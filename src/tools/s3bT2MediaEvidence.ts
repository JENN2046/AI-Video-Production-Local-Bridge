import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { validateImageBuffer, validateImageBufferDecoded } from "./imageValidity.js";
import { resolvedPathsEquivalent } from "./pathEquivalence.js";
import type {
  GovernedMediaEvidence,
  GovernedMediaRootEvidence,
  T2NormalizedArtifact,
  T2NormalizedSnapshot
} from "./s3bT2Types.js";

export type T2MediaEvidenceBundle = {
  media_root: GovernedMediaRootEvidence;
  media_root_evidence_digest: string;
  referenced: Map<string, GovernedMediaEvidence>;
  referenced_media_evidence: readonly GovernedMediaEvidence[];
};

const MAX_MEDIA_BYTES = 512 * 1024 * 1024;

function digest(value: unknown): string {
  return createHash("sha256").update("t2-governed-media-v2\0").update(JSON.stringify(value)).digest("hex");
}

function pathDigest(path: string): string {
  return createHash("sha256").update("t2-path\0").update(path).digest("hex");
}

function inside(child: string, parent: string): boolean {
  const relation = relative(resolve(parent), resolve(child));
  return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
}

function hasSymlinkAncestor(path: string, root: string): boolean {
  if (!inside(path, root)) return true;
  let current = resolve(root);
  const parts = relative(current, resolve(path)).split(/[\\/]+/u).filter(Boolean);
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function invalidRoot(failureClass: string, root = ""): GovernedMediaRootEvidence {
  return { status: "INVALID", fingerprint_digest: digest({ failure_class: failureClass, root: pathDigest(root) }), failure_class: failureClass };
}

type RootInspection = { evidence: GovernedMediaRootEvidence; root_path: string; real_path: string };

function inspectRoot(mediaRoot: string): RootInspection {
  const root = resolve(mediaRoot);
  try {
    const entry = lstatSync(root);
    if (entry.isSymbolicLink()) return { evidence: invalidRoot("MEDIA_ROOT_SYMLINK", root), root_path: root, real_path: root };
    if (!entry.isDirectory()) return { evidence: invalidRoot("MEDIA_ROOT_NOT_DIRECTORY", root), root_path: root, real_path: root };
    const real = resolve(realpathSync(root));
    if (!resolvedPathsEquivalent(real, root)) return { evidence: invalidRoot("MEDIA_ROOT_REALPATH_MISMATCH", root), root_path: root, real_path: real };
    const current = statSync(root);
    if (!current.isDirectory()) return { evidence: invalidRoot("MEDIA_ROOT_NOT_DIRECTORY", root), root_path: root, real_path: real };
    return { evidence: {
        status: "VALID",
        fingerprint_digest: digest({ root: pathDigest(root), real: pathDigest(real), dev: current.dev, ino: current.ino, nlink: current.nlink }),
        authority: { dev: current.dev, ino: current.ino, nlink: current.nlink }
      }, root_path: root, real_path: real };
  } catch {
    return { evidence: invalidRoot("MEDIA_ROOT_IO", root), root_path: root, real_path: root };
  }
}

function invalidMedia(artifactId: string, failureClass: string, identity: Record<string, unknown> = {}): GovernedMediaEvidence {
  return { status: "INVALID", artifact_id: artifactId, failure_class: failureClass, fingerprint_digest: digest({ artifact: artifactId, failure_class: failureClass, ...identity }) };
}

function validMedia(artifactId: string, facts: { dev: number; ino: number; nlink: number; raw_sha256: string; size_bytes: number; detected_mime: string }): GovernedMediaEvidence {
  return {
    status: "VALID",
    artifact_id: artifactId,
    fingerprint_digest: digest({ artifact: artifactId, dev: facts.dev, ino: facts.ino, nlink: facts.nlink, raw_sha256: facts.raw_sha256 }),
    raw_sha256: facts.raw_sha256,
    size_bytes: facts.size_bytes,
    detected_mime: facts.detected_mime,
    decoded: true
  };
}

function sameIdentity(left: { dev: number; ino: number; nlink: number }, right: { dev: number; ino: number; nlink: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;
}

function readAuthoritativeImage(artifact: T2NormalizedArtifact, snapshot: T2NormalizedSnapshot, root: RootInspection & { evidence: Extract<GovernedMediaRootEvidence, { status: "VALID" }> }): GovernedMediaEvidence {
  const blob = snapshot.blobs.get(artifact.blob_id);
  const artifactId = artifact.artifact_id;
  if (!blob || blob.integrity_state !== "verified") return invalidMedia(artifactId, "MEDIA_BLOB_NOT_VERIFIED");
  if (!isAbsolute(blob.storage_uri) || !isAbsolute(artifact.storage.uri) || !resolvedPathsEquivalent(artifact.storage.uri, blob.storage_uri)) return invalidMedia(artifactId, "MEDIA_STORAGE_BINDING_MISMATCH");
  if (!isAbsolute(blob.media_root) || !resolvedPathsEquivalent(blob.media_root, root.root_path)) return invalidMedia(artifactId, "MEDIA_ROOT_BINDING_MISMATCH", { registered_root: pathDigest(blob.media_root) });
  const target = resolve(blob.storage_uri);
  if (!inside(target, root.root_path)) return invalidMedia(artifactId, "MEDIA_PATH_OUTSIDE_ROOT", { target: pathDigest(target) });
  let descriptor = -1;
  try {
    const before = lstatSync(target);
    if (before.isSymbolicLink()) return invalidMedia(artifactId, "MEDIA_SYMLINK_ENTITY", { dev: before.dev, ino: before.ino, nlink: before.nlink });
    if (hasSymlinkAncestor(target, root.root_path)) return invalidMedia(artifactId, "MEDIA_SYMLINK_ANCESTOR", { dev: before.dev, ino: before.ino, nlink: before.nlink });
    if (!before.isFile()) return invalidMedia(artifactId, "MEDIA_NOT_REGULAR_FILE", { dev: before.dev, ino: before.ino, nlink: before.nlink });
    if (before.nlink !== 1) return invalidMedia(artifactId, "MEDIA_HARDLINK_REJECTED", { dev: before.dev, ino: before.ino, nlink: before.nlink });
    const realTarget = resolve(realpathSync(target));
    if (!inside(realTarget, root.real_path)) return invalidMedia(artifactId, "MEDIA_REALPATH_OUTSIDE_ROOT", { dev: before.dev, ino: before.ino, nlink: before.nlink });
    const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    descriptor = openSync(target, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!sameIdentity(before, opened) || opened.nlink !== 1) return invalidMedia(artifactId, "MEDIA_IDENTITY_DRIFT", { dev: opened.dev, ino: opened.ino, nlink: opened.nlink });
    if (opened.size <= 0 || opened.size > MAX_MEDIA_BYTES) return invalidMedia(artifactId, "MEDIA_SIZE_INVALID", { dev: opened.dev, ino: opened.ino, nlink: opened.nlink });
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) return invalidMedia(artifactId, "MEDIA_READ_FAILED", { dev: opened.dev, ino: opened.ino, nlink: opened.nlink });
      offset += read;
    }
    const afterRead = fstatSync(descriptor);
    const afterPath = lstatSync(target);
    const currentRootEntry = lstatSync(root.root_path);
    if (currentRootEntry.isSymbolicLink()) return invalidMedia(artifactId, "MEDIA_ROOT_IDENTITY_DRIFT", { dev: currentRootEntry.dev, ino: currentRootEntry.ino, nlink: currentRootEntry.nlink });
    const currentRoot = statSync(root.root_path);
    if (!sameIdentity(root.evidence.authority, currentRoot)) return invalidMedia(artifactId, "MEDIA_ROOT_IDENTITY_DRIFT", { dev: currentRoot.dev, ino: currentRoot.ino, nlink: currentRoot.nlink });
    if (!sameIdentity(before, afterRead) || !sameIdentity(before, afterPath) || afterRead.size !== bytes.length) return invalidMedia(artifactId, "MEDIA_IDENTITY_DRIFT", { dev: afterRead.dev, ino: afterRead.ino, nlink: afterRead.nlink });
    const structural = validateImageBuffer(bytes);
    if (!structural.ok) return invalidMedia(artifactId, "MEDIA_CONTENT_INVALID", { dev: opened.dev, ino: opened.ino, nlink: opened.nlink });
    const decoded = validateImageBufferDecoded(bytes);
    if (!decoded.ok) return invalidMedia(artifactId, "MEDIA_DECODE_FAILED", { dev: opened.dev, ino: opened.ino, nlink: opened.nlink });
    if (structural.sha256 !== blob.sha256 || structural.sha256 !== artifact.metadata.sha256 || structural.sha256 !== artifact.source.sha256
      || structural.sha256 !== blob.sha256 || structural.width <= 0 || structural.detected_mime !== blob.detected_mime
      || structural.detected_mime !== artifact.storage.mime_type || bytes.length !== blob.size_bytes) {
      return invalidMedia(artifactId, "MEDIA_CONTENT_MISMATCH", { dev: opened.dev, ino: opened.ino, nlink: opened.nlink, raw_sha256: structural.sha256 });
    }
    return validMedia(artifactId, { dev: opened.dev, ino: opened.ino, nlink: opened.nlink, raw_sha256: structural.sha256, size_bytes: bytes.length, detected_mime: structural.detected_mime });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    return invalidMedia(artifactId, code === "ELOOP" ? "MEDIA_SYMLINK_ENTITY" : "MEDIA_IO");
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

function collect(input: { snapshot: T2NormalizedSnapshot; mediaRoot: string }): T2MediaEvidenceBundle {
  const mediaRoot = inspectRoot(input.mediaRoot);
  const referenced = new Map<string, GovernedMediaEvidence>();
  const artifactIds = [...input.snapshot.shots.values()]
    .map((shot) => shot.storyboard_image_artifact_id)
    .filter((artifactId): artifactId is string => artifactId.length > 0);
  for (const artifactId of new Set(artifactIds)) {
    const artifact = input.snapshot.artifacts.get(artifactId);
    if (!artifact) {
      referenced.set(artifactId, invalidMedia(artifactId, "MEDIA_ARTIFACT_NOT_FOUND"));
    } else if (mediaRoot.evidence.status !== "VALID") {
      referenced.set(artifactId, invalidMedia(artifactId, "MEDIA_ROOT_INVALID"));
    } else {
      referenced.set(artifactId, readAuthoritativeImage(artifact, input.snapshot, mediaRoot as RootInspection & { evidence: Extract<GovernedMediaRootEvidence, { status: "VALID" }> }));
    }
  }
  const ordered = [...referenced.values()].sort((left, right) => left.fingerprint_digest.localeCompare(right.fingerprint_digest));
  return {
    media_root: mediaRoot.evidence,
    media_root_evidence_digest: mediaRoot.evidence.fingerprint_digest,
    referenced,
    referenced_media_evidence: ordered
  };
}

export function collectT2GovernedMediaEvidence(input: { snapshot: T2NormalizedSnapshot; mediaRoot: string }): T2MediaEvidenceBundle;
export function collectT2GovernedMediaEvidence(snapshot: T2NormalizedSnapshot, mediaRoot: string): T2MediaEvidenceBundle;
export function collectT2GovernedMediaEvidence(
  inputOrSnapshot: { snapshot: T2NormalizedSnapshot; mediaRoot: string } | T2NormalizedSnapshot,
  mediaRoot?: string
): T2MediaEvidenceBundle {
  return "snapshot" in inputOrSnapshot
    ? collect(inputOrSnapshot)
    : collect({ snapshot: inputOrSnapshot, mediaRoot: mediaRoot ?? "" });
}

export function createValidGovernedMediaEvidence(fingerprint: string): GovernedMediaEvidence {
  return { status: "VALID", fingerprint_digest: digest({ legacy: "valid", fingerprint }) };
}

export function createInvalidGovernedMediaEvidence(failureClass: string): GovernedMediaEvidence {
  return { status: "INVALID", fingerprint_digest: digest({ legacy: "invalid", failureClass }), failure_class: failureClass };
}
