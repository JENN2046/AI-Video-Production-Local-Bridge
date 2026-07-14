import { assertSchemaCurrent } from "../src/storage/migrations.js";
import { openM0Database, openM0DatabaseConnection } from "../src/storage/sqlite.js";
import {
  assertWebGptOwnerBootstrapTarget,
  bootstrapWebGptProjectOwner,
  grantWebGptProjectMembership,
  listWebGptAuthorizationSummary,
  parseWebGptAuthAdminArguments,
  registerWebGptPrincipal,
  revokeWebGptProjectMembership
} from "../src/webgpt-v4/authorizationAdmin.js";
import { principalIdFromFederatedSubject } from "../src/webgpt-v4/types.js";

const MAX_SUBJECT_BYTES = 4096;

async function readSubjectFromSecureStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    const error = new Error("Interactive owner bootstrap requires hidden input from the Windows wrapper.");
    Object.assign(error, { code: "WEBGPT_SECURE_INPUT_REQUIRED" });
    throw error;
  }
  let subject = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    subject += chunk;
    if (Buffer.byteLength(subject, "utf8") > MAX_SUBJECT_BYTES) {
      const error = new Error("Federated subject input exceeds the safe limit.");
      Object.assign(error, { code: "INVALID_WEBGPT_AUTH_ADMIN_INPUT" });
      throw error;
    }
  }
  const normalized = subject.replace(/[\r\n]+$/, "");
  if (!normalized || /[\r\n]/.test(normalized)) {
    const error = new Error("Federated subject input is missing or malformed.");
    Object.assign(error, { code: "INVALID_WEBGPT_AUTH_ADMIN_INPUT" });
    throw error;
  }
  return normalized;
}

try {
  const request = parseWebGptAuthAdminArguments(process.argv.slice(2));
  if (request.action === "bootstrap-owner-preflight" || request.action === "bootstrap-owner-interactive") {
    const preflightDb = openM0DatabaseConnection(request.database_path, { readOnly: true });
    try {
      assertSchemaCurrent(preflightDb);
      assertWebGptOwnerBootstrapTarget(preflightDb, request.project_id as string);
    } finally {
      preflightDb.close();
    }
  }
  if (request.action === "bootstrap-owner-preflight") {
    console.log(JSON.stringify({ result: "PASS", action: request.action, target_valid: true }, null, 2));
  } else {
    const principalId = request.action === "bootstrap-owner-interactive"
      ? principalIdFromFederatedSubject(request.issuer as string, await readSubjectFromSecureStdin())
      : request.principal_id;
    const db = openM0Database(request.database_path);
    try {
      const result = request.action === "bootstrap-owner" || request.action === "bootstrap-owner-interactive"
        ? bootstrapWebGptProjectOwner(db, principalId as string, request.project_id as string, request.reason_code as string)
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
  }
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "WEBGPT_AUTH_ADMIN_FAILED";
  console.error(JSON.stringify({ result: "FAIL", error: { code, message: error instanceof Error ? error.message : "Authorization admin failed." } }));
  process.exitCode = 1;
}
