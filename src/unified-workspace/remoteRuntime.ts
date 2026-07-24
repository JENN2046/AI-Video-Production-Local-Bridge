import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JWTVerifyGetKey } from "jose";

import {
  DIRECTOR_BRIDGE_MAX_BODY_BYTES,
  DirectorBridgeBroker,
  DirectorBridgeError,
  DirectorBridgeReplayGuard,
  type DirectorBridgeKeyring
} from "../director/bridge.js";
import { registerDirectorNativeTools, DIRECTOR_NATIVE_TOOL_CATALOG, type DirectorNativeToolHandlers } from "../director/mcpContract.js";
import type { PinnedHttpsRuntime } from "../net/pinnedHttpsTransport.js";
import {
  assertWebGptV4AuthConfig,
  createOAuthAuthenticator,
  protectedResourceMetadata,
  unavailableAuthenticator,
  wwwAuthenticate,
  type WebGptV4Authenticator,
  type WebGptV4ReadonlyFederatedAuthConfig
} from "../webgpt-v4/auth.js";
import { withToolSecuritySchemes } from "../webgpt-v4/securityTransport.js";
import { errorBody, requireScope, type WebGptV4Actor, type WebGptV4Scope } from "../webgpt-v4/types.js";
import {
  READONLY_REMOTE_PUBLISH_PATH,
  createReadonlyRemoteMcpApp,
  registerReadonlyRemoteMcpApp,
  type ReadonlyRemoteMcpAppOptions
} from "../webgpt-cloud/remoteRuntime.js";
import { READONLY_SNAPSHOT_MAX_BYTES, readonlySnapshotStatus, type ReadonlySnapshot, type ReadonlySnapshotStatus } from "../webgpt-cloud/snapshot.js";
import { ReadonlySnapshotStore, type ReadonlySigningPublicKey } from "../webgpt-cloud/signedSnapshot.js";
import type { ReadonlyMediaGatewayClientOptions } from "../webgpt-cloud/mediaGatewayClient.js";
import {
  UNIFIED_WORKSPACE_MCP_PATH,
  createUnifiedWorkspaceOAuthAuthenticator,
  unifiedWorkspaceProtectedResourceMetadata,
  unifiedWorkspaceProtectedResourceMetadataUrl,
  unifiedWorkspaceWwwAuthenticate,
  type UnifiedWorkspaceOAuthConfig
} from "./oauth.js";
import { unifiedWorkspaceToolScopes } from "./toolCatalog.js";

export const UNIFIED_WORKSPACE_REMOTE_SERVICE_VERSION = "unified-workspace-remote-v1.0.0";
export const UNIFIED_WORKSPACE_SNAPSHOT_PUBLISH_PATH = "/workspace/snapshot";
export const UNIFIED_WORKSPACE_BRIDGE_POLL_PATH = "/director/bridge/v1/poll";
export const UNIFIED_WORKSPACE_BRIDGE_COMPLETE_PATH = "/director/bridge/v1/complete";

export interface UnifiedWorkspaceRemoteLogEvent {
  timestamp: string;
  correlation_id: string;
  event_type: "health" | "readiness" | "oauth_metadata" | "mcp" | "snapshot_publish" | "bridge" | "auth_failure" | "not_found";
  http_status: number;
  stable_error_code?: string;
  rate_limit_event: boolean;
  latency_bucket: "lt_10ms" | "lt_50ms" | "lt_250ms" | "lt_1s" | "gte_1s";
  workspace_snapshot_status: ReadonlySnapshotStatus["freshness_status"];
  legacy_snapshot_status: ReadonlySnapshotStatus["freshness_status"];
  bridge_connected: boolean;
  boot_id_prefix: string;
}

export type UnifiedWorkspaceRemoteLogSink = (event: UnifiedWorkspaceRemoteLogEvent) => void;

export interface UnifiedWorkspaceLegacyReadonlyOptions {
  auth_config?: WebGptV4ReadonlyFederatedAuthConfig | null;
  authenticate?: WebGptV4Authenticator;
  auth_jwks?: JWTVerifyGetKey;
  auth_transport?: PinnedHttpsRuntime;
  publisher_key_id?: string;
  publisher_public_key?: ReadonlySigningPublicKey;
  media_gateway?: ReadonlyMediaGatewayClientOptions;
}

export interface StartUnifiedWorkspaceRemoteRuntimeOptions {
  host?: string;
  port?: number;
  auth_config?: UnifiedWorkspaceOAuthConfig | null;
  authenticate?: WebGptV4Authenticator;
  auth_jwks?: JWTVerifyGetKey;
  auth_transport?: PinnedHttpsRuntime;
  publisher_key_id?: string;
  publisher_public_key?: ReadonlySigningPublicKey;
  bridge_keyring?: DirectorBridgeKeyring | null;
  media_gateway?: ReadonlyMediaGatewayClientOptions;
  legacy_readonly?: UnifiedWorkspaceLegacyReadonlyOptions;
  max_mcp_body_bytes?: number;
  max_publish_body_bytes?: number;
  publish_requests_per_minute?: number;
  now?: () => Date;
  log?: UnifiedWorkspaceRemoteLogSink;
}

export interface UnifiedWorkspaceRemoteRuntime {
  host: string;
  port: number;
  origin: string;
  mcp_url: string;
  snapshot_url: string;
  legacy_mcp_url: string | null;
  legacy_snapshot_url: string | null;
  snapshot_status: () => ReadonlySnapshotStatus;
  bridge_connected: () => boolean;
  close: () => Promise<void>;
}

interface McpRoute {
  path: string;
  metadata_path: string;
  metadata: () => Record<string, unknown>;
  auth_config: WebGptV4ReadonlyFederatedAuthConfig | null;
  authenticate: WebGptV4Authenticator;
  challenge: (error: ReturnType<typeof errorBody>) => string;
  store: ReadonlySnapshotStore | null;
  app: (actor: WebGptV4Actor, snapshot: ReadonlySnapshot | null) => McpServer;
  tool_scopes: Record<string, readonly WebGptV4Scope[]>;
  publish_path: string;
  publish_limiter: WindowLimiter;
}

class WindowLimiter {
  private readonly windows = new Map<string, { started_at: number; count: number }>();
  private static readonly MAXIMUM_TRACKED_KEYS = 1024;

  constructor(private readonly maximum: number, private readonly now: () => Date) {}

  allow(key: string): boolean {
    const currentTime = this.now().getTime();
    for (const [trackedKey, window] of this.windows) {
      if (currentTime - window.started_at >= 60_000) this.windows.delete(trackedKey);
    }
    const current = this.windows.get(key);
    if (!current) {
      if (this.windows.size >= WindowLimiter.MAXIMUM_TRACKED_KEYS) return false;
      this.windows.set(key, { started_at: currentTime, count: 1 });
      return true;
    }
    if (current.count >= this.maximum) return false;
    current.count += 1;
    return true;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function jsonBody(request: IncomingMessage, maximum: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximum) throw new Error("BODY_TOO_LARGE");
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

function latencyBucket(milliseconds: number): UnifiedWorkspaceRemoteLogEvent["latency_bucket"] {
  if (milliseconds < 10) return "lt_10ms";
  if (milliseconds < 50) return "lt_50ms";
  if (milliseconds < 250) return "lt_250ms";
  if (milliseconds < 1_000) return "lt_1s";
  return "gte_1s";
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

function buildSnapshotStore(
  keyId: string | undefined,
  publicKey: ReadonlySigningPublicKey | undefined,
  now: () => Date,
  authConfig: WebGptV4ReadonlyFederatedAuthConfig | null
): ReadonlySnapshotStore | null {
  if (!keyId || !publicKey) return null;
  return new ReadonlySnapshotStore(keyId, publicKey, now, authConfig
    ? { resource_url: authConfig.resource_url, issuer_hash: authConfig.issuer_hash }
    : undefined);
}

function readonlyToolScopes(): Record<string, readonly WebGptV4Scope[]> {
  return {
    render_ai_video_workspace_app: ["projects.read"],
    list_production_projects: ["projects.read"],
    get_project_context: ["projects.read"],
    list_project_shots: ["projects.read"],
    get_review_package: ["projects.read"],
    get_delivery_status: ["projects.read"],
    get_closeout_evidence: ["projects.read"],
    get_readonly_media_playback: ["projects.read"]
  };
}

/**
 * Hosts the future `/workspace/mcp` connector and, when legacy options are
 * supplied, the accepted `/mcp` rollback surface in the same process.  The
 * two routes deliberately own independent snapshot stores and OAuth
 * audiences: a signed Snapshot can never be replayed across resources.
 */
export async function startUnifiedWorkspaceRemoteRuntime(options: StartUnifiedWorkspaceRemoteRuntimeOptions = {}): Promise<UnifiedWorkspaceRemoteRuntime> {
  const host = options.host ?? "127.0.0.1";
  const now = options.now ?? (() => new Date());
  const authConfig = options.auth_config ?? null;
  if (authConfig) assertWebGptV4AuthConfig(authConfig);
  const authenticate = options.authenticate ?? (authConfig
    ? createUnifiedWorkspaceOAuthAuthenticator(authConfig, { jwks: options.auth_jwks, jwks_transport: options.auth_transport })
    : unavailableAuthenticator());
  const workspaceStore = buildSnapshotStore(options.publisher_key_id, options.publisher_public_key, now, authConfig);
  const legacy = options.legacy_readonly;
  const legacyAuthConfig = legacy?.auth_config ?? null;
  if (legacyAuthConfig) assertWebGptV4AuthConfig(legacyAuthConfig);
  const legacyAuthenticate = legacy?.authenticate ?? (legacyAuthConfig
    ? createOAuthAuthenticator(legacyAuthConfig, { jwks: legacy?.auth_jwks, jwks_transport: legacy?.auth_transport })
    : unavailableAuthenticator());
  const legacyStore = buildSnapshotStore(legacy?.publisher_key_id, legacy?.publisher_public_key, now, legacyAuthConfig);
  const broker = options.bridge_keyring ? new DirectorBridgeBroker(options.bridge_keyring, now) : null;
  const pollReplay = new DirectorBridgeReplayGuard();
  const activeRequests = new Set<Promise<void>>();
  const actorCounts = new Map<string, number>();
  const maxMcpBody = options.max_mcp_body_bytes ?? 1024 * 1024;
  const maxPublishBody = options.max_publish_body_bytes ?? READONLY_SNAPSHOT_MAX_BYTES + 64 * 1024;
  const publishRequestsPerMinute = options.publish_requests_per_minute ?? 12;
  const bootIdPrefix = randomUUID().replace(/-/g, "").slice(0, 8);
  const log = options.log ?? ((event: UnifiedWorkspaceRemoteLogEvent) => process.stdout.write(`${JSON.stringify(event)}\n`));
  let activeMcp = 0;
  let activeBridge = 0;

  const directorHandlersFor = (actor: WebGptV4Actor): DirectorNativeToolHandlers => Object.fromEntries(
    DIRECTOR_NATIVE_TOOL_CATALOG.map((entry) => [entry.name, (input: unknown) => {
      if (!broker || !broker.connected()) {
        return Promise.reject(new DirectorBridgeError("DIRECTOR_BRIDGE_UNAVAILABLE", "Local Director bridge is unavailable.", undefined, true));
      }
      return broker.submit(actor, entry.name, input);
    }])
  ) as unknown as DirectorNativeToolHandlers;

  const workspaceRoute: McpRoute = {
    path: UNIFIED_WORKSPACE_MCP_PATH,
    metadata_path: authConfig ? new URL(unifiedWorkspaceProtectedResourceMetadataUrl(authConfig)).pathname : `/.well-known/oauth-protected-resource${UNIFIED_WORKSPACE_MCP_PATH}`,
    metadata: () => unifiedWorkspaceProtectedResourceMetadata(authConfig),
    auth_config: authConfig,
    authenticate,
    challenge: (error) => unifiedWorkspaceWwwAuthenticate(authConfig, error.code === "INSUFFICIENT_SCOPE" ? "insufficient_scope" : error.code === "AUTH_REQUIRED" ? "invalid_request" : "invalid_token", error.code === "INSUFFICIENT_SCOPE" ? { scope: "projects.read", error_description: error.message } : {}),
    store: workspaceStore,
    tool_scopes: unifiedWorkspaceToolScopes(true),
    publish_path: UNIFIED_WORKSPACE_SNAPSHOT_PUBLISH_PATH,
    publish_limiter: new WindowLimiter(publishRequestsPerMinute, now),
    app: (actor, snapshot) => {
      const app = new McpServer(
        { name: "ai-video-production-workspace", version: UNIFIED_WORKSPACE_REMOTE_SERVICE_VERSION },
        { instructions: "AI Video Production Workspace combines a readonly signed Snapshot with a local Director bridge. It never approves, spends, calls a Provider, overwrites Artifacts, delivers media, or commits memory." }
      );
      const readonlyOptions: ReadonlyRemoteMcpAppOptions = {
        service_version: UNIFIED_WORKSPACE_REMOTE_SERVICE_VERSION,
        resource_name: "AI Video Production Workspace",
        resource_description: "Signed-snapshot production workbench with read-only Director status.",
        widget_description: "Open Jenn's signed-snapshot production workbench and its local Director advisory status.",
        render_title: "打开 AI 视频生产工作台",
        render_description: "Open the unified ChatGPT MCP App shell. Project data and Director status are loaded only through bounded tools.",
        render_summary: "AI 视频生产工作台已打开；数据与 Director 状态由 Widget 按需读取。",
        director_status: () => ({ state: broker?.connected() ? "available" : "unavailable", bridge_connected: broker?.connected() ?? false })
      };
      registerReadonlyRemoteMcpApp(app, actor, snapshot, authConfig, now, options.media_gateway, readonlyOptions);
      registerDirectorNativeTools(app, actor, directorHandlersFor(actor), {
        auth_config: authConfig,
        resource_metadata_url: `/.well-known/oauth-protected-resource${UNIFIED_WORKSPACE_MCP_PATH}`,
        app_visible_tools: ["get_director_focus"]
      });
      return app;
    }
  };

  const legacyRoute: McpRoute | null = legacy ? {
    path: "/mcp",
    metadata_path: legacyAuthConfig ? `/.well-known/oauth-protected-resource${new URL(legacyAuthConfig.resource_url).pathname}` : "/.well-known/oauth-protected-resource/mcp",
    metadata: () => protectedResourceMetadata(legacyAuthConfig, ["projects.read"]),
    auth_config: legacyAuthConfig,
    authenticate: legacyAuthenticate,
    challenge: (error) => wwwAuthenticate(
      legacyAuthConfig,
      error.code === "INSUFFICIENT_SCOPE" ? "insufficient_scope" : error.code === "AUTH_REQUIRED" ? "invalid_request" : "invalid_token",
      error.code === "INSUFFICIENT_SCOPE" ? { scope: "projects.read", error_description: error.message } : {}
    ),
    store: legacyStore,
    tool_scopes: readonlyToolScopes(),
    publish_path: READONLY_REMOTE_PUBLISH_PATH,
    publish_limiter: new WindowLimiter(publishRequestsPerMinute, now),
    app: (actor, snapshot) => createReadonlyRemoteMcpApp(actor, snapshot, legacyAuthConfig, now, legacy?.media_gateway)
  } : null;
  const routes = [workspaceRoute, ...(legacyRoute ? [legacyRoute] : [])];

  const statusFor = (store: ReadonlySnapshotStore | null): ReadonlySnapshotStatus => readonlySnapshotStatus(store?.read() ?? null, now());

  const handlePublish = async (request: IncomingMessage, response: ServerResponse, route: McpRoute): Promise<string | undefined> => {
    if (!contentTypeIsJson(request)) {
      const code = "READONLY_SNAPSHOT_PUBLISH_CONTENT_TYPE_REQUIRED";
      sendJson(response, 415, { ok: false, error: { code, message: "Snapshot publish requires application/json." } });
      return code;
    }
    if (!route.auth_config) {
      const code = "READONLY_SNAPSHOT_PUBLISH_AUTH_NOT_CONFIGURED";
      sendJson(response, 503, { ok: false, error: { code, message: "Readonly OAuth is not configured." } });
      return code;
    }
    if (!route.store) {
      const code = "READONLY_SNAPSHOT_PUBLISH_NOT_CONFIGURED";
      sendJson(response, 503, { ok: false, error: { code, message: "Snapshot verification is not configured." } });
      return code;
    }
    if (!route.publish_limiter.allow(request.socket.remoteAddress ?? "unknown")) {
      const code = "READONLY_SNAPSHOT_PUBLISH_RATE_LIMITED";
      sendJson(response, 429, { ok: false, error: { code, message: "Snapshot publish capacity is busy." } }, { "retry-after": "60" });
      return code;
    }
    try {
      const published = route.store.replace(await jsonBody(request, maxPublishBody));
      sendJson(response, 202, { ok: true, snapshot_fingerprint: published.snapshot_fingerprint, generated_at: published.generated_at, expires_at: published.expires_at });
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : "READONLY_SNAPSHOT_PUBLISH_INVALID";
      const code = message === "BODY_TOO_LARGE"
        ? "READONLY_SNAPSHOT_PUBLISH_BODY_TOO_LARGE"
        : /^READONLY_|^JCS_/.test(message) ? message : "READONLY_SNAPSHOT_PUBLISH_INVALID";
      sendJson(response, message === "BODY_TOO_LARGE" ? 413 : 400, { ok: false, error: { code, message: "Signed readonly snapshot was rejected." } });
      return code;
    }
  };

  const handleBridge = async (request: IncomingMessage, response: ServerResponse, path: string): Promise<string | undefined> => {
    if (!broker) {
      const code = "DIRECTOR_BRIDGE_UNAVAILABLE";
      sendJson(response, 503, { ok: false, error: { code, message: "Local Director bridge is unavailable." } });
      return code;
    }
    if (!contentTypeIsJson(request)) {
      const code = "DIRECTOR_BRIDGE_CONTENT_TYPE_REQUIRED";
      sendJson(response, 415, { ok: false, error: { code, message: "Director bridge requires application/json." } });
      return code;
    }
    if (activeBridge >= 2) {
      const code = "DIRECTOR_BRIDGE_BUSY";
      sendJson(response, 429, { ok: false, error: { code, message: "Director bridge request capacity is full." } }, { "retry-after": "1" });
      return code;
    }
    activeBridge += 1;
    try {
      const body = await jsonBody(request, path === UNIFIED_WORKSPACE_BRIDGE_POLL_PATH ? 8 * 1024 : DIRECTOR_BRIDGE_MAX_BODY_BYTES);
      if (path === UNIFIED_WORKSPACE_BRIDGE_POLL_PATH) {
        broker.authenticatePoll(body, pollReplay);
        const next = broker.poll();
        if (!next) { response.writeHead(204, { "cache-control": "no-store" }); response.end(); return undefined; }
        sendJson(response, 200, next);
        return undefined;
      }
      broker.complete(body);
      sendJson(response, 202, { ok: true });
      return undefined;
    } catch (error) {
      const safe = errorBody(error);
      const tooLarge = error instanceof Error && error.message === "BODY_TOO_LARGE";
      const invalidJson = error instanceof Error && error.message === "INVALID_JSON_BODY";
      const code = tooLarge ? "DIRECTOR_BRIDGE_BODY_TOO_LARGE" : invalidJson ? "DIRECTOR_BRIDGE_INVALID_JSON_BODY" : safe.code;
      sendJson(response, tooLarge ? 413 : invalidJson ? 400 : 401, { ok: false, error: { code, message: "Director bridge request was rejected." } });
      return code;
    } finally {
      activeBridge -= 1;
    }
  };

  const handleMcp = async (request: IncomingMessage, response: ServerResponse, route: McpRoute): Promise<{ stable_error_code?: string; auth_failure: boolean }> => {
    if (request.method !== "POST") {
      const code = "METHOD_NOT_ALLOWED";
      sendJson(response, 405, { ok: false, error: { code, message: "MCP accepts POST requests only." } }, { allow: "POST" });
      return { stable_error_code: code, auth_failure: false };
    }
    if (!contentTypeIsJson(request)) {
      const code = "CONTENT_TYPE_REQUIRED";
      sendJson(response, 415, { ok: false, error: { code, message: "MCP requires application/json." } });
      return { stable_error_code: code, auth_failure: false };
    }
    let actor: WebGptV4Actor;
    try {
      actor = await route.authenticate(request);
      requireScope(actor, "projects.read");
    } catch (error) {
      const safe = errorBody(error);
      const challenge = route.challenge(safe);
      sendJson(response, safe.code === "INSUFFICIENT_SCOPE" ? 403 : 401, {
        jsonrpc: "2.0", id: null, error: { code: -32001, message: safe.message, data: { ...safe, _meta: { "mcp/www_authenticate": [challenge] } } }
      }, { "www-authenticate": challenge });
      return { stable_error_code: safe.code, auth_failure: true };
    }
    const activeForActor = actorCounts.get(actor.principal_id) ?? 0;
    if (activeMcp >= 8 || activeForActor >= 4) {
      sendJson(response, 429, { jsonrpc: "2.0", id: null, error: { code: -32004, message: "Workspace request capacity is busy.", data: { code: "UNIFIED_WORKSPACE_REMOTE_BUSY", retryable: true } } }, { "retry-after": "1" });
      return { stable_error_code: "UNIFIED_WORKSPACE_REMOTE_BUSY", auth_failure: false };
    }
    activeMcp += 1;
    actorCounts.set(actor.principal_id, activeForActor + 1);
    let app: McpServer | null = null;
    let transport: StreamableHTTPServerTransport | null = null;
    let parsed: unknown;
    try {
      try {
        parsed = await jsonBody(request, maxMcpBody);
      } catch (error) {
        const code = error instanceof Error && error.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_JSON_BODY";
        if (!response.headersSent) sendJson(response, code === "BODY_TOO_LARGE" ? 413 : 400, {
          jsonrpc: "2.0", id: null, error: { code: -32700, message: code, data: { code } }
        });
        return { stable_error_code: code, auth_failure: false };
      }
      app = route.app(actor, route.store?.read() ?? null);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await app.connect(withToolSecuritySchemes(transport, route.tool_scopes));
      await transport.handleRequest(request, response, parsed);
    } catch (error) {
      const code = "UNIFIED_WORKSPACE_MCP_ERROR";
      if (!response.headersSent) sendJson(response, 500, {
        jsonrpc: "2.0", id: safeRpcId((parsed as Record<string, unknown> | undefined)?.id), error: { code: -32603, message: code, data: { code } }
      });
      return { stable_error_code: code, auth_failure: false };
    } finally {
      await Promise.allSettled([...(transport ? [transport.close()] : []), ...(app ? [app.close()] : [])]);
      activeMcp -= 1;
      const remaining = (actorCounts.get(actor.principal_id) ?? 1) - 1;
      if (remaining <= 0) actorCounts.delete(actor.principal_id); else actorCounts.set(actor.principal_id, remaining);
    }
    return { auth_failure: false };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const startedAt = Date.now();
    const correlationId = randomUUID();
    let eventType: UnifiedWorkspaceRemoteLogEvent["event_type"] = "not_found";
    let status = 500;
    let stableErrorCode: string | undefined;
    let rateLimitEvent = false;
    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        eventType = "health"; status = 200;
        sendJson(response, status, { ok: true, service: "unified-workspace-mcp", version: UNIFIED_WORKSPACE_REMOTE_SERVICE_VERSION });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        eventType = "readiness";
        const workspaceSnapshot = statusFor(workspaceStore);
        const bridgeConnected = broker?.connected() ?? false;
        const checks = {
          workspace_oauth: Boolean(authConfig),
          workspace_snapshot_fresh: workspaceSnapshot.freshness_status === "fresh",
          director_bridge: bridgeConnected,
          legacy_readonly_enabled: Boolean(legacyRoute)
        };
        const ok = checks.workspace_oauth && (checks.workspace_snapshot_fresh || checks.director_bridge);
        status = ok ? 200 : 503;
        if (!ok) stableErrorCode = "UNIFIED_WORKSPACE_NOT_READY";
        sendJson(response, status, { ok, service: "unified-workspace-mcp", version: UNIFIED_WORKSPACE_REMOTE_SERVICE_VERSION, checks, database_attached: false, provider_calls_allowed: false });
        return;
      }
      for (const route of routes) {
        if (request.method === "GET" && (url.pathname === route.metadata_path || (route === legacyRoute && url.pathname === "/.well-known/oauth-protected-resource"))) {
          eventType = "oauth_metadata"; status = 200; sendJson(response, status, route.metadata()); return;
        }
        if (request.method === "PUT" && url.pathname === route.publish_path) {
          eventType = "snapshot_publish"; stableErrorCode = await handlePublish(request, response, route); status = response.statusCode;
          rateLimitEvent = status === 429;
          return;
        }
        if (url.pathname === route.path) {
          const outcome = await handleMcp(request, response, route);
          eventType = outcome.auth_failure ? "auth_failure" : "mcp";
          stableErrorCode = outcome.stable_error_code;
          status = response.statusCode;
          rateLimitEvent = status === 429;
          return;
        }
      }
      if (request.method === "POST" && (url.pathname === UNIFIED_WORKSPACE_BRIDGE_POLL_PATH || url.pathname === UNIFIED_WORKSPACE_BRIDGE_COMPLETE_PATH)) {
        eventType = "bridge"; stableErrorCode = await handleBridge(request, response, url.pathname); status = response.statusCode;
        rateLimitEvent = status === 429;
        return;
      }
      status = 404; stableErrorCode = "NOT_FOUND";
      sendJson(response, status, { ok: false, error: { code: stableErrorCode, message: "Route was not found." } });
    } finally {
      try {
        log({
          timestamp: now().toISOString(), correlation_id: correlationId, event_type: eventType, http_status: status,
          ...(stableErrorCode ? { stable_error_code: stableErrorCode } : {}),
          rate_limit_event: rateLimitEvent,
          latency_bucket: latencyBucket(Date.now() - startedAt),
          workspace_snapshot_status: statusFor(workspaceStore).freshness_status,
          legacy_snapshot_status: statusFor(legacyStore).freshness_status,
          bridge_connected: broker?.connected() ?? false,
          boot_id_prefix: bootIdPrefix
        });
      } catch {
        // Logging is deliberately non-authoritative.
      }
    }
  };

  const server = createServer((request, response) => {
    const task = handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: { code: "UNIFIED_WORKSPACE_REMOTE_INTERNAL_ERROR", message: "Workspace remote request failed." } });
      else if (!response.writableEnded) response.end();
    });
    activeRequests.add(task);
    void task.finally(() => activeRequests.delete(task)).catch(() => undefined);
  });
  const port = await listen(server, host, options.port ?? 0);
  const origin = `http://${host}:${port}`;
  return {
    host, port, origin,
    mcp_url: `${origin}${UNIFIED_WORKSPACE_MCP_PATH}`,
    snapshot_url: `${origin}${UNIFIED_WORKSPACE_SNAPSHOT_PUBLISH_PATH}`,
    legacy_mcp_url: legacyRoute ? `${origin}${legacyRoute.path}` : null,
    legacy_snapshot_url: legacyRoute ? `${origin}${legacyRoute.publish_path}` : null,
    snapshot_status: () => statusFor(workspaceStore),
    bridge_connected: () => broker?.connected() ?? false,
    close: async () => { broker?.close(); await closeServer(server); await Promise.allSettled([...activeRequests]); }
  };
}
