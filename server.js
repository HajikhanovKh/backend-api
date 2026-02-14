import "dotenv/config";
import express from "express";
import multer from "multer";

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o";

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY yoxdur!");
  process.exit(1);
}

app.use(express.json());

/* ================= CORS ================= */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ================= MULTER (RAM) ================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === "application/pdf" ||
      file.mimetype === "image/png" ||
      file.mimetype === "image/jpeg";
    if (!ok) return cb(new Error("Yalnız PDF/JPG/PNG icazəlidir"));
    cb(null, true);
  }
});

/* ================= OpenAI FILE UPLOAD ================= */
async function uploadToOpenAI(buffer, filename, mimetype) {
  const form = new FormData();
  form.append("purpose", "assistants"); // ✅ düz
  form.append("file", new Blob([buffer], { type: mimetype }), filename);

  const res = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("OpenAI file upload error:", data);
    throw new Error(JSON.stringify(data));
  }
  return data.id;
}

/* ================= ANALYZE ================= */
async function analyzeFile(file_id) {
  const prompt = `
Sən CMR və Invoice sənədlərini analiz edən sistemsən.

Sənədin içində həm CMR, həm Invoice ola bilər (məs: 1-ci səhifə CMR, 2-ci səhifə Invoice).
Mümkün olduqda məlumatı ayrıca çıxart.

Yalnız JSON qaytar:

{
  "cmr": {
    "exporter": "",
    "importer": "",
    "goods_name": "",
    "vin": ""
  },
  "invoice": {
    "exporter": "",
    "importer": "",
    "goods_name": "",
    "vin": ""
  }
}

Qaydalar:
- CMR-də Exporter = Consignor, Importer = Consignee
- Invoice-də Exporter = Seller/Shipper, Importer = Buyer
- VIN 17 simvolluq koddur (A-Z və 0-9). Tapılmasa boş string.
- Tapılmayan sahələr boş string olsun.
`.trim();

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_file", file_id }
          ]
        }
      ],
      // ✅ yeni format budur
      text: { format: { type: "json_object" } }
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("OpenAI responses error:", data);
    throw new Error(JSON.stringify(data));
  }

  const text =
    data.output_text ??
    data?.output?.[0]?.content?.[0]?.text ??
    "";

  try {
    return JSON.parse(text);
  } catch {
    return { error: "JSON parse error", raw_text: text };
  }
}

/* ================= ROUTES ================= */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * POST /upload
 * form-data: file=<pdf>
 * returns: { status, analysis }
 */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fayl yoxdur" });

    const file_id = await uploadToOpenAI(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );

    const analysis = await analyzeFile(file_id);

    return res.json({
      status: "success",
      analysis
    });
  } catch (err) {
    console.error("UPLOAD/ANALYZE ERROR:", err?.message || err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

app.listen(PORT, () => {
  console.log("Server başladı:", PORT);
});
