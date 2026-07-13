import { randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { validateAcceptedClipReference, validateActiveArtifactReference } from "./mediaArtifacts.js";
import { createProject, getProject, getShot, listProjectShots, saveProject, saveShot, type Project, type Shot } from "./projects.js";
import { saveStoryboardPackage, type StoryboardPackage } from "./storyboardPackages.js";
import { decideWorkbenchClip, decideWorkbenchImport, updateWorkbenchShot, type WorkbenchPage, type WorkbenchProjectClassification, type WorkbenchV2Result } from "./workbenchV2.js";
import {
  appendWorkbenchInboxEvent,
  getWorkbenchDraftRecord,
  getWorkbenchPendingActionRecord,
  listWorkbenchDraftRecords,
  listWorkbenchPendingActionRecords,
  saveWorkbenchDraftRecord,
  saveWorkbenchPendingActionRecord,
  type WorkbenchDraftRecord,
  type WorkbenchPendingActionRecord
} from "./workbenchInboxStore.js";

interface ImportIndexRow {
  relative_path: string;
  filename: string;
  size_bytes: number;
  mtime_ms: number;
  checksum: string;
  metadata_json: string;
  scanned_at: string;
  decision: string | null;
  target_project_id: string | null;
  artifact_id: string | null;
  reason: string | null;
}

class InboxDomainError extends Error {
  constructor(readonly code: string, message: string, readonly field?: string) {
    super(message);
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function clampLimit(value: number | undefined, fallback = 50, maximum = 200): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value ?? fallback)));
}

function clampOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value ?? 0));
}

function page<T>(items: T[], total: number, limit: number, offset: number): WorkbenchPage<T> {
  return { items, meta: { limit, offset, total, has_more: offset + items.length < total } };
}

export function listWorkbenchInboxV21(
  tab: "pending" | "drafts" | "quarantine",
  input: { status?: string; limit?: number; offset?: number } = {},
  db = openM0Database()
): WorkbenchPage<Record<string, unknown>> {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  const status = input.status && input.status !== "all" ? input.status : "";
  if (tab === "pending") {
    const all = [...listWorkbenchPendingActionRecords(db)].reverse().filter((item) => !status || item.status === status);
    return page(all.slice(offset, offset + limit), all.length, limit, offset);
  }
  if (tab === "drafts") {
    const all = [...listWorkbenchDraftRecords(db)].reverse().filter((item) => !status || item.status === status);
    return page(all.slice(offset, offset + limit), all.length, limit, offset);
  }
  const rows = db.prepare(`
    SELECT i.*, d.decision, d.target_project_id, d.artifact_id, d.reason
    FROM import_index i LEFT JOIN import_decisions d ON d.checksum = i.checksum
    ORDER BY i.scanned_at DESC, i.filename
  `).all() as ImportIndexRow[];
  const items = rows.map((row) => {
    const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
    const blockers = Array.isArray(metadata.blockers) ? metadata.blockers : [];
    const decision = row.decision ?? "quarantined";
    const workflowStatus = decision === "registered" || decision === "excluded"
      ? decision
      : blockers.length > 0 ? "blocked" : "registerable";
    return {
      relative_path: row.relative_path,
      filename: row.filename,
      size_bytes: row.size_bytes,
      checksum: row.checksum,
      ...metadata,
      blockers,
      decision,
      workflow_status: workflowStatus,
      target_project_id: row.target_project_id ?? "",
      artifact_id: row.artifact_id ?? "",
      reason: row.reason ?? ""
    };
  }).filter((item) => !status || item.workflow_status === status);
  return page(items.slice(offset, offset + limit), items.length, limit, offset);
}

export function transitionWorkbenchDraft(
  draftId: string,
  input: {
    action: "request_revision" | "promote" | "close";
    note?: string;
    target_project_id?: string;
    target_shot_id?: string;
    create_new_shot?: boolean;
    project_title?: string;
    classification?: WorkbenchProjectClassification;
  },
  db = openM0Database()
): WorkbenchV2Result<{ draft: WorkbenchDraftRecord; project?: Project; shot?: Shot; pending_action?: WorkbenchPendingActionRecord }> {
  const draft = getWorkbenchDraftRecord(draftId, db);
  if (!draft) return { ok: false, error: { code: "DRAFT_NOT_FOUND", message: `Draft not found: ${draftId}`, field: "draft_id" } };
  if (draft.status !== "pending" && draft.status !== "revision_needed") {
    return { ok: false, error: { code: "INVALID_DRAFT_TRANSITION", message: `Draft cannot transition from ${draft.status}.` } };
  }
  const note = input.note?.trim() ?? "";
  if (input.action === "request_revision" && (note.length < 1 || note.length > 500)) {
    return { ok: false, error: { code: "INVALID_FIELD", message: "Revision note must contain 1 to 500 characters.", field: "note" } };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const updatedAt = new Date().toISOString();
    if (input.action === "request_revision") {
      const next = saveWorkbenchDraftRecord({ ...draft, status: "revision_needed", revision_note: note, updated_at: updatedAt }, db);
      appendWorkbenchInboxEvent({ object_type: "draft", object_id: draftId, event_type: "revision_requested", from_status: draft.status, to_status: next.status, data: { note } }, db);
      db.exec("COMMIT");
      return { ok: true, data: { draft: next } };
    }
    if (input.action === "close") {
      const next = saveWorkbenchDraftRecord({ ...draft, status: "closed", revision_note: note, updated_at: updatedAt }, db);
      appendWorkbenchInboxEvent({ object_type: "draft", object_id: draftId, event_type: "closed", from_status: draft.status, to_status: next.status, data: { note } }, db);
      db.exec("COMMIT");
      return { ok: true, data: { draft: next } };
    }
    const promoted = promoteDraft(draft, input, db);
    const next = saveWorkbenchDraftRecord({
      ...draft,
      status: "promoted",
      target_project_id: promoted.project?.project_id ?? promoted.pending_action?.project_id ?? input.target_project_id ?? "",
      target_shot_id: promoted.shot?.shot_id ?? input.target_shot_id ?? "",
      promoted_object_type: promoted.pending_action ? "pending_action" : promoted.shot ? "shot" : "project",
      promoted_object_id: promoted.pending_action?.action_id ?? promoted.shot?.shot_id ?? promoted.project?.project_id ?? "",
      updated_at: updatedAt
    }, db);
    appendWorkbenchInboxEvent({
      object_type: "draft",
      object_id: draftId,
      event_type: "promoted",
      from_status: draft.status,
      to_status: next.status,
      data: { promoted_object_type: next.promoted_object_type, promoted_object_id: next.promoted_object_id }
    }, db);
    db.exec("COMMIT");
    return { ok: true, data: { draft: next, ...promoted } };
  } catch (error) {
    db.exec("ROLLBACK");
    const domain = error instanceof InboxDomainError ? error : new InboxDomainError("DRAFT_APPLY_BLOCKED", error instanceof Error ? error.message : "Draft apply failed.");
    return { ok: false, error: { code: domain.code, message: domain.message, field: domain.field } };
  }
}

function promoteDraft(
  draft: WorkbenchDraftRecord,
  input: { target_project_id?: string; target_shot_id?: string; create_new_shot?: boolean; project_title?: string; classification?: WorkbenchProjectClassification },
  db: M0Database
): { project?: Project; shot?: Shot; pending_action?: WorkbenchPendingActionRecord } {
  if (draft.tool === "submit_shot_script_draft") return promoteShotDraft(draft, input, db);
  if (draft.tool === "submit_storyboard_package_draft") return promotePackageDraft(draft, input, db);
  const pendingAction = promoteProposalDraft(draft, input.target_project_id, db);
  return { pending_action: pendingAction };
}

function promoteShotDraft(
  draft: WorkbenchDraftRecord,
  input: { target_project_id?: string; target_shot_id?: string; create_new_shot?: boolean },
  db: M0Database
): { project: Project; shot: Shot } {
  const projectId = input.target_project_id?.trim() ?? "";
  const project = writableProject(projectId, db);
  const payload = draft.payload;
  const duration = Number(payload.duration_seconds ?? 3);
  if (!Number.isFinite(duration) || duration <= 0) throw new InboxDomainError("INVALID_FIELD", "Draft duration must be positive.", "duration_seconds");
  if (input.create_new_shot) {
    const existing = listProjectShots(db, projectId);
    const shot: Shot = {
      shot_id: `shot_${randomUUID()}`,
      project_id: projectId,
      order: existing.reduce((max, item) => Math.max(max, item.order), 0) + 1,
      status: "draft",
      duration_seconds: duration,
      description: String(payload.description ?? ""),
      storyboard_image_artifact_id: "",
      video_prompt: String(payload.video_prompt ?? ""),
      negative_prompt: String(payload.negative_prompt ?? ""),
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    saveShot(db, shot);
    project.shot_ids = [...project.shot_ids, shot.shot_id];
    saveProject(db, project);
    return { project, shot };
  }
  const shotId = input.target_shot_id?.trim() ?? "";
  if (!shotId) throw new InboxDomainError("MISSING_REQUIRED_FIELD", "Target SHOT or create_new_shot is required.", "target_shot_id");
  const updated = updateWorkbenchShot(projectId, shotId, {
    description: String(payload.description ?? ""),
    video_prompt: String(payload.video_prompt ?? ""),
    negative_prompt: String(payload.negative_prompt ?? ""),
    duration_seconds: duration
  }, db);
  if (!updated.ok) throw new InboxDomainError(updated.error.code, updated.error.message, updated.error.field);
  return { project, shot: updated.data.shot };
}

function promotePackageDraft(
  draft: WorkbenchDraftRecord,
  input: { project_title?: string; classification?: WorkbenchProjectClassification },
  db: M0Database
): { project: Project } {
  const title = input.project_title?.trim() ?? "";
  if (!title) throw new InboxDomainError("MISSING_REQUIRED_FIELD", "Project title is required.", "project_title");
  if (input.classification !== "production" && input.classification !== "test") {
    throw new InboxDomainError("CLASSIFICATION_REQUIRED", "Project classification must be production or test.", "classification");
  }
  const payloadPackage = draft.payload.package && typeof draft.payload.package === "object" ? draft.payload.package as Record<string, unknown> : draft.payload;
  const rawShots = Array.isArray(draft.payload.shots) ? draft.payload.shots : Array.isArray(payloadPackage.shots) ? payloadPackage.shots : [];
  if (rawShots.length === 0) throw new InboxDomainError("DRAFT_APPLY_BLOCKED", "Storyboard package draft contains no SHOTs.");
  const spec = payloadPackage.video_spec && typeof payloadPackage.video_spec === "object" ? payloadPackage.video_spec as Record<string, unknown> : {};
  const created = createProject({
    title,
    project_type: "human_workbench_v2_draft_promotion",
    video_spec: {
      duration_seconds: positiveNumber(spec.duration_seconds, 15),
      aspect_ratio: String(spec.aspect_ratio ?? "9:16"),
      resolution: String(spec.resolution ?? "1080x1920")
    }
  }, db);
  if (!created.ok) throw new InboxDomainError(created.error.code, created.error.message);
  db.prepare("INSERT OR IGNORE INTO workbench_project_meta (project_id) VALUES (?)").run(created.project_id);
  db.prepare("UPDATE workbench_project_meta SET classification = ?, lifecycle = 'active', updated_at = CURRENT_TIMESTAMP WHERE project_id = ?").run(input.classification, created.project_id);
  const shots: Shot[] = [];
  for (const [index, raw] of rawShots.entries()) {
    if (!raw || typeof raw !== "object") throw new InboxDomainError("DRAFT_APPLY_BLOCKED", `SHOT ${index + 1} is invalid.`);
    const item = raw as Record<string, unknown>;
    const artifactId = String(item.storyboard_image_artifact_id ?? "");
    if (artifactId) {
      throw new InboxDomainError(
        "DRAFT_APPLY_BLOCKED",
        `SHOT ${index + 1} must attach its storyboard image through the project-bound media workflow after promotion.`
      );
    }
    const videoPrompt = String(item.video_prompt ?? "");
    const shot: Shot = {
      shot_id: `shot_${randomUUID()}`,
      project_id: created.project_id,
      order: index + 1,
      status: artifactId && videoPrompt ? "storyboard_approved" : "draft",
      duration_seconds: positiveNumber(item.duration_seconds, 3),
      description: String(item.description ?? item.shot_description ?? ""),
      storyboard_image_artifact_id: artifactId,
      video_prompt: videoPrompt,
      negative_prompt: String(item.negative_prompt ?? ""),
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    saveShot(db, shot);
    shots.push(shot);
  }
  created.project.shot_ids = shots.map((shot) => shot.shot_id);
  saveProject(db, created.project);
  return { project: created.project };
}

function promoteProposalDraft(draft: WorkbenchDraftRecord, requestedProjectId: string | undefined, db: M0Database): WorkbenchPendingActionRecord {
  const toolMap: Record<string, string> = {
    propose_artifact_link: "request_link_artifact_to_shot",
    propose_package_validation: "request_validate_storyboard_package",
    propose_freeze_request: "request_import_storyboard_package",
    webgpt_v4_proposal_storyboard_package: "request_validate_storyboard_package",
    webgpt_v4_proposal_review_decision: "request_webgpt_review_decision",
    webgpt_v4_proposal_regeneration: "request_webgpt_regeneration",
    webgpt_v4_proposal_final_assembly: "request_webgpt_final_assembly_plan",
    webgpt_v4_proposal_memory_saveback: "request_webgpt_memory_saveback_plan",
    webgpt_v4_proposal_package_freeze: "request_import_storyboard_package"
  };
  const pendingTool = toolMap[draft.tool];
  if (!pendingTool) throw new InboxDomainError("DRAFT_APPLY_BLOCKED", `Unsupported draft tool: ${draft.tool}`);
  let projectId = requestedProjectId?.trim() ?? String(draft.payload.project_id ?? "");
  if (draft.source === "webgpt_v4") {
    const boundProjectId = draft.target_project_id || String(draft.payload.project_id ?? "");
    if (!boundProjectId || (requestedProjectId?.trim() && requestedProjectId.trim() !== boundProjectId)) {
      throw new InboxDomainError("DRAFT_TARGET_MISMATCH", "WebGPT V4 proposals cannot be moved to another project.", "target_project_id");
    }
    projectId = boundProjectId;
    writableProductionProject(projectId, db);
  }
  if (draft.tool === "propose_artifact_link") {
    const shot = getShot(db, String(draft.payload.shot_id ?? ""));
    if (!shot) throw new InboxDomainError("SHOT_NOT_FOUND", "Draft target SHOT was not found.", "shot_id");
    projectId = shot.project_id;
  }
  writableProject(projectId, db);
  const createdAt = new Date().toISOString();
  const action = saveWorkbenchPendingActionRecord({
    action_id: `webgpt_action_${randomUUID()}`,
    tool: pendingTool,
    status: "pending",
    created_at: createdAt,
    updated_at: createdAt,
    source: draft.source === "webgpt_v4" ? "webgpt_v4_draft_promotion" : "workbench_v2_1_draft_promotion",
    project_id: projectId,
    payload: { ...draft.payload, project_id: projectId, ...(draft.source === "webgpt_v4" ? { webgpt_v4_bound_project_id: projectId } : {}) },
    validation: { ok: true, blockers: [] },
    human_confirmation: { required: true, confirmed: false, rejected: false, confirmed_at: "", rejected_at: "", rejected_reason: "" },
    execution: { attempted: false, ok: null, executed_at: "", report_path: "", result: null, error: null },
    production_effects: { app_ready_truth_changed: false, media_artifact_registered: false, artifact_linked_to_shot: false, package_validated: false, package_frozen: false, provider_call_attempted: false, source_asset_overwritten: false }
  }, db);
  appendWorkbenchInboxEvent({ object_type: "pending_action", object_id: action.action_id, event_type: "created_from_draft", to_status: "pending", data: { draft_id: draft.draft_id } }, db);
  return action;
}

export function decideWorkbenchPendingAction(
  actionId: string,
  input: { decision: "execute" | "reject"; reason?: string; target_project_id?: string },
  db = openM0Database()
): WorkbenchV2Result<{ action: WorkbenchPendingActionRecord }> {
  const action = getWorkbenchPendingActionRecord(actionId, db);
  if (!action) return { ok: false, error: { code: "ACTION_NOT_FOUND", message: `Pending action not found: ${actionId}`, field: "action_id" } };
  if (action.status !== "pending") return { ok: false, error: { code: "ACTION_NOT_PENDING", message: `Action is not pending: ${action.status}` } };
  const reason = input.reason?.trim() ?? "";
  if (input.decision === "reject" && (reason.length < 1 || reason.length > 500)) {
    return { ok: false, error: { code: "INVALID_FIELD", message: "Rejection reason must contain 1 to 500 characters.", field: "reason" } };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const updatedAt = new Date().toISOString();
    if (input.decision === "reject") {
      const next = saveWorkbenchPendingActionRecord({
        ...action,
        status: "rejected",
        updated_at: updatedAt,
        human_confirmation: { ...(asRecord(action.human_confirmation)), rejected: true, rejected_at: updatedAt, rejected_reason: reason }
      }, db);
      appendWorkbenchInboxEvent({ object_type: "pending_action", object_id: actionId, event_type: "rejected", from_status: action.status, to_status: next.status, data: { reason } }, db);
      db.exec("COMMIT");
      return { ok: true, data: { action: next } };
    }
    const result = executePendingAction(action, input.target_project_id, db);
    const next = saveWorkbenchPendingActionRecord({
      ...action,
      status: "executed",
      updated_at: updatedAt,
      project_id: result.project_id,
      human_confirmation: { ...(asRecord(action.human_confirmation)), confirmed: true, confirmed_at: updatedAt },
      execution: { attempted: true, ok: true, executed_at: updatedAt, report_path: "", result: result.result, error: null },
      production_effects: { ...(asRecord(action.production_effects)), ...result.effects, provider_call_attempted: false, source_asset_overwritten: false }
    }, db);
    appendWorkbenchInboxEvent({ object_type: "pending_action", object_id: actionId, event_type: "executed", from_status: action.status, to_status: next.status, data: { project_id: result.project_id } }, db);
    db.exec("COMMIT");
    return { ok: true, data: { action: next } };
  } catch (error) {
    db.exec("ROLLBACK");
    const domain = error instanceof InboxDomainError ? error : new InboxDomainError("PENDING_ACTION_EXECUTION_FAILED", error instanceof Error ? error.message : "Pending action execution failed.");
    return { ok: false, error: { code: domain.code, message: domain.message, field: domain.field } };
  }
}

function executePendingAction(action: WorkbenchPendingActionRecord, requestedProjectId: string | undefined, db: M0Database): { project_id: string; result: Record<string, unknown>; effects: Record<string, boolean> } {
  const projectId = requestedProjectId?.trim() || action.project_id || String(action.payload.project_id ?? "");
  const boundProjectId = String(action.payload.webgpt_v4_bound_project_id ?? "");
  if (boundProjectId && projectId !== boundProjectId) throw new InboxDomainError("PENDING_ACTION_TARGET_MISMATCH", "WebGPT V4 pending actions cannot be moved to another project.", "target_project_id");
  if (action.tool === "request_register_media_artifact_from_import") {
    writableProject(projectId, db);
    const filename = String(action.payload.import_filename ?? "");
    const row = db.prepare("SELECT checksum FROM import_index WHERE filename = ? ORDER BY scanned_at DESC LIMIT 1").get(filename) as { checksum: string } | undefined;
    if (!row) throw new InboxDomainError("IMPORT_NOT_FOUND", `Import was not found: ${filename}`);
    const decision = decideWorkbenchImport(row.checksum, { decision: "registered", target_project_id: projectId }, db);
    if (!decision.ok) throw new InboxDomainError(decision.error.code, decision.error.message, decision.error.field);
    return { project_id: projectId, result: decision.data, effects: { app_ready_truth_changed: true, media_artifact_registered: true } };
  }
  if (action.tool === "request_link_artifact_to_shot") {
    const shot = getShot(db, String(action.payload.shot_id ?? ""));
    if (!shot) throw new InboxDomainError("SHOT_NOT_FOUND", "Target SHOT was not found.", "shot_id");
    writableProject(shot.project_id, db);
    const updated = updateWorkbenchShot(shot.project_id, shot.shot_id, { storyboard_image_artifact_id: String(action.payload.artifact_id ?? "") }, db);
    if (!updated.ok) throw new InboxDomainError(updated.error.code, updated.error.message, updated.error.field);
    return { project_id: shot.project_id, result: { shot: updated.data.shot }, effects: { app_ready_truth_changed: true, artifact_linked_to_shot: true } };
  }
  if (action.tool === "request_webgpt_review_decision") {
    writableProject(projectId, db);
    const rawDecision = String(action.payload.decision ?? "");
    if (rawDecision !== "approved" && rawDecision !== "revision_needed") {
      throw new InboxDomainError("INVALID_REVIEW_DECISION", "Review decision must be approved or revision_needed.", "decision");
    }
    const decision = rawDecision;
    const revision = action.payload.revision_instruction && typeof action.payload.revision_instruction === "object" && !Array.isArray(action.payload.revision_instruction)
      ? action.payload.revision_instruction as Record<string, unknown>
      : {};
    const reviewed = decideWorkbenchClip(projectId, {
      shot_id: String(action.payload.shot_id ?? ""),
      artifact_id: String(action.payload.artifact_id ?? ""),
      decision,
      rejection_reasons: decision === "revision_needed" && Array.isArray(action.payload.rejection_reasons) ? action.payload.rejection_reasons.map(String) : [],
      revision_instruction: decision === "revision_needed" ? {
        summary: String(revision.summary ?? ""),
        prompt_delta: String(revision.prompt_delta ?? ""),
        negative_delta: String(revision.negative_delta ?? ""),
        priority: revision.priority === "low" || revision.priority === "high" ? revision.priority : "medium"
      } : undefined
    }, db);
    if (!reviewed.ok) throw new InboxDomainError(reviewed.error.code, reviewed.error.message, reviewed.error.field);
    return { project_id: projectId, result: reviewed.data, effects: { app_ready_truth_changed: true } };
  }
  if (action.tool === "request_webgpt_regeneration") {
    const project = writableProject(projectId, db);
    const shot = getShot(db, String(action.payload.shot_id ?? ""));
    if (!shot || shot.project_id !== project.project_id) throw new InboxDomainError("SHOT_NOT_FOUND", "Regeneration target SHOT was not found.", "shot_id");
    const artifact = validateActiveArtifactReference(db, {
      artifact_id: String(action.payload.artifact_id ?? ""), project_id: projectId, shot_id: shot.shot_id, role: "generated_clip", artifact_type: "video"
    });
    if (!artifact.ok || !shot.clip_versions.some((version) => version.artifact_id === artifact.artifact.artifact_id)) {
      throw new InboxDomainError(artifact.ok ? "ARTIFACT_NOT_IN_SHOT_REVIEW" : artifact.error.code, artifact.ok ? "Regeneration target is not a clip version of the SHOT." : artifact.error.message, "artifact_id");
    }
    const requestId = `regeneration_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const data = { ...action.payload, request_id: requestId, project_id: projectId, shot_id: shot.shot_id, artifact_id: artifact.artifact.artifact_id, status: "draft", created_at: createdAt };
    db.prepare(`
      INSERT INTO regeneration_requests (request_id, project_id, shot_id, artifact_id, previous_run_id, status, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)
    `).run(requestId, projectId, shot.shot_id, artifact.artifact.artifact_id, String(action.payload.previous_run_id ?? ""), JSON.stringify(data), createdAt, createdAt);
    return { project_id: projectId, result: data, effects: { app_ready_truth_changed: true } };
  }
  if (action.tool === "request_webgpt_final_assembly_plan") {
    writableProject(projectId, db);
    const shots = listProjectShots(db, projectId);
    const accepted = shots.map((shot) => shot.accepted_clip_artifact_id ? validateAcceptedClipReference(db, shot) : null);
    if (shots.length === 0 || accepted.some((artifact) => !artifact?.ok)) {
      throw new InboxDomainError("ASSEMBLY_NOT_READY", "Every SHOT must have an accepted clip before accepting the assembly plan.");
    }
    return { project_id: projectId, result: { accepted: true, kind: "final_assembly", shot_order: shots.map((shot) => ({ shot_id: shot.shot_id, artifact_id: shot.accepted_clip_artifact_id })) }, effects: { app_ready_truth_changed: false } };
  }
  if (action.tool === "request_webgpt_memory_saveback_plan") {
    writableProject(projectId, db);
    return { project_id: projectId, result: { accepted: true, kind: "memory_saveback", execution_required_in_memory_workspace: true, proposal: action.payload }, effects: { app_ready_truth_changed: false } };
  }
  const project = writableProject(projectId, db);
  const shots = validateProjectStoryboard(projectId, db);
  if (action.tool === "request_validate_storyboard_package") {
    return { project_id: projectId, result: { valid: true, shot_count: shots.length }, effects: { package_validated: true } };
  }
  if (action.tool === "request_import_storyboard_package") {
    const storyboardPackage: StoryboardPackage = {
      storyboard_package_id: `storyboard_package_${randomUUID()}`,
      project_id: projectId,
      status: "approved_for_video_generation",
      approved_shot_snapshots: shots.map((shot) => ({
        shot_id: shot.shot_id,
        order: shot.order,
        duration_seconds: shot.duration_seconds,
        description: shot.description,
        storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
        video_prompt: shot.video_prompt,
        negative_prompt: shot.negative_prompt
      })),
      user_approval: { storyboard_approved: true }
    };
    saveStoryboardPackage(db, storyboardPackage);
    project.active_storyboard_package_id = storyboardPackage.storyboard_package_id;
    project.status = "storyboard_approved";
    for (const shot of shots) {
      shot.status = "storyboard_approved";
      saveShot(db, shot);
    }
    saveProject(db, project);
    return { project_id: projectId, result: { storyboard_package: storyboardPackage }, effects: { app_ready_truth_changed: true, package_validated: true, package_frozen: true } };
  }
  throw new InboxDomainError("TOOL_NOT_FOUND", `Unsupported pending action: ${action.tool}`);
}

function validateProjectStoryboard(projectId: string, db: M0Database): Shot[] {
  const shots = listProjectShots(db, projectId);
  if (shots.length === 0) throw new InboxDomainError("PACKAGE_BLOCKED", "Project has no SHOTs.");
  for (const shot of shots) {
    if (!shot.storyboard_image_artifact_id || !shot.video_prompt) throw new InboxDomainError("PACKAGE_BLOCKED", `SHOT ${shot.shot_id} is missing image or prompt.`);
    const artifact = validateActiveArtifactReference(db, {
      artifact_id: shot.storyboard_image_artifact_id,
      project_id: projectId,
      shot_id: shot.shot_id,
      role: "storyboard_image",
      artifact_type: "image"
    });
    if (!artifact.ok) {
      throw new InboxDomainError("PACKAGE_BLOCKED", `SHOT ${shot.shot_id} has an invalid storyboard image [${artifact.error.code}].`);
    }
  }
  return shots;
}

function writableProject(projectId: string, db: M0Database): Project {
  if (!projectId) throw new InboxDomainError("PENDING_ACTION_TARGET_REQUIRED", "Target project is required.", "target_project_id");
  const project = getProject(db, projectId);
  if (!project) throw new InboxDomainError("PROJECT_NOT_FOUND", `Project not found: ${projectId}`, "target_project_id");
  const meta = db.prepare("SELECT lifecycle FROM workbench_project_meta WHERE project_id = ?").get(projectId) as { lifecycle: string } | undefined;
  if (meta?.lifecycle === "archived") throw new InboxDomainError("PROJECT_ARCHIVED", "Archived projects are read-only.", "target_project_id");
  return project;
}

function writableProductionProject(projectId: string, db: M0Database): Project {
  const project = writableProject(projectId, db);
  const meta = db.prepare("SELECT classification FROM workbench_project_meta WHERE project_id = ?").get(projectId) as { classification: string } | undefined;
  if (meta?.classification !== "production") throw new InboxDomainError("PROJECT_NOT_FOUND", "Production project was not found.", "target_project_id");
  return project;
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
