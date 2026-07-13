import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  ensureM0Directories,
  freezeGptHandoffStoryboardPackage,
  getMediaArtifact,
  getProjectStatus,
  openM0Database,
  paths,
  recoverMediaActivations,
  registerMediaArtifact,
  verifyMediaArtifactBytes,
  scanGptHandoffImports
} from "../src/index.js";

const CANARY_SOURCE = resolve(paths.workspaceRoot, "fixtures", "provider-canary", "m1-r0", "shot_001_canary_720x1280.png");
const ONE_BY_ONE_SOURCE = resolve(paths.workspaceRoot, "fixtures", "storyboard", "shot_001.png");

function copyTestImport(runId: string, order: number): string {
  ensureM0Directories();
  mkdirSync(paths.importsRoot, { recursive: true });
  assert.equal(existsSync(CANARY_SOURCE), true, `Missing test source image: ${CANARY_SOURCE}`);
  const filename = `gpt_handoff_test_${runId}_${String(order).padStart(3, "0")}.png`;
  copyFileSync(CANARY_SOURCE, join(paths.importsRoot, filename));
  return filename;
}

test("M1.5 scans local GPT imports and freezes a four-shot app-ready storyboard package", () => {
  const db = openM0Database();

  try {
    const runId = randomUUID().slice(0, 8);
    const importFilenames = [1, 2, 3, 4].map((order) => copyTestImport(runId, order));
    const scanned = scanGptHandoffImports().filter((image) => importFilenames.includes(image.filename));
    assert.equal(scanned.length, 4);
    assert.equal(scanned.every((image) => image.readable_by_image_validator), true);
    assert.equal(scanned.every((image) => image.width > 0 && image.height > 0), true);

    const result = freezeGptHandoffStoryboardPackage(
      {
        project_title: `M1.5 GPT Handoff Test ${runId}`,
        approved_by_user: true,
        write_report: false,
        shots: importFilenames.map((importFilename, index) => {
          const order = index + 1;
          return {
            import_filename: importFilename,
            order,
            duration_seconds: 2,
            shot_description: `SHOT_${String(order).padStart(3, "0")} local GPT handoff test.`,
            video_prompt: `Animate SHOT_${String(order).padStart(3, "0")} as a locked web GPT storyboard keyframe.`,
            negative_prompt: "no extra text, no source overwrite",
            continuity_constraints: ["Use the imported keyframe as source of truth"]
          };
        })
      },
      db
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.report.result, "PASS");
    assert.equal(result.report.report_path.includes(result.report.run_id), true);
    assert.equal(result.report.latest_report_path, "data/reports/m1_5_gpt_handoff_app_freeze_report.json");
    assert.equal(result.report.input_summary.artifact_ids_from_gpt, false);
    assert.equal(result.report.imported_artifacts.length, 4);
    assert.equal(result.report.storyboard_package.frozen, true);
    assert.equal(result.report.storyboard_package.shot_count, 4);
    assert.equal(result.report.package_validation.validateG0StoryboardPackage, "PASS");
    assert.equal(result.report.package_validation.importG0AppReadyStoryboardPackage, "PASS");

    for (const artifactSummary of result.report.imported_artifacts) {
      const artifact = getMediaArtifact(db, artifactSummary.artifact_id);
      assert.equal(artifact?.artifact_type, "image");
      assert.equal(artifact?.role, "storyboard_image");
      assert.equal(artifact?.status, "active");
      assert.equal(artifact?.artifact_id.startsWith("artifact_"), true);
    }

    const projectStatus = getProjectStatus({ project_id: result.report.project.project_id }, db);
    assert.equal(projectStatus.ok, true);
    if (!projectStatus.ok) return;
    assert.equal(projectStatus.status, "storyboard_approved");
    assert.equal(projectStatus.shots.length, 4);

    assert.equal(result.report.network_call_attempted, false);
    assert.equal(result.report.runway_called, false);
    assert.equal(result.report.runninghub_called, false);
    assert.equal(result.report.real_video_generated, false);
    assert.equal(result.report.regeneration_performed, false);
    assert.equal(result.report.batch_generation_performed, false);
    assert.equal(result.report.source_asset_overwrite, false);
  } finally {
    db.close();
  }
});

test("M1.5 requires explicit user approval before freezing", () => {
  const db = openM0Database();

  try {
    const runId = randomUUID().slice(0, 8);
    const importFilename = copyTestImport(runId, 1);
    const result = freezeGptHandoffStoryboardPackage(
      {
        project_title: "M1.5 Approval Required Test",
        write_report: false,
        shots: [
          {
            import_filename: importFilename,
            order: 1,
            duration_seconds: 2,
            shot_description: "Approval must be explicit.",
            video_prompt: "This should not freeze without approval."
          }
        ]
      },
      db
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "USER_APPROVAL_REQUIRED");
    assert.equal(result.report.imported_artifacts.length, 0);
    assert.equal(result.report.network_call_attempted, false);
  } finally {
    db.close();
  }
});

test("M1.5 prevalidates all shots before registering any media artifact", () => {
  const db = openM0Database();

  try {
    const runId = randomUUID().slice(0, 8);
    const validImport = copyTestImport(runId, 1);
    const invalidImport = `gpt_handoff_test_${runId}_bad.png`;
    const projectTitle = `M1.5 Prevalidation Test ${runId}`;
    writeFileSync(join(paths.importsRoot, invalidImport), "not an image", "utf8");

    const result = freezeGptHandoffStoryboardPackage(
      {
        project_title: projectTitle,
        approved_by_user: true,
        write_report: false,
        shots: [
          {
            import_filename: validImport,
            order: 1,
            duration_seconds: 2,
            shot_description: "This valid image should not be registered yet.",
            video_prompt: "This should be held until all shots pass validation."
          },
          {
            import_filename: invalidImport,
            order: 2,
            duration_seconds: 2,
            shot_description: "Invalid image should block the whole freeze.",
            video_prompt: "This should not import."
          }
        ]
      },
      db
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "IMAGE_FILE_INVALID");
    assert.equal(result.report.imported_artifacts.length, 0);
    const createdProject = db.prepare("SELECT project_id FROM projects WHERE json_extract(data_json, '$.title') = ?").get(projectTitle);
    assert.equal(createdProject, undefined);
  } finally {
    db.close();
  }
});

test("M1.5 rollback retains activation recovery evidence when file cleanup fails", () => {
  const db = openM0Database();
  const runId = randomUUID().slice(0, 8);
  const validImport = copyTestImport(runId, 1);
  appendFileSync(join(paths.importsRoot, validImport), Buffer.from(`unique-${runId}`, "utf8"));
  try {
    const result = freezeGptHandoffStoryboardPackage(
      {
        project_title: `M1.5 Rollback Recovery ${runId}`,
        approved_by_user: true,
        write_report: false,
        shots: [{
          import_filename: validImport,
          order: 1,
          duration_seconds: 2,
          shot_description: "Force rollback after activation.",
          video_prompt: "Preserve the marker until cleanup succeeds."
        }]
      },
      db,
      {
        after_artifact_activated: () => { throw new Error("INJECTED_HANDOFF_ROLLBACK"); },
        remove_activation_file: () => { throw new Error("INJECTED_CLEANUP_FAILURE"); }
      }
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "HANDOFF_FREEZE_FAILED");
    assert.equal(result.report.imported_artifacts.length, 1);
    const imported = result.report.imported_artifacts[0];
    assert.equal(existsSync(imported.storage_uri), true);
    assert.equal(getMediaArtifact(db, imported.artifact_id), null);

    const recovered = recoverMediaActivations(db);
    assert.equal(recovered.failed.some((failure) => failure.code === "MEDIA_ACTIVATION_DB_RECORD_MISSING"), true);
    assert.equal(existsSync(imported.storage_uri), false);
  } finally {
    db.close();
  }
});

test("M1.5 rollback never deletes a deduplicated Blob owned by a committed Artifact", () => {
  const db = openM0Database();
  const runId = randomUUID().slice(0, 8);
  const validImport = copyTestImport(runId, 1);
  try {
    const committed = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
    }, db);
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    const committedBytes = readFileSync(committed.artifact.storage.uri);

    const result = freezeGptHandoffStoryboardPackage(
      {
        project_title: `M1.5 Shared Blob Rollback ${runId}`,
        approved_by_user: true,
        write_report: false,
        shots: [{
          import_filename: validImport,
          order: 1,
          duration_seconds: 2,
          shot_description: "Force rollback after Blob dedupe.",
          video_prompt: "Do not delete shared Blob storage."
        }]
      },
      db,
      { after_artifact_activated: () => { throw new Error("INJECTED_SHARED_BLOB_ROLLBACK"); } }
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.report.imported_artifacts[0].storage_uri, committed.artifact.storage.uri);
    assert.equal(existsSync(committed.artifact.storage.uri), true);
    const stored = getMediaArtifact(db, committed.artifact.artifact_id);
    assert.equal(stored ? verifyMediaArtifactBytes(db, stored).ok : false, true);
    assert.equal(readFileSync(committed.artifact.storage.uri).equals(committedBytes), true);
    assert.deepEqual(recoverMediaActivations(db), { committed: [], failed: [] });
  } finally {
    db.close();
  }
});

test("M1.5 blocks GPT-supplied unsafe image paths before artifact registration", () => {
  const db = openM0Database();

  try {
    const result = freezeGptHandoffStoryboardPackage(
      {
        project_title: "M1.5 Unsafe Handoff Test",
        approved_by_user: true,
        write_report: false,
        shots: [
          {
            import_filename: "../outside.png",
            order: 1,
            duration_seconds: 2,
            shot_description: "Unsafe path should fail.",
            video_prompt: "This should not be imported."
          }
        ]
      },
      db
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "STORAGE_PATH_NOT_ALLOWED");
    assert.equal(result.report.imported_artifacts.length, 0);
    assert.equal(result.report.network_call_attempted, false);
  } finally {
    db.close();
  }
});

test("M1.5 blocks audit and product-reference images before artifact registration", () => {
  const db = openM0Database();

  try {
    const runId = randomUUID().slice(0, 8);
    const audit = `gpt_handoff_audit_DO_NOT_USE_${runId}.png`;
    const reference = `gpt_handoff_product_reference_${runId}.png`;
    ensureM0Directories();
    mkdirSync(paths.importsRoot, { recursive: true });
    copyFileSync(CANARY_SOURCE, join(paths.importsRoot, audit));
    copyFileSync(CANARY_SOURCE, join(paths.importsRoot, reference));

    const scanned = scanGptHandoffImports().filter((image) => image.filename === audit || image.filename === reference);
    assert.equal(scanned.length, 2);
    assert.equal(scanned.every((image) => image.eligible_for_storyboard_image === false), true);

    const auditResult = freezeGptHandoffStoryboardPackage(
      {
        project_title: "M1.5 Audit Reject Test",
        approved_by_user: true,
        write_report: false,
        shots: [{ import_filename: audit, order: 1, duration_seconds: 2, shot_description: "Audit image.", video_prompt: "Should not import." }]
      },
      db
    );
    assert.equal(auditResult.ok, false);
    if (auditResult.ok) return;
    assert.equal(auditResult.error.code, "AUDIT_IMAGE_REJECTED");

    const referenceResult = freezeGptHandoffStoryboardPackage(
      {
        project_title: "M1.5 Product Reference Reject Test",
        approved_by_user: true,
        write_report: false,
        shots: [{ import_filename: reference, order: 1, duration_seconds: 2, shot_description: "Reference image.", video_prompt: "Should not import." }]
      },
      db
    );
    assert.equal(referenceResult.ok, false);
    if (referenceResult.ok) return;
    assert.equal(referenceResult.error.code, "PRODUCT_REFERENCE_REJECTED");
  } finally {
    db.close();
  }
});

test("M1.5 blocks non-vertical storyboard image imports", () => {
  const db = openM0Database();

  try {
    const runId = randomUUID().slice(0, 8);
    const filename = `gpt_handoff_square_${runId}.png`;
    ensureM0Directories();
    mkdirSync(paths.importsRoot, { recursive: true });
    copyFileSync(ONE_BY_ONE_SOURCE, join(paths.importsRoot, filename));

    const result = freezeGptHandoffStoryboardPackage(
      {
        project_title: "M1.5 Aspect Ratio Reject Test",
        approved_by_user: true,
        write_report: false,
        shots: [{ import_filename: filename, order: 1, duration_seconds: 2, shot_description: "Square image.", video_prompt: "Should not import." }]
      },
      db
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "ASPECT_RATIO_NOT_9_16");
    assert.equal(result.report.imported_artifacts.length, 0);
  } finally {
    db.close();
  }
});
