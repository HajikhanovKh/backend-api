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

/* ========= FILE UPLOAD ========= */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

/* ========= OpenAI Upload ========= */

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

/* ========= Analyze ========= */

async function analyzeFile(file_id) {

  const prompt = `
CMR və ya Invoice sənədindən aşağıdakı məlumatları tap:

- Malın adı
- VIN (17 simvol varsa)
- İdxalatçı
- İxracatçı

Yalnız JSON qaytar:

{
  "doc_type": "",
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

  return JSON.parse(text);
}

/* ========= ROUTES ========= */

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/upload", upload.single("file"), async (req, res) => {
  try {

    if (!req.file) {
      return res.status(400).json({ error: "Fayl yoxdur" });
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
    res.status(500).json({ error: err.message });
  }
});

app.post("/analyze", async (req, res) => {
  try {

    const { file_id } = req.body;
    if (!file_id) {
      return res.status(400).json({ error: "file_id lazımdır" });
    }

    const result = await analyzeFile(file_id);

    res.json({
      status: "analyzed",
      data: result
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ========= START ========= */

app.listen(PORT, () => {
  console.log("Server başladı:", PORT);
});
