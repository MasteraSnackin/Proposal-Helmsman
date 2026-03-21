import type { SkillContext } from "../../runtime/types.ts";
import { guardOutput, guardToolCall } from "../../guardrails/civic.ts";
import { ValidationError } from "../../runtime/errors.ts";
import {
  coerceGeneratedText,
  ensureWorkspace,
  readSectionText,
  requireWorkspacePath,
  stripMarkdownHeading,
  workspaceIdFromPath,
  writeSectionText
} from "./shared.ts";

export type ReviseSectionInput = {
  sectionName: string;
  instruction: string;
};

export type ReviseSectionResult =
  | {
      status: "ok";
      sectionName: string;
      file: string;
      guardrail?: {
        modified: true;
        stages: Array<"tool" | "output">;
        reasons: string[];
      };
    }
  | {
      status: "blocked";
      reason: string[];
    };

// TODO: If your OpenClaw SDK expects a different skill export shape, wrap `run`.
export async function run(
  input: ReviseSectionInput,
  context: SkillContext,
): Promise<ReviseSectionResult> {
  const workspacePath = requireWorkspacePath(context);
  await ensureWorkspace(workspacePath);

  if (!input.sectionName?.trim() || !input.instruction?.trim()) {
    throw new ValidationError("Provide both `sectionName` and `instruction` to revise a section.");
  }

  const guardDecision = await guardToolCall(
    "revise_section",
    {
      sectionName: input.sectionName,
      instruction: input.instruction
    },
    {
      workspaceId: workspaceIdFromPath(workspacePath)
    },
  );

  if (guardDecision.decision === "block") {
    return {
      status: "blocked",
      reason: guardDecision.reasons ?? ["Tool call blocked by Civic guardrails."]
    };
  }

  const guardrailStages: Array<"tool" | "output"> = [];
  const guardrailReasons: string[] = [];

  const instruction =
    guardDecision.decision === "modify" && guardDecision.modifiedText
      ? guardDecision.modifiedText
      : input.instruction.trim();

  if (guardDecision.decision === "modify") {
    guardrailStages.push("tool");
    guardrailReasons.push(
      ...(guardDecision.reasons ?? ["Tool call modified by Civic guardrails."]),
    );
  }

  const { fileName, content } = await readSectionText(
    workspacePath,
    input.sectionName,
  );

  const generated = await context.llm.generate({
    system: [
      "TASK=revise_section",
      "You revise proposal draft sections.",
      "Return only the revised section body text. Do not include a Markdown heading.",
      "Do not invent prices, legal guarantees, or client names."
    ].join("\n"),
    prompt: [
      `<section_name>\n${input.sectionName.trim()}\n</section_name>`,
      `<instruction>\n${instruction}\n</instruction>`,
      `<current_content>\n${content}\n</current_content>`
    ].join("\n\n")
  });

  const revisedText = stripMarkdownHeading(coerceGeneratedText(generated));
  const outputDecision = await guardOutput(revisedText, {
    use: "draft",
    workspaceId: workspaceIdFromPath(workspacePath)
  });

  if (outputDecision.decision === "block") {
    return {
      status: "blocked",
      reason: outputDecision.reasons ?? ["Revision blocked by Civic guardrails."]
    };
  }

  const finalText =
    outputDecision.decision === "modify" && outputDecision.modifiedText
      ? outputDecision.modifiedText
      : revisedText;

  if (outputDecision.decision === "modify") {
    guardrailStages.push("output");
    guardrailReasons.push(
      ...(outputDecision.reasons ?? ["Revision output modified by Civic guardrails."]),
    );
  }

  const saved = await writeSectionText(workspacePath, fileName, finalText);

  return {
    status: "ok",
    sectionName: input.sectionName.trim(),
    file: saved.relativePath,
    ...(guardrailStages.length > 0
      ? {
          guardrail: {
            modified: true as const,
            stages: [...new Set(guardrailStages)],
            reasons: [...new Set(guardrailReasons)]
          }
        }
      : {})
  };
}

export default run;
