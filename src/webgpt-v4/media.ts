import { createReadStream, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { paths } from "../paths.js";
import type { M0Database } from "../storage/sqlite.js";
import { productionArtifact, publicArtifact } from "./domain.js";
import { sha256, WebGptV4Error, type WebGptV4Actor } from "./types.js";

const MEDIA_GRANT_TTL_MS = 5 * 60 * 1000;
const MAX_MODEL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_FRAME_PAGE = 12;
const MEDIA_ANALYZER_VERSION = "webgpt-v4-frames-v2";
const MEDIA_ANALYSIS_TIMEOUT_MS = 120_000;
const MEDIA_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MEDIA_CACHE_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const execFileAsync = promisify(execFile);
let lastCacheCleanupAt = 0;

export class MediaAnalysisQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly concurrency = 1, private readonly maximumWaiting = 4, private readonly timeoutMs = MEDIA_ANALYSIS_TIMEOUT_MS) {}

  status(): { active: number; waiting: number; capacity: number } {
    return { active: this.active, waiting: this.waiting.length, capacity: this.concurrency + this.maximumWaiting };
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency && this.waiting.length >= this.maximumWaiting) {
      return Promise.reject(new WebGptV4Error("MEDIA_ANALYSIS_BUSY", "Media analysis queue is full; retry later.", undefined, true));
    }
    return new Promise<T>((resolveRun, rejectRun) => {
      const start = (): void => {
        this.active += 1;
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          rejectRun(new WebGptV4Error("MEDIA_ANALYSIS_TIMEOUT", "Media analysis exceeded the 120 second limit.", undefined, true));
        }, this.timeoutMs);
        void Promise.resolve().then(operation).then((value) => {
          if (!settled) resolveRun(value);
        }, (error) => {
          if (!settled) rejectRun(error);
        }).finally(() => {
          clearTimeout(timer);
          this.active -= 1;
          this.waiting.shift()?.();
        });
      };
      if (this.active < this.concurrency) start();
      else this.waiting.push(start);
    });
  }
}

export const mediaAnalysisQueue = new MediaAnalysisQueue();

export interface ModelImage {
  data: string;
  mime_type: "image/jpeg" | "image/png";
  timestamp_seconds?: number;
  sha256: string;
  reason?: "coverage" | "scene_change";
}

export interface MediaInspection {
  data: Record<string, unknown>;
  model_images: ModelImage[];
  playback: {
    available: boolean;
    url: string;
    expires_at: string;
  };
}

export interface MediaRuntimeOptions {
  public_origin?: string;
  ffmpeg_path?: string;
  now?: () => Date;
  analysis_root?: string;
  allowed_media_roots?: string[];
}

function now(options: MediaRuntimeOptions): Date {
  return options.now?.() ?? new Date();
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function hasSymlinkAncestor(child: string, parent: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  if (!isInside(target, root)) return true;
  let current = root;
  for (const part of relative(root, target).split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) return false;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

export function resolveProductionMediaPath(db: M0Database, projectId: string, artifactId: string, options: MediaRuntimeOptions = {}): { path: string; mime_type: string; filename: string; size: number } {
  const artifact = productionArtifact(db, projectId, artifactId);
  const configured = resolve(artifact.storage.uri);
  const allowedRoots = (options.allowed_media_roots ?? [paths.imageArtifactsRoot, paths.videoArtifactsRoot, paths.finalArtifactsRoot]).map((value) => resolve(value));
  const allowedRoot = allowedRoots.find((root) => isInside(configured, root));
  if (!allowedRoot || hasSymlinkAncestor(configured, allowedRoot) || !existsSync(configured)) {
    throw new WebGptV4Error("MEDIA_NOT_AVAILABLE", "Media storage is outside the approved artifact boundary.");
  }
  const actual = realpathSync(configured);
  if (!isInside(actual, realpathSync(allowedRoot))) throw new WebGptV4Error("MEDIA_NOT_AVAILABLE", "Media storage escaped the approved artifact boundary.");
  const stat = statSync(actual);
  if (!stat.isFile()) throw new WebGptV4Error("MEDIA_NOT_AVAILABLE", "Media artifact is not a regular file.");
  return { path: actual, mime_type: artifact.storage.mime_type, filename: artifact.storage.filename, size: stat.size };
}

export function createMediaGrant(
  db: M0Database,
  input: { actor: WebGptV4Actor; project_id: string; artifact_id: string },
  options: MediaRuntimeOptions = {}
): { token: string; grant_id: string; expires_at: string } {
  productionArtifact(db, input.project_id, input.artifact_id);
  const token = randomBytes(32).toString("base64url");
  const createdAt = now(options);
  const expiresAt = new Date(createdAt.getTime() + MEDIA_GRANT_TTL_MS).toISOString();
  const grantId = `media_grant_${randomUUID()}`;
  db.prepare("DELETE FROM webgpt_media_grants WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(createdAt.toISOString());
  db.prepare(`
    INSERT INTO webgpt_media_grants (grant_id, token_hash, actor_hash, project_id, artifact_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(grantId, sha256(token), input.actor.actor_hash, input.project_id, input.artifact_id, expiresAt, createdAt.toISOString());
  return { token, grant_id: grantId, expires_at: expiresAt };
}

export function invalidateMediaGrantsForRestart(db: M0Database): number {
  const result = db.prepare("DELETE FROM webgpt_media_grants").run() as { changes: number | bigint };
  return Number(result.changes);
}

export function validateMediaGrant(
  db: M0Database,
  input: { token: string; actor_hash: string; project_id: string; artifact_id: string },
  options: MediaRuntimeOptions = {}
): { grant_id: string; actor_hash: string; expires_at: string } {
  const row = db.prepare(`
    SELECT grant_id, actor_hash, project_id, artifact_id, expires_at, revoked_at
    FROM webgpt_media_grants WHERE token_hash = ?
  `).get(sha256(input.token)) as { grant_id: string; actor_hash: string; project_id: string; artifact_id: string; expires_at: string; revoked_at: string | null } | undefined;
  if (!row || row.revoked_at || row.actor_hash !== input.actor_hash || row.project_id !== input.project_id || row.artifact_id !== input.artifact_id || Date.parse(row.expires_at) <= now(options).getTime()) {
    throw new WebGptV4Error("MEDIA_GRANT_INVALID", "Media grant is invalid or expired.");
  }
  return { grant_id: row.grant_id, actor_hash: row.actor_hash, expires_at: row.expires_at };
}

function roundTimestamp(value: number): number {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

async function executableAvailable(candidate: string): Promise<boolean> {
  try {
    await execFileAsync(candidate, ["-version"], { timeout: 5_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function resolveFfmpegExecutable(configured?: string): Promise<string> {
  const winGetLinks = process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe")
    : undefined;
  const candidates = [
    configured,
    process.env.FFMPEG_PATH,
    process.platform === "win32" ? "A:\\AI-VIDEO\\ffmpeg\\bin\\ffmpeg.exe" : undefined,
    winGetLinks,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));
  for (const candidate of [...new Set(candidates)]) {
    if (await executableAvailable(candidate)) return candidate;
  }
  throw new WebGptV4Error("MEDIA_TOOL_UNAVAILABLE", "FFmpeg is not available for video inspection.");
}

export async function resolveFfprobeExecutable(ffmpegPath: string): Promise<string> {
  const adjacent = ffmpegPath.replace(/ffmpeg(?:\.exe)?$/i, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const candidates = [
    process.env.FFPROBE_PATH,
    adjacent !== ffmpegPath ? adjacent : undefined,
    process.platform === "win32" ? "A:\\AI-VIDEO\\ffmpeg\\bin\\ffprobe.exe" : undefined,
    process.platform === "win32" ? "ffprobe.exe" : "ffprobe"
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));
  for (const candidate of [...new Set(candidates)]) {
    if (await executableAvailable(candidate)) return candidate;
  }
  throw new WebGptV4Error("MEDIA_TOOL_UNAVAILABLE", "FFprobe is not available for video inspection.");
}

interface PublicVideoValidation {
  status: "PASS" | "FAIL" | "NOT_TESTED";
  ffprobe_exit_code: number | null;
  has_video_stream: boolean;
  duration_seconds: number | null;
  stream_count: number;
  error: string;
}

async function validateVideo(filePath: string, ffmpegPath: string): Promise<PublicVideoValidation> {
  const ffprobe = await resolveFfprobeExecutable(ffmpegPath);
  try {
    const { stdout } = await execFileAsync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-show_streams", "-of", "json", filePath], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true
    });
    const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; duration?: string }>; format?: { duration?: string } };
    const streams = parsed.streams ?? [];
    const videoStreams = streams.filter((stream) => stream.codec_type === "video");
    const rawDuration = parsed.format?.duration ?? videoStreams[0]?.duration;
    const duration = Number(rawDuration);
    const durationSeconds = Number.isFinite(duration) && duration > 0 ? duration : null;
    const pass = videoStreams.length > 0 && durationSeconds !== null;
    return {
      status: pass ? "PASS" : "FAIL",
      ffprobe_exit_code: 0,
      has_video_stream: videoStreams.length > 0,
      duration_seconds: durationSeconds,
      stream_count: streams.length,
      error: pass ? "" : "ffprobe did not report a video stream and positive duration."
    };
  } catch (error) {
    return {
      status: "FAIL",
      ffprobe_exit_code: typeof (error as { code?: unknown }).code === "number" ? Number((error as { code: number }).code) : 1,
      has_video_stream: false,
      duration_seconds: null,
      stream_count: 0,
      error: "Video validation failed."
    };
  }
}

export function coverageFramePlan(durationSeconds: number, sceneTimestamps: number[] = []): Array<{ timestamp_seconds: number; reason: "coverage" | "scene_change" }> {
  const duration = Math.max(0, durationSeconds);
  const coverageCount = Math.min(36, Math.max(2, Math.ceil(duration) + 1));
  const coverage = Array.from({ length: coverageCount }, (_, index) => roundTimestamp(coverageCount === 1 ? 0 : (duration * index) / (coverageCount - 1)));
  const result = new Map<number, "coverage" | "scene_change">();
  for (const timestamp of coverage) result.set(timestamp, "coverage");
  for (const timestamp of sceneTimestamps.filter(Number.isFinite).filter((value) => value >= 0 && value <= duration).slice(0, 12)) {
    result.set(roundTimestamp(timestamp), "scene_change");
  }
  return [...result.entries()].sort(([left], [right]) => left - right).slice(0, 48).map(([timestamp_seconds, reason]) => ({ timestamp_seconds, reason }));
}

async function detectSceneChanges(filePath: string, ffmpegPath: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-i", filePath,
      "-vf", "select=gt(scene\\,0.30),metadata=print:file=-",
      "-an", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return [...stdout.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
  } catch {
    return [];
  }
}

function framePath(root: string, artifactId: string, timestamp: number): string {
  const safeTimestamp = String(Math.round(timestamp * 1000)).padStart(8, "0");
  return join(root, artifactId, `${safeTimestamp}.jpg`);
}

function analysisCacheRoot(root: string, artifactSha256: string, plan: Array<{ timestamp_seconds: number }>, frameLimit: number): string {
  const key = sha256(JSON.stringify({ artifact_sha256: artifactSha256, analyzer: MEDIA_ANALYZER_VERSION, plan, frame_limit: frameLimit, scale: 1280, quality: 3 }));
  return join(root, key);
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

export async function cleanupMediaAnalysisCache(root: string, options: { now?: number; max_age_ms?: number; max_bytes?: number } = {}): Promise<{ removed: number; bytes: number }> {
  const current = options.now ?? Date.now();
  const maxAge = options.max_age_ms ?? MEDIA_CACHE_MAX_AGE_MS;
  const maxBytes = options.max_bytes ?? MEDIA_CACHE_MAX_BYTES;
  await mkdir(root, { recursive: true });
  const candidates: Array<{ path: string; modified: number; bytes: number }> = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const target = join(root, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) continue;
    candidates.push({ path: target, modified: info.mtimeMs, bytes: await directoryBytes(target) });
  }
  let bytes = candidates.reduce((sum, item) => sum + item.bytes, 0);
  let removed = 0;
  for (const item of candidates.sort((left, right) => left.modified - right.modified)) {
    if (current - item.modified <= maxAge && bytes <= maxBytes) continue;
    await rm(item.path, { recursive: true, force: true });
    bytes -= item.bytes;
    removed += 1;
  }
  return { removed, bytes };
}

async function extractFrame(filePath: string, outputPath: string, timestamp: number, ffmpegPath: string): Promise<void> {
  if (existsSync(outputPath) && statSync(outputPath).size > 0) return;
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await execFileAsync(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-ss", timestamp.toFixed(3), "-i", filePath,
      "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", "-y", outputPath
    ], { timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  } catch {
    throw new WebGptV4Error("MEDIA_ANALYSIS_FAILED", "A review frame could not be extracted from the video.");
  }
}

function decodableTimestamp(timestamp: number, durationSeconds: number): number {
  if (durationSeconds <= 0 || timestamp < durationSeconds) return timestamp;
  return Math.max(0, durationSeconds - Math.min(0.05, durationSeconds / 2));
}

function playbackUrl(origin: string | undefined, projectId: string, artifactId: string, token: string): string {
  if (!origin) return "";
  const base = origin.replace(/\/$/, "");
  return `${base}/media/v4/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/content?grant=${encodeURIComponent(token)}`;
}

export async function inspectProductionMedia(
  db: M0Database,
  input: { project_id: string; artifact_id: string; frame_offset?: number; frame_limit?: number },
  actor: WebGptV4Actor,
  options: MediaRuntimeOptions = {}
): Promise<MediaInspection> {
  const artifact = productionArtifact(db, input.project_id, input.artifact_id);
  const media = resolveProductionMediaPath(db, input.project_id, input.artifact_id, options);
  const modelImages: ModelImage[] = [];
  let analysis: Record<string, unknown>;

  if (artifact.artifact_type === "image") {
    if (media.size > MAX_MODEL_IMAGE_BYTES) throw new WebGptV4Error("MEDIA_TOO_LARGE", "Image exceeds the model inspection limit.");
    const mime = artifact.storage.mime_type === "image/png" ? "image/png" : "image/jpeg";
    const bytes = await readFile(media.path);
    modelImages.push({ data: bytes.toString("base64"), mime_type: mime, sha256: sha256(bytes) });
    analysis = { kind: "image", model_input: "original_image", sha256: artifact.metadata.sha256, width: artifact.metadata.width, height: artifact.metadata.height };
  } else {
    const result = await mediaAnalysisQueue.run(async () => {
      const ffmpeg = await resolveFfmpegExecutable(options.ffmpeg_path);
      const validation = await validateVideo(media.path, ffmpeg);
      if (validation.status !== "PASS" || validation.duration_seconds === null) throw new WebGptV4Error("MEDIA_INVALID", validation.error || "Video validation failed.");
      const scenes = await detectSceneChanges(media.path, ffmpeg);
      const plan = coverageFramePlan(validation.duration_seconds, scenes);
      const offset = Math.max(0, Math.trunc(input.frame_offset ?? 0));
      const limit = Math.min(MAX_FRAME_PAGE, Math.max(1, Math.trunc(input.frame_limit ?? 8)));
      const selected = plan.slice(offset, offset + limit);
      const generatedRoot = options.analysis_root ?? join(paths.mediaRoot, "analysis", "webgpt-v4");
      if (Date.now() - lastCacheCleanupAt > 60 * 60 * 1000) {
        await cleanupMediaAnalysisCache(generatedRoot);
        lastCacheCleanupAt = Date.now();
      }
      const root = analysisCacheRoot(generatedRoot, artifact.metadata.sha256, plan, limit);
      const frames: ModelImage[] = [];
      const modelFrames: Array<{ timestamp_seconds: number; reason: "coverage" | "scene_change"; sha256: string }> = [];
      for (const frame of selected) {
        const output = framePath(root, artifact.artifact_id, frame.timestamp_seconds);
        await extractFrame(media.path, output, decodableTimestamp(frame.timestamp_seconds, validation.duration_seconds), ffmpeg);
        const bytes = await readFile(output);
        const frameHash = sha256(bytes);
        frames.push({ data: bytes.toString("base64"), mime_type: "image/jpeg", timestamp_seconds: frame.timestamp_seconds, reason: frame.reason, sha256: frameHash });
        modelFrames.push({ timestamp_seconds: frame.timestamp_seconds, reason: frame.reason, sha256: frameHash });
      }
      return { frames, analysis: {
        kind: "video", model_input: "timestamped_frame_bundle", direct_video_model_input: false,
        analyzer_version: MEDIA_ANALYZER_VERSION, validation, frame_plan: plan, model_frames: modelFrames,
        frame_page: { offset, limit, returned: selected.length, total: plan.length, has_more: offset + selected.length < plan.length },
        scene_change_frames: scenes.length, sha256: artifact.metadata.sha256
      } };
    });
    modelImages.push(...result.frames);
    analysis = result.analysis;
  }

  const grant = createMediaGrant(db, { actor, project_id: input.project_id, artifact_id: input.artifact_id }, options);
  const url = playbackUrl(options.public_origin, input.project_id, input.artifact_id, grant.token);

  return {
    data: { artifact: publicArtifact(artifact), analysis },
    model_images: modelImages,
    playback: { available: Boolean(url), url, expires_at: grant.expires_at }
  };
}

function singleRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new WebGptV4Error("INVALID_MEDIA_RANGE", "Only one byte range is supported.");
  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart && !rawEnd) throw new WebGptV4Error("INVALID_MEDIA_RANGE", "Media range is empty.");
  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) throw new WebGptV4Error("INVALID_MEDIA_RANGE", "Media suffix range is invalid.");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) throw new WebGptV4Error("INVALID_MEDIA_RANGE", "Media range is outside the file.");
  return { start, end: Math.min(end, size - 1) };
}

export function handleMediaGatewayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  input: { project_id: string; artifact_id: string; token: string; actor_hash: string; db: M0Database; allowed_origin?: string; options?: MediaRuntimeOptions }
): void {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") throw new WebGptV4Error("METHOD_NOT_ALLOWED", "Media gateway accepts GET and HEAD only.");
    validateMediaGrant(input.db, { token: input.token, actor_hash: input.actor_hash, project_id: input.project_id, artifact_id: input.artifact_id }, input.options);
    const media = resolveProductionMediaPath(input.db, input.project_id, input.artifact_id, input.options);
    const range = singleRange(typeof request.headers.range === "string" ? request.headers.range : undefined, media.size);
    const status = range ? 206 : 200;
    const start = range?.start ?? 0;
    const end = range?.end ?? media.size - 1;
    response.statusCode = status;
    response.setHeader("content-type", media.mime_type || (extname(media.filename).toLowerCase() === ".mp4" ? "video/mp4" : "application/octet-stream"));
    response.setHeader("accept-ranges", "bytes");
    response.setHeader("content-length", String(end - start + 1));
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (range) response.setHeader("content-range", `bytes ${start}-${end}/${media.size}`);
    if (input.allowed_origin) {
      response.setHeader("access-control-allow-origin", input.allowed_origin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("vary", "Origin");
    }
    if (request.method === "HEAD") { response.end(); return; }
    createReadStream(media.path, { start, end }).pipe(response);
  } catch (error) {
    const domain = error instanceof WebGptV4Error ? error : new WebGptV4Error("MEDIA_GATEWAY_ERROR", "Media request failed.");
    response.statusCode = domain.code === "MEDIA_GRANT_INVALID" ? 401 : domain.code === "INVALID_MEDIA_RANGE" ? 416 : domain.code === "METHOD_NOT_ALLOWED" ? 405 : 404;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify({ ok: false, error: { code: domain.code, message: domain.message } }));
  }
}
