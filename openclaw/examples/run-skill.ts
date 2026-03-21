import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { createConfiguredLlm } from "../runtime/model-client.ts";
import type { SkillContext } from "../runtime/types.ts";
import draftSection from "../skills/proposal-operator/draft_section.ts";
import exportProposal from "../skills/proposal-operator/export_proposal.ts";
import generateAudioBriefing from "../skills/proposal-operator/generate_audio_briefing.ts";
import parseRfp from "../skills/proposal-operator/parse_rfp.ts";
import planProposalStructure from "../skills/proposal-operator/plan_proposal_structure.ts";
import reviseSection from "../skills/proposal-operator/revise_section.ts";
import updateChecklistCoverage from "../skills/proposal-operator/update_checklist_coverage.ts";
import workspaceStatus from "../skills/proposal-operator/workspace_status.ts";

type SkillRunner = (input: unknown, context: SkillContext) => Promise<unknown>;

const skillMap: Record<string, SkillRunner> = {
  parse_rfp: parseRfp as SkillRunner,
  plan_proposal_structure: planProposalStructure as SkillRunner,
  draft_section: draftSection as SkillRunner,
  revise_section: reviseSection as SkillRunner,
  update_checklist_coverage: updateChecklistCoverage as SkillRunner,
  export_proposal: exportProposal as SkillRunner,
  generate_audio_briefing: generateAudioBriefing as SkillRunner,
  workspace_status: workspaceStatus as SkillRunner
};

async function main(): Promise<void> {
  const [skillName, workspaceArg, inputArg] = process.argv.slice(2);

  if (!skillName || !workspaceArg) {
    throw new Error(
      "Usage: npm run skill -- <skill_name> <workspace_path> [json | @json-file]",
    );
  }

  const skill = skillMap[skillName];

  if (!skill) {
    throw new Error(`Unknown skill: ${skillName}`);
  }

  const workspacePath = path.resolve(process.cwd(), workspaceArg);
  await mkdir(workspacePath, { recursive: true });

  const context: SkillContext = {
    workspacePath,
    llm: createConfiguredLlm()
  };

  const input = await loadInput(inputArg);
  const result = await skill(input, context);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function loadInput(inputArg: string | undefined): Promise<unknown> {
  if (!inputArg) {
    return {};
  }

  if (inputArg.startsWith("@")) {
    const filePath = path.resolve(process.cwd(), inputArg.slice(1));
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  }

  return JSON.parse(inputArg) as unknown;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
