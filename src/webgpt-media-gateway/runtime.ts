import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";

import { paths } from "../paths.js";
import { assertSchemaCurrent } from "../storage/migrations.js";
import { openM0DatabaseConnection, type M0Database } from "../storage/sqlite.js";
import { getMediaArtifact, getMediaBlob, type ArtifactReferenceRequirement, type MediaArtifact, type MediaBlob } from "../tools/mediaArtifacts.js";
import { getProject, getShot } from "../tools/projects.js";
import {
  createReadonlyMediaHandle,
  openReadonlyMediaCapabilityRequest,
  ReadonlyMediaCapabilityError,
  ReadonlyMediaCapabilityReplayGuard,
  READONLY_MEDIA_CAPABILITY_MAX_BODY_BYTES,
  READONLY_MEDIA_CAPABILITY_RESPONSE_SCHEMA,
  READONLY_MEDIA_SESSION_MAX_SECONDS,
  type ReadonlyMediaCapabilityKeyring
} from "../webgpt-cloud/mediaCapability.js";
import { READONLY_MEDIA_MIME_TYPES } from "../webgpt-cloud/snapshot.js";
import { requireWebGptProjectReadAccess } from "../webgpt-v4/projectAuthorization.js";

export const READONLY_MEDIA_GATEWAY_VERSION = "readonly-media-gateway-v1.0.0";
export const READONLY_MEDIA_GATEWAY_DEFAULT_PORT = 2092;
export const READONLY_MEDIA_GATEWAY_HASH_TIMEOUT_MS = 45_000;
export const READONLY_MEDIA_GATEWAY_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const READONLY_MEDIA_GATEWAY_CAPABILITY_TTL_MS = 5 * 60 * 1000;
export const READONLY_MEDIA_GATEWAY_SESSION_TTL_MS = READONLY_MEDIA_SESSION_MAX_SECONDS * 1000;
export const READONLY_MEDIA_GATEWAY_MAX_SESSIONS = 32;
export const READONLY_MEDIA_GATEWAY_MAX_SESSIONS_PER_PRINCIPAL = 4;

const allowedMimeTypes = new Set<string>(READONLY_MEDIA_MIME_TYPES);

export class ReadonlyMediaGatewayError extends Error {
  constructor(readonly code: string, message = "Readonly media request failed.") {
    super(message);
  }
}

export class MediaIntegrityQueue {
  private running = 0;
  private readonly waiting: Array<{ resume: () => void }> = [];

  constructor(
    readonly concurrency = 1,
    readonly maximumWaiting = 4,
    readonly timeoutMs = READONLY_MEDIA_GATEWAY_HASH_TIMEOUT_MS
  ) {}

  get status(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  async run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.maximumWaiting) throw new ReadonlyMediaGatewayError("MEDIA_INTEGRITY_BUSY");
      await new Promise<void>((resolveWaiting, rejectWaiting) => {
        let timer: ReturnType<typeof setTimeout>;
        const waiter = {
          resume: (): void => {
            clearTimeout(timer);
            resolveWaiting();
          }
        };
        timer = setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          rejectWaiting(new ReadonlyMediaGatewayError("MEDIA_INTEGRITY_TIMEOUT"));
        }, this.timeoutMs);
        this.waiting.push(waiter);
      });
    }
    this.running += 1;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.running -= 1;
      this.waiting.shift()?.resume();
    };
    const taskPromise = Promise.resolve().then(() => task(controller.signal));
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new ReadonlyMediaGatewayError("MEDIA_INTEGRITY_TIMEOUT"));
        }, this.timeoutMs);
      });
      return await Promise.race([taskPromise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        void taskPromise.then(release, release);
      } else {
        release();
      }
    }
  }
}

type FileIdentity = {
  real_path: string;
  size: number;
  mtime_ms: number;
  dev: number;
  ino: number;
};

type MediaCandidate = {
  requirement: ArtifactReferenceRequirement;
  artifact: MediaArtifact;
  blob: MediaBlob;
  identity: FileIdentity;
};

type CapabilityRecord = MediaCandidate & {
  handle: string;
  principal_id: string;
  issuer_hash: string;
  expires_at_ms: number;
  consumed: boolean;
};

type SessionRecord = MediaCandidate & {
  handle: string;
  principal_id: string;
  issuer_hash: string;
  expires_at_ms: number;
};

type IntegrityFacts = FileIdentity & { sha256: string; detected_mime: string };

export interface ReadonlyMediaGatewayOptions {
  database_path: string;
  issuer_hash: string;
  keyring: ReadonlyMediaCapabilityKeyring;
  allowed_origin?: string;
  allowed_media_roots?: string[];
  host?: "127.0.0.1";
  port?: number;
  now?: () => Date;
  random_bytes?: (size: number) => Buffer;
  integrity_queue?: MediaIntegrityQueue;
}

export interface ReadonlyMediaGatewayRuntime {
  server: Server;
  host: "127.0.0.1";
  port: number;
  url: string;
  counts(): { capabilities: number; sessions: number };
  close(): Promise<void>;
}

function isInside(child: string, parent: string): boolean {
  const relation = relative(resolve(parent), resolve(child));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function containsSymlinkBetween(root: string, child: string): boolean {
  const relation = relative(resolve(root), resolve(child));
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) return false;
  let current = resolve(root);
  for (const segment of relation.split(/[\\/]+/u)) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function isSafeMediaRoot(root: string): boolean {
  try {
    const resolved = resolve(root);
    return existsSync(resolved)
      && !lstatSync(resolved).isSymbolicLink()
      && statSync(resolved).isDirectory()
      && samePath(realpathSync(resolved), resolved);
  } catch {
    return false;
  }
}

function fileIdentity(path: string): FileIdentity {
  const stats = statSync(path);
  if (!stats.isFile()) throw new ReadonlyMediaGatewayError("MEDIA_FILE_NOT_REGULAR");
  return { real_path: path, size: stats.size, mtime_ms: stats.mtimeMs, dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return samePath(left.real_path, right.real_path)
    && left.size === right.size
    && left.mtime_ms === right.mtime_ms
    && left.dev === right.dev
    && left.ino === right.ino;
}

function detectMime(header: Buffer): string {
  if (header.length >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  if (header.length >= 12 && header.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  return "";
}

async function hashFile(candidate: MediaCandidate, signal: AbortSignal): Promise<IntegrityFacts> {
  const before = fileIdentity(candidate.identity.real_path);
  const descriptor = await open(before.real_path, "r");
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const header = Buffer.alloc(16);
  let headerLength = 0;
  let offset = 0;
  try {
    while (true) {
      if (signal.aborted) throw new ReadonlyMediaGatewayError("MEDIA_INTEGRITY_TIMEOUT");
      const result = await descriptor.read(chunk, 0, chunk.length, offset);
      if (result.bytesRead === 0) break;
      hash.update(chunk.subarray(0, result.bytesRead));
      if (headerLength < header.length) {
        const copied = Math.min(result.bytesRead, header.length - headerLength);
        chunk.copy(header, headerLength, 0, copied);
        headerLength += copied;
      }
      offset += result.bytesRead;
    }
  } finally {
    await descriptor.close();
  }
  const after = fileIdentity(before.real_path);
  if (!sameIdentity(before, after) || offset !== after.size) throw new ReadonlyMediaGatewayError("MEDIA_FILE_CHANGED_DURING_HASH");
  return { ...after, sha256: hash.digest("hex"), detected_mime: detectMime(header.subarray(0, headerLength)) };
}

function requirementForArtifact(db: M0Database, artifact: MediaArtifact): ArtifactReferenceRequirement {
  const project = getProject(db, artifact.linked_objects.project_id);
  if (!project) throw new ReadonlyMediaGatewayError("MEDIA_ARTIFACT_UNAVAILABLE");
  if (artifact.role === "final_video") {
    if (artifact.artifact_type !== "video" || artifact.linked_objects.shot_id !== "" || project.exports.final_video_artifact_id !== artifact.artifact_id) {
      throw new ReadonlyMediaGatewayError("MEDIA_ARTIFACT_BINDING_INVALID");
    }
  } else {
    const shot = getShot(db, artifact.linked_objects.shot_id);
    if (!shot || shot.project_id !== project.project_id) throw new ReadonlyMediaGatewayError("MEDIA_ARTIFACT_BINDING_INVALID");
    if (artifact.role === "storyboard_image") {
      if (artifact.artifact_type !== "image" || shot.storyboard_image_artifact_id !== artifact.artifact_id) throw new ReadonlyMediaGatewayError("MEDIA_ARTIFACT_BINDING_INVALID");
    } else if (artifact.role === "generated_clip") {
      if (artifact.artifact_type !== "video" || !shot.clip_versions.some((version) => version.artifact_id === artifact.artifact_id)) {
        throw new ReadonlyMediaGatewayError("MEDIA_ARTIFACT_BINDING_INVALID");
      }
    } else {
      throw new ReadonlyMediaGatewayError("MEDIA_ARTIFACT_BINDING_INVALID");
    }
  }
  return {
    artifact_id: artifact.artifact_id,
    project_id: artifact.linked_objects.project_id,
    shot_id: artifact.linked_objects.shot_id,
    role: artifact.role,
    artifact_type: artifact.artifact_type
  };
}

function loadCandidate(
  options: ReadonlyMediaGatewayOptions,
  principalId: string,
  issuerHash: string,
  projectId: string,
  artifactId: string,
  expectedSha256?: string
): MediaCandidate {
  const db = openM0DatabaseConnection(options.database_path, { readOnly: true });
  try {
    assertSchemaCurrent(db);
    if (issuerHash !== options.issuer_hash) throw new ReadonlyMediaGatewayError("MEDIA_CAPABILITY_INVALID");
    requireWebGptProjectReadAccess(db, principalId, issuerHash, projectId);
    const artifact = getMediaArtifact(db, artifactId);
    if (!artifact || artifact.linked_objects.project_id !== projectId || artifact.status !== "active") throw new ReadonlyMediaGatewayError("MEDIA_ARTIFACT_UNAVAILABLE");
    const requirement = requirementForArtifact(db, artifact);
    const blob = artifact.blob_id ? getMediaBlob(db, artifact.blob_id) : null;
    if (!blob || blob.integrity_state !== "verified" || !allowedMimeTypes.has(blob.detected_mime)) throw new ReadonlyMediaGatewayError("MEDIA_INTEGRITY_FAILED");
    if (expectedSha256 && blob.sha256 !== expectedSha256) throw new ReadonlyMediaGatewayError("MEDIA_INTEGRITY_FAILED");
    if (artifact.metadata.sha256 !== blob.sha256
      || artifact.source.sha256 !== blob.sha256
      || artifact.storage.mime_type !== blob.detected_mime
      || !samePath(artifact.storage.uri, blob.storage_uri)) throw new ReadonlyMediaGatewayError("MEDIA_INTEGRITY_FAILED");
    const registeredRootValue = blob.provenance.media_root;
    if (typeof registeredRootValue !== "string" || !isAbsolute(registeredRootValue)) throw new ReadonlyMediaGatewayError("MEDIA_PATH_UNSAFE");
    const registeredRoot = resolve(registeredRootValue);
    if (!existsSync(registeredRoot) || lstatSync(registeredRoot).isSymbolicLink() || !statSync(registeredRoot).isDirectory()) throw new ReadonlyMediaGatewayError("MEDIA_PATH_UNSAFE");
    const canonicalRoot = resolve(realpathSync(registeredRoot));
    if (!samePath(canonicalRoot, registeredRoot)) throw new ReadonlyMediaGatewayError("MEDIA_PATH_UNSAFE");
    const localPath = resolve(blob.storage_uri);
    if (!isInside(localPath, registeredRoot) || !existsSync(localPath) || containsSymlinkBetween(registeredRoot, localPath)) {
      throw new ReadonlyMediaGatewayError("MEDIA_PATH_UNSAFE");
    }
    const canonicalFile = resolve(realpathSync(localPath));
    if (!samePath(canonicalFile, localPath) || !isInside(canonicalFile, canonicalRoot)) throw new ReadonlyMediaGatewayError("MEDIA_PATH_UNSAFE");
    const approvedRoots = (options.allowed_media_roots ?? [paths.mediaRoot]).map((root) => resolve(root));
    if (approvedRoots.some((root) => !isSafeMediaRoot(root))) throw new ReadonlyMediaGatewayError("MEDIA_PATH_UNSAFE");
    const canonicalApprovedRoots = approvedRoots.map((root) => resolve(realpathSync(root)));
    if (!canonicalApprovedRoots.some((root) => isInside(canonicalFile, root))) throw new ReadonlyMediaGatewayError("MEDIA_PATH_UNSAFE");
    const identity = fileIdentity(canonicalFile);
    if (identity.size <= 0 || identity.size > READONLY_MEDIA_GATEWAY_MAX_FILE_BYTES || identity.size !== blob.size_bytes) {
      throw new ReadonlyMediaGatewayError("MEDIA_FILE_SIZE_INVALID");
    }
    return { requirement, artifact, blob, identity };
  } catch (error) {
    if (error instanceof ReadonlyMediaGatewayError) throw error;
    throw new ReadonlyMediaGatewayError("MEDIA_ARTIFACT_UNAVAILABLE");
  } finally {
    db.close();
  }
}

function noStore(response: ServerResponse): void {
  response.setHeader("cache-control", "private, no-store, max-age=0");
  response.setHeader("cdn-cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

function mediaHeaders(response: ServerResponse, allowedOrigin: string): void {
  noStore(response);
  response.setHeader("content-disposition", "inline");
  response.setHeader("cross-origin-resource-policy", "cross-origin");
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("vary", "Origin");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  noStore(response);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function errorStatus(code: string): number {
  if (code === "MEDIA_INTEGRITY_BUSY" || code === "MEDIA_SESSION_CAPACITY_EXCEEDED") return 429;
  if (code === "MEDIA_INTEGRITY_TIMEOUT") return 503;
  if (code === "MEDIA_CAPABILITY_REPLAYED") return 409;
  if (code === "MEDIA_RANGE_INVALID") return 416;
  if (code === "MEDIA_ORIGIN_DENIED") return 403;
  return 404;
}

function stableError(error: unknown): ReadonlyMediaGatewayError {
  if (error instanceof ReadonlyMediaGatewayError) return error;
  if (error instanceof ReadonlyMediaCapabilityError) return new ReadonlyMediaGatewayError(error.code === "MEDIA_CAPABILITY_REPLAYED" ? error.code : "MEDIA_CAPABILITY_INVALID");
  return new ReadonlyMediaGatewayError("MEDIA_GATEWAY_UNAVAILABLE");
}

function singleRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || value.includes(",")) throw new ReadonlyMediaGatewayError("MEDIA_RANGE_INVALID");
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (!rawStart && !rawEnd) throw new ReadonlyMediaGatewayError("MEDIA_RANGE_INVALID");
  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) throw new ReadonlyMediaGatewayError("MEDIA_RANGE_INVALID");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) throw new ReadonlyMediaGatewayError("MEDIA_RANGE_INVALID");
  return { start, end: Math.min(end, size - 1) };
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > READONLY_MEDIA_CAPABILITY_MAX_BODY_BYTES) throw new ReadonlyMediaGatewayError("MEDIA_CAPABILITY_INVALID");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ReadonlyMediaGatewayError("MEDIA_CAPABILITY_INVALID");
  }
}

function isApplicationJsonContentType(value: string | undefined): boolean {
  return (value?.split(";", 1)[0]?.trim().toLowerCase() ?? "") === "application/json";
}

function requireUnexpiredCapability(payload: { expires_at: string }, currentMs: number): number {
  const expiresAtMs = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= currentMs) {
    throw new ReadonlyMediaGatewayError("MEDIA_CAPABILITY_EXPIRED");
  }
  return expiresAtMs;
}

export async function startReadonlyMediaGateway(options: ReadonlyMediaGatewayOptions): Promise<ReadonlyMediaGatewayRuntime> {
  if (!/^[0-9a-f]{64}$/.test(options.issuer_hash)) throw new ReadonlyMediaGatewayError("MEDIA_GATEWAY_CONFIG_INVALID");
  const allowedOrigin = options.allowed_origin ?? "https://aivideo.skmt617.top";
  const parsedOrigin = new URL(allowedOrigin);
  if (parsedOrigin.origin !== allowedOrigin || parsedOrigin.protocol !== "https:") throw new ReadonlyMediaGatewayError("MEDIA_GATEWAY_CONFIG_INVALID");
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new ReadonlyMediaGatewayError("MEDIA_GATEWAY_CONFIG_INVALID");
  const now = options.now ?? (() => new Date());
  const random = options.random_bytes ?? randomBytes;
  const queue = options.integrity_queue ?? new MediaIntegrityQueue();
  const replay = new ReadonlyMediaCapabilityReplayGuard();
  const capabilities = new Map<string, CapabilityRecord>();
  const sessions = new Map<string, SessionRecord>();
  const positiveCache = new Map<string, number>();
  const negativeCache = new Map<string, number>();

  const sweep = (): void => {
    const current = now().getTime();
    for (const [handle, item] of capabilities) if (item.expires_at_ms <= current) capabilities.delete(handle);
    for (const [handle, item] of sessions) if (item.expires_at_ms <= current) sessions.delete(handle);
    for (const [key, expiry] of positiveCache) if (expiry <= current) positiveCache.delete(key);
    for (const [key, expiry] of negativeCache) if (expiry <= current) negativeCache.delete(key);
  };

  const verifyIntegrity = async (candidate: MediaCandidate): Promise<MediaCandidate> => {
    const key = [candidate.artifact.artifact_id, candidate.blob.sha256, candidate.identity.real_path, candidate.identity.dev, candidate.identity.ino, candidate.identity.size, candidate.identity.mtime_ms].join("|");
    const negativeKey = `${candidate.artifact.artifact_id}|${candidate.blob.sha256}`;
    const current = now().getTime();
    if ((negativeCache.get(negativeKey) ?? 0) > current) throw new ReadonlyMediaGatewayError("MEDIA_INTEGRITY_FAILED");
    if ((positiveCache.get(key) ?? 0) > current) return candidate;
    try {
      const facts = await queue.run((signal) => hashFile(candidate, signal));
      if (facts.sha256 !== candidate.blob.sha256
        || facts.detected_mime !== candidate.blob.detected_mime
        || !sameIdentity(facts, candidate.identity)) throw new ReadonlyMediaGatewayError("MEDIA_INTEGRITY_FAILED");
      positiveCache.set(key, current + 5 * 60 * 1000);
      return candidate;
    } catch (error) {
      const domain = stableError(error);
      if (domain.code !== "MEDIA_INTEGRITY_BUSY" && domain.code !== "MEDIA_INTEGRITY_TIMEOUT") negativeCache.set(negativeKey, current + 10_000);
      throw domain;
    }
  };

  const validateRecord = (record: CapabilityRecord | SessionRecord): MediaCandidate => {
    const current = loadCandidate(options, record.principal_id, record.issuer_hash, record.requirement.project_id, record.requirement.artifact_id, record.blob.sha256);
    if (!sameIdentity(current.identity, record.identity)) throw new ReadonlyMediaGatewayError("MEDIA_SESSION_INVALID");
    return current;
  };

  const serve = (request: IncomingMessage, response: ServerResponse, session: SessionRecord): void => {
    if (request.headers.origin !== allowedOrigin) throw new ReadonlyMediaGatewayError("MEDIA_ORIGIN_DENIED");
    const current = validateRecord(session);
    const range = singleRange(typeof request.headers.range === "string" ? request.headers.range : undefined, current.identity.size);
    const start = range?.start ?? 0;
    const end = range?.end ?? current.identity.size - 1;
    response.statusCode = range ? 206 : 200;
    mediaHeaders(response, allowedOrigin);
    response.setHeader("content-type", current.blob.detected_mime);
    response.setHeader("accept-ranges", "bytes");
    response.setHeader("content-length", String(end - start + 1));
    if (range) response.setHeader("content-range", `bytes ${start}-${end}/${current.identity.size}`);
    if (request.method === "HEAD") { response.end(); return; }
    const stream = createReadStream(current.identity.real_path, { start, end });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  };

  const server = createServer({
    headersTimeout: 10_000,
    requestTimeout: 60_000,
    keepAliveTimeout: 5_000,
    maxHeaderSize: 16 * 1024
  }, (request, response) => {
    void (async () => {
      try {
        sweep();
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/healthz") {
          json(response, 200, { ok: true, service: "readonly-media-gateway", version: READONLY_MEDIA_GATEWAY_VERSION });
          return;
        }
        if (request.method === "GET" && url.pathname === "/readyz") {
          let database = false;
          let schema = false;
          try {
            const db = openM0DatabaseConnection(options.database_path, { readOnly: true });
            try { database = Boolean(db.prepare("SELECT 1 AS ok").get()); assertSchemaCurrent(db); schema = true; } finally { db.close(); }
          } catch { /* low-disclosure readiness */ }
          const configuredMediaRoots = options.allowed_media_roots ?? [paths.mediaRoot];
          const mediaRoots = configuredMediaRoots.length > 0 && configuredMediaRoots.every(isSafeMediaRoot);
          const capabilityKey = options.keyring.active.key.byteLength === 32;
          const ok = database && schema && mediaRoots && capabilityKey;
          json(response, ok ? 200 : 503, { ok, checks: { database, schema, media_roots: mediaRoots, capability_key: capabilityKey } });
          return;
        }
        if (request.method === "POST" && url.pathname === "/internal/v1/capabilities") {
          if (!isApplicationJsonContentType(request.headers["content-type"])) {
            throw new ReadonlyMediaGatewayError("MEDIA_CAPABILITY_INVALID");
          }
          const payload = openReadonlyMediaCapabilityRequest(await body(request), options.keyring, { now });
          const signedExpiresAtMs = requireUnexpiredCapability(payload, now().getTime());
          replay.accept(payload, now());
          const candidate = loadCandidate(options, payload.principal_id, payload.issuer_hash, payload.project_id, payload.artifact_id, payload.artifact_sha256);
          const verified = await verifyIntegrity(candidate);
          const revalidated = loadCandidate(options, payload.principal_id, payload.issuer_hash, payload.project_id, payload.artifact_id, payload.artifact_sha256);
          if (!sameIdentity(verified.identity, revalidated.identity)) throw new ReadonlyMediaGatewayError("MEDIA_INTEGRITY_FAILED");
          let handle = createReadonlyMediaHandle(random);
          while (capabilities.has(handle) || sessions.has(handle)) handle = createReadonlyMediaHandle(random);
          const issuanceTimeMs = now().getTime();
          requireUnexpiredCapability(payload, issuanceTimeMs);
          const expiresAtMs = Math.min(signedExpiresAtMs, issuanceTimeMs + READONLY_MEDIA_GATEWAY_CAPABILITY_TTL_MS);
          capabilities.set(handle, { ...revalidated, handle, principal_id: payload.principal_id, issuer_hash: payload.issuer_hash, expires_at_ms: expiresAtMs, consumed: false });
          json(response, 201, READONLY_MEDIA_CAPABILITY_RESPONSE_SCHEMA.parse({ capability_handle: handle, expires_at: new Date(expiresAtMs).toISOString() }));
          return;
        }
        const capabilityMatch = /^\/media\/v1\/c\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
        if (capabilityMatch && (request.method === "GET" || request.method === "HEAD")) {
          if (request.headers.origin !== allowedOrigin) throw new ReadonlyMediaGatewayError("MEDIA_ORIGIN_DENIED");
          const record = capabilities.get(capabilityMatch[1]!);
          if (!record || record.expires_at_ms <= now().getTime()) throw new ReadonlyMediaGatewayError("MEDIA_CAPABILITY_INVALID");
          validateRecord(record);
          if (record.consumed) throw new ReadonlyMediaGatewayError("MEDIA_CAPABILITY_REPLAYED");
          if (request.method === "HEAD") { response.statusCode = 204; mediaHeaders(response, allowedOrigin); response.end(); return; }
          const principalSessions = [...sessions.values()].filter((item) => item.principal_id === record.principal_id).length;
          if (sessions.size >= READONLY_MEDIA_GATEWAY_MAX_SESSIONS || principalSessions >= READONLY_MEDIA_GATEWAY_MAX_SESSIONS_PER_PRINCIPAL) {
            throw new ReadonlyMediaGatewayError("MEDIA_SESSION_CAPACITY_EXCEEDED");
          }
          record.consumed = true;
          let sessionHandle = createReadonlyMediaHandle(random);
          while (capabilities.has(sessionHandle) || sessions.has(sessionHandle)) sessionHandle = createReadonlyMediaHandle(random);
          sessions.set(sessionHandle, { ...record, handle: sessionHandle, expires_at_ms: now().getTime() + READONLY_MEDIA_GATEWAY_SESSION_TTL_MS });
          response.statusCode = 302;
          mediaHeaders(response, allowedOrigin);
          response.setHeader("location", `/media/v1/s/${sessionHandle}`);
          response.end();
          return;
        }
        const sessionMatch = /^\/media\/v1\/s\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
        if (sessionMatch && (request.method === "GET" || request.method === "HEAD")) {
          const session = sessions.get(sessionMatch[1]!);
          if (!session || session.expires_at_ms <= now().getTime()) throw new ReadonlyMediaGatewayError("MEDIA_SESSION_EXPIRED");
          try {
            serve(request, response, session);
          } catch (error) {
            if (!(error instanceof ReadonlyMediaGatewayError)
              || !["MEDIA_ORIGIN_DENIED", "MEDIA_RANGE_INVALID"].includes(error.code)) {
              sessions.delete(session.handle);
            }
            throw error;
          }
          return;
        }
        throw new ReadonlyMediaGatewayError("MEDIA_NOT_FOUND");
      } catch (error) {
        const domain = stableError(error);
        if (!response.headersSent) {
          const requestPath = (() => {
            try { return new URL(request.url ?? "/", "http://127.0.0.1").pathname; } catch { return ""; }
          })();
          if (request.headers.origin === allowedOrigin && /^\/media\/v1\/[cs]\//.test(requestPath)) mediaHeaders(response, allowedOrigin);
          json(response, errorStatus(domain.code), { ok: false, error: { code: domain.code } });
        }
        else response.destroy();
      }
    })();
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? READONLY_MEDIA_GATEWAY_DEFAULT_PORT, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new ReadonlyMediaGatewayError("MEDIA_GATEWAY_LISTEN_FAILED");
  return {
    server,
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    counts: () => ({
      capabilities: [...capabilities.values()].filter((item) => !item.consumed && item.expires_at_ms > now().getTime()).length,
      sessions: [...sessions.values()].filter((item) => item.expires_at_ms > now().getTime()).length
    }),
    close: () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  };
}
