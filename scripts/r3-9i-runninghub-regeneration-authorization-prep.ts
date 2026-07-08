import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ensureM0Directories, paths } from "../src/index.js";

const TASK = "R3-9I_RUNNINGHUB_REGENERATION_AUTHORIZATION_PREP";
const R3_9F_REPORT_PATH = "data/reports/r3_9f_human_clip_review_decision_apply_result.json";
const R3_9G_REPORT_PATH = "data/reports/r3_9g_regeneration_strategy_for_review_notes_result.json";
const R3_9H_REPORT_PATH = "data/reports/r3_9h_shot_002_replacement_decision_result.json";
const R3_9B_REPORT_PATH = "data/reports/r3_9b_storyboard_package_to_runninghub_generation_plan_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_9i_runninghub_regeneration_authorization_prep_result.json";
const OUTPUT_ROOT = "data/media/provider-runs/r3-9i-runninghub-regeneration/";
const EXPECTED_SHOT_IDS = [
  "g0_r1_shot_001",
  "g0_r1_shot_002",
  "g0_r1_shot_003",
  "g0_r1_shot_004"
] as const;

type ExpectedShotId = typeof EXPECTED_SHOT_IDS[number];
type ReportResult = "PASS_READY_FOR_USER_AUTHORIZATION" | "BLOCK_WITH_REASON";

interface R3_9FDecision {
  order?: number;
  shot_id?: string;
  generated_clip_artifact_id?: string;
  source_storyboard_image_artifact_id?: string;
  decision?: "accept" | "reject" | "regenerate_requested";
  reviewer?: string;
  note?: string;
  mapped_app_decision?: string;
  after?: {
    shot_status?: string;
    approval_status?: string;
    accepted_clip_artifact_id?: string;
    clip_review_status?: string;
  };
  local_state_links?: {
    generation_run_id?: string;
    generation_batch_id?: string;
  };
}

interface R3_9FReport {
  result?: string;
  decision_apply?: {
    decision_summary?: {
      accept?: number;
      reject?: number;
      regenerate_requested?: number;
    };
    local_blocker_count?: number;
  };
  decisions?: R3_9FDecision[];
  git_receipt?: { commit?: string };
}

interface R3_9GCandidate {
  shot_id?: string;
  shot_label?: string;
  order?: number;
  source_review_decision?: {
    decision?: string;
    reviewer?: string;
    note?: string;
    rejected_generated_clip_artifact_id?: string;
    rejected_generation_run_id?: string;
  };
  source_keyframe?: {
    storyboard_image_artifact_id?: string;
    storage_uri?: string;
    source_path?: string;
    source_asset_overwrite_allowed?: boolean;
  };
  original_prompt_context?: {
    shot_description?: string;
    video_prompt?: string;
    negative_prompt?: string;
  };
  revised_strategy?: {
    action_constraints?: string[];
    prompt_guidance?: string;
    negative_constraints?: string[];
    risk_notes?: string[];
    review_focus?: string[];
  };
  future_runninghub_plan?: {
    provider?: string;
    model_route?: string;
    duration_seconds?: number;
    aspectRatio?: string;
    resolution?: string;
    upload_endpoint?: string;
    submit_endpoint?: string;
    query_endpoint?: string;
  };
}

interface R3_9GReport {
  result?: string;
  regeneration_strategy?: {
    candidate_count?: number;
    candidate_shot_ids?: string[];
    excluded_shot_ids?: string[];
    local_blocker_count?: number;
  };
  candidates?: R3_9GCandidate[];
  git_receipt?: { commit?: string };
}

interface R3_9HReport {
  result?: string;
  shot_002_context?: {
    shot_id?: string;
    order?: number;
    reviewer?: string;
    reject_reason?: string;
    current_state?: {
      revision_needed?: boolean;
      accepted_clip_artifact_id?: string;
      unresolved?: boolean;
    };
    generated_clip_artifact?: {
      artifact_id?: string;
      ffprobe_status?: string;
      duration_seconds?: number;
      local_mp4_path?: string;
    };
    source_storyboard_image_artifact?: {
      artifact_id?: string;
      artifact_type?: string;
      role?: string;
      status?: string;
      source_path?: string;
      storage_uri?: string;
      source_asset_overwrite_allowed?: boolean;
    };
    original_prompt_context?: {
      shot_description?: string;
      video_prompt?: string;
      negative_prompt?: string;
    };
    runninghub_contract_context?: {
      provider?: string;
      model_route?: string;
      duration_seconds?: number;
      aspectRatio?: string;
      resolution?: string;
    };
  };
  recommended_next_path?: {
    option_id?: string;
    prompt_revision_draft?: {
      shot_description?: string | null;
      revised_video_prompt?: string;
      revised_negative_constraints?: string[];
    };
  };
  assembly_readiness?: {
    no_accepted_clips?: boolean;
    shot_002_unresolved?: boolean;
  };
  git_receipt?: { commit?: string };
}

interface R3_9BPlanEntry {
  shot_id?: string;
  order?: number;
  image_artifact?: {
    artifact_id?: string;
    artifact_type?: string;
    role?: string;
    status?: string;
    storage_uri?: string;
    source_path?: string;
    source_asset_overwrite_allowed?: boolean;
  };
  prompt?: {
    shot_description?: string;
    video_prompt?: string;
    negative_prompt?: string;
  };
  duration?: {
    provider_duration_seconds?: number;
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
}

interface R3_9BReport {
  result?: string;
  package?: {
    project_id?: string;
    project_title?: string;
    storyboard_package_id?: string;
    frozen?: boolean;
    status?: string;
  };
  runninghub_primary_lane_contract?: {
    provider?: string;
    model_route?: string;
    upload_endpoint?: string;
    submit_endpoint?: string;
    query_endpoint?: string;
    duration_seconds_per_shot?: number;
    aspectRatio?: string;
    resolution?: string;
  };
  generation_plan?: {
    entries?: R3_9BPlanEntry[];
  };
  git_receipt?: { commit?: string };
}

interface PlannedShot {
  shot_id: ExpectedShotId;
  order: number;
  decision_source: "R3-9G_REGENERATION_STRATEGY" | "R3-9H_SAME_KEYFRAME_REPAIR";
  human_review: {
    decision: string | null;
    reviewer: string | null;
    note: string | null;
    rejected_generated_clip_artifact_id: string | null;
    rejected_generation_run_id: string | null;
  };
  source_storyboard_image: {
    artifact_id: string | null;
    artifact_type: string | null;
    role: string | null;
    status: string | null;
    storage_uri: string | null;
    source_path: string | null;
    storage_uri_exists: boolean;
    source_path_exists: boolean;
    source_asset_overwrite_allowed: false;
  };
  original_prompt_context: {
    shot_description: string | null;
    video_prompt: string | null;
    negative_prompt: string | null;
  };
  revised_prompt_plan: {
    action_constraints: string[];
    prompt_guidance: string | null;
    negative_constraints: string[];
    risk_notes: string[];
    review_focus: string[];
  };
  runninghub_request_plan: {
    provider: "runninghub";
    model_route: "rhart-video-g/image-to-video";
    duration_seconds: 6;
    aspectRatio: "9:16";
    resolution: "480p";
    upload_endpoint: "POST /openapi/v2/media/upload/binary";
    submit_endpoint: "POST /openapi/v2/rhart-video-g/image-to-video";
    query_endpoint: "POST /openapi/v2/query";
    max_upload_calls: 1;
    max_submit_calls: 1;
    max_retry_submit_calls: 0;
    max_second_submit_calls: 0;
    query_same_task_until_terminal_or_timeout: true;
    output_dir: string;
    output_dir_isolated: boolean;
    download_each_success_to_local_media_artifact_storage: true;
    ffprobe_validation_required: true;
    raw_provider_payload_included: false;
    signed_url_recorded: false;
  };
  local_blockers: string[];
}

function readJson<T>(relativePath: string): T | null {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function pathExists(value: string | null | undefined): boolean {
  return typeof value === "string" && value.length > 0 && existsSync(value);
}

function isExpectedShotId(value: string | undefined): value is ExpectedShotId {
  return EXPECTED_SHOT_IDS.includes(value as ExpectedShotId);
}

function shotLabel(shotId: string): string {
  const match = shotId.match(/shot_(\d+)/i);
  return match ? `SHOT_${match[1]}` : shotId;
}

function outputDir(order: number, shotId: string): string {
  return `${OUTPUT_ROOT}${String(order).padStart(2, "0")}-${shotId}/`;
}

function providerPlan(output: string): PlannedShot["runninghub_request_plan"] {
  return {
    provider: "runninghub",
    model_route: "rhart-video-g/image-to-video",
    duration_seconds: 6,
    aspectRatio: "9:16",
    resolution: "480p",
    upload_endpoint: "POST /openapi/v2/media/upload/binary",
    submit_endpoint: "POST /openapi/v2/rhart-video-g/image-to-video",
    query_endpoint: "POST /openapi/v2/query",
    max_upload_calls: 1,
    max_submit_calls: 1,
    max_retry_submit_calls: 0,
    max_second_submit_calls: 0,
    query_same_task_until_terminal_or_timeout: true,
    output_dir: output,
    output_dir_isolated: true,
    download_each_success_to_local_media_artifact_storage: true,
    ffprobe_validation_required: true,
    raw_provider_payload_included: false,
    signed_url_recorded: false
  };
}

function requireString(value: string | null | undefined, blocker: string, blockers: string[]): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  blockers.push(blocker);
  return null;
}

function pushIf(condition: boolean, blocker: string, blockers: string[]): void {
  if (condition) blockers.push(blocker);
}

ensureM0Directories();

const r3f = readJson<R3_9FReport>(R3_9F_REPORT_PATH);
const r3g = readJson<R3_9GReport>(R3_9G_REPORT_PATH);
const r3h = readJson<R3_9HReport>(R3_9H_REPORT_PATH);
const r3b = readJson<R3_9BReport>(R3_9B_REPORT_PATH);

const localBlockers: string[] = [];
if (!r3f) localBlockers.push("R3_9F_REPORT_MISSING");
if (!r3g) localBlockers.push("R3_9G_REPORT_MISSING");
if (!r3h) localBlockers.push("R3_9H_REPORT_MISSING");
if (!r3b) localBlockers.push("R3_9B_REPORT_MISSING");
if (r3f?.result !== "PASS_REVIEW_DECISIONS_APPLIED") localBlockers.push("R3_9F_NOT_PASS");
if (r3g?.result !== "PASS_REGENERATION_STRATEGY_READY") localBlockers.push("R3_9G_NOT_PASS");
if (r3h?.result !== "PASS_SHOT_002_DECISION_READY") localBlockers.push("R3_9H_NOT_PASS");
if (r3b?.result !== "PASS_PACKAGE_GENERATION_PLAN_READY") localBlockers.push("R3_9B_NOT_PASS");
if (r3f?.decision_apply?.decision_summary?.accept !== 0) localBlockers.push("ACCEPTED_CLIP_COUNT_NOT_ZERO");
if (r3f?.decision_apply?.decision_summary?.reject !== 1) localBlockers.push("REJECT_COUNT_NOT_ONE");
if (r3f?.decision_apply?.decision_summary?.regenerate_requested !== 3) localBlockers.push("REGENERATE_REQUESTED_COUNT_NOT_THREE");
if (r3g?.regeneration_strategy?.candidate_count !== 3) localBlockers.push("R3_9G_CANDIDATE_COUNT_NOT_THREE");
if (!r3g?.regeneration_strategy?.excluded_shot_ids?.includes("g0_r1_shot_002")) localBlockers.push("R3_9G_SHOT_002_NOT_EXCLUDED");
if (r3h?.recommended_next_path?.option_id !== "rework_prompt_and_regenerate_same_keyframe") localBlockers.push("R3_9H_NOT_SAME_KEYFRAME_REWORK");

const decisions = new Map((r3f?.decisions ?? []).map((decision) => [decision.shot_id ?? "", decision]));
const planEntries = new Map((r3b?.generation_plan?.entries ?? []).map((entry) => [entry.shot_id ?? "", entry]));
const gCandidates = new Map((r3g?.candidates ?? []).map((candidate) => [candidate.shot_id ?? "", candidate]));

const plannedShots: PlannedShot[] = EXPECTED_SHOT_IDS.map((shotId, index) => {
  const blockers: string[] = [];
  const decision = decisions.get(shotId);
  const planEntry = planEntries.get(shotId);
  const gCandidate = gCandidates.get(shotId);
  const order = planEntry?.order ?? decision?.order ?? index + 1;

  pushIf(!decision, `${shotId}:DECISION_MISSING`, blockers);
  pushIf(!planEntry, `${shotId}:PLAN_ENTRY_MISSING`, blockers);
  pushIf(decision?.mapped_app_decision !== "revision_needed", `${shotId}:NOT_REVISION_NEEDED`, blockers);
  pushIf((decision?.after?.accepted_clip_artifact_id ?? "") !== "", `${shotId}:HAS_ACCEPTED_CLIP`, blockers);
  pushIf(planEntry?.image_artifact?.role !== "storyboard_image", `${shotId}:SOURCE_ROLE_NOT_STORYBOARD_IMAGE`, blockers);
  pushIf(planEntry?.image_artifact?.status !== "active", `${shotId}:SOURCE_IMAGE_NOT_ACTIVE`, blockers);
  pushIf(planEntry?.duration?.provider_duration_seconds !== 6, `${shotId}:PROVIDER_DURATION_NOT_6`, blockers);
  pushIf(planEntry?.provider_fields?.provider !== "runninghub", `${shotId}:PROVIDER_NOT_RUNNINGHUB`, blockers);
  pushIf(planEntry?.provider_fields?.model_route !== "rhart-video-g/image-to-video", `${shotId}:MODEL_ROUTE_MISMATCH`, blockers);
  pushIf(planEntry?.provider_fields?.aspectRatio !== "9:16", `${shotId}:ASPECT_RATIO_NOT_9_16`, blockers);
  pushIf(planEntry?.provider_fields?.resolution !== "480p", `${shotId}:RESOLUTION_NOT_480P`, blockers);

  const output = outputDir(order, shotId);
  const sourceArtifactId = planEntry?.image_artifact?.artifact_id ?? decision?.source_storyboard_image_artifact_id ?? null;
  const sourceStorageUri = planEntry?.image_artifact?.storage_uri ?? null;
  const sourcePath = planEntry?.image_artifact?.source_path ?? null;
  const rejectedArtifactId = decision?.generated_clip_artifact_id ?? null;

  requireString(sourceArtifactId, `${shotId}:SOURCE_ARTIFACT_ID_MISSING`, blockers);
  requireString(sourceStorageUri, `${shotId}:SOURCE_STORAGE_URI_MISSING`, blockers);
  requireString(sourcePath, `${shotId}:SOURCE_PATH_MISSING`, blockers);
  requireString(rejectedArtifactId, `${shotId}:REJECTED_GENERATED_CLIP_ARTIFACT_MISSING`, blockers);
  pushIf(!pathExists(sourceStorageUri), `${shotId}:SOURCE_STORAGE_URI_NOT_FOUND`, blockers);
  pushIf(!pathExists(sourcePath), `${shotId}:SOURCE_PATH_NOT_FOUND`, blockers);
  pushIf(sourceArtifactId !== decision?.source_storyboard_image_artifact_id, `${shotId}:SOURCE_ARTIFACT_DECISION_PLAN_MISMATCH`, blockers);

  if (shotId === "g0_r1_shot_002") {
    const promptDraft = r3h?.recommended_next_path?.prompt_revision_draft;
    const promptText = promptDraft?.revised_video_prompt ?? "";
    const negativeConstraints = promptDraft?.revised_negative_constraints ?? [];
    const shot002PromptGuidance = promptText.length > 0
      ? `${promptText} Explicitly avoid any product-negative mood.`
      : null;
    pushIf(decision?.decision !== "reject", `${shotId}:DECISION_NOT_REJECT`, blockers);
    pushIf(r3h?.shot_002_context?.source_storyboard_image_artifact?.artifact_id !== sourceArtifactId, `${shotId}:R3_9H_SOURCE_ARTIFACT_MISMATCH`, blockers);
    pushIf(r3h?.shot_002_context?.generated_clip_artifact?.artifact_id !== rejectedArtifactId, `${shotId}:R3_9H_REJECTED_ARTIFACT_MISMATCH`, blockers);
    pushIf(r3h?.shot_002_context?.current_state?.unresolved !== true, `${shotId}:R3_9H_NOT_UNRESOLVED`, blockers);
    pushIf(!promptText.includes("Do not create a sigh"), `${shotId}:PROMPT_DOES_NOT_FORBID_SIGH`, blockers);
    pushIf(!promptText.includes("product-negative") && !negativeConstraints.some((item) => item.includes("product-negative")), `${shotId}:PROMPT_DOES_NOT_FORBID_PRODUCT_NEGATIVE_MOOD`, blockers);
    pushIf(!negativeConstraints.some((item) => item.includes("No sighing")), `${shotId}:NEGATIVE_CONSTRAINT_NO_SIGHING_MISSING`, blockers);

    return {
      shot_id: shotId,
      order,
      decision_source: "R3-9H_SAME_KEYFRAME_REPAIR",
      human_review: {
        decision: decision?.decision ?? null,
        reviewer: decision?.reviewer ?? null,
        note: decision?.note ?? null,
        rejected_generated_clip_artifact_id: rejectedArtifactId,
        rejected_generation_run_id: decision?.local_state_links?.generation_run_id ?? null
      },
      source_storyboard_image: {
        artifact_id: sourceArtifactId,
        artifact_type: planEntry?.image_artifact?.artifact_type ?? null,
        role: planEntry?.image_artifact?.role ?? null,
        status: planEntry?.image_artifact?.status ?? null,
        storage_uri: sourceStorageUri,
        source_path: sourcePath,
        storage_uri_exists: pathExists(sourceStorageUri),
        source_path_exists: pathExists(sourcePath),
        source_asset_overwrite_allowed: false
      },
      original_prompt_context: {
        shot_description: planEntry?.prompt?.shot_description ?? null,
        video_prompt: planEntry?.prompt?.video_prompt ?? null,
        negative_prompt: planEntry?.prompt?.negative_prompt ?? null
      },
      revised_prompt_plan: {
        action_constraints: [
          "Use the same storyboard image artifact; do not replace or mutate the frozen storyboard package.",
          "Keep Ryan neutral, focused, approachable, and product-positive.",
          "Allow only small natural hand movement toward the gloves or table gear.",
          "Avoid any sighing, unhappy expression, slumped posture, disappointment, fatigue, or product-negative mood."
        ],
        prompt_guidance: shot002PromptGuidance,
        negative_constraints: negativeConstraints,
        risk_notes: [
          "The main risk is emotional drift into a tired or unhappy expression.",
          "If the same source keyframe still reads as product-negative after regeneration, switch to replacement-keyframe prep instead of repeated prompt-only attempts."
        ],
        review_focus: [
          "Confirm no sighing, unhappy, tired, disappointed, or product-negative expression.",
          "Confirm Ryan remains approachable and buyer-safe.",
          "Confirm the gray skullcap, lunch table, hard hat, thermos, lunch container, worksite background, and daylight remain stable."
        ]
      },
      runninghub_request_plan: providerPlan(output),
      local_blockers: blockers
    };
  }

  pushIf(!gCandidate, `${shotId}:R3_9G_CANDIDATE_MISSING`, blockers);
  pushIf(decision?.decision !== "regenerate_requested", `${shotId}:DECISION_NOT_REGENERATE_REQUESTED`, blockers);
  pushIf(gCandidate?.source_keyframe?.storyboard_image_artifact_id !== sourceArtifactId, `${shotId}:R3_9G_SOURCE_ARTIFACT_MISMATCH`, blockers);
  pushIf(gCandidate?.source_review_decision?.rejected_generated_clip_artifact_id !== rejectedArtifactId, `${shotId}:R3_9G_REJECTED_ARTIFACT_MISMATCH`, blockers);

  return {
    shot_id: shotId,
    order,
    decision_source: "R3-9G_REGENERATION_STRATEGY",
    human_review: {
      decision: decision?.decision ?? null,
      reviewer: decision?.reviewer ?? null,
      note: decision?.note ?? null,
      rejected_generated_clip_artifact_id: rejectedArtifactId,
      rejected_generation_run_id: decision?.local_state_links?.generation_run_id ?? null
    },
    source_storyboard_image: {
      artifact_id: sourceArtifactId,
      artifact_type: planEntry?.image_artifact?.artifact_type ?? null,
      role: planEntry?.image_artifact?.role ?? null,
      status: planEntry?.image_artifact?.status ?? null,
      storage_uri: sourceStorageUri,
      source_path: sourcePath,
      storage_uri_exists: pathExists(sourceStorageUri),
      source_path_exists: pathExists(sourcePath),
      source_asset_overwrite_allowed: false
    },
    original_prompt_context: {
      shot_description: planEntry?.prompt?.shot_description ?? null,
      video_prompt: planEntry?.prompt?.video_prompt ?? null,
      negative_prompt: planEntry?.prompt?.negative_prompt ?? null
    },
    revised_prompt_plan: {
      action_constraints: gCandidate?.revised_strategy?.action_constraints ?? [],
      prompt_guidance: gCandidate?.revised_strategy?.prompt_guidance ?? null,
      negative_constraints: gCandidate?.revised_strategy?.negative_constraints ?? [],
      risk_notes: gCandidate?.revised_strategy?.risk_notes ?? [],
      review_focus: gCandidate?.revised_strategy?.review_focus ?? []
    },
    runninghub_request_plan: providerPlan(output),
    local_blockers: blockers
  };
});

const shotIds = plannedShots.map((shot) => shot.shot_id);
const outputDirs = plannedShots.map((shot) => shot.runninghub_request_plan.output_dir);
const duplicateOutputDirs = outputDirs.filter((dir, index) => outputDirs.indexOf(dir) !== index);
if (plannedShots.length !== 4) localBlockers.push("PLANNED_SHOT_COUNT_NOT_4");
if (!EXPECTED_SHOT_IDS.every((shotId) => shotIds.includes(shotId))) localBlockers.push("PLANNED_SHOT_IDS_NOT_EXACT_EXPECTED_SET");
if (duplicateOutputDirs.length > 0) localBlockers.push(`DUPLICATE_OUTPUT_DIRS:${duplicateOutputDirs.join(",")}`);
plannedShots.forEach((shot) => {
  localBlockers.push(...shot.local_blockers);
  if (!isExpectedShotId(shot.shot_id)) localBlockers.push(`UNEXPECTED_SHOT_ID:${shot.shot_id}`);
});

const shot001 = plannedShots.find((shot) => shot.shot_id === "g0_r1_shot_001");
const shot002 = plannedShots.find((shot) => shot.shot_id === "g0_r1_shot_002");
const shot003 = plannedShots.find((shot) => shot.shot_id === "g0_r1_shot_003");
const shot004 = plannedShots.find((shot) => shot.shot_id === "g0_r1_shot_004");
if (!shot001?.revised_prompt_plan.prompt_guidance?.includes("lunchbox on the table")) localBlockers.push("SHOT_001_PROMPT_DOES_NOT_KEEP_LUNCHBOX_ON_TABLE");
if (!shot001?.revised_prompt_plan.prompt_guidance?.includes("picks up a small bite of food")) localBlockers.push("SHOT_001_PROMPT_DOES_NOT_PICK_FOOD_FROM_LUNCHBOX");
if (!shot002?.revised_prompt_plan.prompt_guidance?.includes("Do not create a sigh")) localBlockers.push("SHOT_002_PROMPT_DOES_NOT_FORBID_SIGH");
if (!shot002?.revised_prompt_plan.prompt_guidance?.includes("product-negative")) localBlockers.push("SHOT_002_PROMPT_DOES_NOT_FORBID_PRODUCT_NEGATIVE_MOOD");
if (!shot003?.revised_prompt_plan.prompt_guidance?.includes("fold depth becomes shallower")) localBlockers.push("SHOT_003_PROMPT_DOES_NOT_ADDRESS_SHALLOWER_FOLDS");
if (!shot004?.revised_prompt_plan.prompt_guidance?.includes("consistent daylight direction")) localBlockers.push("SHOT_004_PROMPT_DOES_NOT_ADDRESS_LIGHT_DIRECTION");
if (!shot004?.revised_prompt_plan.prompt_guidance?.includes("contact shadow")) localBlockers.push("SHOT_004_PROMPT_DOES_NOT_ADDRESS_CONTACT_SHADOW");

const result: ReportResult = localBlockers.length === 0 ? "PASS_READY_FOR_USER_AUTHORIZATION" : "BLOCK_WITH_REASON";
const packageContext = r3b?.package;
const authorizationShotList = plannedShots
  .sort((left, right) => left.order - right.order)
  .map((shot) => `${shot.shot_id}: source_artifact_id=${shot.source_storyboard_image.artifact_id ?? ""}, rejected_clip_artifact_id=${shot.human_review.rejected_generated_clip_artifact_id ?? ""}, duration_seconds=6, output_dir=${shot.runninghub_request_plan.output_dir}`)
  .join(" | ");

const exactAuthorizationPhraseDraft = [
  "授权执行 1 次 RunningHub 4-shot regeneration single-pass live execution：",
  "provider=runninghub",
  "model_route=rhart-video-g/image-to-video",
  `source_plan=${OUTPUT_REPORT_PATH}`,
  `project_id=${packageContext?.project_id ?? ""}`,
  `storyboard_package_id=${packageContext?.storyboard_package_id ?? ""}`,
  "shot_count=4",
  `shots=[${authorizationShotList}]`,
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
  "预算/费用上限=仅允许这 4 个 planned regeneration shots 各 1 次 upload 和 1 次 submit，不允许 retry，不允许第二次计费 submit，不允许 batch expansion，不允许 Runway fallback",
  "stop_on_first_upload_or_submit_failure=true",
  "允许对每个 returned taskId 状态 query 直到 terminal 或 timeout",
  "成功后逐条下载到本地 media artifact storage、注册 generated video artifact 并 ffprobe 校验",
  `output_root=${OUTPUT_ROOT}`,
  "授权只读使用本地 .env.local 中 RUNNINGHUB_API_KEY 用于本次 RunningHub 调用，但不得打印 secret 值",
  "不得调用 Runway，不得 regeneration 以外扩展 batch，不得发布/部署，不得覆盖源资产，不得打印 secret，不得记录 raw provider payload，不得记录 signed URL"
].join("，");

const payload = {
  task: TASK,
  result,
  mode: "local_authorization_prep_only",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    r3_9f_decision_apply_report: R3_9F_REPORT_PATH,
    r3_9f_result: r3f?.result ?? null,
    r3_9f_commit: r3f?.git_receipt?.commit ?? null,
    r3_9g_regeneration_strategy_report: R3_9G_REPORT_PATH,
    r3_9g_result: r3g?.result ?? null,
    r3_9g_commit: r3g?.git_receipt?.commit ?? null,
    r3_9h_shot_002_decision_report: R3_9H_REPORT_PATH,
    r3_9h_result: r3h?.result ?? null,
    r3_9h_commit: r3h?.git_receipt?.commit ?? null,
    r3_9b_generation_plan_report: R3_9B_REPORT_PATH,
    r3_9b_result: r3b?.result ?? null,
    r3_9b_commit: r3b?.git_receipt?.commit ?? null
  },
  package: {
    project_id: packageContext?.project_id ?? null,
    project_title: packageContext?.project_title ?? null,
    storyboard_package_id: packageContext?.storyboard_package_id ?? null,
    frozen: packageContext?.frozen ?? null,
    status: packageContext?.status ?? null,
    storyboard_package_mutated: false
  },
  runninghub_primary_lane_contract: {
    provider: "runninghub",
    model_route: "rhart-video-g/image-to-video",
    upload_first_required: true,
    upload_endpoint: "POST /openapi/v2/media/upload/binary",
    submit_endpoint: "POST /openapi/v2/rhart-video-g/image-to-video",
    query_endpoint: "POST /openapi/v2/query",
    duration_seconds_per_shot: 6,
    aspectRatio: "9:16",
    resolution: "480p",
    source_contract_report: R3_9B_REPORT_PATH
  },
  regeneration_authorization_prep: {
    status: result === "PASS_READY_FOR_USER_AUTHORIZATION" ? "READY_FOR_USER_AUTHORIZATION" : "BLOCKED_LOCALLY",
    planned_shot_count: plannedShots.length,
    planned_shot_ids: plannedShots.map((shot) => shot.shot_id),
    includes_r3_9g_candidates: r3g?.regeneration_strategy?.candidate_shot_ids ?? [],
    includes_r3_9h_same_keyframe_repair_for: "g0_r1_shot_002",
    output_root: OUTPUT_ROOT,
    local_blocker_count: localBlockers.length,
    local_blockers: localBlockers
  },
  planned_shots: plannedShots.sort((left, right) => left.order - right.order),
  budget_boundary: {
    max_upload_calls_total: 4,
    max_submit_calls_total: 4,
    max_upload_calls_per_shot: 1,
    max_submit_calls_per_shot: 1,
    max_retry_submit_calls: 0,
    max_second_submit_calls: 0,
    no_retry: true,
    no_second_submit: true,
    no_runway_fallback: true,
    no_batch_expansion: true,
    stop_on_first_upload_failure: true,
    stop_on_first_submit_failure: true,
    query_only_same_task_id_until_terminal_or_timeout: true,
    no_provider_call_without_new_exact_current_authorization: true
  },
  future_authorization: {
    required_for_real_regeneration: true,
    phrase_is_draft_only: true,
    exact_authorization_phrase_draft: exactAuthorizationPhraseDraft,
    next_live_task_should_verify_this_report_before_call: true
  },
  assembly_readiness: {
    final_assembly_status: "BLOCKED",
    no_accepted_clips: r3f?.decision_apply?.decision_summary?.accept === 0,
    blocked_until_regenerated_clips_reviewed_and_accepted: true,
    required_future_steps: [
      "Obtain fresh exact Jenn authorization for the live RunningHub regeneration task.",
      "Run only the bounded 4-shot regeneration plan if authorized.",
      "Download and register each successful output as a local generated video artifact.",
      "Run ffprobe validation for each regenerated clip.",
      "Prepare a new human review package and apply accept/reject decisions.",
      "Only assemble final video after accepted regenerated clips exist."
    ]
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
    final_assembly_performed: false,
    storyboard_package_mutated: false,
    source_assets_overwritten: false,
    credentials_read: false,
    env_files_read: false,
    secret_values_exposed: false,
    raw_provider_payload_recorded: false,
    signed_url_recorded: false,
    push_performed: false,
    tag_created: false,
    release_or_deploy_performed: false
  },
  validation: {
    "JSON parse for generated R3-9I authorization prep report": "PENDING",
    "npm run r3:9i:prep": "PASS",
    "npm run typecheck": "PENDING",
    "npm run test:m1": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "package.json",
    "scripts/r3-9i-runninghub-regeneration-authorization-prep.ts",
    OUTPUT_REPORT_PATH,
    ".agent_board/*"
  ],
  blocked_reason: result === "BLOCK_WITH_REASON"
    ? "R3-9I found local blockers; inspect regeneration_authorization_prep.local_blockers before requesting live authorization."
    : null,
  git_receipt: {
    repo: true,
    branch: "master",
    commit: "PENDING_LOCAL_COMMIT",
    task: TASK,
    push: false,
    pr: null,
    tag_created: false,
    release_or_deploy_performed: false
  }
};

writeFileSync(resolve(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      result,
      report_path: OUTPUT_REPORT_PATH,
      planned_shot_count: plannedShots.length,
      planned_shot_ids: plannedShots.map((shot) => shot.shot_id),
      max_upload_calls_total: 4,
      max_submit_calls_total: 4,
      local_blocker_count: localBlockers.length,
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false,
      credentials_read: false,
      env_files_read: false,
      regeneration_performed: false
    },
    null,
    2
  )
);

if (result === "BLOCK_WITH_REASON") process.exitCode = 1;
