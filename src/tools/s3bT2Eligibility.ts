import { getM0Paths } from "../paths.js";
import { normalizeT2RawSnapshot } from "./s3bT2Normalize.js";
import { collectT2GovernedMediaEvidence } from "./s3bT2MediaEvidence.js";
import { evaluateT2Snapshot } from "./s3bT2Evaluate.js";
import { captureT2RawSnapshot, fingerprintT2SnapshotEvidence, type T2SnapshotPaths } from "./s3bT2Snapshot.js";
import type { T2SnapshotEvidence } from "./s3bT2Types.js";
import type { T2InternalDecision } from "./s3bT2Evaluate.js";

export type T2CoreInput = {
  snapshotPaths?: T2SnapshotPaths;
  mediaRoot?: string;
  betweenSnapshots?: () => void;
};

export type T2CoreResult = {
  snapshot: T2SnapshotEvidence;
  decision: T2InternalDecision;
  first_fingerprint: string;
  second_fingerprint: string;
};

function captureStage(input: { snapshotPaths: T2SnapshotPaths; mediaRoot: string }): { snapshot: T2SnapshotEvidence; decision: T2InternalDecision; fingerprint: string } {
  const raw = captureT2RawSnapshot(input.snapshotPaths);
  const normalized = normalizeT2RawSnapshot(raw);
  const media = collectT2GovernedMediaEvidence({ snapshot: normalized, mediaRoot: input.mediaRoot });
  const fingerprint = fingerprintT2SnapshotEvidence({
    database_evidence_digest: raw.database_evidence_digest,
    media_root_evidence_digest: media.media_root_evidence_digest,
    referenced_media_evidence: media.referenced_media_evidence
  });
  return {
    fingerprint,
    snapshot: {
      database_evidence_digest: raw.database_evidence_digest,
      media_root_evidence_digest: media.media_root_evidence_digest,
      referenced_media_evidence: media.referenced_media_evidence,
      rowsets: raw.rowset_evidence
    },
    decision: evaluateT2Snapshot(normalized, media.referenced)
  };
}

export function captureT2Core(input: T2CoreInput = {}): T2CoreResult {
  const paths = input.snapshotPaths ?? getM0Paths();
  const mediaRoot = input.mediaRoot ?? getM0Paths().mediaRoot;
  const first = captureStage({ snapshotPaths: paths, mediaRoot });
  input.betweenSnapshots?.();
  const second = captureStage({ snapshotPaths: paths, mediaRoot });
  if (first.fingerprint !== second.fingerprint) {
    return {
      snapshot: second.snapshot,
      first_fingerprint: first.fingerprint,
      second_fingerprint: second.fingerprint,
      decision: { state: "INELIGIBLE", candidates: [], reason_code_counts: { INTERNAL_STATE_CHANGED: 1 } }
    };
  }
  return { snapshot: second.snapshot, first_fingerprint: first.fingerprint, second_fingerprint: second.fingerprint, decision: second.decision };
}

/** Compatibility composition API retained for IS1 callers; IS2 callers use captureT2Core. */
export function captureT2Foundation(input: T2SnapshotPaths = getM0Paths()): T2CoreResult {
  return captureT2Core({ snapshotPaths: input });
}

export { captureT2RawSnapshot, fingerprintT2SnapshotEvidence, T2SnapshotError } from "./s3bT2Snapshot.js";
export { normalizeT2RawSnapshot, parseCanonicalClipVersion, deriveNormalizedShotState } from "./s3bT2Normalize.js";
export { collectT2GovernedMediaEvidence } from "./s3bT2MediaEvidence.js";
export { evaluateT2Snapshot, evaluateT2Internal } from "./s3bT2Evaluate.js";
