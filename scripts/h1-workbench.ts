import { installWorkbenchShutdownHandlers, startWorkbenchApplication } from "../src/apps/workbench/server.js";

const runtime = await startWorkbenchApplication();
console.log(`Workbench V2: ${runtime.url}`);
installWorkbenchShutdownHandlers(runtime);
