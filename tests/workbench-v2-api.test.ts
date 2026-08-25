import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { handleWorkbenchV2Api } from "../src/http/workbenchV2Routes.js";
import { openM0Database } from "../src/storage/sqlite.js";
import type { PersonalReadonlyOperationsService } from "../src/webgpt-cloud/personalReadonlyOperations.js";

test("report GET routes do not create a missing workspace data tree", () => {
  const dataRoot = resolve(process.cwd(), `.readonly-report-manifest-${randomUUID()}`);
  assert.equal(existsSync(dataRoot), false);
  const script = `
    import { createServer } from "node:http";
    import { handleWorkbenchV2Api } from "./dist/src/http/workbenchV2Routes.js";
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      void handleWorkbenchV2Api(request, response, url, "readonly-report-test").then((handled) => {
        if (!handled) { response.writeHead(404); response.end(); }
      });
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const base = "http://127.0.0.1:" + address.port;
    const list = await fetch(base + "/api/v2/system/reports");
    const listBody = await list.json();
    const missing = await fetch(base + "/api/v2/system/reports/missing.json");
    const missingBody = await missing.json();
    await new Promise((resolveClose) => server.close(resolveClose));
    process.stdout.write(JSON.stringify({ listStatus: list.status, listBody, missingStatus: missing.status, missingBody }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, AI_VIDEO_WORKSPACE_DATA_ROOT: dataRoot, AI_VIDEO_WORKSPACE_DB_PATH: "" },
    windowsHide: true
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout) as {
    listStatus: number;
    listBody: { ok: boolean; data: unknown[]; meta: { total: number } };
    missingStatus: number;
    missingBody: { ok: boolean; error: { code: string } };
  };
  assert.equal(result.listStatus, 200);
  assert.equal(result.listBody.ok, true);
  assert.deepEqual(result.listBody.data, []);
  assert.equal(result.listBody.meta.total, 0);
  assert.equal(result.missingStatus, 404);
  assert.equal(result.missingBody.error.code, "REPORT_NOT_FOUND");
  assert.equal(existsSync(dataRoot), false);
});

test("V2 API uses readonly workspace GETs, stable envelopes, pagination, nonce and archived write blocking", async (t) => {
  const nonce = "synthetic-action-nonce";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    handleWorkbenchV2Api(request, response, url, nonce).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    }).catch((error) => { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: false, error: { code: "TEST_SERVER_ERROR", message: String(error) } })); });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const shell = await fetch(`${base}/api/v2/shell`).then((response) => response.json()) as { ok: boolean; data: { action_nonce: string; capabilities: { legacy_available: boolean } } };
  assert.equal(shell.ok, true);
  assert.equal(shell.data.action_nonce, nonce);
  assert.equal(shell.data.capabilities.legacy_available, false);

  const denied = await fetch(`${base}/api/v2/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Denied" }) });
  assert.equal(denied.status, 403);

  const missingClassification = await fetch(`${base}/api/v2/projects`, { method: "POST", headers: { "content-type": "application/json", "x-h1-action-nonce": nonce }, body: JSON.stringify({ title: "Missing classification" }) });
  const missingClassificationPayload = await missingClassification.json() as { ok: boolean; error: { code: string } };
  assert.equal(missingClassificationPayload.ok, false);
  assert.equal(missingClassificationPayload.error.code, "CLASSIFICATION_REQUIRED");

  const createdResponse = await fetch(`${base}/api/v2/projects`, { method: "POST", headers: { "content-type": "application/json", "x-h1-action-nonce": nonce }, body: JSON.stringify({ title: "API project", classification: "production" }) });
  const created = await createdResponse.json() as { ok: boolean; data: { project: { project_id: string } } };
  assert.equal(created.ok, true);
  const projectId = created.data.project.project_id;

  const beforeOpen = "2000-01-01T00:00:00.000Z";
  const projectDb = openM0Database();
  try {
    projectDb.prepare("UPDATE workbench_project_meta SET last_opened_at = ? WHERE project_id = ?").run(beforeOpen, projectId);
  } finally {
    projectDb.close();
  }
  const opened = await fetch(`${base}/api/v2/projects/${encodeURIComponent(projectId)}/overview`);
  assert.equal(opened.status, 200);
  const verifyOpenDb = openM0Database();
  try {
    const meta = verifyOpenDb.prepare("SELECT last_opened_at FROM workbench_project_meta WHERE project_id = ?").get(projectId) as { last_opened_at: string };
    assert.equal(meta.last_opened_at, beforeOpen);
  } finally {
    verifyOpenDb.close();
  }

  const page = await fetch(`${base}/api/v2/projects?limit=1`).then((response) => response.json()) as { ok: boolean; data: unknown[]; meta: { limit: number; total: number } };
  assert.equal(page.ok, true);
  assert.equal(page.meta.limit, 1);
  assert.equal(page.meta.total >= 1, true);

  const archived = await fetch(`${base}/api/v2/projects/${encodeURIComponent(projectId)}/archive`, { method: "POST", headers: { "content-type": "application/json", "x-h1-action-nonce": nonce }, body: "{}" });
  assert.equal(archived.status, 200);
  const rename = await fetch(`${base}/api/v2/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", headers: { "content-type": "application/json", "x-h1-action-nonce": nonce }, body: JSON.stringify({ title: "blocked rename" }) });
  const renamePayload = await rename.json() as { ok: boolean; error: { code: string } };
  assert.equal(rename.status, 409);
  assert.equal(renamePayload.error.code, "PROJECT_ARCHIVED");

  const missing = await fetch(`${base}/api/v2/projects/not-a-project/overview`);
  assert.equal(missing.status, 404);
});

test("personal readonly operations API requires nonce and explicit publish confirmation", async (t) => {
  const nonce = "readonly-operations-nonce";
  const calls = { status: 0, preflight: 0, publish: 0 };
  const service: PersonalReadonlyOperationsService = {
    status: async () => {
      calls.status += 1;
      return {
        operations_version: "personal-readonly-operations-v2",
        checked_at: "2026-07-17T00:00:00.000Z",
        configuration: "ready",
        stable_error_code: null,
        database_available: true,
        publisher_key_available: true,
        ready_to_preflight: true,
        ready_to_publish: true,
        freshness_operations: { state: "renewal_due", reason_code: "SNAPSHOT_EXPIRING_SOON", renewal_recommended: true, recommended_action: "preflight_and_renew", renewal_threshold_seconds: 7200 },
        remote: {
          reachable: true,
          ready: true,
          health_http_status: 200,
          readiness_http_status: 200,
          service_version: "readonly-remote-v1.0.0",
          checks: { oauth: true, publisher_key: true, snapshot_fresh: true, authorization_projection: true, media_capability_roundtrip: true },
          snapshot: { freshness_status: "fresh", generated_at: null, expires_at: null, age_seconds: 0, ttl_remaining_seconds: 3600, snapshot_fingerprint: null }
        },
        last_publish: null,
        last_receipt_state: "none"
      };
    },
    preflight: async () => {
      calls.preflight += 1;
      return { result: "PASS", snapshot_fingerprint: "a".repeat(64), generated_at: "2026-07-17T00:00:00.000Z", expires_at: "2026-07-18T00:00:00.000Z" };
    },
    publish: async () => {
      calls.publish += 1;
      return { result: "PASS", http_status: 202, snapshot_fingerprint: "a".repeat(64), generated_at: "2026-07-17T00:00:00.000Z", expires_at: "2026-07-18T00:00:00.000Z" };
    }
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    void handleWorkbenchV2Api(request, response, url, nonce, { readonly_operations: service }).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const status = await fetch(`${base}/api/v2/system/readonly-operations`);
  assert.equal(status.status, 200);
  assert.equal(calls.status, 1);

  const noNonce = await fetch(`${base}/api/v2/system/readonly-operations/preflight`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noNonce.status, 403);
  assert.equal(calls.preflight, 0);

  const prepared = await fetch(`${base}/api/v2/system/readonly-operations/preflight`, { method: "POST", headers: { "content-type": "application/json", "x-h1-action-nonce": nonce }, body: "{}" });
  assert.equal(prepared.status, 200);
  assert.equal(calls.preflight, 1);

  const unconfirmed = await fetch(`${base}/api/v2/system/readonly-operations/publish`, { method: "POST", headers: { "content-type": "application/json", "x-h1-action-nonce": nonce }, body: "{}" });
  assert.equal(unconfirmed.status, 403);
  assert.equal((await unconfirmed.json() as { error: { code: string } }).error.code, "READONLY_PUBLISH_CONFIRMATION_REQUIRED");
  assert.equal(calls.publish, 0);

  const published = await fetch(`${base}/api/v2/system/readonly-operations/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-h1-action-nonce": nonce },
    body: JSON.stringify({ human_confirmation: true })
  });
  assert.equal(published.status, 200);
  assert.equal(calls.publish, 1);
});
