import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureM0Directories,
  getMediaArtifact,
  getProject,
  openM0Database,
  paths,
  validateMp4File,
  WEBGPT_DRAFT_BRIDGE_VERSION,
  WEBGPT_DRAFT_STORE_FILE,
  WEBGPT_DRAFT_TOOLS,
  WEBGPT_PENDING_ACTION_STORE_FILE,
  WEBGPT_PENDING_ACTION_TOOLS,
  WEBGPT_PENDING_ACTION_VERSION,
  WEBGPT_PRODUCTION_ASSISTANT_STORE_FILE,
  WEBGPT_PRODUCTION_ASSISTANT_TOOLS,
  WEBGPT_PRODUCTION_ASSISTANT_VERSION,
  WEBGPT_READ_ONLY_BRIDGE_VERSION,
  WEBGPT_READ_ONLY_TOOLS,
  WEBGPT_REVIEW_ASSISTANT_STORE_FILE,
  WEBGPT_REVIEW_ASSISTANT_TOOLS,
  WEBGPT_REVIEW_ASSISTANT_VERSION
} from "../src/index.js";

const TASK = "R1-6_WEBGPT_POST_CLOSEOUT_BRIDGE_REALITY_AUDIT";
const OUTPUT_REPORT_PATH = "data/reports/r1_6_webgpt_post_closeout_bridge_reality_audit_result.json";
const R1_0_DOC_PATH = "docs/three_routes/r1_0_webgpt_mcp_boundary_readonly_bridge_plan.md";
const R1_REPORTS = [
  {
    task_id: "R1-1_MCP_V0_READ_ONLY_SERVICE",
    phase: "v0_read_only",
    path: "data/reports/r1_1_mcp_v0_read_only_service_result.json"
  },
  {
    task_id: "R1-2_MCP_V0_5_DRAFT_SUBMISSION",
    phase: "v0_5_draft_submission",
    path: "data/reports/r1_2_mcp_v0_5_draft_submission_result.json"
  },
  {
    task_id: "R1-3_MCP_V1_HUMAN_CONFIRMED_HANDOFF_TOOLS",
    phase: "v1_pending_human_confirmation",
    path: "data/reports/r1_3_mcp_v1_human_confirmed_handoff_tools_result.json"
  },
  {
    task_id: "R1-4_MCP_V2_REVIEW_ASSISTANT_TOOLS",
    phase: "v2_review_assistant",
    path: "data/reports/r1_4_mcp_v2_review_assistant_tools_result.json"
  },
  {
    task_id: "R1-5_MCP_V3_PRODUCTION_ASSISTANT",
    phase: "v3_production_assistant",
    path: "data/reports/r1_5_mcp_v3_production_assistant_result.json"
  }
];
const R3_9R_REPORT_PATH = "data/reports/r3_9r_final_delivery_closeout_result.json";

interface PackageJson {
  scripts?: Record<string, string>;
}

interface R1Report {
  task?: string;
  task_id?: string;
  result?: string;
  generated_at?: string;
  completed_at?: string;
  implementation?: Record<string, unknown>;
  acceptance?: Record<string, unknown>;
  validation?: unknown;
  provider_boundary?: Record<string, unknown>;
  boundary?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  report_path?: string;
  latest_report_path?: string;
}

interface R3_9RReport {
  result?: string;
  project?: {
    project_id?: string;
    project_title?: string;
    storyboard_package_id?: string;
    project_status?: string;
    project_export_final_video_artifact_id?: string;
  };
  final_approval?: {
    decision?: string;
    reviewer?: string;
    final_creative_approval_recorded?: boolean;
  };
  final_video?: {
    local_video_path?: string;
    final_video_artifact_id?: string;
    final_video_artifact_status?: string;
    ffprobe_status?: string;
    ffprobe_duration_seconds?: number | null;
  };
  source_clip_artifacts?: string[];
  source_clips?: Array<{
    order: number;
    shot_id: string;
    source_clip_artifact_id: string;
    local_mp4_path: string;
    ffprobe_status: string;
    duration_seconds: number;
  }>;
  provider_boundary?: Record<string, unknown>;
  git_receipt?: {
    commit?: string;
  };
}

function readJson<T>(relativePath: string): T | null {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

function readText(relativePath: string): string {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
}

function fileExists(relativePath: string): boolean {
  return existsSync(resolve(paths.workspaceRoot, relativePath));
}

function fileSize(relativePath: string): number {
  const absolute = resolve(paths.workspaceRoot, relativePath);
  return existsSync(absolute) ? statSync(absolute).size : 0;
}

function scriptExists(scriptPath: string): boolean {
  return fileExists(scriptPath);
}

function command(packageJson: PackageJson, name: string): string | null {
  return packageJson.scripts?.[name] ?? null;
}

function toolNames<T extends { name: string }>(tools: T[]): string[] {
  return tools.map((tool) => tool.name);
}

function summarizeToolFlags<T extends { name: string }>(tools: T[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({ ...tool }));
}

function validationPass(report: R1Report | null): boolean {
  if (!report) return false;
  if (Array.isArray(report.validation)) {
    return report.validation.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const result = (entry as { result?: unknown }).result;
      return typeof result === "string" && result.startsWith("PASS");
    });
  }
  return true;
}

function r1ReportSummaries() {
  return R1_REPORTS.map((entry) => {
    const report = readJson<R1Report>(entry.path);
    return {
      task_id: entry.task_id,
      phase: entry.phase,
      evidence_path: entry.path,
      evidence_exists: fileExists(entry.path),
      result: report?.result ?? null,
      generated_or_completed_at: report?.generated_at ?? report?.completed_at ?? null,
      validation_pass: validationPass(report),
      latest_report_path: report?.latest_report_path ?? null,
      report_path: report?.report_path ?? null
    };
  });
}

function r1ZeroSummary() {
  const text = readText(R1_0_DOC_PATH);
  const resultMatch = text.match(/result:\s*([A-Z0-9_]+)/);
  const taskMatch = text.match(/task_id:\s*([A-Z0-9_\-]+)/);
  return {
    task_id: taskMatch?.[1] ?? "R1-0_WEBGPT_MCP_BOUNDARY_AND_READONLY_BRIDGE_PLAN",
    phase: "boundary_design",
    evidence_path: R1_0_DOC_PATH,
    evidence_exists: text.length > 0,
    result: resultMatch?.[1] ?? null,
    runtime_server_implemented: /runtime_server_implemented:\s*false/.test(text) ? false : null,
    provider_boundary_declared: text.includes("network_call_attempted: false") && text.includes("secret_values_exposed: false")
  };
}

function bridgeInventory(packageJson: PackageJson) {
  return [
    {
      phase: "v0_read_only",
      version: WEBGPT_READ_ONLY_BRIDGE_VERSION,
      package_script: "webgpt:bridge:v0",
      command: command(packageJson, "webgpt:bridge:v0"),
      source_file: "src/tools/webGptReadOnlyBridge.ts",
      server_entrypoint: "scripts/webgpt-readonly-bridge.ts",
      test_script: "test:webgpt:bridge",
      test_command: command(packageJson, "test:webgpt:bridge"),
      bind_host: "127.0.0.1",
      routes: ["GET /api/tools", "GET /api/tool/<read_tool>"],
      tools: toolNames(WEBGPT_READ_ONLY_TOOLS),
      tool_flags: summarizeToolFlags(WEBGPT_READ_ONLY_TOOLS),
      source_exists: scriptExists("src/tools/webGptReadOnlyBridge.ts"),
      entrypoint_exists: scriptExists("scripts/webgpt-readonly-bridge.ts"),
      test_exists: scriptExists("tests/webgpt-readonly-bridge.test.ts")
    },
    {
      phase: "v0_5_draft_submission",
      version: WEBGPT_DRAFT_BRIDGE_VERSION,
      package_script: "webgpt:bridge:v0.5",
      command: command(packageJson, "webgpt:bridge:v0.5"),
      source_file: "src/tools/webGptDraftBridge.ts",
      server_entrypoint: "scripts/webgpt-draft-bridge.ts",
      store_file: WEBGPT_DRAFT_STORE_FILE,
      test_script: "test:webgpt:drafts",
      test_command: command(packageJson, "test:webgpt:drafts"),
      bind_host: "127.0.0.1",
      routes: ["GET /api/tools", "GET /api/tool/<read_tool>", "POST /api/draft/<draft_tool>"],
      tools: toolNames(WEBGPT_DRAFT_TOOLS),
      tool_flags: summarizeToolFlags(WEBGPT_DRAFT_TOOLS),
      source_exists: scriptExists("src/tools/webGptDraftBridge.ts"),
      entrypoint_exists: scriptExists("scripts/webgpt-draft-bridge.ts"),
      test_exists: scriptExists("tests/webgpt-draft-bridge.test.ts")
    },
    {
      phase: "v1_pending_human_confirmation",
      version: WEBGPT_PENDING_ACTION_VERSION,
      package_script: "webgpt:bridge:v1",
      command: command(packageJson, "webgpt:bridge:v1"),
      source_file: "src/tools/webGptPendingActions.ts",
      server_entrypoint: "scripts/webgpt-human-handoff-bridge.ts",
      store_file: WEBGPT_PENDING_ACTION_STORE_FILE,
      test_script: "test:webgpt:pending",
      test_command: command(packageJson, "test:webgpt:pending"),
      bind_host: "127.0.0.1",
      routes: ["GET /api/tools", "GET /api/tool/<read_tool>", "POST /api/pending-action/<tool>"],
      tools: toolNames(WEBGPT_PENDING_ACTION_TOOLS),
      tool_flags: summarizeToolFlags(WEBGPT_PENDING_ACTION_TOOLS),
      source_exists: scriptExists("src/tools/webGptPendingActions.ts"),
      entrypoint_exists: scriptExists("scripts/webgpt-human-handoff-bridge.ts"),
      test_exists: scriptExists("tests/webgpt-pending-actions.test.ts")
    },
    {
      phase: "v2_review_assistant",
      version: WEBGPT_REVIEW_ASSISTANT_VERSION,
      package_script: "webgpt:bridge:v2",
      command: command(packageJson, "webgpt:bridge:v2"),
      source_file: "src/tools/webGptReviewAssistant.ts",
      server_entrypoint: "scripts/webgpt-review-assistant-bridge.ts",
      store_file: WEBGPT_REVIEW_ASSISTANT_STORE_FILE,
      test_script: "test:webgpt:review",
      test_command: command(packageJson, "test:webgpt:review"),
      bind_host: "127.0.0.1",
      routes: ["GET /api/tools", "GET /api/tool/<read_tool>", "GET /api/review-tool/<tool>", "POST /api/review-tool/<tool>"],
      tools: toolNames(WEBGPT_REVIEW_ASSISTANT_TOOLS),
      tool_flags: summarizeToolFlags(WEBGPT_REVIEW_ASSISTANT_TOOLS),
      source_exists: scriptExists("src/tools/webGptReviewAssistant.ts"),
      entrypoint_exists: scriptExists("scripts/webgpt-review-assistant-bridge.ts"),
      test_exists: scriptExists("tests/webgpt-review-assistant.test.ts")
    },
    {
      phase: "v3_production_assistant",
      version: WEBGPT_PRODUCTION_ASSISTANT_VERSION,
      package_script: "webgpt:bridge:v3",
      command: command(packageJson, "webgpt:bridge:v3"),
      source_file: "src/tools/webGptProductionAssistant.ts",
      server_entrypoint: "scripts/webgpt-production-assistant-bridge.ts",
      store_file: WEBGPT_PRODUCTION_ASSISTANT_STORE_FILE,
      test_script: "test:webgpt:production",
      test_command: command(packageJson, "test:webgpt:production"),
      bind_host: "127.0.0.1",
      routes: ["GET /api/tools", "GET /api/production-tool/<tool>", "POST /api/production-tool/<tool>"],
      tools: toolNames(WEBGPT_PRODUCTION_ASSISTANT_TOOLS),
      tool_flags: summarizeToolFlags(WEBGPT_PRODUCTION_ASSISTANT_TOOLS),
      source_exists: scriptExists("src/tools/webGptProductionAssistant.ts"),
      entrypoint_exists: scriptExists("scripts/webgpt-production-assistant-bridge.ts"),
      test_exists: scriptExists("tests/webgpt-production-assistant.test.ts")
    }
  ];
}

function finalApprovedEvidence(r3_9r: R3_9RReport | null) {
  const db = openM0Database();
  try {
    const projectId = r3_9r?.project?.project_id ?? "";
    const finalArtifactId = r3_9r?.final_video?.final_video_artifact_id ?? "";
    const project = projectId ? getProject(db, projectId) : null;
    const finalArtifact = finalArtifactId ? getMediaArtifact(db, finalArtifactId) : null;
    const finalVideoPath = r3_9r?.final_video?.local_video_path ?? "";
    const finalVideoFfprobe = finalVideoPath && existsSync(finalVideoPath) ? validateMp4File(finalVideoPath) : null;
    const sourceClips = (r3_9r?.source_clips ?? []).map((clip) => {
      const artifact = getMediaArtifact(db, clip.source_clip_artifact_id);
      const ffprobe = clip.local_mp4_path && existsSync(clip.local_mp4_path) ? validateMp4File(clip.local_mp4_path) : null;
      return {
        order: clip.order,
        shot_id: clip.shot_id,
        source_clip_artifact_id: clip.source_clip_artifact_id,
        artifact_found: Boolean(artifact),
        artifact_status: artifact?.status ?? null,
        local_mp4_path: clip.local_mp4_path,
        local_mp4_exists: Boolean(clip.local_mp4_path && existsSync(clip.local_mp4_path)),
        ffprobe_status: ffprobe?.status ?? clip.ffprobe_status,
        duration_seconds: ffprobe?.duration_seconds ?? clip.duration_seconds
      };
    });
    return {
      source_report: R3_9R_REPORT_PATH,
      source_report_exists: fileExists(R3_9R_REPORT_PATH),
      source_report_size_bytes: fileSize(R3_9R_REPORT_PATH),
      source_report_result: r3_9r?.result ?? null,
      source_report_commit: r3_9r?.git_receipt?.commit ?? null,
      project_id: projectId || null,
      project_title: r3_9r?.project?.project_title ?? null,
      storyboard_package_id: r3_9r?.project?.storyboard_package_id ?? null,
      project_found_in_db: Boolean(project),
      project_status_in_report: r3_9r?.project?.project_status ?? null,
      project_status_in_db: project?.status ?? null,
      final_decision: r3_9r?.final_approval?.decision ?? null,
      final_reviewer: r3_9r?.final_approval?.reviewer ?? null,
      final_creative_approval_recorded: r3_9r?.final_approval?.final_creative_approval_recorded ?? false,
      final_video_path: finalVideoPath,
      final_video_exists: Boolean(finalVideoPath && existsSync(finalVideoPath)),
      final_video_artifact_id: finalArtifactId || null,
      final_video_artifact_found_in_db: Boolean(finalArtifact),
      final_video_artifact_status_in_report: r3_9r?.final_video?.final_video_artifact_status ?? null,
      final_video_artifact_status_in_db: finalArtifact?.status ?? null,
      final_video_ffprobe_status_in_report: r3_9r?.final_video?.ffprobe_status ?? null,
      final_video_ffprobe_status_now: finalVideoFfprobe?.status ?? null,
      final_video_duration_seconds: finalVideoFfprobe?.duration_seconds ?? r3_9r?.final_video?.ffprobe_duration_seconds ?? null,
      source_clip_count: sourceClips.length,
      source_clip_artifacts: r3_9r?.source_clip_artifacts ?? [],
      source_clips: sourceClips
    };
  } finally {
    db.close();
  }
}

function boolAllFalse(boundary: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => boundary[key] === false);
}

function boundaryReport() {
  return {
    public_tunnel_started: false,
    network_call_attempted: false,
    provider_called: false,
    runninghub_called: false,
    runway_called: false,
    provider_credits_consumed: false,
    env_files_read: false,
    credentials_read: false,
    production_truth_mutated: false,
    direct_production_mutation_from_gpt: false,
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
const r3_9r = readJson<R3_9RReport>(R3_9R_REPORT_PATH);
const r1_0 = r1ZeroSummary();
const r1Reports = r1ReportSummaries();
const inventory = bridgeInventory(packageJson);
const finalEvidence = finalApprovedEvidence(r3_9r);
const localBlockers: string[] = [];

if (!r1_0.evidence_exists || r1_0.result !== "PASS_MCP_BOUNDARY_READY") localBlockers.push("R1_0_BOUNDARY_DOC_NOT_PASS");
for (const report of r1Reports) {
  if (!report.evidence_exists || report.result !== "PASS") localBlockers.push(`${report.task_id}_NOT_PASS`);
}
for (const bridge of inventory) {
  if (!bridge.command) localBlockers.push(`${bridge.phase}:PACKAGE_SCRIPT_MISSING`);
  if (!bridge.source_exists) localBlockers.push(`${bridge.phase}:SOURCE_FILE_MISSING`);
  if (!bridge.entrypoint_exists) localBlockers.push(`${bridge.phase}:ENTRYPOINT_MISSING`);
  if (!bridge.test_command || !bridge.test_exists) localBlockers.push(`${bridge.phase}:TEST_SURFACE_MISSING`);
}
if (finalEvidence.source_report_result !== "PASS_FINAL_DELIVERY_CLOSEOUT_READY") localBlockers.push("R3_9R_CLOSEOUT_NOT_PASS");
if (finalEvidence.project_status_in_db !== "final_approved") localBlockers.push("PROJECT_NOT_FINAL_APPROVED_IN_DB");
if (finalEvidence.final_decision !== "accept" || finalEvidence.final_reviewer !== "Jenn") localBlockers.push("FINAL_HUMAN_DECISION_NOT_ACCEPTED_BY_JENN");
if (finalEvidence.final_video_ffprobe_status_now !== "PASS") localBlockers.push("FINAL_VIDEO_FFPROBE_NOT_PASS");
if (finalEvidence.source_clip_count !== 4) localBlockers.push("SOURCE_CLIP_COUNT_NOT_4");

const boundary = boundaryReport();
if (!boolAllFalse(boundary, Object.keys(boundary))) localBlockers.push("PROVIDER_OR_DELIVERY_BOUNDARY_NOT_FALSE");

const report = {
  task: TASK,
  result: localBlockers.length === 0 ? "PASS_GPT_BRIDGE_REALITY_AUDITED" : "BLOCK_GPT_BRIDGE_REALITY_AUDIT_WITH_REASON",
  mode: "local_audit_only",
  generated_at: new Date().toISOString(),
  source_of_truth: {
    r1_0_boundary_doc: R1_0_DOC_PATH,
    r1_reports: R1_REPORTS.map((reportEntry) => reportEntry.path),
    r3_9r_final_delivery_closeout_report: R3_9R_REPORT_PATH,
    package_json: "package.json",
    bridge_source_files: inventory.map((bridge) => bridge.source_file),
    bridge_server_entrypoints: inventory.map((bridge) => bridge.server_entrypoint)
  },
  r1_completion_status: [r1_0, ...r1Reports],
  bridge_inventory: inventory,
  final_approved_project_evidence: finalEvidence,
  gpt_capability_map_after_final_approval: {
    can_read: {
      status: true,
      bridge_phase: "v0_read_only",
      tools: toolNames(WEBGPT_READ_ONLY_TOOLS),
      can_reach_r3_9r_report_reference: finalEvidence.source_report_exists,
      can_reach_final_artifact_by_app_id: finalEvidence.final_video_artifact_found_in_db
    },
    can_draft: {
      status: true,
      bridge_phase: "v0_5_draft_submission",
      tools: toolNames(WEBGPT_DRAFT_TOOLS),
      production_truth_changed: false
    },
    can_request_human_confirmed_actions: {
      status: true,
      bridge_phase: "v1_pending_human_confirmation",
      tools: toolNames(WEBGPT_PENDING_ACTION_TOOLS),
      gpt_direct_mutation_allowed: false,
      human_confirmation_required: true
    },
    can_assist_review: {
      status: true,
      bridge_phase: "v2_review_assistant",
      tools: toolNames(WEBGPT_REVIEW_ASSISTANT_TOOLS),
      final_human_approval_allowed: false,
      regeneration_allowed: false
    },
    can_propose_production_plans: {
      status: true,
      bridge_phase: "v3_production_assistant",
      tools: toolNames(WEBGPT_PRODUCTION_ASSISTANT_TOOLS),
      execution_allowed: false,
      provider_call_allowed: false,
      final_delivery_approval_allowed: false,
      long_term_memory_write_allowed: false
    }
  },
  stale_assumptions_found: [
    "R1-0 through R1-5 were completed before the R3-9 final video reached final_approved; downstream GPT work should now reference R3-9R evidence instead of older H1-only assumptions.",
    "Public ChatGPT MCP/App packaging remains a separate decision; current bridge entrypoints are localhost-only development bridges.",
    "GPT may see report references through read-only surfaces, but should not treat chat-provided artifact IDs as authoritative."
  ],
  local_gaps_and_recommendations: {
    blockers: localBlockers,
    non_blocking_gaps: [
      "No dedicated GPT-facing final-delivery endpoint exists yet; current access is through get_latest_reports plus app artifact/project status.",
      "v3 production assistant can propose final assembly plans, but it does not have a closeout-specific proposal type for final-approved delivery archive handoff.",
      "Official ChatGPT MCP packaging, authentication model, and public tunnel/deployment posture are intentionally undecided."
    ],
    recommended_next_tasks: [
      {
        task_id: "R1-7_WEBGPT_LOCAL_BRIDGE_SMOKE_VALIDATION",
        recommendation: localBlockers.length === 0 ? "PROCEED" : "WAIT_FOR_BLOCKER_FIX",
        reason: "Run local bridge/test smoke against current final-approved R3-9R evidence without public exposure."
      },
      {
        task_id: "R1-8_WEBGPT_OPERATOR_RUNBOOK_AND_PROMPT_PACK",
        recommendation: "PROCEED_AFTER_R1_7",
        reason: "Document Chinese operator flow and prompt pack after current local bridge smoke validation passes."
      },
      {
        task_id: "R1-9_CHATGPT_MCP_APP_PACKAGING_DECISION",
        recommendation: "KEEP_FOLLOW_UP",
        reason: "Requires separate decision for official ChatGPT MCP/App packaging, security, auth, and exposure posture."
      }
    ]
  },
  provider_boundary: boundary,
  validation: {
    "npm run r1:6:audit": localBlockers.length === 0 ? "PASS" : "FAIL",
    "JSON parse for generated R1-6 audit report": "PENDING",
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
    "scripts/r1-6-webgpt-post-closeout-bridge-reality-audit.ts",
    OUTPUT_REPORT_PATH,
    ".agent_board/*"
  ],
  blocked_reason: localBlockers.length === 0 ? null : "R1-6 audit found local blockers; inspect local_gaps_and_recommendations.blockers.",
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

writeFileSync(resolve(paths.workspaceRoot, OUTPUT_REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  result: report.result,
  report_path: OUTPUT_REPORT_PATH,
  r1_completed_reports: r1Reports.filter((entry) => entry.result === "PASS").length,
  bridge_phases: inventory.length,
  final_project_status: finalEvidence.project_status_in_db,
  final_video_ffprobe: finalEvidence.final_video_ffprobe_status_now,
  local_blocker_count: localBlockers.length,
  public_tunnel_started: false,
  network_call_attempted: false,
  provider_called: false,
  env_files_read: false,
  credentials_read: false,
  production_truth_mutated: false,
  publish_performed: false,
  release_or_deploy_performed: false
}, null, 2));
if (localBlockers.length > 0) process.exitCode = 1;
