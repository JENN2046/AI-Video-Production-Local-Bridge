import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

function text(path: string): string {
  return readFileSync(path, "utf8");
}

test("readonly media operations pin cloudflared and keep secrets out of command lines and status", () => {
  const manifest = JSON.parse(text("ops/manifests/cloudflared-windows-amd64.json")) as Record<string, unknown>;
  assert.equal(manifest.manifest_version, "cloudflared-binary-v1");
  assert.equal(manifest.version, "2026.7.2");
  assert.match(String(manifest.download_url), /^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\/2026\.7\.2\//);
  assert.equal(manifest.sha256, "cdb5d4432f6ae1595654a692a51308b69d2bf7af961f5578d9391837cf072df9");

  const common = text("scripts/windows/media-runtime-common.ps1");
  const start = text("scripts/windows/media-start.ps1");
  const status = text("scripts/windows/media-status.ps1");
  assert.match(common, /DataProtectionScope\]::CurrentUser/);
  assert.match(common, /Get-FileHash -Algorithm SHA256/);
  assert.match(common, /readonly-media-gateway-v1\.0\.0/);
  assert.match(start, /MEDIA_GATEWAY_LISTENER_IDENTITY_MISMATCH/);
  assert.match(start, /\$env:TUNNEL_TOKEN/);
  assert.doesNotMatch(start, /--token(?:-file)?\b/i);
  assert.match(start, /--no-autoupdate/);
  assert.match(start, /--loglevel", "warn"/);
  assert.doesNotMatch(start, /--loglevel", "debug"/);
  assert.match(status, /active_capabilities/);
  assert.match(status, /active_sessions/);
  assert.doesNotMatch(status, /CapabilityKeyPath|TunnelTokenPath|DatabasePath|MediaRoots|IssuerHash/);
  const preflight = text("scripts/windows/media-preflight.ps1");
  assert.match(preflight, /dist\/scripts\/db-check\.js --read-only/);
});

test("readonly media logon task is current-user limited and starts gateway before tunnel", () => {
  const start = text("scripts/windows/media-start.ps1");
  const gatewayStart = start.indexOf("webgpt-media-gateway-server.js");
  const readiness = start.indexOf("/readyz", gatewayStart);
  const tunnelStart = start.indexOf("Start-Process -FilePath $profile.CloudflaredPath", readiness);
  assert.ok(gatewayStart >= 0 && readiness > gatewayStart && tunnelStart > readiness);

  const install = text("scripts/windows/media-install-logon-task.ps1");
  assert.match(install, /New-ScheduledTaskTrigger -AtLogOn -User \$currentUser/);
  assert.match(install, /Delay = "PT30S"/);
  assert.match(install, /-RestartCount 3/);
  assert.match(install, /-RestartInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(install, /-LogonType Interactive -RunLevel Limited/);
  assert.match(install, /media-logon-entry\.ps1/);
  assert.doesNotMatch(install, /SYSTEM|RunLevel Highest|Password/);
  assert.match(start, /MEDIA_START_ALREADY_IN_PROGRESS/);
  assert.match(start, /Stop-Process -Id \$cloudflared\.Id/);
  assert.match(start, /Stop-Process -Id \$gateway\.Id/);
  const remove = text("scripts/windows/media-remove-logon-task.ps1");
  assert.match(remove, /MEDIA_LOGON_TASK_IDENTITY_MISMATCH/);
});

test("readonly media capability keygen writes only DPAPI CurrentUser ciphertext to ignored storage", () => {
  assert.equal(process.platform, "win32");
  const root = join(process.cwd(), "data", "webgpt", `media-operations-test-${process.pid}-${Date.now()}`);
  const profilePath = join(root, "profile.json");
  const protectedPath = join(root, "capability-key.dpapi");
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(profilePath, JSON.stringify({
      profile_version: "readonly-media-operations-profile-v1",
      database_path: "data/app.sqlite",
      issuer_hash: "a".repeat(64),
      allowed_origin: "https://aivideo.skmt617.top",
      gateway_port: 2092,
      media_roots: ["data/media"],
      capability_key: { kid: "fixture-key", protected_path: protectedPath },
      cloudflared: {
        executable_path: "ops/tools/cloudflared-fixture/cloudflared.exe",
        manifest_path: "ops/manifests/cloudflared-windows-amd64.json",
        protected_token_path: join(root, "tunnel-token.dpapi"),
        public_health_url: "https://media.skmt617.top/healthz"
      },
      runtime_directory: join(root, "runtime")
    }), "utf8");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", "scripts/windows/media-capability-keygen.ps1"], {
      cwd: process.cwd(),
      env: { ...process.env, READONLY_MEDIA_OPERATIONS_PROFILE_PATH: profilePath },
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { result: "CREATED", kid: "fixture-key", protected: true });
    const protectedText = readFileSync(protectedPath, "utf8").trim();
    assert.match(protectedText, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.ok(Buffer.from(protectedText, "base64").byteLength > 32);
    assert.doesNotMatch(result.stdout + result.stderr, /[A-Za-z0-9_-]{43}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readonly media Apps smoke and operations are mandatory local and Windows CI gates", () => {
  const packageJson = JSON.parse(text("package.json")) as { scripts: Record<string, string> };
  const workflow = text(".github/workflows/windows-ci.yml");
  assert.match(packageJson.scripts["test:webgpt:media-gateway"], /webgpt-media-operations\.test\.js/);
  assert.match(packageJson.scripts["smoke:webgpt:media"], /webgpt-media-remote-bridge\.test\.js/);
  assert.match(packageJson.scripts["smoke:webgpt:media"], /webgpt-apps-smoke\.test\.js/);
  assert.match(packageJson.scripts.test, /npm run test:webgpt:media-gateway/);
  assert.match(packageJson.scripts.test, /npm run smoke:webgpt:media/);
  assert.match(workflow, /name: Readonly media Apps smoke\s+run: npm run smoke:webgpt:media/);
});
