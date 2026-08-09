import test from "node:test";
import assert from "node:assert/strict";

import { createObservationArtifact } from "./observation-lifecycle.js";
import { classifyMemoryTaxonomy, evaluateMemoryTier } from "./memory-taxonomy.js";

function createObservation(overrides = {}) {
  return {
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
    ...overrides,
  };
}

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

function createSkillCandidate(overrides = {}) {
  return {
    id: "skill-candidate-routing-project-example-project",
    title: "routing skill candidate: fast reviewer",
    summary: "Clustered 2 related routing instincts by shared trigger/context signals.",
    scope: "project",
    project_id: "example-project",
    domains: ["agent_routing"],
    evidence: {
      instinct_count: 2,
      total_observation_count: 7,
      last_observed: "2026-04-04T20:05:00.000Z",
      project_ids: ["example-project"],
    },
    clustering: {
      shared_trigger_tokens: ["routing", "reviewer"],
      shared_context_signals: ["scope:project", "domain:agent_routing", "project:example-project"],
      similarity_score: 0.8,
    },
    provenance: {
      source_type: "instinct_cluster",
      source_ref: "instinct-cluster:instinct-routing-1,instinct-routing-2",
      source_summary: "Reviewed cluster over 2 routing instincts.",
      evidence_refs: ["instinct-routing-1", "instinct-routing-2"],
    },
    promotion_review: {
      reviewer_id: "operator",
      reviewed_at: "2026-04-04T20:10:00.000Z",
      rationale: "Two related routing instincts are strong enough to review as one reusable skill candidate.",
      review_level: "standard",
    },
    security_review: null,
    status: "candidate",
    created_at: "2026-04-04T20:10:00.000Z",
    updated_at: "2026-04-04T20:10:00.000Z",
    ...overrides,
  };
}

test("evaluateMemoryTier maps observation artifacts to daily memory", () => {
  const tier = evaluateMemoryTier({
    observationArtifact: createObservationArtifact({
      createdAt: "2026-04-04T00:00:00.000Z",
      observation: createObservation(),
    }),
  });

  assert.equal(tier.artifact_kind, "observation_artifact");
  assert.equal(tier.memory_tier, "daily");
  assert.match(tier.rationale, /daily memory inputs/i);
});

test("evaluateMemoryTier maps project-scoped reviewed learnings to projects memory", () => {
  const instinctTier = evaluateMemoryTier({
    instinct: createInstinct(),
  });
  const skillTier = evaluateMemoryTier({
    skillCandidate: createSkillCandidate(),
  });

  assert.equal(instinctTier.memory_tier, "projects");
  assert.equal(skillTier.memory_tier, "projects");
  assert.equal(instinctTier.project_id, "example-project");
  assert.equal(skillTier.project_id, "example-project");
});

test("evaluateMemoryTier maps global reviewed learnings to facts memory", () => {
  const instinctTier = evaluateMemoryTier({
    instinct: createInstinct({
      id: "instinct-routing-global",
      scope: "global",
      project_id: null,
      evidence: {
        observation_count: 6,
        last_observed: "2026-04-04T20:00:00.000Z",
        confirming_sessions: ["task-1", "task-2"],
        contradicting_count: 0,
        project_ids: ["example-project", "secondary-project"],
      },
      promotion_review: {
        reviewer_id: "operator",
        reviewed_at: "2026-04-04T20:01:00.000Z",
        rationale: "Repeated routing preference justified a reviewed global instinct.",
        review_level: "elevated",
      },
    }),
  });
  const skillTier = evaluateMemoryTier({
    skillCandidate: createSkillCandidate({
      id: "skill-candidate-routing-global",
      scope: "global",
      project_id: null,
      evidence: {
        instinct_count: 2,
        total_observation_count: 9,
        last_observed: "2026-04-04T20:05:00.000Z",
        project_ids: ["example-project", "secondary-project"],
      },
      clustering: {
        shared_trigger_tokens: ["routing", "reviewer"],
        shared_context_signals: ["scope:global", "domain:agent_routing"],
        similarity_score: 0.85,
      },
      promotion_review: {
        reviewer_id: "operator",
        reviewed_at: "2026-04-04T20:10:00.000Z",
        rationale: "Two related routing instincts are strong enough to review as one reusable global skill candidate.",
        review_level: "elevated",
      },
    }),
  });

  assert.equal(instinctTier.memory_tier, "facts");
  assert.equal(skillTier.memory_tier, "facts");
  assert.match(instinctTier.rationale, /cross-project durable knowledge/i);
});

test("classifyMemoryTaxonomy summarizes daily, projects, and facts counts", () => {
  const result = classifyMemoryTaxonomy({
    observationArtifacts: [
      createObservationArtifact({
        createdAt: "2026-04-04T00:00:00.000Z",
        observation: createObservation(),
      }),
    ],
    instincts: [
      createInstinct(),
      createInstinct({
        id: "instinct-routing-global",
        scope: "global",
        project_id: null,
        evidence: {
          observation_count: 6,
          last_observed: "2026-04-04T20:00:00.000Z",
          confirming_sessions: ["task-1", "task-2"],
          contradicting_count: 0,
          project_ids: ["example-project", "secondary-project"],
        },
        promotion_review: {
          reviewer_id: "operator",
          reviewed_at: "2026-04-04T20:01:00.000Z",
          rationale: "Repeated routing preference justified a reviewed global instinct.",
          review_level: "elevated",
        },
      }),
    ],
    skillCandidates: [
      createSkillCandidate(),
    ],
  });

  assert.deepEqual(result.summary, {
    daily: 1,
    facts: 1,
    projects: 2,
    total: 4,
  });
});
