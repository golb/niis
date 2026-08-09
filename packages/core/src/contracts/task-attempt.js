import { VERDICT_CLASSES } from "../schemas/verdict.js";

class TaskAttemptContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskAttemptContractError";
  }
}

const AttemptStage = Object.freeze({
  CLAIMED: "CLAIMED",
  WORKSPACE_PREPARED: "WORKSPACE_PREPARED",
  EXECUTED: "EXECUTED",
  GATES_RUN: "GATES_RUN",
  REVIEWED: "REVIEWED",
  READY_TO_PROMOTE: "READY_TO_PROMOTE",
  PROMOTED: "PROMOTED",
  FINISHED: "FINISHED",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

const ATTEMPT_STAGES = Object.freeze(Object.values(AttemptStage));
const TERMINAL_ATTEMPT_STAGES = Object.freeze([
  AttemptStage.FINISHED,
  AttemptStage.BLOCKED,
  AttemptStage.FAILED,
  AttemptStage.CANCELLED,
]);
const ACTIVE_ATTEMPT_STAGES = Object.freeze(
  ATTEMPT_STAGES.filter((stage) => !TERMINAL_ATTEMPT_STAGES.includes(stage)),
);

const CanonicalVerdict = Object.freeze(
  Object.fromEntries(VERDICT_CLASSES.map((verdictClass) => [verdictClass, verdictClass])),
);
const CANONICAL_VERDICTS = Object.freeze(Object.values(CanonicalVerdict));

const PromotionStatus = Object.freeze({
  PENDING: "PENDING",
  PROMOTED: "PROMOTED",
  FAILED: "FAILED",
});
const PROMOTION_STATUSES = Object.freeze(Object.values(PromotionStatus));

const PromotionTargetKind = Object.freeze({
  BRANCH: "BRANCH",
  PULL_REQUEST: "PULL_REQUEST",
});
const PROMOTION_TARGET_KINDS = Object.freeze(Object.values(PromotionTargetKind));

const ALLOWED_ATTEMPT_STAGE_TRANSITIONS = Object.freeze({
  [AttemptStage.CLAIMED]: Object.freeze([
    AttemptStage.WORKSPACE_PREPARED,
    AttemptStage.BLOCKED,
    AttemptStage.FAILED,
    AttemptStage.CANCELLED,
  ]),
  [AttemptStage.WORKSPACE_PREPARED]: Object.freeze([
    AttemptStage.EXECUTED,
    AttemptStage.BLOCKED,
    AttemptStage.FAILED,
    AttemptStage.CANCELLED,
  ]),
  [AttemptStage.EXECUTED]: Object.freeze([
    AttemptStage.GATES_RUN,
    AttemptStage.BLOCKED,
    AttemptStage.FAILED,
    AttemptStage.CANCELLED,
  ]),
  [AttemptStage.GATES_RUN]: Object.freeze([
    AttemptStage.REVIEWED,
    AttemptStage.BLOCKED,
    AttemptStage.FAILED,
    AttemptStage.CANCELLED,
  ]),
  [AttemptStage.REVIEWED]: Object.freeze([
    AttemptStage.READY_TO_PROMOTE,
    AttemptStage.BLOCKED,
    AttemptStage.FAILED,
    AttemptStage.CANCELLED,
  ]),
  [AttemptStage.READY_TO_PROMOTE]: Object.freeze([
    AttemptStage.PROMOTED,
    AttemptStage.BLOCKED,
    AttemptStage.FAILED,
    AttemptStage.CANCELLED,
  ]),
  [AttemptStage.PROMOTED]: Object.freeze([
    AttemptStage.FINISHED,
    AttemptStage.FAILED,
  ]),
  [AttemptStage.FINISHED]: Object.freeze([]),
  [AttemptStage.BLOCKED]: Object.freeze([]),
  [AttemptStage.FAILED]: Object.freeze([]),
  [AttemptStage.CANCELLED]: Object.freeze([]),
});

function clone(value) {
  return structuredClone(value);
}

function ensurePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskAttemptContractError(`${label} must be a plain object`);
  }

  return value;
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TaskAttemptContractError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureNullableString(value, label) {
  if (value === null || value === undefined) {
    return null;
  }

  return ensureNonEmptyString(value, label);
}

function ensureIsoTimestamp(value, label, { nullable = false } = {}) {
  if ((value === null || value === undefined) && nullable) {
    return null;
  }

  const normalized = value instanceof Date ? value.toISOString() : value;

  if (typeof normalized !== "string" || Number.isNaN(Date.parse(normalized))) {
    throw new TaskAttemptContractError(`${label} must be an ISO 8601 timestamp`);
  }

  return new Date(normalized).toISOString();
}

function ensureInteger(value, label, { min = Number.MIN_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min) {
    throw new TaskAttemptContractError(`${label} must be an integer >= ${min}`);
  }

  return value;
}

function ensureEnum(value, allowedValues, label, { nullable = false } = {}) {
  if ((value === null || value === undefined) && nullable) {
    return null;
  }

  if (!allowedValues.includes(value)) {
    throw new TaskAttemptContractError(`${label} must be one of: ${allowedValues.join(", ")}`);
  }

  return value;
}

function isTerminalAttemptStage(stage) {
  return TERMINAL_ATTEMPT_STAGES.includes(stage);
}

function canTransitionAttemptStage(fromStage, toStage) {
  return Boolean(ALLOWED_ATTEMPT_STAGE_TRANSITIONS[fromStage]?.includes(toStage));
}

function assertAttemptStageTransition(fromStage, toStage) {
  ensureEnum(fromStage, ATTEMPT_STAGES, "fromStage");
  ensureEnum(toStage, ATTEMPT_STAGES, "toStage");

  if (!canTransitionAttemptStage(fromStage, toStage)) {
    throw new TaskAttemptContractError(
      `invalid task attempt transition: ${fromStage} -> ${toStage}`,
    );
  }

  return true;
}

function parseTaskAttempt(input) {
  const value = ensurePlainObject(input, "taskAttempt");
  const stage = ensureEnum(value.stage, ATTEMPT_STAGES, "taskAttempt.stage");
  const canonicalVerdict = ensureEnum(
    value.canonical_verdict ?? null,
    CANONICAL_VERDICTS,
    "taskAttempt.canonical_verdict",
    { nullable: true },
  );
  const finishedAt = ensureIsoTimestamp(
    value.finished_at ?? null,
    "taskAttempt.finished_at",
    { nullable: true },
  );
  const leaseHolder = ensureNullableString(
    value.lease_holder ?? null,
    "taskAttempt.lease_holder",
  );
  const leaseExpiresAt = ensureIsoTimestamp(
    value.lease_expires_at ?? null,
    "taskAttempt.lease_expires_at",
    { nullable: true },
  );

  if (stage === AttemptStage.FINISHED && canonicalVerdict !== CanonicalVerdict.PASS) {
    throw new TaskAttemptContractError("FINISHED task attempts require canonical_verdict PASS");
  }

  if (stage === AttemptStage.READY_TO_PROMOTE && canonicalVerdict !== CanonicalVerdict.PASS) {
    throw new TaskAttemptContractError(
      "READY_TO_PROMOTE task attempts require canonical_verdict PASS",
    );
  }

  if (stage === AttemptStage.PROMOTED && canonicalVerdict !== CanonicalVerdict.PASS) {
    throw new TaskAttemptContractError("PROMOTED task attempts require canonical_verdict PASS");
  }

  if (stage === AttemptStage.REVIEWED && canonicalVerdict === null) {
    throw new TaskAttemptContractError(
      "REVIEWED task attempts require a canonical verdict",
    );
  }

  if (Boolean(leaseHolder) !== Boolean(leaseExpiresAt)) {
    throw new TaskAttemptContractError(
      "task attempt lease_holder and lease_expires_at must be set together",
    );
  }

  if (isTerminalAttemptStage(stage) && finishedAt === null) {
    throw new TaskAttemptContractError(
      `${stage} task attempts require a non-null finished_at timestamp`,
    );
  }

  if (!isTerminalAttemptStage(stage) && finishedAt !== null) {
    throw new TaskAttemptContractError(
      `${stage} task attempts must not have a finished_at timestamp`,
    );
  }

  return Object.freeze({
    id: ensureNonEmptyString(value.id, "taskAttempt.id"),
    task_id: ensureNonEmptyString(value.task_id, "taskAttempt.task_id"),
    trigger: ensureNonEmptyString(value.trigger, "taskAttempt.trigger"),
    engine_version: ensureNonEmptyString(
      value.engine_version,
      "taskAttempt.engine_version",
    ),
    stage,
    canonical_verdict: canonicalVerdict,
    workspace_path: ensureNullableString(
      value.workspace_path ?? null,
      "taskAttempt.workspace_path",
    ),
    lease_holder: leaseHolder,
    lease_expires_at: leaseExpiresAt,
    heartbeat_at: ensureIsoTimestamp(
      value.heartbeat_at ?? null,
      "taskAttempt.heartbeat_at",
      { nullable: true },
    ),
    created_at: ensureIsoTimestamp(value.created_at, "taskAttempt.created_at"),
    updated_at: ensureIsoTimestamp(value.updated_at, "taskAttempt.updated_at"),
    finished_at: finishedAt,
    version: ensureInteger(value.version, "taskAttempt.version", { min: 0 }),
    state: clone(ensurePlainObject(value.state ?? {}, "taskAttempt.state")),
    last_error: ensureNullableString(
      value.last_error ?? null,
      "taskAttempt.last_error",
    ),
  });
}

function createTaskAttempt({
  id,
  taskId,
  trigger,
  engineVersion,
  now = new Date(),
  stage = AttemptStage.CLAIMED,
  state = {},
} = {}) {
  const timestamp = ensureIsoTimestamp(now, "now");

  return parseTaskAttempt({
    id,
    task_id: taskId,
    trigger,
    engine_version: engineVersion,
    stage,
    canonical_verdict: null,
    workspace_path: null,
    lease_holder: null,
    lease_expires_at: null,
    heartbeat_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    finished_at: isTerminalAttemptStage(stage) ? timestamp : null,
    version: 0,
    state,
    last_error: null,
  });
}

function parsePromotionRecord(input) {
  const value = ensurePlainObject(input, "promotionRecord");
  const status = ensureEnum(
    value.status,
    PROMOTION_STATUSES,
    "promotionRecord.status",
  );
  const promotedAt = ensureIsoTimestamp(
    value.promoted_at ?? null,
    "promotionRecord.promoted_at",
    { nullable: true },
  );
  const targetKind = ensureEnum(
    value.target_kind ?? null,
    PROMOTION_TARGET_KINDS,
    "promotionRecord.target_kind",
    { nullable: true },
  );
  const targetRef = ensureNullableString(
    value.target_ref ?? null,
    "promotionRecord.target_ref",
  );

  if (status === PromotionStatus.PROMOTED && promotedAt === null) {
    throw new TaskAttemptContractError(
      "PROMOTED promotion records require a non-null promoted_at timestamp",
    );
  }

  if (
    status === PromotionStatus.PROMOTED
    && (targetKind === null || targetRef === null)
  ) {
    throw new TaskAttemptContractError(
      "PROMOTED promotion records require target_kind and target_ref",
    );
  }

  return Object.freeze({
    id: ensureNonEmptyString(value.id, "promotionRecord.id"),
    attempt_id: ensureNonEmptyString(
      value.attempt_id,
      "promotionRecord.attempt_id",
    ),
    task_id: ensureNonEmptyString(value.task_id, "promotionRecord.task_id"),
    status,
    target_kind: targetKind,
    target_ref: targetRef,
    branch_name: ensureNullableString(
      value.branch_name ?? null,
      "promotionRecord.branch_name",
    ),
    commit_sha: ensureNullableString(
      value.commit_sha ?? null,
      "promotionRecord.commit_sha",
    ),
    pr_url: ensureNullableString(value.pr_url ?? null, "promotionRecord.pr_url"),
    error: ensureNullableString(value.error ?? null, "promotionRecord.error"),
    created_at: ensureIsoTimestamp(value.created_at, "promotionRecord.created_at"),
    updated_at: ensureIsoTimestamp(value.updated_at, "promotionRecord.updated_at"),
    promoted_at: promotedAt,
    version: ensureInteger(value.version, "promotionRecord.version", { min: 0 }),
    metadata: clone(
      ensurePlainObject(value.metadata ?? {}, "promotionRecord.metadata"),
    ),
  });
}

function createPromotionRecord({
  id,
  attemptId,
  taskId,
  now = new Date(),
  metadata = {},
} = {}) {
  const timestamp = ensureIsoTimestamp(now, "now");

  return parsePromotionRecord({
    id,
    attempt_id: attemptId,
    task_id: taskId,
    status: PromotionStatus.PENDING,
    target_kind: null,
    target_ref: null,
    branch_name: null,
    commit_sha: null,
    pr_url: null,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
    promoted_at: null,
    version: 0,
    metadata,
  });
}

function isPromotionAllowed(attempt) {
  const normalized = parseTaskAttempt(attempt);

  return (
    normalized.stage === AttemptStage.READY_TO_PROMOTE
    && normalized.canonical_verdict === CanonicalVerdict.PASS
  );
}

function parseTaskAttemptResult(input) {
  const value = ensurePlainObject(input, "taskAttemptResult");
  const stage = ensureEnum(value.stage, ATTEMPT_STAGES, "taskAttemptResult.stage");
  const verdict = ensureEnum(
    value.canonical_verdict ?? null,
    CANONICAL_VERDICTS,
    "taskAttemptResult.canonical_verdict",
    { nullable: true },
  );
  const promotion = value.promotion === null || value.promotion === undefined
    ? null
    : parsePromotionRecord(value.promotion);
  const promoted = promotion?.status === PromotionStatus.PROMOTED;
  const resumable = !isTerminalAttemptStage(stage);

  if (Boolean(value.promoted) !== promoted) {
    throw new TaskAttemptContractError(
      "taskAttemptResult.promoted must match the promotion record status",
    );
  }

  if (Boolean(value.resumable) !== resumable) {
    throw new TaskAttemptContractError(
      "taskAttemptResult.resumable must match the attempt stage",
    );
  }

  return Object.freeze({
    attempt_id: ensureNonEmptyString(
      value.attempt_id,
      "taskAttemptResult.attempt_id",
    ),
    task_id: ensureNonEmptyString(value.task_id, "taskAttemptResult.task_id"),
    stage,
    canonical_verdict: verdict,
    workspace_path: ensureNullableString(
      value.workspace_path ?? null,
      "taskAttemptResult.workspace_path",
    ),
    promoted,
    promotion,
    resumable,
    state: clone(
      ensurePlainObject(value.state ?? {}, "taskAttemptResult.state"),
    ),
  });
}

function createTaskAttemptResult({ attempt, promotion = null } = {}) {
  const normalizedAttempt = parseTaskAttempt(attempt);
  const normalizedPromotion = promotion === null ? null : parsePromotionRecord(promotion);

  return parseTaskAttemptResult({
    attempt_id: normalizedAttempt.id,
    task_id: normalizedAttempt.task_id,
    stage: normalizedAttempt.stage,
    canonical_verdict: normalizedAttempt.canonical_verdict,
    workspace_path: normalizedAttempt.workspace_path,
    promoted: normalizedPromotion?.status === PromotionStatus.PROMOTED,
    promotion: normalizedPromotion,
    resumable: !isTerminalAttemptStage(normalizedAttempt.stage),
    state: normalizedAttempt.state,
  });
}

const TaskAttempt = Object.freeze({
  create: createTaskAttempt,
  parse: parseTaskAttempt,
});
const PromotionRecord = Object.freeze({
  create: createPromotionRecord,
  parse: parsePromotionRecord,
});
const TaskAttemptResult = Object.freeze({
  create: createTaskAttemptResult,
  parse: parseTaskAttemptResult,
});

export {
  ACTIVE_ATTEMPT_STAGES,
  ALLOWED_ATTEMPT_STAGE_TRANSITIONS,
  ATTEMPT_STAGES,
  AttemptStage,
  CANONICAL_VERDICTS,
  CanonicalVerdict,
  PROMOTION_STATUSES,
  PROMOTION_TARGET_KINDS,
  PromotionRecord,
  PromotionStatus,
  PromotionTargetKind,
  TERMINAL_ATTEMPT_STAGES,
  TaskAttempt,
  TaskAttemptContractError,
  TaskAttemptResult,
  assertAttemptStageTransition,
  canTransitionAttemptStage,
  createPromotionRecord,
  createTaskAttempt,
  createTaskAttemptResult,
  isPromotionAllowed,
  isTerminalAttemptStage,
  parsePromotionRecord,
  parseTaskAttempt,
  parseTaskAttemptResult,
};
