import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getGenerationRun, type GenerationRun } from "./generation.js";
import { validateActiveArtifactReference, type MediaArtifact } from "./mediaArtifacts.js";
import { validateMp4File } from "./mediaValidity.js";
import { getShot } from "./projects.js";
import { H1_PROVIDER_BOUNDARY } from "./h1Workbench.js";

export const WEBGPT_REVIEW_ASSISTANT_VERSION = "webgpt-review-assistant-v2";
export const WEBGPT_REVIEW_ASSISTANT_STORE_FILE = "data/webgpt/review_assistant_drafts.json";

export type WebGptReviewAssistantToolName =
  | "get_generation_run"
  | "get_generated_clip_metadata"
  | "submit_review_note_draft"
  | "propose_rejection_reason"
  | "propose_regeneration_prompt";

export interface WebGptReviewAssistantToolDefinition {
  name: WebGptReviewAssistantToolName;
  description: string;
  input_schema: Record<string, unknown>;
  mode: "REVIEW_ASSISTANT";
  read_allowed: boolean;
  draft_write_allowed: boolean;
  final_human_approval_allowed: false;
  regeneration_allowed: false;
  provider_call_allowed: false;
  secret_read_allowed: false;
  shell_allowed: false;
}

export interface WebGptReviewDraftRecord {
  review_draft_id: string;
  tool: Extract<WebGptReviewAssistantToolName, "submit_review_note_draft" | "propose_rejection_reason" | "propose_regeneration_prompt">;
  status: "submitted";
  created_at: string;
  updated_at: string;
  source: "webgpt_review_assistant_v2";
  payload: Record<string, unknown>;
  linked: {
    run_id: string;
    artifact_id: string;
    shot_id: string;
  };
  human_review: {
    final_approval_required: true;
    visible_to_human: true;
  };
  production_effects: {
    final_human_approval_changed: false;
    clip_review_changed: false;
    regeneration_triggered: false;
    provider_call_attempted: false;
    source_asset_overwritten: false;
  };
}

export interface WebGptReviewAssistantStore {
  version: "webgpt-review-assistant-store-v2";
  updated_at: string;
  drafts: WebGptReviewDraftRecord[];
}

export type WebGptReviewAssistantToolResult =
  | {
      ok: true;
      tool: WebGptReviewAssistantToolName;
      mode: "REVIEW_ASSISTANT";
      data: unknown;
      final_human_approval_allowed: false;
      regeneration_allowed: false;
      provider_boundary: typeof H1_PROVIDER_BOUNDARY;
    }
  | {
      ok: false;
      tool: WebGptReviewAssistantToolName | "unknown";
      mode: "REVIEW_ASSISTANT";
      error: {
        code: string;
        message: string;
      };
      final_human_approval_allowed: false;
      regeneration_allowed: false;
      provider_boundary: typeof H1_PROVIDER_BOUNDARY;
    };

export interface WebGptReviewAssistantWorkbenchSummary {
  bridge_version: typeof WEBGPT_REVIEW_ASSISTANT_VERSION;
  store_file: typeof WEBGPT_REVIEW_ASSISTANT_STORE_FILE;
  mode: "REVIEW_DRAFT_REVIEW";
  drafts_total: number;
  drafts: WebGptReviewDraftRecord[];
  provider_boundary: typeof H1_PROVIDER_BOUNDARY;
}

export const WEBGPT_REVIEW_ASSISTANT_TOOLS: WebGptReviewAssistantToolDefinition[] = [
  {
    name: "get_generation_run",
    description: "Read one app Generation Run by run_id.",
    input_schema: { run_id: "required app generation run id" },
    mode: "REVIEW_ASSISTANT",
    read_allowed: true,
    draft_write_allowed: false,
    final_human_approval_allowed: false,
    regeneration_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "get_generated_clip_metadata",
    description: "Read one generated_clip Media Artifact with ffprobe metadata and linked run if available.",
    input_schema: { artifact_id: "required generated_clip artifact id" },
    mode: "REVIEW_ASSISTANT",
    read_allowed: true,
    draft_write_allowed: false,
    final_human_approval_allowed: false,
    regeneration_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "submit_review_note_draft",
    description: "Submit a draft review note for human review without changing clip review status.",
    input_schema: { artifact_id: "required generated_clip artifact id", note: "required draft note" },
    mode: "REVIEW_ASSISTANT",
    read_allowed: false,
    draft_write_allowed: true,
    final_human_approval_allowed: false,
    regeneration_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "propose_rejection_reason",
    description: "Draft a rejection reason for human review without rejecting the clip.",
    input_schema: { artifact_id: "required generated_clip artifact id", reason: "required draft rejection reason" },
    mode: "REVIEW_ASSISTANT",
    read_allowed: false,
    draft_write_allowed: true,
    final_human_approval_allowed: false,
    regeneration_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "propose_regeneration_prompt",
    description: "Draft a regeneration prompt delta for human review without triggering regeneration.",
    input_schema: { artifact_id: "required generated_clip artifact id", prompt_delta: "required draft prompt delta" },
    mode: "REVIEW_ASSISTANT",
    read_allowed: false,
    draft_write_allowed: true,
    final_human_approval_allowed: false,
    regeneration_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  }
];

function now(): string {
  return new Date().toISOString();
}

function storePath(): string {
  return join(paths.dataRoot, "webgpt", "review_assistant_drafts.json");
}

function isFakeOrPendingId(value: string): boolean {
  const upper = value.toUpperCase();
  return upper.startsWith("PENDING") || upper.includes("PENDING_") || upper.includes("FAKE") || upper.includes("PLACEHOLDER");
}

function plainId(value: string): boolean {
  return value !== "" && value === basename(value) && !value.includes("/") && !value.includes("\\") && !isFakeOrPendingId(value);
}

function fail(tool: WebGptReviewAssistantToolName | "unknown", code: string, message: string): WebGptReviewAssistantToolResult {
  return {
    ok: false,
    tool,
    mode: "REVIEW_ASSISTANT",
    error: { code, message },
    final_human_approval_allowed: false,
    regeneration_allowed: false,
    provider_boundary: H1_PROVIDER_BOUNDARY
  };
}

function ok(tool: WebGptReviewAssistantToolName, data: unknown): WebGptReviewAssistantToolResult {
  return {
    ok: true,
    tool,
    mode: "REVIEW_ASSISTANT",
    data,
    final_human_approval_allowed: false,
    regeneration_allowed: false,
    provider_boundary: H1_PROVIDER_BOUNDARY
  };
}

export function loadWebGptReviewAssistantStore(): WebGptReviewAssistantStore {
  const target = storePath();
  if (!existsSync(target)) return { version: "webgpt-review-assistant-store-v2", updated_at: now(), drafts: [] };
  const parsed = JSON.parse(readFileSync(target, "utf8")) as Partial<WebGptReviewAssistantStore>;
  return {
    version: "webgpt-review-assistant-store-v2",
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : now(),
    drafts: Array.isArray(parsed.drafts) ? parsed.drafts : []
  };
}

function saveWebGptReviewAssistantStore(store: WebGptReviewAssistantStore): WebGptReviewAssistantStore {
  const next = { ...store, updated_at: now() };
  const target = storePath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function listGenerationRuns(db: M0Database): GenerationRun[] {
  const rows = db.prepare("SELECT data_json FROM generation_runs ORDER BY updated_at DESC").all() as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as GenerationRun);
}

function findRunForArtifact(db: M0Database, artifactId: string): GenerationRun | null {
  return listGenerationRuns(db).find((run) => Array.isArray(run.output?.artifact_ids) && run.output.artifact_ids.includes(artifactId)) ?? null;
}

function requireGeneratedClip(tool: WebGptReviewAssistantToolName, input: Record<string, unknown>, db: M0Database): { ok: true; artifact: MediaArtifact; run: GenerationRun | null; shot_id: string } | { ok: false; result: WebGptReviewAssistantToolResult } {
  const artifactId = typeof input.artifact_id === "string" ? input.artifact_id.trim() : "";
  if (!artifactId) return { ok: false, result: fail(tool, "MISSING_REQUIRED_FIELD", "artifact_id is required.") };
  if (!plainId(artifactId)) return { ok: false, result: fail(tool, "INVALID_APP_ID", "Only real app generated_clip artifact ids are accepted.") };
  const run = findRunForArtifact(db, artifactId);
  if (!run) return { ok: false, result: fail(tool, "GENERATION_RUN_NOT_FOUND", "Generated clip is not owned by a generation run.") };
  const shot = getShot(db, run.shot_id);
  if (!shot || shot.project_id !== run.project_id || !shot.clip_versions.some((version) => version.artifact_id === artifactId)) {
    return { ok: false, result: fail(tool, "ARTIFACT_NOT_IN_SHOT_REVIEW", "Generated clip is not bound to the generation run SHOT.") };
  }
  const artifact = validateActiveArtifactReference(db, {
    artifact_id: artifactId,
    project_id: run.project_id,
    shot_id: run.shot_id,
    role: "generated_clip",
    artifact_type: "video"
  });
  if (!artifact.ok) return { ok: false, result: fail(tool, artifact.error.code, artifact.error.message) };
  return { ok: true, artifact: artifact.artifact, run, shot_id: run.shot_id };
}

function requiredText(tool: WebGptReviewAssistantToolName, input: Record<string, unknown>, field: string): WebGptReviewAssistantToolResult | null {
  return typeof input[field] === "string" && input[field].trim() !== "" ? null : fail(tool, "MISSING_REQUIRED_FIELD", `${field} is required.`);
}

function appendDraft(
  tool: WebGptReviewDraftRecord["tool"],
  input: Record<string, unknown>,
  linked: WebGptReviewDraftRecord["linked"]
): WebGptReviewDraftRecord {
  const createdAt = now();
  const draft: WebGptReviewDraftRecord = {
    review_draft_id: `webgpt_review_draft_${randomUUID()}`,
    tool,
    status: "submitted",
    created_at: createdAt,
    updated_at: createdAt,
    source: "webgpt_review_assistant_v2",
    payload: JSON.parse(JSON.stringify(input)) as Record<string, unknown>,
    linked,
    human_review: {
      final_approval_required: true,
      visible_to_human: true
    },
    production_effects: {
      final_human_approval_changed: false,
      clip_review_changed: false,
      regeneration_triggered: false,
      provider_call_attempted: false,
      source_asset_overwritten: false
    }
  };
  const store = loadWebGptReviewAssistantStore();
  saveWebGptReviewAssistantStore({ ...store, drafts: [...store.drafts, draft] });
  return draft;
}

export function executeWebGptReviewAssistantTool(
  tool: WebGptReviewAssistantToolName,
  input: Record<string, unknown> = {},
  db = openM0Database()
): WebGptReviewAssistantToolResult {
  if (!WEBGPT_REVIEW_ASSISTANT_TOOLS.some((definition) => definition.name === tool)) {
    return fail("unknown", "TOOL_NOT_FOUND", `Review assistant tool not found: ${tool}`);
  }

  if (tool === "get_generation_run") {
    const runId = typeof input.run_id === "string" ? input.run_id.trim() : "";
    if (!runId) return fail(tool, "MISSING_REQUIRED_FIELD", "run_id is required.");
    if (!plainId(runId)) return fail(tool, "INVALID_APP_ID", "Only real app run_id values are accepted.");
    const run = getGenerationRun(db, runId);
    if (!run) return fail(tool, "GENERATION_RUN_NOT_FOUND", `Run not found: ${runId}`);
    return ok(tool, { run });
  }

  if (tool === "get_generated_clip_metadata") {
    const clip = requireGeneratedClip(tool, input, db);
    if (!clip.ok) return clip.result;
    const shot = clip.run ? getShot(db, clip.run.shot_id) : null;
    return ok(tool, {
      artifact: clip.artifact,
      run: clip.run,
      shot,
      ffprobe: validateMp4File(clip.artifact.storage.uri)
    });
  }

  if (tool === "submit_review_note_draft" || tool === "propose_rejection_reason" || tool === "propose_regeneration_prompt") {
    const clip = requireGeneratedClip(tool, input, db);
    if (!clip.ok) return clip.result;
    const requiredField = tool === "submit_review_note_draft" ? "note" : tool === "propose_rejection_reason" ? "reason" : "prompt_delta";
    const textError = requiredText(tool, input, requiredField);
    if (textError) return textError;
    const draft = appendDraft(tool, input, {
      run_id: clip.run?.run_id ?? "",
      artifact_id: clip.artifact.artifact_id,
      shot_id: clip.shot_id
    });
    return ok(tool, { draft });
  }

  return fail("unknown", "TOOL_NOT_FOUND", `Review assistant tool not found: ${tool}`);
}

export function webGptReviewAssistantWorkbenchSummary(): WebGptReviewAssistantWorkbenchSummary {
  const drafts = [...loadWebGptReviewAssistantStore().drafts].reverse();
  return {
    bridge_version: WEBGPT_REVIEW_ASSISTANT_VERSION,
    store_file: WEBGPT_REVIEW_ASSISTANT_STORE_FILE,
    mode: "REVIEW_DRAFT_REVIEW",
    drafts_total: drafts.length,
    drafts: drafts.slice(0, 100),
    provider_boundary: H1_PROVIDER_BOUNDARY
  };
}
