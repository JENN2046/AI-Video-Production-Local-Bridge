import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { ensureM0Directories, paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getMediaArtifact, verifyMediaArtifactBytes } from "./mediaArtifacts.js";
import { listWorkbenchPendingActionRecords, saveWorkbenchPendingActionRecord } from "./workbenchInboxStore.js";
import {
  freezeH1StoryboardPackage,
  H1_PROVIDER_BOUNDARY,
  linkH1ArtifactToShot,
  loadH1WorkbenchState,
  prepareH1StoryboardPackageProject,
  registerH1ApprovedKeyframe,
  saveH1WorkbenchState,
  scanH1Imports,
  validateH1StoryboardPackage
} from "./h1Workbench.js";

export const WEBGPT_PENDING_ACTION_VERSION = "webgpt-pending-actions-v1";
export const WEBGPT_PENDING_ACTION_STORE_FILE = "data/webgpt/pending_actions.json";
export const WEBGPT_PENDING_ACTION_REPORT_LATEST = "data/reports/r1_3_pending_action_result.json";

export type WebGptPendingActionToolName =
  | "request_register_media_artifact_from_import"
  | "request_link_artifact_to_shot"
  | "request_validate_storyboard_package"
  | "request_import_storyboard_package";

export interface WebGptPendingActionToolDefinition {
  name: WebGptPendingActionToolName;
  description: string;
  input_schema: Record<string, unknown>;
  mode: "PENDING_HUMAN_CONFIRMATION";
  pending_action_write_allowed: true;
  direct_mutation_allowed: false;
  human_confirmation_required: true;
  provider_call_allowed: false;
  secret_read_allowed: false;
  shell_allowed: false;
}

export interface WebGptPendingActionRecord {
  action_id: string;
  tool: WebGptPendingActionToolName;
  status: "pending" | "executed" | "rejected" | "failed";
  created_at: string;
  updated_at: string;
  source: "webgpt_bridge_v1";
  payload: Record<string, unknown>;
  validation: {
    ok: true;
    blockers: [];
  };
  human_confirmation: {
    required: true;
    confirmed: boolean;
    rejected: boolean;
    confirmed_at: string;
    rejected_at: string;
    rejected_reason: string;
  };
  execution: {
    attempted: boolean;
    ok: boolean | null;
    executed_at: string;
    report_path: string;
    result: unknown;
    error: { code: string; message: string } | null;
  };
  production_effects: {
    app_ready_truth_changed: boolean;
    media_artifact_registered: boolean;
    artifact_linked_to_shot: boolean;
    package_validated: boolean;
    package_frozen: boolean;
    provider_call_attempted: false;
    source_asset_overwritten: false;
  };
}

export interface WebGptPendingActionStore {
  version: "webgpt-pending-action-store-v1";
  updated_at: string;
  actions: WebGptPendingActionRecord[];
}

export type WebGptPendingActionToolResult =
  | {
      ok: true;
      tool: WebGptPendingActionToolName;
      mode: "PENDING_HUMAN_CONFIRMATION";
      pending_action_write_allowed: true;
      direct_mutation_allowed: false;
      action: WebGptPendingActionRecord;
      provider_boundary: typeof H1_PROVIDER_BOUNDARY;
    }
  | {
      ok: false;
      tool: WebGptPendingActionToolName | "unknown";
      mode: "PENDING_HUMAN_CONFIRMATION";
      pending_action_write_allowed: false;
      direct_mutation_allowed: false;
      error: {
        code: string;
        message: string;
      };
      provider_boundary: typeof H1_PROVIDER_BOUNDARY;
    };

export interface WebGptPendingActionWorkbenchSummary {
  bridge_version: typeof WEBGPT_PENDING_ACTION_VERSION;
  store_file: typeof WEBGPT_PENDING_ACTION_STORE_FILE;
  mode: "PENDING_ACTION_REVIEW";
  actions_total: number;
  pending_count: number;
  actions: WebGptPendingActionRecord[];
  provider_boundary: typeof H1_PROVIDER_BOUNDARY;
}

export const WEBGPT_PENDING_ACTION_TOOLS: WebGptPendingActionToolDefinition[] = [
  {
    name: "request_register_media_artifact_from_import",
    description: "Request that a human confirms registering an app-screened data/imports image as a Media Artifact.",
    input_schema: { import_filename: "required basename from data/imports" },
    mode: "PENDING_HUMAN_CONFIRMATION",
    pending_action_write_allowed: true,
    direct_mutation_allowed: false,
    human_confirmation_required: true,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "request_link_artifact_to_shot",
    description: "Request that a human confirms linking a real storyboard_image artifact to an existing shot.",
    input_schema: { shot_id: "required existing app shot id", artifact_id: "required active storyboard_image artifact id" },
    mode: "PENDING_HUMAN_CONFIRMATION",
    pending_action_write_allowed: true,
    direct_mutation_allowed: false,
    human_confirmation_required: true,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "request_validate_storyboard_package",
    description: "Request that a human confirms running app-side storyboard package validation.",
    input_schema: { notes: "optional request notes" },
    mode: "PENDING_HUMAN_CONFIRMATION",
    pending_action_write_allowed: true,
    direct_mutation_allowed: false,
    human_confirmation_required: true,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "request_import_storyboard_package",
    description: "Request that a human confirms importing/freezing the current app-ready storyboard package.",
    input_schema: { reason: "required request reason" },
    mode: "PENDING_HUMAN_CONFIRMATION",
    pending_action_write_allowed: true,
    direct_mutation_allowed: false,
    human_confirmation_required: true,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  }
];

function now(): string {
  return new Date().toISOString();
}

export function loadWebGptPendingActionStore(db = openM0Database()): WebGptPendingActionStore {
  const actions = listWorkbenchPendingActionRecords(db) as unknown as WebGptPendingActionRecord[];
  return { version: "webgpt-pending-action-store-v1", updated_at: actions.at(-1)?.updated_at ?? now(), actions };
}

function saveWebGptPendingActionStore(store: WebGptPendingActionStore, db = openM0Database()): WebGptPendingActionStore {
  const next = { ...store, updated_at: now() };
  for (const action of next.actions) saveWorkbenchPendingActionRecord(action as unknown as Record<string, unknown>, db);
  return next;
}

function fail(tool: WebGptPendingActionToolName | "unknown", code: string, message: string): WebGptPendingActionToolResult {
  return {
    ok: false,
    tool,
    mode: "PENDING_HUMAN_CONFIRMATION",
    pending_action_write_allowed: false,
    direct_mutation_allowed: false,
    error: { code, message },
    provider_boundary: H1_PROVIDER_BOUNDARY
  };
}

function ok(tool: WebGptPendingActionToolName, action: WebGptPendingActionRecord): WebGptPendingActionToolResult {
  return {
    ok: true,
    tool,
    mode: "PENDING_HUMAN_CONFIRMATION",
    pending_action_write_allowed: true,
    direct_mutation_allowed: false,
    action,
    provider_boundary: H1_PROVIDER_BOUNDARY
  };
}

function isFakeOrPendingId(value: string): boolean {
  const upper = value.toUpperCase();
  return upper.startsWith("PENDING") || upper.includes("PENDING_") || upper.includes("FAKE") || upper.includes("PLACEHOLDER");
}

function plainId(value: string): boolean {
  return value !== "" && value === basename(value) && !value.includes("/") && !value.includes("\\") && !isFakeOrPendingId(value);
}

function safePayload(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function currentShotIds(db: M0Database): Set<string> {
  const rows = db.prepare("SELECT shot_id FROM shots").all() as Array<{ shot_id: string }>;
  return new Set(rows.map((shot) => shot.shot_id));
}

function validateExistingShotId(tool: WebGptPendingActionToolName, input: Record<string, unknown>, db: M0Database): WebGptPendingActionToolResult | null {
  const shotId = typeof input.shot_id === "string" ? input.shot_id.trim() : "";
  if (!shotId) return fail(tool, "MISSING_REQUIRED_FIELD", "shot_id is required.");
  if (!plainId(shotId)) return fail(tool, "INVALID_APP_ID", "Only real app shot_id values are accepted.");
  if (!currentShotIds(db).has(shotId)) return fail(tool, "SHOT_NOT_FOUND", `Shot not found in current workbench state: ${shotId}`);
  return null;
}

function validateArtifactId(tool: WebGptPendingActionToolName, input: Record<string, unknown>, db: M0Database): WebGptPendingActionToolResult | null {
  const artifactId = typeof input.artifact_id === "string" ? input.artifact_id.trim() : "";
  if (!artifactId) return fail(tool, "MISSING_REQUIRED_FIELD", "artifact_id is required.");
  if (!plainId(artifactId)) return fail(tool, "INVALID_APP_ID", "Only real app artifact_id values are accepted.");
  const artifact = getMediaArtifact(db, artifactId);
  if (!artifact) return fail(tool, "ARTIFACT_NOT_FOUND", `Artifact not found: ${artifactId}`);
  if (artifact.artifact_type !== "image" || artifact.role !== "storyboard_image" || artifact.status !== "active") {
    return fail(tool, "ARTIFACT_NOT_LINKABLE", "Artifact must be an active storyboard_image image artifact.");
  }
  const integrity = verifyMediaArtifactBytes(db, artifact);
  if (!integrity.ok) return fail(tool, integrity.error.code, integrity.error.message);
  return null;
}

function validateImportFilename(tool: WebGptPendingActionToolName, input: Record<string, unknown>, db: M0Database): WebGptPendingActionToolResult | null {
  const filename = typeof input.import_filename === "string" ? input.import_filename.trim() : "";
  if (!filename) return fail(tool, "MISSING_REQUIRED_FIELD", "import_filename is required.");
  if (filename !== basename(filename) || filename.includes("/") || filename.includes("\\") || isFakeOrPendingId(filename)) {
    return fail(tool, "INVALID_IMPORT_FILENAME", "Only real data/imports basenames are accepted.");
  }
  const candidate = scanH1Imports(db).find((item) => item.filename === filename);
  if (!candidate) return fail(tool, "IMPORT_NOT_FOUND", `Import candidate not found: ${filename}`);
  if (candidate.blockers.length > 0) return fail(tool, "IMPORT_BLOCKED", `Import candidate has blockers: ${candidate.blockers.join(",")}`);
  return null;
}

function appendAction(tool: WebGptPendingActionToolName, input: Record<string, unknown>, db: M0Database): WebGptPendingActionRecord {
  const createdAt = now();
  const action: WebGptPendingActionRecord = {
    action_id: `webgpt_action_${randomUUID()}`,
    tool,
    status: "pending",
    created_at: createdAt,
    updated_at: createdAt,
    source: "webgpt_bridge_v1",
    payload: safePayload(input),
    validation: { ok: true, blockers: [] },
    human_confirmation: {
      required: true,
      confirmed: false,
      rejected: false,
      confirmed_at: "",
      rejected_at: "",
      rejected_reason: ""
    },
    execution: {
      attempted: false,
      ok: null,
      executed_at: "",
      report_path: "",
      result: null,
      error: null
    },
    production_effects: {
      app_ready_truth_changed: false,
      media_artifact_registered: false,
      artifact_linked_to_shot: false,
      package_validated: false,
      package_frozen: false,
      provider_call_attempted: false,
      source_asset_overwritten: false
    }
  };
  return saveWorkbenchPendingActionRecord(action as unknown as Record<string, unknown>, db) as unknown as WebGptPendingActionRecord;
}

export function executeWebGptPendingActionTool(
  tool: WebGptPendingActionToolName,
  input: Record<string, unknown> = {},
  db = openM0Database()
): WebGptPendingActionToolResult {
  if (!WEBGPT_PENDING_ACTION_TOOLS.some((definition) => definition.name === tool)) {
    return fail("unknown", "TOOL_NOT_FOUND", `Pending action tool not found: ${tool}`);
  }

  if (tool === "request_register_media_artifact_from_import") {
    const importError = validateImportFilename(tool, input, db);
    if (importError) return importError;
    return ok(tool, appendAction(tool, input, db));
  }

  if (tool === "request_link_artifact_to_shot") {
    const shotError = validateExistingShotId(tool, input, db);
    if (shotError) return shotError;
    const artifactError = validateArtifactId(tool, input, db);
    if (artifactError) return artifactError;
    return ok(tool, appendAction(tool, input, db));
  }

  if (tool === "request_validate_storyboard_package") {
    return ok(tool, appendAction(tool, input, db));
  }

  if (tool === "request_import_storyboard_package") {
    if (typeof input.reason !== "string" || input.reason.trim() === "") return fail(tool, "MISSING_REQUIRED_FIELD", "reason is required.");
    return ok(tool, appendAction(tool, input, db));
  }

  return fail("unknown", "TOOL_NOT_FOUND", `Pending action tool not found: ${tool}`);
}

function updateAction(action: WebGptPendingActionRecord, db: M0Database): WebGptPendingActionRecord {
  const store = loadWebGptPendingActionStore(db);
  const actions = store.actions.map((candidate) => (candidate.action_id === action.action_id ? action : candidate));
  saveWebGptPendingActionStore({ ...store, actions }, db);
  return action;
}

function findAction(actionId: string, db: M0Database): WebGptPendingActionRecord | null {
  if (!plainId(actionId) || !actionId.startsWith("webgpt_action_")) return null;
  return loadWebGptPendingActionStore(db).actions.find((action) => action.action_id === actionId) ?? null;
}

function writePendingActionReport(action: WebGptPendingActionRecord): string {
  ensureM0Directories();
  const runId = randomUUID();
  const reportPath = join(paths.reportsRoot, `r1_3_pending_action_result_${runId}.json`);
  const relativeReportPath = `data/reports/r1_3_pending_action_result_${runId}.json`;
  const payload = {
    task_id: "R1-3_MCP_V1_HUMAN_CONFIRMED_HANDOFF_TOOLS",
    result: action.execution.ok === true || action.status === "rejected" ? "PASS" : "BLOCK_WITH_REASON",
    generated_at: now(),
    action,
    provider_boundary: H1_PROVIDER_BOUNDARY,
    delivery: {
      push: false,
      tag: false,
      release: false,
      deploy: false
    }
  };
  writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  writeFileSync(join(paths.reportsRoot, "r1_3_pending_action_result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return relativeReportPath;
}

function executeConfirmedAction(action: WebGptPendingActionRecord, db: M0Database): { ok: boolean; result: unknown; error: { code: string; message: string } | null; effects: Partial<WebGptPendingActionRecord["production_effects"]> } {
  if (action.tool === "request_register_media_artifact_from_import") {
    const result = registerH1ApprovedKeyframe(
      {
        import_filename: String(action.payload.import_filename ?? ""),
        review_status: "approved_for_media_artifact_handoff",
        write_report: false
      },
      db
    );
    if (!result.ok) return { ok: false, result: null, error: result.error, effects: {} };
    return { ok: true, result: { artifact: result.value.artifact, report: result.value.report }, error: null, effects: { app_ready_truth_changed: true, media_artifact_registered: true } };
  }

  if (action.tool === "request_link_artifact_to_shot") {
    const state = loadH1WorkbenchState();
    const result = linkH1ArtifactToShot(
      state,
      {
        shot_id: String(action.payload.shot_id ?? ""),
        artifact_id: String(action.payload.artifact_id ?? "")
      },
      db
    );
    if (!result.ok) return { ok: false, result: null, error: result.error, effects: {} };
    saveH1WorkbenchState(result.value);
    return { ok: true, result: { state: result.value }, error: null, effects: { app_ready_truth_changed: true, artifact_linked_to_shot: true } };
  }

  if (action.tool === "request_validate_storyboard_package") {
    const result = validateH1StoryboardPackage(loadH1WorkbenchState(), db);
    if (!result.ok) return { ok: false, result: null, error: result.error, effects: {} };
    return { ok: true, result: { validation: result.value.validation }, error: null, effects: { package_validated: true } };
  }

  if (action.tool === "request_import_storyboard_package") {
    const prepared = prepareH1StoryboardPackageProject(loadH1WorkbenchState(), db);
    if (!prepared.ok) return { ok: false, result: null, error: prepared.error, effects: {} };
    const validation = validateH1StoryboardPackage(prepared.value.state, db);
    if (!validation.ok) return { ok: false, result: null, error: validation.error, effects: {} };
    const result = freezeH1StoryboardPackage(validation.value.state, { human_confirmation: true, write_report: false }, db);
    if (!result.ok) return { ok: false, result: null, error: result.error, effects: {} };
    saveH1WorkbenchState(result.value.state);
    return { ok: true, result: { report: result.value.report, state: result.value.state }, error: null, effects: { app_ready_truth_changed: true, package_validated: true, package_frozen: true } };
  }

  return { ok: false, result: null, error: { code: "TOOL_NOT_FOUND", message: `Pending action tool not found: ${action.tool}` }, effects: {} };
}

export function confirmWebGptPendingAction(
  input: { action_id: string; human_confirmation: boolean },
  db = openM0Database()
): { ok: true; action: WebGptPendingActionRecord } | { ok: false; error: { code: string; message: string } } {
  if (input.human_confirmation !== true) return { ok: false, error: { code: "HUMAN_CONFIRMATION_REQUIRED", message: "Human confirmation is required before executing a pending action." } };
  const action = findAction(input.action_id, db);
  if (!action) return { ok: false, error: { code: "ACTION_NOT_FOUND", message: `Pending action not found: ${input.action_id}` } };
  if (action.status !== "pending") return { ok: false, error: { code: "ACTION_NOT_PENDING", message: `Action is not pending: ${action.status}` } };

  const executedAt = now();
  const execution = executeConfirmedAction(action, db);
  const next: WebGptPendingActionRecord = {
    ...action,
    status: execution.ok ? "executed" : "failed",
    updated_at: executedAt,
    human_confirmation: {
      ...action.human_confirmation,
      confirmed: true,
      confirmed_at: executedAt
    },
    execution: {
      attempted: true,
      ok: execution.ok,
      executed_at: executedAt,
      report_path: "",
      result: execution.result,
      error: execution.error
    },
    production_effects: {
      ...action.production_effects,
      ...execution.effects,
      provider_call_attempted: false,
      source_asset_overwritten: false
    }
  };
  next.execution.report_path = writePendingActionReport(next);
  return { ok: true, action: updateAction(next, db) };
}

export function rejectWebGptPendingAction(input: { action_id: string; reason: string }, db = openM0Database()): { ok: true; action: WebGptPendingActionRecord } | { ok: false; error: { code: string; message: string } } {
  const action = findAction(input.action_id, db);
  if (!action) return { ok: false, error: { code: "ACTION_NOT_FOUND", message: `Pending action not found: ${input.action_id}` } };
  if (action.status !== "pending") return { ok: false, error: { code: "ACTION_NOT_PENDING", message: `Action is not pending: ${action.status}` } };
  const rejectedAt = now();
  const next: WebGptPendingActionRecord = {
    ...action,
    status: "rejected",
    updated_at: rejectedAt,
    human_confirmation: {
      ...action.human_confirmation,
      rejected: true,
      rejected_at: rejectedAt,
      rejected_reason: input.reason
    }
  };
  next.execution.report_path = writePendingActionReport(next);
  return { ok: true, action: updateAction(next, db) };
}

export function webGptPendingActionWorkbenchSummary(db = openM0Database()): WebGptPendingActionWorkbenchSummary {
  const actions = [...loadWebGptPendingActionStore(db).actions].reverse();
  return {
    bridge_version: WEBGPT_PENDING_ACTION_VERSION,
    store_file: WEBGPT_PENDING_ACTION_STORE_FILE,
    mode: "PENDING_ACTION_REVIEW",
    actions_total: actions.length,
    pending_count: actions.filter((action) => action.status === "pending").length,
    actions: actions.slice(0, 100),
    provider_boundary: H1_PROVIDER_BOUNDARY
  };
}
