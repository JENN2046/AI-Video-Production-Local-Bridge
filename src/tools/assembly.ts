import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { canonicalizeJcs } from "../packages/domain/jcs.js";
import { ensureM0Directories, paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { resolveFfmpegExecutable, resolveFfprobeExecutable } from "../webgpt-v4/media.js";
import {
  cleanupCommittedMediaActivationMarkers,
  cleanupRolledBackMediaActivationFiles,
  registerMediaArtifact,
  validateAcceptedClipReference,
  type MediaArtifact
} from "./mediaArtifacts.js";
import { saveGenerationRun, type Confirmation, type GenerationRun } from "./generation.js";
import { getProject, listProjectShots, saveProject, type Project, type Shot, type ToolError } from "./projects.js";
import {
  getActiveWorkbenchDeliveryJob,
  getWorkbenchDeliveryState,
  type WorkbenchDeliveryJobRecord,
  type WorkbenchDeliveryWorkflowState
} from "./workbenchDeliveryState.js";
import { cleanupInterruptedWorkbenchExportJob } from "./workbenchDelivery.js";

const execFileAsync = promisify(execFile);

export const FINAL_ASSEMBLY_CONTRACT_VERSION = "final-assembly-v1";
export const FINAL_ASSEMBLY_TIMEOUT_MS = 30 * 60 * 1000;

const DELIVERY_STAGING_DIRECTORY = ".delivery";
const ASSEMBLY_STAGING_DIRECTORY = "assembly";
const QUEUEABLE_STATES = new Set<WorkbenchDeliveryWorkflowState>([
  "not_ready",
  "ready_to_assemble",
  "revision_requested"
]);

export interface AssemblyBlocker {
  code: string;
  shot_id?: string;
  order?: number;
}

export interface AssemblyInputSnapshot {
  contract_version: typeof FINAL_ASSEMBLY_CONTRACT_VERSION;
  project: {
    project_id: string;
    declared_duration_seconds: number;
    aspect_ratio: string;
    resolution: string;
    target_width: number;
    target_height: number;
  };
  shots: Array<{
    shot_id: string;
    order: number;
    artifact_id: string;
    blob_sha256: string;
    duration_seconds: number;
    source_duration_seconds: number;
  }>;
  expected_duration_seconds: number;
}

export interface AssemblyPreflight {
  ready: boolean;
  tooling_checked: boolean;
  contract_version: typeof FINAL_ASSEMBLY_CONTRACT_VERSION;
  input_fingerprint: string;
  target: {
    width: number;
    height: number;
    fps: 30;
    video_codec: "h264";
    audio_codec: "aac";
  } | null;
  shots: AssemblyInputSnapshot["shots"];
  expected_duration_seconds: number;
  blockers: AssemblyBlocker[];
}

export interface AssemblyProcessResult {
  exit_code: number | null;
  timed_out: boolean;
}

export interface AssemblyProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
}

export interface AssemblyProbeResult {
  streams: AssemblyProbeStream[];
  duration_seconds: number;
}

export interface AssemblyDependencies {
  ffmpeg_path?: string;
  ffprobe_path?: string;
  timeout_ms?: number;
  now?: () => Date;
  random_uuid?: () => string;
  run_process?: (command: string, args: string[], timeoutMs: number) => Promise<AssemblyProcessResult>;
  probe_media?: (ffprobePath: string, filePath: string) => Promise<AssemblyProbeResult>;
  before_render?: (outputPath: string) => void | Promise<void>;
  after_render?: (outputPath: string) => void | Promise<void>;
}

export type AssemblyResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError & { field?: string } };

type LegacyAssemblyResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: ToolError; blocking_reasons?: string[] };

interface InternalAssemblyInput {
  project: Project;
  shots: Shot[];
  snapshot: AssemblyInputSnapshot;
  input_fingerprint: string;
}

export interface ResolvedAssemblySource {
  shot_id: string;
  order: number;
  artifact_id: string;
  path: string;
  duration_seconds: number;
  has_audio: boolean;
}

interface DeliveryJobRow extends WorkbenchDeliveryJobRecord {
  input_json: string;
}

class AssemblyFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function now(dependencies: AssemblyDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}

function uuid(dependencies: AssemblyDependencies): string {
  return dependencies.random_uuid?.() ?? randomUUID();
}

function roundMediaNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function explicitConfirmed(confirmation?: Confirmation): boolean {
  return confirmation?.confirmation_level === "explicit" && confirmation.user_confirmed === true;
}

function isPathInside(child: string, parent: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function hasExistingSymlinkAncestor(child: string, parent: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  if (!isPathInside(target, root)) return true;
  let current = root;
  for (const part of relative(root, target).split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) return false;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function parseAspectRatio(value: string): { width: number; height: number } | null {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

export function parseAssemblyResolution(resolution: string, aspectRatio: string): { width: number; height: number } | null {
  const exact = /^(\d{2,4})[x:](\d{2,4})$/i.exec(resolution.trim());
  if (exact) {
    const width = Number(exact[1]);
    const height = Number(exact[2]);
    if (width < 16 || height < 16 || width > 8192 || height > 8192) return null;
    return { width: even(width), height: even(height) };
  }
  const progressive = /^(\d{2,4})p$/i.exec(resolution.trim());
  const ratio = parseAspectRatio(aspectRatio);
  if (!progressive || !ratio) return null;
  const shortSide = even(Number(progressive[1]));
  if (shortSide < 16 || shortSide > 4320) return null;
  const scale = ratio.width / ratio.height;
  const dimensions = scale >= 1
    ? { width: even(shortSide * scale), height: shortSide }
    : { width: shortSide, height: even(shortSide / scale) };
  return dimensions.width <= 8192 && dimensions.height <= 8192 ? dimensions : null;
}

export function assemblyInputFingerprint(snapshot: AssemblyInputSnapshot): string {
  return createHash("sha256").update(canonicalizeJcs(snapshot), "utf8").digest("hex");
}

function lifecycleForProject(db: M0Database, projectId: string): string | null {
  const row = db.prepare("SELECT lifecycle FROM workbench_project_meta WHERE project_id = ?")
    .get(projectId) as { lifecycle: string } | undefined;
  return row?.lifecycle ?? null;
}

function databaseAssemblyInput(
  projectId: string,
  db: M0Database,
  options: { allow_active_job?: boolean; allowed_states?: ReadonlySet<WorkbenchDeliveryWorkflowState> } = {}
): AssemblyResult<InternalAssemblyInput | { blockers: AssemblyBlocker[] }> {
  const project = getProject(db, projectId);
  if (!project) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: "Project was not found.", field: "project_id" } };
  const lifecycle = lifecycleForProject(db, projectId);
  if (lifecycle === null) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: "Project workbench metadata was not found.", field: "project_id" } };
  if (lifecycle === "archived") return { ok: false, error: { code: "PROJECT_ARCHIVED", message: "Archived projects are read-only.", field: "project_id" } };
  const delivery = getWorkbenchDeliveryState(db, projectId);
  if (!delivery) return { ok: false, error: { code: "DELIVERY_STATE_MISSING", message: "Project delivery state is unavailable.", field: "project_id" } };
  if (delivery.workflow_state === "closed") return { ok: false, error: { code: "PROJECT_CLOSED", message: "Closed projects do not accept production changes.", field: "project_id" } };
  if (!options.allow_active_job && getActiveWorkbenchDeliveryJob(db, projectId)) {
    return { ok: false, error: { code: "DELIVERY_JOB_ACTIVE", message: "A delivery Job is already active for this project.", field: "project_id" } };
  }

  const allowedStates = options.allowed_states ?? QUEUEABLE_STATES;
  const blockers: AssemblyBlocker[] = [];
  if (!allowedStates.has(delivery.workflow_state)) blockers.push({ code: "ASSEMBLY_WORKFLOW_STATE_INVALID" });

  const target = parseAssemblyResolution(project.video_spec.resolution, project.video_spec.aspect_ratio);
  if (!target) blockers.push({ code: "ASSEMBLY_TARGET_SPEC_INVALID" });
  if (!Number.isFinite(project.video_spec.duration_seconds) || project.video_spec.duration_seconds <= 0) {
    blockers.push({ code: "ASSEMBLY_PROJECT_DURATION_INVALID" });
  }

  const shots = listProjectShots(db, projectId);
  if (shots.length === 0) blockers.push({ code: "PROJECT_HAS_NO_SHOTS" });
  const projectShotIds = project.shot_ids;
  const orderedShotIds = shots.map((shot) => shot.shot_id);
  if (new Set(projectShotIds).size !== projectShotIds.length
    || projectShotIds.length !== orderedShotIds.length
    || projectShotIds.some((shotId, index) => shotId !== orderedShotIds[index])) {
    blockers.push({ code: "PROJECT_SHOT_ORDER_INVALID" });
  }
  const seenOrders = new Set<number>();
  const snapshotShots: AssemblyInputSnapshot["shots"] = [];
  for (const shot of shots) {
    if (!Number.isInteger(shot.order) || shot.order <= 0 || seenOrders.has(shot.order)) {
      blockers.push({ code: "SHOT_ORDER_INVALID", shot_id: shot.shot_id, order: shot.order });
    }
    seenOrders.add(shot.order);
    if (!Number.isFinite(shot.duration_seconds) || shot.duration_seconds <= 0) {
      blockers.push({ code: "SHOT_DURATION_INVALID", shot_id: shot.shot_id, order: shot.order });
      continue;
    }
    const validated = validateAcceptedClipReference(db, shot);
    if (!validated.ok) {
      blockers.push({ code: validated.error.code, shot_id: shot.shot_id, order: shot.order });
      continue;
    }
    if (validated.artifact.status !== "active"
      || validated.artifact.artifact_type !== "video"
      || validated.artifact.role !== "generated_clip"
      || validated.blob.integrity_state !== "verified"
      || validated.blob.detected_mime !== "video/mp4"
      || !/^[0-9a-f]{64}$/.test(validated.blob.sha256)) {
      blockers.push({ code: "ASSEMBLY_CLIP_INVALID", shot_id: shot.shot_id, order: shot.order });
      continue;
    }
    const sourceDuration = validated.artifact.metadata.duration_seconds;
    if (sourceDuration === null || !Number.isFinite(sourceDuration) || sourceDuration <= 0) {
      blockers.push({ code: "ASSEMBLY_CLIP_DURATION_INVALID", shot_id: shot.shot_id, order: shot.order });
      continue;
    }
    snapshotShots.push({
      shot_id: shot.shot_id,
      order: shot.order,
      artifact_id: validated.artifact.artifact_id,
      blob_sha256: validated.blob.sha256,
      duration_seconds: roundMediaNumber(shot.duration_seconds),
      source_duration_seconds: roundMediaNumber(sourceDuration)
    });
  }
  if (shots.length > 0 && [...seenOrders].some((order) => order > shots.length)
    || shots.some((shot, index) => shot.order !== index + 1)) {
    blockers.push({ code: "SHOT_ORDER_NOT_CONTIGUOUS" });
  }
  if (blockers.length > 0 || !target || snapshotShots.length !== shots.length) {
    return { ok: true, data: { blockers } };
  }
  const snapshot: AssemblyInputSnapshot = {
    contract_version: FINAL_ASSEMBLY_CONTRACT_VERSION,
    project: {
      project_id: project.project_id,
      declared_duration_seconds: roundMediaNumber(project.video_spec.duration_seconds),
      aspect_ratio: project.video_spec.aspect_ratio,
      resolution: project.video_spec.resolution,
      target_width: target.width,
      target_height: target.height
    },
    shots: snapshotShots,
    expected_duration_seconds: roundMediaNumber(snapshotShots.reduce((sum, shot) => sum + shot.duration_seconds, 0))
  };
  return {
    ok: true,
    data: {
      project,
      shots,
      snapshot,
      input_fingerprint: assemblyInputFingerprint(snapshot)
    }
  };
}

function isInternalAssemblyInput(value: InternalAssemblyInput | { blockers: AssemblyBlocker[] }): value is InternalAssemblyInput {
  return "snapshot" in value;
}

export function getAssemblyDatabasePreflight(projectId: string, db = openM0Database()): AssemblyResult<AssemblyPreflight> {
  const collected = databaseAssemblyInput(projectId, db);
  if (!collected.ok) return collected;
  if (!isInternalAssemblyInput(collected.data)) {
    return {
      ok: true,
      data: {
        ready: false,
        tooling_checked: false,
        contract_version: FINAL_ASSEMBLY_CONTRACT_VERSION,
        input_fingerprint: "",
        target: null,
        shots: [],
        expected_duration_seconds: 0,
        blockers: collected.data.blockers
      }
    };
  }
  return {
    ok: true,
    data: {
      ready: true,
      tooling_checked: false,
      contract_version: FINAL_ASSEMBLY_CONTRACT_VERSION,
      input_fingerprint: collected.data.input_fingerprint,
      target: {
        width: collected.data.snapshot.project.target_width,
        height: collected.data.snapshot.project.target_height,
        fps: 30,
        video_codec: "h264",
        audio_codec: "aac"
      },
      shots: collected.data.snapshot.shots,
      expected_duration_seconds: collected.data.snapshot.expected_duration_seconds,
      blockers: []
    }
  };
}

async function resolveAssemblyTools(dependencies: AssemblyDependencies): Promise<{ ffmpeg: string; ffprobe: string }> {
  try {
    const ffmpeg = await resolveFfmpegExecutable(dependencies.ffmpeg_path);
    let ffprobe: string;
    if (dependencies.ffprobe_path) {
      await execFileAsync(dependencies.ffprobe_path, ["-version"], { timeout: 5_000, windowsHide: true });
      ffprobe = dependencies.ffprobe_path;
    } else {
      ffprobe = await resolveFfprobeExecutable(ffmpeg);
    }
    return { ffmpeg, ffprobe };
  } catch {
    throw new AssemblyFailure("FFMPEG_UNAVAILABLE", "FFmpeg and FFprobe are required for final assembly.");
  }
}

export async function preflightWorkbenchAssembly(
  projectId: string,
  db = openM0Database(),
  dependencies: AssemblyDependencies = {}
): Promise<AssemblyResult<AssemblyPreflight>> {
  const databasePreflight = getAssemblyDatabasePreflight(projectId, db);
  if (!databasePreflight.ok || !databasePreflight.data.ready) return databasePreflight;
  try {
    await resolveAssemblyTools(dependencies);
    return { ok: true, data: { ...databasePreflight.data, tooling_checked: true } };
  } catch (error) {
    return assemblyErrorResult(error);
  }
}

async function defaultProbeMedia(ffprobePath: string, filePath: string): Promise<AssemblyProbeResult> {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,duration,sample_rate,channels",
      "-of", "json",
      filePath
    ], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000, windowsHide: true });
    const parsed = JSON.parse(stdout) as { streams?: AssemblyProbeStream[]; format?: { duration?: string } };
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const duration = Number(parsed.format?.duration ?? video?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0) throw new Error("invalid probe result");
    return { streams, duration_seconds: roundMediaNumber(duration) };
  } catch {
    throw new AssemblyFailure("ASSEMBLY_OUTPUT_INVALID", "Media probing failed.");
  }
}

async function resolveAssemblySources(
  input: InternalAssemblyInput,
  db: M0Database,
  ffprobePath: string,
  dependencies: AssemblyDependencies
): Promise<ResolvedAssemblySource[]> {
  const probe = dependencies.probe_media ?? defaultProbeMedia;
  const byShot = new Map(input.shots.map((shot) => [shot.shot_id, shot]));
  const sources: ResolvedAssemblySource[] = [];
  for (const snapshotShot of input.snapshot.shots) {
    const shot = byShot.get(snapshotShot.shot_id);
    if (!shot) throw new AssemblyFailure("ASSEMBLY_INPUT_CHANGED", "Assembly SHOT inputs changed.");
    const validated = validateAcceptedClipReference(db, shot);
    if (!validated.ok || validated.blob.sha256 !== snapshotShot.blob_sha256) {
      throw new AssemblyFailure("ASSEMBLY_INPUT_CHANGED", "Assembly clip inputs changed.");
    }
    const details = await probe(ffprobePath, validated.artifact.storage.uri);
    const video = details.streams.find((stream) => stream.codec_type === "video");
    if (!video || Math.abs(details.duration_seconds - snapshotShot.source_duration_seconds) > 0.25) {
      throw new AssemblyFailure("ASSEMBLY_INPUT_CHANGED", "Assembly clip media facts changed.");
    }
    sources.push({
      shot_id: shot.shot_id,
      order: shot.order,
      artifact_id: validated.artifact.artifact_id,
      path: validated.artifact.storage.uri,
      duration_seconds: shot.duration_seconds,
      has_audio: details.streams.some((stream) => stream.codec_type === "audio")
    });
  }
  return sources;
}

function fraction(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator = "1"] = value.split("/");
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) ? result : 0;
}

export function buildFinalAssemblyFfmpegArgs(
  sources: readonly ResolvedAssemblySource[],
  snapshot: AssemblyInputSnapshot,
  outputPath: string
): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-n"];
  for (const source of sources) args.push("-i", source.path);
  const filters: string[] = [];
  for (const [index, source] of sources.entries()) {
    const duration = roundMediaNumber(source.duration_seconds).toFixed(6);
    filters.push(
      `[${index}:v]scale=w=${snapshot.project.target_width}:h=${snapshot.project.target_height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${snapshot.project.target_width}:${snapshot.project.target_height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `fps=30,setsar=1,tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS[v${index}]`
    );
    filters.push(source.has_audio
      ? `[${index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`
      : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`);
  }
  filters.push(`${sources.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${sources.length}:v=1:a=1[vout][aout]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-r", "30", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    outputPath
  );
  return args;
}

async function defaultRunProcess(command: string, args: string[], timeoutMs: number): Promise<AssemblyProcessResult> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveRun) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ exit_code: exitCode, timed_out: timedOut });
    };
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}

function stagingJobDirectory(jobId: string): string {
  const safeId = createHash("sha256").update(jobId, "utf8").digest("hex");
  return resolve(paths.mediaRoot, DELIVERY_STAGING_DIRECTORY, ASSEMBLY_STAGING_DIRECTORY, safeId);
}

function assertSafeDirectory(directory: string, parent: string): void {
  const root = resolve(parent);
  const target = resolve(directory);
  if (!isPathInside(target, root) || hasExistingSymlinkAncestor(target, root)) {
    throw new AssemblyFailure("ASSEMBLY_OUTPUT_INVALID", "Assembly staging path is unsafe.");
  }
  if (existsSync(target)) {
    const entry = lstatSync(target);
    if (entry.isSymbolicLink() || !entry.isDirectory() || !isPathInside(realpathSync(target), realpathSync(root))) {
      throw new AssemblyFailure("ASSEMBLY_OUTPUT_INVALID", "Assembly staging path is unsafe.");
    }
  }
}

function prepareJobStaging(jobId: string, dependencies: AssemblyDependencies): { directory: string; output: string } {
  ensureM0Directories();
  const mediaRoot = resolve(paths.mediaRoot);
  if (lstatSync(mediaRoot).isSymbolicLink() || !statSync(mediaRoot).isDirectory()) {
    throw new AssemblyFailure("ASSEMBLY_OUTPUT_INVALID", "Media root is unsafe.");
  }
  const deliveryRoot = resolve(mediaRoot, DELIVERY_STAGING_DIRECTORY);
  const assemblyRoot = resolve(deliveryRoot, ASSEMBLY_STAGING_DIRECTORY);
  for (const directory of [deliveryRoot, assemblyRoot]) {
    assertSafeDirectory(directory, mediaRoot);
    if (!existsSync(directory)) mkdirSync(directory);
    assertSafeDirectory(directory, mediaRoot);
  }
  const directory = stagingJobDirectory(jobId);
  assertSafeDirectory(directory, assemblyRoot);
  if (!existsSync(directory)) mkdirSync(directory);
  assertSafeDirectory(directory, assemblyRoot);
  const output = resolve(directory, `final_${uuid(dependencies)}.mp4`);
  if (!isPathInside(output, directory) || existsSync(output) || hasExistingSymlinkAncestor(output, assemblyRoot)) {
    throw new AssemblyFailure("ASSEMBLY_OUTPUT_INVALID", "Assembly output path is unavailable.");
  }
  return { directory, output };
}

function cleanupJobStaging(jobId: string): boolean {
  const assemblyRoot = resolve(paths.mediaRoot, DELIVERY_STAGING_DIRECTORY, ASSEMBLY_STAGING_DIRECTORY);
  const directory = stagingJobDirectory(jobId);
  try {
    if (!existsSync(directory)) return true;
    if (!existsSync(assemblyRoot)
      || lstatSync(assemblyRoot).isSymbolicLink()
      || lstatSync(directory).isSymbolicLink()
      || !statSync(directory).isDirectory()
      || !isPathInside(directory, assemblyRoot)
      || !isPathInside(realpathSync(directory), realpathSync(assemblyRoot))) return false;
    rmSync(directory, { recursive: true, force: true });
    return !existsSync(directory);
  } catch {
    return false;
  }
}

function validateAssemblyOutput(probe: AssemblyProbeResult, snapshot: AssemblyInputSnapshot): void {
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const durationTolerance = Math.max(0.25, snapshot.shots.length * 2 / 30);
  const valid = video?.codec_name === "h264"
    && video.width === snapshot.project.target_width
    && video.height === snapshot.project.target_height
    && video.pix_fmt === "yuv420p"
    && Math.abs(fraction(video.r_frame_rate) - 30) < 0.01
    && audio?.codec_name === "aac"
    && Number(audio.sample_rate) === 48_000
    && audio.channels === 2
    && Math.abs(probe.duration_seconds - snapshot.expected_duration_seconds) <= durationTolerance;
  if (!valid) throw new AssemblyFailure("ASSEMBLY_OUTPUT_INVALID", "Final assembly output failed media validation.");
}

function getDeliveryJob(db: M0Database, jobId: string): DeliveryJobRow | null {
  const row = db.prepare(`
    SELECT job_id, project_id, job_type, state, input_fingerprint, input_json, retry_of_job_id,
      output_artifact_id, export_id, error_code, created_at, started_at, finished_at, updated_at
    FROM workbench_delivery_jobs WHERE job_id = ?
  `).get(jobId) as DeliveryJobRow | undefined;
  return row ?? null;
}

function publicDeliveryJob(row: DeliveryJobRow): WorkbenchDeliveryJobRecord {
  const { input_json: _inputJson, ...job } = row;
  return job;
}

function assemblyErrorResult(error: unknown): AssemblyResult<never> {
  if (error instanceof AssemblyFailure) return { ok: false, error: { code: error.code, message: error.message } };
  return { ok: false, error: { code: "ASSEMBLY_OUTPUT_INVALID", message: "Final assembly did not complete." } };
}

function sqliteFailure(error: unknown): AssemblyFailure {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("idx_workbench_delivery_jobs_single_active") || message.includes("UNIQUE constraint failed: index 'idx_workbench_delivery_jobs_single_active'")) {
    return new AssemblyFailure("DELIVERY_JOB_ACTIVE", "Another assembly or export Job is active.");
  }
  if (message.includes("PROJECT_CLOSED")) return new AssemblyFailure("PROJECT_CLOSED", "Closed projects do not accept production changes.");
  return new AssemblyFailure("ASSEMBLY_OUTPUT_INVALID", "Final assembly state could not be persisted.");
}

export async function queueWorkbenchAssembly(
  input: {
    project_id: string;
    input_fingerprint: string;
    human_confirmation: boolean;
    retry_of_job_id?: string;
  },
  db = openM0Database(),
  dependencies: AssemblyDependencies = {}
): Promise<AssemblyResult<{ job: WorkbenchDeliveryJobRecord; preflight: AssemblyPreflight }>> {
  if (input.human_confirmation !== true) {
    return { ok: false, error: { code: "USER_CONFIRMATION_REQUIRED", message: "Final assembly requires explicit confirmation." } };
  }
  const preflight = await preflightWorkbenchAssembly(input.project_id, db, dependencies);
  if (!preflight.ok) return preflight;
  if (!preflight.data.ready) {
    return { ok: false, error: { code: "ASSEMBLY_NOT_READY", message: "Final assembly inputs are not ready." } };
  }
  if (!/^[0-9a-f]{64}$/.test(input.input_fingerprint) || input.input_fingerprint !== preflight.data.input_fingerprint) {
    return { ok: false, error: { code: "ASSEMBLY_INPUT_CHANGED", message: "Assembly inputs changed after preflight." } };
  }
  if (input.retry_of_job_id) {
    const prior = getDeliveryJob(db, input.retry_of_job_id);
    if (!prior || prior.project_id !== input.project_id || prior.job_type !== "assembly" || !["failed", "interrupted"].includes(prior.state)) {
      return { ok: false, error: { code: "ASSEMBLY_RETRY_INVALID", message: "Assembly retry target is invalid." } };
    }
  }
  const jobId = `delivery_job_${uuid(dependencies)}`;
  const createdAt = now(dependencies);
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    if (getActiveWorkbenchDeliveryJob(db)) throw new AssemblyFailure("DELIVERY_JOB_ACTIVE", "Another assembly or export Job is active.");
    const fresh = databaseAssemblyInput(input.project_id, db);
    if (!fresh.ok) throw new AssemblyFailure(fresh.error.code, fresh.error.message);
    if (!isInternalAssemblyInput(fresh.data) || fresh.data.input_fingerprint !== input.input_fingerprint) {
      throw new AssemblyFailure("ASSEMBLY_INPUT_CHANGED", "Assembly inputs changed after preflight.");
    }
    const delivery = getWorkbenchDeliveryState(db, input.project_id);
    if (!delivery || !QUEUEABLE_STATES.has(delivery.workflow_state)) {
      throw new AssemblyFailure("ASSEMBLY_NOT_READY", "Project delivery state is not ready for assembly.");
    }
    const fromState = delivery.workflow_state;
    if (fromState !== "ready_to_assemble") {
      db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
        .run(createdAt, input.project_id);
    }
    db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'assembling', assembly_input_fingerprint = ?, updated_at = ? WHERE project_id = ?`)
      .run(input.input_fingerprint, createdAt, input.project_id);
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_fingerprint, input_json, retry_of_job_id, created_at, updated_at)
      VALUES (?, ?, 'assembly', 'queued', ?, ?, ?, ?, ?)`)
      .run(jobId, input.project_id, input.input_fingerprint, canonicalizeJcs(fresh.data.snapshot), input.retry_of_job_id ?? null, createdAt, createdAt);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, input_fingerprint, reason_code, data_json, created_at)
      VALUES (?, ?, ?, 'assembly_queued', ?, 'assembling', ?, 'ASSEMBLY_QUEUED', ?, ?)`)
      .run(`delivery_event_${uuid(dependencies)}`, input.project_id, jobId, fromState, input.input_fingerprint,
        canonicalizeJcs({ contract_version: FINAL_ASSEMBLY_CONTRACT_VERSION, shot_count: fresh.data.snapshot.shots.length }), createdAt);
    db.exec("COMMIT");
    transactionOpen = false;
    const job = getDeliveryJob(db, jobId);
    if (!job) throw new AssemblyFailure("ASSEMBLY_OUTPUT_INVALID", "Queued assembly Job could not be read.");
    return { ok: true, data: { job: publicDeliveryJob(job), preflight: preflight.data } };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
    }
    return assemblyErrorResult(error instanceof AssemblyFailure ? error : sqliteFailure(error));
  }
}

function snapshotFromJob(job: DeliveryJobRow): AssemblyInputSnapshot {
  try {
    const parsed = JSON.parse(job.input_json) as AssemblyInputSnapshot;
    if (parsed.contract_version !== FINAL_ASSEMBLY_CONTRACT_VERSION
      || assemblyInputFingerprint(parsed) !== job.input_fingerprint) throw new Error("drift");
    return parsed;
  } catch {
    throw new AssemblyFailure("ASSEMBLY_INPUT_CHANGED", "Stored assembly inputs failed integrity validation.");
  }
}

function markAssemblyJobFailed(db: M0Database, jobId: string, code: string, dependencies: AssemblyDependencies): void {
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const job = getDeliveryJob(db, jobId);
    if (!job || job.job_type !== "assembly" || !["queued", "running"].includes(job.state)) {
      db.exec("COMMIT");
      return;
    }
    const timestamp = now(dependencies);
    const delivery = getWorkbenchDeliveryState(db, job.project_id);
    const fromState = delivery?.workflow_state ?? "";
    if (delivery?.workflow_state === "assembling") {
      db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
        .run(timestamp, job.project_id);
    }
    db.prepare(`UPDATE workbench_delivery_jobs
      SET state = 'failed', error_code = ?, finished_at = ?, updated_at = ? WHERE job_id = ?`)
      .run(code, timestamp, timestamp, jobId);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, input_fingerprint, reason_code, data_json, created_at)
      VALUES (?, ?, ?, 'assembly_failed', ?, ?, ?, ?, '{}', ?)`)
      .run(`delivery_event_${uuid(dependencies)}`, job.project_id, jobId, fromState,
        fromState === "assembling" ? "ready_to_assemble" : fromState, job.input_fingerprint, code, timestamp);
    db.exec("COMMIT");
    transactionOpen = false;
  } catch {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* failure remains visible as an active Job for startup recovery */ }
    }
  }
}

function assertCurrentSnapshot(db: M0Database, projectId: string, expectedFingerprint: string): InternalAssemblyInput {
  const current = databaseAssemblyInput(projectId, db, {
    allow_active_job: true,
    allowed_states: new Set<WorkbenchDeliveryWorkflowState>(["assembling"])
  });
  if (!current.ok) throw new AssemblyFailure(current.error.code, current.error.message);
  if (!isInternalAssemblyInput(current.data) || current.data.input_fingerprint !== expectedFingerprint) {
    throw new AssemblyFailure("ASSEMBLY_INPUT_CHANGED", "Assembly inputs changed while the Job was running.");
  }
  return current.data;
}

export async function runWorkbenchAssemblyJob(
  jobId: string,
  db?: M0Database,
  dependencies: AssemblyDependencies = {}
): Promise<AssemblyResult<{ job: WorkbenchDeliveryJobRecord; run: GenerationRun; final_video_artifact_id: string }>> {
  const connection = db ?? openM0Database();
  const ownsConnection = db === undefined;
  let claimed = false;
  let outputArtifactId = "";
  try {
    let transactionOpen = false;
    try {
      connection.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const queued = getDeliveryJob(connection, jobId);
      if (!queued || queued.job_type !== "assembly") throw new AssemblyFailure("ASSEMBLY_JOB_NOT_FOUND", "Assembly Job was not found.");
      if (queued.state !== "queued") throw new AssemblyFailure("ASSEMBLY_JOB_NOT_QUEUED", "Assembly Job is not queued.");
      const timestamp = now(dependencies);
      connection.prepare("UPDATE workbench_delivery_jobs SET state = 'running', started_at = ?, updated_at = ? WHERE job_id = ?")
        .run(timestamp, timestamp, jobId);
      connection.prepare(`INSERT INTO workbench_delivery_events
        (event_id, project_id, job_id, event_type, from_state, to_state, input_fingerprint, reason_code, data_json, created_at)
        VALUES (?, ?, ?, 'assembly_started', 'assembling', 'assembling', ?, 'ASSEMBLY_STARTED', '{}', ?)`)
        .run(`delivery_event_${uuid(dependencies)}`, queued.project_id, jobId, queued.input_fingerprint, timestamp);
      connection.exec("COMMIT");
      transactionOpen = false;
      claimed = true;
    } catch (error) {
      if (transactionOpen) {
        try { connection.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      }
      throw error;
    }

    const job = getDeliveryJob(connection, jobId);
    if (!job) throw new AssemblyFailure("ASSEMBLY_JOB_NOT_FOUND", "Assembly Job was not found.");
    const snapshot = snapshotFromJob(job);
    const current = assertCurrentSnapshot(connection, job.project_id, job.input_fingerprint ?? "");
    const tools = await resolveAssemblyTools(dependencies);
    const sources = await resolveAssemblySources(current, connection, tools.ffprobe, dependencies);
    const staging = prepareJobStaging(jobId, dependencies);
    await dependencies.before_render?.(staging.output);
    const runProcess = dependencies.run_process ?? defaultRunProcess;
    const processResult = await runProcess(
      tools.ffmpeg,
      buildFinalAssemblyFfmpegArgs(sources, snapshot, staging.output),
      dependencies.timeout_ms ?? FINAL_ASSEMBLY_TIMEOUT_MS
    );
    if (processResult.timed_out) throw new AssemblyFailure("ASSEMBLY_TIMEOUT", "Final assembly exceeded the 30 minute limit.");
    if (processResult.exit_code !== 0) throw new AssemblyFailure("ASSEMBLY_FFMPEG_FAILED", "FFmpeg did not complete final assembly.");
    if (!existsSync(staging.output)
      || lstatSync(staging.output).isSymbolicLink()
      || !statSync(staging.output).isFile()
      || statSync(staging.output).size <= 0) {
      throw new AssemblyFailure("ASSEMBLY_OUTPUT_INVALID", "Final assembly output is missing or invalid.");
    }
    const outputProbe = await (dependencies.probe_media ?? defaultProbeMedia)(tools.ffprobe, staging.output);
    validateAssemblyOutput(outputProbe, snapshot);
    await dependencies.after_render?.(staging.output);
    assertCurrentSnapshot(connection, job.project_id, job.input_fingerprint ?? "");

    const run: GenerationRun = {
      run_id: `run_${uuid(dependencies)}`,
      batch_id: "",
      project_id: job.project_id,
      shot_id: "",
      run_type: "assemble_video",
      status: "succeeded",
      input: {
        storyboard_image_artifact_id: "",
        video_prompt: FINAL_ASSEMBLY_CONTRACT_VERSION,
        negative_prompt: "",
        duration_seconds: snapshot.expected_duration_seconds,
        aspect_ratio: snapshot.project.aspect_ratio,
        resolution: snapshot.project.resolution
      },
      output: { artifact_ids: [] },
      provider: {
        provider: "local",
        provider_name: "local_assembly",
        model_name: FINAL_ASSEMBLY_CONTRACT_VERSION,
        provider_job_id: jobId,
        provider_status: "succeeded"
      },
      versioning: {
        attempt_number: Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM generation_runs WHERE project_id = ? AND run_type = 'assemble_video'"
        ).get(job.project_id) as { count: number }).count) + 1,
        parent_run_id: ""
      },
      error: { code: "", message: "", retryable: false }
    };

    let finalizationOpen = false;
    try {
      connection.exec("BEGIN IMMEDIATE");
      finalizationOpen = true;
      const lockedJob = getDeliveryJob(connection, jobId);
      if (!lockedJob || lockedJob.state !== "running" || lockedJob.input_fingerprint !== job.input_fingerprint) {
        throw new AssemblyFailure("ASSEMBLY_INPUT_CHANGED", "Assembly Job state changed before finalization.");
      }
      assertCurrentSnapshot(connection, job.project_id, job.input_fingerprint ?? "");
      const artifact = registerMediaArtifact({
        artifact_type: "video",
        role: "final_video",
        source: { kind: "provider_output_file", path: staging.output, mime_type: "video/mp4" },
        linked_objects: { project_id: job.project_id },
        metadata: {
          width: snapshot.project.target_width,
          height: snapshot.project.target_height,
          duration_seconds: outputProbe.duration_seconds,
          aspect_ratio: snapshot.project.aspect_ratio
        },
        provenance: {
          kind: "local_assembly",
          provider: "local_assembly",
          provider_job_id: jobId,
          external_url_host: ""
        }
      }, connection);
      if (!artifact.ok) throw new AssemblyFailure("ASSEMBLY_OUTPUT_INVALID", "Final assembly Artifact registration failed.");
      outputArtifactId = artifact.artifact.artifact_id;
      run.output.artifact_ids = [outputArtifactId];
      const project = getProject(connection, job.project_id);
      if (!project) throw new AssemblyFailure("PROJECT_NOT_FOUND", "Project was not found during assembly finalization.");
      project.exports.final_video_artifact_id = outputArtifactId;
      project.status = "video_review";
      saveProject(connection, project);
      saveGenerationRun(connection, run);
      const timestamp = now(dependencies);
      connection.prepare(`UPDATE workbench_delivery_state SET
        workflow_state = 'final_review', current_final_artifact_id = ?, assembly_input_fingerprint = ?,
        approved_artifact_id = NULL, latest_export_id = NULL, latest_exported_at = NULL, updated_at = ?
        WHERE project_id = ?`)
        .run(outputArtifactId, job.input_fingerprint, timestamp, job.project_id);
      connection.prepare(`UPDATE workbench_delivery_jobs SET
        state = 'succeeded', output_artifact_id = ?, finished_at = ?, updated_at = ? WHERE job_id = ?`)
        .run(outputArtifactId, timestamp, timestamp, jobId);
      connection.prepare(`INSERT INTO workbench_delivery_events
        (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id, input_fingerprint, reason_code, data_json, created_at)
        VALUES (?, ?, ?, 'assembly_succeeded', 'assembling', 'final_review', ?, ?, 'ASSEMBLY_SUCCEEDED', ?, ?)`)
        .run(`delivery_event_${uuid(dependencies)}`, job.project_id, jobId, outputArtifactId, job.input_fingerprint,
          canonicalizeJcs({ contract_version: FINAL_ASSEMBLY_CONTRACT_VERSION, run_id: run.run_id }), timestamp);
      connection.exec("COMMIT");
      finalizationOpen = false;
    } catch (error) {
      if (finalizationOpen) {
        try { connection.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      }
      if (outputArtifactId) cleanupRolledBackMediaActivationFiles([outputArtifactId]);
      throw error;
    }
    cleanupCommittedMediaActivationMarkers(connection, [outputArtifactId]);
    cleanupJobStaging(jobId);
    const succeeded = getDeliveryJob(connection, jobId);
    if (!succeeded) throw new AssemblyFailure("ASSEMBLY_OUTPUT_INVALID", "Completed assembly Job could not be read.");
    return { ok: true, data: { job: publicDeliveryJob(succeeded), run, final_video_artifact_id: outputArtifactId } };
  } catch (error) {
    const failure = error instanceof AssemblyFailure ? error : new AssemblyFailure("ASSEMBLY_OUTPUT_INVALID", "Final assembly did not complete.");
    if (claimed) markAssemblyJobFailed(connection, jobId, failure.code, dependencies);
    cleanupJobStaging(jobId);
    return assemblyErrorResult(failure);
  } finally {
    if (ownsConnection) connection.close();
  }
}

const startedAssemblyJobs = new Set<string>();

export function startWorkbenchAssemblyJob(jobId: string, dependencies: AssemblyDependencies = {}): void {
  if (startedAssemblyJobs.has(jobId)) return;
  startedAssemblyJobs.add(jobId);
  setImmediate(() => {
    void runWorkbenchAssemblyJob(jobId, undefined, dependencies)
      .finally(() => startedAssemblyJobs.delete(jobId));
  });
}

export function interruptUnfinishedWorkbenchDeliveryJobs(
  db = openM0Database(),
  dependencies: AssemblyDependencies = {}
): { interrupted: number; staging_cleanup_failed: number } {
  const jobs = db.prepare(`SELECT job_id, project_id, job_type, state, input_fingerprint, input_json,
    retry_of_job_id, output_artifact_id, export_id, error_code, created_at, started_at, finished_at, updated_at
    FROM workbench_delivery_jobs WHERE state IN ('queued','running') ORDER BY created_at, job_id`)
    .all() as DeliveryJobRow[];
  if (jobs.length === 0) return { interrupted: 0, staging_cleanup_failed: 0 };
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const timestamp = now(dependencies);
    for (const job of jobs) {
      const delivery = getWorkbenchDeliveryState(db, job.project_id);
      const fromState = delivery?.workflow_state ?? "";
      if (job.job_type === "assembly" && delivery?.workflow_state === "assembling") {
        db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
          .run(timestamp, job.project_id);
      }
      db.prepare(`UPDATE workbench_delivery_jobs
        SET state = 'interrupted', error_code = 'PROCESS_RESTART', finished_at = ?, updated_at = ? WHERE job_id = ?`)
        .run(timestamp, timestamp, job.job_id);
      db.prepare(`INSERT INTO workbench_delivery_events
        (event_id, project_id, job_id, event_type, from_state, to_state, input_fingerprint, reason_code, data_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PROCESS_RESTART', '{}', ?)`)
        .run(`delivery_event_${uuid(dependencies)}`, job.project_id, job.job_id,
          job.job_type === "assembly" ? "assembly_interrupted" : "export_interrupted",
          fromState,
          job.job_type === "assembly" && fromState === "assembling" ? "ready_to_assemble" : fromState,
          job.input_fingerprint, timestamp);
    }
    db.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* preserve startup recovery failure */ }
    }
    throw error;
  }
  let cleanupFailures = 0;
  for (const job of jobs) {
    if (job.job_type === "assembly" && !cleanupJobStaging(job.job_id)) cleanupFailures += 1;
    if (job.job_type === "export" && !cleanupInterruptedWorkbenchExportJob(job, db)) cleanupFailures += 1;
  }
  return { interrupted: jobs.length, staging_cleanup_failed: cleanupFailures };
}

export function deliveryWorkerStatus(db = openM0Database()): { ready: true; active_job: WorkbenchDeliveryJobRecord | null } {
  return { ready: true, active_job: getActiveWorkbenchDeliveryJob(db) };
}

function blockerReason(blocker: AssemblyBlocker): string {
  const shot = blocker.order === undefined ? "" : `Shot ${String(blocker.order).padStart(3, "0")} `;
  return `${shot}[${blocker.code}]`.trim();
}

export async function assembleFinalVideo(
  input: { project_id: string; confirmation?: Confirmation },
  db = openM0Database(),
  dependencies: AssemblyDependencies = {}
): Promise<LegacyAssemblyResult<{ run: GenerationRun; final_video_artifact_id: string }>> {
  if (!explicitConfirmed(input.confirmation)) {
    return { ok: false, error: { code: "USER_CONFIRMATION_REQUIRED", message: "Final assembly requires explicit confirmation." } };
  }
  const preflight = await preflightWorkbenchAssembly(input.project_id, db, dependencies);
  if (!preflight.ok) return { ok: false, error: preflight.error };
  if (!preflight.data.ready) {
    return {
      ok: false,
      error: { code: "FINAL_ASSEMBLY_NOT_READY", message: "Final assembly is not ready." },
      blocking_reasons: preflight.data.blockers.map(blockerReason)
    };
  }
  const queued = await queueWorkbenchAssembly({
    project_id: input.project_id,
    input_fingerprint: preflight.data.input_fingerprint,
    human_confirmation: true
  }, db, dependencies);
  if (!queued.ok) {
    return {
      ok: false,
      error: {
        code: queued.error.code === "ASSEMBLY_NOT_READY" ? "FINAL_ASSEMBLY_NOT_READY" : queued.error.code,
        message: queued.error.message
      }
    };
  }
  const completed = await runWorkbenchAssemblyJob(queued.data.job.job_id, db, dependencies);
  if (!completed.ok) return { ok: false, error: completed.error };
  return {
    ok: true,
    run: completed.data.run,
    final_video_artifact_id: completed.data.final_video_artifact_id
  };
}
