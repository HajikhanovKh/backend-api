import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";

import OpenAI from "openai";
import vision from "@google-cloud/vision";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ================= Multer (RAM storage) =================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ================= Clients =================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GCP_DOC_AI_KEY_JSON),
});

// ================= Simple Cache =================
const CACHE = new Map();
const CACHE_TTL = 1000 * 60 * 30;

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function cacheGet(key) {
  const v = CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > CACHE_TTL) {
    CACHE.delete(key);
    return null;
  }
  return v;
}

function cacheSet(key, value) {
  CACHE.set(key, { ...value, ts: Date.now() });
}

// ================= Safe JSON Parse (OpenAI codefence fix) =================
function safeJsonParse(raw) {
  const s = String(raw || "").trim();

  // ```json ... ``` və ya ``` ... ``` fence-ləri təmizlə
  const noFences = s
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  // İlk { və son } aralığını götür
  const start = noFences.indexOf("{");
  const end = noFences.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("JSON tapılmadı. Raw: " + noFences.slice(0, 300));
  }

  const jsonStr = noFences.slice(start, end + 1);

  // Parse
  return JSON.parse(jsonStr);
}

// ================= OpenAI ANALYSIS =================
async function analyzeWithOpenAI(buffer) {
  const base64 = buffer.toString("base64");

  const prompt = `
Extract structured data from CMR (page1) and Invoice (page2).
Return STRICT JSON only.
Schema:
{
  "cmr": {
    "exporter": {"name": string|null, "address": string|null},
    "importer": {"name": string|null, "id": string|null},
    "goods_name": string|null,
    "vin": string|null,
    "gross_weight_kg": string|null,
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
    "total_amount": string|null
  }
}

Return ONLY raw JSON. Do NOT wrap in \`\`\`json fences. Do NOT add any extra text.
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
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

  const text = (response.output_text || "").trim();

  try {
    return safeJsonParse(text);
  } catch (e) {
    throw new Error(
      "OpenAI JSON parse error: " + String(e.message).slice(0, 500)
    );
  }
}

// ================= Vision ANALYSIS =================
function extractSimple(text) {
  const vinMatch = text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
  const totalMatch = text.match(/\bTotal[:\s]*([0-9.,]+)/i);

  return {
    cmr: {
      exporter: { name: null, address: null },
      importer: { name: null, id: null },
      goods_name: null,
      vin: vinMatch?.[0] || null,
      gross_weight_kg: null,
      loading_place: null,
      delivery_place: null,
      date: null,
    },
    invoice: {
      exporter: { name: null },
      importer: { name: null, id: null },
      goods_name: null,
      vin: vinMatch?.[0] || null,
      invoice_no: null,
      invoice_date: null,
      total_amount: totalMatch?.[1] || null,
    },
  };
}

// ================= ROUTES =================

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true });
});

// -------- OpenAI ----------
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer)
      return res.status(400).json({ error: "File yoxdur" });

    const key = "openai:" + sha256(req.file.buffer);

    const cached = cacheGet(key);
    if (cached) return res.json({ analysis: cached.analysis, cached: true });

    const analysis = await analyzeWithOpenAI(req.file.buffer);

    cacheSet(key, { analysis });

    res.json({ analysis, cached: false });
  } catch (err) {
    console.error("OPENAI ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------- Google Vision ----------
app.post("/upload/google-vision", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer)
      return res.status(400).json({ error: "File yoxdur" });

    const key = "vision:" + sha256(req.file.buffer);

    const cached = cacheGet(key);
    if (cached) return res.json({ analysis: cached.analysis, cached: true });

    const [result] = await visionClient.documentTextDetection({
      image: { content: req.file.buffer },
    });

    const text = result?.fullTextAnnotation?.text || "";

    const analysis = extractSimple(text);

    cacheSet(key, { analysis });

    res.json({ analysis, cached: false });
  } catch (err) {
    console.error("VISION ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
