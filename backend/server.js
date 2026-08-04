import express from "express";
import dotenv from "dotenv";
import mongoose from "mongoose";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import { pipeline } from "stream/promises";
import { GridFSBucket, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "MarkcodersAdmin";
const ACCOUNT_PASS = process.env.ACCOUNT_PASS;
const JWT_SECRET = process.env.JWT_SECRET;
const TTL_SECONDS = 30 * 60;
const TTL_MS = TTL_SECONDS * 1000;
const MAX_FILE_SIZE = 490 * 1024 * 1024;

const app = express();
let bucket;

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

const fileMetaSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true },
    mimetype: { type: String, required: true },
    size: { type: Number, required: true },
    gridFsId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { _id: true }
);

const shareSchema = new mongoose.Schema(
  {
    ip: { type: String, required: true, unique: true, index: true },
    text: { type: String, default: "" },
    files: { type: [fileMetaSchema], default: [] },
    uploadedAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

shareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const Share = mongoose.model("Share", shareSchema);

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
});

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  let ip = forwarded
    ? String(forwarded).split(",")[0].trim()
    : req.socket.remoteAddress || "unknown";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
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

function refreshExpiry(doc) {
  const now = new Date();
  doc.uploadedAt = now;
  doc.expiresAt = new Date(now.getTime() + TTL_MS);
}

async function deleteGridFsFiles(files = []) {
  await Promise.all(
    files.map(async (file) => {
      try {
        await bucket.delete(new ObjectId(String(file.gridFsId)));
      } catch (err) {
        if (err?.code !== "ENOENT" && err?.message !== "FileNotFound") {
          console.error("GridFS delete error:", err.message);
        }
      }
    })
  );
}

async function deleteShare(doc) {
  if (!doc) return;
  await deleteGridFsFiles(doc.files || []);
  await Share.deleteOne({ _id: doc._id });
}

async function getValidShare(ip) {
  const doc = await Share.findOne({ ip });
  if (!doc) return null;
  if (isExpired(doc)) {
    await deleteShare(doc);
    return null;
  }
  return doc;
}

async function saveToGridFs(file) {
  const uploadStream = bucket.openUploadStream(file.originalname, {
    contentType: file.mimetype || "application/octet-stream",
    metadata: { originalName: file.originalname },
  });
  await pipeline(fs.createReadStream(file.path), uploadStream);
  await fsp.unlink(file.path).catch(() => {});
  return {
    originalName: file.originalname,
    mimetype: file.mimetype || "application/octet-stream",
    size: file.size,
    gridFsId: uploadStream.id,
  };
}

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "MarkCoders Share API",
    auth: "required",
    login: "POST /api/login",
    health: "/api/health",
  });
});

app.get("/api/health", (_req, res) => {
  const dbOk = mongoose.connection.readyState === 1;
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    db: dbOk ? "connected" : "disconnected",
  });
});

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }
    if (!ACCOUNT_PASS || !JWT_SECRET) {
      return res.status(500).json({ error: "Auth is not configured" });
    }

    const userOk = username === ADMIN_USERNAME;
    const passOk = await bcrypt.compare(password, ACCOUNT_PASS);
    if (!userOk || !passOk) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const token = jwt.sign(
      { username: ADMIN_USERNAME, role: "admin" },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      username: ADMIN_USERNAME,
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

app.use("/api", (req, res, next) => {
  if (req.path === "/login" || req.path === "/health") return next();
  return requireAuth(req, res, next);
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
        $set: { text: text.trim(), uploadedAt: now, expiresAt },
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
    upload.array("files")(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large (max 490MB)" });
      }
      return res.status(400).json({ error: err.message || "Invalid file upload" });
    });
  },
  async (req, res) => {
    const tempFiles = req.files || [];
    try {
      if (!tempFiles.length) {
        return res.status(400).json({ error: "At least one file is required" });
      }

      const ip = getClientIp(req);
      let doc = await Share.findOne({ ip });
      if (!doc || isExpired(doc)) {
        if (doc) await deleteShare(doc);
        doc = new Share({
          ip,
          text: "",
          files: [],
          uploadedAt: new Date(),
          expiresAt: new Date(Date.now() + TTL_MS),
        });
      }

      const saved = [];
      for (const file of tempFiles) saved.push(await saveToGridFs(file));
      doc.files.push(...saved);
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
      await Promise.all(tempFiles.map((f) => fsp.unlink(f.path).catch(() => {})));
      return res.status(500).json({ error: "Failed to save files" });
    }
  }
);

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
    if (!doc) return res.status(200).json({ ip, files: [] });
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
    if (!doc) return res.status(404).json({ error: "File not found or expired" });

    const file = doc.files.id(req.params.id);
    if (!file) return res.status(404).json({ error: "File not found" });

    res.setHeader("Content-Type", file.mimetype);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(file.originalName)}"`
    );
    res.setHeader("Content-Length", file.size);

    const downloadStream = bucket.openDownloadStream(
      new ObjectId(String(file.gridFsId))
    );
    downloadStream.on("error", (err) => {
      console.error("Download stream error:", err);
      if (!res.headersSent) res.status(404).json({ error: "File not found" });
      else res.end();
    });
    return downloadStream.pipe(res);
  } catch (err) {
    console.error("Download error:", err);
    return res.status(500).json({ error: "Failed to download file" });
  }
});

app.delete("/api/files/:id", async (req, res) => {
  try {
    const ip = getClientIp(req);
    const doc = await getValidShare(ip);
    if (!doc) return res.status(404).json({ error: "File not found or expired" });

    const file = doc.files.id(req.params.id);
    if (!file) return res.status(404).json({ error: "File not found" });

    await deleteGridFsFiles([file]);
    file.deleteOne();
    await doc.save();

    return res.status(200).json({
      message: "File deleted",
      files: doc.files.map(fileMeta),
    });
  } catch (err) {
    console.error("Delete file error:", err);
    return res.status(500).json({ error: "Failed to delete file" });
  }
});

app.delete("/api/text", async (req, res) => {
  try {
    const ip = getClientIp(req);
    const doc = await Share.findOne({ ip });
    await deleteShare(doc);
    return res.status(200).json({ message: "Share cleared", ip });
  } catch (err) {
    console.error("Delete error:", err);
    return res.status(500).json({ error: "Failed to clear share" });
  }
});

async function cleanupExpiredShares() {
  try {
    const expired = await Share.find({ expiresAt: { $lte: new Date() } });
    for (const doc of expired) {
      await deleteShare(doc);
      console.log(`Deleted expired share for ${doc.ip}`);
    }
  } catch (err) {
    console.error("Cleanup error:", err);
  }
}

async function start() {
  if (!MONGODB_URI) {
    console.error("Missing MONGODB_URI in environment");
    process.exit(1);
  }
  if (!ACCOUNT_PASS || !JWT_SECRET) {
    console.error("Missing ACCOUNT_PASS (bcrypt hash) or JWT_SECRET");
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  bucket = new GridFSBucket(mongoose.connection.db, { bucketName: "shares" });
  console.log("Connected to MongoDB (GridFS ready)");

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Auth user: ${ADMIN_USERNAME} | Max file: 490MB`);
  });

  cleanupExpiredShares();
  setInterval(cleanupExpiredShares, 60 * 1000);
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
