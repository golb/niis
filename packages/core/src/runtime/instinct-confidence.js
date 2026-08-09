import { toIsoTimestamp } from "../scheduler/queue.js";

class InstinctConfidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstinctConfidenceError";
  }
}

const DEFAULT_INSTINCT_CONFIDENCE_POLICY = Object.freeze({
  contradiction_penalty_per_item: 0.1,
  decay_grace_days: 7,
  decay_penalty_per_day: 0.01,
  frequency_bands: Object.freeze([
    Object.freeze({ confidence: 0.3, max: 2, min: 1 }),
    Object.freeze({ confidence: 0.5, max: 5, min: 3 }),
    Object.freeze({ confidence: 0.7, max: 10, min: 6 }),
    Object.freeze({ confidence: 0.85, max: null, min: 11 }),
  ]),
  max_confidence: 1,
  max_confirmation_bonus: 0.15,
  max_contradiction_penalty: 0.3,
  max_decay_penalty: 0.2,
  min_confidence: 0,
  confirmation_bonus_per_session: 0.05,
});

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InstinctConfidenceError(`${label} must be a plain object`);
  }

  return value;
}

function ensureNonNegativeNumber(value, label) {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new InstinctConfidenceError(`${label} must be a non-negative number`);
  }

  return value;
}

function ensureInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new InstinctConfidenceError(`${label} must be a non-negative integer`);
  }

  return value;
}

function ensureTimestamp(value, label) {
  return toIsoTimestamp(value, label);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundConfidence(value) {
  return Math.round(value * 1000) / 1000;
}

function normalizeFrequencyBands(frequencyBands) {
  if (!Array.isArray(frequencyBands)) {
    throw new InstinctConfidenceError("confidencePolicy.frequency_bands must be an array");
  }

  return Object.freeze(frequencyBands.map((band, index) => {
    const normalizedBand = ensurePlainObject(band, `confidencePolicy.frequency_bands[${index}]`);
    const min = ensureInteger(normalizedBand.min, `confidencePolicy.frequency_bands[${index}].min`);
    const max = normalizedBand.max === null
      ? null
      : ensureInteger(normalizedBand.max, `confidencePolicy.frequency_bands[${index}].max`);

    if (max !== null && max < min) {
      throw new InstinctConfidenceError(
        `confidencePolicy.frequency_bands[${index}].max must be >= min`,
      );
    }

    return Object.freeze({
      confidence: ensureNonNegativeNumber(
        normalizedBand.confidence,
        `confidencePolicy.frequency_bands[${index}].confidence`,
      ),
      max,
      min,
    });
  }));
}

function normalizeInstinctConfidencePolicy(confidencePolicy = {}) {
  const normalizedPolicy = confidencePolicy === null ? {} : ensurePlainObject(
    confidencePolicy,
    "confidencePolicy",
  );

  return Object.freeze({
    confirmation_bonus_per_session: ensureNonNegativeNumber(
      normalizedPolicy.confirmation_bonus_per_session
      ?? normalizedPolicy.confirmationBonusPerSession
      ?? DEFAULT_INSTINCT_CONFIDENCE_POLICY.confirmation_bonus_per_session,
      "confidencePolicy.confirmation_bonus_per_session",
    ),
    contradiction_penalty_per_item: ensureNonNegativeNumber(
      normalizedPolicy.contradiction_penalty_per_item
      ?? normalizedPolicy.contradictionPenaltyPerItem
      ?? DEFAULT_INSTINCT_CONFIDENCE_POLICY.contradiction_penalty_per_item,
      "confidencePolicy.contradiction_penalty_per_item",
    ),
    decay_grace_days: ensureInteger(
      normalizedPolicy.decay_grace_days
      ?? normalizedPolicy.decayGraceDays
      ?? DEFAULT_INSTINCT_CONFIDENCE_POLICY.decay_grace_days,
      "confidencePolicy.decay_grace_days",
    ),
    decay_penalty_per_day: ensureNonNegativeNumber(
      normalizedPolicy.decay_penalty_per_day
      ?? normalizedPolicy.decayPenaltyPerDay
      ?? DEFAULT_INSTINCT_CONFIDENCE_POLICY.decay_penalty_per_day,
      "confidencePolicy.decay_penalty_per_day",
    ),
    frequency_bands: normalizeFrequencyBands(
      normalizedPolicy.frequency_bands
      ?? normalizedPolicy.frequencyBands
      ?? DEFAULT_INSTINCT_CONFIDENCE_POLICY.frequency_bands,
    ),
    max_confidence: ensureNonNegativeNumber(
      normalizedPolicy.max_confidence
      ?? normalizedPolicy.maxConfidence
      ?? DEFAULT_INSTINCT_CONFIDENCE_POLICY.max_confidence,
      "confidencePolicy.max_confidence",
    ),
    max_confirmation_bonus: ensureNonNegativeNumber(
      normalizedPolicy.max_confirmation_bonus
      ?? normalizedPolicy.maxConfirmationBonus
      ?? DEFAULT_INSTINCT_CONFIDENCE_POLICY.max_confirmation_bonus,
      "confidencePolicy.max_confirmation_bonus",
    ),
    max_contradiction_penalty: ensureNonNegativeNumber(
      normalizedPolicy.max_contradiction_penalty
      ?? normalizedPolicy.maxContradictionPenalty
      ?? DEFAULT_INSTINCT_CONFIDENCE_POLICY.max_contradiction_penalty,
      "confidencePolicy.max_contradiction_penalty",
    ),
    max_decay_penalty: ensureNonNegativeNumber(
      normalizedPolicy.max_decay_penalty
      ?? normalizedPolicy.maxDecayPenalty
      ?? DEFAULT_INSTINCT_CONFIDENCE_POLICY.max_decay_penalty,
      "confidencePolicy.max_decay_penalty",
    ),
    min_confidence: ensureNonNegativeNumber(
      normalizedPolicy.min_confidence
      ?? normalizedPolicy.minConfidence
      ?? DEFAULT_INSTINCT_CONFIDENCE_POLICY.min_confidence,
      "confidencePolicy.min_confidence",
    ),
  });
}

function resolveFrequencyBandConfidence(observationCount, confidencePolicy) {
  const matchingBand = confidencePolicy.frequency_bands.find((band) =>
    observationCount >= band.min && (band.max === null || observationCount <= band.max));

  if (!matchingBand) {
    return 0;
  }

  return matchingBand.confidence;
}

function calculateInstinctConfidence({
  confidencePolicy = {},
  evidence,
  reviewedAt,
} = {}) {
  const normalizedEvidence = ensurePlainObject(evidence, "evidence");
  const normalizedPolicy = normalizeInstinctConfidencePolicy(confidencePolicy);
  const observationCount = ensureInteger(
    normalizedEvidence.observation_count ?? normalizedEvidence.observationCount ?? 0,
    "evidence.observation_count",
  );
  const contradictingCount = ensureInteger(
    normalizedEvidence.contradicting_count ?? normalizedEvidence.contradictingCount ?? 0,
    "evidence.contradicting_count",
  );
  const confirmingSessions = normalizedEvidence.confirming_sessions
    ?? normalizedEvidence.confirmingSessions
    ?? [];

  if (!Array.isArray(confirmingSessions)) {
    throw new InstinctConfidenceError("evidence.confirming_sessions must be an array");
  }

  const lastObserved = ensureTimestamp(
    normalizedEvidence.last_observed ?? normalizedEvidence.lastObserved ?? reviewedAt,
    "evidence.last_observed",
  );
  const normalizedReviewedAt = ensureTimestamp(reviewedAt, "reviewedAt");
  const elapsedDays = Math.max(
    0,
    Math.floor((Date.parse(normalizedReviewedAt) - Date.parse(lastObserved)) / 86400000),
  );
  const baseConfidence = resolveFrequencyBandConfidence(observationCount, normalizedPolicy);
  const confirmationBonus = Math.min(
    confirmingSessions.length * normalizedPolicy.confirmation_bonus_per_session,
    normalizedPolicy.max_confirmation_bonus,
  );
  const contradictionPenalty = Math.min(
    contradictingCount * normalizedPolicy.contradiction_penalty_per_item,
    normalizedPolicy.max_contradiction_penalty,
  );
  const decayPenalty = Math.min(
    Math.max(0, elapsedDays - normalizedPolicy.decay_grace_days)
      * normalizedPolicy.decay_penalty_per_day,
    normalizedPolicy.max_decay_penalty,
  );
  const finalConfidence = clamp(
    baseConfidence + confirmationBonus - contradictionPenalty - decayPenalty,
    normalizedPolicy.min_confidence,
    normalizedPolicy.max_confidence,
  );

  return Object.freeze({
    adjustments: Object.freeze({
      confirmation_bonus: roundConfidence(confirmationBonus),
      contradiction_penalty: roundConfidence(contradictionPenalty),
      decay_penalty: roundConfidence(decayPenalty),
    }),
    base_confidence: roundConfidence(baseConfidence),
    elapsed_days_since_last_observed: elapsedDays,
    final_confidence: roundConfidence(finalConfidence),
    inputs: Object.freeze({
      confirming_sessions: confirmingSessions.length,
      contradicting_count: contradictingCount,
      last_observed: lastObserved,
      observation_count: observationCount,
      reviewed_at: normalizedReviewedAt,
    }),
    policy: normalizedPolicy,
  });
}

export {
  DEFAULT_INSTINCT_CONFIDENCE_POLICY,
  InstinctConfidenceError,
  calculateInstinctConfidence,
  normalizeInstinctConfidencePolicy,
};
