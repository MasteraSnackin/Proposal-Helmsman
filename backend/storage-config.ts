import path from "node:path";
import { fileURLToPath } from "node:url";

export type WorkspaceStorageMode = "local" | "modal";

export type WorkspaceStorageConfig = {
  mode: WorkspaceStorageMode;
  workspaceRoot: string;
  durable: boolean;
  source: "override" | "env" | "modal-env" | "default";
  modalVolumePath?: string;
};

type ResolveWorkspaceStorageOptions = {
  workspaceRoot?: string;
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..");
const defaultLocalWorkspaceRoot = path.join(projectRoot, "workspaces", "proposals");
const defaultModalVolumePath = "/vol/proposal-helmsman";

export function resolveWorkspaceStorageConfig(
  options: ResolveWorkspaceStorageOptions = {},
): WorkspaceStorageConfig {
  const explicitWorkspaceRoot = options.workspaceRoot?.trim();
  const envWorkspaceRoot = process.env.PROPOSAL_WORKSPACE_ROOT?.trim();
  const requestedMode = normalizeStorageMode(process.env.PROPOSAL_STORAGE_MODE);
  const modalVolumePath = resolveModalVolumePath();

  if (explicitWorkspaceRoot) {
    return buildStorageConfig(path.resolve(explicitWorkspaceRoot), requestedMode, modalVolumePath, "override");
  }

  if (envWorkspaceRoot) {
    return buildStorageConfig(path.resolve(envWorkspaceRoot), requestedMode, modalVolumePath, "env");
  }

  if (requestedMode === "modal" || modalVolumePath) {
    const resolvedVolumePath = modalVolumePath ?? defaultModalVolumePath;
    return {
      mode: "modal",
      workspaceRoot: path.join(resolvedVolumePath, "workspaces", "proposals"),
      durable: true,
      source: modalVolumePath ? "modal-env" : "default",
      modalVolumePath: resolvedVolumePath
    };
  }

  return {
    mode: "local",
    workspaceRoot: defaultLocalWorkspaceRoot,
    durable: false,
    source: "default"
  };
}

function buildStorageConfig(
  workspaceRoot: string,
  requestedMode: WorkspaceStorageMode | undefined,
  modalVolumePath: string | undefined,
  source: WorkspaceStorageConfig["source"],
): WorkspaceStorageConfig {
  const inferredModal =
    requestedMode === "modal" ||
    (modalVolumePath !== undefined &&
      isWithinPath(workspaceRoot, modalVolumePath));

  return {
    mode: inferredModal ? "modal" : "local",
    workspaceRoot,
    durable: inferredModal,
    source,
    ...(modalVolumePath ? { modalVolumePath } : {})
  };
}

function normalizeStorageMode(value: string | undefined): WorkspaceStorageMode | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "modal" ? "modal" : normalized === "local" ? "local" : undefined;
}

function resolveModalVolumePath(): string | undefined {
  const raw =
    process.env.MODAL_VOLUME_PATH?.trim() ||
    process.env.MODAL_WORKSPACE_VOLUME?.trim();

  return raw ? path.resolve(raw) : undefined;
}

function isWithinPath(targetPath: string, rootPath: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootPath);

  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  );
}
