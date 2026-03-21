import { guardInput } from "../guardrails/civic.ts";
import { ValidationError } from "./errors.ts";
import type { SkillContext, LlmClient } from "./types.ts";
import { createConfiguredLlm } from "./model-client.ts";
import draftSection from "../skills/proposal-operator/draft_section.ts";
import exportProposal from "../skills/proposal-operator/export_proposal.ts";
import generateAudioBriefing from "../skills/proposal-operator/generate_audio_briefing.ts";
import parseRfp from "../skills/proposal-operator/parse_rfp.ts";
import planProposalStructure from "../skills/proposal-operator/plan_proposal_structure.ts";
import reviseSection from "../skills/proposal-operator/revise_section.ts";
import updateChecklistCoverage from "../skills/proposal-operator/update_checklist_coverage.ts";
import workspaceStatus from "../skills/proposal-operator/workspace_status.ts";
import {
  ensureWorkspace,
  readRfpDocument,
  workspaceIdFromPath,
  type ProposalSection
} from "../skills/proposal-operator/shared.ts";

export type ProposalOperatorInvocation = {
  message: string;
  workspacePath: string;
  llm?: LlmClient;
};

export type ProposalOperatorGuardrailSummary = {
  modified: true;
  stages: Array<"input" | "tool" | "output">;
  reasons: string[];
};

export type ProposalOperatorResult =
  | {
      status: "ok";
      action: string;
      message: string;
      workspacePath: string;
      result?: unknown;
      milestones?: string[];
      statusSnapshot?: unknown;
      guardrail?: ProposalOperatorGuardrailSummary;
    }
  | {
      status: "blocked";
      action: string;
      message: string;
      reason: string[];
      workspacePath: string;
    };

export async function invokeProposalOperator(
  invocation: ProposalOperatorInvocation,
): Promise<ProposalOperatorResult> {
  const context = await buildContext(invocation.workspacePath, invocation.llm);
  const existingRfp = await readRfpDocument(invocation.workspacePath);
  const shouldBypassInputGuard = shouldTreatAsRfpIngestion(
    invocation.message,
    Boolean(existingRfp),
  );
  const inputDecision = shouldBypassInputGuard
    ? { decision: "allow" as const }
    : await guardInput(invocation.message, {
        agent: "proposal-operator",
        workspaceId: workspaceIdFromPath(invocation.workspacePath)
      });

  if (inputDecision.decision === "block") {
    return {
      status: "blocked",
      action: "input_guard",
      message: "Message blocked by Civic input guardrails.",
      reason: inputDecision.reasons ?? ["Input blocked by guardrails."],
      workspacePath: invocation.workspacePath
    };
  }

  const inputGuardrail = toGuardrailSummary(inputDecision, "input");
  const message =
    inputDecision.decision === "modify" && inputDecision.modifiedText
      ? inputDecision.modifiedText
      : invocation.message;
  const trimmed = message.trim();

  if (!trimmed) {
    return {
      status: "ok",
      action: "noop",
      message: "No message content was provided.",
      workspacePath: invocation.workspacePath
    };
  }

  const explicit = await handleExplicitCommand(trimmed, context);

  if (explicit) {
    return withGuardrailSummary(explicit, inputGuardrail);
  }

  if (!existingRfp) {
    const parseResult = await parseRfp({ rfpText: trimmed }, context);
    const structureResult = await planProposalStructure({}, context);
    const statusSnapshot = await workspaceStatus({}, context);

    return withGuardrailSummary({
      status: "ok",
      action: "ingest_rfp",
      message: "RFP parsed and proposal structure planned.",
      workspacePath: invocation.workspacePath,
      result: {
        parseResult,
        structureResult
      },
      milestones: ["RFP analysed", "Requirements extracted", "Structure planned"],
      statusSnapshot
    }, inputGuardrail);
  }

  const sectionRequest = detectSectionDraftRequest(trimmed);

  if (sectionRequest) {
    const result = await draftSection({ sectionName: sectionRequest }, context);

    if (isBlockedResult(result)) {
      return blockedResult(
        "draft_section",
        invocation.workspacePath,
        `${sectionRequest} draft was blocked.`,
        result.reason,
      );
    }

    const coverage = await updateChecklistCoverage({}, context);
    return withGuardrailSummary({
      status: "ok",
      action: "draft_section",
      message: `${sectionRequest} drafted.`,
      workspacePath: invocation.workspacePath,
      result,
      ...(extractGuardrailSummaryFromSkillResult(result)
        ? { guardrail: extractGuardrailSummaryFromSkillResult(result) }
        : {}),
      milestones: [`${sectionRequest} drafted`, "Requirement coverage updated"],
      statusSnapshot: {
        coverage,
        workspace: await workspaceStatus({}, context)
      }
    }, inputGuardrail);
  }

  if (/^export\b/i.test(trimmed)) {
    const result = await exportProposal({}, context);

    if (isBlockedResult(result)) {
      return blockedResult(
        "export_proposal",
        invocation.workspacePath,
        "Proposal export was blocked.",
        result.reason,
      );
    }

    return withGuardrailSummary({
      status: "ok",
      action: "export_proposal",
      message: "Proposal draft exported.",
      workspacePath: invocation.workspacePath,
      result,
      ...(extractGuardrailSummaryFromSkillResult(result)
        ? { guardrail: extractGuardrailSummaryFromSkillResult(result) }
        : {})
    }, inputGuardrail);
  }

  const statusSnapshot = await workspaceStatus({}, context);

  return withGuardrailSummary({
    status: "ok",
    action: "status",
    message:
      "Message received. Use /draft <section>, /revise <section>::<instruction>, /coverage, /export, /audio, or /status.",
    workspacePath: invocation.workspacePath,
    statusSnapshot
  }, inputGuardrail);
}

async function buildContext(
  workspacePath: string,
  llm?: LlmClient,
): Promise<SkillContext> {
  await ensureWorkspace(workspacePath);

  return {
    workspacePath,
    llm: llm ?? createConfiguredLlm()
  };
}

async function handleExplicitCommand(
  message: string,
  context: SkillContext,
): Promise<ProposalOperatorResult | undefined> {
  if (message.startsWith("/parse ")) {
    const parseResult = await parseRfp({ rfpText: message.slice("/parse ".length) }, context);
    const structureResult = await planProposalStructure({}, context);
    return withGuardrailSummary({
      status: "ok",
      action: "parse_rfp",
      message: "RFP parsed and structure planned.",
      workspacePath: context.workspacePath,
      result: {
        parseResult,
        structureResult
      },
      statusSnapshot: await workspaceStatus({}, context)
    });
  }

  if (message.startsWith("/parse-file ")) {
    const parseResult = await parseRfp(
      { rfpFile: message.slice("/parse-file ".length).trim() },
      context,
    );
    const structureResult = await planProposalStructure({}, context);
    return withGuardrailSummary({
      status: "ok",
      action: "parse_rfp",
      message: "RFP file parsed and structure planned.",
      workspacePath: context.workspacePath,
      result: {
        parseResult,
        structureResult
      },
      statusSnapshot: await workspaceStatus({}, context)
    });
  }

  if (message === "/plan") {
    const result = await planProposalStructure({}, context);
    return withGuardrailSummary({
      status: "ok",
      action: "plan_proposal_structure",
      message: "Proposal structure planned.",
      workspacePath: context.workspacePath,
      result
    });
  }

  if (message.startsWith("/draft ")) {
    const payload = message.slice("/draft ".length);
    const [sectionName, emphasis] = payload.split("::");
    const result = await draftSection(
      {
        sectionName: sectionName.trim(),
        emphasis: emphasis?.trim()
      },
      context,
    );

    if (isBlockedResult(result)) {
      return blockedResult(
        "draft_section",
        context.workspacePath,
        `${sectionName.trim()} draft was blocked.`,
        result.reason,
      );
    }

    return withGuardrailSummary({
      status: "ok",
      action: "draft_section",
      message: `${sectionName.trim()} drafted.`,
      workspacePath: context.workspacePath,
      result,
      ...(extractGuardrailSummaryFromSkillResult(result)
        ? { guardrail: extractGuardrailSummaryFromSkillResult(result) }
        : {}),
      statusSnapshot: {
        coverage: await updateChecklistCoverage({}, context),
        workspace: await workspaceStatus({}, context)
      }
    });
  }

  if (message.startsWith("/revise ")) {
    const payload = message.slice("/revise ".length);
    const [sectionName, instruction] = payload.split("::");

    if (!sectionName || !instruction) {
      throw new ValidationError("Use /revise <section name>::<instruction>");
    }

    const result = await reviseSection(
      {
        sectionName: sectionName.trim(),
        instruction: instruction.trim()
      },
      context,
    );

    if (isBlockedResult(result)) {
      return blockedResult(
        "revise_section",
        context.workspacePath,
        `${sectionName.trim()} revision was blocked.`,
        result.reason,
      );
    }

    return withGuardrailSummary({
      status: "ok",
      action: "revise_section",
      message: `${sectionName.trim()} revised.`,
      workspacePath: context.workspacePath,
      result,
      ...(extractGuardrailSummaryFromSkillResult(result)
        ? { guardrail: extractGuardrailSummaryFromSkillResult(result) }
        : {}),
      statusSnapshot: {
        coverage: await updateChecklistCoverage({}, context),
        workspace: await workspaceStatus({}, context)
      }
    });
  }

  if (message === "/coverage") {
    const result = await updateChecklistCoverage({}, context);
    return withGuardrailSummary({
      status: "ok",
      action: "update_checklist_coverage",
      message: "Requirement coverage updated.",
      workspacePath: context.workspacePath,
      result
    });
  }

  if (message === "/export") {
    const result = await exportProposal({}, context);

    if (isBlockedResult(result)) {
      return blockedResult(
        "export_proposal",
        context.workspacePath,
        "Proposal export was blocked.",
        result.reason,
      );
    }

    return withGuardrailSummary({
      status: "ok",
      action: "export_proposal",
      message: "Proposal exported.",
      workspacePath: context.workspacePath,
      result,
      ...(extractGuardrailSummaryFromSkillResult(result)
        ? { guardrail: extractGuardrailSummaryFromSkillResult(result) }
        : {})
    });
  }

  if (message === "/audio" || message.startsWith("/audio ")) {
    const payload = parseAudioCommand(message);
    const result = await generateAudioBriefing(payload, context);

    if (isBlockedResult(result)) {
      return blockedResult(
        "generate_audio_briefing",
        context.workspacePath,
        "Audio briefing was blocked.",
        result.reason,
      );
    }

    return withGuardrailSummary({
      status: "ok",
      action: "generate_audio_briefing",
      message:
        payload.source === "section" && payload.sectionName
          ? `${payload.sectionName} audio briefing generated.`
          : `${payload.source ?? "summary"} audio briefing generated.`,
      workspacePath: context.workspacePath,
      result,
      statusSnapshot: await workspaceStatus({}, context)
    });
  }

  if (message === "/status") {
    const result = await workspaceStatus({}, context);
    return {
      status: "ok",
      action: "workspace_status",
      message: "Workspace status returned.",
      workspacePath: context.workspacePath,
      result
    };
  }

  if (message === "/help") {
    return {
      status: "ok",
      action: "help",
      message:
        "Available commands: /parse <rfp text>, /parse-file <file>, /plan, /draft <section>::<optional emphasis>, /revise <section>::<instruction>, /coverage, /export, /audio [summary|proposal|<section>|section::<section>], /status.",
      workspacePath: context.workspacePath
    };
  }

  return undefined;
}

function detectSectionDraftRequest(message: string): string | undefined {
  const match = message.match(
    /(?:^|\b)(?:draft|write|create)\s+(?:the\s+)?([a-z][a-z\s&/-]+?)(?:\s+section)?$/i,
  );

  if (!match?.[1]) {
    return undefined;
  }

  return toTitleCase(match[1].trim());
}

function parseAudioCommand(
  message: string,
): {
  source?: "summary" | "proposal" | "section";
  sectionName?: string;
} {
  const payload = message.slice("/audio".length).trim();

  if (!payload || payload.toLowerCase() === "summary") {
    return {
      source: "summary"
    };
  }

  if (payload.toLowerCase() === "proposal") {
    return {
      source: "proposal"
    };
  }

  if (payload.toLowerCase().startsWith("section::")) {
    const sectionName = payload.slice("section::".length).trim();

    if (!sectionName) {
      throw new ValidationError("Use /audio section::<section name>.");
    }

    return {
      source: "section",
      sectionName
    };
  }

  return {
    source: "section",
    sectionName: payload
  };
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function summarizePlannedSections(
  sections: ProposalSection[],
): string[] {
  return sections
    .sort((left, right) => left.order - right.order)
    .map((section) => `${section.order}. ${section.name}`);
}

function isBlockedResult(
  value: unknown,
): value is {
  status: "blocked";
  reason: string[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "blocked" &&
    "reason" in value &&
    Array.isArray(value.reason)
  );
}

function blockedResult(
  action: string,
  workspacePath: string,
  message: string,
  reason: string[],
): ProposalOperatorResult {
  return {
    status: "blocked",
    action,
    message,
    reason,
    workspacePath
  };
}

function withGuardrailSummary(
  result: ProposalOperatorResult,
  summary?: ProposalOperatorGuardrailSummary,
): ProposalOperatorResult {
  if (result.status !== "ok") {
    return result;
  }

  const merged = mergeGuardrailSummaries(result.guardrail, summary);

  if (!merged) {
    return result;
  }

  return {
    ...result,
    message: /guardrails adjusted risky wording/i.test(result.message)
      ? result.message
      : `${result.message} Guardrails adjusted risky wording.`,
    guardrail: merged
  };
}

function toGuardrailSummary(
  decision: { decision: "allow" | "block" | "modify"; reasons?: string[] } | { decision: "allow" },
  stage: "input" | "tool" | "output",
): ProposalOperatorGuardrailSummary | undefined {
  if (decision.decision !== "modify") {
    return undefined;
  }

  return {
    modified: true,
    stages: [stage],
    reasons: decision.reasons?.length
      ? [...new Set(decision.reasons)]
      : [`Guardrails modified ${stage} content.`]
  };
}

function normalizeGuardrailSummary(summary: {
  modified: true;
  stages: Array<"tool" | "output">;
  reasons: string[];
}): ProposalOperatorGuardrailSummary {
  return {
    modified: true,
    stages: [...summary.stages],
    reasons: [...summary.reasons]
  };
}

function extractGuardrailSummaryFromSkillResult(
  value: unknown,
): ProposalOperatorGuardrailSummary | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  if (
    "guardrail" in value &&
    typeof value.guardrail === "object" &&
    value.guardrail !== null &&
    "modified" in value.guardrail &&
    value.guardrail.modified === true &&
    "stages" in value.guardrail &&
    Array.isArray(value.guardrail.stages) &&
    "reasons" in value.guardrail &&
    Array.isArray(value.guardrail.reasons)
  ) {
    return normalizeGuardrailSummary(
      value.guardrail as {
        modified: true;
        stages: Array<"tool" | "output">;
        reasons: string[];
      },
    );
  }

  if (!("guardrails" in value) || !Array.isArray(value.guardrails)) {
    return undefined;
  }

  const stages = value.guardrails
    .map((item) =>
      typeof item === "object" && item !== null && "stage" in item && typeof item.stage === "string"
        ? item.stage
        : undefined,
    )
    .filter(
      (stage): stage is "input" | "tool" | "output" =>
        stage === "input" || stage === "tool" || stage === "output",
    );
  const reasons = value.guardrails.flatMap((item) =>
    typeof item === "object" && item !== null && "reasons" in item && Array.isArray(item.reasons)
      ? item.reasons.filter(
          (reason: unknown): reason is string =>
            typeof reason === "string" && reason.trim().length > 0,
        )
      : [],
  );

  if (stages.length === 0) {
    return undefined;
  }

  return {
    modified: true,
    stages: [...new Set(stages)],
    reasons: reasons.length > 0 ? [...new Set(reasons)] : ["Guardrails adjusted risky wording."]
  };
}

function mergeGuardrailSummaries(
  left?: ProposalOperatorGuardrailSummary,
  right?: ProposalOperatorGuardrailSummary,
): ProposalOperatorGuardrailSummary | undefined {
  if (!left && !right) {
    return undefined;
  }

  return {
    modified: true,
    stages: [...new Set([...(left?.stages ?? []), ...(right?.stages ?? [])])],
    reasons: [...new Set([...(left?.reasons ?? []), ...(right?.reasons ?? [])])]
  };
}

function shouldTreatAsRfpIngestion(
  message: string,
  hasExistingRfp: boolean,
): boolean {
  const trimmed = message.trim();

  if (trimmed.startsWith("/parse ") || trimmed.startsWith("/parse-file ")) {
    return true;
  }

  return !hasExistingRfp && looksLikeRfpText(trimmed);
}

function looksLikeRfpText(value: string): boolean {
  if (!value) {
    return false;
  }

  return (
    value.length > 160 ||
    value.includes("\n") ||
    /\b(rfp|request for proposal|must|should|shall|required|security|pricing|delivery)\b/i.test(
      value,
    )
  );
}
