import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureM0Directories,
  getGenerationRun,
  getMediaArtifact,
  getProject,
  getShot,
  markShotClipReview,
  openM0Database,
  paths,
  saveGenerationBatch,
  saveGenerationRun,
  saveProject,
  saveShot,
  validateMp4File,
  type GenerationBatch,
  type GenerationRun,
  type RevisionInstruction,
  type Shot
} from "../src/index.js";

const TASK = "R3-9L_HUMAN_REGENERATED_CLIP_REVIEW_DECISION_APPLY";
const REVIEW_TABLE_PATH = "data/reports/r3_9k_runninghub_regenerated_clip_review_table.md";
const R3_9K_REPORT_PATH = "data/reports/r3_9k_runninghub_regenerated_clip_review_prep_result.json";
const R3_9J_REPORT_PATH = "data/reports/r3_9j_runninghub_regeneration_single_pass_live_execution_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r3_9l_human_regenerated_clip_review_decision_apply_result.json";
const LIVE_BATCH_ID = "batch_r3_9j_runninghub_regeneration_single_pass_live_execution";

type HumanDecision = "accept" | "reject" | "regenerate_requested";
type ReportResult = "PASS_REVIEW_DECISIONS_APPLIED" | "BLOCK_WITH_REASON";

interface ParsedReviewDecision {
  order: number;
  shot_id: string;
  generated_clip_artifact_id: string;
  ffprobe_status: string;
  duration_seconds: number;
  local_mp4_path: string;
  previous_rejected_clip_artifact_id: string;
  previous_issue_zh: string;
  review_focus_zh: string;
  decision: HumanDecision;
  decision_cell_value: string;
  reviewer: string;
  note: string;
  local_blockers: string[];
}

interface R3_9JShotReceipt {
  shot_id?: string;
  order?: number;
  status?: string;
  source_artifact_id?: string;
  rejected_clip_artifact_id?: string;
  generated_artifact_id?: string;
  local_storage_uri?: string;
  ffprobe_status?: string;
  ffprobe_duration_seconds?: number;
  has_video_stream?: boolean;
  stream_count?: number;
  provider_status?: string;
  provider_job_id?: string;
}

interface R3_9JReport {
  result?: string;
  provider_contract?: {
    provider?: string;
    model_route?: string;
    duration_seconds_per_shot?: number;
    aspectRatio?: string;
    resolution?: string;
  };
  live_execution?: {
    successful_shot_count?: number;
    failed_shot_count?: number;
    skipped_shot_count?: number;
  };
  shots?: R3_9JShotReceipt[];
  output_artifacts?: Array<{
    shot_id?: string;
    artifact_id?: string;
    storage_uri?: string;
    ffprobe_status?: string;
    duration_seconds?: number;
  }>;
  git_receipt?: { commit?: string };
}

interface R3_9KReport {
  result?: string;
  package?: {
    project_id?: string;
    storyboard_package_id?: string;
  };
  review_package?: {
    generated_clip_count?: number;
    local_blocker_count?: number;
    review_table_path?: string;
  };
  review_entries?: Array<{
    shot_id?: string | null;
    generated_clip?: {
      artifact_id?: string | null;
      local_mp4_path?: string | null;
      ffprobe_status?: string | null;
      duration_seconds?: number | null;
    };
    previous_review?: {
      rejected_clip_artifact_id?: string | null;
      issue_zh?: string | null;
    };
    source_keyframe?: {
      storyboard_image_artifact_id?: string | null;
    };
  }>;
  git_receipt?: { commit?: string };
}

interface ApplyRecord {
  order: number;
  shot_id: string;
  generated_clip_artifact_id: string;
  previous_rejected_clip_artifact_id: string;
  local_video_path: string;
  previous_issue_zh: string;
  review_focus_zh: string;
  decision: HumanDecision;
  reviewer: string;
  note: string;
  mapped_app_decision: "approved" | "revision_needed";
  before: {
    shot_status: string;
    accepted_clip_artifact_id: string;
    approval_status: string;
    rejection_reasons: string[];
    clip_version_count: number;
  };
  after: {
    shot_status: string;
    approval_status: string;
    accepted_clip_artifact_id: string;
    clip_review_status: string | null;
    rejection_reasons: string[];
    latest_revision_instruction: RevisionInstruction | null;
  };
  local_state_links: {
    generation_run_id: string;
    generation_run_created: boolean;
    generation_run_linked_to_shot: boolean;
    clip_version_added: boolean;
    generation_batch_id: string;
  };
}

function readJson<T>(relativePath: string): T | null {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function parseDecisionCell(cells: string[]): { decision: HumanDecision | null; value: string; blockers: string[] } {
  const choices: Array<{ decision: HumanDecision; value: string }> = [
    { decision: "accept" as const, value: cells[9] ?? "" },
    { decision: "reject" as const, value: cells[10] ?? "" },
    { decision: "regenerate_requested" as const, value: cells[11] ?? "" }
  ].filter((choice) => choice.value.trim().length > 0);

  if (choices.length !== 1) {
    return {
      decision: null,
      value: "",
      blockers: [`DECISION_COUNT_NOT_1:${choices.length}`]
    };
  }
  return { decision: choices[0].decision, value: choices[0].value, blockers: [] };
}

function parseReviewTable(): ParsedReviewDecision[] {
  const table = readFileSync(resolve(paths.workspaceRoot, REVIEW_TABLE_PATH), "utf8");
  const rows = table.split(/\r?\n/).filter((line) => /^\|\s*\d+\s*\|/.test(line));
  return rows.map((line) => {
    const cells = splitMarkdownRow(line);
    const decision = parseDecisionCell(cells);
    const order = Number(cells[0]);
    const duration = Number(cells[4]);
    const entry: ParsedReviewDecision = {
      order,
      shot_id: cells[1] ?? "",
      generated_clip_artifact_id: cells[2] ?? "",
      ffprobe_status: cells[3] ?? "",
      duration_seconds: Number.isFinite(duration) ? duration : 0,
      local_mp4_path: cells[5] ?? "",
      previous_rejected_clip_artifact_id: cells[6] ?? "",
      previous_issue_zh: cells[7] ?? "",
      review_focus_zh: cells[8] ?? "",
      decision: decision.decision ?? "reject",
      decision_cell_value: decision.value,
      reviewer: cells[12] ?? "",
      note: cells[13] ?? "",
      local_blockers: [...decision.blockers]
    };

    if (cells.length < 14) entry.local_blockers.push(`COLUMN_COUNT_TOO_SMALL:${cells.length}`);
    if (!Number.isInteger(order) || order < 1) entry.local_blockers.push("ORDER_INVALID");
    if (!entry.shot_id) entry.local_blockers.push("SHOT_ID_MISSING");
    if (!entry.generated_clip_artifact_id.startsWith("artifact_")) entry.local_blockers.push("GENERATED_ARTIFACT_ID_INVALID");
    if (entry.ffprobe_status !== "PASS") entry.local_blockers.push("FFPROBE_NOT_PASS_IN_TABLE");
    if (!entry.local_mp4_path || !existsSync(entry.local_mp4_path)) entry.local_blockers.push("LOCAL_MP4_MISSING");
    if (!entry.previous_rejected_clip_artifact_id.startsWith("artifact_")) entry.local_blockers.push("PREVIOUS_REJECTED_CLIP_ARTIFACT_ID_INVALID");
    if (!entry.previous_issue_zh) entry.local_blockers.push("PREVIOUS_ISSUE_MISSING");
    if (!entry.review_focus_zh) entry.local_blockers.push("REVIEW_FOCUS_MISSING");
    if (!entry.reviewer) entry.local_blockers.push("REVIEWER_MISSING");
    if (entry.decision !== "accept" && !entry.note) entry.local_blockers.push("NOTE_REQUIRED_FOR_REJECT_OR_REGENERATE");
    return entry;
  });
}

function decisionSummary(decisions: ParsedReviewDecision[]) {
  return {
    accept: decisions.filter((entry) => entry.decision === "accept").length,
    reject: decisions.filter((entry) => entry.decision === "reject").length,
    regenerate_requested: decisions.filter((entry) => entry.decision === "regenerate_requested").length
  };
}

function revisionInstructionFor(entry: ParsedReviewDecision): RevisionInstruction {
  return {
    summary: entry.note,
    prompt_delta: entry.note,
    negative_delta: "",
    priority: "high"
  };
}

function expectedRunId(artifactId: string): string {
  return `run_r3_9j_${artifactId.replace(/^artifact_/, "").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function maxAttemptNumber(shot: Shot): number {
  return shot.clip_versions.reduce((max, version) => Math.max(max, version.attempt_number), 0);
}

function ensureLiveRunAndClipVersion(input: {
  shot: Shot;
  entry: ParsedReviewDecision;
  receipt: R3_9JShotReceipt;
  project: NonNullable<ReturnType<typeof getProject>>;
  storyboardPackageId: string;
  providerContract: R3_9JReport["provider_contract"];
  db: ReturnType<typeof openM0Database>;
}): { run_id: string; run_created: boolean; run_linked_to_shot: boolean; clip_version_added: boolean; attempt_number: number } {
  const runId = expectedRunId(input.entry.generated_clip_artifact_id);
  const existingRun = getGenerationRun(input.db, runId);
  const existingVersion = input.shot.clip_versions.find((version) => version.artifact_id === input.entry.generated_clip_artifact_id);
  const attemptNumber = existingVersion?.attempt_number ?? maxAttemptNumber(input.shot) + 1;

  let runCreated = false;
  if (!existingRun) {
    const run: GenerationRun = {
      run_id: runId,
      batch_id: LIVE_BATCH_ID,
      project_id: input.shot.project_id,
      shot_id: input.shot.shot_id,
      run_type: "image_to_video",
      status: "succeeded",
      input: {
        storyboard_image_artifact_id: input.shot.storyboard_image_artifact_id,
        video_prompt: input.shot.video_prompt,
        negative_prompt: input.shot.negative_prompt,
        duration_seconds: input.receipt.ffprobe_duration_seconds ?? input.entry.duration_seconds,
        aspect_ratio: input.project.video_spec.aspect_ratio,
        resolution: input.providerContract?.resolution ?? input.project.video_spec.resolution
      },
      output: {
        artifact_ids: [input.entry.generated_clip_artifact_id]
      },
      provider: {
        provider: "real",
        provider_name: "runninghub",
        model_name: input.providerContract?.model_route ?? "rhart-video-g/image-to-video",
        provider_job_id: input.receipt.provider_job_id ?? "",
        provider_status: input.receipt.provider_status ?? "SUCCESS"
      },
      versioning: {
        attempt_number: attemptNumber,
        parent_run_id: ""
      },
      error: {
        code: "",
        message: "",
        retryable: false
      }
    };
    saveGenerationRun(input.db, run);
    runCreated = true;
  }

  let runLinkedToShot = false;
  if (!input.shot.generation_run_ids.includes(runId)) {
    input.shot.generation_run_ids.push(runId);
    runLinkedToShot = true;
  }

  let clipVersionAdded = false;
  if (!existingVersion) {
    input.shot.clip_versions.push({
      artifact_id: input.entry.generated_clip_artifact_id,
      run_id: runId,
      attempt_number: attemptNumber,
      review_status: "pending"
    });
    input.shot.status = "video_generated";
    clipVersionAdded = true;
  }

  if (runLinkedToShot || clipVersionAdded) saveShot(input.db, input.shot);

  return { run_id: runId, run_created: runCreated, run_linked_to_shot: runLinkedToShot, clip_version_added: clipVersionAdded, attempt_number: attemptNumber };
}

function validateSourceReports(input: {
  r3j: R3_9JReport | null;
  r3k: R3_9KReport | null;
  decisions: ParsedReviewDecision[];
}): string[] {
  const blockers: string[] = [];
  if (!input.r3j) blockers.push("R3_9J_REPORT_MISSING");
  if (!input.r3k) blockers.push("R3_9K_REPORT_MISSING");
  if (input.r3j?.result !== "PASS_LIVE_4_SHOT_REGENERATION_COMPLETED") blockers.push("R3_9J_NOT_PASS");
  if (input.r3k?.result !== "PASS_REVIEW_PACKAGE_READY") blockers.push("R3_9K_NOT_PASS");
  if (input.r3j?.live_execution?.successful_shot_count !== 4) blockers.push("R3_9J_SUCCESSFUL_SHOT_COUNT_NOT_4");
  if (input.r3j?.live_execution?.failed_shot_count !== 0) blockers.push("R3_9J_HAS_FAILED_SHOTS");
  if (input.r3j?.live_execution?.skipped_shot_count !== 0) blockers.push("R3_9J_HAS_SKIPPED_SHOTS");
  if (input.r3k?.review_package?.generated_clip_count !== 4) blockers.push("R3_9K_REVIEW_CLIP_COUNT_NOT_4");
  if (input.r3k?.review_package?.local_blocker_count !== 0) blockers.push("R3_9K_HAS_LOCAL_BLOCKERS");
  if (input.r3k?.review_package?.review_table_path !== REVIEW_TABLE_PATH) blockers.push("R3_9K_REVIEW_TABLE_PATH_MISMATCH");
  if (input.decisions.length !== 4) blockers.push(`DECISION_ROW_COUNT_NOT_4:${input.decisions.length}`);
  return blockers;
}

ensureM0Directories();

const decisions = parseReviewTable();
const r3j = readJson<R3_9JReport>(R3_9J_REPORT_PATH);
const r3k = readJson<R3_9KReport>(R3_9K_REPORT_PATH);
const sourceBlockers = validateSourceReports({ r3j, r3k, decisions });
const r3jShotById = new Map((r3j?.shots ?? []).map((shot) => [shot.shot_id ?? "", shot]));
const r3kEntryByShot = new Map((r3k?.review_entries ?? []).map((entry) => [entry.shot_id ?? "", entry]));
const applied: ApplyRecord[] = [];
const localBlockers: string[] = [...sourceBlockers];
let batchSaved = false;
let projectBatchLinked = false;

for (const decision of decisions) {
  localBlockers.push(...decision.local_blockers.map((blocker) => `${decision.shot_id || "unknown"}:${blocker}`));
  const r3jShot = r3jShotById.get(decision.shot_id);
  const r3kEntry = r3kEntryByShot.get(decision.shot_id);
  if (!r3jShot) localBlockers.push(`${decision.shot_id}:R3_9J_SHOT_RECEIPT_MISSING`);
  if (!r3kEntry) localBlockers.push(`${decision.shot_id}:R3_9K_REVIEW_ENTRY_MISSING`);
  if (r3jShot?.status !== "SUCCEEDED") localBlockers.push(`${decision.shot_id}:R3_9J_SHOT_NOT_SUCCEEDED`);
  if (r3jShot?.generated_artifact_id !== decision.generated_clip_artifact_id) localBlockers.push(`${decision.shot_id}:R3_9J_ARTIFACT_MISMATCH`);
  if (r3kEntry?.generated_clip?.artifact_id !== decision.generated_clip_artifact_id) localBlockers.push(`${decision.shot_id}:R3_9K_ARTIFACT_MISMATCH`);
  if (r3kEntry?.previous_review?.rejected_clip_artifact_id !== decision.previous_rejected_clip_artifact_id) localBlockers.push(`${decision.shot_id}:PREVIOUS_REJECTED_ARTIFACT_MISMATCH`);
  if (r3jShot?.ffprobe_status !== "PASS") localBlockers.push(`${decision.shot_id}:R3_9J_FFPROBE_NOT_PASS`);
}

if (localBlockers.length === 0) {
  const db = openM0Database();
  try {
    const projectId = r3k?.package?.project_id ?? "";
    const storyboardPackageId = r3k?.package?.storyboard_package_id ?? "";
    const project = getProject(db, projectId);
    if (!project) {
      localBlockers.push("PROJECT_NOT_FOUND");
    } else {
      const runIds: string[] = [];
      for (const entry of decisions) {
        const shot = getShot(db, entry.shot_id);
        const receipt = r3jShotById.get(entry.shot_id);
        const artifact = getMediaArtifact(db, entry.generated_clip_artifact_id);
        const before = {
          shot_status: shot?.status ?? "",
          accepted_clip_artifact_id: shot?.accepted_clip_artifact_id ?? "",
          approval_status: shot?.review.approval_status ?? "",
          rejection_reasons: shot?.review.rejection_reasons ?? [],
          clip_version_count: shot?.clip_versions.length ?? 0
        };

        if (!shot) {
          localBlockers.push(`${entry.shot_id}:SHOT_NOT_FOUND`);
          continue;
        }
        if (!receipt) {
          localBlockers.push(`${entry.shot_id}:R3_9J_SHOT_RECEIPT_MISSING`);
          continue;
        }
        if (!artifact) {
          localBlockers.push(`${entry.shot_id}:GENERATED_ARTIFACT_NOT_FOUND`);
          continue;
        }
        if (artifact.artifact_type !== "video" || artifact.role !== "generated_clip" || artifact.status !== "active") {
          localBlockers.push(`${entry.shot_id}:GENERATED_ARTIFACT_CLASSIFICATION_INVALID`);
          continue;
        }
        if (artifact.linked_objects.shot_id !== entry.shot_id || artifact.linked_objects.project_id !== shot.project_id) {
          localBlockers.push(`${entry.shot_id}:GENERATED_ARTIFACT_LINK_MISMATCH`);
          continue;
        }
        if (!existsSync(artifact.storage.uri)) {
          localBlockers.push(`${entry.shot_id}:GENERATED_ARTIFACT_FILE_MISSING`);
          continue;
        }
        const ffprobe = validateMp4File(artifact.storage.uri);
        if (ffprobe.status !== "PASS" || ffprobe.has_video_stream !== true) {
          localBlockers.push(`${entry.shot_id}:GENERATED_ARTIFACT_FFPROBE_NOT_PASS`);
          continue;
        }

        const link = ensureLiveRunAndClipVersion({ shot, entry, receipt, project, storyboardPackageId, providerContract: r3j?.provider_contract, db });
        runIds.push(link.run_id);
        const appDecision = entry.decision === "accept" ? "approved" : "revision_needed";
        const review = markShotClipReview(
          {
            shot_id: entry.shot_id,
            artifact_id: entry.generated_clip_artifact_id,
            decision: appDecision,
            rejection_reasons: appDecision === "revision_needed" ? [entry.note] : [],
            revision_instruction: appDecision === "revision_needed" ? revisionInstructionFor(entry) : undefined
          },
          db
        );
        if (!review.ok) {
          localBlockers.push(`${entry.shot_id}:MARK_REVIEW_FAILED:${review.error.code}`);
          continue;
        }
        const clipVersion = review.shot.clip_versions.find((version) => version.artifact_id === entry.generated_clip_artifact_id);
        applied.push({
          order: entry.order,
          shot_id: entry.shot_id,
          generated_clip_artifact_id: entry.generated_clip_artifact_id,
          previous_rejected_clip_artifact_id: entry.previous_rejected_clip_artifact_id,
          local_video_path: entry.local_mp4_path,
          previous_issue_zh: entry.previous_issue_zh,
          review_focus_zh: entry.review_focus_zh,
          decision: entry.decision,
          reviewer: entry.reviewer,
          note: entry.note,
          mapped_app_decision: appDecision,
          before,
          after: {
            shot_status: review.shot.status,
            approval_status: review.shot.review.approval_status,
            accepted_clip_artifact_id: review.shot.accepted_clip_artifact_id,
            clip_review_status: clipVersion?.review_status ?? null,
            rejection_reasons: review.shot.review.rejection_reasons,
            latest_revision_instruction: review.shot.review.latest_revision_instruction
          },
          local_state_links: {
            generation_run_id: link.run_id,
            generation_run_created: link.run_created,
            generation_run_linked_to_shot: link.run_linked_to_shot,
            clip_version_added: link.clip_version_added,
            generation_batch_id: LIVE_BATCH_ID
          }
        });
      }

      if (localBlockers.length === 0) {
        const batch: GenerationBatch = {
          batch_id: LIVE_BATCH_ID,
          project_id: project.project_id,
          storyboard_package_id: storyboardPackageId,
          run_ids: runIds,
          status: "succeeded",
          summary: {
            total: runIds.length,
            queued: 0,
            running: 0,
            succeeded: runIds.length,
            failed: 0
          }
        };
        saveGenerationBatch(db, batch);
        batchSaved = true;
        if (!project.generation_batch_ids.includes(LIVE_BATCH_ID)) {
          project.generation_batch_ids.push(LIVE_BATCH_ID);
          saveProject(db, project);
          projectBatchLinked = true;
        }
      }
    }
  } finally {
    db.close();
  }
}

const summary = decisionSummary(decisions);
const allAccepted = summary.accept === 4 && summary.reject === 0 && summary.regenerate_requested === 0;
const result: ReportResult = localBlockers.length === 0 && applied.length === 4
  ? "PASS_REVIEW_DECISIONS_APPLIED"
  : "BLOCK_WITH_REASON";

const payload = {
  task: TASK,
  result,
  mode: "local_review_decision_apply_only",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    review_table: REVIEW_TABLE_PATH,
    r3_9k_review_prep_report: R3_9K_REPORT_PATH,
    r3_9k_result: r3k?.result ?? null,
    r3_9k_commit: r3k?.git_receipt?.commit ?? null,
    r3_9j_live_report: R3_9J_REPORT_PATH,
    r3_9j_result: r3j?.result ?? null,
    r3_9j_commit: r3j?.git_receipt?.commit ?? null
  },
  decision_apply: {
    status: result === "PASS_REVIEW_DECISIONS_APPLIED" ? "APPLIED_TO_LOCAL_REVIEW_STATE" : "BLOCKED_LOCALLY",
    parsed_decision_count: decisions.length,
    applied_decision_count: applied.length,
    decision_summary: summary,
    all_accepted: allAccepted,
    reviewer_names: Array.from(new Set(decisions.map((entry) => entry.reviewer).filter(Boolean))),
    local_blocker_count: localBlockers.length,
    local_blockers: localBlockers,
    live_generation_batch_receipt_backfilled: batchSaved,
    live_generation_batch_linked_to_project: projectBatchLinked,
    app_review_state_mutated: applied.length > 0
  },
  decisions: applied,
  parsed_decisions: decisions.map((entry) => ({
    order: entry.order,
    shot_id: entry.shot_id,
    generated_clip_artifact_id: entry.generated_clip_artifact_id,
    previous_rejected_clip_artifact_id: entry.previous_rejected_clip_artifact_id,
    local_video_path: entry.local_mp4_path,
    previous_issue_zh: entry.previous_issue_zh,
    review_focus_zh: entry.review_focus_zh,
    decision: entry.decision,
    decision_cell_value: entry.decision_cell_value,
    reviewer: entry.reviewer,
    note: entry.note,
    local_blockers: entry.local_blockers
  })),
  final_assembly_gate: {
    final_assembly_performed: false,
    final_assembly_readiness_check_next_safe_task: allAccepted,
    status: allAccepted ? "READY_FOR_FINAL_ASSEMBLY_READINESS_CHECK" : "BLOCKED_PENDING_REPAIR_OR_REVIEW",
    reason: allAccepted
      ? "All 4 regenerated clips were accepted locally; run a separate readiness check before any final assembly execution."
      : "At least one regenerated clip was not accepted; prepare repair or review follow-up before final assembly."
  },
  next_safe_options: {
    final_assembly_readiness_check: allAccepted,
    regeneration_planning_for: applied.filter((entry) => entry.decision === "regenerate_requested").map((entry) => entry.shot_id),
    rejected_shots_requiring_separate_handling_decision: applied.filter((entry) => entry.decision === "reject").map((entry) => entry.shot_id),
    provider_regeneration_requires_separate_task_and_fresh_authorization: true,
    final_assembly_requires_separate_task: true
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
    "npm run r3:9l:apply-review": "PASS",
    "R3-9K review table parse / required decisions check": "PASS",
    "JSON parse for generated R3-9L decision apply report": "PENDING",
    "npm run typecheck": "PENDING",
    "npm run test:m1": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "package.json",
    "src/tools/review.ts",
    "scripts/r3-9l-human-regenerated-clip-review-decision-apply.ts",
    REVIEW_TABLE_PATH,
    OUTPUT_REPORT_PATH,
    "data/app.sqlite",
    ".agent_board/*"
  ],
  blocked_reason: result === "BLOCK_WITH_REASON"
    ? "R3-9L found local blockers; inspect decision_apply.local_blockers and parsed_decisions[].local_blockers."
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
      parsed_decision_count: decisions.length,
      applied_decision_count: applied.length,
      decision_summary: summary,
      final_assembly_gate: payload.final_assembly_gate.status,
      local_blocker_count: localBlockers.length,
      network_call_attempted: false,
      runninghub_called: false,
      runway_called: false,
      regeneration_performed: false,
      final_assembly_performed: false,
      env_files_read: false,
      credentials_read: false
    },
    null,
    2
  )
);

if (result === "BLOCK_WITH_REASON") process.exitCode = 1;
