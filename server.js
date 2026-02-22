import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";

import OpenAI from "openai";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";

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

// Document AI client (Railway env JSON ilə)
const docaiClient = new DocumentProcessorServiceClient({
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
  const noFences = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  const start = noFences.indexOf("{");
  const end = noFences.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("JSON tapılmadı. Raw: " + noFences.slice(0, 300));
  }
  return JSON.parse(noFences.slice(start, end + 1));
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
    throw new Error("OpenAI JSON parse error: " + String(e.message).slice(0, 500));
  }
}

// ================= Document AI helpers =================
function textFromAnchor(fullText, textAnchor) {
  if (!fullText || !textAnchor?.textSegments?.length) return "";
  let out = "";
  for (const seg of textAnchor.textSegments) {
    const start = Number(seg.startIndex || 0);
    const end = Number(seg.endIndex || 0);
    if (end > start) out += fullText.slice(start, end);
  }
  return out;
}

function normalizeText(t) {
  return (t || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function matchOne(text, patterns) {
  if (!text) return null;
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function extractFromText(text) {
  const t = normalizeText(text);

  const vin =
    matchOne(t, [
      /\bVIN[:\s]*([A-HJ-NPR-Z0-9]{17})\b/i,
      /\b([A-HJ-NPR-Z0-9]{17})\b/,
    ]) || null;

  const gross =
    matchOne(t, [
      /\bGross\s*weight[:\s]*([0-9]+(?:[.,][0-9]+)?)\s*(kg)?\b/i,
      /\bBrut(?:to)?[:\s]*([0-9]+(?:[.,][0-9]+)?)\b/i,
      /\bGross[:\s]*([0-9]+(?:[.,][0-9]+)?)\b/i,
    ]) || null;

  const exporterName =
    matchOne(t, [
      /\bExporter[:\s]*([^\n]{3,80})/i,
      /\bSender[:\s]*([^\n]{3,80})/i,
      /\bConsignor[:\s]*([^\n]{3,80})/i,
    ]) || null;

  const importerName =
    matchOne(t, [
      /\bImporter[:\s]*([^\n]{3,80})/i,
      /\bReceiver[:\s]*([^\n]{3,80})/i,
      /\bConsignee[:\s]*([^\n]{3,80})/i,
    ]) || null;

  const importerId =
    matchOne(t, [
      /\bID[:\s]*([A-Z0-9\-]{4,30})\b/i,
      /\bTax\s*ID[:\s]*([A-Z0-9\-]{4,30})\b/i,
    ]) || null;

  const goodsName =
    matchOne(t, [
      /\bGoods(?:\s*description)?[:\s]*([^\n]{3,120})/i,
      /\bDescription[:\s]*([^\n]{3,120})/i,
    ]) || null;

  const invoiceNo =
    matchOne(t, [
      /\bInvoice\s*(?:No|#|Number)[:\s]*([A-Z0-9\-\/]+)\b/i,
    ]) || null;

  const anyDate =
    matchOne(t, [
      /\b([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4})\b/,
    ]) || null;

  const total =
    matchOne(t, [
      /\bTotal(?:\s*Amount)?[:\s]*([0-9]+(?:[.,][0-9]+)?)\s*([A-Z]{3})?\b/i,
      /\bGrand\s*Total[:\s]*([0-9]+(?:[.,][0-9]+)?)\s*([A-Z]{3})?\b/i,
    ]) || null;

  const loadingPlace =
    matchOne(t, [
      /\bLoading\s*place[:\s]*([^\n]{2,80})/i,
      /\bPlace\s*of\s*taking\s*over[:\s]*([^\n]{2,80})/i,
    ]) || null;

  const deliveryPlace =
    matchOne(t, [
      /\bDelivery\s*place[:\s]*([^\n]{2,80})/i,
      /\bPlace\s*designated\s*for\s*delivery[:\s]*([^\n]{2,80})/i,
    ]) || null;

  return {
    exporterName,
    importerName,
    importerId,
    goodsName,
    vin,
    gross,
    loadingPlace,
    deliveryPlace,
    anyDate,
    invoiceNo,
    total,
  };
}

async function analyzeWithDocumentAI(pdfBuffer) {
  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_LOCATION; // məsələn: "eu" və ya "us"
  const processorId = process.env.DOC_AI_PROCESSOR_ID;

  if (!projectId || !location || !processorId) {
    throw new Error("GCP_PROJECT_ID / GCP_LOCATION / DOC_AI_PROCESSOR_ID env-ləri çatmır");
  }

  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;

  const request = {
    name,
    rawDocument: {
      content: pdfBuffer.toString("base64"),
      mimeType: "application/pdf",
    },
  };

  const [result] = await docaiClient.processDocument(request);
  const doc = result.document;

  const fullText = doc?.text || "";
  const pages = doc?.pages || [];

  // Page 1 = pages[0], Page 2 = pages[1]
  const pageTexts = pages.map((p) => textFromAnchor(fullText, p.layout?.textAnchor));
  return {
    page1: pageTexts[0] || "",
    page2: pageTexts[1] || "",
    fullText,
  };
}

// ================= ROUTES =================

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, routes: ["/upload", "/upload/google-vision"] });
});

// -------- OpenAI ----------
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "File yoxdur" });

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

// -------- "Google Vision" endpoint -> Document AI ----------
app.post("/upload/google-vision", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "File yoxdur" });

    const key = "docai:" + sha256(req.file.buffer);
    const cached = cacheGet(key);
    if (cached) return res.json({ analysis: cached.analysis, cached: true });

    const { page1, page2 } = await analyzeWithDocumentAI(req.file.buffer);

    // 1-ci səhifə CMR, 2-ci səhifə Invoice kimi parse edirik
    const cmrFields = extractFromText(page1);
    const invFields = extractFromText(page2);

    const analysis = {
      cmr: {
        exporter: { name: cmrFields.exporterName || null, address: null },
        importer: { name: cmrFields.importerName || null, id: cmrFields.importerId || null },
        goods_name: cmrFields.goodsName || null,
        vin: cmrFields.vin || null,
        gross_weight_kg: cmrFields.gross || null,
        loading_place: cmrFields.loadingPlace || null,
        delivery_place: cmrFields.deliveryPlace || null,
        date: cmrFields.anyDate || null,
      },
      invoice: {
        exporter: { name: invFields.exporterName || null },
        importer: { name: invFields.importerName || null, id: invFields.importerId || null },
        goods_name: invFields.goodsName || null,
        vin: invFields.vin || null,
        invoice_no: invFields.invoiceNo || null,
        invoice_date: invFields.anyDate || null,
        total_amount: invFields.total || null,
      },
    };

    cacheSet(key, { analysis });
    res.json({ analysis, cached: false });
  } catch (err) {
    console.error("DOCAI ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
