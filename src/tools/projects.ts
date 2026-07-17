import { randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { validateAcceptedClipReference } from "./mediaArtifacts.js";

export type ProjectStatus = "draft" | "storyboard_approved" | "video_generation_in_progress" | "video_review" | "final_approved";
export type ShotStatus = "draft" | "storyboard_approved" | "video_pending" | "video_generated" | "video_review" | "approved" | "revision_needed";

export interface Project {
  project_id: string;
  title: string;
  project_type: string;
  status: ProjectStatus;
  brief: Record<string, unknown>;
  video_spec: {
    duration_seconds: number;
    aspect_ratio: string;
    resolution: string;
  };
  shot_ids: string[];
  active_storyboard_package_id: string;
  generation_batch_ids: string[];
  exports: {
    final_video_artifact_id: string;
  };
}

export interface Shot {
  shot_id: string;
  project_id: string;
  order: number;
  status: ShotStatus;
  duration_seconds: number;
  description: string;
  storyboard_image_artifact_id: string;
  video_prompt: string;
  negative_prompt: string;
  generation_run_ids: string[];
  accepted_clip_artifact_id: string;
  clip_versions: Array<{
    artifact_id: string;
    run_id: string;
    attempt_number: number;
    review_status: "pending" | "approved" | "rejected";
  }>;
  review: {
    approval_status: "pending" | "approved" | "revision_needed";
    rejection_reasons: string[];
    latest_revision_instruction: null | {
      summary: string;
      prompt_delta: string;
      negative_delta: string;
      priority: "low" | "medium" | "high";
    };
  };
}

export interface ToolError {
  code: string;
  message: string;
}

export function createProject(
  input: {
    title: string;
    project_type?: string;
    brief?: Record<string, unknown>;
    video_spec?: Partial<Project["video_spec"]>;
  },
  db = openM0Database()
): { ok: true; project_id: string; status: ProjectStatus; project: Project } | { ok: false; error: ToolError } {
  if (!input.title) {
    return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", message: "title is required." } };
  }

  const project: Project = {
    project_id: `project_${randomUUID()}`,
    title: input.title,
    project_type: input.project_type ?? "m0_video_loop",
    status: "draft",
    brief: input.brief ?? {},
    video_spec: {
      duration_seconds: input.video_spec?.duration_seconds ?? 15,
      aspect_ratio: input.video_spec?.aspect_ratio ?? "9:16",
      resolution: input.video_spec?.resolution ?? "1080x1920"
    },
    shot_ids: [],
    active_storyboard_package_id: "",
    generation_batch_ids: [],
    exports: {
      final_video_artifact_id: ""
    }
  };

  saveProject(db, project);
  return { ok: true, project_id: project.project_id, status: project.status, project };
}

export function saveProject(db: M0Database, project: Project): void {
  db.prepare(`
    INSERT INTO projects (project_id, data_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(project_id) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(project.project_id, JSON.stringify(project));
}

export function getProject(db: M0Database, projectId: string): Project | null {
  const row = db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(projectId) as { data_json: string } | undefined;
  return row ? (JSON.parse(row.data_json) as Project) : null;
}

export function saveShot(db: M0Database, shot: Shot): void {
  db.prepare(`
    INSERT OR REPLACE INTO shots (shot_id, project_id, data_json, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(shot.shot_id, shot.project_id, JSON.stringify(shot));
}

export function getShot(db: M0Database, shotId: string): Shot | null {
  const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(shotId) as { data_json: string } | undefined;
  return row ? (JSON.parse(row.data_json) as Shot) : null;
}

export function listProjectShots(db: M0Database, projectId: string): Shot[] {
  const rows = db.prepare("SELECT data_json FROM shots WHERE project_id = ? ORDER BY json_extract(data_json, '$.order'), shot_id").all(projectId) as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as Shot);
}

export function getProjectStatus(input: { project_id: string }, db = openM0Database()) {
  const project = getProject(db, input.project_id);
  if (!project) {
    return { ok: false as const, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${input.project_id}` } };
  }

  const shots = listProjectShots(db, project.project_id);
  const readiness_checks = shots.map((shot) => {
    if (!shot.accepted_clip_artifact_id) {
      return { ok: false as const, code: "SHOT_ACCEPTED_CLIP_MISSING", shot_id: shot.shot_id, artifact_id: "" };
    }
    const validated = validateAcceptedClipReference(db, shot);
    return validated.ok
      ? { ok: true as const, code: "SHOT_ACCEPTED_CLIP_READY", shot_id: shot.shot_id, artifact_id: shot.accepted_clip_artifact_id }
      : { ok: false as const, code: validated.error.code, shot_id: shot.shot_id, artifact_id: shot.accepted_clip_artifact_id };
  });
  const blocking_reasons = readiness_checks
    .filter((check) => !check.ok)
    .map((check) => `Shot ${String(shots.find((shot) => shot.shot_id === check.shot_id)?.order ?? 0).padStart(3, "0")} [${check.code}]`);

  return {
    ok: true as const,
    project,
    status: project.status,
    shots,
    generation_batches: project.generation_batch_ids,
    generation_runs: shots.flatMap((shot) => shot.generation_run_ids),
    ready_for_assembly: shots.length > 0 && readiness_checks.every((check) => check.ok),
    blocking_reasons,
    readiness_checks,
    final_video_artifact_id: project.exports.final_video_artifact_id
  };
}

export function buildStoryboardApprovedShot(input: {
  shot_id?: string;
  project_id: string;
  order: number;
  duration_seconds: number;
  description?: string;
  storyboard_image_artifact_id: string;
  video_prompt: string;
  negative_prompt?: string;
}): Shot {
  return {
    shot_id: input.shot_id || `shot_${randomUUID()}`,
    project_id: input.project_id,
    order: input.order,
    status: "storyboard_approved",
    duration_seconds: input.duration_seconds,
    description: input.description ?? "",
    storyboard_image_artifact_id: input.storyboard_image_artifact_id,
    video_prompt: input.video_prompt,
    negative_prompt: input.negative_prompt ?? "",
    generation_run_ids: [],
    accepted_clip_artifact_id: "",
    clip_versions: [],
    review: {
      approval_status: "pending",
      rejection_reasons: [],
      latest_revision_instruction: null
    }
  };
}
