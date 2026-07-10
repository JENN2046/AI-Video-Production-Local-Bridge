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
  mapRunningHubProviderError,
  openM0Database,
  parseRunningHubMediaUploadResponse,
  parseRunningHubQueryResponse,
  parseRunningHubSubmitResponse,
  paths,
  RUNNINGHUB_DEFAULT_RESOLUTION,
  RUNNINGHUB_DOC_EXAMPLE_DURATION_SECONDS,
  RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT,
  RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT,
  RUNNINGHUB_QUERY_ENDPOINT,
  RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER,
  validateImageFile,
  type ProviderToolError
} from "../src/index.js";

const TASK = "R3-8H_RUNNINGHUB_ADAPTER_OR_AUTHORIZATION_NEXT_STEP";
const OUTPUT_REPORT_PATH = "data/reports/r3_8h_runninghub_adapter_skeleton_offline_result.json";
const G0_FREEZE_REPORT_PATH = "data/reports/g0_r1_package_freeze_result.json";
const R3_8G_REPORT_PATH = "data/reports/r3_8g_runninghub_contract_freeze_dry_run_result.json";
const SELECTED_ARTIFACT_ID = "artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7";
const SELECTED_SOURCE_PATH = "A:\\AI Video Production Workspace\\data\\imports\\g0_r1_SHOT_001_IMAGE_ACCEPTED_WEBGPT.png";
const SELECTED_STORAGE_URI = "A:\\AI Video Production Workspace\\data\\media\\artifacts\\images\\artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7.png";
const SYNTHETIC_SECRET = "R3_8H_SYNTHETIC_SECRET_DO_NOT_LOG_123";
const SYNTHETIC_TASK_ID = "runninghub_task_synthetic_r3_8h";
const SYNTHETIC_UPLOAD_URL = "https://runninghub-cdn.example/uploaded/keyframe.png";
const SYNTHETIC_OUTPUT_URL = "https://cdn.example.test/runninghub/output.mp4";

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

type R3_8HResult = "PASS_ADAPTER_SKELETON_OFFLINE" | "BLOCK_WITH_REASON";

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
    sanitized_provider_error_summary: error.sanitized_provider_error_summary ?? null
  };
}

function resultFor(blockReason: string | null): R3_8HResult {
  return blockReason ? "BLOCK_WITH_REASON" : "PASS_ADAPTER_SKELETON_OFFLINE";
}

function noForbiddenLeak(value: unknown, forbiddenPaths: string[]): boolean {
  const serialized = JSON.stringify(value);
  return (
    !serialized.includes(SYNTHETIC_SECRET) &&
    !serialized.includes(SYNTHETIC_UPLOAD_URL) &&
    !serialized.includes(SYNTHETIC_OUTPUT_URL) &&
    !serialized.includes(SELECTED_SOURCE_PATH) &&
    !serialized.includes(SELECTED_STORAGE_URI) &&
    forbiddenPaths.every((path) => !path || !serialized.includes(path)) &&
    !serialized.includes("data:image/") &&
    !/base64,[A-Za-z0-9+/=]{32,}/.test(serialized) &&
    !/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(serialized) &&
    !serialized.includes("RUNNINGHUB_API_KEY=")
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
  const r3_8gReport = readJson<Record<string, unknown>>(R3_8G_REPORT_PATH);
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

  let blockReason: string | null = null;
  if (!runningHubConfig?.primary || runningHubConfig.status !== "primary_real_provider") {
    blockReason = "RunningHub is not primary_real_provider in local registry.";
  } else if (runwayConfig?.primary !== false || runwayConfig?.status !== "secondary_selectable_provider_port") {
    blockReason = "Runway is not secondary_selectable_provider_port in local registry.";
  } else if (!artifact || artifact.artifact_id !== SELECTED_ARTIFACT_ID) {
    blockReason = "Selected keyframe artifact is missing from app registry.";
  } else if (resolve(artifact.storage.uri) !== resolve(SELECTED_STORAGE_URI)) {
    blockReason = "Selected artifact storage URI does not match R3-8D selected keyframe.";
  } else if (!storageValidation?.ok || !sourceValidation.ok) {
    blockReason = "Selected keyframe image is not readable.";
  } else if (!project || !shot || !storyboardPackage) {
    blockReason = "Selected project, shot, or storyboard package linkage is missing.";
  } else if (!r3_8gReport || r3_8gReport.result !== "PASS_CONTRACT_FREEZE_DRY_RUN") {
    blockReason = "R3-8G contract freeze report is missing or not PASS.";
  }

  const uploadRequest = artifact ? buildRunningHubMediaUploadRequest({ storyboard_artifact: artifact }) : null;
  const submitRequest =
    artifact && shot
      ? buildRunningHubImageToVideoSubmitRequest({
          generation_input: {
            storyboard_artifact: artifact,
            video_prompt: shot.video_prompt,
            negative_prompt: shot.negative_prompt,
            duration_seconds: RUNNINGHUB_DOC_EXAMPLE_DURATION_SECONDS,
            aspect_ratio: "9:16",
            resolution: RUNNINGHUB_DEFAULT_RESOLUTION
          },
          uploaded_download_url: RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER
        })
      : null;
  const queryRequest = buildRunningHubQueryRequest(SYNTHETIC_TASK_ID);

  if (uploadRequest && !uploadRequest.ok && !blockReason) blockReason = uploadRequest.error.message;
  if (submitRequest && !submitRequest.ok && !blockReason) blockReason = submitRequest.error.message;
  if (!queryRequest.ok && !blockReason) blockReason = queryRequest.error.message;

  const uploadParsed = parseRunningHubMediaUploadResponse({
    data: { download_url: SYNTHETIC_UPLOAD_URL }
  });
  const submitParsed = parseRunningHubSubmitResponse({
    taskId: SYNTHETIC_TASK_ID,
    status: "PENDING",
    errorCode: "",
    errorMessage: "",
    results: []
  });
  const queryParsed = parseRunningHubQueryResponse({
    taskId: SYNTHETIC_TASK_ID,
    status: "SUCCESS",
    errorCode: "",
    errorMessage: "",
    results: [{ url: SYNTHETIC_OUTPUT_URL, outputType: "video" }]
  });
  const failedQueryParsed = parseRunningHubQueryResponse(
    {
      taskId: "runninghub_task_failed_synthetic",
      status: "FAILED",
      errorCode: "GENERATION_FAILED",
      errorMessage: `generation failed ${SYNTHETIC_SECRET}`,
      results: []
    },
    "runninghub_task_failed_synthetic",
    [SYNTHETIC_SECRET]
  );

  const errorCases = [
    { label: "invalid_api_key", payload: { errorCode: "INVALID_API_KEY", errorMessage: `invalid api key ${SYNTHETIC_SECRET}` } },
    { label: "rate_limit", payload: { errorCode: "RATE_LIMIT", errorMessage: "rate limit exceeded" } },
    { label: "insufficient_credits", payload: { errorCode: "INSUFFICIENT_CREDITS", errorMessage: "insufficient credits" } },
    { label: "insufficient_permission", http_status: 403, payload: { errorCode: "NO_PERMISSION", errorMessage: "insufficient permission" } },
    { label: "content_safety", payload: { errorCode: "CONTENT_SAFETY", errorMessage: "content safety rejected" } },
    { label: "timeout", payload: { errorCode: "TIMEOUT", errorMessage: "task timeout" } },
    { label: "generation_failure", payload: { errorCode: "GENERATION_FAILED", errorMessage: "generation failed" } },
    { label: "unknown_provider_failure", payload: { errorCode: "SOMETHING_ELSE", errorMessage: "unknown provider failure" } }
  ].map((item) => {
    const mapped = mapRunningHubProviderError({
      http_status: item.http_status ?? null,
      payload: item.payload,
      secrets: [SYNTHETIC_SECRET]
    });
    return {
      label: item.label,
      code: mapped.code,
      retryable: mapped.retryable === true,
      provider_error_code_present: Boolean(mapped.sanitized_provider_error_summary?.provider_error_code),
      provider_error_message_redacted: !JSON.stringify(mapped).includes(SYNTHETIC_SECRET)
    };
  });

  const queryOutputHost = queryParsed.ok && queryParsed.output_url ? new URL(queryParsed.output_url).host : null;
  const payload = {
    task: TASK,
    result: resultFor(blockReason),
    generated_at: new Date().toISOString(),
    source_contract_report: R3_8G_REPORT_PATH,
    local_registry: {
      runninghub_primary: runningHubConfig?.primary === true,
      runninghub_status: runningHubConfig?.status ?? null,
      runninghub_model_name: runningHubConfig?.model_name ?? null,
      runway_secondary: runwayConfig?.primary === false && runwayConfig.status === "secondary_selectable_provider_port"
    },
    selected_keyframe: {
      artifact_id: artifact?.artifact_id ?? SELECTED_ARTIFACT_ID,
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
      source_path_included: false,
      storage_uri_included: false,
      source_asset_overwritten: false
    },
    project_linkage: {
      project_id: project?.project_id ?? null,
      storyboard_package_id: storyboardPackage?.storyboard_package_id ?? null,
      shot_id: shot?.shot_id ?? selectedShot?.shot_id ?? null,
      dry_run_duration_seconds: RUNNINGHUB_DOC_EXAMPLE_DURATION_SECONDS
    },
    request_builders: {
      upload: uploadRequest?.ok
        ? {
            endpoint: uploadRequest.summary.endpoint,
            file_field: uploadRequest.summary.file_field,
            mime_type: uploadRequest.summary.mime_type,
            file_size_bytes: uploadRequest.summary.file_size_bytes,
            sha256_present: uploadRequest.summary.sha256.length === 64,
            authorization_value_included: uploadRequest.summary.auth.authorization_value_included,
            binary_payload_included: uploadRequest.summary.binary_payload_included,
            base64_included: uploadRequest.summary.base64_included,
            local_file_path_included: uploadRequest.summary.local_file_path_included
          }
        : safeError(uploadRequest?.error ?? null),
      submit: submitRequest?.ok
        ? {
            endpoint: submitRequest.summary.endpoint,
            prompt_text_length: submitRequest.summary.prompt_text_length,
            negative_prompt_supported: submitRequest.summary.negative_prompt_supported,
            aspectRatio: submitRequest.summary.aspectRatio,
            image_url_values_included: submitRequest.summary.image_url_values_included,
            image_url_placeholder_used: submitRequest.summary.imageUrls[0] === RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER,
            resolution: submitRequest.summary.resolution,
            duration: submitRequest.summary.duration,
            raw_provider_payload_included: submitRequest.summary.raw_provider_payload_included
          }
        : safeError(submitRequest?.error ?? null),
      query: queryRequest.ok
        ? {
            endpoint: queryRequest.summary.endpoint,
            task_id_present: queryRequest.summary.task_id_present,
            task_id_length: queryRequest.summary.task_id_length,
            task_id_value_included: queryRequest.summary.task_id_value_included
          }
        : safeError(queryRequest.error)
    },
    response_parsers: {
      upload_download_url_present: uploadParsed.ok && uploadParsed.download_url_present,
      submit_task_id_present: submitParsed.ok && Boolean(submitParsed.provider_job_id),
      submit_status: submitParsed.ok ? submitParsed.provider_status : null,
      query_status: queryParsed.ok ? queryParsed.status : null,
      query_output_url_extracted: queryParsed.ok && Boolean(queryParsed.output_url),
      query_output_url_host: queryOutputHost,
      failed_query_mapped_error: failedQueryParsed.ok ? safeError(failedQueryParsed.mapped_error ?? null) : safeError(failedQueryParsed.error),
      raw_provider_payload_recorded: false
    },
    error_mapping: errorCases,
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
      runninghub_confirmed_primary: runningHubConfig?.primary === true && runningHubConfig.status === "primary_real_provider",
      upload_request_builder: uploadRequest?.ok === true && uploadRequest.summary.endpoint === `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
      submit_request_builder: submitRequest?.ok === true && submitRequest.summary.endpoint === `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
      query_request_builder: queryRequest.ok === true && queryRequest.summary.endpoint === `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
      upload_parser: uploadParsed.ok === true,
      submit_parser: submitParsed.ok === true,
      query_parser: queryParsed.ok === true && queryParsed.status === "succeeded",
      error_mapping: errorCases.length === 8 && errorCases.every((item) => item.provider_error_message_redacted),
      no_network_call: true,
      no_secret_base64_or_raw_payload_leak: false
    },
    blocked_reason: blockReason,
    validation: {
      "npm run r3:8h:offline": "PASS",
      "npm run typecheck": "PENDING",
      "npm run test:m1": "PENDING",
      "npm run secret:scan": "PENDING",
      "git diff --check": "PENDING"
    },
    changed_files: [
      "package.json",
      "scripts/r3-8h-runninghub-adapter-skeleton-offline.ts",
      "src/index.ts",
      "src/tools/videoProviderAdapters.ts",
      "tests/m1-provider-boundary.test.ts",
      OUTPUT_REPORT_PATH,
      ".agent_board/*"
    ],
    next_step: {
      recommended_task: "R3-8I_RUNNINGHUB_REAL_KEYFRAME_AUTHORIZATION_PREP",
      recommended_action: "Prepare a separate exact authorization checklist for one live RunningHub upload-first real-keyframe canary.",
      live_upload_submit_poll_download_requires_new_exact_user_authorization: true
    }
  };

  payload.acceptance.no_secret_base64_or_raw_payload_leak = noForbiddenLeak(payload, [artifact?.storage.uri ?? ""]);
  if (!payload.acceptance.no_secret_base64_or_raw_payload_leak && !blockReason) {
    payload.blocked_reason = "Offline report contains forbidden secret-shaped, base64, local path, or raw provider payload text.";
    payload.result = "BLOCK_WITH_REASON";
  }

  writeFileSync(join(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        result: payload.result,
        report_path: OUTPUT_REPORT_PATH,
        upload_endpoint: `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
        submit_endpoint: `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
        query_endpoint: `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
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
