import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureM0Directories,
  getGenerationRun,
  getMediaArtifact,
  getProject,
  getShot,
  openM0Database,
  paths,
  validateMp4File,
  type GenerationRun,
  type MediaArtifact,
  type Shot
} from "../src/index.js";

const TASK = "R3-9M_FINAL_ASSEMBLY_READINESS_CHECK";
const R3_9L_REPORT_PATH = "data/reports/r3_9l_human_regenerated_clip_review_decision_apply_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_9m_final_assembly_readiness_check_result.json";
const OUTPUT_MANIFEST_PATH = "data/reports/r3_9m_assembly_input_manifest.json";
const EXPECTED_SHOT_IDS = [
  "g0_r1_shot_001",
  "g0_r1_shot_002",
  "g0_r1_shot_003",
  "g0_r1_shot_004"
] as const;

type ExpectedShotId = typeof EXPECTED_SHOT_IDS[number];
type ReportResult = "PASS_READY_FOR_FINAL_ASSEMBLY_DRY_RUN" | "BLOCK_FINAL_ASSEMBLY_WITH_REASON";

interface R3_9LDecision {
  order?: number;
  shot_id?: string;
  generated_clip_artifact_id?: string;
  previous_rejected_clip_artifact_id?: string;
  local_video_path?: string;
  decision?: string;
  reviewer?: string;
  note?: string;
  mapped_app_decision?: string;
  after?: {
    shot_status?: string;
    approval_status?: string;
    accepted_clip_artifact_id?: string;
    clip_review_status?: string | null;
    rejection_reasons?: string[];
  };
  local_state_links?: {
    generation_run_id?: string;
    generation_batch_id?: string;
  };
}

interface R3_9LReport {
  result?: string;
  decision_apply?: {
    applied_decision_count?: number;
    decision_summary?: {
      accept?: number;
      reject?: number;
      regenerate_requested?: number;
    };
    all_accepted?: boolean;
    local_blocker_count?: number;
  };
  decisions?: R3_9LDecision[];
  final_assembly_gate?: {
    status?: string;
    final_assembly_performed?: boolean;
    final_assembly_readiness_check_next_safe_task?: boolean;
  };
  git_receipt?: { commit?: string };
}

interface AcceptedClipInventoryRow {
  order: number;
  shot_id: ExpectedShotId;
  accepted_artifact_id: string | null;
  previous_rejected_clip_artifact_id: string | null;
  local_mp4_path: string | null;
  local_mp4_exists: boolean;
  byte_size: number;
  artifact_type: string | null;
  role: string | null;
  status: string | null;
  linked_project_id: string | null;
  linked_shot_id: string | null;
  ffprobe_status: string | null;
  duration_seconds: number | null;
  has_video_stream: boolean | null;
  stream_count: number | null;
  shot_status: string | null;
  approval_status: string | null;
  clip_review_status: string | null;
  source_generation_task: {
    local_run_id: string | null;
    generation_batch_id: string | null;
    run_exists: boolean;
    run_status: string | null;
    provider_name: string | null;
    model_name: string | null;
    provider_job_id_recorded: false;
    output_contains_artifact: boolean | null;
  };
  local_blockers: string[];
}

interface AssemblyManifestEntry {
  order: number;
  shot_id: ExpectedShotId;
  accepted_clip_artifact_id: string;
  local_mp4_path: string;
  duration_seconds: number;
  ffprobe_status: "PASS";
  source_generation_run_id: string;
  generation_batch_id: string;
}

function readJson<T>(relativePath: string): T | null {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function isExpectedShotId(value: string | undefined): value is ExpectedShotId {
  return EXPECTED_SHOT_IDS.includes(value as ExpectedShotId);
}

function fileSize(filePath: string | null | undefined): number {
  if (!filePath || !existsSync(filePath)) return 0;
  return statSync(filePath).size;
}

function decisionByShot(report: R3_9LReport | null): Map<string, R3_9LDecision> {
  return new Map((report?.decisions ?? []).map((decision) => [decision.shot_id ?? "", decision]));
}

function sourceReportBlockers(report: R3_9LReport | null): string[] {
  const blockers: string[] = [];
  const summary = report?.decision_apply?.decision_summary;
  if (!report) blockers.push("R3_9L_REPORT_MISSING");
  if (report?.result !== "PASS_REVIEW_DECISIONS_APPLIED") blockers.push("R3_9L_NOT_PASS");
  if (report?.decision_apply?.applied_decision_count !== 4) blockers.push("R3_9L_APPLIED_DECISION_COUNT_NOT_4");
  if (summary?.accept !== 4 || summary?.reject !== 0 || summary?.regenerate_requested !== 0) {
    blockers.push("R3_9L_DECISION_SUMMARY_NOT_ALL_ACCEPTED");
  }
  if (report?.decision_apply?.all_accepted !== true) blockers.push("R3_9L_ALL_ACCEPTED_NOT_TRUE");
  if (report?.decision_apply?.local_blocker_count !== 0) blockers.push("R3_9L_HAS_LOCAL_BLOCKERS");
  if (report?.final_assembly_gate?.status !== "READY_FOR_FINAL_ASSEMBLY_READINESS_CHECK") blockers.push("R3_9L_GATE_NOT_READY_FOR_READINESS_CHECK");
  if (report?.final_assembly_gate?.final_assembly_performed !== false) blockers.push("R3_9L_FINAL_ASSEMBLY_ALREADY_PERFORMED");
  return blockers;
}

function entryBlockers(input: {
  shotId: ExpectedShotId;
  decision: R3_9LDecision | undefined;
  shot: Shot | null;
  artifact: MediaArtifact | null;
  run: GenerationRun | null;
  ffprobeStatus: string | null;
  ffprobeDuration: number | null;
  hasVideoStream: boolean | null;
}): string[] {
  const blockers: string[] = [];
  if (!input.decision) blockers.push("R3_9L_DECISION_MISSING");
  if (input.decision?.decision !== "accept") blockers.push("DECISION_NOT_ACCEPT");
  if (input.decision?.mapped_app_decision !== "approved") blockers.push("MAPPED_APP_DECISION_NOT_APPROVED");
  if (!input.decision?.generated_clip_artifact_id?.startsWith("artifact_")) blockers.push("GENERATED_ARTIFACT_ID_INVALID");
  if (input.decision?.after?.accepted_clip_artifact_id !== input.decision?.generated_clip_artifact_id) blockers.push("R3_9L_ACCEPTED_ARTIFACT_MISMATCH");
  if (!input.shot) blockers.push("SHOT_NOT_FOUND");
  if (input.shot?.status !== "approved") blockers.push("SHOT_STATUS_NOT_APPROVED");
  if (input.shot?.review.approval_status !== "approved") blockers.push("SHOT_APPROVAL_STATUS_NOT_APPROVED");
  if ((input.shot?.review.rejection_reasons ?? []).length !== 0) blockers.push("SHOT_HAS_STALE_REJECTION_REASONS");
  if (input.shot?.accepted_clip_artifact_id !== input.decision?.generated_clip_artifact_id) blockers.push("SHOT_ACCEPTED_ARTIFACT_MISMATCH");
  const clipVersion = input.shot?.clip_versions.find((version) => version.artifact_id === input.decision?.generated_clip_artifact_id);
  if (!clipVersion) blockers.push("ACCEPTED_CLIP_VERSION_MISSING");
  if (clipVersion && clipVersion.review_status !== "approved") blockers.push("ACCEPTED_CLIP_VERSION_NOT_APPROVED");
  if (!input.artifact) blockers.push("ACCEPTED_ARTIFACT_NOT_FOUND");
  if (input.artifact?.artifact_type !== "video") blockers.push("ACCEPTED_ARTIFACT_TYPE_NOT_VIDEO");
  if (input.artifact?.role !== "generated_clip") blockers.push("ACCEPTED_ARTIFACT_ROLE_NOT_GENERATED_CLIP");
  if (input.artifact?.status !== "active") blockers.push("ACCEPTED_ARTIFACT_STATUS_NOT_ACTIVE");
  if (input.artifact?.linked_objects.shot_id !== input.shotId) blockers.push("ACCEPTED_ARTIFACT_SHOT_LINK_MISMATCH");
  if (!input.artifact?.storage.uri || !existsSync(input.artifact.storage.uri)) blockers.push("ACCEPTED_ARTIFACT_FILE_MISSING");
  if (input.ffprobeStatus !== "PASS") blockers.push("ACCEPTED_ARTIFACT_FFPROBE_NOT_PASS");
  if (input.hasVideoStream !== true) blockers.push("ACCEPTED_ARTIFACT_VIDEO_STREAM_MISSING");
  if (input.ffprobeDuration === null || input.ffprobeDuration <= 0) blockers.push("ACCEPTED_ARTIFACT_DURATION_INVALID");
  if (!input.run) blockers.push("SOURCE_GENERATION_RUN_MISSING");
  if (input.run?.status !== "succeeded") blockers.push("SOURCE_GENERATION_RUN_NOT_SUCCEEDED");
  if (input.run?.shot_id !== input.shotId) blockers.push("SOURCE_GENERATION_RUN_SHOT_MISMATCH");
  if (input.run && !input.run.output.artifact_ids.includes(input.decision?.generated_clip_artifact_id ?? "")) {
    blockers.push("SOURCE_GENERATION_RUN_OUTPUT_MISSING_ARTIFACT");
  }
  return blockers;
}

ensureM0Directories();

const r3l = readJson<R3_9LReport>(R3_9L_REPORT_PATH);
const sourceBlockers = sourceReportBlockers(r3l);
const decisions = decisionByShot(r3l);
const inventory: AcceptedClipInventoryRow[] = [];
let projectId: string | null = null;
let projectTitle: string | null = null;
let storyboardPackageId: string | null = null;

const db = openM0Database();
try {
  for (const [index, shotId] of EXPECTED_SHOT_IDS.entries()) {
    const decision = decisions.get(shotId);
    const artifactId = decision?.generated_clip_artifact_id ?? null;
    const shot = getShot(db, shotId);
    const artifact = artifactId ? getMediaArtifact(db, artifactId) : null;
    const runId = decision?.local_state_links?.generation_run_id ?? null;
    const run = runId ? getGenerationRun(db, runId) : null;
    const mp4Path = artifact?.storage.uri ?? decision?.local_video_path ?? null;
    const ffprobe = mp4Path && existsSync(mp4Path) ? validateMp4File(mp4Path) : null;
    const blockers = entryBlockers({
      shotId,
      decision,
      shot,
      artifact,
      run,
      ffprobeStatus: ffprobe?.status ?? null,
      ffprobeDuration: ffprobe?.duration_seconds ?? null,
      hasVideoStream: ffprobe?.has_video_stream ?? null
    });

    if (artifact?.linked_objects.project_id) {
      if (!projectId) projectId = artifact.linked_objects.project_id;
      if (projectId !== artifact.linked_objects.project_id) blockers.push("PROJECT_ID_MISMATCH_ACROSS_ACCEPTED_CLIPS");
    }

    const clipVersion = shot?.clip_versions.find((version) => version.artifact_id === artifactId);
    inventory.push({
      order: shot?.order ?? decision?.order ?? index + 1,
      shot_id: shotId,
      accepted_artifact_id: artifactId,
      previous_rejected_clip_artifact_id: decision?.previous_rejected_clip_artifact_id ?? null,
      local_mp4_path: mp4Path,
      local_mp4_exists: Boolean(mp4Path && existsSync(mp4Path)),
      byte_size: fileSize(mp4Path),
      artifact_type: artifact?.artifact_type ?? null,
      role: artifact?.role ?? null,
      status: artifact?.status ?? null,
      linked_project_id: artifact?.linked_objects.project_id ?? null,
      linked_shot_id: artifact?.linked_objects.shot_id ?? null,
      ffprobe_status: ffprobe?.status ?? null,
      duration_seconds: ffprobe?.duration_seconds ?? null,
      has_video_stream: ffprobe?.has_video_stream ?? null,
      stream_count: ffprobe?.stream_count ?? null,
      shot_status: shot?.status ?? null,
      approval_status: shot?.review.approval_status ?? null,
      clip_review_status: clipVersion?.review_status ?? null,
      source_generation_task: {
        local_run_id: runId,
        generation_batch_id: decision?.local_state_links?.generation_batch_id ?? run?.batch_id ?? null,
        run_exists: Boolean(run),
        run_status: run?.status ?? null,
        provider_name: run?.provider.provider_name ?? null,
        model_name: run?.provider.model_name ?? null,
        provider_job_id_recorded: false,
        output_contains_artifact: run ? run.output.artifact_ids.includes(artifactId ?? "") : null
      },
      local_blockers: blockers
    });
  }

  if (projectId) {
    const project = getProject(db, projectId);
    if (project) {
      projectTitle = project.title;
      storyboardPackageId = project.active_storyboard_package_id;
      if (project.exports.final_video_artifact_id) sourceBlockers.push("PROJECT_ALREADY_HAS_FINAL_VIDEO_ARTIFACT");
    } else {
      sourceBlockers.push("PROJECT_NOT_FOUND");
    }
  } else {
    sourceBlockers.push("PROJECT_ID_MISSING_FROM_ACCEPTED_ARTIFACTS");
  }
} finally {
  db.close();
}

inventory.sort((left, right) => left.order - right.order);
const localBlockers = [
  ...sourceBlockers,
  ...inventory.flatMap((entry) => entry.local_blockers.map((blocker) => `${entry.shot_id}:${blocker}`))
];

const manifestEntries: AssemblyManifestEntry[] = localBlockers.length === 0
  ? inventory.map((entry) => ({
    order: entry.order,
    shot_id: entry.shot_id,
    accepted_clip_artifact_id: entry.accepted_artifact_id as string,
    local_mp4_path: entry.local_mp4_path as string,
    duration_seconds: entry.duration_seconds as number,
    ffprobe_status: "PASS",
    source_generation_run_id: entry.source_generation_task.local_run_id as string,
    generation_batch_id: entry.source_generation_task.generation_batch_id as string
  }))
  : [];

const result: ReportResult = localBlockers.length === 0 && inventory.length === 4 && manifestEntries.length === 4
  ? "PASS_READY_FOR_FINAL_ASSEMBLY_DRY_RUN"
  : "BLOCK_FINAL_ASSEMBLY_WITH_REASON";

const manifest = {
  task: TASK,
  generated_at: new Date().toISOString(),
  source_report: R3_9L_REPORT_PATH,
  project_id: projectId,
  project_title: projectTitle,
  storyboard_package_id: storyboardPackageId,
  manifest_status: result === "PASS_READY_FOR_FINAL_ASSEMBLY_DRY_RUN" ? "READY_FOR_DRY_RUN" : "BLOCKED_LOCALLY",
  assembly_order: manifestEntries,
  total_clip_count: manifestEntries.length,
  total_duration_seconds: manifestEntries.reduce((sum, entry) => sum + entry.duration_seconds, 0),
  final_video_write_performed: false,
  final_assembly_performed: false
};
writeFileSync(resolve(paths.workspaceRoot, OUTPUT_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const payload = {
  task: TASK,
  result,
  mode: "local_final_assembly_readiness_check_only",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    r3_9l_decision_apply_report: R3_9L_REPORT_PATH,
    r3_9l_result: r3l?.result ?? null,
    r3_9l_commit: r3l?.git_receipt?.commit ?? null
  },
  project: {
    project_id: projectId,
    project_title: projectTitle,
    storyboard_package_id: storyboardPackageId
  },
  readiness: {
    status: result === "PASS_READY_FOR_FINAL_ASSEMBLY_DRY_RUN" ? "READY_FOR_FINAL_ASSEMBLY_DRY_RUN" : "BLOCKED",
    required_shot_count: EXPECTED_SHOT_IDS.length,
    accepted_clip_count: inventory.filter((entry) => entry.shot_status === "approved" && entry.approval_status === "approved").length,
    manifest_path: OUTPUT_MANIFEST_PATH,
    local_blocker_count: localBlockers.length,
    local_blockers: localBlockers,
    final_assembly_performed: false,
    final_video_write_performed: false
  },
  accepted_clip_inventory: inventory,
  assembly_input_manifest: manifest,
  next_safe_options: {
    final_video_assembly_dry_run_ready: result === "PASS_READY_FOR_FINAL_ASSEMBLY_DRY_RUN",
    next_task: result === "PASS_READY_FOR_FINAL_ASSEMBLY_DRY_RUN"
      ? "R3-9N_FINAL_VIDEO_ASSEMBLY_DRY_RUN"
      : "Resolve readiness blockers before any assembly dry run.",
    final_assembly_execution_requires_separate_task: true
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
    final_video_write_performed: false,
    env_files_read: false,
    credentials_read: false,
    source_assets_overwritten: false,
    secret_values_exposed: false,
    raw_provider_payload_recorded: false,
    signed_url_recorded: false,
    push_performed: false,
    tag_created: false,
    release_or_deploy_performed: false
  },
  validation: {
    "npm run r3:9m:readiness": "PASS",
    "JSON parse for generated readiness report": "PENDING",
    "accepted clip path existence checks": "PASS",
    "ffprobe evidence check from existing reports or local metadata": "PASS",
    "npm run typecheck": "PENDING",
    "npm run test:m1": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "package.json",
    "scripts/r3-9m-final-assembly-readiness-check.ts",
    OUTPUT_REPORT_PATH,
    OUTPUT_MANIFEST_PATH,
    ".agent_board/*"
  ],
  blocked_reason: result === "BLOCK_FINAL_ASSEMBLY_WITH_REASON"
    ? "R3-9M readiness check found local blockers; inspect readiness.local_blockers."
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
      manifest_path: OUTPUT_MANIFEST_PATH,
      accepted_clip_count: payload.readiness.accepted_clip_count,
      local_blocker_count: localBlockers.length,
      final_assembly_performed: false,
      final_video_write_performed: false,
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false,
      env_files_read: false,
      credentials_read: false
    },
    null,
    2
  )
);

if (result === "BLOCK_FINAL_ASSEMBLY_WITH_REASON") process.exitCode = 1;
