const ACTIVATION_REVIEW_MODES = Object.freeze(["standard", "adversarial", "auto"]);
const ADVERSARIAL_REVIEW_STAGE_ROLES = Object.freeze(["attacker", "defender", "auditor"]);

const DEFAULT_ACTIVATION_REVIEW_POLICY = Object.freeze({
  high_stakes_surface_types: Object.freeze(["conversion_candidate"]),
  mode: "standard",
});

class ActivationReviewPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ActivationReviewPolicyError";
  }
}

function ensurePlainObject(value, label) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ActivationReviewPolicyError(`${label} must be a plain object`);
  }

  return value;
}

function ensureString(value, label, fallback) {
  const candidate = value ?? fallback;

  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new ActivationReviewPolicyError(`${label} must be a non-empty string`);
  }

  return candidate.trim();
}

function ensureStringArray(values, label, fallback = []) {
  const candidate = values ?? fallback;

  if (!Array.isArray(candidate)) {
    throw new ActivationReviewPolicyError(`${label} must be an array`);
  }

  return Object.freeze(candidate.map((value, index) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ActivationReviewPolicyError(`${label}[${index}] must be a non-empty string`);
    }

    return value.trim();
  }));
}

function normalizeActivationReviewPolicy(policy = {}) {
  const normalizedPolicy = ensurePlainObject(policy, "activation_review");
  const mode = ensureString(
    normalizedPolicy.mode,
    "activation_review.mode",
    DEFAULT_ACTIVATION_REVIEW_POLICY.mode,
  );

  if (!ACTIVATION_REVIEW_MODES.includes(mode)) {
    throw new ActivationReviewPolicyError(
      `unsupported activation_review.mode ${mode}; expected one of ${ACTIVATION_REVIEW_MODES.join(", ")}`,
    );
  }

  return Object.freeze({
    high_stakes_surface_types: ensureStringArray(
      normalizedPolicy.high_stakes_surface_types,
      "activation_review.high_stakes_surface_types",
      DEFAULT_ACTIVATION_REVIEW_POLICY.high_stakes_surface_types,
    ),
    mode,
  });
}

function resolveAdversarialReviewPlan({
  policy = DEFAULT_ACTIVATION_REVIEW_POLICY,
  surfaces = [],
} = {}) {
  const normalizedPolicy = normalizeActivationReviewPolicy(policy);
  const observedSurfaceTypes = Array.isArray(surfaces)
    ? surfaces
      .map((surface) => surface?.type)
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim())
    : [];
  const triggerSurfaceTypes = [...new Set(observedSurfaceTypes.filter(
    (surfaceType) => normalizedPolicy.high_stakes_surface_types.includes(surfaceType),
  ))];
  const required = normalizedPolicy.mode === "adversarial"
    || (normalizedPolicy.mode === "auto" && triggerSurfaceTypes.length > 0);

  return Object.freeze({
    mode: required ? "adversarial" : "standard",
    pattern_id: required ? "activation_import_adversarial/v1" : null,
    policy_mode: normalizedPolicy.mode,
    required,
    stage_roles: required ? ADVERSARIAL_REVIEW_STAGE_ROLES : Object.freeze([]),
    stages: required
      ? Object.freeze([
        Object.freeze({
          objective: "Enumerate credible abuse paths, privilege escalation, and prompt/security failure modes.",
          reviewer_role: "attacker",
          stage_id: "attacker_review",
        }),
        Object.freeze({
          objective: "Challenge or mitigate the attacker claims with concrete evidence and bounded counter-arguments.",
          reviewer_role: "defender",
          stage_id: "defender_review",
        }),
        Object.freeze({
          objective: "Resolve the dispute, weigh evidence quality, and issue the final activation/import recommendation.",
          reviewer_role: "auditor",
          stage_id: "auditor_review",
        }),
      ])
      : Object.freeze([]),
    trigger_surface_types: Object.freeze(triggerSurfaceTypes),
  });
}

export {
  ACTIVATION_REVIEW_MODES,
  ADVERSARIAL_REVIEW_STAGE_ROLES,
  ActivationReviewPolicyError,
  DEFAULT_ACTIVATION_REVIEW_POLICY,
  normalizeActivationReviewPolicy,
  resolveAdversarialReviewPlan,
};
