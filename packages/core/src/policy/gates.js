import { parseBlockerArtifact } from "../schemas/blocker.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import { createApprovalBlocker } from "../state/authority.js";
import { createPolicyObservation } from "./observations.js";
import { DEFAULT_REDACTION_POLICY } from "./redaction.js";

class PolicyGateError extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyGateError";
  }
}

const DEFAULT_PRE_EXECUTION_GATE_POLICY = Object.freeze({
  allow_operations: [],
  allow_sensitive_path_classes: [],
  allow_tool_families: [],
  blocked_anomaly_signals: ["path_escape", "prompt_injection", "tool_poisoning"],
  deny_operations: ["danger.full_access"],
  deny_sensitive_path_classes: ["home"],
  deny_tool_families: ["destructive"],
  fail_mode: "fail_closed",
  required_permissions: Object.freeze({
    "workspace.write": ["workspace.write"],
    "network.access": ["network.access"],
  }),
});

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PolicyGateError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new PolicyGateError(`${label} must be an array`);
  }

  return values.map((value, index) => ensureNonEmptyString(value, `${label}[${index}]`));
}

function normalizePreExecutionGatePolicy(policy = {}) {
  const normalizedPolicy = policy && typeof policy === "object" && !Array.isArray(policy)
    ? policy
    : {};
  const failMode = normalizedPolicy.fail_mode ?? normalizedPolicy.failMode
    ?? DEFAULT_PRE_EXECUTION_GATE_POLICY.fail_mode;

  if (!["fail_open", "fail_closed"].includes(failMode)) {
    throw new PolicyGateError(`unsupported pre-execution fail mode: ${failMode}`);
  }

  return Object.freeze({
    allow_operations: Object.freeze(
      ensureStringArray(
        normalizedPolicy.allow_operations ?? normalizedPolicy.allowOperations
          ?? DEFAULT_PRE_EXECUTION_GATE_POLICY.allow_operations,
        "pre_execution_gate.allow_operations",
      ),
    ),
    allow_sensitive_path_classes: Object.freeze(
      ensureStringArray(
        normalizedPolicy.allow_sensitive_path_classes
          ?? normalizedPolicy.allowSensitivePathClasses
          ?? DEFAULT_PRE_EXECUTION_GATE_POLICY.allow_sensitive_path_classes,
        "pre_execution_gate.allow_sensitive_path_classes",
      ),
    ),
    allow_tool_families: Object.freeze(
      ensureStringArray(
        normalizedPolicy.allow_tool_families ?? normalizedPolicy.allowToolFamilies
          ?? DEFAULT_PRE_EXECUTION_GATE_POLICY.allow_tool_families,
        "pre_execution_gate.allow_tool_families",
      ),
    ),
    blocked_anomaly_signals: Object.freeze(
      ensureStringArray(
        normalizedPolicy.blocked_anomaly_signals ?? normalizedPolicy.blockedAnomalySignals
          ?? DEFAULT_PRE_EXECUTION_GATE_POLICY.blocked_anomaly_signals,
        "pre_execution_gate.blocked_anomaly_signals",
      ),
    ),
    deny_operations: Object.freeze(
      ensureStringArray(
        normalizedPolicy.deny_operations ?? normalizedPolicy.denyOperations
          ?? DEFAULT_PRE_EXECUTION_GATE_POLICY.deny_operations,
        "pre_execution_gate.deny_operations",
      ),
    ),
    deny_sensitive_path_classes: Object.freeze(
      ensureStringArray(
        normalizedPolicy.deny_sensitive_path_classes
          ?? normalizedPolicy.denySensitivePathClasses
          ?? DEFAULT_PRE_EXECUTION_GATE_POLICY.deny_sensitive_path_classes,
        "pre_execution_gate.deny_sensitive_path_classes",
      ),
    ),
    deny_tool_families: Object.freeze(
      ensureStringArray(
        normalizedPolicy.deny_tool_families ?? normalizedPolicy.denyToolFamilies
          ?? DEFAULT_PRE_EXECUTION_GATE_POLICY.deny_tool_families,
        "pre_execution_gate.deny_tool_families",
      ),
    ),
    fail_mode: failMode,
    required_permissions: Object.freeze(
      Object.fromEntries(
        Object.entries(
          normalizedPolicy.required_permissions ?? normalizedPolicy.requiredPermissions
            ?? DEFAULT_PRE_EXECUTION_GATE_POLICY.required_permissions,
        ).map(([operation, permissions]) => [
          ensureNonEmptyString(operation, "pre_execution_gate.required_permissions operation"),
          Object.freeze(
            ensureStringArray(
              permissions,
              `pre_execution_gate.required_permissions.${operation}`,
            ),
          ),
        ]),
      ),
    ),
  });
}

function createGateDecisionArtifacts({
  taskId,
  runId,
  policyRefs = [],
  reason,
  decision = "allowed",
  now = new Date(),
}) {
  const timestamp = toIsoTimestamp(now, "gate decision timestamp");

  return {
    event: parseEventLogEntry({
      actor: "policy",
      event_type: "POLICY_DECISION",
      id: `${runId}:pre-execution-gate:${timestamp}`,
      payload: {
        decision,
        reason,
      },
      run_id: runId,
      task_id: taskId,
      timestamp,
    }),
    explainability: parseExplainabilityRecord({
      alternatives_considered: [],
      decision_type: "GATE",
      evidence_refs: [],
      human_readable_summary: reason,
      id: `${runId}:pre-execution-gate:${timestamp}`,
      policy_refs: policyRefs,
      route_chosen: "pre_execution_gate",
      task_id: taskId,
      timestamp,
    }),
  };
}

function createSecurityBlocker({ taskId, reason, now = new Date() }) {
  const timestamp = toIsoTimestamp(now, "security blocker timestamp");

  return parseBlockerArtifact({
    blocker_class: "SECURITY_FINDING",
    created_at: timestamp,
    id: `${taskId}:security-blocker:${Date.parse(timestamp)}`,
    next_action: "Adjust policy, route, or execution request before retrying the tool call.",
    reason,
    task_id: taskId,
  });
}

function createEnvironmentBlocker({ taskId, reason, now = new Date() }) {
  const timestamp = toIsoTimestamp(now, "environment blocker timestamp");

  return parseBlockerArtifact({
    blocker_class: "ENV_BLOCK",
    created_at: timestamp,
    id: `${taskId}:env-block:${Date.parse(timestamp)}`,
    next_action: "Repair the execution environment or select a compatible sandbox before retrying.",
    reason,
    task_id: taskId,
  });
}

function evaluatePolicyConstraints({
  anomalySignals = [],
  grantedPermissions = [],
  operation,
  policy,
  sandboxLevel,
  sensitivePathClass = null,
  toolFamily = null,
}) {
  const normalizedOperation = ensureNonEmptyString(operation, "operation");
  const normalizedPolicy = normalizePreExecutionGatePolicy(policy);
  const normalizedGrantedPermissions = ensureStringArray(
    grantedPermissions,
    "grantedPermissions",
  );
  const normalizedAnomalySignals = ensureStringArray(anomalySignals, "anomalySignals");

  if (normalizedPolicy.deny_operations.includes(normalizedOperation)) {
    return {
      allowed: false,
      blocker_type: "security",
      reason: `operation ${normalizedOperation} is denied by pre-execution policy`,
    };
  }

  if (
    normalizedPolicy.allow_operations.length > 0
    && !normalizedPolicy.allow_operations.includes(normalizedOperation)
  ) {
    return {
      allowed: false,
      blocker_type: "security",
      reason: `operation ${normalizedOperation} is outside the pre-execution allowlist`,
    };
  }

  if (toolFamily && normalizedPolicy.deny_tool_families.includes(toolFamily)) {
    return {
      allowed: false,
      blocker_type: "security",
      reason: `tool family ${toolFamily} is denied by pre-execution policy`,
    };
  }

  if (
    toolFamily
    && normalizedPolicy.allow_tool_families.length > 0
    && !normalizedPolicy.allow_tool_families.includes(toolFamily)
  ) {
    return {
      allowed: false,
      blocker_type: "security",
      reason: `tool family ${toolFamily} is outside the pre-execution allowlist`,
    };
  }

  if (
    sensitivePathClass
    && normalizedPolicy.deny_sensitive_path_classes.includes(sensitivePathClass)
  ) {
    return {
      allowed: false,
      blocker_type: "security",
      reason: `sensitive path class ${sensitivePathClass} is denied by pre-execution policy`,
    };
  }

  if (
    sensitivePathClass
    && normalizedPolicy.allow_sensitive_path_classes.length > 0
    && !normalizedPolicy.allow_sensitive_path_classes.includes(sensitivePathClass)
  ) {
    return {
      allowed: false,
      blocker_type: "security",
      reason: `sensitive path class ${sensitivePathClass} is outside the pre-execution allowlist`,
    };
  }

  if (sandboxLevel === "danger-full-access") {
    return {
      allowed: false,
      blocker_type: "environment",
      reason: "danger-full-access requires an explicit later approval path and is blocked at pre-execution gate time",
    };
  }

  const requiredPermissions = normalizedPolicy.required_permissions[normalizedOperation] ?? [];

  if (requiredPermissions.some((permission) => !normalizedGrantedPermissions.includes(permission))) {
    return {
      allowed: false,
      blocker_type: "approval",
      reason: `operation ${normalizedOperation} is missing required permissions: ${requiredPermissions.join(", ")}`,
    };
  }

  const blockedSignal = normalizedAnomalySignals.find((signal) =>
    normalizedPolicy.blocked_anomaly_signals.includes(signal));

  if (blockedSignal) {
    return {
      allowed: false,
      blocker_type: "security",
      reason: `anomaly signal ${blockedSignal} triggered a pre-execution block`,
    };
  }

  return {
    allowed: true,
    blocker_type: null,
    reason: `pre-execution gate allows ${normalizedOperation}`,
  };
}

function evaluatePreExecutionGate({
  anomalySignals = [],
  grantedPermissions = [],
  now = new Date(),
  operation,
  policy = {},
  runId,
  sandboxLevel = "workspace-write",
  sensitivePathClass = null,
  taskId,
  toolFamily = null,
}) {
  const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
  const normalizedRunId = ensureNonEmptyString(runId, "runId");
  const rawPolicy = policy?.pre_execution_gate ?? policy;
  const requestedFailMode = rawPolicy?.fail_mode ?? rawPolicy?.failMode ?? "fail_closed";

  try {
    const normalizedPolicy = normalizePreExecutionGatePolicy(rawPolicy);
    const decision = evaluatePolicyConstraints({
      anomalySignals,
      grantedPermissions,
      operation,
      policy: normalizedPolicy,
      sandboxLevel,
      sensitivePathClass,
      toolFamily,
    });
    const artifacts = createGateDecisionArtifacts({
      decision: decision.allowed ? "allowed" : "blocked",
      now,
      policyRefs: ["policy/pre_execution_gate/v1"],
      reason: decision.reason,
      runId: normalizedRunId,
      taskId: normalizedTaskId,
    });

    if (decision.allowed) {
      return {
        allowed: true,
        blocker: null,
        event: artifacts.event,
        explainability: artifacts.explainability,
        observation_signal: createPolicyObservation({
          category: "pre_execution_gate",
          confidence: 1,
          payload: {
            decision: "allowed",
            operation,
          },
          policyRefs: ["policy/pre_execution_gate/v1"],
          redactionPolicy: DEFAULT_REDACTION_POLICY,
          sourceId: artifacts.event.id,
          sourceKind: "pre_execution_gate",
          summary: decision.reason,
        }),
      };
    }

    const blocker = decision.blocker_type === "approval"
      ? parseBlockerArtifact({
        ...createApprovalBlocker(decision.reason),
        created_at: toIsoTimestamp(now, "approval blocker timestamp"),
        id: `${normalizedTaskId}:approval-blocker:${Date.parse(now)}`,
        task_id: normalizedTaskId,
      })
      : decision.blocker_type === "environment"
        ? createEnvironmentBlocker({
          now,
          reason: decision.reason,
          taskId: normalizedTaskId,
        })
        : createSecurityBlocker({
          now,
          reason: decision.reason,
          taskId: normalizedTaskId,
        });

    return {
      allowed: false,
      blocker,
      event: artifacts.event,
      explainability: artifacts.explainability,
      observation_signal: createPolicyObservation({
        category: "pre_execution_gate",
        confidence: 1,
        payload: {
          blocker_class: blocker.blocker_class,
          decision: "blocked",
          operation,
        },
        policyRefs: ["policy/pre_execution_gate/v1"],
        redactionPolicy: DEFAULT_REDACTION_POLICY,
        sourceId: artifacts.event.id,
        sourceKind: "pre_execution_gate",
        summary: decision.reason,
      }),
    };
  } catch (error) {
    if (requestedFailMode === "fail_open") {
      const artifacts = createGateDecisionArtifacts({
        decision: "failed-open",
        now,
        policyRefs: ["policy/pre_execution_gate/v1", "policy/fail_open/v1"],
        reason: `pre-execution gate failed open: ${error.message}`,
        runId: normalizedRunId,
        taskId: normalizedTaskId,
      });

      return {
        allowed: true,
        blocker: null,
        event: artifacts.event,
        explainability: artifacts.explainability,
        observation_signal: createPolicyObservation({
          category: "pre_execution_gate_failure",
          confidence: 0.5,
          payload: {
            fail_mode: "fail_open",
            operation,
          },
          policyRefs: ["policy/pre_execution_gate/v1", "policy/fail_open/v1"],
          redactionPolicy: DEFAULT_REDACTION_POLICY,
          sourceId: artifacts.event.id,
          sourceKind: "pre_execution_gate_failure",
          summary: error.message,
        }),
      };
    }

    const artifacts = createGateDecisionArtifacts({
      decision: "failed-closed",
      now,
      policyRefs: ["policy/pre_execution_gate/v1", "policy/fail_closed/v1"],
      reason: `pre-execution gate failed closed: ${error.message}`,
      runId: normalizedRunId,
      taskId: normalizedTaskId,
    });

    return {
      allowed: false,
      blocker: createSecurityBlocker({
        now,
        reason: `pre-execution gate failed closed: ${error.message}`,
        taskId: normalizedTaskId,
      }),
      event: artifacts.event,
      explainability: artifacts.explainability,
      observation_signal: createPolicyObservation({
        category: "pre_execution_gate_failure",
        confidence: 1,
        payload: {
          fail_mode: "fail_closed",
          operation,
        },
        policyRefs: ["policy/pre_execution_gate/v1", "policy/fail_closed/v1"],
        redactionPolicy: DEFAULT_REDACTION_POLICY,
        sourceId: artifacts.event.id,
        sourceKind: "pre_execution_gate_failure",
        summary: error.message,
      }),
    };
  }
}

export {
  DEFAULT_PRE_EXECUTION_GATE_POLICY,
  PolicyGateError,
  evaluatePreExecutionGate,
  normalizePreExecutionGatePolicy,
};
