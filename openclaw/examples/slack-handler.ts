import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";

import {
  hasProcessedSlackEvent,
  recordProcessedSlackEvent
} from "../../backend/slack-idempotency.ts";
import { resolveWorkspaceStorageConfig } from "../../backend/storage-config.ts";
import { createConfiguredLlm } from "../runtime/model-client.ts";
import { createNoopLlm } from "../runtime/noop-llm.ts";
import { invokeProposalOperator } from "../runtime/proposal-operator.ts";
import workspaceStatus from "../skills/proposal-operator/workspace_status.ts";
import { ensureWorkspace } from "../skills/proposal-operator/shared.ts";
import { isRecord, type SkillContext } from "../runtime/types.ts";

type CustomInboundMessage = {
  text: string;
  channelId: string;
  threadId?: string;
  statusOnly?: boolean;
};

type SlackUrlVerification = {
  type: "url_verification";
  challenge: string;
};

type SlackEventEnvelope = {
  type: "event_callback";
  event_id?: string;
  event_time?: number;
  event?: {
    type?: string;
    text?: string;
    channel?: string;
    thread_ts?: string;
    ts?: string;
    bot_id?: string;
    subtype?: string;
  };
};

type NormalizedSlackMessage = {
  text: string;
  channelId: string;
  threadId?: string;
  statusOnly?: boolean;
  eventId?: string;
};

const SLACK_SIGNATURE_HEADER = "x-slack-signature";
const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
const SLACK_MAX_AGE_SECONDS = 60 * 5;

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  try {
    verifySlackSignature(request, rawBody);
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 401 },
    );
  }

  let body: unknown;

  try {
    body = rawBody ? (JSON.parse(rawBody) as unknown) : {};
  } catch {
    return Response.json(
      {
        error: "Slack request body must be valid JSON."
      },
      { status: 400 },
    );
  }

  if (isSlackUrlVerification(body)) {
    return new Response(body.challenge, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8"
      }
    });
  }

  const normalized = extractSlackMessage(body);

  if (!normalized) {
    return Response.json(
      {
        status: "ignored",
        reason: "No actionable Slack message was found."
      },
      { status: 200 },
    );
  }

  const storage = resolveWorkspaceStorageConfig();
  const workspaceId = sanitizeWorkspaceId(
    `${normalized.channelId}_${normalized.threadId ?? "root"}`,
  );
  const workspacePath = path.resolve(storage.workspaceRoot, workspaceId);

  await ensureWorkspace(workspacePath);

  if (normalized.eventId && (await hasProcessedSlackEvent(storage.workspaceRoot, normalized.eventId))) {
    return Response.json(
      {
        status: "ignored",
        reason: "Duplicate Slack event already processed.",
        workspaceId
      },
      { status: 200 },
    );
  }

  const agentResult = await invokeProposalOperator({
    message: normalized.text,
    workspacePath,
    llm: createConfiguredLlm()
  });

  const status = normalized.statusOnly
    ? await workspaceStatus({}, buildContext(workspacePath))
    : undefined;

  if (normalized.eventId) {
    await recordProcessedSlackEvent(storage.workspaceRoot, {
      eventId: normalized.eventId,
      receivedAt: new Date().toISOString(),
      workspaceId,
      channelId: normalized.channelId,
      threadId: normalized.threadId
    });
  }

  return Response.json({
    workspaceId,
    workspacePath,
    agentResult,
    status
  });
}

function buildContext(workspacePath: string): SkillContext {
  return {
    workspacePath,
    llm: createNoopLlm("Slack status snapshot")
  };
}

function verifySlackSignature(request: Request, rawBody: string): void {
  const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim();

  if (!signingSecret) {
    throw new Error("SLACK_SIGNING_SECRET is required for the Slack handler.");
  }

  const timestamp = request.headers.get(SLACK_TIMESTAMP_HEADER)?.trim();
  const signature = request.headers.get(SLACK_SIGNATURE_HEADER)?.trim();

  if (!timestamp || !signature) {
    throw new Error("Missing Slack signature headers.");
  }

  const timestampNumber = Number(timestamp);

  if (!Number.isFinite(timestampNumber)) {
    throw new Error("Slack timestamp header is invalid.");
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampNumber);

  if (ageSeconds > SLACK_MAX_AGE_SECONDS) {
    throw new Error("Slack request timestamp is too old.");
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const digest = createHmac("sha256", signingSecret).update(base).digest("hex");
  const expectedSignature = `v0=${digest}`;

  if (!safeCompare(signature, expectedSignature)) {
    throw new Error("Slack request signature is invalid.");
  }
}

function extractSlackMessage(body: unknown): NormalizedSlackMessage | undefined {
  if (isCustomInboundMessage(body)) {
    return body;
  }

  if (!isSlackEventEnvelope(body)) {
    return undefined;
  }

  const event = body.event;

  if (!event || event.type !== "message" || event.bot_id || event.subtype) {
    return undefined;
  }

  if (
    typeof event.text !== "string" ||
    !event.text.trim() ||
    typeof event.channel !== "string" ||
    !event.channel.trim()
  ) {
    return undefined;
  }

  return {
    text: event.text.trim(),
    channelId: event.channel.trim(),
    eventId: typeof body.event_id === "string" && body.event_id.trim() ? body.event_id.trim() : undefined,
    threadId:
      typeof event.thread_ts === "string" && event.thread_ts.trim()
        ? event.thread_ts.trim()
        : typeof event.ts === "string" && event.ts.trim()
          ? event.ts.trim()
          : undefined
  };
}

function isCustomInboundMessage(value: unknown): value is CustomInboundMessage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.text === "string" &&
    typeof value.channelId === "string" &&
    (value.threadId === undefined || typeof value.threadId === "string") &&
    (value.statusOnly === undefined || typeof value.statusOnly === "boolean")
  );
}

function isSlackEventEnvelope(value: unknown): value is SlackEventEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "event_callback"
  );
}

function isSlackUrlVerification(value: unknown): value is SlackUrlVerification {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "url_verification" &&
    "challenge" in value &&
    typeof value.challenge === "string"
  );
}

function sanitizeWorkspaceId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
