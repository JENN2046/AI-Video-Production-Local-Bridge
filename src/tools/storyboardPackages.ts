import { randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getMediaArtifact } from "./mediaArtifacts.js";
import {
  buildStoryboardApprovedShot,
  getProject,
  saveProject,
  saveShot,
  type Project,
  type Shot,
  type ToolError
} from "./projects.js";

export interface ApprovedShotSnapshot {
  shot_id?: string;
  order: number;
  duration_seconds: number;
  description?: string;
  storyboard_image_artifact_id: string;
  video_prompt: string;
  negative_prompt?: string;
}

export interface StoryboardPackage {
  storyboard_package_id: string;
  project_id: string;
  status: "approved_for_video_generation";
  approved_shot_snapshots: ApprovedShotSnapshot[];
  user_approval: {
    storyboard_approved: true;
  };
}

export interface ImportStoryboardPackageInput {
  storyboard_package_id?: string;
  project_id: string;
  status: "approved_for_video_generation" | string;
  approved_shot_snapshots: ApprovedShotSnapshot[];
  user_approval: {
    storyboard_approved: boolean;
  };
}

type ImportResult =
  | {
      ok: true;
      storyboard_package_id: string;
      project: Project;
      shots: Shot[];
      storyboard_package: StoryboardPackage;
    }
  | { ok: false; error: ToolError };

function gateErrorForArtifactStatus(status: string): string {
  if (status === "pending_upload") return "ARTIFACT_PENDING_UPLOAD";
  if (status === "inaccessible") return "ARTIFACT_INACCESSIBLE";
  if (status === "expired") return "ARTIFACT_EXPIRED";
  return "INVALID_STATUS_TRANSITION";
}

function validateSnapshot(snapshot: ApprovedShotSnapshot, index: number, db: M0Database): ToolError | null {
  if (!snapshot.storyboard_image_artifact_id || !snapshot.video_prompt || !snapshot.duration_seconds) {
    return { code: "MISSING_REQUIRED_FIELD", message: `Shot snapshot ${index + 1} is missing a required field.` };
  }

  const artifact = getMediaArtifact(db, snapshot.storyboard_image_artifact_id);
  if (!artifact) {
    return { code: "ARTIFACT_NOT_FOUND", message: `Storyboard artifact not found: ${snapshot.storyboard_image_artifact_id}` };
  }

  if (artifact.status !== "active") {
    return { code: gateErrorForArtifactStatus(artifact.status), message: `Storyboard artifact is not active: ${artifact.status}` };
  }

  if (artifact.role !== "storyboard_image" || artifact.artifact_type !== "image") {
    return { code: "INVALID_ARTIFACT_ROLE", message: "Storyboard Package requires active storyboard_image image artifacts." };
  }

  return null;
}

export function saveStoryboardPackage(db: M0Database, storyboardPackage: StoryboardPackage): void {
  db.prepare(`
    INSERT OR REPLACE INTO storyboard_packages (storyboard_package_id, project_id, data_json, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(storyboardPackage.storyboard_package_id, storyboardPackage.project_id, JSON.stringify(storyboardPackage));
}

export function getStoryboardPackage(db: M0Database, storyboardPackageId: string): StoryboardPackage | null {
  const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(storyboardPackageId) as { data_json: string } | undefined;
  return row ? (JSON.parse(row.data_json) as StoryboardPackage) : null;
}

export function importStoryboardPackage(input: ImportStoryboardPackageInput, db = openM0Database()): ImportResult {
  const project = getProject(db, input.project_id);
  if (!project) {
    return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${input.project_id}` } };
  }

  if (input.status !== "approved_for_video_generation" || input.user_approval?.storyboard_approved !== true) {
    return { ok: false, error: { code: "UNAPPROVED_STORYBOARD_PACKAGE", message: "Storyboard Package is not approved for video generation." } };
  }

  if (!input.approved_shot_snapshots?.length) {
    return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", message: "approved_shot_snapshots must not be empty." } };
  }

  for (const [index, snapshot] of input.approved_shot_snapshots.entries()) {
    const error = validateSnapshot(snapshot, index, db);
    if (error) return { ok: false, error };
  }

  const frozenSnapshots = structuredClone(input.approved_shot_snapshots);
  const storyboardPackage: StoryboardPackage = {
    storyboard_package_id: input.storyboard_package_id || `storyboard_package_${randomUUID()}`,
    project_id: input.project_id,
    status: "approved_for_video_generation",
    approved_shot_snapshots: frozenSnapshots,
    user_approval: {
      storyboard_approved: true
    }
  };

  const shots = frozenSnapshots.map((snapshot) =>
    buildStoryboardApprovedShot({
      ...snapshot,
      project_id: project.project_id
    })
  );

  for (const shot of shots) {
    saveShot(db, shot);
  }

  project.status = "storyboard_approved";
  project.active_storyboard_package_id = storyboardPackage.storyboard_package_id;
  project.shot_ids = shots.map((shot) => shot.shot_id);
  saveProject(db, project);
  saveStoryboardPackage(db, storyboardPackage);

  return {
    ok: true,
    storyboard_package_id: storyboardPackage.storyboard_package_id,
    project,
    shots,
    storyboard_package: storyboardPackage
  };
}
