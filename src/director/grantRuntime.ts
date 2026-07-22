import { randomUUID } from "node:crypto";

import {
  DIRECTOR_FOCUS_SCHEMA,
  DIRECTOR_PROPOSAL_SCHEMA,
  validateDirectorAutomationGrant,
  validateDirectorProposalAgainstTargetState,
  type DirectorAutomationGrant,
  type DirectorFocus,
  type DirectorProposal
} from "./domain.js";
import { buildDirectorContext } from "./localService.js";
import type { M0Database } from "../storage/sqlite.js";
import { getShot, type Shot } from "../tools/projects.js";

const WORKSPACE_ID = "jenn-ai-video-workspace";

export interface DirectorAutomationLink {
  grant_id: string;
  reservation_id: string;
  proposal_id: string;
  policy_hash: string;
  /** Persisted only after reservation, so release/consume use the exact ledger amount. */
  amount_minor?: number;
}

export interface DirectorGrantAuthorization {
  grant: DirectorAutomationGrant;
  proposal: Extract<DirectorProposal, { kind: "generation_plan" | "clip_regeneration" }>;
  focus: DirectorFocus;
  shot: Shot;
}

export class DirectorGrantRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DirectorGrantRuntimeError";
  }
}

interface ProposalRow {
  proposal_id: string;
  workspace_id: string;
  principal_id: string;
  project_id: string;
  target_type: DirectorProposal["target_type"];
  target_id: string;
  focus_id: string;
  focus_generation: number;
  schema_version: "director-domain-v1";
  kind: DirectorProposal["kind"];
  base_state_hash: string;
  payload_json: string;
  payload_hash: string;
  parent_proposal_id: string | null;
  idempotency_key: string;
  source: DirectorProposal["source"];
  created_at: string;
}

interface GrantRow {
  grant_id: string;
  workspace_id: string;
  principal_id: string;
  project_id: string;
  provider: "runninghub";
  allowed_actions_json: string;
  currency: string;
  max_total_minor: number;
  max_per_run_minor: number;
  max_versions_per_shot: number;
  max_automatic_retries: number;
  pricing_contract_version: string;
  capability_contract_version: string;
  starts_at: string;
  expires_at: string;
  policy_hash: string;
  created_at: string;
}

interface FocusRow {
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

function proposalFromRow(row: ProposalRow): DirectorProposal {
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); }
  catch { throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_DATA_INTEGRITY_VIOLATION", "Director Proposal payload is malformed."); }
  const { payload_json: _payloadJson, ...fields } = row;
  try { return DIRECTOR_PROPOSAL_SCHEMA.parse({ ...fields, focus_generation: Number(row.focus_generation), payload }); }
  catch { throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_DATA_INTEGRITY_VIOLATION", "Director Proposal is malformed."); }
}

function grantFromRow(row: GrantRow): DirectorAutomationGrant {
  let allowedActions: unknown;
  try { allowedActions = JSON.parse(row.allowed_actions_json); }
  catch { throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_DATA_INTEGRITY_VIOLATION", "Automation Grant action list is malformed."); }
  try {
    return validateDirectorAutomationGrant({
      grant_id: row.grant_id, workspace_id: row.workspace_id, principal_id: row.principal_id, project_id: row.project_id,
      provider: row.provider, allowed_actions: allowedActions, currency: row.currency, max_total_minor: Number(row.max_total_minor),
      max_per_run_minor: Number(row.max_per_run_minor), max_versions_per_shot: Number(row.max_versions_per_shot),
      max_automatic_retries: Number(row.max_automatic_retries), pricing_contract_version: row.pricing_contract_version,
      capability_contract_version: row.capability_contract_version, starts_at: row.starts_at, expires_at: row.expires_at,
      policy_hash: row.policy_hash, created_at: row.created_at
    });
  } catch {
    throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_DATA_INTEGRITY_VIOLATION", "Automation Grant is malformed.");
  }
}

function focusFromRow(row: FocusRow): DirectorFocus {
  try { return DIRECTOR_FOCUS_SCHEMA.parse({ ...row, generation: Number(row.generation) }); }
  catch { throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_DATA_INTEGRITY_VIOLATION", "Director Focus is malformed."); }
}

function activeSoleOwner(db: M0Database, grant: DirectorAutomationGrant): boolean {
  const owners = db.prepare(`SELECT DISTINCT m.principal_id
    FROM webgpt_project_memberships m
    JOIN webgpt_auth_principals p ON p.workspace_id = m.workspace_id AND p.principal_id = m.principal_id
    JOIN webgpt_auth_principal_bindings b ON b.workspace_id = m.workspace_id AND b.principal_id = m.principal_id
    WHERE m.workspace_id = ? AND m.project_id = ? AND m.role = 'owner' AND m.status = 'active' AND p.status = 'active'
    ORDER BY m.principal_id`).all(WORKSPACE_ID, grant.project_id) as Array<{ principal_id: string }>;
  return owners.length === 1 && owners[0]?.principal_id === grant.principal_id;
}

function projectIsActiveProduction(db: M0Database, projectId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM workbench_project_meta
    WHERE project_id = ? AND classification = 'production' AND lifecycle = 'active'`).get(projectId));
}

function focusIsCurrent(db: M0Database, grant: DirectorAutomationGrant, focus: DirectorFocus, now: Date): boolean {
  if (focus.workspace_id !== WORKSPACE_ID || focus.principal_id !== grant.principal_id || focus.project_id !== grant.project_id
    || Date.parse(focus.expires_at) <= now.getTime()) return false;
  const terminal = db.prepare(`SELECT 1 FROM director_focus_events
    WHERE focus_id = ? AND event_type IN ('revoked', 'superseded') LIMIT 1`).get(focus.focus_id);
  if (terminal) return false;
  const latest = db.prepare(`SELECT focus_id, generation FROM director_focuses
    WHERE workspace_id = ? AND principal_id = ? ORDER BY generation DESC LIMIT 1`)
    .get(WORKSPACE_ID, grant.principal_id) as { focus_id: string; generation: number } | undefined;
  return latest?.focus_id === focus.focus_id && Number(latest.generation) === focus.generation;
}

export function loadDirectorGrantAuthorization(
  db: M0Database,
  link: Pick<DirectorAutomationLink, "grant_id" | "proposal_id" | "policy_hash">,
  action: DirectorAutomationGrant["allowed_actions"][number],
  now = new Date(),
  options: { verify_target_state?: boolean } = {}
): DirectorGrantAuthorization {
  const row = db.prepare(`SELECT
      g.grant_id, g.workspace_id AS grant_workspace_id, g.principal_id AS grant_principal_id, g.project_id AS grant_project_id,
      g.provider, g.allowed_actions_json, g.currency, g.max_total_minor, g.max_per_run_minor, g.max_versions_per_shot,
      g.max_automatic_retries, g.pricing_contract_version, g.capability_contract_version, g.starts_at, g.expires_at, g.policy_hash, g.created_at AS grant_created_at,
      p.proposal_id, p.workspace_id AS proposal_workspace_id, p.principal_id AS proposal_principal_id, p.project_id AS proposal_project_id,
      p.target_type, p.target_id, p.focus_id, p.focus_generation, p.schema_version, p.kind, p.base_state_hash,
      p.payload_json, p.payload_hash, p.parent_proposal_id, p.idempotency_key, p.source, p.created_at AS proposal_created_at
    FROM director_automation_grants g
    JOIN director_proposal_events e ON e.receipt_type = 'director_automation_grant' AND e.receipt_id = g.grant_id AND e.event_type = 'compiled'
    JOIN director_proposals p ON p.proposal_id = e.proposal_id
    WHERE g.grant_id = ? AND p.proposal_id = ?
    ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`).get(link.grant_id, link.proposal_id) as Record<string, unknown> | undefined;
  if (!row) throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_GRANT_NOT_FOUND", "Automation Grant is not bound to the requested Proposal.");
  const grant = grantFromRow({
    grant_id: String(row.grant_id), workspace_id: String(row.grant_workspace_id), principal_id: String(row.grant_principal_id),
    project_id: String(row.grant_project_id), provider: row.provider as "runninghub", allowed_actions_json: String(row.allowed_actions_json),
    currency: String(row.currency), max_total_minor: Number(row.max_total_minor), max_per_run_minor: Number(row.max_per_run_minor),
    max_versions_per_shot: Number(row.max_versions_per_shot), max_automatic_retries: Number(row.max_automatic_retries),
    pricing_contract_version: String(row.pricing_contract_version), capability_contract_version: String(row.capability_contract_version),
    starts_at: String(row.starts_at), expires_at: String(row.expires_at), policy_hash: String(row.policy_hash), created_at: String(row.grant_created_at)
  });
  const proposal = proposalFromRow({
    proposal_id: String(row.proposal_id), workspace_id: String(row.proposal_workspace_id), principal_id: String(row.proposal_principal_id),
    project_id: String(row.proposal_project_id), target_type: row.target_type as DirectorProposal["target_type"], target_id: String(row.target_id),
    focus_id: String(row.focus_id), focus_generation: Number(row.focus_generation), schema_version: row.schema_version as "director-domain-v1",
    kind: row.kind as DirectorProposal["kind"], base_state_hash: String(row.base_state_hash), payload_json: String(row.payload_json),
    payload_hash: String(row.payload_hash), parent_proposal_id: row.parent_proposal_id === null ? null : String(row.parent_proposal_id),
    idempotency_key: String(row.idempotency_key), source: row.source as DirectorProposal["source"], created_at: String(row.proposal_created_at)
  });
  if (grant.policy_hash !== link.policy_hash || grant.workspace_id !== WORKSPACE_ID || grant.principal_id !== proposal.principal_id || grant.project_id !== proposal.project_id) {
    throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_GRANT_BINDING_MISMATCH", "Automation Grant binding no longer matches its Proposal.");
  }
  if (proposal.kind !== "generation_plan" && proposal.kind !== "clip_regeneration") {
    throw new DirectorGrantRuntimeError("DIRECTOR_PROPOSAL_KIND_NOT_AUTOMATABLE", "Proposal kind cannot be executed by the bounded orchestrator.");
  }
  if (!grant.allowed_actions.includes(action)) throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_ACTION_DENIED", "Automation Grant does not allow this action.");
  if (Date.parse(grant.starts_at) > now.getTime() || Date.parse(grant.expires_at) <= now.getTime()) {
    throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_GRANT_EXPIRED", "Automation Grant is not currently active.");
  }
  if (!projectIsActiveProduction(db, grant.project_id)) throw new DirectorGrantRuntimeError("DIRECTOR_PROJECT_NOT_AVAILABLE", "Automation Grant project is not active production.");
  if (!activeSoleOwner(db, grant)) throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_OWNER_REQUIRED", "Automation Grant no longer has its active sole owner.");
  const focusRow = db.prepare(`SELECT focus_id, workspace_id, principal_id, project_id, target_type, target_id,
    generation, supersedes_focus_id, created_at, expires_at FROM director_focuses WHERE focus_id = ?`).get(proposal.focus_id) as FocusRow | undefined;
  if (!focusRow) throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_DATA_INTEGRITY_VIOLATION", "Automation Grant Proposal has no Focus evidence.");
  const focus = focusFromRow(focusRow);
  if (!focusIsCurrent(db, grant, focus, now)) {
    throw new DirectorGrantRuntimeError("DIRECTOR_FOCUS_STALE", "Automation Grant Focus is no longer current.");
  }
  if (options.verify_target_state !== false) {
    try { validateDirectorProposalAgainstTargetState(proposal, buildDirectorContext(db, focus, proposal.kind, "full").targetState); }
    catch { throw new DirectorGrantRuntimeError("DIRECTOR_PROPOSAL_STALE", "Automation Grant Proposal no longer matches authoritative project state."); }
  }
  const shot = getShot(db, proposal.payload.shot_id);
  if (!shot || shot.project_id !== grant.project_id || shot.clip_versions.length >= grant.max_versions_per_shot) {
    throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_VERSION_LIMIT_REACHED", "Automation Grant cannot create another version for this SHOT.");
  }
  return { grant, proposal, focus, shot };
}

function allocation(db: M0Database, grantId: string): { reserved: number; consumed: number } {
  const rows = db.prepare(`SELECT event_type, amount_minor FROM director_automation_grant_events
    WHERE grant_id = ? ORDER BY created_at, rowid`).all(grantId) as Array<{ event_type: string; amount_minor: number }>;
  let reserved = 0;
  let consumed = 0;
  for (const row of rows) {
    if (row.event_type === "reserve") reserved += Number(row.amount_minor);
    if (row.event_type === "release") reserved -= Number(row.amount_minor);
    if (row.event_type === "consume") { reserved -= Number(row.amount_minor); consumed += Number(row.amount_minor); }
  }
  return { reserved: Math.max(0, reserved), consumed: Math.max(0, consumed) };
}

export function reserveDirectorGrant(
  db: M0Database,
  authorization: DirectorGrantAuthorization,
  input: { amount_minor: number; currency: string; intent_id: string; run_id: string; now?: Date }
): DirectorAutomationLink {
  if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor <= 0 || input.amount_minor > authorization.grant.max_per_run_minor
    || input.currency !== authorization.grant.currency) {
    throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_BUDGET_DENIED", "Requested execution is outside the Automation Grant per-run budget.");
  }
  const current = allocation(db, authorization.grant.grant_id);
  if (current.consumed + current.reserved + input.amount_minor > authorization.grant.max_total_minor) {
    throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_BUDGET_EXHAUSTED", "Automation Grant total budget is exhausted.");
  }
  const reservationId = `director_reservation_${randomUUID()}`;
  const createdAt = (input.now ?? new Date()).toISOString();
  db.prepare(`INSERT INTO director_automation_grant_events
    (event_id, grant_id, event_type, reservation_id, amount_minor, currency, intent_id, run_id, reason_code, created_at)
    VALUES (?, ?, 'reserve', ?, ?, ?, ?, ?, 'DIRECTOR_AUTOMATION_RESERVED', ?)`)
    .run(`director_grant_event_${randomUUID()}`, authorization.grant.grant_id, reservationId, input.amount_minor, input.currency, input.intent_id, input.run_id, createdAt);
  return { grant_id: authorization.grant.grant_id, reservation_id: reservationId, proposal_id: authorization.proposal.proposal_id, policy_hash: authorization.grant.policy_hash };
}

export function consumeDirectorGrantReservation(db: M0Database, link: DirectorAutomationLink, input: { amount_minor: number; currency: string; intent_id: string; run_id: string; now?: Date }): void {
  // This records a Provider submission that has already succeeded. Do not
  // re-run live owner/expiry checks here: a grant may legitimately expire in
  // flight, but its earlier immutable reservation must still become spend.
  const grant = db.prepare("SELECT policy_hash FROM director_automation_grants WHERE grant_id = ?")
    .get(link.grant_id) as { policy_hash: string } | undefined;
  if (!grant || grant.policy_hash !== link.policy_hash) {
    throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_GRANT_BINDING_MISMATCH", "Automation Grant reservation no longer matches its immutable policy.");
  }
  const active = db.prepare(`SELECT event_type, amount_minor, currency, intent_id, run_id FROM director_automation_grant_events
    WHERE grant_id = ? AND reservation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(link.grant_id, link.reservation_id) as { event_type: string; amount_minor: number; currency: string; intent_id: string; run_id: string } | undefined;
  if (!active || active.event_type !== "reserve" || Number(active.amount_minor) !== input.amount_minor || active.currency !== input.currency
    || active.intent_id !== input.intent_id || active.run_id !== input.run_id) {
    throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_RESERVATION_INVALID", "Automation Grant reservation is not active for this execution.");
  }
  db.prepare(`INSERT INTO director_automation_grant_events
    (event_id, grant_id, event_type, reservation_id, amount_minor, currency, intent_id, run_id, reason_code, created_at)
    VALUES (?, ?, 'consume', ?, ?, ?, ?, ?, 'DIRECTOR_AUTOMATION_SUBMITTED', ?)`)
    .run(`director_grant_event_${randomUUID()}`, link.grant_id, link.reservation_id, input.amount_minor, input.currency, input.intent_id, input.run_id, (input.now ?? new Date()).toISOString());
}

export function releaseDirectorGrantReservation(db: M0Database, link: DirectorAutomationLink, input: { amount_minor: number; currency: string; intent_id: string; run_id: string; reason_code: string; now?: Date }): void {
  if (!/^[A-Z0-9_]{3,64}$/.test(input.reason_code)) throw new DirectorGrantRuntimeError("DIRECTOR_AUTOMATION_RELEASE_REASON_INVALID", "Automation Grant release reason is invalid.");
  const active = db.prepare(`SELECT event_type, amount_minor, currency, intent_id, run_id FROM director_automation_grant_events
    WHERE grant_id = ? AND reservation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(link.grant_id, link.reservation_id) as { event_type: string; amount_minor: number; currency: string; intent_id: string; run_id: string } | undefined;
  if (!active || active.event_type !== "reserve" || Number(active.amount_minor) !== input.amount_minor || active.currency !== input.currency
    || active.intent_id !== input.intent_id || active.run_id !== input.run_id) return;
  db.prepare(`INSERT INTO director_automation_grant_events
    (event_id, grant_id, event_type, reservation_id, amount_minor, currency, intent_id, run_id, reason_code, created_at)
    VALUES (?, ?, 'release', ?, ?, ?, ?, ?, ?, ?)`)
    .run(`director_grant_event_${randomUUID()}`, link.grant_id, link.reservation_id, input.amount_minor, input.currency, input.intent_id, input.run_id, input.reason_code, (input.now ?? new Date()).toISOString());
}
