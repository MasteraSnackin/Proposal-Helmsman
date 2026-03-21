import { ValidationError } from "../../runtime/errors.ts";
import type { SkillContext } from "../../runtime/types.ts";
import {
  ensureWorkspace,
  findRequirementEvidence,
  readAllSectionContents,
  readRfpDocument,
  requireWorkspacePath,
  writeRfpDocument
} from "./shared.ts";

export type UpdateChecklistCoverageInput = Record<string, never>;

export type UpdateChecklistCoverageResult = {
  status: "ok";
  mustHaveTotal: number;
  mustHaveCovered: number;
};

// TODO: If your OpenClaw SDK expects a different skill export shape, wrap `run`.
export async function run(
  _input: UpdateChecklistCoverageInput,
  context: SkillContext,
): Promise<UpdateChecklistCoverageResult> {
  const workspacePath = requireWorkspacePath(context);
  await ensureWorkspace(workspacePath);

  const rfp = await readRfpDocument(workspacePath);

  if (!rfp) {
    throw new ValidationError("Parse an RFP before updating requirement coverage.");
  }

  const sectionContents = await readAllSectionContents(workspacePath);

  const updatedRequirements = rfp.requirements.map((requirement) => {
    const evidence = findRequirementEvidence(requirement.text, sectionContents);

    return {
      ...requirement,
      covered: evidence.length > 0,
      evidence
    };
  });

  const updatedDocument = {
    ...rfp,
    requirements: updatedRequirements
  };

  await writeRfpDocument(workspacePath, updatedDocument);

  const mustHaveRequirements = updatedRequirements.filter(
    (requirement) => requirement.must_have,
  );

  return {
    status: "ok",
    mustHaveTotal: mustHaveRequirements.length,
    mustHaveCovered: mustHaveRequirements.filter((requirement) => requirement.covered)
      .length
  };
}

export default run;
