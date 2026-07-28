import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  DIRECTOR_BRIDGE_ACTIVATION_VERSION,
  DIRECTOR_BRIDGE_CONTROL_VERSION,
  DIRECTOR_BRIDGE_HEARTBEAT_SCHEMA,
  DirectorBridgeRuntimeControl
} from "../src/director/runtimeControl.js";
import {
  DIRECTOR_BRIDGE_COMPLETION_SCHEMA,
  DIRECTOR_BRIDGE_REQUEST_SCHEMA,
  DirectorBridgeBroker,
  DirectorBridgeReplayGuard,
  DirectorLocalBridgeClient,
  signDirectorBridgeBody,
  verifyDirectorBridgeBody
} from "../src/director/bridge.js";

function text(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalRuntimePath(value: string): string {
  return resolve(value).replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

const managedLaunchEnvironmentNames = [
  "ComSpec",
  "Path",
  "PATHEXT",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "WINDIR",
  "REAL_PROVIDER_ENABLED",
  "M1_REAL_PROVIDER_EXECUTION_ALLOWED",
  "M1_REAL_PROVIDER_COST_ACK",
  "WEBGPT_DIRECTOR_REMOTE_ORIGIN",
  "WEBGPT_DIRECTOR_BRIDGE_KEY_ID",
  "WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH",
  "AI_VIDEO_WORKSPACE_DB_PATH",
  "FFMPEG_PATH",
  "AI_VIDEO_DIRECTOR_BRIDGE_FIXTURE_MODE"
] as const;

function managedLaunchEnvironmentSha256(environment: NodeJS.ProcessEnv): string {
  const canonical = ["director-bridge-launch-environment-v1"];
  for (const name of managedLaunchEnvironmentNames) {
    const value = environment[name];
    if (value === undefined || value.trim() === "") continue;
    canonical.push(`name=${name.toUpperCase()}`);
    canonical.push(`value_sha256=${sha256Text(value)}`);
  }
  return sha256Text(canonical.join("\n"));
}

function managedRuntimeEnvironment(options: {
  workspace: string;
  root: string;
  heartbeat_path: string;
  stop_path: string;
  activation_path: string;
  instance_id: string;
  entrypoint: string;
  database_path: string;
  dpapi_path: string;
  key_id: string;
  origin: string;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of managedLaunchEnvironmentNames.slice(0, 8)) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") environment[name] = value;
  }
  environment.REAL_PROVIDER_ENABLED = "false";
  environment.M1_REAL_PROVIDER_EXECUTION_ALLOWED = "false";
  environment.M1_REAL_PROVIDER_COST_ACK = "false";
  environment.WEBGPT_DIRECTOR_BRIDGE_KEY_ID = options.key_id;
  environment.WEBGPT_DIRECTOR_BRIDGE_KEY_B64 = undefined;
  environment.WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH = options.dpapi_path;
  environment.WEBGPT_DIRECTOR_REMOTE_ORIGIN = options.origin;
  environment.AI_VIDEO_WORKSPACE_DB_PATH = options.database_path;
  const launchConfigSha = sha256Text([
    "director-bridge-launch-config-v2",
    `remote_origin=${options.origin}`,
    `database_path=${canonicalRuntimePath(options.database_path)}`,
    `dpapi_path=${canonicalRuntimePath(options.dpapi_path)}`,
    `key_id=${options.key_id}`,
    "provider_enabled=false",
    "provider_execution_allowed=false",
    "provider_cost_acknowledged=false",
    `startup_environment_sha256=${managedLaunchEnvironmentSha256(environment)}`
  ].join("\n"));
  const launchArgvSha = sha256Text([
    "director-bridge-launch-argv-v1",
    `node=${canonicalRuntimePath(process.execPath)}`,
    `entrypoint=${canonicalRuntimePath(options.entrypoint)}`
  ].join("\n"));
  return {
    ...environment,
    AI_VIDEO_DIRECTOR_BRIDGE_HEARTBEAT_PATH: options.heartbeat_path,
    AI_VIDEO_DIRECTOR_BRIDGE_STOP_REQUEST_PATH: options.stop_path,
    AI_VIDEO_DIRECTOR_BRIDGE_ACTIVATION_PATH: options.activation_path,
    AI_VIDEO_DIRECTOR_BRIDGE_INSTANCE_ID: options.instance_id,
    AI_VIDEO_DIRECTOR_BRIDGE_SOURCE_COMMIT: "a".repeat(40),
    AI_VIDEO_DIRECTOR_BRIDGE_BUILD_MANIFEST_SHA256: "b".repeat(64),
    AI_VIDEO_DIRECTOR_BRIDGE_ENTRYPOINT_SHA256: "c".repeat(64),
    AI_VIDEO_DIRECTOR_BRIDGE_LAUNCH_CONFIG_SHA256: launchConfigSha,
    AI_VIDEO_DIRECTOR_BRIDGE_LAUNCH_ARGV_SHA256: launchArgvSha,
    AI_VIDEO_DIRECTOR_BRIDGE_RUNTIME_ROOT: options.root,
    AI_VIDEO_DIRECTOR_BRIDGE_WORKSPACE_ROOT: options.workspace
  };
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      readFileSync(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error("DIRECTOR_BRIDGE_TEST_FILE_TIMEOUT");
}

test("Director Bridge heartbeat schema carries instance, PID and source fingerprints while excluding business-data fields", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "director-bridge-runtime-control-"));
  const root = join(workspace, "runtime");
  mkdirSync(root);
  const heartbeatPath = join(root, "director-bridge-heartbeat.json");
  const stopPath = join(root, "director-bridge-stop-request.json");
  const activationPath = join(root, "director-bridge-activation.json");
  const instanceId = randomBytes(32).toString("base64url");
  const sourceCommit = "1".repeat(40);
  const buildSha = "2".repeat(64);
  const entrypointSha = "3".repeat(64);
  const launchConfigSha = "4".repeat(64);
  const launchArgvSha = "5".repeat(64);
  let now = new Date("2026-07-28T03:00:00.000Z");
  const control = new DirectorBridgeRuntimeControl({
    runtime_root: root,
    heartbeat_path: heartbeatPath,
    stop_request_path: stopPath,
    activation_path: activationPath,
    instance_id: instanceId,
    source_commit: sourceCommit,
    build_manifest_sha256: buildSha,
    entrypoint_sha256: entrypointSha,
    launch_config_sha256: launchConfigSha,
    launch_argv_sha256: launchArgvSha,
    workspace_root: workspace,
    now: () => now,
    heartbeat_interval_ms: 30_000
  });
  try {
    control.start();
    writeFileSync(activationPath, JSON.stringify({
      activation_version: DIRECTOR_BRIDGE_ACTIVATION_VERSION,
      instance_id: instanceId,
      action: "activate",
      activated_at_utc: now.toISOString()
    }), "utf8");
    await control.waitForActivation();
    control.setPhase("handling");
    const handling = DIRECTOR_BRIDGE_HEARTBEAT_SCHEMA.parse(JSON.parse(readFileSync(heartbeatPath, "utf8")) as unknown);
    assert.equal(handling.phase, "handling");
    assert.equal(handling.completion_pending, true);
    control.setPhase("completing");
    control.recordRemoteSuccess(false);
    const completing = DIRECTOR_BRIDGE_HEARTBEAT_SCHEMA.parse(JSON.parse(readFileSync(heartbeatPath, "utf8")) as unknown);
    assert.equal(completing.completion_pending, true);
    assert.throws(() => control.markStopped(), /DIRECTOR_BRIDGE_COMPLETION_UNCONFIRMED/);
    now = new Date("2026-07-28T03:00:01.000Z");
    control.recordRemoteSuccess(true);
    const heartbeat = DIRECTOR_BRIDGE_HEARTBEAT_SCHEMA.parse(JSON.parse(readFileSync(heartbeatPath, "utf8")) as unknown);
    assert.equal(heartbeat.instance_id, instanceId);
    assert.equal(heartbeat.source_commit, sourceCommit);
    assert.equal(heartbeat.build_manifest_sha256, buildSha);
    assert.equal(heartbeat.entrypoint_sha256, entrypointSha);
    assert.equal(heartbeat.launch_config_sha256, launchConfigSha);
    assert.equal(heartbeat.launch_argv_sha256, launchArgvSha);
    assert.equal(heartbeat.phase, "idle");
    assert.equal(heartbeat.last_authenticated_poll_at_utc, now.toISOString());
    assert.equal(heartbeat.last_request_completed_at_utc, now.toISOString());
    assert.equal(heartbeat.completion_pending, false);
    assert.equal(heartbeat.provider_enabled, false);
    assert.equal(JSON.stringify(heartbeat).includes(root), false);
    assert.equal(JSON.stringify(heartbeat).includes("project_id"), false);
    assert.equal(JSON.stringify(heartbeat).includes("request_id"), false);
    assert.equal(JSON.stringify(heartbeat).includes("tool"), false);

    writeFileSync(stopPath, JSON.stringify({
      control_version: DIRECTOR_BRIDGE_CONTROL_VERSION,
      instance_id: randomBytes(32).toString("base64url"),
      action: "stop",
      requested_at_utc: now.toISOString()
    }), "utf8");
    assert.equal(control.stopRequested(), false);
    writeFileSync(stopPath, JSON.stringify({
      control_version: DIRECTOR_BRIDGE_CONTROL_VERSION,
      instance_id: instanceId,
      action: "stop",
      requested_at_utc: now.toISOString()
    }), "utf8");
    assert.equal(control.stopRequested(), true);
    control.markStopped();
    const stopped = DIRECTOR_BRIDGE_HEARTBEAT_SCHEMA.parse(JSON.parse(readFileSync(heartbeatPath, "utf8")) as unknown);
    assert.equal(stopped.phase, "stopped");
    assert.equal(stopped.stop_requested, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Director Bridge client reports authenticated poll phases without payload details", async () => {
  const phases: string[] = [];
  const client = new DirectorLocalBridgeClient({
    remote_origin: "https://director.example.test/",
    client_id: "director-runtime-phase-test",
    keyring: { active: { kid: "director-runtime-phase-test", key: Buffer.alloc(32, 37) } },
    handlers: () => ({}) as never,
    fetch: async () => new Response(null, { status: 204 }),
    on_phase: (phase) => phases.push(phase)
  });
  assert.equal(await client.runOnce(), false);
  assert.deepEqual(phases, ["polling", "idle"]);
});

test("Director Bridge managed runtime rejects a workspace root that differs from the canonical cwd", () => {
  const workspace = mkdtempSync(join(tmpdir(), "director-bridge-workspace-mismatch-"));
  const root = join(workspace, "runtime");
  mkdirSync(root);
  const entrypoint = process.argv[1];
  assert.ok(entrypoint);
  try {
    const environment = managedRuntimeEnvironment({
      workspace,
      root,
      heartbeat_path: join(root, "director-bridge-heartbeat.json"),
      stop_path: join(root, "director-bridge-stop-request.json"),
      activation_path: join(root, "director-bridge-activation.json"),
      instance_id: randomBytes(32).toString("base64url"),
      entrypoint,
      database_path: join(workspace, "database.sqlite"),
      dpapi_path: join(workspace, "bridge-key.dpapi"),
      key_id: "director-workspace-mismatch",
      origin: "https://director-workspace-mismatch.example.test"
    });
    assert.throws(
      () => DirectorBridgeRuntimeControl.fromEnvironment({ ...environment, NODE_OPTIONS: "--require=untrusted-preload.cjs" }),
      /DIRECTOR_BRIDGE_RUNTIME_LAUNCH_IDENTITY_INVALID/
    );
    assert.throws(
      () => DirectorBridgeRuntimeControl.fromEnvironment(environment),
      /DIRECTOR_BRIDGE_RUNTIME_(?:CONTROL|LAUNCH_IDENTITY|WORKSPACE)_INVALID/
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Director Bridge real entrypoint remains pre-activation and stops without loading key or database inputs", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "director-bridge-preactivation-"));
  const root = join(workspace, "runtime");
  mkdirSync(root);
  const entrypoint = resolve("dist/scripts/director-local-bridge.js");
  const heartbeatPath = join(root, "director-bridge-heartbeat.json");
  const stopPath = join(root, "director-bridge-stop-request.json");
  const activationPath = join(root, "director-bridge-activation.json");
  const databasePath = join(workspace, "must-not-be-read.sqlite");
  const dpapiPath = join(workspace, "must-not-be-read.dpapi");
  const instanceId = randomBytes(32).toString("base64url");
  const keyId = "director-preactivation-test";
  const origin = "https://director-preactivation.example.test";
  const child = spawn(process.execPath, [entrypoint], {
    cwd: workspace,
    env: managedRuntimeEnvironment({
      workspace,
      root,
      heartbeat_path: heartbeatPath,
      stop_path: stopPath,
      activation_path: activationPath,
      instance_id: instanceId,
      entrypoint,
      database_path: databasePath,
      dpapi_path: dpapiPath,
      key_id: keyId,
      origin
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const childClosed = once(child, "close");
  try {
    await waitForFile(heartbeatPath);
    const starting = DIRECTOR_BRIDGE_HEARTBEAT_SCHEMA.parse(JSON.parse(readFileSync(heartbeatPath, "utf8")) as unknown);
    assert.equal(starting.phase, "starting");
    assert.equal(starting.last_authenticated_poll_at_utc, null);
    assert.doesNotMatch(stderr, /DIRECTOR_|must-not-be-read/);
    writeFileSync(stopPath, JSON.stringify({
      control_version: DIRECTOR_BRIDGE_CONTROL_VERSION,
      instance_id: instanceId,
      action: "stop",
      requested_at_utc: new Date().toISOString()
    }), "utf8");
    const [exitCode] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(exitCode, 0);
    const stopped = DIRECTOR_BRIDGE_HEARTBEAT_SCHEMA.parse(JSON.parse(readFileSync(heartbeatPath, "utf8")) as unknown);
    assert.equal(stopped.phase, "stopped");
    assert.equal(stopped.stop_requested, true);
    assert.equal(stopped.completion_pending, false);
    assert.doesNotMatch(stderr, /DIRECTOR_|must-not-be-read/);
  } finally {
    if (child.exitCode === null) child.kill();
    await childClosed;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Director Bridge activation reports a heartbeat-write fatal without loading key or database inputs", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "director-bridge-activation-fatal-"));
  const root = join(workspace, "runtime");
  mkdirSync(root);
  const entrypoint = resolve("dist/scripts/director-local-bridge.js");
  const heartbeatPath = join(root, "director-bridge-heartbeat.json");
  const stopPath = join(root, "director-bridge-stop-request.json");
  const activationPath = join(root, "director-bridge-activation.json");
  const databasePath = join(workspace, "must-not-be-read.sqlite");
  const dpapiPath = join(workspace, "must-not-be-read.dpapi");
  const child = spawn(process.execPath, [entrypoint], {
    cwd: workspace,
    env: managedRuntimeEnvironment({
      workspace,
      root,
      heartbeat_path: heartbeatPath,
      stop_path: stopPath,
      activation_path: activationPath,
      instance_id: randomBytes(32).toString("base64url"),
      entrypoint,
      database_path: databasePath,
      dpapi_path: dpapiPath,
      key_id: "director-activation-fatal",
      origin: "https://director-activation-fatal.example.test"
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    await waitForFile(heartbeatPath);
    assert.equal(existsSync(databasePath), false);
    assert.equal(existsSync(dpapiPath), false);
    rmSync(root, { recursive: true, force: true });
    const [exitCode] = await once(child, "exit", { signal: AbortSignal.timeout(10_000) }) as [number | null, NodeJS.Signals | null];
    assert.equal(exitCode, 1);
    assert.match(stderr, /"stable_error_code":"DIRECTOR_BRIDGE_RUNTIME_HEARTBEAT_FAILED"/);
    assert.doesNotMatch(stderr, /DIRECTOR_BRIDGE_RUNTIME_STOP_REQUESTED/);
    assert.equal(existsSync(databasePath), false);
    assert.equal(existsSync(dpapiPath), false);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Director Bridge stop gate returns a signed failure without invoking a local handler", async () => {
  const now = new Date("2026-07-28T03:30:00.000Z");
  const keyring = { active: { kid: "director-stop-gate", key: Buffer.alloc(32, 41) } };
  const request = DIRECTOR_BRIDGE_REQUEST_SCHEMA.parse({
    protocol_version: "director-local-bridge-v1",
    request_id: "director_stop_gate_request",
    actor: {
      principal_id: "1".repeat(64),
      actor_hash: "2".repeat(64),
      issuer_hash: "3".repeat(64),
      scopes: ["projects.read"]
    },
    tool: "get_director_focus",
    input: {},
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30_000).toISOString()
  });
  let fetchCount = 0;
  let handlerCalls = 0;
  let completionCode = "";
  const client = new DirectorLocalBridgeClient({
    remote_origin: "https://director.example.test/",
    client_id: "director-stop-gate",
    keyring,
    handlers: () => ({
      get_director_focus: async () => {
        handlerCalls += 1;
        return { state: "no_focus", focus: null };
      }
    }) as never,
    now: () => now,
    should_stop: () => true,
    fetch: async (_input, init) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(JSON.stringify(signDirectorBridgeBody(request, keyring.active, now)), { status: 200 });
      }
      const envelope = JSON.parse(String(init?.body)) as unknown;
      const completion = verifyDirectorBridgeBody(
        envelope,
        keyring,
        DIRECTOR_BRIDGE_COMPLETION_SCHEMA,
        new DirectorBridgeReplayGuard(),
        now
      );
      completionCode = completion.error?.code ?? "";
      return new Response(null, { status: 202 });
    }
  });
  assert.equal(await client.runOnce(), true);
  assert.equal(fetchCount, 2);
  assert.equal(handlerCalls, 0);
  assert.equal(completionCode, "DIRECTOR_BRIDGE_STOPPING");
});

test("Director Bridge retries one pending completion before polling or re-invoking its handler", async () => {
  const now = new Date("2026-07-28T03:40:00.000Z");
  const keyring = { active: { kid: "director-completion-retry", key: Buffer.alloc(32, 43) } };
  const request = DIRECTOR_BRIDGE_REQUEST_SCHEMA.parse({
    protocol_version: "director-local-bridge-v1",
    request_id: "director_completion_retry_request",
    actor: {
      principal_id: "4".repeat(64),
      actor_hash: "5".repeat(64),
      issuer_hash: "6".repeat(64),
      scopes: ["projects.read"]
    },
    tool: "get_director_focus",
    input: {},
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30_000).toISOString()
  });
  let pollCalls = 0;
  let completionCalls = 0;
  let handlerCalls = 0;
  let firstCompletionBody = "";
  const completionReplay = new DirectorBridgeReplayGuard();
  const client = new DirectorLocalBridgeClient({
    remote_origin: "https://director.example.test/",
    client_id: "director-completion-retry",
    keyring,
    handlers: () => ({
      get_director_focus: async () => {
        handlerCalls += 1;
        return { state: "no_focus", focus: null };
      }
    }) as never,
    now: () => now,
    fetch: async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/poll")) {
        pollCalls += 1;
        return new Response(JSON.stringify(signDirectorBridgeBody(request, keyring.active, now)), { status: 200 });
      }
      completionCalls += 1;
      const completion = verifyDirectorBridgeBody(
        JSON.parse(String(init?.body)) as unknown,
        keyring,
        DIRECTOR_BRIDGE_COMPLETION_SCHEMA,
        completionReplay,
        now
      );
      const body = JSON.stringify(completion);
      if (completionCalls === 1) {
        firstCompletionBody = body;
        return new Response(null, { status: 503 });
      }
      assert.equal(body, firstCompletionBody);
      return new Response(null, { status: 202 });
    }
  });
  await assert.rejects(() => client.runOnce(),
    (error) => error instanceof Error && "code" in error && error.code === "DIRECTOR_BRIDGE_COMPLETE_FAILED");
  assert.equal(client.hasPendingCompletion(), true);
  assert.equal(handlerCalls, 1);
  assert.equal(pollCalls, 1);
  assert.equal(await client.runOnce(), true);
  assert.equal(client.hasPendingCompletion(), false);
  assert.equal(handlerCalls, 1);
  assert.equal(pollCalls, 1);
  assert.equal(completionCalls, 2);
});

test("Director Bridge entrypoint defers managed-runtime fatal exit while a completion remains pending", () => {
  const runtime = text("scripts/director-local-bridge.ts");
  assert.match(
    runtime,
    /if \(!client\.hasPendingCompletion\(\)\) assertManagedRuntimeHealthy\(\);/
  );
  const loopStart = runtime.indexOf("while (true)");
  const loopEnd = runtime.indexOf("\n  assertManagedRuntimeHealthy();", loopStart);
  assert.ok(loopStart >= 0 && loopEnd > loopStart);
  const loop = runtime.slice(loopStart, loopEnd);
  assert.match(loop, /assertManagedRuntimeHealthyUnlessDraining\(\)/);
  assert.doesNotMatch(loop, /\bassertManagedRuntimeHealthy\(\)/);
});

test("Director Bridge broker accepts an identical completion retry but rejects a conflict", async () => {
  const acceptedAt = new Date("2026-07-28T03:50:00.000Z");
  let now = acceptedAt;
  const keyring = { active: { kid: "director-completion-dedup", key: Buffer.alloc(32, 47) } };
  const broker = new DirectorBridgeBroker(keyring, () => now);
  const actor = {
    principal_id: "7".repeat(64),
    actor_hash: "8".repeat(64),
    issuer_hash: "9".repeat(64),
    scopes: new Set(["projects.read"] as const)
  };
  const pending = broker.submit(actor, "get_director_focus", {});
  const dispatched = broker.poll();
  assert.ok(dispatched);
  const request = verifyDirectorBridgeBody(
    dispatched,
    keyring,
    DIRECTOR_BRIDGE_REQUEST_SCHEMA,
    new DirectorBridgeReplayGuard(),
    now
  );
  const completion = DIRECTOR_BRIDGE_COMPLETION_SCHEMA.parse({
    protocol_version: "director-local-bridge-v1",
    request_id: request.request_id,
    ok: true,
    result: { state: "no_focus", focus: null },
    completed_at: now.toISOString()
  });
  broker.complete(signDirectorBridgeBody(completion, keyring.active, now));
  assert.deepEqual(await pending, completion.result);
  now = new Date(acceptedAt.getTime() + 150_000);
  assert.doesNotThrow(() => broker.complete(signDirectorBridgeBody(completion, keyring.active, now)));
  assert.throws(() => broker.complete(signDirectorBridgeBody({
    ...completion,
    result: { state: "focus_expired", focus: null }
  }, keyring.active, now)), (error) =>
    error instanceof Error && "code" in error && error.code === "DIRECTOR_BRIDGE_COMPLETION_CONFLICT");
  now = new Date(acceptedAt.getTime() + 300_001);
  assert.throws(() => broker.complete(signDirectorBridgeBody(completion, keyring.active, now)), (error) =>
    error instanceof Error && "code" in error && error.code === "DIRECTOR_BRIDGE_REQUEST_NOT_FOUND");
});

test("Director Bridge Windows lifecycle manager scripts do not read Bridge key or database file contents", () => {
  const common = text("scripts/windows/director-bridge-runtime-common.ps1");
  const start = text("scripts/windows/director-bridge-start.ps1");
  const status = text("scripts/windows/director-bridge-status.ps1");
  const stop = text("scripts/windows/director-bridge-stop.ps1");
  const smoke = text("scripts/windows/director-bridge-runtime-smoke.ps1");
  const fixture = text("scripts/windows/fixtures/director-bridge-fake-runtime.cjs");
  const runtime = text("scripts/director-local-bridge.ts");
  const runtimeControl = text("src/director/runtimeControl.ts");

  assert.match(common, /DIRECTOR_BRIDGE_RUNTIME_PATH_REPARSE_POINT/);
  assert.match(common, /DIRECTOR_BRIDGE_RUNTIME_PRIVATE_PATH_TRACKED/);
  assert.match(common, /DIRECTOR_BRIDGE_RUNTIME_PRIVATE_PATH_NOT_IGNORED/);
  assert.match(common, /Get-CimInstance Win32_Process/);
  assert.match(common, /process_start_time_utc/);
  assert.match(common, /entrypoint_sha256/);
  assert.match(common, /build_manifest_sha256/);
  assert.match(common, /source_commit/);
  assert.match(common, /launch_config_sha256/);
  assert.match(common, /launch_argv_sha256/);
  assert.match(common, /director-bridge-activation\.json/);
  assert.match(common, /\[IO\.FileShare\]::None/);
  assert.match(common, /DIRECTOR_PROVIDER_MUST_BE_DISABLED/);
  assert.match(common, /DIRECTOR_BRIDGE_PLAINTEXT_KEY_FORBIDDEN/);
  assert.match(common, /DIRECTOR_BRIDGE_NODE_STARTUP_ENV_FORBIDDEN/);
  assert.match(common, /Get-DirectorBridgeLaunchEnvironmentSha256/);
  assert.match(common, /Start-DirectorBridgeNodeProcess/);
  assert.match(common, /SetEnvironmentVariable\(\[string\]\$name, \$null, "Process"\)/);
  assert.match(start, /Assert-DirectorBridgeNoNodeStartupEnvironment/);
  assert.match(start, /Add-DirectorBridgeRuntimeEnvironment/);
  assert.match(start, /Start-DirectorBridgeNodeProcess/);
  assert.match(start, /if \(\$assessment\.ProcessIdentity -eq "match"\)/);
  assert.match(start, /result = \$result/);
  assert.match(common, /AI_VIDEO_DIRECTOR_BRIDGE_HEARTBEAT_PATH/);
  assert.match(common, /AI_VIDEO_DIRECTOR_BRIDGE_STOP_REQUEST_PATH/);
  assert.match(runtime, /DirectorBridgeRuntimeControl\.fromEnvironment/);
  assert.match(runtimeControl, /director-bridge-launch-config-v2/);
  assert.match(runtimeControl, /startup_environment_sha256/);
  assert.match(runtimeControl, /name\.toUpperCase\(\)\.startsWith\("NODE_"\)/);
  assert.match(runtime, /managedRuntime\?\.stopRequested\(\)/);
  assert.match(smoke, /\$script:knownFixtureProcesses/);
  assert.match(smoke, /process_start_time_utc/);
  assert.match(smoke, /\$startMatches/);
  assert.doesNotMatch(smoke, /DIRECTOR_BRIDGE_RUNTIME_SMOKE_CLEANUP_IDENTITY_FAILED/);
  assert.match(common, /Get-DirectorBridgeFixtureFailureCode/);
  assert.match(common, /director-bridge-fixture-failure-v1/);
  assert.match(start, /Throw-DirectorBridgeChildExit/);
  assert.match(smoke, /DIRECTOR_BRIDGE_FIXTURE_DIAGNOSTIC_FAILURE/);
  assert.match(fixture, /director-bridge-fixture-failure-v1/);
  assert.doesNotMatch(fixture, /console\.(?:log|error|warn)/);
  assert.doesNotMatch(`${common}\n${start}\n${status}\n${stop}`, /AI_VIDEO_DIRECTOR_BRIDGE_RUNTIME_TEST_MODE/);
  assert.doesNotMatch(common, /Get-Content[^\r\n]*(?:WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH|AI_VIDEO_WORKSPACE_DB_PATH)/i);
  assert.doesNotMatch(common, /\[IO\.File\]::ReadAll(?:Text|Bytes)\([^\r\n]*(?:dpapi|database)/i);
  assert.doesNotMatch(status, /Get-Content.*(?:dpapi|database|sqlite)/i);
  assert.doesNotMatch(`${common}\n${start}\n${status}\n${stop}`, /Stop-Process/);
  assert.doesNotMatch(status, /\bpid\s*=/i);
  assert.doesNotMatch(status, /instance_id\s*=/i);
  assert.doesNotMatch(start, /database_path|remote_origin|dpapi|key_id/i);
});

test("Director Bridge fake-runtime smoke command is wired into canonical local and Windows CI scripts", () => {
  const packageJson = JSON.parse(text("package.json")) as { scripts: Record<string, string> };
  const workflow = text(".github/workflows/windows-ci.yml");
  assert.equal(packageJson.scripts["start:director:bridge"], "powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File scripts/windows/director-bridge-start.ps1");
  assert.match(packageJson.scripts["test:webgpt:director"], /director-bridge-windows-operations\.test\.js/);
  assert.match(packageJson.scripts["test:windows-runtime"], /npm run test:windows-runtime:workbench/);
  assert.match(packageJson.scripts["test:windows-runtime"], /npm run test:windows-runtime:director-bridge/);
  assert.match(packageJson.scripts["test:windows-runtime:director-bridge"], /director-bridge-runtime-smoke\.ps1/);
  assert.match(packageJson.scripts.test, /npm run test:windows-runtime/);
  assert.match(workflow, /name: Windows managed runtime controls\s+run: npm run test:windows-runtime/);
});
