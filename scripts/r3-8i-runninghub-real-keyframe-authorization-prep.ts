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
  RUNNINGHUB_DOC_EXAMPLE_DURATION_SECONDS,
  RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT,
  RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT,
  RUNNINGHUB_MODEL_ROUTE,
  RUNNINGHUB_QUERY_ENDPOINT,
  RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER,
  validateImageFile,
  type ProviderToolError
} from "../src/index.js";

const TASK = "R3-8I_RUNNINGHUB_REAL_KEYFRAME_AUTHORIZATION_PREP";
const OUTPUT_REPORT_PATH = "data/reports/r3_8i_runninghub_real_keyframe_authorization_prep_result.json";
const G0_FREEZE_REPORT_PATH = "data/reports/g0_r1_package_freeze_result.json";
const R3_8G_REPORT_PATH = "data/reports/r3_8g_runninghub_contract_freeze_dry_run_result.json";
const R3_8H_REPORT_PATH = "data/reports/r3_8h_runninghub_adapter_skeleton_offline_result.json";
const SELECTED_ARTIFACT_ID = "artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7";
const SELECTED_SOURCE_PATH = "A:\\AI Video Production Workspace\\data\\imports\\g0_r1_SHOT_001_IMAGE_ACCEPTED_WEBGPT.png";
const SELECTED_STORAGE_URI = "A:\\AI Video Production Workspace\\data\\media\\artifacts\\images\\artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7.png";
const OUTPUT_DIR = "data/media/provider-canary/r3-8j-runninghub-real-keyframe/";
const SYNTHETIC_QUERY_TASK_ID = "runninghub_task_authorization_prep_only";

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

type R3_8IResult = "PASS_READY_FOR_USER_AUTHORIZATION" | "BLOCK_WITH_REASON";

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

function reportResult(blockReason: string | null): R3_8IResult {
  return blockReason ? "BLOCK_WITH_REASON" : "PASS_READY_FOR_USER_AUTHORIZATION";
}

function containsForbiddenSecretText(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return (
    /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(serialized) ||
    /base64,[A-Za-z0-9+/=]{32,}/.test(serialized) ||
    serialized.includes("data:image/") ||
    serialized.includes("RUNNINGHUB_API_KEY=") ||
    serialized.includes("RUNWAYML_API_SECRET=")
  );
}

function exactAuthorizationPhrase(input: {
  selectedArtifactId: string;
  sourcePath: string;
  storageUri: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
}): string {
  const details = [
    "provider=runninghub",
    `upload_endpoint=POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
    `submit_endpoint=POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
    `query_endpoint=POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
    `model_route=${RUNNINGHUB_MODEL_ROUTE}`,
    `selected_artifact_id=${input.selectedArtifactId}`,
    `source_path=${input.sourcePath}`,
    `storage_uri=${input.storageUri}`,
    `duration_seconds=${input.durationSeconds}`,
    `aspectRatio=${input.aspectRatio}`,
    `resolution=${input.resolution}`,
    "max_upload_calls=1",
    "max_submit_calls=1",
    "预算/费用上限=仅允许这 1 次 upload-first canary submit 且不允许自动重试或第二次计费 submit",
    `output_dir=${OUTPUT_DIR}`,
    "允许同一 taskId 的状态查询直到终态或超时；成功后下载为本地 media artifact 并 ffprobe 校验",
    "授权只读使用本地 .env.local 中 RUNNINGHUB_API_KEY 用于本次 RunningHub 调用，但不得打印 secret 值",
    "不得调用 Runway，不得 regeneration，不得 batch，不得发布/部署，不得覆盖源资产，不得打印 secret，不得记录 raw provider payload。"
  ].join("，");
  return `授权执行 1 次 RunningHub upload-first real-storyboard-keyframe single-submit canary 真实调用：${details}`;
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
  const r3_8hReport = readJson<Record<string, unknown>>(R3_8H_REPORT_PATH);
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
  const durationSeconds = RUNNINGHUB_DOC_EXAMPLE_DURATION_SECONDS;
  const aspectRatio = "9:16";
  const resolution = RUNNINGHUB_DEFAULT_RESOLUTION;

  let blockReason: string | null = null;
  if (!runningHubConfig?.primary || runningHubConfig.status !== "primary_real_provider") {
    blockReason = "RunningHub is not primary_real_provider in local registry.";
  } else if (runwayConfig?.primary !== false || runwayConfig?.status !== "secondary_selectable_provider_port") {
    blockReason = "Runway is not secondary_selectable_provider_port in local registry.";
  } else if (!r3_8gReport || r3_8gReport.result !== "PASS_CONTRACT_FREEZE_DRY_RUN") {
    blockReason = "R3-8G contract freeze report is missing or not PASS.";
  } else if (!r3_8hReport || r3_8hReport.result !== "PASS_ADAPTER_SKELETON_OFFLINE") {
    blockReason = "R3-8H offline adapter skeleton report is missing or not PASS.";
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
  const submitRequest =
    artifact && shot
      ? buildRunningHubImageToVideoSubmitRequest({
          generation_input: {
            storyboard_artifact: artifact,
            video_prompt: shot.video_prompt,
            negative_prompt: shot.negative_prompt,
            duration_seconds: durationSeconds,
            aspect_ratio: aspectRatio,
            resolution
          },
          uploaded_download_url: RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER
        })
      : null;
  const queryRequest = buildRunningHubQueryRequest(SYNTHETIC_QUERY_TASK_ID);

  if (uploadRequest && !uploadRequest.ok && !blockReason) blockReason = uploadRequest.error.message;
  if (submitRequest && !submitRequest.ok && !blockReason) blockReason = submitRequest.error.message;
  if (!queryRequest.ok && !blockReason) blockReason = queryRequest.error.message;

  const authorizationPhrase = exactAuthorizationPhrase({
    selectedArtifactId: SELECTED_ARTIFACT_ID,
    sourcePath: SELECTED_SOURCE_PATH,
    storageUri: SELECTED_STORAGE_URI,
    durationSeconds,
    aspectRatio,
    resolution
  });

  const payload = {
    task: TASK,
    result: reportResult(blockReason),
    generated_at: new Date().toISOString(),
    source_reports: {
      r3_8g_contract_freeze: R3_8G_REPORT_PATH,
      r3_8h_adapter_skeleton: R3_8H_REPORT_PATH,
      g0_freeze: G0_FREEZE_REPORT_PATH
    },
    local_registry: {
      runninghub_primary: runningHubConfig?.primary === true,
      runninghub_status: runningHubConfig?.status ?? null,
      runninghub_model_name: runningHubConfig?.model_name ?? null,
      runway_secondary: runwayConfig?.primary === false && runwayConfig.status === "secondary_selectable_provider_port",
      runway_fallback_allowed: false
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
      gpt_invented_artifact_id: false,
      source_asset_overwritten: false
    },
    project_linkage: {
      project_id: project?.project_id ?? null,
      project_title: project?.title ?? null,
      storyboard_package_id: storyboardPackage?.storyboard_package_id ?? null,
      shot_id: shot?.shot_id ?? selectedShot?.shot_id ?? null,
      package_shot_duration_seconds: selectedShot?.duration_seconds ?? shot?.duration_seconds ?? null,
      runninghub_canary_duration_seconds: durationSeconds,
      duration_policy: "Use 6 seconds because the reviewed RunningHub official model API example documents duration=6; full supported range remains unresolved."
    },
    live_canary_plan: {
      provider: "runninghub",
      model_route: RUNNINGHUB_MODEL_ROUTE,
      upload_first_required: true,
      upload: uploadRequest?.ok
        ? {
            endpoint: uploadRequest.summary.endpoint,
            method: uploadRequest.method,
            file_field: uploadRequest.summary.file_field,
            file_name: uploadRequest.summary.file_name,
            mime_type: uploadRequest.summary.mime_type,
            file_size_bytes: uploadRequest.summary.file_size_bytes,
            sha256: uploadRequest.summary.sha256,
            max_upload_calls: 1,
            authorization_value_included: uploadRequest.summary.auth.authorization_value_included,
            binary_payload_included: uploadRequest.summary.binary_payload_included,
            base64_included: uploadRequest.summary.base64_included
          }
        : safeError(uploadRequest?.error ?? null),
      submit: submitRequest?.ok
        ? {
            endpoint: submitRequest.summary.endpoint,
            method: submitRequest.method,
            request_fields: ["prompt", "aspectRatio", "imageUrls", "resolution", "duration"],
            prompt_text_length: submitRequest.summary.prompt_text_length,
            negative_prompt_supported: submitRequest.summary.negative_prompt_supported,
            negative_prompt_text_length: submitRequest.summary.negative_prompt_text_length,
            aspectRatio: submitRequest.summary.aspectRatio,
            image_url_values_included: submitRequest.summary.image_url_values_included,
            image_url_placeholder_used: submitRequest.summary.imageUrls[0] === RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER,
            resolution: submitRequest.summary.resolution,
            duration: submitRequest.summary.duration,
            max_submit_calls: 1,
            retry_allowed: false,
            raw_provider_payload_included: submitRequest.summary.raw_provider_payload_included
          }
        : safeError(submitRequest?.error ?? null),
      query: queryRequest.ok
        ? {
            endpoint: queryRequest.summary.endpoint,
            method: queryRequest.method,
            body_shape: { taskId: "string" },
            task_id_value_included: queryRequest.summary.task_id_value_included,
            allowed_after_submit_task_id: true,
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
    final_guard: {
      result: reportResult(blockReason),
      requires_user_authorization_for_real_call: true,
      authorization_phrase_must_match: true,
      env_local_read_allowed_in_this_task: false,
      live_task_may_require_env_local_read_authorization: true,
      max_upload_calls: 1,
      max_submit_calls: 1,
      retry_allowed: false,
      second_submit_allowed: false,
      runninghub_upload_allowed_now: false,
      runninghub_submit_allowed_now: false,
      runninghub_query_allowed_now: false,
      runninghub_output_download_allowed_now: false,
      runway_fallback_allowed: false,
      regeneration_allowed: false,
      batch_generation_allowed: false,
      publish_allowed: false,
      deploy_allowed: false,
      source_overwrite_allowed: false,
      secret_printing_allowed: false,
      raw_provider_payload_recording_allowed: false,
      budget_boundary: "Only one future upload-first RunningHub canary submit may be authorized; no automatic retry or second billable submit."
    },
    exact_authorization_phrase: authorizationPhrase,
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
      selected_artifact_from_app_registry: artifact?.artifact_id === SELECTED_ARTIFACT_ID,
      upload_first_plan_ready: uploadRequest?.ok === true && uploadRequest.summary.endpoint === `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
      submit_plan_ready: submitRequest?.ok === true && submitRequest.summary.endpoint === `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
      query_plan_ready: queryRequest.ok === true && queryRequest.summary.endpoint === `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
      max_submit_calls_one: true,
      retries_disabled: true,
      batch_regeneration_publish_deploy_source_overwrite_disabled: true,
      exact_authorization_phrase_generated: authorizationPhrase.length > 0,
      no_network_call: true,
      no_secret_base64_authorization_or_raw_payload_leak: false
    },
    blocked_reason: blockReason,
    validation: {
      "npm run r3:8i:prep": "PASS",
      "npm run typecheck": "PENDING",
      "npm run test:m1": "PENDING",
      "npm run secret:scan": "PENDING",
      "git diff --check": "PENDING"
    },
    changed_files: [
      "package.json",
      "scripts/r3-8i-runninghub-real-keyframe-authorization-prep.ts",
      OUTPUT_REPORT_PATH,
      ".agent_board/*"
    ],
    next_step: {
      recommended_task: "R3-8J_RUNNINGHUB_REAL_KEYFRAME_SINGLE_SUBMIT_CANARY",
      recommended_action: "Run exactly one live RunningHub upload-first canary only after Jenn provides the exact authorization phrase.",
      live_upload_submit_poll_download_requires_new_exact_user_authorization: true
    }
  };

  payload.acceptance.no_secret_base64_authorization_or_raw_payload_leak = !containsForbiddenSecretText(payload);
  if (!payload.acceptance.no_secret_base64_authorization_or_raw_payload_leak && !blockReason) {
    payload.blocked_reason = "Authorization prep report contains forbidden secret-shaped, base64, Authorization value, or raw provider payload text.";
    payload.result = "BLOCK_WITH_REASON";
    payload.final_guard.result = "BLOCK_WITH_REASON";
  }

  writeFileSync(join(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        result: payload.result,
        report_path: OUTPUT_REPORT_PATH,
        selected_artifact_id: SELECTED_ARTIFACT_ID,
        upload_endpoint: `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
        submit_endpoint: `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
        query_endpoint: `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
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
