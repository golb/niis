import test from "node:test";
import assert from "node:assert/strict";

import { clusterInstinctsToSkillCandidate } from "./skill-candidate.js";

function createInstinct(overrides = {}) {
  return {
    id: "instinct-gate-block-1",
    trigger: "Respond to repeated gate block publish failures",
    confidence: 0.7,
    domain: "blocker_resolution",
    source: "runtime_observation",
    scope: "project",
    project_id: "example-project",
    evidence: {
      observation_count: 4,
      last_observed: "2026-04-04T19:00:00.000Z",
      confirming_sessions: ["task-1", "task-2"],
      contradicting_count: 0,
      project_ids: ["example-project"],
    },
    provenance: {
      source_type: "runtime_observation",
      source_ref: "task-1:gate-block",
      source_summary: "Repeated gate block while publishing",
      evidence_refs: ["task-1:gate-block"],
      suggestion_category: null,
    },
    promotion_review: {
      reviewer_id: "operator",
      reviewed_at: "2026-04-04T19:01:00.000Z",
      rationale: "Repeated gate block justified a reviewed instinct.",
      review_level: "standard",
    },
    security_review: null,
    status: "tentative",
    created_at: "2026-04-04T19:01:00.000Z",
    updated_at: "2026-04-04T19:01:00.000Z",
    ...overrides,
  };
}

test("clusterInstinctsToSkillCandidate creates a reviewed skill candidate from related instincts", () => {
  const clustered = clusterInstinctsToSkillCandidate({
    instincts: [
      createInstinct(),
      createInstinct({
        id: "instinct-gate-block-2",
        trigger: "Route around repeated gate block publish failures",
        evidence: {
          observation_count: 3,
          last_observed: "2026-04-04T19:05:00.000Z",
          confirming_sessions: ["task-3"],
          contradicting_count: 0,
          project_ids: ["example-project"],
        },
        provenance: {
          source_type: "runtime_observation",
          source_ref: "task-2:gate-block",
          source_summary: "Repeated gate block before publish retry",
          evidence_refs: ["task-2:gate-block"],
          suggestion_category: null,
        },
      }),
    ],
    review: {
      decision: "approve",
      rationale: "Two related blocker instincts are strong enough to review as one reusable skill candidate.",
      reviewedAt: "2026-04-04T19:10:00.000Z",
      reviewerId: "operator",
    },
  });

  assert.equal(clustered.approved, true);
  assert.equal(clustered.skill_candidate.scope, "project");
  assert.equal(clustered.skill_candidate.project_id, "example-project");
  assert.deepEqual(clustered.skill_candidate.domains, ["blocker_resolution"]);
  assert.deepEqual(clustered.skill_candidate.provenance.evidence_refs, [
    "instinct-gate-block-1",
    "instinct-gate-block-2",
  ]);
  assert.match(clustered.skill_candidate.summary, /related instincts/i);
  assert.ok(clustered.skill_candidate.clustering.shared_trigger_tokens.includes("gate"));
  assert.ok(clustered.skill_candidate.clustering.shared_trigger_tokens.includes("publish"));
});

test("clusterInstinctsToSkillCandidate rejects unrelated instinct groups", () => {
  const clustered = clusterInstinctsToSkillCandidate({
    instincts: [
      createInstinct(),
      createInstinct({
        id: "instinct-routing-1",
        trigger: "Prefer fast reviewer for routing conflicts",
        domain: "agent_routing",
        provenance: {
          source_type: "manual_note",
          source_ref: "note:routing",
          source_summary: "Routing preference for fast reviewer",
          evidence_refs: ["note:routing"],
          suggestion_category: null,
        },
      }),
    ],
    review: {
      decision: "approve",
      rationale: "Unrelated instincts should not cluster.",
      reviewedAt: "2026-04-04T19:10:00.000Z",
      reviewerId: "operator",
    },
  });

  assert.equal(clustered.approved, false);
  assert.equal(clustered.skill_candidate, null);
  assert.match(clustered.reason_rejected, /share one domain/i);
});

test("clusterInstinctsToSkillCandidate requires explicit security review for suspicious clusters", () => {
  const instincts = [
    createInstinct({
      provenance: {
        source_type: "discovery_candidate",
        source_ref: "registry://skill-a",
        source_summary: "Publish helper pattern from imported candidate",
        evidence_refs: ["registry://skill-a"],
        suggestion_category: "technical_debt",
      },
      security_review: {
        decision: "allow",
        rationale: "The imported instinct was audited before local promotion.",
        reviewed_at: "2026-04-04T19:01:30.000Z",
        reviewer_id: "security-operator",
        risk_level: "high",
        trigger_refs: ["security/prompt-injection-carrier"],
      },
    }),
    createInstinct({
      id: "instinct-gate-block-2",
      trigger: "Route around repeated gate block publish failures",
      provenance: {
        source_type: "runtime_observation",
        source_ref: "task-2:gate-block",
        source_summary: "Repeated gate block before publish retry",
        evidence_refs: ["task-2:gate-block"],
        suggestion_category: null,
      },
    }),
  ];

  const missingSecurityReview = clusterInstinctsToSkillCandidate({
    instincts,
    review: {
      decision: "approve",
      rationale: "Cluster is otherwise useful.",
      reviewedAt: "2026-04-04T19:10:00.000Z",
      reviewerId: "operator",
    },
  });
  const allowedCluster = clusterInstinctsToSkillCandidate({
    instincts,
    review: {
      decision: "approve",
      rationale: "Cluster is otherwise useful.",
      reviewedAt: "2026-04-04T19:10:00.000Z",
      reviewerId: "operator",
    },
    securityReview: {
      decision: "allow",
      rationale: "The reviewed imported instinct may contribute to a candidate, but activation remains separate.",
      reviewedAt: "2026-04-04T19:10:30.000Z",
      reviewerId: "security-operator",
    },
  });

  assert.equal(missingSecurityReview.approved, false);
  assert.equal(missingSecurityReview.security_evaluation.status, "requires_review");
  assert.match(missingSecurityReview.reason_rejected, /explicit security review/i);

  assert.equal(allowedCluster.approved, true);
  assert.equal(allowedCluster.security_evaluation.status, "allowed_with_review");
  assert.equal(allowedCluster.skill_candidate.security_review.reviewer_id, "security-operator");
  assert.equal(allowedCluster.skill_candidate.security_review.risk_level, "high");
});
