import type { M0Database } from "../storage/sqlite.js";
import { WEBGPT_AUTHORIZATION_WORKSPACE_ID } from "../storage/migrations.js";
import { WebGptV4Error } from "./types.js";

export function assertWebGptPrincipalActive(db: M0Database, principalId: string): void {
  const row = db.prepare(`SELECT status FROM webgpt_auth_principals
    WHERE workspace_id = ? AND principal_id = ?`).get(WEBGPT_AUTHORIZATION_WORKSPACE_ID, principalId) as { status: string } | undefined;
  if (!row) throw new WebGptV4Error("WEBGPT_PRINCIPAL_NOT_REGISTERED", "This identity is not registered for the local workspace.");
  if (row.status !== "active") throw new WebGptV4Error("WEBGPT_PRINCIPAL_DISABLED", "This identity is disabled for the local workspace.");
}

export function authorizedWebGptProjectIds(db: M0Database, principalId: string): string[] {
  assertWebGptPrincipalActive(db, principalId);
  return (db.prepare(`SELECT m.project_id FROM webgpt_project_memberships m
    JOIN workbench_project_meta p ON p.project_id = m.project_id AND p.classification = 'production'
    WHERE m.workspace_id = ? AND m.principal_id = ? AND m.status = 'active'
    ORDER BY m.project_id`).all(WEBGPT_AUTHORIZATION_WORKSPACE_ID, principalId) as Array<{ project_id: string }>).map((row) => row.project_id);
}

export function requireWebGptProjectReadAccess(db: M0Database, principalId: string, projectId: string): void {
  assertWebGptPrincipalActive(db, principalId);
  const row = db.prepare(`SELECT 1 FROM webgpt_project_memberships m
    JOIN workbench_project_meta p ON p.project_id = m.project_id AND p.classification = 'production'
    WHERE m.workspace_id = ? AND m.principal_id = ? AND m.project_id = ? AND m.status = 'active'`)
    .get(WEBGPT_AUTHORIZATION_WORKSPACE_ID, principalId, projectId);
  if (!row) throw new WebGptV4Error("PROJECT_NOT_FOUND", "Production project was not found.", "project_id");
}

export function webGptProjectAuthorizationReady(db: M0Database): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM webgpt_project_memberships m
    JOIN webgpt_auth_principals a ON a.workspace_id = m.workspace_id AND a.principal_id = m.principal_id
    JOIN workbench_project_meta p ON p.project_id = m.project_id AND p.classification = 'production'
    WHERE m.workspace_id = ? AND m.role = 'owner' AND m.status = 'active' AND a.status = 'active' LIMIT 1`)
    .get(WEBGPT_AUTHORIZATION_WORKSPACE_ID));
}
