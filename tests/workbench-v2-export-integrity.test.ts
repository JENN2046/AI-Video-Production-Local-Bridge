import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { paths } from "../src/paths.js";
import { checkDatabase, migrateDatabase } from "../src/storage/databaseGovernance.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { registerMediaArtifact } from "../src/tools/mediaArtifacts.js";
import { createProject } from "../src/tools/projects.js";
import { insertWorkbenchExportFixture } from "./workbench-delivery-test-helpers.js";

function setupFinalArtifact(db: ReturnType<typeof openM0Database>, suffix: string) {
  const project = createProject({ title: `Export integrity ${suffix}` }, db);
  assert.equal(project.ok, true);
  if (!project.ok) throw new Error("EXPORT_INTEGRITY_PROJECT_SETUP_FAILED");
  const artifact = registerMediaArtifact({
    artifact_type: "video",
    role: "final_video",
    source: { kind: "fixture_path", path: "video/mock_clip.mp4" },
    linked_objects: { project_id: project.project_id }
  }, db);
  assert.equal(artifact.ok, true);
  if (!artifact.ok) throw new Error("EXPORT_INTEGRITY_ARTIFACT_SETUP_FAILED");
  const blob = db.prepare(`SELECT b.sha256, b.size_bytes FROM media_artifact_blobs ab
    JOIN media_blobs b ON b.blob_id = ab.blob_id WHERE ab.artifact_id = ?`)
    .get(artifact.artifact.artifact_id) as { sha256: string; size_bytes: number };
  return { project_id: project.project_id, artifact_id: artifact.artifact.artifact_id, blob };
}

test("Export receipts bind immutable records to a regular project-scoped file and verified final Blob", (t) => {
  const db = openM0Database(":memory:");
  try {
    const fixture = setupFinalArtifact(db, randomUUID());
    const now = "2026-08-17T12:00:00.000Z";
    const projectRoot = join(paths.exportsRoot, fixture.project_id);
    mkdirSync(projectRoot, { recursive: true });
    const source = join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4");
    const insert = (exportId: string, relativePath: string, sha256 = fixture.blob.sha256,
      sizeBytes = fixture.blob.size_bytes) => db.prepare(`INSERT INTO workbench_exports
        (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(exportId, fixture.project_id, fixture.artifact_id, relativePath, sha256, sizeBytes, now);

    const valid = insertWorkbenchExportFixture(db, { project_id: fixture.project_id,
      artifact_id: fixture.artifact_id, export_id: "export_valid", created_at: now });
    assert.throws(() => db.prepare("UPDATE workbench_exports SET size_bytes = size_bytes WHERE export_id = 'export_valid'").run(),
      /WORKBENCH_EXPORT_IMMUTABLE/);
    assert.throws(() => db.prepare("DELETE FROM workbench_exports WHERE export_id = 'export_valid'").run(),
      /WORKBENCH_EXPORT_IMMUTABLE/);

    assert.throws(() => insert("export_missing", `data/exports/${fixture.project_id}/missing.mp4`),
      /WORKBENCH_EXPORT_FILE_INTEGRITY_INVALID/);
    copyFileSync(source, join(projectRoot, "bad-hash.mp4"));
    assert.throws(() => insert("export_bad_hash", `data/exports/${fixture.project_id}/bad-hash.mp4`, "0".repeat(64)),
      /WORKBENCH_EXPORT_FILE_INTEGRITY_INVALID/);
    copyFileSync(source, join(projectRoot, "bad-size.mp4"));
    assert.throws(() => insert("export_bad_size", `data/exports/${fixture.project_id}/bad-size.mp4`,
      fixture.blob.sha256, fixture.blob.size_bytes + 1), /WORKBENCH_EXPORT_FILE_INTEGRITY_INVALID/);

    const different = Buffer.from("different export fixture", "utf8");
    writeFileSync(join(projectRoot, "blob-mismatch.mp4"), different, { flag: "wx" });
    assert.throws(() => insert("export_blob_mismatch", `data/exports/${fixture.project_id}/blob-mismatch.mp4`,
      createHash("sha256").update(different).digest("hex"), different.length),
    /WORKBENCH_EXPORT_FILE_INTEGRITY_INVALID/);
    assert.throws(() => insert("export_cross_project", "data/exports/another_project/cross.mp4"),
      /WORKBENCH_EXPORT_FILE_INTEGRITY_INVALID|CHECK constraint failed/);
    assert.throws(() => insert("export_escape", `data/exports/${fixture.project_id}/../escape.mp4`),
      /WORKBENCH_EXPORT_FILE_INTEGRITY_INVALID|CHECK constraint failed/);

    const symlinkTarget = join(projectRoot, "symlink-target.mp4");
    const symlinkPath = join(projectRoot, "symlink.mp4");
    copyFileSync(source, symlinkTarget);
    try {
      symlinkSync(symlinkTarget, symlinkPath, "file");
      assert.throws(() => insert("export_symlink", `data/exports/${fixture.project_id}/symlink.mp4`),
        /WORKBENCH_EXPORT_FILE_INTEGRITY_INVALID/);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.diagnostic("SKIP: Windows symlink privilege is unavailable");
    }

    assert.equal(valid.relative_path, `data/exports/${fixture.project_id}/export_valid.mp4`);
  } finally {
    db.close();
  }
});

test("Export integrity defaults closed on raw connections and db:check detects post-insert file drift", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-export-integrity-"));
  const sqlitePath = join(root, "app.sqlite");
  try {
    migrateDatabase(sqlitePath);
    let db = openM0Database(sqlitePath);
    const fixture = setupFinalArtifact(db, randomUUID());
    const receipt = insertWorkbenchExportFixture(db, { project_id: fixture.project_id,
      artifact_id: fixture.artifact_id, export_id: "export_governance", created_at: "2026-08-17T12:30:00.000Z" });
    db.close();

    const raw = new DatabaseSync(sqlitePath);
    try {
      assert.throws(() => raw.prepare(`INSERT INTO workbench_exports
        (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
        VALUES ('export_raw', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
        .run(fixture.project_id, fixture.artifact_id,
          `data/exports/${fixture.project_id}/export_governance.mp4`, receipt.sha256, receipt.size_bytes),
      /no such function: workbench_export_file_integrity_valid/);
    } finally {
      raw.close();
    }

    const exportPath = join(paths.exportsRoot, fixture.project_id, "export_governance.mp4");
    const displaced = `${exportPath}.displaced`;
    renameSync(exportPath, displaced);
    const missing = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(missing.missing_media_files > 0, true);
    assert.equal(missing.result, "FAIL");
    renameSync(displaced, exportPath);
    writeFileSync(exportPath, Buffer.from("drifted export bytes", "utf8"));
    const drifted = checkDatabase(sqlitePath, { recover_media_activations: false });
    assert.equal(drifted.media_integrity_errors > 0, true);
    assert.equal(drifted.result, "FAIL");
    db = openM0Database(sqlitePath);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
