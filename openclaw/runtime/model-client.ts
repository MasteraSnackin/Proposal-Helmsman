import { createDemoLlm } from "./demo-llm.ts";
import {
  ConfigurationError,
  ExternalServiceError,
  RequestTimeoutError,
  extractResponseSnippet,
  isAbortLikeError
} from "./errors.ts";
import { isRecord, type GenerateOptions, type LlmClient } from "./types.ts";

export type ModelClientInfo = {
  provider: string;
  model: string;
  mode: "live" | "demo";
};

export function createConfiguredLlm(): LlmClient {
  const provider = (process.env.OPENCLAW_MODEL_PROVIDER ?? "google")
    .trim()
    .toLowerCase();

  if (provider === "demo") {
    return createDemoLlm();
  }

  if ((provider === "google" || provider === "gemini") && process.env.GEMINI_API_KEY) {
    return createGeminiLlm();
  }

  return createDemoLlm();
}

export function getModelClientInfo(): ModelClientInfo {
  const provider = (process.env.OPENCLAW_MODEL_PROVIDER ?? "google")
    .trim()
    .toLowerCase();
  const model = (process.env.OPENCLAW_MODEL ?? "gemini-2.5-flash").trim();
  const liveGemini = (provider === "google" || provider === "gemini") && Boolean(process.env.GEMINI_API_KEY);

  return {
    provider,
    model,
    mode: liveGemini ? "live" : "demo"
  };
}

function createGeminiLlm(): LlmClient {
  return {
    async generate<T = unknown>(options: GenerateOptions) {
      const apiKey = process.env.GEMINI_API_KEY?.trim();

      if (!apiKey) {
        throw new ConfigurationError("GEMINI_API_KEY is required for the Gemini model client.");
      }

      const model = (process.env.OPENCLAW_MODEL ?? "gemini-2.5-flash").trim();
      const temperature = parseTemperature(process.env.OPENCLAW_TEMPERATURE);
      const responseMimeType =
        options.output?.format === "json" ? "application/json" : "text/plain";

      const payload: Record<string, unknown> = {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `<system>\n${options.system}\n</system>\n\n<task>\n${options.prompt}\n</task>`
              }
            ]
          }
        ],
        generationConfig: {
          temperature,
          responseMimeType,
          ...(options.output?.format === "json" && options.output.schema
            ? { responseJsonSchema: options.output.schema }
            : {})
        }
      };

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const response = await requestGemini(endpoint, apiKey, payload);

      if (!response.ok) {
        const responseText = await safeReadResponseText(response);
        throw new ExternalServiceError(`Gemini request failed with ${response.status}.`, {
          service: "gemini",
          statusCode: response.status >= 400 && response.status < 500 ? response.status : 502,
          retryable: response.status >= 500 || response.status === 429,
          details: {
            model,
            status: response.status,
            response: extractResponseSnippet(responseText)
          }
        });
      }

      let raw: unknown;

      try {
        raw = (await response.json()) as unknown;
      } catch (error) {
        throw new ExternalServiceError("Gemini returned invalid JSON.", {
          service: "gemini",
          details: {
            model,
            status: response.status
          },
          retryable: true,
          cause: error
        });
      }

      const text = extractGeminiText(raw);

      if (!text) {
        throw new ExternalServiceError("Gemini response did not contain text output.", {
          service: "gemini",
          details: {
            model,
            status: response.status
          },
          retryable: false
        });
      }

      if (options.output?.format === "json") {
        return {
          text
        };
      }

      return text as T | string;
    }
  };
}

function extractGeminiText(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const candidates = payload.candidates;

  if (!Array.isArray(candidates)) {
    return undefined;
  }

  const texts = candidates
    .flatMap((candidate) => {
      if (!isRecord(candidate) || !isRecord(candidate.content)) {
        return [];
      }

      const parts = candidate.content.parts;

      if (!Array.isArray(parts)) {
        return [];
      }

      return parts
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : undefined))
        .filter((value): value is string => Boolean(value));
    })
    .join("\n")
    .trim();

  return texts || undefined;
}

function parseTemperature(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0.4;
}

async function requestGemini(
  endpoint: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  try {
    return await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(parseTimeout(process.env.OPENCLAW_MODEL_TIMEOUT_MS, 20_000))
    });
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new RequestTimeoutError("Gemini request timed out.", {
        service: "gemini",
        details: {
          timeoutMs: parseTimeout(process.env.OPENCLAW_MODEL_TIMEOUT_MS, 20_000)
        },
        cause: error
      });
    }

    throw new ExternalServiceError("Gemini request could not be completed.", {
      service: "gemini",
      details: {
        endpoint
      },
      cause: error
    });
  }
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
