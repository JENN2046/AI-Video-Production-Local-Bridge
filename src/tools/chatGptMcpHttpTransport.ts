import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import {
  boundaryFlags,
  CHATGPT_MCP_BRIDGE_VERSION,
  CHATGPT_MCP_LOCAL_TEST_SERVER_NAME,
  CHATGPT_MCP_TOOL_DESCRIPTORS,
  createChatGptMcpLocalServer,
  type ChatGptMcpToolResultEnvelope
} from "./chatGptMcpBridge.js";

export const CHATGPT_MCP_HTTP_LOCAL_HOST = "127.0.0.1";
export const CHATGPT_MCP_HTTP_LOCAL_TRANSPORT = "localhost_http_dry_run";

export interface ChatGptMcpHttpLocalHarness {
  transport: typeof CHATGPT_MCP_HTTP_LOCAL_TRANSPORT;
  host: typeof CHATGPT_MCP_HTTP_LOCAL_HOST;
  port: number;
  baseUrl: string;
  mcpUrl: string;
  public_endpoint: false;
  chatgpt_connector_created: false;
  close: () => Promise<void>;
}

interface JsonRpcLikeRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface HttpResponseEnvelope {
  ok: boolean;
  method: string;
  result?: unknown;
  error?: { code: string; message: string };
  boundary: Record<string, boolean>;
  endpoint: {
    transport: typeof CHATGPT_MCP_HTTP_LOCAL_TRANSPORT;
    localhost_only: true;
    public_endpoint: false;
    chatgpt_connector_created: false;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function endpointMetadata(): HttpResponseEnvelope["endpoint"] {
  return {
    transport: CHATGPT_MCP_HTTP_LOCAL_TRANSPORT,
    localhost_only: true,
    public_endpoint: false,
    chatgpt_connector_created: false
  };
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(payload)}\n`);
}

function failHttp(method: string, code: string, message: string): HttpResponseEnvelope {
  return {
    ok: false,
    method,
    error: { code, message },
    boundary: boundaryFlags(),
    endpoint: endpointMetadata()
  };
}

function okHttp(method: string, result: unknown): HttpResponseEnvelope {
  return {
    ok: true,
    method,
    result,
    boundary: boundaryFlags(),
    endpoint: endpointMetadata()
  };
}

function hostHeaderIsLocalhost(request: IncomingMessage): boolean {
  const host = request.headers.host ?? "";
  const hostname = host.split(":")[0]?.replace(/^\[|\]$/g, "") ?? "";
  return hostname === CHATGPT_MCP_HTTP_LOCAL_HOST || hostname === "localhost";
}

async function readRequestJson(request: IncomingMessage): Promise<JsonRpcLikeRequest | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 1024 * 1024) return null;
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeToolArguments(params: unknown): { name: string; input: Record<string, unknown> } | null {
  if (!isRecord(params) || typeof params.name !== "string") return null;
  const rawInput = "arguments" in params ? params.arguments : params.input;
  return {
    name: params.name,
    input: isRecord(rawInput) ? rawInput : {}
  };
}

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse, db: M0Database): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${CHATGPT_MCP_HTTP_LOCAL_HOST}`);
  if (!hostHeaderIsLocalhost(request)) {
    sendJson(response, 403, failHttp("unknown", "LOCALHOST_ONLY", "Only localhost host headers are accepted by the dry-run harness."));
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, okHttp("health", {
      server_name: CHATGPT_MCP_LOCAL_TEST_SERVER_NAME,
      bridge_version: CHATGPT_MCP_BRIDGE_VERSION,
      localhost_only: true
    }));
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJson(response, 404, failHttp("unknown", "NOT_FOUND", "Only /mcp is exposed by this local dry-run harness."));
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, failHttp("unknown", "METHOD_NOT_ALLOWED", "The local dry-run /mcp endpoint accepts POST only."));
    return;
  }

  const body = await readRequestJson(request);
  if (!body) {
    sendJson(response, 400, failHttp("unknown", "INVALID_JSON", "Request body must be a JSON object."));
    return;
  }

  const method = typeof body.method === "string" ? body.method : "";
  const localServer = createChatGptMcpLocalServer(db);
  if (method === "tools/list") {
    sendJson(response, 200, okHttp(method, {
      tools: localServer.listTools(),
      tool_count: CHATGPT_MCP_TOOL_DESCRIPTORS.length
    }));
    return;
  }

  if (method === "tools/call") {
    const call = normalizeToolArguments(body.params);
    if (!call) {
      sendJson(response, 400, failHttp(method, "INVALID_TOOL_CALL", "tools/call requires params.name and optional params.arguments."));
      return;
    }
    sendJson(response, 200, okHttp(method, localServer.callTool(call.name, call.input)));
    return;
  }

  sendJson(response, 400, failHttp(method || "unknown", "UNKNOWN_MCP_METHOD", "Supported dry-run methods are tools/list and tools/call."));
}

export async function startChatGptMcpHttpLocalHarness(): Promise<ChatGptMcpHttpLocalHarness> {
  const db = openM0Database();
  let closed = false;
  const server: Server = createServer((request, response) => {
    void handleMcpRequest(request, response, db).catch((error: unknown) => {
      sendJson(response, 500, failHttp("unknown", "LOCAL_HTTP_HARNESS_ERROR", error instanceof Error ? error.message : "Unknown local harness error."));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, CHATGPT_MCP_HTTP_LOCAL_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://${CHATGPT_MCP_HTTP_LOCAL_HOST}:${address.port}`;

  return {
    transport: CHATGPT_MCP_HTTP_LOCAL_TRANSPORT,
    host: CHATGPT_MCP_HTTP_LOCAL_HOST,
    port: address.port,
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    public_endpoint: false,
    chatgpt_connector_created: false,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      db.close();
    }
  };
}

async function postMcp(url: string, payload: unknown): Promise<{ status: number; body: HttpResponseEnvelope }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json() as HttpResponseEnvelope;
  return { status: response.status, body };
}

function toolResult(payload: HttpResponseEnvelope): ChatGptMcpToolResultEnvelope | null {
  if (!isRecord(payload.result) || !("ok" in payload.result)) return null;
  return payload.result as unknown as ChatGptMcpToolResultEnvelope;
}

function allBoundaryFlagsFalse(boundary: Record<string, boolean>): boolean {
  return Object.values(boundary).every((value) => value === false);
}

export async function runR2GHttpMcpTransportLocalDryRun(generatedAt = new Date().toISOString()): Promise<Record<string, unknown>> {
  const harness = await startChatGptMcpHttpLocalHarness();
  let serverClosedAfterRun = false;
  let report: Record<string, unknown> | null = null;
  try {
    const listTools = await postMcp(harness.mcpUrl, { jsonrpc: "2.0", id: "list-tools", method: "tools/list", params: {} });
    const approvedTool = await postMcp(harness.mcpUrl, {
      jsonrpc: "2.0",
      id: "approved-tool",
      method: "tools/call",
      params: { name: "get_project_status", arguments: {} }
    });
    const forbiddenTool = await postMcp(harness.mcpUrl, {
      jsonrpc: "2.0",
      id: "forbidden-tool",
      method: "tools/call",
      params: { name: "call_runninghub", arguments: {} }
    });
    const schemaValidation = await postMcp(harness.mcpUrl, {
      jsonrpc: "2.0",
      id: "schema-validation",
      method: "tools/call",
      params: { name: "get_project_status", arguments: { extra_unexpected: true } }
    });

    const approvedResult = toolResult(approvedTool.body);
    const forbiddenResult = toolResult(forbiddenTool.body);
    const schemaResult = toolResult(schemaValidation.body);
    const listResult = isRecord(listTools.body.result) ? listTools.body.result : {};
    const listToolsOk = listTools.status === 200 && listTools.body.ok && Array.isArray(listResult.tools) && listResult.tools.length === CHATGPT_MCP_TOOL_DESCRIPTORS.length;
    const approvedToolOk = approvedTool.status === 200 && approvedTool.body.ok && approvedResult?.ok === true && approvedResult.mode === "READ_ONLY";
    const forbiddenToolFailClosed = forbiddenTool.status === 200 && forbiddenTool.body.ok && forbiddenResult?.ok === false && (forbiddenResult.structuredContent.error as { code?: string }).code === "FORBIDDEN_ACTION";
    const schemaValidationFailClosed = schemaValidation.status === 200 && schemaValidation.body.ok && schemaResult?.ok === false && (schemaResult.structuredContent.error as { code?: string }).code === "UNKNOWN_INPUT_FIELD";
    const boundaryFlagChecks = [
      listTools.body.boundary,
      approvedTool.body.boundary,
      forbiddenTool.body.boundary,
      schemaValidation.body.boundary,
      approvedResult?._meta.provider_boundary,
      forbiddenResult?._meta.provider_boundary,
      schemaResult?._meta.provider_boundary
    ].filter((boundary): boundary is Record<string, boolean> => Boolean(boundary));
    const boundaryFlagsRemainFalse = boundaryFlagChecks.every(allBoundaryFlagsFalse);

    const result = listToolsOk && approvedToolOk && forbiddenToolFailClosed && schemaValidationFailClosed && boundaryFlagsRemainFalse
      ? "PASS_LOCAL_HTTP_MCP_TRANSPORT_DRY_RUN"
      : "BLOCK_LOCAL_HTTP_MCP_TRANSPORT_WITH_REASON";

    report = {
      task_id: "R2G-J_HTTP_MCP_TRANSPORT_LOCAL_DRY_RUN",
      result,
      generated_at: generatedAt,
      bridge_version: CHATGPT_MCP_BRIDGE_VERSION,
      http_transport: {
        transport: CHATGPT_MCP_HTTP_LOCAL_TRANSPORT,
        host: harness.host,
        port: harness.port,
        mcp_url: harness.mcpUrl,
        localhost_only: true,
        public_endpoint: false,
        chatgpt_connector_created: false,
        server_closed_after_run: false
      },
      mcp_methods_supported: ["tools/list", "tools/call"],
      dry_run_checks: {
        list_tools: {
          status: listTools.status,
          ok: listToolsOk,
          tool_count: Array.isArray(listResult.tools) ? listResult.tools.length : 0
        },
        call_approved_tool: {
          status: approvedTool.status,
          ok: approvedToolOk,
          tool: approvedResult?.tool ?? "unknown",
          mode: approvedResult?.mode ?? "unknown"
        },
        forbidden_tool_fail_closed: {
          status: forbiddenTool.status,
          ok: forbiddenToolFailClosed,
          tool: "call_runninghub",
          error_code: forbiddenResult && isRecord(forbiddenResult.structuredContent.error) ? forbiddenResult.structuredContent.error.code : "unknown"
        },
        schema_validation_fail_closed: {
          status: schemaValidation.status,
          ok: schemaValidationFailClosed,
          tool: "get_project_status",
          error_code: schemaResult && isRecord(schemaResult.structuredContent.error) ? schemaResult.structuredContent.error.code : "unknown"
        },
        boundary_flags_remain_false: boundaryFlagsRemainFalse
      },
      boundary_observed: {
        localhost_http_requests_performed: true,
        localhost_http_request_count: 4,
        public_tunnel_started: false,
        public_mcp_endpoint_created: false,
        chatgpt_connector_created: false,
        deploy_performed: false,
        env_files_read: false,
        credentials_read: false,
        external_provider_or_api_call_attempted: false,
        provider_api_called: false,
        push_performed: false,
        tag_created: false,
        release_or_deploy_performed: false,
        publish_performed: false
      },
      provider_boundary: boundaryFlags(),
      git_receipt: {
        repo: true,
        branch: "master",
        commit: "PENDING_LOCAL_COMMIT",
        task: "R2G-J_HTTP_MCP_TRANSPORT_LOCAL_DRY_RUN",
        push: false,
        pr: null,
        tag_created: false,
        release_or_deploy_performed: false
      }
    };
  } finally {
    await harness.close();
    serverClosedAfterRun = true;
  }

  if (report) {
    const httpTransport = report.http_transport as { server_closed_after_run: boolean };
    httpTransport.server_closed_after_run = serverClosedAfterRun;
    return report;
  }
  throw new Error("R2G-J local HTTP MCP dry-run failed before report creation.");
}
