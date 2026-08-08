import { WEBGPT_V4_CLIP_VERSION_SCHEMA } from "../packages/domain/clipVersion.js";
import type { T2NormalizedSnapshot, T2RawSnapshot } from "./s3bT2Types.js";

/** The only business normalization in IS1 is a boundary for later phases. */
export function normalizeT2RawSnapshot(raw: T2RawSnapshot): T2NormalizedSnapshot {
  return {
    database: raw.database,
    rowsets: raw.rowset_evidence,
    database_evidence_digest: raw.database_evidence_digest,
    business_evaluation: "not_started"
  };
}

/** Proof that later T2 code can consume the canonical strict ClipVersion schema. */
export function parseCanonicalClipVersion(value: unknown): ReturnType<typeof WEBGPT_V4_CLIP_VERSION_SCHEMA.safeParse> {
  return WEBGPT_V4_CLIP_VERSION_SCHEMA.safeParse(value);
}
