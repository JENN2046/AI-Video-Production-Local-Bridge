import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { callM0ToolPlaceholder, listM0Tools, listTables, openM0Database, paths } from "../src/index.js";
import { DATABASE_MIGRATIONS } from "../src/storage/migrations.js";
import { WORKBENCH_V2_SCHEMA_VERSION } from "../src/storage/workbenchV2Schema.js";
import { WEBGPT_V4_VERSION } from "../src/webgpt-v4/types.js";

test("beta.5 MCP App closeout reports consistent package, service, schema, and migration identities", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { version: string; packages: { "": { version: string } } };
  const readme = readFileSync("README.md", "utf8");
  const currentState = readFileSync("CURRENT_STATE.md", "utf8");

  assert.equal(packageJson.version, "0.1.0-beta.5");
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.equal(WEBGPT_V4_VERSION, "webgpt-v4.3.0");
  assert.equal(WORKBENCH_V2_SCHEMA_VERSION, "workbench-v2-6");
  assert.equal(DATABASE_MIGRATIONS.at(-1)?.id, "0010");
  for (const document of [readme, currentState]) {
    assert.match(document, /0\.1\.0-beta\.5/);
    assert.match(document, /webgpt-v4\.3\.0/);
    assert.match(document, /JENN_SINGLE_USER_MCP_APP_PASS/);
    assert.match(document, /MANUAL_PUBLISH_OPERATIONAL_READY/);
    assert.match(document, /PARTIAL_MULTI_USER_GATE/);
  }
});

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
