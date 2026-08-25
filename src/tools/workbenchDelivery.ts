import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { canonicalizeJcs } from "../packages/domain/jcs.js";
import { paths } from "../paths.js";
import { withWorkbenchProductionMutationAuthority } from "../storage/productionMutationAuthority.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { validateActiveArtifactReference, validateAcceptedClipReference } from "./mediaArtifacts.js";
import { validateMp4FileDescriptor } from "./mediaValidity.js";
import { getProject, listProjectShots, saveProject, saveShot, type Project, type ToolError } from "./projects.js";
import { markShotClipReview } from "./review.js";
import {
  getActiveWorkbenchDeliveryJob,
  getWorkbenchDeliveryState,
  refreshWorkbenchAssemblyReadiness,
  workbenchProductionMutationError,
  type WorkbenchCloseoutReceipt,
  type WorkbenchDeliveryJobRecord,
  type WorkbenchDeliveryState,
  type WorkbenchExportRecord
} from "./workbenchDeliveryState.js";

export const FINAL_EXPORT_CONTRACT_VERSION = "final-export-v1" as const;
export const CLOSEOUT_CONFIRMATION_PHRASE = "确认结案" as const;

const NATIVE_EXPORT_CONTROL_TIMEOUT_MS = 10_000;
const NATIVE_EXPORT_COPY_MIN_TIMEOUT_MS = 5 * 60_000;
const NATIVE_EXPORT_COPY_MAX_TIMEOUT_MS = 6 * 60 * 60_000;
const NATIVE_EXPORT_COPY_FLUSH_GRACE_MS = 60_000;
const NATIVE_EXPORT_COPY_MIN_BYTES_PER_SECOND = 1024 * 1024;

export function calculateNativeExportCopyTimeoutMs(sourceSizeBytes: number): number {
  if (!Number.isSafeInteger(sourceSizeBytes) || sourceSizeBytes < 0) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export source size is invalid.");
  }
  // The helper durably copies source -> .part -> final and flushes both files.
  const throughputBudget = Math.ceil(
    ((sourceSizeBytes * 2) / NATIVE_EXPORT_COPY_MIN_BYTES_PER_SECOND) * 1000
  ) + NATIVE_EXPORT_COPY_FLUSH_GRACE_MS;
  return Math.min(
    NATIVE_EXPORT_COPY_MAX_TIMEOUT_MS,
    Math.max(NATIVE_EXPORT_COPY_MIN_TIMEOUT_MS, throughputBudget)
  );
}

export type WorkbenchDeliveryResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError & { field?: string } };

export type WorkbenchFinalReviewDecision = "accept" | "reassemble" | "regenerate_shots";

export interface WorkbenchFinalVersionRecord {
  artifact_id: string;
  created_at: string;
  assembly_job_id: string | null;
  assembled_at: string | null;
}

export interface WorkbenchExportSnapshot {
  contract_version: typeof FINAL_EXPORT_CONTRACT_VERSION;
  project_id: string;
  artifact_id: string;
  blob_sha256: string;
  size_bytes: number;
  relative_path: string;
}

export type WorkbenchExportVerificationState = "not_applicable" | "unverified" | "verified" | "failed";

export interface WorkbenchExportIntegrityStatus {
  state: WorkbenchExportVerificationState;
  reason_code:
    | "EXPORT_NOT_APPLICABLE"
    | "EXPORT_INTEGRITY_UNVERIFIED"
    | "EXPORT_INTEGRITY_VERIFIED"
    | "EXPORT_INTEGRITY_FAILED";
  export_id: string | null;
  checked_at: string | null;
}

export interface WorkbenchDeliveryDependencies {
  now?: () => Date;
  random_uuid?: () => string;
  before_export_copy?: (partPath: string) => void | Promise<void>;
  after_export_lease?: (partPath: string) => void | Promise<void>;
  after_export_directory_revalidation?: (partPath: string) => void | Promise<void>;
  after_export_copy?: (partPath: string) => void | Promise<void>;
  before_export_commit?: () => void | Promise<void>;
  validate_export_file?: (filePath: string) => boolean;
}

interface DeliveryJobRow extends WorkbenchDeliveryJobRecord {
  input_json: string;
}

interface FileIdentity {
  size_bytes: number;
  mtime_ms: number;
  ctime_ms: number;
  device: number;
  inode: number;
}

interface DirectoryIdentity {
  real_path: string;
  device: string;
  inode: string;
  birthtime_ns: string;
}

interface ExportDirectoryLease {
  data_root: DirectoryIdentity;
  export_root: DirectoryIdentity;
  project_directory: DirectoryIdentity;
  data_root_path: string;
  export_root_path: string;
  project_directory_path: string;
}

interface FileFacts extends FileIdentity {
  sha256: string;
}

interface OpenFileFacts extends FileFacts {
  file_descriptor: number;
}

class DeliveryFailure extends Error {
  constructor(readonly code: string, message: string, readonly field?: string) {
    super(message);
  }
}

function now(dependencies: WorkbenchDeliveryDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}

function uuid(dependencies: WorkbenchDeliveryDependencies): string {
  return dependencies.random_uuid?.() ?? randomUUID();
}

function isPathInside(child: string, parent: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function hasExistingSymlinkAncestor(child: string, parent: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  if (!isPathInside(target, root)) return true;
  let current = root;
  for (const part of relative(root, target).split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) return false;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function assertSafeExistingExportFile(filePath: string): void {
  const dataRoot = resolve(paths.dataRoot);
  const exportRoot = resolve(paths.exportsRoot);
  if (!isPathInside(filePath, exportRoot)
    || !existsSync(dataRoot) || lstatSync(dataRoot).isSymbolicLink() || !statSync(dataRoot).isDirectory()
    || !existsSync(exportRoot) || lstatSync(exportRoot).isSymbolicLink() || !statSync(exportRoot).isDirectory()
    || !isPathInside(realpathSync(exportRoot), realpathSync(dataRoot))
    || hasExistingSymlinkAncestor(filePath, exportRoot)) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export path failed filesystem governance validation.");
  }
}

function identityFromStat(value: ReturnType<typeof fstatSync>): FileIdentity {
  return {
    size_bytes: Number(value.size),
    mtime_ms: Number(value.mtimeMs),
    ctime_ms: Number(value.ctimeMs),
    device: Number(value.dev),
    inode: Number(value.ino)
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.size_bytes === right.size_bytes
    && left.mtime_ms === right.mtime_ms
    && left.ctime_ms === right.ctime_ms
    && left.device === right.device
    && left.inode === right.inode;
}

function inspectExportFileIdentity(filePath: string): FileIdentity {
  assertSafeExistingExportFile(filePath);
  if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink() || !statSync(filePath).isFile()) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export bytes are unavailable or unsafe.");
  }
  const descriptor = openSync(filePath, "r");
  try {
    const opened = fstatSync(descriptor);
    const pathAfter = lstatSync(filePath);
    if (!opened.isFile() || pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || (opened.dev !== 0 && pathAfter.dev !== opened.dev)
      || (opened.ino !== 0 && pathAfter.ino !== opened.ino)) {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export file identity changed during inspection.");
    }
    return identityFromStat(opened);
  } finally {
    closeSync(descriptor);
  }
}

function openFileFacts(filePath: string): OpenFileFacts {
  assertSafeExistingExportFile(filePath);
  if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink() || !statSync(filePath).isFile()) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export bytes are unavailable or unsafe.");
  }
  const descriptor = openSync(filePath, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export bytes are not a regular file.");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(filePath);
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || offset !== before.size
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || (before.dev !== 0 && pathAfter.dev !== before.dev)
      || (before.ino !== 0 && pathAfter.ino !== before.ino)) {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export bytes changed during verification.");
    }
    return {
      file_descriptor: descriptor,
      sha256: hash.digest("hex"),
      ...identityFromStat(before)
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function validateExportFile(
  filePath: string,
  expected: Pick<WorkbenchExportSnapshot, "blob_sha256" | "size_bytes">,
  dependencies: WorkbenchDeliveryDependencies
): FileFacts {
  const opened = openFileFacts(filePath);
  try {
    const mediaValid = dependencies.validate_export_file
      ? dependencies.validate_export_file(filePath)
      : validateMp4FileDescriptor(opened.file_descriptor).status === "PASS";
    if (opened.sha256 !== expected.blob_sha256 || opened.size_bytes !== expected.size_bytes || !mediaValid) {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export bytes failed SHA-256, size, or FFprobe validation.");
    }
    const { file_descriptor: _descriptor, ...facts } = opened;
    return facts;
  } finally {
    closeSync(opened.file_descriptor);
  }
}

function deliveryError(error: unknown): WorkbenchDeliveryResult<never> {
  if (error instanceof DeliveryFailure) {
    return { ok: false, error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } };
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("idx_workbench_delivery_jobs_single_active")
    || message.includes("UNIQUE constraint failed: index 'idx_workbench_delivery_jobs_single_active'")) {
    return { ok: false, error: { code: "DELIVERY_JOB_ACTIVE", message: "Another assembly or export Job is active." } };
  }
  const mapped = workbenchProductionMutationError(error);
  if (mapped.code === "PRODUCTION_MUTATION_CONFLICT") return { ok: false, error: mapped };
  if (message.includes("PROJECT_CLOSED")) {
    return { ok: false, error: { code: "PROJECT_CLOSED", message: "Closed projects do not accept production changes." } };
  }
  return { ok: false, error: { code: "EXPORT_INTEGRITY_FAILED", message: "Delivery operation failed closed." } };
}

function commitWithVerifiedOutcome(
  db: M0Database,
  verifyCommitted: () => boolean,
  recoveryCode: string,
  recoveryMessage: string
): void {
  try {
    db.exec("COMMIT");
    return;
  } catch (error) {
    if ((db as unknown as { isTransaction?: boolean }).isTransaction === true) {
      try {
        db.exec("ROLLBACK");
      } catch {
        throw new DeliveryFailure(recoveryCode, recoveryMessage);
      }
      throw error;
    }
    try {
      if (verifyCommitted()) return;
    } catch { /* a failed postcondition read keeps the outcome explicitly recoverable */ }
    throw new DeliveryFailure(recoveryCode, recoveryMessage);
  }
}

function projectForDelivery(db: M0Database, projectId: string): { project: Project; delivery: WorkbenchDeliveryState } {
  const project = getProject(db, projectId);
  if (!project) throw new DeliveryFailure("PROJECT_NOT_FOUND", "Project was not found.", "project_id");
  const meta = db.prepare("SELECT lifecycle FROM workbench_project_meta WHERE project_id = ?")
    .get(projectId) as { lifecycle: string } | undefined;
  if (!meta) throw new DeliveryFailure("PROJECT_NOT_FOUND", "Project workbench metadata was not found.", "project_id");
  if (meta.lifecycle === "archived") throw new DeliveryFailure("PROJECT_ARCHIVED", "Archived projects are read-only.", "project_id");
  const delivery = getWorkbenchDeliveryState(db, projectId);
  if (!delivery) throw new DeliveryFailure("DELIVERY_STATE_MISSING", "Project delivery state is unavailable.", "project_id");
  if (delivery.workflow_state === "closed") throw new DeliveryFailure("PROJECT_CLOSED", "Closed projects do not accept production changes.", "project_id");
  return { project, delivery };
}

function getDeliveryJob(db: M0Database, jobId: string): DeliveryJobRow | null {
  return db.prepare(`SELECT job_id, project_id, job_type, state, input_fingerprint, input_json,
    retry_of_job_id, output_artifact_id, export_id, terminal_event_id, error_code,
    created_at, started_at, finished_at, updated_at
    FROM workbench_delivery_jobs WHERE job_id = ?`).get(jobId) as DeliveryJobRow | undefined ?? null;
}

function publicDeliveryJob(row: DeliveryJobRow): WorkbenchDeliveryJobRecord {
  const { input_json: _inputJson, ...job } = row;
  return job;
}

function exportInputFingerprint(snapshot: WorkbenchExportSnapshot): string {
  return createHash("sha256").update(canonicalizeJcs(snapshot), "utf8").digest("hex");
}

function finalArtifactShortId(artifactId: string): string {
  const safe = artifactId.replace(/^artifact_/, "").replace(/[^A-Za-z0-9]/g, "");
  return safe.slice(0, 8) || createHash("sha256").update(artifactId, "utf8").digest("hex").slice(0, 8);
}

function exportTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function assertSafeProjectSegment(projectId: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Project id cannot be represented in the governed export library.", "project_id");
  }
}

function exportFileLocation(relativePath: string, expectedProjectId?: string): { directory: string; final: string; part: string } {
  if (relativePath.includes("\\") || relativePath.includes("..") || relativePath.includes(":")) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export path failed governance validation.");
  }
  const parts = relativePath.split("/");
  if (parts.length !== 4 || parts[0] !== "data" || parts[1] !== "exports" || !parts[2] || !parts[3]
    || (expectedProjectId && parts[2] !== expectedProjectId) || basename(parts[3]) !== parts[3] || !parts[3].endsWith(".mp4")) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export path failed governance validation.");
  }
  const root = resolve(paths.exportsRoot);
  const directory = resolve(root, parts[2]);
  const final = resolve(directory, parts[3]);
  const part = `${final}.part`;
  if (!isPathInside(directory, root) || !isPathInside(final, directory) || !isPathInside(part, directory)) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export path escaped the governed library.");
  }
  return { directory, final, part };
}

function chooseExportRelativePath(projectId: string, artifactId: string, date: Date, db: M0Database): string {
  assertSafeProjectSegment(projectId);
  for (let offsetMs = 0; offsetMs < 10_000; offsetMs += 1) {
    const filename = `${projectId}_${exportTimestamp(new Date(date.getTime() + offsetMs))}_${finalArtifactShortId(artifactId)}.mp4`;
    const relativePath = `data/exports/${projectId}/${filename}`;
    const location = exportFileLocation(relativePath, projectId);
    const claimed = db.prepare("SELECT 1 AS claimed FROM workbench_exports WHERE relative_path = ?").get(relativePath);
    if (!claimed && !existsSync(location.final) && !existsSync(location.part)) return relativePath;
  }
  throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "A unique export filename could not be allocated.");
}

function directoryIdentity(directoryPath: string): DirectoryIdentity {
  const link = lstatSync(directoryPath);
  const value = statSync(directoryPath, { bigint: true });
  if (link.isSymbolicLink() || !value.isDirectory()) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export directory identity is unsafe.");
  }
  return {
    real_path: realpathSync(directoryPath),
    device: value.dev.toString(),
    inode: value.ino.toString(),
    birthtime_ns: value.birthtimeNs.toString()
  };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.real_path === right.real_path
    && left.device === right.device
    && left.inode === right.inode
    && left.birthtime_ns === right.birthtime_ns;
}

function ensureSafeExportDirectory(projectId: string): ExportDirectoryLease {
  assertSafeProjectSegment(projectId);
  const dataRoot = resolve(paths.dataRoot);
  const root = resolve(paths.exportsRoot);
  if (!existsSync(dataRoot) || lstatSync(dataRoot).isSymbolicLink() || !statSync(dataRoot).isDirectory()) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export data root is unsafe.");
  }
  if (!isPathInside(root, dataRoot) || hasExistingSymlinkAncestor(root, dataRoot)) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export library path is unsafe.");
  }
  if (!existsSync(root)) mkdirSync(root);
  if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory() || !isPathInside(realpathSync(root), realpathSync(dataRoot))) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export library path is unsafe.");
  }
  const directory = resolve(root, projectId);
  if (!isPathInside(directory, root) || hasExistingSymlinkAncestor(directory, root)) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Project export path is unsafe.");
  }
  if (!existsSync(directory)) mkdirSync(directory);
  if (lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory()
    || !isPathInside(realpathSync(directory), realpathSync(root))) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Project export path is unsafe.");
  }
  return {
    data_root: directoryIdentity(dataRoot),
    export_root: directoryIdentity(root),
    project_directory: directoryIdentity(directory),
    data_root_path: dataRoot,
    export_root_path: root,
    project_directory_path: directory
  };
}

function assertExportDirectoryLease(lease: ExportDirectoryLease): void {
  if (hasExistingSymlinkAncestor(lease.export_root_path, lease.data_root_path)
    || hasExistingSymlinkAncestor(lease.project_directory_path, lease.export_root_path)
    || !sameDirectoryIdentity(directoryIdentity(lease.data_root_path), lease.data_root)
    || !sameDirectoryIdentity(directoryIdentity(lease.export_root_path), lease.export_root)
    || !sameDirectoryIdentity(directoryIdentity(lease.project_directory_path), lease.project_directory)) {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export directory identity changed during execution.");
  }
}

export class NativeExportFileLease {
  private readonly pendingLines: string[] = [];
  private readonly waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private outputBuffer = "";
  private terminalError: Error | null = null;
  private readonly exitPromise: Promise<number | null>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly controlTimeoutMs = NATIVE_EXPORT_CONTROL_TIMEOUT_MS,
    private readonly copyTimeoutForSize: (sourceSizeBytes: number) => number = calculateNativeExportCopyTimeoutMs
  ) {
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdin.on("error", () => this.failPending(new Error("EXPORT_NATIVE_HANDLE_STDIN_FAILED")));
    child.stdout.on("data", (chunk: string) => {
      this.outputBuffer += chunk;
      for (;;) {
        const newline = this.outputBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.outputBuffer.slice(0, newline).replace(/\r$/, "");
        this.outputBuffer = this.outputBuffer.slice(newline + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(line);
        else this.pendingLines.push(line);
      }
    });
    this.exitPromise = new Promise((resolveExit) => {
      child.once("close", (code) => {
        this.failPending(new Error("EXPORT_NATIVE_HANDLE_EXITED"));
        resolveExit(code);
      });
      child.once("error", () => this.failPending(new Error("EXPORT_NATIVE_HANDLE_FAILED")));
    });
  }

  private failPending(error: Error): void {
    this.terminalError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private nextLine(timeoutMs = this.controlTimeoutMs): Promise<string> {
    if (this.pendingLines.length > 0) return Promise.resolve(this.pendingLines.shift()!);
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise((resolveLine, rejectLine) => {
      const waiter: { resolve: (line: string) => void; reject: (error: Error) => void } = {
        resolve: (line) => { clearTimeout(timer); resolveLine(line); },
        reject: (error) => { clearTimeout(timer); rejectLine(error); }
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        rejectLine(new Error("EXPORT_NATIVE_HANDLE_TIMEOUT"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private async expect(expected: string, timeoutMs = this.controlTimeoutMs): Promise<void> {
    if (await this.nextLine(timeoutMs) !== expected) {
      const error = new Error("EXPORT_NATIVE_HANDLE_PROTOCOL_INVALID");
      this.failPending(error);
      throw error;
    }
  }

  private send(command: string): Promise<void> {
    if (this.terminalError || this.child.exitCode !== null || this.child.stdin.destroyed) {
      return Promise.reject(this.terminalError ?? new Error("EXPORT_NATIVE_HANDLE_EXITED"));
    }
    return new Promise((resolveWrite, rejectWrite) => {
      this.child.stdin.write(`${command}\n`, (error) => {
        if (error) {
          const failure = new Error("EXPORT_NATIVE_HANDLE_STDIN_FAILED");
          this.failPending(failure);
          rejectWrite(failure);
        } else {
          resolveWrite();
        }
      });
    });
  }

  async copy(sourceSizeBytes: number): Promise<void> {
    await this.send("COPY");
    await this.expect("COPIED", this.copyTimeoutForSize(sourceSizeBytes));
  }

  async release(preserveFinal: boolean): Promise<void> {
    await this.send(preserveFinal ? "PRESERVE" : "ABORT");
    this.child.stdin.end();
    await this.expect(preserveFinal ? "PRESERVED" : "ABORTED");
    if (await this.exitPromise !== 0) throw new Error("EXPORT_NATIVE_HANDLE_RELEASE_FAILED");
  }

  terminate(): void {
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill();
  }

  static async acquire(
    directoryLease: ExportDirectoryLease,
    partPath: string,
    finalPath: string,
    sourcePath: string
  ): Promise<NativeExportFileLease> {
    if (process.platform !== "win32") {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Native export handle governance requires the Windows Runtime.");
    }
    const helperPath = resolve(paths.workspaceRoot, "scripts", "hold-export-files.ps1");
    if (!existsSync(helperPath)) {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Native export handle helper is unavailable.");
    }
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const lease = new NativeExportFileLease(child);
    try {
      child.stdin.write([
        directoryLease.data_root_path,
        directoryLease.data_root.device,
        directoryLease.data_root.inode,
        directoryLease.export_root_path,
        directoryLease.export_root.device,
        directoryLease.export_root.inode,
        directoryLease.project_directory_path,
        directoryLease.project_directory.device,
        directoryLease.project_directory.inode,
        partPath,
        finalPath,
        sourcePath
      ].join("\n") + "\n");
      await lease.expect("LEASED");
      assertExportDirectoryLease(directoryLease);
      return lease;
    } catch {
      lease.terminate();
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Native export handle governance failed closed.");
    }
  }
}

function exportRecord(db: M0Database, projectId: string, exportId: string): WorkbenchExportRecord | null {
  const row = db.prepare(`SELECT export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at
    FROM workbench_exports WHERE project_id = ? AND export_id = ?`).get(projectId, exportId) as WorkbenchExportRecord | undefined;
  return row ? { ...row, size_bytes: Number(row.size_bytes) } : null;
}

interface ExportIntegrityCacheRecord {
  signature: string;
  identity: FileIdentity;
  state: "verified" | "failed";
  checked_at: string;
}

const exportIntegrityCache = new Map<string, ExportIntegrityCacheRecord>();

function exportIntegrityCacheKey(record: WorkbenchExportRecord): string {
  return `${record.project_id}\0${record.export_id}`;
}

function exportIntegritySignature(record: WorkbenchExportRecord): string {
  return canonicalizeJcs({
    project_id: record.project_id,
    export_id: record.export_id,
    artifact_id: record.artifact_id,
    relative_path: record.relative_path,
    sha256: record.sha256,
    size_bytes: record.size_bytes,
    created_at: record.created_at
  });
}

function governedCurrentExportRecord(db: M0Database, projectId: string): WorkbenchExportRecord | null {
  const row = db.prepare(`SELECT exported.export_id, exported.project_id, exported.artifact_id,
      exported.relative_path, exported.sha256, exported.size_bytes, exported.created_at
    FROM workbench_delivery_state state
    JOIN projects project ON project.project_id = state.project_id AND json_valid(project.data_json) = 1
    JOIN workbench_exports exported
      ON exported.project_id = state.project_id AND exported.export_id = state.latest_export_id
    JOIN media_artifacts artifact
      ON artifact.artifact_id = exported.artifact_id AND artifact.project_id = exported.project_id
        AND COALESCE(artifact.shot_id, '') = '' AND artifact.role = 'final_video'
        AND artifact.artifact_type = 'video' AND artifact.status = 'active'
    JOIN media_artifact_blobs binding ON binding.artifact_id = artifact.artifact_id
    JOIN media_blobs blob
      ON blob.blob_id = binding.blob_id AND blob.integrity_state = 'verified'
        AND blob.sha256 = exported.sha256 AND blob.size_bytes = exported.size_bytes
    WHERE state.project_id = ? AND state.workflow_state IN ('exported','closed')
      AND state.current_final_artifact_id = exported.artifact_id
      AND state.approved_artifact_id = exported.artifact_id
      AND state.latest_exported_at = exported.created_at
      AND json_extract(project.data_json, '$.exports.final_video_artifact_id') = exported.artifact_id`)
    .get(projectId) as WorkbenchExportRecord | undefined;
  return row ? { ...row, size_bytes: Number(row.size_bytes) } : null;
}

function cacheExportIntegrity(
  record: WorkbenchExportRecord,
  facts: FileIdentity,
  state: "verified" | "failed",
  checkedAt: string
): void {
  exportIntegrityCache.set(exportIntegrityCacheKey(record), {
    signature: exportIntegritySignature(record),
    identity: facts,
    state,
    checked_at: checkedAt
  });
}

export function getWorkbenchExportIntegrityStatus(
  db: M0Database,
  projectId: string,
  mode: "identity" | "full" = "identity",
  dependencies: WorkbenchDeliveryDependencies = {}
): WorkbenchExportIntegrityStatus {
  const delivery = getWorkbenchDeliveryState(db, projectId);
  if (!delivery || !["exported", "closed"].includes(delivery.workflow_state)) {
    return { state: "not_applicable", reason_code: "EXPORT_NOT_APPLICABLE", export_id: null, checked_at: null };
  }
  const record = governedCurrentExportRecord(db, projectId);
  if (!record) {
    return {
      state: "failed",
      reason_code: "EXPORT_INTEGRITY_FAILED",
      export_id: delivery.latest_export_id,
      checked_at: now(dependencies)
    };
  }
  const location = exportFileLocation(record.relative_path, projectId);
  let identity: FileIdentity;
  try {
    identity = inspectExportFileIdentity(location.final);
  } catch {
    return {
      state: "failed",
      reason_code: "EXPORT_INTEGRITY_FAILED",
      export_id: record.export_id,
      checked_at: now(dependencies)
    };
  }
  const signature = exportIntegritySignature(record);
  const cached = exportIntegrityCache.get(exportIntegrityCacheKey(record));
  const cacheMatches = cached?.signature === signature && sameFileIdentity(cached.identity, identity);
  if (mode === "identity" && cacheMatches) {
    return {
      state: cached.state,
      reason_code: cached.state === "verified" ? "EXPORT_INTEGRITY_VERIFIED" : "EXPORT_INTEGRITY_FAILED",
      export_id: record.export_id,
      checked_at: cached.checked_at
    };
  }
  if (mode === "identity") {
    return {
      state: "unverified",
      reason_code: "EXPORT_INTEGRITY_UNVERIFIED",
      export_id: record.export_id,
      checked_at: null
    };
  }
  const checkedAt = now(dependencies);
  let artifact: ReturnType<typeof validateActiveArtifactReference>;
  try {
    artifact = validateActiveArtifactReference(db, {
      artifact_id: record.artifact_id,
      project_id: record.project_id,
      shot_id: "",
      role: "final_video",
      artifact_type: "video"
    });
  } catch {
    artifact = { ok: false, error: { code: "ARTIFACT_REFERENCE_CHECK_FAILED", message: "Artifact reference could not be verified." } };
  }
  if (!artifact.ok || artifact.blob.sha256 !== record.sha256 || artifact.blob.size_bytes !== record.size_bytes) {
    return {
      state: "failed",
      reason_code: "EXPORT_INTEGRITY_FAILED",
      export_id: record.export_id,
      checked_at: checkedAt
    };
  }
  try {
    if (cacheMatches && dependencies.validate_export_file === undefined) {
      return {
        state: cached.state,
        reason_code: cached.state === "verified" ? "EXPORT_INTEGRITY_VERIFIED" : "EXPORT_INTEGRITY_FAILED",
        export_id: record.export_id,
        checked_at: cached.checked_at
      };
    }
    const facts = validateExportFile(location.final, {
      blob_sha256: record.sha256,
      size_bytes: record.size_bytes
    }, dependencies);
    if (dependencies.validate_export_file === undefined) cacheExportIntegrity(record, facts, "verified", checkedAt);
    return {
      state: "verified",
      reason_code: "EXPORT_INTEGRITY_VERIFIED",
      export_id: record.export_id,
      checked_at: checkedAt
    };
  } catch {
    if (dependencies.validate_export_file === undefined) cacheExportIntegrity(record, identity, "failed", checkedAt);
    return {
      state: "failed",
      reason_code: "EXPORT_INTEGRITY_FAILED",
      export_id: record.export_id,
      checked_at: checkedAt
    };
  }
}

function exportRecordIsReusable(db: M0Database, record: WorkbenchExportRecord, dependencies: WorkbenchDeliveryDependencies): boolean {
  try {
    const artifact = validateActiveArtifactReference(db, {
      artifact_id: record.artifact_id,
      project_id: record.project_id,
      shot_id: "",
      role: "final_video",
      artifact_type: "video"
    });
    if (!artifact.ok || artifact.blob.sha256 !== record.sha256 || artifact.blob.size_bytes !== record.size_bytes) return false;
    const location = exportFileLocation(record.relative_path, record.project_id);
    validateExportFile(location.final, { blob_sha256: record.sha256, size_bytes: record.size_bytes }, dependencies);
    return true;
  } catch {
    return false;
  }
}

export function listWorkbenchFinalVersions(db: M0Database, projectId: string): WorkbenchFinalVersionRecord[] {
  return (db.prepare(`SELECT a.artifact_id, a.created_at, j.job_id AS assembly_job_id, j.finished_at AS assembled_at
    FROM media_artifacts a
    LEFT JOIN workbench_delivery_jobs j
      ON j.output_artifact_id = a.artifact_id AND j.project_id = a.project_id
        AND j.job_type = 'assembly' AND j.state = 'succeeded'
    WHERE a.project_id = ? AND COALESCE(a.shot_id, '') = '' AND a.role = 'final_video'
      AND a.artifact_type = 'video' AND a.status = 'active'
    ORDER BY COALESCE(j.finished_at, a.created_at) DESC, a.artifact_id DESC`).all(projectId) as WorkbenchFinalVersionRecord[])
    .map((row) => ({ ...row, assembly_job_id: row.assembly_job_id ?? null, assembled_at: row.assembled_at ?? null }));
}

export function refreshWorkbenchDeliveryAssemblyReadiness(db: M0Database, projectId: string): WorkbenchDeliveryState | null {
  const delivery = getWorkbenchDeliveryState(db, projectId);
  if (!delivery || delivery.workflow_state === "closed" || getActiveWorkbenchDeliveryJob(db, projectId)) return delivery;
  if (!new Set(["not_ready", "ready_to_assemble", "revision_requested"]).has(delivery.workflow_state)) return delivery;
  return refreshWorkbenchAssemblyReadiness(db, projectId);
}

export function decideWorkbenchFinalReview(
  input: {
    project_id: string;
    artifact_id: string;
    decision: WorkbenchFinalReviewDecision;
    shot_ids?: string[];
    reason?: string;
    human_confirmation: boolean;
  },
  db = openM0Database(),
  dependencies: WorkbenchDeliveryDependencies = {}
): WorkbenchDeliveryResult<{
  delivery: WorkbenchDeliveryState;
  decision: WorkbenchFinalReviewDecision;
  regeneration_requests: Array<Record<string, unknown>>;
}> {
  if (input.human_confirmation !== true) {
    return { ok: false, error: { code: "HUMAN_CONFIRMATION_REQUIRED", message: "Final review requires explicit human confirmation." } };
  }
  if (!new Set<WorkbenchFinalReviewDecision>(["accept", "reassemble", "regenerate_shots"]).has(input.decision)) {
    return { ok: false, error: { code: "FINAL_REVIEW_DECISION_INVALID", message: "Final review decision is invalid.", field: "decision" } };
  }
  const selectedShotIds = [...new Set((input.shot_ids ?? []).map((value) => value.trim()).filter(Boolean))];
  if (input.decision === "regenerate_shots" && selectedShotIds.length === 0) {
    return { ok: false, error: { code: "FINAL_REWORK_SELECTION_REQUIRED", message: "Select at least one SHOT for targeted regeneration.", field: "shot_ids" } };
  }
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const { project, delivery } = projectForDelivery(db, input.project_id);
    if (getActiveWorkbenchDeliveryJob(db, input.project_id)) {
      throw new DeliveryFailure("DELIVERY_JOB_ACTIVE", "A delivery Job is active for this project.");
    }
    if (!delivery.current_final_artifact_id || input.artifact_id !== delivery.current_final_artifact_id
      || project.exports.final_video_artifact_id !== delivery.current_final_artifact_id) {
      throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Final review must target the current final Artifact.", "artifact_id");
    }
    const finalArtifact = validateActiveArtifactReference(db, {
      artifact_id: input.artifact_id,
      project_id: input.project_id,
      shot_id: "",
      role: "final_video",
      artifact_type: "video"
    });
    if (!finalArtifact.ok) {
      throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Current final Artifact failed integrity validation.", "artifact_id");
    }

    const timestamp = now(dependencies);
    const eventId = `delivery_event_${uuid(dependencies)}`;
    const requests: Array<Record<string, unknown>> = [];
    let nextState: "approved" | "ready_to_assemble" | "revision_requested";
    let eventType: "final_review_accepted" | "final_review_reassemble" | "final_review_regenerate_shots";
    let reasonCode: string;
    let authorityKind: "final_review_accept" | "final_review_reassemble" | "final_review_regenerate_shots";

    if (input.decision === "accept") {
      if (delivery.workflow_state !== "final_review") {
        throw new DeliveryFailure("FINAL_REVIEW_STATE_INVALID", "Only a current final-review Artifact can be accepted.");
      }
      nextState = "approved";
      eventType = "final_review_accepted";
      reasonCode = "FINAL_REVIEW_ACCEPTED";
      authorityKind = "final_review_accept";
      withWorkbenchProductionMutationAuthority(db, {
        kind: authorityKind, project_id: input.project_id, object_id: input.project_id
      }, () => db.prepare(`UPDATE workbench_delivery_state
          SET workflow_state = 'approved', approved_artifact_id = current_final_artifact_id,
            latest_export_id = NULL, latest_exported_at = NULL, updated_at = ?
          WHERE project_id = ?`)
        .run(timestamp, input.project_id));
    } else if (input.decision === "reassemble") {
      if (!["final_review", "approved", "exported", "legacy_review_required"].includes(delivery.workflow_state)) {
        throw new DeliveryFailure("FINAL_REVIEW_STATE_INVALID", "Project is not eligible for reassembly.");
      }
      const shots = listProjectShots(db, input.project_id);
      if (shots.length === 0 || !shots.every((shot) => Boolean(shot.accepted_clip_artifact_id)
        && validateAcceptedClipReference(db, shot).ok)) {
        throw new DeliveryFailure("ASSEMBLY_NOT_READY", "All accepted clips must remain valid before reassembly.");
      }
      nextState = "ready_to_assemble";
      eventType = "final_review_reassemble";
      reasonCode = "FINAL_REASSEMBLY_REQUESTED";
      authorityKind = "final_review_reassemble";
      withWorkbenchProductionMutationAuthority(db, {
        kind: authorityKind, project_id: input.project_id, object_id: input.project_id
      }, () => db.prepare(`UPDATE workbench_delivery_state
          SET workflow_state = 'ready_to_assemble', legacy_final_artifact_id = NULL,
            assembly_input_fingerprint = NULL, approved_artifact_id = NULL,
            latest_export_id = NULL, latest_exported_at = NULL, updated_at = ?
          WHERE project_id = ?`)
        .run(timestamp, input.project_id));
    } else {
      if (!["final_review", "approved", "exported"].includes(delivery.workflow_state)) {
        throw new DeliveryFailure("FINAL_REVIEW_STATE_INVALID", "Project is not eligible for targeted regeneration.");
      }
      const shots = new Map(listProjectShots(db, input.project_id).map((shot) => [shot.shot_id, shot]));
      for (const shotId of selectedShotIds) {
        const shot = shots.get(shotId);
        if (!shot?.accepted_clip_artifact_id || !validateAcceptedClipReference(db, shot).ok) {
          throw new DeliveryFailure("FINAL_REWORK_SELECTION_REQUIRED", "Every selected SHOT must have a valid current accepted clip.", "shot_ids");
        }
        if (!shot.clip_versions.some((version) => version.artifact_id === shot.accepted_clip_artifact_id)) {
          throw new DeliveryFailure("FINAL_REWORK_SELECTION_REQUIRED", "Selected SHOT acceptance evidence is incomplete.", "shot_ids");
        }
      }
      nextState = "revision_requested";
      eventType = "final_review_regenerate_shots";
      reasonCode = "FINAL_SHOT_REGENERATION_REQUESTED";
      authorityKind = "final_review_regenerate_shots";
      withWorkbenchProductionMutationAuthority(db, {
        kind: authorityKind, project_id: input.project_id, object_id: input.project_id
      }, () => db.prepare(`UPDATE workbench_delivery_state
          SET workflow_state = 'revision_requested', assembly_input_fingerprint = NULL,
            approved_artifact_id = NULL, latest_export_id = NULL, latest_exported_at = NULL, updated_at = ?
          WHERE project_id = ?`)
        .run(timestamp, input.project_id));

      for (const shotId of selectedShotIds) {
        const shot = shots.get(shotId)!;
        const artifactId = shot.accepted_clip_artifact_id;
        const version = shot.clip_versions.find((item) => item.artifact_id === artifactId)!;
        const instruction = input.reason?.trim() || "最终审查要求定向返工";
        const reviewed = markShotClipReview({
          shot_id: shotId,
          artifact_id: artifactId,
          decision: "revision_needed",
          rejection_reasons: [instruction],
          revision_instruction: {
            summary: instruction,
            prompt_delta: input.reason?.trim() || "",
            negative_delta: "",
            priority: "high"
          }
        }, db);
        if (!reviewed.ok) {
          throw new DeliveryFailure("FINAL_REWORK_SELECTION_REQUIRED", "Selected SHOT could not enter regeneration.", "shot_ids");
        }
        reviewed.shot.accepted_clip_artifact_id = "";
        saveShot(db, reviewed.shot);
        const request = {
          request_id: `regeneration_${uuid(dependencies)}`,
          project_id: input.project_id,
          shot_id: shotId,
          artifact_id: artifactId,
          previous_run_id: version.run_id,
          rejection_reasons: [instruction],
          revision_instruction: reviewed.shot.review.latest_revision_instruction,
          source: "final_review",
          status: "draft",
          created_at: timestamp
        };
        withWorkbenchProductionMutationAuthority(db, {
          kind: "regeneration_request", project_id: input.project_id, object_id: request.request_id
        }, () => db.prepare(`INSERT INTO regeneration_requests
            (request_id, project_id, shot_id, artifact_id, previous_run_id, status, data_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`)
          .run(request.request_id, request.project_id, request.shot_id, request.artifact_id,
            request.previous_run_id, canonicalizeJcs(request), timestamp, timestamp));
        requests.push(request);
      }
    }

    withWorkbenchProductionMutationAuthority(db, {
      kind: authorityKind, project_id: input.project_id, object_id: eventId
    }, () => db.prepare(`INSERT INTO workbench_delivery_events
        (event_id, project_id, event_type, from_state, to_state, artifact_id,
          input_fingerprint, reason_code, data_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eventId, input.project_id, eventType, delivery.workflow_state, nextState,
        input.artifact_id, delivery.assembly_input_fingerprint, reasonCode,
        canonicalizeJcs({ shot_ids: selectedShotIds, reason: (input.reason ?? "").trim().slice(0, 1_000) }), timestamp));
    commitWithVerifiedOutcome(db, () => {
      const committed = db.prepare(`SELECT 1 AS present FROM workbench_delivery_events
        WHERE event_id = ? AND project_id = ? AND event_type = ? AND to_state = ?`)
        .get(eventId, input.project_id, eventType, nextState) as { present: number } | undefined;
      const committedState = getWorkbenchDeliveryState(db, input.project_id);
      return Boolean(committed && committedState?.workflow_state === nextState);
    }, "FINAL_REVIEW_RECOVERY_REQUIRED", "Final review commit outcome requires explicit recovery.");
    transactionOpen = false;
    const updated = getWorkbenchDeliveryState(db, input.project_id);
    if (!updated) throw new DeliveryFailure("DELIVERY_STATE_MISSING", "Updated delivery state is unavailable.");
    return { ok: true, data: { delivery: updated, decision: input.decision, regeneration_requests: requests } };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
    }
    return deliveryError(error);
  }
}

export function queueWorkbenchExport(
  input: {
    project_id: string;
    artifact_id: string;
    human_confirmation: boolean;
    retry_of_job_id?: string;
  },
  db = openM0Database(),
  dependencies: WorkbenchDeliveryDependencies = {}
): WorkbenchDeliveryResult<{ reused: boolean; export: WorkbenchExportRecord | null; job: WorkbenchDeliveryJobRecord | null }> {
  if (input.human_confirmation !== true) {
    return { ok: false, error: { code: "EXPORT_CONFIRMATION_REQUIRED", message: "Local export requires explicit human confirmation." } };
  }
  try {
    const { project, delivery } = projectForDelivery(db, input.project_id);
    if (getActiveWorkbenchDeliveryJob(db)) throw new DeliveryFailure("DELIVERY_JOB_ACTIVE", "Another assembly or export Job is active.");
    if (!["approved", "exported"].includes(delivery.workflow_state)
      || !delivery.current_final_artifact_id || delivery.current_final_artifact_id !== input.artifact_id
      || delivery.approved_artifact_id !== input.artifact_id || project.exports.final_video_artifact_id !== input.artifact_id) {
      throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Export must target the current approved final Artifact.", "artifact_id");
    }
    const artifact = validateActiveArtifactReference(db, {
      artifact_id: input.artifact_id,
      project_id: input.project_id,
      shot_id: "",
      role: "final_video",
      artifact_type: "video"
    });
    if (!artifact.ok) throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Approved final Artifact failed integrity validation.");

    const existing = db.prepare(`SELECT export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at
      FROM workbench_exports WHERE project_id = ? AND artifact_id = ?
      ORDER BY created_at DESC, export_id DESC`).all(input.project_id, input.artifact_id) as WorkbenchExportRecord[];
    const reusable = existing.map((record) => ({ ...record, size_bytes: Number(record.size_bytes) }))
      .find((record) => exportRecordIsReusable(db, record, dependencies));
    if (reusable) {
      if (delivery.workflow_state !== "exported" || delivery.latest_export_id !== reusable.export_id) {
        const timestamp = now(dependencies);
        const eventId = `delivery_event_${uuid(dependencies)}`;
        let transactionOpen = false;
        try {
          db.exec("BEGIN IMMEDIATE");
          transactionOpen = true;
          const locked = projectForDelivery(db, input.project_id);
          if (getActiveWorkbenchDeliveryJob(db) || !["approved", "exported"].includes(locked.delivery.workflow_state)
            || locked.delivery.current_final_artifact_id !== input.artifact_id
            || locked.delivery.approved_artifact_id !== input.artifact_id
            || locked.project.exports.final_video_artifact_id !== input.artifact_id
            || !exportRecordIsReusable(db, reusable, dependencies)) {
            throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Delivery state changed before export reuse.");
          }
          withWorkbenchProductionMutationAuthority(db, {
            kind: "export_reuse", project_id: input.project_id, object_id: input.project_id
          }, () => db.prepare(`UPDATE workbench_delivery_state
              SET workflow_state = 'exported', latest_export_id = ?, latest_exported_at = ?, updated_at = ?
              WHERE project_id = ?`)
            .run(reusable.export_id, reusable.created_at, timestamp, input.project_id));
          withWorkbenchProductionMutationAuthority(db, {
            kind: "export_reuse", project_id: input.project_id, object_id: eventId
          }, () => db.prepare(`INSERT INTO workbench_delivery_events
              (event_id, project_id, event_type, from_state, to_state, artifact_id, export_id,
                reason_code, data_json, created_at)
              VALUES (?, ?, 'export_reused', ?, 'exported', ?, ?, 'EXPORT_REUSED', '{"reused":true}', ?)`)
            .run(eventId, input.project_id, locked.delivery.workflow_state, input.artifact_id, reusable.export_id, timestamp));
          commitWithVerifiedOutcome(db, () => {
            const committed = db.prepare(`SELECT 1 AS present FROM workbench_delivery_events
              WHERE event_id = ? AND project_id = ? AND event_type = 'export_reused'
                AND export_id = ? AND to_state = 'exported'`)
              .get(eventId, input.project_id, reusable.export_id) as { present: number } | undefined;
            const committedState = getWorkbenchDeliveryState(db, input.project_id);
            return Boolean(committed && committedState?.workflow_state === "exported"
              && committedState.latest_export_id === reusable.export_id);
          }, "EXPORT_RECOVERY_REQUIRED", "Export reuse commit outcome requires explicit recovery.");
          transactionOpen = false;
        } catch (error) {
          if (transactionOpen) {
            try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
          }
          throw error;
        }
      }
      return { ok: true, data: { reused: true, export: reusable, job: null } };
    }

    const latestPrior = db.prepare(`SELECT job_id, state FROM workbench_delivery_jobs
      WHERE project_id = ? AND job_type = 'export'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(input.project_id) as { job_id: string; state: string } | undefined;
    if (latestPrior && ["failed", "interrupted"].includes(latestPrior.state)
      && input.retry_of_job_id !== latestPrior.job_id) {
      throw new DeliveryFailure("EXPORT_RETRY_REQUIRED", "Explicit retry lineage is required after an interrupted or failed export.", "retry_of_job_id");
    }
    if (input.retry_of_job_id) {
      const prior = getDeliveryJob(db, input.retry_of_job_id);
      if (!latestPrior || latestPrior.job_id !== input.retry_of_job_id
        || !["failed", "interrupted"].includes(latestPrior.state)
        || !prior || prior.project_id !== input.project_id || prior.job_type !== "export"
        || !["failed", "interrupted"].includes(prior.state)) {
        throw new DeliveryFailure("EXPORT_RETRY_INVALID", "Export retry must reference a failed or interrupted export Job.", "retry_of_job_id");
      }
    }

    const timestamp = now(dependencies);
    const relativePath = chooseExportRelativePath(input.project_id, input.artifact_id, new Date(timestamp), db);
    const snapshot: WorkbenchExportSnapshot = {
      contract_version: FINAL_EXPORT_CONTRACT_VERSION,
      project_id: input.project_id,
      artifact_id: input.artifact_id,
      blob_sha256: artifact.blob.sha256,
      size_bytes: artifact.blob.size_bytes,
      relative_path: relativePath
    };
    const fingerprint = exportInputFingerprint(snapshot);
    const jobId = `delivery_job_${uuid(dependencies)}`;
    const eventId = `delivery_event_${uuid(dependencies)}`;
    let transactionOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const locked = projectForDelivery(db, input.project_id);
      if (getActiveWorkbenchDeliveryJob(db)) throw new DeliveryFailure("DELIVERY_JOB_ACTIVE", "Another assembly or export Job is active.");
      const lockedArtifact = validateActiveArtifactReference(db, {
        artifact_id: input.artifact_id,
        project_id: input.project_id,
        shot_id: "",
        role: "final_video",
        artifact_type: "video"
      });
      if (!["approved", "exported"].includes(locked.delivery.workflow_state)
        || locked.delivery.current_final_artifact_id !== input.artifact_id
        || locked.delivery.approved_artifact_id !== input.artifact_id
        || locked.project.exports.final_video_artifact_id !== input.artifact_id
        || !lockedArtifact.ok || lockedArtifact.blob.sha256 !== snapshot.blob_sha256
        || lockedArtifact.blob.size_bytes !== snapshot.size_bytes) {
        throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Approved final Artifact changed before export queueing.", "artifact_id");
      }
      const lockedPrior = db.prepare(`SELECT job_id, state FROM workbench_delivery_jobs
        WHERE project_id = ? AND job_type = 'export'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(input.project_id) as { job_id: string; state: string } | undefined;
      if (lockedPrior && ["failed", "interrupted"].includes(lockedPrior.state)
        && input.retry_of_job_id !== lockedPrior.job_id) {
        throw new DeliveryFailure("EXPORT_RETRY_REQUIRED", "Explicit retry lineage is required after an interrupted or failed export.", "retry_of_job_id");
      }
      if (input.retry_of_job_id
        && (!lockedPrior || lockedPrior.job_id !== input.retry_of_job_id
          || !["failed", "interrupted"].includes(lockedPrior.state))) {
        throw new DeliveryFailure("EXPORT_RETRY_INVALID", "Export retry must reference the latest failed or interrupted export Job.", "retry_of_job_id");
      }
      withWorkbenchProductionMutationAuthority(db, {
        kind: "export_queue", project_id: input.project_id, object_id: jobId
      }, () => {
        db.prepare(`INSERT INTO workbench_delivery_jobs
          (job_id, project_id, job_type, state, input_fingerprint, input_json, retry_of_job_id, created_at, updated_at)
          VALUES (?, ?, 'export', 'queued', ?, ?, ?, ?, ?)`)
          .run(jobId, input.project_id, fingerprint, canonicalizeJcs(snapshot), input.retry_of_job_id ?? null, timestamp, timestamp);
        db.prepare(`INSERT INTO workbench_delivery_events
          (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id,
            input_fingerprint, reason_code, data_json, created_at)
          VALUES (?, ?, ?, 'export_queued', ?, ?, ?, ?, 'EXPORT_QUEUED', '{}', ?)`)
          .run(eventId, input.project_id, jobId, locked.delivery.workflow_state, locked.delivery.workflow_state,
            input.artifact_id, fingerprint, timestamp);
      });
      commitWithVerifiedOutcome(db, () => {
        const committedJob = getDeliveryJob(db, jobId);
        const committedEvent = db.prepare(`SELECT 1 AS present FROM workbench_delivery_events
          WHERE event_id = ? AND project_id = ? AND job_id = ? AND event_type = 'export_queued'`)
          .get(eventId, input.project_id, jobId) as { present: number } | undefined;
        return Boolean(committedJob?.state === "queued" && committedJob.input_fingerprint === fingerprint && committedEvent);
      }, "EXPORT_RECOVERY_REQUIRED", "Export queue commit outcome requires explicit recovery.");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      }
      throw error;
    }
    const job = getDeliveryJob(db, jobId);
    if (!job) throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Queued export Job could not be read.");
    return { ok: true, data: { reused: false, export: null, job: publicDeliveryJob(job) } };
  } catch (error) {
    return deliveryError(error);
  }
}

function exportSnapshotFromJob(job: DeliveryJobRow): WorkbenchExportSnapshot {
  try {
    const parsed = JSON.parse(job.input_json) as WorkbenchExportSnapshot;
    if (parsed.contract_version !== FINAL_EXPORT_CONTRACT_VERSION || parsed.project_id !== job.project_id
      || typeof parsed.artifact_id !== "string" || parsed.artifact_id.length === 0
      || !/^[0-9a-f]{64}$/.test(parsed.blob_sha256) || parsed.size_bytes <= 0
      || exportInputFingerprint(parsed) !== job.input_fingerprint) throw new Error("drift");
    exportFileLocation(parsed.relative_path, parsed.project_id);
    return parsed;
  } catch {
    throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Stored export inputs failed integrity validation.");
  }
}

export function inspectInterruptedWorkbenchExportEvidence(
  job: Pick<DeliveryJobRow, "project_id" | "input_json" | "input_fingerprint">
): boolean {
  try {
    const snapshot = JSON.parse(job.input_json) as WorkbenchExportSnapshot;
    if (snapshot.contract_version !== FINAL_EXPORT_CONTRACT_VERSION || snapshot.project_id !== job.project_id
      || exportInputFingerprint(snapshot) !== job.input_fingerprint) return true;
    const location = exportFileLocation(snapshot.relative_path, snapshot.project_id);
    return existsSync(location.part) || existsSync(location.final);
  } catch {
    return true;
  }
}

export function interruptedWorkbenchExportArtifactId(
  job: Pick<DeliveryJobRow, "project_id" | "input_json" | "input_fingerprint">
): string | null {
  try {
    return exportSnapshotFromJob(job as DeliveryJobRow).artifact_id;
  } catch {
    return null;
  }
}

function markExportJobFailed(
  db: M0Database,
  jobId: string,
  errorCode: string,
  dependencies: WorkbenchDeliveryDependencies
): void {
  let lastError: unknown = new Error("EXPORT_FAILURE_FINALIZATION_NOT_ATTEMPTED");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let transactionOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const job = getDeliveryJob(db, jobId);
      if (!job || job.job_type !== "export") {
        throw new DeliveryFailure("EXPORT_RECOVERY_REQUIRED", "Export failure evidence is unavailable.");
      }
      if (!["queued", "running"].includes(job.state)) {
        db.exec("ROLLBACK");
        transactionOpen = false;
        return;
      }
      const delivery = getWorkbenchDeliveryState(db, job.project_id);
      if (!delivery || !["approved", "exported"].includes(delivery.workflow_state)) {
        throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Export delivery state changed before failure finalization.");
      }
      const timestamp = now(dependencies);
      const terminalEventId = `delivery_event_${uuid(dependencies)}`;
      let artifactId: string | null = null;
      try { artifactId = exportSnapshotFromJob(job).artifact_id; } catch { /* keep low-disclosure failure evidence */ }
      withWorkbenchProductionMutationAuthority(db, {
        kind: "export_failure", project_id: job.project_id, object_id: jobId
      }, () => {
        db.prepare(`UPDATE workbench_delivery_jobs
          SET state = 'failed', terminal_event_id = ?, error_code = ?, finished_at = ?, updated_at = ?
          WHERE job_id = ?`)
          .run(terminalEventId, errorCode, timestamp, timestamp, jobId);
        db.prepare(`INSERT INTO workbench_delivery_events
          (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id,
            input_fingerprint, reason_code, data_json, created_at)
          VALUES (?, ?, ?, 'export_failed', ?, ?, ?, ?, ?, ?, ?)`)
          .run(terminalEventId, job.project_id, jobId, delivery.workflow_state, delivery.workflow_state,
            artifactId, job.input_fingerprint, errorCode,
            canonicalizeJcs({ recovery_evidence_preserved: inspectInterruptedWorkbenchExportEvidence(job) }), timestamp);
      });
      commitWithVerifiedOutcome(db, () => {
        const terminalJob = getDeliveryJob(db, jobId);
        const terminalEvent = db.prepare(`SELECT 1 AS present FROM workbench_delivery_events
          WHERE event_id = ? AND project_id = ? AND job_id = ? AND event_type = 'export_failed'
            AND reason_code = ?`)
          .get(terminalEventId, job.project_id, jobId, errorCode) as { present: number } | undefined;
        return Boolean(terminalJob?.state === "failed"
          && terminalJob.terminal_event_id === terminalEventId
          && terminalJob.error_code === errorCode
          && terminalEvent);
      }, "EXPORT_RECOVERY_REQUIRED", "Export failure outcome requires explicit recovery.");
      transactionOpen = false;
      return;
    } catch (error) {
      lastError = error;
      if (transactionOpen && (db as unknown as { isTransaction?: boolean }).isTransaction === true) {
        try { db.exec("ROLLBACK"); } catch { /* the next attempt performs a fresh durable reconciliation */ }
      }
    }
  }
  throw lastError instanceof DeliveryFailure && lastError.code === "EXPORT_RECOVERY_REQUIRED"
    ? lastError
    : new DeliveryFailure("EXPORT_RECOVERY_REQUIRED", "Export failure outcome requires explicit recovery.");
}

export async function runWorkbenchExportJob(
  jobId: string,
  db?: M0Database,
  dependencies: WorkbenchDeliveryDependencies = {}
): Promise<WorkbenchDeliveryResult<{ job: WorkbenchDeliveryJobRecord; export: WorkbenchExportRecord }>> {
  const connection = db ?? openM0Database();
  const ownsConnection = !db;
  let claimed = false;
  let nativeLease: NativeExportFileLease | null = null;
  let finalBytesReady = false;
  let preserveRecoveryEvidence = false;
  let location: ReturnType<typeof exportFileLocation> | null = null;
  try {
    let claimOpen = false;
    try {
      connection.exec("BEGIN IMMEDIATE");
      claimOpen = true;
      const queued = getDeliveryJob(connection, jobId);
      if (!queued || queued.job_type !== "export" || queued.state !== "queued") {
        throw new DeliveryFailure("EXPORT_JOB_NOT_FOUND", "Queued export Job was not found.");
      }
      const delivery = getWorkbenchDeliveryState(connection, queued.project_id);
      if (!delivery || !["approved", "exported"].includes(delivery.workflow_state)) {
        throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Approved delivery state changed before export start.");
      }
      const snapshot = exportSnapshotFromJob(queued);
      const timestamp = now(dependencies);
      const eventId = `delivery_event_${uuid(dependencies)}`;
      withWorkbenchProductionMutationAuthority(connection, {
        kind: "export_start", project_id: queued.project_id, object_id: jobId
      }, () => {
        connection.prepare(`UPDATE workbench_delivery_jobs
          SET state = 'running', started_at = ?, updated_at = ? WHERE job_id = ?`)
          .run(timestamp, timestamp, jobId);
        connection.prepare(`INSERT INTO workbench_delivery_events
          (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id,
            input_fingerprint, reason_code, data_json, created_at)
          VALUES (?, ?, ?, 'export_started', ?, ?, ?, ?, 'EXPORT_STARTED', '{}', ?)`)
          .run(eventId, queued.project_id, jobId, delivery.workflow_state, delivery.workflow_state,
            snapshot.artifact_id, queued.input_fingerprint, timestamp);
      });
      commitWithVerifiedOutcome(connection, () => {
        const committedJob = getDeliveryJob(connection, jobId);
        const committedEvent = connection.prepare(`SELECT 1 AS present FROM workbench_delivery_events
          WHERE event_id = ? AND project_id = ? AND job_id = ? AND event_type = 'export_started'`)
          .get(eventId, queued.project_id, jobId) as { present: number } | undefined;
        return Boolean(committedJob?.state === "running" && committedEvent);
      }, "EXPORT_RECOVERY_REQUIRED", "Export Job claim outcome requires explicit recovery.");
      claimOpen = false;
      claimed = true;
    } catch (error) {
      if (claimOpen) {
        try { connection.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      }
      throw error;
    }

    const job = getDeliveryJob(connection, jobId);
    if (!job) throw new DeliveryFailure("EXPORT_JOB_NOT_FOUND", "Export Job was not found after claim.");
    const snapshot = exportSnapshotFromJob(job);
    const initial = projectForDelivery(connection, job.project_id);
    if (!["approved", "exported"].includes(initial.delivery.workflow_state)
      || initial.delivery.current_final_artifact_id !== snapshot.artifact_id
      || initial.delivery.approved_artifact_id !== snapshot.artifact_id
      || initial.project.exports.final_video_artifact_id !== snapshot.artifact_id) {
      throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Approved final Artifact changed before export execution.");
    }
    const source = validateActiveArtifactReference(connection, {
      artifact_id: snapshot.artifact_id,
      project_id: snapshot.project_id,
      shot_id: "",
      role: "final_video",
      artifact_type: "video"
    });
    if (!source.ok || source.blob.sha256 !== snapshot.blob_sha256 || source.blob.size_bytes !== snapshot.size_bytes) {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Approved final Artifact bytes changed before export.");
    }

    const directoryLease = ensureSafeExportDirectory(snapshot.project_id);
    location = exportFileLocation(snapshot.relative_path, snapshot.project_id);
    if (existsSync(location.part) || existsSync(location.final)
      || hasExistingSymlinkAncestor(location.part, paths.exportsRoot)) {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export output path is already occupied or unsafe.");
    }
    if (dependencies.before_export_copy) await dependencies.before_export_copy(location.part);
    assertExportDirectoryLease(directoryLease);
    nativeLease = await NativeExportFileLease.acquire(
      directoryLease,
      location.part,
      location.final,
      source.artifact.storage.uri
    );
    if (dependencies.after_export_lease) await dependencies.after_export_lease(location.part);
    assertExportDirectoryLease(directoryLease);
    if (dependencies.after_export_directory_revalidation) {
      await dependencies.after_export_directory_revalidation(location.part);
    }
    await nativeLease.copy(snapshot.size_bytes);
    if (dependencies.after_export_copy) await dependencies.after_export_copy(location.part);
    assertExportDirectoryLease(directoryLease);
    validateExportFile(location.part, snapshot, dependencies);
    validateExportFile(location.final, snapshot, dependencies);
    finalBytesReady = true;
    if (dependencies.before_export_commit) await dependencies.before_export_commit();

    const exportId = `export_${uuid(dependencies)}`;
    const terminalEventId = `delivery_event_${uuid(dependencies)}`;
    const timestamp = now(dependencies);
    let finalizationPhase: "before_begin" | "in_transaction" | "commit_attempted" = "before_begin";
    try {
      connection.exec("BEGIN IMMEDIATE");
      finalizationPhase = "in_transaction";
      const lockedJob = getDeliveryJob(connection, jobId);
      const locked = projectForDelivery(connection, snapshot.project_id);
      if (!lockedJob || lockedJob.state !== "running"
        || lockedJob.input_fingerprint !== exportInputFingerprint(snapshot)
        || !["approved", "exported"].includes(locked.delivery.workflow_state)
        || locked.delivery.current_final_artifact_id !== snapshot.artifact_id
        || locked.delivery.approved_artifact_id !== snapshot.artifact_id
        || locked.project.exports.final_video_artifact_id !== snapshot.artifact_id) {
        throw new DeliveryFailure("FINAL_REVIEW_ARTIFACT_STALE", "Delivery state changed before export finalization.");
      }
      const currentSource = validateActiveArtifactReference(connection, {
        artifact_id: snapshot.artifact_id,
        project_id: snapshot.project_id,
        shot_id: "",
        role: "final_video",
        artifact_type: "video"
      });
      if (!currentSource.ok || currentSource.blob.sha256 !== snapshot.blob_sha256
        || currentSource.blob.size_bytes !== snapshot.size_bytes) {
        throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Final Artifact failed the export commit gate.");
      }
      validateExportFile(location.final, snapshot, dependencies);
      withWorkbenchProductionMutationAuthority(connection, {
        kind: "export_finalization", project_id: snapshot.project_id, object_id: exportId
      }, () => connection.prepare(`INSERT INTO workbench_exports
          (export_id, project_id, artifact_id, relative_path, sha256, size_bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(exportId, snapshot.project_id, snapshot.artifact_id, snapshot.relative_path,
          snapshot.blob_sha256, snapshot.size_bytes, timestamp));
      withWorkbenchProductionMutationAuthority(connection, {
        kind: "export_finalization", project_id: snapshot.project_id, object_id: snapshot.project_id
      }, () => connection.prepare(`UPDATE workbench_delivery_state
          SET workflow_state = 'exported', latest_export_id = ?, latest_exported_at = ?, updated_at = ?
          WHERE project_id = ?`)
        .run(exportId, timestamp, timestamp, snapshot.project_id));
      withWorkbenchProductionMutationAuthority(connection, {
        kind: "export_finalization", project_id: snapshot.project_id, object_id: jobId
      }, () => {
        connection.prepare(`UPDATE workbench_delivery_jobs
          SET state = 'succeeded', export_id = ?, terminal_event_id = ?, finished_at = ?, updated_at = ?
          WHERE job_id = ?`)
          .run(exportId, terminalEventId, timestamp, timestamp, jobId);
        connection.prepare(`INSERT INTO workbench_delivery_events
          (event_id, project_id, job_id, event_type, from_state, to_state, artifact_id, export_id,
            input_fingerprint, reason_code, data_json, created_at)
          VALUES (?, ?, ?, 'export_succeeded', ?, 'exported', ?, ?, ?, 'EXPORT_SUCCEEDED', ?, ?)`)
          .run(terminalEventId, snapshot.project_id, jobId, locked.delivery.workflow_state,
            snapshot.artifact_id, exportId, job.input_fingerprint,
            canonicalizeJcs({ relative_path: snapshot.relative_path, sha256: snapshot.blob_sha256,
              size_bytes: snapshot.size_bytes }), timestamp);
      });
      finalizationPhase = "commit_attempted";
      connection.exec("COMMIT");
      finalizationPhase = "before_begin";
    } catch (error) {
      if (finalizationPhase === "before_begin") {
        throw error;
      }
      let rollbackConfirmed = false;
      if ((connection as unknown as { isTransaction?: boolean }).isTransaction === true) {
        try {
          connection.exec("ROLLBACK");
          rollbackConfirmed = true;
        } catch { /* an uncertain commit/rollback must retain all recovery evidence */ }
      }
      if (!rollbackConfirmed) {
        preserveRecoveryEvidence = true;
        throw new DeliveryFailure("EXPORT_RECOVERY_REQUIRED", "Export commit outcome requires explicit recovery.");
      }
      throw error;
    }
    const completedJob = getDeliveryJob(connection, jobId);
    const completedExport = exportRecord(connection, snapshot.project_id, exportId);
    if (!completedJob || !completedExport) {
      preserveRecoveryEvidence = true;
      throw new DeliveryFailure("EXPORT_RECOVERY_REQUIRED", "Completed export evidence requires explicit recovery.");
    }
    await nativeLease.release(true);
    nativeLease = null;
    return { ok: true, data: { job: publicDeliveryJob(completedJob), export: completedExport } };
  } catch (error) {
    const failure = error instanceof DeliveryFailure
      ? error
      : workbenchProductionMutationError(error).code === "PRODUCTION_MUTATION_CONFLICT"
        ? new DeliveryFailure("PRODUCTION_MUTATION_CONFLICT", "Production mutation failed closed because the database is busy.")
        : new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Local export did not complete.");
    let reportedFailure = failure;
    if (claimed && !preserveRecoveryEvidence) {
      try {
        markExportJobFailed(connection, jobId, failure.code, dependencies);
      } catch {
        preserveRecoveryEvidence = true;
        reportedFailure = new DeliveryFailure("EXPORT_RECOVERY_REQUIRED", "Export failure outcome requires explicit recovery.");
      }
    }
    if (nativeLease) {
      try {
        await nativeLease.release(finalBytesReady || preserveRecoveryEvidence);
        nativeLease = null;
      } catch {
        preserveRecoveryEvidence = true;
        reportedFailure = new DeliveryFailure("EXPORT_RECOVERY_REQUIRED", "Export file-handle outcome requires explicit recovery.");
      }
    }
    return deliveryError(reportedFailure);
  } finally {
    nativeLease?.terminate();
    if (ownsConnection) connection.close();
  }
}

const startedExportJobs = new Set<string>();

export function startWorkbenchExportJob(jobId: string, dependencies: WorkbenchDeliveryDependencies = {}): void {
  if (startedExportJobs.has(jobId)) return;
  startedExportJobs.add(jobId);
  setImmediate(() => {
    void runWorkbenchExportJob(jobId, undefined, dependencies)
      .finally(() => startedExportJobs.delete(jobId));
  });
}

export function resolveWorkbenchExportDownload(
  projectId: string,
  exportId: string,
  db = openM0Database(),
  dependencies: WorkbenchDeliveryDependencies = {}
): WorkbenchDeliveryResult<{
  absolute_path: string;
  file_descriptor: number;
  filename: string;
  size_bytes: number;
  export: WorkbenchExportRecord;
}> {
  let descriptor: number | null = null;
  try {
    const record = exportRecord(db, projectId, exportId);
    if (!record) throw new DeliveryFailure("EXPORT_NOT_FOUND", "Export was not found.");
    if (!exportRecordIsReusable(db, record, dependencies)) {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export file no longer matches its immutable record.");
    }
    const location = exportFileLocation(record.relative_path, projectId);
    const opened = openFileFacts(location.final);
    descriptor = opened.file_descriptor;
    if (opened.sha256 !== record.sha256 || opened.size_bytes !== record.size_bytes) {
      throw new DeliveryFailure("EXPORT_INTEGRITY_FAILED", "Export bytes changed before download streaming.");
    }
    return {
      ok: true,
      data: {
        absolute_path: location.final,
        file_descriptor: opened.file_descriptor,
        filename: basename(location.final),
        size_bytes: record.size_bytes,
        export: record
      }
    };
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* preserve the integrity failure */ }
    }
    return deliveryError(error);
  }
}

export function closeoutWorkbenchDelivery(
  input: { project_id: string; confirmation_phrase: string },
  db = openM0Database(),
  dependencies: WorkbenchDeliveryDependencies = {}
): WorkbenchDeliveryResult<{ delivery: WorkbenchDeliveryState; receipt: WorkbenchCloseoutReceipt }> {
  if (input.confirmation_phrase !== CLOSEOUT_CONFIRMATION_PHRASE) {
    return {
      ok: false,
      error: {
        code: "CLOSEOUT_CONFIRMATION_REQUIRED",
        message: `Closeout requires the exact confirmation phrase: ${CLOSEOUT_CONFIRMATION_PHRASE}.`,
        field: "confirmation_phrase"
      }
    };
  }

  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const { project, delivery } = projectForDelivery(db, input.project_id);
    if (getActiveWorkbenchDeliveryJob(db, input.project_id)) {
      throw new DeliveryFailure("DELIVERY_JOB_ACTIVE", "A delivery Job is active for this project.");
    }
    if (delivery.workflow_state !== "exported" || !delivery.current_final_artifact_id
      || delivery.approved_artifact_id !== delivery.current_final_artifact_id
      || project.exports.final_video_artifact_id !== delivery.current_final_artifact_id
      || !delivery.latest_export_id || !delivery.latest_exported_at) {
      throw new DeliveryFailure("CLOSEOUT_EXPORT_MISMATCH", "Closeout requires the current approved and exported final Artifact.");
    }

    const artifact = validateActiveArtifactReference(db, {
      artifact_id: delivery.current_final_artifact_id,
      project_id: input.project_id,
      shot_id: "",
      role: "final_video",
      artifact_type: "video"
    });
    if (!artifact.ok) {
      throw new DeliveryFailure("CLOSEOUT_EXPORT_MISMATCH", "Current final Artifact failed closeout validation.");
    }
    const exported = exportRecord(db, input.project_id, delivery.latest_export_id);
    if (!exported || exported.artifact_id !== delivery.current_final_artifact_id
      || exported.created_at !== delivery.latest_exported_at
      || exported.sha256 !== artifact.blob.sha256 || exported.size_bytes !== artifact.blob.size_bytes) {
      throw new DeliveryFailure("CLOSEOUT_EXPORT_MISMATCH", "The latest Export receipt does not match the current final Artifact.");
    }
    const location = exportFileLocation(exported.relative_path, input.project_id);
    try {
      validateExportFile(location.final, { blob_sha256: exported.sha256, size_bytes: exported.size_bytes }, dependencies);
    } catch {
      throw new DeliveryFailure("CLOSEOUT_EXPORT_MISMATCH", "Export bytes no longer match the immutable receipt.");
    }

    const timestamp = now(dependencies);
    const eventId = `delivery_event_${uuid(dependencies)}`;
    withWorkbenchProductionMutationAuthority(db, {
      kind: "closeout", project_id: input.project_id, object_id: input.project_id
    }, () => db.prepare(`UPDATE projects
        SET data_json = json_set(data_json, '$.status', 'final_approved'), updated_at = ?
        WHERE project_id = ?`)
      .run(timestamp, input.project_id));
    withWorkbenchProductionMutationAuthority(db, {
      kind: "closeout", project_id: input.project_id, object_id: input.project_id
    }, () => db.prepare(`UPDATE workbench_delivery_state
        SET workflow_state = 'closed', closed_at = ?, updated_at = ?
        WHERE project_id = ?`)
      .run(timestamp, timestamp, input.project_id));
    withWorkbenchProductionMutationAuthority(db, {
      kind: "closeout", project_id: input.project_id, object_id: eventId
    }, () => db.prepare(`INSERT INTO workbench_delivery_events
        (event_id, project_id, event_type, from_state, to_state, artifact_id, export_id,
          reason_code, data_json, created_at)
        VALUES (?, ?, 'closeout', 'exported', 'closed', ?, ?, 'CLOSEOUT_CONFIRMED', ?, ?)`)
      .run(eventId, input.project_id, delivery.current_final_artifact_id, exported.export_id,
        canonicalizeJcs({ confirmation_phrase: CLOSEOUT_CONFIRMATION_PHRASE,
          sha256: exported.sha256, size_bytes: exported.size_bytes }), timestamp));

    try {
      db.exec("COMMIT");
      transactionOpen = false;
    } catch {
      let rollbackConfirmed = false;
      try {
        db.exec("ROLLBACK");
        transactionOpen = false;
        rollbackConfirmed = true;
      } catch { /* closeout outcome requires explicit recovery */ }
      if (!rollbackConfirmed) {
        throw new DeliveryFailure("CLOSEOUT_RECOVERY_REQUIRED", "Closeout commit outcome requires explicit recovery.");
      }
      throw new DeliveryFailure("CLOSEOUT_RECOVERY_REQUIRED", "Closeout commit was not confirmed.");
    }

    const updated = getWorkbenchDeliveryState(db, input.project_id);
    const receipt = db.prepare(`SELECT event_id, project_id, artifact_id, export_id, reason_code, created_at
      FROM workbench_delivery_events WHERE event_id = ? AND project_id = ? AND event_type = 'closeout'`)
      .get(eventId, input.project_id) as WorkbenchCloseoutReceipt | undefined;
    if (!updated || updated.workflow_state !== "closed" || !receipt) {
      throw new DeliveryFailure("CLOSEOUT_RECOVERY_REQUIRED", "Closeout evidence could not be confirmed.");
    }
    return { ok: true, data: { delivery: updated, receipt } };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch {
        return deliveryError(new DeliveryFailure("CLOSEOUT_RECOVERY_REQUIRED", "Closeout outcome requires explicit recovery."));
      }
    }
    return deliveryError(error);
  }
}
