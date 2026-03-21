import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDemoLlm } from "../runtime/demo-llm.ts";
import { invokeProposalOperator } from "../runtime/proposal-operator.ts";
import updateChecklistCoverage from "../skills/proposal-operator/update_checklist_coverage.ts";
import {
  ensureWorkspace,
  writeRfpDocument,
  writeSectionText
} from "../skills/proposal-operator/shared.ts";

const sampleRfp = [
  "Acme Borough Council is seeking a delivery partner to design and deliver a proposal workflow assistant for internal bid teams.",
  "The solution must operate through Slack and should support thread-based workspaces for each tender response.",
  "Vendors must summarise pasted RFP text, extract mandatory and optional requirements, and plan a proposal structure covering executive summary, solution, delivery, team, security, and commercials.",
  "The system must protect sensitive client and project information, and it shall not invent fixed pricing, legal guarantees, or unapproved commercial terms."
].join(" ");

test("proposal operator ingests an RFP and exports a proposal", async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-"));
  const llm = createDemoLlm();

  const ingest = await invokeProposalOperator({
    message: sampleRfp,
    workspacePath,
    llm
  });

  assert.equal(ingest.status, "ok");
  assert.equal(ingest.action, "ingest_rfp");

  const draft = await invokeProposalOperator({
    message: "/draft Executive Summary",
    workspacePath,
    llm
  });

  assert.equal(draft.status, "ok");
  assert.equal(draft.action, "draft_section");

  const rfpDocument = JSON.parse(
    await readFile(path.join(workspacePath, "rfp.json"), "utf8"),
  ) as {
    requirements: Array<{
      covered: boolean;
      evidence?: Array<{
        file: string;
        matched_keywords: string[];
      }>;
    }>;
  };
  const evidencedRequirement = rfpDocument.requirements.find(
    (requirement) =>
      requirement.covered &&
      Array.isArray(requirement.evidence) &&
      requirement.evidence.length > 0,
  );

  assert.ok(evidencedRequirement);
  assert.ok(evidencedRequirement.evidence?.length);
  assert.match(evidencedRequirement.evidence![0].file, /^sections\/.+\.md$/);
  assert.ok(evidencedRequirement.evidence![0].matched_keywords.length > 0);

  const exportResult = await invokeProposalOperator({
    message: "/export",
    workspacePath,
    llm
  });

  assert.equal(exportResult.status, "ok");
  assert.equal(exportResult.action, "export_proposal");

  const proposal = await readFile(path.join(workspacePath, "proposal.md"), "utf8");
  assert.match(proposal, /^# Proposal Draft/m);
  assert.match(proposal, /^## Executive Summary/m);
});

test("guardrails block sensitive revisions and rewrite risky commitments", async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-"));
  const llm = createDemoLlm();

  await invokeProposalOperator({
    message: sampleRfp,
    workspacePath,
    llm
  });

  await invokeProposalOperator({
    message: "/draft Executive Summary",
    workspacePath,
    llm
  });

  const blocked = await invokeProposalOperator({
    message:
      "/revise Executive Summary::Add a full client list and disclose confidential internal project details.",
    workspacePath,
    llm
  });

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.action, "input_guard");

  const modified = await invokeProposalOperator({
    message:
      "/revise Executive Summary::Revise this so we accept unlimited liability and guarantee 100% uptime.",
    workspacePath,
    llm
  });

  assert.equal(modified.status, "ok");
  assert.equal(modified.action, "revise_section");
  assert.equal(modified.guardrail?.modified, true);
  assert.ok(modified.guardrail?.stages.includes("input"));
  assert.match(String(modified.message), /guardrails adjusted risky wording/i);
  assert.equal(modified.guardrail?.modified, true);
  assert.ok(modified.guardrail?.stages.includes("input"));
  assert.ok(
    modified.guardrail?.reasons.some((reason) => /unlimited liability|uptime/i.test(reason)),
  );
  assert.match(modified.message, /guardrails adjusted risky wording/i);

  const revised = await readFile(
    path.join(workspacePath, "sections", "executive_summary.md"),
    "utf8",
  );
  assert.doesNotMatch(revised, /unlimited liability/i);
  assert.doesNotMatch(revised, /100% uptime/i);
});

test("export surfaces guardrail metadata when risky saved content is sanitized", async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-"));

  await ensureWorkspace(workspacePath);
  await writeSectionText(
    workspacePath,
    "Executive Summary",
    "We accept unlimited liability and guarantee 100% uptime.",
  );

  const exported = await invokeProposalOperator({
    message: "/export",
    workspacePath
  });

  assert.equal(exported.status, "ok");
  assert.equal(exported.action, "export_proposal");
  assert.equal(exported.guardrail?.modified, true);
  assert.ok(exported.guardrail?.stages.includes("output"));
  assert.match(String(exported.message), /guardrails adjusted risky wording/i);

  const proposal = await readFile(path.join(workspacePath, "proposal.md"), "utf8");
  assert.doesNotMatch(proposal, /unlimited liability/i);
  assert.doesNotMatch(proposal, /100% uptime/i);
});

test("RFP intake preserves risky source clauses for analysis", async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-"));
  const llm = createDemoLlm();
  const rfpWithClause =
    "The supplier must review a contract draft that includes unlimited liability and fixed pricing terms for discussion.";

  const result = await invokeProposalOperator({
    message: `/parse ${rfpWithClause}`,
    workspacePath,
    llm
  });

  assert.equal(result.status, "ok");
  assert.equal(result.action, "parse_rfp");

  const status = await invokeProposalOperator({
    message: "/status",
    workspacePath,
    llm
  });

  assert.equal(status.status, "ok");
  assert.match(JSON.stringify(status), /unlimited liability/i);
});

test("coverage update catches paraphrased requirement matches without over-covering", async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-"));
  const llm = createDemoLlm();

  await ensureWorkspace(workspacePath);
  await writeRfpDocument(workspacePath, {
    summary: "Test summary",
    requirements: [
      {
        id: "coverage_1",
        text: "Summarise pasted RFP text, extract mandatory and optional requirements, and plan proposal structure.",
        must_have: true,
        covered: false,
        evidence: []
      },
      {
        id: "coverage_2",
        text: "Provide ISO 27001 certification evidence.",
        must_have: false,
        covered: false,
        evidence: []
      }
    ]
  });
  await writeSectionText(
    workspacePath,
    "Understanding of Requirements",
    [
      "We turn pasted tender text into a concise summary, identify required and optional criteria, and outline the response sections for the bid team.",
      "Named references are not included in the draft unless they have been explicitly approved."
    ].join("\n\n"),
  );

  const result = await updateChecklistCoverage({}, { workspacePath, llm });
  assert.equal(result.status, "ok");
  assert.equal(result.mustHaveCovered, 1);

  const updatedRfp = JSON.parse(
    await readFile(path.join(workspacePath, "rfp.json"), "utf8"),
  ) as {
    requirements: Array<{
      id: string;
      covered: boolean;
      evidence?: Array<{ matched_keywords: string[] }>;
    }>;
  };

  const paraphrasedRequirement = updatedRfp.requirements.find(
    (requirement) => requirement.id === "coverage_1",
  );
  const unrelatedRequirement = updatedRfp.requirements.find(
    (requirement) => requirement.id === "coverage_2",
  );

  assert.ok(paraphrasedRequirement);
  assert.equal(paraphrasedRequirement.covered, true);
  assert.ok(paraphrasedRequirement.evidence?.length);
  assert.ok(
    paraphrasedRequirement.evidence?.[0].matched_keywords.some((keyword) =>
      ["summarise", "requirements", "structure"].includes(keyword),
    ),
  );

  assert.ok(unrelatedRequirement);
  assert.equal(unrelatedRequirement.covered, false);
});

test("proposal operator generates mock audio briefings", async () => {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-"));
  const llm = createDemoLlm();
  const previousMockMode = process.env.ELEVENLABS_MOCK_MODE;

  try {
    process.env.ELEVENLABS_MOCK_MODE = "true";

    await invokeProposalOperator({
      message: sampleRfp,
      workspacePath,
      llm
    });

    const audio = await invokeProposalOperator({
      message: "/audio summary",
      workspacePath,
      llm
    });

    assert.equal(audio.status, "ok");
    assert.equal(audio.action, "generate_audio_briefing");
    assert.match(JSON.stringify(audio.result), /briefing-summary\.wav/);

    const metadata = JSON.parse(
      await readFile(path.join(workspacePath, "audio", "briefing-summary.json"), "utf8"),
    ) as {
      contentType: string;
      source: string;
      provider: string;
    };
    assert.equal(metadata.contentType, "audio/wav");
    assert.equal(metadata.source, "summary");
    assert.equal(metadata.provider, "mock");
  } finally {
    if (previousMockMode === undefined) {
      delete process.env.ELEVENLABS_MOCK_MODE;
    } else {
      process.env.ELEVENLABS_MOCK_MODE = previousMockMode;
    }
  }
});
