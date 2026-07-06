import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkProviderEnv, ensureM0Directories, paths } from "../src/index.js";

ensureM0Directories();
const result = checkProviderEnv();
const reportPath = join(paths.reportsRoot, "provider_env_check_result.json");
writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));

if (result.result !== "PASS") {
  process.exit(1);
}
