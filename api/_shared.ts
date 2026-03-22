import { handleProposalApiPathRequest } from "../backend/proposal-api.ts";
import { MethodNotAllowedError, toErrorPayload } from "../openclaw/runtime/errors.ts";

export const runtime = "nodejs";

type RouteHandler = (request: Request) => Promise<Response>;
type RouteHandlerMap = Partial<Record<"GET" | "POST" | "OPTIONS", RouteHandler>>;

export async function routeProposalApi(
  request: Request,
  pathname: string,
): Promise<Response> {
  return await handleProposalApiPathRequest(request, pathname);
}

export function createOptionsHandler(allowedMethods: string[]): RouteHandler {
  const allowHeader = buildAllowHeader(allowedMethods);

  return async function OPTIONS(): Promise<Response> {
    return new Response(null, {
      status: 204,
      headers: {
        allow: allowHeader
      }
    });
  };
}

export function createRouteHandler(
  pathname: string,
  handlers: RouteHandlerMap,
): RouteHandler {
  const allowedMethods = Object.keys(handlers).filter(
    (method): method is "GET" | "POST" => method === "GET" || method === "POST",
  );
  const allowHeader = buildAllowHeader(allowedMethods);

  return async function handler(request: Request): Promise<Response> {
    const method = request.method.toUpperCase() as keyof RouteHandlerMap;

    if (method === "OPTIONS") {
      const optionsHandler = handlers.OPTIONS ?? createOptionsHandler(allowedMethods);
      return await optionsHandler(request);
    }

    const methodHandler = handlers[method];

    if (methodHandler) {
      return await methodHandler(request);
    }

    return jsonResponse(
      405,
      toErrorPayload(
        new MethodNotAllowedError(request.method.toUpperCase(), {
          path: pathname,
          allowedMethods
        }),
      ),
      {
        allow: allowHeader
      },
    );
  };
}

function buildAllowHeader(allowedMethods: string[]): string {
  return [...new Set([...allowedMethods.map((method) => method.toUpperCase()), "OPTIONS"])].join(", ");
}

function jsonResponse(
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    status: statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}
