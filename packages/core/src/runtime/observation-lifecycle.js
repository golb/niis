import { createPolicyObservation, normalizeObservationLifecyclePolicy } from "../policy/observations.js";
import { resolvePolicy } from "../policy/resolved-policy.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import {
  OBSERVATION_STORAGE_TIERS,
  parseObservationArtifact,
} from "../schemas/observation-artifact.js";

class ObservationLifecycleError extends Error {
  constructor(message) {
    super(message);
    this.name = "ObservationLifecycleError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ObservationLifecycleError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureNullableTimestamp(value, label) {
  if (value === null || value === undefined) {
    return null;
  }

  return toIsoTimestamp(value, label);
}

function ensureEnumValue(value, allowedValues, label) {
  if (!allowedValues.includes(value)) {
    throw new ObservationLifecycleError(`${label} must be one of: ${allowedValues.join(", ")}`);
  }

  return value;
}

function resolveLifecyclePolicy(policy = {}) {
  return resolvePolicy({ runtimeOverrides: policy }).observation_ingestion.lifecycle_policy;
}

function deriveObservationArtifactId(observation, createdAt) {
  const suffix = `${observation.source_id}-${Date.parse(createdAt)}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `observation-${suffix}`.replace(/^-+|-+$/g, "");
}

function createObservationArtifact({
  artifactId = null,
  archivedAt = null,
  createdAt = new Date(),
  observation,
  policy = {},
  processedAt = null,
  purgedAt = null,
  storageTier = "hot",
  updatedAt = null,
} = {}) {
  const normalizedObservation = createPolicyObservation(observation);
  const normalizedCreatedAt = toIsoTimestamp(createdAt, "createdAt");
  const lifecyclePolicy = normalizeObservationLifecyclePolicy(resolveLifecyclePolicy(policy));
  const normalizedStorageTier = ensureEnumValue(storageTier, OBSERVATION_STORAGE_TIERS, "storageTier");
  const normalizedUpdatedAt = updatedAt === null || updatedAt === undefined
    ? normalizedCreatedAt
    : toIsoTimestamp(updatedAt, "updatedAt");

  return parseObservationArtifact({
    archived_at: ensureNullableTimestamp(archivedAt, "archivedAt"),
    created_at: normalizedCreatedAt,
    id:
      artifactId === null || artifactId === undefined
        ? deriveObservationArtifactId(normalizedObservation, normalizedCreatedAt)
        : ensureNonEmptyString(artifactId, "artifactId"),
    lifecycle: {
      archive_after_days: lifecyclePolicy.archive_after_days,
      last_action: normalizedStorageTier === "purged" ? "purge" : "retain_hot",
      last_evaluated_at: normalizedUpdatedAt,
      policy_id: lifecyclePolicy.policy_id,
      purge_after_days: lifecyclePolicy.purge_after_days,
      retain_unprocessed: lifecyclePolicy.retain_unprocessed,
    },
    observation: normalizedObservation,
    processed_at: ensureNullableTimestamp(processedAt, "processedAt"),
    purged_at: ensureNullableTimestamp(purgedAt, "purgedAt"),
    storage_tier: normalizedStorageTier,
    updated_at: normalizedUpdatedAt,
  });
}

function ageInDays(fromTimestamp, now) {
  return (Date.parse(now) - Date.parse(fromTimestamp)) / (24 * 60 * 60 * 1000);
}

function evaluateObservationLifecycle({
  artifact,
  now = new Date(),
  policy = {},
} = {}) {
  const normalizedArtifact = parseObservationArtifact(artifact);
  const normalizedNow = toIsoTimestamp(now, "now");
  const lifecyclePolicy = normalizeObservationLifecyclePolicy(
    policy?.observation_ingestion?.lifecycle_policy
    ?? policy?.observation_ingestion?.lifecyclePolicy
    ?? resolveLifecyclePolicy(policy),
  );
  const processedReference = normalizedArtifact.processed_at ?? normalizedArtifact.created_at;
  const purgeReference =
    normalizedArtifact.archived_at
    ?? normalizedArtifact.processed_at
    ?? normalizedArtifact.created_at;
  const processedAgeDays = ageInDays(processedReference, normalizedNow);
  const purgeAgeDays = ageInDays(purgeReference, normalizedNow);
  let action = "retain_hot";
  let nextStorageTier = normalizedArtifact.storage_tier;
  let reason =
    normalizedArtifact.storage_tier === "archive"
      ? "artifact remains in the archive observation tier."
      : "artifact remains in the hot observation tier.";

  if (normalizedArtifact.storage_tier === "purged") {
    action = "purge";
    nextStorageTier = "purged";
    reason = "artifact is already purged and remains outside the hot path.";
  } else if (normalizedArtifact.processed_at === null && lifecyclePolicy.retain_unprocessed) {
    action = "retain_hot";
    nextStorageTier = "hot";
    reason = "unprocessed observations remain in the hot path until review or promotion consumes them.";
  } else if (purgeAgeDays >= lifecyclePolicy.purge_after_days) {
    action = "purge";
    nextStorageTier = "purged";
    reason = `artifact age exceeded purge_after_days=${lifecyclePolicy.purge_after_days}.`;
  } else if (
    normalizedArtifact.storage_tier === "hot"
    && normalizedArtifact.processed_at !== null
    && processedAgeDays >= lifecyclePolicy.archive_after_days
  ) {
    action = "archive";
    nextStorageTier = "archive";
    reason = `processed artifact age exceeded archive_after_days=${lifecyclePolicy.archive_after_days}.`;
  }

  const updatedArtifact = parseObservationArtifact({
    ...normalizedArtifact,
    archived_at:
      action === "archive"
        ? normalizedArtifact.archived_at ?? normalizedNow
        : normalizedArtifact.archived_at,
    lifecycle: {
      archive_after_days: lifecyclePolicy.archive_after_days,
      last_action: action,
      last_evaluated_at: normalizedNow,
      policy_id: lifecyclePolicy.policy_id,
      purge_after_days: lifecyclePolicy.purge_after_days,
      retain_unprocessed: lifecyclePolicy.retain_unprocessed,
    },
    purged_at:
      action === "purge"
        ? normalizedArtifact.purged_at ?? normalizedNow
        : normalizedArtifact.purged_at,
    storage_tier: nextStorageTier,
    updated_at: normalizedNow,
  });

  return Object.freeze({
    action,
    age_days: Number(processedAgeDays.toFixed(2)),
    artifact_id: normalizedArtifact.id,
    next_storage_tier: nextStorageTier,
    policy: lifecyclePolicy,
    reason,
    updated_artifact: updatedArtifact,
  });
}

function applyObservationLifecycle({
  artifacts = [],
  now = new Date(),
  policy = {},
} = {}) {
  if (!Array.isArray(artifacts)) {
    throw new ObservationLifecycleError("artifacts must be an array");
  }

  const decisions = Object.freeze(artifacts.map((artifact) =>
    evaluateObservationLifecycle({ artifact, now, policy })));
  const summary = Object.freeze({
    archive: decisions.filter((decision) => decision.action === "archive").length,
    purge: decisions.filter((decision) => decision.action === "purge").length,
    retain_hot: decisions.filter((decision) => decision.action === "retain_hot").length,
    total: decisions.length,
  });

  return Object.freeze({
    decisions,
    policy: decisions[0]?.policy ?? normalizeObservationLifecyclePolicy(resolveLifecyclePolicy(policy)),
    summary,
    updated_artifacts: Object.freeze(decisions.map((decision) => decision.updated_artifact)),
  });
}

export {
  ObservationLifecycleError,
  applyObservationLifecycle,
  createObservationArtifact,
  evaluateObservationLifecycle,
};
