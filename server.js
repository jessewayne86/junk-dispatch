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
app.post("/intake", async (req, res) => {
  console.log("Intake raw body:", JSON.stringify(req.body));

  const sd =
    req.body?.message?.analysis?.structuredData ||
    req.body?.analysis?.structuredData ||
    req.body;

  const jobId = "job_" + Math.random().toString(36).slice(2, 9);
  const base = process.env.BASE_URL || "https://example.com";

  const payload = {
    jobId,
    name: sd?.name || "",
    phone: (sd?.callbackNumber && sd.callbackNumber !== "Same number")
      ? sd.callbackNumber
      : (sd?.phone || sd?.from || ""),
    address: sd?.serviceAddress || sd?.address || "",
    description: [
      sd?.jobType ? `jobType: ${sd.jobType}` : "",
      sd?.location ? `location: ${sd.location}` : "",
      sd?.size ? `size: ${sd.size}` : "",
      sd?.tier ? `tier: ${sd.tier}` : "",
      sd?.deadline ? `deadline: ${sd.deadline}` : "",
      sd?.preferredWindow ? `preferredWindow: ${sd.preferredWindow}` : "",
      sd?.specialItems?.length ? `specialItems: ${sd.specialItems.join(", ")}` : "",
      sd?.escalate ? `escalate: true (${sd?.escalationReason || ""})` : "",
    ].filter(Boolean).join(" | "),
  };

  // Push to Google Sheet (Apps Script webhook)
  try {
    if (!process.env.SHEETS_WEBHOOK_URL) {
      console.warn("SHEETS_WEBHOOK_URL is missing; skipping sheet write.");
    } else {
      const r = await fetch(process.env.SHEETS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      console.log("Sheets status:", r.status, "body:", text);
    }
  } catch (err) {
    console.error("❌ Sheet write failed:", err?.message || err);
  }

  return res.json({
    ok: true,
    jobId,
    photoLink: `${base}/upload?job=${jobId}`,
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
