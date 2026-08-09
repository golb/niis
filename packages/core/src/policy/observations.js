import { redactValue, DEFAULT_REDACTION_POLICY } from "./redaction.js";

class PolicyObservationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyObservationError";
  }
}

const DEFAULT_OBSERVATION_LIFECYCLE_POLICY = Object.freeze({
  archive_after_days: 7,
  policy_id: "policy/observation-lifecycle/v1",
  purge_after_days: 30,
  retain_unprocessed: true,
});
const OBSERVATION_PATTERN_CATEGORIES = Object.freeze([
  "operator_override",
  "blocker_resolution",
  "workflow_pattern",
  "task_decomposition",
  "routing_preference",
  "evidence_pattern",
  "policy_guardrail",
]);
const DEFAULT_PATTERN_CATEGORY_BY_OBSERVATION_CATEGORY = Object.freeze({
  background_observer_guard: "policy_guardrail",
  pre_execution_gate: "blocker_resolution",
  pre_execution_gate_failure: "policy_guardrail",
  route_asset_health: "routing_preference",
  route_selection: "routing_preference",
  route_watch_status: "routing_preference",
  security_scan: "evidence_pattern",
  security_scan_summary: "evidence_pattern",
  task_decomposition: "task_decomposition",
  validator_result: "workflow_pattern",
});
const DEFAULT_PATTERN_CATEGORY_BY_SOURCE_KIND = Object.freeze({
  background_observer_guardian: "policy_guardrail",
  pre_execution_gate: "blocker_resolution",
  pre_execution_gate_failure: "policy_guardrail",
  route_selection: "routing_preference",
  route_watch_status: "routing_preference",
  security_scan: "evidence_pattern",
  security_scan_finding: "evidence_pattern",
  security_scan_summary: "evidence_pattern",
  validator_result: "workflow_pattern",
});

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PolicyObservationError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new PolicyObservationError(`${label} must be an array`);
  }

  return [...new Set(values.map((value, index) =>
    ensureNonEmptyString(value, `${label}[${index}]`)))];
}

function ensurePositiveInteger(value, label, fallback) {
  const candidate = value ?? fallback;

  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw new PolicyObservationError(`${label} must be a positive integer`);
  }

  return candidate;
}

function ensureEnumValue(value, allowedValues, label) {
  if (!allowedValues.includes(value)) {
    throw new PolicyObservationError(`${label} must be one of: ${allowedValues.join(", ")}`);
  }

  return value;
}

function normalizeObservationLifecyclePolicy(policy = {}) {
  if (policy === undefined || policy === null) {
    return DEFAULT_OBSERVATION_LIFECYCLE_POLICY;
  }

  if (typeof policy !== "object" || Array.isArray(policy)) {
    throw new PolicyObservationError("observation lifecycle policy must be a plain object");
  }

  return Object.freeze({
    archive_after_days: ensurePositiveInteger(
      policy.archive_after_days ?? policy.archiveAfterDays,
      "observationLifecyclePolicy.archive_after_days",
      DEFAULT_OBSERVATION_LIFECYCLE_POLICY.archive_after_days,
    ),
    policy_id: ensureNonEmptyString(
      policy.policy_id ?? policy.policyId ?? DEFAULT_OBSERVATION_LIFECYCLE_POLICY.policy_id,
      "observationLifecyclePolicy.policy_id",
    ),
    purge_after_days: ensurePositiveInteger(
      policy.purge_after_days ?? policy.purgeAfterDays,
      "observationLifecyclePolicy.purge_after_days",
      DEFAULT_OBSERVATION_LIFECYCLE_POLICY.purge_after_days,
    ),
    retain_unprocessed:
      policy.retain_unprocessed ?? policy.retainUnprocessed ?? DEFAULT_OBSERVATION_LIFECYCLE_POLICY.retain_unprocessed,
  });
}

function deriveObservationPatternCategory({
  category,
  patternCategory = null,
  sourceKind,
}) {
  if (patternCategory !== null && patternCategory !== undefined) {
    return ensureEnumValue(
      patternCategory,
      OBSERVATION_PATTERN_CATEGORIES,
      "observation.pattern_category",
    );
  }

  return (
    DEFAULT_PATTERN_CATEGORY_BY_OBSERVATION_CATEGORY[category]
    ?? DEFAULT_PATTERN_CATEGORY_BY_SOURCE_KIND[sourceKind]
    ?? "workflow_pattern"
  );
}

function createPolicyObservation({
  category,
  confidence = 0,
  pattern_category: patternCategorySnakeCase = null,
  patternCategory = null,
  payload = {},
  policyRefs = [],
  redactionPolicy = DEFAULT_REDACTION_POLICY,
  sourceId,
  sourceKind,
  summary,
}) {
  const normalizedCategory = ensureNonEmptyString(category, "observation.category");
  const normalizedSourceKind = ensureNonEmptyString(sourceKind, "observation.sourceKind");

  return Object.freeze({
    category: normalizedCategory,
    confidence: typeof confidence === "number" ? confidence : 0,
    payload: redactValue(payload, redactionPolicy),
    pattern_category: deriveObservationPatternCategory({
      category: normalizedCategory,
      patternCategory: patternCategory ?? patternCategorySnakeCase,
      sourceKind: normalizedSourceKind,
    }),
    policy_refs: Object.freeze(ensureStringArray(policyRefs, "observation.policyRefs")),
    source_id: ensureNonEmptyString(sourceId, "observation.sourceId"),
    source_kind: normalizedSourceKind,
    summary: ensureNonEmptyString(summary, "observation.summary"),
  });
}

function normalizeObservationSignals({
  redactionPolicy = DEFAULT_REDACTION_POLICY,
  signals = [],
  sourceId,
  sourceKind,
  defaultPolicyRefs = [],
}) {
  if (!Array.isArray(signals)) {
    throw new PolicyObservationError("signals must be an array");
  }

  return Object.freeze(signals.map((signal, index) =>
    createPolicyObservation({
      category: signal.category ?? "policy_signal",
      confidence: signal.confidence ?? 0,
      patternCategory: signal.pattern_category ?? signal.patternCategory ?? null,
      payload: signal.payload ?? {},
      policyRefs: signal.policy_refs ?? signal.policyRefs ?? defaultPolicyRefs,
      redactionPolicy,
      sourceId: signal.source_id ?? signal.sourceId ?? `${sourceId}:${index + 1}`,
      sourceKind: signal.source_kind ?? signal.sourceKind ?? sourceKind,
      summary: signal.summary ?? `policy signal ${index + 1}`,
    })));
}

export {
  DEFAULT_OBSERVATION_LIFECYCLE_POLICY,
  OBSERVATION_PATTERN_CATEGORIES,
  PolicyObservationError,
  createPolicyObservation,
  deriveObservationPatternCategory,
  normalizeObservationLifecyclePolicy,
  normalizeObservationSignals,
};
