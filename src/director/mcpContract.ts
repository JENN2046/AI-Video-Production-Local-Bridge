import { createHash } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  DIRECTOR_PROPOSAL_KIND_SCHEMA,
  DIRECTOR_PROPOSAL_DRAFT_SCHEMA,
  DIRECTOR_PROPOSAL_SCHEMA,
  DIRECTOR_TARGET_STATE_V1_SCHEMA,
  validateDirectorProposal
} from "./domain.js";
import { DIRECTOR_MEMORY_RECALL_CONTEXT_SCHEMA } from "./memoryPort.js";
import { wwwAuthenticate, type WebGptV4AuthConfig } from "../webgpt-v4/auth.js";
import { errorBody, requireScope, type WebGptV4Actor, type WebGptV4Scope } from "../webgpt-v4/types.js";

export const DIRECTOR_MCP_SERVICE_VERSION = "director-mcp-v1.0.0";
export const DIRECTOR_CONTEXT_VERSION = "director-context-v1";
export const DIRECTOR_TOOL_RESULT_MAX_BYTES = 128 * 1024;
export const DIRECTOR_MODEL_IMAGE_MAX_BYTES = 12 * 1024 * 1024;

export const DIRECTOR_NATIVE_TOOL_NAMES = [
  "get_director_focus",
  "get_director_context",
  "inspect_director_video_frames",
  "submit_director_proposal",
  "get_director_proposal_status"
] as const;

export type DirectorNativeToolName = typeof DIRECTOR_NATIVE_TOOL_NAMES[number];

export const DIRECTOR_OAUTH_SCOPES = ["projects.read", "media.read", "proposals.write"] as const satisfies readonly WebGptV4Scope[];

export const DIRECTOR_FORBIDDEN_TOOL_NAMES = [
  "approve_storyboard_package",
  "confirm_generation_intent",
  "submit_provider_job",
  "adopt_clip",
  "confirm_assembly",
  "confirm_delivery",
  "commit_memory",
  "delete_artifact",
  "overwrite_storyboard_package"
] as const;

const idSchema = z.string().trim().min(1).max(160);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.iso.datetime();
const requestIdSchema = z.string().trim().min(1).max(128).optional();

export const DIRECTOR_PUBLIC_FOCUS_SCHEMA = z.object({
  focus_id: idSchema,
  project_id: idSchema,
  target_type: z.enum(["project", "shot", "artifact", "storyboard_package", "generation_run", "delivery", "memory"]),
  target_id: idSchema,
  generation: z.number().int().positive(),
  created_at: timestampSchema,
  expires_at: timestampSchema
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expires_at) <= Date.parse(value.created_at)) {
    context.addIssue({ code: "custom", message: "Director Focus must expire after it is created.", path: ["expires_at"] });
  }
});

const discussionShotSchema = z.object({
  shot_id: idSchema,
  order: z.number().int().nonnegative(),
  status: z.string().trim().min(1).max(64),
  duration_seconds: z.number().finite().positive(),
  description: z.string().max(16_384),
  storyboard_prompt: z.string().max(16_384),
  video_prompt: z.string().max(16_384),
  negative_prompt: z.string().max(16_384),
  continuity_constraints: z.array(z.string().trim().min(1).max(1_024)).max(30)
}).strict();

const discussionArtifactSchema = z.object({
  artifact_id: idSchema,
  shot_id: idSchema.nullable(),
  artifact_type: z.enum(["image", "video"]),
  role: z.enum(["storyboard_image", "generated_clip", "final_video"]),
  status: z.enum(["pending_upload", "active", "archived", "inaccessible", "expired"]),
  mime_type: z.string().trim().min(1).max(128),
  sha256: hashSchema
}).strict();

const discussionReviewSchema = z.object({
  event_id: idSchema,
  artifact_id: idSchema.nullable(),
  disposition: z.enum(["pending", "accepted", "rejected", "revision_needed"]),
  reason_codes: z.array(z.string().regex(/^[A-Z0-9_]{3,64}$/)).max(20),
  note: z.string().max(8_192),
  created_at: timestampSchema
}).strict();

const directorQuoteSchema = z.object({
  quote_state: z.enum(["not_applicable", "ready", "missing", "expired", "stale", "capability_drift", "capability_unavailable"]),
  expires_at: timestampSchema.nullable(),
  currency: z.enum(["CNY", "RH_COINS"]).nullable(),
  requires_human_refresh: z.boolean()
}).strict();

export const DIRECTOR_DISCUSSION_CONTEXT_SCHEMA = z.object({
  project: z.object({
    project_id: idSchema,
    title: z.string().trim().min(1).max(1_024),
    status: z.string().trim().min(1).max(64),
    lifecycle_state: z.enum(["active", "archived"]),
    brief_summary: z.string().max(16_384),
    creative_direction: z.string().max(16_384),
    video_spec: z.object({
      duration_seconds: z.number().finite().positive(),
      aspect_ratio: z.string().trim().min(1).max(128),
      resolution: z.string().trim().min(1).max(128)
    }).strict()
  }).strict(),
  target_shot: discussionShotSchema.nullable(),
  adjacent_shots: z.array(discussionShotSchema).max(2),
  target_artifact: discussionArtifactSchema.nullable(),
  review_history: z.array(discussionReviewSchema).max(50),
  /** Never includes a numeric estimate: only the local Workbench may quote. */
  quote: directorQuoteSchema,
  /** Advisory-only, project-bound long-term experience from an injected port. */
  memory_recall: DIRECTOR_MEMORY_RECALL_CONTEXT_SCHEMA
}).strict();

export const DIRECTOR_GET_FOCUS_INPUT_SCHEMA = z.object({ request_id: requestIdSchema }).strict();
export const DIRECTOR_GET_FOCUS_OUTPUT_SCHEMA = z.object({
  state: z.enum(["active", "no_focus", "focus_expired"]),
  focus: DIRECTOR_PUBLIC_FOCUS_SCHEMA.nullable()
}).strict().superRefine((value, context) => {
  if ((value.state === "active") !== (value.focus !== null)) {
    context.addIssue({ code: "custom", message: "Only active focus results may expose a Focus.", path: ["focus"] });
  }
});

export const DIRECTOR_GET_CONTEXT_INPUT_SCHEMA = z.object({
  focus_id: idSchema,
  focus_generation: z.number().int().positive(),
  proposal_kind: DIRECTOR_PROPOSAL_KIND_SCHEMA,
  detail: z.enum(["compact", "full"]).default("compact"),
  request_id: requestIdSchema
}).strict();
export const DIRECTOR_GET_CONTEXT_OUTPUT_SCHEMA = z.object({
  state: z.literal("ready"),
  context_version: z.literal(DIRECTOR_CONTEXT_VERSION),
  focus: DIRECTOR_PUBLIC_FOCUS_SCHEMA,
  base_state_hash: hashSchema,
  target_state: DIRECTOR_TARGET_STATE_V1_SCHEMA,
  discussion: DIRECTOR_DISCUSSION_CONTEXT_SCHEMA
}).strict();

export const DIRECTOR_INSPECT_VIDEO_FRAMES_INPUT_SCHEMA = z.object({
  focus_id: idSchema,
  focus_generation: z.number().int().positive(),
  artifact_id: idSchema,
  sampling: z.enum(["overview", "adaptive"]).default("adaptive"),
  max_frames: z.number().int().min(1).max(40).default(12),
  request_id: requestIdSchema
}).strict();
export const DIRECTOR_INSPECT_VIDEO_FRAMES_OUTPUT_SCHEMA = z.object({
  state: z.literal("ready"),
  focus_id: idSchema,
  focus_generation: z.number().int().positive(),
  project_id: idSchema,
  artifact_id: idSchema,
  mime_type: z.enum(["video/mp4", "video/webm"]),
  duration_seconds: z.number().finite().positive(),
  base_state_hash: hashSchema,
  frames: z.array(z.object({
    sequence: z.number().int().nonnegative(),
    timestamp_seconds: z.number().finite().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sha256: hashSchema
  }).strict()).min(1).max(40),
  truncated: z.boolean()
}).strict();

const directorModelImageSchema = z.object({
  data: z.string().min(4).max(16 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  mime_type: z.literal("image/jpeg")
}).strict();

export const DIRECTOR_VIDEO_FRAME_TOOL_OUTPUT_SCHEMA = z.object({
  structured_content: DIRECTOR_INSPECT_VIDEO_FRAMES_OUTPUT_SCHEMA,
  model_images: z.array(directorModelImageSchema).min(1).max(40)
}).strict().superRefine((value, context) => {
  if (value.model_images.length !== value.structured_content.frames.length) {
    context.addIssue({ code: "custom", message: "Frame metadata and model images must have the same length.", path: ["model_images"] });
    return;
  }
  let total = 0;
  value.model_images.forEach((image, index) => {
    const bytes = Buffer.from(image.data, "base64");
    total += bytes.byteLength;
    if (bytes.toString("base64") !== image.data) {
      context.addIssue({ code: "custom", message: "Model image must use canonical base64.", path: ["model_images", index, "data"] });
    }
    if (createHash("sha256").update(bytes).digest("hex") !== value.structured_content.frames[index]?.sha256) {
      context.addIssue({ code: "custom", message: "Model image digest does not match its frame metadata.", path: ["model_images", index, "data"] });
    }
  });
  if (total > DIRECTOR_MODEL_IMAGE_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "Model image content exceeds the Director frame budget.", path: ["model_images"] });
  }
});

export const DIRECTOR_SUBMIT_PROPOSAL_INPUT_SCHEMA = z.object({
  focus_id: idSchema,
  focus_generation: z.number().int().positive(),
  base_state_hash: hashSchema,
  idempotency_key: z.string().trim().min(16).max(160),
  parent_proposal_id: idSchema.nullable().optional(),
  proposal: DIRECTOR_PROPOSAL_DRAFT_SCHEMA,
  request_id: requestIdSchema
}).strict();
export const DIRECTOR_SUBMIT_PROPOSAL_OUTPUT_SCHEMA = z.object({
  state: z.literal("accepted_for_human_review"),
  proposal_id: idSchema,
  kind: z.enum([
    "creative_brief", "script", "shot_plan", "storyboard_revision", "generation_plan",
    "artifact_import", "clip_regeneration", "review_assessment", "assembly_plan", "delivery_plan", "memory_saveback"
  ]),
  focus_id: idSchema,
  focus_generation: z.number().int().positive(),
  base_state_hash: hashSchema,
  payload_hash: hashSchema,
  source: z.literal("native"),
  created_at: timestampSchema
}).strict();

export const DIRECTOR_GET_PROPOSAL_STATUS_INPUT_SCHEMA = z.object({
  proposal_id: idSchema,
  request_id: requestIdSchema
}).strict();
export const DIRECTOR_GET_PROPOSAL_STATUS_OUTPUT_SCHEMA = z.object({
  proposal_id: idSchema,
  state: z.enum(["pending_review", "approved", "rejected", "superseded", "executing", "completed", "failed"]),
  reason_code: z.string().regex(/^[A-Z0-9_]{3,64}$/).nullable(),
  updated_at: timestampSchema
}).strict();

export const DIRECTOR_MANUAL_IMPORT_SCHEMA = z.object({
  mode: z.literal("manual"),
  confirmed_by_user: z.literal(true),
  proposal: DIRECTOR_PROPOSAL_SCHEMA,
  imported_at: timestampSchema
}).strict().superRefine((value, context) => {
  if (value.proposal.source !== "untrusted_manual_import") {
    context.addIssue({ code: "custom", message: "Manual imports must remain explicitly untrusted.", path: ["proposal", "source"] });
  }
  try {
    validateDirectorProposal(value.proposal);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Manual Proposal failed immutable content and target validation.",
      path: ["proposal"]
    });
  }
});

type InputOf<T extends z.ZodType> = z.infer<T>;
type OutputOf<T extends z.ZodType> = z.infer<T>;

export interface DirectorNativeToolHandlers {
  get_director_focus(input: InputOf<typeof DIRECTOR_GET_FOCUS_INPUT_SCHEMA>): Promise<OutputOf<typeof DIRECTOR_GET_FOCUS_OUTPUT_SCHEMA>>;
  get_director_context(input: InputOf<typeof DIRECTOR_GET_CONTEXT_INPUT_SCHEMA>): Promise<OutputOf<typeof DIRECTOR_GET_CONTEXT_OUTPUT_SCHEMA>>;
  inspect_director_video_frames(input: InputOf<typeof DIRECTOR_INSPECT_VIDEO_FRAMES_INPUT_SCHEMA>): Promise<DirectorVideoFrameToolOutput | OutputOf<typeof DIRECTOR_INSPECT_VIDEO_FRAMES_OUTPUT_SCHEMA>>;
  submit_director_proposal(input: InputOf<typeof DIRECTOR_SUBMIT_PROPOSAL_INPUT_SCHEMA>): Promise<OutputOf<typeof DIRECTOR_SUBMIT_PROPOSAL_OUTPUT_SCHEMA>>;
  get_director_proposal_status(input: InputOf<typeof DIRECTOR_GET_PROPOSAL_STATUS_INPUT_SCHEMA>): Promise<OutputOf<typeof DIRECTOR_GET_PROPOSAL_STATUS_OUTPUT_SCHEMA>>;
}

export type DirectorModelImage = z.infer<typeof directorModelImageSchema>;
export type DirectorVideoFrameToolOutput = z.infer<typeof DIRECTOR_VIDEO_FRAME_TOOL_OUTPUT_SCHEMA>;

export const DIRECTOR_NATIVE_TOOL_CATALOG = [
  { name: "get_director_focus", scope: ["projects.read"], risk: "read", input: DIRECTOR_GET_FOCUS_INPUT_SCHEMA, output: DIRECTOR_GET_FOCUS_OUTPUT_SCHEMA },
  { name: "get_director_context", scope: ["projects.read"], risk: "read", input: DIRECTOR_GET_CONTEXT_INPUT_SCHEMA, output: DIRECTOR_GET_CONTEXT_OUTPUT_SCHEMA },
  { name: "inspect_director_video_frames", scope: ["projects.read", "media.read"], risk: "media_read", input: DIRECTOR_INSPECT_VIDEO_FRAMES_INPUT_SCHEMA, output: DIRECTOR_INSPECT_VIDEO_FRAMES_OUTPUT_SCHEMA },
  { name: "submit_director_proposal", scope: ["projects.read", "proposals.write"], risk: "proposal_write", input: DIRECTOR_SUBMIT_PROPOSAL_INPUT_SCHEMA, output: DIRECTOR_SUBMIT_PROPOSAL_OUTPUT_SCHEMA },
  { name: "get_director_proposal_status", scope: ["projects.read"], risk: "read", input: DIRECTOR_GET_PROPOSAL_STATUS_INPUT_SCHEMA, output: DIRECTOR_GET_PROPOSAL_STATUS_OUTPUT_SCHEMA }
] as const;

const titles: Record<DirectorNativeToolName, string> = {
  get_director_focus: "读取当前讨论对象",
  get_director_context: "读取 Director 讨论上下文",
  inspect_director_video_frames: "读取视频时间戳帧",
  submit_director_proposal: "提交 Director 提议",
  get_director_proposal_status: "读取 Director 提议状态"
};

const descriptions: Record<DirectorNativeToolName, string> = {
  get_director_focus: "Return the authenticated user's current Workbench-selected Focus without accepting arbitrary project identifiers.",
  get_director_context: "Return a project-bound, generation-bound discussion context for the current Focus.",
  inspect_director_video_frames: "Return bounded timestamped image frames for the video Artifact already bound to the current Focus.",
  submit_director_proposal: "Submit an immutable advisory Proposal for Human Workbench review. This never approves or executes it.",
  get_director_proposal_status: "Return the review/execution status of one Proposal owned by the authenticated principal."
};

function toolResult<T>(schema: z.ZodType<T>, value: unknown, summary: string): never {
  const structuredContent = schema.parse(value);
  const result = {
    isError: false,
    structuredContent,
    content: [{ type: "text", text: summary }]
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > DIRECTOR_TOOL_RESULT_MAX_BYTES) {
    return {
      isError: true,
      content: [{ type: "text", text: "RESPONSE_BUDGET_EXCEEDED: Director tool result exceeds the 128 KiB response budget." }]
    } as never;
  }
  return result as never;
}

export interface CreateDirectorNativeMcpServerOptions {
  auth_config?: WebGptV4AuthConfig | null;
  /**
   * A unified route has its own PRMD path.  The legacy Director route keeps
   * its existing default so it remains a standalone rollback surface.
   */
  resource_metadata_url?: string;
}

export function registerDirectorNativeTools(
  server: McpServer,
  actor: WebGptV4Actor,
  handlers: DirectorNativeToolHandlers,
  options: CreateDirectorNativeMcpServerOptions = {}
): void {

  for (const entry of DIRECTOR_NATIVE_TOOL_CATALOG) {
    const readOnly = entry.risk !== "proposal_write";
    const descriptor = {
      title: titles[entry.name],
      description: descriptions[entry.name],
      inputSchema: entry.input,
      outputSchema: entry.output,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: false,
        openWorldHint: false,
        ...(entry.risk === "proposal_write" ? { idempotentHint: true } : {})
      },
      _meta: {
        securitySchemes: [{ type: "oauth2" as const, scopes: [...entry.scope] }],
        ui: { visibility: ["model"] }
      }
    };
    const invoke = async (input: unknown): Promise<never> => {
      try {
        for (const scope of entry.scope) requireScope(actor, scope);
        const parsed = entry.input.parse(input);
        const handled = await handlers[entry.name](parsed as never);
        const frameResult = entry.name === "inspect_director_video_frames"
          && handled && typeof handled === "object" && "structured_content" in handled
          ? DIRECTOR_VIDEO_FRAME_TOOL_OUTPUT_SCHEMA.parse(handled)
          : null;
        const value = frameResult?.structured_content ?? handled;
        const summary = entry.name === "submit_director_proposal"
          ? "Director 提议已提交到 Human Workbench 等待人工审查；尚未执行任何生产动作。"
          : "已返回与当前 Director Focus 绑定的只读结果。";
        const result = toolResult(entry.output as z.ZodType<unknown>, value, summary) as unknown as Record<string, unknown>;
        if (entry.name === "inspect_director_video_frames" && result.isError !== true) {
          const images = frameResult?.model_images ?? [];
          result.content = [
            { type: "text", text: summary },
            ...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mime_type }))
          ];
        }
        return result as never;
      } catch (error) {
        const safe = errorBody(error);
        const challenge = safe.code === "INSUFFICIENT_SCOPE"
          ? wwwAuthenticate(options.auth_config ?? null, "insufficient_scope", {
            scope: entry.scope.join(" "),
            error_description: safe.message,
            ...(options.auth_config ? {} : { resource_metadata_url: options.resource_metadata_url ?? "/.well-known/oauth-protected-resource/director/mcp" })
          })
          : null;
        return {
          isError: true,
          content: [{ type: "text", text: `${safe.code}: ${safe.message}`.slice(0, 1_024) }],
          ...(challenge ? { _meta: { "mcp/www_authenticate": [challenge] } } : {})
        } as never;
      }
    };
    server.registerTool(entry.name, descriptor, invoke);
  }
}

export function createDirectorNativeMcpServer(
  actor: WebGptV4Actor,
  handlers: DirectorNativeToolHandlers,
  options: CreateDirectorNativeMcpServerOptions = {}
): McpServer {
  const server = new McpServer(
    { name: "jenn-ai-video-director", version: DIRECTOR_MCP_SERVICE_VERSION },
    { instructions: "ChatGPT Director may read bound context and submit immutable advisory proposals. It cannot approve, execute, spend, deliver, delete, overwrite, or commit memory." }
  );
  registerDirectorNativeTools(server, actor, handlers, options);
  return server;
}
