import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runDatabaseMigrations } from "../src/storage/migrations.js";
import { openM0DatabaseConnection } from "../src/storage/sqlite.js";
import { createProject, getProject, getShot, saveProject, saveShot } from "../src/tools/projects.js";
import { importStoryboardPackage, saveStoryboardPackage } from "../src/tools/storyboardPackages.js";
import { scanS3bT2Eligibility, s3bT2ExitCode, type S3bT2ScanOptions } from "../src/tools/s3bT2Eligibility.js";
import { validateImageBuffer, validateImageBufferDecoded } from "../src/tools/imageValidity.js";
import type { M0Paths } from "../src/paths.js";
import type { MediaArtifact } from "../src/tools/mediaArtifacts.js";

interface Fixture {
  root: string;
  paths: M0Paths;
  project_id: string;
  shot_id: string;
  package_id: string;
  artifact_id: string;
  media_path: string;
  cleanup(): void;
}

function fixturePaths(root: string): M0Paths {
  const dataRoot = join(root, "data");
  const mediaRoot = join(dataRoot, "media");
  const activation = join(mediaRoot, ".activation");
  return {
    workspaceRoot: root,
    dataRoot,
    importsRoot: join(dataRoot, "imports"),
    sqlitePath: join(dataRoot, "app.sqlite"),
    mediaRoot,
    imageArtifactsRoot: join(mediaRoot, "artifacts", "images"),
    videoArtifactsRoot: join(mediaRoot, "artifacts", "videos"),
    finalArtifactsRoot: join(mediaRoot, "artifacts", "final"),
    mediaActivationRoot: activation,
    mediaActivationStagingRoot: join(activation, "staging"),
    mediaActivationPendingRoot: join(activation, "pending"),
    mediaActivationQuarantineRoot: join(activation, "quarantine"),
    mediaActivationJournalRoot: join(activation, "journal"),
    reportsRoot: join(dataRoot, "reports")
  };
}

function addArtifact(db: ReturnType<typeof openM0DatabaseConnection>, paths: M0Paths, projectId: string, shotId: string, source = "fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png") {
  const artifactId = `artifact_${randomUUID()}`;
  const blobId = `blob_${randomUUID()}`;
  const mediaPath = join(paths.mediaRoot, `${artifactId}.png`);
  mkdirSync(paths.mediaRoot, { recursive: true });
  copyFileSync(resolve(source), mediaPath);
  const bytes = readFileSync(mediaPath);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const artifact: MediaArtifact = {
    artifact_id: artifactId,
    blob_id: blobId,
    artifact_type: "image",
    role: "storyboard_image",
    status: "active",
    storage: { uri: mediaPath, mime_type: "image/png", filename: `${artifactId}.png` },
    metadata: { width: 720, height: 1280, duration_seconds: null, aspect_ratio: "9:16", sha256: sha },
    linked_objects: { project_id: projectId, shot_id: shotId },
    source: { kind: "fixture", provider: "", provider_job_id: "", sha256: sha, external_url_host: "" }
  };
  db.prepare(`INSERT INTO media_blobs (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
    VALUES (?, ?, ?, 'image/png', ?, 'verified', ?)`)
    .run(blobId, sha, bytes.length, mediaPath, JSON.stringify({ media_root: paths.mediaRoot }));
  db.prepare(`INSERT INTO media_artifacts (artifact_id, project_id, shot_id, role, artifact_type, status, data_json)
    VALUES (?, ?, ?, 'storyboard_image', 'image', 'active', ?)`)
    .run(artifactId, projectId, shotId, JSON.stringify(artifact));
  db.prepare("INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)").run(artifactId, blobId);
  return { artifactId, mediaPath };
}

function createFixture(options: { duration?: number; resolution?: string; aspectRatio?: string; classification?: string; lifecycle?: string; projectStatus?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "s3b-t2-"));
  const paths = fixturePaths(root);
  mkdirSync(paths.dataRoot, { recursive: true });
  const db = openM0DatabaseConnection(paths.sqlitePath);
  runDatabaseMigrations(db);
  const duration = options.duration ?? 6;
  const created = createProject({ title: "Fixture", video_spec: { duration_seconds: duration, aspect_ratio: options.aspectRatio ?? "9:16", resolution: options.resolution ?? "720x1280" } }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("fixture project failed");
  const shotId = `shot_${randomUUID()}`;
  db.prepare("UPDATE workbench_project_meta SET classification = ? WHERE project_id = ?")
    .run(options.classification ?? "production", created.project_id);
  const { artifactId, mediaPath } = addArtifact(db, paths, created.project_id, shotId);
  const imported = importStoryboardPackage({
    project_id: created.project_id,
    status: "approved_for_video_generation",
    approved_shot_snapshots: [{ shot_id: shotId, order: 1, duration_seconds: duration, description: "Frozen", storyboard_image_artifact_id: artifactId, video_prompt: "Animate", negative_prompt: "blur" }],
    user_approval: { storyboard_approved: true }
  }, db);
  assert.equal(imported.ok, true);
  if (!imported.ok) throw new Error("fixture package failed");
  const project = getProject(db, created.project_id)!;
  project.status = (options.projectStatus ?? "storyboard_approved") as typeof project.status;
  saveProject(db, project);
  db.prepare("UPDATE workbench_project_meta SET lifecycle = ? WHERE project_id = ?")
    .run(options.lifecycle ?? "active", created.project_id);
  db.close();
  return {
    root, paths, project_id: created.project_id, shot_id: shotId,
    package_id: imported.storyboard_package_id, artifact_id: artifactId, media_path: mediaPath,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function addUnreferencedShotWithStructuredDrift(fixture: Fixture): string {
  const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
  const shot = getShot(db, fixture.shot_id);
  assert.ok(shot);
  const unreferencedShot = {
    ...shot,
    shot_id: `shot_${randomUUID()}`,
    order: 2,
    storyboard_image_artifact_id: ""
  };
  saveShot(db, unreferencedShot);
  db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?")
    .run("{", fixture.artifact_id);
  db.close();
  return unreferencedShot.shot_id;
}

async function scan(fixture: Fixture, options: Omit<S3bT2ScanOptions, "paths"> = {}) {
  return scanS3bT2Eligibility({ paths: fixture.paths, ...options });
}

function insertActiveIntent(db: ReturnType<typeof openM0DatabaseConnection>, fixture: Fixture, intentId: string): void {
  db.prepare(`INSERT INTO generation_intents
    (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
     duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
     confirmed, expires_at, status)
    VALUES (?, ?, ?, 'runninghub', 'primary', 'model', ?, 6, '720x1280', 1, 1, 'USD', 1, '2099-01-01', 'queued')`)
    .run(intentId, fixture.project_id, fixture.shot_id, fixture.artifact_id);
}

function rewriteArtifactLedgerForTest(fixture: Fixture, bytes: Buffer): void {
  writeFileSync(fixture.media_path, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'media_blobs_no_update'").get() as { sql: string } | undefined;
  if (trigger) db.exec("DROP TRIGGER media_blobs_no_update");
  try {
    db.prepare("UPDATE media_blobs SET sha256 = ?, size_bytes = ? WHERE blob_id = (SELECT blob_id FROM media_artifact_blobs WHERE artifact_id = ?)")
      .run(sha, bytes.length, fixture.artifact_id);
    const row = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
    const artifact = JSON.parse(row.data_json) as MediaArtifact;
    artifact.metadata.sha256 = sha;
    artifact.source.sha256 = sha;
    db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?")
      .run(JSON.stringify(artifact), fixture.artifact_id);
  } finally {
    if (trigger) db.exec(trigger.sql);
    db.close();
  }
}

test("authoritative image acceptance performs full decode on the exact buffer", async (t) => {
  const fixture = createFixture();
  try {
    const pngBytes = readFileSync(fixture.media_path);
    const png = validateImageBufferDecoded(pngBytes);
    if (!png.ok && png.error_code === "IMAGE_DECODE_UNAVAILABLE") {
      t.skip("FFmpeg is unavailable for buffer decode validation");
      return;
    }
    assert.equal(png.ok, true);

    const ffmpeg = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const jpegProcess = spawnSync(ffmpeg, ["-v", "error", "-i", fixture.media_path, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], {
      encoding: null,
      windowsHide: true
    });
    if (jpegProcess.status !== 0 || !Buffer.isBuffer(jpegProcess.stdout)) {
      t.skip("FFmpeg could not create the isolated JPEG fixture");
      return;
    }
    const jpeg = validateImageBufferDecoded(jpegProcess.stdout);
    assert.equal(jpeg.ok, true);

    const structurallyPlausible = pngBytes.subarray(0, 24);
    assert.equal(validateImageBuffer(structurallyPlausible).ok, true);
    const decoded = validateImageBufferDecoded(structurallyPlausible);
    assert.equal(decoded.ok, false);
    assert.equal(decoded.error_code, "IMAGE_DECODE_FAILED");
  } finally { fixture.cleanup(); }
});

test("read-only scanner returns one low-disclosure eligible candidate with query_only and zero changes", async () => {
  const fixture = createFixture();
  try {
    const result = await scan(fixture);
    assert.equal(result.result, "PASS_ONE_ELIGIBLE_SHOT");
    assert.equal(result.eligible_candidate_count, 1);
    assert.match(result.candidate_alias ?? "", /^shot_[a-f0-9]{32}$/);
    const legacyAlias = `shot_${createHash("sha256").update(`s3b-t2-alias-v1\u0000${fixture.shot_id}`).digest("hex").slice(0, 16)}`;
    assert.notEqual(result.candidate_alias, legacyAlias);
    assert.equal(result.read_only_proof.sqlite_total_changes, 0);
    assert.deepEqual(result.read_only_proof, { sqlite_total_changes: 0, network_calls: 0, credential_reads: 0, media_writes: 0 });
    const encoded = JSON.stringify(result);
    for (const forbidden of [fixture.project_id, fixture.shot_id, fixture.package_id, fixture.artifact_id, fixture.root, "Animate", "blur"]) assert.equal(encoded.includes(forbidden), false);
    assert.equal(s3bT2ExitCode(result.result), 0);
  } finally { fixture.cleanup(); }
});

test("eligible candidate aliases rotate randomly across scans without identifier disclosure", async () => {
  const fixture = createFixture();
  try {
    const first = await scan(fixture);
    const second = await scan(fixture);
    assert.equal(first.result, "PASS_ONE_ELIGIBLE_SHOT");
    assert.equal(second.result, "PASS_ONE_ELIGIBLE_SHOT");
    assert.match(first.candidate_alias ?? "", /^shot_[a-f0-9]{32}$/);
    assert.match(second.candidate_alias ?? "", /^shot_[a-f0-9]{32}$/);
    assert.notEqual(first.candidate_alias, second.candidate_alias);
    for (const receipt of [first, second]) {
      const encoded = JSON.stringify(receipt);
      assert.equal(encoded.includes(fixture.shot_id), false);
      assert.equal(encoded.includes(fixture.project_id), false);
      assert.equal(encoded.includes(fixture.package_id), false);
      assert.equal(encoded.includes(fixture.artifact_id), false);
      assert.equal(encoded.includes("s3b-t2-alias-v1"), false);
    }
  } finally { fixture.cleanup(); }
});

test("scanner source does not call migration, recovery, writable database, or directory creation entry points", () => {
  const source = readFileSync(resolve("src/tools/s3bT2Eligibility.ts"), "utf8");
  for (const forbidden of ["openM0Database(", "checkDatabase(", "runDatabaseMigrations(", "recoverMediaActivations(", "ensureM0Directories("]) {
    assert.equal(source.includes(forbidden), false);
  }
  assert.equal(source.includes("verifyMediaArtifactBytes"), false);
  assert.match(source, /openM0DatabaseConnection\(scanPaths\.sqlitePath, \{ readOnly: true, assertPathCurrent \}\)/);
});

test("CLI rejects path and activity selectors without opening a database", () => {
  const invoked = spawnSync(process.execPath, [resolve("dist/scripts/s3b-t2-eligible-shot.js"), "--database-path", "forbidden"], { encoding: "utf8" });
  assert.equal(invoked.status, 1);
  const receipt = JSON.parse(invoked.stdout) as { result: string };
  assert.equal(receipt.result, "T2_READ_ONLY_BOUNDARY_VIOLATION");
  assert.equal(invoked.stdout.includes("forbidden"), false);
});

test("the explicit read-only SQLite boundary rejects writes", () => {
  const fixture = createFixture();
  try {
    const db = openM0DatabaseConnection(fixture.paths.sqlitePath, { readOnly: true });
    try {
      assert.equal((db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only, 1);
      assert.throws(() => db.prepare("UPDATE projects SET updated_at = CURRENT_TIMESTAMP").run(), /readonly|read-only/i);
      assert.equal((db.prepare("SELECT total_changes() AS count").get() as { count: number }).count, 0);
    } finally { db.close(); }
  } finally { fixture.cleanup(); }
});

test("project classification, lifecycle, delivered state, and provider capability fail closed", async (t) => {
  for (const entry of [
    [{ classification: "test" }, "PROJECT_NOT_PRODUCTION"],
    [{ lifecycle: "archived" }, "PROJECT_NOT_ACTIVE"],
    [{ projectStatus: "final_approved" }, "PROJECT_ALREADY_DELIVERED"],
    [{ duration: 5 }, "PROVIDER_CAPABILITY_DURATION_UNSUPPORTED"],
    [{ resolution: "unsupported" }, "PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED"],
    [{ aspectRatio: "4:3" }, "PROVIDER_CAPABILITY_ASPECT_RATIO_UNSUPPORTED"]
  ] as const) {
    await t.test(entry[1], async () => {
      const fixture = createFixture(entry[0]);
      try {
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts[entry[1]], 1);
        assert.equal(result.candidate_alias, undefined);
      } finally { fixture.cleanup(); }
    });
  }
});

test("T2 validates project video_spec runtime shape before provider capability lookup", async (t) => {
  const cases = [
    ["missing video_spec", (project: Record<string, unknown>) => { delete project.video_spec; }, "PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED"],
    ["null video_spec", (project: Record<string, unknown>) => { project.video_spec = null; }, "PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED"],
    ["numeric resolution", (project: Record<string, unknown>) => { (project.video_spec as Record<string, unknown>).resolution = 720; }, "PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED"],
    ["object resolution", (project: Record<string, unknown>) => { (project.video_spec as Record<string, unknown>).resolution = {}; }, "PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED"],
    ["numeric aspect ratio", (project: Record<string, unknown>) => { (project.video_spec as Record<string, unknown>).aspect_ratio = 916; }, "PROVIDER_CAPABILITY_ASPECT_RATIO_UNSUPPORTED"],
    ["object aspect ratio", (project: Record<string, unknown>) => { (project.video_spec as Record<string, unknown>).aspect_ratio = {}; }, "PROVIDER_CAPABILITY_ASPECT_RATIO_UNSUPPORTED"]
  ] as const;

  for (const [name, mutate, reason] of cases) {
    await t.test(name, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(fixture.project_id) as { data_json: string };
        const project = JSON.parse(row.data_json) as Record<string, unknown>;
        mutate(project);
        db.prepare("UPDATE projects SET data_json = ? WHERE project_id = ?").run(JSON.stringify(project), fixture.project_id);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts[reason], 1);
        assert.equal(result.reason_code_counts.SHOT_OPERATIONAL_STATE_INELIGIBLE, undefined);
      } finally { fixture.cleanup(); }
    });
  }

  await t.test("empty resolution remains shape-valid and is delegated to the registry", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(fixture.project_id) as { data_json: string };
      const project = JSON.parse(row.data_json) as Record<string, unknown>;
      (project.video_spec as Record<string, unknown>).resolution = "";
      db.prepare("UPDATE projects SET data_json = ? WHERE project_id = ?").run(JSON.stringify(project), fixture.project_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "PASS_ONE_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("active intent remains higher precedence than malformed video_spec", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(fixture.project_id) as { data_json: string };
      const project = JSON.parse(row.data_json) as Record<string, unknown>;
      project.video_spec = null;
      db.prepare("UPDATE projects SET data_json = ? WHERE project_id = ?").run(JSON.stringify(project), fixture.project_id);
      insertActiveIntent(db, fixture, "intent_malformed_video_spec_active");
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED, undefined);
    } finally { fixture.cleanup(); }
  });
});

test("package matching accepts unique order fallback, normalizes null negative prompt, and ignores description", async () => {
  const fixture = createFixture();
  try {
    const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
    const packageRow = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
    const storyboard = JSON.parse(packageRow.data_json);
    delete storyboard.approved_shot_snapshots[0].shot_id;
    delete storyboard.approved_shot_snapshots[0].negative_prompt;
    saveStoryboardPackage(db, storyboard);
    const shotRow = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
    const shot = JSON.parse(shotRow.data_json);
    shot.negative_prompt = null;
    shot.description = "Changed after freeze";
    saveShot(db, shot);
    db.close();
    const result = await scan(fixture);
    assert.equal(result.result, "PASS_ONE_ELIGIBLE_SHOT");
    assert.equal(result.package_match_mode, "order");
  } finally { fixture.cleanup(); }
});

test("T2 classifies malformed Shot JSON and preserves active-intent precedence", async (t) => {
  await t.test("malformed Shot JSON", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare("UPDATE shots SET data_json = ? WHERE shot_id = ?").run('{"x":1,}', fixture.shot_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.SHOT_STATE_INCONSISTENT, 1);
    } finally { fixture.cleanup(); }
  });
  await t.test("malformed Shot JSON with active intent", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare("UPDATE shots SET data_json = ? WHERE shot_id = ?").run('{"x":1,}', fixture.shot_id);
      db.prepare(`INSERT INTO generation_intents
        (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
         duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
         confirmed, expires_at, status)
        VALUES ('intent_malformed_shot', ?, ?, 'runninghub', 'primary', 'model', ?, 6, '720x1280', 1, 1, 'USD', 1, '2099-01-01', 'queued')`)
        .run(fixture.project_id, fixture.shot_id, fixture.artifact_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.SHOT_STATE_INCONSISTENT, undefined);
    } finally { fixture.cleanup(); }
  });
});

test("T2 enforces integer ClipVersion attempts without losing started or active precedence", async (t) => {
  for (const attemptNumber of [1.5, -1.5]) {
    await t.test(`fractional attempt_number ${attemptNumber} is inconsistent`, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
        const shot = JSON.parse(row.data_json);
        shot.clip_versions.push({ artifact_id: "fractional_artifact", run_id: "fractional_run", attempt_number: attemptNumber, review_status: "pending" });
        saveShot(db, shot);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts.SHOT_STATE_INCONSISTENT, 1);
        assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, undefined);
      } finally { fixture.cleanup(); }
    });
  }

  for (const attemptNumber of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
    await t.test(`unsafe integer attempt_number ${attemptNumber} is inconsistent`, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
        const shot = JSON.parse(row.data_json);
        shot.clip_versions.push({ artifact_id: "unsafe_artifact", run_id: "unsafe_run", attempt_number: attemptNumber, review_status: "pending" });
        saveShot(db, shot);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts.SHOT_STATE_INCONSISTENT, 1);
        assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, undefined);
      } finally { fixture.cleanup(); }
    });
  }

  for (const attemptNumber of [1, 0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
    await t.test(`integer attempt_number ${attemptNumber} preserves started history`, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
        const shot = JSON.parse(row.data_json);
        shot.clip_versions.push({ artifact_id: "integer_artifact", run_id: "integer_run", attempt_number: attemptNumber, review_status: "pending" });
        saveShot(db, shot);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, 1);
        assert.equal(result.reason_code_counts.SHOT_STATE_INCONSISTENT, undefined);
      } finally { fixture.cleanup(); }
    });
  }

  for (const [label, attemptNumber] of [
    ["fractional", 1.5],
    ["unsafe positive", Number.MAX_SAFE_INTEGER + 1],
    ["unsafe negative", Number.MIN_SAFE_INTEGER - 1]
  ] as const) {
    await t.test(`${label} ClipVersion preserves active intent precedence`, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
        const shot = JSON.parse(row.data_json);
        shot.clip_versions.push({ artifact_id: `${label}_active_artifact`, run_id: `${label}_active_run`, attempt_number: attemptNumber, review_status: "pending" });
        saveShot(db, shot);
        insertActiveIntent(db, fixture, `intent_${label.replace(/ /g, "_")}_active`);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
        assert.equal(result.reason_code_counts.SHOT_STATE_INCONSISTENT, undefined);
        assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, undefined);
      } finally { fixture.cleanup(); }
    });
  }
});

test("T2 project parsing preserves active-intent precedence and fingerprints invalid facts", async (t) => {
  await t.test("malformed project JSON with active intent is classified as active", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare("UPDATE projects SET data_json = ? WHERE project_id = ?").run("null", fixture.project_id);
      insertActiveIntent(db, fixture, "intent_malformed_project");
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(Object.keys(result.reason_code_counts).length, 1);
      assert.equal(JSON.stringify(result).includes(fixture.project_id), false);
    } finally { fixture.cleanup(); }
  });

  await t.test("project relational/data identity mismatch with active intent is classified as active", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM projects WHERE project_id = ?").get(fixture.project_id) as { data_json: string };
      const project = JSON.parse(row.data_json);
      project.project_id = "project_json_mismatch";
      db.prepare("UPDATE projects SET data_json = ? WHERE project_id = ?").run(JSON.stringify(project), fixture.project_id);
      insertActiveIntent(db, fixture, "intent_project_mismatch");
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(Object.keys(result.reason_code_counts).length, 1);
    } finally { fixture.cleanup(); }
  });

  await t.test("malformed project without active intent remains a boundary failure", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare("UPDATE projects SET data_json = ? WHERE project_id = ?").run("null", fixture.project_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "T2_READ_ONLY_BOUNDARY_VIOLATION");
      assert.deepEqual(result.reason_code_counts, {});
    } finally { fixture.cleanup(); }
  });

  await t.test("invalid project facts changing between snapshots return state changed", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare("UPDATE projects SET data_json = ? WHERE project_id = ?").run("null", fixture.project_id);
      insertActiveIntent(db, fixture, "intent_invalid_project_drift");
      db.close();
      const result = await scan(fixture, { betweenSnapshots: () => {
        const driftDb = openM0DatabaseConnection(fixture.paths.sqlitePath);
        try { driftDb.prepare("UPDATE projects SET data_json = ? WHERE project_id = ?").run("{}", fixture.project_id); }
        finally { driftDb.close(); }
      } });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("active intent disappearing between invalid project snapshots returns state changed", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare("UPDATE projects SET data_json = ? WHERE project_id = ?").run("null", fixture.project_id);
      insertActiveIntent(db, fixture, "intent_project_active_disappears");
      db.close();
      const result = await scan(fixture, { betweenSnapshots: () => {
        const driftDb = openM0DatabaseConnection(fixture.paths.sqlitePath);
        try { driftDb.prepare("DELETE FROM generation_intents WHERE intent_id = ?").run("intent_project_active_disappears"); }
        finally { driftDb.close(); }
      } });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });
});

test("T2 validates Shot generation history runtime shapes before dereferencing", async (t) => {
  for (const [name, mutate] of [
    ["generation_run_ids missing", (shot: Record<string, unknown>) => { delete shot.generation_run_ids; }],
    ["generation_run_ids null", (shot: Record<string, unknown>) => { shot.generation_run_ids = null; }],
    ["generation_run_ids object", (shot: Record<string, unknown>) => { shot.generation_run_ids = {}; }],
    ["generation_run_ids contains non-string", (shot: Record<string, unknown>) => { shot.generation_run_ids = ["run_ok", 1]; }],
    ["clip_versions missing", (shot: Record<string, unknown>) => { delete shot.clip_versions; }],
    ["clip_versions null", (shot: Record<string, unknown>) => { shot.clip_versions = null; }],
    ["clip_versions object", (shot: Record<string, unknown>) => { shot.clip_versions = {}; }],
    ["clip_versions contains null", (shot: Record<string, unknown>) => { shot.clip_versions = [null]; }],
    ["clip_versions contains scalar", (shot: Record<string, unknown>) => { shot.clip_versions = [1]; }],
    ["clip_versions contains array", (shot: Record<string, unknown>) => { shot.clip_versions = [[]]; }],
    ["clip_version missing artifact_id", (shot: Record<string, unknown>) => { shot.clip_versions = [{ run_id: "run", attempt_number: 1, review_status: "pending" }]; }],
    ["clip_version non-string artifact_id", (shot: Record<string, unknown>) => { shot.clip_versions = [{ artifact_id: 1, run_id: "run", attempt_number: 1, review_status: "pending" }]; }],
    ["clip_version missing run_id", (shot: Record<string, unknown>) => { shot.clip_versions = [{ artifact_id: "artifact", attempt_number: 1, review_status: "pending" }]; }],
    ["clip_version non-string run_id", (shot: Record<string, unknown>) => { shot.clip_versions = [{ artifact_id: "artifact", run_id: 1, attempt_number: 1, review_status: "pending" }]; }],
    ["clip_version missing attempt_number", (shot: Record<string, unknown>) => { shot.clip_versions = [{ artifact_id: "artifact", run_id: "run", review_status: "pending" }]; }],
    ["clip_version non-finite attempt_number", (shot: Record<string, unknown>) => { shot.clip_versions = [{ artifact_id: "artifact", run_id: "run", attempt_number: Number.NaN, review_status: "pending" }]; }],
    ["clip_version unknown review_status", (shot: Record<string, unknown>) => { shot.clip_versions = [{ artifact_id: "artifact", run_id: "run", attempt_number: 1, review_status: "unknown" }]; }],
    ["clip_version extra string", (shot: Record<string, unknown>) => { shot.clip_versions = [{ artifact_id: "artifact", run_id: "run", attempt_number: 1, review_status: "pending", note: "extra" }]; }],
    ["clip_version extra null", (shot: Record<string, unknown>) => { shot.clip_versions = [{ artifact_id: "artifact", run_id: "run", attempt_number: 1, review_status: "pending", note: null }]; }],
    ["clip_version extra object", (shot: Record<string, unknown>) => { shot.clip_versions = [{ artifact_id: "artifact", run_id: "run", attempt_number: 1, review_status: "pending", note: {} }]; }]
  ] as const) {
    await t.test(name, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
        const shot = JSON.parse(row.data_json) as Record<string, unknown>;
        mutate(shot);
        saveShot(db, shot as unknown as Parameters<typeof saveShot>[1]);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts.SHOT_STATE_INCONSISTENT, 1);
        assert.notEqual(result.result, "T2_READ_ONLY_BOUNDARY_VIOLATION");
      } finally { fixture.cleanup(); }
    });
  }

  await t.test("malformed nested Shot shape preserves active intent precedence", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
      const shot = JSON.parse(row.data_json) as Record<string, unknown>;
      shot.generation_run_ids = null;
      saveShot(db, shot as unknown as Parameters<typeof saveShot>[1]);
      db.prepare(`INSERT INTO generation_intents
        (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
         duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
         confirmed, expires_at, status)
        VALUES ('intent_shape_active', ?, ?, 'runninghub', 'primary', 'model', ?, 6, '720x1280', 1, 1, 'USD', 1, '2099-01-01', 'queued')`)
        .run(fixture.project_id, fixture.shot_id, fixture.artifact_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.SHOT_STATE_INCONSISTENT, undefined);
      assert.notEqual(result.result, "T2_READ_ONLY_BOUNDARY_VIOLATION");
    } finally { fixture.cleanup(); }
  });

  await t.test("malformed clip_versions preserves active intent precedence", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
      const shot = JSON.parse(row.data_json) as Record<string, unknown>;
      shot.clip_versions = [null];
      saveShot(db, shot as unknown as Parameters<typeof saveShot>[1]);
      db.prepare(`INSERT INTO generation_intents
        (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
         duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
         confirmed, expires_at, status)
        VALUES ('intent_clip_shape_active', ?, ?, 'runninghub', 'primary', 'model', ?, 6, '720x1280', 1, 1, 'USD', 1, '2099-01-01', 'queued')`)
        .run(fixture.project_id, fixture.shot_id, fixture.artifact_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.SHOT_STATE_INCONSISTENT, undefined);
      assert.notEqual(result.result, "T2_READ_ONLY_BOUNDARY_VIOLATION");
    } finally { fixture.cleanup(); }
  });

  await t.test("unknown ClipVersion fields preserve active intent precedence", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
      const shot = JSON.parse(row.data_json) as Record<string, unknown>;
      shot.clip_versions = [{ artifact_id: "artifact", run_id: "run", attempt_number: 1, review_status: "pending", note: "extra" }];
      saveShot(db, shot as unknown as Parameters<typeof saveShot>[1]);
      insertActiveIntent(db, fixture, "intent_clip_extra_active");
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.SHOT_STATE_INCONSISTENT, undefined);
      assert.notEqual(result.result, "T2_READ_ONLY_BOUNDARY_VIOLATION");
    } finally { fixture.cleanup(); }
  });
});

test("T2 rejects malformed Artifact nested shapes without boundary fallback", async (t) => {
  for (const [name, mutate] of [
    ["storage missing", (artifact: Record<string, unknown>) => { delete artifact.storage; }],
    ["storage null", (artifact: Record<string, unknown>) => { artifact.storage = null; }],
    ["storage mime missing", (artifact: Record<string, unknown>) => { delete (artifact.storage as Record<string, unknown>).mime_type; }]
  ] as const) {
    await t.test(name, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
        const artifact = JSON.parse(row.data_json) as Record<string, unknown>;
        mutate(artifact);
        db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run(JSON.stringify(artifact), fixture.artifact_id);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
      } finally { fixture.cleanup(); }
    });
  }
});

test("T2 uses strict nullish-only negative prompt normalization", async (t) => {
  for (const [name, shotValue, snapshotValue] of [
    ["number versus number", 1, 1],
    ["different numbers", 1, 2],
    ["boolean versus boolean", false, false],
    ["object versus object", {}, {}]
  ] as const) {
    await t.test(name, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const shotRow = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
        const shot = JSON.parse(shotRow.data_json);
        shot.negative_prompt = shotValue;
        saveShot(db, shot);
        const packageRow = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
        const storyboard = JSON.parse(packageRow.data_json);
        storyboard.approved_shot_snapshots[0].negative_prompt = snapshotValue;
        saveStoryboardPackage(db, storyboard);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, 1);
        assert.equal(result.candidate_alias, undefined);
      } finally { fixture.cleanup(); }
    });
  }
});

test("T2 validates Storyboard Package relational projection", async (t) => {
  await t.test("relational project id drift", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare("UPDATE storyboard_packages SET project_id = ? WHERE storyboard_package_id = ?").run("project_other", fixture.package_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.PACKAGE_PROJECT_MISMATCH, 1);
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });
  await t.test("relational package id drift", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
      const storyboard = JSON.parse(row.data_json);
      storyboard.storyboard_package_id = "storyboard_package_json_only";
      db.prepare("UPDATE storyboard_packages SET data_json = ? WHERE storyboard_package_id = ?").run(JSON.stringify(storyboard), fixture.package_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, 1);
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });
});

test("T2 validates the approved snapshot collection before matching", async (t) => {
  for (const [name, mutate] of [
    ["approved snapshots missing", (storyboard: Record<string, unknown>) => { delete storyboard.approved_shot_snapshots; }],
    ["approved snapshots null", (storyboard: Record<string, unknown>) => { storyboard.approved_shot_snapshots = null; }],
    ["approved snapshots object", (storyboard: Record<string, unknown>) => { storyboard.approved_shot_snapshots = {}; }],
    ["approved snapshots string", (storyboard: Record<string, unknown>) => { storyboard.approved_shot_snapshots = "snapshot"; }],
    ["approved snapshots contains null", (storyboard: Record<string, unknown>) => { storyboard.approved_shot_snapshots = [null]; }],
    ["approved snapshots contains primitive", (storyboard: Record<string, unknown>) => { storyboard.approved_shot_snapshots = [1]; }]
  ] as const) {
    await t.test(name, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
        const storyboard = JSON.parse(row.data_json) as Record<string, unknown>;
        mutate(storyboard);
        saveStoryboardPackage(db, storyboard as unknown as Parameters<typeof saveStoryboardPackage>[1]);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, 1);
        assert.notEqual(result.result, "T2_READ_ONLY_BOUNDARY_VIOLATION");
      } finally { fixture.cleanup(); }
    });
  }

  for (const [name, mutate] of [
    ["snapshot missing order", (snapshot: Record<string, unknown>) => { delete snapshot.order; }],
    ["snapshot invalid shot_id type", (snapshot: Record<string, unknown>) => { snapshot.shot_id = 1; }],
    ["snapshot empty shot_id", (snapshot: Record<string, unknown>) => { snapshot.shot_id = ""; }],
    ["snapshot null shot_id", (snapshot: Record<string, unknown>) => { snapshot.shot_id = null; }],
    ["snapshot missing duration", (snapshot: Record<string, unknown>) => { delete snapshot.duration_seconds; }],
    ["snapshot missing artifact id", (snapshot: Record<string, unknown>) => { delete snapshot.storyboard_image_artifact_id; }],
    ["snapshot missing video prompt", (snapshot: Record<string, unknown>) => { delete snapshot.video_prompt; }],
    ["snapshot invalid negative prompt", (snapshot: Record<string, unknown>) => { snapshot.negative_prompt = 1; }]
  ] as const) {
    await t.test(name, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
        const storyboard = JSON.parse(row.data_json) as Record<string, unknown>;
        const snapshots = storyboard.approved_shot_snapshots as Array<Record<string, unknown>>;
        mutate(snapshots[0]);
        saveStoryboardPackage(db, storyboard as unknown as Parameters<typeof saveStoryboardPackage>[1]);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, 1);
        assert.notEqual(result.result, "T2_READ_ONLY_BOUNDARY_VIOLATION");
      } finally { fixture.cleanup(); }
    });
  }

  await t.test("one valid snapshot plus one malformed snapshot rejects the whole collection", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
      const storyboard = JSON.parse(row.data_json) as Record<string, unknown>;
      const snapshots = storyboard.approved_shot_snapshots as Array<Record<string, unknown>>;
      const malformed = { ...snapshots[0] };
      delete malformed.order;
      storyboard.approved_shot_snapshots = [snapshots[0], malformed];
      saveStoryboardPackage(db, storyboard as unknown as Parameters<typeof saveStoryboardPackage>[1]);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, 1);
      assert.notEqual(result.result, "T2_READ_ONLY_BOUNDARY_VIOLATION");
    } finally { fixture.cleanup(); }
  });
});

test("ineligible shots retain canonical operational reason codes", async (t) => {
  await t.test("missing video prompt", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
      const shot = JSON.parse(row.data_json);
      shot.video_prompt = "";
      saveShot(db, shot);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.VIDEO_PROMPT_MISSING, 1);
      assert.equal(result.reason_code_counts.SHOT_OPERATIONAL_STATE_INELIGIBLE, undefined);
    } finally { fixture.cleanup(); }
  });
  await t.test("inactive storyboard artifact", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
      const artifact = JSON.parse(row.data_json);
      artifact.status = "inaccessible";
      db.prepare("UPDATE media_artifacts SET status = 'inaccessible', data_json = ? WHERE artifact_id = ?")
        .run(JSON.stringify(artifact), fixture.artifact_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INACTIVE, 1);
      assert.equal(result.reason_code_counts.SHOT_OPERATIONAL_STATE_INELIGIBLE, undefined);
    } finally { fixture.cleanup(); }
  });
});

test("ambiguous package order and unsupported artifact mime are rejected", async (t) => {
  await t.test("ambiguous order", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
      const storyboard = JSON.parse(row.data_json);
      delete storyboard.approved_shot_snapshots[0].shot_id;
      storyboard.approved_shot_snapshots.push({ ...storyboard.approved_shot_snapshots[0] });
      saveStoryboardPackage(db, storyboard);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, 1);
    } finally { fixture.cleanup(); }
  });
  await t.test("unsupported mime", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
      const artifact = JSON.parse(row.data_json);
      artifact.storage.mime_type = "image/gif";
      db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run(JSON.stringify(artifact), fixture.artifact_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.STORYBOARD_IMAGE_MIME_UNSUPPORTED, 1);
    } finally { fixture.cleanup(); }
  });
  await t.test("unsafe media path", async () => {
    const fixture = createFixture();
    try {
      const outside = join(fixture.paths.dataRoot, "outside.png");
      copyFileSync(fixture.media_path, outside);
      const before = readFileSync(outside);
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'media_blobs_no_update'").get() as { sql: string };
      db.exec("DROP TRIGGER media_blobs_no_update");
      db.prepare("UPDATE media_blobs SET storage_uri = ? WHERE blob_id = (SELECT blob_id FROM media_artifact_blobs WHERE artifact_id = ?)").run(outside, fixture.artifact_id);
      db.exec(trigger.sql);
      const row = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
      const artifact = JSON.parse(row.data_json); artifact.storage.uri = outside;
      db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run(JSON.stringify(artifact), fixture.artifact_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
      assert.deepEqual(readFileSync(outside), before);
    } finally { fixture.cleanup(); }
  });
  await t.test("registered media root outside authoritative root is rejected before bytes are read", async () => {
    const fixture = createFixture();
    try {
      const outsideRoot = join(fixture.root, "outside-media");
      mkdirSync(outsideRoot, { recursive: true });
      const outsidePath = join(outsideRoot, "outside.png");
      copyFileSync(fixture.media_path, outsidePath);
      const before = readFileSync(outsidePath);
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'media_blobs_no_update'").get() as { sql: string };
      db.exec("DROP TRIGGER media_blobs_no_update");
      db.prepare("UPDATE media_blobs SET storage_uri = ?, provenance_json = ? WHERE blob_id = (SELECT blob_id FROM media_artifact_blobs WHERE artifact_id = ?)")
        .run(outsidePath, JSON.stringify({ media_root: outsideRoot }), fixture.artifact_id);
      const row = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
      const artifact = JSON.parse(row.data_json);
      artifact.storage.uri = outsidePath;
      db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run(JSON.stringify(artifact), fixture.artifact_id);
      db.exec(trigger.sql);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
      assert.deepEqual(readFileSync(outsidePath), before);
    } finally { fixture.cleanup(); }
  });
  await t.test("symlink escape is rejected without accepting the target", async (t) => {
    const fixture = createFixture();
    try {
      const outsideRoot = join(fixture.root, "outside-media");
      mkdirSync(outsideRoot, { recursive: true });
      const outsidePath = join(outsideRoot, "outside.png");
      copyFileSync(fixture.media_path, outsidePath);
      const linkPath = join(fixture.paths.mediaRoot, "escaped.png");
      try { symlinkSync(outsidePath, linkPath, "file"); } catch { t.skip("file symlink creation is unavailable on this host"); return; }
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'media_blobs_no_update'").get() as { sql: string };
      db.exec("DROP TRIGGER media_blobs_no_update");
      db.prepare("UPDATE media_blobs SET storage_uri = ? WHERE blob_id = (SELECT blob_id FROM media_artifact_blobs WHERE artifact_id = ?)")
        .run(linkPath, fixture.artifact_id);
      const row = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
      const artifact = JSON.parse(row.data_json);
      artifact.storage.uri = linkPath;
      db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run(JSON.stringify(artifact), fixture.artifact_id);
      db.exec(trigger.sql);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
    } finally { fixture.cleanup(); }
  });
});

test("exclusive governed media files reject hard links without changing T2 precedence", async (t) => {
  await t.test("outside-to-inside hard link is rejected before byte acceptance", async (t) => {
    const fixture = createFixture();
    try {
      const outsideRoot = join(fixture.root, "outside-media");
      mkdirSync(outsideRoot, { recursive: true });
      const outsidePath = join(outsideRoot, "source.png");
      copyFileSync(fixture.media_path, outsidePath);
      unlinkSync(fixture.media_path);
      try { linkSync(outsidePath, fixture.media_path); } catch { t.skip("hard-link creation is unavailable on this host"); return; }
      assert.ok(lstatSync(fixture.media_path).nlink >= 2);
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
    } finally { fixture.cleanup(); }
  });

  await t.test("two hard links inside mediaRoot are still non-exclusive", async (t) => {
    const fixture = createFixture();
    try {
      const secondPath = join(fixture.paths.mediaRoot, "second-link.png");
      try { linkSync(fixture.media_path, secondPath); } catch { t.skip("hard-link creation is unavailable on this host"); return; }
      assert.ok(lstatSync(fixture.media_path).nlink >= 2);
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("normal single-link fixture remains eligible", async () => {
    const fixture = createFixture();
    try {
      assert.equal(lstatSync(fixture.media_path).nlink, 1);
      const result = await scan(fixture);
      assert.equal(result.result, "PASS_ONE_ELIGIBLE_SHOT");
      assert.equal(result.artifact_verification_level, "actual_bytes");
    } finally { fixture.cleanup(); }
  });

  await t.test("ledger-matching hard link is rejected despite correct bytes", async (t) => {
    const fixture = createFixture();
    try {
      const outsideRoot = join(fixture.root, "ledger-match-outside");
      mkdirSync(outsideRoot, { recursive: true });
      const outsidePath = join(outsideRoot, "source.png");
      copyFileSync(fixture.media_path, outsidePath);
      unlinkSync(fixture.media_path);
      try { linkSync(outsidePath, fixture.media_path); } catch { t.skip("hard-link creation is unavailable on this host"); return; }
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("active intent remains higher precedence than hard-link integrity", async (t) => {
    const fixture = createFixture();
    try {
      const secondPath = join(fixture.paths.mediaRoot, "active-intent-link.png");
      try { linkSync(fixture.media_path, secondPath); } catch { t.skip("hard-link creation is unavailable on this host"); return; }
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      insertActiveIntent(db, fixture, "intent_hard_link_active");
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("single-link to hard-link drift fails the two-snapshot scan", async (t) => {
    const fixture = createFixture();
    try {
      const secondPath = join(fixture.paths.mediaRoot, "between-snapshots-link.png");
      const result = await scan(fixture, { betweenSnapshots: () => {
        try { linkSync(fixture.media_path, secondPath); } catch { throw new Error("HARD_LINK_UNAVAILABLE"); }
      } });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
      assert.equal(result.candidate_alias, undefined);
    } catch (error) {
      if (error instanceof Error && error.message === "HARD_LINK_UNAVAILABLE") {
        t.skip("hard-link creation is unavailable on this host");
        return;
      }
      throw error;
    } finally { fixture.cleanup(); }
  });

  await t.test("hard-link A to hard-link B drift changes the identity failure fingerprint", async (t) => {
    const fixture = createFixture();
    try {
      const outsideRoot = join(fixture.root, "identity-drift");
      mkdirSync(outsideRoot, { recursive: true });
      const firstPath = join(outsideRoot, "source-a.png");
      const secondPath = join(outsideRoot, "source-b.png");
      copyFileSync(fixture.media_path, firstPath);
      copyFileSync(fixture.media_path, secondPath);
      writeFileSync(secondPath, Buffer.from("different-invalid-bytes"));
      unlinkSync(fixture.media_path);
      try { linkSync(firstPath, fixture.media_path); } catch { t.skip("hard-link creation is unavailable on this host"); return; }
      const result = await scan(fixture, { betweenSnapshots: () => {
        unlinkSync(fixture.media_path);
        linkSync(secondPath, fixture.media_path);
      } });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
      assert.equal(result.candidate_alias, undefined);
    } catch (error) {
      if (error instanceof Error && /hard|link/i.test(error.message)) {
        t.skip("hard-link creation is unavailable on this host");
        return;
      }
      throw error;
    } finally { fixture.cleanup(); }
  });

  await t.test("missing to different invalid file drift changes the identity failure fingerprint", async (t) => {
    const fixture = createFixture();
    try {
      const outsideRoot = join(fixture.root, "missing-drift");
      mkdirSync(outsideRoot, { recursive: true });
      const outsidePath = join(outsideRoot, "source.png");
      copyFileSync(fixture.media_path, outsidePath);
      unlinkSync(fixture.media_path);
      const result = await scan(fixture, { betweenSnapshots: () => {
        try { linkSync(outsidePath, fixture.media_path); } catch { throw new Error("HARD_LINK_UNAVAILABLE"); }
      } });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
      assert.equal(result.candidate_alias, undefined);
    } catch (error) {
      if (error instanceof Error && error.message === "HARD_LINK_UNAVAILABLE") {
        t.skip("hard-link creation is unavailable on this host");
        return;
      }
      throw error;
    } finally { fixture.cleanup(); }
  });

  await t.test("unchanged invalid identity remains a stable integrity rejection", async (t) => {
    const fixture = createFixture();
    try {
      const secondPath = join(fixture.paths.mediaRoot, "stable-invalid-link.png");
      try { linkSync(fixture.media_path, secondPath); } catch { t.skip("hard-link creation is unavailable on this host"); return; }
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });
});

test("authoritative mediaRoot identity is represented in every snapshot", async (t) => {
  await t.test("valid root replacement changes the two-snapshot fingerprint", async () => {
    const fixture = createFixture();
    try {
      const mediaRoot = fixture.paths.mediaRoot;
      const movedRoot = join(fixture.root, "media-root-before-replacement");
      const mediaName = basename(fixture.media_path);
      const result = await scan(fixture, { betweenSnapshots: () => {
        renameSync(mediaRoot, movedRoot);
        mkdirSync(mediaRoot, { recursive: true });
        copyFileSync(join(movedRoot, mediaName), fixture.media_path);
      } });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("invalid non-directory root inode replacement changes the fingerprint", async () => {
    const fixture = createFixture();
    try {
      const invalidRoot = join(fixture.root, "invalid-media-root");
      writeFileSync(invalidRoot, Buffer.from("invalid-root-a"));
      fixture.paths.mediaRoot = invalidRoot;
      const result = await scan(fixture, { betweenSnapshots: () => {
        unlinkSync(invalidRoot);
        writeFileSync(invalidRoot, Buffer.from("invalid-root-b"));
      } });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("invalid symlink target replacement changes the fingerprint", async () => {
    const fixture = createFixture();
    try {
      const invalidRoot = join(fixture.root, "invalid-media-root-link");
      const targetPath = join(fixture.root, "invalid-media-target");
      const movedTargetPath = join(fixture.root, "invalid-media-target-before-replacement");
      mkdirSync(targetPath);
      try { symlinkSync(targetPath, invalidRoot, "junction"); } catch {
        t.skip("directory symlink creation is unavailable on this host");
        return;
      }
      fixture.paths.mediaRoot = invalidRoot;
      const result = await scan(fixture, { betweenSnapshots: () => {
        renameSync(targetPath, movedTargetPath);
        mkdirSync(targetPath);
      } });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("stable invalid root remains a stable integrity rejection", async () => {
    const fixture = createFixture();
    try {
      const invalidRoot = join(fixture.root, "stable-invalid-media-root");
      writeFileSync(invalidRoot, Buffer.from("stable-invalid-root"));
      fixture.paths.mediaRoot = invalidRoot;
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("active intent remains higher precedence than stable invalid root", async () => {
    const fixture = createFixture();
    try {
      const invalidRoot = join(fixture.root, "active-invalid-media-root");
      writeFileSync(invalidRoot, Buffer.from("active-invalid-root"));
      fixture.paths.mediaRoot = invalidRoot;
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      insertActiveIntent(db, fixture, "intent_invalid_root_active");
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, undefined);
    } finally { fixture.cleanup(); }
  });
});

test("snapshot matching requires one globally unique shot or order match", async (t) => {
  for (const [name, reverse] of [["order-only first then shot id", false], ["shot id first then order-only", true]] as const) {
    await t.test(name, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
        const storyboard = JSON.parse(row.data_json);
        const shotIdSnapshot = { ...storyboard.approved_shot_snapshots[0] };
        const orderSnapshot = { ...shotIdSnapshot };
        delete orderSnapshot.shot_id;
        storyboard.approved_shot_snapshots = reverse ? [shotIdSnapshot, orderSnapshot] : [orderSnapshot, shotIdSnapshot];
        saveStoryboardPackage(db, storyboard);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, 1);
        assert.equal(result.candidate_alias, undefined);
      } finally { fixture.cleanup(); }
    });
  }

  for (const [name, snapshots] of [
    ["duplicate shot id", (base: Record<string, unknown>) => [base, { ...base }]],
    ["duplicate order fallback", (base: Record<string, unknown>) => {
      const first = { ...base }; delete first.shot_id;
      const second = { ...first };
      return [first, second];
    }]
  ] as const) {
    await t.test(name, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
        const storyboard = JSON.parse(row.data_json);
        storyboard.approved_shot_snapshots = snapshots(storyboard.approved_shot_snapshots[0]);
        saveStoryboardPackage(db, storyboard);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, 1);
        assert.equal(result.candidate_alias, undefined);
      } finally { fixture.cleanup(); }
    });
  }

  await t.test("unique shot id ignores an unrelated order", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
      const storyboard = JSON.parse(row.data_json);
      storyboard.approved_shot_snapshots.push({ ...storyboard.approved_shot_snapshots[0], shot_id: undefined, order: 2 });
      saveStoryboardPackage(db, storyboard);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "PASS_ONE_ELIGIBLE_SHOT");
      assert.equal(result.package_match_mode, "shot_id");
    } finally { fixture.cleanup(); }
  });

  await t.test("absent shot_id allows same-order fallback", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
      const storyboard = JSON.parse(row.data_json);
      delete storyboard.approved_shot_snapshots[0].shot_id;
      saveStoryboardPackage(db, storyboard);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "PASS_ONE_ELIGIBLE_SHOT");
      assert.equal(result.package_match_mode, "order");
    } finally { fixture.cleanup(); }
  });

  for (const [name, shotId] of [["empty shot_id", ""], ["null shot_id", null], ["wrong non-empty shot_id", "shot_other"]] as const) {
    await t.test(`${name} never falls back to order`, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
        const storyboard = JSON.parse(row.data_json);
        storyboard.approved_shot_snapshots[0].shot_id = shotId;
        saveStoryboardPackage(db, storyboard);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, 1);
        assert.equal(result.candidate_alias, undefined);
      } finally { fixture.cleanup(); }
    });
  }

  await t.test("empty shot_id remains lower priority than active intent", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
      const storyboard = JSON.parse(row.data_json);
      storyboard.approved_shot_snapshots[0].shot_id = "";
      saveStoryboardPackage(db, storyboard);
      insertActiveIntent(db, fixture, "intent_empty_snapshot_active");
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, undefined);
    } finally { fixture.cleanup(); }
  });
});

test("storyboard artifact structured drift is a stable ineligible result", async (t) => {
  for (const [name, mutate] of [
    ["status projection drift", (artifact: Record<string, unknown>) => { artifact.status = "inaccessible"; }],
    ["binding projection drift", (artifact: Record<string, unknown>) => { artifact.linked_objects = { project_id: "other", shot_id: "other" }; }],
    ["role/type projection drift", (artifact: Record<string, unknown>) => { artifact.role = "generated_clip"; artifact.artifact_type = "video"; }]
  ] as const) {
    await t.test(name, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
        const artifact = JSON.parse(row.data_json) as Record<string, unknown>;
        mutate(artifact);
        db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run(JSON.stringify(artifact), fixture.artifact_id);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
        assert.equal(result.candidate_alias, undefined);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(JSON.stringify(result).includes(fixture.artifact_id), false);
        assert.equal(JSON.stringify(result).includes("ARTIFACT_STRUCTURED_DRIFT"), false);
      } finally { fixture.cleanup(); }
    });
  }

  await t.test("structured drift changes the snapshot fingerprint", async () => {
    const fixture = createFixture();
    try {
      const result = await scan(fixture, { betweenSnapshots: () => {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
        const artifact = JSON.parse(row.data_json) as Record<string, unknown>;
        artifact.status = "inaccessible";
        db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run(JSON.stringify(artifact), fixture.artifact_id);
        db.close();
      } });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("active intent takes precedence over unchanged drift", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
      const artifact = JSON.parse(row.data_json) as Record<string, unknown>;
      artifact.status = "inaccessible";
      db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run(JSON.stringify(artifact), fixture.artifact_id);
      db.prepare(`INSERT INTO generation_intents
        (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
         duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
         confirmed, expires_at, status)
        VALUES ('intent_active_drift', ?, ?, 'runninghub', 'primary', 'model', ?, 6, '720x1280', 1, 1, 'USD', 1, '2099-01-01', 'queued')`)
        .run(fixture.project_id, fixture.shot_id, fixture.artifact_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, undefined);
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("unchanged drift and unchanged unreferenced shot remain stable", async () => {
    const fixture = createFixture();
    try {
      addUnreferencedShotWithStructuredDrift(fixture);
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });

  for (const [name, mutate] of [
    ["data_json", (db: ReturnType<typeof openM0DatabaseConnection>, shotId: string) => {
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(shotId) as { data_json: string };
      const shot = JSON.parse(row.data_json) as Record<string, unknown>;
      shot.description = "changed while structured drift remains";
      db.prepare("UPDATE shots SET data_json = ? WHERE shot_id = ?").run(JSON.stringify(shot), shotId);
    }],
    ["shot_id", (db: ReturnType<typeof openM0DatabaseConnection>, shotId: string) => {
      const replacementId = `shot_${randomUUID()}`;
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(shotId) as { data_json: string };
      const shot = JSON.parse(row.data_json) as Record<string, unknown>;
      shot.shot_id = replacementId;
      db.prepare("UPDATE shots SET shot_id = ?, data_json = ? WHERE shot_id = ?")
        .run(replacementId, JSON.stringify(shot), shotId);
    }],
    ["project_id", (db: ReturnType<typeof openM0DatabaseConnection>, shotId: string) => {
      const replacementProjectId = `project_${randomUUID()}`;
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(shotId) as { data_json: string };
      const shot = JSON.parse(row.data_json) as Record<string, unknown>;
      shot.project_id = replacementProjectId;
      db.prepare("UPDATE shots SET project_id = ?, data_json = ? WHERE shot_id = ?")
        .run(replacementProjectId, JSON.stringify(shot), shotId);
    }]
  ] as const) {
    await t.test(`unreferenced shot ${name} change breaks the drift fingerprint`, async () => {
      const fixture = createFixture();
      try {
        const unreferencedShotId = addUnreferencedShotWithStructuredDrift(fixture);
        const result = await scan(fixture, { betweenSnapshots: () => {
          const driftDb = openM0DatabaseConnection(fixture.paths.sqlitePath);
          try { mutate(driftDb, unreferencedShotId); } finally { driftDb.close(); }
        } });
        assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
        assert.equal(result.candidate_alias, undefined);
        const encoded = JSON.stringify(result);
        assert.equal(encoded.includes(unreferencedShotId), false);
        assert.equal(encoded.includes("s3b-t2-shot-fact-v1"), false);
      } finally { fixture.cleanup(); }
    });
  }

  await t.test("malformed artifact projection is a stable integrity rejection", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run("{", fixture.artifact_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });

  for (const [name, mutate] of [
    ["artifact relational fact", (fixture: Fixture, db: ReturnType<typeof openM0DatabaseConnection>) => {
      db.prepare("UPDATE media_artifacts SET status = 'archived' WHERE artifact_id = ?").run(fixture.artifact_id);
    }],
    ["artifact data_json fact", (fixture: Fixture, db: ReturnType<typeof openM0DatabaseConnection>) => {
      const row = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
      const artifact = JSON.parse(row.data_json) as Record<string, unknown>;
      artifact.status = "expired";
      db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run(JSON.stringify(artifact), fixture.artifact_id);
    }],
    ["shot fact", (fixture: Fixture, db: ReturnType<typeof openM0DatabaseConnection>) => {
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
      const shot = JSON.parse(row.data_json); shot.description = "changed while drift remains";
      saveShot(db, shot);
    }],
    ["project fact", (fixture: Fixture, db: ReturnType<typeof openM0DatabaseConnection>) => {
      db.prepare("UPDATE workbench_project_meta SET classification = 'test' WHERE project_id = ?").run(fixture.project_id);
    }]
  ] as const) {
    await t.test(`${name} changes the drift fingerprint`, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
        const artifact = JSON.parse(row.data_json) as Record<string, unknown>;
        artifact.status = "inaccessible";
        db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run(JSON.stringify(artifact), fixture.artifact_id);
        db.close();
        const result = await scan(fixture, { betweenSnapshots: () => {
          const driftDb = openM0DatabaseConnection(fixture.paths.sqlitePath);
          mutate(fixture, driftDb);
          driftDb.close();
        } });
        assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
        assert.equal(result.candidate_alias, undefined);
        assert.equal(JSON.stringify(result).includes(fixture.project_id), false);
        assert.equal(JSON.stringify(result).includes(fixture.shot_id), false);
        assert.equal(JSON.stringify(result).includes(fixture.artifact_id), false);
        assert.equal(JSON.stringify(result).includes("s3b-t2-drift-reference-v1"), false);
      } finally { fixture.cleanup(); }
    });
  }

  await t.test("shot relational keys change the drift fingerprint", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const artifactRow = db.prepare("SELECT data_json FROM media_artifacts WHERE artifact_id = ?").get(fixture.artifact_id) as { data_json: string };
      const artifact = JSON.parse(artifactRow.data_json) as Record<string, unknown>;
      artifact.status = "inaccessible";
      db.prepare("UPDATE media_artifacts SET data_json = ? WHERE artifact_id = ?").run(JSON.stringify(artifact), fixture.artifact_id);
      db.close();
      const result = await scan(fixture, { betweenSnapshots: () => {
        const driftDb = openM0DatabaseConnection(fixture.paths.sqlitePath);
        try {
          const row = driftDb.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
          const shot = JSON.parse(row.data_json) as Record<string, unknown>;
          const replacementShotId = `shot_${randomUUID()}`;
          shot.shot_id = replacementShotId;
          driftDb.prepare("UPDATE shots SET shot_id = ?, data_json = ? WHERE shot_id = ?")
            .run(replacementShotId, JSON.stringify(shot), fixture.shot_id);
        } finally { driftDb.close(); }
      } });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
      assert.equal(result.candidate_alias, undefined);
      assert.equal(JSON.stringify(result).includes(fixture.project_id), false);
      assert.equal(JSON.stringify(result).includes(fixture.shot_id), false);
    } finally { fixture.cleanup(); }
  });

});

test("shot operational fact drift is a stable integrity rejection", async (t) => {
  for (const field of ["shot_id", "project_id"] as const) {
    await t.test(`relational ${field} projection drift`, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
        const shot = JSON.parse(row.data_json) as Record<string, unknown>;
        shot[field] = field === "shot_id" ? "shot_json_only" : "project_json_only";
        db.prepare("UPDATE shots SET data_json = ? WHERE shot_id = ?").run(JSON.stringify(shot), fixture.shot_id);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
        assert.equal(result.eligible_candidate_count, 0);
        assert.equal(result.reason_code_counts.SHOT_STATE_INCONSISTENT, 1);
      } finally { fixture.cleanup(); }
    });
  }

  await t.test("active intent takes precedence over shot drift", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
      const shot = JSON.parse(row.data_json) as Record<string, unknown>;
      shot.shot_id = "shot_json_only";
      db.prepare("UPDATE shots SET data_json = ? WHERE shot_id = ?").run(JSON.stringify(shot), fixture.shot_id);
      db.prepare(`INSERT INTO generation_intents
        (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
         duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
         confirmed, expires_at, status)
        VALUES ('intent_active_shot_drift', ?, ?, 'runninghub', 'primary', 'model', ?, 6, '720x1280', 1, 1, 'USD', 1, '2099-01-01', 'queued')`)
        .run(fixture.project_id, fixture.shot_id, fixture.artifact_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.SHOT_STATE_INCONSISTENT, undefined);
    } finally { fixture.cleanup(); }
  });
});

test("invalid persisted generation states preserve started semantics", async (t) => {
  await t.test("unknown generation run status without active intent", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare(`INSERT INTO generation_runs
        (run_id, batch_id, project_id, shot_id, run_type, status, data_json)
        VALUES ('run_unknown_status', NULL, ?, ?, 'initial', 'unexpected', '{}')`)
        .run(fixture.project_id, fixture.shot_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, 1);
      assert.equal(result.reason_code_counts.SHOT_OPERATIONAL_STATE_INELIGIBLE, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("unknown generation job state without active intent", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare(`INSERT INTO generation_intents
        (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
         duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
         confirmed, expires_at, status)
        VALUES ('intent_unknown_job', ?, ?, 'runninghub', 'primary', 'model', ?, 6, '720x1280', 1, 1, 'USD', 1, '2099-01-01', 'succeeded')`)
        .run(fixture.project_id, fixture.shot_id, fixture.artifact_id);
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES ('job_unknown_state', 'intent_unknown_job', 'unexpected')").run();
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, 1);
      assert.equal(result.reason_code_counts.SHOT_OPERATIONAL_STATE_INELIGIBLE, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("active intent takes precedence over invalid generation run status", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare(`INSERT INTO generation_runs
        (run_id, batch_id, project_id, shot_id, run_type, status, data_json)
        VALUES ('run_unknown_active', NULL, ?, ?, 'initial', 'unexpected', '{}')`)
        .run(fixture.project_id, fixture.shot_id);
      insertActiveIntent(db, fixture, "intent_unknown_run_active");
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, undefined);
    } finally { fixture.cleanup(); }
  });

  await t.test("active intent takes precedence over invalid generation job state", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare(`INSERT INTO generation_intents
        (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
         duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
         confirmed, expires_at, status)
        VALUES ('intent_unknown_job_active_base', ?, ?, 'runninghub', 'primary', 'model', ?, 6, '720x1280', 1, 1, 'USD', 1, '2099-01-01', 'succeeded')`)
        .run(fixture.project_id, fixture.shot_id, fixture.artifact_id);
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES ('job_unknown_active_base', 'intent_unknown_job_active_base', 'unexpected')").run();
      insertActiveIntent(db, fixture, "intent_unknown_job_active");
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, undefined);
    } finally { fixture.cleanup(); }
  });
});

test("missing active package, generation history, and byte drift are deterministic rejections", async (t) => {
  await t.test("draft zero-version shot preserves storyboard approval reason", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
      const shot = JSON.parse(row.data_json);
      shot.status = "draft";
      saveShot(db, shot);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.STORYBOARD_APPROVAL_REQUIRED, 1);
      assert.equal(result.reason_code_counts.SHOT_NOT_STORYBOARD_APPROVED, undefined);
      assert.equal(result.reason_code_counts.SHOT_OPERATIONAL_STATE_INELIGIBLE, undefined);
    } finally { fixture.cleanup(); }
  });
  await t.test("revision-needed zero-version shot preserves storyboard reason", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
      const shot = JSON.parse(row.data_json);
      shot.status = "revision_needed";
      saveShot(db, shot);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.STORYBOARD_REVISION_REQUIRED, 1);
      assert.equal(result.reason_code_counts.SHOT_NOT_STORYBOARD_APPROVED, undefined);
      assert.equal(result.reason_code_counts.SHOT_OPERATIONAL_STATE_INELIGIBLE, undefined);
    } finally { fixture.cleanup(); }
  });
  await t.test("active package missing", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const project = getProject(db, fixture.project_id)!; project.active_storyboard_package_id = ""; saveProject(db, project); db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.PACKAGE_NOT_FOUND, 1);
    } finally { fixture.cleanup(); }
  });
  await t.test("generation_run_ids present", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
      const shot = JSON.parse(row.data_json); shot.generation_run_ids.push("historical_run"); saveShot(db, shot); db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, 1);
      assert.equal(result.reason_code_counts.SHOT_OPERATIONAL_STATE_INELIGIBLE, undefined);
    } finally { fixture.cleanup(); }
  });
  await t.test("clip_versions present", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
      const shot = JSON.parse(row.data_json);
      shot.clip_versions.push({ artifact_id: "historical_artifact", run_id: "historical_run", attempt_number: 1, review_status: "pending" });
      saveShot(db, shot);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, 1);
      assert.equal(result.reason_code_counts.SHOT_OPERATIONAL_STATE_INELIGIBLE, undefined);
    } finally { fixture.cleanup(); }
  });
  await t.test("artifact bytes drift", async () => {
    const fixture = createFixture();
    try {
      writeFileSync(fixture.media_path, Buffer.from("not an image"));
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
    } finally { fixture.cleanup(); }
  });
  await t.test("structurally plausible corrupt bytes are rejected even when the ledger matches", async () => {
    const fixture = createFixture();
    try {
      const structurallyPlausible = readFileSync(fixture.media_path).subarray(0, 24);
      rewriteArtifactLedgerForTest(fixture, structurallyPlausible);
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, undefined);
    } finally { fixture.cleanup(); }
  });
  await t.test("active intent still takes precedence over decode failure", async () => {
    const fixture = createFixture();
    try {
      const structurallyPlausible = readFileSync(fixture.media_path).subarray(0, 24);
      rewriteArtifactLedgerForTest(fixture, structurallyPlausible);
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      insertActiveIntent(db, fixture, "intent_decode_failure_active");
      db.close();
      const result = await scan(fixture);
      assert.equal(result.result, "S3_NO_ELIGIBLE_SHOT");
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, undefined);
    } finally { fixture.cleanup(); }
  });
  await t.test("different invalid bytes change the two-snapshot fingerprint", async () => {
    const fixture = createFixture();
    try {
      writeFileSync(fixture.media_path, Buffer.from("invalid-A"));
      const result = await scan(fixture, { betweenSnapshots: () => writeFileSync(fixture.media_path, Buffer.from("invalid-B")) });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
      assert.equal(result.candidate_alias, undefined);
    } finally { fixture.cleanup(); }
  });
  await t.test("artifact file missing", async () => {
    const fixture = createFixture();
    try {
      rmSync(fixture.media_path);
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.STORYBOARD_ARTIFACT_INTEGRITY_INVALID, 1);
    } finally { fixture.cleanup(); }
  });
  await t.test("frozen input drift", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
      const shot = JSON.parse(row.data_json); shot.video_prompt = "changed"; saveShot(db, shot); db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, 1);
    } finally { fixture.cleanup(); }
  });
  await t.test("package snapshot zero match", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      const row = db.prepare("SELECT data_json FROM storyboard_packages WHERE storyboard_package_id = ?").get(fixture.package_id) as { data_json: string };
      const storyboard = JSON.parse(row.data_json); delete storyboard.approved_shot_snapshots[0].shot_id; storyboard.approved_shot_snapshots[0].order = 99; saveStoryboardPackage(db, storyboard); db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.PACKAGE_SNAPSHOT_MISMATCH, 1);
    } finally { fixture.cleanup(); }
  });
});

test("full database rowset fingerprints capture timestamp and relationship drift", async (t) => {
  type TestDb = ReturnType<typeof openM0DatabaseConnection>;
  type RowsetCase = {
    name: string;
    prepare?: (db: TestDb, fixture: Fixture) => void;
    mutate: (db: TestDb, fixture: Fixture) => void;
  };
  const cases: RowsetCase[] = [
    {
      name: "project updated_at",
      mutate: (db, fixture) => { db.prepare("UPDATE projects SET updated_at = ? WHERE project_id = ?").run("2000-01-01T00:00:00.000Z", fixture.project_id); }
    },
    {
      name: "workbench_project_meta updated_at",
      mutate: (db, fixture) => { db.prepare("UPDATE workbench_project_meta SET updated_at = ? WHERE project_id = ?").run("2000-01-01T00:00:00.000Z", fixture.project_id); }
    },
    {
      name: "shot updated_at",
      mutate: (db, fixture) => { db.prepare("UPDATE shots SET updated_at = ? WHERE shot_id = ?").run("2000-01-01T00:00:00.000Z", fixture.shot_id); }
    },
    {
      name: "storyboard package updated_at",
      mutate: (db, fixture) => { db.prepare("UPDATE storyboard_packages SET updated_at = ? WHERE storyboard_package_id = ?").run("2000-01-01T00:00:00.000Z", fixture.package_id); }
    },
    {
      name: "media artifact updated_at",
      mutate: (db, fixture) => { db.prepare("UPDATE media_artifacts SET updated_at = ? WHERE artifact_id = ?").run("2000-01-01T00:00:00.000Z", fixture.artifact_id); }
    },
    {
      name: "artifact blob link created_at",
      mutate: (db, fixture) => { db.prepare("UPDATE media_artifact_blobs SET created_at = ? WHERE artifact_id = ?").run("2000-01-01T00:00:00.000Z", fixture.artifact_id); }
    },
    {
      name: "generation intent updated_at",
      prepare: (db, fixture) => {
        db.prepare(`INSERT INTO generation_intents
          (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
           duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
           confirmed, expires_at, status)
          VALUES (?, ?, ?, 'runninghub', 'primary', 'model', ?, 6, '720x1280', 1, 1, 'USD', 0, '2099-01-01', 'prepared')`)
          .run("intent_rowset", fixture.project_id, fixture.shot_id, fixture.artifact_id);
      },
      mutate: (db) => { db.prepare("UPDATE generation_intents SET updated_at = ? WHERE intent_id = ?").run("2000-01-01T00:00:00.000Z", "intent_rowset"); }
    },
    {
      name: "generation job updated_at",
      prepare: (db, fixture) => {
        db.prepare(`INSERT INTO generation_intents
          (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
           duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
           confirmed, expires_at, status)
          VALUES (?, ?, ?, 'runninghub', 'primary', 'model', ?, 6, '720x1280', 1, 1, 'USD', 0, '2099-01-01', 'prepared')`)
          .run("intent_job_rowset", fixture.project_id, fixture.shot_id, fixture.artifact_id);
        db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES (?, ?, 'queued')")
          .run("job_rowset", "intent_job_rowset");
      },
      mutate: (db) => { db.prepare("UPDATE generation_jobs SET updated_at = ? WHERE job_id = ?").run("2000-01-01T00:00:00.000Z", "job_rowset"); }
    },
    {
      name: "generation run updated_at",
      prepare: (db, fixture) => {
        db.prepare(`INSERT INTO generation_runs
          (run_id, batch_id, project_id, shot_id, run_type, status, data_json)
          VALUES (?, NULL, ?, ?, 'provider', 'succeeded', '{}')`)
          .run("run_rowset", fixture.project_id, fixture.shot_id);
      },
      mutate: (db) => { db.prepare("UPDATE generation_runs SET updated_at = ? WHERE run_id = ?").run("2000-01-01T00:00:00.000Z", "run_rowset"); }
    },
    {
      name: "new media blob row",
      mutate: (db) => {
        db.prepare(`INSERT INTO media_blobs
          (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
          VALUES (?, '', 0, '', '', 'unverified', '{}')`)
          .run(`blob_${randomUUID()}`);
      }
    }
  ];

  for (const rowsetCase of cases) {
    await t.test(rowsetCase.name, async () => {
      const fixture = createFixture();
      try {
        const setupDb = openM0DatabaseConnection(fixture.paths.sqlitePath);
        rowsetCase.prepare?.(setupDb, fixture);
        setupDb.close();
        const result = await scan(fixture, { betweenSnapshots: () => {
          const driftDb = openM0DatabaseConnection(fixture.paths.sqlitePath);
          try { rowsetCase.mutate(driftDb, fixture); } finally { driftDb.close(); }
        } });
        assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
        assert.equal(result.candidate_alias, undefined);
        const encoded = JSON.stringify(result);
        assert.equal(encoded.includes(fixture.project_id), false);
        assert.equal(encoded.includes(fixture.shot_id), false);
        assert.equal(encoded.includes(fixture.artifact_id), false);
        assert.equal(encoded.includes("s3b-t2-rowset-"), false);
      } finally { fixture.cleanup(); }
    });
  }
});

test("global active intent blocks all candidates and multiple candidates do not disclose aliases", async () => {
  const first = createFixture();
  try {
    const db = openM0DatabaseConnection(first.paths.sqlitePath);
    db.prepare(`INSERT INTO generation_intents
      (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id, duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency, confirmed, expires_at, status)
      VALUES ('intent_active', ?, ?, 'runninghub', 'primary', 'model', ?, 6, '480p', 1, 1, 'USD', 1, '2099-01-01', 'queued')`)
      .run(first.project_id, first.shot_id, first.artifact_id);
    db.close();
    const blocked = await scan(first);
    assert.equal(blocked.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
    assert.equal(blocked.candidate_alias, undefined);
    const runningDb = openM0DatabaseConnection(first.paths.sqlitePath);
    runningDb.prepare("UPDATE generation_intents SET status = 'running' WHERE intent_id = 'intent_active'").run();
    runningDb.close();
    const running = await scan(first);
    assert.equal(running.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
  } finally { first.cleanup(); }

  const fixture = createFixture();
  try {
    const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
    const project = createProject({ title: "Second", video_spec: { duration_seconds: 6, aspect_ratio: "9:16", resolution: "720x1280" } }, db);
    assert.equal(project.ok, true);
    if (!project.ok) return;
    const secondShot = `shot_${randomUUID()}`;
    db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(project.project_id);
    const art = addArtifact(db, fixture.paths, project.project_id, secondShot, "fixtures/storyboard/shot_002.png");
    const imported = importStoryboardPackage({ project_id: project.project_id, status: "approved_for_video_generation", approved_shot_snapshots: [{ shot_id: secondShot, order: 1, duration_seconds: 6, storyboard_image_artifact_id: art.artifactId, video_prompt: "Second", negative_prompt: "" }], user_approval: { storyboard_approved: true } }, db);
    assert.equal(imported.ok, true);
    const secondProject = getProject(db, project.project_id)!; secondProject.status = "storyboard_approved"; saveProject(db, secondProject);
    db.close();
    const result = await scan(fixture);
    assert.equal(result.result, "S3_MULTIPLE_ELIGIBLE_SHOTS");
    assert.equal(result.eligible_candidate_count, 2);
    assert.equal(result.candidate_alias, undefined);
  } finally { fixture.cleanup(); }
});

test("started generation jobs and runs preserve the started reason without an active intent", async (t) => {
  for (const state of ["queued", "submitting", "polling", "downloading", "finalizing", "succeeded", "cancelled"] as const) {
    await t.test(`generation job ${state}`, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        db.prepare(`INSERT INTO generation_intents
          (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
           duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
           confirmed, expires_at, status)
          VALUES (?, ?, ?, 'runninghub', 'primary', 'model', ?, 6, '720x1280', 1, 1, 'USD', 1, '2099-01-01', 'succeeded')`)
          .run(`intent_${state}`, fixture.project_id, fixture.shot_id, fixture.artifact_id);
        db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES (?, ?, ?)")
          .run(`job_${state}`, `intent_${state}`, state);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, 1);
        assert.equal(result.reason_code_counts.SHOT_OPERATIONAL_STATE_INELIGIBLE, undefined);
      } finally { fixture.cleanup(); }
    });
  }

  for (const status of ["queued", "running", "succeeded", "cancelled"] as const) {
    await t.test(`latest generation run ${status}`, async () => {
      const fixture = createFixture();
      try {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        db.prepare(`INSERT INTO generation_runs
          (run_id, batch_id, project_id, shot_id, run_type, status, data_json)
          VALUES (?, NULL, ?, ?, 'initial', ?, '{}')`)
          .run(`run_${status}`, fixture.project_id, fixture.shot_id, status);
        db.close();
        const result = await scan(fixture);
        assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, 1);
        assert.equal(result.reason_code_counts.SHOT_OPERATIONAL_STATE_INELIGIBLE, undefined);
      } finally { fixture.cleanup(); }
    });
  }

  await t.test("active intent takes precedence over terminal history", async () => {
    const fixture = createFixture();
    try {
      const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
      db.prepare(`INSERT INTO generation_runs
        (run_id, batch_id, project_id, shot_id, run_type, status, data_json)
        VALUES ('run_terminal_with_active_intent', NULL, ?, ?, 'initial', 'succeeded', '{}')`)
        .run(fixture.project_id, fixture.shot_id);
      db.prepare(`INSERT INTO generation_intents
        (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id,
         duration_seconds, resolution, estimated_cost_value, budget_limit_value, currency,
         confirmed, expires_at, status)
        VALUES ('intent_active_terminal_history', ?, ?, 'runninghub', 'primary', 'model', ?, 6, '720x1280', 1, 1, 'USD', 1, '2099-01-01', 'running')`)
        .run(fixture.project_id, fixture.shot_id, fixture.artifact_id);
      db.close();
      const result = await scan(fixture);
      assert.equal(result.reason_code_counts.REAL_GENERATION_ALREADY_ACTIVE, 1);
      assert.equal(result.reason_code_counts.GENERATION_ALREADY_STARTED, undefined);
    } finally { fixture.cleanup(); }
  });
});

test("database path substitution and state or byte drift fail closed without retry", async (t) => {
  await t.test("database symlink substitute", async () => {
    const fixture = createFixture();
    try {
      const unsafeRoot = mkdtempSync(join(tmpdir(), "s3b-t2-link-"));
      const unsafePaths = { ...fixture.paths, sqlitePath: join(unsafeRoot, "linked.sqlite") };
      try {
        // Windows file symlink creation can require privileges; a hard link is still caught by the data-root boundary.
        const { linkSync } = await import("node:fs");
        linkSync(fixture.paths.sqlitePath, unsafePaths.sqlitePath);
        assert.equal(lstatSync(unsafePaths.sqlitePath).isFile(), true);
        const result = await scanS3bT2Eligibility({ paths: unsafePaths });
        assert.equal(result.result, "T2_READ_ONLY_BOUNDARY_VIOLATION");
      } finally { rmSync(unsafeRoot, { recursive: true, force: true }); }
    } finally { fixture.cleanup(); }
  });
  await t.test("database state drift", async () => {
    const fixture = createFixture();
    try {
      const result = await scan(fixture, { betweenSnapshots: () => {
        const db = openM0DatabaseConnection(fixture.paths.sqlitePath);
        db.prepare("UPDATE projects SET updated_at = '2099-01-01' WHERE project_id = ?").run(fixture.project_id);
        const row = db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(fixture.shot_id) as { data_json: string };
        const shot = JSON.parse(row.data_json); shot.description = "concurrent"; saveShot(db, shot); db.close();
      } });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
    } finally { fixture.cleanup(); }
  });
  await t.test("database identity replacement", async () => {
    const fixture = createFixture();
    try {
      const replacement = join(fixture.paths.dataRoot, "replacement.sqlite");
      const previous = join(fixture.paths.dataRoot, "previous.sqlite");
      copyFileSync(fixture.paths.sqlitePath, replacement);
      const result = await scan(fixture, { betweenSnapshots: () => {
        renameSync(fixture.paths.sqlitePath, previous);
        renameSync(replacement, fixture.paths.sqlitePath);
      } });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
    } finally { fixture.cleanup(); }
  });
  await t.test("media byte drift", async () => {
    const fixture = createFixture();
    try {
      const result = await scan(fixture, { betweenSnapshots: () => writeFileSync(fixture.media_path, Buffer.from("drift")) });
      assert.equal(result.result, "T2_STATE_CHANGED_DURING_SCAN");
    } finally { fixture.cleanup(); }
  });
});

test("scanner performs no network calls or credential environment reads", async () => {
  const fixture = createFixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => { calls += 1; throw new Error("network forbidden"); }) as typeof fetch;
  try {
    const result = await scan(fixture);
    assert.equal(result.result, "PASS_ONE_ELIGIBLE_SHOT");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; fixture.cleanup(); }
});
