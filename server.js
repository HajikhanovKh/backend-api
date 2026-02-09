import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import "dotenv/config";

const app = express();

// Webflow üçün rahat: CORS açıq
app.use(cors());
app.use(express.json());

// MySQL connection pool (Railway variables)
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
    console.error("HEALTH ERROR:", e); // Railway logs-da tam görünsün
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
    if (!reg) {
      return res.status(400).json({ error: "reg_code is required" });
    }

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

    if (rows.length === 0) {
      return res.status(404).json({ error: "not found" });
    }

    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

// Railway PORT
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log("API running on port", port));
