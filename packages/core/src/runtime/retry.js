import { createHash } from "node:crypto";

import { parseAdapterResponse } from "../schemas/adapter-response.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import { createFailureReport } from "./failure.js";

class RetryPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "RetryPolicyError";
  }
}

const RETRY_MODES = Object.freeze(["continuation", "failure"]);
const RETRY_PLAN_STATUSES = Object.freeze(["SCHEDULED", "BLOCKED", "EXHAUSTED", "STALE"]);

const DEFAULT_RETRY_POLICY = Object.freeze({
  continuationDelayMs: 15 * 1000,
  failureBaseDelayMs: 5 * 1000,
  failureMaxDelayMs: 5 * 60 * 1000,
  failureBackoffMultiplier: 2,
  cooldownMs: 0,
  maxAttempts: 5,
});

function ensurePositiveInteger(value, label, { minimum = 1 } = {}) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RetryPolicyError(`${label} must be an integer >= ${minimum}`);
  }

  return value;
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RetryPolicyError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureRetryMode(mode) {
  if (!RETRY_MODES.includes(mode)) {
    throw new RetryPolicyError(`unsupported retry mode: ${mode}`);
  }

  return mode;
}

function createRetryPolicy({
  continuationDelayMs = DEFAULT_RETRY_POLICY.continuationDelayMs,
  failureBaseDelayMs = DEFAULT_RETRY_POLICY.failureBaseDelayMs,
  failureMaxDelayMs = DEFAULT_RETRY_POLICY.failureMaxDelayMs,
  failureBackoffMultiplier = DEFAULT_RETRY_POLICY.failureBackoffMultiplier,
  cooldownMs = DEFAULT_RETRY_POLICY.cooldownMs,
  maxAttempts = DEFAULT_RETRY_POLICY.maxAttempts,
} = {}) {
  const normalizedPolicy = {
    continuationDelayMs: ensurePositiveInteger(continuationDelayMs, "continuationDelayMs"),
    cooldownMs: ensurePositiveInteger(cooldownMs, "cooldownMs", { minimum: 0 }),
    failureBackoffMultiplier: ensurePositiveInteger(
      failureBackoffMultiplier,
      "failureBackoffMultiplier",
    ),
    failureBaseDelayMs: ensurePositiveInteger(failureBaseDelayMs, "failureBaseDelayMs"),
    failureMaxDelayMs: ensurePositiveInteger(failureMaxDelayMs, "failureMaxDelayMs"),
    maxAttempts: ensurePositiveInteger(maxAttempts, "maxAttempts"),
  };

  if (normalizedPolicy.failureMaxDelayMs < normalizedPolicy.failureBaseDelayMs) {
    throw new RetryPolicyError("failureMaxDelayMs must be >= failureBaseDelayMs");
  }

  return Object.freeze(normalizedPolicy);
}

function calculateRetryDelay({
  mode,
  attempt,
  retryPolicy = createRetryPolicy(),
}) {
  ensureRetryMode(mode);
  ensurePositiveInteger(attempt, "attempt");

  if (mode === "continuation") {
    return retryPolicy.continuationDelayMs;
  }

  const exponentialDelay =
    retryPolicy.failureBaseDelayMs * retryPolicy.failureBackoffMultiplier ** (attempt - 1);

  return Math.min(exponentialDelay, retryPolicy.failureMaxDelayMs);
}

function createRetryDispatchToken({
  taskId,
  runId,
  mode,
  attempt,
  issuedAt = new Date(),
}) {
  const normalizedMode = ensureRetryMode(mode);
  const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
  const normalizedRunId = ensureNonEmptyString(runId, "runId");
  const normalizedAttempt = ensurePositiveInteger(attempt, "attempt");
  const issuedAtTimestamp = toIsoTimestamp(issuedAt, "issuedAt");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        attempt: normalizedAttempt,
        issued_at: issuedAtTimestamp,
        mode: normalizedMode,
        run_id: normalizedRunId,
        task_id: normalizedTaskId,
      }),
    )
    .digest("hex");

  return Object.freeze({
    attempt: normalizedAttempt,
    issued_at: issuedAtTimestamp,
    retry_mode: normalizedMode,
    run_id: normalizedRunId,
    task_id: normalizedTaskId,
    token: fingerprint,
  });
}

function isRetryDispatchTokenStale({
  token,
  activeToken,
}) {
  if (!activeToken) {
    return false;
  }

  if (!token || !activeToken) {
    throw new RetryPolicyError("token and activeToken must be provided for stale checks");
  }

  if (token.task_id !== activeToken.task_id || token.run_id !== activeToken.run_id) {
    return true;
  }

  if (token.token === activeToken.token) {
    return false;
  }

  if (token.attempt < activeToken.attempt) {
    return true;
  }

  if (token.attempt === activeToken.attempt) {
    return Date.parse(token.issued_at) < Date.parse(activeToken.issued_at);
  }

  return false;
}

function assertRetryDispatchTokenFresh({
  token,
  activeToken,
}) {
  if (isRetryDispatchTokenStale({ token, activeToken })) {
    throw new RetryPolicyError(
      `retry dispatch token for ${token.task_id}/${token.run_id} is stale and must not dispatch`,
    );
  }

  return true;
}

function calculateNextEligibleAt({
  now,
  lastAttemptAt = null,
  delayMs,
  cooldownMs,
}) {
  const nowTimestamp = Date.parse(toIsoTimestamp(now, "now"));
  const delayTarget = nowTimestamp + delayMs;

  if (!lastAttemptAt) {
    return new Date(delayTarget).toISOString();
  }

  const cooldownTarget =
    Date.parse(toIsoTimestamp(lastAttemptAt, "lastAttemptAt")) + cooldownMs;

  return new Date(Math.max(delayTarget, cooldownTarget)).toISOString();
}

function createRetryArtifacts({
  retryPlan,
  now = new Date(),
  actor = "runtime",
  policyRef = "runtime/retry-policy/v1",
}) {
  const timestamp = toIsoTimestamp(now, "now");
  const oppositeMode =
    retryPlan.retry_mode === "continuation" ? "failure" : "continuation";
  const modeSummary =
    retryPlan.retry_mode === "continuation"
      ? "Normal completion scheduled a short continuation probe."
      : "Failure retry scheduled with capped exponential backoff.";

  const event = parseEventLogEntry({
    id: `${retryPlan.run_id}:retry:${timestamp}`,
    run_id: retryPlan.run_id,
    task_id: retryPlan.task_id,
    event_type: "POLICY_DECISION",
    timestamp,
    actor,
    payload: {
      attempt: retryPlan.attempt,
      cooldown_ms: retryPlan.cooldown_ms,
      delay_ms: retryPlan.delay_ms,
      retry_mode: retryPlan.retry_mode,
      scheduled_at: retryPlan.scheduled_at,
      status: retryPlan.status,
      token: retryPlan.dispatch_token?.token ?? null,
    },
  });

  const explainability = parseExplainabilityRecord({
    id: `${retryPlan.run_id}:retry-explain:${timestamp}`,
    decision_type: "ASSIGNMENT",
    task_id: retryPlan.task_id,
    route_chosen: `retry:${retryPlan.retry_mode}`,
    alternatives_considered: [
      {
        option: `retry:${oppositeMode}`,
        reason_rejected: `The policy selected ${retryPlan.retry_mode} retry semantics for this execution outcome.`,
      },
    ],
    policy_refs: [policyRef],
    evidence_refs: [retryPlan.run_id],
    timestamp,
    human_readable_summary: `${modeSummary} Attempt ${retryPlan.attempt} is eligible at ${retryPlan.scheduled_at}.`,
  });

  return {
    event,
    explainability,
  };
}

function planRetryAttempt({
  taskId,
  runId,
  mode,
  attempt,
  now = new Date(),
  lastAttemptAt = null,
  retryPolicy = createRetryPolicy(),
  adapterResponse = null,
  failure = null,
  activeToken = null,
  failureHistory = [],
  attemptedFixes = [],
  blockers = [],
}) {
  const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
  const normalizedRunId = ensureNonEmptyString(runId, "runId");
  const normalizedMode = ensureRetryMode(mode);
  const normalizedAttempt = ensurePositiveInteger(attempt, "attempt");
  const planningTimestamp = toIsoTimestamp(now, "now");

  if (normalizedAttempt > retryPolicy.maxAttempts) {
    return Object.freeze({
      allowed: false,
      attempt: normalizedAttempt,
      cooldown_ms: retryPolicy.cooldownMs,
      delay_ms: 0,
      dispatch_token: null,
      failure_report:
        failureHistory.length > 0
          ? createFailureReport({
              taskId: normalizedTaskId,
              attempts: normalizedAttempt - 1,
              failures: failureHistory,
              attemptedFixes,
              blockers,
              generatedAt: planningTimestamp,
            })
          : null,
      next_eligible_at: null,
      reason: `retry budget exhausted after ${retryPolicy.maxAttempts} attempts`,
      retry_mode: normalizedMode,
      run_id: normalizedRunId,
      scheduled_at: null,
      status: "EXHAUSTED",
      task_id: normalizedTaskId,
    });
  }

  if (normalizedMode === "failure" && adapterResponse !== null) {
    const normalizedResponse = parseAdapterResponse(adapterResponse);

    if (normalizedResponse.error && normalizedResponse.error.retry_safe === false) {
      return Object.freeze({
        allowed: false,
        attempt: normalizedAttempt,
        cooldown_ms: retryPolicy.cooldownMs,
        delay_ms: 0,
        dispatch_token: null,
        failure_report: null,
        next_eligible_at: null,
        reason: normalizedResponse.error.stop_condition,
        retry_mode: normalizedMode,
        run_id: normalizedRunId,
        scheduled_at: null,
        status: "BLOCKED",
        task_id: normalizedTaskId,
      });
    }
  }

  const latestFailure = failure ?? failureHistory.at(-1) ?? null;
  const latestFailureRetrySafe = latestFailure?.retry_safe ?? latestFailure?.retrySafe;
  if (normalizedMode === "failure" && latestFailureRetrySafe === false) {
    return Object.freeze({
      allowed: false,
      attempt: normalizedAttempt,
      cooldown_ms: retryPolicy.cooldownMs,
      delay_ms: 0,
      dispatch_token: null,
      failure_report: null,
      next_eligible_at: null,
      reason:
        latestFailure.stop_condition
        ?? latestFailure.stopCondition
        ?? latestFailure.summary
        ?? "automatic retry is blocked for this non-retryable failure",
      retry_mode: normalizedMode,
      run_id: normalizedRunId,
      scheduled_at: null,
      status: "BLOCKED",
      task_id: normalizedTaskId,
    });
  }

  const delayMs = calculateRetryDelay({
    mode: normalizedMode,
    attempt: normalizedAttempt,
    retryPolicy,
  });
  const scheduledAt = calculateNextEligibleAt({
    now: planningTimestamp,
    lastAttemptAt,
    delayMs,
    cooldownMs: retryPolicy.cooldownMs,
  });
  const dispatchToken = createRetryDispatchToken({
    taskId: normalizedTaskId,
    runId: normalizedRunId,
    mode: normalizedMode,
    attempt: normalizedAttempt,
    issuedAt: planningTimestamp,
  });

  if (activeToken && isRetryDispatchTokenStale({ token: dispatchToken, activeToken })) {
    return Object.freeze({
      allowed: false,
      attempt: normalizedAttempt,
      cooldown_ms: retryPolicy.cooldownMs,
      delay_ms: delayMs,
      dispatch_token: dispatchToken,
      failure_report: null,
      next_eligible_at: null,
      reason: "retry dispatch token is stale relative to the active retry plan",
      retry_mode: normalizedMode,
      run_id: normalizedRunId,
      scheduled_at: null,
      status: "STALE",
      task_id: normalizedTaskId,
    });
  }

  const plan = {
    allowed: true,
    attempt: normalizedAttempt,
    cooldown_ms: retryPolicy.cooldownMs,
    delay_ms: delayMs,
    dispatch_token: dispatchToken,
    failure_report: null,
    next_eligible_at: scheduledAt,
    reason:
      normalizedMode === "continuation"
        ? "normal completion scheduled a short continuation re-check"
        : "failure backoff retry scheduled",
    retry_mode: normalizedMode,
    run_id: normalizedRunId,
    scheduled_at: scheduledAt,
    status: "SCHEDULED",
    task_id: normalizedTaskId,
  };

  return Object.freeze({
    ...plan,
    ...createRetryArtifacts({
      retryPlan: plan,
      now: planningTimestamp,
    }),
  });
}

export {
  DEFAULT_RETRY_POLICY,
  RETRY_MODES,
  RETRY_PLAN_STATUSES,
  RetryPolicyError,
  assertRetryDispatchTokenFresh,
  calculateRetryDelay,
  createRetryArtifacts,
  createRetryDispatchToken,
  createRetryPolicy,
  isRetryDispatchTokenStale,
  planRetryAttempt,
};
