import { randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getMediaArtifact, registerMediaArtifact } from "./mediaArtifacts.js";
import { getGenerationRun, saveGenerationRun, type Confirmation, type GenerationRun } from "./generation.js";
import { getProject, getShot, saveShot, type Shot, type ToolError } from "./projects.js";
import { providerError, selectM1ProviderPort, type ProviderExecutionRequest, type ProviderPortName, type ProviderToolError } from "./provider.js";
import { downloadProviderOutputToArtifact } from "./providerOutputDownloader.js";
import {
  MockVideoProviderAdapter,
  RunwayVideoProviderAdapter,
  RunningHubVideoProviderAdapter,
  type ProviderGenerationInput,
  type ProviderJobStatus,
  type VideoProviderAdapter
} from "./videoProviderAdapters.js";

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

function validateGeneratedClip(db: M0Database, artifactId: string): ToolError | null {
  const artifact = getMediaArtifact(db, artifactId);
  if (!artifact) return { code: "ARTIFACT_NOT_FOUND", message: `Artifact not found: ${artifactId}` };
  if (artifact.status !== "active") return { code: "ARTIFACT_INACCESSIBLE", message: `Artifact is not active: ${artifact.status}` };
  if (artifact.artifact_type !== "video" || artifact.role !== "generated_clip") {
    return { code: "INVALID_ARTIFACT_ROLE", message: "Shot review requires active generated_clip video artifacts." };
  }
  return null;
}

function generationRunStatusFromProvider(status: ProviderJobStatus): GenerationRun["status"] {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "cancelled") return "cancelled";
  return status;
}

function providerErrorToRunError(error: ProviderToolError): GenerationRun["error"] {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable === true
  };
}

function adapterForProvider(providerName: ProviderPortName, credential?: string): VideoProviderAdapter {
  if (providerName === "runway") return new RunwayVideoProviderAdapter({ credential: credential ?? "" });
  if (providerName === "runninghub") return new RunningHubVideoProviderAdapter();
  return new MockVideoProviderAdapter();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function pollProviderUntilComplete(adapter: VideoProviderAdapter, providerJobId: string) {
  const maxAttempts = adapter.provider_name === "mock" ? 1 : 120;
  const intervalMs = adapter.provider_name === "mock" ? 0 : 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await adapter.pollStatus(providerJobId);
    if (!status.ok) return status;
    if (status.status === "succeeded" || status.status === "failed" || status.status === "cancelled") return status;
    if (attempt < maxAttempts - 1) await delay(intervalMs);
  }

  return { ok: false as const, error: providerError("PROVIDER_TIMEOUT", "Provider task did not complete before timeout.", true) };
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

  const artifactError = validateGeneratedClip(db, input.artifact_id);
  if (artifactError) return { ok: false, error: artifactError };

  const clipVersion = findClipVersion(shot, input.artifact_id);
  if (!clipVersion) {
    return { ok: false, error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact is not a clip version for the shot." } };
  }

  if (input.decision === "approved") {
    shot.accepted_clip_artifact_id = input.artifact_id;
    shot.status = "approved";
    shot.review.approval_status = "approved";
    shot.review.rejection_reasons = [];
    shot.review.latest_revision_instruction = null;
    clipVersion.review_status = "approved";
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

  const shot = getShot(db, input.shot_id);
  if (!shot) return { ok: false, error: { code: "SHOT_NOT_FOUND", message: `Shot not found: ${input.shot_id}` } };

  const previousRun = getGenerationRun(db, input.previous_run_id);
  if (!previousRun) {
    return { ok: false, error: { code: "GENERATION_RUN_NOT_FOUND", message: `Previous run not found: ${input.previous_run_id}` } };
  }

  const project = getProject(db, shot.project_id);
  if (!project) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${shot.project_id}` } };

  const providerSelection = selectM1ProviderPort(input.provider_execution);
  if (!providerSelection.ok) return { ok: false, error: providerSelection.error };
  const selectedProvider = providerSelection.selected;
  const adapter = adapterForProvider(selectedProvider.provider_name, selectedProvider.credential);
  const attemptNumber = previousRun.versioning.attempt_number + 1;
  const run: GenerationRun = {
    run_id: `run_${randomUUID()}`,
    batch_id: previousRun.batch_id,
    project_id: project.project_id,
    shot_id: shot.shot_id,
    run_type: "regenerate_shot",
    status: "running",
    input: {
      storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
      video_prompt: input.updated_prompt,
      negative_prompt: input.updated_negative_prompt ?? shot.negative_prompt,
      duration_seconds: shot.duration_seconds,
      aspect_ratio: project.video_spec.aspect_ratio,
      resolution: project.video_spec.resolution
    },
    output: {
      artifact_ids: []
    },
    provider: {
      provider: selectedProvider.provider,
      provider_name: selectedProvider.provider_name,
      model_name: adapter.model_name,
      provider_job_id: "",
      provider_status: "not_submitted"
    },
    versioning: {
      attempt_number: attemptNumber,
      parent_run_id: previousRun.run_id
    },
    error: {
      code: "",
      message: "",
      retryable: false
    }
  };

  if (selectedProvider.provider_name === "mock") {
    const job = await adapter.submitGeneration({
      storyboard_artifact: getMediaArtifact(db, shot.storyboard_image_artifact_id) as NonNullable<ReturnType<typeof getMediaArtifact>>,
      video_prompt: input.updated_prompt,
      negative_prompt: input.updated_negative_prompt ?? shot.negative_prompt,
      duration_seconds: shot.duration_seconds,
      aspect_ratio: project.video_spec.aspect_ratio,
      resolution: project.video_spec.resolution
    });
    if (!job.ok) {
      return { ok: false, error: { code: "GENERATION_PROVIDER_ERROR", message: job.error.message } };
    }
    const artifactResult = registerMediaArtifact(
      {
        artifact_type: "video",
        role: "generated_clip",
        source: {
          kind: "fixture_path",
          path: "video/mock_clip.mp4"
        },
        linked_objects: {
          project_id: project.project_id,
          shot_id: shot.shot_id
        },
        metadata: {
          duration_seconds: shot.duration_seconds,
          aspect_ratio: project.video_spec.aspect_ratio,
          width: 1080,
          height: 1920
        },
        provenance: {
          provider: "mock",
          provider_job_id: job.provider_job_id
        }
      },
      db
    );
    if (!artifactResult.ok) {
      return { ok: false, error: { code: "GENERATION_PROVIDER_ERROR", message: artifactResult.error.message } };
    }
    run.status = "succeeded";
    run.output.artifact_ids = [artifactResult.artifact.artifact_id];
    run.provider.provider_job_id = job.provider_job_id;
    run.provider.provider_status = job.provider_status;
  } else {
    const storyboardArtifact = getMediaArtifact(db, shot.storyboard_image_artifact_id);
    if (!storyboardArtifact) {
      run.status = "failed";
      run.error = providerErrorToRunError(providerError("PROVIDER_UNSUPPORTED_INPUT", "Storyboard artifact is missing."));
    } else {
      const providerInput: ProviderGenerationInput = {
        storyboard_artifact: storyboardArtifact,
        video_prompt: input.updated_prompt,
        negative_prompt: input.updated_negative_prompt ?? shot.negative_prompt,
        duration_seconds: shot.duration_seconds,
        aspect_ratio: project.video_spec.aspect_ratio,
        resolution: project.video_spec.resolution
      };
      const submit = await adapter.submitGeneration(providerInput);
      if (!submit.ok) {
        run.status = "failed";
        run.error = providerErrorToRunError(submit.error);
      } else {
        run.provider.provider_job_id = submit.provider_job_id;
        run.provider.provider_status = submit.provider_status;
        const status = await pollProviderUntilComplete(adapter, submit.provider_job_id);
        if (!status.ok) {
          run.status = "failed";
          run.error = providerErrorToRunError(status.error);
        } else {
          run.status = generationRunStatusFromProvider(status.status);
          run.provider.provider_status = status.provider_status;
          if (status.status !== "succeeded") {
            run.error = {
              code: "PROVIDER_REQUEST_FAILED",
              message: `Provider task ended with status ${status.provider_status}.`,
              retryable: status.retryable
            };
          } else {
            const output = status.output_url
              ? { ok: true as const, provider_job_id: submit.provider_job_id, output_url: status.output_url, provider_status: status.provider_status }
              : await adapter.fetchOutput(submit.provider_job_id);
            if (!output.ok) {
              run.status = "failed";
              run.error = providerErrorToRunError(output.error);
            } else {
              const download = await downloadProviderOutputToArtifact(
                {
                  url: output.output_url,
                  provider_name: selectedProvider.provider_name,
                  provider_job_id: submit.provider_job_id,
                  project_id: project.project_id,
                  shot_id: shot.shot_id,
                  duration_seconds: shot.duration_seconds,
                  aspect_ratio: project.video_spec.aspect_ratio
                },
                db
              );
              if (!download.ok) {
                run.status = "failed";
                run.error = providerErrorToRunError(download.error);
              } else {
                run.status = "succeeded";
                run.output.artifact_ids = [download.artifact.artifact_id];
                run.provider.provider_status = output.provider_status;
              }
            }
          }
        }
      }
    }
  }

  shot.video_prompt = input.updated_prompt;
  shot.negative_prompt = input.updated_negative_prompt ?? shot.negative_prompt;
  shot.generation_run_ids.push(run.run_id);
  if (run.status === "succeeded" && run.output.artifact_ids.length > 0) {
    shot.status = "video_generated";
    shot.clip_versions.push({
      artifact_id: run.output.artifact_ids[0],
      run_id: run.run_id,
      attempt_number: attemptNumber,
      review_status: "pending"
    });
  } else if (run.status === "failed") {
    shot.status = "revision_needed";
  }
  saveGenerationRun(db, run);
  saveShot(db, shot);

  return { ok: true, run, artifact_id: run.output.artifact_ids[0] ?? "", shot };
}
