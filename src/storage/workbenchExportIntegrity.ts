import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { paths, type M0Paths } from "../paths.js";
import type { M0Database } from "./sqlite.js";

export type WorkbenchExportIntegrityResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "integrity" };

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\\/:]/u.test(value);
}

export function verifyWorkbenchExportFile(
  input: { project_id: string; relative_path: string; sha256: string; size_bytes: number },
  m0Paths: M0Paths = paths
): WorkbenchExportIntegrityResult {
  const parts = input.relative_path.split("/");
  if (parts.length !== 4 || parts[0] !== "data" || parts[1] !== "exports"
    || parts[2] !== input.project_id || !isSafeSegment(input.project_id)
    || !isSafeSegment(parts[3] ?? "") || !parts[3]!.endsWith(".mp4")) {
    return { ok: false, reason: "integrity" };
  }
  const projectRoot = resolve(m0Paths.exportsRoot, input.project_id);
  const filePath = resolve(projectRoot, parts[3]!);
  if (!inside(m0Paths.exportsRoot, projectRoot) || !inside(projectRoot, filePath)) {
    return { ok: false, reason: "integrity" };
  }

  let descriptor: number | undefined;
  try {
    const rootStat = lstatSync(m0Paths.exportsRoot);
    const projectStat = lstatSync(projectRoot);
    const pathStat = lstatSync(filePath);
    if (rootStat.isSymbolicLink() || projectStat.isSymbolicLink() || pathStat.isSymbolicLink()
      || !rootStat.isDirectory() || !projectStat.isDirectory() || !pathStat.isFile()) {
      return { ok: false, reason: "integrity" };
    }
    descriptor = openSync(filePath, "r");
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== input.size_bytes
      || before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
      return { ok: false, reason: "integrity" };
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead === 0) return { ok: false, reason: "integrity" };
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(filePath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || after.dev !== before.dev || after.ino !== before.ino || pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino || pathAfter.size !== after.size
      || pathAfter.mtimeMs !== after.mtimeMs || pathAfter.ctimeMs !== after.ctimeMs
      || hash.digest("hex") !== input.sha256) {
      return { ok: false, reason: "integrity" };
    }
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "missing" : "integrity" };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function registerWorkbenchExportIntegrityFunction(db: M0Database, m0Paths: M0Paths = paths): void {
  const functions = db as M0Database & {
    function: (name: string, options: { deterministic: boolean }, callback: (...args: unknown[]) => number) => void;
  };
  functions.function("workbench_export_file_integrity_valid", { deterministic: false },
    (projectId: unknown, relativePath: unknown, sha256: unknown, sizeBytes: unknown) =>
      verifyWorkbenchExportFile({
        project_id: String(projectId),
        relative_path: String(relativePath),
        sha256: String(sha256),
        size_bytes: Number(sizeBytes)
      }, m0Paths).ok ? 1 : 0);
}
