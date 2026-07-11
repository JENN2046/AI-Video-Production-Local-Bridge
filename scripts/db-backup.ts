import { backupDatabase } from "../src/storage/databaseGovernance.js";

const result = backupDatabase();
console.log(JSON.stringify({ result: "PASS", backup: result.filename }));
