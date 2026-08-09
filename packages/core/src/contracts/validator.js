import { AUTHENTICITY_STATUSES } from "../schemas/evidence.js";
import { FAILURE_ATTRIBUTIONS, VERDICT_CLASSES } from "../schemas/verdict.js";

class ValidatorContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidatorContractError";
  }
}

const VALIDATOR_STRICTNESS_LEVELS = Object.freeze(["strict", "standard", "minimal"]);

const DEFAULT_VERDICT_CONTINUATION_POLICY = Object.freeze({
  PASS: Object.freeze({
    action: "complete_lane",
    continue_to_next: false,
    create_blocker: false,
    retry_kind: null,
  }),
  DEFECT: Object.freeze({
    action: "stop_with_blocker",
    continue_to_next: false,
    create_blocker: true,
    retry_kind: null,
  }),
  EVIDENCE_GAP: Object.freeze({
    action: "continue_to_next_validator",
    continue_to_next: true,
    create_blocker: false,
    retry_kind: null,
  }),
  PARTIAL_PROGRESS: Object.freeze({
    action: "request_short_continuation_retry",
    continue_to_next: false,
    create_blocker: false,
    retry_kind: "continuation",
  }),
  ENV_BLOCK: Object.freeze({
    action: "stop_with_blocker",
    continue_to_next: false,
    create_blocker: true,
    retry_kind: null,
  }),
  NEEDS_ESCALATION: Object.freeze({
    action: "stop_with_blocker",
    continue_to_next: false,
    create_blocker: true,
    retry_kind: null,
  }),
});

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidatorContractError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidatorContractError(`${label} must be a plain object`);
  }

  return value;
}

function ensureStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new ValidatorContractError(`${label} must be an array`);
  }

  return [...new Set(values.map((value, index) =>
    ensureNonEmptyString(value, `${label}[${index}]`)))];
}

function ensureVerdictClass(verdictClass) {
  const normalizedVerdictClass = ensureNonEmptyString(verdictClass, "verdict_class");

  if (!VERDICT_CLASSES.includes(normalizedVerdictClass)) {
    throw new ValidatorContractError(
      `unsupported verdict_class ${normalizedVerdictClass}; expected one of ${VERDICT_CLASSES.join(", ")}`,
    );
  }

  return normalizedVerdictClass;
}

function ensureFailureAttribution(failureAttribution) {
  const normalizedFailureAttribution =
    failureAttribution === undefined || failureAttribution === null
      ? "none"
      : ensureNonEmptyString(failureAttribution, "failure_attribution");

  if (!FAILURE_ATTRIBUTIONS.includes(normalizedFailureAttribution)) {
    throw new ValidatorContractError(
      `unsupported failure_attribution ${normalizedFailureAttribution}; expected one of ${FAILURE_ATTRIBUTIONS.join(", ")}`,
    );
  }

  return normalizedFailureAttribution;
}

function normalizeEvidencePacket(evidencePacket = {}) {
  if (evidencePacket === null) {
    return null;
  }

  const normalized = evidencePacket && typeof evidencePacket === "object" && !Array.isArray(evidencePacket)
    ? evidencePacket
    : {};
  const items = Array.isArray(normalized.items)
    ? normalized.items.map((item, index) => {
      const normalizedItem = ensurePlainObject(item, `evidence_packet.items[${index}]`);

      return Object.freeze({
        content: ensureNonEmptyString(
          normalizedItem.content ?? normalizedItem.summary ?? "runtime evidence item",
          `evidence_packet.items[${index}].content`,
        ),
        raw_output_ref:
          normalizedItem.raw_output_ref === undefined ? null : normalizedItem.raw_output_ref,
        source: ensureNonEmptyString(
          normalizedItem.source ?? "validator",
          `evidence_packet.items[${index}].source`,
        ),
        subtask_id:
          normalizedItem.subtask_id === undefined || normalizedItem.subtask_id === null
            ? null
            : ensureNonEmptyString(
              normalizedItem.subtask_id,
              `evidence_packet.items[${index}].subtask_id`,
            ),
        type: ensureNonEmptyString(
          normalizedItem.type ?? "note",
          `evidence_packet.items[${index}].type`,
        ),
      });
    })
    : [];
  const authenticityStatus = normalized.authenticity_status ?? "UNVERIFIED";

  if (!AUTHENTICITY_STATUSES.includes(authenticityStatus)) {
    throw new ValidatorContractError(
      `unsupported evidence authenticity_status ${authenticityStatus}`,
    );
  }

  return Object.freeze({
    authenticity_status: authenticityStatus,
    items: Object.freeze(items),
    markers: Object.freeze({
      auth_surfaces_attempted: Array.isArray(normalized.markers?.auth_surfaces_attempted)
        ? normalized.markers.auth_surfaces_attempted
        : [],
      browser_live_checks: Array.isArray(normalized.markers?.browser_live_checks)
        ? normalized.markers.browser_live_checks
        : [],
      checked_urls: Array.isArray(normalized.markers?.checked_urls)
        ? normalized.markers.checked_urls
        : [],
      runtime_evidence_succeeded: Boolean(normalized.markers?.runtime_evidence_succeeded),
    }),
  });
}

function normalizeObservationSignals(observationSignals = []) {
  if (!Array.isArray(observationSignals)) {
    throw new ValidatorContractError("observation_signals must be an array");
  }

  return Object.freeze(observationSignals.map((signal, index) => {
    const normalizedSignal = ensurePlainObject(signal, `observation_signals[${index}]`);

    return Object.freeze({
      category: ensureNonEmptyString(
        normalizedSignal.category ?? "validator_signal",
        `observation_signals[${index}].category`,
      ),
      confidence: typeof normalizedSignal.confidence === "number"
        ? normalizedSignal.confidence
        : 0,
      pattern_category:
        normalizedSignal.pattern_category ?? normalizedSignal.patternCategory ?? null,
      summary: ensureNonEmptyString(
        normalizedSignal.summary ?? `validator signal ${index + 1}`,
        `observation_signals[${index}].summary`,
      ),
    });
  }));
}

function normalizeValidatorResult(result, validatorId) {
  const normalizedResult = ensurePlainObject(result, `validator result from ${validatorId}`);

  return Object.freeze({
    blocker_class:
      normalizedResult.blocker_class === undefined ? null : normalizedResult.blocker_class,
    evidence_packet: normalizeEvidencePacket(
      normalizedResult.evidence_packet === undefined ? {} : normalizedResult.evidence_packet,
    ),
    human_summary:
      normalizedResult.human_summary === undefined
        ? null
        : ensureNonEmptyString(normalizedResult.human_summary, "human_summary"),
    next_action: ensureNonEmptyString(normalizedResult.next_action, "next_action"),
    observation_signals: normalizeObservationSignals(
      normalizedResult.observation_signals ?? [],
    ),
    policy_refs: Object.freeze(
      ensureStringArray(normalizedResult.policy_refs ?? [], "policy_refs"),
    ),
    reason: ensureNonEmptyString(normalizedResult.reason, "reason"),
    failure_attribution: ensureFailureAttribution(
      normalizedResult.failure_attribution ?? normalizedResult.failureAttribution,
    ),
    verdict_class: ensureVerdictClass(normalizedResult.verdict_class),
  });
}

function createVerdictContinuationPolicy(overrides = {}) {
  const normalizedOverrides = overrides && typeof overrides === "object" && !Array.isArray(overrides)
    ? overrides
    : {};
  const policy = {};

  for (const verdictClass of VERDICT_CLASSES) {
    const override = normalizedOverrides[verdictClass] ?? {};
    const base = DEFAULT_VERDICT_CONTINUATION_POLICY[verdictClass];
    const normalizedAction = ensureNonEmptyString(
      override.action ?? base.action,
      `${verdictClass}.action`,
    );

    policy[verdictClass] = Object.freeze({
      action: normalizedAction,
      continue_to_next:
        override.continue_to_next === undefined
          ? base.continue_to_next
          : Boolean(override.continue_to_next),
      create_blocker:
        override.create_blocker === undefined
          ? base.create_blocker
          : Boolean(override.create_blocker),
      retry_kind:
        override.retry_kind === undefined
          ? base.retry_kind
          : override.retry_kind === null
            ? null
            : ensureNonEmptyString(override.retry_kind, `${verdictClass}.retry_kind`),
    });
  }

  return Object.freeze(policy);
}

function createValidatorDefinition({
  id,
  description,
  domain,
  excludedConcerns = [],
  validate,
}) {
  const validatorId = ensureNonEmptyString(id, "validator id");
  const validatorDomain = ensureNonEmptyString(domain, `${validatorId} domain`);
  const normalizedExcludedConcerns = ensureStringArray(
    excludedConcerns,
    `${validatorId} excludedConcerns`,
  );

  if (normalizedExcludedConcerns.includes(validatorDomain)) {
    throw new ValidatorContractError(
      `validator ${validatorId} cannot exclude its own domain ${validatorDomain}`,
    );
  }

  if (typeof validate !== "function") {
    throw new ValidatorContractError(`validator ${validatorId} validate must be a function`);
  }

  return Object.freeze({
    description: ensureNonEmptyString(description ?? validatorId, `${validatorId} description`),
    domain: validatorDomain,
    excluded_concerns: Object.freeze(normalizedExcludedConcerns),
    id: validatorId,
    async validate(context) {
      const result = await validate(context);
      return normalizeValidatorResult(result, validatorId);
    },
  });
}

function assertValidatorOrthogonality(validators = []) {
  if (!Array.isArray(validators)) {
    throw new ValidatorContractError("validators must be an array");
  }

  const ids = new Set();
  const domains = new Set();

  for (const validator of validators) {
    if (!validator || typeof validator.validate !== "function") {
      throw new ValidatorContractError("each validator must expose validate()");
    }

    if (ids.has(validator.id)) {
      throw new ValidatorContractError(`validator id ${validator.id} is duplicated`);
    }

    if (domains.has(validator.domain)) {
      throw new ValidatorContractError(
        `validator domain ${validator.domain} is duplicated; validators must remain orthogonal`,
      );
    }

    ids.add(validator.id);
    domains.add(validator.domain);
  }

  return true;
}

function selectValidatorsById(validators = [], validatorIds = []) {
  if (!Array.isArray(validatorIds) || validatorIds.length === 0) {
    return validators;
  }

  const byId = new Map(validators.map((validator) => [validator.id, validator]));

  return validatorIds.map((validatorId) => {
    const normalizedValidatorId = ensureNonEmptyString(validatorId, "validator id");
    const validator = byId.get(normalizedValidatorId);

    if (!validator) {
      throw new ValidatorContractError(`unknown validator id: ${normalizedValidatorId}`);
    }

    return validator;
  });
}

export {
  DEFAULT_VERDICT_CONTINUATION_POLICY,
  VALIDATOR_STRICTNESS_LEVELS,
  ValidatorContractError,
  assertValidatorOrthogonality,
  createValidatorDefinition,
  createVerdictContinuationPolicy,
  normalizeValidatorResult,
  selectValidatorsById,
};
