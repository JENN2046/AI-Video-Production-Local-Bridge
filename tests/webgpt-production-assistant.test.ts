import assert from "node:assert/strict";
import test from "node:test";

import {
  approveH3GeneratedClip,
  createGenerationRunFromPackageShot,
  createMemorySavebackProposal,
  createProject,
  executeH4FinalAssembly,
  executeWebGptProductionAssistantTool,
  importStoryboardPackage,
  loadWebGptProductionAssistantStore,
  openM0Database,
  registerMediaArtifact,
  WEBGPT_PRODUCTION_ASSISTANT_TOOLS,
  webGptProductionAssistantWorkbenchSummary,
  type GenerationRun
} from "../src/index.js";

async function createProductionContext(db: ReturnType<typeof openM0Database>): Promise<{
  project_id: string;
  shot_id: string;
  artifact_id: string;
  run: GenerationRun;
  proposal_id: string;
}> {
  const project = createProject({ title: "Production Assistant Test" }, db);
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
          video_prompt: "Animate this shot for production assistant."
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
  if (!generated.ok || !generated.generated_artifact_id) throw new Error("Generation failed.");

  const approved = approveH3GeneratedClip({ shot_id: storyboard.shots[0].shot_id, artifact_id: generated.generated_artifact_id, write_report: false }, db);
  assert.equal(approved.ok, true);
  if (!approved.ok) throw new Error("Clip approval failed.");

  const assembled = executeH4FinalAssembly({ project_id: project.project_id, human_confirmation: true, write_report: false }, undefined, db);
  assert.equal(assembled.ok, true);
  if (!assembled.ok) throw new Error("Assembly failed.");

  const proposal = createMemorySavebackProposal({ project_id: project.project_id, write_report: false }, db);
  assert.equal(proposal.ok, true);
  if (!proposal.ok) throw new Error("Proposal creation failed.");

  return {
    project_id: project.project_id,
    shot_id: storyboard.shots[0].shot_id,
    artifact_id: generated.generated_artifact_id,
    run: generated.run,
    proposal_id: proposal.value.proposal.proposal_id
  };
}

test("WebGPT v3 production assistant inventory has planning powers only", () => {
  assert.deepEqual(
    WEBGPT_PRODUCTION_ASSISTANT_TOOLS.map((tool) => tool.name),
    ["propose_generation_plan", "propose_regeneration_plan", "propose_final_assembly_plan", "propose_memory_saveback"]
  );

  for (const tool of WEBGPT_PRODUCTION_ASSISTANT_TOOLS) {
    assert.equal(tool.mode, "PRODUCTION_ASSISTANT_PLAN");
    assert.equal(tool.plan_write_allowed, true);
    assert.equal(tool.execution_allowed, false);
    assert.equal(tool.provider_call_allowed, false);
    assert.equal(tool.final_delivery_approval_allowed, false);
    assert.equal(tool.long_term_memory_write_allowed, false);
    assert.equal(tool.secret_read_allowed, false);
    assert.equal(tool.shell_allowed, false);
  }
});

test("WebGPT v3 stores production plans without executing generation, assembly, or memory writes", async () => {
  const db = openM0Database();

  try {
    const context = await createProductionContext(db);
    const beforePlans = loadWebGptProductionAssistantStore().plans.length;

    const generation = executeWebGptProductionAssistantTool(
      "propose_generation_plan",
      { project_id: context.project_id, notes: "Generate selected package shots after human approval." },
      db
    );
    assert.equal(generation.ok, true);
    if (!generation.ok) return;

    const regeneration = executeWebGptProductionAssistantTool(
      "propose_regeneration_plan",
      { project_id: context.project_id, artifact_id: context.artifact_id, prompt_delta: "Add stronger camera motion." },
      db
    );
    assert.equal(regeneration.ok, true);
    if (!regeneration.ok) return;

    const assembly = executeWebGptProductionAssistantTool("propose_final_assembly_plan", { project_id: context.project_id, notes: "Assemble after all clips accepted." }, db);
    assert.equal(assembly.ok, true);
    if (!assembly.ok) return;

    const saveback = executeWebGptProductionAssistantTool(
      "propose_memory_saveback",
      { project_id: context.project_id, proposal_id: context.proposal_id, notes: "Human should decide reusable memories." },
      db
    );
    assert.equal(saveback.ok, true);
    if (!saveback.ok) return;

    assert.equal(loadWebGptProductionAssistantStore().plans.length, beforePlans + 4);
    for (const result of [generation, regeneration, assembly, saveback]) {
      assert.equal(result.execution_allowed, false);
      assert.equal(result.plan.production_effects.provider_call_attempted, false);
      assert.equal(result.plan.production_effects.generation_started, false);
      assert.equal(result.plan.production_effects.regeneration_started, false);
      assert.equal(result.plan.production_effects.final_assembly_started, false);
      assert.equal(result.plan.production_effects.final_delivery_approved, false);
      assert.equal(result.plan.production_effects.long_term_memory_written, false);
      assert.equal(result.plan.human_review.human_workbench_hard_gate, true);
    }
  } finally {
    db.close();
  }
});

test("WebGPT v3 rejects fake ids and exposes offline workbench summary", () => {
  const db = openM0Database();

  try {
    const fakeProject = executeWebGptProductionAssistantTool("propose_generation_plan", { project_id: "project_fake", notes: "Should fail." }, db);
    assert.equal(fakeProject.ok, false);
    if (fakeProject.ok) return;
    assert.equal(fakeProject.error.code, "INVALID_APP_ID");

    const fakeArtifact = executeWebGptProductionAssistantTool(
      "propose_regeneration_plan",
      { project_id: "project_fake", artifact_id: "artifact_fake", prompt_delta: "Should fail." },
      db
    );
    assert.equal(fakeArtifact.ok, false);
    if (fakeArtifact.ok) return;
    assert.equal(fakeArtifact.error.code, "INVALID_APP_ID");

    const summary = webGptProductionAssistantWorkbenchSummary();
    assert.equal(summary.mode, "PRODUCTION_PLAN_REVIEW");
    assert.equal(summary.provider_boundary.network_call_attempted, false);
    assert.equal(summary.provider_boundary.runway_called, false);
    assert.equal(summary.provider_boundary.runninghub_called, false);
    assert.equal(summary.production_effects.provider_call_attempted, false);
    assert.equal(summary.production_effects.final_delivery_approved, false);
    assert.equal(summary.production_effects.long_term_memory_written, false);
  } finally {
    db.close();
  }
});

test("WebGPT v3 rejects cross-project generated clips and memory proposals", async () => {
  const db = openM0Database();

  try {
    const first = await createProductionContext(db);
    const second = await createProductionContext(db);

    const crossProjectClip = executeWebGptProductionAssistantTool(
      "propose_regeneration_plan",
      { project_id: first.project_id, artifact_id: second.artifact_id, prompt_delta: "Use the wrong project's clip." },
      db
    );
    assert.equal(crossProjectClip.ok, false);
    if (crossProjectClip.ok) return;
    assert.equal(crossProjectClip.error.code, "ARTIFACT_PROJECT_MISMATCH");

    const crossProjectProposal = executeWebGptProductionAssistantTool(
      "propose_memory_saveback",
      { project_id: first.project_id, proposal_id: second.proposal_id, notes: "Use the wrong project's proposal." },
      db
    );
    assert.equal(crossProjectProposal.ok, false);
    if (crossProjectProposal.ok) return;
    assert.equal(crossProjectProposal.error.code, "PROPOSAL_PROJECT_MISMATCH");
  } finally {
    db.close();
  }
});
