import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getMediaArtifact, validateActiveArtifactReference } from "./mediaArtifacts.js";
import { getProject, getShot } from "./projects.js";
import { H1_PROVIDER_BOUNDARY } from "./h1Workbench.js";
import { loadMemorySavebackStore } from "./memorySaveback.js";

export const WEBGPT_PRODUCTION_ASSISTANT_VERSION = "webgpt-production-assistant-v3";
export const WEBGPT_PRODUCTION_ASSISTANT_STORE_FILE = "data/webgpt/production_assistant_plans.json";

export type WebGptProductionAssistantToolName =
  | "propose_generation_plan"
  | "propose_regeneration_plan"
  | "propose_final_assembly_plan"
  | "propose_memory_saveback";

export interface WebGptProductionAssistantToolDefinition {
  name: WebGptProductionAssistantToolName;
  description: string;
  input_schema: Record<string, unknown>;
  mode: "PRODUCTION_ASSISTANT_PLAN";
  plan_write_allowed: true;
  execution_allowed: false;
  provider_call_allowed: false;
  final_delivery_approval_allowed: false;
  long_term_memory_write_allowed: false;
  secret_read_allowed: false;
  shell_allowed: false;
}

export interface WebGptProductionPlanRecord {
  plan_id: string;
  tool: WebGptProductionAssistantToolName;
  status: "submitted";
  created_at: string;
  updated_at: string;
  source: "webgpt_production_assistant_v3";
  payload: Record<string, unknown>;
  linked: {
    project_id: string;
    shot_id: string;
    artifact_id: string;
    proposal_id: string;
  };
  human_review: {
    required_before_execution: true;
    human_workbench_hard_gate: true;
  };
  production_effects: {
    provider_call_attempted: false;
    generation_started: false;
    regeneration_started: false;
    final_assembly_started: false;
    final_delivery_approved: false;
    long_term_memory_written: false;
    source_asset_overwritten: false;
  };
}

export interface WebGptProductionAssistantStore {
  version: "webgpt-production-assistant-store-v3";
  updated_at: string;
  plans: WebGptProductionPlanRecord[];
}

export type WebGptProductionAssistantToolResult =
  | {
      ok: true;
      tool: WebGptProductionAssistantToolName;
      mode: "PRODUCTION_ASSISTANT_PLAN";
      plan_write_allowed: true;
      execution_allowed: false;
      plan: WebGptProductionPlanRecord;
      provider_boundary: typeof H1_PROVIDER_BOUNDARY;
    }
  | {
      ok: false;
      tool: WebGptProductionAssistantToolName | "unknown";
      mode: "PRODUCTION_ASSISTANT_PLAN";
      plan_write_allowed: false;
      execution_allowed: false;
      error: { code: string; message: string };
      provider_boundary: typeof H1_PROVIDER_BOUNDARY;
    };

export interface WebGptProductionAssistantWorkbenchSummary {
  bridge_version: typeof WEBGPT_PRODUCTION_ASSISTANT_VERSION;
  store_file: typeof WEBGPT_PRODUCTION_ASSISTANT_STORE_FILE;
  mode: "PRODUCTION_PLAN_REVIEW";
  plans_total: number;
  plans: WebGptProductionPlanRecord[];
  provider_boundary: typeof H1_PROVIDER_BOUNDARY;
  production_effects: WebGptProductionPlanRecord["production_effects"];
}

export const WEBGPT_PRODUCTION_ASSISTANT_TOOLS: WebGptProductionAssistantToolDefinition[] = [
  {
    name: "propose_generation_plan",
    description: "Draft a generation plan for human review without starting generation or calling a provider.",
    input_schema: { project_id: "required app project id", shot_ids: "optional shot id list", notes: "required plan notes" },
    mode: "PRODUCTION_ASSISTANT_PLAN",
    plan_write_allowed: true,
    execution_allowed: false,
    provider_call_allowed: false,
    final_delivery_approval_allowed: false,
    long_term_memory_write_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "propose_regeneration_plan",
    description: "Draft a regeneration plan for a generated clip without triggering regeneration.",
    input_schema: { project_id: "required app project id", artifact_id: "required generated_clip artifact id", prompt_delta: "required prompt delta" },
    mode: "PRODUCTION_ASSISTANT_PLAN",
    plan_write_allowed: true,
    execution_allowed: false,
    provider_call_allowed: false,
    final_delivery_approval_allowed: false,
    long_term_memory_write_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "propose_final_assembly_plan",
    description: "Draft a final assembly plan without approving delivery or assembling video.",
    input_schema: { project_id: "required app project id", notes: "optional assembly notes" },
    mode: "PRODUCTION_ASSISTANT_PLAN",
    plan_write_allowed: true,
    execution_allowed: false,
    provider_call_allowed: false,
    final_delivery_approval_allowed: false,
    long_term_memory_write_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "propose_memory_saveback",
    description: "Draft a memory saveback plan without writing long-term memory.",
    input_schema: { project_id: "required app project id", proposal_id: "optional existing saveback proposal id", notes: "optional saveback notes" },
    mode: "PRODUCTION_ASSISTANT_PLAN",
    plan_write_allowed: true,
    execution_allowed: false,
    provider_call_allowed: false,
    final_delivery_approval_allowed: false,
    long_term_memory_write_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  }
];

const NO_PRODUCTION_EFFECTS: WebGptProductionPlanRecord["production_effects"] = {
  provider_call_attempted: false,
  generation_started: false,
  regeneration_started: false,
  final_assembly_started: false,
  final_delivery_approved: false,
  long_term_memory_written: false,
  source_asset_overwritten: false
};

function now(): string {
  return new Date().toISOString();
}

function storePath(): string {
  return join(paths.dataRoot, "webgpt", "production_assistant_plans.json");
}

export function loadWebGptProductionAssistantStore(): WebGptProductionAssistantStore {
  const target = storePath();
  if (!existsSync(target)) return { version: "webgpt-production-assistant-store-v3", updated_at: now(), plans: [] };
  const parsed = JSON.parse(readFileSync(target, "utf8")) as Partial<WebGptProductionAssistantStore>;
  return {
    version: "webgpt-production-assistant-store-v3",
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : now(),
    plans: Array.isArray(parsed.plans) ? parsed.plans : []
  };
}

function saveWebGptProductionAssistantStore(store: WebGptProductionAssistantStore): WebGptProductionAssistantStore {
  const next = { ...store, updated_at: now() };
  const target = storePath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function fail(tool: WebGptProductionAssistantToolName | "unknown", code: string, message: string): WebGptProductionAssistantToolResult {
  return {
    ok: false,
    tool,
    mode: "PRODUCTION_ASSISTANT_PLAN",
    plan_write_allowed: false,
    execution_allowed: false,
    error: { code, message },
    provider_boundary: H1_PROVIDER_BOUNDARY
  };
}

function ok(tool: WebGptProductionAssistantToolName, plan: WebGptProductionPlanRecord): WebGptProductionAssistantToolResult {
  return {
    ok: true,
    tool,
    mode: "PRODUCTION_ASSISTANT_PLAN",
    plan_write_allowed: true,
    execution_allowed: false,
    plan,
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

function requiredProject(tool: WebGptProductionAssistantToolName, input: Record<string, unknown>, db: M0Database): { ok: true; project_id: string } | { ok: false; result: WebGptProductionAssistantToolResult } {
  const projectId = typeof input.project_id === "string" ? input.project_id.trim() : "";
  if (!projectId) return { ok: false, result: fail(tool, "MISSING_REQUIRED_FIELD", "project_id is required.") };
  if (!plainId(projectId)) return { ok: false, result: fail(tool, "INVALID_APP_ID", "Only real app project_id values are accepted.") };
  const project = getProject(db, projectId);
  if (!project) return { ok: false, result: fail(tool, "PROJECT_NOT_FOUND", `Project not found: ${projectId}`) };
  const meta = db.prepare("SELECT lifecycle FROM workbench_project_meta WHERE project_id = ?").get(projectId) as { lifecycle: string } | undefined;
  if (meta?.lifecycle === "archived") return { ok: false, result: fail(tool, "PROJECT_ARCHIVED", "Archived projects cannot accept new production plans.") };
  return { ok: true, project_id: project.project_id };
}

function requiredGeneratedClip(
  tool: WebGptProductionAssistantToolName,
  input: Record<string, unknown>,
  projectId: string,
  db: M0Database
): { ok: true; artifact_id: string; shot_id: string } | { ok: false; result: WebGptProductionAssistantToolResult } {
  const artifactId = typeof input.artifact_id === "string" ? input.artifact_id.trim() : "";
  if (!artifactId) return { ok: false, result: fail(tool, "MISSING_REQUIRED_FIELD", "artifact_id is required.") };
  if (!plainId(artifactId)) return { ok: false, result: fail(tool, "INVALID_APP_ID", "Only real app generated_clip artifact ids are accepted.") };
  const artifact = getMediaArtifact(db, artifactId);
  if (!artifact) return { ok: false, result: fail(tool, "ARTIFACT_NOT_FOUND", `Artifact not found: ${artifactId}`) };
  if (artifact.artifact_type !== "video" || artifact.role !== "generated_clip") {
    return { ok: false, result: fail(tool, "ARTIFACT_NOT_GENERATED_CLIP", "Artifact must be a generated_clip video.") };
  }
  if (artifact.linked_objects.project_id !== projectId) {
    return { ok: false, result: fail(tool, "ARTIFACT_PROJECT_MISMATCH", "Generated clip artifact does not belong to the requested project.") };
  }
  if (!artifact.linked_objects.shot_id) {
    return { ok: false, result: fail(tool, "ARTIFACT_SHOT_LINK_MISSING", "Generated clip artifact is missing its shot link.") };
  }
  const shot = getShot(db, artifact.linked_objects.shot_id);
  if (!shot || shot.project_id !== projectId || !shot.clip_versions.some((version) => version.artifact_id === artifact.artifact_id)) {
    return { ok: false, result: fail(tool, "ARTIFACT_NOT_IN_SHOT_REVIEW", "Generated clip is not a reviewed version of its SHOT.") };
  }
  const validated = validateActiveArtifactReference(db, {
    artifact_id: artifact.artifact_id,
    project_id: projectId,
    shot_id: shot.shot_id,
    role: "generated_clip",
    artifact_type: "video"
  });
  if (!validated.ok) return { ok: false, result: fail(tool, validated.error.code, validated.error.message) };
  return { ok: true, artifact_id: artifact.artifact_id, shot_id: artifact.linked_objects.shot_id };
}

function requiredOptionalProposal(
  tool: WebGptProductionAssistantToolName,
  input: Record<string, unknown>,
  projectId: string
): { ok: true; proposal_id: string } | { ok: false; result: WebGptProductionAssistantToolResult } {
  const proposalId = typeof input.proposal_id === "string" ? input.proposal_id.trim() : "";
  if (!proposalId) return { ok: true, proposal_id: "" };
  if (!plainId(proposalId) || !proposalId.startsWith("memory_proposal_")) {
    return { ok: false, result: fail(tool, "INVALID_APP_ID", "Only real app memory proposal ids are accepted.") };
  }
  const proposal = loadMemorySavebackStore().proposals.find((candidate) => candidate.proposal_id === proposalId);
  if (!proposal) return { ok: false, result: fail(tool, "PROPOSAL_NOT_FOUND", `Memory proposal not found: ${proposalId}`) };
  if (proposal.project_id !== projectId) {
    return { ok: false, result: fail(tool, "PROPOSAL_PROJECT_MISMATCH", "Memory proposal does not belong to the requested project.") };
  }
  return { ok: true, proposal_id: proposal.proposal_id };
}

function requiredText(tool: WebGptProductionAssistantToolName, input: Record<string, unknown>, field: string): WebGptProductionAssistantToolResult | null {
  return typeof input[field] === "string" && input[field].trim() !== "" ? null : fail(tool, "MISSING_REQUIRED_FIELD", `${field} is required.`);
}

function appendPlan(tool: WebGptProductionAssistantToolName, input: Record<string, unknown>, linked: WebGptProductionPlanRecord["linked"]): WebGptProductionPlanRecord {
  const createdAt = now();
  const plan: WebGptProductionPlanRecord = {
    plan_id: `webgpt_production_plan_${randomUUID()}`,
    tool,
    status: "submitted",
    created_at: createdAt,
    updated_at: createdAt,
    source: "webgpt_production_assistant_v3",
    payload: JSON.parse(JSON.stringify(input)) as Record<string, unknown>,
    linked,
    human_review: {
      required_before_execution: true,
      human_workbench_hard_gate: true
    },
    production_effects: { ...NO_PRODUCTION_EFFECTS }
  };
  const store = loadWebGptProductionAssistantStore();
  saveWebGptProductionAssistantStore({ ...store, plans: [...store.plans, plan] });
  return plan;
}

export function executeWebGptProductionAssistantTool(
  tool: WebGptProductionAssistantToolName,
  input: Record<string, unknown> = {},
  db = openM0Database()
): WebGptProductionAssistantToolResult {
  if (!WEBGPT_PRODUCTION_ASSISTANT_TOOLS.some((definition) => definition.name === tool)) {
    return fail("unknown", "TOOL_NOT_FOUND", `Production assistant tool not found: ${tool}`);
  }

  const project = requiredProject(tool, input, db);
  if (!project.ok) return project.result;

  if (tool === "propose_generation_plan") {
    const textError = requiredText(tool, input, "notes");
    if (textError) return textError;
    return ok(tool, appendPlan(tool, input, { project_id: project.project_id, shot_id: "", artifact_id: "", proposal_id: "" }));
  }

  if (tool === "propose_regeneration_plan") {
    const clip = requiredGeneratedClip(tool, input, project.project_id, db);
    if (!clip.ok) return clip.result;
    const textError = requiredText(tool, input, "prompt_delta");
    if (textError) return textError;
    return ok(tool, appendPlan(tool, input, { project_id: project.project_id, shot_id: clip.shot_id, artifact_id: clip.artifact_id, proposal_id: "" }));
  }

  if (tool === "propose_final_assembly_plan") {
    return ok(tool, appendPlan(tool, input, { project_id: project.project_id, shot_id: "", artifact_id: "", proposal_id: "" }));
  }

  if (tool === "propose_memory_saveback") {
    const proposal = requiredOptionalProposal(tool, input, project.project_id);
    if (!proposal.ok) return proposal.result;
    return ok(tool, appendPlan(tool, input, { project_id: project.project_id, shot_id: "", artifact_id: "", proposal_id: proposal.proposal_id }));
  }

  return fail("unknown", "TOOL_NOT_FOUND", `Production assistant tool not found: ${tool}`);
}

export function webGptProductionAssistantWorkbenchSummary(): WebGptProductionAssistantWorkbenchSummary {
  const plans = [...loadWebGptProductionAssistantStore().plans].reverse();
  return {
    bridge_version: WEBGPT_PRODUCTION_ASSISTANT_VERSION,
    store_file: WEBGPT_PRODUCTION_ASSISTANT_STORE_FILE,
    mode: "PRODUCTION_PLAN_REVIEW",
    plans_total: plans.length,
    plans: plans.slice(0, 100),
    provider_boundary: H1_PROVIDER_BOUNDARY,
    production_effects: { ...NO_PRODUCTION_EFFECTS }
  };
}
