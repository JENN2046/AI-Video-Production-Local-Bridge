import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getMediaArtifact } from "./mediaArtifacts.js";
import { defaultH1WorkbenchState, H1_PROVIDER_BOUNDARY, H1_STATE_FILE, type H1WorkbenchState } from "./h1Workbench.js";

export const WEBGPT_DRAFT_BRIDGE_VERSION = "webgpt-draft-v0.5";
export const WEBGPT_DRAFT_STORE_FILE = "data/webgpt/draft_submissions.json";

export type WebGptDraftToolName =
  | "submit_shot_script_draft"
  | "submit_storyboard_package_draft"
  | "propose_artifact_link"
  | "propose_package_validation"
  | "propose_freeze_request";

export interface WebGptDraftToolDefinition {
  name: WebGptDraftToolName;
  description: string;
  input_schema: Record<string, unknown>;
  mode: "DRAFT_SUBMISSION";
  draft_write_allowed: true;
  production_mutation_allowed: false;
  direct_freeze_allowed: false;
  direct_artifact_registration_allowed: false;
  provider_call_allowed: false;
  secret_read_allowed: false;
  shell_allowed: false;
}

export interface WebGptDraftRecord {
  draft_id: string;
  tool: WebGptDraftToolName;
  status: "submitted";
  created_at: string;
  updated_at: string;
  source: "webgpt_bridge_v0_5";
  payload: Record<string, unknown>;
  validation: {
    ok: true;
    blockers: [];
  };
  human_review: {
    required_before_app_mutation: true;
    visible_in_h1_workbench: true;
  };
  production_effects: {
    app_ready_truth_changed: false;
    media_artifact_registered: false;
    artifact_linked_to_shot: false;
    package_validated: false;
    package_frozen: false;
    provider_call_attempted: false;
    source_asset_overwritten: false;
  };
}

export interface WebGptDraftStore {
  version: "webgpt-draft-store-v0.5";
  updated_at: string;
  drafts: WebGptDraftRecord[];
}

export type WebGptDraftToolResult =
  | {
      ok: true;
      tool: WebGptDraftToolName;
      mode: "DRAFT_SUBMISSION";
      draft_write_allowed: true;
      production_mutation_allowed: false;
      draft: WebGptDraftRecord;
      provider_boundary: typeof H1_PROVIDER_BOUNDARY;
    }
  | {
      ok: false;
      tool: WebGptDraftToolName | "unknown";
      mode: "DRAFT_SUBMISSION";
      draft_write_allowed: false;
      production_mutation_allowed: false;
      error: {
        code: string;
        message: string;
      };
      provider_boundary: typeof H1_PROVIDER_BOUNDARY;
    };

export interface WebGptDraftWorkbenchSummary {
  bridge_version: typeof WEBGPT_DRAFT_BRIDGE_VERSION;
  store_file: typeof WEBGPT_DRAFT_STORE_FILE;
  mode: "DRAFT_REVIEW";
  drafts_total: number;
  drafts: WebGptDraftRecord[];
  provider_boundary: typeof H1_PROVIDER_BOUNDARY;
  production_effects: WebGptDraftRecord["production_effects"];
}

export const WEBGPT_DRAFT_TOOLS: WebGptDraftToolDefinition[] = [
  {
    name: "submit_shot_script_draft",
    description: "Submit a shot description, video prompt, negative prompt, and duration draft without changing app truth.",
    input_schema: {
      shot_id: "optional existing app shot id",
      proposed_shot_key: "optional non-authoritative draft label",
      description: "required draft shot description",
      video_prompt: "required draft video prompt",
      negative_prompt: "optional draft negative prompt",
      duration_seconds: "optional draft duration"
    },
    mode: "DRAFT_SUBMISSION",
    draft_write_allowed: true,
    production_mutation_allowed: false,
    direct_freeze_allowed: false,
    direct_artifact_registration_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "submit_storyboard_package_draft",
    description: "Submit a non-authoritative storyboard package draft for human review.",
    input_schema: {
      package_title: "optional draft title",
      shots: "array of draft shots; app artifact ids are validated if provided"
    },
    mode: "DRAFT_SUBMISSION",
    draft_write_allowed: true,
    production_mutation_allowed: false,
    direct_freeze_allowed: false,
    direct_artifact_registration_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "propose_artifact_link",
    description: "Propose linking a real app Media Artifact to an existing shot, without executing the link.",
    input_schema: {
      shot_id: "required existing app shot id",
      artifact_id: "required real app artifact id"
    },
    mode: "DRAFT_SUBMISSION",
    draft_write_allowed: true,
    production_mutation_allowed: false,
    direct_freeze_allowed: false,
    direct_artifact_registration_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "propose_package_validation",
    description: "Request human review of a package validation proposal without running production validation.",
    input_schema: {
      package_draft_id: "optional existing draft id",
      notes: "optional validation notes"
    },
    mode: "DRAFT_SUBMISSION",
    draft_write_allowed: true,
    production_mutation_allowed: false,
    direct_freeze_allowed: false,
    direct_artifact_registration_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "propose_freeze_request",
    description: "Request human review of a future package freeze without freezing anything.",
    input_schema: {
      package_draft_id: "optional existing draft id",
      reason: "required freeze request reason"
    },
    mode: "DRAFT_SUBMISSION",
    draft_write_allowed: true,
    production_mutation_allowed: false,
    direct_freeze_allowed: false,
    direct_artifact_registration_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  }
];

const NO_PRODUCTION_EFFECTS: WebGptDraftRecord["production_effects"] = {
  app_ready_truth_changed: false,
  media_artifact_registered: false,
  artifact_linked_to_shot: false,
  package_validated: false,
  package_frozen: false,
  provider_call_attempted: false,
  source_asset_overwritten: false
};

function now(): string {
  return new Date().toISOString();
}

function storePath(): string {
  return join(paths.workspaceRoot, WEBGPT_DRAFT_STORE_FILE);
}

function h1StatePath(): string {
  return join(paths.workspaceRoot, H1_STATE_FILE);
}

function loadH1DraftState(): H1WorkbenchState {
  const target = h1StatePath();
  if (!existsSync(target)) return defaultH1WorkbenchState();
  const parsed = JSON.parse(readFileSync(target, "utf8")) as H1WorkbenchState;
  return {
    ...defaultH1WorkbenchState(),
    ...parsed,
    regeneration_request_drafts: parsed.regeneration_request_drafts ?? []
  };
}

export function loadWebGptDraftStore(): WebGptDraftStore {
  const target = storePath();
  if (!existsSync(target)) return { version: "webgpt-draft-store-v0.5", updated_at: now(), drafts: [] };
  const parsed = JSON.parse(readFileSync(target, "utf8")) as Partial<WebGptDraftStore>;
  return {
    version: "webgpt-draft-store-v0.5",
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : now(),
    drafts: Array.isArray(parsed.drafts) ? parsed.drafts : []
  };
}

function saveWebGptDraftStore(store: WebGptDraftStore): WebGptDraftStore {
  const next = { ...store, updated_at: now() };
  const target = storePath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function fail(tool: WebGptDraftToolName | "unknown", code: string, message: string): WebGptDraftToolResult {
  return {
    ok: false,
    tool,
    mode: "DRAFT_SUBMISSION",
    draft_write_allowed: false,
    production_mutation_allowed: false,
    error: { code, message },
    provider_boundary: H1_PROVIDER_BOUNDARY
  };
}

function ok(tool: WebGptDraftToolName, draft: WebGptDraftRecord): WebGptDraftToolResult {
  return {
    ok: true,
    tool,
    mode: "DRAFT_SUBMISSION",
    draft_write_allowed: true,
    production_mutation_allowed: false,
    draft,
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

function currentShotIds(): Set<string> {
  return new Set(loadH1DraftState().shots.map((shot) => shot.shot_id));
}

function validateExistingShotId(tool: WebGptDraftToolName, input: Record<string, unknown>, required: boolean): WebGptDraftToolResult | null {
  const shotId = typeof input.shot_id === "string" ? input.shot_id.trim() : "";
  if (!shotId) return required ? fail(tool, "MISSING_REQUIRED_FIELD", "shot_id is required.") : null;
  if (!plainId(shotId)) return fail(tool, "INVALID_APP_ID", "Only real app shot_id values are accepted.");
  if (!currentShotIds().has(shotId)) return fail(tool, "SHOT_NOT_FOUND", `Shot not found in current workbench state: ${shotId}`);
  return null;
}

function validateArtifactId(tool: WebGptDraftToolName, artifactId: string, db: M0Database): WebGptDraftToolResult | null {
  if (!artifactId) return fail(tool, "MISSING_REQUIRED_FIELD", "artifact_id is required.");
  if (!plainId(artifactId)) return fail(tool, "INVALID_APP_ID", "Only real app artifact_id values are accepted.");
  const artifact = getMediaArtifact(db, artifactId);
  if (!artifact) return fail(tool, "ARTIFACT_NOT_FOUND", `Artifact not found: ${artifactId}`);
  if (artifact.artifact_type !== "image" || artifact.role !== "storyboard_image" || artifact.status !== "active") {
    return fail(tool, "ARTIFACT_NOT_LINKABLE", "Artifact must be an active storyboard_image image artifact.");
  }
  return null;
}

function validateDraftId(tool: WebGptDraftToolName, input: Record<string, unknown>, required: boolean): WebGptDraftToolResult | null {
  const draftId = typeof input.package_draft_id === "string" ? input.package_draft_id.trim() : "";
  if (!draftId) return required ? fail(tool, "MISSING_REQUIRED_FIELD", "package_draft_id is required.") : null;
  if (!plainId(draftId) || !draftId.startsWith("webgpt_draft_")) return fail(tool, "INVALID_DRAFT_ID", "Only real app draft ids are accepted.");
  const draft = loadWebGptDraftStore().drafts.find((candidate) => candidate.draft_id === draftId);
  if (!draft) return fail(tool, "DRAFT_NOT_FOUND", `Draft not found: ${draftId}`);
  if (draft.tool !== "submit_storyboard_package_draft") return fail(tool, "DRAFT_TYPE_NOT_PACKAGE", "package_draft_id must refer to a storyboard package draft.");
  return null;
}

function draftPayload(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function appendDraft(tool: WebGptDraftToolName, input: Record<string, unknown>): WebGptDraftRecord {
  const createdAt = now();
  const draft: WebGptDraftRecord = {
    draft_id: `webgpt_draft_${randomUUID()}`,
    tool,
    status: "submitted",
    created_at: createdAt,
    updated_at: createdAt,
    source: "webgpt_bridge_v0_5",
    payload: draftPayload(input),
    validation: { ok: true, blockers: [] },
    human_review: {
      required_before_app_mutation: true,
      visible_in_h1_workbench: true
    },
    production_effects: { ...NO_PRODUCTION_EFFECTS }
  };
  const store = loadWebGptDraftStore();
  saveWebGptDraftStore({ ...store, drafts: [...store.drafts, draft] });
  return draft;
}

function storyboardDraftShots(input: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(input.shots)) return input.shots.filter((shot): shot is Record<string, unknown> => Boolean(shot) && typeof shot === "object");
  const pkg = input.package;
  if (pkg && typeof pkg === "object" && Array.isArray((pkg as { shots?: unknown }).shots)) {
    return ((pkg as { shots: unknown[] }).shots).filter((shot): shot is Record<string, unknown> => Boolean(shot) && typeof shot === "object");
  }
  return [];
}

function validateStoryboardDraftArtifacts(tool: WebGptDraftToolName, input: Record<string, unknown>, db: M0Database): WebGptDraftToolResult | null {
  for (const shot of storyboardDraftShots(input)) {
    const artifactId = typeof shot.storyboard_image_artifact_id === "string" ? shot.storyboard_image_artifact_id.trim() : "";
    if (!artifactId) continue;
    const artifactError = validateArtifactId(tool, artifactId, db);
    if (artifactError) return artifactError;
  }
  return null;
}

export function executeWebGptDraftTool(
  tool: WebGptDraftToolName,
  input: Record<string, unknown> = {},
  db = openM0Database()
): WebGptDraftToolResult {
  if (!WEBGPT_DRAFT_TOOLS.some((definition) => definition.name === tool)) {
    return fail("unknown", "TOOL_NOT_FOUND", `Draft tool not found: ${tool}`);
  }

  if (tool === "submit_shot_script_draft") {
    const shotError = validateExistingShotId(tool, input, false);
    if (shotError) return shotError;
    if (typeof input.description !== "string" || input.description.trim() === "") return fail(tool, "MISSING_REQUIRED_FIELD", "description is required.");
    if (typeof input.video_prompt !== "string" || input.video_prompt.trim() === "") return fail(tool, "MISSING_REQUIRED_FIELD", "video_prompt is required.");
    return ok(tool, appendDraft(tool, input));
  }

  if (tool === "submit_storyboard_package_draft") {
    const artifactError = validateStoryboardDraftArtifacts(tool, input, db);
    if (artifactError) return artifactError;
    return ok(tool, appendDraft(tool, input));
  }

  if (tool === "propose_artifact_link") {
    const shotError = validateExistingShotId(tool, input, true);
    if (shotError) return shotError;
    const artifactId = typeof input.artifact_id === "string" ? input.artifact_id.trim() : "";
    const artifactError = validateArtifactId(tool, artifactId, db);
    if (artifactError) return artifactError;
    return ok(tool, appendDraft(tool, input));
  }

  if (tool === "propose_package_validation") {
    const draftError = validateDraftId(tool, input, false);
    if (draftError) return draftError;
    return ok(tool, appendDraft(tool, input));
  }

  if (tool === "propose_freeze_request") {
    const draftError = validateDraftId(tool, input, false);
    if (draftError) return draftError;
    if (typeof input.reason !== "string" || input.reason.trim() === "") return fail(tool, "MISSING_REQUIRED_FIELD", "reason is required.");
    return ok(tool, appendDraft(tool, input));
  }

  return fail("unknown", "TOOL_NOT_FOUND", `Draft tool not found: ${tool}`);
}

export function webGptDraftWorkbenchSummary(): WebGptDraftWorkbenchSummary {
  const drafts = [...loadWebGptDraftStore().drafts].reverse();
  return {
    bridge_version: WEBGPT_DRAFT_BRIDGE_VERSION,
    store_file: WEBGPT_DRAFT_STORE_FILE,
    mode: "DRAFT_REVIEW",
    drafts_total: drafts.length,
    drafts: drafts.slice(0, 100),
    provider_boundary: H1_PROVIDER_BOUNDARY,
    production_effects: { ...NO_PRODUCTION_EFFECTS }
  };
}
