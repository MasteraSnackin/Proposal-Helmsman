import { routeProposalApi, runtime } from "./_shared.ts";

export { runtime };

export async function GET(request: Request): Promise<Response> {
  return await routeProposalApi(request, "/api/audio");
}

export async function POST(request: Request): Promise<Response> {
  return await routeProposalApi(request, "/api/audio");
}

export default {
  GET,
  POST
};
