import { z } from "zod/v4";

import { fail, type WebGptV4Result } from "./types.js";

export type WebGptV4Detail = "compact" | "full";
type UnknownRecord = Record<string, unknown>;

const projectStatusSchema = z.enum(["draft", "storyboard_approved", "video_generation_in_progress", "video_review", "final_approved"]);
const shotStatusSchema = z.enum(["draft", "storyboard_approved", "video_pending", "video_generated", "video_review", "approved", "revision_needed"]);
const prioritySchema = z.enum(["urgent", "high", "normal"]);

export const WEBGPT_V4_META_SCHEMA = z.object({
  request_id: z.string(), source_version: z.string(), updated_at: z.string(), idempotent_replay: z.boolean().optional()
}).strict();

export const WEBGPT_V4_ERROR_SCHEMA = z.object({
  code: z.string(), message: z.string(), field: z.string().optional(), retryable: z.boolean().optional(),
  suggested_parameters: z.object({ detail: z.literal("compact").optional(), limit: z.number().int().positive().optional(), notes_limit: z.number().int().positive().optional() }).strict().optional()
}).strict();

export function resultContractSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data, meta: WEBGPT_V4_META_SCHEMA }).strict(),
    z.object({ ok: z.literal(false), error: WEBGPT_V4_ERROR_SCHEMA, meta: WEBGPT_V4_META_SCHEMA }).strict()
  ]);
}

export function resultOutputSchema<T extends z.ZodType>(data: T) {
  return z.object({
    ok: z.boolean(), data: data.optional(), error: WEBGPT_V4_ERROR_SCHEMA.optional(), meta: WEBGPT_V4_META_SCHEMA
  }).strict().meta({
    oneOf: [
      { properties: { ok: { const: true } }, required: ["ok", "data", "meta"], not: { required: ["error"] } },
      { properties: { ok: { const: false } }, required: ["ok", "error", "meta"], not: { required: ["data"] } }
    ]
  });
}

export const WEBGPT_V4_PROJECT_SCHEMA = z.object({ project_id: z.string(), title: z.string(), status: projectStatusSchema, shot_ids: z.array(z.string()) }).strict();
export const WEBGPT_V4_COMPACT_PROJECT_SCHEMA = WEBGPT_V4_PROJECT_SCHEMA.pick({ project_id: true, title: true, status: true }).strict();
const revisionInstructionSchema = z.object({ summary: z.string(), prompt_delta: z.string(), negative_delta: z.string(), priority: z.enum(["low", "medium", "high"]) }).strict();
const clipVersionSchema = z.object({ artifact_id: z.string(), run_id: z.string(), attempt_number: z.number().int(), review_status: z.enum(["pending", "approved", "rejected"]) }).strict();
export const WEBGPT_V4_SHOT_SCHEMA = z.object({
  shot_id: z.string(), project_id: z.string(), order: z.number(), status: shotStatusSchema, duration_seconds: z.number(), description: z.string(),
  storyboard_image_artifact_id: z.string(), video_prompt: z.string(), negative_prompt: z.string(), generation_run_ids: z.array(z.string()),
  accepted_clip_artifact_id: z.string(), clip_versions: z.array(clipVersionSchema),
  review: z.object({ approval_status: z.enum(["pending", "approved", "revision_needed"]), rejection_reasons: z.array(z.string()), latest_revision_instruction: revisionInstructionSchema.nullable() }).strict(),
  updated_at: z.string().optional()
}).strict();
export const WEBGPT_V4_COMPACT_SHOT_SCHEMA = WEBGPT_V4_SHOT_SCHEMA.pick({
  shot_id: true, project_id: true, order: true, status: true, duration_seconds: true, description: true, accepted_clip_artifact_id: true, updated_at: true
}).strict();
const projectMetaSchema = z.object({
  project_id: z.string(), classification: z.literal("production"), lifecycle: z.enum(["active", "archived"]), pinned: z.boolean(),
  last_opened_at: z.string().nullable(), updated_at: z.string()
}).strict();
const nextActionDerivedSchema = z.object({ label: z.string(), reason_code: z.string(), priority: prioritySchema }).strict();
export const WEBGPT_V4_NEXT_ACTION_SCHEMA = z.object({
  source: z.enum(["derived", "override"]), label: z.string(), reason_code: z.string(), priority: prioritySchema,
  expires_at: z.string().nullable(), derived: nextActionDerivedSchema
}).strict();
export const WEBGPT_V4_SUMMARY_SCHEMA = z.object({
  shot_count: z.number().int(), accepted_count: z.number().int(), active_run_count: z.number().int(), blocker_count: z.number().int(),
  blocker_reason: z.string(), review_pending_count: z.number().int(), delivery_state: z.enum(["not_ready", "ready_to_assemble", "final_review", "delivered"]),
  next_action: WEBGPT_V4_NEXT_ACTION_SCHEMA, risk: z.enum(["blocked", "attention", "clear"])
}).strict();
const pageSchema = z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int(), has_more: z.boolean(), next_offset: z.number().int().nullable() }).strict();
export const WEBGPT_V4_ARTIFACT_SCHEMA = z.object({
  artifact_id: z.string(), artifact_type: z.enum(["image", "video"]), role: z.enum(["storyboard_image", "generated_clip", "final_video"]),
  status: z.enum(["pending_upload", "active", "inaccessible", "expired", "archived"]), filename: z.string(), mime_type: z.string(),
  metadata: z.object({ width: z.number(), height: z.number(), duration_seconds: z.number().nullable(), aspect_ratio: z.string(), sha256: z.string() }).strict(),
  linked_objects: z.object({ project_id: z.string(), shot_id: z.string() }).strict(),
  provenance: z.object({ kind: z.string(), provider: z.string(), sha256: z.string() }).strict(),
  updated_at: z.string().optional()
}).strict();
export const WEBGPT_V4_COMPACT_ARTIFACT_SCHEMA = WEBGPT_V4_ARTIFACT_SCHEMA.pick({
  artifact_id: true, artifact_type: true, role: true, status: true, filename: true, mime_type: true, linked_objects: true, updated_at: true
}).extend({ metadata: WEBGPT_V4_ARTIFACT_SCHEMA.shape.metadata.omit({ sha256: true }).strict() }).strict();
export const WEBGPT_V4_REVIEW_NOTE_SCHEMA = z.object({
  note_id: z.string(), project_id: z.string(), shot_id: z.string(), artifact_id: z.string(), note: z.string(), source: z.string(), created_at: z.string(), updated_at: z.string()
}).strict();

const compactListSummarySchema = WEBGPT_V4_SUMMARY_SCHEMA.pick({
  shot_count: true, accepted_count: true, blocker_count: true, review_pending_count: true, delivery_state: true, next_action: true, risk: true
}).strict();
const projectListDataSchema = z.discriminatedUnion("detail", [
  z.object({
    detail: z.literal("compact"),
    items: z.array(z.object({ project: WEBGPT_V4_COMPACT_PROJECT_SCHEMA, lifecycle: z.enum(["active", "archived"]), pinned: z.boolean(), updated_at: z.string(), summary: compactListSummarySchema }).strict()),
    page: pageSchema
  }).strict(),
  z.object({
    detail: z.literal("full"),
    items: z.array(z.object({ project: WEBGPT_V4_PROJECT_SCHEMA, lifecycle: z.enum(["active", "archived"]), pinned: z.boolean(), last_opened_at: z.string().nullable(), updated_at: z.string(), summary: WEBGPT_V4_SUMMARY_SCHEMA }).strict()),
    page: pageSchema
  }).strict()
]);
const shotListDataSchema = z.discriminatedUnion("detail", [
  z.object({ detail: z.literal("compact"), items: z.array(WEBGPT_V4_COMPACT_SHOT_SCHEMA), page: pageSchema }).strict(),
  z.object({ detail: z.literal("full"), items: z.array(WEBGPT_V4_SHOT_SCHEMA), page: pageSchema }).strict()
]);
const mediaListDataSchema = z.discriminatedUnion("detail", [
  z.object({ detail: z.literal("compact"), items: z.array(WEBGPT_V4_COMPACT_ARTIFACT_SCHEMA), page: pageSchema }).strict(),
  z.object({ detail: z.literal("full"), items: z.array(WEBGPT_V4_ARTIFACT_SCHEMA), page: pageSchema }).strict()
]);
const metricsSchema = z.object({ shots: z.number().int(), storyboard_approved: z.number().int(), generation_active: z.number().int(), review_pending: z.number().int(), accepted_clips: z.number().int() }).strict();
const blockerSchema = z.object({ shot_id: z.string(), order: z.number(), missing_image: z.boolean(), missing_prompt: z.boolean() }).strict();
const compactContextBase = { detail: z.literal("compact"), project: WEBGPT_V4_COMPACT_PROJECT_SCHEMA, summary: WEBGPT_V4_SUMMARY_SCHEMA };
const fullContextBase = { detail: z.literal("full"), project: WEBGPT_V4_PROJECT_SCHEMA, meta: projectMetaSchema, summary: WEBGPT_V4_SUMMARY_SCHEMA };
const projectContextDataSchema = z.union([
  z.object({ ...compactContextBase, workspace: z.literal("overview"), metrics: metricsSchema, blockers: z.array(blockerSchema) }).strict(),
  z.object({ ...compactContextBase, workspace: z.literal("storyboard"), shots: z.array(WEBGPT_V4_COMPACT_SHOT_SCHEMA) }).strict(),
  z.object({ ...compactContextBase, workspace: z.literal("generation"), shots: z.array(WEBGPT_V4_COMPACT_SHOT_SCHEMA) }).strict(),
  z.object({ ...compactContextBase, workspace: z.literal("review"), shots: z.array(WEBGPT_V4_COMPACT_SHOT_SCHEMA), review_notes: z.array(WEBGPT_V4_REVIEW_NOTE_SCHEMA) }).strict(),
  z.object({ ...compactContextBase, workspace: z.literal("delivery"), ready_for_assembly: z.boolean(), accepted_clips: z.array(z.object({ shot_id: z.string(), order: z.number(), artifact: WEBGPT_V4_COMPACT_ARTIFACT_SCHEMA.nullable() }).strict()), final_artifact: WEBGPT_V4_COMPACT_ARTIFACT_SCHEMA.nullable() }).strict(),
  z.object({ ...fullContextBase, workspace: z.literal("overview"), metrics: metricsSchema, blockers: z.array(blockerSchema) }).strict(),
  z.object({ ...fullContextBase, workspace: z.literal("storyboard"), shots: z.array(WEBGPT_V4_SHOT_SCHEMA) }).strict(),
  z.object({ ...fullContextBase, workspace: z.literal("generation"), shots: z.array(WEBGPT_V4_SHOT_SCHEMA) }).strict(),
  z.object({ ...fullContextBase, workspace: z.literal("review"), shots: z.array(WEBGPT_V4_SHOT_SCHEMA), review_notes: z.array(WEBGPT_V4_REVIEW_NOTE_SCHEMA) }).strict(),
  z.object({ ...fullContextBase, workspace: z.literal("delivery"), ready_for_assembly: z.boolean(), accepted_clips: z.array(z.object({ shot_id: z.string(), order: z.number(), artifact: WEBGPT_V4_ARTIFACT_SCHEMA.nullable() }).strict()), final_artifact: WEBGPT_V4_ARTIFACT_SCHEMA.nullable() }).strict()
]);
const compactVersionSchema = clipVersionSchema.pick({ artifact_id: true, attempt_number: true, review_status: true }).strict();
const reviewPackageDataSchema = z.discriminatedUnion("detail", [
  z.object({ detail: z.literal("compact"), shot: WEBGPT_V4_COMPACT_SHOT_SCHEMA, versions: z.array(compactVersionSchema), notes: z.array(WEBGPT_V4_REVIEW_NOTE_SCHEMA), notes_total: z.number().int(), selected_artifact_id: z.string() }).strict(),
  z.object({ detail: z.literal("full"), shot: WEBGPT_V4_SHOT_SCHEMA, versions: z.array(clipVersionSchema.extend({ artifact: WEBGPT_V4_ARTIFACT_SCHEMA }).strict()), notes: z.array(WEBGPT_V4_REVIEW_NOTE_SCHEMA), notes_total: z.number().int(), selected_artifact_id: z.string() }).strict()
]);
const deliveryDataSchema = z.object({ project_id: z.string(), project_status: projectStatusSchema, shots_total: z.number().int(), shots_accepted: z.number().int(), ready_for_assembly: z.boolean(), final_artifact: WEBGPT_V4_ARTIFACT_SCHEMA.nullable(), delivered: z.boolean() }).strict();
const closeoutDataSchema = deliveryDataSchema.extend({ evidence: z.object({ source: z.literal("sqlite_structured_summary"), webgpt_audit_events: z.number().int(), raw_reports_exposed: z.literal(false) }).strict() }).strict();

export const WEBGPT_V4_READ_OUTPUT_SCHEMAS = {
  list_production_projects: resultOutputSchema(projectListDataSchema),
  get_project_context: resultOutputSchema(projectContextDataSchema),
  list_project_shots: resultOutputSchema(shotListDataSchema),
  list_project_media: resultOutputSchema(mediaListDataSchema),
  get_review_package: resultOutputSchema(reviewPackageDataSchema),
  get_delivery_status: resultOutputSchema(deliveryDataSchema),
  get_closeout_evidence: resultOutputSchema(closeoutDataSchema)
} as const;

const contractSchemas = {
  list_production_projects: resultContractSchema(projectListDataSchema),
  get_project_context: resultContractSchema(projectContextDataSchema),
  list_project_shots: resultContractSchema(shotListDataSchema),
  list_project_media: resultContractSchema(mediaListDataSchema),
  get_review_package: resultContractSchema(reviewPackageDataSchema),
  get_delivery_status: resultContractSchema(deliveryDataSchema),
  get_closeout_evidence: resultContractSchema(closeoutDataSchema)
} as const;

export const record = (value: unknown): UnknownRecord => value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
export const records = (value: unknown): UnknownRecord[] => Array.isArray(value) ? value.map(record) : [];

export function publicProject(value: unknown, compact = false): UnknownRecord {
  const item = record(value);
  return compact
    ? { project_id: item.project_id, title: item.title, status: item.status }
    : { project_id: item.project_id, title: item.title, status: item.status, shot_ids: item.shot_ids };
}

function clipVersion(value: unknown): UnknownRecord {
  const item = record(value);
  return { artifact_id: item.artifact_id, run_id: item.run_id, attempt_number: item.attempt_number, review_status: item.review_status };
}

export function publicShot(value: unknown, compact = false): UnknownRecord {
  const item = record(value);
  if (compact) return {
    shot_id: item.shot_id, project_id: item.project_id, order: item.order, status: item.status, duration_seconds: item.duration_seconds,
    description: item.description, accepted_clip_artifact_id: item.accepted_clip_artifact_id,
    ...(typeof item.updated_at === "string" ? { updated_at: item.updated_at } : {})
  };
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

export function publicSummary(value: unknown, compact = false): UnknownRecord {
  const item = record(value);
  const shared = {
    shot_count: item.shot_count, accepted_count: item.accepted_count, blocker_count: item.blocker_count,
    review_pending_count: item.review_pending_count, delivery_state: item.delivery_state, next_action: nextAction(item.next_action), risk: item.risk
  };
  return compact ? shared : { ...shared, active_run_count: item.active_run_count, blocker_reason: item.blocker_reason };
}

function page(value: unknown): UnknownRecord {
  const item = record(value);
  const hasMore = item.has_more === true;
  const offset = Number(item.offset);
  const limit = Number(item.limit);
  return { limit: item.limit, offset: item.offset, total: item.total, has_more: hasMore, next_offset: hasMore ? offset + limit : null };
}

export function publicArtifact(value: unknown, compact = false): UnknownRecord {
  const item = record(value);
  const storage = record(item.storage);
  const metadata = record(item.metadata);
  const links = record(item.linked_objects);
  const provenance = record(item.provenance ?? item.source);
  const base = {
    artifact_id: item.artifact_id, artifact_type: item.artifact_type, role: item.role, status: item.status,
    filename: item.filename ?? storage.filename, mime_type: item.mime_type ?? storage.mime_type,
    linked_objects: { project_id: links.project_id, shot_id: links.shot_id },
    ...(typeof item.updated_at === "string" ? { updated_at: item.updated_at } : {})
  };
  if (compact) return { ...base, metadata: { width: metadata.width, height: metadata.height, duration_seconds: metadata.duration_seconds, aspect_ratio: metadata.aspect_ratio } };
  return {
    ...base,
    metadata: { width: metadata.width, height: metadata.height, duration_seconds: metadata.duration_seconds, aspect_ratio: metadata.aspect_ratio, sha256: metadata.sha256 },
    provenance: { kind: provenance.kind, provider: provenance.provider, sha256: provenance.sha256 ?? metadata.sha256 }
  };
}

export function publicNote(value: unknown, projectId?: unknown, shotId?: unknown): UnknownRecord {
  const item = record(value);
  return { note_id: item.note_id, project_id: item.project_id ?? projectId, shot_id: item.shot_id ?? shotId, artifact_id: item.artifact_id, note: item.note, source: item.source, created_at: item.created_at, updated_at: item.updated_at };
}

export function validateContract<T>(schema: z.ZodType<T>, result: WebGptV4Result<unknown>, data: unknown): WebGptV4Result<unknown> {
  const candidate = result.ok ? { ok: true, data, meta: result.meta } : result;
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data as WebGptV4Result<unknown> : fail(result.meta.request_id, { code: "WEBGPT_V4_OUTPUT_CONTRACT_VIOLATION", message: "WebGPT V4 could not produce a valid public result." });
}

export function readProjectList(result: WebGptV4Result<unknown>, detail: WebGptV4Detail): WebGptV4Result<unknown> {
  if (!result.ok) return validateContract(contractSchemas.list_production_projects, result, undefined);
  const data = record(result.data);
  const compact = detail === "compact";
  return validateContract(contractSchemas.list_production_projects, result, {
    detail,
    items: records(data.items).map((value) => ({
      project: publicProject(value.project, compact), lifecycle: value.lifecycle, pinned: value.pinned,
      ...(compact ? {} : { last_opened_at: value.last_opened_at }), updated_at: value.updated_at, summary: publicSummary(value.summary, compact)
    })),
    page: page(data.page)
  });
}

export function readShotList(result: WebGptV4Result<unknown>, detail: WebGptV4Detail): WebGptV4Result<unknown> {
  if (!result.ok) return validateContract(contractSchemas.list_project_shots, result, undefined);
  const data = record(result.data);
  return validateContract(contractSchemas.list_project_shots, result, { detail, items: records(data.items).map((item) => publicShot(item, detail === "compact")), page: page(data.page) });
}

export function readMediaList(result: WebGptV4Result<unknown>, detail: WebGptV4Detail): WebGptV4Result<unknown> {
  if (!result.ok) return validateContract(contractSchemas.list_project_media, result, undefined);
  const data = record(result.data);
  return validateContract(contractSchemas.list_project_media, result, { detail, items: records(data.items).map((item) => publicArtifact(item, detail === "compact")), page: page(data.page) });
}

export function readProjectContext(result: WebGptV4Result<unknown>, detail: WebGptV4Detail): WebGptV4Result<unknown> {
  if (!result.ok) return validateContract(contractSchemas.get_project_context, result, undefined);
  const data = record(result.data);
  const compact = detail === "compact";
  const base = {
    detail, project: publicProject(data.project, compact), ...(compact ? {} : { meta: projectMeta(data.meta) }), summary: publicSummary(data.summary), workspace: data.workspace
  };
  let projected: UnknownRecord;
  if (data.workspace === "overview") {
    const metrics = record(data.metrics);
    projected = { ...base, metrics: { shots: metrics.shots, storyboard_approved: metrics.storyboard_approved, generation_active: metrics.generation_active, review_pending: metrics.review_pending, accepted_clips: metrics.accepted_clips }, blockers: records(data.blockers).map((item) => ({ shot_id: item.shot_id, order: item.order, missing_image: item.missing_image, missing_prompt: item.missing_prompt })) };
  } else if (data.workspace === "storyboard" || data.workspace === "generation") {
    projected = { ...base, shots: records(data.shots).map((item) => publicShot(item, compact)) };
  } else if (data.workspace === "review") {
    projected = { ...base, shots: records(data.version_stacks).map((item) => publicShot(item.shot, compact)), review_notes: records(data.review_notes).map((item) => publicNote(item)) };
  } else {
    projected = { ...base, ready_for_assembly: data.ready_for_assembly, accepted_clips: records(data.accepted_clips).map((item) => ({ shot_id: item.shot_id, order: item.order, artifact: item.artifact ? publicArtifact(item.artifact, compact) : null })), final_artifact: data.final_artifact ? publicArtifact(data.final_artifact, compact) : null };
  }
  return validateContract(contractSchemas.get_project_context, result, projected);
}

export function readReviewPackage(result: WebGptV4Result<unknown>, detail: WebGptV4Detail, projectId: string, shotId: string): WebGptV4Result<unknown> {
  if (!result.ok) return validateContract(contractSchemas.get_review_package, result, undefined);
  const data = record(result.data);
  const compact = detail === "compact";
  return validateContract(contractSchemas.get_review_package, result, {
    detail, shot: publicShot(data.shot, compact),
    versions: records(data.versions).map((item) => compact
      ? { artifact_id: item.artifact_id, attempt_number: item.attempt_number, review_status: item.review_status }
      : { ...clipVersion(item), artifact: publicArtifact(item.artifact) }),
    notes: records(data.notes).map((item) => publicNote(item, projectId, shotId)), notes_total: data.notes_total,
    selected_artifact_id: data.selected_artifact_id
  });
}

export function readDelivery(result: WebGptV4Result<unknown>, closeout = false): WebGptV4Result<unknown> {
  const schema = closeout ? contractSchemas.get_closeout_evidence : contractSchemas.get_delivery_status;
  if (!result.ok) return validateContract(schema, result, undefined);
  const data = record(result.data);
  return validateContract(schema, result, {
    project_id: data.project_id, project_status: data.project_status, shots_total: data.shots_total, shots_accepted: data.shots_accepted,
    ready_for_assembly: data.ready_for_assembly, final_artifact: data.final_artifact ? publicArtifact(data.final_artifact) : null, delivered: data.delivered,
    ...(closeout ? { evidence: data.evidence } : {})
  });
}

const mediaValidationSchema = z.object({
  status: z.enum(["PASS", "FAIL"]), ffprobe_exit_code: z.number().int(), has_video_stream: z.boolean(),
  duration_seconds: z.number().nullable(), stream_count: z.number().int(), error: z.string()
}).strict();
const frameSchema = z.object({ timestamp_seconds: z.number(), reason: z.enum(["coverage", "scene_change"]) }).strict();
const modelFrameSchema = frameSchema.extend({ sha256: z.string() }).strict();
const inspectionSchema = z.object({
  artifact: WEBGPT_V4_ARTIFACT_SCHEMA,
  analysis: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("image"), model_input: z.literal("original_image"), sha256: z.string(), width: z.number(), height: z.number() }).strict(),
    z.object({
      kind: z.literal("video"), model_input: z.literal("timestamped_frame_bundle"), direct_video_model_input: z.literal(false),
      analyzer_version: z.string(), validation: mediaValidationSchema, frame_plan: z.array(frameSchema), model_frames: z.array(modelFrameSchema),
      frame_page: z.object({ offset: z.number().int(), limit: z.number().int(), returned: z.number().int(), total: z.number().int(), has_more: z.boolean() }).strict(),
      scene_change_frames: z.number().int(), sha256: z.string()
    }).strict()
  ])
}).strict();

const proposalBase = {
  project_id: z.string(), shot_id: z.string(), artifact_id: z.string()
};
const proposalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ ...proposalBase, kind: z.literal("storyboard_package"), notes: z.string().optional(), expected_shot_ids: z.array(z.string()).optional() }).strict(),
  z.object({
    ...proposalBase, kind: z.literal("review_decision"), decision: z.enum(["approved", "revision_needed"]),
    rejection_reasons: z.array(z.string()).optional(), revision_instruction: revisionInstructionSchema.optional()
  }).strict(),
  z.object({
    ...proposalBase, kind: z.literal("regeneration"), previous_run_id: z.string().optional(), prompt_delta: z.string(),
    negative_delta: z.string().optional(), notes: z.string().optional()
  }).strict(),
  z.object({ ...proposalBase, kind: z.literal("final_assembly"), notes: z.string().optional() }).strict(),
  z.object({ ...proposalBase, kind: z.literal("memory_saveback"), proposal_id: z.string().optional(), notes: z.string() }).strict(),
  z.object({ ...proposalBase, kind: z.literal("package_freeze"), notes: z.string().optional(), expected_shot_ids: z.array(z.string()).optional() }).strict()
]);
const proposalDraftSchema = z.object({
  draft_id: z.string(), tool: z.string(), status: z.enum(["pending", "revision_needed", "promoted", "closed"]), source: z.literal("webgpt_v4"),
  created_at: z.string(), updated_at: z.string(), parent_draft_id: z.string().nullable(), target_project_id: z.string(), target_shot_id: z.string(),
  promoted_object_type: z.string().nullable(), promoted_object_id: z.string().nullable(), revision_note: z.string().nullable(), payload: proposalPayloadSchema
}).strict();
const generationIntentSchema = z.object({
  intent_id: z.string(), project_id: z.string(), shot_id: z.string(), provider: z.literal("runninghub"), account_label: z.enum(["personal", "team"]),
  model: z.literal("runninghub_kling_3_0_image_to_video"), input_artifact_id: z.string(), estimated_cost_value: z.number(), budget_limit_value: z.number(),
  currency: z.string(), confirmed: z.literal(false), status: z.literal("prepared"), expires_at: z.string(), requires_human_preflight: z.literal(true),
  provider_call_attempted: z.literal(false)
}).strict();

const fullDataSchemas = {
  inspect_media: inspectionSchema,
  update_shot_copy: z.object({ shot: WEBGPT_V4_SHOT_SCHEMA, updated_at: z.string() }).strict(),
  add_review_note: WEBGPT_V4_REVIEW_NOTE_SCHEMA,
  submit_production_proposal: z.object({ draft: proposalDraftSchema }).strict(),
  revise_production_proposal: z.object({ draft: proposalDraftSchema, closed_draft_id: z.string() }).strict(),
  close_production_proposal: z.object({ draft: proposalDraftSchema }).strict(),
  prepare_generation_intent: generationIntentSchema
} as const;

export const WEBGPT_V4_FULL_OUTPUT_SCHEMAS = {
  inspect_media: resultOutputSchema(fullDataSchemas.inspect_media),
  update_shot_copy: resultOutputSchema(fullDataSchemas.update_shot_copy),
  add_review_note: resultOutputSchema(fullDataSchemas.add_review_note),
  submit_production_proposal: resultOutputSchema(fullDataSchemas.submit_production_proposal),
  revise_production_proposal: resultOutputSchema(fullDataSchemas.revise_production_proposal),
  close_production_proposal: resultOutputSchema(fullDataSchemas.close_production_proposal),
  prepare_generation_intent: resultOutputSchema(fullDataSchemas.prepare_generation_intent)
} as const;

const fullContractSchemas = {
  inspect_media: resultContractSchema(fullDataSchemas.inspect_media),
  update_shot_copy: resultContractSchema(fullDataSchemas.update_shot_copy),
  add_review_note: resultContractSchema(fullDataSchemas.add_review_note),
  submit_production_proposal: resultContractSchema(fullDataSchemas.submit_production_proposal),
  revise_production_proposal: resultContractSchema(fullDataSchemas.revise_production_proposal),
  close_production_proposal: resultContractSchema(fullDataSchemas.close_production_proposal),
  prepare_generation_intent: resultContractSchema(fullDataSchemas.prepare_generation_intent)
} as const;

function publicInspection(value: unknown): UnknownRecord {
  const item = record(value);
  const analysis = record(item.analysis);
  if (analysis.kind === "image") return {
    artifact: publicArtifact(item.artifact),
    analysis: { kind: "image", model_input: "original_image", sha256: analysis.sha256, width: analysis.width, height: analysis.height }
  };
  const validation = record(analysis.validation);
  const framePage = record(analysis.frame_page);
  return {
    artifact: publicArtifact(item.artifact),
    analysis: {
      kind: "video", model_input: "timestamped_frame_bundle", direct_video_model_input: false, analyzer_version: analysis.analyzer_version,
      validation: {
        status: validation.status, ffprobe_exit_code: validation.ffprobe_exit_code, has_video_stream: validation.has_video_stream,
        duration_seconds: validation.duration_seconds, stream_count: validation.stream_count, error: validation.error
      },
      frame_plan: records(analysis.frame_plan).map((frame) => ({ timestamp_seconds: frame.timestamp_seconds, reason: frame.reason })),
      model_frames: records(analysis.model_frames).map((frame) => ({ timestamp_seconds: frame.timestamp_seconds, reason: frame.reason, sha256: frame.sha256 })),
      frame_page: { offset: framePage.offset, limit: framePage.limit, returned: framePage.returned, total: framePage.total, has_more: framePage.has_more },
      scene_change_frames: analysis.scene_change_frames, sha256: analysis.sha256
    }
  };
}

function optionalString(item: UnknownRecord, key: string): string | undefined {
  return typeof item[key] === "string" ? item[key] as string : undefined;
}

function publicProposalPayload(value: unknown): UnknownRecord {
  const item = record(value);
  const base = { kind: item.kind, project_id: item.project_id, shot_id: item.shot_id, artifact_id: item.artifact_id };
  if (item.kind === "storyboard_package" || item.kind === "package_freeze") return {
    ...base, ...(optionalString(item, "notes") !== undefined ? { notes: item.notes } : {}),
    ...(Array.isArray(item.expected_shot_ids) ? { expected_shot_ids: item.expected_shot_ids } : {})
  };
  if (item.kind === "review_decision") {
    const instruction = record(item.revision_instruction);
    return {
      ...base, decision: item.decision,
      ...(Array.isArray(item.rejection_reasons) ? { rejection_reasons: item.rejection_reasons } : {}),
      ...(item.revision_instruction ? { revision_instruction: { summary: instruction.summary, prompt_delta: instruction.prompt_delta, negative_delta: instruction.negative_delta, priority: instruction.priority } } : {})
    };
  }
  if (item.kind === "regeneration") return {
    ...base, prompt_delta: item.prompt_delta,
    ...(optionalString(item, "previous_run_id") !== undefined ? { previous_run_id: item.previous_run_id } : {}),
    ...(optionalString(item, "negative_delta") !== undefined ? { negative_delta: item.negative_delta } : {}),
    ...(optionalString(item, "notes") !== undefined ? { notes: item.notes } : {})
  };
  if (item.kind === "memory_saveback") return { ...base, notes: item.notes, ...(optionalString(item, "proposal_id") !== undefined ? { proposal_id: item.proposal_id } : {}) };
  return { ...base, ...(optionalString(item, "notes") !== undefined ? { notes: item.notes } : {}) };
}

function publicDraft(value: unknown): UnknownRecord {
  const item = record(value);
  const nullable = (key: string): string | null => typeof item[key] === "string" && item[key] ? item[key] as string : null;
  return {
    draft_id: item.draft_id, tool: item.tool, status: item.status, source: item.source, created_at: item.created_at, updated_at: item.updated_at,
    parent_draft_id: nullable("parent_draft_id"), target_project_id: item.target_project_id, target_shot_id: typeof item.target_shot_id === "string" ? item.target_shot_id : "",
    promoted_object_type: nullable("promoted_object_type"), promoted_object_id: nullable("promoted_object_id"), revision_note: nullable("revision_note"),
    payload: publicProposalPayload(item.payload)
  };
}

export function fullInspection(result: WebGptV4Result<unknown>): WebGptV4Result<unknown> {
  return validateContract(fullContractSchemas.inspect_media, result, result.ok ? publicInspection(result.data) : undefined);
}

export function fullShotCopy(result: WebGptV4Result<unknown>): WebGptV4Result<unknown> {
  const data = result.ok ? record(result.data) : {};
  return validateContract(fullContractSchemas.update_shot_copy, result, result.ok ? { shot: publicShot(data.shot), updated_at: data.updated_at } : undefined);
}

export function fullReviewNote(result: WebGptV4Result<unknown>): WebGptV4Result<unknown> {
  return validateContract(fullContractSchemas.add_review_note, result, result.ok ? publicNote(result.data) : undefined);
}

export function fullProposal(result: WebGptV4Result<unknown>, mode: "submit" | "revise" | "close"): WebGptV4Result<unknown> {
  const schema = mode === "submit" ? fullContractSchemas.submit_production_proposal : mode === "revise" ? fullContractSchemas.revise_production_proposal : fullContractSchemas.close_production_proposal;
  const data = result.ok ? record(result.data) : {};
  return validateContract(schema, result, result.ok ? { draft: publicDraft(data.draft), ...(mode === "revise" ? { closed_draft_id: data.closed_draft_id } : {}) } : undefined);
}

export function fullGenerationIntent(result: WebGptV4Result<unknown>): WebGptV4Result<unknown> {
  const data = result.ok ? record(result.data) : {};
  return validateContract(fullContractSchemas.prepare_generation_intent, result, result.ok ? {
    intent_id: data.intent_id, project_id: data.project_id, shot_id: data.shot_id, provider: data.provider, account_label: data.account_label,
    model: data.model, input_artifact_id: data.input_artifact_id, estimated_cost_value: data.estimated_cost_value, budget_limit_value: data.budget_limit_value,
    currency: data.currency, confirmed: data.confirmed, status: data.status, expires_at: data.expires_at,
    requires_human_preflight: data.requires_human_preflight, provider_call_attempted: data.provider_call_attempted
  } : undefined);
}
