import { createHash } from "node:crypto";

import {
  deriveShotOperationalState,
  type ArtifactOperationalFact,
  type ShotOperationalState
} from "../packages/domain/operationalState.js";
import { paths } from "../paths.js";
import { type M0Database } from "../storage/sqlite.js";
import { collectProjectOperationalBundle } from "./operationalStateFacts.js";
import {
  getMediaArtifact,
  getMediaBlob,
  type MediaArtifact,
  type MediaBlob
} from "./mediaArtifacts.js";
import { getProject, getShot, listProjectShots, type Project, type Shot } from "./projects.js";
import { buildProviderCapabilityKey } from "./providerCapabilities.js";
import { RUNNINGHUB_MODEL_ROUTE } from "./videoProviderAdapters.js";
import { getStoryboardPackage, type StoryboardPackage } from "./storyboardPackages.js";
import {
  admissionCandidateKey,
  classifyAdmissionAuthoritySlice,
  packageSnapshotCollectionCoversProject,
  parseCanonicalClipVersion,
  type T2AdmissionCandidateHistory,
  type T2AdmissionCandidateIdentity
} from "./s3bT2Normalize.js";
import { collectT2GovernedMediaEvidence } from "./s3bT2MediaEvidence.js";
import type {
  GenerationAdmissionArtifactFacts,
  GenerationAdmissionFacts,
  GenerationAdmissionMediaFacts,
  GenerationAdmissionPackageFacts,
  GenerationAdmissionPackageSnapshot,
  GenerationAdmissionProviderFacts,
  GenerationAdmissionStateFacts,
  GenerationAdmissionProjectFacts,
  GenerationAdmissionShotFacts,
  T2DatabaseRow,
  T2NormalizedArtifact,
  T2NormalizedBlob,
  T2NormalizedShot,
  T2NormalizedSnapshot
} from "./s3bT2Types.js";

export type AdmissionFactsReadResult =
  | { ok: true; facts: GenerationAdmissionFacts }
  | { ok: false; error: { code: string; message: string } };

export type AdmissionCandidateSetInput = {
  project_id?: string;
  shot_id?: string;
};

type GenerationAdmissionFactsReadOptions = {
  verify_media?: boolean;
  execution_projection?: {
    intent_id: string;
    run_id: string;
    project_status: Project["status"];
    shot_status: Shot["status"];
  };
};

export type AdmissionCandidateFactsReadResult =
  | { ok: true; candidates: readonly T2AdmissionCandidateIdentity[]; facts: readonly GenerationAdmissionFacts[] }
  | { ok: false; error: { code: string; message: string } };

const RUN_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
const JOB_STATES = new Set(["queued", "submitting", "polling", "downloading", "finalizing", "manual_reconciliation", "succeeded", "failed", "cancelled"]);

type CandidateAuthorityRows = {
  projects: T2DatabaseRow[];
  shots: T2DatabaseRow[];
  candidates: T2AdmissionCandidateIdentity[];
  required_project_ids: string[];
  required_shot_ids: string[];
};

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function rowsForProjectIds(db: M0Database, projectIds: readonly string[]): T2DatabaseRow[] {
  if (projectIds.length === 0) return [];
  const placeholders = projectIds.map(() => "?").join(", ");
  return db.prepare(`SELECT project_id, data_json FROM projects WHERE project_id IN (${placeholders}) ORDER BY project_id`)
    .all(...projectIds) as T2DatabaseRow[];
}

function readCandidateAuthorityRows(db: M0Database, input: AdmissionCandidateSetInput): CandidateAuthorityRows {
  if (input.project_id && input.shot_id) {
    const projectShots = db.prepare("SELECT shot_id, project_id, data_json FROM shots WHERE project_id = ? ORDER BY shot_id")
      .all(input.project_id) as T2DatabaseRow[];
    const selected = db.prepare("SELECT shot_id, project_id, data_json FROM shots WHERE shot_id = ?").get(input.shot_id) as T2DatabaseRow | undefined;
    const shots = selected && !projectShots.some((row) => row.shot_id === selected.shot_id) ? [...projectShots, selected] : projectShots;
    return {
      projects: rowsForProjectIds(db, [input.project_id]),
      shots,
      candidates: [{ project_id: input.project_id, shot_id: input.shot_id }],
      required_project_ids: [input.project_id],
      required_shot_ids: [input.shot_id]
    };
  }

  if (input.project_id) {
    const shots = db.prepare("SELECT shot_id, project_id, data_json FROM shots WHERE project_id = ? ORDER BY shot_id")
      .all(input.project_id) as T2DatabaseRow[];
    return {
      projects: rowsForProjectIds(db, [input.project_id]),
      shots,
      candidates: shots.map((row) => ({ project_id: input.project_id as string, shot_id: typeof row.shot_id === "string" ? row.shot_id : "" }))
        .filter((candidate) => candidate.shot_id.length > 0),
      required_project_ids: [input.project_id],
      required_shot_ids: shots.map((row) => typeof row.shot_id === "string" ? row.shot_id : "").filter(Boolean)
    };
  }

  if (input.shot_id) {
    const selected = db.prepare("SELECT shot_id, project_id, data_json FROM shots WHERE shot_id = ?").get(input.shot_id) as T2DatabaseRow | undefined;
    const projectId = typeof selected?.project_id === "string" ? selected.project_id : "";
    const projectShots = projectId
      ? db.prepare("SELECT shot_id, project_id, data_json FROM shots WHERE project_id = ? ORDER BY shot_id").all(projectId) as T2DatabaseRow[]
      : [];
    const shots = selected && !projectShots.some((row) => row.shot_id === selected.shot_id) ? [...projectShots, selected] : projectShots;
    return {
      projects: rowsForProjectIds(db, projectId ? [projectId] : []),
      shots,
      candidates: projectId ? [{ project_id: projectId, shot_id: input.shot_id }] : [],
      required_project_ids: projectId ? [projectId] : [],
      required_shot_ids: [input.shot_id]
    };
  }

  const shots = db.prepare("SELECT shot_id, project_id, data_json FROM shots ORDER BY project_id, shot_id").all() as T2DatabaseRow[];
  const candidates = shots.map((row) => ({
    project_id: typeof row.project_id === "string" ? row.project_id : "",
    shot_id: typeof row.shot_id === "string" ? row.shot_id : ""
  })).filter((candidate) => candidate.project_id.length > 0 && candidate.shot_id.length > 0);
  const projectIds = uniqueStrings(candidates.map((candidate) => candidate.project_id));
  return {
    projects: rowsForProjectIds(db, projectIds),
    shots,
    candidates,
    required_project_ids: projectIds,
    required_shot_ids: uniqueStrings(candidates.map((candidate) => candidate.shot_id))
  };
}

function readSelectedHistoryRows(
  db: M0Database,
  candidates: readonly T2AdmissionCandidateIdentity[]
): { jobs: T2DatabaseRow[]; runs: T2DatabaseRow[] } {
  if (candidates.length === 0) return { jobs: [], runs: [] };
  const projectIds = uniqueStrings(candidates.map((candidate) => candidate.project_id));
  const shotIds = uniqueStrings(candidates.map((candidate) => candidate.shot_id));
  const projectPlaceholders = projectIds.map(() => "?").join(", ");
  const shotPlaceholders = shotIds.map(() => "?").join(", ");
  const jobs = db.prepare(`SELECT
      'job' AS history_kind,
      job.job_id AS history_id,
      job.state AS history_state,
      job.created_at AS history_created_at,
      job.updated_at AS history_updated_at,
      job.rowid AS history_rowid,
      intent.intent_id AS authority_parent_id,
      intent.project_id AS history_project_id,
      intent.shot_id AS history_shot_id,
      project.project_id AS authority_project_id,
      project.data_json AS authority_project_data_json,
      shot.shot_id AS authority_shot_id,
      shot.project_id AS authority_shot_project_id,
      shot.data_json AS authority_shot_data_json
    FROM generation_jobs job
    LEFT JOIN generation_intents intent ON intent.intent_id = job.intent_id
    LEFT JOIN projects project ON project.project_id = intent.project_id
    LEFT JOIN shots shot ON shot.shot_id = intent.shot_id
    WHERE intent.intent_id IS NULL
      OR project.project_id IS NULL
      OR shot.shot_id IS NULL
      OR shot.project_id IS NOT intent.project_id
      OR CASE
        WHEN json_valid(project.data_json) <> 1 THEN 1
        WHEN json_extract(project.data_json, '$.project_id') IS NOT project.project_id THEN 1
        ELSE 0
      END = 1
      OR CASE
        WHEN json_valid(shot.data_json) <> 1 THEN 1
        WHEN json_extract(shot.data_json, '$.shot_id') IS NOT shot.shot_id THEN 1
        WHEN json_extract(shot.data_json, '$.project_id') IS NOT shot.project_id THEN 1
        ELSE 0
      END = 1
      OR intent.project_id IN (${projectPlaceholders})
      OR intent.shot_id IN (${shotPlaceholders})
    ORDER BY job.updated_at, job.created_at, job.rowid`).all(...projectIds, ...shotIds) as T2DatabaseRow[];

  const runs = db.prepare(`SELECT
      'run' AS history_kind,
      run.run_id AS history_id,
      run.status AS history_state,
      run.run_type AS history_run_type,
      run.created_at AS history_created_at,
      run.updated_at AS history_updated_at,
      run.rowid AS history_rowid,
      run.project_id AS history_project_id,
      run.shot_id AS history_shot_id,
      project.project_id AS authority_project_id,
      project.data_json AS authority_project_data_json,
      shot.shot_id AS authority_shot_id,
      shot.project_id AS authority_shot_project_id,
      shot.data_json AS authority_shot_data_json
    FROM generation_runs run
    LEFT JOIN projects project ON project.project_id = run.project_id
    LEFT JOIN shots shot ON shot.shot_id = run.shot_id
    WHERE NOT (run.run_type = 'assemble_video' AND COALESCE(run.shot_id, '') = '')
      AND (run.project_id IN (${projectPlaceholders}) OR run.shot_id IN (${shotPlaceholders}))
    ORDER BY run.updated_at, run.created_at, run.rowid`).all(...projectIds, ...shotIds) as T2DatabaseRow[];
  return { jobs, runs };
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0`).update(JSON.stringify(value)).digest("hex");
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function negativePrompt(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : null;
}

function projectFacts(db: M0Database, project: Project): GenerationAdmissionProjectFacts {
  const meta = db.prepare("SELECT classification, lifecycle FROM workbench_project_meta WHERE project_id = ?")
    .get(project.project_id) as { classification?: unknown; lifecycle?: unknown } | undefined;
  return {
    project_id: project.project_id,
    status: project.status,
    classification: stringOrEmpty(meta?.classification),
    lifecycle: stringOrEmpty(meta?.lifecycle),
    active_storyboard_package_id: project.active_storyboard_package_id,
    final_video_artifact_id: project.exports.final_video_artifact_id,
    video_spec: {
      duration_seconds: project.video_spec.duration_seconds,
      aspect_ratio: project.video_spec.aspect_ratio,
      resolution: project.video_spec.resolution
    }
  };
}

function canonicalClipVersions(shot: Shot): Shot["clip_versions"] {
  const parsed = shot.clip_versions.map((version) => parseCanonicalClipVersion(version));
  if (parsed.some((version) => !version.success)) throw new Error("SHOT_OPERATIONAL_FACT_INVALID");
  return parsed.map((version) => version.data) as Shot["clip_versions"];
}

function admissionArtifactOperationalFact(
  db: M0Database,
  shot: Shot,
  artifactId: string,
  expectedRole: "storyboard_image" | "generated_clip",
  expectedType: "image" | "video"
): ArtifactOperationalFact {
  if (!artifactId) return { artifact_id: null, status: "missing", verification_level: "none" };
  const artifact = getMediaArtifact(db, artifactId);
  if (!artifact) return { artifact_id: artifactId, status: "integrity_invalid", verification_level: "none" };
  if (artifact.linked_objects.project_id !== shot.project_id || artifact.linked_objects.shot_id !== shot.shot_id) {
    return { artifact_id: artifactId, status: "binding_invalid", verification_level: "none" };
  }
  if (artifact.role !== expectedRole || artifact.artifact_type !== expectedType) {
    return { artifact_id: artifactId, status: "role_invalid", verification_level: "none" };
  }
  if (artifact.status !== "active") return { artifact_id: artifactId, status: "inactive", verification_level: "none" };
  const blob = artifact.blob_id ? getMediaBlob(db, artifact.blob_id) : null;
  if (!blob || blob.integrity_state !== "verified") {
    return { artifact_id: artifactId, status: "integrity_invalid", verification_level: "none" };
  }
  return { artifact_id: artifactId, status: "active", verification_level: "ledger_verified" };
}

function admissionOperationalState(
  db: M0Database,
  shot: Shot,
  generation: GenerationAdmissionStateFacts
): ShotOperationalState {
  const clipVersions = canonicalClipVersions(shot);
  const latest = [...clipVersions].sort((left, right) => right.attempt_number - left.attempt_number)[0];
  const accepted = clipVersions.find((version) => version.artifact_id === shot.accepted_clip_artifact_id);
  return deriveShotOperationalState({
    shot_id: shot.shot_id,
    project_id: shot.project_id,
    stored_workflow_status: shot.status,
    duration_seconds: shot.duration_seconds,
    video_prompt_present: shot.video_prompt.trim().length > 0,
    storyboard_artifact: admissionArtifactOperationalFact(db, shot, shot.storyboard_image_artifact_id, "storyboard_image", "image"),
    accepted_clip_artifact: admissionArtifactOperationalFact(db, shot, shot.accepted_clip_artifact_id, "generated_clip", "video"),
    latest_version_artifact: admissionArtifactOperationalFact(db, shot, latest?.artifact_id ?? "", "generated_clip", "video"),
    generation_version_count: clipVersions.length,
    accepted_clip_in_version_stack: Boolean(shot.accepted_clip_artifact_id && accepted),
    accepted_clip_review_status: accepted?.review_status ?? null,
    review_approval_status: shot.review.approval_status,
    latest_version_review_status: latest?.review_status ?? null,
    generation_job_state: generation.latest_job_state,
    latest_generation_run_status: generation.latest_run_status
  });
}

function shotFacts(shot: Shot, state: ShotOperationalState | undefined): GenerationAdmissionShotFacts {
  const clipVersions = canonicalClipVersions(shot);
  return {
    shot_id: shot.shot_id,
    project_id: shot.project_id,
    order: shot.order,
    status: shot.status,
    duration_seconds: shot.duration_seconds,
    storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
    video_prompt: shot.video_prompt,
    negative_prompt: shot.negative_prompt,
    generation_run_ids: [...shot.generation_run_ids],
    clip_versions: clipVersions.map((version) => ({ ...version })),
    review_approval_status: shot.review.approval_status,
    operational_stage: state?.generation.stage ?? "state_inconsistent",
    operational_reason_codes: state?.generation.reason_codes ?? ["SHOT_STATE_INCONSISTENT"],
    prepare_generation_allowed: state?.allowed_workflow_actions.prepare_generation === true
  };
}

function snapshotFromUnknown(value: unknown): GenerationAdmissionPackageSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const negative = negativePrompt(record.negative_prompt);
  if (!Number.isFinite(record.order)
    || !Number.isFinite(record.duration_seconds)
    || typeof record.storyboard_image_artifact_id !== "string"
    || typeof record.video_prompt !== "string"
    || negative === null) return null;
  const shotId = record.shot_id;
  if (shotId !== undefined && (typeof shotId !== "string" || shotId.length === 0)) return null;
  return {
    ...(typeof shotId === "string" ? { shot_id: shotId } : {}),
    order: Number(record.order),
    duration_seconds: Number(record.duration_seconds),
    storyboard_image_artifact_id: record.storyboard_image_artifact_id,
    video_prompt: record.video_prompt,
    negative_prompt: negative
  };
}

function packageFacts(
  project: Project,
  shot: Shot,
  storyboardPackage: StoryboardPackage | null,
  projectShots: readonly Pick<Shot, "shot_id" | "order">[]
): GenerationAdmissionPackageFacts {
  if (!storyboardPackage) {
    return {
      storyboard_package_id: "",
      project_id: "",
      status: "",
      storyboard_approved: false,
      snapshot_count: 0,
      project_shot_count: projectShots.length,
      snapshot_collection_complete: false,
      snapshot_ambiguous: false,
      selected_snapshot: null,
      match_mode: null
    };
  }

  const rawSnapshots = Array.isArray(storyboardPackage.approved_shot_snapshots)
    ? storyboardPackage.approved_shot_snapshots as unknown[]
    : [];
  const snapshots = rawSnapshots.map(snapshotFromUnknown);
  const malformed = snapshots.some((snapshot) => snapshot === null);
  const normalized = snapshots.filter((snapshot): snapshot is GenerationAdmissionPackageSnapshot => snapshot !== null);
  const withShotId = normalized.filter((snapshot) => snapshot.shot_id !== undefined);
  const explicitMatches = withShotId.filter((snapshot) => snapshot.shot_id === shot.shot_id);
  const orderMatches = normalized.filter((snapshot) => snapshot.order === shot.order);
  const useExplicit = withShotId.length > 0;
  const matches = useExplicit ? explicitMatches : orderMatches;
  const snapshotCollectionComplete = !malformed && packageSnapshotCollectionCoversProject(normalized, projectShots);
  const snapshotAmbiguous = !snapshotCollectionComplete
    || malformed
    || matches.length !== 1
    || (!useExplicit && orderMatches.length > 1)
    || (useExplicit && withShotId.filter((snapshot) => snapshot.shot_id === shot.shot_id).length > 1);

  return {
    storyboard_package_id: stringOrEmpty((storyboardPackage as unknown as Record<string, unknown>).storyboard_package_id),
    project_id: stringOrEmpty((storyboardPackage as unknown as Record<string, unknown>).project_id),
    status: stringOrEmpty((storyboardPackage as unknown as Record<string, unknown>).status),
    storyboard_approved: Boolean((storyboardPackage as unknown as Record<string, unknown>).user_approval
      && typeof (storyboardPackage as unknown as Record<string, unknown>).user_approval === "object"
      && ((storyboardPackage as unknown as Record<string, unknown>).user_approval as Record<string, unknown>).storyboard_approved === true),
    snapshot_count: rawSnapshots.length,
    project_shot_count: projectShots.length,
    snapshot_collection_complete: snapshotCollectionComplete,
    snapshot_ambiguous: snapshotAmbiguous,
    selected_snapshot: snapshotAmbiguous ? null : matches[0],
    match_mode: snapshotAmbiguous ? null : (useExplicit ? "shot_id" : "order")
  };
}

function artifactFacts(artifact: MediaArtifact | null, blob: MediaBlob | null): GenerationAdmissionArtifactFacts | null {
  if (!artifact) return null;
  return {
    artifact_id: artifact.artifact_id,
    project_id: artifact.linked_objects.project_id,
    shot_id: artifact.linked_objects.shot_id,
    role: artifact.role,
    artifact_type: artifact.artifact_type,
    status: artifact.status,
    blob_id: artifact.blob_id,
    storage_uri: artifact.storage.uri,
    mime_type: artifact.storage.mime_type,
    artifact_sha256: artifact.metadata.sha256,
    source_sha256: artifact.source.sha256,
    blob_sha256: blob?.sha256 ?? "",
    blob_size_bytes: blob?.size_bytes ?? 0,
    blob_detected_mime: blob?.detected_mime ?? "",
    blob_integrity_state: blob?.integrity_state ?? ""
  };
}

function logicalMediaFacts(artifact: MediaArtifact | null, blob: MediaBlob | null): GenerationAdmissionMediaFacts {
  const logical = artifactFacts(artifact, blob);
  const logicallyValid = Boolean(logical
    && logical.artifact_id
    && logical.blob_id
    && logical.status === "active"
    && logical.role === "storyboard_image"
    && logical.artifact_type === "image"
    && logical.blob_integrity_state === "verified"
    && logical.blob_detected_mime.length > 0
    && logical.blob_sha256.length > 0
    && logical.artifact_sha256 === logical.blob_sha256
    && logical.source_sha256 === logical.blob_sha256);
  return logicallyValid
    ? {
      status: "NOT_CHECKED",
      verification_level: "none",
      artifact: logical,
      media_verification_token: "",
      fingerprint_digest: "",
      raw_sha256: logical?.blob_sha256 ?? "",
      size_bytes: logical?.blob_size_bytes ?? 0,
      detected_mime: logical?.blob_detected_mime ?? ""
    }
    : {
      status: "INVALID",
      verification_level: "none",
      artifact: logical,
      media_verification_token: "",
      fingerprint_digest: digest("t2-admission-invalid-media-v1", { artifact_id: logical?.artifact_id ?? "", blob_id: logical?.blob_id ?? "" }),
      raw_sha256: logical?.blob_sha256 ?? "",
      size_bytes: logical?.blob_size_bytes ?? 0,
      detected_mime: logical?.blob_detected_mime ?? "",
      failure_class: "MEDIA_LOGICAL_BINDING_INVALID"
    };
}

function normalizedMediaSnapshot(shot: Shot, artifact: MediaArtifact, blob: MediaBlob): T2NormalizedSnapshot {
  const normalizedArtifact: T2NormalizedArtifact = {
    artifact_id: artifact.artifact_id,
    project_id: artifact.linked_objects.project_id,
    shot_id: artifact.linked_objects.shot_id,
    blob_id: artifact.blob_id,
    artifact_type: artifact.artifact_type,
    role: artifact.role,
    status: artifact.status,
    storage: { uri: artifact.storage.uri, mime_type: artifact.storage.mime_type, filename: artifact.storage.filename },
    metadata: { sha256: artifact.metadata.sha256 },
    linked_objects: { project_id: artifact.linked_objects.project_id, shot_id: artifact.linked_objects.shot_id },
    source: { sha256: artifact.source.sha256 }
  };
  const mediaRoot = typeof blob.provenance.media_root === "string" ? blob.provenance.media_root : paths.mediaRoot;
  const normalizedBlob: T2NormalizedBlob = {
    blob_id: blob.blob_id,
    sha256: blob.sha256,
    size_bytes: blob.size_bytes,
    detected_mime: blob.detected_mime,
    storage_uri: blob.storage_uri,
    integrity_state: blob.integrity_state,
    media_root: mediaRoot
  };
  const normalizedShot = {
    shot_id: shot.shot_id,
    project_id: shot.project_id,
    order: shot.order,
    status: shot.status,
    duration_seconds: shot.duration_seconds,
    storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
    video_prompt: shot.video_prompt,
    negative_prompt: shot.negative_prompt,
    generation_run_ids: shot.generation_run_ids,
    accepted_clip_artifact_id: shot.accepted_clip_artifact_id,
    clip_versions: shot.clip_versions,
    review: shot.review
  } as T2NormalizedShot;
  return {
    database: { identity_digest: "", total_changes_before: 0, total_changes_after: 0, active_intent_count: 0, query_only: 1, schema_current: true },
    projects: new Map(),
    project_meta: new Map(),
    shots: new Map([[shot.shot_id, normalizedShot]]),
    packages: new Map(),
    artifacts: new Map([[artifact.artifact_id, normalizedArtifact]]),
    blobs: new Map([[blob.blob_id, normalizedBlob]]),
    artifact_blob_links: new Map([[artifact.artifact_id, blob.blob_id]]),
    generation: new Map(),
    normalization_issues: [],
    rowsets: {} as never,
    database_evidence_digest: ""
  };
}

function verifyMedia(
  shot: Shot,
  artifact: MediaArtifact | null,
  blob: MediaBlob | null,
  logical: GenerationAdmissionMediaFacts
): GenerationAdmissionMediaFacts {
  if (!artifact || !blob || logical.status === "INVALID") return logical;
  try {
    const bundle = collectT2GovernedMediaEvidence({
      snapshot: normalizedMediaSnapshot(shot, artifact, blob),
      mediaRoot: typeof blob.provenance.media_root === "string" ? blob.provenance.media_root : paths.mediaRoot
    });
    const evidence = bundle.referenced.get(artifact.artifact_id);
    if (!evidence || evidence.status !== "VALID") {
      return {
        ...logical,
        status: "INVALID",
        failure_class: evidence && evidence.status === "INVALID" ? evidence.failure_class : "MEDIA_VERIFICATION_UNAVAILABLE",
        fingerprint_digest: evidence?.fingerprint_digest ?? logical.fingerprint_digest
      };
    }
    return {
      status: "VALID",
      verification_level: "bytes_verified",
      artifact: logical.artifact,
      media_verification_token: "",
      fingerprint_digest: evidence.fingerprint_digest,
      raw_sha256: evidence.raw_sha256 ?? blob.sha256,
      size_bytes: evidence.size_bytes ?? blob.size_bytes,
      detected_mime: evidence.detected_mime ?? blob.detected_mime
    };
  } catch {
    return { ...logical, status: "INVALID", failure_class: "MEDIA_VERIFICATION_UNAVAILABLE" };
  }
}

function generationFacts(
  db: M0Database,
  projectId: string,
  shotId: string,
  executionProjection?: NonNullable<GenerationAdmissionFactsReadOptions["execution_projection"]>
): GenerationAdmissionStateFacts {
  const active = executionProjection
    ? db.prepare("SELECT COUNT(*) AS count FROM generation_intents WHERE status IN ('queued', 'running') AND intent_id <> ?")
      .get(executionProjection.intent_id) as { count: number | bigint }
    : db.prepare("SELECT COUNT(*) AS count FROM generation_intents WHERE status IN ('queued', 'running')")
      .get() as { count: number | bigint };
  const runs = executionProjection
    ? db.prepare(`SELECT status FROM generation_runs
        WHERE project_id = ? AND shot_id = ? AND run_id <> ? ORDER BY updated_at DESC, rowid DESC`)
      .all(projectId, shotId, executionProjection.run_id) as Array<{ status: string }>
    : db.prepare(`SELECT status FROM generation_runs
        WHERE project_id = ? AND shot_id = ? ORDER BY updated_at DESC, rowid DESC`)
      .all(projectId, shotId) as Array<{ status: string }>;
  const jobs = executionProjection
    ? db.prepare(`SELECT job.state FROM generation_jobs job
        JOIN generation_intents intent ON intent.intent_id = job.intent_id
        WHERE intent.project_id = ? AND intent.shot_id = ? AND intent.intent_id <> ?
        ORDER BY job.updated_at DESC, job.created_at DESC, job.rowid DESC`)
      .all(projectId, shotId, executionProjection.intent_id) as Array<{ state: string }>
    : db.prepare(`SELECT job.state FROM generation_jobs job
        JOIN generation_intents intent ON intent.intent_id = job.intent_id
        WHERE intent.project_id = ? AND intent.shot_id = ?
        ORDER BY job.updated_at DESC, job.created_at DESC, job.rowid DESC`)
      .all(projectId, shotId) as Array<{ state: string }>;
  const malformedRun = runs.some((row) => !RUN_STATUSES.has(row.status));
  const malformedJob = jobs.some((row) => !JOB_STATES.has(row.state));
  return {
    active_intent_count: Number(active.count),
    selected_has_any_job_or_run: runs.length > 0 || jobs.length > 0,
    latest_run_status: RUN_STATUSES.has(runs[0]?.status ?? "") ? runs[0].status as GenerationAdmissionStateFacts["latest_run_status"] : null,
    latest_job_state: JOB_STATES.has(jobs[0]?.state ?? "") ? jobs[0].state as GenerationAdmissionStateFacts["latest_job_state"] : null,
    malformed_history: malformedRun || malformedJob
  };
}

function newestHistoryFirst(left: T2DatabaseRow, right: T2DatabaseRow): number {
  const leftTime = String(left.history_updated_at ?? left.history_created_at ?? "");
  const rightTime = String(right.history_updated_at ?? right.history_created_at ?? "");
  if (leftTime !== rightTime) return rightTime.localeCompare(leftTime);
  return Number(right.history_rowid ?? 0) - Number(left.history_rowid ?? 0);
}

function generationFactsFromHistory(
  activeIntentCount: number,
  history: T2AdmissionCandidateHistory
): GenerationAdmissionStateFacts {
  const runs = [...history.runs].sort(newestHistoryFirst);
  const jobs = [...history.jobs].sort(newestHistoryFirst);
  const runStatus = typeof runs[0]?.history_state === "string" ? runs[0].history_state : "";
  const jobState = typeof jobs[0]?.history_state === "string" ? jobs[0].history_state : "";
  return {
    active_intent_count: activeIntentCount,
    selected_has_any_job_or_run: runs.length > 0 || jobs.length > 0,
    latest_run_status: RUN_STATUSES.has(runStatus) ? runStatus as GenerationAdmissionStateFacts["latest_run_status"] : null,
    latest_job_state: JOB_STATES.has(jobState) ? jobState as GenerationAdmissionStateFacts["latest_job_state"] : null,
    malformed_history: runs.some((row) => !RUN_STATUSES.has(String(row.history_state ?? "")))
      || jobs.some((row) => !JOB_STATES.has(String(row.history_state ?? "")))
  };
}

function providerFacts(project: Project, shot: Shot): GenerationAdmissionProviderFacts {
  const capability = buildProviderCapabilityKey({
    provider: "runninghub",
    model: RUNNINGHUB_MODEL_ROUTE,
    duration_seconds: shot.duration_seconds,
    resolution: project.video_spec.resolution,
    aspect_ratio: project.video_spec.aspect_ratio
  });
  if (!capability.ok) {
    return {
      ok: false,
      provider_name: "runninghub",
      model: RUNNINGHUB_MODEL_ROUTE,
      capability_key: "",
      capability_id: "",
      registry_version: "provider-capabilities-v1",
      duration_seconds: shot.duration_seconds,
      resolution: project.video_spec.resolution,
      aspect_ratio: project.video_spec.aspect_ratio,
      error_code: capability.code
    };
  }
  return {
    ok: true,
    provider_name: capability.key.provider,
    model: capability.key.model,
    capability_key: capability.key.serialized,
    capability_id: capability.key.capability_id,
    registry_version: capability.key.registry_version,
    duration_seconds: capability.key.duration_seconds,
    resolution: capability.key.resolution,
    aspect_ratio: capability.key.aspect_ratio
  };
}

function buildGenerationAdmissionFacts(
  db: M0Database,
  projectId: string,
  shotId: string,
  options: GenerationAdmissionFactsReadOptions,
  trustedGeneration?: GenerationAdmissionStateFacts
): AdmissionFactsReadResult {
  const storedProject = getProject(db, projectId);
  if (!storedProject) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: "Project was not found." } };
  const storedShot = getShot(db, shotId);
  if (!storedShot || storedShot.project_id !== storedProject.project_id) {
    return { ok: false, error: { code: "SHOT_NOT_FOUND", message: "SHOT was not found in the selected project." } };
  }
  const project = options.execution_projection
    ? { ...storedProject, status: options.execution_projection.project_status }
    : storedProject;
  const shot = options.execution_projection
    ? {
      ...storedShot,
      status: options.execution_projection.shot_status,
      generation_run_ids: storedShot.generation_run_ids.filter((runId) => runId !== options.execution_projection?.run_id)
    }
    : storedShot;
  const projectShots = listProjectShots(db, project.project_id);
  const generation = trustedGeneration
    ?? generationFacts(db, project.project_id, shot.shot_id, options.execution_projection);
  const operational = trustedGeneration || options.execution_projection
    ? admissionOperationalState(db, shot, generation)
    : collectProjectOperationalBundle(db, project).states_by_shot_id.get(shot.shot_id);
  const packageValue = project.active_storyboard_package_id
    ? getStoryboardPackage(db, project.active_storyboard_package_id)
    : null;
  const artifact = shot.storyboard_image_artifact_id ? getMediaArtifact(db, shot.storyboard_image_artifact_id) : null;
  const blob = artifact?.blob_id ? getMediaBlob(db, artifact.blob_id) : null;
  const logicalMedia = logicalMediaFacts(artifact, blob);
  const media = options.verify_media === false ? logicalMedia : verifyMedia(shot, artifact, blob, logicalMedia);
  return {
    ok: true,
    facts: {
      project: projectFacts(db, project),
      shot: shotFacts(shot, operational),
      package: packageFacts(project, shot, packageValue, projectShots),
      media,
      generation,
      provider: providerFacts(project, shot)
    }
  };
}

export function readGenerationAdmissionFacts(
  db: M0Database,
  projectId: string,
  shotId: string,
  options: GenerationAdmissionFactsReadOptions = {}
): AdmissionFactsReadResult {
  try {
    return buildGenerationAdmissionFacts(db, projectId, shotId, options);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "GENERATION_ADMISSION_FACTS_UNAVAILABLE";
    return { ok: false, error: { code, message: "Generation admission facts could not be read from the current authority." } };
  }
}

/** Admission-only read. Validation, history classification, and fact construction share one snapshot. */
export function readGenerationAdmissionCandidateFacts(
  db: M0Database,
  input: AdmissionCandidateSetInput,
  options: { verify_media?: boolean } = {}
): AdmissionCandidateFactsReadResult {
  let result: AdmissionCandidateFactsReadResult = {
    ok: false,
    error: { code: "GENERATION_ADMISSION_FACTS_UNAVAILABLE", message: "Generation admission facts could not be read from the current authority." }
  };
  let snapshotStarted = false;
  try {
    db.exec("SAVEPOINT t2_selected_admission_authority");
    snapshotStarted = true;
    const candidateAuthority = readCandidateAuthorityRows(db, input);
    if (candidateAuthority.candidates.length === 0
      && candidateAuthority.required_project_ids.length === 0
      && candidateAuthority.required_shot_ids.length === 0) {
      result = { ok: true, candidates: [], facts: [] };
    } else {
      const history = readSelectedHistoryRows(db, candidateAuthority.candidates);
      const classified = classifyAdmissionAuthoritySlice({ ...candidateAuthority, generation_jobs: history.jobs, generation_runs: history.runs });
      if (classified.status !== "COMPLETE") throw new Error("GENERATION_ADMISSION_FACTS_UNAVAILABLE");
      const active = db.prepare("SELECT COUNT(*) AS count FROM generation_intents WHERE status IN ('queued', 'running')")
        .get() as { count: number | bigint };
      const facts: GenerationAdmissionFacts[] = [];
      for (const candidate of candidateAuthority.candidates) {
        const candidateHistory = classified.history_by_candidate.get(admissionCandidateKey(candidate));
        if (!candidateHistory) throw new Error("GENERATION_ADMISSION_FACTS_UNAVAILABLE");
        const read = buildGenerationAdmissionFacts(
          db,
          candidate.project_id,
          candidate.shot_id,
          options,
          generationFactsFromHistory(Number(active.count), candidateHistory)
        );
        if (!read.ok) throw new Error("GENERATION_ADMISSION_FACTS_UNAVAILABLE");
        facts.push(read.facts);
      }
      result = { ok: true, candidates: candidateAuthority.candidates, facts };
    }
  } catch {
    result = {
      ok: false,
      error: { code: "GENERATION_ADMISSION_FACTS_UNAVAILABLE", message: "Generation admission facts could not be read from the current authority." }
    };
  } finally {
    if (snapshotStarted) {
      try {
        db.exec("RELEASE SAVEPOINT t2_selected_admission_authority");
      } catch {
        result = {
          ok: false,
          error: { code: "GENERATION_ADMISSION_FACTS_UNAVAILABLE", message: "Generation admission facts could not be read from the current authority." }
        };
      }
    }
  }
  return result;
}
