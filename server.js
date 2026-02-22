import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { OpenAI } from "openai";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import vision from "@google-cloud/vision";

const app = express();

// Webflow -> Railway CORS
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.options("*", cors());

// Upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

app.get("/health", (req, res) => res.json({ ok: true }));

/* =========================
   OPENAI
========================= */
function getOpenAIClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing env: OPENAI_API_KEY");
  return new OpenAI({ apiKey: key });
}

/**
 * ✅ Buraya sənin hazır OpenAI analiz kodun gələcək.
 * Mən “stub” qoyuram ki server işləsin.
 */
async function analyzeWithOpenAI(reqFile) {
  // ======= SƏNİN KÖHNƏ OPENAI KODUNU BURAYA PASTE ET =======
  // reqFile.buffer, reqFile.mimetype, reqFile.originalname istifadə edə bilərsən.

  return {
    cmr: { note: "Buraya sənin OpenAI analiz kodun gəlməlidir." },
    invoice: {},
  };
}

app.post("/upload/openai", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file. Field must be 'file'." });

    const analysis = await analyzeWithOpenAI(req.file);

    return res.json({
      provider: "openai",
      cached: false,
      analysis,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

/* =========================
   GOOGLE (VISION VARIANTI)
   - PDF -> Document AI
   - Image -> Vision OCR
========================= */

// Google credentials (eynidir, həm DocumentAI həm Vision üçün)
function getGoogleCredentials() {
  const raw = process.env.GCP_KEY_JSON;
  if (!raw) throw new Error("Missing env: GCP_KEY_JSON");
  return JSON.parse(raw);
}

// Document AI helpers
function getDocAIClient() {
  const credentials = getGoogleCredentials();
  return new DocumentProcessorServiceClient({ credentials });
}

function docAIProcessorName() {
  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_LOCATION; // eu / us
  const processorId = process.env.DOC_AI_PROCESSOR_ID;

  if (!projectId) throw new Error("Missing env: GCP_PROJECT_ID");
  if (!location) throw new Error("Missing env: GCP_LOCATION");
  if (!processorId) throw new Error("Missing env: DOC_AI_PROCESSOR_ID");

  return `projects/${projectId}/locations/${location}/processors/${processorId}`;
}

// Vision client
function getVisionClient() {
  const credentials = getGoogleCredentials();
  return new vision.ImageAnnotatorClient({ credentials });
}

function buildAnalysisRaw(cmrText, invoiceText) {
  return {
    cmr: {
      exporter: { name: "", address: "" },
      importer: { name: "", id: "" },
      goods_name: "",
      vin: "",
      gross_weight_kg: "",
      loading_place: "",
      delivery_place: "",
      date: "",
      raw_text: cmrText || "",
    },
    invoice: {
      exporter: { name: "" },
      importer: { name: "", id: "" },
      goods_name: "",
      vin: "",
      invoice_no: "",
      invoice_date: "",
      total_amount: "",
      raw_text: invoiceText || "",
    },
  };
}

app.post("/upload/vision", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file. Field must be 'file'." });

    // 1) PDF -> Document AI
    if (req.file.mimetype === "application/pdf") {
      const client = getDocAIClient();
      const name = docAIProcessorName();

      const [result] = await client.processDocument({
        name,
        rawDocument: {
          content: req.file.buffer.toString("base64"),
          mimeType: "application/pdf",
        },
      });

      const doc = result?.document;
      const fullText = doc?.text || "";
      const pages = doc?.pages || [];

      function pageText(pageIndex) {
        const page = pages[pageIndex];
        if (!page?.layout?.textAnchor?.textSegments) return "";
        let out = "";
        for (const seg of page.layout.textAnchor.textSegments) {
          const s = Number(seg.startIndex || 0);
          const e = Number(seg.endIndex || 0);
          out += fullText.slice(s, e);
        }
        return out.trim();
      }

      const cmrText = pageText(0);
      const invoiceText = pageText(1);

      return res.json({
        provider: "google_document_ai",
        cached: false,
        analysis: buildAnalysisRaw(cmrText, invoiceText),
      });
    }

    // 2) Image -> Vision OCR
    const vClient = getVisionClient();
    const [vRes] = await vClient.textDetection({ image: { content: req.file.buffer } });
    const fullText = vRes.fullTextAnnotation?.text || "";

    return res.json({
      provider: "google_vision",
      cached: false,
      analysis: buildAnalysisRaw(fullText, ""), // şəkil üçün hamısını cmr.raw_text-ə yazırıq
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

/* =========================
   Köhnə /upload də işləsin deyə:
   Default: OpenAI
========================= */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file. Field must be 'file'." });

    const analysis = await analyzeWithOpenAI(req.file);

    return res.json({
      provider: "openai",
      cached: false,
      analysis,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API running on port", PORT));
