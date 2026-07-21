import { DirectorLocalBridgeClient } from "../src/director/bridge.js";
import { loadDirectorBridgeKeyring } from "../src/director/bridgeConfig.js";
import { createDirectorLocalService } from "../src/director/localService.js";

function exactOrigin(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("DIRECTOR_BRIDGE_ORIGIN_INVALID");
  }
  return parsed.toString();
}

async function main(): Promise<void> {
  if (process.env.REAL_PROVIDER_ENABLED?.trim().toLowerCase() === "true") {
    throw new Error("DIRECTOR_PROVIDER_MUST_BE_DISABLED");
  }
  const keyring = loadDirectorBridgeKeyring();
  if (!keyring) throw new Error("DIRECTOR_BRIDGE_KEY_REQUIRED");
  const databasePath = process.env.AI_VIDEO_WORKSPACE_DB_PATH?.trim() ?? "";
  if (!databasePath) throw new Error("DIRECTOR_DATABASE_PATH_REQUIRED");
  const client = new DirectorLocalBridgeClient({
    remote_origin: exactOrigin(process.env.WEBGPT_DIRECTOR_REMOTE_ORIGIN),
    client_id: "jenn-local-director",
    keyring,
    handlers: (actor) => createDirectorLocalService(actor, { database_path: databasePath, ffmpeg_path: process.env.FFMPEG_PATH })
  });
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  let failures = 0;
  while (!stopping) {
    try {
      const handled = await client.runOnce();
      failures = 0;
      await new Promise((resolve) => setTimeout(resolve, handled ? 0 : 1_000));
    } catch {
      failures = Math.min(6, failures + 1);
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** failures)));
    }
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "DIRECTOR_LOCAL_BRIDGE_START_FAILED";
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event_type: "boot_failure", stable_error_code: code })}\n`);
  process.exit(1);
});
