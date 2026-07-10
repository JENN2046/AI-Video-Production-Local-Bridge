import { openM0Database } from "../src/storage/sqlite.js";
import { migrateLegacyWebGptV4History } from "../src/webgpt-v4/migration.js";

const db = openM0Database();
try {
  console.log(JSON.stringify(migrateLegacyWebGptV4History(db), null, 2));
} finally {
  db.close();
}
