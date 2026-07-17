import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import type { JWTVerifyGetKey } from "jose";

import type { PinnedHttpsRuntime } from "../net/pinnedHttpsTransport.js";
import {
  assertWebGptV4AuthConfig,
  createOAuthAuthenticator,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  unavailableAuthenticator,
  wwwAuthenticate,
  type WebGptV4Authenticator,
  type WebGptV4ReadonlyFederatedAuthConfig
} from "../webgpt-v4/auth.js";
import { WEBGPT_V4_READ_OUTPUT_SCHEMAS } from "../webgpt-v4/contracts.js";
import { withToolSecuritySchemes } from "../webgpt-v4/securityTransport.js";
import { webGptV4Tool } from "../webgpt-v4/toolCatalog.js";
import {
  errorBody,
  fail,
  requestId,
  requireScope,
  WEBGPT_V4_VERSION,
  type WebGptV4Actor,
  type WebGptV4Result
} from "../webgpt-v4/types.js";
import {
  READONLY_WORKBENCH_DATA_TOOLS
} from "./appContract.js";
import type {
  ReadonlyDataSource,
  ReadonlyProjectContextInput,
  ReadonlyProjectListInput,
  ReadonlyReviewInput,
  ReadonlyShotListInput
} from "./dataSourceContract.js";
import { SnapshotReadonlyDataSource } from "./snapshotDataSource.js";
import { readonlySnapshotStatus, READONLY_SNAPSHOT_MAX_BYTES, type ReadonlySnapshot, type ReadonlySnapshotStatus } from "./snapshot.js";
import {
  ReadonlySnapshotStore,
  type ReadonlySigningPublicKey
} from "./signedSnapshot.js";

export const READONLY_REMOTE_SERVICE_VERSION = "readonly-remote-v1.0.0";
export const READONLY_REMOTE_DEFAULT_HOST = "127.0.0.1";
export const READONLY_REMOTE_DEFAULT_PORT = 2094;
export const READONLY_REMOTE_PUBLISH_PATH = "/snapshot";
export const READONLY_REMOTE_TOOL_RESULT_MAX_BYTES = 128 * 1024;

type RemoteToolName = typeof READONLY_WORKBENCH_DATA_TOOLS[number];

const toolScopes = Object.fromEntries(READONLY_WORKBENCH_DATA_TOOLS.map((name) => [name, "projects.read"])) as Record<RemoteToolName, "projects.read">;

export interface ReadonlyRemoteLogEvent {
  timestamp: string;
  correlation_id: string;
  event_type: "health" | "readiness" | "oauth_metadata" | "auth_failure" | "mcp" | "snapshot_publish" | "not_found";
  http_status: number;
  stable_error_code?: string;
  latency_bucket: "lt_10ms" | "lt_50ms" | "lt_250ms" | "lt_1s" | "gte_1s";
  rate_limit_event: boolean;
  auth_failure_count: number;
  snapshot_status: "no_snapshot" | "fresh" | "snapshot_expired";
  snapshot_age_bucket: "none" | "lt_5m" | "lt_1h" | "lt_6h" | "lt_24h" | "gte_24h";
  boot_id_prefix: string;
}

export type ReadonlyRemoteLogSink = (event: ReadonlyRemoteLogEvent) => void;

export interface StartReadonlyRemoteRuntimeOptions {
  host?: string;
  port?: number;
  auth_config?: WebGptV4ReadonlyFederatedAuthConfig | null;
  authenticate?: WebGptV4Authenticator;
  auth_jwks?: JWTVerifyGetKey;
  auth_transport?: PinnedHttpsRuntime;
  publisher_key_id?: string;
  publisher_public_key?: ReadonlySigningPublicKey;
  max_mcp_body_bytes?: number;
  max_publish_body_bytes?: number;
  global_request_limit?: number;
  principal_request_limit?: number;
  publish_requests_per_minute?: number;
  now?: () => Date;
  log?: ReadonlyRemoteLogSink;
}

export interface ReadonlyRemoteRuntime {
  host: string;
  port: number;
  origin: string;
  mcp_url: string;
  snapshot_url: string;
  snapshot_status: () => ReadonlySnapshotStatus;
  close: () => Promise<void>;
}

class AdmissionLimiter {
  private active = 0;
  private readonly principals = new Map<string, number>();

  constructor(private readonly globalMaximum: number, private readonly principalMaximum: number) {}

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

class WindowLimiter {
  private readonly windows = new Map<string, { started_at: number; count: number }>();
  private static readonly MAXIMUM_TRACKED_KEYS = 1024;

  constructor(private readonly maximum: number, private readonly now: () => Date) {}

  allow(key: string): boolean {
    const now = this.now().getTime();
    for (const [trackedKey, window] of this.windows) {
      if (now - window.started_at >= 60_000) this.windows.delete(trackedKey);
    }
    const current = this.windows.get(key);
    if (!current) {
      if (this.windows.size >= WindowLimiter.MAXIMUM_TRACKED_KEYS) return false;
      this.windows.set(key, { started_at: now, count: 1 });
      return true;
    }
    if (current.count >= this.maximum) return false;
    current.count += 1;
    return true;
  }
}

function latencyBucket(milliseconds: number): ReadonlyRemoteLogEvent["latency_bucket"] {
  if (milliseconds < 10) return "lt_10ms";
  if (milliseconds < 50) return "lt_50ms";
  if (milliseconds < 250) return "lt_250ms";
  if (milliseconds < 1000) return "lt_1s";
  return "gte_1s";
}

function snapshotAgeBucket(snapshot: ReadonlySnapshot | null, now: Date): ReadonlyRemoteLogEvent["snapshot_age_bucket"] {
  if (!snapshot) return "none";
  const age = Math.max(0, now.getTime() - Date.parse(snapshot.generated_at));
  if (age < 5 * 60_000) return "lt_5m";
  if (age < 60 * 60_000) return "lt_1h";
  if (age < 6 * 60 * 60_000) return "lt_6h";
  if (age < 24 * 60 * 60_000) return "lt_24h";
  return "gte_24h";
}

function defaultLog(event: ReadonlyRemoteLogEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
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
    size += buffer.length;
    if (size > maximum) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new Error("INVALID_JSON_BODY");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("INVALID_JSON_BODY");
  }
}

function safeJsonRpcId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function buildReadonlyRemoteToolResult<T>(resultInput: WebGptV4Result<T>, fingerprint: string | null, challenge?: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    snapshot_fingerprint: fingerprint,
    ...(challenge ? { "mcp/www_authenticate": [challenge] } : {})
  };
  const serialize = (result: WebGptV4Result<unknown>): Record<string, unknown> => {
    const message = result.ok ? "请求已完成；结构化结果位于 structuredContent。" : `${result.error.code}: ${result.error.message}`;
    return {
      isError: !result.ok,
      structuredContent: result,
      content: [{ type: "text", text: message.slice(0, 1024) }],
      _meta: meta
    };
  };
  const candidate = serialize(resultInput);
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= READONLY_REMOTE_TOOL_RESULT_MAX_BYTES) return candidate;
  return serialize(fail(resultInput.meta.request_id, {
    code: "RESPONSE_BUDGET_EXCEEDED",
    message: "The complete MCP tool result exceeds the WebGPT response budget.",
    field: resultInput.ok && typeof resultInput.data === "object" && resultInput.data !== null && "detail" in resultInput.data ? "detail" : "limit",
    retryable: false,
    suggested_parameters: { detail: "compact", limit: 20 }
  }));
}

function unavailableResult(idValue?: string): WebGptV4Result<never> {
  return fail(requestId(idValue), { code: "WEBGPT_CLOUD_SNAPSHOT_UNAVAILABLE", message: "No readonly snapshot is currently available." });
}

function createReadonlyRemoteMcpApp(
  actor: WebGptV4Actor,
  snapshot: ReadonlySnapshot | null,
  authConfig: WebGptV4ReadonlyFederatedAuthConfig | null,
  now: () => Date
): McpServer {
  const server = new McpServer(
    { name: "ai-video-readonly-workspace", version: READONLY_REMOTE_SERVICE_VERSION },
    { instructions: "Readonly production workspace. Never write, fetch media, call a Provider, or disclose data outside the signed project projection." }
  );
  const source = snapshot && actor.issuer_hash
    ? new SnapshotReadonlyDataSource(snapshot, actor.principal_id, actor.issuer_hash, now)
    : snapshot
      ? new SnapshotReadonlyDataSource(snapshot, actor.principal_id, "", now)
      : null;
  const fingerprint = snapshot?.snapshot_fingerprint ?? null;
  const security = (name: RemoteToolName) => ({
    annotations: webGptV4Tool(name).annotations,
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["projects.read"] }] }
  });
  const invoke = <T>(idValue: string | undefined, operation: (dataSource: ReadonlyDataSource) => WebGptV4Result<T>): Record<string, unknown> => {
    try {
      requireScope(actor, "projects.read");
      return buildReadonlyRemoteToolResult(source ? operation(source) : unavailableResult(idValue), fingerprint);
    } catch (error) {
      const safe = errorBody(error);
      const challenge = safe.code === "INSUFFICIENT_SCOPE"
        ? wwwAuthenticate(authConfig, "insufficient_scope", { scope: "projects.read", error_description: safe.message })
        : undefined;
      return buildReadonlyRemoteToolResult(fail(requestId(idValue), safe), fingerprint, challenge);
    }
  };

  server.registerTool("list_production_projects", {
    title: "列出生产项目", description: "List authorized production projects from the signed readonly snapshot.",
    inputSchema: { query: z.string().max(200).optional(), include_archived: z.boolean().default(false), detail: z.enum(["compact", "full"]).default("compact"), limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.list_production_projects, ...security("list_production_projects")
  }, async (input) => invoke(input.request_id, (dataSource) => dataSource.listProductionProjects(input as ReadonlyProjectListInput, input.request_id)) as never);

  server.registerTool("get_project_context", {
    title: "读取项目上下文", description: "Read one authorized project context from the signed readonly snapshot.",
    inputSchema: { project_id: z.string().min(1), workspace: z.enum(["overview", "storyboard", "generation", "review", "delivery"]).default("overview"), detail: z.enum(["compact", "full"]).default("compact"), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.get_project_context, ...security("get_project_context")
  }, async (input) => invoke(input.request_id, (dataSource) => dataSource.getProjectContext(input as ReadonlyProjectContextInput, input.request_id)) as never);

  server.registerTool("list_project_shots", {
    title: "列出项目 SHOT", description: "List SHOTs for one authorized project from the signed readonly snapshot.",
    inputSchema: { project_id: z.string().min(1), detail: z.enum(["compact", "full"]).default("compact"), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.list_project_shots, ...security("list_project_shots")
  }, async (input) => invoke(input.request_id, (dataSource) => dataSource.listProjectShots(input as ReadonlyShotListInput, input.request_id)) as never);

  server.registerTool("get_review_package", {
    title: "读取审片包", description: "Read one authorized SHOT review package from the signed readonly snapshot.",
    inputSchema: { project_id: z.string().min(1), shot_id: z.string().min(1), artifact_id: z.string().optional(), notes_limit: z.number().int().min(1).max(50).default(10), detail: z.enum(["compact", "full"]).default("compact"), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.get_review_package, ...security("get_review_package")
  }, async (input) => invoke(input.request_id, (dataSource) => dataSource.getReviewPackage(input as ReadonlyReviewInput, input.request_id)) as never);

  server.registerTool("get_delivery_status", {
    title: "读取交付状态", description: "Read delivery status for one authorized project from the signed readonly snapshot.",
    inputSchema: { project_id: z.string().min(1), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.get_delivery_status, ...security("get_delivery_status")
  }, async (input) => invoke(input.request_id, (dataSource) => dataSource.getDeliveryStatus(input.project_id, input.request_id)) as never);

  server.registerTool("get_closeout_evidence", {
    title: "读取收口证据", description: "Read closeout evidence for one authorized project from the signed readonly snapshot.",
    inputSchema: { project_id: z.string().min(1), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.get_closeout_evidence, ...security("get_closeout_evidence")
  }, async (input) => invoke(input.request_id, (dataSource) => dataSource.getCloseoutEvidence(input.project_id, input.request_id)) as never);

  return server;
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

export async function startReadonlyRemoteRuntime(options: StartReadonlyRemoteRuntimeOptions = {}): Promise<ReadonlyRemoteRuntime> {
  const now = options.now ?? (() => new Date());
  const authConfig = options.auth_config ?? null;
  if (authConfig) {
    assertWebGptV4AuthConfig(authConfig);
    if (authConfig.provider !== "federated" || authConfig.access_model !== "project_membership") throw new Error("INVALID_READONLY_REMOTE_AUTH_CONFIG");
  }
  const authenticate = options.authenticate ?? (authConfig
    ? createOAuthAuthenticator(authConfig, { jwks: options.auth_jwks, jwks_transport: options.auth_transport })
    : unavailableAuthenticator());
  const store = options.publisher_key_id && options.publisher_public_key
    ? new ReadonlySnapshotStore(
        options.publisher_key_id,
        options.publisher_public_key,
        now,
        authConfig ? { resource_url: authConfig.resource_url, issuer_hash: authConfig.issuer_hash } : undefined
      )
    : null;
  const host = options.host ?? READONLY_REMOTE_DEFAULT_HOST;
  const requestedPort = options.port ?? READONLY_REMOTE_DEFAULT_PORT;
  const admission = new AdmissionLimiter(options.global_request_limit ?? 8, options.principal_request_limit ?? 4);
  const publishLimiter = new WindowLimiter(options.publish_requests_per_minute ?? 12, now);
  const maximumMcpBody = options.max_mcp_body_bytes ?? 1024 * 1024;
  const maximumPublishBody = options.max_publish_body_bytes ?? READONLY_SNAPSHOT_MAX_BYTES + 64 * 1024;
  const log = options.log ?? defaultLog;
  const bootIdPrefix = randomUUID().replace(/-/g, "").slice(0, 8);
  const activeRequests = new Set<Promise<void>>();
  let authFailureCount = 0;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const startedAt = Date.now();
    const correlationId = randomUUID();
    let eventType: ReadonlyRemoteLogEvent["event_type"] = "not_found";
    let status = 500;
    let stableErrorCode: string | undefined;
    let rateLimitEvent = false;
    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      const snapshot = store?.read() ?? null;
      if (request.method === "GET" && url.pathname === "/healthz") {
        eventType = "health"; status = 200;
        sendJson(response, status, { ok: true, service: "readonly-remote-mcp", version: READONLY_REMOTE_SERVICE_VERSION });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        eventType = "readiness";
        const snapshotStatus = readonlySnapshotStatus(snapshot, now());
        const checks = {
          oauth: Boolean(authConfig),
          publisher_key: Boolean(store),
          snapshot_fresh: snapshotStatus.freshness_status === "fresh",
          authorization_projection: Boolean(snapshot?.authorization.principals.length)
        };
        const ok = Object.values(checks).every(Boolean);
        status = ok ? 200 : 503;
        if (!ok) stableErrorCode = "READONLY_REMOTE_NOT_READY";
        sendJson(response, status, { ok, service: "readonly-remote-mcp", version: READONLY_REMOTE_SERVICE_VERSION, checks, snapshot: snapshotStatus, database_attached: false, provider_calls_allowed: false });
        return;
      }
      const metadataPath = authConfig ? new URL(protectedResourceMetadataUrl(authConfig.resource_url)).pathname : "/.well-known/oauth-protected-resource/mcp";
      if (request.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === metadataPath)) {
        eventType = "oauth_metadata"; status = 200;
        sendJson(response, status, protectedResourceMetadata(authConfig, ["projects.read"]));
        return;
      }
      if (request.method === "PUT" && url.pathname === READONLY_REMOTE_PUBLISH_PATH) {
        eventType = "snapshot_publish";
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          status = 415; stableErrorCode = "READONLY_SNAPSHOT_PUBLISH_CONTENT_TYPE_REQUIRED";
          sendJson(response, status, { ok: false, error: { code: stableErrorCode, message: "Snapshot publish requires application/json." } });
          return;
        }
        const peer = request.socket.remoteAddress ?? "unknown";
        if (!publishLimiter.allow(peer)) {
          status = 429; stableErrorCode = "READONLY_SNAPSHOT_PUBLISH_RATE_LIMITED"; rateLimitEvent = true;
          sendJson(response, status, { ok: false, error: { code: stableErrorCode, message: "Snapshot publish capacity is busy." } }, { "retry-after": "60" });
          return;
        }
        if (!authConfig) {
          status = 503; stableErrorCode = "READONLY_SNAPSHOT_PUBLISH_AUTH_NOT_CONFIGURED";
          sendJson(response, status, { ok: false, error: { code: stableErrorCode, message: "Readonly OAuth is not configured." } });
          return;
        }
        if (!store) {
          status = 503; stableErrorCode = "READONLY_SNAPSHOT_PUBLISH_NOT_CONFIGURED";
          sendJson(response, status, { ok: false, error: { code: stableErrorCode, message: "Snapshot verification is not configured." } });
          return;
        }
        try {
          const published = store.replace(await jsonBody(request, maximumPublishBody));
          status = 202;
          sendJson(response, status, { ok: true, snapshot_fingerprint: published.snapshot_fingerprint, generated_at: published.generated_at, expires_at: published.expires_at });
        } catch (error) {
          const message = error instanceof Error ? error.message : "READONLY_SNAPSHOT_PUBLISH_INVALID";
          status = message === "BODY_TOO_LARGE" ? 413 : 400;
          stableErrorCode = /^READONLY_|^JCS_/.test(message) ? message : "READONLY_SNAPSHOT_PUBLISH_INVALID";
          sendJson(response, status, { ok: false, error: { code: stableErrorCode, message: "Signed readonly snapshot was rejected." } });
        }
        return;
      }
      if (url.pathname !== "/mcp") {
        status = 404; stableErrorCode = "NOT_FOUND";
        sendJson(response, status, { ok: false, error: { code: stableErrorCode, message: "Route was not found." } });
        return;
      }
      eventType = "mcp";
      let actor: WebGptV4Actor;
      try {
        actor = await authenticate(request);
      } catch (error) {
        const safe = errorBody(error);
        authFailureCount += 1;
        eventType = "auth_failure";
        const insufficient = safe.code === "INSUFFICIENT_SCOPE";
        status = insufficient ? 403 : 401;
        stableErrorCode = safe.code;
        const challenge = wwwAuthenticate(authConfig, insufficient ? "insufficient_scope" : safe.code === "AUTH_REQUIRED" ? "invalid_request" : "invalid_token", insufficient ? { scope: "projects.read", error_description: safe.message } : {});
        sendJson(response, status, { jsonrpc: "2.0", id: null, error: { code: -32001, message: safe.message, data: { ...safe, _meta: { "mcp/www_authenticate": [challenge] } } } }, { "www-authenticate": challenge });
        return;
      }
      const release = admission.acquire(actor.principal_id);
      if (!release) {
        status = 429; stableErrorCode = "WEBGPT_REQUEST_BUSY"; rateLimitEvent = true;
        sendJson(response, status, { jsonrpc: "2.0", id: null, error: { code: -32004, message: "Readonly MCP request capacity is busy.", data: { code: stableErrorCode, retryable: true } } }, { "retry-after": "1" });
        return;
      }
      try {
        let parsedBody: unknown;
        try {
          parsedBody = await jsonBody(request, maximumMcpBody);
        } catch (error) {
          stableErrorCode = error instanceof Error && error.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_JSON_BODY";
          status = stableErrorCode === "BODY_TOO_LARGE" ? 413 : 400;
          sendJson(response, status, { jsonrpc: "2.0", id: null, error: { code: -32700, message: stableErrorCode, data: { code: stableErrorCode } } });
          return;
        }
        let app: McpServer | null = null;
        let transport: StreamableHTTPServerTransport | null = null;
        try {
          app = createReadonlyRemoteMcpApp(actor, snapshot, authConfig, now);
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          await app.connect(withToolSecuritySchemes(transport, toolScopes));
          await transport.handleRequest(request, response, parsedBody);
          status = response.statusCode;
        } catch {
          status = 500; stableErrorCode = "READONLY_REMOTE_MCP_ERROR";
          if (!response.headersSent) sendJson(response, status, { jsonrpc: "2.0", id: safeJsonRpcId((parsedBody as Record<string, unknown> | null)?.id), error: { code: -32603, message: "Internal MCP server error." } });
        } finally {
          await Promise.allSettled([...(transport ? [transport.close()] : []), ...(app ? [app.close()] : [])]);
        }
      } finally {
        release();
      }
    } finally {
      const snapshot = store?.read() ?? null;
      const snapshotStatus = readonlySnapshotStatus(snapshot, now());
      try {
        log({
          timestamp: now().toISOString(), correlation_id: correlationId, event_type: eventType, http_status: status,
          ...(stableErrorCode ? { stable_error_code: stableErrorCode } : {}),
          latency_bucket: latencyBucket(Date.now() - startedAt), rate_limit_event: rateLimitEvent,
          auth_failure_count: authFailureCount, snapshot_status: snapshotStatus.freshness_status,
          snapshot_age_bucket: snapshotAgeBucket(snapshot, now()), boot_id_prefix: bootIdPrefix
        });
      } catch {
        // Runtime logging is deliberately non-authoritative and cannot alter a request result.
      }
    }
  };

  const server = createServer((request, response) => {
    const task = handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: { code: "READONLY_REMOTE_INTERNAL_ERROR", message: "Remote runtime request failed." } });
      else if (!response.writableEnded) response.end();
    });
    activeRequests.add(task);
    void task.finally(() => activeRequests.delete(task)).catch(() => undefined);
  });
  const port = await listen(server, host, requestedPort);
  const origin = `http://${host}:${port}`;
  return {
    host, port, origin, mcp_url: `${origin}/mcp`, snapshot_url: `${origin}${READONLY_REMOTE_PUBLISH_PATH}`,
    snapshot_status: () => readonlySnapshotStatus(store?.read() ?? null, now()),
    close: async () => {
      await closeServer(server);
      await Promise.allSettled([...activeRequests]);
    }
  };
}
