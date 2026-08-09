import test from "node:test";
import assert from "node:assert/strict";

import { evaluateLearningGovernance } from "./learning-governance.js";

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

function createSkillCandidate(overrides = {}) {
  return {
    id: "skill-candidate-blocker-resolution-gate-publish-project-example-project",
    title: "blocker resolution skill candidate: gate, publish",
    summary: "Clustered 2 related instincts by shared trigger/context signals (gate, publish).",
    scope: "project",
    project_id: "example-project",
    domains: ["blocker_resolution"],
    evidence: {
      instinct_count: 2,
      total_observation_count: 7,
      last_observed: "2026-04-04T19:05:00.000Z",
      project_ids: ["example-project"],
    },
    clustering: {
      shared_trigger_tokens: ["gate", "publish"],
      shared_context_signals: ["scope:project", "domain:blocker_resolution", "project:example-project"],
      similarity_score: 0.75,
    },
    provenance: {
      source_type: "instinct_cluster",
      source_ref: "instinct-cluster:instinct-gate-block-1,instinct-gate-block-2",
      source_summary: "Reviewed cluster over 2 instincts.",
      evidence_refs: ["instinct-gate-block-1", "instinct-gate-block-2"],
    },
    promotion_review: {
      reviewer_id: "operator",
      reviewed_at: "2026-04-04T19:10:00.000Z",
      rationale: "Two related blocker instincts are strong enough to review as one reusable skill candidate.",
      review_level: "standard",
    },
    security_review: null,
    status: "candidate",
    created_at: "2026-04-04T19:10:00.000Z",
    updated_at: "2026-04-04T19:10:00.000Z",
    ...overrides,
  };
}

test("evaluateLearningGovernance blocks direct instinct-to-active-behavior progression", () => {
  const evaluation = evaluateLearningGovernance({
    instinct: createInstinct(),
    taskId: "learning-governance-instinct",
  });

  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.blocker?.blocker_class, "DEPENDENCY_UNMET");
  assert.equal(evaluation.package_manifest, null);
  assert.match(evaluation.blocker?.reason ?? "", /cannot directly affect active behavior/i);
});

test("evaluateLearningGovernance requires explicit operator approval for skill candidates", () => {
  const evaluation = evaluateLearningGovernance({
    skillCandidate: createSkillCandidate(),
    taskId: "learning-governance-pending",
  });

  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.blocker?.blocker_class, "MISSING_APPROVAL");
  assert.equal(evaluation.approval.status, "PENDING");
  assert.equal(evaluation.evidence_evaluation.ok, true);
  assert.equal(evaluation.package_manifest, null);
  assert.match(evaluation.explainability.human_readable_summary, /governance approval is still required/i);
});

test("evaluateLearningGovernance blocks reviewed skill packaging without durable evidence", () => {
  const evaluation = evaluateLearningGovernance({
    approval: {
      approvedAt: "2026-04-04T19:16:00.000Z",
      id: "approval-learning-insufficient-evidence",
      ownerRole: "operator",
      reason: "This candidate may proceed to reviewed package form.",
      requestedBy: "reviewer",
      status: "APPROVED",
      taskId: "learning-governance-insufficient-evidence",
    },
    skillCandidate: createSkillCandidate({
      evidence: {
        instinct_count: 2,
        total_observation_count: 2,
        last_observed: "2026-04-04T19:05:00.000Z",
        project_ids: ["example-project"],
      },
    }),
    taskId: "learning-governance-insufficient-evidence",
  });

  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.blocker?.blocker_class, "DEPENDENCY_UNMET");
  assert.equal(evaluation.evidence_evaluation.ok, false);
  assert.equal(evaluation.evidence_evaluation.required_observation_count, 4);
  assert.equal(evaluation.package_manifest, null);
  assert.match(evaluation.blocker?.reason ?? "", /durable evidence/i);
});

test("evaluateLearningGovernance only emits REVIEW skill manifests after approved governance", () => {
  const evaluation = evaluateLearningGovernance({
    approval: {
      approvedAt: "2026-04-04T19:16:00.000Z",
      id: "approval-learning-1",
      ownerRole: "operator",
      reason: "This candidate may proceed to reviewed package form.",
      requestedBy: "reviewer",
      status: "APPROVED",
      taskId: "learning-governance-approved",
    },
    skillCandidate: createSkillCandidate(),
    taskId: "learning-governance-approved",
  });

  assert.equal(evaluation.allowed, true);
  assert.equal(evaluation.blocker, null);
  assert.equal(evaluation.evidence_evaluation.ok, true);
  assert.equal(evaluation.package_manifest.type, "skill");
  assert.equal(evaluation.package_manifest.activation_status, "REVIEW");
  assert.notEqual(evaluation.package_manifest.activation_status, "ACTIVE");
  assert.equal(evaluation.target_status, "REVIEW");
  assert.match(evaluation.decision.summary, /approved/i);
});
