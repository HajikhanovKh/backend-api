// server.js (ESM)
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import "dotenv/config";
import multer from "multer";
import path from "path";
import fs from "fs";

const app = express();

/** ✅ CORS (Webflow domenlərini yazmaq daha yaxşıdır)
 *  Əgər domenlərini bilmirsənsə, müvəqqəti app.use(cors()) saxla.
 */
app.use(
  cors({
    origin: [
      "https://avtomobil-ile-dasinan-mal.webflow.io",
      "https://avtomobil-ile-dasinan-mal.com",
    ],
  })
);
// Əgər yuxarı origin siyahısı problem yaratsa, bunu istifadə et:
// app.use(cors());

app.use(express.json());

// =========================
// ✅ Upload (PDF) hissəsi
// =========================
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// yüklənən faylları URL ilə açmaq üçün
app.use("/uploads", express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "_" + safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF allowed"));
  },
});

// Webflow buraya multipart/form-data ilə "file" göndərəcək
app.post("/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file is required" });

    // Railway reverse proxy üçün https düzgün çıxsın deyə:
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.get("host");
    const url = `${proto}://${host}/uploads/${req.file.filename}`;

    return res.json({ url });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    return res.status(500).json({ error: e?.message || "upload_error" });
  }
});

// multer/fileFilter errorlarını JSON qaytarmaq üçün
app.use((err, req, res, next) => {
  if (err?.message === "Only PDF allowed") {
    return res.status(400).json({ error: "only_pdf_allowed" });
  }
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "file_too_large" });
  }
  if (err) {
    console.error("MIDDLEWARE ERROR:", err);
    return res.status(500).json({ error: err.message || "server_error" });
  }
  next();
});

// =========================
// ✅ MySQL connection pool
// =========================
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  port: Number(process.env.MYSQLPORT || 3306),
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// 1) Sağlamlıq testi (DB qoşulubmu?)
app.get("/health", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 AS ok");
    res.json({ status: "ok", db: rows[0].ok });
  } catch (e) {
    console.error("HEALTH ERROR:", e);
    res.status(500).json({
      status: "error",
      name: e?.name || null,
      code: e?.code || null,
      errno: e?.errno || null,
      message: e?.message || null,
      sqlState: e?.sqlState || null,
    });
  }
});

// 2) NV search: nv_reg_code ilə tap
// istifadə: /nv/search?reg_code=00500 (və ya 10020030000001)
app.get("/nv/search", async (req, res) => {
  try {
    const reg = (req.query.reg_code || "").trim();
    if (!reg) return res.status(400).json({ error: "reg_code is required" });

    const [rows] = await pool.query(
      `SELECT
         id,
         nv_reg_code,
         nv_number,
         nv_marka,
         nv_type,
         nv_country
       FROM nv_info
       WHERE nv_reg_code = ?
       LIMIT 1`,
      [reg]
    );

    if (rows.length === 0) return res.status(404).json({ error: "not found" });

    res.json(rows[0]);
  } catch (e) {
    console.error("NV SEARCH ERROR:", e);
    res.status(500).json({ error: e?.message || "server_error" });
  }
});

// 3) (Opsional) hamısını qaytarır
app.get("/nv", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const [rows] = await pool.query(
      "SELECT id, nv_reg_code, nv_number, nv_marka, nv_type, nv_country FROM nv_info ORDER BY id DESC LIMIT ?",
      [limit]
    );
    res.json(rows);
  } catch (e) {
    console.error("NV LIST ERROR:", e);
    res.status(500).json({ error: e?.message || "server_error" });
  }
});

// 4) (Opsional) ən son yazılan qeyd
app.get("/nv/latest", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, nv_reg_code, nv_number, nv_marka, nv_type, nv_country FROM nv_info ORDER BY id DESC LIMIT 1"
    );
    res.json(rows[0] || {});
  } catch (e) {
    console.error("NV LATEST ERROR:", e);
    res.status(500).json({ error: e?.message || "server_error" });
  }
});

// Railway PORT
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log("API running on port", port));
