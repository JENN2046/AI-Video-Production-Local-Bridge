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
  WEBGPT_V4_COMPACT_SHOT_SCHEMA,
  publicArtifact,
  publicProject,
  publicShot,
  publicSummary
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

const compactProjectContextDataSchema = WEBGPT_V4_PROJECT_CONTEXT_DATA_SCHEMA.refine(
  (value) => value.detail === "compact",
  "Compact context slot requires a compact DTO."
);
const fullProjectContextDataSchema = WEBGPT_V4_PROJECT_CONTEXT_DATA_SCHEMA.refine(
  (value) => value.detail === "full",
  "Full context slot requires a full DTO."
);
const compactReviewPackageDataSchema = WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA.refine(
  (value) => value.detail === "compact",
  "Compact review slot requires a compact DTO."
);
const fullReviewPackageDataSchema = WEBGPT_V4_REVIEW_PACKAGE_DATA_SCHEMA.refine(
  (value) => value.detail === "full",
  "Full review slot requires a full DTO."
);

const contextProjectionSchema = z.object({
  workspace: z.enum(["overview", "storyboard", "generation", "review", "delivery"]),
  compact: compactProjectContextDataSchema,
  full: fullProjectContextDataSchema
}).strict();

const reviewProjectionSchema = z.object({
  shot_id: z.string().min(1),
  compact: compactReviewPackageDataSchema,
  full: fullReviewPackageDataSchema
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
type FullContextProjection = ReadonlyProjectProjectionShape["contexts"][number]["full"];
type FullReviewProjection = ReadonlyProjectProjectionShape["review_packages"][number]["full"];

function compactContextFromFull(value: FullContextProjection): unknown {
  const base = {
    detail: "compact" as const,
    project: publicProject(value.project, true),
    summary: value.summary,
    workspace: value.workspace
  };
  if (value.workspace === "overview") return { ...base, metrics: value.metrics, blockers: value.blockers };
  if (value.workspace === "storyboard" || value.workspace === "generation") {
    return { ...base, shots: value.shots.map((shot) => publicShot(shot, true)) };
  }
  if (value.workspace === "review") {
    return { ...base, shots: value.shots.map((shot) => publicShot(shot, true)), review_notes: value.review_notes };
  }
  return {
    ...base,
    ready_for_assembly: value.ready_for_assembly,
    readiness_checks: value.readiness_checks,
    accepted_clips: value.accepted_clips.map((clip) => ({
      shot_id: clip.shot_id,
      order: clip.order,
      artifact: clip.artifact ? publicArtifact(clip.artifact, true) : null
    })),
    final_artifact: value.final_artifact ? publicArtifact(value.final_artifact, true) : null,
    final_artifact_reason_code: value.final_artifact_reason_code
  };
}

function compactReviewFromFull(value: FullReviewProjection): unknown {
  return {
    detail: "compact" as const,
    shot: publicShot(value.shot, true),
    versions: value.versions.map((version) => ({
      artifact_id: version.artifact_id,
      attempt_number: version.attempt_number,
      review_status: version.review_status
    })),
    notes: value.notes,
    notes_total: value.notes_total,
    selected_artifact_id: value.selected_artifact_id
  };
}

function shotParityValue<T extends { updated_at?: string }>(value: T): Omit<T, "updated_at"> {
  const { updated_at: _updatedAt, ...stable } = value;
  return stable;
}

function expectedDeliveryContextSummary(project: ReadonlyProjectProjectionShape): ReadonlyProjectProjectionShape["list_item_full"]["summary"] {
  const summary = structuredClone(project.list_item_full.summary);
  if (project.delivery.final_artifact || project.delivery.final_artifact_reason_code) return summary;
  const invalidCount = project.delivery.readiness_checks.filter((check) => Boolean(check.artifact_id) && !check.ok).length;
  const readinessDerived = project.delivery.ready_for_assembly
    ? { label: "合成交付", reason_code: "assemble", priority: "high" as const }
    : { label: "修复无效采纳片段", reason_code: "accepted_clip_invalid", priority: "urgent" as const };
  const derived = summary.next_action.derived.reason_code === "assembly_readiness_required"
    ? readinessDerived
    : summary.next_action.derived;
  const preserveOverride = summary.next_action.source === "override" && invalidCount === 0;
  const blockerCount = summary.blocker_count + invalidCount;
  return {
    ...summary,
    blocker_count: blockerCount,
    blocker_reason: [summary.blocker_reason, invalidCount > 0 ? `${invalidCount} 个采纳片段无效` : ""].filter(Boolean).join("、"),
    delivery_state: project.delivery.ready_for_assembly ? "ready_to_assemble" : "not_ready",
    next_action: preserveOverride
      ? { ...summary.next_action, derived }
      : { source: "derived", ...derived, expires_at: null, derived },
    risk: blockerCount > 0
      ? "blocked"
      : summary.active_run_count > 0 || summary.review_pending_count > 0
        ? "attention"
        : "clear"
  };
}

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

function validateGeneratedClipArtifact(
  artifact: { artifact_type: string; role: string; status: string; linked_objects: { shot_id: string } },
  expectedShotId: string,
  path: Array<string | number>,
  context: z.core.$RefinementCtx
): void {
  if (artifact.artifact_type !== "video" || artifact.role !== "generated_clip" || artifact.status !== "active" || artifact.linked_objects.shot_id !== expectedShotId) {
    addBindingIssue(context, path, "Generated clip artifact contract mismatch.");
  }
}

function validateFinalArtifact(
  artifact: { artifact_type: string; role: string; status: string; linked_objects: { shot_id: string } } | null,
  path: Array<string | number>,
  context: z.core.$RefinementCtx
): void {
  if (!artifact) return;
  if (artifact.artifact_type !== "video" || artifact.role !== "final_video" || artifact.status !== "active" || artifact.linked_objects.shot_id !== "") {
    addBindingIssue(context, path, "Final artifact contract mismatch.");
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
  const compactShotIds = new Set(project.shots_compact.map((shot) => shot.shot_id));
  const reviewByShot = new Map(project.review_packages.map((review) => [review.shot_id, review]));
  if (shotIds.size !== project.shots_full.length) addBindingIssue(context, [...base, "shots_full"], "Duplicate full SHOT binding.");
  if (compactShotIds.size !== project.shots_compact.length) addBindingIssue(context, [...base, "shots_compact"], "Duplicate compact SHOT binding.");

  if (project.list_item_compact.project.project_id !== projectId || project.list_item_full.project.project_id !== projectId) {
    addBindingIssue(context, base, "Projected project binding mismatch.");
  }
  const expectedCompactListItem = WEBGPT_V4_COMPACT_PROJECT_LIST_ITEM_SCHEMA.parse({
    project: publicProject(project.list_item_full.project, true),
    lifecycle: project.list_item_full.lifecycle,
    pinned: project.list_item_full.pinned,
    updated_at: project.list_item_full.updated_at,
    summary: publicSummary(project.list_item_full.summary, true)
  });
  if (canonicalizeJcs(project.list_item_compact) !== canonicalizeJcs(expectedCompactListItem)) {
    addBindingIssue(context, [...base, "list_item_compact"], "Compact/full project list parity mismatch.");
  }
  for (const [shotIndex, shot] of project.shots_compact.entries()) {
    if (shot.project_id !== projectId) addBindingIssue(context, [...base, "shots_compact", shotIndex, "project_id"], "SHOT project binding mismatch.");
    if (!shotIds.has(shot.shot_id)) addBindingIssue(context, [...base, "shots_compact", shotIndex, "shot_id"], "Compact SHOT is absent from the full SHOT projection.");
    const fullShot = project.shots_full.find((candidate) => candidate.shot_id === shot.shot_id);
    if (fullShot) {
      const expectedCompactShot = WEBGPT_V4_COMPACT_SHOT_SCHEMA.parse(publicShot(fullShot, true));
      if (canonicalizeJcs(shot) !== canonicalizeJcs(expectedCompactShot)) {
        addBindingIssue(context, [...base, "shots_compact", shotIndex], "Compact/full SHOT parity mismatch.");
      }
    }
  }
  if (compactShotIds.size !== shotIds.size || [...shotIds].some((shotId) => !compactShotIds.has(shotId))) {
    addBindingIssue(context, [...base, "shots_compact"], "Compact and full SHOT bindings differ.");
  }
  if (project.shots_compact.some((shot, shotIndex) => shot.shot_id !== project.shots_full[shotIndex]?.shot_id)) {
    addBindingIssue(context, [...base, "shots_compact"], "Compact and full SHOT ordering differs.");
  }
  for (const [shotIndex, shot] of project.shots_full.entries()) {
    if (shot.project_id !== projectId) addBindingIssue(context, [...base, "shots_full", shotIndex, "project_id"], "SHOT project binding mismatch.");
  }
  const listedShotIds = project.list_item_full.project.shot_ids;
  if (listedShotIds.length !== shotIds.size || listedShotIds.some((shotId) => !shotIds.has(shotId))) {
    addBindingIssue(context, [...base, "list_item_full", "project", "shot_ids"], "Project SHOT list binding mismatch.");
  }
  if (listedShotIds.some((shotId, shotIndex) => shotId !== project.shots_full[shotIndex]?.shot_id)) {
    addBindingIssue(context, [...base, "list_item_full", "project", "shot_ids"], "Project SHOT list ordering differs.");
  }

  const canonicalSummary = project.list_item_full.summary;
  const expectedSummaryState = {
    shot_count: project.shots_full.length,
    accepted_count: project.shots_full.filter((shot) => Boolean(shot.accepted_clip_artifact_id)).length,
    review_pending_count: project.shots_full.filter((shot) => shot.clip_versions.length > 0 && shot.review.approval_status === "pending").length,
    delivery_state: project.list_item_full.project.status === "final_approved"
      ? "delivered"
      : project.delivery.final_artifact || project.delivery.final_artifact_reason_code
        ? "final_review"
        : "not_ready"
  };
  if (canonicalSummary.shot_count !== expectedSummaryState.shot_count
    || canonicalSummary.accepted_count !== expectedSummaryState.accepted_count
    || canonicalSummary.review_pending_count !== expectedSummaryState.review_pending_count
    || canonicalSummary.delivery_state !== expectedSummaryState.delivery_state) {
    addBindingIssue(context, [...base, "list_item_full", "summary"], "Project summary canonical state mismatch.");
  }

  const contextWorkspaces = new Set(project.contexts.map((projection) => projection.workspace));
  if (contextWorkspaces.size !== project.contexts.length) addBindingIssue(context, [...base, "contexts"], "Duplicate project context workspace.");
  const canonicalContextMeta = project.contexts[0]?.full.meta;
  for (const [contextIndex, projection] of project.contexts.entries()) {
    for (const [detail, value] of [["compact", projection.compact], ["full", projection.full]] as const) {
      const path = [...base, "contexts", contextIndex, detail] as Array<string | number>;
      if (value.workspace !== projection.workspace) addBindingIssue(context, [...path, "workspace"], "Context workspace binding mismatch.");
      if (value.project.project_id !== projectId) addBindingIssue(context, [...path, "project", "project_id"], "Context project binding mismatch.");
      if ("meta" in value) {
        const expectedListMeta = {
          project_id: projectId,
          classification: "production",
          lifecycle: project.list_item_full.lifecycle,
          pinned: project.list_item_full.pinned,
          last_opened_at: project.list_item_full.last_opened_at
        };
        const listComparableMeta = {
          project_id: value.meta.project_id,
          classification: value.meta.classification,
          lifecycle: value.meta.lifecycle,
          pinned: value.meta.pinned,
          last_opened_at: value.meta.last_opened_at
        };
        if (canonicalizeJcs(listComparableMeta) !== canonicalizeJcs(expectedListMeta)
          || (canonicalContextMeta && canonicalizeJcs(value.meta) !== canonicalizeJcs(canonicalContextMeta))) {
          addBindingIssue(context, [...path, "meta"], "Context metadata canonical projection mismatch.");
        }
      }
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
          const canonicalVersionIds = new Set(reviewByShot.get(note.shot_id)?.full.versions.map((version) => version.artifact_id) ?? []);
          if (note.artifact_id && !canonicalVersionIds.has(note.artifact_id)) {
            addBindingIssue(context, [...path, "review_notes", noteIndex, "artifact_id"], "Review context note artifact is absent from the canonical SHOT versions.");
          }
        }
      }
      if ("accepted_clips" in value) {
        for (const [clipIndex, clip] of value.accepted_clips.entries()) {
          if (!shotIds.has(clip.shot_id)) addBindingIssue(context, [...path, "accepted_clips", clipIndex, "shot_id"], "Accepted clip SHOT binding mismatch.");
          validateArtifactBinding(clip.artifact, projectId, clip.shot_id, [...path, "accepted_clips", clipIndex, "artifact"], context);
          if (clip.artifact) validateGeneratedClipArtifact(clip.artifact, clip.shot_id, [...path, "accepted_clips", clipIndex, "artifact"], context);
        }
        validateArtifactBinding(value.final_artifact, projectId, null, [...path, "final_artifact"], context);
        validateFinalArtifact(value.final_artifact, [...path, "final_artifact"], context);
        if (value.final_artifact && value.final_artifact_reason_code) {
          addBindingIssue(context, [...path, "final_artifact_reason_code"], "Usable final artifact cannot carry an error reason.");
        }
        if (value.accepted_clips.some((clip, clipIndex) => clip.shot_id !== project.shots_full[clipIndex]?.shot_id)) {
          addBindingIssue(context, [...path, "accepted_clips"], "Delivery context accepted-clip ordering differs.");
        }
      }
    }
    const expectedCompactContext = compactProjectContextDataSchema.parse(compactContextFromFull(projection.full));
    if (canonicalizeJcs(projection.compact) !== canonicalizeJcs(expectedCompactContext)) {
      addBindingIssue(context, [...base, "contexts", contextIndex, "compact"], "Compact/full context parity mismatch.");
    }
    if (canonicalizeJcs(projection.full.project) !== canonicalizeJcs(project.list_item_full.project)) {
      addBindingIssue(context, [...base, "contexts", contextIndex, "full", "project"], "Context/project canonical projection mismatch.");
    }
    const expectedContextSummary = projection.workspace === "delivery"
      ? expectedDeliveryContextSummary(project)
      : project.list_item_full.summary;
    if (canonicalizeJcs(projection.full.summary) !== canonicalizeJcs(expectedContextSummary)) {
      addBindingIssue(context, [...base, "contexts", contextIndex, "full", "summary"], "Context summary canonical projection mismatch.");
    }
    if ("shots" in projection.full
      && canonicalizeJcs(projection.full.shots.map(shotParityValue)) !== canonicalizeJcs(project.shots_full.map(shotParityValue))) {
      addBindingIssue(context, [...base, "contexts", contextIndex, "full", "shots"], "Context/canonical SHOT projection mismatch.");
    }
    if (projection.full.workspace === "delivery") {
      const sharedDelivery = {
        ready_for_assembly: project.delivery.ready_for_assembly,
        readiness_checks: project.delivery.readiness_checks,
        final_artifact: project.delivery.final_artifact,
        final_artifact_reason_code: project.delivery.final_artifact_reason_code
      };
      const contextDelivery = {
        ready_for_assembly: projection.full.ready_for_assembly,
        readiness_checks: projection.full.readiness_checks,
        final_artifact: projection.full.final_artifact,
        final_artifact_reason_code: projection.full.final_artifact_reason_code
      };
      if (canonicalizeJcs(contextDelivery) !== canonicalizeJcs(sharedDelivery)) {
        addBindingIssue(context, [...base, "contexts", contextIndex, "full"], "Context/delivery canonical projection mismatch.");
      }
      const clipsByShot = new Map(projection.full.accepted_clips.map((clip) => [clip.shot_id, clip]));
      if (clipsByShot.size !== projection.full.accepted_clips.length || clipsByShot.size !== project.shots_full.length) {
        addBindingIssue(context, [...base, "contexts", contextIndex, "full", "accepted_clips"], "Delivery context accepted-clip SHOT set mismatch.");
      }
      const checksByShot = new Map(project.delivery.readiness_checks.map((check) => [check.shot_id, check]));
      for (const shot of project.shots_full) {
        const clip = clipsByShot.get(shot.shot_id);
        const check = checksByShot.get(shot.shot_id);
        const canonicalArtifact = reviewByShot.get(shot.shot_id)?.full.versions
          .find((version) => version.artifact_id === shot.accepted_clip_artifact_id)?.artifact;
        if (!clip || !check) continue;
        if (clip.order !== shot.order
          || (check.ok && (!clip.artifact || clip.artifact.artifact_id !== shot.accepted_clip_artifact_id))
          || (check.ok && (!canonicalArtifact || canonicalizeJcs(clip.artifact) !== canonicalizeJcs(canonicalArtifact)))
          || (!check.ok && clip.artifact !== null)) {
          addBindingIssue(context, [...base, "contexts", contextIndex, "full", "accepted_clips"], "Delivery context accepted-clip projection mismatch.");
        }
      }
    } else if (projection.full.workspace === "overview") {
      const expectedMetrics = {
        shots: project.shots_full.length,
        storyboard_approved: project.shots_full.filter((shot) => shot.status === "storyboard_approved").length,
        review_pending: project.shots_full.filter((shot) => shot.clip_versions.length > 0 && shot.review.approval_status === "pending").length,
        accepted_clips: project.shots_full.filter((shot) => Boolean(shot.accepted_clip_artifact_id)).length
      };
      const { generation_active: _generationActive, ...shotDerivedMetrics } = projection.full.metrics;
      const expectedBlockers = project.shots_full
        .filter((shot) => !shot.storyboard_image_artifact_id || !shot.video_prompt)
        .map((shot) => ({
          shot_id: shot.shot_id,
          order: shot.order,
          missing_image: !shot.storyboard_image_artifact_id,
          missing_prompt: !shot.video_prompt
        }));
      if (canonicalizeJcs(shotDerivedMetrics) !== canonicalizeJcs(expectedMetrics)
        || canonicalizeJcs(projection.full.blockers) !== canonicalizeJcs(expectedBlockers)) {
        addBindingIssue(context, [...base, "contexts", contextIndex, "full"], "Overview metrics or blockers canonical projection mismatch.");
      }
    }
  }

  const reviewShotIds = new Set(project.review_packages.map((review) => review.shot_id));
  if (reviewShotIds.size !== project.review_packages.length) addBindingIssue(context, [...base, "review_packages"], "Duplicate review package SHOT binding.");
  if (reviewShotIds.size !== shotIds.size || [...shotIds].some((shotId) => !reviewShotIds.has(shotId))) {
    addBindingIssue(context, [...base, "review_packages"], "Review package and full SHOT bindings differ.");
  }
  if (project.review_packages.some((review, reviewIndex) => review.shot_id !== project.shots_full[reviewIndex]?.shot_id)) {
    addBindingIssue(context, [...base, "review_packages"], "Review package SHOT ordering differs.");
  }
  for (const [reviewIndex, review] of project.review_packages.entries()) {
    const path = [...base, "review_packages", reviewIndex] as Array<string | number>;
    if (!shotIds.has(review.shot_id)) addBindingIssue(context, [...path, "shot_id"], "Review package SHOT binding mismatch.");
    for (const [detail, value] of [["compact", review.compact], ["full", review.full]] as const) {
      const detailPath = [...path, detail] as Array<string | number>;
      if (value.shot.project_id !== projectId || value.shot.shot_id !== review.shot_id) {
        addBindingIssue(context, [...detailPath, "shot"], "Review package SHOT binding mismatch.");
      }
      if (value.notes_total < 0 || value.notes_total < value.notes.length) {
        addBindingIssue(context, [...detailPath, "notes_total"], "Review notes total is smaller than returned notes.");
      }
      if (detail === "full") {
        const canonicalShot = project.shots_full.find((shot) => shot.shot_id === review.shot_id);
        if (canonicalShot && canonicalizeJcs(shotParityValue(value.shot)) !== canonicalizeJcs(shotParityValue(canonicalShot))) {
          addBindingIssue(context, [...detailPath, "shot"], "Review/project SHOT parity mismatch.");
        }
      }
      for (const [noteIndex, note] of value.notes.entries()) {
        if (note.project_id !== projectId || note.shot_id !== review.shot_id) {
          addBindingIssue(context, [...detailPath, "notes", noteIndex], "Review package note binding mismatch.");
        }
      }
      for (const [versionIndex, version] of value.versions.entries()) {
        if ("artifact" in version) {
          const artifact = version.artifact as {
            artifact_id: string;
            artifact_type: string;
            role: string;
            status: string;
            linked_objects: { project_id: string; shot_id: string };
          };
          validateArtifactBinding(
            artifact,
            projectId,
            review.shot_id,
            [...detailPath, "versions", versionIndex, "artifact"],
            context
          );
          if (artifact.artifact_id !== version.artifact_id) {
            addBindingIssue(context, [...detailPath, "versions", versionIndex, "artifact", "artifact_id"], "Review version artifact id mismatch.");
          }
          validateGeneratedClipArtifact(artifact, review.shot_id, [...detailPath, "versions", versionIndex, "artifact"], context);
        }
      }
    }
    const expectedCompactReview = compactReviewPackageDataSchema.parse(compactReviewFromFull(review.full));
    if (canonicalizeJcs(review.compact) !== canonicalizeJcs(expectedCompactReview)) {
      addBindingIssue(context, [...path, "compact"], "Compact/full review package parity mismatch.");
    }
    const canonicalShot = project.shots_full.find((shot) => shot.shot_id === review.shot_id);
    const versionIds = new Set(review.full.versions.map((version) => version.artifact_id));
    const projectedVersions = review.full.versions.map(({ artifact: _artifact, ...version }) => version);
    if (canonicalShot && canonicalizeJcs(projectedVersions) !== canonicalizeJcs(canonicalShot.clip_versions)) {
      addBindingIssue(context, [...path, "full", "versions"], "Review version stack differs from the canonical SHOT versions.");
    }
    for (const [noteIndex, note] of review.full.notes.entries()) {
      if (note.artifact_id && !versionIds.has(note.artifact_id)) {
        addBindingIssue(context, [...path, "full", "notes", noteIndex, "artifact_id"], "Review note artifact is absent from the canonical SHOT versions.");
      }
    }
    if (canonicalShot?.accepted_clip_artifact_id && !versionIds.has(canonicalShot.accepted_clip_artifact_id)) {
      addBindingIssue(context, [...path, "full", "versions"], "Accepted clip is absent from the SHOT review versions.");
    }
    if (canonicalShot
      && review.full.selected_artifact_id !== canonicalShot.accepted_clip_artifact_id
      && !versionIds.has(review.full.selected_artifact_id)) {
      addBindingIssue(context, [...path, "full", "selected_artifact_id"], "Review selected artifact binding mismatch.");
    }
  }

  for (const [name, value] of [["delivery", project.delivery], ["closeout", project.closeout]] as const) {
    const path = [...base, name] as Array<string | number>;
    if (value.project_id !== projectId) addBindingIssue(context, [...path, "project_id"], "Delivery project binding mismatch.");
    for (const [checkIndex, check] of value.readiness_checks.entries()) {
      if (!shotIds.has(check.shot_id)) addBindingIssue(context, [...path, "readiness_checks", checkIndex, "shot_id"], "Delivery SHOT binding mismatch.");
    }
    validateArtifactBinding(value.final_artifact, projectId, null, [...path, "final_artifact"], context);
    validateFinalArtifact(value.final_artifact, [...path, "final_artifact"], context);
    if (value.final_artifact && value.final_artifact_reason_code) {
      addBindingIssue(context, [...path, "final_artifact_reason_code"], "Usable final artifact cannot carry an error reason.");
    }
  }
  const { evidence: _evidence, ...closeoutDelivery } = project.closeout;
  if (canonicalizeJcs(closeoutDelivery) !== canonicalizeJcs(project.delivery)) {
    addBindingIssue(context, [...base, "closeout"], "Closeout/delivery parity mismatch.");
  }
  const checksByShot = new Map(project.delivery.readiness_checks.map((check) => [check.shot_id, check]));
  if (checksByShot.size !== project.delivery.readiness_checks.length || checksByShot.size !== project.shots_full.length) {
    addBindingIssue(context, [...base, "delivery", "readiness_checks"], "Delivery readiness SHOT set mismatch.");
  }
  if (project.delivery.readiness_checks.some((check, checkIndex) => check.shot_id !== project.shots_full[checkIndex]?.shot_id)) {
    addBindingIssue(context, [...base, "delivery", "readiness_checks"], "Delivery readiness SHOT ordering differs.");
  }
  for (const shot of project.shots_full) {
    const check = checksByShot.get(shot.shot_id);
    if (!check) continue;
    if (check.artifact_id !== shot.accepted_clip_artifact_id) {
      addBindingIssue(context, [...base, "delivery", "readiness_checks"], "Delivery accepted artifact reference mismatch.");
    }
    if (!shot.accepted_clip_artifact_id && (check.ok || check.reason_code !== "SHOT_ACCEPTED_CLIP_MISSING")) {
      addBindingIssue(context, [...base, "delivery", "readiness_checks"], "Delivery missing-clip readiness mismatch.");
    }
    if (shot.accepted_clip_artifact_id && (!check.ok || check.reason_code !== "SHOT_ACCEPTED_CLIP_READY")) {
      addBindingIssue(context, [...base, "delivery", "readiness_checks"], "Delivery accepted-clip readiness mismatch.");
    } else if (check.ok && check.reason_code !== "SHOT_ACCEPTED_CLIP_READY") {
      addBindingIssue(context, [...base, "delivery", "readiness_checks"], "Delivery ready-clip reason mismatch.");
    }
  }
  const acceptedCount = project.delivery.readiness_checks.filter((check) => check.ok).length;
  const readyForAssembly = project.shots_full.length > 0 && project.delivery.readiness_checks.every((check) => check.ok);
  const delivered = project.list_item_full.project.status === "final_approved" && project.delivery.final_artifact !== null;
  if (project.delivery.project_status !== project.list_item_full.project.status
    || project.delivery.shots_total !== project.shots_full.length
    || project.delivery.shots_accepted !== acceptedCount
    || project.delivery.ready_for_assembly !== readyForAssembly
    || project.delivery.delivered !== delivered) {
    addBindingIssue(context, [...base, "delivery"], "Delivery/canonical project state mismatch.");
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
  const expectedProjectOrder = [...value.projects].sort((left, right) => {
    const pinnedDifference = Number(right.list_item_full.pinned) - Number(left.list_item_full.pinned);
    if (pinnedDifference !== 0) return pinnedDifference;
    const leftUpdatedAt = left.list_item_full.updated_at;
    const rightUpdatedAt = right.list_item_full.updated_at;
    if (leftUpdatedAt !== rightUpdatedAt) return leftUpdatedAt > rightUpdatedAt ? -1 : 1;
    return left.project_id === right.project_id ? 0 : left.project_id > right.project_id ? -1 : 1;
  });
  if (value.projects.some((project, index) => project.project_id !== expectedProjectOrder[index]?.project_id)) {
    context.addIssue({ code: "custom", message: "Projected project ordering differs from the canonical project list order.", path: ["projects"] });
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
