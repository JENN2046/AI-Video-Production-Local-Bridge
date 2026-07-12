import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { migrateDatabase } from "../src/storage/databaseGovernance.js";

const tempRoot = mkdtempSync(join(tmpdir(), "ai-video-workbench-tests-"));
const dataRoot = join(tempRoot, "data");
const sqlitePath = join(dataRoot, "app.sqlite");

try {
  migrateDatabase(sqlitePath);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AI_VIDEO_WORKSPACE_DATA_ROOT: dataRoot,
      AI_VIDEO_WORKSPACE_DB_PATH: sqlitePath,
      AI_VIDEO_TEST_AUTO_MIGRATE: "true"
    },
    stdio: "inherit"
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
