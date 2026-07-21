import { DirectorBridgeError, assertDirectorBridgeKeyring, type DirectorBridgeKeyring } from "./bridge.js";

export const DIRECTOR_BRIDGE_ENV_KEYS = [
  "WEBGPT_DIRECTOR_BRIDGE_KEY_ID",
  "WEBGPT_DIRECTOR_BRIDGE_KEY_B64"
] as const;

export function loadDirectorBridgeKeyring(env: NodeJS.ProcessEnv = process.env): DirectorBridgeKeyring | null {
  const kid = env.WEBGPT_DIRECTOR_BRIDGE_KEY_ID?.trim() ?? "";
  const encoded = env.WEBGPT_DIRECTOR_BRIDGE_KEY_B64?.trim() ?? "";
  if (!kid && !encoded) return null;
  if (!kid || !encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_KEY_INVALID", "Director bridge authentication is not configured correctly.");
  }
  const keyring = { active: { kid, key: Buffer.from(encoded, "base64") } };
  assertDirectorBridgeKeyring(keyring);
  return keyring;
}
