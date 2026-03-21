import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { POST } from "../examples/slack-handler.ts";

test("Slack handler accepts valid signed url verification", async () => {
  const request = signedRequest({
    type: "url_verification",
    challenge: "abc123"
  });

  const response = await POST(request);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "abc123");
});

test("Slack handler rejects invalid signatures", async () => {
  const body = JSON.stringify({
    text: "hello",
    channelId: "C123"
  });

  const response = await POST(
    new Request("https://example.com/slack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=invalid"
      },
      body
    }),
  );

  assert.equal(response.status, 401);
  assert.match(await response.text(), /invalid/i);
});

test("Slack handler processes signed message events and ignores bot loops", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-slack-"));
  process.env.PROPOSAL_WORKSPACE_ROOT = workspaceRoot;

  try {
    const messageResponse = await POST(
      signedRequest({
        type: "event_callback",
        event_id: "evt-primary-1",
        event: {
          type: "message",
          text: "/parse The solution must operate through Slack and plan proposal sections.",
          channel: "C456",
          ts: "1710000000.000100"
        }
      }),
    );

    assert.equal(messageResponse.status, 200);
    const messagePayload = (await messageResponse.json()) as Record<string, unknown>;
    assert.equal(messagePayload.workspaceId, "C456_1710000000_000100");

    const workspacePath = path.join(workspaceRoot, "C456_1710000000_000100");
    const rfp = await readFile(path.join(workspacePath, "rfp.json"), "utf8");
    assert.match(rfp, /Slack/);

    const botResponse = await POST(
      signedRequest({
        type: "event_callback",
        event_id: "evt-bot-1",
        event: {
          type: "message",
          text: "ignore me",
          channel: "C456",
          ts: "1710000000.000101",
          bot_id: "B999"
        }
      }),
    );

    assert.equal(botResponse.status, 200);
    assert.match(await botResponse.text(), /ignored/i);
  } finally {
    delete process.env.PROPOSAL_WORKSPACE_ROOT;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Slack handler ignores duplicate signed event callbacks", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-slack-"));
  process.env.PROPOSAL_WORKSPACE_ROOT = workspaceRoot;

  try {
    const payload = {
      type: "event_callback",
      event_id: "evt-duplicate-1",
      event: {
        type: "message",
        text: "/parse Slack retries should not create duplicate proposal work.",
        channel: "C789",
        ts: "1710000000.000200"
      }
    };

    const firstResponse = await POST(signedRequest(payload));
    assert.equal(firstResponse.status, 200);

    const secondResponse = await POST(signedRequest(payload));
    assert.equal(secondResponse.status, 200);
    assert.match(await secondResponse.text(), /duplicate/i);
  } finally {
    delete process.env.PROPOSAL_WORKSPACE_ROOT;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function signedRequest(payload: Record<string, unknown>): Request {
  process.env.SLACK_SIGNING_SECRET = "test-signing-secret";

  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;

  return new Request("https://example.com/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature
    },
    body: rawBody
  });
}
