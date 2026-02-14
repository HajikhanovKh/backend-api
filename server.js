import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import multer from "multer";
import { z } from "zod";

/* ================= CONFIG ================= */

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o";

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY yoxdur!");
  process.exit(1);
}

/* ================= APP ================= */

const app = express();

app.use(helmet());
app.use(morgan("dev"));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

/* ================= FILE UPLOAD ================= */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed =
      file.mimetype === "application/pdf" ||
      file.mimetype === "image/png" ||
      file.mimetype === "image/jpeg";

    if (!allowed) return cb(new Error("Yalnız PDF/JPG/PNG icazəlidir"));
    cb(null, true);
  }
});

/* ================= HELPERS ================= */

async function uploadToOpenAI(buffer, filename, mimetype) {
  const form = new FormData();
  form.append("purpose", "assistants");
  form.append("file", new Blob([buffer], { type: mimetype }), filename);

  const res = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

/* ================= ANALYZE FUNCTION ================= */

async function analyzeFile(file_id) {

  const prompt = `
Sən beynəlxalq daşımalar üzrə sənəd analiz edən AI sistemisən.

Sənə verilən fayl CMR və ya Invoice ola bilər.
Sən hər iki sənəd tipində aşağıdakı məlumatları tapmalısan:

1) Malın adı (Goods description / Product name)
2) VIN kodu (17 simvolluq avtomobil identifikasiya nömrəsi, varsa)
3) İdxalatçı (Importer / Consignee)
4) İxracatçı (Exporter / Shipper / Consignor)

Qaydalar:

- CMR-də:
  Exporter = Consignor
  Importer = Consignee

- Invoice-də:
  Exporter = Seller / Shipper
  Importer = Buyer

- VIN 17 simvoldan ibarət olur (A-Z və 0-9)
- Əgər məlumat tapılmazsa null yaz
- Yalnız JSON qaytar

JSON strukturu:

{
  "doc_type": "CMR | INVOICE | UNKNOWN",
  "goods_name": "",
  "vin": "",
  "exporter": "",
  "importer": "",
  "confidence": 0
}
`;

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
      response_format: { type: "json_object" }
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));

  const text =
    data.output_text ||
    data?.output?.[0]?.content?.[0]?.text;

  let parsed = JSON.parse(text);

  /* ====== VIN əlavə yoxlama (regex fallback) ====== */
  const vinRegex = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
  const vinMatch = text.match(vinRegex);

  if (!parsed.vin && vinMatch) {
    parsed.vin = vinMatch[0];
  }

  return parsed;
}

/* ================= ROUTES ================= */

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* 1️⃣ UPLOAD */

app.post("/upload", upload.single("file"), async (req, res) => {
  try {

    if (!req.file) {
      return res.status(400).json({ error: "Fayl tapılmadı" });
    }

    const uploaded = await uploadToOpenAI(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );

    res.json({
      status: "uploaded",
      file_id: uploaded.id
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* 2️⃣ ANALYZE */

app.post("/analyze", async (req, res) => {
  try {

    const schema = z.object({
      file_id: z.string()
    });

    const { file_id } = schema.parse(req.body);

    const result = await analyzeFile(file_id);

    res.json({
      status: "analyzed",
      data: result
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ================= ERROR HANDLER ================= */

app.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Fayl çox böyükdür (max 25MB)" });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

/* ================= START ================= */

app.listen(PORT, () => {
  console.log(`🚀 Server işləyir: ${PORT}`);
});
