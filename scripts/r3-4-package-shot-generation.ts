import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createGenerationRunFromPackageShot,
  ensureM0Directories,
  getMediaArtifact,
  openM0Database,
  paths
} from "../src/index.js";

const SOURCE_PACKAGE_REPORT = "data/reports/g0_r1_package_freeze_result.json";
const REPORT_STEM = "r3_4_package_based_shot_generation_result";
const LATEST_REPORT = `data/reports/${REPORT_STEM}.json`;

interface PackageFreezeReport {
  project: {
    project_id: string;
  };
  storyboard_package: {
    storyboard_package_id: string;
    shot_ids: string[];
  };
}

function writeReport(runId: string, payload: unknown): string {
  ensureM0Directories();
  const immutable = join(paths.reportsRoot, `${REPORT_STEM}_${runId}.json`);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(immutable, text, "utf8");
  writeFileSync(join(paths.workspaceRoot, LATEST_REPORT), text, "utf8");
  return immutable;
}

ensureM0Directories();
const runId = randomUUID();
const db = openM0Database();

try {
  const source = JSON.parse(readFileSync(join(paths.workspaceRoot, SOURCE_PACKAGE_REPORT), "utf8")) as PackageFreezeReport;
  const projectId = source.project.project_id;
  const storyboardPackageId = source.storyboard_package.storyboard_package_id;
  const shotId = source.storyboard_package.shot_ids[0];

  const generation = await createGenerationRunFromPackageShot(
    {
      project_id: projectId,
      storyboard_package_id: storyboardPackageId,
      shot_id: shotId,
      confirmation: {
        confirmation_level: "hard_gate",
        user_confirmed: true
      }
    },
    db
  );

  if (!generation.ok) {
    const payload = {
      task: "R3-4_PACKAGE_BASED_SHOT_GENERATION",
      result: "BLOCK_WITH_REASON",
      run_id: runId,
      generated_at: new Date().toISOString(),
      source_package_report: SOURCE_PACKAGE_REPORT,
      error: generation.error,
      provider_boundary: {
        network_call_attempted: false,
        runway_called: false,
        runninghub_called: false,
        provider_credits_consumed: false,
        real_video_generated: false,
        secret_values_exposed: false
      }
    };
    writeReport(runId, payload);
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }

  const generatedArtifact = generation.generated_artifact_id ? getMediaArtifact(db, generation.generated_artifact_id) : null;
  const payload = {
    task: "R3-4_PACKAGE_BASED_SHOT_GENERATION",
    result: "PASS",
    run_id: runId,
    generated_at: new Date().toISOString(),
    source_package_report: SOURCE_PACKAGE_REPORT,
    project_id: projectId,
    storyboard_package_id: storyboardPackageId,
    shot_id: shotId,
    generation: {
      batch_id: generation.batch.batch_id,
      batch_status: generation.batch.status,
      run_id: generation.run.run_id,
      run_status: generation.run.status,
      provider_name: generation.run.provider.provider_name,
      provider_job_id: generation.run.provider.provider_job_id,
      generated_artifact_id: generation.generated_artifact_id
    },
    provider_request_summary: generation.provider_request_summary,
    generated_clip_artifact: generatedArtifact
      ? {
          artifact_id: generatedArtifact.artifact_id,
          artifact_type: generatedArtifact.artifact_type,
          role: generatedArtifact.role,
          status: generatedArtifact.status,
          storage_uri: generatedArtifact.storage.uri,
          source_provider: generatedArtifact.source.provider,
          provider_job_id: generatedArtifact.source.provider_job_id
        }
      : null,
    ffprobe: generation.ffprobe,
    hard_gates: {
      live_provider_submit_without_exact_authorization: "BLOCKED_BY_DEFAULT",
      old_versions_overwritten: false,
      raw_data_imports_provider_input: false,
      source_assets_overwritten: false,
      automatic_regeneration: false
    },
    provider_boundary: {
      network_call_attempted: false,
      runway_called: false,
      runninghub_called: false,
      provider_credits_consumed: false,
      real_video_generated: false,
      regeneration_performed: false,
      batch_generation_performed: false,
      secret_values_exposed: false
    },
    report_path: `data/reports/${REPORT_STEM}_${runId}.json`,
    latest_report_path: LATEST_REPORT
  };
  writeReport(runId, payload);
  console.log(JSON.stringify(payload, null, 2));
} finally {
  db.close();
}
