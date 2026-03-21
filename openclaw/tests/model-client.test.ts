import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "../runtime/errors.ts";
import { createConfiguredLlm } from "../runtime/model-client.ts";

test("gemini client wraps upstream fetch failures as structured external errors", async () => {
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.OPENCLAW_MODEL_PROVIDER;
  const originalModel = process.env.OPENCLAW_MODEL;
  const originalApiKey = process.env.GEMINI_API_KEY;

  process.env.OPENCLAW_MODEL_PROVIDER = "google";
  process.env.OPENCLAW_MODEL = "gemini-2.5-flash";
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  try {
    const llm = createConfiguredLlm();

    await assert.rejects(
      () =>
        llm.generate({
          system: "Test system",
          prompt: "Test prompt"
        }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "EXTERNAL_SERVICE_ERROR" &&
        error.retryable === true &&
        /Gemini request could not be completed/i.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;

    if (originalProvider === undefined) {
      delete process.env.OPENCLAW_MODEL_PROVIDER;
    } else {
      process.env.OPENCLAW_MODEL_PROVIDER = originalProvider;
    }

    if (originalModel === undefined) {
      delete process.env.OPENCLAW_MODEL;
    } else {
      process.env.OPENCLAW_MODEL = originalModel;
    }

    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  }
});
