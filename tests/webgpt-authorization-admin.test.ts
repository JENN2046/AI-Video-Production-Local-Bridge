import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { DATABASE_MIGRATIONS, assertSchemaCurrent, migrationChecksum, runDatabaseMigrations, WEBGPT_AUTHORIZATION_WORKSPACE_ID } from "../src/storage/migrations.js";
import { openM0Database } from "../src/storage/sqlite.js";
import {
  assertWebGptOwnerBootstrapTarget,
  assertWebGptOwnerBootstrapWritable,
  bootstrapWebGptProjectOwner,
  grantWebGptProjectMembership,
  listWebGptAuthorizationSummary,
  parseWebGptAuthAdminArguments,
  registerWebGptPrincipal,
  revokeWebGptProjectMembership,
  WebGptAuthAdminInputError
} from "../src/webgpt-v4/authorizationAdmin.js";
import { authorizedWebGptProjectIds, requireWebGptProjectReadAccess, webGptProjectAuthorizationReady } from "../src/webgpt-v4/projectAuthorization.js";
import { listProductionProjects } from "../src/webgpt-v4/domain.js";
import { createProject } from "../src/tools/projects.js";
import { principalIdFromFederatedSubject } from "../src/webgpt-v4/types.js";

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
  const interactive = parseWebGptAuthAdminArguments([
    "bootstrap-owner-interactive", "--db", "fixture.sqlite", "--issuer", "https://issuer.example/", "--project", "project_auth_fixture"
  ]);
  assert.equal(interactive.issuer, "https://issuer.example/");
  assert.equal(interactive.principal_id, undefined);
  const preflight = parseWebGptAuthAdminArguments([
    "bootstrap-owner-preflight", "--db", "fixture.sqlite", "--issuer", "https://issuer.example/", "--project", "project_auth_fixture"
  ]);
  assert.equal(preflight.issuer, "https://issuer.example/");
  assert.equal(preflight.principal_id, undefined);
  assert.throws(() => parseWebGptAuthAdminArguments([
    "bootstrap-owner-interactive", "--db", "fixture.sqlite", "--issuer", "http://issuer.example", "--project", "project_auth_fixture"
  ]), /HTTPS issuer URL/);
  assert.throws(() => parseWebGptAuthAdminArguments([
    "bootstrap-owner-interactive", "--db", "fixture.sqlite", "--issuer", "https://issuer.example", "--project", "project_auth_fixture", "--principal", PRINCIPAL
  ]), /not valid for bootstrap-owner-interactive/);
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

test("owner bootstrap rejects a disabled principal and rolls back without membership events", () => {
  const db = openM0Database(":memory:");
  try {
    createProductionProject(db);
    registerWebGptPrincipal(db, PRINCIPAL, "TEST_REGISTER");
    db.prepare("UPDATE webgpt_auth_principals SET status = 'disabled' WHERE workspace_id = ? AND principal_id = ?")
      .run(WEBGPT_AUTHORIZATION_WORKSPACE_ID, PRINCIPAL);
    const before = listWebGptAuthorizationSummary(db);
    assert.throws(() => bootstrapWebGptProjectOwner(db, PRINCIPAL, "project_auth_fixture", "TEST_BOOTSTRAP"), /not active/);
    assert.deepEqual(listWebGptAuthorizationSummary(db), before);
  } finally {
    db.close();
  }
});

test("runtime authorization filters project discovery and hides cross-project access", () => {
  const db = openM0Database(":memory:");
  try {
    const allowed = createProject({ title: "Allowed" }, db);
    const hidden = createProject({ title: "Hidden" }, db);
    assert.equal(allowed.ok && hidden.ok, true);
    if (!allowed.ok || !hidden.ok) return;
    db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id IN (?, ?)")
      .run(allowed.project_id, hidden.project_id);
    bootstrapWebGptProjectOwner(db, PRINCIPAL, allowed.project_id, "TEST_BOOTSTRAP");
    assert.equal(webGptProjectAuthorizationReady(db), true);
    assert.deepEqual(authorizedWebGptProjectIds(db, PRINCIPAL), [allowed.project_id]);
    const result = listProductionProjects({}, db, "request_fixture", authorizedWebGptProjectIds(db, PRINCIPAL));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.data.items.map((item) => (item.project as { project_id: string }).project_id), [allowed.project_id]);
    assert.throws(() => requireWebGptProjectReadAccess(db, PRINCIPAL, hidden.project_id), (error) =>
      error instanceof Error && "code" in error && error.code === "PROJECT_NOT_FOUND");
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

test("owner bootstrap target preflight is read-only and production-only", () => {
  const db = openM0Database(":memory:");
  try {
    createProductionProject(db);
    assert.doesNotThrow(() => assertWebGptOwnerBootstrapTarget(db, "project_auth_fixture"));
    assert.throws(() => assertWebGptOwnerBootstrapTarget(db, "project_missing"), /classified as production/);
    assert.deepEqual(listWebGptAuthorizationSummary(db), { principals: 0, active_memberships: 0, revoked_memberships: 0, events: 0 });
  } finally {
    db.close();
  }
});

test("owner bootstrap write preflight rolls back without authorization changes", () => {
  const db = openM0Database(":memory:");
  try {
    createProductionProject(db);
    const before = db.prepare("SELECT classification, updated_at FROM workbench_project_meta WHERE project_id = ?")
      .get("project_auth_fixture");
    assert.doesNotThrow(() => assertWebGptOwnerBootstrapWritable(db, "project_auth_fixture"));
    const after = db.prepare("SELECT classification, updated_at FROM workbench_project_meta WHERE project_id = ?")
      .get("project_auth_fixture");
    assert.deepEqual(after, before);
    assert.deepEqual(listWebGptAuthorizationSummary(db), { principals: 0, active_memberships: 0, revoked_memberships: 0, events: 0 });
  } finally {
    db.close();
  }
});

test("owner bootstrap write preflight rejects a read-only database after a real rolled-back write", () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "webgpt-auth-readonly-preflight-"));
  const selected = join(root, "selected.sqlite");
  try {
    const setup = new DatabaseSync(selected);
    runDatabaseMigrations(setup);
    createProductionProject(setup);
    setup.close();
    const makeReadOnly = spawnSync("attrib.exe", ["+R", selected], { encoding: "utf8" });
    assert.equal(makeReadOnly.status, 0, makeReadOnly.stderr);

    const db = openM0Database(selected);
    try {
      assert.throws(() => assertWebGptOwnerBootstrapWritable(db, "project_auth_fixture"), /readonly database/i);
    } finally {
      db.close();
    }
  } finally {
    spawnSync("attrib.exe", ["-R", selected], { encoding: "utf8" });
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive owner bootstrap consumes subject only from stdin and never discloses it", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-auth-interactive-"));
  const subject = "descope-user-private-fixture";
  const issuer = "https://api.descope.example/project-fixture";
  const principal = principalIdFromFederatedSubject(issuer, subject);
  try {
    const selected = join(root, "selected.sqlite");
    const db = new DatabaseSync(selected);
    runDatabaseMigrations(db);
    createProductionProject(db);
    db.close();
    const command = join(process.cwd(), "dist", "scripts", "webgpt-auth-admin.js");
    const success = spawnSync(process.execPath, [command, "bootstrap-owner-interactive", "--db", selected,
      "--issuer", issuer, "--project", "project_auth_fixture", "--reason", "TEST_INTERACTIVE"], {
      encoding: "utf8",
      input: `${Buffer.from(subject, "utf8").toString("base64")}\n`
    });
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(JSON.parse(success.stdout) as unknown, {
      result: "PASS", action: "bootstrap-owner-interactive", principal_created: true, membership_created: true
    });
    assert.equal(`${success.stdout}${success.stderr}`.includes(subject), false);
    assert.equal(`${success.stdout}${success.stderr}`.includes(principal), false);

    const verify = new DatabaseSync(selected, { readOnly: true });
    const stored = JSON.stringify({
      principals: verify.prepare("SELECT * FROM webgpt_auth_principals").all(),
      memberships: verify.prepare("SELECT * FROM webgpt_project_memberships").all(),
      events: verify.prepare("SELECT * FROM webgpt_auth_events").all()
    });
    assert.equal(stored.includes(subject), false);
    assert.equal(stored.includes(principal), true);
    assert.equal((verify.prepare("SELECT COUNT(*) AS count FROM webgpt_project_memberships WHERE role = 'owner' AND status = 'active'").get() as { count: number }).count, 1);
    verify.close();

    const missing = spawnSync(process.execPath, [command, "bootstrap-owner-interactive", "--db", selected,
      "--issuer", issuer, "--project", "project_auth_fixture"], { encoding: "utf8", input: "" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /INVALID_WEBGPT_AUTH_ADMIN_INPUT/);
    assert.equal(missing.stderr.includes(subject), false);

    const invalidProject = spawnSync(process.execPath, [command, "bootstrap-owner-interactive", "--db", selected,
      "--issuer", issuer, "--project", "project_missing"], { encoding: "utf8", input: `${Buffer.from(subject, "utf8").toString("base64")}\n` });
    assert.equal(invalidProject.status, 1);
    assert.equal(`${invalidProject.stdout}${invalidProject.stderr}`.includes(subject), false);
    assert.equal(`${invalidProject.stdout}${invalidProject.stderr}`.includes(principal), false);
    const unchanged = new DatabaseSync(selected, { readOnly: true });
    assert.deepEqual(listWebGptAuthorizationSummary(unchanged), { principals: 1, active_memberships: 1, revoked_memberships: 0, events: 2 });
    unchanged.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive owner bootstrap rejects an invalid target before consuming private stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-auth-preflight-"));
  try {
    const selected = join(root, "selected.sqlite");
    const db = new DatabaseSync(selected);
    runDatabaseMigrations(db);
    db.close();
    const command = join(process.cwd(), "dist", "scripts", "webgpt-auth-admin.js");
    const child = spawn(process.execPath, [command, "bootstrap-owner-interactive", "--db", selected,
      "--issuer", "https://issuer.example", "--project", "project_missing"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const status = await Promise.race([
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
      new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 2_000))
    ]);
    if (status === "timeout") child.kill();
    assert.notEqual(status, "timeout", "process waited for stdin before validating the target");
    assert.equal(status, 1);
    assert.equal(stdout.includes("project_missing"), false);
    assert.match(stderr, /INVALID_WEBGPT_AUTH_ADMIN_INPUT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner bootstrap preflight validates the target without stdin or committed database changes", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-auth-cli-preflight-"));
  try {
    const selected = join(root, "selected.sqlite");
    const db = new DatabaseSync(selected);
    runDatabaseMigrations(db);
    createProductionProject(db);
    db.close();
    const command = join(process.cwd(), "dist", "scripts", "webgpt-auth-admin.js");
    const result = spawnSync(process.execPath, [command, "bootstrap-owner-preflight", "--db", selected,
      "--issuer", "https://issuer.example", "--project", "project_auth_fixture"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout) as unknown, {
      result: "PASS", action: "bootstrap-owner-preflight", target_valid: true
    });
    const verify = new DatabaseSync(selected, { readOnly: true });
    assert.deepEqual(listWebGptAuthorizationSummary(verify), { principals: 0, active_memberships: 0, revoked_memberships: 0, events: 0 });
    verify.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive owner bootstrap rejects writer contention before consuming private stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-auth-lock-preflight-"));
  let lockDb: DatabaseSync | undefined;
  try {
    const selected = join(root, "selected.sqlite");
    const setup = new DatabaseSync(selected);
    runDatabaseMigrations(setup);
    createProductionProject(setup);
    setup.close();
    lockDb = new DatabaseSync(selected);
    lockDb.exec("BEGIN IMMEDIATE");

    const command = join(process.cwd(), "dist", "scripts", "webgpt-auth-admin.js");
    const child = spawn(process.execPath, [command, "bootstrap-owner-interactive", "--db", selected,
      "--issuer", "https://issuer.example", "--project", "project_auth_fixture"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const status = await Promise.race([
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
      new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 8_000))
    ]);
    if (status === "timeout") child.kill();
    assert.notEqual(status, "timeout", "process waited for stdin instead of rejecting writer contention");
    assert.equal(status, 1);
    assert.match(stderr, /database is locked/i);
    assert.deepEqual(listWebGptAuthorizationSummary(lockDb), { principals: 0, active_memberships: 0, revoked_memberships: 0, events: 0 });
  } finally {
    if (lockDb) {
      try { lockDb.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
      lockDb.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows bootstrap wrapper uses hidden input and remains compatible with Windows PowerShell", () => {
  const wrapper = join(process.cwd(), "scripts", "windows", "webgpt-bootstrap-owner.ps1");
  const source = readFileSync(wrapper, "utf8");
  assert.match(source, /Read-Host .* -AsSecureString/);
  assert.match(source, /ZeroFreeBSTR/);
  assert.ok(source.indexOf("bootstrap-owner-preflight") < source.indexOf("Read-Host"));
  assert.match(source, /bootstrap-owner-preflight[\s\S]*?--reason \$Reason \| Out-Null[\s\S]*?Read-Host/,
    "the preflight must not add a second JSON document to successful wrapper stdout");
  assert.match(source, /\[System\.Text\.Encoding\]::UTF8\.GetBytes\(\$plainSubject\)/);
  assert.match(source, /\[Convert\]::ToBase64String\(\$subjectBytes\)/);
  assert.match(source, /\$OutputEncoding = \[System\.Text\.ASCIIEncoding\]::new\(\)/);
  assert.match(source, /finally \{\s*\$OutputEncoding = \$previousOutputEncoding/);
  assert.equal(source.includes("HashData"), false);
  assert.equal(source.includes("ToHexString"), false);
  if (process.platform === "win32") {
    const parsed = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      "$null = [scriptblock]::Create((Get-Content -Raw -LiteralPath $env:WEBGPT_WRAPPER_TEST_PATH))"], {
      encoding: "utf8",
      env: { ...process.env, WEBGPT_WRAPPER_TEST_PATH: wrapper }
    });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

test("Windows bootstrap wrapper preserves a Unicode subject across the PowerShell-to-Node pipe", () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "webgpt-auth-wrapper-unicode-"));
  const subject = "descope-用户-α";
  const issuer = "https://issuer.example/unicode-fixture";
  try {
    const selected = join(root, "selected.sqlite");
    const db = new DatabaseSync(selected);
    runDatabaseMigrations(db);
    createProductionProject(db);
    db.close();
    const wrapper = join(process.cwd(), "scripts", "windows", "webgpt-bootstrap-owner.ps1");
    const command = [
      "function Read-Host {",
      "  param([string]$Prompt, [switch]$AsSecureString)",
      "  $secure = [System.Security.SecureString]::new()",
      "  foreach ($character in $env:WEBGPT_TEST_SUBJECT.ToCharArray()) { $secure.AppendChar($character) }",
      "  $secure.MakeReadOnly()",
      "  $secure",
      "}",
      "& $env:WEBGPT_TEST_WRAPPER -DatabasePath $env:WEBGPT_TEST_DB -Issuer $env:WEBGPT_TEST_ISSUER -ProjectId project_auth_fixture -Reason TEST_UNICODE_PIPE"
    ].join("\n");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        WEBGPT_TEST_SUBJECT: subject,
        WEBGPT_TEST_WRAPPER: wrapper,
        WEBGPT_TEST_DB: selected,
        WEBGPT_TEST_ISSUER: issuer
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout) as unknown, {
      result: "PASS", action: "bootstrap-owner-interactive", principal_created: true, membership_created: true
    });
    assert.equal(`${result.stdout}${result.stderr}`.includes(subject), false);

    const verify = new DatabaseSync(selected, { readOnly: true });
    const membership = verify.prepare(`SELECT principal_id FROM webgpt_project_memberships
      WHERE workspace_id = ? AND project_id = ? AND role = 'owner' AND status = 'active'`)
      .get(WEBGPT_AUTHORIZATION_WORKSPACE_ID, "project_auth_fixture") as { principal_id: string } | undefined;
    verify.close();
    assert.equal(membership?.principal_id, principalIdFromFederatedSubject(issuer, subject));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
