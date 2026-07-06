import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  createProject,
  ensureM0Directories,
  getMediaArtifact,
  importG0AppReadyStoryboardPackage,
  openM0Database,
  paths,
  registerMediaArtifact,
  saveG0Artifact,
  selectM1ProviderPort,
  validateG0StoryboardPackage,
  type G0ArtifactKind,
  type G0StoryboardPackageInput
} from "../src/index.js";

const SAMPLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

function writeImportImage(filename: string): string {
  ensureM0Directories();
  mkdirSync(paths.importsRoot, { recursive: true });
  const target = join(paths.importsRoot, filename);
  writeFileSync(target, SAMPLE_PNG);
  return target;
}

function writeResult(payload: unknown): void {
  const reportPath = join(paths.reportsRoot, "g0_demo_result.json");
  writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload, null, 2));
}

ensureM0Directories();
const db = openM0Database();

try {
  const project = createProject({
    title: "G0 App-ready Package Demo",
    project_type: "g0_pregeneration",
    video_spec: {
      duration_seconds: 15,
      aspect_ratio: "9:16",
      resolution: "1080x1920"
    }
  }, db);
  if (!project.ok) throw new Error(project.error.message);

  const g0Payloads: Array<[G0ArtifactKind, unknown]> = [
    ["creative_brief", { product: "demo skincare bottle", objective: "15s vertical realistic commercial", audience: "mobile shoppers" }],
    ["script", { beats: ["hero reveal", "texture macro", "end card"] }],
    ["shot_list", { shots: [{ order: 1, duration_seconds: 5, description: "Hero bottle push-in" }] }],
    ["storyboard_image_prompts", { prompts: ["realistic studio product frame, clean reflection, vertical crop"] }],
    ["storyboard_review_record", { approved_by_user: true, reviewer: "test_fixture", notes: ["ready for app import"] }],
    ["storyboard_package_draft", { status: "draft_for_review", shots: [{ order: 1, image_ref: "chat-image-ref", approved_by_user: false }] }]
  ];

  const savedArtifacts = Object.fromEntries(
    g0Payloads.map(([kind, payload]) => {
      const saved = saveG0Artifact({ project_id: project.project_id, kind, payload }, db);
      if (!saved.ok) throw new Error(saved.error.message);
      return [kind, saved.saved.path];
    })
  );

  const sourcePath = writeImportImage("g0_app_ready_storyboard_001.png");
  const storyboardArtifact = registerMediaArtifact(
    {
      artifact_type: "image",
      role: "storyboard_image",
      source: { kind: "local_file_import", import_filename: basename(sourcePath) },
      linked_objects: { project_id: project.project_id }
    },
    db
  );
  if (!storyboardArtifact.ok) throw new Error(storyboardArtifact.error.message);

  const appReady: G0StoryboardPackageInput = {
    project_id: project.project_id,
    status: "approved_for_video_generation",
    approved_by_user: true,
    confirmation: { user_confirmed: true, source: "test_fixture" },
    shots: [
      {
        shot_id: "g0_demo_shot_001",
        order: 1,
        duration_seconds: 5,
        storyboard_image_artifact_id: storyboardArtifact.artifact.artifact_id,
        shot_description: "Hero bottle push-in on a clean reflective surface.",
        video_prompt: "Animate the storyboard image with a slow camera push and subtle liquid shimmer.",
        negative_prompt: "",
        continuity_constraints: ["Keep bottle shape stable", "No extra text", "Maintain vertical crop"],
        approved_by_user: true
      }
    ]
  };

  const validation = validateG0StoryboardPackage(appReady, db);
  if (!validation.ok) throw new Error(validation.error.message);
  const imported = importG0AppReadyStoryboardPackage(appReady, db);
  if (!imported.ok) throw new Error(imported.error.message);

  const storedArtifact = getMediaArtifact(db, storyboardArtifact.artifact.artifact_id);
  const realProviderDisabled = selectM1ProviderPort(
    { provider: "real", provider_name: "runway", cost_acknowledged: true },
    { M1_REAL_PROVIDER: "runway" }
  );

  writeResult({
    phase: "G0",
    result: validation.app_ready && imported.ok && storedArtifact?.status === "active" ? "PASS" : "FAIL",
    project_id: project.project_id,
    saved_g0_artifacts: savedArtifacts,
    local_storyboard_import: "PASS",
    storyboard_artifact: {
      artifact_id: storyboardArtifact.artifact.artifact_id,
      status: storedArtifact?.status,
      artifact_type: storedArtifact?.artifact_type,
      role: storedArtifact?.role,
      source_path: sourcePath,
      stored_path: storedArtifact?.storage.uri ?? null
    },
    app_ready_package: {
      status: appReady.status,
      validator: validation.app_ready ? "PASS" : "FAIL",
      storyboard_package_id: imported.storyboard_package_id,
      saved_path: imported.saved_package.path,
      video_prompt_present: appReady.shots.every((shot) => shot.video_prompt.length > 0),
      approved_by_user_true: appReady.approved_by_user && appReady.shots.every((shot) => shot.approved_by_user)
    },
    provider_boundary: {
      no_provider_call: "PASS",
      real_provider_disabled: !realProviderDisabled.ok && realProviderDisabled.error.code === "PROVIDER_DISABLED" ? "PASS" : "FAIL",
      network_call_attempted: false
    }
  });
} finally {
  db.close();
}
