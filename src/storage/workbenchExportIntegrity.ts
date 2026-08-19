import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { paths, type M0Paths } from "../paths.js";
import type { M0Database } from "./sqlite.js";

export type WorkbenchExportIntegrityResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "integrity" };

export type WorkbenchExportIdentityResult =
  | { ok: true; file_identity_sha256: string }
  | { ok: false; reason: "missing" | "integrity" };

type WorkbenchExportInput = {
  project_id: string;
  relative_path: string;
  sha256: string;
  size_bytes: number;
};

type WorkbenchExportIdentityInput = WorkbenchExportInput & {
  file_identity_sha256: string;
};

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\\/:]/u.test(value);
}

function resolvedExportPath(
  input: WorkbenchExportInput,
  m0Paths: M0Paths
): { exports_root: string; project_root: string; file_path: string } | null {
  const parts = input.relative_path.split("/");
  if (parts.length !== 4 || parts[0] !== "data" || parts[1] !== "exports"
    || parts[2] !== input.project_id || !isSafeSegment(input.project_id)
    || !isSafeSegment(parts[3] ?? "") || !parts[3]!.endsWith(".mp4")) {
    return null;
  }
  const exportsRoot = resolve(m0Paths.exportsRoot);
  const projectRoot = resolve(exportsRoot, input.project_id);
  const filePath = resolve(projectRoot, parts[3]!);
  if (!inside(exportsRoot, projectRoot) || !inside(projectRoot, filePath)) return null;
  return { exports_root: exportsRoot, project_root: projectRoot, file_path: filePath };
}

function fileIdentitySha256(stat: {
  dev: number | bigint;
  ino: number | bigint;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): string {
  return createHash("sha256").update(JSON.stringify({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    mtime_ms: String(stat.mtimeMs),
    ctime_ms: String(stat.ctimeMs)
  })).digest("hex");
}

function inspectExportPath(
  input: WorkbenchExportInput,
  m0Paths: M0Paths
): { ok: true; file_path: string; file_identity_sha256: string } | { ok: false; reason: "missing" | "integrity" } {
  const resolved = resolvedExportPath(input, m0Paths);
  if (!resolved) return { ok: false, reason: "integrity" };
  try {
    const rootStat = lstatSync(resolved.exports_root);
    const projectStat = lstatSync(resolved.project_root);
    const pathStat = lstatSync(resolved.file_path);
    if (rootStat.isSymbolicLink() || projectStat.isSymbolicLink() || pathStat.isSymbolicLink()
      || !rootStat.isDirectory() || !projectStat.isDirectory() || !pathStat.isFile()
      || pathStat.size !== input.size_bytes) {
      return { ok: false, reason: "integrity" };
    }
    return {
      ok: true,
      file_path: resolved.file_path,
      file_identity_sha256: fileIdentitySha256(pathStat)
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "missing" : "integrity" };
  }
}

export function verifyWorkbenchExportFileIdentity(
  input: WorkbenchExportIdentityInput,
  m0Paths: M0Paths = paths
): WorkbenchExportIntegrityResult {
  if (!/^[0-9a-f]{64}$/u.test(input.file_identity_sha256)) return { ok: false, reason: "integrity" };
  const inspected = inspectExportPath(input, m0Paths);
  if (!inspected.ok) return inspected;
  return inspected.file_identity_sha256 === input.file_identity_sha256
    ? { ok: true }
    : { ok: false, reason: "integrity" };
}

export function inspectWorkbenchExportFile(
  input: WorkbenchExportInput,
  m0Paths: M0Paths = paths
): WorkbenchExportIdentityResult {
  const inspected = inspectExportPath(input, m0Paths);
  if (!inspected.ok) return inspected;

  let descriptor: number | undefined;
  try {
    descriptor = openSync(inspected.file_path, "r");
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== input.size_bytes
      || fileIdentitySha256(before) !== inspected.file_identity_sha256) {
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
    const pathAfter = lstatSync(inspected.file_path);
    const afterIdentity = fileIdentitySha256(after);
    if (afterIdentity !== inspected.file_identity_sha256 || pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || fileIdentitySha256(pathAfter) !== afterIdentity || hash.digest("hex") !== input.sha256) {
      return { ok: false, reason: "integrity" };
    }
    return { ok: true, file_identity_sha256: afterIdentity };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "missing" : "integrity" };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function verifyWorkbenchExportFile(
  input: WorkbenchExportInput,
  m0Paths: M0Paths = paths
): WorkbenchExportIntegrityResult {
  const result = inspectWorkbenchExportFile(input, m0Paths);
  return result.ok ? { ok: true } : result;
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
  functions.function("workbench_export_file_identity_valid", { deterministic: false },
    (projectId: unknown, relativePath: unknown, sha256: unknown, sizeBytes: unknown, fileIdentitySha256: unknown) =>
      verifyWorkbenchExportFileIdentity({
        project_id: String(projectId),
        relative_path: String(relativePath),
        sha256: String(sha256),
        size_bytes: Number(sizeBytes),
        file_identity_sha256: String(fileIdentitySha256)
      }, m0Paths).ok ? 1 : 0);
}
