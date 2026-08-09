import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "tests/s3b-t2-oracle-manifest.json"), "utf8")
) as {
  runner_evidence: {
    executed_runner_cases: { observed: number; assigned_to_group: number; unassigned: number };
    groups: Array<{
      semantic_group_id: string;
      test_name: string;
      covered_variants: string[];
    }>;
  };
  semantic_behavior_groups: {
    count: number;
    all_have_real_source_test_names: boolean;
    groups: Array<{
      id: string;
      contract_area: string;
      actual_source_test_names: string[];
      covered_variants: string[];
      required_behavior: string;
      disposition: string;
      target_test_or_invariant: string;
      old_safety_lesson?: string;
      new_acceptance_behavior?: string;
    }>;
  };
  responsibility_remap: {
    total_groups: number;
    mapped: number;
    unmapped: number;
    silently_dropped: number;
    dispositions: Record<string, number>;
  };
  PR118_review_findings: {
    expected: number;
    mapped: number;
    unmapped: number;
    unique_thread_ids: number;
    duplicate_ids: number;
    unknown_ids: number;
    entries: Array<{
      thread_id: string;
      finding_summary: string;
      root_cause: string;
      contract_area: string;
      target_behavior_or_invariant: string;
    }>;
  };
  current_four_findings: Array<{
    thread_id: string;
    target_behavior_or_invariant: string;
  }>;
  placeholder_sources: { count: number };
};

const allowedAreas = new Set([
  "database_authority",
  "read_only",
  "runtime_schema",
  "generation_history",
  "reason_precedence",
  "package_freeze",
  "media_authority",
  "actual_bytes",
  "snapshot_drift",
  "provider_capability",
  "privacy",
  "receipt",
  "governance"
]);

const allowedDispositions = new Set([
  "RETAIN_IN_T2",
  "RETAIN_IN_EXISTING_AUTHORITY",
  "MOVE_TO_SHARED_AUTHORITY",
  "REPLACE_WITH_BEHAVIOR"
]);

const isPlaceholder = (value: string): boolean =>
  value.includes("#executed-case-") || value.includes("IS1 <contract_area> contract boundary");

test("runner evidence is compact, assigned, and grounded in real source groups", () => {
  const runner = manifest.runner_evidence;
  assert.deepEqual(runner.executed_runner_cases, {
    observed: 202,
    assigned_to_group: 202,
    unassigned: 0
  });
  assert.equal(runner.groups.length, 31);
  assert.equal(
    runner.groups.reduce(
      (count, group) => count + (group.covered_variants.length === 0 ? 1 : group.covered_variants.length + 1),
      0
    ),
    202
  );
  assert.equal(new Set(runner.groups.map((group) => group.semantic_group_id)).size, runner.groups.length);
  for (const group of runner.groups) {
    assert.ok(group.test_name.length > 0);
    assert.equal(group.test_name, group.test_name.trim());
    assert.ok(group.covered_variants.every((variant) => variant.length > 0));
    assert.equal(isPlaceholder(group.test_name), false);
    assert.equal(group.covered_variants.some(isPlaceholder), false);
  }
});

test("semantic behavior groups are unique, non-placeholder, and actionable", () => {
  const semantic = manifest.semantic_behavior_groups;
  assert.equal(semantic.count, 31);
  assert.equal(semantic.all_have_real_source_test_names, true);
  assert.equal(new Set(semantic.groups.map((group) => group.id)).size, semantic.groups.length);
  for (const group of semantic.groups) {
    assert.equal(group.actual_source_test_names.length > 0, true);
    assert.equal(group.actual_source_test_names.some(isPlaceholder), false);
    assert.equal(group.covered_variants.some(isPlaceholder), false);
    assert.ok(allowedAreas.has(group.contract_area));
    assert.ok(group.required_behavior.length > 0);
    assert.equal(allowedDispositions.has(group.disposition), true);
    assert.ok(group.target_test_or_invariant.length > 0);
    if (group.disposition === "REPLACE_WITH_BEHAVIOR") {
      assert.ok(group.old_safety_lesson && group.old_safety_lesson.length > 0);
      assert.ok(group.new_acceptance_behavior && group.new_acceptance_behavior.length > 0);
    }
  }
});

test("IS2.5 responsibility remap covers every semantic group without silent drops", () => {
  assert.deepEqual(manifest.responsibility_remap, {
    total_groups: 31,
    mapped: 31,
    unmapped: 0,
    silently_dropped: 0,
    dispositions: {
      RETAIN_IN_T2: 3,
      RETAIN_IN_EXISTING_AUTHORITY: 18,
      MOVE_TO_SHARED_AUTHORITY: 6,
      REPLACE_WITH_BEHAVIOR: 4
    }
  });
  assert.equal(manifest.semantic_behavior_groups.groups.filter((group) => group.disposition === "REPLACE_WITH_BEHAVIOR").length, 4);
});

test("all PR118 review findings map to unique real threads and current targets", () => {
  const review = manifest.PR118_review_findings;
  assert.deepEqual(
    {
      expected: review.expected,
      mapped: review.mapped,
      unmapped: review.unmapped,
      unique_thread_ids: review.unique_thread_ids,
      duplicate_ids: review.duplicate_ids,
      unknown_ids: review.unknown_ids
    },
    { expected: 49, mapped: 49, unmapped: 0, unique_thread_ids: 49, duplicate_ids: 0, unknown_ids: 0 }
  );
  assert.equal(new Set(review.entries.map((entry) => entry.thread_id)).size, 49);
  for (const entry of review.entries) {
    assert.ok(entry.thread_id.startsWith("PRRT_"));
    assert.ok(entry.finding_summary.length > 0);
    assert.ok(entry.root_cause.length > 0);
    assert.ok(allowedAreas.has(entry.contract_area));
    assert.ok(entry.target_behavior_or_invariant.length > 0);
    assert.equal(isPlaceholder(entry.finding_summary), false);
    assert.equal(isPlaceholder(entry.root_cause), false);
    assert.equal(isPlaceholder(entry.target_behavior_or_invariant), false);
  }
  const currentTargets = new Map(
    manifest.current_four_findings.map((finding) => [finding.thread_id, finding.target_behavior_or_invariant])
  );
  assert.deepEqual(
    Object.fromEntries(currentTargets),
    {
      PRRT_kwDOTTDtUM6XfIRi: "T2-NORM-ARTIFACT-NON_OBJECT",
      PRRT_kwDOTTDtUM6XfIRk: "T2-MEDIA-SUCCESS-IDENTITY-FINGERPRINT",
      PRRT_kwDOTTDtUM6XfIRn: "T2-MEDIA-SYMLINK-ENTITY-FINGERPRINT",
      PRRT_kwDOTTDtUM6XfIRp: "T2-GOV-TERMINAL-TIP-SINGLE-SOURCE"
    }
  );
});

test("oracle has no synthetic placeholder sources", () => {
  assert.equal(manifest.placeholder_sources.count, 0);
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes("#executed-case-"), false);
  assert.equal(serialized.includes("IS1 <contract_area> contract boundary"), false);
});
