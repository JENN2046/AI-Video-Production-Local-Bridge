/**
 * T2 evaluator facade.  The IS2.5 path is the pure facts-only evaluator;
 * legacy snapshot evaluation remains available for diagnostics and existing
 * IS1 callers without making it the final concurrency authority.
 */
export { evaluateGenerationAdmission } from "./s3bT2AdmissionEvaluate.js";
export type { GenerationAdmissionDecision, GenerationAdmissionFacts } from "./s3bT2Types.js";
export { evaluateT2Snapshot, evaluateT2Internal } from "./s3bT2LegacyEvaluate.js";
export type { T2InternalDecision } from "./s3bT2LegacyEvaluate.js";
