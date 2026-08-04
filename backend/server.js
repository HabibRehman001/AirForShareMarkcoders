import express from "express";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const PORT = process.env.PORT || 3001;
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // check every 1 minute

const app = express();

// Needed on Render so req.ip / X-Forwarded-For are correct
app.set("trust proxy", 1);

app.use(express.json());

const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!allowedOrigins.length || (origin && allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  let ip = forwarded
    ? String(forwarded).split(",")[0].trim()
    : req.socket.remoteAddress || "unknown";

  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }

  return ip;
}

function sanitizeIp(ip) {
  return ip.replace(/:/g, "_");
}

function getIpFolder(ip) {
  return path.join(DATA_DIR, sanitizeIp(ip));
}

function getDataFilePath(ip) {
  return path.join(getIpFolder(ip), "data.json");
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function deleteIpData(ip) {
  await fs.rm(getIpFolder(ip), { recursive: true, force: true });
}

function isExpired(uploadedAt) {
  return Date.now() - uploadedAt >= TTL_MS;
}

async function readIpData(ip) {
  const filePath = getDataFilePath(ip);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw);

    if (!data?.text || !data?.uploadedAt || isExpired(data.uploadedAt)) {
      await deleteIpData(ip);
      return null;
    }

    return data;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function cleanupExpiredData() {
  try {
    const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const folder = path.join(DATA_DIR, entry.name);
      const filePath = path.join(folder, "data.json");

      try {
        const raw = await fs.readFile(filePath, "utf8");
        const data = JSON.parse(raw);

        if (!data?.uploadedAt || isExpired(data.uploadedAt)) {
          await fs.rm(folder, { recursive: true, force: true });
          console.log(`Deleted expired data for ${entry.name}`);
        }
      } catch {
        // Corrupt / incomplete folder — remove it
        await fs.rm(folder, { recursive: true, force: true });
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Cleanup error:", err);
    }
  }
}

app.post("/api/upload", async (req, res) => {
  try {
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }

    const ip = getClientIp(req);
    const folder = getIpFolder(ip);
    const payload = {
      text: text.trim(),
      uploadedAt: Date.now(),
      expiresInMs: TTL_MS,
    };

    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(getDataFilePath(ip), JSON.stringify(payload, null, 2), "utf8");

    // Remove legacy text.txt if present
    await fs.rm(path.join(folder, "text.txt"), { force: true });

    return res.status(200).json({
      message: "Text saved",
      ip,
      text: payload.text,
      expiresInMs: TTL_MS,
    });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Failed to save text" });
  }
});

app.get("/api/text", async (req, res) => {
  try {
    const ip = getClientIp(req);
    const data = await readIpData(ip);

    if (!data) {
      return res.status(200).json({ ip, text: "", expired: false });
    }

    const remainingMs = Math.max(0, TTL_MS - (Date.now() - data.uploadedAt));

    return res.status(200).json({
      ip,
      text: data.text,
      remainingMs,
    });
  } catch (err) {
    console.error("Fetch error:", err);
    return res.status(500).json({ error: "Failed to read text" });
  }
});

ensureDataDir()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Text expires after ${TTL_MS / 60000} minutes per IP`);
    });

    cleanupExpiredData();
    setInterval(cleanupExpiredData, CLEANUP_INTERVAL_MS);
  })
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
