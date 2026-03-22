import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MethodNotAllowedError,
  NotFoundError,
  ValidationError,
  toApplicationError,
  toErrorPayload
} from "../openclaw/runtime/errors.ts";
import { getElevenLabsClientInfo } from "../openclaw/runtime/elevenlabs-client.ts";
import { getModelClientInfo } from "../openclaw/runtime/model-client.ts";
import { createNoopLlm } from "../openclaw/runtime/noop-llm.ts";
import type { SkillContext } from "../openclaw/runtime/types.ts";
import { invokeProposalOperator } from "../openclaw/runtime/proposal-operator.ts";
import generateAudioBriefing from "../openclaw/skills/proposal-operator/generate_audio_briefing.ts";
import workspaceStatus from "../openclaw/skills/proposal-operator/workspace_status.ts";
import {
  audioAbsolutePath,
  ensureWorkspace,
  listAudioArtifacts,
  readTextIfExists,
  readRfpDocument,
  resolveWorkspacePath,
  workspaceFilePath
} from "../openclaw/skills/proposal-operator/shared.ts";
import { resolveWorkspaceStorageConfig, type WorkspaceStorageConfig } from "./storage-config.ts";

export type ProposalApiOptions = {
  workspaceRoot?: string;
  sampleRfpPath?: string;
};

export type ProposalApiDispatchInput = {
  method?: string;
  url?: string | URL;
  bodyText?: string;
};

export type WorkspaceCard = {
  id: string;
  summary: string;
  hasRfp: boolean;
  proposalExists: boolean;
  requirementCount: number;
  coveredMustHave: number;
  totalMustHave: number;
  updatedAt?: string;
};

export type WorkspacePayload = {
  workspaceId: string;
  summary: string;
  hasRfp: boolean;
  proposalExists: boolean;
  proposalContent: string;
  requirements: Array<{
    id: string;
    text: string;
    must_have: boolean;
    covered: boolean;
    evidence?: Array<{
      section: string;
      file: string;
      matched_keywords: string[];
    }>;
  }>;
  coverage: {
    requirementCount: number;
    coveredCount: number;
    mustHaveTotal: number;
    mustHaveCovered: number;
  };
  sections: Array<{
    name: string;
    file: string;
    exists: boolean;
    content: string;
  }>;
  audioArtifacts: Array<{
    file: string;
    contentType: string;
    source: "summary" | "proposal" | "section";
    sectionName?: string;
    provider: "live" | "mock";
    voiceId: string;
    modelId: string;
    outputFormat: string;
    characters: number;
    generatedAt: string;
  }>;
  updatedAt?: string;
};

type ResolvedProposalApiPaths = {
  workspaceRoot: string;
  sampleRfpPath: string;
  storage: WorkspaceStorageConfig;
};
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..");
const defaultSampleRfpPath = path.join(
  projectRoot,
  "openclaw",
  "examples",
  "demo",
  "sample-rfp.txt",
);

export async function handleProposalApiRequest(
  request: Request,
  options: ProposalApiOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const bodyText = shouldReadRequestBody(request.method) ? await request.text() : "";

  return dispatchProposalApiRequest(
    {
      method: request.method,
      url,
      bodyText
    },
    options,
  );
}

export async function handleProposalApiPathRequest(
  request: Request,
  pathname: string,
  options: ProposalApiOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;

  return dispatchProposalApiRequest(
    {
      method: request.method,
      url,
      bodyText: shouldReadRequestBody(request.method) ? await request.text() : ""
    },
    options,
  );
}

export async function dispatchProposalApiRequest(
  input: ProposalApiDispatchInput,
  options: ProposalApiOptions = {},
): Promise<Response> {
  const paths = resolveProposalApiPaths(options);
  await mkdir(paths.workspaceRoot, { recursive: true });

  try {
    const method = input.method ?? "GET";
    const url = normalizeUrl(input.url);
    const body = shouldReadRequestBody(method) ? parseJsonObjectString(input.bodyText ?? "") : {};
    return await processProposalApiRoute(method, url, body, paths);
  } catch (error) {
    const applicationError = toApplicationError(error);
    return jsonResponse(applicationError.statusCode, toErrorPayload(applicationError));
  }
}

async function processProposalApiRoute(
  method: string,
  url: URL,
  body: Record<string, unknown>,
  paths: ResolvedProposalApiPaths,
): Promise<Response> {
  const allowedMethods = allowedMethodsForPath(url.pathname);

  if (!allowedMethods) {
    throw new NotFoundError("API route not found.", {
      path: url.pathname
    });
  }

  if (!allowedMethods.includes(method)) {
    throw new MethodNotAllowedError(method, {
      path: url.pathname,
      allowedMethods
    });
  }

  if (url.pathname === "/api/health") {
    return jsonResponse(200, {
      ok: true,
      model: getModelClientInfo(),
      storage: {
        mode: paths.storage.mode,
        durable: paths.storage.durable,
        workspaceRoot: paths.storage.workspaceRoot,
        source: paths.storage.source,
        ...(paths.storage.modalVolumePath
          ? { modalVolumePath: paths.storage.modalVolumePath }
          : {})
      },
      civic: {
        mockMode:
          process.env.CIVIC_MOCK_MODE === "true" ||
          !process.env.CIVIC_GUARD_URL ||
          !process.env.CIVIC_API_KEY,
        configured: Boolean(process.env.CIVIC_GUARD_URL && process.env.CIVIC_API_KEY)
      },
      audio: getElevenLabsClientInfo()
    });
  }

  if (url.pathname === "/api/sample-rfp") {
    const rfpText = await readFile(paths.sampleRfpPath, "utf8");
    return jsonResponse(200, { rfpText });
  }

  if (method === "GET" && url.pathname === "/api/workspaces") {
    return jsonResponse(200, {
      workspaces: await listWorkspaces(paths.workspaceRoot)
    });
  }

  if (method === "POST" && url.pathname === "/api/workspaces") {
    const label =
      typeof body.workspaceLabel === "string" && body.workspaceLabel.trim()
        ? body.workspaceLabel.trim()
        : undefined;
    const workspaceId = label ? createWorkspaceId(label) : createWorkspaceId();
    const workspacePath = getWorkspacePath(paths.workspaceRoot, workspaceId);
    await ensureWorkspace(workspacePath);

    return jsonResponse(201, {
      workspaceId,
      workspace: await getWorkspacePayload(paths.workspaceRoot, workspaceId)
    });
  }

  if (url.pathname === "/api/reset") {
    const workspaceId = requireWorkspaceId(body.workspaceId);
    const workspacePath = getWorkspacePath(paths.workspaceRoot, workspaceId);

    await rm(workspacePath, { recursive: true, force: true });
    await ensureWorkspace(workspacePath);

    return jsonResponse(200, {
      status: "ok",
      workspaceId,
      workspace: await getWorkspacePayload(paths.workspaceRoot, workspaceId)
    });
  }

  if (url.pathname === "/api/status") {
    const workspaceId = requireWorkspaceId(url.searchParams.get("workspaceId"));
    return jsonResponse(200, {
      workspace: await getWorkspacePayload(paths.workspaceRoot, workspaceId)
    });
  }

  if (url.pathname === "/api/proposal") {
    const workspaceId = requireWorkspaceId(url.searchParams.get("workspaceId"));
    const workspace = await getWorkspacePayload(paths.workspaceRoot, workspaceId);

    if (!workspace.proposalContent.trim()) {
      throw new NotFoundError("Export a proposal before downloading it.", {
        workspaceId
      });
    }

    return textResponse(200, workspace.proposalContent, "text/markdown; charset=utf-8", {
      "content-disposition": `attachment; filename="${workspaceId}-proposal.md"`
    });
  }

  if (method === "GET" && url.pathname === "/api/audio") {
    const workspaceId = requireWorkspaceId(url.searchParams.get("workspaceId"));
    const workspacePath = getWorkspacePath(paths.workspaceRoot, workspaceId);
    const artifact = await resolveAudioArtifact(
      workspacePath,
      typeof url.searchParams.get("file") === "string"
        ? url.searchParams.get("file") ?? undefined
        : undefined,
    );
    const audioBody = await readFile(audioAbsolutePath(workspacePath, artifact.file));

    return binaryResponse(200, audioBody, artifact.contentType, {
      "content-disposition": `attachment; filename="${path.basename(artifact.file)}"`
    });
  }

  if (url.pathname === "/api/message") {
    const workspaceId = requireWorkspaceId(body.workspaceId);

    if (typeof body.message !== "string" || !body.message.trim()) {
      throw new ValidationError("`message` is required.");
    }

    const workspacePath = getWorkspacePath(paths.workspaceRoot, workspaceId);
    const agentResult = await invokeProposalOperator({
      workspacePath,
      message: body.message
    });

    return jsonResponse(200, {
      agentResult,
      workspace: await getWorkspacePayload(paths.workspaceRoot, workspaceId),
      workspaces: await listWorkspaces(paths.workspaceRoot)
    });
  }

  if (method === "POST" && url.pathname === "/api/audio") {
    const workspaceId = requireWorkspaceId(body.workspaceId);
    const workspacePath = getWorkspacePath(paths.workspaceRoot, workspaceId);
    const context: SkillContext = {
      workspacePath,
      llm: createNoopLlm("audio briefing generation")
    };
    const result = await generateAudioBriefing(
      {
        source: normalizeAudioSource(body.source),
        sectionName: typeof body.sectionName === "string" ? body.sectionName : undefined,
        voiceId: typeof body.voiceId === "string" ? body.voiceId : undefined,
        modelId: typeof body.modelId === "string" ? body.modelId : undefined,
        outputFormat: typeof body.outputFormat === "string" ? body.outputFormat : undefined
      },
      context,
    );

    return jsonResponse(200, {
      result,
      workspace: await getWorkspacePayload(paths.workspaceRoot, workspaceId)
    });
  }

  throw new NotFoundError("API route not found.", {
    path: url.pathname
  });
}

function allowedMethodsForPath(pathname: string): string[] | undefined {
  switch (pathname) {
    case "/api/health":
    case "/api/sample-rfp":
    case "/api/status":
    case "/api/proposal":
      return ["GET"];
    case "/api/message":
    case "/api/reset":
      return ["POST"];
    case "/api/workspaces":
    case "/api/audio":
      return ["GET", "POST"];
    default:
      return undefined;
  }
}

export async function listWorkspaces(workspaceRoot: string): Promise<WorkspaceCard[]> {
  await mkdir(workspaceRoot, { recursive: true });

  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const workspaceIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  return Promise.all(
    workspaceIds.map(async (workspaceId) => {
      return await getWorkspaceCard(workspaceRoot, workspaceId);
    }),
  );
}

export async function getWorkspacePayload(
  workspaceRoot: string,
  workspaceId: string,
): Promise<WorkspacePayload> {
  const workspacePath = getWorkspacePath(workspaceRoot, workspaceId);
  await ensureWorkspace(workspacePath);

  const context: SkillContext = {
    workspacePath,
    llm: createNoopLlm("workspace payload generation")
  };
  const snapshot = await workspaceStatus({}, context);

  const sections = await Promise.all(
    snapshot.sections.map(async (section) => ({
      ...section,
      content: section.exists
        ? (await readTextIfExists(resolveWorkspacePath(workspacePath, section.file))) ?? ""
        : ""
    })),
  );

  const requirementCount = snapshot.requirements.length;
  const coveredCount = snapshot.requirements.filter((item) => item.covered).length;
  const mustHaveRequirements = snapshot.requirements.filter((item) => item.must_have);
  const proposalContent =
    (await readTextIfExists(workspaceFilePath(workspacePath, "proposal.md"))) ?? "";
  const audioArtifacts = await listAudioArtifacts(workspacePath);
  const workspaceStat = await stat(workspacePath);

  return {
    workspaceId,
    summary: snapshot.summary,
    hasRfp: Boolean(snapshot.summary || snapshot.requirements.length > 0),
    proposalExists: snapshot.proposalExists,
    proposalContent,
    requirements: snapshot.requirements,
    coverage: {
      requirementCount,
      coveredCount,
      mustHaveTotal: mustHaveRequirements.length,
      mustHaveCovered: mustHaveRequirements.filter((item) => item.covered).length
    },
    sections,
    audioArtifacts,
    updatedAt: workspaceStat.mtime.toISOString()
  };
}

async function getWorkspaceCard(
  workspaceRoot: string,
  workspaceId: string,
): Promise<WorkspaceCard> {
  const workspacePath = getWorkspacePath(workspaceRoot, workspaceId);
  await ensureWorkspace(workspacePath);

  const [rfp, workspaceStat, proposalExists] = await Promise.all([
    readRfpDocument(workspacePath),
    stat(workspacePath),
    hasWorkspaceProposal(workspacePath)
  ]);

  const requirements = rfp?.requirements ?? [];
  const mustHaveRequirements = requirements.filter((item) => item.must_have);

  return {
    id: workspaceId,
    summary: rfp?.summary ?? "",
    hasRfp: Boolean((rfp?.summary ?? "").trim() || requirements.length > 0),
    proposalExists,
    requirementCount: requirements.length,
    coveredMustHave: mustHaveRequirements.filter((item) => item.covered).length,
    totalMustHave: mustHaveRequirements.length,
    updatedAt: workspaceStat.mtime.toISOString()
  };
}

function normalizeUrl(input: string | URL | undefined): URL {
  if (input instanceof URL) {
    return input;
  }

  return new URL(input ?? "/", "http://localhost");
}

function shouldReadRequestBody(method: string | undefined): boolean {
  return (method ?? "GET") !== "GET" && (method ?? "GET") !== "HEAD";
}

function parseJsonObjectString(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();

  if (!trimmed) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new ValidationError("Request body must be valid JSON.", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("Expected a JSON object body.");
  }

  return parsed as Record<string, unknown>;
}

function jsonResponse(statusCode: number, payload: unknown): Response {
  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    status: statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function textResponse(
  statusCode: number,
  body: string,
  contentType: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status: statusCode,
    headers: {
      "content-type": contentType,
      ...headers
    }
  });
}

function binaryResponse(
  statusCode: number,
  body: Uint8Array,
  contentType: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(Buffer.from(body), {
    status: statusCode,
    headers: {
      "content-type": contentType,
      ...headers
    }
  });
}

function requireWorkspaceId(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new ValidationError("`workspaceId` is required.");
  }

  return sanitizeWorkspaceId(input);
}

function getWorkspacePath(workspaceRoot: string, workspaceId: string): string {
  return path.join(workspaceRoot, sanitizeWorkspaceId(workspaceId));
}

async function hasWorkspaceProposal(workspacePath: string): Promise<boolean> {
  try {
    const proposalStat = await stat(workspaceFilePath(workspacePath, "proposal.md"));
    return proposalStat.isFile();
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }

    throw error;
  }
}

function sanitizeWorkspaceId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  if (!sanitized) {
    throw new ValidationError("Workspace id is empty after sanitization.");
  }

  return sanitized;
}

function createWorkspaceId(label = "proposal-thread"): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  const suffix = new Date().toISOString().replace(/[:.]/g, "-").toLowerCase();
  return sanitizeWorkspaceId(`${slug || "proposal-thread"}-${suffix}`);
}

function resolveProposalApiPaths(options: ProposalApiOptions): ResolvedProposalApiPaths {
  const storage = resolveWorkspaceStorageConfig({
    workspaceRoot: options.workspaceRoot
  });

  return {
    workspaceRoot: storage.workspaceRoot,
    sampleRfpPath: options.sampleRfpPath ?? defaultSampleRfpPath,
    storage
  };
}

function normalizeAudioSource(value: unknown): "summary" | "proposal" | "section" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "summary" || normalized === "proposal" || normalized === "section") {
    return normalized;
  }

  throw new ValidationError("`source` must be `summary`, `proposal`, or `section`.");
}

async function resolveAudioArtifact(
  workspacePath: string,
  requestedFile: string | undefined,
): Promise<{
  file: string;
  contentType: string;
}> {
  const audioArtifacts = await listAudioArtifacts(workspacePath);

  if (audioArtifacts.length === 0) {
    throw new NotFoundError("Generate an audio briefing before downloading it.");
  }

  if (!requestedFile?.trim()) {
    return {
      file: path.basename(audioArtifacts[0].file),
      contentType: audioArtifacts[0].contentType
    };
  }

  const matchedArtifact = audioArtifacts.find(
    (artifact) => path.basename(artifact.file) === path.basename(requestedFile),
  );

  if (!matchedArtifact) {
    throw new NotFoundError("Requested audio file was not found.", {
      file: requestedFile
    });
  }

  return {
    file: path.basename(matchedArtifact.file),
    contentType: matchedArtifact.contentType
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
