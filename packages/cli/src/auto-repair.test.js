import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_REPAIR_TRIGGER,
  AutoRepairPolicyError,
  assertAutoRepairClaimPolicy,
  createAutoRepairQueuePayloadPatch,
  parseAutoRepairEnvelope,
  resolveAutoRepairPriorAttempt,
  resolveBoundedAutoRepairDecision,
} from "./auto-repair.js";

function fixture(overrides = {}) {
  const priorAttempt = {
    canonical_verdict: "DEFECT",
    created_at: "2026-07-23T10:00:00.000Z",
    id: "attempt:prior",
    stage: "BLOCKED",
    state: {
      review: {
        reason: "The focused regression still fails.",
      },
      workspace: {
        plan_approval_digest: "plan-digest-1",
      },
    },
    task_id: "task:repair",
    trigger: "serve",
  };
  const task = {
    id: "task:repair",
    max_rejections: 5,
    rejection_count: 1,
    status: "BLOCKED",
  };
  const queueEntry = {
    payload: {
      attempt_id: priorAttempt.id,
      canonical_verdict: priorAttempt.canonical_verdict,
    },
    state: "BLOCKED",
    task_id: task.id,
  };
  return {
    activeBlockerCount: 0,
    approvedPlanDigest: "plan-digest-1",
    attempts: [priorAttempt],
    config: {
      enabled: true,
      max_attempts: 2,
    },
    planApproved: true,
    promotionRecord: null,
    queueEntry,
    task,
    ...overrides,
  };
}

test("auto-repair is explicit opt-in and accepts only a blocked DEFECT", () => {
  assert.equal(
    resolveBoundedAutoRepairDecision(fixture({
      config: { enabled: false, max_attempts: 2 },
    })).reason,
    "config_disabled",
  );

  const eligible = resolveBoundedAutoRepairDecision(fixture());
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.sequence, 1);
  assert.equal(eligible.prior_attempt_id, "attempt:prior");
  assert.equal(eligible.prior_canonical_verdict, "DEFECT");
  assert.equal(eligible.trigger, AUTO_REPAIR_TRIGGER);

  for (const verdict of [
    "PASS",
    "ENV_BLOCK",
    "EVIDENCE_GAP",
    "NEEDS_ESCALATION",
  ]) {
    const state = fixture();
    state.attempts[0] = {
      ...state.attempts[0],
      canonical_verdict: verdict,
    };
    state.queueEntry = {
      ...state.queueEntry,
      payload: {
        ...state.queueEntry.payload,
        canonical_verdict: verdict,
      },
    };
    assert.equal(
      resolveBoundedAutoRepairDecision(state).reason,
      "verdict_not_repairable",
      verdict,
    );
  }
});

test("auto-repair fails closed on blockers, approval drift, promotion, and limits", () => {
  assert.equal(
    resolveBoundedAutoRepairDecision(fixture({
      activeBlockerCount: 1,
    })).reason,
    "active_blockers",
  );
  assert.equal(
    resolveBoundedAutoRepairDecision(fixture({
      approvedPlanDigest: "changed-plan",
    })).reason,
    "plan_approval_mismatch",
  );
  assert.equal(
    resolveBoundedAutoRepairDecision(fixture({
      promotionRecord: { status: "PENDING" },
    })).reason,
    "promotion_record_exists",
  );

  const exhausted = fixture();
  exhausted.attempts.push(
    {
      ...exhausted.attempts[0],
      created_at: "2026-07-23T10:01:00.000Z",
      id: "attempt:retry-1",
      trigger: "auto-repair",
    },
    {
      ...exhausted.attempts[0],
      created_at: "2026-07-23T10:02:00.000Z",
      id: "attempt:retry-2",
      trigger: "auto-repair",
    },
  );
  exhausted.queueEntry = {
    ...exhausted.queueEntry,
    payload: {
      ...exhausted.queueEntry.payload,
      attempt_id: "attempt:retry-2",
    },
  };
  assert.equal(
    resolveBoundedAutoRepairDecision(exhausted).reason,
    "retry_attempt_limit_reached",
  );
});

test("queue provenance clears the old binding while preserving the immutable verdict", () => {
  const state = fixture();
  const priorSnapshot = structuredClone(state.attempts[0]);
  const decision = resolveBoundedAutoRepairDecision(state);
  const patch = createAutoRepairQueuePayloadPatch({
    decision,
    now: "2026-07-23T10:03:00.000Z",
  });

  assert.equal(patch.attempt_id, null);
  assert.equal(patch.attempt_trigger, null);
  assert.equal(patch.canonical_verdict, null);
  assert.equal(patch.auto_repair.prior_attempt_id, priorSnapshot.id);
  assert.equal(
    patch.auto_repair.prior_canonical_verdict,
    priorSnapshot.canonical_verdict,
  );
  assert.deepEqual(state.attempts[0], priorSnapshot);

  const queued = {
    ...state.queueEntry,
    payload: {
      ...state.queueEntry.payload,
      ...patch,
    },
    state: "PENDING",
  };
  assert.equal(parseAutoRepairEnvelope(queued).sequence, 1);
  assert.strictEqual(
    resolveAutoRepairPriorAttempt({
      approvedPlanDigest: "plan-digest-1",
      attempts: state.attempts,
      queueEntry: queued,
    }),
    state.attempts[0],
  );
});

test("repair provenance rejects plan drift and prior-attempt substitution", () => {
  const state = fixture();
  const patch = createAutoRepairQueuePayloadPatch({
    decision: resolveBoundedAutoRepairDecision(state),
  });
  const queued = {
    ...state.queueEntry,
    payload: {
      ...state.queueEntry.payload,
      ...patch,
    },
    state: "CLAIMED",
  };

  assert.throws(
    () => resolveAutoRepairPriorAttempt({
      approvedPlanDigest: "changed-plan",
      attempts: state.attempts,
      queueEntry: queued,
    }),
    (error) =>
      error instanceof AutoRepairPolicyError
      && error.code === "auto_repair_plan_changed",
  );
  assert.throws(
    () => resolveAutoRepairPriorAttempt({
      approvedPlanDigest: "plan-digest-1",
      attempts: [{
        ...state.attempts[0],
        canonical_verdict: "EVIDENCE_GAP",
      }],
      queueEntry: queued,
    }),
    (error) =>
      error instanceof AutoRepairPolicyError
      && error.code === "auto_repair_prior_attempt_mismatch",
  );
  assert.throws(
    () => resolveAutoRepairPriorAttempt({
      approvedPlanDigest: "plan-digest-1",
      attempts: state.attempts,
      queueEntry: {
        ...queued,
        payload: {
          ...queued.payload,
          attempt_id: "attempt:prior",
        },
      },
    }),
    (error) =>
      error instanceof AutoRepairPolicyError
      && error.code === "auto_repair_attempt_binding_invalid",
  );

  const activeRepair = {
    canonical_verdict: null,
    id: "attempt:repair-active",
    stage: "EXECUTED",
    state: {},
    task_id: "task:repair",
    trigger: AUTO_REPAIR_TRIGGER,
  };
  assert.strictEqual(
    resolveAutoRepairPriorAttempt({
      approvedPlanDigest: "plan-digest-1",
      attempts: [...state.attempts, activeRepair],
      boundAttempt: activeRepair,
      queueEntry: {
        ...queued,
        payload: {
          ...queued.payload,
          attempt_id: activeRepair.id,
        },
      },
    }),
    state.attempts[0],
  );
});

test("claim-time policy catches opt-out, new blockers, and a lowered cap", () => {
  const state = fixture();
  const patch = createAutoRepairQueuePayloadPatch({
    decision: resolveBoundedAutoRepairDecision(state),
  });
  const queued = {
    ...state.queueEntry,
    payload: {
      ...state.queueEntry.payload,
      ...patch,
    },
    state: "CLAIMED",
  };
  assert.equal(
    assertAutoRepairClaimPolicy({
      activeBlockerCount: 0,
      config: state.config,
      queueEntry: queued,
      task: state.task,
    }).sequence,
    1,
  );
  assert.throws(
    () => assertAutoRepairClaimPolicy({
      activeBlockerCount: 0,
      config: { enabled: false, max_attempts: 2 },
      queueEntry: queued,
      task: state.task,
    }),
    (error) =>
      error instanceof AutoRepairPolicyError
      && error.code === "auto_repair_disabled",
  );
  assert.throws(
    () => assertAutoRepairClaimPolicy({
      activeBlockerCount: 1,
      config: state.config,
      queueEntry: queued,
      task: state.task,
    }),
    (error) =>
      error instanceof AutoRepairPolicyError
      && error.code === "active_blockers",
  );
  assert.throws(
    () => assertAutoRepairClaimPolicy({
      activeBlockerCount: 0,
      config: { enabled: true, max_attempts: 0 },
      queueEntry: queued,
      task: state.task,
    }),
    (error) =>
      error instanceof AutoRepairPolicyError
      && error.code === "retry_attempt_limit_reached",
  );
});
