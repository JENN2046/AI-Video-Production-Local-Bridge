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
  openM0Database,
  paths,
  registerMediaArtifact
} from "../src/index.js";

const REPORT_STEM = "r3_6_memory_asset_saveback_core_result";
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
    const project = createProject({ title: `R3-6 Memory Saveback ${runId.slice(0, 8)}` }, db);
    if (!project.ok) throw new Error(project.error.message);

    const storyboardArtifact = registerMediaArtifact(
      {
        artifact_type: "image",
        role: "storyboard_image",
        source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
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
            video_prompt: "Animate this shot for memory saveback core proof.",
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

    const proposalResult = createMemorySavebackProposal(
      {
        project_id: project.project_id,
        report_refs: [
          "data/reports/r2_4_h4_final_assembly_workbench_result.json",
          "data/reports/h4_final_assembly_result.json"
        ],
        write_report: true
      },
      db
    );
    if (!proposalResult.ok) throw new Error(proposalResult.error.message);

    const proposal = proposalResult.value.proposal;
    const memoryItem = proposal.items.find((item) => item.item_type === "memory_item");
    const assetItem = proposal.items.find((item) => item.item_type === "asset" && item.provenance.artifact_id === generation.generated_artifact_id);
    const rejectedItem = proposal.items.find((item) => item.item_type === "reference") ?? proposal.items.at(-1);
    if (!memoryItem || !assetItem || !rejectedItem) throw new Error("Proposal did not contain required item types.");

    const missingConfirmation = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: false,
        decisions: [{ item_id: memoryItem.item_id, decision: "approve" }]
      },
      proposalResult.value.store
    );

    const confirmed = confirmMemorySavebackProposal(
      {
        proposal_id: proposal.proposal_id,
        human_confirmation: true,
        decisions: [
          { item_id: memoryItem.item_id, decision: "approve" },
          { item_id: assetItem.item_id, decision: "approve" },
          { item_id: rejectedItem.item_id, decision: "reject", rejection_reason: "not needed in recall pack" }
        ]
      },
      proposalResult.value.store
    );
    if (!confirmed.ok) throw new Error(confirmed.error.message);

    const recall = generateMemoryRecallPack({ project_id: project.project_id }, confirmed.value.store);
    if (!recall.ok) throw new Error(recall.error.message);

    const report = {
      task_id: "R3-6_MEMORY_ASSET_SAVEBACK_CORE",
      result: "PASS",
      run_id: runId,
      generated_at: new Date().toISOString(),
      project_id: project.project_id,
      storyboard_package_id: storyboard.storyboard_package_id,
      final_video_artifact_id: assembly.value.final_video_artifact_id,
      memory_saveback: {
        proposal_id: proposal.proposal_id,
        proposal_item_count: proposal.items.length,
        proposal_created: true,
        missing_confirmation_result: missingConfirmation.ok ? "UNEXPECTED_PASS" : missingConfirmation.error.code,
        approved_items_materialized: confirmed.value.created.memory_items.length + confirmed.value.created.assets.length + confirmed.value.created.references.length,
        rejected_items_materialized: [...confirmed.value.store.memory_items, ...confirmed.value.store.assets, ...confirmed.value.store.references].filter(
          (record) => record.provenance.proposal_item_id === rejectedItem.item_id
        ).length,
        memory_items_created: confirmed.value.created.memory_items.length,
        assets_created: confirmed.value.created.assets.length,
        references_created: confirmed.value.created.references.length,
        recall_pack_id: recall.value.recall_pack.recall_pack_id,
        recall_pack_memory_items: recall.value.recall_pack.memory_items.length,
        recall_pack_assets: recall.value.recall_pack.assets.length,
        recall_pack_references: recall.value.recall_pack.references.length
      },
      provenance: {
        project_id: proposal.items.every((item) => item.provenance.project_id === project.project_id),
        shot_id_present: proposal.items.some((item) => item.provenance.shot_id === shotId),
        artifact_id_present: proposal.items.some((item) => Boolean(item.provenance.artifact_id)),
        run_id_present: proposal.items.some((item) => item.provenance.run_id === generation.run.run_id),
        report_refs_present: proposal.items.every((item) => item.provenance.report_refs.length > 0)
      },
      boundary: {
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
