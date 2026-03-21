import { POST as handleSlackPost } from "../openclaw/examples/slack-handler.ts";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return await handleSlackPost(request);
}

export default POST;
