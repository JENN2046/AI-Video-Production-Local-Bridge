import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod/v4";

import type { M0Database } from "../storage/sqlite.js";
import { wwwAuthenticate, type WebGptV4AuthConfig } from "./auth.js";
import {
  addProductionReviewNote,
  closeProductionProposal,
  getProductionCloseoutEvidence,
  getProductionDeliveryStatus,
  getProductionProjectContext,
  getProductionReviewPackage,
  listProductionProjectMedia,
  listProductionProjectShots,
  listProductionProjects,
  prepareProductionGenerationIntent,
  reviseProductionProposal,
  submitProductionProposal,
  updateProductionShotCopy,
  type ProductionProposalKind
} from "./domain.js";
import { inspectProductionMedia, type MediaRuntimeOptions } from "./media.js";
import { productionProposalRevisionSchema, productionProposalSubmitSchema } from "./proposals.js";
import { readonlyDelivery, readonlyProjectContext, readonlyProjectList, readonlyReviewPackage, readonlyShotList, WEBGPT_V4_READONLY_OUTPUT_SCHEMAS } from "./readonlyContracts.js";
import { WEBGPT_V4_FULL_TOOL_SCOPES } from "./toolCatalog.js";
import { webGptV4Tool, webGptV4ToolsForProfile, type WebGptV4Profile, type WebGptV4ToolName } from "./toolCatalog.js";
import { errorBody, fail, requestId, requireScope, WEBGPT_V4_VERSION, WebGptV4Error, type WebGptV4Actor, type WebGptV4Result, type WebGptV4Scope } from "./types.js";

export const WEBGPT_V4_WIDGET_URI = "ui://webgpt-v4/media-inspector.html";

export const WEBGPT_V4_TOOL_SCOPES = WEBGPT_V4_FULL_TOOL_SCOPES;

const successMetaSchema = z.object({
  request_id: z.string(),
  source_version: z.string(),
  updated_at: z.string(),
  idempotent_replay: z.boolean().optional()
});

const errorSchema = z.object({ code: z.string(), message: z.string(), field: z.string().optional(), retryable: z.boolean().optional() });
const jsonRecordSchema = z.record(z.string(), z.json());
const pageSchema = z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int(), has_more: z.boolean() });
const projectSchema = z.object({ project_id: z.string(), title: z.string(), status: z.string(), shot_ids: z.array(z.string()) }).passthrough();
const shotSchema = z.object({
  shot_id: z.string(), project_id: z.string(), order: z.number(), status: z.string(), duration_seconds: z.number(),
  description: z.string(), storyboard_image_artifact_id: z.string(), video_prompt: z.string(), negative_prompt: z.string(),
  generation_run_ids: z.array(z.string()), accepted_clip_artifact_id: z.string(), clip_versions: z.array(jsonRecordSchema), review: jsonRecordSchema,
  updated_at: z.string().optional()
}).passthrough();
const artifactSchema = z.object({
  artifact_id: z.string(), artifact_type: z.enum(["image", "video"]), role: z.enum(["storyboard_image", "generated_clip", "final_video"]),
  status: z.string(), filename: z.string(), mime_type: z.string(), metadata: jsonRecordSchema, linked_objects: jsonRecordSchema,
  provenance: jsonRecordSchema, updated_at: z.string().optional()
}).passthrough();
const draftSchema = z.object({
  draft_id: z.string(), tool: z.string(), status: z.string(), source: z.string(), created_at: z.string(), updated_at: z.string(),
  target_project_id: z.string(), target_shot_id: z.string(), payload: jsonRecordSchema
}).passthrough();
const reviewNoteSchema = z.object({
  note_id: z.string(), project_id: z.string(), shot_id: z.string(), artifact_id: z.string(), note: z.string(), source: z.string(), created_at: z.string(), updated_at: z.string()
});
const generationIntentSchema = z.object({
  intent_id: z.string(), project_id: z.string(), shot_id: z.string(), provider: z.literal("runninghub"), account_label: z.enum(["personal", "team"]),
  model: z.string(), input_artifact_id: z.string(), estimated_cost_value: z.number(), budget_limit_value: z.number(), currency: z.string(),
  confirmed: z.boolean(), status: z.literal("prepared"), expires_at: z.string(), requires_human_preflight: z.boolean(), provider_call_attempted: z.boolean()
});
const projectListSchema = z.object({ items: z.array(z.object({ project: projectSchema, lifecycle: z.string(), pinned: z.boolean(), last_opened_at: z.string().nullable(), updated_at: z.string(), summary: jsonRecordSchema }).passthrough()), page: pageSchema });
const shotListSchema = z.object({ items: z.array(shotSchema), page: pageSchema });
const mediaListSchema = z.object({ items: z.array(artifactSchema), page: pageSchema });
const projectContextSchema = z.object({
  project: projectSchema, meta: jsonRecordSchema, summary: jsonRecordSchema,
  workspace: z.enum(["overview", "storyboard", "generation", "review", "delivery"]),
  metrics: jsonRecordSchema.optional(), blockers: z.array(jsonRecordSchema).optional(), recent_runs: z.array(jsonRecordSchema).optional(),
  shots: z.array(shotSchema).optional(), packages: z.array(jsonRecordSchema).optional(), artifacts: jsonRecordSchema.optional(), runs: z.array(jsonRecordSchema).optional(),
  version_stacks: z.array(jsonRecordSchema).optional(), regeneration_requests: z.array(jsonRecordSchema).optional(), review_notes: z.array(reviewNoteSchema).optional(),
  ready_for_assembly: z.boolean().optional(), accepted_clips: z.array(jsonRecordSchema).optional(), final_artifact: artifactSchema.nullable().optional()
}).passthrough();
const inspectSchema = z.object({ artifact: artifactSchema, analysis: z.object({ kind: z.enum(["image", "video"]), model_input: z.string(), sha256: z.string() }).passthrough() });
const reviewPackageSchema = z.object({ shot: shotSchema, versions: z.array(jsonRecordSchema), notes: z.array(reviewNoteSchema), selected_artifact_id: z.string() });
const deliverySchema = z.object({ project_id: z.string(), project_status: z.string(), shots_total: z.number().int(), shots_accepted: z.number().int(), ready_for_assembly: z.boolean(), final_artifact: artifactSchema.nullable(), delivered: z.boolean() });
const closeoutSchema = deliverySchema.extend({ evidence: z.object({ source: z.literal("sqlite_structured_summary"), webgpt_audit_events: z.number().int(), raw_reports_exposed: z.literal(false) }) });
const shotCopySchema = z.object({ shot: shotSchema, updated_at: z.string() });
const proposalSchema = z.object({ draft: draftSchema });
const revisedProposalSchema = z.object({ draft: draftSchema, closed_draft_id: z.string() });

function resultSchema(dataSchema: z.ZodType): Record<string, z.ZodType> {
  return {
    ok: z.boolean(),
    data: dataSchema.optional(),
    error: errorSchema.optional(),
    meta: successMetaSchema
  };
}

const projectListResultSchema = resultSchema(projectListSchema);
const shotListResultSchema = resultSchema(shotListSchema);
const mediaListResultSchema = resultSchema(mediaListSchema);
const projectContextResultSchema = resultSchema(projectContextSchema);
const inspectResultSchema = resultSchema(inspectSchema);
const reviewPackageResultSchema = resultSchema(reviewPackageSchema);
const deliveryResultSchema = resultSchema(deliverySchema);
const closeoutResultSchema = resultSchema(closeoutSchema);
const shotCopyResultSchema = resultSchema(shotCopySchema);
const reviewNoteResultSchema = resultSchema(reviewNoteSchema);
const proposalResultSchema = resultSchema(proposalSchema);
const revisedProposalResultSchema = resultSchema(revisedProposalSchema);
const generationIntentResultSchema = resultSchema(generationIntentSchema);

function security(scope: WebGptV4Scope): Record<string, unknown> {
  return { securitySchemes: [{ type: "oauth2", scopes: [scope] }] };
}

function contract(name: WebGptV4ToolName): { annotations: WebGptV4ToolCatalogAnnotations; _meta: Record<string, unknown> } {
  const tool = webGptV4Tool(name);
  return { annotations: tool.annotations, _meta: { ...security(tool.scope) } };
}

type WebGptV4ToolCatalogAnnotations = ReturnType<typeof webGptV4Tool>["annotations"];

function asToolResult<T>(result: WebGptV4Result<T>, extra?: { content?: Array<Record<string, unknown>>; meta?: Record<string, unknown> }): Record<string, unknown> {
  const message = result.ok ? JSON.stringify(result.data) : `${result.error.code}: ${result.error.message}`;
  return {
    isError: !result.ok,
    structuredContent: result,
    content: extra?.content ?? [{ type: "text", text: message }],
    _meta: extra?.meta ?? {}
  };
}

function guarded<T>(scope: WebGptV4Scope, actor: WebGptV4Actor, authConfig: WebGptV4AuthConfig | null, idValue: string | undefined, operation: () => WebGptV4Result<T>): Record<string, unknown> {
  const id = requestId(idValue);
  try {
    requireScope(actor, scope);
    return asToolResult(operation());
  } catch (error) {
    const safe = errorBody(error);
    const meta = safe.code === "INSUFFICIENT_SCOPE"
      ? { "mcp/www_authenticate": [wwwAuthenticate(authConfig, "insufficient_scope", { scope, error_description: safe.message })] }
      : undefined;
    return asToolResult(fail(id, safe), meta ? { meta } : undefined);
  }
}

function widgetHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font-family:Inter,"Microsoft YaHei",sans-serif}*{box-sizing:border-box}body{margin:0;padding:12px;background:transparent;color:CanvasText}.shell{border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:8px;overflow:hidden;background:color-mix(in srgb,Canvas 94%,transparent)}header{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent)}h1{font-size:14px;margin:0}small{opacity:.68}.stage{background:#0a0b0e;aspect-ratio:16/9;display:grid;place-items:center}.stage video,.stage img{width:100%;height:100%;object-fit:contain}.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:color-mix(in srgb,CanvasText 10%,transparent)}.fact{padding:8px 10px;background:Canvas;font-size:12px}.fact strong{display:block;overflow:hidden;text-overflow:ellipsis}.empty{padding:28px;text-align:center;opacity:.7}@media(max-width:520px){.facts{grid-template-columns:1fr}.stage{aspect-ratio:4/3}}
</style></head><body><main class="shell"><header><div><h1 id="title">生产媒体</h1><small id="subtitle">等待媒体结果</small></div></header><section id="stage" class="stage"><div class="empty">尚未载入媒体</div></section><section id="facts" class="facts"></section></main>
<script type="module">
const stage=document.getElementById('stage'),title=document.getElementById('title'),subtitle=document.getElementById('subtitle'),facts=document.getElementById('facts');
function render(result){const sc=result?.structuredContent||result||{};if(!sc.ok)return;const artifact=sc.data?.artifact||{};const analysis=sc.data?.analysis||{};const meta=result?._meta||{};title.textContent=artifact.filename||artifact.artifact_id||'生产媒体';subtitle.textContent=[artifact.role,artifact.mime_type].filter(Boolean).join(' · ');stage.replaceChildren();const url=meta.playback_url||'';if(url){const media=artifact.artifact_type==='video'?document.createElement('video'):document.createElement('img');media.crossOrigin='use-credentials';if(media.tagName==='VIDEO'){media.controls=true;media.preload='metadata'}media.src=url;media.alt=artifact.filename||'生产媒体';stage.append(media)}else{const empty=document.createElement('div');empty.className='empty';empty.textContent='媒体网关尚未配置';stage.append(empty)}facts.replaceChildren();[['类型',artifact.artifact_type],['画幅',artifact.metadata?.aspect_ratio],['分析',analysis.model_input]].forEach(([label,value])=>{const el=document.createElement('div');el.className='fact';const caption=document.createElement('small');caption.textContent=String(label);const strong=document.createElement('strong');strong.textContent=String(value||'—');el.append(caption,strong);facts.append(el)})}
window.addEventListener('message',event=>{if(event.source!==window.parent)return;const msg=event.data;if(msg?.jsonrpc==='2.0'&&msg?.method==='ui/notifications/tool-result')render(msg.params)});
if(window.openai?.toolOutput)render({structuredContent:window.openai.toolOutput,_meta:window.openai.toolResponseMetadata||{}});
</script></body></html>`;
}

export interface CreateWebGptV4McpAppOptions {
  db: M0Database;
  actor: WebGptV4Actor;
  profile?: WebGptV4Profile;
  auth_config?: WebGptV4AuthConfig | null;
  media?: MediaRuntimeOptions;
}

export function createWebGptV4McpApp(options: CreateWebGptV4McpAppOptions): McpServer {
  const { db, actor } = options;
  const profile = options.profile ?? "readonly";
  const enabledTools = new Set(webGptV4ToolsForProfile(profile).map((tool) => tool.name));
  const authConfig = options.auth_config ?? null;
  const server = new McpServer(
    { name: "ai-video-production-assistant", version: WEBGPT_V4_VERSION },
    {
      instructions: "仅处理 classification=production 项目。先列出或明确项目，再读取项目对象，最后才调用写工具。禁止访问测试、未分类、隔离或未归属数据；禁止调用 Provider、上传、生成提交、合成、交付、删除、Shell、任意文件或凭证。文案和审片注记可直写，其余生产建议必须进入人类工作台确认。"
    }
  );

  if (enabledTools.has("inspect_media")) registerAppResource(server, "WebGPT V4 Media Inspector", WEBGPT_V4_WIDGET_URI, { description: "Project-scoped production media player." }, async () => ({
    contents: [{
      uri: WEBGPT_V4_WIDGET_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: widgetHtml(),
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: options.media?.public_origin ? [options.media.public_origin] : [], resourceDomains: options.media?.public_origin ? [options.media.public_origin] : [] }
        }
      }
    }]
  }));

  if (enabledTools.has("list_production_projects")) server.registerTool("list_production_projects", {
    title: "列出生产项目",
    description: "Use this when the user needs to select or find a real production project. Never returns test or unclassified projects.",
    inputSchema: { query: z.string().max(200).optional(), include_archived: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0), request_id: z.string().max(128).optional() },
    outputSchema: profile === "readonly" ? WEBGPT_V4_READONLY_OUTPUT_SCHEMAS.list_production_projects : projectListResultSchema,
    ...contract("list_production_projects")
  }, async (input) => guarded("projects.read", actor, authConfig, input.request_id, () => {
    const result = listProductionProjects(input, db, input.request_id);
    return profile === "readonly" ? readonlyProjectList(result) : result;
  }) as never);

  if (enabledTools.has("get_project_context")) server.registerTool("get_project_context", {
    title: "读取项目上下文",
    description: "Use this when the user needs the authoritative overview, storyboard, generation, review, or delivery context for one production project.",
    inputSchema: { project_id: z.string(), workspace: z.enum(["overview", "storyboard", "generation", "review", "delivery"]).default("overview"), request_id: z.string().max(128).optional() },
    outputSchema: profile === "readonly" ? WEBGPT_V4_READONLY_OUTPUT_SCHEMAS.get_project_context : projectContextResultSchema, ...contract("get_project_context")
  }, async (input) => guarded("projects.read", actor, authConfig, input.request_id, () => {
    const result = getProductionProjectContext(input, db, input.request_id);
    return profile === "readonly" ? readonlyProjectContext(result) : result;
  }) as never);

  if (enabledTools.has("list_project_shots")) server.registerTool("list_project_shots", {
    title: "列出项目 SHOT",
    description: "Use this when the user needs SHOT ids, copy, state, versions, and optimistic-lock timestamps for one production project.",
    inputSchema: { project_id: z.string(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0), request_id: z.string().max(128).optional() },
    outputSchema: profile === "readonly" ? WEBGPT_V4_READONLY_OUTPUT_SCHEMAS.list_project_shots : shotListResultSchema, ...contract("list_project_shots")
  }, async (input) => guarded("projects.read", actor, authConfig, input.request_id, () => {
    const result = listProductionProjectShots(input, db, input.request_id);
    return profile === "readonly" ? readonlyShotList(result) : result;
  }) as never);

  if (enabledTools.has("list_project_media")) server.registerTool("list_project_media", {
    title: "列出项目媒体",
    description: "Use this when the user needs registered storyboard images, generated clips, or final videos from one production project.",
    inputSchema: { project_id: z.string(), shot_id: z.string().optional(), role: z.enum(["storyboard_image", "generated_clip", "final_video"]).optional(), type: z.enum(["image", "video"]).optional(), status: z.enum(["active", "pending_upload", "inaccessible", "expired", "archived"]).optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0), request_id: z.string().max(128).optional() },
    outputSchema: mediaListResultSchema, ...contract("list_project_media")
  }, async (input) => guarded("media.read", actor, authConfig, input.request_id, () => listProductionProjectMedia(input, db, input.request_id)) as never);

  if (enabledTools.has("inspect_media")) registerAppTool(server, "inspect_media", {
    title: "检查生产媒体",
    description: "Use this when the user needs to inspect one project-owned image or video. Video reasoning uses timestamped frames; this never sends video as a native model input.",
    inputSchema: { project_id: z.string(), artifact_id: z.string(), frame_offset: z.number().int().min(0).default(0), frame_limit: z.number().int().min(1).max(12).default(8), request_id: z.string().max(128).optional() },
    outputSchema: inspectResultSchema,
    annotations: webGptV4Tool("inspect_media").annotations,
    _meta: { ...security("media.read"), ui: { resourceUri: WEBGPT_V4_WIDGET_URI }, "openai/outputTemplate": WEBGPT_V4_WIDGET_URI }
  }, async (input) => {
    const id = requestId(input.request_id);
    try {
      requireScope(actor, "media.read");
      const inspected = await inspectProductionMedia(db, input, actor, options.media);
      const result: WebGptV4Result<Record<string, unknown>> = { ok: true, data: inspected.data, meta: { request_id: id, source_version: WEBGPT_V4_VERSION, updated_at: new Date().toISOString() } };
      const content: Array<Record<string, unknown>> = [{ type: "text", text: JSON.stringify(inspected.data) }];
      for (const image of inspected.model_images) content.push({ type: "image", data: image.data, mimeType: image.mime_type });
      return asToolResult(result, { content, meta: { playback_url: inspected.playback.url, playback_expires_at: inspected.playback.expires_at } }) as never;
    } catch (error) {
      const safe = errorBody(error);
      const meta = safe.code === "INSUFFICIENT_SCOPE"
        ? { "mcp/www_authenticate": [wwwAuthenticate(authConfig, "insufficient_scope", { scope: "media.read", error_description: safe.message })] }
        : undefined;
      return asToolResult(fail(id, safe), meta ? { meta } : undefined) as never;
    }
  });

  if (enabledTools.has("get_review_package")) server.registerTool("get_review_package", {
    title: "读取审片包",
    description: "Use this when the user needs a SHOT version stack, prior notes, and the selected generated clip before drafting review feedback.",
    inputSchema: { project_id: z.string(), shot_id: z.string(), artifact_id: z.string().optional(), request_id: z.string().max(128).optional() },
    outputSchema: profile === "readonly" ? WEBGPT_V4_READONLY_OUTPUT_SCHEMAS.get_review_package : reviewPackageResultSchema, ...contract("get_review_package")
  }, async (input) => guarded("projects.read", actor, authConfig, input.request_id, () => {
    const result = getProductionReviewPackage(input, db, input.request_id);
    return profile === "readonly" ? readonlyReviewPackage(result, input.project_id, input.shot_id) : result;
  }) as never);

  if (enabledTools.has("get_delivery_status")) server.registerTool("get_delivery_status", {
    title: "读取交付状态",
    description: "Use this when the user asks whether a production project is ready to assemble, in final review, or delivered.",
    inputSchema: { project_id: z.string(), request_id: z.string().max(128).optional() }, outputSchema: profile === "readonly" ? WEBGPT_V4_READONLY_OUTPUT_SCHEMAS.get_delivery_status : deliveryResultSchema, ...contract("get_delivery_status")
  }, async (input) => guarded("projects.read", actor, authConfig, input.request_id, () => {
    const result = getProductionDeliveryStatus(input, db, input.request_id);
    return profile === "readonly" ? readonlyDelivery(result) : result;
  }) as never);

  if (enabledTools.has("get_closeout_evidence")) server.registerTool("get_closeout_evidence", {
    title: "读取收尾证据",
    description: "Use this when the user needs a structured closeout summary without raw reports, logs, local paths, or provider payloads.",
    inputSchema: { project_id: z.string(), request_id: z.string().max(128).optional() }, outputSchema: profile === "readonly" ? WEBGPT_V4_READONLY_OUTPUT_SCHEMAS.get_closeout_evidence : closeoutResultSchema, ...contract("get_closeout_evidence")
  }, async (input) => guarded("projects.read", actor, authConfig, input.request_id, () => {
    const result = getProductionCloseoutEvidence(input, db, input.request_id);
    return profile === "readonly" ? readonlyDelivery(result, true) : result;
  }) as never);

  if (enabledTools.has("update_shot_copy")) server.registerTool("update_shot_copy", {
    title: "更新 SHOT 文案",
    description: "Use this when the user explicitly wants to update SHOT description, prompt, negative prompt, or duration. Never changes media bindings or workflow status.",
    inputSchema: { project_id: z.string(), shot_id: z.string(), expected_updated_at: z.string(), idempotency_key: z.string().min(1).max(200), description: z.string().max(2000).optional(), video_prompt: z.string().max(8000).optional(), negative_prompt: z.string().max(4000).optional(), duration_seconds: z.number().int().min(1).max(60).optional(), request_id: z.string().max(128).optional() },
    outputSchema: shotCopyResultSchema, ...contract("update_shot_copy")
  }, async (input) => guarded("shots.write", actor, authConfig, input.request_id, () => updateProductionShotCopy(input, { actor, request_id: input.request_id, idempotency_key: input.idempotency_key }, db)) as never);

  if (enabledTools.has("add_review_note")) server.registerTool("add_review_note", {
    title: "添加审片注记",
    description: "Use this when the user wants to attach non-decisional review notes to a SHOT or clip. Never approves, rejects, or requests regeneration.",
    inputSchema: { project_id: z.string(), shot_id: z.string(), artifact_id: z.string().optional(), note: z.string().min(1).max(2000), idempotency_key: z.string().min(1).max(200), request_id: z.string().max(128).optional() },
    outputSchema: reviewNoteResultSchema, ...contract("add_review_note")
  }, async (input) => guarded("reviews.write", actor, authConfig, input.request_id, () => addProductionReviewNote(input, { actor, request_id: input.request_id, idempotency_key: input.idempotency_key }, db)) as never);

  if (enabledTools.has("submit_production_proposal")) server.registerTool("submit_production_proposal", {
    title: "提交生产提议",
    description: "Use this when the user wants a storyboard, review decision, regeneration, assembly, memory, or package-freeze proposal placed in the human workbench inbox.",
    inputSchema: productionProposalSubmitSchema,
    outputSchema: proposalResultSchema, ...contract("submit_production_proposal")
  }, async (input) => guarded("proposals.write", actor, authConfig, input.request_id, () => submitProductionProposal({ ...input, kind: input.kind as ProductionProposalKind }, { actor, request_id: input.request_id, idempotency_key: input.idempotency_key }, db)) as never);

  if (enabledTools.has("revise_production_proposal")) server.registerTool("revise_production_proposal", {
    title: "修订生产提议",
    description: "Use this when the user wants to supersede an active WebGPT V4 proposal while preserving its history.",
    inputSchema: productionProposalRevisionSchema,
    outputSchema: revisedProposalResultSchema, ...contract("revise_production_proposal")
  }, async (input) => guarded("proposals.write", actor, authConfig, input.request_id, () => reviseProductionProposal(input, { actor, request_id: input.request_id, idempotency_key: input.idempotency_key }, db)) as never);

  if (enabledTools.has("close_production_proposal")) server.registerTool("close_production_proposal", {
    title: "关闭生产提议",
    description: "Use this when the user wants to close an active WebGPT V4 proposal without applying it.",
    inputSchema: { project_id: z.string(), draft_id: z.string(), reason: z.string().max(500).optional(), idempotency_key: z.string().min(1).max(200), request_id: z.string().max(128).optional() },
    outputSchema: proposalResultSchema, ...contract("close_production_proposal")
  }, async (input) => guarded("proposals.write", actor, authConfig, input.request_id, () => closeProductionProposal(input, { actor, request_id: input.request_id, idempotency_key: input.idempotency_key }, db)) as never);

  if (enabledTools.has("prepare_generation_intent")) server.registerTool("prepare_generation_intent", {
    title: "准备生成意图",
    description: "Use this when the user wants a non-confirmed generation intent based only on a current local price cache. Never contacts RunningHub, uploads, confirms cost, or submits a task.",
    inputSchema: { project_id: z.string(), shot_id: z.string(), account_label: z.enum(["personal", "team"]), budget_limit_value: z.number().positive(), idempotency_key: z.string().min(1).max(200), request_id: z.string().max(128).optional() },
    outputSchema: generationIntentResultSchema, ...contract("prepare_generation_intent")
  }, async (input) => guarded("generation.prepare", actor, authConfig, input.request_id, () => prepareProductionGenerationIntent(input, { actor, request_id: input.request_id, idempotency_key: input.idempotency_key }, db)) as never);

  return server;
}
