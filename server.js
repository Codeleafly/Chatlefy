const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const crypto = require("crypto");
const winston = require("winston");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

// === Logger Setup ===
const logDir = path.join(__dirname, "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(info => `[${info.timestamp}] ${info.level.toUpperCase()}: ${info.message}`)
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logDir, "error.log"),
      level: "error",
    }),
    new winston.transports.File({
      filename: path.join(logDir, "combined.log"),
    }),
    new winston.transports.Console(),
  ],
});

// === Env Constants ===
const ENCRYPTED_API_FILE = path.join(__dirname, "encrypted.api.enc");
const RUNTIME_FLAG_FILE = path.join(__dirname, "api.runtime.flag");
const SYSTEM_PROMPT_PATH = path.join(__dirname, "system.instruction.prompt");

const PASSWORD = process.env.PASSWORD;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const API_KEY_RAW = process.env.API_KEY_RAW;

if (!PASSWORD || !ENCRYPTION_KEY) {
  console.error("Missing PASSWORD or ENCRYPTION_KEY in .env");
  process.exit(1);
}

function encrypt(text, keyHex) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(keyHex, "hex"), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + encrypted;
}

function decrypt(encryptedText, keyHex) {
  const iv = Buffer.from(encryptedText.slice(0, 32), "hex");
  const encrypted = encryptedText.slice(32);
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(keyHex, "hex"), iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getEncryptedAPIKey() {
  if (!fs.existsSync(RUNTIME_FLAG_FILE)) {
    const encrypted = encrypt(API_KEY_RAW, ENCRYPTION_KEY);
    fs.writeFileSync(ENCRYPTED_API_FILE, encrypted);
    fs.writeFileSync(RUNTIME_FLAG_FILE, "ENCRYPTED=YES");
    logger.info("API Key encrypted and saved.");
  }
  return decrypt(fs.readFileSync(ENCRYPTED_API_FILE, "utf-8"), ENCRYPTION_KEY);
}

const API_KEY = getEncryptedAPIKey();
const ai = new GoogleGenerativeAI(API_KEY);

const MAX_REQUESTS_PER_DAY = 50;
let systemPromptText = "You are Chatlefy, an AI assistant made by Smart Tell Line...";
if (fs.existsSync(SYSTEM_PROMPT_PATH)) {
  systemPromptText = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(bodyParser.json());

// ✅ Serve static files from public folder
app.use(express.static(path.join(__dirname, "public")));

let userHistories = {};
let requestCounter = {};
function resetCountersDaily() {
  requestCounter = {};
  setTimeout(resetCountersDaily, 24 * 60 * 60 * 1000);
}
resetCountersDaily();

app.post("/chat", async (req, res) => {
  const { userId, message } = req.body;

  if (!userId || !message) return res.status(400).json({ reply: "Invalid input" });

  if (!message.includes(PASSWORD) && !userHistories[userId]) {
    return res.status(403).json({ reply: "Unauthorized access. Provide password." });
  }

  if (!userHistories[userId] && message.includes(PASSWORD)) {
    const model = ai.getGenerativeModel({
      model: "gemini-2.5-flash-preview-05-20",
      generationConfig: { temperature: 1.0, topK: 1, topP: 1 },
      systemInstruction: { role: "system", parts: [{ text: systemPromptText }] },
    });
    const chat = model.startChat({ history: [] });
    userHistories[userId] = { model, chat };
    requestCounter[userId] = 0;
    return res.json({ reply: "Access granted. You can now start chatting." });
  }

  if (requestCounter[userId] >= MAX_REQUESTS_PER_DAY) {
    return res.status(429).json({ reply: "Rate limit exceeded for today." });
  }

  try {
    requestCounter[userId]++;
    const result = await userHistories[userId].chat.sendMessage(message);
    res.json({ reply: result.response.text() });
  } catch (err) {
    logger.error(`Chat error: ${err.message}`);
    res.status(500).json({ reply: "Chatlefy is currently unavailable." });
  }
});

app.listen(PORT, () => {
  logger.info(`Chatlefy running securely on http://localhost:${PORT}`);
});
