import path from "node:path";

import { ValidationError } from "../../runtime/errors.ts";
import type { SkillContext } from "../../runtime/types.ts";
import {
  coerceGeneratedJson,
  ensureWorkspace,
  readRequiredText,
  resolveWorkspacePath,
  requireWorkspacePath,
  slugify,
  writeRfpDocument,
  type Requirement
} from "./shared.ts";
export type ParseRfpInput = {
  rfpText?: string;
  rfpFile?: string;
};

export type ParseRfpResult = {
  status: "ok";
  summary: string;
  requirementCount: number;
};

type ParseRfpModelOutput = {
  summary?: string;
  requirements?: Array<{
    id?: string;
    text?: string;
    must_have?: boolean;
  }>;
};

// TODO: If your OpenClaw SDK expects a different skill export shape, wrap `run`.
export async function run(
  input: ParseRfpInput,
  context: SkillContext,
): Promise<ParseRfpResult> {
  const workspacePath = requireWorkspacePath(context);
  await ensureWorkspace(workspacePath);

  const sourceText = await loadRfpText(input, workspacePath);

  const generated = await context.llm.generate<ParseRfpModelOutput>({
    system: [
      "TASK=parse_rfp",
      "You analyse RFP text and respond with JSON only.",
      'Return exactly this shape: {"summary":"...", "requirements":[{"id":"...", "text":"...", "must_have":true}]}',
      "Summary should be 3-6 sentences.",
      "Requirements should be concise and normalized."
    ].join("\n"),
    prompt: `<rfp_text>\n${sourceText}\n</rfp_text>`,
    output: {
      format: "json",
      schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          requirements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                must_have: { type: "boolean" }
              },
              required: ["text", "must_have"]
            }
          }
        },
        required: ["summary", "requirements"]
      }
    }
  });

  const parsed = coerceGeneratedJson<ParseRfpModelOutput>(generated);
  const summary = parsed.summary?.trim() || "RFP summary unavailable.";
  const requirements = normalizeRequirements(parsed.requirements ?? []);

  await writeRfpDocument(workspacePath, {
    summary,
    requirements
  });

  return {
    status: "ok",
    summary,
    requirementCount: requirements.length
  };
}

export default run;

async function loadRfpText(
  input: ParseRfpInput,
  workspacePath: string,
): Promise<string> {
  if (input.rfpText?.trim()) {
    return input.rfpText.trim();
  }

  if (input.rfpFile?.trim()) {
    const absolutePath = resolveWorkspacePath(workspacePath, input.rfpFile.trim());
    return (await readRequiredText(path.resolve(absolutePath))).trim();
  }

  throw new ValidationError("Provide either `rfpText` or `rfpFile` to parse an RFP.");
}

function normalizeRequirements(
  requirements: ParseRfpModelOutput["requirements"],
): Requirement[] {
  const seenIds = new Set<string>();

  return (requirements ?? [])
    .filter((requirement) => typeof requirement.text === "string" && requirement.text.trim())
    .map((requirement, index) => {
      const seed = requirement.id?.trim() || requirement.text!;
      let id = slugify(seed).replace(/-/g, "_");

      if (!id) {
        id = "requirement";
      }

      let candidate = `${id}_${index + 1}`;

      while (seenIds.has(candidate)) {
        candidate = `${id}_${index + 1}_${seenIds.size + 1}`;
      }

      seenIds.add(candidate);

      return {
        id: candidate,
        text: requirement.text!.trim(),
        must_have: Boolean(requirement.must_have),
        covered: false,
        evidence: []
      };
    });
}
