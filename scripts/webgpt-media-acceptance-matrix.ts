import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { createReadonlyMediaCapabilityRequest, parseReadonlyMediaCapabilityKey, READONLY_MEDIA_CAPABILITY_TTL_MS } from "../src/webgpt-cloud/mediaCapability.js";
import { exportReadonlySnapshotFromDatabase } from "../src/webgpt-cloud/dataSource.js";
import { openM0DatabaseConnection } from "../src/storage/sqlite.js";
import { revokeWebGptProjectMembership } from "../src/webgpt-v4/authorizationAdmin.js";
import {
  READONLY_MEDIA_CHATGPT_SANDBOX_ORIGIN,
  READONLY_MEDIA_GATEWAY_HASH_TIMEOUT_MS
} from "../src/webgpt-media-gateway/runtime.js";

const RUN_ID = /^run_[0-9a-f]{32}$/;
const HANDLE = /^[A-Za-z0-9_-]{43}$/;
const FIXTURE_VERSION = "readonly-media-acceptance-fixture-v2";
const WIDGET_ORIGIN = READONLY_MEDIA_CHATGPT_SANDBOX_ORIGIN;
function testTimeout(name: string, fallback: number): number {
  if (process.env.NODE_ENV !== "test") return fallback;
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 50 && value <= 5_000 ? value : fallback;
}

const REQUEST_TIMEOUT_MS = testTimeout("MEDIA_ACCEPTANCE_TEST_REQUEST_TIMEOUT_MS", 15_000);
const CAPABILITY_REQUEST_TIMEOUT_MS = testTimeout(
  "MEDIA_ACCEPTANCE_TEST_CAPABILITY_TIMEOUT_MS",
  READONLY_MEDIA_GATEWAY_HASH_TIMEOUT_MS + 15_000
);
const CAPABILITY_HANDLE_EXPIRY_LEAD_MS = testTimeout(
  "MEDIA_ACCEPTANCE_TEST_HANDLE_EXPIRY_LEAD_MS",
  CAPABILITY_REQUEST_TIMEOUT_MS
);
const JSON_RESPONSE_MAX_BYTES = 16 * 1024;
const MANIFEST_MAX_BYTES = 16 * 1024;
const MANIFEST_NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const DISTINCT_MEDIA_VALIDATIONS = 4;
// One issuance per media validation, plus stale-envelope, expiring-handle, and retained-project issuances.
const MATRIX_CAPABILITY_REQUESTS = DISTINCT_MEDIA_VALIDATIONS + 3;
// health/ready, activation/media/replay per media, then expired, revoked, and retained activation/media requests.
const MATRIX_ORDINARY_REQUESTS = 2 + DISTINCT_MEDIA_VALIDATIONS * 3 + 4;
// The expiry probe permits up to five seconds of timestamp drift and waits an additional 25ms after expiry.
const MATRIX_EXPIRY_WAIT_ALLOWANCE_MS = 5_025;
// Covers bounded local fixture validation, Snapshot export, revocation, and event-loop scheduling outside HTTP deadlines.
const MATRIX_LOCAL_SETUP_ALLOWANCE_MS = 2 * 60_000;
const MATRIX_TIMEOUT_MS = testTimeout(
  "MEDIA_ACCEPTANCE_TEST_MATRIX_TIMEOUT_MS",
  MATRIX_CAPABILITY_REQUESTS * CAPABILITY_REQUEST_TIMEOUT_MS
    + MATRIX_ORDINARY_REQUESTS * REQUEST_TIMEOUT_MS
    + CAPABILITY_HANDLE_EXPIRY_LEAD_MS
    + MATRIX_EXPIRY_WAIT_ALLOWANCE_MS
    + MATRIX_LOCAL_SETUP_ALLOWANCE_MS
);

class MatrixError extends Error {
  constructor(readonly code: string) { super(code); }
}

type ManifestMedia = {
  artifact_id: string;
  media_relative_path: string;
  media_sha256: string;
  mime_type: "image/png" | "image/jpeg" | "video/mp4";
  role: "storyboard_image" | "generated_clip";
};

type ManifestProject = {
  project_id: string;
  media: ManifestMedia[];
};

type Manifest = {
  fixture_version: typeof FIXTURE_VERSION;
  run_id: string;
  database_file: "app.sqlite";
  issuer_hash: string;
  resource_url: string;
  projects: ManifestProject[];
};

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : "";
  if (!value || value.startsWith("--")) throw new MatrixError("MEDIA_ACCEPTANCE_ARGUMENT_REQUIRED");
  return value;
}

function fixtureRoot(runId: string): string {
  if (!RUN_ID.test(runId)) throw new MatrixError("MEDIA_ACCEPTANCE_RUN_ID_INVALID");
  const workspace = realpathSync(resolve(process.cwd()));
  const root = resolve(workspace, "data", "webgpt", "media-acceptance", runId);
  const rel = relative(workspace, root);
  if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(root) || lstatSync(root).isSymbolicLink()) {
    throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  }
  let cursor = workspace;
  for (const part of rel.split(/[\\/]+/)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  }
  const real = realpathSync(root);
  const realRel = relative(workspace, real);
  if (realRel.startsWith("..") || isAbsolute(realRel)) throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  return real;
}

function readManifest(root: string, runId: string): Manifest {
  const manifestPath = resolve(root, "fixture.json");
  let value: unknown;
  let descriptor: number;
  try {
    descriptor = openSync(manifestPath, constants.O_RDONLY | MANIFEST_NOFOLLOW_FLAG);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ELOOP" || code === "EMLINK") throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
    throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  }
  try {
    let size: number;
    let openedDevice: bigint;
    let openedInode: bigint;
    try {
      const descriptorStats = fstatSync(descriptor, { bigint: true });
      const pathStats = lstatSync(manifestPath, { bigint: true });
      if (!descriptorStats.isFile() || !pathStats.isFile()
        || descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino
        || descriptorStats.nlink !== 1n || pathStats.nlink !== 1n) {
        throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
      }
      const manifestReal = realpathSync(manifestPath);
      const manifestRel = relative(realpathSync(root), manifestReal);
      if (!manifestRel || manifestRel.startsWith("..") || isAbsolute(manifestRel)) {
        throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
      }
      if (descriptorStats.size > BigInt(MANIFEST_MAX_BYTES)) throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_TOO_LARGE");
      if (descriptorStats.size < 1n || descriptorStats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
      }
      openedDevice = descriptorStats.dev;
      openedInode = descriptorStats.ino;
      size = Number(descriptorStats.size);
    } catch (error) {
      if (error instanceof MatrixError) throw error;
      throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
    }
    const bytes = Buffer.alloc(size);
    try {
      if (readSync(descriptor, bytes, 0, size, 0) !== size) {
        throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
      }
      const finalStats = fstatSync(descriptor, { bigint: true });
      if (finalStats.dev !== openedDevice || finalStats.ino !== openedInode || finalStats.nlink !== 1n) {
        throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
      }
      if (finalStats.size > BigInt(MANIFEST_MAX_BYTES)) throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_TOO_LARGE");
      if (finalStats.size !== BigInt(size)) throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof MatrixError) throw error;
      throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
    }
  } finally {
    closeSync(descriptor);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  const manifest = value as Partial<Manifest>;
  if (manifest.fixture_version !== FIXTURE_VERSION || manifest.run_id !== runId || manifest.database_file !== "app.sqlite"
    || !/^[0-9a-f]{64}$/.test(manifest.issuer_hash ?? "") || typeof manifest.resource_url !== "string"
    || !Array.isArray(manifest.projects) || manifest.projects.length !== 2
    || manifest.projects.some((project) => !project || typeof project.project_id !== "string" || !Array.isArray(project.media)
      || project.media.length !== 2 || project.media.some((media) => !media || typeof media.artifact_id !== "string"
        || typeof media.media_relative_path !== "string" || !media.media_relative_path
        || !/^[0-9a-f]{64}$/.test(media.media_sha256 ?? "") || !["image/png", "image/jpeg", "video/mp4"].includes(media.mime_type)
        || !["storyboard_image", "generated_clip"].includes(media.role))
      || project.media.filter((media) => media.role === "storyboard_image" && ["image/png", "image/jpeg"].includes(media.mime_type)).length !== 1
      || project.media.filter((media) => media.role === "generated_clip" && media.mime_type === "video/mp4").length !== 1)) {
    throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  }
  const media = manifest.projects.flatMap((project) => project.media);
  if (new Set(media.map((item) => item.artifact_id)).size !== 4 || new Set(media.map((item) => item.media_sha256)).size !== 4) {
    throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  }
  return manifest as Manifest;
}

function expectedMediaFile(root: string, media: ManifestMedia): { path: string; size: number } {
  const path = resolve(root, media.media_relative_path);
  const rel = relative(realpathSync(root), path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  }
  const real = realpathSync(path);
  const realRel = relative(realpathSync(root), real);
  if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  const size = statSync(real).size;
  if (!Number.isSafeInteger(size) || size < 1) throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  return { path: real, size };
}

function expectedVideoSuffix(root: string, media: ManifestMedia): { byte_length: number; sha256: string; start: number; end: number; total: number } {
  const { path, size: total } = expectedMediaFile(root, media);
  const byteLength = Math.min(16, total);
  const bytes = Buffer.alloc(byteLength);
  const descriptor = openSync(path, "r");
  try {
    if (readSync(descriptor, bytes, 0, byteLength, total - byteLength) !== byteLength) throw new MatrixError("MEDIA_ACCEPTANCE_MANIFEST_INVALID");
  } finally {
    closeSync(descriptor);
  }
  return {
    byte_length: byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    start: total - byteLength,
    end: total - 1,
    total
  };
}

function gatewayOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new MatrixError("MEDIA_ACCEPTANCE_URL_INVALID"); }
  const approvedPublicOrigin = url.origin === "https://media.skmt617.top";
  const approvedLoopbackOrigin = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (!approvedPublicOrigin && !approvedLoopbackOrigin) {
    throw new MatrixError("MEDIA_ACCEPTANCE_URL_INVALID");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new MatrixError("MEDIA_ACCEPTANCE_URL_INVALID");
  return url.origin;
}

async function stdinKey(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 128) throw new MatrixError("MEDIA_CAPABILITY_KEY_INVALID");
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new MatrixError("MEDIA_CAPABILITY_KEY_INVALID");
  return value;
}

type BoundedResponse = {
  response: Response;
  json?: Record<string, unknown>;
  byte_length?: number;
  body_sha256?: string;
};

async function readBoundedResponseBody(response: Response, maximumBytes: number, digest: boolean, captureBytes = false): Promise<{
  byte_length: number;
  body_sha256?: string;
  body_bytes?: Buffer;
}> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new MatrixError("MEDIA_ACCEPTANCE_RESPONSE_INVALID");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) throw new MatrixError("MEDIA_ACCEPTANCE_RESPONSE_INVALID");
    const advertisedBytes = Number(contentLength);
    if (!Number.isSafeInteger(advertisedBytes)) throw new MatrixError("MEDIA_ACCEPTANCE_RESPONSE_INVALID");
    if (advertisedBytes > maximumBytes) {
      try { await response.body?.cancel(); } catch { /* the bounded result remains controlling */ }
      throw new MatrixError("MEDIA_ACCEPTANCE_RESPONSE_TOO_LARGE");
    }
  }
  if (!response.body) {
    return {
      byte_length: 0,
      ...(digest ? { body_sha256: createHash("sha256").digest("hex") } : {}),
      ...(captureBytes ? { body_bytes: Buffer.alloc(0) } : {})
    };
  }
  const reader = response.body.getReader();
  const hash = digest ? createHash("sha256") : null;
  const chunks: Buffer[] | undefined = captureBytes ? [] : undefined;
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        try { await reader.cancel(); } catch { /* the bounded result remains controlling */ }
        throw new MatrixError("MEDIA_ACCEPTANCE_RESPONSE_TOO_LARGE");
      }
      hash?.update(value);
      chunks?.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return {
    byte_length: byteLength,
    ...(hash ? { body_sha256: hash.digest("hex") } : {}),
    ...(chunks ? { body_bytes: Buffer.concat(chunks, byteLength) } : {})
  };
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    throw new MatrixError("MEDIA_ACCEPTANCE_RESPONSE_INVALID");
  }
}

async function request(
  overallSignal: AbortSignal,
  input: string,
  init: RequestInit = {},
  bodyMode: "none" | "json" | "bytes" | "digest" = "none",
  timeoutMs = REQUEST_TIMEOUT_MS,
  maximumBodyBytes?: number
): Promise<BoundedResponse> {
  const requestController = new AbortController();
  const requestTimer = setTimeout(() => requestController.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: AbortSignal.any([overallSignal, requestController.signal]) });
    if (bodyMode === "json") {
      let value: unknown;
      try {
        const body = await readBoundedResponseBody(response, JSON_RESPONSE_MAX_BYTES, false, true);
        value = JSON.parse(body.body_bytes!.toString("utf8"));
      } catch (error) {
        if (error instanceof MatrixError) throw error;
        if (overallSignal.aborted || requestController.signal.aborted) throw error;
        throw new MatrixError("MEDIA_ACCEPTANCE_RESPONSE_INVALID");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new MatrixError("MEDIA_ACCEPTANCE_RESPONSE_INVALID");
      return { response, json: value as Record<string, unknown> };
    }
    if (bodyMode === "bytes" || bodyMode === "digest") {
      const body = await readBoundedResponseBody(response, maximumBodyBytes ?? 0, bodyMode === "digest");
      return {
        response,
        ...body
      };
    }
    await discardResponseBody(response);
    return { response };
  } catch (error) {
    if (overallSignal.aborted) throw new MatrixError("MEDIA_ACCEPTANCE_MATRIX_TIMEOUT");
    if (requestController.signal.aborted) throw new MatrixError("MEDIA_ACCEPTANCE_REQUEST_TIMEOUT");
    if (error instanceof MatrixError) throw error;
    throw new MatrixError("MEDIA_ACCEPTANCE_REQUEST_FAILED");
  } finally {
    clearTimeout(requestTimer);
  }
}

function stableErrorCode(value: Record<string, unknown>): string | null {
  const error = value.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  return typeof (error as Record<string, unknown>).code === "string" ? String((error as Record<string, unknown>).code) : null;
}

function assertWidgetCors(response: Response): void {
  if (response.headers.get("access-control-allow-origin") !== WIDGET_ORIGIN
    || response.headers.get("access-control-allow-credentials") !== "true") {
    throw new MatrixError("MEDIA_ACCEPTANCE_CORS_FAILED");
  }
}

async function main(): Promise<void> {
  const matrixController = new AbortController();
  const matrixTimer = setTimeout(() => matrixController.abort(), MATRIX_TIMEOUT_MS);
  try {
  const runId = arg("--run");
  const origin = gatewayOrigin(arg("--origin"));
  const kid = arg("--kid");
  const root = fixtureRoot(runId);
  const manifest = readManifest(root, runId);
  const databasePath = resolve(root, manifest.database_file);
  if (!existsSync(databasePath) || lstatSync(databasePath).isSymbolicLink()) throw new MatrixError("MEDIA_ACCEPTANCE_ROOT_UNSAFE");
  const encodedKey = await stdinKey();
  const keyring = { active: parseReadonlyMediaCapabilityKey(kid, encodedKey) };
  const snapshot = exportReadonlySnapshotFromDatabase({
    database_path: databasePath,
    issuer_hash: manifest.issuer_hash,
    resource_url: manifest.resource_url
  });
  const principal = snapshot.authorization.principals.find((item) =>
    manifest.projects.every((project) => item.project_ids.includes(project.project_id))
  );
  if (!principal) throw new MatrixError("MEDIA_ACCEPTANCE_AUTHORIZATION_INVALID");

  const requestEnvelope = (project: ManifestProject, media: ManifestMedia, now?: Date) =>
    createReadonlyMediaCapabilityRequest({
      principal_id: principal.principal_id,
      issuer_hash: manifest.issuer_hash,
      project_id: project.project_id,
      artifact_id: media.artifact_id,
      artifact_sha256: media.media_sha256,
      snapshot_fingerprint: snapshot.snapshot_fingerprint
    }, keyring, now ? { now: () => now } : {});

  const issue = async (project: ManifestProject, media: ManifestMedia, now?: Date): Promise<{ handle: string; expires_at_ms: number }> => {
    const result = await request(matrixController.signal, `${origin}/internal/v1/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(requestEnvelope(project, media, now))
    }, "json", CAPABILITY_REQUEST_TIMEOUT_MS);
    const response = result.response;
    if (response.status !== 201) throw new MatrixError("MEDIA_ACCEPTANCE_CAPABILITY_FAILED");
    const handle = result.json?.capability_handle;
    const expiresAt = result.json?.expires_at;
    const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    if (typeof handle !== "string" || !HANDLE.test(handle) || !Number.isFinite(expiresAtMs)
      || new Date(expiresAtMs).toISOString() !== expiresAt) throw new MatrixError("MEDIA_ACCEPTANCE_RESPONSE_INVALID");
    return { handle, expires_at_ms: expiresAtMs };
  };

  const activate = async (handle: string): Promise<{ capabilityUrl: string; sessionUrl: string }> => {
    const capabilityUrl = `${origin}/media/v1/c/${handle}`;
    const response = (await request(matrixController.signal, capabilityUrl, { headers: { origin: WIDGET_ORIGIN }, redirect: "manual" })).response;
    const location = response.headers.get("location");
    if (response.status === 403) throw new MatrixError("MEDIA_ACCEPTANCE_ORIGIN_DENIED");
    if (response.status === 404) throw new MatrixError("MEDIA_ACCEPTANCE_CAPABILITY_REJECTED");
    if (response.status === 429) throw new MatrixError("MEDIA_ACCEPTANCE_CAPACITY_EXCEEDED");
    if (response.status !== 302) throw new MatrixError("MEDIA_ACCEPTANCE_ACTIVATION_FAILED");
    assertWidgetCors(response);
    if (!location || !/^\/media\/v1\/s\/[A-Za-z0-9_-]{43}$/.test(location)) throw new MatrixError("MEDIA_ACCEPTANCE_REDIRECT_INVALID");
    return { capabilityUrl, sessionUrl: `${origin}${location}` };
  };

  const health = (await request(matrixController.signal, `${origin}/healthz`)).response;
  const ready = (await request(matrixController.signal, `${origin}/readyz`)).response;
  if (health.status !== 200 || ready.status !== 200) throw new MatrixError("MEDIA_ACCEPTANCE_GATEWAY_UNAVAILABLE");

  const waitForCapabilityExpiry = async (expiresAtMs: number): Promise<void> => {
    const remainingMs = expiresAtMs - Date.now();
    if (remainingMs <= 0 || remainingMs > CAPABILITY_HANDLE_EXPIRY_LEAD_MS + 5_000) {
      throw new MatrixError("MEDIA_ACCEPTANCE_EXPIRY_FAILED");
    }
    if (matrixController.signal.aborted) throw new MatrixError("MEDIA_ACCEPTANCE_MATRIX_TIMEOUT");
    await new Promise<void>((resolveWait, rejectWait) => {
      const timer = setTimeout(done, remainingMs + 25);
      const abort = () => {
        clearTimeout(timer);
        rejectWait(new MatrixError("MEDIA_ACCEPTANCE_MATRIX_TIMEOUT"));
      };
      function done(): void {
        matrixController.signal.removeEventListener("abort", abort);
        resolveWait();
      }
      matrixController.signal.addEventListener("abort", abort, { once: true });
    });
  };

  let revocationSession: string | null = null;
  for (const [projectIndex, project] of manifest.projects.entries()) {
    for (const media of project.media) {
      const activated = await activate((await issue(project, media)).handle);
      if (projectIndex === 1 && revocationSession === null) revocationSession = activated.sessionUrl;
      const videoSuffix = media.mime_type === "video/mp4" ? expectedVideoSuffix(root, media) : null;
      const maximumBodyBytes = videoSuffix?.byte_length ?? expectedMediaFile(root, media).size;
      const result = await request(matrixController.signal, activated.sessionUrl, {
        headers: media.mime_type === "video/mp4"
          ? { origin: WIDGET_ORIGIN, range: `bytes=-${videoSuffix!.byte_length}` }
          : { origin: WIDGET_ORIGIN }
      }, "digest", REQUEST_TIMEOUT_MS, maximumBodyBytes);
      const response = result.response;
      assertWidgetCors(response);
      if (media.mime_type === "video/mp4") {
        const expectedRange = `bytes ${videoSuffix!.start}-${videoSuffix!.end}/${videoSuffix!.total}`;
        if (response.status !== 206 || response.headers.get("accept-ranges") !== "bytes"
          || response.headers.get("content-range") !== expectedRange
          || response.headers.get("content-type") !== "video/mp4"
          || result.byte_length !== videoSuffix!.byte_length
          || result.body_sha256 !== videoSuffix!.sha256) {
          throw new MatrixError("MEDIA_ACCEPTANCE_RANGE_FAILED");
        }
      } else if (response.status !== 200 || response.headers.get("content-type") !== media.mime_type
        || (result.byte_length ?? 0) < 1 || result.body_sha256 !== media.media_sha256) {
        throw new MatrixError("MEDIA_ACCEPTANCE_IMAGE_FAILED");
      }
      const replay = await request(matrixController.signal, activated.capabilityUrl, { headers: { origin: WIDGET_ORIGIN }, redirect: "manual" }, "json");
      assertWidgetCors(replay.response);
      if (replay.response.status !== 409 || stableErrorCode(replay.json!) !== "MEDIA_CAPABILITY_REPLAYED") {
        throw new MatrixError("MEDIA_ACCEPTANCE_REPLAY_FAILED");
      }
    }
  }

  const staleEnvelopeAt = new Date(Date.now() - 10 * 60 * 1000);
  const staleEnvelope = await request(matrixController.signal, `${origin}/internal/v1/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(requestEnvelope(manifest.projects[0]!, manifest.projects[0]!.media[0]!, staleEnvelopeAt))
  }, "json", CAPABILITY_REQUEST_TIMEOUT_MS);
  if (staleEnvelope.response.status !== 404 || stableErrorCode(staleEnvelope.json!) !== "MEDIA_CAPABILITY_INVALID") {
    throw new MatrixError("MEDIA_ACCEPTANCE_EXPIRY_FAILED");
  }

  const expiringProject = manifest.projects[0]!;
  const expiringMedia = expiringProject.media[0]!;
  const expiringCapability = await issue(
    expiringProject,
    expiringMedia,
    new Date(Date.now() - READONLY_MEDIA_CAPABILITY_TTL_MS + CAPABILITY_HANDLE_EXPIRY_LEAD_MS)
  );
  await waitForCapabilityExpiry(expiringCapability.expires_at_ms);
  const expiredHandle = await request(matrixController.signal, `${origin}/media/v1/c/${expiringCapability.handle}`, {
    headers: { origin: WIDGET_ORIGIN }, redirect: "manual"
  }, "json");
  assertWidgetCors(expiredHandle.response);
  if (expiredHandle.response.status !== 404 || stableErrorCode(expiredHandle.json!) !== "MEDIA_CAPABILITY_INVALID") {
    throw new MatrixError("MEDIA_ACCEPTANCE_EXPIRY_FAILED");
  }

  const revokedProject = manifest.projects[1]!;
  if (!revocationSession) throw new MatrixError("MEDIA_ACCEPTANCE_REVOCATION_FAILED");
  const db = openM0DatabaseConnection(databasePath);
  try {
    if (!revokeWebGptProjectMembership(db, principal.principal_id, revokedProject.project_id, "MEDIA_ACCEPTANCE_REVOCATION").changed) {
      throw new MatrixError("MEDIA_ACCEPTANCE_REVOCATION_FAILED");
    }
  } finally { db.close(); }
  const revoked = await request(matrixController.signal, revocationSession, { headers: { origin: WIDGET_ORIGIN } }, "json");
  assertWidgetCors(revoked.response);
  if (revoked.response.status !== 404 || stableErrorCode(revoked.json!) !== "MEDIA_AUTHORIZATION_DENIED") {
    throw new MatrixError("MEDIA_ACCEPTANCE_REVOCATION_FAILED");
  }

  const retainedProject = manifest.projects[0]!;
  const retainedMedia = retainedProject.media.find((media) => media.mime_type === "video/mp4")!;
  const retainedSuffix = expectedVideoSuffix(root, retainedMedia);
  const retainedSession = await activate((await issue(retainedProject, retainedMedia)).handle);
  const retained = await request(matrixController.signal, retainedSession.sessionUrl, {
    headers: { origin: WIDGET_ORIGIN, range: `bytes=-${retainedSuffix.byte_length}` }
  }, "digest", REQUEST_TIMEOUT_MS, retainedSuffix.byte_length);
  assertWidgetCors(retained.response);
  if (retained.response.status !== 206 || retained.byte_length !== retainedSuffix.byte_length
    || retained.body_sha256 !== retainedSuffix.sha256
    || retained.response.headers.get("content-range") !== `bytes ${retainedSuffix.start}-${retainedSuffix.end}/${retainedSuffix.total}`) {
    throw new MatrixError("MEDIA_ACCEPTANCE_PROJECT_ISOLATION_FAILED");
  }

  console.log(JSON.stringify({
    result: "PASS",
    action: "matrix",
    run_id: runId,
    checks: {
      gateway_ready: true,
      widget_cors: true,
      image_200: true,
      mp4_range_206: true,
      project_switch: true,
      capability_replay: true,
      capability_expiry: true,
      membership_revocation: true,
      unaffected_project_retained: true,
      webm_support: false
    }
  }));
  } finally {
    clearTimeout(matrixTimer);
  }
}

main().catch((error) => {
  const code = error instanceof MatrixError ? error.code : "MEDIA_ACCEPTANCE_MATRIX_FAILED";
  console.error(JSON.stringify({ result: "FAIL", stable_error_code: code }));
  process.exitCode = 1;
});
