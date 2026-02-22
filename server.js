// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");

const { OpenAI } = require("openai");
const vision = require("@google-cloud/vision");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// -------------------- Multer (RAM-da saxla) --------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB (istəsən artır)
});

// -------------------- Clients --------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GCP_DOC_AI_KEY_JSON),
});

// -------------------- Simple in-memory cache --------------------
const CACHE = new Map(); // key: sha256(file) -> { analysis, provider, ts }
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 dəqiqə

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function cacheGet(key) {
  const v = CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return v;
}

function cacheSet(key, value) {
  CACHE.set(key, { ...value, ts: Date.now() });
}

// -------------------- Helpers: text -> structured fields --------------------
function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function matchOne(text, patterns) {
  if (!text) return null;
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function normalizeText(t) {
  return (t || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Sadə extractor (istəsən sonra daha “smart” edərik)
function extractFromVisionText(rawText) {
  const text = normalizeText(rawText);

  // VIN (17 simvol) üçün basic regex
  const vin =
    matchOne(text, [
      /\bVIN[:\s]*([A-HJ-NPR-Z0-9]{17})\b/i,
      /\b([A-HJ-NPR-Z0-9]{17})\b/,
    ]) || null;

  const gross =
    matchOne(text, [
      /\bGross\s*weight[:\s]*([0-9]+(?:[.,][0-9]+)?)\s*(kg)?\b/i,
      /\bBrut(?:to)?[:\s]*([0-9]+(?:[.,][0-9]+)?)\b/i,
    ]) || null;

  const invoiceNo =
    matchOne(text, [
      /\bInvoice\s*(No|#|Number)[:\s]*([A-Z0-9\-\/]+)\b/i, // group 2 ola bilər
    ]) || null;

  // Yuxarıdakı regex-də group 2 olduğu üçün düzəldək:
  const invoiceNoFixed = (() => {
    const m = text.match(/\bInvoice\s*(?:No|#|Number)[:\s]*([A-Z0-9\-\/]+)\b/i);
    return m?.[1]?.trim() || null;
  })();

  const invoiceDate =
    matchOne(text, [
      /\bInvoice\s*Date[:\s]*([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4})\b/i,
      /\bDate[:\s]*([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4})\b/i,
    ]) || null;

  const total =
    matchOne(text, [
      /\bTotal(?:\s*Amount)?[:\s]*([0-9]+(?:[.,][0-9]+)?)\s*([A-Z]{3})?\b/i,
      /\bGrand\s*Total[:\s]*([0-9]+(?:[.,][0-9]+)?)\s*([A-Z]{3})?\b/i,
    ]) || null;

  // Exporter / Importer üçün sadə başlıq əsaslı axtarış (çox PDF-də işləyir, hamısında yox)
  const exporterName =
    matchOne(text, [
      /\bExporter[:\s]*([^\n]{3,80})/i,
      /\bSender[:\s]*([^\n]{3,80})/i,
      /\bConsignor[:\s]*([^\n]{3,80})/i,
    ]) || null;

  const importerName =
    matchOne(text, [
      /\bImporter[:\s]*([^\n]{3,80})/i,
      /\bReceiver[:\s]*([^\n]{3,80})/i,
      /\bConsignee[:\s]*([^\n]{3,80})/i,
    ]) || null;

  const goodsName =
    matchOne(text, [
      /\bGoods(?:\s*description)?[:\s]*([^\n]{3,120})/i,
      /\bDescription[:\s]*([^\n]{3,120})/i,
    ]) || null;

  // CMR date / loading / delivery üçün də sadə nümunələr
  const cmrDate =
    matchOne(text, [
      /\bCMR\s*Date[:\s]*([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4})\b/i,
      /\bDate[:\s]*([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4})\b/i,
    ]) || null;

  const loadingPlace =
    matchOne(text, [
      /\bPlace\s*of\s*taking\s*over[:\s]*([^\n]{2,80})/i,
      /\bLoading\s*place[:\s]*([^\n]{2,80})/i,
    ]) || null;

  const deliveryPlace =
    matchOne(text, [
      /\bPlace\s*designated\s*for\s*delivery[:\s]*([^\n]{2,80})/i,
      /\bDelivery\s*place[:\s]*([^\n]{2,80})/i,
    ]) || null;

  return {
    cmr: {
      exporter: { name: exporterName || null, address: null },
      importer: { name: importerName || null, id: null },
      goods_name: goodsName || null,
      vin,
      gross_weight_kg: gross,
      loading_place: loadingPlace,
      delivery_place: deliveryPlace,
      date: cmrDate,
    },
    invoice: {
      exporter: { name: exporterName || null },
      importer: { name: importerName || null, id: null },
      goods_name: goodsName || null,
      vin,
      invoice_no: pickFirst(invoiceNoFixed, invoiceNo),
      invoice_date: invoiceDate,
      total_amount: total,
    },
  };
}

// -------------------- OpenAI extraction --------------------
// Bu funksiya PDF buffer-i OpenAI-a göndərir və JSON qaytarır.
// Səndə artıq işləyən prompt/format varsa, buranı ona uyğunlaşdır.
async function analyzeWithOpenAI(pdfBuffer) {
  const base64 = pdfBuffer.toString("base64");

  const prompt = `
You will receive a PDF that contains 2 pages:
- Page 1: CMR
- Page 2: Invoice

Extract structured data and return STRICT JSON with this schema:
{
  "cmr": {
    "exporter": {"name": string|null, "address": string|null},
    "importer": {"name": string|null, "id": string|null},
    "goods_name": string|null,
    "vin": string|null,
    "gross_weight_kg": string|number|null,
    "loading_place": string|null,
    "delivery_place": string|null,
    "date": string|null
  },
  "invoice": {
    "exporter": {"name": string|null},
    "importer": {"name": string|null, "id": string|null},
    "goods_name": string|null,
    "vin": string|null,
    "invoice_no": string|null,
    "invoice_date": string|null,
    "total_amount": string|number|null
  }
}

Return ONLY JSON. No extra text.
`;

  // OpenAI Responses API (PDF input_file)
  const resp = await openai.responses.create({
    model: "gpt-4.1-mini", // istəsən dəyiş (səndə hansı stabil işləyirsə)
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_file",
            filename: "document.pdf",
            file_data: `data:application/pdf;base64,${base64}`,
          },
        ],
      },
    ],
  });

  // Cavab mətnini götür
  const outText = (resp.output_text || "").trim();

  let parsed;
  try {
    parsed = JSON.parse(outText);
  } catch (e) {
    // JSON parse alınmasa, debug üçün xətanı yuxarı qaldır
    throw new Error("OpenAI JSON parse failed. Raw output: " + outText.slice(0, 800));
  }

  return parsed;
}

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "pdf-analyzer", routes: ["/upload", "/upload/google-vision"] });
});

// 1) OpenAI
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "File yoxdur" });

    const fileBuf = req.file.buffer;
    const key = "openai:" + sha256(fileBuf);

    const cached = cacheGet(key);
    if (cached) {
      return res.json({ analysis: cached.analysis, provider: "openai", cached: true });
    }

    const analysis = await analyzeWithOpenAI(fileBuf);

    cacheSet(key, { analysis, provider: "openai" });

    res.json({ analysis, provider: "openai", cached: false });
  } catch (err) {
    console.error("OPENAI ERROR:", err);
    res.status(500).json({ error: "OpenAI xətası", details: String(err?.message || err) });
  }
});

// 2) Google Vision
app.post("/upload/google-vision", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "File yoxdur" });

    const fileBuf = req.file.buffer;
    const key = "vision:" + sha256(fileBuf);

    const cached = cacheGet(key);
    if (cached) {
      return res.json({ analysis: cached.analysis, provider: "google-vision", cached: true });
    }

    // PDF üçün Vision documentTextDetection
    const [result] = await visionClient.documentTextDetection({
      image: { content: fileBuf },
    });

    const visionText = result?.fullTextAnnotation?.text || "";
    const analysis = extractFromVisionText(visionText);

    cacheSet(key, { analysis, provider: "google-vision" });

    res.json({ analysis, provider: "google-vision", cached: false });
  } catch (err) {
    console.error("VISION ERROR:", err);
    res.status(500).json({ error: "Google Vision xətası", details: String(err?.message || err) });
  }
});

// -------------------- Start --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
