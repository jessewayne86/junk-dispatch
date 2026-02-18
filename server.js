import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false })); // <-- required for Twilio

// ===== EXISTING ROUTES =====

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.post("/vapi/webhook", (req, res) => {
  console.log("Vapi event:", JSON.stringify(req.body).slice(0, 2000));
  res.status(200).send("ok");
});

app.post("/twilio/call-status", (req, res) => {
  console.log("Twilio call status:", req.body);
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

// ===== NEW TWILIO SMS ROUTE =====

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const OWNER_PHONE = process.env.OWNER_PHONE;
const BUSINESS_PHONE = process.env.TWILIO_NUMBER;

app.post("/webhooks/sms", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log("Inbound SMS:", { from, body });

  console.log("Notify vars:", {
  OWNER_PHONE,
  BUSINESS_PHONE,
  hasSid: !!process.env.TWILIO_ACCOUNT_SID,
  hasToken: !!process.env.TWILIO_AUTH_TOKEN
});

try {
  console.log("Attempting notification send...");
  const msg = await twilioClient.messages.create({
    from: BUSINESS_PHONE,
    to: OWNER_PHONE,
    body: `📩 New Message\nFrom: ${from}\n\n"${body}"`,
  });

  console.log("Notification SENT. SID:", msg.sid);
} catch (err) {
  console.error("Notification FAILED:", {
    status: err?.status,
    code: err?.code,
    message: err?.message,
    moreInfo: err?.moreInfo
  });
}

  res.status(200).send("ok");
});

// ===== SERVER START =====

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log("Listening on port", port);
});
