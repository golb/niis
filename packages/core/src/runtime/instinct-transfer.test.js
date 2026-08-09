import test from "node:test";
import assert from "node:assert/strict";

import {
  exportReviewedInstinctBundle,
  importReviewedInstinctBundle,
} from "./instinct-transfer.js";

function createInstinct(overrides = {}) {
  return {
    id: "instinct-routing-1",
    trigger: "Prefer fast reviewer for repeated routing conflicts",
    confidence: 0.7,
    domain: "agent_routing",
    source: "runtime_observation",
    scope: "project",
    project_id: "example-project",
    evidence: {
      observation_count: 4,
      last_observed: "2026-04-04T20:00:00.000Z",
      confirming_sessions: ["task-1", "task-2"],
      contradicting_count: 0,
      project_ids: ["example-project"],
    },
    provenance: {
      source_type: "runtime_observation",
      source_ref: "task-1:routing",
      source_summary: "Repeated routing preference for fast reviewer",
      evidence_refs: ["task-1:routing"],
      suggestion_category: null,
    },
    promotion_review: {
      reviewer_id: "operator",
      reviewed_at: "2026-04-04T20:01:00.000Z",
      rationale: "Repeated routing preference justified a reviewed instinct.",
      review_level: "standard",
    },
    security_review: null,
    status: "tentative",
    created_at: "2026-04-04T20:01:00.000Z",
    updated_at: "2026-04-04T20:01:00.000Z",
    ...overrides,
  };
}

test("exportReviewedInstinctBundle returns a reviewed instinct sharing bundle", () => {
  const exported = exportReviewedInstinctBundle({
    instincts: [
      createInstinct(),
      createInstinct({
        id: "instinct-routing-2",
        trigger: "Prefer fast reviewer for retry-heavy routing conflicts",
        evidence: {
          observation_count: 3,
          last_observed: "2026-04-04T20:05:00.000Z",
          confirming_sessions: ["task-3"],
          contradicting_count: 0,
          project_ids: ["example-project"],
        },
      }),
    ],
    review: {
      decision: "approve",
      rationale: "The instincts are export-safe as reviewed local learning artifacts.",
      reviewedAt: "2026-04-04T20:10:00.000Z",
      reviewerId: "operator",
    },
  });

  assert.equal(exported.approved, true);
  assert.equal(exported.bundle.bundle_kind, "instinct_bundle");
  assert.equal(exported.bundle.instincts.length, 2);
  assert.equal(exported.bundle.export_review.reviewer_id, "operator");
  assert.equal(exported.bundle.summary.instinct_count, 2);
  assert.ok(exported.bundle.summary.domains.includes("agent_routing"));
});

test("importReviewedInstinctBundle creates tentative imported instincts with import provenance", () => {
  const exported = exportReviewedInstinctBundle({
    bundleId: "routing-review-bundle",
    instincts: [createInstinct({
      id: "instinct-routing-exported",
      project_id: "other-project",
      evidence: {
        observation_count: 5,
        last_observed: "2026-04-04T20:06:00.000Z",
        confirming_sessions: ["task-3"],
        contradicting_count: 0,
        project_ids: ["other-project"],
      },
    })],
    review: {
      decision: "approve",
      rationale: "Bundle is safe to share for reviewed import.",
      reviewedAt: "2026-04-04T20:10:00.000Z",
      reviewerId: "operator",
    },
  });
  const imported = importReviewedInstinctBundle({
    bundle: exported.bundle,
    review: {
      decision: "approve",
      rationale: "Imported instinct should remain tentative until further local learning/governance.",
      reviewedAt: "2026-04-04T20:12:00.000Z",
      reviewerId: "operator",
    },
  });

  assert.equal(imported.approved, true);
  assert.equal(imported.imported_instincts.length, 1);
  assert.equal(imported.merged_instincts.length, 0);
  assert.equal(imported.imported_instincts[0].source, "imported");
  assert.equal(imported.imported_instincts[0].status, "tentative");
  assert.equal(imported.imported_instincts[0].provenance.source_type, "instinct_import");
  assert.equal(
    imported.imported_instincts[0].provenance.source_ref,
    "routing-review-bundle:instinct-routing-exported",
  );
  assert.equal(imported.imported_instincts[0].promotion_review.reviewer_id, "operator");
});

test("importReviewedInstinctBundle deduplicates bundle instincts and merges duplicates into local instincts", () => {
  const exported = exportReviewedInstinctBundle({
    bundleId: "routing-review-bundle",
    instincts: [
      createInstinct({
        id: "instinct-routing-duplicate-a",
        confidence: 0.6,
        evidence: {
          observation_count: 2,
          last_observed: "2026-04-04T20:03:00.000Z",
          confirming_sessions: ["task-a"],
          contradicting_count: 0,
          project_ids: ["example-project"],
        },
        provenance: {
          source_type: "runtime_observation",
          source_ref: "task-a:routing",
          source_summary: "Repeated routing preference in imported bundle",
          evidence_refs: ["task-a:routing"],
          suggestion_category: null,
        },
      }),
      createInstinct({
        id: "instinct-routing-duplicate-b",
        confidence: 0.9,
        evidence: {
          observation_count: 5,
          last_observed: "2026-04-04T20:09:00.000Z",
          confirming_sessions: ["task-b"],
          contradicting_count: 1,
          project_ids: ["example-project"],
        },
        provenance: {
          source_type: "runtime_observation",
          source_ref: "task-b:routing",
          source_summary: "Higher-confidence duplicate in imported bundle",
          evidence_refs: ["task-b:routing"],
          suggestion_category: null,
        },
      }),
    ],
    review: {
      decision: "approve",
      rationale: "Bundle is safe to share for reviewed import.",
      reviewedAt: "2026-04-04T20:10:00.000Z",
      reviewerId: "operator",
    },
  });
  const imported = importReviewedInstinctBundle({
    bundle: exported.bundle,
    existingInstincts: [createInstinct({
      confidence: 0.7,
      evidence: {
        observation_count: 4,
        last_observed: "2026-04-04T20:00:00.000Z",
        confirming_sessions: ["task-1"],
        contradicting_count: 0,
        project_ids: ["example-project"],
      },
      provenance: {
        source_type: "runtime_observation",
        source_ref: "task-local:routing",
        source_summary: "Local reviewed routing instinct",
        evidence_refs: ["task-local:routing"],
        suggestion_category: null,
      },
    })],
    review: {
      decision: "approve",
      rationale: "Import should merge duplicate routing instincts without replacing local provenance.",
      reviewedAt: "2026-04-04T20:12:00.000Z",
      reviewerId: "operator",
    },
  });

  assert.equal(imported.approved, true);
  assert.equal(imported.duplicates.length, 1);
  assert.equal(imported.imported_instincts.length, 0);
  assert.equal(imported.merged_instincts.length, 1);
  assert.equal(imported.merged_instincts[0].merge_policy, "keep_local_provenance_raise_confidence");
  assert.equal(imported.merged_instincts[0].merged_instinct.id, "instinct-routing-1");
  assert.equal(imported.merged_instincts[0].merged_instinct.provenance.source_ref, "task-local:routing");
  assert.equal(imported.merged_instincts[0].merged_instinct.confidence, 0.9);
  assert.equal(imported.merged_instincts[0].merged_instinct.evidence.observation_count, 11);
  assert.deepEqual(
    imported.merged_instincts[0].merged_instinct.evidence.confirming_sessions,
    ["task-1", "task-a", "task-b"],
  );
  assert.ok(
    imported.merged_instincts[0].merged_instinct.provenance.evidence_refs.includes(
      "routing-review-bundle:instinct-routing-duplicate-b",
    ),
  );
});
