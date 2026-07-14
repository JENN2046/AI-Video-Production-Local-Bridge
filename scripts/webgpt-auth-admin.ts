import { openM0Database } from "../src/storage/sqlite.js";
import {
  bootstrapWebGptProjectOwner,
  grantWebGptProjectMembership,
  listWebGptAuthorizationSummary,
  parseWebGptAuthAdminArguments,
  registerWebGptPrincipal,
  revokeWebGptProjectMembership
} from "../src/webgpt-v4/authorizationAdmin.js";

try {
  const request = parseWebGptAuthAdminArguments(process.argv.slice(2));
  const db = openM0Database(request.database_path);
  try {
    const result = request.action === "bootstrap-owner"
      ? bootstrapWebGptProjectOwner(db, request.principal_id as string, request.project_id as string, request.reason_code as string)
      : request.action === "register"
        ? registerWebGptPrincipal(db, request.principal_id as string, request.reason_code as string)
        : request.action === "grant"
          ? grantWebGptProjectMembership(db, request.principal_id as string, request.project_id as string, request.role as "owner" | "viewer", request.reason_code as string)
          : request.action === "revoke"
            ? revokeWebGptProjectMembership(db, request.principal_id as string, request.project_id as string, request.reason_code as string)
            : listWebGptAuthorizationSummary(db);
    console.log(JSON.stringify({ result: "PASS", action: request.action, ...result }, null, 2));
  } finally {
    db.close();
  }
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "WEBGPT_AUTH_ADMIN_FAILED";
  console.error(JSON.stringify({ result: "FAIL", error: { code, message: error instanceof Error ? error.message : "Authorization admin failed." } }));
  process.exitCode = 1;
}
