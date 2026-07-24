import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { issuerHash, WEBGPT_V4_VERSION } from "../src/webgpt-v4/types.js";
import {
  assertReadonlyPublisherPathsIgnored,
  createReadonlyPublisherKey,
  currentUserDpapi,
  parseReadonlyPublisherProfile,
  publishReadonlySnapshot,
  type ReadonlyDpapi,
  type ReadonlyPublisherProfile
} from "../src/webgpt-cloud/publisher.js";
import {
  createPersonalReadonlyOperationsService,
  PersonalReadonlyOperationsError
} from "../src/webgpt-cloud/personalReadonlyOperations.js";
import { verifyReadonlySignedSnapshot } from "../src/webgpt-cloud/signedSnapshot.js";
import {
  finalizeReadonlySnapshot,
  READONLY_SNAPSHOT_REQUIRED_MIGRATION,
  READONLY_SNAPSHOT_REQUIRED_SCHEMA,
  READONLY_SNAPSHOT_SCHEMA_VERSION
} from "../src/webgpt-cloud/snapshot.js";

const ISSUER = "https://auth.example.test/";
const RESOURCE = "https://aivideo.example.test/mcp";
const NOW = new Date("2026-07-17T00:00:00.000Z");

const reversibleProtector: ReadonlyDpapi = {
  protect: (value) => Buffer.from(value).reverse(),
  unprotect: (value) => Buffer.from(value).reverse()
};

function profile(root: string): ReadonlyPublisherProfile {
  return parseReadonlyPublisherProfile({
    profile_version: "readonly-publisher-profile-v1",
    database_path: join(root, "fixture.sqlite"),
    issuer: ISSUER,
    resource_url: RESOURCE,
    snapshot_url: "https://aivideo.example.test/snapshot",
    key_id: "publisher-fixture-v1",
    protected_private_key_path: join(root, "publisher-key.dpapi"),
    public_key_path: join(root, "publisher-public.pem"),
    receipts_directory: join(root, "receipts"),
    ttl_seconds: 3600
  });
}

function snapshot(resourceUrl = RESOURCE) {
  return finalizeReadonlySnapshot({
    schema_version: READONLY_SNAPSHOT_SCHEMA_VERSION,
    source_schema: READONLY_SNAPSHOT_REQUIRED_SCHEMA,
    source_migration: READONLY_SNAPSHOT_REQUIRED_MIGRATION,
    source_version: WEBGPT_V4_VERSION,
    generated_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
    resource_url: resourceUrl,
    issuer_hash: issuerHash(ISSUER),
    authorization: { principals: [] },
    projects: []
  });
}

test("publisher profile accepts only exact legacy or unified Snapshot publish target pairs", () => {
  const unified = parseReadonlyPublisherProfile({
    ...profile(join(tmpdir(), "safe-profile")),
    resource_url: "https://aivideo.example.test/workspace/mcp",
    snapshot_url: "https://aivideo.example.test/workspace/snapshot"
  });
  assert.equal(unified.resource_url, "https://aivideo.example.test/workspace/mcp");
  assert.equal(unified.snapshot_url, "https://aivideo.example.test/workspace/snapshot");
  assert.throws(() => parseReadonlyPublisherProfile({
    ...profile(join(tmpdir(), "safe-profile")),
    resource_url: "https://aivideo.example.test/not-mcp"
  }));
  assert.throws(() => parseReadonlyPublisherProfile({
    ...profile(join(tmpdir(), "safe-profile")),
    snapshot_url: "https://other.example.test/snapshot"
  }));
  assert.throws(() => parseReadonlyPublisherProfile({
    ...profile(join(tmpdir(), "safe-profile")),
    snapshot_url: "http://aivideo.example.test/snapshot"
  }));
  assert.throws(() => parseReadonlyPublisherProfile({
    ...profile(join(tmpdir(), "safe-profile")),
    resource_url: "https://aivideo.example.test/workspace/mcp",
    snapshot_url: "https://aivideo.example.test/snapshot"
  }));
  assert.throws(() => parseReadonlyPublisherProfile({
    ...profile(join(tmpdir(), "safe-profile")),
    snapshot_url: "https://aivideo.example.test/workspace/snapshot"
  }));
});

test("Windows DPAPI CurrentUser roundtrip keeps plaintext out of files and output", async () => {
  assert.equal(process.platform, "win32", "Readonly publisher delivery is supported only on the frozen Windows lane.");
  const root = await mkdtemp(join(tmpdir(), "readonly-dpapi-"));
  try {
    const configured = profile(root);
    createReadonlyPublisherKey(configured, currentUserDpapi);
    const protectedFile = readFileSync(configured.protected_private_key_path);
    const publicFile = readFileSync(configured.public_key_path, "utf8");
    assert.equal(protectedFile.includes(Buffer.from("PRIVATE KEY", "utf8")), false);
    assert.equal(publicFile.includes("PRIVATE KEY"), false);
    await publishReadonlySnapshot(configured, {
      dpapi: currentUserDpapi,
      now: () => NOW,
      export_snapshot: () => snapshot(),
      fetch_impl: async () => ({ ok: true, status: 202 })
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publisher clears exported private key bytes when DPAPI protection fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "readonly-dpapi-failure-"));
  const capture: { value?: Buffer } = {};
  try {
    assert.throws(() => createReadonlyPublisherKey(profile(root), {
      protect: (value) => {
        capture.value = value;
        throw new Error("fixture failure");
      },
      unprotect: (value) => value
    }));
    assert.ok(capture.value);
    assert.equal(capture.value.every((byte) => byte === 0), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publisher refuses runtime profile, key, or receipt paths that are not Git ignored", () => {
  const configured = profile(join(tmpdir(), "publisher-path-gate"));
  const checked: string[] = [];
  assert.throws(() => assertReadonlyPublisherPathsIgnored("profile.json", configured, (path) => {
    checked.push(path);
    return path !== configured.public_key_path;
  }, () => false), (error: unknown) => error instanceof Error && error.message === "READONLY_PUBLISHER_PATH_NOT_IGNORED");
  assert.deepEqual(checked, ["profile.json", configured.protected_private_key_path, configured.public_key_path]);
  assert.throws(() => assertReadonlyPublisherPathsIgnored("profile.json", configured, () => true, (path) => path === configured.protected_private_key_path));
});

test("publisher signs a strict projection, sends only the envelope, and writes a sanitized receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "readonly-publisher-"));
  try {
    const configured = profile(root);
    createReadonlyPublisherKey(configured, reversibleProtector);
    let publishedBody: unknown = null;
    const result = await publishReadonlySnapshot(configured, {
      dpapi: reversibleProtector,
      now: () => NOW,
      export_snapshot: () => snapshot(),
      fetch_impl: async (url, init) => {
        assert.equal(url, configured.snapshot_url);
        assert.equal(init.method, "PUT");
        assert.equal(init.redirect, "manual");
        assert.equal(init.signal instanceof AbortSignal, true);
        publishedBody = JSON.parse(String(init.body));
        return { ok: true, status: 202 };
      }
    });
    const publicKey = readFileSync(configured.public_key_path);
    assert.equal(verifyReadonlySignedSnapshot(publishedBody, configured.key_id, publicKey, NOW).snapshot_fingerprint, snapshot().snapshot_fingerprint);
    assert.equal(result.receipt.result, "PASS");
    const receipt = JSON.parse(await readFile(result.receipt_path, "utf8")) as Record<string, unknown>;
    const serialized = JSON.stringify(receipt);
    for (const forbidden of [configured.database_path, configured.protected_private_key_path, configured.snapshot_url, "subject", "token", "projects"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publisher signs and publishes a unified Workspace Snapshot through its exact paired route", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-workspace-publisher-"));
  try {
    const configured = parseReadonlyPublisherProfile({
      ...profile(root),
      resource_url: "https://aivideo.example.test/workspace/mcp",
      snapshot_url: "https://aivideo.example.test/workspace/snapshot",
      key_id: "unified-workspace-publisher-v1"
    });
    createReadonlyPublisherKey(configured, reversibleProtector);
    let exportedResourceUrl: string | null = null;
    let publishedUrl: string | null = null;
    const result = await publishReadonlySnapshot(configured, {
      dpapi: reversibleProtector,
      now: () => NOW,
      export_snapshot: (input) => {
        exportedResourceUrl = input.resource_url;
        return snapshot(input.resource_url);
      },
      fetch_impl: async (url, init) => {
        publishedUrl = url;
        assert.equal(init.method, "PUT");
        assert.equal(init.redirect, "manual");
        return { ok: true, status: 202 };
      }
    });
    assert.equal(exportedResourceUrl, configured.resource_url);
    assert.equal(publishedUrl, configured.snapshot_url);
    assert.equal(result.receipt.result, "PASS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publisher records a stable failure receipt without reading a remote response body", async () => {
  const root = await mkdtemp(join(tmpdir(), "readonly-publisher-failure-"));
  try {
    const configured = profile(root);
    createReadonlyPublisherKey(configured, reversibleProtector);
    await assert.rejects(() => publishReadonlySnapshot(configured, {
      dpapi: reversibleProtector,
      now: () => NOW,
      export_snapshot: () => snapshot(),
      fetch_impl: async () => ({ ok: false, status: 503 })
    }), (error: unknown) => error instanceof Error && error.message === "READONLY_PUBLISHER_REMOTE_REJECTED");
    const files = readdirSync(configured.receipts_directory);
    assert.equal(files.length, 1);
    const receipt = JSON.parse(readFileSync(join(configured.receipts_directory, files[0]!), "utf8")) as Record<string, unknown>;
    assert.deepEqual({ result: receipt.result, stable_error_code: receipt.stable_error_code, http_status: receipt.http_status }, {
      result: "FAIL", stable_error_code: "READONLY_PUBLISHER_REMOTE_REJECTED", http_status: 503
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("personal readonly operations keep status read-only and run one explicit preflight-publish lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "readonly-personal-operations-"));
  try {
    const configured = profile(root);
    const profilePath = join(root, "profile.json");
    await writeFile(configured.database_path, "fixture");
    createReadonlyPublisherKey(configured, reversibleProtector);
    let exportCount = 0;
    let publishCount = 0;
    let healthStatus = 200;
    let statusBody = JSON.stringify({
      ok: true,
      version: "readonly-remote-v1.0.0",
      checks: { oauth: true, publisher_key: true, snapshot_fresh: true, authorization_projection: true, media_capability_roundtrip: true },
      snapshot: {
        freshness_status: "fresh",
        generated_at: NOW.toISOString(),
        expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
        age_seconds: 0,
        ttl_remaining_seconds: 3600,
        snapshot_fingerprint: snapshot().snapshot_fingerprint
      },
      forbidden_business_text: "must-not-escape"
    });
    const service = createPersonalReadonlyOperationsService(profilePath, {
      now: () => NOW,
      assert_paths_ignored: () => undefined,
      publisher: {
        dpapi: reversibleProtector,
        now: () => NOW,
        export_snapshot: () => { exportCount += 1; return snapshot(); },
        fetch_impl: async () => { publishCount += 1; return { ok: true, status: 202 }; }
      },
      status_fetch_impl: async (url, init) => {
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "manual");
        return url.endsWith("/healthz")
          ? { ok: healthStatus === 200, status: healthStatus, text: async () => JSON.stringify({ ok: healthStatus === 200 }) }
          : { ok: true, status: 200, text: async () => statusBody };
      }
    });
    await writeFile(profilePath, JSON.stringify(configured));
    const before = await service.status();
    assert.equal(exportCount, 0, "status must not export or open business rows");
    assert.equal(before.ready_to_publish, true);
    assert.equal(before.remote.ready, true);
    assert.equal(before.remote.checks.media_capability_roundtrip, true);
    assert.deepEqual(before.freshness_operations, {
      state: "renewal_due",
      reason_code: "SNAPSHOT_EXPIRING_SOON",
      renewal_recommended: true,
      recommended_action: "preflight_and_renew",
      renewal_threshold_seconds: 7200
    });
    assert.equal(before.remote.snapshot.snapshot_fingerprint, snapshot().snapshot_fingerprint);
    assert.equal(JSON.stringify(before).includes("must-not-escape"), false);
    assert.equal(JSON.stringify(before).includes(configured.database_path), false);
    assert.equal(JSON.stringify(before).includes(configured.snapshot_url), false);

    statusBody = JSON.stringify({
      ok: false,
      version: "readonly-remote-v1.0.0",
      checks: { oauth: true, publisher_key: true, snapshot_fresh: false, authorization_projection: false, media_capability_roundtrip: true },
      snapshot: { freshness_status: "no_snapshot", generated_at: null, expires_at: null, age_seconds: null, ttl_remaining_seconds: null, snapshot_fingerprint: null }
    });
    const missing = await service.status();
    assert.deepEqual(missing.freshness_operations, {
      state: "restoration_required",
      reason_code: "SNAPSHOT_NOT_PUBLISHED",
      renewal_recommended: true,
      recommended_action: "preflight_and_renew",
      renewal_threshold_seconds: 7200
    });
    assert.equal(exportCount, 0, "status reminders must never export or renew a snapshot");

    statusBody = JSON.stringify({
      ok: false,
      version: "readonly-remote-v1.0.0",
      checks: { oauth: true, publisher_key: true, snapshot_fresh: false, authorization_projection: true, media_capability_roundtrip: true },
      snapshot: {
        freshness_status: "snapshot_expired",
        generated_at: new Date(NOW.getTime() - 25 * 3600_000).toISOString(),
        expires_at: new Date(NOW.getTime() - 3600_000).toISOString(),
        age_seconds: 25 * 3600,
        ttl_remaining_seconds: 0,
        snapshot_fingerprint: snapshot().snapshot_fingerprint
      }
    });
    const expired = await service.status();
    assert.equal(expired.freshness_operations.state, "restoration_required");
    assert.equal(expired.freshness_operations.reason_code, "SNAPSHOT_EXPIRED");
    assert.equal(expired.freshness_operations.renewal_recommended, true);

    statusBody = JSON.stringify({
      ok: true,
      version: "readonly-remote-v1.0.0",
      checks: { oauth: true, publisher_key: true, snapshot_fresh: true, authorization_projection: true, media_capability_roundtrip: true },
      snapshot: {
        freshness_status: "fresh",
        generated_at: NOW.toISOString(),
        expires_at: new Date(NOW.getTime() + 3 * 3600_000).toISOString(),
        age_seconds: 0,
        ttl_remaining_seconds: 3 * 3600,
        snapshot_fingerprint: snapshot().snapshot_fingerprint
      }
    });
    const current = await service.status();
    assert.equal(current.freshness_operations.state, "current");
    assert.equal(current.freshness_operations.reason_code, "SNAPSHOT_FRESH");
    assert.equal(current.freshness_operations.renewal_recommended, false);
    assert.equal(exportCount, 0, "all freshness status projections must remain read-only");

    healthStatus = 503;
    const unreachable = await service.status();
    assert.equal(unreachable.freshness_operations.state, "service_unavailable");
    assert.equal(unreachable.freshness_operations.reason_code, "REMOTE_UNREACHABLE");
    assert.equal(unreachable.freshness_operations.renewal_recommended, false, "an unreachable remote must not recommend a blind publish");
    assert.equal(unreachable.freshness_operations.recommended_action, "check_remote");
    healthStatus = 200;

    const prepared = await service.preflight();
    assert.equal(prepared.result, "PASS");
    assert.equal(exportCount, 1);
    assert.equal(publishCount, 0);
    assert.equal(existsSync(configured.receipts_directory), false, "preflight must not write a receipt");

    const published = await service.publish();
    assert.equal(published.http_status, 202);
    assert.equal(exportCount, 2);
    assert.equal(publishCount, 1);
    const after = await service.status();
    assert.equal(after.last_receipt_state, "valid");
    assert.equal(after.last_publish?.result, "PASS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("personal readonly operations reject overlapping publish attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "readonly-personal-operations-lock-"));
  const profilePath = join(root, "profile.json");
  try {
    const configured = profile(root);
    await writeFile(configured.database_path, "fixture");
    await writeFile(profilePath, JSON.stringify(configured));
    createReadonlyPublisherKey(configured, reversibleProtector);
    let releasePublish: (() => void) | undefined;
    let startedPublish: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { startedPublish = resolve; });
    const released = new Promise<void>((resolve) => { releasePublish = resolve; });
    const service = createPersonalReadonlyOperationsService(profilePath, {
      assert_paths_ignored: () => undefined,
      publisher: {
        dpapi: reversibleProtector,
        now: () => NOW,
        export_snapshot: () => snapshot(),
        fetch_impl: async () => {
          startedPublish?.();
          await released;
          return { ok: true, status: 202 };
        }
      }
    });
    const first = service.publish();
    await started;
    await assert.rejects(() => service.publish(), (error: unknown) =>
      error instanceof PersonalReadonlyOperationsError && error.code === "READONLY_PUBLISH_OPERATION_IN_PROGRESS");
    releasePublish?.();
    await first;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Render blueprint freezes one always-on instance without disk or auto deploy", () => {
  const blueprint = readFileSync(join(process.cwd(), "render.yaml"), "utf8");
  assert.match(blueprint, /name:\s+jenn-ai-video-readonly-mcp-app/);
  assert.match(blueprint, /plan:\s+starter/);
  assert.match(blueprint, /numInstances:\s+1/);
  assert.match(blueprint, /autoDeployTrigger:\s+off/);
  assert.doesNotMatch(blueprint, /\bautoDeploy:\s*/);
  assert.match(blueprint, /startCommand:\s+node dist\/scripts\/webgpt-cloud-server\.js/);
  assert.doesNotMatch(blueprint, /^\s*disk:/m);
});

test("Render entrypoint keeps publisher, exporter, and SQLite modules out of the remote graph", () => {
  const entrypoint = readFileSync(join(process.cwd(), "scripts", "webgpt-cloud-server.ts"), "utf8");
  assert.doesNotMatch(entrypoint, /webgpt-cloud\/publisher|webgpt-cloud\/dataSource|database\/|sqlite/i);
});
