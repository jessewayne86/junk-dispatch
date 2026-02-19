// server.js
import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";

// Node 18+ has fetch built-in. If your runtime is older, install node-fetch.
const app = express();

app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends form-encoded by default

// ===================== CONFIG =====================
// REQUIRED: your Apps Script Web App URL (the upsert-by-Job-ID endpoint)
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;

// OPTIONAL: used to generate upload links
const BASE_URL = process.env.BASE_URL || "https://example.com";

// Twilio notify
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const OWNER_PHONE = process.env.OWNER_PHONE;
const BUSINESS_PHONE = process.env.TWILIO_NUMBER;

// ===================== HELPERS =====================
async function postToSheet(payload) {
  if (!SHEETS_WEBHOOK_URL) {
    console.warn("SHEETS_WEBHOOK_URL is missing; skipping sheet write.");
    return { skipped: true };
  }

  const r = await fetch(SHEETS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await r.text().catch(() => "");
  console.log("Sheets status:", r.status, "body:", text.slice(0, 1500));

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!r.ok) {
    throw new Error(`Sheets webhook failed: ${r.status} ${text}`);
  }

  return json;
}

function generateJobId() {
  return "job_" + Math.random().toString(36).slice(2, 9);
}

// ===== VAPI CALL ↔ JOB MAPPING (simple + works now) =====
const callToJob = new Map();

function getCallId(message) {
  return (
    message?.call?.id ||
    message?.callId ||
    message?.call_id ||
    message?.message?.call?.id ||
    message?.event?.call?.id ||
    ""
  );
}

function getToolCalls(message) {
  // Vapi payloads vary — support a few common shapes
  return (
    message?.toolCalls ||
    message?.tool_calls ||
    message?.message?.toolCalls ||
    message?.message?.tool_calls ||
    []
  );
}

function getToolName(tc) {
  return tc?.name || tc?.toolName || tc?.function?.name || "";
}

function getToolArgs(tc) {
  return tc?.args || tc?.arguments || tc?.function?.arguments || {};
}

function getToolCallId(tc) {
  return tc?.id || tc?.toolCallId || tc?.tool_call_id || "";
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
  };
}

// ===================== ROUTES =====================
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

/**
 * VAPI WEBHOOK
 * Handles:
 * - tool calls mid-call (create_intake/update_intake) -> writes/updates row immediately
 * - end-of-call-report -> writes final snapshot to same Job ID
 */
app.post("/vapi/webhook", async (req, res) => {
  try {
    const message = req.body;

    console.log("Vapi event:", JSON.stringify(message).slice(0, 2000));

    // 1) TOOL CALLS (mid-call)
    const toolCalls = getToolCalls(message);
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const callId = String(getCallId(message) || "").trim();
      const toolCallResults = [];

      for (const tc of toolCalls) {
        const toolName = getToolName(tc);
        const args = getToolArgs(tc);
        const toolCallId = getToolCallId(tc);

        // ---- create_intake ----
        if (toolName === "create_intake") {
          const resolvedCallId = String(args.callId || callId || "").trim();
          if (!resolvedCallId) {
            toolCallResults.push({
              toolCallId,
              result: { ok: false, error: "Missing callId" },
            });
            continue;
          }

          // Reuse or create jobId for this call
          const existingJobId = callToJob.get(resolvedCallId);
          const jobId = existingJobId || generateJobId();
          callToJob.set(resolvedCallId, jobId);

          // Prefer structured data if present, otherwise args
          const sd =
            message?.analysis?.structuredData ||
            message?.message?.analysis?.structuredData ||
            args;

          const payload = {
            ...buildPayloadFromStructuredData(sd, jobId),
            "Call ID": resolvedCallId,
            callId: resolvedCallId,
            "Photos Link": sd?.photoLink || `${BASE_URL}/upload?job=${jobId}`,
            "Webhook Event": "tool-create_intake",
          };

          try {
            const sheetResp = await postToSheet(payload);
            console.log("✅ Mid-call intake row written:", { jobId, callId: resolvedCallId });
            toolCallResults.push({
              toolCallId,
              result: {
                ok: true,
                jobId,
                photoLink: payload["Photos Link"],
                sheet: sheetResp,
              },
            });
          } catch (err) {
            console.error("❌ Sheet write failed (create_intake):", err?.message || err);
            toolCallResults.push({
              toolCallId,
              result: { ok: false, error: "Sheet write failed (create_intake)" },
            });
          }

          continue;
        }

        // ---- update_intake ----
        if (toolName === "update_intake") {
          const resolvedCallId = String(args.callId || callId || "").trim();
          const mappedJobId = resolvedCallId ? callToJob.get(resolvedCallId) : null;

          const jobId = String(args.jobId || args["Job ID"] || mappedJobId || "").trim();
          if (!jobId) {
            toolCallResults.push({
              toolCallId,
              result: { ok: false, error: "Missing jobId (and no callId→jobId mapping found)" },
            });
            continue;
          }

          if (resolvedCallId) callToJob.set(resolvedCallId, jobId);

          const sd =
            message?.analysis?.structuredData ||
            message?.message?.analysis?.structuredData ||
            args;

          const payload = {
            ...buildPayloadFromStructuredData(sd, jobId),
            "Call ID": resolvedCallId,
            callId: resolvedCallId,
            "Webhook Event": "tool-update_intake",
          };

          try {
            const sheetResp = await postToSheet(payload);
            console.log("✅ Intake updated:", { jobId, callId: resolvedCallId });
            toolCallResults.push({
              toolCallId,
              result: { ok: true, jobId, sheet: sheetResp },
            });
          } catch (err) {
            console.error("❌ Sheet write failed (update_intake):", err?.message || err);
            toolCallResults.push({
              toolCallId,
              result: { ok: false, error: "Sheet write failed (update_intake)" },
            });
          }

          continue;
        }

        // Unknown tool
        toolCallResults.push({
          toolCallId,
          result: { ok: false, error: `Unhandled tool: ${toolName}` },
        });
      }

      // IMPORTANT: Vapi expects toolCallResults for tool call events
      return res.status(200).json({ toolCallResults });
    }

    // 2) END OF CALL REPORT (final snapshot)
    if (message?.type === "end-of-call-report") {
      const sd = message?.analysis?.structuredData || {};
      const callId = String(getCallId(message) || "").trim();

      // Reuse mid-call jobId if available
      const jobId = (callId && callToJob.get(callId)) ? callToJob.get(callId) : generateJobId();

      const payload = {
        ...buildPayloadFromStructuredData(sd, jobId),
        "Call ID": callId,
        callId,
        "Webhook Event": "call-end",
      };

      try {
        await postToSheet(payload);
        console.log("✅ End-of-call row written:", { jobId, callId });
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
 * Keep this if you ever add an HTTP tool later. Not required for the current Vapi tool-call flow.
 */
app.post("/intake", async (req, res) => {
  console.log("Intake raw body:", JSON.stringify(req.body).slice(0, 2000));

  const sd =
    req.body?.message?.analysis?.structuredData ||
    req.body?.analysis?.structuredData ||
    req.body;

  const jobId = generateJobId();

  const payload = {
    ...buildPayloadFromStructuredData(sd, jobId),
    "Call ID": String(getCallId(req.body) || "").trim(),
    "Photos Link": sd?.photoLink || `${BASE_URL}/upload?job=${jobId}`,
    "Webhook Event": "http-intake",
  };

  try {
    await postToSheet(payload);
    console.log("✅ Intake row written:", jobId);
  } catch (err) {
    console.error("❌ Sheet write failed (intake):", err?.message || err);
  }

  return res.json({
    ok: true,
    jobId,
    photoLink: payload["Photos Link"],
  });
});

// ===== TWILIO SMS ROUTE =====
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
