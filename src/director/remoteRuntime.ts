import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JWTVerifyGetKey } from "jose";

import {
  DIRECTOR_BRIDGE_MAX_BODY_BYTES,
  DirectorBridgeBroker,
  DirectorBridgeReplayGuard,
  type DirectorBridgeKeyring
} from "./bridge.js";
import { createDirectorNativeMcpServer, DIRECTOR_NATIVE_TOOL_CATALOG, type DirectorNativeToolHandlers } from "./mcpContract.js";
import {
  createDirectorOAuthAuthenticator,
  directorProtectedResourceMetadata,
  directorProtectedResourceMetadataUrl,
  directorWwwAuthenticate,
  type DirectorOAuthConfig
} from "./oauth.js";
import type { PinnedHttpsRuntime } from "../net/pinnedHttpsTransport.js";
import { withToolSecuritySchemes } from "../webgpt-v4/securityTransport.js";
import { errorBody, requireScope, type WebGptV4Actor } from "../webgpt-v4/types.js";
import type { WebGptV4Authenticator } from "../webgpt-v4/auth.js";

export const DIRECTOR_REMOTE_SERVICE_VERSION = "director-remote-v1.0.0";
export const DIRECTOR_REMOTE_MCP_PATH = "/director/mcp";
export const DIRECTOR_BRIDGE_POLL_PATH = "/director/bridge/v1/poll";
export const DIRECTOR_BRIDGE_COMPLETE_PATH = "/director/bridge/v1/complete";

export interface StartDirectorRemoteRuntimeOptions {
  host?: string;
  port?: number;
  auth_config?: DirectorOAuthConfig | null;
  authenticate?: WebGptV4Authenticator;
  auth_jwks?: JWTVerifyGetKey;
  auth_transport?: PinnedHttpsRuntime;
  bridge_keyring: DirectorBridgeKeyring;
  now?: () => Date;
  max_mcp_body_bytes?: number;
}

export interface DirectorRemoteRuntime {
  host: string;
  port: number;
  origin: string;
  mcp_url: string;
  bridge_connected: () => boolean;
  close: () => Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function jsonBody(request: IncomingMessage, maximum: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maximum) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new Error("INVALID_JSON_BODY");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error("INVALID_JSON_BODY"); }
}

function contentTypeIsJson(request: IncomingMessage): boolean {
  return /^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "");
}

function safeRpcId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function startDirectorRemoteRuntime(options: StartDirectorRemoteRuntimeOptions): Promise<DirectorRemoteRuntime> {
  const host = options.host ?? "127.0.0.1";
  const now = options.now ?? (() => new Date());
  const authConfig = options.auth_config ?? null;
  const authenticate = options.authenticate ?? (authConfig
    ? createDirectorOAuthAuthenticator(authConfig, { jwks: options.auth_jwks, jwks_transport: options.auth_transport })
    : async () => { throw new Error("AUTH_NOT_CONFIGURED"); });
  const broker = new DirectorBridgeBroker(options.bridge_keyring, now);
  const pollReplay = new DirectorBridgeReplayGuard();
  const activeRequests = new Set<Promise<void>>();
  const actorCounts = new Map<string, number>();
  let active = 0;
  let activeBridgeRequests = 0;

  const handlersFor = (actor: WebGptV4Actor): DirectorNativeToolHandlers => Object.fromEntries(
    DIRECTOR_NATIVE_TOOL_CATALOG.map((entry) => [entry.name, (input: unknown) => broker.submit(actor, entry.name, input)])
  ) as unknown as DirectorNativeToolHandlers;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true, service: "director-remote-mcp", version: DIRECTOR_REMOTE_SERVICE_VERSION });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const checks = { oauth: Boolean(authConfig), local_bridge: broker.connected() };
      const ok = Object.values(checks).every(Boolean);
      sendJson(response, ok ? 200 : 503, { ok, service: "director-remote-mcp", version: DIRECTOR_REMOTE_SERVICE_VERSION, checks, database_attached: false, provider_calls_allowed: false });
      return;
    }
    const metadataPath = authConfig
      ? new URL(directorProtectedResourceMetadataUrl(authConfig)).pathname
      : "/.well-known/oauth-protected-resource/director/mcp";
    if (request.method === "GET" && (url.pathname === metadataPath || url.pathname === "/.well-known/oauth-protected-resource/director/mcp")) {
      sendJson(response, 200, directorProtectedResourceMetadata(authConfig));
      return;
    }
    if (request.method === "POST" && (url.pathname === DIRECTOR_BRIDGE_POLL_PATH || url.pathname === DIRECTOR_BRIDGE_COMPLETE_PATH)) {
      if (!contentTypeIsJson(request)) {
        sendJson(response, 415, { ok: false, error: { code: "DIRECTOR_BRIDGE_CONTENT_TYPE_REQUIRED", message: "Director bridge requires application/json." } });
        return;
      }
      if (activeBridgeRequests >= 2) {
        sendJson(response, 429, { ok: false, error: { code: "DIRECTOR_BRIDGE_BUSY", message: "Director bridge request capacity is full." } }, { "retry-after": "1" });
        return;
      }
      activeBridgeRequests += 1;
      try {
        const body = await jsonBody(request, url.pathname === DIRECTOR_BRIDGE_POLL_PATH ? 8 * 1024 : DIRECTOR_BRIDGE_MAX_BODY_BYTES);
        if (url.pathname === DIRECTOR_BRIDGE_POLL_PATH) {
          broker.authenticatePoll(body, pollReplay);
          const next = broker.poll();
          if (!next) { response.writeHead(204, { "cache-control": "no-store" }); response.end(); return; }
          sendJson(response, 200, next);
          return;
        }
        broker.complete(body);
        sendJson(response, 202, { ok: true });
      } catch (error) {
        const safe = errorBody(error);
        const tooLarge = error instanceof Error && error.message === "BODY_TOO_LARGE";
        sendJson(response, tooLarge ? 413 : 401, { ok: false, error: { code: tooLarge ? "DIRECTOR_BRIDGE_BODY_TOO_LARGE" : safe.code, message: "Director bridge request was rejected." } });
      } finally {
        activeBridgeRequests -= 1;
      }
      return;
    }
    if (url.pathname !== DIRECTOR_REMOTE_MCP_PATH) {
      sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route was not found." } });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Director MCP accepts POST requests only." } }, { allow: "POST" });
      return;
    }
    if (!contentTypeIsJson(request)) {
      sendJson(response, 415, { ok: false, error: { code: "CONTENT_TYPE_REQUIRED", message: "Director MCP requires application/json." } });
      return;
    }
    let actor: WebGptV4Actor;
    try {
      actor = await authenticate(request);
      requireScope(actor, "projects.read");
    } catch (error) {
      const safe = errorBody(error);
      const insufficient = safe.code === "INSUFFICIENT_SCOPE";
      const challenge = directorWwwAuthenticate(authConfig, insufficient ? "insufficient_scope" : "invalid_token", insufficient ? { scope: "projects.read", error_description: safe.message } : {});
      sendJson(response, insufficient ? 403 : 401, {
        jsonrpc: "2.0", id: null, error: { code: -32001, message: safe.message, data: { ...safe, _meta: { "mcp/www_authenticate": [challenge] } } }
      }, { "www-authenticate": challenge });
      return;
    }
    const principalActive = actorCounts.get(actor.principal_id) ?? 0;
    if (active >= 8 || principalActive >= 4) {
      sendJson(response, 429, { jsonrpc: "2.0", id: null, error: { code: -32004, message: "Director request capacity is busy.", data: { code: "DIRECTOR_REMOTE_BUSY", retryable: true } } }, { "retry-after": "1" });
      return;
    }
    active += 1;
    actorCounts.set(actor.principal_id, principalActive + 1);
    let app: ReturnType<typeof createDirectorNativeMcpServer> | null = null;
    let transport: StreamableHTTPServerTransport | null = null;
    let parsed: unknown;
    try {
      parsed = await jsonBody(request, options.max_mcp_body_bytes ?? 1024 * 1024);
      app = createDirectorNativeMcpServer(actor, handlersFor(actor), { auth_config: authConfig });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const scopes = Object.fromEntries(DIRECTOR_NATIVE_TOOL_CATALOG.map((entry) => [entry.name, entry.scope]));
      await app.connect(withToolSecuritySchemes(transport, scopes));
      await transport.handleRequest(request, response, parsed);
    } catch (error) {
      const code = error instanceof Error && error.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "DIRECTOR_REMOTE_MCP_ERROR";
      if (!response.headersSent) sendJson(response, code === "BODY_TOO_LARGE" ? 413 : 500, {
        jsonrpc: "2.0", id: safeRpcId((parsed as Record<string, unknown> | undefined)?.id), error: { code: -32603, message: code, data: { code } }
      });
    } finally {
      await Promise.allSettled([...(transport ? [transport.close()] : []), ...(app ? [app.close()] : [])]);
      active -= 1;
      const remaining = (actorCounts.get(actor.principal_id) ?? 1) - 1;
      if (remaining <= 0) actorCounts.delete(actor.principal_id); else actorCounts.set(actor.principal_id, remaining);
    }
  };

  const server = createServer((request, response) => {
    const task = handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: { code: "DIRECTOR_REMOTE_INTERNAL_ERROR", message: "Director runtime request failed." } });
      else if (!response.writableEnded) response.end();
    });
    activeRequests.add(task);
    void task.finally(() => activeRequests.delete(task)).catch(() => undefined);
  });
  const port = await listen(server, host, options.port ?? 0);
  const origin = `http://${host}:${port}`;
  return {
    host, port, origin, mcp_url: `${origin}${DIRECTOR_REMOTE_MCP_PATH}`,
    bridge_connected: () => broker.connected(),
    close: async () => { broker.close(); await closeServer(server); await Promise.allSettled([...activeRequests]); }
  };
}
