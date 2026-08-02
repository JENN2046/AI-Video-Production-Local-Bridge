import { closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";

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

export interface VerifiedBlobStorageRecoveryInput {
  invalid_artifact_id: string;
  project_id: string;
  shot_id: string;
  source_path: string;
}

export interface VerifiedBlobStorageRecoveryFaults {
  target_mutex_busy_timeout_ms?: number;
  after_target_mutex_acquired?: () => void;
  after_target_mutex_guard_open?: () => void;
  after_target_mutex_temp_link_observed?: () => void;
  after_target_authority_temp_created?: () => void;
  after_stage_ownership_planned?: () => void;
  after_stage_publication_created?: () => void;
  after_stage_ownership_persisted?: () => void;
  after_stage_owner_created?: () => void;
  after_stage_published_with_owner_proof?: () => void;
  after_staged_copy?: () => void;
  before_staging_pair_isolated?: () => void;
  after_staging_entry_isolated?: () => void;
  after_staging_cleanup_entry_removed?: () => void;
  after_interrupted_placement_link_removed?: () => void;
  after_corrupt_quarantined?: () => void;
  after_replacement_placed?: () => void;
  before_final_verification?: () => void;
}

export type VerifiedBlobStorageRecoveryResult =
  | {
    ok: true;
    blob: MediaBlob;
    outcome: "MISSING_BYTES" | "CONTENT_DRIFT" | "ALREADY_REUSABLE";
    corrupt_bytes_quarantined: boolean;
  }
  | { ok: false; error: ToolError };

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

function verifiedBlobStorageIsReusable(blob: MediaBlob): boolean {
  if (blob.integrity_state !== "verified") return false;
  const rootValue = blob.provenance.media_root;
  if (typeof rootValue !== "string" || !isAbsolute(rootValue)) return false;
  const registeredRoot = resolve(rootValue);
  const localPath = resolve(blob.storage_uri);
  try {
    const canonicalRoot = resolve(realpathSync(registeredRoot));
    if (!sameResolvedPath(canonicalRoot, registeredRoot)
      || lstatSync(registeredRoot).isSymbolicLink()
      || !statSync(registeredRoot).isDirectory()
      || !isPathInside(localPath, registeredRoot)
      || hasExistingSymlinkAncestor(localPath, registeredRoot)
      || lstatSync(localPath).isSymbolicLink()
      || !statSync(localPath).isFile()) return false;
    const facts = hashLocalFile(localPath);
    return facts.sha256 === blob.sha256
      && facts.size_bytes === blob.size_bytes
      && detectMimeFromBytes(facts.header) === blob.detected_mime;
  } catch {
    return false;
  }
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
      const reusable: MediaBlob = {
        blob_id: existing.blob_id,
        sha256: existing.sha256,
        size_bytes: Number(existing.size_bytes),
        detected_mime: existing.detected_mime,
        storage_uri: existing.storage_uri,
        integrity_state: existing.integrity_state,
        provenance: JSON.parse(existing.provenance_json) as Record<string, unknown>
      };
      if (!verifiedBlobStorageIsReusable(reusable)) throw new Error("MEDIA_BLOB_EXISTING_BYTES_INVALID");
      return reusable;
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
  if (!sameResolvedPath(canonicalRoot, root)) throw new Error("MEDIA_ACTIVATION_PATH_UNSAFE");
  const roots = activationRoots(root);
  for (const directory of [roots.activation, roots.staging, roots.pending, roots.quarantine, roots.journal]) {
    if (create) {
      try { mkdirSync(directory); }
      catch (error) {
        // Another process may have created the same app-controlled directory
        // after this recovery validated its parent. The entry is accepted only
        // after the ordinary no-symlink, directory and canonical-root checks.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
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
  final_path_owned: boolean;
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
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary) && !lstatSync(temporary).isSymbolicLink()) rmSync(temporary, { force: true });
  }
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

const VERIFIED_BLOB_RECOVERY_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  MEDIA_BLOB_RECOVERY_BINDING_MISMATCH: "The requested Artifact and immutable MediaBlob binding could not be verified.",
  MEDIA_BLOB_RECOVERY_BUSY: "Another local recovery may be processing the same MediaBlob storage target.",
  MEDIA_BLOB_RECOVERY_CONTENT_MISMATCH: "Downloaded media bytes do not match the immutable MediaBlob facts.",
  MEDIA_BLOB_RECOVERY_PATH_UNSAFE: "MediaBlob recovery paths are not app-controlled regular-file paths.",
  MEDIA_BLOB_RECOVERY_FAILED: "MediaBlob bytes could not be recovered safely."
};

const DETERMINISTIC_BLOB_RECOVERY_STAGING_NAME = /^blob-recovery-[a-f0-9]{64}\.staged$/i;
const DETERMINISTIC_BLOB_RECOVERY_STAGE_OWNER_NAME = /^\.blob-recovery-stage-[a-f0-9]{64}\.owner$/i;
const BLOB_RECOVERY_STAGE_PUBLICATION_NAME = /^\.blob-recovery-stage-[a-f0-9]{64}\.publish-[0-9a-f-]{36}\.tmp$/i;
const LEGACY_BLOB_RECOVERY_STAGING_NAME = /^blob-recovery-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.staged$/i;
const BLOB_RECOVERY_TARGET_MUTEX_NAME = /^blob-recovery-target-[a-f0-9]{64}\.lock\.sqlite$/i;
const BLOB_RECOVERY_STAGE_OWNERSHIP_STORE_NAME = /^blob-recovery-stage-ownership-[a-f0-9]{64}\.sqlite$/i;
const BLOB_RECOVERY_TARGET_MUTEX_TEMP_NAME = /^\.brm-[0-9a-f-]{36}\.tmp\.sqlite$/i;
const BLOB_RECOVERY_TARGET_AUTHORITY_NAME = /^\.blob-recovery-target-[a-f0-9]{64}\.authority\.json$/i;
const BLOB_RECOVERY_TARGET_AUTHORITY_TEMP_NAME = /^\.blob-recovery-target-[a-f0-9]{64}\.authority-[0-9a-f-]{36}\.tmp$/i;
const BLOB_RECOVERY_TARGET_MUTEX_BUSY_TIMEOUT_MS = 30_000;
const BLOB_RECOVERY_TARGET_MUTEX_APPLICATION_ID = 0x41564252;
const BLOB_RECOVERY_STAGE_OWNERSHIP_APPLICATION_ID = 0x4156424f;
const BLOB_RECOVERY_TARGET_MUTEX_MAX_BYTES = 64 * 1024;
const BLOB_RECOVERY_STAGE_OWNERSHIP_JOURNAL_MAX_BYTES = 128 * 1024;
const requireNodeBuiltin = createRequire(import.meta.url);

function verifiedBlobRecoveryPathIdentity(value: string): string {
  const resolvedPath = resolve(value);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function hasSymlinkAncestorBeforeCanonicalRoot(child: string, canonicalRoot: string): boolean {
  let current = resolve(child);
  const expectedRoot = resolve(canonicalRoot);
  while (true) {
    if (!existsSync(current)) return true;
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) return true;
    if (sameResolvedPath(resolve(realpathSync(current)), expectedRoot)) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function isWindowsDosShortFilename(filename: string): boolean {
  const extensionIndex = filename.lastIndexOf(".");
  const base = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
  const extension = extensionIndex > 0 ? filename.slice(extensionIndex + 1) : "";
  // Win32 long names admit punctuation such as + , ; = [ ], but DOS 8.3
  // names do not. Keep this aligned with the SFN character set so an
  // ordinary long filename containing a tilde is not treated as an alias.
  const shortStemCharacter = "[A-Z0-9$%'\\-_@!(){}^#&`\\u0080-\\uFFFF]";
  const shortExtensionCharacter = "[A-Z0-9$%'\\-_@~!(){}^#&`\\u0080-\\uFFFF]";
  return base.length <= 8
    && extension.length <= 3
    && new RegExp(`^${shortStemCharacter}{1,6}~[0-9]{1,6}$`, "i").test(base)
    && (extension === "" || new RegExp(`^${shortExtensionCharacter}{1,3}$`, "i").test(extension));
}

function verifiedBlobRecoveryError(error: unknown): ToolError {
  const candidate = error instanceof Error ? error.message : "";
  const code = Object.hasOwn(VERIFIED_BLOB_RECOVERY_ERROR_MESSAGES, candidate)
    ? candidate
    : "MEDIA_BLOB_RECOVERY_FAILED";
  return { code, message: VERIFIED_BLOB_RECOVERY_ERROR_MESSAGES[code] };
}

function assertRecoveryRegularFile(filePath: string, registeredRoot: string, canonicalRoot: string): void {
  const resolvedPath = resolve(filePath);
  if (!isPathInside(resolvedPath, registeredRoot)
    || hasExistingSymlinkAncestor(resolvedPath, registeredRoot)
    || !existsSync(resolvedPath)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const entry = lstatSync(resolvedPath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const canonicalPath = resolve(realpathSync(resolvedPath));
  if (!isPathInside(canonicalPath, canonicalRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
}

function verifiedBlobRecoveryStagingPathForTarget(
  targetPath: string,
  _roots: ReturnType<typeof activationRoots>,
  registeredRoot: string
): string {
  if (!isAbsolute(targetPath)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const resolvedTargetPath = resolve(targetPath);
  if (!isPathInside(resolvedTargetPath, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const digest = createHash("sha256")
    .update(verifiedBlobRecoveryPathIdentity(resolvedTargetPath))
    .digest("hex");
  const targetDirectory = dirname(resolvedTargetPath);
  const stagedPath = resolve(targetDirectory, `blob-recovery-${digest}.staged`);
  if (!sameResolvedPath(dirname(stagedPath), targetDirectory)
    || !isPathInside(stagedPath, registeredRoot)
    || sameResolvedPath(stagedPath, resolvedTargetPath)
    || hasExistingSymlinkAncestor(stagedPath, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return stagedPath;
}

function verifiedBlobRecoveryStageOwnerPath(stagedPath: string, registeredRoot: string): string {
  const stagedName = basename(stagedPath);
  const digest = stagedName.slice("blob-recovery-".length, -".staged".length);
  const ownerPath = resolve(dirname(stagedPath), `.blob-recovery-stage-${digest}.owner`);
  if (!DETERMINISTIC_BLOB_RECOVERY_STAGING_NAME.test(stagedName)
    || !DETERMINISTIC_BLOB_RECOVERY_STAGE_OWNER_NAME.test(basename(ownerPath))
    || !sameResolvedPath(dirname(ownerPath), dirname(stagedPath))
    || !isPathInside(ownerPath, registeredRoot)
    || sameResolvedPath(ownerPath, stagedPath)
    || hasExistingSymlinkAncestor(ownerPath, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return ownerPath;
}

function verifiedBlobRecoveryStagePublicationPath(
  stagedPath: string,
  registeredRoot: string
): string {
  const stagedName = basename(stagedPath);
  const digest = stagedName.slice("blob-recovery-".length, -".staged".length);
  const publicationPath = resolve(
    dirname(stagedPath),
    `.blob-recovery-stage-${digest}.publish-${randomUUID()}.tmp`
  );
  if (!DETERMINISTIC_BLOB_RECOVERY_STAGING_NAME.test(stagedName)
    || !BLOB_RECOVERY_STAGE_PUBLICATION_NAME.test(basename(publicationPath))
    || !sameResolvedPath(dirname(publicationPath), dirname(stagedPath))
    || !isPathInside(publicationPath, registeredRoot)
    || sameResolvedPath(publicationPath, stagedPath)
    || hasExistingSymlinkAncestor(publicationPath, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return publicationPath;
}

function findRecordedRecoveryStagePublication(
  stagedPath: string,
  ownerPath: string,
  registeredRoot: string,
  canonicalRoot: string,
  ownership: VerifiedBlobRecoveryStageOwnership | null
): { path: string; entry: NonNullable<ReturnType<typeof lstatSync>> } | null {
  if (!ownership) return null;
  const publicationPath = resolve(dirname(stagedPath), ownership.publication_name);
  if (!BLOB_RECOVERY_STAGE_PUBLICATION_NAME.test(ownership.publication_name)
    || !sameResolvedPath(dirname(publicationPath), dirname(stagedPath))
    || !isPathInside(publicationPath, registeredRoot)
    || hasExistingSymlinkAncestor(publicationPath, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  if (!existsSync(publicationPath)) return null;
  const publication = lstatSync(publicationPath);
  const stageExists = existsSync(stagedPath);
  const ownerExists = existsSync(ownerPath);
  if (ownership.state === "planned") {
    if (stageExists || ownerExists || publication.isSymbolicLink()
      || !publication.isFile() || publication.nlink !== 1 || publication.size !== 0) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
  } else {
    assertVerifiedBlobRecoveryStageOwnership(ownership, publicationPath, ownerPath, undefined);
  }
  const expectedLinkCount = 1 + Number(stageExists) + Number(ownerExists);
  const canonicalDirectory = resolve(realpathSync(dirname(stagedPath)));
  const canonicalPublication = resolve(realpathSync(publicationPath));
  if (publication.isSymbolicLink() || !publication.isFile()
    || publication.nlink !== expectedLinkCount
    || !isPathInside(canonicalPublication, canonicalRoot)
    || !sameResolvedPath(dirname(canonicalPublication), canonicalDirectory)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  if (stageExists) {
    const stage = lstatSync(stagedPath);
    if (stage.isSymbolicLink() || !stage.isFile()
      || stage.nlink !== expectedLinkCount
      || String(stage.dev) !== ownership.device_id
      || String(stage.ino) !== ownership.inode_id) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
  }
  return { path: publicationPath, entry: publication };
}

function assertOwnedRecoveryStagingFile(
  stagedPath: string,
  ownerPath: string,
  registeredRoot: string,
  canonicalRoot: string,
  expectedLinkCount = 2
): ReturnType<typeof lstatSync> {
  if (!existsSync(stagedPath) || !existsSync(ownerPath)
    || !sameResolvedPath(dirname(stagedPath), dirname(ownerPath))
    || !isPathInside(stagedPath, registeredRoot)
    || !isPathInside(ownerPath, registeredRoot)
    || hasExistingSymlinkAncestor(stagedPath, registeredRoot)
    || hasExistingSymlinkAncestor(ownerPath, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const staged = lstatSync(stagedPath);
  const owner = lstatSync(ownerPath);
  if (staged.isSymbolicLink() || owner.isSymbolicLink()
    || !staged.isFile() || !owner.isFile()
    || staged.ino === 0 || staged.nlink !== expectedLinkCount
    || owner.nlink !== expectedLinkCount
    || staged.dev !== owner.dev || staged.ino !== owner.ino) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const canonicalStage = resolve(realpathSync(stagedPath));
  const canonicalOwner = resolve(realpathSync(ownerPath));
  const canonicalDirectory = resolve(realpathSync(dirname(stagedPath)));
  if (!isPathInside(canonicalStage, canonicalRoot)
    || !isPathInside(canonicalOwner, canonicalRoot)
    || !sameResolvedPath(dirname(canonicalStage), canonicalDirectory)
    || !sameResolvedPath(dirname(canonicalOwner), canonicalDirectory)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return staged;
}

function copyRecoverySourceToDescriptor(sourcePath: string, targetDescriptor: number): void {
  const sourceDescriptor = openSync(sourcePath, "r");
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const read = readSync(sourceDescriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      let written = 0;
      while (written < read) {
        written += writeSync(targetDescriptor, chunk, written, read - written, null);
      }
    }
    fsyncSync(targetDescriptor);
  } finally {
    closeSync(sourceDescriptor);
  }
}

function assertExpectedRecoveryStagingFile(
  stagedPath: string,
  expectedStagedPath: string,
  _roots: ReturnType<typeof activationRoots>,
  registeredRoot: string,
  canonicalRoot: string,
  expectedLinkCount = 1
): void {
  const resolvedPath = resolve(stagedPath);
  const expectedDirectory = dirname(resolve(expectedStagedPath));
  if (!sameResolvedPath(resolvedPath, expectedStagedPath)
    || !DETERMINISTIC_BLOB_RECOVERY_STAGING_NAME.test(basename(resolvedPath))
    || !sameResolvedPath(dirname(resolvedPath), expectedDirectory)
    || !isPathInside(resolvedPath, registeredRoot)
    || hasExistingSymlinkAncestor(resolvedPath, registeredRoot)
    || !existsSync(resolvedPath)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const entry = lstatSync(resolvedPath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== expectedLinkCount) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const canonicalPath = resolve(realpathSync(resolvedPath));
  const canonicalStaging = resolve(realpathSync(expectedDirectory));
  if (!isPathInside(canonicalPath, canonicalRoot)
    || !sameResolvedPath(dirname(canonicalPath), canonicalStaging)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
}

function reconcileLegacyVerifiedBlobRecoveryStaging(
  targetDirectory: string,
  targetPath: string,
  registeredRoot: string,
  canonicalRoot: string,
  artifact: MediaArtifact,
  blob: MediaBlob,
  interruptedPlacementCandidate = "",
  excludedSourcePath = ""
): void {
  const validatedCandidates: string[] = [];
  for (const entry of readdirSync(targetDirectory, { withFileTypes: true })) {
    if (!LEGACY_BLOB_RECOVERY_STAGING_NAME.test(entry.name)) continue;
    const candidatePath = resolve(targetDirectory, entry.name);
    if (interruptedPlacementCandidate
      && sameResolvedPath(candidatePath, interruptedPlacementCandidate)) {
      continue;
    }
    if (excludedSourcePath && sameResolvedPath(candidatePath, excludedSourcePath)) continue;
    if (!sameResolvedPath(dirname(candidatePath), targetDirectory)
      || !isPathInside(candidatePath, registeredRoot)
      || sameResolvedPath(candidatePath, targetPath)
      || hasExistingSymlinkAncestor(candidatePath, registeredRoot)
      || !existsSync(candidatePath)) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    const candidateEntry = lstatSync(candidatePath);
    if (candidateEntry.isSymbolicLink() || !candidateEntry.isFile() || candidateEntry.nlink !== 1) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    const canonicalCandidate = resolve(realpathSync(candidatePath));
    if (!isPathInside(canonicalCandidate, canonicalRoot)
      || !sameResolvedPath(dirname(canonicalCandidate), resolve(realpathSync(targetDirectory)))) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    let candidateFacts: LocalMediaFacts;
    try {
      candidateFacts = localMediaFacts(candidatePath, artifact);
    } catch {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    if (candidateFacts.sha256 !== blob.sha256
      || candidateFacts.size_bytes !== blob.size_bytes
      || candidateFacts.detected_mime !== blob.detected_mime) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    validatedCandidates.push(candidatePath);
  }
  // Legacy random names have no persistent ownership companion. Even matching
  // bytes can be a caller-owned copy, so explicit recovery must preserve them.
  if (validatedCandidates.length > 0) throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
}

function prepareVerifiedBlobRecoveryStaging(
  sourcePath: string,
  stagedPath: string,
  ownerPath: string,
  artifact: MediaArtifact,
  blob: MediaBlob,
  roots: ReturnType<typeof activationRoots>,
  registeredRoot: string,
  canonicalRoot: string,
  cleanupDirectory: string,
  targetMutex: VerifiedBlobRecoveryTargetMutex,
  faults: VerifiedBlobStorageRecoveryFaults
): void {
  let ownership = readVerifiedBlobRecoveryStageOwnership(targetMutex, stagedPath, blob);
  let publication = findRecordedRecoveryStagePublication(
    stagedPath,
    ownerPath,
    registeredRoot,
    canonicalRoot,
    ownership
  );
  if ((existsSync(stagedPath) || existsSync(ownerPath) || publication) && !ownership) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  if (publication && existsSync(stagedPath)) {
    rmSync(publication.path);
    publication = null;
    assertOwnedRecoveryStagingFile(
      stagedPath,
      ownerPath,
      registeredRoot,
      canonicalRoot
    );
  }
  if (existsSync(stagedPath)) {
    assertVerifiedBlobRecoveryStageOwnership(ownership, stagedPath, ownerPath, blob);
    assertExpectedRecoveryStagingFile(stagedPath, stagedPath, roots, registeredRoot, canonicalRoot, 2);
    assertOwnedRecoveryStagingFile(stagedPath, ownerPath, registeredRoot, canonicalRoot);
    let stagedFacts: LocalMediaFacts | null = null;
    try { stagedFacts = localMediaFacts(stagedPath, artifact); }
    catch { /* a safe app-owned partial stage can be discarded and recopied */ }
    if (stagedFacts
      && stagedFacts.sha256 === blob.sha256
      && stagedFacts.size_bytes === blob.size_bytes
      && stagedFacts.detected_mime === blob.detected_mime) {
      return;
    }
    removeOwnedRecoveryStagingPair(
      stagedPath,
      ownerPath,
      artifact.storage.uri,
      registeredRoot,
      canonicalRoot,
      cleanupDirectory,
      2,
      faults.before_staging_pair_isolated,
      faults.after_staging_entry_isolated,
      faults.after_staging_cleanup_entry_removed
    );
    ownership = null;
  } else if (existsSync(ownerPath) && !publication) {
    // A lone deterministic owner has no surviving stage-instance binding. Its
    // name, empty bytes and a target authority file cannot prove this inode was
    // created by recovery, so preserve it and fail closed.
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  if (!existsSync(stagedPath) && !existsSync(ownerPath) && !publication
    && (!ownership || ownership.state === "published")) {
    const plannedPublicationPath = verifiedBlobRecoveryStagePublicationPath(stagedPath, registeredRoot);
    ownership = planVerifiedBlobRecoveryStageOwnership(
      targetMutex,
      stagedPath,
      plannedPublicationPath,
      blob
    );
    faults.after_stage_ownership_planned?.();
  }
  if (!ownership) throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  let descriptor = -1;
  let stagedIdentity: ReturnType<typeof fstatSync> | null = null;
  const publicationPath = publication?.path
    ?? resolve(dirname(stagedPath), ownership.publication_name);
  try {
    if (publication) {
      descriptor = openSync(publication.path, "r+");
    } else {
      descriptor = openSync(publicationPath, "wx+");
      faults.after_stage_publication_created?.();
    }
    stagedIdentity = fstatSync(descriptor);
    if (!stagedIdentity.isFile() || stagedIdentity.ino === 0
      || (publication && (stagedIdentity.nlink !== publication.entry.nlink
        || stagedIdentity.dev !== publication.entry.dev
        || stagedIdentity.ino !== publication.entry.ino))) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    if (ownership.state === "planned") {
      ownership = persistVerifiedBlobRecoveryStageOwnership(
        targetMutex,
        stagedPath,
        publicationPath,
        stagedIdentity,
        blob,
        faults.after_stage_ownership_persisted
      );
    } else {
      if (!publication) throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      assertVerifiedBlobRecoveryStageOwnership(ownership, publication.path, ownerPath, blob);
    }
    if (!existsSync(ownerPath)) {
      linkSync(publicationPath, ownerPath);
      const ownerPublished = lstatSync(ownerPath);
      const linkedPublication = fstatSync(descriptor);
      if (ownerPublished.isSymbolicLink() || !ownerPublished.isFile()
        || linkedPublication.nlink !== 2 || ownerPublished.nlink !== 2
        || ownerPublished.dev !== stagedIdentity.dev || ownerPublished.ino !== stagedIdentity.ino
        || linkedPublication.dev !== stagedIdentity.dev || linkedPublication.ino !== stagedIdentity.ino) {
        throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      }
      faults.after_stage_owner_created?.();
    }
    linkSync(ownerPath, stagedPath);
    const linked = fstatSync(descriptor);
    if (!linked.isFile() || linked.nlink !== 3
      || linked.dev !== stagedIdentity.dev || linked.ino !== stagedIdentity.ino) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    const linkedPublication = findRecordedRecoveryStagePublication(
      stagedPath,
      ownerPath,
      registeredRoot,
      canonicalRoot,
      ownership
    );
    if (!linkedPublication) throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    faults.after_stage_published_with_owner_proof?.();
    rmSync(publicationPath);
    const normalized = fstatSync(descriptor);
    if (!normalized.isFile() || normalized.nlink !== 2
      || normalized.dev !== stagedIdentity.dev || normalized.ino !== stagedIdentity.ino) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    assertOwnedRecoveryStagingFile(stagedPath, ownerPath, registeredRoot, canonicalRoot);
    assertVerifiedBlobRecoveryStageOwnership(ownership, stagedPath, ownerPath, blob);
    ftruncateSync(descriptor, 0);
    copyRecoverySourceToDescriptor(sourcePath, descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    throw error;
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
  assertExpectedRecoveryStagingFile(stagedPath, stagedPath, roots, registeredRoot, canonicalRoot, 2);
  assertOwnedRecoveryStagingFile(stagedPath, ownerPath, registeredRoot, canonicalRoot);
  assertVerifiedBlobRecoveryStageOwnership(ownership, stagedPath, ownerPath, blob);
  let stagedFacts: LocalMediaFacts;
  try { stagedFacts = localMediaFacts(stagedPath, artifact); }
  catch { throw new Error("MEDIA_BLOB_RECOVERY_CONTENT_MISMATCH"); }
  if (stagedFacts.sha256 !== blob.sha256
    || stagedFacts.size_bytes !== blob.size_bytes
    || stagedFacts.detected_mime !== blob.detected_mime) {
    throw new Error("MEDIA_BLOB_RECOVERY_CONTENT_MISMATCH");
  }
}

function inspectInterruptedVerifiedBlobPlacement(
  targetPath: string,
  _targetDirectory: string,
  deterministicStagedPath: string,
  deterministicOwnerPath: string,
  _roots: ReturnType<typeof activationRoots>,
  registeredRoot: string,
  canonicalRoot: string
): { candidatePaths: string[]; targetEntry: ReturnType<typeof lstatSync> } | null {
  const targetEntry = lstatSync(targetPath);
  if (targetEntry.isSymbolicLink() || !targetEntry.isFile()) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  if (targetEntry.nlink === 1) return null;
  if (targetEntry.ino === 0) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }

  // A hard exit after the first normalization removal leaves the target and
  // deterministic owner as a two-link pair.  That is still provably app-owned:
  // the owner is the only remaining companion link to the target inode.  Treat
  // it as a resumable state instead of rejecting every retry permanently.
  if (targetEntry.nlink === 2) {
    if (existsSync(deterministicStagedPath) || !existsSync(deterministicOwnerPath)
      || !sameResolvedPath(dirname(targetPath), dirname(deterministicOwnerPath))
      || !isPathInside(deterministicOwnerPath, registeredRoot)
      || !DETERMINISTIC_BLOB_RECOVERY_STAGE_OWNER_NAME.test(basename(deterministicOwnerPath))
      || hasExistingSymlinkAncestor(deterministicOwnerPath, registeredRoot)) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    const owner = lstatSync(deterministicOwnerPath);
    const canonicalOwner = resolve(realpathSync(deterministicOwnerPath));
    const canonicalTargetDirectory = resolve(realpathSync(dirname(targetPath)));
    if (owner.isSymbolicLink() || !owner.isFile() || owner.nlink !== 2
      || owner.dev !== targetEntry.dev || owner.ino !== targetEntry.ino
      || !isPathInside(canonicalOwner, canonicalRoot)
      || !sameResolvedPath(dirname(canonicalOwner), canonicalTargetDirectory)) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    return { candidatePaths: [deterministicOwnerPath], targetEntry };
  }

  if (targetEntry.nlink !== 3
    || !existsSync(deterministicStagedPath) || !existsSync(deterministicOwnerPath)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }

  const owned = assertOwnedRecoveryStagingFile(
    deterministicStagedPath,
    deterministicOwnerPath,
    registeredRoot,
    canonicalRoot,
    3
  );
  if (!owned || owned.dev !== targetEntry.dev || owned.ino !== targetEntry.ino) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return { candidatePaths: [deterministicStagedPath, deterministicOwnerPath], targetEntry };
}

function removeInterruptedVerifiedBlobPlacementLink(
  targetPath: string,
  candidatePath: string,
  expectedTarget: NonNullable<ReturnType<typeof lstatSync>>,
  registeredRoot: string,
  canonicalRoot: string
): void {
  const targetBefore = lstatSync(targetPath);
  if (targetBefore.isSymbolicLink() || !targetBefore.isFile()
    || targetBefore.ino === 0
    || targetBefore.dev !== expectedTarget.dev
    || targetBefore.ino !== expectedTarget.ino
    || targetBefore.nlink <= 1
    || !isPathInside(targetPath, registeredRoot)
    || hasExistingSymlinkAncestor(targetPath, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  if (!sameResolvedPath(dirname(targetPath), dirname(candidatePath))
    || !isPathInside(candidatePath, registeredRoot)
    || hasExistingSymlinkAncestor(candidatePath, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const candidate = lstatSync(candidatePath);
  const canonicalTargetDirectory = resolve(realpathSync(dirname(targetPath)));
  const canonicalCandidate = resolve(realpathSync(candidatePath));
  if (candidate.isSymbolicLink() || !candidate.isFile()
    || candidate.nlink !== targetBefore.nlink
    || candidate.dev !== targetBefore.dev
    || candidate.ino !== targetBefore.ino
    || !isPathInside(canonicalCandidate, canonicalRoot)
    || !sameResolvedPath(dirname(canonicalCandidate), canonicalTargetDirectory)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }

  // Each removal is a separately validated state transition.  If the process
  // stops after this unlink, the next run observes target+owner (nlink=2) and
  // can safely continue rather than requiring a manual repair.
  rmSync(candidatePath);
  const targetAfter = lstatSync(targetPath);
  if (targetAfter.isSymbolicLink() || !targetAfter.isFile()
    || targetAfter.nlink !== targetBefore.nlink - 1
    || targetAfter.dev !== expectedTarget.dev
    || targetAfter.ino !== expectedTarget.ino) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
}

function normalizeInterruptedVerifiedBlobPlacement(
  targetPath: string,
  targetDirectory: string,
  deterministicStagedPath: string,
  deterministicOwnerPath: string,
  roots: ReturnType<typeof activationRoots>,
  registeredRoot: string,
  canonicalRoot: string,
  afterLinkRemoved?: () => void
): void {
  const interrupted = inspectInterruptedVerifiedBlobPlacement(
    targetPath,
    targetDirectory,
    deterministicStagedPath,
    deterministicOwnerPath,
    roots,
    registeredRoot,
    canonicalRoot
  );
  if (!interrupted) return;

  const { candidatePaths, targetEntry } = interrupted;
  if (!targetEntry) throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  for (const candidatePath of candidatePaths) {
    removeInterruptedVerifiedBlobPlacementLink(
      targetPath,
      candidatePath,
      targetEntry,
      registeredRoot,
      canonicalRoot
    );
    afterLinkRemoved?.();
  }
  const normalizedTarget = lstatSync(targetPath);
  if (normalizedTarget.isSymbolicLink()
    || !normalizedTarget.isFile()
    || normalizedTarget.nlink !== 1
    || normalizedTarget.dev !== targetEntry.dev
    || normalizedTarget.ino !== targetEntry.ino) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
}

function recoveryRootAndTarget(blob: MediaBlob): {
  registeredRoot: string;
  canonicalRoot: string;
  targetPath: string;
  targetDirectory: string;
  registeredTargetUsesDosAlias: boolean;
} {
  const rootValue = blob.provenance.media_root;
  if (typeof rootValue !== "string"
    || !isAbsolute(rootValue)
    || !isAbsolute(blob.storage_uri)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const registeredRoot = resolve(rootValue);
  if (!existsSync(registeredRoot)) throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  const rootEntry = lstatSync(registeredRoot);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const canonicalRoot = resolve(realpathSync(registeredRoot));
  if (!sameResolvedPath(canonicalRoot, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const registeredTargetPath = resolve(blob.storage_uri);
  const registeredTargetDirectory = dirname(registeredTargetPath);
  if (!existsSync(registeredTargetDirectory)
    || hasSymlinkAncestorBeforeCanonicalRoot(registeredTargetDirectory, canonicalRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const directoryEntry = lstatSync(registeredTargetDirectory);
  if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const canonicalDirectory = resolve(realpathSync(registeredTargetDirectory));
  if (!isPathInside(canonicalDirectory, canonicalRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  let targetPath = resolve(canonicalDirectory, basename(registeredTargetPath));
  let registeredTargetUsesDosAlias = false;
  if (existsSync(registeredTargetPath)) {
    const targetEntry = lstatSync(registeredTargetPath);
    if (targetEntry.isSymbolicLink() || !targetEntry.isFile()) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    targetPath = resolve(realpathSync(registeredTargetPath));
    registeredTargetUsesDosAlias = process.platform === "win32"
      && isWindowsDosShortFilename(basename(registeredTargetPath))
      && !sameResolvedPath(targetPath, registeredTargetPath);
  } else if (process.platform === "win32" && isWindowsDosShortFilename(basename(registeredTargetPath))) {
    // A missing DOS-short filename cannot be expanded back to its physical long
    // name, so deriving a second recovery identity would be unsafe.
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const targetDirectory = dirname(targetPath);
  if (!sameResolvedPath(targetDirectory, canonicalDirectory)
    || !isPathInside(targetPath, canonicalRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return { registeredRoot, canonicalRoot, targetPath, targetDirectory, registeredTargetUsesDosAlias };
}

interface VerifiedBlobRecoveryBinding {
  artifact: MediaArtifact;
  blob: MediaBlob;
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>;
  identity: string;
}

interface VerifiedBlobRecoveryTargetMutex {
  database: NodeDatabaseSync;
  guardDescriptor: number;
  ownershipDatabase: NodeDatabaseSync;
  ownershipGuardDescriptor: number;
}

interface VerifiedBlobRecoveryStageOwnership {
  version: number;
  state: "planned" | "published";
  staged_path_identity_sha256: string;
  publication_name: string;
  instance_id: string;
  device_id: string;
  inode_id: string;
  blob_sha256: string;
}

function verifiedBlobRecoveryStagePathIdentity(stagedPath: string): string {
  return createHash("sha256")
    .update(verifiedBlobRecoveryPathIdentity(resolve(stagedPath)))
    .digest("hex");
}

function readVerifiedBlobRecoveryStageOwnership(
  mutex: VerifiedBlobRecoveryTargetMutex,
  stagedPath: string,
  blob: MediaBlob
): VerifiedBlobRecoveryStageOwnership | null {
  const row = mutex.ownershipDatabase.prepare(`
    SELECT version, state, staged_path_identity_sha256, publication_name, instance_id,
           device_id, inode_id, blob_sha256
      FROM verified_blob_recovery_stage_ownership
     WHERE singleton = 1
  `).get() as VerifiedBlobRecoveryStageOwnership | undefined;
  if (!row) return null;
  if (row.version !== 1
    || row.staged_path_identity_sha256 !== verifiedBlobRecoveryStagePathIdentity(stagedPath)
    || (row.state !== "planned" && row.state !== "published")
    || !BLOB_RECOVERY_STAGE_PUBLICATION_NAME.test(row.publication_name)
    || !/^[0-9a-f-]{36}$/i.test(row.instance_id)
    || (row.state === "planned" && (row.device_id !== "" || row.inode_id !== ""))
    || (row.state === "published" && (!/^\d+$/.test(row.device_id)
      || !/^\d+$/.test(row.inode_id) || row.inode_id === "0"))
    || row.blob_sha256 !== blob.sha256) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const publicationInstance = row.publication_name.slice(
    row.publication_name.indexOf(".publish-") + ".publish-".length,
    -".tmp".length
  );
  if (publicationInstance.toLowerCase() !== row.instance_id.toLowerCase()) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return row;
}

function assertVerifiedBlobRecoveryStageOwnership(
  ownership: VerifiedBlobRecoveryStageOwnership | null,
  firstPath: string,
  secondPath: string,
  blob?: MediaBlob
): void {
  if (!ownership || ownership.state !== "published"
    || (blob && ownership.blob_sha256 !== blob.sha256)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  let observed = false;
  for (const candidatePath of [firstPath, secondPath]) {
    if (!candidatePath || !existsSync(candidatePath)) continue;
    const candidate = lstatSync(candidatePath);
    observed = true;
    if (candidate.isSymbolicLink() || !candidate.isFile()
      || String(candidate.dev) !== ownership.device_id
      || String(candidate.ino) !== ownership.inode_id) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
  }
  if (!observed) throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
}

function commitVerifiedBlobRecoveryStageOwnership(
  mutex: VerifiedBlobRecoveryTargetMutex,
  ownership: VerifiedBlobRecoveryStageOwnership,
  afterPersisted?: () => void
): void {
  try {
    mutex.ownershipDatabase.exec("BEGIN IMMEDIATE");
    mutex.ownershipDatabase.prepare(`
      INSERT INTO verified_blob_recovery_stage_ownership (
        singleton, version, state, staged_path_identity_sha256, publication_name,
        instance_id, device_id, inode_id, blob_sha256
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        version = excluded.version,
        state = excluded.state,
        staged_path_identity_sha256 = excluded.staged_path_identity_sha256,
        publication_name = excluded.publication_name,
        instance_id = excluded.instance_id,
        device_id = excluded.device_id,
        inode_id = excluded.inode_id,
        blob_sha256 = excluded.blob_sha256
    `).run(
      ownership.version,
      ownership.state,
      ownership.staged_path_identity_sha256,
      ownership.publication_name,
      ownership.instance_id,
      ownership.device_id,
      ownership.inode_id,
      ownership.blob_sha256
    );
    mutex.ownershipDatabase.exec("COMMIT");
    afterPersisted?.();
  } catch (error) {
    try { mutex.ownershipDatabase.exec("ROLLBACK"); } catch { /* preserve stable persistence failure */ }
    if ((error as { errcode?: number }).errcode === 5) {
      throw new Error("MEDIA_BLOB_RECOVERY_BUSY");
    }
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
}

function planVerifiedBlobRecoveryStageOwnership(
  mutex: VerifiedBlobRecoveryTargetMutex,
  stagedPath: string,
  publicationPath: string,
  blob: MediaBlob
): VerifiedBlobRecoveryStageOwnership {
  const publicationName = basename(publicationPath);
  const instanceId = publicationName.slice(
    publicationName.indexOf(".publish-") + ".publish-".length,
    -".tmp".length
  );
  const ownership: VerifiedBlobRecoveryStageOwnership = {
    version: 1,
    state: "planned",
    staged_path_identity_sha256: verifiedBlobRecoveryStagePathIdentity(stagedPath),
    publication_name: publicationName,
    instance_id: instanceId,
    device_id: "",
    inode_id: "",
    blob_sha256: blob.sha256
  };
  if (!BLOB_RECOVERY_STAGE_PUBLICATION_NAME.test(publicationName)
    || !/^[0-9a-f-]{36}$/i.test(instanceId)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  commitVerifiedBlobRecoveryStageOwnership(mutex, ownership);
  return ownership;
}

function persistVerifiedBlobRecoveryStageOwnership(
  mutex: VerifiedBlobRecoveryTargetMutex,
  stagedPath: string,
  publicationPath: string,
  identity: ReturnType<typeof fstatSync>,
  blob: MediaBlob,
  afterPersisted?: () => void
): VerifiedBlobRecoveryStageOwnership {
  const publicationName = basename(publicationPath);
  const instanceId = publicationName.slice(
    publicationName.indexOf(".publish-") + ".publish-".length,
    -".tmp".length
  );
  const ownership: VerifiedBlobRecoveryStageOwnership = {
    version: 1,
    state: "published",
    staged_path_identity_sha256: verifiedBlobRecoveryStagePathIdentity(stagedPath),
    publication_name: publicationName,
    instance_id: instanceId,
    device_id: String(identity.dev),
    inode_id: String(identity.ino),
    blob_sha256: blob.sha256
  };
  if (!BLOB_RECOVERY_STAGE_PUBLICATION_NAME.test(publicationName)
    || !/^[0-9a-f-]{36}$/i.test(instanceId)
    || identity.ino === 0 || !identity.isFile() || identity.nlink !== 1) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  commitVerifiedBlobRecoveryStageOwnership(mutex, ownership, afterPersisted);
  return ownership;
}

interface VerifiedBlobRecoveryTargetAuthority {
  version: 1;
  target_identity_sha256: string;
  registered_root_identity_sha256: string;
  blob_sha256: string;
  blob_size_bytes: number;
  blob_mime: string;
}

interface VerifiedBlobRecoveryTargetAuthorityPublication extends VerifiedBlobRecoveryTargetAuthority {
  temporary_name: string;
}

function readVerifiedBlobRecoveryTargetAuthorityPublication(
  mutex: VerifiedBlobRecoveryTargetMutex,
  expected: VerifiedBlobRecoveryTargetAuthority
): VerifiedBlobRecoveryTargetAuthorityPublication | null {
  const row = mutex.ownershipDatabase.prepare(`
    SELECT version, temporary_name, target_identity_sha256, registered_root_identity_sha256,
           blob_sha256, blob_size_bytes, blob_mime
      FROM verified_blob_recovery_target_authority_publication
     WHERE singleton = 1
  `).get() as VerifiedBlobRecoveryTargetAuthorityPublication | undefined;
  if (!row) return null;
  if (row.version !== 1
    || !BLOB_RECOVERY_TARGET_AUTHORITY_TEMP_NAME.test(row.temporary_name)
    || !row.temporary_name.startsWith(
      `.blob-recovery-target-${expected.target_identity_sha256}.authority-`
    )
    || row.target_identity_sha256 !== expected.target_identity_sha256
    || row.registered_root_identity_sha256 !== expected.registered_root_identity_sha256) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  if (row.blob_sha256 !== expected.blob_sha256
    || row.blob_size_bytes !== expected.blob_size_bytes
    || row.blob_mime !== expected.blob_mime) {
    throw new Error("MEDIA_BLOB_RECOVERY_BINDING_MISMATCH");
  }
  return row;
}

function planVerifiedBlobRecoveryTargetAuthorityPublication(
  mutex: VerifiedBlobRecoveryTargetMutex,
  expected: VerifiedBlobRecoveryTargetAuthority
): VerifiedBlobRecoveryTargetAuthorityPublication {
  const publication: VerifiedBlobRecoveryTargetAuthorityPublication = {
    ...expected,
    temporary_name: `.blob-recovery-target-${expected.target_identity_sha256}.authority-${randomUUID()}.tmp`
  };
  if (!BLOB_RECOVERY_TARGET_AUTHORITY_TEMP_NAME.test(publication.temporary_name)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  try {
    mutex.ownershipDatabase.exec("BEGIN IMMEDIATE");
    mutex.ownershipDatabase.prepare(`
      INSERT INTO verified_blob_recovery_target_authority_publication (
        singleton, version, temporary_name, target_identity_sha256,
        registered_root_identity_sha256, blob_sha256, blob_size_bytes, blob_mime
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      publication.version,
      publication.temporary_name,
      publication.target_identity_sha256,
      publication.registered_root_identity_sha256,
      publication.blob_sha256,
      publication.blob_size_bytes,
      publication.blob_mime
    );
    mutex.ownershipDatabase.exec("COMMIT");
  } catch (error) {
    try { mutex.ownershipDatabase.exec("ROLLBACK"); } catch { /* preserve stable persistence failure */ }
    if ((error as { errcode?: number }).errcode === 5) {
      throw new Error("MEDIA_BLOB_RECOVERY_BUSY");
    }
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return publication;
}

function removeRecordedVerifiedBlobRecoveryTargetAuthorityCompanion(
  authorityPath: string,
  publication: VerifiedBlobRecoveryTargetAuthorityPublication,
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>,
  expected: VerifiedBlobRecoveryTargetAuthority
): void {
  const temporaryPath = resolve(recoveryPaths.targetDirectory, publication.temporary_name);
  if (!sameResolvedPath(dirname(temporaryPath), recoveryPaths.targetDirectory)
    || !isPathInside(temporaryPath, recoveryPaths.registeredRoot)
    || hasExistingSymlinkAncestor(temporaryPath, recoveryPaths.registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  try {
    const authority = lstatSync(authorityPath);
    const temporary = lstatSync(temporaryPath);
    if (authority.isSymbolicLink() || !authority.isFile() || authority.nlink !== 2
      || temporary.isSymbolicLink() || !temporary.isFile() || temporary.nlink !== 2
      || authority.dev !== temporary.dev || authority.ino !== temporary.ino) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    rmSync(temporaryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assertVerifiedBlobRecoveryTargetAuthorityFile(authorityPath, recoveryPaths, expected);
}

function readVerifiedBlobRecoveryBinding(
  input: VerifiedBlobStorageRecoveryInput,
  db: M0Database
): VerifiedBlobRecoveryBinding {
  let artifact: MediaArtifact | null;
  try {
    artifact = getMediaArtifact(db, input.invalid_artifact_id);
  } catch {
    throw new Error("MEDIA_BLOB_RECOVERY_BINDING_MISMATCH");
  }
  if (!artifact
    || artifact.linked_objects.project_id !== input.project_id
    || artifact.linked_objects.shot_id !== input.shot_id
    || artifact.role !== "generated_clip"
    || artifact.artifact_type !== "video") {
    throw new Error("MEDIA_BLOB_RECOVERY_BINDING_MISMATCH");
  }

  const links = db.prepare(
    "SELECT blob_id FROM media_artifact_blobs WHERE artifact_id = ? ORDER BY blob_id"
  ).all(input.invalid_artifact_id) as Array<{ blob_id: string }>;
  if (links.length !== 1 || links[0].blob_id !== artifact.blob_id) {
    throw new Error("MEDIA_BLOB_RECOVERY_BINDING_MISMATCH");
  }
  const blob = getMediaBlob(db, links[0].blob_id);
  if (!blob
    || blob.integrity_state !== "verified"
    || !isAbsolute(artifact.storage.uri)
    || !sameResolvedPath(artifact.storage.uri, blob.storage_uri)
    || artifact.metadata.sha256 !== blob.sha256
    || artifact.source.sha256 !== blob.sha256
    || artifact.storage.mime_type !== blob.detected_mime) {
    throw new Error("MEDIA_BLOB_RECOVERY_BINDING_MISMATCH");
  }
  const recoveryPaths = recoveryRootAndTarget(blob);
  const identity = JSON.stringify({
    artifact_id: artifact.artifact_id,
    artifact_blob_id: artifact.blob_id,
    project_id: artifact.linked_objects.project_id,
    shot_id: artifact.linked_objects.shot_id,
    artifact_type: artifact.artifact_type,
    role: artifact.role,
    artifact_storage_uri: resolve(artifact.storage.uri),
    artifact_sha256: artifact.metadata.sha256,
    source_sha256: artifact.source.sha256,
    artifact_mime: artifact.storage.mime_type,
    blob_id: blob.blob_id,
    blob_sha256: blob.sha256,
    blob_size_bytes: blob.size_bytes,
    blob_mime: blob.detected_mime,
    blob_storage_uri: resolve(blob.storage_uri),
    blob_integrity_state: blob.integrity_state,
    registered_media_root: recoveryPaths.registeredRoot,
    canonical_media_root: recoveryPaths.canonicalRoot
  });
  return { artifact, blob, recoveryPaths, identity };
}

function verifiedBlobRecoveryTargetMutexPath(
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>,
  roots: ReturnType<typeof activationRoots>,
  stagedPath: string
): string {
  const canonicalJournal = resolve(realpathSync(roots.journal));
  if (!sameResolvedPath(canonicalJournal, roots.journal)
    || !isPathInside(canonicalJournal, recoveryPaths.canonicalRoot)
    || hasExistingSymlinkAncestor(roots.journal, recoveryPaths.registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const digest = createHash("sha256")
    .update(verifiedBlobRecoveryPathIdentity(recoveryPaths.canonicalRoot))
    .update("\0")
    .update(verifiedBlobRecoveryPathIdentity(recoveryPaths.targetPath))
    .digest("hex");
  const lockPath = resolve(roots.journal, `blob-recovery-target-${digest}.lock.sqlite`);
  if (!BLOB_RECOVERY_TARGET_MUTEX_NAME.test(basename(lockPath))
    || !sameResolvedPath(dirname(lockPath), roots.journal)
    || !isPathInside(lockPath, recoveryPaths.registeredRoot)
    || sameResolvedPath(lockPath, recoveryPaths.targetPath)
    || sameResolvedPath(lockPath, stagedPath)
    || hasExistingSymlinkAncestor(lockPath, recoveryPaths.registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return lockPath;
}

function verifiedBlobRecoveryStageOwnershipStorePath(
  stagedPath: string,
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>,
  roots: ReturnType<typeof activationRoots>
): string {
  const digest = basename(stagedPath).slice("blob-recovery-".length, -".staged".length);
  const storePath = resolve(roots.journal, `blob-recovery-stage-ownership-${digest}.sqlite`);
  if (!DETERMINISTIC_BLOB_RECOVERY_STAGING_NAME.test(basename(stagedPath))
    || !BLOB_RECOVERY_STAGE_OWNERSHIP_STORE_NAME.test(basename(storePath))
    || !sameResolvedPath(dirname(storePath), roots.journal)
    || !isPathInside(storePath, recoveryPaths.registeredRoot)
    || sameResolvedPath(storePath, recoveryPaths.targetPath)
    || sameResolvedPath(storePath, stagedPath)
    || hasExistingSymlinkAncestor(storePath, recoveryPaths.registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return storePath;
}

function verifiedBlobRecoveryTargetAuthorityPath(
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>
): string {
  const digest = createHash("sha256")
    .update(verifiedBlobRecoveryPathIdentity(recoveryPaths.targetPath))
    .digest("hex");
  const authorityPath = resolve(
    recoveryPaths.targetDirectory,
    `.blob-recovery-target-${digest}.authority.json`
  );
  if (!BLOB_RECOVERY_TARGET_AUTHORITY_NAME.test(basename(authorityPath))
    || !sameResolvedPath(dirname(authorityPath), recoveryPaths.targetDirectory)
    || !isPathInside(authorityPath, recoveryPaths.registeredRoot)
    || sameResolvedPath(authorityPath, recoveryPaths.targetPath)
    || hasExistingSymlinkAncestor(authorityPath, recoveryPaths.registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return authorityPath;
}

function expectedVerifiedBlobRecoveryTargetAuthority(
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>,
  blob: MediaBlob
): VerifiedBlobRecoveryTargetAuthority {
  return {
    version: 1,
    target_identity_sha256: createHash("sha256")
      .update(verifiedBlobRecoveryPathIdentity(recoveryPaths.targetPath))
      .digest("hex"),
    registered_root_identity_sha256: createHash("sha256")
      .update(verifiedBlobRecoveryPathIdentity(recoveryPaths.canonicalRoot))
      .digest("hex"),
    blob_sha256: blob.sha256,
    blob_size_bytes: blob.size_bytes,
    blob_mime: blob.detected_mime
  };
}

function assertVerifiedBlobRecoveryTargetAuthorityFile(
  authorityPath: string,
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>,
  expected: VerifiedBlobRecoveryTargetAuthority
): void {
  if (!existsSync(authorityPath)
    || !sameResolvedPath(dirname(authorityPath), recoveryPaths.targetDirectory)
    || !isPathInside(authorityPath, recoveryPaths.canonicalRoot)
    || hasExistingSymlinkAncestor(authorityPath, recoveryPaths.registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const entry = lstatSync(authorityPath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink < 1 || entry.nlink > 2 || entry.size <= 0 || entry.size > 1024) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  let linkedCandidatePath = "";
  if (entry.nlink === 2) {
    const linkedCandidates = readdirSync(recoveryPaths.targetDirectory)
      .filter((name) => BLOB_RECOVERY_TARGET_AUTHORITY_TEMP_NAME.test(name))
      .map((name) => resolve(recoveryPaths.targetDirectory, name))
      .filter((candidatePath) => {
        try {
          const candidate = lstatSync(candidatePath);
          return !candidate.isSymbolicLink()
            && candidate.isFile()
            && candidate.nlink === 2
            && candidate.dev === entry.dev
            && candidate.ino === entry.ino;
        } catch {
          return false;
        }
      });
    if (linkedCandidates.length !== 1) throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    linkedCandidatePath = linkedCandidates[0];
  }
  let descriptor = -1;
  try {
    descriptor = openSync(authorityPath, "r");
    const guarded = fstatSync(descriptor);
    const current = statSync(authorityPath);
    const canonicalPath = resolve(realpathSync(authorityPath));
    const safeLinkCount = guarded.nlink === 1 || guarded.nlink === 2;
    if (!guarded.isFile()
      || !safeLinkCount
      || guarded.size <= 0
      || guarded.size > 1024
      || guarded.dev !== entry.dev
      || guarded.ino !== entry.ino
      || guarded.dev !== current.dev
      || guarded.ino !== current.ino
      || (!linkedCandidatePath && guarded.nlink !== 1)
      || !sameResolvedPath(canonicalPath, authorityPath)) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    let actual: VerifiedBlobRecoveryTargetAuthority;
    try {
      actual = JSON.parse(readFileSync(descriptor, "utf8")) as VerifiedBlobRecoveryTargetAuthority;
    } catch {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    const after = fstatSync(descriptor);
    const currentAfter = statSync(authorityPath);
    if (after.dev !== guarded.dev
      || after.ino !== guarded.ino
      || after.size !== guarded.size
      || after.mtimeMs !== guarded.mtimeMs
      || currentAfter.dev !== guarded.dev
      || currentAfter.ino !== guarded.ino) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    if (actual.version !== 1
      || actual.target_identity_sha256 !== expected.target_identity_sha256
      || actual.registered_root_identity_sha256 !== expected.registered_root_identity_sha256) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    if (actual.blob_sha256 !== expected.blob_sha256
      || actual.blob_size_bytes !== expected.blob_size_bytes
      || actual.blob_mime !== expected.blob_mime) {
      throw new Error("MEDIA_BLOB_RECOVERY_BINDING_MISMATCH");
    }
    if (linkedCandidatePath) {
      try {
        const candidate = lstatSync(linkedCandidatePath);
        if (guarded.nlink !== 2
          || candidate.isSymbolicLink() || !candidate.isFile()
          || candidate.nlink !== 2
          || candidate.dev !== guarded.dev
          || candidate.ino !== guarded.ino) {
          throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || guarded.nlink !== 1) throw error;
      }
    }
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

function ensureVerifiedBlobRecoveryTargetAuthority(
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>,
  blob: MediaBlob,
  faults: VerifiedBlobStorageRecoveryFaults,
  targetMutex: VerifiedBlobRecoveryTargetMutex
): string {
  const authorityPath = verifiedBlobRecoveryTargetAuthorityPath(recoveryPaths);
  const expected = expectedVerifiedBlobRecoveryTargetAuthority(recoveryPaths, blob);
  let publication = readVerifiedBlobRecoveryTargetAuthorityPublication(targetMutex, expected);
  try {
    lstatSync(authorityPath);
    assertVerifiedBlobRecoveryTargetAuthorityFile(authorityPath, recoveryPaths, expected);
    if (publication) {
      removeRecordedVerifiedBlobRecoveryTargetAuthorityCompanion(
        authorityPath,
        publication,
        recoveryPaths,
        expected
      );
    }
    return authorityPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  publication ??= planVerifiedBlobRecoveryTargetAuthorityPublication(targetMutex, expected);
  const temporaryPath = resolve(recoveryPaths.targetDirectory, publication.temporary_name);
  if (!BLOB_RECOVERY_TARGET_AUTHORITY_TEMP_NAME.test(basename(temporaryPath))
    || !sameResolvedPath(dirname(temporaryPath), recoveryPaths.targetDirectory)
    || !isPathInside(temporaryPath, recoveryPaths.registeredRoot)
    || hasExistingSymlinkAncestor(temporaryPath, recoveryPaths.registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  let descriptor = -1;
  try {
    let entry: ReturnType<typeof lstatSync> | null = null;
    try { entry = lstatSync(temporaryPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    descriptor = openSync(temporaryPath, entry ? "r+" : "wx+");
    const temporaryIdentity = fstatSync(descriptor);
    const current = statSync(temporaryPath);
    if (!temporaryIdentity.isFile() || temporaryIdentity.nlink !== 1
      || temporaryIdentity.size > 1024
      || current.dev !== temporaryIdentity.dev || current.ino !== temporaryIdentity.ino
      || (entry && (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1
        || entry.dev !== temporaryIdentity.dev || entry.ino !== temporaryIdentity.ino))) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    faults.after_target_authority_temp_created?.();
    if (temporaryIdentity.size === 0) {
      writeFileSync(descriptor, JSON.stringify(expected), "utf8");
      fsyncSync(descriptor);
    } else {
      let actual: VerifiedBlobRecoveryTargetAuthority;
      try { actual = JSON.parse(readFileSync(descriptor, "utf8")) as VerifiedBlobRecoveryTargetAuthority; }
      catch { throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE"); }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      }
    }
    const written = fstatSync(descriptor);
    if (!written.isFile() || written.nlink !== 1 || written.size <= 0 || written.size > 1024) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    closeSync(descriptor);
    descriptor = -1;
    try { linkSync(temporaryPath, authorityPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      }
    }
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
  assertVerifiedBlobRecoveryTargetAuthorityFile(authorityPath, recoveryPaths, expected);
  removeRecordedVerifiedBlobRecoveryTargetAuthorityCompanion(
    authorityPath,
    publication,
    recoveryPaths,
    expected
  );
  return authorityPath;
}

function validateVerifiedBlobRecoveryEntriesBeforeAuthority(
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>,
  stagedPath: string,
  ownerPath: string,
  sourcePath: string,
  roots: ReturnType<typeof activationRoots>,
  artifact: MediaArtifact,
  blob: MediaBlob,
  targetMutex: VerifiedBlobRecoveryTargetMutex
): void {
  const authorityPath = verifiedBlobRecoveryTargetAuthorityPath(recoveryPaths);
  const expectedAuthority = expectedVerifiedBlobRecoveryTargetAuthority(recoveryPaths, blob);
  let authorityExists = false;
  try {
    lstatSync(authorityPath);
    authorityExists = true;
    assertVerifiedBlobRecoveryTargetAuthorityFile(authorityPath, recoveryPaths, expectedAuthority);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const interrupted = existsSync(recoveryPaths.targetPath)
    ? inspectInterruptedVerifiedBlobPlacement(
      recoveryPaths.targetPath,
      recoveryPaths.targetDirectory,
      stagedPath,
      ownerPath,
      roots,
      recoveryPaths.registeredRoot,
      recoveryPaths.canonicalRoot
    )
    : null;
  const stageOwnership = readVerifiedBlobRecoveryStageOwnership(targetMutex, stagedPath, blob);
  const stagePublication = findRecordedRecoveryStagePublication(
    stagedPath,
    ownerPath,
    recoveryPaths.registeredRoot,
    recoveryPaths.canonicalRoot,
    stageOwnership
  );

  if (existsSync(stagedPath)
    && (!interrupted || !interrupted.candidatePaths.some((candidatePath) => sameResolvedPath(candidatePath, stagedPath)))) {
    // A deterministic name and persistent target authority do not establish
    // stage-instance ownership. The exact companion hard link must identify
    // the same app-created inode before a stage can be reused or replaced.
    if (!stagePublication) {
      assertVerifiedBlobRecoveryStageOwnership(stageOwnership, stagedPath, ownerPath, blob);
      assertExpectedRecoveryStagingFile(
        stagedPath,
        stagedPath,
        roots,
        recoveryPaths.registeredRoot,
        recoveryPaths.canonicalRoot,
        2
      );
      assertOwnedRecoveryStagingFile(
        stagedPath,
        ownerPath,
        recoveryPaths.registeredRoot,
        recoveryPaths.canonicalRoot
      );
    }
  } else if (!existsSync(stagedPath) && existsSync(ownerPath)
    && (!interrupted || !interrupted.candidatePaths.some((candidatePath) => sameResolvedPath(candidatePath, ownerPath)))) {
    // Target authority is path/digest authority, not ownership evidence for a
    // later single-link owner inode. Only a verified publication companion or
    // the target-owner interrupted-placement pair may authorize continuation.
    if (!stagePublication) throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  if ((interrupted || stagePublication) && !authorityExists) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }

  reconcileLegacyVerifiedBlobRecoveryStaging(
    recoveryPaths.targetDirectory,
    recoveryPaths.targetPath,
    recoveryPaths.registeredRoot,
    recoveryPaths.canonicalRoot,
    artifact,
    blob,
    interrupted?.candidatePaths[0],
    sourcePath
  );
}

function assertVerifiedBlobRecoveryTargetMutexSidecarsAbsent(lockPath: string): void {
  for (const sidecarPath of [`${lockPath}-journal`, `${lockPath}-wal`, `${lockPath}-shm`]) {
    try {
      lstatSync(sidecarPath);
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function openNodeSqliteDatabase(filePath: string): NodeDatabaseSync {
  const sqlite = requireNodeBuiltin("node:sqlite") as typeof import("node:sqlite");
  return new sqlite.DatabaseSync(filePath);
}

function verifiedBlobRecoveryTargetMutexHeaderIdentity(lockPath: string): {
  applicationId: number;
  userVersion: number;
} {
  const name = basename(lockPath);
  const isTargetMutex = BLOB_RECOVERY_TARGET_MUTEX_NAME.test(name);
  const isOwnershipStore = BLOB_RECOVERY_STAGE_OWNERSHIP_STORE_NAME.test(name);
  if (!isTargetMutex && !isOwnershipStore) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const digest = Buffer.from(isTargetMutex
    ? name.slice("blob-recovery-target-".length, -".lock.sqlite".length)
    : name.slice("blob-recovery-stage-ownership-".length, -".sqlite".length), "hex");
  const applicationSalt = isTargetMutex
    ? BLOB_RECOVERY_TARGET_MUTEX_APPLICATION_ID
    : BLOB_RECOVERY_STAGE_OWNERSHIP_APPLICATION_ID;
  const applicationId = ((digest.readUInt32BE(0) ^ applicationSalt) & 0x7fffffff) || 1;
  const userVersion = (digest.readUInt32BE(4) & 0x7fffffff) || 1;
  return { applicationId, userVersion };
}

function assertVerifiedBlobRecoveryTargetMutexHeader(
  descriptor: number,
  lockPath: string,
  expectedLinkCount = 1
): void {
  const entry = fstatSync(descriptor);
  const expected = verifiedBlobRecoveryTargetMutexHeaderIdentity(lockPath);
  if (!entry.isFile()
    || entry.nlink !== expectedLinkCount
    || entry.size < 100
    || entry.size > BLOB_RECOVERY_TARGET_MUTEX_MAX_BYTES) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const header = Buffer.alloc(100);
  if (readSync(descriptor, header, 0, header.length, 0) !== header.length
    || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
    || header.readUInt32BE(60) !== expected.userVersion
    || header.readUInt32BE(68) !== expected.applicationId) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
}

function writeEmptyVerifiedBlobRecoveryMutex(descriptor: number, lockPath: string): void {
  const identity = verifiedBlobRecoveryTargetMutexHeaderIdentity(lockPath);
  const page = Buffer.alloc(4096);
  page.write("SQLite format 3\0", 0, "binary");
  page.writeUInt16BE(4096, 16);
  page[18] = 1;
  page[19] = 1;
  page[21] = 64;
  page[22] = 32;
  page[23] = 32;
  page.writeUInt32BE(1, 24);
  page.writeUInt32BE(1, 28);
  page.writeUInt32BE(4, 44);
  page.writeUInt32BE(1, 56);
  page.writeUInt32BE(identity.userVersion, 60);
  page.writeUInt32BE(identity.applicationId, 68);
  page.writeUInt32BE(1, 92);
  page.writeUInt32BE(3_048_000, 96);
  page[100] = 0x0d;
  page.writeUInt16BE(4096, 105);
  let written = 0;
  while (written < page.length) {
    written += writeSync(descriptor, page, written, page.length - written, written);
  }
  fsyncSync(descriptor);
}

function assertConnectedVerifiedBlobRecoveryTargetMutex(
  database: NodeDatabaseSync,
  lockPath: string
): void {
  const expected = verifiedBlobRecoveryTargetMutexHeaderIdentity(lockPath);
  const application = database.prepare("PRAGMA application_id").get() as { application_id?: number };
  const version = database.prepare("PRAGMA user_version").get() as { user_version?: number };
  if (application.application_id !== expected.applicationId
    || version.user_version !== expected.userVersion) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
}

function initializeVerifiedBlobRecoveryTargetMutex(
  lockPath: string,
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>,
  roots: ReturnType<typeof activationRoots>
): void {
  const temporaryPath = resolve(
    roots.journal,
    `.brm-${randomUUID()}.tmp.sqlite`
  );
  if (!BLOB_RECOVERY_TARGET_MUTEX_TEMP_NAME.test(basename(temporaryPath))
    || !sameResolvedPath(dirname(temporaryPath), roots.journal)
    || !isPathInside(temporaryPath, recoveryPaths.registeredRoot)
    || hasExistingSymlinkAncestor(temporaryPath, recoveryPaths.registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }

  let descriptor = -1;
  let temporaryIdentity: ReturnType<typeof fstatSync> | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx+");
    temporaryIdentity = fstatSync(descriptor);
    writeEmptyVerifiedBlobRecoveryMutex(descriptor, lockPath);
    const initialized = fstatSync(descriptor);
    const currentInitialized = statSync(temporaryPath);
    if (initialized.dev !== temporaryIdentity.dev
      || initialized.ino !== temporaryIdentity.ino
      || currentInitialized.dev !== temporaryIdentity.dev
      || currentInitialized.ino !== temporaryIdentity.ino) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    assertVerifiedBlobRecoveryTargetMutexHeader(descriptor, lockPath);
    assertVerifiedBlobRecoveryTargetMutexSidecarsAbsent(temporaryPath);
    try { linkSync(temporaryPath, lockPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      }
    }
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
    if (temporaryIdentity) {
      try {
        const current = lstatSync(temporaryPath);
        if (!current.isSymbolicLink()
          && current.isFile()
          && current.dev === temporaryIdentity.dev
          && current.ino === temporaryIdentity.ino) {
          rmSync(temporaryPath);
        }
      } catch { /* another contender may normalize the linked initialization temp */ }
    }
  }
}

function assertVerifiedBlobRecoveryTargetMutexFile(
  lockPath: string,
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>,
  roots: ReturnType<typeof activationRoots>,
  guardDescriptor?: number,
  afterTemporaryLinkObserved?: () => void
): void {
  if (!existsSync(lockPath)
    || !sameResolvedPath(dirname(lockPath), roots.journal)
    || !isPathInside(lockPath, recoveryPaths.canonicalRoot)
    || hasExistingSymlinkAncestor(lockPath, recoveryPaths.registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  let entry = lstatSync(lockPath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink < 1 || entry.nlink > 2) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  let linkedCandidatePath = "";
  if (entry.nlink === 2) {
    afterTemporaryLinkObserved?.();
    const linkedCandidates = readdirSync(roots.journal)
      .filter((name) => BLOB_RECOVERY_TARGET_MUTEX_TEMP_NAME.test(name))
      .map((name) => resolve(roots.journal, name))
      .filter((candidatePath) => {
        try {
          const candidate = lstatSync(candidatePath);
          return !candidate.isSymbolicLink()
            && candidate.isFile()
            && candidate.nlink === 2
            && candidate.dev === entry.dev
            && candidate.ino === entry.ino;
        } catch {
          return false;
        }
      });
    if (linkedCandidates.length === 0) {
      const converged = lstatSync(lockPath);
      if (converged.isSymbolicLink() || !converged.isFile()
        || converged.nlink !== 1
        || converged.dev !== entry.dev || converged.ino !== entry.ino) {
        throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      }
      entry = converged;
    } else if (linkedCandidates.length === 1) {
      linkedCandidatePath = linkedCandidates[0];
    } else {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
  }
  const canonicalPath = resolve(realpathSync(lockPath));
  if (!sameResolvedPath(canonicalPath, lockPath)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  if (guardDescriptor !== undefined) {
    const guarded = fstatSync(guardDescriptor);
    const current = statSync(lockPath);
    if (!guarded.isFile() || (guarded.nlink !== 1 && guarded.nlink !== 2)
      || guarded.dev !== current.dev || guarded.ino !== current.ino
      || guarded.dev !== entry.dev || guarded.ino !== entry.ino
      || (!linkedCandidatePath && guarded.nlink !== 1)) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    assertVerifiedBlobRecoveryTargetMutexHeader(guardDescriptor, lockPath, guarded.nlink);
    if (linkedCandidatePath) {
      try {
        const candidate = lstatSync(linkedCandidatePath);
        if (guarded.nlink !== 2
          || candidate.isSymbolicLink() || !candidate.isFile()
          || candidate.nlink !== 2
          || candidate.dev !== guarded.dev
          || candidate.ino !== guarded.ino) {
          throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || guarded.nlink !== 1) throw error;
      }
    }
  }
}

function acquireVerifiedBlobRecoveryTargetMutex(
  lockPath: string,
  ownershipPath: string,
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>,
  roots: ReturnType<typeof activationRoots>,
  busyTimeoutMs: number,
  faults: VerifiedBlobStorageRecoveryFaults
): VerifiedBlobRecoveryTargetMutex {
  if (!existsSync(lockPath)) {
    initializeVerifiedBlobRecoveryTargetMutex(lockPath, recoveryPaths, roots);
  }

  let guardDescriptor = -1;
  let ownershipGuardDescriptor = -1;
  let database: NodeDatabaseSync | null = null;
  let ownershipDatabase: NodeDatabaseSync | null = null;
  try {
    assertVerifiedBlobRecoveryTargetMutexFile(
      lockPath,
      recoveryPaths,
      roots,
      undefined,
      faults.after_target_mutex_temp_link_observed
    );
    assertVerifiedBlobRecoveryTargetMutexSidecarsAbsent(lockPath);
    guardDescriptor = openSync(lockPath, "r");
    assertVerifiedBlobRecoveryTargetMutexFile(lockPath, recoveryPaths, roots, guardDescriptor);
    faults.after_target_mutex_guard_open?.();
    database = openNodeSqliteDatabase(lockPath);
    assertConnectedVerifiedBlobRecoveryTargetMutex(database, lockPath);
    assertVerifiedBlobRecoveryTargetMutexFile(lockPath, recoveryPaths, roots, guardDescriptor);
    assertVerifiedBlobRecoveryTargetMutexSidecarsAbsent(lockPath);
    const journalMode = database.prepare("PRAGMA journal_mode = MEMORY").get() as { journal_mode?: string };
    if (journalMode.journal_mode?.toLowerCase() !== "memory") {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    assertVerifiedBlobRecoveryTargetMutexSidecarsAbsent(lockPath);
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    try {
      database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if ((error as { errcode?: number }).errcode === 5) {
        throw new Error("MEDIA_BLOB_RECOVERY_BUSY");
      }
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    assertConnectedVerifiedBlobRecoveryTargetMutex(database, lockPath);
    assertVerifiedBlobRecoveryTargetMutexFile(lockPath, recoveryPaths, roots, guardDescriptor);
    assertVerifiedBlobRecoveryTargetMutexSidecarsAbsent(lockPath);

    // The target transaction above is the continuous cross-database mutex.
    // Ownership is durable in an independent verified SQLite file so its
    // commits never release or reacquire that target lock.
    if (!existsSync(ownershipPath)) {
      initializeVerifiedBlobRecoveryTargetMutex(ownershipPath, recoveryPaths, roots);
    }
    assertVerifiedBlobRecoveryTargetMutexFile(ownershipPath, recoveryPaths, roots);
    assertVerifiedBlobRecoveryOwnershipJournalRecoverable(ownershipPath, recoveryPaths, roots);
    ownershipGuardDescriptor = openSync(ownershipPath, "r");
    assertVerifiedBlobRecoveryTargetMutexFile(
      ownershipPath,
      recoveryPaths,
      roots,
      ownershipGuardDescriptor
    );
    ownershipDatabase = openNodeSqliteDatabase(ownershipPath);
    const ownershipIntegrity = ownershipDatabase.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
    if (ownershipIntegrity.integrity_check?.toLowerCase() !== "ok") {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    assertConnectedVerifiedBlobRecoveryTargetMutex(ownershipDatabase, ownershipPath);
    assertVerifiedBlobRecoveryTargetMutexFile(
      ownershipPath,
      recoveryPaths,
      roots,
      ownershipGuardDescriptor
    );
    assertVerifiedBlobRecoveryTargetMutexSidecarsAbsent(ownershipPath);
    const ownershipJournalMode = ownershipDatabase.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode?: string };
    if (ownershipJournalMode.journal_mode?.toLowerCase() !== "delete") {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    ownershipDatabase.exec("PRAGMA synchronous = FULL;");
    const ownershipSynchronous = ownershipDatabase.prepare("PRAGMA synchronous").get() as { synchronous?: number };
    if (ownershipSynchronous.synchronous !== 2) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    ownershipDatabase.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    ownershipDatabase.exec(`
      CREATE TABLE IF NOT EXISTS verified_blob_recovery_stage_ownership (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL CHECK (version = 1),
        state TEXT NOT NULL CHECK (state IN ('planned', 'published')),
        staged_path_identity_sha256 TEXT NOT NULL,
        publication_name TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        inode_id TEXT NOT NULL,
        blob_sha256 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verified_blob_recovery_target_authority_publication (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL CHECK (version = 1),
        temporary_name TEXT NOT NULL,
        target_identity_sha256 TEXT NOT NULL,
        registered_root_identity_sha256 TEXT NOT NULL,
        blob_sha256 TEXT NOT NULL,
        blob_size_bytes INTEGER NOT NULL,
        blob_mime TEXT NOT NULL
      )
    `);
    assertConnectedVerifiedBlobRecoveryTargetMutex(ownershipDatabase, ownershipPath);
    assertVerifiedBlobRecoveryTargetMutexFile(
      ownershipPath,
      recoveryPaths,
      roots,
      ownershipGuardDescriptor
    );
    assertVerifiedBlobRecoveryTargetMutexSidecarsAbsent(ownershipPath);
    return { database, guardDescriptor, ownershipDatabase, ownershipGuardDescriptor };
  } catch (error) {
    if (ownershipDatabase) {
      try { ownershipDatabase.close(); } catch { /* preserve the stable acquisition error */ }
    }
    if (ownershipGuardDescriptor >= 0) closeSync(ownershipGuardDescriptor);
    if (database) {
      try { database.exec("ROLLBACK"); } catch { /* preserve the stable acquisition error */ }
      try { database.close(); } catch { /* preserve the stable acquisition error */ }
    }
    if (guardDescriptor >= 0) closeSync(guardDescriptor);
    if (error instanceof Error
      && (error.message === "MEDIA_BLOB_RECOVERY_BUSY"
        || error.message === "MEDIA_BLOB_RECOVERY_PATH_UNSAFE")) {
      throw error;
    }
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
}

function releaseVerifiedBlobRecoveryTargetMutex(mutex: VerifiedBlobRecoveryTargetMutex | null): void {
  if (!mutex) return;
  try {
    try { mutex.ownershipDatabase.close(); }
    finally { closeSync(mutex.ownershipGuardDescriptor); }
  } finally {
    try { mutex.database.exec("ROLLBACK"); } catch { /* process close still releases the operating-system lock */ }
    try { mutex.database.close(); } finally { closeSync(mutex.guardDescriptor); }
  }
}

function assertVerifiedBlobRecoveryOwnershipJournalRecoverable(
  ownershipPath: string,
  recoveryPaths: ReturnType<typeof recoveryRootAndTarget>,
  roots: ReturnType<typeof activationRoots>
): void {
  for (const sidecarPath of [`${ownershipPath}-wal`, `${ownershipPath}-shm`]) {
    try {
      lstatSync(sidecarPath);
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const journalPath = `${ownershipPath}-journal`;
  if (!existsSync(journalPath)) return;
  if (!sameResolvedPath(dirname(journalPath), roots.journal)
    || !isPathInside(journalPath, recoveryPaths.registeredRoot)
    || hasExistingSymlinkAncestor(journalPath, recoveryPaths.registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const entry = lstatSync(journalPath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1
    || entry.size > BLOB_RECOVERY_STAGE_OWNERSHIP_JOURNAL_MAX_BYTES
    || !sameResolvedPath(resolve(realpathSync(journalPath)), journalPath)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
}

function removeGeneratedRecoveryFile(filePath: string, ownedDirectory: string, registeredRoot: string): void {
  if (!existsSync(filePath)) return;
  const resolvedPath = resolve(filePath);
  if (!sameResolvedPath(dirname(resolvedPath), ownedDirectory)
    || !isPathInside(resolvedPath, registeredRoot)
    || hasExistingSymlinkAncestor(resolvedPath, registeredRoot)) return;
  const entry = lstatSync(filePath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) return;
  rmSync(filePath, { force: true });
}

function verifiedBlobRecoveryCleanupPaths(
  stagedPath: string,
  cleanupDirectory: string,
  registeredRoot: string
): { stagedCleanup: string; ownerCleanup: string } {
  const stagedName = basename(stagedPath);
  const digest = stagedName.slice("blob-recovery-".length, -".staged".length);
  const stagedCleanup = resolve(cleanupDirectory, `.blob-recovery-cleanup-${digest}.stage`);
  const ownerCleanup = resolve(cleanupDirectory, `.blob-recovery-cleanup-${digest}.owner`);
  if (!DETERMINISTIC_BLOB_RECOVERY_STAGING_NAME.test(stagedName)
    || !sameResolvedPath(dirname(stagedCleanup), cleanupDirectory)
    || !sameResolvedPath(dirname(ownerCleanup), cleanupDirectory)
    || !isPathInside(stagedCleanup, registeredRoot)
    || !isPathInside(ownerCleanup, registeredRoot)
    || hasExistingSymlinkAncestor(stagedCleanup, registeredRoot)
    || hasExistingSymlinkAncestor(ownerCleanup, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return { stagedCleanup, ownerCleanup };
}

function verifiedBlobRecoveryCleanupDirectory(
  stagedPath: string,
  registeredRoot: string,
  canonicalRoot: string,
  create: boolean
): string {
  const cleanupDirectory = resolve(dirname(stagedPath), ".blob-recovery-cleanup");
  if (!sameResolvedPath(dirname(cleanupDirectory), dirname(stagedPath))
    || !isPathInside(cleanupDirectory, registeredRoot)
    || hasExistingSymlinkAncestor(cleanupDirectory, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  if (create) {
    try { mkdirSync(cleanupDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      }
    }
  }
  if (!existsSync(cleanupDirectory)) return cleanupDirectory;
  const entry = lstatSync(cleanupDirectory);
  const canonical = resolve(realpathSync(cleanupDirectory));
  if (entry.isSymbolicLink() || !entry.isDirectory()
    || !isPathInside(canonical, canonicalRoot)
    || !sameResolvedPath(dirname(canonical), resolve(realpathSync(dirname(stagedPath))))) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  return cleanupDirectory;
}

function reconcileOwnedRecoveryCleanupPair(
  stagedPath: string,
  ownerPath: string,
  targetPath: string,
  cleanupDirectory: string,
  registeredRoot: string,
  protectedSourcePath = "",
  afterFirstRemoval?: () => void
): void {
  if (!existsSync(cleanupDirectory)) return;
  if (!sameResolvedPath(resolve(realpathSync(cleanupDirectory)), cleanupDirectory)
    || !isPathInside(cleanupDirectory, registeredRoot)
    || hasExistingSymlinkAncestor(cleanupDirectory, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const { stagedCleanup, ownerCleanup } = verifiedBlobRecoveryCleanupPaths(
    stagedPath,
    cleanupDirectory,
    registeredRoot
  );
  if (protectedSourcePath && [stagedPath, ownerPath, stagedCleanup, ownerCleanup]
    .some((candidate) => sameResolvedPath(candidate, protectedSourcePath))) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const cleanupPaths = [stagedCleanup, ownerCleanup].filter((candidate) => existsSync(candidate));
  if (cleanupPaths.length === 0) return;
  if (cleanupPaths.length === 1) {
    // A lone cleanup entry cannot prove that its counterpart directory entry has
    // not been replaced between a path-based identity check and a move. Preserve
    // both locations and require explicit repair rather than move an unverified
    // path into application cleanup.
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const cleanupEntries = cleanupPaths.map((candidate) => {
    const entry = lstatSync(candidate);
    const canonical = resolve(realpathSync(candidate));
    if (entry.isSymbolicLink() || !entry.isFile() || entry.ino === 0
      || !sameResolvedPath(dirname(canonical), cleanupDirectory)) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    return entry;
  });
  const owned = cleanupEntries[0];
  if (cleanupEntries.some((entry) => entry.dev !== owned.dev || entry.ino !== owned.ino)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  let targetOwnsLink = false;
  if (existsSync(targetPath)) {
    const target = lstatSync(targetPath);
    targetOwnsLink = !target.isSymbolicLink() && target.isFile()
      && target.dev === owned.dev && target.ino === owned.ino;
  }
  const expectedLinks = cleanupPaths.length + (targetOwnsLink ? 1 : 0);
  if (owned.nlink !== expectedLinks
    || cleanupEntries.some((entry) => entry.nlink !== expectedLinks)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  let removed = false;
  for (const cleanupPath of cleanupPaths) {
    rmSync(cleanupPath);
    if (!removed) {
      removed = true;
      afterFirstRemoval?.();
    }
  }
}

function removeOwnedRecoveryStagingPair(
  stagedPath: string,
  ownerPath: string,
  targetPath: string,
  registeredRoot: string,
  canonicalRoot: string,
  cleanupDirectory: string,
  expectedLinkCount = 2,
  beforeIsolation?: () => void,
  afterFirstIsolation?: () => void,
  afterFirstCleanupRemoval?: () => void
): void {
  verifiedBlobRecoveryCleanupDirectory(
    stagedPath,
    registeredRoot,
    canonicalRoot,
    true
  );
  reconcileOwnedRecoveryCleanupPair(
    stagedPath,
    ownerPath,
    targetPath,
    cleanupDirectory,
    registeredRoot
  );
  if (!existsSync(stagedPath) && !existsSync(ownerPath)) return;
  const owned = assertOwnedRecoveryStagingFile(
    stagedPath,
    ownerPath,
    registeredRoot,
    canonicalRoot,
    expectedLinkCount
  );
  if (!owned) throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  if (!sameResolvedPath(resolve(realpathSync(cleanupDirectory)), cleanupDirectory)
    || !isPathInside(cleanupDirectory, registeredRoot)
    || hasExistingSymlinkAncestor(cleanupDirectory, registeredRoot)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  const { stagedCleanup, ownerCleanup } = verifiedBlobRecoveryCleanupPaths(
    stagedPath,
    cleanupDirectory,
    registeredRoot
  );
  if (existsSync(stagedCleanup) || existsSync(ownerCleanup)) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  beforeIsolation?.();
  renameSync(stagedPath, stagedCleanup);
  const movedStage = lstatSync(stagedCleanup);
  if (movedStage.isSymbolicLink() || !movedStage.isFile()
    || movedStage.dev !== owned.dev || movedStage.ino !== owned.ino
    || movedStage.nlink !== expectedLinkCount) {
    if (!existsSync(stagedPath)) {
      try { renameSync(stagedCleanup, stagedPath); } catch { /* preserve the isolated entry on restore failure */ }
    }
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  afterFirstIsolation?.();
  renameSync(ownerPath, ownerCleanup);
  const movedOwner = lstatSync(ownerCleanup);
  if (movedOwner.isSymbolicLink() || !movedOwner.isFile()
    || movedOwner.dev !== owned.dev || movedOwner.ino !== owned.ino
    || movedOwner.nlink !== expectedLinkCount) {
    if (!existsSync(ownerPath)) {
      try { renameSync(ownerCleanup, ownerPath); } catch { /* preserve the isolated entry on restore failure */ }
    }
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  reconcileOwnedRecoveryCleanupPair(
    stagedPath,
    ownerPath,
    targetPath,
    cleanupDirectory,
    registeredRoot,
    "",
    afterFirstCleanupRemoval
  );
}

function placeOwnedRecoveryStagingFile(
  stagedPath: string,
  ownerPath: string,
  targetPath: string,
  registeredRoot: string,
  canonicalRoot: string,
  cleanupDirectory: string,
  beforeIsolation?: () => void,
  afterFirstIsolation?: () => void,
  afterFirstCleanupRemoval?: () => void
): void {
  const stagedIdentity = assertOwnedRecoveryStagingFile(
    stagedPath,
    ownerPath,
    registeredRoot,
    canonicalRoot
  );
  if (!stagedIdentity) throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  try {
    linkSync(stagedPath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("MEDIA_BLOB_RECOVERY_FAILED");
    }
    throw error;
  }
  const targetIdentity = lstatSync(targetPath);
  if (targetIdentity.isSymbolicLink() || !targetIdentity.isFile()
    || targetIdentity.nlink !== 3
    || targetIdentity.dev !== stagedIdentity.dev
    || targetIdentity.ino !== stagedIdentity.ino) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
  removeOwnedRecoveryStagingPair(
    stagedPath,
    ownerPath,
    targetPath,
    registeredRoot,
    canonicalRoot,
    cleanupDirectory,
    3,
    beforeIsolation,
    afterFirstIsolation,
    afterFirstCleanupRemoval
  );
  const placedIdentity = lstatSync(targetPath);
  if (placedIdentity.isSymbolicLink() || !placedIdentity.isFile()
    || placedIdentity.nlink !== 1
    || placedIdentity.dev !== stagedIdentity.dev
    || placedIdentity.ino !== stagedIdentity.ino) {
    throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
  }
}

/**
 * Repairs only the physical bytes represented by an existing immutable verified
 * MediaBlob. The caller must be the explicit Workbench provider-output recovery
 * branch; ordinary registration and download paths never call this function.
 */
export function recoverVerifiedBlobStorage(
  input: VerifiedBlobStorageRecoveryInput,
  db: M0Database,
  faults: VerifiedBlobStorageRecoveryFaults = {}
): VerifiedBlobStorageRecoveryResult {
  if (databaseIsInTransaction(db)) {
    return { ok: false, error: verifiedBlobRecoveryError("MEDIA_BLOB_RECOVERY_FAILED") };
  }

  let transactionOpen = false;
  let registeredRoot = "";
  let targetPath = "";
  let stagedPath = "";
  let stagedOwnerPath = "";
  let quarantinePath = "";
  let recoveryCleanupDirectory = "";
  let replacementPlaced = false;
  let originalQuarantined = false;
  let filesystemRecoveryStarted = false;
  let targetMutex: VerifiedBlobRecoveryTargetMutex | null = null;
  let originalCondition: "MISSING_BYTES" | "CONTENT_DRIFT" | "ALREADY_REUSABLE" = "MISSING_BYTES";

  try {
    const preflight = readVerifiedBlobRecoveryBinding(input, db);
    const preflightPaths = preflight.recoveryPaths;
    let activation: ReturnType<typeof activationRoots>;
    try { activation = ensureSafeActivationRoots(preflightPaths.registeredRoot, true); }
    catch { throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE"); }
    const preflightStagedPath = verifiedBlobRecoveryStagingPathForTarget(
      preflightPaths.targetPath,
      activation,
      preflightPaths.registeredRoot
    );
    const preflightStagedOwnerPath = verifiedBlobRecoveryStageOwnerPath(
      preflightStagedPath,
      preflightPaths.registeredRoot
    );
    const lockPath = verifiedBlobRecoveryTargetMutexPath(preflightPaths, activation, preflightStagedPath);
    const ownershipPath = verifiedBlobRecoveryStageOwnershipStorePath(
      preflightStagedPath,
      preflightPaths,
      activation
    );
    const requestedBusyTimeout = faults.target_mutex_busy_timeout_ms;
    const busyTimeoutMs = Number.isInteger(requestedBusyTimeout)
      && Number(requestedBusyTimeout) > 0
      && Number(requestedBusyTimeout) <= BLOB_RECOVERY_TARGET_MUTEX_BUSY_TIMEOUT_MS
      ? Number(requestedBusyTimeout)
      : BLOB_RECOVERY_TARGET_MUTEX_BUSY_TIMEOUT_MS;
    targetMutex = acquireVerifiedBlobRecoveryTargetMutex(
      lockPath,
      ownershipPath,
      preflightPaths,
      activation,
      busyTimeoutMs,
      faults
    );
    faults.after_target_mutex_acquired?.();
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const binding = readVerifiedBlobRecoveryBinding(input, db);
    if (binding.identity !== preflight.identity) {
      throw new Error("MEDIA_BLOB_RECOVERY_BINDING_MISMATCH");
    }
    const { artifact, blob, recoveryPaths } = binding;
    registeredRoot = recoveryPaths.registeredRoot;
    targetPath = recoveryPaths.targetPath;
    const sourcePath = resolve(input.source_path);
    if (sameResolvedPath(sourcePath, targetPath)) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    assertRecoveryRegularFile(sourcePath, registeredRoot, recoveryPaths.canonicalRoot);

    let sourceFacts: LocalMediaFacts;
    try {
      sourceFacts = localMediaFacts(sourcePath, artifact);
    } catch {
      throw new Error("MEDIA_BLOB_RECOVERY_CONTENT_MISMATCH");
    }
    if (sourceFacts.sha256 !== blob.sha256
      || sourceFacts.size_bytes !== blob.size_bytes
      || sourceFacts.detected_mime !== blob.detected_mime
      || sourceFacts.detected_mime !== "video/mp4") {
      throw new Error("MEDIA_BLOB_RECOVERY_CONTENT_MISMATCH");
    }
    try { activation = ensureSafeActivationRoots(registeredRoot, false); }
    catch { throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE"); }
    stagedPath = verifiedBlobRecoveryStagingPathForTarget(
      recoveryPaths.targetPath,
      activation,
      registeredRoot
    );
    stagedOwnerPath = verifiedBlobRecoveryStageOwnerPath(stagedPath, registeredRoot);
    recoveryCleanupDirectory = verifiedBlobRecoveryCleanupDirectory(
      stagedPath,
      registeredRoot,
      recoveryPaths.canonicalRoot,
      false
    );
    if (!sameResolvedPath(stagedPath, preflightStagedPath)
      || !sameResolvedPath(stagedOwnerPath, preflightStagedOwnerPath)
      || !sameResolvedPath(
        lockPath,
        verifiedBlobRecoveryTargetMutexPath(recoveryPaths, activation, stagedPath)
      )
      || !sameResolvedPath(
        ownershipPath,
        verifiedBlobRecoveryStageOwnershipStorePath(stagedPath, recoveryPaths, activation)
      )) {
      throw new Error("MEDIA_BLOB_RECOVERY_BINDING_MISMATCH");
    }
    reconcileOwnedRecoveryCleanupPair(
      stagedPath,
      stagedOwnerPath,
      recoveryPaths.targetPath,
      recoveryCleanupDirectory,
      registeredRoot,
      sourcePath
    );
    validateVerifiedBlobRecoveryEntriesBeforeAuthority(
      recoveryPaths,
      stagedPath,
      stagedOwnerPath,
      sourcePath,
      activation,
      artifact,
      blob,
      targetMutex
    );

    // A DOS 8.3 binding is safe for read-only reuse while the physical target
    // exists, but quarantine would make that immutable alias unresolvable on
    // retry. Reject drift before publishing authority or moving recovery media.
    if (recoveryPaths.registeredTargetUsesDosAlias && existsSync(targetPath)) {
      const currentFacts = hashLocalFile(targetPath);
      if (currentFacts.sha256 !== blob.sha256
        || currentFacts.size_bytes !== blob.size_bytes
        || detectMimeFromBytes(currentFacts.header) !== blob.detected_mime) {
        throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      }
    }

    ensureVerifiedBlobRecoveryTargetAuthority(recoveryPaths, blob, faults, targetMutex);
    filesystemRecoveryStarted = true;

    if (existsSync(targetPath)) {
      normalizeInterruptedVerifiedBlobPlacement(
        targetPath,
        recoveryPaths.targetDirectory,
        stagedPath,
        stagedOwnerPath,
        activation,
        registeredRoot,
        recoveryPaths.canonicalRoot,
        faults.after_interrupted_placement_link_removed
      );
    }
    reconcileLegacyVerifiedBlobRecoveryStaging(
      recoveryPaths.targetDirectory,
      targetPath,
      registeredRoot,
      recoveryPaths.canonicalRoot,
      artifact,
      blob,
      "",
      sourcePath
    );

    if (existsSync(targetPath)) {
      assertRecoveryRegularFile(targetPath, registeredRoot, recoveryPaths.canonicalRoot);
      const currentFacts = hashLocalFile(targetPath);
      originalCondition = currentFacts.sha256 === blob.sha256
        && currentFacts.size_bytes === blob.size_bytes
        && detectMimeFromBytes(currentFacts.header) === blob.detected_mime
        ? "ALREADY_REUSABLE"
        : "CONTENT_DRIFT";
    } else {
      originalCondition = "MISSING_BYTES";
    }

    if (originalCondition === "ALREADY_REUSABLE") {
      if (existsSync(stagedPath)) {
        const stageOwnership = readVerifiedBlobRecoveryStageOwnership(targetMutex, stagedPath, blob);
        assertVerifiedBlobRecoveryStageOwnership(stageOwnership, stagedPath, stagedOwnerPath, blob);
        assertExpectedRecoveryStagingFile(
          stagedPath,
          stagedPath,
          activation,
          registeredRoot,
          recoveryPaths.canonicalRoot,
          2
        );
        removeOwnedRecoveryStagingPair(
          stagedPath,
          stagedOwnerPath,
          targetPath,
          registeredRoot,
          recoveryPaths.canonicalRoot,
          recoveryCleanupDirectory,
          2,
          faults.before_staging_pair_isolated,
          faults.after_staging_entry_isolated,
          faults.after_staging_cleanup_entry_removed
        );
      } else if (existsSync(stagedOwnerPath)) {
        throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
      }
      if (!verifiedBlobStorageIsReusable(blob)) throw new Error("MEDIA_BLOB_RECOVERY_FAILED");
      db.exec("COMMIT");
      transactionOpen = false;
      return {
        ok: true,
        blob,
        outcome: "ALREADY_REUSABLE",
        corrupt_bytes_quarantined: false
      };
    }

    quarantinePath = resolve(activation.quarantine, `blob-recovery-${randomUUID()}.corrupt`);
    if (!isPathInside(quarantinePath, activation.quarantine)
      || hasExistingSymlinkAncestor(quarantinePath, registeredRoot)) {
      throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
    }
    prepareVerifiedBlobRecoveryStaging(
      sourcePath,
      stagedPath,
      stagedOwnerPath,
      artifact,
      blob,
      activation,
      registeredRoot,
      recoveryPaths.canonicalRoot,
      recoveryCleanupDirectory,
      targetMutex,
      faults
    );
    faults.after_staged_copy?.();

    if (originalCondition === "CONTENT_DRIFT") {
      assertRecoveryRegularFile(targetPath, registeredRoot, recoveryPaths.canonicalRoot);
      if (existsSync(quarantinePath)) throw new Error("MEDIA_BLOB_RECOVERY_FAILED");
      renameSync(targetPath, quarantinePath);
      originalQuarantined = true;
      faults.after_corrupt_quarantined?.();
    } else if (existsSync(targetPath)) {
      throw new Error("MEDIA_BLOB_RECOVERY_FAILED");
    }

    const stageOwnership = readVerifiedBlobRecoveryStageOwnership(targetMutex, stagedPath, blob);
    assertVerifiedBlobRecoveryStageOwnership(stageOwnership, stagedPath, stagedOwnerPath, blob);
    placeOwnedRecoveryStagingFile(
      stagedPath,
      stagedOwnerPath,
      targetPath,
      registeredRoot,
      recoveryPaths.canonicalRoot,
      recoveryCleanupDirectory,
      faults.before_staging_pair_isolated,
      faults.after_staging_entry_isolated,
      faults.after_staging_cleanup_entry_removed
    );
    stagedPath = "";
    stagedOwnerPath = "";
    replacementPlaced = true;
    faults.after_replacement_placed?.();
    faults.before_final_verification?.();

    assertRecoveryRegularFile(targetPath, registeredRoot, recoveryPaths.canonicalRoot);
    const finalFacts = localMediaFacts(targetPath, artifact);
    if (finalFacts.sha256 !== blob.sha256
      || finalFacts.size_bytes !== blob.size_bytes
      || finalFacts.detected_mime !== blob.detected_mime
      || !verifiedBlobStorageIsReusable(blob)) {
      throw new Error("MEDIA_BLOB_RECOVERY_FAILED");
    }

    db.exec("COMMIT");
    transactionOpen = false;
    return {
      ok: true,
      blob,
      outcome: originalCondition,
      corrupt_bytes_quarantined: originalQuarantined
    };
  } catch (error) {
    const rollbackDiscardPath = targetPath
      ? resolve(dirname(targetPath), `blob-recovery-${randomUUID()}.rollback`)
      : "";
    let replacementMovedAside = false;
    if (filesystemRecoveryStarted && replacementPlaced && targetPath && registeredRoot && existsSync(targetPath)) {
      try {
        const rootCanonical = resolve(realpathSync(registeredRoot));
        assertRecoveryRegularFile(targetPath, registeredRoot, rootCanonical);
        renameSync(targetPath, rollbackDiscardPath);
        replacementMovedAside = true;
        replacementPlaced = false;
      } catch {
        // Leave the verified replacement in place rather than delete or overwrite an unverified path.
      }
    }
    if (filesystemRecoveryStarted && originalQuarantined && quarantinePath && targetPath && !existsSync(targetPath) && existsSync(quarantinePath)) {
      try {
        renameSync(quarantinePath, targetPath);
        originalQuarantined = false;
      } catch {
        if (replacementMovedAside && rollbackDiscardPath && !existsSync(targetPath) && existsSync(rollbackDiscardPath)) {
          try {
            renameSync(rollbackDiscardPath, targetPath);
            replacementMovedAside = false;
          } catch {
            // A subsequent explicit recovery will fail closed until the exact target can be repaired.
          }
        }
      }
    }
    if (filesystemRecoveryStarted && replacementMovedAside && rollbackDiscardPath) {
      try { removeGeneratedRecoveryFile(rollbackDiscardPath, dirname(targetPath), registeredRoot); } catch { /* generated cleanup is retryable */ }
    }
    if (filesystemRecoveryStarted && stagedPath && stagedOwnerPath) {
      try {
        if (!targetMutex) throw new Error("MEDIA_BLOB_RECOVERY_PATH_UNSAFE");
        const cleanupOwnership = readVerifiedBlobRecoveryStageOwnership(
          targetMutex,
          stagedPath,
          readVerifiedBlobRecoveryBinding(input, db).blob
        );
        assertVerifiedBlobRecoveryStageOwnership(
          cleanupOwnership,
          stagedPath,
          stagedOwnerPath
        );
        removeOwnedRecoveryStagingPair(
          stagedPath,
          stagedOwnerPath,
          targetPath,
          registeredRoot,
          resolve(realpathSync(registeredRoot)),
          recoveryCleanupDirectory
        );
      } catch { /* owned generated cleanup is retryable */ }
    }
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original stable recovery failure */ }
    }
    return { ok: false, error: verifiedBlobRecoveryError(error) };
  } finally {
    releaseVerifiedBlobRecoveryTargetMutex(targetMutex);
  }
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

function moveActivationFileExclusively(sourcePath: string, finalPath: string, afterLinked?: () => void): void {
  try {
    linkSync(sourcePath, finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("MEDIA_ACTIVATION_FINAL_PATH_EXISTS");
    throw error;
  }
  try {
    if (afterLinked) afterLinked();
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
      final_path_owned: false,
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
    moveActivationFileExclusively(pendingPath, finalPath, () => {
      marker.final_path_owned = true;
      writeActivationMarker(marker);
    });
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
  let roots: ReturnType<typeof activationRoots>;
  try { roots = ensureSafeActivationRoots(mediaRoot, false); }
  catch { throw new Error("MEDIA_STAGING_OWNER_INVALID"); }
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
    || typeof marker.final_path_owned !== "boolean"
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
    const finalPath = resolve(marker.final_path);
    const pendingPath = resolve(marker.pending_path);
    const stagingPath = resolve(marker.staging_path);
    const linkedFinalOwned = samePhysicalFile(pendingPath, finalPath);
    const ownedCandidates = marker.final_path_owned || linkedFinalOwned
      ? [finalPath, pendingPath, stagingPath]
      : [pendingPath, stagingPath];
    try {
      quarantineActivationFile(artifact, ownedCandidates, resolve(marker.media_root));
      for (const candidate of [pendingPath, stagingPath]) {
        if (existsSync(candidate) && !lstatSync(candidate).isSymbolicLink() && statSync(candidate).isFile()) rmSync(candidate, { force: true });
      }
    } catch { /* retain stable failed evidence even when no file can be moved */ }
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
      const roots = ensureSafeActivationRoots(mediaRoot, false);
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
        try {
          ensureSafeActivationRoots(mediaRoot, false);
          quarantineActivationFile(artifact, ownedCandidates, mediaRoot);
        } catch { /* retain failure evidence in the journal without touching an unsafe root */ }
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

export interface ArtifactReferenceRequirement {
  artifact_id: string;
  project_id: string;
  shot_id: string;
  role: ArtifactRole;
  artifact_type: ArtifactType;
}

export type ActiveArtifactReferenceResult =
  | { ok: true; artifact: MediaArtifact; blob: MediaBlob }
  | { ok: false; error: ToolError };

export function validateActiveArtifactReference(
  db: M0Database,
  expected: ArtifactReferenceRequirement
): ActiveArtifactReferenceResult {
  let artifact: MediaArtifact | null;
  try {
    artifact = getMediaArtifact(db, expected.artifact_id);
  } catch (error) {
    if (error instanceof ArtifactStructuredDriftError) {
      return { ok: false, error: { code: error.code, message: "Artifact structured columns and JSON projection do not match." } };
    }
    return { ok: false, error: { code: "ARTIFACT_REFERENCE_CHECK_FAILED", message: "Artifact reference could not be verified." } };
  }
  if (!artifact) return { ok: false, error: { code: "ARTIFACT_NOT_FOUND", message: `Artifact not found: ${expected.artifact_id}` } };
  if (artifact.artifact_id !== expected.artifact_id
    || artifact.linked_objects.project_id !== expected.project_id
    || artifact.linked_objects.shot_id !== expected.shot_id) {
    return { ok: false, error: { code: "ARTIFACT_REFERENCE_BINDING_MISMATCH", message: "Artifact does not match the expected project and SHOT binding." } };
  }
  if (artifact.role !== expected.role || artifact.artifact_type !== expected.artifact_type) {
    return { ok: false, error: { code: "ARTIFACT_REFERENCE_ROLE_MISMATCH", message: "Artifact role or type does not match the workflow reference." } };
  }
  if (artifact.status !== "active") {
    return { ok: false, error: { code: "ARTIFACT_REFERENCE_INACTIVE", message: `Artifact is not active: ${artifact.status}` } };
  }
  const verified = verifyMediaArtifactBytes(db, artifact);
  if (!verified.ok) return verified;
  return { ok: true, artifact, blob: verified.blob };
}

export function validateAcceptedClipReference(
  db: M0Database,
  shot: Pick<Shot, "project_id" | "shot_id" | "accepted_clip_artifact_id" | "clip_versions">
): ActiveArtifactReferenceResult {
  if (!shot.accepted_clip_artifact_id) {
    return { ok: false, error: { code: "SHOT_ACCEPTED_CLIP_MISSING", message: "SHOT has no accepted clip reference." } };
  }
  if (!shot.clip_versions.some((version) => version.artifact_id === shot.accepted_clip_artifact_id)) {
    return { ok: false, error: { code: "ARTIFACT_NOT_IN_SHOT_REVIEW", message: "Accepted clip is not a reviewed version of the SHOT." } };
  }
  return validateActiveArtifactReference(db, {
    artifact_id: shot.accepted_clip_artifact_id,
    project_id: shot.project_id,
    shot_id: shot.shot_id,
    role: "generated_clip",
    artifact_type: "video"
  });
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
  const sourceIntegrity = verifyMediaArtifactBytes(db, source);
  if (!sourceIntegrity.ok) return sourceIntegrity;
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
    const expectedRole: ArtifactRole = input.reference === "storyboard_image_artifact_id" ? "storyboard_image" : "generated_clip";
    const expectedType: ArtifactType = input.reference === "storyboard_image_artifact_id" ? "image" : "video";
    const validated = validateActiveArtifactReference(db, {
      artifact_id: input.artifact_id,
      project_id: input.project_id,
      shot_id: input.shot_id,
      role: expectedRole,
      artifact_type: expectedType
    });
    if (!validated.ok) {
      if (manageTransaction) db.exec("ROLLBACK");
      if (!["ARTIFACT_NOT_FOUND", "ARTIFACT_REFERENCE_BINDING_MISMATCH", "ARTIFACT_REFERENCE_ROLE_MISMATCH", "ARTIFACT_REFERENCE_INACTIVE"].includes(validated.error.code)) {
        return { ok: false, error: validated.error };
      }
      return { ok: false, error: { code: "INVALID_ARTIFACT_BINDING", message: "Artifact must be active, verified, and scoped to the target project and SHOT." } };
    }
    const artifact = validated.artifact;
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
