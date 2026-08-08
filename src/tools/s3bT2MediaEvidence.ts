import { createHash } from "node:crypto";

import type { GovernedMediaEvidence } from "./s3bT2Types.js";

function mediaEvidenceDigest(status: "VALID" | "INVALID", value: string): string {
  return createHash("sha256").update(`t2-governed-media-evidence-v1\0${status}\0${value}`).digest("hex");
}

export function createValidGovernedMediaEvidence(fingerprint: string): GovernedMediaEvidence {
  return { status: "VALID", fingerprint_digest: mediaEvidenceDigest("VALID", fingerprint) };
}

export function createInvalidGovernedMediaEvidence(failureClass: string): GovernedMediaEvidence {
  return {
    status: "INVALID",
    fingerprint_digest: mediaEvidenceDigest("INVALID", failureClass),
    failure_class: failureClass
  };
}
