import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ISSUER = "https://issuer.acceptance.test/";
const RESOURCE = "https://aivideo.acceptance.test/mcp";
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

test("MP4 acceptance fixture is isolated, snapshot-v4 bound, source-preserving, and low disclosure", () => {
  const wrapper = readFileSync(resolve("scripts/windows/media-create-acceptance-fixture.ps1"), "utf8");
  assert.match(wrapper, /Read-Host "Auth0 user_id\/sub \(input hidden\)" -AsSecureString/);
  assert.doesNotMatch(wrapper, /-MaskInput/);
  assert.match(wrapper, /SecureStringToBSTR\(\$secureSubject\)/);
  assert.match(wrapper, /ZeroFreeBSTR\(\$bstr\)/);

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

    const manifest = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { media_relative_path: string };
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
