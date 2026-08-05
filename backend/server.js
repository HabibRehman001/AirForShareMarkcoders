import express from "express";
import dotenv from "dotenv";
import mongoose from "mongoose";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import http from "http";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";

dotenv.config();

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "MarkcodersAdmin").trim();
/** Bcrypt hash (preferred) or plaintext — strip wrapping quotes (common anton/panel misconfig). */
const ACCOUNT_PASS = String(process.env.ACCOUNT_PASS || "")
  .trim()
  .replace(/^['"]|['"]$/g, "");
const JWT_SECRET = process.env.JWT_SECRET;

async function verifyPassword(password) {
  if (!ACCOUNT_PASS) return false;
  if (/^\$2[aby]\$/.test(ACCOUNT_PASS)) {
    return bcrypt.compare(password, ACCOUNT_PASS);
  }
  // Plaintext fallback when ACCOUNT_PASS was set without bcrypt on the server
  return password === ACCOUNT_PASS;
}
/** One shared clipboard for all logged-in MarkCoders devices (not per client IP). */
const SHARE_KEY = "markcoders";
const TTL_SECONDS = 30 * 60;
const TTL_MS = TTL_SECONDS * 1000;
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_BYTES) || 10 * 1024 * 1024 * 1024; // 10GB default
const MAX_FILE_SIZE_LABEL = process.env.MAX_FILE_SIZE_LABEL || "10GB";
/** File bytes live on disk; Mongo only stores refs (storedName). */
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads"));

const app = express();
const server = http.createServer(app);
let io;

app.set("trust proxy", 1);
app.use(express.json());

/**
 * Cross-origin friendly CORS (Render / ngrok / localhost).
 * Echo Origin + Allow-Credentials so both Bearer and older cookie clients work.
 */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ||
      "Content-Type, Authorization, ngrok-skip-browser-warning"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

function getTokenFromRequest(req) {
  const header = req.headers.authorization || "";
  const [type, bearer] = header.split(" ");
  if (type === "Bearer" && bearer) return bearer;
  // Optional query token (e.g. download links)
  const q = req.query?.token;
  if (typeof q === "string" && q) return q;
  return "";
}

function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function shareRoom(ip) {
  return `share:${ip}`;
}

const fileMetaSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true },
    mimetype: { type: String, required: true },
    size: { type: Number, required: true },
    /** Disk filename only — never store file bytes in Mongo. */
    storedName: { type: String, required: true },
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
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").slice(0, 32);
      cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
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

function getShareKey() {
  return SHARE_KEY;
}

/** Serialize mutations per share key so concurrent uploads/deletes can't clobber each other. */
const shareQueues = new Map();

function withShareLock(key, task) {
  const prev = shareQueues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(task);
  // Keep the chain going even if this task fails; clear map when this is the last waiter.
  const tail = run.then(
    () => {},
    () => {}
  );
  shareQueues.set(key, tail);
  tail.finally(() => {
    if (shareQueues.get(key) === tail) shareQueues.delete(key);
  });
  return run;
}

function isExpired(doc) {
  return !doc || doc.expiresAt.getTime() <= Date.now();
}

function fileMeta(file) {
  const id = file._id.toString();
  return {
    id,
    name: file.originalName,
    mimetype: file.mimetype,
    size: file.size,
    // Download path — Share stores ref only, not file bytes
    url: `/api/files/${id}/download`,
  };
}

function sharePayload(doc, ip) {
  if (!doc) {
    return { ip, text: "", files: [], expired: false };
  }
  return {
    ip: doc.ip || ip,
    text: doc.text || "",
    files: (doc.files || []).map(fileMeta),
    remainingMs: Math.max(0, doc.expiresAt.getTime() - Date.now()),
    expiresAt: doc.expiresAt,
  };
}

function emitShareUpdate(ip, doc) {
  if (!io) return;
  io.to(shareRoom(ip)).emit("share:update", sharePayload(doc, ip));
}

async function deleteStoredFiles(files = []) {
  await Promise.all(
    files.map(async (file) => {
      if (!file?.storedName) return;
      try {
        await fsp.unlink(resolveStoredPath(file.storedName));
      } catch (err) {
        if (err?.code !== "ENOENT") {
          console.error("Disk delete error:", err.message);
        }
      }
    })
  );
}

async function deleteShare(doc) {
  if (!doc) return;
  await deleteStoredFiles(doc.files || []);
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

/** Build DB ref from a multer disk file (bytes already on disk). */
function refFromUploadedFile(file) {
  return {
    originalName: file.originalname,
    mimetype: file.mimetype || "application/octet-stream",
    size: file.size,
    storedName: file.filename,
  };
}

function resolveStoredPath(storedName) {
  const base = UPLOAD_DIR;
  const full = path.resolve(UPLOAD_DIR, path.basename(String(storedName)));
  if (!full.startsWith(base + path.sep)) {
    throw new Error("Invalid file reference");
  }
  return full;
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

    const userOk = username.toLowerCase() === ADMIN_USERNAME.toLowerCase();
    const passOk = await verifyPassword(password);
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
      username: ADMIN_USERNAME,
      token,
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/logout", (_req, res) => {
  // Client clears localStorage token; nothing to clear server-side
  return res.status(200).json({ message: "Logged out" });
});

app.get("/api/me", (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    // 200 so browsers don't log a failed request when checking session on the login page
    return res.status(200).json({ authenticated: false });
  }
  try {
    const user = jwt.verify(token, JWT_SECRET);
    return res.status(200).json({ authenticated: true, username: user.username });
  } catch {
    return res.status(200).json({ authenticated: false });
  }
});

app.use("/api", (req, res, next) => {
  if (req.path === "/login" || req.path === "/logout" || req.path === "/health" || req.path === "/me") {
    return next();
  }
  return requireAuth(req, res, next);
});

app.post("/api/upload", async (req, res) => {
  try {
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }

    const ip = getShareKey();
    const doc = await withShareLock(ip, async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + TTL_MS);
      const updated = await Share.findOneAndUpdate(
        { ip },
        {
          $set: { text: text.trim(), uploadedAt: now, expiresAt },
          $setOnInsert: { ip, files: [] },
        },
        { upsert: true, new: true }
      );
      emitShareUpdate(ip, updated);
      return updated;
    });

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
        return res.status(400).json({ error: `File too large (max ${MAX_FILE_SIZE_LABEL})` });
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

      const ip = getShareKey();
      const doc = await withShareLock(ip, async () => {
        let existing = await Share.findOne({ ip });
        if (existing && isExpired(existing)) {
          await deleteShare(existing);
          existing = null;
        }

        if (!existing) {
          existing = await Share.create({
            ip,
            text: "",
            files: [],
            uploadedAt: new Date(),
            expiresAt: new Date(Date.now() + TTL_MS),
          });
        }

        // Process one file at a time; DB only gets refs (storedName), bytes stay on disk.
        const saved = [];
        for (const file of tempFiles) {
          saved.push(refFromUploadedFile(file));
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + TTL_MS);
        const updated = await Share.findOneAndUpdate(
          { ip },
          {
            $push: { files: { $each: saved } },
            $set: { uploadedAt: now, expiresAt },
          },
          { new: true }
        );

        emitShareUpdate(ip, updated);
        return updated;
      });

      return res.status(200).json({
        message: "Files saved",
        ip: doc.ip,
        text: doc.text || "",
        files: (doc.files || []).map(fileMeta),
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
    const ip = getShareKey();
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
    const ip = getShareKey();
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
    const ip = getShareKey();
    const doc = await getValidShare(ip);
    if (!doc) return res.status(404).json({ error: "File not found or expired" });

    const file = doc.files.id(req.params.id);
    if (!file?.storedName) return res.status(404).json({ error: "File not found" });

    const fullPath = resolveStoredPath(file.storedName);
    await fsp.access(fullPath);

    res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
    const safeName = String(file.originalName || "download").replace(/[^\w.\-() ]+/g, "_");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.originalName || "download")}`
    );
    res.setHeader("Content-Length", file.size);
    res.setHeader("Cache-Control", "no-store");

    const downloadStream = fs.createReadStream(fullPath);
    downloadStream.on("error", (err) => {
      console.error("Download stream error:", err);
      if (!res.headersSent) res.status(404).json({ error: "File not found" });
      else res.end();
    });
    return downloadStream.pipe(res);
  } catch (err) {
    console.error("Download error:", err);
    return res.status(404).json({ error: "File not found" });
  }
});

app.delete("/api/files/:id", async (req, res) => {
  try {
    const ip = getShareKey();
    const result = await withShareLock(ip, async () => {
      const doc = await getValidShare(ip);
      if (!doc) return { status: 404, body: { error: "File not found or expired" } };

      const file = doc.files.id(req.params.id);
      if (!file) return { status: 404, body: { error: "File not found" } };

      await deleteStoredFiles([file]);
      file.deleteOne();
      await doc.save();

      emitShareUpdate(ip, doc);

      return {
        status: 200,
        body: {
          message: "File deleted",
          text: doc.text || "",
          files: doc.files.map(fileMeta),
        },
      };
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error("Delete file error:", err);
    return res.status(500).json({ error: "Failed to delete file" });
  }
});

app.delete("/api/files", async (req, res) => {
  try {
    const ip = getShareKey();
    const result = await withShareLock(ip, async () => {
      const doc = await getValidShare(ip);
      if (!doc) {
        return {
          status: 200,
          body: { message: "No files to delete", text: "", files: [] },
        };
      }

      await deleteStoredFiles(doc.files || []);
      doc.files = [];
      await doc.save();

      emitShareUpdate(ip, doc);

      return {
        status: 200,
        body: {
          message: "All files deleted",
          text: doc.text || "",
          files: [],
        },
      };
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error("Delete all files error:", err);
    return res.status(500).json({ error: "Failed to delete files" });
  }
});

app.delete("/api/text", async (req, res) => {
  try {
    const ip = getShareKey();
    await withShareLock(ip, async () => {
      const doc = await Share.findOne({ ip });
      await deleteShare(doc);
      emitShareUpdate(ip, null);
    });
    return res.status(200).json({ message: "Share cleared", ip, text: "", files: [] });
  } catch (err) {
    console.error("Delete error:", err);
    return res.status(500).json({ error: "Failed to clear share" });
  }
});

async function cleanupExpiredShares() {
  try {
    const expired = await Share.find({ expiresAt: { $lte: new Date() } });
    for (const doc of expired) {
      const ip = doc.ip;
      await withShareLock(ip, async () => {
        const fresh = await Share.findById(doc._id);
        if (!fresh || fresh.expiresAt.getTime() > Date.now()) return;
        await deleteShare(fresh);
        emitShareUpdate(ip, null);
        console.log(`Deleted expired share for ${ip}`);
      });
    }
  } catch (err) {
    console.error("Cleanup error:", err);
  }
}

function getSocketIp(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  let ip = forwarded
    ? String(forwarded).split(",")[0].trim()
    : socket.handshake.address || "unknown";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

function setupSocketIo() {
  io = new Server(server, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    try {
      const authHeader = socket.handshake.headers.authorization || "";
      const [type, bearer] = String(authHeader).split(" ");
      const token =
        (type === "Bearer" && bearer) ||
        socket.handshake.auth?.token ||
        "";

      if (!token) return next(new Error("Authentication required"));
      socket.user = jwt.verify(token, JWT_SECRET);
      socket.shareKey = getShareKey();
      socket.clientIp = getSocketIp(socket);
      return next();
    } catch {
      return next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    const room = shareRoom(socket.shareKey);
    socket.join(room);

    socket.on("share:sync", async () => {
      try {
        const doc = await getValidShare(socket.shareKey);
        socket.emit("share:update", sharePayload(doc, socket.shareKey));
      } catch (err) {
        console.error("Socket sync error:", err);
      }
    });
  });
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
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  console.log(`Connected to MongoDB (file refs only) | uploads: ${UPLOAD_DIR}`);

  setupSocketIo();

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Auth user: ${ADMIN_USERNAME} | Max file: ${MAX_FILE_SIZE_LABEL} | Socket.IO enabled`);
  });

  cleanupExpiredShares();
  setInterval(cleanupExpiredShares, 60 * 1000);
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
