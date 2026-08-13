import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildStoryboardApprovedShot,
  closeoutWorkbenchDelivery,
  createProject,
  decideWorkbenchFinalReview,
  getMediaArtifact,
  getProject,
  interruptUnfinishedWorkbenchDeliveryJobs,
  listWorkbenchFinalVersions,
  openM0Database,
  paths,
  queueWorkbenchExport,
  registerMediaArtifact,
  resolveWorkbenchExportDownload,
  runWorkbenchExportJob,
  saveProject,
  saveShot,
  type MediaArtifact,
  type Project,
  type Shot
} from "../src/index.js";
import { handleWorkbenchV2Api } from "../src/http/workbenchV2Routes.js";
import type { M0Database } from "../src/storage/sqlite.js";
import { assertWorkbenchProjectWritable, decideWorkbenchClip, getWorkbenchProjectWorkspace } from "../src/tools/workbenchV2.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function createVideo(name: string, dimensions = "320x180", withAudio = true): string {
  const directory = resolve(paths.mediaRoot, ".delivery-actions-test-inputs");
  mkdirSync(directory, { recursive: true });
  const output = resolve(directory, `${name}_${randomUUID()}.mp4`);
  const color = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 6);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x${color}:s=${dimensions}:r=30:d=1`];
  if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=1", "-shortest");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-ar", "48000", "-ac", "2");
  else args.push("-an");
  args.push("-metadata", `comment=delivery-actions-${randomUUID()}`, output);
  const result = spawnSync(FFMPEG, args, { stdio: "ignore", windowsHide: true });
  assert.equal(result.status, 0, "FFmpeg delivery fixture creation should succeed");
  return output;
}

function attachAcceptedClip(db: M0Database, project: Project, order: number): { shot: Shot; artifact: MediaArtifact } {
  const shot = buildStoryboardApprovedShot({
    project_id: project.project_id,
    order,
    duration_seconds: 1,
    storyboard_image_artifact_id: "",
    video_prompt: `Delivery SHOT ${order}`
  });
  const registered = registerMediaArtifact({
    artifact_type: "video",
    role: "generated_clip",
    source: { kind: "provider_output_file", path: createVideo(`clip-${order}`), mime_type: "video/mp4" },
    linked_objects: { project_id: project.project_id, shot_id: shot.shot_id },
    metadata: { width: 320, height: 180, aspect_ratio: "16:9", duration_seconds: 1 },
    provenance: { provider: "mock", provider_job_id: `delivery_fixture_${randomUUID()}` }
  }, db);
  if (!registered.ok) throw new Error(`${registered.error.code}: ${registered.error.message}`);
  shot.accepted_clip_artifact_id = registered.artifact.artifact_id;
  shot.clip_versions = [{ artifact_id: registered.artifact.artifact_id, run_id: `run_${randomUUID()}`, attempt_number: 1, review_status: "approved" }];
  shot.status = "approved";
  shot.review.approval_status = "approved";
  saveShot(db, shot);
  project.shot_ids.push(shot.shot_id);
  saveProject(db, project);
  return { shot, artifact: registered.artifact };
}

function setupFinalReviewProject(db: M0Database, shotCount = 2): { project: Project; shots: Shot[]; clips: MediaArtifact[]; final: MediaArtifact } {
  const created = createProject({
    title: `Delivery ${randomUUID().slice(0, 8)}`,
    video_spec: { duration_seconds: shotCount, aspect_ratio: "16:9", resolution: "320x180" }
  }, db);
  if (!created.ok) throw new Error(created.error.message);
  const project = created.project;
  const pairs = Array.from({ length: shotCount }, (_, index) => attachAcceptedClip(db, project, index + 1));
  const finalRegistered = registerMediaArtifact({
    artifact_type: "video",
    role: "final_video",
    source: { kind: "provider_output_file", path: createVideo("final"), mime_type: "video/mp4" },
    linked_objects: { project_id: project.project_id, shot_id: "" },
    metadata: { width: 320, height: 180, aspect_ratio: "16:9", duration_seconds: 1 },
    provenance: { provider: "local_assembly", provider_job_id: `assembly_fixture_${randomUUID()}` }
  }, db);
  if (!finalRegistered.ok) throw new Error(`${finalRegistered.error.code}: ${finalRegistered.error.message}`);
  project.exports.final_video_artifact_id = finalRegistered.artifact.artifact_id;
  project.status = "video_review";
  saveProject(db, project);
  const timestamp = new Date().toISOString();
  db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'ready_to_assemble', updated_at = ? WHERE project_id = ?").run(timestamp, project.project_id);
  db.prepare("UPDATE workbench_delivery_state SET workflow_state = 'assembling', assembly_input_fingerprint = ?, updated_at = ? WHERE project_id = ?")
    .run("a".repeat(64), timestamp, project.project_id);
  db.prepare(`UPDATE workbench_delivery_state SET workflow_state = 'final_review', current_final_artifact_id = ?, updated_at = ? WHERE project_id = ?`)
    .run(finalRegistered.artifact.artifact_id, timestamp, project.project_id);
  return { project, shots: pairs.map((pair) => pair.shot), clips: pairs.map((pair) => pair.artifact), final: finalRegistered.artifact };
}

function acceptFinal(db: M0Database, fixture: ReturnType<typeof setupFinalReviewProject>) {
  const accepted = decideWorkbenchFinalReview({
    project_id: fixture.project.project_id,
    artifact_id: fixture.final.artifact_id,
    decision: "accept",
    human_confirmation: true
  }, db);
  assert.equal(accepted.ok, true);
  return accepted;
}

test("final review accepts, reassembles, and targets only selected SHOTs while preserving old versions", () => {
  const db = openM0Database();
  try {
    const acceptedFixture = setupFinalReviewProject(db, 2);
    const stale = decideWorkbenchFinalReview({
      project_id: acceptedFixture.project.project_id,
      artifact_id: "artifact_stale",
      decision: "accept",
      human_confirmation: true
    }, db);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "FINAL_REVIEW_ARTIFACT_STALE");
    const bypass = decideWorkbenchClip(acceptedFixture.project.project_id, {
      shot_id: acceptedFixture.shots[0].shot_id,
      artifact_id: acceptedFixture.clips[0].artifact_id,
      decision: "revision_needed",
      rejection_reasons: ["Must use final review"],
      revision_instruction: { summary: "Must use final review", prompt_delta: "", negative_delta: "", priority: "high" }
    }, db);
    assert.equal(bypass.ok, false);
    if (!bypass.ok) assert.equal(bypass.error.code, "FINAL_REVIEW_REQUIRED");
    acceptFinal(db, acceptedFixture);
    assert.equal((db.prepare("SELECT workflow_state, approved_artifact_id FROM workbench_delivery_state WHERE project_id = ?")
      .get(acceptedFixture.project.project_id) as { workflow_state: string; approved_artifact_id: string }).workflow_state, "approved");
    assert.equal(getProject(db, acceptedFixture.project.project_id)?.status, "video_review");

    const reassembleFixture = setupFinalReviewProject(db, 2);
    const beforePointers = reassembleFixture.shots.map((shot) => shot.accepted_clip_artifact_id);
    const reassembled = decideWorkbenchFinalReview({
      project_id: reassembleFixture.project.project_id,
      artifact_id: reassembleFixture.final.artifact_id,
      decision: "reassemble",
      human_confirmation: true
    }, db);
    assert.equal(reassembled.ok, true);
    assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?").get(reassembleFixture.project.project_id) as { workflow_state: string }).workflow_state, "ready_to_assemble");
    assert.deepEqual(reassembleFixture.shots.map((shot) => (db.prepare("SELECT json_extract(data_json, '$.accepted_clip_artifact_id') AS id FROM shots WHERE shot_id = ?").get(shot.shot_id) as { id: string }).id), beforePointers);

    const targetedFixture = setupFinalReviewProject(db, 2);
    const noSelection = decideWorkbenchFinalReview({
      project_id: targetedFixture.project.project_id,
      artifact_id: targetedFixture.final.artifact_id,
      decision: "regenerate_shots",
      shot_ids: [],
      human_confirmation: true
    }, db);
    assert.equal(noSelection.ok, false);
    if (!noSelection.ok) assert.equal(noSelection.error.code, "FINAL_REWORK_SELECTION_REQUIRED");
    const targeted = decideWorkbenchFinalReview({
      project_id: targetedFixture.project.project_id,
      artifact_id: targetedFixture.final.artifact_id,
      decision: "regenerate_shots",
      shot_ids: [targetedFixture.shots[0].shot_id],
      reason: "First SHOT motion is discontinuous.",
      human_confirmation: true
    }, db);
    assert.equal(targeted.ok, true);
    if (!targeted.ok) return;
    assert.equal(targeted.data.regeneration_requests.length, 1);
    const first = JSON.parse((db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(targetedFixture.shots[0].shot_id) as { data_json: string }).data_json) as Shot;
    const second = JSON.parse((db.prepare("SELECT data_json FROM shots WHERE shot_id = ?").get(targetedFixture.shots[1].shot_id) as { data_json: string }).data_json) as Shot;
    assert.equal(first.accepted_clip_artifact_id, "");
    assert.equal(first.status, "revision_needed");
    assert.equal(second.accepted_clip_artifact_id, targetedFixture.clips[1].artifact_id);
    assert.equal((db.prepare("SELECT workflow_state, current_final_artifact_id FROM workbench_delivery_state WHERE project_id = ?")
      .get(targetedFixture.project.project_id) as { workflow_state: string; current_final_artifact_id: string }).workflow_state, "revision_requested");
    assert.equal(listWorkbenchFinalVersions(db, targetedFixture.project.project_id).some((version) => version.artifact_id === targetedFixture.final.artifact_id), true);
    assert.equal(getMediaArtifact(db, targetedFixture.final.artifact_id)?.status, "active");
  } finally {
    db.close();
  }
});

test("export is persistent, exclusive, idempotent, drift-aware, and leaves state unchanged on failure", async () => {
  const db = openM0Database();
  try {
    const fixture = setupFinalReviewProject(db, 1);
    acceptFinal(db, fixture);
    const sourceHash = sha256(fixture.final.storage.uri);
    const queued = queueWorkbenchExport({ project_id: fixture.project.project_id, artifact_id: fixture.final.artifact_id, human_confirmation: true }, db);
    assert.equal(queued.ok, true);
    if (!queued.ok || !queued.data.job) return;
    assert.equal(queued.data.reused, false);
    assert.equal("input_json" in queued.data.job, false);
    const completed = await runWorkbenchExportJob(queued.data.job.job_id, db);
    assert.equal(completed.ok, true);
    if (!completed.ok) return;
    assert.match(completed.data.export.relative_path, new RegExp(`^data/exports/${fixture.project.project_id}/${fixture.project.project_id}_[0-9TZ]+_[A-Za-z0-9]{8}\\.mp4$`));
    const location = resolve(paths.exportsRoot, fixture.project.project_id, basename(completed.data.export.relative_path));
    assert.equal(existsSync(location), true);
    assert.equal(sha256(location), completed.data.export.sha256);
    assert.equal(sha256(fixture.final.storage.uri), sourceHash);
    assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?").get(fixture.project.project_id) as { workflow_state: string }).workflow_state, "exported");

    const reused = queueWorkbenchExport({ project_id: fixture.project.project_id, artifact_id: fixture.final.artifact_id, human_confirmation: true }, db);
    assert.equal(reused.ok, true);
    if (reused.ok) {
      assert.equal(reused.data.reused, true);
      assert.equal(reused.data.export?.export_id, completed.data.export.export_id);
      assert.equal(reused.data.job, null);
    }

    writeFileSync(location, "export drift", "utf8");
    const mismatchedCloseout = closeoutWorkbenchDelivery({ project_id: fixture.project.project_id, confirmation_phrase: "确认结案" }, db);
    assert.equal(mismatchedCloseout.ok, false);
    if (!mismatchedCloseout.ok) assert.equal(mismatchedCloseout.error.code, "CLOSEOUT_EXPORT_MISMATCH");
    const replacement = queueWorkbenchExport({ project_id: fixture.project.project_id, artifact_id: fixture.final.artifact_id, human_confirmation: true }, db);
    assert.equal(replacement.ok, true);
    if (!replacement.ok || !replacement.data.job) return;
    assert.equal(replacement.data.reused, false);
    const replacementCompleted = await runWorkbenchExportJob(replacement.data.job.job_id, db);
    assert.equal(replacementCompleted.ok, true);
    if (replacementCompleted.ok) assert.notEqual(replacementCompleted.data.export.export_id, completed.data.export.export_id);

    const failedFixture = setupFinalReviewProject(db, 1);
    acceptFinal(db, failedFixture);
    const failedQueue = queueWorkbenchExport({ project_id: failedFixture.project.project_id, artifact_id: failedFixture.final.artifact_id, human_confirmation: true }, db);
    assert.equal(failedQueue.ok, true);
    if (!failedQueue.ok || !failedQueue.data.job) return;
    const failed = await runWorkbenchExportJob(failedQueue.data.job.job_id, db, {
      after_export_copy: (partPath) => writeFileSync(partPath, "tampered", "utf8")
    });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error.code, "EXPORT_INTEGRITY_FAILED");
    assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?").get(failedFixture.project.project_id) as { workflow_state: string }).workflow_state, "approved");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workbench_exports WHERE project_id = ?").get(failedFixture.project.project_id) as { count: number }).count, 0);

    const occupiedFixture = setupFinalReviewProject(db, 1);
    acceptFinal(db, occupiedFixture);
    const occupiedQueue = queueWorkbenchExport({ project_id: occupiedFixture.project.project_id, artifact_id: occupiedFixture.final.artifact_id, human_confirmation: true }, db);
    assert.equal(occupiedQueue.ok, true);
    if (!occupiedQueue.ok || !occupiedQueue.data.job) return;
    const input = JSON.parse((db.prepare("SELECT input_json FROM workbench_delivery_jobs WHERE job_id = ?").get(occupiedQueue.data.job.job_id) as { input_json: string }).input_json) as { relative_path: string };
    const occupiedPath = resolve(paths.exportsRoot, occupiedFixture.project.project_id, basename(input.relative_path));
    mkdirSync(resolve(paths.exportsRoot, occupiedFixture.project.project_id), { recursive: true });
    const sentinel = Buffer.from("do-not-overwrite", "utf8");
    writeFileSync(occupiedPath, sentinel, { flag: "wx" });
    const occupied = await runWorkbenchExportJob(occupiedQueue.data.job.job_id, db);
    assert.equal(occupied.ok, false);
    assert.equal(readFileSync(occupiedPath).equals(sentinel), true);
  } finally {
    db.close();
  }
});

test("export restart recovery removes only Job-owned staging and never auto-resumes", () => {
  const db = openM0Database();
  try {
    const fixture = setupFinalReviewProject(db, 1);
    acceptFinal(db, fixture);
    const queued = queueWorkbenchExport({ project_id: fixture.project.project_id, artifact_id: fixture.final.artifact_id, human_confirmation: true }, db);
    assert.equal(queued.ok, true);
    if (!queued.ok || !queued.data.job) return;
    const snapshot = JSON.parse((db.prepare("SELECT input_json FROM workbench_delivery_jobs WHERE job_id = ?").get(queued.data.job.job_id) as { input_json: string }).input_json) as { relative_path: string };
    const part = `${resolve(paths.exportsRoot, fixture.project.project_id, basename(snapshot.relative_path))}.part`;
    mkdirSync(resolve(paths.exportsRoot, fixture.project.project_id), { recursive: true });
    writeFileSync(part, "partial export", { flag: "wx" });
    const recovered = interruptUnfinishedWorkbenchDeliveryJobs(db);
    assert.deepEqual(recovered, { interrupted: 1, staging_cleanup_failed: 0 });
    assert.equal(existsSync(part), false);
    const job = db.prepare("SELECT state, error_code FROM workbench_delivery_jobs WHERE job_id = ?").get(queued.data.job.job_id) as { state: string; error_code: string };
    assert.equal(job.state, "interrupted");
    assert.equal(job.error_code, "PROCESS_RESTART");
    assert.equal((db.prepare("SELECT workflow_state FROM workbench_delivery_state WHERE project_id = ?").get(fixture.project.project_id) as { workflow_state: string }).workflow_state, "approved");
  } finally {
    db.close();
  }
});

test("closeout requires exact phrase and matching export, then closes every production write", async () => {
  const db = openM0Database();
  try {
    const fixture = setupFinalReviewProject(db, 1);
    acceptFinal(db, fixture);
    const queued = queueWorkbenchExport({ project_id: fixture.project.project_id, artifact_id: fixture.final.artifact_id, human_confirmation: true }, db);
    assert.equal(queued.ok, true);
    if (!queued.ok || !queued.data.job) return;
    const exported = await runWorkbenchExportJob(queued.data.job.job_id, db);
    assert.equal(exported.ok, true);
    if (!exported.ok) return;
    const wrong = closeoutWorkbenchDelivery({ project_id: fixture.project.project_id, confirmation_phrase: "确认" }, db);
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.error.code, "CLOSEOUT_CONFIRMATION_REQUIRED");
    const closed = closeoutWorkbenchDelivery({ project_id: fixture.project.project_id, confirmation_phrase: "确认结案" }, db);
    assert.equal(closed.ok, true);
    if (!closed.ok) return;
    assert.equal(closed.data.delivery.workflow_state, "closed");
    assert.equal(closed.data.receipt.export_id, exported.data.export.export_id);
    assert.equal(getProject(db, fixture.project.project_id)?.status, "final_approved");
    const writable = assertWorkbenchProjectWritable(db, fixture.project.project_id);
    assert.equal(writable.ok, false);
    if (!writable.ok) assert.equal(writable.error.code, "PROJECT_CLOSED");
    const repeated = closeoutWorkbenchDelivery({ project_id: fixture.project.project_id, confirmation_phrase: "确认结案" }, db);
    assert.equal(repeated.ok, false);
    if (!repeated.ok) assert.equal(repeated.error.code, "PROJECT_CLOSED");
  } finally {
    db.close();
  }
});

test("delivery HTTP flow exposes sanitized DTOs and serves only verified export bytes", async (t) => {
  const db = openM0Database();
  const nonce = `delivery-nonce-${randomUUID()}`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    void handleWorkbenchV2Api(request, response, url, nonce).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  try {
    const fixture = setupFinalReviewProject(db, 1);
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const root = `${base}/api/v2/projects/${encodeURIComponent(fixture.project.project_id)}/delivery`;
    const headers = { "content-type": "application/json", "x-h1-action-nonce": nonce };
    const accepted = await fetch(`${root}/final-review`, { method: "POST", headers, body: JSON.stringify({ artifact_id: fixture.final.artifact_id, decision: "accept", human_confirmation: true }) });
    assert.equal(accepted.status, 200);
    const started = await fetch(`${root}/export`, { method: "POST", headers, body: JSON.stringify({ artifact_id: fixture.final.artifact_id, human_confirmation: true }) });
    assert.equal(started.status, 202);
    const startedBody = await started.json() as { ok: true; data: { job: { job_id: string } } };
    const deadline = Date.now() + 20_000;
    let state = "queued";
    while (Date.now() < deadline) {
      state = (db.prepare("SELECT state FROM workbench_delivery_jobs WHERE job_id = ?").get(startedBody.data.job.job_id) as { state: string } | undefined)?.state ?? "missing";
      if (new Set(["succeeded", "failed", "interrupted"]).has(state)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.equal(state, "succeeded");
    const workspaceResponse = await fetch(`${base}/api/v2/projects/${encodeURIComponent(fixture.project.project_id)}/delivery`);
    const workspace = await workspaceResponse.json() as { ok: true; data: Record<string, unknown> & { latest_export: { export_id: string; relative_path: string } } };
    assert.equal(workspaceResponse.status, 200);
    assert.equal(JSON.stringify(workspace).includes(resolve(paths.dataRoot)), false);
    assert.match(workspace.data.latest_export.relative_path, /^data\/exports\//);
    assert.equal(Array.isArray(workspace.data.final_versions), true);
    assert.equal(Object.hasOwn(workspace.data, "current_final_version"), true);
    const file = await fetch(`${root}/exports/${encodeURIComponent(workspace.data.latest_export.export_id)}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "video/mp4");
    assert.equal((await file.arrayBuffer()).byteLength > 0, true);
    const closed = await fetch(`${root}/closeout`, { method: "POST", headers, body: JSON.stringify({ confirmation_phrase: "确认结案" }) });
    assert.equal(closed.status, 200);
    const after = getWorkbenchProjectWorkspace(fixture.project.project_id, "delivery", db);
    assert.equal(after.ok, true);
    if (after.ok) assert.equal(after.data.workflow_state, "closed");
    const download = resolveWorkbenchExportDownload(fixture.project.project_id, workspace.data.latest_export.export_id, db);
    assert.equal(download.ok, true);
  } finally {
    db.close();
  }
});
