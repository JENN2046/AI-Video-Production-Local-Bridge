import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { DATABASE_MIGRATIONS, assertSchemaCurrent, migrationChecksum, runDatabaseMigrations, WEBGPT_AUTHORIZATION_WORKSPACE_ID } from "../src/storage/migrations.js";
import { openM0Database } from "../src/storage/sqlite.js";
import {
  bootstrapWebGptProjectOwner,
  grantWebGptProjectMembership,
  listWebGptAuthorizationSummary,
  parseWebGptAuthAdminArguments,
  registerWebGptPrincipal,
  revokeWebGptProjectMembership,
  WebGptAuthAdminInputError
} from "../src/webgpt-v4/authorizationAdmin.js";

const PRINCIPAL = "a".repeat(64);

function createProductionProject(db: DatabaseSync, id = "project_auth_fixture"): void {
  const data = JSON.stringify({ project_id: id, title: "Authorization fixture", status: "draft", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
  db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)").run(id, data);
  db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(id);
}

test("migration 0007 creates constrained authorization tables and append-only events", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const result = runDatabaseMigrations(db);
    assert.equal(result.applied.at(-1), "0007");
    assertSchemaCurrent(db);
    createProductionProject(db);
    registerWebGptPrincipal(db, PRINCIPAL, "TEST_BOOTSTRAP");
    grantWebGptProjectMembership(db, PRINCIPAL, "project_auth_fixture", "owner", "TEST_GRANT");
    const event = db.prepare("SELECT event_id FROM webgpt_auth_events WHERE event_type = 'membership_granted'").get() as { event_id: string };
    assert.throws(() => db.prepare("UPDATE webgpt_auth_events SET reason_code = 'TAMPERED' WHERE event_id = ?").run(event.event_id), /WEBGPT_AUTH_EVENTS_APPEND_ONLY/);
    assert.throws(() => db.prepare("DELETE FROM webgpt_auth_events WHERE event_id = ?").run(event.event_id), /WEBGPT_AUTH_EVENTS_APPEND_ONLY/);
  } finally {
    db.close();
  }
});

test("schema validation rejects authorization trigger and constraint drift", () => {
  const triggerDb = new DatabaseSync(":memory:");
  try {
    runDatabaseMigrations(triggerDb);
    triggerDb.exec("DROP TRIGGER webgpt_auth_events_no_delete");
    assert.throws(() => assertSchemaCurrent(triggerDb), /missing_trigger:webgpt_auth_events_no_delete/);
  } finally {
    triggerDb.close();
  }
  const constraintDb = new DatabaseSync(":memory:");
  try {
    runDatabaseMigrations(constraintDb);
    constraintDb.exec("ALTER TABLE webgpt_project_memberships RENAME TO webgpt_project_memberships_canonical");
    constraintDb.exec(`CREATE TABLE webgpt_project_memberships (
      workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (workspace_id, project_id, principal_id),
      FOREIGN KEY (project_id) REFERENCES projects(project_id), CHECK (role IN ('owner','viewer')),
      CHECK (status IN ('active','revoked')))`);
    assert.throws(() => assertSchemaCurrent(constraintDb), /check_constraints:webgpt_project_memberships|foreign_keys:webgpt_project_memberships/);
  } finally {
    constraintDb.close();
  }
});

test("an existing 0006 database applies only 0007", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of DATABASE_MIGRATIONS.slice(0, 6)) migration.apply(db);
    db.exec(`CREATE TABLE schema_migrations (
      migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    for (const migration of DATABASE_MIGRATIONS.slice(0, 6)) {
      db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)")
        .run(migration.id, migration.name, migrationChecksum(migration));
    }
    assert.deepEqual(runDatabaseMigrations(db).applied, ["0007"]);
    assertSchemaCurrent(db);
  } finally {
    db.close();
  }
});

test("admin parser requires an explicit database and rejects raw identity-shaped inputs", () => {
  assert.throws(() => parseWebGptAuthAdminArguments(["list"]), WebGptAuthAdminInputError);
  assert.throws(() => parseWebGptAuthAdminArguments(["list", "--db", "fixture.sqlite", "--principal", PRINCIPAL]), /not valid for list/);
  assert.throws(() => parseWebGptAuthAdminArguments(["register", "--db", "fixture.sqlite", "--principal", "google-oauth2|user"]), /lowercase SHA-256/);
  const parsed = parseWebGptAuthAdminArguments(["register", "--db", "fixture.sqlite", "--principal", PRINCIPAL]);
  assert.equal(parsed.database_path.endsWith("fixture.sqlite"), true);
  assert.equal(parsed.reason_code, "LOCAL_ADMIN_APPROVED");
});

test("registration, grant and revoke are transactional, idempotent and production-only", () => {
  const db = openM0Database(":memory:");
  try {
    createProductionProject(db);
    const testData = JSON.stringify({ project_id: "project_test", title: "Test", status: "draft", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_test', ?)").run(testData);
    db.prepare("UPDATE workbench_project_meta SET classification = 'test' WHERE project_id = 'project_test'").run();

    assert.deepEqual(registerWebGptPrincipal(db, PRINCIPAL, "TEST_REGISTER"), { created: true });
    assert.deepEqual(registerWebGptPrincipal(db, PRINCIPAL, "TEST_REGISTER"), { created: false });
    assert.throws(() => grantWebGptProjectMembership(db, PRINCIPAL, "project_test", "viewer", "TEST_GRANT"), /classified as production/);
    assert.deepEqual(grantWebGptProjectMembership(db, PRINCIPAL, "project_auth_fixture", "viewer", "TEST_GRANT"), { changed: true });
    assert.deepEqual(grantWebGptProjectMembership(db, PRINCIPAL, "project_auth_fixture", "viewer", "TEST_GRANT"), { changed: false });
    assert.deepEqual(revokeWebGptProjectMembership(db, PRINCIPAL, "project_auth_fixture", "TEST_REVOKE"), { changed: true });
    assert.deepEqual(revokeWebGptProjectMembership(db, PRINCIPAL, "project_auth_fixture", "TEST_REVOKE"), { changed: false });
    assert.deepEqual(listWebGptAuthorizationSummary(db), { principals: 1, active_memberships: 0, revoked_memberships: 1, events: 3 });
    const stored = JSON.stringify(db.prepare("SELECT * FROM webgpt_auth_principals").all());
    assert.equal(stored.includes("google-oauth2"), false);
    assert.equal(stored.includes("@"), false);
    assert.equal((db.prepare("SELECT workspace_id FROM webgpt_auth_principals").get() as { workspace_id: string }).workspace_id, WEBGPT_AUTHORIZATION_WORKSPACE_ID);
  } finally {
    db.close();
  }
});

test("owner bootstrap atomically creates the principal and production membership", () => {
  const db = openM0Database(":memory:");
  try {
    createProductionProject(db);
    assert.deepEqual(bootstrapWebGptProjectOwner(db, PRINCIPAL, "project_auth_fixture", "TEST_BOOTSTRAP"), {
      principal_created: true,
      membership_created: true
    });
    assert.deepEqual(bootstrapWebGptProjectOwner(db, PRINCIPAL, "project_auth_fixture", "TEST_BOOTSTRAP"), {
      principal_created: false,
      membership_created: false
    });
    assert.deepEqual(listWebGptAuthorizationSummary(db), { principals: 1, active_memberships: 1, revoked_memberships: 0, events: 2 });
  } finally {
    db.close();
  }
});

test("admin opens only the explicitly selected migrated fixture database", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-auth-admin-"));
  try {
    const selected = join(root, "selected.sqlite");
    const db = new DatabaseSync(selected);
    runDatabaseMigrations(db);
    db.close();
    const parsed = parseWebGptAuthAdminArguments(["list", "--db", selected]);
    assert.equal(parsed.database_path, selected);
    const command = join(process.cwd(), "dist", "scripts", "webgpt-auth-admin.js");
    const success = spawnSync(process.execPath, [command, "list", "--db", selected], { encoding: "utf8" });
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(JSON.parse(success.stdout) as unknown, {
      result: "PASS", action: "list", principals: 0, active_memberships: 0, revoked_memberships: 0, events: 0
    });
    const missingDatabase = spawnSync(process.execPath, [command, "list"], { encoding: "utf8" });
    assert.equal(missingDatabase.status, 1);
    assert.match(missingDatabase.stderr, /INVALID_WEBGPT_AUTH_ADMIN_INPUT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
