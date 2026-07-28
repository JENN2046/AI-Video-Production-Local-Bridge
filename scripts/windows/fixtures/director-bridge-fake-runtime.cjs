const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const heartbeatPath = process.env.AI_VIDEO_DIRECTOR_BRIDGE_HEARTBEAT_PATH;
const stopRequestPath = process.env.AI_VIDEO_DIRECTOR_BRIDGE_STOP_REQUEST_PATH;
const activationPath = process.env.AI_VIDEO_DIRECTOR_BRIDGE_ACTIVATION_PATH;
const instanceId = process.env.AI_VIDEO_DIRECTOR_BRIDGE_INSTANCE_ID;
const sourceCommit = process.env.AI_VIDEO_DIRECTOR_BRIDGE_SOURCE_COMMIT;
const buildManifestSha256 = process.env.AI_VIDEO_DIRECTOR_BRIDGE_BUILD_MANIFEST_SHA256;
const entrypointSha256 = process.env.AI_VIDEO_DIRECTOR_BRIDGE_ENTRYPOINT_SHA256;
const expectedLaunchConfigSha256 = process.env.AI_VIDEO_DIRECTOR_BRIDGE_LAUNCH_CONFIG_SHA256;
const expectedLaunchArgvSha256 = process.env.AI_VIDEO_DIRECTOR_BRIDGE_LAUNCH_ARGV_SHA256;
const runtimeRoot = process.env.AI_VIDEO_DIRECTOR_BRIDGE_RUNTIME_ROOT;
const workspaceRoot = process.env.AI_VIDEO_DIRECTOR_BRIDGE_WORKSPACE_ROOT;
const mode = process.env.AI_VIDEO_DIRECTOR_BRIDGE_FIXTURE_MODE;

function fail() {
  process.exit(1);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalWindowsPath(value) {
  if (!value || !value.trim()) fail();
  return path.resolve(value).replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function actualLaunchArgvSha256() {
  if (!process.argv[1]) fail();
  return sha256Text([
    "director-bridge-launch-argv-v1",
    `node=${canonicalWindowsPath(process.execPath)}`,
    `entrypoint=${canonicalWindowsPath(process.argv[1])}`
  ].join("\n"));
}

function actualLaunchConfigSha256() {
  let origin;
  try {
    origin = new URL(process.env.WEBGPT_DIRECTOR_REMOTE_ORIGIN || "");
  } catch {
    fail();
  }
  if (origin.protocol !== "https:"
    || origin.username
    || origin.password
    || origin.search
    || origin.hash
    || origin.pathname !== "/") fail();
  const keyId = (process.env.WEBGPT_DIRECTOR_BRIDGE_KEY_ID || "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(keyId)) fail();
  if ((process.env.WEBGPT_DIRECTOR_BRIDGE_KEY_B64 || "").trim()) fail();
  if (process.env.REAL_PROVIDER_ENABLED !== "false"
    || process.env.M1_REAL_PROVIDER_EXECUTION_ALLOWED !== "false"
    || process.env.M1_REAL_PROVIDER_COST_ACK !== "false") fail();
  return sha256Text([
    "director-bridge-launch-config-v1",
    `remote_origin=${origin.origin.toLowerCase()}`,
    `database_path=${canonicalWindowsPath(process.env.AI_VIDEO_WORKSPACE_DB_PATH || "")}`,
    `dpapi_path=${canonicalWindowsPath(process.env.WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH || "")}`,
    `key_id=${keyId}`,
    "provider_enabled=false",
    "provider_execution_allowed=false",
    "provider_cost_acknowledged=false"
  ].join("\n"));
}

const required = [
  heartbeatPath,
  stopRequestPath,
  activationPath,
  instanceId,
  sourceCommit,
  buildManifestSha256,
  entrypointSha256,
  expectedLaunchConfigSha256,
  expectedLaunchArgvSha256,
  runtimeRoot,
  workspaceRoot
];
if (required.some((value) => !value) || mode !== "ready") fail();
if (actualLaunchConfigSha256() !== expectedLaunchConfigSha256
  || actualLaunchArgvSha256() !== expectedLaunchArgvSha256) fail();

function atomicWrite(target, value) {
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, target);
}

let activated = false;

function heartbeat(phase, stopRequested = false) {
  const now = new Date().toISOString();
  atomicWrite(heartbeatPath, {
    heartbeat_version: "director-bridge-heartbeat-v1",
    instance_id: instanceId,
    pid: process.pid,
    source_commit: sourceCommit,
    build_manifest_sha256: buildManifestSha256,
    entrypoint_sha256: entrypointSha256,
    launch_config_sha256: expectedLaunchConfigSha256,
    launch_argv_sha256: expectedLaunchArgvSha256,
    phase,
    heartbeat_at_utc: now,
    last_authenticated_poll_at_utc: activated ? now : null,
    last_request_completed_at_utc: null,
    consecutive_failures: 0,
    next_retry_at_utc: null,
    stable_error_code: null,
    stop_requested: stopRequested,
    completion_pending: false,
    provider_enabled: false
  });
}

function stopRequested() {
  if (!fs.existsSync(stopRequestPath)) return false;
  try {
    const value = JSON.parse(fs.readFileSync(stopRequestPath, "utf8"));
    return value.control_version === "director-bridge-control-v1"
      && value.instance_id === instanceId
      && value.action === "stop";
  } catch {
    return false;
  }
}

function activationRequested() {
  if (!fs.existsSync(activationPath)) return false;
  try {
    const value = JSON.parse(fs.readFileSync(activationPath, "utf8"));
    if (value.activation_version !== "director-bridge-activation-v1"
      || value.instance_id !== instanceId
      || value.action !== "activate") return false;
    fs.rmSync(activationPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

heartbeat("starting");
const timer = setInterval(() => {
  if (stopRequested()) {
    heartbeat("stopped", true);
    clearInterval(timer);
    process.exit(0);
  }
  if (!activated && activationRequested()) activated = true;
  heartbeat(activated ? "idle" : "starting");
}, 100);
