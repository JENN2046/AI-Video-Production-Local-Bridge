import { installWorkbenchShutdownHandlers, startWorkbenchApplication, type WorkbenchRuntime } from "../src/apps/workbench/server.js";

let runtime: WorkbenchRuntime | undefined;
let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (runtime) await runtime.close();
  process.exit(0);
};
const shutdownToken = process.env.AI_VIDEO_WORKBENCH_SHUTDOWN_TOKEN?.trim();
runtime = await startWorkbenchApplication(undefined, shutdownToken ? {
  shutdown_token: shutdownToken,
  on_shutdown_requested: () => { void shutdown(); }
} : {});
console.log(`Workbench V2: ${runtime.url}`);
installWorkbenchShutdownHandlers(runtime, shutdown);
