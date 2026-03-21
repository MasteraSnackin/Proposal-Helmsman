import { guardOutput } from "../../guardrails/civic.ts";
import { synthesizeSpeech } from "../../runtime/elevenlabs-client.ts";
import { NotFoundError, ValidationError } from "../../runtime/errors.ts";
import type { SkillContext } from "../../runtime/types.ts";
import {
  PROPOSAL_MD_FILE,
  ensureWorkspace,
  readRequiredText,
  readRfpDocument,
  readSectionText,
  requireWorkspacePath,
  slugify,
  stripMarkdownHeading,
  workspaceFilePath,
  workspaceIdFromPath,
  writeAudioArtifact,
  type AudioArtifactMetadata,
  type AudioBriefingSource
} from "./shared.ts";

export type GenerateAudioBriefingInput = {
  source?: AudioBriefingSource;
  sectionName?: string;
  voiceId?: string;
  modelId?: string;
  outputFormat?: string;
};

export type GenerateAudioBriefingResult =
  | {
      status: "ok";
      file: string;
      contentType: string;
      source: AudioBriefingSource;
      sectionName?: string;
      provider: "live" | "mock";
      characters: number;
    }
  | {
      status: "blocked";
      reason: string[];
    };

const DEFAULT_AUDIO_CHAR_LIMIT = 3_200;

// TODO: If your OpenClaw SDK expects a different skill export shape, wrap `run`.
export async function run(
  input: GenerateAudioBriefingInput,
  context: SkillContext,
): Promise<GenerateAudioBriefingResult> {
  const workspacePath = requireWorkspacePath(context);
  await ensureWorkspace(workspacePath);

  const source = resolveSource(input);
  const narration = await buildNarrationText(workspacePath, source, input.sectionName);
  const workspaceId = workspaceIdFromPath(workspacePath);
  const outputDecision = await guardOutput(narration, {
    use: "draft",
    workspaceId
  });

  if (outputDecision.decision === "block") {
    return {
      status: "blocked",
      reason: outputDecision.reasons ?? ["Audio briefing blocked by guardrails."]
    };
  }

  const guardedText =
    outputDecision.decision === "modify" && outputDecision.modifiedText
      ? outputDecision.modifiedText
      : narration;
  const synthesis = await synthesizeSpeech({
    text: guardedText,
    voiceId: input.voiceId,
    modelId: input.modelId,
    outputFormat: input.outputFormat
  });
  const fileStem = buildFileStem(source, input.sectionName);
  const fileName = `${fileStem}.${synthesis.extension}`;
  const metadata: AudioArtifactMetadata = {
    file: `audio/${fileName}`,
    contentType: synthesis.contentType,
    source,
    ...(source === "section" && input.sectionName?.trim()
      ? { sectionName: input.sectionName.trim() }
      : {}),
    provider: synthesis.provider,
    voiceId: synthesis.voiceId,
    modelId: synthesis.modelId,
    outputFormat: synthesis.outputFormat,
    characters: synthesis.characterCount,
    generatedAt: new Date().toISOString()
  };

  await writeAudioArtifact(workspacePath, fileName, synthesis.audioData, metadata);

  return {
    status: "ok",
    file: metadata.file,
    contentType: metadata.contentType,
    source,
    ...(metadata.sectionName ? { sectionName: metadata.sectionName } : {}),
    provider: metadata.provider,
    characters: metadata.characters
  };
}

export default run;

function resolveSource(input: GenerateAudioBriefingInput): AudioBriefingSource {
  if (input.source) {
    return input.source;
  }

  return input.sectionName?.trim() ? "section" : "summary";
}

async function buildNarrationText(
  workspacePath: string,
  source: AudioBriefingSource,
  sectionName?: string,
): Promise<string> {
  switch (source) {
    case "summary":
      return await buildSummaryNarration(workspacePath);
    case "proposal":
      return await buildProposalNarration(workspacePath);
    case "section":
      if (!sectionName?.trim()) {
        throw new ValidationError("`sectionName` is required when source is `section`.");
      }

      return await buildSectionNarration(workspacePath, sectionName.trim());
  }
}

async function buildSummaryNarration(workspacePath: string): Promise<string> {
  const rfp = await readRfpDocument(workspacePath);

  if (!rfp) {
    throw new ValidationError("Parse an RFP before generating an audio briefing.");
  }

  const priorityRequirements = rfp.requirements
    .filter((requirement) => requirement.must_have)
    .slice(0, 3);
  const fallbackRequirements =
    priorityRequirements.length > 0 ? priorityRequirements : rfp.requirements.slice(0, 3);
  const requirementSentence =
    fallbackRequirements.length > 0
      ? `Key requirements include ${fallbackRequirements
          .map((requirement) => sanitizeNarrationText(requirement.text))
          .join("; ")}.`
      : "";

  return trimNarration([
    "Proposal briefing.",
    sanitizeNarrationText(rfp.summary),
    requirementSentence
  ]);
}

async function buildProposalNarration(workspacePath: string): Promise<string> {
  const proposalText = await readRequiredText(workspaceFilePath(workspacePath, PROPOSAL_MD_FILE));

  if (!proposalText.trim()) {
    throw new NotFoundError("Export a proposal before generating proposal audio.");
  }

  return trimNarration([
    "Proposal draft briefing.",
    sanitizeNarrationText(proposalText)
  ]);
}

async function buildSectionNarration(
  workspacePath: string,
  sectionName: string,
): Promise<string> {
  const section = await readSectionText(workspacePath, sectionName);
  return trimNarration([
    `${sectionName} briefing.`,
    sanitizeNarrationText(section.content)
  ]);
}

function buildFileStem(source: AudioBriefingSource, sectionName?: string): string {
  if (source === "section" && sectionName?.trim()) {
    return `briefing-${slugify(sectionName)}`;
  }

  return source === "proposal" ? "briefing-proposal" : "briefing-summary";
}

function sanitizeNarrationText(content: string): string {
  return stripMarkdownHeading(content)
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/[`*_>]/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function trimNarration(parts: string[]): string {
  const text = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  if (text.length <= DEFAULT_AUDIO_CHAR_LIMIT) {
    return text;
  }

  const truncated = text.slice(0, DEFAULT_AUDIO_CHAR_LIMIT);
  const sentenceSafe = truncated.replace(/\s+\S*$/, "").trim();
  return `${sentenceSafe}. This audio briefing was shortened for length.`;
}
