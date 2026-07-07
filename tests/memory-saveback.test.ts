import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  approveH3GeneratedClip,
  confirmMemorySavebackProposal,
  createGenerationRunFromPackageShot,
  createMemorySavebackProposal,
  createProject,
  executeH4FinalAssembly,
  generateMemoryRecallPack,
  importStoryboardPackage,
  openM0Database,
  registerMediaArtifact
} from "../src/index.js";

async function setupClosedProject(db: ReturnType<typeof openM0Database>) {
  const project = createProject({ title: `Memory Saveback ${randomUUID().slice(0, 8)}` }, db);
  assert.equal(project.ok, true);
  if (!project.ok) throw new Error("project setup failed");

  const storyboardArtifact = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
    },
    db
  );
  assert.equal(storyboardArtifact.ok, true);
  if (!storyboardArtifact.ok) throw new Error("artifact setup failed");

  const storyboard = importStoryboardPackage(
    {
      project_id: project.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [
        {
          order: 1,
          duration_seconds: 2,
          storyboard_image_artifact_id: storyboardArtifact.artifact.artifact_id,
          video_prompt: "Animate this shot for memory saveback.",
          negative_prompt: ""
        }
      ],
      user_approval: { storyboard_approved: true }
    },
    db
  );
  assert.equal(storyboard.ok, true);
  if (!storyboard.ok) throw new Error("storyboard setup failed");

  const shotId = storyboard.shots[0].shot_id;
  const generation = await createGenerationRunFromPackageShot(
    {
      project_id: project.project_id,
      storyboard_package_id: storyboard.storyboard_package_id,
      shot_id: shotId,
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    },
    db
  );
  assert.equal(generation.ok, true);
  if (!generation.ok || !generation.generated_artifact_id) throw new Error("generation setup failed");

  const approved = approveH3GeneratedClip({ shot_id: shotId, artifact_id: generation.generated_artifact_id, write_report: false }, db);
  assert.equal(approved.ok, true);
  if (!approved.ok) throw new Error("approval setup failed");

  const finalAssembly = executeH4FinalAssembly({ project_id: project.project_id, human_confirmation: true, write_report: false }, undefined, db);
  assert.equal(finalAssembly.ok, true);
  if (!finalAssembly.ok) throw new Error("assembly setup failed");

  return { project, storyboard, generation, finalAssembly };
}

test("R3-6 creates saveback proposal with project, shot, artifact, run, and report provenance", async () => {
  const db = openM0Database();

  try {
    const { project, storyboard, generation, finalAssembly } = await setupClosedProject(db);
    const created = createMemorySavebackProposal(
      {
        project_id: project.project_id,
        report_refs: ["data/reports/r2_4_h4_final_assembly_workbench_result.json"],
        write_report: false
      },
      db
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const proposal = created.value.proposal;
    assert.equal(proposal.long_term_memory_write_attempted, false);
    assert.equal(proposal.items.some((item) => item.item_type === "memory_item"), true);
    assert.equal(proposal.items.some((item) => item.item_type === "asset" && item.provenance.artifact_id === generation.generated_artifact_id), true);
    assert.equal(proposal.items.some((item) => item.item_type === "asset" && item.provenance.artifact_id === finalAssembly.value.final_video_artifact_id), true);
    assert.equal(proposal.items.some((item) => item.item_type === "reference" && item.provenance.storyboard_package_id === storyboard.storyboard_package_id), true);
    assert.equal(proposal.items.every((item) => item.provenance.project_id === project.project_id), true);
    assert.equal(proposal.items.some((item) => item.provenance.shot_id === storyboard.shots[0].shot_id), true);
    assert.equal(proposal.items.some((item) => item.provenance.run_id === generation.run.run_id), true);
    assert.equal(proposal.items.every((item) => item.provenance.report_refs.includes("data/reports/r2_4_h4_final_assembly_workbench_result.json")), true);
  } finally {
    db.close();
  }
});

test("R3-6 materializes only approved items after human confirmation and builds recall pack", async () => {
  const db = openM0Database();

  try {
    const { project } = await setupClosedProject(db);
    const created = createMemorySavebackProposal({ project_id: project.project_id, write_report: false }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const proposal = created.value.proposal;
    const memoryItem = proposal.items.find((item) => item.item_type === "memory_item");
    const assetItem = proposal.items.find((item) => item.item_type === "asset");
    const rejectedItem = proposal.items.find((item) => item.item_id !== memoryItem?.item_id && item.item_id !== assetItem?.item_id);
    assert(memoryItem);
    assert(assetItem);
    assert(rejectedItem);

    const missingConfirmation = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: false,
        decisions: [{ item_id: memoryItem.item_id, decision: "approve" }]
      },
      created.value.store
    );
    assert.equal(missingConfirmation.ok, false);
    if (missingConfirmation.ok) return;
    assert.equal(missingConfirmation.error.code, "HUMAN_CONFIRMATION_REQUIRED");

    const confirmed = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: true,
        decisions: [
          { item_id: memoryItem.item_id, decision: "approve", title: "Confirmed production memory" },
          { item_id: assetItem.item_id, decision: "approve" },
          { item_id: rejectedItem.item_id, decision: "reject", rejection_reason: "not useful for future recall" }
        ]
      },
      created.value.store
    );
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) return;
    assert.equal(confirmed.value.proposal.status, "reviewed");
    assert.equal(confirmed.value.created.memory_items.length, 1);
    assert.equal(confirmed.value.created.assets.length, 1);
    assert.equal(confirmed.value.created.references.length, 0);
    assert.equal(
      [...confirmed.value.store.memory_items, ...confirmed.value.store.assets, ...confirmed.value.store.references].some(
        (record) => record.provenance.proposal_item_id === rejectedItem.item_id
      ),
      false
    );
    assert.equal(confirmed.value.created.assets[0].provenance.project_id, project.project_id);
    assert.equal(Boolean(confirmed.value.created.assets[0].provenance.artifact_id), true);

    const recall = generateMemoryRecallPack({ project_id: project.project_id }, confirmed.value.store);
    assert.equal(recall.ok, true);
    if (!recall.ok) return;
    assert.equal(recall.value.recall_pack.memory_items.length, 1);
    assert.equal(recall.value.recall_pack.assets.length, 1);
    assert.equal(recall.value.recall_pack.boundary.long_term_memory_write_attempted, false);

    const remainingDecisions = confirmed.value.proposal.items
      .filter((item) => item.status === "proposed")
      .map((item) => ({ item_id: item.item_id, decision: "reject" as const, rejection_reason: "not needed" }));
    assert.equal(remainingDecisions.length > 0, true);
    const fullyReviewed = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: true,
        decisions: remainingDecisions
      },
      confirmed.value.store
    );
    assert.equal(fullyReviewed.ok, true);
    if (!fullyReviewed.ok) return;
    assert.equal(fullyReviewed.value.proposal.status, "confirmed");
    assert.equal(fullyReviewed.value.created.memory_items.length, 0);
    assert.equal(fullyReviewed.value.created.assets.length, 0);
    assert.equal(fullyReviewed.value.created.references.length, 0);
  } finally {
    db.close();
  }
});

test("R3-6 rejects invalid or unknown saveback decisions instead of materializing them", async () => {
  const db = openM0Database();

  try {
    const { project } = await setupClosedProject(db);
    const created = createMemorySavebackProposal({ project_id: project.project_id, write_report: false }, db);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const proposal = created.value.proposal;
    const invalidDecision = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: true,
        decisions: [{ item_id: proposal.items[0].item_id, decision: "ignore" as "approve" }]
      },
      created.value.store
    );
    assert.equal(invalidDecision.ok, false);
    if (invalidDecision.ok) return;
    assert.equal(invalidDecision.error.code, "INVALID_DECISION");

    const unknownItem = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: true,
        decisions: [{ item_id: "saveback_item_missing", decision: "reject" }]
      },
      created.value.store
    );
    assert.equal(unknownItem.ok, false);
    if (unknownItem.ok) return;
    assert.equal(unknownItem.error.code, "PROPOSAL_ITEM_NOT_FOUND");
  } finally {
    db.close();
  }
});
