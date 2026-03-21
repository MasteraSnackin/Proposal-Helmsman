import { isRecord } from "../runtime/types.ts";
import {
  ConfigurationError,
  ExternalServiceError,
  RequestTimeoutError,
  extractResponseSnippet,
  isAbortLikeError,
  stringifyUnknown
} from "../runtime/errors.ts";

export type GuardDecision = {
  decision: "allow" | "block" | "modify";
  modifiedText?: string;
  reasons?: string[];
};

type GuardRoute = "input" | "tool" | "output";

const BLOCK_RULES: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(full client list|complete client list|all client names|share client names)\b/i,
    reason: "Client references and internal client lists are sensitive and cannot be disclosed."
  },
  {
    pattern: /\b(confidential document|internal document|private attachment|bypass compliance)\b/i,
    reason: "Confidential materials and compliance controls must not be bypassed."
  }
];

const MODIFY_RULES: Array<{
  pattern: RegExp;
  replacement: string;
  reason: string;
}> = [
  {
    pattern: /\bunlimited liability\b/gi,
    replacement: "liability terms subject to mutual agreement and contract",
    reason: "Do not promise unlimited liability."
  },
  {
    pattern: /\b(guaranteed?|commit to)\s+100%\s+uptime\b/gi,
    replacement: "high availability targets subject to agreed service levels",
    reason: "Do not invent hard uptime guarantees."
  },
  {
    pattern: /\bprovide exact pricing\b/gi,
    replacement: "provide pricing once the commercial scope is confirmed",
    reason: "Do not invent pricing commitments."
  }
];

export async function guardInput(
  text: string,
  context: { agent: string; workspaceId?: string },
): Promise<GuardDecision> {
  return requestGuard("input", { text, context }, text);
}

export async function guardToolCall(
  tool: string,
  args: unknown,
  context: { workspaceId: string },
): Promise<GuardDecision> {
  return requestGuard("tool", { tool, args, context }, JSON.stringify(args) ?? "");
}

export async function guardOutput(
  text: string,
  context: { use: "draft" | "export"; workspaceId: string },
): Promise<GuardDecision> {
  return requestGuard("output", { text, context }, text);
}

async function requestGuard(
  route: GuardRoute,
  body: Record<string, unknown>,
  mockText: string,
): Promise<GuardDecision> {
  const baseUrl = process.env.CIVIC_GUARD_URL?.trim();
  const apiKey = process.env.CIVIC_API_KEY?.trim();
  const useMock =
    process.env.CIVIC_MOCK_MODE === "true" || !baseUrl || !apiKey;

  if (useMock) {
    return runMockGuard(mockText);
  }

  try {
    let target: string;

    try {
      target = new URL(
        route,
        baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
      ).toString();
    } catch (error) {
      throw new ConfigurationError("Civic guard URL is invalid.", {
        route,
        baseUrl,
        cause: stringifyUnknown(error)
      });
    }

    const response = await requestCivic(target, apiKey, body);
    const responseText = await safeReadResponseText(response);

    if (!response.ok) {
      throw new ExternalServiceError(`Civic guard request failed with ${response.status}.`, {
        service: "civic",
        statusCode: response.status >= 400 && response.status < 500 ? response.status : 502,
        retryable: response.status >= 500 || response.status === 429,
        details: {
          route,
          status: response.status,
          response: extractResponseSnippet(responseText)
        }
      });
    }

    let payload: unknown;

    try {
      payload = responseText ? (JSON.parse(responseText) as unknown) : {};
    } catch (error) {
      throw new ExternalServiceError("Civic guard returned invalid JSON.", {
        service: "civic",
        details: {
          route,
          status: response.status,
          response: extractResponseSnippet(responseText)
        },
        cause: error
      });
    }

    const decision = parseGuardDecision(payload);

    if (!decision) {
      throw new ExternalServiceError("Civic guard response did not match GuardDecision.", {
        service: "civic",
        details: {
          route,
          status: response.status
        },
        retryable: false
      });
    }

    return decision;
  } catch (error) {
    if (process.env.CIVIC_FAIL_OPEN === "true") {
      return {
        decision: "allow",
        reasons: [
          `Civic guard request failed but fail-open mode is enabled: ${stringifyUnknown(error)}`
        ]
      };
    }

    return {
      decision: "block",
      reasons: [`Civic guard request failed: ${stringifyUnknown(error)}`]
    };
  }
}

function runMockGuard(text: string): GuardDecision {
  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(text)) {
      return {
        decision: "block",
        reasons: [rule.reason]
      };
    }
  }

  let modifiedText = text;
  const reasons: string[] = [];

  for (const rule of MODIFY_RULES) {
    rule.pattern.lastIndex = 0;

    if (rule.pattern.test(modifiedText)) {
      rule.pattern.lastIndex = 0;
      modifiedText = modifiedText.replace(rule.pattern, rule.replacement);
      reasons.push(rule.reason);
    }
  }

  if (modifiedText !== text) {
    return {
      decision: "modify",
      modifiedText,
      reasons
    };
  }

  return {
    decision: "allow"
  };
}

function parseGuardDecision(payload: unknown): GuardDecision | undefined {
  if (isGuardDecision(payload)) {
    return payload;
  }

  if (isRecord(payload) && "data" in payload && isGuardDecision(payload.data)) {
    return payload.data;
  }

  return undefined;
}

function isGuardDecision(value: unknown): value is GuardDecision {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.decision === "allow" ||
      value.decision === "block" ||
      value.decision === "modify") &&
    (value.modifiedText === undefined || typeof value.modifiedText === "string") &&
    (value.reasons === undefined ||
      (Array.isArray(value.reasons) &&
        value.reasons.every((reason) => typeof reason === "string")))
  );
}

async function requestCivic(
  target: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  try {
    return await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(parseTimeout(process.env.CIVIC_GUARD_TIMEOUT_MS, 8_000))
    });
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new RequestTimeoutError("Civic guard request timed out.", {
        service: "civic",
        details: {
          target,
          timeoutMs: parseTimeout(process.env.CIVIC_GUARD_TIMEOUT_MS, 8_000)
        },
        cause: error
      });
    }

    throw new ExternalServiceError("Civic guard request could not be completed.", {
      service: "civic",
      details: {
        target
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
