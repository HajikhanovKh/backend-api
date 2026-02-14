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
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ================= MULTER (RAM) ================= */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

/* ================= OpenAI FILE UPLOAD ================= */

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
  return data.id;
}

/* ================= ANALYZE ================= */

async function analyzeFile(file_id){

  const prompt = `
Sən CMR və Invoice sənədlərini analiz edən sistemsən.

Aşağıdakı məlumatları tap və yalnız JSON qaytar:

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
- CMR-də Exporter = Consignor
- CMR-də Importer = Consignee
- Invoice-də Exporter = Seller
- Invoice-də Importer = Buyer
- VIN 17 simvolluq koddur (A-Z və 0-9)
- Tapılmayan sahə boş string olsun
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

  return JSON.parse(text);
}

/* ================= ROUTE ================= */

app.post("/upload", upload.single("file"), async (req, res) => {

  try {

    if (!req.file) {
      return res.status(400).json({ error: "Fayl yoxdur" });
    }

    const file_id = await uploadToOpenAI(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );

    const analysis = await analyzeFile(file_id);

    res.json({
      status: "success",
      analysis
    });

  } catch(err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }

});

app.get("/health",(req,res)=>{
  res.json({status:"ok"});
});

app.listen(PORT, ()=>{
  console.log("Server başladı:", PORT);
});
