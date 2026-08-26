import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "server" && mode !== "full") {
  console.error("Usage: node scripts/ensure-test-build.mjs <server|full>");
  process.exit(2);
}

const reuseCiBuild = process.env.CI_REUSE_BUILD === "true";
if (reuseCiBuild) {
  const requiredOutputs = ["dist/scripts/run-isolated-tests.js"];
  if (mode === "full") requiredOutputs.push("dist/workbench-ui/index.html");

  const missing = requiredOutputs.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    console.error(`CI build reuse requested, but build output is missing: ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log(`Reusing the existing CI ${mode} build.`);
  process.exit(0);
}

const buildScript = mode === "full" ? "build" : "build:server";
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) {
  console.error("npm_execpath is unavailable; run this helper from an npm script.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [npmCli, "run", buildScript], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
