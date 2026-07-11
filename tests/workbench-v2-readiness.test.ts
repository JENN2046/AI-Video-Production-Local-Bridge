import assert from "node:assert/strict";
import test from "node:test";

import { startWorkbenchApplication } from "../src/apps/workbench/server.js";
import { openM0Database } from "../src/storage/sqlite.js";

test("Workbench health is liveness-only and readiness verifies local dependencies", async () => {
  const previousProvider = process.env.REAL_PROVIDER_ENABLED;
  process.env.REAL_PROVIDER_ENABLED = "false";
  const runtime = await startWorkbenchApplication(0);
  try {
    const health = await fetch(`${runtime.url}/healthz`);
    assert.equal(health.status, 200);
    const healthBody = await health.json() as { ok: boolean; service: string };
    assert.deepEqual(healthBody, { ok: true, service: "workbench-v2" });

    const ready = await fetch(`${runtime.url}/readyz`);
    assert.equal(ready.status, 200);
    const body = await ready.json() as { ok: boolean; checks: Record<string, boolean> };
    assert.equal(body.ok, true);
    for (const check of ["schema", "database", "media_directory", "ffmpeg", "ffprobe", "worker", "provider"]) assert.equal(body.checks[check], true);
    const db = openM0Database();
    try {
      const marker = db.prepare("SELECT COUNT(*) AS count FROM m0_meta WHERE key = 'workbench_v2_1_inbox_migrated_at'").get() as { count: number };
      assert.equal(marker.count, 0, "service startup must not run legacy data migrations");
      db.prepare(`INSERT INTO generation_intents
        (intent_id, project_id, shot_id, provider, account_label, model, input_artifact_id, duration_seconds, resolution,
         estimated_cost_value, budget_limit_value, currency, confirmed, expires_at, status)
        VALUES ('intent_readiness_dynamic', 'project_readiness', 'shot_readiness', 'runninghub', 'personal', 'model',
          'artifact_readiness', 6, '1080x1920', 0.08, 1, 'CNY', 1, '2099-01-01T00:00:00.000Z', 'queued')`).run();
      db.prepare("INSERT INTO generation_jobs (job_id, intent_id, state) VALUES ('job_readiness_dynamic', 'intent_readiness_dynamic', 'queued')").run();
    } finally { db.close(); }
    const staleCacheProbe = await fetch(`${runtime.url}/readyz`);
    const staleCacheBody = await staleCacheProbe.json() as { ok: boolean; checks: Record<string, boolean> };
    assert.equal(staleCacheProbe.status, 503);
    assert.equal(staleCacheBody.ok, false);
    assert.equal(staleCacheBody.checks.worker, false);

    const deferredDb = openM0Database();
    try {
      deferredDb.prepare("UPDATE generation_intents SET provider_task_id = 'task_readiness_dynamic', status = 'running' WHERE intent_id = 'intent_readiness_dynamic'").run();
      deferredDb.prepare("UPDATE generation_jobs SET state = 'polling', next_attempt_at = ? WHERE job_id = 'job_readiness_dynamic'")
        .run(new Date(Date.now() + 60_000).toISOString());
    } finally { deferredDb.close(); }
    const deferredProbe = await fetch(`${runtime.url}/readyz`);
    const deferredBody = await deferredProbe.json() as { ok: boolean; checks: Record<string, boolean> };
    assert.equal(deferredProbe.status, 200);
    assert.equal(deferredBody.ok, true);
    assert.equal(deferredBody.checks.worker, true);

    const dueDb = openM0Database();
    try {
      dueDb.prepare("UPDATE generation_jobs SET next_attempt_at = CURRENT_TIMESTAMP WHERE job_id = 'job_readiness_dynamic'").run();
    } finally { dueDb.close(); }
    const dueProbe = await fetch(`${runtime.url}/readyz`);
    const dueBody = await dueProbe.json() as { ok: boolean; checks: Record<string, boolean> };
    assert.equal(dueProbe.status, 503);
    assert.equal(dueBody.ok, false);
    assert.equal(dueBody.checks.worker, false);
  } finally {
    await runtime.close();
    if (previousProvider === undefined) delete process.env.REAL_PROVIDER_ENABLED;
    else process.env.REAL_PROVIDER_ENABLED = previousProvider;
  }
});
