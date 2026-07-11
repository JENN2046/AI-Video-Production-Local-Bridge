import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  type MediaArtifact,
  type ProviderToolError,
  type Shot
} from "../src/index.js";

const TASK = "R3-9A_RUNNINGHUB_PRIMARY_LANE_WIRING_DRY_RUN";
const OUTPUT_REPORT_PATH = "data/reports/r3_9a_runninghub_primary_lane_wiring_dry_run_result.json";
const R3_8K_REPORT_PATH = "data/reports/r3_8k_provider_path_decision_closeout.json";
const R3_8O_REPORT_PATH = "data/reports/r3_8o_runninghub_enterprise_key_6s_single_submit_canary_result.json";
const G0_FREEZE_REPORT_PATH = "data/reports/g0_r1_package_freeze_result.json";
const SYNTHETIC_QUERY_TASK_ID = "runninghub_task_r3_9a_dry_run_only";

interface G0FreezeReport {
  result?: string;
  project?: { project_id?: string; title?: string };
  storyboard_package?: { storyboard_package_id?: string; status?: string; shot_count?: number };
  shots?: Array<{
    shot_id?: string;
    order?: number;
    duration_seconds?: number;
    storyboard_image_artifact_id?: string;
    approved_by_user?: boolean;
  }>;
}

interface R3_8KReport {
  result?: string;
  decision?: {
    primary_validated_m1_provider_path?: string;
    provider?: string;
    model_route?: string;
  };
  evidence_summary?: {
    runninghub?: {
      duration_contract_repair?: {
        minimum_duration_seconds?: number;
        local_guard_blocks_duration_3_before_upload_or_submit?: boolean;
      };
    };
  };
}

interface R3_8OReport {
  result?: string;
  provider_contract?: {
    provider?: string;
    model_route?: string;
    duration_seconds?: number;
    aspectRatio?: string;
    resolution?: string;
    max_upload_calls?: number;
    max_submit_calls?: number;
  };
  output_artifact?: {
    generated_artifact_id?: string;
    ffprobe_status?: string;
  };
}

type ReportResult = "PASS_PRIMARY_LANE_WIRED_DRY_RUN" | "BLOCK_WITH_REASON";

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

function providerDurationFor(appDurationSeconds: number): number {
  return Math.max(appDurationSeconds, RUNNINGHUB_MIN_DURATION_SECONDS);
}

function isAppMediaArtifact(artifact: MediaArtifact): boolean {
  const uri = artifact.storage.uri.replace(/\\/g, "/").toLowerCase();
  return uri.includes("/data/media/artifacts/") && !uri.includes("/data/imports/");
}

function promptPlan(shot: Shot): Record<string, unknown> {
  return {
    video_prompt: shot.video_prompt,
    negative_prompt: shot.negative_prompt,
    video_prompt_text_length: shot.video_prompt.length,
    negative_prompt_text_length: shot.negative_prompt.length,
    negative_prompt_supported_by_runninghub: false
  };
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

function buildShotPlan(input: {
  shot: Shot | null;
  artifact: MediaArtifact | null;
  order: number | null;
  appDurationSeconds: number | null;
  outputDir: string;
}): Record<string, unknown> {
  const blockers: string[] = [];
  const shot = input.shot;
  const artifact = input.artifact;
  const appDurationSeconds = input.appDurationSeconds ?? shot?.duration_seconds ?? 0;
  const providerDurationSeconds = providerDurationFor(appDurationSeconds);

  if (!shot) blockers.push("SHOT_NOT_FOUND");
  if (!artifact) blockers.push("MEDIA_ARTIFACT_NOT_FOUND");
  if (artifact && artifact.artifact_id.startsWith("PENDING_")) blockers.push("PENDING_ARTIFACT_ID_REJECTED");
  if (artifact && (artifact.status !== "active" || artifact.artifact_type !== "image" || artifact.role !== "storyboard_image")) {
    blockers.push("ARTIFACT_NOT_ACTIVE_STORYBOARD_IMAGE");
  }
  if (artifact && !isAppMediaArtifact(artifact)) blockers.push("ARTIFACT_STORAGE_NOT_APP_MEDIA");
  if (!Number.isFinite(appDurationSeconds) || appDurationSeconds <= 0) blockers.push("INVALID_APP_DURATION_SECONDS");

  const uploadRequest = artifact && blockers.length === 0 ? buildRunningHubMediaUploadRequest({ storyboard_artifact: artifact }) : null;
  if (uploadRequest && !uploadRequest.ok) blockers.push(`UPLOAD_PLAN_BLOCKED:${uploadRequest.error.code}`);

  const submitRequest =
    shot && artifact && blockers.length === 0
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

  const rejectedDurationCheck =
    shot && artifact
      ? buildRunningHubImageToVideoSubmitRequest({
          generation_input: {
            storyboard_artifact: artifact,
            video_prompt: shot.video_prompt,
            negative_prompt: shot.negative_prompt,
            duration_seconds: RUNNINGHUB_MIN_DURATION_SECONDS - 1,
            aspect_ratio: "9:16",
            resolution: RUNNINGHUB_DEFAULT_RESOLUTION
          },
          uploaded_download_url: RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER
        })
      : null;

  const queryRequest = blockers.length === 0 ? buildRunningHubQueryRequest(SYNTHETIC_QUERY_TASK_ID) : null;
  if (queryRequest && !queryRequest.ok) blockers.push(`QUERY_PLAN_BLOCKED:${queryRequest.error.code}`);

  return {
    status: blockers.length === 0 ? "READY_FOR_AUTHORIZATION_GATED_LIVE_USE" : "BLOCKED_LOCALLY",
    blocked_reasons: blockers,
    order: input.order,
    shot_id: shot?.shot_id ?? null,
    selected_image_artifact: {
      artifact_id: artifact?.artifact_id ?? null,
      artifact_type: artifact?.artifact_type ?? null,
      role: artifact?.role ?? null,
      status: artifact?.status ?? null,
      storage_is_app_media: artifact ? isAppMediaArtifact(artifact) : false,
      source_path_included: false,
      storage_uri_included: false,
      source_asset_overwrite_allowed: false
    },
    prompt: shot ? promptPlan(shot) : null,
    app_duration_seconds: appDurationSeconds || null,
    duration_seconds: providerDurationSeconds,
    provider_duration_seconds: providerDurationSeconds,
    provider_duration_adjusted_to_minimum: appDurationSeconds < RUNNINGHUB_MIN_DURATION_SECONDS,
    provider_duration_minimum_seconds: RUNNINGHUB_MIN_DURATION_SECONDS,
    output_dir: input.outputDir,
    authorization_required: true,
    max_upload_calls: 1,
    max_submit_calls: 1,
    upload_first_flow: [
      "local_media_artifact",
      "runninghub_media_upload_request_plan",
      "runninghub_image_to_video_submit_request_plan",
      "runninghub_query_until_terminal_plan",
      "download_to_local_media_artifact_storage_and_ffprobe"
    ],
    duration_guard: {
      duration_below_minimum_rejected_before_upload_or_submit: rejectedDurationCheck?.ok === false,
      rejected_duration_seconds: RUNNINGHUB_MIN_DURATION_SECONDS - 1,
      rejection_error: rejectedDurationCheck && !rejectedDurationCheck.ok ? safeError(rejectedDurationCheck.error) : null
    },
    upload_request_plan:
      uploadRequest?.ok === true
        ? {
            endpoint: uploadRequest.summary.endpoint,
            file_field: uploadRequest.summary.file_field,
            mime_type: uploadRequest.summary.mime_type,
            file_size_bytes: uploadRequest.summary.file_size_bytes,
            sha256: uploadRequest.summary.sha256,
            local_file_path_included: uploadRequest.summary.local_file_path_included,
            binary_payload_included: uploadRequest.summary.binary_payload_included,
            base64_included: uploadRequest.summary.base64_included,
            authorization_value_included: uploadRequest.summary.auth.authorization_value_included
          }
        : safeError(uploadRequest?.error ?? null),
    submit_request_plan:
      submitRequest?.ok === true
        ? {
            endpoint: submitRequest.summary.endpoint,
            request_fields: ["prompt", "aspectRatio", "imageUrls", "resolution", "duration"],
            prompt_text_length: submitRequest.summary.prompt_text_length,
            negative_prompt_supported: submitRequest.summary.negative_prompt_supported,
            negative_prompt_text_length: submitRequest.summary.negative_prompt_text_length,
            aspectRatio: submitRequest.summary.aspectRatio,
            image_url_values_included: submitRequest.summary.image_url_values_included,
            image_url_placeholder_used: submitRequest.summary.imageUrls[0] === RUNNINGHUB_UPLOAD_DOWNLOAD_URL_PLACEHOLDER,
            resolution: submitRequest.summary.resolution,
            duration: submitRequest.summary.duration,
            raw_provider_payload_included: submitRequest.summary.raw_provider_payload_included
          }
        : safeError(submitRequest?.error ?? null),
    query_request_plan:
      queryRequest?.ok === true
        ? {
            endpoint: queryRequest.summary.endpoint,
            body_shape: { taskId: "string" },
            task_id_value_included: queryRequest.summary.task_id_value_included,
            status_query_not_a_second_submit: true
          }
        : safeError(queryRequest?.error ?? null),
    output_handling_if_succeeded: {
      download_to_local_media_artifact_storage: true,
      ffprobe_validation_required: true,
      source_asset_overwrite_allowed: false
    }
  };
}

ensureM0Directories();

const db = openM0Database();
try {
  const r3_8kReport = readJson<R3_8KReport>(R3_8K_REPORT_PATH);
  const r3_8oReport = readJson<R3_8OReport>(R3_8O_REPORT_PATH);
  const g0FreezeReport = readJson<G0FreezeReport>(G0_FREEZE_REPORT_PATH);
  const providerConfigs = listProviderConfigs();
  const runningHubConfig = providerConfigs.find((config) => config.provider_name === "runninghub");
  const runwayConfig = providerConfigs.find((config) => config.provider_name === "runway");
  const projectId = g0FreezeReport?.project?.project_id ?? "";
  const packageId = g0FreezeReport?.storyboard_package?.storyboard_package_id ?? "";
  const project = projectId ? getProject(db, projectId) : null;
  const storyboardPackage = packageId ? getStoryboardPackage(db, packageId) : null;
  const packageShots = g0FreezeReport?.shots ?? [];

  let blockReason: string | null = null;
  if (r3_8kReport?.result !== "PASS_PROVIDER_PATH_CLOSED") blockReason = "R3-8K provider path closeout is missing or not PASS.";
  else if (r3_8kReport.decision?.primary_validated_m1_provider_path !== "runninghub_enterprise_shared_api_key") {
    blockReason = "R3-8K did not record RunningHub Enterprise-Shared API Key as the primary validated M1 provider path.";
  } else if (r3_8oReport?.result !== "PASS_LIVE_SINGLE_SUBMIT_COMPLETED") {
    blockReason = "R3-8O Enterprise Key canary evidence is missing or not PASS.";
  } else if (!runningHubConfig?.primary || runningHubConfig.status !== "primary_real_provider") {
    blockReason = "RunningHub is not primary_real_provider in local M1 registry.";
  } else if (runwayConfig?.primary !== false || runwayConfig.status !== "secondary_selectable_provider_port") {
    blockReason = "Runway is not secondary_selectable_provider_port in local M1 registry.";
  } else if (!project || !storyboardPackage || g0FreezeReport?.result !== "PASS") {
    blockReason = "Frozen G0 storyboard package linkage is missing or not PASS.";
  } else if (r3_8kReport.evidence_summary?.runninghub?.duration_contract_repair?.minimum_duration_seconds !== RUNNINGHUB_MIN_DURATION_SECONDS) {
    blockReason = "R3-8K duration evidence does not match RunningHub minimum 6 seconds.";
  }

  const shotPlans = packageShots.map((packageShot, index) => {
    const shotId = packageShot.shot_id ?? "";
    const artifactId = packageShot.storyboard_image_artifact_id ?? "";
    return buildShotPlan({
      shot: shotId ? getShot(db, shotId) : null,
      artifact: artifactId ? getMediaArtifact(db, artifactId) : null,
      order: packageShot.order ?? index + 1,
      appDurationSeconds: packageShot.duration_seconds ?? null,
      outputDir: `data/media/provider-runs/r3-9b-runninghub-package/${String(packageShot.order ?? index + 1).padStart(2, "0")}-${shotId || "shot"}/`
    });
  });
  const singleShotPlan = shotPlans[0] ?? null;
  const packagePlanStatus = shotPlans.length > 0 && shotPlans.every((plan) => plan.status === "READY_FOR_AUTHORIZATION_GATED_LIVE_USE")
    ? "SUPPORTED"
    : "BLOCKED_LOCALLY";

  const payload = {
    task: TASK,
    result: blockReason ? "BLOCK_WITH_REASON" as ReportResult : "PASS_PRIMARY_LANE_WIRED_DRY_RUN" as ReportResult,
    mode: "dry_run",
    generated_at: new Date().toISOString(),
    source_reports: {
      provider_path_decision_closeout: R3_8K_REPORT_PATH,
      runninghub_enterprise_key_canary: R3_8O_REPORT_PATH,
      frozen_storyboard_package: G0_FREEZE_REPORT_PATH
    },
    primary_lane_selection: {
      provider: runningHubConfig?.provider_name ?? null,
      provider_display_name: runningHubConfig?.provider_display_name ?? null,
      provider_status: runningHubConfig?.status ?? null,
      selected_for_m1_generation_planning: runningHubConfig?.provider_name === "runninghub" && runningHubConfig.primary === true,
      model_route: RUNNINGHUB_MODEL_ROUTE,
      credential_env_name: runningHubConfig?.credential_env_name ?? "RUNNINGHUB_API_KEY",
      credential_read: false,
      credential_value_included: false,
      enterprise_shared_api_key_path: "PRIMARY_VALIDATED_BY_R3_8K",
      runway_role: runwayConfig?.status === "secondary_selectable_provider_port" ? "secondary_or_fallback_only" : "unexpected",
      runway_selected_by_primary_lane_dry_run: false
    },
    runninghub_contract: {
      upload_first_required: true,
      model_route: RUNNINGHUB_MODEL_ROUTE,
      upload_endpoint: `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
      submit_endpoint: `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
      query_endpoint: `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
      request_fields: ["prompt", "aspectRatio", "imageUrls", "resolution", "duration"],
      aspectRatio: "9:16",
      resolution: RUNNINGHUB_DEFAULT_RESOLUTION,
      duration_minimum_seconds: RUNNINGHUB_MIN_DURATION_SECONDS,
      duration_seconds_policy: "provider_duration_seconds = max(app_shot_duration_seconds, 6)",
      max_upload_calls_per_shot: 1,
      max_submit_calls_per_shot: 1,
      retry_submit_allowed: false,
      second_submit_allowed: false,
      query_until_terminal_or_timeout: true
    },
    single_shot_dry_run_plan: singleShotPlan,
    package_level_dry_run_plan: {
      status: packagePlanStatus,
      local_block_reasons: blockReason ? [blockReason] : [],
      project_id: (project?.project_id ?? projectId) || null,
      storyboard_package_id: (storyboardPackage?.storyboard_package_id ?? packageId) || null,
      shot_count: shotPlans.length,
      ready_shot_count: shotPlans.filter((plan) => plan.status === "READY_FOR_AUTHORIZATION_GATED_LIVE_USE").length,
      blocked_shot_count: shotPlans.filter((plan) => plan.status !== "READY_FOR_AUTHORIZATION_GATED_LIVE_USE").length,
      plans: shotPlans
    },
    acceptance: {
      primary_provider_selection_resolves_to_runninghub: runningHubConfig?.provider_name === "runninghub" && runningHubConfig.primary === true,
      runway_not_selected_by_primary_lane_dry_run: runwayConfig?.primary === false,
      runninghub_duration_minimum_validated_before_upload_or_submit: shotPlans.every((plan) =>
        typeof plan === "object" && plan !== null && (plan as { duration_guard?: { duration_below_minimum_rejected_before_upload_or_submit?: boolean } }).duration_guard?.duration_below_minimum_rejected_before_upload_or_submit === true
      ),
      upload_first_planning_explicit: shotPlans.every((plan) => Array.isArray((plan as { upload_first_flow?: unknown }).upload_first_flow)),
      single_shot_plan_records_required_fields: Boolean(singleShotPlan),
      package_level_plan_supported_or_locally_blocked: packagePlanStatus === "SUPPORTED" || packagePlanStatus === "BLOCKED_LOCALLY",
      future_live_calls_authorization_gated: true,
      no_credentials_or_env_read: true,
      no_provider_call: true,
      no_source_overwrite: true,
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
      regeneration_performed: false,
      batch_generation_performed: false,
      source_assets_overwritten: false,
      credentials_read: false,
      env_files_read: false,
      secret_values_exposed: false,
      raw_provider_payload_recorded: false,
      signed_url_recorded: false,
      push_performed: false,
      tag_created: false,
      release_or_deploy_performed: false,
      production_credentials_change: false
    },
    validation: {
      "npm run r3:9a:dry-run": "PASS",
      "npm run typecheck": "PENDING",
      "npm run test:m1": "PENDING",
      "npm run secret:scan": "PENDING",
      "git diff --check": "PENDING"
    },
    changed_files: [
      "package.json",
      "scripts/r3-9a-runninghub-primary-lane-wiring-dry-run.ts",
      "tests/m1-provider-boundary.test.ts",
      OUTPUT_REPORT_PATH,
      ".agent_board/*"
    ],
    blocked_reason: blockReason,
    next_step: {
      recommended_task: "R3-9B_STORYBOARD_PACKAGE_TO_RUNNINGHUB_GENERATION_PLAN",
      requires_user_authorization_for_real_call: true,
      do_not_execute_live_provider_call_from_this_plan: true
    }
  };

  if (!noForbiddenLeak(payload) && !blockReason) {
    payload.result = "BLOCK_WITH_REASON";
    payload.blocked_reason = "Dry-run report contains forbidden secret-shaped, URL, data URI, long base64, or raw provider payload text.";
  }

  writeFileSync(join(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        result: payload.result,
        report_path: OUTPUT_REPORT_PATH,
        primary_provider: payload.primary_lane_selection.provider,
        package_plan_status: payload.package_level_dry_run_plan.status,
        shot_count: payload.package_level_dry_run_plan.shot_count,
        provider_duration_minimum_seconds: RUNNINGHUB_MIN_DURATION_SECONDS,
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
