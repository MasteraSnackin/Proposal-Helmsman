import { ConfigurationError } from "./errors.ts";
import type { LlmClient } from "./types.ts";

export function createNoopLlm(label = "metadata-only path"): LlmClient {
  return {
    async generate(): Promise<never> {
      throw new ConfigurationError(`LLM generate() was called unexpectedly in ${label}.`);
    }
  };
}
