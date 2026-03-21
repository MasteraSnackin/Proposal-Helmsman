import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GET as audioGet, POST as audioPost } from "../../api/audio.ts";
import { GET as healthGet } from "../../api/health.ts";
import { POST as messagePost } from "../../api/message.ts";
import { GET as proposalGet } from "../../api/proposal.ts";
import { GET as sampleRfpGet } from "../../api/sample-rfp.ts";
import { GET as statusGet } from "../../api/status.ts";
import { POST as workspacesPost } from "../../api/workspaces.ts";

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

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}
