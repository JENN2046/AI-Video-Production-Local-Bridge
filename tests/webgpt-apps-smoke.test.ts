import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { openM0Database } from "../src/storage/sqlite.js";
import { createProject, saveProject, saveShot, type Shot } from "../src/tools/projects.js";
import { bootstrapWebGptProjectOwner } from "../src/webgpt-v4/authorizationAdmin.js";
import { actorFromFederatedSubject, issuerHash } from "../src/webgpt-v4/types.js";
import { READONLY_WORKBENCH_MEDIA_TOOL, READONLY_WORKBENCH_RESOURCE_MIME, READONLY_WORKBENCH_RESOURCE_URI, READONLY_WORKBENCH_RENDER_TOOL } from "../src/webgpt-cloud/appContract.js";
import { exportReadonlySnapshotFromDatabase } from "../src/webgpt-cloud/dataSource.js";
import { startReadonlyRemoteRuntime } from "../src/webgpt-cloud/remoteRuntime.js";
import { signReadonlySnapshot } from "../src/webgpt-cloud/signedSnapshot.js";

const ISSUER = "https://auth.example.test/";
const RESOURCE = "https://aivideo.example.test/mcp";
const SUBJECT = "auth0|readonly-apps-smoke-owner";
const ACTOR = actorFromFederatedSubject(ISSUER, SUBJECT, ["projects.read"]);

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function fixtureSnapshot(root: string) {
  const sqlitePath = join(root, "app.sqlite");
  const db = openM0Database(sqlitePath);
  try {
    const created = createProject({ title: "Readonly Apps smoke fixture" }, db);
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("fixture project creation failed");
    db.prepare("UPDATE workbench_project_meta SET classification = 'production' WHERE project_id = ?").run(created.project_id);
    const shot: Shot = {
      shot_id: "shot_readonly_apps_smoke_001",
      project_id: created.project_id,
      order: 1,
      status: "storyboard_approved",
      duration_seconds: 6,
      description: "Readonly Apps smoke SHOT",
      storyboard_image_artifact_id: "",
      video_prompt: "Synthetic fixture prompt",
      negative_prompt: "",
      generation_run_ids: [],
      accepted_clip_artifact_id: "",
      clip_versions: [],
      review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null }
    };
    saveShot(db, shot);
    created.project.shot_ids = [shot.shot_id];
    saveProject(db, created.project);
    bootstrapWebGptProjectOwner(db, ACTOR.principal_id, created.project_id, "READONLY_APPS_SMOKE", ACTOR.issuer_hash!);
    return {
      project_id: created.project_id,
      shot_id: shot.shot_id,
      snapshot: exportReadonlySnapshotFromDatabase({
        database_path: sqlitePath,
        issuer_hash: ACTOR.issuer_hash!,
        resource_url: RESOURCE,
        generated_at: new Date(Date.now() - 1_000).toISOString(),
        ttl_seconds: 60 * 60
      })
    };
  } finally {
    db.close();
  }
}

test("Apps smoke discovers seven model-visible tools and one app-only media tool, reads the UI resource, and renders an empty authenticated shell", async () => {
  const root = mkdtempSync(join(tmpdir(), "readonly-apps-smoke-"));
  const fixture = fixtureSnapshot(root);
  const pair = generateKeyPairSync("ed25519");
  const runtime = await startReadonlyRemoteRuntime({
    port: 0,
    auth_config: {
      provider: "federated", access_model: "project_membership", issuer: ISSUER, issuer_hash: issuerHash(ISSUER),
      audience: RESOURCE, resource_url: RESOURCE, jwks_uri: "https://auth.example.test/.well-known/jwks.json",
      client_registration: "predefined", configuration_source: "generic"
    },
    authenticate: async () => ACTOR,
    publisher_key_id: "publisher-smoke-v1",
    publisher_public_key: pair.publicKey
  });
  const client = new Client({ name: "readonly-apps-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcp_url));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    assert.equal(tools.tools.some((tool) => tool.name === READONLY_WORKBENCH_RENDER_TOOL), true);
    const appOnly = tools.tools.find((tool) => tool.name === READONLY_WORKBENCH_MEDIA_TOOL);
    assert.ok(appOnly);
    assert.deepEqual((appOnly._meta as Record<string, unknown>).ui, { visibility: ["app"] });
    assert.equal(tools.tools.filter((tool) => (tool._meta as Record<string, unknown>).ui && ((tool._meta as { ui?: { visibility?: string[] } }).ui?.visibility ?? []).includes("model")).length, 7);
    const resources = await client.listResources();
    assert.equal(resources.resources.some((resource) => resource.uri === READONLY_WORKBENCH_RESOURCE_URI && resource.mimeType === READONLY_WORKBENCH_RESOURCE_MIME), true);
    const resource = await client.readResource({ uri: READONLY_WORKBENCH_RESOURCE_URI });
    assert.equal(resource.contents[0]?.mimeType, READONLY_WORKBENCH_RESOURCE_MIME);
    const rendered = await client.callTool({ name: READONLY_WORKBENCH_RENDER_TOOL, arguments: {} });
    const shell = rendered.structuredContent as { app_state?: string };
    assert.equal(shell.app_state, "no_snapshot");

    const published = await fetch(runtime.snapshot_url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signReadonlySnapshot(fixture.snapshot, "publisher-smoke-v1", pair.privateKey))
    });
    assert.equal(published.status, 202);

    const readyRender = await client.callTool({ name: READONLY_WORKBENCH_RENDER_TOOL, arguments: {} });
    const readyShell = record(readyRender.structuredContent);
    assert.equal(readyShell.app_state, "ready");
    const renderFingerprint = record(readyShell.status).snapshot_fingerprint;
    assert.equal(renderFingerprint, fixture.snapshot.snapshot_fingerprint);

    const calls = [
      { name: "list_production_projects", arguments: {} },
      { name: "get_project_context", arguments: { project_id: fixture.project_id, workspace: "overview" } },
      { name: "list_project_shots", arguments: { project_id: fixture.project_id } },
      { name: "get_review_package", arguments: { project_id: fixture.project_id, shot_id: fixture.shot_id } },
      { name: "get_delivery_status", arguments: { project_id: fixture.project_id } },
      { name: "get_closeout_evidence", arguments: { project_id: fixture.project_id } }
    ];
    const fingerprints = [renderFingerprint];
    for (const call of calls) {
      const result = await client.callTool(call);
      assert.equal(result.isError, false, call.name);
      const structured = record(result.structuredContent);
      assert.equal(structured.ok, true, call.name);
      const modelVisibleFingerprint = record(structured.meta).snapshot_fingerprint;
      assert.equal(modelVisibleFingerprint, fixture.snapshot.snapshot_fingerprint, call.name);
      assert.equal(record(result._meta).snapshot_fingerprint, modelVisibleFingerprint, call.name);
      fingerprints.push(modelVisibleFingerprint);
    }
    assert.deepEqual([...new Set(fingerprints)], [fixture.snapshot.snapshot_fingerprint]);
  } finally {
    await transport.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
