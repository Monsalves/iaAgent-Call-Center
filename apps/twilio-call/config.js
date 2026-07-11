import path from "node:path";
import { fileURLToPath } from "node:url";

import { getProjectRoot, loadEnvForApp, readRequiredEnv } from "../../shared/env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadEnvForApp(__dirname);

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return "";
}

function numberFromEnv(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === "string" && value.trim() === "") {
      continue;
    }

    return Number(value);
  }

  return Number.NaN;
}

export const config = {
  appName: "twilio-call",
  projectRoot: getProjectRoot(),
  host: firstNonEmpty(process.env.TWILIO_CALL_HOST, process.env.APP_HOST, "127.0.0.1"),
  port: numberFromEnv(process.env.TWILIO_CALL_PORT, process.env.APP_PORT, 8090),
  publicBaseUrl: firstNonEmpty(process.env.PUBLIC_BASE_URL),
  triggerToken: firstNonEmpty(process.env.TWILIO_CALL_TRIGGER_TOKEN),
  azureOpenAIEndpoint: readRequiredEnv("AZURE_OPENAI_ENDPOINT"),
  azureOpenAIApiKey: readRequiredEnv("AZURE_OPENAI_API_KEY"),
  deploymentName: readRequiredEnv("AZURE_OPENAI_DEPLOYMENT_NAME"),
  apiVersion: firstNonEmpty(process.env.AZURE_OPENAI_API_VERSION, "2025-04-01-preview"),
  voice: firstNonEmpty(process.env.TWILIO_CALL_VOICE, process.env.AZURE_OPENAI_VOICE, "alloy"),
  systemPrompt:
    firstNonEmpty(
      process.env.TWILIO_CALL_SYSTEM_PROMPT,
      process.env.CALL_CENTER_SYSTEM_PROMPT,
      "Eres un agente de call center saliente. Responde siempre en espanol, con tono cordial, directo y breve."
    ),
  vadThreshold: numberFromEnv(
    process.env.TWILIO_CALL_VAD_THRESHOLD,
    process.env.AZURE_OPENAI_VAD_THRESHOLD,
    0.62
  ),
  vadPrefixPaddingMs: numberFromEnv(
    process.env.TWILIO_CALL_VAD_PREFIX_PADDING_MS,
    process.env.AZURE_OPENAI_VAD_PREFIX_PADDING_MS,
    180
  ),
  vadSilenceDurationMs: numberFromEnv(
    process.env.TWILIO_CALL_VAD_SILENCE_DURATION_MS,
    process.env.AZURE_OPENAI_VAD_SILENCE_DURATION_MS,
    420
  ),
  bargeInDebounceMs: numberFromEnv(
    process.env.TWILIO_CALL_BARGE_IN_DEBOUNCE_MS,
    process.env.BARGE_IN_DEBOUNCE_MS,
    450
  ),
  twilioAccountSid: firstNonEmpty(process.env.TWILIO_ACCOUNT_SID),
  twilioAuthToken: firstNonEmpty(process.env.TWILIO_AUTH_TOKEN),
  twilioFromNumber: firstNonEmpty(process.env.TWILIO_FROM_NUMBER),
  twilioToNumber: firstNonEmpty(process.env.TWILIO_TO_NUMBER),
  twilioVoiceWebhookPath: firstNonEmpty(process.env.TWILIO_VOICE_WEBHOOK_PATH, "/twilio/voice"),
  twilioStatusWebhookPath: firstNonEmpty(
    process.env.TWILIO_STATUS_WEBHOOK_PATH,
    "/twilio/status"
  ),
  twilioStreamPath: firstNonEmpty(process.env.TWILIO_STREAM_PATH, "/twilio-media-stream"),
  dataFile: firstNonEmpty(process.env.CAMPAIGN_DATA_FILE, "data/campaign-store.json"),
  redisUrl: firstNonEmpty(process.env.REDIS_URL, "redis://127.0.0.1:6379"),
  bullMqQueueName: firstNonEmpty(process.env.BULLMQ_QUEUE_NAME, "outbound-calls"),
  maxConcurrentCalls: numberFromEnv(process.env.MAX_CONCURRENT_CALLS, 1),
  dispatchIntervalMs: numberFromEnv(process.env.CAMPAIGN_DISPATCH_INTERVAL_MS, 1000),
  maxCallAttempts: numberFromEnv(process.env.MAX_CALL_ATTEMPTS, 3),
  retryBaseMs: numberFromEnv(process.env.CALL_RETRY_BASE_MS, 5000)
};
