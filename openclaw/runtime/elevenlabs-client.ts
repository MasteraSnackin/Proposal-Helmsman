import {
  ConfigurationError,
  ExternalServiceError,
  RequestTimeoutError,
  extractResponseSnippet,
  isAbortLikeError
} from "./errors.ts";

export type ElevenLabsClientInfo = {
  provider: "elevenlabs";
  mode: "live" | "mock";
  configured: boolean;
  voiceId?: string;
  modelId: string;
  outputFormat: string;
};

export type ElevenLabsVoiceSettings = {
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
};

export type SynthesizeSpeechInput = {
  text: string;
  voiceId?: string;
  modelId?: string;
  outputFormat?: string;
  languageCode?: string;
  voiceSettings?: ElevenLabsVoiceSettings;
};

export type SynthesizeSpeechResult = {
  audioData: Uint8Array;
  contentType: string;
  extension: string;
  provider: "live" | "mock";
  voiceId: string;
  modelId: string;
  outputFormat: string;
  characterCount: number;
};

const DEFAULT_API_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const DEFAULT_MOCK_VOICE_ID = "demo-voice";

export function getElevenLabsClientInfo(): ElevenLabsClientInfo {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();

  return {
    provider: "elevenlabs",
    mode: shouldUseMockMode(apiKey, voiceId) ? "mock" : "live",
    configured: Boolean(apiKey && voiceId),
    voiceId: voiceId || undefined,
    modelId: resolveModelId(),
    outputFormat: resolveOutputFormat()
  };
}

export async function synthesizeSpeech(
  input: SynthesizeSpeechInput,
): Promise<SynthesizeSpeechResult> {
  const text = input.text.trim();

  if (!text) {
    throw new ConfigurationError("ElevenLabs synthesis requires non-empty text.");
  }

  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const voiceId = input.voiceId?.trim() || process.env.ELEVENLABS_VOICE_ID?.trim();
  const modelId = input.modelId?.trim() || resolveModelId();
  const outputFormat = input.outputFormat?.trim() || resolveOutputFormat();

  if (shouldUseMockMode(apiKey, voiceId)) {
    return buildMockSpeech(text, voiceId || DEFAULT_MOCK_VOICE_ID, modelId);
  }

  const target = buildSynthesisUrl(voiceId!, outputFormat);
  const response = await requestElevenLabs(target, apiKey!, {
    text,
    model_id: modelId,
    ...(input.languageCode?.trim() ? { language_code: input.languageCode.trim() } : {}),
    ...(input.voiceSettings ? { voice_settings: normalizeVoiceSettings(input.voiceSettings) } : {})
  });

  if (!response.ok) {
    const responseText = await safeReadResponseText(response);
    throw new ExternalServiceError(`ElevenLabs request failed with ${response.status}.`, {
      service: "elevenlabs",
      statusCode: response.status >= 400 && response.status < 500 ? response.status : 502,
      retryable: response.status >= 500 || response.status === 429,
      details: {
        voiceId,
        modelId,
        status: response.status,
        response: extractResponseSnippet(responseText)
      }
    });
  }

  const audioData = new Uint8Array(await response.arrayBuffer());

  if (audioData.byteLength === 0) {
    throw new ExternalServiceError("ElevenLabs response did not contain audio data.", {
      service: "elevenlabs",
      retryable: false,
      details: {
        voiceId,
        modelId
      }
    });
  }

  return {
    audioData,
    contentType: response.headers.get("content-type") ?? mimeTypeForOutputFormat(outputFormat),
    extension: extensionForOutputFormat(outputFormat),
    provider: "live",
    voiceId: voiceId!,
    modelId,
    outputFormat,
    characterCount: Number(response.headers.get("x-character-count")) || text.length
  };
}

function shouldUseMockMode(apiKey?: string, voiceId?: string): boolean {
  return (
    process.env.ELEVENLABS_MOCK_MODE === "true" ||
    !apiKey?.trim() ||
    !voiceId?.trim()
  );
}

function resolveModelId(): string {
  return (process.env.ELEVENLABS_MODEL_ID ?? DEFAULT_MODEL_ID).trim();
}

function resolveOutputFormat(): string {
  return (process.env.ELEVENLABS_OUTPUT_FORMAT ?? DEFAULT_OUTPUT_FORMAT).trim();
}

function buildSynthesisUrl(voiceId: string, outputFormat: string): string {
  const baseUrl = process.env.ELEVENLABS_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  const url = new URL(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`, baseUrl);
  url.searchParams.set("output_format", outputFormat);
  return url.toString();
}

async function requestElevenLabs(
  target: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  try {
    return await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": apiKey
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(parseTimeout(process.env.ELEVENLABS_TIMEOUT_MS, 20_000))
    });
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new RequestTimeoutError("ElevenLabs request timed out.", {
        service: "elevenlabs",
        details: {
          target,
          timeoutMs: parseTimeout(process.env.ELEVENLABS_TIMEOUT_MS, 20_000)
        },
        cause: error
      });
    }

    throw new ExternalServiceError("ElevenLabs request could not be completed.", {
      service: "elevenlabs",
      details: {
        target
      },
      cause: error
    });
  }
}

function normalizeVoiceSettings(
  input: ElevenLabsVoiceSettings,
): Record<string, boolean | number> {
  const settings: Record<string, boolean | number> = {};

  if (typeof input.stability === "number") {
    settings.stability = input.stability;
  }

  if (typeof input.similarityBoost === "number") {
    settings.similarity_boost = input.similarityBoost;
  }

  if (typeof input.style === "number") {
    settings.style = input.style;
  }

  if (typeof input.useSpeakerBoost === "boolean") {
    settings.use_speaker_boost = input.useSpeakerBoost;
  }

  if (typeof input.speed === "number") {
    settings.speed = input.speed;
  }

  return settings;
}

function buildMockSpeech(
  text: string,
  voiceId: string,
  modelId: string,
): SynthesizeSpeechResult {
  return {
    audioData: createSilentWave(text),
    contentType: "audio/wav",
    extension: "wav",
    provider: "mock",
    voiceId,
    modelId,
    outputFormat: "wav_16000_16",
    characterCount: text.length
  };
}

function createSilentWave(text: string): Uint8Array {
  const sampleRate = 16_000;
  const durationSeconds = Math.min(2, Math.max(0.35, text.length / 180));
  const sampleCount = Math.max(1, Math.floor(sampleRate * durationSeconds));
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function mimeTypeForOutputFormat(outputFormat: string): string {
  const codec = outputFormat.split("_")[0]?.toLowerCase();

  switch (codec) {
    case "wav":
      return "audio/wav";
    case "pcm":
      return "audio/L16";
    case "ulaw":
      return "audio/basic";
    case "mp3":
    default:
      return "audio/mpeg";
  }
}

function extensionForOutputFormat(outputFormat: string): string {
  const codec = outputFormat.split("_")[0]?.toLowerCase();

  switch (codec) {
    case "wav":
      return "wav";
    case "pcm":
      return "pcm";
    case "ulaw":
      return "ulaw";
    case "mp3":
    default:
      return "mp3";
  }
}

function parseTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
