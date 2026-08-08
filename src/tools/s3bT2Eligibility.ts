import { getM0Paths } from "../paths.js";
import { normalizeT2RawSnapshot } from "./s3bT2Normalize.js";
import { captureT2RawSnapshot, type T2SnapshotPaths } from "./s3bT2Snapshot.js";
import { evaluateT2Snapshot } from "./s3bT2Evaluate.js";
import type { T2EligibilityDecision, T2SnapshotEvidence } from "./s3bT2Types.js";

export type T2FoundationResult = {
  snapshot: T2SnapshotEvidence;
  decision: T2EligibilityDecision;
};

/** Thin composition boundary; no candidate or receipt logic belongs here yet. */
export function captureT2Foundation(input: T2SnapshotPaths = getM0Paths()): T2FoundationResult {
  const normalized = normalizeT2RawSnapshot(captureT2RawSnapshot(input));
  return {
    snapshot: {
      database_evidence_digest: normalized.database_evidence_digest,
      rowsets: normalized.rowsets,
      business_evaluation: normalized.business_evaluation
    },
    decision: evaluateT2Snapshot(normalized)
  };
}

export { captureT2RawSnapshot, T2SnapshotError } from "./s3bT2Snapshot.js";
export { normalizeT2RawSnapshot, parseCanonicalClipVersion } from "./s3bT2Normalize.js";
export { evaluateT2Snapshot } from "./s3bT2Evaluate.js";
