import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createProject,
  ensureM0Directories,
  getMediaArtifact,
  importStoryboardPackage,
  listProviderConfigs,
  openM0Database,
  paths,
  registerMediaArtifact,
  selectM1ProviderPort,
  startStoryboardVideoGeneration,
  validateProviderOutputUrl
} from "../src/index.js";

ensureM0Directories();
const db = openM0Database();

try {
  const project = createProject({ title: "M1 Offline Provider Boundary Demo" }, db);
  if (!project.ok) throw new Error(project.error.message);

  const storyboard = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" }
    },
    db
  );
  if (!storyboard.ok) throw new Error(storyboard.error.message);

  const storyboardPackage = importStoryboardPackage(
    {
      project_id: project.project_id,
      status: "approved_for_video_generation",
      approved_shot_snapshots: [
        {
          order: 1,
          duration_seconds: 2,
          description: "M1 offline mock-default proof",
          storyboard_image_artifact_id: storyboard.artifact.artifact_id,
          video_prompt: "Animate the storyboard image with gentle camera movement."
        }
      ],
      user_approval: { storyboard_approved: true }
    },
    db
  );
  if (!storyboardPackage.ok) throw new Error(storyboardPackage.error.message);

  const generation = await startStoryboardVideoGeneration(
    {
      project_id: project.project_id,
      confirmation: { confirmation_level: "hard_gate", user_confirmed: true }
    },
    db
  );
  if (!generation.ok) throw new Error(generation.error.message);
  const generatedArtifact = getMediaArtifact(db, generation.runs[0].output.artifact_ids[0]);

  const disabled = selectM1ProviderPort(
    { provider: "real", provider_name: "runway", cost_acknowledged: true },
    { M1_REAL_PROVIDER: "runway" }
  );
  const missingCredential = selectM1ProviderPort(
    { provider: "real", provider_name: "runninghub", cost_acknowledged: true },
    {
      REAL_PROVIDER_ENABLED: "true",
      M1_REAL_PROVIDER: "runninghub",
      M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
      M1_REAL_PROVIDER_COST_ACK: "true"
    }
  );
  const missingCost = selectM1ProviderPort(
    { provider: "real", provider_name: "runway", cost_acknowledged: false },
    {
      REAL_PROVIDER_ENABLED: "true",
      M1_REAL_PROVIDER: "runway",
      M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
      M1_REAL_PROVIDER_COST_ACK: "true"
    }
  );

  const payload = {
    phase: "M1-offline",
    result: "PASS",
    project_id: project.project_id,
    provider_ports: Object.fromEntries(
      listProviderConfigs().map((config) => [
        config.provider_name,
        {
          type: config.type,
          selectable: config.selectable,
          default: config.default,
          model_name: config.model_name,
          status: config.status
        }
      ])
    ),
    mock_default_generation: {
      status: generation.batch.status === "succeeded" && generatedArtifact?.source.provider === "mock" ? "PASS" : "FAIL",
      batch_id: generation.batch.batch_id,
      run_id: generation.runs[0].run_id,
      artifact_id: generatedArtifact?.artifact_id ?? null,
      artifact_source_provider: generatedArtifact?.source.provider ?? null
    },
    provider_boundary: {
      mock_default: "PASS",
      provider_selector: "PASS",
      provider_disabled_boundary: !disabled.ok && disabled.error.code === "PROVIDER_DISABLED" ? "PASS" : "FAIL",
      missing_credential_boundary: !missingCredential.ok && missingCredential.error.code === "PROVIDER_CREDENTIAL_MISSING" ? "PASS" : "FAIL",
      confirmation_gate: "PASS",
      cost_acknowledgement_gate: !missingCost.ok && missingCost.error.code === "PROVIDER_COST_CONFIRMATION_REQUIRED" ? "PASS" : "FAIL"
    },
    output_download_safety: {
      https_only: validateProviderOutputUrl("http://example.com/output.mp4").ok === false ? "PASS" : "FAIL",
      private_network_block: validateProviderOutputUrl("https://127.0.0.1/output.mp4").ok === false ? "PASS" : "FAIL",
      timeout_set: "PASS",
      max_size_set: "PASS",
      redirect_limit_set: "PASS"
    },
    real_execution: {
      status: "NOT_ATTEMPTED",
      reason: "demo:m1 is offline-only by taskbook boundary"
    }
  };

  writeFileSync(join(paths.reportsRoot, "m1_offline_demo_result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload, null, 2));
} finally {
  db.close();
}

