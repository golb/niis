import test from "node:test";
import assert from "node:assert/strict";

import {
  assertRetryDispatchTokenFresh,
  calculateRetryDelay,
  createRetryDispatchToken,
  createRetryPolicy,
  isRetryDispatchTokenStale,
  planRetryAttempt,
} from "./retry.js";
import { normalizeFailure } from "./failure.js";

test("calculateRetryDelay uses fixed continuation delay and capped failure backoff", () => {
  const retryPolicy = createRetryPolicy({
    continuationDelayMs: 15000,
    failureBaseDelayMs: 5000,
    failureBackoffMultiplier: 2,
    failureMaxDelayMs: 20000,
    maxAttempts: 5,
    cooldownMs: 0,
  });

  assert.equal(
    calculateRetryDelay({
      mode: "continuation",
      attempt: 3,
      retryPolicy,
    }),
    15000,
  );
  assert.equal(
    calculateRetryDelay({
      mode: "failure",
      attempt: 1,
      retryPolicy,
    }),
    5000,
  );
  assert.equal(
    calculateRetryDelay({
      mode: "failure",
      attempt: 3,
      retryPolicy,
    }),
    20000,
  );
});

test("planRetryAttempt blocks failure retry when adapter marks the error non-retriable", () => {
  const plan = planRetryAttempt({
    taskId: "TASK-1",
    runId: "run-1",
    mode: "failure",
    attempt: 1,
    adapterResponse: {
      status: "ERROR",
      summary: "Permission denied",
      next_actions: [],
      artifacts: [],
      cost: null,
      completion_signal: null,
      self_assessment: null,
      error: {
        root_cause: "missing adapter permission",
        category: "auth",
        retry_safe: false,
        retry_instruction: null,
        stop_condition: "Stop until credentials are fixed.",
        escalation_hint: "Update the adapter secret ref.",
      },
    },
  });

  assert.equal(plan.status, "BLOCKED");
  assert.equal(plan.allowed, false);
  assert.equal(plan.reason, "Stop until credentials are fixed.");
});

test("planRetryAttempt does not retry a normalized non-retryable runtime failure", () => {
  const failure = normalizeFailure({
    taskId: "TASK-ROUTE",
    runId: "run-route",
    now: "2026-03-21T10:30:00.000Z",
    error: Object.assign(new Error("routing capability mismatch"), {
      code: "ROUTING_CAPABILITY_MISMATCH",
      retrySafe: false,
    }),
  });
  const plan = planRetryAttempt({
    taskId: "TASK-ROUTE",
    runId: "run-route",
    mode: "failure",
    attempt: 1,
    failureHistory: [failure],
  });

  assert.equal(plan.status, "BLOCKED");
  assert.equal(plan.allowed, false);
  assert.equal(plan.dispatch_token, null);
  assert.match(plan.reason, /deterministic configuration incompatibility/);
});

test("planRetryAttempt schedules continuation retries with artifacts and token", () => {
  const retryPolicy = createRetryPolicy({
    continuationDelayMs: 10000,
    failureBaseDelayMs: 5000,
    failureBackoffMultiplier: 2,
    failureMaxDelayMs: 30000,
    maxAttempts: 5,
    cooldownMs: 2000,
  });
  const plan = planRetryAttempt({
    taskId: "TASK-1",
    runId: "run-1",
    mode: "continuation",
    attempt: 1,
    now: "2026-03-21T10:30:00.000Z",
    lastAttemptAt: "2026-03-21T10:29:59.000Z",
    retryPolicy,
  });

  assert.equal(plan.status, "SCHEDULED");
  assert.equal(plan.allowed, true);
  assert.equal(plan.delay_ms, 10000);
  assert.equal(plan.scheduled_at, "2026-03-21T10:30:10.000Z");
  assert.equal(plan.event.event_type, "POLICY_DECISION");
  assert.equal(plan.explainability.route_chosen, "retry:continuation");
  assert.equal(typeof plan.dispatch_token.token, "string");
});

test("retry dispatch tokens reject stale attempts", () => {
  const activeToken = createRetryDispatchToken({
    taskId: "TASK-1",
    runId: "run-1",
    mode: "failure",
    attempt: 2,
    issuedAt: "2026-03-21T10:30:05.000Z",
  });
  const staleToken = createRetryDispatchToken({
    taskId: "TASK-1",
    runId: "run-1",
    mode: "failure",
    attempt: 1,
    issuedAt: "2026-03-21T10:30:00.000Z",
  });

  assert.equal(
    isRetryDispatchTokenStale({
      token: staleToken,
      activeToken,
    }),
    true,
  );
  assert.throws(
    () =>
      assertRetryDispatchTokenFresh({
        token: staleToken,
        activeToken,
      }),
    /is stale/,
  );
});

test("planRetryAttempt emits a structured failure report when the retry budget is exhausted", () => {
  const failureHistory = [
    normalizeFailure({
      taskId: "TASK-1",
      runId: "run-1",
      kind: "timeout",
      now: "2026-03-21T10:20:00.000Z",
      error: new Error("first timeout"),
    }),
    normalizeFailure({
      taskId: "TASK-1",
      runId: "run-2",
      kind: "timeout",
      now: "2026-03-21T10:25:00.000Z",
      error: new Error("second timeout"),
    }),
  ];

  const plan = planRetryAttempt({
    taskId: "TASK-1",
    runId: "run-3",
    mode: "failure",
    attempt: 3,
    retryPolicy: createRetryPolicy({
      continuationDelayMs: 10000,
      failureBaseDelayMs: 5000,
      failureBackoffMultiplier: 2,
      failureMaxDelayMs: 20000,
      maxAttempts: 2,
      cooldownMs: 0,
    }),
    failureHistory,
    attemptedFixes: ["restarted adapter"],
    blockers: ["operator escalation pending"],
    now: "2026-03-21T10:30:00.000Z",
  });

  assert.equal(plan.status, "EXHAUSTED");
  assert.equal(plan.allowed, false);
  assert.equal(plan.failure_report?.attempts, 2);
  assert.equal(plan.failure_report?.terminal_action, "retry");
});
