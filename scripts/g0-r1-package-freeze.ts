import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createProject,
  ensureM0Directories,
  getMediaArtifact,
  importG0AppReadyStoryboardPackage,
  openM0Database,
  paths,
  validateG0StoryboardPackage,
  type G0StoryboardPackageInput
} from "../src/index.js";

const IMPORT_PREP_LATEST = "data/reports/g0_r1_import_prep_result.json";
const REPORT_STEM = "g0_r1_package_freeze_result";
const LATEST_REPORT = `data/reports/${REPORT_STEM}.json`;

const shotSpecs = [
  {
    shot_id: "SHOT_001",
    order: 1,
    duration_seconds: 3,
    description: "Ryan sits at the construction-site lunch bench with the gray skullcap visible.",
    video_prompt:
      "Use approved image as visual anchor. Add subtle realistic handheld drift. Keep Ryan seated and calm at the lunch area. Maintain gray skullcap, black hoodie, yellow high-vis vest, white hard hat, gloves, lunch items, construction background, and natural daylight.",
    negative_prompt: "No face drift, no product deformation, no text, no CGI, no unsafe action.",
    continuity_constraints: ["Same Ryan", "Same gray skullcap", "Same wardrobe", "Same lunch area", "Natural daylight"]
  },
  {
    shot_id: "SHOT_002",
    order: 2,
    duration_seconds: 3,
    description: "Ryan reaches toward the work gloves and nearby gear on the lunch table.",
    video_prompt:
      "Use image as visual anchor. Add small natural hand movement toward the gloves. Keep the gray skullcap visible and stable. Maintain the same lunch table, hard hat, thermos, lunch container, worksite background, and natural daylight.",
    negative_prompt: "No broken hands, no extra fingers, no product drift, no text, no poster look.",
    continuity_constraints: ["Same Ryan", "Same gray skullcap", "Same lunch table", "Same props", "Natural daylight"]
  },
  {
    shot_id: "SHOT_003",
    order: 3,
    duration_seconds: 4,
    description: "Ryan adjusts the gray skullcap with both hands, showing comfort, fit, texture, seam structure, and label.",
    video_prompt:
      "Use image as visual anchor. Add subtle hand adjustment motion around the cap edge. Keep cap texture, seams, label, fit, face, wardrobe, and daylight stable. Motion should feel ordinary and practical.",
    negative_prompt: "No distorted hands, no warped cap, no text, no CGI, no face drift, no exaggerated motion.",
    continuity_constraints: ["Same Ryan", "Same gray skullcap", "Same wardrobe", "Construction site daylight"]
  },
  {
    shot_id: "SHOT_004",
    order: 4,
    duration_seconds: 5,
    description: "Ryan stands with hard hat and work bag, ready to return to the worksite while still wearing the gray skullcap.",
    video_prompt:
      "Use image as visual anchor. Add slight forward body movement or gentle handheld follow as Ryan prepares to return to work. Keep the gray skullcap visible and preserve grounded workday realism.",
    negative_prompt: "No heroic exaggeration, no unsafe staging, no text, no product drift, no CGI.",
    continuity_constraints: ["Same Ryan", "Same product", "Same wardrobe", "Same hard hat", "Same work bag", "Natural daylight"]
  }
] as const;

interface ImportPrepReport {
  result: string;
  imported_artifacts: Array<{
    shot_id: string;
    artifact_id: string;
    artifact_type: string;
    role: string;
    status: string;
    storage_uri: string;
  }>;
}

function reportPath(runId: string): string {
  return join(paths.reportsRoot, `${REPORT_STEM}_${runId}.json`);
}

function latestReportPath(): string {
  return join(paths.workspaceRoot, LATEST_REPORT);
}

function writeReport(runId: string, payload: unknown): string {
  ensureM0Directories();
  const immutablePath = reportPath(runId);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(immutablePath, text, "utf8");
  writeFileSync(latestReportPath(), text, "utf8");
  return immutablePath;
}

function loadImportPrep(): ImportPrepReport {
  const path = join(paths.workspaceRoot, IMPORT_PREP_LATEST);
  if (!existsSync(path)) {
    throw new Error(`Missing import-prep report: ${IMPORT_PREP_LATEST}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ImportPrepReport;
  if (parsed.result !== "PASS") {
    throw new Error(`Import-prep report is not PASS: ${parsed.result}`);
  }
  return parsed;
}

ensureM0Directories();
const db = openM0Database();
const runId = randomUUID();

try {
  const importPrep = loadImportPrep();
  const artifactByShot = new Map(importPrep.imported_artifacts.map((artifact) => [artifact.shot_id, artifact]));
  const packageShots: G0StoryboardPackageInput["shots"] = [];

  for (const shot of shotSpecs) {
    const artifactSummary = artifactByShot.get(shot.shot_id);
    if (!artifactSummary) {
      throw new Error(`${shot.shot_id} is missing an app-returned Media Artifact ID.`);
    }
    if (
      artifactSummary.artifact_id.startsWith("PENDING") ||
      artifactSummary.artifact_id.includes("PENDING_ACTIVE_ARTIFACT_ID")
    ) {
      throw new Error(`${shot.shot_id} has a pending artifact id, refusing package freeze.`);
    }

    const artifact = getMediaArtifact(db, artifactSummary.artifact_id);
    if (!artifact) {
      throw new Error(`${shot.shot_id} artifact not found in app database: ${artifactSummary.artifact_id}`);
    }
    if (artifact.artifact_type !== "image" || artifact.role !== "storyboard_image" || artifact.status !== "active") {
      throw new Error(`${shot.shot_id} artifact is not an active storyboard image: ${artifactSummary.artifact_id}`);
    }

    packageShots.push({
      shot_id: `g0_r1_${shot.shot_id.toLowerCase()}`,
      order: shot.order,
      duration_seconds: shot.duration_seconds,
      storyboard_image_artifact_id: artifact.artifact_id,
      shot_description: shot.description,
      video_prompt: shot.video_prompt,
      negative_prompt: shot.negative_prompt,
      continuity_constraints: [...shot.continuity_constraints],
      approved_by_user: true
    });
  }

  const project = createProject(
    {
      title: "Ryan's Lunch Break Skullcap",
      project_type: "g0_r1_webgpt_product_ad",
      video_spec: {
        duration_seconds: 15,
        aspect_ratio: "9:16",
        resolution: "1080x1920"
      }
    },
    db
  );
  if (!project.ok) throw new Error(project.error.message);

  const packageInput: G0StoryboardPackageInput = {
    project_id: project.project_id,
    status: "approved_for_video_generation",
    shots: packageShots,
    approved_by_user: true,
    confirmation: {
      user_confirmed: true,
      source: "app"
    }
  };

  const validation = validateG0StoryboardPackage(packageInput, db);
  if (!validation.ok) throw new Error(`${validation.error.code}: ${validation.error.message}`);
  const imported = importG0AppReadyStoryboardPackage(packageInput, db);
  if (!imported.ok) throw new Error(`${imported.error.code}: ${imported.error.message}`);

  const result = {
    task: "G0-R1-PACKAGE-FREEZE",
    result: "PASS",
    run_id: runId,
    generated_at: new Date().toISOString(),
    source_import_prep_report: IMPORT_PREP_LATEST,
    project: {
      project_id: imported.project.project_id,
      title: imported.project.title,
      status: imported.project.status
    },
    package_validation: {
      validateG0StoryboardPackage: "PASS",
      importG0AppReadyStoryboardPackage: "PASS"
    },
    storyboard_package: {
      storyboard_package_id: imported.storyboard_package_id,
      status: "approved_for_video_generation",
      frozen: true,
      shot_count: imported.shots.length,
      shot_ids: imported.shots.map((shot) => shot.shot_id)
    },
    shots: packageShots.map((shot) => ({
      shot_id: shot.shot_id,
      order: shot.order,
      duration_seconds: shot.duration_seconds,
      storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
      approved_by_user: shot.approved_by_user
    })),
    provider_boundary: {
      network_call_attempted: false,
      runway_called: false,
      runninghub_called: false,
      video_generated: false,
      regeneration_performed: false,
      batch_generation_performed: false,
      source_assets_overwritten: false
    },
    report_path: `data/reports/${REPORT_STEM}_${runId}.json`,
    latest_report_path: LATEST_REPORT
  };
  writeReport(runId, result);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = {
    task: "G0-R1-PACKAGE-FREEZE",
    result: "BLOCK_WITH_REASON",
    run_id: runId,
    generated_at: new Date().toISOString(),
    error: {
      code: "G0_R1_PACKAGE_FREEZE_BLOCKED",
      message: error instanceof Error ? error.message : "Package freeze failed."
    },
    provider_boundary: {
      network_call_attempted: false,
      runway_called: false,
      runninghub_called: false,
      video_generated: false,
      regeneration_performed: false,
      batch_generation_performed: false,
      source_assets_overwritten: false
    }
  };
  writeReport(runId, result);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  db.close();
}
