import { checkDatabase } from "../src/storage/databaseGovernance.js";

const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(["--read-only"]);
for (const arg of args) {
  if (!allowedArgs.has(arg)) throw new Error("DATABASE_CHECK_ARGUMENT_INVALID");
}
const result = checkDatabase(undefined, { recover_media_activations: !args.has("--read-only") });
console.log(JSON.stringify(result, null, 2));
if (result.result !== "PASS") process.exitCode = 1;
