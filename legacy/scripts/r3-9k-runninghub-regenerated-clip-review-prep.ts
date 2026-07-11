import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureM0Directories,
  getMediaArtifact,
  openM0Database,
  paths,
  validateMp4File,
  type MediaArtifact
} from "../src/index.js";

const TASK = "R3-9K_RUNNINGHUB_REGENERATED_CLIP_REVIEW_PREP";
const R3_9J_REPORT_PATH = "data/reports/r3_9j_runninghub_regeneration_single_pass_live_execution_result.json";
const R3_9I_REPORT_PATH = "data/reports/r3_9i_runninghub_regeneration_authorization_prep_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_9k_runninghub_regenerated_clip_review_prep_result.json";
const OUTPUT_TABLE_PATH = "data/reports/r3_9k_runninghub_regenerated_clip_review_table.md";
const EXPECTED_SHOT_IDS = [
  "g0_r1_shot_001",
  "g0_r1_shot_002",
  "g0_r1_shot_003",
  "g0_r1_shot_004"
] as const;

type ExpectedShotId = typeof EXPECTED_SHOT_IDS[number];
type ReportResult = "PASS_REVIEW_PACKAGE_READY" | "BLOCK_WITH_REASON";

interface R3_9JOutputArtifact {
  shot_id?: string;
  artifact_id?: string;
  storage_uri?: string;
  ffprobe_status?: string;
  duration_seconds?: number;
}

interface R3_9JShotReceipt {
  shot_id?: string;
  order?: number;
  status?: string;
  source_artifact_id?: string;
  rejected_clip_artifact_id?: string;
  source_path?: string;
  storage_uri?: string;
  output_dir?: string;
  generated_artifact_id?: string;
  local_storage_uri?: string;
  ffprobe_status?: string;
  ffprobe_duration_seconds?: number;
  has_video_stream?: boolean;
  stream_count?: number;
  error?: string | null;
}

interface R3_9JReport {
  task?: string;
  result?: string;
  source_plan?: {
    path?: string;
    result?: string;
    implementation_commit?: string;
  };
  live_execution?: {
    upload_call_count?: number;
    submit_call_count?: number;
    query_call_count?: number;
    successful_shot_count?: number;
    failed_shot_count?: number;
    skipped_shot_count?: number;
  };
  shots?: R3_9JShotReceipt[];
  output_artifacts?: R3_9JOutputArtifact[];
  provider_boundary?: Record<string, unknown>;
  git_receipt?: { commit?: string };
}

interface R3_9IPlannedShot {
  shot_id?: string;
  order?: number;
  human_review?: {
    decision?: string | null;
    reviewer?: string | null;
    note?: string | null;
    rejected_generated_clip_artifact_id?: string | null;
    rejected_generation_run_id?: string | null;
  };
  source_storyboard_image?: {
    artifact_id?: string | null;
    storage_uri?: string | null;
    source_path?: string | null;
  };
  original_prompt_context?: {
    shot_description?: string | null;
    video_prompt?: string | null;
    negative_prompt?: string | null;
  };
  revised_prompt_plan?: {
    prompt_guidance?: string | null;
    negative_constraints?: string[];
    review_focus?: string[];
  };
}

interface R3_9IReport {
  result?: string;
  package?: {
    project_id?: string;
    storyboard_package_id?: string;
  };
  planned_shots?: R3_9IPlannedShot[];
  git_receipt?: { commit?: string };
}

interface ReviewDecisionPlaceholder {
  accept: null;
  reject: null;
  regenerate_requested: null;
  reviewer: "";
  notes: "";
  reviewed_at: null;
}

interface ReviewEntry {
  order: number;
  shot_id: ExpectedShotId;
  generated_clip: {
    artifact_id: string | null;
    artifact_type: string | null;
    role: string | null;
    status: string | null;
    local_mp4_path: string | null;
    file_exists: boolean;
    byte_size: number;
    ffprobe_status: string | null;
    duration_seconds: number | null;
    has_video_stream: boolean | null;
    stream_count: number | null;
  };
  previous_review: {
    rejected_clip_artifact_id: string | null;
    issue_zh: string | null;
    decision: string | null;
    reviewer: string | null;
  };
  this_round_review_focus_zh: string[];
  source_keyframe: {
    storyboard_image_artifact_id: string | null;
    source_path: string | null;
    storage_uri: string | null;
  };
  prompt_context: {
    shot_description: string | null;
    video_prompt: string | null;
    negative_prompt: string | null;
    revised_prompt_guidance: string | null;
  };
  review_decision: ReviewDecisionPlaceholder;
  local_blockers: string[];
}

function readJson<T>(relativePath: string): T | null {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function fileSize(filePath: string | null | undefined): number {
  if (!filePath || !existsSync(filePath)) return 0;
  return statSync(filePath).size;
}

function decisionPlaceholder(): ReviewDecisionPlaceholder {
  return {
    accept: null,
    reject: null,
    regenerate_requested: null,
    reviewer: "",
    notes: "",
    reviewed_at: null
  };
}

function artifactSummary(artifact: MediaArtifact | null): {
  artifact_type: string | null;
  role: string | null;
  status: string | null;
  storage_uri: string | null;
} {
  return {
    artifact_type: artifact?.artifact_type ?? null,
    role: artifact?.role ?? null,
    status: artifact?.status ?? null,
    storage_uri: artifact?.storage.uri ?? null
  };
}

function isExpectedShotId(value: string | undefined): value is ExpectedShotId {
  return EXPECTED_SHOT_IDS.includes(value as ExpectedShotId);
}

function reviewFocusZh(shotId: ExpectedShotId): string[] {
  const shared = [
    "确认人物身份、灰色帽子、工装、构图、工地环境和自然光保持稳定。",
    "确认本片段只能进入人工审查，未获得 accept 前不得进入最终合成。"
  ];
  if (shotId === "g0_r1_shot_001") {
    return [
      "确认饭盒始终留在桌上，没有被端起来吃。",
      "确认手是从饭盒里面拿起食物，并把食物送到嘴边或嘴里。",
      ...shared
    ];
  }
  if (shotId === "g0_r1_shot_002") {
    return [
      "确认没有叹气、不高兴、疲惫、失望、塌肩或让产品显得负面的情绪。",
      "确认 Ryan 保持专注、自然、亲和，并且对产品观感是正向的。",
      "确认灰色帽子、午餐桌、黄色安全帽、保温杯、饭盒、工地背景和自然光保持稳定。"
    ];
  }
  if (shotId === "g0_r1_shot_003") {
    return [
      "确认拉扯帽子时折痕会变浅，面料会随着拉起方向产生真实变化。",
      "确认帽子仍贴合头部，标签、织物纹理、手部动作和脸部稳定。",
      ...shared
    ];
  }
  return [
    "确认帽子的光照方向、阴影、接触阴影和织物质感符合真实场景光影。",
    "确认轻微身体动作或镜头跟随不会破坏帽子、脸部、工装和工地背景稳定性。",
    ...shared
  ];
}

function markdownCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function buildMarkdown(entries: ReviewEntry[], reportPath: string): string {
  const rows = entries
    .map((entry) =>
      [
        entry.order,
        entry.shot_id,
        entry.generated_clip.artifact_id,
        entry.generated_clip.ffprobe_status,
        entry.generated_clip.duration_seconds,
        entry.generated_clip.local_mp4_path,
        entry.previous_review.rejected_clip_artifact_id,
        entry.previous_review.issue_zh,
        entry.this_round_review_focus_zh.join("；"),
        "",
        "",
        "",
        "",
        ""
      ].map(markdownCell).join(" | ")
    )
    .map((row) => `| ${row} |`)
    .join("\n");

  return [
    "# R3-9K RunningHub 再生成片段人工审查表",
    "",
    `来源报告：\`${R3_9J_REPORT_PATH}\``,
    `审查准备报告：\`${reportPath}\``,
    "",
    "本表只用于人工观看和记录意见，不会修改系统 review decision，也不会触发 regeneration、batch 或 final assembly。每个镜头只填写一个决策栏：accept、reject 或 regenerate_requested。",
    "",
    "final assembly 状态：等待人工 accept；未完成 accept 前保持阻塞。",
    "",
    "| 序号 | shot_id | 本轮视频 artifact_id | ffprobe | 时长秒 | 本地视频路径 | 上一轮被拒 clip | 上一轮问题 | 这轮重点检查项 | accept | reject | regenerate_requested | 审查人 | 备注 |",
    "|---:|---|---|---|---:|---|---|---|---|---|---|---|---|---|",
    rows,
    ""
  ].join("\n");
}

function sourcePlanBlockers(r3j: R3_9JReport | null, r3i: R3_9IReport | null): string[] {
  const blockers: string[] = [];
  if (!r3j) blockers.push("R3_9J_REPORT_MISSING");
  if (!r3i) blockers.push("R3_9I_REPORT_MISSING");
  if (r3j?.result !== "PASS_LIVE_4_SHOT_REGENERATION_COMPLETED") blockers.push("R3_9J_NOT_PASS");
  if (r3i?.result !== "PASS_READY_FOR_USER_AUTHORIZATION") blockers.push("R3_9I_NOT_PASS");
  if (r3j?.source_plan?.path !== R3_9I_REPORT_PATH) blockers.push("R3_9J_SOURCE_PLAN_NOT_R3_9I");
  if ((r3j?.output_artifacts ?? []).length !== 4) blockers.push("R3_9J_OUTPUT_ARTIFACT_COUNT_NOT_4");
  if ((r3j?.shots ?? []).length !== 4) blockers.push("R3_9J_SHOT_RECEIPT_COUNT_NOT_4");
  if ((r3i?.planned_shots ?? []).length !== 4) blockers.push("R3_9I_PLANNED_SHOT_COUNT_NOT_4");
  if (r3j?.live_execution?.successful_shot_count !== 4) blockers.push("R3_9J_SUCCESSFUL_SHOT_COUNT_NOT_4");
  if (r3j?.live_execution?.failed_shot_count !== 0) blockers.push("R3_9J_HAS_FAILED_SHOTS");
  if (r3j?.live_execution?.skipped_shot_count !== 0) blockers.push("R3_9J_HAS_SKIPPED_SHOTS");
  return blockers;
}

function entryBlockers(entry: ReviewEntry): string[] {
  const blockers: string[] = [];
  if (!entry.generated_clip.artifact_id?.startsWith("artifact_")) blockers.push("GENERATED_ARTIFACT_ID_INVALID");
  if (entry.generated_clip.artifact_type !== "video") blockers.push("GENERATED_ARTIFACT_TYPE_NOT_VIDEO");
  if (entry.generated_clip.role !== "generated_clip") blockers.push("GENERATED_ARTIFACT_ROLE_NOT_GENERATED_CLIP");
  if (entry.generated_clip.status !== "active") blockers.push("GENERATED_ARTIFACT_STATUS_NOT_ACTIVE");
  if (!entry.generated_clip.local_mp4_path || !entry.generated_clip.file_exists) blockers.push("LOCAL_MP4_MISSING");
  if (entry.generated_clip.ffprobe_status !== "PASS") blockers.push("FFPROBE_NOT_PASS");
  if (entry.generated_clip.has_video_stream !== true) blockers.push("VIDEO_STREAM_MISSING");
  if (!entry.previous_review.rejected_clip_artifact_id?.startsWith("artifact_")) blockers.push("PREVIOUS_REJECTED_CLIP_ARTIFACT_ID_INVALID");
  if (!entry.previous_review.issue_zh) blockers.push("PREVIOUS_ISSUE_MISSING");
  if (entry.this_round_review_focus_zh.length < 2) blockers.push("REVIEW_FOCUS_MISSING");
  if (!entry.source_keyframe.storyboard_image_artifact_id?.startsWith("artifact_")) blockers.push("SOURCE_IMAGE_ARTIFACT_ID_INVALID");
  return blockers;
}

ensureM0Directories();

const r3j = readJson<R3_9JReport>(R3_9J_REPORT_PATH);
const r3i = readJson<R3_9IReport>(R3_9I_REPORT_PATH);
const planBlockers = sourcePlanBlockers(r3j, r3i);
const outputByShot = new Map((r3j?.output_artifacts ?? []).map((artifact) => [artifact.shot_id ?? "", artifact]));
const shotReceiptByShot = new Map((r3j?.shots ?? []).map((shot) => [shot.shot_id ?? "", shot]));
const previousPlanByShot = new Map((r3i?.planned_shots ?? []).map((shot) => [shot.shot_id ?? "", shot]));

const db = openM0Database();
let entries: ReviewEntry[] = [];
try {
  entries = EXPECTED_SHOT_IDS.map((shotId, index) => {
    const output = outputByShot.get(shotId);
    const receipt = shotReceiptByShot.get(shotId);
    const previous = previousPlanByShot.get(shotId);
    const artifactId = output?.artifact_id ?? receipt?.generated_artifact_id ?? null;
    const generatedArtifact = artifactId ? getMediaArtifact(db, artifactId) : null;
    const generated = artifactSummary(generatedArtifact);
    const localMp4Path = generated.storage_uri ?? output?.storage_uri ?? receipt?.local_storage_uri ?? null;
    const ffprobe = localMp4Path && existsSync(localMp4Path) ? validateMp4File(localMp4Path) : null;
    const shotIdFromSources = output?.shot_id ?? receipt?.shot_id ?? previous?.shot_id ?? shotId;
    if (!isExpectedShotId(shotIdFromSources)) {
      throw new Error(`Unexpected shot_id in R3-9K source reports: ${shotIdFromSources}`);
    }

    const entry: ReviewEntry = {
      order: receipt?.order ?? previous?.order ?? index + 1,
      shot_id: shotIdFromSources,
      generated_clip: {
        artifact_id: artifactId,
        artifact_type: generated.artifact_type,
        role: generated.role,
        status: generated.status,
        local_mp4_path: localMp4Path,
        file_exists: Boolean(localMp4Path && existsSync(localMp4Path)),
        byte_size: fileSize(localMp4Path),
        ffprobe_status: ffprobe?.status ?? output?.ffprobe_status ?? receipt?.ffprobe_status ?? null,
        duration_seconds: ffprobe?.duration_seconds ?? output?.duration_seconds ?? receipt?.ffprobe_duration_seconds ?? null,
        has_video_stream: ffprobe?.has_video_stream ?? receipt?.has_video_stream ?? null,
        stream_count: ffprobe?.stream_count ?? receipt?.stream_count ?? null
      },
      previous_review: {
        rejected_clip_artifact_id: previous?.human_review?.rejected_generated_clip_artifact_id ?? receipt?.rejected_clip_artifact_id ?? null,
        issue_zh: previous?.human_review?.note ?? null,
        decision: previous?.human_review?.decision ?? null,
        reviewer: previous?.human_review?.reviewer ?? null
      },
      this_round_review_focus_zh: reviewFocusZh(shotIdFromSources),
      source_keyframe: {
        storyboard_image_artifact_id: previous?.source_storyboard_image?.artifact_id ?? receipt?.source_artifact_id ?? null,
        source_path: previous?.source_storyboard_image?.source_path ?? receipt?.source_path ?? null,
        storage_uri: previous?.source_storyboard_image?.storage_uri ?? receipt?.storage_uri ?? null
      },
      prompt_context: {
        shot_description: previous?.original_prompt_context?.shot_description ?? null,
        video_prompt: previous?.original_prompt_context?.video_prompt ?? null,
        negative_prompt: previous?.original_prompt_context?.negative_prompt ?? null,
        revised_prompt_guidance: previous?.revised_prompt_plan?.prompt_guidance ?? null
      },
      review_decision: decisionPlaceholder(),
      local_blockers: []
    };
    entry.local_blockers = entryBlockers(entry);
    return entry;
  });
} finally {
  db.close();
}

const unexpectedShotIds = entries.filter((entry) => !EXPECTED_SHOT_IDS.includes(entry.shot_id));
const duplicateArtifacts = entries
  .map((entry) => entry.generated_clip.artifact_id)
  .filter((artifactId, index, all) => artifactId && all.indexOf(artifactId) !== index);
const entryBlockerCount = entries.reduce((sum, entry) => sum + entry.local_blockers.length, 0);
if (unexpectedShotIds.length > 0) planBlockers.push("UNEXPECTED_SHOT_IDS_PRESENT");
if (duplicateArtifacts.length > 0) planBlockers.push("DUPLICATE_GENERATED_ARTIFACT_IDS");

const result: ReportResult = planBlockers.length === 0 && entries.length === 4 && entryBlockerCount === 0
  ? "PASS_REVIEW_PACKAGE_READY"
  : "BLOCK_WITH_REASON";

const markdown = buildMarkdown(entries, OUTPUT_REPORT_PATH);
writeFileSync(resolve(paths.workspaceRoot, OUTPUT_TABLE_PATH), markdown, "utf8");

const payload = {
  task: TASK,
  result,
  mode: "local_review_prep_only",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    r3_9j_live_report: R3_9J_REPORT_PATH,
    r3_9j_result: r3j?.result ?? null,
    r3_9j_commit: r3j?.git_receipt?.commit ?? null,
    r3_9i_regeneration_authorization_prep_report: R3_9I_REPORT_PATH,
    r3_9i_result: r3i?.result ?? null,
    r3_9i_commit: r3i?.git_receipt?.commit ?? null
  },
  package: {
    project_id: r3i?.package?.project_id ?? null,
    storyboard_package_id: r3i?.package?.storyboard_package_id ?? null
  },
  review_package: {
    status: result === "PASS_REVIEW_PACKAGE_READY" ? "READY_FOR_HUMAN_REVIEW" : "BLOCKED_LOCALLY",
    language: "zh-CN",
    generated_clip_count: entries.length,
    local_blocker_count: entryBlockerCount,
    source_plan_blockers: planBlockers,
    review_table_path: OUTPUT_TABLE_PATH,
    required_decision_fields: ["accept", "reject", "regenerate_requested"],
    no_review_decisions_selected: entries.every((entry) =>
      entry.review_decision.accept === null &&
      entry.review_decision.reject === null &&
      entry.review_decision.regenerate_requested === null
    ),
    app_review_state_mutated: false
  },
  review_entries: entries,
  ffprobe_summary: entries.map((entry) => ({
    shot_id: entry.shot_id,
    artifact_id: entry.generated_clip.artifact_id,
    local_mp4_path: entry.generated_clip.local_mp4_path,
    ffprobe_status: entry.generated_clip.ffprobe_status,
    duration_seconds: entry.generated_clip.duration_seconds,
    has_video_stream: entry.generated_clip.has_video_stream,
    stream_count: entry.generated_clip.stream_count,
    byte_size: entry.generated_clip.byte_size
  })),
  assembly_readiness: {
    final_assembly_status: "BLOCKED_PENDING_HUMAN_ACCEPT",
    final_assembly_performed: false,
    required_before_assembly: [
      "Human reviewer must watch each regenerated MP4.",
      "Each shot must receive exactly one review decision.",
      "Only accepted regenerated clips may be used by a future final assembly task."
    ]
  },
  human_review_next_step: {
    instruction_zh: "请人工打开表格中的本地 MP4 路径逐条观看，并为每个镜头填写 accept、reject 或 regenerate_requested 其中一个决策。",
    accept: "片段修复了上一轮问题且可进入后续最终合成准备。",
    reject: "片段仍不可用，且不应进入最终合成。",
    regenerate_requested: "片段需要再次准备重生成任务；本报告不会自动触发重生成。",
    notes_required_for_reject_or_regenerate: true,
    mutation_performed_by_this_task: false
  },
  provider_boundary: {
    network_call_attempted: false,
    runninghub_called: false,
    runway_called: false,
    regeneration_performed: false,
    batch_generation_performed: false,
    final_assembly_performed: false,
    review_decision_mutation_performed: false,
    credentials_read: false,
    env_files_read: false,
    source_assets_overwritten: false,
    secret_values_exposed: false,
    raw_provider_payload_recorded: false,
    signed_url_recorded: false,
    push_performed: false,
    tag_created: false,
    release_or_deploy_performed: false
  },
  validation: {
    "npm run r3:9k:review-prep": "PASS",
    "JSON parse for generated R3-9K review prep report": "PENDING",
    "table parse / required rows check": "PENDING",
    "npm run typecheck": "PENDING",
    "npm run test:m1": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "package.json",
    "scripts/r3-9k-runninghub-regenerated-clip-review-prep.ts",
    OUTPUT_REPORT_PATH,
    OUTPUT_TABLE_PATH,
    ".agent_board/*"
  ],
  blocked_reason: result === "BLOCK_WITH_REASON"
    ? "R3-9K review prep found local blockers; inspect review_package.source_plan_blockers and review_entries[].local_blockers."
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
      review_table_path: OUTPUT_TABLE_PATH,
      generated_clip_count: entries.length,
      local_blocker_count: entryBlockerCount,
      final_assembly_status: payload.assembly_readiness.final_assembly_status,
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false,
      review_decision_mutation_performed: false,
      credentials_read: false,
      env_files_read: false
    },
    null,
    2
  )
);
if (result === "BLOCK_WITH_REASON") process.exitCode = 1;
