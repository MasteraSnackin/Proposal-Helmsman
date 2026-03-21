import { ValidationError } from "../../runtime/errors.ts";
import type { SkillContext } from "../../runtime/types.ts";
import {
  coerceGeneratedJson,
  ensureWorkspace,
  normalizeSectionPlan,
  readRfpDocument,
  requireWorkspacePath,
  writeProposalStructure,
  type ProposalSection
} from "./shared.ts";

export type PlanProposalStructureInput = Record<string, never>;

export type PlanProposalStructureResult = {
  status: "ok";
  sections: ProposalSection[];
};

type StructureModelOutput = {
  sections?: Array<{
    name?: string;
    order?: number;
  }>;
};

// TODO: If your OpenClaw SDK expects a different skill export shape, wrap `run`.
export async function run(
  _input: PlanProposalStructureInput,
  context: SkillContext,
): Promise<PlanProposalStructureResult> {
  const workspacePath = requireWorkspacePath(context);
  await ensureWorkspace(workspacePath);

  const rfp = await readRfpDocument(workspacePath);

  if (!rfp) {
    throw new ValidationError("Parse an RFP before planning the proposal structure.");
  }

  const generated = await context.llm.generate<StructureModelOutput>({
    system: [
      "TASK=plan_proposal_structure",
      "You are planning a proposal response.",
      'Return JSON only with the shape: {"sections":[{"name":"Executive Summary","order":1}]}',
      "Include standard proposal sections where relevant."
    ].join("\n"),
    prompt: [
      `<rfp_summary>\n${rfp.summary}\n</rfp_summary>`,
      `<requirements_json>\n${JSON.stringify(rfp.requirements, null, 2)}\n</requirements_json>`
    ].join("\n\n"),
    output: {
      format: "json",
      schema: {
        type: "object",
        properties: {
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                order: { type: "number" }
              },
              required: ["name", "order"]
            }
          }
        },
        required: ["sections"]
      }
    }
  });

  const parsed = coerceGeneratedJson<StructureModelOutput>(generated);
  const sections = normalizeSectionPlan(parsed.sections ?? []);

  await writeProposalStructure(workspacePath, { sections });

  return {
    status: "ok",
    sections
  };
}

export default run;
