import { startWebGptV4, WEBGPT_V4_MCP_PORT, WEBGPT_V4_MEDIA_PORT } from "../src/webgpt-v4/server.js";

const mcpPort = Number(process.env.WEBGPT_V4_MCP_PORT ?? WEBGPT_V4_MCP_PORT);
const mediaPort = Number(process.env.WEBGPT_V4_MEDIA_PORT ?? WEBGPT_V4_MEDIA_PORT);
const publicMediaOrigin = process.env.WEBGPT_V4_MEDIA_PUBLIC_ORIGIN?.trim() || `http://127.0.0.1:${mediaPort}`;

const runtime = await startWebGptV4({ mcp_port: mcpPort, media_port: mediaPort, media: { public_origin: publicMediaOrigin } });
console.log(`WebGPT V4 MCP: ${runtime.mcp_url}`);
console.log(`WebGPT V4 Media: ${runtime.media_url}`);
console.log(`OAuth configured: ${runtime.auth_configured}`);

const shutdown = async (): Promise<void> => {
  await runtime.close();
  process.exit(0);
};

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
