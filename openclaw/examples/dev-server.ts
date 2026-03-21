import { startDevServer } from "../runtime/dev-server.ts";

async function main(): Promise<void> {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  const server = await startDevServer({
    port: Number.isFinite(port) ? port : 3000
  });

  process.stdout.write(`Proposal Helmsman UI running at ${server.url}\n`);

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exitCode = 0;
  };

  process.once("SIGINT", () => {
    void shutdown();
  });

  process.once("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
