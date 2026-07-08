import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ensureM0Directories, paths } from "../src/index.js";

const TASK = "R3-9P_FINAL_VIDEO_REVIEW_PACKAGE";
const SOURCE_REPORT_PATH = "data/reports/r3_9o_final_video_assembly_execution_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_9p_final_video_review_package_result.json";
const REVIEW_TABLE_PATH = "data/reports/r3_9p_final_video_review_table.md";

interface R3_9OReport {
  result?: string;
  project?: {
    project_id?: string | null;
    project_title?: string | null;
    storyboard_package_id?: string | null;
  };
  assembly_execution?: {
    final_video_path?: string;
    final_video_artifact_id?: string | null;
    final_video_artifact_path?: string | null;
    final_video_exists?: boolean;
    final_video_byte_size?: number;
    final_video_written?: boolean;
    final_assembly_performed?: boolean;
    source_clip_artifact_ids?: string[];
    output_duration_seconds?: number | null;
    assembly_run_id?: string | null;
  };
  ordered_input_clips?: SourceClip[];
  ffprobe_result?: {
    status?: string;
    duration_seconds?: number | null;
    stream_count?: number;
    has_video_stream?: boolean;
    ffprobe_exit_code?: number | null;
    error?: string;
  };
  provider_boundary?: Record<string, unknown>;
  git_receipt?: {
    commit?: string;
  };
}

interface SourceClip {
  order: number;
  shot_id: string;
  accepted_clip_artifact_id: string;
  local_mp4_path: string;
  duration_seconds: number;
  ffprobe_status: string;
  source_generation_run_id: string;
  generation_batch_id: string;
}

function readJson<T>(relativePath: string): T | null {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function md(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function code(value: unknown): string {
  return `\`${md(value)}\``;
}

function sourceClipIds(clips: SourceClip[]): string[] {
  return clips.map((clip) => clip.accepted_clip_artifact_id).filter(Boolean);
}

ensureM0Directories();

const source = readJson<R3_9OReport>(SOURCE_REPORT_PATH);
const clips = [...(source?.ordered_input_clips ?? [])].sort((left, right) => left.order - right.order);
const finalVideoPath = source?.assembly_execution?.final_video_path ?? "";
const finalArtifactId = source?.assembly_execution?.final_video_artifact_id ?? null;
const blockers: string[] = [];

if (!source) blockers.push("R3_9O_REPORT_MISSING");
if (source?.result !== "PASS_LOCAL_FINAL_VIDEO_ASSEMBLED") blockers.push("R3_9O_NOT_PASS");
if (source?.assembly_execution?.final_video_written !== true) blockers.push("FINAL_VIDEO_NOT_WRITTEN");
if (source?.assembly_execution?.final_assembly_performed !== true) blockers.push("FINAL_ASSEMBLY_NOT_PERFORMED");
if (!finalVideoPath || !existsSync(finalVideoPath)) blockers.push("FINAL_VIDEO_PATH_MISSING");
if (!finalArtifactId?.startsWith("artifact_")) blockers.push("FINAL_VIDEO_ARTIFACT_ID_INVALID");
if (source?.ffprobe_result?.status !== "PASS") blockers.push("FINAL_VIDEO_FFPROBE_NOT_PASS");
if (source?.ffprobe_result?.has_video_stream !== true) blockers.push("FINAL_VIDEO_STREAM_MISSING");
if ((source?.ffprobe_result?.duration_seconds ?? 0) <= 0) blockers.push("FINAL_VIDEO_DURATION_INVALID");
if (clips.length !== 4) blockers.push("SOURCE_CLIP_COUNT_NOT_4");
for (const clip of clips) {
  if (!clip.accepted_clip_artifact_id?.startsWith("artifact_")) blockers.push(`${clip.shot_id}:SOURCE_CLIP_ARTIFACT_ID_INVALID`);
  if (!clip.local_mp4_path || !existsSync(clip.local_mp4_path)) blockers.push(`${clip.shot_id}:SOURCE_CLIP_PATH_MISSING`);
  if (clip.ffprobe_status !== "PASS") blockers.push(`${clip.shot_id}:SOURCE_CLIP_FFPROBE_NOT_PASS`);
}

const result = blockers.length === 0 ? "PASS_FINAL_VIDEO_REVIEW_PACKAGE_READY" : "BLOCK_FINAL_VIDEO_REVIEW_PACKAGE_WITH_REASON";
const sourceIds = sourceClipIds(clips);
const finalVideoExists = Boolean(finalVideoPath && existsSync(finalVideoPath));

const reviewTable = [
  "# R3-9P 最终视频人工审查表",
  "",
  "状态：等待人工最终创意批准。",
  "",
  `来源报告：${code(SOURCE_REPORT_PATH)}`,
  `最终视频：${code(finalVideoPath)}`,
  `最终视频 Artifact：${code(finalArtifactId ?? "")}`,
  `ffprobe：${code(source?.ffprobe_result?.status ?? "")}，时长 ${code(source?.ffprobe_result?.duration_seconds ?? "")} 秒，stream_count ${code(source?.ffprobe_result?.stream_count ?? "")}`,
  "",
  "## 最终决策",
  "",
  "| 审查对象 | 本地视频路径 | Final Artifact | 来源 Clip Artifacts | accept | reject | revision_requested | 审查人 | 备注 |",
  "|---|---|---|---|---|---|---|---|---|",
  `| 最终成片 | ${code(finalVideoPath)} | ${code(finalArtifactId ?? "")} | ${sourceIds.map(code).join("<br>")} | [ ] | [ ] | [ ] |  |  |`,
  "",
  "## 来源片段",
  "",
  "| 顺序 | shot_id | 来源 Clip Artifact | 本地 MP4 | ffprobe | 时长秒 | 生成 run |",
  "|---:|---|---|---|---|---:|---|",
  ...clips.map((clip) => `| ${clip.order} | ${md(clip.shot_id)} | ${code(clip.accepted_clip_artifact_id)} | ${code(clip.local_mp4_path)} | ${md(clip.ffprobe_status)} | ${clip.duration_seconds} | ${code(clip.source_generation_run_id)} |`),
  "",
  "## 边界",
  "",
  "- 本审查包没有发布、部署、上传或调用 provider。",
  "- 本审查包没有记录最终创意批准。",
  "- 需要人工在最终决策行选择 `accept`、`reject` 或 `revision_requested` 后，另行执行决策应用任务。"
].join("\n");
writeFileSync(resolve(paths.workspaceRoot, REVIEW_TABLE_PATH), `${reviewTable}\n`, "utf8");

const payload = {
  task: TASK,
  result,
  mode: "local_final_video_review_package_only",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    r3_9o_assembly_report: SOURCE_REPORT_PATH,
    r3_9o_result: source?.result ?? null,
    r3_9o_commit: source?.git_receipt?.commit ?? null
  },
  project: {
    project_id: source?.project?.project_id ?? null,
    project_title: source?.project?.project_title ?? null,
    storyboard_package_id: source?.project?.storyboard_package_id ?? null
  },
  final_video: {
    local_video_path: finalVideoPath,
    local_video_exists: finalVideoExists,
    final_video_artifact_id: finalArtifactId,
    final_video_artifact_path: source?.assembly_execution?.final_video_artifact_path ?? null,
    byte_size: source?.assembly_execution?.final_video_byte_size ?? null,
    assembly_run_id: source?.assembly_execution?.assembly_run_id ?? null,
    ffprobe: source?.ffprobe_result ?? null
  },
  source_clips: clips.map((clip) => ({
    order: clip.order,
    shot_id: clip.shot_id,
    source_clip_artifact_id: clip.accepted_clip_artifact_id,
    local_mp4_path: clip.local_mp4_path,
    ffprobe_status: clip.ffprobe_status,
    duration_seconds: clip.duration_seconds,
    source_generation_run_id: clip.source_generation_run_id,
    generation_batch_id: clip.generation_batch_id
  })),
  review_package: {
    status: result === "PASS_FINAL_VIDEO_REVIEW_PACKAGE_READY" ? "READY_FOR_HUMAN_FINAL_REVIEW" : "BLOCKED",
    review_table_path: REVIEW_TABLE_PATH,
    review_controls_present: ["accept", "reject", "revision_requested"],
    review_controls_preselected: false,
    final_creative_approval_recorded: false,
    decision: null,
    reviewer: null,
    local_blocker_count: blockers.length,
    local_blockers: blockers
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
    regeneration_performed: false,
    batch_generation_performed: false,
    env_files_read: false,
    credentials_read: false,
    source_assets_overwritten: false,
    secret_values_exposed: false,
    raw_provider_payload_recorded: false,
    signed_url_recorded: false,
    publish_performed: false,
    final_creative_approval_recorded: false,
    push_performed: false,
    tag_created: false,
    release_or_deploy_performed: false
  },
  validation: {
    "npm run r3:9p:review-package": result === "PASS_FINAL_VIDEO_REVIEW_PACKAGE_READY" ? "PASS" : "FAIL",
    "JSON parse for generated final video review package report": "PENDING",
    "review table required fields check": "PENDING",
    "final video path existence check": finalVideoExists ? "PASS" : "FAIL",
    "npm run typecheck": "PENDING",
    "npm run test:m1": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "package.json",
    "scripts/r3-9p-final-video-review-package.ts",
    OUTPUT_REPORT_PATH,
    REVIEW_TABLE_PATH,
    ".agent_board/*"
  ],
  blocked_reason: result === "PASS_FINAL_VIDEO_REVIEW_PACKAGE_READY" ? null : "R3-9P review package blocked; inspect review_package.local_blockers.",
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
console.log(JSON.stringify({
  result,
  report_path: OUTPUT_REPORT_PATH,
  review_table_path: REVIEW_TABLE_PATH,
  final_video_path: finalVideoPath,
  final_video_artifact_id: finalArtifactId,
  source_clip_count: clips.length,
  final_creative_approval_recorded: false,
  network_call_attempted: false,
  runninghub_called: false,
  runway_called: false,
  env_files_read: false,
  credentials_read: false,
  secret_values_exposed: false
}, null, 2));
if (result !== "PASS_FINAL_VIDEO_REVIEW_PACKAGE_READY") process.exitCode = 1;
