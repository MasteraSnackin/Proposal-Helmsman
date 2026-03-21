import type { SkillContext } from "../../runtime/types.ts";
import {
  PROPOSAL_MD_FILE,
  ensureWorkspace,
  listSectionFiles,
  proposalSectionFile,
  readProposalStructure,
  readRfpDocument,
  readTextIfExists,
  requireWorkspacePath,
  workspaceFilePath,
  type WorkspaceStatusSnapshot
} from "./shared.ts";

export type WorkspaceStatusInput = Record<string, never>;

export type WorkspaceStatusResult = WorkspaceStatusSnapshot & {
  proposalExists: boolean;
};

// TODO: If your OpenClaw SDK expects a different skill export shape, wrap `run`.
export async function run(
  _input: WorkspaceStatusInput,
  context: SkillContext,
): Promise<WorkspaceStatusResult> {
  const workspacePath = requireWorkspacePath(context);
  await ensureWorkspace(workspacePath);

  const rfp = await readRfpDocument(workspacePath);
  const structure = await readProposalStructure(workspacePath);
  const sectionFiles = await listSectionFiles(workspacePath);
  const sectionFileSet = new Set(sectionFiles.map((file) => `sections/${file}`));

  const sections =
    structure?.sections.map((section) => {
      const file = proposalSectionFile(section);
      return {
        name: section.name,
        file,
        exists: sectionFileSet.has(file)
      };
    }) ??
    sectionFiles.map((file) => ({
      name: file.replace(/\.md$/i, "").replace(/_/g, " "),
      file: `sections/${file}`,
      exists: true
    }));

  return {
    summary: rfp?.summary ?? "",
    requirements: rfp?.requirements ?? [],
    sections,
    proposalExists: Boolean(
      await readTextIfExists(workspaceFilePath(workspacePath, PROPOSAL_MD_FILE)),
    )
  };
}

export default run;
