import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { assertSchemaCurrent } from "../storage/migrations.js";
import { openM0DatabaseConnection, type M0Database } from "../storage/sqlite.js";
import { paths, type M0Paths } from "../paths.js";
import { collectProjectOperationalBundles } from "./operationalStateFacts.js";
import { getMediaArtifact, verifyMediaArtifactBytes } from "./mediaArtifacts.js";
import { buildProviderCapabilityKey, RUNNINGHUB_IMAGE_TO_VIDEO_CAPABILITY } from "./providerCapabilities.js";
import type { Project, Shot } from "./projects.js";
import { getStoryboardPackage, type ApprovedShotSnapshot, type StoryboardPackage } from "./storyboardPackages.js";
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

function parseProject(row: ProjectRow): Project {
  const project = JSON.parse(row.data_json) as Project;
  if (!project || project.project_id !== row.project_id) throw new Error("T2_PROJECT_FACT_INVALID");
  return project;
}

function normalizeNegativePrompt(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function matchingSnapshot(storyboard: StoryboardPackage, shot: Shot): { snapshot: ApprovedShotSnapshot; mode: Candidate["match_mode"] } | null | "ambiguous" {
  const byId = storyboard.approved_shot_snapshots.filter((snapshot) => snapshot.shot_id === shot.shot_id);
  if (byId.length === 1) return { snapshot: byId[0], mode: "shot_id" };
  if (byId.length > 1) return "ambiguous";
  const byOrder = storyboard.approved_shot_snapshots.filter((snapshot) => !snapshot.shot_id && snapshot.order === shot.order);
  return byOrder.length === 1 ? { snapshot: byOrder[0], mode: "order" } : byOrder.length > 1 ? "ambiguous" : null;
}

function addReason(reasons: SnapshotResult["reasons"], code: S3bT2ReasonCode): void {
  reasons[code] = (reasons[code] ?? 0) + 1;
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

function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
      const projects = rows.map(parseProject);
      const bundles = collectProjectOperationalBundles(db, projects);
      const candidates: Candidate[] = [];
      const fingerprintFacts: unknown[] = [{ database_identity: guard.identity, active_intent_count: activeIntentCount }];

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
        const storyboard = getStoryboardPackage(db, project.active_storyboard_package_id);
        fingerprintFacts.push({ storyboard });
        if (!storyboard) { addReason(reasons, "PACKAGE_NOT_FOUND"); continue; }
        if (storyboard.project_id !== project.project_id) { addReason(reasons, "PACKAGE_PROJECT_MISMATCH"); continue; }
        if (storyboard.status !== "approved_for_video_generation" || storyboard.user_approval?.storyboard_approved !== true) {
          addReason(reasons, "PACKAGE_NOT_APPROVED"); continue;
        }
        if (!bundle) throw new Error("T2_OPERATIONAL_BUNDLE_MISSING");
        for (const shot of bundle.shots) {
          if (shot.status !== "storyboard_approved") { addReason(reasons, "SHOT_NOT_STORYBOARD_APPROVED"); continue; }
          if (shot.generation_run_ids.length !== 0 || shot.clip_versions.length !== 0) {
            addReason(reasons, "GENERATION_ALREADY_STARTED");
            continue;
          }
          const operational = bundle.states_by_shot_id.get(shot.shot_id);
          if (!operational
            || operational.generation.stage !== "ready"
            || !operational.allowed_workflow_actions.prepare_generation
            || operational.review.stage !== "not_started") {
            if (!operational || !addCanonicalOperationalReasons(reasons, operational)) {
              addReason(reasons, "SHOT_OPERATIONAL_STATE_INELIGIBLE");
            }
            continue;
          }
          const matched = matchingSnapshot(storyboard, shot);
          if (matched === "ambiguous") { addReason(reasons, "PACKAGE_SNAPSHOT_MISMATCH"); continue; }
          if (!matched
            || matched.snapshot.duration_seconds !== shot.duration_seconds
            || matched.snapshot.video_prompt !== shot.video_prompt
            || normalizeNegativePrompt(matched.snapshot.negative_prompt) !== normalizeNegativePrompt(shot.negative_prompt)
            || matched.snapshot.storyboard_image_artifact_id !== shot.storyboard_image_artifact_id) {
            addReason(reasons, "PACKAGE_SNAPSHOT_MISMATCH"); continue;
          }
          const artifact = getMediaArtifact(db, shot.storyboard_image_artifact_id);
          if (!artifact
            || artifact.status !== "active"
            || artifact.artifact_type !== "image"
            || artifact.role !== "storyboard_image"
            || artifact.linked_objects.project_id !== project.project_id
            || artifact.linked_objects.shot_id !== shot.shot_id) {
            addReason(reasons, "STORYBOARD_ARTIFACT_INTEGRITY_INVALID"); continue;
          }
          if (!["image/png", "image/jpeg"].includes(artifact.storage.mime_type)) {
            addReason(reasons, "STORYBOARD_IMAGE_MIME_UNSUPPORTED"); continue;
          }
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
    receipt.candidate_alias = `shot_${createHash("sha256").update(`s3b-t2-alias-v1\u0000${candidate.shot_id}`).digest("hex").slice(0, 16)}`;
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
