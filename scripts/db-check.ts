import { checkDatabase } from "../src/storage/databaseGovernance.js";

const result = checkDatabase();
console.log(JSON.stringify(result, null, 2));
if (result.result !== "PASS") process.exitCode = 1;
