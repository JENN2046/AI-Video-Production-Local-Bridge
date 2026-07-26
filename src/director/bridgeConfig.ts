import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { DirectorBridgeError, assertDirectorBridgeKeyring, type DirectorBridgeKeyring } from "./bridge.js";

export const DIRECTOR_BRIDGE_ENV_KEYS = [
  "WEBGPT_DIRECTOR_BRIDGE_KEY_ID",
  "WEBGPT_DIRECTOR_BRIDGE_KEY_B64",
  "WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH"
] as const;

export type DirectorBridgeKeySourcePolicy = "remote_environment" | "local_dpapi";

const DIRECTOR_BRIDGE_KEY_B64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeDirectorBridgeKey(encoded: string): Buffer {
  if (!DIRECTOR_BRIDGE_KEY_B64_PATTERN.test(encoded)) {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_KEY_INVALID", "Director bridge authentication is not configured correctly.");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== encoded) {
    key.fill(0);
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_KEY_INVALID", "Director bridge authentication is not configured correctly.");
  }
  return key;
}

function unprotectDirectorBridgeKey(path: string): Buffer {
  if (process.platform !== "win32") {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_KEY_DPAPI_UNAVAILABLE", "Director bridge DPAPI material is unavailable on this platform.");
  }
  let protectedText: string;
  try {
    protectedText = readFileSync(path, "utf8").trim();
  } catch {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_KEY_DPAPI_FAILED", "Director bridge DPAPI material could not be loaded.");
  }
  if (!DIRECTOR_BRIDGE_KEY_B64_PATTERN.test(protectedText)) {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_KEY_DPAPI_FAILED", "Director bridge DPAPI material could not be loaded.");
  }
  const command = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$encoded=[Console]::In.ReadToEnd().Trim()",
    "$protected=$null; $plain=$null",
    "try { $protected=[Convert]::FromBase64String($encoded); $plain=[System.Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); if ($plain.Length -ne 32) { exit 1 }; [Console]::Out.Write([Convert]::ToBase64String($plain)) } finally { if ($null -ne $plain) { [Array]::Clear($plain,0,$plain.Length) }; if ($null -ne $protected) { [Array]::Clear($protected,0,$protected.Length) } }"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command", command], {
    input: protectedText,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1_024
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_KEY_DPAPI_FAILED", "Director bridge DPAPI material could not be loaded.");
  }
  try {
    return decodeDirectorBridgeKey(result.stdout.trim());
  } catch {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_KEY_DPAPI_FAILED", "Director bridge DPAPI material could not be loaded.");
  }
}

export function loadDirectorBridgeKeyring(
  env: NodeJS.ProcessEnv = process.env,
  sourcePolicy: DirectorBridgeKeySourcePolicy = "remote_environment"
): DirectorBridgeKeyring | null {
  if (sourcePolicy !== "remote_environment" && sourcePolicy !== "local_dpapi") {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_KEY_INVALID", "Director bridge authentication is not configured correctly.");
  }
  const kid = env.WEBGPT_DIRECTOR_BRIDGE_KEY_ID?.trim() ?? "";
  const encoded = env.WEBGPT_DIRECTOR_BRIDGE_KEY_B64?.trim() ?? "";
  const dpapiPath = env.WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH?.trim() ?? "";
  if (!kid && !encoded && !dpapiPath) return null;
  if (!kid || (encoded && dpapiPath) || (!encoded && !dpapiPath)) {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_KEY_INVALID", "Director bridge authentication is not configured correctly.");
  }
  if ((sourcePolicy === "remote_environment" && !encoded) || (sourcePolicy === "local_dpapi" && !dpapiPath)) {
    throw new DirectorBridgeError("DIRECTOR_BRIDGE_KEY_SOURCE_FORBIDDEN", "Director bridge key material is not permitted for this runtime.");
  }
  const key = sourcePolicy === "remote_environment" ? decodeDirectorBridgeKey(encoded) : unprotectDirectorBridgeKey(dpapiPath);
  try {
    const keyring = { active: { kid, key } };
    assertDirectorBridgeKeyring(keyring);
    return keyring;
  } catch (error) {
    key.fill(0);
    throw error;
  }
}
