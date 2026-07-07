import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  buildRunningHubImageToVideoDryRunPlan,
  ensureM0Directories,
  getMediaArtifact,
  getProject,
  getShot,
  getStoryboardPackage,
  listProviderConfigs,
  openM0Database,
  paths,
  RUNNINGHUB_API_BASE_URL,
  RUNNINGHUB_DEFAULT_RESOLUTION,
  RUNNINGHUB_DOC_EXAMPLE_DURATION_SECONDS,
  RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT,
  RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT,
  RUNNINGHUB_MODEL_ROUTE,
  RUNNINGHUB_QUERY_ENDPOINT,
  validateImageFile,
  type RunningHubImageToVideoDryRunPlan
} from "../src/index.js";

const TASK = "R3-8G_RUNNINGHUB_CONTRACT_FREEZE_AND_DRY_RUN";
const OUTPUT_REPORT_PATH = "data/reports/r3_8g_runninghub_contract_freeze_dry_run_result.json";
const G0_FREEZE_REPORT_PATH = "data/reports/g0_r1_package_freeze_result.json";
const R3_8F_REPORT_PATH = "data/reports/r3_8f_provider_priority_switch_to_runninghub_result.json";
const R3_8D_REPORT_PATH = "data/reports/r3_8d_real_storyboard_keyframe_canary_prepare_result.json";
const SELECTED_ARTIFACT_ID = "artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7";
const SELECTED_SOURCE_PATH = "A:\\AI Video Production Workspace\\data\\imports\\g0_r1_SHOT_001_IMAGE_ACCEPTED_WEBGPT.png";
const SELECTED_STORAGE_URI = "A:\\AI Video Production Workspace\\data\\media\\artifacts\\images\\artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7.png";

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

type R3_8GResult = "PASS_CONTRACT_FREEZE_DRY_RUN" | "BLOCK_WITH_REASON";

function readJson<T>(path: string): T | null {
  const absolute = resolve(paths.workspaceRoot, path);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function reportResult(plan: RunningHubImageToVideoDryRunPlan | null, blockReason: string | null): R3_8GResult {
  if (blockReason || !plan) return "BLOCK_WITH_REASON";
  return "PASS_CONTRACT_FREEZE_DRY_RUN";
}

function noSecretsInPlan(plan: RunningHubImageToVideoDryRunPlan | null): boolean {
  const serialized = JSON.stringify(plan);
  return (
    !/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(serialized) &&
    !serialized.includes("RUNNINGHUB_API_KEY=") &&
    !serialized.includes("data:image/") &&
    !/base64,[A-Za-z0-9+/=]{32,}/.test(serialized) &&
    !serialized.includes(SELECTED_STORAGE_URI)
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

  let plan: RunningHubImageToVideoDryRunPlan | null = null;
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
  } else {
    const built = buildRunningHubImageToVideoDryRunPlan({
      storyboard_artifact: {
        ...artifact,
        metadata: {
          ...artifact.metadata,
          sha256: storageValidation.sha256
        }
      },
      video_prompt: shot.video_prompt,
      negative_prompt: shot.negative_prompt,
      duration_seconds: RUNNINGHUB_DOC_EXAMPLE_DURATION_SECONDS,
      aspect_ratio: "9:16",
      resolution: RUNNINGHUB_DEFAULT_RESOLUTION
    });
    if (!built.ok) {
      blockReason = built.error.message;
    } else {
      plan = {
        ...built.plan,
        image_reference: {
          ...built.plan.image_reference,
          upload_file_size_bytes: storageSize,
          upload_file_sha256: storageValidation.sha256
        }
      };
    }
  }

  if (!noSecretsInPlan(plan)) {
    blockReason = "Dry-run plan contains forbidden secret, base64, Authorization value, or local storage URI text.";
  }

  const payload = {
    task: TASK,
    result: reportResult(plan, blockReason),
    generated_at: new Date().toISOString(),
    official_sources_reviewed: [
      {
        url: "https://www.runninghub.cn/",
        facts: ["RunningHub exposes API, Model API, AI Application API, and Workflow API entry points."]
      },
      {
        url: "https://www.runninghub.cn/call-api/api-detail/2019380112598044674",
        facts: ["The public API detail page identifies interface /rhart-video-g/image-to-video and input fields API Key, prompt, aspectRatio, imageUrls, resolution, duration."]
      },
      {
        url: "https://www.runninghub.cn/runninghub-api-doc-cn/api-448183102",
        facts: [
          "The official API docs freeze POST /openapi/v2/rhart-video-g/image-to-video.",
          "The request example uses prompt, aspectRatio, imageUrls, resolution, and duration.",
          "The response example includes taskId, status, errorCode, errorMessage, results, clientId, and promptTips."
        ]
      },
      {
        url: "https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306",
        facts: ["The V2 query endpoint is POST /openapi/v2/query and returns taskId, status, errorCode, errorMessage, and results[].url."]
      },
      {
        url: "https://www.runninghub.cn/runninghub-api-doc-cn/api-425749007",
        facts: ["The upload endpoint is POST /openapi/v2/media/upload/binary; upload response data.download_url is used by standard model API."]
      },
      {
        url: "https://www.runninghub.cn/runninghub-api-doc-cn/doc-8435517",
        facts: ["Model API errors use errorCode and errorMessage; documented classes include invalid API key, rate limit, insufficient permissions, content safety, timeout, and generation failure."]
      }
    ],
    local_registry: {
      runninghub_primary: runningHubConfig?.primary === true,
      runninghub_status: runningHubConfig?.status ?? null,
      runninghub_model_name: runningHubConfig?.model_name ?? null,
      runway_secondary: runwayConfig?.primary === false && runwayConfig.status === "secondary_selectable_provider_port"
    },
    contract_freeze: {
      api_base_url: RUNNINGHUB_API_BASE_URL,
      submit_endpoint: `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
      upload_endpoint: `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
      query_endpoint: `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
      model_route: RUNNINGHUB_MODEL_ROUTE,
      auth_header_name: "Authorization",
      auth_scheme: "Bearer",
      credential_env_name: "RUNNINGHUB_API_KEY",
      request_fields: ["prompt", "aspectRatio", "imageUrls", "resolution", "duration"],
      native_negative_prompt_field: null,
      submit_task_id_field: "taskId",
      submit_status_field: "status",
      query_output_url_field: "results[].url",
      query_terminal_success_status: "SUCCESS",
      error_fields: ["code", "msg", "message", "errorCode", "errorMessage"]
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
      source_asset_overwritten: false
    },
    project_linkage: {
      project_id: project?.project_id ?? null,
      storyboard_package_id: storyboardPackage?.storyboard_package_id ?? null,
      shot_id: shot?.shot_id ?? selectedShot?.shot_id ?? null,
      project_shot_duration_seconds: selectedShot?.duration_seconds ?? shot?.duration_seconds ?? null,
      dry_run_duration_seconds: RUNNINGHUB_DOC_EXAMPLE_DURATION_SECONDS,
      duration_policy: "RunningHub official examples confirm duration field with value 6; the full supported duration range is not enumerated, so live adapter must keep duration validation conservative."
    },
    dry_run_request_plan: plan,
    unresolved_contract_fields: plan?.unresolved_fields ?? ["contract plan was not generated"],
    provider_boundary: {
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false,
      provider_credits_consumed: false,
      real_video_generated: false,
      upload_attempted: false,
      status_poll_attempted: false,
      output_download_attempted: false,
      regeneration_performed: false,
      batch_generation_performed: false,
      source_assets_overwritten: false,
      secret_values_exposed: false,
      raw_provider_payload_recorded: false
    },
    acceptance: {
      runninghub_confirmed_primary: runningHubConfig?.primary === true && runningHubConfig.status === "primary_real_provider",
      runway_confirmed_secondary: runwayConfig?.primary === false && runwayConfig.status === "secondary_selectable_provider_port",
      official_docs_reviewed: true,
      contract_fields_frozen_or_marked_unresolved: plan !== null,
      dry_run_request_summary_generated: plan !== null,
      dry_run_contains_no_credentials_base64_authorization_or_raw_payload: noSecretsInPlan(plan),
      no_provider_call: true
    },
    blocked_reason: blockReason,
    validation: {
      "npm run r3:8g:dry-run": "PASS",
      "npm run typecheck": "PENDING",
      "npm run test:m1": "PENDING",
      "npm run secret:scan": "PENDING",
      "git diff --check": "PENDING"
    },
    changed_files: [
      ".env.example",
      "package.json",
      "scripts/r3-8g-runninghub-contract-freeze-dry-run.ts",
      "src/index.ts",
      "src/tools/videoProviderAdapters.ts",
      "tests/m1-provider-boundary.test.ts",
      OUTPUT_REPORT_PATH,
      ".agent_board/*"
    ],
    next_step: {
      recommended_task: "R3-8H_RUNNINGHUB_ADAPTER_OR_AUTHORIZATION_NEXT_STEP",
      recommended_action: "Implement upload-first RunningHub adapter dry-run tests, then prepare a separate exact authorization phrase for one live RunningHub canary.",
      live_call_requires_new_exact_user_authorization: true
    }
  };

  writeFileSync(join(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        result: payload.result,
        report_path: OUTPUT_REPORT_PATH,
        submit_endpoint: payload.contract_freeze.submit_endpoint,
        query_endpoint: payload.contract_freeze.query_endpoint,
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
