import { z } from "zod/v4";

import { assertSchemaCurrent, SchemaMigrationRequiredError } from "../storage/migrations.js";
import { openM0DatabaseConnection, type M0Database } from "../storage/sqlite.js";
import { getProject } from "../tools/projects.js";
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
  READONLY_PROJECT_PROJECTION_SCHEMA,
  READONLY_SNAPSHOT_REQUIRED_MIGRATION,
  READONLY_SNAPSHOT_REQUIRED_SCHEMA,
  READONLY_SNAPSHOT_SCHEMA_VERSION,
  type ReadonlyProjectProjection,
  type ReadonlySnapshot,
  type ReadonlySnapshotUnsigned
} from "./snapshot.js";
import type {
  ReadonlyDataSource,
  ReadonlyProjectContextInput,
  ReadonlyProjectListInput,
  ReadonlyReviewInput,
  ReadonlyShotListInput
} from "./dataSourceContract.js";

export type {
  ReadonlyDataSource,
  ReadonlyProjectContextInput,
  ReadonlyProjectListInput,
  ReadonlyReviewInput,
  ReadonlyShotListInput
} from "./dataSourceContract.js";
export { SnapshotReadonlyDataSource } from "./snapshotDataSource.js";

type ProjectListData = z.infer<typeof WEBGPT_V4_PROJECT_LIST_DATA_SCHEMA>;
type ShotListData = z.infer<typeof WEBGPT_V4_SHOT_LIST_DATA_SCHEMA>;

export class ReadonlyProjectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
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
      const sourceProject = getProject(db, projectId);
      if (!sourceProject) throw new ReadonlyProjectionError("READONLY_PROJECTION_CONTRACT_VIOLATION", "Source project is missing during readonly export.");
      const compactItem = compactItems.get(projectId);
      if (!compactItem) throw new ReadonlyProjectionError("READONLY_PROJECTION_CONTRACT_VIOLATION", "Compact project projection is missing.");
      const shotList = (detail: WebGptV4Detail): ShotListData => allPages(
        (pageOffset) => readShotList(listProductionProjectShots({ project_id: projectId, limit: 100, offset: pageOffset }, db, "readonly_export"), detail),
        WEBGPT_V4_SHOT_LIST_DATA_SCHEMA
      );
      const compactShots = shotList("compact");
      const fullShots = shotList("full");
      const compactShotItems = compactShots.items.map((shot) => WEBGPT_V4_COMPACT_SHOT_SCHEMA.parse(shot));
      const fullShotItems = fullShots.items.map((shot) => WEBGPT_V4_SHOT_SCHEMA.parse(shot));
      const contexts = workspaces.map((workspace) => {
        const compact = requireSuccess(readProjectContext(getProductionProjectContext({ project_id: projectId, workspace }, db, "readonly_export"), "compact"), WEBGPT_V4_PROJECT_CONTEXT_DATA_SCHEMA);
        const full = requireSuccess(readProjectContext(getProductionProjectContext({ project_id: projectId, workspace }, db, "readonly_export"), "full"), WEBGPT_V4_PROJECT_CONTEXT_DATA_SCHEMA);
        return { workspace, compact, full };
      });
      const firstFullContext = contexts[0]?.full;
      if (!firstFullContext || !("meta" in firstFullContext)) {
        throw new ReadonlyProjectionError("READONLY_PROJECTION_CONTRACT_VIOLATION", "Full project context projection is missing metadata.");
      }
      const reviewPackages = fullShotItems.map((shot) => ({
        shot_id: shot.shot_id,
        compact: requireSuccess(readReviewPackage(getProductionReviewPackage({ project_id: projectId, shot_id: shot.shot_id, notes_limit: 50 }, db, "readonly_export"), "compact", projectId, shot.shot_id), WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA),
        full: requireSuccess(readReviewPackage(getProductionReviewPackage({ project_id: projectId, shot_id: shot.shot_id, notes_limit: 50 }, db, "readonly_export"), "full", projectId, shot.shot_id), WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA)
      }));
      return READONLY_PROJECT_PROJECTION_SCHEMA.parse({
        project_id: projectId,
        final_video_artifact_id: sourceProject.exports.final_video_artifact_id,
        context_meta_updated_at: firstFullContext.meta.updated_at,
        list_item_compact: compactItem,
        list_item_full: fullItem,
        contexts,
        shots_compact: compactShotItems,
        shots_full: fullShotItems,
        review_packages: reviewPackages,
        delivery: requireSuccess(readDelivery(getProductionDeliveryStatus({ project_id: projectId }, db, "readonly_export")), WEBGPT_V4_DELIVERY_DATA_SCHEMA),
        closeout: requireSuccess(readDelivery(getProductionCloseoutEvidence({ project_id: projectId }, db, "readonly_export"), true), WEBGPT_V4_CLOSEOUT_DATA_SCHEMA)
      });
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
