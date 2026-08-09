const UI_LIFECYCLE_ACTIONS = Object.freeze([
  "approve",
  "start",
  "cancel",
  "retry",
  "resolve",
]);

class UiLifecycleActionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "UiLifecycleActionError";
    this.code = options.code ?? "invalid_lifecycle_action";
    this.status = options.status ?? 409;
  }
}

function ensureRetryPolicyCount(value, label, { allowZero = true } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) {
    throw new UiLifecycleActionError(
      `${label} must be an integer >= ${minimum}`,
      {
        code: "retry_policy_unavailable",
        status: 503,
      },
    );
  }
  return value;
}

function isRetryAttemptTrigger(trigger) {
  if (typeof trigger !== "string") return false;
  return /(?:^|[-_:])retry(?:$|[-_:])/.test(trigger.trim().toLocaleLowerCase("en-US"));
}

function countRetryAttempts(attempts = []) {
  if (!Array.isArray(attempts)) {
    throw new UiLifecycleActionError("attempts must be an array", {
      code: "retry_policy_unavailable",
      status: 503,
    });
  }
  const explicitRetryCount = attempts.filter((attempt) =>
    isRetryAttemptTrigger(attempt?.trigger)).length;



  return Math.max(explicitRetryCount, Math.max(0, attempts.length - 1));
}

function assertRetryLifecyclePolicy({
  activeBlockerCount = 0,
  maxRejections = null,
  maxRetryAttempts = null,
  planApproved = false,
  rejectionCount = null,
  retryAttemptCount = null,
} = {}) {
  if (!Number.isInteger(activeBlockerCount) || activeBlockerCount < 0) {
    throw new UiLifecycleActionError("activeBlockerCount must be a non-negative integer", {
      status: 400,
    });
  }
  if (activeBlockerCount > 0) {
    throw new UiLifecycleActionError(
      "Resolve active blockers before retrying the task",
      { code: "active_blockers" },
    );
  }
  if (!planApproved) {
    throw new UiLifecycleActionError(
      "A current plan approval is required before retrying the task",
      { code: "plan_approval_required" },
    );
  }

  const normalizedRejectionCount = ensureRetryPolicyCount(
    rejectionCount,
    "rejectionCount",
  );
  const normalizedMaxRejections = ensureRetryPolicyCount(
    maxRejections,
    "maxRejections",
  );
  const normalizedRetryAttemptCount = ensureRetryPolicyCount(
    retryAttemptCount,
    "retryAttemptCount",
  );
  const normalizedMaxRetryAttempts = ensureRetryPolicyCount(
    maxRetryAttempts,
    "maxRetryAttempts",
  );

  if (normalizedRejectionCount >= normalizedMaxRejections) {
    throw new UiLifecycleActionError(
      `Retry rejected: task reached max_rejections (${normalizedMaxRejections})`,
      { code: "rejection_limit_reached" },
    );
  }
  if (normalizedRetryAttemptCount >= normalizedMaxRetryAttempts) {
    throw new UiLifecycleActionError(
      `Retry rejected: task reached the configured retry-attempt limit (${normalizedMaxRetryAttempts})`,
      { code: "retry_attempt_limit_reached" },
    );
  }

  return Object.freeze({
    maxRejections: normalizedMaxRejections,
    maxRetryAttempts: normalizedMaxRetryAttempts,
    rejectionCount: normalizedRejectionCount,
    retryAttemptCount: normalizedRetryAttemptCount,
  });
}

function resolveUiLifecycleAction({
  action,
  taskStatus,
  planApproved = false,
  activeBlockerCount = 0,
  maxRejections = null,
  maxRetryAttempts = null,
  rejectionCount = null,
  retryAttemptCount = null,
} = {}) {
  if (!UI_LIFECYCLE_ACTIONS.includes(action)) {
    throw new UiLifecycleActionError(`Unsupported lifecycle action: ${action}`, {
      status: 404,
    });
  }
  if (!Number.isInteger(activeBlockerCount) || activeBlockerCount < 0) {
    throw new UiLifecycleActionError("activeBlockerCount must be a non-negative integer", {
      status: 400,
    });
  }

  if (action === "approve" && taskStatus === "PENDING") {
    return Object.freeze({
      action,
      nextStatus: "PENDING",
      recordPlanApproval: true,
      startExecution: false,
      startPlanning: false,
      cancelExecution: false,
      rerunReview: false,
    });
  }

  if (action === "start" && taskStatus === "UNPLANNED") {
    return Object.freeze({
      action,
      nextStatus: "IN_PROGRESS",
      recordPlanApproval: false,
      startExecution: false,
      startPlanning: true,
      cancelExecution: false,
      rerunReview: false,
    });
  }

  if (action === "start" && taskStatus === "PENDING") {
    if (!planApproved) {
      throw new UiLifecycleActionError(
        "Plan approval is required before execution can start",
        { code: "plan_approval_required" },
      );
    }
    return Object.freeze({
      action,
      nextStatus: "IN_PROGRESS",
      recordPlanApproval: false,
      startExecution: true,
      startPlanning: false,
      cancelExecution: false,
      rerunReview: false,
    });
  }

  if (action === "cancel" && taskStatus === "IN_PROGRESS") {
    return Object.freeze({
      action,
      nextStatus: "BLOCKED",
      recordPlanApproval: false,
      startExecution: false,
      startPlanning: false,
      cancelExecution: true,
      rerunReview: false,
    });
  }

  if (action === "retry" && ["BLOCKED", "REJECTED"].includes(taskStatus)) {
    assertRetryLifecyclePolicy({
      activeBlockerCount,
      maxRejections,
      maxRetryAttempts,
      planApproved,
      rejectionCount,
      retryAttemptCount,
    });
    return Object.freeze({
      action,
      createNewAttempt: true,
      nextStatus: "IN_PROGRESS",
      recordPlanApproval: false,
      startExecution: true,
      startPlanning: false,
      cancelExecution: false,
      rerunReview: false,
    });
  }

  if (action === "resolve" && taskStatus === "BLOCKED") {
    if (activeBlockerCount > 0) {
      throw new UiLifecycleActionError(
        "The task still has active blockers",
        { code: "active_blockers" },
      );
    }
    return Object.freeze({
      action,
      nextStatus: "PENDING",
      recordPlanApproval: false,
      startExecution: false,
      startPlanning: false,
      cancelExecution: false,
      rerunReview: false,
    });
  }

  if (action === "resolve" && taskStatus === "IN_REVIEW") {
    return Object.freeze({
      action,
      nextStatus: null,
      recordPlanApproval: false,
      startExecution: false,
      startPlanning: false,
      cancelExecution: false,
      rerunReview: true,
    });
  }

  throw new UiLifecycleActionError(
    `Action ${action} is not allowed while task status is ${taskStatus}`,
  );
}

export {
  UI_LIFECYCLE_ACTIONS,
  UiLifecycleActionError,
  assertRetryLifecyclePolicy,
  countRetryAttempts,
  isRetryAttemptTrigger,
  resolveUiLifecycleAction,
};
