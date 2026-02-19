import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends form-encoded by default

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

function buildPayloadFromStructuredData(sd, jobId) {
  const phone =
    sd?.callbackNumber && sd.callbackNumber !== "Same number"
      ? sd.callbackNumber
      : (sd?.phone || sd?.from || "");

  const specialItemsText = Array.isArray(sd?.specialItems)
    ? sd.specialItems.join(", ")
    : (sd?.specialItems || "");

  // Build a clean scope description (still one cell, but structured)
  const scopeParts = [
    sd?.jobType ? `jobType: ${sd.jobType}` : "",
    sd?.location ? `location: ${sd.location}` : "",
    sd?.size ? `size: ${sd.size}` : "",
    sd?.access ? `access: ${Array.isArray(sd.access) ? sd.access.join(", ") : sd.access}` : "",
    specialItemsText ? `specialItems: ${specialItemsText}` : "",
    sd?.deadline ? `deadline: ${sd.deadline}` : "",
  ].filter(Boolean);

  return {
    // ✅ Match your sheet columns (Jobs header row)
    "Job ID": jobId,
    "Created At": new Date().toISOString(),
    "Source": sd?.source || "vapi",

    "Customer Name": sd?.name || "",
    "Customer Phone": phone,
    "Customer Email": sd?.email || "",

    "Service Address": sd?.serviceAddress || sd?.address || "",
    "City/ZIP": sd?.cityZip || sd?.city || sd?.zip || "",

    "Job Type": sd?.jobType || "",
    "Items / Scope Description": scopeParts.join(" | "),

    "Preferred Timing": sd?.preferredWindow || "",
    "Urgent (Y/N)": (sd?.urgent || sd?.urgent_flag) ? "Y" : "N",

    "Photos Link": sd?.photoLink || "",

    // You can use these for internal tracking on intake
    "Intake Notes": sd?.intakeNotes || "",
    "Status": sd?.status || "New",

    // Optional: helps debugging
    "Webhook Event": "call-end",
  };
}


// ===== ROUTES =====
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

/**
 * VAPI WEBHOOK
 * This is where Vapi sends call events.
 * We write to the sheet when the call ends (end-of-call-report).
 */
app.post("/vapi/webhook", async (req, res) => {
  try {
    const message = req.body;

    // Keep your existing logging (trim to avoid log spam)
    console.log("Vapi event:", JSON.stringify(message).slice(0, 2000));

    // ✅ Only write to sheet on end-of-call-report (best signal + clean data)
    if (message?.type === "end-of-call-report") {
      const sd = message?.analysis?.structuredData || {};
      const jobId = "job_" + Math.random().toString(36).slice(2, 9);

      const payload = buildPayloadFromStructuredData(sd, jobId);

      try {
        await postToSheet(payload);
        console.log("✅ End-of-call row written:", jobId);
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
 * OPTIONAL: /intake
 * Use this if you create a Vapi Tool called create_intake that calls this endpoint mid-call.
 * It returns jobId + photoLink and ALSO writes a row (source: intake).
 */
app.post("/intake", async (req, res) => {
  console.log("Intake raw body:", JSON.stringify(req.body).slice(0, 2000));

  const sd =
    req.body?.message?.analysis?.structuredData ||
    req.body?.analysis?.structuredData ||
    req.body;

  const jobId = "job_" + Math.random().toString(36).slice(2, 9);
  const base = process.env.BASE_URL || "https://example.com";

  const payload = {
    ...buildPayloadFromStructuredData(sd, jobId),
    source: "intake",
  };

  try {
    await postToSheet(payload);
    console.log("✅ Intake row written:", jobId);
  } catch (err) {
    console.error("❌ Sheet write failed (intake):", err?.message || err);
    // Don't fail the call flow because Sheets failed
  }

  return res.json({
    ok: true,
    jobId,
    photoLink: `${base}/upload?job=${jobId}`,
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
