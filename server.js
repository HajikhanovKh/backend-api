// server.js (ESM)
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import "dotenv/config";
import multer from "multer";
import path from "path";
import fs from "fs";
import OpenAI from "openai";
import pdf from "pdf-parse";

console.log("SERVER VERSION: upload + analyze-vision ✅");

const app = express();

/** ✅ CORS */
app.use(
  cors({
    origin: [
      "https://avtomobil-ile-dasinan-mal.webflow.io",
      "https://avtomobil-ile-dasinan-mal.com",
    ],
  })
);
// Alternativ (test üçün): app.use(cors());

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
// ✅ OpenAI
// =========================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function fetchPdfBuffer(pdfUrl) {
  const r = await fetch(pdfUrl, {
    method: "GET",
    headers: { Accept: "application/pdf,*/*" },
  });

  if (!r.ok) {
    const ct = r.headers.get("content-type");
    const body = await r.text().catch(() => "");
    throw new Error(
      `pdf_fetch_failed status=${r.status} contentType=${ct} body=${body.slice(0, 200)}`
    );
  }

  const arr = await r.arrayBuffer();
  return Buffer.from(arr);
}

// ✅ Vision üçün base64
async function fetchPdfBase64(pdfUrl) {
  const buf = await fetchPdfBuffer(pdfUrl);
  return buf.toString("base64");
}

// =========================
// ✅ Analyze (Vision) — TÖVSİYƏ OLUNAN
// =========================
app.post("/analyze-vision", async (req, res) => {
  try {
    const { pdfUrl } = req.body || {};
    if (!pdfUrl) return res.status(400).json({ error: "pdfUrl is required" });

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      temperature: 0,

      // ✅ Structured Outputs (JSON Schema)
      text: {
        format: {
          type: "json_schema",
          strict: true,
          schema: {
            name: "cmr_invoice_parties",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                exporter: { type: "string" },
                importer: { type: "string" }
              },
              required: ["exporter", "importer"]
            }
          }
        }
      },

      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Bu PDF-də 1-ci səhifə CMR, 2-ci səhifə Invoice-dir.\n" +
                "CMR-də olan tərəfləri götür:\n" +
                "- Exporter = Consignor / Sender\n" +
                "- Importer = Consignee\n" +
                "Adları sənəddə necə yazılıbsa elə yaz (şirkət adı, şəhər/ölkə varsa saxla).\n" +
                "Tapmasan boş string qaytar."
            },
            {
              type: "input_file",
              filename: "document.pdf",
              file_url: pdfUrl
            }
          ]
        }
      ]
    });

    // 🔎 Debug üçün: model nə qaytardı?
    const outText = response.output_text || "";
    // outText JSON olmalıdır (schema ilə)
    let out = { exporter: "", importer: "" };
    try { out = JSON.parse(outText); } catch {}

    return res.json({
      exporter: out.exporter || "",
      importer: out.importer || "",
      // ❗ debug üçün saxla (sonra silərsən)
      raw: outText
    });

  } catch (e) {
    console.error("ANALYZE VISION ERROR:", e);
    return res.status(500).json({ error: e?.message || "analyze_error" });
  }
});


// =========================
// ✅ Analyze (Simple) — KÖHNƏ (pdf-parse)
// =========================
app.post("/analyze-simple", async (req, res) => {
  try {
    const { pdfUrl } = req.body || {};
    if (!pdfUrl) return res.status(400).json({ error: "pdfUrl is required" });

    const buf = await fetchPdfBuffer(pdfUrl);

    // OCR YOX: PDF-in text layer-i varsa işləyəcək
    const parsed = await pdf(buf);
    const text = (parsed.text || "").slice(0, 20000);

    const prompt = `
Mətn CMR+Invoice-dan çıxarılıb.
Exporter (göndərən/satıcı) və Importer (alan/consignee) adlarını tap.
Yalnız JSON qaytar:
{"exporter":"","importer":""}

Mətn:
${text}
`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: "Only valid JSON. No extra text." },
        { role: "user", content: prompt },
      ],
    });

    const content = resp.choices?.[0]?.message?.content || "{}";
    let out = { exporter: "", importer: "" };
    try {
      out = JSON.parse(content);
    } catch {}

    res.json({
      exporter: out.exporter || "",
      importer: out.importer || "",
    });
  } catch (e) {
    console.error("ANALYZE SIMPLE ERROR:", e);
    res.status(500).json({ error: e?.message || "analyze_error" });
  }
});

// =========================
// ✅ Test page (indi Vision çağırır)
// =========================
app.get("/test-analyze", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`
    <h2>Analyze test (Vision)</h2>
    <p>PDF URL:</p>
    <input id="u" style="width:700px" placeholder="PDF URL yapışdır">
    <button id="b">Analyze</button>
    <pre id="o" style="background:#111;color:#0f0;padding:12px;white-space:pre-wrap"></pre>

    <script>
      document.getElementById('b').onclick = async () => {
        const pdfUrl = document.getElementById('u').value.trim();
        if(!pdfUrl) return alert('PDF URL daxil et');

        const r = await fetch('/analyze-vision', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ pdfUrl })
        });

        const t = await r.text();
        document.getElementById('o').textContent = 'Status: ' + r.status + '\\n' + t;
      };
    </script>
  `);
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

// ✅ Sağlamlıq testi
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

// ✅ NV search
app.get("/nv/search", async (req, res) => {
  try {
    const reg = (req.query.reg_code || "").trim();
    if (!reg) return res.status(400).json({ error: "reg_code is required" });

    const [rows] = await pool.query(
      `SELECT id, nv_reg_code, nv_number, nv_marka, nv_type, nv_country
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

// =========================
// ✅ Listen
// =========================
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log("API running on port", port));
