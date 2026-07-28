import { DirectorLocalBridgeClient } from "../src/director/bridge.js";
import { loadDirectorBridgeKeyring } from "../src/director/bridgeConfig.js";
import { createDirectorLocalService } from "../src/director/localService.js";
import {
  DirectorBridgeRuntimeControl,
  directorBridgeStableErrorCode
} from "../src/director/runtimeControl.js";

function exactOrigin(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("DIRECTOR_BRIDGE_ORIGIN_INVALID");
  }
  return parsed.toString();
}

let managedRuntime: DirectorBridgeRuntimeControl | null = null;

function environmentTrue(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === "true";
}

async function waitForNextPoll(milliseconds: number, stopping: () => boolean): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!stopping() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  }
}

function assertManagedRuntimeHealthy(): void {
  const code = managedRuntime?.fatalErrorCode();
  if (code) throw new Error(code);
}

async function main(): Promise<void> {
  if ([
    "REAL_PROVIDER_ENABLED",
    "M1_REAL_PROVIDER_EXECUTION_ALLOWED",
    "M1_REAL_PROVIDER_COST_ACK"
  ].some(environmentTrue)) {
    throw new Error("DIRECTOR_PROVIDER_MUST_BE_DISABLED");
  }
  managedRuntime = DirectorBridgeRuntimeControl.fromEnvironment(process.env);
  managedRuntime?.start();
  let stopping = false;
  const requestSignalStop = (): void => {
    stopping = true;
    managedRuntime?.requestStop();
  };
  process.once("SIGINT", requestSignalStop);
  process.once("SIGTERM", requestSignalStop);
  if (managedRuntime) {
    try {
      await managedRuntime.waitForActivation(60_000, () => stopping);
    } catch (error) {
      const fatalRuntimeCode = managedRuntime.fatalErrorCode();
      if (fatalRuntimeCode) throw new Error(fatalRuntimeCode);
      if (managedRuntime.stopRequested()) {
        managedRuntime.markStopped();
        return;
      }
      throw error;
    }
    assertManagedRuntimeHealthy();
    if (managedRuntime.stopRequested()) {
      managedRuntime.markStopped();
      return;
    }
  }
  const keyring = loadDirectorBridgeKeyring(process.env, "local_dpapi");
  if (!keyring) throw new Error("DIRECTOR_BRIDGE_KEY_REQUIRED");
  const databasePath = process.env.AI_VIDEO_WORKSPACE_DB_PATH?.trim() ?? "";
  if (!databasePath) throw new Error("DIRECTOR_DATABASE_PATH_REQUIRED");
  const client = new DirectorLocalBridgeClient({
    remote_origin: exactOrigin(process.env.WEBGPT_DIRECTOR_REMOTE_ORIGIN),
    client_id: "jenn-local-director",
    keyring,
    handlers: (actor) => createDirectorLocalService(actor, { database_path: databasePath, ffmpeg_path: process.env.FFMPEG_PATH }),
    on_phase: (phase) => managedRuntime?.setPhase(phase),
    should_stop: () => stopping || (managedRuntime?.stopRequested() ?? false)
  });
  const assertManagedRuntimeHealthyUnlessDraining = (): void => {
    if (!client.hasPendingCompletion()) assertManagedRuntimeHealthy();
  };
  let failures = 0;
  while (true) {
    assertManagedRuntimeHealthyUnlessDraining();
    const stopRequested = stopping || (managedRuntime?.stopRequested() ?? false);
    if (stopRequested && !client.hasPendingCompletion()) break;
    try {
      const handled = await client.runOnce();
      failures = 0;
      managedRuntime?.recordRemoteSuccess(handled);
      assertManagedRuntimeHealthyUnlessDraining();
      await waitForNextPoll(handled ? 0 : 1_000, () =>
        !client.hasPendingCompletion() && (stopping || (managedRuntime?.stopRequested() ?? false))
      );
      assertManagedRuntimeHealthyUnlessDraining();
    } catch (error) {
      assertManagedRuntimeHealthyUnlessDraining();
      failures = Math.min(6, failures + 1);
      const backoff = Math.min(30_000, 1_000 * 2 ** failures);
      managedRuntime?.recordBackoff(error, failures, new Date(Date.now() + backoff));
      await waitForNextPoll(backoff, () =>
        !client.hasPendingCompletion() && (stopping || (managedRuntime?.stopRequested() ?? false))
      );
      assertManagedRuntimeHealthyUnlessDraining();
    }
  }
  assertManagedRuntimeHealthy();
  managedRuntime?.setPhase("stopping");
  managedRuntime?.markStopped();
}

main().catch((error: unknown) => {
  try { managedRuntime?.markFailed(error); } catch { /* The stable boot receipt below remains the final fallback. */ }
  const code = directorBridgeStableErrorCode(error);
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event_type: "boot_failure", stable_error_code: code })}\n`);
  process.exit(1);
});
