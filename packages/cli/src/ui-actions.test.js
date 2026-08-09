import test from "node:test";
import assert from "node:assert/strict";

import {
  UiLifecycleActionError,
  countRetryAttempts,
  resolveUiLifecycleAction,
} from "./ui-actions.js";

test("planning and execution are separate operator actions", () => {
  const planning = resolveUiLifecycleAction({
    action: "start",
    taskStatus: "UNPLANNED",
  });
  assert.equal(planning.startPlanning, true);
  assert.equal(planning.startExecution, false);

  assert.throws(
    () => resolveUiLifecycleAction({
      action: "start",
      taskStatus: "PENDING",
    }),
    (error) =>
      error instanceof UiLifecycleActionError
      && error.code === "plan_approval_required",
  );

  const approval = resolveUiLifecycleAction({
    action: "approve",
    taskStatus: "PENDING",
  });
  assert.equal(approval.recordPlanApproval, true);

  const execution = resolveUiLifecycleAction({
    action: "start",
    planApproved: true,
    taskStatus: "PENDING",
  });
  assert.equal(execution.startExecution, true);
});

test("retry and blocker resolution fail closed while blockers remain active", () => {
  for (const action of ["retry", "resolve"]) {
    assert.throws(
      () => resolveUiLifecycleAction({
        action,
        activeBlockerCount: 1,
        taskStatus: "BLOCKED",
      }),
      (error) =>
        error instanceof UiLifecycleActionError
        && error.code === "active_blockers",
    );
  }
});

test("retry requires a current approval and creates a distinct bounded attempt", () => {
  assert.throws(
    () => resolveUiLifecycleAction({
      action: "retry",
      maxRejections: 5,
      maxRetryAttempts: 2,
      rejectionCount: 1,
      retryAttemptCount: 0,
      taskStatus: "REJECTED",
    }),
    (error) =>
      error instanceof UiLifecycleActionError
      && error.code === "plan_approval_required",
  );

  const retry = resolveUiLifecycleAction({
    action: "retry",
    maxRejections: 5,
    maxRetryAttempts: 2,
    planApproved: true,
    rejectionCount: 1,
    retryAttemptCount: 0,
    taskStatus: "REJECTED",
  });
  assert.equal(retry.startExecution, true);
  assert.equal(retry.createNewAttempt, true);
});

test("retry fails closed at either configured attempt or rejection limit", () => {
  assert.throws(
    () => resolveUiLifecycleAction({
      action: "retry",
      maxRejections: 5,
      maxRetryAttempts: 2,
      planApproved: true,
      rejectionCount: 1,
      retryAttemptCount: 2,
      taskStatus: "BLOCKED",
    }),
    (error) =>
      error instanceof UiLifecycleActionError
      && error.code === "retry_attempt_limit_reached",
  );
  assert.throws(
    () => resolveUiLifecycleAction({
      action: "retry",
      maxRejections: 5,
      maxRetryAttempts: 2,
      planApproved: true,
      rejectionCount: 5,
      retryAttemptCount: 0,
      taskStatus: "BLOCKED",
    }),
    (error) =>
      error instanceof UiLifecycleActionError
      && error.code === "rejection_limit_reached",
  );
  assert.throws(
    () => resolveUiLifecycleAction({
      action: "retry",
      planApproved: true,
      taskStatus: "BLOCKED",
    }),
    (error) =>
      error instanceof UiLifecycleActionError
      && error.code === "retry_policy_unavailable",
  );
});

test("retry-attempt counting cannot be bypassed with legacy trigger provenance", () => {
  assert.equal(countRetryAttempts([
    { trigger: "cli" },
    { trigger: "ui-retry" },
    { trigger: "RETRY" },
    { trigger: "serve:retry:manual" },
    { trigger: "review" },
  ]), 4);
});

test("only supervised execution can be cancelled and review resolution reruns review", () => {
  assert.equal(resolveUiLifecycleAction({
    action: "cancel",
    taskStatus: "IN_PROGRESS",
  }).cancelExecution, true);
  assert.throws(
    () => resolveUiLifecycleAction({
      action: "cancel",
      taskStatus: "PLANNING",
    }),
    UiLifecycleActionError,
  );
  assert.equal(resolveUiLifecycleAction({
    action: "resolve",
    taskStatus: "IN_REVIEW",
  }).rerunReview, true);
  assert.throws(
    () => resolveUiLifecycleAction({
      action: "cancel",
      taskStatus: "DONE",
    }),
    UiLifecycleActionError,
  );
});
