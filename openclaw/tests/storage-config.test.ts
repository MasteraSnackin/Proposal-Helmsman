import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveWorkspaceStorageConfig } from "../../backend/storage-config.ts";

test("workspace storage config defaults to local storage", () => {
  const previousRoot = process.env.PROPOSAL_WORKSPACE_ROOT;
  const previousMode = process.env.PROPOSAL_STORAGE_MODE;
  const previousModalPath = process.env.MODAL_VOLUME_PATH;

  try {
    delete process.env.PROPOSAL_WORKSPACE_ROOT;
    delete process.env.PROPOSAL_STORAGE_MODE;
    delete process.env.MODAL_VOLUME_PATH;

    const storage = resolveWorkspaceStorageConfig();
    assert.equal(storage.mode, "local");
    assert.equal(storage.durable, false);
    assert.match(storage.workspaceRoot, /workspaces\/proposals$/);
  } finally {
    restoreEnv("PROPOSAL_WORKSPACE_ROOT", previousRoot);
    restoreEnv("PROPOSAL_STORAGE_MODE", previousMode);
    restoreEnv("MODAL_VOLUME_PATH", previousModalPath);
  }
});

test("workspace storage config switches to modal volume when configured", async () => {
  const modalRoot = await mkdtemp(path.join(tmpdir(), "proposal-helmsman-modal-"));
  const previousRoot = process.env.PROPOSAL_WORKSPACE_ROOT;
  const previousMode = process.env.PROPOSAL_STORAGE_MODE;
  const previousModalPath = process.env.MODAL_VOLUME_PATH;

  try {
    delete process.env.PROPOSAL_WORKSPACE_ROOT;
    process.env.PROPOSAL_STORAGE_MODE = "modal";
    process.env.MODAL_VOLUME_PATH = modalRoot;

    const storage = resolveWorkspaceStorageConfig();
    assert.equal(storage.mode, "modal");
    assert.equal(storage.durable, true);
    assert.equal(storage.modalVolumePath, modalRoot);
    assert.equal(storage.workspaceRoot, path.join(modalRoot, "workspaces", "proposals"));
  } finally {
    restoreEnv("PROPOSAL_WORKSPACE_ROOT", previousRoot);
    restoreEnv("PROPOSAL_STORAGE_MODE", previousMode);
    restoreEnv("MODAL_VOLUME_PATH", previousModalPath);
    await rm(modalRoot, { recursive: true, force: true });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
