import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  assembleFinalVideo,
  createProject,
  getMediaArtifact,
  importStoryboardPackage,
  markShotClipReview,
  openM0Database,
  paths,
  registerMediaArtifact,
  regenerateShotVideo,
  startStoryboardVideoGeneration,
  summarizeMp4Validations,
  validateMp4File
} from "../src/index.js";
import type { MediaArtifact } from "../src/index.js";

async function setupGeneratedProject(db: ReturnType<typeof openM0Database>) {
  const project = createProject({ title: "M0-R1 Media Validity" }, db);
  assert.equal(project.ok, true);
  if (!project.ok) throw new Error("project setup failed");

  const snapshots = [1, 2, 3].map((_, index) => {
    const artifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
      },
      db
    );
    assert.equal(artifact.ok, true);
    if (!artifact.ok) throw new Error("artifact setup failed");
    return {
      order: index + 1,
      duration_seconds: 2,
      description: `Shot ${index + 1}`,
      storyboard_image_artifact_id: artifact.artifact.artifact_id,
      video_prompt: `Animate shot ${index + 1}`,
      negative_prompt: "blur"
    };
  });

  const storyboard = importStoryboardPackage(
    {
      project_id: project.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: snapshots,
      user_approval: { storyboard_approved: true }
    },
    db
  );
  assert.equal(storyboard.ok, true);
  if (!storyboard.ok) throw new Error("storyboard setup failed");

  const generation = await startStoryboardVideoGeneration(
    {
      project_id: project.project_id,
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    },
    db
  );
  assert.equal(generation.ok, true);
  if (!generation.ok) throw new Error("generation setup failed");

  return { project, storyboard, generation };
}

function assertValidMp4Artifact(artifact: MediaArtifact | null | undefined): void {
  assert(artifact);
  const validity = validateMp4File(artifact.storage.uri);
  assert.equal(validity.status, "PASS", validity.error);
  assert.equal(validity.has_video_stream, true);
  assert(validity.duration_seconds !== null && validity.duration_seconds > 0);
  assert.equal(Math.abs(validity.duration_seconds - (artifact.metadata.duration_seconds ?? 0)) < 0.25, true);
}

test("M0-R1 mock fixture mp4 is valid", () => {
  const validity = validateMp4File(join(paths.workspaceRoot, "fixtures", "video", "mock_clip.mp4"));
  assert.equal(validity.status, "PASS", validity.error);
  assert.equal(validity.has_video_stream, true);
  assert.equal(validity.duration_seconds !== null && validity.duration_seconds > 0, true);
});

test("M0-R1 mock provider output artifacts are valid mp4 files", async () => {
  const db = openM0Database();

  try {
    const { generation } = await setupGeneratedProject(db);
    for (const run of generation.runs) {
      assertValidMp4Artifact(getMediaArtifact(db, run.output.artifact_ids[0]));
    }
  } finally {
    db.close();
  }
});

test("M0-R1 regenerated shot artifact is valid mp4", async () => {
  const db = openM0Database();

  try {
    const { storyboard, generation } = await setupGeneratedProject(db);
    const shot = storyboard.shots[0];
    const run = generation.runs.find((item) => item.shot_id === shot.shot_id);
    assert(run);
    const firstArtifactId = run.output.artifact_ids[0];

    const rejected = markShotClipReview(
      {
        shot_id: shot.shot_id,
        artifact_id: firstArtifactId,
        decision: "revision_needed",
        rejection_reasons: ["needs more motion"],
        revision_instruction: {
          summary: "Add motion",
          prompt_delta: "more motion",
          negative_delta: "static",
          priority: "medium"
        }
      },
      db
    );
    assert.equal(rejected.ok, true);

    const regenerated = await regenerateShotVideo(
      {
        shot_id: shot.shot_id,
        previous_run_id: run.run_id,
        updated_prompt: "Animate with more motion.",
        confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
      },
      db
    );
    assert.equal(regenerated.ok, true);
    if (!regenerated.ok) return;
    assertValidMp4Artifact(getMediaArtifact(db, regenerated.artifact_id));
  } finally {
    db.close();
  }
});

test("M0-R1 final assembly artifact is valid mp4", async () => {
  const db = openM0Database();

  try {
    const { project, storyboard, generation } = await setupGeneratedProject(db);
    for (const shot of storyboard.shots) {
      const run = generation.runs.find((item) => item.shot_id === shot.shot_id);
      assert(run);
      const review = markShotClipReview({ shot_id: shot.shot_id, artifact_id: run.output.artifact_ids[0], decision: "approved" }, db);
      assert.equal(review.ok, true);
    }

    const assembled = assembleFinalVideo(
      {
        project_id: project.project_id,
        confirmation: { confirmation_level: "explicit", user_confirmed: true }
      },
      db
    );
    assert.equal(assembled.ok, true);
    if (!assembled.ok) return;

    const artifact = getMediaArtifact(db, assembled.final_video_artifact_id);
    assertValidMp4Artifact(artifact);
    assert.notEqual(readFileSync(artifact?.storage.uri ?? "", "utf8").startsWith("M0_FINAL_VIDEO"), true);
  } finally {
    db.close();
  }
});

test("M0-R1 invalid mp4 media fails validity summary", () => {
  const invalidPath = join(paths.dataRoot, "m0-r1-invalid.mp4");
  writeFileSync(invalidPath, "not a valid mp4", "utf8");

  try {
    const invalid = validateMp4File(invalidPath);
    assert.equal(invalid.status, "FAIL");
    const summary = summarizeMp4Validations([invalid]);
    assert.equal(summary.status, "FAIL");
    assert.equal(summary.failed, 1);
  } finally {
    rmSync(invalidPath, { force: true });
  }
});
