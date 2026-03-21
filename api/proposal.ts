import { routeProposalApi, runtime } from "./_shared.ts";

export { runtime };

export async function GET(request: Request): Promise<Response> {
  return await routeProposalApi(request, "/api/proposal");
}

export default GET;
