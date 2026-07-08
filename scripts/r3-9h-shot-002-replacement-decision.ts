import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ensureM0Directories, paths } from "../src/index.js";

const TASK = "R3-9H_SHOT_002_REPLACEMENT_DECISION";
const SHOT_ID = "g0_r1_shot_002";
const EXPECTED_REJECT_NOTE = "我不要叹气不高兴的表情，这样会让人不想购买产品";
const R3_9F_REPORT_PATH = "data/reports/r3_9f_human_clip_review_decision_apply_result.json";
const R3_9E_REPORT_PATH = "data/reports/r3_9e_runninghub_generated_clip_review_prep_result.json";
const R3_9B_REPORT_PATH = "data/reports/r3_9b_storyboard_package_to_runninghub_generation_plan_result.json";
const R3_9G_REPORT_PATH = "data/reports/r3_9g_regeneration_strategy_for_review_notes_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_9h_shot_002_replacement_decision_result.json";

type ReportResult = "PASS_SHOT_002_DECISION_READY" | "BLOCK_WITH_REASON";

interface R3_9FDecision {
  order?: number;
  shot_id?: string;
  generated_clip_artifact_id?: string;
  source_storyboard_image_artifact_id?: string;
  decision?: "accept" | "reject" | "regenerate_requested";
  reviewer?: string;
  note?: string;
  mapped_app_decision?: string;
  before?: {
    shot_status?: string;
    accepted_clip_artifact_id?: string;
    clip_version_count?: number;
  };
  after?: {
    shot_status?: string;
    approval_status?: string;
    accepted_clip_artifact_id?: string;
    clip_review_status?: string;
    rejection_reasons?: string[];
    latest_revision_instruction?: {
      summary?: string;
      prompt_delta?: string;
      negative_delta?: string;
      priority?: string;
    };
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

interface R3_9EReviewEntry {
  order?: number;
  shot_id?: string;
  generated_clip?: {
    artifact_id?: string;
    artifact_type?: string;
    role?: string;
    status?: string;
    local_mp4_path?: string;
    file_exists?: boolean;
    byte_size?: number;
    ffprobe_status?: string;
    duration_seconds?: number;
    has_video_stream?: boolean;
    stream_count?: number;
  };
  source_keyframe?: {
    storyboard_image_artifact_id?: string;
    source_path?: string;
    storage_uri?: string;
  };
  prompt_context?: {
    shot_description?: string;
    video_prompt?: string;
    negative_prompt?: string;
  };
  local_blockers?: string[];
}

interface R3_9EReport {
  result?: string;
  review_entries?: R3_9EReviewEntry[];
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
    app_duration_seconds?: number;
    provider_duration_seconds?: number;
  };
  provider_fields?: {
    provider?: string;
    model_route?: string;
    aspectRatio?: string;
    resolution?: string;
  };
  output_plan?: {
    output_dir?: string;
  };
}

interface R3_9BReport {
  result?: string;
  package?: {
    project_id?: string;
    project_title?: string;
    storyboard_package_id?: string;
  };
  generation_plan?: {
    entries?: R3_9BPlanEntry[];
  };
  git_receipt?: { commit?: string };
}

interface R3_9GReport {
  result?: string;
  regeneration_strategy?: {
    candidate_shot_ids?: string[];
    excluded_shot_ids?: string[];
  };
  git_receipt?: { commit?: string };
}

function readJson<T>(relativePath: string): T | null {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function pathExists(maybePath: string | undefined): boolean {
  return typeof maybePath === "string" && maybePath.length > 0 && existsSync(maybePath);
}

function option(
  id: string,
  label: string,
  status: "RECOMMENDED" | "AVAILABLE" | "NOT_RECOMMENDED_NOW",
  tradeoffs: string[],
  blockers: string[],
  nextTask: string
) {
  return {
    id,
    label,
    status,
    tradeoffs,
    blockers,
    next_task_draft: nextTask
  };
}

ensureM0Directories();

const r3f = readJson<R3_9FReport>(R3_9F_REPORT_PATH);
const r3e = readJson<R3_9EReport>(R3_9E_REPORT_PATH);
const r3b = readJson<R3_9BReport>(R3_9B_REPORT_PATH);
const r3g = readJson<R3_9GReport>(R3_9G_REPORT_PATH);

const decision = r3f?.decisions?.find((item) => item.shot_id === SHOT_ID);
const reviewEntry = r3e?.review_entries?.find((item) => item.shot_id === SHOT_ID);
const planEntry = r3b?.generation_plan?.entries?.find((item) => item.shot_id === SHOT_ID);
const localBlockers: string[] = [];

if (!r3f) localBlockers.push("R3_9F_REPORT_MISSING");
if (!r3e) localBlockers.push("R3_9E_REPORT_MISSING");
if (!r3b) localBlockers.push("R3_9B_REPORT_MISSING");
if (!r3g) localBlockers.push("R3_9G_REPORT_MISSING");
if (r3f?.result !== "PASS_REVIEW_DECISIONS_APPLIED") localBlockers.push("R3_9F_NOT_PASS");
if (r3e?.result !== "PASS_REVIEW_PACKAGE_READY") localBlockers.push("R3_9E_NOT_PASS");
if (r3b?.result !== "PASS_PACKAGE_GENERATION_PLAN_READY") localBlockers.push("R3_9B_NOT_PASS");
if (r3g?.result !== "PASS_REGENERATION_STRATEGY_READY") localBlockers.push("R3_9G_NOT_PASS");
if (!r3g?.regeneration_strategy?.excluded_shot_ids?.includes(SHOT_ID)) {
  localBlockers.push("R3_9G_DID_NOT_ROUTE_SHOT_002_TO_H");
}

if (!decision) localBlockers.push("SHOT_002_REVIEW_DECISION_MISSING");
if (decision?.decision !== "reject") localBlockers.push(`SHOT_002_DECISION_NOT_REJECT:${decision?.decision ?? "missing"}`);
if (decision?.reviewer !== "Jenn") localBlockers.push(`SHOT_002_REVIEWER_NOT_JENN:${decision?.reviewer ?? "missing"}`);
if (decision?.note !== EXPECTED_REJECT_NOTE) localBlockers.push("SHOT_002_REJECT_NOTE_MISMATCH");
if (decision?.mapped_app_decision !== "revision_needed") localBlockers.push("SHOT_002_MAPPED_DECISION_NOT_REVISION_NEEDED");
if (decision?.after?.shot_status !== "revision_needed") localBlockers.push("SHOT_002_SHOT_STATUS_NOT_REVISION_NEEDED");
if (decision?.after?.approval_status !== "revision_needed") localBlockers.push("SHOT_002_APPROVAL_STATUS_NOT_REVISION_NEEDED");
if (decision?.after?.clip_review_status !== "rejected") localBlockers.push("SHOT_002_CLIP_REVIEW_STATUS_NOT_REJECTED");
if ((decision?.after?.accepted_clip_artifact_id ?? "") !== "") localBlockers.push("SHOT_002_HAS_ACCEPTED_CLIP");
if (!decision?.after?.rejection_reasons?.includes(EXPECTED_REJECT_NOTE)) localBlockers.push("SHOT_002_REJECTION_REASON_MISSING");
if (!decision?.generated_clip_artifact_id?.startsWith("artifact_")) localBlockers.push("SHOT_002_GENERATED_CLIP_ARTIFACT_ID_INVALID");
if (!decision?.source_storyboard_image_artifact_id?.startsWith("artifact_")) localBlockers.push("SHOT_002_SOURCE_STORYBOARD_ARTIFACT_ID_INVALID");

if (!reviewEntry) localBlockers.push("SHOT_002_REVIEW_ENTRY_MISSING");
if (reviewEntry?.generated_clip?.artifact_id !== decision?.generated_clip_artifact_id) {
  localBlockers.push("SHOT_002_GENERATED_CLIP_ARTIFACT_MISMATCH");
}
if (reviewEntry?.source_keyframe?.storyboard_image_artifact_id !== decision?.source_storyboard_image_artifact_id) {
  localBlockers.push("SHOT_002_SOURCE_KEYFRAME_ARTIFACT_MISMATCH");
}
if (reviewEntry?.generated_clip?.ffprobe_status !== "PASS") localBlockers.push("SHOT_002_GENERATED_CLIP_FFPROBE_NOT_PASS");
if (!pathExists(reviewEntry?.generated_clip?.local_mp4_path)) localBlockers.push("SHOT_002_GENERATED_CLIP_FILE_MISSING");
if (!pathExists(reviewEntry?.source_keyframe?.storage_uri)) localBlockers.push("SHOT_002_SOURCE_KEYFRAME_STORAGE_MISSING");
if (!pathExists(reviewEntry?.source_keyframe?.source_path)) localBlockers.push("SHOT_002_SOURCE_KEYFRAME_IMPORT_MISSING");

if (!planEntry) localBlockers.push("SHOT_002_R3_9B_PLAN_ENTRY_MISSING");
if (planEntry?.image_artifact?.artifact_id !== decision?.source_storyboard_image_artifact_id) {
  localBlockers.push("SHOT_002_PLAN_ARTIFACT_MISMATCH");
}
if (planEntry?.image_artifact?.role !== "storyboard_image") localBlockers.push("SHOT_002_PLAN_IMAGE_ROLE_NOT_STORYBOARD_IMAGE");
if (planEntry?.image_artifact?.status !== "active") localBlockers.push("SHOT_002_PLAN_IMAGE_NOT_ACTIVE");
if (planEntry?.duration?.provider_duration_seconds !== 6) localBlockers.push("SHOT_002_PROVIDER_DURATION_NOT_6");
if (planEntry?.provider_fields?.provider !== "runninghub") localBlockers.push("SHOT_002_PROVIDER_NOT_RUNNINGHUB");
if (planEntry?.provider_fields?.aspectRatio !== "9:16") localBlockers.push("SHOT_002_ASPECT_RATIO_NOT_9_16");
if (planEntry?.provider_fields?.resolution !== "480p") localBlockers.push("SHOT_002_RESOLUTION_NOT_480P");

const noAcceptedClips = r3f?.decision_apply?.decision_summary?.accept === 0;
const shot002Unresolved = decision?.after?.shot_status === "revision_needed" && (decision.after.accepted_clip_artifact_id ?? "") === "";
const result: ReportResult = localBlockers.length === 0
  ? "PASS_SHOT_002_DECISION_READY"
  : "BLOCK_WITH_REASON";

const decisionOptions = [
  option(
    "rework_prompt_and_regenerate_same_keyframe",
    "Use the same storyboard keyframe, revise the motion/expression prompt, and prepare a future single-shot regeneration.",
    "RECOMMENDED",
    [
      "Directly targets Jenn's reject note because the problem is the generated emotional expression, not an invalid artifact id or broken keyframe registration.",
      "Keeps the frozen storyboard package untouched and avoids introducing a new image provenance path.",
      "Lowest local preparation cost before a future authorized provider call.",
      "Residual risk: if the source keyframe itself reads unhappy, prompt-only repair may still reproduce a product-negative mood."
    ],
    [
      "Needs a future task to prepare the revised single-shot RunningHub plan.",
      "Needs fresh exact Jenn authorization before any real provider call.",
      "Needs later human review before final assembly."
    ],
    "R3-9I_SHOT_002_SAME_KEYFRAME_REGENERATION_PREP"
  ),
  option(
    "replace_storyboard_keyframe_before_generation",
    "Import a new approved SHOT_002 keyframe with neutral/positive buyer-safe expression, then prepare generation from that artifact.",
    "AVAILABLE",
    [
      "Best option if Jenn judges the current keyframe itself as visually unhappy, tired, or purchase-negative.",
      "Gives strongest control over facial mood before generation.",
      "Costs more local work: new WebGPT/keyframe import, media artifact registration, package/update decision, and a new authorization prep.",
      "Must avoid mutating the existing frozen package silently; any replacement should be explicit and traceable."
    ],
    [
      "Requires a newly approved source image from Jenn/WebGPT.",
      "Requires a new Media Artifact id generated by the app, not by GPT.",
      "Requires a separate package replacement or derivative package task before provider execution."
    ],
    "R3-9J_SHOT_002_REPLACEMENT_KEYFRAME_IMPORT_PREP"
  ),
  option(
    "remove_or_resequence_before_final_assembly",
    "Remove SHOT_002 from the final edit or resequence around it before assembly.",
    "NOT_RECOMMENDED_NOW",
    [
      "Avoids spending another provider submit on SHOT_002.",
      "May weaken the product story because SHOT_002 is the work-gear/lunch-table transition beat.",
      "Does not solve the rejected asset; it only changes the edit plan.",
      "Final assembly would still need accepted clips for the retained shots."
    ],
    [
      "Needs Jenn's editorial decision to drop or restructure this beat.",
      "Needs final assembly plan revision; not safe to do implicitly from this decision report."
    ],
    "R3-9K_SHOT_002_REMOVE_OR_RESEQUENCE_EDIT_DECISION"
  )
];

const promptRevisionDraft = {
  shot_description: planEntry?.prompt?.shot_description ?? reviewEntry?.prompt_context?.shot_description ?? null,
  revised_video_prompt: [
    "Use the same storyboard image as the visual anchor.",
    "Keep Ryan neutral, focused, approachable, and product-positive.",
    "Add only small natural hand movement toward the gloves or table gear.",
    "Do not create a sigh, unhappy expression, slumped posture, disappointment, fatigue, or any emotion that makes the product feel undesirable.",
    "Keep the gray skullcap visible and stable, with the same lunch table, hard hat, thermos, lunch container, worksite background, and natural daylight."
  ].join(" "),
  revised_negative_constraints: [
    "No sighing.",
    "No unhappy, disappointed, tired, discouraged, irritated, or product-negative facial expression.",
    "No downturned mouth, heavy exhale, drooping shoulders, or dejected posture.",
    "No broken hands, no extra fingers, no product drift, no text, no poster look."
  ],
  provider_prompt_not_submitted: true
};

const payload = {
  task: TASK,
  result,
  mode: "local_decision_only",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    primary_review_decision_report: R3_9F_REPORT_PATH,
    primary_review_decision_result: r3f?.result ?? null,
    primary_review_decision_commit: r3f?.git_receipt?.commit ?? null,
    review_prep_report: R3_9E_REPORT_PATH,
    review_prep_result: r3e?.result ?? null,
    generation_plan_report: R3_9B_REPORT_PATH,
    generation_plan_result: r3b?.result ?? null,
    regeneration_strategy_report: R3_9G_REPORT_PATH,
    regeneration_strategy_result: r3g?.result ?? null
  },
  shot_002_context: {
    shot_id: SHOT_ID,
    order: decision?.order ?? reviewEntry?.order ?? planEntry?.order ?? null,
    reviewer: decision?.reviewer ?? null,
    reject_reason: decision?.note ?? null,
    expected_reject_reason: EXPECTED_REJECT_NOTE,
    app_decision: decision?.mapped_app_decision ?? null,
    current_state: {
      before: decision?.before ?? null,
      after: decision?.after ?? null,
      revision_needed: decision?.after?.shot_status === "revision_needed",
      accepted_clip_artifact_id: decision?.after?.accepted_clip_artifact_id ?? null,
      unresolved: shot002Unresolved
    },
    generated_clip_artifact: {
      artifact_id: decision?.generated_clip_artifact_id ?? reviewEntry?.generated_clip?.artifact_id ?? null,
      artifact_type: reviewEntry?.generated_clip?.artifact_type ?? "video",
      role: reviewEntry?.generated_clip?.role ?? "generated_clip",
      status: reviewEntry?.generated_clip?.status ?? null,
      local_mp4_path: reviewEntry?.generated_clip?.local_mp4_path ?? null,
      file_exists: pathExists(reviewEntry?.generated_clip?.local_mp4_path),
      ffprobe_status: reviewEntry?.generated_clip?.ffprobe_status ?? null,
      duration_seconds: reviewEntry?.generated_clip?.duration_seconds ?? null,
      provider_source: "runninghub_r3_9d_single_pass_4_shot_execution"
    },
    source_storyboard_image_artifact: {
      artifact_id: decision?.source_storyboard_image_artifact_id ?? reviewEntry?.source_keyframe?.storyboard_image_artifact_id ?? null,
      artifact_type: planEntry?.image_artifact?.artifact_type ?? "image",
      role: planEntry?.image_artifact?.role ?? "storyboard_image",
      status: planEntry?.image_artifact?.status ?? null,
      source_path: reviewEntry?.source_keyframe?.source_path ?? planEntry?.image_artifact?.source_path ?? null,
      storage_uri: reviewEntry?.source_keyframe?.storage_uri ?? planEntry?.image_artifact?.storage_uri ?? null,
      source_path_exists: pathExists(reviewEntry?.source_keyframe?.source_path ?? planEntry?.image_artifact?.source_path),
      storage_uri_exists: pathExists(reviewEntry?.source_keyframe?.storage_uri ?? planEntry?.image_artifact?.storage_uri),
      source_asset_overwrite_allowed: false
    },
    original_prompt_context: {
      shot_description: planEntry?.prompt?.shot_description ?? reviewEntry?.prompt_context?.shot_description ?? null,
      video_prompt: planEntry?.prompt?.video_prompt ?? reviewEntry?.prompt_context?.video_prompt ?? null,
      negative_prompt: planEntry?.prompt?.negative_prompt ?? reviewEntry?.prompt_context?.negative_prompt ?? null
    },
    runninghub_contract_context: {
      provider: planEntry?.provider_fields?.provider ?? null,
      model_route: planEntry?.provider_fields?.model_route ?? null,
      duration_seconds: planEntry?.duration?.provider_duration_seconds ?? null,
      aspectRatio: planEntry?.provider_fields?.aspectRatio ?? null,
      resolution: planEntry?.provider_fields?.resolution ?? null,
      no_live_call_authorized_by_this_task: true
    }
  },
  decision_options: decisionOptions,
  recommended_next_path: {
    status: result === "PASS_SHOT_002_DECISION_READY" ? "RECOMMENDED_SAFE_LOCAL_NEXT_OPTION" : "BLOCKED_LOCALLY",
    option_id: "rework_prompt_and_regenerate_same_keyframe",
    rationale: [
      "Jenn rejected the emotional expression in the generated clip; the current local evidence does not show a broken or invalid storyboard image artifact.",
      "Same-keyframe rework preserves provenance and avoids mutating the frozen storyboard package.",
      "The prompt can explicitly prohibit sighing, unhappiness, dejected posture, and product-negative mood.",
      "Replacement keyframe remains the fallback if Jenn says the source keyframe itself is the problem."
    ],
    prompt_revision_draft: promptRevisionDraft,
    future_task_draft: {
      task_id: "R3-9I_SHOT_002_SAME_KEYFRAME_REGENERATION_PREP",
      status: "FOLLOW_UP_NOT_READY_UNTIL_PROMOTED",
      goal: "Prepare a single-shot RunningHub regeneration plan for SHOT_002 using the existing storyboard image artifact and the revised expression-safe prompt.",
      provider_call_allowed_in_prep: false,
      live_execution_requires_fresh_exact_authorization: true
    }
  },
  assembly_readiness: {
    final_assembly_status: "BLOCKED",
    no_accepted_clips: noAcceptedClips,
    shot_002_unresolved: shot002Unresolved,
    other_revision_needed_shots: r3g?.regeneration_strategy?.candidate_shot_ids ?? [],
    blocked_reasons: [
      "R3-9F records zero accepted clips.",
      "SHOT_002 is rejected and remains revision_needed with no accepted_clip_artifact_id.",
      "SHOT_001, SHOT_003, and SHOT_004 still need future regeneration and human acceptance."
    ]
  },
  local_blocker_count: localBlockers.length,
  local_blockers: localBlockers,
  follow_up_task_drafts: [
    {
      task_id: "R3-9I_SHOT_002_SAME_KEYFRAME_REGENERATION_PREP",
      queue_status_recommendation: "FOLLOW_UP",
      purpose: "Prepare revised prompt and dry-run plan only; no provider call."
    },
    {
      task_id: "R3-9J_SHOT_002_REPLACEMENT_KEYFRAME_IMPORT_PREP",
      queue_status_recommendation: "FOLLOW_UP",
      purpose: "Use only if Jenn chooses keyframe replacement."
    },
    {
      task_id: "R3-9K_SHOT_002_REMOVE_OR_RESEQUENCE_EDIT_DECISION",
      queue_status_recommendation: "FOLLOW_UP",
      purpose: "Use only if Jenn chooses to drop or restructure SHOT_002."
    }
  ],
  provider_boundary: {
    network_call_attempted: false,
    runninghub_called: false,
    runway_called: false,
    media_upload_to_provider: false,
    provider_submit: false,
    status_poll: false,
    output_download_from_provider: false,
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
    "JSON parse for generated SHOT_002 decision report": "PENDING",
    "npm run r3:9h:decision": "PASS",
    "npm run typecheck": "PENDING",
    "npm run test:m1": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "package.json",
    "scripts/r3-9h-shot-002-replacement-decision.ts",
    OUTPUT_REPORT_PATH,
    ".agent_board/*"
  ],
  blocked_reason: result === "BLOCK_WITH_REASON"
    ? "R3-9H found local blockers; inspect local_blockers before promoting a follow-up task."
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
      result: payload.result,
      report_path: OUTPUT_REPORT_PATH,
      shot_id: SHOT_ID,
      recommended_next_path: payload.recommended_next_path.option_id,
      local_blocker_count: localBlockers.length,
      final_assembly_status: payload.assembly_readiness.final_assembly_status,
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false,
      regeneration_performed: false,
      final_assembly_performed: false
    },
    null,
    2
  )
);

if (result === "BLOCK_WITH_REASON") process.exitCode = 1;
