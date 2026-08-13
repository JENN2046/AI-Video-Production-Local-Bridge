import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const edgePath = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const requestedPort = Number(process.env.PLAYWRIGHT_WORKBENCH_PORT ?? 4181);
if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65_535) {
  throw new Error("PLAYWRIGHT_WORKBENCH_PORT must be an unprivileged TCP port.");
}
const baseURL = `http://127.0.0.1:${requestedPort}`;
const dataRoot = requestedPort === 4181 ? "ops/tools/playwright-data" : `ops/tools/playwright-data-${requestedPort}`;

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    browserName: "chromium",
    launchOptions: existsSync(edgePath) ? { executablePath: edgePath } : undefined,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node dist/scripts/prepare-browser-fixture.js && node dist/scripts/h1-workbench.js",
    url: `${baseURL}/api/v2/shell`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      H1_WORKBENCH_PORT: String(requestedPort),
      AI_VIDEO_WORKSPACE_DATA_ROOT: dataRoot,
      AI_VIDEO_WORKSPACE_DB_PATH: `${dataRoot}/app.sqlite`
    }
  }
});
