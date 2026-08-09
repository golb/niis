import test from "node:test";
import assert from "node:assert/strict";

import { calculateInstinctConfidence } from "./instinct-confidence.js";

test("calculateInstinctConfidence applies canonical default bands and adjustments", () => {
  const evaluation = calculateInstinctConfidence({
    evidence: {
      confirming_sessions: ["task-1", "task-2"],
      contradicting_count: 1,
      last_observed: "2026-04-04T00:00:00.000Z",
      observation_count: 4,
    },
    reviewedAt: "2026-04-04T12:00:00.000Z",
  });

  assert.equal(evaluation.base_confidence, 0.5);
  assert.equal(evaluation.adjustments.confirmation_bonus, 0.1);
  assert.equal(evaluation.adjustments.contradiction_penalty, 0.1);
  assert.equal(evaluation.adjustments.decay_penalty, 0);
  assert.equal(evaluation.final_confidence, 0.5);
});

test("calculateInstinctConfidence accepts policy overrides for decay and bonuses", () => {
  const evaluation = calculateInstinctConfidence({
    confidencePolicy: {
      confirmationBonusPerSession: 0.02,
      contradictionPenaltyPerItem: 0.05,
      decayGraceDays: 0,
      decayPenaltyPerDay: 0.02,
      maxDecayPenalty: 0.5,
    },
    evidence: {
      confirming_sessions: ["task-1"],
      contradicting_count: 0,
      last_observed: "2026-04-01T00:00:00.000Z",
      observation_count: 11,
    },
    reviewedAt: "2026-04-04T00:00:00.000Z",
  });

  assert.equal(evaluation.base_confidence, 0.85);
  assert.equal(evaluation.adjustments.confirmation_bonus, 0.02);
  assert.equal(evaluation.adjustments.decay_penalty, 0.06);
  assert.equal(evaluation.final_confidence, 0.81);
});
