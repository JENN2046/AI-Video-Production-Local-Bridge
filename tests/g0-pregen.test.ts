import assert from "node:assert/strict";
import test from "node:test";

import {
  createProject,
  getProject,
  importG0AppReadyStoryboardPackage,
  openM0Database,
  readG0Artifact,
  registerMediaArtifact,
  saveG0Artifact,
  validateG0StoryboardPackage,
  type G0StoryboardPackageInput
} from "../src/index.js";

function createActiveStoryboardArtifact(db: ReturnType<typeof openM0Database>) {
  const result = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "storyboard/shot_001.png" }
    },
    db
  );
  if (!result.ok) throw new Error(result.error.message);
  assert.equal(result.ok, true);
  return result.artifact;
}

function baseAppReadyPackage(projectId: string, artifactId: string): G0StoryboardPackageInput {
  return {
    project_id: projectId,
    status: "approved_for_video_generation",
    approved_by_user: true,
    confirmation: { user_confirmed: true, source: "test_fixture" },
    shots: [
      {
        shot_id: "g0_shot_001",
        order: 1,
        duration_seconds: 5,
        storyboard_image_artifact_id: artifactId,
        shot_description: "Opening product shot",
        video_prompt: "A gentle push-in over the product with realistic studio light.",
        negative_prompt: "",
        continuity_constraints: ["Keep product centered", "No logo deformation"],
        approved_by_user: true
      }
    ]
  };
}

test("G0 persists creative artifacts under the app project boundary", () => {
  const db = openM0Database();

  try {
    const project = createProject({ title: "G0 Persistence" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) return;

    const inputs = [
      ["creative_brief", { product: "demo item", objective: "15s vertical commercial" }],
      ["script", { beats: ["open", "benefit", "close"] }],
      ["shot_list", { shots: [{ order: 1, description: "Opening" }] }],
      ["storyboard_image_prompts", { prompts: ["clean studio product frame"] }],
      ["storyboard_review_record", { approved_by_user: false, notes: ["revise shot 1"] }],
      ["storyboard_package_draft", { status: "draft_for_review", shots: [] }]
    ] as const;

    for (const [kind, payload] of inputs) {
      const saved = saveG0Artifact({ project_id: project.project_id, kind, payload }, db);
      assert.equal(saved.ok, true);
      if (!saved.ok) return;
      const reloaded = readG0Artifact(project.project_id, kind);
      assert.equal(reloaded?.kind, kind);
      assert.deepEqual(reloaded?.payload, payload);
    }

    const storedProject = getProject(db, project.project_id);
    assert.equal(storedProject?.brief.objective, "15s vertical commercial");
  } finally {
    db.close();
  }
});

test("G0 draft package is accepted as draft only and cannot import for generation", () => {
  const db = openM0Database();

  try {
    const project = createProject({ title: "G0 Draft Only" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) return;

    const draft: G0StoryboardPackageInput = {
      project_id: project.project_id,
      status: "draft_for_review",
      approved_by_user: false,
      shots: [],
      confirmation: { user_confirmed: false, source: "test_fixture" }
    };

    const validation = validateG0StoryboardPackage(draft, db);
    assert.equal(validation.ok, true);
    if (!validation.ok) return;
    assert.equal(validation.app_ready, false);

    const imported = importG0AppReadyStoryboardPackage(draft, db);
    assert.equal(imported.ok, false);
    if (imported.ok) return;
    assert.equal(imported.error.code, "DRAFT_PACKAGE_NOT_APP_READY");
  } finally {
    db.close();
  }
});

test("G0 app-ready package blocks fake, pending, unapproved, and incomplete shots", () => {
  const db = openM0Database();

  try {
    const project = createProject({ title: "G0 Negative Gates" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) return;

    const fake = validateG0StoryboardPackage(baseAppReadyPackage(project.project_id, "artifact_fake"), db);
    assert.equal(fake.ok, false);
    if (fake.ok) return;
    assert.equal(fake.error.code, "ARTIFACT_NOT_FOUND");

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
    const pendingValidation = validateG0StoryboardPackage(baseAppReadyPackage(project.project_id, pending.artifact.artifact_id), db);
    assert.equal(pendingValidation.ok, false);
    if (pendingValidation.ok) return;
    assert.equal(pendingValidation.error.code, "ARTIFACT_PENDING_UPLOAD");

    const active = createActiveStoryboardArtifact(db);
    const missingPrompt = baseAppReadyPackage(project.project_id, active.artifact_id);
    missingPrompt.shots[0].video_prompt = "";
    const missingPromptValidation = validateG0StoryboardPackage(missingPrompt, db);
    assert.equal(missingPromptValidation.ok, false);
    if (missingPromptValidation.ok) return;
    assert.equal(missingPromptValidation.error.code, "MISSING_REQUIRED_FIELD");

    const missingDescription = baseAppReadyPackage(project.project_id, active.artifact_id);
    missingDescription.shots[0].shot_description = "";
    const missingDescriptionValidation = validateG0StoryboardPackage(missingDescription, db);
    assert.equal(missingDescriptionValidation.ok, false);
    if (missingDescriptionValidation.ok) return;
    assert.equal(missingDescriptionValidation.error.code, "MISSING_REQUIRED_FIELD");

    const missingDuration = baseAppReadyPackage(project.project_id, active.artifact_id);
    missingDuration.shots[0].duration_seconds = 0;
    const missingDurationValidation = validateG0StoryboardPackage(missingDuration, db);
    assert.equal(missingDurationValidation.ok, false);
    if (missingDurationValidation.ok) return;
    assert.equal(missingDurationValidation.error.code, "MISSING_REQUIRED_FIELD");

    const invalidNegativePrompt = baseAppReadyPackage(project.project_id, active.artifact_id);
    invalidNegativePrompt.shots[0].negative_prompt = undefined as unknown as string;
    const invalidNegativePromptValidation = validateG0StoryboardPackage(invalidNegativePrompt, db);
    assert.equal(invalidNegativePromptValidation.ok, false);
    if (invalidNegativePromptValidation.ok) return;
    assert.equal(invalidNegativePromptValidation.error.code, "MISSING_REQUIRED_FIELD");

    const rawImportPath = validateG0StoryboardPackage(baseAppReadyPackage(project.project_id, "data/imports/g0_r1_SHOT_001.png"), db);
    assert.equal(rawImportPath.ok, false);
    if (rawImportPath.ok) return;
    assert.equal(rawImportPath.error.code, "ARTIFACT_NOT_FOUND");

    const unapproved = baseAppReadyPackage(project.project_id, active.artifact_id);
    unapproved.shots[0].approved_by_user = false;
    const unapprovedValidation = validateG0StoryboardPackage(unapproved, db);
    assert.equal(unapprovedValidation.ok, false);
    if (unapprovedValidation.ok) return;
    assert.equal(unapprovedValidation.error.code, "USER_APPROVAL_REQUIRED");
  } finally {
    db.close();
  }
});

test("G0 valid app-ready package imports through existing Storyboard Package chain", () => {
  const db = openM0Database();

  try {
    const project = createProject({ title: "G0 App Ready" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) return;
    const active = createActiveStoryboardArtifact(db);
    const input = baseAppReadyPackage(project.project_id, active.artifact_id);

    const validation = validateG0StoryboardPackage(input, db);
    assert.equal(validation.ok, true);
    if (!validation.ok) return;
    assert.equal(validation.app_ready, true);

    const imported = importG0AppReadyStoryboardPackage(input, db);
    assert.equal(imported.ok, true);
    if (!imported.ok) return;
    assert.equal(imported.project.status, "storyboard_approved");
    assert.equal(imported.shots.length, 1);
    assert.equal(imported.shots[0].storyboard_image_artifact_id, active.artifact_id);

    const saved = readG0Artifact(project.project_id, "storyboard_package");
    assert.equal(saved?.kind, "storyboard_package");
    assert.equal((saved?.payload as { status?: string } | undefined)?.status, "approved_for_video_generation");
  } finally {
    db.close();
  }
});
