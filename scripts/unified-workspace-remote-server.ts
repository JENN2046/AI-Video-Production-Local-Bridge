import { createPublicKey } from "node:crypto";

import { loadDirectorBridgeKeyring } from "../src/director/bridgeConfig.js";
import { loadUnifiedWorkspaceOAuthConfig } from "../src/unified-workspace/oauth.js";
import { startUnifiedWorkspaceRemoteRuntime } from "../src/unified-workspace/remoteRuntime.js";
import { loadWebGptV4AuthConfig } from "../src/webgpt-v4/auth.js";
import { loadReadonlyMediaGatewayClientOptions } from "../src/webgpt-cloud/mediaGatewayClient.js";

class UnifiedWorkspaceRemoteConfigError extends Error {
  constructor(readonly code: string) { super(code); }
}

const SPKI_PUBLIC_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?$/;

function stableBootFailureCode(error: unknown): string {
  if (error instanceof UnifiedWorkspaceRemoteConfigError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)) {
    return error.code;
  }
  return "UNIFIED_WORKSPACE_REMOTE_START_FAILED";
}

function port(value: string | undefined): number {
  const parsed = Number(value ?? "10000");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new UnifiedWorkspaceRemoteConfigError("UNIFIED_WORKSPACE_REMOTE_PORT_INVALID");
  return parsed;
}

function publisherConfig(env: NodeJS.ProcessEnv, prefix: "WEBGPT_WORKSPACE" | "WEBGPT_CLOUD", failureCode: string): { publisher_key_id?: string; publisher_public_key?: string } {
  const keyId = env[`${prefix}_PUBLISHER_KEY_ID`]?.trim() ?? "";
  const encoded = env[`${prefix}_PUBLISHER_PUBLIC_KEY_B64`]?.trim() ?? "";
  if (!keyId && !encoded) return {};
  if (!keyId || !encoded || !/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) throw new UnifiedWorkspaceRemoteConfigError(failureCode);
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("invalid base64");
    const pem = Buffer.from(encoded, "base64").toString("utf8");
    // `createPublicKey()` can derive a public key from PKCS#8 private input.
    // The remote process must retain only an explicitly encoded SPKI public key.
    if (!SPKI_PUBLIC_PEM.test(pem)) throw new Error("public SPKI PEM required");
    if (createPublicKey(pem).asymmetricKeyType !== "ed25519") throw new Error("invalid key");
    return { publisher_key_id: keyId, publisher_public_key: pem };
  } catch {
    throw new UnifiedWorkspaceRemoteConfigError(failureCode);
  }
}

async function main(): Promise<void> {
  const legacy = loadWebGptV4AuthConfig("readonly", process.env);
  if (legacy && (legacy.provider !== "federated" || legacy.access_model !== "project_membership")) {
    throw new UnifiedWorkspaceRemoteConfigError("UNIFIED_WORKSPACE_LEGACY_AUTH_CONFIG_INVALID");
  }
  const mediaGateway = loadReadonlyMediaGatewayClientOptions(process.env) ?? undefined;
  const runtime = await startUnifiedWorkspaceRemoteRuntime({
    host: "0.0.0.0",
    port: port(process.env.PORT),
    auth_config: loadUnifiedWorkspaceOAuthConfig(process.env),
    bridge_keyring: loadDirectorBridgeKeyring(process.env),
    media_gateway: mediaGateway,
    ...publisherConfig(process.env, "WEBGPT_WORKSPACE", "UNIFIED_WORKSPACE_PUBLISHER_CONFIG_INVALID"),
    legacy_readonly: legacy ? {
      auth_config: legacy,
      media_gateway: mediaGateway,
      ...publisherConfig(process.env, "WEBGPT_CLOUD", "UNIFIED_WORKSPACE_LEGACY_PUBLISHER_CONFIG_INVALID")
    } : undefined,
    log: (event) => console.log(JSON.stringify(event))
  });
  const stop = async (): Promise<void> => { await runtime.close(); process.exit(0); };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  const code = stableBootFailureCode(error);
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event_type: "boot_failure", stable_error_code: code })}\n`);
  process.exit(1);
});
