import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.post("/vapi/webhook", (req, res) => {
  console.log("Vapi event:", JSON.stringify(req.body).slice(0, 2000));
  res.status(200).send("ok");
});

app.post("/intake", (req, res) => {
  console.log("Intake:", req.body);

  const jobId = "job_" + Math.random().toString(36).slice(2, 9);
  const base = process.env.BASE_URL || "https://example.com";

  res.json({
    jobId,
    photoLink: `${base}/upload?job=${jobId}`
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Listening on port", port);
});
