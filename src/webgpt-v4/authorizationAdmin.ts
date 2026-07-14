import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import type { M0Database } from "../storage/sqlite.js";
import { WEBGPT_AUTHORIZATION_WORKSPACE_ID } from "../storage/migrations.js";

export type WebGptProjectRole = "owner" | "viewer";
export type WebGptAuthAdminAction = "bootstrap-owner" | "register" | "grant" | "revoke" | "list";

export interface WebGptAuthAdminRequest {
  action: WebGptAuthAdminAction;
  database_path: string;
  principal_id?: string;
  project_id?: string;
  role?: WebGptProjectRole;
  reason_code?: string;
}

export class WebGptAuthAdminInputError extends Error {
  readonly code = "INVALID_WEBGPT_AUTH_ADMIN_INPUT";
}

const PRINCIPAL_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REASON_PATTERN = /^[A-Z0-9_]{1,64}$/;

function required(value: string | undefined, name: string): string {
  if (!value) throw new WebGptAuthAdminInputError(`${name} is required.`);
  return value;
}

function validatePrincipal(value: string | undefined): string {
  const principal = required(value, "--principal");
  if (!PRINCIPAL_PATTERN.test(principal)) throw new WebGptAuthAdminInputError("--principal must be a lowercase SHA-256 value.");
  return principal;
}

function validateProject(value: string | undefined): string {
  const project = required(value, "--project");
  if (!SAFE_ID_PATTERN.test(project)) throw new WebGptAuthAdminInputError("--project is invalid.");
  return project;
}

function validateReason(value: string | undefined): string {
  const reason = value ?? "LOCAL_ADMIN_APPROVED";
  if (!REASON_PATTERN.test(reason)) throw new WebGptAuthAdminInputError("--reason must be an uppercase stable code.");
  return reason;
}

export function parseWebGptAuthAdminArguments(argv: readonly string[]): WebGptAuthAdminRequest {
  const [actionRaw, ...rest] = argv;
  if (!(["bootstrap-owner", "register", "grant", "revoke", "list"] as const).includes(actionRaw as WebGptAuthAdminAction)) {
    throw new WebGptAuthAdminInputError("Action must be bootstrap-owner, register, grant, revoke, or list.");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new WebGptAuthAdminInputError(`Invalid argument ${key ?? "<missing>"}.`);
    if (values.has(key)) throw new WebGptAuthAdminInputError(`Duplicate argument ${key}.`);
    values.set(key, value);
  }
  const allowed = new Set(["--db", "--principal", "--project", "--role", "--reason"]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new WebGptAuthAdminInputError(`Unknown argument ${key}.`);
  const actionArguments: Record<WebGptAuthAdminAction, ReadonlySet<string>> = {
    "bootstrap-owner": new Set(["--db", "--principal", "--project", "--reason"]),
    register: new Set(["--db", "--principal", "--reason"]),
    grant: new Set(["--db", "--principal", "--project", "--role", "--reason"]),
    revoke: new Set(["--db", "--principal", "--project", "--reason"]),
    list: new Set(["--db"])
  };
  for (const key of values.keys()) {
    if (!actionArguments[actionRaw as WebGptAuthAdminAction].has(key)) {
      throw new WebGptAuthAdminInputError(`${key} is not valid for ${actionRaw}.`);
    }
  }
  const databaseValue = required(values.get("--db"), "--db");
  const databasePath = resolve(databaseValue);
  if (!isAbsolute(databasePath)) throw new WebGptAuthAdminInputError("--db must resolve to an absolute path.");
  const action = actionRaw as WebGptAuthAdminAction;
  const request: WebGptAuthAdminRequest = { action, database_path: databasePath };
  if (action !== "list") request.principal_id = validatePrincipal(values.get("--principal"));
  if (action === "bootstrap-owner" || action === "grant" || action === "revoke") request.project_id = validateProject(values.get("--project"));
  if (action === "grant") {
    const role = required(values.get("--role"), "--role");
    if (role !== "owner" && role !== "viewer") throw new WebGptAuthAdminInputError("--role must be owner or viewer.");
    request.role = role;
  }
  if (action !== "list") request.reason_code = validateReason(values.get("--reason"));
  return request;
}

function insertEvent(db: M0Database, input: {
  principal_id: string;
  project_id?: string;
  event_type: "principal_registered" | "membership_granted" | "membership_revoked";
  role?: WebGptProjectRole;
  reason_code: string;
}): void {
  db.prepare(`INSERT INTO webgpt_auth_events
    (event_id, workspace_id, principal_id, project_id, event_type, role, reason_code)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`auth_evt_${randomUUID()}`, WEBGPT_AUTHORIZATION_WORKSPACE_ID, input.principal_id,
      input.project_id ?? null, input.event_type, input.role ?? null, input.reason_code);
}

export function registerWebGptPrincipal(db: M0Database, principalId: string, reasonCode: string): { created: boolean } {
  if (!PRINCIPAL_PATTERN.test(principalId)) throw new WebGptAuthAdminInputError("Invalid principal.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`INSERT OR IGNORE INTO webgpt_auth_principals
      (workspace_id, principal_id) VALUES (?, ?)`).run(WEBGPT_AUTHORIZATION_WORKSPACE_ID, principalId) as { changes: number | bigint };
    const created = Number(result.changes) === 1;
    if (created) insertEvent(db, { principal_id: principalId, event_type: "principal_registered", reason_code: reasonCode });
    db.exec("COMMIT");
    return { created };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function bootstrapWebGptProjectOwner(db: M0Database, principalId: string, projectId: string, reasonCode: string): { principal_created: boolean; membership_created: boolean } {
  if (!PRINCIPAL_PATTERN.test(principalId)) throw new WebGptAuthAdminInputError("Invalid principal.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const project = db.prepare(`SELECT p.project_id FROM projects p
      JOIN workbench_project_meta m ON m.project_id = p.project_id
      WHERE p.project_id = ? AND m.classification = 'production'`).get(projectId);
    if (!project) throw new WebGptAuthAdminInputError("Project must exist and be classified as production.");
    const principalResult = db.prepare(`INSERT OR IGNORE INTO webgpt_auth_principals
      (workspace_id, principal_id) VALUES (?, ?)`).run(WEBGPT_AUTHORIZATION_WORKSPACE_ID, principalId) as { changes: number | bigint };
    const principalCreated = Number(principalResult.changes) === 1;
    const existing = db.prepare(`SELECT role, status FROM webgpt_project_memberships
      WHERE workspace_id = ? AND project_id = ? AND principal_id = ?`)
      .get(WEBGPT_AUTHORIZATION_WORKSPACE_ID, projectId, principalId) as { role: string; status: string } | undefined;
    if (existing && (existing.role !== "owner" || existing.status !== "active")) {
      throw new WebGptAuthAdminInputError("Bootstrap cannot replace an existing membership; use grant explicitly.");
    }
    const membershipCreated = !existing;
    if (principalCreated) insertEvent(db, { principal_id: principalId, event_type: "principal_registered", reason_code: reasonCode });
    if (membershipCreated) {
      db.prepare(`INSERT INTO webgpt_project_memberships
        (workspace_id, project_id, principal_id, role, status) VALUES (?, ?, ?, 'owner', 'active')`)
        .run(WEBGPT_AUTHORIZATION_WORKSPACE_ID, projectId, principalId);
      insertEvent(db, { principal_id: principalId, project_id: projectId, event_type: "membership_granted", role: "owner", reason_code: reasonCode });
    }
    db.exec("COMMIT");
    return { principal_created: principalCreated, membership_created: membershipCreated };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function grantWebGptProjectMembership(db: M0Database, principalId: string, projectId: string, role: WebGptProjectRole, reasonCode: string): { changed: boolean } {
  db.exec("BEGIN IMMEDIATE");
  try {
    const project = db.prepare(`SELECT p.project_id FROM projects p
      JOIN workbench_project_meta m ON m.project_id = p.project_id
      WHERE p.project_id = ? AND m.classification = 'production'`).get(projectId);
    if (!project) throw new WebGptAuthAdminInputError("Project must exist and be classified as production.");
    const principal = db.prepare(`SELECT 1 FROM webgpt_auth_principals
      WHERE workspace_id = ? AND principal_id = ? AND status = 'active'`)
      .get(WEBGPT_AUTHORIZATION_WORKSPACE_ID, principalId);
    if (!principal) throw new WebGptAuthAdminInputError("Principal is not registered and active.");
    const previous = db.prepare(`SELECT role, status FROM webgpt_project_memberships
      WHERE workspace_id = ? AND project_id = ? AND principal_id = ?`)
      .get(WEBGPT_AUTHORIZATION_WORKSPACE_ID, projectId, principalId) as { role: string; status: string } | undefined;
    const changed = previous?.role !== role || previous?.status !== "active";
    if (changed) {
      db.prepare(`INSERT INTO webgpt_project_memberships
        (workspace_id, project_id, principal_id, role, status) VALUES (?, ?, ?, ?, 'active')
        ON CONFLICT(workspace_id, project_id, principal_id) DO UPDATE SET
          role = excluded.role, status = 'active', updated_at = CURRENT_TIMESTAMP`)
        .run(WEBGPT_AUTHORIZATION_WORKSPACE_ID, projectId, principalId, role);
      insertEvent(db, { principal_id: principalId, project_id: projectId, event_type: "membership_granted", role, reason_code: reasonCode });
    }
    db.exec("COMMIT");
    return { changed };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function revokeWebGptProjectMembership(db: M0Database, principalId: string, projectId: string, reasonCode: string): { changed: boolean } {
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = db.prepare(`SELECT role, status FROM webgpt_project_memberships
      WHERE workspace_id = ? AND project_id = ? AND principal_id = ?`)
      .get(WEBGPT_AUTHORIZATION_WORKSPACE_ID, projectId, principalId) as { role: WebGptProjectRole; status: string } | undefined;
    const changed = Boolean(previous && previous.status === "active");
    if (changed && previous) {
      db.prepare(`UPDATE webgpt_project_memberships SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND project_id = ? AND principal_id = ?`)
        .run(WEBGPT_AUTHORIZATION_WORKSPACE_ID, projectId, principalId);
      insertEvent(db, { principal_id: principalId, project_id: projectId, event_type: "membership_revoked", role: previous.role, reason_code: reasonCode });
    }
    db.exec("COMMIT");
    return { changed };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listWebGptAuthorizationSummary(db: M0Database): { principals: number; active_memberships: number; revoked_memberships: number; events: number } {
  const count = (table: string, where = "") => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as { count: number }).count);
  return {
    principals: count("webgpt_auth_principals"),
    active_memberships: count("webgpt_project_memberships", "WHERE status = 'active'"),
    revoked_memberships: count("webgpt_project_memberships", "WHERE status = 'revoked'"),
    events: count("webgpt_auth_events")
  };
}
