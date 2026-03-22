import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dispatchProposalApiRequest } from "../../backend/proposal-api.ts";
import { resolveWorkspaceStorageConfig } from "../../backend/storage-config.ts";
import {
  ForbiddenError,
  MethodNotAllowedError,
  NotFoundError,
  toApplicationError,
  toErrorPayload
} from "./errors.ts";

type DevServerOptions = {
  host?: string;
  port?: number;
  publicRoot?: string;
  workspaceRoot?: string;
};

export type RunningDevServer = {
  url: string;
  close(): Promise<void>;
};

export type DevRequest = {
  method?: string;
  url?: string;
  body?: Record<string, unknown> | string;
};

export type DevResponse = {
  statusCode: number;
  contentType: string;
  body: string | Buffer;
  headers?: Record<string, string>;
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..", "..");
const defaultPublicRoot = path.join(projectRoot, "web");

export async function startDevServer(
  options: DevServerOptions = {},
): Promise<RunningDevServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 3000;
  const resolvedPaths = resolvePaths(options);

  await mkdir(resolvedPaths.workspaceRoot, { recursive: true });

  const server = createServer((request, response) => {
    void handleRequest(request, response, resolvedPaths);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolve());
  });

  const address = server.address();
  const activePort =
    typeof address === "object" && address !== null ? address.port : requestedPort;

  return {
    url: `http://${host}:${activePort}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
}

export async function dispatchDevRequest(
  request: DevRequest,
  options: DevServerOptions = {},
): Promise<DevResponse> {
  const paths = resolvePaths(options);
  await mkdir(paths.workspaceRoot, { recursive: true });

  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");

    if (isApiPath(url.pathname)) {
      return await toDevResponse(
        await dispatchProposalApiRequest(
          {
            method,
            url,
            bodyText: normalizeDevRequestBodyText(request.body)
          },
          {
            workspaceRoot: paths.workspaceRoot
          },
        ),
      );
    }

    if (method === "GET") {
      return await serveStaticAsset(url.pathname, paths.publicRoot);
    }

    return jsonResponse(
      405,
      toErrorPayload(
        new MethodNotAllowedError(method, {
          path: url.pathname,
          allowedMethods: ["GET"]
        }),
      ),
    );
  } catch (error) {
    const applicationError = toApplicationError(error);
    return jsonResponse(applicationError.statusCode, toErrorPayload(applicationError));
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  paths: {
    publicRoot: string;
    workspaceRoot: string;
  },
): Promise<void> {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");

    if (isApiPath(url.pathname)) {
      const apiResponse = await dispatchProposalApiRequest(
        {
          method,
          url,
          bodyText: shouldReadRequestBody(method) ? await readRequestBodyText(request) : ""
        },
        {
          workspaceRoot: paths.workspaceRoot
        },
      );
      await sendWebResponse(response, apiResponse);
      return;
    }

    if (method === "GET") {
      const staticResponse = await serveStaticAsset(url.pathname, paths.publicRoot);
      sendDevResponse(response, staticResponse);
      return;
    }

    sendDevResponse(
      response,
      jsonResponse(
        405,
        toErrorPayload(
          new MethodNotAllowedError(method, {
            path: url.pathname,
            allowedMethods: ["GET"]
          }),
        ),
      ),
    );
  } catch (error) {
    const applicationError = toApplicationError(error);

    if (applicationError.statusCode >= 500) {
      console.error("[dev-server]", applicationError);
    }

    sendDevResponse(
      response,
      jsonResponse(applicationError.statusCode, toErrorPayload(applicationError)),
    );
  }
}

async function readRequestBodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function shouldReadRequestBody(method: string | undefined): boolean {
  return (method ?? "GET") !== "GET" && (method ?? "GET") !== "HEAD";
}

function normalizeDevRequestBodyText(
  body: Record<string, unknown> | string | undefined,
): string {
  if (body === undefined) {
    return "";
  }

  return typeof body === "string" ? body : JSON.stringify(body);
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

async function sendWebResponse(
  response: ServerResponse,
  webResponse: Response,
): Promise<void> {
  const bodyBuffer = Buffer.from(await webResponse.arrayBuffer());
  const headers = headersToRecord(webResponse.headers);
  sendDevResponse(response, {
    statusCode: webResponse.status,
    contentType: headers["content-type"] ?? "application/octet-stream",
    body: bodyBuffer,
    headers
  });
}

function sendDevResponse(response: ServerResponse, result: DevResponse): void {
  response.statusCode = result.statusCode;

  for (const [header, value] of Object.entries(result.headers ?? {})) {
    response.setHeader(header, value);
  }

  if (!response.hasHeader("content-type")) {
    response.setHeader("content-type", result.contentType);
  }

  response.end(result.body);
}

async function toDevResponse(webResponse: Response): Promise<DevResponse> {
  const body = Buffer.from(await webResponse.arrayBuffer());
  const headers = headersToRecord(webResponse.headers);

  return {
    statusCode: webResponse.status,
    contentType: headers["content-type"] ?? "application/octet-stream",
    body,
    headers
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const entries: Record<string, string> = {};
  headers.forEach((value, key) => {
    entries[key] = value;
  });
  return entries;
}

async function serveStaticAsset(
  pathname: string,
  publicRoot: string,
): Promise<DevResponse> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(publicRoot, relativePath);

  if (
    filePath !== path.resolve(publicRoot) &&
    !filePath.startsWith(`${path.resolve(publicRoot)}${path.sep}`)
  ) {
    return jsonResponse(403, toErrorPayload(new ForbiddenError("Forbidden.", {
      path: pathname
    })));
  }

  try {
    const content = await readFile(filePath);
    return {
      statusCode: 200,
      contentType: contentTypeFor(filePath),
      body: content
    };
  } catch {
    return jsonResponse(404, toErrorPayload(new NotFoundError("Not found.", {
      path: pathname
    })));
  }
}

function jsonResponse(statusCode: number, payload: unknown): DevResponse {
  return {
    statusCode,
    contentType: "application/json; charset=utf-8",
    body: `${JSON.stringify(payload, null, 2)}\n`
  };
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }

  return "text/html; charset=utf-8";
}

function resolvePaths(options: DevServerOptions): {
  publicRoot: string;
  workspaceRoot: string;
} {
  const storage = resolveWorkspaceStorageConfig({
    workspaceRoot: options.workspaceRoot
  });

  return {
    publicRoot: options.publicRoot ?? defaultPublicRoot,
    workspaceRoot: storage.workspaceRoot
  };
}
