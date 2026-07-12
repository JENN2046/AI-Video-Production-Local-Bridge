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
import {
  fullGenerationIntent,
  fullInspection,
  fullProposal,
  fullReviewNote,
  fullShotCopy,
  readDelivery,
  readMediaList,
  readProjectContext,
  readProjectList,
  readReviewPackage,
  readShotList,
  WEBGPT_V4_FULL_OUTPUT_SCHEMAS,
  WEBGPT_V4_READ_OUTPUT_SCHEMAS
} from "./contracts.js";
import { WEBGPT_V4_FULL_TOOL_SCOPES } from "./toolCatalog.js";
import { webGptV4Tool, webGptV4ToolsForProfile, type WebGptV4Profile, type WebGptV4ToolName } from "./toolCatalog.js";
import type { WebGptTelemetrySink } from "./telemetry.js";
import { errorBody, fail, requestId, requireScope, WEBGPT_V4_VERSION, WebGptV4Error, type WebGptV4Actor, type WebGptV4Result, type WebGptV4Scope } from "./types.js";

export const WEBGPT_V4_WIDGET_URI = "ui://webgpt-v4/media-inspector-v2.html";

export const WEBGPT_V4_TOOL_SCOPES = WEBGPT_V4_FULL_TOOL_SCOPES;

function security(scope: WebGptV4Scope): Record<string, unknown> {
  return { securitySchemes: [{ type: "oauth2", scopes: [scope] }] };
}

function contract(name: WebGptV4ToolName): { annotations: WebGptV4ToolCatalogAnnotations; _meta: Record<string, unknown> } {
  const tool = webGptV4Tool(name);
  return { annotations: tool.annotations, _meta: { ...security(tool.scope) } };
}

type WebGptV4ToolCatalogAnnotations = ReturnType<typeof webGptV4Tool>["annotations"];

function itemCount(result: WebGptV4Result<unknown>): number | undefined {
  if (!result.ok || !result.data || typeof result.data !== "object") return undefined;
  const data = result.data as Record<string, unknown>;
  if (Array.isArray(data.items)) return data.items.length;
  if (Array.isArray(data.notes)) return data.notes.length;
  return undefined;
}

function asToolResult<T>(
  result: WebGptV4Result<T>,
  extra?: { content?: Array<Record<string, unknown>>; meta?: Record<string, unknown> },
  telemetry?: { sink: WebGptTelemetrySink; profile: WebGptV4Profile; tool: WebGptV4ToolName; started_at: number; request_id?: string; detail?: "compact" | "full" }
): Record<string, unknown> {
  const serialized = JSON.stringify(result);
  const bounded: WebGptV4Result<unknown> = Buffer.byteLength(serialized, "utf8") <= 128 * 1024
    ? result
    : fail(result.meta.request_id, {
      code: "RESPONSE_BUDGET_EXCEEDED",
      message: "The requested result exceeds the WebGPT response budget.",
      field: result.ok && typeof result.data === "object" && result.data !== null && "detail" in result.data ? "detail" : "limit",
      retryable: false,
      suggested_parameters: result.ok && typeof result.data === "object" && result.data !== null && "detail" in result.data
        ? { detail: "compact", limit: 20 }
        : { limit: 20 }
    });
  const message = bounded.ok
    ? "请求已完成；结构化结果位于 structuredContent。"
    : `${bounded.error.code}: ${bounded.error.message}`;
  if (telemetry) {
    try {
      telemetry.sink.record({
        timestamp: new Date().toISOString(), request_id: telemetry.request_id ?? bounded.meta.request_id, profile: telemetry.profile, tool: telemetry.tool,
        duration_ms: Math.max(0, Date.now() - telemetry.started_at), outcome: bounded.ok ? "success" : "error",
        ...(!bounded.ok ? { error_code: bounded.error.code, retryable: bounded.error.retryable === true } : {}),
        result_bytes: Buffer.byteLength(JSON.stringify(bounded), "utf8"),
        ...(itemCount(bounded) !== undefined ? { item_count: itemCount(bounded) } : {}),
        ...(telemetry.detail ? { detail_level: telemetry.detail } : {})
      });
    } catch {
      telemetry.sink.markUnhealthy();
    }
  }
  return {
    isError: !bounded.ok,
    structuredContent: bounded,
    content: bounded.ok && extra?.content ? extra.content : [{ type: "text", text: message.slice(0, 1024) }],
    _meta: extra?.meta ?? {}
  };
}

function guarded<T>(
  tool: WebGptV4ToolName,
  scope: WebGptV4Scope,
  actor: WebGptV4Actor,
  authConfig: WebGptV4AuthConfig | null,
  idValue: string | undefined,
  profile: WebGptV4Profile,
  telemetry: WebGptTelemetrySink,
  operation: () => WebGptV4Result<T>,
  detail?: "compact" | "full"
): Record<string, unknown> {
  const id = requestId(idValue);
  const telemetryRequestId = idValue ? requestId() : undefined;
  const startedAt = Date.now();
  try {
    requireScope(actor, scope);
    return asToolResult(operation(), undefined, { sink: telemetry, profile, tool, started_at: startedAt, request_id: telemetryRequestId, detail });
  } catch (error) {
    const safe = errorBody(error);
    const meta = safe.code === "INSUFFICIENT_SCOPE"
      ? { "mcp/www_authenticate": [wwwAuthenticate(authConfig, "insufficient_scope", { scope, error_description: safe.message })] }
      : undefined;
    return asToolResult(fail(id, safe), meta ? { meta } : undefined, { sink: telemetry, profile, tool, started_at: startedAt, request_id: telemetryRequestId, detail });
  }
}

export function webGptV4WidgetHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font-family:Inter,"Microsoft YaHei",sans-serif}*{box-sizing:border-box}body{margin:0;padding:12px;background:transparent;color:CanvasText}.shell{border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:8px;overflow:hidden;background:color-mix(in srgb,Canvas 94%,transparent)}header{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent)}h1{font-size:14px;margin:0}small{opacity:.68}.stage{background:#0a0b0e;aspect-ratio:16/9;display:grid;place-items:center}.stage video,.stage img{width:100%;height:100%;object-fit:contain}.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:color-mix(in srgb,CanvasText 10%,transparent)}.fact{padding:8px 10px;background:Canvas;font-size:12px}.fact strong{display:block;overflow:hidden;text-overflow:ellipsis}.empty{padding:28px;text-align:center;opacity:.7}@media(max-width:520px){.facts{grid-template-columns:1fr}.stage{aspect-ratio:4/3}}
</style></head><body><main class="shell"><header><div><h1 id="title">生产媒体</h1><small id="subtitle">等待媒体结果</small></div></header><section id="stage" class="stage"><div class="empty">尚未载入媒体</div></section><section id="facts" class="facts"></section></main>
<script>
const stage=document.getElementById('stage'),title=document.getElementById('title'),subtitle=document.getElementById('subtitle'),facts=document.getElementById('facts');
function render(result){const sc=result?.structuredContent||result||{};if(!sc.ok||!sc.data||typeof sc.data!=='object')return;const artifact=sc.data?.artifact||{};const analysis=sc.data?.analysis||{};const meta=result?._meta||{};title.textContent=artifact.filename||artifact.artifact_id||'生产媒体';subtitle.textContent=[artifact.role,artifact.mime_type].filter(Boolean).join(' · ');stage.replaceChildren();const url=typeof meta.playback_url==='string'?meta.playback_url:'';if(url){const media=artifact.artifact_type==='video'?document.createElement('video'):document.createElement('img');media.crossOrigin='use-credentials';if(media.tagName==='VIDEO'){media.controls=true;media.preload='metadata'}media.src=url;media.alt=artifact.filename||'生产媒体';stage.append(media)}else{const empty=document.createElement('div');empty.className='empty';empty.textContent='媒体网关尚未配置';stage.append(empty)}facts.replaceChildren();[['类型',artifact.artifact_type],['画幅',artifact.metadata?.aspect_ratio],['分析',analysis.model_input]].forEach(([label,value])=>{const el=document.createElement('div');el.className='fact';const caption=document.createElement('small');caption.textContent=String(label);const strong=document.createElement('strong');strong.textContent=String(value||'—');el.append(caption,strong);facts.append(el)})}
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
  telemetry: WebGptTelemetrySink;
  widget_domain?: string | null;
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
      text: webGptV4WidgetHtml(),
      _meta: {
        "openai/widgetDescription": "Inspect one project-bound image or timestamped video frame bundle.",
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: options.media?.public_origin ? [options.media.public_origin] : [] },
          ...(options.widget_domain ? { domain: options.widget_domain } : {})
        }
      }
    }]
  }));

  if (enabledTools.has("list_production_projects")) server.registerTool("list_production_projects", {
    title: "列出生产项目",
    description: "Use this when the user needs to select or find a real production project. Never returns test or unclassified projects.",
    inputSchema: { query: z.string().max(200).optional(), include_archived: z.boolean().default(false), detail: z.enum(["compact", "full"]).default("compact"), limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.list_production_projects,
    ...contract("list_production_projects")
  }, async (input) => guarded("list_production_projects", "projects.read", actor, authConfig, input.request_id, profile, options.telemetry, () => {
    return readProjectList(listProductionProjects(input, db, input.request_id), input.detail);
  }, input.detail) as never);

  if (enabledTools.has("get_project_context")) server.registerTool("get_project_context", {
    title: "读取项目上下文",
    description: "Use this when the user needs the authoritative overview, storyboard, generation, review, or delivery context for one production project.",
    inputSchema: { project_id: z.string(), workspace: z.enum(["overview", "storyboard", "generation", "review", "delivery"]).default("overview"), detail: z.enum(["compact", "full"]).default("compact"), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.get_project_context, ...contract("get_project_context")
  }, async (input) => guarded("get_project_context", "projects.read", actor, authConfig, input.request_id, profile, options.telemetry, () => {
    return readProjectContext(getProductionProjectContext(input, db, input.request_id), input.detail);
  }, input.detail) as never);

  if (enabledTools.has("list_project_shots")) server.registerTool("list_project_shots", {
    title: "列出项目 SHOT",
    description: "Use this when the user needs SHOT ids, copy, state, versions, and optimistic-lock timestamps for one production project.",
    inputSchema: { project_id: z.string(), detail: z.enum(["compact", "full"]).default("compact"), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.list_project_shots, ...contract("list_project_shots")
  }, async (input) => guarded("list_project_shots", "projects.read", actor, authConfig, input.request_id, profile, options.telemetry, () => {
    return readShotList(listProductionProjectShots(input, db, input.request_id), input.detail);
  }, input.detail) as never);

  if (enabledTools.has("list_project_media")) server.registerTool("list_project_media", {
    title: "列出项目媒体",
    description: "Use this when the user needs registered storyboard images, generated clips, or final videos from one production project.",
    inputSchema: { project_id: z.string(), shot_id: z.string().optional(), role: z.enum(["storyboard_image", "generated_clip", "final_video"]).optional(), type: z.enum(["image", "video"]).optional(), status: z.enum(["active", "pending_upload", "inaccessible", "expired", "archived"]).optional(), detail: z.enum(["compact", "full"]).default("compact"), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.list_project_media, ...contract("list_project_media")
  }, async (input) => guarded("list_project_media", "media.read", actor, authConfig, input.request_id, profile, options.telemetry, () => readMediaList(listProductionProjectMedia(input, db, input.request_id), input.detail), input.detail) as never);

  if (enabledTools.has("inspect_media")) registerAppTool(server, "inspect_media", {
    title: "检查生产媒体",
    description: "Use this when the user needs to inspect one project-owned image or video. Video reasoning uses timestamped frames; this never sends video as a native model input.",
    inputSchema: { project_id: z.string(), artifact_id: z.string(), frame_offset: z.number().int().min(0).default(0), frame_limit: z.number().int().min(1).max(12).default(8), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_FULL_OUTPUT_SCHEMAS.inspect_media,
    annotations: webGptV4Tool("inspect_media").annotations,
    _meta: {
      ...security("media.read"), ui: { resourceUri: WEBGPT_V4_WIDGET_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": WEBGPT_V4_WIDGET_URI,
      "openai/toolInvocation/invoking": "Inspecting production media…",
      "openai/toolInvocation/invoked": "Production media inspected"
    }
  }, async (input) => {
    const id = requestId(input.request_id);
    const telemetryRequestId = input.request_id ? requestId() : undefined;
    const startedAt = Date.now();
    try {
      requireScope(actor, "media.read");
      const inspected = await inspectProductionMedia(db, input, actor, options.media);
      const result = fullInspection({ ok: true, data: inspected.data, meta: { request_id: id, source_version: WEBGPT_V4_VERSION, updated_at: new Date().toISOString() } });
      const content: Array<Record<string, unknown>> = [{ type: "text", text: "媒体检查已完成；分析结果位于 structuredContent。" }];
      for (const image of inspected.model_images) content.push({ type: "image", data: image.data, mimeType: image.mime_type });
      return asToolResult(result, { content, meta: { playback_url: inspected.playback.url, playback_expires_at: inspected.playback.expires_at } }, { sink: options.telemetry, profile, tool: "inspect_media", started_at: startedAt, request_id: telemetryRequestId }) as never;
    } catch (error) {
      const safe = errorBody(error);
      const meta = safe.code === "INSUFFICIENT_SCOPE"
        ? { "mcp/www_authenticate": [wwwAuthenticate(authConfig, "insufficient_scope", { scope: "media.read", error_description: safe.message })] }
        : undefined;
      return asToolResult(fail(id, safe), meta ? { meta } : undefined, { sink: options.telemetry, profile, tool: "inspect_media", started_at: startedAt, request_id: telemetryRequestId }) as never;
    }
  });

  if (enabledTools.has("get_review_package")) server.registerTool("get_review_package", {
    title: "读取审片包",
    description: "Use this when the user needs a SHOT version stack, prior notes, and the selected generated clip before drafting review feedback.",
    inputSchema: { project_id: z.string(), shot_id: z.string(), artifact_id: z.string().optional(), detail: z.enum(["compact", "full"]).default("compact"), notes_limit: z.number().int().min(1).max(50).default(10), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.get_review_package, ...contract("get_review_package")
  }, async (input) => guarded("get_review_package", "projects.read", actor, authConfig, input.request_id, profile, options.telemetry, () => {
    return readReviewPackage(getProductionReviewPackage(input, db, input.request_id), input.detail, input.project_id, input.shot_id);
  }, input.detail) as never);

  if (enabledTools.has("get_delivery_status")) server.registerTool("get_delivery_status", {
    title: "读取交付状态",
    description: "Use this when the user asks whether a production project is ready to assemble, in final review, or delivered.",
    inputSchema: { project_id: z.string(), request_id: z.string().max(128).optional() }, outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.get_delivery_status, ...contract("get_delivery_status")
  }, async (input) => guarded("get_delivery_status", "projects.read", actor, authConfig, input.request_id, profile, options.telemetry, () => {
    return readDelivery(getProductionDeliveryStatus(input, db, input.request_id));
  }) as never);

  if (enabledTools.has("get_closeout_evidence")) server.registerTool("get_closeout_evidence", {
    title: "读取收尾证据",
    description: "Use this when the user needs a structured closeout summary without raw reports, logs, local paths, or provider payloads.",
    inputSchema: { project_id: z.string(), request_id: z.string().max(128).optional() }, outputSchema: WEBGPT_V4_READ_OUTPUT_SCHEMAS.get_closeout_evidence, ...contract("get_closeout_evidence")
  }, async (input) => guarded("get_closeout_evidence", "projects.read", actor, authConfig, input.request_id, profile, options.telemetry, () => {
    return readDelivery(getProductionCloseoutEvidence(input, db, input.request_id), true);
  }) as never);

  if (enabledTools.has("update_shot_copy")) server.registerTool("update_shot_copy", {
    title: "更新 SHOT 文案",
    description: "Use this when the user explicitly wants to update SHOT description, prompt, negative prompt, or duration. Never changes media bindings or workflow status.",
    inputSchema: { project_id: z.string(), shot_id: z.string(), expected_updated_at: z.string(), idempotency_key: z.string().min(1).max(200), description: z.string().max(2000).optional(), video_prompt: z.string().max(8000).optional(), negative_prompt: z.string().max(4000).optional(), duration_seconds: z.number().int().min(1).max(60).optional(), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_FULL_OUTPUT_SCHEMAS.update_shot_copy, ...contract("update_shot_copy")
  }, async (input) => guarded("update_shot_copy", "shots.write", actor, authConfig, input.request_id, profile, options.telemetry, () => fullShotCopy(updateProductionShotCopy(input, { actor, request_id: input.request_id, idempotency_key: input.idempotency_key }, db))) as never);

  if (enabledTools.has("add_review_note")) server.registerTool("add_review_note", {
    title: "添加审片注记",
    description: "Use this when the user wants to attach non-decisional review notes to a SHOT or clip. Never approves, rejects, or requests regeneration.",
    inputSchema: { project_id: z.string(), shot_id: z.string(), artifact_id: z.string().optional(), note: z.string().min(1).max(2000), idempotency_key: z.string().min(1).max(200), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_FULL_OUTPUT_SCHEMAS.add_review_note, ...contract("add_review_note")
  }, async (input) => guarded("add_review_note", "reviews.write", actor, authConfig, input.request_id, profile, options.telemetry, () => fullReviewNote(addProductionReviewNote(input, { actor, request_id: input.request_id, idempotency_key: input.idempotency_key }, db))) as never);

  if (enabledTools.has("submit_production_proposal")) server.registerTool("submit_production_proposal", {
    title: "提交生产提议",
    description: "Use this when the user wants a storyboard, review decision, regeneration, assembly, memory, or package-freeze proposal placed in the human workbench inbox.",
    inputSchema: productionProposalSubmitSchema,
    outputSchema: WEBGPT_V4_FULL_OUTPUT_SCHEMAS.submit_production_proposal, ...contract("submit_production_proposal")
  }, async (input) => guarded("submit_production_proposal", "proposals.write", actor, authConfig, input.request_id, profile, options.telemetry, () => fullProposal(submitProductionProposal({ ...input, kind: input.kind as ProductionProposalKind }, { actor, request_id: input.request_id, idempotency_key: input.idempotency_key }, db), "submit")) as never);

  if (enabledTools.has("revise_production_proposal")) server.registerTool("revise_production_proposal", {
    title: "修订生产提议",
    description: "Use this when the user wants to supersede an active WebGPT V4 proposal while preserving its history.",
    inputSchema: productionProposalRevisionSchema,
    outputSchema: WEBGPT_V4_FULL_OUTPUT_SCHEMAS.revise_production_proposal, ...contract("revise_production_proposal")
  }, async (input) => guarded("revise_production_proposal", "proposals.write", actor, authConfig, input.request_id, profile, options.telemetry, () => fullProposal(reviseProductionProposal(input, { actor, request_id: input.request_id, idempotency_key: input.idempotency_key }, db), "revise")) as never);

  if (enabledTools.has("close_production_proposal")) server.registerTool("close_production_proposal", {
    title: "关闭生产提议",
    description: "Use this when the user wants to close an active WebGPT V4 proposal without applying it.",
    inputSchema: { project_id: z.string(), draft_id: z.string(), reason: z.string().max(500).optional(), idempotency_key: z.string().min(1).max(200), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_FULL_OUTPUT_SCHEMAS.close_production_proposal, ...contract("close_production_proposal")
  }, async (input) => guarded("close_production_proposal", "proposals.write", actor, authConfig, input.request_id, profile, options.telemetry, () => fullProposal(closeProductionProposal(input, { actor, request_id: input.request_id, idempotency_key: input.idempotency_key }, db), "close")) as never);

  if (enabledTools.has("prepare_generation_intent")) server.registerTool("prepare_generation_intent", {
    title: "准备生成意图",
    description: "Use this when the user wants a non-confirmed generation intent based only on a current local price cache. Never contacts RunningHub, uploads, confirms cost, or submits a task.",
    inputSchema: { project_id: z.string(), shot_id: z.string(), account_label: z.enum(["personal", "team"]), budget_limit_value: z.number().positive(), idempotency_key: z.string().min(1).max(200), request_id: z.string().max(128).optional() },
    outputSchema: WEBGPT_V4_FULL_OUTPUT_SCHEMAS.prepare_generation_intent, ...contract("prepare_generation_intent")
  }, async (input) => guarded("prepare_generation_intent", "generation.prepare", actor, authConfig, input.request_id, profile, options.telemetry, () => fullGenerationIntent(prepareProductionGenerationIntent(input, { actor, request_id: input.request_id, idempotency_key: input.idempotency_key }, db))) as never);

  return server;
}
