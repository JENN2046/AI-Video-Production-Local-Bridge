import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkProviderEnv, ensureM0Directories, loadProviderEnvLocal, paths } from "../src/index.js";

ensureM0Directories();
const envFile = loadProviderEnvLocal();
const result = checkProviderEnv();
const reportPath = join(paths.reportsRoot, "provider_env_check_result.json");
const payload = { ...result, env_file: envFile };
writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify(payload, null, 2));

if (result.result !== "PASS") {
  process.exit(1);
}
