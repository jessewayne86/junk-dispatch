import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends form-encoded by default

// ===== CALLID -> JOBID (for end-of-call update) =====
// NOTE: This is in-memory. If Railway restarts mid-call, mapping can be lost.
// Best long-term: store this in a DB/Redis OR ensure jobId is included in end-of-call structured data.
const callIdToJobId = new Map();

function getCallIdFromVapiMessage(message) {
  return (
    message?.call?.id ||
    message?.callId ||
    message?.conversationId ||
    message?.id ||
    null
  );
}

// ===== HELPERS =====
async function postToSheet(payload) {
  if (!process.env.SHEETS_WEBHOOK_URL) {
    console.warn("SHEETS_WEBHOOK_URL is missing; skipping sheet write.");
    return;
  }

  const r = await fetch(process.env.SHEETS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await r.text().catch(() => "");
  console.log("Sheets status:", r.status, "body:", text);

  if (!r.ok) {
    throw new Error(`Sheets webhook failed: ${r.status} ${text}`);
  }
}

function buildPayloadFromStructuredData(sd, jobId, sourceValue = "vapi") {
  const phone =
    sd?.callbackNumber && sd.callbackNumber !== "Same number"
      ? sd.callbackNumber
      : (sd?.phone || sd?.from || "");

  const specialItemsText = Array.isArray(sd?.specialItems)
    ? sd.specialItems.join(", ")
    : (sd?.specialItems || "");

  const accessText = Array.isArray(sd?.access)
    ? sd.access.join(", ")
    : (sd?.access || "");

  // Build a clean scope description (still one cell, but structured)
  const scopeParts = [
    sd?.jobType ? `jobType: ${sd.jobType}` : "",
    sd?.location ? `location: ${sd.location}` : "",
    sd?.size ? `size: ${sd.size}` : "",
    accessText ? `access: ${accessText}` : "",
    specialItemsText ? `specialItems: ${specialItemsText}` : "",
    sd?.deadline ? `deadline: ${sd.deadline}` : "",
  ].filter(Boolean);

  return {
    // ✅ Match your sheet columns (Jobs header row)
    "Job ID": jobId,
    "Created At": new Date().toISOString(),
    "Source": sourceValue,

    "Customer Name": sd?.name || "",
    "Customer Phone": phone,
    "Customer Email": sd?.email || "",

    "Service Address": sd?.serviceAddress || sd?.address || "",
    "City/ZIP": sd?.cityZip || sd?.city || sd?.zip || "",

    "Job Type": sd?.jobType || "",
    "Items / Scope Description": scopeParts.join(" | "),

    // Your sheet header is "Preferred Timing"
    "Preferred Timing": sd?.preferredWindow || "",
    "Urgent (Y/N)": (sd?.urgent || sd?.urgent_flag) ? "Y" : "N",

    "Photos Link": sd?.photoLink || "",

    // You can use these for internal tracking on intake
    "Intake Notes": sd?.intakeNotes || "",
    "Status": sd?.status || "New",
  };
}

// ===== ROUTES =====
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

/**
 * VAPI WEBHOOK
 * This is where Vapi sends call events.
 * We write to the sheet when the call ends (end-of-call-report),
 * AND we reuse the jobId created during /intake so Apps Script can update the same row.
 */
app.post("/vapi/webhook", async (req, res) => {
  try {
    const message = req.body;

    // Keep your existing logging (trim to avoid log spam)
    console.log("Vapi event:", JSON.stringify(message).slice(0, 2000));

    // ✅ Only write to sheet on end-of-call-report (best signal + clean data)
    if (message?.type === "end-of-call-report") {
      const sd = message?.analysis?.structuredData || {};

      const callId = getCallIdFromVapiMessage(message);

      // Prefer a jobId provided in structuredData (best, survives restarts),
      // otherwise use in-memory map from /intake,
      // otherwise fallback to a random jobId (will create a new row).
      const jobId =
        (sd && (sd["Job ID"] || sd.jobId)) ||
        (callId ? callIdToJobId.get(callId) : null) ||
        ("job_" + Math.random().toString(36).slice(2, 9));

      const payload = buildPayloadFromStructuredData(sd, jobId, "call-end");

      try {
        await postToSheet(payload);
        console.log("✅ End-of-call upsert sent:", { jobId, callId });
      } catch (err) {
        console.error("❌ Sheet write failed (end-of-call):", err?.message || err);
      }
    }

    // Always 200 so Vapi doesn't retry
    return res.status(200).send("ok");
  } catch (err) {
    console.error("❌ /vapi/webhook error:", err?.message || err);
    return res.status(200).send("ok");
  }
});

app.post("/twilio/call-status", (req, res) => {
  console.log("Twilio call status:", req.body);
  res.status(200).send("ok");
});

/**
 * /intake
 * Called mid-call by create_intake tool.
 * It returns jobId + photoLink and writes the FIRST row (source: intake).
 * We also store callId -> jobId so end-of-call can update the same row.
 */
app.post("/intake", async (req, res) => {
  console.log("Intake raw body:", JSON.stringify(req.body).slice(0, 2000));

  const sd =
    req.body?.message?.analysis?.structuredData ||
    req.body?.analysis?.structuredData ||
    req.body;

  const jobId = "job_" + Math.random().toString(36).slice(2, 9);
  const base = process.env.BASE_URL || "https://example.com";
  const photoLink = `${base}/upload?job=${jobId}`;

  // Try to capture callId from multiple possible shapes
  const callId =
    req.body?.call?.id ||
    req.body?.callId ||
    req.body?.message?.call?.id ||
    req.body?.message?.callId ||
    sd?.callId ||
    null;

  if (callId) {
    callIdToJobId.set(callId, jobId);
    console.log("✅ Stored callId -> jobId:", { callId, jobId });
  } else {
    console.warn("⚠️ No callId found on /intake; end-of-call may create a new row.");
  }

  // Ensure the sheet has the photo link on intake
  const payload = buildPayloadFromStructuredData({ ...sd, photoLink }, jobId, "intake");

  try {
    await postToSheet(payload);
    console.log("✅ Intake row written:", { jobId, callId });
  } catch (err) {
    console.error("❌ Sheet write failed (intake):", err?.message || err);
    // Don't fail the call flow because Sheets failed
  }

  return res.json({
    ok: true,
    jobId,
    photoLink,
  });
});

// ===== TWILIO SMS ROUTE =====
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
    hasToken: !!process.env.TWILIO_AUTH_TOKEN,
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
      moreInfo: err?.moreInfo,
    });
  }

  res.status(200).send("ok");
});

// ===== SERVER START =====
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log("Listening on port", port);
});
