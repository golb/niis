import { createHash } from "node:crypto";

class QueueProjectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueueProjectionError";
  }
}

const DurableQueueState = Object.freeze({
  PENDING: "PENDING",
  CLAIMED: "CLAIMED",
  BLOCKED: "BLOCKED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

const DURABLE_QUEUE_STATES = Object.freeze(Object.values(DurableQueueState));
const TERMINAL_QUEUE_STATES = Object.freeze([
  DurableQueueState.COMPLETED,
  DurableQueueState.FAILED,
  DurableQueueState.CANCELLED,
]);

const QueueProjectionOperation = Object.freeze({
  UPSERT: "UPSERT",
  REMOVE: "REMOVE",
});
const QUEUE_PROJECTION_OPERATIONS = Object.freeze(
  Object.values(QueueProjectionOperation),
);

function clone(value) {
  return structuredClone(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function ensurePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new QueueProjectionError(`${label} must be a plain object`);
  }

  return value;
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new QueueProjectionError(`${label} must be a non-empty string`);
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
    throw new QueueProjectionError(`${label} must be an ISO 8601 timestamp`);
  }

  return new Date(normalized).toISOString();
}

function ensureInteger(value, label, { min = Number.MIN_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min) {
    throw new QueueProjectionError(`${label} must be an integer >= ${min}`);
  }

  return value;
}

function ensureQueueState(value, label = "state") {
  if (!DURABLE_QUEUE_STATES.includes(value)) {
    throw new QueueProjectionError(
      `${label} must be one of: ${DURABLE_QUEUE_STATES.join(", ")}`,
    );
  }

  return value;
}

function parseDurableQueueEntry(input) {
  const value = ensurePlainObject(input, "queueEntry");
  const state = ensureQueueState(value.state, "queueEntry.state");
  const claimedBy = ensureNullableString(
    value.claimed_by ?? null,
    "queueEntry.claimed_by",
  );
  const claimExpiresAt = ensureIsoTimestamp(
    value.claim_expires_at ?? null,
    "queueEntry.claim_expires_at",
    { nullable: true },
  );

  if (state === DurableQueueState.CLAIMED && (!claimedBy || !claimExpiresAt)) {
    throw new QueueProjectionError(
      "CLAIMED queue entries require claimed_by and claim_expires_at",
    );
  }

  if (state !== DurableQueueState.CLAIMED && (claimedBy || claimExpiresAt)) {
    throw new QueueProjectionError(
      `${state} queue entries cannot retain claim ownership`,
    );
  }

  return Object.freeze({
    task_id: ensureNonEmptyString(value.task_id, "queueEntry.task_id"),
    state,
    priority: value.priority === null || value.priority === undefined
      ? null
      : ensureInteger(value.priority, "queueEntry.priority"),
    available_at: ensureIsoTimestamp(
      value.available_at,
      "queueEntry.available_at",
    ),
    claimed_by: claimedBy,
    claim_expires_at: claimExpiresAt,
    created_at: ensureIsoTimestamp(value.created_at, "queueEntry.created_at"),
    updated_at: ensureIsoTimestamp(value.updated_at, "queueEntry.updated_at"),
    version: ensureInteger(value.version, "queueEntry.version", { min: 0 }),
    payload: clone(ensurePlainObject(value.payload ?? {}, "queueEntry.payload")),
  });
}

function createQueueProjectionContentDigest(input) {
  const entry = parseDurableQueueEntry(input);
  return sha256({
    available_at: entry.available_at,
    claim_expires_at: entry.claim_expires_at,
    claimed_by: entry.claimed_by,
    created_at: entry.created_at,
    payload: entry.payload,
    priority: entry.priority,
    state: entry.state,
    task_id: entry.task_id,
    updated_at: entry.updated_at,
    version: entry.version,
  });
}

function parseQueueProjectionEvent(input) {
  const value = ensurePlainObject(input, "queueProjectionEvent");
  const operation = value.operation;

  if (!QUEUE_PROJECTION_OPERATIONS.includes(operation)) {
    throw new QueueProjectionError(
      `queueProjectionEvent.operation must be one of: ${QUEUE_PROJECTION_OPERATIONS.join(", ")}`,
    );
  }

  const entry = value.entry === null || value.entry === undefined
    ? null
    : parseDurableQueueEntry(value.entry);

  if (operation === QueueProjectionOperation.UPSERT && entry === null) {
    throw new QueueProjectionError("UPSERT projection events require an entry");
  }

  return Object.freeze({
    sequence_id: ensureInteger(
      value.sequence_id,
      "queueProjectionEvent.sequence_id",
      { min: 1 },
    ),
    event_id: ensureNonEmptyString(
      value.event_id,
      "queueProjectionEvent.event_id",
    ),
    task_id: ensureNonEmptyString(
      value.task_id,
      "queueProjectionEvent.task_id",
    ),
    operation,
    entry,
    created_at: ensureIsoTimestamp(
      value.created_at,
      "queueProjectionEvent.created_at",
    ),
    delivered_at: ensureIsoTimestamp(
      value.delivered_at ?? null,
      "queueProjectionEvent.delivered_at",
      { nullable: true },
    ),
    delivery_attempts: ensureInteger(
      value.delivery_attempts ?? 0,
      "queueProjectionEvent.delivery_attempts",
      { min: 0 },
    ),
    last_error: ensureNullableString(
      value.last_error ?? null,
      "queueProjectionEvent.last_error",
    ),
  });
}

function normalizeProjectionSnapshot(entries) {
  if (!Array.isArray(entries)) {
    throw new QueueProjectionError("projection snapshot must be an array");
  }

  const normalized = entries.map((entry, index) => {
    const value = ensurePlainObject(entry, `projection[${index}]`);

    return Object.freeze({
      task_id: ensureNonEmptyString(value.task_id, `projection[${index}].task_id`),
      state: ensureQueueState(value.state, `projection[${index}].state`),
      version: ensureInteger(
        value.version ?? 0,
        `projection[${index}].version`,
        { min: 0 },
      ),
      content_digest: value.content_digest === null
        || value.content_digest === undefined
        ? null
        : ensureNonEmptyString(
          value.content_digest,
          `projection[${index}].content_digest`,
        ),
    });
  });
  const seen = new Set();

  for (const entry of normalized) {
    if (seen.has(entry.task_id)) {
      throw new QueueProjectionError(
        `projection snapshot contains duplicate task_id ${entry.task_id}`,
      );
    }
    seen.add(entry.task_id);
  }

  return normalized;
}

function compareQueueProjection({
  authoritativeEntries,
  projectedEntries,
  pendingEvents = [],
} = {}) {
  if (!Array.isArray(authoritativeEntries)) {
    throw new QueueProjectionError("authoritativeEntries must be an array");
  }

  const authoritative = authoritativeEntries.map(parseDurableQueueEntry);
  const projected = normalizeProjectionSnapshot(projectedEntries);
  const normalizedPendingEvents = pendingEvents.map(parseQueueProjectionEvent);
  const pendingTaskIds = new Set(
    normalizedPendingEvents.map((event) => event.task_id),
  );
  const authoritativeByTask = new Map(
    authoritative.map((entry) => [entry.task_id, entry]),
  );
  const projectedByTask = new Map(
    projected.map((entry) => [entry.task_id, entry]),
  );
  const taskIds = [...new Set([
    ...authoritativeByTask.keys(),
    ...projectedByTask.keys(),
  ])].sort();
  const divergences = [];

  for (const taskId of taskIds) {
    const source = authoritativeByTask.get(taskId) ?? null;
    const projection = projectedByTask.get(taskId) ?? null;
    let kind = null;

    if (!source) {
      kind = "projection_only";
    } else if (!projection) {
      kind = "source_only";
    } else if (source.state !== projection.state) {
      kind = "state_mismatch";
    } else if (source.version !== projection.version) {
      kind = "version_mismatch";
    } else if (projection.content_digest === null) {
      kind = "content_digest_missing";
    } else if (
      createQueueProjectionContentDigest(source) !== projection.content_digest
    ) {
      kind = "content_mismatch";
    }

    if (kind) {
      const authoritativeDigest = source
        ? createQueueProjectionContentDigest(source)
        : null;
      divergences.push(Object.freeze({
        task_id: taskId,
        kind,
        authoritative: source
          ? {
              content_digest: authoritativeDigest,
              state: source.state,
              version: source.version,
            }
          : null,
        projected: projection
          ? {
              content_digest: projection.content_digest,
              state: projection.state,
              version: projection.version,
            }
          : null,
        covered_by_pending_outbox: pendingTaskIds.has(taskId),
      }));
    }
  }

  const unexplainedDivergences = divergences.filter(
    (entry) => !entry.covered_by_pending_outbox,
  );
  const status = unexplainedDivergences.length > 0
    ? "diverged"
    : divergences.length > 0 || normalizedPendingEvents.length > 0
      ? "lagging"
      : "in_sync";

  return Object.freeze({
    status,
    requires_operator: unexplainedDivergences.length > 0,
    pending_outbox_count: normalizedPendingEvents.length,
    divergences: Object.freeze(divergences),
    unexplained_divergences: Object.freeze(unexplainedDivergences),
  });
}

async function readProjectionSnapshot(projection) {
  if (!projection || typeof projection !== "object") {
    throw new QueueProjectionError("projection is required");
  }

  const reader = projection.snapshot ?? projection.list;

  if (typeof reader !== "function") {
    throw new QueueProjectionError("projection must implement snapshot() or list()");
  }

  return normalizeProjectionSnapshot(await reader.call(projection));
}

async function inspectQueueProjection({ store, projection } = {}) {
  if (!store?.queue || typeof store.queue.list !== "function") {
    throw new QueueProjectionError("store.queue.list() is required");
  }

  if (!store?.outbox || typeof store.outbox.listPending !== "function") {
    throw new QueueProjectionError("store.outbox.listPending() is required");
  }

  const [authoritativeEntries, projectedEntries, pendingEvents] = await Promise.all([
    store.queue.list(),
    readProjectionSnapshot(projection),
    store.outbox.listPending(),
  ]);

  return compareQueueProjection({
    authoritativeEntries,
    projectedEntries,
    pendingEvents,
  });
}

async function flushQueueProjectionOutbox({
  store,
  projection,
  limit = 100,
} = {}) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new QueueProjectionError("limit must be a positive integer");
  }

  if (typeof projection?.apply !== "function") {
    throw new QueueProjectionError("projection.apply(event) is required");
  }

  const events = await store.outbox.listPending({ limit });
  const delivered = [];
  const failed = [];

  for (const rawEvent of events) {
    const event = parseQueueProjectionEvent(rawEvent);

    try {
      await projection.apply(event);
      await store.outbox.markDelivered({
        eventId: event.event_id,
      });
      delivered.push(event.event_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.outbox.markFailed({
        eventId: event.event_id,
        error: message,
      });
      failed.push(Object.freeze({
        event_id: event.event_id,
        error: message,
      }));
      break;
    }
  }

  return Object.freeze({
    delivered: Object.freeze(delivered),
    failed: Object.freeze(failed),
    processed: events.length,
  });
}

async function reconcileQueueProjection({
  store,
  projection,
  applyPending = false,
  limit = 100,
} = {}) {
  const before = await inspectQueueProjection({ store, projection });
  let flush = null;

  if (applyPending && before.pending_outbox_count > 0) {
    flush = await flushQueueProjectionOutbox({
      store,
      projection,
      limit,
    });
  }

  const after = flush
    ? await inspectQueueProjection({ store, projection })
    : before;

  return Object.freeze({
    before,
    flush,
    after,
    requires_operator: after.requires_operator,
  });
}

export {
  DURABLE_QUEUE_STATES,
  DurableQueueState,
  QUEUE_PROJECTION_OPERATIONS,
  QueueProjectionError,
  QueueProjectionOperation,
  TERMINAL_QUEUE_STATES,
  compareQueueProjection,
  createQueueProjectionContentDigest,
  flushQueueProjectionOutbox,
  inspectQueueProjection,
  normalizeProjectionSnapshot,
  parseDurableQueueEntry,
  parseQueueProjectionEvent,
  reconcileQueueProjection,
};
