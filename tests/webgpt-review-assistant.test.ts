import assert from "node:assert/strict";
import test from "node:test";

import {
  createGenerationRunFromPackageShot,
  createProject,
  executeWebGptReviewAssistantTool,
  getShot,
  importStoryboardPackage,
  loadWebGptReviewAssistantStore,
  openM0Database,
  registerMediaArtifact,
  WEBGPT_REVIEW_ASSISTANT_TOOLS,
  webGptReviewAssistantWorkbenchSummary,
  type GenerationRun
} from "../src/index.js";

async function createReviewClip(db: ReturnType<typeof openM0Database>): Promise<{ run: GenerationRun; artifact_id: string; shot_id: string; project_id: string; package_id: string }> {
  const project = createProject({ title: "Review Assistant Test" }, db);
  assert.equal(project.ok, true);
  if (!project.ok) throw new Error("Project creation failed.");

  const storyboardArtifact = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "storyboard/shot_001.png" }
    },
    db
  );
  assert.equal(storyboardArtifact.ok, true);
  if (!storyboardArtifact.ok) throw new Error("Storyboard artifact creation failed.");

  const storyboard = importStoryboardPackage(
    {
      project_id: project.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [
        {
          order: 1,
          duration_seconds: 2,
          storyboard_image_artifact_id: storyboardArtifact.artifact.artifact_id,
          video_prompt: "Animate this shot for review assistant."
        }
      ],
      user_approval: { storyboard_approved: true }
    },
    db
  );
  assert.equal(storyboard.ok, true);
  if (!storyboard.ok) throw new Error("Storyboard package import failed.");

  const generated = await createGenerationRunFromPackageShot(
    {
      project_id: project.project_id,
      storyboard_package_id: storyboard.storyboard_package_id,
      shot_id: storyboard.shots[0].shot_id,
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    },
    db
  );
  assert.equal(generated.ok, true);
  if (!generated.ok) throw new Error("Generation failed.");
  assert.ok(generated.generated_artifact_id);

  return {
    run: generated.run,
    artifact_id: generated.generated_artifact_id,
    shot_id: storyboard.shots[0].shot_id,
    project_id: project.project_id,
    package_id: storyboard.storyboard_package_id
  };
}

test("WebGPT v2 review assistant tool inventory has no approval/regeneration/provider powers", () => {
  assert.deepEqual(
    WEBGPT_REVIEW_ASSISTANT_TOOLS.map((tool) => tool.name),
    [
      "get_generation_run",
      "get_generated_clip_metadata",
      "submit_review_note_draft",
      "propose_rejection_reason",
      "propose_regeneration_prompt"
    ]
  );

  for (const tool of WEBGPT_REVIEW_ASSISTANT_TOOLS) {
    assert.equal(tool.mode, "REVIEW_ASSISTANT");
    assert.equal(tool.final_human_approval_allowed, false);
    assert.equal(tool.regeneration_allowed, false);
    assert.equal(tool.provider_call_allowed, false);
    assert.equal(tool.secret_read_allowed, false);
    assert.equal(tool.shell_allowed, false);
  }
});

test("WebGPT v2 reads generated run and clip metadata without provider calls", async () => {
  const db = openM0Database();

  try {
    const clip = await createReviewClip(db);
    const runResult = executeWebGptReviewAssistantTool("get_generation_run", { run_id: clip.run.run_id }, db);
    assert.equal(runResult.ok, true);
    if (!runResult.ok) return;
    assert.equal((runResult.data as { run: GenerationRun }).run.run_id, clip.run.run_id);
    assert.equal(runResult.provider_boundary.network_call_attempted, false);

    const clipResult = executeWebGptReviewAssistantTool("get_generated_clip_metadata", { artifact_id: clip.artifact_id }, db);
    assert.equal(clipResult.ok, true);
    if (!clipResult.ok) return;
    const data = clipResult.data as { artifact: { artifact_id: string }; run: GenerationRun; ffprobe: { status: string } };
    assert.equal(data.artifact.artifact_id, clip.artifact_id);
    assert.equal(data.run.run_id, clip.run.run_id);
    assert.equal(data.ffprobe.status, "PASS");
    assert.equal(clipResult.regeneration_allowed, false);
  } finally {
    db.close();
  }
});

test("WebGPT v2 stores review drafts without changing clip review or triggering regeneration", async () => {
  const db = openM0Database();

  try {
    const clip = await createReviewClip(db);
    const beforeDraftCount = loadWebGptReviewAssistantStore().drafts.length;
    const runCountBefore = getShot(db, clip.shot_id)?.generation_run_ids.length ?? 0;

    const note = executeWebGptReviewAssistantTool("submit_review_note_draft", { artifact_id: clip.artifact_id, note: "Looks close; human should decide." }, db);
    assert.equal(note.ok, true);
    if (!note.ok) return;
    const rejection = executeWebGptReviewAssistantTool("propose_rejection_reason", { artifact_id: clip.artifact_id, reason: "Motion could be stronger." }, db);
    assert.equal(rejection.ok, true);
    if (!rejection.ok) return;
    const prompt = executeWebGptReviewAssistantTool("propose_regeneration_prompt", { artifact_id: clip.artifact_id, prompt_delta: "Add more visible camera movement." }, db);
    assert.equal(prompt.ok, true);
    if (!prompt.ok) return;

    assert.equal(loadWebGptReviewAssistantStore().drafts.length, beforeDraftCount + 3);
    assert.equal(getShot(db, clip.shot_id)?.generation_run_ids.length, runCountBefore);
    assert.equal(getShot(db, clip.shot_id)?.clip_versions.find((version) => version.artifact_id === clip.artifact_id)?.review_status, "pending");

    const draft = (prompt.data as { draft: { production_effects: { regeneration_triggered: boolean; final_human_approval_changed: boolean; provider_call_attempted: boolean } } }).draft;
    assert.equal(draft.production_effects.regeneration_triggered, false);
    assert.equal(draft.production_effects.final_human_approval_changed, false);
    assert.equal(draft.production_effects.provider_call_attempted, false);
  } finally {
    db.close();
  }
});

test("WebGPT v2 rejects fake ids and exposes offline workbench summary", () => {
  const db = openM0Database();

  try {
    const fakeRun = executeWebGptReviewAssistantTool("get_generation_run", { run_id: "run_fake" }, db);
    assert.equal(fakeRun.ok, false);
    if (fakeRun.ok) return;
    assert.equal(fakeRun.error.code, "INVALID_APP_ID");

    const fakeClip = executeWebGptReviewAssistantTool("get_generated_clip_metadata", { artifact_id: "artifact_fake" }, db);
    assert.equal(fakeClip.ok, false);
    if (fakeClip.ok) return;
    assert.equal(fakeClip.error.code, "INVALID_APP_ID");

    const summary = webGptReviewAssistantWorkbenchSummary();
    assert.equal(summary.mode, "REVIEW_DRAFT_REVIEW");
    assert.equal(summary.provider_boundary.network_call_attempted, false);
    assert.equal(summary.provider_boundary.runway_called, false);
    assert.equal(summary.provider_boundary.runninghub_called, false);
  } finally {
    db.close();
  }
});
