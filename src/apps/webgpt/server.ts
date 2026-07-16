import { startWebGptV4, WEBGPT_V4_MCP_PORT, WEBGPT_V4_MEDIA_PORT } from "../../webgpt-v4/server.js";
import { createBenchmarkFakeIpRecoveringResolver } from "../../net/pinnedHttpsTransport.js";

export async function startWebGptApplication(): Promise<Awaited<ReturnType<typeof startWebGptV4>>> {
  const mcpPort = Number(process.env.WEBGPT_V4_MCP_PORT ?? WEBGPT_V4_MCP_PORT);
  const mediaPort = Number(process.env.WEBGPT_V4_MEDIA_PORT ?? WEBGPT_V4_MEDIA_PORT);
  const publicMediaOrigin = process.env.WEBGPT_V4_MEDIA_PUBLIC_ORIGIN?.trim() || `http://127.0.0.1:${mediaPort}`;
  return startWebGptV4({
    profile: process.env.WEBGPT_V4_PROFILE,
    auth_transport: { resolve_hostname: createBenchmarkFakeIpRecoveringResolver() },
    mcp_port: mcpPort,
    media_port: mediaPort,
    widget_domain: process.env.WEBGPT_V4_WIDGET_DOMAIN,
    telemetry_mode: process.env.WEBGPT_V4_TELEMETRY_MODE,
    media: { public_origin: publicMediaOrigin }
  });
}

export function installWebGptShutdownHandlers(runtime: Awaited<ReturnType<typeof startWebGptV4>>): void {
  const shutdown = async (): Promise<void> => {
    await runtime.close();
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}
