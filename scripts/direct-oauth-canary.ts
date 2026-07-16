import { startDirectOAuthCanary } from "../src/webgpt-canary/directOAuthCanary.js";

const portValue = process.env.PORT ?? process.env.DIRECT_OAUTH_CANARY_PORT ?? "10000";
const port = Number(portValue);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("INVALID_DIRECT_OAUTH_CANARY_PORT");

const runtime = await startDirectOAuthCanary({ port });
process.stdout.write(`Direct OAuth canary listening on port ${runtime.port}.\n`);

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  void runtime.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
