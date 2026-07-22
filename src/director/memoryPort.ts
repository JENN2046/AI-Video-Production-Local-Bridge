import { z } from "zod";

import { DIRECTOR_PROPOSAL_KIND_SCHEMA } from "./domain.js";

/**
 * This port is deliberately an advisory-only seam.  ChatGPT may use recalled
 * experience while preparing a proposal, but neither the port nor the local
 * Director service can turn that experience into an approval, a Provider call,
 * or a durable memory write.
 */
export const DIRECTOR_MEMORY_PORT_VERSION = "director-memory-port-v1";
export const DIRECTOR_MEMORY_RECALL_TIMEOUT_MS = 2_000;

const idSchema = z.string().trim().min(1).max(160);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const textSchema = z.string().trim().min(1).max(512);
const categorySchema = z.enum(["preference", "decision", "failure_pattern", "reusable_rule", "provider_learning"]);
const scopeSchema = z.enum(["project", "workspace"]);

const memoryItemSchema = z.object({
  category: categorySchema,
  summary: textSchema,
  evidence: z.array(textSchema).max(6),
  scope: scopeSchema
}).strict();

export const DIRECTOR_MEMORY_RECALL_CONTEXT_SCHEMA = z.object({
  state: z.enum(["disabled", "empty", "ready", "unavailable"]),
  items: z.array(memoryItemSchema).max(12)
}).strict().superRefine((value, context) => {
  if (value.state === "ready" && value.items.length === 0) {
    context.addIssue({ code: "custom", message: "A ready memory recall must contain at least one item.", path: ["items"] });
  }
  if (value.state !== "ready" && value.items.length !== 0) {
    context.addIssue({ code: "custom", message: "Only a ready memory recall may expose items.", path: ["items"] });
  }
});

export type DirectorMemoryRecallContext = z.infer<typeof DIRECTOR_MEMORY_RECALL_CONTEXT_SCHEMA>;

export interface DirectorMemoryRecallRequest {
  workspace_id: "jenn-ai-video-workspace";
  principal_id: string;
  issuer_hash: string;
  project_id: string;
  proposal_kind: z.infer<typeof DIRECTOR_PROPOSAL_KIND_SCHEMA>;
}

const portResponseItemSchema = memoryItemSchema.extend({
  /**
   * Project memory may only originate from the active project.  Workspace
   * memory has no source project identifier, so a port cannot smuggle another
   * project's identity through this response.
   */
  source_project_id: idSchema.nullable()
}).strict();

const portResponseSchema = z.object({
  version: z.literal(DIRECTOR_MEMORY_PORT_VERSION),
  state: z.enum(["disabled", "empty", "ready", "unavailable"]),
  workspace_id: z.literal("jenn-ai-video-workspace"),
  principal_id: hashSchema,
  issuer_hash: hashSchema,
  project_id: idSchema,
  proposal_kind: DIRECTOR_PROPOSAL_KIND_SCHEMA,
  items: z.array(portResponseItemSchema).max(12)
}).strict().superRefine((value, context) => {
  if (value.state === "ready" && value.items.length === 0) {
    context.addIssue({ code: "custom", message: "A ready port response must contain memory items.", path: ["items"] });
  }
  if (value.state !== "ready" && value.items.length !== 0) {
    context.addIssue({ code: "custom", message: "Only a ready port response may contain memory items.", path: ["items"] });
  }
  value.items.forEach((item, index) => {
    if (item.scope === "project" && item.source_project_id !== value.project_id) {
      context.addIssue({ code: "custom", message: "Project memory must be bound to the requested project.", path: ["items", index, "source_project_id"] });
    }
    if (item.scope === "workspace" && item.source_project_id !== null) {
      context.addIssue({ code: "custom", message: "Workspace memory cannot expose a source project identifier.", path: ["items", index, "source_project_id"] });
    }
  });
});

export interface DirectorMemoryPort {
  recall(request: DirectorMemoryRecallRequest): Promise<unknown>;
}

export const DISABLED_DIRECTOR_MEMORY_PORT: DirectorMemoryPort = {
  async recall(request) {
    return {
      version: DIRECTOR_MEMORY_PORT_VERSION,
      state: "disabled",
      workspace_id: request.workspace_id,
      principal_id: request.principal_id,
      issuer_hash: request.issuer_hash,
      project_id: request.project_id,
      proposal_kind: request.proposal_kind,
      items: []
    };
  }
};

export function disabledDirectorMemoryRecall(): DirectorMemoryRecallContext {
  return { state: "disabled", items: [] };
}

function unavailableDirectorMemoryRecall(): DirectorMemoryRecallContext {
  return { state: "unavailable", items: [] };
}

async function recallWithTimeout(port: DirectorMemoryPort, request: DirectorMemoryRecallRequest): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      port.recall(request),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("DIRECTOR_MEMORY_PORT_TIMEOUT")), DIRECTOR_MEMORY_RECALL_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Treat every port response as untrusted.  A bad binding, malformed item, or
 * port failure becomes a data-free unavailable state; the rest of Director
 * context remains useful and no cross-project memory is disclosed.
 */
export async function recallDirectorMemory(
  port: DirectorMemoryPort,
  request: DirectorMemoryRecallRequest
): Promise<DirectorMemoryRecallContext> {
  try {
    const response = portResponseSchema.parse(await recallWithTimeout(port, request));
    if (response.workspace_id !== request.workspace_id
      || response.principal_id !== request.principal_id
      || response.issuer_hash !== request.issuer_hash
      || response.project_id !== request.project_id
      || response.proposal_kind !== request.proposal_kind) {
      return unavailableDirectorMemoryRecall();
    }
    return DIRECTOR_MEMORY_RECALL_CONTEXT_SCHEMA.parse({
      state: response.state,
      items: response.items.map(({ category, summary, evidence, scope }) => ({ category, summary, evidence, scope }))
    });
  } catch {
    return unavailableDirectorMemoryRecall();
  }
}

const savebackItemSchema = z.object({
  category: categorySchema,
  summary: textSchema,
  evidence: z.array(textSchema).min(1).max(20),
  scope: scopeSchema
}).strict();

export const DIRECTOR_MEMORY_SAVEBACK_ENVELOPE_SCHEMA = z.object({
  version: z.literal(DIRECTOR_MEMORY_PORT_VERSION),
  dispatch_state: z.literal("awaiting_external_confirmation"),
  proposal_id: idSchema,
  workspace_id: z.literal("jenn-ai-video-workspace"),
  principal_id: hashSchema,
  issuer_hash: hashSchema,
  project_id: idSchema,
  items: z.array(savebackItemSchema).min(1).max(30),
  requires_human_confirmation: z.literal(true)
}).strict();

export type DirectorMemorySavebackEnvelope = z.infer<typeof DIRECTOR_MEMORY_SAVEBACK_ENVELOPE_SCHEMA>;

/**
 * Build a portable, non-dispatched Saveback envelope.  A future stable memory
 * plugin may consume it only behind its own explicit external acceptance gate.
 * This function has no filesystem, network, database, or provider side effect.
 */
export function prepareDirectorMemorySavebackEnvelope(input: Omit<DirectorMemorySavebackEnvelope, "version" | "dispatch_state">): DirectorMemorySavebackEnvelope {
  return DIRECTOR_MEMORY_SAVEBACK_ENVELOPE_SCHEMA.parse({
    version: DIRECTOR_MEMORY_PORT_VERSION,
    dispatch_state: "awaiting_external_confirmation",
    ...input
  });
}
