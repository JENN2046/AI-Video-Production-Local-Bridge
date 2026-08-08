import type { T2EligibilityDecision, T2NormalizedSnapshot } from "./s3bT2Types.js";

/** Pure IS1 placeholder: business eligibility begins in the next phase. */
export function evaluateT2Snapshot(_snapshot: T2NormalizedSnapshot): T2EligibilityDecision {
  return {
    result: "FOUNDATION_ONLY",
    eligible: false,
    reason_code: "T2_EVALUATION_NOT_STARTED"
  };
}
