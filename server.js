import express from "express";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.send("OK"));

app.post("/api/invoices", (req, res) => {
  console.log(req.body);
  res.send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
