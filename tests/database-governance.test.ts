import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { backupDatabase, checkDatabase, databaseLogicalManifest, migrateDatabase } from "../src/storage/databaseGovernance.js";
import { assertSchemaCurrent, DATABASE_MIGRATIONS, M0_BASE_SCHEMA_SQL, migrationChecksum, runDatabaseMigrations, SchemaMigrationRequiredError } from "../src/storage/migrations.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { workbenchAssemblyInputFingerprint } from "../src/storage/workbenchAssemblyFingerprint.js";
import { initializeWorkbenchV2Schema } from "../src/storage/workbenchV2Schema.js";
import { paths } from "../src/paths.js";
import { persistMediaArtifact, registerMediaArtifact, transitionMediaArtifactStatus, type MediaArtifact } from "../src/tools/mediaArtifacts.js";
import { buildStoryboardApprovedShot, createProject, saveShot } from "../src/tools/projects.js";
import {
  approveWorkbenchDeliveryFixture,
  completeWorkbenchAssemblyFixture,
  completeWorkbenchExportFixture,
  createAcceptedAssemblyClipFixture,
  ensureAcceptedAssemblyClipsFixture,
  failWorkbenchAssemblyFixture,
  insertWorkbenchExportFixture,
  queueWorkbenchAssemblyFixture
} from "./workbench-delivery-test-helpers.js";

const HISTORICAL_MIGRATION_0005_CHECKSUM = "92297a3ce2996e427b8a8e3dae39a25f33a294c29142b5ca723cdcd4700ad8b0";
const INTERIM_MIGRATION_0005_CHECKSUM = "6e929ae3b8db4387891d664cd22dc5299dab689eab0d6c1dd07dc70afbabbe73";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ai-video-db-governance-"));
}

function setProjectFinalArtifactFixture(
  db: ReturnType<typeof openM0Database>,
  projectId: string,
  artifactId: string
): void {
  db.prepare(`UPDATE projects SET data_json = json_set(
      data_json, '$.status', 'video_review', '$.exports.final_video_artifact_id', ?
    ), updated_at = CURRENT_TIMESTAMP WHERE project_id = ?`).run(artifactId, projectId);
}

function insertUnverifiedArtifact(
  db: DatabaseSync,
  input: { artifact_id: string; project_id?: string; shot_id?: string; uri: string }
): void {
  const blobId = `blob_${input.artifact_id}`;
  db.prepare(`INSERT INTO media_blobs
    (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
    VALUES (?, '', 0, '', ?, 'unverified', '{}')`).run(blobId, input.uri);
  const artifact = {
    artifact_id: input.artifact_id,
    blob_id: blobId,
    artifact_type: "image",
    role: "storyboard_image",
    status: "inaccessible",
    storage: { uri: input.uri, mime_type: "image/png", filename: `${input.artifact_id}.png` },
    metadata: { width: 0, height: 0, duration_seconds: null, aspect_ratio: "", sha256: "" },
    linked_objects: { project_id: input.project_id ?? "", shot_id: input.shot_id ?? "" },
    source: { kind: "accessible_uri", provider: "", provider_job_id: "", sha256: "", external_url_host: "media.example.test" }
  };
  db.prepare(`INSERT INTO media_artifacts
    (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, ?, 'storyboard_image', 'image', 'inaccessible', ?)`)
    .run(input.artifact_id, input.project_id || null, input.shot_id || null, JSON.stringify(artifact));
  db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)").run(input.artifact_id, blobId);
}

function createApprovedDeliveryFixture(
  db: ReturnType<typeof openM0Database>,
  suffix: string,
  now = "2026-08-15T10:00:00.000Z"
): { project_id: string; artifact_id: string; fingerprint: string } {
  const project = createProject({ title: `Rework evidence ${suffix}` }, db);
  assert.equal(project.ok, true);
  if (!project.ok) throw new Error("rework evidence project setup failed");
  ensureAcceptedAssemblyClipsFixture(db, project.project_id);
  const artifact = registerMediaArtifact({
    artifact_type: "video",
    role: "final_video",
    source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
    linked_objects: { project_id: project.project_id }
  }, db);
  assert.equal(artifact.ok, true);
  if (!artifact.ok) throw new Error("rework evidence Artifact setup failed");
  setProjectFinalArtifactFixture(db, project.project_id, artifact.artifact.artifact_id);
  db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
    .run(now, project.project_id);
  completeWorkbenchAssemblyFixture(db, {
    project_id: project.project_id,
    artifact_id: artifact.artifact.artifact_id,
    job_id: `job_rework_assembly_${suffix}`,
    event_id: `event_rework_assembly_${suffix}`,
    created_at: now
  });
  const fingerprint = (db.prepare(`SELECT assembly_input_fingerprint FROM workbench_delivery_state
    WHERE project_id = ?`).get(project.project_id) as { assembly_input_fingerprint: string }).assembly_input_fingerprint;
  approveWorkbenchDeliveryFixture(db, {
    project_id: project.project_id,
    event_id: `event_rework_accepted_${suffix}`,
    created_at: now
  });
  return { project_id: project.project_id, artifact_id: artifact.artifact.artifact_id, fingerprint };
}

test("fresh database migrates explicitly and remains idempotent", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    const first = migrateDatabase(sqlitePath);
    assert.deepEqual(first.applied, DATABASE_MIGRATIONS.map((migration) => migration.id));
    assert.equal(first.baselined, false);
    const second = migrateDatabase(sqlitePath);
    assert.deepEqual(second.applied, []);
    assert.equal(checkDatabase(sqlitePath).result, "PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only database check reports pending media activation without recovering or mutating it", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    const stagingPath = join(root, "staged-media.bin");
    const pendingPath = join(root, "pending-media.bin");
    const finalPath = join(root, "final-media.bin");
    const bytes = Buffer.from("pending-activation-fixture", "utf8");
    writeFileSync(stagingPath, bytes);
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    try {
      const sha256 = "a".repeat(64);
      const artifact = {
        artifact_id: "artifact_pending_readonly_check",
        artifact_type: "image",
        role: "storyboard_image",
        storage: { uri: finalPath, mime_type: "image/png" },
        metadata: { sha256 },
        source: { sha256 }
      };
      db.prepare(`INSERT INTO media_activation_journal
        (activation_id, artifact_id, state, artifact_type, role, expected_sha256, expected_size_bytes,
         detected_mime, staging_path, pending_path, final_path, artifact_json)
        VALUES (?, ?, 'staged', 'image', 'storyboard_image', ?, ?, 'image/png', ?, ?, ?, ?)`)
        .run("activation_pending_readonly_check", artifact.artifact_id, sha256, bytes.byteLength,
          stagingPath, pendingPath, finalPath, JSON.stringify(artifact));
    } finally {
      db.close();
    }

    const before = databaseLogicalManifest(sqlitePath);
    const beforeBytes = readFileSync(stagingPath);
    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    const after = databaseLogicalManifest(sqlitePath);

    assert.equal(checked.result, "FAIL");
    assert.equal(checked.pending_media_activations, 1);
    assert.deepEqual(after, before);
    assert.deepEqual(readFileSync(stagingPath), beforeBytes);
    const verifyDb = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      const row = verifyDb.prepare("SELECT state FROM media_activation_journal WHERE activation_id = ?")
        .get("activation_pending_readonly_check") as { state: string };
      assert.equal(row.state, "staged");
    } finally {
      verifyDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh database migration creates a missing parent directory", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "new", "nested", "app.sqlite");
    const result = migrateDatabase(sqlitePath);
    assert.deepEqual(result.applied, DATABASE_MIGRATIONS.map((migration) => migration.id));
    assert.equal(checkDatabase(sqlitePath).result, "PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing workbench-v2-4 database is baselined without rewriting business rows", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec("BEGIN IMMEDIATE");
    db.exec(M0_BASE_SCHEMA_SQL);
    initializeWorkbenchV2Schema(db, { manage_transaction: false });
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_existing', ?)").run(JSON.stringify({ project_id: "project_existing", title: "Existing" }));
    db.prepare(`INSERT INTO generation_intents
      (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id, duration_seconds, resolution,
       estimated_cost_value, budget_limit_value, currency, confirmed, expires_at, provider_task_id, status)
      VALUES ('intent_existing', 'project_existing', 'shot_existing', 'runninghub', 'personal', 'model', 'artifact_existing', 6,
        '1080x1920', 0.08, 1, 'CNY', 1, '2099-01-01T00:00:00.000Z', 'task_existing', 'running')`).run();
    db.exec("COMMIT");
    const before = db.prepare("SELECT data_json FROM projects WHERE project_id = 'project_existing'").get() as { data_json: string };
    const result = runDatabaseMigrations(db);
    const after = db.prepare("SELECT data_json FROM projects WHERE project_id = 'project_existing'").get() as { data_json: string };
    assert.equal(result.baselined, true);
    assert.equal(after.data_json, before.data_json);
    const backfilled = db.prepare(`SELECT j.state, e.to_state, e.reason_code FROM generation_jobs j
      JOIN generation_job_events e ON e.job_id = j.job_id WHERE j.intent_id = 'intent_existing'`).get() as { state: string; to_state: string; reason_code: string };
    assert.deepEqual({ ...backfilled }, { state: "polling", to_state: "polling", reason_code: "MIGRATION_BACKFILL" });
    assertSchemaCurrent(db);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration checksum drift fails closed", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("UPDATE schema_migrations SET checksum = 'changed' WHERE migration_id = '0002'").run();
    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError && error.code === "SCHEMA_MIGRATION_REQUIRED");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing v2-4 baseline rejects weakened table CHECK constraints", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(M0_BASE_SCHEMA_SQL);
    initializeWorkbenchV2Schema(db);
    db.exec("ALTER TABLE workbench_project_meta RENAME TO workbench_project_meta_canonical");
    db.exec(`CREATE TABLE workbench_project_meta (
      project_id TEXT PRIMARY KEY,
      classification TEXT NOT NULL DEFAULT 'unclassified',
      lifecycle TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      last_opened_at TEXT,
      next_action_override TEXT NOT NULL DEFAULT '',
      next_action_priority TEXT,
      next_action_expires_at TEXT,
      next_action_project_status TEXT,
      next_action_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec("DROP TABLE workbench_project_meta_canonical");
    assert.throws(() => runDatabaseMigrations(db), (error) => error instanceof SchemaMigrationRequiredError && /check_constraints:workbench_project_meta/.test(error.message));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});

test("schema validation rejects weakened UNIQUE and REFERENCES constraints", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "weakened-non-check-constraints.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE generation_job_events;
      DROP TABLE generation_jobs;
      CREATE TABLE generation_jobs (
        job_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        state TEXT NOT NULL,
        lease_owner TEXT NOT NULL DEFAULT '',
        lease_token TEXT NOT NULL DEFAULT '',
        lease_expires_at TEXT,
        next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        reconciliation_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (state IN ('queued','submitting','polling','downloading','finalizing','manual_reconciliation','succeeded','failed','cancelled'))
      );
      CREATE TABLE generation_job_events (
        event_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        from_state TEXT NOT NULL DEFAULT '',
        to_state TEXT NOT NULL,
        reason_code TEXT NOT NULL DEFAULT '',
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_generation_jobs_due ON generation_jobs(state, next_attempt_at, created_at);
      CREATE INDEX idx_generation_job_events_job ON generation_job_events(job_id, created_at);
      CREATE TRIGGER generation_job_events_no_update
        BEFORE UPDATE ON generation_job_events BEGIN
          SELECT RAISE(ABORT, 'GENERATION_JOB_EVENTS_APPEND_ONLY');
        END;
      CREATE TRIGGER generation_job_events_no_delete
        BEFORE DELETE ON generation_job_events BEGIN
          SELECT RAISE(ABORT, 'GENERATION_JOB_EVENTS_APPEND_ONLY');
        END;
    `);
    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError
      && /unique_constraints:generation_jobs/.test(error.message)
      && /foreign_keys:generation_jobs/.test(error.message)
      && /foreign_keys:generation_job_events/.test(error.message));
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema validation preserves case-sensitive CHECK and default string literals", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "case-sensitive-schema-literals.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    const jobTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'generation_jobs'").get() as { sql: string };
    const jobIndexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'generation_jobs' AND sql IS NOT NULL").all() as Array<{ sql: string }>;
    const driftedJobSql = jobTable.sql.replace("'queued'", "'QUEUED'");
    assert.notEqual(driftedJobSql, jobTable.sql);

    const metaTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workbench_project_meta'").get() as { sql: string };
    const metaIndexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workbench_project_meta' AND sql IS NOT NULL").all() as Array<{ sql: string }>;
    const driftedMetaSql = metaTable.sql.replace("DEFAULT 'active'", "DEFAULT 'ACTIVE'");
    assert.notEqual(driftedMetaSql, metaTable.sql);

    db.exec("PRAGMA foreign_keys = OFF; DROP TABLE generation_jobs;");
    db.exec(driftedJobSql);
    for (const index of jobIndexes) db.exec(index.sql);
    db.exec("DROP TABLE workbench_project_meta;");
    db.exec(driftedMetaSql);
    for (const index of metaIndexes) db.exec(index.sql);
    db.exec("PRAGMA foreign_keys = ON;");

    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError
      && /check_constraints:generation_jobs/.test(error.message)
      && /column_definition:workbench_project_meta.lifecycle/.test(error.message));
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema validation recognizes generated columns and rejects expression drift", () => {
  const root = tempRoot();
  try {
    const fixtures = [
      {
        table: "workbench_delivery_events",
        original: "THEN json_array(project_id, artifact_id, input_fingerprint)",
        replacement: "THEN json_array(project_id, artifact_id)"
      },
      {
        table: "workbench_delivery_state",
        original: "THEN json_array(project_id, approved_artifact_id, assembly_input_fingerprint, updated_at)",
        replacement: "THEN json_array(project_id, approved_artifact_id, assembly_input_fingerprint)"
      },
      {
        table: "workbench_delivery_jobs",
        original: "THEN json_array(project_id, job_id, 'export_started', json_extract(input_json, '$.artifact_id'))",
        replacement: "THEN json_array(project_id, job_id, 'export_queued', json_extract(input_json, '$.artifact_id'))"
      }
    ] as const;
    for (const fixture of fixtures) {
      const sqlitePath = join(root, `${fixture.table}.sqlite`);
      migrateDatabase(sqlitePath);
      const db = new DatabaseSync(sqlitePath);
      const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(fixture.table) as { sql: string };
      const ownedObjects = db.prepare(`SELECT sql FROM sqlite_master
        WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name`)
        .all(fixture.table) as Array<{ sql: string }>;
      const driftedSql = table.sql.replace(fixture.original, fixture.replacement);
      assert.notEqual(driftedSql, table.sql);
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(`DROP TABLE "${fixture.table}"`);
      db.exec(driftedSql);
      for (const object of ownedObjects) db.exec(object.sql);
      db.exec("PRAGMA foreign_keys = ON");

      assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError
        && new RegExp(`generated_columns:${fixture.table}`).test(error.message));
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime open cannot use a production environment flag to migrate persistent data", () => {
  const root = tempRoot();
  const previous = process.env.AI_VIDEO_AUTO_MIGRATE;
  const previousTestAutoMigrate = process.env.AI_VIDEO_TEST_AUTO_MIGRATE;
  try {
    const sqlitePath = join(root, "runtime.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec(M0_BASE_SCHEMA_SQL);
    initializeWorkbenchV2Schema(db);
    db.close();
    process.env.AI_VIDEO_AUTO_MIGRATE = "true";
    delete process.env.AI_VIDEO_TEST_AUTO_MIGRATE;
    assert.throws(() => openM0Database(sqlitePath), (error) => error instanceof SchemaMigrationRequiredError);
  } finally {
    if (previous === undefined) delete process.env.AI_VIDEO_AUTO_MIGRATE;
    else process.env.AI_VIDEO_AUTO_MIGRATE = previous;
    if (previousTestAutoMigrate === undefined) delete process.env.AI_VIDEO_TEST_AUTO_MIGRATE;
    else process.env.AI_VIDEO_TEST_AUTO_MIGRATE = previousTestAutoMigrate;
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema validation rejects migration rows from a newer runtime", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "future.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES ('9999', 'future_schema', 'future-checksum')").run();
    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError && /unsupported migration 9999/.test(error.message));
    assert.throws(() => runDatabaseMigrations(db), (error) => error instanceof SchemaMigrationRequiredError && /unsupported migration 9999/.test(error.message));
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database migrated through 0003 keeps its historical checksums and upgrades through current", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "legacy-0003.sqlite");
    const db = new DatabaseSync(sqlitePath);
    for (const migration of DATABASE_MIGRATIONS.slice(0, 2)) migration.apply(db);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_legacy', ?)")
      .run(JSON.stringify({ project_id: "project_legacy", title: "Legacy 0003" }));
    db.prepare(`INSERT INTO generation_intents
      (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id, duration_seconds, resolution,
       estimated_cost_value, budget_limit_value, currency, confirmed, expires_at, provider_task_id, status)
      VALUES ('intent_legacy', 'project_legacy', 'shot_legacy', 'runninghub', 'personal', 'model', 'artifact_legacy', 6,
        '1080x1920', 0.08, 1, 'CNY', 1, '2099-01-01T00:00:00.000Z', 'task_legacy', 'running')`).run();
    DATABASE_MIGRATIONS[2].apply(db);
    db.exec(`CREATE TABLE schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    for (const migration of DATABASE_MIGRATIONS.slice(0, 3)) {
      db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)")
        .run(migration.id, migration.name, migrationChecksum(migration));
    }

    assert.equal(migrationChecksum(DATABASE_MIGRATIONS[1]), "52dc1311414cd88468542159d215adce443717b087e65d73d3f60859e5727c75");
    assert.equal(migrationChecksum(DATABASE_MIGRATIONS[2]), "161aa27dec915827c0ab6d46bc768ca2734c2efdf4bc45ae2fa1b2f4b564fef8");
    const result = runDatabaseMigrations(db);
    assert.deepEqual(result.applied, ["0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012"]);
    const event = db.prepare("SELECT to_state, reason_code FROM generation_job_events WHERE job_id = 'job_intent_legacy'").get() as { to_state: string; reason_code: string };
    assert.deepEqual({ ...event }, { to_state: "polling", reason_code: "MIGRATION_BACKFILL" });
    assertSchemaCurrent(db);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration 0006 backfills active legacy Artifact facts from the verified Blob", () => {
  const root = tempRoot();
  let db: DatabaseSync | null = null;
  try {
    const sqlitePath = join(root, "legacy-0005.sqlite");
    db = new DatabaseSync(sqlitePath);
    for (const migration of DATABASE_MIGRATIONS.slice(0, 4)) migration.apply(db);
    const sourcePath = resolve("fixtures", "provider-canary", "m1-r0", "shot_001_canary_720x1280.png");
    const artifact = {
      artifact_id: "artifact_legacy_facts",
      blob_id: "",
      artifact_type: "image",
      role: "storyboard_image",
      status: "active",
      storage: { uri: sourcePath, mime_type: "application/octet-stream", filename: "legacy-declared.jpg" },
      metadata: { width: 720, height: 1280, duration_seconds: null, aspect_ratio: "9:16", sha256: "legacy-placeholder" },
      linked_objects: { project_id: "", shot_id: "" },
      source: { kind: "legacy_import", provider: "", provider_job_id: "", sha256: "", external_url_host: "" },
      business_note: "must survive fact backfill"
    };
    db.prepare("INSERT INTO media_artifacts (artifact_id, role, artifact_type, status, data_json) VALUES (?, 'storyboard_image', 'image', 'active', ?)")
      .run(artifact.artifact_id, JSON.stringify(artifact));
    DATABASE_MIGRATIONS[4].apply(db);
    const before = db.prepare(`SELECT a.data_json, b.sha256, b.detected_mime, b.storage_uri
      FROM media_artifacts a JOIN media_artifact_blobs m ON m.artifact_id = a.artifact_id JOIN media_blobs b ON b.blob_id = m.blob_id
      WHERE a.artifact_id = ?`).get(artifact.artifact_id) as { data_json: string; sha256: string; detected_mime: string; storage_uri: string };
    assert.equal((JSON.parse(before.data_json) as typeof artifact).metadata.sha256, "legacy-placeholder");
    const historicalBlob = db.prepare("SELECT provenance_json FROM media_blobs WHERE blob_id = (SELECT blob_id FROM media_artifact_blobs WHERE artifact_id = ?)")
      .get(artifact.artifact_id) as { provenance_json: string };
    assert.equal(Object.hasOwn(JSON.parse(historicalBlob.provenance_json) as Record<string, unknown>, "media_root"), false);

    db.exec(`CREATE TABLE schema_migrations (
      migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const insertLedger = db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)");
    for (const migration of DATABASE_MIGRATIONS.slice(0, 4)) insertLedger.run(migration.id, migration.name, migrationChecksum(migration));
    assert.equal(migrationChecksum(DATABASE_MIGRATIONS[4]), HISTORICAL_MIGRATION_0005_CHECKSUM);
    insertLedger.run(DATABASE_MIGRATIONS[4].id, DATABASE_MIGRATIONS[4].name, HISTORICAL_MIGRATION_0005_CHECKSUM);
    const migrated = runDatabaseMigrations(db);
    assert.deepEqual(migrated.applied, ["0006", "0007", "0008", "0009", "0010", "0011", "0012"]);

    const after = JSON.parse((db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(artifact.artifact_id) as { data_json: string }).data_json) as typeof artifact;
    assert.equal(after.metadata.sha256, before.sha256);
    assert.equal(after.source.sha256, before.sha256);
    assert.equal(after.storage.mime_type, before.detected_mime);
    assert.equal(after.storage.uri, before.storage_uri);
    assert.equal(after.storage.filename, "shot_001_canary_720x1280.png");
    assert.equal(after.business_note, "must survive fact backfill");
    const blobAfter = db.prepare("SELECT storage_uri, provenance_json FROM media_blobs WHERE blob_id = ?").get(after.blob_id) as { storage_uri: string; provenance_json: string };
    const canonicalSource = resolve(realpathSync(sourcePath));
    assert.equal(blobAfter.storage_uri, canonicalSource);
    assert.equal((JSON.parse(blobAfter.provenance_json) as { media_root: string }).media_root, dirname(canonicalSource));
    assertSchemaCurrent(db);
    db.close();
    db = null;
    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.result, "PASS", JSON.stringify(checked));
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration accepts and canonicalizes the interim 0005 ledger checksum", () => {
  const root = tempRoot();
  let db: DatabaseSync | null = null;
  try {
    const sqlitePath = join(root, "interim-0005.sqlite");
    const connection = new DatabaseSync(sqlitePath);
    db = connection;
    for (const migration of DATABASE_MIGRATIONS.slice(0, 5)) migration.apply(connection);
    connection.exec(`CREATE TABLE schema_migrations (
      migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const insertLedger = connection.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)");
    for (const migration of DATABASE_MIGRATIONS.slice(0, 5)) {
      insertLedger.run(migration.id, migration.name, migration.id === "0005" ? INTERIM_MIGRATION_0005_CHECKSUM : migrationChecksum(migration));
    }

    assert.throws(
      () => assertSchemaCurrent(connection),
      (error) => error instanceof SchemaMigrationRequiredError
        && /Database schema version is workbench-v2-5|Missing database migration 0006/.test(error.message)
    );
    const migrated = runDatabaseMigrations(connection);
    assert.deepEqual(migrated.applied, ["0006", "0007", "0008", "0009", "0010", "0011", "0012"]);
    const normalized = connection.prepare("SELECT checksum FROM schema_migrations WHERE migration_id = '0005'").get() as { checksum: string };
    assert.equal(normalized.checksum, HISTORICAL_MIGRATION_0005_CHECKSUM);
    assertSchemaCurrent(connection);

    connection.prepare("UPDATE schema_migrations SET checksum = ? WHERE migration_id = '0005'").run(INTERIM_MIGRATION_0005_CHECKSUM);
    assert.doesNotThrow(() => assertSchemaCurrent(connection));
    const repaired = runDatabaseMigrations(connection);
    assert.deepEqual(repaired.applied, []);
    const repairedChecksum = connection.prepare("SELECT checksum FROM schema_migrations WHERE migration_id = '0005'").get() as { checksum: string };
    assert.equal(repairedChecksum.checksum, HISTORICAL_MIGRATION_0005_CHECKSUM);

    connection.prepare("UPDATE schema_migrations SET checksum = 'unknown-0005-drift' WHERE migration_id = '0005'").run();
    assert.throws(() => assertSchemaCurrent(connection), (error) => error instanceof SchemaMigrationRequiredError && /checksum mismatch for 0005/.test(error.message));
    assert.throws(() => runDatabaseMigrations(connection), (error) => error instanceof SchemaMigrationRequiredError && /checksum mismatch for 0005/.test(error.message));
    connection.close();
    db = null;
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing v2-4 baseline rejects missing columns and indexes", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec(M0_BASE_SCHEMA_SQL);
    initializeWorkbenchV2Schema(db);
    db.exec("ALTER TABLE generation_intents DROP COLUMN provider_task_id");
    assert.throws(() => runDatabaseMigrations(db), (error) => error instanceof SchemaMigrationRequiredError && /missing_column:generation_intents\.provider_task_id/.test(error.message));
    db.close();

    const indexPath = join(root, "missing-index.sqlite");
    migrateDatabase(indexPath);
    const indexed = new DatabaseSync(indexPath);
    indexed.exec("DROP INDEX idx_generation_intents_active");
    assert.throws(() => assertSchemaCurrent(indexed), (error) => error instanceof SchemaMigrationRequiredError && /missing_index:idx_generation_intents_active/.test(error.message));
    indexed.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema validation rejects index and trigger definitions with the expected names", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.exec("DROP INDEX idx_generation_intents_active; CREATE INDEX idx_generation_intents_active ON generation_intents(intent_id)");
    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError && /index_definition:idx_generation_intents_active/.test(error.message));
    db.exec("DROP INDEX idx_generation_intents_active; CREATE INDEX idx_generation_intents_active ON generation_intents(status, updated_at DESC)");
    db.exec("DROP TRIGGER generation_job_events_no_delete; CREATE TRIGGER generation_job_events_no_delete BEFORE DELETE ON generation_job_events BEGIN SELECT 1; END");
    assert.throws(() => assertSchemaCurrent(db), (error) => error instanceof SchemaMigrationRequiredError && /trigger_definition:generation_job_events_no_delete/.test(error.message));
    db.close();

    const projectTriggerPath = join(root, "project-trigger.sqlite");
    migrateDatabase(projectTriggerPath);
    const projectTrigger = new DatabaseSync(projectTriggerPath);
    projectTrigger.exec("DROP TRIGGER trg_workbench_project_meta_after_insert; CREATE TRIGGER trg_workbench_project_meta_after_insert AFTER INSERT ON projects BEGIN SELECT 1; END");
    assert.throws(() => assertSchemaCurrent(projectTrigger), (error) => error instanceof SchemaMigrationRequiredError && /trigger_definition:trg_workbench_project_meta_after_insert/.test(error.message));
    projectTrigger.close();

    const deliveryJobTriggerPath = join(root, "delivery-job-trigger.sqlite");
    migrateDatabase(deliveryJobTriggerPath);
    const deliveryJobTrigger = new DatabaseSync(deliveryJobTriggerPath);
    deliveryJobTrigger.exec(`DROP TRIGGER workbench_delivery_jobs_validate_insert;
      CREATE TRIGGER workbench_delivery_jobs_validate_insert BEFORE INSERT ON workbench_delivery_jobs BEGIN SELECT 1; END`);
    assert.throws(() => assertSchemaCurrent(deliveryJobTrigger), (error) => error instanceof SchemaMigrationRequiredError
      && /trigger_definition:workbench_delivery_jobs_validate_insert/.test(error.message));
    deliveryJobTrigger.close();

    const deliveryArtifactTriggerPath = join(root, "delivery-artifact-trigger.sqlite");
    migrateDatabase(deliveryArtifactTriggerPath);
    const deliveryArtifactTrigger = new DatabaseSync(deliveryArtifactTriggerPath);
    deliveryArtifactTrigger.exec(`DROP TRIGGER workbench_delivery_artifact_content_guard;
      CREATE TRIGGER workbench_delivery_artifact_content_guard BEFORE UPDATE OF data_json
      ON media_artifacts BEGIN SELECT 1; END`);
    assert.throws(() => assertSchemaCurrent(deliveryArtifactTrigger), (error) => error instanceof SchemaMigrationRequiredError
      && /trigger_definition:workbench_delivery_artifact_content_guard/.test(error.message));
    deliveryArtifactTrigger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects missing structured identifiers and accepts external media URLs", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_missing_json_id', ?)")
      .run(JSON.stringify({ title: "Missing JSON identifier" }));
    insertUnverifiedArtifact(db, { artifact_id: "artifact_external", uri: "https://example.test/media/storyboard.png" });
    db.close();

    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.structured_drift_rows, 1);
    assert.equal(checked.missing_media_files, 0);
    assert.equal(checked.result, "FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check returns a structured failure for malformed JSON and missing schema", () => {
  const root = tempRoot();
  try {
    const malformedPath = join(root, "malformed.sqlite");
    migrateDatabase(malformedPath);
    const malformed = new DatabaseSync(malformedPath);
    malformed.exec("DROP INDEX idx_projects_status_updated");
    malformed.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_bad_json', '{')").run();
    malformed.close();
    const malformedResult = checkDatabase(malformedPath);
    assert.equal(malformedResult.result, "FAIL");
    assert.equal(malformedResult.invalid_json_rows, 1);

    const missingPath = join(root, "missing.sqlite");
    migrateDatabase(missingPath);
    const missing = new DatabaseSync(missingPath);
    missing.exec("DROP TABLE generation_job_events");
    missing.close();
    const missingResult = checkDatabase(missingPath);
    assert.equal(missingResult.result, "FAIL");
    assert.equal(missingResult.schema_current, false);
    assert.equal(missingResult.check_errors > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check reports orphan rows", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO shots (shot_id, project_id, data_json) VALUES ('shot_orphan', 'project_missing', ?)")
      .run(JSON.stringify({ shot_id: "shot_orphan", project_id: "project_missing" }));
    db.close();
    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.result, "FAIL");
    assert.equal(checked.orphan_rows > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check reports invalid delivery Job bindings and inactive referenced final Artifacts", () => {
  const root = tempRoot();
  let db: DatabaseSync | null = null;
  try {
    const sqlitePath = join(root, "delivery-job-bindings.sqlite");
    migrateDatabase(sqlitePath);
    db = openM0Database(sqlitePath);
    const now = "2026-08-14T00:00:00.000Z";
    for (const projectId of ["project_a", "project_b"]) {
      db.prepare("INSERT INTO projects (project_id, data_json) VALUES (?, ?)")
        .run(projectId, JSON.stringify({
          project_id: projectId,
          video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" },
          exports: { final_video_artifact_id: "" }
        }));
    }
    ensureAcceptedAssemblyClipsFixture(db, "project_b");
    const artifact = {
      artifact_id: "artifact_b",
      blob_id: "blob_b",
      artifact_type: "video",
      role: "final_video",
      status: "active",
      linked_objects: { project_id: "project_b", shot_id: "" }
    };
    db.prepare(`INSERT INTO media_blobs
      (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
      VALUES ('blob_b', '', 0, '', '', 'unverified', '{}')`).run();
    db.prepare(`INSERT INTO media_artifacts
      (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
      VALUES ('artifact_b', 'project_b', '', 'final_video', 'video', 'active', ?)`).run(JSON.stringify(artifact));
    db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES ('artifact_b', 'blob_b')").run();
    const oldArtifact = { ...artifact, artifact_id: "artifact_old_b" };
    db.prepare(`INSERT INTO media_artifacts
      (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
      VALUES ('artifact_old_b', 'project_b', '', 'final_video', 'video', 'active', ?)`).run(JSON.stringify(oldArtifact));
    db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES ('artifact_old_b', 'blob_b')").run();
    db.prepare("UPDATE projects SET data_json = ? WHERE project_id = 'project_b'")
      .run(JSON.stringify({
        project_id: "project_b",
        video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" },
        exports: { final_video_artifact_id: "artifact_b" }
      }));
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = 'project_b'").run(now);
    queueWorkbenchAssemblyFixture(db, {
      project_id: "project_b",
      job_id: "parent_b",
      event_id: "parent_b_queued",
      created_at: now
    });
    failWorkbenchAssemblyFixture(db, {
      project_id: "project_b",
      job_id: "parent_b",
      event_id: "parent_b_failed",
      created_at: now
    });
    completeWorkbenchAssemblyFixture(db, {
      project_id: "project_b",
      artifact_id: "artifact_b",
      job_id: "assembly_current_b",
      event_id: "assembly_succeeded_current_b",
      created_at: now
    });
    const exportValidation = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger'
      AND name = 'workbench_exports_validate_insert'`).get() as { sql: string };
    db.exec("DROP TRIGGER workbench_exports_validate_insert");
    db.prepare(`INSERT INTO workbench_exports
      (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
      VALUES ('export_b', 'project_b', 'artifact_b', 'data/exports/project_b/final.mp4', ?, 1, ?)`)
      .run("d".repeat(64), now);
    db.prepare(`INSERT INTO workbench_exports
      (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
      VALUES ('export_old_b', 'project_b', 'artifact_old_b', 'data/exports/project_b/old.mp4', ?, 1, ?)`)
      .run("e".repeat(64), now);
    db.exec(exportValidation.sql);
    approveWorkbenchDeliveryFixture(db, {
      project_id: "project_b",
      event_id: "final_review_accepted_valid_b",
      created_at: now
    });
    completeWorkbenchExportFixture(db, {
      project_id: "project_b",
      export_id: "export_b",
      job_id: "export_current_b",
      event_id: "export_succeeded_current_b",
      created_at: now
    });
    const triggerRows = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger'
      AND name IN ('workbench_delivery_jobs_validate_insert', 'workbench_delivery_jobs_validate_bindings_update',
        'workbench_delivery_artifact_status_guard', 'workbench_delivery_events_validate_insert',
        'workbench_delivery_events_job_event_unique', 'workbench_delivery_assembly_success_apply',
        'workbench_delivery_assembly_terminal_apply', 'workbench_delivery_export_success_apply',
        'workbench_delivery_state_transition')
      ORDER BY name`).all() as Array<{ sql: string }>;
    assert.equal(triggerRows.length, 9);
    db.exec(`DROP TRIGGER workbench_delivery_jobs_validate_insert;
      DROP TRIGGER workbench_delivery_jobs_validate_bindings_update;
      DROP TRIGGER workbench_delivery_artifact_status_guard;
      DROP TRIGGER workbench_delivery_events_validate_insert;
      DROP TRIGGER workbench_delivery_events_job_event_unique;
      DROP TRIGGER workbench_delivery_assembly_success_apply;
      DROP TRIGGER workbench_delivery_assembly_terminal_apply;
      DROP TRIGGER workbench_delivery_export_success_apply;
      DROP TRIGGER workbench_delivery_state_transition;`);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'closed', closed_at = ?, updated_at = ? WHERE project_id = 'project_b'`).run(now, now);
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, retry_of_job_id, error_code, terminal_event_id,
        created_at, finished_at, updated_at)
      VALUES ('retry_a', 'project_a', 'assembly', 'failed', '{}', 'parent_b', 'SYNTHETIC_FAILURE',
        'event_retry_a_terminal', ?, ?, ?)`)
      .run(now, now, now);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, reason_code, data_json, created_at)
      VALUES ('assembly_failed_duplicate_b', 'project_b', 'parent_b', 'assembly_failed',
        'assembling', 'ready_to_assemble', 'SYNTHETIC_FAILURE', '{}', ?)`)
      .run(now);
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, output_artifact_id, terminal_event_id,
        created_at, finished_at, updated_at)
      VALUES ('assembly_a', 'project_a', 'assembly', 'succeeded',
        '{"source_clip_artifact_ids":[]}', 'artifact_b', 'event_assembly_a_terminal', ?, ?, ?)`)
      .run(now, now, now);
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, export_id, terminal_event_id,
        created_at, finished_at, updated_at)
      VALUES ('export_a', 'project_a', 'export', 'succeeded', '{}', 'export_b',
        'event_export_a_terminal', ?, ?, ?)`)
      .run(now, now, now);
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, export_id, terminal_event_id,
        created_at, finished_at, updated_at)
      VALUES ('export_input_mismatch_b', 'project_b', 'export', 'succeeded',
        '{"artifact_id":"artifact_old_b"}', 'export_b', 'event_export_input_mismatch_b_terminal', ?, ?, ?)`)
      .run(now, now, now);
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, created_at, updated_at)
      VALUES ('export_queued_stale_b', 'project_b', 'export', 'queued',
        '{"artifact_id":"artifact_old_b"}', ?, ?)`)
      .run(now, now);
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, export_id, error_code, terminal_event_id,
        created_at, finished_at, updated_at)
      VALUES ('assembly_wrong_export_type_b', 'project_b', 'assembly', 'failed', '{}', 'export_b',
        'SYNTHETIC_FAILURE', 'event_assembly_wrong_export_type_b_terminal', ?, ?, ?)`)
      .run(now, now, now);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
      VALUES ('closeout_stale_binding_b', 'project_b', 'closeout', 'exported', 'closed',
        'artifact_old_b', 'export_old_b', 'CLOSEOUT_CONFIRMED', '{}', ?)`)
      .run(now);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
      VALUES ('closeout_duplicate_current_b', 'project_b', 'closeout', 'exported', 'closed',
        'artifact_b', 'export_b', 'CLOSEOUT_DUPLICATE', '{}', ?)`)
      .run("2026-08-14T00:01:00.000Z");
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
      VALUES ('export_succeeded_input_mismatch_b', 'project_b', 'export_input_mismatch_b', 'export_succeeded',
        'approved', 'exported', 'artifact_b', 'export_b', 'SYNTHETIC_SUCCEEDED', '{}', ?)`)
      .run(now);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id, export_id, reason_code, data_json, created_at)
      VALUES ('export_succeeded_wrong_job_b', 'project_b', 'parent_b', 'export_succeeded', 'approved', 'exported',
        'artifact_b', 'export_b', 'SYNTHETIC_SUCCEEDED', '{}', ?)`)
      .run(now);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, reason_code, data_json, created_at)
      VALUES ('assembly_failed_wrong_state_b', 'project_b', 'parent_b', 'assembly_failed', 'closed', 'not_ready',
        'SYNTHETIC_FAILURE', '{}', ?)`)
      .run(now);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, reason_code, data_json, created_at)
      VALUES ('final_review_wrong_current_state_b', 'project_b', 'final_review_accepted', 'final_review', 'approved',
        'artifact_old_b', 'SYNTHETIC_REVIEW', '{}', ?)`)
      .run(now);
    oldArtifact.status = "archived";
    db.prepare("UPDATE media_artifacts SET status = 'archived', data_json = ? WHERE artifact_id = 'artifact_old_b'")
      .run(JSON.stringify(oldArtifact));
    artifact.status = "archived";
    db.prepare("UPDATE media_artifacts SET status = 'archived', data_json = ? WHERE artifact_id = 'artifact_b'")
      .run(JSON.stringify(artifact));
    for (const row of triggerRows) db.exec(row.sql);
    db.exec("PRAGMA foreign_keys = ON");
    assertSchemaCurrent(db);
    db.close();
    db = null;

    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.schema_current, true);
    assert.equal(checked.orphan_rows > 0, true);
    assert.equal(checked.missing_media_files > 0, true);
    assert.equal(checked.check_errors, 0);
    assert.equal(checked.result, "FAIL");
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects approval fingerprints detached from successful assembly evidence", () => {
  const root = tempRoot();
  let db: ReturnType<typeof openM0Database> | null = null;
  try {
    const sqlitePath = join(root, "approval-assembly-drift.sqlite");
    migrateDatabase(sqlitePath);
    db = openM0Database(sqlitePath);
    const fixture = createApprovedDeliveryFixture(db, "approval_assembly_drift");
    const approvalEventId = "event_rework_accepted_approval_assembly_drift";
    const triggerRows = db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'workbench_delivery_events_no_update', 'workbench_delivery_state_transition'
      ) ORDER BY name`).all() as Array<{ name: string; sql: string }>;
    assert.equal(triggerRows.length, 2);
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`DROP TRIGGER workbench_delivery_events_no_update;
      DROP TRIGGER workbench_delivery_state_transition;`);
    const forgedFingerprint = "e".repeat(64);
    db.prepare(`UPDATE workbench_delivery_events SET input_fingerprint = ?
      WHERE event_id = ?`).run(forgedFingerprint, approvalEventId);
    db.prepare(`UPDATE workbench_delivery_state SET assembly_input_fingerprint = ?
      WHERE project_id = ?`).run(forgedFingerprint, fixture.project_id);
    for (const trigger of triggerRows) db.exec(trigger.sql);
    db.exec("PRAGMA foreign_keys = ON");
    assertSchemaCurrent(db);
    db.close();
    db = null;

    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.schema_current, true);
    assert.equal(checked.orphan_rows > 0, true);
    assert.equal(checked.result, "FAIL");
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects duplicate lifecycle Events after the insert guard is bypassed", () => {
  const root = tempRoot();
  let db: ReturnType<typeof openM0Database> | null = null;
  try {
    const sqlitePath = join(root, "duplicate-delivery-event.sqlite");
    migrateDatabase(sqlitePath);
    db = openM0Database(sqlitePath);
    const project = createProject({ title: "Duplicate delivery Event governance" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) throw new Error("duplicate Event project setup failed");
    const now = "2026-08-15T09:00:00.000Z";
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ?
      WHERE project_id = ?`).run(now, project.project_id);
    queueWorkbenchAssemblyFixture(db, {
      project_id: project.project_id,
      job_id: "job_duplicate_event",
      event_id: "event_duplicate_queued",
      created_at: now
    });
    failWorkbenchAssemblyFixture(db, {
      project_id: project.project_id,
      job_id: "job_duplicate_event",
      event_id: "event_duplicate_original",
      created_at: now
    });
    const insertEvent = db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, reason_code, data_json, created_at)
      VALUES (?, ?, 'job_duplicate_event', 'assembly_failed', 'assembling', 'ready_to_assemble',
        'SYNTHETIC_FAILURE', '{}', ?)`);
    const bypassNames = ["workbench_delivery_events_validate_insert",
      "workbench_delivery_events_job_event_unique", "workbench_delivery_assembly_terminal_apply"];
    const bypassDefinitions = bypassNames.map((name) => (db!.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = ?`).get(name) as { sql: string }).sql);
    for (const name of bypassNames) db.exec(`DROP TRIGGER ${name}`);
    insertEvent.run("event_duplicate_first", project.project_id, now);
    insertEvent.run("event_duplicate_second", project.project_id, now);
    for (const definition of bypassDefinitions) db.exec(definition);
    assertSchemaCurrent(db);
    db.close();
    db = null;

    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.schema_current, true);
    assert.equal(checked.orphan_rows > 0, true);
    assert.equal(checked.result, "FAIL");
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects missing, duplicate, and pointer-drifted delivery success evidence", () => {
  const root = tempRoot();
  let db: ReturnType<typeof openM0Database> | null = null;
  try {
    const sqlitePath = join(root, "delivery-success-evidence.sqlite");
    migrateDatabase(sqlitePath);
    db = openM0Database(sqlitePath);
    const now = "2026-08-15T09:15:00.000Z";
    const driftedAt = "2026-08-15T09:16:00.000Z";

    const createAssembled = (suffix: string) => {
      if (!db) throw new Error("delivery success evidence database is unavailable");
      const project = createProject({ title: `Delivery success evidence ${suffix}` }, db);
      assert.equal(project.ok, true);
      if (!project.ok) throw new Error("delivery success evidence project setup failed");
      ensureAcceptedAssemblyClipsFixture(db, project.project_id);
      const artifact = registerMediaArtifact({
        artifact_type: "video",
        role: "final_video",
        source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
        linked_objects: { project_id: project.project_id }
      }, db);
      assert.equal(artifact.ok, true);
      if (!artifact.ok) throw new Error("delivery success evidence Artifact setup failed");
      setProjectFinalArtifactFixture(db, project.project_id, artifact.artifact.artifact_id);
      db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
        .run(now, project.project_id);
      completeWorkbenchAssemblyFixture(db, {
        project_id: project.project_id,
        artifact_id: artifact.artifact.artifact_id,
        job_id: `job_success_assembly_${suffix}`,
        event_id: `event_success_assembly_${suffix}`,
        created_at: now
      });
      const fingerprint = (db.prepare(`SELECT assembly_input_fingerprint FROM workbench_delivery_state
        WHERE project_id = ?`).get(project.project_id) as { assembly_input_fingerprint: string }).assembly_input_fingerprint;
      return { project_id: project.project_id, artifact_id: artifact.artifact.artifact_id, fingerprint };
    };

    const missingAssembly = createAssembled("missing");
    const duplicateAssembly = createAssembled("duplicate");
    const driftedExport = createAssembled("export_drift");
    approveWorkbenchDeliveryFixture(db, {
      project_id: driftedExport.project_id,
      event_id: "event_success_export_accepted",
      created_at: now
    });
    insertWorkbenchExportFixture(db, { project_id: driftedExport.project_id,
      artifact_id: driftedExport.artifact_id, export_id: "export_success_drift", created_at: now });
    completeWorkbenchExportFixture(db, {
      project_id: driftedExport.project_id,
      export_id: "export_success_drift",
      job_id: "job_success_export_drift",
      event_id: "event_success_export_drift",
      created_at: now
    });
    db.close();
    db = null;
    assert.equal(checkDatabase(sqlitePath, { recover_media_activations: false }).result, "PASS");

    db = openM0Database(sqlitePath);
    db.exec("PRAGMA foreign_keys = OFF");
    const triggerSql = (name: string) => (db!.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = ?`).get(name) as { sql: string }).sql;

    const noDelete = triggerSql("workbench_delivery_events_no_delete");
    db.exec("DROP TRIGGER workbench_delivery_events_no_delete");
    db.prepare("DELETE FROM workbench_delivery_events WHERE event_id = 'event_success_assembly_missing'").run();
    db.exec(noDelete);

    const noUpdate = triggerSql("workbench_delivery_events_no_update");
    db.exec("DROP TRIGGER workbench_delivery_events_no_update");
    db.prepare("UPDATE workbench_delivery_events SET created_at = ? WHERE event_id = 'event_success_export_drift'")
      .run(driftedAt);
    db.exec(noUpdate);

    const duplicateTriggerNames = [
      "workbench_delivery_events_validate_insert",
      "workbench_delivery_events_job_event_unique",
      "workbench_delivery_assembly_success_apply"
    ];
    const duplicateTriggers = duplicateTriggerNames.map((name) => triggerSql(name));
    for (const name of duplicateTriggerNames) db.exec(`DROP TRIGGER ${name}`);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id,
        input_fingerprint, reason_code, data_json, created_at)
      VALUES ('event_success_assembly_duplicate_second', ?, 'job_success_assembly_duplicate',
        'assembly_succeeded', 'assembling', 'final_review', ?, ?, 'ASSEMBLY_SUCCEEDED', '{}', ?)`)
      .run(duplicateAssembly.project_id, duplicateAssembly.artifact_id, duplicateAssembly.fingerprint, now);
    for (const definition of duplicateTriggers) db.exec(definition);

    db.exec("PRAGMA foreign_keys = ON");
    assert.doesNotThrow(() => assertSchemaCurrent(db!));
    db.close();
    db = null;

    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.schema_current, true);
    assert.equal(checked.orphan_rows > 0, true);
    assert.equal(checked.result, "FAIL");
    assert.notEqual(missingAssembly.project_id, duplicateAssembly.project_id);
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects missing and timestamp-drifted final review acceptance evidence", () => {
  const root = tempRoot();
  let db: ReturnType<typeof openM0Database> | null = null;
  try {
    const sqlitePath = join(root, "approval-evidence-drift.sqlite");
    migrateDatabase(sqlitePath);
    db = openM0Database(sqlitePath);
    const now = "2026-08-15T09:30:00.000Z";
    const driftedAt = "2026-08-15T09:31:00.000Z";
    const projects: Array<{ project_id: string; artifact_id: string }> = [];
    for (const title of ["Missing approval evidence", "Drifted approval evidence"]) {
      const project = createProject({ title }, db);
      assert.equal(project.ok, true);
      if (!project.ok) throw new Error("approval evidence project setup failed");
      ensureAcceptedAssemblyClipsFixture(db, project.project_id);
      const artifact = registerMediaArtifact({
        artifact_type: "video",
        role: "final_video",
        source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
        linked_objects: { project_id: project.project_id }
      }, db);
      assert.equal(artifact.ok, true);
      if (!artifact.ok) throw new Error("approval evidence Artifact setup failed");
      setProjectFinalArtifactFixture(db, project.project_id, artifact.artifact.artifact_id);
      db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
        .run(now, project.project_id);
      completeWorkbenchAssemblyFixture(db, {
        project_id: project.project_id,
        artifact_id: artifact.artifact.artifact_id,
        job_id: `job_approval_assembly_${projects.length}`,
        event_id: `event_approval_assembly_${projects.length}`,
        created_at: now
      });
      projects.push({ project_id: project.project_id, artifact_id: artifact.artifact.artifact_id });
    }

    approveWorkbenchDeliveryFixture(db, {
      project_id: projects[1].project_id,
      event_id: "event_approval_evidence_before_drift",
      created_at: now
    });
    db.exec("PRAGMA foreign_keys = OFF");
    assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 0);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'approved',
      approved_artifact_id = current_final_artifact_id, updated_at = ? WHERE project_id = ?`)
      .run(now, projects[0].project_id);
    db.prepare("UPDATE workbench_delivery_state SET updated_at = ? WHERE project_id = ?")
      .run(driftedAt, projects[1].project_id);
    db.close();
    db = null;

    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.schema_current, true);
    assert.equal(checked.orphan_rows, 2);
    assert.equal(checked.media_integrity_errors, 0);
    assert.equal(checked.result, "FAIL");
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects first-review missing, approved missing, duplicate, and drifted final rework evidence", () => {
  const root = tempRoot();
  const scenarios = ["first_review_missing", "missing", "duplicate", "drift"] as const;
  try {
    for (const scenario of scenarios) {
      const sqlitePath = join(root, `rework-${scenario}.sqlite`);
      migrateDatabase(sqlitePath);
      const db = openM0Database(sqlitePath);
      const now = "2026-08-15T10:00:00.000Z";
      const fixture = createApprovedDeliveryFixture(db, scenario, now);
      const triggerSql = (name: string) => (db.prepare(`SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = ?`).get(name) as { sql: string }).sql;

      if (scenario === "first_review_missing") {
        const transitionTrigger = triggerSql("workbench_delivery_state_transition");
        const appendOnlyTrigger = triggerSql("workbench_delivery_events_no_delete");
        db.exec("PRAGMA foreign_keys = OFF");
        db.exec("DROP TRIGGER workbench_delivery_state_transition");
        db.exec("DROP TRIGGER workbench_delivery_events_no_delete");
        db.prepare("DELETE FROM workbench_delivery_events WHERE project_id = ? AND event_type = 'final_review_accepted'")
          .run(fixture.project_id);
        db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble',
          approved_artifact_id = NULL, updated_at = ? WHERE project_id = ?`)
          .run("2026-08-15T10:01:00.000Z", fixture.project_id);
        db.exec(transitionTrigger);
        db.exec(appendOnlyTrigger);
        db.exec("PRAGMA foreign_keys = ON");
      } else if (scenario === "missing") {
        const transitionTrigger = triggerSql("workbench_delivery_state_transition");
        db.exec("DROP TRIGGER workbench_delivery_state_transition");
        db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble',
          approved_artifact_id = NULL, updated_at = ? WHERE project_id = ?`)
          .run("2026-08-15T10:01:00.000Z", fixture.project_id);
        db.exec(transitionTrigger);
      } else if (scenario === "duplicate") {
        db.prepare(`INSERT INTO workbench_delivery_events
          (event_id, project_id, event_type, from_state, to_state, artifact_id,
            input_fingerprint, reason_code, data_json, created_at)
          VALUES ('event_rework_first', ?, 'final_review_reassemble', 'approved', 'ready_to_assemble', ?, ?,
            'FINAL_REASSEMBLY_REQUESTED', '{}', ?)`)
          .run(fixture.project_id, fixture.artifact_id, fixture.fingerprint, now);
        const triggerNames = [
          "workbench_delivery_events_validate_insert",
          "workbench_delivery_events_rework_unique",
          "workbench_delivery_rework_apply"
        ];
        const triggerDefinitions = triggerNames.map((name) => triggerSql(name));
        for (const name of triggerNames) db.exec(`DROP TRIGGER ${name}`);
        db.prepare(`INSERT INTO workbench_delivery_events
          (event_id, project_id, event_type, from_state, to_state, artifact_id,
            input_fingerprint, reason_code, data_json, created_at)
          VALUES ('event_rework_duplicate', ?, 'final_review_reassemble', 'approved', 'ready_to_assemble', ?, ?,
            'FINAL_REASSEMBLY_REQUESTED', '{}', '2026-08-15T10:01:00.000Z')`)
          .run(fixture.project_id, fixture.artifact_id, fixture.fingerprint);
        for (const definition of triggerDefinitions) db.exec(definition);
      } else {
        const triggerNames = ["workbench_delivery_events_validate_insert", "workbench_delivery_rework_apply"];
        const triggerDefinitions = triggerNames.map((name) => triggerSql(name));
        for (const name of triggerNames) db.exec(`DROP TRIGGER ${name}`);
        db.prepare(`INSERT INTO workbench_delivery_events
          (event_id, project_id, event_type, from_state, to_state, artifact_id,
            input_fingerprint, reason_code, data_json, created_at)
          VALUES ('event_rework_drift', ?, 'final_review_reassemble', 'approved', 'revision_requested', ?, ?,
            'FINAL_REASSEMBLY_REQUESTED', '{}', ?)`)
          .run(fixture.project_id, fixture.artifact_id, fixture.fingerprint, now);
        for (const definition of triggerDefinitions) db.exec(definition);
      }
      assert.doesNotThrow(() => assertSchemaCurrent(db));
      db.close();

      const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
      assert.equal(checked.schema_current, true);
      assert.ok(checked.orphan_rows >= 1, JSON.stringify(checked));
      assert.equal(checked.result, "FAIL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects a legacy final pointer downgraded without reset evidence", () => {
  const root = tempRoot();
  let db: ReturnType<typeof openM0Database> | null = null;
  try {
    const sqlitePath = join(root, "legacy-reset-missing.sqlite");
    migrateDatabase(sqlitePath);
    db = openM0Database(sqlitePath);
    const project = createProject({ title: "Legacy reset evidence" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) throw new Error("legacy reset project setup failed");
    const artifact = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: project.project_id }
    }, db);
    assert.equal(artifact.ok, true);
    if (!artifact.ok) throw new Error("legacy reset Artifact setup failed");

    const transitionSql = (db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'workbench_delivery_state_transition'`).get() as { sql: string }).sql;
    db.exec("DROP TRIGGER workbench_delivery_state_transition");
    db.prepare(`UPDATE workbench_delivery_state
      SET workflow_state = 'ready_to_assemble', current_final_artifact_id = ?,
        assembly_input_fingerprint = NULL, updated_at = '2026-08-18T02:10:00.000Z'
      WHERE project_id = ?`).run(artifact.artifact.artifact_id, project.project_id);
    db.exec(transitionSql);
    db.close();
    db = null;

    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.schema_current, true);
    assert.ok(checked.orphan_rows >= 1, JSON.stringify(checked));
    assert.equal(checked.result, "FAIL");
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check accepts active historical final Artifacts referenced by succeeded assembly Jobs", () => {
  const root = tempRoot();
  let db: ReturnType<typeof openM0Database> | null = null;
  try {
    const sqlitePath = join(root, "historical-assembly.sqlite");
    migrateDatabase(sqlitePath);
    db = openM0Database(sqlitePath);
    const project = createProject({ title: "Historical assembly evidence" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) throw new Error("historical assembly project setup failed");
    ensureAcceptedAssemblyClipsFixture(db, project.project_id);
    const historical = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: project.project_id }
    }, db);
    const current = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: project.project_id }
    }, db);
    assert.equal(historical.ok, true);
    assert.equal(current.ok, true);
    if (!historical.ok || !current.ok) throw new Error("historical assembly Artifact setup failed");
    setProjectFinalArtifactFixture(db, project.project_id, current.artifact.artifact_id);
    const now = "2026-08-14T03:00:00.000Z";
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, project.project_id);
    completeWorkbenchAssemblyFixture(db, {
      project_id: project.project_id,
      artifact_id: historical.artifact.artifact_id,
      job_id: "job_historical_assembly",
      event_id: "event_historical_assembly",
      created_at: now
    });
    const historicalFingerprint = (db.prepare(`SELECT assembly_input_fingerprint FROM workbench_delivery_state
      WHERE project_id = ?`).get(project.project_id) as { assembly_input_fingerprint: string }).assembly_input_fingerprint;
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, input_fingerprint, reason_code, data_json, created_at)
      VALUES ('event_historical_reassemble', ?, 'final_review_reassemble', 'final_review', 'ready_to_assemble', ?,
        ?, 'FINAL_REASSEMBLY_REQUESTED', '{}', ?)`)
      .run(project.project_id, historical.artifact.artifact_id, historicalFingerprint, now);
    completeWorkbenchAssemblyFixture(db, {
      project_id: project.project_id,
      artifact_id: current.artifact.artifact_id,
      job_id: "job_current_assembly",
      event_id: "event_current_assembly",
      created_at: now
    });
    approveWorkbenchDeliveryFixture(db, {
      project_id: project.project_id,
      event_id: "event_current_accepted",
      created_at: now
    });
    const currentFingerprint = (db.prepare(`SELECT assembly_input_fingerprint FROM workbench_delivery_state
      WHERE project_id = ?`).get(project.project_id) as { assembly_input_fingerprint: string }).assembly_input_fingerprint;
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, event_type, from_state, to_state, artifact_id, input_fingerprint, reason_code, data_json, created_at)
      VALUES ('event_current_reassemble', ?, 'final_review_reassemble', 'approved', 'ready_to_assemble', ?,
        ?, 'FINAL_REASSEMBLY_REQUESTED', '{}', ?)`)
      .run(project.project_id, current.artifact.artifact_id, currentFingerprint, now);
    const deactivated = transitionMediaArtifactStatus(historical.artifact.artifact_id, "archived", db);
    assert.equal(deactivated.ok ? null : deactivated.error.code, "WORKBENCH_DELIVERY_ARTIFACT_ACTIVE_REQUIRED");
    db.close();
    db = null;

    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.orphan_rows, 0);
    assert.equal(checked.result, "PASS");
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("succeeded assembly input clips remain active and db:check detects bypassed drift", () => {
  const root = tempRoot();
  let db: ReturnType<typeof openM0Database> | null = null;
  try {
    const sqlitePath = join(root, "assembly-input-evidence.sqlite");
    migrateDatabase(sqlitePath);
    db = openM0Database(sqlitePath);
    const project = createProject({ title: "Assembly input evidence" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) throw new Error("assembly input evidence project setup failed");
    const shot = buildStoryboardApprovedShot({
      project_id: project.project_id,
      order: 1,
      duration_seconds: 2,
      storyboard_image_artifact_id: "",
      video_prompt: "Preserve the accepted source clip."
    });
    saveShot(db, shot);
    const clip = registerMediaArtifact({
      artifact_type: "video",
      role: "generated_clip",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: project.project_id, shot_id: shot.shot_id }
    }, db);
    const finalArtifact = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: project.project_id }
    }, db);
    assert.equal(clip.ok, true);
    assert.equal(finalArtifact.ok, true);
    if (!clip.ok || !finalArtifact.ok) throw new Error("assembly input evidence media setup failed");
    shot.status = "video_review";
    shot.accepted_clip_artifact_id = clip.artifact.artifact_id;
    shot.clip_versions = [{
      artifact_id: clip.artifact.artifact_id,
      run_id: "run_assembly_input_evidence",
      attempt_number: 1,
      review_status: "approved"
    }];
    shot.review.approval_status = "approved";
    saveShot(db, shot);
    setProjectFinalArtifactFixture(db, project.project_id, finalArtifact.artifact.artifact_id);
    const now = "2026-08-17T03:00:00.000Z";
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, project.project_id);
    completeWorkbenchAssemblyFixture(db, {
      project_id: project.project_id,
      artifact_id: finalArtifact.artifact.artifact_id,
      job_id: "job_assembly_input_evidence",
      event_id: "event_assembly_input_evidence",
      created_at: now
    });

    const statusGuard = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger'
      AND name = 'workbench_delivery_artifact_status_guard'`).get() as { sql: string }).sql;
    db.exec("DROP TRIGGER workbench_delivery_artifact_status_guard");
    db.prepare(`UPDATE media_artifacts SET status = 'archived',
      data_json = json_set(data_json, '$.status', 'archived') WHERE artifact_id = ?`)
      .run(clip.artifact.artifact_id);
    db.exec(statusGuard);
    assert.doesNotThrow(() => assertSchemaCurrent(db!));
    db.close();
    db = null;

    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.schema_current, true);
    assert.ok(checked.orphan_rows >= 1, JSON.stringify(checked));
    assert.equal(checked.result, "FAIL");
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects an assembly fingerprint that no longer matches canonical Job input", () => {
  const root = tempRoot();
  let db: ReturnType<typeof openM0Database> | null = null;
  try {
    const sqlitePath = join(root, "assembly-fingerprint-drift.sqlite");
    migrateDatabase(sqlitePath);
    db = openM0Database(sqlitePath);
    const project = createProject({ title: "Assembly fingerprint governance" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) throw new Error("assembly fingerprint project setup failed");
    ensureAcceptedAssemblyClipsFixture(db, project.project_id);
    const finalArtifact = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: project.project_id }
    }, db);
    assert.equal(finalArtifact.ok, true);
    if (!finalArtifact.ok) throw new Error("assembly fingerprint Artifact setup failed");
    setProjectFinalArtifactFixture(db, project.project_id, finalArtifact.artifact.artifact_id);
    const now = "2026-08-17T03:30:00.000Z";
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(now, project.project_id);
    completeWorkbenchAssemblyFixture(db, {
      project_id: project.project_id,
      artifact_id: finalArtifact.artifact.artifact_id,
      job_id: "job_assembly_fingerprint_drift",
      event_id: "event_assembly_fingerprint_drift",
      created_at: now
    });

    const triggerNames = [
      "workbench_delivery_jobs_validate_bindings_update",
      "workbench_delivery_jobs_identity_immutable",
      "workbench_delivery_jobs_terminal_immutable",
      "workbench_delivery_events_no_update",
      "workbench_delivery_state_transition"
    ];
    const triggerSql = triggerNames.map((name) => (db!.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = ?`).get(name) as { sql: string }).sql);
    db.exec("PRAGMA foreign_keys = OFF");
    for (const name of triggerNames) db.exec(`DROP TRIGGER ${name}`);
    const forgedFingerprint = "0".repeat(64);
    db.prepare("UPDATE workbench_delivery_jobs SET input_fingerprint = ? WHERE job_id = 'job_assembly_fingerprint_drift'")
      .run(forgedFingerprint);
    db.prepare("UPDATE workbench_delivery_events SET input_fingerprint = ? WHERE job_id = 'job_assembly_fingerprint_drift'")
      .run(forgedFingerprint);
    db.prepare("UPDATE workbench_delivery_state SET assembly_input_fingerprint = ? WHERE project_id = ?")
      .run(forgedFingerprint, project.project_id);
    for (const definition of triggerSql) db.exec(definition);
    db.exec("PRAGMA foreign_keys = ON");
    assertSchemaCurrent(db);
    db.close();
    db = null;

    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.schema_current, true);
    assert.ok(checked.orphan_rows >= 1, JSON.stringify(checked));
    assert.equal(checked.result, "FAIL");
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects zero-SHOT and partial-SHOT succeeded assembly evidence", () => {
  const root = tempRoot();
  let db: ReturnType<typeof openM0Database> | null = null;
  try {
    const sqlitePath = join(root, "assembly-shot-coverage.sqlite");
    migrateDatabase(sqlitePath);
    db = openM0Database(sqlitePath);
    const now = "2026-08-17T11:00:00.000Z";

    const emptyProject = createProject({ title: "Zero SHOT assembly evidence" }, db);
    assert.equal(emptyProject.ok, true);
    if (!emptyProject.ok) throw new Error("zero SHOT assembly project setup failed");
    const emptyFinal = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: emptyProject.project_id }
    }, db);
    assert.equal(emptyFinal.ok, true);
    if (!emptyFinal.ok) throw new Error("zero SHOT final Artifact setup failed");

    const partialProject = createProject({ title: "Partial SHOT assembly evidence" }, db);
    assert.equal(partialProject.ok, true);
    if (!partialProject.ok) throw new Error("partial SHOT assembly project setup failed");
    const first = createAcceptedAssemblyClipFixture(db, {
      project_id: partialProject.project_id, order: 1, label: "coverage first"
    });
    createAcceptedAssemblyClipFixture(db, {
      project_id: partialProject.project_id, order: 2, label: "coverage second"
    });
    const partialFinal = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: partialProject.project_id }
    }, db);
    assert.equal(partialFinal.ok, true);
    if (!partialFinal.ok) throw new Error("partial SHOT final Artifact setup failed");

    const approvalProject = createProject({ title: "Unapproved SHOT assembly evidence" }, db);
    assert.equal(approvalProject.ok, true);
    if (!approvalProject.ok) throw new Error("unapproved SHOT assembly project setup failed");
    const approvalClip = createAcceptedAssemblyClipFixture(db, {
      project_id: approvalProject.project_id, label: "approval drift"
    });
    const approvalFinal = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: approvalProject.project_id }
    }, db);
    assert.equal(approvalFinal.ok, true);
    if (!approvalFinal.ok) throw new Error("unapproved SHOT final Artifact setup failed");
    setProjectFinalArtifactFixture(db, approvalProject.project_id, approvalFinal.artifact.artifact_id);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ?
      WHERE project_id = ?`).run(now, approvalProject.project_id);
    completeWorkbenchAssemblyFixture(db, {
      project_id: approvalProject.project_id,
      artifact_id: approvalFinal.artifact.artifact_id,
      job_id: "job_assembly_approval_drift",
      event_id: "event_assembly_approval_drift",
      created_at: now
    });

    const cleanCheck = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(cleanCheck.result, "PASS", JSON.stringify(cleanCheck));
    db.prepare(`UPDATE shots SET data_json = json_set(
        data_json,
        '$.status', 'revision_needed',
        '$.review.approval_status', 'revision_needed',
        '$.clip_versions[0].review_status', 'rejected'
      ), updated_at = ? WHERE shot_id = ?`).run("2026-08-17T11:00:01.000Z", approvalClip.shot_id);
    const insertGuard = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger'
      AND name = 'workbench_delivery_jobs_validate_insert'`).get() as { sql: string }).sql;
    db.exec("DROP TRIGGER workbench_delivery_jobs_validate_insert");
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, output_artifact_id, terminal_event_id,
        created_at, started_at, finished_at, updated_at)
      VALUES ('job_assembly_zero_shot_bypass', ?, 'assembly', 'succeeded',
        '{"source_clip_artifact_ids":[]}', ?, 'event_assembly_zero_shot_bypass_terminal', ?, ?, ?, ?)`)
      .run(emptyProject.project_id, emptyFinal.artifact.artifact_id, now, now, now, now);
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_json, output_artifact_id, terminal_event_id,
        created_at, started_at, finished_at, updated_at)
      VALUES ('job_assembly_partial_shot_bypass', ?, 'assembly', 'succeeded',
        json_object('source_clip_artifact_ids', json_array(?)), ?,
        'event_assembly_partial_shot_bypass_terminal', ?, ?, ?, ?)`)
      .run(partialProject.project_id, first.artifact_id, partialFinal.artifact.artifact_id,
        now, now, now, now);
    db.exec(insertGuard);
    db.exec("PRAGMA foreign_keys = ON");
    assert.doesNotThrow(() => assertSchemaCurrent(db!));
    db.close();
    db = null;

    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.schema_current, true);
    assert.ok(checked.orphan_rows >= 3, JSON.stringify(checked));
    assert.equal(checked.result, "FAIL");
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects an active assembly whose inputs reverse canonical SHOT order", () => {
  const root = tempRoot();
  let db: ReturnType<typeof openM0Database> | null = null;
  try {
    const sqlitePath = join(root, "assembly-input-order.sqlite");
    migrateDatabase(sqlitePath);
    db = openM0Database(sqlitePath);
    const now = "2026-08-17T12:00:00.000Z";
    const project = createProject({ title: "Reversed assembly input order" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) throw new Error("assembly order project setup failed");
    const first = createAcceptedAssemblyClipFixture(db, {
      project_id: project.project_id, order: 1, label: "order first"
    });
    const second = createAcceptedAssemblyClipFixture(db, {
      project_id: project.project_id, order: 2, label: "order second"
    });
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ?
      WHERE project_id = ?`).run(now, project.project_id);
    assert.equal(checkDatabase(sqlitePath, { recover_media_activations: false }).result, "PASS");

    const reversedInput = JSON.stringify({ source_clip_artifact_ids: [second.artifact_id, first.artifact_id] });
    const reversedFingerprint = workbenchAssemblyInputFingerprint(db, project.project_id,
      [second.artifact_id, first.artifact_id]);
    assert.ok(reversedFingerprint);
    const insertGuard = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger'
      AND name = 'workbench_delivery_jobs_validate_insert'`).get() as { sql: string }).sql;
    db.exec("DROP TRIGGER workbench_delivery_jobs_validate_insert; BEGIN IMMEDIATE");
    db.prepare(`INSERT INTO workbench_delivery_jobs
      (job_id, project_id, job_type, state, input_fingerprint, input_json, created_at, updated_at)
      VALUES ('job_assembly_reversed_bypass', ?, 'assembly', 'queued', ?, ?, ?, ?)`)
      .run(project.project_id, reversedFingerprint, reversedInput, now, now);
    db.prepare(`INSERT INTO workbench_delivery_events
      (event_id, project_id, job_id, event_type, from_state, to_state, input_fingerprint,
        reason_code, data_json, created_at)
      VALUES ('event_assembly_reversed_bypass', ?, 'job_assembly_reversed_bypass',
        'assembly_queued', 'ready_to_assemble', 'assembling', ?, 'ASSEMBLY_QUEUED', '{}', ?)`)
      .run(project.project_id, reversedFingerprint, now);
    db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'assembling',
      active_assembly_job_id = 'job_assembly_reversed_bypass', assembly_input_fingerprint = ?, updated_at = ?
      WHERE project_id = ?`).run(reversedFingerprint, now, project.project_id);
    db.exec("COMMIT");
    db.exec(insertGuard);
    assertSchemaCurrent(db);
    db.close();
    db = null;

    const checked = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(checked.schema_current, true);
    assert.equal(checked.orphan_rows, 1, JSON.stringify(checked));
    assert.equal(checked.result, "FAIL");
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects package and batch drift plus missing batch links", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "links.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_links', ?)")
      .run(JSON.stringify({ project_id: "project_links", active_storyboard_package_id: "package_cross_project" }));
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_package_owner', ?)")
      .run(JSON.stringify({ project_id: "project_package_owner" }));
    db.prepare("INSERT INTO storyboard_packages (storyboard_package_id, project_id, data_json) VALUES ('package_drift', 'project_links', ?)")
      .run(JSON.stringify({ storyboard_package_id: "package_other", project_id: "project_links" }));
    db.prepare("INSERT INTO storyboard_packages (storyboard_package_id, project_id, data_json) VALUES ('package_cross_project', 'project_package_owner', ?)")
      .run(JSON.stringify({ storyboard_package_id: "package_cross_project", project_id: "project_package_owner" }));
    db.prepare("INSERT INTO generation_batches (batch_id, project_id, storyboard_package_id, data_json) VALUES ('batch_orphan_package', 'project_links', 'package_missing', ?)")
      .run(JSON.stringify({ batch_id: "batch_orphan_package", project_id: "project_links", storyboard_package_id: "package_missing" }));
    db.prepare("INSERT INTO generation_batches (batch_id, project_id, storyboard_package_id, data_json) VALUES ('batch_cross_project', 'project_links', 'package_cross_project', ?)")
      .run(JSON.stringify({ batch_id: "batch_cross_project", project_id: "project_links", storyboard_package_id: "package_cross_project" }));
    db.prepare("INSERT INTO generation_runs (run_id, batch_id, project_id, shot_id, run_type, status, data_json) VALUES ('run_orphan_batch', 'batch_missing', 'project_links', '', 'image_to_video', 'queued', ?)")
      .run(JSON.stringify({ run_id: "run_orphan_batch", batch_id: "batch_missing", project_id: "project_links", shot_id: "" }));
    db.close();

    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.structured_drift_rows, 1);
    assert.equal(checked.orphan_rows, 4);
    assert.equal(checked.result, "FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects run and artifact link drift", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "link-drift.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_link_drift', ?)")
      .run(JSON.stringify({ project_id: "project_link_drift" }));
    db.prepare("INSERT INTO generation_runs (run_id, batch_id, project_id, shot_id, run_type, status, data_json) VALUES ('run_link_drift', '', 'project_link_drift', '', 'image_to_video', 'queued', ?)")
      .run(JSON.stringify({ run_id: "run_link_drift", batch_id: "batch_wrong", project_id: "project_link_drift", shot_id: "shot_wrong" }));
    insertUnverifiedArtifact(db, { artifact_id: "artifact_link_drift", project_id: "project_link_drift", uri: "https://media.example.test/artifact_link_drift.png" });
    const driftedArtifact = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = 'artifact_link_drift'").get() as { data_json: string };
    const driftedJson = JSON.parse(driftedArtifact.data_json) as { linked_objects: { project_id: string; shot_id: string } };
    driftedJson.linked_objects = { project_id: "project_wrong", shot_id: "shot_wrong" };
    db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = 'artifact_link_drift'").run(JSON.stringify(driftedJson));
    db.close();

    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.structured_drift_rows, 2);
    assert.equal(checked.result, "FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database check detects every regeneration request mirror-field drift", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "regeneration-request-drift.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    db.prepare("INSERT INTO projects (project_id, data_json) VALUES ('project_regen_drift', ?)")
      .run(JSON.stringify({ project_id: "project_regen_drift" }));
    db.prepare("INSERT INTO shots (shot_id, project_id, data_json) VALUES ('shot_regen_drift', 'project_regen_drift', ?)")
      .run(JSON.stringify({ shot_id: "shot_regen_drift", project_id: "project_regen_drift" }));
    insertUnverifiedArtifact(db, {
      artifact_id: "artifact_regen_drift",
      project_id: "project_regen_drift",
      shot_id: "shot_regen_drift",
      uri: "https://media.example.test/artifact_regen_drift.png"
    });

    const mirroredFields = ["request_id", "project_id", "shot_id", "artifact_id", "previous_run_id", "status"] as const;
    const insertRequest = db.prepare("INSERT INTO regeneration_requests (request_id, project_id, shot_id, artifact_id, previous_run_id, status, data_json) VALUES (?, 'project_regen_drift', 'shot_regen_drift', 'artifact_regen_drift', 'run_regen_drift', 'draft', ?)");
    for (const field of mirroredFields) {
      const requestId = `request_${field}_drift`;
      const data = {
        request_id: requestId,
        project_id: "project_regen_drift",
        shot_id: "shot_regen_drift",
        artifact_id: "artifact_regen_drift",
        previous_run_id: "run_regen_drift",
        status: "draft"
      };
      data[field] = field === "status" ? "submitted" : `${data[field]}_wrong`;
      insertRequest.run(requestId, JSON.stringify(data));
    }
    db.close();

    const checked = checkDatabase(sqlitePath);
    assert.equal(checked.structured_drift_rows, mirroredFields.length);
    assert.equal(checked.orphan_rows, 0);
    assert.equal(checked.missing_media_files, 0);
    assert.equal(checked.result, "FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider task IDs are unique per provider at the database boundary", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const db = new DatabaseSync(sqlitePath);
    const artifact = (artifactId: string) => JSON.stringify({ artifact_id: artifactId, source: { provider: "runninghub", provider_job_id: "task_unique" } });
    db.prepare("INSERT INTO media_artifacts (artifact_id, role, artifact_type, status, data_json) VALUES (?, 'generated_clip', 'video', 'active', ?)")
      .run("artifact_unique_1", artifact("artifact_unique_1"));
    assert.throws(() => db.prepare("INSERT INTO media_artifacts (artifact_id, role, artifact_type, status, data_json) VALUES (?, 'generated_clip', 'video', 'active', ?)")
      .run("artifact_unique_2", artifact("artifact_unique_2")), /UNIQUE constraint failed/);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact persistence preserves the existing row on provider task conflicts", () => {
  const root = tempRoot();
  const mediaPath = join(paths.videoArtifactsRoot, `${basename(root)}-provider-conflict.mp4`);
  let db: ReturnType<typeof openM0Database> | null = null;
  try {
    const sqlitePath = join(root, "artifact-provider-task-conflict.sqlite");
    migrateDatabase(sqlitePath);
    mkdirSync(dirname(mediaPath), { recursive: true });
    copyFileSync(resolve("fixtures/video/mock_clip.mp4"), mediaPath);
    db = openM0Database(sqlitePath);
    const activeDb = db;
    const artifact = (artifactId: string, status: MediaArtifact["status"] = "active"): MediaArtifact => ({
      artifact_id: artifactId,
      blob_id: "",
      artifact_type: "video",
      role: "generated_clip",
      status,
      storage: { uri: mediaPath, mime_type: "video/mp4", filename: "mock_clip.mp4" },
      metadata: { width: 1080, height: 1920, duration_seconds: 6, aspect_ratio: "9:16", sha256: `sha-${artifactId}` },
      linked_objects: { project_id: "project_artifact_conflict", shot_id: "shot_artifact_conflict" },
      source: { kind: "provider_output_file", provider: "runninghub", provider_job_id: "task_artifact_conflict", sha256: `sha-${artifactId}`, external_url_host: "cdn.example.test" }
    });

    persistMediaArtifact(activeDb, artifact("artifact_original"));
    activeDb.prepare("INSERT INTO generation_runs (run_id, batch_id, project_id, shot_id, run_type, status, data_json) VALUES ('run_artifact_reference', '', 'project_artifact_conflict', 'shot_artifact_conflict', 'image_to_video', 'succeeded', ?)")
      .run(JSON.stringify({ run_id: "run_artifact_reference", output: { artifact_ids: ["artifact_original"] } }));

    assert.throws(() => persistMediaArtifact(activeDb, artifact("artifact_conflicting")), /UNIQUE constraint failed/);
    const rowsAfterConflict = activeDb.prepare("SELECT artifact_id FROM media_artifacts WHERE json_extract(data_json, '$.source.provider_job_id') = 'task_artifact_conflict'").all() as Array<{ artifact_id: string }>;
    assert.deepEqual(rowsAfterConflict.map((row) => row.artifact_id), ["artifact_original"]);
    const referencedRun = activeDb.prepare("SELECT data_json FROM generation_runs WHERE run_id = 'run_artifact_reference'").get() as { data_json: string };
    assert.deepEqual((JSON.parse(referencedRun.data_json) as { output: { artifact_ids: string[] } }).output.artifact_ids, ["artifact_original"]);

    const archived = transitionMediaArtifactStatus("artifact_original", "archived", activeDb);
    assert.equal(archived.ok, true);
    const updated = activeDb.prepare("SELECT status, data_json FROM media_artifacts WHERE artifact_id = 'artifact_original'").get() as { status: string; data_json: string };
    assert.equal(updated.status, "archived");
    assert.equal((JSON.parse(updated.data_json) as MediaArtifact).status, "archived");
    activeDb.close();
    db = null;
  } finally {
    try { db?.close(); } catch { /* retain the primary assertion failure */ }
    rmSync(mediaPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing v2-4 database fails with a stable reconciliation gate for duplicate provider tasks", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "duplicate-provider-task.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec(M0_BASE_SCHEMA_SQL);
    initializeWorkbenchV2Schema(db);
    const artifact = (artifactId: string) => JSON.stringify({ artifact_id: artifactId, source: { provider: "runninghub", provider_job_id: "legacy_duplicate_task" } });
    for (const artifactId of ["artifact_legacy_dup_1", "artifact_legacy_dup_2"]) {
      db.prepare("INSERT INTO media_artifacts (artifact_id, role, artifact_type, status, data_json) VALUES (?, 'generated_clip', 'video', 'active', ?)")
        .run(artifactId, artifact(artifactId));
    }
    assert.throws(() => runDatabaseMigrations(db), (error) => error instanceof SchemaMigrationRequiredError
      && error.code === "SCHEMA_MIGRATION_REQUIRED"
      && /PROVIDER_TASK_DUPLICATES_REQUIRE_RECONCILIATION: 1 duplicate provider task group/.test(error.message));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    assert.equal(tables.some((row) => row.name === "generation_jobs"), false);
    assert.equal(tables.some((row) => row.name === "schema_migrations"), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM media_artifacts").get() as { count: number }).count, 2);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration fails cleanly when another connection owns the migration lock", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    const owner = new DatabaseSync(sqlitePath);
    owner.exec(M0_BASE_SCHEMA_SQL);
    owner.exec("BEGIN EXCLUSIVE");
    assert.throws(() => migrateDatabase(sqlitePath), /locked/i);
    owner.exec("ROLLBACK");
    owner.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup and isolated restore preserve a valid database", () => {
  const root = tempRoot();
  try {
    const sqlitePath = join(root, "app.sqlite");
    migrateDatabase(sqlitePath);
    const backup = backupDatabase({ sqlite_path: sqlitePath, backup_root: join(root, "backups"), timestamp: new Date("2026-07-11T00:00:00.000Z") });
    const restoredPath = join(root, "restored.sqlite");
    copyFileSync(backup.backup_path, restoredPath);
    assert.equal(checkDatabase(restoredPath).result, "PASS");
    assert.deepEqual(databaseLogicalManifest(restoredPath), databaseLogicalManifest(sqlitePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration checksum is deterministic", () => {
  assert.equal(migrationChecksum(DATABASE_MIGRATIONS[0]), migrationChecksum(DATABASE_MIGRATIONS[0]));
  assert.notEqual(migrationChecksum(DATABASE_MIGRATIONS[0]), migrationChecksum(DATABASE_MIGRATIONS[1]));
  assert.doesNotMatch(DATABASE_MIGRATIONS[1].canonical, /function\s+initializeWorkbenchV2Schema/);
});
