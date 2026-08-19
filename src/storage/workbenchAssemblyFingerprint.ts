import { createHash } from "node:crypto";

import { canonicalizeJcs } from "../packages/domain/jcs.js";
import type { M0Database } from "./sqlite.js";

export const WORKBENCH_ASSEMBLY_CONTRACT = "final-assembly-v1";

export function parseWorkbenchAssemblyInput(inputJson: string): { source_clip_artifact_ids: string[] } | null {
  try {
    const value = JSON.parse(inputJson) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || !Array.isArray(record.source_clip_artifact_ids)
      || record.source_clip_artifact_ids.some((artifactId) => typeof artifactId !== "string" || artifactId.length === 0)) {
      return null;
    }
    return { source_clip_artifact_ids: [...record.source_clip_artifact_ids] as string[] };
  } catch {
    return null;
  }
}

export function workbenchAssemblyInputFingerprint(
  _db: M0Database,
  projectId: string,
  sourceClipArtifactIds: readonly string[]
): string | null {
  if (!projectId || sourceClipArtifactIds.some((artifactId) => !artifactId)) return null;
  return createHash("sha256").update(canonicalizeJcs({
    assembly_contract: WORKBENCH_ASSEMBLY_CONTRACT,
    project_id: projectId,
    source_clip_artifact_ids: [...sourceClipArtifactIds]
  }), "utf8").digest("hex");
}

export function workbenchAssemblyInputFingerprintFromJson(db: M0Database, projectId: string, inputJson: string): string | null {
  const parsed = parseWorkbenchAssemblyInput(inputJson);
  return parsed ? workbenchAssemblyInputFingerprint(db, projectId, parsed.source_clip_artifact_ids) : null;
}

export function registerWorkbenchAssemblyFingerprintFunction(db: M0Database): void {
  const functions = db as M0Database & {
    function: (name: string, options: { deterministic: boolean }, callback: (...args: unknown[]) => string | null) => void;
  };
  functions.function("workbench_assembly_input_fingerprint", { deterministic: true },
    (projectId: unknown, inputJson: unknown) => workbenchAssemblyInputFingerprintFromJson(db, String(projectId), String(inputJson)));
}
