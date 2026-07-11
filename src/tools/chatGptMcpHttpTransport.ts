import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import {
  boundaryFlags,
  CHATGPT_MCP_BRIDGE_VERSION,
  CHATGPT_MCP_LOCAL_TEST_SERVER_NAME,
  CHATGPT_MCP_TOOL_DESCRIPTORS,
  createChatGptMcpLocalServer,
  executeChatGptMcpReadOnlyTool,
  listChatGptMcpReadOnlyToolDescriptors,
  type ChatGptMcpToolDescriptor,
  type ChatGptMcpToolResultEnvelope
} from "./chatGptMcpBridge.js";

export const CHATGPT_MCP_HTTP_LOCAL_HOST = "127.0.0.1";
export const CHATGPT_MCP_HTTP_LOCAL_TRANSPORT = "localhost_http_dry_run";
export const CHATGPT_MCP_HTTP_READ_ONLY_LIVE_SMOKE_LOCAL_TRANSPORT = "read_only_live_smoke_local_entry";
export const CHATGPT_MCP_READ_ONLY_LIVE_SMOKE_RECOMMENDED_PORT = 2091;

type ChatGptMcpHttpTransport =
  | typeof CHATGPT_MCP_HTTP_LOCAL_TRANSPORT
  | typeof CHATGPT_MCP_HTTP_READ_ONLY_LIVE_SMOKE_LOCAL_TRANSPORT;

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

export interface ChatGptMcpReadOnlyLiveSmokeLocalEntry {
  transport: typeof CHATGPT_MCP_HTTP_READ_ONLY_LIVE_SMOKE_LOCAL_TRANSPORT;
  host: typeof CHATGPT_MCP_HTTP_LOCAL_HOST;
  port: number;
  baseUrl: string;
  mcpUrl: string;
  localhost_only: true;
  public_endpoint: false;
  public_tunnel_started: false;
  chatgpt_connector_created: false;
  read_only_only: true;
  tunnel_ready_host_header: true;
  allowed_tool_names: string[];
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
    transport: ChatGptMcpHttpTransport;
    localhost_only: true;
    public_endpoint: false;
    chatgpt_connector_created: false;
    read_only_only?: true;
    tunnel_ready_host_header?: true;
  };
}

interface JsonRpcSuccessEnvelope {
  jsonrpc: "2.0";
  id: unknown;
  result: unknown;
}

interface JsonRpcErrorEnvelope {
  jsonrpc: "2.0";
  id: unknown;
  error: {
    code: number;
    message: string;
    data: {
      code: string;
      boundary: Record<string, boolean>;
      endpoint: HttpResponseEnvelope["endpoint"];
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function endpointMetadata(transport: ChatGptMcpHttpTransport): HttpResponseEnvelope["endpoint"] {
  if (transport === CHATGPT_MCP_HTTP_READ_ONLY_LIVE_SMOKE_LOCAL_TRANSPORT) {
    return {
      transport,
      localhost_only: true,
      public_endpoint: false,
      chatgpt_connector_created: false,
      read_only_only: true,
      tunnel_ready_host_header: true
    };
  }
  return {
    transport,
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

function failHttp(method: string, code: string, message: string, transport: ChatGptMcpHttpTransport): HttpResponseEnvelope {
  return {
    ok: false,
    method,
    error: { code, message },
    boundary: boundaryFlags(),
    endpoint: endpointMetadata(transport)
  };
}

function okHttp(method: string, result: unknown, transport: ChatGptMcpHttpTransport): HttpResponseEnvelope {
  return {
    ok: true,
    method,
    result,
    boundary: boundaryFlags(),
    endpoint: endpointMetadata(transport)
  };
}

function jsonRpcId(id: unknown): unknown {
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function sendJsonRpcResult(response: ServerResponse, id: unknown, result: unknown): void {
  sendJson(response, 200, { jsonrpc: "2.0", id: jsonRpcId(id), result } satisfies JsonRpcSuccessEnvelope);
}

function sendJsonRpcError(
  response: ServerResponse,
  id: unknown,
  statusCode: number,
  rpcCode: number,
  code: string,
  message: string
): void {
  sendJson(response, statusCode, {
    jsonrpc: "2.0",
    id: jsonRpcId(id),
    error: {
      code: rpcCode,
      message,
      data: {
        code,
        boundary: boundaryFlags(),
        endpoint: endpointMetadata(CHATGPT_MCP_HTTP_READ_ONLY_LIVE_SMOKE_LOCAL_TRANSPORT)
      }
    }
  } satisfies JsonRpcErrorEnvelope);
}

function hostHeaderIsLocalhost(request: IncomingMessage): boolean {
  const host = request.headers.host ?? "";
  const hostname = host.split(":")[0]?.replace(/^\[|\]$/g, "") ?? "";
  return hostname === CHATGPT_MCP_HTTP_LOCAL_HOST || hostname === "localhost";
}

function remoteAddressIsLocalhost(request: IncomingMessage): boolean {
  const remoteAddress = request.socket.remoteAddress ?? "";
  return remoteAddress === CHATGPT_MCP_HTTP_LOCAL_HOST || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

async function readRequestJson(request: IncomingMessage): Promise<JsonRpcLikeRequest | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > 1024 * 1024) return null;
    chunks.push(buffer);
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

function mcpToolDescriptor(descriptor: ChatGptMcpToolDescriptor): Record<string, unknown> {
  return {
    name: descriptor.name,
    title: descriptor.title,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
    annotations: descriptor.annotations,
    _meta: {
      ...descriptor._meta,
      security: descriptor.security,
      r2g_live_smoke_read_only: true
    }
  };
}

function mcpToolResult(result: ChatGptMcpToolResultEnvelope): Record<string, unknown> {
  return {
    isError: !result.ok,
    content: result.content,
    structuredContent: result.structuredContent,
    _meta: {
      ...result._meta,
      r2g_live_smoke: {
        ok: result.ok,
        tool: result.tool,
        mode: result.mode,
        read_only_only: true
      }
    }
  };
}

async function handleDryRunMcpRequest(request: IncomingMessage, response: ServerResponse, db: M0Database): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${CHATGPT_MCP_HTTP_LOCAL_HOST}`);
  if (!hostHeaderIsLocalhost(request)) {
    sendJson(
      response,
      403,
      failHttp("unknown", "LOCALHOST_ONLY", "Only localhost host headers are accepted by the dry-run harness.", CHATGPT_MCP_HTTP_LOCAL_TRANSPORT)
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, okHttp("health", {
      server_name: CHATGPT_MCP_LOCAL_TEST_SERVER_NAME,
      bridge_version: CHATGPT_MCP_BRIDGE_VERSION,
      localhost_only: true
    }, CHATGPT_MCP_HTTP_LOCAL_TRANSPORT));
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJson(response, 404, failHttp("unknown", "NOT_FOUND", "Only /mcp is exposed by this local dry-run harness.", CHATGPT_MCP_HTTP_LOCAL_TRANSPORT));
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, failHttp("unknown", "METHOD_NOT_ALLOWED", "The local dry-run /mcp endpoint accepts POST only.", CHATGPT_MCP_HTTP_LOCAL_TRANSPORT));
    return;
  }

  const body = await readRequestJson(request);
  if (!body) {
    sendJson(response, 400, failHttp("unknown", "INVALID_JSON", "Request body must be a JSON object.", CHATGPT_MCP_HTTP_LOCAL_TRANSPORT));
    return;
  }

  const method = typeof body.method === "string" ? body.method : "";
  const localServer = createChatGptMcpLocalServer(db);
  if (method === "tools/list") {
    sendJson(response, 200, okHttp(method, {
      tools: localServer.listTools(),
      tool_count: CHATGPT_MCP_TOOL_DESCRIPTORS.length
    }, CHATGPT_MCP_HTTP_LOCAL_TRANSPORT));
    return;
  }

  if (method === "tools/call") {
    const call = normalizeToolArguments(body.params);
    if (!call) {
      sendJson(response, 400, failHttp(method, "INVALID_TOOL_CALL", "tools/call requires params.name and optional params.arguments.", CHATGPT_MCP_HTTP_LOCAL_TRANSPORT));
      return;
    }
    sendJson(response, 200, okHttp(method, localServer.callTool(call.name, call.input), CHATGPT_MCP_HTTP_LOCAL_TRANSPORT));
    return;
  }

  sendJson(response, 400, failHttp(method || "unknown", "UNKNOWN_MCP_METHOD", "Supported dry-run methods are tools/list and tools/call.", CHATGPT_MCP_HTTP_LOCAL_TRANSPORT));
}

async function handleReadOnlyLiveSmokeMcpRequest(request: IncomingMessage, response: ServerResponse, db: M0Database): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${CHATGPT_MCP_HTTP_LOCAL_HOST}`);
  if (!remoteAddressIsLocalhost(request)) {
    sendJson(
      response,
      403,
      failHttp("unknown", "LOCAL_SOCKET_ONLY", "The R2G-L local entry only accepts loopback TCP connections.", CHATGPT_MCP_HTTP_READ_ONLY_LIVE_SMOKE_LOCAL_TRANSPORT)
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, okHttp("health", {
      server_name: CHATGPT_MCP_LOCAL_TEST_SERVER_NAME,
      bridge_version: CHATGPT_MCP_BRIDGE_VERSION,
      localhost_only: true,
      public_endpoint: false,
      public_tunnel_started: false,
      chatgpt_connector_created: false,
      read_only_only: true,
      tunnel_ready_host_header: true,
      allowed_tool_names: listChatGptMcpReadOnlyToolDescriptors().map((tool) => tool.name)
    }, CHATGPT_MCP_HTTP_READ_ONLY_LIVE_SMOKE_LOCAL_TRANSPORT));
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJsonRpcError(response, null, 404, -32004, "NOT_FOUND", "Only /mcp is exposed by the R2G-L read-only local entry.");
    return;
  }

  if (request.method !== "POST") {
    sendJsonRpcError(response, null, 405, -32005, "METHOD_NOT_ALLOWED", "The R2G-L read-only local /mcp endpoint accepts POST only.");
    return;
  }

  const body = await readRequestJson(request);
  if (!body) {
    sendJsonRpcError(response, null, 400, -32700, "INVALID_JSON", "Request body must be a JSON object.");
    return;
  }

  const method = typeof body.method === "string" ? body.method : "";
  if (method === "initialize") {
    const params = isRecord(body.params) ? body.params : {};
    const protocolVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
    sendJsonRpcResult(response, body.id, {
      protocolVersion,
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: CHATGPT_MCP_LOCAL_TEST_SERVER_NAME,
        version: CHATGPT_MCP_BRIDGE_VERSION
      },
      instructions: "R2G-L local read-only smoke entry. Only READ_ONLY tools are listed or callable. Provider, generation, secret, deploy, and write actions fail closed."
    });
    return;
  }

  if (method === "notifications/initialized") {
    sendJsonRpcResult(response, body.id, { ok: true });
    return;
  }

  if (method === "tools/list") {
    const tools = listChatGptMcpReadOnlyToolDescriptors().map(mcpToolDescriptor);
    sendJsonRpcResult(response, body.id, { tools, tool_count: tools.length });
    return;
  }

  if (method === "tools/call") {
    const call = normalizeToolArguments(body.params);
    if (!call) {
      sendJsonRpcError(response, body.id, 400, -32602, "INVALID_TOOL_CALL", "tools/call requires params.name and optional params.arguments.");
      return;
    }
    sendJsonRpcResult(response, body.id, mcpToolResult(executeChatGptMcpReadOnlyTool(call.name, call.input, db)));
    return;
  }

  sendJsonRpcError(response, body.id, 400, -32601, "UNKNOWN_MCP_METHOD", "Supported R2G-L methods are initialize, notifications/initialized, tools/list, and tools/call.");
}

async function startHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse, db: M0Database) => Promise<void>,
  port: number
): Promise<{ server: Server; db: M0Database; port: number }> {
  const db = openM0Database();
  const server: Server = createServer((request, response) => {
    void handler(request, response, db).catch((error: unknown) => {
      sendJson(response, 500, failHttp("unknown", "LOCAL_HTTP_SERVER_ERROR", error instanceof Error ? error.message : "Unknown local HTTP error.", CHATGPT_MCP_HTTP_LOCAL_TRANSPORT));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      db.close();
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, CHATGPT_MCP_HTTP_LOCAL_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return { server, db, port: address.port };
}

async function closeServer(server: Server, db: M0Database, alreadyClosed: () => boolean, markClosed: () => void): Promise<void> {
  if (alreadyClosed()) return;
  markClosed();
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  db.close();
}

export async function startChatGptMcpHttpLocalHarness(): Promise<ChatGptMcpHttpLocalHarness> {
  let closed = false;
  const { server, db, port } = await startHttpServer(handleDryRunMcpRequest, 0);
  const baseUrl = `http://${CHATGPT_MCP_HTTP_LOCAL_HOST}:${port}`;

  return {
    transport: CHATGPT_MCP_HTTP_LOCAL_TRANSPORT,
    host: CHATGPT_MCP_HTTP_LOCAL_HOST,
    port,
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    public_endpoint: false,
    chatgpt_connector_created: false,
    close: () => closeServer(server, db, () => closed, () => { closed = true; })
  };
}

export async function startChatGptMcpReadOnlyLiveSmokeLocalEntry(port = 0): Promise<ChatGptMcpReadOnlyLiveSmokeLocalEntry> {
  let closed = false;
  const { server, db, port: boundPort } = await startHttpServer(handleReadOnlyLiveSmokeMcpRequest, port);
  const baseUrl = `http://${CHATGPT_MCP_HTTP_LOCAL_HOST}:${boundPort}`;
  return {
    transport: CHATGPT_MCP_HTTP_READ_ONLY_LIVE_SMOKE_LOCAL_TRANSPORT,
    host: CHATGPT_MCP_HTTP_LOCAL_HOST,
    port: boundPort,
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    localhost_only: true,
    public_endpoint: false,
    public_tunnel_started: false,
    chatgpt_connector_created: false,
    read_only_only: true,
    tunnel_ready_host_header: true,
    allowed_tool_names: listChatGptMcpReadOnlyToolDescriptors().map((tool) => tool.name),
    close: () => closeServer(server, db, () => closed, () => { closed = true; })
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

async function postJsonRpc(url: string, payload: unknown): Promise<{ status: number; body: JsonRpcSuccessEnvelope | JsonRpcErrorEnvelope }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json() as JsonRpcSuccessEnvelope | JsonRpcErrorEnvelope;
  return { status: response.status, body };
}

async function getJson(url: string): Promise<{ status: number; body: HttpResponseEnvelope }> {
  const response = await fetch(url, { method: "GET" });
  const body = await response.json() as HttpResponseEnvelope;
  return { status: response.status, body };
}

function toolResult(payload: HttpResponseEnvelope): ChatGptMcpToolResultEnvelope | null {
  if (!isRecord(payload.result) || !("ok" in payload.result)) return null;
  return payload.result as unknown as ChatGptMcpToolResultEnvelope;
}

function jsonRpcResultBody(response: { body: JsonRpcSuccessEnvelope | JsonRpcErrorEnvelope }): Record<string, unknown> | null {
  return "result" in response.body && isRecord(response.body.result) ? response.body.result : null;
}

function jsonRpcToolResult(response: { body: JsonRpcSuccessEnvelope | JsonRpcErrorEnvelope }): Record<string, unknown> | null {
  const result = jsonRpcResultBody(response);
  return result && isRecord(result.structuredContent) ? result : null;
}

function allBoundaryFlagsFalse(boundary: Record<string, boolean>): boolean {
  return Object.values(boundary).every((value) => value === false);
}

function toolResultBoundary(result: Record<string, unknown> | null): Record<string, boolean> | null {
  const structuredContent = result && isRecord(result.structuredContent) ? result.structuredContent : null;
  const boundary = structuredContent && isRecord(structuredContent.boundary) ? structuredContent.boundary : null;
  if (!boundary) return null;
  return Object.fromEntries(Object.entries(boundary).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
}

function mcpToolErrorCode(result: Record<string, unknown> | null): string {
  const structuredContent = result && isRecord(result.structuredContent) ? result.structuredContent : null;
  const error = structuredContent && isRecord(structuredContent.error) ? structuredContent.error : null;
  return typeof error?.code === "string" ? error.code : "unknown";
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

export async function runR2GReadOnlyLiveSmokeLocalEntryPrep(generatedAt = new Date().toISOString()): Promise<Record<string, unknown>> {
  const entry = await startChatGptMcpReadOnlyLiveSmokeLocalEntry();
  let serverClosedAfterRun = false;
  let report: Record<string, unknown> | null = null;
  try {
    const health = await getJson(`${entry.baseUrl}/health`);
    const initialize = await postJsonRpc(entry.mcpUrl, {
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "r2g-l-local-prep", version: "0.0.0" }
      }
    });
    const listTools = await postJsonRpc(entry.mcpUrl, { jsonrpc: "2.0", id: "list-tools", method: "tools/list", params: {} });
    const approvedTool = await postJsonRpc(entry.mcpUrl, {
      jsonrpc: "2.0",
      id: "approved-tool",
      method: "tools/call",
      params: { name: "get_project_status", arguments: {} }
    });
    const draftTool = await postJsonRpc(entry.mcpUrl, {
      jsonrpc: "2.0",
      id: "draft-tool",
      method: "tools/call",
      params: {
        name: "submit_storyboard_draft",
        arguments: { shots: [{ description: "Should not be stored.", video_prompt: "Should not be stored." }] }
      }
    });
    const humanConfirmedTool = await postJsonRpc(entry.mcpUrl, {
      jsonrpc: "2.0",
      id: "human-confirmed-tool",
      method: "tools/call",
      params: { name: "request_package_freeze", arguments: { reason: "Should not create pending action." } }
    });
    const forbiddenProviderTool = await postJsonRpc(entry.mcpUrl, {
      jsonrpc: "2.0",
      id: "forbidden-provider-tool",
      method: "tools/call",
      params: { name: "call_runninghub", arguments: {} }
    });
    const unknownTool = await postJsonRpc(entry.mcpUrl, {
      jsonrpc: "2.0",
      id: "unknown-tool",
      method: "tools/call",
      params: { name: "unknown_tool", arguments: {} }
    });
    const schemaValidation = await postJsonRpc(entry.mcpUrl, {
      jsonrpc: "2.0",
      id: "schema-validation",
      method: "tools/call",
      params: { name: "get_project_status", arguments: { extra_unexpected: true } }
    });

    const listResult = jsonRpcResultBody(listTools);
    const listedTools = listResult && Array.isArray(listResult.tools) ? listResult.tools : [];
    const listedToolNames = listedTools
      .filter((tool): tool is Record<string, unknown> => isRecord(tool))
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string");
    const expectedReadOnlyToolNames = listChatGptMcpReadOnlyToolDescriptors().map((tool) => tool.name);
    const expectedReadOnlyToolNameSet = new Set<string>(expectedReadOnlyToolNames);
    const onlyReadOnlyToolsListed = listedToolNames.length === expectedReadOnlyToolNames.length
      && listedToolNames.every((name) => expectedReadOnlyToolNameSet.has(name));

    const approvedResult = jsonRpcToolResult(approvedTool);
    const draftResult = jsonRpcToolResult(draftTool);
    const humanConfirmedResult = jsonRpcToolResult(humanConfirmedTool);
    const forbiddenProviderResult = jsonRpcToolResult(forbiddenProviderTool);
    const unknownResult = jsonRpcToolResult(unknownTool);
    const schemaResult = jsonRpcToolResult(schemaValidation);

    const healthOk = health.status === 200 && health.body.ok === true && isRecord(health.body.result) && health.body.result.read_only_only === true;
    const initializeOk = initialize.status === 200 && "result" in initialize.body && isRecord(initialize.body.result) && isRecord(initialize.body.result.serverInfo);
    const listToolsOk = listTools.status === 200 && "result" in listTools.body && onlyReadOnlyToolsListed;
    const approvedToolOk = approvedTool.status === 200 && approvedResult?.isError === false;
    const draftToolFailClosed = draftTool.status === 200 && draftResult?.isError === true && mcpToolErrorCode(draftResult) === "READ_ONLY_LIVE_SMOKE_ONLY";
    const humanConfirmedToolFailClosed = humanConfirmedTool.status === 200 && humanConfirmedResult?.isError === true && mcpToolErrorCode(humanConfirmedResult) === "READ_ONLY_LIVE_SMOKE_ONLY";
    const forbiddenProviderToolFailClosed = forbiddenProviderTool.status === 200 && forbiddenProviderResult?.isError === true && mcpToolErrorCode(forbiddenProviderResult) === "FORBIDDEN_ACTION";
    const unknownToolFailClosed = unknownTool.status === 200 && unknownResult?.isError === true && mcpToolErrorCode(unknownResult) === "TOOL_NOT_FOUND";
    const schemaValidationFailClosed = schemaValidation.status === 200 && schemaResult?.isError === true && mcpToolErrorCode(schemaResult) === "UNKNOWN_INPUT_FIELD";
    const boundaryChecks = [
      health.body.boundary,
      toolResultBoundary(approvedResult),
      toolResultBoundary(draftResult),
      toolResultBoundary(humanConfirmedResult),
      toolResultBoundary(forbiddenProviderResult),
      toolResultBoundary(unknownResult),
      toolResultBoundary(schemaResult)
    ].filter((boundary): boundary is Record<string, boolean> => Boolean(boundary));
    const boundaryFlagsRemainFalse = boundaryChecks.every(allBoundaryFlagsFalse);

    const result = healthOk
      && initializeOk
      && listToolsOk
      && approvedToolOk
      && draftToolFailClosed
      && humanConfirmedToolFailClosed
      && forbiddenProviderToolFailClosed
      && unknownToolFailClosed
      && schemaValidationFailClosed
      && boundaryFlagsRemainFalse
      ? "PASS_READ_ONLY_LIVE_SMOKE_LOCAL_ENTRY_PREP"
      : "BLOCK_READ_ONLY_LIVE_SMOKE_LOCAL_ENTRY_WITH_REASON";

    report = {
      task_id: "R2G-L_CHATGPT_CONNECTOR_READ_ONLY_LIVE_SMOKE_LOCAL_ENTRY_PREP",
      result,
      generated_at: generatedAt,
      bridge_version: CHATGPT_MCP_BRIDGE_VERSION,
      app_archetype: "tool-only",
      official_docs_rechecked: [
        {
          title: "Build your MCP server",
          url: "https://developers.openai.com/apps-sdk/build/mcp-server",
          implication: "The local entry exposes tool descriptors and tool results with structuredContent/content/_meta while enforcing auth and action boundaries server-side."
        },
        {
          title: "Deploy your app",
          url: "https://developers.openai.com/apps-sdk/deploy",
          implication: "Future ChatGPT testing needs a public HTTPS tunnel or hosted /mcp endpoint; this task intentionally does not start one."
        },
        {
          title: "Connect from ChatGPT",
          url: "https://developers.openai.com/apps-sdk/deploy/connect-chatgpt",
          implication: "Future connector creation needs developer mode, connector metadata, and a reachable HTTPS /mcp URL; this task remains local-only."
        }
      ],
      local_entry: {
        transport: entry.transport,
        host: entry.host,
        port: entry.port,
        mcp_url: entry.mcpUrl,
        recommended_future_local_port: CHATGPT_MCP_READ_ONLY_LIVE_SMOKE_RECOMMENDED_PORT,
        localhost_only: true,
        public_endpoint: false,
        public_tunnel_started: false,
        chatgpt_connector_created: false,
        read_only_only: true,
        tunnel_ready_host_header: true,
        server_closed_after_run: false
      },
      tool_surface: {
        listed_tool_names: listedToolNames,
        listed_tool_count: listedToolNames.length,
        expected_read_only_tool_names: expectedReadOnlyToolNames,
        excluded_non_read_only_tools: CHATGPT_MCP_TOOL_DESCRIPTORS
          .filter((tool) => tool.security.mode !== "READ_ONLY")
          .map((tool) => ({ name: tool.name, mode: tool.security.mode })),
        provider_tools_exposed: false,
        write_tools_exposed: false
      },
      local_smoke_checks: {
        health: { status: health.status, ok: healthOk },
        initialize: { status: initialize.status, ok: initializeOk },
        list_read_only_tools: { status: listTools.status, ok: listToolsOk, tool_count: listedToolNames.length },
        call_get_project_status: { status: approvedTool.status, ok: approvedToolOk },
        deny_draft_tool: { status: draftTool.status, ok: draftToolFailClosed, error_code: mcpToolErrorCode(draftResult) },
        deny_human_confirmed_tool: { status: humanConfirmedTool.status, ok: humanConfirmedToolFailClosed, error_code: mcpToolErrorCode(humanConfirmedResult) },
        deny_provider_tool: { status: forbiddenProviderTool.status, ok: forbiddenProviderToolFailClosed, error_code: mcpToolErrorCode(forbiddenProviderResult) },
        deny_unknown_tool: { status: unknownTool.status, ok: unknownToolFailClosed, error_code: mcpToolErrorCode(unknownResult) },
        schema_validation_fail_closed: { status: schemaValidation.status, ok: schemaValidationFailClosed, error_code: mcpToolErrorCode(schemaResult) },
        boundary_flags_remain_false: boundaryFlagsRemainFalse
      },
      boundary_observed: {
        localhost_http_requests_performed: true,
        localhost_http_request_count: 8,
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
        publish_performed: false,
        production_configuration_changed: false
      },
      future_live_smoke_command_template: {
        local_server_command: "npm run start:webgpt",
        historical_recommended_port: CHATGPT_MCP_READ_ONLY_LIVE_SMOKE_RECOMMENDED_PORT,
        public_tunnel_command_required_later: true,
        chatgpt_connector_creation_required_later: true,
        requires_exact_future_authorization: true
      },
      provider_boundary: boundaryFlags(),
      git_receipt: {
        repo: true,
        branch: "master",
        commit: "PENDING_LOCAL_COMMIT",
        task: "R2G-L_CHATGPT_CONNECTOR_READ_ONLY_LIVE_SMOKE_LOCAL_ENTRY_PREP",
        push: false,
        pr: null,
        tag_created: false,
        release_or_deploy_performed: false
      }
    };
  } finally {
    await entry.close();
    serverClosedAfterRun = true;
  }

  if (report) {
    const localEntry = report.local_entry as { server_closed_after_run: boolean };
    localEntry.server_closed_after_run = serverClosedAfterRun;
    return report;
  }
  throw new Error("R2G-L read-only live smoke local entry prep failed before report creation.");
}
