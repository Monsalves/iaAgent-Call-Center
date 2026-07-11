import { AzureRealtimeSession } from "../shared/azureRealtimeSession.js";
import { config } from "./config.js";

function normalizeContext(context) {
  const rawContext = String(context || "").trim();
  if (!rawContext) {
    return "Sin contexto adicional.";
  }

  try {
    const parsed = JSON.parse(rawContext);
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed)
        .map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join("\n");
    }
  } catch {}

  return rawContext;
}

function buildInstructions(metadata) {
  return [
    config.systemPrompt.trim(),
    metadata.campaignPrompt ? `Instrucciones especificas de campana:\n${metadata.campaignPrompt}` : "",
    "",
    "Contexto de llamada:",
    `- Nombre del contacto: ${metadata.name || "contacto"}`,
    normalizeContext(metadata.context),
    "",
    "Politica de conversacion:",
    "- Abre con un saludo corto y di el motivo de la llamada en una sola frase.",
    "- Valida rapidamente si la persona puede hablar en este momento.",
    "- Haz una sola pregunta por turno.",
    "- Responde con frases cortas, naturales y faciles de entender por telefono.",
    "- Si el usuario interrumpe, cambia inmediatamente al ultimo punto que dijo.",
    "- Si falta informacion, dilo directo y ofrece el siguiente paso.",
    "- Si detectas mas de 10 segundos de silencio, pregunta una vez si la persona sigue en linea.",
    "- Si vuelven a ocurrir dos silencios prolongados sin respuesta, despide la llamada de forma amable.",
    "- Evita explicaciones largas y evita sonar como chatbot.",
    "- Si la llamada ya cumplio su objetivo, cierra de forma breve y amable."
  ].join("\n");
}

export function createRealtimeSession(metadata = {}) {
  return new AzureRealtimeSession({
    config: {
      azureOpenAIEndpoint: config.azureOpenAIEndpoint,
      azureOpenAIApiKey: config.azureOpenAIApiKey,
      deploymentName: config.deploymentName,
      voice: config.voice,
      vadThreshold: config.vadThreshold,
      vadPrefixPaddingMs: config.vadPrefixPaddingMs,
      vadSilenceDurationMs: config.vadSilenceDurationMs
    },
    metadata,
    instructions: buildInstructions(metadata),
    tools: []
  });
}
