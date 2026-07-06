import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  executeWebGptProductionAssistantTool,
  WEBGPT_PRODUCTION_ASSISTANT_TOOLS,
  type WebGptProductionAssistantToolName
} from "../src/index.js";

const DEFAULT_PORT = 4186;
const MAX_BODY_BYTES = 1024 * 1024;

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

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
  }
  if (!body.trim()) return {};
  const parsed = JSON.parse(body) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isLocalRequest(request)) {
    sendJson(response, 403, { ok: false, error: { code: "LOCALHOST_ONLY", message: "WebGPT production assistant bridge only accepts localhost requests." } });
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/api/tools")) {
    sendJson(response, 200, {
      ok: true,
      mode: "PRODUCTION_ASSISTANT_PLAN_ONLY",
      execution_allowed: false,
      provider_call_allowed: false,
      final_delivery_approval_allowed: false,
      long_term_memory_write_allowed: false,
      production_assistant_tools: WEBGPT_PRODUCTION_ASSISTANT_TOOLS
    });
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/production-tool/")) {
    const tool = decodeURIComponent(url.pathname.slice("/api/production-tool/".length)) as WebGptProductionAssistantToolName;
    sendJson(response, 200, executeWebGptProductionAssistantTool(tool, queryInput(url)));
    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/production-tool/")) {
    const tool = decodeURIComponent(url.pathname.slice("/api/production-tool/".length)) as WebGptProductionAssistantToolName;
    const input = await readJsonBody(request);
    sendJson(response, 200, executeWebGptProductionAssistantTool(tool, input));
    return;
  }

  if (request.method !== "GET" && request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only GET tools and POST production plan tools are available." } });
    return;
  }

  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "WebGPT production assistant bridge route not found." } });
}

const startPort = Number(process.env.WEBGPT_PRODUCTION_BRIDGE_PORT || process.env.PORT || DEFAULT_PORT);
const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    const code = error instanceof Error && error.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "SERVER_ERROR";
    sendJson(response, code === "BODY_TOO_LARGE" ? 413 : 500, { ok: false, error: { code, message: "WebGPT production assistant bridge server error." } });
  });
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
    console.log(`WebGPT v3 生产助理 bridge 运行中：http://127.0.0.1:${actualPort}`);
  });
}

listen(startPort);
