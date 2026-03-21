import { writeFile } from "node:fs/promises";

import type { SkillContext } from "../../runtime/types.ts";
import { guardOutput } from "../../guardrails/civic.ts";
import {
  DEFAULT_PROPOSAL_SECTIONS,
  PROPOSAL_MD_FILE,
  createGuardrailIntervention,
  ensureWorkspace,
  type GuardrailIntervention,
  readProposalStructure,
  readTextIfExists,
  requireWorkspacePath,
  sectionAbsolutePath,
  sectionFileFromName,
  workspaceFilePath,
  workspaceIdFromPath
} from "./shared.ts";

export type ExportProposalInput = Record<string, never>;

export type ExportProposalResult =
  | {
      status: "ok";
      file: string;
      guardrails?: GuardrailIntervention[];
    }
  | {
      status: "blocked";
      reason: string[];
    };

// TODO: If your OpenClaw SDK expects a different skill export shape, wrap `run`.
export async function run(
  _input: ExportProposalInput,
  context: SkillContext,
): Promise<ExportProposalResult> {
  const workspacePath = requireWorkspacePath(context);
  await ensureWorkspace(workspacePath);

  const structure =
    (await readProposalStructure(workspacePath)) ?? {
      sections: DEFAULT_PROPOSAL_SECTIONS
    };

  const compiledSections = await Promise.all(
    structure.sections
      .sort((left, right) => left.order - right.order)
      .map(async (section) => {
        const content =
          (await readTextIfExists(
            sectionAbsolutePath(workspacePath, sectionFileFromName(section.name)),
          ))?.trim() || "_Draft pending._";

        return `## ${section.name}\n\n${content}`;
      }),
  );

  const proposalText = [`# Proposal Draft`, ...compiledSections].join("\n\n");
  const guardDecision = await guardOutput(proposalText, {
    use: "export",
    workspaceId: workspaceIdFromPath(workspacePath)
  });

  if (guardDecision.decision === "block") {
    return {
      status: "blocked",
      reason: guardDecision.reasons ?? ["Proposal export blocked by Civic guardrails."]
    };
  }

  const finalText =
    guardDecision.decision === "modify" && guardDecision.modifiedText
      ? guardDecision.modifiedText
      : proposalText;
  const guardrails =
    guardDecision.decision === "modify"
      ? [
          createGuardrailIntervention(
            "output",
            guardDecision.reasons,
            "Exported proposal text was adjusted by guardrails.",
          )
        ]
      : undefined;

  await writeFile(
    workspaceFilePath(workspacePath, PROPOSAL_MD_FILE),
    `${finalText.trim()}\n`,
    "utf8",
  );

  return {
    status: "ok",
    file: PROPOSAL_MD_FILE,
    ...(guardrails ? { guardrails } : {})
  };
}

export default run;
