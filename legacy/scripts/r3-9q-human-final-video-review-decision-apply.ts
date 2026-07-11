import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureM0Directories,
  getMediaArtifact,
  getProject,
  openM0Database,
  paths,
  saveProject,
  validateMp4File,
  type ProjectStatus
} from "../src/index.js";

const TASK = "R3-9Q_HUMAN_FINAL_VIDEO_REVIEW_DECISION_APPLY";
const SOURCE_TABLE_PATH = "data/reports/r3_9p_final_video_review_table.md";
const SOURCE_REPORT_PATH = "data/reports/r3_9p_final_video_review_package_result.json";
const ASSEMBLY_REPORT_PATH = "data/reports/r3_9o_final_video_assembly_execution_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_9q_human_final_video_review_decision_apply_result.json";
const EXPECTED_FINAL_ARTIFACT_ID = "artifact_2fa09a9e-3408-49f8-96f9-42c87cfbbfbe";

type FinalDecision = "accept" | "reject" | "revision_requested";

interface R3_9PReport {
  result?: string;
  project?: {
    project_id?: string | null;
    project_title?: string | null;
    storyboard_package_id?: string | null;
  };
  final_video?: {
    local_video_path?: string;
    final_video_artifact_id?: string | null;
    final_video_artifact_path?: string | null;
    ffprobe?: {
      status?: string;
      duration_seconds?: number | null;
      has_video_stream?: boolean;
      stream_count?: number;
      ffprobe_exit_code?: number | null;
    };
  };
  source_clips?: SourceClip[];
  git_receipt?: { commit?: string };
}

interface R3_9OReport {
  result?: string;
  assembly_execution?: {
    final_video_path?: string;
    final_video_artifact_id?: string | null;
    source_clip_artifact_ids?: string[];
  };
  ffprobe_result?: {
    status?: string;
    duration_seconds?: number | null;
    has_video_stream?: boolean;
  };
  git_receipt?: { commit?: string };
}

interface SourceClip {
  order: number;
  shot_id: string;
  source_clip_artifact_id: string;
  local_mp4_path: string;
  ffprobe_status: string;
  duration_seconds: number;
  source_generation_run_id: string;
  generation_batch_id: string;
}

interface FinalDecisionRow {
  review_object: string;
  final_video_path: string;
  final_video_artifact_id: string;
  source_clip_artifact_ids: string[];
  accept_selected: boolean;
  reject_selected: boolean;
  revision_requested_selected: boolean;
  selected_decision: FinalDecision | null;
  reviewer: string;
  note: string;
}

function readJson<T>(relativePath: string): T | null {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function stripCode(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) return trimmed.slice(1, -1);
  return trimmed;
}

function extractCodeSpans(value: string): string[] {
  return [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

function splitMarkdownRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function selected(cell: string, keyword: FinalDecision): boolean {
  const normalized = cell.trim().toLowerCase();
  return normalized === `[${keyword}]` || normalized === `[x]` || normalized === "x" || normalized === keyword || normalized === "yes" || normalized === "true";
}

function parseDecisionTable(tableText: string): { row: FinalDecisionRow | null; blockers: string[] } {
  const blockers: string[] = [];
  const lines = tableText.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.includes("| 审查对象 |") && line.includes("| accept |") && line.includes("| revision_requested |"));
  if (headerIndex < 0) return { row: null, blockers: ["FINAL_DECISION_TABLE_HEADER_MISSING"] };

  const dataRows: string[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) break;
    if (!trimmed.includes("---")) dataRows.push(line);
  }
  if (dataRows.length !== 1) blockers.push("FINAL_DECISION_ROW_COUNT_NOT_1");

  const cells = dataRows[0] ? splitMarkdownRow(dataRows[0]) : [];
  if (cells.length < 9) blockers.push("FINAL_DECISION_ROW_MALFORMED");
  if (blockers.length > 0) return { row: null, blockers };

  const acceptSelected = selected(cells[4], "accept");
  const rejectSelected = selected(cells[5], "reject");
  const revisionSelected = selected(cells[6], "revision_requested");
  const selectedCount = [acceptSelected, rejectSelected, revisionSelected].filter(Boolean).length;
  if (selectedCount !== 1) blockers.push("FINAL_DECISION_SELECTED_COUNT_NOT_1");
  const decision: FinalDecision | null = acceptSelected ? "accept" : rejectSelected ? "reject" : revisionSelected ? "revision_requested" : null;

  return {
    row: {
      review_object: cells[0],
      final_video_path: stripCode(cells[1]),
      final_video_artifact_id: stripCode(cells[2]),
      source_clip_artifact_ids: extractCodeSpans(cells[3]),
      accept_selected: acceptSelected,
      reject_selected: rejectSelected,
      revision_requested_selected: revisionSelected,
      selected_decision: decision,
      reviewer: cells[7],
      note: cells[8]
    },
    blockers
  };
}

function summarizeSourceClips(sourceClips: SourceClip[] = []) {
  return [...sourceClips].sort((left, right) => left.order - right.order).map((clip) => ({
    order: clip.order,
    shot_id: clip.shot_id,
    source_clip_artifact_id: clip.source_clip_artifact_id,
    local_mp4_path: clip.local_mp4_path,
    ffprobe_status: clip.ffprobe_status,
    duration_seconds: clip.duration_seconds,
    source_generation_run_id: clip.source_generation_run_id,
    generation_batch_id: clip.generation_batch_id
  }));
}

ensureM0Directories();

const tableText = existsSync(resolve(paths.workspaceRoot, SOURCE_TABLE_PATH))
  ? readFileSync(resolve(paths.workspaceRoot, SOURCE_TABLE_PATH), "utf8")
  : "";
const tableParse = parseDecisionTable(tableText);
const reviewReport = readJson<R3_9PReport>(SOURCE_REPORT_PATH);
const assemblyReport = readJson<R3_9OReport>(ASSEMBLY_REPORT_PATH);
const decision = tableParse.row?.selected_decision ?? null;
const finalVideoPath = reviewReport?.final_video?.local_video_path ?? assemblyReport?.assembly_execution?.final_video_path ?? tableParse.row?.final_video_path ?? "";
const finalArtifactId = reviewReport?.final_video?.final_video_artifact_id ?? assemblyReport?.assembly_execution?.final_video_artifact_id ?? tableParse.row?.final_video_artifact_id ?? null;
const sourceClipIds = summarizeSourceClips(reviewReport?.source_clips).map((clip) => clip.source_clip_artifact_id);
const blockers = [...tableParse.blockers];

if (!tableText) blockers.push("R3_9P_FINAL_REVIEW_TABLE_MISSING");
if (!reviewReport) blockers.push("R3_9P_REVIEW_PACKAGE_REPORT_MISSING");
if (!assemblyReport) blockers.push("R3_9O_ASSEMBLY_REPORT_MISSING");
if (reviewReport?.result !== "PASS_FINAL_VIDEO_REVIEW_PACKAGE_READY") blockers.push("R3_9P_NOT_PASS");
if (assemblyReport?.result !== "PASS_LOCAL_FINAL_VIDEO_ASSEMBLED") blockers.push("R3_9O_NOT_PASS");
if (!decision) blockers.push("FINAL_DECISION_MISSING");
if (!tableParse.row?.reviewer) blockers.push("REVIEWER_MISSING");
if (finalArtifactId !== EXPECTED_FINAL_ARTIFACT_ID) blockers.push("FINAL_VIDEO_ARTIFACT_ID_MISMATCH");
if (tableParse.row?.final_video_artifact_id !== EXPECTED_FINAL_ARTIFACT_ID) blockers.push("TABLE_FINAL_ARTIFACT_ID_MISMATCH");
if (tableParse.row?.final_video_path && finalVideoPath && tableParse.row.final_video_path !== finalVideoPath) blockers.push("TABLE_FINAL_VIDEO_PATH_MISMATCH");
if (!finalVideoPath || !existsSync(finalVideoPath)) blockers.push("FINAL_VIDEO_PATH_MISSING");
if (sourceClipIds.length !== 4) blockers.push("SOURCE_CLIP_COUNT_NOT_4");
for (const expectedSourceClipId of sourceClipIds) {
  if (!tableParse.row?.source_clip_artifact_ids.includes(expectedSourceClipId)) blockers.push(`TABLE_SOURCE_CLIP_MISSING:${expectedSourceClipId}`);
}

const ffprobe = finalVideoPath && existsSync(finalVideoPath) ? validateMp4File(finalVideoPath) : null;
if (ffprobe?.status !== "PASS") blockers.push("FINAL_VIDEO_FFPROBE_NOT_PASS");

let beforeProjectStatus: ProjectStatus | null = null;
let afterProjectStatus: ProjectStatus | null = null;
let finalCreativeApprovalRecorded = false;
let nextTask = "BLOCKED";
let projectExportFinalArtifactId: string | null = null;
let finalArtifactStatus: string | null = null;

if (blockers.length === 0) {
  const db = openM0Database();
  try {
    const projectId = reviewReport?.project?.project_id ?? "";
    const project = getProject(db, projectId);
    if (!project) {
      blockers.push("PROJECT_NOT_FOUND");
    } else {
      beforeProjectStatus = project.status;
      projectExportFinalArtifactId = project.exports.final_video_artifact_id || null;
      if (project.exports.final_video_artifact_id !== EXPECTED_FINAL_ARTIFACT_ID) blockers.push("PROJECT_FINAL_VIDEO_ARTIFACT_MISMATCH");
      const finalArtifact = getMediaArtifact(db, EXPECTED_FINAL_ARTIFACT_ID);
      finalArtifactStatus = finalArtifact?.status ?? null;
      if (!finalArtifact || finalArtifact.role !== "final_video" || finalArtifact.artifact_type !== "video" || finalArtifact.status !== "active") {
        blockers.push("FINAL_VIDEO_ARTIFACT_NOT_ACTIVE_FINAL_VIDEO");
      }

      if (blockers.length === 0) {
        if (decision === "accept") {
          project.status = "final_approved";
          saveProject(db, project);
          finalCreativeApprovalRecorded = true;
          nextTask = "R3-9R_FINAL_DELIVERY_CLOSEOUT";
        } else {
          project.status = "video_review";
          saveProject(db, project);
          finalCreativeApprovalRecorded = false;
          nextTask = "FINAL_VIDEO_REVISION_STRATEGY";
        }
        afterProjectStatus = project.status;
      }
    }
  } finally {
    db.close();
  }
}

const result = blockers.length === 0
  ? decision === "accept"
    ? "PASS_FINAL_CREATIVE_APPROVAL_RECORDED"
    : "PASS_FINAL_REVIEW_DECISION_RECORDED_REVISION_REQUIRED"
  : "BLOCK_FINAL_REVIEW_DECISION_APPLY_WITH_REASON";

const payload = {
  task: TASK,
  result,
  mode: "local_final_video_review_decision_apply_only",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    r3_9p_review_table: SOURCE_TABLE_PATH,
    r3_9p_review_package_report: SOURCE_REPORT_PATH,
    r3_9p_commit: reviewReport?.git_receipt?.commit ?? null,
    r3_9o_assembly_report: ASSEMBLY_REPORT_PATH,
    r3_9o_commit: assemblyReport?.git_receipt?.commit ?? null
  },
  project: {
    project_id: reviewReport?.project?.project_id ?? null,
    project_title: reviewReport?.project?.project_title ?? null,
    storyboard_package_id: reviewReport?.project?.storyboard_package_id ?? null,
    project_status_before: beforeProjectStatus,
    project_status_after: afterProjectStatus,
    project_export_final_video_artifact_id: projectExportFinalArtifactId
  },
  decision_apply: {
    status: result.startsWith("PASS") ? "APPLIED" : "BLOCKED",
    decision,
    reviewer: tableParse.row?.reviewer ?? "",
    note: tableParse.row?.note ?? "",
    parsed_decision_row_count: tableParse.row ? 1 : 0,
    selected_decision_count: tableParse.row
      ? [tableParse.row.accept_selected, tableParse.row.reject_selected, tableParse.row.revision_requested_selected].filter(Boolean).length
      : 0,
    accept_selected: tableParse.row?.accept_selected ?? false,
    reject_selected: tableParse.row?.reject_selected ?? false,
    revision_requested_selected: tableParse.row?.revision_requested_selected ?? false,
    final_creative_approval_recorded: finalCreativeApprovalRecorded,
    next_task: nextTask,
    local_blocker_count: blockers.length,
    local_blockers: blockers
  },
  final_video: {
    local_video_path: finalVideoPath,
    local_video_exists: Boolean(finalVideoPath && existsSync(finalVideoPath)),
    final_video_artifact_id: finalArtifactId,
    expected_final_video_artifact_id: EXPECTED_FINAL_ARTIFACT_ID,
    final_video_artifact_status: finalArtifactStatus,
    ffprobe_status: ffprobe?.status ?? null,
    duration_seconds: ffprobe?.duration_seconds ?? null,
    has_video_stream: ffprobe?.has_video_stream ?? null,
    stream_count: ffprobe?.stream_count ?? null
  },
  source_clip_artifacts: sourceClipIds,
  source_clips: summarizeSourceClips(reviewReport?.source_clips),
  provider_boundary: {
    publish_performed: false,
    release_or_deploy_performed: false,
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
    final_video_reassembled: false,
    env_files_read: false,
    credentials_read: false,
    source_assets_overwritten: false,
    secret_values_exposed: false,
    raw_provider_payload_recorded: false,
    signed_url_recorded: false,
    push_performed: false,
    tag_created: false
  },
  validation: {
    "npm run r3:9q:apply-final-review": result.startsWith("PASS") ? "PASS" : "FAIL",
    "R3-9P final video review table parse / required decision check": blockers.length === 0 ? "PASS" : "FAIL",
    "JSON parse for generated R3-9Q decision apply report": "PENDING",
    "final video path existence check": finalVideoPath && existsSync(finalVideoPath) ? "PASS" : "FAIL",
    "npm run typecheck": "PENDING",
    "npm run test:m1": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "package.json",
    "scripts/r3-9q-human-final-video-review-decision-apply.ts",
    OUTPUT_REPORT_PATH,
    SOURCE_TABLE_PATH,
    ".agent_board/*"
  ],
  blocked_reason: result.startsWith("PASS") ? null : "R3-9Q decision apply blocked; inspect decision_apply.local_blockers.",
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
  decision,
  reviewer: tableParse.row?.reviewer ?? "",
  final_creative_approval_recorded: finalCreativeApprovalRecorded,
  project_status_before: beforeProjectStatus,
  project_status_after: afterProjectStatus,
  next_task: nextTask,
  local_blocker_count: blockers.length,
  network_call_attempted: false,
  runninghub_called: false,
  runway_called: false,
  publish_performed: false,
  release_or_deploy_performed: false
}, null, 2));
if (!result.startsWith("PASS")) process.exitCode = 1;
