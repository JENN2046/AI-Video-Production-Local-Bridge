import { existsSync, statSync } from "node:fs";

import { paths } from "../src/paths.js";
import { backupDatabase, databaseLogicalManifest, migrateDatabase } from "../src/storage/databaseGovernance.js";
import { openM0Database } from "../src/storage/sqlite.js";
import { migrateLegacyWorkbenchInboxStores } from "../src/tools/workbenchInboxStore.js";
import { migrateLegacyWebGptV4History } from "../src/webgpt-v4/migration.js";

const databaseExists = existsSync(paths.sqlitePath) && statSync(paths.sqlitePath).size > 0;
const before = databaseExists ? databaseLogicalManifest(paths.sqlitePath) : null;
const backup = databaseExists ? backupDatabase() : null;
const migration = migrateDatabase(paths.sqlitePath);
const db = openM0Database(paths.sqlitePath);
let legacy;
try {
  legacy = {
    inbox: migrateLegacyWorkbenchInboxStores(db),
    webgpt: migrateLegacyWebGptV4History(db, paths.dataRoot)
  };
} finally { db.close(); }
const after = databaseLogicalManifest(paths.sqlitePath);
console.log(JSON.stringify({ result: "PASS", backup: backup?.filename ?? null, evidence: { before, after }, ...migration, legacy }, null, 2));
