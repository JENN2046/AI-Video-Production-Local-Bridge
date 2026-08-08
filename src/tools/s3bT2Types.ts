export const T2_SNAPSHOT_ROWSET_NAMES = [
  "projects",
  "workbench_project_meta",
  "shots",
  "storyboard_packages",
  "media_artifacts",
  "media_artifact_blobs",
  "media_blobs",
  "generation_intents",
  "generation_jobs",
  "generation_runs"
] as const;

export type T2SnapshotRowsetName = typeof T2_SNAPSHOT_ROWSET_NAMES[number];
export type T2DatabaseRow = Record<string, unknown>;

export type T2RowsetEvidence = {
  row_count: number;
  digest: string;
};

export type T2RowsetEvidenceMap = {
  [K in T2SnapshotRowsetName]: T2RowsetEvidence;
};

export type T2RawRowsetMap = {
  [K in T2SnapshotRowsetName]: readonly T2DatabaseRow[];
};

export type T2DatabaseEvidence = {
  identity_digest: string;
  total_changes_before: number;
  total_changes_after: number;
  active_intent_count: number;
  query_only: 1;
  schema_current: true;
};

export type T2RawSnapshot = {
  database: T2DatabaseEvidence;
  rowsets: T2RawRowsetMap;
  rowset_evidence: T2RowsetEvidenceMap;
  database_evidence_digest: string;
};

export type T2NormalizedSnapshot = {
  database: T2DatabaseEvidence;
  rowsets: T2RowsetEvidenceMap;
  database_evidence_digest: string;
  business_evaluation: "not_started";
};

export type T2SnapshotEvidence = {
  database_evidence_digest: string;
  rowsets: T2RowsetEvidenceMap;
  business_evaluation: "not_started";
};

export type T2EligibilityDecision = {
  result: "FOUNDATION_ONLY";
  eligible: false;
  reason_code: "T2_EVALUATION_NOT_STARTED";
};

export type GovernedMediaEvidence =
  | {
      status: "VALID";
      fingerprint_digest: string;
    }
  | {
      status: "INVALID";
      fingerprint_digest: string;
      failure_class: string;
    };
