import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalizeJcs } from "../packages/domain/jcs.js";
import { DIRECTOR_SUPPORTED_CURRENCIES } from "./currency.js";

export const DIRECTOR_DOMAIN_SCHEMA_VERSION = "director-domain-v1";
export const STORYBOARD_PACKAGE_V2_SCHEMA_VERSION = "storyboard-package-v2";

const idSchema = z.string().trim().min(1).max(160);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.iso.datetime();
const nullableIdSchema = idSchema.nullable();
const nullableHashSchema = hashSchema.nullable();
const nonEmptyTextSchema = z.string().trim().min(1).max(16_384);
const shortTextSchema = z.string().trim().min(1).max(1_024);

const artifactImportSafeMimeReferencePattern = /\b(?:image\/(?:jpeg|png)|video\/mp4)\b/giu;
const artifactImportSourceLocatorPattern = /(?:\b[a-z][a-z0-9+.-]*:\/\/|(?:^|[\s"'(])(?:[a-z]:[\\/]|\\\\|\/(?:[^/\s]+\/)+[^/\s]+|(?:~|\.{1,2}|[A-Za-z0-9_.-]+)[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]+)|\bdata:[^\s,;]+;base64,|(?:^|[^A-Za-z0-9+/=])[A-Za-z0-9+/]{64,}={0,2}(?=$|[^A-Za-z0-9+/=]))/iu;

function artifactImportTextHasSourceLocator(value: string): boolean {
  // MIME names are already constrained by expected_mime_type and may be used
  // as explanatory prose.  Every other filesystem-style slash token is a
  // locator, not an import instruction, and is forbidden from the ledger.
  return artifactImportSourceLocatorPattern.test(value.replace(artifactImportSafeMimeReferencePattern, ""));
}

/**
 * Artifact-import prose may explain the requested role and evidence, but it
 * must never smuggle a filesystem locator, external URL, data URL, or bytes
 * into immutable proposal storage.  Actual selection stays in the local
 * Workbench's controlled file picker and Artifact validator.
 */
const artifactImportTextSchema = nonEmptyTextSchema.refine(
  (value) => !artifactImportTextHasSourceLocator(value),
  "DIRECTOR_ARTIFACT_IMPORT_SOURCE_LOCATOR_FORBIDDEN"
);

export const DIRECTOR_PROPOSAL_KIND_SCHEMA = z.enum([
  "creative_brief",
  "script",
  "shot_plan",
  "storyboard_revision",
  "artifact_import",
  "generation_plan",
  "clip_regeneration",
  "review_assessment",
  "assembly_plan",
  "delivery_plan",
  "memory_saveback"
]);

export const DIRECTOR_TARGET_TYPE_SCHEMA = z.enum([
  "project",
  "shot",
  "artifact",
  "storyboard_package",
  "generation_run",
  "delivery",
  "memory"
]);

const projectStateSchema = z.object({
  project_id: idSchema,
  status: z.enum(["draft", "storyboard_approved", "video_generation_in_progress", "video_review", "final_approved"]),
  lifecycle_state: z.enum(["active", "archived"]),
  video_spec: z.object({
    duration_seconds: z.number().finite().positive(),
    aspect_ratio: shortTextSchema,
    resolution: shortTextSchema
  }).strict(),
  creative_direction_hash: nullableHashSchema,
  current_storyboard_package_id: nullableIdSchema,
  current_storyboard_package_hash: nullableHashSchema
}).strict().superRefine((value, context) => {
  if ((value.current_storyboard_package_id === null) !== (value.current_storyboard_package_hash === null)) {
    context.addIssue({
      code: "custom",
      message: "Current Storyboard Package id and hash must be present or absent together.",
      path: ["current_storyboard_package_id"]
    });
  }
});

const shotStateSchema = z.object({
  shot_id: idSchema,
  project_id: idSchema,
  order: z.number().int().nonnegative(),
  status: z.enum(["draft", "storyboard_approved", "video_pending", "video_generated", "video_review", "approved", "revision_needed"]),
  duration_seconds: z.number().finite().positive(),
  storyboard_artifact_id: nullableIdSchema,
  storyboard_artifact_sha256: nullableHashSchema,
  accepted_clip_artifact_id: nullableIdSchema,
  accepted_clip_artifact_sha256: nullableHashSchema,
  prompt_hash: hashSchema,
  negative_prompt_hash: hashSchema,
  continuity_hash: hashSchema,
  current_generation_input_hash: nullableHashSchema,
  current_review_decision_event_id: nullableIdSchema
}).strict().superRefine((value, context) => {
  for (const [idField, hashField] of [
    ["storyboard_artifact_id", "storyboard_artifact_sha256"],
    ["accepted_clip_artifact_id", "accepted_clip_artifact_sha256"]
  ] as const) {
    if ((value[idField] === null) !== (value[hashField] === null)) {
      context.addIssue({
        code: "custom",
        message: `${idField} and ${hashField} must be present or absent together.`,
        path: [idField]
      });
    }
  }
});

const artifactStateSchema = z.object({
  artifact_id: idSchema,
  project_id: idSchema,
  shot_id: nullableIdSchema,
  artifact_type: z.enum(["image", "video"]),
  role: z.enum(["storyboard_image", "generated_clip", "final_video"]),
  status: z.enum(["pending_upload", "active", "archived", "inaccessible", "expired"]),
  sha256: hashSchema
}).strict().superRefine((value, context) => {
  const expectedType = value.role === "storyboard_image" ? "image" : "video";
  if (value.artifact_type !== expectedType) {
    context.addIssue({
      code: "custom",
      message: `Artifact role ${value.role} requires type ${expectedType}.`,
      path: ["artifact_type"]
    });
  }
});

const generationStateSchema = z.object({
  prepared_intent_id: nullableIdSchema,
  frozen_input_hash: nullableHashSchema,
  latest_run_id: nullableIdSchema,
  latest_job_state: z.enum([
    "queued",
    "submitting",
    "polling",
    "downloading",
    "finalizing",
    "manual_reconciliation",
    "succeeded",
    "failed",
    "cancelled"
  ]).nullable()
}).strict().superRefine((value, context) => {
  if ((value.prepared_intent_id === null) !== (value.frozen_input_hash === null)) {
    context.addIssue({
      code: "custom",
      message: "Prepared intent id and frozen input hash must be present or absent together.",
      path: ["prepared_intent_id"]
    });
  }
  if (value.latest_job_state !== null && value.latest_run_id === null) {
    context.addIssue({
      code: "custom",
      message: "A latest job state requires a latest Generation Run id.",
      path: ["latest_job_state"]
    });
  }
});

export const DIRECTOR_TARGET_STATE_V1_SCHEMA = z.object({
  schema_version: z.literal(DIRECTOR_DOMAIN_SCHEMA_VERSION),
  proposal_kind: DIRECTOR_PROPOSAL_KIND_SCHEMA,
  project: projectStateSchema,
  target_shot: shotStateSchema.nullable(),
  adjacent_shots: z.array(shotStateSchema).max(2),
  target_artifact: artifactStateSchema.nullable(),
  generation: generationStateSchema.nullable()
}).strict().superRefine((value, context) => {
  const shotIds = new Set<string>();
  if (value.target_shot && value.adjacent_shots.some((shot) => shot.shot_id === value.target_shot?.shot_id)) {
    context.addIssue({ code: "custom", message: "Adjacent SHOTs must not repeat the target SHOT.", path: ["adjacent_shots"] });
  }
  for (const [index, shot] of value.adjacent_shots.entries()) {
    if (shotIds.has(shot.shot_id)) {
      context.addIssue({ code: "custom", message: "Adjacent SHOT ids must be unique.", path: ["adjacent_shots", index, "shot_id"] });
    }
    shotIds.add(shot.shot_id);
    if (shot.project_id !== value.project.project_id) {
      context.addIssue({ code: "custom", message: "Adjacent SHOT must belong to the target Project.", path: ["adjacent_shots", index, "project_id"] });
    }
  }
  if (value.target_shot?.project_id !== undefined && value.target_shot.project_id !== value.project.project_id) {
    context.addIssue({ code: "custom", message: "Target SHOT must belong to the target Project.", path: ["target_shot", "project_id"] });
  }
  if (value.target_artifact && value.target_artifact.project_id !== value.project.project_id) {
    context.addIssue({ code: "custom", message: "Target Artifact must belong to the target Project.", path: ["target_artifact", "project_id"] });
  }
  if (value.target_artifact && value.target_artifact.shot_id !== (value.target_shot?.shot_id ?? null)) {
    context.addIssue({ code: "custom", message: "Target Artifact must belong to the target SHOT.", path: ["target_artifact", "shot_id"] });
  }
});

export type DirectorTargetStateV1 = z.infer<typeof DIRECTOR_TARGET_STATE_V1_SCHEMA>;

export function directorContentHash(value: unknown): string {
  return createHash("sha256").update(canonicalizeJcs(value), "utf8").digest("hex");
}

export function directorBaseStateHash(value: DirectorTargetStateV1): string {
  return directorContentHash(DIRECTOR_TARGET_STATE_V1_SCHEMA.parse(value));
}

const proposalCommonShape = {
  proposal_id: idSchema,
  schema_version: z.literal(DIRECTOR_DOMAIN_SCHEMA_VERSION),
  workspace_id: z.literal("jenn-ai-video-workspace"),
  principal_id: hashSchema,
  project_id: idSchema,
  target_type: DIRECTOR_TARGET_TYPE_SCHEMA,
  target_id: idSchema,
  focus_id: idSchema,
  focus_generation: z.number().int().positive(),
  base_state_hash: hashSchema,
  payload_hash: hashSchema,
  parent_proposal_id: nullableIdSchema,
  idempotency_key: z.string().trim().min(16).max(160),
  source: z.enum(["native", "untrusted_manual_import"]),
  created_at: timestampSchema
} as const;

const creativeBriefPayloadSchema = z.object({
  summary: nonEmptyTextSchema,
  objectives: z.array(shortTextSchema).min(1).max(20),
  constraints: z.array(shortTextSchema).max(30),
  proposed_brief: z.object({
    title: shortTextSchema,
    audience: shortTextSchema,
    key_message: nonEmptyTextSchema,
    creative_direction: nonEmptyTextSchema,
    call_to_action: z.string().max(4_096)
  }).strict()
}).strict();

const scriptPayloadSchema = z.object({
  script_text: nonEmptyTextSchema,
  rationale: nonEmptyTextSchema,
  shot_count_target: z.number().int().positive().max(100)
}).strict();

const shotPlanPayloadSchema = z.object({
  shots: z.array(z.object({
    order: z.number().int().nonnegative(),
    description: nonEmptyTextSchema,
    duration_seconds: z.number().finite().positive().max(120),
    continuity_constraints: z.array(shortTextSchema).max(30)
  }).strict()).min(1).max(100),
  rationale: nonEmptyTextSchema
}).strict();

const storyboardRevisionPayloadSchema = z.object({
  shot_id: idSchema,
  diagnosis: nonEmptyTextSchema,
  keep: z.array(shortTextSchema).max(30),
  change: z.array(shortTextSchema).min(1).max(30),
  storyboard_prompt: nonEmptyTextSchema,
  negative_prompt: z.string().max(16_384),
  composition_notes: z.string().max(8_192),
  continuity_constraints: z.array(shortTextSchema).max(30)
}).strict();

/**
 * A model can request that a human import a local asset for one SHOT, but it
 * never supplies a pathname, URL, bytes, or an instruction to inspect an
 * arbitrary local file.  The Workbench owns the subsequent file-selection and
 * existing Artifact/Blob validation boundary.
 */
/**
 * These types deliberately match the existing local Artifact/Blob byte
 * validators.  The media gateway supports a wider playback allowlist, but a
 * Director import receipt is an authoritative local-evidence operation and
 * must not accept a proposal that the current import boundary cannot verify.
 */
export const DIRECTOR_ARTIFACT_IMPORT_SUPPORTED_MIME_TYPES = ["image/jpeg", "image/png", "video/mp4"] as const;

export const DIRECTOR_ARTIFACT_IMPORT_PAYLOAD_SCHEMA = z.object({
  shot_id: idSchema,
  target_role: z.enum(["storyboard_image", "generated_clip"]),
  expected_mime_type: z.enum(DIRECTOR_ARTIFACT_IMPORT_SUPPORTED_MIME_TYPES),
  summary: artifactImportTextSchema,
  rationale: artifactImportTextSchema
}).strict().superRefine((value, context) => {
  const imageRole = value.target_role === "storyboard_image";
  const imageMime = value.expected_mime_type.startsWith("image/");
  if (imageRole !== imageMime) {
    context.addIssue({
      code: "custom",
      message: "Storyboard imports require an image MIME type and clip imports require a video MIME type.",
      path: ["expected_mime_type"]
    });
  }
});

const generationPlanPayloadSchema = z.object({
  shot_id: idSchema,
  provider: z.literal("runninghub"),
  model: shortTextSchema,
  duration_seconds: z.number().int().positive().max(120),
  resolution: shortTextSchema,
  video_prompt: nonEmptyTextSchema,
  negative_prompt: z.string().max(16_384),
  continuity_constraints: z.array(shortTextSchema).max(30),
  estimated_cost_minor: z.number().int().nonnegative(),
  currency: z.enum(DIRECTOR_SUPPORTED_CURRENCIES)
}).strict();

const clipRegenerationPayloadSchema = generationPlanPayloadSchema.extend({
  current_artifact_id: idSchema,
  reason_codes: z.array(z.string().regex(/^[A-Z0-9_]{3,64}$/)).min(1).max(20),
  prompt_delta: nonEmptyTextSchema,
  negative_delta: z.string().max(8_192)
}).strict();

const reviewAssessmentPayloadSchema = z.object({
  shot_id: idSchema,
  artifact_id: idSchema,
  diagnosis: nonEmptyTextSchema,
  evidence: z.array(z.object({
    timestamp_seconds: z.number().finite().nonnegative(),
    observation: shortTextSchema
  }).strict()).max(40),
  recommended_disposition: z.enum(["keep_reviewing", "regenerate", "escalate_to_human"]),
  prompt_delta: z.string().max(16_384),
  continuity_delta: z.array(shortTextSchema).max(30),
  confidence: z.number().finite().min(0).max(1)
}).strict();

const assemblyPlanPayloadSchema = z.object({
  ordered_artifact_ids: z.array(idSchema).min(1).max(100),
  notes: z.string().max(16_384),
  requires_human_confirmation: z.literal(true)
}).strict();

const deliveryPlanPayloadSchema = z.object({
  final_artifact_id: idSchema,
  checklist: z.array(shortTextSchema).min(1).max(50),
  notes: z.string().max(16_384),
  requires_human_confirmation: z.literal(true)
}).strict();

const memorySavebackPayloadSchema = z.object({
  items: z.array(z.object({
    category: z.enum(["preference", "decision", "failure_pattern", "reusable_rule", "provider_learning"]),
    summary: shortTextSchema,
    evidence: z.array(shortTextSchema).min(1).max(20),
    scope: z.enum(["project", "workspace"])
  }).strict()).min(1).max(30),
  requires_human_confirmation: z.literal(true)
}).strict();

/**
 * The only proposal material ChatGPT is allowed to author directly. Identity,
 * project/target binding, hashes derived from the payload, source and creation
 * time are assigned by the authenticated local bridge rather than trusted from
 * model input.
 */
export const DIRECTOR_PROPOSAL_DRAFT_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("creative_brief"), payload: creativeBriefPayloadSchema }).strict(),
  z.object({ kind: z.literal("script"), payload: scriptPayloadSchema }).strict(),
  z.object({ kind: z.literal("shot_plan"), payload: shotPlanPayloadSchema }).strict(),
  z.object({ kind: z.literal("storyboard_revision"), payload: storyboardRevisionPayloadSchema }).strict(),
  z.object({ kind: z.literal("artifact_import"), payload: DIRECTOR_ARTIFACT_IMPORT_PAYLOAD_SCHEMA }).strict(),
  z.object({ kind: z.literal("generation_plan"), payload: generationPlanPayloadSchema }).strict(),
  z.object({ kind: z.literal("clip_regeneration"), payload: clipRegenerationPayloadSchema }).strict(),
  z.object({ kind: z.literal("review_assessment"), payload: reviewAssessmentPayloadSchema }).strict(),
  z.object({ kind: z.literal("assembly_plan"), payload: assemblyPlanPayloadSchema }).strict(),
  z.object({ kind: z.literal("delivery_plan"), payload: deliveryPlanPayloadSchema }).strict(),
  z.object({ kind: z.literal("memory_saveback"), payload: memorySavebackPayloadSchema }).strict()
]);

export type DirectorProposalDraft = z.infer<typeof DIRECTOR_PROPOSAL_DRAFT_SCHEMA>;

const directorProposalShapeSchema = z.discriminatedUnion("kind", [
  z.object({ ...proposalCommonShape, kind: z.literal("creative_brief"), payload: creativeBriefPayloadSchema }).strict(),
  z.object({ ...proposalCommonShape, kind: z.literal("script"), payload: scriptPayloadSchema }).strict(),
  z.object({ ...proposalCommonShape, kind: z.literal("shot_plan"), payload: shotPlanPayloadSchema }).strict(),
  z.object({ ...proposalCommonShape, kind: z.literal("storyboard_revision"), payload: storyboardRevisionPayloadSchema }).strict(),
  z.object({ ...proposalCommonShape, kind: z.literal("artifact_import"), payload: DIRECTOR_ARTIFACT_IMPORT_PAYLOAD_SCHEMA }).strict(),
  z.object({ ...proposalCommonShape, kind: z.literal("generation_plan"), payload: generationPlanPayloadSchema }).strict(),
  z.object({ ...proposalCommonShape, kind: z.literal("clip_regeneration"), payload: clipRegenerationPayloadSchema }).strict(),
  z.object({ ...proposalCommonShape, kind: z.literal("review_assessment"), payload: reviewAssessmentPayloadSchema }).strict(),
  z.object({ ...proposalCommonShape, kind: z.literal("assembly_plan"), payload: assemblyPlanPayloadSchema }).strict(),
  z.object({ ...proposalCommonShape, kind: z.literal("delivery_plan"), payload: deliveryPlanPayloadSchema }).strict(),
  z.object({ ...proposalCommonShape, kind: z.literal("memory_saveback"), payload: memorySavebackPayloadSchema }).strict()
]);

function validateProposalTarget(value: z.infer<typeof directorProposalShapeSchema>, context: z.core.$RefinementCtx): void {
  const requireTarget = (targetType: z.infer<typeof DIRECTOR_TARGET_TYPE_SCHEMA>, targetId: string): void => {
    if (value.target_type !== targetType) {
      context.addIssue({ code: "custom", message: `Proposal kind ${value.kind} requires target type ${targetType}.`, path: ["target_type"] });
    }
    if (value.target_id !== targetId) {
      context.addIssue({ code: "custom", message: `Proposal kind ${value.kind} is not bound to its payload target.`, path: ["target_id"] });
    }
  };
  switch (value.kind) {
    case "creative_brief":
    case "script":
    case "shot_plan":
    case "assembly_plan":
      requireTarget("project", value.project_id);
      break;
    case "storyboard_revision":
    case "artifact_import":
    case "generation_plan":
      requireTarget("shot", value.payload.shot_id);
      break;
    case "clip_regeneration":
      if (value.target_type === "artifact") requireTarget("artifact", value.payload.current_artifact_id);
      else requireTarget("shot", value.payload.shot_id);
      break;
    case "review_assessment":
      if (value.target_type === "artifact") requireTarget("artifact", value.payload.artifact_id);
      else requireTarget("shot", value.payload.shot_id);
      break;
    case "delivery_plan":
      requireTarget("delivery", value.project_id);
      break;
    case "memory_saveback":
      requireTarget("memory", value.project_id);
      break;
  }
}

export const DIRECTOR_PROPOSAL_SCHEMA = directorProposalShapeSchema.superRefine(validateProposalTarget);

export type DirectorProposal = z.infer<typeof DIRECTOR_PROPOSAL_SCHEMA>;

export function validateDirectorProposal(value: unknown): DirectorProposal {
  const proposal = DIRECTOR_PROPOSAL_SCHEMA.parse(value);
  if (proposal.payload_hash !== directorContentHash(proposal.payload)) throw new Error("DIRECTOR_PROPOSAL_PAYLOAD_HASH_MISMATCH");
  return proposal;
}

export interface ValidatedDirectorProposalTarget {
  proposal: DirectorProposal;
  target_state: DirectorTargetStateV1;
}

/**
 * Binds a Proposal to the exact authoritative state captured for it. This is a
 * pure contract check: proposal ingestion and later compilation must both call
 * it, while the caller remains responsible for building the state from current
 * authoritative rows.
 */
export function validateDirectorProposalAgainstTargetState(
  proposalValue: unknown,
  targetStateValue: unknown
): ValidatedDirectorProposalTarget {
  const proposal = validateDirectorProposal(proposalValue);
  const targetState = DIRECTOR_TARGET_STATE_V1_SCHEMA.parse(targetStateValue);
  if (proposal.kind !== targetState.proposal_kind) throw new Error("DIRECTOR_PROPOSAL_KIND_STATE_MISMATCH");
  if (proposal.project_id !== targetState.project.project_id) throw new Error("DIRECTOR_PROPOSAL_PROJECT_STATE_MISMATCH");
  if (proposal.base_state_hash !== directorBaseStateHash(targetState)) throw new Error("DIRECTOR_PROPOSAL_BASE_STATE_MISMATCH");

  const targetShotId = targetState.target_shot?.shot_id ?? null;
  const targetArtifactId = targetState.target_artifact?.artifact_id ?? null;
  switch (proposal.target_type) {
    case "project":
    case "delivery":
    case "memory":
      if (proposal.target_id !== targetState.project.project_id) throw new Error("DIRECTOR_PROPOSAL_TARGET_STATE_MISMATCH");
      break;
    case "shot":
      if (targetShotId === null || proposal.target_id !== targetShotId) throw new Error("DIRECTOR_PROPOSAL_TARGET_STATE_MISMATCH");
      break;
    case "artifact":
      if (targetArtifactId === null || proposal.target_id !== targetArtifactId) throw new Error("DIRECTOR_PROPOSAL_TARGET_STATE_MISMATCH");
      break;
    case "storyboard_package":
      if (proposal.target_id !== targetState.project.current_storyboard_package_id) throw new Error("DIRECTOR_PROPOSAL_TARGET_STATE_MISMATCH");
      break;
    case "generation_run":
      if (proposal.target_id !== targetState.generation?.latest_run_id) throw new Error("DIRECTOR_PROPOSAL_TARGET_STATE_MISMATCH");
      break;
  }

  switch (proposal.kind) {
    case "storyboard_revision":
    case "artifact_import":
    case "generation_plan":
      if (proposal.payload.shot_id !== targetShotId) throw new Error("DIRECTOR_PROPOSAL_SHOT_STATE_MISMATCH");
      break;
    case "clip_regeneration":
      if (proposal.payload.shot_id !== targetShotId || proposal.payload.current_artifact_id !== targetArtifactId) {
        throw new Error("DIRECTOR_PROPOSAL_ARTIFACT_STATE_MISMATCH");
      }
      break;
    case "review_assessment":
      if (proposal.payload.shot_id !== targetShotId || proposal.payload.artifact_id !== targetArtifactId) {
        throw new Error("DIRECTOR_PROPOSAL_ARTIFACT_STATE_MISMATCH");
      }
      break;
    case "delivery_plan":
      if (proposal.payload.final_artifact_id !== targetArtifactId || targetState.target_artifact?.role !== "final_video") {
        throw new Error("DIRECTOR_PROPOSAL_FINAL_ARTIFACT_STATE_MISMATCH");
      }
      break;
    default:
      break;
  }
  return { proposal, target_state: targetState };
}

export const DIRECTOR_ARTIFACT_IMPORT_RECEIPT_SCHEMA = z.object({
  receipt_id: idSchema,
  proposal_id: idSchema,
  project_id: idSchema,
  shot_id: idSchema,
  artifact_id: idSchema,
  blob_sha256: hashSchema,
  role: z.enum(["storyboard_image", "generated_clip"]),
  mime_type: z.enum(DIRECTOR_ARTIFACT_IMPORT_SUPPORTED_MIME_TYPES),
  created_at: timestampSchema
}).strict().superRefine((value, context) => {
  const imageRole = value.role === "storyboard_image";
  const imageMime = value.mime_type.startsWith("image/");
  if (imageRole !== imageMime) {
    context.addIssue({
      code: "custom",
      message: "Artifact import receipt role and MIME type are inconsistent.",
      path: ["mime_type"]
    });
  }
});

export type DirectorArtifactImportReceipt = z.infer<typeof DIRECTOR_ARTIFACT_IMPORT_RECEIPT_SCHEMA>;

export function validateDirectorArtifactImportReceipt(value: unknown): DirectorArtifactImportReceipt {
  return DIRECTOR_ARTIFACT_IMPORT_RECEIPT_SCHEMA.parse(value);
}

export const DIRECTOR_FOCUS_SCHEMA = z.object({
  focus_id: idSchema,
  workspace_id: z.literal("jenn-ai-video-workspace"),
  principal_id: hashSchema,
  project_id: idSchema,
  target_type: DIRECTOR_TARGET_TYPE_SCHEMA,
  target_id: idSchema,
  generation: z.number().int().positive(),
  supersedes_focus_id: nullableIdSchema,
  created_at: timestampSchema,
  expires_at: timestampSchema
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expires_at) <= Date.parse(value.created_at)) {
    context.addIssue({ code: "custom", message: "Director Focus must expire after it is created.", path: ["expires_at"] });
  }
});

export type DirectorFocus = z.infer<typeof DIRECTOR_FOCUS_SCHEMA>;

const directorAutomationGrantShape = {
  grant_id: idSchema,
  workspace_id: z.literal("jenn-ai-video-workspace"),
  principal_id: hashSchema,
  project_id: idSchema,
  provider: z.literal("runninghub"),
  allowed_actions: z.array(z.enum(["generation.submit", "generation.retry", "generation.download", "artifact.activate"])).min(1).max(4),
  currency: z.enum(DIRECTOR_SUPPORTED_CURRENCIES),
  max_total_minor: z.number().int().positive(),
  max_per_run_minor: z.number().int().positive(),
  max_versions_per_shot: z.number().int().positive().max(20),
  max_automatic_retries: z.number().int().nonnegative().max(5),
  pricing_contract_version: shortTextSchema,
  capability_contract_version: shortTextSchema,
  starts_at: timestampSchema,
  expires_at: timestampSchema,
  created_at: timestampSchema
} as const;

function validateAutomationGrantLimits(
  value: { allowed_actions: string[]; max_per_run_minor: number; max_total_minor: number; max_automatic_retries: number; starts_at: string; expires_at: string },
  context: z.core.$RefinementCtx
): void {
  if (new Set(value.allowed_actions).size !== value.allowed_actions.length) {
    context.addIssue({ code: "custom", message: "Automation Grant actions must be unique.", path: ["allowed_actions"] });
  }
  if (value.max_per_run_minor > value.max_total_minor) {
    context.addIssue({ code: "custom", message: "Per-run budget cannot exceed total budget.", path: ["max_per_run_minor"] });
  }
  if (Date.parse(value.expires_at) <= Date.parse(value.starts_at)) {
    context.addIssue({ code: "custom", message: "Automation Grant must expire after it starts.", path: ["expires_at"] });
  }
  const retryAllowed = value.allowed_actions.includes("generation.retry");
  if ((value.max_automatic_retries > 0) !== retryAllowed) {
    context.addIssue({ code: "custom", message: "Automation Grant retry action must exactly match its retry limit.", path: ["allowed_actions"] });
  }
}

export const DIRECTOR_AUTOMATION_GRANT_UNSIGNED_SCHEMA = z.object(directorAutomationGrantShape).strict().superRefine(validateAutomationGrantLimits);
export const DIRECTOR_AUTOMATION_GRANT_SCHEMA = z.object({ ...directorAutomationGrantShape, policy_hash: hashSchema })
  .strict()
  .superRefine(validateAutomationGrantLimits);

export type DirectorAutomationGrantUnsigned = z.infer<typeof DIRECTOR_AUTOMATION_GRANT_UNSIGNED_SCHEMA>;
export type DirectorAutomationGrant = z.infer<typeof DIRECTOR_AUTOMATION_GRANT_SCHEMA>;

export function finalizeDirectorAutomationGrant(value: DirectorAutomationGrantUnsigned): DirectorAutomationGrant {
  const parsed = DIRECTOR_AUTOMATION_GRANT_UNSIGNED_SCHEMA.parse(value);
  return DIRECTOR_AUTOMATION_GRANT_SCHEMA.parse({ ...parsed, policy_hash: directorContentHash(parsed) });
}

export function validateDirectorAutomationGrant(value: unknown): DirectorAutomationGrant {
  const grant = DIRECTOR_AUTOMATION_GRANT_SCHEMA.parse(value);
  const { policy_hash: claimed, ...unsigned } = grant;
  if (directorContentHash(unsigned) !== claimed) throw new Error("DIRECTOR_AUTOMATION_GRANT_POLICY_HASH_MISMATCH");
  return grant;
}

const storyboardPackageShotV2Schema = z.object({
  shot_id: idSchema,
  order: z.number().int().nonnegative(),
  storyboard_artifact_id: idSchema,
  artifact_sha256: hashSchema,
  storyboard_prompt: nonEmptyTextSchema,
  negative_prompt: z.string().max(16_384),
  composition_notes: z.string().max(8_192),
  continuity_constraints: z.array(shortTextSchema).max(30),
  duration_seconds: z.number().finite().positive().max(120),
  camera_motion: z.string().max(4_096),
  generation_constraints: z.array(shortTextSchema).max(30)
}).strict();

const storyboardPackageV2Shape = {
  schema_version: z.literal(STORYBOARD_PACKAGE_V2_SCHEMA_VERSION),
  package_version_id: idSchema,
  project_id: idSchema,
  version: z.number().int().positive(),
  supersedes_package_version_id: nullableIdSchema,
  initial_state: z.literal("draft_candidate"),
  video_spec: z.object({
    duration_seconds: z.number().finite().positive(),
    aspect_ratio: shortTextSchema,
    resolution: shortTextSchema
  }).strict(),
  creative_direction_hash: nullableHashSchema,
  shots: z.array(storyboardPackageShotV2Schema).min(1).max(100),
  created_from_proposal_id: nullableIdSchema,
  created_at: timestampSchema
} as const;

function validateStoryboardPackageV2Shape(
  value: { shots: Array<{ shot_id: string; order: number; duration_seconds: number }>; video_spec: { duration_seconds: number } },
  context: z.core.$RefinementCtx
): void {
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const [index, shot] of value.shots.entries()) {
    if (ids.has(shot.shot_id)) context.addIssue({ code: "custom", message: "Duplicate SHOT id.", path: ["shots", index, "shot_id"] });
    if (orders.has(shot.order)) context.addIssue({ code: "custom", message: "Duplicate SHOT order.", path: ["shots", index, "order"] });
    ids.add(shot.shot_id);
    orders.add(shot.order);
  }
  const shotDuration = value.shots.reduce((total, shot) => total + shot.duration_seconds, 0);
  if (Math.abs(shotDuration - value.video_spec.duration_seconds) > 0.001) {
    context.addIssue({ code: "custom", message: "Storyboard Package SHOT duration must equal the project video duration.", path: ["video_spec", "duration_seconds"] });
  }
}

export const STORYBOARD_PACKAGE_V2_UNSIGNED_SCHEMA = z.object(storyboardPackageV2Shape).strict().superRefine(validateStoryboardPackageV2Shape);

export const STORYBOARD_PACKAGE_V2_SCHEMA = z.object({ ...storyboardPackageV2Shape, content_hash: hashSchema })
  .strict()
  .superRefine(validateStoryboardPackageV2Shape);
export type StoryboardPackageV2Unsigned = z.infer<typeof STORYBOARD_PACKAGE_V2_UNSIGNED_SCHEMA>;
export type StoryboardPackageV2 = z.infer<typeof STORYBOARD_PACKAGE_V2_SCHEMA>;

export function finalizeStoryboardPackageV2(value: StoryboardPackageV2Unsigned): StoryboardPackageV2 {
  const parsed = STORYBOARD_PACKAGE_V2_UNSIGNED_SCHEMA.parse(value);
  return STORYBOARD_PACKAGE_V2_SCHEMA.parse({ ...parsed, content_hash: directorContentHash(parsed) });
}

export function validateStoryboardPackageV2(value: unknown): StoryboardPackageV2 {
  const packageVersion = STORYBOARD_PACKAGE_V2_SCHEMA.parse(value);
  const { content_hash: claimed, ...unsigned } = packageVersion;
  if (directorContentHash(unsigned) !== claimed) throw new Error("STORYBOARD_PACKAGE_V2_CONTENT_HASH_MISMATCH");
  return packageVersion;
}

export const DIRECTOR_PROPOSAL_EVENT_TYPE_SCHEMA = z.enum(["submitted", "imported", "withdrawn", "accepted", "rejected", "compiled"]);
export const DIRECTOR_GRANT_EVENT_TYPE_SCHEMA = z.enum(["reserve", "release", "consume", "revoke", "expire"]);
export const STORYBOARD_PACKAGE_V2_EVENT_TYPE_SCHEMA = z.enum(["created", "frozen", "superseded"]);
