import {
  WEBGPT_V4_PROJECT_LIST_DATA_SCHEMA,
  WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA,
  WEBGPT_V4_SHOT_LIST_DATA_SCHEMA
} from "../webgpt-v4/contracts.js";
import { fail, ok, requestId, type WebGptV4Result } from "../webgpt-v4/types.js";
import type {
  ReadonlyDataSource,
  ReadonlyProjectContextInput,
  ReadonlyProjectListInput,
  ReadonlyReviewInput,
  ReadonlyShotListInput
} from "./dataSourceContract.js";
import {
  parseReadonlySnapshot,
  readonlySnapshotStatus,
  type ReadonlyProjectProjection,
  type ReadonlySnapshot
} from "./snapshot.js";

type ReviewPackageData = ReturnType<typeof WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA.parse>;

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

export class SnapshotReadonlyDataSource implements ReadonlyDataSource {
  private readonly snapshot: ReadonlySnapshot;

  constructor(
    snapshot: ReadonlySnapshot,
    private readonly principalId: string,
    private readonly issuerHash: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.snapshot = parseReadonlySnapshot(snapshot, this.now());
  }

  private id(idValue?: string): string { return requestId(idValue); }

  private authorizedProjectIds(): string[] | null {
    if (this.issuerHash !== this.snapshot.issuer_hash) return null;
    return this.snapshot.authorization.principals.find((item) => item.principal_id === this.principalId)?.project_ids ?? null;
  }

  private admission(idValue?: string): WebGptV4Result<never> | null {
    const id = this.id(idValue);
    if (readonlySnapshotStatus(this.snapshot, this.now()).freshness_status !== "fresh") {
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
    return ok(this.id(idValue), WEBGPT_V4_PROJECT_LIST_DATA_SCHEMA.parse({
      detail,
      items: structuredClone(selected),
      page: { limit, offset: start, total: candidates.length, has_more: hasMore, next_offset: hasMore ? start + limit : null }
    }), this.snapshot.generated_at);
  }

  getProjectContext(input: ReadonlyProjectContextInput, idValue?: string): WebGptV4Result<unknown> {
    const projection = this.project(input.project_id, idValue);
    if ("ok" in projection) return projection;
    const workspace = input.workspace ?? "overview";
    const found = projection.contexts.find((item) => item.workspace === workspace);
    if (!found) return fail(this.id(idValue), { code: "WEBGPT_CLOUD_SNAPSHOT_INVALID", message: "The readonly snapshot is missing a project context." });
    return ok(this.id(idValue), structuredClone(input.detail === "full" ? found.full : found.compact), this.snapshot.generated_at);
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
