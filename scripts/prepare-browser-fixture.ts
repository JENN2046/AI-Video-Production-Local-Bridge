import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { assertInsideWorkspace, ensureM0Directories, paths } from "../src/paths.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { migrateDatabase } from "../src/storage/databaseGovernance.js";
import { saveGenerationRun, type GenerationRun } from "../src/tools/generation.js";
import { persistMediaArtifact, type MediaArtifact } from "../src/tools/mediaArtifacts.js";
import { createProject, saveProject, saveShot, type Project, type Shot } from "../src/tools/projects.js";

const dataRoot = assertInsideWorkspace(paths.dataRoot);
const relativeDataRoot = relative(paths.workspaceRoot, dataRoot).split(/[\\/]+/).join("/").toLowerCase();
if (!/^ops\/tools\/playwright-data(?:-\d{4,5})?$/.test(relativeDataRoot)) {
  throw new Error("Refusing to prepare browser fixture outside its governed ops/tools/playwright-data lane.");
}

rmSync(dataRoot, { recursive: true, force: true });
ensureM0Directories();
migrateDatabase(paths.sqlitePath);

const db = openM0Database();
try {
  const createProductionProject = (title: string, durationSeconds = 6): Project => {
    const result = createProject({
      title,
      project_type: "browser_smoke",
      video_spec: { duration_seconds: durationSeconds, aspect_ratio: "9:16", resolution: "1080x1920" }
    }, db);
    if (!result.ok) throw new Error(result.error.message);
    db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(result.project_id);
    return result.project;
  };

  const persistFixtureArtifact = (input: {
    artifactId: string;
    projectId: string;
    shotId?: string;
    artifactType: "image" | "video";
    role: "storyboard_image" | "generated_clip" | "final_video";
    durationSeconds?: number | null;
  }): MediaArtifact => {
    const extension = input.artifactType === "image" ? "png" : "mp4";
    const targetRoot = input.artifactType === "image" ? paths.imageArtifactsRoot : paths.videoArtifactsRoot;
    const target = join(targetRoot, `${input.artifactId}.${extension}`);
    const source = input.artifactType === "image"
      ? resolve(paths.workspaceRoot, "fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png")
      : resolve(paths.workspaceRoot, "fixtures/video/mock_clip.mp4");
    copyFileSync(source, target);
    const artifact: MediaArtifact = {
      artifact_id: input.artifactId,
      blob_id: "",
      artifact_type: input.artifactType,
      role: input.role,
      status: "active",
      storage: { uri: target, mime_type: input.artifactType === "image" ? "image/png" : "video/mp4", filename: `${input.artifactId}.${extension}` },
      metadata: { width: 720, height: 1280, duration_seconds: input.durationSeconds ?? null, aspect_ratio: "9:16", sha256: "" },
      linked_objects: { project_id: input.projectId, shot_id: input.shotId ?? "" },
      source: {
        kind: "browser_fixture",
        provider: input.role === "generated_clip" ? "mock" : input.role === "final_video" ? "local_assembly" : "",
        provider_job_id: input.artifactId,
        sha256: "",
        external_url_host: ""
      }
    };
    persistMediaArtifact(db, artifact);
    return artifact;
  };

  const createFixtureShot = (project: Project, input: { shotId: string; order: number; status?: Shot["status"] }): Shot => {
    const shot: Shot = {
      shot_id: input.shotId,
      project_id: project.project_id,
      order: input.order,
      status: input.status ?? "storyboard_approved",
      duration_seconds: 6,
      description: `Browser fixture SHOT ${input.order}`,
      storyboard_image_artifact_id: "",
      video_prompt: `Stable browser fixture prompt ${input.order}`,
      negative_prompt: "",
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    const storyboard = persistFixtureArtifact({
      artifactId: `artifact_${input.shotId}_storyboard`,
      projectId: project.project_id,
      shotId: shot.shot_id,
      artifactType: "image",
      role: "storyboard_image"
    });
    shot.storyboard_image_artifact_id = storyboard.artifact_id;
    saveShot(db, shot);
    project.shot_ids.push(shot.shot_id);
    saveProject(db, project);
    return shot;
  };

  const attachAcceptedClip = (project: Project, shot: Shot, suffix: string): MediaArtifact => {
    const clip = persistFixtureArtifact({
      artifactId: `artifact_${suffix}_clip`,
      projectId: project.project_id,
      shotId: shot.shot_id,
      artifactType: "video",
      role: "generated_clip",
      durationSeconds: shot.duration_seconds
    });
    shot.accepted_clip_artifact_id = clip.artifact_id;
    shot.clip_versions = [{ artifact_id: clip.artifact_id, run_id: `run_${suffix}`, attempt_number: 1, review_status: "approved" }];
    shot.status = "approved";
    shot.review.approval_status = "approved";
    saveShot(db, shot);
    return clip;
  };

  const createDeliveryProject = (title: string, suffix: string, state: "final_review" | "approved" | "exported"): Project => {
    const project = createProductionProject(title);
    const shot = createFixtureShot(project, { shotId: `shot_${suffix}_1`, order: 1 });
    attachAcceptedClip(project, shot, suffix);
    const finalArtifact = persistFixtureArtifact({
      artifactId: `artifact_${suffix}_final`,
      projectId: project.project_id,
      artifactType: "video",
      role: "final_video",
      durationSeconds: project.video_spec.duration_seconds
    });
    project.status = "video_review";
    project.exports.final_video_artifact_id = finalArtifact.artifact_id;
    saveProject(db, project);
    const timestamp = new Date().toISOString();
    // The Browser CI fixture is prepared before FFprobe is available. Preserve the
    // real transition order here; the running service still revalidates every byte.
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?")
      .run(timestamp, project.project_id);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'assembling', assembly_input_fingerprint = ?, updated_at = ? WHERE project_id = ?")
      .run("a".repeat(64), timestamp, project.project_id);
    db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'final_review', current_final_artifact_id = ?, updated_at = ? WHERE project_id = ?")
      .run(finalArtifact.artifact_id, timestamp, project.project_id);
    if (state === "approved" || state === "exported") {
      db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'approved', approved_artifact_id = ?, updated_at = ? WHERE project_id = ?")
        .run(finalArtifact.artifact_id, timestamp, project.project_id);
    }
    if (state === "exported") {
      const exportId = `export_${suffix}`;
      const exportDirectory = join(paths.exportsRoot, project.project_id);
      const exportFilename = `${project.project_id}_browser_${suffix}.mp4`;
      const exportTarget = join(exportDirectory, exportFilename);
      mkdirSync(exportDirectory, { recursive: true });
      copyFileSync(resolve(paths.workspaceRoot, "fixtures/video/mock_clip.mp4"), exportTarget);
      const relativePath = `data/exports/${project.project_id}/${exportFilename}`;
      db.prepare(`INSERT INTO workbench_exports
        (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(exportId, project.project_id, finalArtifact.artifact_id, relativePath, finalArtifact.metadata.sha256, statSync(exportTarget).size, timestamp);
      db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'exported', latest_export_id = ?,
        latest_exported_at = ?, updated_at = ? WHERE project_id = ?`)
        .run(exportId, timestamp, timestamp, project.project_id);
    }
    return project;
  };

  const created = createProject({
    title: "Playwright Production Fixture",
    project_type: "browser_smoke",
    video_spec: { duration_seconds: 18, aspect_ratio: "9:16", resolution: "1080x1920" }
  }, db);
  if (!created.ok) throw new Error(created.error.message);
  db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);

  for (let index = 0; index < 3; index += 1) {
    const shot: Shot = {
      shot_id: `shot_browser_${index + 1}`,
      project_id: created.project_id,
      order: index + 1,
      status: "draft",
      duration_seconds: 6,
      description: `Browser fixture SHOT ${index + 1}`,
      storyboard_image_artifact_id: "",
      video_prompt: `Stable browser fixture prompt ${index + 1}`,
      negative_prompt: "",
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    const storyboardId = `artifact_browser_storyboard_${index + 1}`;
    const storyboardTarget = join(paths.imageArtifactsRoot, `${storyboardId}.png`);
    copyFileSync(resolve(paths.workspaceRoot, "fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png"), storyboardTarget);
    const storyboard: MediaArtifact = {
      artifact_id: storyboardId,
      blob_id: "",
      artifact_type: "image",
      role: "storyboard_image",
      status: "active",
      storage: { uri: storyboardTarget, mime_type: "image/png", filename: `${storyboardId}.png` },
      metadata: { width: 720, height: 1280, duration_seconds: null, aspect_ratio: "9:16", sha256: "" },
      linked_objects: { project_id: created.project_id, shot_id: shot.shot_id },
      source: { kind: "browser_fixture", provider: "", provider_job_id: "", sha256: "", external_url_host: "" }
    };
    persistMediaArtifact(db, storyboard);
    shot.storyboard_image_artifact_id = storyboard.artifact_id;
    const attempts = index === 0 ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const clipId = `artifact_browser_clip_${index + 1}_${attempt}`;
      const clipTarget = join(paths.videoArtifactsRoot, `${clipId}.mp4`);
      copyFileSync(resolve(paths.workspaceRoot, "fixtures/video/mock_clip.mp4"), clipTarget);
      const clip: MediaArtifact = {
        artifact_id: clipId,
        blob_id: "",
        artifact_type: "video",
        role: "generated_clip",
        status: "active",
        storage: { uri: clipTarget, mime_type: "video/mp4", filename: `${clipId}.mp4` },
        metadata: { width: 720, height: 1280, duration_seconds: shot.duration_seconds, aspect_ratio: "9:16", sha256: "" },
        linked_objects: { project_id: created.project_id, shot_id: shot.shot_id },
        source: { kind: "browser_fixture", provider: "mock", provider_job_id: `browser_fixture_${index + 1}_${attempt}`, sha256: "", external_url_host: "" }
      };
      persistMediaArtifact(db, clip);
      const run: GenerationRun = {
        run_id: `run_browser_${index + 1}_${attempt}`,
        batch_id: "batch_browser_fixture",
        project_id: created.project_id,
        shot_id: shot.shot_id,
        run_type: attempt === 1 ? "image_to_video" : "regenerate_shot",
        status: "succeeded",
        input: {
          storyboard_image_artifact_id: storyboard.artifact_id,
          video_prompt: shot.video_prompt,
          negative_prompt: shot.negative_prompt,
          duration_seconds: shot.duration_seconds,
          aspect_ratio: created.project.video_spec.aspect_ratio,
          resolution: created.project.video_spec.resolution
        },
        output: { artifact_ids: [clip.artifact_id] },
        provider: { provider: "mock", provider_name: "mock", model_name: "browser-fixture", provider_job_id: `browser_fixture_${index + 1}_${attempt}`, provider_status: "succeeded" },
        versioning: { attempt_number: attempt, parent_run_id: attempt === 1 ? "" : `run_browser_${index + 1}_${attempt - 1}` },
        error: { code: "", message: "", retryable: false }
      };
      saveGenerationRun(db, run);
      shot.generation_run_ids.push(run.run_id);
      shot.clip_versions.push({ artifact_id: clip.artifact_id, run_id: run.run_id, attempt_number: attempt, review_status: "pending" });
    }
    const accepted = shot.clip_versions.at(-1);
    if (!accepted) throw new Error(`Browser fixture SHOT ${shot.shot_id} has no generated version.`);
    accepted.review_status = "approved";
    shot.accepted_clip_artifact_id = accepted.artifact_id;
    shot.status = "approved";
    shot.review.approval_status = "approved";
    saveShot(db, shot);
    created.project.shot_ids.push(shot.shot_id);
  }
  created.project.status = "video_review";
  saveProject(db, created.project);
  db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = CURRENT_TIMESTAMP WHERE project_id = ?")
    .run(created.project_id);

  const generationProject = createProductionProject("Playwright Generation Fixture", 18);
  createFixtureShot(generationProject, { shotId: "shot_browser_generation_ready", order: 1 });
  const reconciliationShots = [
    { shot: createFixtureShot(generationProject, { shotId: "shot_browser_reconcile_known", order: 2 }), taskId: "task-browser-known" },
    { shot: createFixtureShot(generationProject, { shotId: "shot_browser_reconcile_unknown", order: 3 }), taskId: "" }
  ];
  const insertIntent = db.prepare(`INSERT INTO generation_intents
    (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id, duration_seconds, resolution,
     estimated_cost_value, budget_limit_value, currency, confirmed, expires_at, provider_task_id, status, data_json)
    VALUES (?, ?, ?, 'runninghub', 'personal', 'rhart-video-g/image-to-video', ?, 6, '1080x1920',
      0.08, 1, 'CNY', 1, '2099-01-01T00:00:00.000Z', ?, ?, '{}')`);
  for (const [index, item] of reconciliationShots.entries()) {
    const intentId = `intent_browser_reconcile_${index + 1}`;
    const jobId = `job_browser_reconcile_${index + 1}`;
    insertIntent.run(
      intentId,
      generationProject.project_id,
      item.shot.shot_id,
      item.shot.storyboard_image_artifact_id,
      item.taskId,
      item.taskId ? "running" : "queued"
    );
    db.prepare(`INSERT INTO generation_jobs (job_id, intent_id, state, reconciliation_reason)
      VALUES (?, ?, 'manual_reconciliation', 'PROVIDER_SUBMIT_OUTCOME_UNKNOWN')`).run(jobId, intentId);
  }
  generationProject.status = "storyboard_approved";
  saveProject(db, generationProject);

  createDeliveryProject("Playwright Final Review Fixture", "browser_review", "final_review");
  createDeliveryProject("Playwright Approved Delivery Fixture", "browser_approved", "approved");
  createDeliveryProject("Playwright Exported Delivery Fixture", "browser_exported", "exported");

  const governanceCandidate = createProject({
    title: "M0 Browser Governance Fixture",
    project_type: "browser_smoke",
    video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "1080x1920" }
  }, db);
  if (!governanceCandidate.ok) throw new Error(governanceCandidate.error.message);

  const insertIndex = db.prepare(`
    INSERT INTO import_index (relative_path, filename, size_bytes, mtime_ms, checksum, metadata_json, scanned_at)
    VALUES (?, ?, 1024, ?, ?, ?, ?)
  `);
  const insertDecision = db.prepare(`
    INSERT INTO import_decisions (checksum, filename, decision, reason)
    VALUES (?, ?, 'excluded', 'browser fixture')
  `);
  for (let index = 0; index < 60; index += 1) {
    const filename = `excluded-browser-${String(index + 1).padStart(2, "0")}.png`;
    const checksum = index.toString(16).padStart(64, "0");
    const scannedAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    insertIndex.run(`imports/${filename}`, filename, index, checksum, JSON.stringify({ blockers: [], classification: "storyboard_candidate" }), scannedAt);
    insertDecision.run(checksum, filename);
  }
} finally {
  db.close();
}
