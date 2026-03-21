import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { dispatchDevRequest } from "../runtime/dev-server.ts";
import { ensureWorkspace, writeSectionText } from "../skills/proposal-operator/shared.ts";

const sampleRfp = [
  "Acme Borough Council is seeking a delivery partner to design and deliver a proposal workflow assistant for internal bid teams.",
  "The solution must operate through Slack and should support thread-based workspaces for each tender response.",
  "Vendors must summarise pasted RFP text, extract mandatory and optional requirements, and plan a proposal structure covering executive summary, solution, delivery, team, security, and commercials."
].join(" ");

test("dev server routes serve UI and operator APIs", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-ui-"));

  const home = await dispatchDevRequest(
    {
      method: "GET",
      url: "/"
    },
    {
      workspaceRoot
    },
  );

  assert.equal(home.statusCode, 200);
  assert.match(home.body.toString(), /Proposal Helmsman/);

  const health = await dispatchJson(
    {
      method: "GET",
      url: "/api/health"
    },
    workspaceRoot,
  );

  assert.equal(health.ok, true);

  const created = await dispatchJson(
    {
      method: "POST",
      url: "/api/workspaces",
      body: {
        workspaceLabel: "audit-demo"
      }
    },
    workspaceRoot,
  );

  assert.match(created.workspaceId, /audit-demo/);

  const message = await dispatchJson(
    {
      method: "POST",
      url: "/api/message",
      body: {
        workspaceId: created.workspaceId,
        message: `/parse ${sampleRfp}`
      }
    },
    workspaceRoot,
  );

  assert.equal(message.agentResult.status, "ok");

  const draft = await dispatchJson(
    {
      method: "POST",
      url: "/api/message",
      body: {
        workspaceId: created.workspaceId,
        message: "/draft Executive Summary"
      }
    },
    workspaceRoot,
  );

  assert.equal(draft.agentResult.status, "ok");

  const exportResult = await dispatchJson(
    {
      method: "POST",
      url: "/api/message",
      body: {
        workspaceId: created.workspaceId,
        message: "/export"
      }
    },
    workspaceRoot,
  );

  assert.equal(exportResult.agentResult.status, "ok");

  const status = await dispatchJson(
    {
      method: "GET",
      url: `/api/status?workspaceId=${encodeURIComponent(created.workspaceId)}`
    },
    workspaceRoot,
  );

  assert.equal(status.workspace.hasRfp, true);
  assert.ok(Array.isArray(status.workspace.sections));
  assert.ok(
    status.workspace.requirements.some(
      (requirement: { evidence?: unknown[] }) => (requirement.evidence?.length ?? 0) > 0,
    ),
  );

  const download = await dispatchDevRequest(
    {
      method: "GET",
      url: `/api/proposal?workspaceId=${encodeURIComponent(created.workspaceId)}`
    },
    {
      workspaceRoot
    },
  );

  assert.equal(download.statusCode, 200);
  assert.equal(download.contentType, "text/markdown; charset=utf-8");
  assert.match(String(download.headers?.["content-disposition"]), /proposal\.md/);
  assert.match(download.body.toString(), /^# Proposal Draft/m);
});

test("dev server returns structured validation errors for bad operator requests", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-ui-"));
  const created = await dispatchJson(
    {
      method: "POST",
      url: "/api/workspaces",
      body: {
        workspaceLabel: "validation-demo"
      }
    },
    workspaceRoot,
  );

  const response = await dispatchDevRequest(
    {
      method: "POST",
      url: "/api/message",
      body: {
        workspaceId: created.workspaceId
      }
    },
    {
      workspaceRoot
    },
  );

  assert.equal(response.statusCode, 400);
  const payload = JSON.parse(response.body.toString());
  assert.equal(payload.code, "VALIDATION_ERROR");
  assert.match(payload.error, /message/i);
});

test("dev server preserves guardrail modification metadata on successful revisions", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-ui-"));
  const created = await dispatchJson(
    {
      method: "POST",
      url: "/api/workspaces",
      body: {
        workspaceLabel: "guardrail-demo"
      }
    },
    workspaceRoot,
  );

  await dispatchJson(
    {
      method: "POST",
      url: "/api/message",
      body: {
        workspaceId: created.workspaceId,
        message:
          "/parse The system must protect sensitive client and project information, and it shall not invent fixed pricing, legal guarantees, or unapproved commercial terms."
      }
    },
    workspaceRoot,
  );

  await dispatchJson(
    {
      method: "POST",
      url: "/api/message",
      body: {
        workspaceId: created.workspaceId,
        message: "/draft Executive Summary"
      }
    },
    workspaceRoot,
  );

  const revised = await dispatchJson(
    {
      method: "POST",
      url: "/api/message",
      body: {
        workspaceId: created.workspaceId,
        message:
          "/revise Executive Summary::Revise this so we accept unlimited liability and guarantee 100% uptime."
      }
    },
    workspaceRoot,
  );

  assert.equal(revised.agentResult.status, "ok");
  assert.equal(revised.agentResult.action, "revise_section");
  assert.equal(revised.agentResult.guardrail?.modified, true);
  assert.ok(Array.isArray(revised.agentResult.guardrail?.stages));
  assert.ok(revised.agentResult.guardrail.stages.includes("input"));
  assert.match(String(revised.agentResult.message), /guardrails adjusted risky wording/i);
});

test("dev server surfaces export guardrail metadata for sanitized proposal output", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-ui-"));
  const workspaceId = "export-guardrail-demo";
  const workspacePath = path.join(workspaceRoot, workspaceId);

  await ensureWorkspace(workspacePath);
  await writeSectionText(
    workspacePath,
    "Executive Summary",
    "We accept unlimited liability and guarantee 100% uptime.",
  );

  const exported = await dispatchJson(
    {
      method: "POST",
      url: "/api/message",
      body: {
        workspaceId,
        message: "/export"
      }
    },
    workspaceRoot,
  );

  assert.equal(exported.agentResult.status, "ok");
  assert.equal(exported.agentResult.action, "export_proposal");
  assert.equal(exported.agentResult.guardrail?.modified, true);
  assert.ok(Array.isArray(exported.agentResult.guardrail?.stages));
  assert.ok(exported.agentResult.guardrail.stages.includes("output"));
  assert.match(String(exported.agentResult.message), /guardrails adjusted risky wording/i);
});

test("dev server rejects malformed JSON bodies with 400", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-ui-"));
  const response = await dispatchDevRequest(
    {
      method: "POST",
      url: "/api/message",
      body: "{bad json"
    },
    {
      workspaceRoot
    },
  );

  assert.equal(response.statusCode, 400);
  const payload = JSON.parse(response.body.toString());
  assert.equal(payload.code, "VALIDATION_ERROR");
  assert.match(String(payload.error), /valid json/i);
});

test("dev server follows shared storage env resolution for health and workspace writes", async () => {
  const modalRoot = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-modal-"));
  const previousStorageMode = process.env.PROPOSAL_STORAGE_MODE;
  const previousModalPath = process.env.MODAL_VOLUME_PATH;
  const previousWorkspaceRoot = process.env.PROPOSAL_WORKSPACE_ROOT;

  try {
    process.env.PROPOSAL_STORAGE_MODE = "modal";
    process.env.MODAL_VOLUME_PATH = modalRoot;
    delete process.env.PROPOSAL_WORKSPACE_ROOT;

    const health = await dispatchJson(
      {
        method: "GET",
        url: "/api/health"
      },
      undefined,
    );

    assert.equal(health.storage.mode, "modal");
    assert.equal(health.storage.durable, true);
    assert.equal(
      health.storage.workspaceRoot,
      path.join(modalRoot, "workspaces", "proposals"),
    );

    const created = await dispatchJson(
      {
        method: "POST",
        url: "/api/workspaces",
        body: {
          workspaceLabel: "modal-demo"
        }
      },
      undefined,
    );

    assert.match(String(created.workspace.workspaceId), /modal-demo/);
  } finally {
    restoreEnv("PROPOSAL_STORAGE_MODE", previousStorageMode);
    restoreEnv("MODAL_VOLUME_PATH", previousModalPath);
    restoreEnv("PROPOSAL_WORKSPACE_ROOT", previousWorkspaceRoot);
    await rm(modalRoot, { recursive: true, force: true });
  }
});

async function dispatchJson(
  request: Parameters<typeof dispatchDevRequest>[0],
  workspaceRoot?: string,
): Promise<any> {
  const response = await dispatchDevRequest(request, {
    workspaceRoot
  });

  assert.ok(response.statusCode >= 200 && response.statusCode < 300);
  return JSON.parse(response.body.toString());
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
