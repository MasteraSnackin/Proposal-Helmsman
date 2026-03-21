import { routeProposalApi, runtime } from "./_shared.ts";

export { runtime };

export async function GET(request: Request): Promise<Response> {
  return await routeProposalApi(request, "/api/workspaces");
}

export async function POST(request: Request): Promise<Response> {
  return await routeProposalApi(request, "/api/workspaces");
}

export default async function handler(request: Request): Promise<Response> {
  return await routeProposalApi(request, "/api/workspaces");
}
