import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { openM0Database, openM0DatabaseConnection } from "../storage/sqlite.js";
import { loadWebGptV4AuthConfig, createAuth0Authenticator, createAuth0MediaAuthenticator, protectedResourceMetadata, unavailableAuthenticator, wwwAuthenticate, type WebGptV4AuthConfig, type WebGptV4Authenticator } from "./auth.js";
import { errorBody, WEBGPT_V4_VERSION } from "./types.js";
import { createWebGptV4McpApp, WEBGPT_V4_TOOL_SCOPES } from "./mcpApp.js";
import { handleMediaGatewayRequest, invalidateMediaGrantsForRestart, type MediaRuntimeOptions } from "./media.js";
import { migrateLegacyWebGptV4History } from "./migration.js";
import { withToolSecuritySchemes } from "./securityTransport.js";

export const WEBGPT_V4_HOST = "127.0.0.1";
export const WEBGPT_V4_MCP_PORT = 2091;
export const WEBGPT_V4_MEDIA_PORT = 2092;

export interface StartWebGptV4Options {
  mcp_port?: number;
  media_port?: number;
  sqlite_path?: string;
  data_root?: string;
  auth_config?: WebGptV4AuthConfig | null;
  authenticate?: WebGptV4Authenticator;
  authenticate_media?: WebGptV4Authenticator;
  media?: MediaRuntimeOptions;
  max_body_bytes?: number;
}

export interface WebGptV4Runtime {
  mcp_port: number;
  media_port: number;
  mcp_url: string;
  media_url: string;
  auth_configured: boolean;
  invalidated_media_grants: number;
  migration: ReturnType<typeof migrateLegacyWebGptV4History>;
  close: () => Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage, maximum: number): Promise<Record<string, unknown> | undefined> {
  if (request.method !== "POST") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_JSON_BODY");
  return parsed as Record<string, unknown>;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, WEBGPT_V4_HOST, () => {
      server.off("error", reject);
      resolveListen((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function decodedPathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("INVALID_MEDIA_PATH");
  }
}

const MCP_WRITE_TOOLS = new Set([
  "inspect_media",
  "update_shot_copy",
  "add_review_note",
  "submit_production_proposal",
  "revise_production_proposal",
  "close_production_proposal",
  "prepare_generation_intent"
]);

function mcpRequestNeedsWrite(parsedBody: Record<string, unknown> | undefined): boolean {
  if (parsedBody?.method !== "tools/call") return false;
  const params = parsedBody.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  return MCP_WRITE_TOOLS.has(String((params as Record<string, unknown>).name ?? ""));
}

export async function startWebGptV4(options: StartWebGptV4Options = {}): Promise<WebGptV4Runtime> {
  const authConfig = options.auth_config === undefined ? loadWebGptV4AuthConfig() : options.auth_config;
  const authenticate = options.authenticate ?? (authConfig ? createAuth0Authenticator(authConfig) : unavailableAuthenticator());
  const authenticateMedia = options.authenticate_media ?? (authConfig
    ? createAuth0MediaAuthenticator(authConfig, process.env.WEBGPT_V4_MEDIA_AUTH_COOKIE_NAME?.trim() || undefined)
    : unavailableAuthenticator());
  const maximum = options.max_body_bytes ?? 1024 * 1024;
  const bootstrapDb = openM0Database(options.sqlite_path);
  const migration = migrateLegacyWebGptV4History(bootstrapDb, options.data_root);
  const invalidatedMediaGrants = invalidateMediaGrantsForRestart(bootstrapDb);
  bootstrapDb.close();

  const activeRequests = new Set<Promise<void>>();
  const trackRequest = (task: Promise<void>): void => {
    activeRequests.add(task);
    void task.finally(() => activeRequests.delete(task)).catch(() => undefined);
  };

  const handleMcpRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${WEBGPT_V4_HOST}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true, service: "webgpt-v4-mcp", version: WEBGPT_V4_VERSION });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      sendJson(response, authConfig ? 200 : 503, { ok: Boolean(authConfig), service: "webgpt-v4-mcp", auth_configured: Boolean(authConfig), provider_calls_allowed: false });
      return;
    }
    if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      sendJson(response, 200, protectedResourceMetadata(authConfig));
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route was not found." } });
      return;
    }

    let actor;
    try {
      actor = await authenticate(request);
    } catch (error) {
      const safe = errorBody(error);
      sendJson(response, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: safe.message, data: safe } }, { "www-authenticate": wwwAuthenticate(authConfig, safe.code === "AUTH_REQUIRED" ? "invalid_request" : "invalid_token") });
      return;
    }

    let parsedBody: Record<string, unknown> | undefined;
    try {
      parsedBody = await body(request, maximum);
    } catch (error) {
      const code = error instanceof Error && error.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_JSON_BODY";
      sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: code, data: { code } } });
      return;
    }

    const db = openM0DatabaseConnection(options.sqlite_path, { readOnly: !mcpRequestNeedsWrite(parsedBody) });
    const app = createWebGptV4McpApp({ db, actor, auth_config: authConfig, media: options.media });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const securedTransport = withToolSecuritySchemes(transport, WEBGPT_V4_TOOL_SCOPES);
    try {
      await app.connect(securedTransport);
      await transport.handleRequest(request, response, parsedBody);
    } catch {
      if (!response.headersSent) sendJson(response, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal MCP server error." } });
    } finally {
      await Promise.allSettled([transport.close(), app.close()]);
      db.close();
    }
  };

  const mcpServer = createServer((request, response) => {
    trackRequest(handleMcpRequest(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal MCP server error." } });
      else if (!response.writableEnded) response.end();
    }));
  });

  const handleMediaRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${WEBGPT_V4_HOST}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true, service: "webgpt-v4-media", version: WEBGPT_V4_VERSION });
      return;
    }
    const match = /^\/media\/v4\/projects\/([^/]+)\/artifacts\/([^/]+)\/content$/.exec(url.pathname);
    if (!match) {
      sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Media route was not found." } });
      return;
    }
    let actor;
    try {
      actor = await authenticateMedia(request);
    } catch (error) {
      const safe = errorBody(error);
      sendJson(response, 401, { ok: false, error: safe }, { "www-authenticate": wwwAuthenticate(authConfig, safe.code === "AUTH_REQUIRED" ? "invalid_request" : "invalid_token") });
      return;
    }
    let projectId: string;
    let artifactId: string;
    try {
      projectId = decodedPathSegment(match[1]);
      artifactId = decodedPathSegment(match[2]);
    } catch {
      sendJson(response, 400, { ok: false, error: { code: "INVALID_MEDIA_PATH", message: "Media route contains an invalid path segment." } });
      return;
    }
    const db = openM0DatabaseConnection(options.sqlite_path, { readOnly: true });
    try {
      handleMediaGatewayRequest(request, response, {
        project_id: projectId,
        artifact_id: artifactId,
        token: url.searchParams.get("grant") ?? "",
        actor_hash: actor.actor_hash,
        db,
        allowed_origin: process.env.WEBGPT_V4_WIDGET_ORIGIN?.trim(),
        options: options.media
      });
    } finally {
      db.close();
    }
  };

  const mediaServer = createServer((request, response) => {
    trackRequest(handleMediaRequest(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: { code: "MEDIA_GATEWAY_ERROR", message: "Media request failed." } });
      else if (!response.writableEnded) response.end();
    }));
  });

  const [mcpPort, mediaPort] = await Promise.all([
    listen(mcpServer, options.mcp_port ?? WEBGPT_V4_MCP_PORT),
    listen(mediaServer, options.media_port ?? WEBGPT_V4_MEDIA_PORT)
  ]);
  return {
    mcp_port: mcpPort,
    media_port: mediaPort,
    mcp_url: `http://${WEBGPT_V4_HOST}:${mcpPort}/mcp`,
    media_url: `http://${WEBGPT_V4_HOST}:${mediaPort}`,
    auth_configured: Boolean(authConfig),
    invalidated_media_grants: invalidatedMediaGrants,
    migration,
    close: async () => {
      await Promise.all([close(mcpServer), close(mediaServer)]);
      await Promise.allSettled([...activeRequests]);
    }
  };
}
