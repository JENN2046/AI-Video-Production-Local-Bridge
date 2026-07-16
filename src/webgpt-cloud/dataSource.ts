import { z } from "zod/v4";

import { assertSchemaCurrent, SchemaMigrationRequiredError } from "../storage/migrations.js";
import { openM0DatabaseConnection, type M0Database } from "../storage/sqlite.js";
import {
  readDelivery,
  readProjectContext,
  readProjectList,
  readReviewPackage,
  readShotList,
  WEBGPT_V4_CLOSEOUT_DATA_SCHEMA,
  WEBGPT_V4_COMPACT_PROJECT_LIST_ITEM_SCHEMA,
  WEBGPT_V4_DELIVERY_DATA_SCHEMA,
  WEBGPT_V4_FULL_PROJECT_LIST_ITEM_SCHEMA,
  WEBGPT_V4_PROJECT_CONTEXT_DATA_SCHEMA,
  WEBGPT_V4_PROJECT_LIST_DATA_SCHEMA,
  WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA,
  WEBGPT_V4_COMPACT_SHOT_SCHEMA,
  WEBGPT_V4_SHOT_SCHEMA,
  WEBGPT_V4_SHOT_LIST_DATA_SCHEMA,
  type WebGptV4Detail
} from "../webgpt-v4/contracts.js";
import {
  getProductionCloseoutEvidence,
  getProductionDeliveryStatus,
  getProductionProjectContext,
  getProductionReviewPackage,
  listProductionProjects,
  listProductionProjectShots
} from "../webgpt-v4/domain.js";
import { authorizedWebGptProjectIds } from "../webgpt-v4/projectAuthorization.js";
import { errorBody, fail, ok, requestId, WebGptV4Error, WEBGPT_V4_VERSION, type WebGptV4Result } from "../webgpt-v4/types.js";
import {
  finalizeReadonlySnapshot,
  parseReadonlySnapshot,
  readonlySnapshotStatus,
  READONLY_SNAPSHOT_REQUIRED_MIGRATION,
  READONLY_SNAPSHOT_REQUIRED_SCHEMA,
  READONLY_SNAPSHOT_SCHEMA_VERSION,
  type ReadonlyProjectProjection,
  type ReadonlySnapshot,
  type ReadonlySnapshotUnsigned
} from "./snapshot.js";

type ProjectListData = z.infer<typeof WEBGPT_V4_PROJECT_LIST_DATA_SCHEMA>;
type ProjectContextData = z.infer<typeof WEBGPT_V4_PROJECT_CONTEXT_DATA_SCHEMA>;
type ShotListData = z.infer<typeof WEBGPT_V4_SHOT_LIST_DATA_SCHEMA>;
type ReviewPackageData = z.infer<typeof WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA>;
type DeliveryData = z.infer<typeof WEBGPT_V4_DELIVERY_DATA_SCHEMA>;
type CloseoutData = z.infer<typeof WEBGPT_V4_CLOSEOUT_DATA_SCHEMA>;

export type ReadonlyProjectListInput = {
  query?: string;
  include_archived?: boolean;
  limit?: number;
  offset?: number;
  detail?: WebGptV4Detail;
};
export type ReadonlyProjectContextInput = {
  project_id: string;
  workspace?: "overview" | "storyboard" | "generation" | "review" | "delivery";
  detail?: WebGptV4Detail;
};
export type ReadonlyShotListInput = { project_id: string; limit?: number; offset?: number; detail?: WebGptV4Detail };
export type ReadonlyReviewInput = { project_id: string; shot_id: string; artifact_id?: string; notes_limit?: number; detail?: WebGptV4Detail };

export interface ReadonlyDataSource {
  listProductionProjects(input?: ReadonlyProjectListInput, requestIdValue?: string): WebGptV4Result<unknown>;
  getProjectContext(input: ReadonlyProjectContextInput, requestIdValue?: string): WebGptV4Result<unknown>;
  listProjectShots(input: ReadonlyShotListInput, requestIdValue?: string): WebGptV4Result<unknown>;
  getReviewPackage(input: ReadonlyReviewInput, requestIdValue?: string): WebGptV4Result<unknown>;
  getDeliveryStatus(projectId: string, requestIdValue?: string): WebGptV4Result<unknown>;
  getCloseoutEvidence(projectId: string, requestIdValue?: string): WebGptV4Result<unknown>;
}

export class ReadonlyProjectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function clamp(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.trunc(value as number))) : fallback;
}

function offset(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0;
}

function sqliteLikeFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function sqliteContainsLike(value: string, query: string): boolean {
  const pattern = `%${sqliteLikeFold(query)}%`;
  const expression = pattern.split("").map((character) => {
    if (character === "%") return ".*";
    if (character === "_") return ".";
    return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }).join("");
  return new RegExp(`^${expression}$`, "su").test(sqliteLikeFold(value));
}

function requireSuccess<T>(result: WebGptV4Result<unknown>, schema: z.ZodType<T>): T {
  if (!result.ok) throw new ReadonlyProjectionError(result.error.code, result.error.message);
  return schema.parse(result.data);
}

export class SqliteReadonlyDataSource implements ReadonlyDataSource {
  constructor(
    private readonly db: M0Database,
    private readonly principalId: string,
    private readonly issuerHash: string
  ) {}

  private authorization(idValue?: string): string[] | WebGptV4Result<never> {
    try {
      return authorizedWebGptProjectIds(this.db, this.principalId, this.issuerHash);
    } catch (error) {
      if (error instanceof WebGptV4Error) return fail(requestId(idValue), errorBody(error));
      throw error;
    }
  }

  private denied(idValue?: string): WebGptV4Result<never> {
    return fail(requestId(idValue), { code: "PROJECT_NOT_FOUND", message: "Production project was not found.", field: "project_id" });
  }

  listProductionProjects(input: ReadonlyProjectListInput = {}, idValue?: string): WebGptV4Result<unknown> {
    const authorization = this.authorization(idValue);
    if (!Array.isArray(authorization)) return authorization;
    const detail = input.detail ?? "compact";
    return readProjectList(listProductionProjects(input, this.db, idValue, authorization), detail);
  }

  getProjectContext(input: ReadonlyProjectContextInput, idValue?: string): WebGptV4Result<unknown> {
    const authorization = this.authorization(idValue);
    if (!Array.isArray(authorization)) return authorization;
    if (!authorization.includes(input.project_id)) return this.denied(idValue);
    return readProjectContext(getProductionProjectContext(input, this.db, idValue), input.detail ?? "compact");
  }

  listProjectShots(input: ReadonlyShotListInput, idValue?: string): WebGptV4Result<unknown> {
    const authorization = this.authorization(idValue);
    if (!Array.isArray(authorization)) return authorization;
    if (!authorization.includes(input.project_id)) return this.denied(idValue);
    return readShotList(listProductionProjectShots(input, this.db, idValue), input.detail ?? "compact");
  }

  getReviewPackage(input: ReadonlyReviewInput, idValue?: string): WebGptV4Result<unknown> {
    const authorization = this.authorization(idValue);
    if (!Array.isArray(authorization)) return authorization;
    if (!authorization.includes(input.project_id)) return this.denied(idValue);
    return readReviewPackage(getProductionReviewPackage(input, this.db, idValue), input.detail ?? "compact", input.project_id, input.shot_id);
  }

  getDeliveryStatus(projectId: string, idValue?: string): WebGptV4Result<unknown> {
    const authorization = this.authorization(idValue);
    if (!Array.isArray(authorization)) return authorization;
    if (!authorization.includes(projectId)) return this.denied(idValue);
    return readDelivery(getProductionDeliveryStatus({ project_id: projectId }, this.db, idValue));
  }

  getCloseoutEvidence(projectId: string, idValue?: string): WebGptV4Result<unknown> {
    const authorization = this.authorization(idValue);
    if (!Array.isArray(authorization)) return authorization;
    if (!authorization.includes(projectId)) return this.denied(idValue);
    return readDelivery(getProductionCloseoutEvidence({ project_id: projectId }, this.db, idValue), true);
  }
}

export class SnapshotReadonlyDataSource implements ReadonlyDataSource {
  private readonly snapshot: ReadonlySnapshot;

  constructor(snapshot: ReadonlySnapshot, private readonly principalId: string, private readonly issuerHash: string) {
    this.snapshot = parseReadonlySnapshot(snapshot);
  }

  private id(idValue?: string): string { return requestId(idValue); }

  private authorizedProjectIds(): string[] | null {
    if (this.issuerHash !== this.snapshot.issuer_hash) return null;
    return this.snapshot.authorization.principals.find((item) => item.principal_id === this.principalId)?.project_ids ?? null;
  }

  private admission(idValue?: string): WebGptV4Result<never> | null {
    const id = this.id(idValue);
    if (readonlySnapshotStatus(this.snapshot).freshness_status !== "fresh") {
      return fail(id, { code: "WEBGPT_CLOUD_SNAPSHOT_EXPIRED", message: "The readonly snapshot has expired." });
    }
    if (this.authorizedProjectIds() === null) {
      return fail(id, { code: "WEBGPT_PRINCIPAL_NOT_REGISTERED", message: "This identity is not registered for the readonly snapshot." });
    }
    return null;
  }

  private project(projectId: string, idValue?: string): ReadonlyProjectProjection | WebGptV4Result<never> {
    const admission = this.admission(idValue);
    if (admission) return admission;
    if (!this.authorizedProjectIds()?.includes(projectId)) {
      return fail(this.id(idValue), { code: "PROJECT_NOT_FOUND", message: "Production project was not found.", field: "project_id" });
    }
    return this.snapshot.projects.find((item) => item.project_id === projectId)
      ?? fail(this.id(idValue), { code: "PROJECT_NOT_FOUND", message: "Production project was not found.", field: "project_id" });
  }

  listProductionProjects(input: ReadonlyProjectListInput = {}, idValue?: string): WebGptV4Result<unknown> {
    const admission = this.admission(idValue);
    if (admission) return admission;
    const detail = input.detail ?? "compact";
    const ids = new Set(this.authorizedProjectIds() ?? []);
    const query = input.query?.trim() ?? "";
    const candidates = this.snapshot.projects.filter((projection) => {
      if (!ids.has(projection.project_id)) return false;
      const item = projection.list_item_full;
      if (!input.include_archived && item.lifecycle !== "active") return false;
      return !query || sqliteContainsLike(projection.project_id, query) || sqliteContainsLike(item.project.title, query);
    });
    const limit = clamp(input.limit, 25, 100);
    const start = offset(input.offset);
    const selected = candidates.slice(start, start + limit).map((projection) => detail === "compact" ? projection.list_item_compact : projection.list_item_full);
    const hasMore = start + selected.length < candidates.length;
    const payload = {
      detail,
      items: structuredClone(selected),
      page: { limit, offset: start, total: candidates.length, has_more: hasMore, next_offset: hasMore ? start + limit : null }
    };
    return ok(this.id(idValue), WEBGPT_V4_PROJECT_LIST_DATA_SCHEMA.parse(payload), this.snapshot.generated_at);
  }

  getProjectContext(input: ReadonlyProjectContextInput, idValue?: string): WebGptV4Result<unknown> {
    const projection = this.project(input.project_id, idValue);
    if ("ok" in projection) return projection;
    const workspace = input.workspace ?? "overview";
    const found = projection.contexts.find((item) => item.workspace === workspace);
    if (!found) return fail(this.id(idValue), { code: "WEBGPT_CLOUD_SNAPSHOT_INVALID", message: "The readonly snapshot is missing a project context." });
    const payload = input.detail === "full" ? found.full : found.compact;
    return ok(this.id(idValue), structuredClone(payload), this.snapshot.generated_at);
  }

  listProjectShots(input: ReadonlyShotListInput, idValue?: string): WebGptV4Result<unknown> {
    const projection = this.project(input.project_id, idValue);
    if ("ok" in projection) return projection;
    const detail = input.detail ?? "compact";
    const items = detail === "full" ? projection.shots_full : projection.shots_compact;
    const limit = clamp(input.limit, 50, 100);
    const start = offset(input.offset);
    const selected = items.slice(start, start + limit);
    const hasMore = start + selected.length < items.length;
    return ok(this.id(idValue), WEBGPT_V4_SHOT_LIST_DATA_SCHEMA.parse({
      detail, items: structuredClone(selected),
      page: { limit, offset: start, total: items.length, has_more: hasMore, next_offset: hasMore ? start + limit : null }
    }), this.snapshot.generated_at);
  }

  getReviewPackage(input: ReadonlyReviewInput, idValue?: string): WebGptV4Result<unknown> {
    const projection = this.project(input.project_id, idValue);
    if ("ok" in projection) return projection;
    const found = projection.review_packages.find((item) => item.shot_id === input.shot_id);
    if (!found) return fail(this.id(idValue), { code: "SHOT_NOT_FOUND", message: "SHOT was not found in the production project.", field: "shot_id" });
    const payload = structuredClone(input.detail === "full" ? found.full : found.compact) as ReviewPackageData;
    if (input.artifact_id && !payload.versions.some((version) => version.artifact_id === input.artifact_id)) {
      return fail(this.id(idValue), { code: "ARTIFACT_NOT_IN_SHOT_REVIEW", message: "Artifact is not a version of the requested SHOT.", field: "artifact_id" });
    }
    payload.selected_artifact_id = input.artifact_id ?? payload.selected_artifact_id;
    payload.notes = payload.notes.slice(0, clamp(input.notes_limit, 10, 50));
    return ok(this.id(idValue), WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA.parse(payload), this.snapshot.generated_at);
  }

  getDeliveryStatus(projectId: string, idValue?: string): WebGptV4Result<unknown> {
    const projection = this.project(projectId, idValue);
    if ("ok" in projection) return projection;
    return ok(this.id(idValue), structuredClone(projection.delivery), this.snapshot.generated_at);
  }

  getCloseoutEvidence(projectId: string, idValue?: string): WebGptV4Result<unknown> {
    const projection = this.project(projectId, idValue);
    if ("ok" in projection) return projection;
    return ok(this.id(idValue), structuredClone(projection.closeout), this.snapshot.generated_at);
  }
}

const forbiddenProjectionKeys = new Set([
  "uri", "path", "local_path", "storage_directory", "signed_url", "provider_payload",
  "author_hash", "actor_hash", "token", "cookie", "subject", "idempotency_key"
]);

function assertNoForbiddenProjectionFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenProjectionFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenProjectionKeys.has(key.toLocaleLowerCase())) {
      throw new ReadonlyProjectionError("READONLY_PROJECTION_FORBIDDEN_FIELD", "Readonly projection contains a forbidden field.");
    }
    assertNoForbiddenProjectionFields(item);
  }
}

function allPages<T>(load: (offset: number) => WebGptV4Result<unknown>, schema: z.ZodType<T & { items: unknown[]; page: { next_offset: number | null } }>): T {
  let currentOffset = 0;
  let first: (T & { items: unknown[]; page: { next_offset: number | null } }) | null = null;
  const items: unknown[] = [];
  do {
    const page = requireSuccess(load(currentOffset), schema);
    if (!first) first = page;
    items.push(...page.items);
    if (page.page.next_offset === null) break;
    currentOffset = page.page.next_offset;
  } while (true);
  if (!first) throw new ReadonlyProjectionError("READONLY_PROJECTION_EMPTY_PAGE", "Readonly projection did not produce a page.");
  return { ...first, items, page: { ...first.page, offset: 0, total: items.length, has_more: false, next_offset: null } } as T;
}

export type ExportReadonlySnapshotInput = {
  database_path: string;
  issuer_hash: string;
  resource_url: string;
  generated_at?: string;
  ttl_seconds?: number;
};

export function exportReadonlySnapshotFromDatabase(input: ExportReadonlySnapshotInput): ReadonlySnapshot {
  const db = openM0DatabaseConnection(input.database_path, { readOnly: true });
  let transactionOpen = false;
  try {
    db.exec("BEGIN;");
    transactionOpen = true;
    try {
      assertSchemaCurrent(db);
    } catch (error) {
      if (error instanceof SchemaMigrationRequiredError) {
        throw new ReadonlyProjectionError(
          "READONLY_PROJECTION_SCHEMA_MIGRATION_REQUIRED",
          `Readonly projection requires schema ${READONLY_SNAPSHOT_REQUIRED_SCHEMA} at migration ${READONLY_SNAPSHOT_REQUIRED_MIGRATION}.`
        );
      }
      throw error;
    }

    if (!/^[0-9a-f]{64}$/.test(input.issuer_hash)) {
      throw new ReadonlyProjectionError("READONLY_PROJECTION_INVALID_ISSUER", "Readonly projection issuer hash is invalid.");
    }

    const principals = (db.prepare(`SELECT p.principal_id
      FROM webgpt_auth_principals p
      JOIN webgpt_auth_principal_bindings b ON b.workspace_id = p.workspace_id AND b.principal_id = p.principal_id
      WHERE p.status = 'active' AND b.issuer_hash = ?
      ORDER BY p.principal_id`).all(input.issuer_hash) as Array<{ principal_id: string }>).map((principal) => ({
        principal_id: principal.principal_id,
        project_ids: authorizedWebGptProjectIds(db, principal.principal_id, input.issuer_hash)
      }));
    const projectIds = [...new Set(principals.flatMap((principal) => principal.project_ids))];

    const listFor = (detail: WebGptV4Detail): ProjectListData => allPages(
      (pageOffset) => readProjectList(listProductionProjects({ include_archived: true, limit: 100, offset: pageOffset }, db, "readonly_export", projectIds), detail),
      WEBGPT_V4_PROJECT_LIST_DATA_SCHEMA
    );
    const compactList = listFor("compact");
    const fullList = listFor("full");
    const compactItems = new Map(compactList.items.map((item) => {
      const parsed = WEBGPT_V4_COMPACT_PROJECT_LIST_ITEM_SCHEMA.parse(item);
      return [parsed.project.project_id, parsed] as const;
    }));
    const fullItems = new Map(fullList.items.map((item) => {
      const parsed = WEBGPT_V4_FULL_PROJECT_LIST_ITEM_SCHEMA.parse(item);
      return [parsed.project.project_id, parsed] as const;
    }));
    const workspaces = ["overview", "storyboard", "generation", "review", "delivery"] as const;

    const projects: ReadonlyProjectProjection[] = [...fullItems.values()].map((fullItem) => {
      const projectId = fullItem.project.project_id;
      const compactItem = compactItems.get(projectId);
      if (!compactItem) throw new ReadonlyProjectionError("READONLY_PROJECTION_CONTRACT_VIOLATION", "Compact project projection is missing.");
      const contexts = workspaces.map((workspace) => ({
        workspace,
        compact: requireSuccess(readProjectContext(getProductionProjectContext({ project_id: projectId, workspace }, db, "readonly_export"), "compact"), WEBGPT_V4_PROJECT_CONTEXT_DATA_SCHEMA),
        full: requireSuccess(readProjectContext(getProductionProjectContext({ project_id: projectId, workspace }, db, "readonly_export"), "full"), WEBGPT_V4_PROJECT_CONTEXT_DATA_SCHEMA)
      }));
      const shotList = (detail: WebGptV4Detail): ShotListData => allPages(
        (pageOffset) => readShotList(listProductionProjectShots({ project_id: projectId, limit: 100, offset: pageOffset }, db, "readonly_export"), detail),
        WEBGPT_V4_SHOT_LIST_DATA_SCHEMA
      );
      const compactShots = shotList("compact");
      const fullShots = shotList("full");
      const compactShotItems = compactShots.items.map((shot) => WEBGPT_V4_COMPACT_SHOT_SCHEMA.parse(shot));
      const fullShotItems = fullShots.items.map((shot) => WEBGPT_V4_SHOT_SCHEMA.parse(shot));
      const reviewPackages = fullShotItems.map((shot) => ({
        shot_id: shot.shot_id,
        compact: requireSuccess(readReviewPackage(getProductionReviewPackage({ project_id: projectId, shot_id: shot.shot_id, notes_limit: 50 }, db, "readonly_export"), "compact", projectId, shot.shot_id), WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA),
        full: requireSuccess(readReviewPackage(getProductionReviewPackage({ project_id: projectId, shot_id: shot.shot_id, notes_limit: 50 }, db, "readonly_export"), "full", projectId, shot.shot_id), WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA)
      }));
      return {
        project_id: projectId,
        list_item_compact: compactItem,
        list_item_full: fullItem,
        contexts,
        shots_compact: compactShotItems,
        shots_full: fullShotItems,
        review_packages: reviewPackages,
        delivery: requireSuccess(readDelivery(getProductionDeliveryStatus({ project_id: projectId }, db, "readonly_export")), WEBGPT_V4_DELIVERY_DATA_SCHEMA),
        closeout: requireSuccess(readDelivery(getProductionCloseoutEvidence({ project_id: projectId }, db, "readonly_export"), true), WEBGPT_V4_CLOSEOUT_DATA_SCHEMA)
      };
    });
    assertNoForbiddenProjectionFields(projects);

    const generatedAt = input.generated_at ?? new Date().toISOString();
    const ttlSeconds = input.ttl_seconds ?? 24 * 60 * 60;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 24 * 60 * 60) {
      throw new ReadonlyProjectionError("READONLY_PROJECTION_INVALID_TTL", "Readonly projection TTL must be an integer between 1 and 86400 seconds.");
    }
    const unsigned: ReadonlySnapshotUnsigned = {
      schema_version: READONLY_SNAPSHOT_SCHEMA_VERSION,
      source_schema: READONLY_SNAPSHOT_REQUIRED_SCHEMA,
      source_migration: READONLY_SNAPSHOT_REQUIRED_MIGRATION,
      source_version: WEBGPT_V4_VERSION,
      generated_at: generatedAt,
      expires_at: new Date(Date.parse(generatedAt) + ttlSeconds * 1000).toISOString(),
      resource_url: input.resource_url,
      issuer_hash: input.issuer_hash,
      authorization: { principals },
      projects
    };
    const snapshot = finalizeReadonlySnapshot(unsigned);
    db.exec("COMMIT;");
    transactionOpen = false;
    return snapshot;
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Preserve the original export failure.
      }
    }
    throw error;
  } finally {
    db.close();
  }
}
