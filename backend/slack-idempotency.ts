import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type SlackEventReceipt = {
  eventId: string;
  receivedAt: string;
  workspaceId?: string;
  channelId?: string;
  threadId?: string;
};

export async function hasProcessedSlackEvent(
  workspaceRoot: string,
  eventId: string,
): Promise<boolean> {
  const receiptPath = slackEventReceiptPath(workspaceRoot, eventId);

  try {
    await readFile(receiptPath, "utf8");
    return true;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }

    throw error;
  }
}

export async function recordProcessedSlackEvent(
  workspaceRoot: string,
  receipt: SlackEventReceipt,
): Promise<void> {
  const receiptsDir = path.join(workspaceRoot, ".slack-events");
  await mkdir(receiptsDir, { recursive: true });

  await writeFile(
    slackEventReceiptPath(workspaceRoot, receipt.eventId),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
}

function slackEventReceiptPath(workspaceRoot: string, eventId: string): string {
  const digest = createHash("sha256").update(eventId).digest("hex");
  return path.join(workspaceRoot, ".slack-events", `${digest}.json`);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
