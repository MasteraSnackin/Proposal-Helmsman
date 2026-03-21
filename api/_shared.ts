import { handleProposalApiPathRequest } from "../backend/proposal-api.ts";

export const runtime = "nodejs";

// TODO: Adapt this export shape if your deployment target expects a different serverless signature.
export async function routeProposalApi(
  request: Request,
  pathname: string,
): Promise<Response> {
  return await handleProposalApiPathRequest(request, pathname);
}
