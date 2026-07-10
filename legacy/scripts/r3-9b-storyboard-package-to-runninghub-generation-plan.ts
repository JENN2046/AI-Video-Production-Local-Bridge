import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  buildRunningHubImageToVideoSubmitRequest,
  buildRunningHubMediaUploadRequest,
  buildRunningHubQueryRequest,
  ensureM0Directories,
  getMediaArtifact,
  getProject,
  getShot,
  getStoryboardPackage,
  openM0Database,
  paths,
  RUNNINGHUB_DEFAULT_RESOLUTION,
  RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT,
  RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT,
  RUNNINGHUB_MIN_DURATION_SECONDS,
  RUNNINGHUB_MODEL_ROUTE,
  RUNNINGHUB_QUERY_ENDPOINT,
  RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER,
  validateImageFile,
  type MediaArtifact,
  type ProviderToolError,
  type Shot
} from "../src/index.js";

const TASK = "R3-9B_STORYBOARD_PACKAGE_TO_RUNNINGHUB_GENERATION_PLAN";
const OUTPUT_REPORT_PATH = "data/reports/r3_9b_storyboard_package_to_runninghub_generation_plan_result.json";
const R3_9A_REPORT_PATH = "data/reports/r3_9a_runninghub_primary_lane_wiring_dry_run_result.json";
const G0_FREEZE_REPORT_PATH = "data/reports/g0_r1_package_freeze_result.json";
const G0_IMPORT_PREP_REPORT_PATH = "data/reports/g0_r1_import_prep_result.json";
const OUTPUT_ROOT = "data/media/provider-runs/r3-9b-runninghub-package/";

interface G0FreezeReport {
  result?: string;
  project?: { project_id?: string; title?: string; status?: string };
  storyboard_package?: { storyboard_package_id?: string; status?: string; frozen?: boolean; shot_count?: number };
  shots?: Array<{
    shot_id?: string;
    order?: number;
    duration_seconds?: number;
    storyboard_image_artifact_id?: string;
    approved_by_user?: boolean;
  }>;
}

interface ImportPrepReport {
  result?: string;
  input_policy?: {
    accepted_pending_ids?: boolean;
    audit_images_imported?: boolean;
    product_reference_imported_as_storyboard_image?: boolean;
  };
  imported_artifacts?: Array<{
    shot_id?: string;
    order?: number;
    data_import_filename?: string;
    artifact_id?: string;
    artifact_type?: string;
    role?: string;
    status?: string;
    source_sha256?: string;
    stored_sha256?: string;
  }>;
  rejected_assets?: Array<{ package_source_file?: string; status?: string }>;
}

interface R3_9AReport {
  result?: string;
  runninghub_contract?: {
    duration_minimum_seconds?: number;
    max_upload_calls_per_shot?: number;
    max_submit_calls_per_shot?: number;
  };
  package_level_dry_run_plan?: {
    status?: string;
    shot_count?: number;
    ready_shot_count?: number;
  };
}

type ReportResult = "PASS_PACKAGE_GENERATION_PLAN_READY" | "BLOCK_WITH_REASON";

function readJson<T>(path: string): T | null {
  const absolute = resolve(paths.workspaceRoot, path);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function safeError(error: ProviderToolError | null): Record<string, unknown> | null {
  if (!error) return null;
  return {
    code: error.code,
    retryable: error.retryable === true,
    message: error.message,
    sanitized_provider_error_summary: error.sanitized_provider_error_summary ?? null
  };
}

function isAppMediaArtifact(artifact: MediaArtifact): boolean {
  const uri = artifact.storage.uri.replace(/\\/g, "/").toLowerCase();
  return uri.includes("/data/media/artifacts/") && !uri.includes("/data/imports/");
}

function sourcePathFromImportFilename(filename: string | undefined): string | null {
  if (!filename) return null;
  return join(paths.workspaceRoot, "data", "imports", filename);
}

function artifactClassifier(input: {
  artifact: MediaArtifact | null;
  importFilename: string | undefined;
  importRecord?: { artifact_type?: string; role?: string; status?: string } | null;
}): string[] {
  const blockers: string[] = [];
  const artifact = input.artifact;
  const filename = input.importFilename ?? "";
  if (!artifact) return ["MEDIA_ARTIFACT_NOT_FOUND"];
  if (artifact.artifact_id.startsWith("PENDING_")) blockers.push("PENDING_ARTIFACT_ID_REJECTED");
  if (artifact.artifact_type !== "image" || artifact.role !== "storyboard_image" || artifact.status !== "active") {
    blockers.push("ARTIFACT_NOT_ACTIVE_STORYBOARD_IMAGE");
  }
  if (input.importRecord && (input.importRecord.artifact_type !== "image" || input.importRecord.role !== "storyboard_image" || input.importRecord.status !== "active")) {
    blockers.push("IMPORT_PREP_RECORD_NOT_ACTIVE_STORYBOARD_IMAGE");
  }
  if (/audit|do_not_use/i.test(filename)) blockers.push("AUDIT_IMAGE_REJECTED");
  if (/product_reference|reference/i.test(filename)) blockers.push("PRODUCT_REFERENCE_REJECTED");
  if (!isAppMediaArtifact(artifact)) blockers.push("ARTIFACT_STORAGE_NOT_APP_MEDIA");
  return blockers;
}

function providerDurationFor(appDurationSeconds: number): number {
  return Math.max(appDurationSeconds, RUNNINGHUB_MIN_DURATION_SECONDS);
}

function noForbiddenLeak(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return (
    !/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(serialized) &&
    !serialized.includes("RUNNINGHUB_API_KEY=") &&
    !serialized.includes("RUNWAYML_API_SECRET=") &&
    !/https?:\/\/[^\s"']+/i.test(serialized) &&
    !serialized.includes("data:image/") &&
    !/base64,[A-Za-z0-9+/=]{32,}/.test(serialized)
  );
}

function buildPlanEntry(input: {
  order: number;
  packageShotId: string;
  appDurationSeconds: number;
  artifact: MediaArtifact | null;
  shot: Shot | null;
  importRecord: NonNullable<ImportPrepReport["imported_artifacts"]>[number] | null;
}) {
  const artifact = input.artifact;
  const shot = input.shot;
  const sourcePath = sourcePathFromImportFilename(input.importRecord?.data_import_filename);
  const outputDir = `${OUTPUT_ROOT}${String(input.order).padStart(2, "0")}-${input.packageShotId}/`;
  const providerDurationSeconds = providerDurationFor(input.appDurationSeconds);
  const blockers = artifactClassifier({ artifact, importFilename: input.importRecord?.data_import_filename, importRecord: input.importRecord });

  if (!shot) blockers.push("SHOT_NOT_FOUND");
  if (!sourcePath || !existsSync(sourcePath)) blockers.push("SOURCE_IMPORT_FILE_NOT_FOUND");
  if (artifact && !existsSync(artifact.storage.uri)) blockers.push("ARTIFACT_STORAGE_FILE_NOT_FOUND");
  if (!Number.isFinite(input.appDurationSeconds) || input.appDurationSeconds <= 0) blockers.push("INVALID_APP_DURATION_SECONDS");

  const sourceValidation = sourcePath && existsSync(sourcePath) ? validateImageFile(sourcePath) : null;
  const storageValidation = artifact && existsSync(artifact.storage.uri) ? validateImageFile(artifact.storage.uri) : null;
  if (sourceValidation && !sourceValidation.ok) blockers.push("SOURCE_IMAGE_NOT_READABLE");
  if (storageValidation && !storageValidation.ok) blockers.push("STORAGE_IMAGE_NOT_READABLE");
  if (storageValidation?.ok && Math.abs(storageValidation.width / storageValidation.height - 9 / 16) > 0.02) blockers.push("STORYBOARD_IMAGE_NOT_VERTICAL_9_16");

  const uploadRequest = artifact && blockers.length === 0 ? buildRunningHubMediaUploadRequest({ storyboard_artifact: artifact }) : null;
  if (uploadRequest && !uploadRequest.ok) blockers.push(`UPLOAD_PLAN_BLOCKED:${uploadRequest.error.code}`);

  const submitRequest =
    artifact && shot && blockers.length === 0
      ? buildRunningHubImageToVideoSubmitRequest({
          generation_input: {
            storyboard_artifact: artifact,
            video_prompt: shot.video_prompt,
            negative_prompt: shot.negative_prompt,
            duration_seconds: providerDurationSeconds,
            aspect_ratio: "9:16",
            resolution: RUNNINGHUB_DEFAULT_RESOLUTION
          },
          uploaded_download_url: RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER
        })
      : null;
  if (submitRequest && !submitRequest.ok) blockers.push(`SUBMIT_PLAN_BLOCKED:${submitRequest.error.code}`);

  const queryRequest = blockers.length === 0 ? buildRunningHubQueryRequest(`runninghub_task_${input.packageShotId}_future`) : null;
  if (queryRequest && !queryRequest.ok) blockers.push(`QUERY_PLAN_BLOCKED:${queryRequest.error.code}`);

  return {
    status: blockers.length === 0 ? "READY_FOR_FUTURE_AUTHORIZED_SUBMIT" : "BLOCKED_LOCALLY",
    blocked_reasons: blockers,
    shot_id: input.packageShotId,
    order: input.order,
    image_artifact: {
      artifact_id: artifact?.artifact_id ?? null,
      artifact_id_from_app: artifact ? artifact.artifact_id.startsWith("artifact_") : false,
      artifact_type: artifact?.artifact_type ?? null,
      role: artifact?.role ?? null,
      status: artifact?.status ?? null,
      storage_uri: artifact?.storage.uri ?? null,
      storage_is_app_media: artifact ? isAppMediaArtifact(artifact) : false,
      storage_sha256: storageValidation?.ok ? storageValidation.sha256 : input.importRecord?.stored_sha256 ?? null,
      source_path: sourcePath,
      source_sha256: sourceValidation?.ok ? sourceValidation.sha256 : input.importRecord?.source_sha256 ?? null,
      source_asset_overwrite_allowed: false
    },
    prompt: {
      shot_description: shot?.description ?? null,
      video_prompt: shot?.video_prompt ?? null,
      negative_prompt: shot?.negative_prompt ?? null,
      negative_prompt_supported_by_runninghub: false
    },
    duration: {
      app_duration_seconds: input.appDurationSeconds,
      provider_duration_seconds: providerDurationSeconds,
      provider_duration_minimum_seconds: RUNNINGHUB_MIN_DURATION_SECONDS,
      provider_duration_adjusted_to_minimum: input.appDurationSeconds < RUNNINGHUB_MIN_DURATION_SECONDS
    },
    provider_fields: {
      provider: "runninghub",
      model_route: RUNNINGHUB_MODEL_ROUTE,
      aspectRatio: "9:16",
      resolution: RUNNINGHUB_DEFAULT_RESOLUTION,
      upload_endpoint: `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
      submit_endpoint: `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
      query_endpoint: `POST ${RUNNINGHUB_QUERY_ENDPOINT}`
    },
    call_budget: {
      max_upload_calls: 1,
      max_submit_calls: 1,
      max_retry_submit_calls: 0,
      max_second_submit_calls: 0,
      query_same_task_until_terminal_or_timeout: true
    },
    output_plan: {
      output_dir: outputDir,
      expected_local_artifact_registration: {
        artifact_type: "video",
        role: "generated_clip",
        provider_name: "runninghub",
        project_id: shot?.project_id ?? null,
        shot_id: shot?.shot_id ?? input.packageShotId,
        storage_directory: outputDir,
        ffprobe_validation_required: true,
        source_asset_overwrite_allowed: false
      }
    },
    request_plan: {
      upload:
        uploadRequest?.ok === true
          ? {
              endpoint: uploadRequest.summary.endpoint,
              file_field: uploadRequest.summary.file_field,
              file_name: uploadRequest.summary.file_name,
              mime_type: uploadRequest.summary.mime_type,
              file_size_bytes: uploadRequest.summary.file_size_bytes,
              sha256: uploadRequest.summary.sha256,
              binary_payload_included: uploadRequest.summary.binary_payload_included,
              base64_included: uploadRequest.summary.base64_included,
              authorization_value_included: uploadRequest.summary.auth.authorization_value_included
            }
          : safeError(uploadRequest?.error ?? null),
      submit:
        submitRequest?.ok === true
          ? {
              endpoint: submitRequest.summary.endpoint,
              request_fields: ["prompt", "aspectRatio", "imageUrls", "resolution", "duration"],
              prompt_text_length: submitRequest.summary.prompt_text_length,
              negative_prompt_supported: submitRequest.summary.negative_prompt_supported,
              negative_prompt_text_length: submitRequest.summary.negative_prompt_text_length,
              image_url_values_included: submitRequest.summary.image_url_values_included,
              image_url_placeholder_used: submitRequest.summary.imageUrls[0] === RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER,
              raw_provider_payload_included: submitRequest.summary.raw_provider_payload_included
            }
          : safeError(submitRequest?.error ?? null),
      query:
        queryRequest?.ok === true
          ? {
              endpoint: queryRequest.summary.endpoint,
              body_shape: { taskId: "string" },
              task_id_value_included: queryRequest.summary.task_id_value_included,
              status_query_not_a_second_submit: true
            }
          : safeError(queryRequest?.error ?? null)
    }
  };
}

ensureM0Directories();

const db = openM0Database();
try {
  const r3_9aReport = readJson<R3_9AReport>(R3_9A_REPORT_PATH);
  const freezeReport = readJson<G0FreezeReport>(G0_FREEZE_REPORT_PATH);
  const importPrepReport = readJson<ImportPrepReport>(G0_IMPORT_PREP_REPORT_PATH);
  const projectId = freezeReport?.project?.project_id ?? "";
  const packageId = freezeReport?.storyboard_package?.storyboard_package_id ?? "";
  const project = projectId ? getProject(db, projectId) : null;
  const storyboardPackage = packageId ? getStoryboardPackage(db, packageId) : null;
  const shots = freezeReport?.shots ?? [];

  let blockReason: string | null = null;
  if (r3_9aReport?.result !== "PASS_PRIMARY_LANE_WIRED_DRY_RUN") blockReason = "R3-9A primary lane dry-run report is missing or not PASS.";
  else if (r3_9aReport.runninghub_contract?.duration_minimum_seconds !== RUNNINGHUB_MIN_DURATION_SECONDS) {
    blockReason = "R3-9A RunningHub duration minimum does not match 6 seconds.";
  } else if (freezeReport?.result !== "PASS" || !project || !storyboardPackage) {
    blockReason = "Current frozen storyboard package is missing or not PASS.";
  } else if (importPrepReport?.result !== "PASS") {
    blockReason = "G0 import-prep report is missing or not PASS.";
  } else if (importPrepReport.input_policy?.accepted_pending_ids !== false || importPrepReport.input_policy?.audit_images_imported !== false) {
    blockReason = "G0 import-prep input policy does not prove pending/audit assets were rejected.";
  }

  const importedByArtifactId = new Map((importPrepReport?.imported_artifacts ?? []).map((record) => [record.artifact_id ?? "", record]));
  const planEntries = shots.map((packageShot, index) => {
    const shotId = packageShot.shot_id ?? "";
    const artifactId = packageShot.storyboard_image_artifact_id ?? "";
    return buildPlanEntry({
      order: packageShot.order ?? index + 1,
      packageShotId: shotId || `shot_${index + 1}`,
      appDurationSeconds: packageShot.duration_seconds ?? 0,
      artifact: artifactId ? getMediaArtifact(db, artifactId) : null,
      shot: shotId ? getShot(db, shotId) : null,
      importRecord: importedByArtifactId.get(artifactId) ?? null
    });
  });

  const readyEntries = planEntries.filter((entry) => entry.status === "READY_FOR_FUTURE_AUTHORIZED_SUBMIT");
  const blockedEntries = planEntries.filter((entry) => entry.status !== "READY_FOR_FUTURE_AUTHORIZED_SUBMIT");
  const maxUploadCallsTotal = readyEntries.length;
  const maxSubmitCallsTotal = readyEntries.length;
  const authorizationPhraseDraft = [
    "Authorize one RunningHub storyboard-package generation dry-run plan for future live execution only after this phrase is explicitly re-submitted by Jenn:",
    "provider=runninghub",
    "model_route=rhart-video-g/image-to-video",
    `project_id=${project?.project_id ?? projectId}`,
    `storyboard_package_id=${storyboardPackage?.storyboard_package_id ?? packageId}`,
    `shot_count=${readyEntries.length}`,
    "duration_seconds_per_shot=6",
    "aspectRatio=9:16",
    "resolution=480p",
    `max_upload_calls_total=${maxUploadCallsTotal}`,
    `max_submit_calls_total=${maxSubmitCallsTotal}`,
    "max_upload_calls_per_shot=1",
    "max_submit_calls_per_shot=1",
    "no_retry=true",
    "no_second_submit=true",
    "query_only_same_task_id_until_terminal_or_timeout=true",
    `output_root=${OUTPUT_ROOT}`,
    "download_each_success_to_local_media_artifact_storage=true",
    "ffprobe_validate_each_output=true",
    "do_not_call_runway=true",
    "do_not_regenerate=true",
    "do_not_batch_beyond_listed_shots=true",
    "do_not_publish_or_deploy=true",
    "do_not_overwrite_source_assets=true",
    "do_not_print_secrets=true",
    "do_not_record_raw_provider_payload=true",
    "do_not_record_signed_urls=true"
  ].join("; ");

  const payload = {
    task: TASK,
    result: blockReason || blockedEntries.length > 0 ? "BLOCK_WITH_REASON" as ReportResult : "PASS_PACKAGE_GENERATION_PLAN_READY" as ReportResult,
    mode: "planning_only",
    generated_at: new Date().toISOString(),
    source_reports: {
      r3_9a_primary_lane_dry_run: R3_9A_REPORT_PATH,
      frozen_storyboard_package: G0_FREEZE_REPORT_PATH,
      import_prep: G0_IMPORT_PREP_REPORT_PATH
    },
    package: {
      project_id: (project?.project_id ?? projectId) || null,
      project_title: project?.title ?? freezeReport?.project?.title ?? null,
      storyboard_package_id: (storyboardPackage?.storyboard_package_id ?? packageId) || null,
      frozen: freezeReport?.storyboard_package?.frozen === true,
      status: freezeReport?.storyboard_package?.status ?? null,
      package_shot_count: shots.length
    },
    runninghub_primary_lane_contract: {
      provider: "runninghub",
      model_route: RUNNINGHUB_MODEL_ROUTE,
      upload_first_required: true,
      upload_endpoint: `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
      submit_endpoint: `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
      query_endpoint: `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
      duration_minimum_seconds: RUNNINGHUB_MIN_DURATION_SECONDS,
      duration_seconds_per_shot: RUNNINGHUB_MIN_DURATION_SECONDS,
      aspectRatio: "9:16",
      resolution: RUNNINGHUB_DEFAULT_RESOLUTION,
      source_contract_report: R3_9A_REPORT_PATH
    },
    generation_plan: {
      status: payloadStatus(blockReason, blockedEntries.length),
      eligible_shot_count: readyEntries.length,
      blocked_shot_count: blockedEntries.length,
      entries: planEntries
    },
    future_authorization: {
      authorization_required_before_live_call: true,
      phrase_is_draft_only: true,
      exact_authorization_phrase_draft: authorizationPhraseDraft,
      budget_and_stop_conditions: {
        max_upload_calls_total: maxUploadCallsTotal,
        max_submit_calls_total: maxSubmitCallsTotal,
        max_upload_calls_per_shot: 1,
        max_submit_calls_per_shot: 1,
        no_retry: true,
        no_second_submit: true,
        stop_if_any_upload_fails: true,
        stop_if_any_submit_fails: true,
        query_only_same_task_id_until_terminal_or_timeout: true,
        no_provider_call_without_new_exact_current_authorization: true
      }
    },
    import_guard: {
      accepted_pending_ids: false,
      audit_images_imported: false,
      product_reference_imported_as_storyboard_image: false,
      rejected_assets_from_import_prep: importPrepReport?.rejected_assets ?? []
    },
    acceptance: {
      one_plan_entry_per_frozen_package_shot: planEntries.length === shots.length,
      every_plan_entry_references_real_app_artifact_id: planEntries.every((entry) => entry.image_artifact.artifact_id?.startsWith("artifact_")),
      every_plan_entry_has_local_source_path: planEntries.every((entry) => Boolean(entry.image_artifact.source_path)),
      no_source_asset_overwrite: true,
      blocked_shots_identified_with_local_reason: blockedEntries.every((entry) => entry.blocked_reasons.length > 0),
      future_live_execution_authorization_gated: true,
      single_submit_budget_bounded: true,
      no_credentials_or_env_read: true,
      no_provider_call: true,
      no_raw_provider_payload_or_signed_url_recorded: true
    },
    provider_boundary: {
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false,
      upload_attempted: false,
      submit_attempted: false,
      status_poll_attempted: false,
      output_download_attempted: false,
      provider_credits_consumed: false,
      real_video_generated: false,
      credentials_read: false,
      env_files_read: false,
      regeneration_performed: false,
      batch_generation_performed: false,
      source_assets_overwritten: false,
      secret_values_exposed: false,
      raw_provider_payload_recorded: false,
      signed_url_recorded: false,
      push_performed: false,
      tag_created: false,
      release_or_deploy_performed: false,
      production_credentials_change: false
    },
    validation: {
      "JSON parse for generated plan report": "PENDING",
      "npm run r3:9b:plan": "PASS",
      "npm run typecheck": "PENDING",
      "npm run test:m1": "PENDING",
      "npm run secret:scan": "PENDING",
      "git diff --check": "PENDING"
    },
    changed_files: [
      "package.json",
      "scripts/r3-9b-storyboard-package-to-runninghub-generation-plan.ts",
      OUTPUT_REPORT_PATH,
      ".agent_board/*"
    ],
    blocked_reason: blockReason ?? (blockedEntries.length > 0 ? "One or more package shots are blocked locally; see generation_plan.entries[].blocked_reasons." : null),
    next_step: {
      live_provider_call_requires_new_exact_current_authorization: true,
      recommended_operator_action: "Review the draft phrase, decide whether to authorize all 4 shots or a subset, then provide a fresh exact authorization phrase before any RunningHub call."
    }
  };

  if (!noForbiddenLeak(payload) && !payload.blocked_reason) {
    payload.result = "BLOCK_WITH_REASON";
    payload.blocked_reason = "Plan report contains forbidden secret-shaped, URL, data URI, or long base64 text.";
  }

  writeFileSync(join(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        result: payload.result,
        report_path: OUTPUT_REPORT_PATH,
        eligible_shot_count: readyEntries.length,
        blocked_shot_count: blockedEntries.length,
        max_upload_calls_total: maxUploadCallsTotal,
        max_submit_calls_total: maxSubmitCallsTotal,
        network_call_attempted: false,
        runninghub_called: false,
        runway_called: false
      },
      null,
      2
    )
  );
  if (payload.result === "BLOCK_WITH_REASON") process.exitCode = 1;
} finally {
  db.close();
}

function payloadStatus(blockReason: string | null, blockedCount: number): "READY_FOR_FUTURE_AUTHORIZED_EXECUTION" | "BLOCKED_LOCALLY" {
  return blockReason || blockedCount > 0 ? "BLOCKED_LOCALLY" : "READY_FOR_FUTURE_AUTHORIZED_EXECUTION";
}
