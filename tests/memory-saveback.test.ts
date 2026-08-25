import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  approveH3GeneratedClip,
  confirmMemorySavebackProposal,
  createGenerationRunFromPackageShot,
  createMemorySavebackProposal,
  createProject,
  generateMemoryRecallPack,
  getProject,
  getShot,
  importStoryboardPackage,
  registerMediaArtifact,
  saveShot
} from "../src/index.js";
import { DATABASE_MIGRATIONS, migrationChecksum } from "../src/storage/migrations.js";
import { installWorkbenchProductionMutationAuthority } from "../src/storage/productionMutationAuthority.js";

function applyMigrationsThrough(db: DatabaseSync, through: string): void {
  installWorkbenchProductionMutationAuthority(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    BEGIN EXCLUSIVE;
  `);
  try {
    for (const migration of DATABASE_MIGRATIONS.filter((candidate) => candidate.id <= through)) {
      const applied = db.prepare("SELECT 1 AS present FROM schema_migrations WHERE migration_id = ?")
        .get(migration.id) as { present: number } | undefined;
      if (applied) continue;
      migration.apply(db);
      db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum) VALUES (?, ?, ?)")
        .run(migration.id, migration.name, migrationChecksum(migration));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function open0012FixtureDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyMigrationsThrough(db, "0012");
  return db;
}

const LEGACY_FIXTURE_TABLES = [
  "projects",
  "shots",
  "media_blobs",
  "media_artifacts",
  "media_artifact_blobs",
  "storyboard_packages",
  "generation_batches",
  "generation_runs"
] as const;

function copyFixtureTable(source: DatabaseSync, target: DatabaseSync, table: typeof LEGACY_FIXTURE_TABLES[number]): void {
  const columns = (target.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((column) => column.name);
  const quotedColumns = columns.map((column) => `"${column}"`).join(", ");
  const rows = source.prepare(`SELECT ${quotedColumns} FROM "${table}"`).all() as Array<Record<string, unknown>>;
  const insert = target.prepare(`INSERT INTO "${table}" (${quotedColumns}) VALUES (${columns.map(() => "?").join(", ")})`);
  for (const row of rows) insert.run(...columns.map((column) => row[column] as never));
}

async function setupLegacyFinalProjectFixture(
  beforeLegacyMigration?: (context: { db: DatabaseSync; project_id: string; shot_id: string }) => void | Promise<void>
) {
  const sourceDb = open0012FixtureDatabase();
  let db: DatabaseSync | null = null;
  try {
    const project = createProject({ title: `Memory Saveback ${randomUUID().slice(0, 8)}` }, sourceDb);
    assert.equal(project.ok, true);
    if (!project.ok) throw new Error("project setup failed");

    const storyboardArtifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
      },
      sourceDb
    );
    assert.equal(storyboardArtifact.ok, true);
    if (!storyboardArtifact.ok) throw new Error("artifact setup failed");

    const storyboard = importStoryboardPackage(
      {
        project_id: project.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            storyboard_image_artifact_id: storyboardArtifact.artifact.artifact_id,
            video_prompt: "Animate this shot for memory saveback.",
            negative_prompt: ""
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      sourceDb
    );
    assert.equal(storyboard.ok, true);
    if (!storyboard.ok) throw new Error("storyboard setup failed");

    const shotId = storyboard.shots[0].shot_id;
    const generation = await createGenerationRunFromPackageShot(
      {
        project_id: project.project_id,
        storyboard_package_id: storyboard.storyboard_package_id,
        shot_id: shotId,
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      sourceDb
    );
    assert.equal(generation.ok, true);
    if (!generation.ok || !generation.generated_artifact_id) throw new Error("generation setup failed");

    const approved = approveH3GeneratedClip(
      { shot_id: shotId, artifact_id: generation.generated_artifact_id, write_report: false },
      sourceDb
    );
    assert.equal(approved.ok, true);
    if (!approved.ok) throw new Error("approval setup failed");

    const finalArtifact = registerMediaArtifact({
      artifact_type: "video",
      role: "final_video",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id: project.project_id }
    }, sourceDb);
    assert.equal(finalArtifact.ok, true);
    if (!finalArtifact.ok) throw new Error("final artifact fixture setup failed");
    await beforeLegacyMigration?.({ db: sourceDb, project_id: project.project_id, shot_id: shotId });

    const storedProject = getProject(sourceDb, project.project_id);
    assert(storedProject);
    storedProject.status = "final_approved";
    storedProject.exports.final_video_artifact_id = finalArtifact.artifact.artifact_id;
    sourceDb.prepare(`
      UPDATE projects
      SET data_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ?
    `).run(JSON.stringify(storedProject), storedProject.project_id);

    db = new DatabaseSync(":memory:");
    applyMigrationsThrough(db, "0011");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of LEGACY_FIXTURE_TABLES) copyFixtureTable(sourceDb, db, table);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    applyMigrationsThrough(db, "0012");
    const legacyState = db.prepare(`
      SELECT workflow_state, current_final_artifact_id, legacy_final_artifact_id
      FROM workbench_delivery_state
      WHERE project_id = ?
    `).get(project.project_id) as {
      workflow_state: string;
      current_final_artifact_id: string | null;
      legacy_final_artifact_id: string | null;
    };
    assert.equal(legacyState.workflow_state, "legacy_review_required");
    assert.equal(legacyState.current_final_artifact_id, finalArtifact.artifact.artifact_id);
    assert.equal(legacyState.legacy_final_artifact_id, finalArtifact.artifact.artifact_id);
    applyMigrationsThrough(db, "0013");

    return { db, project, storyboard, generation, final_video_artifact_id: finalArtifact.artifact.artifact_id };
  } catch (error) {
    db?.close();
    throw error;
  } finally {
    sourceDb.close();
  }
}

test("R3-6 creates saveback proposal with project, shot, artifact, run, and report provenance", async () => {
  const { db, project, storyboard, generation, final_video_artifact_id } = await setupLegacyFinalProjectFixture();

  try {
    const created = createMemorySavebackProposal(
      {
        project_id: project.project_id,
        report_refs: ["data/reports/r2_4_h4_final_assembly_workbench_result.json"],
        write_report: false
      },
      db
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const proposal = created.value.proposal;
    assert.equal(proposal.long_term_memory_write_attempted, false);
    assert.equal(proposal.items.some((item) => item.item_type === "memory_item"), true);
    assert.equal(proposal.items.some((item) => item.item_type === "asset" && item.provenance.artifact_id === generation.generated_artifact_id), true);
    assert.equal(proposal.items.some((item) => item.item_type === "asset" && item.provenance.artifact_id === final_video_artifact_id), true);
    assert.equal(proposal.items.some((item) => item.item_type === "reference" && item.provenance.storyboard_package_id === storyboard.storyboard_package_id), true);
    assert.equal(proposal.items.every((item) => item.provenance.project_id === project.project_id), true);
    assert.equal(proposal.items.some((item) => item.provenance.shot_id === storyboard.shots[0].shot_id), true);
    assert.equal(proposal.items.some((item) => item.provenance.run_id === generation.run.run_id), true);
    assert.equal(proposal.items.every((item) => item.provenance.report_refs.includes("data/reports/r2_4_h4_final_assembly_workbench_result.json")), true);
  } finally {
    db.close();
  }
});

test("R3-6 materializes only approved items after human confirmation and builds recall pack", async () => {
  const { db, project } = await setupLegacyFinalProjectFixture();

  try {
    const created = createMemorySavebackProposal({ project_id: project.project_id, write_report: false }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const proposal = created.value.proposal;
    const memoryItem = proposal.items.find((item) => item.item_type === "memory_item");
    const assetItem = proposal.items.find((item) => item.item_type === "asset");
    const rejectedItem = proposal.items.find((item) => item.item_id !== memoryItem?.item_id && item.item_id !== assetItem?.item_id);
    assert(memoryItem);
    assert(assetItem);
    assert(rejectedItem);

    const missingConfirmation = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: false,
        decisions: [{ item_id: memoryItem.item_id, decision: "approve" }]
      },
      created.value.store
    );
    assert.equal(missingConfirmation.ok, false);
    if (missingConfirmation.ok) return;
    assert.equal(missingConfirmation.error.code, "HUMAN_CONFIRMATION_REQUIRED");

    const confirmed = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: true,
        decisions: [
          { item_id: memoryItem.item_id, decision: "approve", title: "Confirmed production memory" },
          { item_id: assetItem.item_id, decision: "approve" },
          { item_id: rejectedItem.item_id, decision: "reject", rejection_reason: "not useful for future recall" }
        ]
      },
      created.value.store
    );
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) return;
    assert.equal(confirmed.value.proposal.status, "reviewed");
    assert.equal(confirmed.value.created.memory_items.length, 1);
    assert.equal(confirmed.value.created.assets.length, 1);
    assert.equal(confirmed.value.created.references.length, 0);
    assert.equal(
      [...confirmed.value.store.memory_items, ...confirmed.value.store.assets, ...confirmed.value.store.references].some(
        (record) => record.provenance.proposal_item_id === rejectedItem.item_id
      ),
      false
    );
    assert.equal(confirmed.value.created.assets[0].provenance.project_id, project.project_id);
    assert.equal(Boolean(confirmed.value.created.assets[0].provenance.artifact_id), true);

    const recall = generateMemoryRecallPack({ project_id: project.project_id }, confirmed.value.store);
    assert.equal(recall.ok, true);
    if (!recall.ok) return;
    assert.equal(recall.value.recall_pack.memory_items.length, 1);
    assert.equal(recall.value.recall_pack.assets.length, 1);
    assert.equal(recall.value.recall_pack.boundary.long_term_memory_write_attempted, false);

    const remainingDecisions = confirmed.value.proposal.items
      .filter((item) => item.status === "proposed")
      .map((item) => ({ item_id: item.item_id, decision: "reject" as const, rejection_reason: "not needed" }));
    assert.equal(remainingDecisions.length > 0, true);
    const fullyReviewed = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: true,
        decisions: remainingDecisions
      },
      confirmed.value.store
    );
    assert.equal(fullyReviewed.ok, true);
    if (!fullyReviewed.ok) return;
    assert.equal(fullyReviewed.value.proposal.status, "confirmed");
    assert.equal(fullyReviewed.value.created.memory_items.length, 0);
    assert.equal(fullyReviewed.value.created.assets.length, 0);
    assert.equal(fullyReviewed.value.created.references.length, 0);
  } finally {
    db.close();
  }
});

test("R3-6 rejects invalid or unknown saveback decisions instead of materializing them", async () => {
  const { db, project } = await setupLegacyFinalProjectFixture();

  try {
    const created = createMemorySavebackProposal({ project_id: project.project_id, write_report: false }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const proposal = created.value.proposal;
    const invalidDecision = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: true,
        decisions: [{ item_id: proposal.items[0].item_id, decision: "ignore" as "approve" }]
      },
      created.value.store
    );
    assert.equal(invalidDecision.ok, false);
    if (invalidDecision.ok) return;
    assert.equal(invalidDecision.error.code, "INVALID_DECISION");

    const unknownItem = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: true,
        decisions: [{ item_id: "saveback_item_missing", decision: "reject" }]
      },
      created.value.store
    );
    assert.equal(unknownItem.ok, false);
    if (unknownItem.ok) return;
    assert.equal(unknownItem.error.code, "PROPOSAL_ITEM_NOT_FOUND");
  } finally {
    db.close();
  }
});

test("R3-6 refuses saveback proposals with stale accepted clip references", async () => {
  const { db, project } = await setupLegacyFinalProjectFixture(({ db: fixtureDb, project_id, shot_id }) => {
    const shot = getShot(fixtureDb, shot_id);
    assert.ok(shot);
    if (!shot) throw new Error("shot fixture setup failed");
    const stale = registerMediaArtifact({
      artifact_type: "video",
      role: "generated_clip",
      source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
      linked_objects: { project_id, shot_id }
    }, fixtureDb);
    assert.equal(stale.ok, true);
    if (!stale.ok) throw new Error("stale artifact fixture setup failed");
    shot.accepted_clip_artifact_id = stale.artifact.artifact_id;
    saveShot(fixtureDb, shot);
  });

  try {
    const created = createMemorySavebackProposal({ project_id: project.project_id, write_report: false }, db);
    assert.equal(created.ok, false);
    if (!created.ok) assert.equal(created.error.code, "ARTIFACT_NOT_IN_SHOT_REVIEW");
  } finally {
    db.close();
  }
});
