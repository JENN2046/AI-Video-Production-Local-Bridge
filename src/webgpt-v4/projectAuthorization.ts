import type { M0Database } from "../storage/sqlite.js";
import { WEBGPT_AUTHORIZATION_WORKSPACE_ID } from "../storage/migrations.js";
import { WebGptV4Error } from "./types.js";

function requireIssuerHash(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{64}$/.test(value)) {
    throw new WebGptV4Error("WEBGPT_PRINCIPAL_NOT_REGISTERED", "This identity is not registered for the local workspace.");
  }
  return value;
}

export function assertWebGptPrincipalActive(db: M0Database, principalId: string, issuerHash: string | undefined): void {
  const expectedIssuerHash = requireIssuerHash(issuerHash);
  const row = db.prepare(`SELECT p.status FROM webgpt_auth_principals p
    JOIN webgpt_auth_principal_bindings b
      ON b.workspace_id = p.workspace_id AND b.principal_id = p.principal_id
    WHERE p.workspace_id = ? AND p.principal_id = ? AND b.issuer_hash = ?`)
    .get(WEBGPT_AUTHORIZATION_WORKSPACE_ID, principalId, expectedIssuerHash) as { status: string } | undefined;
  if (!row) throw new WebGptV4Error("WEBGPT_PRINCIPAL_NOT_REGISTERED", "This identity is not registered for the local workspace.");
  if (row.status !== "active") throw new WebGptV4Error("WEBGPT_PRINCIPAL_DISABLED", "This identity is disabled for the local workspace.");
}

export function authorizedWebGptProjectIds(db: M0Database, principalId: string, issuerHash: string | undefined): string[] {
  assertWebGptPrincipalActive(db, principalId, issuerHash);
  return (db.prepare(`SELECT m.project_id FROM webgpt_project_memberships m
    JOIN webgpt_auth_principal_bindings b ON b.workspace_id = m.workspace_id AND b.principal_id = m.principal_id
    JOIN workbench_project_meta p ON p.project_id = m.project_id AND p.classification = 'production'
    WHERE m.workspace_id = ? AND m.principal_id = ? AND b.issuer_hash = ? AND m.status = 'active'
    ORDER BY m.project_id`).all(WEBGPT_AUTHORIZATION_WORKSPACE_ID, principalId, requireIssuerHash(issuerHash)) as Array<{ project_id: string }>).map((row) => row.project_id);
}

export function requireWebGptProjectReadAccess(db: M0Database, principalId: string, issuerHash: string | undefined, projectId: string): void {
  assertWebGptPrincipalActive(db, principalId, issuerHash);
  const row = db.prepare(`SELECT 1 FROM webgpt_project_memberships m
    JOIN webgpt_auth_principal_bindings b ON b.workspace_id = m.workspace_id AND b.principal_id = m.principal_id
    JOIN workbench_project_meta p ON p.project_id = m.project_id AND p.classification = 'production'
    WHERE m.workspace_id = ? AND m.principal_id = ? AND b.issuer_hash = ? AND m.project_id = ? AND m.status = 'active'`)
    .get(WEBGPT_AUTHORIZATION_WORKSPACE_ID, principalId, requireIssuerHash(issuerHash), projectId);
  if (!row) throw new WebGptV4Error("PROJECT_NOT_FOUND", "Production project was not found.", "project_id");
}

export function webGptProjectAuthorizationReady(db: M0Database, issuerHash: string | undefined): boolean {
  if (!issuerHash || !/^[0-9a-f]{64}$/.test(issuerHash)) return false;
  return Boolean(db.prepare(`SELECT 1 FROM webgpt_project_memberships m
    JOIN webgpt_auth_principals a ON a.workspace_id = m.workspace_id AND a.principal_id = m.principal_id
    JOIN webgpt_auth_principal_bindings b ON b.workspace_id = m.workspace_id AND b.principal_id = m.principal_id
    JOIN workbench_project_meta p ON p.project_id = m.project_id AND p.classification = 'production'
    WHERE m.workspace_id = ? AND b.issuer_hash = ? AND m.role = 'owner' AND m.status = 'active' AND a.status = 'active' LIMIT 1`)
    .get(WEBGPT_AUTHORIZATION_WORKSPACE_ID, issuerHash));
}
