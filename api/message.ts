import { routeProposalApi, runtime } from "./_shared.ts";

export { runtime };

export async function POST(request: Request): Promise<Response> {
  return await routeProposalApi(request, "/api/message");
}

export default POST;
