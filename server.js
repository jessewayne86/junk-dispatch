/**
 * Junk Dispatch - Unified Server
 * - Keeps existing Vapi webhook flow (/vapi/webhook)
 * - Keeps existing owner SMS notify route (/webhooks/sms)
 * - Adds middleware inbound SMS route (/webhooks/inbound-sms):
 *    1) notify owner via SMS + email
 *    2) forward inbound payload to Vapi Twilio SMS endpoint
 *    3) return Vapi response to Twilio (preserves Vapi auto-reply)
 */

import express from "express";
import twilio from "twilio";
import sgMail from "@sendgrid/mail";

const app = express();

// Twilio sends x-www-form-urlencoded by default for inbound SMS webhooks
app.use(express.urlencoded({ extended: false }));
// Keep JSON in case your Vapi webhook posts JSON
app.use(express.json({ limit: "2mb" }));

// ===== ENV =====
const {
  NODE_ENV,
  SHEETS_WEBHOOK_URL,

  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,

  OWNER_PHONE,

  SENDGRID_API_KEY,
  ALERT_EMAIL_TO,
  ALERT_EMAIL_FROM,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_NUMBER) {
  console.warn("Missing Twilio env vars. Check TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_NUMBER.");
}
if (!OWNER_PHONE) {
  console.warn("Missing OWNER_PHONE (your personal). Owner alerts will not send.");
}

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
} else {
  console.warn("Missing SENDGRID_API_KEY. Email alerts will not send.");
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ===== HELPERS =====
function extractMedia(reqBody) {
  const numMedia = parseInt(reqBody.NumMedia || "0", 10);
  const media = [];
  for (let i = 0; i < numMedia; i++) {
    const url = reqBody[`MediaUrl${i}`];
    const type = reqBody[`MediaContentType${i}`];
    if (url) media.push({ url, type });
  }
  return media;
}

async function notifyOwnerSms({ from, body, firstPhotoUrl }) {
  if (!OWNER_PHONE) return;

  // Keep SMS short. Put full details in email.
  const smsBody =
    `📩 New lead: ${from} — ${body}` +
    (firstPhotoUrl ? ` | Photo: ${firstPhotoUrl}` : "");

  await twilioClient.messages.create({
    from: TWILIO_NUMBER,
    to: OWNER_PHONE,
    body: smsBody,
  });
}

async function notifyOwnerEmail({ from, to, body, media }) {
  if (!SENDGRID_API_KEY || !ALERT_EMAIL_TO || !ALERT_EMAIL_FROM) return;

  const mediaBlock = media.length
    ? `\n\nPhotos:\n${media.map(m => `${m.type || "media"}: ${m.url}`).join("\n")}`
    : `\n\nPhotos: (none)`;

  const text =
    `NEW SMS/MMS LEAD\n` +
    `From: ${from}\n` +
    `To: ${to}\n\n` +
    `Message:\n${body}` +
    mediaBlock +
    `\n\n(Reply by calling/texting manually for now until A2P is active.)`;

  console.log("SENDGRID CHECK:", {
  hasKey: !!process.env.SENDGRID_API_KEY,
  to: process.env.ALERT_EMAIL_TO,
  from: process.env.ALERT_EMAIL_FROM
});
  
  await sgMail.send({
    to: ALERT_EMAIL_TO,
    from: ALERT_EMAIL_FROM,
    subject: `New SMS lead from ${from}`,
    text,
  });
}

// ===== ROUTES =====

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, env: NODE_ENV || "unknown" });
});

/**
 * EXISTING ROUTE (kept):
 * /webhooks/sms
 * - Notifies owner by SMS only.
 * - Doesn't forward to Vapi.
 * (You can keep it for internal testing.)
 */
app.post("/webhooks/sms", async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body || "";
    await twilioClient.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_PHONE,
      body: `New SMS from ${from}: ${body}`,
    });
    res.send("ok");
  } catch (err) {
    console.error("Error in /webhooks/sms:", err?.message || err);
    res.status(500).send("error");
  }
});

/**
 * NEW ROUTE (use this as Twilio inbound SMS webhook):
 * /webhooks/inbound-sms
 * 1) Alert you instantly (SMS + email)
 * 2) Forward payload to Vapi
 * 3) Return Vapi response to Twilio (preserves auto-reply)
 */
app.post("/webhooks/inbound-sms", async (req, res) => {
  const from = req.body.From;
  const to = req.body.To;
  const body = req.body.Body || "";

  const media = extractMedia(req.body);
  const firstPhotoUrl = media[0]?.url;

  // 1) Alert owner via SMS (don’t block on failure)
  try {
    await notifyOwnerSms({ from, body, firstPhotoUrl });
  } catch (err) {
    console.error("Owner SMS alert failed:", err?.code, err?.message || err);
  }

  // 2) Alert owner via Email (don’t block on failure)
  try {
    await notifyOwnerEmail({ from, to, body, media });
  } catch (err) {
    console.error("Owner Email alert failed:", err?.response?.body || err?.message || err);
  }

  // 3) Forward to Vapi to preserve auto-response
  try {
    const vapiResp = await fetch("https://api.vapi.ai/twilio/sms", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(req.body).toString(),
    });

    const text = await vapiResp.text();

    // 4) Return Vapi response back to Twilio
    return res
      .status(200)
      .type(vapiResp.headers.get("content-type") || "text/xml")
      .send(text);
  } catch (err) {
    console.error("Forward to Vapi failed:", err?.message || err);

    // Always ACK Twilio so it doesn't retry and spam you
    return res.status(200).type("text/xml").send("<Response></Response>");
  }
});

/**
 * EXISTING Vapi webhook route (kept, based on your current build):
 * /vapi/webhook
 * - Receives Vapi call events/tool calls
 * - Writes to Sheets via SHEETS_WEBHOOK_URL
 *
 * IMPORTANT: This should remain unchanged to avoid breaking your voice flow.
 */
app.post("/vapi/webhook", async (req, res) => {
  try {
    // Your existing logic likely expects JSON from Vapi
    // We forward to Sheets if configured
    if (SHEETS_WEBHOOK_URL) {
      try {
        await fetch(SHEETS_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
        });
      } catch (sheetErr) {
        console.error("Sheets webhook failed:", sheetErr?.message || sheetErr);
      }
    } else {
      console.warn("SHEETS_WEBHOOK_URL not set; skipping Sheets write.");
    }

    // Always ACK Vapi
    res.json({ ok: true });
  } catch (err) {
    console.error("Error in /vapi/webhook:", err?.message || err);
    res.status(200).json({ ok: true }); // still ACK to prevent retries
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
