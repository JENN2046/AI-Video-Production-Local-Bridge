import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, realpathSync, readSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { assertSchemaCurrent } from "../storage/migrations.js";
import { openM0DatabaseConnection, type M0Database } from "../storage/sqlite.js";
import { paths, type M0Paths } from "../paths.js";
import { collectProjectOperationalBundles, OperationalStateIntegrityError } from "./operationalStateFacts.js";
import { ArtifactStructuredDriftError, getMediaArtifact, getMediaBlob, verifyMediaArtifactBytes, type MediaArtifact, type MediaBlob } from "./mediaArtifacts.js";
import { buildProviderCapabilityKey, RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY } from "./providerCapabilities.js";
import type { Project, Shot } from "./projects.js";
import type { ApprovedShotSnapshot, StoryboardPackage } from "./storyboardPackages.js";
import type { ShotOperationalState } from "../packages/domain/operationalState.js";

export const S3B_T2_REASON_CODES = [
  "REAL_GENERATION_ALREADY_ACTIVE",
  "PROJECT_NOT_PRODUCTION",
  "PROJECT_NOT_ACTIVE",
  "PROJECT_ALREADY_DELIVERED",
  "PROJECT_STATUS_INELIGIBLE",
  "PACKAGE_NOT_FOUND",
  "PACKAGE_PROJECT_MISMATCH",
  "PACKAGE_NOT_APPROVED",
  "SHOT_NOT_STORYBOARD_APPROVED",
  "SHOT_OPERATIONAL_STATE_INELIGIBLE",
  "GENERATION_ALREADY_STARTED",
  "STORYBOARD_APPROVAL_REQUIRED",
  "STORYBOARD_REVISION_REQUIRED",
  "STORYBOARD_IMAGE_MISSING",
  "STORYBOARD_ARTIFACT_INACTIVE",
  "STORYBOARD_ARTIFACT_BINDING_INVALID",
  "STORYBOARD_ARTIFACT_ROLE_INVALID",
  "PACKAGE_SNAPSHOT_MISMATCH",
  "STORYBOARD_ARTIFACT_INTEGRITY_INVALID",
  "STORYBOARD_IMAGE_MIME_UNSUPPORTED",
  "VIDEO_PROMPT_MISSING",
  "SHOT_DURATION_INVALID",
  "SHOT_STATE_INCONSISTENT",
  "GENERATION_MANUAL_RECONCILIATION",
  "GENERATION_FAILED",
  "SHOT_REVIEW_NOT_APPROVED",
  "ARTIFACT_NOT_IN_SHOT_REVIEW",
  "CLIP_REVISION_REQUIRED",
  "PROVIDER_CAPABILITY_NOT_FOUND",
  "PROVIDER_CAPABILITY_MODEL_MISMATCH",
  "PROVIDER_CAPABILITY_DURATION_UNSUPPORTED",
  "PROVIDER_CAPABILITY_RESOLUTION_UNSUPPORTED",
  "PROVIDER_CAPABILITY_ASPECT_RATIO_UNSUPPORTED"
] as const;

export type S3bT2ReasonCode = typeof S3B_T2_REASON_CODES[number];
export type S3bT2StableResult = "PASS_ONE_ELIGIBLE_SHOT" | "S3_NO_ELIGIBLE_SHOT" | "S3_MULTIPLE_ELIGIBLE_SHOTS" | "T2_STATE_CHANGED_DURING_SCAN" | "T2_READ_ONLY_BOUNDARY_VIOLATION";

export interface S3bT2Receipt {
  schema_version: "s3b-t2-eligibility-receipt-v1";
  result: S3bT2StableResult;
  eligible_candidate_count: number;
  candidate_alias?: string;
  package_match_mode?: "shot_id" | "order";
  artifact_verification_level?: "actual_bytes";
  mime_class?: "image";
  provider_capability?: { provider: "runninghub"; registry_only: true; result: "PASS" };
  reason_code_counts: Partial<Record<S3bT2ReasonCode, number>>;
  read_only_proof: {
    sqlite_total_changes: 0;
    network_calls: 0;
    credential_reads: 0;
    media_writes: 0;
  };
}

interface Candidate {
  project_id: string;
  shot_id: string;
  package_id: string;
  artifact_id: string;
  match_mode: "shot_id" | "order";
}

interface SnapshotResult {
  fingerprint: string;
  candidates: Candidate[];
  reasons: Partial<Record<S3bT2ReasonCode, number>>;
  sqlite: { total_changes_before: number; total_changes_after: number };
  boundary_violation?: boolean;
}

interface ProjectRow {
  project_id: string;
  data_json: string;
  classification: string;
  lifecycle: string;
}

export interface S3bT2ScanOptions {
  paths?: M0Paths;
  betweenSnapshots?: () => void | Promise<void>;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sameResolvedPath(first: string, second: string): boolean {
  const left = resolve(first);
  const right = resolve(second);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function hasSymlinkInPath(child: string, parent: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (!isInside(resolvedChild, resolvedParent)) return true;
  let current = resolvedParent;
  for (const part of relative(resolvedParent, resolvedChild).split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) return false;
    if (!lstatSync(current).isSymbolicLink()) continue;
    return true;
  }
  return false;
}

interface AuthoritativeMediaRoot {
  configured: string;
  canonical: string;
}

function resolveAuthoritativeMediaRoot(scanPaths: M0Paths): AuthoritativeMediaRoot | null {
  const configured = resolve(scanPaths.mediaRoot);
  try {
    const entry = lstatSync(configured);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return null;
    const canonical = resolve(realpathSync(configured));
    if (!sameResolvedPath(canonical, configured)) return null;
    return { configured, canonical };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseShotForT2(raw: string): { ok: true; shot: Partial<Shot> } | { ok: false } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ok: false };
    if (!Array.isArray(parsed.generation_run_ids)
      || !parsed.generation_run_ids.every((value): value is string => typeof value === "string")
      || !Array.isArray(parsed.clip_versions)
      || !parsed.clip_versions.every((value) => isRecord(value)
        && typeof value.artifact_id === "string"
        && typeof value.run_id === "string"
        && typeof value.attempt_number === "number"
        && Number.isInteger(value.attempt_number)
        && (value.review_status === "pending"
          || value.review_status === "approved"
          || value.review_status === "rejected"))) {
      return { ok: false };
    }
    return { ok: true, shot: parsed as Partial<Shot> };
  } catch {
    return { ok: false };
  }
}

function validateApprovedShotSnapshots(value: unknown): { ok: true; snapshots: ApprovedShotSnapshot[] } | { ok: false } {
  if (!Array.isArray(value)) return { ok: false };
  for (const snapshot of value) {
    if (!isRecord(snapshot)
      || typeof snapshot.order !== "number"
      || !Number.isFinite(snapshot.order)
      || (snapshot.shot_id !== undefined && typeof snapshot.shot_id !== "string")
      || typeof snapshot.duration_seconds !== "number"
      || !Number.isFinite(snapshot.duration_seconds)
      || typeof snapshot.storyboard_image_artifact_id !== "string"
      || snapshot.storyboard_image_artifact_id.length === 0
      || typeof snapshot.video_prompt !== "string"
      || (snapshot.negative_prompt !== undefined
        && snapshot.negative_prompt !== null
        && typeof snapshot.negative_prompt !== "string")) {
      return { ok: false };
    }
  }
  return { ok: true, snapshots: value as ApprovedShotSnapshot[] };
}

function isT2MediaArtifactShape(value: unknown): value is MediaArtifact {
  if (!isRecord(value)
    || typeof value.artifact_id !== "string"
    || typeof value.blob_id !== "string"
    || !isRecord(value.storage)
    || typeof value.storage.uri !== "string"
    || typeof value.storage.mime_type !== "string"
    || typeof value.storage.filename !== "string"
    || !isRecord(value.metadata)
    || !isRecord(value.linked_objects)
    || typeof value.linked_objects.project_id !== "string"
    || typeof value.linked_objects.shot_id !== "string"
    || !isRecord(value.source)) return false;
  return true;
}

function normalizeNegativePrompt(value: unknown): { ok: true; value: string } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: "" };
  if (typeof value === "string") return { ok: true, value };
  return { ok: false };
}

type MediaByteInspection =
  | { ok: true; blob: MediaBlob; actual_byte_digest: string }
  | { ok: false; code: "STORYBOARD_ARTIFACT_INTEGRITY_INVALID"; actual_byte_digest?: string };

function hashAuthoritativeMediaFile(filePath: string, root: AuthoritativeMediaRoot): string | null {
  const resolvedPath = resolve(filePath);
  if (!isInside(resolvedPath, root.configured) || hasSymlinkInPath(resolvedPath, root.configured)) return null;
  let descriptor: number;
  try {
    const entry = lstatSync(resolvedPath);
    if (entry.isSymbolicLink() || !entry.isFile()) return null;
    if (!isInside(resolve(realpathSync(resolvedPath)), root.canonical)) return null;
    descriptor = openSync(resolvedPath, "r");
  } catch {
    return null;
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) return null;
    const hash = createHash("sha256").update("s3b-t2-actual-media-bytes-v1\0");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    const after = fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.dev !== after.dev || before.ino !== after.ino) return null;
    if (!isInside(resolve(realpathSync(resolvedPath)), root.canonical)) return null;
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}

function inspectMediaArtifactBytes(
  db: M0Database,
  artifact: unknown,
  root: AuthoritativeMediaRoot | null
): MediaByteInspection {
  if (!root || !isT2MediaArtifactShape(artifact)) return { ok: false, code: "STORYBOARD_ARTIFACT_INTEGRITY_INVALID" };
  let blob: MediaBlob | null;
  try {
    blob = getMediaBlob(db, artifact.blob_id);
  } catch {
    return { ok: false, code: "STORYBOARD_ARTIFACT_INTEGRITY_INVALID" };
  }
  if (!blob || blob.integrity_state !== "verified" || !isRecord(blob.provenance) || typeof blob.provenance.media_root !== "string"
    || !isAbsolute(blob.provenance.media_root) || !sameResolvedPath(blob.provenance.media_root, root.configured)
    || !isAbsolute(blob.storage_uri) || !isAbsolute(artifact.storage.uri)
    || !sameResolvedPath(blob.storage_uri, artifact.storage.uri)) {
    return { ok: false, code: "STORYBOARD_ARTIFACT_INTEGRITY_INVALID" };
  }
  const resolvedStorage = resolve(blob.storage_uri);
  if (!isInside(resolvedStorage, root.configured) || hasSymlinkInPath(resolvedStorage, root.configured)) {
    return { ok: false, code: "STORYBOARD_ARTIFACT_INTEGRITY_INVALID" };
  }
  try {
    const entry = lstatSync(resolvedStorage);
    if (entry.isSymbolicLink() || !entry.isFile() || !isInside(resolve(realpathSync(resolvedStorage)), root.canonical)) {
      return { ok: false, code: "STORYBOARD_ARTIFACT_INTEGRITY_INVALID" };
    }
  } catch {
    return { ok: false, code: "STORYBOARD_ARTIFACT_INTEGRITY_INVALID" };
  }
  const actualByteDigest = hashAuthoritativeMediaFile(resolvedStorage, root);
  if (!actualByteDigest) return { ok: false, code: "STORYBOARD_ARTIFACT_INTEGRITY_INVALID" };
  return { ok: true, blob, actual_byte_digest: actualByteDigest };
}

function assertNoSymlinkPath(child: string, parent: string): void {
  let current = resolve(parent);
  if (lstatSync(current).isSymbolicLink()) throw new Error("T2_DATABASE_PATH_UNSAFE");
  for (const part of relative(current, resolve(child)).split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("T2_DATABASE_PATH_UNSAFE");
  }
}

function buildDatabasePathGuard(scanPaths: M0Paths): { assertPathCurrent: () => void; identity: string } {
  const expectedPath = resolve(scanPaths.sqlitePath);
  const expectedRoot = realpathSync(resolve(scanPaths.dataRoot));
  if (!isInside(expectedPath, expectedRoot)) throw new Error("T2_DATABASE_PATH_OUTSIDE_DATA_ROOT");
  assertNoSymlinkPath(expectedPath, expectedRoot);
  const initialLink = lstatSync(expectedPath);
  if (!initialLink.isFile() || initialLink.isSymbolicLink() || initialLink.nlink !== 1) throw new Error("T2_DATABASE_PATH_UNSAFE");
  const initialReal = realpathSync(expectedPath);
  if (!isInside(initialReal, expectedRoot)) throw new Error("T2_DATABASE_REALPATH_OUTSIDE_DATA_ROOT");
  const initial = statSync(initialReal, { bigint: true });
  const assertPathCurrent = () => {
    assertNoSymlinkPath(expectedPath, expectedRoot);
    const currentLink = lstatSync(expectedPath);
    if (!currentLink.isFile() || currentLink.isSymbolicLink() || currentLink.nlink !== 1) throw new Error("T2_DATABASE_PATH_UNSAFE");
    const currentReal = realpathSync(expectedPath);
    const current = statSync(currentReal, { bigint: true });
    if (currentReal !== initialReal || current.dev !== initial.dev || current.ino !== initial.ino || !isInside(currentReal, expectedRoot)) {
      throw new Error("T2_DATABASE_PATH_CHANGED");
    }
  };
  return { assertPathCurrent, identity: `${initial.dev}:${initial.ino}` };
}

function parseProjectForT2(row: ProjectRow): { ok: true; project: Project } | { ok: false } {
  try {
    const parsed: unknown = JSON.parse(row.data_json);
    if (!isRecord(parsed) || parsed.project_id !== row.project_id) return { ok: false };
    return { ok: true, project: parsed as unknown as Project };
  } catch {
    return { ok: false };
  }
}

function matchingSnapshot(snapshots: ApprovedShotSnapshot[], shot: Shot): { snapshot: ApprovedShotSnapshot; mode: Candidate["match_mode"] } | null | "ambiguous" {
  const matches = snapshots.filter((snapshot) =>
    snapshot.shot_id ? snapshot.shot_id === shot.shot_id : snapshot.order === shot.order
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) return "ambiguous";
  const snapshot = matches[0];
  return { snapshot, mode: snapshot.shot_id ? "shot_id" : "order" };
}

function addReason(reasons: SnapshotResult["reasons"], code: S3bT2ReasonCode): void {
  reasons[code] = (reasons[code] ?? 0) + 1;
}

function createCandidateAlias(): string {
  return `shot_${randomBytes(16).toString("hex")}`;
}

const CANONICAL_OPERATIONAL_REASON_CODES = new Set<S3bT2ReasonCode>([
  "STORYBOARD_APPROVAL_REQUIRED",
  "STORYBOARD_REVISION_REQUIRED",
  "STORYBOARD_IMAGE_MISSING",
  "STORYBOARD_ARTIFACT_INACTIVE",
  "STORYBOARD_ARTIFACT_BINDING_INVALID",
  "STORYBOARD_ARTIFACT_ROLE_INVALID",
  "STORYBOARD_ARTIFACT_INTEGRITY_INVALID",
  "VIDEO_PROMPT_MISSING",
  "SHOT_DURATION_INVALID",
  "SHOT_STATE_INCONSISTENT",
  "GENERATION_MANUAL_RECONCILIATION",
  "GENERATION_FAILED",
  "SHOT_REVIEW_NOT_APPROVED",
  "ARTIFACT_NOT_IN_SHOT_REVIEW",
  "CLIP_REVISION_REQUIRED"
]);

function addCanonicalOperationalReasons(
  reasons: SnapshotResult["reasons"],
  operational: ShotOperationalState
): boolean {
  const canonical = [
    ...operational.generation.reason_codes,
    ...operational.blocker_codes
  ].filter((code): code is S3bT2ReasonCode => CANONICAL_OPERATIONAL_REASON_CODES.has(code as S3bT2ReasonCode));
  for (const code of new Set(canonical)) addReason(reasons, code);
  return canonical.length > 0;
}

function domainSeparatedSha256(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

function canonicalizeSqlRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).sort(([left], [right]) => left.localeCompare(right))
  );
}

const SNAPSHOT_ROWSET_SPECS = [
  { table: "projects", orderBy: ["project_id"] },
  { table: "workbench_project_meta", orderBy: ["project_id"] },
  { table: "shots", orderBy: ["project_id", "shot_id"] },
  { table: "storyboard_packages", orderBy: ["project_id", "storyboard_package_id"] },
  { table: "media_artifacts", orderBy: ["project_id", "shot_id", "artifact_id"] },
  { table: "media_artifact_blobs", orderBy: ["artifact_id"] },
  { table: "media_blobs", orderBy: ["blob_id"] },
  { table: "generation_intents", orderBy: ["intent_id"] },
  { table: "generation_jobs", orderBy: ["job_id"] },
  { table: "generation_runs", orderBy: ["project_id", "shot_id", "run_id"] }
] as const;

function readSnapshotRowsets(db: M0Database): Array<{ table: string; row_count: number; rowset_digest: string }> {
  return SNAPSHOT_ROWSET_SPECS.map((spec) => {
    const rows = db.prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.orderBy.join(", ")}`).all() as Array<Record<string, unknown>>;
    const canonicalRows = rows.map(canonicalizeSqlRow);
    return {
      table: spec.table,
      row_count: canonicalRows.length,
      rowset_digest: domainSeparatedSha256(`s3b-t2-rowset-${spec.table}-v1`, canonicalRows)
    };
  });
}

function stableFingerprint(value: unknown): string {
  return domainSeparatedSha256("s3b-t2-snapshot-envelope-v1", value);
}

function totalChanges(db: M0Database): number {
  return Number((db.prepare("SELECT total_changes() AS count").get() as { count: number }).count);
}

function readSnapshot(scanPaths: M0Paths): SnapshotResult {
  const guard = buildDatabasePathGuard(scanPaths);
  const assertPathCurrent = guard.assertPathCurrent;
  const db = openM0DatabaseConnection(scanPaths.sqlitePath, { readOnly: true, assertPathCurrent });
  const reasons: SnapshotResult["reasons"] = {};
  try {
    db.exec("PRAGMA query_only = ON");
    const queryOnly = Number((db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only);
    if (queryOnly !== 1) throw new Error("T2_QUERY_ONLY_NOT_ENFORCED");
    assertSchemaCurrent(db);
    const before = totalChanges(db);
    db.exec("BEGIN");
    try {
      const activeIntentCount = Number((db.prepare("SELECT COUNT(*) AS count FROM generation_intents WHERE status IN ('queued','running')").get() as { count: number }).count);
      const rows = db.prepare(`
        SELECT p.project_id, p.data_json, m.classification, m.lifecycle
        FROM projects p JOIN workbench_project_meta m ON m.project_id = p.project_id
        ORDER BY p.project_id
      `).all() as ProjectRow[];
      const candidates: Candidate[] = [];
      const fingerprintFacts: unknown[] = [
        { database_identity: guard.identity, active_intent_count: activeIntentCount },
        { database_rowsets: readSnapshotRowsets(db) }
      ];
      const projectFacts = rows.map((projectRow) => ({
        project_id: projectRow.project_id,
        project_data_json: projectRow.data_json,
        classification: projectRow.classification,
        lifecycle: projectRow.lifecycle
      }));
      const projectDigests = projectFacts
        .map((facts) => createHash("sha256")
          .update("s3b-t2-project-fact-v1\0")
          .update(JSON.stringify(facts))
          .digest("hex"))
        .sort();
      fingerprintFacts.push({ project_count: projectDigests.length, project_digests: projectDigests });

      const shotRowsByProject = new Map<string, Array<{ shot_id: string; project_id: string; data_json: string }>>();
      const shotFacts: unknown[] = [];
      for (const projectRow of rows) {
        const shotRows = db.prepare("SELECT shot_id, project_id, data_json FROM shots WHERE project_id = ? ORDER BY rowid")
          .all(projectRow.project_id) as Array<{ shot_id: string; project_id: string; data_json: string }>;
        shotRowsByProject.set(projectRow.project_id, shotRows);
        for (const shotRow of shotRows) {
          shotFacts.push({ shot_id: shotRow.shot_id, project_id: shotRow.project_id, shot_data_json: shotRow.data_json });
        }
      }
      const shotDigests = shotFacts
        .map((facts) => createHash("sha256")
          .update("s3b-t2-shot-fact-v1\0")
          .update(JSON.stringify(facts))
          .digest("hex"))
        .sort();
      fingerprintFacts.push({ shot_count: shotDigests.length, shot_digests: shotDigests });

      const parsedProjects = rows.map(parseProjectForT2);
      const invalidProject = parsedProjects.some((result) => !result.ok);
      if (invalidProject) {
        fingerprintFacts.push({ project_parse_status: "invalid" });
        if (activeIntentCount > 0) addReason(reasons, "REAL_GENERATION_ALREADY_ACTIVE");
        db.exec("COMMIT");
        assertPathCurrent();
        const after = totalChanges(db);
        if (before !== 0 || after !== 0) throw new Error("T2_DATABASE_WRITE_DETECTED");
        return {
          fingerprint: stableFingerprint({ fingerprintFacts, candidates, reasons }),
          candidates,
          reasons,
          sqlite: { total_changes_before: before, total_changes_after: after },
          boundary_violation: activeIntentCount === 0
        };
      }
      const projects = parsedProjects.map((result) => {
        if (!result.ok) throw new Error("T2_PROJECT_FACT_INVALID");
        return result.project;
      });
      const authoritativeMediaRoot = resolveAuthoritativeMediaRoot(scanPaths);
      const generationHistoryByShot = new Set<string>();
      for (const row of db.prepare("SELECT project_id, shot_id FROM generation_runs WHERE shot_id IS NOT NULL").all() as Array<{ project_id: string; shot_id: string }>) {
        generationHistoryByShot.add(`${row.project_id}\u0000${row.shot_id}`);
      }
      for (const row of db.prepare(`
        SELECT intent.project_id, intent.shot_id
        FROM generation_jobs job
        JOIN generation_intents intent ON intent.intent_id = job.intent_id
        WHERE intent.shot_id IS NOT NULL
      `).all() as Array<{ project_id: string; shot_id: string }>) {
        generationHistoryByShot.add(`${row.project_id}\u0000${row.shot_id}`);
      }

      const storyboardReferenceFacts: unknown[] = [];
      let storyboardArtifactStructuredDriftCount = 0;
      let malformedShotCount = 0;
      for (const [index, project] of projects.entries()) {
        const row = rows[index];
        const shotRows = shotRowsByProject.get(project.project_id) ?? [];
        for (const shotRow of shotRows) {
          const parsedShot = parseShotForT2(shotRow.data_json);
          if (!parsedShot.ok) {
            malformedShotCount += 1;
            continue;
          }
          const shot = parsedShot.shot;
          const artifactId = shot.storyboard_image_artifact_id;
          if (typeof artifactId !== "string" || artifactId.length === 0) continue;
          const artifactRow = db.prepare(`
            SELECT a.artifact_id, a.project_id, a.shot_id, a.role, a.artifact_type, a.status, a.data_json,
              m.blob_id, b.sha256, b.size_bytes, b.detected_mime, b.storage_uri, b.integrity_state, b.provenance_json
            FROM media_artifacts a
            LEFT JOIN media_artifact_blobs m ON m.artifact_id = a.artifact_id
            LEFT JOIN media_blobs b ON b.blob_id = m.blob_id
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
            sha256: string | null;
            size_bytes: number | null;
            detected_mime: string | null;
            storage_uri: string | null;
            integrity_state: string | null;
            provenance_json: string | null;
          } | undefined;
          const blobFact = artifactRow
            ? {
              blob_id: artifactRow.blob_id,
              sha256: artifactRow.sha256,
              size_bytes: artifactRow.size_bytes,
              detected_mime: artifactRow.detected_mime,
              storage_uri: artifactRow.storage_uri,
              integrity_state: artifactRow.integrity_state,
              provenance_json: artifactRow.provenance_json
            }
            : null;
          const blobFactDigest = createHash("sha256")
            .update("s3b-t2-blob-fact-v1\0")
            .update(JSON.stringify(blobFact))
            .digest("hex");
          storyboardReferenceFacts.push({
            project_fact: { project_data_json: row.data_json, classification: row.classification, lifecycle: row.lifecycle },
            shot_fact: {
              shot_id: shotRow.shot_id,
              project_id: shotRow.project_id,
              shot_data_json: shotRow.data_json,
              storyboard_image_artifact_id: artifactId
            },
            artifact_fact: artifactRow
              ? {
                artifact_id: artifactRow.artifact_id,
                project_id: artifactRow.project_id,
                shot_id: artifactRow.shot_id,
                role: artifactRow.role,
                artifact_type: artifactRow.artifact_type,
                status: artifactRow.status,
                data_json: artifactRow.data_json,
                blob_id: artifactRow.blob_id,
                blob_fact_digest: blobFactDigest
              }
              : {
                artifact_id: artifactId,
                project_id: null,
                shot_id: null,
                role: null,
                artifact_type: null,
                status: null,
                data_json: null,
                blob_id: null,
                blob_fact_digest: blobFactDigest
              }
          });
          try {
            getMediaArtifact(db, artifactId);
          } catch (error) {
            if (!(error instanceof ArtifactStructuredDriftError) && !(error instanceof SyntaxError)) throw error;
            storyboardArtifactStructuredDriftCount += 1;
          }
        }
      }
      const referenceDigests = storyboardReferenceFacts
        .map((facts) => createHash("sha256")
          .update("s3b-t2-drift-reference-v1\0")
          .update(JSON.stringify(facts))
          .digest("hex"))
        .sort();
      fingerprintFacts.push({
        storyboard_reference_count: referenceDigests.length,
        storyboard_reference_digests: referenceDigests,
        storyboard_artifact_structured_drift_count: storyboardArtifactStructuredDriftCount
      });
      if (malformedShotCount > 0) {
        addReason(reasons, activeIntentCount > 0 ? "REAL_GENERATION_ALREADY_ACTIVE" : "SHOT_STATE_INCONSISTENT");
        db.exec("ROLLBACK");
        assertPathCurrent();
        const after = totalChanges(db);
        if (before !== 0 || after !== 0) throw new Error("T2_DATABASE_WRITE_DETECTED");
        return {
          fingerprint: stableFingerprint({ fingerprintFacts, candidates, reasons }),
          candidates,
          reasons,
          sqlite: { total_changes_before: before, total_changes_after: after }
        };
      }
      if (storyboardArtifactStructuredDriftCount > 0) {
        addReason(reasons, activeIntentCount > 0 ? "REAL_GENERATION_ALREADY_ACTIVE" : "STORYBOARD_ARTIFACT_INTEGRITY_INVALID");
        db.exec("COMMIT");
        assertPathCurrent();
        const after = totalChanges(db);
        if (before !== 0 || after !== 0) throw new Error("T2_DATABASE_WRITE_DETECTED");
        return {
          fingerprint: stableFingerprint({ fingerprintFacts, candidates, reasons }),
          candidates,
          reasons,
          sqlite: { total_changes_before: before, total_changes_after: after }
        };
      }

      let bundles: ReturnType<typeof collectProjectOperationalBundles>;
      try {
        bundles = collectProjectOperationalBundles(db, projects);
      } catch (error) {
        if (!(error instanceof OperationalStateIntegrityError)) throw error;
        if (error.code === "ARTIFACT_OPERATIONAL_FACT_INVALID") {
          addReason(reasons, activeIntentCount > 0 ? "REAL_GENERATION_ALREADY_ACTIVE" : "STORYBOARD_ARTIFACT_INTEGRITY_INVALID");
        } else if (error.code === "SHOT_OPERATIONAL_FACT_INVALID") {
          addReason(reasons, activeIntentCount > 0 ? "REAL_GENERATION_ALREADY_ACTIVE" : "SHOT_STATE_INCONSISTENT");
        } else {
          throw error;
        }
        db.exec("COMMIT");
        assertPathCurrent();
        const after = totalChanges(db);
        if (before !== 0 || after !== 0) throw new Error("T2_DATABASE_WRITE_DETECTED");
        return {
          fingerprint: stableFingerprint({ fingerprintFacts, candidates, reasons }),
          candidates,
          reasons,
          sqlite: { total_changes_before: before, total_changes_after: after }
        };
      }

      if (activeIntentCount > 0) addReason(reasons, "REAL_GENERATION_ALREADY_ACTIVE");
      for (const [index, project] of projects.entries()) {
        const row = rows[index];
        const bundle = bundles.get(project.project_id);
        fingerprintFacts.push({ row, project, shots: bundle?.shots, states: bundle?.states });
        if (activeIntentCount > 0) continue;
        if (row.classification !== "production") { addReason(reasons, "PROJECT_NOT_PRODUCTION"); continue; }
        if (row.lifecycle !== "active") { addReason(reasons, "PROJECT_NOT_ACTIVE"); continue; }
        if (project.status === "final_approved") { addReason(reasons, "PROJECT_ALREADY_DELIVERED"); continue; }
        if (!["draft", "storyboard_approved", "video_generation_in_progress", "video_review"].includes(project.status)) {
          addReason(reasons, "PROJECT_STATUS_INELIGIBLE"); continue;
        }
        if (!project.active_storyboard_package_id) { addReason(reasons, "PACKAGE_NOT_FOUND"); continue; }
        const packageRow = db.prepare(`
          SELECT storyboard_package_id, project_id, data_json
          FROM storyboard_packages
          WHERE storyboard_package_id = ?
        `).get(project.active_storyboard_package_id) as {
          storyboard_package_id: string;
          project_id: string;
          data_json: string;
        } | undefined;
        if (!packageRow) { addReason(reasons, "PACKAGE_NOT_FOUND"); continue; }
        let storyboard: StoryboardPackage;
        try {
          const parsed: unknown = JSON.parse(packageRow.data_json);
          if (!isRecord(parsed)) throw new Error("PACKAGE_SNAPSHOT_MISMATCH");
          const validatedSnapshots = validateApprovedShotSnapshots(parsed.approved_shot_snapshots);
          if (!validatedSnapshots.ok) throw new Error("PACKAGE_SNAPSHOT_MISMATCH");
          storyboard = { ...parsed, approved_shot_snapshots: validatedSnapshots.snapshots } as unknown as StoryboardPackage;
        } catch {
          addReason(reasons, "PACKAGE_SNAPSHOT_MISMATCH");
          continue;
        }
        fingerprintFacts.push({ storyboard, package_row: packageRow });
        if (storyboard.storyboard_package_id !== packageRow.storyboard_package_id) { addReason(reasons, "PACKAGE_SNAPSHOT_MISMATCH"); continue; }
        if (storyboard.project_id !== packageRow.project_id) { addReason(reasons, "PACKAGE_PROJECT_MISMATCH"); continue; }
        if (storyboard.project_id !== project.project_id) { addReason(reasons, "PACKAGE_PROJECT_MISMATCH"); continue; }
        if (storyboard.status !== "approved_for_video_generation" || storyboard.user_approval?.storyboard_approved !== true) {
          addReason(reasons, "PACKAGE_NOT_APPROVED"); continue;
        }
        if (!bundle) throw new Error("T2_OPERATIONAL_BUNDLE_MISSING");
        for (const shot of bundle.shots) {
          const operational = bundle.states_by_shot_id.get(shot.shot_id);
          if (shot.generation_run_ids.length !== 0 || shot.clip_versions.length !== 0) {
            addReason(reasons, "GENERATION_ALREADY_STARTED");
            continue;
          }
          if (generationHistoryByShot.has(`${shot.project_id}\u0000${shot.shot_id}`)) {
            addReason(reasons, "GENERATION_ALREADY_STARTED");
            continue;
          }
          if (operational && ["queued", "running"].includes(operational.generation.stage)) {
            addReason(reasons, "GENERATION_ALREADY_STARTED");
            continue;
          }
          if (shot.status !== "storyboard_approved") {
            if (operational && addCanonicalOperationalReasons(reasons, operational)) continue;
            addReason(reasons, "SHOT_NOT_STORYBOARD_APPROVED");
            continue;
          }
          if (!operational
            || operational.generation.stage !== "ready"
            || !operational.allowed_workflow_actions.prepare_generation
            || operational.review.stage !== "not_started") {
            if (!operational || !addCanonicalOperationalReasons(reasons, operational)) {
              addReason(reasons, "SHOT_OPERATIONAL_STATE_INELIGIBLE");
            }
            continue;
          }
          const matched = matchingSnapshot(storyboard.approved_shot_snapshots, shot);
          if (matched === "ambiguous") { addReason(reasons, "PACKAGE_SNAPSHOT_MISMATCH"); continue; }
          if (!matched
            || matched.snapshot.duration_seconds !== shot.duration_seconds
            || matched.snapshot.video_prompt !== shot.video_prompt
            || matched.snapshot.storyboard_image_artifact_id !== shot.storyboard_image_artifact_id) {
            addReason(reasons, "PACKAGE_SNAPSHOT_MISMATCH"); continue;
          }
          const snapshotNegativePrompt = normalizeNegativePrompt(matched.snapshot.negative_prompt);
          const shotNegativePrompt = normalizeNegativePrompt(shot.negative_prompt);
          if (!snapshotNegativePrompt.ok || !shotNegativePrompt.ok || snapshotNegativePrompt.value !== shotNegativePrompt.value) {
            addReason(reasons, "PACKAGE_SNAPSHOT_MISMATCH"); continue;
          }
          let artifact: ReturnType<typeof getMediaArtifact>;
          try {
            artifact = getMediaArtifact(db, shot.storyboard_image_artifact_id);
          } catch (error) {
            if (!(error instanceof ArtifactStructuredDriftError)) throw error;
            addReason(reasons, "STORYBOARD_ARTIFACT_INTEGRITY_INVALID");
            continue;
          }
          if (!isT2MediaArtifactShape(artifact)) {
            addReason(reasons, "STORYBOARD_ARTIFACT_INTEGRITY_INVALID");
            continue;
          }
          if (artifact.status !== "active"
            || artifact.artifact_type !== "image"
            || artifact.role !== "storyboard_image"
            || artifact.linked_objects.project_id !== project.project_id
            || artifact.linked_objects.shot_id !== shot.shot_id) {
            addReason(reasons, "STORYBOARD_ARTIFACT_INTEGRITY_INVALID"); continue;
          }
          if (!["image/png", "image/jpeg"].includes(artifact.storage.mime_type)) {
            addReason(reasons, "STORYBOARD_IMAGE_MIME_UNSUPPORTED"); continue;
          }
          const mediaInspection = inspectMediaArtifactBytes(db, artifact, authoritativeMediaRoot);
          if (!mediaInspection.ok) {
            if (mediaInspection.actual_byte_digest) {
              fingerprintFacts.push({ actual_media_digest: mediaInspection.actual_byte_digest, verification: mediaInspection.code });
            }
            addReason(reasons, mediaInspection.code);
            continue;
          }
          fingerprintFacts.push({ actual_media_digest: mediaInspection.actual_byte_digest });
          const verified = verifyMediaArtifactBytes(db, artifact);
          fingerprintFacts.push({ artifact, verified: verified.ok ? verified.blob : verified.error.code });
          if (!verified.ok || !["image/png", "image/jpeg"].includes(verified.blob.detected_mime)) {
            addReason(reasons, verified.ok ? "STORYBOARD_IMAGE_MIME_UNSUPPORTED" : "STORYBOARD_ARTIFACT_INTEGRITY_INVALID"); continue;
          }
          const artifactPackage = (artifact.source as Record<string, unknown>).storyboard_package_id;
          const blobPackage = verified.blob.provenance.storyboard_package_id;
          if ((typeof artifactPackage === "string" && artifactPackage !== storyboard.storyboard_package_id)
            || (typeof blobPackage === "string" && blobPackage !== storyboard.storyboard_package_id)) {
            addReason(reasons, "STORYBOARD_ARTIFACT_INTEGRITY_INVALID"); continue;
          }
          const capability = buildProviderCapabilityKey({
            provider: "runninghub",
            model: RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY.model,
            duration_seconds: shot.duration_seconds,
            resolution: project.video_spec.resolution,
            aspect_ratio: project.video_spec.aspect_ratio
          });
          fingerprintFacts.push({ capability });
          if (!capability.ok) { addReason(reasons, capability.code); continue; }
          candidates.push({
            project_id: project.project_id,
            shot_id: shot.shot_id,
            package_id: storyboard.storyboard_package_id,
            artifact_id: artifact.artifact_id,
            match_mode: matched.mode
          });
        }
      }
      db.exec("COMMIT");
      assertPathCurrent();
      const after = totalChanges(db);
      if (before !== 0 || after !== 0) throw new Error("T2_DATABASE_WRITE_DETECTED");
      return {
        fingerprint: stableFingerprint({ fingerprintFacts, candidates, reasons }),
        candidates,
        reasons,
        sqlite: { total_changes_before: before, total_changes_after: after }
      };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original boundary failure */ }
      throw error;
    }
  } finally {
    db.close();
  }
}

function boundaryReceipt(): S3bT2Receipt {
  return {
    schema_version: "s3b-t2-eligibility-receipt-v1",
    result: "T2_READ_ONLY_BOUNDARY_VIOLATION",
    eligible_candidate_count: 0,
    reason_code_counts: {},
    read_only_proof: { sqlite_total_changes: 0, network_calls: 0, credential_reads: 0, media_writes: 0 }
  };
}

export async function scanS3bT2Eligibility(options: S3bT2ScanOptions = {}): Promise<S3bT2Receipt> {
  const scanPaths = options.paths ?? paths;
  let first: SnapshotResult;
  let second: SnapshotResult;
  try {
    first = readSnapshot(scanPaths);
    await options.betweenSnapshots?.();
    second = readSnapshot(scanPaths);
  } catch {
    return boundaryReceipt();
  }
  if (first.fingerprint !== second.fingerprint) {
    return { ...boundaryReceipt(), result: "T2_STATE_CHANGED_DURING_SCAN" };
  }
  if (first.boundary_violation || second.boundary_violation) return boundaryReceipt();
  const count = second.candidates.length;
  const receipt: S3bT2Receipt = {
    schema_version: "s3b-t2-eligibility-receipt-v1",
    result: count === 1 ? "PASS_ONE_ELIGIBLE_SHOT" : count === 0 ? "S3_NO_ELIGIBLE_SHOT" : "S3_MULTIPLE_ELIGIBLE_SHOTS",
    eligible_candidate_count: count,
    reason_code_counts: second.reasons,
    read_only_proof: { sqlite_total_changes: 0, network_calls: 0, credential_reads: 0, media_writes: 0 }
  };
  if (count === 1) {
    const candidate = second.candidates[0];
    receipt.candidate_alias = createCandidateAlias();
    receipt.package_match_mode = candidate.match_mode;
    receipt.artifact_verification_level = "actual_bytes";
    receipt.mime_class = "image";
    receipt.provider_capability = { provider: "runninghub", registry_only: true, result: "PASS" };
  }
  return receipt;
}

export function s3bT2ExitCode(result: S3bT2StableResult): 0 | 1 | 2 {
  if (result === "PASS_ONE_ELIGIBLE_SHOT") return 0;
  if (["S3_NO_ELIGIBLE_SHOT", "S3_MULTIPLE_ELIGIBLE_SHOTS", "T2_STATE_CHANGED_DURING_SCAN"].includes(result)) return 2;
  return 1;
}
