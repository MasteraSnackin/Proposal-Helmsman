import {
  createOptionsHandler,
  createRouteHandler,
  routeProposalApi,
  runtime
} from "./_shared.ts";

export { runtime };
const pathname = "/api/message";
const allowedMethods = ["POST"];

export async function POST(request: Request): Promise<Response> {
  return await routeProposalApi(request, pathname);
}

export const OPTIONS = createOptionsHandler(allowedMethods);

export default createRouteHandler(pathname, {
  POST,
  OPTIONS
});
