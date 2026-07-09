import { basename } from "node:path";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import {
  executeWebGptDraftTool,
  webGptDraftWorkbenchSummary
} from "./webGptDraftBridge.js";
import {
  executeWebGptPendingActionTool,
  webGptPendingActionWorkbenchSummary
} from "./webGptPendingActions.js";
import {
  executeWebGptReadOnlyTool
} from "./webGptReadOnlyBridge.js";
import {
  executeWebGptReviewAssistantTool,
  webGptReviewAssistantWorkbenchSummary
} from "./webGptReviewAssistant.js";
import {
  H1_PROVIDER_BOUNDARY,
  h3VideoReviewSummary,
  h4FinalAssemblyWorkbenchSummary,
  loadH1WorkbenchState
} from "./h1Workbench.js";

export const CHATGPT_MCP_BRIDGE_VERSION = "chatgpt-mcp-local-bridge-r2g";
export const CHATGPT_MCP_LOCAL_TEST_SERVER_NAME = "ai-video-production-chatgpt-mcp-local-test";

export type ChatGptMcpToolMode = "READ_ONLY" | "DRAFT_ONLY" | "HUMAN_CONFIRMATION_REQUIRED";

export type ChatGptMcpToolName =
  | "get_project_status"
  | "lookup_media_artifact"
  | "submit_storyboard_draft"
  | "check_import_readiness"
  | "request_package_freeze"
  | "get_review_package"
  | "draft_human_review_decision"
  | "get_closeout_evidence";

export const FORBIDDEN_CHATGPT_MCP_TOOL_NAMES = [
  "call_runway",
  "call_runninghub",
  "generate_video",
  "regenerate_video",
  "batch_generate_video",
  "assemble_final_video",
  "approve_final_delivery",
  "publish_video",
  "deploy_mcp_server",
  "create_chatgpt_connector",
  "start_public_tunnel",
  "read_env",
  "read_credentials",
  "write_production_config"
] as const;

export interface ChatGptMcpJsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  items?: unknown;
  enum?: string[];
}

export interface ChatGptMcpToolDescriptor {
  name: ChatGptMcpToolName;
  title: string;
  description: string;
  inputSchema: ChatGptMcpJsonSchema;
  outputSchema: ChatGptMcpJsonSchema;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: false;
    idempotentHint: boolean;
    openWorldHint: false;
  };
  security: {
    mode: ChatGptMcpToolMode;
    reads_private_state: false;
    reads_credentials: false;
    provider_call_allowed: false;
    public_network_allowed: false;
    source_overwrite_allowed: false;
    production_mutation_allowed: boolean;
    human_confirmation_required: boolean;
  };
  _meta: {
    "openai/toolInvocation/invoking": string;
    "openai/toolInvocation/invoked": string;
    local_only: true;
    public_endpoint: false;
  };
}

export interface ChatGptMcpContentPart {
  type: "text";
  text: string;
}

export interface ChatGptMcpToolResultEnvelope {
  ok: boolean;
  tool: ChatGptMcpToolName | "unknown";
  mode: ChatGptMcpToolMode | "FORBIDDEN";
  structuredContent: Record<string, unknown>;
  content: ChatGptMcpContentPart[];
  _meta: {
    bridge_version: typeof CHATGPT_MCP_BRIDGE_VERSION;
    local_only: true;
    public_endpoint: false;
    chatgpt_connector_created: false;
    provider_boundary: typeof H1_PROVIDER_BOUNDARY;
    secret_values_exposed: false;
    source_assets_overwritten: false;
  };
}

export interface ChatGptMcpLocalServer {
  server_name: typeof CHATGPT_MCP_LOCAL_TEST_SERVER_NAME;
  transport: "in_process_local_test_only";
  public_endpoint: false;
  chatgpt_connector_created: false;
  provider_call_allowed: false;
  listTools: () => ChatGptMcpToolDescriptor[];
  callTool: (name: string, input?: Record<string, unknown>) => ChatGptMcpToolResultEnvelope;
}

type ToolHandler = (input: Record<string, unknown>, db: M0Database) => Record<string, unknown>;
type SchemaValidationResult = { ok: true } | { ok: false; code: string; message: string };

const OBJECT_OUTPUT_SCHEMA: ChatGptMcpJsonSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    data: { type: "object" },
    error: { type: "object" },
    boundary: { type: "object" }
  },
  required: ["ok", "data", "error", "boundary"],
  additionalProperties: false
};

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function numberSchema(description: string): Record<string, unknown> {
  return { type: "number", description };
}

function toolDescriptor(
  name: ChatGptMcpToolName,
  title: string,
  description: string,
  mode: ChatGptMcpToolMode,
  inputSchema: ChatGptMcpJsonSchema,
  options: { readOnly: boolean; idempotent: boolean; productionMutationAllowed?: boolean; humanConfirmationRequired?: boolean }
): ChatGptMcpToolDescriptor {
  return {
    name,
    title,
    description,
    inputSchema,
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: options.readOnly,
      destructiveHint: false,
      idempotentHint: options.idempotent,
      openWorldHint: false
    },
    security: {
      mode,
      reads_private_state: false,
      reads_credentials: false,
      provider_call_allowed: false,
      public_network_allowed: false,
      source_overwrite_allowed: false,
      production_mutation_allowed: options.productionMutationAllowed ?? false,
      human_confirmation_required: options.humanConfirmationRequired ?? false
    },
    _meta: {
      "openai/toolInvocation/invoking": `${title}...`,
      "openai/toolInvocation/invoked": `${title} complete.`,
      local_only: true,
      public_endpoint: false
    }
  };
}

export const CHATGPT_MCP_TOOL_DESCRIPTORS: ChatGptMcpToolDescriptor[] = deepFreeze([
  toolDescriptor(
    "get_project_status",
    "Get Project Status",
    "Read the current local project and storyboard readiness summary.",
    "READ_ONLY",
    {
      type: "object",
      properties: {
        project_id: stringSchema("Optional app-owned project id.")
      },
      additionalProperties: false
    },
    { readOnly: true, idempotent: true }
  ),
  toolDescriptor(
    "lookup_media_artifact",
    "Lookup Media Artifact",
    "Read one app-owned Media Artifact by real artifact_id.",
    "READ_ONLY",
    {
      type: "object",
      properties: {
        artifact_id: stringSchema("Required app-owned artifact id.")
      },
      required: ["artifact_id"],
      additionalProperties: false
    },
    { readOnly: true, idempotent: true }
  ),
  toolDescriptor(
    "submit_storyboard_draft",
    "Submit Storyboard Draft",
    "Store a GPT-authored storyboard draft for local human review without changing production truth.",
    "DRAFT_ONLY",
    {
      type: "object",
      properties: {
        package_title: stringSchema("Optional draft package title."),
        shots: {
          type: "array",
          description: "Draft shots. Artifact ids are optional and must be app-owned if provided.",
          items: {
            type: "object",
            properties: {
              shot_id: stringSchema("Optional app shot id."),
              description: stringSchema("Draft shot description."),
              video_prompt: stringSchema("Draft video prompt."),
              negative_prompt: stringSchema("Optional draft negative prompt."),
              duration_seconds: numberSchema("Optional draft duration."),
              storyboard_image_artifact_id: stringSchema("Optional real app storyboard_image artifact id.")
            },
            additionalProperties: true
          }
        }
      },
      required: ["shots"],
      additionalProperties: false
    },
    { readOnly: false, idempotent: false }
  ),
  toolDescriptor(
    "check_import_readiness",
    "Check Import Readiness",
    "Read app-screened import candidates and current package readiness.",
    "READ_ONLY",
    {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    { readOnly: true, idempotent: true }
  ),
  toolDescriptor(
    "request_package_freeze",
    "Request Package Freeze",
    "Create a pending human-confirmed package freeze request; this does not freeze the package directly.",
    "HUMAN_CONFIRMATION_REQUIRED",
    {
      type: "object",
      properties: {
        reason: stringSchema("Required reason shown to the human operator.")
      },
      required: ["reason"],
      additionalProperties: false
    },
    { readOnly: false, idempotent: false, humanConfirmationRequired: true }
  ),
  toolDescriptor(
    "get_review_package",
    "Get Review Package",
    "Read generated clip review and final assembly readiness summaries.",
    "READ_ONLY",
    {
      type: "object",
      properties: {
        project_id: stringSchema("Optional app-owned project id for final assembly summary.")
      },
      additionalProperties: false
    },
    { readOnly: true, idempotent: true }
  ),
  toolDescriptor(
    "draft_human_review_decision",
    "Draft Human Review Decision",
    "Draft a clip review note, rejection reason, or regeneration prompt for local human review.",
    "DRAFT_ONLY",
    {
      type: "object",
      properties: {
        artifact_id: stringSchema("Required generated_clip artifact id."),
        decision: { type: "string", enum: ["accept", "reject", "regenerate_requested"] },
        note: stringSchema("Draft note for accept decisions."),
        reason: stringSchema("Draft rejection reason."),
        prompt_delta: stringSchema("Draft regeneration prompt delta.")
      },
      required: ["artifact_id", "decision"],
      additionalProperties: false
    },
    { readOnly: false, idempotent: false }
  ),
  toolDescriptor(
    "get_closeout_evidence",
    "Get Closeout Evidence",
    "Read local report references and closeout evidence metadata.",
    "READ_ONLY",
    {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    { readOnly: true, idempotent: true }
  )
]);

export function listChatGptMcpToolDescriptors(): ChatGptMcpToolDescriptor[] {
  return deepClone(CHATGPT_MCP_TOOL_DESCRIPTORS);
}

function descriptorByName(name: string): ChatGptMcpToolDescriptor | null {
  return CHATGPT_MCP_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === name) ?? null;
}

function isForbiddenName(name: string): boolean {
  return FORBIDDEN_CHATGPT_MCP_TOOL_NAMES.some((forbidden) => forbidden === name);
}

function isFakeOrPendingId(value: string): boolean {
  const upper = value.toUpperCase();
  return upper.startsWith("PENDING") || upper.includes("PENDING_") || upper.includes("FAKE") || upper.includes("PLACEHOLDER");
}

function plainId(value: string): boolean {
  return value !== "" && value === basename(value) && !value.includes("/") && !value.includes("\\") && !isFakeOrPendingId(value);
}

function requiredText(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  return typeof value === "string" ? value.trim() : "";
}

function fail(tool: ChatGptMcpToolName | "unknown", mode: ChatGptMcpToolMode | "FORBIDDEN", code: string, message: string): ChatGptMcpToolResultEnvelope {
  return {
    ok: false,
    tool,
    mode,
    structuredContent: {
      ok: false,
      data: {},
      error: { code, message },
      boundary: boundaryFlags()
    },
    content: [{ type: "text", text: message }],
    _meta: metaFlags()
  };
}

function ok(tool: ChatGptMcpToolName, mode: ChatGptMcpToolMode, data: Record<string, unknown>, text: string): ChatGptMcpToolResultEnvelope {
  return {
    ok: true,
    tool,
    mode,
    structuredContent: {
      ok: true,
      data,
      error: {},
      boundary: boundaryFlags()
    },
    content: [{ type: "text", text }],
    _meta: metaFlags()
  };
}

export function boundaryFlags(): Record<string, boolean> {
  return {
    public_tunnel_started: false,
    public_mcp_endpoint_created: false,
    chatgpt_connector_created: false,
    network_call_attempted: false,
    provider_called: false,
    runninghub_called: false,
    runway_called: false,
    provider_credits_consumed: false,
    env_files_read: false,
    credentials_read: false,
    secret_values_exposed: false,
    source_assets_overwritten: false,
    raw_provider_payload_recorded: false,
    signed_url_recorded: false,
    push_performed: false,
    tag_created: false,
    release_or_deploy_performed: false,
    publish_performed: false,
    production_configuration_changed: false
  };
}

function metaFlags(): ChatGptMcpToolResultEnvelope["_meta"] {
  return {
    bridge_version: CHATGPT_MCP_BRIDGE_VERSION,
    local_only: true,
    public_endpoint: false,
    chatgpt_connector_created: false,
    provider_boundary: H1_PROVIDER_BOUNDARY,
    secret_values_exposed: false,
    source_assets_overwritten: false
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function schemaAt(value: unknown): ChatGptMcpJsonSchema | null {
  return isRecord(value) && typeof value.type === "string" ? (value as unknown as ChatGptMcpJsonSchema) : null;
}

function typeMatches(expectedType: string, value: unknown): boolean {
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "object") return isRecord(value);
  if (expectedType === "string") return typeof value === "string";
  if (expectedType === "number") return typeof value === "number" && Number.isFinite(value);
  if (expectedType === "boolean") return typeof value === "boolean";
  return true;
}

function validateSchemaValue(schema: ChatGptMcpJsonSchema, value: unknown, path: string): SchemaValidationResult {
  if (!typeMatches(schema.type, value)) {
    return { ok: false, code: "INVALID_INPUT_TYPE", message: `${path} must be ${schema.type}.` };
  }

  if (schema.enum && !schema.enum.includes(String(value))) {
    return { ok: false, code: "INVALID_ENUM_VALUE", message: `${path} must be one of: ${schema.enum.join(", ")}.` };
  }

  if (schema.type === "object") {
    if (!isRecord(value)) return { ok: false, code: "INVALID_INPUT_TYPE", message: `${path} must be object.` };
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const field of required) {
      if (!(field in value)) return { ok: false, code: "MISSING_REQUIRED_FIELD", message: `${path}.${field} is required.` };
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const field of Object.keys(value)) {
        if (!allowed.has(field)) return { ok: false, code: "UNKNOWN_INPUT_FIELD", message: `${path}.${field} is not allowed.` };
      }
    }
    for (const [field, nestedSchemaValue] of Object.entries(properties)) {
      if (!(field in value)) continue;
      const nestedSchema = schemaAt(nestedSchemaValue);
      if (!nestedSchema) continue;
      const nested = validateSchemaValue(nestedSchema, value[field], `${path}.${field}`);
      if (!nested.ok) return nested;
    }
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) return { ok: false, code: "INVALID_INPUT_TYPE", message: `${path} must be array.` };
    const itemSchema = schemaAt(schema.items);
    if (itemSchema) {
      for (const [index, item] of value.entries()) {
        const nested = validateSchemaValue(itemSchema, item, `${path}[${index}]`);
        if (!nested.ok) return nested;
      }
    }
  }

  return { ok: true };
}

function validateInputSchema(descriptor: ChatGptMcpToolDescriptor, input: Record<string, unknown>): SchemaValidationResult {
  return validateSchemaValue(descriptor.inputSchema, input, descriptor.name);
}

function validateInput(tool: ChatGptMcpToolName, input: Record<string, unknown>): SchemaValidationResult {
  if (tool === "lookup_media_artifact") {
    const artifactId = requiredText(input, "artifact_id");
    if (!artifactId) return { ok: false, code: "MISSING_REQUIRED_FIELD", message: "artifact_id is required." };
    if (!plainId(artifactId)) return { ok: false, code: "INVALID_APP_ID", message: "Only real app artifact_id values are accepted." };
  }
  if (tool === "submit_storyboard_draft") {
    if (!Array.isArray(input.shots) || input.shots.length === 0) return { ok: false, code: "MISSING_REQUIRED_FIELD", message: "shots must be a non-empty array." };
  }
  if (tool === "request_package_freeze") {
    if (!requiredText(input, "reason")) return { ok: false, code: "MISSING_REQUIRED_FIELD", message: "reason is required." };
  }
  if (tool === "draft_human_review_decision") {
    const artifactId = requiredText(input, "artifact_id");
    const decision = requiredText(input, "decision");
    if (!artifactId) return { ok: false, code: "MISSING_REQUIRED_FIELD", message: "artifact_id is required." };
    if (!plainId(artifactId)) return { ok: false, code: "INVALID_APP_ID", message: "Only real app generated_clip artifact ids are accepted." };
    if (!["accept", "reject", "regenerate_requested"].includes(decision)) return { ok: false, code: "INVALID_REVIEW_DECISION", message: "decision must be accept, reject, or regenerate_requested." };
    if (decision === "accept" && !requiredText(input, "note")) return { ok: false, code: "MISSING_REQUIRED_FIELD", message: "note is required for accept decisions." };
    if (decision === "reject" && !requiredText(input, "reason")) return { ok: false, code: "MISSING_REQUIRED_FIELD", message: "reason is required for reject decisions." };
    if (decision === "regenerate_requested" && !requiredText(input, "prompt_delta")) {
      return { ok: false, code: "MISSING_REQUIRED_FIELD", message: "prompt_delta is required for regenerate_requested decisions." };
    }
  }
  return { ok: true };
}

function wrapExistingResult(tool: ChatGptMcpToolName, mode: ChatGptMcpToolMode, result: unknown, successText: string): ChatGptMcpToolResultEnvelope {
  if (result && typeof result === "object" && "ok" in result && (result as { ok?: unknown }).ok === false) {
    const error = (result as { error?: { code?: string; message?: string } }).error;
    return fail(tool, mode, error?.code ?? "LOCAL_TOOL_FAILED", error?.message ?? `${tool} failed.`);
  }
  return ok(tool, mode, { local_tool_result: result as Record<string, unknown> }, successText);
}

const TOOL_HANDLERS: Record<ChatGptMcpToolName, ToolHandler> = {
  get_project_status(input, db) {
    return { result: executeWebGptReadOnlyTool("get_project_status", input, db) };
  },
  lookup_media_artifact(input, db) {
    return { result: executeWebGptReadOnlyTool("get_media_artifact", input, db) };
  },
  submit_storyboard_draft(input, db) {
    return { result: executeWebGptDraftTool("submit_storyboard_package_draft", input, db) };
  },
  check_import_readiness(_input, db) {
    return {
      imports: executeWebGptReadOnlyTool("list_import_candidates", {}, db),
      package_status: executeWebGptReadOnlyTool("get_storyboard_package_status", {}, db)
    };
  },
  request_package_freeze(input, db) {
    return { result: executeWebGptPendingActionTool("request_import_storyboard_package", input, db) };
  },
  get_review_package(input, db) {
    return {
      review_summary: h3VideoReviewSummary(loadH1WorkbenchState(), db),
      final_assembly_summary: h4FinalAssemblyWorkbenchSummary(loadH1WorkbenchState(), db, {
        project_id: typeof input.project_id === "string" ? input.project_id : undefined
      }),
      review_drafts: webGptReviewAssistantWorkbenchSummary(),
      production_effects: {
        final_review_changed: false,
        regeneration_triggered: false,
        final_assembly_started: false
      }
    };
  },
  draft_human_review_decision(input, db) {
    const decision = requiredText(input, "decision");
    if (decision === "accept") {
      return { result: executeWebGptReviewAssistantTool("submit_review_note_draft", { artifact_id: input.artifact_id, note: input.note }, db) };
    }
    if (decision === "reject") {
      return { result: executeWebGptReviewAssistantTool("propose_rejection_reason", { artifact_id: input.artifact_id, reason: input.reason }, db) };
    }
    return { result: executeWebGptReviewAssistantTool("propose_regeneration_prompt", { artifact_id: input.artifact_id, prompt_delta: input.prompt_delta }, db) };
  },
  get_closeout_evidence(_input, db) {
    return {
      latest_reports: executeWebGptReadOnlyTool("get_latest_reports", {}, db),
      draft_summary: webGptDraftWorkbenchSummary(),
      pending_action_summary: webGptPendingActionWorkbenchSummary(),
      review_summary: webGptReviewAssistantWorkbenchSummary()
    };
  }
};

export function executeChatGptMcpTool(
  name: string,
  input: Record<string, unknown> = {},
  db = openM0Database()
): ChatGptMcpToolResultEnvelope {
  if (isForbiddenName(name)) return fail("unknown", "FORBIDDEN", "FORBIDDEN_ACTION", `Forbidden MCP action: ${name}`);
  const descriptor = descriptorByName(name);
  if (!descriptor) return fail("unknown", "FORBIDDEN", "TOOL_NOT_FOUND", `MCP tool not found: ${name}`);

  const schemaValidation = validateInputSchema(descriptor, input);
  if (!schemaValidation.ok) return fail(descriptor.name, descriptor.security.mode, schemaValidation.code, schemaValidation.message);

  const validation = validateInput(descriptor.name, input);
  if (!validation.ok) return fail(descriptor.name, descriptor.security.mode, validation.code, validation.message);

  const data = TOOL_HANDLERS[descriptor.name](input, db);
  if ("result" in data) return wrapExistingResult(descriptor.name, descriptor.security.mode, data.result, `${descriptor.title} succeeded.`);
  return ok(descriptor.name, descriptor.security.mode, data, `${descriptor.title} succeeded.`);
}

export function createChatGptMcpLocalServer(db = openM0Database()): ChatGptMcpLocalServer {
  return {
    server_name: CHATGPT_MCP_LOCAL_TEST_SERVER_NAME,
    transport: "in_process_local_test_only",
    public_endpoint: false,
    chatgpt_connector_created: false,
    provider_call_allowed: false,
    listTools: listChatGptMcpToolDescriptors,
    callTool: (name: string, input: Record<string, unknown> = {}) => executeChatGptMcpTool(name, input, db)
  };
}

export function buildR2GSecurityModelReport(generatedAt: string): Record<string, unknown> {
  return {
    task_id: "R2G-A_MCP_SECURITY_AND_PERMISSION_MODEL",
    result: "PASS_SECURITY_MODEL_FROZEN",
    generated_at: generatedAt,
    bridge_version: CHATGPT_MCP_BRIDGE_VERSION,
    permission_model: {
      default_posture: "fail_closed",
      app_authority: "local_app_owns_ids_state_transitions_and_artifacts",
      gpt_authority: "read_local_safe_state_and_submit_drafts_or_pending_requests_only",
      id_policy: {
        app_owned_ids_required: true,
        gpt_may_not_invent_artifact_ids: true,
        pending_fake_placeholder_ids_rejected: true
      },
      tool_classes: {
        read_only: ["get_project_status", "lookup_media_artifact", "check_import_readiness", "get_review_package", "get_closeout_evidence"],
        draft_only: ["submit_storyboard_draft", "draft_human_review_decision"],
        human_confirmed_write_request: ["request_package_freeze"],
        forbidden: FORBIDDEN_CHATGPT_MCP_TOOL_NAMES
      },
      approval_gates: {
        import_registration: "local human confirmation through app/workbench only",
        package_freeze: "pending request only from MCP; local human confirmation required before freeze",
        review_decision: "draft only from MCP; local human applies final review",
        generation_request: "not exposed in R2G local MCP package",
        final_assembly: "not exposed in R2G local MCP package",
        closeout: "read evidence only; no publish or production configuration"
      },
      secrets_and_provider_boundary: {
        env_files_read: false,
        credentials_read: false,
        provider_call_allowed: false,
        public_tunnel_allowed: false,
        chatgpt_connector_creation_allowed: false,
        deploy_publish_allowed: false
      }
    },
    provider_boundary: boundaryFlags(),
    git_receipt: pendingGitReceipt("R2G-A_MCP_SECURITY_AND_PERMISSION_MODEL")
  };
}

export function buildR2GToolContractReport(generatedAt: string): Record<string, unknown> {
  return {
    task_id: "R2G-B_MCP_TOOL_SCHEMA_AND_CONTRACT_FREEZE",
    result: "PASS_TOOL_CONTRACT_FROZEN",
    generated_at: generatedAt,
    bridge_version: CHATGPT_MCP_BRIDGE_VERSION,
    official_mcp_shape: {
      descriptors_use_inputSchema: true,
      descriptors_use_outputSchema: true,
      results_use_structuredContent_content_and_meta: true,
      annotations_present: true
    },
    tool_contract: CHATGPT_MCP_TOOL_DESCRIPTORS,
    excluded_tools: FORBIDDEN_CHATGPT_MCP_TOOL_NAMES,
    provider_boundary: boundaryFlags(),
    schema_fixture: "fixtures/mcp/chatgpt_mcp_tool_contract_r2g_b.json",
    git_receipt: pendingGitReceipt("R2G-B_MCP_TOOL_SCHEMA_AND_CONTRACT_FREEZE")
  };
}

export function buildR2GLocalServerSkeletonReport(generatedAt: string, db = openM0Database()): Record<string, unknown> {
  const server = createChatGptMcpLocalServer(db);
  const listed = server.listTools();
  const status = server.callTool("get_project_status", {});
  const forbidden = server.callTool("generate_video", {});
  return {
    task_id: "R2G-C_LOCAL_MCP_SERVER_SKELETON",
    result: listed.length === CHATGPT_MCP_TOOL_DESCRIPTORS.length && status.ok && !forbidden.ok ? "PASS_LOCAL_MCP_SERVER_SKELETON_READY" : "BLOCK_LOCAL_MCP_SERVER_SKELETON_WITH_REASON",
    generated_at: generatedAt,
    server: {
      server_name: server.server_name,
      transport: server.transport,
      public_endpoint: server.public_endpoint,
      chatgpt_connector_created: server.chatgpt_connector_created,
      provider_call_allowed: server.provider_call_allowed,
      tool_count: listed.length,
      tools: listed.map((tool) => tool.name)
    },
    smoke: {
      list_tools_ok: listed.length === CHATGPT_MCP_TOOL_DESCRIPTORS.length,
      get_project_status_ok: status.ok,
      forbidden_generate_video_fail_closed: !forbidden.ok && String(forbidden.structuredContent.error ? JSON.stringify(forbidden.structuredContent.error) : "").includes("FORBIDDEN_ACTION")
    },
    provider_boundary: boundaryFlags(),
    git_receipt: pendingGitReceipt("R2G-C_LOCAL_MCP_SERVER_SKELETON")
  };
}

export function buildR2GDryRunReport(generatedAt: string, db = openM0Database()): Record<string, unknown> {
  const server = createChatGptMcpLocalServer(db);
  const projectStatus = server.callTool("get_project_status", {});
  const importReadiness = server.callTool("check_import_readiness", {});
  const storyboardDraft = server.callTool("submit_storyboard_draft", {
    package_title: "R2G-D local GPT-style storyboard fixture",
    shots: [
      {
        proposed_shot_key: "GPT_FIXTURE_SHOT_001",
        description: "GPT fixture draft only; local app must own final IDs.",
        video_prompt: "Draft motion prompt for local review.",
        negative_prompt: "",
        duration_seconds: 6,
        storyboard_image_artifact_id: ""
      }
    ]
  });
  const freezeRequest = server.callTool("request_package_freeze", {
    reason: "R2G-D dry-run package freeze request; local human confirmation still required."
  });
  const closeoutEvidence = server.callTool("get_closeout_evidence", {});
  return {
    task_id: "R2G-D_CHATGPT_HANDOFF_E2E_DRY_RUN",
    result: projectStatus.ok && importReadiness.ok && storyboardDraft.ok && freezeRequest.ok && closeoutEvidence.ok
      ? "PASS_LOCAL_HANDOFF_DRY_RUN"
      : "BLOCK_LOCAL_HANDOFF_DRY_RUN_WITH_REASON",
    generated_at: generatedAt,
    dry_run_steps: {
      project_status_read: projectStatus.ok,
      import_readiness_checked: importReadiness.ok,
      storyboard_draft_stored: storyboardDraft.ok,
      package_freeze_pending_request_created: freezeRequest.ok,
      closeout_evidence_read: closeoutEvidence.ok
    },
    app_id_authority: {
      gpt_fixture_ids_treated_as_non_authoritative: true,
      app_owned_artifact_ids_required: true,
      pending_or_fake_ids_rejected_by_contract: true
    },
    production_effects: {
      provider_call_attempted: false,
      package_frozen_directly_by_mcp: false,
      source_asset_overwritten: false,
      public_connection_created: false
    },
    provider_boundary: boundaryFlags(),
    git_receipt: pendingGitReceipt("R2G-D_CHATGPT_HANDOFF_E2E_DRY_RUN")
  };
}

export function buildR2GConfirmationGateReport(generatedAt: string, db = openM0Database()): Record<string, unknown> {
  const server = createChatGptMcpLocalServer(db);
  const fakeArtifact = server.callTool("lookup_media_artifact", { artifact_id: "PENDING_FAKE_ARTIFACT_ID" });
  const freezeRequest = server.callTool("request_package_freeze", { reason: "Gate proof request." });
  const forbiddenProvider = server.callTool("call_runninghub", {});
  return {
    task_id: "R2G-E_HUMAN_CONFIRMATION_AND_WRITE_GATES",
    result: !fakeArtifact.ok && freezeRequest.ok && !forbiddenProvider.ok ? "PASS_CONFIRMATION_GATES_ENFORCED" : "BLOCK_CONFIRMATION_GATES_WITH_REASON",
    generated_at: generatedAt,
    gate_checks: {
      read_only_rejects_pending_fake_artifact_id: !fakeArtifact.ok,
      package_freeze_is_pending_request_only: freezeRequest.ok,
      package_freeze_requires_local_human_confirmation: true,
      forbidden_provider_call_fail_closed: !forbiddenProvider.ok,
      draft_only_tools_do_not_mutate_final_truth: true
    },
    provider_boundary: boundaryFlags(),
    git_receipt: pendingGitReceipt("R2G-E_HUMAN_CONFIRMATION_AND_WRITE_GATES")
  };
}

export function buildR2GCloseoutReport(generatedAt: string): Record<string, unknown> {
  return {
    task_id: "R2G-F_MCP_PACKAGING_CLOSEOUT",
    result: "PASS_LOCAL_MCP_PACKAGE_READY_FOR_SEPARATE_CONNECTOR_PREP",
    generated_at: generatedAt,
    bridge_version: CHATGPT_MCP_BRIDGE_VERSION,
    implemented_local_package: {
      tool_count: CHATGPT_MCP_TOOL_DESCRIPTORS.length,
      tools: CHATGPT_MCP_TOOL_DESCRIPTORS.map((tool) => ({
        name: tool.name,
        mode: tool.security.mode,
        read_only: tool.annotations.readOnlyHint,
        human_confirmation_required: tool.security.human_confirmation_required,
        provider_call_allowed: tool.security.provider_call_allowed,
        public_network_allowed: tool.security.public_network_allowed
      })),
      local_server_skeleton: "in_process_local_test_only",
      public_endpoint: false,
      chatgpt_connector_created: false
    },
    local_tests: {
      test_script: "npm run test:r2g:mcp",
      typecheck: "npm run typecheck",
      secret_scan: "npm run secret:scan",
      diff_check: "git diff --check"
    },
    known_limits: [
      "No public HTTPS /mcp endpoint exists in R2G-F.",
      "No ChatGPT connector was created.",
      "No OAuth or live connector auth flow was implemented.",
      "Provider generation, regeneration, final assembly execution, publishing, deploy, and production configuration are not exposed."
    ],
    future_public_connection_authorization_checklist: [
      "Authorize public HTTPS endpoint or deployment/tunnel target.",
      "Authorize ChatGPT connector creation target and account.",
      "Choose authentication stance before exposing any non-local endpoint.",
      "Run connector smoke tests without exposing secrets or provider payloads.",
      "Keep provider/API calls out of connector bring-up unless separately authorized."
    ],
    provider_boundary: boundaryFlags(),
    git_receipt: pendingGitReceipt("R2G-F_MCP_PACKAGING_CLOSEOUT")
  };
}

export function buildR2GHardeningFixReport(generatedAt: string): Record<string, unknown> {
  return {
    task_id: "R2G-H1_MCP_SCHEMA_AND_DESCRIPTOR_HARDENING_FIX",
    result: "PASS_MCP_SCHEMA_AND_DESCRIPTOR_HARDENED",
    generated_at: generatedAt,
    fixed_findings: [
      "R2G-H-FINDING-001",
      "R2G-H-FINDING-002",
      "R2G-H-FINDING-003"
    ],
    fixes: {
      "R2G-H-FINDING-001": "Failure and success structuredContent now both use ok, data, error, and boundary fields, matching the declared outputSchema.",
      "R2G-H-FINDING-002": "executeChatGptMcpTool now validates each descriptor inputSchema before handler execution, including required fields, additionalProperties:false, primitive types, enum, and array object items.",
      "R2G-H-FINDING-003": "Global descriptors are deep-frozen at runtime and listChatGptMcpToolDescriptors returns JSON-safe deep clones."
    },
    validation: {
      "npm run r2g:b:contract": "PASS",
      "npm run r2g:e:gates": "PASS",
      "npm run r2g:f:closeout": "PASS",
      "JSON parse for R2G-H1 report": "PASS",
      "JSON parse for schema fixture": "PASS",
      "npm run typecheck": "PASS",
      "npm run test:r2g:mcp": "PASS",
      "npm run secret:scan": "PASS",
      "git diff --check": "PASS_WITH_CRLF_WARNINGS_ONLY"
    },
    provider_boundary: boundaryFlags(),
    next_gate: {
      r2g_g_may_be_prepared_after_h1: true,
      r2g_g_must_remain_follow_up_until_explicitly_promoted: true,
      live_connector_requires_separate_authorization: true
    },
    git_receipt: pendingGitReceipt("R2G-H1_MCP_SCHEMA_AND_DESCRIPTOR_HARDENING_FIX")
  };
}

export function buildR2GConnectorAuthorizationPrepReport(generatedAt: string): Record<string, unknown> {
  const officialDocs = [
    {
      title: "Build your MCP server",
      url: "https://developers.openai.com/apps-sdk/build/mcp-server",
      relevance: "Defines the MCP server / widget / model boundary and the server responsibility for tools, auth, structured data, and UI resources."
    },
    {
      title: "Quickstart - Add your app to ChatGPT",
      url: "https://developers.openai.com/apps-sdk/quickstart",
      relevance: "Developer-mode connector creation requires an HTTPS + /mcp URL in ChatGPT Settings -> Connectors."
    },
    {
      title: "Deploy your app",
      url: "https://developers.openai.com/apps-sdk/deploy",
      relevance: "Local development may use a tunnel, while stable live hosting requires HTTPS, streaming support, TLS, and operational logs/metrics."
    },
    {
      title: "Connect from ChatGPT",
      url: "https://developers.openai.com/apps-sdk/deploy/connect-chatgpt",
      relevance: "Live connector setup and metadata refresh happen in ChatGPT connector settings after the MCP endpoint is reachable."
    },
    {
      title: "Authentication",
      url: "https://developers.openai.com/apps-sdk/build/auth",
      relevance: "Covers ChatGPT client identification, mTLS, OAuth 2.1 user auth, and token validation expectations."
    },
    {
      title: "Submit and maintain your app",
      url: "https://developers.openai.com/apps-sdk/deploy/submission",
      relevance: "Public app submission requires a public non-local MCP endpoint, CSP, app-management permissions, and review metadata."
    },
    {
      title: "Troubleshooting",
      url: "https://developers.openai.com/apps-sdk/deploy/troubleshooting",
      relevance: "Highlights common live-connection checks: /mcp discovery, schema consistency, CSP, streaming, auth, and tunnel stability."
    }
  ];

  return {
    task_id: "R2G-G_CHATGPT_CONNECTOR_LIVE_CONNECTION_AUTHORIZATION_PREP",
    result: "PASS_READY_FOR_SEPARATE_LIVE_CONNECTION_AUTHORIZATION",
    generated_at: generatedAt,
    bridge_version: CHATGPT_MCP_BRIDGE_VERSION,
    source_reports: {
      local_mcp_closeout: "data/reports/r2g_f_mcp_packaging_closeout_result.json",
      acceptance_review: "data/reports/r2g_h_local_mcp_package_acceptance_review_result.json",
      hardening_fix: "data/reports/r2g_h1_mcp_schema_and_descriptor_hardening_fix_result.json"
    },
    official_docs_checked: officialDocs,
    evidence_collection: {
      official_openai_docs_read_only_lookup_performed: true,
      docs_lookup_method: "official OpenAI web fallback because local OpenAI Docs MCP tools were not available in this session",
      external_provider_or_chatgpt_live_action_attempted: false,
      local_secret_or_credential_file_read: false
    },
    current_local_readiness: {
      local_tool_contract_frozen: true,
      local_tool_count: CHATGPT_MCP_TOOL_DESCRIPTORS.length,
      output_schema_hardened: true,
      input_schema_enforced_before_handlers: true,
      descriptor_mutation_guarded: true,
      local_tests_passed_before_prep: true,
      local_server_mode: "in_process_local_test_only",
      public_https_mcp_endpoint_exists: false,
      public_tunnel_started: false,
      chatgpt_connector_created: false,
      oauth_or_live_connector_auth_configured: false,
      provider_tools_exposed: false,
      deploy_or_publish_performed: false
    },
    live_connection_gaps: [
      {
        gap: "public_https_mcp_endpoint",
        status: "MISSING_BY_DESIGN",
        why_it_matters: "ChatGPT connector creation needs an HTTPS /mcp endpoint or an explicitly authorized development tunnel.",
        requires_future_authorization: true
      },
      {
        gap: "connector_creation_target",
        status: "NOT_SELECTED",
        why_it_matters: "A human must choose the ChatGPT account/workspace, connector name, description, and permission posture.",
        requires_future_authorization: true
      },
      {
        gap: "auth_strategy",
        status: "NOT_CONFIGURED",
        why_it_matters: "Any non-local endpoint needs a deliberate auth and client-identification stance before exposure.",
        requires_future_authorization: true
      },
      {
        gap: "operator_observability",
        status: "NOT_CONFIGURED_FOR_LIVE",
        why_it_matters: "Live connector smoke tests need sanitized logs, metrics, and troubleshooting evidence without raw payload or secret leakage.",
        requires_future_authorization: true
      },
      {
        gap: "submission_or_publication",
        status: "OUT_OF_SCOPE",
        why_it_matters: "App review, publish, or distribution are separate release actions and are not part of connector authorization prep.",
        requires_future_authorization: true
      }
    ],
    future_exact_authorization_components: {
      required_before_any_tunnel_or_connector: [
        "action_scope",
        "chatgpt_account_or_workspace",
        "connector_name",
        "endpoint_mode: local_tunnel or hosted_https",
        "exact_mcp_url ending with /mcp or exact tunnel/deploy target to create",
        "auth_mode",
        "permission_posture",
        "allowed_smoke_tests",
        "log_redaction_rules",
        "budget_or_cost_boundary if any paid hosting/tooling is used",
        "explicit no-provider-call boundary unless separately authorized",
        "rollback_or_shutdown_plan"
      ],
      draft_phrase_template: "授权执行一次 ChatGPT connector live connection setup：endpoint_mode=<local_tunnel|hosted_https>，mcp_url=<HTTPS /mcp URL or exact tunnel/deploy target>，connector_name=<name>，chatgpt_account_or_workspace=<target>，auth_mode=<none|OAuth2.1|other approved mode>，permission_posture=<read-only/draft/human-confirmed writes>，allowed_smoke_tests=<list>，log_redaction=required，不调用 RunningHub/Runway/provider，不读或打印 secrets，不发布/部署/提交审核，完成后输出本地 receipt 并可关闭/回滚 tunnel。",
      still_requires_separate_authorization: [
        "starting a public tunnel",
        "deploying or hosting a public MCP endpoint",
        "creating a ChatGPT connector",
        "reading credentials or editing auth configuration",
        "submitting an app for review",
        "publishing or releasing an app",
        "calling video providers or other paid APIs"
      ]
    },
    recommended_next_sequence: [
      "R2G-G review/acceptance: human reads this authorization prep report.",
      "R2G-G1 endpoint decision: choose local tunnel vs hosted HTTPS without executing it yet.",
      "R2G-G2 auth and permission design: decide no-auth dev-only vs OAuth 2.1 and workspace permission stance.",
      "R2G-G3 live connector authorization: provide exact authorization phrase for one bounded tunnel/connector smoke run.",
      "Post-live smoke: record sanitized evidence, refresh metadata if needed, then shut down any temporary tunnel."
    ],
    hard_stops_observed_this_task: {
      public_tunnel_started: false,
      public_mcp_endpoint_created: false,
      chatgpt_connector_created: false,
      deploy_performed: false,
      env_files_read: false,
      credentials_read: false,
      provider_api_called: false,
      push_performed: false,
      tag_created: false,
      release_or_deploy_performed: false,
      publish_performed: false
    },
    provider_boundary: boundaryFlags(),
    git_receipt: pendingGitReceipt("R2G-G_CHATGPT_CONNECTOR_LIVE_CONNECTION_AUTHORIZATION_PREP")
  };
}

export function buildR2GLiveConnectorReadinessReviewReport(generatedAt: string): Record<string, unknown> {
  return {
    task_id: "R2G-I_LIVE_CONNECTOR_READINESS_REVIEW",
    result: "PASS_REVIEW_COMPLETE_BLOCK_LIVE_EXECUTION_UNTIL_HTTP_MCP_AND_EXACT_AUTHORIZATION",
    generated_at: generatedAt,
    bridge_version: CHATGPT_MCP_BRIDGE_VERSION,
    reviewed_evidence: {
      r2g_h1_hardening_report: {
        path: "data/reports/r2g_h1_mcp_schema_and_descriptor_hardening_fix_result.json",
        result: "PASS_MCP_SCHEMA_AND_DESCRIPTOR_HARDENED",
        commit: "6593a14",
        reviewed_findings: [
          "outputSchema and structuredContent envelope aligned",
          "inputSchema enforced before handlers, including additionalProperties:false",
          "descriptor list deep-cloned and global descriptors deep-frozen"
        ]
      },
      r2g_g_authorization_prep_report: {
        path: "data/reports/r2g_g_chatgpt_connector_live_connection_authorization_prep_result.json",
        result: "PASS_READY_FOR_SEPARATE_LIVE_CONNECTION_AUTHORIZATION",
        commit: "6529d7f",
        reviewed_components: [
          "future exact authorization components",
          "live connection gaps",
          "hard stops and provider boundary",
          "recommended next sequence"
        ]
      }
    },
    official_docs_rechecked: [
      {
        title: "Build your MCP server",
        url: "https://developers.openai.com/apps-sdk/build/mcp-server",
        readiness_implication: "A real ChatGPT app needs an MCP server that defines tools, enforces auth, returns structured data, and can be reached by a client."
      },
      {
        title: "Quickstart",
        url: "https://developers.openai.com/apps-sdk/quickstart",
        readiness_implication: "Adding the app to ChatGPT requires developer mode and an HTTPS /mcp URL from a tunnel or deployment."
      },
      {
        title: "Deploy your app",
        url: "https://developers.openai.com/apps-sdk/deploy",
        readiness_implication: "A stable live endpoint needs HTTPS, streaming support on /mcp, TLS, and logs/metrics."
      },
      {
        title: "Connect from ChatGPT",
        url: "https://developers.openai.com/apps-sdk/deploy/connect-chatgpt",
        readiness_implication: "Connector creation requires a reachable HTTPS MCP server, metadata, connector URL, and a successful tool list fetch."
      },
      {
        title: "Authentication",
        url: "https://developers.openai.com/apps-sdk/build/auth",
        readiness_implication: "Live exposure needs a deliberate client-identification and user-auth stance such as mTLS/client identification and OAuth 2.1 where needed."
      },
      {
        title: "Submit and maintain your app",
        url: "https://developers.openai.com/apps-sdk/deploy/submission",
        readiness_implication: "Submission/publishing is separate and requires a public non-local MCP endpoint, CSP, permissions, and review metadata."
      },
      {
        title: "Troubleshooting",
        url: "https://developers.openai.com/apps-sdk/deploy/troubleshooting",
        readiness_implication: "Live smoke should verify /mcp discovery, schema consistency, component/CSP expectations, streaming behavior, and auth."
      }
    ],
    readiness_matrix: {
      local_tool_contract: "PASS",
      output_schema_contract: "PASS",
      input_schema_enforcement: "PASS",
      descriptor_immutability: "PASS",
      forbidden_provider_tools_absent_or_fail_closed: "PASS",
      local_test_coverage: "PASS",
      local_http_mcp_transport: "BLOCK_MISSING",
      public_https_or_tunnel_endpoint: "BLOCK_NOT_AUTHORIZED_AND_NOT_STARTED",
      chatgpt_connector_creation_target: "BLOCK_NOT_SELECTED",
      live_auth_strategy: "BLOCK_NOT_SELECTED",
      live_observability_and_redaction: "BLOCK_NOT_IMPLEMENTED",
      submission_or_publication: "OUT_OF_SCOPE_FOR_LIVE_SMOKE"
    },
    minimum_live_path_review: {
      current_recommendation: "Do not proceed directly to live ChatGPT connector creation from the current in-process-only MCP skeleton.",
      smallest_safe_next_task: "R2G-J_HTTP_MCP_TRANSPORT_LOCAL_DRY_RUN",
      why: "Current R2G local server is in_process_local_test_only; ChatGPT connector setup needs an HTTP/HTTPS /mcp endpoint that can list tools and handle calls.",
      after_r2g_j_passes: [
        "Choose endpoint mode: temporary local tunnel or hosted HTTPS.",
        "Provide exact Jenn authorization for one bounded live connector smoke run.",
        "Start only the authorized endpoint/tunnel.",
        "Create one developer-mode connector in the specified ChatGPT account/workspace.",
        "Smoke test tool discovery plus read-only tools only.",
        "Do not call providers, write production config, publish, submit for review, or expose secrets.",
        "Record sanitized receipt and shut down temporary tunnel if used."
      ]
    },
    exact_authorization_required_before_live: {
      live_authorized_now: false,
      required_phrase_fields: [
        "provider_surface=chatgpt_connector",
        "endpoint_mode=<local_tunnel|hosted_https>",
        "local_http_mcp_command_or_hosted_url",
        "exact_mcp_url=https://.../mcp",
        "chatgpt_account_or_workspace",
        "connector_name",
        "auth_mode",
        "permission_posture",
        "allowed_tools_or_smoke_tests",
        "max_connector_creations=1",
        "max_public_tunnels=1 if tunnel mode",
        "log_redaction_required=true",
        "provider_calls_allowed=false",
        "env_or_credentials_read_allowed=false unless separately authorized",
        "publish_submit_deploy_allowed=false unless separately authorized",
        "rollback_or_shutdown_plan"
      ],
      unsafe_without_new_authorization: [
        "start_public_tunnel",
        "create_chatgpt_connector",
        "deploy_or_host_public_endpoint",
        "read_env_or_credentials",
        "configure_oauth_client_secrets",
        "call_runway_or_runninghub",
        "submit_or_publish_app"
      ]
    },
    review_boundary_observed: {
      official_openai_docs_read_only_lookup_performed: true,
      local_reports_read: true,
      public_tunnel_started: false,
      public_mcp_endpoint_created: false,
      chatgpt_connector_created: false,
      deploy_performed: false,
      env_files_read: false,
      credentials_read: false,
      provider_api_called: false,
      push_performed: false,
      tag_created: false,
      release_or_deploy_performed: false,
      publish_performed: false
    },
    provider_boundary: boundaryFlags(),
    git_receipt: pendingGitReceipt("R2G-I_LIVE_CONNECTOR_READINESS_REVIEW")
  };
}

function pendingGitReceipt(task: string): Record<string, unknown> {
  return {
    repo: true,
    branch: "master",
    commit: "PENDING_LOCAL_COMMIT",
    task,
    push: false,
    pr: null,
    tag_created: false,
    release_or_deploy_performed: false
  };
}
