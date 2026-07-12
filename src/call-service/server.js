import http from "node:http";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";

import { decodeTwilioPayload, encodeTwilioPayload, resamplePcm16 } from "../shared/audio.js";
import { config } from "./config.js";
import { createRealtimeSession } from "./realtime.js";
import { CampaignStore } from "./store.js";
import { BullMqCampaignQueue } from "./bullmq-queue.js";
import { parseContactsCsv } from "./csv.js";

const app = express();
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const server = http.createServer(app);
const twilioWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false
});

function getBearerToken(request) {
  const header = String(request.headers.authorization ?? "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) {
    return "";
  }

  return header.slice(7).trim();
}

function requireTriggerAuth(request, response, next) {
  if (!config.triggerToken) {
    next();
    return;
  }

  const token = getBearerToken(request);
  if (token && token === config.triggerToken) {
    next();
    return;
  }

  response.status(401).json({
    error: "Unauthorized. Send Authorization: Bearer <token>."
  });
}

function requireTwilioConfig() {
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioFromNumber) {
    throw new Error(
      "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER."
    );
  }
}

function buildPublicUrl(pathname, query = {}) {
  if (!config.publicBaseUrl) {
    throw new Error("PUBLIC_BASE_URL is required to build Twilio webhooks.");
  }

  const url = new URL(pathname, config.publicBaseUrl);
  Object.entries(query).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });
  return url;
}

function buildStreamUrl() {
  const url = buildPublicUrl(config.twilioStreamPath);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function buildTwiml({ name, context, campaignPrompt = "", attemptId = "" }) {
  const streamUrl = buildStreamUrl();
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<Response>",
    "  <Connect>",
    `    <Stream url="${streamUrl.toString()}">`,
    `      <Parameter name="name" value="${encodeURIComponent(name || "")}" />`,
    `      <Parameter name="context" value="${encodeURIComponent(context || "")}" />`,
    `      <Parameter name="campaignPrompt" value="${encodeURIComponent(campaignPrompt)}" />`,
    `      <Parameter name="attemptId" value="${encodeURIComponent(attemptId)}" />`,
    "    </Stream>",
    "  </Connect>",
    "</Response>"
  ].join("\n");
}

async function createTwilioCall({ to, name, context, campaignId = "", contactId = "", attemptId = "", campaignPrompt = "" }) {
  requireTwilioConfig();

  const statusCallbackUrl = buildPublicUrl(config.twilioStatusWebhookPath, { campaignId, contactId, attemptId });
  const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64");
  const payload = new URLSearchParams();
  payload.set("To", to);
  payload.set("From", config.twilioFromNumber);
  payload.set("StatusCallback", statusCallbackUrl.toString());
  payload.set("StatusCallbackMethod", "POST");
  ["initiated", "ringing", "answered", "completed"].forEach((eventName) => {
    payload.append("StatusCallbackEvent", eventName);
  });
  payload.set("Twiml", buildTwiml({ name, context, campaignPrompt, attemptId }));

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Calls.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: payload.toString()
    }
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || `Twilio call creation failed with status ${response.status}`);
  }

  return body;
}

const store = new CampaignStore(path.resolve(config.projectRoot, config.dataFile));
const campaignQueue = new BullMqCampaignQueue({
  store,
  createCall: ({ phone, ...metadata }) => createTwilioCall({ ...metadata, to: phone, name: metadata.name, context: JSON.stringify(metadata.context) }),
  redisUrl: config.redisUrl,
  queueName: config.bullMqQueueName,
  maxConcurrentCalls: config.maxConcurrentCalls,
  maxAttempts: config.maxCallAttempts,
  retryBaseMs: config.retryBaseMs
});
const forcedAttemptResults = new Map();

function attachSessionHandlers(session, emitAudio, closeSocket) {
  session.on("debug", (message) => {
    console.log(`[twilio-call][debug] ${message}`);
  });
  session.on("assistantText", (text) => {
    console.log(`[twilio-call] ${text}`);
  });
  session.on("assistantAudio", async (audio24k) => {
    try {
      await emitAudio(audio24k);
    } catch (error) {
      console.error("[twilio-call] failed to emit audio", error);
      closeSocket(1011, "audio emit failed");
    }
  });
  session.on("error", (error) => {
    if (error?.error?.code === "response_cancel_not_active") {
      console.warn("[twilio-call] ignoring late cancel after barge-in", {
        responseId: session.lastResponseId
      });
      return;
    }

    console.error("[twilio-call] session error", error);
    closeSocket(1011, "provider error");
  });
}

function logTiming(stage, data = {}) {
  console.log("[timing]", {
    stage,
    at: new Date().toISOString(),
    ...data
  });
}

function sendTwilioClear(socket, streamSid) {
  if (!streamSid || socket.readyState !== socket.OPEN) {
    return false;
  }

  socket.send(
    JSON.stringify({
      event: "clear",
      streamSid
    }),
    { compress: false }
  );
  return true;
}

app.use(express.text({ type: ["text/csv", "application/csv"], limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use((request, response, next) => {
  if (!request.path.startsWith("/twilio")) {
    next();
    return;
  }

  console.log("[twilio-http] request", {
    method: request.method,
    path: request.path,
    query: request.query,
    host: request.headers.host,
    userAgent: request.headers["user-agent"],
    forwardedFor: request.headers["x-forwarded-for"],
    twilioSignature: request.headers["x-twilio-signature"]
  });

  response.on("finish", () => {
    console.log("[twilio-http] response", {
      method: request.method,
      path: request.path,
      statusCode: response.statusCode
    });
  });

  next();
});

app.get("/", (_, response) => {
  response.json({
    app: config.appName,
    status: "ok",
    endpoints: [
      "/health",
      config.twilioVoiceWebhookPath,
      config.twilioStatusWebhookPath,
      "/twilio/call",
      config.twilioStreamPath,
      "/api/campaigns"
    ]
  });
});

app.get("/ui", (_, response) => response.sendFile(path.join(publicDirectory, "index.html")));

app.get("/health", (_, response) => {
  response.json({
    status: "ok",
    app: config.appName,
    model: config.deploymentName,
    voice: config.voice,
    publicBaseUrlConfigured: Boolean(config.publicBaseUrl),
    triggerAuthConfigured: Boolean(config.triggerToken),
    twilioConfigured: Boolean(
      config.twilioAccountSid && config.twilioAuthToken && config.twilioFromNumber
    ),
    campaignStore: config.dataFile,
    redisConfigured: Boolean(config.redisUrl),
    maxConcurrentCalls: config.maxConcurrentCalls
  });
});

app.get("/api/campaigns", requireTriggerAuth, (_, response) => response.json({ campaigns: store.listCampaigns() }));

app.post("/api/campaigns", requireTriggerAuth, (request, response) => {
  const name = String(request.body?.name ?? "").trim();
  if (!name) return response.status(400).json({ error: "Campaign name is required." });
  try { return response.status(201).json({ campaign: store.createCampaign({ name, prompt: String(request.body?.prompt ?? "") }) }); }
  catch (error) { return response.status(500).json({ error: error.message }); }
});

app.post("/api/campaigns/:campaignId/contacts/csv", requireTriggerAuth, async (request, response) => {
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.includes("text/csv") && !contentType.includes("application/csv")) return response.status(415).json({ error: "Use Content-Type: text/csv." });
  try {
    const contacts = parseContactsCsv(request.body);
    const created = store.addContacts(request.params.campaignId, contacts);
    await campaignQueue.enqueueContacts(request.params.campaignId, created);
    return response.status(201).json({ imported: created.length, campaignId: request.params.campaignId });
  } catch (error) {
    const status = /Redis|Connection|connect|ECONNREFUSED/i.test(error.message) ? 503 : 400;
    return response.status(status).json({ error: error.message });
  }
});

app.get("/api/campaigns/:campaignId", requireTriggerAuth, (request, response) => {
  const campaign = store.getCampaign(request.params.campaignId);
  return campaign ? response.json({ campaign }) : response.status(404).json({ error: "Campaign not found." });
});

app.post("/api/campaigns/:campaignId/start", requireTriggerAuth, async (request, response) => {
  const campaign = store.getCampaign(request.params.campaignId);
  if (!campaign) return response.status(404).json({ error: "Campaign not found." });
  if (!campaign.contacts.length) return response.status(409).json({ error: "Campaign has no contacts." });
  if (!["ready", "paused", "error"].includes(campaign.status)) return response.status(409).json({ error: `Campaign cannot start from ${campaign.status}.` });
  const activeCampaign = store.listCampaigns().find((item) => item.status === "running" && item.id !== campaign.id);
  if (activeCampaign) return response.status(409).json({ error: `Campaign ${activeCampaign.id} is already running; the MVP supports one active campaign.` });
  try { return response.json({ campaign: await campaignQueue.start(campaign.id) }); }
  catch (error) {
    store.setCampaignStatus(campaign.id, "error");
    return response.status(503).json({ error: `Redis/BullMQ unavailable: ${error.message}` });
  }
});

app.post("/api/campaigns/:campaignId/pause", requireTriggerAuth, async (request, response) => {
  const campaign = store.getCampaign(request.params.campaignId);
  if (!campaign) return response.status(404).json({ error: "Campaign not found." });
  if (campaign.status !== "running") return response.status(409).json({ error: "Only a running campaign can be paused." });
  try { return response.json({ campaign: await campaignQueue.pause(campaign.id) }); }
  catch (error) { return response.status(503).json({ error: `Redis/BullMQ unavailable: ${error.message}` }); }
});

app.post("/api/campaigns/:campaignId/resume", requireTriggerAuth, async (request, response) => {
  const campaign = store.getCampaign(request.params.campaignId);
  if (!campaign) return response.status(404).json({ error: "Campaign not found." });
  if (campaign.status !== "paused") return response.status(409).json({ error: "Only a paused campaign can be resumed." });
  try { return response.json({ campaign: await campaignQueue.resume(campaign.id) }); }
  catch (error) { return response.status(503).json({ error: `Redis/BullMQ unavailable: ${error.message}` }); }
});

app.all(config.twilioVoiceWebhookPath, (request, response) => {
  try {
    const name = String(request.query.name ?? request.body?.name ?? "");
    const context = String(request.query.context ?? request.body?.context ?? "");
    response.type("text/xml").send(buildTwiml({ name, context }));
  } catch (error) {
    response.status(500).json({
      error: error?.message || String(error)
    });
  }
});

app.post(config.twilioStatusWebhookPath, (request, response) => {
  console.log("[twilio-status]", {
    callSid: request.body?.CallSid,
    callStatus: request.body?.CallStatus,
    callDuration: request.body?.CallDuration,
    from: request.body?.From,
    to: request.body?.To,
    sequenceNumber: request.body?.SequenceNumber,
    sipResponseCode: request.body?.SipResponseCode
  });
  const callSid = request.body?.CallSid;
  const attempt = store.findAttemptByCallSid(callSid) || (request.query.attemptId ? store.snapshot().attempts.find((item) => item.id === request.query.attemptId) : null);
  const status = String(request.body?.CallStatus || "").toLowerCase();
  if (attempt && ["completed", "busy", "no-answer", "failed", "canceled"].includes(status)) {
    const forcedResultCode = forcedAttemptResults.get(attempt.id);
    forcedAttemptResults.delete(attempt.id);
    const resultCode = forcedResultCode || { "no-answer": "no_answer", busy: "busy", failed: "failed", canceled: "provider_error", completed: "completed" }[status];
    const retryDelayMs = resultCode === "provider_error" ? config.retryBaseMs * 2 ** (attempt.attemptNumber - 1) : 0;
    const completedAttempt = store.finishAttempt(attempt.id, { resultCode, durationSeconds: Number(request.body?.CallDuration || 0), errorMessage: request.body?.ErrorCode || null, retryDelayMs });
    campaignQueue.completeAttempt(completedAttempt);
  }
  response.json({ status: "ok" });
});

app.post("/twilio/call", requireTriggerAuth, async (request, response) => {
  const to = String(request.body?.to ?? config.twilioToNumber ?? "").trim();
  const name = String(request.body?.name ?? "");
  const context = String(request.body?.context ?? "");

  if (!to) {
    response.status(400).json({
      error: "Missing destination phone number. Send {\"to\":\"+56...\"} or set TWILIO_TO_NUMBER."
    });
    return;
  }

  try {
    const call = await createTwilioCall({ to, name, context });
    response.json({
      status: "initiated",
      sid: call.sid,
      to: call.to,
      from: call.from,
      mediaStreamUrl: buildStreamUrl().toString()
    });
  } catch (error) {
    console.error("[twilio-call] call creation failed", error);
    response.status(500).json({
      error: error?.message || String(error)
    });
  }
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== config.twilioStreamPath) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  twilioWss.handleUpgrade(request, socket, head, (websocket) => {
    twilioWss.emit("connection", websocket, request);
  });
});

twilioWss.on("connection", async (socket, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let streamSid = null;
  let session = null;
  let interruptionPending = false;
  let lastBargeInAt = 0;
  let attemptId = "";
  let silenceTimer = null;

  const clearSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
  };
  const scheduleSilenceTimeout = () => {
    clearSilenceTimer();
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      if (attemptId) forcedAttemptResults.set(attemptId, "silence_timeout");
      logTiming("contact_silence_timeout", { streamSid, attemptId, timeoutMs: config.contactSilenceTimeoutMs });
      if (socket.readyState === socket.OPEN) socket.close(1000, "contact silence timeout");
    }, config.contactSilenceTimeoutMs);
  };

  socket.on("message", async (rawMessage) => {
    try {
      const payload = JSON.parse(rawMessage.toString());
      if (payload.event === "connected") {
        return;
      }

      if (payload.event === "start") {
        streamSid = payload.start.streamSid;
        const customParameters = payload.start.customParameters ?? {};
        session = createRealtimeSession({
          name: decodeURIComponent(customParameters.name ?? url.searchParams.get("name") ?? ""),
          context: decodeURIComponent(
            customParameters.context ?? url.searchParams.get("context") ?? ""
          ),
          campaignPrompt: decodeURIComponent(customParameters.campaignPrompt ?? ""),
          attemptId: decodeURIComponent(customParameters.attemptId ?? "")
        });
        attachSessionHandlers(
          session,
          async (audio24k) => {
            if (!streamSid || socket.readyState !== socket.OPEN) {
              return;
            }
            if (interruptionPending) {
              logTiming("assistant_audio_after_barge_in", {
                streamSid,
                responseId: session.lastResponseId
              });
              interruptionPending = false;
            }
            const audio8k = resamplePcm16(audio24k, 24000, 8000);
            socket.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: {
                  payload: encodeTwilioPayload(audio8k)
                }
              }),
              { compress: false }
            );
          },
          (code, reason) => socket.close(code, reason)
        );
        attemptId = decodeURIComponent(customParameters.attemptId ?? "");
        if (attemptId) session.on("transcript-turn", ({ role, text, turnId }) => store.appendTranscript(attemptId, role, text, turnId));
        session.on("speech-started", clearSilenceTimer);
        session.on("response-started", clearSilenceTimer);
        session.on("response-done", ({ status }) => {
          if (status === "completed") scheduleSilenceTimeout();
        });
        session.on("barge-in", ({ at }) => {
          if (at - lastBargeInAt < config.bargeInDebounceMs) {
            logTiming("speech_started_ignored", { streamSid, detectedAtMs: at });
            return;
          }
          lastBargeInAt = at;
          logTiming("speech_started", { streamSid, detectedAtMs: at });
          const cleared = sendTwilioClear(socket, streamSid);
          if (cleared) {
            interruptionPending = true;
            logTiming("twilio_clear_sent", { streamSid });
          }
          const cancelled = session.cancelResponse();
          if (cancelled) {
            logTiming("azure_response_cancel_sent", {
              streamSid,
              responseId: session.lastResponseId
            });
          }
        });
        await session.start();
        scheduleSilenceTimeout();
        return;
      }

      if (payload.event === "media" && session) {
        const inboundPcm8k = decodeTwilioPayload(payload.media.payload);
        const inboundPcm24k = resamplePcm16(inboundPcm8k, 8000, 24000);
        await session.receiveAudioChunk(inboundPcm24k);
        return;
      }

      if (payload.event === "stop") {
        clearSilenceTimer();
        interruptionPending = false;
        socket.close(1000, "twilio stop");
      }
    } catch (error) {
      console.error("[twilio-media-stream] message handling failed", error);
      socket.close(1011, "bridge error");
    }
  });

  socket.on("close", async () => {
    clearSilenceTimer();
    await session?.close().catch(() => undefined);
  });

  socket.on("error", async (error) => {
    clearSilenceTimer();
    console.error("[twilio-media-stream] websocket error", error);
    await session?.close().catch(() => undefined);
  });
});

server.listen(config.port, config.host, () => {
  console.log(`twilio-call listening on http://${config.host}:${config.port}`);
});
