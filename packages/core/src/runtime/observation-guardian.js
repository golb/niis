import { createPolicyObservation } from "../policy/observations.js";
import { resolvePolicy } from "../policy/resolved-policy.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";

class ObservationGuardianError extends Error {
  constructor(message) {
    super(message);
    this.name = "ObservationGuardianError";
  }
}

const DEFAULT_BACKGROUND_OBSERVER_POLICY_REF = "policy/background-observer-guardian/v1";
const BACKGROUND_OBSERVER_TASK_ID = "runtime:background-observer";
const ACTIVITY_SIGNAL_STATES = ["active", "idle"];
const ACTIVITY_SIGNAL_FAIL_MODES = ["skip_observation", "allow_without_signal"];

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ObservationGuardianError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureNullableTimestamp(value, label) {
  if (value === undefined || value === null) {
    return null;
  }

  return toIsoTimestamp(value, label);
}

function ensurePositiveInteger(value, label, fallback, { minimum = 1 } = {}) {
  const candidate = value ?? fallback;
  const normalized = Number(candidate);

  if (!Number.isInteger(normalized) || normalized < minimum) {
    throw new ObservationGuardianError(`${label} must be an integer >= ${minimum}`);
  }

  return normalized;
}

function ensureEnumValue(value, allowedValues, label, fallback = null) {
  const candidate = value ?? fallback;

  if (!allowedValues.includes(candidate)) {
    throw new ObservationGuardianError(`${label} must be one of: ${allowedValues.join(", ")}`);
  }

  return candidate;
}

function normalizeActivitySignal(signal = null) {
  if (signal === undefined || signal === null) {
    return Object.freeze({
      observed_at: null,
      state: null,
      supported: false,
    });
  }

  if (typeof signal !== "object" || Array.isArray(signal)) {
    throw new ObservationGuardianError("activitySignal must be a plain object");
  }

  const supported = signal.supported !== false;
  const rawState = signal.state ?? null;

  if (!supported) {
    return Object.freeze({
      observed_at: ensureNullableTimestamp(signal.observedAt ?? signal.observed_at ?? null, "activitySignal.observed_at"),
      state: null,
      supported: false,
    });
  }

  return Object.freeze({
    observed_at: ensureNullableTimestamp(signal.observedAt ?? signal.observed_at ?? null, "activitySignal.observed_at"),
    state:
      rawState === null
        ? null
        : ensureEnumValue(rawState, ACTIVITY_SIGNAL_STATES, "activitySignal.state"),
    supported: true,
  });
}

function isHourWithinWindow(hour, { start_hour: startHour, end_hour: endHour }) {
  if (startHour === 0 && endHour === 24) {
    return true;
  }

  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }

  return hour >= startHour || hour < endHour;
}

function createCheck(name, { allowed, reason = null, details = {} }) {
  return Object.freeze({
    allowed,
    details: Object.freeze(details),
    name,
    reason,
  });
}

function createGuardianArtifacts({
  allowed,
  checks,
  now,
  policyRef,
  projectId,
  runId,
  taskId,
}) {
  const timestamp = toIsoTimestamp(now, "guardian timestamp");
  const blockedCheck = checks.find((check) => check.allowed === false) ?? null;
  const decision = allowed ? "observe" : "skip";
  const summary = allowed
    ? `Background observer may continue for project ${projectId} after guardian checks passed.`
    : `Background observer skipped for project ${projectId} because ${blockedCheck?.reason ?? "guardian checks failed"}.`;

  return Object.freeze({
    event: parseEventLogEntry({
      actor: "background_observer_guardian",
      event_type: "POLICY_DECISION",
      id: `${runId}:background-observer-guardian:${timestamp}`,
      payload: {
        blocked_check: blockedCheck?.name ?? null,
        check_count: checks.length,
        decision,
        project_id: projectId,
      },
      run_id: runId,
      task_id: taskId,
      timestamp,
    }),
    explainability: parseExplainabilityRecord({
      alternatives_considered: allowed
        ? []
        : [{
          option: "Run background observation immediately",
          reason_rejected: blockedCheck?.reason ?? "guardian checks failed",
        }],
      decision_type: "GATE",
      evidence_refs: [],
      human_readable_summary: summary,
      id: `${runId}:background-observer-guardian:${timestamp}`,
      policy_refs: [policyRef],
      route_chosen: allowed ? "background_observer_guardian:allow" : "background_observer_guardian:skip",
      task_id: taskId,
      timestamp,
    }),
    observation_signal: createPolicyObservation({
      category: "background_observer_guard",
      confidence: allowed ? 1 : 0.8,
      payload: {
        blocked_check: blockedCheck?.name ?? null,
        check_count: checks.length,
        decision,
        project_id: projectId,
      },
      policyRefs: [policyRef],
      sourceId: `${taskId}:guardian`,
      sourceKind: "background_observer_guardian",
      summary,
    }),
  });
}

function evaluateObservationGuardian({
  activitySignal = null,
  lastObservationAt = null,
  now = new Date(),
  observerTurn = 1,
  policy = {},
  projectId,
  runId = null,
  taskId = BACKGROUND_OBSERVER_TASK_ID,
} = {}) {
  const normalizedProjectId = ensureNonEmptyString(projectId, "projectId");
  const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
  const normalizedRunId = runId === null || runId === undefined
    ? `${normalizedTaskId}:run`
    : ensureNonEmptyString(runId, "runId");
  const normalizedNow = toIsoTimestamp(now, "now");
  const resolvedPolicy = resolvePolicy({ runtimeOverrides: policy });
  const backgroundPolicy = resolvedPolicy.background_analysis;
  const activityPolicy = backgroundPolicy.activity_signal;
  const failMode = ensureEnumValue(
    activityPolicy.fail_mode,
    ACTIVITY_SIGNAL_FAIL_MODES,
    "background_analysis.activity_signal.fail_mode",
  );
  const requiredState = ensureEnumValue(
    activityPolicy.required_state,
    ACTIVITY_SIGNAL_STATES,
    "background_analysis.activity_signal.required_state",
  );
  const normalizedActivitySignal = normalizeActivitySignal(activitySignal);
  const normalizedObserverTurn = ensurePositiveInteger(
    observerTurn,
    "observerTurn",
    1,
  );
  const normalizedLastObservationAt = ensureNullableTimestamp(lastObservationAt, "lastObservationAt");
  const checks = [];
  const utcHour = new Date(normalizedNow).getUTCHours();
  const timeWindow = backgroundPolicy.time_window_utc;
  const withinWindow = isHourWithinWindow(utcHour, timeWindow);

  checks.push(createCheck("time_window", {
    allowed: withinWindow,
    details: {
      current_hour_utc: utcHour,
      end_hour: timeWindow.end_hour,
      start_hour: timeWindow.start_hour,
    },
    reason:
      withinWindow
        ? null
        : `current UTC hour ${utcHour} is outside allowed observation window ${timeWindow.start_hour}-${timeWindow.end_hour}.`,
  }));

  if (!withinWindow) {
    const artifacts = createGuardianArtifacts({
      allowed: false,
      checks,
      now: normalizedNow,
      policyRef: DEFAULT_BACKGROUND_OBSERVER_POLICY_REF,
      projectId: normalizedProjectId,
      runId: normalizedRunId,
      taskId: normalizedTaskId,
    });

    return Object.freeze({
      allowed: false,
      checks: Object.freeze(checks),
      cooldown_until: null,
      ...artifacts,
    });
  }

  let cooldownUntil = null;

  if (normalizedLastObservationAt !== null) {
    cooldownUntil = new Date(
      Date.parse(normalizedLastObservationAt) + backgroundPolicy.project_cooldown_ms,
    ).toISOString();
  }

  const cooldownActive =
    cooldownUntil !== null && Date.parse(normalizedNow) < Date.parse(cooldownUntil);

  checks.push(createCheck("project_cooldown", {
    allowed: !cooldownActive,
    details: {
      cooldown_until: cooldownUntil,
      project_cooldown_ms: backgroundPolicy.project_cooldown_ms,
    },
    reason:
      cooldownActive
        ? `project cooldown remains active until ${cooldownUntil}.`
        : null,
  }));

  if (cooldownActive) {
    const artifacts = createGuardianArtifacts({
      allowed: false,
      checks,
      now: normalizedNow,
      policyRef: DEFAULT_BACKGROUND_OBSERVER_POLICY_REF,
      projectId: normalizedProjectId,
      runId: normalizedRunId,
      taskId: normalizedTaskId,
    });

    return Object.freeze({
      allowed: false,
      checks: Object.freeze(checks),
      cooldown_until: cooldownUntil,
      ...artifacts,
    });
  }

  const turnBudgetAllowed = normalizedObserverTurn <= backgroundPolicy.observer_max_turns;

  checks.push(createCheck("observer_turn_budget", {
    allowed: turnBudgetAllowed,
    details: {
      observer_max_turns: backgroundPolicy.observer_max_turns,
      observer_turn: normalizedObserverTurn,
    },
    reason:
      turnBudgetAllowed
        ? null
        : `observer turn ${normalizedObserverTurn} exceeds configured max ${backgroundPolicy.observer_max_turns}.`,
  }));

  if (!turnBudgetAllowed) {
    const artifacts = createGuardianArtifacts({
      allowed: false,
      checks,
      now: normalizedNow,
      policyRef: DEFAULT_BACKGROUND_OBSERVER_POLICY_REF,
      projectId: normalizedProjectId,
      runId: normalizedRunId,
      taskId: normalizedTaskId,
    });

    return Object.freeze({
      allowed: false,
      checks: Object.freeze(checks),
      cooldown_until: null,
      ...artifacts,
    });
  }

  let activityAllowed = true;
  let activityReason = null;

  if (!normalizedActivitySignal.supported || normalizedActivitySignal.state === null) {
    activityAllowed = failMode === "allow_without_signal";
    activityReason = activityAllowed
      ? null
      : "activity signal is unavailable and fail mode is skip_observation.";
  } else if (normalizedActivitySignal.state !== requiredState) {
    activityAllowed = false;
    activityReason = `activity signal is ${normalizedActivitySignal.state}; required state is ${requiredState}.`;
  }

  checks.push(createCheck("activity_signal", {
    allowed: activityAllowed,
    details: {
      fail_mode: failMode,
      observed_at: normalizedActivitySignal.observed_at,
      required_state: requiredState,
      state: normalizedActivitySignal.state,
      supported: normalizedActivitySignal.supported,
    },
    reason: activityReason,
  }));

  const allowed = activityAllowed;
  const artifacts = createGuardianArtifacts({
    allowed,
    checks,
    now: normalizedNow,
    policyRef: DEFAULT_BACKGROUND_OBSERVER_POLICY_REF,
    projectId: normalizedProjectId,
    runId: normalizedRunId,
    taskId: normalizedTaskId,
  });

  return Object.freeze({
    allowed,
    checks: Object.freeze(checks),
    cooldown_until: cooldownUntil,
    ...artifacts,
  });
}

export {
  ACTIVITY_SIGNAL_FAIL_MODES,
  ACTIVITY_SIGNAL_STATES,
  BACKGROUND_OBSERVER_TASK_ID,
  DEFAULT_BACKGROUND_OBSERVER_POLICY_REF,
  ObservationGuardianError,
  evaluateObservationGuardian,
};
