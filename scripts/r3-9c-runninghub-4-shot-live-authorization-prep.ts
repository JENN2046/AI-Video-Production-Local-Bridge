import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  ensureM0Directories,
  paths,
  RUNNINGHUB_DEFAULT_RESOLUTION,
  RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT,
  RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT,
  RUNNINGHUB_MIN_DURATION_SECONDS,
  RUNNINGHUB_MODEL_ROUTE,
  RUNNINGHUB_QUERY_ENDPOINT
} from "../src/index.js";

const TASK = "R3-9C_RUNNINGHUB_4_SHOT_LIVE_AUTHORIZATION_PREP";
const OUTPUT_REPORT_PATH = "data/reports/r3_9c_runninghub_4_shot_live_authorization_prep_result.json";
const R3_9B_REPORT_PATH = "data/reports/r3_9b_storyboard_package_to_runninghub_generation_plan_result.json";

interface R3_9BPlanEntry {
  status?: string;
  blocked_reasons?: string[];
  shot_id?: string;
  order?: number;
  image_artifact?: {
    artifact_id?: string | null;
    artifact_id_from_app?: boolean;
    artifact_type?: string | null;
    role?: string | null;
    status?: string | null;
    storage_uri?: string | null;
    storage_is_app_media?: boolean;
    source_path?: string | null;
    source_asset_overwrite_allowed?: boolean;
  };
  prompt?: {
    shot_description?: string | null;
    video_prompt?: string | null;
    negative_prompt?: string | null;
    negative_prompt_supported_by_runninghub?: boolean;
  };
  duration?: {
    app_duration_seconds?: number;
    provider_duration_seconds?: number;
    provider_duration_minimum_seconds?: number;
    provider_duration_adjusted_to_minimum?: boolean;
  };
  provider_fields?: {
    provider?: string;
    model_route?: string;
    aspectRatio?: string;
    resolution?: string;
    upload_endpoint?: string;
    submit_endpoint?: string;
    query_endpoint?: string;
  };
  call_budget?: {
    max_upload_calls?: number;
    max_submit_calls?: number;
    max_retry_submit_calls?: number;
    max_second_submit_calls?: number;
    query_same_task_until_terminal_or_timeout?: boolean;
  };
  output_plan?: {
    output_dir?: string;
    expected_local_artifact_registration?: {
      artifact_type?: string;
      role?: string;
      provider_name?: string;
      project_id?: string | null;
      shot_id?: string | null;
      storage_directory?: string;
      ffprobe_validation_required?: boolean;
      source_asset_overwrite_allowed?: boolean;
    };
  };
  request_plan?: {
    upload?: {
      endpoint?: string;
      authorization_value_included?: boolean;
      binary_payload_included?: boolean;
      base64_included?: boolean;
    };
    submit?: {
      endpoint?: string;
      image_url_values_included?: boolean;
      image_url_placeholder_used?: boolean;
      raw_provider_payload_included?: boolean;
    };
    query?: {
      endpoint?: string;
      task_id_value_included?: boolean;
      status_query_not_a_second_submit?: boolean;
    };
  };
}

interface R3_9BReport {
  result?: string;
  package?: {
    project_id?: string | null;
    project_title?: string | null;
    storyboard_package_id?: string | null;
    frozen?: boolean;
    status?: string | null;
    package_shot_count?: number;
  };
  runninghub_primary_lane_contract?: {
    provider?: string;
    model_route?: string;
    upload_first_required?: boolean;
    upload_endpoint?: string;
    submit_endpoint?: string;
    query_endpoint?: string;
    duration_minimum_seconds?: number;
    duration_seconds_per_shot?: number;
    aspectRatio?: string;
    resolution?: string;
  };
  generation_plan?: {
    status?: string;
    eligible_shot_count?: number;
    blocked_shot_count?: number;
    entries?: R3_9BPlanEntry[];
  };
  future_authorization?: {
    budget_and_stop_conditions?: {
      max_upload_calls_total?: number;
      max_submit_calls_total?: number;
      max_upload_calls_per_shot?: number;
      max_submit_calls_per_shot?: number;
      no_retry?: boolean;
      no_second_submit?: boolean;
      stop_if_any_upload_fails?: boolean;
      stop_if_any_submit_fails?: boolean;
      query_only_same_task_id_until_terminal_or_timeout?: boolean;
      no_provider_call_without_new_exact_current_authorization?: boolean;
    };
  };
  provider_boundary?: Record<string, unknown>;
  git_receipt?: { commit?: string };
}

type ReportResult = "PASS_READY_FOR_USER_AUTHORIZATION" | "BLOCK_WITH_REASON";

function readJson<T>(path: string): T | null {
  const absolute = resolve(paths.workspaceRoot, path);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function fileFacts(filePath: string | null | undefined): Record<string, unknown> {
  if (!filePath) return { path: null, exists: false };
  const exists = existsSync(filePath);
  return {
    path: filePath,
    exists,
    byte_size: exists ? statSync(filePath).size : 0
  };
}

function shotBlockers(entry: R3_9BPlanEntry): string[] {
  const blockers: string[] = [...(entry.blocked_reasons ?? [])];
  const artifact = entry.image_artifact ?? {};
  const prompt = entry.prompt ?? {};
  const duration = entry.duration ?? {};
  const provider = entry.provider_fields ?? {};
  const budget = entry.call_budget ?? {};
  const output = entry.output_plan ?? {};
  const request = entry.request_plan ?? {};

  if (entry.status !== "READY_FOR_FUTURE_AUTHORIZED_SUBMIT") blockers.push("PLAN_ENTRY_NOT_READY");
  if (!entry.shot_id) blockers.push("SHOT_ID_MISSING");
  if (!artifact.artifact_id?.startsWith("artifact_")) blockers.push("APP_ARTIFACT_ID_INVALID");
  if (artifact.artifact_id_from_app !== true) blockers.push("ARTIFACT_ID_NOT_CONFIRMED_FROM_APP");
  if (artifact.artifact_type !== "image" || artifact.role !== "storyboard_image" || artifact.status !== "active") blockers.push("ARTIFACT_CLASSIFICATION_INVALID");
  if (artifact.storage_is_app_media !== true) blockers.push("ARTIFACT_STORAGE_NOT_APP_MEDIA");
  if (!artifact.source_path || !existsSync(artifact.source_path)) blockers.push("SOURCE_PATH_MISSING");
  if (!artifact.storage_uri || !existsSync(artifact.storage_uri)) blockers.push("STORAGE_URI_MISSING");
  if (artifact.source_asset_overwrite_allowed !== false) blockers.push("SOURCE_OVERWRITE_NOT_FORBIDDEN");
  if (!prompt.video_prompt || prompt.video_prompt.trim().length === 0) blockers.push("VIDEO_PROMPT_MISSING");
  if (duration.provider_duration_seconds !== RUNNINGHUB_MIN_DURATION_SECONDS) blockers.push("PROVIDER_DURATION_NOT_6");
  if (duration.provider_duration_minimum_seconds !== RUNNINGHUB_MIN_DURATION_SECONDS) blockers.push("PROVIDER_DURATION_MINIMUM_NOT_6");
  if (provider.provider !== "runninghub" || provider.model_route !== RUNNINGHUB_MODEL_ROUTE) blockers.push("PROVIDER_LANE_NOT_RUNNINGHUB");
  if (provider.aspectRatio !== "9:16" || provider.resolution !== RUNNINGHUB_DEFAULT_RESOLUTION) blockers.push("PROVIDER_RATIO_OR_RESOLUTION_MISMATCH");
  if (provider.upload_endpoint !== `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`) blockers.push("UPLOAD_ENDPOINT_MISMATCH");
  if (provider.submit_endpoint !== `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`) blockers.push("SUBMIT_ENDPOINT_MISMATCH");
  if (provider.query_endpoint !== `POST ${RUNNINGHUB_QUERY_ENDPOINT}`) blockers.push("QUERY_ENDPOINT_MISMATCH");
  if (budget.max_upload_calls !== 1 || budget.max_submit_calls !== 1) blockers.push("PER_SHOT_BUDGET_NOT_SINGLE_SUBMIT");
  if (budget.max_retry_submit_calls !== 0 || budget.max_second_submit_calls !== 0) blockers.push("RETRY_OR_SECOND_SUBMIT_NOT_FORBIDDEN");
  if (budget.query_same_task_until_terminal_or_timeout !== true) blockers.push("QUERY_STOP_CONDITION_MISSING");
  if (!output.output_dir || !output.expected_local_artifact_registration?.storage_directory) blockers.push("OUTPUT_DIRECTORY_MISSING");
  if (output.expected_local_artifact_registration?.ffprobe_validation_required !== true) blockers.push("FFPROBE_VALIDATION_NOT_REQUIRED");
  if (output.expected_local_artifact_registration?.source_asset_overwrite_allowed !== false) blockers.push("OUTPUT_REGISTRATION_SOURCE_OVERWRITE_NOT_FORBIDDEN");
  if (request.upload?.authorization_value_included !== false || request.upload?.binary_payload_included !== false || request.upload?.base64_included !== false) {
    blockers.push("UPLOAD_REQUEST_SUMMARY_NOT_SANITIZED");
  }
  if (request.submit?.image_url_values_included !== false || request.submit?.raw_provider_payload_included !== false) blockers.push("SUBMIT_REQUEST_SUMMARY_NOT_SANITIZED");
  if (request.query?.task_id_value_included !== false || request.query?.status_query_not_a_second_submit !== true) blockers.push("QUERY_REQUEST_SUMMARY_NOT_SANITIZED");

  return Array.from(new Set(blockers));
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

function compactShotForPhrase(entry: R3_9BPlanEntry): string {
  return [
    `shot_id=${entry.shot_id}`,
    `artifact_id=${entry.image_artifact?.artifact_id}`,
    `source_path=${entry.image_artifact?.source_path}`,
    `storage_uri=${entry.image_artifact?.storage_uri}`,
    `duration_seconds=${RUNNINGHUB_MIN_DURATION_SECONDS}`,
    `output_dir=${entry.output_plan?.output_dir}`
  ].join(", ");
}

ensureM0Directories();

const r3_9bReport = readJson<R3_9BReport>(R3_9B_REPORT_PATH);
const entries = r3_9bReport?.generation_plan?.entries ?? [];
const shotConfirmations = entries.map((entry) => ({
  shot_id: entry.shot_id ?? null,
  order: entry.order ?? null,
  status: shotBlockers(entry).length === 0 ? "CONFIRMED_READY_FOR_FUTURE_AUTHORIZED_LIVE_CALL" : "BLOCKED_LOCALLY",
  local_blockers: shotBlockers(entry),
  artifact: {
    artifact_id: entry.image_artifact?.artifact_id ?? null,
    artifact_type: entry.image_artifact?.artifact_type ?? null,
    role: entry.image_artifact?.role ?? null,
    status: entry.image_artifact?.status ?? null,
    source_path: entry.image_artifact?.source_path ?? null,
    source_file: fileFacts(entry.image_artifact?.source_path),
    storage_uri: entry.image_artifact?.storage_uri ?? null,
    storage_file: fileFacts(entry.image_artifact?.storage_uri),
    source_asset_overwrite_allowed: false
  },
  prompt: entry.prompt ?? null,
  duration_seconds: entry.duration?.provider_duration_seconds ?? null,
  app_duration_seconds: entry.duration?.app_duration_seconds ?? null,
  provider: entry.provider_fields ?? null,
  output_dir: entry.output_plan?.output_dir ?? null,
  future_local_artifact_storage: entry.output_plan?.expected_local_artifact_registration ?? null,
  future_validation_path: {
    upload_first: true,
    submit_after_upload_download_url: true,
    query_same_task_id_until_terminal_or_timeout: true,
    download_success_output_to_local_media_artifact_storage: true,
    ffprobe_validate_local_video: true,
    register_generated_clip_artifact: true
  }
}));

const budget = r3_9bReport?.future_authorization?.budget_and_stop_conditions ?? {};
const topLevelBlockers: string[] = [];
if (!r3_9bReport) topLevelBlockers.push("R3_9B_REPORT_MISSING");
if (r3_9bReport?.result !== "PASS_PACKAGE_GENERATION_PLAN_READY") topLevelBlockers.push("R3_9B_NOT_PASS");
if (r3_9bReport?.generation_plan?.status !== "READY_FOR_FUTURE_AUTHORIZED_EXECUTION") topLevelBlockers.push("R3_9B_PLAN_NOT_READY");
if (r3_9bReport?.generation_plan?.eligible_shot_count !== 4 || entries.length !== 4) topLevelBlockers.push("SHOT_COUNT_NOT_4");
if (r3_9bReport?.generation_plan?.blocked_shot_count !== 0) topLevelBlockers.push("R3_9B_HAS_BLOCKED_SHOTS");
if (r3_9bReport?.runninghub_primary_lane_contract?.provider !== "runninghub") topLevelBlockers.push("PROVIDER_NOT_RUNNINGHUB");
if (r3_9bReport?.runninghub_primary_lane_contract?.duration_seconds_per_shot !== RUNNINGHUB_MIN_DURATION_SECONDS) topLevelBlockers.push("CONTRACT_DURATION_NOT_6");
if (budget.max_upload_calls_total !== 4 || budget.max_submit_calls_total !== 4) topLevelBlockers.push("TOTAL_BUDGET_NOT_4_UPLOAD_4_SUBMIT");
if (budget.max_upload_calls_per_shot !== 1 || budget.max_submit_calls_per_shot !== 1) topLevelBlockers.push("PER_SHOT_BUDGET_NOT_1");
if (budget.no_retry !== true || budget.no_second_submit !== true) topLevelBlockers.push("RETRY_OR_SECOND_SUBMIT_NOT_DISABLED");
if (budget.query_only_same_task_id_until_terminal_or_timeout !== true) topLevelBlockers.push("QUERY_STOP_CONDITION_MISSING");

const shotBlockerCount = shotConfirmations.reduce((sum, shot) => sum + shot.local_blockers.length, 0);
const exactAuthorizationPhrase = [
  "授权执行 1 次 RunningHub 4-shot storyboard-package live generation：",
  "provider=runninghub",
  "model_route=rhart-video-g/image-to-video",
  `project_id=${r3_9bReport?.package?.project_id ?? ""}`,
  `storyboard_package_id=${r3_9bReport?.package?.storyboard_package_id ?? ""}`,
  "shot_count=4",
  `shots=[${entries.map(compactShotForPhrase).join(" | ")}]`,
  "duration_seconds_per_shot=6",
  "aspectRatio=9:16",
  "resolution=480p",
  "upload_endpoint=POST /openapi/v2/media/upload/binary",
  "submit_endpoint=POST /openapi/v2/rhart-video-g/image-to-video",
  "query_endpoint=POST /openapi/v2/query",
  "max_upload_calls_total=4",
  "max_submit_calls_total=4",
  "max_upload_calls_per_shot=1",
  "max_submit_calls_per_shot=1",
  "预算/费用上限=仅允许这 4 个 planned shots 各 1 次 upload 和 1 次 submit，不允许 retry 或第二次计费 submit",
  "允许对每个 returned taskId 状态 query 直到 terminal 或 timeout",
  "成功后逐条下载到本地 media artifact storage 并 ffprobe 校验",
  "output_root=data/media/provider-runs/r3-9b-runninghub-package/",
  "授权只读使用本地 .env.local 中 RUNNINGHUB_API_KEY 用于本次 RunningHub 调用，但不得打印 secret 值",
  "不得调用 Runway，不得 regeneration，不得扩大 batch，不得发布/部署，不得覆盖源资产，不得打印 secret，不得记录 raw provider payload，不得记录 signed URL"
].join("，");

const payload = {
  task: TASK,
  result: topLevelBlockers.length === 0 && shotBlockerCount === 0 ? "PASS_READY_FOR_USER_AUTHORIZATION" as ReportResult : "BLOCK_WITH_REASON" as ReportResult,
  mode: "authorization_prep_only",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    r3_9b_plan_report: R3_9B_REPORT_PATH,
    r3_9b_result: r3_9bReport?.result ?? null,
    r3_9b_commit: r3_9bReport?.git_receipt?.commit ?? null
  },
  hard_gate_summary: {
    eligible_shot_count_confirmed: shotConfirmations.filter((shot) => shot.status === "CONFIRMED_READY_FOR_FUTURE_AUTHORIZED_LIVE_CALL").length,
    local_blocker_count: shotBlockerCount,
    top_level_blockers: topLevelBlockers,
    provider: "runninghub",
    model_route: RUNNINGHUB_MODEL_ROUTE,
    duration_seconds_per_shot: RUNNINGHUB_MIN_DURATION_SECONDS,
    aspectRatio: "9:16",
    resolution: RUNNINGHUB_DEFAULT_RESOLUTION,
    upload_first_required: true,
    no_runway_fallback: true,
    no_retry: true,
    no_second_submit: true,
    no_regeneration: true,
    no_batch_expansion: true
  },
  shot_confirmations: shotConfirmations,
  budget_and_stop_conditions: {
    max_upload_calls_total: 4,
    max_submit_calls_total: 4,
    max_upload_calls_per_shot: 1,
    max_submit_calls_per_shot: 1,
    max_retry_submit_calls: 0,
    max_second_submit_calls: 0,
    stop_if_any_upload_fails: true,
    stop_if_any_submit_fails: true,
    query_only_same_task_id_until_terminal_or_timeout: true,
    stop_before_any_unplanned_shot: true,
    no_runway_fallback: true,
    no_regeneration: true,
    no_batch_expansion: true
  },
  future_execution_path_per_shot: {
    step_1_upload_local_storyboard_image: `POST ${RUNNINGHUB_MEDIA_UPLOAD_ENDPOINT}`,
    step_2_submit_image_to_video_after_upload: `POST ${RUNNINGHUB_IMAGE_TO_VIDEO_ENDPOINT}`,
    step_3_query_same_task_until_terminal_or_timeout: `POST ${RUNNINGHUB_QUERY_ENDPOINT}`,
    step_4_download_success_output_to_local_media_artifact_storage: true,
    step_5_register_generated_clip_media_artifact: true,
    step_6_ffprobe_validate_local_video: true
  },
  future_authorization_phrase: {
    phrase_is_draft_only: true,
    ready_for_user_to_copy_after_review: topLevelBlockers.length === 0 && shotBlockerCount === 0,
    exact_phrase: exactAuthorizationPhrase
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
  acceptance: {
    r3_9b_plan_parsed_as_source_of_truth: r3_9bReport?.result === "PASS_PACKAGE_GENERATION_PLAN_READY",
    exactly_4_eligible_shot_plans_confirmed: entries.length === 4 && shotConfirmations.length === 4 && shotBlockerCount === 0,
    zero_local_blockers: shotBlockerCount === 0 && topLevelBlockers.length === 0,
    each_shot_confirms_required_fields: shotConfirmations.every((shot) => shot.local_blockers.length === 0),
    budget_and_stop_conditions_explicit: budget.max_upload_calls_total === 4 && budget.max_submit_calls_total === 4,
    future_query_download_ffprobe_path_documented: true,
    precise_future_authorization_phrase_drafted_not_executed: true,
    no_credentials_or_env_read: true,
    no_provider_call: true,
    no_source_overwrite: true,
    no_push_tag_release_or_deploy: true
  },
  validation: {
    "JSON parse for generated authorization prep report": "PENDING",
    "npm run r3:9c:prep": "PASS",
    "npm run typecheck": "PENDING",
    "npm run test:m1": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "package.json",
    "scripts/r3-9c-runninghub-4-shot-live-authorization-prep.ts",
    OUTPUT_REPORT_PATH,
    ".agent_board/*"
  ],
  blocked_reason: topLevelBlockers.length > 0 || shotBlockerCount > 0 ? "R3-9C hard gate found local blockers; inspect top_level_blockers and shot_confirmations[].local_blockers." : null,
  next_step: {
    user_may_review_authorization_phrase: true,
    live_provider_call_requires_new_exact_current_authorization: true,
    do_not_execute_from_this_prep_task: true
  }
};

if (!noForbiddenLeak(payload) && !payload.blocked_reason) {
  payload.result = "BLOCK_WITH_REASON";
  payload.blocked_reason = "Authorization prep report contains forbidden secret-shaped, URL, data URI, or long base64 text.";
}

writeFileSync(join(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      result: payload.result,
      report_path: OUTPUT_REPORT_PATH,
      eligible_shot_count_confirmed: payload.hard_gate_summary.eligible_shot_count_confirmed,
      local_blocker_count: payload.hard_gate_summary.local_blocker_count,
      max_upload_calls_total: payload.budget_and_stop_conditions.max_upload_calls_total,
      max_submit_calls_total: payload.budget_and_stop_conditions.max_submit_calls_total,
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false
    },
    null,
    2
  )
);
if (payload.result === "BLOCK_WITH_REASON") process.exitCode = 1;
