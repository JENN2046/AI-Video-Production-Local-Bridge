import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureM0Directories, paths, runSecretScan } from "../src/index.js";

ensureM0Directories();
const result = runSecretScan();
const reportPath = join(paths.reportsRoot, "secret_scan_result.json");
writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));

if (result.result !== "PASS") {
  process.exit(1);
}
