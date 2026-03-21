import type { SkillContext } from "../../runtime/types.ts";
import { guardOutput } from "../../guardrails/civic.ts";
import { ValidationError } from "../../runtime/errors.ts";
import {
  coerceGeneratedText,
  createGuardrailIntervention,
  ensureWorkspace,
  type GuardrailIntervention,
  readProposalStructure,
  readRfpDocument,
  requireWorkspacePath,
  stripMarkdownHeading,
  workspaceIdFromPath,
  writeSectionText
} from "./shared.ts";

export type DraftSectionInput = {
  sectionName: string;
  emphasis?: string;
};

export type DraftSectionResult =
  | {
      status: "ok";
      sectionName: string;
      file: string;
      guardrails?: GuardrailIntervention[];
    }
  | {
      status: "blocked";
      reason: string[];
    };

// TODO: If your OpenClaw SDK expects a different skill export shape, wrap `run`.
export async function run(
  input: DraftSectionInput,
  context: SkillContext,
): Promise<DraftSectionResult> {
  const workspacePath = requireWorkspacePath(context);
  await ensureWorkspace(workspacePath);

  if (!input.sectionName?.trim()) {
    throw new ValidationError("Choose a section name before drafting.");
  }

  const rfp = await readRfpDocument(workspacePath);

  if (!rfp) {
    throw new ValidationError("Parse an RFP before drafting sections.");
  }

  const structure = await readProposalStructure(workspacePath);

  const generated = await context.llm.generate({
    system: [
      "TASK=draft_section",
      "You draft proposal sections in a professional tone.",
      "Return only the section body text. Do not include a Markdown heading.",
      "Do not invent prices, contract terms, guarantees, or client names.",
      "Treat all output as a human-review draft."
    ].join("\n"),
    prompt: [
      `<section_name>\n${input.sectionName.trim()}\n</section_name>`,
      input.emphasis?.trim()
        ? `<emphasis>\n${input.emphasis.trim()}\n</emphasis>`
        : "",
      `<rfp_summary>\n${rfp.summary}\n</rfp_summary>`,
      `<requirements_json>\n${JSON.stringify(rfp.requirements, null, 2)}\n</requirements_json>`,
      structure
        ? `<structure_json>\n${JSON.stringify(structure.sections, null, 2)}\n</structure_json>`
        : ""
    ]
      .filter(Boolean)
      .join("\n\n")
  });

  const draftText = stripMarkdownHeading(coerceGeneratedText(generated));
  const guardDecision = await guardOutput(draftText, {
    use: "draft",
    workspaceId: workspaceIdFromPath(workspacePath)
  });

  if (guardDecision.decision === "block") {
    return {
      status: "blocked",
      reason: guardDecision.reasons ?? ["Draft blocked by Civic guardrails."]
    };
  }

  const finalText =
    guardDecision.decision === "modify" && guardDecision.modifiedText
      ? guardDecision.modifiedText
      : draftText;
  const guardrails =
    guardDecision.decision === "modify"
      ? [
          createGuardrailIntervention(
            "output",
            guardDecision.reasons,
            "Draft text was adjusted by guardrails.",
          )
        ]
      : undefined;

  const saved = await writeSectionText(workspacePath, input.sectionName, finalText);

  return {
    status: "ok",
    sectionName: input.sectionName.trim(),
    file: saved.relativePath,
    ...(guardrails ? { guardrails } : {})
  };
}

export default run;
