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
import { createProject, getProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { registerMediaArtifact } from "../src/tools/mediaArtifacts.js";
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
  readonlySnapshotReviewPendingCount,
  readonlySnapshotStatus,
  READONLY_SNAPSHOT_SCHEMA_VERSION,
  snapshotFingerprint,
  type ReadonlySnapshotUnsigned
} from "../src/webgpt-cloud/snapshot.js";

const ISSUER = "https://issuer.example.test/";
const RESOURCE = "https://aivideo.example.test/mcp";

test("snapshot review count follows the projected operational review stage", () => {
  assert.equal(readonlySnapshotReviewPendingCount([
    {
      operational_state: { review: { stage: "pending" } }
    },
    {
      operational_state: { review: { stage: "revision_needed" } }
    },
    {
      operational_state: { review: { stage: "pending" } }
    },
    {
      operational_state: { review: { stage: "inconsistent" } }
    }
  ]), 2);
});

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

function addSecondFixtureShot(
  sqlitePath: string,
  projectId: string,
  options: { order?: number; shot_id?: string } = {}
): void {
  const db = openM0Database(sqlitePath);
  try {
    const project = getProject(db, projectId);
    assert.ok(project);
    const secondShot: Shot = {
      shot_id: options.shot_id ?? "shot_cloud_projection_002",
      project_id: projectId,
      order: options.order ?? 2,
      status: "storyboard_approved",
      duration_seconds: 4,
      description: "Second readonly projection shot",
      storyboard_image_artifact_id: "",
      video_prompt: "A second safe fixture prompt",
      negative_prompt: "",
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    saveShot(db, secondShot);
    project.shot_ids.push(secondShot.shot_id);
    saveProject(db, project);
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
  const fixtureDb = openM0Database(sqlitePath);
  try {
    const project = getProject(fixtureDb, fixture.project_id);
    assert.ok(project);
    const registered = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: fixture.project_id }
    }, fixtureDb);
    assert.equal(registered.ok, true);
    if (!registered.ok) throw new Error("final video projection fixture registration failed");
    project.status = "final_approved";
    project.exports.final_video_artifact_id = registered.artifact.artifact_id;
    saveProject(fixtureDb, project);
  } finally {
    fixtureDb.close();
  }
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
  const deliveryContext = snapshot.projects[0]!.contexts.find((context) => context.workspace === "delivery");
  assert.ok(deliveryContext && "final_artifact_reason_code" in deliveryContext.compact && "final_artifact_reason_code" in deliveryContext.full);
  assert.equal(deliveryContext.compact.final_artifact_reason_code, null);
  assert.equal(deliveryContext.full.final_artifact_reason_code, null);
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
    schema_version: READONLY_SNAPSHOT_SCHEMA_VERSION,
    source_schema: "workbench-v2-5",
    source_migration: "0008",
    source_version: "webgpt-v4.3.0",
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

test("readonly snapshot v2 rejects prior v1 payloads with a stable version error", () => {
  const current = finalizeReadonlySnapshot({
    schema_version: READONLY_SNAPSHOT_SCHEMA_VERSION,
    source_schema: "workbench-v2-5",
    source_migration: "0008",
    source_version: "webgpt-v4.3.0",
    generated_at: "2026-07-16T00:00:00.000Z",
    expires_at: "2026-07-16T01:00:00.000Z",
    resource_url: RESOURCE,
    issuer_hash: "a".repeat(64),
    authorization: { principals: [] },
    projects: []
  });
  const legacy = structuredClone(current) as unknown as Record<string, unknown>;
  legacy.schema_version = "readonly-snapshot-v1";
  assert.throws(
    () => parseReadonlySnapshot(legacy, new Date("2026-07-16T00:30:00.000Z")),
    /READONLY_SNAPSHOT_VERSION_UNSUPPORTED/
  );
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
      (candidate) => { candidate.projects[0]!.shots_full[0]!.operational_state.shot_id = "shot_cross_binding"; },
      (candidate) => { candidate.projects[0]!.shots_full[0]!.operational_state.project_id = "project_cross_binding"; },
      (candidate) => { candidate.projects[0]!.review_packages[0]!.full.shot.project_id = "project_cross_binding"; },
      (candidate) => { candidate.projects[0]!.review_packages[0]!.full.shot.operational_state.shot_id = "shot_cross_binding"; },
      (candidate) => { candidate.projects[0]!.delivery.project_id = "project_cross_binding"; },
      (candidate) => { candidate.projects[0]!.closeout.project_id = "project_cross_binding"; },
      (candidate) => { candidate.projects[0]!.review_packages = []; }
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(unsigned);
      mutate(candidate);
      assert.throws(() => finalizeReadonlySnapshot(candidate), /(binding mismatch|bindings differ)/i);
    }

    const mismatchedOperationalStatus = structuredClone(unsigned);
    mismatchedOperationalStatus.projects[0]!.shots_full[0]!.operational_state.stored_workflow_status = "draft";
    assert.throws(() => finalizeReadonlySnapshot(mismatchedOperationalStatus), /operational state workflow status mismatch/i);

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

    const acceptedArtifactOutsideReview = structuredClone(unsigned);
    acceptedArtifactOutsideReview.projects[0]!.shots_full[0]!.accepted_clip_artifact_id = "artifact_not_in_review";
    assert.throws(() => finalizeReadonlySnapshot(acceptedArtifactOutsideReview), /accepted clip is absent from the SHOT review versions/i);

    const acceptedArtifactMarkedNotReady = structuredClone(unsigned);
    const notReadyProject = acceptedArtifactMarkedNotReady.projects[0]!;
    notReadyProject.shots_full[0]!.accepted_clip_artifact_id = generatedArtifact.artifact_id;
    notReadyProject.shots_full[0]!.clip_versions.push({ artifact_id: generatedArtifact.artifact_id, run_id: "run_generated", attempt_number: 1, review_status: "approved" });
    notReadyProject.review_packages[0]!.full.versions.push({
      artifact_id: generatedArtifact.artifact_id,
      run_id: "run_generated",
      attempt_number: 1,
      review_status: "approved",
      artifact: structuredClone(generatedArtifact)
    });
    notReadyProject.review_packages[0]!.compact.versions.push({ artifact_id: generatedArtifact.artifact_id, attempt_number: 1, review_status: "approved" });
    notReadyProject.delivery.readiness_checks[0]!.artifact_id = generatedArtifact.artifact_id;
    notReadyProject.delivery.readiness_checks[0]!.ok = false;
    notReadyProject.delivery.readiness_checks[0]!.reason_code = "ARTIFACT_INACCESSIBLE";
    notReadyProject.closeout.readiness_checks = structuredClone(notReadyProject.delivery.readiness_checks);
    assert.throws(() => finalizeReadonlySnapshot(acceptedArtifactMarkedNotReady), /delivery accepted-clip readiness mismatch/i);

    const extraReviewVersion = structuredClone(unsigned);
    extraReviewVersion.projects[0]!.review_packages[0]!.full.versions.push({
      artifact_id: generatedArtifact.artifact_id,
      run_id: "run_extra",
      attempt_number: 1,
      review_status: "pending",
      artifact: structuredClone(generatedArtifact)
    });
    extraReviewVersion.projects[0]!.review_packages[0]!.compact.versions.push({ artifact_id: generatedArtifact.artifact_id, attempt_number: 1, review_status: "pending" });
    assert.throws(() => finalizeReadonlySnapshot(extraReviewVersion), /review version stack differs from the canonical SHOT versions/i);

    const selectedNonAcceptedVersion = structuredClone(extraReviewVersion);
    const selectedProject = selectedNonAcceptedVersion.projects[0]!;
    const selectedVersion = { artifact_id: generatedArtifact.artifact_id, run_id: "run_extra", attempt_number: 1, review_status: "pending" as const };
    selectedProject.shots_full[0]!.clip_versions.push(selectedVersion);
    selectedProject.review_packages[0]!.full.selected_artifact_id = generatedArtifact.artifact_id;
    selectedProject.review_packages[0]!.compact.selected_artifact_id = generatedArtifact.artifact_id;
    selectedProject.list_item_full.summary.review_pending_count = 1;
    selectedProject.list_item_compact.summary.review_pending_count = 1;
    for (const context of selectedProject.contexts) {
      context.full.summary.review_pending_count = 1;
      context.compact.summary.review_pending_count = 1;
      if ("shots" in context.full) context.full.shots[0]!.clip_versions.push(structuredClone(selectedVersion));
      if (context.full.workspace === "overview") context.full.metrics.review_pending = 1;
      if (context.compact.workspace === "overview") context.compact.metrics.review_pending = 1;
    }
    assert.throws(() => finalizeReadonlySnapshot(selectedNonAcceptedVersion), /review selected artifact binding mismatch/i);

    const unrelatedReviewNote = structuredClone(unsigned);
    const note = {
      note_id: "note_unrelated_artifact",
      project_id: unrelatedReviewNote.projects[0]!.project_id,
      shot_id: unrelatedReviewNote.projects[0]!.shots_full[0]!.shot_id,
      artifact_id: "artifact_not_in_versions",
      note: "Synthetic note",
      source: "fixture",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    unrelatedReviewNote.projects[0]!.review_packages[0]!.full.notes.push(note);
    unrelatedReviewNote.projects[0]!.review_packages[0]!.compact.notes.push(structuredClone(note));
    assert.throws(() => finalizeReadonlySnapshot(unrelatedReviewNote), /review note artifact is absent from the canonical SHOT versions/i);

    const impossibleReviewTotal = structuredClone(unsigned);
    const validNote = { ...note, note_id: "note_valid_unbound", artifact_id: "" };
    impossibleReviewTotal.projects[0]!.review_packages[0]!.full.notes.push(validNote);
    impossibleReviewTotal.projects[0]!.review_packages[0]!.compact.notes.push(structuredClone(validNote));
    impossibleReviewTotal.projects[0]!.review_packages[0]!.full.notes_total = 0;
    impossibleReviewTotal.projects[0]!.review_packages[0]!.compact.notes_total = 0;
    assert.throws(() => finalizeReadonlySnapshot(impossibleReviewTotal), /review notes total is smaller than returned notes/i);

    const negativeReviewTotal = structuredClone(unsigned);
    negativeReviewTotal.projects[0]!.review_packages[0]!.full.notes_total = -1;
    negativeReviewTotal.projects[0]!.review_packages[0]!.compact.notes_total = -1;
    assert.throws(() => finalizeReadonlySnapshot(negativeReviewTotal), /review notes total is smaller than returned notes/i);

    const reversedReviewNotes = structuredClone(unsigned);
    const olderNote = { ...note, note_id: "note_older", artifact_id: "", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
    const newerNote = { ...note, note_id: "note_newer", artifact_id: "", created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" };
    reversedReviewNotes.projects[0]!.review_packages[0]!.full.notes.push(olderNote, newerNote);
    reversedReviewNotes.projects[0]!.review_packages[0]!.compact.notes.push(structuredClone(olderNote), structuredClone(newerNote));
    reversedReviewNotes.projects[0]!.review_packages[0]!.full.notes_total = 2;
    reversedReviewNotes.projects[0]!.review_packages[0]!.compact.notes_total = 2;
    assert.throws(() => finalizeReadonlySnapshot(reversedReviewNotes), /review notes are not ordered newest first/i);

    const reversedContextReviewNotes = structuredClone(unsigned);
    const reversedContext = reversedContextReviewNotes.projects[0]!.contexts.find((context) => context.workspace === "review");
    assert.ok(reversedContext && "review_notes" in reversedContext.full && "review_notes" in reversedContext.compact);
    reversedContext.full.review_notes.push(structuredClone(olderNote), structuredClone(newerNote));
    reversedContext.compact.review_notes.push(structuredClone(olderNote), structuredClone(newerNote));
    assert.throws(() => finalizeReadonlySnapshot(reversedContextReviewNotes), /review context notes are not ordered newest first/i);

    const unrelatedContextReviewNote = structuredClone(unsigned);
    const reviewContext = unrelatedContextReviewNote.projects[0]!.contexts.find((context) => context.workspace === "review");
    assert.ok(reviewContext && "review_notes" in reviewContext.full && "review_notes" in reviewContext.compact);
    reviewContext.full.review_notes.push(structuredClone(note));
    reviewContext.compact.review_notes.push(structuredClone(note));
    assert.throws(() => finalizeReadonlySnapshot(unrelatedContextReviewNote), /review context note artifact is absent from the canonical SHOT versions/i);

    const divergentDeliveryArtifact = structuredClone(acceptedArtifactMarkedNotReady);
    const divergentDeliveryProject = divergentDeliveryArtifact.projects[0]!;
    divergentDeliveryProject.delivery.readiness_checks[0]!.ok = true;
    divergentDeliveryProject.delivery.readiness_checks[0]!.reason_code = "SHOT_ACCEPTED_CLIP_READY";
    const divergentDeliveryContext = divergentDeliveryProject.contexts.find((context) => context.workspace === "delivery");
    assert.ok(divergentDeliveryContext && "accepted_clips" in divergentDeliveryContext.full);
    divergentDeliveryContext.full.accepted_clips[0]!.artifact = {
      ...structuredClone(generatedArtifact),
      filename: "divergent-provider-payload.mp4"
    };
    assert.throws(() => finalizeReadonlySnapshot(divergentDeliveryArtifact), /delivery context accepted-clip projection mismatch/i);

    const divergentSummary = structuredClone(unsigned);
    const summaryProject = divergentSummary.projects[0]!;
    summaryProject.list_item_full.summary.shot_count = 99;
    summaryProject.list_item_compact.summary.shot_count = 99;
    for (const context of summaryProject.contexts) {
      context.full.summary.shot_count = 99;
      context.compact.summary.shot_count = 99;
    }
    assert.throws(() => finalizeReadonlySnapshot(divergentSummary), /project summary canonical state mismatch/i);

    const negativeSummaryCount = structuredClone(unsigned);
    negativeSummaryCount.projects[0]!.list_item_full.summary.active_run_count = -1;
    for (const context of negativeSummaryCount.projects[0]!.contexts) {
      context.full.summary.active_run_count = -1;
      context.compact.summary.active_run_count = -1;
    }
    assert.throws(() => finalizeReadonlySnapshot(negativeSummaryCount), /project summary counts cannot be negative/i);

    const understatedBlockers = structuredClone(unsigned);
    const clearSummary = {
      blocker_count: 0,
      blocker_reason: "",
      risk: "clear" as const,
      next_action: {
        source: "derived" as const,
        label: "已交付",
        reason_code: "delivered",
        priority: "normal" as const,
        expires_at: null,
        derived: { label: "已交付", reason_code: "delivered", priority: "normal" as const }
      }
    };
    const { blocker_reason: _blockerReason, ...clearCompactSummary } = clearSummary;
    Object.assign(understatedBlockers.projects[0]!.list_item_full.summary, structuredClone(clearSummary));
    Object.assign(understatedBlockers.projects[0]!.list_item_compact.summary, structuredClone(clearCompactSummary));
    for (const context of understatedBlockers.projects[0]!.contexts) {
      Object.assign(context.full.summary, structuredClone(clearSummary));
      Object.assign(context.compact.summary, structuredClone(clearCompactSummary));
    }
    assert.throws(() => finalizeReadonlySnapshot(understatedBlockers), /project blocker summary differs from canonical SHOT blockers/i);

    const divergentOverview = structuredClone(unsigned);
    const overview = divergentOverview.projects[0]!.contexts.find((context) => context.workspace === "overview");
    assert.ok(overview && "metrics" in overview.full && "metrics" in overview.compact);
    overview.full.metrics.shots = 99;
    overview.compact.metrics.shots = 99;
    assert.throws(() => finalizeReadonlySnapshot(divergentOverview), /overview metrics or blockers canonical projection mismatch/i);

    const boundedOverviewRuns = structuredClone(unsigned);
    const boundedOverview = boundedOverviewRuns.projects[0]!.contexts.find((context) => context.workspace === "overview");
    assert.ok(boundedOverview && "metrics" in boundedOverview.full && "metrics" in boundedOverview.compact);
    boundedOverview.full.metrics.generation_active = 17;
    boundedOverview.compact.metrics.generation_active = 17;
    assert.doesNotThrow(() => finalizeReadonlySnapshot(boundedOverviewRuns));

    const negativeOverviewRuns = structuredClone(unsigned);
    const negativeOverview = negativeOverviewRuns.projects[0]!.contexts.find((context) => context.workspace === "overview");
    assert.ok(negativeOverview && "metrics" in negativeOverview.full && "metrics" in negativeOverview.compact);
    negativeOverview.full.metrics.generation_active = -1;
    negativeOverview.compact.metrics.generation_active = -1;
    assert.throws(() => finalizeReadonlySnapshot(negativeOverviewRuns), /overview generation active count cannot be negative/i);

    const divergentMeta = structuredClone(unsigned);
    const fullContext = divergentMeta.projects[0]!.contexts[0]!.full;
    assert.ok("meta" in fullContext);
    fullContext.meta.pinned = !fullContext.meta.pinned;
    assert.throws(() => finalizeReadonlySnapshot(divergentMeta), /context metadata canonical projection mismatch/i);

    const divergentMetaTimestamp = structuredClone(unsigned);
    const laterFullContext = divergentMetaTimestamp.projects[0]!.contexts[1]!.full;
    assert.ok("meta" in laterFullContext);
    laterFullContext.meta.updated_at = "2099-01-01T00:00:00.000Z";
    assert.throws(() => finalizeReadonlySnapshot(divergentMetaTimestamp), /context metadata canonical projection mismatch/i);

    const divergentAllMetaTimestamps = structuredClone(unsigned);
    for (const context of divergentAllMetaTimestamps.projects[0]!.contexts) {
      assert.ok("meta" in context.full);
      context.full.meta.updated_at = "2099-01-01T00:00:00.000Z";
    }
    assert.throws(() => finalizeReadonlySnapshot(divergentAllMetaTimestamps), /context metadata canonical projection mismatch/i);

    const invalidFinalArtifactReference = structuredClone(unsigned);
    const invalidFinalProject = invalidFinalArtifactReference.projects[0]!;
    invalidFinalProject.final_video_artifact_id = "artifact_inaccessible_final";
    invalidFinalProject.list_item_full.summary.delivery_state = "final_review";
    invalidFinalProject.list_item_compact.summary.delivery_state = "final_review";
    invalidFinalProject.delivery.final_artifact_reason_code = "ARTIFACT_INACCESSIBLE";
    invalidFinalProject.closeout.final_artifact_reason_code = "ARTIFACT_INACCESSIBLE";
    for (const context of invalidFinalProject.contexts) {
      context.full.summary.delivery_state = "final_review";
      context.compact.summary.delivery_state = "final_review";
      if (context.workspace === "delivery" && "final_artifact_reason_code" in context.full && "final_artifact_reason_code" in context.compact) {
        context.full.final_artifact_reason_code = "ARTIFACT_INACCESSIBLE";
        context.compact.final_artifact_reason_code = "ARTIFACT_INACCESSIBLE";
      }
    }
    assert.doesNotThrow(() => finalizeReadonlySnapshot(invalidFinalArtifactReference));

    const contradictoryFinalArtifact = structuredClone(unsigned);
    const usableFinalArtifact = {
      ...structuredClone(generatedArtifact),
      artifact_id: "artifact_final_video",
      role: "final_video" as const,
      linked_objects: { project_id: contradictoryFinalArtifact.projects[0]!.project_id, shot_id: null }
    };
    contradictoryFinalArtifact.projects[0]!.delivery.final_artifact = usableFinalArtifact;
    contradictoryFinalArtifact.projects[0]!.delivery.final_artifact_reason_code = "ARTIFACT_INACCESSIBLE";
    assert.throws(() => finalizeReadonlySnapshot(contradictoryFinalArtifact), /usable final artifact cannot carry an error reason/i);

    const nonCanonicalFinalArtifact = structuredClone(unsigned);
    nonCanonicalFinalArtifact.projects[0]!.delivery.final_artifact = structuredClone(usableFinalArtifact);
    nonCanonicalFinalArtifact.projects[0]!.closeout.final_artifact = structuredClone(usableFinalArtifact);
    assert.throws(() => finalizeReadonlySnapshot(nonCanonicalFinalArtifact), /final artifact differs from canonical project export/i);

    const negativeCloseoutEvidence = structuredClone(unsigned);
    negativeCloseoutEvidence.projects[0]!.closeout.evidence.webgpt_audit_events = -1;
    assert.throws(() => finalizeReadonlySnapshot(negativeCloseoutEvidence), /closeout audit event count cannot be negative/i);

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

test("readonly snapshot requires compact and full SHOT ordering parity", () => {
  const root = mkdtempSync(join(tmpdir(), "readonly-projection-shot-order-"));
  const sqlitePath = join(root, "app.sqlite");
  const fixture = createFixture(sqlitePath);
  addSecondFixtureShot(sqlitePath, fixture.project_id);
  try {
    const snapshot = exportReadonlySnapshotFromDatabase({
      database_path: sqlitePath,
      issuer_hash: fixture.actor.issuer_hash!,
      resource_url: RESOURCE
    });
    const { snapshot_fingerprint: _fingerprint, ...unsigned } = snapshot;
    assert.equal(unsigned.projects[0]!.shots_full.length, 2);
    unsigned.projects[0]!.shots_compact.reverse();
    assert.throws(() => finalizeReadonlySnapshot(unsigned), /compact and full SHOT ordering differs/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readonly snapshot requires canonical full SHOT ordering", () => {
  const root = mkdtempSync(join(tmpdir(), "readonly-projection-canonical-shot-order-"));
  const sqlitePath = join(root, "app.sqlite");
  const fixture = createFixture(sqlitePath);
  addSecondFixtureShot(sqlitePath, fixture.project_id);
  try {
    const snapshot = exportReadonlySnapshotFromDatabase({
      database_path: sqlitePath,
      issuer_hash: fixture.actor.issuer_hash!,
      resource_url: RESOURCE
    });
    const { snapshot_fingerprint: _fingerprint, ...unsigned } = snapshot;
    const project = unsigned.projects[0]!;
    project.shots_full.reverse();
    project.shots_compact.reverse();
    project.list_item_full.project.shot_ids.reverse();
    assert.throws(() => finalizeReadonlySnapshot(unsigned), /full SHOT ordering is not canonical/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readonly exporter uses shot_id as the deterministic tiebreaker for equal SHOT order", () => {
  const root = mkdtempSync(join(tmpdir(), "readonly-projection-shot-order-tie-"));
  const sqlitePath = join(root, "app.sqlite");
  const fixture = createFixture(sqlitePath);
  addSecondFixtureShot(sqlitePath, fixture.project_id, { order: 1, shot_id: "shot_cloud_projection_000" });
  try {
    const snapshot = exportReadonlySnapshotFromDatabase({
      database_path: sqlitePath,
      issuer_hash: fixture.actor.issuer_hash!,
      resource_url: RESOURCE
    });
    const project = snapshot.projects[0]!;
    const expectedShotIds = ["shot_cloud_projection_000", "shot_cloud_projection_001"];
    assert.deepEqual(project.shots_full.map((shot) => shot.shot_id), expectedShotIds);
    assert.deepEqual(project.shots_compact.map((shot) => shot.shot_id), expectedShotIds);
    for (const context of project.contexts) {
      if ("shots" in context.full) assert.deepEqual(context.full.shots.map((shot) => shot.shot_id), expectedShotIds);
      if ("shots" in context.compact) assert.deepEqual(context.compact.shots.map((shot) => shot.shot_id), expectedShotIds);
    }
    assert.deepEqual(project.delivery.readiness_checks.map((check) => check.shot_id), expectedShotIds);
    assert.deepEqual(project.closeout.readiness_checks.map((check) => check.shot_id), expectedShotIds);
    const db = openM0DatabaseConnection(sqlitePath, { readOnly: true });
    try {
      const sqlite = new SqliteReadonlyDataSource(db, fixture.actor.principal_id, fixture.actor.issuer_hash!);
      const projected = new SnapshotReadonlyDataSource(snapshot, fixture.actor.principal_id, fixture.actor.issuer_hash!);
      assert.deepEqual(
        stripMeta(projected.listProductionProjects({ detail: "full" }, "tie-order")),
        stripMeta(sqlite.listProductionProjects({ detail: "full" }, "tie-order"))
      );
      for (const workspace of ["overview", "storyboard", "generation", "review", "delivery"] as const) {
        assert.deepEqual(
          stripMeta(projected.getProjectContext({ project_id: fixture.project_id, workspace, detail: "full" }, "tie-order")),
          stripMeta(sqlite.getProjectContext({ project_id: fixture.project_id, workspace, detail: "full" }, "tie-order"))
        );
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readonly snapshot requires canonical readiness ordering", () => {
  const root = mkdtempSync(join(tmpdir(), "readonly-projection-readiness-order-"));
  const sqlitePath = join(root, "app.sqlite");
  const fixture = createFixture(sqlitePath);
  addSecondFixtureShot(sqlitePath, fixture.project_id);
  try {
    const snapshot = exportReadonlySnapshotFromDatabase({
      database_path: sqlitePath,
      issuer_hash: fixture.actor.issuer_hash!,
      resource_url: RESOURCE
    });
    const { snapshot_fingerprint: _fingerprint, ...unsigned } = snapshot;
    const project = unsigned.projects[0]!;
    assert.equal(project.delivery.readiness_checks.length, 2);
    project.delivery.readiness_checks.reverse();
    project.closeout.readiness_checks.reverse();
    const deliveryContext = project.contexts.find((context) => context.workspace === "delivery");
    assert.ok(deliveryContext && "readiness_checks" in deliveryContext.full && "readiness_checks" in deliveryContext.compact);
    deliveryContext.full.readiness_checks.reverse();
    deliveryContext.compact.readiness_checks.reverse();
    assert.throws(() => finalizeReadonlySnapshot(unsigned), /delivery readiness SHOT ordering differs/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readonly snapshot requires canonical project list ordering", () => {
  const root = mkdtempSync(join(tmpdir(), "readonly-projection-project-order-"));
  const sqlitePath = join(root, "app.sqlite");
  const fixture = createFixture(sqlitePath);
  const db = openM0Database(sqlitePath);
  try {
    const second = createProject({ title: "Second authorized project" }, db);
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("fixture setup failed");
    db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(second.project_id);
    bootstrapWebGptProjectOwner(db, fixture.actor.principal_id, second.project_id, "READONLY_CLOUD_SECOND_PROJECT", fixture.actor.issuer_hash!);
  } finally {
    db.close();
  }
  try {
    const snapshot = exportReadonlySnapshotFromDatabase({
      database_path: sqlitePath,
      issuer_hash: fixture.actor.issuer_hash!,
      resource_url: RESOURCE
    });
    const { snapshot_fingerprint: _fingerprint, ...unsigned } = snapshot;
    assert.equal(unsigned.projects.length, 2);
    unsigned.projects.reverse();
    assert.throws(() => finalizeReadonlySnapshot(unsigned), /project ordering differs from the canonical project list order/i);
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
