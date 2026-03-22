import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

type AppHarness = {
  state: {
    workspaceId: string;
    optimistic: {
      sectionName: string;
      sectionContent: string;
      proposalContent: string;
    };
  };
  sendOperatorMessage: (message: string, options?: Record<string, unknown>) => Promise<unknown>;
  normalizeError: (error: unknown, fallback: string) => {
    noticeMessage: string;
    toastMessage: string;
    logMessage: string;
  };
  toRequestError: (status: number, payload: unknown) => Error;
  __setClearNotice: (fn: () => void) => void;
  __setLogActivity: (fn: (title: string, detail: string) => void) => void;
  __setRender: (fn: () => void) => void;
  __setSetBusy: (fn: (button?: unknown, busy?: boolean, options?: unknown) => void) => void;
  __setShowNotice: (fn: (message: string, kind?: string) => void) => void;
  __setSyncSectionSelection: (fn: () => void) => void;
  __setToast: (fn: (message: string, kind?: string) => void) => void;
};

test("operator request failures clear optimistic placeholders and rerender the UI", async () => {
  const app = await loadAppHarness();
  const notices: Array<{ message: string; kind: string }> = [];
  const toasts: Array<{ message: string; kind: string }> = [];
  const activity: Array<{ title: string; detail: string }> = [];
  let renderCount = 0;

  app.state.workspaceId = "debug-demo";
  app.state.optimistic.sectionName = "Executive Summary";
  app.state.optimistic.sectionContent = "Applying revision safely...";
  app.state.optimistic.proposalContent = "Assembling proposal draft...";

  app.__setClearNotice(() => {});
  app.__setSetBusy(() => {});
  app.__setSyncSectionSelection(() => {
    throw new Error("syncSectionSelection should not run on request failure");
  });
  app.__setShowNotice((message, kind = "info") => {
    notices.push({ message, kind });
  });
  app.__setToast((message, kind = "success") => {
    toasts.push({ message, kind });
  });
  app.__setLogActivity((title, detail) => {
    activity.push({ title, detail });
  });
  app.__setRender(() => {
    renderCount += 1;
  });

  const result = await app.sendOperatorMessage("/export", {
    button: {
      dataset: {},
      textContent: "Export",
      disabled: false,
      setAttribute() {},
    }
  });

  assert.equal(result, undefined);
  assert.equal(app.state.optimistic.sectionName, "");
  assert.equal(app.state.optimistic.sectionContent, "");
  assert.equal(app.state.optimistic.proposalContent, "");
  assert.equal(renderCount, 1);
  assert.deepEqual(notices, [
    {
      message: "Network request failed. You can try again.",
      kind: "error"
    }
  ]);
  assert.deepEqual(toasts, [
    {
      message: "Network request failed. You can try again.",
      kind: "error"
    }
  ]);
  assert.deepEqual(activity, [
    {
      title: "Operator error",
      detail: "Network request failed. [NETWORK_ERROR]"
    }
  ]);
});

test("request error normalization preserves structured debugging details", async () => {
  const app = await loadAppHarness();
  const error = app.toRequestError(405, {
    error: "Method not allowed: PATCH",
    code: "METHOD_NOT_ALLOWED",
    details: {
      method: "PATCH",
      allowedMethods: ["GET"],
      path: "/api/health"
    }
  });

  const normalized = app.normalizeError(error, "Fallback error");

  assert.equal(normalized.noticeMessage, "Method not allowed: PATCH");
  assert.equal(normalized.toastMessage, "Method not allowed: PATCH");
  assert.equal(
    normalized.logMessage,
    "Method not allowed: PATCH [METHOD_NOT_ALLOWED] method=PATCH allowed=GET path=/api/health",
  );
});

async function loadAppHarness(): Promise<AppHarness> {
  const sourcePath = path.resolve(process.cwd(), "web/app.js");
  const source = await readFile(sourcePath, "utf8");
  const context = createAppContext();

  vm.runInNewContext(
    `${source}
globalThis.__testExports = {
  state,
  sendOperatorMessage,
  normalizeError,
  toRequestError,
  __setClearNotice(fn) { clearNotice = fn; },
  __setLogActivity(fn) { logActivity = fn; },
  __setRender(fn) { render = fn; },
  __setSetBusy(fn) { setBusy = fn; },
  __setShowNotice(fn) { showNotice = fn; },
  __setSyncSectionSelection(fn) { syncSectionSelection = fn; },
  __setToast(fn) { toast = fn; }
};`,
    context,
    {
      filename: sourcePath
    },
  );

  return (context as unknown as { __testExports: AppHarness }).__testExports;
}

function createAppContext() {
  const localStorage = {
    getItem() {
      return "";
    },
    setItem() {},
    removeItem() {}
  };

  const document = {
    activeElement: null,
    addEventListener() {},
    createElement() {
      return {
        className: "",
        textContent: "",
        setAttribute() {},
        remove() {}
      };
    },
    getElementById() {
      return null;
    }
  };

  const windowObject = {
    localStorage,
    fetch: async () => {
      throw new Error("offline");
    },
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    URL: {
      createObjectURL() {
        return "blob:stub";
      },
      revokeObjectURL() {}
    }
  };

  const context: Record<string, unknown> = {
    console,
    document,
    HTMLElement: class HTMLElement {},
    window: windowObject
  };

  context.globalThis = context;
  return context;
}
