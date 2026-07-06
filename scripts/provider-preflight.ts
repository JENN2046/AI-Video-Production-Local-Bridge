import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureM0Directories, loadProviderEnvLocal, paths, providerPreflight } from "../src/index.js";

ensureM0Directories();
const envFile = loadProviderEnvLocal();
const result = providerPreflight();
const reportPath = join(paths.reportsRoot, "provider_preflight_result.json");
const payload = { ...result, env_file: envFile };
writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify(payload, null, 2));

if (result.result !== "PASS") {
  process.exit(1);
}
