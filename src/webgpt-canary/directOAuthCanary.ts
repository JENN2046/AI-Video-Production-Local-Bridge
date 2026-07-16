import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";

import {
  assertWebGptV4AuthConfig,
  createOAuthAuthenticator,
  loadWebGptV4AuthConfig,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  wwwAuthenticate,
  type WebGptV4AuthConfig,
  type WebGptV4Authenticator,
  type WebGptV4AuthenticatorOptions
} from "../webgpt-v4/auth.js";
import { withToolSecuritySchemes } from "../webgpt-v4/securityTransport.js";
import { errorBody, requireScope, WebGptV4Error } from "../webgpt-v4/types.js";

export const DIRECT_OAUTH_CANARY_VERSION = "direct-oauth-canary-v1.0.0";
export const DIRECT_OAUTH_CANARY_TOOL = "get_direct_oauth_smoke_status";
export const DIRECT_OAUTH_CANARY_SCOPE = "projects.read" as const;

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 10000;
const MAXIMUM_BODY_BYTES = 256 * 1024;

export interface DirectOAuthCanaryOptions {
  host?: string;
  port?: number;
  auth_config?: WebGptV4AuthConfig;
  authenticate?: WebGptV4Authenticator;
  authenticator_options?: WebGptV4AuthenticatorOptions;
}

export interface DirectOAuthCanaryRuntime {
  host: string;
  port: number;
  mcp_url: string;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload).toString(),
    "cache-control": "no-store",
    ...headers
  });
  response.end(payload);
}

function safeJsonRpcId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" || value === null ? value : null;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > MAXIMUM_BODY_BYTES) throw new WebGptV4Error("BODY_TOO_LARGE", "MCP request body exceeds the canary limit.");
    chunks.push(value);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_OBJECT");
    return parsed as Record<string, unknown>;
  } catch {
    throw new WebGptV4Error("INVALID_JSON_BODY", "MCP request body must be a JSON object.");
  }
}

function createCanaryMcpServer(): McpServer {
  const server = new McpServer(
    { name: "jenn-ai-video-direct-oauth-canary", version: DIRECT_OAUTH_CANARY_VERSION },
    { instructions: "OAuth compatibility canary only. It exposes no production data and performs no writes." }
  );
  server.registerTool(DIRECT_OAUTH_CANARY_TOOL, {
    title: "Direct OAuth smoke status",
    description: "Confirms that the direct public MCP endpoint authenticated a projects.read request. Returns no project or production data.",
    inputSchema: {},
    outputSchema: {
      mode: z.literal("direct_public_https"),
      oauth_authenticated: z.literal(true),
      required_scope: z.literal(DIRECT_OAUTH_CANARY_SCOPE),
      database_connected: z.literal(false),
      snapshot_connected: z.literal(false),
      workbench_ui_enabled: z.literal(false),
      media_enabled: z.literal(false),
      provider_calls_allowed: z.literal(false)
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [DIRECT_OAUTH_CANARY_SCOPE] }] }
  }, async () => {
    const status = {
      mode: "direct_public_https" as const,
      oauth_authenticated: true as const,
      required_scope: DIRECT_OAUTH_CANARY_SCOPE,
      database_connected: false as const,
      snapshot_connected: false as const,
      workbench_ui_enabled: false as const,
      media_enabled: false as const,
      provider_calls_allowed: false as const
    };
    return {
      content: [{ type: "text", text: "Direct OAuth canary authentication succeeded." }],
      structuredContent: status
    };
  });
  return server;
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("DIRECT_OAUTH_CANARY_LISTEN_FAILED"));
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function startDirectOAuthCanary(options: DirectOAuthCanaryOptions = {}): Promise<DirectOAuthCanaryRuntime> {
  const authConfig = options.auth_config ?? loadWebGptV4AuthConfig("readonly");
  if (!authConfig) throw new WebGptV4Error("INVALID_WEBGPT_AUTH_CONFIG", "Direct OAuth canary requires explicit Readonly OAuth configuration.");
  assertWebGptV4AuthConfig(authConfig);
  if (authConfig.provider !== "federated" || authConfig.access_model !== "project_membership") {
    throw new WebGptV4Error("INVALID_WEBGPT_AUTH_CONFIG", "Direct OAuth canary accepts only the Readonly Federated OAuth contract.");
  }
  const authenticate = options.authenticate ?? createOAuthAuthenticator(authConfig, options.authenticator_options);
  const configuredMetadataUrl = new URL(protectedResourceMetadataUrl(authConfig.resource_url));
  const activeRequests = new Set<Promise<void>>();

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://direct-oauth-canary.local");
    if (request.method === "GET" && url.pathname === "/healthz" && url.search === "") {
      sendJson(response, 200, { ok: true, service: "direct-oauth-canary", version: DIRECT_OAUTH_CANARY_VERSION });
      return;
    }
    const metadataPath = request.method === "GET" && url.search === "" && (
      url.pathname === "/.well-known/oauth-protected-resource"
      || url.pathname === "/.well-known/oauth-protected-resource/mcp"
      || url.pathname === configuredMetadataUrl.pathname
    );
    if (metadataPath) {
      sendJson(response, 200, protectedResourceMetadata(authConfig, [DIRECT_OAUTH_CANARY_SCOPE]));
      return;
    }
    if (url.pathname !== "/mcp" || request.method !== "POST") {
      sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route was not found." } });
      return;
    }

    try {
      const actor = await authenticate(request);
      requireScope(actor, DIRECT_OAUTH_CANARY_SCOPE);
    } catch (error) {
      const safe = errorBody(error);
      const insufficientScope = safe.code === "INSUFFICIENT_SCOPE";
      const challenge = wwwAuthenticate(
        authConfig,
        insufficientScope ? "insufficient_scope" : safe.code === "AUTH_REQUIRED" ? "invalid_request" : "invalid_token",
        insufficientScope ? { scope: DIRECT_OAUTH_CANARY_SCOPE, error_description: safe.message } : {}
      );
      sendJson(response, insufficientScope ? 403 : 401, {
        jsonrpc: "2.0", id: null, error: { code: insufficientScope ? -32003 : -32001, message: safe.message, data: safe }
      }, { "www-authenticate": challenge });
      return;
    }

    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = await readJsonBody(request);
    } catch (error) {
      const safe = errorBody(error);
      sendJson(response, safe.code === "BODY_TOO_LARGE" ? 413 : 400, {
        jsonrpc: "2.0", id: null, error: { code: -32700, message: safe.message, data: safe }
      });
      return;
    }

    const app = createCanaryMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await app.connect(withToolSecuritySchemes(transport, { [DIRECT_OAUTH_CANARY_TOOL]: DIRECT_OAUTH_CANARY_SCOPE }));
      await transport.handleRequest(request, response, parsedBody);
    } catch {
      if (!response.headersSent) sendJson(response, 500, {
        jsonrpc: "2.0", id: safeJsonRpcId(parsedBody.id), error: { code: -32603, message: "Internal MCP canary error." }
      });
    } finally {
      await Promise.allSettled([transport.close(), app.close()]);
    }
  };

  const server = createServer((request, response) => {
    const task = handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: { code: "DIRECT_OAUTH_CANARY_ERROR", message: "Canary request failed." } });
      else if (!response.writableEnded) response.end();
    });
    activeRequests.add(task);
    void task.finally(() => activeRequests.delete(task)).catch(() => undefined);
  });
  const host = options.host ?? DEFAULT_HOST;
  const port = await listen(server, host, options.port ?? DEFAULT_PORT);
  const clientHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return {
    host,
    port,
    mcp_url: `http://${clientHost}:${port}/mcp`,
    close: async () => {
      await close(server);
      await Promise.allSettled([...activeRequests]);
    }
  };
}
