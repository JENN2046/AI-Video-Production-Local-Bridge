import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const edgePath = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4181",
    browserName: "chromium",
    launchOptions: existsSync(edgePath) ? { executablePath: edgePath } : undefined,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node dist/scripts/h1-workbench.js",
    url: "http://127.0.0.1:4181/api/v2/shell",
    reuseExistingServer: true,
    timeout: 120_000
  }
});
