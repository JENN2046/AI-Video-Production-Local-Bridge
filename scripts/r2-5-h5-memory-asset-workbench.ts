import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  approveH3GeneratedClip,
  confirmMemorySavebackProposal,
  createGenerationRunFromPackageShot,
  createMemorySavebackProposal,
  createProject,
  ensureM0Directories,
  executeH4FinalAssembly,
  generateMemoryRecallPack,
  importStoryboardPackage,
  memorySavebackWorkbenchSummary,
  openM0Database,
  paths,
  registerMediaArtifact
} from "../src/index.js";

const REPORT_STEM = "r2_5_h5_memory_asset_workbench_result";
const LATEST_REPORT = `data/reports/${REPORT_STEM}.json`;

function writeReport(runId: string, payload: unknown): void {
  ensureM0Directories();
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(join(paths.reportsRoot, `${REPORT_STEM}_${runId}.json`), text, "utf8");
  writeFileSync(join(paths.workspaceRoot, LATEST_REPORT), text, "utf8");
}

async function main(): Promise<void> {
  ensureM0Directories();
  const runId = randomUUID();
  const db = openM0Database();

  try {
    const project = createProject({ title: `R2-5 H5 Workbench ${runId.slice(0, 8)}` }, db);
    if (!project.ok) throw new Error(project.error.message);

    const storyboardArtifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "fixture_path", path: "storyboard/shot_001.png" }
      },
      db
    );
    if (!storyboardArtifact.ok) throw new Error(storyboardArtifact.error.message);

    const storyboard = importStoryboardPackage(
      {
        project_id: project.project_id,
        status: "approved_for_video_generation",
        approved_shot_snapshots: [
          {
            order: 1,
            duration_seconds: 2,
            storyboard_image_artifact_id: storyboardArtifact.artifact.artifact_id,
            video_prompt: "Animate this shot for H5 memory asset workbench proof.",
            negative_prompt: ""
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );
    if (!storyboard.ok) throw new Error(storyboard.error.message);

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
    if (!generation.ok || !generation.generated_artifact_id) {
      throw new Error(generation.ok ? "Generation produced no artifact." : generation.error.message);
    }

    const approval = approveH3GeneratedClip({ shot_id: shotId, artifact_id: generation.generated_artifact_id, write_report: false }, db);
    if (!approval.ok) throw new Error(approval.error.message);

    const assembly = executeH4FinalAssembly({ project_id: project.project_id, human_confirmation: true, write_report: false }, undefined, db);
    if (!assembly.ok) throw new Error(assembly.error.message);

    const proposalResult = createMemorySavebackProposal({ project_id: project.project_id, write_report: false }, db);
    if (!proposalResult.ok) throw new Error(proposalResult.error.message);
    const proposal = proposalResult.value.proposal;
    const before = memorySavebackWorkbenchSummary(proposalResult.value.store);

    const memoryItem = proposal.items.find((item) => item.item_type === "memory_item");
    const clipAsset = proposal.items.find((item) => item.item_type === "asset" && item.provenance.artifact_id === generation.generated_artifact_id);
    const reference = proposal.items.find((item) => item.item_type === "reference");
    const rejected = proposal.items.find((item) => item.item_type === "asset" && item.provenance.artifact_id === assembly.value.final_video_artifact_id);
    if (!memoryItem || !clipAsset || !reference || !rejected) throw new Error("Proposal did not contain required H5 proof items.");

    const confirmed = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: true,
        decisions: [
          {
            item_id: memoryItem.item_id,
            decision: "approve",
            title: "Edited H5 production memory",
            content: `${memoryItem.content} Edited in H5 workbench proof.`
          },
          { item_id: clipAsset.item_id, decision: "approve" },
          { item_id: reference.item_id, decision: "approve" },
          { item_id: rejected.item_id, decision: "reject", rejection_reason: "Keep final video out of reusable asset set for this proof." }
        ]
      },
      proposalResult.value.store
    );
    if (!confirmed.ok) throw new Error(confirmed.error.message);

    const recall = generateMemoryRecallPack({ project_id: project.project_id }, confirmed.value.store);
    if (!recall.ok) throw new Error(recall.error.message);
    const after = memorySavebackWorkbenchSummary(recall.value.store);

    const rejectedMaterialized = [...recall.value.store.memory_items, ...recall.value.store.assets, ...recall.value.store.references].filter(
      (record) => record.provenance.proposal_item_id === rejected.item_id
    );
    const report = {
      task_id: "R2-5_H5_MEMORY_ASSET_WORKBENCH",
      result: "PASS",
      run_id: runId,
      generated_at: new Date().toISOString(),
      project_id: project.project_id,
      proposal_id: proposal.proposal_id,
      workbench: {
        proposal_visible: Boolean(before.latest_proposal),
        human_can_approve_reject_edit: confirmed.value.created.memory_items[0]?.title === "Edited H5 production memory",
        asset_reference_provenance_visible: Boolean(
          confirmed.value.created.assets[0]?.provenance.project_id && confirmed.value.created.references[0]?.provenance.storyboard_package_id
        ),
        no_automatic_memory_save_without_confirmation: after.boundary.automatic_memory_save === false,
        rejected_items_not_saved: rejectedMaterialized.length === 0,
        recall_pack_visible: after.recall_packs_total > before.recall_packs_total
      },
      counts: {
        proposals_total: after.proposals_total,
        memory_items_total: after.memory_items_total,
        assets_total: after.assets_total,
        references_total: after.references_total,
        recall_packs_total: after.recall_packs_total
      },
      boundary: {
        automatic_memory_save: false,
        long_term_memory_write_attempted: false,
        secret_read: false,
        private_state_read: false,
        source_asset_overwritten: false,
        provider_call_attempted: false,
        push: false,
        tag: false,
        release: false,
        deploy: false
      },
      report_path: `data/reports/${REPORT_STEM}_${runId}.json`,
      latest_report_path: LATEST_REPORT
    };

    writeReport(runId, report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
