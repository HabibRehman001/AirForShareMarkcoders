import express from "express";
import dotenv from "dotenv";
import mongoose from "mongoose";
import multer from "multer";

dotenv.config();

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;
const TTL_SECONDS = 30 * 60; // 30 minutes
const TTL_MS = TTL_SECONDS * 1000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;

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

const fileSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true },
    mimetype: { type: String, required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true },
  },
  { _id: true }
);

const shareSchema = new mongoose.Schema(
  {
    ip: { type: String, required: true, unique: true, index: true },
    text: { type: String, default: "" },
    files: { type: [fileSchema], default: [] },
    uploadedAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

shareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Share = mongoose.model("Share", shareSchema);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
  },
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

function isExpired(doc) {
  return !doc || doc.expiresAt.getTime() <= Date.now();
}

function fileMeta(file) {
  return {
    id: file._id.toString(),
    name: file.originalName,
    mimetype: file.mimetype,
    size: file.size,
  };
}

async function getValidShare(ip) {
  const doc = await Share.findOne({ ip });
  if (!doc) return null;

  if (isExpired(doc)) {
    await Share.deleteOne({ _id: doc._id });
    return null;
  }

  return doc;
}

function refreshExpiry(doc) {
  const now = new Date();
  doc.uploadedAt = now;
  doc.expiresAt = new Date(now.getTime() + TTL_MS);
}

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "MarkCoders Share API",
    storage: "mongodb",
    health: "/api/health",
    uploadText: "POST /api/upload",
    uploadFile: "POST /api/upload-file",
    text: "GET /api/text",
    files: "GET /api/files",
    download: "GET /api/files/:id/download",
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

    const doc = await Share.findOneAndUpdate(
      { ip },
      {
        $set: {
          text: text.trim(),
          uploadedAt: now,
          expiresAt,
        },
        $setOnInsert: { ip, files: [] },
      },
      { upsert: true, new: true }
    );

    return res.status(200).json({
      message: "Text saved",
      ip: doc.ip,
      text: doc.text,
      files: (doc.files || []).map(fileMeta),
      expiresInMs: TTL_MS,
      expiresAt: doc.expiresAt,
    });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Failed to save text" });
  }
});

app.post(
  "/api/upload-file",
  (req, res, next) => {
    upload.array("files", MAX_FILES)(req, res, (err) => {
      if (!err) return next();
      console.error("Multer error:", err);
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: "File too large (max 10MB)" });
        }
        if (err.code === "LIMIT_FILE_COUNT") {
          return res.status(400).json({ error: `Max ${MAX_FILES} files allowed` });
        }
      }
      return res.status(400).json({ error: err.message || "Invalid file upload" });
    });
  },
  async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "At least one file is required" });
    }

    const ip = getClientIp(req);
    let doc = await Share.findOne({ ip });

    if (!doc || isExpired(doc)) {
      if (doc) await Share.deleteOne({ _id: doc._id });
      doc = new Share({
        ip,
        text: "",
        files: [],
        uploadedAt: new Date(),
        expiresAt: new Date(Date.now() + TTL_MS),
      });
    }

    const incoming = files.map((file) => ({
      originalName: file.originalname,
      mimetype: file.mimetype || "application/octet-stream",
      size: file.size,
      data: file.buffer,
    }));

    if (doc.files.length + incoming.length > MAX_FILES) {
      return res.status(400).json({
        error: `Max ${MAX_FILES} files allowed per IP`,
      });
    }

    doc.files.push(...incoming);
    refreshExpiry(doc);
    await doc.save();

    return res.status(200).json({
      message: "Files saved",
      ip: doc.ip,
      files: doc.files.map(fileMeta),
      expiresInMs: TTL_MS,
      expiresAt: doc.expiresAt,
    });
  } catch (err) {
    console.error("File upload error:", err);
    return res.status(500).json({ error: "Failed to save files" });
  }
});

app.get("/api/text", async (req, res) => {
  try {
    const ip = getClientIp(req);
    const doc = await getValidShare(ip);

    if (!doc) {
      return res.status(200).json({ ip, text: "", files: [], expired: false });
    }

    return res.status(200).json({
      ip,
      text: doc.text || "",
      files: doc.files.map(fileMeta),
      remainingMs: Math.max(0, doc.expiresAt.getTime() - Date.now()),
      expiresAt: doc.expiresAt,
    });
  } catch (err) {
    console.error("Fetch error:", err);
    return res.status(500).json({ error: "Failed to read text" });
  }
});

app.get("/api/files", async (req, res) => {
  try {
    const ip = getClientIp(req);
    const doc = await getValidShare(ip);

    if (!doc) {
      return res.status(200).json({ ip, files: [] });
    }

    return res.status(200).json({
      ip,
      files: doc.files.map(fileMeta),
      remainingMs: Math.max(0, doc.expiresAt.getTime() - Date.now()),
      expiresAt: doc.expiresAt,
    });
  } catch (err) {
    console.error("List files error:", err);
    return res.status(500).json({ error: "Failed to list files" });
  }
});

app.get("/api/files/:id/download", async (req, res) => {
  try {
    const ip = getClientIp(req);
    const doc = await getValidShare(ip);

    if (!doc) {
      return res.status(404).json({ error: "File not found or expired" });
    }

    const file = doc.files.id(req.params.id);
    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }

    res.setHeader("Content-Type", file.mimetype);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(file.originalName)}"`
    );
    res.setHeader("Content-Length", file.size);
    return res.status(200).send(file.data);
  } catch (err) {
    console.error("Download error:", err);
    return res.status(500).json({ error: "Failed to download file" });
  }
});

app.delete("/api/text", async (req, res) => {
  try {
    const ip = getClientIp(req);
    await Share.deleteOne({ ip });
    return res.status(200).json({ message: "Share cleared", ip });
  } catch (err) {
    console.error("Delete error:", err);
    return res.status(500).json({ error: "Failed to clear share" });
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
    console.log(`Shares expire after ${TTL_SECONDS / 60} minutes per IP`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
