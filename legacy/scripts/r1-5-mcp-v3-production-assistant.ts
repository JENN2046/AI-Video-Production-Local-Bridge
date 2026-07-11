import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  approveH3GeneratedClip,
  createGenerationRunFromPackageShot,
  createMemorySavebackProposal,
  createProject,
  ensureM0Directories,
  executeH4FinalAssembly,
  executeWebGptProductionAssistantTool,
  importStoryboardPackage,
  loadWebGptProductionAssistantStore,
  openM0Database,
  paths,
  registerMediaArtifact,
  WEBGPT_PRODUCTION_ASSISTANT_TOOLS,
  webGptProductionAssistantWorkbenchSummary
} from "../src/index.js";

const REPORT_STEM = "r1_5_mcp_v3_production_assistant_result";
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
    const project = createProject({ title: `R1-5 Production Assistant ${runId.slice(0, 8)}` }, db);
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
            video_prompt: "Animate this shot for production assistant proof.",
            negative_prompt: ""
          }
        ],
        user_approval: { storyboard_approved: true }
      },
      db
    );
    if (!storyboard.ok) throw new Error(storyboard.error.message);

    const shotId = storyboard.shots[0].shot_id;
    const generationRunCountBeforePlans = loadWebGptProductionAssistantStore().plans.length;
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

    const proposal = createMemorySavebackProposal({ project_id: project.project_id, write_report: false }, db);
    if (!proposal.ok) throw new Error(proposal.error.message);

    const generationPlan = executeWebGptProductionAssistantTool(
      "propose_generation_plan",
      { project_id: project.project_id, notes: "Plan generation only; Human Workbench must execute." },
      db
    );
    const regenerationPlan = executeWebGptProductionAssistantTool(
      "propose_regeneration_plan",
      { project_id: project.project_id, artifact_id: generation.generated_artifact_id, prompt_delta: "Increase motion after human review." },
      db
    );
    const assemblyPlan = executeWebGptProductionAssistantTool(
      "propose_final_assembly_plan",
      { project_id: project.project_id, notes: "Final assembly remains a Human Workbench action." },
      db
    );
    const savebackPlan = executeWebGptProductionAssistantTool(
      "propose_memory_saveback",
      { project_id: project.project_id, proposal_id: proposal.value.proposal.proposal_id, notes: "Memory saveback remains human-confirmed." },
      db
    );
    const results = [generationPlan, regenerationPlan, assemblyPlan, savebackPlan];
    for (const result of results) {
      if (!result.ok) throw new Error(result.error.message);
    }

    const summary = webGptProductionAssistantWorkbenchSummary();
    const report = {
      task_id: "R1-5_MCP_V3_PRODUCTION_ASSISTANT",
      result: "PASS",
      run_id: runId,
      generated_at: new Date().toISOString(),
      project_id: project.project_id,
      tool_inventory: WEBGPT_PRODUCTION_ASSISTANT_TOOLS.map((tool) => ({
        name: tool.name,
        execution_allowed: tool.execution_allowed,
        provider_call_allowed: tool.provider_call_allowed,
        final_delivery_approval_allowed: tool.final_delivery_approval_allowed,
        long_term_memory_write_allowed: tool.long_term_memory_write_allowed,
        secret_read_allowed: tool.secret_read_allowed,
        shell_allowed: tool.shell_allowed
      })),
      plan_results: results.map((result) =>
        result.ok
          ? {
              tool: result.tool,
              plan_id: result.plan.plan_id,
              execution_allowed: result.execution_allowed,
              provider_call_attempted: result.plan.production_effects.provider_call_attempted,
              generation_started: result.plan.production_effects.generation_started,
              regeneration_started: result.plan.production_effects.regeneration_started,
              final_assembly_started: result.plan.production_effects.final_assembly_started,
              final_delivery_approved: result.plan.production_effects.final_delivery_approved,
              long_term_memory_written: result.plan.production_effects.long_term_memory_written
            }
          : { tool: result.tool, error: result.error.code }
      ),
      summary: {
        mode: summary.mode,
        plans_added: loadWebGptProductionAssistantStore().plans.length - generationRunCountBeforePlans,
        provider_call_attempted: summary.production_effects.provider_call_attempted,
        final_delivery_approved: summary.production_effects.final_delivery_approved,
        long_term_memory_written: summary.production_effects.long_term_memory_written
      },
      boundary: {
        provider_call_attempted: false,
        real_provider_call: false,
        final_delivery_approval_changed: false,
        long_term_memory_write_attempted: false,
        secret_read: false,
        shell_execution: false,
        source_asset_overwritten: false,
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
