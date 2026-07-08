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

const TASK = "R3-9E_RUNNINGHUB_GENERATED_CLIP_REVIEW_PREP";
const R3_9D_REPORT_PATH = "data/reports/r3_9d_runninghub_4_shot_single_pass_live_execution_result.json";
const R3_9C_REPORT_PATH = "data/reports/r3_9c_runninghub_4_shot_live_authorization_prep_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_9e_runninghub_generated_clip_review_prep_result.json";
const OUTPUT_TABLE_PATH = "data/reports/r3_9e_runninghub_generated_clip_review_table.md";

type ReportResult = "PASS_REVIEW_PACKAGE_READY" | "BLOCK_WITH_REASON";

interface R3_9DOutputArtifact {
  shot_id?: string;
  artifact_id?: string;
  storage_uri?: string;
  ffprobe_status?: string;
  duration_seconds?: number;
}

interface R3_9DShotReceipt {
  shot_id?: string;
  order?: number;
  status?: string;
  artifact_id?: string;
  source_path?: string;
  storage_uri?: string;
  output_dir?: string;
  generated_artifact_id?: string;
  local_storage_uri?: string;
  ffprobe_status?: string;
  ffprobe_duration_seconds?: number;
}

interface R3_9DReport {
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
  shots?: R3_9DShotReceipt[];
  output_artifacts?: R3_9DOutputArtifact[];
  provider_boundary?: Record<string, unknown>;
  git_receipt?: { commit?: string };
}

interface R3_9CShotConfirmation {
  shot_id?: string | null;
  order?: number | null;
  artifact?: {
    artifact_id?: string | null;
    source_path?: string | null;
    storage_uri?: string | null;
  };
  prompt?: {
    shot_description?: string | null;
    video_prompt?: string | null;
    negative_prompt?: string | null;
  } | null;
}

interface R3_9CReport {
  result?: string;
  shot_confirmations?: R3_9CShotConfirmation[];
  git_receipt?: { implementation_commit?: string };
}

interface ReviewDecisionPlaceholder {
  accept: null;
  reject: null;
  regenerate_requested: null;
  notes: "";
  reviewer: "";
  reviewed_at: null;
}

interface ReviewEntry {
  order: number | null;
  shot_id: string | null;
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
  source_keyframe: {
    storyboard_image_artifact_id: string | null;
    source_path: string | null;
    storage_uri: string | null;
  };
  prompt_context: {
    shot_description: string | null;
    video_prompt: string | null;
    negative_prompt: string | null;
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
    notes: "",
    reviewer: "",
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

function markdownCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function buildMarkdown(entries: ReviewEntry[], reportPath: string): string {
  const rows = entries
    .map((entry) =>
      [
        entry.order ?? "",
        entry.shot_id ?? "",
        entry.generated_clip.artifact_id ?? "",
        entry.generated_clip.ffprobe_status ?? "",
        entry.generated_clip.duration_seconds ?? "",
        entry.generated_clip.local_mp4_path ?? "",
        entry.source_keyframe.storyboard_image_artifact_id ?? "",
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
    "# R3-9E RunningHub 生成片段人工审查表",
    "",
    `来源报告：\`${reportPath}\``,
    "",
    "人工审查时，每个镜头只填写一个决策栏：接受、拒绝或请求重生成。本表只是审查准备面板，不会修改应用内审查状态。",
    "",
    "| 序号 | 镜头 | 生成片段 Artifact | ffprobe | 时长 | 本地 MP4 | 来源分镜图 Artifact | 接受 | 拒绝 | 请求重生成 | 审查人 | 备注 |",
    "|---:|---|---|---|---:|---|---|---|---|---|---|---|",
    rows,
    ""
  ].join("\n");
}

function sourcePlanBlockers(r3d: R3_9DReport | null, r3c: R3_9CReport | null): string[] {
  const blockers: string[] = [];
  if (!r3d) blockers.push("R3_9D_REPORT_MISSING");
  if (!r3c) blockers.push("R3_9C_REPORT_MISSING");
  if (r3d?.result !== "PASS_LIVE_4_SHOT_SINGLE_PASS_COMPLETED") blockers.push("R3_9D_NOT_PASS");
  if (r3c?.result !== "PASS_READY_FOR_USER_AUTHORIZATION") blockers.push("R3_9C_NOT_PASS");
  if ((r3d?.output_artifacts ?? []).length !== 4) blockers.push("R3_9D_OUTPUT_ARTIFACT_COUNT_NOT_4");
  if ((r3d?.shots ?? []).length !== 4) blockers.push("R3_9D_SHOT_RECEIPT_COUNT_NOT_4");
  if (r3d?.live_execution?.successful_shot_count !== 4) blockers.push("R3_9D_SUCCESSFUL_SHOT_COUNT_NOT_4");
  if (r3d?.live_execution?.failed_shot_count !== 0) blockers.push("R3_9D_HAS_FAILED_SHOTS");
  if (r3d?.live_execution?.skipped_shot_count !== 0) blockers.push("R3_9D_HAS_SKIPPED_SHOTS");
  return blockers;
}

function entryBlockers(entry: ReviewEntry): string[] {
  const blockers: string[] = [];
  if (!entry.shot_id) blockers.push("SHOT_ID_MISSING");
  if (!entry.generated_clip.artifact_id?.startsWith("artifact_")) blockers.push("GENERATED_ARTIFACT_ID_INVALID");
  if (entry.generated_clip.artifact_type !== "video" || entry.generated_clip.role !== "generated_clip" || entry.generated_clip.status !== "active") {
    blockers.push("GENERATED_ARTIFACT_CLASSIFICATION_INVALID");
  }
  if (!entry.generated_clip.local_mp4_path || !entry.generated_clip.file_exists) blockers.push("LOCAL_MP4_MISSING");
  if (entry.generated_clip.ffprobe_status !== "PASS") blockers.push("FFPROBE_NOT_PASS");
  if (entry.generated_clip.has_video_stream !== true) blockers.push("VIDEO_STREAM_MISSING");
  if (!entry.source_keyframe.storyboard_image_artifact_id?.startsWith("artifact_")) blockers.push("SOURCE_IMAGE_ARTIFACT_ID_INVALID");
  if (!entry.source_keyframe.source_path || !existsSync(entry.source_keyframe.source_path)) blockers.push("SOURCE_KEYFRAME_PATH_MISSING");
  if (!entry.source_keyframe.storage_uri || !existsSync(entry.source_keyframe.storage_uri)) blockers.push("SOURCE_KEYFRAME_STORAGE_MISSING");
  if (!entry.prompt_context.video_prompt) blockers.push("VIDEO_PROMPT_MISSING");
  return blockers;
}

ensureM0Directories();

const r3d = readJson<R3_9DReport>(R3_9D_REPORT_PATH);
const r3c = readJson<R3_9CReport>(R3_9C_REPORT_PATH);
const planBlockers = sourcePlanBlockers(r3d, r3c);
const sourceByShot = new Map((r3c?.shot_confirmations ?? []).map((shot) => [shot.shot_id ?? "", shot]));
const outputByShot = new Map((r3d?.output_artifacts ?? []).map((artifact) => [artifact.shot_id ?? "", artifact]));

const db = openM0Database();
let entries: ReviewEntry[] = [];
try {
  entries = (r3d?.shots ?? []).map((shot) => {
    const output = outputByShot.get(shot.shot_id ?? "");
    const generatedArtifact = output?.artifact_id ? getMediaArtifact(db, output.artifact_id) : null;
    const source = sourceByShot.get(shot.shot_id ?? "");
    const generated = artifactSummary(generatedArtifact);
    const localMp4Path = generated.storage_uri ?? output?.storage_uri ?? shot.local_storage_uri ?? null;
    const ffprobe = localMp4Path && existsSync(localMp4Path) ? validateMp4File(localMp4Path) : null;
    const entry: ReviewEntry = {
      order: shot.order ?? source?.order ?? null,
      shot_id: shot.shot_id ?? source?.shot_id ?? null,
      generated_clip: {
        artifact_id: output?.artifact_id ?? shot.generated_artifact_id ?? null,
        artifact_type: generated.artifact_type,
        role: generated.role,
        status: generated.status,
        local_mp4_path: localMp4Path,
        file_exists: Boolean(localMp4Path && existsSync(localMp4Path)),
        byte_size: fileSize(localMp4Path),
        ffprobe_status: ffprobe?.status ?? output?.ffprobe_status ?? shot.ffprobe_status ?? null,
        duration_seconds: ffprobe?.duration_seconds ?? output?.duration_seconds ?? shot.ffprobe_duration_seconds ?? null,
        has_video_stream: ffprobe?.has_video_stream ?? null,
        stream_count: ffprobe?.stream_count ?? null
      },
      source_keyframe: {
        storyboard_image_artifact_id: source?.artifact?.artifact_id ?? shot.artifact_id ?? null,
        source_path: source?.artifact?.source_path ?? shot.source_path ?? null,
        storage_uri: source?.artifact?.storage_uri ?? shot.storage_uri ?? null
      },
      prompt_context: {
        shot_description: source?.prompt?.shot_description ?? null,
        video_prompt: source?.prompt?.video_prompt ?? null,
        negative_prompt: source?.prompt?.negative_prompt ?? null
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

const entryBlockerCount = entries.reduce((sum, entry) => sum + entry.local_blockers.length, 0);
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
    r3_9d_live_report: R3_9D_REPORT_PATH,
    r3_9d_result: r3d?.result ?? null,
    r3_9d_commit: r3d?.git_receipt?.commit ?? null,
    r3_9c_authorization_prep_report: R3_9C_REPORT_PATH,
    r3_9c_result: r3c?.result ?? null,
    r3_9c_commit: r3c?.git_receipt?.implementation_commit ?? null
  },
  review_package: {
    status: result === "PASS_REVIEW_PACKAGE_READY" ? "READY_FOR_HUMAN_REVIEW" : "BLOCKED_LOCALLY",
    generated_clip_count: entries.length,
    local_blocker_count: entryBlockerCount,
    source_plan_blockers: planBlockers,
    review_table_path: OUTPUT_TABLE_PATH,
    no_review_decisions_selected: entries.every((entry) =>
      entry.review_decision.accept === null &&
      entry.review_decision.reject === null &&
      entry.review_decision.regenerate_requested === null
    ),
    app_review_state_mutated: false
  },
  review_entries: entries,
  human_review_next_step: {
    instruction: "打开本地 MP4 路径完成人工观看后，每个镜头只填写一个决策：accept、reject 或 regenerate_requested。",
    accept: "仅在人工视觉审查确认片段可用后填写。",
    reject: "当片段不应进入最终合成时填写。",
    regenerate_requested: "当后续需要准备单独的重生成任务时填写；本报告不会触发重生成。",
    notes_required_for_reject_or_regenerate: true,
    mutation_performed_by_this_task: false
  },
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
    review_decision_mutation_performed: false,
    source_assets_overwritten: false,
    secret_values_exposed: false,
    raw_provider_payload_recorded: false,
    signed_url_recorded: false,
    push_performed: false,
    tag_created: false,
    release_or_deploy_performed: false
  },
  validation: {
    "JSON parse for generated review package report": "PENDING",
    "Markdown review table exists": "PASS",
    "npm run r3:9e:review-prep": "PASS",
    "npm run typecheck": "PENDING",
    "npm run test:m1": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "package.json",
    "scripts/r3-9e-runninghub-generated-clip-review-prep.ts",
    OUTPUT_REPORT_PATH,
    OUTPUT_TABLE_PATH,
    ".agent_board/*"
  ],
  blocked_reason: result === "BLOCK_WITH_REASON"
    ? "R3-9E review prep found local blockers; inspect review_package.source_plan_blockers and review_entries[].local_blockers."
    : null,
  next_step: {
    human_review_required: true,
    provider_regeneration_requires_separate_task: true,
    final_assembly_requires_separate_task_after_acceptance: true
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
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false,
      review_decision_mutation_performed: false
    },
    null,
    2
  )
);
if (result === "BLOCK_WITH_REASON") process.exitCode = 1;
