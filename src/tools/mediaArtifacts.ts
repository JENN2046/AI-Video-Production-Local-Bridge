import { closeSync, constants, copyFileSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { ensureM0Directories, paths } from "../paths.js";
import { validateImageBuffer, validateImageFile, type ImageValidationResult } from "./imageValidity.js";
import { validateMp4File } from "./mediaValidity.js";
import { getProject, getShot, type Shot } from "./projects.js";

export type ArtifactType = "image" | "video";
export type ArtifactRole = "storyboard_image" | "generated_clip" | "final_video";
export type ArtifactStatus = "pending_upload" | "active" | "inaccessible" | "expired" | "archived";
export type MediaBlobIntegrityState = "verified" | "unverified" | "missing" | "quarantined";

export interface MediaBlob {
  blob_id: string;
  sha256: string;
  size_bytes: number;
  detected_mime: string;
  storage_uri: string;
  integrity_state: MediaBlobIntegrityState;
  provenance: Record<string, unknown>;
}

export type MediaArtifactSource =
  | { kind: "fixture_path"; path: string }
  | { kind: "local_file_import"; import_filename: string }
  | { kind: "pending_user_upload"; filename?: string; mime_type?: string }
  | { kind: "file_handle"; filename: string; mime_type: string; bytes_base64: string }
  | { kind: "app_upload"; filename: string; mime_type: string; bytes_base64: string }
  | { kind: "accessible_uri"; uri: string; filename?: string; mime_type?: string }
  | { kind: "provider_output_file"; path: string; mime_type?: string };

export interface RegisterMediaArtifactInput {
  artifact_type: ArtifactType;
  role: ArtifactRole;
  source: MediaArtifactSource;
  storage_directory?: string;
  linked_objects?: {
    project_id?: string;
    shot_id?: string;
  };
  metadata?: Partial<MediaArtifact["metadata"]>;
  provenance?: Partial<MediaArtifact["source"]>;
}

export interface MediaArtifact {
  artifact_id: string;
  blob_id: string;
  artifact_type: ArtifactType;
  role: ArtifactRole;
  status: ArtifactStatus;
  storage: {
    uri: string;
    mime_type: string;
    filename: string;
  };
  metadata: {
    width: number;
    height: number;
    duration_seconds: number | null;
    aspect_ratio: string;
    sha256: string;
  };
  linked_objects: {
    project_id: string;
    shot_id: string;
  };
  source: {
    kind: string;
    provider: string;
    provider_job_id: string;
    sha256: string;
    external_url_host: string;
  };
}

export interface ToolError {
  code: string;
  message: string;
}

export type RegisterMediaArtifactResult =
  | { ok: true; artifact: MediaArtifact }
  | { ok: false; error: ToolError };

export type ActivatePendingMediaArtifactResult =
  | { ok: true; artifact: MediaArtifact }
  | { ok: false; error: ToolError };

export interface ActivatePendingMediaArtifactInput {
  artifact_id: string;
  source:
    | { kind: "local_file_import"; import_filename: string }
    | { kind: "app_upload"; filename: string; mime_type: string; bytes_base64: string }
    | { kind: "accessible_uri"; uri: string; filename?: string; mime_type?: string };
}

export interface StoryboardImageTransferGate {
  fixture_path: "PASS" | "FAIL";
  external_transfer_path: "PASS" | "FAIL" | "NOT_TESTED";
}

export class ArtifactStructuredDriftError extends Error {
  readonly code = "ARTIFACT_STRUCTURED_DRIFT";

  constructor(artifactId: string) {
    super(`ARTIFACT_STRUCTURED_DRIFT: ${artifactId} relational binding differs from data_json.`);
  }
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function hasExistingSymlinkAncestor(child: string, parent: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (!isPathInside(resolvedChild, resolvedParent)) return true;
  const parts = relative(resolvedParent, resolvedChild).split(/[\\/]+/).filter(Boolean);
  let current = resolvedParent;
  for (const part of parts) {
    current = resolve(current, part);
    if (!existsSync(current)) return false;
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function validateRole(artifactType: ArtifactType, role: ArtifactRole): ToolError | null {
  if (role === "storyboard_image" && artifactType !== "image") {
    return { code: "INVALID_ARTIFACT_ROLE", message: "storyboard_image artifacts must be images." };
  }

  if ((role === "generated_clip" || role === "final_video") && artifactType !== "video") {
    return { code: "INVALID_ARTIFACT_ROLE", message: `${role} artifacts must be videos.` };
  }

  return null;
}

function imageValidationError(validation: ImageValidationResult): ToolError {
  return {
    code: validation.error_code || "IMAGE_FILE_INVALID",
    message: validation.error || "Image validation failed."
  };
}

function mimeTypeFor(filename: string, artifactType: ArtifactType): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".mp4") return "video/mp4";
  return artifactType === "image" ? "application/octet-stream" : "application/octet-stream";
}

function mediaRootFor(artifactType: ArtifactType, role: ArtifactRole): string {
  if (role === "final_video") return paths.finalArtifactsRoot;
  return artifactType === "image" ? paths.imageArtifactsRoot : paths.videoArtifactsRoot;
}

function defaultMetadata(artifactType: ArtifactType, metadata: RegisterMediaArtifactInput["metadata"] = {}): MediaArtifact["metadata"] {
  if (artifactType === "image") {
    return {
      width: metadata.width ?? 1,
      height: metadata.height ?? 1,
      duration_seconds: null,
      aspect_ratio: metadata.aspect_ratio ?? "1:1",
      sha256: metadata.sha256 ?? ""
    };
  }

  return {
    width: metadata.width ?? 1080,
    height: metadata.height ?? 1920,
    duration_seconds: metadata.duration_seconds ?? 1,
    aspect_ratio: metadata.aspect_ratio ?? "9:16",
    sha256: metadata.sha256 ?? ""
  };
}

function detectMimeFromBytes(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  return "";
}

function sameResolvedPath(first: string, second: string): boolean {
  const left = resolve(first);
  const right = resolve(second);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function hashLocalFile(filePath: string): { sha256: string; size_bytes: number; header: Buffer } {
  const descriptor = openSync(filePath, "r");
  try {
    const before = fstatSync(descriptor);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    const header = Buffer.alloc(16);
    let size = 0;
    let headerLength = 0;
    while (true) {
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      if (headerLength < header.length) {
        const copied = Math.min(read, header.length - headerLength);
        chunk.copy(header, headerLength, 0, copied);
        headerLength += copied;
      }
      size += read;
    }
    const after = fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== after.size) throw new Error("MEDIA_FILE_CHANGED_DURING_HASH");
    return { sha256: hash.digest("hex"), size_bytes: size, header: header.subarray(0, headerLength) };
  } finally {
    closeSync(descriptor);
  }
}

function databaseIsInTransaction(db: M0Database): boolean {
  return Boolean((db as unknown as { isTransaction?: boolean }).isTransaction);
}

function buildBlobForArtifact(artifact: MediaArtifact, mediaRoot = paths.mediaRoot): MediaBlob {
  const uri = artifact.storage.uri;
  if (uri && !/^https?:\/\//i.test(uri) && existsSync(uri) && !lstatSync(uri).isSymbolicLink() && statSync(uri).isFile()) {
    const facts = hashLocalFile(uri);
    const detectedMime = detectMimeFromBytes(facts.header);
    const typeMatches = artifact.artifact_type === "image" ? detectedMime.startsWith("image/") : detectedMime === "video/mp4";
    if (facts.size_bytes > 0 && typeMatches) {
      return {
        blob_id: `blob_sha256_${facts.sha256}`,
        sha256: facts.sha256,
        size_bytes: facts.size_bytes,
        detected_mime: detectedMime,
        storage_uri: resolve(uri),
        integrity_state: "verified",
        provenance: { source: artifact.source.kind, immutable: true, media_root: resolve(mediaRoot) }
      };
    }
  }

  const missing = Boolean(uri && !/^https?:\/\//i.test(uri) && !existsSync(uri));
  return {
    blob_id: `blob_unverified_${createHash("sha256").update(artifact.artifact_id).digest("hex")}`,
    sha256: "",
    size_bytes: 0,
    detected_mime: "",
    storage_uri: uri,
    integrity_state: missing ? "missing" : "unverified",
    provenance: { source: artifact.source.kind, immutable: true, reason: missing ? "LOCAL_FILE_MISSING" : "CONTENT_NOT_LOCALLY_VERIFIABLE" }
  };
}

function persistBlob(db: M0Database, blob: MediaBlob): MediaBlob {
  if (blob.integrity_state === "verified") {
    const existing = db.prepare(`
      SELECT blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json
      FROM media_blobs WHERE sha256 = ? AND integrity_state = 'verified'
    `).get(blob.sha256) as {
      blob_id: string;
      sha256: string;
      size_bytes: number;
      detected_mime: string;
      storage_uri: string;
      integrity_state: MediaBlobIntegrityState;
      provenance_json: string;
    } | undefined;
    if (existing) {
      if (Number(existing.size_bytes) !== blob.size_bytes || existing.detected_mime !== blob.detected_mime) {
        throw new Error("MEDIA_BLOB_CONTENT_CONFLICT");
      }
      return {
        blob_id: existing.blob_id,
        sha256: existing.sha256,
        size_bytes: Number(existing.size_bytes),
        detected_mime: existing.detected_mime,
        storage_uri: existing.storage_uri,
        integrity_state: existing.integrity_state,
        provenance: JSON.parse(existing.provenance_json) as Record<string, unknown>
      };
    }
  }
  db.prepare(`
    INSERT INTO media_blobs (blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(blob.blob_id, blob.sha256, blob.size_bytes, blob.detected_mime, blob.storage_uri, blob.integrity_state, JSON.stringify(blob.provenance));
  return blob;
}

function persistMediaArtifactInternal(db: M0Database, artifact: MediaArtifact, allowStatusTransition: boolean, mediaRoot = paths.mediaRoot): void {
  const manageTransaction = !databaseIsInTransaction(db);
  if (manageTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare(`
      SELECT project_id, shot_id, role, artifact_type, status FROM media_artifacts WHERE artifact_id = ?
    `).get(artifact.artifact_id) as { project_id: string | null; shot_id: string | null; role: string; artifact_type: string; status: ArtifactStatus } | undefined;
    if (existing && (
      (existing.project_id ?? "") !== artifact.linked_objects.project_id
      || (existing.shot_id ?? "") !== artifact.linked_objects.shot_id
      || existing.role !== artifact.role
      || existing.artifact_type !== artifact.artifact_type
    )) {
      throw new Error("MEDIA_ARTIFACT_IDENTITY_IMMUTABLE");
    }
    if (existing && existing.status !== artifact.status && !allowStatusTransition) {
      throw new Error("MEDIA_ARTIFACT_STATUS_TRANSITION_REQUIRED");
    }

    let blob: MediaBlob;
    if (artifact.blob_id) {
      const row = db.prepare(`
        SELECT blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json
        FROM media_blobs WHERE blob_id = ?
      `).get(artifact.blob_id) as {
        blob_id: string; sha256: string; size_bytes: number; detected_mime: string; storage_uri: string;
        integrity_state: MediaBlobIntegrityState; provenance_json: string;
      } | undefined;
      if (!row) throw new Error("MEDIA_BLOB_NOT_FOUND");
      blob = { ...row, size_bytes: Number(row.size_bytes), provenance: JSON.parse(row.provenance_json) as Record<string, unknown> };
    } else {
      blob = persistBlob(db, buildBlobForArtifact(artifact, mediaRoot));
      artifact.blob_id = blob.blob_id;
    }
    if (blob.integrity_state === "verified") {
      artifact.metadata.sha256 = blob.sha256;
      artifact.source.sha256 = blob.sha256;
      artifact.storage.mime_type = blob.detected_mime;
      artifact.storage.uri = blob.storage_uri;
      artifact.storage.filename = basename(blob.storage_uri);
    } else if (artifact.status === "active") {
      throw new Error("ACTIVE_ARTIFACT_REQUIRES_VERIFIED_BLOB");
    }

    db.prepare(`
      INSERT INTO media_artifacts (
        artifact_id, project_id, shot_id, role, artifact_type, status, data_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(artifact_id) DO UPDATE SET
        status = excluded.status,
        data_json = excluded.data_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      artifact.artifact_id,
      artifact.linked_objects.project_id || null,
      artifact.linked_objects.shot_id || null,
      artifact.role,
      artifact.artifact_type,
      artifact.status,
      JSON.stringify(artifact)
    );
    db.prepare(`
      INSERT INTO media_artifact_blobs (artifact_id, blob_id) VALUES (?, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET blob_id = excluded.blob_id
    `).run(artifact.artifact_id, artifact.blob_id);
    if (manageTransaction) db.exec("COMMIT");
  } catch (error) {
    if (manageTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function persistMediaArtifact(db: M0Database, artifact: MediaArtifact): void {
  persistMediaArtifactInternal(db, artifact, false);
}

const ARTIFACT_STATUS_TRANSITIONS: Readonly<Record<ArtifactStatus, readonly ArtifactStatus[]>> = {
  pending_upload: ["active", "inaccessible", "archived"],
  active: ["inaccessible", "expired", "archived"],
  inaccessible: ["active", "expired", "archived"],
  expired: ["archived"],
  archived: []
};

export function transitionMediaArtifactStatus(
  artifactId: string,
  nextStatus: ArtifactStatus,
  db = openM0Database()
): { ok: true; artifact: MediaArtifact } | { ok: false; error: ToolError } {
  const artifact = getMediaArtifact(db, artifactId);
  if (!artifact) return { ok: false, error: { code: "ARTIFACT_NOT_FOUND", message: `Artifact not found: ${artifactId}` } };
  if (artifact.status === nextStatus) return { ok: true, artifact };
  if (!ARTIFACT_STATUS_TRANSITIONS[artifact.status].includes(nextStatus)) {
    return { ok: false, error: { code: "INVALID_ARTIFACT_STATUS_TRANSITION", message: `${artifact.status} cannot transition to ${nextStatus}.` } };
  }
  artifact.status = nextStatus;
  try {
    persistMediaArtifactInternal(db, artifact, true);
    return { ok: true, artifact };
  } catch (error) {
    return { ok: false, error: { code: "ARTIFACT_STATUS_TRANSITION_FAILED", message: error instanceof Error ? error.message : "Artifact status transition failed." } };
  }
}

function buildArtifact(input: RegisterMediaArtifactInput, status: ArtifactStatus, filename: string, uri: string, mimeType: string): MediaArtifact {
  return {
    artifact_id: `artifact_${randomUUID()}`,
    blob_id: "",
    artifact_type: input.artifact_type,
    role: input.role,
    status,
    storage: {
      uri,
      mime_type: mimeType,
      filename
    },
    metadata: defaultMetadata(input.artifact_type, input.metadata),
    linked_objects: {
      project_id: input.linked_objects?.project_id ?? "",
      shot_id: input.linked_objects?.shot_id ?? ""
    },
    source: {
      kind: input.source.kind,
      provider: input.provenance?.provider ?? "",
      provider_job_id: input.provenance?.provider_job_id ?? "",
      sha256: input.provenance?.sha256 ?? input.metadata?.sha256 ?? "",
      external_url_host: input.provenance?.external_url_host ?? ""
    }
  };
}

function buildValidatedImageArtifact(
  input: RegisterMediaArtifactInput,
  artifactId: string,
  filename: string,
  uri: string,
  validation: ImageValidationResult
): MediaArtifact {
  return {
    ...buildArtifact(
      {
        ...input,
        metadata: {
          ...input.metadata,
          width: validation.width,
          height: validation.height,
          duration_seconds: null,
          aspect_ratio: validation.aspect_ratio,
          sha256: validation.sha256
        },
        provenance: {
          ...input.provenance,
          sha256: validation.sha256
        }
      },
      "active",
      filename,
      uri,
      validation.detected_mime || mimeTypeFor(filename, input.artifact_type)
    ),
    artifact_id: artifactId
  };
}

function filenameHasPathTraversal(filename: string): boolean {
  return filename.includes("..") || filename.includes("/") || filename.includes("\\") || isAbsolute(filename);
}

function sha256ForFile(filePath: string): string {
  return hashLocalFile(filePath).sha256;
}

interface LocalMediaFacts {
  sha256: string;
  size_bytes: number;
  detected_mime: string;
  width: number;
  height: number;
  duration_seconds: number | null;
  aspect_ratio: string;
}

class MediaActivationInjectedCrash extends Error {
  constructor(readonly causeValue: unknown) {
    super(causeValue instanceof Error ? causeValue.message : "MEDIA_ACTIVATION_INJECTED_CRASH");
  }
}

function mediaActivationErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : "MEDIA_ACTIVATION_FAILED";
  if (raw.includes("media_activation_journal.artifact_id")) return "MEDIA_ACTIVATION_ALREADY_PENDING";
  if (/^[A-Z][A-Z0-9_]+$/.test(raw)) return raw;
  const systemCode = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof systemCode === "string" && /^E[A-Z]+$/.test(systemCode)) return "MEDIA_ACTIVATION_IO_FAILED";
  if (/constraint|sqlite|database/i.test(raw)) return "MEDIA_ACTIVATION_DATABASE_FAILED";
  return "MEDIA_ACTIVATION_FAILED";
}

function copyToStagingExclusively(sourcePath: string, stagingPath: string): ToolError | null {
  try {
    copyFileSync(sourcePath, stagingPath, constants.COPYFILE_EXCL);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { code: "MEDIA_ACTIVATION_ALREADY_PENDING", message: "An existing staged activation owns this Artifact id." };
    }
    return { code: "MEDIA_ACTIVATION_IO_FAILED", message: "Media bytes could not be copied into app-controlled staging." };
  }
}

function writeToStagingExclusively(stagingPath: string, bytes: Buffer): ToolError | null {
  try {
    writeFileSync(stagingPath, bytes, { flag: "wx" });
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { code: "MEDIA_ACTIVATION_ALREADY_PENDING", message: "An existing staged activation owns this Artifact id." };
    }
    return { code: "MEDIA_ACTIVATION_IO_FAILED", message: "Media bytes could not be written into app-controlled staging." };
  }
}

function activationRoots(mediaRoot: string): { activation: string; staging: string; pending: string; quarantine: string; journal: string } {
  const activation = resolve(mediaRoot, ".activation");
  return {
    activation,
    staging: resolve(activation, "staging"),
    pending: resolve(activation, "pending"),
    quarantine: resolve(activation, "quarantine"),
    journal: resolve(activation, "journal")
  };
}

function ensureSafeMediaRoot(mediaRoot: string): void {
  const root = resolve(mediaRoot);
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
  const canonical = resolve(realpathSync(root));
  const comparable = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  if (comparable(canonical) !== comparable(root)) throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
}

function ensureSafeActivationRoots(mediaRoot: string, create: boolean): ReturnType<typeof activationRoots> {
  const root = resolve(mediaRoot);
  if (create) ensureSafeMediaRoot(root);
  if (!existsSync(root)) {
    if (!create) return activationRoots(root);
    throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
  }
  if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
  const canonicalRoot = resolve(realpathSync(root));
  const roots = activationRoots(root);
  for (const directory of [roots.activation, roots.staging, roots.pending, roots.quarantine, roots.journal]) {
    if (create && !existsSync(directory)) mkdirSync(directory);
    if (!existsSync(directory)) continue;
    if (lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory()) throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
    const canonicalDirectory = resolve(realpathSync(directory));
    if (!isPathInside(canonicalDirectory, canonicalRoot)) throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
  }
  return roots;
}

interface MediaActivationMarker {
  version: 1;
  activation_id: string;
  artifact_id: string;
  media_root: string;
  artifact_type: ArtifactType;
  role: ArtifactRole;
  expected_sha256: string;
  expected_size_bytes: number;
  detected_mime: string;
  staging_path: string;
  pending_path: string;
  final_path: string;
  artifact_json: string;
}

interface MediaStagingOwner {
  version: 1;
  artifact_id: string;
  media_root: string;
  staging_path: string;
}

function stagingOwnerPath(artifactId: string): string {
  const roots = ensureSafeActivationRoots(paths.mediaRoot, false);
  const digest = createHash("sha256").update(artifactId).digest("hex");
  const target = resolve(roots.journal, `staging-owner-${digest}.json`);
  if (!isPathInside(target, roots.journal) || hasExistingSymlinkAncestor(target, roots.activation)) throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
  return target;
}

function claimStagingOwnership(artifact: MediaArtifact, mediaRoot: string): ToolError | null {
  let roots: ReturnType<typeof activationRoots>;
  try { roots = ensureSafeActivationRoots(paths.mediaRoot, true); }
  catch { return { code: "MEDIA_ACTIVATION_PATH_UNSAFE", message: "Media activation ownership storage is not app-controlled." }; }
  const target = stagingOwnerPath(artifact.artifact_id);
  const owner: MediaStagingOwner = {
    version: 1,
    artifact_id: artifact.artifact_id,
    media_root: resolve(mediaRoot),
    staging_path: stagedPathForArtifact(artifact, mediaRoot)
  };
  try {
    writeFileSync(target, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { code: "MEDIA_ACTIVATION_ALREADY_PENDING", message: "An existing staging owner controls this Artifact id." };
    }
    if (existsSync(target)) {
      try { rmSync(target, { force: true }); } catch { /* recovery will fail closed on a partial owner record */ }
    }
    return { code: "MEDIA_ACTIVATION_IO_FAILED", message: "Media staging ownership could not be recorded." };
  }
}

function removeStagingOwnership(artifactId: string): void {
  const target = stagingOwnerPath(artifactId);
  if (existsSync(target) && !lstatSync(target).isSymbolicLink()) rmSync(target, { force: true });
}

function reconcileFailedStagingWrite(artifactId: string, stagingPath: string, stageError: ToolError): void {
  if (stageError.code === "MEDIA_ACTIVATION_ALREADY_PENDING") return;
  let stagingCleared = !existsSync(stagingPath);
  if (!stagingCleared) {
    try {
      if (!lstatSync(stagingPath).isSymbolicLink() && statSync(stagingPath).isFile()) {
        rmSync(stagingPath, { force: true });
        stagingCleared = !existsSync(stagingPath);
      }
    } catch { /* retain the owner so recovery can retry safe cleanup */ }
  }
  if (stagingCleared) {
    try { removeStagingOwnership(artifactId); } catch { /* recovery retains the ownership record */ }
  }
}

function copyToOwnedStaging(
  artifact: MediaArtifact,
  sourcePath: string,
  mediaRoot = paths.mediaRoot,
  afterStagingWritten?: (stagingPath: string) => void
): ToolError | null {
  const ownerError = claimStagingOwnership(artifact, mediaRoot);
  if (ownerError) return ownerError;
  const stagingPath = stagedPathForArtifact(artifact, mediaRoot);
  const stageError = copyToStagingExclusively(sourcePath, stagingPath);
  if (stageError) {
    reconcileFailedStagingWrite(artifact.artifact_id, stagingPath, stageError);
    return stageError;
  }
  if (afterStagingWritten) {
    try { afterStagingWritten(stagingPath); } catch (error) { throw new MediaActivationInjectedCrash(error); }
  }
  return null;
}

function writeToOwnedStaging(artifact: MediaArtifact, bytes: Buffer, mediaRoot = paths.mediaRoot): ToolError | null {
  const ownerError = claimStagingOwnership(artifact, mediaRoot);
  if (ownerError) return ownerError;
  const stagingPath = stagedPathForArtifact(artifact, mediaRoot);
  const stageError = writeToStagingExclusively(stagingPath, bytes);
  if (stageError) {
    reconcileFailedStagingWrite(artifact.artifact_id, stagingPath, stageError);
    return stageError;
  }
  return null;
}

function markerPath(activationId: string): string {
  if (!/^activation_[0-9a-f-]{36}$/i.test(activationId)) throw new Error("MEDIA_ACTIVATION_MARKER_INVALID");
  const roots = ensureSafeActivationRoots(paths.mediaRoot, false);
  const target = resolve(roots.journal, `${activationId}.json`);
  if (!isPathInside(target, roots.journal) || hasExistingSymlinkAncestor(target, roots.activation)) throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
  return target;
}

function writeActivationMarker(marker: MediaActivationMarker): string {
  const roots = ensureSafeActivationRoots(paths.mediaRoot, true);
  const target = markerPath(marker.activation_id);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, target);
  return target;
}

function removeActivationMarker(activationId: string): void {
  const target = markerPath(activationId);
  if (existsSync(target) && !lstatSync(target).isSymbolicLink()) rmSync(target, { force: true });
  const temporary = `${target}.tmp`;
  if (existsSync(temporary) && !lstatSync(temporary).isSymbolicLink()) rmSync(temporary, { force: true });
}

function activationFilePath(root: string, artifact: MediaArtifact, suffix: string, activationRoot = paths.mediaActivationRoot): string {
  const extension = extname(artifact.storage.filename).toLowerCase() || (artifact.artifact_type === "image" ? ".img" : ".mp4");
  const target = resolve(root, `${artifact.artifact_id}${extension}${suffix}`);
  if (!isPathInside(target, root) || hasExistingSymlinkAncestor(target, activationRoot)) throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
  return target;
}

function stagedPathForArtifact(artifact: MediaArtifact, mediaRoot = paths.mediaRoot): string {
  const roots = activationRoots(mediaRoot);
  return activationFilePath(roots.staging, artifact, ".stage", roots.activation);
}

function pendingPathForArtifact(artifact: MediaArtifact, mediaRoot = paths.mediaRoot): string {
  const roots = activationRoots(mediaRoot);
  return activationFilePath(roots.pending, artifact, ".pending", roots.activation);
}

function localMediaFacts(filePath: string, artifact: MediaArtifact): LocalMediaFacts {
  if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink() || !statSync(filePath).isFile()) throw new Error("MEDIA_ACTIVATION_FILE_UNREADABLE");
  const fileFacts = hashLocalFile(filePath);
  if (artifact.artifact_type === "image") {
    const validation = validateImageFile(filePath);
    if (!validation.ok) throw new Error(validation.error_code || "IMAGE_DECODE_FAILED");
    return {
      sha256: validation.sha256,
      size_bytes: fileFacts.size_bytes,
      detected_mime: validation.detected_mime,
      width: validation.width,
      height: validation.height,
      duration_seconds: null,
      aspect_ratio: validation.aspect_ratio
    };
  }
  const validation = validateMp4File(filePath);
  if (validation.status !== "PASS") throw new Error(validation.status === "NOT_TESTED" ? "VIDEO_PROBE_UNAVAILABLE" : "VIDEO_FILE_INVALID");
  const detectedMime = detectMimeFromBytes(fileFacts.header);
  if (detectedMime !== "video/mp4") throw new Error("MEDIA_MIME_MISMATCH");
  return {
    sha256: fileFacts.sha256,
    size_bytes: fileFacts.size_bytes,
    detected_mime: detectedMime,
    width: artifact.metadata.width,
    height: artifact.metadata.height,
    duration_seconds: validation.duration_seconds,
    aspect_ratio: artifact.metadata.aspect_ratio
  };
}

function applyLocalMediaFacts(artifact: MediaArtifact, facts: LocalMediaFacts): void {
  artifact.metadata = {
    width: facts.width,
    height: facts.height,
    duration_seconds: facts.duration_seconds,
    aspect_ratio: facts.aspect_ratio,
    sha256: facts.sha256
  };
  artifact.source.sha256 = facts.sha256;
  artifact.storage.mime_type = facts.detected_mime;
}

function quarantineActivationFile(artifact: MediaArtifact, candidates: string[], mediaRoot = paths.mediaRoot): void {
  const roots = activationRoots(mediaRoot);
  mkdirSync(roots.quarantine, { recursive: true });
  const quarantine = activationFilePath(roots.quarantine, artifact, ".failed", roots.activation);
  for (const candidate of candidates) {
    if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink()) continue;
    if (existsSync(quarantine)) rmSync(quarantine, { force: true });
    renameSync(candidate, quarantine);
    return;
  }
}

function moveActivationFileExclusively(sourcePath: string, finalPath: string): void {
  try {
    linkSync(sourcePath, finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("MEDIA_ACTIVATION_FINAL_PATH_EXISTS");
    throw error;
  }
  try {
    rmSync(sourcePath);
  } catch (error) {
    try { rmSync(finalPath, { force: true }); } catch { /* recovery detects the two-link crash window */ }
    throw error;
  }
}

function samePhysicalFile(firstPath: string, secondPath: string): boolean {
  if (!existsSync(firstPath) || !existsSync(secondPath)) return false;
  if (lstatSync(firstPath).isSymbolicLink() || lstatSync(secondPath).isSymbolicLink()) return false;
  const first = statSync(firstPath);
  const second = statSync(secondPath);
  return first.isFile() && second.isFile() && first.dev === second.dev && first.ino !== 0 && first.ino === second.ino;
}

function commitStagedMediaArtifact(
  db: M0Database,
  artifact: MediaArtifact,
  allowStatusTransition: boolean,
  options: { after_journal_staged?: (stagingPath: string) => void; after_pending_placed?: (pendingPath: string) => void; after_file_placed?: (finalPath: string) => void; remove_post_commit_file?: (finalPath: string) => void; media_root?: string } = {}
): RegisterMediaArtifactResult {
  const activationId = `activation_${randomUUID()}`;
  const mediaRoot = resolve(options.media_root ?? paths.mediaRoot);
  const roots = ensureSafeActivationRoots(mediaRoot, true);
  const stagingPath = stagedPathForArtifact(artifact, mediaRoot);
  const pendingPath = pendingPathForArtifact(artifact, mediaRoot);
  const finalPath = resolve(artifact.storage.uri);
  const manageTransaction = !databaseIsInTransaction(db);
  let journalCreated = false;
  let markerCreated = false;
  let finalPathOwned = false;
  try {
    if (!isPathInside(finalPath, mediaRoot) || hasExistingSymlinkAncestor(finalPath, mediaRoot)) {
      throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
    }
    mkdirSync(dirname(finalPath), { recursive: true });
    if (hasExistingSymlinkAncestor(finalPath, mediaRoot)) throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
    const facts = localMediaFacts(stagingPath, artifact);
    applyLocalMediaFacts(artifact, facts);
    const marker: MediaActivationMarker = {
      version: 1,
      activation_id: activationId,
      artifact_id: artifact.artifact_id,
      media_root: mediaRoot,
      artifact_type: artifact.artifact_type,
      role: artifact.role,
      expected_sha256: facts.sha256,
      expected_size_bytes: facts.size_bytes,
      detected_mime: facts.detected_mime,
      staging_path: stagingPath,
      pending_path: pendingPath,
      final_path: finalPath,
      artifact_json: JSON.stringify(artifact)
    };
    const insertJournal = (): void => {
      db.prepare(`INSERT INTO media_activation_journal
        (activation_id, artifact_id, state, artifact_type, role, expected_sha256, expected_size_bytes, detected_mime,
         staging_path, pending_path, final_path, artifact_json)
        VALUES (?, ?, 'staged', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(activationId, artifact.artifact_id, artifact.artifact_type, artifact.role, facts.sha256, facts.size_bytes, facts.detected_mime,
          stagingPath, pendingPath, finalPath, JSON.stringify(artifact));
      journalCreated = true;
    };
    if (manageTransaction) insertJournal();
    writeActivationMarker(marker);
    markerCreated = true;
    if (!manageTransaction) insertJournal();
    removeStagingOwnership(artifact.artifact_id);
    if (options.after_journal_staged) {
      try { options.after_journal_staged(stagingPath); } catch (error) { throw new MediaActivationInjectedCrash(error); }
    }
    renameSync(stagingPath, pendingPath);
    if (options.after_pending_placed) {
      try { options.after_pending_placed(pendingPath); } catch (error) { throw new MediaActivationInjectedCrash(error); }
    }
    db.prepare("UPDATE media_activation_journal SET state = 'file_placed', updated_at = CURRENT_TIMESTAMP WHERE activation_id = ? AND state = 'staged'").run(activationId);
    moveActivationFileExclusively(pendingPath, finalPath);
    finalPathOwned = true;
    if (options.after_file_placed) {
      try { options.after_file_placed(finalPath); } catch (error) { throw new MediaActivationInjectedCrash(error); }
    }
    const committedFacts = localMediaFacts(finalPath, artifact);
    if (committedFacts.sha256 !== facts.sha256 || committedFacts.size_bytes !== facts.size_bytes || committedFacts.detected_mime !== facts.detected_mime) {
      throw new Error("MEDIA_ACTIVATION_CONTENT_DRIFT");
    }
    if (manageTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      persistMediaArtifactInternal(db, artifact, allowStatusTransition, mediaRoot);
      db.prepare("UPDATE media_activation_journal SET state = 'committed', final_path = ?, artifact_json = ?, error_code = '', updated_at = CURRENT_TIMESTAMP WHERE activation_id = ? AND state = 'file_placed'")
        .run(artifact.storage.uri, JSON.stringify(artifact), activationId);
      if (manageTransaction) db.exec("COMMIT");
    } catch (error) {
      if (manageTransaction) db.exec("ROLLBACK");
      throw error;
    }
    if (manageTransaction) {
      let cleanupComplete = true;
      if (resolve(artifact.storage.uri) !== finalPath && existsSync(finalPath)) {
        try {
          if (options.remove_post_commit_file) options.remove_post_commit_file(finalPath);
          else rmSync(finalPath, { force: true });
        } catch { cleanupComplete = false; }
        if (existsSync(finalPath)) cleanupComplete = false;
      }
      if (cleanupComplete) {
        try { removeActivationMarker(activationId); } catch { /* committed marker cleanup is recoverable */ }
      }
    }
    return { ok: true, artifact };
  } catch (error) {
    if (error instanceof MediaActivationInjectedCrash) throw error.causeValue;
    const code = mediaActivationErrorCode(error);
    if (journalCreated) {
      const ownedCandidates = finalPathOwned ? [finalPath, pendingPath, stagingPath] : [pendingPath, stagingPath];
      try { quarantineActivationFile(artifact, ownedCandidates, mediaRoot); } catch { /* preserve the journal failure even when quarantine cannot move the file */ }
      try { db.prepare("UPDATE media_activation_journal SET state = 'failed', error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE activation_id = ?").run(code, activationId); } catch { /* db:check will surface the non-terminal record */ }
    } else if (existsSync(stagingPath)) {
      rmSync(stagingPath, { force: true });
    }
    if (markerCreated && (!journalCreated || manageTransaction)) {
      try { removeActivationMarker(activationId); } catch { /* a leftover marker fails closed during recovery */ }
    }
    try { removeStagingOwnership(artifact.artifact_id); } catch { /* recovery will reconcile the owner record */ }
    return { ok: false, error: { code, message: "Media activation failed before the Artifact became active." } };
  }
}

export function activateLocalMediaArtifact(
  input: { artifact: MediaArtifact; source_path: string; media_root?: string; allow_status_transition?: boolean; after_staging_written?: (stagingPath: string) => void; after_journal_staged?: (stagingPath: string) => void; after_pending_placed?: (pendingPath: string) => void; after_file_placed?: (finalPath: string) => void; remove_post_commit_file?: (finalPath: string) => void },
  db = openM0Database()
): RegisterMediaArtifactResult {
  ensureM0Directories();
  const sourcePath = resolve(input.source_path);
  if (!existsSync(sourcePath) || lstatSync(sourcePath).isSymbolicLink() || !statSync(sourcePath).isFile()) {
    return { ok: false, error: { code: "MEDIA_ACTIVATION_FILE_UNREADABLE", message: "Activation source file is not a regular readable file." } };
  }
  const mediaRoot = resolve(input.media_root ?? paths.mediaRoot);
  try { ensureSafeActivationRoots(mediaRoot, true); }
  catch { return { ok: false, error: { code: "MEDIA_ACTIVATION_PATH_UNSAFE", message: "Media activation directories are not app-controlled." } }; }
  const stageError = copyToOwnedStaging(input.artifact, sourcePath, mediaRoot, input.after_staging_written);
  if (stageError) return { ok: false, error: stageError };
  return commitStagedMediaArtifact(db, input.artifact, input.allow_status_transition === true, { after_journal_staged: input.after_journal_staged, after_pending_placed: input.after_pending_placed, after_file_placed: input.after_file_placed, remove_post_commit_file: input.remove_post_commit_file, media_root: mediaRoot });
}

function activationMarkerPaths(): string[] {
  const roots = ensureSafeActivationRoots(paths.mediaRoot, false);
  if (!existsSync(roots.journal)) return [];
  if (lstatSync(roots.journal).isSymbolicLink() || !statSync(roots.journal).isDirectory()) throw new Error("MEDIA_ACTIVATION_JOURNAL_UNSAFE");
  return readdirSync(roots.journal, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^activation_[0-9a-f-]{36}\.json$/i.test(entry.name))
    .map((entry) => resolve(roots.journal, entry.name));
}

function stagingOwnerPaths(): string[] {
  const roots = ensureSafeActivationRoots(paths.mediaRoot, false);
  if (!existsSync(roots.journal)) return [];
  if (lstatSync(roots.journal).isSymbolicLink() || !statSync(roots.journal).isDirectory()) throw new Error("MEDIA_ACTIVATION_JOURNAL_UNSAFE");
  return readdirSync(roots.journal, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^staging-owner-[a-f0-9]{64}\.json$/i.test(entry.name))
    .map((entry) => resolve(roots.journal, entry.name));
}

function readStagingOwner(filePath: string): MediaStagingOwner {
  const journalRoots = activationRoots(paths.mediaRoot);
  const target = resolve(filePath);
  if (!isPathInside(target, journalRoots.journal) || lstatSync(target).isSymbolicLink() || !statSync(target).isFile()) throw new Error("MEDIA_STAGING_OWNER_INVALID");
  const owner = JSON.parse(readFileSync(target, "utf8")) as Partial<MediaStagingOwner>;
  if (owner.version !== 1
    || typeof owner.artifact_id !== "string" || owner.artifact_id.length === 0
    || typeof owner.media_root !== "string" || !isAbsolute(owner.media_root)
    || typeof owner.staging_path !== "string"
    || stagingOwnerPath(owner.artifact_id) !== target) throw new Error("MEDIA_STAGING_OWNER_INVALID");
  const mediaRoot = resolve(owner.media_root);
  const roots = activationRoots(mediaRoot);
  if (!isPathInside(resolve(owner.staging_path), roots.staging)
    || hasExistingSymlinkAncestor(resolve(owner.staging_path), roots.activation)) throw new Error("MEDIA_STAGING_OWNER_INVALID");
  return owner as MediaStagingOwner;
}

function reconcileStagingOwners(db: M0Database, result: MediaActivationRecoveryResult): void {
  for (const filePath of stagingOwnerPaths()) {
    let owner: MediaStagingOwner;
    try {
      owner = readStagingOwner(filePath);
    } catch {
      rmSync(filePath, { force: true });
      result.failed.push({ activation_id: basename(filePath, ".json"), code: "MEDIA_STAGING_OWNER_INVALID" });
      continue;
    }
    const transferred = db.prepare(`SELECT activation_id FROM media_activation_journal
      WHERE artifact_id = ? AND staging_path = ? AND state IN ('staged','file_placed')
      ORDER BY created_at DESC LIMIT 1`).get(owner.artifact_id, resolve(owner.staging_path)) as { activation_id: string } | undefined;
    if (!transferred) {
      const stagingPath = resolve(owner.staging_path);
      let stagingCleared = !existsSync(stagingPath);
      if (!stagingCleared) {
        try {
          if (!lstatSync(stagingPath).isSymbolicLink() && statSync(stagingPath).isFile()) {
            rmSync(stagingPath, { force: true });
            stagingCleared = !existsSync(stagingPath);
          }
        } catch { /* preserve the owner so the unsafe or unavailable path remains fail closed */ }
      }
      result.failed.push({ activation_id: basename(filePath, ".json"), code: "MEDIA_ACTIVATION_DB_RECORD_MISSING" });
      if (!stagingCleared) continue;
    }
    rmSync(filePath, { force: true });
  }
}

function readActivationMarker(filePath: string): MediaActivationMarker {
  const journalRoots = activationRoots(paths.mediaRoot);
  const target = resolve(filePath);
  if (!isPathInside(target, journalRoots.journal) || lstatSync(target).isSymbolicLink() || !statSync(target).isFile()) throw new Error("MEDIA_ACTIVATION_MARKER_INVALID");
  const marker = JSON.parse(readFileSync(target, "utf8")) as Partial<MediaActivationMarker>;
  if (marker.version !== 1
    || typeof marker.activation_id !== "string"
    || typeof marker.artifact_id !== "string"
    || typeof marker.media_root !== "string" || !isAbsolute(marker.media_root)
    || (marker.artifact_type !== "image" && marker.artifact_type !== "video")
    || !(["storyboard_image", "generated_clip", "final_video"] as const).includes(marker.role as ArtifactRole)
    || !/^[a-f0-9]{64}$/i.test(String(marker.expected_sha256 ?? ""))
    || !Number.isInteger(marker.expected_size_bytes) || Number(marker.expected_size_bytes) <= 0
    || typeof marker.detected_mime !== "string"
    || typeof marker.staging_path !== "string"
    || typeof marker.pending_path !== "string"
    || typeof marker.final_path !== "string"
    || typeof marker.artifact_json !== "string"
    || markerPath(marker.activation_id) !== target) throw new Error("MEDIA_ACTIVATION_MARKER_INVALID");
  const root = resolve(marker.media_root);
  const roots = ensureSafeActivationRoots(root, false);
  if (existsSync(root)) {
    const canonicalRoot = resolve(realpathSync(root));
    const rootMatches = process.platform === "win32" ? canonicalRoot.toLowerCase() === root.toLowerCase() : canonicalRoot === root;
    if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory() || !rootMatches) throw new Error("MEDIA_ACTIVATION_MARKER_INVALID");
  }
  const artifact = JSON.parse(marker.artifact_json) as MediaArtifact;
  if (artifact.artifact_id !== marker.artifact_id
    || artifact.artifact_type !== marker.artifact_type
    || artifact.role !== marker.role
    || artifact.storage.uri !== marker.final_path
    || artifact.storage.mime_type !== marker.detected_mime
    || artifact.metadata.sha256 !== marker.expected_sha256
    || artifact.source.sha256 !== marker.expected_sha256
    || !isPathInside(resolve(marker.staging_path), roots.staging)
    || !isPathInside(resolve(marker.pending_path), roots.pending)
    || !isPathInside(resolve(marker.final_path), root)
    || hasExistingSymlinkAncestor(resolve(marker.staging_path), roots.activation)
    || hasExistingSymlinkAncestor(resolve(marker.pending_path), roots.activation)
    || hasExistingSymlinkAncestor(resolve(marker.final_path), root)) throw new Error("MEDIA_ACTIVATION_MARKER_INVALID");
  return marker as MediaActivationMarker;
}

export function discardMediaActivationMarkers(artifactIds: readonly string[]): void {
  const wanted = new Set(artifactIds);
  let filePaths: string[] = [];
  try { filePaths = activationMarkerPaths(); } catch { return; }
  for (const filePath of filePaths) {
    try {
      const marker = readActivationMarker(filePath);
      if (wanted.has(marker.artifact_id)) rmSync(filePath, { force: true });
    } catch { /* invalid markers remain visible to recovery and db:check */ }
  }
}

export function cleanupRolledBackMediaActivationFiles(
  artifactIds: readonly string[],
  options: { remove_file?: (target: string) => void } = {}
): boolean {
  const wanted = new Set(artifactIds);
  let complete = true;
  let filePaths: string[] = [];
  try { filePaths = activationMarkerPaths(); } catch { return false; }
  for (const filePath of filePaths) {
    let marker: MediaActivationMarker;
    try { marker = readActivationMarker(filePath); }
    catch { complete = false; continue; }
    if (!wanted.has(marker.artifact_id)) continue;
    let markerClean = true;
    for (const candidate of [marker.final_path, marker.pending_path, marker.staging_path]) {
      const target = resolve(candidate);
      if (!existsSync(target)) continue;
      try {
        if (lstatSync(target).isSymbolicLink() || !statSync(target).isFile()) {
          markerClean = false;
          continue;
        }
        if (options.remove_file) options.remove_file(target);
        else rmSync(target, { force: true });
      } catch { markerClean = false; }
      if (existsSync(target)) markerClean = false;
    }
    if (markerClean) {
      try { rmSync(filePath, { force: true }); }
      catch { complete = false; }
    } else complete = false;
  }
  return complete;
}

export function cleanupCommittedMediaActivationMarkers(db: M0Database, artifactIds: readonly string[]): void {
  const wanted = new Set(artifactIds);
  let filePaths: string[] = [];
  try { filePaths = activationMarkerPaths(); } catch { return; }
  for (const filePath of filePaths) {
    try {
      const marker = readActivationMarker(filePath);
      if (!wanted.has(marker.artifact_id)) continue;
      const row = db.prepare(`SELECT j.state, j.final_path FROM media_activation_journal j
        JOIN media_artifacts a ON a.artifact_id = j.artifact_id
        WHERE j.activation_id = ?`).get(marker.activation_id) as { state: string; final_path: string } | undefined;
      if (row?.state === "committed") cleanupCommittedActivationMarker(marker, filePath, row.final_path);
    } catch { /* startup recovery handles markers that cannot be safely cleared */ }
  }
}

function cleanupCommittedActivationMarker(marker: MediaActivationMarker, filePath: string, authoritativeFinalPath: string): boolean {
  for (const candidate of [marker.final_path, marker.pending_path, marker.staging_path]) {
    const target = resolve(candidate);
    if (sameResolvedPath(target, authoritativeFinalPath) || !existsSync(target)) continue;
    try {
      if (lstatSync(target).isSymbolicLink() || !statSync(target).isFile()) return false;
      rmSync(target, { force: true });
    } catch { return false; }
    if (existsSync(target)) return false;
  }
  try { rmSync(filePath, { force: true }); }
  catch { return false; }
  return !existsSync(filePath);
}

function reconcileUnrecordedActivationMarkers(db: M0Database, result: MediaActivationRecoveryResult): void {
  for (const filePath of activationMarkerPaths()) {
    let marker: MediaActivationMarker;
    try {
      marker = readActivationMarker(filePath);
    } catch {
      result.failed.push({ activation_id: basename(filePath, ".json"), code: "MEDIA_ACTIVATION_MARKER_INVALID" });
      continue;
    }
    const existing = db.prepare("SELECT state, final_path FROM media_activation_journal WHERE activation_id = ?").get(marker.activation_id) as { state: string; final_path: string } | undefined;
    if (existing?.state === "committed") {
      if (!cleanupCommittedActivationMarker(marker, filePath, existing.final_path)) {
        result.failed.push({ activation_id: marker.activation_id, code: "MEDIA_ACTIVATION_POST_COMMIT_CLEANUP_FAILED" });
      }
      continue;
    }
    if (existing?.state === "failed") {
      rmSync(filePath, { force: true });
      continue;
    }
    if (existing) continue;
    const artifact = JSON.parse(marker.artifact_json) as MediaArtifact;
    try { quarantineActivationFile(artifact, [resolve(marker.final_path), resolve(marker.pending_path), resolve(marker.staging_path)], resolve(marker.media_root)); } catch { /* retain stable failed evidence even when no file can be moved */ }
    db.prepare(`INSERT INTO media_activation_journal
      (activation_id, artifact_id, state, artifact_type, role, expected_sha256, expected_size_bytes, detected_mime,
       staging_path, pending_path, final_path, artifact_json, error_code)
      VALUES (?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MEDIA_ACTIVATION_DB_RECORD_MISSING')`)
      .run(marker.activation_id, marker.artifact_id, marker.artifact_type, marker.role, marker.expected_sha256, marker.expected_size_bytes,
        marker.detected_mime, marker.staging_path, marker.pending_path, marker.final_path, marker.artifact_json);
    rmSync(filePath, { force: true });
    result.failed.push({ activation_id: marker.activation_id, code: "MEDIA_ACTIVATION_DB_RECORD_MISSING" });
  }
}

export interface MediaActivationRecoveryResult {
  committed: string[];
  failed: Array<{ activation_id: string; code: string }>;
}

export function recoverMediaActivations(db = openM0Database()): MediaActivationRecoveryResult {
  const result: MediaActivationRecoveryResult = { committed: [], failed: [] };
  const manageMarkerTransaction = !databaseIsInTransaction(db);
  if (manageMarkerTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    reconcileUnrecordedActivationMarkers(db, result);
    if (manageMarkerTransaction) db.exec("COMMIT");
  } catch (error) {
    if (manageMarkerTransaction && databaseIsInTransaction(db)) db.exec("ROLLBACK");
    throw error;
  }
  reconcileStagingOwners(db, result);
  const rows = db.prepare(`SELECT activation_id, state, expected_sha256, expected_size_bytes, detected_mime,
      staging_path, pending_path, final_path, artifact_json
    FROM media_activation_journal WHERE state IN ('staged','file_placed') ORDER BY created_at, activation_id`).all() as Array<{
      activation_id: string; state: "staged" | "file_placed"; expected_sha256: string; expected_size_bytes: number; detected_mime: string;
      staging_path: string; pending_path: string; final_path: string; artifact_json: string;
    }>;
  for (const row of rows) {
    let artifact: MediaArtifact | null = null;
    let failureStagingPath = resolve(row.staging_path);
    let failurePendingPath = resolve(row.pending_path);
    let failureFinalPath: string | null = null;
    try {
      artifact = JSON.parse(row.artifact_json) as MediaArtifact;
      const stagingPath = resolve(row.staging_path);
      const pendingPath = resolve(row.pending_path);
      const finalPath = resolve(row.final_path);
      const mediaRoot = dirname(dirname(dirname(stagingPath)));
      const roots = activationRoots(mediaRoot);
      if (!isPathInside(stagingPath, roots.staging)
        || !isPathInside(pendingPath, roots.pending)
        || !isPathInside(finalPath, mediaRoot)
        || hasExistingSymlinkAncestor(stagingPath, roots.activation)
        || hasExistingSymlinkAncestor(pendingPath, roots.activation)
        || hasExistingSymlinkAncestor(finalPath, mediaRoot)) throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
      if (samePhysicalFile(pendingPath, finalPath)) {
        rmSync(pendingPath);
        failureFinalPath = finalPath;
      }
      if (row.state === "staged") {
        const present = [stagingPath, pendingPath, finalPath].filter((candidate) => existsSync(candidate));
        if (present.length === 0) throw new Error("MEDIA_ACTIVATION_STAGED_FILE_MISSING");
        if (present.length !== 1) throw new Error("MEDIA_ACTIVATION_MULTIPLE_FILES_PRESENT");
        if (present[0] === stagingPath) renameSync(stagingPath, pendingPath);
        if (present[0] === finalPath) failureFinalPath = finalPath;
        db.prepare("UPDATE media_activation_journal SET state = 'file_placed', updated_at = CURRENT_TIMESTAMP WHERE activation_id = ? AND state = 'staged'").run(row.activation_id);
      } else {
        const present = [pendingPath, finalPath].filter((candidate) => existsSync(candidate));
        if (present.length === 0) throw new Error("MEDIA_ACTIVATION_PLACED_FILE_MISSING");
        if (present.length !== 1 || existsSync(stagingPath)) throw new Error("MEDIA_ACTIVATION_MULTIPLE_FILES_PRESENT");
        if (present[0] === finalPath) failureFinalPath = finalPath;
      }
      if (existsSync(pendingPath)) {
        moveActivationFileExclusively(pendingPath, finalPath);
        failureFinalPath = finalPath;
      }
      if (!existsSync(finalPath)) throw new Error("MEDIA_ACTIVATION_PLACED_FILE_MISSING");
      const facts = localMediaFacts(finalPath, artifact);
      if (facts.sha256 !== row.expected_sha256 || facts.size_bytes !== Number(row.expected_size_bytes) || facts.detected_mime !== row.detected_mime) {
        throw new Error("MEDIA_ACTIVATION_CONTENT_DRIFT");
      }
      applyLocalMediaFacts(artifact, facts);
      db.exec("BEGIN IMMEDIATE");
      try {
        persistMediaArtifactInternal(db, artifact, true, mediaRoot);
        db.prepare("UPDATE media_activation_journal SET state = 'committed', final_path = ?, artifact_json = ?, error_code = '', updated_at = CURRENT_TIMESTAMP WHERE activation_id = ? AND state = 'file_placed'")
          .run(artifact.storage.uri, JSON.stringify(artifact), row.activation_id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      try {
        const committedMarkerPath = markerPath(row.activation_id);
        if (existsSync(committedMarkerPath)) {
          const committedMarker = readActivationMarker(committedMarkerPath);
          if (!cleanupCommittedActivationMarker(committedMarker, committedMarkerPath, artifact.storage.uri)) {
            result.failed.push({ activation_id: row.activation_id, code: "MEDIA_ACTIVATION_POST_COMMIT_CLEANUP_FAILED" });
          }
        }
      } catch {
        result.failed.push({ activation_id: row.activation_id, code: "MEDIA_ACTIVATION_POST_COMMIT_CLEANUP_FAILED" });
      }
      result.committed.push(row.activation_id);
    } catch (error) {
      const code = mediaActivationErrorCode(error);
      if (artifact) {
        const mediaRoot = dirname(dirname(dirname(resolve(row.staging_path))));
        const ownedCandidates = failureFinalPath
          ? [failureFinalPath, failurePendingPath, failureStagingPath]
          : [failurePendingPath, failureStagingPath];
        try { quarantineActivationFile(artifact, ownedCandidates, mediaRoot); } catch { /* retain failure evidence in the journal */ }
      }
      try { db.prepare("UPDATE media_activation_journal SET state = 'failed', error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE activation_id = ?").run(code, row.activation_id); } catch { /* schema checks report the remaining record */ }
      try {
        removeActivationMarker(row.activation_id);
      } catch { /* db:check will keep reporting any unsafe marker */ }
      result.failed.push({ activation_id: row.activation_id, code });
    }
  }
  return result;
}

export function verifyMediaArtifactBytes(db: M0Database, artifact: MediaArtifact): { ok: true; blob: MediaBlob } | { ok: false; error: ToolError } {
  const blob = artifact.blob_id ? getMediaBlob(db, artifact.blob_id) : null;
  if (!blob || blob.integrity_state !== "verified" || artifact.status !== "active") {
    return { ok: false, error: { code: "ARTIFACT_INTEGRITY_UNVERIFIED", message: "Artifact does not reference an active verified MediaBlob." } };
  }
  const localPath = resolve(blob.storage_uri);
  const artifactPath = resolve(artifact.storage.uri);
  if (!sameResolvedPath(artifactPath, localPath)) {
    return { ok: false, error: { code: "MEDIA_BLOB_CONTENT_DRIFT", message: "Artifact storage URI differs from its authoritative MediaBlob." } };
  }
  const registeredRoot = typeof blob.provenance.media_root === "string" && isAbsolute(blob.provenance.media_root)
    ? resolve(blob.provenance.media_root)
    : paths.mediaRoot;
  try {
    const canonicalRoot = resolve(realpathSync(registeredRoot));
    const rootMatches = process.platform === "win32"
      ? canonicalRoot.toLowerCase() === resolve(registeredRoot).toLowerCase()
      : canonicalRoot === resolve(registeredRoot);
    if (!existsSync(registeredRoot)
      || lstatSync(registeredRoot).isSymbolicLink()
      || !statSync(registeredRoot).isDirectory()
      || !rootMatches
      || !isPathInside(localPath, registeredRoot)
      || hasExistingSymlinkAncestor(localPath, registeredRoot)
      || lstatSync(localPath).isSymbolicLink()) {
      return { ok: false, error: { code: "MEDIA_BLOB_PATH_UNSAFE", message: "MediaBlob path is outside app-controlled storage or uses a symbolic link." } };
    }
    const facts = localMediaFacts(localPath, artifact);
    if (facts.sha256 !== blob.sha256 || facts.size_bytes !== blob.size_bytes || facts.detected_mime !== blob.detected_mime
      || artifact.metadata.sha256 !== blob.sha256 || artifact.source.sha256 !== blob.sha256 || artifact.storage.mime_type !== blob.detected_mime) {
      return { ok: false, error: { code: "MEDIA_BLOB_CONTENT_DRIFT", message: "Stored media bytes differ from the registered MediaBlob facts." } };
    }
    return { ok: true, blob };
  } catch (error) {
    const raw = error instanceof Error ? error.message : "MEDIA_BLOB_CHECK_FAILED";
    const code = /^[A-Z][A-Z0-9_]+$/.test(raw) ? raw : "MEDIA_BLOB_CHECK_FAILED";
    return { ok: false, error: { code, message: "Stored media bytes could not be verified." } };
  }
}

function copyFixture(input: RegisterMediaArtifactInput): RegisterMediaArtifactResult {
  if (input.source.kind !== "fixture_path") {
    throw new Error("copyFixture received non-fixture source.");
  }

  if (isAbsolute(input.source.path) || input.source.path.includes("..")) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Fixture path must be relative and stay inside fixtures/." } };
  }

  const fixturesRoot = resolve(paths.workspaceRoot, "fixtures");
  const sourcePath = resolve(fixturesRoot, input.source.path);
  if (!isPathInside(sourcePath, fixturesRoot)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Fixture path resolved outside fixtures/." } };
  }

  if (!existsSync(sourcePath)) {
    return { ok: false, error: { code: "MEDIA_FILE_NOT_READABLE", message: `Fixture file is not readable: ${input.source.path}` } };
  }

  const sourceStat = statSync(sourcePath);
  if (!sourceStat.isFile()) {
    return { ok: false, error: { code: "MEDIA_FILE_NOT_READABLE", message: `Fixture path is not a file: ${input.source.path}` } };
  }

  ensureM0Directories();
  const artifactId = `artifact_${randomUUID()}`;
  const filename = `${artifactId}${extname(sourcePath).toLowerCase() || (input.artifact_type === "image" ? ".img" : ".bin")}`;
  const destinationRoot = mediaRootFor(input.artifact_type, input.role);
  const destinationPath = resolve(destinationRoot, filename);
  if (!isPathInside(destinationPath, destinationRoot)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Destination path resolved outside app-controlled media storage." } };
  }

  const prepared = { ...buildArtifact(input, "active", filename, destinationPath, mimeTypeFor(sourcePath, input.artifact_type)), artifact_id: artifactId };
  const stagingPath = stagedPathForArtifact(prepared);
  const stageError = copyToOwnedStaging(prepared, sourcePath);
  if (stageError) return { ok: false, error: stageError };
  readFileSync(stagingPath);

  if (input.artifact_type === "image") {
    const validation = validateImageFile(stagingPath);
    if (!validation.ok) {
      rmSync(stagingPath, { force: true });
      try { removeStagingOwnership(prepared.artifact_id); } catch { /* recovery will reconcile the owner record */ }
      return { ok: false, error: imageValidationError(validation) };
    }
    return { ok: true, artifact: buildValidatedImageArtifact(input, artifactId, filename, destinationPath, validation) };
  }
  return { ok: true, artifact: prepared };
}

function writeUploadedBytes(input: RegisterMediaArtifactInput, artifactId = `artifact_${randomUUID()}`): RegisterMediaArtifactResult {
  if (input.source.kind !== "file_handle" && input.source.kind !== "app_upload") {
    throw new Error("writeUploadedBytes received unsupported source.");
  }

  const roleError = validateRole(input.artifact_type, input.role);
  if (roleError) return { ok: false, error: roleError };

  const unsafeName = input.source.filename;
  if (filenameHasPathTraversal(unsafeName)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Upload filename must not contain path traversal." } };
  }

  const decoded = Buffer.from(input.source.bytes_base64, "base64");
  if (input.artifact_type === "image") {
    const validation = validateImageBuffer(decoded, unsafeName);
    if (!validation.ok) return { ok: false, error: imageValidationError(validation) };

    const filename = `${artifactId}${validation.extension}`;
    const destinationRoot = mediaRootFor(input.artifact_type, input.role);
    const destinationPath = resolve(destinationRoot, filename);
    if (!isPathInside(destinationPath, destinationRoot)) {
      return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Upload destination resolved outside app media storage." } };
    }

    ensureM0Directories();
    const prepared = buildValidatedImageArtifact(input, artifactId, filename, destinationPath, validation);
    const stagingPath = stagedPathForArtifact(prepared);
    const stageError = writeToOwnedStaging(prepared, decoded);
    if (stageError) return { ok: false, error: stageError };
    readFileSync(stagingPath);

    const storedValidation = validateImageFile(stagingPath);
    if (!storedValidation.ok) {
      rmSync(stagingPath, { force: true });
      try { removeStagingOwnership(prepared.artifact_id); } catch { /* recovery will reconcile the owner record */ }
      return { ok: false, error: imageValidationError(storedValidation) };
    }

    return { ok: true, artifact: buildValidatedImageArtifact(input, artifactId, filename, destinationPath, storedValidation) };
  }

  const filename = `${artifactId}${extname(unsafeName).toLowerCase()}`;
  const destinationRoot = mediaRootFor(input.artifact_type, input.role);
  const destinationPath = resolve(destinationRoot, filename);
  if (!isPathInside(destinationPath, destinationRoot)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Upload destination resolved outside app media storage." } };
  }

  ensureM0Directories();
  const artifact: MediaArtifact = {
    ...buildArtifact(input, "active", filename, destinationPath, input.source.mime_type),
    artifact_id: artifactId
  };
  const stagingPath = stagedPathForArtifact(artifact);
  const stageError = writeToOwnedStaging(artifact, decoded);
  if (stageError) return { ok: false, error: stageError };
  readFileSync(stagingPath);
  return { ok: true, artifact };
}

function copyProviderOutputFile(input: RegisterMediaArtifactInput): RegisterMediaArtifactResult {
  if (input.source.kind !== "provider_output_file") {
    throw new Error("copyProviderOutputFile received unsupported source.");
  }

  if (input.artifact_type !== "video" || (input.role !== "generated_clip" && input.role !== "final_video")) {
    return { ok: false, error: { code: "INVALID_ARTIFACT_ROLE", message: "provider_output_file supports generated_clip and final_video video artifacts only." } };
  }

  ensureM0Directories();
  const sourcePath = resolve(input.source.path);
  const mediaRoot = resolve(paths.mediaRoot);
  if (lstatSync(mediaRoot).isSymbolicLink()) {
    return { ok: false, error: { code: "SYMLINK_ESCAPE_BLOCKED", message: "App media root symbolic links are blocked for provider outputs." } };
  }
  const realMediaRoot = realpathSync(mediaRoot);
  if (!isPathInside(sourcePath, mediaRoot)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Provider output must already be inside app-controlled media storage." } };
  }

  if (!existsSync(sourcePath)) {
    return { ok: false, error: { code: "MEDIA_FILE_NOT_READABLE", message: "Provider output file is not readable." } };
  }

  if (lstatSync(sourcePath).isSymbolicLink()) {
    return { ok: false, error: { code: "SYMLINK_ESCAPE_BLOCKED", message: "Provider output file symbolic links are blocked." } };
  }
  const realSourcePath = realpathSync(sourcePath);
  if (!isPathInside(realSourcePath, realMediaRoot)) {
    return { ok: false, error: { code: "SYMLINK_ESCAPE_BLOCKED", message: "Provider output file resolves outside app media storage." } };
  }

  const sourceStat = statSync(sourcePath);
  if (!sourceStat.isFile()) {
    return { ok: false, error: { code: "MEDIA_FILE_NOT_READABLE", message: "Provider output path is not a file." } };
  }

  readFileSync(realSourcePath);
  const artifactId = `artifact_${randomUUID()}`;
  const filename = `${artifactId}${extname(realSourcePath).toLowerCase() || ".mp4"}`;
  const destinationRoot = resolve(input.storage_directory ?? mediaRootFor(input.artifact_type, input.role));
  if (!isPathInside(destinationRoot, mediaRoot)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Provider artifact destination must be inside app-controlled media storage." } };
  }
  if (hasExistingSymlinkAncestor(destinationRoot, mediaRoot)) {
    return { ok: false, error: { code: "SYMLINK_ESCAPE_BLOCKED", message: "Provider artifact destination must not pass through symbolic links." } };
  }
  if (!existsSync(destinationRoot)) mkdirSync(destinationRoot, { recursive: true });
  if (lstatSync(destinationRoot).isSymbolicLink()) {
    return { ok: false, error: { code: "SYMLINK_ESCAPE_BLOCKED", message: "Provider artifact destination symbolic links are blocked." } };
  }
  if (!isPathInside(realpathSync(destinationRoot), realMediaRoot)) {
    return { ok: false, error: { code: "SYMLINK_ESCAPE_BLOCKED", message: "Provider artifact destination resolves outside app media storage." } };
  }
  const destinationPath = resolve(destinationRoot, filename);
  if (!isPathInside(destinationPath, destinationRoot)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Provider artifact destination resolved outside app media storage." } };
  }

  const preparedBase: MediaArtifact = {
    ...buildArtifact(input, "active", filename, destinationPath, input.source.mime_type ?? mimeTypeFor(filename, input.artifact_type)),
    artifact_id: artifactId
  };
  const stagingPath = stagedPathForArtifact(preparedBase);
  const stageError = copyToOwnedStaging(preparedBase, realSourcePath);
  if (stageError) return { ok: false, error: stageError };
  const sha256 = sha256ForFile(stagingPath);

  const artifact: MediaArtifact = {
    ...buildArtifact(
      {
        ...input,
        metadata: {
          ...input.metadata,
          sha256
        },
        provenance: {
          ...input.provenance,
          sha256
        }
      },
      "active",
      filename,
      destinationPath,
      input.source.mime_type ?? mimeTypeFor(filename, input.artifact_type)
    ),
    artifact_id: artifactId
  };

  return { ok: true, artifact };
}

function localImportPathError(importFilename: string): ToolError | null {
  if (!importFilename || filenameHasPathTraversal(importFilename)) {
    return { code: "STORAGE_PATH_NOT_ALLOWED", message: "local_file_import filename must be a plain filename under data/imports." };
  }
  return null;
}

function copyLocalImageImport(input: RegisterMediaArtifactInput, artifactId = `artifact_${randomUUID()}`): RegisterMediaArtifactResult {
  if (input.source.kind !== "local_file_import") {
    throw new Error("copyLocalImageImport received unsupported source.");
  }

  if (input.artifact_type !== "image") {
    return { ok: false, error: { code: "INVALID_ARTIFACT_ROLE", message: "local_file_import currently supports image artifacts only." } };
  }

  const importError = localImportPathError(input.source.import_filename);
  if (importError) return { ok: false, error: importError };

  ensureM0Directories();
  const importsRoot = resolve(paths.importsRoot);
  const sourcePath = resolve(importsRoot, input.source.import_filename);
  if (!isPathInside(sourcePath, importsRoot)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Import path resolved outside data/imports." } };
  }

  if (!existsSync(sourcePath)) {
    return { ok: false, error: { code: "IMAGE_FILE_NOT_READABLE", message: `Import image is not readable: ${input.source.import_filename}` } };
  }

  const sourceLinkStat = lstatSync(sourcePath);
  if (sourceLinkStat.isSymbolicLink()) {
    return { ok: false, error: { code: "SYMLINK_ESCAPE_BLOCKED", message: "local_file_import refuses symbolic links." } };
  }

  const realSourcePath = realpathSync(sourcePath);
  if (!isPathInside(realSourcePath, importsRoot)) {
    return { ok: false, error: { code: "SYMLINK_ESCAPE_BLOCKED", message: "Import file resolves outside data/imports." } };
  }

  const sourceStat = statSync(realSourcePath);
  if (!sourceStat.isFile()) {
    return { ok: false, error: { code: "IMAGE_FILE_NOT_READABLE", message: "Import path is not a file." } };
  }

  const validation = validateImageFile(realSourcePath);
  if (!validation.ok) return { ok: false, error: imageValidationError(validation) };

  const filename = `${artifactId}${validation.extension}`;
  const destinationRoot = mediaRootFor(input.artifact_type, input.role);
  const destinationPath = resolve(destinationRoot, filename);
  if (!isPathInside(destinationPath, destinationRoot)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Local import destination resolved outside app media storage." } };
  }

  const prepared = buildValidatedImageArtifact(input, artifactId, filename, destinationPath, validation);
  const stagingPath = stagedPathForArtifact(prepared);
  const stageError = copyToOwnedStaging(prepared, realSourcePath);
  if (stageError) return { ok: false, error: stageError };
  readFileSync(stagingPath);

  const storedValidation = validateImageFile(stagingPath);
  if (!storedValidation.ok) {
    rmSync(stagingPath, { force: true });
    try { removeStagingOwnership(prepared.artifact_id); } catch { /* recovery will reconcile the owner record */ }
    return { ok: false, error: imageValidationError(storedValidation) };
  }

  return { ok: true, artifact: buildValidatedImageArtifact(input, artifactId, filename, destinationPath, storedValidation) };
}

function ipv4ToNumber(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const parsed = Number(part);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) return null;
    value = (value << 8) + parsed;
  }
  return value >>> 0;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host === "0.0.0.0" || host === "::1") return true;
  if (host === "169.254.169.254") return true;
  if (host.startsWith("fe80:") || host.startsWith("fd")) return true;

  const ipv4 = ipv4ToNumber(host);
  if (ipv4 === null) return false;
  const first = (ipv4 >>> 24) & 0xff;
  const second = (ipv4 >>> 16) & 0xff;
  if (first === 10 || first === 127 || first === 0) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  return false;
}

function validateAccessibleUri(uriInput: string): { uri?: URL; error?: ToolError } {
  let uri: URL;
  try {
    uri = new URL(uriInput);
  } catch {
    return { error: { code: "INVALID_ACCESSIBLE_URI", message: "accessible_uri must be a valid URL." } };
  }

  if (uri.protocol !== "http:" && uri.protocol !== "https:") {
    return { error: { code: "EXTERNAL_URI_SCHEME_NOT_ALLOWED", message: "accessible_uri supports only http and https schemes." } };
  }

  if (isPrivateHost(uri.hostname)) {
    return { error: { code: "EXTERNAL_URI_PRIVATE_NETWORK_BLOCKED", message: "accessible_uri private network destinations are blocked." } };
  }

  return { uri };
}

function registerAccessibleUriReference(input: RegisterMediaArtifactInput): RegisterMediaArtifactResult {
  if (input.source.kind !== "accessible_uri") {
    throw new Error("registerAccessibleUriReference received unsupported source.");
  }

  const uriValidation = validateAccessibleUri(input.source.uri);
  if (uriValidation.error) return { ok: false, error: uriValidation.error };
  const uri = uriValidation.uri;
  if (!uri) return { ok: false, error: { code: "INVALID_ACCESSIBLE_URI", message: "accessible_uri must be a valid URL." } };

  const filename = input.source.filename ?? (basename(uri.pathname) || `external_${randomUUID()}${input.artifact_type === "image" ? ".img" : ".bin"}`);
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\") || isAbsolute(filename)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "accessible_uri filename must be a plain filename without path traversal." } };
  }

  return {
    ok: true,
    artifact: buildArtifact(input, "inaccessible", filename, input.source.uri, input.source.mime_type ?? mimeTypeFor(filename, input.artifact_type))
  };
}

export function registerMediaArtifact(input: RegisterMediaArtifactInput, db = openM0Database()): RegisterMediaArtifactResult {
  const roleError = validateRole(input.artifact_type, input.role);
  if (roleError) return { ok: false, error: roleError };

  let result: RegisterMediaArtifactResult;

  if (input.source.kind === "pending_user_upload") {
    result = {
      ok: true,
      artifact: buildArtifact(
        input,
        "pending_upload",
        input.source.filename ?? "",
        "",
        input.source.mime_type ?? mimeTypeFor(input.source.filename ?? "", input.artifact_type)
      )
    };
  } else if (input.source.kind === "local_file_import") {
    result = copyLocalImageImport(input);
  } else if (input.source.kind === "fixture_path") {
    result = copyFixture(input);
  } else if (input.source.kind === "file_handle" || input.source.kind === "app_upload") {
    result = writeUploadedBytes(input);
  } else if (input.source.kind === "accessible_uri") {
    result = registerAccessibleUriReference(input);
  } else if (input.source.kind === "provider_output_file") {
    result = copyProviderOutputFile(input);
  } else {
    result = {
      ok: false,
      error: {
        code: "EXTERNAL_TRANSFER_NOT_TESTED",
        message: "External accessible_uri transfer is not tested in this local M0 runtime."
      }
    };
  }

  if (result.ok) {
    if (result.artifact.status === "active" && !/^https?:\/\//i.test(result.artifact.storage.uri)) {
      result = commitStagedMediaArtifact(db, result.artifact, false);
    } else {
      persistMediaArtifact(db, result.artifact);
    }
  }

  return result;
}

export function activatePendingMediaArtifact(input: ActivatePendingMediaArtifactInput, db = openM0Database()): ActivatePendingMediaArtifactResult {
  const existing = getMediaArtifact(db, input.artifact_id);
  if (!existing) {
    return { ok: false, error: { code: "PENDING_ARTIFACT_NOT_FOUND", message: `Pending artifact not found: ${input.artifact_id}` } };
  }

  if (existing.status === "active") {
    return { ok: false, error: { code: "ARTIFACT_ALREADY_ACTIVE", message: "Artifact is already active." } };
  }

  if (existing.status !== "pending_upload") {
    return { ok: false, error: { code: "ARTIFACT_NOT_PENDING_UPLOAD", message: `Artifact is not pending_upload: ${existing.status}` } };
  }

  if (existing.artifact_type !== "image" || existing.role !== "storyboard_image") {
    return { ok: false, error: { code: "INVALID_ARTIFACT_ROLE", message: "Only pending storyboard_image image artifacts can be activated in M1-0." } };
  }

  const activationInput: RegisterMediaArtifactInput = {
    artifact_type: existing.artifact_type,
    role: existing.role,
    source: input.source,
    linked_objects: existing.linked_objects,
    metadata: existing.metadata
  };

  let result: RegisterMediaArtifactResult;
  if (input.source.kind === "local_file_import") {
    result = copyLocalImageImport(activationInput, existing.artifact_id);
  } else if (input.source.kind === "app_upload") {
    result = writeUploadedBytes(activationInput, existing.artifact_id);
  } else {
    const uriValidation = validateAccessibleUri(input.source.uri);
    if (uriValidation.error) return { ok: false, error: uriValidation.error };
    return { ok: false, error: { code: "EXTERNAL_URI_DOWNLOAD_FAILED", message: "accessible_uri download is not implemented in M1-0." } };
  }

  if (!result.ok) return result;
  return commitStagedMediaArtifact(db, result.artifact, true);
}

export function getStoryboardImageTransferGate(): StoryboardImageTransferGate {
  return {
    fixture_path: "PASS",
    external_transfer_path: "NOT_TESTED"
  };
}

export function getMediaArtifact(db: M0Database, artifactId: string): MediaArtifact | null {
  const row = db.prepare(`
    SELECT a.artifact_id, a.project_id, a.shot_id, a.role, a.artifact_type, a.status, a.data_json, m.blob_id
    FROM media_artifacts a
    LEFT JOIN media_artifact_blobs m ON m.artifact_id = a.artifact_id
    WHERE a.artifact_id = ?
  `).get(artifactId) as {
    artifact_id: string;
    project_id: string | null;
    shot_id: string | null;
    role: string;
    artifact_type: string;
    status: string;
    data_json: string;
    blob_id: string | null;
  } | undefined;
  if (!row) return null;
  const artifact = JSON.parse(row.data_json) as MediaArtifact;
  if (
    artifact.artifact_id !== row.artifact_id
    || artifact.linked_objects?.project_id !== (row.project_id ?? "")
    || artifact.linked_objects?.shot_id !== (row.shot_id ?? "")
    || artifact.role !== row.role
    || artifact.artifact_type !== row.artifact_type
    || artifact.status !== row.status
    || (row.blob_id !== null && artifact.blob_id !== row.blob_id)
  ) {
    throw new ArtifactStructuredDriftError(artifactId);
  }
  return artifact;
}

export function getMediaBlob(db: M0Database, blobId: string): MediaBlob | null {
  const row = db.prepare(`
    SELECT blob_id, sha256, size_bytes, detected_mime, storage_uri, integrity_state, provenance_json
    FROM media_blobs WHERE blob_id = ?
  `).get(blobId) as {
    blob_id: string;
    sha256: string;
    size_bytes: number;
    detected_mime: string;
    storage_uri: string;
    integrity_state: MediaBlobIntegrityState;
    provenance_json: string;
  } | undefined;
  return row ? {
    blob_id: row.blob_id,
    sha256: row.sha256,
    size_bytes: Number(row.size_bytes),
    detected_mime: row.detected_mime,
    storage_uri: row.storage_uri,
    integrity_state: row.integrity_state,
    provenance: JSON.parse(row.provenance_json) as Record<string, unknown>
  } : null;
}

export type ArtifactShotReference = "storyboard_image_artifact_id" | "accepted_clip_artifact_id";

export type ScopedArtifactResult =
  | { ok: true; artifact: MediaArtifact }
  | { ok: false; error: ToolError };

export function createScopedArtifactFromBlob(
  input: {
    source_artifact_id: string;
    project_id: string;
    shot_id?: string;
    role?: ArtifactRole;
  },
  db = openM0Database()
): ScopedArtifactResult {
  const source = getMediaArtifact(db, input.source_artifact_id);
  if (!source) return { ok: false, error: { code: "ARTIFACT_NOT_FOUND", message: `Artifact not found: ${input.source_artifact_id}` } };
  const sourceBlob = source.blob_id ? getMediaBlob(db, source.blob_id) : null;
  if (!sourceBlob) {
    return { ok: false, error: { code: "MEDIA_BLOB_NOT_FOUND", message: "Source Artifact has no registered MediaBlob." } };
  }
  if (source.status !== "active" || sourceBlob.integrity_state !== "verified") {
    return { ok: false, error: { code: "ARTIFACT_INTEGRITY_UNVERIFIED", message: "Only an active Artifact with a verified MediaBlob can create a scoped Artifact." } };
  }
  const project = getProject(db, input.project_id);
  if (!project) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${input.project_id}` } };
  const role = input.role ?? source.role;
  const roleError = validateRole(source.artifact_type, role);
  if (roleError) return { ok: false, error: roleError };
  const shotId = input.shot_id ?? "";
  if (role === "final_video") {
    if (shotId) return { ok: false, error: { code: "INVALID_ARTIFACT_SCOPE", message: "final_video Artifacts are project-scoped." } };
  } else if (shotId) {
    const shot = getShot(db, shotId);
    if (!shot || shot.project_id !== input.project_id) {
      return { ok: false, error: { code: "INVALID_ARTIFACT_SCOPE", message: `${role} Artifacts require a SHOT in the target project.` } };
    }
  }
  const artifact: MediaArtifact = {
    ...structuredClone(source),
    artifact_id: `artifact_${randomUUID()}`,
    blob_id: source.blob_id,
    role,
    linked_objects: { project_id: input.project_id, shot_id: shotId },
    source: { ...source.source, kind: "scoped_blob_reference" }
  };
  try {
    persistMediaArtifact(db, artifact);
  } catch (error) {
    return { ok: false, error: { code: "ARTIFACT_SCOPE_CREATION_FAILED", message: error instanceof Error ? error.message : "Scoped Artifact creation failed." } };
  }
  return { ok: true, artifact };
}

export type AttachArtifactResult =
  | { ok: true; shot: Shot; artifact: MediaArtifact }
  | { ok: false; error: ToolError };

export function attachArtifactToShot(
  input: {
    project_id: string;
    shot_id: string;
    artifact_id: string;
    reference: ArtifactShotReference;
    expected_current_artifact_id?: string;
  },
  db = openM0Database()
): AttachArtifactResult {
  const manageTransaction = !databaseIsInTransaction(db);
  if (manageTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    if (!getProject(db, input.project_id)) {
      if (manageTransaction) db.exec("ROLLBACK");
      return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: "Target project was not found." } };
    }
    const shot = getShot(db, input.shot_id);
    if (!shot || shot.project_id !== input.project_id) {
      if (manageTransaction) db.exec("ROLLBACK");
      return { ok: false, error: { code: "SHOT_NOT_FOUND", message: "SHOT does not belong to the selected project." } };
    }
    const artifact = getMediaArtifact(db, input.artifact_id);
    const expectedRole: ArtifactRole = input.reference === "storyboard_image_artifact_id" ? "storyboard_image" : "generated_clip";
    const expectedType: ArtifactType = input.reference === "storyboard_image_artifact_id" ? "image" : "video";
    const blob = artifact?.blob_id ? getMediaBlob(db, artifact.blob_id) : null;
    if (
      !artifact
      || artifact.linked_objects.project_id !== input.project_id
      || artifact.linked_objects.shot_id !== input.shot_id
      || artifact.role !== expectedRole
      || artifact.artifact_type !== expectedType
      || artifact.status !== "active"
      || blob?.integrity_state !== "verified"
    ) {
      if (manageTransaction) db.exec("ROLLBACK");
      return { ok: false, error: { code: "INVALID_ARTIFACT_BINDING", message: "Artifact must be active, verified, and scoped to the target project and SHOT." } };
    }
    const current = shot[input.reference];
    if (input.expected_current_artifact_id !== undefined && current !== input.expected_current_artifact_id) {
      if (manageTransaction) db.exec("ROLLBACK");
      return { ok: false, error: { code: "CONFLICT_STALE_ARTIFACT_REFERENCE", message: "SHOT Artifact reference changed before attach." } };
    }
    const nextShot = { ...shot, [input.reference]: artifact.artifact_id } as Shot;
    const result = db.prepare(`
      UPDATE shots SET data_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE shot_id = ? AND project_id = ? AND json_extract(data_json, ?) IS ?
    `).run(JSON.stringify(nextShot), input.shot_id, input.project_id, `$.${input.reference}`, current) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new Error("CONFLICT_STALE_ARTIFACT_REFERENCE");
    if (manageTransaction) db.exec("COMMIT");
    return { ok: true, shot: nextShot, artifact };
  } catch (error) {
    if (manageTransaction && databaseIsInTransaction(db)) db.exec("ROLLBACK");
    return { ok: false, error: { code: error instanceof Error ? error.message : "ARTIFACT_ATTACH_FAILED", message: "Artifact attach transaction failed." } };
  }
}

export function fixturePath(filename: string): string {
  return join("storyboard", basename(filename));
}
