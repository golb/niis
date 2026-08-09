import {
  UiLifecycleActionError,
  assertRetryLifecyclePolicy,
  countRetryAttempts,
} from "./ui-actions.js";

const AUTO_REPAIR_SCHEMA_VERSION = 1;
const AUTO_REPAIR_TRIGGER = "auto-repair";
const REPAIRABLE_ATTEMPT_STAGE = "BLOCKED";
const REPAIRABLE_CANONICAL_VERDICT = "DEFECT";
const TERMINAL_ATTEMPT_STAGES = new Set([
  "BLOCKED",
  "CANCELLED",
  "FAILED",
  "FINISHED",
]);

class AutoRepairPolicyError extends Error {
  constructor(message, { code = "auto_repair_policy_error" } = {}) {
    super(message);
    this.name = "AutoRepairPolicyError";
    this.code = code;
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function freezeDecision(value) {
  return Object.freeze(value);
}

function ineligible(reason, details = {}) {
  return freezeDecision({
    eligible: false,
    reason,
    ...details,
  });
}

function resolvePriorFailureReason(attempt) {
  const value =
    attempt?.state?.review?.reason
    ?? attempt?.state?.gates?.reason
    ?? attempt?.state?.terminal?.reason
    ?? attempt?.last_error
    ?? "The prior attempt ended with a repairable defect.";
  return String(value).trim().slice(0, 2_000);
}

function resolveAttemptPlanDigest(attempt) {
  const digest = attempt?.state?.workspace?.plan_approval_digest;
  return isNonEmptyString(digest) ? digest.trim() : null;
}

function resolveBoundedAutoRepairDecision({
  activeBlockerCount = 0,
  approvedPlanDigest = null,
  attempts = [],
  config = {},
  planApproved = false,
  promotionRecord = null,
  queueEntry = null,
  task = null,
} = {}) {
  if (config?.enabled !== true) {
    return ineligible("config_disabled");
  }
  if (!task || !queueEntry || !Array.isArray(attempts)) {
    return ineligible("policy_state_unavailable");
  }
  if (queueEntry.state !== "BLOCKED") {
    return ineligible("queue_not_repairable", {
      queue_state: queueEntry.state ?? null,
    });
  }
  if (!["BLOCKED", "REJECTED"].includes(task.status)) {
    return ineligible("task_not_repairable", {
      task_status: task.status ?? null,
    });
  }
  const activeAttempt = attempts.find((attempt) =>
    !TERMINAL_ATTEMPT_STAGES.has(attempt?.stage));
  if (activeAttempt) {
    return ineligible("active_attempt_exists", {
      active_attempt_id: activeAttempt.id ?? null,
    });
  }
  const priorAttempt = attempts.at(-1) ?? null;
  if (!priorAttempt) {
    return ineligible("prior_attempt_missing");
  }
  if (
    queueEntry.payload?.attempt_id !== priorAttempt.id
    || priorAttempt.task_id !== task.id
  ) {
    return ineligible("attempt_binding_mismatch");
  }
  if (
    priorAttempt.stage !== REPAIRABLE_ATTEMPT_STAGE
    || priorAttempt.canonical_verdict !== REPAIRABLE_CANONICAL_VERDICT
  ) {
    return ineligible("verdict_not_repairable", {
      prior_attempt_stage: priorAttempt.stage ?? null,
      prior_canonical_verdict: priorAttempt.canonical_verdict ?? null,
    });
  }
  if (promotionRecord) {
    return ineligible("promotion_record_exists");
  }
  const priorPlanDigest = resolveAttemptPlanDigest(priorAttempt);
  if (
    !planApproved
    || !isNonEmptyString(approvedPlanDigest)
    || !priorPlanDigest
    || priorPlanDigest !== approvedPlanDigest.trim()
  ) {
    return ineligible("plan_approval_mismatch");
  }

  const retryAttemptCount = countRetryAttempts(attempts);
  try {
    const retryPolicy = assertRetryLifecyclePolicy({
      activeBlockerCount,
      maxRejections: task.max_rejections,
      maxRetryAttempts: config.max_attempts,
      planApproved,
      rejectionCount: task.rejection_count,
      retryAttemptCount,
    });
    return freezeDecision({
      eligible: true,
      max_attempts: retryPolicy.maxRetryAttempts,
      plan_approval_digest: priorPlanDigest,
      prior_attempt_id: priorAttempt.id,
      prior_canonical_verdict: priorAttempt.canonical_verdict,
      prior_reason: resolvePriorFailureReason(priorAttempt),
      reason: "repairable_defect",
      sequence: retryPolicy.retryAttemptCount + 1,
      trigger: AUTO_REPAIR_TRIGGER,
    });
  } catch (error) {
    if (error instanceof UiLifecycleActionError) {
      return ineligible(error.code, {
        policy_message: error.message,
      });
    }
    throw error;
  }
}

function createAutoRepairQueuePayloadPatch({
  decision,
  now = new Date(),
} = {}) {
  if (!decision?.eligible) {
    throw new AutoRepairPolicyError(
      "an eligible auto-repair decision is required",
      { code: "auto_repair_decision_required" },
    );
  }
  const scheduledAt = now instanceof Date
    ? now.toISOString()
    : new Date(now).toISOString();
  if (Number.isNaN(Date.parse(scheduledAt))) {
    throw new AutoRepairPolicyError(
      "now must be an ISO 8601 timestamp",
      { code: "auto_repair_timestamp_invalid" },
    );
  }
  return Object.freeze({
    attempt_engine_version: null,
    attempt_id: null,
    attempt_trigger: null,
    auto_repair: Object.freeze({
      plan_approval_digest: decision.plan_approval_digest,
      prior_attempt_id: decision.prior_attempt_id,
      prior_canonical_verdict: decision.prior_canonical_verdict,
      prior_reason: decision.prior_reason,
      scheduled_at: scheduledAt,
      schema_version: AUTO_REPAIR_SCHEMA_VERSION,
      sequence: decision.sequence,
      trigger: AUTO_REPAIR_TRIGGER,
    }),
    canonical_verdict: null,
    resume_required: false,
  });
}

function parseAutoRepairEnvelope(queueEntry) {
  const envelope = queueEntry?.payload?.auto_repair;
  if (!envelope) return null;
  if (
    envelope.schema_version !== AUTO_REPAIR_SCHEMA_VERSION
    || envelope.trigger !== AUTO_REPAIR_TRIGGER
    || !Number.isInteger(envelope.sequence)
    || envelope.sequence < 1
    || !isNonEmptyString(envelope.plan_approval_digest)
    || !isNonEmptyString(envelope.prior_attempt_id)
    || envelope.prior_canonical_verdict !== REPAIRABLE_CANONICAL_VERDICT
    || !isNonEmptyString(envelope.scheduled_at)
    || Number.isNaN(Date.parse(envelope.scheduled_at))
  ) {
    throw new AutoRepairPolicyError(
      `task ${queueEntry?.task_id ?? "unknown"} has invalid auto-repair provenance`,
      { code: "auto_repair_provenance_invalid" },
    );
  }
  return Object.freeze({
    plan_approval_digest: envelope.plan_approval_digest.trim(),
    prior_attempt_id: envelope.prior_attempt_id.trim(),
    prior_canonical_verdict: envelope.prior_canonical_verdict,
    prior_reason: String(envelope.prior_reason ?? "").slice(0, 2_000),
    scheduled_at: new Date(envelope.scheduled_at).toISOString(),
    schema_version: envelope.schema_version,
    sequence: envelope.sequence,
    trigger: envelope.trigger,
  });
}

function assertAutoRepairClaimPolicy({
  activeBlockerCount = 0,
  config = {},
  queueEntry,
  task = null,
} = {}) {
  const envelope = parseAutoRepairEnvelope(queueEntry);
  if (!envelope) return null;
  if (config.enabled !== true) {
    throw new AutoRepairPolicyError(
      "bounded auto-repair was disabled after this attempt was scheduled",
      { code: "auto_repair_disabled" },
    );
  }
  if (!task || task.id !== queueEntry.task_id) {
    throw new AutoRepairPolicyError(
      "task state is unavailable for the queued repair",
      { code: "auto_repair_task_missing" },
    );
  }
  try {
    assertRetryLifecyclePolicy({
      activeBlockerCount,
      maxRejections: task.max_rejections,
      maxRetryAttempts: config.max_attempts,
      planApproved: true,
      rejectionCount: task.rejection_count,
      retryAttemptCount: envelope.sequence - 1,
    });
  } catch (error) {
    if (error instanceof UiLifecycleActionError) {
      throw new AutoRepairPolicyError(error.message, {
        code: error.code,
      });
    }
    throw error;
  }
  return envelope;
}

function resolveAutoRepairPriorAttempt({
  approvedPlanDigest,
  attempts = [],
  boundAttempt = null,
  queueEntry,
} = {}) {
  const envelope = parseAutoRepairEnvelope(queueEntry);
  if (!envelope) return null;
  const boundAttemptId = isNonEmptyString(queueEntry?.payload?.attempt_id)
    ? queueEntry.payload.attempt_id.trim()
    : null;
  if (
    boundAttemptId
    && (
      boundAttempt?.id !== boundAttemptId
      || boundAttempt.trigger !== AUTO_REPAIR_TRIGGER
      || TERMINAL_ATTEMPT_STAGES.has(boundAttempt.stage)
    )
  ) {
    throw new AutoRepairPolicyError(
      "repair provenance is bound to an invalid attempt",
      { code: "auto_repair_attempt_binding_invalid" },
    );
  }
  if (
    !isNonEmptyString(approvedPlanDigest)
    || approvedPlanDigest.trim() !== envelope.plan_approval_digest
  ) {
    throw new AutoRepairPolicyError(
      "the approved plan changed after the repair attempt was scheduled",
      { code: "auto_repair_plan_changed" },
    );
  }
  const priorAttempt = attempts.find((attempt) =>
    attempt?.id === envelope.prior_attempt_id) ?? null;
  if (
    !priorAttempt
    || priorAttempt.task_id !== queueEntry.task_id
    || priorAttempt.stage !== REPAIRABLE_ATTEMPT_STAGE
    || priorAttempt.canonical_verdict !== envelope.prior_canonical_verdict
    || resolveAttemptPlanDigest(priorAttempt) !== envelope.plan_approval_digest
  ) {
    throw new AutoRepairPolicyError(
      "the immutable prior attempt no longer matches repair provenance",
      { code: "auto_repair_prior_attempt_mismatch" },
    );
  }
  return priorAttempt;
}

export {
  AUTO_REPAIR_SCHEMA_VERSION,
  AUTO_REPAIR_TRIGGER,
  AutoRepairPolicyError,
  assertAutoRepairClaimPolicy,
  createAutoRepairQueuePayloadPatch,
  parseAutoRepairEnvelope,
  resolveAutoRepairPriorAttempt,
  resolveBoundedAutoRepairDecision,
  resolvePriorFailureReason,
};
