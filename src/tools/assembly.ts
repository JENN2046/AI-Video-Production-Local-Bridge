import { randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getMediaArtifact, registerMediaArtifact } from "./mediaArtifacts.js";
import { saveGenerationRun, type Confirmation, type GenerationRun } from "./generation.js";
import { getProject, listProjectShots, saveProject, type ToolError } from "./projects.js";

type ToolResult<T> = { ok: true } & T | { ok: false; error: ToolError; blocking_reasons?: string[] };

const M0_FINAL_PLACEHOLDER_FIXTURE = "video/mock_clip.mp4";
const M0_FINAL_PLACEHOLDER_DURATION_SECONDS = 2;

function explicitConfirmed(confirmation?: Confirmation): boolean {
  return confirmation?.confirmation_level === "explicit" && confirmation.user_confirmed === true;
}

function finalAssemblyBlockingReasons(db: M0Database, projectId: string): string[] {
  const shots = listProjectShots(db, projectId);
  const reasons: string[] = [];

  for (const shot of shots) {
    if (!shot.accepted_clip_artifact_id) {
      reasons.push(`Shot ${String(shot.order).padStart(3, "0")} has no accepted clip`);
      continue;
    }

    const artifact = getMediaArtifact(db, shot.accepted_clip_artifact_id);
    if (!artifact) {
      reasons.push(`Shot ${String(shot.order).padStart(3, "0")} accepted clip artifact is missing`);
      continue;
    }
    if (artifact.status !== "active") reasons.push(`Shot ${String(shot.order).padStart(3, "0")} accepted clip is not active`);
    if (artifact.artifact_type !== "video" || artifact.role !== "generated_clip") {
      reasons.push(`Shot ${String(shot.order).padStart(3, "0")} accepted clip is not a generated_clip video`);
    }
  }

  return reasons;
}

export function assembleFinalVideo(
  input: {
    project_id: string;
    confirmation?: Confirmation;
  },
  db = openM0Database()
): ToolResult<{ run: GenerationRun; final_video_artifact_id: string }> {
  if (!explicitConfirmed(input.confirmation)) {
    return { ok: false, error: { code: "USER_CONFIRMATION_REQUIRED", message: "Final assembly requires explicit confirmation." } };
  }

  const project = getProject(db, input.project_id);
  if (!project) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${input.project_id}` } };

  const shots = listProjectShots(db, project.project_id);
  const blockingReasons = finalAssemblyBlockingReasons(db, project.project_id);
  if (!shots.length || blockingReasons.length) {
    return {
      ok: false,
      error: { code: "FINAL_ASSEMBLY_NOT_READY", message: "Final assembly is not ready." },
      blocking_reasons: !shots.length ? ["Project has no shots"] : blockingReasons
    };
  }

  const artifact = registerMediaArtifact(
    {
      artifact_type: "video",
      role: "final_video",
      source: {
        kind: "fixture_path",
        path: M0_FINAL_PLACEHOLDER_FIXTURE
      },
      linked_objects: {
        project_id: project.project_id
      },
      metadata: {
        duration_seconds: M0_FINAL_PLACEHOLDER_DURATION_SECONDS,
        aspect_ratio: project.video_spec.aspect_ratio,
        width: 1080,
        height: 1920
      }
    },
    db
  );
  if (!artifact.ok) {
    return { ok: false, error: { code: "GENERATION_PROVIDER_ERROR", message: artifact.error.message } };
  }

  const run: GenerationRun = {
    run_id: `run_${randomUUID()}`,
    batch_id: "",
    project_id: project.project_id,
    shot_id: "",
    run_type: "assemble_video",
    status: "succeeded",
    input: {
      storyboard_image_artifact_id: "",
      video_prompt: "assemble accepted M0 clips",
      negative_prompt: "",
      duration_seconds: shots.reduce((sum, shot) => sum + shot.duration_seconds, 0),
      aspect_ratio: project.video_spec.aspect_ratio,
      resolution: project.video_spec.resolution
    },
    output: {
      artifact_ids: [artifact.artifact.artifact_id]
    },
    provider: {
      provider: "mock",
      provider_name: "mock",
      model_name: "placeholder_copy",
      provider_job_id: "",
      provider_status: "succeeded"
    },
    versioning: {
      attempt_number: 1,
      parent_run_id: ""
    },
    error: {
      code: "",
      message: "",
      retryable: false
    }
  };

  project.exports.final_video_artifact_id = artifact.artifact.artifact_id;
  project.status = "video_review";
  saveProject(db, project);
  saveGenerationRun(db, run);

  return { ok: true, run, final_video_artifact_id: artifact.artifact.artifact_id };
}
