import { randomUUID } from "node:crypto";

import {
  DIRECTOR_FOCUS_SCHEMA,
  DIRECTOR_PROPOSAL_SCHEMA,
  validateDirectorProposalAgainstTargetState,
  type DirectorFocus,
  type DirectorProposal,
  type DirectorProposalDraft
} from "./domain.js";
import { buildDirectorContext } from "./localService.js";
import { getMediaArtifact } from "../tools/mediaArtifacts.js";
import { getGenerationRun } from "../tools/generation.js";
import { getProject, getShot, type Project } from "../tools/projects.js";
import type { M0Database } from "../storage/sqlite.js";

const WORKSPACE_ID = "jenn-ai-video-workspace";
const MAX_FOCUS_TTL_SECONDS = 2 * 60 * 60;
const DEFAULT_FOCUS_TTL_SECONDS = 30 * 60;

export type DirectorApprovalDecision = "accept" | "reject";
export type DirectorFocusTargetType = DirectorFocus["target_type"];
type DirectorProposalKind = DirectorProposalDraft["kind"];

export interface DirectorApprovalError {
  code: string;
  message: string;
  field?: string;
}

export type DirectorApprovalResult<T> = { ok: true; data: T } | { ok: false; error: DirectorApprovalError };

interface StoredProposalRow {
  proposal_id: string;
  workspace_id: string;
  principal_id: string;
  project_id: string;
  target_type: DirectorProposal["target_type"];
  target_id: string;
  focus_id: string;
  focus_generation: number;
  schema_version: "director-domain-v1";
  kind: DirectorProposalKind;
  base_state_hash: string;
  payload_json: string;
  payload_hash: string;
  parent_proposal_id: string | null;
  idempotency_key: string;
  source: DirectorProposal["source"];
  created_at: string;
}

interface StoredFocusRow {
  focus_id: string;
  workspace_id: string;
  principal_id: string;
  project_id: string;
  target_type: DirectorFocus["target_type"];
  target_id: string;
  generation: number;
  supersedes_focus_id: string | null;
  created_at: string;
  expires_at: string;
}

export interface DirectorProposalQueueItem {
  proposal_id: string;
  project_id: string;
  target_type: DirectorProposal["target_type"];
  target_id: string;
  focus_id: string;
  focus_generation: number;
  kind: DirectorProposalKind;
  source: DirectorProposal["source"];
  created_at: string;
  base_state_hash: string;
  payload_hash: string;
  payload: DirectorProposal["payload"];
  status: "pending_review" | "accepted" | "rejected" | "withdrawn" | "compiled" | "stale";
  reason_code: string | null;
  updated_at: string;
  action_allowed: boolean;
  action_blocked_code: string | null;
}

export interface DirectorApprovalTower {
  project_id: string;
  principal_state: "single_owner_ready" | "no_active_owner" | "ambiguous_active_owner";
  focus: {
    state: "no_focus" | "active" | "focus_expired";
    focus: Omit<DirectorFocus, "workspace_id" | "principal_id"> | null;
  };
  proposals: DirectorProposalQueueItem[];
}

function error(code: string, message: string, field?: string): DirectorApprovalResult<never> {
  return { ok: false, error: { code, message, field } };
}

class DirectorApprovalAbort extends Error {
  constructor(readonly approvalError: DirectorApprovalError) {
    super(approvalError.code);
  }
}

function abortDecision(code: string, message: string, field?: string): never {
  throw new DirectorApprovalAbort({ code, message, field });
}

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function storedFocus(row: StoredFocusRow): DirectorFocus {
  return DIRECTOR_FOCUS_SCHEMA.parse({ ...row, generation: Number(row.generation) });
}

function storedProposal(row: StoredProposalRow): DirectorProposal {
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); }
  catch { throw new Error("DIRECTOR_PROPOSAL_PAYLOAD_INVALID"); }
  const { payload_json: _payloadJson, ...fields } = row;
  return DIRECTOR_PROPOSAL_SCHEMA.parse({ ...fields, focus_generation: Number(row.focus_generation), payload });
}

function focusTerminal(db: M0Database, focusId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM director_focus_events
    WHERE focus_id = ? AND event_type IN ('revoked', 'superseded') LIMIT 1`).get(focusId));
}

function latestFocus(db: M0Database, principalId: string): DirectorFocus | null {
  const row = db.prepare(`SELECT focus_id, workspace_id, principal_id, project_id, target_type, target_id,
      generation, supersedes_focus_id, created_at, expires_at
    FROM director_focuses WHERE workspace_id = ? AND principal_id = ?
    ORDER BY generation DESC LIMIT 1`).get(WORKSPACE_ID, principalId) as StoredFocusRow | undefined;
  return row ? storedFocus(row) : null;
}

function latestProposalEvent(db: M0Database, proposalId: string): { event_type: string; reason_code: string; created_at: string } | null {
  return db.prepare(`SELECT event_type, reason_code, created_at FROM director_proposal_events
    WHERE proposal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(proposalId) as { event_type: string; reason_code: string; created_at: string } | undefined ?? null;
}

function publicFocus(focus: DirectorFocus): Omit<DirectorFocus, "workspace_id" | "principal_id"> {
  const { workspace_id: _workspace, principal_id: _principal, ...publicValue } = focus;
  return publicValue;
}

function ownerPrincipals(db: M0Database, projectId: string): string[] {
  const rows = db.prepare(`SELECT DISTINCT m.principal_id
    FROM webgpt_project_memberships m
    JOIN webgpt_auth_principals p ON p.workspace_id = m.workspace_id AND p.principal_id = m.principal_id
    JOIN webgpt_auth_principal_bindings b ON b.workspace_id = m.workspace_id AND b.principal_id = m.principal_id
    WHERE m.workspace_id = ? AND m.project_id = ? AND m.role = 'owner' AND m.status = 'active' AND p.status = 'active'
    ORDER BY m.principal_id`).all(WORKSPACE_ID, projectId) as Array<{ principal_id: string }>;
  return rows.map((row) => row.principal_id);
}

function ownerState(db: M0Database, projectId: string): { state: DirectorApprovalTower["principal_state"]; principal_id: string | null } {
  const principals = ownerPrincipals(db, projectId);
  if (principals.length === 0) return { state: "no_active_owner", principal_id: null };
  if (principals.length !== 1) return { state: "ambiguous_active_owner", principal_id: null };
  return { state: "single_owner_ready", principal_id: principals[0]! };
}

function proposalPrincipalIsActiveMember(db: M0Database, proposal: DirectorProposal): boolean {
  return Boolean(db.prepare(`SELECT 1
    FROM webgpt_project_memberships m
    JOIN webgpt_auth_principals p ON p.workspace_id = m.workspace_id AND p.principal_id = m.principal_id
    JOIN webgpt_auth_principal_bindings b ON b.workspace_id = m.workspace_id AND b.principal_id = m.principal_id
    WHERE m.workspace_id = ? AND m.project_id = ? AND m.principal_id = ?
      AND m.status = 'active' AND p.status = 'active'
    LIMIT 1`).get(WORKSPACE_ID, proposal.project_id, proposal.principal_id));
}

function projectIsWritableDirectorProject(db: M0Database, projectId: string): Project | null {
  const row = db.prepare(`SELECT p.data_json FROM projects p
    JOIN workbench_project_meta m ON m.project_id = p.project_id
    WHERE p.project_id = ? AND m.classification = 'production' AND m.lifecycle = 'active'`).get(projectId) as { data_json: string } | undefined;
  if (!row) return null;
  try {
    const project = JSON.parse(row.data_json) as Project;
    return project.project_id === projectId ? project : null;
  } catch { return null; }
}

function assertFocusTarget(db: M0Database, project: Project, targetType: DirectorFocusTargetType, targetId: string): void {
  if (!targetId || targetId.length > 160) throw new Error("DIRECTOR_FOCUS_TARGET_INVALID");
  if (["project", "delivery", "memory"].includes(targetType)) {
    if (targetId !== project.project_id) throw new Error("DIRECTOR_FOCUS_TARGET_INVALID");
    return;
  }
  if (targetType === "shot") {
    const shot = getShot(db, targetId);
    if (!shot || shot.project_id !== project.project_id) throw new Error("DIRECTOR_FOCUS_TARGET_INVALID");
    return;
  }
  if (targetType === "artifact") {
    const artifact = getMediaArtifact(db, targetId);
    if (!artifact || artifact.linked_objects.project_id !== project.project_id || artifact.status !== "active") {
      throw new Error("DIRECTOR_FOCUS_TARGET_INVALID");
    }
    return;
  }
  if (targetType === "generation_run") {
    const run = getGenerationRun(db, targetId);
    if (!run || run.project_id !== project.project_id) throw new Error("DIRECTOR_FOCUS_TARGET_INVALID");
    return;
  }
  if (targetType === "storyboard_package") {
    const row = db.prepare("SELECT 1 FROM storyboard_packages WHERE storyboard_package_id = ? AND project_id = ?")
      .get(targetId, project.project_id);
    if (!row || project.active_storyboard_package_id !== targetId) throw new Error("DIRECTOR_FOCUS_TARGET_INVALID");
    return;
  }
  throw new Error("DIRECTOR_FOCUS_TARGET_INVALID");
}

function proposalStatus(db: M0Database, proposal: DirectorProposal, now: Date): Pick<DirectorProposalQueueItem, "status" | "reason_code" | "updated_at" | "action_allowed" | "action_blocked_code"> {
  const event = latestProposalEvent(db, proposal.proposal_id);
  const statusByEvent: Record<string, DirectorProposalQueueItem["status"]> = {
    submitted: "pending_review", imported: "pending_review", accepted: "accepted", rejected: "rejected", withdrawn: "withdrawn", compiled: "compiled"
  };
  const base = statusByEvent[event?.event_type ?? "submitted"] ?? "pending_review";
  if (base !== "pending_review") {
    return { status: base, reason_code: event?.reason_code ?? null, updated_at: event?.created_at ?? proposal.created_at, action_allowed: false, action_blocked_code: "DIRECTOR_PROPOSAL_NOT_PENDING" };
  }
  if (!proposalPrincipalIsActiveMember(db, proposal)) {
    return { status: "stale", reason_code: "DIRECTOR_PROPOSAL_PRINCIPAL_INACTIVE", updated_at: event?.created_at ?? proposal.created_at, action_allowed: false, action_blocked_code: "DIRECTOR_PROPOSAL_PRINCIPAL_INACTIVE" };
  }
  const focus = db.prepare(`SELECT focus_id, workspace_id, principal_id, project_id, target_type, target_id,
      generation, supersedes_focus_id, created_at, expires_at FROM director_focuses WHERE focus_id = ?`)
    .get(proposal.focus_id) as StoredFocusRow | undefined;
  if (!focus) return { status: "stale", reason_code: "DIRECTOR_FOCUS_NOT_FOUND", updated_at: event?.created_at ?? proposal.created_at, action_allowed: false, action_blocked_code: "DIRECTOR_FOCUS_STALE" };
  const parsedFocus = storedFocus(focus);
  const current = latestFocus(db, proposal.principal_id);
  if (focusTerminal(db, parsedFocus.focus_id) || Date.parse(parsedFocus.expires_at) <= now.getTime()
    || current?.focus_id !== parsedFocus.focus_id || current.generation !== parsedFocus.generation) {
    return { status: "stale", reason_code: "DIRECTOR_FOCUS_STALE", updated_at: event?.created_at ?? proposal.created_at, action_allowed: false, action_blocked_code: "DIRECTOR_FOCUS_STALE" };
  }
  return { status: "pending_review", reason_code: event?.reason_code ?? null, updated_at: event?.created_at ?? proposal.created_at, action_allowed: true, action_blocked_code: null };
}

function queueItem(db: M0Database, row: StoredProposalRow, now: Date): DirectorProposalQueueItem {
  const proposal = storedProposal(row);
  return {
    proposal_id: proposal.proposal_id,
    project_id: proposal.project_id,
    target_type: proposal.target_type,
    target_id: proposal.target_id,
    focus_id: proposal.focus_id,
    focus_generation: proposal.focus_generation,
    kind: proposal.kind,
    source: proposal.source,
    created_at: proposal.created_at,
    base_state_hash: proposal.base_state_hash,
    payload_hash: proposal.payload_hash,
    payload: proposal.payload,
    ...proposalStatus(db, proposal, now)
  };
}

export function getDirectorApprovalTower(projectId: string, db: M0Database, now = () => new Date()): DirectorApprovalResult<DirectorApprovalTower> {
  const project = projectIsWritableDirectorProject(db, projectId);
  if (!project) return error("DIRECTOR_PROJECT_NOT_AVAILABLE", "Director controls require an active production project.", "project_id");
  const principal = ownerState(db, projectId);
  const focus = principal.principal_id ? latestFocus(db, principal.principal_id) : null;
  const observedAt = now();
  const focusState = !focus ? "no_focus" : focusTerminal(db, focus.focus_id) || Date.parse(focus.expires_at) <= observedAt.getTime() ? "focus_expired" : "active";
  const rows = db.prepare(`SELECT proposal_id, workspace_id, principal_id, project_id, target_type, target_id, focus_id,
      focus_generation, schema_version, kind, base_state_hash, payload_json, payload_hash, parent_proposal_id,
      idempotency_key, source, created_at FROM director_proposals WHERE project_id = ?
      ORDER BY created_at DESC, proposal_id DESC LIMIT 100`).all(projectId) as StoredProposalRow[];
  try {
    return {
      ok: true,
      data: {
        project_id: project.project_id,
        principal_state: principal.state,
        focus: { state: focusState, focus: focus && focusState === "active" ? publicFocus(focus) : null },
        proposals: rows.map((row) => queueItem(db, row, observedAt))
      }
    };
  } catch {
    return error("DIRECTOR_APPROVAL_DATA_INTEGRITY_VIOLATION", "Director approval data is invalid.");
  }
}

export function createDirectorWorkbenchFocus(
  input: { project_id: string; target_type: DirectorFocusTargetType; target_id: string; ttl_seconds?: number; human_confirmation: boolean },
  db: M0Database,
  now = () => new Date()
): DirectorApprovalResult<{ focus: Omit<DirectorFocus, "workspace_id" | "principal_id"> }> {
  if (input.human_confirmation !== true) return error("DIRECTOR_FOCUS_CONFIRMATION_REQUIRED", "Human confirmation is required to change ChatGPT Director Focus.");
  const project = projectIsWritableDirectorProject(db, input.project_id);
  if (!project) return error("DIRECTOR_PROJECT_NOT_AVAILABLE", "Director controls require an active production project.", "project_id");
  const principal = ownerState(db, project.project_id);
  if (!principal.principal_id) return error("DIRECTOR_PRINCIPAL_SELECTION_REQUIRED", "Exactly one active issuer-bound project owner is required before creating a Director Focus.");
  const ttl = input.ttl_seconds === undefined ? DEFAULT_FOCUS_TTL_SECONDS : Math.trunc(input.ttl_seconds);
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > MAX_FOCUS_TTL_SECONDS) return error("DIRECTOR_FOCUS_TTL_INVALID", "Director Focus TTL is outside the allowed bound.", "ttl_seconds");
  try { assertFocusTarget(db, project, input.target_type, input.target_id); }
  catch { return error("DIRECTOR_FOCUS_TARGET_INVALID", "Director Focus target is not bound to the selected project.", "target_id"); }

  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-check mutable authorization and target facts after taking the writer
    // lock. The read before BEGIN only gives the UI a quick failure; it cannot
    // authorize a Focus if another local action archived the project, changed
    // its owners, or rebound the target in between.
    const lockedProject = projectIsWritableDirectorProject(db, input.project_id);
    if (!lockedProject) abortDecision("DIRECTOR_PROJECT_NOT_AVAILABLE", "Director controls require an active production project.", "project_id");
    const lockedOwner = ownerState(db, lockedProject.project_id);
    if (!lockedOwner.principal_id) abortDecision("DIRECTOR_PRINCIPAL_SELECTION_REQUIRED", "Exactly one active issuer-bound project owner is required before creating a Director Focus.");
    try { assertFocusTarget(db, lockedProject, input.target_type, input.target_id); }
    catch { abortDecision("DIRECTOR_FOCUS_TARGET_INVALID", "Director Focus target is not bound to the selected project.", "target_id"); }

    // Allocate the generation while holding the writer lock. Two Workbench tabs
    // must not create the same generation or leave two actionable Focuses for
    // one principal.
    const previous = latestFocus(db, lockedOwner.principal_id);
    const currentTime = now();
    const createdAt = currentTime.toISOString();
    const focus = DIRECTOR_FOCUS_SCHEMA.parse({
      focus_id: `director_focus_${randomUUID()}`,
      workspace_id: WORKSPACE_ID,
      principal_id: lockedOwner.principal_id,
      project_id: lockedProject.project_id,
      target_type: input.target_type,
      target_id: input.target_id,
      generation: (previous?.generation ?? 0) + 1,
      // The schema deliberately forbids a cross-project supersession reference.
      // We still terminally supersede the previous principal focus below, but only
      // retain a lineage link when both Focuses belong to the same project.
      supersedes_focus_id: previous?.project_id === lockedProject.project_id ? previous.focus_id : null,
      created_at: createdAt,
      expires_at: new Date(currentTime.getTime() + ttl * 1000).toISOString()
    });
    if (previous && !focusTerminal(db, previous.focus_id)) {
      db.prepare(`INSERT INTO director_focus_events (event_id, focus_id, event_type, reason_code, created_at)
        VALUES (?, ?, 'superseded', 'DIRECTOR_HUMAN_FOCUS_CHANGED', ?)`)
        .run(`director_focus_event_${randomUUID()}`, previous.focus_id, createdAt);
    }
    db.prepare(`INSERT INTO director_focuses
      (focus_id, workspace_id, principal_id, project_id, target_type, target_id, generation, supersedes_focus_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(focus.focus_id, focus.workspace_id, focus.principal_id, focus.project_id, focus.target_type, focus.target_id,
        focus.generation, focus.supersedes_focus_id, focus.created_at, focus.expires_at);
    db.prepare(`INSERT INTO director_focus_events (event_id, focus_id, event_type, reason_code, created_at)
      VALUES (?, ?, 'created', 'DIRECTOR_HUMAN_FOCUS_CREATED', ?)`)
      .run(`director_focus_event_${randomUUID()}`, focus.focus_id, focus.created_at);
    db.exec("COMMIT");
    return { ok: true, data: { focus: publicFocus(focus) } };
  } catch (caught) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    if (caught instanceof DirectorApprovalAbort) return { ok: false, error: caught.approvalError };
    return error("DIRECTOR_FOCUS_CREATE_FAILED", "Director Focus could not be created.");
  }
}

export function decideDirectorProposal(
  input: { proposal_id: string; decision: DirectorApprovalDecision; reason_code?: string; human_confirmation: boolean },
  db: M0Database,
  now = () => new Date()
): DirectorApprovalResult<{ proposal: DirectorProposalQueueItem }> {
  if (input.human_confirmation !== true) return error("DIRECTOR_PROPOSAL_CONFIRMATION_REQUIRED", "Human confirmation is required for a Director Proposal decision.");
  const reason = input.decision === "accept" ? "DIRECTOR_HUMAN_ACCEPTED" : (input.reason_code ?? "DIRECTOR_HUMAN_REJECTED").trim();
  if (!/^[A-Z0-9_]{3,64}$/.test(reason)) return error("DIRECTOR_PROPOSAL_REASON_INVALID", "Proposal rejection reason must be a stable code.", "reason_code");
  const eventType = input.decision === "accept" ? "accepted" : "rejected";
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const row = db.prepare(`SELECT proposal_id, workspace_id, principal_id, project_id, target_type, target_id, focus_id,
        focus_generation, schema_version, kind, base_state_hash, payload_json, payload_hash, parent_proposal_id,
        idempotency_key, source, created_at FROM director_proposals WHERE proposal_id = ?`).get(input.proposal_id) as StoredProposalRow | undefined;
    if (!row) abortDecision("DIRECTOR_PROPOSAL_NOT_FOUND", "Director Proposal was not found.", "proposal_id");
    let proposal: DirectorProposal;
    try { proposal = storedProposal(row); }
    catch { abortDecision("DIRECTOR_APPROVAL_DATA_INTEGRITY_VIOLATION", "Director Proposal is malformed."); }
    if (!projectIsWritableDirectorProject(db, proposal.project_id)) {
      abortDecision("DIRECTOR_PROJECT_NOT_AVAILABLE", "Director controls require an active production project.", "project_id");
    }
    let state: Pick<DirectorProposalQueueItem, "status" | "reason_code" | "updated_at" | "action_allowed" | "action_blocked_code">;
    try { state = proposalStatus(db, proposal, now()); }
    catch { abortDecision("DIRECTOR_APPROVAL_DATA_INTEGRITY_VIOLATION", "Director Proposal state is malformed."); }
    if (state.status !== "pending_review" || !state.action_allowed) {
      abortDecision(state.action_blocked_code ?? "DIRECTOR_PROPOSAL_NOT_PENDING", "Director Proposal cannot be decided in its current state.");
    }
    const focusRow = db.prepare(`SELECT focus_id, workspace_id, principal_id, project_id, target_type, target_id,
        generation, supersedes_focus_id, created_at, expires_at FROM director_focuses WHERE focus_id = ?`).get(proposal.focus_id) as StoredFocusRow | undefined;
    if (!focusRow) abortDecision("DIRECTOR_FOCUS_STALE", "Director Focus is no longer available.");
    let focus: DirectorFocus;
    try { focus = storedFocus(focusRow); }
    catch { abortDecision("DIRECTOR_APPROVAL_DATA_INTEGRITY_VIOLATION", "Director Focus is malformed."); }
    if (input.decision === "accept") {
      try {
        const current = buildDirectorContext(db, focus, proposal.kind, "full");
        validateDirectorProposalAgainstTargetState(proposal, current.targetState);
      } catch {
        abortDecision("DIRECTOR_PROPOSAL_STALE", "Director Proposal no longer matches the authoritative project state.");
      }
    }
    const createdAt = isoNow(now);
    db.prepare(`INSERT INTO director_proposal_events (event_id, proposal_id, event_type, reason_code, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(`director_proposal_event_${randomUUID()}`, proposal.proposal_id, eventType, reason, createdAt);
    const updated = queueItem(db, row, now());
    db.exec("COMMIT");
    transactionOpen = false;
    return { ok: true, data: { proposal: updated } };
  } catch (caught) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    }
    if (caught instanceof DirectorApprovalAbort) {
      return { ok: false, error: caught.approvalError };
    }
    return error("DIRECTOR_PROPOSAL_DECISION_FAILED", "Director Proposal decision could not be recorded.");
  }
}
