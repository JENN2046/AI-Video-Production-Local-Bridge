import { createHash } from "node:crypto";

import { withWorkbenchProductionMutationAuthority } from "../storage/productionMutationAuthority.js";
import type { M0Database } from "../storage/sqlite.js";
import { getGenerationRun } from "./generation.js";
import { validateActiveArtifactReference } from "./mediaArtifacts.js";
import { getProject, getShot } from "./projects.js";
import { getStoryboardPackage } from "./storyboardPackages.js";
import { assertWorkbenchContentMutationAllowed } from "./workbenchDeliveryState.js";
import type { GenerationPlan } from "./s3bT2Types.js";

export type GenerationExecutionReceiptState =
  | "reserved"
  | "ambiguous"
  | "submitted"
  | "reconciling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface GenerationExecutionBindingInput {
  intent_id: string;
  job_id: string;
  run_id: string;
  project_id: string;
  shot_id: string;
  provider: "runninghub";
  model: string;
  input_artifact_id: string;
  provider_task_id: string;
  duration_seconds: number;
  resolution: string;
  input_snapshot: {
    video_prompt: string;
    negative_prompt: string;
    aspect_ratio: string;
    project_resolution?: string;
    capability_key?: string;
    prepared_by?: string;
    admission_only?: true;
    director_automation?: unknown;
  };
  generation_plan?: GenerationPlan;
}

export interface GenerationExecutionAuthoritySnapshot {
  schema_version: "generation_execution_authority.v1";
  intent: {
    intent_id: string;
    job_id: string;
    run_id: string;
    project_id: string;
    shot_id: string;
    provider: "runninghub";
    model: string;
    input_artifact_id: string;
    duration_seconds: number;
    resolution: string;
    input_snapshot: GenerationExecutionBindingInput["input_snapshot"];
    generation_plan: GenerationPlan | null;
  };
  project: {
    active_storyboard_package_id: string;
    video_spec: { duration_seconds: number; aspect_ratio: string; resolution: string };
  };
  storyboard_package: {
    storyboard_package_id: string;
    content_sha256: string;
  };
  shot: {
    shot_id: string;
    order: number;
    duration_seconds: number;
    storyboard_image_artifact_id: string;
    video_prompt: string;
    negative_prompt: string;
  };
  storyboard_artifact: {
    artifact_id: string;
    blob_id: string;
    sha256: string;
  };
}

export interface GenerationExecutionReceipt {
  intent_id: string;
  job_id: string;
  run_id: string;
  project_id: string;
  shot_id: string;
  storyboard_package_id: string;
  provider: "runninghub";
  authority_fingerprint: string;
  authority_snapshot: GenerationExecutionAuthoritySnapshot;
  provider_task_id: string;
  provider_status: string;
  result_artifact_id: string | null;
  state: GenerationExecutionReceiptState;
  created_at: string;
  updated_at: string;
}

export type GenerationExecutionAuthorityResult =
  | { ok: true; snapshot: GenerationExecutionAuthoritySnapshot; fingerprint: string }
  | { ok: false; error: { code: "GENERATION_EXECUTION_AUTHORITY_STALE" | "GENERATION_EXECUTION_SNAPSHOT_MISSING"; message: string } };

interface GenerationExecutionReceiptRow {
  intent_id: string;
  job_id: string;
  run_id: string;
  project_id: string;
  shot_id: string;
  storyboard_package_id: string;
  provider: "runninghub";
  authority_fingerprint: string;
  authority_snapshot_json: string;
  provider_task_id: string;
  provider_status: string;
  result_artifact_id: string | null;
  state: GenerationExecutionReceiptState;
  created_at: string;
  updated_at: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function authorityStale(message: string): GenerationExecutionAuthorityResult {
  return { ok: false, error: { code: "GENERATION_EXECUTION_AUTHORITY_STALE", message } };
}

function receiptFromRow(row: GenerationExecutionReceiptRow): GenerationExecutionReceipt | null {
  try {
    const snapshot = JSON.parse(row.authority_snapshot_json) as GenerationExecutionAuthoritySnapshot;
    if (snapshot.schema_version !== "generation_execution_authority.v1") return null;
    return { ...row, authority_snapshot: snapshot };
  } catch {
    return null;
  }
}

export function getGenerationExecutionReceipt(db: M0Database, intentId: string): GenerationExecutionReceipt | null {
  const row = db.prepare("SELECT * FROM generation_execution_receipts WHERE intent_id = ?").get(intentId) as GenerationExecutionReceiptRow | undefined;
  return row ? receiptFromRow(row) : null;
}

export function buildGenerationExecutionAuthority(
  db: M0Database,
  input: GenerationExecutionBindingInput
): GenerationExecutionAuthorityResult {
  const writable = assertWorkbenchContentMutationAllowed(db, input.project_id);
  if (!writable.ok) return authorityStale("Project delivery state no longer permits generation execution.");
  const project = getProject(db, input.project_id);
  const shot = getShot(db, input.shot_id);
  const storyboardPackage = project?.active_storyboard_package_id
    ? getStoryboardPackage(db, project.active_storyboard_package_id)
    : null;
  const run = input.run_id ? getGenerationRun(db, input.run_id) : null;
  const job = db.prepare("SELECT job_id, intent_id, state FROM generation_jobs WHERE job_id = ?").get(input.job_id) as {
    job_id: string;
    intent_id: string;
    state: string;
  } | undefined;
  if (!project || !shot || !storyboardPackage || !run || !job
    || shot.project_id !== project.project_id
    || storyboardPackage.project_id !== project.project_id
    || job.intent_id !== input.intent_id
    || run.project_id !== project.project_id
    || run.shot_id !== shot.shot_id
    || shot.generation_run_ids.filter((runId) => runId === input.run_id).length !== 1
    || !["queued", "running"].includes(run.status)
    || !["queued", "submitting", "polling", "downloading", "finalizing", "manual_reconciliation"].includes(job.state)
    || project.status !== "video_generation_in_progress"
    || shot.status !== "video_pending") {
    return authorityStale("Project, SHOT, Run, or Job generation binding changed after confirmation.");
  }
  if (!project.active_storyboard_package_id
    || (input.generation_plan && input.generation_plan.storyboard_package_id !== project.active_storyboard_package_id)) {
    return authorityStale("The active Storyboard Package changed after confirmation.");
  }
  const packageShot = storyboardPackage.approved_shot_snapshots.find((candidate) => candidate.shot_id === shot.shot_id);
  if (!packageShot
    || packageShot.order !== shot.order
    || packageShot.duration_seconds !== shot.duration_seconds
    || packageShot.storyboard_image_artifact_id !== shot.storyboard_image_artifact_id
    || packageShot.video_prompt !== shot.video_prompt
    || (packageShot.negative_prompt ?? "") !== shot.negative_prompt) {
    return authorityStale("The approved Storyboard Package no longer binds the current SHOT inputs.");
  }
  const artifact = validateActiveArtifactReference(db, {
    artifact_id: input.input_artifact_id,
    project_id: project.project_id,
    shot_id: shot.shot_id,
    role: "storyboard_image",
    artifact_type: "image"
  });
  if (!artifact.ok || artifact.artifact.artifact_id !== shot.storyboard_image_artifact_id) {
    return authorityStale("The storyboard Artifact is no longer active or bound to the current SHOT.");
  }
  if (input.input_snapshot.video_prompt !== shot.video_prompt
    || input.input_snapshot.negative_prompt !== shot.negative_prompt
    || input.input_snapshot.aspect_ratio !== project.video_spec.aspect_ratio
    || input.input_snapshot.project_resolution !== project.video_spec.resolution
    || input.duration_seconds !== shot.duration_seconds) {
    return authorityStale("Project video spec or SHOT Provider inputs changed after confirmation.");
  }
  const conflict = db.prepare(`SELECT intent_id FROM generation_intents
    WHERE intent_id <> ? AND (
      status IN ('queued','running')
      OR (status = 'prepared' AND json_valid(data_json) = 1 AND json_type(data_json, '$.generation_plan') IS NOT NULL)
    ) LIMIT 1`).get(input.intent_id) as { intent_id: string } | undefined;
  if (conflict) return authorityStale("The global real-generation right is owned by another Intent.");

  const snapshot: GenerationExecutionAuthoritySnapshot = {
    schema_version: "generation_execution_authority.v1",
    intent: {
      intent_id: input.intent_id,
      job_id: input.job_id,
      run_id: input.run_id,
      project_id: input.project_id,
      shot_id: input.shot_id,
      provider: input.provider,
      model: input.model,
      input_artifact_id: input.input_artifact_id,
      duration_seconds: input.duration_seconds,
      resolution: input.resolution,
      input_snapshot: structuredClone(input.input_snapshot),
      generation_plan: input.generation_plan ? structuredClone(input.generation_plan) : null
    },
    project: {
      active_storyboard_package_id: project.active_storyboard_package_id,
      video_spec: structuredClone(project.video_spec)
    },
    storyboard_package: {
      storyboard_package_id: storyboardPackage.storyboard_package_id,
      content_sha256: sha256(JSON.stringify(storyboardPackage))
    },
    shot: {
      shot_id: shot.shot_id,
      order: shot.order,
      duration_seconds: shot.duration_seconds,
      storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
      video_prompt: shot.video_prompt,
      negative_prompt: shot.negative_prompt
    },
    storyboard_artifact: {
      artifact_id: artifact.artifact.artifact_id,
      blob_id: artifact.artifact.blob_id,
      sha256: artifact.artifact.metadata.sha256
    }
  };
  return { ok: true, snapshot, fingerprint: sha256(JSON.stringify(snapshot)) };
}

export function createGenerationExecutionReceipt(
  db: M0Database,
  input: GenerationExecutionBindingInput
): GenerationExecutionAuthorityResult {
  const authority = buildGenerationExecutionAuthority(db, input);
  if (!authority.ok) return authority;
  withWorkbenchProductionMutationAuthority(db, {
    kind: "generation_execution",
    project_id: input.project_id,
    object_id: input.intent_id
  }, () => db.prepare(`INSERT INTO generation_execution_receipts
      (intent_id, job_id, run_id, project_id, shot_id, storyboard_package_id, provider,
       authority_fingerprint, authority_snapshot_json, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`)
    .run(input.intent_id, input.job_id, input.run_id, input.project_id, input.shot_id,
      authority.snapshot.storyboard_package.storyboard_package_id, input.provider,
      authority.fingerprint, JSON.stringify(authority.snapshot)));
  return authority;
}

export function revalidateGenerationExecutionAuthority(
  db: M0Database,
  input: GenerationExecutionBindingInput
): GenerationExecutionAuthorityResult {
  const receipt = getGenerationExecutionReceipt(db, input.intent_id);
  if (!receipt) {
    return { ok: false, error: { code: "GENERATION_EXECUTION_SNAPSHOT_MISSING", message: "Generation execution has no frozen authority receipt." } };
  }
  if (receipt.job_id !== input.job_id || receipt.run_id !== input.run_id
    || receipt.project_id !== input.project_id || receipt.shot_id !== input.shot_id
    || receipt.provider !== input.provider || receipt.state === "failed" || receipt.state === "cancelled") {
    return authorityStale("The durable generation execution receipt no longer matches this worker.");
  }
  if (receipt.provider_task_id !== input.provider_task_id
    || (["reserved", "ambiguous"].includes(receipt.state) && input.provider_task_id !== "")
    || (["submitted", "reconciling", "succeeded"].includes(receipt.state) && input.provider_task_id === "")) {
    return authorityStale("Provider task identity no longer matches the durable execution receipt.");
  }
  const current = buildGenerationExecutionAuthority(db, input);
  if (!current.ok) return current;
  if (current.fingerprint !== receipt.authority_fingerprint
    || JSON.stringify(current.snapshot) !== JSON.stringify(receipt.authority_snapshot)) {
    return authorityStale("Frozen Project, Storyboard Package, SHOT, Artifact, or Intent authority drifted.");
  }
  return current;
}

export function transitionGenerationExecutionReceipt(
  db: M0Database,
  intentId: string,
  input: {
    state: GenerationExecutionReceiptState;
    provider_task_id?: string;
    provider_status?: string;
    result_artifact_id?: string | null;
  }
): GenerationExecutionReceipt {
  const receipt = getGenerationExecutionReceipt(db, intentId);
  if (!receipt) throw new Error("GENERATION_EXECUTION_SNAPSHOT_MISSING");
  const providerTaskId = input.provider_task_id ?? receipt.provider_task_id;
  const providerStatus = input.provider_status ?? receipt.provider_status;
  const resultArtifactId = input.result_artifact_id === undefined ? receipt.result_artifact_id : input.result_artifact_id;
  withWorkbenchProductionMutationAuthority(db, {
    kind: "generation_execution",
    project_id: receipt.project_id,
    object_id: receipt.intent_id
  }, () => {
    const updated = db.prepare(`UPDATE generation_execution_receipts
      SET provider_task_id = ?, provider_status = ?, result_artifact_id = ?, state = ?, updated_at = CURRENT_TIMESTAMP
      WHERE intent_id = ?`).run(providerTaskId, providerStatus, resultArtifactId, input.state, receipt.intent_id) as { changes: number | bigint };
    if (Number(updated.changes) !== 1) throw new Error("GENERATION_EXECUTION_RECEIPT_UPDATE_FAILED");
  });
  const current = getGenerationExecutionReceipt(db, intentId);
  if (!current) throw new Error("GENERATION_EXECUTION_RECEIPT_UPDATE_FAILED");
  return current;
}
