import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

interface LegacyManifest {
  authorized_file_count: number;
  entries: Array<{ source: string; destination: string; sha256: string }>;
}

function gitBlob(path: string): Buffer {
  const result = spawnSync("git", ["show", `HEAD:${path}`], { encoding: "buffer", shell: false, windowsHide: true });
  assert.equal(result.status, 0, `missing committed legacy destination: ${path}`);
  return result.stdout;
}

function committedPathExists(path: string): boolean {
  return spawnSync("git", ["cat-file", "-e", `HEAD:${path}`], { shell: false, windowsHide: true }).status === 0;
}

test("legacy manifest preserves every authorized destination blob and retires its source", () => {
  const manifest = JSON.parse(readFileSync("legacy/MANIFEST.json", "utf8")) as LegacyManifest;
  assert.equal(manifest.entries.length, manifest.authorized_file_count);
  assert.equal(new Set(manifest.entries.map((entry) => entry.destination)).size, manifest.authorized_file_count);
  for (const entry of manifest.entries) {
    assert.equal(committedPathExists(entry.source), false, `legacy source remains active: ${entry.source}`);
    assert.equal(createHash("sha256").update(gitBlob(entry.destination)).digest("hex"), entry.sha256, `legacy hash drift: ${entry.destination}`);
  }
});
