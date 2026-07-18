import type { IncomingMessage, ServerResponse } from "node:http";

import { openM0Database } from "../storage/sqlite.js";
import {
  PersonalReadonlyOperationsError,
  type PersonalReadonlyOperationsService
} from "../webgpt-cloud/personalReadonlyOperations.js";
import { h2CanaryWorkbenchSummary } from "../tools/h1Workbench.js";
import { applyWorkbenchGovernance, getWorkbenchGovernancePreview } from "../tools/workbenchGovernance.js";
import { decideWorkbenchPendingAction, listWorkbenchInboxV21, transitionWorkbenchDraft } from "../tools/workbenchInbox.js";
import {
  confirmWorkbenchGeneration,
  getWorkbenchGenerationIntent,
  preflightWorkbenchGeneration,
  reconcileGenerationJob,
  startWorkbenchGeneration
} from "../tools/workbenchGeneration.js";
import {
  createWorkbenchProject,
  decideWorkbenchClip,
  decideWorkbenchImport,
  getWorkbenchDashboard,
  getWorkbenchReport,
  getWorkbenchProjectWorkspace,
  getWorkbenchShell,
  listWorkbenchAssets,
  listWorkbenchProjects,
  listWorkbenchReports,
  refreshWorkbenchImportIndex,
  setWorkbenchProjectLifecycle,
  updateWorkbenchProject,
  updateWorkbenchShot,
  type WorkbenchProjectClassification,
  type WorkbenchProjectLifecycle,
  type WorkbenchProjectPriority,
  type WorkbenchProjectScope,
  type WorkbenchWorkspace,
  type WorkbenchV2Error,
  type WorkbenchV2Result
} from "../tools/workbenchV2.js";

const MAX_BODY_BYTES = 1024 * 1024;
const PROJECT_WORKSPACES = new Set<WorkbenchWorkspace>(["overview", "storyboard", "generation", "review", "delivery"]);
const INBOX_TABS = new Set(["pending", "drafts", "quarantine"]);
const ASSET_TABS = new Set(["media", "memory", "reference", "recall"]);

function send(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function sendOk(response: ServerResponse, data: unknown, meta?: unknown): void {
  send(response, 200, meta === undefined ? { ok: true, data } : { ok: true, data, meta });
}

function statusForError(error: WorkbenchV2Error): number {
  if (error.code.endsWith("_NOT_FOUND")) return 404;
  if (["PROJECT_ARCHIVED", "PROJECT_OPERATIONAL_DATA_INTEGRITY_VIOLATION", "SHOT_BLOCKED", "GOVERNANCE_SNAPSHOT_STALE", "INVALID_DRAFT_TRANSITION", "ACTION_NOT_PENDING"].includes(error.code)) return 409;
  if (error.code === "ACTION_NONCE_REQUIRED") return 403;
  return 400;
}

function sendResult<T>(response: ServerResponse, result: WorkbenchV2Result<T>, successStatus = 200): void {
  if (result.ok) send(response, successStatus, { ok: true, data: result.data });
  else send(response, statusForError(result.error), { ok: false, error: result.error });
}

function sendPage(response: ServerResponse, result: { items: unknown[]; meta: unknown }): void {
  sendOk(response, result.items, result.meta);
}

function sendReadonlyOperationsError(response: ServerResponse, error: unknown): void {
  const code = error instanceof PersonalReadonlyOperationsError ? error.code : "READONLY_PERSONAL_OPERATIONS_FAILED";
  const status = code === "READONLY_PUBLISH_OPERATION_IN_PROGRESS" ? 409
    : code === "READONLY_PUBLISHER_REMOTE_REJECTED" ? 502
      : code === "READONLY_PUBLISHER_PROFILE_NOT_CONFIGURED" || code === "READONLY_PUBLISHER_PROFILE_INVALID" || code === "READONLY_PUBLISHER_PATH_NOT_IGNORED" ? 503
        : 500;
  send(response, status, { ok: false, error: { code, message: "Readonly Snapshot operation did not complete." } });
}

export interface WorkbenchV2ApiServices {
  readonly_operations?: PersonalReadonlyOperationsService;
}

function numberParam(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("BODY_TOO_LARGE"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_JSON_BODY");
        resolveBody(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("INVALID_JSON_BODY"));
      }
    });
    request.on("error", reject);
  });
}

function withDatabase<T>(operation: (db: ReturnType<typeof openM0Database>) => T): T {
  const db = openM0Database();
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function hasNonce(request: IncomingMessage, actionNonce: string): boolean {
  return request.headers["x-h1-action-nonce"] === actionNonce;
}

async function mutation(
  request: IncomingMessage,
  response: ServerResponse,
  actionNonce: string,
  operation: (body: Record<string, unknown>) => void | Promise<void>
): Promise<void> {
  if (!hasNonce(request, actionNonce)) {
    send(response, 403, { ok: false, error: { code: "ACTION_NONCE_REQUIRED", message: "Mutation nonce is required." } });
    return;
  }
  try {
    await operation(await readBody(request));
  } catch (error) {
    const code = error instanceof Error && error.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_JSON_BODY";
    send(response, 400, { ok: false, error: { code, message: code === "BODY_TOO_LARGE" ? "Request body is too large." : "Request body must be valid JSON." } });
  }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export async function handleWorkbenchV2Api(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  actionNonce: string,
  services: WorkbenchV2ApiServices = {}
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v2/")) return false;

  if (request.method === "GET" && url.pathname === "/api/v2/shell") {
    const data = withDatabase((db) => getWorkbenchShell(db));
    sendOk(response, { ...data, action_nonce: actionNonce });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v2/dashboard") {
    sendOk(response, withDatabase((db) => getWorkbenchDashboard(db)));
    return true;
  }

  const inboxMatch = url.pathname.match(/^\/api\/v2\/inbox\/([^/]+)$/);
  if (request.method === "GET" && inboxMatch) {
    const tab = decodeSegment(inboxMatch[1]);
    if (!INBOX_TABS.has(tab)) {
      send(response, 404, { ok: false, error: { code: "INBOX_TAB_NOT_FOUND", message: "Inbox tab was not found." } });
      return true;
    }
    const result = withDatabase((db) => listWorkbenchInboxV21(tab as "pending" | "drafts" | "quarantine", {
      status: url.searchParams.get("status") ?? undefined,
      limit: numberParam(url.searchParams.get("limit")),
      offset: numberParam(url.searchParams.get("offset"))
    }, db));
    sendPage(response, result);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v2/projects") {
    const lifecycle = (url.searchParams.get("lifecycle") ?? "active") as WorkbenchProjectLifecycle | "all";
    const classification = (url.searchParams.get("classification") ?? "all") as WorkbenchProjectClassification | "all";
    const result = withDatabase((db) => listWorkbenchProjects({
      scope: (url.searchParams.get("scope") ?? "daily") as WorkbenchProjectScope,
      lifecycle,
      classification,
      query: url.searchParams.get("query") ?? undefined,
      limit: numberParam(url.searchParams.get("limit")),
      offset: numberParam(url.searchParams.get("offset"))
    }, db));
    sendPage(response, result);
    return true;
  }

  const projectWorkspaceMatch = url.pathname.match(/^\/api\/v2\/projects\/([^/]+)\/(overview|storyboard|generation|review|delivery)$/);
  if (request.method === "GET" && projectWorkspaceMatch) {
    const projectId = decodeSegment(projectWorkspaceMatch[1]);
    const workspace = projectWorkspaceMatch[2] as WorkbenchWorkspace;
    if (!projectId || !PROJECT_WORKSPACES.has(workspace)) {
      send(response, 404, { ok: false, error: { code: "PROJECT_WORKSPACE_NOT_FOUND", message: "Project workspace was not found." } });
      return true;
    }
    sendResult(response, withDatabase((db) => getWorkbenchProjectWorkspace(projectId, workspace, db, { touch_last_opened: true })));
    return true;
  }

  const assetsMatch = url.pathname.match(/^\/api\/v2\/assets\/([^/]+)$/);
  if (request.method === "GET" && assetsMatch) {
    const tab = decodeSegment(assetsMatch[1]);
    if (!ASSET_TABS.has(tab)) {
      send(response, 404, { ok: false, error: { code: "ASSET_TAB_NOT_FOUND", message: "Asset tab was not found." } });
      return true;
    }
    const result = withDatabase((db) => listWorkbenchAssets(tab as "media" | "memory" | "reference" | "recall", {
      project_id: url.searchParams.get("project_id") ?? undefined,
      scope: (url.searchParams.get("scope") ?? "daily") as "daily" | "unassigned" | "all",
      type: url.searchParams.get("type") ?? undefined,
      role: url.searchParams.get("role") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      limit: numberParam(url.searchParams.get("limit")),
      offset: numberParam(url.searchParams.get("offset"))
    }, db));
    sendPage(response, result);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v2/system/canary") {
    sendOk(response, h2CanaryWorkbenchSummary());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v2/system/readonly-operations") {
    if (!services.readonly_operations) {
      send(response, 503, { ok: false, error: { code: "READONLY_PERSONAL_OPERATIONS_NOT_CONFIGURED", message: "Readonly operations are not configured." } });
      return true;
    }
    try {
      sendOk(response, await services.readonly_operations.status());
    } catch (error) {
      sendReadonlyOperationsError(response, error);
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v2/system/readonly-operations/preflight") {
    await mutation(request, response, actionNonce, async () => {
      if (!services.readonly_operations) {
        send(response, 503, { ok: false, error: { code: "READONLY_PERSONAL_OPERATIONS_NOT_CONFIGURED", message: "Readonly operations are not configured." } });
        return;
      }
      try {
        sendOk(response, await services.readonly_operations.preflight());
      } catch (error) {
        sendReadonlyOperationsError(response, error);
      }
    });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v2/system/readonly-operations/publish") {
    await mutation(request, response, actionNonce, async (body) => {
      if (body.human_confirmation !== true) {
        send(response, 403, { ok: false, error: { code: "READONLY_PUBLISH_CONFIRMATION_REQUIRED", message: "Human confirmation is required." } });
        return;
      }
      if (!services.readonly_operations) {
        send(response, 503, { ok: false, error: { code: "READONLY_PERSONAL_OPERATIONS_NOT_CONFIGURED", message: "Readonly operations are not configured." } });
        return;
      }
      try {
        sendOk(response, await services.readonly_operations.publish());
      } catch (error) {
        sendReadonlyOperationsError(response, error);
      }
    });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v2/system/reports") {
    sendPage(response, listWorkbenchReports({ limit: numberParam(url.searchParams.get("limit")), offset: numberParam(url.searchParams.get("offset")) }));
    return true;
  }
  const reportMatch = url.pathname.match(/^\/api\/v2\/system\/reports\/([^/]+)$/);
  if (request.method === "GET" && reportMatch) {
    sendResult(response, getWorkbenchReport(decodeSegment(reportMatch[1])));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v2/system/governance") {
    sendOk(response, withDatabase((db) => getWorkbenchGovernancePreview(db)));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v2/system/governance/apply") {
    await mutation(request, response, actionNonce, (body) => sendResult(response, withDatabase((db) => applyWorkbenchGovernance({
      rule_groups: Array.isArray(body.rule_groups) ? body.rule_groups.map(String) : [],
      snapshot_hash: text(body.snapshot_hash)
    }, db))));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v2/projects") {
    await mutation(request, response, actionNonce, (body) => sendResult(response, withDatabase((db) => createWorkbenchProject({
      title: text(body.title),
      classification: body.classification as WorkbenchProjectClassification | undefined,
      project_type: optionalText(body.project_type),
      duration_seconds: body.duration_seconds === undefined ? undefined : Number(body.duration_seconds),
      aspect_ratio: optionalText(body.aspect_ratio),
      resolution: optionalText(body.resolution)
    }, db))));
    return true;
  }

  const projectMutationMatch = url.pathname.match(/^\/api\/v2\/projects\/([^/]+)$/);
  if (request.method === "PATCH" && projectMutationMatch) {
    const projectId = decodeSegment(projectMutationMatch[1]);
    await mutation(request, response, actionNonce, (body) => {
      const override = record(body.next_action_override);
      sendResult(response, withDatabase((db) => updateWorkbenchProject(projectId, {
        title: optionalText(body.title),
        classification: body.classification as WorkbenchProjectClassification | undefined,
        pinned: body.pinned === undefined ? undefined : body.pinned === true,
        next_action_override: body.next_action_override === null ? null : override ? {
          label: text(override.label),
          priority: override.priority as WorkbenchProjectPriority
        } : undefined
      }, db)));
    });
    return true;
  }

  const draftTransitionMatch = url.pathname.match(/^\/api\/v2\/inbox\/drafts\/([^/]+)\/transition$/);
  if (request.method === "POST" && draftTransitionMatch) {
    const draftId = decodeSegment(draftTransitionMatch[1]);
    await mutation(request, response, actionNonce, (body) => sendResult(response, withDatabase((db) => transitionWorkbenchDraft(draftId, {
      action: body.action === "request_revision" || body.action === "close" ? body.action : "promote",
      note: optionalText(body.note),
      target_project_id: optionalText(body.target_project_id),
      target_shot_id: optionalText(body.target_shot_id),
      create_new_shot: body.create_new_shot === true,
      project_title: optionalText(body.project_title),
      classification: body.classification as WorkbenchProjectClassification | undefined
    }, db))));
    return true;
  }

  const pendingDecisionMatch = url.pathname.match(/^\/api\/v2\/inbox\/pending\/([^/]+)\/decision$/);
  if (request.method === "POST" && pendingDecisionMatch) {
    const actionId = decodeSegment(pendingDecisionMatch[1]);
    await mutation(request, response, actionNonce, (body) => sendResult(response, withDatabase((db) => decideWorkbenchPendingAction(actionId, {
      decision: body.decision === "reject" ? "reject" : "execute",
      reason: optionalText(body.reason),
      target_project_id: optionalText(body.target_project_id)
    }, db))));
    return true;
  }

  const lifecycleMatch = url.pathname.match(/^\/api\/v2\/projects\/([^/]+)\/(archive|restore)$/);
  if (request.method === "POST" && lifecycleMatch) {
    const projectId = decodeSegment(lifecycleMatch[1]);
    const lifecycle = lifecycleMatch[2] === "archive" ? "archived" : "active";
    await mutation(request, response, actionNonce, () => sendResult(response, withDatabase((db) => setWorkbenchProjectLifecycle(projectId, lifecycle, db))));
    return true;
  }

  const shotMatch = url.pathname.match(/^\/api\/v2\/projects\/([^/]+)\/shots\/([^/]+)$/);
  if (request.method === "PATCH" && shotMatch) {
    const projectId = decodeSegment(shotMatch[1]);
    const shotId = decodeSegment(shotMatch[2]);
    await mutation(request, response, actionNonce, (body) => sendResult(response, withDatabase((db) => updateWorkbenchShot(projectId, shotId, {
      description: optionalText(body.description),
      video_prompt: optionalText(body.video_prompt),
      negative_prompt: optionalText(body.negative_prompt),
      duration_seconds: body.duration_seconds === undefined ? undefined : Number(body.duration_seconds),
      storyboard_image_artifact_id: optionalText(body.storyboard_image_artifact_id),
      approve_storyboard: body.approve_storyboard === true,
      human_confirmation: body.human_confirmation === true
    }, db))));
    return true;
  }

  const reviewMatch = url.pathname.match(/^\/api\/v2\/projects\/([^/]+)\/review\/decision$/);
  if (request.method === "POST" && reviewMatch) {
    const projectId = decodeSegment(reviewMatch[1]);
    await mutation(request, response, actionNonce, (body) => {
      const revision = body.revision_instruction && typeof body.revision_instruction === "object" && !Array.isArray(body.revision_instruction)
        ? body.revision_instruction as Record<string, unknown>
        : {};
      sendResult(response, withDatabase((db) => decideWorkbenchClip(projectId, {
        shot_id: text(body.shot_id),
        artifact_id: text(body.artifact_id),
        decision: body.decision === "revision_needed" ? "revision_needed" : "approved",
        rejection_reasons: Array.isArray(body.rejection_reasons) ? body.rejection_reasons.map(String) : [],
        revision_instruction: body.decision === "revision_needed" ? {
          summary: text(revision.summary),
          prompt_delta: text(revision.prompt_delta),
          negative_delta: text(revision.negative_delta),
          priority: revision.priority === "low" || revision.priority === "high" ? revision.priority : "medium"
        } : undefined
      }, db)));
    });
    return true;
  }

  const generationPreflightMatch = url.pathname.match(/^\/api\/v2\/projects\/([^/]+)\/generation\/preflight$/);
  if (request.method === "POST" && generationPreflightMatch) {
    const projectId = decodeSegment(generationPreflightMatch[1]);
    await mutation(request, response, actionNonce, async (body) => {
      const db = openM0Database();
      try {
        sendResult(response, await preflightWorkbenchGeneration({
          project_id: projectId,
          shot_id: text(body.shot_id),
          account_label: body.account_label === "team" ? "team" : "personal",
          budget_limit_value: Number(body.budget_limit_value)
        }, db));
      } finally {
        db.close();
      }
    });
    return true;
  }

  const generationIntentMatch = url.pathname.match(/^\/api\/v2\/generation\/intents\/([^/]+)$/);
  if (request.method === "GET" && generationIntentMatch) {
    sendResult(response, withDatabase((db) => getWorkbenchGenerationIntent(decodeSegment(generationIntentMatch[1]), db)));
    return true;
  }

  const generationConfirmMatch = url.pathname.match(/^\/api\/v2\/generation\/intents\/([^/]+)\/confirm$/);
  if (request.method === "POST" && generationConfirmMatch) {
    const intentId = decodeSegment(generationConfirmMatch[1]);
    await mutation(request, response, actionNonce, (body) => {
      const result = withDatabase((db) => confirmWorkbenchGeneration({
        intent_id: intentId,
        budget_limit_value: Number(body.budget_limit_value),
        cost_confirmed: body.cost_confirmed === true,
        human_confirmation: body.human_confirmation === true
      }, db));
      if (result.ok) startWorkbenchGeneration(intentId, { allow_submit: true });
      sendResult(response, result, 202);
    });
    return true;
  }

  const generationReconcileMatch = url.pathname.match(/^\/api\/v2\/generation\/jobs\/([^/]+)\/reconcile$/);
  if (request.method === "POST" && generationReconcileMatch) {
    const jobId = decodeSegment(generationReconcileMatch[1]);
    await mutation(request, response, actionNonce, (body) => {
      const result = withDatabase((db) => reconcileGenerationJob(jobId, {
        decision: optionalText(body.decision) ?? "",
        provider_task_id: optionalText(body.provider_task_id),
        reason: optionalText(body.reason),
        human_confirmation: body.human_confirmation === true
      }, db));
      if (result.ok && result.data.job.state === "polling") startWorkbenchGeneration(result.data.intent.intent_id, { allow_submit: false });
      sendResult(response, result);
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v2/import-index/refresh") {
    await mutation(request, response, actionNonce, () => sendOk(response, withDatabase((db) => refreshWorkbenchImportIndex(db))));
    return true;
  }

  const importDecisionMatch = url.pathname.match(/^\/api\/v2\/imports\/([a-fA-F0-9]{64})\/decision$/);
  if (request.method === "POST" && importDecisionMatch) {
    await mutation(request, response, actionNonce, (body) => sendResult(response, withDatabase((db) => decideWorkbenchImport(importDecisionMatch[1].toLowerCase(), {
      decision: body.decision === "registered" || body.decision === "excluded" ? body.decision : "quarantined",
      target_project_id: optionalText(body.target_project_id),
      reason: optionalText(body.reason)
    }, db))));
    return true;
  }

  send(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "V2 route was not found." } });
  return true;
}
