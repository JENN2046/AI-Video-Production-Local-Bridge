import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import { ensureM0Directories, paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { createProject, getProject, getShot, listProjectShots, type Project, type Shot } from "./projects.js";
import { type GenerationRun } from "./generation.js";
import { assembleFinalVideo } from "./assembly.js";
import { importG0AppReadyStoryboardPackage, validateG0StoryboardPackage, type G0StoryboardPackageInput } from "./g0Pregen.js";
import { getMediaArtifact, registerMediaArtifact, type MediaArtifact } from "./mediaArtifacts.js";
import { validateImageFile, type ImageValidationResult } from "./imageValidity.js";
import { validateMp4File, type Mp4ValidationResult } from "./mediaValidity.js";
import { markShotClipReview, type RevisionInstruction } from "./review.js";
import { classifyStoryboardImageImport, isNineSixteenAspectRatio, isNineSixteenDimensions } from "./importClassifier.js";

export const H1_STATE_FILE = "data/h1/workbench_state.json";
export const H1_FREEZE_REPORT_LATEST = "data/reports/h1_workbench_package_freeze_result.json";
export const H1_IMPORT_REPORT_LATEST = "data/reports/h1_workbench_import_register_result.json";
export const H2_RUNWAY_CANARY_DRY_RUN_REPORT = "data/reports/m1_r0_runway_canary_dry_run_report.json";
export const H3_REVIEW_REPORT_LATEST = "data/reports/h3_video_review_result.json";
export const H4_FINAL_ASSEMBLY_REPORT_LATEST = "data/reports/h4_final_assembly_result.json";

const H1_FREEZE_REPORT_STEM = "h1_workbench_package_freeze_result";
const H1_IMPORT_REPORT_STEM = "h1_workbench_import_register_result";
const H3_REVIEW_REPORT_STEM = "h3_video_review_result";
const H4_FINAL_ASSEMBLY_REPORT_STEM = "h4_final_assembly_result";
const H3_REVIEW_CLIP_LIMIT = 50;
const H3_REVIEW_CLIP_MAX_LIMIT = 200;
const APPROVED_REVIEW_STATUS = "approved_for_media_artifact_handoff";

export const H1_PROVIDER_BOUNDARY = {
  network_call_attempted: false,
  runway_called: false,
  runninghub_called: false,
  provider_credits_consumed: false,
  real_video_generated: false,
  regeneration_performed: false,
  batch_generation_performed: false,
  final_assembly_performed: false,
  memory_saveback_performed: false,
  source_asset_overwritten: false,
  secret_values_exposed: false
} as const;

export type H1ShotApprovalStatus = "pending" | "approved" | "revision_needed";
export type H1MutationResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface H1ShotDraft {
  shot_id: string;
  order: number;
  duration_seconds: number;
  description: string;
  video_prompt: string;
  negative_prompt: string;
  continuity_constraints: string[];
  storyboard_image_artifact_id: string;
  approval_status: H1ShotApprovalStatus;
}

export interface H1WorkbenchState {
  version: "h1-v0.1";
  updated_at: string;
  project: {
    project_id: string;
    title: string;
    project_type: string;
    duration_seconds: number;
    aspect_ratio: "9:16";
    resolution: string;
  };
  shots: H1ShotDraft[];
  rejected_imports: Array<{ import_filename: string; reason: string; rejected_at: string }>;
  frozen_package_history: Array<{ storyboard_package_id: string; report_path: string; frozen_at: string }>;
  regeneration_request_drafts: H3RegenerationRequestDraft[];
}

export interface H1ScannedImport {
  filename: string;
  relative_path: string;
  size_bytes: number;
  readable_image: boolean;
  mime_type: string;
  width: number;
  height: number;
  detected_aspect_ratio: string;
  normalized_aspect_ratio: "9:16" | "";
  checksum: string;
  review_status: "approved_for_media_artifact_handoff" | "blocked";
  blockers: string[];
  existing_artifact_ids: string[];
}

export interface H1PackageValidation {
  ok: boolean;
  blockers: string[];
  validateG0StoryboardPackage: "PASS" | "FAIL";
  app_ready: boolean;
  project_id: string;
  shot_count: number;
}

export interface H2CanaryWorkbenchSummary {
  report_path: string;
  report_exists: boolean;
  report_result: string;
  active_provider: string;
  env_check_result: string;
  provider_preflight_result: string;
  credential_env_name: string | null;
  credential_present: boolean;
  selected_input: {
    path: string;
    source_type: string;
    width: number;
    height: number;
    aspect_ratio: string;
    runway_ratio: string | null;
    duration_seconds: number;
    readable: boolean;
    usable_for_real_provider_canary: boolean;
  };
  provider_boundary: typeof H1_PROVIDER_BOUNDARY & {
    provider: string;
    model: string;
    endpoint: string;
    x_runway_version: string;
    max_submit_calls: number;
    runway_ratio: string;
    direct_9_16_sent_to_runway: boolean;
    real_submit_available: false;
    real_submit_requires_separate_authorization: true;
  };
  dry_run_plan: {
    command: string;
    can_open_latest_report: boolean;
    can_generate_from_workbench: false;
    regeneration_allowed: false;
    batch_generation_allowed: false;
    runninghub_allowed: false;
  };
  authorization: {
    required_for_real_call: true;
    provided: boolean;
    accepted: boolean;
  };
}

export interface H3RegenerationRequestDraft {
  draft_id: string;
  shot_id: string;
  artifact_id: string;
  previous_run_id: string;
  rejection_reasons: string[];
  revision_instruction: RevisionInstruction;
  status: "draft";
  created_at: string;
}

export interface H3VideoReviewItem {
  shot_id: string;
  run_id: string;
  run_status: string;
  run_type: string;
  provider_name: string;
  provider_job_id: string;
  artifact_id: string;
  artifact_type: string;
  artifact_role: string;
  artifact_status: string;
  storage_filename: string;
  accepted_clip_artifact_id: string;
  clip_review_status: "pending" | "approved" | "rejected";
  ffprobe: Mp4ValidationResult | null;
  rejection_reasons: string[];
  latest_revision_instruction: RevisionInstruction | null;
}

export interface H3VideoReviewSummary {
  generated_clips: H3VideoReviewItem[];
  generated_clip_limit: number;
  generated_clip_offset: number;
  generated_clip_total_available: number;
  generated_clip_filtered_available: number;
  generated_clip_status_counts: {
    all: number;
    pending: number;
    approved: number;
    rejected: number;
  };
  generated_clip_shot_count_total: number;
  generated_clip_shot_counts: Array<{ shot_id: string; count: number }>;
  generated_clip_filters: {
    status: "all" | H3VideoReviewItem["clip_review_status"];
    shot_id: string;
  };
  regeneration_request_drafts: H3RegenerationRequestDraft[];
  provider_boundary: typeof H1_PROVIDER_BOUNDARY;
}

export interface H3VideoReviewSummaryOptions {
  status?: "all" | H3VideoReviewItem["clip_review_status"];
  shot_id?: string;
  offset?: number;
  limit?: number;
}

export interface H4AssemblyClipPreview {
  shot_id: string;
  order: number;
  duration_seconds: number;
  accepted_clip_artifact_id: string;
  accepted_clip_status: string;
  storage_filename: string;
  ffprobe: Mp4ValidationResult | null;
  blockers: string[];
}

export interface H4FinalVideoArtifactSummary {
  artifact_id: string;
  exists: boolean;
  artifact_type: string;
  role: string;
  status: string;
  storage_filename: string;
  ffprobe: Mp4ValidationResult | null;
}

export interface H4FinalAssemblyWorkbenchSummary {
  project_id: string;
  project_title: string;
  project_status: string;
  ready_for_assembly: boolean;
  blockers: string[];
  required_shots: number;
  accepted_clips: number;
  clip_order_preview: H4AssemblyClipPreview[];
  final_video_artifact: H4FinalVideoArtifactSummary | null;
  latest_report_path: string;
  latest_report_exists: boolean;
  provider_boundary: typeof H1_PROVIDER_BOUNDARY;
  confirmation: {
    required: true;
    accepted_by_summary: false;
  };
}

function now(): string {
  return new Date().toISOString();
}

function h1Root(): string {
  return join(paths.dataRoot, "h1");
}

function h1StatePath(): string {
  return join(paths.workspaceRoot, H1_STATE_FILE);
}

function ensureH1Directories(): void {
  ensureM0Directories();
  if (!existsSync(h1Root())) mkdirSync(h1Root(), { recursive: true });
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toolError(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

function pendingId(value: string): boolean {
  const upper = value.toUpperCase();
  return upper.startsWith("PENDING") || upper.includes("PENDING_");
}

function forbiddenImportNameReason(filename: string): string | null {
  const classification = classifyStoryboardImageImport(filename);
  return classification.ok ? null : classification.reason_code;
}

function isNineSixteenLike(width: number, height: number): boolean {
  return isNineSixteenDimensions(width, height);
}

function safeImportImagePath(filename: string): H1MutationResult<string> {
  const reason = forbiddenImportNameReason(filename);
  if (reason) return { ok: false, error: toolError(reason, `Import filename is not allowed: ${filename}`) };

  const importsRoot = resolve(paths.importsRoot);
  const sourcePath = resolve(importsRoot, filename);
  if (!isPathInside(sourcePath, importsRoot)) return { ok: false, error: toolError("STORAGE_PATH_NOT_ALLOWED", "Import path resolved outside data/imports.") };
  if (!existsSync(sourcePath)) return { ok: false, error: toolError("IMAGE_FILE_NOT_READABLE", `Import image not found: ${filename}`) };
  if (lstatSync(sourcePath).isSymbolicLink()) return { ok: false, error: toolError("SYMLINK_ESCAPE_BLOCKED", "Import image symbolic links are blocked.") };

  const realSourcePath = realpathSync(sourcePath);
  if (!isPathInside(realSourcePath, importsRoot)) return { ok: false, error: toolError("SYMLINK_ESCAPE_BLOCKED", "Import image resolves outside data/imports.") };
  if (!statSync(realSourcePath).isFile()) return { ok: false, error: toolError("IMAGE_FILE_NOT_READABLE", "Import path is not a file.") };
  return { ok: true, value: realSourcePath };
}

function inspectImportImage(filename: string): H1ScannedImport {
  const relativePath = `data/imports/${filename}`;
  const base = {
    filename,
    relative_path: relativePath,
    size_bytes: 0,
    readable_image: false,
    mime_type: "",
    width: 0,
    height: 0,
    detected_aspect_ratio: "",
    normalized_aspect_ratio: "" as const,
    checksum: "",
    review_status: "blocked" as const,
    blockers: [] as string[],
    existing_artifact_ids: [] as string[]
  };

  const safePath = safeImportImagePath(filename);
  if (!safePath.ok) return { ...base, blockers: [safePath.error.code] };
  const size = statSync(safePath.value).size;
  const validation = validateImageFile(safePath.value);
  if (!validation.ok) {
    return {
      ...base,
      size_bytes: size,
      blockers: [validation.error_code || "IMAGE_FILE_INVALID"]
    };
  }

  const blockers: string[] = [];
  if (validation.detected_mime !== "image/png" && validation.detected_mime !== "image/jpeg") blockers.push("IMAGE_MIME_UNSUPPORTED");
  if (!isNineSixteenLike(validation.width, validation.height)) blockers.push("ASPECT_RATIO_NOT_9_16");

  return {
    ...base,
    size_bytes: size,
    readable_image: validation.ok,
    mime_type: validation.detected_mime,
    width: validation.width,
    height: validation.height,
    detected_aspect_ratio: validation.aspect_ratio,
    normalized_aspect_ratio: isNineSixteenLike(validation.width, validation.height) ? "9:16" : "",
    checksum: validation.sha256,
    review_status: blockers.length === 0 ? APPROVED_REVIEW_STATUS : "blocked",
    blockers
  };
}

function listMediaArtifacts(db: M0Database): MediaArtifact[] {
  const rows = db.prepare("SELECT data_json FROM media_artifacts ORDER BY created_at").all() as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as MediaArtifact);
}

function imageChecksumByArtifact(artifact: MediaArtifact): string {
  const metadata = artifact.metadata as Partial<MediaArtifact["metadata"]> | undefined;
  const source = artifact.source as Partial<MediaArtifact["source"]> | undefined;
  return metadata?.sha256 || source?.sha256 || "";
}

export function listH1MediaArtifacts(db = openM0Database()): MediaArtifact[] {
  return listMediaArtifacts(db).filter((artifact) => artifact.artifact_type === "image" && artifact.role === "storyboard_image");
}

export function scanH1Imports(db = openM0Database()): H1ScannedImport[] {
  ensureM0Directories();
  if (!existsSync(paths.importsRoot)) return [];
  const artifacts = listH1MediaArtifacts(db);

  return readdirSync(paths.importsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const scanned = inspectImportImage(entry.name);
      if (scanned.checksum) {
        scanned.existing_artifact_ids = artifacts
          .filter((artifact) => imageChecksumByArtifact(artifact) === scanned.checksum)
          .map((artifact) => artifact.artifact_id);
      }
      return scanned;
    });
}

export function defaultH1WorkbenchState(): H1WorkbenchState {
  return {
    version: "h1-v0.1",
    updated_at: now(),
    project: {
      project_id: "",
      title: "Ryan's Lunch Break Skullcap",
      project_type: "h1_human_operator_workbench",
      duration_seconds: 15,
      aspect_ratio: "9:16",
      resolution: "1080x1920"
    },
    shots: [
      {
        shot_id: "SHOT_001",
        order: 1,
        duration_seconds: 3,
        description: "Ryan sits at the construction-site lunch bench with the gray skullcap visible.",
        video_prompt: "",
        negative_prompt: "",
        continuity_constraints: [],
        storyboard_image_artifact_id: "",
        approval_status: "pending"
      },
      {
        shot_id: "SHOT_002",
        order: 2,
        duration_seconds: 3,
        description: "Ryan reaches toward the work gloves and nearby gear on the lunch table.",
        video_prompt: "",
        negative_prompt: "",
        continuity_constraints: [],
        storyboard_image_artifact_id: "",
        approval_status: "pending"
      },
      {
        shot_id: "SHOT_003",
        order: 3,
        duration_seconds: 4,
        description: "Ryan adjusts the gray skullcap with both hands.",
        video_prompt: "",
        negative_prompt: "",
        continuity_constraints: [],
        storyboard_image_artifact_id: "",
        approval_status: "pending"
      },
      {
        shot_id: "SHOT_004",
        order: 4,
        duration_seconds: 5,
        description: "Ryan stands with hard hat and work bag, ready to return to the worksite.",
        video_prompt: "",
        negative_prompt: "",
        continuity_constraints: [],
        storyboard_image_artifact_id: "",
        approval_status: "pending"
      }
    ],
    rejected_imports: [],
    frozen_package_history: [],
    regeneration_request_drafts: []
  };
}

function normalizeH1WorkbenchState(parsed: H1WorkbenchState): H1WorkbenchState {
  return {
    ...defaultH1WorkbenchState(),
    ...parsed,
    regeneration_request_drafts: parsed.regeneration_request_drafts ?? []
  };
}

export function loadH1WorkbenchState(): H1WorkbenchState {
  ensureH1Directories();
  const target = h1StatePath();
  if (!existsSync(target)) return defaultH1WorkbenchState();
  return normalizeH1WorkbenchState(JSON.parse(readFileSync(target, "utf8")) as H1WorkbenchState);
}

export function saveH1WorkbenchState(state: H1WorkbenchState): H1WorkbenchState {
  ensureH1Directories();
  const next = { ...state, updated_at: now() };
  writeFileSync(h1StatePath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function registerH1ApprovedKeyframe(
  input: { import_filename: string; review_status: string; write_report?: boolean },
  db = openM0Database()
): H1MutationResult<{ artifact: MediaArtifact; report: unknown }> {
  if (input.review_status !== APPROVED_REVIEW_STATUS) {
    return { ok: false, error: toolError("REVIEW_STATUS_NOT_APPROVED", "Import requires approved_for_media_artifact_handoff review status.") };
  }

  const scanned = inspectImportImage(input.import_filename);
  if (scanned.blockers.length > 0) {
    return { ok: false, error: toolError(scanned.blockers[0], `Import is blocked: ${scanned.blockers.join(", ")}`) };
  }

  const registered = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "local_file_import", import_filename: input.import_filename },
      metadata: { sha256: scanned.checksum },
      provenance: { sha256: scanned.checksum }
    },
    db
  );
  if (!registered.ok) return { ok: false, error: registered.error };

  const storedValidation = validateImageFile(registered.artifact.storage.uri);
  const runId = randomUUID();
  const report = {
    task: "H1-HANDOFF-WORKBENCH-MVP",
    action: "register_approved_keyframe",
    result: "PASS",
    run_id: runId,
    generated_at: now(),
    import_filename: input.import_filename,
    review_status: input.review_status,
    artifact: {
      artifact_id: registered.artifact.artifact_id,
      artifact_type: registered.artifact.artifact_type,
      role: registered.artifact.role,
      status: registered.artifact.status,
      storage_uri: registered.artifact.storage.uri,
      mime_type: registered.artifact.storage.mime_type,
      width: registered.artifact.metadata.width,
      height: registered.artifact.metadata.height,
      detected_aspect_ratio: registered.artifact.metadata.aspect_ratio,
      normalized_aspect_ratio: "9:16",
      checksum: storedValidation.ok ? storedValidation.sha256 : scanned.checksum
    },
    provider_boundary: H1_PROVIDER_BOUNDARY,
    report_path: `data/reports/${H1_IMPORT_REPORT_STEM}_${runId}.json`,
    latest_report_path: H1_IMPORT_REPORT_LATEST
  };
  if (input.write_report !== false) writeJsonReport(H1_IMPORT_REPORT_STEM, runId, report, H1_IMPORT_REPORT_LATEST);
  return { ok: true, value: { artifact: registered.artifact, report } };
}

function findShot(state: H1WorkbenchState, shotId: string): H1ShotDraft | null {
  return state.shots.find((shot) => shot.shot_id === shotId) ?? null;
}

export function updateH1ShotMetadata(
  state: H1WorkbenchState,
  input: { shot_id: string; duration_seconds?: number; description?: string; video_prompt?: string; negative_prompt?: string; continuity_constraints?: string[] }
): H1MutationResult<H1WorkbenchState> {
  const shot = findShot(state, input.shot_id);
  if (!shot) return { ok: false, error: toolError("SHOT_NOT_FOUND", `Shot not found: ${input.shot_id}`) };
  const nextShot: H1ShotDraft = {
    ...shot,
    duration_seconds: input.duration_seconds ?? shot.duration_seconds,
    description: input.description ?? shot.description,
    video_prompt: input.video_prompt ?? shot.video_prompt,
    negative_prompt: input.negative_prompt ?? shot.negative_prompt,
    continuity_constraints: input.continuity_constraints ?? shot.continuity_constraints
  };
  if (nextShot.duration_seconds <= 0) return { ok: false, error: toolError("MISSING_REQUIRED_FIELD", "duration_seconds must be positive.") };
  return {
    ok: true,
    value: {
      ...state,
      updated_at: now(),
      shots: state.shots.map((candidate) => (candidate.shot_id === input.shot_id ? nextShot : candidate))
    }
  };
}

export function linkH1ArtifactToShot(
  state: H1WorkbenchState,
  input: { shot_id: string; artifact_id: string },
  db = openM0Database()
): H1MutationResult<H1WorkbenchState> {
  if (pendingId(input.artifact_id)) return { ok: false, error: toolError("PENDING_ID_REJECTED", "PENDING_* artifact IDs are not accepted.") };
  const shot = findShot(state, input.shot_id);
  if (!shot) return { ok: false, error: toolError("SHOT_NOT_FOUND", `Shot not found: ${input.shot_id}`) };
  const artifact = getMediaArtifact(db, input.artifact_id);
  if (!artifact) return { ok: false, error: toolError("ARTIFACT_NOT_FOUND", `Artifact not found: ${input.artifact_id}`) };
  if (artifact.status !== "active") return { ok: false, error: toolError(`ARTIFACT_${artifact.status.toUpperCase()}`, `Artifact is not active: ${artifact.status}`) };
  if (artifact.artifact_type !== "image" || artifact.role !== "storyboard_image") {
    return { ok: false, error: toolError("INVALID_ARTIFACT_ROLE", "Shot can only link active storyboard_image image artifacts.") };
  }

  return {
    ok: true,
    value: {
      ...state,
      updated_at: now(),
      shots: state.shots.map((candidate) => (candidate.shot_id === input.shot_id ? { ...candidate, storyboard_image_artifact_id: input.artifact_id } : candidate))
    }
  };
}

export function markH1ShotApproved(state: H1WorkbenchState, input: { shot_id: string; human_confirmation: boolean }): H1MutationResult<H1WorkbenchState> {
  if (input.human_confirmation !== true) return { ok: false, error: toolError("HUMAN_CONFIRMATION_REQUIRED", "Approving a shot requires explicit human confirmation.") };
  const shot = findShot(state, input.shot_id);
  if (!shot) return { ok: false, error: toolError("SHOT_NOT_FOUND", `Shot not found: ${input.shot_id}`) };
  return {
    ok: true,
    value: {
      ...state,
      updated_at: now(),
      shots: state.shots.map((candidate) => (candidate.shot_id === input.shot_id ? { ...candidate, approval_status: "approved" } : candidate))
    }
  };
}

export function markH1ShotRevisionNeeded(state: H1WorkbenchState, input: { shot_id: string }): H1MutationResult<H1WorkbenchState> {
  const shot = findShot(state, input.shot_id);
  if (!shot) return { ok: false, error: toolError("SHOT_NOT_FOUND", `Shot not found: ${input.shot_id}`) };
  return {
    ok: true,
    value: {
      ...state,
      updated_at: now(),
      shots: state.shots.map((candidate) => (candidate.shot_id === input.shot_id ? { ...candidate, approval_status: "revision_needed" } : candidate))
    }
  };
}

export function rejectH1Import(state: H1WorkbenchState, input: { import_filename: string; reason: string }): H1WorkbenchState {
  return {
    ...state,
    updated_at: now(),
    rejected_imports: [
      ...state.rejected_imports,
      {
        import_filename: basename(input.import_filename),
        reason: input.reason || "rejected_from_storyboard_flow",
        rejected_at: now()
      }
    ]
  };
}

export function h1ShotBlockers(shot: H1ShotDraft, db = openM0Database()): string[] {
  const blockers: string[] = [];
  if (pendingId(shot.storyboard_image_artifact_id)) blockers.push("PENDING_ID_REJECTED");
  if (!shot.storyboard_image_artifact_id) blockers.push("MISSING_STORYBOARD_IMAGE_ARTIFACT_ID");
  if (!shot.description.trim()) blockers.push("MISSING_DESCRIPTION");
  if (!shot.video_prompt.trim()) blockers.push("MISSING_VIDEO_PROMPT");
  if (typeof shot.negative_prompt !== "string") blockers.push("MISSING_NEGATIVE_PROMPT");
  if (typeof shot.duration_seconds !== "number" || shot.duration_seconds <= 0) blockers.push("MISSING_DURATION_SECONDS");
  if (shot.approval_status !== "approved") blockers.push("SHOT_NOT_APPROVED");

  if (shot.storyboard_image_artifact_id && !pendingId(shot.storyboard_image_artifact_id)) {
    const artifact = getMediaArtifact(db, shot.storyboard_image_artifact_id);
    if (!artifact) blockers.push("ARTIFACT_NOT_FOUND");
    else {
      if (artifact.status !== "active") blockers.push(`ARTIFACT_${artifact.status.toUpperCase()}`);
      if (artifact.artifact_type !== "image" || artifact.role !== "storyboard_image") blockers.push("INVALID_ARTIFACT_ROLE");
      if (!isNineSixteenAspectRatio(artifact.metadata.aspect_ratio)) blockers.push("STORYBOARD_IMAGE_ASPECT_RATIO_NOT_9_16");
    }
  }
  return blockers;
}

export function prepareH1StoryboardPackageProject(state: H1WorkbenchState, db = openM0Database()): H1MutationResult<{ project: Project; state: H1WorkbenchState }> {
  if (pendingId(state.project.project_id)) return { ok: false, error: toolError("FAKE_PROJECT_ID_REJECTED", "PENDING or fake project IDs are not accepted.") };
  if (state.project.project_id) {
    const existing = getProject(db, state.project.project_id);
    if (!existing) return { ok: false, error: toolError("PROJECT_NOT_FOUND", `Project not found: ${state.project.project_id}`) };
    return { ok: true, value: { project: existing, state } };
  }

  const created = createProject(
    {
      title: state.project.title,
      project_type: state.project.project_type,
      video_spec: {
        duration_seconds: state.project.duration_seconds,
        aspect_ratio: state.project.aspect_ratio,
        resolution: state.project.resolution
      }
    },
    db
  );
  if (!created.ok) return { ok: false, error: created.error };
  return {
    ok: true,
    value: {
      project: created.project,
      state: {
        ...state,
        updated_at: now(),
        project: {
          ...state.project,
          project_id: created.project.project_id
        }
      }
    }
  };
}

function buildG0Input(state: H1WorkbenchState, projectId: string): G0StoryboardPackageInput {
  return {
    project_id: projectId,
    status: "approved_for_video_generation",
    approved_by_user: true,
    confirmation: {
      user_confirmed: true,
      source: "app"
    },
    shots: state.shots
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((shot) => ({
        shot_id: shot.shot_id,
        order: shot.order,
        duration_seconds: shot.duration_seconds,
        storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
        shot_description: shot.description,
        video_prompt: shot.video_prompt,
        negative_prompt: shot.negative_prompt,
        continuity_constraints: shot.continuity_constraints,
        approved_by_user: shot.approval_status === "approved"
      }))
  };
}

export function validateH1StoryboardPackage(state: H1WorkbenchState, db = openM0Database()): H1MutationResult<{ state: H1WorkbenchState; validation: H1PackageValidation }> {
  const shotBlockers = state.shots.flatMap((shot) => h1ShotBlockers(shot, db).map((blocker) => `${shot.shot_id}:${blocker}`));
  const projectBlockers: string[] = [];
  if (pendingId(state.project.project_id)) projectBlockers.push("FAKE_PROJECT_ID_REJECTED");
  else if (!state.project.project_id) projectBlockers.push("PROJECT_NOT_PREPARED");
  else if (!getProject(db, state.project.project_id)) projectBlockers.push("PROJECT_NOT_FOUND");
  const blockers = [...projectBlockers, ...shotBlockers];

  if (blockers.length > 0) {
    return {
      ok: true,
      value: {
        state,
        validation: {
          ok: false,
          blockers,
          validateG0StoryboardPackage: "FAIL",
          app_ready: false,
          project_id: state.project.project_id,
          shot_count: state.shots.length
        }
      }
    };
  }

  const packageInput = buildG0Input(state, state.project.project_id);
  const validation = validateG0StoryboardPackage(packageInput, db);
  if (!validation.ok) {
    return {
      ok: true,
      value: {
        state,
        validation: {
          ok: false,
          blockers: [validation.error.code],
          validateG0StoryboardPackage: "FAIL",
          app_ready: false,
          project_id: state.project.project_id,
          shot_count: state.shots.length
        }
      }
    };
  }
  return {
    ok: true,
    value: {
      state,
      validation: {
        ok: true,
        blockers: [],
        validateG0StoryboardPackage: "PASS",
        app_ready: validation.app_ready,
        project_id: state.project.project_id,
        shot_count: state.shots.length
      }
    }
  };
}

export function freezeH1StoryboardPackage(
  state: H1WorkbenchState,
  input: { human_confirmation: boolean; write_report?: boolean },
  db = openM0Database()
): H1MutationResult<{ state: H1WorkbenchState; report: unknown }> {
  if (input.human_confirmation !== true) return { ok: false, error: toolError("HUMAN_CONFIRMATION_REQUIRED", "Freezing a Storyboard Package requires explicit human confirmation.") };
  const validationResult = validateH1StoryboardPackage(state, db);
  if (!validationResult.ok) return validationResult;
  if (!validationResult.value.validation.ok) {
    return { ok: false, error: toolError("FREEZE_PRECONDITIONS_BLOCKED", validationResult.value.validation.blockers.join(", ")) };
  }

  const nextState = validationResult.value.state;
  const packageInput = buildG0Input(nextState, validationResult.value.validation.project_id);
  const imported = importG0AppReadyStoryboardPackage(packageInput, db);
  if (!imported.ok) return { ok: false, error: imported.error };

  const runId = randomUUID();
  const frozenAt = now();
  const reportPath = `data/reports/${H1_FREEZE_REPORT_STEM}_${runId}.json`;
  const report = {
    task: "H1-HANDOFF-WORKBENCH-MVP",
    action: "freeze_app_ready_storyboard_package",
    result: "PASS",
    run_id: runId,
    generated_at: frozenAt,
    project: {
      project_id: imported.project.project_id,
      title: imported.project.title,
      status: imported.project.status
    },
    package_validation: {
      validateG0StoryboardPackage: "PASS",
      importG0AppReadyStoryboardPackage: "PASS"
    },
    storyboard_package: {
      storyboard_package_id: imported.storyboard_package_id,
      status: "approved_for_video_generation",
      frozen: true,
      shot_count: imported.shots.length,
      shot_ids: imported.shots.map((shot) => shot.shot_id)
    },
    shots: packageInput.shots.map((shot) => ({
      shot_id: shot.shot_id,
      order: shot.order,
      storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
      approved_by_user: shot.approved_by_user
    })),
    provider_boundary: H1_PROVIDER_BOUNDARY,
    report_path: reportPath,
    latest_report_path: H1_FREEZE_REPORT_LATEST
  };
  if (input.write_report !== false) writeJsonReport(H1_FREEZE_REPORT_STEM, runId, report, H1_FREEZE_REPORT_LATEST);

  return {
    ok: true,
    value: {
      state: {
        ...nextState,
        updated_at: frozenAt,
        frozen_package_history: [
          ...nextState.frozen_package_history,
          {
            storyboard_package_id: imported.storyboard_package_id,
            report_path: reportPath,
            frozen_at: frozenAt
          }
        ]
      },
      report
    }
  };
}

function listGenerationRuns(db: M0Database): GenerationRun[] {
  const rows = db.prepare("SELECT data_json FROM generation_runs ORDER BY updated_at DESC").all() as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as GenerationRun);
}

function reviewStatusForArtifact(shotId: string, artifactId: string, db: M0Database): H3VideoReviewItem["clip_review_status"] {
  const shot = getShot(db, shotId);
  const version = shot?.clip_versions.find((candidate) => candidate.artifact_id === artifactId);
  return version?.review_status ?? "pending";
}

export function h3VideoReviewSummary(state = loadH1WorkbenchState(), db = openM0Database(), options: H3VideoReviewSummaryOptions = {}): H3VideoReviewSummary {
  const statusFilter =
    options.status === "pending" || options.status === "approved" || options.status === "rejected" ? options.status : "all";
  const shotFilter = typeof options.shot_id === "string" ? options.shot_id.trim() : "";
  const offset = Math.max(0, Math.floor(Number(options.offset ?? 0)));
  const requestedLimit = Math.floor(Number(options.limit ?? H3_REVIEW_CLIP_LIMIT));
  const limit = Math.min(H3_REVIEW_CLIP_MAX_LIMIT, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : H3_REVIEW_CLIP_LIMIT));
  let generated_clip_total_available = 0;
  let generated_clip_filtered_available = 0;
  const generated_clips: H3VideoReviewItem[] = [];
  const generated_clip_status_counts = {
    all: 0,
    pending: 0,
    approved: 0,
    rejected: 0
  };
  const shotCounts = new Map<string, number>();

  for (const run of listGenerationRuns(db)) {
    const artifactIds = Array.isArray(run.output?.artifact_ids) ? run.output.artifact_ids : [];
    for (const artifactId of artifactIds) {
      const artifact = getMediaArtifact(db, artifactId);
      if (!artifact || artifact.role !== "generated_clip" || artifact.artifact_type !== "video") continue;

      generated_clip_total_available += 1;
      const shot = getShot(db, run.shot_id);
      const clip_review_status = reviewStatusForArtifact(run.shot_id, artifact.artifact_id, db);
      generated_clip_status_counts.all += 1;
      generated_clip_status_counts[clip_review_status] += 1;
      shotCounts.set(run.shot_id, (shotCounts.get(run.shot_id) ?? 0) + 1);
      if (statusFilter !== "all" && clip_review_status !== statusFilter) continue;
      if (shotFilter && run.shot_id !== shotFilter) continue;

      const filteredIndex = generated_clip_filtered_available;
      generated_clip_filtered_available += 1;
      if (filteredIndex < offset || generated_clips.length >= limit) continue;

      generated_clips.push({
        shot_id: run.shot_id,
        run_id: run.run_id,
        run_status: run.status,
        run_type: run.run_type,
        provider_name: run.provider?.provider_name ?? "unknown",
        provider_job_id: run.provider?.provider_job_id ?? "",
        artifact_id: artifact.artifact_id,
        artifact_type: artifact.artifact_type,
        artifact_role: artifact.role,
        artifact_status: artifact.status,
        storage_filename: artifact.storage.filename,
        accepted_clip_artifact_id: shot?.accepted_clip_artifact_id ?? "",
        clip_review_status,
        ffprobe: validateMp4File(artifact.storage.uri),
        rejection_reasons: shot?.review.rejection_reasons ?? [],
        latest_revision_instruction: shot?.review.latest_revision_instruction ?? null
      });
    }
  }

  return {
    generated_clips,
    generated_clip_limit: limit,
    generated_clip_offset: offset,
    generated_clip_total_available,
    generated_clip_filtered_available,
    generated_clip_status_counts,
    generated_clip_shot_count_total: shotCounts.size,
    generated_clip_shot_counts: [...shotCounts.entries()]
      .map(([shot_id, count]) => ({ shot_id, count }))
      .sort((a, b) => b.count - a.count || a.shot_id.localeCompare(b.shot_id))
      .filter((item, index) => index < 200 || item.shot_id === shotFilter),
    generated_clip_filters: {
      status: statusFilter,
      shot_id: shotFilter
    },
    regeneration_request_drafts: state.regeneration_request_drafts,
    provider_boundary: H1_PROVIDER_BOUNDARY
  };
}

export function approveH3GeneratedClip(
  input: { shot_id: string; artifact_id: string; write_report?: boolean },
  db = openM0Database()
): H1MutationResult<{ shot_id: string; artifact_id: string; accepted_clip_artifact_id: string; report: unknown }> {
  const review = markShotClipReview({ shot_id: input.shot_id, artifact_id: input.artifact_id, decision: "approved" }, db);
  if (!review.ok) return review;

  const runId = randomUUID();
  const report = {
    task: "R2-3_H3_VIDEO_REVIEW_WORKBENCH",
    action: "approve_generated_clip",
    result: "PASS",
    run_id: runId,
    generated_at: now(),
    shot_id: input.shot_id,
    artifact_id: input.artifact_id,
    accepted_clip_artifact_id: review.shot.accepted_clip_artifact_id,
    provider_boundary: H1_PROVIDER_BOUNDARY,
    regeneration_request_draft_created: false,
    regeneration_performed: false,
    report_path: `data/reports/${H3_REVIEW_REPORT_STEM}_${runId}.json`,
    latest_report_path: H3_REVIEW_REPORT_LATEST
  };
  if (input.write_report !== false) writeJsonReport(H3_REVIEW_REPORT_STEM, runId, report, H3_REVIEW_REPORT_LATEST);

  return {
    ok: true,
    value: {
      shot_id: input.shot_id,
      artifact_id: input.artifact_id,
      accepted_clip_artifact_id: review.shot.accepted_clip_artifact_id,
      report
    }
  };
}

export function rejectH3GeneratedClip(
  state: H1WorkbenchState,
  input: {
    shot_id: string;
    artifact_id: string;
    rejection_reasons: string[];
    revision_instruction: RevisionInstruction;
    write_report?: boolean;
  },
  db = openM0Database()
): H1MutationResult<{ state: H1WorkbenchState; draft: H3RegenerationRequestDraft; report: unknown }> {
  const review = markShotClipReview(
    {
      shot_id: input.shot_id,
      artifact_id: input.artifact_id,
      decision: "revision_needed",
      rejection_reasons: input.rejection_reasons,
      revision_instruction: input.revision_instruction
    },
    db
  );
  if (!review.ok) return review;

  const clipVersion = review.shot.clip_versions.find((candidate) => candidate.artifact_id === input.artifact_id);
  const draft: H3RegenerationRequestDraft = {
    draft_id: `regen_draft_${randomUUID()}`,
    shot_id: input.shot_id,
    artifact_id: input.artifact_id,
    previous_run_id: clipVersion?.run_id ?? "",
    rejection_reasons: input.rejection_reasons,
    revision_instruction: input.revision_instruction,
    status: "draft",
    created_at: now()
  };
  const nextState = saveH1WorkbenchState({
    ...state,
    regeneration_request_drafts: [...state.regeneration_request_drafts, draft]
  });

  const runId = randomUUID();
  const report = {
    task: "R2-3_H3_VIDEO_REVIEW_WORKBENCH",
    action: "reject_generated_clip_create_regeneration_draft",
    result: "PASS",
    run_id: runId,
    generated_at: now(),
    shot_id: input.shot_id,
    artifact_id: input.artifact_id,
    rejection_reasons: input.rejection_reasons,
    draft,
    provider_boundary: H1_PROVIDER_BOUNDARY,
    regeneration_request_draft_created: true,
    regeneration_performed: false,
    report_path: `data/reports/${H3_REVIEW_REPORT_STEM}_${runId}.json`,
    latest_report_path: H3_REVIEW_REPORT_LATEST
  };
  if (input.write_report !== false) writeJsonReport(H3_REVIEW_REPORT_STEM, runId, report, H3_REVIEW_REPORT_LATEST);

  return { ok: true, value: { state: nextState, draft, report } };
}

function listProjects(db: M0Database): Project[] {
  const rows = db.prepare("SELECT data_json FROM projects ORDER BY updated_at DESC").all() as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as Project);
}

function inferH4Project(state: H1WorkbenchState, db: M0Database, explicitProjectId?: string): Project | null {
  const preferredProjectId = explicitProjectId || state.project.project_id;
  if (preferredProjectId) return getProject(db, preferredProjectId);
  return listProjects(db).find((project) => listProjectShots(db, project.project_id).length > 0) ?? null;
}

function finalVideoArtifactSummary(project: Project, db: M0Database): H4FinalVideoArtifactSummary | null {
  const artifactId = project.exports.final_video_artifact_id;
  if (!artifactId) return null;
  const artifact = getMediaArtifact(db, artifactId);
  return {
    artifact_id: artifactId,
    exists: Boolean(artifact),
    artifact_type: artifact?.artifact_type ?? "",
    role: artifact?.role ?? "",
    status: artifact?.status ?? "",
    storage_filename: artifact?.storage.filename ?? "",
    ffprobe: artifact ? validateMp4File(artifact.storage.uri) : null
  };
}

function assemblyClipPreviewForShot(shot: Shot, db: M0Database): H4AssemblyClipPreview {
  const blockers: string[] = [];
  if (!shot.accepted_clip_artifact_id) blockers.push("MISSING_ACCEPTED_CLIP");
  const artifact = shot.accepted_clip_artifact_id ? getMediaArtifact(db, shot.accepted_clip_artifact_id) : null;
  if (shot.accepted_clip_artifact_id && !artifact) blockers.push("ACCEPTED_CLIP_ARTIFACT_MISSING");
  if (artifact) {
    if (artifact.status !== "active") blockers.push(`ACCEPTED_CLIP_${artifact.status.toUpperCase()}`);
    if (artifact.artifact_type !== "video" || artifact.role !== "generated_clip") blockers.push("ACCEPTED_CLIP_NOT_GENERATED_VIDEO");
  }

  return {
    shot_id: shot.shot_id,
    order: shot.order,
    duration_seconds: shot.duration_seconds,
    accepted_clip_artifact_id: shot.accepted_clip_artifact_id,
    accepted_clip_status: artifact?.status ?? "",
    storage_filename: artifact?.storage.filename ?? "",
    ffprobe: artifact ? validateMp4File(artifact.storage.uri) : null,
    blockers
  };
}

export function h4FinalAssemblyWorkbenchSummary(
  state = loadH1WorkbenchState(),
  db = openM0Database(),
  input: { project_id?: string } = {}
): H4FinalAssemblyWorkbenchSummary {
  const project = inferH4Project(state, db, input.project_id);
  if (!project) {
    return {
      project_id: input.project_id ?? "",
      project_title: "",
      project_status: "",
      ready_for_assembly: false,
      blockers: ["PROJECT_NOT_FOUND"],
      required_shots: 0,
      accepted_clips: 0,
      clip_order_preview: [],
      final_video_artifact: null,
      latest_report_path: H4_FINAL_ASSEMBLY_REPORT_LATEST,
      latest_report_exists: existsSync(join(paths.workspaceRoot, H4_FINAL_ASSEMBLY_REPORT_LATEST)),
      provider_boundary: H1_PROVIDER_BOUNDARY,
      confirmation: {
        required: true,
        accepted_by_summary: false
      }
    };
  }

  const shots = listProjectShots(db, project.project_id);
  const clipOrderPreview = shots.map((shot) => assemblyClipPreviewForShot(shot, db));
  const blockers = clipOrderPreview.flatMap((item) => item.blockers.map((blocker) => `${item.shot_id}:${blocker}`));
  if (!shots.length) blockers.push("PROJECT_HAS_NO_SHOTS");

  return {
    project_id: project.project_id,
    project_title: project.title,
    project_status: project.status,
    ready_for_assembly: shots.length > 0 && blockers.length === 0,
    blockers,
    required_shots: shots.length,
    accepted_clips: clipOrderPreview.filter((item) => item.accepted_clip_artifact_id && item.blockers.length === 0).length,
    clip_order_preview: clipOrderPreview,
    final_video_artifact: finalVideoArtifactSummary(project, db),
    latest_report_path: H4_FINAL_ASSEMBLY_REPORT_LATEST,
    latest_report_exists: existsSync(join(paths.workspaceRoot, H4_FINAL_ASSEMBLY_REPORT_LATEST)),
    provider_boundary: H1_PROVIDER_BOUNDARY,
    confirmation: {
      required: true,
      accepted_by_summary: false
    }
  };
}

export function executeH4FinalAssembly(
  input: { project_id?: string; human_confirmation: boolean; write_report?: boolean },
  state = loadH1WorkbenchState(),
  db = openM0Database()
): H1MutationResult<{ summary: H4FinalAssemblyWorkbenchSummary; report: unknown; final_video_artifact_id: string }> {
  if (input.human_confirmation !== true) {
    return { ok: false, error: toolError("HUMAN_CONFIRMATION_REQUIRED", "Final assembly requires explicit human confirmation.") };
  }

  const project = inferH4Project(state, db, input.project_id);
  if (!project) return { ok: false, error: toolError("PROJECT_NOT_FOUND", "No project is available for final assembly.") };

  const before = h4FinalAssemblyWorkbenchSummary(state, db, { project_id: project.project_id });
  if (!before.ready_for_assembly) {
    return { ok: false, error: toolError("FINAL_ASSEMBLY_NOT_READY", before.blockers.join(", ")) };
  }

  const assembled = assembleFinalVideo(
    {
      project_id: project.project_id,
      confirmation: { confirmation_level: "explicit", user_confirmed: true }
    },
    db
  );
  if (!assembled.ok) {
    return {
      ok: false,
      error: toolError(assembled.error.code, [assembled.error.message, ...(assembled.blocking_reasons ?? [])].filter(Boolean).join(" "))
    };
  }

  const summaryAfterAssembly = h4FinalAssemblyWorkbenchSummary(state, db, { project_id: project.project_id });
  const runId = randomUUID();
  const report = {
    task: "R2-4_H4_FINAL_ASSEMBLY_WORKBENCH",
    action: "execute_final_assembly",
    result: "PASS",
    run_id: runId,
    generated_at: now(),
    project_id: project.project_id,
    readiness_before: before,
    final_assembly: {
      run_id: assembled.run.run_id,
      final_video_artifact_id: assembled.final_video_artifact_id,
      source_clip_artifact_ids: before.clip_order_preview.map((item) => item.accepted_clip_artifact_id),
      source_asset_overwritten: false
    },
    final_video_artifact: summaryAfterAssembly.final_video_artifact,
    provider_boundary: {
      ...H1_PROVIDER_BOUNDARY,
      final_assembly_performed: true
    },
    report_path: `data/reports/${H4_FINAL_ASSEMBLY_REPORT_STEM}_${runId}.json`,
    latest_report_path: H4_FINAL_ASSEMBLY_REPORT_LATEST
  };
  if (input.write_report !== false) writeJsonReport(H4_FINAL_ASSEMBLY_REPORT_STEM, runId, report, H4_FINAL_ASSEMBLY_REPORT_LATEST);
  const summary = input.write_report === false ? summaryAfterAssembly : h4FinalAssemblyWorkbenchSummary(state, db, { project_id: project.project_id });

  return { ok: true, value: { summary, report, final_video_artifact_id: assembled.final_video_artifact_id } };
}

function writeJsonReport(stem: string, runId: string, payload: unknown, latestRelativePath: string): string {
  ensureM0Directories();
  const immutablePath = join(paths.reportsRoot, `${stem}_${runId}.json`);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(immutablePath, text, "utf8");
  writeFileSync(join(paths.workspaceRoot, latestRelativePath), text, "utf8");
  return immutablePath;
}

export function listH1Reports(): Array<{ name: string; relative_path: string; size_bytes: number; updated_at: string; is_latest_pointer: boolean }> {
  ensureM0Directories();
  if (!existsSync(paths.reportsRoot)) return [];
  return readdirSync(paths.reportsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const target = join(paths.reportsRoot, entry.name);
      const stat = statSync(target);
      return {
        name: entry.name,
        relative_path: `data/reports/${entry.name}`,
        size_bytes: stat.size,
        updated_at: stat.mtime.toISOString(),
        is_latest_pointer: !/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i.test(entry.name)
      };
    });
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeBoolean(value: unknown): boolean {
  return value === true;
}

export function h2CanaryWorkbenchSummary(reportRelativePath = H2_RUNWAY_CANARY_DRY_RUN_REPORT): H2CanaryWorkbenchSummary {
  const reportPath = join(paths.workspaceRoot, reportRelativePath);
  const fallback: H2CanaryWorkbenchSummary = {
    report_path: reportRelativePath,
    report_exists: false,
    report_result: "MISSING_REPORT",
    active_provider: "",
    env_check_result: "UNKNOWN",
    provider_preflight_result: "UNKNOWN",
    credential_env_name: null,
    credential_present: false,
    selected_input: {
      path: "",
      source_type: "",
      width: 0,
      height: 0,
      aspect_ratio: "",
      runway_ratio: null,
      duration_seconds: 0,
      readable: false,
      usable_for_real_provider_canary: false
    },
    provider_boundary: {
      ...H1_PROVIDER_BOUNDARY,
      provider: "",
      model: "",
      endpoint: "",
      x_runway_version: "",
      max_submit_calls: 0,
      runway_ratio: "",
      direct_9_16_sent_to_runway: false,
      real_submit_available: false,
      real_submit_requires_separate_authorization: true
    },
    dry_run_plan: {
      command: "npm run runway:canary",
      can_open_latest_report: false,
      can_generate_from_workbench: false,
      regeneration_allowed: false,
      batch_generation_allowed: false,
      runninghub_allowed: false
    },
    authorization: {
      required_for_real_call: true,
      provided: false,
      accepted: false
    }
  };

  if (!existsSync(reportPath)) return fallback;

  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    const preflight = (report.preflight ?? {}) as Record<string, unknown>;
    const input = (report.selected_canary_input ?? {}) as Record<string, unknown>;
    const boundary = (report.provider_boundary ?? {}) as Record<string, unknown>;
    const authorization = (report.authorization ?? {}) as Record<string, unknown>;

    return {
      ...fallback,
      report_exists: true,
      report_result: safeString(report.result) || "UNKNOWN",
      active_provider: safeString(preflight.active_provider),
      env_check_result: safeString(preflight.env_check_result) || "UNKNOWN",
      provider_preflight_result: safeString(preflight.provider_preflight_result) || "UNKNOWN",
      credential_env_name: safeString(preflight.credential_env_name) || null,
      credential_present: safeBoolean(preflight.credential_present),
      selected_input: {
        path: safeString(input.path),
        source_type: safeString(input.source_type),
        width: safeNumber(input.width),
        height: safeNumber(input.height),
        aspect_ratio: safeString(input.aspect_ratio),
        runway_ratio: safeString(input.runway_ratio) || null,
        duration_seconds: safeNumber(input.duration_seconds),
        readable: safeBoolean(input.readable_by_image_validator),
        usable_for_real_provider_canary: safeBoolean(input.usable_for_real_provider_canary)
      },
      provider_boundary: {
        ...H1_PROVIDER_BOUNDARY,
        provider: safeString(boundary.provider),
        model: safeString(boundary.model),
        endpoint: safeString(boundary.endpoint),
        x_runway_version: safeString(boundary.x_runway_version),
        max_submit_calls: safeNumber(boundary.max_submit_calls),
        runway_ratio: safeString(boundary.runway_ratio),
        direct_9_16_sent_to_runway: safeBoolean(boundary.direct_9_16_sent_to_runway),
        real_submit_available: false,
        real_submit_requires_separate_authorization: true
      },
      dry_run_plan: {
        ...fallback.dry_run_plan,
        command: safeString(report.command) || fallback.dry_run_plan.command,
        can_open_latest_report: true,
        regeneration_allowed: false,
        batch_generation_allowed: false,
        runninghub_allowed: false
      },
      authorization: {
        required_for_real_call: true,
        provided: safeBoolean(authorization.provided),
        accepted: safeBoolean(authorization.accepted)
      }
    };
  } catch {
    return {
      ...fallback,
      report_exists: true,
      report_result: "UNREADABLE_REPORT"
    };
  }
}

export function h1DashboardSummary(state = loadH1WorkbenchState(), db = openM0Database()) {
  const imports = scanH1Imports(db);
  const shotBlockers = state.shots.flatMap((shot) => h1ShotBlockers(shot, db));
  return {
    project_title: state.project.title,
    project_id: state.project.project_id || "",
    shots_total: state.shots.length,
    shots_approved: state.shots.filter((shot) => shot.approval_status === "approved").length,
    imports_total: imports.length,
    imports_ready: imports.filter((item) => item.blockers.length === 0).length,
    blockers_total: shotBlockers.length,
    reports_total: listH1Reports().length,
    provider_boundary: H1_PROVIDER_BOUNDARY
  };
}
