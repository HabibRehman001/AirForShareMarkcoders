import express from "express";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;
const TTL_SECONDS = 30 * 60; // 30 minutes
const TTL_MS = TTL_SECONDS * 1000;

const app = express();

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const shareSchema = new mongoose.Schema(
  {
    ip: { type: String, required: true, unique: true, index: true },
    text: { type: String, required: true },
    uploadedAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

// MongoDB auto-deletes documents after expiresAt
shareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Share = mongoose.model("Share", shareSchema);

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

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "MarkCoders Share API",
    storage: "mongodb",
    health: "/api/health",
    upload: "POST /api/upload",
    text: "GET /api/text",
  });
});

app.get("/api/health", (_req, res) => {
  const dbOk = mongoose.connection.readyState === 1;
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    db: dbOk ? "connected" : "disconnected",
  });
});

app.post("/api/upload", async (req, res) => {
  try {
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }

    const ip = getClientIp(req);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_MS);
    const cleanText = text.trim();

    const doc = await Share.findOneAndUpdate(
      { ip },
      {
        ip,
        text: cleanText,
        uploadedAt: now,
        expiresAt,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({
      message: "Text saved",
      ip: doc.ip,
      text: doc.text,
      expiresInMs: TTL_MS,
      expiresAt: doc.expiresAt,
    });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Failed to save text" });
  }
});

app.get("/api/text", async (req, res) => {
  try {
    const ip = getClientIp(req);
    const doc = await Share.findOne({ ip });

    if (!doc) {
      return res.status(200).json({ ip, text: "", expired: false });
    }

    // Safety check before Mongo TTL worker runs
    if (doc.expiresAt.getTime() <= Date.now()) {
      await Share.deleteOne({ _id: doc._id });
      return res.status(200).json({ ip, text: "", expired: true });
    }

    const remainingMs = Math.max(0, doc.expiresAt.getTime() - Date.now());

    return res.status(200).json({
      ip,
      text: doc.text,
      remainingMs,
      expiresAt: doc.expiresAt,
    });
  } catch (err) {
    console.error("Fetch error:", err);
    return res.status(500).json({ error: "Failed to read text" });
  }
});

app.delete("/api/text", async (req, res) => {
  try {
    const ip = getClientIp(req);
    await Share.deleteOne({ ip });
    return res.status(200).json({ message: "Text cleared", ip });
  } catch (err) {
    console.error("Delete error:", err);
    return res.status(500).json({ error: "Failed to clear text" });
  }
});

async function start() {
  if (!MONGODB_URI) {
    console.error("Missing MONGODB_URI in environment");
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB");

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Text expires after ${TTL_SECONDS / 60} minutes per IP`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
