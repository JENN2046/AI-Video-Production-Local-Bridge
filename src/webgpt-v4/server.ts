import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { openM0Database, openM0DatabaseConnection, type M0Database } from "../storage/sqlite.js";
import { assertSchemaCurrent, SchemaMigrationRequiredError } from "../storage/migrations.js";
import { paths } from "../paths.js";
import { loadWebGptV4AuthConfig, createOAuthAuthenticator, createAuth0MediaAuthenticator, protectedResourceMetadata, protectedResourceMetadataUrl, unavailableAuthenticator, wwwAuthenticate, type WebGptV4AuthConfig, type WebGptV4Authenticator } from "./auth.js";
import { errorBody, WEBGPT_V4_VERSION, WebGptV4Error } from "./types.js";
import { createWebGptV4McpApp } from "./mcpApp.js";
import { webGptProjectAuthorizationReady } from "./projectAuthorization.js";
import { handleMediaGatewayRequest, invalidateMediaGrantsForRestart, mediaAnalysisQueue, resolveFfmpegExecutable, resolveFfprobeExecutable, type MediaRuntimeOptions } from "./media.js";
import { withToolSecuritySchemes } from "./securityTransport.js";
import { parseWebGptV4Profile, webGptV4ScopesForProfile, webGptV4ToolNeedsWrite, webGptV4ToolScopesForProfile, type WebGptV4Profile } from "./toolCatalog.js";
import { createWebGptTelemetrySink, parseWebGptMediaPublicOrigin, parseWebGptTelemetryMode, parseWebGptWidgetDomain, type WebGptTelemetryMode, type WebGptTelemetrySink } from "./telemetry.js";

export const WEBGPT_V4_HOST = "127.0.0.1";
export const WEBGPT_V4_MCP_PORT = 2091;
export const WEBGPT_V4_MEDIA_PORT = 2092;

export class WebGptRequestLimiter {
  private active = 0;
  private readonly principals = new Map<string, number>();

  constructor(private readonly globalMaximum = 8, private readonly principalMaximum = 4) {}

  acquire(principalId: string): (() => void) | null {
    const principalActive = this.principals.get(principalId) ?? 0;
    if (this.active >= this.globalMaximum || principalActive >= this.principalMaximum) return null;
    this.active += 1;
    this.principals.set(principalId, principalActive + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const remaining = (this.principals.get(principalId) ?? 1) - 1;
      if (remaining <= 0) this.principals.delete(principalId);
      else this.principals.set(principalId, remaining);
    };
  }
}

export interface StartWebGptV4Options {
  profile?: string;
  mcp_port?: number;
  media_port?: number;
  sqlite_path?: string;
  data_root?: string;
  auth_config?: WebGptV4AuthConfig | null;
  authenticate?: WebGptV4Authenticator;
  authenticate_media?: WebGptV4Authenticator;
  media?: MediaRuntimeOptions;
  max_body_bytes?: number;
  widget_domain?: string;
  telemetry_mode?: string;
  telemetry_sink?: WebGptTelemetrySink;
}

export interface WebGptV4Runtime {
  profile: WebGptV4Profile;
  mcp_port: number;
  media_port: number | null;
  mcp_url: string;
  media_url: string | null;
  auth_configured: boolean;
  invalidated_media_grants: number;
  telemetry_mode: WebGptTelemetryMode;
  widget_domain: string | null;
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

function mcpRequestNeedsWrite(parsedBody: Record<string, unknown> | undefined, profile: WebGptV4Profile): boolean {
  if (parsedBody?.method !== "tools/call") return false;
  const params = parsedBody.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  return webGptV4ToolNeedsWrite(String((params as Record<string, unknown>).name ?? ""), profile);
}

function safeJsonRpcId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function openValidatedDatabase(sqlitePath: string | undefined, readOnly: boolean): M0Database {
  const db = openM0DatabaseConnection(sqlitePath, { readOnly });
  try {
    assertSchemaCurrent(db);
    return db;
  } catch (error) {
    db.close();
    if (error instanceof SchemaMigrationRequiredError) {
      throw new WebGptV4Error("SCHEMA_MIGRATION_REQUIRED", "The database schema must be migrated before WebGPT can start.");
    }
    throw error;
  }
}

function isExternalHttpsOrigin(origin: string | null): boolean {
  if (!origin) return false;
  const parsed = new URL(origin);
  return parsed.protocol === "https:"
    && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "[::1]";
}

export async function startWebGptV4(options: StartWebGptV4Options = {}): Promise<WebGptV4Runtime> {
  let profile: WebGptV4Profile;
  try {
    profile = parseWebGptV4Profile(options.profile);
  } catch {
    throw new WebGptV4Error("INVALID_WEBGPT_PROFILE", "WEBGPT_V4_PROFILE must be readonly or full.", "WEBGPT_V4_PROFILE");
  }
  const configuredTelemetryMode = parseWebGptTelemetryMode(options.telemetry_mode);
  if (options.telemetry_sink && options.telemetry_mode !== undefined && options.telemetry_sink.mode !== configuredTelemetryMode) {
    throw new WebGptV4Error("INVALID_WEBGPT_TELEMETRY_MODE", "Injected telemetry mode does not match WEBGPT_V4_TELEMETRY_MODE.", "WEBGPT_V4_TELEMETRY_MODE");
  }
  const telemetry = options.telemetry_sink ?? createWebGptTelemetrySink(configuredTelemetryMode, join(options.data_root ?? paths.dataRoot, "webgpt", "telemetry"));
  const telemetryMode = telemetry.mode;
  const widgetDomain = parseWebGptWidgetDomain(options.widget_domain);
  const mediaPublicOrigin = profile === "full" ? parseWebGptMediaPublicOrigin(options.media?.public_origin) : null;
  const mediaOptions = profile === "full" && options.media
    ? { ...options.media, public_origin: mediaPublicOrigin ?? undefined }
    : options.media;
  const authConfig = options.auth_config === undefined ? loadWebGptV4AuthConfig(profile) : options.auth_config;
  if (authConfig && authConfig.provider !== (profile === "readonly" ? "descope" : "auth0")) {
    throw new WebGptV4Error("INVALID_WEBGPT_AUTH_PROVIDER", `${profile} profile cannot use the configured OAuth provider.`);
  }
  const authenticate = options.authenticate ?? (authConfig ? createOAuthAuthenticator(authConfig) : unavailableAuthenticator());
  const authenticateMedia = options.authenticate_media ?? (profile === "full" && authConfig?.provider === "auth0"
    ? createAuth0MediaAuthenticator(authConfig, process.env.WEBGPT_V4_MEDIA_AUTH_COOKIE_NAME?.trim() || undefined)
    : unavailableAuthenticator());
  const projectAuthorizationEnabled = profile === "readonly" && authConfig?.provider === "descope";
  const maximum = options.max_body_bytes ?? 1024 * 1024;
  let invalidatedMediaGrants = 0;
  if (profile === "full") {
    const bootstrapDb = openM0Database(options.sqlite_path);
    try { invalidatedMediaGrants = invalidateMediaGrantsForRestart(bootstrapDb); }
    finally { bootstrapDb.close(); }
  }

  const activeRequests = new Set<Promise<void>>();
  const requestLimiter = new WebGptRequestLimiter();
  let readinessCache: { expires: number; checks: Record<string, boolean> } | null = null;
  const readiness = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    let staticChecks: Record<string, boolean>;
    if (readinessCache && readinessCache.expires > Date.now()) {
      staticChecks = readinessCache.checks;
    } else {
      staticChecks = { oauth: Boolean(authConfig), schema: false, database: false };
      try {
        const db = openValidatedDatabase(options.sqlite_path, profile === "readonly");
        try {
          staticChecks.database = (db.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
          staticChecks.schema = (db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check === "ok";
        } finally { db.close(); }
      } catch { staticChecks.database = false; }
      if (profile === "full") {
        staticChecks.media_directory = false;
        staticChecks.ffmpeg = false;
        staticChecks.ffprobe = false;
        try { accessSync(paths.mediaRoot, constants.R_OK | constants.W_OK); staticChecks.media_directory = true; } catch { staticChecks.media_directory = false; }
        try {
          const ffmpeg = await resolveFfmpegExecutable(mediaOptions?.ffmpeg_path);
          staticChecks.ffmpeg = true;
          await resolveFfprobeExecutable(ffmpeg);
          staticChecks.ffprobe = true;
        } catch { staticChecks.ffmpeg = false; staticChecks.ffprobe = false; }
      }
      readinessCache = { checks: staticChecks, expires: Date.now() + 30_000 };
    }
    let authorization = true;
    if (projectAuthorizationEnabled) {
      try {
        const db = openValidatedDatabase(options.sqlite_path, true);
        try { authorization = webGptProjectAuthorizationReady(db); }
        finally { db.close(); }
      } catch { authorization = false; }
    }
    const queueStatus = mediaAnalysisQueue.status();
    const baseChecks = projectAuthorizationEnabled ? { ...staticChecks, authorization } : staticChecks;
    const checks = profile === "full"
      ? { ...baseChecks, media_queue: queueStatus.active + queueStatus.waiting < queueStatus.capacity }
      : baseChecks;
    if (telemetryMode === "jsonl") checks.telemetry = telemetry.probe();
    const ok = Object.values(checks).every(Boolean);
    const result = {
      status: ok ? 200 : 503,
      body: {
        ok, service: "webgpt-v4", profile, checks, provider_calls_allowed: false,
        external_release_gate: {
          widget_domain: profile === "readonly" || Boolean(widgetDomain),
          media_public_origin: profile === "readonly" || isExternalHttpsOrigin(mediaPublicOrigin)
        }
      }
    };
    return result;
  };
  const trackRequest = (task: Promise<void>): void => {
    activeRequests.add(task);
    void task.finally(() => activeRequests.delete(task)).catch(() => undefined);
  };
  const configuredMetadataUrl = authConfig
    ? new URL(protectedResourceMetadataUrl(authConfig.resource_url))
    : new URL("http://localhost/.well-known/oauth-protected-resource/mcp");
  let localMcpResourceUrl: string | null = null;

  const handleMcpRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${WEBGPT_V4_HOST}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true, service: "webgpt-v4-mcp", version: WEBGPT_V4_VERSION });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const ready = await readiness();
      sendJson(response, ready.status, { ...ready.body, service: "webgpt-v4-mcp", auth_configured: Boolean(authConfig) });
      return;
    }
    const isCompatibilityMetadataPath = url.pathname === "/.well-known/oauth-protected-resource" && url.search === "";
    // The local MCP transport is always mounted at /mcp, even when a secure
    // tunnel gives the public resource a longer, path-based audience. Tunnel
    // discovery derives PRMD from the local target, so keep this transport
    // alias alongside the public resource's path-aware metadata endpoint.
    const isLocalMcpMetadataPath = url.pathname === "/.well-known/oauth-protected-resource/mcp" && url.search === "";
    const isConfiguredMetadataPath = url.pathname === configuredMetadataUrl.pathname && url.search === configuredMetadataUrl.search;
    if (request.method === "GET" && (isCompatibilityMetadataPath || isLocalMcpMetadataPath || isConfiguredMetadataPath)) {
      const metadata = protectedResourceMetadata(authConfig, webGptV4ScopesForProfile(profile));
      if (authConfig && !isConfiguredMetadataPath && (isCompatibilityMetadataPath || isLocalMcpMetadataPath) && localMcpResourceUrl) {
        // tunnel-client discovers OAuth through the private MCP target and
        // rewrites this resource to the OpenAI-hosted Tunnel URL for callers.
        // Keep JWT validation bound to the configured public audience while
        // preventing either local discovery candidate from recursively probing
        // that public URL.
        metadata.resource = localMcpResourceUrl;
      }
      sendJson(response, 200, metadata);
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

    let db: M0Database;
    const releaseAdmission = requestLimiter.acquire(actor.principal_id);
    if (!releaseAdmission) {
      sendJson(response, 429, { jsonrpc: "2.0", id: safeJsonRpcId(parsedBody?.id), error: {
        code: -32004, message: "WebGPT request capacity is busy.", data: { code: "WEBGPT_REQUEST_BUSY", retryable: true }
      } }, { "retry-after": "1" });
      return;
    }
    try {
      db = openValidatedDatabase(options.sqlite_path, !mcpRequestNeedsWrite(parsedBody, profile));
    } catch (error) {
      releaseAdmission();
      const safe = errorBody(error);
      sendJson(response, 503, { jsonrpc: "2.0", id: safeJsonRpcId(parsedBody?.id), error: { code: -32003, message: safe.message, data: safe } });
      return;
    }
    if (projectAuthorizationEnabled && !webGptProjectAuthorizationReady(db)) {
      db.close();
      releaseAdmission();
      const safe = { code: "MULTI_USER_AUTHORIZATION_NOT_READY", message: "Multi-user project authorization is not ready." };
      sendJson(response, 503, { jsonrpc: "2.0", id: safeJsonRpcId(parsedBody?.id), error: {
        code: -32003, message: safe.message, data: safe
      } });
      return;
    }
    let app: ReturnType<typeof createWebGptV4McpApp> | null = null;
    let transport: StreamableHTTPServerTransport | null = null;
    try {
      app = createWebGptV4McpApp({ db, actor, profile, auth_config: authConfig, media: mediaOptions, telemetry, widget_domain: widgetDomain });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const securedTransport = withToolSecuritySchemes(transport, webGptV4ToolScopesForProfile(profile));
      await app.connect(securedTransport);
      await transport.handleRequest(request, response, parsedBody);
    } catch {
      if (!response.headersSent) sendJson(response, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal MCP server error." } });
    } finally {
      await Promise.allSettled([...(transport ? [transport.close()] : []), ...(app ? [app.close()] : [])]);
      db.close();
      releaseAdmission();
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
    if (request.method === "GET" && url.pathname === "/readyz") {
      const ready = await readiness();
      sendJson(response, ready.status, { ...ready.body, service: "webgpt-v4-media", auth_configured: Boolean(authConfig) });
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
    let db: M0Database;
    try {
      db = openValidatedDatabase(options.sqlite_path, true);
    } catch (error) {
      sendJson(response, 503, { ok: false, error: errorBody(error) });
      return;
    }
    try {
      handleMediaGatewayRequest(request, response, {
        project_id: projectId,
        artifact_id: artifactId,
        token: url.searchParams.get("grant") ?? "",
        actor_hash: actor.actor_hash,
        db,
        allowed_origin: widgetDomain ?? undefined,
        options: mediaOptions
      });
    } finally {
      db.close();
    }
  };

  const mediaServer = profile === "full" ? createServer((request, response) => {
    trackRequest(handleMediaRequest(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: { code: "MEDIA_GATEWAY_ERROR", message: "Media request failed." } });
      else if (!response.writableEnded) response.end();
    }));
  }) : null;

  const mcpPort = await listen(mcpServer, options.mcp_port ?? WEBGPT_V4_MCP_PORT);
  localMcpResourceUrl = `http://${WEBGPT_V4_HOST}:${mcpPort}/mcp`;
  let mediaPort: number | null = null;
  try {
    mediaPort = mediaServer ? await listen(mediaServer, options.media_port ?? WEBGPT_V4_MEDIA_PORT) : null;
  } catch (error) {
    await close(mcpServer);
    throw error;
  }
  return {
    profile,
    mcp_port: mcpPort,
    media_port: mediaPort,
    mcp_url: `http://${WEBGPT_V4_HOST}:${mcpPort}/mcp`,
    media_url: mediaPort === null ? null : `http://${WEBGPT_V4_HOST}:${mediaPort}`,
    auth_configured: Boolean(authConfig),
    invalidated_media_grants: invalidatedMediaGrants,
    telemetry_mode: telemetryMode,
    widget_domain: widgetDomain,
    close: async () => {
      await Promise.all([close(mcpServer), ...(mediaServer ? [close(mediaServer)] : [])]);
      await Promise.allSettled([...activeRequests]);
    }
  };
}
