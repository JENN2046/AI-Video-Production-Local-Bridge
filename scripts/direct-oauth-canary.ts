import { startDirectOAuthCanary } from "../src/webgpt-canary/directOAuthCanary.js";
import { loadWebGptV4AuthConfig } from "../src/webgpt-v4/auth.js";

function portFromEnvironment(): number {
  const value = process.env.PORT ?? process.env.DIRECT_OAUTH_CANARY_PORT ?? "10000";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("INVALID_DIRECT_OAUTH_CANARY_PORT");
  return port;
}

function originsFromEnvironment(): string[] {
  return (process.env.DIRECT_OAUTH_CANARY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const authConfig = loadWebGptV4AuthConfig("readonly");
if (!authConfig) throw new Error("INVALID_WEBGPT_AUTH_CONFIG");

const runtime = await startDirectOAuthCanary({
  host: process.env.DIRECT_OAUTH_CANARY_HOST?.trim() || undefined,
  port: portFromEnvironment(),
  allowed_origins: originsFromEnvironment(),
  auth_config: authConfig
});
process.stdout.write(`Direct OAuth canary listening on ${runtime.mcp_url}.\n`);

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  void runtime.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
