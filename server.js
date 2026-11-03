import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.resolve(process.env.DATA_DIR || "data");
const password = process.env.ADMIN_PASSWORD;
if (!password || password.length < 12)
  throw new Error(
    "Set ADMIN_PASSWORD to at least 12 characters. Run npm run setup for local settings.",
  );
mkdirSync(path.join(data, "uploads"), { recursive: true });
mkdirSync(path.join(data, "temporary"), { recursive: true });
const db = new DatabaseSync(path.join(data, "review.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',code_hash TEXT UNIQUE NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth(token TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,name TEXT NOT NULL,admin INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,name TEXT NOT NULL,kind TEXT NOT NULL,stored TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,author TEXT NOT NULL,owner TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,audio_id TEXT REFERENCES files(id),time REAL,score_id TEXT REFERENCES files(id),page INTEGER,x REAL,y REAL,parent_id TEXT REFERENCES notes(id) ON DELETE CASCADE,created TEXT NOT NULL);
`);
const hash = (s) => createHash("sha256").update(s).digest("hex");
const cleanCode = (s) =>
  String(s || "")
    .toUpperCase()
    .replace(/[\s-]/g, "");
const newCode = () => randomBytes(6).toString("hex").toUpperCase();
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const fail = (status, message) => Object.assign(new Error(message), { status });
const app = express();
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "script-src": ["'self'"],
        "worker-src": ["'self'", "blob:"],
        "img-src": ["'self'", "data:", "blob:"],
        "connect-src": ["'self'"],
        "object-src": ["'none'"],
      },
    },
  }),
);
app.use(express.json({ limit: "32kb" }));
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`)
      return res
        .status(403)
        .json({ error: "Please use this site to make changes." });
  }
  const cookie = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("review_token="))
    ?.slice(13);
  req.identity = cookie
    ? db
        .prepare("SELECT * FROM auth WHERE token=? AND expires>?")
        .get(hash(cookie), Date.now())
    : null;
  next();
});
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
});
function issue(res, sessionId, name, admin) {
  const token = randomBytes(32).toString("hex");
  db.prepare("DELETE FROM auth WHERE expires<?").run(Date.now());
  db.prepare("INSERT INTO auth VALUES(?,?,?,?,?)").run(
    hash(token),
    sessionId,
    name,
    admin ? 1 : 0,
    Date.now() + 7 * 86400000,
  );
  res.cookie("review_token", token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: "lax",
    maxAge: 7 * 86400000,
    path: "/",
  });
}
function admin(req, res, next) {
  if (!req.identity?.admin)
    return next(fail(403, "Please sign in to manage your library."));
  next();
}
function access(req, res, next) {
  if (
    !req.identity ||
    (!req.identity.admin && req.identity.session_id !== req.params.id)
  )
    return next(fail(403, "Enter the access code to open this session."));
  req.review = db
    .prepare("SELECT id,title,description,created FROM sessions WHERE id=?")
    .get(req.params.id);
  if (!req.review) return next(fail(404, "Session not found."));
  next();
}
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.post("/api/login", loginLimit, (req, res) => {
  if (req.body.password !== undefined) {
    const a = Buffer.from(hash(String(req.body.password))),
      b = Buffer.from(hash(password));
    if (!timingSafeEqual(a, b))
      throw fail(401, "That password did not match. Please try again.");
    issue(res, null, "Owner", true);
    return res.json({ admin: true });
  }
  const session = db
    .prepare("SELECT id FROM sessions WHERE code_hash=?")
    .get(hash(cleanCode(req.body.code)));
  if (!session)
    throw fail(401, "That code did not match. Please check it and try again.");
  const name = text(req.body.name, 60);
  if (!name)
    throw fail(400, "Please enter your name so others know who left a note.");
  issue(res, session.id, name, false);
  res.json({ admin: false, sessionId: session.id });
});
app.post("/api/logout", (req, res) => {
  if (req.identity)
    db.prepare("DELETE FROM auth WHERE token=?").run(req.identity.token);
  res.clearCookie("review_token", { path: "/" });
  res.json({ ok: true });
});
app.get("/api/me", (req, res) =>
  res.json(
    req.identity
      ? {
          admin: !!req.identity.admin,
          name: req.identity.name,
          sessionId: req.identity.session_id,
        }
      : null,
  ),
);
app.get("/api/sessions", admin, (req, res) =>
  res.json(
    db
      .prepare(
        `SELECT s.id,s.title,s.description,s.created,(SELECT COUNT(*) FROM files WHERE session_id=s.id) file_count,(SELECT COUNT(*) FROM notes WHERE session_id=s.id) note_count FROM sessions s ORDER BY created DESC`,
      )
      .all(),
  ),
);
app.post("/api/sessions", admin, (req, res) => {
  const title = text(req.body.title, 120);
  if (!title) throw fail(400, "Give this session a title.");
  const id = randomUUID(),
    code = newCode();
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
    id,
    title,
    text(req.body.description, 2000),
    hash(code),
    new Date().toISOString(),
  );
  res.status(201).json({ id, code });
});
app.get("/api/sessions/:id", access, (req, res) => {
  const files = db
    .prepare(
      "SELECT id,name,kind,created FROM files WHERE session_id=? ORDER BY created",
    )
    .all(req.params.id);
  const notes = db
    .prepare("SELECT * FROM notes WHERE session_id=? ORDER BY created")
    .all(req.params.id)
    .map(({ owner, ...n }) => ({
      ...n,
      editable: !!req.identity.admin || owner === req.identity.token,
    }));
  res.json({ ...req.review, files, notes });
});
app.post("/api/sessions/:id/code", admin, access, (req, res) => {
  const code = newCode();
  db.prepare("UPDATE sessions SET code_hash=? WHERE id=?").run(
    hash(code),
    req.params.id,
  );
  db.prepare("DELETE FROM auth WHERE session_id=?").run(req.params.id);
  res.json({ code });
});
app.delete("/api/sessions/:id", admin, access, (req, res) => {
  const files = db
    .prepare("SELECT stored FROM files WHERE session_id=?")
    .all(req.params.id);
  db.prepare("DELETE FROM sessions WHERE id=?").run(req.params.id);
  for (const f of files) {
    try {
      unlinkSync(path.join(data, "uploads", f.stored));
    } catch {}
  }
  res.json({ ok: true });
});
const upload = multer({
  dest: path.join(data, "temporary"),
  limits: { fileSize: 150 * 1024 * 1024, files: 1, fields: 0 },
});
let converting = false;
app.post("/api/sessions/:id/files", admin, access, (req, res, next) => {
  if (converting)
    return next(
      fail(503, "Another file is being prepared. Please try again shortly."),
    );
  converting = true;
  upload.single("file")(req, res, (err) => {
    if (err) {
      converting = false;
      return next(err);
    }
    processUpload(req, res)
      .catch(next)
      .finally(() => {
        converting = false;
      });
  });
});
async function processUpload(req, res) {
  if (!req.file) throw fail(400, "Choose a PDF or audio file.");
  const f = req.file,
    id = randomUUID();
  let target;
  try {
    const ext = path.extname(f.originalname).toLowerCase();
    const pdf = ext === ".pdf";
    if (
      !pdf &&
      ![
        ".aac",
        ".m4a",
        ".mp3",
        ".wav",
        ".ogg",
        ".flac",
        ".webm",
        ".mp4",
      ].includes(ext)
    )
      throw fail(
        400,
        "Use a PDF or an audio file (AAC, M4A, MP3, WAV, OGG, FLAC, WebM).",
      );
    const stored = id + (pdf ? ".pdf" : ".m4a");
    target = path.join(data, "uploads", stored);
    if (pdf) {
      if (
        !readFileSync(f.path).subarray(0, 1024).includes(Buffer.from("%PDF-"))
      )
        throw fail(400, "This file does not appear to be a PDF.");
      const { copyFileSync } = await import("node:fs");
      copyFileSync(f.path, target);
    } else {
      try {
        await run(
          "ffmpeg",
          [
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "aac,mov,mp3,wav,ogg,flac,matroska,webm",
            "-i",
            f.path,
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            "-y",
            target,
          ],
          { timeout: 300000, maxBuffer: 1024 * 1024 },
        );
      } catch {
        throw fail(
          400,
          "This audio could not be prepared. Try another audio file.",
        );
      }
    }
    db.prepare("INSERT INTO files VALUES(?,?,?,?,?,?)").run(
      id,
      req.params.id,
      text(f.originalname, 200),
      pdf ? "score" : "audio",
      stored,
      new Date().toISOString(),
    );
    res.status(201).json({ id });
  } catch (err) {
    if (target && existsSync(target)) unlinkSync(target);
    throw err;
  } finally {
    if (existsSync(f.path)) unlinkSync(f.path);
  }
}
app.get("/api/sessions/:id/files/:fileId", access, (req, res) => {
  const file = db
    .prepare("SELECT * FROM files WHERE id=? AND session_id=?")
    .get(req.params.fileId, req.params.id);
  if (!file) throw fail(404, "File not found.");
  res.type(file.kind === "score" ? "application/pdf" : "audio/mp4");
  res.sendFile(path.join(data, "uploads", file.stored));
});
app.post("/api/sessions/:id/notes", access, (req, res) => {
  const body = text(req.body.body, 5000);
  if (!body) throw fail(400, "Write a note first.");
  const kind = ["note", "question", "bookmark"].includes(req.body.kind)
    ? req.body.kind
    : "note";
  const file = (id, kind) =>
    id &&
    db
      .prepare("SELECT id FROM files WHERE id=? AND session_id=? AND kind=?")
      .get(id, req.params.id, kind);
  const audio = file(req.body.audioId, "audio"),
    score = file(req.body.scoreId, "score");
  if ((req.body.audioId && !audio) || (req.body.scoreId && !score))
    throw fail(400, "Choose a file from this session.");
  const time = audio ? Number(req.body.time) : null;
  const page = score ? Number(req.body.page) : null;
  if (audio && (!Number.isFinite(time) || time < 0 || time > 864000))
    throw fail(400, "Invalid audio time.");
  if (score && (!Number.isInteger(page) || page < 1 || page > 10000))
    throw fail(400, "Invalid score page.");
  const coords =
    score &&
    Number.isFinite(req.body.x) &&
    Number.isFinite(req.body.y) &&
    req.body.x >= 0 &&
    req.body.x <= 1 &&
    req.body.y >= 0 &&
    req.body.y <= 1;
  const parent = req.body.parentId
    ? db
        .prepare(
          "SELECT id FROM notes WHERE id=? AND session_id=? AND parent_id IS NULL",
        )
        .get(req.body.parentId, req.params.id)
    : null;
  if (req.body.parentId && !parent) throw fail(400, "Original note not found.");
  const id = randomUUID();
  db.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id,
    req.params.id,
    req.identity.name,
    req.identity.token,
    kind,
    body,
    audio?.id || null,
    time,
    score?.id || null,
    page,
    coords ? req.body.x : null,
    coords ? req.body.y : null,
    parent?.id || null,
    new Date().toISOString(),
  );
  res.status(201).json({ id });
});
app.patch("/api/sessions/:id/notes/:noteId", access, (req, res) => {
  const note = db
    .prepare("SELECT * FROM notes WHERE id=? AND session_id=?")
    .get(req.params.noteId, req.params.id);
  if (!note) throw fail(404, "Note not found.");
  if (!req.identity.admin && note.owner !== req.identity.token)
    throw fail(403, "You can only change your own notes.");
  const body = text(req.body.body, 5000);
  if (!body) throw fail(400, "Write a note first.");
  db.prepare("UPDATE notes SET body=? WHERE id=?").run(body, note.id);
  res.json({ ok: true });
});
app.delete("/api/sessions/:id/notes/:noteId", access, (req, res) => {
  const note = db
    .prepare("SELECT * FROM notes WHERE id=? AND session_id=?")
    .get(req.params.noteId, req.params.id);
  if (!note) throw fail(404, "Note not found.");
  if (!req.identity.admin && note.owner !== req.identity.token)
    throw fail(403, "You can only remove your own notes.");
  db.prepare("DELETE FROM notes WHERE id=?").run(note.id);
  res.json({ ok: true });
});
app.use(
  "/pdfjs",
  express.static(path.join(root, "node_modules/pdfjs-dist/build")),
);
app.use(
  "/pdf-fonts",
  express.static(path.join(root, "node_modules/pdfjs-dist/standard_fonts")),
);
app.use(
  "/pdf-cmaps",
  express.static(path.join(root, "node_modules/pdfjs-dist/cmaps")),
);
app.use(express.static(path.join(root, "public")));
app.use((err, req, res, next) => {
  const status =
    err.code === "LIMIT_FILE_SIZE"
      ? 413
      : err instanceof multer.MulterError
        ? 400
        : err.status || 500;
  if (status === 500) console.error(err);
  res
    .status(status)
    .json({
      error:
        err.code === "LIMIT_FILE_SIZE"
          ? "This file is too large. The limit is 150 MB per file."
          : status === 500
            ? "Something went wrong. Please try again."
            : err.message,
    });
});
const server = app.listen(
  Number(process.env.PORT || 3000),
  process.env.HOST || "0.0.0.0",
  () =>
    console.log(
      `Score & Sound is ready at http://localhost:${server.address().port}`,
    ),
);
process.on("SIGTERM", () =>
  server.close(() => {
    db.close();
    process.exit(0);
  }),
);
