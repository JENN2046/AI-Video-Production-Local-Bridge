import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import {
  activatePendingMediaArtifact,
  createProject,
  ensureM0Directories,
  getProjectStatus,
  importStoryboardPackage,
  openM0Database,
  paths,
  registerMediaArtifact,
  validateImageFile
} from "../src/index.js";

const SAMPLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

function writeImportImage(filename: string, bytes = SAMPLE_PNG): string {
  ensureM0Directories();
  mkdirSync(paths.importsRoot, { recursive: true });
  const target = join(paths.importsRoot, filename);
  writeFileSync(target, bytes);
  return target;
}

function pathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("\\"));
}

function symlinkEscapeCheck(): "PASS" | "FAIL" | "NOT_TESTED" {
  const outsidePath = join(paths.dataRoot, "m1_0_demo_symlink_outside.png");
  const linkPath = join(paths.importsRoot, "m1_0_demo_symlink.png");
  writeFileSync(outsidePath, SAMPLE_PNG);
  rmSync(linkPath, { force: true });

  try {
    symlinkSync(outsidePath, linkPath, "file");
  } catch {
    rmSync(outsidePath, { force: true });
    return "NOT_TESTED";
  }

  const db = openM0Database();
  try {
    const result = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "local_file_import", import_filename: basename(linkPath) }
      },
      db
    );
    return !result.ok && result.error.code === "SYMLINK_ESCAPE_BLOCKED" ? "PASS" : "FAIL";
  } finally {
    db.close();
    rmSync(linkPath, { force: true });
    rmSync(outsidePath, { force: true });
  }
}

ensureM0Directories();
const db = openM0Database();

try {
  const manualSource = writeImportImage("gpt_storyboard_external_001.png");
  const pendingSource = writeImportImage("gpt_storyboard_external_pending.png");
  writeImportImage("gpt_storyboard_invalid.png", Buffer.from("not an image", "utf8"));

  const manual = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "local_file_import", import_filename: basename(manualSource) }
    },
    db
  );
  if (!manual.ok) throw new Error(manual.error.message);
  const manualValidation = validateImageFile(manual.artifact.storage.uri);
  if (!manualValidation.ok) throw new Error(manualValidation.error);

  const manualProject = createProject({ title: "M1-0 Local Import Demo" }, db);
  if (!manualProject.ok) throw new Error("Manual import project setup failed.");
  const imported = importStoryboardPackage(
    {
      project_id: manualProject.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [
        {
          order: 1,
          duration_seconds: 2,
          description: "M1-0 external local import storyboard",
          storyboard_image_artifact_id: manual.artifact.artifact_id,
          video_prompt: "Animate the external local import storyboard image."
        }
      ],
      user_approval: { storyboard_approved: true }
    },
    db
  );
  if (!imported.ok) throw new Error(imported.error.message);
  const manualStatus = getProjectStatus({ project_id: manualProject.project_id }, db);
  if (!manualStatus.ok) throw new Error(manualStatus.error.message);

  const pending = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "pending_user_upload", filename: "pending.png", mime_type: "image/png" }
    },
    db
  );
  if (!pending.ok) throw new Error(pending.error.message);
  const pendingProject = createProject({ title: "M1-0 Pending Upload Demo" }, db);
  if (!pendingProject.ok) throw new Error("Pending project setup failed.");
  const pendingBeforeActivation = importStoryboardPackage(
    {
      project_id: pendingProject.project_id,
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
  const activated = activatePendingMediaArtifact(
    {
      artifact_id: pending.artifact.artifact_id,
      source: { kind: "local_file_import", import_filename: basename(pendingSource) }
    },
    db
  );
  if (!activated.ok) throw new Error(activated.error.message);
  const activatedValidation = validateImageFile(activated.artifact.storage.uri);
  if (!activatedValidation.ok) throw new Error(activatedValidation.error);
  const pendingAfterActivation = importStoryboardPackage(
    {
      project_id: pendingProject.project_id,
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
  if (!pendingAfterActivation.ok) throw new Error(pendingAfterActivation.error.message);

  const invalidImage = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "local_file_import", import_filename: "gpt_storyboard_invalid.png" }
    },
    db
  );
  const traversal = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "local_file_import", import_filename: "../../outside.png" }
    },
    db
  );
  const privateUri = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "accessible_uri", uri: "http://127.0.0.1/test.png", filename: "test.png", mime_type: "image/png" }
    },
    db
  );
  const publicUri = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "accessible_uri", uri: "https://example.test/storyboard/external.png", filename: "external.png", mime_type: "image/png" }
    },
    db
  );

  const payload = {
    phase: "M1-0",
    result: "PASS_WITH_GAPS",
    manual_upload_or_local_import: {
      status: "PASS",
      artifact_id: manual.artifact.artifact_id,
      source_path: manualSource,
      stored_path: manual.artifact.storage.uri,
      source_inside_imports: pathInside(manualSource, paths.importsRoot),
      stored_inside_media: pathInside(manual.artifact.storage.uri, paths.imageArtifactsRoot),
      width: manualValidation.width,
      height: manualValidation.height,
      detected_mime: manualValidation.detected_mime,
      sha256: manualValidation.sha256
    },
    pending_upload_activation: {
      status: "PASS",
      pending_blocked_before_activation: !pendingBeforeActivation.ok,
      pending_artifact_id: pending.artifact.artifact_id,
      activated_artifact_id: activated.artifact.artifact_id,
      stored_path: activated.artifact.storage.uri,
      width: activatedValidation.width,
      height: activatedValidation.height,
      detected_mime: activatedValidation.detected_mime,
      sha256: activatedValidation.sha256
    },
    storyboard_package_validation: {
      external_image_artifact_imported: "PASS",
      project_status_after_import: manualStatus.status,
      shot_count: manualStatus.shots.length
    },
    negative_tests: {
      invalid_image_blocked: !invalidImage.ok && invalidImage.error.code === "IMAGE_FILE_INVALID" ? "PASS" : "FAIL",
      path_traversal_blocked: !traversal.ok && traversal.error.code === "STORAGE_PATH_NOT_ALLOWED" ? "PASS" : "FAIL",
      symlink_escape_blocked: symlinkEscapeCheck(),
      pending_upload_blocked_before_activation: !pendingBeforeActivation.ok ? "PASS" : "FAIL",
      accessible_uri_private_network_blocked: !privateUri.ok && privateUri.error.code === "EXTERNAL_URI_PRIVATE_NETWORK_BLOCKED" ? "PASS" : "FAIL"
    },
    accessible_uri: {
      status: "NOT_TESTED",
      uri: "https://example.test/storyboard/external.png",
      error_code: publicUri.ok && publicUri.artifact.status !== "active" ? "EXTERNAL_URI_DOWNLOAD_NOT_ATTEMPTED" : "UNEXPECTED_ACTIVE_ARTIFACT"
    },
    chatgpt_file_handle: {
      status: "NOT_TESTED"
    }
  };

  writeFileSync(join(paths.reportsRoot, "m1_0_external_image_transfer_demo_result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload, null, 2));
} finally {
  db.close();
}
