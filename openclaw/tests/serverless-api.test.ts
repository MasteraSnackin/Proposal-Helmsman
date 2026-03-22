import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GET as audioGet, OPTIONS as audioOptions, POST as audioPost } from "../../api/audio.ts";
import healthHandler, { GET as healthGet, OPTIONS as healthOptions } from "../../api/health.ts";
import { POST as messagePost } from "../../api/message.ts";
import { GET as proposalGet } from "../../api/proposal.ts";
import { OPTIONS as resetOptions, POST as resetPost } from "../../api/reset.ts";
import { GET as sampleRfpGet } from "../../api/sample-rfp.ts";
import { OPTIONS as slackOptions, POST as slackPost } from "../../api/slack.ts";
import { GET as statusGet } from "../../api/status.ts";
import { OPTIONS as workspacesOptions, POST as workspacesPost } from "../../api/workspaces.ts";

test("serverless api endpoints drive a full proposal flow", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-api-"));
  process.env.PROPOSAL_WORKSPACE_ROOT = workspaceRoot;
  const previousAudioMockMode = process.env.ELEVENLABS_MOCK_MODE;
  process.env.ELEVENLABS_MOCK_MODE = "true";

  try {
    const health = await healthGet(new Request("https://example.com/api/health"));
    assert.equal(health.status, 200);
    const healthPayload = await health.json();
    assert.equal(healthPayload.storage.mode, "local");
    assert.equal(healthPayload.storage.durable, false);
    assert.equal(healthPayload.storage.workspaceRoot, workspaceRoot);
    assert.equal(healthPayload.audio.provider, "elevenlabs");
    assert.equal(healthPayload.audio.mode, "mock");

    const sample = await sampleRfpGet(new Request("https://example.com/api/sample-rfp"));
    assert.equal(sample.status, 200);
    const samplePayload = await sample.json();
    assert.match(String(samplePayload.rfpText), /proposal/i);

    const created = await workspacesPost(
      jsonRequest("https://example.com/api/workspaces", {
        workspaceLabel: "serverless-demo"
      }),
    );
    assert.equal(created.status, 201);
    const createdPayload = await created.json();
    assert.match(String(createdPayload.workspaceId), /serverless-demo/);

    const workspaceId = String(createdPayload.workspaceId);

    const parsed = await messagePost(
      jsonRequest("https://example.com/api/message", {
        workspaceId,
        message:
          "/parse The solution must operate through Slack, extract requirements, and export proposal drafts safely."
      }),
    );
    assert.equal(parsed.status, 200);

    const drafted = await messagePost(
      jsonRequest("https://example.com/api/message", {
        workspaceId,
        message: "/draft Executive Summary"
      }),
    );
    assert.equal(drafted.status, 200);

    const covered = await messagePost(
      jsonRequest("https://example.com/api/message", {
        workspaceId,
        message: "/coverage"
      }),
    );
    assert.equal(covered.status, 200);

    const exported = await messagePost(
      jsonRequest("https://example.com/api/message", {
        workspaceId,
        message: "/export"
      }),
    );
    assert.equal(exported.status, 200);

    const audioGenerated = await audioPost(
      jsonRequest("https://example.com/api/audio", {
        workspaceId,
        source: "summary"
      }),
    );
    assert.equal(audioGenerated.status, 200);
    const audioPayload = await audioGenerated.json();
    assert.equal(audioPayload.result.status, "ok");
    assert.ok(Array.isArray(audioPayload.workspace.audioArtifacts));
    assert.equal(audioPayload.workspace.audioArtifacts.length > 0, true);

    const status = await statusGet(
      new Request(`https://example.com/api/status?workspaceId=${encodeURIComponent(workspaceId)}`),
    );
    assert.equal(status.status, 200);
    const statusPayload = await status.json();
    assert.ok(
      statusPayload.workspace.requirements.some(
        (requirement: { evidence?: unknown[] }) =>
          Array.isArray(requirement.evidence) && requirement.evidence.length > 0,
      ),
    );

    const proposal = await proposalGet(
      new Request(`https://example.com/api/proposal?workspaceId=${encodeURIComponent(workspaceId)}`),
    );
    assert.equal(proposal.status, 200);
    assert.equal(
      proposal.headers.get("content-type"),
      "text/markdown; charset=utf-8",
    );
    assert.match(await proposal.text(), /^# Proposal Draft/m);

    const audio = await audioGet(
      new Request(`https://example.com/api/audio?workspaceId=${encodeURIComponent(workspaceId)}`),
    );
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/wav");
    assert.ok((await audio.arrayBuffer()).byteLength > 0);

    const reset = await resetPost(
      jsonRequest("https://example.com/api/reset", {
        workspaceId
      }),
    );
    assert.equal(reset.status, 200);
    const resetPayload = await reset.json();
    assert.equal(resetPayload.status, "ok");
    assert.equal(resetPayload.workspace.workspaceId, workspaceId);
    assert.equal(resetPayload.workspace.hasRfp, false);
    assert.equal(resetPayload.workspace.proposalExists, false);
  } finally {
    delete process.env.PROPOSAL_WORKSPACE_ROOT;
    if (previousAudioMockMode === undefined) {
      delete process.env.ELEVENLABS_MOCK_MODE;
    } else {
      process.env.ELEVENLABS_MOCK_MODE = previousAudioMockMode;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("serverless api wrappers expose preflight and structured method handling", async () => {
  const healthPreflight = await healthOptions(
    new Request("https://example.com/api/health", {
      method: "OPTIONS"
    }),
  );
  assert.equal(healthPreflight.status, 204);
  assert.equal(healthPreflight.headers.get("allow"), "GET, OPTIONS");

  const workspacePreflight = await workspacesOptions(
    new Request("https://example.com/api/workspaces", {
      method: "OPTIONS"
    }),
  );
  assert.equal(workspacePreflight.status, 204);
  assert.equal(workspacePreflight.headers.get("allow"), "GET, POST, OPTIONS");

  const audioPreflight = await audioOptions(
    new Request("https://example.com/api/audio", {
      method: "OPTIONS"
    }),
  );
  assert.equal(audioPreflight.status, 204);
  assert.equal(audioPreflight.headers.get("allow"), "GET, POST, OPTIONS");

  const resetPreflight = await resetOptions(
    new Request("https://example.com/api/reset", {
      method: "OPTIONS"
    }),
  );
  assert.equal(resetPreflight.status, 204);
  assert.equal(resetPreflight.headers.get("allow"), "POST, OPTIONS");

  const patchResponse = await healthHandler(
    new Request("https://example.com/api/health", {
      method: "PATCH"
    }),
  );
  assert.equal(patchResponse.status, 405);
  assert.equal(patchResponse.headers.get("allow"), "GET, OPTIONS");
  const patchPayload = await patchResponse.json();
  assert.equal(patchPayload.code, "METHOD_NOT_ALLOWED");
  assert.equal(patchPayload.details.path, "/api/health");
  assert.deepEqual(patchPayload.details.allowedMethods, ["GET"]);
});

test("serverless slack endpoint handles signed verification and preflight", async () => {
  const previousSigningSecret = process.env.SLACK_SIGNING_SECRET;

  try {
    const preflight = await slackOptions(
      new Request("https://example.com/api/slack", {
        method: "OPTIONS"
      }),
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("allow"), "POST, OPTIONS");

    const response = await slackPost(
      signedSlackRequest({
        type: "url_verification",
        challenge: "serverless-challenge"
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "serverless-challenge");
  } finally {
    restoreEnv("SLACK_SIGNING_SECRET", previousSigningSecret);
  }
});

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function signedSlackRequest(payload: Record<string, unknown>): Request {
  process.env.SLACK_SIGNING_SECRET = "test-signing-secret";

  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;

  return new Request("https://example.com/api/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature
    },
    body: rawBody
  });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
