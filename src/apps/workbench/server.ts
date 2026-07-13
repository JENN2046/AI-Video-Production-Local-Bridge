import { randomUUID, timingSafeEqual } from "node:crypto";
import { accessSync, constants, createReadStream, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import { ensureM0Directories, paths } from "../../paths.js";
import { handleWorkbenchV2Api } from "../../packages/domain/index.js";
import { getMediaArtifact, recoverMediaActivations, validateImageFile } from "../../packages/media/index.js";
import { generationWorkerStatus, resumeWorkbenchGenerationJobs } from "../../packages/providers/index.js";
import { openM0Database } from "../../packages/storage/index.js";
import { checkProviderEnv } from "../../tools/providerEnv.js";
import { resolveFfmpegExecutable, resolveFfprobeExecutable } from "../../webgpt-v4/media.js";

export const WORKBENCH_HOST = "127.0.0.1";
export const WORKBENCH_PORT = 4181;

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};
const MEDIA_CONTENT_TYPES: Record<string, string> = { ...IMAGE_CONTENT_TYPES, ".mp4": "video/mp4" };
const V2_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};
let readinessCache: { expires: number; checks: Record<string, boolean> } | null = null;

export interface WorkbenchRuntime {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export interface WorkbenchStartOptions {
  shutdown_token?: string;
  on_shutdown_requested?: () => void;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function isPathInside(child: string, parent: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function normalizedHost(hostHeader: string | undefined): string {
  const host = (hostHeader ?? "").toLowerCase();
  if (host.startsWith("[::1]")) return "::1";
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

function isLocalRequest(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? "";
  if (!new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]).has(remote)) return false;
  return new Set(["127.0.0.1", "localhost", "::1"]).has(normalizedHost(request.headers.host));
}

function safeFile(root: string, filename: string): string | null {
  const target = resolve(root, filename);
  if (!isPathInside(target, root) || !existsSync(target) || lstatSync(target).isSymbolicLink()) return null;
  const actual = realpathSync(target);
  if (!isPathInside(actual, root) || !statSync(actual).isFile()) return null;
  return actual;
}

function serveImport(pathname: string, response: ServerResponse): void {
  const filename = basename(decodeURIComponent(pathname.slice("/imports/".length)));
  const contentType = IMAGE_CONTENT_TYPES[extname(filename).toLowerCase()];
  const target = contentType ? safeFile(resolve(paths.importsRoot), filename) : null;
  if (!target || !validateImageFile(target).ok) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Import image was not found." } });
    return;
  }
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  createReadStream(target).pipe(response);
}

function serveUiAsset(pathname: string, response: ServerResponse): void {
  const filename = basename(decodeURIComponent(pathname.slice("/ui-assets/".length)));
  const contentType = IMAGE_CONTENT_TYPES[extname(filename).toLowerCase()];
  const target = contentType ? safeFile(resolve(paths.workspaceRoot, "data", "ui"), filename) : null;
  if (!target) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "UI asset was not found." } });
    return;
  }
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  createReadStream(target).pipe(response);
}

function serveWorkbenchUi(pathname: string, response: ServerResponse): void {
  const root = resolve(paths.workspaceRoot, "dist", "workbench-ui");
  const target = pathname.startsWith("/v2-assets/")
    ? safeFile(root, pathname.slice(1))
    : safeFile(root, "index.html");
  if (!target) {
    sendJson(response, 503, { ok: false, error: { code: "V2_UI_NOT_BUILT", message: "Workbench UI has not been built." } });
    return;
  }
  response.writeHead(200, {
    "content-type": V2_CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
    "cache-control": pathname.startsWith("/v2-assets/") ? "public, max-age=31536000, immutable" : "no-store"
  });
  createReadStream(target).pipe(response);
}

function withDatabase<T>(operation: (db: ReturnType<typeof openM0Database>) => T): T {
  const db = openM0Database();
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

async function workbenchReadiness(): Promise<{ status: number; body: Record<string, unknown> }> {
  let staticChecks: Record<string, boolean>;
  if (readinessCache && readinessCache.expires > Date.now()) {
    staticChecks = readinessCache.checks;
  } else {
    staticChecks = { schema: false, database: false, media_directory: false, ffmpeg: false, ffprobe: false, provider: true };
    try {
      withDatabase((db) => {
        staticChecks.database = (db.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
        staticChecks.schema = (db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check === "ok";
      });
    } catch { staticChecks.database = false; }
    try { accessSync(paths.mediaRoot, constants.R_OK | constants.W_OK); staticChecks.media_directory = true; } catch { staticChecks.media_directory = false; }
    try {
      const ffmpeg = await resolveFfmpegExecutable();
      staticChecks.ffmpeg = true;
      await resolveFfprobeExecutable(ffmpeg);
      staticChecks.ffprobe = true;
    } catch { staticChecks.ffmpeg = false; staticChecks.ffprobe = false; }
    if (process.env.REAL_PROVIDER_ENABLED === "true") {
      const provider = checkProviderEnv();
      staticChecks.provider = provider.result === "PASS" && provider.provider_name === "runninghub";
    }
    readinessCache = { checks: staticChecks, expires: Date.now() + 30_000 };
  }
  let worker = false;
  try { worker = withDatabase((db) => generationWorkerStatus(db).ready); } catch { worker = false; }
  const checks = { ...staticChecks, worker };
  const ok = Object.values(checks).every(Boolean);
  const result = { status: ok ? 200 : 503, body: { ok, service: "workbench-v2", checks } };
  return result;
}

function serveMedia(pathname: string, request: IncomingMessage, response: ServerResponse): void {
  const artifactId = basename(decodeURIComponent(pathname.slice("/media/artifacts/".length)));
  if (!/^artifact_[0-9a-f-]+$/i.test(artifactId)) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Media artifact was not found." } });
    return;
  }
  const artifact = withDatabase((db) => getMediaArtifact(db, artifactId));
  if (!artifact || artifact.status !== "active") {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Media artifact was not found." } });
    return;
  }
  const mediaRoot = resolve(paths.mediaRoot);
  const target = resolve(artifact.storage.uri);
  const actual = isPathInside(target, mediaRoot) ? safeFile(mediaRoot, relative(mediaRoot, target)) : null;
  if (!actual) {
    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Media artifact was not found." } });
    return;
  }
  const size = statSync(actual).size;
  const contentType = artifact.storage.mime_type || MEDIA_CONTENT_TYPES[extname(actual).toLowerCase()] || "application/octet-stream";
  const headers = { "content-type": contentType, "cache-control": "no-store", "accept-ranges": artifact.artifact_type === "video" ? "bytes" : "none" };
  const range = request.headers.range;
  if (artifact.artifact_type === "video" && typeof range === "string") {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : size - 1;
      if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end < size) {
        response.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) });
        createReadStream(actual, { start, end }).pipe(response);
        return;
      }
    }
    response.writeHead(416, { "content-range": `bytes */${size}` });
    response.end();
    return;
  }
  response.writeHead(200, { ...headers, "content-length": String(size) });
  createReadStream(actual).pipe(response);
}

function shutdownTokenMatches(request: IncomingMessage, expected: string): boolean {
  const provided = request.headers["x-ai-video-shutdown-token"];
  if (typeof provided !== "string") return false;
  const actualBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  actionNonce: string,
  shutdown?: { token: string; request: () => void }
): Promise<void> {
  if (!isLocalRequest(request)) {
    sendJson(response, 403, { ok: false, error: { code: "LOCALHOST_ONLY", message: "Workbench accepts local requests only." } });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${WORKBENCH_HOST}`);
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true, service: "workbench-v2" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    const ready = await workbenchReadiness();
    sendJson(response, ready.status, ready.body);
    return;
  }
  if (request.method === "POST" && url.pathname === "/_local/shutdown" && shutdown) {
    if (!shutdownTokenMatches(request, shutdown.token)) {
      sendJson(response, 403, { ok: false, error: { code: "SHUTDOWN_FORBIDDEN", message: "Shutdown request was rejected." } });
      return;
    }
    sendJson(response, 202, { ok: true, status: "shutting_down" });
    setImmediate(shutdown.request);
    return;
  }
  if (await handleWorkbenchV2Api(request, response, url, actionNonce)) return;
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
    response.writeHead(302, { location: "/v2/dashboard", "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method === "GET" && (url.pathname === "/v2" || url.pathname.startsWith("/v2/") || url.pathname.startsWith("/v2-assets/"))) {
    serveWorkbenchUi(url.pathname, response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/ui-assets/")) {
    serveUiAsset(url.pathname, response);
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/imports/")) {
    serveImport(url.pathname, response);
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/media/artifacts/")) {
    serveMedia(url.pathname, request, response);
    return;
  }
  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route was not found." } });
}

function listen(server: Server, startPort: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    const attempt = (port: number): void => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && port < startPort + 20) attempt(port + 1);
        else reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        const address = server.address();
        resolveListen(typeof address === "object" && address ? address.port : port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, WORKBENCH_HOST);
    };
    attempt(startPort);
  });
}

export async function startWorkbenchApplication(
  startPort = Number(process.env.H1_WORKBENCH_PORT || process.env.PORT || WORKBENCH_PORT),
  options: WorkbenchStartOptions = {}
): Promise<WorkbenchRuntime> {
  ensureM0Directories();
  withDatabase((db) => recoverMediaActivations(db));
  resumeWorkbenchGenerationJobs();
  const actionNonce = randomUUID();
  const shutdown = options.shutdown_token?.trim() && options.on_shutdown_requested
    ? { token: options.shutdown_token.trim(), request: options.on_shutdown_requested }
    : undefined;
  const server = createServer((request, response) => {
    void route(request, response, actionNonce, shutdown).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: { code: "SERVER_ERROR", message: "Workbench server error." } });
      else if (!response.writableEnded) response.end();
    });
  });
  const port = await listen(server, startPort);
  return {
    host: WORKBENCH_HOST,
    port,
    url: `http://${WORKBENCH_HOST}:${port}`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  };
}

export function installWorkbenchShutdownHandlers(runtime: WorkbenchRuntime, requestedShutdown?: () => Promise<void>): void {
  const shutdown = requestedShutdown ?? (async (): Promise<void> => {
    await runtime.close();
    process.exit(0);
  });
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}
