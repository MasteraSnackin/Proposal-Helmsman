import { routeProposalApi, runtime } from "./_shared.ts";

export { runtime };

export async function GET(request: Request): Promise<Response> {
  return await routeProposalApi(request, "/api/sample-rfp");
}

export default GET;
