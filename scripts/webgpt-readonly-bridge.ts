import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  executeWebGptReadOnlyTool,
  WEBGPT_READ_ONLY_TOOLS,
  type WebGptReadOnlyToolName
} from "../src/index.js";

const DEFAULT_PORT = 4182;

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function normalizeHostHeader(hostHeader: string | undefined): string {
  const host = (hostHeader ?? "").toLowerCase();
  if (host.startsWith("[::1]")) return "::1";
  const colonIndex = host.indexOf(":");
  return colonIndex === -1 ? host : host.slice(0, colonIndex);
}

function isLocalRequest(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? "";
  if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") return false;
  const host = normalizeHostHeader(request.headers.host);
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function queryInput(url: URL): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams.entries()) input[key] = value;
  return input;
}

function route(request: IncomingMessage, response: ServerResponse): void {
  if (!isLocalRequest(request)) {
    sendJson(response, 403, { ok: false, error: { code: "LOCALHOST_ONLY", message: "WebGPT read-only bridge only accepts localhost requests." } });
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: { code: "READ_ONLY_GET_REQUIRED", message: "Only GET is available in the v0 read-only bridge." } });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/api/tools") {
    sendJson(response, 200, {
      ok: true,
      mode: "READ_ONLY",
      mutation_allowed: false,
      tools: WEBGPT_READ_ONLY_TOOLS
    });
    return;
  }

  if (url.pathname.startsWith("/api/tool/")) {
    const tool = decodeURIComponent(url.pathname.slice("/api/tool/".length)) as WebGptReadOnlyToolName;
    sendJson(response, 200, executeWebGptReadOnlyTool(tool, queryInput(url)));
    return;
  }

  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Read-only bridge route not found." } });
}

const startPort = Number(process.env.WEBGPT_READONLY_BRIDGE_PORT || process.env.PORT || DEFAULT_PORT);
const server = createServer((request, response) => {
  try {
    route(request, response);
  } catch {
    sendJson(response, 500, { ok: false, error: { code: "SERVER_ERROR", message: "Read-only bridge server error." } });
  }
});

function listen(port: number): void {
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && port < startPort + 20) {
      listen(port + 1);
      return;
    }
    throw error;
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`WebGPT v0 只读 bridge 运行中：http://127.0.0.1:${actualPort}`);
  });
}

listen(startPort);
