import { randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import {
  attachArtifactToShot,
  cleanupCommittedMediaActivationMarkers,
  cleanupRolledBackMediaActivationFiles,
  getMediaArtifact,
  registerMediaArtifact,
  validateActiveArtifactReference
} from "./mediaArtifacts.js";
import { getGenerationRun, saveGenerationRun, type Confirmation, type GenerationRun } from "./generation.js";
import { requireShotWorkflowWriteAction } from "./operationalWriteGates.js";
import { getProject, getShot, saveShot, type Project, type Shot, type ToolError } from "./projects.js";
import { type ProviderExecutionRequest } from "./provider.js";
import { MockVideoProviderAdapter } from "./videoProviderAdapters.js";
import { assertWorkbenchContentMutationAllowed } from "./workbenchDeliveryState.js";

type ToolResult<T> = { ok: true } & T | { ok: false; error: ToolError };

export interface RevisionInstruction {
  summary: string;
  prompt_delta: string;
  negative_delta: string;
  priority: "low" | "medium" | "high";
}

function hardGateConfirmed(confirmation?: Confirmation): boolean {
  return confirmation?.confirmation_level === "hard_gate" && confirmation.user_confirmed === true;
}

function findClipVersion(shot: Shot, artifactId: string) {
  return shot.clip_versions.find((version) => version.artifact_id === artifactId);
}

function validateGeneratedClip(db: M0Database, artifactId: string, shot: Shot): ToolError | null {
  const validated = validateActiveArtifactReference(db, {
    artifact_id: artifactId, project_id: shot.project_id, shot_id: shot.shot_id, role: "generated_clip", artifact_type: "video"
  });
  return validated.ok ? null : validated.error;
}

function databaseIsInTransaction(db: M0Database): boolean {
  return Boolean((db as unknown as { isTransaction?: boolean }).isTransaction);
}

function regenerationContext(
  db: M0Database,
  shotId: string,
  previousRunId: string
): ToolResult<{ shot: Shot; previous_run: GenerationRun; project: Project }> {
  const shot = getShot(db, shotId);
  if (!shot) return { ok: false, error: { code: "SHOT_NOT_FOUND", message: `Shot not found: ${shotId}` } };
  const writable = assertWorkbenchContentMutationAllowed(db, shot.project_id);
  if (!writable.ok) return { ok: false, error: writable.error };
  const previousRun = getGenerationRun(db, previousRunId);
  if (!previousRun) {
    return { ok: false, error: { code: "GENERATION_RUN_NOT_FOUND", message: `Previous run not found: ${previousRunId}` } };
  }
  if (previousRun.shot_id !== shot.shot_id || previousRun.project_id !== shot.project_id) {
    return { ok: false, error: { code: "GENERATION_RUN_BINDING_MISMATCH", message: "Previous run does not belong to the requested SHOT." } };
  }
  const project = getProject(db, shot.project_id);
  if (!project) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${shot.project_id}` } };
  const workflowGate = requireShotWorkflowWriteAction(db, project, shot, "regenerate");
  if (!workflowGate.ok) return { ok: false, error: workflowGate.error };
  const storyboard = validateActiveArtifactReference(db, {
    artifact_id: shot.storyboard_image_artifact_id,
    project_id: project.project_id,
    shot_id: shot.shot_id,
    role: "storyboard_image",
    artifact_type: "image"
  });
  if (!storyboard.ok) return { ok: false, error: storyboard.error };
  return { ok: true, shot, previous_run: previousRun, project };
}

export function markShotClipReview(
  input: {
    shot_id: string;
    artifact_id: string;
    decision: "approved" | "revision_needed";
    rejection_reasons?: string[];
    revision_instruction?: RevisionInstruction;
  },
  db = openM0Database()
): ToolResult<{ shot: Shot }> {
  const shot = getShot(db, input.shot_id);
  if (!shot) return { ok: false, error: { code: "SHOT_NOT_FOUND", message: `Shot not found: ${input.shot_id}` } };
  const writable = assertWorkbenchContentMutationAllowed(db, shot.project_id);
  if (!writable.ok) return { ok: false, error: writable.error };

  const artifactError = validateGeneratedClip(db, input.artifact_id, shot);
  if (artifactError) return { ok: false, error: artifactError };

  const clipVersion = findClipVersion(shot, input.artifact_id);
  if (!clipVersion) {
    return { ok: false, error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact is not a clip version for the shot." } };
  }

  if (input.decision === "approved") {
    const ownsTransaction = !(db as unknown as { isTransaction?: boolean }).isTransaction;
    if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      const attached = attachArtifactToShot({
        project_id: shot.project_id,
        shot_id: shot.shot_id,
        artifact_id: input.artifact_id,
        reference: "accepted_clip_artifact_id",
        expected_current_artifact_id: shot.accepted_clip_artifact_id
      }, db);
      if (!attached.ok) {
        if (ownsTransaction) db.exec("ROLLBACK");
        return attached;
      }
      const nextShot = attached.shot;
      nextShot.status = "approved";
      nextShot.review.approval_status = "approved";
      nextShot.review.rejection_reasons = [];
      nextShot.review.latest_revision_instruction = null;
      const nextVersion = findClipVersion(nextShot, input.artifact_id);
      if (!nextVersion) throw new Error("ARTIFACT_NOT_FOUND");
      nextVersion.review_status = "approved";
      saveShot(db, nextShot);
      if (ownsTransaction) db.exec("COMMIT");
      return { ok: true, shot: nextShot };
    } catch (error) {
      if (ownsTransaction && (db as unknown as { isTransaction?: boolean }).isTransaction) db.exec("ROLLBACK");
      return { ok: false, error: { code: "CLIP_REVIEW_TRANSACTION_FAILED", message: error instanceof Error ? error.message : "Clip review failed." } };
    }
  } else {
    shot.status = "revision_needed";
    shot.review.approval_status = "revision_needed";
    shot.review.rejection_reasons = input.rejection_reasons ?? [];
    shot.review.latest_revision_instruction = input.revision_instruction ?? null;
    clipVersion.review_status = "rejected";
  }

  saveShot(db, shot);
  return { ok: true, shot };
}

export async function regenerateShotVideo(
  input: {
    shot_id: string;
    previous_run_id: string;
    updated_prompt: string;
    updated_negative_prompt?: string;
    provider_execution?: ProviderExecutionRequest;
    confirmation?: Confirmation;
  },
  db = openM0Database()
): Promise<ToolResult<{ run: GenerationRun; artifact_id: string; shot: Shot }>> {
  if (!hardGateConfirmed(input.confirmation)) {
    return { ok: false, error: { code: "HARD_GATE_CONFIRMATION_REQUIRED", message: "Regeneration requires hard_gate confirmation." } };
  }

  if (!input.updated_prompt) {
    return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", message: "updated_prompt is required." } };
  }

  if (input.provider_execution
    && (input.provider_execution.provider !== "mock"
      || (input.provider_execution.provider_name !== undefined && input.provider_execution.provider_name !== "mock"))) {
    return { ok: false, error: { code: "LEGACY_REGENERATION_RETIRED", message: "Real-provider regeneration must use the persisted generation job worker and reconciliation boundary." } };
  }
  if (databaseIsInTransaction(db)) {
    return { ok: false, error: { code: "REGENERATION_TRANSACTION_UNSAFE", message: "Regeneration cannot await Provider work inside a caller-owned transaction." } };
  }
  const initialContext = regenerationContext(db, input.shot_id, input.previous_run_id);
  if (!initialContext.ok) return initialContext;

  const adapter = new MockVideoProviderAdapter();
  const job = await adapter.submitGeneration();
  if (!job.ok) {
    return { ok: false, error: { code: "GENERATION_PROVIDER_ERROR", message: job.error.message } };
  }
  let activatedArtifactId = "";
  let persistenceError: ToolError | null = null;
  try {
    db.exec("BEGIN IMMEDIATE");
    const current = regenerationContext(db, input.shot_id, input.previous_run_id);
    if (!current.ok) {
      persistenceError = current.error;
      throw new Error(current.error.code);
    }
    const { shot, previous_run: previousRun, project } = current;
    const attemptNumber = previousRun.versioning.attempt_number + 1;
    const run: GenerationRun = {
      run_id: `run_${randomUUID()}`,
      batch_id: previousRun.batch_id,
      project_id: project.project_id,
      shot_id: shot.shot_id,
      run_type: "regenerate_shot",
      status: "succeeded",
      input: {
        storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
        video_prompt: input.updated_prompt,
        negative_prompt: input.updated_negative_prompt ?? shot.negative_prompt,
        duration_seconds: shot.duration_seconds,
        aspect_ratio: project.video_spec.aspect_ratio,
        resolution: project.video_spec.resolution
      },
      output: { artifact_ids: [] },
      provider: {
        provider: "mock",
        provider_name: "mock",
        model_name: adapter.model_name,
        provider_job_id: job.provider_job_id,
        provider_status: job.provider_status
      },
      versioning: {
        attempt_number: attemptNumber,
        parent_run_id: previousRun.run_id
      },
      error: { code: "", message: "", retryable: false }
    };
    const artifactResult = registerMediaArtifact({
      artifact_type: "video",
      role: "generated_clip",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: project.project_id, shot_id: shot.shot_id },
      metadata: {
        duration_seconds: shot.duration_seconds,
        aspect_ratio: project.video_spec.aspect_ratio,
        width: 1080,
        height: 1920
      },
      provenance: { provider: "mock", provider_job_id: job.provider_job_id }
    }, db);
    if (!artifactResult.ok) {
      persistenceError = { code: "GENERATION_PROVIDER_ERROR", message: artifactResult.error.message };
      throw new Error(artifactResult.error.code);
    }
    activatedArtifactId = artifactResult.artifact.artifact_id;
    run.output.artifact_ids = [activatedArtifactId];
    shot.video_prompt = input.updated_prompt;
    shot.negative_prompt = input.updated_negative_prompt ?? shot.negative_prompt;
    shot.generation_run_ids.push(run.run_id);
    shot.status = "video_generated";
    shot.clip_versions.push({
      artifact_id: activatedArtifactId,
      run_id: run.run_id,
      attempt_number: attemptNumber,
      review_status: "pending"
    });
    saveGenerationRun(db, run);
    saveShot(db, shot);
    db.exec("COMMIT");
    cleanupCommittedMediaActivationMarkers(db, [activatedArtifactId]);
    return { ok: true, run, artifact_id: activatedArtifactId, shot };
  } catch {
    if (databaseIsInTransaction(db)) db.exec("ROLLBACK");
    if (activatedArtifactId) cleanupRolledBackMediaActivationFiles([activatedArtifactId]);
    return {
      ok: false,
      error: persistenceError ?? {
        code: "REGENERATION_PERSIST_FAILED",
        message: "Regeneration result could not be persisted atomically."
      }
    };
  }
}
