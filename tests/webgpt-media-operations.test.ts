import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  const previousEnvironmentClear = start.indexOf('$previousEnvironmentVariables | ForEach-Object { Remove-Item "Env:$_"');
  const previousProfileBranch = start.indexOf('if ($null -ne $profile.PreviousCapability)');
  const gatewayProcessStart = start.indexOf("$gateway = Start-Process");
  assert.ok(previousEnvironmentClear >= 0 && previousEnvironmentClear < previousProfileBranch && previousEnvironmentClear < gatewayProcessStart);
  assert.match(status, /active_capabilities/);
  assert.match(status, /active_sessions/);
  assert.doesNotMatch(status, /CapabilityKeyPath|TunnelTokenPath|DatabasePath|MediaRoots|IssuerHash/);
  const preflight = text("scripts/windows/media-preflight.ps1");
  assert.match(preflight, /dist\/scripts\/db-check\.js --read-only/);
  assert.match(common, /Invoke-WebRequest -UseBasicParsing -Uri \$Url -TimeoutSec \$TimeoutSec -MaximumRedirection 0/);
  assert.match(common, /FileAttributes\]::ReparsePoint/);
  assert.match(common, /MEDIA_OPERATIONS_PATH_REPARSE_POINT/);
  assert.match(common, /X-Readonly-Media-Instance-Probe/);
  assert.match(common, /readonly-media-runtime-state-v3/);
  assert.match(preflight, /Assert-MediaCapabilityKeyring/);
  assert.match(start, /Get-MediaGatewayHealth \$profile\.PublicHealthUrl 3 \$instanceProbe/);
});

test("readonly media operations reject private paths through reparse points", { skip: process.platform !== "win32" }, () => {
  const root = join(process.cwd(), "data", "webgpt", `media-reparse-test-${process.pid}-${Date.now()}`);
  const target = mkdtempSync(join(tmpdir(), "media-reparse-target-"));
  const junction = join(root, "private-link");
  mkdirSync(root, { recursive: true });
  symlinkSync(target, junction, "junction");
  try {
    const command = [
      ". $env:MEDIA_TEST_COMMON_SCRIPT",
      "try { Resolve-MediaInsideWorkspace $env:MEDIA_TEST_LINKED_PATH | Out-Null; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
    ].join("\n");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEDIA_TEST_COMMON_SCRIPT: join(process.cwd(), "scripts", "windows", "media-runtime-common.ps1"),
        MEDIA_TEST_LINKED_PATH: join(junction, "capability-key.dpapi")
      },
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MEDIA_OPERATIONS_PATH_REPARSE_POINT/);
  } finally {
    rmdirSync(junction);
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("readonly media preflight rejects an active and previous capability key with the same kid", { skip: process.platform !== "win32" }, () => {
  const command = [
    ". $env:MEDIA_TEST_COMMON_SCRIPT",
    "$profile = [pscustomobject]@{ CapabilityKid = 'same-kid'; PreviousCapability = [pscustomobject]@{ Kid = 'same-kid' } }",
    "$active = New-Object byte[] 32",
    "$previous = New-Object byte[] 32",
    "try { Assert-MediaCapabilityKeyring $profile $active $previous; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: process.cwd(),
    env: { ...process.env, MEDIA_TEST_COMMON_SCRIPT: join(process.cwd(), "scripts", "windows", "media-runtime-common.ps1") },
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MEDIA_CAPABILITY_KEY_INVALID/);
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

test("readonly media preflight accepts only a managed gateway matching the listener", async (context) => {
  const common = text("scripts/windows/media-runtime-common.ps1");
  const preflight = text("scripts/windows/media-preflight.ps1");
  assert.match(common, /function Assert-MediaPreflightPortState/);
  assert.match(common, /MEDIA_OPERATIONS_STATE_INVALID/);
  assert.match(common, /MEDIA_OPERATIONS_STATE_CONFLICT/);
  assert.match(common, /MEDIA_GATEWAY_LISTENER_IDENTITY_MISMATCH/);
  assert.match(common, /Get-NetTCPConnection -LocalPort \$Port -State Listen/);
  assert.doesNotMatch(common, /Get-NetTCPConnection -LocalAddress "127\.0\.0\.1" -LocalPort \$Port/);
  assert.match(common, /MEDIA_GATEWAY_PORT_MULTIPLE_LISTENERS/);
  assert.match(common, /MEDIA_OPERATIONS_PROFILE_DRIFT/);
  assert.match(preflight, /Assert-MediaPreflightPortState \$profile \$node\.NodePath/);

  const start = text("scripts/windows/media-start.ps1");
  const statusScript = text("scripts/windows/media-status.ps1");
  const stopScript = text("scripts/windows/media-stop.ps1");
  const ignoredBoundary = start.indexOf("Assert-MediaGitIgnored (Get-MediaPrivatePaths $profile)");
  const stateRead = start.indexOf("Read-MediaState $profile");
  const staleStateDelete = start.indexOf("Remove-Item -LiteralPath $profile.StatePath -Force");
  assert.ok(ignoredBoundary >= 0 && ignoredBoundary < stateRead && ignoredBoundary < staleStateDelete);
  assert.match(statusScript, /MEDIA_OPERATIONS_RESTART_REQUIRED/);
  assert.match(statusScript, /Assert-MediaRuntimeStateIdentity \$profile \$node\.NodePath \$profileFingerprint \$state/);
  assert.match(stopScript, /readonly-media-runtime-state-v1/);
  assert.match(stopScript, /readonly-media-runtime-state-v2/);
  const stopIgnoredBoundary = stopScript.indexOf("Assert-MediaGitIgnored (Get-MediaPrivatePaths $profile)");
  const stopStateRead = stopScript.indexOf("Read-MediaState $profile");
  const stopStateDelete = stopScript.indexOf("Remove-Item -LiteralPath $profile.StatePath -Force");
  const stopCountsDelete = stopScript.indexOf("Remove-Item -LiteralPath $profile.CountsPath -Force");
  assert.ok(stopIgnoredBoundary >= 0 && stopIgnoredBoundary < stopStateRead && stopIgnoredBoundary < stopStateDelete && stopIgnoredBoundary < stopCountsDelete);
  const stopMissingState = stopScript.indexOf("if ($null -eq $state)");
  const stopListenerCheck = stopScript.indexOf("Get-MediaListenerPid $profile.GatewayPort", stopMissingState);
  const stopAlreadyStopped = stopScript.indexOf('result = "ALREADY_STOPPED"', stopMissingState);
  assert.ok(stopMissingState >= 0 && stopListenerCheck > stopMissingState && stopListenerCheck < stopAlreadyStopped);
  assert.match(stopScript, /MEDIA_OPERATIONS_STATE_MISSING_WITH_LISTENER/);

  await context.test("Windows listener ownership rejects stale and drifted state", { skip: process.platform !== "win32" }, async () => {
    const root = join(process.cwd(), "data", "webgpt", `media-port-state-test-${process.pid}-${Date.now()}`);
    const statePath = join(root, "media-state.json");
    mkdirSync(root, { recursive: true });
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const command = [
        ". $env:MEDIA_TEST_COMMON_SCRIPT",
        "$listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort ([int]$env:MEDIA_TEST_PORT) -State Listen | Select-Object -First 1",
        "if ($env:MEDIA_TEST_MODE -eq 'valid' -or $env:MEDIA_TEST_MODE -eq 'drift') { $recordProcess = Get-Process -Id ([int]$listener.OwningProcess) } else { $recordProcess = Get-Process -Id $PID }",
        "$started = if ($env:MEDIA_TEST_MODE -eq 'drift') { '2000-01-01T00:00:00.0000000Z' } else { $recordProcess.StartTime.ToUniversalTime().ToString('o') }",
        "$fingerprint = 'a' * 64",
        "$stateFingerprint = if ($env:MEDIA_TEST_MODE -eq 'profile-drift') { 'b' * 64 } else { $fingerprint }",
        "$state = [ordered]@{ state_version = 'readonly-media-runtime-state-v3'; profile_fingerprint = $stateFingerprint; instance_probe = ('A' * 43); gateway_pid = $recordProcess.Id; gateway_start_time_utc = $started; gateway_executable = $recordProcess.Path; cloudflared_pid = $recordProcess.Id; cloudflared_start_time_utc = $started; cloudflared_executable = $recordProcess.Path; started_at_utc = (Get-Date).ToUniversalTime().ToString('o'); gateway_port = [int]$env:MEDIA_TEST_PORT }",
        "$state | ConvertTo-Json | Set-Content -LiteralPath $env:MEDIA_TEST_STATE_PATH -Encoding UTF8",
        "$profile = [pscustomobject]@{ StatePath = $env:MEDIA_TEST_STATE_PATH; GatewayPort = [int]$env:MEDIA_TEST_PORT; CloudflaredPath = $recordProcess.Path }",
        "try { Assert-MediaPreflightPortState $profile $recordProcess.Path $fingerprint; [Console]::Out.WriteLine('PASS'); exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
      ].join("\n");
      const run = (mode: "unknown" | "valid" | "drift" | "profile-drift") => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MEDIA_TEST_COMMON_SCRIPT: join(process.cwd(), "scripts", "windows", "media-runtime-common.ps1"),
          MEDIA_TEST_STATE_PATH: statePath,
          MEDIA_TEST_PORT: String(address.port),
          MEDIA_TEST_MODE: mode
        },
        encoding: "utf8",
        windowsHide: true
      });

      const unknown = run("unknown");
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, /MEDIA_GATEWAY_LISTENER_IDENTITY_MISMATCH/);
      const valid = run("valid");
      assert.equal(valid.status, 0, valid.stderr);
      assert.equal(valid.stdout.trim(), "PASS");
      const drift = run("drift");
      assert.equal(drift.status, 1);
      assert.match(drift.stderr, /MEDIA_OPERATIONS_STATE_CONFLICT/);
      const profileDrift = run("profile-drift");
      assert.equal(profileDrift.status, 1);
      assert.match(profileDrift.stderr, /MEDIA_OPERATIONS_PROFILE_DRIFT/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  await context.test("Windows listener discovery includes wildcard bindings", { skip: process.platform !== "win32" }, async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", () => resolve());
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const command = [
        ". $env:MEDIA_TEST_COMMON_SCRIPT",
        "$owner = Get-MediaListenerPid ([int]$env:MEDIA_TEST_PORT)",
        "if ($null -eq $owner) { [Console]::Error.WriteLine('LISTENER_NOT_FOUND'); exit 1 }",
        "[Console]::Out.WriteLine($owner)",
        "exit 0"
      ].join("\n");
      const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MEDIA_TEST_COMMON_SCRIPT: join(process.cwd(), "scripts", "windows", "media-runtime-common.ps1"),
          MEDIA_TEST_PORT: String(address.port)
        },
        encoding: "utf8",
        windowsHide: true
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout.trim(), /^\d+$/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("readonly media capability keygen writes only DPAPI CurrentUser ciphertext to ignored storage", async (context) => {
  const common = text("scripts/windows/media-runtime-common.ps1");
  const keygen = text("scripts/windows/media-capability-keygen.ps1");
  const keyImport = text("scripts/windows/media-capability-key-import.ps1");
  assert.match(common, /DataProtectionScope\]::CurrentUser/);
  assert.match(common, /ConvertFrom-MediaCapabilityKeyBase64Url/);
  assert.match(keyImport, /Read-Host "Shared media capability key \(input hidden\)" -AsSecureString/);
  assert.match(keyImport, /ZeroFreeGlobalAllocUnicode/);
  assert.match(keyImport, /ConvertFrom-MediaCapabilityKeyBase64Url/);
  assert.doesNotMatch(keyImport, /Write-(?:Host|Output).*\$encoded|Write-MediaJson[\s\S]*?encoded\s*=/i);
  assert.doesNotMatch(keygen, /ToBase64String\(\$bytes\)|Write-(?:Host|Output).*\$bytes/i);

  await context.test("Windows DPAPI keygen and hidden import roundtrip", { skip: process.platform !== "win32" }, () => {
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

      rmSync(protectedPath, { force: true });
      const sharedKey = Buffer.alloc(32, 47).toString("base64url");
      const importScript = join(process.cwd(), "scripts", "windows", "media-capability-key-import.ps1");
      const importCommand = [
        "function Read-Host {",
        "  param([string]$Prompt, [switch]$AsSecureString)",
        "  $secure = [System.Security.SecureString]::new()",
        "  foreach ($character in $env:MEDIA_TEST_SHARED_KEY.ToCharArray()) { $secure.AppendChar($character) }",
        "  $secure.MakeReadOnly()",
        "  $secure",
        "}",
        "& $env:MEDIA_TEST_IMPORT_SCRIPT"
      ].join("\n");
      const imported = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", importCommand], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          READONLY_MEDIA_OPERATIONS_PROFILE_PATH: profilePath,
          MEDIA_TEST_IMPORT_SCRIPT: importScript,
          MEDIA_TEST_SHARED_KEY: sharedKey
        },
        encoding: "utf8",
        windowsHide: true
      });
      assert.equal(imported.status, 0, imported.stderr);
      assert.deepEqual(JSON.parse(imported.stdout.trim()), { result: "IMPORTED", kid: "fixture-key", protected: true });
      assert.equal(`${imported.stdout}${imported.stderr}`.includes(sharedKey), false);

      const verifyCommand = [
        ". $env:MEDIA_TEST_COMMON_SCRIPT",
        "$actual = Unprotect-MediaBytes $env:MEDIA_TEST_PROTECTED_PATH",
        "$expected = ConvertFrom-MediaCapabilityKeyBase64Url $env:MEDIA_TEST_SHARED_KEY",
        "try {",
        "  if ([Convert]::ToBase64String($actual) -cne [Convert]::ToBase64String($expected)) { exit 1 }",
        "} finally {",
        "  [Array]::Clear($actual, 0, $actual.Length)",
        "  [Array]::Clear($expected, 0, $expected.Length)",
        "}"
      ].join("\n");
      const verified = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", verifyCommand], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MEDIA_TEST_COMMON_SCRIPT: join(process.cwd(), "scripts", "windows", "media-runtime-common.ps1"),
          MEDIA_TEST_PROTECTED_PATH: protectedPath,
          MEDIA_TEST_SHARED_KEY: sharedKey
        },
        encoding: "utf8",
        windowsHide: true
      });
      assert.equal(verified.status, 0, verified.stderr);
      assert.equal(verified.stdout.trim(), "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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
