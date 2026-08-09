import assert from "node:assert/strict";
import test from "node:test";

import {
  AttemptStage,
  CanonicalVerdict,
  PromotionStatus,
  canTransitionAttemptStage,
  createPromotionRecord,
  createTaskAttempt,
  createTaskAttemptResult,
  isPromotionAllowed,
  parsePromotionRecord,
  parseTaskAttempt,
} from "./task-attempt.js";

const NOW = "2026-07-23T10:00:00.000Z";

test("task attempt contract defines the supervised lifecycle and terminal invariants", () => {
  const claimed = createTaskAttempt({
    id: "attempt-1",
    taskId: "task-1",
    trigger: "cli",
    engineVersion: "rc-1",
    now: NOW,
  });

  assert.equal(claimed.stage, AttemptStage.CLAIMED);
  assert.equal(claimed.version, 0);
  assert.equal(canTransitionAttemptStage(
    AttemptStage.CLAIMED,
    AttemptStage.WORKSPACE_PREPARED,
  ), true);
  assert.equal(canTransitionAttemptStage(
    AttemptStage.CLAIMED,
    AttemptStage.PROMOTED,
  ), false);
  assert.throws(
    () => parseTaskAttempt({
      ...claimed,
      stage: AttemptStage.FINISHED,
      canonical_verdict: CanonicalVerdict.DEFECT,
      finished_at: NOW,
    }),
    /require canonical_verdict PASS/,
  );
  assert.throws(
    () => parseTaskAttempt({
      ...claimed,
      stage: AttemptStage.BLOCKED,
    }),
    /require a non-null finished_at/,
  );
});

test("promotion and result contracts allow reviewable branch or PR promotion only", () => {
  const ready = parseTaskAttempt({
    ...createTaskAttempt({
      id: "attempt-2",
      taskId: "task-2",
      trigger: "serve",
      engineVersion: "rc-1",
      now: NOW,
    }),
    stage: AttemptStage.READY_TO_PROMOTE,
    canonical_verdict: CanonicalVerdict.PASS,
    version: 5,
  });
  const pending = createPromotionRecord({
    id: "promotion:attempt-2",
    attemptId: ready.id,
    taskId: ready.task_id,
    now: NOW,
  });
  const promoted = parsePromotionRecord({
    ...pending,
    status: PromotionStatus.PROMOTED,
    target_kind: "BRANCH",
    target_ref: "refs/heads/niis/task-2",
    branch_name: "niis/task-2",
    promoted_at: NOW,
    updated_at: NOW,
    version: 1,
  });
  const result = createTaskAttemptResult({
    attempt: parseTaskAttempt({
      ...ready,
      stage: AttemptStage.PROMOTED,
      version: 6,
    }),
    promotion: promoted,
  });

  assert.equal(isPromotionAllowed(ready), true);
  assert.equal(result.promoted, true);
  assert.equal(result.promotion.target_kind, "BRANCH");
  assert.equal(result.resumable, true);
});
