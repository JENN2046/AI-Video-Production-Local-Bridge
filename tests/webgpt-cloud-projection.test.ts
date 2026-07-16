import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { bindWebGptPrincipalIssuer, bootstrapWebGptProjectOwner, registerWebGptPrincipal } from "../src/webgpt-v4/authorizationAdmin.js";
import { actorFromFederatedSubject, type WebGptV4Result } from "../src/webgpt-v4/types.js";
import { openM0Database, openM0DatabaseConnection, type M0Database } from "../src/storage/sqlite.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import {
  exportReadonlySnapshotFromDatabase,
  ReadonlyProjectionError,
  SnapshotReadonlyDataSource,
  SqliteReadonlyDataSource
} from "../src/webgpt-cloud/dataSource.js";
import {
  canonicalizeJcs,
  finalizeReadonlySnapshot,
  parseReadonlySnapshot,
  readonlySnapshotStatus,
  snapshotFingerprint,
  type ReadonlySnapshotUnsigned
} from "../src/webgpt-cloud/snapshot.js";

const ISSUER = "https://issuer.example.test/";
const RESOURCE = "https://aivideo.example.test/mcp";

function stableValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return { buffer_sha256: createHash("sha256").update(value).digest("hex") };
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
}

function logicalManifest(db: M0Database): { table_count: number; row_count: number; sha256: string } {
  const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  let rowCount = 0;
  const payload = tables.map((name) => {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("unsafe fixture table name");
    const rows = (db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>).map(stableValue);
    rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    rowCount += rows.length;
    return { name, rows };
  });
  return { table_count: tables.length, row_count: rowCount, sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

function createFixture(sqlitePath: string): {
  actor: ReturnType<typeof actorFromFederatedSubject>;
  unassigned_actor: ReturnType<typeof actorFromFederatedSubject>;
  project_id: string;
  hidden_project_id: string;
  shot_id: string;
} {
  const db = openM0Database(sqlitePath);
  try {
    const created = createProject({ title: "Readonly MCP App fixture" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("fixture setup failed");
    db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
    const shot: Shot = {
      shot_id: "shot_cloud_projection_001",
      project_id: created.project_id,
      order: 1,
      status: "storyboard_approved",
      duration_seconds: 6,
      description: "Readonly projection shot",
      storyboard_image_artifact_id: "",
      video_prompt: "A safe fixture prompt",
      negative_prompt: "",
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    saveShot(db, shot);
    created.project.shot_ids = [shot.shot_id];
    saveProject(db, created.project);
    const actor = actorFromFederatedSubject(ISSUER, "readonly-cloud-owner", ["projects.read"]);
    bootstrapWebGptProjectOwner(db, actor.principal_id, created.project_id, "READONLY_CLOUD_FIXTURE", actor.issuer_hash!);
    const hidden = createProject({ title: "Hidden production fixture" }, db);
    assert.equal(hidden.ok, true);
    if (!hidden.ok) throw new Error("hidden fixture setup failed");
    db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(hidden.project_id);
    const unassignedActor = actorFromFederatedSubject(ISSUER, "readonly-cloud-unassigned", ["projects.read"]);
    registerWebGptPrincipal(db, unassignedActor.principal_id, "READONLY_CLOUD_UNASSIGNED");
    bindWebGptPrincipalIssuer(db, unassignedActor.principal_id, unassignedActor.issuer_hash!);
    return { actor, unassigned_actor: unassignedActor, project_id: created.project_id, hidden_project_id: hidden.project_id, shot_id: shot.shot_id };
  } finally {
    db.close();
  }
}

function resultData(result: WebGptV4Result<unknown>): unknown {
  if (!result.ok) throw new Error(result.error.code);
  return result.data;
}

function stripMeta(result: ReturnType<SqliteReadonlyDataSource["listProductionProjects"]>): unknown {
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

test("readonly projection requires migration 0008 and never upgrades an older database", () => {
  const root = mkdtempSync(join(tmpdir(), "readonly-projection-ledger-"));
  const sqlitePath = join(root, "app.sqlite");
  const db = openM0Database(sqlitePath);
  db.exec(`
    DROP TABLE webgpt_auth_principal_bindings;
    DELETE FROM schema_migrations WHERE migration_id = '0008';
  `);
  db.close();
  try {
    assert.throws(
      () => exportReadonlySnapshotFromDatabase({
        database_path: sqlitePath,
        issuer_hash: "a".repeat(64),
        resource_url: RESOURCE
      }),
      (error) => error instanceof ReadonlyProjectionError && error.code === "READONLY_PROJECTION_SCHEMA_MIGRATION_REQUIRED"
    );
    const verify = openM0DatabaseConnection(sqlitePath, { readOnly: true });
    try {
      assert.equal((verify.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE migration_id = '0008'").get() as { count: number }).count, 0);
      assert.equal((verify.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE type = 'table' AND name = 'webgpt_auth_principal_bindings'").get() as { count: number }).count, 0);
    } finally {
      verify.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite and Snapshot readonly adapters preserve six-tool DTO parity and database zero-write manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "readonly-projection-parity-"));
  const sqlitePath = join(root, "app.sqlite");
  const fixture = createFixture(sqlitePath);
  const beforeDb = openM0DatabaseConnection(sqlitePath, { readOnly: true });
  const before = logicalManifest(beforeDb);
  beforeDb.close();
  const generatedAt = new Date(Date.now() - 60_000).toISOString();
  const snapshot = exportReadonlySnapshotFromDatabase({
    database_path: sqlitePath,
    issuer_hash: fixture.actor.issuer_hash!,
    resource_url: RESOURCE,
    generated_at: generatedAt,
    ttl_seconds: 3600
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /"(?:local_path|provider_payload|actor_hash|subject|idempotency_key)":/);
  const db = openM0DatabaseConnection(sqlitePath, { readOnly: true });
  try {
    const sqlite = new SqliteReadonlyDataSource(db, fixture.actor.principal_id, fixture.actor.issuer_hash!);
    const projected = new SnapshotReadonlyDataSource(snapshot, fixture.actor.principal_id, fixture.actor.issuer_hash!);
    const pairs = [
      [sqlite.listProductionProjects({ detail: "compact" }, "same"), projected.listProductionProjects({ detail: "compact" }, "same")],
      [sqlite.listProductionProjects({ detail: "full", query: "%MCP_App%" }, "same"), projected.listProductionProjects({ detail: "full", query: "%MCP_App%" }, "same")],
      [sqlite.getProjectContext({ project_id: fixture.project_id, workspace: "overview", detail: "compact" }, "same"), projected.getProjectContext({ project_id: fixture.project_id, workspace: "overview", detail: "compact" }, "same")],
      [sqlite.listProjectShots({ project_id: fixture.project_id, detail: "full" }, "same"), projected.listProjectShots({ project_id: fixture.project_id, detail: "full" }, "same")],
      [sqlite.getReviewPackage({ project_id: fixture.project_id, shot_id: fixture.shot_id, detail: "compact" }, "same"), projected.getReviewPackage({ project_id: fixture.project_id, shot_id: fixture.shot_id, detail: "compact" }, "same")],
      [sqlite.getDeliveryStatus(fixture.project_id, "same"), projected.getDeliveryStatus(fixture.project_id, "same")],
      [sqlite.getCloseoutEvidence(fixture.project_id, "same"), projected.getCloseoutEvidence(fixture.project_id, "same")]
    ];
    for (const [local, cloud] of pairs) assert.deepEqual(stripMeta(cloud), stripMeta(local));
    assert.equal((resultData(projected.listProductionProjects()) as { items: unknown[] }).items.length, 1);
    assert.deepEqual(
      stripMeta(projected.getProjectContext({ project_id: fixture.hidden_project_id }, "same")),
      stripMeta(sqlite.getProjectContext({ project_id: fixture.hidden_project_id }, "same"))
    );
    const emptySqlite = new SqliteReadonlyDataSource(db, fixture.unassigned_actor.principal_id, fixture.unassigned_actor.issuer_hash!);
    const emptySnapshot = new SnapshotReadonlyDataSource(snapshot, fixture.unassigned_actor.principal_id, fixture.unassigned_actor.issuer_hash!);
    assert.deepEqual(stripMeta(emptySnapshot.listProductionProjects({}, "same")), stripMeta(emptySqlite.listProductionProjects({}, "same")));
    assert.equal((resultData(emptySnapshot.listProductionProjects()) as { items: unknown[] }).items.length, 0);

    for (const source of [
      new SqliteReadonlyDataSource(db, "f".repeat(64), fixture.actor.issuer_hash!),
      new SqliteReadonlyDataSource(db, fixture.actor.principal_id, "e".repeat(64))
    ]) {
      const denied = [
        source.listProductionProjects({}, "auth-denied"),
        source.getProjectContext({ project_id: fixture.project_id }, "auth-denied"),
        source.listProjectShots({ project_id: fixture.project_id }, "auth-denied"),
        source.getReviewPackage({ project_id: fixture.project_id, shot_id: fixture.shot_id }, "auth-denied"),
        source.getDeliveryStatus(fixture.project_id, "auth-denied"),
        source.getCloseoutEvidence(fixture.project_id, "auth-denied")
      ];
      for (const result of denied) {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "WEBGPT_PRINCIPAL_NOT_REGISTERED");
      }
    }
  } finally {
    db.close();
  }
  const afterDb = openM0DatabaseConnection(sqlitePath, { readOnly: true });
  try {
    assert.deepEqual(logicalManifest(afterDb), before);
  } finally {
    afterDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot fingerprint uses deterministic JCS input and server time remains authoritative", () => {
  assert.equal(canonicalizeJcs({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalizeJcs({ a: -0 }), '{"a":0}');
  assert.throws(() => canonicalizeJcs("\ud800"), /JCS_INVALID_UNICODE/);
  const generatedAt = "2026-07-16T00:00:00.000Z";
  const unsigned: ReadonlySnapshotUnsigned = {
    schema_version: "readonly-snapshot-v1",
    source_schema: "workbench-v2-5",
    source_migration: "0008",
    source_version: "webgpt-v4.2.0",
    generated_at: generatedAt,
    expires_at: "2026-07-16T01:00:00.000Z",
    resource_url: RESOURCE,
    issuer_hash: "a".repeat(64),
    authorization: { principals: [] },
    projects: []
  };
  const reordered = JSON.parse(JSON.stringify(unsigned)) as ReadonlySnapshotUnsigned;
  assert.equal(snapshotFingerprint(unsigned), snapshotFingerprint(reordered));
  const changed = structuredClone(unsigned);
  changed.expires_at = "2026-07-16T00:59:59.000Z";
  assert.notEqual(snapshotFingerprint(unsigned), snapshotFingerprint(changed));
  const snapshot = finalizeReadonlySnapshot(unsigned);
  assert.match(snapshot.snapshot_fingerprint, /^[0-9a-f]{64}$/);
  const tampered = structuredClone(snapshot);
  tampered.expires_at = "2026-07-16T00:59:59.000Z";
  assert.throws(() => parseReadonlySnapshot(tampered), /READONLY_SNAPSHOT_FINGERPRINT_MISMATCH/);
  assert.deepEqual(readonlySnapshotStatus(snapshot, new Date("2026-07-16T00:30:00.000Z")), {
    server_now: "2026-07-16T00:30:00.000Z",
    generated_at: generatedAt,
    expires_at: "2026-07-16T01:00:00.000Z",
    age_seconds: 1800,
    ttl_remaining_seconds: 1800,
    freshness_status: "fresh",
    snapshot_fingerprint: snapshot.snapshot_fingerprint
  });
  assert.equal(readonlySnapshotStatus(snapshot, new Date("2026-07-16T01:00:00.000Z")).freshness_status, "snapshot_expired");

  const futureUnsigned = structuredClone(unsigned);
  futureUnsigned.generated_at = "2026-07-17T00:00:00.000Z";
  futureUnsigned.expires_at = "2026-07-17T01:00:00.000Z";
  assert.throws(
    () => finalizeReadonlySnapshot(futureUnsigned, new Date("2026-07-16T23:59:59.999Z")),
    /READONLY_SNAPSHOT_GENERATED_IN_FUTURE/
  );
  const futureSnapshot = finalizeReadonlySnapshot(futureUnsigned, new Date("2026-07-17T00:00:00.000Z"));
  assert.throws(
    () => parseReadonlySnapshot(futureSnapshot, new Date("2026-07-16T23:59:59.999Z")),
    /READONLY_SNAPSHOT_GENERATED_IN_FUTURE/
  );
  assert.deepEqual(readonlySnapshotStatus(futureSnapshot, new Date("2026-07-16T23:59:59.999Z")), {
    server_now: "2026-07-16T23:59:59.999Z",
    generated_at: "2026-07-17T00:00:00.000Z",
    expires_at: "2026-07-17T01:00:00.000Z",
    age_seconds: 0,
    ttl_remaining_seconds: 0,
    freshness_status: "snapshot_expired",
    snapshot_fingerprint: futureSnapshot.snapshot_fingerprint
  });
});

test("SQLite readonly adapter returns a stable denial for a disabled principal", () => {
  const root = mkdtempSync(join(tmpdir(), "readonly-projection-disabled-"));
  const sqlitePath = join(root, "app.sqlite");
  const fixture = createFixture(sqlitePath);
  const db = openM0DatabaseConnection(sqlitePath);
  try {
    db.prepare("UPDATE webgpt_auth_principals SET status = 'disabled' WHERE principal_id = ?").run(fixture.actor.principal_id);
    const source = new SqliteReadonlyDataSource(db, fixture.actor.principal_id, fixture.actor.issuer_hash!);
    const result = source.listProductionProjects({}, "disabled");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "WEBGPT_PRINCIPAL_DISABLED");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot validation rejects nested cross-project DTO bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "readonly-projection-bindings-"));
  const sqlitePath = join(root, "app.sqlite");
  const fixture = createFixture(sqlitePath);
  try {
    const snapshot = exportReadonlySnapshotFromDatabase({
      database_path: sqlitePath,
      issuer_hash: fixture.actor.issuer_hash!,
      resource_url: RESOURCE,
      generated_at: new Date(Date.now() - 1_000).toISOString(),
      ttl_seconds: 3600
    });
    const { snapshot_fingerprint: _fingerprint, ...unsigned } = snapshot;
    const generatedArtifact = {
      artifact_id: "artifact_generated_001",
      artifact_type: "video" as const,
      role: "generated_clip" as const,
      status: "active" as const,
      filename: "generated.mp4",
      mime_type: "video/mp4",
      metadata: { width: 1920, height: 1080, duration_seconds: 6, aspect_ratio: "16:9", sha256: "a".repeat(64) },
      linked_objects: { project_id: fixture.project_id, shot_id: fixture.shot_id },
      provenance: { kind: "provider", provider: "fixture", sha256: "a".repeat(64) }
    };
    const mutations: Array<(candidate: ReadonlySnapshotUnsigned) => void> = [
      (candidate) => { candidate.projects[0]!.contexts[0]!.compact.project.project_id = "project_cross_binding"; },
      (candidate) => { candidate.projects[0]!.shots_full[0]!.project_id = "project_cross_binding"; },
      (candidate) => { candidate.projects[0]!.review_packages[0]!.full.shot.project_id = "project_cross_binding"; },
      (candidate) => { candidate.projects[0]!.delivery.project_id = "project_cross_binding"; },
      (candidate) => { candidate.projects[0]!.closeout.project_id = "project_cross_binding"; },
      (candidate) => { candidate.projects[0]!.review_packages = []; }
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(unsigned);
      mutate(candidate);
      assert.throws(() => finalizeReadonlySnapshot(candidate), /(binding mismatch|bindings differ)/i);
    }

    const fullContextInCompactSlot = structuredClone(unsigned);
    (fullContextInCompactSlot.projects[0]!.contexts[0] as unknown as { compact: unknown }).compact =
      structuredClone(fullContextInCompactSlot.projects[0]!.contexts[0]!.full);
    assert.throws(() => finalizeReadonlySnapshot(fullContextInCompactSlot), /compact context slot/i);

    const fullReviewInCompactSlot = structuredClone(unsigned);
    (fullReviewInCompactSlot.projects[0]!.review_packages[0] as unknown as { compact: unknown }).compact =
      structuredClone(fullReviewInCompactSlot.projects[0]!.review_packages[0]!.full);
    assert.throws(() => finalizeReadonlySnapshot(fullReviewInCompactSlot), /compact review slot/i);

    const divergentCompactProject = structuredClone(unsigned);
    divergentCompactProject.projects[0]!.list_item_compact.project.title = "Divergent compact title";
    assert.throws(() => finalizeReadonlySnapshot(divergentCompactProject), /project list parity mismatch/i);

    const divergentCompactShot = structuredClone(unsigned);
    divergentCompactShot.projects[0]!.shots_compact[0]!.description = "Divergent compact SHOT";
    assert.throws(() => finalizeReadonlySnapshot(divergentCompactShot), /SHOT parity mismatch/i);

    const divergentCompactContext = structuredClone(unsigned);
    divergentCompactContext.projects[0]!.contexts[0]!.compact.project.title = "Divergent context title";
    assert.throws(() => finalizeReadonlySnapshot(divergentCompactContext), /context parity mismatch/i);

    const divergentCanonicalContext = structuredClone(unsigned);
    divergentCanonicalContext.projects[0]!.contexts[0]!.full.project.title = "Divergent canonical context";
    divergentCanonicalContext.projects[0]!.contexts[0]!.compact.project.title = "Divergent canonical context";
    assert.throws(() => finalizeReadonlySnapshot(divergentCanonicalContext), /context\/project canonical projection mismatch/i);

    const divergentCompactReview = structuredClone(unsigned);
    divergentCompactReview.projects[0]!.review_packages[0]!.compact.selected_artifact_id = "artifact_divergent";
    assert.throws(() => finalizeReadonlySnapshot(divergentCompactReview), /review package parity mismatch/i);

    const divergentCloseout = structuredClone(unsigned);
    divergentCloseout.projects[0]!.closeout.delivered = !divergentCloseout.projects[0]!.delivery.delivered;
    assert.throws(() => finalizeReadonlySnapshot(divergentCloseout), /closeout\/delivery parity mismatch/i);

    const fabricatedDeliveryCounts = structuredClone(unsigned);
    fabricatedDeliveryCounts.projects[0]!.delivery.shots_total += 1;
    fabricatedDeliveryCounts.projects[0]!.closeout.shots_total += 1;
    assert.throws(() => finalizeReadonlySnapshot(fabricatedDeliveryCounts), /delivery\/canonical project state mismatch/i);

    const missingDeliveryContextClip = structuredClone(unsigned);
    const deliveryContext = missingDeliveryContextClip.projects[0]!.contexts.find((item) => item.workspace === "delivery")!;
    if (deliveryContext.full.workspace !== "delivery" || deliveryContext.compact.workspace !== "delivery") throw new Error("delivery fixture missing");
    deliveryContext.full.accepted_clips = [];
    deliveryContext.compact.accepted_clips = [];
    assert.throws(() => finalizeReadonlySnapshot(missingDeliveryContextClip), /accepted-clip SHOT set mismatch/i);

    const divergentReviewShot = structuredClone(unsigned);
    divergentReviewShot.projects[0]!.review_packages[0]!.full.shot.description = "Divergent review SHOT";
    divergentReviewShot.projects[0]!.review_packages[0]!.compact.shot.description = "Divergent review SHOT";
    assert.throws(() => finalizeReadonlySnapshot(divergentReviewShot), /review\/project SHOT parity mismatch/i);

    const mismatchedVersionArtifact = structuredClone(unsigned);
    mismatchedVersionArtifact.projects[0]!.review_packages[0]!.full.versions.push({
      artifact_id: "artifact_version_slot",
      run_id: "run_fixture",
      attempt_number: 1,
      review_status: "pending",
      artifact: structuredClone(generatedArtifact)
    });
    mismatchedVersionArtifact.projects[0]!.review_packages[0]!.compact.versions.push({
      artifact_id: "artifact_version_slot",
      attempt_number: 1,
      review_status: "pending"
    });
    assert.throws(() => finalizeReadonlySnapshot(mismatchedVersionArtifact), /review version artifact id mismatch/i);

    const unboundSelectedArtifact = structuredClone(unsigned);
    unboundSelectedArtifact.projects[0]!.review_packages[0]!.full.selected_artifact_id = "artifact_unbound";
    unboundSelectedArtifact.projects[0]!.review_packages[0]!.compact.selected_artifact_id = "artifact_unbound";
    assert.throws(() => finalizeReadonlySnapshot(unboundSelectedArtifact), /review selected artifact binding mismatch/i);

    const inactiveVersionArtifact = structuredClone(unsigned);
    const archivedArtifact = { ...structuredClone(generatedArtifact), status: "archived" as const };
    inactiveVersionArtifact.projects[0]!.review_packages[0]!.full.versions.push({
      artifact_id: archivedArtifact.artifact_id,
      run_id: "run_archived",
      attempt_number: 1,
      review_status: "pending",
      artifact: archivedArtifact
    });
    inactiveVersionArtifact.projects[0]!.review_packages[0]!.compact.versions.push({
      artifact_id: archivedArtifact.artifact_id,
      attempt_number: 1,
      review_status: "pending"
    });
    assert.throws(() => finalizeReadonlySnapshot(inactiveVersionArtifact), /generated clip artifact contract mismatch/i);

    const nonFinalDeliveryArtifact = structuredClone(unsigned);
    nonFinalDeliveryArtifact.projects[0]!.delivery.final_artifact = structuredClone(generatedArtifact);
    nonFinalDeliveryArtifact.projects[0]!.closeout.final_artifact = structuredClone(generatedArtifact);
    assert.throws(() => finalizeReadonlySnapshot(nonFinalDeliveryArtifact), /final artifact contract mismatch/i);

    const duplicateCompactShot = structuredClone(unsigned);
    const projected = duplicateCompactShot.projects[0]!;
    const secondShotId = "shot_cloud_projection_002";
    const secondFullShot = structuredClone(projected.shots_full[0]!);
    secondFullShot.shot_id = secondShotId;
    projected.shots_full.push(secondFullShot);
    projected.list_item_full.project.shot_ids.push(secondShotId);
    projected.shots_compact.push(structuredClone(projected.shots_compact[0]!));
    const secondReview = structuredClone(projected.review_packages[0]!);
    secondReview.shot_id = secondShotId;
    secondReview.compact.shot.shot_id = secondShotId;
    secondReview.full.shot.shot_id = secondShotId;
    projected.review_packages.push(secondReview);
    assert.throws(() => finalizeReadonlySnapshot(duplicateCompactShot), /duplicate compact SHOT binding/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readonly exporter holds every schema and projection query inside one read transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "readonly-projection-transaction-"));
  const sqlitePath = join(root, "app.sqlite");
  const fixture = createFixture(sqlitePath);
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  let transactionOpen = false;
  let beginCount = 0;
  let commitCount = 0;
  let prepareCount = 0;
  DatabaseSync.prototype.exec = function patchedExec(sql: string): void {
    const normalized = sql.trim().toUpperCase();
    if (normalized === "BEGIN;") {
      assert.equal(transactionOpen, false);
      transactionOpen = true;
      beginCount += 1;
    } else if (normalized === "COMMIT;") {
      assert.equal(transactionOpen, true);
      commitCount += 1;
      transactionOpen = false;
    }
    originalExec.call(this, sql);
  };
  DatabaseSync.prototype.prepare = function patchedPrepare(sql: string) {
    assert.equal(transactionOpen, true, `query escaped readonly export transaction: ${sql.slice(0, 40)}`);
    prepareCount += 1;
    return originalPrepare.call(this, sql);
  };
  try {
    exportReadonlySnapshotFromDatabase({
      database_path: sqlitePath,
      issuer_hash: fixture.actor.issuer_hash!,
      resource_url: RESOURCE,
      generated_at: new Date(Date.now() - 1_000).toISOString(),
      ttl_seconds: 3600
    });
    assert.equal(beginCount, 1);
    assert.equal(commitCount, 1);
    assert.ok(prepareCount > 10);
    assert.equal(transactionOpen, false);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    DatabaseSync.prototype.prepare = originalPrepare;
    rmSync(root, { recursive: true, force: true });
  }
});
