import assert from "node:assert/strict";
import test from "node:test";

import {
  createProject,
  importStoryboardPackage,
  openM0Database,
  registerMediaArtifact,
  selectM0Provider,
  startStoryboardVideoGeneration
} from "../src/index.js";

test("M0-G real provider selection returns PROVIDER_DISABLED", () => {
  assert.deepEqual(selectM0Provider("real"), {
    ok: false,
    error: {
      code: "PROVIDER_DISABLED",
      message: "Real providers are disabled in M0."
    }
  });
});

test("M0-G start generation with real provider is blocked without network or credentials", async () => {
  const db = openM0Database();

  try {
    const project = createProject({ title: "M0-G Project" }, db);
    assert.equal(project.ok, true);
    if (!project.ok) return;
    const artifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "fixture_path", path: "storyboard/shot_001.png" }
      },
      db
    );
    assert.equal(artifact.ok, true);
    if (!artifact.ok) return;
    const storyboard = importStoryboardPackage(
      {
        project_id: project.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            storyboard_image_artifact_id: artifact.artifact.artifact_id,
            video_prompt: "Animate"
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );
    assert.equal(storyboard.ok, true);
    if (!storyboard.ok) return;
    const generation = await startStoryboardVideoGeneration(
      {
        project_id: project.project_id,
        provider: "real",
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );
    assert.equal(generation.ok, false);
    if (generation.ok) return;
    assert.equal(generation.error.code, "PROVIDER_DISABLED");
  } finally {
    db.close();
  }
});
