import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ensureM0Directories, paths, realCommandReadiness } from "../src/index.js";

function writeResult(payload: unknown): void {
  writeFileSync(join(paths.reportsRoot, "m1_real_test_result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload, null, 2));
}

ensureM0Directories();
const readiness = realCommandReadiness();
if (!readiness.ok) {
  writeResult({
    phase: "M1-real-test",
    result: readiness.status,
    provider_name: readiness.provider_name,
    missing: readiness.missing,
    real_provider_called: false,
    provider_credits_consumed: false
  });
  process.exit(0);
}

const demo = spawnSync(process.execPath, [join(paths.workspaceRoot, "dist", "scripts", "demo-m1-real.js")], {
  cwd: paths.workspaceRoot,
  shell: false,
  stdio: "inherit",
  windowsHide: true
});

const exitCode = typeof demo.status === "number" ? demo.status : 1;
writeResult({
  phase: "M1-real-test",
  result: exitCode === 0 ? "PASS_OR_PROVIDER_REPORTED" : "FAIL",
  provider_name: readiness.provider_name,
  delegated_to: "demo:m1:real",
  exit_code: exitCode
});

process.exit(exitCode);

