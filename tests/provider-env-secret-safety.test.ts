import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { checkProviderEnv, loadProviderEnvFile, maskSecret, paths, providerPreflight, runSecretScan } from "../src/index.js";
import { secretFindingForText } from "../src/tools/providerEnv.js";

const DUMMY_SECRET = "dummy_RUNWAY_secret_for_tests_1234";

test("Provider env defaults to mock or disabled without network preflight", () => {
  const check = checkProviderEnv({ M1_REAL_PROVIDER: "mock" });
  assert.equal(check.result, "PASS");
  assert.equal(check.provider_name, "mock");
  assert.equal(check.no_network_call, true);

  const preflight = providerPreflight({ M1_REAL_PROVIDER: "mock" });
  assert.equal(preflight.result, "PASS");
  assert.equal(preflight.status, "MOCK_OR_DISABLED");
  assert.equal(preflight.network_call_attempted, false);
});

test("Provider gates block missing execution, cost ack, unsupported provider, and missing credential", () => {
  const missingExecution = providerPreflight({
    REAL_PROVIDER_ENABLED: "true",
    M1_REAL_PROVIDER: "runway",
    M1_REAL_PROVIDER_COST_ACK: "true",
    RUNWAYML_API_SECRET: DUMMY_SECRET
  });
  assert.equal(missingExecution.result, "BLOCKED");
  assert.equal(missingExecution.error_code, "PROVIDER_DISABLED");

  const missingCost = providerPreflight({
    REAL_PROVIDER_ENABLED: "true",
    M1_REAL_PROVIDER: "runway",
    M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
    RUNWAYML_API_SECRET: DUMMY_SECRET
  });
  assert.equal(missingCost.result, "BLOCKED");
  assert.equal(missingCost.error_code, "PROVIDER_COST_CONFIRMATION_REQUIRED");

  const unsupported = providerPreflight({ M1_REAL_PROVIDER: "not-a-provider" });
  assert.equal(unsupported.result, "BLOCKED");
  assert.deepEqual(unsupported.missing, ["M1_REAL_PROVIDER"]);

  const missingCredential = providerPreflight({
    REAL_PROVIDER_ENABLED: "true",
    M1_REAL_PROVIDER: "runninghub",
    M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
    M1_REAL_PROVIDER_COST_ACK: "true"
  });
  assert.equal(missingCredential.result, "BLOCKED");
  assert.equal(missingCredential.error_code, "PROVIDER_CREDENTIAL_MISSING");
});

test("Provider preflight can become ready without exposing any credential preview", () => {
  const ready = providerPreflight({
    REAL_PROVIDER_ENABLED: "true",
    M1_REAL_PROVIDER: "runway",
    M1_REAL_PROVIDER_EXECUTION_ALLOWED: "true",
    M1_REAL_PROVIDER_COST_ACK: "true",
    RUNWAYML_API_SECRET: DUMMY_SECRET
  });

  assert.equal(ready.result, "PASS");
  assert.equal(ready.status, "READY_FOR_AUTHORIZED_REAL_CALL");
  assert.equal(ready.network_call_attempted, false);
  assert.equal(ready.masked_credential_preview, null);
  assert.equal(JSON.stringify(ready).includes(DUMMY_SECRET), false);
  assert.equal(JSON.stringify(ready).includes("dum****1234"), false);
  assert.equal(maskSecret(DUMMY_SECRET), "dum****1234");
});

test("Provider env loader reads allowed keys from a local env file without returning values", () => {
  const tmpRoot = join(paths.dataRoot, "tmp", "provider-env-loader-test");
  mkdirSync(tmpRoot, { recursive: true });
  const envPath = join(tmpRoot, ".env.local");
  writeFileSync(
    envPath,
    [
      "REAL_PROVIDER_ENABLED=true",
      "M1_REAL_PROVIDER=runway",
      "M1_REAL_PROVIDER_EXECUTION_ALLOWED=true",
      "M1_REAL_PROVIDER_COST_ACK=true",
      "RUNNINGHUB_MODEL_API_ENDPOINT=/rhart-video-g/image-to-video",
      `RUNWAYML_API_SECRET=${DUMMY_SECRET}`,
      "IGNORED_SECRET=should_not_load"
    ].join("\n"),
    "utf8"
  );

  const env: NodeJS.ProcessEnv = {};
  const loaded = loadProviderEnvFile({ filePath: envPath, env });
  assert.equal(loaded.env_file_found, true);
  assert.equal(loaded.secret_values_exposed, false);
  assert.equal(loaded.loaded_keys.includes("RUNWAYML_API_SECRET"), true);
  assert.equal(loaded.loaded_keys.includes("RUNNINGHUB_MODEL_API_ENDPOINT"), true);
  assert.equal(loaded.ignored_keys.includes("IGNORED_SECRET"), true);
  assert.equal(JSON.stringify(loaded).includes(DUMMY_SECRET), false);

  const ready = providerPreflight(env);
  assert.equal(ready.result, "PASS");
  assert.equal(ready.masked_credential_preview, null);
  assert.equal(JSON.stringify(ready).includes(DUMMY_SECRET), false);
  assert.equal(JSON.stringify(ready).includes("dum****1234"), false);
});

test("Secret scan covers tracked text files and reports without reading credentials", () => {
  const scan = runSecretScan();
  assert.equal(scan.result, "PASS", JSON.stringify(scan.findings));
  assert.equal(scan.git_tracked_files, "PASS");
  assert.equal(scan.reports, "PASS");
  assert.equal(scan.sqlite_or_runtime_state, "NOT_APPLICABLE");
});

test("Secret scan distinguishes OAuth protocol text and fixtures from bearer credentials", () => {
  assert.equal(secretFindingForText("const match = /^Bearer\\s+(.+)$/i;"), null);
  assert.equal(secretFindingForText("Authorization: Bearer test-token"), null);
  assert.equal(secretFindingForText('Bearer resource_metadata="https://example.test/.well-known/oauth-protected-resource"'), null);
  const shortCredentialHeader = ["Authorization:", "Bearer", "abcd1234efgh"].join(" ");
  assert.equal(secretFindingForText(shortCredentialHeader), "unredacted bearer token");
  const credentialShapedHeader = ["Authorization:", "Bearer", "abcdefghijklmnopqrstuvwxyz012345"].join(" ");
  assert.equal(secretFindingForText(credentialShapedHeader), "unredacted bearer token");
  const multipleBearers = [
    ["Authorization:", "Bearer", "test-token"].join(" "),
    ["Authorization:", "Bearer", "abcdefghijklmnop"].join(" ")
  ].join("\n");
  assert.equal(secretFindingForText(multipleBearers), "unredacted bearer token");
  const multipleJsonSecrets = [
    ["\"", "RUNNINGHUB_API_KEY", "\":\"", "dummy", "\""].join(""),
    ["\"", "RUNWAYML_API_SECRET", "\":\"", "real-secret-value", "\""].join("")
  ].join("\n");
  assert.equal(secretFindingForText(multipleJsonSecrets), "RUNWAYML_API_SECRET has a non-placeholder JSON value");
  const multipleTokenPatterns = [["sk", "-", "dummy_dummy_dummy"].join(""), ["sk", "-", "abcdefghijklmnopqrstuvwxyz"].join("")].join("\n");
  assert.equal(secretFindingForText(multipleTokenPatterns), "token-like secret pattern");
});
