import { z } from "zod/v4";

import { fail, type WebGptV4Result } from "./types.js";

const projectStatusSchema = z.enum(["draft", "storyboard_approved", "video_generation_in_progress", "video_review", "final_approved"]);
const shotStatusSchema = z.enum(["draft", "storyboard_approved", "video_pending", "video_generated", "video_review", "approved", "revision_needed"]);
const prioritySchema = z.enum(["urgent", "high", "normal"]);

const metaSchema = z.object({
  request_id: z.string(),
  source_version: z.string(),
  updated_at: z.string(),
  idempotent_replay: z.boolean().optional()
}).strict();

const errorSchema = z.object({
  code: z.string(), message: z.string(), field: z.string().optional(), retryable: z.boolean().optional(),
  suggested_parameters: z.object({ detail: z.literal("compact").optional(), limit: z.number().int().positive().optional(), notes_limit: z.number().int().positive().optional() }).strict().optional()
}).strict();

function resultContractSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data, meta: metaSchema }).strict(),
    z.object({ ok: z.literal(false), error: errorSchema, meta: metaSchema }).strict()
  ]);
}

function resultOutputSchema<T extends z.ZodType>(data: T) {
  return z.object({ ok: z.boolean(), data: data.optional(), error: errorSchema.optional(), meta: metaSchema }).strict();
}

const projectSchema = z.object({ project_id: z.string(), title: z.string(), status: projectStatusSchema, shot_ids: z.array(z.string()) }).strict();
const revisionInstructionSchema = z.object({ summary: z.string(), prompt_delta: z.string(), negative_delta: z.string(), priority: z.enum(["low", "medium", "high"]) }).strict();
const clipVersionSchema = z.object({ artifact_id: z.string(), run_id: z.string(), attempt_number: z.number().int(), review_status: z.enum(["pending", "approved", "rejected"]) }).strict();
const shotSchema = z.object({
  shot_id: z.string(), project_id: z.string(), order: z.number(), status: shotStatusSchema, duration_seconds: z.number(), description: z.string(),
  storyboard_image_artifact_id: z.string(), video_prompt: z.string(), negative_prompt: z.string(), generation_run_ids: z.array(z.string()),
  accepted_clip_artifact_id: z.string(), clip_versions: z.array(clipVersionSchema),
  review: z.object({ approval_status: z.enum(["pending", "approved", "revision_needed"]), rejection_reasons: z.array(z.string()), latest_revision_instruction: revisionInstructionSchema.nullable() }).strict(),
  updated_at: z.string().optional()
}).strict();
const projectMetaSchema = z.object({
  project_id: z.string(), classification: z.literal("production"), lifecycle: z.enum(["active", "archived"]), pinned: z.boolean(),
  last_opened_at: z.string().nullable(), updated_at: z.string()
}).strict();
const nextActionDerivedSchema = z.object({ label: z.string(), reason_code: z.string(), priority: prioritySchema }).strict();
const nextActionSchema = z.object({
  source: z.enum(["derived", "override"]), label: z.string(), reason_code: z.string(), priority: prioritySchema,
  expires_at: z.string().nullable(), derived: nextActionDerivedSchema
}).strict();
const summarySchema = z.object({
  shot_count: z.number().int(), accepted_count: z.number().int(), active_run_count: z.number().int(), blocker_count: z.number().int(),
  blocker_reason: z.string(), review_pending_count: z.number().int(), delivery_state: z.enum(["not_ready", "ready_to_assemble", "final_review", "delivered"]),
  next_action: nextActionSchema, risk: z.enum(["blocked", "attention", "clear"])
}).strict();
const pageSchema = z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int(), has_more: z.boolean() }).strict();
const artifactSchema = z.object({
  artifact_id: z.string(), artifact_type: z.enum(["image", "video"]), role: z.enum(["storyboard_image", "generated_clip", "final_video"]),
  status: z.enum(["pending_upload", "active", "inaccessible", "expired", "archived"]), filename: z.string(), mime_type: z.string(),
  metadata: z.object({ width: z.number(), height: z.number(), duration_seconds: z.number().nullable(), aspect_ratio: z.string(), sha256: z.string() }).strict(),
  linked_objects: z.object({ project_id: z.string(), shot_id: z.string() }).strict(),
  provenance: z.object({ kind: z.string(), provider: z.string(), sha256: z.string() }).strict()
}).strict();
const reviewNoteSchema = z.object({
  note_id: z.string(), project_id: z.string(), shot_id: z.string(), artifact_id: z.string(), note: z.string(), source: z.string(), created_at: z.string(), updated_at: z.string()
}).strict();

const projectListDataSchema = z.object({
  items: z.array(z.object({ project: projectSchema, lifecycle: z.enum(["active", "archived"]), pinned: z.boolean(), last_opened_at: z.string().nullable(), updated_at: z.string(), summary: summarySchema }).strict()),
  page: pageSchema
}).strict();
const shotListDataSchema = z.object({ items: z.array(shotSchema), page: pageSchema }).strict();
const contextBase = { project: projectSchema, meta: projectMetaSchema, summary: summarySchema };
const projectContextDataSchema = z.discriminatedUnion("workspace", [
  z.object({ ...contextBase, workspace: z.literal("overview"), metrics: z.object({ shots: z.number().int(), storyboard_approved: z.number().int(), generation_active: z.number().int(), review_pending: z.number().int(), accepted_clips: z.number().int() }).strict(), blockers: z.array(z.object({ shot_id: z.string(), order: z.number(), missing_image: z.boolean(), missing_prompt: z.boolean() }).strict()) }).strict(),
  z.object({ ...contextBase, workspace: z.literal("storyboard"), shots: z.array(shotSchema) }).strict(),
  z.object({ ...contextBase, workspace: z.literal("generation"), shots: z.array(shotSchema) }).strict(),
  z.object({ ...contextBase, workspace: z.literal("review"), shots: z.array(shotSchema), review_notes: z.array(reviewNoteSchema) }).strict(),
  z.object({ ...contextBase, workspace: z.literal("delivery"), ready_for_assembly: z.boolean(), accepted_clips: z.array(z.object({ shot_id: z.string(), order: z.number(), artifact: artifactSchema.nullable() }).strict()), final_artifact: artifactSchema.nullable() }).strict()
]);
const reviewPackageDataSchema = z.object({
  shot: shotSchema,
  versions: z.array(clipVersionSchema.extend({ artifact: artifactSchema }).strict()),
  notes: z.array(reviewNoteSchema),
  selected_artifact_id: z.string()
}).strict();
const deliveryDataSchema = z.object({ project_id: z.string(), project_status: projectStatusSchema, shots_total: z.number().int(), shots_accepted: z.number().int(), ready_for_assembly: z.boolean(), final_artifact: artifactSchema.nullable(), delivered: z.boolean() }).strict();
const closeoutDataSchema = deliveryDataSchema.extend({ evidence: z.object({ source: z.literal("sqlite_structured_summary"), webgpt_audit_events: z.number().int(), raw_reports_exposed: z.literal(false) }).strict() }).strict();

export const WEBGPT_V4_READONLY_OUTPUT_SCHEMAS = {
  list_production_projects: resultOutputSchema(projectListDataSchema),
  get_project_context: resultOutputSchema(projectContextDataSchema),
  list_project_shots: resultOutputSchema(shotListDataSchema),
  get_review_package: resultOutputSchema(reviewPackageDataSchema),
  get_delivery_status: resultOutputSchema(deliveryDataSchema),
  get_closeout_evidence: resultOutputSchema(closeoutDataSchema)
} as const;

const WEBGPT_V4_READONLY_CONTRACT_SCHEMAS = {
  list_production_projects: resultContractSchema(projectListDataSchema),
  get_project_context: resultContractSchema(projectContextDataSchema),
  list_project_shots: resultContractSchema(shotListDataSchema),
  get_review_package: resultContractSchema(reviewPackageDataSchema),
  get_delivery_status: resultContractSchema(deliveryDataSchema),
  get_closeout_evidence: resultContractSchema(closeoutDataSchema)
} as const;

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): UnknownRecord => value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
const records = (value: unknown): UnknownRecord[] => Array.isArray(value) ? value.map(record) : [];

function project(value: unknown): UnknownRecord {
  const item = record(value);
  return { project_id: item.project_id, title: item.title, status: item.status, shot_ids: item.shot_ids };
}

function clipVersion(value: unknown): UnknownRecord {
  const item = record(value);
  return { artifact_id: item.artifact_id, run_id: item.run_id, attempt_number: item.attempt_number, review_status: item.review_status };
}

function shot(value: unknown): UnknownRecord {
  const item = record(value);
  const review = record(item.review);
  const instruction = review.latest_revision_instruction === null ? null : record(review.latest_revision_instruction);
  return {
    shot_id: item.shot_id, project_id: item.project_id, order: item.order, status: item.status, duration_seconds: item.duration_seconds,
    description: item.description, storyboard_image_artifact_id: item.storyboard_image_artifact_id, video_prompt: item.video_prompt,
    negative_prompt: item.negative_prompt, generation_run_ids: item.generation_run_ids, accepted_clip_artifact_id: item.accepted_clip_artifact_id,
    clip_versions: records(item.clip_versions).map(clipVersion),
    review: { approval_status: review.approval_status, rejection_reasons: review.rejection_reasons, latest_revision_instruction: instruction },
    ...(typeof item.updated_at === "string" ? { updated_at: item.updated_at } : {})
  };
}

function projectMeta(value: unknown): UnknownRecord {
  const item = record(value);
  return { project_id: item.project_id, classification: item.classification, lifecycle: item.lifecycle, pinned: item.pinned, last_opened_at: item.last_opened_at, updated_at: item.updated_at };
}

function nextAction(value: unknown): UnknownRecord {
  const item = record(value);
  const derived = record(item.derived);
  return { source: item.source, label: item.label, reason_code: item.reason_code, priority: item.priority, expires_at: item.expires_at, derived: { label: derived.label, reason_code: derived.reason_code, priority: derived.priority } };
}

function summary(value: unknown): UnknownRecord {
  const item = record(value);
  return {
    shot_count: item.shot_count, accepted_count: item.accepted_count, active_run_count: item.active_run_count, blocker_count: item.blocker_count,
    blocker_reason: item.blocker_reason, review_pending_count: item.review_pending_count, delivery_state: item.delivery_state,
    next_action: nextAction(item.next_action), risk: item.risk
  };
}

function page(value: unknown): UnknownRecord {
  const item = record(value);
  return { limit: item.limit, offset: item.offset, total: item.total, has_more: item.has_more };
}

function artifact(value: unknown): UnknownRecord {
  const item = record(value);
  const storage = record(item.storage);
  const metadata = record(item.metadata);
  const links = record(item.linked_objects);
  const provenance = record(item.provenance ?? item.source);
  return {
    artifact_id: item.artifact_id, artifact_type: item.artifact_type, role: item.role, status: item.status,
    filename: item.filename ?? storage.filename, mime_type: item.mime_type ?? storage.mime_type,
    metadata: { width: metadata.width, height: metadata.height, duration_seconds: metadata.duration_seconds, aspect_ratio: metadata.aspect_ratio, sha256: metadata.sha256 },
    linked_objects: { project_id: links.project_id, shot_id: links.shot_id },
    provenance: { kind: provenance.kind, provider: provenance.provider, sha256: provenance.sha256 ?? metadata.sha256 }
  };
}

function note(value: unknown, projectId?: unknown, shotId?: unknown): UnknownRecord {
  const item = record(value);
  return { note_id: item.note_id, project_id: item.project_id ?? projectId, shot_id: item.shot_id ?? shotId, artifact_id: item.artifact_id, note: item.note, source: item.source, created_at: item.created_at, updated_at: item.updated_at };
}

function validate<T>(schema: z.ZodType<T>, result: WebGptV4Result<unknown>, data: unknown): WebGptV4Result<unknown> {
  const candidate = result.ok ? { ok: true, data, meta: result.meta } : result;
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data as WebGptV4Result<unknown> : fail(result.meta.request_id, { code: "WEBGPT_V4_OUTPUT_CONTRACT_VIOLATION", message: "WebGPT V4 could not produce a valid public result." });
}

export function readonlyProjectList(result: WebGptV4Result<unknown>): WebGptV4Result<unknown> {
  if (!result.ok) return validate(WEBGPT_V4_READONLY_CONTRACT_SCHEMAS.list_production_projects, result, undefined);
  const data = record(result.data);
  return validate(WEBGPT_V4_READONLY_CONTRACT_SCHEMAS.list_production_projects, result, {
    items: records(data.items).map((value) => ({ project: project(value.project), lifecycle: value.lifecycle, pinned: value.pinned, last_opened_at: value.last_opened_at, updated_at: value.updated_at, summary: summary(value.summary) })),
    page: page(data.page)
  });
}

export function readonlyShotList(result: WebGptV4Result<unknown>): WebGptV4Result<unknown> {
  if (!result.ok) return validate(WEBGPT_V4_READONLY_CONTRACT_SCHEMAS.list_project_shots, result, undefined);
  const data = record(result.data);
  return validate(WEBGPT_V4_READONLY_CONTRACT_SCHEMAS.list_project_shots, result, { items: records(data.items).map(shot), page: page(data.page) });
}

export function readonlyProjectContext(result: WebGptV4Result<unknown>): WebGptV4Result<unknown> {
  if (!result.ok) return validate(WEBGPT_V4_READONLY_CONTRACT_SCHEMAS.get_project_context, result, undefined);
  const data = record(result.data);
  const base = { project: project(data.project), meta: projectMeta(data.meta), summary: summary(data.summary), workspace: data.workspace };
  let projected: UnknownRecord;
  if (data.workspace === "overview") {
    const metrics = record(data.metrics);
    projected = { ...base, metrics: { shots: metrics.shots, storyboard_approved: metrics.storyboard_approved, generation_active: metrics.generation_active, review_pending: metrics.review_pending, accepted_clips: metrics.accepted_clips }, blockers: records(data.blockers).map((item) => ({ shot_id: item.shot_id, order: item.order, missing_image: item.missing_image, missing_prompt: item.missing_prompt })) };
  } else if (data.workspace === "storyboard" || data.workspace === "generation") {
    projected = { ...base, shots: records(data.shots).map(shot) };
  } else if (data.workspace === "review") {
    projected = { ...base, shots: records(data.version_stacks).map((item) => shot(item.shot)), review_notes: records(data.review_notes).map((item) => note(item)) };
  } else {
    projected = { ...base, ready_for_assembly: data.ready_for_assembly, accepted_clips: records(data.accepted_clips).map((item) => ({ shot_id: item.shot_id, order: item.order, artifact: item.artifact ? artifact(item.artifact) : null })), final_artifact: data.final_artifact ? artifact(data.final_artifact) : null };
  }
  return validate(WEBGPT_V4_READONLY_CONTRACT_SCHEMAS.get_project_context, result, projected);
}

export function readonlyReviewPackage(result: WebGptV4Result<unknown>, projectId: string, shotId: string): WebGptV4Result<unknown> {
  if (!result.ok) return validate(WEBGPT_V4_READONLY_CONTRACT_SCHEMAS.get_review_package, result, undefined);
  const data = record(result.data);
  return validate(WEBGPT_V4_READONLY_CONTRACT_SCHEMAS.get_review_package, result, {
    shot: shot(data.shot),
    versions: records(data.versions).map((item) => ({ ...clipVersion(item), artifact: artifact(item.artifact) })),
    notes: records(data.notes).map((item) => note(item, projectId, shotId)),
    selected_artifact_id: data.selected_artifact_id
  });
}

export function readonlyDelivery(result: WebGptV4Result<unknown>, closeout = false): WebGptV4Result<unknown> {
  const schema = closeout ? WEBGPT_V4_READONLY_CONTRACT_SCHEMAS.get_closeout_evidence : WEBGPT_V4_READONLY_CONTRACT_SCHEMAS.get_delivery_status;
  if (!result.ok) return validate(schema, result, undefined);
  const data = record(result.data);
  return validate(schema, result, {
    project_id: data.project_id, project_status: data.project_status, shots_total: data.shots_total, shots_accepted: data.shots_accepted,
    ready_for_assembly: data.ready_for_assembly, final_artifact: data.final_artifact ? artifact(data.final_artifact) : null, delivered: data.delivered,
    ...(closeout ? { evidence: data.evidence } : {})
  });
}
