import { createOptionsHandler, createRouteHandler } from "./_shared.ts";
import { POST as handleSlackPost } from "../openclaw/examples/slack-handler.ts";

export const runtime = "nodejs";
const pathname = "/api/slack";
const allowedMethods = ["POST"];

export async function POST(request: Request): Promise<Response> {
  return await handleSlackPost(request);
}

export const OPTIONS = createOptionsHandler(allowedMethods);

export default createRouteHandler(pathname, {
  POST,
  OPTIONS
});
