import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ISSUER = "https://issuer.acceptance.test/";
const RESOURCE = "https://aivideo.skmt617.top/mcp";
const SUBJECT = "auth0|media-acceptance-test-subject";

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function lowDisclosureError(stderr: string): unknown {
  const line = stderr.trim().split(/\r?\n/).reverse().find((candidate) => candidate.startsWith("{"));
  assert.ok(line, "expected a stable JSON error receipt");
  return JSON.parse(line);
}

const childEnv = { ...process.env, NODE_NO_WARNINGS: "1" };

test("MP4 acceptance fixture and generated profiles are isolated, contract-valid, source-preserving, and low disclosure", () => {
  const wrapper = readFileSync(resolve("scripts/windows/media-create-acceptance-fixture.ps1"), "utf8");
  const runbook = readFileSync(resolve("docs/webgpt/READONLY_LOCAL_MEDIA_GATEWAY_RUNBOOK.md"), "utf8");
  assert.match(wrapper, /Read-Host "Auth0 user_id\/sub \(input hidden\)" -AsSecureString/);
  assert.doesNotMatch(wrapper, /-MaskInput/);
  assert.match(wrapper, /SecureStringToBSTR\(\$secureSubject\)/);
  assert.match(wrapper, /ZeroFreeBSTR\(\$bstr\)/);
  assert.match(runbook, /npm --silent run media:fixture:create --/);
  assert.match(runbook, /npm --silent run media:fixture:verify --/);
  assert.match(runbook, /npm --silent run media:fixture:profiles --/);
  assert.doesNotMatch(runbook, /`npm run media:fixture:(?:create|verify|profiles)/);

  const source = resolve("fixtures/video/mock_clip.mp4");
  const command = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const before = { sha256: sha(source), size: statSync(source).size, mtimeMs: statSync(source).mtimeMs };
  const created = spawnSync(process.execPath, [command, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
    cwd: process.cwd(), input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
  });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout) as { result: string; run_id: string; checks: Record<string, boolean> };
  assert.equal(receipt.result, "PASS");
  assert.match(receipt.run_id, /^run_[0-9a-f]{32}$/);
  assert.deepEqual(receipt.checks, { source_unchanged: true, ledger_0008: true, mp4_valid: true, snapshot_v4: true, media_binding: true });
  assert.equal(created.stdout.includes(SUBJECT), false);
  assert.equal(created.stdout.includes(source), false);
  assert.doesNotMatch(created.stdout, /[0-9a-f]{64}/);
  const root = resolve("data/webgpt/media-acceptance", receipt.run_id);
  try {
    const verified = spawnSync(process.execPath, [command, "verify", "--run", receipt.run_id, "--issuer", ISSUER, "--resource", RESOURCE], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(verified.status, 0, verified.stderr);
    const verification = JSON.parse(verified.stdout) as { result: string; checks: Record<string, boolean>; project_count: number; media_binding_count: number };
    assert.equal(verification.result, "PASS");
    assert.deepEqual(verification.checks, { schema: true, database_manifest: true, media_digest: true, snapshot_v4: true, media_binding: true });
    assert.equal(verification.project_count, 1);
    assert.equal(verification.media_binding_count, 2);
    assert.equal(verified.stdout.includes(SUBJECT), false);
    assert.doesNotMatch(verified.stdout, /[0-9a-f]{64}/);

    const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { issuer_hash: string; media_relative_path: string };
    const publisherTemplatePath = join(root, "publisher-template.json");
    const gatewayTemplatePath = join(root, "gateway-template.json");
    const invalidPublisherTemplatePath = join(root, "publisher-template-invalid.json");
    const wrongIssuerPublisherTemplatePath = join(root, "publisher-template-wrong-issuer.json");
    const publisherTemplate = {
      profile_version: "readonly-publisher-profile-v1",
      database_path: "data/app.sqlite",
      issuer: ISSUER,
      resource_url: RESOURCE,
      snapshot_url: "https://aivideo.skmt617.top/snapshot",
      key_id: "acceptance-publisher-v1",
      protected_private_key_path: "data/webgpt/publisher/key.dpapi",
      public_key_path: "data/webgpt/publisher/public.pem",
      receipts_directory: "data/webgpt/publisher/receipts",
      ttl_seconds: 86400
    };
    writeFileSync(publisherTemplatePath, JSON.stringify(publisherTemplate), "utf8");
    writeFileSync(invalidPublisherTemplatePath, JSON.stringify({
      ...publisherTemplate,
      protected_key_path: publisherTemplate.protected_private_key_path,
      receipt_directory: publisherTemplate.receipts_directory,
      protected_private_key_path: undefined,
      receipts_directory: undefined
    }), "utf8");
    writeFileSync(wrongIssuerPublisherTemplatePath, JSON.stringify({ ...publisherTemplate, issuer: "https://other-issuer.acceptance.test/" }), "utf8");
    writeFileSync(gatewayTemplatePath, JSON.stringify({
      profile_version: "readonly-media-operations-profile-v1",
      database_path: "data/app.sqlite",
      issuer_hash: manifest.issuer_hash,
      allowed_origin: "https://aivideo.skmt617.top",
      gateway_port: 2092,
      media_roots: ["data/media"],
      capability_key: { kid: "acceptance-media-v1", protected_path: "data/webgpt/media-gateway/key.dpapi" },
      cloudflared: {
        executable_path: "ops/tools/cloudflared/cloudflared.exe",
        manifest_path: "ops/manifests/cloudflared.json",
        protected_token_path: "data/webgpt/media-gateway/token.dpapi",
        public_health_url: "https://media.skmt617.top/healthz"
      },
      runtime_directory: "data/webgpt/media-gateway/runtime"
    }), "utf8");

    const invalidProfiles = spawnSync(process.execPath, [command, "profiles", "--run", receipt.run_id, "--publisher-template", invalidPublisherTemplatePath, "--gateway-template", gatewayTemplatePath], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(invalidProfiles.status, 1);
    assert.deepEqual(lowDisclosureError(invalidProfiles.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_PUBLISHER_TEMPLATE_INVALID" });

    const wrongIssuerProfiles = spawnSync(process.execPath, [command, "profiles", "--run", receipt.run_id, "--publisher-template", wrongIssuerPublisherTemplatePath, "--gateway-template", gatewayTemplatePath], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(wrongIssuerProfiles.status, 1);
    assert.deepEqual(lowDisclosureError(wrongIssuerProfiles.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_PUBLISHER_TEMPLATE_INVALID" });

    const profiles = spawnSync(process.execPath, [command, "profiles", "--run", receipt.run_id, "--publisher-template", publisherTemplatePath, "--gateway-template", gatewayTemplatePath], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(profiles.status, 0, profiles.stderr);
    const profileReceipt = JSON.parse(profiles.stdout) as { result: string; action: string; run_id: string; checks: Record<string, boolean> };
    assert.deepEqual(profileReceipt, {
      result: "PASS",
      action: "profiles",
      run_id: receipt.run_id,
      checks: { publisher_profile: true, gateway_profile: true, git_ignored: true, secret_values_copied: false }
    });
    assert.doesNotMatch(profiles.stdout, /[0-9a-f]{64}|\.dpapi|https:\/\//);
    const generatedPublisher = JSON.parse(readFileSync(join(root, "publisher-profile.json"), "utf8")) as Record<string, unknown>;
    const generatedGateway = JSON.parse(readFileSync(join(root, "gateway-profile.json"), "utf8")) as Record<string, unknown>;
    assert.equal(generatedPublisher.protected_private_key_path, publisherTemplate.protected_private_key_path);
    assert.equal(typeof generatedPublisher.receipts_directory, "string");
    assert.equal("protected_key_path" in generatedPublisher, false);
    assert.equal("receipt_directory" in generatedPublisher, false);
    assert.match(String(generatedPublisher.database_path), new RegExp(`${receipt.run_id}/app\\.sqlite$`));
    assert.match(String(generatedPublisher.receipts_directory), new RegExp(`${receipt.run_id}/publisher-receipts$`));
    assert.match(String(generatedGateway.database_path), new RegExp(`${receipt.run_id}/app\\.sqlite$`));
    assert.deepEqual(generatedGateway.media_roots, [relative(process.cwd(), dirname(resolve(root, manifest.media_relative_path))).replaceAll("\\", "/")]);
    assert.match(String(generatedGateway.runtime_directory), new RegExp(`${receipt.run_id}/gateway-runtime$`));
    const repeatedProfiles = spawnSync(process.execPath, [command, "profiles", "--run", receipt.run_id, "--publisher-template", publisherTemplatePath, "--gateway-template", gatewayTemplatePath], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(repeatedProfiles.status, 1);
    assert.deepEqual(lowDisclosureError(repeatedProfiles.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_PROFILE_EXISTS" });

    appendFileSync(resolve(root, manifest.media_relative_path), Buffer.from([0]));
    const drifted = spawnSync(process.execPath, [command, "verify", "--run", receipt.run_id, "--issuer", ISSUER, "--resource", RESOURCE], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(drifted.status, 1);
    assert.deepEqual(lowDisclosureError(drifted.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_INTEGRITY_FAILED" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const after = { sha256: sha(source), size: statSync(source).size, mtimeMs: statSync(source).mtimeMs };
  assert.deepEqual(after, before);
});

test("MP4 acceptance fixture rejects a symlinked acceptance root", () => {
  const workspace = mkdtempSync(join(tmpdir(), "media-acceptance-workspace-"));
  const external = mkdtempSync(join(tmpdir(), "media-acceptance-external-"));
  const dataRoot = join(workspace, "data", "webgpt");
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(join(workspace, ".gitignore"), "data/\n", "utf8");
  symlinkSync(external, join(dataRoot, "media-acceptance"), process.platform === "win32" ? "junction" : "dir");
  try {
    const command = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
    const source = resolve("fixtures/video/mock_clip.mp4");
    const result = spawnSync(process.execPath, [command, "create", "--input", source, "--issuer", ISSUER, "--resource", RESOURCE], {
      cwd: workspace, input: `${SUBJECT}\n`, encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(result.status, 1);
    assert.deepEqual(lowDisclosureError(result.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE" });
    assert.deepEqual(readdirSync(external), []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("MP4 acceptance fixture verify rejects symlinked run and nested paths", () => {
  const workspace = mkdtempSync(join(tmpdir(), "media-acceptance-verify-workspace-"));
  const external = mkdtempSync(join(tmpdir(), "media-acceptance-verify-external-"));
  const acceptanceRoot = join(workspace, "data", "webgpt", "media-acceptance");
  mkdirSync(acceptanceRoot, { recursive: true });
  writeFileSync(join(workspace, ".gitignore"), "data/\n", "utf8");
  spawnSync("git", ["init", "--quiet"], { cwd: workspace, windowsHide: true });
  const command = resolve("dist/scripts/webgpt-media-acceptance-fixture.js");
  const runId = "run_00000000000000000000000000000000";
  const runPath = join(acceptanceRoot, runId);
  try {
    symlinkSync(external, runPath, process.platform === "win32" ? "junction" : "dir");
    const linkedRun = spawnSync(process.execPath, [command, "verify", "--run", runId, "--issuer", ISSUER, "--resource", RESOURCE], {
      cwd: workspace, encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(linkedRun.status, 1);
    assert.deepEqual(lowDisclosureError(linkedRun.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE" });
    unlinkSync(runPath);

    mkdirSync(runPath, { recursive: true });
    const linkedData = join(runPath, "linked-data");
    writeFileSync(join(runPath, "app.sqlite"), "not-a-database", "utf8");
    writeFileSync(join(external, "fixture.mp4"), "not-a-video", "utf8");
    symlinkSync(external, linkedData, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(runPath, "fixture.json"), JSON.stringify({
      fixture_version: "readonly-media-acceptance-fixture-v1",
      run_id: runId,
      database_file: "app.sqlite",
      project_id: "project_fixture",
      shot_id: "shot_fixture",
      artifact_id: "artifact_fixture",
      blob_id: "blob_fixture",
      issuer_hash: "0".repeat(64),
      resource_url: RESOURCE,
      media_relative_path: "linked-data/fixture.mp4",
      media_sha256: "0".repeat(64),
      database_manifest: "0".repeat(64)
    }), "utf8");
    const linkedNested = spawnSync(process.execPath, [command, "verify", "--run", runId, "--issuer", ISSUER, "--resource", RESOURCE], {
      cwd: workspace, encoding: "utf8", windowsHide: true, env: childEnv
    });
    assert.equal(linkedNested.status, 1);
    assert.deepEqual(lowDisclosureError(linkedNested.stderr), { result: "FAIL", stable_error_code: "MEDIA_ACCEPTANCE_ROOT_UNSAFE" });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
