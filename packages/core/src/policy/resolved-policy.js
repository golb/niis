import {
  DEFAULT_ACTIVATION_REVIEW_POLICY,
  normalizeActivationReviewPolicy,
} from "./activation-review.js";
import {
  DEFAULT_PRE_EXECUTION_GATE_POLICY,
  normalizePreExecutionGatePolicy,
} from "./gates.js";
import { DEFAULT_REDACTION_POLICY } from "./redaction.js";
import { DEFAULT_THREAT_CATALOG, createThreatCatalog } from "./threat-catalog.js";
import {
  VALIDATOR_STRICTNESS_LEVELS,
  createVerdictContinuationPolicy,
} from "../contracts/validator.js";
import {
  DEFAULT_OBSERVATION_LIFECYCLE_POLICY,
  normalizeObservationLifecyclePolicy,
} from "./observations.js";

class ResolvedPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResolvedPolicyError";
  }
}

const DEFAULT_RESOLVED_POLICY = Object.freeze({
  activation_review: DEFAULT_ACTIVATION_REVIEW_POLICY,
  background_analysis: Object.freeze({
    activity_signal: Object.freeze({
      fail_mode: "skip_observation",
      required_state: "idle",
    }),
    observer_max_turns: 3,
    project_cooldown_ms: 300000,
    time_window_utc: Object.freeze({
      end_hour: 24,
      start_hour: 0,
    }),
  }),
  fail_mode: Object.freeze({
    pre_execution_gate: "fail_closed",
    validator_lane: "fail_closed",
  }),
  observation_ingestion: Object.freeze({
    inherit_redaction_rules: true,
    lifecycle_policy: DEFAULT_OBSERVATION_LIFECYCLE_POLICY,
    publish_gate_outputs: true,
  }),
  permissions: Object.freeze({
    approvals_required_for: Object.freeze(["danger.full_access", "network.access", "workspace.write"]),
  }),
  pre_execution_gate: DEFAULT_PRE_EXECUTION_GATE_POLICY,
  redaction: DEFAULT_REDACTION_POLICY,
  resource_limits: Object.freeze({
    adapter_timeout_ms: 300000,
    extension_timeout_ms: 30000,
    hook_timeout_ms: 30000,
    payload_stdin_bytes: 1048576,
    secret_resolution_rate_limit: Object.freeze({
      max_calls: 30,
      window_ms: 60000,
    }),
    validator_timeout_ms: 15000,
  }),
  secret_handling: Object.freeze({
    plaintext_persistence: "reject",
    query_exports_redacted: true,
  }),
  session_compaction: Object.freeze({
    max_raw_input_tokens: 50000,
    max_session_age_hours: 8,
    max_session_runs: 20,
  }),
  threat_catalog: DEFAULT_THREAT_CATALOG,
  tool_access: Object.freeze({
    deny_operations: Object.freeze(["danger.full_access"]),
    deny_sensitive_path_classes: Object.freeze(["home"]),
    deny_tool_families: Object.freeze(["destructive"]),
  }),
  validator_lane: Object.freeze({
    continuation_by_verdict: createVerdictContinuationPolicy(),
    default_validator_ids: Object.freeze([
      "evidence_authenticity",
      "security_scan",
      "llm_review",
      "completion_proof",
    ]),
    short_retry_delay_ms: 1000,
    strictness: "strict",
  }),
});

const DEFAULT_VALIDATOR_IDS_BY_STRICTNESS = Object.freeze({
  strict: Object.freeze([
    "evidence_authenticity",
    "security_scan",
    "llm_review",
    "completion_proof",
  ]),
  standard: Object.freeze(["evidence_authenticity", "completion_proof"]),
  minimal: Object.freeze(["completion_proof"]),
});

function ensurePlainObject(value, label) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ResolvedPolicyError(`${label} must be a plain object`);
  }

  return value;
}

function ensureString(value, label, fallback) {
  const candidate = value ?? fallback;

  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new ResolvedPolicyError(`${label} must be a non-empty string`);
  }

  return candidate.trim();
}

function ensureStringArray(values, label, fallback = []) {
  const candidate = values ?? fallback;

  if (!Array.isArray(candidate)) {
    throw new ResolvedPolicyError(`${label} must be an array`);
  }

  return Object.freeze(candidate.map((value, index) => ensureString(value, `${label}[${index}]`)));
}

function ensureFiniteNumber(value, label, fallback) {
  const candidate = value ?? fallback;
  const normalized = Number(candidate);

  if (!Number.isFinite(normalized)) {
    throw new ResolvedPolicyError(`${label} must be a finite number`);
  }

  return normalized;
}

function ensureIntegerRange(value, label, fallback, { minimum, maximum }) {
  const normalized = ensureFiniteNumber(value, label, fallback);

  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new ResolvedPolicyError(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return normalized;
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }

  if (
    base
    && typeof base === "object"
    && override
    && typeof override === "object"
    && !Array.isArray(base)
    && !Array.isArray(override)
  ) {
    const merged = { ...base };

    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in base ? deepMerge(base[key], value) : value;
    }

    return merged;
  }

  return override === undefined ? base : override;
}

function selectDefaultValidatorIdsForStrictness(strictness) {
  return DEFAULT_VALIDATOR_IDS_BY_STRICTNESS[strictness]
    ?? DEFAULT_VALIDATOR_IDS_BY_STRICTNESS.strict;
}

function pickExplicitDefaultValidatorIds(...sources) {
  for (const source of sources) {
    const candidate = source?.validator_lane?.default_validator_ids;

    if (candidate !== undefined) {
      return candidate;
    }
  }

  return undefined;
}

function resolvePolicy({
  basePolicy = {},
  projectProfile = {},
  workflowPolicy = {},
  runtimeOverrides = {},
} = {}) {
  const normalizedBasePolicy = ensurePlainObject(basePolicy, "basePolicy");
  const normalizedProjectProfile = ensurePlainObject(projectProfile, "projectProfile");
  const normalizedWorkflowPolicy = ensurePlainObject(workflowPolicy, "workflowPolicy");
  const normalizedRuntimeOverrides = ensurePlainObject(runtimeOverrides, "runtimeOverrides");
  const explicitDefaultValidatorIds = pickExplicitDefaultValidatorIds(
    normalizedRuntimeOverrides,
    normalizedWorkflowPolicy,
    normalizedProjectProfile,
    normalizedBasePolicy,
  );
  const merged = deepMerge(
    DEFAULT_RESOLVED_POLICY,
    deepMerge(
      normalizedBasePolicy,
      deepMerge(
        normalizedProjectProfile,
        deepMerge(
          normalizedWorkflowPolicy,
          normalizedRuntimeOverrides,
        ),
      ),
    ),
  );
  const strictness = ensureString(
    merged.validator_lane?.strictness,
    "validator_lane.strictness",
    DEFAULT_RESOLVED_POLICY.validator_lane.strictness,
  );

  if (!VALIDATOR_STRICTNESS_LEVELS.includes(strictness)) {
    throw new ResolvedPolicyError(
      `unsupported validator strictness ${strictness}; expected one of ${VALIDATOR_STRICTNESS_LEVELS.join(", ")}`,
    );
  }

  return Object.freeze({
    activation_review: normalizeActivationReviewPolicy(merged.activation_review),
    background_analysis: Object.freeze({
      activity_signal: Object.freeze({
        fail_mode: ensureString(
          merged.background_analysis?.activity_signal?.fail_mode
            ?? merged.background_analysis?.activity_signal?.failMode,
          "background_analysis.activity_signal.fail_mode",
          DEFAULT_RESOLVED_POLICY.background_analysis.activity_signal.fail_mode,
        ),
        required_state: ensureString(
          merged.background_analysis?.activity_signal?.required_state
            ?? merged.background_analysis?.activity_signal?.requiredState,
          "background_analysis.activity_signal.required_state",
          DEFAULT_RESOLVED_POLICY.background_analysis.activity_signal.required_state,
        ),
      }),
      observer_max_turns: ensureFiniteNumber(
        merged.background_analysis?.observer_max_turns
          ?? DEFAULT_RESOLVED_POLICY.background_analysis.observer_max_turns,
        "background_analysis.observer_max_turns",
        DEFAULT_RESOLVED_POLICY.background_analysis.observer_max_turns,
      ),
      project_cooldown_ms: ensureFiniteNumber(
        merged.background_analysis?.project_cooldown_ms
          ?? DEFAULT_RESOLVED_POLICY.background_analysis.project_cooldown_ms,
        "background_analysis.project_cooldown_ms",
        DEFAULT_RESOLVED_POLICY.background_analysis.project_cooldown_ms,
      ),
      time_window_utc: Object.freeze({
        end_hour: ensureIntegerRange(
          merged.background_analysis?.time_window_utc?.end_hour
            ?? merged.background_analysis?.time_window_utc?.endHour,
          "background_analysis.time_window_utc.end_hour",
          DEFAULT_RESOLVED_POLICY.background_analysis.time_window_utc.end_hour,
          { minimum: 1, maximum: 24 },
        ),
        start_hour: ensureIntegerRange(
          merged.background_analysis?.time_window_utc?.start_hour
            ?? merged.background_analysis?.time_window_utc?.startHour,
          "background_analysis.time_window_utc.start_hour",
          DEFAULT_RESOLVED_POLICY.background_analysis.time_window_utc.start_hour,
          { minimum: 0, maximum: 23 },
        ),
      }),
    }),
    fail_mode: Object.freeze({
      pre_execution_gate: ensureString(
        merged.fail_mode?.pre_execution_gate,
        "fail_mode.pre_execution_gate",
        DEFAULT_RESOLVED_POLICY.fail_mode.pre_execution_gate,
      ),
      validator_lane: ensureString(
        merged.fail_mode?.validator_lane,
        "fail_mode.validator_lane",
        DEFAULT_RESOLVED_POLICY.fail_mode.validator_lane,
      ),
    }),
    observation_ingestion: Object.freeze({
      inherit_redaction_rules:
        merged.observation_ingestion?.inherit_redaction_rules !== false,
      lifecycle_policy: normalizeObservationLifecyclePolicy(
        merged.observation_ingestion?.lifecycle_policy
        ?? merged.observation_ingestion?.lifecyclePolicy
        ?? DEFAULT_OBSERVATION_LIFECYCLE_POLICY,
      ),
      publish_gate_outputs: merged.observation_ingestion?.publish_gate_outputs !== false,
    }),
    permissions: Object.freeze({
      approvals_required_for: ensureStringArray(
        merged.permissions?.approvals_required_for,
        "permissions.approvals_required_for",
        DEFAULT_RESOLVED_POLICY.permissions.approvals_required_for,
      ),
    }),
    pre_execution_gate: normalizePreExecutionGatePolicy(merged.pre_execution_gate),
    redaction: Object.freeze({
      jwt: merged.redaction?.jwt !== false,
      operator_pii: merged.redaction?.operator_pii !== false,
      secret_assignments: merged.redaction?.secret_assignments !== false,
    }),
    resource_limits: Object.freeze({
      adapter_timeout_ms: Number(
        merged.resource_limits?.adapter_timeout_ms
          ?? DEFAULT_RESOLVED_POLICY.resource_limits.adapter_timeout_ms,
      ),
      extension_timeout_ms: Number(
        merged.resource_limits?.extension_timeout_ms
          ?? DEFAULT_RESOLVED_POLICY.resource_limits.extension_timeout_ms,
      ),
      hook_timeout_ms: Number(
        merged.resource_limits?.hook_timeout_ms
          ?? DEFAULT_RESOLVED_POLICY.resource_limits.hook_timeout_ms,
      ),
      payload_stdin_bytes: Number(
        merged.resource_limits?.payload_stdin_bytes
          ?? DEFAULT_RESOLVED_POLICY.resource_limits.payload_stdin_bytes,
      ),
      secret_resolution_rate_limit: Object.freeze({
        max_calls: Number(
          merged.resource_limits?.secret_resolution_rate_limit?.max_calls
            ?? DEFAULT_RESOLVED_POLICY.resource_limits.secret_resolution_rate_limit.max_calls,
        ),
        window_ms: Number(
          merged.resource_limits?.secret_resolution_rate_limit?.window_ms
            ?? DEFAULT_RESOLVED_POLICY.resource_limits.secret_resolution_rate_limit.window_ms,
        ),
      }),
      validator_timeout_ms: Number(
        merged.resource_limits?.validator_timeout_ms
          ?? DEFAULT_RESOLVED_POLICY.resource_limits.validator_timeout_ms,
      ),
    }),
    secret_handling: Object.freeze({
      plaintext_persistence: ensureString(
        merged.secret_handling?.plaintext_persistence,
        "secret_handling.plaintext_persistence",
        DEFAULT_RESOLVED_POLICY.secret_handling.plaintext_persistence,
      ),
      query_exports_redacted: merged.secret_handling?.query_exports_redacted !== false,
    }),
    session_compaction: Object.freeze({
      max_raw_input_tokens: Number(
        merged.session_compaction?.max_raw_input_tokens
          ?? DEFAULT_RESOLVED_POLICY.session_compaction.max_raw_input_tokens,
      ),
      max_session_age_hours: Number(
        merged.session_compaction?.max_session_age_hours
          ?? DEFAULT_RESOLVED_POLICY.session_compaction.max_session_age_hours,
      ),
      max_session_runs: Number(
        merged.session_compaction?.max_session_runs
          ?? DEFAULT_RESOLVED_POLICY.session_compaction.max_session_runs,
      ),
    }),
    threat_catalog: createThreatCatalog(merged.threat_catalog),
    tool_access: Object.freeze({
      deny_operations: ensureStringArray(
        merged.tool_access?.deny_operations,
        "tool_access.deny_operations",
        DEFAULT_RESOLVED_POLICY.tool_access.deny_operations,
      ),
      deny_sensitive_path_classes: ensureStringArray(
        merged.tool_access?.deny_sensitive_path_classes,
        "tool_access.deny_sensitive_path_classes",
        DEFAULT_RESOLVED_POLICY.tool_access.deny_sensitive_path_classes,
      ),
      deny_tool_families: ensureStringArray(
        merged.tool_access?.deny_tool_families,
        "tool_access.deny_tool_families",
        DEFAULT_RESOLVED_POLICY.tool_access.deny_tool_families,
      ),
    }),
    validator_lane: Object.freeze({
      continuation_by_verdict: createVerdictContinuationPolicy(
        merged.validator_lane?.continuation_by_verdict,
      ),
      default_validator_ids: ensureStringArray(
        explicitDefaultValidatorIds,
        "validator_lane.default_validator_ids",
        selectDefaultValidatorIdsForStrictness(strictness),
      ),
      short_retry_delay_ms: Number(
        merged.validator_lane?.short_retry_delay_ms
          ?? DEFAULT_RESOLVED_POLICY.validator_lane.short_retry_delay_ms,
      ),
      strictness,
    }),
  });
}

export {
  DEFAULT_VALIDATOR_IDS_BY_STRICTNESS,
  DEFAULT_RESOLVED_POLICY,
  ResolvedPolicyError,
  resolvePolicy,
  selectDefaultValidatorIdsForStrictness,
};
