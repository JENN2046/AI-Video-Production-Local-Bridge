import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import {
  DIRECTOR_FOCUS_SCHEMA,
  DIRECTOR_PROPOSAL_SCHEMA,
  DIRECTOR_TARGET_STATE_V1_SCHEMA,
  directorBaseStateHash,
  directorContentHash,
  validateDirectorProposalAgainstTargetState,
  type DirectorFocus,
  type DirectorProposal,
  type DirectorProposalDraft,
  type DirectorTargetStateV1
} from "./domain.js";
import {
  DISABLED_DIRECTOR_MEMORY_PORT,
  disabledDirectorMemoryRecall,
  recallDirectorMemory,
  type DirectorMemoryPort
} from "./memoryPort.js";
import { publicDirectorQuote, readDirectorQuote, selectVerifiedDirectorCapability } from "./providerCapability.js";
import {
  DIRECTOR_DISCUSSION_CONTEXT_SCHEMA,
  DIRECTOR_GET_CONTEXT_INPUT_SCHEMA,
  DIRECTOR_GET_CONTEXT_OUTPUT_SCHEMA,
  DIRECTOR_GET_FOCUS_OUTPUT_SCHEMA,
  DIRECTOR_GET_PROPOSAL_STATUS_OUTPUT_SCHEMA,
  DIRECTOR_INSPECT_VIDEO_FRAMES_OUTPUT_SCHEMA,
  DIRECTOR_MODEL_IMAGE_MAX_BYTES,
  DIRECTOR_SUBMIT_PROPOSAL_OUTPUT_SCHEMA,
  type DirectorNativeToolHandlers,
  type DirectorVideoFrameToolOutput
} from "./mcpContract.js";
import { assertSchemaCurrent } from "../storage/migrations.js";
import { openM0DatabaseConnection, type M0Database } from "../storage/sqlite.js";
import { getMediaArtifact, validateActiveArtifactReference, type MediaArtifact } from "../tools/mediaArtifacts.js";
import { type Project, type Shot } from "../tools/projects.js";
import { getGenerationRun, type GenerationRun } from "../tools/generation.js";
import { assertWebGptPrincipalActive, requireWebGptProjectReadAccess } from "../webgpt-v4/projectAuthorization.js";
import { coverageFramePlan, resolveFfmpegExecutable, resolveFfprobeExecutable } from "../webgpt-v4/media.js";
import { WebGptV4Error, type WebGptV4Actor } from "../webgpt-v4/types.js";

const execFileAsync = promisify(execFile);
const WORKSPACE_ID = "jenn-ai-video-workspace";
const FRAME_TIMEOUT_MS = 120_000;
const MAX_SOURCE_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

export type DirectorProposalKind = DirectorProposalDraft["kind"];

export interface DirectorLocalServiceOptions {
  database_path: string;
  ffmpeg_path?: string;
  now?: () => Date;
  /** Injected only by a future, separately accepted memory integration. */
  memory_port?: DirectorMemoryPort;
}

interface ProjectRow {
  project_id: string;
  data_json: string;
  lifecycle: "active" | "archived";
}

interface StoredProposalRow {
  proposal_id: string;
  workspace_id: string;
  principal_id: string;
  project_id: string;
  target_type: DirectorProposal["target_type"];
  target_id: string;
  focus_id: string;
  focus_generation: number;
  schema_version: "director-domain-v1";
  kind: DirectorProposalKind;
  base_state_hash: string;
  payload_json: string;
  payload_hash: string;
  parent_proposal_id: string | null;
  idempotency_key: string;
  source: "native" | "untrusted_manual_import";
  created_at: string;
}

function parseRecord(value: string, code: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(code);
    return parsed as Record<string, unknown>;
  } catch {
    throw new WebGptV4Error(code, "Stored Director source data is malformed.");
  }
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 16_384) : "";
}

function continuity(shot: Shot): string[] {
  const raw = (shot as unknown as Record<string, unknown>).continuity_constraints;
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 30)
    : [];
}

function requireIssuer(actor: WebGptV4Actor): string {
  if (!actor.issuer_hash || !/^[0-9a-f]{64}$/.test(actor.issuer_hash)) {
    throw new WebGptV4Error("WEBGPT_PRINCIPAL_NOT_REGISTERED", "This identity is not registered for the Director workspace.");
  }
  return actor.issuer_hash;
}

function projectRow(db: M0Database, projectId: string): { project: Project; lifecycle: "active" | "archived" } {
  const row = db.prepare(`SELECT p.project_id, p.data_json, m.lifecycle FROM projects p
    JOIN workbench_project_meta m ON m.project_id = p.project_id
    WHERE p.project_id = ? AND m.classification = 'production'`).get(projectId) as ProjectRow | undefined;
  if (!row) throw new WebGptV4Error("PROJECT_NOT_FOUND", "Production project was not found.", "project_id");
  const project = parseRecord(row.data_json, "DIRECTOR_PROJECT_INVALID") as unknown as Project;
  if (project.project_id !== row.project_id || row.project_id !== projectId) {
    throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Project binding is inconsistent.");
  }
  return { project, lifecycle: row.lifecycle };
}

function requireBoundShot(db: M0Database, projectId: string, shotId: string): Shot {
  const row = db.prepare("SELECT shot_id, project_id, data_json FROM shots WHERE shot_id = ? AND project_id = ?")
    .get(shotId, projectId) as { shot_id: string; project_id: string; data_json: string } | undefined;
  if (!row) throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Focused SHOT binding is inconsistent.", "shot_id");
  const shot = parseRecord(row.data_json, "DIRECTOR_SHOT_INVALID") as unknown as Shot;
  if (shot.shot_id !== row.shot_id || shot.project_id !== row.project_id) {
    throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Focused SHOT binding is inconsistent.", "shot_id");
  }
  return shot;
}

function boundProjectShots(db: M0Database, projectId: string): Shot[] {
  const rows = db.prepare(`SELECT shot_id, project_id, data_json FROM shots
    WHERE project_id = ? ORDER BY json_extract(data_json, '$.order'), shot_id`)
    .all(projectId) as Array<{ shot_id: string; project_id: string; data_json: string }>;
  return rows.map((row) => {
    const shot = parseRecord(row.data_json, "DIRECTOR_SHOT_INVALID") as unknown as Shot;
    if (shot.shot_id !== row.shot_id || shot.project_id !== row.project_id || row.project_id !== projectId) {
      throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Project SHOT binding is inconsistent.", "shot_id");
    }
    return shot;
  });
}

function currentFocus(db: M0Database, actor: WebGptV4Actor): DirectorFocus | null {
  const row = db.prepare(`SELECT f.* FROM director_focuses f
    WHERE f.workspace_id = ? AND f.principal_id = ?
    ORDER BY f.generation DESC LIMIT 1`).get(WORKSPACE_ID, actor.principal_id) as Record<string, unknown> | undefined;
  return row ? DIRECTOR_FOCUS_SCHEMA.parse({ ...row, generation: Number(row.generation) }) : null;
}

function focusIsTerminal(db: M0Database, focusId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM director_focus_events
    WHERE focus_id = ? AND event_type IN ('revoked','superseded') LIMIT 1`).get(focusId));
}

function publicFocus(focus: DirectorFocus): Record<string, unknown> {
  return {
    focus_id: focus.focus_id,
    project_id: focus.project_id,
    target_type: focus.target_type,
    target_id: focus.target_id,
    generation: focus.generation,
    created_at: focus.created_at,
    expires_at: focus.expires_at
  };
}

function requireFocus(
  db: M0Database,
  actor: WebGptV4Actor,
  focusId: string,
  generation: number,
  now: Date
): DirectorFocus {
  const focus = currentFocus(db, actor);
  if (!focus || focus.focus_id !== focusId || focus.generation !== generation) {
    throw new WebGptV4Error("DIRECTOR_FOCUS_STALE", "Director Focus no longer matches the current Workbench selection.", "focus_id");
  }
  if (focusIsTerminal(db, focus.focus_id) || Date.parse(focus.expires_at) <= now.getTime()) {
    throw new WebGptV4Error("DIRECTOR_FOCUS_EXPIRED", "Director Focus is expired or no longer active.", "focus_id");
  }
  requireWebGptProjectReadAccess(db, actor.principal_id, requireIssuer(actor), focus.project_id);
  return focus;
}

function proposalKindMatchesFocus(kind: DirectorProposalKind, focus: DirectorFocus): void {
  const allowed: Record<DirectorProposalKind, readonly DirectorFocus["target_type"][]> = {
    creative_brief: ["project"], script: ["project"], shot_plan: ["project"],
    storyboard_revision: ["shot"], artifact_import: ["shot"], generation_plan: ["shot"],
    clip_regeneration: ["shot", "artifact"], review_assessment: ["shot", "artifact"],
    assembly_plan: ["project"], delivery_plan: ["delivery"], memory_saveback: ["memory"]
  };
  if (!allowed[kind].includes(focus.target_type)) {
    throw new WebGptV4Error("DIRECTOR_PROPOSAL_TARGET_MISMATCH", "Proposal kind does not match the active Focus target.", "proposal_kind");
  }
}

function artifactForFocus(db: M0Database, focus: DirectorFocus, project: Project, targetShot: Shot | null, kind: DirectorProposalKind): MediaArtifact | null {
  let artifactId = "";
  if (focus.target_type === "artifact") artifactId = focus.target_id;
  else if (kind === "storyboard_revision" || kind === "generation_plan") artifactId = targetShot?.storyboard_image_artifact_id ?? "";
  else if (kind === "clip_regeneration" || kind === "review_assessment") {
    artifactId = targetShot
      ? [...targetShot.clip_versions].sort((left, right) => right.attempt_number - left.attempt_number)[0]?.artifact_id
        ?? targetShot.accepted_clip_artifact_id
      : "";
  }
  else if (kind === "delivery_plan") artifactId = project.exports.final_video_artifact_id;
  if (!artifactId) return null;
  const artifact = getMediaArtifact(db, artifactId);
  if (!artifact || artifact.artifact_id !== artifactId || artifact.linked_objects.project_id !== project.project_id) {
    throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Focused Artifact binding is inconsistent.", "artifact_id");
  }
  if (targetShot && artifact.linked_objects.shot_id !== targetShot.shot_id) {
    throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Focused Artifact is bound to another SHOT.", "artifact_id");
  }
  const expectedRole = kind === "storyboard_revision" || kind === "generation_plan"
    ? "storyboard_image"
    : kind === "delivery_plan" ? "final_video" : "generated_clip";
  const expectedType = expectedRole === "storyboard_image" ? "image" : "video";
  if (artifact.role !== expectedRole || artifact.artifact_type !== expectedType || artifact.status !== "active") {
    throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Focused Artifact role or status is inconsistent.", "artifact_id");
  }
  return artifact;
}

function targetShotForFocus(db: M0Database, focus: DirectorFocus): Shot | null {
  if (focus.target_type === "shot") {
    return requireBoundShot(db, focus.project_id, focus.target_id);
  }
  if (focus.target_type === "artifact") {
    const artifact = getMediaArtifact(db, focus.target_id);
    if (!artifact || artifact.linked_objects.project_id !== focus.project_id || !artifact.linked_objects.shot_id) {
      throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Focused Artifact has no valid SHOT binding.", "artifact_id");
    }
    return requireBoundShot(db, focus.project_id, artifact.linked_objects.shot_id);
  }
  if (focus.target_type === "generation_run") {
    const run = getGenerationRun(db, focus.target_id);
    if (!run || run.run_id !== focus.target_id || run.project_id !== focus.project_id) {
      throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Focused Generation Run binding is inconsistent.", "target_id");
    }
    return requireBoundShot(db, focus.project_id, run.shot_id);
  }
  return null;
}

function latestReviewEventId(db: M0Database, projectId: string, shotId: string): string | null {
  const row = db.prepare(`SELECT note_id FROM workbench_review_notes
    WHERE project_id = ? AND shot_id = ? ORDER BY created_at DESC, note_id DESC LIMIT 1`)
    .get(projectId, shotId) as { note_id: string } | undefined;
  return row?.note_id ?? null;
}

function shotState(db: M0Database, shot: Shot): DirectorTargetStateV1["target_shot"] {
  const storyboard = shot.storyboard_image_artifact_id ? getMediaArtifact(db, shot.storyboard_image_artifact_id) : null;
  const accepted = shot.accepted_clip_artifact_id ? getMediaArtifact(db, shot.accepted_clip_artifact_id) : null;
  const latestRunId = shot.generation_run_ids.at(-1) ?? null;
  const latestRun = latestRunId ? getGenerationRun(db, latestRunId) : null;
  if (shot.storyboard_image_artifact_id && !storyboard) {
    throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Storyboard Artifact is missing.", "artifact_id");
  }
  if (shot.accepted_clip_artifact_id && !accepted) {
    throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Accepted clip Artifact is missing.", "artifact_id");
  }
  if (latestRunId && !latestRun) {
    throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Generation Run is missing.", "target_id");
  }
  if (storyboard && (storyboard.linked_objects.project_id !== shot.project_id || storyboard.linked_objects.shot_id !== shot.shot_id
    || storyboard.role !== "storyboard_image" || storyboard.artifact_type !== "image" || storyboard.status !== "active")) {
    throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Storyboard Artifact binding is inconsistent.", "artifact_id");
  }
  if (accepted && (accepted.linked_objects.project_id !== shot.project_id || accepted.linked_objects.shot_id !== shot.shot_id
    || accepted.role !== "generated_clip" || accepted.artifact_type !== "video" || accepted.status !== "active")) {
    throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Accepted clip Artifact binding is inconsistent.", "artifact_id");
  }
  if (latestRun && (latestRun.run_id !== latestRunId
    || latestRun.project_id !== shot.project_id || latestRun.shot_id !== shot.shot_id)) {
    throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Generation Run binding is inconsistent.", "target_id");
  }
  return {
    shot_id: shot.shot_id,
    project_id: shot.project_id,
    order: shot.order,
    status: shot.status,
    duration_seconds: shot.duration_seconds,
    storyboard_artifact_id: storyboard?.artifact_id ?? null,
    storyboard_artifact_sha256: storyboard?.metadata.sha256 || null,
    accepted_clip_artifact_id: accepted?.artifact_id ?? null,
    accepted_clip_artifact_sha256: accepted?.metadata.sha256 || null,
    prompt_hash: directorContentHash(shot.video_prompt),
    negative_prompt_hash: directorContentHash(shot.negative_prompt),
    continuity_hash: directorContentHash(continuity(shot)),
    current_generation_input_hash: latestRun ? directorContentHash(latestRun.input) : null,
    current_review_decision_event_id: latestReviewEventId(db, shot.project_id, shot.shot_id)
  };
}

function artifactState(artifact: MediaArtifact | null): DirectorTargetStateV1["target_artifact"] {
  return artifact ? {
    artifact_id: artifact.artifact_id,
    project_id: artifact.linked_objects.project_id,
    shot_id: artifact.linked_objects.shot_id || null,
    artifact_type: artifact.artifact_type,
    role: artifact.role,
    status: artifact.status,
    sha256: artifact.metadata.sha256
  } : null;
}

function packageBinding(db: M0Database, project: Project): { id: string | null; hash: string | null } {
  const id = project.active_storyboard_package_id || null;
  if (!id) return { id: null, hash: null };
  const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ? AND project_id = ?")
    .get(id, project.project_id) as { data_json: string } | undefined;
  if (!row) throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Current Storyboard Package is missing.");
  return { id, hash: directorContentHash(parseRecord(row.data_json, "DIRECTOR_STORYBOARD_PACKAGE_INVALID")) };
}

function generationState(db: M0Database, shot: Shot | null): DirectorTargetStateV1["generation"] {
  if (!shot) return null;
  const intent = db.prepare(`SELECT intent_id, run_id, data_json FROM generation_intents
    WHERE project_id = ? AND shot_id = ? AND status IN ('prepared','queued','running')
    ORDER BY created_at DESC, intent_id DESC LIMIT 1`)
    .get(shot.project_id, shot.shot_id) as { intent_id: string; run_id: string | null; data_json: string } | undefined;
  const latestRunId = shot.generation_run_ids.at(-1) ?? intent?.run_id ?? null;
  const run = latestRunId ? getGenerationRun(db, latestRunId) : null;
  if (latestRunId && (!run || run.run_id !== latestRunId || run.project_id !== shot.project_id || run.shot_id !== shot.shot_id)) {
    throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Generation Run binding is inconsistent.", "target_id");
  }
  const job = intent ? db.prepare("SELECT state FROM generation_jobs WHERE intent_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(intent.intent_id) as { state: DirectorTargetStateV1["generation"] extends infer _ ? string : never } | undefined : undefined;
  const allowed = new Set(["queued", "submitting", "polling", "downloading", "finalizing", "manual_reconciliation", "succeeded", "failed", "cancelled"]);
  const jobState = job && allowed.has(job.state) ? job.state as NonNullable<DirectorTargetStateV1["generation"]>["latest_job_state"] : null;
  return {
    prepared_intent_id: intent?.intent_id ?? null,
    frozen_input_hash: intent ? directorContentHash(parseRecord(intent.data_json, "DIRECTOR_GENERATION_INTENT_INVALID")) : null,
    latest_run_id: run?.run_id ?? null,
    latest_job_state: run ? jobState : null
  };
}

function discussionShot(shot: Shot): Record<string, unknown> {
  return {
    shot_id: shot.shot_id, order: shot.order, status: shot.status, duration_seconds: shot.duration_seconds,
    description: shot.description, storyboard_prompt: optionalText((shot as unknown as Record<string, unknown>).storyboard_prompt),
    video_prompt: shot.video_prompt, negative_prompt: shot.negative_prompt, continuity_constraints: continuity(shot)
  };
}

/**
 * Rebuild the authoritative context used to bind a Director Proposal.  This is
 * deliberately shared with the Human Workbench approval boundary: accepting a
 * proposal must use the exact same target-state construction as native
 * proposal ingestion, rather than trusting the hash supplied by ChatGPT.
 */
export function buildDirectorContext(
  db: M0Database,
  focus: DirectorFocus,
  kind: DirectorProposalKind,
  detail: "compact" | "full",
  now = new Date()
) {
  proposalKindMatchesFocus(kind, focus);
  const { project, lifecycle } = projectRow(db, focus.project_id);
  const shots = boundProjectShots(db, project.project_id);
  const targetShot = targetShotForFocus(db, focus);
  const targetArtifact = artifactForFocus(db, focus, project, targetShot, kind);
  const packageInfo = packageBinding(db, project);
  const targetIndex = targetShot ? shots.findIndex((shot) => shot.shot_id === targetShot.shot_id) : -1;
  const adjacent = targetIndex < 0 ? [] : [shots[targetIndex - 1], shots[targetIndex + 1]].filter((shot): shot is Shot => Boolean(shot));
  const brief = project.brief ?? {};
  const creative = (brief as Record<string, unknown>).creative_direction;
  const targetState = DIRECTOR_TARGET_STATE_V1_SCHEMA.parse({
    schema_version: "director-domain-v1",
    proposal_kind: kind,
    project: {
      project_id: project.project_id, status: project.status, lifecycle_state: lifecycle,
      video_spec: project.video_spec,
      creative_direction_hash: creative === undefined || creative === null || creative === "" ? null : directorContentHash(creative),
      current_storyboard_package_id: packageInfo.id,
      current_storyboard_package_hash: packageInfo.hash
    },
    target_shot: targetShot ? shotState(db, targetShot) : null,
    adjacent_shots: adjacent.map((shot) => shotState(db, shot)),
    target_artifact: artifactState(targetArtifact),
    generation: generationState(db, targetShot)
  });
  const notes = targetShot ? db.prepare(`SELECT note_id, artifact_id, note, created_at FROM workbench_review_notes
    WHERE project_id = ? AND shot_id = ? ORDER BY created_at DESC, note_id DESC LIMIT ?`)
    .all(project.project_id, targetShot.shot_id, detail === "full" ? 50 : 10) as Array<{ note_id: string; artifact_id: string; note: string; created_at: string }> : [];
  const rawQuote = (targetShot && (kind === "generation_plan" || kind === "clip_regeneration"))
    ? readDirectorQuote(db, selectVerifiedDirectorCapability({
      duration_seconds: targetShot.duration_seconds,
      resolution: project.video_spec.resolution,
      aspect_ratio: project.video_spec.aspect_ratio
    }), now)
    : { quote_state: "not_applicable" as const, capability_reference: null, expires_at: null, currency: null, requires_human_refresh: false };
  const discussion = DIRECTOR_DISCUSSION_CONTEXT_SCHEMA.parse({
    project: {
      project_id: project.project_id, title: project.title, status: project.status, lifecycle_state: lifecycle,
      brief_summary: optionalText((brief as Record<string, unknown>).summary ?? (brief as Record<string, unknown>).brief),
      creative_direction: optionalText(creative), video_spec: project.video_spec
    },
    target_shot: targetShot ? discussionShot(targetShot) : null,
    adjacent_shots: adjacent.map(discussionShot),
    target_artifact: targetArtifact ? {
      artifact_id: targetArtifact.artifact_id, shot_id: targetArtifact.linked_objects.shot_id || null,
      artifact_type: targetArtifact.artifact_type, role: targetArtifact.role, status: targetArtifact.status,
      mime_type: targetArtifact.storage.mime_type, sha256: targetArtifact.metadata.sha256
    } : null,
    review_history: notes.map((note) => {
      const version = targetShot?.clip_versions.find((item) => item.artifact_id === note.artifact_id);
      const reviewArtifact = note.artifact_id ? getMediaArtifact(db, note.artifact_id) : null;
      if (note.artifact_id && (!version || !reviewArtifact
        || reviewArtifact.linked_objects.project_id !== project.project_id
        || reviewArtifact.linked_objects.shot_id !== targetShot?.shot_id
        || reviewArtifact.role !== "generated_clip" || reviewArtifact.artifact_type !== "video")) {
        throw new WebGptV4Error("DIRECTOR_DATA_INTEGRITY_VIOLATION", "Review Artifact binding is inconsistent.", "artifact_id");
      }
      const disposition = version?.review_status === "approved" ? "accepted" : version?.review_status === "rejected" ? "rejected" : "pending";
      return { event_id: note.note_id, artifact_id: note.artifact_id || null, disposition, reason_codes: [], note: note.note, created_at: new Date(note.created_at).toISOString() };
    }),
    quote: publicDirectorQuote(rawQuote),
    memory_recall: disabledDirectorMemoryRecall()
  });
  return { targetState, discussion, project, targetShot, targetArtifact };
}

function storedProposal(row: StoredProposalRow): DirectorProposal {
  const { payload_json: payloadJson, ...fields } = row;
  return DIRECTOR_PROPOSAL_SCHEMA.parse({ ...fields, focus_generation: Number(row.focus_generation), payload: JSON.parse(payloadJson) });
}

async function extractFrames(
  path: string,
  expectedSha256: string,
  expectedMime: "video/mp4" | "video/webm",
  requestedMax: number,
  sampling: "overview" | "adaptive",
  configuredFfmpeg?: string,
  signal?: AbortSignal
): Promise<{ duration: number; mime: "video/mp4" | "video/webm"; frames: Array<{ timestamp: number; width: number; height: number; bytes: Buffer }> }> {
  const ffmpeg = await resolveFfmpegExecutable(configuredFfmpeg);
  const ffprobe = await resolveFfprobeExecutable(ffmpeg);
  const root = await mkdtemp(join(tmpdir(), "director-frames-"));
  try {
    const snapshotPath = join(root, expectedMime === "video/webm" ? "source.webm" : "source.mp4");
    const sourceHash = createHash("sha256");
    const source = createReadStream(path);
    let sourceBytes = 0;
    source.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sourceBytes += bytes.byteLength;
      if (sourceBytes > MAX_SOURCE_VIDEO_BYTES) {
        source.destroy(new WebGptV4Error("DIRECTOR_MEDIA_SOURCE_TOO_LARGE", "Focused video exceeds the Director analysis source limit."));
        return;
      }
      sourceHash.update(bytes);
    });
    await pipeline(source, createWriteStream(snapshotPath, { flags: "wx" }), { signal });
    if (sourceHash.digest("hex") !== expectedSha256) {
      throw new WebGptV4Error("MEDIA_BLOB_CONTENT_DRIFT", "Focused video bytes changed before frame analysis.");
    }
    const { stdout } = await execFileAsync(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", snapshotPath], {
      encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, signal
    });
    const probe = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
    const stream = probe.streams?.find((item) => item.codec_type === "video");
    const duration = Number(probe.format?.duration);
    if (!stream?.width || !stream.height || !Number.isFinite(duration) || duration <= 0) {
      throw new WebGptV4Error("DIRECTOR_MEDIA_INVALID", "Focused video has no valid video stream.");
    }
    const count = Math.min(requestedMax, sampling === "overview" ? 12 : 24);
    const plan = selectDirectorFramePlan(duration, count);
    const frames: Array<{ timestamp: number; width: number; height: number; bytes: Buffer }> = [];
    let total = 0;
    for (const [index, item] of plan.entries()) {
      const output = join(root, `${String(index).padStart(3, "0")}.jpg`);
      const timestamp = item.timestamp_seconds < duration
        ? item.timestamp_seconds
        : Math.max(0, duration - Math.min(0.05, duration / 2));
      await execFileAsync(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-ss", timestamp.toFixed(3), "-i", snapshotPath,
        "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-pix_fmt", "yuvj420p",
        "-strict", "unofficial", "-threads", "1", "-q:v", "3", "-y", output
      ], { timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, signal });
      let bytes: Buffer;
      try { bytes = await readFile(output); }
      catch { throw new WebGptV4Error("DIRECTOR_MEDIA_ANALYSIS_FAILED", "A requested video frame could not be decoded."); }
      total += bytes.byteLength;
      if (total > DIRECTOR_MODEL_IMAGE_MAX_BYTES) throw new WebGptV4Error("DIRECTOR_MEDIA_FRAME_BUDGET_EXCEEDED", "Video frame output exceeds the model-input budget.");
      const width = Math.min(stream.width, 1280);
      const height = stream.width <= 1280 ? stream.height : Math.max(2, Math.round((stream.height * width / stream.width) / 2) * 2);
      frames.push({ timestamp, width, height, bytes });
    }
    return { duration, mime: expectedMime, frames };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function selectDirectorFramePlan(
  durationSeconds: number,
  count: number
): Array<{ timestamp_seconds: number; reason: "coverage" | "scene_change" }> {
  const plan = coverageFramePlan(durationSeconds);
  if (plan.length <= count) return plan;
  if (count <= 1) return [plan[Math.floor((plan.length - 1) / 2)]!];
  return Array.from({ length: count }, (_, index) => {
    const planIndex = Math.round((index * (plan.length - 1)) / (count - 1));
    return plan[planIndex]!;
  });
}

export class DirectorLocalService implements DirectorNativeToolHandlers {
  private readonly now: () => Date;
  private readonly memoryPort: DirectorMemoryPort;

  constructor(private readonly actor: WebGptV4Actor, private readonly options: DirectorLocalServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.memoryPort = options.memory_port ?? DISABLED_DIRECTOR_MEMORY_PORT;
  }

  private read<T>(operation: (db: M0Database) => T): T {
    const db = openM0DatabaseConnection(this.options.database_path, { readOnly: true });
    let transactionOpen = false;
    try {
      db.exec("BEGIN");
      transactionOpen = true;
      assertSchemaCurrent(db);
      const result = operation(db);
      db.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) db.exec("ROLLBACK");
      throw error;
    } finally { db.close(); }
  }

  async get_director_focus(): Promise<ReturnType<typeof DIRECTOR_GET_FOCUS_OUTPUT_SCHEMA.parse>> {
    return this.read((db) => {
      const actorIssuer = requireIssuer(this.actor);
      assertWebGptPrincipalActive(db, this.actor.principal_id, actorIssuer);
      const focus = currentFocus(db, this.actor);
      if (!focus) return DIRECTOR_GET_FOCUS_OUTPUT_SCHEMA.parse({ state: "no_focus", focus: null });
      if (focusIsTerminal(db, focus.focus_id) || Date.parse(focus.expires_at) <= this.now().getTime()) {
        return DIRECTOR_GET_FOCUS_OUTPUT_SCHEMA.parse({ state: "focus_expired", focus: null });
      }
      requireWebGptProjectReadAccess(db, this.actor.principal_id, this.actor.issuer_hash, focus.project_id);
      return DIRECTOR_GET_FOCUS_OUTPUT_SCHEMA.parse({ state: "active", focus: publicFocus(focus) });
    });
  }

  async get_director_context(input: Parameters<DirectorNativeToolHandlers["get_director_context"]>[0]) {
    const issuerHash = requireIssuer(this.actor);
    const prepared = this.read((db) => {
      const focus = requireFocus(db, this.actor, input.focus_id, input.focus_generation, this.now());
      const built = buildDirectorContext(db, focus, input.proposal_kind, input.detail, this.now());
      return { focus, built };
    });
    const memoryRecall = await recallDirectorMemory(this.memoryPort, {
      workspace_id: WORKSPACE_ID,
      principal_id: this.actor.principal_id,
      issuer_hash: issuerHash,
      project_id: prepared.focus.project_id,
      proposal_kind: input.proposal_kind
    });
    return DIRECTOR_GET_CONTEXT_OUTPUT_SCHEMA.parse({
      state: "ready", context_version: "director-context-v1", focus: publicFocus(prepared.focus),
      base_state_hash: directorBaseStateHash(prepared.built.targetState), target_state: prepared.built.targetState,
      discussion: { ...prepared.built.discussion, memory_recall: memoryRecall }
    });
  }

  async inspect_director_video_frames(input: Parameters<DirectorNativeToolHandlers["inspect_director_video_frames"]>[0]): Promise<DirectorVideoFrameToolOutput> {
    const prepared = this.read((db) => {
      const focus = requireFocus(db, this.actor, input.focus_id, input.focus_generation, this.now());
      const built = buildDirectorContext(db, focus, "review_assessment", "full");
      const artifact = built.targetArtifact;
      if (!artifact || artifact.artifact_id !== input.artifact_id) {
        throw new WebGptV4Error("DIRECTOR_MEDIA_NOT_FOCUS_BOUND", "Video Artifact is not bound to the active Focus target.", "artifact_id");
      }
      if (artifact.artifact_type !== "video" || !["video/mp4", "video/webm"].includes(artifact.storage.mime_type)) {
        throw new WebGptV4Error("DIRECTOR_MEDIA_INVALID", "Focused Artifact is not a supported video.", "artifact_id");
      }
      const checked = validateActiveArtifactReference(db, {
        artifact_id: artifact.artifact_id, project_id: focus.project_id,
        shot_id: artifact.linked_objects.shot_id, role: artifact.role, artifact_type: "video"
      });
      if (!checked.ok) throw new WebGptV4Error(checked.error.code, checked.error.message, "artifact_id");
      if (checked.blob.size_bytes > MAX_SOURCE_VIDEO_BYTES) {
        throw new WebGptV4Error("DIRECTOR_MEDIA_SOURCE_TOO_LARGE", "Focused video exceeds the Director analysis source limit.", "artifact_id");
      }
      return { focus, artifact, targetState: built.targetState, path: checked.blob.storage_uri, sha256: checked.blob.sha256 };
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FRAME_TIMEOUT_MS);
    let extracted: Awaited<ReturnType<typeof extractFrames>>;
    try {
      extracted = await extractFrames(
        prepared.path,
        prepared.sha256,
        prepared.artifact.storage.mime_type as "video/mp4" | "video/webm",
        input.max_frames,
        input.sampling,
        this.options.ffmpeg_path,
        controller.signal
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new WebGptV4Error("DIRECTOR_MEDIA_ANALYSIS_TIMEOUT", "Video frame analysis exceeded its time budget.", undefined, true);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    this.read((db) => {
      const focus = requireFocus(db, this.actor, input.focus_id, input.focus_generation, this.now());
      const artifact = getMediaArtifact(db, input.artifact_id);
      if (!artifact || artifact.linked_objects.project_id !== focus.project_id || artifact.metadata.sha256 !== prepared.sha256) {
        throw new WebGptV4Error("MEDIA_BLOB_CONTENT_DRIFT", "Focused video changed during frame analysis.");
      }
      const checked = validateActiveArtifactReference(db, {
        artifact_id: artifact.artifact_id, project_id: focus.project_id,
        shot_id: artifact.linked_objects.shot_id, role: artifact.role, artifact_type: "video"
      });
      if (!checked.ok) throw new WebGptV4Error(checked.error.code, checked.error.message, "artifact_id");
    });
    const structured = DIRECTOR_INSPECT_VIDEO_FRAMES_OUTPUT_SCHEMA.parse({
      state: "ready", focus_id: prepared.focus.focus_id, focus_generation: prepared.focus.generation,
      project_id: prepared.focus.project_id, artifact_id: prepared.artifact.artifact_id,
      mime_type: extracted.mime, duration_seconds: extracted.duration,
      base_state_hash: directorBaseStateHash(prepared.targetState),
      frames: extracted.frames.map((frame, sequence) => ({
        sequence, timestamp_seconds: frame.timestamp, width: frame.width, height: frame.height,
        sha256: createHash("sha256").update(frame.bytes).digest("hex")
      })),
      truncated: extracted.frames.length < input.max_frames
    });
    return {
      structured_content: structured,
      model_images: extracted.frames.map((frame) => ({ data: frame.bytes.toString("base64"), mime_type: "image/jpeg" }))
    };
  }

  async submit_director_proposal(input: Parameters<DirectorNativeToolHandlers["submit_director_proposal"]>[0]) {
    const db = openM0DatabaseConnection(this.options.database_path);
    let transactionOpen = false;
    try {
      assertSchemaCurrent(db);
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const focus = requireFocus(db, this.actor, input.focus_id, input.focus_generation, this.now());
      const built = buildDirectorContext(db, focus, input.proposal.kind, "full");
      const authoritativeHash = directorBaseStateHash(built.targetState);
      if (input.base_state_hash !== authoritativeHash) {
        throw new WebGptV4Error("DIRECTOR_BASE_STATE_DRIFT", "Director Proposal was prepared from stale authoritative state.", "base_state_hash");
      }
      const payloadHash = directorContentHash(input.proposal.payload);
      const existing = db.prepare(`SELECT * FROM director_proposals
        WHERE workspace_id = ? AND principal_id = ? AND idempotency_key = ?`)
        .get(WORKSPACE_ID, this.actor.principal_id, input.idempotency_key) as StoredProposalRow | undefined;
      if (existing) {
        const proposal = storedProposal(existing);
        if (proposal.focus_id !== focus.focus_id || proposal.focus_generation !== focus.generation
          || proposal.base_state_hash !== authoritativeHash || proposal.payload_hash !== payloadHash
          || proposal.kind !== input.proposal.kind
          || proposal.source !== "native"
          || proposal.parent_proposal_id !== (input.parent_proposal_id ?? null)) {
          throw new WebGptV4Error("DIRECTOR_IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another Proposal.", "idempotency_key");
        }
        const replay = DIRECTOR_SUBMIT_PROPOSAL_OUTPUT_SCHEMA.parse({
          state: "accepted_for_human_review", proposal_id: proposal.proposal_id, kind: proposal.kind,
          focus_id: proposal.focus_id, focus_generation: proposal.focus_generation,
          base_state_hash: proposal.base_state_hash, payload_hash: proposal.payload_hash,
          source: "native", created_at: proposal.created_at
        });
        db.exec("COMMIT");
        transactionOpen = false;
        return replay;
      }
      const proposal = DIRECTOR_PROPOSAL_SCHEMA.parse({
        proposal_id: `director_proposal_${randomUUID()}`, schema_version: "director-domain-v1",
        workspace_id: WORKSPACE_ID, principal_id: this.actor.principal_id, project_id: focus.project_id,
        target_type: focus.target_type, target_id: focus.target_id, focus_id: focus.focus_id,
        focus_generation: focus.generation, base_state_hash: authoritativeHash, payload_hash: payloadHash,
        parent_proposal_id: input.parent_proposal_id ?? null, idempotency_key: input.idempotency_key,
        source: "native", created_at: this.now().toISOString(), ...input.proposal
      });
      validateDirectorProposalAgainstTargetState(proposal, built.targetState);
      db.prepare(`INSERT INTO director_proposals
        (proposal_id, workspace_id, principal_id, project_id, target_type, target_id, focus_id, focus_generation,
         schema_version, kind, base_state_hash, payload_json, payload_hash, parent_proposal_id, idempotency_key, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(proposal.proposal_id, proposal.workspace_id, proposal.principal_id, proposal.project_id,
          proposal.target_type, proposal.target_id, proposal.focus_id, proposal.focus_generation,
          proposal.schema_version, proposal.kind, proposal.base_state_hash, JSON.stringify(proposal.payload),
          proposal.payload_hash, proposal.parent_proposal_id, proposal.idempotency_key, proposal.source, proposal.created_at);
      db.prepare(`INSERT INTO director_proposal_events
        (event_id, proposal_id, event_type, reason_code, created_at) VALUES (?, ?, 'submitted', 'DIRECTOR_NATIVE_SUBMITTED', ?)`)
        .run(`director_proposal_event_${randomUUID()}`, proposal.proposal_id, proposal.created_at);
      const result = DIRECTOR_SUBMIT_PROPOSAL_OUTPUT_SCHEMA.parse({
        state: "accepted_for_human_review", proposal_id: proposal.proposal_id, kind: proposal.kind,
        focus_id: proposal.focus_id, focus_generation: proposal.focus_generation,
        base_state_hash: proposal.base_state_hash, payload_hash: proposal.payload_hash,
        source: "native", created_at: proposal.created_at
      });
      db.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) db.exec("ROLLBACK");
      throw error;
    } finally { db.close(); }
  }

  async get_director_proposal_status(input: Parameters<DirectorNativeToolHandlers["get_director_proposal_status"]>[0]) {
    return this.read((db) => {
      const row = db.prepare("SELECT * FROM director_proposals WHERE proposal_id = ? AND workspace_id = ? AND principal_id = ?")
        .get(input.proposal_id, WORKSPACE_ID, this.actor.principal_id) as StoredProposalRow | undefined;
      if (!row) throw new WebGptV4Error("DIRECTOR_PROPOSAL_NOT_FOUND", "Director Proposal was not found.", "proposal_id");
      requireWebGptProjectReadAccess(db, this.actor.principal_id, requireIssuer(this.actor), row.project_id);
      const event = db.prepare(`SELECT event_type, reason_code, created_at FROM director_proposal_events
        WHERE proposal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .get(row.proposal_id) as { event_type: string; reason_code: string; created_at: string } | undefined;
      const states: Record<string, string> = {
        submitted: "pending_review", imported: "pending_review", accepted: "approved",
        rejected: "rejected", withdrawn: "superseded", compiled: "approved"
      };
      return DIRECTOR_GET_PROPOSAL_STATUS_OUTPUT_SCHEMA.parse({
        proposal_id: row.proposal_id, state: states[event?.event_type ?? "submitted"] ?? "pending_review",
        reason_code: event?.reason_code ?? null, updated_at: new Date(event?.created_at ?? row.created_at).toISOString()
      });
    });
  }
}

export function createDirectorLocalService(actor: WebGptV4Actor, options: DirectorLocalServiceOptions): DirectorLocalService {
  return new DirectorLocalService(actor, options);
}
