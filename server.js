import "dotenv/config";
import express from "express";
import multer from "multer";
import crypto from "crypto";

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

/* ================= SIMPLE CACHE (RAM) =================
   Eyni PDF təkrar göndəriləndə eyni nəticə qaytarsın deyə.
   Qeyd: Server restart olsa cache sıfırlanır.
*/
const analysisCache = new Map(); // key: sha256 -> value: analysis

/* ================= OpenAI FILE UPLOAD ================= */
async function uploadToOpenAI(buffer, filename, mimetype) {
  const form = new FormData();
  form.append("purpose", "assistants");
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

/* ================= POST-CHECK / NORMALIZE ================= */
function normalizeAnalysis(a) {
  const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/;

  const fixVin = (v) => {
    const s = String(v ?? "").trim().toUpperCase();
    return vinRegex.test(s) ? s : "";
  };

  const fixKg = (v) => {
    const s = String(v ?? "")
      .toUpperCase()
      .replace(",", ".")
      .trim();
    const m = s.match(/(\d+(\.\d+)?)/);
    return m ? m[1] : "";
  };

  const fixText = (v) => String(v ?? "").trim();

  const out = a && typeof a === "object" ? a : {};
  out.cmr = out.cmr && typeof out.cmr === "object" ? out.cmr : {};
  out.invoice = out.invoice && typeof out.invoice === "object" ? out.invoice : {};

  // Ensure nested objects exist
  out.cmr.exporter = out.cmr.exporter && typeof out.cmr.exporter === "object" ? out.cmr.exporter : { name: "", address: "" };
  out.cmr.importer = out.cmr.importer && typeof out.cmr.importer === "object" ? out.cmr.importer : { name: "", address: "", id: "" };

  out.invoice.exporter = out.invoice.exporter && typeof out.invoice.exporter === "object" ? out.invoice.exporter : { name: "", address: "" };
  out.invoice.importer = out.invoice.importer && typeof out.invoice.importer === "object" ? out.invoice.importer : { name: "", address: "", id: "" };

  // Trim all text fields
  out.cmr.exporter.name = fixText(out.cmr.exporter.name);
  out.cmr.exporter.address = fixText(out.cmr.exporter.address);
  out.cmr.importer.name = fixText(out.cmr.importer.name);
  out.cmr.importer.address = fixText(out.cmr.importer.address);
  out.cmr.importer.id = fixText(out.cmr.importer.id);

  out.cmr.goods_name = fixText(out.cmr.goods_name);
  out.cmr.vin = fixVin(out.cmr.vin);
  out.cmr.gross_weight_kg = fixKg(out.cmr.gross_weight_kg);
  out.cmr.loading_place = fixText(out.cmr.loading_place);
  out.cmr.delivery_place = fixText(out.cmr.delivery_place);
  out.cmr.date = fixText(out.cmr.date);

  out.invoice.exporter.name = fixText(out.invoice.exporter.name);
  out.invoice.exporter.address = fixText(out.invoice.exporter.address);
  out.invoice.importer.name = fixText(out.invoice.importer.name);
  out.invoice.importer.address = fixText(out.invoice.importer.address);
  out.invoice.importer.id = fixText(out.invoice.importer.id);

  out.invoice.goods_name = fixText(out.invoice.goods_name);
  out.invoice.vin = fixVin(out.invoice.vin);
  out.invoice.invoice_no = fixText(out.invoice.invoice_no);
  out.invoice.invoice_date = fixText(out.invoice.invoice_date);
  out.invoice.total_amount = fixText(out.invoice.total_amount);

  return out;
}

/* ================= ANALYZE ================= */
async function analyzeFile(file_id) {
  const prompt = `
Sən CMR və Invoice sənədini analiz edirsən. Sənəd 2 səhifə ola bilər:
- 1-ci səhifə: CMR
- 2-ci səhifə: Invoice

CMR oxunuş qaydası (ÇOX VACİB):
- Qrafa 1 (yuxarı sol): Exporter/Consignor adı + ünvanı
- Qrafa 2 (qrafa 1-in altında, sol): Importer/Consignee adı + ünvanı və ya ID
- Orta hissə (qrafalar 6-12 arası ola bilər): malın adı (goods/vehicle description), VIN varsa, çəki (kg), ədəd/packaging
- VIN 17 simvol olur (A-HJ-NPR-Z və 0-9)

Invoice oxunuş qaydası:
- Seller/Shipper -> exporter
- Buyer/Consignee -> importer
- Goods/Vehicle description, VIN, invoice number, invoice date, total amount

Yalnız JSON qaytar (tapılmayan sahələr boş string):

{
  "cmr": {
    "exporter": {"name":"", "address":""},
    "importer": {"name":"", "address":"", "id":""},
    "goods_name": "",
    "vin": "",
    "gross_weight_kg": "",
    "loading_place": "",
    "delivery_place": "",
    "date": ""
  },
  "invoice": {
    "exporter": {"name":"", "address":""},
    "importer": {"name":"", "address":"", "id":""},
    "goods_name": "",
    "vin": "",
    "invoice_no": "",
    "invoice_date": "",
    "total_amount": ""
  }
}

Qaydalar:
- VIN yalnız 17 simvol regex-ə uyğundursa yaz, yoxsa boş string.
- CMR-də “Exporter/Importer” yerlərini qrafa 1 və 2-yə görə seç.
- Əlavə izah yazma. Yalnız JSON.
  `.trim();

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      top_p: 1,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_file", file_id }
          ]
        }
      ],
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

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "JSON parse error", raw_text: text };
  }

  return normalizeAnalysis(parsed);
}

/* ================= ROUTES ================= */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * POST /upload
 * form-data: file=<pdf>
 * returns: { status, analysis, cached }
 */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fayl yoxdur" });

    // ✅ hash -> cache
    const hash = crypto
      .createHash("sha256")
      .update(req.file.buffer)
      .digest("hex");

    if (analysisCache.has(hash)) {
      return res.json({
        status: "success",
        cached: true,
        analysis: analysisCache.get(hash)
      });
    }

    // ✅ OpenAI upload -> analyze
    const file_id = await uploadToOpenAI(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );

    const analysis = await analyzeFile(file_id);

    analysisCache.set(hash, analysis);

    return res.json({
      status: "success",
      cached: false,
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
