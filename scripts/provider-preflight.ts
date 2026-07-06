import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureM0Directories, paths, providerPreflight } from "../src/index.js";

ensureM0Directories();
const result = providerPreflight();
const reportPath = join(paths.reportsRoot, "provider_preflight_result.json");
writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));

if (result.result !== "PASS") {
  process.exit(1);
}
