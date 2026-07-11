import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureM0Directories,
  executeWebGptReadOnlyTool,
  executeWebGptReviewAssistantTool,
  openM0Database,
  paths,
  WEBGPT_DRAFT_TOOLS,
  WEBGPT_PENDING_ACTION_TOOLS,
  WEBGPT_PRODUCTION_ASSISTANT_TOOLS,
  WEBGPT_READ_ONLY_TOOLS,
  WEBGPT_REVIEW_ASSISTANT_TOOLS
} from "../src/index.js";

const TASK = "R1-7_WEBGPT_LOCAL_BRIDGE_SMOKE_VALIDATION";
const SOURCE_AUDIT_REPORT_PATH = "data/reports/r1_6_webgpt_post_closeout_bridge_reality_audit_result.json";
const FINAL_CLOSEOUT_REPORT_PATH = "data/reports/r3_9r_final_delivery_closeout_result.json";
const OUTPUT_REPORT_PATH = "data/reports/r1_7_webgpt_local_bridge_smoke_validation_result.json";

interface PackageJson {
  scripts?: Record<string, string>;
}

interface R1_6Report {
  result?: string;
  bridge_inventory?: Array<{
    phase?: string;
    package_script?: string;
    command?: string | null;
    source_exists?: boolean;
    entrypoint_exists?: boolean;
    test_exists?: boolean;
  }>;
}

interface R3_9RReport {
  result?: string;
  project?: {
    project_id?: string;
    project_status?: string;
  };
  final_approval?: {
    decision?: string;
    reviewer?: string;
    final_creative_approval_recorded?: boolean;
  };
  final_video?: {
    local_video_path?: string;
    final_video_artifact_id?: string;
    ffprobe_status?: string;
  };
  source_clips?: Array<{
    order: number;
    shot_id: string;
    source_clip_artifact_id: string;
    ffprobe_status: string;
  }>;
}

function readJson<T>(relativePath: string): T | null {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function script(packageJson: PackageJson, name: string): string | null {
  return packageJson.scripts?.[name] ?? null;
}

function toolNames<T extends { name: string }>(tools: T[]): string[] {
  return tools.map((tool) => tool.name);
}

function toolSafetyFlags<T extends { name: string }>(tools: T[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({ ...tool }));
}

function bridgeBoundary() {
  return {
    public_tunnel_started: false,
    network_call_attempted: false,
    provider_called: false,
    runninghub_called: false,
    runway_called: false,
    media_upload_to_provider: false,
    env_files_read: false,
    credentials_read: false,
    production_truth_mutated: false,
    source_assets_overwritten: false,
    secret_values_exposed: false,
    raw_provider_payload_recorded: false,
    signed_url_recorded: false,
    publish_performed: false,
    release_or_deploy_performed: false,
    push_performed: false,
    tag_created: false
  };
}

ensureM0Directories();

const packageJson = readJson<PackageJson>("package.json") ?? {};
const auditReport = readJson<R1_6Report>(SOURCE_AUDIT_REPORT_PATH);
const closeoutReport = readJson<R3_9RReport>(FINAL_CLOSEOUT_REPORT_PATH);
const finalArtifactId = closeoutReport?.final_video?.final_video_artifact_id ?? "";
const firstSourceClip = [...(closeoutReport?.source_clips ?? [])].sort((left, right) => left.order - right.order)[0] ?? null;
const blockers: string[] = [];

if (auditReport?.result !== "PASS_GPT_BRIDGE_REALITY_AUDITED") blockers.push("R1_6_AUDIT_NOT_PASS");
if (closeoutReport?.result !== "PASS_FINAL_DELIVERY_CLOSEOUT_READY") blockers.push("R3_9R_CLOSEOUT_NOT_PASS");
if (closeoutReport?.project?.project_status !== "final_approved") blockers.push("R3_9R_PROJECT_NOT_FINAL_APPROVED");
if (closeoutReport?.final_approval?.decision !== "accept" || closeoutReport?.final_approval?.reviewer !== "Jenn") blockers.push("FINAL_APPROVAL_NOT_ACCEPTED_BY_JENN");
if (!finalArtifactId) blockers.push("FINAL_ARTIFACT_ID_MISSING");
if (!firstSourceClip?.source_clip_artifact_id) blockers.push("SOURCE_CLIP_ARTIFACT_ID_MISSING");

const expectedScripts = [
  "webgpt:bridge:v0",
  "webgpt:bridge:v0.5",
  "webgpt:bridge:v1",
  "webgpt:bridge:v2",
  "webgpt:bridge:v3",
  "test:webgpt:bridge",
  "test:webgpt:drafts",
  "test:webgpt:pending",
  "test:webgpt:review",
  "test:webgpt:production"
];
const packageScriptSmoke = expectedScripts.map((name) => ({
  name,
  command: script(packageJson, name),
  exists: Boolean(script(packageJson, name))
}));
for (const item of packageScriptSmoke) {
  if (!item.exists) blockers.push(`PACKAGE_SCRIPT_MISSING:${item.name}`);
}

const db = openM0Database();
let latestReportsSmoke: Record<string, unknown>;
let finalArtifactSmoke: Record<string, unknown>;
let reviewMetadataSmoke: Record<string, unknown>;
try {
  const latestReports = executeWebGptReadOnlyTool("get_latest_reports", {}, db);
  const latestReportRefs = latestReports.ok && latestReports.data && typeof latestReports.data === "object"
    ? ((latestReports.data as { reports?: Array<{ relative_path?: string }> }).reports ?? [])
    : [];
  const r3_9rReachable = latestReportRefs.some((report) => report.relative_path === FINAL_CLOSEOUT_REPORT_PATH);
  const r1_6Reachable = latestReportRefs.some((report) => report.relative_path === SOURCE_AUDIT_REPORT_PATH);
  if (!latestReports.ok) blockers.push("READ_ONLY_GET_LATEST_REPORTS_FAILED");
  if (!r3_9rReachable) blockers.push("READ_ONLY_REPORTS_DO_NOT_INCLUDE_R3_9R");
  if (!r1_6Reachable) blockers.push("READ_ONLY_REPORTS_DO_NOT_INCLUDE_R1_6");
  latestReportsSmoke = {
    ok: latestReports.ok,
    r3_9r_closeout_report_reachable: r3_9rReachable,
    r1_6_audit_report_reachable: r1_6Reachable,
    report_ref_count: latestReportRefs.length
  };

  const finalArtifact = finalArtifactId ? executeWebGptReadOnlyTool("get_media_artifact", { artifact_id: finalArtifactId }, db) : null;
  if (!finalArtifact?.ok) blockers.push("READ_ONLY_FINAL_ARTIFACT_LOOKUP_FAILED");
  finalArtifactSmoke = {
    ok: finalArtifact?.ok ?? false,
    artifact_id: finalArtifactId,
    mode: finalArtifact?.ok ? finalArtifact.mode : null,
    mutation_allowed: finalArtifact?.ok ? finalArtifact.mutation_allowed : null
  };

  const reviewMetadata = firstSourceClip?.source_clip_artifact_id
    ? executeWebGptReviewAssistantTool("get_generated_clip_metadata", { artifact_id: firstSourceClip.source_clip_artifact_id }, db)
    : null;
  const ffprobeStatus = reviewMetadata?.ok && reviewMetadata.data && typeof reviewMetadata.data === "object"
    ? ((reviewMetadata.data as { ffprobe?: { status?: string } }).ffprobe?.status ?? null)
    : null;
  if (!reviewMetadata?.ok) blockers.push("REVIEW_ASSISTANT_SOURCE_CLIP_METADATA_FAILED");
  if (ffprobeStatus !== "PASS") blockers.push("REVIEW_ASSISTANT_SOURCE_CLIP_FFPROBE_NOT_PASS");
  reviewMetadataSmoke = {
    ok: reviewMetadata?.ok ?? false,
    artifact_id: firstSourceClip?.source_clip_artifact_id ?? null,
    ffprobe_status: ffprobeStatus,
    final_human_approval_allowed: reviewMetadata?.ok ? reviewMetadata.final_human_approval_allowed : null,
    regeneration_allowed: reviewMetadata?.ok ? reviewMetadata.regeneration_allowed : null
  };
} finally {
  db.close();
}

const boundary = bridgeBoundary();
const result = blockers.length === 0 ? "PASS_WEBGPT_LOCAL_BRIDGE_SMOKE_VALIDATED" : "BLOCK_WEBGPT_LOCAL_BRIDGE_SMOKE_WITH_REASON";
const payload = {
  task: TASK,
  result,
  mode: "local_bridge_smoke_validation_only",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    r1_6_audit_report: SOURCE_AUDIT_REPORT_PATH,
    r3_9r_final_delivery_closeout_report: FINAL_CLOSEOUT_REPORT_PATH,
    package_json: "package.json"
  },
  package_script_smoke: packageScriptSmoke,
  direct_app_tool_smoke: {
    latest_reports: latestReportsSmoke,
    final_video_artifact_lookup: finalArtifactSmoke,
    source_clip_review_metadata_lookup: reviewMetadataSmoke
  },
  bridge_tool_inventory: {
    v0_read_only: {
      tools: toolNames(WEBGPT_READ_ONLY_TOOLS),
      safety_flags: toolSafetyFlags(WEBGPT_READ_ONLY_TOOLS)
    },
    v0_5_drafts: {
      tools: toolNames(WEBGPT_DRAFT_TOOLS),
      safety_flags: toolSafetyFlags(WEBGPT_DRAFT_TOOLS)
    },
    v1_pending_actions: {
      tools: toolNames(WEBGPT_PENDING_ACTION_TOOLS),
      safety_flags: toolSafetyFlags(WEBGPT_PENDING_ACTION_TOOLS)
    },
    v2_review_assistant: {
      tools: toolNames(WEBGPT_REVIEW_ASSISTANT_TOOLS),
      safety_flags: toolSafetyFlags(WEBGPT_REVIEW_ASSISTANT_TOOLS)
    },
    v3_production_assistant: {
      tools: toolNames(WEBGPT_PRODUCTION_ASSISTANT_TOOLS),
      safety_flags: toolSafetyFlags(WEBGPT_PRODUCTION_ASSISTANT_TOOLS)
    }
  },
  current_final_approved_evidence: {
    project_id: closeoutReport?.project?.project_id ?? null,
    project_status: closeoutReport?.project?.project_status ?? null,
    final_decision: closeoutReport?.final_approval?.decision ?? null,
    final_reviewer: closeoutReport?.final_approval?.reviewer ?? null,
    final_video_artifact_id: finalArtifactId || null,
    final_video_path: closeoutReport?.final_video?.local_video_path ?? null,
    final_video_ffprobe_status: closeoutReport?.final_video?.ffprobe_status ?? null,
    source_clip_count: closeoutReport?.source_clips?.length ?? 0
  },
  test_matrix: {
    "npm run test:webgpt:bridge": "PENDING",
    "npm run test:webgpt:drafts": "PENDING",
    "npm run test:webgpt:pending": "PENDING",
    "npm run test:webgpt:review": "PENDING",
    "npm run test:webgpt:production": "PENDING"
  },
  provider_boundary: boundary,
  local_blockers: blockers,
  validation: {
    "npm run r1:7:smoke": result === "PASS_WEBGPT_LOCAL_BRIDGE_SMOKE_VALIDATED" ? "PASS" : "FAIL",
    "JSON parse for generated R1-7 smoke report": "PENDING",
    "npm run typecheck": "PENDING",
    "npm run test:webgpt:bridge": "PENDING",
    "npm run test:webgpt:drafts": "PENDING",
    "npm run test:webgpt:pending": "PENDING",
    "npm run test:webgpt:review": "PENDING",
    "npm run test:webgpt:production": "PENDING",
    "npm run secret:scan": "PENDING",
    "git diff --check": "PENDING"
  },
  changed_files: [
    "package.json",
    "scripts/r1-7-webgpt-local-bridge-smoke-validation.ts",
    OUTPUT_REPORT_PATH,
    ".agent_board/*"
  ],
  blocked_reason: result === "PASS_WEBGPT_LOCAL_BRIDGE_SMOKE_VALIDATED" ? null : "R1-7 smoke validation found local blockers; inspect local_blockers.",
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
  final_video_artifact_lookup_ok: finalArtifactSmoke.ok,
  source_clip_metadata_ok: reviewMetadataSmoke.ok,
  latest_reports_reaches_r3_9r: latestReportsSmoke.r3_9r_closeout_report_reachable,
  local_blocker_count: blockers.length,
  public_tunnel_started: false,
  network_call_attempted: false,
  provider_called: false,
  env_files_read: false,
  credentials_read: false,
  publish_performed: false,
  release_or_deploy_performed: false
}, null, 2));
if (blockers.length > 0) process.exitCode = 1;
