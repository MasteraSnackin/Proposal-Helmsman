import {
  createOptionsHandler,
  createRouteHandler,
  routeProposalApi,
  runtime
} from "./_shared.ts";

export { runtime };
const pathname = "/api/status";
const allowedMethods = ["GET"];

export async function GET(request: Request): Promise<Response> {
  return await routeProposalApi(request, pathname);
}

export const OPTIONS = createOptionsHandler(allowedMethods);

export default createRouteHandler(pathname, {
  GET,
  OPTIONS
});
