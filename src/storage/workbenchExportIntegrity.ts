import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { paths, type M0Paths } from "../paths.js";
import type { M0Database } from "./sqlite.js";

export type WorkbenchExportIntegrityResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "integrity" };

export type WorkbenchExportIntegrityCacheState = "verified" | "invalid" | "unverified";

interface WorkbenchExportFileFacts {
  dev: string;
  ino: string;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
}

interface WorkbenchExportIntegrityCacheEntry {
  exports_root: string;
  project_root: string;
  file_path: string;
  facts: WorkbenchExportFileFacts;
}

const MAX_EXPORT_INTEGRITY_CACHE_ENTRIES = 2048;
const exportIntegrityCache = new Map<string, WorkbenchExportIntegrityCacheEntry>();

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\\/:]/u.test(value);
}

function resolvedExportPath(
  input: { project_id: string; relative_path: string; sha256: string; size_bytes: number },
  m0Paths: M0Paths
): { cache_key: string; exports_root: string; project_root: string; file_path: string } | null {
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
  return {
    cache_key: JSON.stringify([exportsRoot, input.project_id, input.relative_path, input.sha256, input.size_bytes]),
    exports_root: exportsRoot,
    project_root: projectRoot,
    file_path: filePath
  };
}

function fileFacts(stat: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number }): WorkbenchExportFileFacts {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs
  };
}

function sameFileFacts(left: WorkbenchExportFileFacts, right: WorkbenchExportFileFacts): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtime_ms === right.mtime_ms && left.ctime_ms === right.ctime_ms;
}

function rememberVerifiedExport(cacheKey: string, entry: WorkbenchExportIntegrityCacheEntry): void {
  exportIntegrityCache.delete(cacheKey);
  exportIntegrityCache.set(cacheKey, entry);
  while (exportIntegrityCache.size > MAX_EXPORT_INTEGRITY_CACHE_ENTRIES) {
    const oldest = exportIntegrityCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    exportIntegrityCache.delete(oldest);
  }
}

export function invalidateWorkbenchExportIntegrityCache(
  input: { project_id: string; relative_path: string; sha256: string; size_bytes: number },
  m0Paths: M0Paths = paths
): void {
  const resolved = resolvedExportPath(input, m0Paths);
  if (resolved) exportIntegrityCache.delete(resolved.cache_key);
}

export function getCachedWorkbenchExportIntegrity(
  input: { project_id: string; relative_path: string; sha256: string; size_bytes: number },
  m0Paths: M0Paths = paths
): WorkbenchExportIntegrityCacheState {
  const resolved = resolvedExportPath(input, m0Paths);
  if (!resolved) return "invalid";
  const cached = exportIntegrityCache.get(resolved.cache_key);
  if (!cached) return "unverified";
  try {
    const rootStat = lstatSync(resolved.exports_root);
    const projectStat = lstatSync(resolved.project_root);
    const pathStat = lstatSync(resolved.file_path);
    const currentFacts = fileFacts(pathStat);
    if (rootStat.isSymbolicLink() || projectStat.isSymbolicLink() || pathStat.isSymbolicLink()
      || !rootStat.isDirectory() || !projectStat.isDirectory() || !pathStat.isFile()
      || cached.exports_root !== resolved.exports_root || cached.project_root !== resolved.project_root
      || cached.file_path !== resolved.file_path || !sameFileFacts(cached.facts, currentFacts)) {
      exportIntegrityCache.delete(resolved.cache_key);
      return "invalid";
    }
    return "verified";
  } catch {
    exportIntegrityCache.delete(resolved.cache_key);
    return "invalid";
  }
}

export function verifyWorkbenchExportFile(
  input: { project_id: string; relative_path: string; sha256: string; size_bytes: number },
  m0Paths: M0Paths = paths
): WorkbenchExportIntegrityResult {
  const resolved = resolvedExportPath(input, m0Paths);
  if (!resolved) return { ok: false, reason: "integrity" };
  const { cache_key: cacheKey, exports_root: exportsRoot, project_root: projectRoot, file_path: filePath } = resolved;
  exportIntegrityCache.delete(cacheKey);

  let descriptor: number | undefined;
  try {
    const rootStat = lstatSync(exportsRoot);
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
      exportIntegrityCache.delete(cacheKey);
      return { ok: false, reason: "integrity" };
    }
    rememberVerifiedExport(cacheKey, {
      exports_root: exportsRoot,
      project_root: projectRoot,
      file_path: filePath,
      facts: fileFacts(after)
    });
    return { ok: true };
  } catch (error) {
    exportIntegrityCache.delete(cacheKey);
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
