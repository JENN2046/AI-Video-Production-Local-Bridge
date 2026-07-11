import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureM0Directories,
  getMediaArtifact,
  getProject,
  openM0Database,
  paths,
  validateMp4File
} from "../src/index.js";

const TASK = "R3-9R_FINAL_DELIVERY_CLOSEOUT";
const SOURCE_Q_REPORT_PATH = "data/reports/r3_9q_human_final_video_review_decision_apply_result.json";
const SOURCE_P_REPORT_PATH = "data/reports/r3_9p_final_video_review_package_result.json";
const SOURCE_O_REPORT_PATH = "data/reports/r3_9o_final_video_assembly_execution_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_9r_final_delivery_closeout_result.json";
const EVIDENCE_MANIFEST_PATH = "data/reports/r3_9r_final_delivery_evidence_manifest.json";
const LOCAL_SUMMARY_PATH = "data/reports/r3_9r_local_video_delivery_summary.md";
const EXPECTED_PROJECT_ID = "project_b742cb15-e44e-41b2-8d2d-4b90a30720df";
const EXPECTED_PACKAGE_ID = "storyboard_package_1e5c1eca-624e-4687-9775-31e4b59f428a";
const EXPECTED_FINAL_ARTIFACT_ID = "artifact_2fa09a9e-3408-49f8-96f9-42c87cfbbfbe";
const EXPECTED_FINAL_VIDEO_PATH = resolve(
  paths.workspaceRoot,
  "data/media/artifacts/final/r3-9o-final-video/ryan_lunch_break_skullcap_final_r3_9o.mp4"
);
const EXPECTED_SOURCE_CLIP_IDS = [
  "artifact_37d18f76-ec61-4b5d-8f5c-acca2b4ba203",
  "artifact_eeef12a7-9533-4172-beaa-6c25b91415f7",
  "artifact_20b1ee68-0b75-4fc1-96a8-93f36de31d5a",
  "artifact_263a2344-5154-4981-bfe4-120571effb3e"
];

interface R3_9QReport {
  result?: string;
  source_of_truth?: {
    r3_9p_review_package_report?: string;
    r3_9p_commit?: string | null;
    r3_9o_assembly_report?: string;
    r3_9o_commit?: string | null;
  };
  project?: {
    project_id?: string | null;
    project_title?: string | null;
    storyboard_package_id?: string | null;
    project_status_after?: string | null;
    project_export_final_video_artifact_id?: string | null;
  };
  decision_apply?: {
    status?: string;
    decision?: string | null;
    reviewer?: string;
    final_creative_approval_recorded?: boolean;
    local_blocker_count?: number;
  };
  final_video?: {
    local_video_path?: string;
    local_video_exists?: boolean;
    final_video_artifact_id?: string | null;
    final_video_artifact_status?: string | null;
    ffprobe_status?: string | null;
    duration_seconds?: number | null;
    has_video_stream?: boolean | null;
    stream_count?: number | null;
  };
  source_clip_artifacts?: string[];
  source_clips?: SourceClip[];
  git_receipt?: {
    commit?: string;
  };
}

interface R3_9PReport {
  result?: string;
  final_video?: {
    local_video_path?: string;
    final_video_artifact_id?: string | null;
    final_video_artifact_path?: string | null;
  };
  review_package?: {
    status?: string;
    review_table_path?: string;
  };
  git_receipt?: {
    commit?: string;
  };
}

interface R3_9OReport {
  result?: string;
  project?: {
    project_id?: string | null;
    project_title?: string | null;
    storyboard_package_id?: string | null;
  };
  assembly_execution?: {
    status?: string;
    final_video_path?: string;
    final_video_artifact_id?: string | null;
    final_video_artifact_path?: string | null;
    final_video_byte_size?: number;
    final_video_written?: boolean;
    source_clip_artifact_ids?: string[];
    assembly_run_id?: string | null;
    output_duration_seconds?: number | null;
  };
  ordered_input_clips?: Array<{
    order: number;
    shot_id: string;
    accepted_clip_artifact_id: string;
    local_mp4_path: string;
    input_exists: boolean;
    byte_size: number;
    duration_seconds: number;
    ffprobe_status: string;
    source_generation_run_id: string;
    generation_batch_id: string;
  }>;
  ffprobe_result?: {
    status?: string;
    path?: string;
    duration_seconds?: number | null;
    has_video_stream?: boolean;
    stream_count?: number;
    ffprobe_exit_code?: number | null;
  };
  git_receipt?: {
    commit?: string;
  };
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

function readJson<T>(relativePath: string): T | null {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function fileSize(filePath: string): number {
  return existsSync(filePath) ? statSync(filePath).size : 0;
}

function stableUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizePath(filePath: string): string {
  return resolve(filePath);
}

function markdownCode(value: unknown): string {
  return `\`${String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>")}\``;
}

function sourceClipsFromReports(qReport: R3_9QReport | null, oReport: R3_9OReport | null): SourceClip[] {
  const qClips = qReport?.source_clips ?? [];
  if (qClips.length > 0) {
    return [...qClips].sort((left, right) => left.order - right.order);
  }

  return [...(oReport?.ordered_input_clips ?? [])]
    .sort((left, right) => left.order - right.order)
    .map((clip) => ({
      order: clip.order,
      shot_id: clip.shot_id,
      source_clip_artifact_id: clip.accepted_clip_artifact_id,
      local_mp4_path: clip.local_mp4_path,
      ffprobe_status: clip.ffprobe_status,
      duration_seconds: clip.duration_seconds,
      source_generation_run_id: clip.source_generation_run_id,
      generation_batch_id: clip.generation_batch_id
    }));
}

function allFalseBoundary() {
  return {
    publish_performed: false,
    release_or_deploy_performed: false,
    push_performed: false,
    tag_created: false,
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
    upload_performed: false,
    production_configuration_changed: false
  };
}

ensureM0Directories();

const qReport = readJson<R3_9QReport>(SOURCE_Q_REPORT_PATH);
const pReport = readJson<R3_9PReport>(SOURCE_P_REPORT_PATH);
const oReport = readJson<R3_9OReport>(SOURCE_O_REPORT_PATH);
const sourceClips = sourceClipsFromReports(qReport, oReport);
const finalVideoPath = qReport?.final_video?.local_video_path ?? oReport?.assembly_execution?.final_video_path ?? "";
const normalizedFinalVideoPath = finalVideoPath ? normalizePath(finalVideoPath) : "";
const finalVideoArtifactId = qReport?.final_video?.final_video_artifact_id ?? oReport?.assembly_execution?.final_video_artifact_id ?? null;
const finalFfprobe = normalizedFinalVideoPath && existsSync(normalizedFinalVideoPath)
  ? validateMp4File(normalizedFinalVideoPath)
  : null;
const blockers: string[] = [];

if (!qReport) blockers.push("R3_9Q_REPORT_MISSING");
if (!pReport) blockers.push("R3_9P_REPORT_MISSING");
if (!oReport) blockers.push("R3_9O_REPORT_MISSING");
if (qReport?.result !== "PASS_FINAL_CREATIVE_APPROVAL_RECORDED") blockers.push("R3_9Q_NOT_FINAL_APPROVED");
if (qReport?.decision_apply?.decision !== "accept") blockers.push("FINAL_DECISION_NOT_ACCEPT");
if (qReport?.decision_apply?.reviewer !== "Jenn") blockers.push("FINAL_REVIEWER_NOT_JENN");
if (qReport?.decision_apply?.final_creative_approval_recorded !== true) blockers.push("FINAL_CREATIVE_APPROVAL_NOT_RECORDED");
if ((qReport?.decision_apply?.local_blocker_count ?? 0) !== 0) blockers.push("R3_9Q_HAS_LOCAL_BLOCKERS");
if (pReport?.result !== "PASS_FINAL_VIDEO_REVIEW_PACKAGE_READY") blockers.push("R3_9P_NOT_PASS");
if (oReport?.result !== "PASS_LOCAL_FINAL_VIDEO_ASSEMBLED") blockers.push("R3_9O_NOT_PASS");
if (oReport?.assembly_execution?.status !== "ASSEMBLED") blockers.push("R3_9O_NOT_ASSEMBLED");
if (oReport?.assembly_execution?.final_video_written !== true) blockers.push("R3_9O_FINAL_VIDEO_NOT_WRITTEN");
if (qReport?.project?.project_id !== EXPECTED_PROJECT_ID) blockers.push("PROJECT_ID_MISMATCH");
if (qReport?.project?.storyboard_package_id !== EXPECTED_PACKAGE_ID) blockers.push("STORYBOARD_PACKAGE_ID_MISMATCH");
if (qReport?.project?.project_status_after !== "final_approved") blockers.push("Q_PROJECT_STATUS_NOT_FINAL_APPROVED");
if (qReport?.project?.project_export_final_video_artifact_id !== EXPECTED_FINAL_ARTIFACT_ID) blockers.push("Q_PROJECT_FINAL_ARTIFACT_MISMATCH");
if (finalVideoArtifactId !== EXPECTED_FINAL_ARTIFACT_ID) blockers.push("FINAL_VIDEO_ARTIFACT_ID_MISMATCH");
if (!normalizedFinalVideoPath) blockers.push("FINAL_VIDEO_PATH_MISSING");
if (normalizedFinalVideoPath && normalizedFinalVideoPath !== EXPECTED_FINAL_VIDEO_PATH) blockers.push("FINAL_VIDEO_PATH_MISMATCH");
if (!normalizedFinalVideoPath || !existsSync(normalizedFinalVideoPath)) blockers.push("FINAL_VIDEO_FILE_MISSING");
if (finalFfprobe?.status !== "PASS") blockers.push("FINAL_VIDEO_FFPROBE_NOT_PASS");
if (sourceClips.length !== 4) blockers.push("SOURCE_CLIP_COUNT_NOT_4");

const seenSourceIds = sourceClips.map((clip) => clip.source_clip_artifact_id);
for (const expectedSourceClipId of EXPECTED_SOURCE_CLIP_IDS) {
  if (!seenSourceIds.includes(expectedSourceClipId)) blockers.push(`SOURCE_CLIP_ID_MISSING:${expectedSourceClipId}`);
}

const db = openM0Database();
let projectStatus: string | null = null;
let projectExportFinalArtifactId: string | null = null;
let finalArtifactStatus: string | null = null;
let finalArtifactStorageUri: string | null = null;
let finalArtifactRole: string | null = null;
let finalArtifactType: string | null = null;
const sourceClipEvidence = sourceClips.map((clip) => {
  const artifact = getMediaArtifact(db, clip.source_clip_artifact_id);
  const ffprobe = clip.local_mp4_path && existsSync(clip.local_mp4_path) ? validateMp4File(clip.local_mp4_path) : null;
  if (!artifact) blockers.push(`${clip.shot_id}:SOURCE_CLIP_ARTIFACT_MISSING`);
  if (artifact && (artifact.role !== "generated_clip" || artifact.artifact_type !== "video" || artifact.status !== "active")) {
    blockers.push(`${clip.shot_id}:SOURCE_CLIP_ARTIFACT_NOT_ACTIVE_GENERATED_CLIP`);
  }
  if (!clip.local_mp4_path || !existsSync(clip.local_mp4_path)) blockers.push(`${clip.shot_id}:SOURCE_CLIP_FILE_MISSING`);
  if (ffprobe?.status !== "PASS") blockers.push(`${clip.shot_id}:SOURCE_CLIP_FFPROBE_NOT_PASS`);
  return {
    order: clip.order,
    shot_id: clip.shot_id,
    source_clip_artifact_id: clip.source_clip_artifact_id,
    artifact_status: artifact?.status ?? null,
    local_mp4_path: clip.local_mp4_path,
    local_mp4_exists: Boolean(clip.local_mp4_path && existsSync(clip.local_mp4_path)),
    byte_size: fileSize(clip.local_mp4_path),
    ffprobe_status: ffprobe?.status ?? null,
    duration_seconds: ffprobe?.duration_seconds ?? clip.duration_seconds,
    source_generation_run_id: clip.source_generation_run_id,
    generation_batch_id: clip.generation_batch_id
  };
});

try {
  const project = getProject(db, EXPECTED_PROJECT_ID);
  if (!project) {
    blockers.push("PROJECT_NOT_FOUND");
  } else {
    projectStatus = project.status;
    projectExportFinalArtifactId = project.exports.final_video_artifact_id || null;
    if (project.status !== "final_approved") blockers.push("PROJECT_STATUS_NOT_FINAL_APPROVED");
    if (project.exports.final_video_artifact_id !== EXPECTED_FINAL_ARTIFACT_ID) blockers.push("PROJECT_FINAL_VIDEO_ARTIFACT_MISMATCH");
  }

  const finalArtifact = getMediaArtifact(db, EXPECTED_FINAL_ARTIFACT_ID);
  finalArtifactStatus = finalArtifact?.status ?? null;
  finalArtifactStorageUri = finalArtifact?.storage.uri ?? null;
  finalArtifactRole = finalArtifact?.role ?? null;
  finalArtifactType = finalArtifact?.artifact_type ?? null;
  if (!finalArtifact) {
    blockers.push("FINAL_VIDEO_ARTIFACT_MISSING");
  } else {
    if (finalArtifact.role !== "final_video" || finalArtifact.artifact_type !== "video" || finalArtifact.status !== "active") {
      blockers.push("FINAL_VIDEO_ARTIFACT_NOT_ACTIVE_FINAL_VIDEO");
    }
    if (!existsSync(finalArtifact.storage.uri)) blockers.push("FINAL_VIDEO_ARTIFACT_STORAGE_MISSING");
  }
} finally {
  db.close();
}

const generationBatchIds = stableUnique(sourceClipEvidence.map((clip) => clip.generation_batch_id));
const generationRunIds = stableUnique(sourceClipEvidence.map((clip) => clip.source_generation_run_id));
const result = blockers.length === 0 ? "PASS_FINAL_DELIVERY_CLOSEOUT_READY" : "BLOCK_FINAL_DELIVERY_CLOSEOUT_WITH_REASON";
const providerBoundary = allFalseBoundary();
const validation = {
  "npm run r3:9r:closeout": result === "PASS_FINAL_DELIVERY_CLOSEOUT_READY" ? "PASS" : "FAIL",
  "JSON parse for generated final delivery closeout report": "PENDING",
  "final video path existence check": normalizedFinalVideoPath && existsSync(normalizedFinalVideoPath) ? "PASS" : "FAIL",
  "final video ffprobe evidence check": finalFfprobe?.status ?? "FAIL",
  "source clip artifact lineage check": blockers.some((blocker) => blocker.startsWith("SOURCE_CLIP") || blocker.includes(":SOURCE_CLIP")) ? "FAIL" : "PASS",
  "npm run typecheck": "PENDING",
  "npm run test:m1": "PENDING",
  "npm run secret:scan": "PENDING",
  "git diff --check": "PENDING"
};

const evidenceManifest = {
  task: TASK,
  result,
  generated_at: new Date().toISOString(),
  project_id: qReport?.project?.project_id ?? oReport?.project?.project_id ?? EXPECTED_PROJECT_ID,
  storyboard_package_id: qReport?.project?.storyboard_package_id ?? oReport?.project?.storyboard_package_id ?? EXPECTED_PACKAGE_ID,
  final_human_decision: {
    decision: qReport?.decision_apply?.decision ?? null,
    reviewer: qReport?.decision_apply?.reviewer ?? null,
    final_creative_approval_recorded: qReport?.decision_apply?.final_creative_approval_recorded ?? false,
    source_report: SOURCE_Q_REPORT_PATH
  },
  final_video: {
    local_video_path: normalizedFinalVideoPath,
    local_video_exists: Boolean(normalizedFinalVideoPath && existsSync(normalizedFinalVideoPath)),
    final_video_artifact_id: finalVideoArtifactId,
    final_video_artifact_status: finalArtifactStatus,
    final_video_artifact_role: finalArtifactRole,
    final_video_artifact_type: finalArtifactType,
    final_video_artifact_storage_uri: finalArtifactStorageUri,
    final_video_artifact_storage_exists: Boolean(finalArtifactStorageUri && existsSync(finalArtifactStorageUri)),
    byte_size: fileSize(normalizedFinalVideoPath),
    ffprobe: finalFfprobe
  },
  source_clips: sourceClipEvidence,
  source_reports: [
    {
      task: "R3-9O_FINAL_VIDEO_ASSEMBLY_EXECUTION",
      path: SOURCE_O_REPORT_PATH,
      commit: oReport?.git_receipt?.commit ?? qReport?.source_of_truth?.r3_9o_commit ?? null,
      result: oReport?.result ?? null
    },
    {
      task: "R3-9P_FINAL_VIDEO_REVIEW_PACKAGE",
      path: SOURCE_P_REPORT_PATH,
      commit: pReport?.git_receipt?.commit ?? qReport?.source_of_truth?.r3_9p_commit ?? null,
      result: pReport?.result ?? null
    },
    {
      task: "R3-9Q_HUMAN_FINAL_VIDEO_REVIEW_DECISION_APPLY",
      path: SOURCE_Q_REPORT_PATH,
      commit: qReport?.git_receipt?.commit ?? null,
      result: qReport?.result ?? null
    }
  ],
  provider_lane_summary: {
    primary_provider_lane: "runninghub",
    accepted_clip_generation_source: "R3-9J_RUNNINGHUB_REGENERATION_SINGLE_PASS_LIVE_EXECUTION",
    generation_batch_ids: generationBatchIds,
    generation_run_ids: generationRunIds,
    provider_raw_payload_recorded: false,
    signed_url_recorded: false,
    secret_values_exposed: false
  },
  provider_boundary: providerBoundary,
  blockers
};

const localSummary = [
  "# R3-9R 本地最终交付收口摘要",
  "",
  `结论：${result}`,
  "",
  "## 最终成片",
  "",
  `- 项目：${qReport?.project?.project_title ?? oReport?.project?.project_title ?? ""}`,
  `- project_id：${markdownCode(qReport?.project?.project_id ?? oReport?.project?.project_id ?? EXPECTED_PROJECT_ID)}`,
  `- storyboard_package_id：${markdownCode(qReport?.project?.storyboard_package_id ?? oReport?.project?.storyboard_package_id ?? EXPECTED_PACKAGE_ID)}`,
  `- 最终视频路径：${markdownCode(normalizedFinalVideoPath)}`,
  `- final_video_artifact_id：${markdownCode(finalVideoArtifactId ?? "")}`,
  `- ffprobe：${markdownCode(finalFfprobe?.status ?? "")}，时长 ${markdownCode(finalFfprobe?.duration_seconds ?? "")} 秒，stream_count ${markdownCode(finalFfprobe?.stream_count ?? "")}`,
  "",
  "## 人工最终决策",
  "",
  `- decision：${markdownCode(qReport?.decision_apply?.decision ?? "")}`,
  `- reviewer：${markdownCode(qReport?.decision_apply?.reviewer ?? "")}`,
  `- final_creative_approval_recorded：${markdownCode(qReport?.decision_apply?.final_creative_approval_recorded ?? false)}`,
  `- project_status：${markdownCode(projectStatus ?? "")}`,
  "",
  "## 来源片段",
  "",
  "| 顺序 | shot_id | 来源 Clip Artifact | 本地 MP4 | ffprobe | 时长秒 | 生成 run |",
  "|---:|---|---|---|---|---:|---|",
  ...sourceClipEvidence.map((clip) => `| ${clip.order} | ${clip.shot_id} | ${markdownCode(clip.source_clip_artifact_id)} | ${markdownCode(clip.local_mp4_path)} | ${clip.ffprobe_status ?? ""} | ${clip.duration_seconds ?? ""} | ${markdownCode(clip.source_generation_run_id)} |`),
  "",
  "## 本阶段边界",
  "",
  "- R3-9R 仅生成本地 closeout 证据包，没有发布、部署、上传、push、tag 或 release。",
  "- R3-9R 没有调用 RunningHub 或 Runway，没有读取 `.env` 或 credentials，没有记录 raw provider payload 或 signed URL。",
  "- R3-9R 没有重新装配视频、没有 regeneration、没有 batch expansion、没有覆盖源资产。",
  "",
  "## 证据文件",
  "",
  `- closeout report：${markdownCode(OUTPUT_REPORT_PATH)}`,
  `- evidence manifest：${markdownCode(EVIDENCE_MANIFEST_PATH)}`,
  `- local summary：${markdownCode(LOCAL_SUMMARY_PATH)}`
].join("\n");

const payload = {
  task: TASK,
  result,
  mode: "local_final_delivery_closeout_only",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    r3_9q_final_review_decision_report: SOURCE_Q_REPORT_PATH,
    r3_9q_result: qReport?.result ?? null,
    r3_9q_commit: qReport?.git_receipt?.commit ?? null,
    r3_9p_final_review_package_report: SOURCE_P_REPORT_PATH,
    r3_9p_result: pReport?.result ?? null,
    r3_9p_commit: pReport?.git_receipt?.commit ?? qReport?.source_of_truth?.r3_9p_commit ?? null,
    r3_9o_final_video_assembly_report: SOURCE_O_REPORT_PATH,
    r3_9o_result: oReport?.result ?? null,
    r3_9o_commit: oReport?.git_receipt?.commit ?? qReport?.source_of_truth?.r3_9o_commit ?? null
  },
  project: {
    project_id: qReport?.project?.project_id ?? oReport?.project?.project_id ?? EXPECTED_PROJECT_ID,
    project_title: qReport?.project?.project_title ?? oReport?.project?.project_title ?? null,
    storyboard_package_id: qReport?.project?.storyboard_package_id ?? oReport?.project?.storyboard_package_id ?? EXPECTED_PACKAGE_ID,
    project_status: projectStatus,
    project_export_final_video_artifact_id: projectExportFinalArtifactId,
    final_creative_approval_state: qReport?.project?.project_status_after ?? null
  },
  final_approval: {
    decision: qReport?.decision_apply?.decision ?? null,
    reviewer: qReport?.decision_apply?.reviewer ?? null,
    final_creative_approval_recorded: qReport?.decision_apply?.final_creative_approval_recorded ?? false,
    local_blocker_count: qReport?.decision_apply?.local_blocker_count ?? null
  },
  final_video: {
    local_video_path: normalizedFinalVideoPath,
    expected_local_video_path: EXPECTED_FINAL_VIDEO_PATH,
    local_video_exists: Boolean(normalizedFinalVideoPath && existsSync(normalizedFinalVideoPath)),
    byte_size: fileSize(normalizedFinalVideoPath),
    final_video_artifact_id: finalVideoArtifactId,
    expected_final_video_artifact_id: EXPECTED_FINAL_ARTIFACT_ID,
    final_video_artifact_status: finalArtifactStatus,
    final_video_artifact_role: finalArtifactRole,
    final_video_artifact_type: finalArtifactType,
    final_video_artifact_storage_uri: finalArtifactStorageUri,
    final_video_artifact_storage_exists: Boolean(finalArtifactStorageUri && existsSync(finalArtifactStorageUri)),
    ffprobe_status: finalFfprobe?.status ?? null,
    ffprobe_duration_seconds: finalFfprobe?.duration_seconds ?? null,
    ffprobe_has_video_stream: finalFfprobe?.has_video_stream ?? null,
    ffprobe_stream_count: finalFfprobe?.stream_count ?? null,
    assembly_run_id: oReport?.assembly_execution?.assembly_run_id ?? null
  },
  source_clip_artifacts: seenSourceIds,
  source_clips: sourceClipEvidence,
  provider_lane_summary: evidenceManifest.provider_lane_summary,
  closeout_delivery: {
    status: result === "PASS_FINAL_DELIVERY_CLOSEOUT_READY" ? "LOCAL_CLOSEOUT_READY" : "BLOCKED",
    evidence_manifest_path: EVIDENCE_MANIFEST_PATH,
    local_summary_path: LOCAL_SUMMARY_PATH,
    final_delivery_published: false,
    external_delivery_performed: false,
    production_configuration_changed: false,
    local_blocker_count: blockers.length,
    local_blockers: blockers
  },
  provider_boundary: providerBoundary,
  validation,
  changed_files: [
    "package.json",
    "scripts/r3-9r-final-delivery-closeout.ts",
    OUTPUT_REPORT_PATH,
    EVIDENCE_MANIFEST_PATH,
    LOCAL_SUMMARY_PATH,
    ".agent_board/*"
  ],
  blocked_reason: result === "PASS_FINAL_DELIVERY_CLOSEOUT_READY" ? null : "R3-9R final delivery closeout blocked; inspect closeout_delivery.local_blockers.",
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

writeFileSync(resolve(paths.workspaceRoot, EVIDENCE_MANIFEST_PATH), `${JSON.stringify(evidenceManifest, null, 2)}\n`, "utf8");
writeFileSync(resolve(paths.workspaceRoot, LOCAL_SUMMARY_PATH), `${localSummary}\n`, "utf8");
writeFileSync(resolve(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  result,
  report_path: OUTPUT_REPORT_PATH,
  evidence_manifest_path: EVIDENCE_MANIFEST_PATH,
  local_summary_path: LOCAL_SUMMARY_PATH,
  final_video_path: normalizedFinalVideoPath,
  final_video_artifact_id: finalVideoArtifactId,
  final_decision: qReport?.decision_apply?.decision ?? null,
  reviewer: qReport?.decision_apply?.reviewer ?? null,
  ffprobe_status: finalFfprobe?.status ?? null,
  source_clip_count: sourceClipEvidence.length,
  local_blocker_count: blockers.length,
  network_call_attempted: false,
  runninghub_called: false,
  runway_called: false,
  env_files_read: false,
  credentials_read: false,
  publish_performed: false,
  release_or_deploy_performed: false,
  push_performed: false,
  tag_created: false
}, null, 2));
if (result !== "PASS_FINAL_DELIVERY_CLOSEOUT_READY") process.exitCode = 1;
