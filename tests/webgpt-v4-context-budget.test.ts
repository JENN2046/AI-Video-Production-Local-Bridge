import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { openM0Database } from "../src/storage/sqlite.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { registerMediaArtifact } from "../src/tools/mediaArtifacts.js";
import { startWebGptV4 } from "../src/webgpt-v4/server.js";
import { actorFromSubject, WEBGPT_V4_SCOPES } from "../src/webgpt-v4/types.js";

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

test("compact context is materially smaller, paginated, bounded, and does not duplicate business JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-v4-budget-"));
  const sqlitePath = join(root, "app.sqlite");
  const dataRoot = join(root, "data");
  mkdirSync(join(dataRoot, "webgpt"), { recursive: true });
  const db = openM0Database(sqlitePath);
  const created = createProject({ title: "Canonical large production" }, db);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("fixture setup failed");
  db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
  const shots: Shot[] = [];
  for (let index = 0; index < 100; index += 1) {
    const shot: Shot = {
      shot_id: `shot_budget_${String(index).padStart(3, "0")}`, project_id: created.project_id, order: index + 1,
      status: "storyboard_approved", duration_seconds: 6, description: `SHOT ${index + 1}`,
      storyboard_image_artifact_id: "", video_prompt: `video-${"x".repeat(250)}`, negative_prompt: `negative-${"y".repeat(150)}`,
      generation_run_ids: [], accepted_clip_artifact_id: "", clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    saveShot(db, shot);
    shots.push(shot);
  }
  created.project.shot_ids = shots.map((shot) => shot.shot_id);
  saveProject(db, created.project);
  const largeImage = registerMediaArtifact({
    artifact_type: "image",
    role: "storyboard_image",
    source: { kind: "fixture_path", path: "provider-canary/m1-r0/shot_001_canary_720x1280.png" },
    linked_objects: { project_id: created.project_id, shot_id: shots[0].shot_id }
  }, db);
  assert.equal(largeImage.ok, true);
  if (!largeImage.ok) throw new Error("large image fixture failed");
  const insertNote = db.prepare(`INSERT INTO workbench_review_notes
    (note_id, project_id, shot_id, artifact_id, author_hash, note, source, created_at, updated_at)
    VALUES (?, ?, ?, '', 'fixture-author', ?, 'webgpt_v4', ?, ?)`);
  for (let index = 0; index < 60; index += 1) {
    const timestamp = `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`;
    insertNote.run(`note_budget_${index}`, created.project_id, shots[0].shot_id, `审片注记 ${index}`, timestamp, timestamp);
  }
  db.close();

  const actor = actorFromSubject("auth0|jenn", WEBGPT_V4_SCOPES);
  const runtime = await startWebGptV4({ profile: "full", mcp_port: 0, media_port: 0, sqlite_path: sqlitePath, data_root: dataRoot, authenticate: async () => actor });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url), { requestInit: { headers: { Authorization: "Bearer fixture" } } });
  const client = new Client({ name: "webgpt-v4-context-budget", version: "1.0.0" });
  try {
    await client.connect(transport);
    const compact = await client.callTool({ name: "list_project_shots", arguments: { project_id: created.project_id, detail: "compact", limit: 50 } });
    const full = await client.callTool({ name: "list_project_shots", arguments: { project_id: created.project_id, detail: "full", limit: 50 } });
    assert.equal(compact.isError, false, JSON.stringify(compact.structuredContent));
    assert.equal(full.isError, false, JSON.stringify(full.structuredContent));
    const compactBytes = bytes(compact.structuredContent);
    const fullBytes = bytes(full.structuredContent);
    assert.ok(compactBytes < fullBytes * 0.5, `compact=${compactBytes}, full=${fullBytes}`);
    assert.ok(bytes(compact.structuredContent) <= 128 * 1024);
    assert.ok(bytes(full.structuredContent) <= 128 * 1024);
    const compactJson = JSON.stringify(compact.structuredContent);
    for (const omitted of ["video_prompt", "negative_prompt", "clip_versions"]) assert.equal(compactJson.includes(`\"${omitted}\"`), false);
    assert.equal(compactJson.includes('"operational_state"'), true);
    assert.equal(compactJson.includes('"review"'), true);
    assert.equal(compactJson.includes('"rejection_reasons"'), false);
    const compactText = (compact.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
    assert.ok(Buffer.byteLength(compactText, "utf8") <= 1024);
    assert.equal(compactText.includes("video-"), false);

    const oversizedMedia = await client.callTool({ name: "inspect_media", arguments: { project_id: created.project_id, artifact_id: largeImage.artifact.artifact_id } });
    assert.equal(oversizedMedia.isError, true);
    const mediaBudget = (oversizedMedia.structuredContent as { error: { code: string; field: string } }).error;
    assert.deepEqual({ code: mediaBudget.code, field: mediaBudget.field }, { code: "RESPONSE_BUDGET_EXCEEDED", field: "content" });
    assert.equal((oversizedMedia.content as Array<{ type: string }>).some((item) => item.type === "image"), false);
    assert.ok(bytes({ structuredContent: oversizedMedia.structuredContent, content: oversizedMedia.content, _meta: oversizedMedia._meta }) <= 128 * 1024);

    const firstPage = await client.callTool({ name: "list_project_shots", arguments: { project_id: created.project_id, detail: "compact", limit: 20 } });
    const page = (firstPage.structuredContent as { data: { page: { next_offset: number | null } } }).data.page;
    assert.equal(page.next_offset, 20);

    const review = await client.callTool({ name: "get_review_package", arguments: { project_id: created.project_id, shot_id: shots[0].shot_id, detail: "compact" } });
    assert.equal(review.isError, false, JSON.stringify(review.structuredContent));
    const reviewData = (review.structuredContent as { data: { notes: unknown[]; notes_total: number } }).data;
    assert.equal(reviewData.notes.length, 10);
    assert.equal(reviewData.notes_total, 60);

    const mutate = openM0Database(sqlitePath);
    try {
      for (const shot of shots) {
        shot.video_prompt = "中文".repeat(4000);
        shot.negative_prompt = "边界".repeat(2000);
        saveShot(mutate, shot);
      }
    } finally {
      mutate.close();
    }
    const oversized = await client.callTool({ name: "list_project_shots", arguments: { project_id: created.project_id, detail: "full", limit: 100 } });
    assert.equal(oversized.isError, true);
    const error = (oversized.structuredContent as { error: { code: string; retryable: boolean; field: string; suggested_parameters: { detail: string } } }).error;
    assert.equal(error.code, "RESPONSE_BUDGET_EXCEEDED");
    assert.equal(error.retryable, false);
    assert.equal(error.field, "detail");
    assert.equal(error.suggested_parameters.detail, "compact");
    assert.ok(bytes(oversized.structuredContent) <= 128 * 1024);
    const recovered = await client.callTool({ name: "list_project_shots", arguments: { project_id: created.project_id, detail: "compact", limit: 100 } });
    assert.equal(recovered.isError, false, JSON.stringify(recovered.structuredContent));
  } finally {
    await client.close();
    await runtime.close();
    rmSync(largeImage.artifact.storage.uri, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
