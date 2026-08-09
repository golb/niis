class ScopeGovernanceError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScopeGovernanceError";
  }
}

const DEFAULT_SCOPE_GOVERNANCE_POLICY = Object.freeze({
  default_bug_disposition: "evidence_only",
  exception_requires: Object.freeze([
    "decision_log_ref",
    "operator_approval",
    "proof_justification",
  ]),
  unrelated_bugfix_disposition: "backlog_input",
});

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ScopeGovernanceError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ScopeGovernanceError(`${label} must be a plain object`);
  }

  return value;
}

function ensureStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new ScopeGovernanceError(`${label} must be an array`);
  }

  return [...new Set(values.map((value, index) =>
    ensureNonEmptyString(value, `${label}[${index}]`)))];
}

function normalizeScopeGovernancePolicy(policy = {}) {
  const normalizedPolicy = ensurePlainObject(policy, "scopeGovernancePolicy");

  return Object.freeze({
    default_bug_disposition: ensureNonEmptyString(
      normalizedPolicy.default_bug_disposition
        ?? DEFAULT_SCOPE_GOVERNANCE_POLICY.default_bug_disposition,
      "default_bug_disposition",
    ),
    exception_requires: Object.freeze(
      ensureStringArray(
        normalizedPolicy.exception_requires
          ?? DEFAULT_SCOPE_GOVERNANCE_POLICY.exception_requires,
        "exception_requires",
      ),
    ),
    unrelated_bugfix_disposition: ensureNonEmptyString(
      normalizedPolicy.unrelated_bugfix_disposition
        ?? DEFAULT_SCOPE_GOVERNANCE_POLICY.unrelated_bugfix_disposition,
      "unrelated_bugfix_disposition",
    ),
  });
}

function evaluateScopeBoundary({
  candidate = {},
  policy = {},
}) {
  const normalizedCandidate = ensurePlainObject(candidate, "candidate");
  const normalizedPolicy = normalizeScopeGovernancePolicy(policy);

  if (!normalizedCandidate.host_bug) {
    return {
      allowed: true,
      disposition: "in_scope",
      reason: "Candidate is not classified as host-product bugfix drift.",
    };
  }

  if (!normalizedCandidate.proof_required) {
    return {
      allowed: false,
      disposition: normalizedPolicy.unrelated_bugfix_disposition,
      reason:
        "Discovered host-product bug remains evidence/backlog input and does not enter the current phase scope automatically.",
    };
  }

  const hasDecisionLogRef = Boolean(normalizedCandidate.decision_log_ref);
  const hasOperatorApproval = Boolean(normalizedCandidate.operator_approved_exception);
  const hasProofJustification = Boolean(normalizedCandidate.proof_justification);

  if (hasDecisionLogRef && hasOperatorApproval && hasProofJustification) {
    return {
      allowed: true,
      disposition: "proof_exception",
      reason:
        "Host bugfix exception is allowed because proof justification, decision log reference, and operator approval are all present.",
    };
  }

  return {
    allowed: false,
    disposition: normalizedPolicy.default_bug_disposition,
    reason:
      "Host bugfix remains outside the current phase until governance exception requirements are satisfied.",
  };
}

export {
  DEFAULT_SCOPE_GOVERNANCE_POLICY,
  ScopeGovernanceError,
  evaluateScopeBoundary,
  normalizeScopeGovernancePolicy,
};
