import test from "node:test";
import assert from "node:assert/strict";

import { promoteDiscoveryCandidateToInstinct } from "./instinct-promotion.js";

function createDiscoveryCandidate(overrides = {}) {
  return {
    candidate_id: "local_filesystem:/tmp/review-skill/package.json",
    candidate_kind: "package",
    dedup_key: "package:pkg-review-skill",
    display_name: "Review Skill",
    metadata: {
      filesystem_root: "/tmp/packages",
      source_id: "local-filesystem-1",
    },
    package_id: "pkg-review-skill",
    package_manifest: null,
    review_required: true,
    security_findings: [],
    source_kind: "local_filesystem",
    source_ref: "/tmp/review-skill/package.json",
    suggestion_category: "shipped_capability",
    suggestion_reason: "Local manifest already exists and should be documented before duplication.",
    version: "0.1.0",
    ...overrides,
  };
}

test("promoteDiscoveryCandidateToInstinct creates a reviewed instinct artifact with provenance", () => {
  const promotion = promoteDiscoveryCandidateToInstinct({
    candidate: createDiscoveryCandidate(),
    domain: "workflow_optimization",
    evidence: {
      confirmingSessions: ["task-1", "task-2"],
      lastObserved: "2026-04-04T17:30:00.000Z",
      observationCount: 4,
    },
    projectId: "example-project",
    review: {
      decision: "approve",
      rationale: "Repeated local evidence justifies a reviewed project-scoped instinct artifact.",
      reviewedAt: "2026-04-04T17:31:00.000Z",
      reviewerId: "operator",
    },
  });

  assert.equal(promotion.approved, true);
  assert.equal(promotion.instinct_artifact.scope, "project");
  assert.equal(promotion.instinct_artifact.project_id, "example-project");
  assert.equal(promotion.instinct_artifact.provenance.source_type, "discovery_candidate");
  assert.equal(promotion.instinct_artifact.provenance.suggestion_category, "shipped_capability");
  assert.equal(promotion.instinct_artifact.promotion_review.reviewer_id, "operator");
  assert.equal(promotion.instinct_artifact.promotion_review.review_level, "standard");
  assert.equal(promotion.instinct_artifact.confidence, 0.6);
  assert.equal(promotion.confidence_evaluation.final_confidence, 0.6);
  assert.equal(promotion.instinct_artifact.status, "tentative");
});

test("promoteDiscoveryCandidateToInstinct returns an explicit rejected review result", () => {
  const promotion = promoteDiscoveryCandidateToInstinct({
    candidate: createDiscoveryCandidate({
      suggestion_category: "technical_debt",
    }),
    confidence: 0.3,
    domain: "policy_tuning",
    projectId: "example-project",
    review: {
      decision: "reject",
      rationale: "Debt-like candidates should not be promoted into durable memory yet.",
      reviewedAt: "2026-04-04T17:32:00.000Z",
      reviewerId: "operator",
    },
  });

  assert.equal(promotion.approved, false);
  assert.equal(promotion.instinct_artifact, null);
  assert.match(promotion.reason_rejected, /not be promoted/i);
  assert.equal(promotion.review_record.reviewer_id, "operator");
});

test("promoteDiscoveryCandidateToInstinct preserves explicit confidence overrides", () => {
  const promotion = promoteDiscoveryCandidateToInstinct({
    candidate: createDiscoveryCandidate(),
    confidence: 0.92,
    domain: "workflow_optimization",
    evidence: {
      confirmingSessions: ["task-1", "task-2"],
      lastObserved: "2026-04-04T17:30:00.000Z",
      observationCount: 4,
    },
    projectId: "example-project",
    review: {
      decision: "approve",
      rationale: "Operator override should remain stronger than default confidence policy.",
      reviewedAt: "2026-04-04T17:31:00.000Z",
      reviewerId: "operator",
    },
  });

  assert.equal(promotion.confidence_evaluation.final_confidence, 0.6);
  assert.equal(promotion.instinct_artifact.confidence, 0.92);
});

test("promoteDiscoveryCandidateToInstinct requires explicit security review for suspicious candidates", () => {
  const promotion = promoteDiscoveryCandidateToInstinct({
    candidate: createDiscoveryCandidate({
      security_findings: [{
        auto_fixable: false,
        blocking: true,
        category: "supply_chain",
        remediation_hint: "Review before promotion.",
        rule_id: "security/prompt-injection-carrier",
        severity: "high",
        source_surface_id: "registry-entry",
        source_surface_type: "discovery",
        summary: "Imported content may carry prompt-injection instructions.",
      }],
      source_kind: "registry",
      source_ref: "registry://review-skill",
      suggestion_category: "technical_debt",
    }),
    domain: "evidence_patterns",
    evidence: {
      confirmingSessions: ["task-1", "task-2"],
      lastObserved: "2026-04-04T17:30:00.000Z",
      observationCount: 4,
    },
    projectId: "example-project",
    review: {
      decision: "approve",
      rationale: "Promotion is otherwise acceptable, but security review is still required.",
      reviewedAt: "2026-04-04T17:31:00.000Z",
      reviewerId: "operator",
    },
  });

  assert.equal(promotion.approved, false);
  assert.equal(promotion.instinct_artifact, null);
  assert.equal(promotion.security_evaluation.status, "requires_review");
  assert.match(promotion.reason_rejected, /explicit security review/i);
});

test("promoteDiscoveryCandidateToInstinct records an allowed security review for suspicious candidates", () => {
  const promotion = promoteDiscoveryCandidateToInstinct({
    candidate: createDiscoveryCandidate({
      security_findings: [{
        auto_fixable: false,
        blocking: true,
        category: "supply_chain",
        remediation_hint: "Review before promotion.",
        rule_id: "security/prompt-injection-carrier",
        severity: "high",
        source_surface_id: "registry-entry",
        source_surface_type: "discovery",
        summary: "Imported content may carry prompt-injection instructions.",
      }],
      source_kind: "registry",
      source_ref: "registry://review-skill",
      suggestion_category: "technical_debt",
    }),
    domain: "evidence_patterns",
    evidence: {
      confirmingSessions: ["task-1", "task-2"],
      lastObserved: "2026-04-04T17:30:00.000Z",
      observationCount: 4,
    },
    projectId: "example-project",
    review: {
      decision: "approve",
      rationale: "Promotion may proceed after explicit security audit.",
      reviewedAt: "2026-04-04T17:31:00.000Z",
      reviewerId: "operator",
    },
    securityReview: {
      decision: "allow",
      rationale: "The suspicious content was audited and accepted as a reviewed local pattern.",
      reviewedAt: "2026-04-04T17:31:30.000Z",
      reviewerId: "security-operator",
    },
  });

  assert.equal(promotion.approved, true);
  assert.equal(promotion.security_evaluation.status, "allowed_with_review");
  assert.equal(promotion.instinct_artifact.security_review.reviewer_id, "security-operator");
  assert.equal(promotion.instinct_artifact.security_review.risk_level, "high");
  assert.deepEqual(promotion.instinct_artifact.security_review.trigger_refs, ["security/prompt-injection-carrier"]);
});

test("promoteDiscoveryCandidateToInstinct requires elevated multi-project proof for global scope", () => {
  const promotion = promoteDiscoveryCandidateToInstinct({
    candidate: createDiscoveryCandidate(),
    domain: "agent_routing",
    evidence: {
      confirmingSessions: ["task-1", "task-2"],
      lastObserved: "2026-04-04T17:30:00.000Z",
      observationCount: 6,
      projectIds: ["example-project"],
    },
    review: {
      decision: "approve",
      rationale: "Attempted global promotion without sufficient threshold proof.",
      reviewedAt: "2026-04-04T17:31:00.000Z",
      reviewerId: "operator",
      reviewLevel: "standard",
    },
    scope: "global",
  });

  assert.equal(promotion.approved, false);
  assert.equal(promotion.instinct_artifact, null);
  assert.match(promotion.reason_rejected, /multi-project proof/i);
  assert.equal(promotion.threshold_evaluation.required_review_level, "elevated");
});

test("promoteDiscoveryCandidateToInstinct allows global scope after elevated multi-project review", () => {
  const promotion = promoteDiscoveryCandidateToInstinct({
    candidate: createDiscoveryCandidate(),
    domain: "agent_routing",
    evidence: {
      confirmingSessions: ["task-1", "task-2", "task-3"],
      lastObserved: "2026-04-04T17:30:00.000Z",
      observationCount: 11,
      projectIds: ["example-project", "apollo"],
    },
    review: {
      decision: "approve",
      rationale: "Repeated evidence across projects justifies elevated global promotion review.",
      reviewedAt: "2026-04-04T17:31:00.000Z",
      reviewerId: "operator",
      reviewLevel: "elevated",
    },
    scope: "global",
    status: "promoted",
  });

  assert.equal(promotion.approved, true);
  assert.equal(promotion.instinct_artifact.scope, "global");
  assert.equal(promotion.instinct_artifact.project_id, null);
  assert.equal(promotion.instinct_artifact.promotion_review.review_level, "elevated");
  assert.deepEqual(promotion.threshold_evaluation.observed_project_ids, ["example-project", "apollo"]);
});

test("promoteObservationToInstinct promotes repeated policy observations into reviewed project instincts", async () => {
  const { promoteObservationToInstinct } = await import("./instinct-promotion.js");
  const promotion = promoteObservationToInstinct({
    evidence: {
      confirmingSessions: ["task-1", "task-2"],
      lastObserved: "2026-04-04T18:10:00.000Z",
      observationCount: 3,
      projectIds: ["example-project"],
    },
    observation: {
      category: "pre_execution_gate",
      confidence: 1,
      payload: {
        decision: "blocked",
        operation: "danger.full_access",
      },
      policyRefs: ["policy/pre_execution_gate/v1"],
      sourceId: "task-1:gate-block",
      sourceKind: "pre_execution_gate",
      summary: "blocked dangerous operation",
    },
    projectId: "example-project",
    review: {
      decision: "approve",
      rationale: "Repeated gate blocks justify a reusable blocker-resolution instinct.",
      reviewedAt: "2026-04-04T18:11:00.000Z",
      reviewerId: "operator",
    },
  });

  assert.equal(promotion.approved, true);
  assert.equal(promotion.ingress_evaluation.derived_domain, "blocker_resolution");
  assert.equal(promotion.source_observation.source_kind, "pre_execution_gate");
  assert.equal(promotion.instinct_artifact.source, "runtime_observation");
  assert.equal(promotion.instinct_artifact.provenance.source_type, "runtime_observation");
});

test("promoteObservationToInstinct rejects single observations and self-loop sources", async () => {
  const { promoteObservationToInstinct } = await import("./instinct-promotion.js");
  const singleObservation = promoteObservationToInstinct({
    evidence: {
      lastObserved: "2026-04-04T18:10:00.000Z",
      observationCount: 1,
      projectIds: ["example-project"],
    },
    observation: {
      category: "security_scan",
      confidence: 0.7,
      payload: {},
      sourceId: "security-scan:1",
      sourceKind: "security_scan_finding",
      summary: "low-risk security observation",
    },
    projectId: "example-project",
    review: {
      decision: "approve",
      rationale: "Single observations should stay observations.",
      reviewedAt: "2026-04-04T18:11:00.000Z",
      reviewerId: "operator",
    },
  });
  const selfLoopObservation = promoteObservationToInstinct({
    evidence: {
      lastObserved: "2026-04-04T18:10:00.000Z",
      observationCount: 3,
      projectIds: ["example-project"],
    },
    observation: {
      category: "policy_signal",
      confidence: 0.7,
      payload: {},
      sourceId: "learning-loop:1",
      sourceKind: "learning_observer",
      summary: "self-loop attempt",
    },
    projectId: "example-project",
    review: {
      decision: "approve",
      rationale: "Self-loop sources should never be promoted.",
      reviewedAt: "2026-04-04T18:11:00.000Z",
      reviewerId: "operator",
    },
  });

  assert.equal(singleObservation.approved, false);
  assert.match(singleObservation.reason_rejected, /single observations remain observations/i);
  assert.equal(selfLoopObservation.approved, false);
  assert.match(selfLoopObservation.reason_rejected, /self-referential source kind/i);
});

test("promoteObservationToInstinct derives instinct domains from explicit orchestration pattern categories", async () => {
  const { promoteObservationToInstinct } = await import("./instinct-promotion.js");
  const routingPromotion = promoteObservationToInstinct({
    evidence: {
      lastObserved: "2026-04-04T18:10:00.000Z",
      observationCount: 3,
      projectIds: ["example-project"],
    },
    observation: {
      category: "route_selection",
      confidence: 0.8,
      payload: {
        selected_agent: "fast-reviewer",
      },
      sourceId: "route-selection:1",
      sourceKind: "route_selection",
      summary: "selected fallback route",
    },
    projectId: "example-project",
    review: {
      decision: "approve",
      rationale: "Repeated routing preference may become a reviewed routing instinct.",
      reviewedAt: "2026-04-04T18:11:00.000Z",
      reviewerId: "operator",
    },
  });
  const decompositionPromotion = promoteObservationToInstinct({
    evidence: {
      lastObserved: "2026-04-04T18:10:00.000Z",
      observationCount: 3,
      projectIds: ["example-project"],
    },
    observation: {
      category: "policy_signal",
      confidence: 0.7,
      patternCategory: "task_decomposition",
      payload: {},
      sourceId: "decomposition:1",
      sourceKind: "manual_note",
      summary: "split large tasks into implementation and proof subtasks",
    },
    projectId: "example-project",
    review: {
      decision: "approve",
      rationale: "Repeated decomposition guidance may become a reviewed decomposition instinct.",
      reviewedAt: "2026-04-04T18:11:00.000Z",
      reviewerId: "operator",
    },
  });

  assert.equal(routingPromotion.approved, true);
  assert.equal(routingPromotion.source_observation.pattern_category, "routing_preference");
  assert.equal(routingPromotion.ingress_evaluation.derived_domain, "agent_routing");
  assert.equal(decompositionPromotion.approved, true);
  assert.equal(decompositionPromotion.source_observation.pattern_category, "task_decomposition");
  assert.equal(decompositionPromotion.ingress_evaluation.derived_domain, "task_decomposition");
});
