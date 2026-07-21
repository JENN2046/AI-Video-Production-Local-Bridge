import { loadDirectorBridgeKeyring } from "../src/director/bridgeConfig.js";
import { loadDirectorOAuthConfig } from "../src/director/oauth.js";
import { startDirectorRemoteRuntime } from "../src/director/remoteRuntime.js";

function port(value: string | undefined): number {
  const parsed = Number(value ?? "10000");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("DIRECTOR_REMOTE_PORT_INVALID");
  return parsed;
}

async function main(): Promise<void> {
  const keyring = loadDirectorBridgeKeyring();
  if (!keyring) throw new Error("DIRECTOR_BRIDGE_KEY_REQUIRED");
  const runtime = await startDirectorRemoteRuntime({
    host: "0.0.0.0", port: port(process.env.PORT), auth_config: loadDirectorOAuthConfig(), bridge_keyring: keyring
  });
  const stop = async (): Promise<void> => { await runtime.close(); process.exit(0); };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "DIRECTOR_REMOTE_START_FAILED";
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event_type: "boot_failure", stable_error_code: code })}\n`);
  process.exit(1);
});
