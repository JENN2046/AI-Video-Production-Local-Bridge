import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

export const DIRECTOR_BRIDGE_HEARTBEAT_VERSION = "director-bridge-heartbeat-v1";
export const DIRECTOR_BRIDGE_CONTROL_VERSION = "director-bridge-control-v1";
export const DIRECTOR_BRIDGE_ACTIVATION_VERSION = "director-bridge-activation-v1";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const instanceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestampSchema = z.iso.datetime();
const stableErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,95}$/);

export type DirectorBridgeRuntimePhase =
  | "starting"
  | "polling"
  | "idle"
  | "handling"
  | "completing"
  | "backoff"
  | "stopping"
  | "stopped"
  | "failed";

export const DIRECTOR_BRIDGE_HEARTBEAT_SCHEMA = z.object({
  heartbeat_version: z.literal(DIRECTOR_BRIDGE_HEARTBEAT_VERSION),
  instance_id: instanceIdSchema,
  pid: z.number().int().positive(),
  source_commit: z.string().regex(/^[0-9a-f]{40}$/),
  build_manifest_sha256: sha256Schema,
  entrypoint_sha256: sha256Schema,
  launch_config_sha256: sha256Schema,
  launch_argv_sha256: sha256Schema,
  phase: z.enum(["starting", "polling", "idle", "handling", "completing", "backoff", "stopping", "stopped", "failed"]),
  heartbeat_at_utc: timestampSchema,
  last_authenticated_poll_at_utc: timestampSchema.nullable(),
  last_request_completed_at_utc: timestampSchema.nullable(),
  consecutive_failures: z.number().int().min(0).max(6),
  next_retry_at_utc: timestampSchema.nullable(),
  stable_error_code: stableErrorCodeSchema.nullable(),
  stop_requested: z.boolean(),
  completion_pending: z.boolean(),
  provider_enabled: z.literal(false)
}).strict();

export type DirectorBridgeHeartbeat = z.infer<typeof DIRECTOR_BRIDGE_HEARTBEAT_SCHEMA>;

export const DIRECTOR_BRIDGE_CONTROL_SCHEMA = z.object({
  control_version: z.literal(DIRECTOR_BRIDGE_CONTROL_VERSION),
  instance_id: instanceIdSchema,
  action: z.literal("stop"),
  requested_at_utc: timestampSchema
}).strict();

export const DIRECTOR_BRIDGE_ACTIVATION_SCHEMA = z.object({
  activation_version: z.literal(DIRECTOR_BRIDGE_ACTIVATION_VERSION),
  instance_id: instanceIdSchema,
  action: z.literal("activate"),
  activated_at_utc: timestampSchema
}).strict();

interface DirectorBridgeRuntimeControlOptions {
  runtime_root: string;
  heartbeat_path: string;
  stop_request_path: string;
  activation_path: string;
  instance_id: string;
  source_commit: string;
  build_manifest_sha256: string;
  entrypoint_sha256: string;
  launch_config_sha256: string;
  launch_argv_sha256: string;
  workspace_root?: string;
  now?: () => Date;
  heartbeat_interval_ms?: number;
}

function exactSameText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalWindowsPath(value: string): string {
  if (!value.trim()) throw new Error("DIRECTOR_BRIDGE_RUNTIME_LAUNCH_IDENTITY_INVALID");
  return resolve(value).replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function actualLaunchArgvSha256(): string {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error("DIRECTOR_BRIDGE_RUNTIME_LAUNCH_IDENTITY_INVALID");
  return sha256Text([
    "director-bridge-launch-argv-v1",
    `node=${canonicalWindowsPath(process.execPath)}`,
    `entrypoint=${canonicalWindowsPath(entrypoint)}`
  ].join("\n"));
}

const launchEnvironmentNames = [
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

function actualLaunchEnvironmentSha256(environment: NodeJS.ProcessEnv): string {
  const canonical = ["director-bridge-launch-environment-v1"];
  for (const name of launchEnvironmentNames) {
    const value = environment[name];
    if (value === undefined || value.trim() === "") continue;
    canonical.push(`name=${name.toUpperCase()}`);
    canonical.push(`value_sha256=${sha256Text(value)}`);
  }
  return sha256Text(canonical.join("\n"));
}

function actualLaunchConfigSha256(environment: NodeJS.ProcessEnv): string {
  if (Object.keys(environment).some((name) => name.toUpperCase().startsWith("NODE_"))) {
    throw new Error("DIRECTOR_BRIDGE_RUNTIME_LAUNCH_IDENTITY_INVALID");
  }
  const originValue = environment.WEBGPT_DIRECTOR_REMOTE_ORIGIN?.trim() ?? "";
  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    throw new Error("DIRECTOR_BRIDGE_RUNTIME_LAUNCH_IDENTITY_INVALID");
  }
  if (origin.protocol !== "https:"
    || origin.username
    || origin.password
    || origin.search
    || origin.hash
    || origin.pathname !== "/") {
    throw new Error("DIRECTOR_BRIDGE_RUNTIME_LAUNCH_IDENTITY_INVALID");
  }
  const keyId = environment.WEBGPT_DIRECTOR_BRIDGE_KEY_ID?.trim() ?? "";
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(keyId)) {
    throw new Error("DIRECTOR_BRIDGE_RUNTIME_LAUNCH_IDENTITY_INVALID");
  }
  if ((environment.WEBGPT_DIRECTOR_BRIDGE_KEY_B64?.trim() ?? "").length > 0) {
    throw new Error("DIRECTOR_BRIDGE_PLAINTEXT_KEY_FORBIDDEN");
  }
  const providerValues = [
    environment.REAL_PROVIDER_ENABLED,
    environment.M1_REAL_PROVIDER_EXECUTION_ALLOWED,
    environment.M1_REAL_PROVIDER_COST_ACK
  ].map((value) => value?.trim().toLowerCase() ?? "");
  if (providerValues.some((value) => value !== "false")) {
    throw new Error("DIRECTOR_PROVIDER_MUST_BE_DISABLED");
  }
  return sha256Text([
    "director-bridge-launch-config-v2",
    `remote_origin=${origin.origin.toLowerCase()}`,
    `database_path=${canonicalWindowsPath(environment.AI_VIDEO_WORKSPACE_DB_PATH ?? "")}`,
    `dpapi_path=${canonicalWindowsPath(environment.WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH ?? "")}`,
    `key_id=${keyId}`,
    "provider_enabled=false",
    "provider_execution_allowed=false",
    "provider_cost_acknowledged=false",
    `startup_environment_sha256=${actualLaunchEnvironmentSha256(environment)}`
  ].join("\n"));
}

function atomicWriteJson(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function stableCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && stableErrorCodeSchema.safeParse(code).success) return code;
  }
  if (error instanceof Error && stableErrorCodeSchema.safeParse(error.message).success) return error.message;
  return "DIRECTOR_BRIDGE_RUNTIME_FAILED";
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function assertPrivateRuntimeRoot(runtimeRoot: string, workspaceRoot: string): void {
  if (!isAbsolute(runtimeRoot) || !isAbsolute(workspaceRoot)) {
    throw new Error("DIRECTOR_BRIDGE_RUNTIME_CONTROL_INVALID");
  }
  const workspace = realpathSync(workspaceRoot);
  const runtime = realpathSync(runtimeRoot);
  if (!samePath(resolve(workspaceRoot), workspace) || !samePath(resolve(runtimeRoot), runtime)) {
    throw new Error("DIRECTOR_BRIDGE_RUNTIME_CONTROL_INVALID");
  }
  const withinWorkspace = relative(workspace, runtime);
  if (!withinWorkspace || isAbsolute(withinWorkspace) || withinWorkspace === ".." || withinWorkspace.startsWith(`..${sep}`)) {
    throw new Error("DIRECTOR_BRIDGE_RUNTIME_CONTROL_INVALID");
  }
  let current = workspace;
  for (const segment of withinWorkspace.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error("DIRECTOR_BRIDGE_RUNTIME_CONTROL_INVALID");
  }
}

function assertManagedWorkingDirectory(workspaceRoot: string): void {
  try {
    if (!samePath(realpathSync(process.cwd()), realpathSync(workspaceRoot))) {
      throw new Error("DIRECTOR_BRIDGE_RUNTIME_LAUNCH_IDENTITY_INVALID");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "DIRECTOR_BRIDGE_RUNTIME_LAUNCH_IDENTITY_INVALID") throw error;
    throw new Error("DIRECTOR_BRIDGE_RUNTIME_LAUNCH_IDENTITY_INVALID");
  }
}

function assertControlFileSafe(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("DIRECTOR_BRIDGE_RUNTIME_CONTROL_INVALID");
  }
}

export class DirectorBridgeRuntimeControl {
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private phase: DirectorBridgeRuntimePhase = "starting";
  private lastAuthenticatedPollAt: string | null = null;
  private lastRequestCompletedAt: string | null = null;
  private consecutiveFailures = 0;
  private nextRetryAt: string | null = null;
  private errorCode: string | null = null;
  private requestedStop = false;
  private fatalRuntimeCode: string | null = null;
  private completionPending = false;

  constructor(private readonly options: DirectorBridgeRuntimeControlOptions) {
    const parsed = z.object({
      runtime_root: z.string().min(1),
      heartbeat_path: z.string().min(1),
      stop_request_path: z.string().min(1),
      activation_path: z.string().min(1),
      instance_id: instanceIdSchema,
      source_commit: z.string().regex(/^[0-9a-f]{40}$/),
      build_manifest_sha256: sha256Schema,
      entrypoint_sha256: sha256Schema,
      launch_config_sha256: sha256Schema,
      launch_argv_sha256: sha256Schema
    }).strict().safeParse({
      runtime_root: options.runtime_root,
      heartbeat_path: options.heartbeat_path,
      stop_request_path: options.stop_request_path,
      activation_path: options.activation_path,
      instance_id: options.instance_id,
      source_commit: options.source_commit,
      build_manifest_sha256: options.build_manifest_sha256,
      entrypoint_sha256: options.entrypoint_sha256,
      launch_config_sha256: options.launch_config_sha256,
      launch_argv_sha256: options.launch_argv_sha256
    });
    if (!parsed.success
      || !isAbsolute(options.heartbeat_path)
      || !isAbsolute(options.stop_request_path)
      || !isAbsolute(options.activation_path)
      || !samePath(dirname(options.heartbeat_path), options.runtime_root)
      || !samePath(dirname(options.stop_request_path), options.runtime_root)
      || !samePath(dirname(options.activation_path), options.runtime_root)
      || basename(options.heartbeat_path) !== "director-bridge-heartbeat.json"
      || basename(options.stop_request_path) !== "director-bridge-stop-request.json"
      || basename(options.activation_path) !== "director-bridge-activation.json") {
      throw new Error("DIRECTOR_BRIDGE_RUNTIME_CONTROL_INVALID");
    }
    assertPrivateRuntimeRoot(options.runtime_root, options.workspace_root ?? process.cwd());
    assertControlFileSafe(options.heartbeat_path);
    assertControlFileSafe(options.stop_request_path);
    assertControlFileSafe(options.activation_path);
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.heartbeat_interval_ms ?? 5_000;
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 100 || this.intervalMs > 30_000) {
      throw new Error("DIRECTOR_BRIDGE_RUNTIME_CONTROL_INVALID");
    }
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv): DirectorBridgeRuntimeControl | null {
    const names = [
      "AI_VIDEO_DIRECTOR_BRIDGE_HEARTBEAT_PATH",
      "AI_VIDEO_DIRECTOR_BRIDGE_STOP_REQUEST_PATH",
      "AI_VIDEO_DIRECTOR_BRIDGE_ACTIVATION_PATH",
      "AI_VIDEO_DIRECTOR_BRIDGE_INSTANCE_ID",
      "AI_VIDEO_DIRECTOR_BRIDGE_SOURCE_COMMIT",
      "AI_VIDEO_DIRECTOR_BRIDGE_BUILD_MANIFEST_SHA256",
      "AI_VIDEO_DIRECTOR_BRIDGE_ENTRYPOINT_SHA256",
      "AI_VIDEO_DIRECTOR_BRIDGE_LAUNCH_CONFIG_SHA256",
      "AI_VIDEO_DIRECTOR_BRIDGE_LAUNCH_ARGV_SHA256",
      "AI_VIDEO_DIRECTOR_BRIDGE_RUNTIME_ROOT",
      "AI_VIDEO_DIRECTOR_BRIDGE_WORKSPACE_ROOT"
    ] as const;
    const values = names.map((name) => environment[name]?.trim() ?? "");
    if (values.every((value) => value.length === 0)) return null;
    if (values.some((value) => value.length === 0)) throw new Error("DIRECTOR_BRIDGE_RUNTIME_CONTROL_INVALID");
    if (!exactSameText(actualLaunchConfigSha256(environment), values[7])
      || !exactSameText(actualLaunchArgvSha256(), values[8])) {
      throw new Error("DIRECTOR_BRIDGE_RUNTIME_LAUNCH_IDENTITY_INVALID");
    }
    assertManagedWorkingDirectory(values[10]);
    return new DirectorBridgeRuntimeControl({
      heartbeat_path: values[0],
      stop_request_path: values[1],
      activation_path: values[2],
      instance_id: values[3],
      source_commit: values[4],
      build_manifest_sha256: values[5],
      entrypoint_sha256: values[6],
      launch_config_sha256: values[7],
      launch_argv_sha256: values[8],
      runtime_root: values[9],
      workspace_root: values[10]
    });
  }

  start(): void {
    if (this.timer) throw new Error("DIRECTOR_BRIDGE_RUNTIME_CONTROL_INVALID");
    this.writeHeartbeat();
    this.timer = setInterval(() => {
      try {
        this.pulse();
      } catch {
        this.fatalRuntimeCode = "DIRECTOR_BRIDGE_RUNTIME_HEARTBEAT_FAILED";
        this.requestedStop = true;
        this.phase = "stopping";
      }
    }, this.intervalMs);
  }

  setPhase(phase: Exclude<DirectorBridgeRuntimePhase, "starting" | "stopped" | "failed">): void {
    if (phase === "idle" || phase === "handling") this.lastAuthenticatedPollAt = this.now().toISOString();
    if (phase === "handling" || phase === "completing") this.completionPending = true;
    this.phase = this.requestedStop ? "stopping" : phase;
    this.safeWriteHeartbeat();
  }

  recordRemoteSuccess(handled: boolean): void {
    const completedAt = this.now().toISOString();
    this.lastAuthenticatedPollAt = completedAt;
    if (handled) {
      this.lastRequestCompletedAt = completedAt;
      this.completionPending = false;
    }
    this.consecutiveFailures = 0;
    this.nextRetryAt = null;
    this.errorCode = null;
    this.phase = this.requestedStop ? "stopping" : "idle";
    this.safeWriteHeartbeat();
  }

  recordBackoff(error: unknown, failures: number, retryAt: Date): void {
    this.consecutiveFailures = Math.max(0, Math.min(6, failures));
    this.nextRetryAt = retryAt.toISOString();
    this.errorCode = stableCode(error);
    this.phase = this.requestedStop ? "stopping" : "backoff";
    this.safeWriteHeartbeat();
  }

  stopRequested(): boolean {
    this.refreshStopRequest();
    return this.requestedStop;
  }

  requestStop(): void {
    this.requestedStop = true;
    this.phase = "stopping";
    this.safeWriteHeartbeat();
  }

  fatalErrorCode(): string | null {
    return this.fatalRuntimeCode;
  }

  hasPendingCompletion(): boolean {
    return this.completionPending;
  }

  async waitForActivation(timeoutMs = 60_000, externallyStopping: () => boolean = () => false): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (externallyStopping()) {
        this.requestedStop = true;
        this.phase = "stopping";
        this.safeWriteHeartbeat();
      }
      this.refreshStopRequest();
      if (this.requestedStop) throw new Error("DIRECTOR_BRIDGE_RUNTIME_STOP_REQUESTED");
      if (existsSync(this.options.activation_path)) {
        try {
          assertControlFileSafe(this.options.activation_path);
          const activation = DIRECTOR_BRIDGE_ACTIVATION_SCHEMA.parse(
            JSON.parse(readFileSync(this.options.activation_path, "utf8")) as unknown
          );
          if (exactSameText(activation.instance_id, this.options.instance_id)) {
            rmSync(this.options.activation_path, { force: true });
            return;
          }
        } catch {
          // A stale or malformed activation never starts the Bridge.
        }
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error("DIRECTOR_BRIDGE_RUNTIME_ACTIVATION_TIMEOUT");
  }

  markStopped(): void {
    if (this.completionPending) throw new Error("DIRECTOR_BRIDGE_COMPLETION_UNCONFIRMED");
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.requestedStop = true;
    this.phase = "stopped";
    this.nextRetryAt = null;
    this.writeHeartbeat();
  }

  markFailed(error: unknown): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.phase = "failed";
    this.errorCode = stableCode(error);
    this.nextRetryAt = null;
    this.safeWriteHeartbeat();
  }

  private pulse(): void {
    this.refreshStopRequest();
    this.writeHeartbeat();
  }

  private refreshStopRequest(): void {
    if (this.requestedStop || !existsSync(this.options.stop_request_path)) return;
    try {
      assertControlFileSafe(this.options.stop_request_path);
      const parsed = DIRECTOR_BRIDGE_CONTROL_SCHEMA.parse(
        JSON.parse(readFileSync(this.options.stop_request_path, "utf8")) as unknown
      );
      if (exactSameText(parsed.instance_id, this.options.instance_id)) {
        this.requestedStop = true;
        this.phase = "stopping";
      }
    } catch {
      // Invalid or stale control files never disclose details and cannot stop this instance.
    }
  }

  private writeHeartbeat(): void {
    const heartbeat = DIRECTOR_BRIDGE_HEARTBEAT_SCHEMA.parse({
      heartbeat_version: DIRECTOR_BRIDGE_HEARTBEAT_VERSION,
      instance_id: this.options.instance_id,
      pid: process.pid,
      source_commit: this.options.source_commit,
      build_manifest_sha256: this.options.build_manifest_sha256,
      entrypoint_sha256: this.options.entrypoint_sha256,
      launch_config_sha256: this.options.launch_config_sha256,
      launch_argv_sha256: this.options.launch_argv_sha256,
      phase: this.phase,
      heartbeat_at_utc: this.now().toISOString(),
      last_authenticated_poll_at_utc: this.lastAuthenticatedPollAt,
      last_request_completed_at_utc: this.lastRequestCompletedAt,
      consecutive_failures: this.consecutiveFailures,
      next_retry_at_utc: this.nextRetryAt,
      stable_error_code: this.errorCode,
      stop_requested: this.requestedStop,
      completion_pending: this.completionPending,
      provider_enabled: false
    });
    atomicWriteJson(this.options.heartbeat_path, heartbeat);
  }

  private safeWriteHeartbeat(): void {
    if (this.fatalRuntimeCode) return;
    try {
      this.writeHeartbeat();
    } catch {
      this.fatalRuntimeCode = "DIRECTOR_BRIDGE_RUNTIME_HEARTBEAT_FAILED";
      this.requestedStop = true;
      this.phase = "stopping";
    }
  }
}

export function directorBridgeStableErrorCode(error: unknown): string {
  return stableCode(error);
}
