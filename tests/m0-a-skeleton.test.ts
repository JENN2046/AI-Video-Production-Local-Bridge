import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { callM0ToolPlaceholder, listM0Tools, listTables, openM0Database, paths } from "../src/index.js";

test("M0-A initializes SQLite metadata storage", () => {
  const db = openM0Database();

  try {
    const tables = listTables(db);
    assert.equal(existsSync(paths.sqlitePath), true);
    assert.deepEqual(
      [
        "generation_batches",
        "generation_runs",
        "m0_meta",
        "media_artifacts",
        "projects",
        "shots",
        "storyboard_packages"
      ].every((table) => tables.includes(table)),
      true
    );
  } finally {
    db.close();
  }
});

test("M0-A creates app-controlled media and report directories", () => {
  openM0Database().close();

  assert.equal(existsSync(paths.imageArtifactsRoot), true);
  assert.equal(existsSync(paths.videoArtifactsRoot), true);
  assert.equal(existsSync(paths.finalArtifactsRoot), true);
  assert.equal(existsSync(paths.reportsRoot), true);
});

test("M0-A registers the stable nine-tool interface", () => {
  assert.deepEqual(
    listM0Tools().map((tool) => tool.name),
    [
      "create_project",
      "get_project_status",
      "register_media_artifact",
      "import_storyboard_package",
      "start_storyboard_video_generation",
      "get_generation_status",
      "mark_shot_clip_review",
      "regenerate_shot_video",
      "assemble_final_video"
    ]
  );
});

test("M0-A placeholders fail explicitly instead of pretending success", () => {
  assert.deepEqual(callM0ToolPlaceholder("assemble_final_video"), {
    ok: false,
    error: {
      code: "M0_TOOL_NOT_IMPLEMENTED",
      message: "assemble_final_video is registered but not implemented in the M0-A skeleton."
    }
  });

  assert.equal(callM0ToolPlaceholder("not_a_tool").error?.code, "UNKNOWN_TOOL");
});
