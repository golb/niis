import {
  defineSchema,
  enumField,
  exportSchema,
  integer,
  parseSchema,
  string,
  validateSchema,
} from "../schemas/shared.js";

class QueueModelError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueueModelError";
  }
}

const QUEUE_ITEM_STATUSES = ["QUEUED", "CLAIMED"];
const TASK_SOURCE_TIMESTAMP_FIELDS = ["created_at", "updated_at", "queued_at", "detected_at"];
const TASK_SOURCE_NORMALIZATION_CONTRACT = Object.freeze({
  identifier: "sanitize to [A-Za-z0-9._-] with separator collapse",
  state: "trimmed lowercase string",
  labels: "array of trimmed lowercase strings",
  priority: "integer or null",
  timestamps: "ISO-8601 strings",
});

const queueItemSchema = defineSchema({
  name: "queue_item",
  entity: "queue_item",
  description: "Canonical queue item for deterministic scheduler dispatch.",
  fields: {
    task_id: string({ minLength: 1 }),
    priority: integer({ nullable: true, default: null }),
    queued_at: string({ isoTimestamp: true }),
    claimed_by: string({ nullable: true, default: null }),
    claim_expires_at: string({ nullable: true, default: null, isoTimestamp: true }),
    status: enumField(QUEUE_ITEM_STATUSES),
  },
});

function parseQueueItem(input) {
  return parseSchema(queueItemSchema, input);
}

function validateQueueItem(input) {
  return validateSchema(queueItemSchema, input);
}

function exportQueueItemSchema() {
  return exportSchema(queueItemSchema);
}

function toIsoTimestamp(value, fieldName = "timestamp") {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new QueueModelError(`${fieldName} must be a valid timestamp`);
  }

  return date.toISOString();
}

function normalizeQueuePriority(priority) {
  if (priority === null || priority === undefined || priority === "") {
    return null;
  }

  if (typeof priority === "string") {
    const trimmed = priority.trim();

    if (trimmed === "") {
      return null;
    }

    if (!/^-?\d+$/.test(trimmed)) {
      throw new QueueModelError("priority must be an integer or null");
    }

    return Number.parseInt(trimmed, 10);
  }

  if (!Number.isInteger(priority)) {
    throw new QueueModelError("priority must be an integer or null");
  }

  return priority;
}

function compareQueuePriority(leftPriority, rightPriority) {
  const left = normalizeQueuePriority(leftPriority);
  const right = normalizeQueuePriority(rightPriority);

  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left - right;
}

function compareQueueItems(leftItem, rightItem) {
  const left = parseQueueItem(leftItem);
  const right = parseQueueItem(rightItem);

  const priorityDiff = compareQueuePriority(left.priority, right.priority);

  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  const queuedAtDiff = Date.parse(left.queued_at) - Date.parse(right.queued_at);

  if (queuedAtDiff !== 0) {
    return queuedAtDiff;
  }

  return left.task_id.localeCompare(right.task_id);
}

function sortQueueItems(queueItems) {
  return queueItems
    .map((queueItem, index) => ({
      index,
      item: parseQueueItem(queueItem),
    }))
    .sort((left, right) => {
      const diff = compareQueueItems(left.item, right.item);

      if (diff !== 0) {
        return diff;
      }

      return left.index - right.index;
    })
    .map(({ item }) => item);
}

function createQueueItem({
  taskId,
  priority = null,
  queuedAt,
  claimedBy = null,
  claimExpiresAt = null,
  status = "QUEUED",
}) {
  return parseQueueItem({
    task_id: taskId,
    priority: normalizeQueuePriority(priority),
    queued_at: toIsoTimestamp(queuedAt, "queuedAt"),
    claimed_by: claimedBy,
    claim_expires_at: claimExpiresAt === null ? null : toIsoTimestamp(claimExpiresAt, "claimExpiresAt"),
    status,
  });
}

function hasClaimExpired(queueItem, now) {
  const normalizedQueueItem = parseQueueItem(queueItem);

  if (normalizedQueueItem.status !== "CLAIMED" || !normalizedQueueItem.claim_expires_at) {
    return false;
  }

  return Date.parse(normalizedQueueItem.claim_expires_at) <= Date.parse(toIsoTimestamp(now, "now"));
}

function releaseExpiredClaim(queueItem, now) {
  const normalizedQueueItem = parseQueueItem(queueItem);

  if (!hasClaimExpired(normalizedQueueItem, now)) {
    return normalizedQueueItem;
  }

  return parseQueueItem({
    ...normalizedQueueItem,
    claimed_by: null,
    claim_expires_at: null,
    status: "QUEUED",
  });
}

function claimQueueItem(queueItem, { claimedBy, claimExpiresAt }) {
  const normalizedQueueItem = parseQueueItem(queueItem);

  if (!claimedBy) {
    throw new QueueModelError("claimQueueItem requires claimedBy");
  }

  if (normalizedQueueItem.status === "CLAIMED" && normalizedQueueItem.claim_expires_at) {
    throw new QueueModelError(
      `Queue item ${normalizedQueueItem.task_id} already has an active claim and cannot be claimed again`,
    );
  }

  return parseQueueItem({
    ...normalizedQueueItem,
    claimed_by: claimedBy,
    claim_expires_at: toIsoTimestamp(claimExpiresAt, "claimExpiresAt"),
    status: "CLAIMED",
  });
}

function sanitizeTaskSourceIdentifier(identifier) {
  if (typeof identifier !== "string" || identifier.trim() === "") {
    throw new QueueModelError("identifier must be a non-empty string");
  }

  const sanitized = identifier
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  if (!sanitized) {
    throw new QueueModelError("identifier must contain at least one allowed character");
  }

  return sanitized;
}

function normalizeTaskSourceState(state) {
  if (typeof state !== "string" || state.trim() === "") {
    throw new QueueModelError("state must be a non-empty string");
  }

  return state.trim().toLowerCase();
}

function normalizeTaskSourceLabels(labels) {
  if (labels === undefined || labels === null) {
    return [];
  }

  if (!Array.isArray(labels)) {
    throw new QueueModelError("labels must be an array");
  }

  const normalized = labels.map((label, index) => {
    if (typeof label !== "string" || label.trim() === "") {
      throw new QueueModelError(`labels[${index}] must be a non-empty string`);
    }

    return label.trim().toLowerCase();
  });

  return [...new Set(normalized)];
}

function normalizeTaskSourceRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new QueueModelError("task source record must be a plain object");
  }

  const identifierSource = input.identifier ?? input.id ?? input.task_id;

  if (identifierSource === undefined) {
    throw new QueueModelError("task source record must include identifier, id, or task_id");
  }

  const normalized = {
    identifier: sanitizeTaskSourceIdentifier(identifierSource),
    state: normalizeTaskSourceState(input.state),
    labels: normalizeTaskSourceLabels(input.labels),
    priority: normalizeQueuePriority(input.priority),
  };

  for (const fieldName of TASK_SOURCE_TIMESTAMP_FIELDS) {
    if (input[fieldName] !== undefined && input[fieldName] !== null) {
      normalized[fieldName] = toIsoTimestamp(input[fieldName], fieldName);
    }
  }

  return normalized;
}

export {
  QUEUE_ITEM_STATUSES,
  QueueModelError,
  TASK_SOURCE_NORMALIZATION_CONTRACT,
  TASK_SOURCE_TIMESTAMP_FIELDS,
  claimQueueItem,
  compareQueueItems,
  compareQueuePriority,
  createQueueItem,
  exportQueueItemSchema,
  hasClaimExpired,
  normalizeQueuePriority,
  normalizeTaskSourceLabels,
  normalizeTaskSourceRecord,
  normalizeTaskSourceState,
  parseQueueItem,
  queueItemSchema,
  releaseExpiredClaim,
  sanitizeTaskSourceIdentifier,
  sortQueueItems,
  toIsoTimestamp,
  validateQueueItem,
};
