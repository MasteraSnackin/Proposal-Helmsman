import {
  createOptionsHandler,
  createRouteHandler,
  routeProposalApi,
  runtime
} from "./_shared.ts";

export { runtime };
const pathname = "/api/workspaces";
const allowedMethods = ["GET", "POST"];

export async function GET(request: Request): Promise<Response> {
  return await routeProposalApi(request, pathname);
}

export async function POST(request: Request): Promise<Response> {
  return await routeProposalApi(request, pathname);
}

export const OPTIONS = createOptionsHandler(allowedMethods);

export default createRouteHandler(pathname, {
  GET,
  POST,
  OPTIONS
});
