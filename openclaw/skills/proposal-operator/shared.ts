import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DataIntegrityError,
  ExternalServiceError,
  NotFoundError,
  ValidationError
} from "../../runtime/errors.ts";
import { isRecord, type SkillContext } from "../../runtime/types.ts";

export interface Requirement {
  id: string;
  text: string;
  must_have: boolean;
  covered: boolean;
  evidence?: RequirementCoverageEvidence[];
}

export interface RequirementCoverageEvidence {
  section: string;
  file: string;
  matched_keywords: string[];
}

export interface RfpDocument {
  summary: string;
  requirements: Requirement[];
}

export interface ProposalSection {
  name: string;
  order: number;
}

export interface ProposalStructure {
  sections: ProposalSection[];
}

export interface WorkspaceStatusSnapshot {
  summary: string;
  requirements: Requirement[];
  sections: Array<{
    name: string;
    file: string;
    exists: boolean;
  }>;
}

export type AudioBriefingSource = "summary" | "proposal" | "section";

export interface AudioArtifactMetadata {
  file: string;
  contentType: string;
  source: AudioBriefingSource;
  sectionName?: string;
  provider: "live" | "mock";
  voiceId: string;
  modelId: string;
  outputFormat: string;
  characters: number;
  generatedAt: string;
}

export interface GuardrailIntervention {
  stage: "input" | "tool" | "output";
  reasons: string[];
}

export function createGuardrailIntervention(
  stage: GuardrailIntervention["stage"],
  reasons: string[] | undefined,
  fallbackReason: string,
): GuardrailIntervention {
  return {
    stage,
    reasons: reasons && reasons.length > 0 ? reasons : [fallbackReason]
  };
}

export const RFP_JSON_FILE = "rfp.json";
export const STRUCTURE_JSON_FILE = "structure.json";
export const SECTIONS_DIR = "sections";
export const PROPOSAL_MD_FILE = "proposal.md";
export const AUDIO_DIR = "audio";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "our",
  "proposal",
  "provide",
  "required",
  "rfp",
  "shall",
  "should",
  "the",
  "their",
  "they",
  "this",
  "to",
  "we",
  "will",
  "with",
  "you",
  "your"
]);

const COVERAGE_ALIAS_MAP = new Map<string, string>([
  ["bid", "proposal"],
  ["bids", "proposal"],
  ["budget", "commercial"],
  ["budgets", "commercial"],
  ["capture", "extract"],
  ["captures", "extract"],
  ["capturing", "extract"],
  ["chatops", "slack"],
  ["checklists", "requirement"],
  ["commercials", "commercial"],
  ["confidential", "privacy"],
  ["confidentiality", "privacy"],
  ["cost", "commercial"],
  ["costs", "commercial"],
  ["contract", "commercial"],
  ["contracts", "commercial"],
  ["contractual", "commercial"],
  ["conversation", "thread"],
  ["conversations", "thread"],
  ["criteria", "requirement"],
  ["cyber", "security"],
  ["cybersecurity", "security"],
  ["data-protection", "privacy"],
  ["deliver", "delivery"],
  ["delivering", "delivery"],
  ["delivery", "delivery"],
  ["edit", "revise"],
  ["editing", "revise"],
  ["execution", "delivery"],
  ["essential", "mandatory"],
  ["extracting", "extract"],
  ["fee", "commercial"],
  ["fees", "commercial"],
  ["fixed-price", "commercial"],
  ["gdpr", "privacy"],
  ["guarantees", "guarantee"],
  ["handover", "delivery"],
  ["identify", "extract"],
  ["identifies", "extract"],
  ["identifying", "extract"],
  ["implementation", "delivery"],
  ["implementations", "delivery"],
  ["indemnity", "liability"],
  ["infosec", "security"],
  ["milestones", "timeline"],
  ["must", "mandatory"],
  ["mandatory", "mandatory"],
  ["material", "text"],
  ["needs", "mandatory"],
  ["optional", "optional"],
  ["commitment", "guarantee"],
  ["commitments", "guarantee"],
  ["discretionary", "optional"],
  ["outline", "structure"],
  ["outlining", "structure"],
  ["overview", "summary"],
  ["people", "team"],
  ["personnel", "team"],
  ["plan", "timeline"],
  ["planning", "timeline"],
  ["plans", "timeline"],
  ["price", "commercial"],
  ["prices", "commercial"],
  ["pricing", "commercial"],
  ["private", "privacy"],
  ["required", "mandatory"],
  ["requirements", "requirement"],
  ["responses", "proposal"],
  ["references", "client"],
  ["response", "proposal"],
  ["responses", "proposal"],
  ["roadmap", "timeline"],
  ["rollout", "delivery"],
  ["schedules", "timeline"],
  ["section", "structure"],
  ["sections", "structure"],
  ["secure", "security"],
  ["security", "security"],
  ["slas", "guarantee"],
  ["staff", "team"],
  ["submission", "proposal"],
  ["submissions", "proposal"],
  ["summaries", "summary"],
  ["summarise", "summary"],
  ["summarised", "summary"],
  ["summarises", "summary"],
  ["summarize", "summary"],
  ["summarized", "summary"],
  ["summarizes", "summary"],
  ["tender", "proposal"],
  ["tenders", "proposal"],
  ["threaded", "thread"],
  ["threads", "thread"],
  ["timeline", "timeline"],
  ["timelines", "timeline"],
  ["update", "revise"],
  ["updates", "revise"],
  ["updating", "revise"],
  ["uptime", "guarantee"],
  ["workspaces", "workspace"],
  ["write", "draft"],
  ["writing", "draft"]
]);

const COVERAGE_CONCEPT_TOKENS = new Set(
  Array.from(
    new Set([
      ...COVERAGE_ALIAS_MAP.values(),
      "client",
      "commercial",
      "delivery",
      "draft",
      "extract",
      "guarantee",
      "liability",
      "mandatory",
      "optional",
      "privacy",
      "proposal",
      "requirement",
      "security",
      "slack",
      "structure",
      "summary",
      "team",
      "text",
      "thread",
      "timeline",
      "workspace"
    ]),
  ),
);

type CoverageFeatures = {
  rawKeywords: string[];
  canonicalTokens: string[];
  canonicalTokenSet: Set<string>;
  canonicalPhrases: string[];
  canonicalPhraseSet: Set<string>;
};

export const DEFAULT_PROPOSAL_SECTIONS: ProposalSection[] = [
  { name: "Executive Summary", order: 1 },
  { name: "Understanding of Requirements", order: 2 },
  { name: "Proposed Solution", order: 3 },
  { name: "Delivery Plan", order: 4 },
  { name: "Team and Relevant Experience", order: 5 },
  { name: "Data Privacy and Security", order: 6 },
  { name: "Commercials and Assumptions", order: 7 }
];

export async function ensureWorkspace(workspacePath: string): Promise<void> {
  await mkdir(workspacePath, { recursive: true });
  await mkdir(path.join(workspacePath, SECTIONS_DIR), { recursive: true });
  await mkdir(path.join(workspacePath, AUDIO_DIR), { recursive: true });
}

export function workspaceIdFromPath(workspacePath: string): string {
  return path.basename(path.resolve(workspacePath));
}

export function workspaceFilePath(
  workspacePath: string,
  relativeFile: string,
): string {
  return path.join(workspacePath, relativeFile);
}

export function resolveWorkspacePath(
  workspacePath: string,
  relativeFile: string,
): string {
  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedTarget = path.resolve(resolvedWorkspace, relativeFile);

  if (
    resolvedTarget !== resolvedWorkspace &&
    !resolvedTarget.startsWith(`${resolvedWorkspace}${path.sep}`)
  ) {
    throw new ValidationError("Requested file path escapes the workspace.", {
      relativeFile
    });
  }

  return resolvedTarget;
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new DataIntegrityError("Workspace JSON is malformed.", { filePath }, error);
    }
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function readRequiredText(filePath: string): Promise<string> {
  const content = await readTextIfExists(filePath);

  if (content === undefined) {
    throw new NotFoundError("Required workspace file was not found.", {
      filePath
    });
  }

  return content;
}

export async function readRfpDocument(
  workspacePath: string,
): Promise<RfpDocument | undefined> {
  return readJsonIfExists<RfpDocument>(
    workspaceFilePath(workspacePath, RFP_JSON_FILE),
  );
}

export async function writeRfpDocument(
  workspacePath: string,
  document: RfpDocument,
): Promise<void> {
  await writeJsonFile(workspaceFilePath(workspacePath, RFP_JSON_FILE), document);
}

export async function readProposalStructure(
  workspacePath: string,
): Promise<ProposalStructure | undefined> {
  return readJsonIfExists<ProposalStructure>(
    workspaceFilePath(workspacePath, STRUCTURE_JSON_FILE),
  );
}

export async function writeProposalStructure(
  workspacePath: string,
  structure: ProposalStructure,
): Promise<void> {
  await writeJsonFile(
    workspaceFilePath(workspacePath, STRUCTURE_JSON_FILE),
    structure,
  );
}

export function normalizeSectionFileName(sectionNameOrFile: string): string {
  const baseName = path.basename(sectionNameOrFile).replace(/\.md$/i, "");
  return `${toSnakeCase(baseName)}.md`;
}

export function sectionFileFromName(sectionName: string): string {
  return normalizeSectionFileName(sectionName);
}

export function sectionRelativePath(fileName: string): string {
  return path.posix.join(SECTIONS_DIR, fileName);
}

export function sectionAbsolutePath(
  workspacePath: string,
  fileName: string,
): string {
  return workspaceFilePath(workspacePath, sectionRelativePath(fileName));
}

export function audioRelativePath(fileName: string): string {
  return path.posix.join(AUDIO_DIR, path.basename(fileName));
}

export function audioAbsolutePath(workspacePath: string, fileName: string): string {
  return workspaceFilePath(workspacePath, audioRelativePath(fileName));
}

export function audioMetadataFileName(fileName: string): string {
  return `${path.basename(fileName, path.extname(fileName))}.json`;
}

export async function readSectionText(
  workspacePath: string,
  sectionNameOrFile: string,
): Promise<{ fileName: string; content: string }> {
  const fileName = normalizeSectionFileName(sectionNameOrFile);
  const content = await readRequiredText(sectionAbsolutePath(workspacePath, fileName));
  return { fileName, content };
}

export async function writeSectionText(
  workspacePath: string,
  sectionName: string,
  content: string,
): Promise<{ fileName: string; relativePath: string }> {
  const fileName = sectionFileFromName(sectionName);
  const relativePath = sectionRelativePath(fileName);
  const absolutePath = workspaceFilePath(workspacePath, relativePath);
  await writeFile(absolutePath, `${content.trim()}\n`, "utf8");
  return { fileName, relativePath };
}

export async function listSectionFiles(workspacePath: string): Promise<string[]> {
  const sectionsPath = workspaceFilePath(workspacePath, SECTIONS_DIR);

  try {
    const entries = await readdir(sectionsPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
}

export async function readAllSectionContents(
  workspacePath: string,
): Promise<Array<{ fileName: string; content: string }>> {
  const files = await listSectionFiles(workspacePath);
  return Promise.all(
    files.map(async (fileName) => ({
      fileName,
      content: await readRequiredText(sectionAbsolutePath(workspacePath, fileName))
    })),
  );
}

export async function listAudioArtifacts(
  workspacePath: string,
): Promise<AudioArtifactMetadata[]> {
  const audioPath = workspaceFilePath(workspacePath, AUDIO_DIR);

  try {
    const entries = await readdir(audioPath, { withFileTypes: true });
    const metadataFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));

    const artifacts = await Promise.all(
      metadataFiles.map(async (fileName) => {
        return await readJsonIfExists<AudioArtifactMetadata>(
          workspaceFilePath(workspacePath, path.posix.join(AUDIO_DIR, fileName)),
        );
      }),
    );

    return artifacts
      .filter((artifact): artifact is AudioArtifactMetadata => Boolean(artifact))
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
}

export async function writeAudioArtifact(
  workspacePath: string,
  fileName: string,
  audioData: Uint8Array,
  metadata: AudioArtifactMetadata,
): Promise<void> {
  await writeFile(audioAbsolutePath(workspacePath, fileName), audioData);
  await writeJsonFile(
    workspaceFilePath(workspacePath, path.posix.join(AUDIO_DIR, audioMetadataFileName(fileName))),
    metadata,
  );
}

export function proposalSectionFile(section: ProposalSection): string {
  return sectionRelativePath(sectionFileFromName(section.name));
}

export function toSnakeCase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

export function stripMarkdownHeading(content: string): string {
  const lines = content.trim().split(/\r?\n/);

  if (lines[0]?.trim().startsWith("#")) {
    return lines.slice(1).join("\n").trim();
  }

  return content.trim();
}

export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));

  return Array.from(new Set(words));
}

export function isRequirementCovered(
  requirementText: string,
  sectionTexts: string[],
): boolean {
  const sections = sectionTexts.map((content, index) => ({
    fileName: `section_${index + 1}.md`,
    content
  }));

  return findRequirementEvidence(requirementText, sections).length > 0;
}

export function findRequirementEvidence(
  requirementText: string,
  sections: Array<{ fileName: string; content: string }>,
): RequirementCoverageEvidence[] {
  const requirementFeatures = buildCoverageFeatures(requirementText);

  if (
    requirementFeatures.canonicalTokens.length === 0 &&
    requirementFeatures.canonicalPhrases.length === 0
  ) {
    return [];
  }

  return sections
    .map((section) => {
      const bestMatch = rankSectionCoverage(requirementFeatures, section.content);

      if (!bestMatch || !meetsCoverageThreshold(requirementFeatures, bestMatch)) {
        return undefined;
      }

      return {
        section: humanizeSectionFileName(section.fileName),
        file: sectionRelativePath(section.fileName),
        matched_keywords: buildMatchedKeywords(requirementFeatures, bestMatch).slice(0, 6)
      };
    })
    .filter((evidence): evidence is RequirementCoverageEvidence => Boolean(evidence));
}

export function coerceGeneratedText(generated: unknown): string {
  if (typeof generated === "string") {
    return stripCodeFence(generated).trim();
  }

  if (isRecord(generated)) {
    const directText = firstString(
      generated.text,
      generated.content,
      generated.output_text,
    );

    if (directText) {
      return stripCodeFence(directText).trim();
    }
  }

  throw new ExternalServiceError("Model output did not contain plain text.", {
    service: "model",
    retryable: false
  });
}

export function coerceGeneratedJson<T>(generated: unknown): T {
  if (typeof generated === "string") {
    try {
      return JSON.parse(stripCodeFence(generated)) as T;
    } catch (error) {
      throw new ExternalServiceError("Model output did not contain valid JSON.", {
        service: "model",
        retryable: false,
        cause: error
      });
    }
  }

  if (isRecord(generated)) {
    if ("json" in generated && generated.json !== undefined) {
      return generated.json as T;
    }

    const directText = firstString(
      generated.text,
      generated.content,
      generated.output_text,
    );

    if (directText) {
      try {
        return JSON.parse(stripCodeFence(directText)) as T;
      } catch (error) {
        throw new ExternalServiceError("Model output did not contain valid JSON.", {
          service: "model",
          retryable: false,
          cause: error
        });
      }
    }

    return generated as T;
  }

  throw new ExternalServiceError("Model output could not be interpreted as JSON.", {
    service: "model",
    retryable: false
  });
}

export function normalizeSectionPlan(
  sections: Array<{ name?: string; order?: number }>,
): ProposalSection[] {
  const cleaned = sections
    .filter((section) => typeof section.name === "string" && section.name.trim())
    .map((section, index) => ({
      name: section.name!.trim(),
      order:
        typeof section.order === "number" && Number.isFinite(section.order)
          ? section.order
          : index + 1
    }))
    .sort((left, right) => left.order - right.order);

  return cleaned.length > 0 ? cleaned : DEFAULT_PROPOSAL_SECTIONS;
}

export function requireWorkspacePath(context: SkillContext): string {
  if (!context.workspacePath) {
    throw new ValidationError("SkillContext.workspacePath is required.");
  }

  return context.workspacePath;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function buildCoverageFeatures(text: string): CoverageFeatures {
  const rawKeywords = extractKeywords(text);
  const canonicalTokenSequence = rawKeywords
    .map((keyword) => canonicalizeCoverageToken(keyword))
    .filter((token) => token.length >= 3);
  const dedupedCanonicalTokens = Array.from(new Set(canonicalTokenSequence));
  const canonicalPhrases = Array.from(
    new Set(buildCanonicalPhrases(canonicalTokenSequence)),
  );

  return {
    rawKeywords,
    canonicalTokens: dedupedCanonicalTokens,
    canonicalTokenSet: new Set(dedupedCanonicalTokens),
    canonicalPhrases,
    canonicalPhraseSet: new Set(canonicalPhrases)
  };
}

function rankSectionCoverage(
  requirement: CoverageFeatures,
  sectionContent: string,
): CoverageMatch | undefined {
  const chunks = splitCoverageChunks(sectionContent);
  const matches = chunks
    .map((chunk) => scoreCoverageChunk(requirement, buildCoverageFeatures(chunk)))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score);

  return matches[0];
}

function splitCoverageChunks(content: string): string[] {
  const paragraphs = content
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length > 0) {
    return paragraphs;
  }

  const sentences = content
    .split(/(?<=[.!?])\s+/g)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  return sentences.length > 0 ? sentences : [content.trim()].filter(Boolean);
}

type CoverageMatch = {
  score: number;
  matchedCanonicalTokens: string[];
  matchedCanonicalPhrases: string[];
  matchedConceptTokens: string[];
};

function scoreCoverageChunk(
  requirement: CoverageFeatures,
  chunk: CoverageFeatures,
): CoverageMatch {
  const matchedCanonicalTokens = requirement.canonicalTokens.filter((token) =>
    chunk.canonicalTokenSet.has(token),
  );
  const matchedCanonicalPhrases = requirement.canonicalPhrases.filter((phrase) =>
    chunk.canonicalPhraseSet.has(phrase),
  );
  const matchedConceptTokens = matchedCanonicalTokens.filter((token) =>
    COVERAGE_CONCEPT_TOKENS.has(token),
  );
  const tokenRecall =
    requirement.canonicalTokens.length > 0
      ? matchedCanonicalTokens.length / requirement.canonicalTokens.length
      : 0;
  const phraseRecall =
    requirement.canonicalPhrases.length > 0
      ? matchedCanonicalPhrases.length / requirement.canonicalPhrases.length
      : 0;
  const score =
    matchedCanonicalTokens.length * 1.4 +
    matchedCanonicalPhrases.length * 2.8 +
    matchedConceptTokens.length * 2.2 +
    tokenRecall * 2 +
    phraseRecall * 1.5;

  return {
    score,
    matchedCanonicalTokens,
    matchedCanonicalPhrases,
    matchedConceptTokens
  };
}

function meetsCoverageThreshold(
  requirement: CoverageFeatures,
  match: CoverageMatch,
): boolean {
  if (match.matchedCanonicalPhrases.length > 0) {
    return true;
  }

  if (match.matchedConceptTokens.length >= 3 && match.score >= 6) {
    return true;
  }

  if (match.matchedConceptTokens.length >= 2 && match.score >= 5) {
    return true;
  }

  const requirementTokenCount = requirement.canonicalTokens.length;

  if (requirementTokenCount <= 2) {
    return match.matchedCanonicalTokens.length >= requirementTokenCount;
  }

  if (requirementTokenCount <= 4) {
    return match.matchedCanonicalTokens.length >= 2;
  }

  const minimumTokenMatches = Math.max(2, Math.ceil(requirementTokenCount * 0.45));
  return match.matchedCanonicalTokens.length >= minimumTokenMatches && match.score >= 5;
}

function buildMatchedKeywords(
  requirement: CoverageFeatures,
  match: CoverageMatch,
): string[] {
  const tokenMatches = requirement.rawKeywords.filter((keyword) =>
    match.matchedCanonicalTokens.includes(canonicalizeCoverageToken(keyword)),
  );
  const phraseMatches = match.matchedCanonicalPhrases.flatMap((phrase) =>
    phrase.split(" ").filter((token) => token.length >= 4),
  );

  return Array.from(new Set([...tokenMatches, ...phraseMatches]));
}

function buildCanonicalPhrases(tokens: string[]): string[] {
  const phrases: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    for (let size = 2; size <= 3; size += 1) {
      const slice = tokens.slice(index, index + size);

      if (slice.length === size) {
        phrases.push(slice.join(" "));
      }
    }
  }

  return phrases;
}

function canonicalizeCoverageToken(token: string): string {
  const lowered = token.toLowerCase();
  const directAlias = COVERAGE_ALIAS_MAP.get(lowered);

  if (directAlias) {
    return directAlias;
  }

  const stemmed = stemCoverageToken(lowered);
  return COVERAGE_ALIAS_MAP.get(stemmed) ?? stemmed;
}

function stemCoverageToken(token: string): string {
  if (token.length <= 4) {
    return token;
  }

  if (token.endsWith("ies") && token.length > 5) {
    return `${token.slice(0, -3)}y`;
  }

  if (token.endsWith("ing") && token.length > 6) {
    return token.slice(0, -3);
  }

  if (token.endsWith("ed") && token.length > 5) {
    return token.slice(0, -2);
  }

  if (token.endsWith("es") && token.length > 5) {
    return token.slice(0, -2);
  }

  if (token.endsWith("s") && token.length > 4) {
    return token.slice(0, -1);
  }

  return token;
}

function humanizeSectionFileName(fileName: string): string {
  return fileName
    .replace(/\.md$/i, "")
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();

  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/\s*```$/, "");
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
