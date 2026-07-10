import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { assertInsideWorkspace, paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getMediaArtifact } from "./mediaArtifacts.js";
import { getProject, saveProject, type Project, type Shot, type ToolError } from "./projects.js";
import { importStoryboardPackage, type ImportStoryboardPackageInput } from "./storyboardPackages.js";
import { isNineSixteenAspectRatio } from "./importClassifier.js";

export type G0ArtifactKind =
  | "creative_brief"
  | "script"
  | "shot_list"
  | "storyboard_image_prompts"
  | "storyboard_review_record"
  | "storyboard_package_draft"
  | "storyboard_package";

export const G0_ARTIFACT_FILENAMES: Record<G0ArtifactKind, string> = {
  creative_brief: "creative_brief.json",
  script: "script.json",
  shot_list: "shot_list.json",
  storyboard_image_prompts: "storyboard_image_prompts.json",
  storyboard_review_record: "storyboard_review_record.json",
  storyboard_package_draft: "storyboard_package_draft.json",
  storyboard_package: "storyboard_package.json"
};

export interface G0SavedArtifact {
  project_id: string;
  kind: G0ArtifactKind;
  filename: string;
  path: string;
  saved_at: string;
}

export interface G0SavedArtifactEnvelope {
  project_id: string;
  kind: G0ArtifactKind;
  saved_at: string;
  payload: unknown;
}

export interface G0StoryboardPackageShotSnapshot {
  shot_id: string;
  order: number;
  duration_seconds: number;
  storyboard_image_artifact_id: string;
  shot_description: string;
  video_prompt: string;
  negative_prompt: string;
  continuity_constraints: string[];
  approved_by_user: boolean;
}

export interface G0StoryboardPackageInput {
  storyboard_package_id?: string;
  project_id: string;
  status: "draft_for_review" | "approved_for_video_generation";
  shots: G0StoryboardPackageShotSnapshot[];
  approved_by_user: boolean;
  confirmation?: {
    user_confirmed: boolean;
    source: "test_fixture" | "jenn" | "app";
  };
}

export type G0ValidationResult =
  | {
      ok: true;
      status: "draft_for_review" | "approved_for_video_generation";
      app_ready: boolean;
      import_input?: ImportStoryboardPackageInput;
    }
  | { ok: false; error: ToolError };

export type G0SaveResult =
  | { ok: true; saved: G0SavedArtifact }
  | { ok: false; error: ToolError };

export type G0ImportResult =
  | {
      ok: true;
      storyboard_package_id: string;
      project: Project;
      shots: Shot[];
      saved_package: G0SavedArtifact;
    }
  | { ok: false; error: ToolError };

function safeProjectFolder(projectId: string): string | null {
  if (!projectId || projectId.includes("..") || projectId.includes("/") || projectId.includes("\\")) {
    return null;
  }
  return projectId;
}

export function g0ProjectRoot(projectId: string): string {
  const safe = safeProjectFolder(projectId);
  if (!safe) {
    throw new Error(`Invalid project id for G0 storage: ${projectId}`);
  }
  return assertInsideWorkspace(resolve(paths.dataRoot, "projects", safe, "g0"), paths.dataRoot);
}

function ensureG0ProjectRoot(projectId: string): string {
  const root = g0ProjectRoot(projectId);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

function projectOrError(projectId: string, db: M0Database): Project | ToolError {
  const project = getProject(db, projectId);
  if (!project) return { code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` };
  return project;
}

export function saveG0Artifact(
  input: { project_id: string; kind: G0ArtifactKind; payload: unknown },
  db = openM0Database()
): G0SaveResult {
  const project = projectOrError(input.project_id, db);
  if ("code" in project) return { ok: false, error: project };

  const filename = G0_ARTIFACT_FILENAMES[input.kind];
  if (!filename) return { ok: false, error: { code: "G0_UNSUPPORTED_ARTIFACT_KIND", message: `Unsupported G0 artifact kind: ${input.kind}` } };

  const root = ensureG0ProjectRoot(input.project_id);
  const target = assertInsideWorkspace(join(root, filename), root);
  const savedAt = new Date().toISOString();
  const envelope: G0SavedArtifactEnvelope = {
    project_id: input.project_id,
    kind: input.kind,
    saved_at: savedAt,
    payload: input.payload
  };

  writeFileSync(target, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

  if (input.kind === "creative_brief" && input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)) {
    project.brief = input.payload as Record<string, unknown>;
    saveProject(db, project);
  }

  return {
    ok: true,
    saved: {
      project_id: input.project_id,
      kind: input.kind,
      filename,
      path: target,
      saved_at: savedAt
    }
  };
}

export function readG0Artifact(projectId: string, kind: G0ArtifactKind): G0SavedArtifactEnvelope | null {
  const filename = G0_ARTIFACT_FILENAMES[kind];
  const target = join(g0ProjectRoot(projectId), filename);
  if (!existsSync(target)) return null;
  return JSON.parse(readFileSync(target, "utf8")) as G0SavedArtifactEnvelope;
}

function requiredString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function validateAppReadyShot(snapshot: G0StoryboardPackageShotSnapshot, index: number, db: M0Database): ToolError | null {
  const label = `G0 shot snapshot ${index + 1}`;

  if (!requiredString(snapshot.shot_id)) return { code: "MISSING_REQUIRED_FIELD", message: `${label} is missing shot_id.` };
  if (!Number.isInteger(snapshot.order) || snapshot.order <= 0) return { code: "MISSING_REQUIRED_FIELD", message: `${label} has invalid order.` };
  if (typeof snapshot.duration_seconds !== "number" || snapshot.duration_seconds <= 0) {
    return { code: "MISSING_REQUIRED_FIELD", message: `${label} has invalid duration_seconds.` };
  }
  if (!requiredString(snapshot.storyboard_image_artifact_id)) {
    return { code: "MISSING_REQUIRED_FIELD", message: `${label} is missing storyboard_image_artifact_id.` };
  }
  if (!requiredString(snapshot.shot_description)) return { code: "MISSING_REQUIRED_FIELD", message: `${label} is missing shot_description.` };
  if (!requiredString(snapshot.video_prompt)) return { code: "MISSING_REQUIRED_FIELD", message: `${label} is missing video_prompt.` };
  if (typeof snapshot.negative_prompt !== "string") return { code: "MISSING_REQUIRED_FIELD", message: `${label} is missing negative_prompt.` };
  if (!Array.isArray(snapshot.continuity_constraints)) {
    return { code: "MISSING_REQUIRED_FIELD", message: `${label} is missing continuity_constraints.` };
  }
  if (snapshot.approved_by_user !== true) return { code: "USER_APPROVAL_REQUIRED", message: `${label} is not approved by user.` };

  const artifact = getMediaArtifact(db, snapshot.storyboard_image_artifact_id);
  if (!artifact) {
    return { code: "ARTIFACT_NOT_FOUND", message: `Storyboard artifact not found: ${snapshot.storyboard_image_artifact_id}` };
  }
  if (artifact.status !== "active") return { code: `ARTIFACT_${artifact.status.toUpperCase()}`, message: `Storyboard artifact is not active: ${artifact.status}` };
  if (artifact.artifact_type !== "image" || artifact.role !== "storyboard_image") {
    return { code: "INVALID_ARTIFACT_ROLE", message: "G0 app-ready package requires active storyboard_image image artifacts." };
  }
  if (!isNineSixteenAspectRatio(artifact.metadata.aspect_ratio)) {
    return { code: "STORYBOARD_IMAGE_ASPECT_RATIO_NOT_9_16", message: "G0 app-ready package requires vertical 9:16 storyboard_image artifacts." };
  }

  return null;
}

export function validateG0StoryboardPackage(input: G0StoryboardPackageInput, db = openM0Database()): G0ValidationResult {
  const project = projectOrError(input.project_id, db);
  if ("code" in project) return { ok: false, error: project };

  if (input.status === "draft_for_review") {
    return {
      ok: true,
      status: "draft_for_review",
      app_ready: false
    };
  }

  if (input.status !== "approved_for_video_generation") {
    return { ok: false, error: { code: "G0_INVALID_PACKAGE_STATUS", message: `Unsupported G0 package status: ${input.status}` } };
  }
  if (input.approved_by_user !== true) {
    return { ok: false, error: { code: "USER_APPROVAL_REQUIRED", message: "G0 app-ready package requires approved_by_user=true." } };
  }
  if (input.confirmation?.user_confirmed !== true) {
    return { ok: false, error: { code: "CONFIRMATION_REQUIRED", message: "G0 app-ready package requires Jenn or test fixture confirmation." } };
  }
  if (!input.shots.length) {
    return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", message: "G0 app-ready package requires at least one shot." } };
  }

  for (const [index, snapshot] of input.shots.entries()) {
    const error = validateAppReadyShot(snapshot, index, db);
    if (error) return { ok: false, error };
  }

  return {
    ok: true,
    status: "approved_for_video_generation",
    app_ready: true,
    import_input: {
      storyboard_package_id: input.storyboard_package_id,
      project_id: input.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: input.shots.map((shot) => ({
        shot_id: shot.shot_id,
        order: shot.order,
        duration_seconds: shot.duration_seconds,
        description: shot.shot_description,
        storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
        video_prompt: shot.video_prompt,
        negative_prompt: shot.negative_prompt
      })),
      user_approval: {
        storyboard_approved: true
      }
    }
  };
}

export function importG0AppReadyStoryboardPackage(input: G0StoryboardPackageInput, db = openM0Database()): G0ImportResult {
  const validation = validateG0StoryboardPackage(input, db);
  if (!validation.ok) return validation;
  if (!validation.app_ready || !validation.import_input) {
    return { ok: false, error: { code: "DRAFT_PACKAGE_NOT_APP_READY", message: "Draft packages cannot start video generation." } };
  }

  const imported = importStoryboardPackage(validation.import_input, db);
  if (!imported.ok) return imported;

  const saved = saveG0Artifact(
    {
      project_id: input.project_id,
      kind: "storyboard_package",
      payload: {
        ...input,
        storyboard_package_id: imported.storyboard_package_id
      }
    },
    db
  );
  if (!saved.ok) return saved;

  return {
    ok: true,
    storyboard_package_id: imported.storyboard_package_id,
    project: imported.project,
    shots: imported.shots,
    saved_package: saved.saved
  };
}
