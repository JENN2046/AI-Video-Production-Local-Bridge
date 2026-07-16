import { createHash } from "node:crypto";

import { z } from "zod/v4";

import {
  WEBGPT_V4_CLOSEOUT_DATA_SCHEMA,
  WEBGPT_V4_COMPACT_PROJECT_LIST_ITEM_SCHEMA,
  WEBGPT_V4_DELIVERY_DATA_SCHEMA,
  WEBGPT_V4_FULL_PROJECT_LIST_ITEM_SCHEMA,
  WEBGPT_V4_PROJECT_CONTEXT_DATA_SCHEMA,
  WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA,
  WEBGPT_V4_SHOT_SCHEMA,
  WEBGPT_V4_COMPACT_SHOT_SCHEMA
} from "../webgpt-v4/contracts.js";

export const READONLY_SNAPSHOT_SCHEMA_VERSION = "readonly-snapshot-v1";
export const READONLY_SNAPSHOT_REQUIRED_SCHEMA = "workbench-v2-5";
export const READONLY_SNAPSHOT_REQUIRED_MIGRATION = "0008";
export const READONLY_SNAPSHOT_MAX_TTL_SECONDS = 24 * 60 * 60;
export const READONLY_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const isoInstantSchema = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "Expected a canonical UTC ISO instant.");
const httpsResourceSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, "Expected a credential-free HTTPS resource URL.");

const authorizationPrincipalSchema = z.object({
  principal_id: sha256Schema,
  project_ids: z.array(z.string().min(1)).max(10000)
}).strict();

const contextProjectionSchema = z.object({
  workspace: z.enum(["overview", "storyboard", "generation", "review", "delivery"]),
  compact: WEBGPT_V4_PROJECT_CONTEXT_DATA_SCHEMA,
  full: WEBGPT_V4_PROJECT_CONTEXT_DATA_SCHEMA
}).strict();

const reviewProjectionSchema = z.object({
  shot_id: z.string().min(1),
  compact: WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA,
  full: WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA
}).strict();

export const READONLY_PROJECT_PROJECTION_SCHEMA = z.object({
  project_id: z.string().min(1),
  list_item_compact: WEBGPT_V4_COMPACT_PROJECT_LIST_ITEM_SCHEMA,
  list_item_full: WEBGPT_V4_FULL_PROJECT_LIST_ITEM_SCHEMA,
  contexts: z.array(contextProjectionSchema).length(5),
  shots_compact: z.array(WEBGPT_V4_COMPACT_SHOT_SCHEMA),
  shots_full: z.array(WEBGPT_V4_SHOT_SCHEMA),
  review_packages: z.array(reviewProjectionSchema),
  delivery: WEBGPT_V4_DELIVERY_DATA_SCHEMA,
  closeout: WEBGPT_V4_CLOSEOUT_DATA_SCHEMA
}).strict();

type ReadonlyProjectProjectionShape = z.infer<typeof READONLY_PROJECT_PROJECTION_SCHEMA>;

function addBindingIssue(context: z.core.$RefinementCtx, path: Array<string | number>, message: string): void {
  context.addIssue({ code: "custom", message, path });
}

function validateArtifactBinding(
  artifact: { linked_objects: { project_id: string; shot_id: string } } | null,
  projectId: string,
  expectedShotId: string | null,
  path: Array<string | number>,
  context: z.core.$RefinementCtx
): void {
  if (!artifact) return;
  if (artifact.linked_objects.project_id !== projectId) {
    addBindingIssue(context, [...path, "linked_objects", "project_id"], "Artifact project binding mismatch.");
  }
  if (expectedShotId !== null && artifact.linked_objects.shot_id !== expectedShotId) {
    addBindingIssue(context, [...path, "linked_objects", "shot_id"], "Artifact SHOT binding mismatch.");
  }
}

function validateProjectProjectionBindings(
  project: ReadonlyProjectProjectionShape,
  projectIndex: number,
  context: z.core.$RefinementCtx
): void {
  const base = ["projects", projectIndex] as Array<string | number>;
  const projectId = project.project_id;
  const shotIds = new Set(project.shots_full.map((shot) => shot.shot_id));
  if (shotIds.size !== project.shots_full.length) addBindingIssue(context, [...base, "shots_full"], "Duplicate full SHOT binding.");

  if (project.list_item_compact.project.project_id !== projectId || project.list_item_full.project.project_id !== projectId) {
    addBindingIssue(context, base, "Projected project binding mismatch.");
  }
  for (const [shotIndex, shot] of project.shots_compact.entries()) {
    if (shot.project_id !== projectId) addBindingIssue(context, [...base, "shots_compact", shotIndex, "project_id"], "SHOT project binding mismatch.");
    if (!shotIds.has(shot.shot_id)) addBindingIssue(context, [...base, "shots_compact", shotIndex, "shot_id"], "Compact SHOT is absent from the full SHOT projection.");
  }
  if (project.shots_compact.length !== shotIds.size) addBindingIssue(context, [...base, "shots_compact"], "Compact and full SHOT bindings differ.");
  for (const [shotIndex, shot] of project.shots_full.entries()) {
    if (shot.project_id !== projectId) addBindingIssue(context, [...base, "shots_full", shotIndex, "project_id"], "SHOT project binding mismatch.");
  }
  const listedShotIds = project.list_item_full.project.shot_ids;
  if (listedShotIds.length !== shotIds.size || listedShotIds.some((shotId) => !shotIds.has(shotId))) {
    addBindingIssue(context, [...base, "list_item_full", "project", "shot_ids"], "Project SHOT list binding mismatch.");
  }

  const contextWorkspaces = new Set(project.contexts.map((projection) => projection.workspace));
  if (contextWorkspaces.size !== project.contexts.length) addBindingIssue(context, [...base, "contexts"], "Duplicate project context workspace.");
  for (const [contextIndex, projection] of project.contexts.entries()) {
    for (const [detail, value] of [["compact", projection.compact], ["full", projection.full]] as const) {
      const path = [...base, "contexts", contextIndex, detail] as Array<string | number>;
      if (value.workspace !== projection.workspace) addBindingIssue(context, [...path, "workspace"], "Context workspace binding mismatch.");
      if (value.project.project_id !== projectId) addBindingIssue(context, [...path, "project", "project_id"], "Context project binding mismatch.");
      if ("meta" in value && value.meta.project_id !== projectId) addBindingIssue(context, [...path, "meta", "project_id"], "Context metadata project binding mismatch.");
      if ("shots" in value) {
        for (const [shotIndex, shot] of value.shots.entries()) {
          if (shot.project_id !== projectId || !shotIds.has(shot.shot_id)) {
            addBindingIssue(context, [...path, "shots", shotIndex], "Context SHOT binding mismatch.");
          }
        }
      }
      if ("review_notes" in value) {
        for (const [noteIndex, note] of value.review_notes.entries()) {
          if (note.project_id !== projectId || !shotIds.has(note.shot_id)) {
            addBindingIssue(context, [...path, "review_notes", noteIndex], "Review note binding mismatch.");
          }
        }
      }
      if ("accepted_clips" in value) {
        for (const [clipIndex, clip] of value.accepted_clips.entries()) {
          if (!shotIds.has(clip.shot_id)) addBindingIssue(context, [...path, "accepted_clips", clipIndex, "shot_id"], "Accepted clip SHOT binding mismatch.");
          validateArtifactBinding(clip.artifact, projectId, clip.shot_id, [...path, "accepted_clips", clipIndex, "artifact"], context);
        }
        validateArtifactBinding(value.final_artifact, projectId, null, [...path, "final_artifact"], context);
      }
    }
  }

  for (const [reviewIndex, review] of project.review_packages.entries()) {
    const path = [...base, "review_packages", reviewIndex] as Array<string | number>;
    if (!shotIds.has(review.shot_id)) addBindingIssue(context, [...path, "shot_id"], "Review package SHOT binding mismatch.");
    for (const [detail, value] of [["compact", review.compact], ["full", review.full]] as const) {
      const detailPath = [...path, detail] as Array<string | number>;
      if (value.shot.project_id !== projectId || value.shot.shot_id !== review.shot_id) {
        addBindingIssue(context, [...detailPath, "shot"], "Review package SHOT binding mismatch.");
      }
      for (const [noteIndex, note] of value.notes.entries()) {
        if (note.project_id !== projectId || note.shot_id !== review.shot_id) {
          addBindingIssue(context, [...detailPath, "notes", noteIndex], "Review package note binding mismatch.");
        }
      }
      for (const [versionIndex, version] of value.versions.entries()) {
        if ("artifact" in version) {
          validateArtifactBinding(
            version.artifact as { linked_objects: { project_id: string; shot_id: string } },
            projectId,
            review.shot_id,
            [...detailPath, "versions", versionIndex, "artifact"],
            context
          );
        }
      }
    }
  }

  for (const [name, value] of [["delivery", project.delivery], ["closeout", project.closeout]] as const) {
    const path = [...base, name] as Array<string | number>;
    if (value.project_id !== projectId) addBindingIssue(context, [...path, "project_id"], "Delivery project binding mismatch.");
    for (const [checkIndex, check] of value.readiness_checks.entries()) {
      if (!shotIds.has(check.shot_id)) addBindingIssue(context, [...path, "readiness_checks", checkIndex, "shot_id"], "Delivery SHOT binding mismatch.");
    }
    validateArtifactBinding(value.final_artifact, projectId, null, [...path, "final_artifact"], context);
  }
}

const readonlySnapshotShape = {
  schema_version: z.literal(READONLY_SNAPSHOT_SCHEMA_VERSION),
  source_schema: z.literal(READONLY_SNAPSHOT_REQUIRED_SCHEMA),
  source_migration: z.literal(READONLY_SNAPSHOT_REQUIRED_MIGRATION),
  source_version: z.string().min(1).max(100),
  generated_at: isoInstantSchema,
  expires_at: isoInstantSchema,
  resource_url: httpsResourceSchema,
  issuer_hash: sha256Schema,
  authorization: z.object({ principals: z.array(authorizationPrincipalSchema) }).strict(),
  projects: z.array(READONLY_PROJECT_PROJECTION_SCHEMA)
} as const;

function validateSnapshotBindings(value: {
  authorization: { principals: Array<{ principal_id: string; project_ids: string[] }> };
  projects: ReadonlyProjectProjectionShape[];
}, context: z.core.$RefinementCtx): void {
  const projectIds = new Set<string>();
  for (const [projectIndex, project] of value.projects.entries()) {
    if (projectIds.has(project.project_id)) context.addIssue({ code: "custom", message: "Duplicate projected project id.", path: ["projects"] });
    projectIds.add(project.project_id);
    validateProjectProjectionBindings(project, projectIndex, context);
  }
  const principals = new Set<string>();
  for (const principal of value.authorization.principals) {
    if (principals.has(principal.principal_id)) context.addIssue({ code: "custom", message: "Duplicate authorization principal.", path: ["authorization", "principals"] });
    principals.add(principal.principal_id);
    const grants = new Set<string>();
    for (const projectId of principal.project_ids) {
      if (grants.has(projectId)) context.addIssue({ code: "custom", message: "Duplicate project grant.", path: ["authorization", "principals"] });
      grants.add(projectId);
      if (!projectIds.has(projectId)) context.addIssue({ code: "custom", message: "Authorization references an absent project.", path: ["authorization", "principals"] });
    }
  }
}

export const READONLY_SNAPSHOT_UNSIGNED_SCHEMA = z.object(readonlySnapshotShape).strict().superRefine(validateSnapshotBindings);

export const READONLY_SNAPSHOT_SCHEMA = z.object({ ...readonlySnapshotShape,
  snapshot_fingerprint: sha256Schema
}).strict().superRefine(validateSnapshotBindings);

export type ReadonlySnapshotUnsigned = z.infer<typeof READONLY_SNAPSHOT_UNSIGNED_SCHEMA>;
export type ReadonlySnapshot = z.infer<typeof READONLY_SNAPSHOT_SCHEMA>;
export type ReadonlyProjectProjection = z.infer<typeof READONLY_PROJECT_PROJECTION_SCHEMA>;

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("JCS_INVALID_UNICODE");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("JCS_INVALID_UNICODE");
    }
  }
}

/** RFC 8785/JCS canonical JSON for JSON-compatible values. */
export function canonicalizeJcs(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS_NON_FINITE_NUMBER");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJcs).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, item] of entries) {
      assertUnicodeScalarString(key);
      if (item === undefined || typeof item === "bigint" || typeof item === "function" || typeof item === "symbol") {
        throw new Error("JCS_UNSUPPORTED_VALUE");
      }
    }
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJcs(item)}`).join(",")}}`;
  }
  throw new Error("JCS_UNSUPPORTED_VALUE");
}

export function snapshotFingerprint(snapshot: ReadonlySnapshotUnsigned): string {
  const validated = READONLY_SNAPSHOT_UNSIGNED_SCHEMA.parse(snapshot);
  return createHash("sha256").update(canonicalizeJcs(validated), "utf8").digest("hex");
}

function assertSnapshotTimeWindow(snapshot: ReadonlySnapshotUnsigned, now = new Date()): void {
  const generated = Date.parse(snapshot.generated_at);
  const expires = Date.parse(snapshot.expires_at);
  const ttlSeconds = (expires - generated) / 1000;
  if (!(ttlSeconds > 0 && ttlSeconds <= READONLY_SNAPSHOT_MAX_TTL_SECONDS)) {
    throw new Error("READONLY_SNAPSHOT_INVALID_TTL");
  }
  if (generated > now.getTime()) throw new Error("READONLY_SNAPSHOT_GENERATED_IN_FUTURE");
}

export function finalizeReadonlySnapshot(input: ReadonlySnapshotUnsigned, now = new Date()): ReadonlySnapshot {
  const validated = READONLY_SNAPSHOT_UNSIGNED_SCHEMA.parse(input);
  assertSnapshotTimeWindow(validated, now);
  const snapshot = READONLY_SNAPSHOT_SCHEMA.parse({ ...validated, snapshot_fingerprint: snapshotFingerprint(validated) });
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > READONLY_SNAPSHOT_MAX_BYTES) {
    throw new Error("READONLY_SNAPSHOT_TOO_LARGE");
  }
  return snapshot;
}

export function parseReadonlySnapshot(input: unknown, now = new Date()): ReadonlySnapshot {
  const snapshot = READONLY_SNAPSHOT_SCHEMA.parse(input);
  assertSnapshotTimeWindow(snapshot, now);
  const { snapshot_fingerprint: claimed, ...unsigned } = snapshot;
  if (snapshotFingerprint(unsigned) !== claimed) throw new Error("READONLY_SNAPSHOT_FINGERPRINT_MISMATCH");
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > READONLY_SNAPSHOT_MAX_BYTES) throw new Error("READONLY_SNAPSHOT_TOO_LARGE");
  return snapshot;
}

export type ReadonlySnapshotStatus = {
  server_now: string;
  generated_at: string | null;
  expires_at: string | null;
  age_seconds: number | null;
  ttl_remaining_seconds: number;
  freshness_status: "no_snapshot" | "fresh" | "snapshot_expired";
  snapshot_fingerprint: string | null;
};

export function readonlySnapshotStatus(snapshot: ReadonlySnapshot | null, now = new Date()): ReadonlySnapshotStatus {
  const serverNow = now.toISOString();
  if (!snapshot) return {
    server_now: serverNow, generated_at: null, expires_at: null, age_seconds: null,
    ttl_remaining_seconds: 0, freshness_status: "no_snapshot", snapshot_fingerprint: null
  };
  const nowMs = now.getTime();
  const generatedMs = Date.parse(snapshot.generated_at);
  const expiresMs = Date.parse(snapshot.expires_at);
  if (generatedMs > nowMs) return {
    server_now: serverNow,
    generated_at: snapshot.generated_at,
    expires_at: snapshot.expires_at,
    age_seconds: 0,
    ttl_remaining_seconds: 0,
    freshness_status: "snapshot_expired",
    snapshot_fingerprint: snapshot.snapshot_fingerprint
  };
  const remaining = Math.max(0, Math.ceil((expiresMs - nowMs) / 1000));
  return {
    server_now: serverNow,
    generated_at: snapshot.generated_at,
    expires_at: snapshot.expires_at,
    age_seconds: Math.max(0, Math.floor((nowMs - generatedMs) / 1000)),
    ttl_remaining_seconds: remaining,
    freshness_status: nowMs < expiresMs ? "fresh" : "snapshot_expired",
    snapshot_fingerprint: snapshot.snapshot_fingerprint
  };
}
