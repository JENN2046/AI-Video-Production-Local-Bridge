import { rmSync } from "node:fs";
import { relative } from "node:path";

import { assertInsideWorkspace, ensureM0Directories, paths } from "../src/paths.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";

const dataRoot = assertInsideWorkspace(paths.dataRoot);
const expectedRelativePath = "ops/tools/playwright-data";
const relativeDataRoot = relative(paths.workspaceRoot, dataRoot).split(/[\\/]+/).join("/").toLowerCase();
if (relativeDataRoot !== expectedRelativePath) {
  throw new Error(`Refusing to prepare browser fixture outside ${expectedRelativePath}.`);
}

rmSync(dataRoot, { recursive: true, force: true });
ensureM0Directories();

const db = openM0Database();
try {
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
    saveShot(db, shot);
    created.project.shot_ids.push(shot.shot_id);
  }
  saveProject(db, created.project);

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
