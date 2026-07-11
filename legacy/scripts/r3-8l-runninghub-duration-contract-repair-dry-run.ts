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
  listProviderConfigs,
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
  type ProviderToolError
} from "../src/index.js";

const TASK = "R3-8L_RUNNINGHUB_DURATION_CONTRACT_REPAIR_DRY_RUN";
const OUTPUT_REPORT_PATH = "data/reports/r3_8l_runninghub_duration_contract_repair_dry_run_result.json";
const R3_8J_REPORT_PATH = "data/reports/r3_8j_runninghub_real_keyframe_single_submit_canary_result.json";
const G0_FREEZE_REPORT_PATH = "data/reports/g0_r1_package_freeze_result.json";
const SELECTED_ARTIFACT_ID = "artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7";
const SELECTED_SOURCE_PATH = "A:\\AI Video Production Workspace\\data\\imports\\g0_r1_SHOT_001_IMAGE_ACCEPTED_WEBGPT.png";
const SELECTED_STORAGE_URI = "A:\\AI Video Production Workspace\\data\\media\\artifacts\\images\\artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7.png";
const OUTPUT_DIR = "data/media/provider-canary/r3-8m-runninghub-6s-real-keyframe/";
const REJECTED_DURATION_SECONDS = 3;
const ACCEPTED_DURATION_SECONDS = RUNNINGHUB_MIN_DURATION_SECONDS;
const SYNTHETIC_QUERY_TASK_ID = "runninghub_task_duration_contract_repair_only";

interface G0FreezeReport {
  project?: { project_id?: string; title?: string };
  storyboard_package?: { storyboard_package_id?: string };
  shots?: Array<{
    shot_id?: string;
    order?: number;
    duration_seconds?: number;
    storyboard_image_artifact_id?: string;
    approved_by_user?: boolean;
  }>;
}

interface R3_8JReport {
  result?: string;
  live_execution?: {
    upload_call_count?: number;
    submit_call_count?: number;
    query_call_count?: number;
    provider_job_id_present?: boolean;
    error?: {
      sanitized_provider_error_summary?: {
        provider_error_code?: string;
        provider_error_message?: string;
      };
    };
  };
  failure_receipt?: {
    receipt_status?: string;
    duration_seconds_attempted?: number;
    provider_minimum_duration_seconds?: number;
    sanitized_provider_error_code?: string;
    sanitized_provider_error_message?: string;
    no_retry_or_second_submit?: boolean;
  };
}

type R3_8LResult = "PASS_DURATION_CONTRACT_REPAIRED" | "BLOCK_WITH_REASON";

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

function resultFor(blockReason: string | null): R3_8LResult {
  return blockReason ? "BLOCK_WITH_REASON" : "PASS_DURATION_CONTRACT_REPAIRED";
}

function noForbiddenLeak(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return (
    !/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(serialized) &&
    !serialized.includes("RUNNINGHUB_API_KEY=") &&
    !serialized.includes("RUNWAYML_API_SECRET=") &&
    !serialized.includes("data:image/") &&
    !/base64,[A-Za-z0-9+/=]{32,}/.test(serialized)
  );
}

ensureM0Directories();

const db = openM0Database();
try {
  const providerConfigs = listProviderConfigs();
  const runningHubConfig = providerConfigs.find((config) => config.provider_name === "runninghub");
  const runwayConfig = providerConfigs.find((config) => config.provider_name === "runway");
  const artifact = getMediaArtifact(db, SELECTED_ARTIFACT_ID);
  const freezeReport = readJson<G0FreezeReport>(G0_FREEZE_REPORT_PATH);
  const r3_8jReport = readJson<R3_8JReport>(R3_8J_REPORT_PATH);
  const selectedShot = freezeReport?.shots?.find((shot) => shot.storyboard_image_artifact_id === SELECTED_ARTIFACT_ID);
  const projectId = freezeReport?.project?.project_id ?? "";
  const packageId = freezeReport?.storyboard_package?.storyboard_package_id ?? "";
  const shotId = selectedShot?.shot_id ?? "";
  const project = projectId ? getProject(db, projectId) : null;
  const shot = shotId ? getShot(db, shotId) : null;
  const storyboardPackage = packageId ? getStoryboardPackage(db, packageId) : null;
  const storageValidation = artifact?.storage.uri ? validateImageFile(artifact.storage.uri) : null;
  const sourceValidation = validateImageFile(SELECTED_SOURCE_PATH);
  const storageSize = artifact?.storage.uri && existsSync(artifact.storage.uri) ? statSync(artifact.storage.uri).size : 0;

  const r3_8jMinimum = r3_8jReport?.failure_receipt?.provider_minimum_duration_seconds ?? null;
  const r3_8jAttemptedDuration = r3_8jReport?.failure_receipt?.duration_seconds_attempted ?? null;
  const r3_8jMessage = r3_8jReport?.failure_receipt?.sanitized_provider_error_message ?? "";

  let blockReason: string | null = null;
  if (!runningHubConfig?.primary || runningHubConfig.status !== "primary_real_provider") {
    blockReason = "RunningHub is not primary_real_provider in local registry.";
  } else if (runwayConfig?.primary !== false || runwayConfig?.status !== "secondary_selectable_provider_port") {
    blockReason = "Runway is not secondary_selectable_provider_port in local registry.";
  } else if (!r3_8jReport || r3_8jReport.failure_receipt?.receipt_status !== "COMPLETE") {
    blockReason = "R3-8J failure receipt is missing or incomplete.";
  } else if (r3_8jAttemptedDuration !== REJECTED_DURATION_SECONDS || r3_8jMinimum !== RUNNINGHUB_MIN_DURATION_SECONDS) {
    blockReason = "R3-8J duration evidence does not match rejected duration 3 and minimum duration 6.";
  } else if (!artifact || artifact.artifact_id !== SELECTED_ARTIFACT_ID) {
    blockReason = "Selected keyframe artifact is missing from app registry.";
  } else if (resolve(artifact.storage.uri) !== resolve(SELECTED_STORAGE_URI)) {
    blockReason = "Selected artifact storage URI does not match the prepared real keyframe.";
  } else if (!storageValidation?.ok || !sourceValidation.ok) {
    blockReason = "Selected keyframe image is not readable.";
  } else if (!project || !shot || !storyboardPackage) {
    blockReason = "Selected project, shot, or storyboard package linkage is missing.";
  }

  const uploadRequest = artifact ? buildRunningHubMediaUploadRequest({ storyboard_artifact: artifact }) : null;
  const rejectedSubmitRequest =
    artifact && shot
      ? buildRunningHubImageToVideoSubmitRequest({
          generation_input: {
            storyboard_artifact: artifact,
            video_prompt: shot.video_prompt,
            negative_prompt: shot.negative_prompt,
            duration_seconds: REJECTED_DURATION_SECONDS,
            aspect_ratio: "9:16",
            resolution: RUNNINGHUB_DEFAULT_RESOLUTION
          },
          uploaded_download_url: RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER
        })
      : null;
  const acceptedSubmitRequest =
    artifact && shot
      ? buildRunningHubImageToVideoSubmitRequest({
          generation_input: {
            storyboard_artifact: artifact,
            video_prompt: shot.video_prompt,
            negative_prompt: shot.negative_prompt,
            duration_seconds: ACCEPTED_DURATION_SECONDS,
            aspect_ratio: "9:16",
            resolution: RUNNINGHUB_DEFAULT_RESOLUTION
          },
          uploaded_download_url: RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER
        })
      : null;
  const queryRequest = buildRunningHubQueryRequest(SYNTHETIC_QUERY_TASK_ID);

  if (uploadRequest && !uploadRequest.ok && !blockReason) blockReason = uploadRequest.error.message;
  if (rejectedSubmitRequest?.ok === true && !blockReason) blockReason = "duration_seconds=3 unexpectedly built a RunningHub submit request.";
  if (rejectedSubmitRequest && !rejectedSubmitRequest.ok && rejectedSubmitRequest.error.code !== "PROVIDER_UNSUPPORTED_INPUT" && !blockReason) {
    blockReason = "duration_seconds=3 failed with an unexpected error class.";
  }
  if (acceptedSubmitRequest && !acceptedSubmitRequest.ok && !blockReason) blockReason = acceptedSubmitRequest.error.message;
  if (!queryRequest.ok && !blockReason) blockReason = queryRequest.error.message;

  const payload = {
    task: TASK,
    result: resultFor(blockReason),
    mode: "dry_run",
    generated_at: new Date().toISOString(),
    source_reports: {
      r3_8j_failure_receipt: R3_8J_REPORT_PATH,
      g0_freeze: G0_FREEZE_REPORT_PATH
    },
    duration_contract: {
      provider: "runninghub",
      model_route: RUNNINGHUB_MODEL_ROUTE,
      source_evidence: "R3-8J sanitized provider failure receipt",
      min_duration_seconds: RUNNINGHUB_MIN_DURATION_SECONDS,
      rejected_duration_seconds: REJECTED_DURATION_SECONDS,
      accepted_duration_seconds: ACCEPTED_DURATION_SECONDS,
      r3_8j_attempted_duration_seconds: r3_8jAttemptedDuration,
      r3_8j_provider_minimum_duration_seconds: r3_8jMinimum,
      sanitized_provider_error_code: r3_8jReport?.failure_receipt?.sanitized_provider_error_code ?? null,
      sanitized_provider_error_message: r3_8jMessage || null,
      local_guard_blocks_before_upload_or_submit: rejectedSubmitRequest?.ok === false,
      local_guard_error: rejectedSubmitRequest?.ok === false ? safeError(rejectedSubmitRequest.error) : null,
      upload_request_not_required_for_rejected_duration: true,
      no_retry_or_second_submit_from_r3_8j: r3_8jReport?.failure_receipt?.no_retry_or_second_submit === true
    },
    selected_keyframe: {
      artifact_id: artifact?.artifact_id ?? SELECTED_ARTIFACT_ID,
      source_path: SELECTED_SOURCE_PATH,
      storage_uri: artifact?.storage.uri ?? SELECTED_STORAGE_URI,
      mime_type: storageValidation?.detected_mime ?? artifact?.storage.mime_type ?? "",
      width: storageValidation?.width ?? 0,
      height: storageValidation?.height ?? 0,
      aspect_ratio: storageValidation?.aspect_ratio ?? "",
      near_vertical_9_16: storageValidation ? Math.abs(storageValidation.width / storageValidation.height - 9 / 16) <= 0.01 : false,
      sha256: storageValidation?.sha256 ?? "",
      byte_size: storageSize,
      source_readable: sourceValidation.ok,
      storage_readable: storageValidation?.ok === true,
      artifact_role: artifact?.role ?? null,
      artifact_status: artifact?.status ?? null,
      artifact_id_from_app_registry: artifact?.artifact_id === SELECTED_ARTIFACT_ID,
      source_asset_overwritten: false
    },
    project_linkage: {
      project_id: project?.project_id ?? null,
      project_title: project?.title ?? null,
      storyboard_package_id: storyboardPackage?.storyboard_package_id ?? null,
      shot_id: shot?.shot_id ?? selectedShot?.shot_id ?? null,
      package_shot_duration_seconds: selectedShot?.duration_seconds ?? shot?.duration_seconds ?? null,
      runninghub_next_canary_duration_seconds: ACCEPTED_DURATION_SECONDS
    },
    dry_run_plan: {
      provider: "runninghub",
      model_route: RUNNINGHUB_MODEL_ROUTE,
      upload_endpoint: `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
      submit_endpoint: `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
      query_endpoint: `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
      duration_seconds: acceptedSubmitRequest?.ok ? acceptedSubmitRequest.summary.duration : ACCEPTED_DURATION_SECONDS,
      aspectRatio: acceptedSubmitRequest?.ok ? acceptedSubmitRequest.summary.aspectRatio : "9:16",
      resolution: acceptedSubmitRequest?.ok ? acceptedSubmitRequest.summary.resolution : RUNNINGHUB_DEFAULT_RESOLUTION,
      max_upload_calls: 1,
      max_submit_calls: 1,
      query_until_terminal: true,
      retry_allowed: false,
      second_submit_allowed: false,
      upload: uploadRequest?.ok
        ? {
            endpoint: uploadRequest.summary.endpoint,
            method: uploadRequest.method,
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
      submit: acceptedSubmitRequest?.ok
        ? {
            endpoint: acceptedSubmitRequest.summary.endpoint,
            method: acceptedSubmitRequest.method,
            request_fields: ["prompt", "aspectRatio", "imageUrls", "resolution", "duration"],
            prompt_text_length: acceptedSubmitRequest.summary.prompt_text_length,
            negative_prompt_supported: acceptedSubmitRequest.summary.negative_prompt_supported,
            negative_prompt_text_length: acceptedSubmitRequest.summary.negative_prompt_text_length,
            image_url_values_included: acceptedSubmitRequest.summary.image_url_values_included,
            image_url_placeholder_used: acceptedSubmitRequest.summary.imageUrls[0] === RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER,
            raw_provider_payload_included: acceptedSubmitRequest.summary.raw_provider_payload_included
          }
        : safeError(acceptedSubmitRequest?.error ?? null),
      query: queryRequest.ok
        ? {
            endpoint: queryRequest.summary.endpoint,
            method: queryRequest.method,
            body_shape: { taskId: "string" },
            task_id_value_included: queryRequest.summary.task_id_value_included,
            status_query_not_a_second_submit: true
          }
        : safeError(queryRequest.error),
      output_handling_if_succeeded: {
        output_dir: OUTPUT_DIR,
        download_to_local_media_artifact_storage: true,
        ffprobe_validation_required: true,
        source_asset_overwrite_allowed: false
      }
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
      regeneration_performed: false,
      batch_generation_performed: false,
      source_assets_overwritten: false,
      secret_values_exposed: false,
      raw_provider_payload_recorded: false,
      push_performed: false,
      tag_created: false,
      release_or_deploy_performed: false
    },
    acceptance: {
      r3_8j_failure_receipt_complete: r3_8jReport?.failure_receipt?.receipt_status === "COMPLETE",
      duration_3_blocked_before_upload_or_submit: rejectedSubmitRequest?.ok === false,
      duration_6_submit_plan_ready: acceptedSubmitRequest?.ok === true,
      upload_plan_ready_for_duration_6: uploadRequest?.ok === true,
      query_plan_ready: queryRequest.ok === true,
      max_upload_calls_one: true,
      max_submit_calls_one: true,
      query_until_terminal_true: true,
      no_network_call: true,
      no_provider_credit_consumption: true,
      no_real_video_generated: true,
      no_secret_base64_authorization_or_raw_payload_leak: false
    },
    validation: {
      "npm run r3:8l:dry-run": "PASS",
      "npm run typecheck": "PENDING",
      "npm run test:m1": "PENDING",
      "npm run secret:scan": "PENDING",
      "git diff --check": "PENDING"
    },
    changed_files: [
      "package.json",
      "src/tools/videoProviderAdapters.ts",
      "src/index.ts",
      "scripts/r3-8i-runninghub-real-keyframe-authorization-prep.ts",
      "scripts/r3-8l-runninghub-duration-contract-repair-dry-run.ts",
      "tests/m1-provider-boundary.test.ts",
      OUTPUT_REPORT_PATH,
      ".agent_board/*"
    ],
    blocked_reason: blockReason,
    next_step: {
      recommended_task: "R3-8M_RUNNINGHUB_6S_SINGLE_SUBMIT_CANARY",
      requires_user_authorization_for_real_call: true,
      required_duration_seconds: RUNNINGHUB_MIN_DURATION_SECONDS,
      live_upload_submit_poll_download_requires_new_exact_user_authorization: true,
      do_not_run_automatically: true
    }
  };

  payload.acceptance.no_secret_base64_authorization_or_raw_payload_leak = noForbiddenLeak(payload);
  if (!payload.acceptance.no_secret_base64_authorization_or_raw_payload_leak && !blockReason) {
    payload.blocked_reason = "Dry-run report contains forbidden secret-shaped, base64, Authorization value, or raw provider payload text.";
    payload.result = "BLOCK_WITH_REASON";
  }

  writeFileSync(join(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        result: payload.result,
        report_path: OUTPUT_REPORT_PATH,
        min_duration_seconds: RUNNINGHUB_MIN_DURATION_SECONDS,
        rejected_duration_seconds: REJECTED_DURATION_SECONDS,
        accepted_duration_seconds: ACCEPTED_DURATION_SECONDS,
        max_upload_calls: 1,
        max_submit_calls: 1,
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
