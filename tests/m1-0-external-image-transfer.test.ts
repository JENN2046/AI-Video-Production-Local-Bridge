import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  activatePendingMediaArtifact,
  createProject,
  ensureM0Directories,
  getMediaArtifact,
  getProjectStatus,
  importStoryboardPackage,
  openM0Database,
  paths,
  registerMediaArtifact,
  validateImageFile
} from "../src/index.js";

const SAMPLE_PNG = readFileSync(join(paths.workspaceRoot, "fixtures", "provider-canary", "m1-r0", "shot_001_canary_720x1280.png"));

function writeImportImage(filename: string, bytes = SAMPLE_PNG): string {
  ensureM0Directories();
  mkdirSync(paths.importsRoot, { recursive: true });
  const target = join(paths.importsRoot, filename);
  writeFileSync(target, bytes);
  return target;
}

function assertPathInside(child: string, parent: string): void {
  const rel = relative(resolve(parent), resolve(child));
  assert.equal(rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith("\\\\")), true);
}

test("M1-0 local import real image becomes active artifact usable by Storyboard Package", () => {
  const db = openM0Database();
  const sourcePath = writeImportImage("gpt_storyboard_external_001.png");

  try {
    const artifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "local_file_import", import_filename: basename(sourcePath) }
      },
      db
    );
    assert.equal(artifact.ok, true);
    if (!artifact.ok) return;

    assert.equal(artifact.artifact.status, "active");
    assert.equal(artifact.artifact.storage.mime_type, "image/png");
    assert.equal(artifact.artifact.metadata.width, 720);
    assert.equal(artifact.artifact.metadata.height, 1280);
    assertPathInside(artifact.artifact.storage.uri, paths.imageArtifactsRoot);
    assert.equal(resolve(sourcePath).startsWith(resolve(paths.importsRoot)), true);
    assert.equal(resolve(sourcePath).includes(`${resolve(paths.workspaceRoot)}\\fixtures\\`), false);

    const storedValidation = validateImageFile(artifact.artifact.storage.uri);
    assert.equal(storedValidation.ok, true, storedValidation.error);
    assert.equal(storedValidation.width, artifact.artifact.metadata.width);
    assert.equal(storedValidation.height, artifact.artifact.metadata.height);

    const project = createProject({ title: "M1-0 Local Import" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) return;
    const imported = importStoryboardPackage(
      {
        project_id: project.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            description: "External local import shot",
            storyboard_image_artifact_id: artifact.artifact.artifact_id,
            video_prompt: "Animate the external storyboard image."
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );
    assert.equal(imported.ok, true);
    const status = getProjectStatus({ project_id: project.project_id }, db);
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(status.status, "storyboard_approved");
    assert.equal(status.shots.length, 1);
  } finally {
    db.close();
  }
});

test("M1-0 pending upload cannot enter Storyboard Package before activation", () => {
  const db = openM0Database();

  try {
    const project = createProject({ title: "M1-0 Pending Block" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) return;
    const pending = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "pending_user_upload", filename: "pending.png", mime_type: "image/png" }
      },
      db
    );
    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    assert.equal(pending.artifact.status, "pending_upload");

    const imported = importStoryboardPackage(
      {
        project_id: project.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            storyboard_image_artifact_id: pending.artifact.artifact_id,
            video_prompt: "Animate after activation."
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );
    assert.equal(imported.ok, false);
    if (imported.ok) return;
    assert.equal(imported.error.code, "ARTIFACT_PENDING_UPLOAD");
  } finally {
    db.close();
  }
});

test("M1-0 pending upload activates with same artifact id and can enter Storyboard Package", () => {
  const db = openM0Database();
  const importPath = writeImportImage("gpt_storyboard_external_pending.png");

  try {
    const pending = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "pending_user_upload", filename: "pending.png", mime_type: "image/png" }
      },
      db
    );
    assert.equal(pending.ok, true);
    if (!pending.ok) return;

    const activated = activatePendingMediaArtifact(
      {
        artifact_id: pending.artifact.artifact_id,
        source: { kind: "local_file_import", import_filename: basename(importPath) }
      },
      db
    );
    assert.equal(activated.ok, true);
    if (!activated.ok) return;
    assert.equal(activated.artifact.artifact_id, pending.artifact.artifact_id);
    assert.equal(activated.artifact.status, "active");
    assertPathInside(activated.artifact.storage.uri, paths.imageArtifactsRoot);

    const project = createProject({ title: "M1-0 Pending Activated" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) return;
    const imported = importStoryboardPackage(
      {
        project_id: project.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            storyboard_image_artifact_id: activated.artifact.artifact_id,
            video_prompt: "Animate activated external image."
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );
    assert.equal(imported.ok, true);
  } finally {
    db.close();
  }
});

test("M1-0 pending app upload stages bytes under the existing artifact id", () => {
  const db = openM0Database();
  try {
    const pending = registerMediaArtifact({
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "pending_user_upload", filename: "pending-app.png", mime_type: "image/png" }
    }, db);
    assert.equal(pending.ok, true);
    if (!pending.ok) return;

    const activated = activatePendingMediaArtifact({
      artifact_id: pending.artifact.artifact_id,
      source: { kind: "app_upload", filename: "uploaded.png", mime_type: "image/png", bytes_base64: SAMPLE_PNG.toString("base64") }
    }, db);
    assert.equal(activated.ok, true, activated.ok ? undefined : activated.error.code);
    if (!activated.ok) return;
    assert.equal(activated.artifact.artifact_id, pending.artifact.artifact_id);
    assert.equal(activated.artifact.status, "active");
    assert.equal(existsSync(activated.artifact.storage.uri), true);
  } finally {
    db.close();
  }
});

test("M1-0 invalid disguised image is rejected", () => {
  const db = openM0Database();
  writeImportImage("gpt_storyboard_invalid.png", Buffer.from("not an image", "utf8"));

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "local_file_import", import_filename: "gpt_storyboard_invalid.png" }
      },
      db
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "IMAGE_FILE_INVALID");
  } finally {
    db.close();
  }
});

test("M1-0 local import path traversal is rejected", () => {
  const db = openM0Database();

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "local_file_import", import_filename: "../../outside.png" }
      },
      db
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "STORAGE_PATH_NOT_ALLOWED");
  } finally {
    db.close();
  }
});

test("M1-0 symlink escape is blocked when symlinks are available", (t) => {
  const db = openM0Database();
  ensureM0Directories();
  const outsidePath = join(paths.dataRoot, "m1_0_symlink_outside.png");
  const linkPath = join(paths.importsRoot, "symlink_to_outside.png");
  writeFileSync(outsidePath, SAMPLE_PNG);
  rmSync(linkPath, { force: true });

  try {
    symlinkSync(outsidePath, linkPath, "file");
  } catch {
    t.skip("Symlink creation is unavailable in this Windows environment.");
    db.close();
    return;
  }

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "local_file_import", import_filename: "symlink_to_outside.png" }
      },
      db
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "SYMLINK_ESCAPE_BLOCKED");
  } finally {
    rmSync(linkPath, { force: true });
    rmSync(outsidePath, { force: true });
    db.close();
  }
});

test("M1-0 accessible URI private network and forbidden schemes are blocked", () => {
  const db = openM0Database();

  try {
    const privateUri = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "accessible_uri", uri: "http://127.0.0.1/test.png", filename: "test.png", mime_type: "image/png" }
      },
      db
    );
    assert.equal(privateUri.ok, false);
    if (privateUri.ok) return;
    assert.equal(privateUri.error.code, "EXTERNAL_URI_PRIVATE_NETWORK_BLOCKED");

    const fileUri = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "accessible_uri", uri: "file:///etc/passwd", filename: "passwd.png", mime_type: "image/png" }
      },
      db
    );
    assert.equal(fileUri.ok, false);
    if (fileUri.ok) return;
    assert.equal(fileUri.error.code, "EXTERNAL_URI_SCHEME_NOT_ALLOWED");
  } finally {
    db.close();
  }
});

test("M1-0 accessible URI path does not mark unverified public URI active", () => {
  const db = openM0Database();

  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: {
          kind: "accessible_uri",
          uri: "https://example.test/storyboard/external.png",
          filename: "external.png",
          mime_type: "image/png"
        }
      },
      db
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.artifact.status, "inaccessible");
    assert.equal(getMediaArtifact(db, result.artifact.artifact_id)?.status, "inaccessible");
  } finally {
    db.close();
  }
});
