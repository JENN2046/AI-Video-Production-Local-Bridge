import { randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { cleanupCommittedMediaActivationMarkers, cleanupRolledBackMediaActivationFiles, registerMediaArtifact, validateAcceptedClipReference } from "./mediaArtifacts.js";
import { saveGenerationRun, type Confirmation, type GenerationRun } from "./generation.js";
import { getProject, listProjectShots, type ToolError } from "./projects.js";
import { assertWorkbenchProductionWriteAllowed, getActiveWorkbenchDeliveryJob, type WorkbenchDeliveryWorkflowState } from "./workbenchDeliveryState.js";

type ToolResult<T> = { ok: true } & T | { ok: false; error: ToolError; blocking_reasons?: string[] };

function databaseIsInTransaction(db: M0Database): boolean {
  return Boolean((db as unknown as { isTransaction?: boolean }).isTransaction);
}

function synchronizeAssemblyProjectResult(db: M0Database, projectId: string, artifactId: string): void {
  if (!databaseIsInTransaction(db)) throw new Error("ASSEMBLY_INPUT_CHANGED");
  const updated = db.prepare(`UPDATE projects
    SET data_json = json_set(
      data_json,
      '$.status', 'video_review',
      '$.exports.final_video_artifact_id', ?
    ), updated_at = CURRENT_TIMESTAMP
    WHERE project_id = ?
      AND json_extract(data_json, '$.project_id') = ?
      AND EXISTS (
        SELECT 1 FROM workbench_delivery_state delivery
        WHERE delivery.project_id = projects.project_id
          AND delivery.workflow_state = 'assembling'
      )
      AND EXISTS (
        SELECT 1 FROM media_artifacts artifact
        JOIN media_artifact_blobs link ON link.artifact_id = artifact.artifact_id
        JOIN media_blobs blob ON blob.blob_id = link.blob_id
        WHERE artifact.artifact_id = ? AND artifact.project_id = projects.project_id
          AND COALESCE(artifact.shot_id, '') = ''
          AND artifact.role = 'final_video' AND artifact.artifact_type = 'video'
          AND artifact.status = 'active' AND blob.integrity_state = 'verified'
      )`)
    .run(artifactId, projectId, projectId, artifactId) as { changes: number | bigint };
  if (Number(updated.changes) !== 1) throw new Error("ASSEMBLY_INPUT_CHANGED");
}

const M0_FINAL_PLACEHOLDER_FIXTURE = "video/mock_clip.mp4";
const M0_FINAL_PLACEHOLDER_DURATION_SECONDS = 2;

function explicitConfirmed(confirmation?: Confirmation): boolean {
  return confirmation?.confirmation_level === "explicit" && confirmation.user_confirmed === true;
}

function finalAssemblyBlockingReasons(db: M0Database, projectId: string): string[] {
  const shots = listProjectShots(db, projectId);
  const reasons: string[] = [];

  for (const shot of shots) {
    if (!shot.accepted_clip_artifact_id) {
      reasons.push(`Shot ${String(shot.order).padStart(3, "0")} has no accepted clip`);
      continue;
    }

    const validated = validateAcceptedClipReference(db, shot);
    if (!validated.ok) reasons.push(`Shot ${String(shot.order).padStart(3, "0")} [${validated.error.code}] ${validated.error.message}`);
  }

  return reasons;
}

const REASSEMBLY_SOURCE_STATES: ReadonlySet<WorkbenchDeliveryWorkflowState> = new Set([
  "not_ready",
  "final_review",
  "revision_requested",
  "approved",
  "exported",
  "legacy_review_required"
]);

const FINAL_REVIEW_REASSEMBLY_SOURCE_STATES: ReadonlySet<WorkbenchDeliveryWorkflowState> = new Set([
  "final_review",
  "approved",
  "exported",
  "legacy_review_required"
]);
const ATOMIC_REASSEMBLY_SOURCE_STATES: ReadonlySet<WorkbenchDeliveryWorkflowState> = new Set([
  "approved",
  "exported"
]);

function assemblyPersistenceError(error: unknown): ToolError {
  const code = error instanceof Error ? error.message : "";
  if (code === "PROJECT_NOT_FOUND") return { code, message: "Project no longer exists." };
  if (code === "PROJECT_ARCHIVED") return { code, message: "Archived projects are read-only." };
  if (code === "DELIVERY_STATE_MISSING") return { code, message: "Project delivery state is unavailable." };
  if (code === "PROJECT_CLOSED") return { code, message: "Closed projects do not accept production changes." };
  if (code === "DELIVERY_JOB_ACTIVE") return { code, message: "Another delivery operation is already active." };
  if (code === "ASSEMBLY_INPUT_CHANGED") return { code, message: "Assembly state changed before the result could be committed." };
  return { code: "FINAL_ASSEMBLY_PERSIST_FAILED", message: "Final assembly result could not be committed." };
}

export function assembleFinalVideo(
  input: {
    project_id: string;
    confirmation?: Confirmation;
  },
  db = openM0Database()
): ToolResult<{ run: GenerationRun; final_video_artifact_id: string }> {
  if (!explicitConfirmed(input.confirmation)) {
    return { ok: false, error: { code: "USER_CONFIRMATION_REQUIRED", message: "Final assembly requires explicit confirmation." } };
  }
  if (databaseIsInTransaction(db)) {
    return {
      ok: false,
      error: {
        code: "FINAL_ASSEMBLY_TRANSACTION_UNSAFE",
        message: "Final assembly cannot run inside a caller-owned database transaction."
      }
    };
  }

  const project = getProject(db, input.project_id);
  if (!project) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${input.project_id}` } };
  const writable = assertWorkbenchProductionWriteAllowed(db, project.project_id);
  if (!writable.ok) return { ok: false, error: writable.error };
  if (writable.delivery.workflow_state === "assembling" || getActiveWorkbenchDeliveryJob(db)) {
    return { ok: false, error: { code: "DELIVERY_JOB_ACTIVE", message: "Another delivery operation is already active." } };
  }

  const shots = listProjectShots(db, project.project_id);
  const blockingReasons = finalAssemblyBlockingReasons(db, project.project_id);
  if (!shots.length || blockingReasons.length) {
    return {
      ok: false,
      error: { code: "FINAL_ASSEMBLY_NOT_READY", message: "Final assembly is not ready." },
      blocking_reasons: !shots.length ? ["Project has no shots"] : blockingReasons
    };
  }

  const savepoint = `legacy_assembly_${randomUUID().replaceAll("-", "")}`;
  let activatedArtifactId = "";
  let artifactFailure: ToolError | null = null;
  let committed: { run: GenerationRun; artifact_id: string } | null = null;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const currentBoundary = assertWorkbenchProductionWriteAllowed(db, project.project_id);
    if (!currentBoundary.ok) throw new Error(currentBoundary.error.code);
    if (getActiveWorkbenchDeliveryJob(db)) throw new Error("DELIVERY_JOB_ACTIVE");
    const currentState = currentBoundary.delivery.workflow_state;
    const clearsPriorFingerprint = currentState !== "ready_to_assemble";
    if (currentState === "assembling") throw new Error("DELIVERY_JOB_ACTIVE");
    if (currentState !== "ready_to_assemble") {
      if (!REASSEMBLY_SOURCE_STATES.has(currentState)) throw new Error("ASSEMBLY_INPUT_CHANGED");
      const insertReassemblyEvent = () => {
        db.prepare(`INSERT INTO workbench_delivery_events
          (event_id, project_id, event_type, from_state, to_state, artifact_id,
            input_fingerprint, reason_code, data_json, created_at)
          VALUES (?, ?, 'final_review_reassemble', ?, 'ready_to_assemble', ?, ?,
            'LEGACY_REASSEMBLY_REQUESTED', '{"source":"legacy_assembly"}', CURRENT_TIMESTAMP)`)
          .run(`event_${randomUUID()}`, project.project_id, currentState,
            currentBoundary.delivery.current_final_artifact_id,
            currentBoundary.delivery.assembly_input_fingerprint);
      };
      if (ATOMIC_REASSEMBLY_SOURCE_STATES.has(currentState)) {
        insertReassemblyEvent();
      } else {
        const prepared = db.prepare(`UPDATE workbench_delivery_state
          SET workflow_state = 'ready_to_assemble',
            approved_artifact_id = NULL, latest_export_id = NULL, latest_exported_at = NULL,
            closed_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE project_id = ? AND workflow_state = ?`).run(project.project_id, currentState) as { changes: number | bigint };
        if (Number(prepared.changes) !== 1) throw new Error("ASSEMBLY_INPUT_CHANGED");
        if (FINAL_REVIEW_REASSEMBLY_SOURCE_STATES.has(currentState)) insertReassemblyEvent();
      }
    }
    const started = db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'assembling',
        assembly_input_fingerprint = CASE WHEN ? THEN NULL ELSE assembly_input_fingerprint END,
        updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND workflow_state = 'ready_to_assemble'
        AND assembly_input_fingerprint IS ?`)
      .run(clearsPriorFingerprint ? 1 : 0, project.project_id,
        currentBoundary.delivery.assembly_input_fingerprint) as { changes: number | bigint };
    if (Number(started.changes) !== 1) throw new Error("ASSEMBLY_INPUT_CHANGED");
    if (getActiveWorkbenchDeliveryJob(db)) throw new Error("DELIVERY_JOB_ACTIVE");

    const currentProject = getProject(db, project.project_id);
    if (!currentProject) throw new Error("PROJECT_NOT_FOUND");
    const currentShots = listProjectShots(db, project.project_id);
    if (!currentShots.length || finalAssemblyBlockingReasons(db, project.project_id).length) {
      throw new Error("ASSEMBLY_INPUT_CHANGED");
    }

    const artifact = registerMediaArtifact(
      {
        artifact_type: "video",
        role: "final_video",
        source: {
          kind: "fixture_path",
          path: M0_FINAL_PLACEHOLDER_FIXTURE
        },
        linked_objects: {
          project_id: currentProject.project_id
        },
        metadata: {
          duration_seconds: M0_FINAL_PLACEHOLDER_DURATION_SECONDS,
          aspect_ratio: currentProject.video_spec.aspect_ratio,
          width: 1080,
          height: 1920
        }
      },
      db
    );
    if (!artifact.ok) {
      artifactFailure = artifact.error;
      throw new Error("FINAL_ASSEMBLY_ARTIFACT_FAILED");
    }
    activatedArtifactId = artifact.artifact.artifact_id;

    const run: GenerationRun = {
      run_id: `run_${randomUUID()}`,
      batch_id: "",
      project_id: currentProject.project_id,
      shot_id: "",
      run_type: "assemble_video",
      status: "succeeded",
      input: {
        storyboard_image_artifact_id: "",
        video_prompt: "assemble accepted M0 clips",
        negative_prompt: "",
        duration_seconds: currentShots.reduce((sum, shot) => sum + shot.duration_seconds, 0),
        aspect_ratio: currentProject.video_spec.aspect_ratio,
        resolution: currentProject.video_spec.resolution
      },
      output: {
        artifact_ids: [activatedArtifactId]
      },
      provider: {
        provider: "mock",
        provider_name: "mock",
        model_name: "placeholder_copy",
        provider_job_id: "",
        provider_status: "succeeded"
      },
      versioning: {
        attempt_number: 1,
        parent_run_id: ""
      },
      error: {
        code: "",
        message: "",
        retryable: false
      }
    };

    synchronizeAssemblyProjectResult(db, currentProject.project_id, activatedArtifactId);
    saveGenerationRun(db, run);

    const deliveryJobId = `job_${randomUUID()}`;
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, output_artifact_id,
        created_at, started_at, finished_at, updated_at)
      VALUES (?, ?, 'assembly', 'succeeded', '{}', ?,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
      .run(deliveryJobId, currentProject.project_id, activatedArtifactId);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id, reason_code, data_json, created_at)
      VALUES (?, ?, ?, 'assembly_succeeded', 'assembling', 'final_review', ?, 'LEGACY_ASSEMBLY_SUCCEEDED', '{}', CURRENT_TIMESTAMP)`)
      .run(`event_${randomUUID()}`, currentProject.project_id, deliveryJobId, activatedArtifactId);
    committed = { run, artifact_id: activatedArtifactId };
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch { /* preserve the stable assembly error */ }
    if (activatedArtifactId) cleanupRolledBackMediaActivationFiles([activatedArtifactId]);
    if (artifactFailure) {
      return { ok: false, error: { code: "GENERATION_PROVIDER_ERROR", message: artifactFailure.message } };
    }
    return { ok: false, error: assemblyPersistenceError(error) };
  }

  if (!committed) return { ok: false, error: { code: "FINAL_ASSEMBLY_PERSIST_FAILED", message: "Final assembly result could not be committed." } };
  cleanupCommittedMediaActivationMarkers(db, [committed.artifact_id]);
  return { ok: true, run: committed.run, final_video_artifact_id: committed.artifact_id };
}
