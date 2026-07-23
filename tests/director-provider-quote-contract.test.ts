import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDirectorGrantCapability,
  publicDirectorQuote,
  readDirectorQuote,
  RUNNINGHUB_DIRECTOR_CAPABILITY,
  RUNWAY_DIRECTOR_CAPABILITY_CANDIDATE,
  selectVerifiedDirectorCapability
} from "../src/director/providerCapability.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { buildProviderPriceCacheKey } from "../src/tools/providerCapabilities.js";

const now = new Date("2026-07-23T08:00:00.000Z");

function runningHubSelection() {
  const selection = selectVerifiedDirectorCapability({
    duration_seconds: 6,
    resolution: "480p",
    aspect_ratio: "9:16"
  });
  assert.ok(selection);
  return selection;
}

function writeQuote(
  db: ReturnType<typeof openM0Database>,
  input: { source?: string; fetched_at?: Date; expires_at?: Date; estimated_cost_value?: number } = {}
): void {
  const selection = runningHubSelection();
  const priceKey = buildProviderPriceCacheKey(selection.key, selection.capability.provider_capability);
  db.prepare(`INSERT INTO webgpt_provider_price_cache (
    provider, model, duration_seconds, resolution, estimated_cost_value, currency, source, fetched_at, expires_at
  ) VALUES (?, ?, ?, ?, ?, 'CNY', ?, ?, ?)`).run(
    priceKey.provider, priceKey.model, priceKey.duration_seconds, priceKey.storage_resolution,
    input.estimated_cost_value ?? 0.08, input.source ?? priceKey.source,
    (input.fetched_at ?? now).toISOString(), (input.expires_at ?? new Date(now.getTime() + 60 * 60_000)).toISOString()
  );
}

test("Director selects only verified Provider Capabilities and preserves candidate routes as non-selectable", () => {
  const selected = runningHubSelection();
  assert.equal(selected.capability.reference, RUNNINGHUB_DIRECTOR_CAPABILITY.reference);
  assert.equal(selected.key.provider, "runninghub");
  assert.equal(RUNWAY_DIRECTOR_CAPABILITY_CANDIDATE.verification, "candidate");
  assert.equal(selectVerifiedDirectorCapability({
    duration_seconds: 2,
    resolution: "720:1280",
    aspect_ratio: "9:16"
  }), null);
  assert.equal(assertDirectorGrantCapability("runninghub", "runninghub-capability-v1"), null);
  assert.throws(() => assertDirectorGrantCapability("runninghub", "unrecognized-legacy-reference"), /DIRECTOR_PROVIDER_CAPABILITY_DRIFT/);
  assert.equal(assertDirectorGrantCapability("runninghub", RUNNINGHUB_DIRECTOR_CAPABILITY.reference)?.reference, RUNNINGHUB_DIRECTOR_CAPABILITY.reference);
  assert.throws(
    () => assertDirectorGrantCapability("runway", RUNWAY_DIRECTOR_CAPABILITY_CANDIDATE.reference),
    /DIRECTOR_PROVIDER_CAPABILITY_UNAVAILABLE/
  );
});

test("Director quote resolver requires a current matching local preflight and redacts cost from discussion projection", () => {
  const db = openM0Database(":memory:");
  try {
    const selection = runningHubSelection();
    assert.equal(readDirectorQuote(db, selection, now).quote_state, "missing");

    writeQuote(db, { fetched_at: new Date(now.getTime() - 11 * 60_000) });
    assert.equal(readDirectorQuote(db, selection, now).quote_state, "stale");
    db.exec("DELETE FROM webgpt_provider_price_cache");

    writeQuote(db, { source: "unverified-source" });
    assert.equal(readDirectorQuote(db, selection, now).quote_state, "capability_drift");
    db.exec("DELETE FROM webgpt_provider_price_cache");

    writeQuote(db);
    const quote = readDirectorQuote(db, selection, now);
    assert.equal(quote.quote_state, "ready");
    if (quote.quote_state !== "ready") throw new Error("Expected a fresh verified quote.");
    assert.equal(quote.amount_minor, 8);
    const publicQuote = publicDirectorQuote(quote);
    assert.deepEqual(publicQuote, {
      quote_state: "ready",
      expires_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
      currency: "CNY",
      requires_human_refresh: false
    });
    assert.equal("amount_minor" in publicQuote, false);
    assert.equal("capability_reference" in publicQuote, false);
  } finally {
    db.close();
  }
});
