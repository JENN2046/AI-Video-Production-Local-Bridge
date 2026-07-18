import type { M0Database } from "../storage/sqlite.js";
import {
  deriveProjectOperationalSummary,
  deriveShotOperationalState,
  type ArtifactOperationalFact,
  type GenerationOperationalJobState,
  type GenerationOperationalRunStatus,
  type ProjectOperationalSummary,
  type ShotOperationalState
} from "../packages/domain/operationalState.js";
import type { Project, Shot } from "./projects.js";

export interface ProjectOperationalBundle {
  project: Project;
  shots: Shot[];
  states: ShotOperationalState[];
  states_by_shot_id: Map<string, ShotOperationalState>;
  summary: ProjectOperationalSummary;
}

export class OperationalStateIntegrityError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface ArtifactLedgerRow {
  artifact_id: string;
  project_id: string | null;
  shot_id: string | null;
  role: string;
  artifact_type: string;
  status: string;
  data_json: string;
  blob_id: string | null;
  integrity_state: string | null;
}

interface RunRow {
  project_id: string;
  shot_id: string | null;
  status: string;
}

interface JobRow {
  project_id: string;
  shot_id: string;
  state: string;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function parseShot(value: string, expectedShotId: string, expectedProjectId: string): Shot {
  try {
    const shot = JSON.parse(value) as Shot;
    if (!shot
      || shot.shot_id !== expectedShotId
      || shot.project_id !== expectedProjectId
      || !Array.isArray(shot.clip_versions)
      || !shot.review
      || !["pending", "approved", "revision_needed"].includes(shot.review.approval_status)) {
      throw new OperationalStateIntegrityError("SHOT_OPERATIONAL_FACT_INVALID");
    }
    return shot;
  } catch (error) {
    if (error instanceof OperationalStateIntegrityError) throw error;
    throw new OperationalStateIntegrityError("SHOT_OPERATIONAL_FACT_INVALID");
  }
}

function artifactFact(
  artifactId: string,
  projectId: string,
  shotId: string,
  expectedRole: "storyboard_image" | "generated_clip",
  expectedType: "image" | "video",
  rows: Map<string, ArtifactLedgerRow>
): ArtifactOperationalFact {
  if (!artifactId) return { artifact_id: null, status: "missing", verification_level: "none" };
  const row = rows.get(artifactId);
  if (!row) return { artifact_id: artifactId, status: "integrity_invalid", verification_level: "none" };
  try {
    const projected = JSON.parse(row.data_json) as {
      artifact_id?: unknown;
      blob_id?: unknown;
      role?: unknown;
      artifact_type?: unknown;
      status?: unknown;
      linked_objects?: { project_id?: unknown; shot_id?: unknown };
    };
    if (projected.artifact_id !== row.artifact_id
      || projected.linked_objects?.project_id !== (row.project_id ?? "")
      || projected.linked_objects?.shot_id !== (row.shot_id ?? "")
      || projected.role !== row.role
      || projected.artifact_type !== row.artifact_type
      || projected.status !== row.status
      || (row.blob_id !== null && projected.blob_id !== row.blob_id)) {
      throw new OperationalStateIntegrityError("ARTIFACT_OPERATIONAL_FACT_INVALID");
    }
  } catch (error) {
    if (error instanceof OperationalStateIntegrityError) throw error;
    throw new OperationalStateIntegrityError("ARTIFACT_OPERATIONAL_FACT_INVALID");
  }
  if ((row.project_id ?? "") !== projectId || (row.shot_id ?? "") !== shotId) {
    return { artifact_id: artifactId, status: "binding_invalid", verification_level: "none" };
  }
  if (row.role !== expectedRole || row.artifact_type !== expectedType) {
    return { artifact_id: artifactId, status: "role_invalid", verification_level: "none" };
  }
  if (row.status !== "active") return { artifact_id: artifactId, status: "inactive", verification_level: "none" };
  if (!row.blob_id || row.integrity_state !== "verified") {
    return { artifact_id: artifactId, status: "integrity_invalid", verification_level: "none" };
  }
  return { artifact_id: artifactId, status: "active", verification_level: "ledger_verified" };
}

function jobState(value: string | undefined): GenerationOperationalJobState {
  if (value === undefined) return null;
  if (["queued", "submitting", "polling", "downloading", "finalizing", "manual_reconciliation", "succeeded", "failed", "cancelled"].includes(value)) {
    return value as GenerationOperationalJobState;
  }
  throw new OperationalStateIntegrityError("GENERATION_JOB_OPERATIONAL_STATE_INVALID");
}

function runStatus(value: string | undefined): GenerationOperationalRunStatus {
  if (value === undefined) return null;
  if (["queued", "running", "succeeded", "failed", "cancelled"].includes(value)) return value as GenerationOperationalRunStatus;
  throw new OperationalStateIntegrityError("GENERATION_RUN_OPERATIONAL_STATUS_INVALID");
}

function shotKey(projectId: string, shotId: string): string {
  return `${projectId}\u0000${shotId}`;
}

export function collectProjectOperationalBundles(
  db: M0Database,
  projects: Project[]
): Map<string, ProjectOperationalBundle> {
  const uniqueProjects = [...new Map(projects.map((project) => [project.project_id, project])).values()];
  if (uniqueProjects.length === 0) return new Map();
  const projectIds = uniqueProjects.map((project) => project.project_id);
  const slots = placeholders(projectIds.length);

  const shotRows = db.prepare(`
    SELECT shot_id, project_id, data_json
    FROM shots
    WHERE project_id IN (${slots})
    ORDER BY project_id, json_extract(data_json, '$.order'), shot_id
  `).all(...projectIds) as Array<{ shot_id: string; project_id: string; data_json: string }>;
  const shotsByProject = new Map<string, Shot[]>();
  for (const row of shotRows) {
    const shot = parseShot(row.data_json, row.shot_id, row.project_id);
    const collection = shotsByProject.get(row.project_id) ?? [];
    collection.push(shot);
    shotsByProject.set(row.project_id, collection);
  }

  const artifactRows = db.prepare(`
    SELECT a.artifact_id, a.project_id, a.shot_id, a.role, a.artifact_type, a.status, a.data_json,
      link.blob_id, blob.integrity_state
    FROM media_artifacts a
    LEFT JOIN media_artifact_blobs link ON link.artifact_id = a.artifact_id
    LEFT JOIN media_blobs blob ON blob.blob_id = link.blob_id
    WHERE a.project_id IN (${slots})
  `).all(...projectIds) as ArtifactLedgerRow[];
  const artifacts = new Map(artifactRows.map((row) => [row.artifact_id, row]));

  const runRows = db.prepare(`
    SELECT project_id, shot_id, status
    FROM generation_runs
    WHERE project_id IN (${slots}) AND COALESCE(shot_id, '') <> ''
    ORDER BY updated_at DESC, rowid DESC
  `).all(...projectIds) as RunRow[];
  const latestRunByShot = new Map<string, string>();
  for (const row of runRows) {
    if (!row.shot_id) continue;
    const key = shotKey(row.project_id, row.shot_id);
    if (!latestRunByShot.has(key)) latestRunByShot.set(key, row.status);
  }

  const jobRows = db.prepare(`
    SELECT intent.project_id, intent.shot_id, job.state
    FROM generation_jobs job
    JOIN generation_intents intent ON intent.intent_id = job.intent_id
    WHERE intent.project_id IN (${slots})
    ORDER BY job.updated_at DESC, job.created_at DESC, job.rowid DESC
  `).all(...projectIds) as JobRow[];
  const latestJobByShot = new Map<string, string>();
  for (const row of jobRows) {
    const key = shotKey(row.project_id, row.shot_id);
    if (!latestJobByShot.has(key)) latestJobByShot.set(key, row.state);
  }

  const result = new Map<string, ProjectOperationalBundle>();
  for (const project of uniqueProjects) {
    const shots = shotsByProject.get(project.project_id) ?? [];
    const states = shots.map((shot) => {
      const latestVersion = [...shot.clip_versions].sort((left, right) => right.attempt_number - left.attempt_number)[0];
      const acceptedVersion = shot.clip_versions.find((version) => version.artifact_id === shot.accepted_clip_artifact_id);
      return deriveShotOperationalState({
        shot_id: shot.shot_id,
        project_id: shot.project_id,
        stored_workflow_status: shot.status,
        duration_seconds: shot.duration_seconds,
        video_prompt_present: typeof shot.video_prompt === "string" && shot.video_prompt.trim().length > 0,
        storyboard_artifact: artifactFact(shot.storyboard_image_artifact_id, shot.project_id, shot.shot_id, "storyboard_image", "image", artifacts),
        accepted_clip_artifact: artifactFact(shot.accepted_clip_artifact_id, shot.project_id, shot.shot_id, "generated_clip", "video", artifacts),
        generation_version_count: shot.clip_versions.length,
        accepted_clip_in_version_stack: Boolean(shot.accepted_clip_artifact_id && shot.clip_versions.some((version) => version.artifact_id === shot.accepted_clip_artifact_id)),
        accepted_clip_review_status: acceptedVersion?.review_status ?? null,
        review_approval_status: shot.review.approval_status,
        latest_version_review_status: latestVersion?.review_status ?? null,
        generation_job_state: jobState(latestJobByShot.get(shotKey(shot.project_id, shot.shot_id))),
        latest_generation_run_status: runStatus(latestRunByShot.get(shotKey(shot.project_id, shot.shot_id)))
      });
    });
    result.set(project.project_id, {
      project,
      shots,
      states,
      states_by_shot_id: new Map(states.map((state) => [state.shot_id, state])),
      summary: deriveProjectOperationalSummary(states)
    });
  }
  return result;
}

export function collectProjectOperationalBundle(db: M0Database, project: Project): ProjectOperationalBundle {
  const bundle = collectProjectOperationalBundles(db, [project]).get(project.project_id);
  if (!bundle) throw new Error("PROJECT_OPERATIONAL_STATE_UNAVAILABLE");
  return bundle;
}
