import { installWebGptShutdownHandlers, startWebGptApplication } from "../src/apps/webgpt/server.js";

const runtime = await startWebGptApplication();
console.log(`WebGPT V4 MCP: ${runtime.mcp_url}`);
console.log(`WebGPT V4 Profile: ${runtime.profile}`);
console.log(runtime.media_url ? `WebGPT V4 Media: ${runtime.media_url}` : "WebGPT V4 Media: disabled (readonly profile)");
console.log(`OAuth configured: ${runtime.auth_configured}`);
installWebGptShutdownHandlers(runtime);
