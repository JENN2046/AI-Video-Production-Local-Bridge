import { randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getMediaArtifact, registerMediaArtifact, validateActiveArtifactReference } from "./mediaArtifacts.js";
import { getProject, getProjectStatus, getShot, listProjectShots, saveProject, saveShot, type Project, type Shot, type ToolError } from "./projects.js";
import { getStoryboardPackage } from "./storyboardPackages.js";
import { providerError, selectM0Provider, selectM1ProviderPort, type ProviderExecutionRequest, type ProviderPortName, type ProviderToolError } from "./provider.js";
import { downloadProviderOutputToArtifact } from "./providerOutputDownloader.js";
import { validateMp4File, type Mp4ValidationResult } from "./mediaValidity.js";
import {
  buildRunwayImageToVideoRequest,
  MockVideoProviderAdapter,
  RunwayVideoProviderAdapter,
  RunningHubVideoProviderAdapter,
  type ProviderGenerationInput,
  type ProviderJobStatus,
  type VideoProviderAdapter
} from "./videoProviderAdapters.js";

export type GenerationRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type GenerationBatchStatus = GenerationRunStatus | "partially_failed";

export interface Confirmation {
  confirmation_level: "hard_gate" | "explicit";
  user_confirmed: boolean;
}

export interface GenerationBatch {
  batch_id: string;
  project_id: string;
  storyboard_package_id: string;
  run_ids: string[];
  status: GenerationBatchStatus;
  summary: {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
  };
}

export interface GenerationRun {
  run_id: string;
  batch_id: string;
  project_id: string;
  shot_id: string;
  run_type: "image_to_video" | "regenerate_shot" | "assemble_video";
  status: GenerationRunStatus;
  input: {
    storyboard_image_artifact_id: string;
    video_prompt: string;
    negative_prompt: string;
    duration_seconds: number;
    aspect_ratio: string;
    resolution: string;
  };
  output: {
    artifact_ids: string[];
  };
  provider: {
    provider: "mock" | "real";
    provider_name: ProviderPortName;
    model_name: string;
    provider_job_id: string;
    provider_status: string;
  };
  versioning: {
    attempt_number: number;
    parent_run_id: string;
  };
  error: {
    code: string;
    message: string;
    retryable: boolean;
    sanitized_provider_error_summary?: ProviderToolError["sanitized_provider_error_summary"];
  };
}

type ToolResult<T> = { ok: true } & T | { ok: false; error: ToolError };

export interface PackageShotGenerationInput {
  project_id: string;
  storyboard_package_id: string;
  shot_id: string;
  provider_execution?: ProviderExecutionRequest;
  confirmation?: Confirmation;
  allow_live_provider?: boolean;
}

export interface PackageShotProviderRequestSummary {
  provider: "runway";
  endpoint: string;
  x_runway_version: string;
  project_aspect_ratio: string;
  runway_ratio: string;
  duration_seconds: number;
  prompt_text_present: boolean;
  prompt_image_source_artifact_id: string;
  prompt_image_storage_is_app_media: boolean;
  raw_data_imports_provider_input: false;
}

export type PackageShotGenerationResult = ToolResult<{
  batch: GenerationBatch;
  run: GenerationRun;
  generated_artifact_id: string | null;
  ffprobe: Mp4ValidationResult | null;
  provider_request_summary: PackageShotProviderRequestSummary | null;
}>;

function isHardGateConfirmed(confirmation?: Confirmation): boolean {
  return confirmation?.confirmation_level === "hard_gate" && confirmation.user_confirmed === true;
}

export function saveGenerationBatch(db: M0Database, batch: GenerationBatch): void {
  db.prepare(`
    INSERT OR REPLACE INTO generation_batches (batch_id, project_id, storyboard_package_id, data_json, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(batch.batch_id, batch.project_id, batch.storyboard_package_id, JSON.stringify(batch));
}

export function saveGenerationRun(db: M0Database, run: GenerationRun): void {
  db.prepare(`
    INSERT OR REPLACE INTO generation_runs (run_id, batch_id, project_id, shot_id, run_type, status, data_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(run.run_id, run.batch_id, run.project_id, run.shot_id, run.run_type, run.status, JSON.stringify(run));
}

export function getGenerationBatch(db: M0Database, batchId: string): GenerationBatch | null {
  const row = db.prepare("SELECT data_json FROM generation_batches WHERE batch_id = ?").get(batchId) as { data_json: string } | undefined;
  return row ? (JSON.parse(row.data_json) as GenerationBatch) : null;
}

export function getGenerationRun(db: M0Database, runId: string): GenerationRun | null {
  const row = db.prepare("SELECT data_json FROM generation_runs WHERE run_id = ?").get(runId) as { data_json: string } | undefined;
  return row ? (JSON.parse(row.data_json) as GenerationRun) : null;
}

export function listBatchRuns(db: M0Database, batchId: string): GenerationRun[] {
  const rows = db.prepare("SELECT data_json FROM generation_runs WHERE batch_id = ? ORDER BY created_at").all(batchId) as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as GenerationRun);
}

function summarizeRuns(runs: GenerationRun[]): GenerationBatch["summary"] {
  return {
    total: runs.length,
    queued: runs.filter((run) => run.status === "queued").length,
    running: runs.filter((run) => run.status === "running").length,
    succeeded: runs.filter((run) => run.status === "succeeded").length,
    failed: runs.filter((run) => run.status === "failed").length
  };
}

function batchStatusFromSummary(summary: GenerationBatch["summary"]): GenerationBatchStatus {
  if (summary.failed > 0 && summary.succeeded > 0) return "partially_failed";
  if (summary.failed > 0) return "failed";
  if (summary.running > 0) return "running";
  if (summary.queued > 0) return "queued";
  return "succeeded";
}

export interface MockProviderJob {
  provider_job_id: string;
  status: "succeeded";
  fixture_path: string;
}

export function submitMockGeneration(): MockProviderJob {
  return {
    provider_job_id: `mock_job_${randomUUID()}`,
    status: "succeeded",
    fixture_path: "video/mock_clip.mp4"
  };
}

export function pollMockStatus(job: MockProviderJob): "succeeded" {
  return job.status;
}

export function fetchMockOutput(job: MockProviderJob): string {
  return job.fixture_path;
}

function createGeneratedClipArtifact(db: M0Database, project: Project, shot: Shot, job = submitMockGeneration()) {
  pollMockStatus(job);
  return registerMediaArtifact(
    {
      artifact_type: "video",
      role: "generated_clip",
      source: {
        kind: "fixture_path",
        path: fetchMockOutput(job)
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
}

function generationRunStatusFromProvider(status: ProviderJobStatus): GenerationRunStatus {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "cancelled") return "cancelled";
  return status;
}

function providerErrorToRunError(error: ProviderToolError): GenerationRun["error"] {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable === true,
    ...(error.sanitized_provider_error_summary ? { sanitized_provider_error_summary: error.sanitized_provider_error_summary } : {})
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function adapterForSelectedProvider(providerName: ProviderPortName, credential?: string): VideoProviderAdapter {
  if (providerName === "runway") return new RunwayVideoProviderAdapter({ credential: credential ?? "" });
  if (providerName === "runninghub") return new RunningHubVideoProviderAdapter({ credential: credential ?? "" });
  return new MockVideoProviderAdapter();
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

function providerInputFromShotWithDb(db: M0Database, project: Project, shot: Shot): ProviderGenerationInput | { error: ProviderToolError } {
  const storyboardArtifact = validateActiveArtifactReference(db, {
    artifact_id: shot.storyboard_image_artifact_id,
    project_id: project.project_id,
    shot_id: shot.shot_id,
    role: "storyboard_image",
    artifact_type: "image"
  });
  if (!storyboardArtifact.ok) return { error: providerError(storyboardArtifact.error.code, storyboardArtifact.error.message) };

  return {
    storyboard_artifact: storyboardArtifact.artifact,
    video_prompt: shot.video_prompt,
    negative_prompt: shot.negative_prompt,
    duration_seconds: shot.duration_seconds,
    aspect_ratio: project.video_spec.aspect_ratio,
    resolution: project.video_spec.resolution
  };
}

function isAppMediaProviderInput(uri: string): boolean {
  const normalized = uri.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/data/media/artifacts/") && !normalized.includes("/data/imports/");
}

function runwayRequestSummaryForShot(db: M0Database, project: Project, shot: Shot): PackageShotProviderRequestSummary | { error: ToolError } {
  const providerInput = providerInputFromShotWithDb(db, project, shot);
  if ("error" in providerInput) {
    return { error: { code: providerInput.error.code, message: providerInput.error.message } };
  }

  if (!isAppMediaProviderInput(providerInput.storyboard_artifact.storage.uri)) {
    return {
      error: {
        code: "RAW_IMPORTS_PROVIDER_INPUT_BLOCKED",
        message: "Provider input must use app-controlled media artifact storage, not raw data/imports paths."
      }
    };
  }

  const request = buildRunwayImageToVideoRequest(providerInput);
  if (!request.ok) return { error: { code: request.error.code, message: request.error.message } };

  return {
    provider: "runway",
    endpoint: request.endpoint,
    x_runway_version: request.headers["X-Runway-Version"],
    project_aspect_ratio: providerInput.aspect_ratio,
    runway_ratio: request.body.ratio,
    duration_seconds: request.body.duration,
    prompt_text_present: request.body.promptText.trim().length > 0,
    prompt_image_source_artifact_id: providerInput.storyboard_artifact.artifact_id,
    prompt_image_storage_is_app_media: true,
    raw_data_imports_provider_input: false
  };
}

export async function createGenerationRunFromPackageShot(
  input: PackageShotGenerationInput,
  db = openM0Database()
): Promise<PackageShotGenerationResult> {
  if (input.provider_execution?.provider === "real" && input.allow_live_provider !== true) {
    return {
      ok: false,
      error: {
        code: "LIVE_PROVIDER_AUTHORIZATION_REQUIRED",
        message: "Live provider submit requires a separate exact authorization path."
      }
    };
  }

  const project = getProject(db, input.project_id);
  if (!project) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${input.project_id}` } };

  const storyboardPackage = getStoryboardPackage(db, input.storyboard_package_id);
  if (!storyboardPackage) {
    return { ok: false, error: { code: "STORYBOARD_PACKAGE_NOT_FOUND", message: `Storyboard Package not found: ${input.storyboard_package_id}` } };
  }
  if (storyboardPackage.project_id !== project.project_id) {
    return { ok: false, error: { code: "STORYBOARD_PACKAGE_PROJECT_MISMATCH", message: "Storyboard Package does not belong to the requested project." } };
  }

  const shot = getShot(db, input.shot_id);
  if (!shot || shot.project_id !== project.project_id) {
    return { ok: false, error: { code: "SHOT_NOT_FOUND", message: `Shot not found in project: ${input.shot_id}` } };
  }

  const shotInPackage = storyboardPackage.approved_shot_snapshots.some((snapshot) =>
    snapshot.shot_id
      ? snapshot.shot_id === shot.shot_id
      : snapshot.order === shot.order && snapshot.storyboard_image_artifact_id === shot.storyboard_image_artifact_id
  );
  if (!shotInPackage) {
    return { ok: false, error: { code: "SHOT_NOT_IN_STORYBOARD_PACKAGE", message: `Shot is not in frozen Storyboard Package: ${shot.shot_id}` } };
  }

  const providerRequestSummary = runwayRequestSummaryForShot(db, project, shot);
  if (providerRequestSummary && "error" in providerRequestSummary) return { ok: false, error: providerRequestSummary.error };

  const generation = await startStoryboardVideoGeneration(
    {
      project_id: project.project_id,
      storyboard_package_id: storyboardPackage.storyboard_package_id,
      selected_shot_ids: [shot.shot_id],
      provider_execution: input.provider_execution,
      confirmation: input.confirmation
    },
    db
  );
  if (!generation.ok) return generation;

  const run = generation.runs[0];
  const generatedArtifactId = run.output.artifact_ids[0] ?? null;
  const generatedArtifact = generatedArtifactId ? getMediaArtifact(db, generatedArtifactId) : null;
  const ffprobe = generatedArtifact ? validateMp4File(generatedArtifact.storage.uri) : null;

  return {
    ok: true,
    batch: generation.batch,
    run,
    generated_artifact_id: generatedArtifactId,
    ffprobe,
    provider_request_summary: providerRequestSummary
  };
}

export async function startStoryboardVideoGeneration(
  input: {
    project_id: string;
    storyboard_package_id?: string;
    provider?: "mock" | "real";
    provider_execution?: ProviderExecutionRequest;
    selected_shot_ids?: string[];
    confirmation?: Confirmation;
    provider_output_storage_directory?: string;
    allow_live_provider?: boolean;
  },
  db = openM0Database()
): Promise<ToolResult<{ batch: GenerationBatch; runs: GenerationRun[] }>> {
  if (!isHardGateConfirmed(input.confirmation)) {
    return { ok: false, error: { code: "HARD_GATE_CONFIRMATION_REQUIRED", message: "Generation requires hard_gate confirmation." } };
  }

  const providerSelection = input.provider_execution
    ? selectM1ProviderPort(input.provider_execution)
    : selectM0Provider(input.provider ?? "mock");
  if (!providerSelection.ok) return { ok: false, error: providerSelection.error };
  const selectedProvider =
    "selected" in providerSelection
      ? providerSelection.selected
      : {
          provider: "mock" as const,
          provider_name: "mock" as const,
          config: {
            provider_name: "mock" as const,
            model_name: "mock_fixture"
          },
          credential: undefined
        };
  if (selectedProvider.provider === "real" && input.allow_live_provider !== true) {
    return { ok: false, error: { code: "PROVIDER_DISABLED", message: "Legacy batch generation cannot call a real provider. Use the V2 single-SHOT intent flow or an explicitly authorized canary." } };
  }
  const adapter = adapterForSelectedProvider(selectedProvider.provider_name, selectedProvider.credential);

  const project = getProject(db, input.project_id);
  if (!project) {
    return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${input.project_id}` } };
  }

  const storyboardPackageId = input.storyboard_package_id || project.active_storyboard_package_id;
  const storyboardPackage = getStoryboardPackage(db, storyboardPackageId);
  if (!storyboardPackage) {
    return { ok: false, error: { code: "STORYBOARD_PACKAGE_NOT_FOUND", message: `Storyboard Package not found: ${storyboardPackageId}` } };
  }

  const allShots = listProjectShots(db, project.project_id);
  const shots = input.selected_shot_ids?.length
    ? allShots.filter((shot) => input.selected_shot_ids?.includes(shot.shot_id))
    : allShots;
  if (!shots.length) {
    return { ok: false, error: { code: "STORYBOARD_PACKAGE_NOT_READY", message: "No shots are ready for generation." } };
  }

  const batchId = `batch_${randomUUID()}`;
  const runs: GenerationRun[] = [];

  for (const shot of shots) {
    const storyboardArtifact = validateActiveArtifactReference(db, {
      artifact_id: shot.storyboard_image_artifact_id, project_id: project.project_id, shot_id: shot.shot_id, role: "storyboard_image", artifact_type: "image"
    });
    if (!storyboardArtifact.ok) return { ok: false, error: storyboardArtifact.error };

    const run: GenerationRun = {
      run_id: `run_${randomUUID()}`,
      batch_id: batchId,
      project_id: project.project_id,
      shot_id: shot.shot_id,
      run_type: "image_to_video",
      status: "running",
      input: {
        storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
        video_prompt: shot.video_prompt,
        negative_prompt: shot.negative_prompt,
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
        attempt_number: 1,
        parent_run_id: ""
      },
      error: {
        code: "",
        message: "",
        retryable: false
      }
    };

    if (selectedProvider.provider_name === "mock") {
      const job = submitMockGeneration();
      const artifactResult = createGeneratedClipArtifact(db, project, shot, job);
      if (!artifactResult.ok) {
        return { ok: false, error: { code: "GENERATION_PROVIDER_ERROR", message: artifactResult.error.message } };
      }
      run.status = "succeeded";
      run.output.artifact_ids = [artifactResult.artifact.artifact_id];
      run.provider.provider_job_id = job.provider_job_id;
      run.provider.provider_status = job.status;
    } else {
      const providerInput = providerInputFromShotWithDb(db, project, shot);
      if ("error" in providerInput) {
        run.status = "failed";
        run.error = providerErrorToRunError(providerInput.error);
      } else {
        const submit = await adapter.submitGeneration(providerInput);
        if (!submit.ok) {
          run.status = "failed";
          run.error = providerErrorToRunError(submit.error);
        } else {
          run.provider.provider_job_id = submit.provider_job_id;
          run.provider.provider_status = submit.provider_status;
          const providerStatus = await pollProviderUntilComplete(adapter, submit.provider_job_id);
          if (!providerStatus.ok) {
            run.status = "failed";
            run.error = providerErrorToRunError(providerStatus.error);
          } else {
            run.status = generationRunStatusFromProvider(providerStatus.status);
            run.provider.provider_status = providerStatus.provider_status;
            if (providerStatus.status !== "succeeded") {
              run.error = {
                code: providerStatus.status === "cancelled" ? "PROVIDER_REQUEST_FAILED" : "PROVIDER_REQUEST_FAILED",
                message: `Provider task ended with status ${providerStatus.provider_status}.`,
                retryable: providerStatus.retryable
              };
            } else {
              const output = providerStatus.output_url
                ? { ok: true as const, provider_job_id: submit.provider_job_id, output_url: providerStatus.output_url, provider_status: providerStatus.provider_status }
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
                    aspect_ratio: project.video_spec.aspect_ratio,
                    storage_directory: input.provider_output_storage_directory
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

    shot.generation_run_ids.push(run.run_id);
    if (run.status === "succeeded" && run.output.artifact_ids.length > 0) {
      shot.status = "video_generated";
      shot.clip_versions.push({
        artifact_id: run.output.artifact_ids[0],
        run_id: run.run_id,
        attempt_number: 1,
        review_status: "pending"
      });
    } else if (run.status === "failed") {
      shot.status = "video_pending";
    }
    saveShot(db, shot);
    saveGenerationRun(db, run);
    runs.push(run);
  }

  const summary = summarizeRuns(runs);
  const batch: GenerationBatch = {
    batch_id: batchId,
    project_id: project.project_id,
    storyboard_package_id: storyboardPackage.storyboard_package_id,
    run_ids: runs.map((run) => run.run_id),
    status: batchStatusFromSummary(summary),
    summary
  };

  project.status = summary.succeeded > 0 ? "video_review" : "video_generation_in_progress";
  project.generation_batch_ids.push(batch.batch_id);
  saveProject(db, project);
  saveGenerationBatch(db, batch);

  return { ok: true, batch, runs };
}

export function getGenerationStatus(
  input: {
    project_id?: string;
    batch_id?: string;
    run_id?: string;
  },
  db = openM0Database()
) {
  if (input.run_id) {
    const run = getGenerationRun(db, input.run_id);
    if (!run) return { ok: false as const, error: { code: "GENERATION_RUN_NOT_FOUND", message: `Run not found: ${input.run_id}` } };
    return { ok: true as const, run };
  }

  if (input.batch_id) {
    const batch = getGenerationBatch(db, input.batch_id);
    if (!batch) return { ok: false as const, error: { code: "GENERATION_BATCH_NOT_FOUND", message: `Batch not found: ${input.batch_id}` } };
    return { ok: true as const, batch, runs: listBatchRuns(db, input.batch_id) };
  }

  if (input.project_id) {
    const status = getProjectStatus({ project_id: input.project_id }, db);
    if (!status.ok) return status;
    const batches = status.project.generation_batch_ids.map((batchId) => getGenerationBatch(db, batchId)).filter((batch): batch is GenerationBatch => batch !== null);
    const runs = batches.flatMap((batch) => listBatchRuns(db, batch.batch_id));
    return { ok: true as const, project_id: input.project_id, batches, runs, summary: status };
  }

  return { ok: false as const, error: { code: "MISSING_REQUIRED_FIELD", message: "project_id, batch_id, or run_id is required." } };
}
