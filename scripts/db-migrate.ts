import { existsSync, statSync } from "node:fs";

import { paths } from "../src/paths.js";
import { backupDatabase, migrateDatabase } from "../src/storage/databaseGovernance.js";

const backup = existsSync(paths.sqlitePath) && statSync(paths.sqlitePath).size > 0 ? backupDatabase() : null;
const migration = migrateDatabase(paths.sqlitePath);
console.log(JSON.stringify({ result: "PASS", backup: backup?.filename ?? null, ...migration }, null, 2));
