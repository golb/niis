import { parseAdapterResponse } from "../schemas/adapter-response.js";
import { parseBlockerArtifact } from "../schemas/blocker.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { parseRunRecord } from "../schemas/run.js";
import { findTaskLease } from "../scheduler/lease.js";
import { toIsoTimestamp } from "../scheduler/queue.js";

class RuntimeFailureError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeFailureError";
  }
}

const FAILURE_CLASSES = Object.freeze([
  "ADAPTER_TIMEOUT",
  "ADAPTER_ERROR",
  "VALIDATION_FAILURE",
  "ENVIRONMENT_BLOCK",
  "RESOURCE_LIMIT",
  "AUTH_FAILURE",
  "PERMANENT_FAILURE",
  "STALL_DETECTED",
  "ORPHAN_RUN",
  "CHECKPOINT_FAILURE",
]);

const FAILURE_CATEGORIES = Object.freeze([
  "transient",
  "permanent",
  "env_block",
  "resource_limit",
  "auth",
]);

const FAILURE_NEXT_ACTIONS = Object.freeze(["retry", "recovery", "escalate", "block"]);
const FAILURE_SEVERITIES = Object.freeze(["warn", "error", "critical"]);
const ACTIVE_RUN_STATUSES = Object.freeze(["STARTED", "RUNNING"]);

const DEFAULT_FAILURE_POLICY = Object.freeze({
  stallTimeoutMs: 10 * 60 * 1000,
  maxCrashRecoveryAttempts: 3,
  maxOrphanRecoveryAttempts: 2,
  maxStallRecoveryAttempts: 2,
  crashWindowMs: 30 * 60 * 1000,
});

const CATEGORY_TO_FAILURE_CLASS = Object.freeze({
  transient: "ADAPTER_ERROR",
  permanent: "PERMANENT_FAILURE",
  env_block: "ENVIRONMENT_BLOCK",
  resource_limit: "RESOURCE_LIMIT",
  auth: "AUTH_FAILURE",
});

const CATEGORY_TO_NEXT_ACTION = Object.freeze({
  transient: "retry",
  permanent: "block",
  env_block: "escalate",
  resource_limit: "recovery",
  auth: "escalate",
});

const CATEGORY_TO_SEVERITY = Object.freeze({
  transient: "error",
  permanent: "error",
  env_block: "critical",
  resource_limit: "warn",
  auth: "critical",
});

function ensurePositiveInteger(value, label, { minimum = 1 } = {}) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RuntimeFailureError(`${label} must be an integer >= ${minimum}`);
  }

  return value;
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RuntimeFailureError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeFailureError(`${label} must be a plain object`);
  }

  return value;
}

function normalizeErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string" && error.trim() !== "") {
    return error.trim();
  }

  return "Unknown runtime error";
}

function resolveErrorRetrySafety(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return null;
  }

  const retrySafe = error.retry_safe ?? error.retrySafe;
  return typeof retrySafe === "boolean" ? retrySafe : null;
}

function ensureFailureClass(failureClass) {
  if (!FAILURE_CLASSES.includes(failureClass)) {
    throw new RuntimeFailureError(`unsupported failure class: ${failureClass}`);
  }

  return failureClass;
}

function ensureFailureCategory(category) {
  if (!FAILURE_CATEGORIES.includes(category)) {
    throw new RuntimeFailureError(`unsupported failure category: ${category}`);
  }

  return category;
}

function ensureFailureNextAction(nextAction) {
  if (!FAILURE_NEXT_ACTIONS.includes(nextAction)) {
    throw new RuntimeFailureError(`unsupported failure next action: ${nextAction}`);
  }

  return nextAction;
}

function ensureFailureSeverity(severity) {
  if (!FAILURE_SEVERITIES.includes(severity)) {
    throw new RuntimeFailureError(`unsupported failure severity: ${severity}`);
  }

  return severity;
}

function createFailurePolicy({
  stallTimeoutMs = DEFAULT_FAILURE_POLICY.stallTimeoutMs,
  maxCrashRecoveryAttempts = DEFAULT_FAILURE_POLICY.maxCrashRecoveryAttempts,
  maxOrphanRecoveryAttempts = DEFAULT_FAILURE_POLICY.maxOrphanRecoveryAttempts,
  maxStallRecoveryAttempts = DEFAULT_FAILURE_POLICY.maxStallRecoveryAttempts,
  crashWindowMs = DEFAULT_FAILURE_POLICY.crashWindowMs,
} = {}) {
  return Object.freeze({
    crashWindowMs: ensurePositiveInteger(crashWindowMs, "crashWindowMs"),
    maxCrashRecoveryAttempts: ensurePositiveInteger(
      maxCrashRecoveryAttempts,
      "maxCrashRecoveryAttempts",
    ),
    maxOrphanRecoveryAttempts: ensurePositiveInteger(
      maxOrphanRecoveryAttempts,
      "maxOrphanRecoveryAttempts",
    ),
    maxStallRecoveryAttempts: ensurePositiveInteger(
      maxStallRecoveryAttempts,
      "maxStallRecoveryAttempts",
    ),
    stallTimeoutMs: ensurePositiveInteger(stallTimeoutMs, "stallTimeoutMs"),
  });
}

function createFailureRecord({
  taskId,
  runId,
  source = "runtime",
  component = "serve",
  detectedAt = new Date(),
  failureClass,
  category,
  nextAction,
  retrySafe,
  severity = "error",
  summary,
  rootCause,
  stopCondition,
  escalationHint = null,
  details = {},
}) {
  ensureNonEmptyString(taskId, "taskId");
  ensureNonEmptyString(runId, "runId");
  ensureNonEmptyString(source, "source");
  ensureNonEmptyString(component, "component");
  ensureFailureClass(failureClass);
  ensureFailureCategory(category);
  ensureFailureNextAction(nextAction);
  ensureFailureSeverity(severity);

  if (typeof retrySafe !== "boolean") {
    throw new RuntimeFailureError("retrySafe must be a boolean");
  }

  return Object.freeze({
    category,
    component,
    details: ensurePlainObject(details, "details"),
    detected_at: toIsoTimestamp(detectedAt, "detectedAt"),
    escalation_hint: escalationHint === null ? null : ensureNonEmptyString(escalationHint, "escalationHint"),
    failure_class: failureClass,
    next_action: nextAction,
    retry_safe: retrySafe,
    root_cause: ensureNonEmptyString(rootCause, "rootCause"),
    run_id: runId,
    severity,
    source,
    stop_condition: ensureNonEmptyString(stopCondition, "stopCondition"),
    summary: ensureNonEmptyString(summary, "summary"),
    task_id: taskId,
  });
}

function normalizeRunInput(runRecord) {
  if (!runRecord || typeof runRecord !== "object") {
    throw new RuntimeFailureError("runRecord must be an object");
  }

  const normalized = parseRunRecord({
    id: runRecord.id,
    task_id: runRecord.task_id,
    subtask_id: runRecord.subtask_id ?? null,
    role_id: runRecord.role_id ?? null,
    agent_id: runRecord.agent_id,
    adapter_id: runRecord.adapter_id,
    status: runRecord.status,
    started_at: runRecord.started_at,
    finished_at: runRecord.finished_at ?? null,
    checkpoint_id: runRecord.checkpoint_id ?? null,
    exit_code: runRecord.exit_code ?? null,
    cost: runRecord.cost,
    invocation_source: runRecord.invocation_source,
    run_log: runRecord.run_log,
    task_session_key: runRecord.task_session_key ?? null,
  });

  return {
    ...normalized,
    component: typeof runRecord.component === "string" && runRecord.component.trim() !== ""
      ? runRecord.component.trim()
      : "serve",
    last_progress_at: toIsoTimestamp(
      runRecord.last_progress_at ?? normalized.started_at,
      "last_progress_at",
    ),
  };
}

function normalizeFailure({
  taskId,
  runId,
  kind = "error",
  source = "runtime",
  component = "serve",
  now = new Date(),
  adapterResponse = null,
  error = null,
  details = {},
} = {}) {
  ensureNonEmptyString(taskId, "taskId");
  ensureNonEmptyString(runId, "runId");
  const timestamp = toIsoTimestamp(now, "now");

  if (adapterResponse !== null) {
    const normalizedResponse = parseAdapterResponse(adapterResponse);

    if (normalizedResponse.status === "TIMEOUT") {
      return createFailureRecord({
        taskId,
        runId,
        source,
        component,
        detectedAt: timestamp,
        failureClass: "ADAPTER_TIMEOUT",
        category: "transient",
        nextAction: "retry",
        retrySafe: normalizedResponse.error?.retry_safe ?? true,
        severity: "error",
        summary: normalizedResponse.summary,
        rootCause: normalizedResponse.error?.root_cause ?? normalizedResponse.summary,
        stopCondition:
          normalizedResponse.error?.stop_condition ??
          "Stop retrying when timeout retries exceed policy or the task leaves an active state.",
        escalationHint: normalizedResponse.error?.escalation_hint ?? null,
        details: {
          ...details,
          adapter_status: normalizedResponse.status,
          next_actions: normalizedResponse.next_actions,
        },
      });
    }

    if (normalizedResponse.error) {
      const failureClass = CATEGORY_TO_FAILURE_CLASS[normalizedResponse.error.category];
      const nextAction = CATEGORY_TO_NEXT_ACTION[normalizedResponse.error.category];
      const severity = CATEGORY_TO_SEVERITY[normalizedResponse.error.category];

      return createFailureRecord({
        taskId,
        runId,
        source,
        component,
        detectedAt: timestamp,
        failureClass,
        category: normalizedResponse.error.category,
        nextAction,
        retrySafe: normalizedResponse.error.retry_safe,
        severity,
        summary: normalizedResponse.summary,
        rootCause: normalizedResponse.error.root_cause,
        stopCondition: normalizedResponse.error.stop_condition,
        escalationHint: normalizedResponse.error.escalation_hint,
        details: {
          ...details,
          adapter_status: normalizedResponse.status,
          next_actions: normalizedResponse.next_actions,
        },
      });
    }
  }

  if (kind === "timeout") {
    return createFailureRecord({
      taskId,
      runId,
      source,
      component,
      detectedAt: timestamp,
      failureClass: "ADAPTER_TIMEOUT",
      category: "transient",
      nextAction: "retry",
      retrySafe: true,
      severity: "error",
      summary: "Execution timed out before the adapter returned a result.",
      rootCause: normalizeErrorMessage(error),
      stopCondition: "Stop retrying when timeout retries exceed policy or the task leaves an active state.",
      escalationHint: "Inspect adapter latency and workspace health if repeated timeouts continue.",
      details,
    });
  }

  if (kind === "validation") {
    return createFailureRecord({
      taskId,
      runId,
      source,
      component,
      detectedAt: timestamp,
      failureClass: "VALIDATION_FAILURE",
      category: "permanent",
      nextAction: "block",
      retrySafe: false,
      severity: "error",
      summary: "Runtime validation failed before execution could continue.",
      rootCause: normalizeErrorMessage(error),
      stopCondition: "Stop until configuration or state validation passes.",
      escalationHint: "Correct the invalid runtime configuration or task state and retry manually.",
      details,
    });
  }

  if (kind === "stall") {
    return createFailureRecord({
      taskId,
      runId,
      source,
      component,
      detectedAt: timestamp,
      failureClass: "STALL_DETECTED",
      category: "transient",
      nextAction: "recovery",
      retrySafe: true,
      severity: "warn",
      summary: "Active execution stalled beyond the configured timeout window.",
      rootCause: normalizeErrorMessage(error ?? "No progress heartbeat within the stall timeout."),
      stopCondition: "Stop auto-recovery after the configured stall recovery budget is exhausted.",
      escalationHint: "Inspect the adapter session, workspace hooks, and pending callbacks for deadlock.",
      details,
    });
  }

  if (kind === "orphan") {
    return createFailureRecord({
      taskId,
      runId,
      source,
      component,
      detectedAt: timestamp,
      failureClass: "ORPHAN_RUN",
      category: "transient",
      nextAction: "recovery",
      retrySafe: true,
      severity: "warn",
      summary: "Run is active but no matching lease or runtime owner exists.",
      rootCause: normalizeErrorMessage(error ?? "Run ownership was lost during reconciliation."),
      stopCondition: "Stop auto-recovery after the configured orphan recovery budget is exhausted.",
      escalationHint: "Reconcile leases, recover from checkpoint, or terminate the orphaned component.",
      details,
    });
  }

  if (kind === "checkpoint") {
    return createFailureRecord({
      taskId,
      runId,
      source,
      component,
      detectedAt: timestamp,
      failureClass: "CHECKPOINT_FAILURE",
      category: "env_block",
      nextAction: "escalate",
      retrySafe: false,
      severity: "critical",
      summary: "Checkpoint recovery failed and the run cannot be resumed safely.",
      rootCause: normalizeErrorMessage(error),
      stopCondition: "Stop until checkpoint integrity or session restoration is repaired.",
      escalationHint: "Inspect checkpoint storage, session codec compatibility, and restore inputs.",
      details,
    });
  }

  if (resolveErrorRetrySafety(error) === false) {
    return createFailureRecord({
      taskId,
      runId,
      source,
      component,
      detectedAt: timestamp,
      failureClass: "PERMANENT_FAILURE",
      category: "permanent",
      nextAction: "block",
      retrySafe: false,
      severity: "error",
      summary: "Execution stopped on a non-retryable runtime error.",
      rootCause: normalizeErrorMessage(error),
      stopCondition: "Stop automatic retries until the deterministic configuration incompatibility is corrected.",
      escalationHint: "Correct the reported routing or runtime configuration, then retry manually.",
      details: {
        ...details,
        error_code:
          typeof error.code === "string" && error.code.trim() !== ""
            ? error.code
            : null,
      },
    });
  }

  return createFailureRecord({
    taskId,
    runId,
    source,
    component,
    detectedAt: timestamp,
    failureClass: "ADAPTER_ERROR",
    category: "transient",
    nextAction: "retry",
    retrySafe: true,
    severity: "error",
    summary: "Execution failed with an unclassified runtime error.",
    rootCause: normalizeErrorMessage(error),
    stopCondition: "Stop retrying when the retry budget is exhausted or the task becomes ineligible.",
    escalationHint: "Inspect runtime diagnostics and adapter stderr for the failing run.",
    details,
  });
}

function createFailureArtifacts({
  failure,
  now = new Date(),
  actor = "runtime",
  policyRefs = ["runtime/failure-taxonomy/v1"],
}) {
  const timestamp = toIsoTimestamp(now, "now");
  const normalizedFailure = createFailureRecord({
    ...failure,
    taskId: failure.task_id,
    runId: failure.run_id,
    detectedAt: failure.detected_at,
    failureClass: failure.failure_class,
    nextAction: failure.next_action,
    retrySafe: failure.retry_safe,
    rootCause: failure.root_cause,
    stopCondition: failure.stop_condition,
    escalationHint: failure.escalation_hint,
  });
  const decisionType =
    normalizedFailure.next_action === "retry"
      ? "ASSIGNMENT"
      : normalizedFailure.next_action === "recovery"
        ? "GATE"
        : "BLOCKER";

  const event = parseEventLogEntry({
    id: `${normalizedFailure.run_id}:failure:${timestamp}`,
    run_id: normalizedFailure.run_id,
    task_id: normalizedFailure.task_id,
    event_type: "ERROR",
    timestamp,
    actor,
    payload: {
      category: normalizedFailure.category,
      component: normalizedFailure.component,
      failure_class: normalizedFailure.failure_class,
      next_action: normalizedFailure.next_action,
      retry_safe: normalizedFailure.retry_safe,
      severity: normalizedFailure.severity,
      summary: normalizedFailure.summary,
    },
  });

  const explainability = parseExplainabilityRecord({
    id: `${normalizedFailure.run_id}:failure-explain:${timestamp}`,
    decision_type: decisionType,
    task_id: normalizedFailure.task_id,
    route_chosen: `failure:${normalizedFailure.next_action}`,
    alternatives_considered: [],
    policy_refs: [...policyRefs],
    evidence_refs: [normalizedFailure.run_id],
    timestamp,
    human_readable_summary: `${normalizedFailure.failure_class} classified as ${normalizedFailure.category}; next action is ${normalizedFailure.next_action}.`,
  });

  const blocker =
    normalizedFailure.next_action === "block" || normalizedFailure.next_action === "escalate"
      ? parseBlockerArtifact({
          id: `${normalizedFailure.task_id}:${normalizedFailure.failure_class}:${timestamp}`,
          task_id: normalizedFailure.task_id,
          blocker_class: "ENV_BLOCK",
          reason: normalizedFailure.summary,
          next_action: normalizedFailure.escalation_hint ?? normalizedFailure.stop_condition,
          created_at: timestamp,
          resolved_at: null,
        })
      : null;

  return {
    blocker,
    event,
    explainability,
    failure: normalizedFailure,
  };
}

function detectStalledRuns({
  activeRuns,
  now = new Date(),
  stallTimeoutMs = DEFAULT_FAILURE_POLICY.stallTimeoutMs,
}) {
  const timestamp = toIsoTimestamp(now, "now");
  const timeoutMs = ensurePositiveInteger(stallTimeoutMs, "stallTimeoutMs");

  return activeRuns
    .map(normalizeRunInput)
    .filter((runRecord) => ACTIVE_RUN_STATUSES.includes(runRecord.status))
    .filter((runRecord) => Date.parse(timestamp) - Date.parse(runRecord.last_progress_at) >= timeoutMs)
    .map((runRecord) =>
      normalizeFailure({
        taskId: runRecord.task_id,
        runId: runRecord.id,
        kind: "stall",
        source: "runtime",
        component: runRecord.component,
        now: timestamp,
        details: {
          last_progress_at: runRecord.last_progress_at,
          started_at: runRecord.started_at,
          stall_timeout_ms: timeoutMs,
        },
      }),
    );
}

function reconcileOrphanedRuns({
  activeRuns,
  leases,
  recoveryAttempts = {},
  checkpointIdsByRunId = {},
  now = new Date(),
  policy = createFailurePolicy(),
}) {
  const timestamp = toIsoTimestamp(now, "now");

  return activeRuns
    .map(normalizeRunInput)
    .filter((runRecord) => ACTIVE_RUN_STATUSES.includes(runRecord.status))
    .map((runRecord) => {
      const activeLease = findTaskLease(leases, runRecord.task_id, timestamp);

      if (activeLease && activeLease.holder === runRecord.agent_id) {
        return null;
      }

      const attempts = recoveryAttempts[runRecord.id] ?? 0;
      const recoveryAction =
        attempts < policy.maxOrphanRecoveryAttempts
          ? checkpointIdsByRunId[runRecord.id]
            ? "resume"
            : "retry"
          : "incident";

      return {
        attempts,
        checkpoint_id: checkpointIdsByRunId[runRecord.id] ?? null,
        failure: normalizeFailure({
          taskId: runRecord.task_id,
          runId: runRecord.id,
          kind: "orphan",
          source: "runtime",
          component: runRecord.component,
          now: timestamp,
          details: {
            active_lease_holder: activeLease?.holder ?? null,
            checkpoint_id: checkpointIdsByRunId[runRecord.id] ?? null,
          },
        }),
        recovery_action: recoveryAction,
        run: runRecord,
      };
    })
    .filter(Boolean);
}

function createIncidentSnapshot({
  component = "serve",
  crashHistory = [],
  stalledFailures = [],
  orphanedRuns = [],
  generatedAt = new Date(),
}) {
  const timestamp = toIsoTimestamp(generatedAt, "generatedAt");

  return Object.freeze({
    component,
    crash_count: crashHistory.length,
    freeze_dispatch: true,
    generated_at: timestamp,
    isolated_components: [component],
    orphaned_run_ids: orphanedRuns.map((entry) => entry.run.id),
    stalled_run_ids: stalledFailures.map((failure) => failure.run_id),
  });
}

function evaluateSelfHealing({
  crashHistory = [],
  stalledFailures = [],
  orphanedRuns = [],
  recoveryAttempts = {},
  component = "serve",
  now = new Date(),
  policy = createFailurePolicy(),
}) {
  const timestamp = toIsoTimestamp(now, "now");
  const crashWindowFloor = Date.parse(timestamp) - policy.crashWindowMs;
  const crashesInWindow = crashHistory
    .map((entry) => Date.parse(toIsoTimestamp(entry, "crashHistory entry")))
    .filter((entryTimestamp) => entryTimestamp >= crashWindowFloor);

  const exhaustedStalls = stalledFailures.filter(
    (failure) => (recoveryAttempts[failure.run_id] ?? 0) >= policy.maxStallRecoveryAttempts,
  );
  const exhaustedOrphans = orphanedRuns.filter(
    (entry) => (recoveryAttempts[entry.run.id] ?? 0) >= policy.maxOrphanRecoveryAttempts,
  );
  const incidentRequired =
    crashesInWindow.length > policy.maxCrashRecoveryAttempts ||
    exhaustedStalls.length > 0 ||
    exhaustedOrphans.length > 0;

  if (incidentRequired) {
    const diagnosticSnapshot = createIncidentSnapshot({
      component,
      crashHistory: crashesInWindow,
      stalledFailures,
      orphanedRuns,
      generatedAt: timestamp,
    });

    return Object.freeze({
      actions: [
        {
          type: "freeze_dispatch",
          reason: "bounded self-healing budget exhausted",
        },
        {
          type: "capture_diagnostic_snapshot",
          snapshot: diagnosticSnapshot,
        },
        {
          type: "isolate_component",
          component,
        },
        {
          type: "wait_for_intervention",
          reason: "incident mode active until operator or policy-driven recovery clears the fault",
        },
      ],
      diagnostic_snapshot: diagnosticSnapshot,
      freeze_dispatch: true,
      mode: "incident",
    });
  }

  const actions = [
    ...stalledFailures.map((failure) => ({
      run_id: failure.run_id,
      task_id: failure.task_id,
      type: "recover_stalled_run",
    })),
    ...orphanedRuns.map((entry) => ({
      run_id: entry.run.id,
      task_id: entry.run.task_id,
      checkpoint_id: entry.checkpoint_id,
      type: entry.recovery_action === "resume" ? "resume_orphaned_run" : "retry_orphaned_run",
    })),
  ];

  return Object.freeze({
    actions,
    diagnostic_snapshot: null,
    freeze_dispatch: false,
    mode: actions.length > 0 ? "recovering" : "healthy",
  });
}

function createFailureReport({
  taskId,
  attempts,
  failures,
  attemptedFixes = [],
  blockers = [],
  generatedAt = new Date(),
}) {
  ensureNonEmptyString(taskId, "taskId");
  ensurePositiveInteger(attempts, "attempts");

  if (!Array.isArray(failures) || failures.length === 0) {
    throw new RuntimeFailureError("failures must be a non-empty array");
  }

  if (!Array.isArray(attemptedFixes)) {
    throw new RuntimeFailureError("attemptedFixes must be an array");
  }

  if (!Array.isArray(blockers)) {
    throw new RuntimeFailureError("blockers must be an array");
  }

  const normalizedFailures = failures.map((failure) =>
    createFailureRecord({
      ...failure,
      taskId: failure.task_id,
      runId: failure.run_id,
      detectedAt: failure.detected_at,
      failureClass: failure.failure_class,
      nextAction: failure.next_action,
      retrySafe: failure.retry_safe,
      rootCause: failure.root_cause,
      stopCondition: failure.stop_condition,
      escalationHint: failure.escalation_hint,
    }),
  );
  const terminalFailure = normalizedFailures.at(-1);

  return Object.freeze({
    attempts,
    attempted_fixes: attemptedFixes.map((fix) => {
      if (typeof fix === "string") {
        return {
          note: fix,
        };
      }

      return ensurePlainObject(fix, "attemptedFix");
    }),
    blockers,
    failures: normalizedFailures.map((failure) => ({
      category: failure.category,
      detected_at: failure.detected_at,
      failure_class: failure.failure_class,
      next_action: failure.next_action,
      root_cause: failure.root_cause,
      run_id: failure.run_id,
      summary: failure.summary,
    })),
    generated_at: toIsoTimestamp(generatedAt, "generatedAt"),
    task_id: taskId,
    terminal_action: terminalFailure.next_action,
  });
}

export {
  ACTIVE_RUN_STATUSES,
  DEFAULT_FAILURE_POLICY,
  FAILURE_CATEGORIES,
  FAILURE_CLASSES,
  FAILURE_NEXT_ACTIONS,
  FAILURE_SEVERITIES,
  RuntimeFailureError,
  createFailureArtifacts,
  createFailurePolicy,
  createFailureRecord,
  createFailureReport,
  createIncidentSnapshot,
  detectStalledRuns,
  evaluateSelfHealing,
  normalizeFailure,
  reconcileOrphanedRuns,
};
