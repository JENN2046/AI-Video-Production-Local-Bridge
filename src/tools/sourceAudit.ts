import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { ensureM0Directories, paths } from "../paths.js";

export interface SourceAuditFinding {
  code: string;
  path: string;
  detail: string;
}

export interface SourceAuditReport {
  task: "SOURCE-AUDIT-FIX-P0";
  action: "source_package_audit" | "clean_source_export";
  result: "PASS" | "BLOCK";
  run_id: string;
  generated_at: string;
  archive_path: string | null;
  tracked_file_count: number;
  archive_entry_count: number;
  checks: {
    tracked_source_only: boolean;
    forbidden_paths_absent: boolean;
    secret_shaped_values_absent: boolean;
    archive_entries_safe: boolean;
  };
  findings: SourceAuditFinding[];
}

export interface CleanSourceExportResult {
  ok: boolean;
  report: SourceAuditReport & { output_zip_path?: string; sha256_path?: string; sha256?: string };
  error?: { code: string; message: string };
}

const FORBIDDEN_PATH_PATTERNS: RegExp[] = [
  /^\.env(?:\.|$)/i,
  /^config\.env$/i,
  /^credentials(?:\/|\.|$)/i,
  /^secret(?:\/|s\/|$)/i,
  /^state-private\//i,
  /^data\/(?:media|imports)(?:\/|$)/i,
  /^data\/app\.sqlite(?:-|$)/i,
  /^node_modules\//i,
  /^dist\//i,
  /^\.git\//i,
  /(?:^|\/).codex-home\//i,
  /(?:^|\/)\.omc\//i,
  /\.(?:pem|key|p12|pfx)$/i,
  /\.sqlite(?:-|$)/i,
  /\.(?:log)$/i
];

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "OPENAI_KEY_SHAPE", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "BEARER_TOKEN_SHAPE", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}\b/gi },
  { name: "PRIVATE_KEY_BLOCK", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "PROVIDER_SECRET_ASSIGNMENT", pattern: /\b(?:RUNWAYML_API_SECRET|RUNNINGHUB_API_KEY|OPENAI_API_KEY|api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}/gi }
];

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

function now(): string {
  return new Date().toISOString();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "");
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isForbiddenPath(value: string): boolean {
  const normalized = normalizePath(value);
  if (normalized === ".env.example") return false;
  return FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function runGit(args: string[]): string {
  const result = spawnSync("git", args, { cwd: paths.workspaceRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  }
  return result.stdout;
}

export function listTrackedSourceFiles(): string[] {
  return runGit(["ls-files", "-z"])
    .split("\0")
    .map((entry) => normalizePath(entry.trim()))
    .filter(Boolean);
}

function isProbablyTextFile(filePath: string): boolean {
  if (TEXT_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf(".")).toLowerCase())) return true;
  const sample = readFileSync(filePath).subarray(0, 4096);
  return !sample.includes(0);
}

function allowedSecretTestContext(line: string): boolean {
  return /(?:FAKE|DUMMY|PLACEHOLDER|REDACTED|EXAMPLE|TEST_SECRET|DO_NOT_LOG|<[^>]+>)/i.test(line);
}

function scanFileForSecretShapes(filePath: string, displayPath: string): SourceAuditFinding[] {
  if (!existsSync(filePath) || !statSync(filePath).isFile() || !isProbablyTextFile(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  const findings: SourceAuditFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    if (allowedSecretTestContext(line)) continue;
    for (const detector of SECRET_PATTERNS) {
      detector.pattern.lastIndex = 0;
      if (detector.pattern.test(line)) {
        findings.push({
          code: "SECRET_SHAPED_VALUE",
          path: displayPath,
          detail: `${detector.name} at line ${lineIndex + 1}`
        });
      }
    }
  }
  return findings;
}

function pathFindings(files: string[], code: string): SourceAuditFinding[] {
  return files
    .filter(isForbiddenPath)
    .map((path) => ({
      code,
      path,
      detail: "Forbidden, ignored, generated, private-state, or secret-adjacent path must not be present in source export."
    }));
}

function report(action: SourceAuditReport["action"], archivePath: string | null, trackedFiles: string[], archiveEntries: string[], findings: SourceAuditFinding[]): SourceAuditReport {
  const hasForbidden = findings.some((finding) => finding.code === "FORBIDDEN_TRACKED_PATH" || finding.code === "FORBIDDEN_ARCHIVE_PATH");
  const hasSecret = findings.some((finding) => finding.code === "SECRET_SHAPED_VALUE");
  const hasUnsafeArchive = findings.some((finding) => finding.code === "ARCHIVE_PATH_TRAVERSAL" || finding.code === "ARCHIVE_UNTRACKED_ENTRY" || finding.code === "ARCHIVE_SYMLINK_ENTRY");
  return {
    task: "SOURCE-AUDIT-FIX-P0",
    action,
    result: findings.length === 0 ? "PASS" : "BLOCK",
    run_id: randomUUID(),
    generated_at: now(),
    archive_path: archivePath,
    tracked_file_count: trackedFiles.length,
    archive_entry_count: archiveEntries.length,
    checks: {
      tracked_source_only: !findings.some((finding) => finding.code === "ARCHIVE_UNTRACKED_ENTRY"),
      forbidden_paths_absent: !hasForbidden,
      secret_shaped_values_absent: !hasSecret,
      archive_entries_safe: !hasUnsafeArchive
    },
    findings
  };
}

export function auditTrackedSource(): SourceAuditReport {
  const trackedFiles = listTrackedSourceFiles();
  const findings = [
    ...pathFindings(trackedFiles, "FORBIDDEN_TRACKED_PATH"),
    ...trackedFiles.flatMap((file) => scanFileForSecretShapes(join(paths.workspaceRoot, file), file))
  ];
  return report("source_package_audit", null, trackedFiles, [], findings);
}

function listArchiveEntries(archivePath: string): string[] {
  const result = spawnSync("tar", ["-tf", archivePath], { cwd: paths.workspaceRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Unable to list archive entries with tar.").trim());
  }
  return result.stdout
    .split(/\r?\n/)
    .map(normalizePath)
    .filter((entry) => entry && entry !== ".");
}

function archiveEntryTraversalFinding(entry: string): SourceAuditFinding | null {
  const normalized = normalizePath(entry);
  if (!normalized || isAbsolute(normalized) || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return { code: "ARCHIVE_PATH_TRAVERSAL", path: entry, detail: "Archive entry path is unsafe." };
  }
  return null;
}

function walkFiles(root: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      output.push(target);
      continue;
    }
    if (entry.isDirectory()) output.push(...walkFiles(target));
    else if (entry.isFile()) output.push(target);
  }
  return output;
}

export function auditArchivePackage(archivePathInput: string): SourceAuditReport {
  const archivePath = resolve(paths.workspaceRoot, archivePathInput);
  if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
    const trackedFiles = listTrackedSourceFiles();
    return report("source_package_audit", archivePathInput, trackedFiles, [], [
      { code: "ARCHIVE_NOT_FOUND", path: archivePathInput, detail: "Archive file is not readable." }
    ]);
  }

  const trackedFiles = listTrackedSourceFiles();
  const trackedSet = new Set(trackedFiles);
  const archiveEntries = listArchiveEntries(archivePath);
  const findings: SourceAuditFinding[] = [
    ...pathFindings(trackedFiles, "FORBIDDEN_TRACKED_PATH"),
    ...trackedFiles.flatMap((file) => scanFileForSecretShapes(join(paths.workspaceRoot, file), file))
  ];

  for (const entry of archiveEntries) {
    const traversal = archiveEntryTraversalFinding(entry);
    if (traversal) findings.push(traversal);
    if (isForbiddenPath(entry)) findings.push({ code: "FORBIDDEN_ARCHIVE_PATH", path: entry, detail: "Archive contains a forbidden path." });
    const directoryEntry = trackedFiles.some((file) => file.startsWith(`${entry}/`));
    if (!directoryEntry && !trackedSet.has(entry)) findings.push({ code: "ARCHIVE_UNTRACKED_ENTRY", path: entry, detail: "Archive contains a file that is not tracked source." });
  }

  if (!findings.some((finding) => finding.code === "ARCHIVE_PATH_TRAVERSAL")) {
    const tempRoot = mkdtempSync(join(tmpdir(), "source-audit-"));
    try {
      const extract = spawnSync("tar", ["-xf", archivePath, "-C", tempRoot], { cwd: paths.workspaceRoot, encoding: "utf8" });
      if (extract.status !== 0) {
        findings.push({ code: "ARCHIVE_EXTRACT_FAILED", path: archivePathInput, detail: (extract.stderr || extract.stdout || "Archive extraction failed.").trim() });
      } else {
        for (const file of walkFiles(tempRoot)) {
          const relativePath = normalizePath(relative(tempRoot, file));
          if (lstatSync(file).isSymbolicLink()) {
            findings.push({ code: "ARCHIVE_SYMLINK_ENTRY", path: relativePath, detail: "Archive must not contain symlinks." });
          } else {
            findings.push(...scanFileForSecretShapes(file, relativePath));
          }
        }
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  return report("source_package_audit", archivePathInput, trackedFiles, archiveEntries, findings);
}

export function writeSourceAuditReport(auditReport: SourceAuditReport, latestName = "source_package_audit_report.json"): string {
  ensureM0Directories();
  const target = join(paths.reportsRoot, latestName);
  writeFileSync(target, `${JSON.stringify(auditReport, null, 2)}\n`, "utf8");
  const immutable = join(paths.reportsRoot, `${basename(latestName, ".json")}_${auditReport.run_id}.json`);
  writeFileSync(immutable, `${JSON.stringify(auditReport, null, 2)}\n`, "utf8");
  return target;
}

export function sha256ForFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function cleanSourceExport(outputPathInput?: string): CleanSourceExportResult {
  ensureM0Directories();
  const preflight = auditTrackedSource();
  if (preflight.result !== "PASS") {
    writeSourceAuditReport(preflight, "source_clean_export_report.json");
    return { ok: false, report: { ...preflight, action: "clean_source_export" }, error: { code: "SOURCE_AUDIT_BLOCKED", message: "Source audit blocked clean export." } };
  }

  const timestamp = now().replace(/[:.]/g, "-");
  const outputPath = resolve(paths.workspaceRoot, outputPathInput ?? join("ops", "reports", `source-clean-export-${timestamp}.zip`));
  if (!isPathInside(outputPath, paths.workspaceRoot)) {
    const blocked = report("clean_source_export", outputPathInput ?? outputPath, listTrackedSourceFiles(), [], [
      { code: "EXPORT_PATH_OUTSIDE_WORKSPACE", path: outputPathInput ?? outputPath, detail: "Clean export target must stay inside workspace." }
    ]);
    writeSourceAuditReport(blocked, "source_clean_export_report.json");
    return { ok: false, report: blocked, error: { code: "EXPORT_PATH_OUTSIDE_WORKSPACE", message: "Clean export target must stay inside workspace." } };
  }
  if (existsSync(outputPath)) {
    const blocked = report("clean_source_export", outputPath, listTrackedSourceFiles(), [], [
      { code: "EXPORT_TARGET_EXISTS", path: outputPath, detail: "Clean export refuses to overwrite an existing archive." }
    ]);
    writeSourceAuditReport(blocked, "source_clean_export_report.json");
    return { ok: false, report: blocked, error: { code: "EXPORT_TARGET_EXISTS", message: "Clean export refuses to overwrite an existing archive." } };
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  const archive = spawnSync("git", ["archive", "--format=zip", `--output=${outputPath}`, "HEAD"], { cwd: paths.workspaceRoot, encoding: "utf8" });
  if (archive.status !== 0) {
    const blocked = report("clean_source_export", outputPath, listTrackedSourceFiles(), [], [
      { code: "GIT_ARCHIVE_FAILED", path: outputPath, detail: (archive.stderr || archive.stdout || "git archive failed").trim() }
    ]);
    writeSourceAuditReport(blocked, "source_clean_export_report.json");
    return { ok: false, report: blocked, error: { code: "GIT_ARCHIVE_FAILED", message: "git archive failed." } };
  }

  const postflight = auditArchivePackage(outputPath);
  const sha256 = sha256ForFile(outputPath);
  const sha256Path = `${outputPath}.sha256.txt`;
  writeFileSync(sha256Path, `${sha256}  ${basename(outputPath)}\n`, "utf8");
  const finalReport = {
    ...postflight,
    action: "clean_source_export" as const,
    output_zip_path: outputPath,
    sha256_path: sha256Path,
    sha256
  };
  writeSourceAuditReport(finalReport, "source_clean_export_report.json");
  return postflight.result === "PASS"
    ? { ok: true, report: finalReport }
    : { ok: false, report: finalReport, error: { code: "ARCHIVE_AUDIT_BLOCKED", message: "Archive audit blocked clean export." } };
}
