import {
  CHATGPT_MCP_READ_ONLY_LIVE_SMOKE_RECOMMENDED_PORT,
  startChatGptMcpReadOnlyLiveSmokeLocalEntry
} from "../src/index.js";

function parsePort(args: string[]): number {
  const index = args.indexOf("--port");
  if (index === -1) return CHATGPT_MCP_READ_ONLY_LIVE_SMOKE_RECOMMENDED_PORT;
  const raw = args[index + 1];
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  return parsed;
}

const entry = await startChatGptMcpReadOnlyLiveSmokeLocalEntry(parsePort(process.argv.slice(2)));

console.log(JSON.stringify({
  stage: "r2g-l-serve-read-only",
  transport: entry.transport,
  mcp_url: entry.mcpUrl,
  localhost_only: entry.localhost_only,
  public_endpoint: entry.public_endpoint,
  public_tunnel_started: entry.public_tunnel_started,
  chatgpt_connector_created: entry.chatgpt_connector_created,
  read_only_only: entry.read_only_only,
  allowed_tool_names: entry.allowed_tool_names
}, null, 2));

async function shutdown(): Promise<void> {
  await entry.close();
  process.exit(0);
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
