export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonObject = {
  [key: string]: JsonValue | undefined;
};

export type GenerateOutputOptions = {
  format: "json" | "text";
  schema?: unknown;
};

export type GenerateOptions = {
  system: string;
  prompt: string;
  output?: GenerateOutputOptions;
};

export interface LlmClient {
  generate<T = unknown>(
    options: GenerateOptions,
  ): Promise<
    | T
    | string
    | {
        json?: T;
        text?: string;
        content?: string;
        output_text?: string;
      }
  >;
}

export interface SkillContext {
  workspacePath: string;
  llm: LlmClient;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
