import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { auditArchivePackage } from "../src/tools/sourceAudit.js";

test("source package audit blocks forbidden paths and secret-shaped values in archives", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "source-audit-test-"));
  try {
    const payloadRoot = join(tempRoot, "payload");
    mkdirSync(payloadRoot, { recursive: true });
    const secretPayload = "RUNWAYML_API_SECRET=" + "live_value_that_must_not_ship_12345";
    writeFileSync(join(payloadRoot, ".env"), `${secretPayload}\n`, "utf8");
    writeFileSync(join(payloadRoot, "src.ts"), "export const ok = true;\n", "utf8");
    const archivePath = join(tempRoot, "bad-source-package.tar");
    const packed = spawnSync("tar", ["-cf", archivePath, "-C", payloadRoot, "."], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);

    const report = auditArchivePackage(archivePath);
    assert.equal(report.result, "BLOCK");
    assert.equal(report.findings.some((finding) => finding.code === "FORBIDDEN_ARCHIVE_PATH"), true);
    assert.equal(report.findings.some((finding) => finding.code === "SECRET_SHAPED_VALUE"), true);
    assert.equal(JSON.stringify(report).includes("live_value_that_must_not_ship_12345"), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
