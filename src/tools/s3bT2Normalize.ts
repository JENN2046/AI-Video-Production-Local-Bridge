import { WEBGPT_V4_CLIP_VERSION_SCHEMA } from "../packages/domain/clipVersion.js";
import { deriveShotOperationalState, type ArtifactOperationalFact, type ShotOperationalFacts } from "../packages/domain/operationalState.js";
import type {
  T2GenerationFacts,
  T2NormalizedArtifact,
  T2NormalizedBlob,
  T2NormalizedPackage,
  T2NormalizedPackageSnapshot,
  T2NormalizedProject,
  T2NormalizedProjectMeta,
  T2NormalizedShot,
  T2NormalizedSnapshot,
  T2NormalizationIssue,
  T2RawSnapshot,
  T2DatabaseRow
} from "./s3bT2Types.js";

const PROJECT_STATUSES = new Set(["draft", "storyboard_approved", "video_generation_in_progress", "video_review", "final_approved"]);
const SHOT_STATUSES = new Set(["draft", "storyboard_approved", "video_pending", "video_generated", "video_review", "approved", "revision_needed"]);
const RUN_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
const JOB_STATES = new Set(["queued", "submitting", "polling", "downloading", "finalizing", "manual_reconciliation", "succeeded", "failed", "cancelled"]);

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseObject(value: unknown): RecordValue | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): value is string {
  return typeof value === "string";
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function issue(issues: T2NormalizationIssue[], code: string, entity: T2NormalizationIssue["entity"], key?: string): void {
  issues.push({ code, entity, ...(key ? { key } : {}) });
}

function relationString(row: T2DatabaseRow, name: string): string | null {
  const value = row[name];
  return typeof value === "string" ? value : null;
}

function normalizeProjects(raw: T2RawSnapshot, issues: T2NormalizationIssue[]): Map<string, T2NormalizedProject> {
  const result = new Map<string, T2NormalizedProject>();
  for (const row of raw.rowsets.projects) {
    const relationId = relationString(row, "project_id");
    const value = parseObject(row.data_json);
    const projectId = value?.project_id;
    const spec = value?.video_spec;
    const exportsValue = value?.exports;
    if (!relationId || !value || projectId !== relationId || !stringValue(value.status) || !PROJECT_STATUSES.has(value.status)
      || !isRecord(spec) || !finiteNumber(spec.duration_seconds) || !stringValue(spec.aspect_ratio) || !stringValue(spec.resolution)
      || !stringValue(value.active_storyboard_package_id) || !isRecord(exportsValue) || !stringValue(exportsValue.final_video_artifact_id)) {
      issue(issues, "PROJECT_INVALID", "project", relationId ?? undefined);
      continue;
    }
    result.set(relationId, {
      project_id: relationId,
      status: value.status,
      video_spec: { duration_seconds: spec.duration_seconds, aspect_ratio: spec.aspect_ratio, resolution: spec.resolution },
      active_storyboard_package_id: value.active_storyboard_package_id,
      final_video_artifact_id: exportsValue.final_video_artifact_id
    });
  }
  return result;
}

function normalizeProjectMeta(raw: T2RawSnapshot, issues: T2NormalizationIssue[]): Map<string, T2NormalizedProjectMeta> {
  const result = new Map<string, T2NormalizedProjectMeta>();
  for (const row of raw.rowsets.workbench_project_meta) {
    const projectId = relationString(row, "project_id");
    const classification = row.classification;
    const lifecycle = row.lifecycle;
    if (!projectId || !["production", "test", "unclassified"].includes(String(classification)) || !["active", "archived"].includes(String(lifecycle))) {
      issue(issues, "PROJECT_META_INVALID", "project_meta", projectId ?? undefined);
      continue;
    }
    result.set(projectId, { project_id: projectId, classification: classification as T2NormalizedProjectMeta["classification"], lifecycle: lifecycle as T2NormalizedProjectMeta["lifecycle"] });
  }
  return result;
}

function normalizeShot(raw: T2DatabaseRow, issues: T2NormalizationIssue[]): T2NormalizedShot | null {
  const relationId = relationString(raw, "shot_id");
  const relationProjectId = relationString(raw, "project_id");
  const value = parseObject(raw.data_json);
  const review = value?.review;
  const versions = value?.clip_versions;
  const reviewStatus = isRecord(review) ? review.approval_status : undefined;
  if (!relationId || !relationProjectId || !value || value.shot_id !== relationId || value.project_id !== relationProjectId
    || !finiteNumber(value.order) || !SHOT_STATUSES.has(String(value.status)) || !finiteNumber(value.duration_seconds)
    || !stringValue(value.storyboard_image_artifact_id) || !stringValue(value.video_prompt)
    || !(value.negative_prompt === undefined || value.negative_prompt === null || stringValue(value.negative_prompt))
    || !Array.isArray(value.generation_run_ids) || !value.generation_run_ids.every(stringValue)
    || !stringValue(value.accepted_clip_artifact_id) || !Array.isArray(versions)
    || !isRecord(review) || !["pending", "approved", "revision_needed"].includes(String(reviewStatus))) {
    issue(issues, "SHOT_INVALID", "shot", relationId ?? undefined);
    return null;
  }
  const parsedVersions: T2NormalizedShot["clip_versions"] = [];
  for (const version of versions) {
    const parsed = WEBGPT_V4_CLIP_VERSION_SCHEMA.safeParse(version);
    if (!parsed.success) {
      issue(issues, "SHOT_INVALID", "shot", relationId);
      return null;
    }
    parsedVersions.push(parsed.data);
  }
  return {
    shot_id: relationId,
    project_id: relationProjectId,
    order: value.order,
    status: String(value.status),
    duration_seconds: value.duration_seconds,
    storyboard_image_artifact_id: value.storyboard_image_artifact_id,
    video_prompt: value.video_prompt,
    negative_prompt: value.negative_prompt == null ? "" : value.negative_prompt,
    generation_run_ids: value.generation_run_ids,
    accepted_clip_artifact_id: value.accepted_clip_artifact_id,
    clip_versions: parsedVersions,
    review: {
      approval_status: reviewStatus as T2NormalizedShot["review"]["approval_status"],
      rejection_reasons: Array.isArray(review.rejection_reasons) && review.rejection_reasons.every(stringValue) ? review.rejection_reasons : [],
      latest_revision_instruction: review.latest_revision_instruction ?? null
    }
  };
}

function normalizeShots(raw: T2RawSnapshot, issues: T2NormalizationIssue[]): Map<string, T2NormalizedShot> {
  const result = new Map<string, T2NormalizedShot>();
  for (const row of raw.rowsets.shots) {
    const shot = normalizeShot(row, issues);
    if (shot) result.set(shot.shot_id, shot);
  }
  return result;
}

function normalizePackage(raw: T2DatabaseRow, issues: T2NormalizationIssue[]): T2NormalizedPackage | null {
  const relationId = relationString(raw, "storyboard_package_id");
  const relationProjectId = relationString(raw, "project_id");
  const value = parseObject(raw.data_json);
  const approval = isRecord(value?.user_approval) ? value.user_approval.storyboard_approved : undefined;
  const snapshots = value?.approved_shot_snapshots;
  if (!relationId || !relationProjectId || !value || value.storyboard_package_id !== relationId || value.project_id !== relationProjectId
    || !stringValue(value.status) || !Array.isArray(snapshots) || approval !== true) {
    issue(issues, "PACKAGE_INVALID", "package", relationId ?? undefined);
    return null;
  }
  const normalized: T2NormalizedPackageSnapshot[] = [];
  for (const snapshot of snapshots) {
    if (!isRecord(snapshot) || ("shot_id" in snapshot && (typeof snapshot.shot_id !== "string" || snapshot.shot_id.length === 0))
      || !finiteNumber(snapshot.order) || !finiteNumber(snapshot.duration_seconds)
      || !stringValue(snapshot.storyboard_image_artifact_id) || !stringValue(snapshot.video_prompt)
      || !(snapshot.negative_prompt === undefined || snapshot.negative_prompt === null || stringValue(snapshot.negative_prompt))) {
      issue(issues, "PACKAGE_INVALID", "package", relationId);
      return null;
    }
    normalized.push({
      ...(typeof snapshot.shot_id === "string" ? { shot_id: snapshot.shot_id } : {}),
      order: snapshot.order,
      duration_seconds: snapshot.duration_seconds,
      description: typeof snapshot.description === "string" ? snapshot.description : "",
      storyboard_image_artifact_id: snapshot.storyboard_image_artifact_id,
      video_prompt: snapshot.video_prompt,
      negative_prompt: snapshot.negative_prompt == null ? "" : snapshot.negative_prompt
    });
  }
  return { storyboard_package_id: relationId, project_id: relationProjectId, status: value.status, approved_shot_snapshots: normalized, storyboard_approved: true };
}

function normalizePackages(raw: T2RawSnapshot, issues: T2NormalizationIssue[]): Map<string, T2NormalizedPackage> {
  const result = new Map<string, T2NormalizedPackage>();
  for (const row of raw.rowsets.storyboard_packages) {
    const pkg = normalizePackage(row, issues);
    if (pkg) result.set(pkg.storyboard_package_id, pkg);
  }
  return result;
}

function normalizeArtifacts(raw: T2RawSnapshot, issues: T2NormalizationIssue[]): Map<string, T2NormalizedArtifact> {
  const result = new Map<string, T2NormalizedArtifact>();
  for (const row of raw.rowsets.media_artifacts) {
    const relationId = relationString(row, "artifact_id");
    const relationProjectId = relationString(row, "project_id") ?? "";
    const relationShotId = relationString(row, "shot_id") ?? "";
    const value = parseObject(row.data_json);
    const storage = value?.storage;
    const metadata = value?.metadata;
    const linked = value?.linked_objects;
    const source = value?.source;
    if (!relationId || !value || value.artifact_id !== relationId || value.blob_id !== undefined && !stringValue(value.blob_id)
      || !stringValue(value.artifact_type) || !stringValue(value.role) || !stringValue(value.status)
      || value.project_id !== undefined || !isRecord(storage) || !stringValue(storage.uri) || !stringValue(storage.mime_type) || !stringValue(storage.filename)
      || !isRecord(metadata) || !stringValue(metadata.sha256) || !isRecord(linked) || linked.project_id !== relationProjectId || linked.shot_id !== relationShotId
      || !isRecord(source) || !stringValue(source.sha256)
      || (String(row.role) !== value.role || String(row.artifact_type) !== value.artifact_type || String(row.status) !== value.status)) {
      issue(issues, "ARTIFACT_INVALID", "artifact", relationId ?? undefined);
      continue;
    }
    result.set(relationId, {
      artifact_id: relationId,
      project_id: relationProjectId,
      shot_id: relationShotId,
      blob_id: typeof value.blob_id === "string" ? value.blob_id : "",
      artifact_type: value.artifact_type,
      role: value.role,
      status: value.status,
      storage: { uri: storage.uri, mime_type: storage.mime_type, filename: storage.filename },
      metadata: { sha256: metadata.sha256 },
      linked_objects: { project_id: linked.project_id, shot_id: linked.shot_id },
      source: { sha256: source.sha256 }
    });
  }
  return result;
}

function normalizeBlobs(raw: T2RawSnapshot, issues: T2NormalizationIssue[]): Map<string, T2NormalizedBlob> {
  const result = new Map<string, T2NormalizedBlob>();
  for (const row of raw.rowsets.media_blobs) {
    const blobId = relationString(row, "blob_id");
    const provenance = parseObject(row.provenance_json);
    const mediaRoot = provenance?.media_root;
    if (!blobId || !stringValue(row.sha256) || !finiteNumber(Number(row.size_bytes)) || !stringValue(row.detected_mime)
      || !stringValue(row.storage_uri) || !stringValue(row.integrity_state) || !stringValue(mediaRoot)) {
      issue(issues, "BLOB_INVALID", "blob", blobId ?? undefined);
      continue;
    }
    result.set(blobId, {
      blob_id: blobId,
      sha256: row.sha256,
      size_bytes: Number(row.size_bytes),
      detected_mime: row.detected_mime,
      storage_uri: row.storage_uri,
      integrity_state: row.integrity_state,
      media_root: mediaRoot
    });
  }
  return result;
}

function normalizeArtifactBlobLinks(raw: T2RawSnapshot, issues: T2NormalizationIssue[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of raw.rowsets.media_artifact_blobs) {
    const artifactId = relationString(row, "artifact_id");
    const blobId = relationString(row, "blob_id");
    if (!artifactId || !blobId || result.has(artifactId)) {
      issue(issues, "ARTIFACT_BLOB_BINDING_INVALID", "relation", artifactId ?? undefined);
      continue;
    }
    result.set(artifactId, blobId);
  }
  return result;
}

function normalizeGeneration(raw: T2RawSnapshot, issues: T2NormalizationIssue[]): Map<string, T2GenerationFacts> {
  type Mutable = T2GenerationFacts & { latestRunAt: string; latestJobAt: string };
  const result = new Map<string, Mutable>();
  const ensure = (projectId: string, shotId: string): Mutable => {
    const key = `${projectId}\u0000${shotId}`;
    const current = result.get(key);
    if (current) return current;
    const created: Mutable = { project_id: projectId, shot_id: shotId, has_any_job_or_run: false, latest_run_status: null, latest_job_state: null, malformed_history: false, latestRunAt: "", latestJobAt: "" };
    result.set(key, created);
    return created;
  };
  const intents = new Map<string, { projectId: string; shotId: string }>();
  for (const row of raw.rowsets.generation_intents) {
    const intentId = relationString(row, "intent_id");
    const projectId = relationString(row, "project_id");
    const shotId = relationString(row, "shot_id");
    if (intentId && projectId && shotId) intents.set(intentId, { projectId, shotId });
  }
  for (const row of raw.rowsets.generation_runs) {
    const projectId = relationString(row, "project_id");
    const shotId = relationString(row, "shot_id");
    const status = relationString(row, "status");
    if (!projectId || !shotId) continue;
    const facts = ensure(projectId, shotId);
    facts.has_any_job_or_run = true;
    if (!status || !RUN_STATUSES.has(status)) {
      facts.malformed_history = true;
      issue(issues, "GENERATION_HISTORY_INVALID", "generation", `${projectId}:${shotId}`);
      continue;
    }
    const updatedAt = String(row.updated_at ?? row.created_at ?? "");
    if (updatedAt >= facts.latestRunAt) { facts.latestRunAt = updatedAt; facts.latest_run_status = status as T2GenerationFacts["latest_run_status"]; }
  }
  for (const row of raw.rowsets.generation_jobs) {
    const intent = intents.get(String(row.intent_id ?? ""));
    if (!intent) {
      issue(issues, "GENERATION_HISTORY_INVALID", "generation");
      continue;
    }
    const facts = ensure(intent.projectId, intent.shotId);
    facts.has_any_job_or_run = true;
    const state = relationString(row, "state");
    if (!state || !JOB_STATES.has(state)) {
      facts.malformed_history = true;
      issue(issues, "GENERATION_HISTORY_INVALID", "generation", `${intent.projectId}:${intent.shotId}`);
      continue;
    }
    const updatedAt = String(row.updated_at ?? row.created_at ?? "");
    if (updatedAt >= facts.latestJobAt) { facts.latestJobAt = updatedAt; facts.latest_job_state = state as T2GenerationFacts["latest_job_state"]; }
  }
  return new Map([...result.entries()].map(([key, value]) => {
    const { latestRunAt: _run, latestJobAt: _job, ...facts } = value;
    return [key, facts];
  }));
}

export function normalizeT2RawSnapshot(raw: T2RawSnapshot): T2NormalizedSnapshot {
  const issues: T2NormalizationIssue[] = [];
  const projects = normalizeProjects(raw, issues);
  const project_meta = normalizeProjectMeta(raw, issues);
  const shots = normalizeShots(raw, issues);
  const packages = normalizePackages(raw, issues);
  const artifacts = normalizeArtifacts(raw, issues);
  const blobs = normalizeBlobs(raw, issues);
  const artifact_blob_links = normalizeArtifactBlobLinks(raw, issues);
  for (const [artifactId, artifact] of artifacts) {
    const linkedBlob = artifact_blob_links.get(artifactId);
    if (!linkedBlob || (artifact.blob_id && artifact.blob_id !== linkedBlob) || !blobs.has(linkedBlob)) issue(issues, "ARTIFACT_BLOB_BINDING_INVALID", "relation", artifactId);
    else artifact.blob_id = linkedBlob;
  }
  const generation = normalizeGeneration(raw, issues);
  return {
    database: raw.database,
    projects,
    project_meta,
    shots,
    packages,
    artifacts,
    blobs,
    artifact_blob_links,
    generation,
    normalization_issues: issues,
    rowsets: raw.rowset_evidence,
    database_evidence_digest: raw.database_evidence_digest
  };
}

/** Pure canonical ClipVersion boundary; no second validator is permitted. */
export function parseCanonicalClipVersion(value: unknown): ReturnType<typeof WEBGPT_V4_CLIP_VERSION_SCHEMA.safeParse> {
  return WEBGPT_V4_CLIP_VERSION_SCHEMA.safeParse(value);
}

/** Build the operational state from already-normalized facts without touching storage. */
export function deriveNormalizedShotState(
  snapshot: T2NormalizedSnapshot,
  shot: T2NormalizedShot,
  mediaVerified = new Set<string>()
) {
  const artifactFact = (artifactId: string): ArtifactOperationalFact => {
    if (!artifactId) return { artifact_id: null, status: "missing", verification_level: "none" };
    const artifact = snapshot.artifacts.get(artifactId);
    if (!artifact) return { artifact_id: artifactId, status: "integrity_invalid", verification_level: "none" };
    if (artifact.project_id !== shot.project_id || artifact.shot_id !== shot.shot_id) return { artifact_id: artifactId, status: "binding_invalid", verification_level: "none" };
    if (artifact.role !== "storyboard_image" && artifactId === shot.storyboard_image_artifact_id) return { artifact_id: artifactId, status: "role_invalid", verification_level: "none" };
    if (artifact.status !== "active") return { artifact_id: artifactId, status: "inactive", verification_level: "none" };
    const blob = snapshot.blobs.get(artifact.blob_id);
    if (!blob || blob.integrity_state !== "verified") return { artifact_id: artifactId, status: "integrity_invalid", verification_level: "none" };
    return { artifact_id: artifactId, status: "active", verification_level: mediaVerified.has(artifactId) ? "bytes_verified" : "ledger_verified" };
  };
  const latest = [...shot.clip_versions].sort((left, right) => right.attempt_number - left.attempt_number)[0];
  const accepted = shot.clip_versions.find((version) => version.artifact_id === shot.accepted_clip_artifact_id);
  const history = snapshot.generation.get(`${shot.project_id}\u0000${shot.shot_id}`);
  const facts: ShotOperationalFacts = {
    shot_id: shot.shot_id,
    project_id: shot.project_id,
    stored_workflow_status: shot.status as ShotOperationalFacts["stored_workflow_status"],
    duration_seconds: shot.duration_seconds,
    video_prompt_present: shot.video_prompt.trim().length > 0,
    storyboard_artifact: artifactFact(shot.storyboard_image_artifact_id),
    accepted_clip_artifact: artifactFact(shot.accepted_clip_artifact_id),
    latest_version_artifact: artifactFact(latest?.artifact_id ?? ""),
    generation_version_count: shot.clip_versions.length,
    accepted_clip_in_version_stack: Boolean(shot.accepted_clip_artifact_id && accepted),
    accepted_clip_review_status: accepted?.review_status ?? null,
    review_approval_status: shot.review.approval_status,
    latest_version_review_status: latest?.review_status ?? null,
    generation_job_state: history?.latest_job_state ?? null,
    latest_generation_run_status: history?.latest_run_status ?? null
  };
  return deriveShotOperationalState(facts);
}
