import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleWorkbenchV2Api } from "../src/http/workbenchV2Routes.js";

test("V2 API uses stable envelopes, pagination, nonce and archived write blocking", async (t) => {
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
