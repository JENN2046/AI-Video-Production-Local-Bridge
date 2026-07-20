import { resolve } from "node:path";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

import { parseReadonlyMediaCapabilityKeyringConfiguration } from "../src/webgpt-cloud/mediaCapability.js";
import { startReadonlyMediaGateway } from "../src/webgpt-media-gateway/runtime.js";

class MediaGatewayBootError extends Error {
  constructor(readonly code: string) { super(code); }
}

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new MediaGatewayBootError("MEDIA_GATEWAY_CONFIG_INVALID");
  return value;
}

function port(value: string | undefined): number {
  const parsed = Number(value ?? "2092");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new MediaGatewayBootError("MEDIA_GATEWAY_CONFIG_INVALID");
  }
  return parsed;
}

function mediaRoots(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error("invalid roots");
    }
    return parsed.map((item) => resolve(item));
  } catch {
    throw new MediaGatewayBootError("MEDIA_GATEWAY_CONFIG_INVALID");
  }
}

async function main(): Promise<void> {
  const activeKid = required("READONLY_MEDIA_GATEWAY_ACTIVE_KID");
  const activeKey = required("READONLY_MEDIA_GATEWAY_ACTIVE_KEY_B64URL");
  const previousValues = [
    process.env.READONLY_MEDIA_GATEWAY_PREVIOUS_KID?.trim() ?? "",
    process.env.READONLY_MEDIA_GATEWAY_PREVIOUS_KEY_B64URL?.trim() ?? "",
    process.env.READONLY_MEDIA_GATEWAY_PREVIOUS_ACCEPTED_FROM?.trim() ?? "",
    process.env.READONLY_MEDIA_GATEWAY_PREVIOUS_ACCEPTED_UNTIL?.trim() ?? ""
  ];
  if (previousValues.some(Boolean) && !previousValues.every(Boolean)) throw new MediaGatewayBootError("MEDIA_GATEWAY_CONFIG_INVALID");
  const keyring = parseReadonlyMediaCapabilityKeyringConfiguration({
    active_kid: activeKid,
    active_key: activeKey,
    previous_kid: previousValues[0],
    previous_key: previousValues[1],
    previous_accepted_from: previousValues[2],
    previous_accepted_until: previousValues[3]
  });
  const runtime = await startReadonlyMediaGateway({
    database_path: resolve(required("READONLY_MEDIA_GATEWAY_DATABASE_PATH")),
    issuer_hash: required("READONLY_MEDIA_GATEWAY_ISSUER_HASH"),
    keyring,
    allowed_origin: required("READONLY_MEDIA_GATEWAY_ALLOWED_ORIGIN"),
    allowed_media_roots: mediaRoots(process.env.READONLY_MEDIA_GATEWAY_ALLOWED_ROOTS_JSON),
    instance_probe: required("READONLY_MEDIA_GATEWAY_INSTANCE_PROBE"),
    port: port(process.env.READONLY_MEDIA_GATEWAY_PORT)
  });

  delete process.env.READONLY_MEDIA_GATEWAY_ACTIVE_KEY_B64URL;
  delete process.env.READONLY_MEDIA_GATEWAY_PREVIOUS_KEY_B64URL;
  delete process.env.READONLY_MEDIA_GATEWAY_INSTANCE_PROBE;

  const countsPath = process.env.READONLY_MEDIA_GATEWAY_COUNTS_PATH?.trim();
  delete process.env.READONLY_MEDIA_GATEWAY_COUNTS_PATH;
  const countsTimer = countsPath ? setInterval(() => {
    const temporary = `${countsPath}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, JSON.stringify({ ...runtime.counts(), updated_at: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, countsPath);
    } catch {
      try { unlinkSync(temporary); } catch { /* best-effort local status only */ }
    }
  }, 1_000) : undefined;
  countsTimer?.unref();

  const stop = async (): Promise<void> => {
    if (countsTimer) clearInterval(countsTimer);
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  const code = error instanceof MediaGatewayBootError ? error.code : "MEDIA_GATEWAY_START_FAILED";
  console.error(JSON.stringify({ ok: false, error: { code } }));
  process.exit(1);
});
