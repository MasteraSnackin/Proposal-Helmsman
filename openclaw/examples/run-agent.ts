import path from "node:path";

import { getModelClientInfo } from "../runtime/model-client.ts";
import { invokeProposalOperator } from "../runtime/proposal-operator.ts";

async function main(): Promise<void> {
  const [workspaceArg, ...messageParts] = process.argv.slice(2);

  if (!workspaceArg || messageParts.length === 0) {
    throw new Error(
      "Usage: npm run agent -- <workspace_path> <message text>",
    );
  }

  const workspacePath = path.resolve(process.cwd(), workspaceArg);
  const message = messageParts.join(" ");
  const result = await invokeProposalOperator({
    message,
    workspacePath
  });

  process.stdout.write(
    `${JSON.stringify({ model: getModelClientInfo(), result }, null, 2)}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
