import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import { EventEmitter } from "node:events";

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/openai\/v1\/?$/, "").replace(/\/$/, "");
}

function toToolMap(tools = []) {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

export class AzureRealtimeSession extends EventEmitter {
  constructor({ config, metadata = {}, instructions, tools = [] }) {
    super();
    this.config = config;
    this.metadata = metadata;
    this.instructions = instructions;
    this.session = null;
    this.closed = false;
    this.responseActive = false;
    this.cancelPending = false;
    this.lastResponseId = null;
    this.toolMap = toToolMap(tools);
    this.client = new OpenAI({
      baseURL: `${normalizeEndpoint(config.azureOpenAIEndpoint)}/openai/v1`,
      apiKey: config.azureOpenAIApiKey
    });
  }

  async start() {
    let createdResolve;
    const createdPromise = new Promise((resolve) => {
      createdResolve = resolve;
    });

    this.session = await OpenAIRealtimeWS.create(this.client, {
      model: this.config.deploymentName,
      options: {
        headers: {
          "api-key": this.config.azureOpenAIApiKey
        }
      }
    });

    this.session.on("error", (error) => {
      if (error?.error?.code === "response_cancel_not_active") {
        this.cancelPending = false;
        this.responseActive = false;
      }
      this.responseActive = false;
      this.emit("error", error);
    });
    this.session.on("session.created", () => {
      this.emit("debug", "Azure Realtime session created");
      createdResolve();
    });
    this.session.on("session.updated", () => {
      this.emit("debug", "Azure Realtime session updated");
    });
    this.session.on("input_audio_buffer.speech_started", (event) => {
      this.emit("speech-started", { eventId: event?.event_id ?? null, at: Date.now() });
      this.emit("client-event", { type: "barge-in" });
      this.emit("barge-in", {
        eventId: event?.event_id ?? null,
        at: Date.now()
      });
    });
    this.session.on("input_audio_buffer.speech_stopped", () => {
      this.emit("client-event", { type: "speech-stopped" });
    });
    this.session.on("response.created", (event) => {
      this.responseActive = true;
      this.cancelPending = false;
      this.lastResponseId = event.response?.id ?? this.lastResponseId;
      this.emit("response-started", { responseId: this.lastResponseId, at: Date.now() });
    });
    this.session.on("response.output_audio.delta", (event) => {
      this.responseActive = true;
      this.lastResponseId = event.response_id ?? this.lastResponseId;
      this.emit("assistantAudio", Buffer.from(event.delta, "base64"));
    });
    this.session.on("response.output_text.delta", (event) => {
      this.responseActive = true;
      this.lastResponseId = event.response_id ?? this.lastResponseId;
      this.emit("assistantText", event.delta);
    });
    this.session.on("response.output_audio_transcript.delta", (event) => {
      this.responseActive = true;
      this.lastResponseId = event.response_id ?? this.lastResponseId;
      this.emit("assistantText", event.delta);
    });
    this.session.on("response.output_audio_transcript.done", (event) => {
      const text = String(event.transcript || "").trim();
      if (text) this.emit("transcript-turn", { role: "assistant", text, turnId: event.item_id || event.response_id || null, at: Date.now() });
    });
    this.session.on("conversation.item.input_audio_transcription.completed", (event) => {
      const text = String(event.transcript || "").trim();
      if (text) this.emit("transcript-turn", { role: "user", text, turnId: event.item_id || null, at: Date.now() });
    });
    this.session.on("response.done", (event) => {
      this.responseActive = false;
      this.cancelPending = false;
      this.lastResponseId = event.response?.id ?? this.lastResponseId;
      this.emit("client-event", {
        type: "response-done",
        status: event.response?.status || "unknown"
      });
      this.emit("response-done", { responseId: this.lastResponseId, status: event.response?.status || "unknown", at: Date.now() });
    });
    this.session.on("response.function_call_arguments.done", async (event) => {
      await this.handleFunctionCall(event);
    });
    this.session.on("conversation.item.created", (event) => {
      if (event.item?.type !== "function_call") {
        return;
      }
      this.emit("client-event", {
        type: "tool-created",
        tool: event.item.name,
        callId: event.item.call_id ?? null
      });
      this.emit(
        "debug",
        `tool-created ${event.item.name || "unknown"} (${event.item.call_id || "sin-call-id"})`
      );
    });
    this.session.socket?.addEventListener?.("close", () => {
      this.responseActive = false;
      this.cancelPending = false;
    });

    await createdPromise;

    this.session.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: this.instructions,
        output_modalities: ["audio"],
        tool_choice: this.toolMap.size > 0 ? "auto" : "none",
        tools: [...this.toolMap.values()].map((tool) => tool.definition),
        audio: {
          input: {
            transcription: {
              model: "whisper-1"
            },
            format: {
              type: "audio/pcm",
              rate: 24000
            },
            turn_detection: {
              type: "server_vad",
              threshold: this.config.vadThreshold,
              prefix_padding_ms: this.config.vadPrefixPaddingMs,
              silence_duration_ms: this.config.vadSilenceDurationMs,
              create_response: true,
              interrupt_response: true
            }
          },
          output: {
            voice: this.config.voice,
            format: {
              type: "audio/pcm",
              rate: 24000
            }
          }
        }
      }
    });
  }

  async receiveAudioChunk(pcm24kBuffer) {
    if (
      this.closed ||
      !this.session ||
      !this.session.socket ||
      this.session.socket.readyState !== this.session.socket.OPEN
    ) {
      return;
    }

    this.session.send({
      type: "input_audio_buffer.append",
      audio: Buffer.from(pcm24kBuffer).toString("base64")
    });
  }

  async handleFunctionCall(event) {
    if (!this.session || this.closed) {
      return;
    }

    const tool = this.toolMap.get(event.name);
    if (!tool) {
      return;
    }

    const output = await tool.handle({
      event,
      metadata: this.metadata,
      emit: (type, payload) => this.emit(type, payload)
    });

    this.session.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output
      }
    });

    this.session.send({
      type: "response.create"
    });
  }

  cancelResponse() {
    if (
      !this.responseActive ||
      this.cancelPending ||
      this.closed ||
      !this.session ||
      !this.session.socket ||
      this.session.socket.readyState !== this.session.socket.OPEN
    ) {
      return false;
    }

    this.cancelPending = true;
    this.session.send({
      type: "response.cancel"
    });
    return true;
  }

  async close() {
    this.closed = true;
    this.responseActive = false;
    this.cancelPending = false;
    if (this.session?.socket && this.session.socket.readyState === this.session.socket.OPEN) {
      this.session.close();
    }
    this.removeAllListeners();
  }
}
