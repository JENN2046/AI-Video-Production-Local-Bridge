import { createPublicKey } from "node:crypto";

import { loadWebGptV4AuthConfig } from "../src/webgpt-v4/auth.js";
import { startReadonlyRemoteRuntime } from "../src/webgpt-cloud/remoteRuntime.js";

class ReadonlyRemoteConfigError extends Error {
  constructor(readonly code: string) { super(code); }
}

function port(value: string | undefined): number {
  const parsed = Number(value ?? "10000");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new ReadonlyRemoteConfigError("READONLY_REMOTE_PORT_INVALID");
  return parsed;
}

function publisherConfig(env: NodeJS.ProcessEnv): { publisher_key_id?: string; publisher_public_key?: string } {
  const keyId = env.WEBGPT_CLOUD_PUBLISHER_KEY_ID?.trim() ?? "";
  const encoded = env.WEBGPT_CLOUD_PUBLISHER_PUBLIC_KEY_B64?.trim() ?? "";
  if (!keyId && !encoded) return {};
  if (!keyId || !encoded || !/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) throw new ReadonlyRemoteConfigError("READONLY_REMOTE_PUBLISHER_CONFIG_INVALID");
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("invalid base64");
    const pem = Buffer.from(encoded, "base64").toString("utf8");
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("invalid key");
    return { publisher_key_id: keyId, publisher_public_key: pem };
  } catch {
    throw new ReadonlyRemoteConfigError("READONLY_REMOTE_PUBLISHER_CONFIG_INVALID");
  }
}

async function main(): Promise<void> {
  const authConfig = loadWebGptV4AuthConfig("readonly", process.env);
  if (authConfig && authConfig.provider !== "federated") {
    throw new ReadonlyRemoteConfigError("READONLY_REMOTE_AUTH_CONFIG_INVALID");
  }
  const runtime = await startReadonlyRemoteRuntime({
    host: "0.0.0.0",
    port: port(process.env.PORT),
    auth_config: authConfig,
    ...publisherConfig(process.env),
    log: (event) => console.log(JSON.stringify(event))
  });
  const stop = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  const code = error instanceof ReadonlyRemoteConfigError ? error.code : "READONLY_REMOTE_START_FAILED";
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), event_type: "boot_failure", stable_error_code: code }));
  process.exit(1);
});
