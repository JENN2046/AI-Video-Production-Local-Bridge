import { randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { registerMediaArtifact, validateAcceptedClipReference } from "./mediaArtifacts.js";
import { saveGenerationRun, type Confirmation, type GenerationRun } from "./generation.js";
import { getProject, listProjectShots, saveProject, type ToolError } from "./projects.js";
import { assertWorkbenchProductionWriteAllowed, type WorkbenchDeliveryWorkflowState } from "./workbenchDeliveryState.js";

type ToolResult<T> = { ok: true } & T | { ok: false; error: ToolError; blocking_reasons?: string[] };

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

  const project = getProject(db, input.project_id);
  if (!project) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${input.project_id}` } };
  const writable = assertWorkbenchProductionWriteAllowed(db, project.project_id);
  if (!writable.ok) return { ok: false, error: writable.error };
  if (writable.delivery.workflow_state === "assembling") {
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

  const artifact = registerMediaArtifact(
    {
      artifact_type: "video",
      role: "final_video",
      source: {
        kind: "fixture_path",
        path: M0_FINAL_PLACEHOLDER_FIXTURE
      },
      linked_objects: {
        project_id: project.project_id
      },
      metadata: {
        duration_seconds: M0_FINAL_PLACEHOLDER_DURATION_SECONDS,
        aspect_ratio: project.video_spec.aspect_ratio,
        width: 1080,
        height: 1920
      }
    },
    db
  );
  if (!artifact.ok) {
    return { ok: false, error: { code: "GENERATION_PROVIDER_ERROR", message: artifact.error.message } };
  }

  const run: GenerationRun = {
    run_id: `run_${randomUUID()}`,
    batch_id: "",
    project_id: project.project_id,
    shot_id: "",
    run_type: "assemble_video",
    status: "succeeded",
    input: {
      storyboard_image_artifact_id: "",
      video_prompt: "assemble accepted M0 clips",
      negative_prompt: "",
      duration_seconds: shots.reduce((sum, shot) => sum + shot.duration_seconds, 0),
      aspect_ratio: project.video_spec.aspect_ratio,
      resolution: project.video_spec.resolution
    },
    output: {
      artifact_ids: [artifact.artifact.artifact_id]
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

  const savepoint = `legacy_assembly_${randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const currentBoundary = assertWorkbenchProductionWriteAllowed(db, project.project_id);
    if (!currentBoundary.ok) throw new Error(currentBoundary.error.code);
    const currentState = currentBoundary.delivery.workflow_state;
    if (currentState === "assembling") throw new Error("DELIVERY_JOB_ACTIVE");
    if (currentState !== "ready_to_assemble") {
      if (!REASSEMBLY_SOURCE_STATES.has(currentState)) throw new Error("ASSEMBLY_INPUT_CHANGED");
      const prepared = db.prepare(`UPDATE workbench_delivery_state
        SET workflow_state = 'ready_to_assemble', assembly_input_fingerprint = NULL,
          approved_artifact_id = NULL, latest_export_id = NULL, latest_exported_at = NULL,
          closed_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ? AND workflow_state = ?`).run(project.project_id, currentState) as { changes: number | bigint };
      if (Number(prepared.changes) !== 1) throw new Error("ASSEMBLY_INPUT_CHANGED");
    }
    const started = db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'assembling', updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND workflow_state = 'ready_to_assemble'`).run(project.project_id) as { changes: number | bigint };
    if (Number(started.changes) !== 1) throw new Error("ASSEMBLY_INPUT_CHANGED");

    project.exports.final_video_artifact_id = artifact.artifact.artifact_id;
    project.status = "video_review";
    saveProject(db, project);
    saveGenerationRun(db, run);

    const completed = db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'final_review', current_final_artifact_id = ?,
        approved_artifact_id = NULL, latest_export_id = NULL, latest_exported_at = NULL,
        closed_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND workflow_state = 'assembling'`).run(artifact.artifact.artifact_id, project.project_id) as { changes: number | bigint };
    if (Number(completed.changes) !== 1) throw new Error("ASSEMBLY_INPUT_CHANGED");
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, reason_code, data_json, created_at)
      VALUES (?, ?, 'assembly_succeeded', 'assembling', 'final_review', ?, 'LEGACY_ASSEMBLY_SUCCEEDED', '{}', CURRENT_TIMESTAMP)`)
      .run(`event_${randomUUID()}`, project.project_id, artifact.artifact.artifact_id);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch { /* preserve the stable assembly error */ }
    return { ok: false, error: assemblyPersistenceError(error) };
  }

  return { ok: true, run, final_video_artifact_id: artifact.artifact.artifact_id };
}
