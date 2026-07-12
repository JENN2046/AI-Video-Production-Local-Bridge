import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { ensureM0Directories, paths } from "../paths.js";
import { validateImageBuffer, validateImageFile, type ImageValidationResult } from "./imageValidity.js";
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

function databaseIsInTransaction(db: M0Database): boolean {
  return Boolean((db as unknown as { isTransaction?: boolean }).isTransaction);
}

function buildBlobForArtifact(artifact: MediaArtifact): MediaBlob {
  const uri = artifact.storage.uri;
  if (uri && !/^https?:\/\//i.test(uri) && existsSync(uri) && !lstatSync(uri).isSymbolicLink() && statSync(uri).isFile()) {
    const bytes = readFileSync(uri);
    const detectedMime = detectMimeFromBytes(bytes);
    const typeMatches = artifact.artifact_type === "image" ? detectedMime.startsWith("image/") : detectedMime === "video/mp4";
    if (bytes.length > 0 && typeMatches) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return {
        blob_id: `blob_sha256_${sha256}`,
        sha256,
        size_bytes: bytes.length,
        detected_mime: detectedMime,
        storage_uri: resolve(uri),
        integrity_state: "verified",
        provenance: { source: artifact.source.kind, immutable: true }
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

function persistMediaArtifactInternal(db: M0Database, artifact: MediaArtifact, allowStatusTransition: boolean): void {
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
      blob = persistBlob(db, buildBlobForArtifact(artifact));
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
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
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

  copyFileSync(sourcePath, destinationPath);
  readFileSync(destinationPath);

  if (input.artifact_type === "image") {
    const validation = validateImageFile(destinationPath);
    if (!validation.ok) {
      rmSync(destinationPath, { force: true });
      return { ok: false, error: imageValidationError(validation) };
    }
    return { ok: true, artifact: buildValidatedImageArtifact(input, artifactId, filename, destinationPath, validation) };
  }

  const artifact: MediaArtifact = {
    ...buildArtifact(input, "active", filename, destinationPath, mimeTypeFor(sourcePath, input.artifact_type)),
    artifact_id: artifactId
  };

  return { ok: true, artifact };
}

function writeUploadedBytes(input: RegisterMediaArtifactInput): RegisterMediaArtifactResult {
  if (input.source.kind !== "file_handle" && input.source.kind !== "app_upload") {
    throw new Error("writeUploadedBytes received unsupported source.");
  }

  const roleError = validateRole(input.artifact_type, input.role);
  if (roleError) return { ok: false, error: roleError };

  const unsafeName = input.source.filename;
  if (filenameHasPathTraversal(unsafeName)) {
    return { ok: false, error: { code: "STORAGE_PATH_NOT_ALLOWED", message: "Upload filename must not contain path traversal." } };
  }

  const artifactId = `artifact_${randomUUID()}`;
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
    writeFileSync(destinationPath, decoded);
    readFileSync(destinationPath);

    const storedValidation = validateImageFile(destinationPath);
    if (!storedValidation.ok) {
      rmSync(destinationPath, { force: true });
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
  writeFileSync(destinationPath, decoded);
  readFileSync(destinationPath);

  const artifact: MediaArtifact = {
    ...buildArtifact(input, "active", filename, destinationPath, input.source.mime_type),
    artifact_id: artifactId
  };
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

  copyFileSync(realSourcePath, destinationPath);
  const sha256 = sha256ForFile(destinationPath);

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

  copyFileSync(realSourcePath, destinationPath);
  readFileSync(destinationPath);

  const storedValidation = validateImageFile(destinationPath);
  if (!storedValidation.ok) {
    rmSync(destinationPath, { force: true });
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
    persistMediaArtifact(db, result.artifact);
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
    result = writeUploadedBytes(activationInput);
    if (result.ok) {
      result.artifact.artifact_id = existing.artifact_id;
    }
  } else {
    const uriValidation = validateAccessibleUri(input.source.uri);
    if (uriValidation.error) return { ok: false, error: uriValidation.error };
    return { ok: false, error: { code: "EXTERNAL_URI_DOWNLOAD_FAILED", message: "accessible_uri download is not implemented in M1-0." } };
  }

  if (!result.ok) return result;
  persistMediaArtifactInternal(db, result.artifact, true);
  return { ok: true, artifact: result.artifact };
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
