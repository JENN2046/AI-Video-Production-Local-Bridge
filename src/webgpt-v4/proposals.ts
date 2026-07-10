import { z } from "zod/v4";

import { WebGptV4Error } from "./types.js";

const appId = z.string().trim().min(1).max(200).refine((value) => !value.includes("/") && !value.includes("\\"), "Invalid application id.");
const notes = z.string().trim().min(1).max(2000);
const promptText = z.string().trim().min(1).max(8000);

const revisionInstructionSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  prompt_delta: z.string().max(8000).default(""),
  negative_delta: z.string().max(4000).default(""),
  priority: z.enum(["low", "medium", "high"]).default("medium")
}).strict();

export const productionProposalPayloadSchemas = {
  storyboard_package: z.object({
    notes: notes.optional(),
    expected_shot_ids: z.array(appId).min(1).max(100).optional()
  }).strict(),
  review_decision: z.object({
    shot_id: appId,
    artifact_id: appId,
    decision: z.enum(["approved", "revision_needed"]),
    rejection_reasons: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    revision_instruction: revisionInstructionSchema.optional()
  }).strict().superRefine((value, context) => {
    if (value.decision === "revision_needed" && !value.revision_instruction) {
      context.addIssue({ code: "custom", path: ["revision_instruction"], message: "revision_instruction is required when decision is revision_needed." });
    }
  }),
  regeneration: z.object({
    shot_id: appId,
    artifact_id: appId,
    previous_run_id: appId.optional(),
    prompt_delta: promptText,
    negative_delta: z.string().max(4000).optional(),
    notes: notes.optional()
  }).strict(),
  final_assembly: z.object({ notes: notes.optional() }).strict(),
  memory_saveback: z.object({
    proposal_id: appId.optional(),
    notes
  }).strict(),
  package_freeze: z.object({
    notes: notes.optional(),
    expected_shot_ids: z.array(appId).min(1).max(100).optional()
  }).strict()
} as const;

export const productionProposalPayloadUnionSchema = z.union([
  productionProposalPayloadSchemas.storyboard_package,
  productionProposalPayloadSchemas.review_decision,
  productionProposalPayloadSchemas.regeneration,
  productionProposalPayloadSchemas.final_assembly,
  productionProposalPayloadSchemas.memory_saveback,
  productionProposalPayloadSchemas.package_freeze
]);

const requestFields = {
  project_id: appId,
  idempotency_key: z.string().trim().min(1).max(200),
  request_id: z.string().max(128).optional()
};

export const productionProposalSubmitSchema = z.discriminatedUnion("kind", [
  z.object({ ...requestFields, kind: z.literal("storyboard_package"), payload: productionProposalPayloadSchemas.storyboard_package }).strict(),
  z.object({ ...requestFields, kind: z.literal("review_decision"), payload: productionProposalPayloadSchemas.review_decision }).strict(),
  z.object({ ...requestFields, kind: z.literal("regeneration"), payload: productionProposalPayloadSchemas.regeneration }).strict(),
  z.object({ ...requestFields, kind: z.literal("final_assembly"), payload: productionProposalPayloadSchemas.final_assembly }).strict(),
  z.object({ ...requestFields, kind: z.literal("memory_saveback"), payload: productionProposalPayloadSchemas.memory_saveback }).strict(),
  z.object({ ...requestFields, kind: z.literal("package_freeze"), payload: productionProposalPayloadSchemas.package_freeze }).strict()
]);

export const productionProposalRevisionSchema = z.object({
  project_id: appId,
  draft_id: appId,
  payload: productionProposalPayloadUnionSchema,
  idempotency_key: z.string().trim().min(1).max(200),
  request_id: z.string().max(128).optional()
}).strict();

export function parseProductionProposalPayload(kind: keyof typeof productionProposalPayloadSchemas, payload: unknown): Record<string, unknown> {
  const parsed = productionProposalPayloadSchemas[kind].safeParse(payload);
  if (parsed.success) return parsed.data as Record<string, unknown>;
  const issue = parsed.error.issues[0];
  throw new WebGptV4Error("INVALID_PROPOSAL_PAYLOAD", issue?.message ?? "Proposal payload is invalid.", issue?.path.join(".") || "payload");
}
