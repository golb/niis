import { parseTaskRecord } from "../schemas/task.js";
import {
  anyObject,
  arrayOf,
  defineSchema,
  enumField,
  exportSchema,
  integer,
  objectShape,
  parseSchema,
  validateSchema,
  string,
} from "../schemas/shared.js";
import { compareQueuePriority, createQueueItem, sortQueueItems, toIsoTimestamp } from "./queue.js";
import {
  LeaseError,
  acquireOrRenewLease,
  buildLeaseConflictBlocker,
  filterActiveLeases,
  findTaskLease,
  parseLeaseRecord,
  releaseLease,
} from "./lease.js";

class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = "LockError";
  }
}

const DEFERRED_WAKEUP_STATUSES = ["DEFERRED", "PROMOTED"];
const TRIGGER_DISPOSITIONS = [
  "ENQUEUED",
  "COALESCED_QUEUE",
  "DEFERRED",
  "COALESCED_DEFERRED",
  "PROMOTED",
];
const CONCURRENCY_DENIAL_REASONS = ["GLOBAL_LIMIT", "AGENT_LIMIT", "STATE_LIMIT"];

const deferredWakeupSchema = defineSchema({
  name: "deferred_wakeup",
  entity: "deferred_wakeup",
  description: "Task trigger deferred behind an active lease, with coalesced traceability.",
  fields: {
    wakeup_id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    priority: integer({ nullable: true, default: null }),
    original_source: string({ minLength: 1 }),
    original_context: anyObject({ default: {} }),
    deferred_at: string({ isoTimestamp: true }),
    promoted_at: string({ isoTimestamp: true, nullable: true, default: null }),
    status: enumField(DEFERRED_WAKEUP_STATUSES),
    coalesced_count: integer({ min: 1, default: 1 }),
    signals: arrayOf(
      objectShape({
        source: string({ minLength: 1 }),
        context: anyObject({ default: {} }),
        observed_at: string({ isoTimestamp: true }),
      }),
      { default: [] },
    ),
  },
});

function parseDeferredWakeup(input) {
  return parseSchema(deferredWakeupSchema, input);
}

function validateDeferredWakeup(input) {
  return validateSchema(deferredWakeupSchema, input);
}

function exportDeferredWakeupSchema() {
  return exportSchema(deferredWakeupSchema);
}

function normalizePositiveInteger(value, fieldName) {
  if (value === null || value === undefined) {
    return null;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new LockError(`${fieldName} must be a positive integer or null`);
  }

  return value;
}

function createDeferredWakeup({
  wakeupId,
  taskId,
  source,
  context = {},
  deferredAt,
  priority = null,
}) {
  const timestamp = toIsoTimestamp(deferredAt, "deferredAt");

  return parseDeferredWakeup({
    wakeup_id: wakeupId,
    task_id: taskId,
    priority,
    original_source: source,
    original_context: context,
    deferred_at: timestamp,
    promoted_at: null,
    status: "DEFERRED",
    coalesced_count: 1,
    signals: [
      {
        source,
        context,
        observed_at: timestamp,
      },
    ],
  });
}

function sortDeferredWakeups(deferredWakeups) {
  return deferredWakeups
    .map(parseDeferredWakeup)
    .sort((left, right) => {
      const deferredAtDiff = Date.parse(left.deferred_at) - Date.parse(right.deferred_at);

      if (deferredAtDiff !== 0) {
        return deferredAtDiff;
      }

      return left.task_id.localeCompare(right.task_id);
    });
}

function selectHigherPriority(currentPriority, nextPriority) {
  const diff = compareQueuePriority(currentPriority, nextPriority);

  if (diff <= 0) {
    return currentPriority;
  }

  return nextPriority;
}

function coalesceDeferredWakeup({
  deferredWakeups,
  taskId,
  source,
  context = {},
  now = new Date(),
  priority = null,
}) {
  const timestamp = toIsoTimestamp(now, "now");
  const orderedWakeups = sortDeferredWakeups(deferredWakeups);
  const existingWakeup = orderedWakeups.find(
    (wakeup) => wakeup.task_id === taskId && wakeup.status === "DEFERRED",
  );

  if (!existingWakeup) {
    const deferredWakeup = createDeferredWakeup({
      wakeupId: `${taskId}:${timestamp}`,
      taskId,
      source,
      context,
      deferredAt: timestamp,
      priority,
    });

    return {
      action: "created",
      deferredWakeup,
      deferredWakeups: [...orderedWakeups, deferredWakeup],
    };
  }

  const updatedWakeup = parseDeferredWakeup({
    ...existingWakeup,
    priority: selectHigherPriority(existingWakeup.priority, priority),
    coalesced_count: existingWakeup.coalesced_count + 1,
    signals: [
      ...existingWakeup.signals,
      {
        source,
        context,
        observed_at: timestamp,
      },
    ],
  });

  return {
    action: "coalesced",
    deferredWakeup: updatedWakeup,
    deferredWakeups: orderedWakeups.map((wakeup) =>
      wakeup.wakeup_id === existingWakeup.wakeup_id ? updatedWakeup : wakeup,
    ),
  };
}

function createConcurrencyPolicy({
  globalLimit = null,
  perAgentLimit = null,
  perStateThrottle = {},
} = {}) {
  const normalizedPerStateThrottle = {};

  for (const [state, limit] of Object.entries(perStateThrottle)) {
    normalizedPerStateThrottle[state] = normalizePositiveInteger(limit, `perStateThrottle.${state}`);
  }

  return Object.freeze({
    globalLimit: normalizePositiveInteger(globalLimit, "globalLimit"),
    perAgentLimit: normalizePositiveInteger(perAgentLimit, "perAgentLimit"),
    perStateThrottle: normalizedPerStateThrottle,
  });
}

function buildTaskLookup(tasks) {
  return new Map(tasks.map((task) => {
    const normalizedTask = parseTaskRecord(task);
    return [normalizedTask.id, normalizedTask];
  }));
}

function collectConcurrencySnapshot({ leases, tasks, now = new Date() }) {
  const timestamp = toIsoTimestamp(now, "now");
  const activeLeases = filterActiveLeases(leases, timestamp).map(parseLeaseRecord);
  const taskLookup = buildTaskLookup(tasks);
  const byHolder = {};
  const byState = {};

  for (const lease of activeLeases) {
    byHolder[lease.holder] = (byHolder[lease.holder] ?? 0) + 1;

    const task = taskLookup.get(lease.task_id);

    if (task) {
      byState[task.status] = (byState[task.status] ?? 0) + 1;
    }
  }

  return {
    activeLeases,
    byHolder,
    byState,
    globalActive: activeLeases.length,
    taskLookup,
  };
}

function evaluateConcurrencyPolicy({
  leases,
  tasks,
  holder,
  candidateTaskId,
  policy,
  now = new Date(),
}) {
  const normalizedPolicy = policy ?? createConcurrencyPolicy();
  const snapshot = collectConcurrencySnapshot({ leases, tasks, now });

  if (
    normalizedPolicy.globalLimit !== null &&
    snapshot.globalActive >= normalizedPolicy.globalLimit
  ) {
    return {
      allowed: false,
      reason: "GLOBAL_LIMIT",
      snapshot,
    };
  }

  if (
    normalizedPolicy.perAgentLimit !== null &&
    (snapshot.byHolder[holder] ?? 0) >= normalizedPolicy.perAgentLimit
  ) {
    return {
      allowed: false,
      reason: "AGENT_LIMIT",
      snapshot,
    };
  }

  const candidateTask = snapshot.taskLookup.get(candidateTaskId) ?? null;
  const stateLimit = candidateTask
    ? normalizedPolicy.perStateThrottle[candidateTask.status] ?? null
    : null;

  if (candidateTask && stateLimit !== null && (snapshot.byState[candidateTask.status] ?? 0) >= stateLimit) {
    return {
      allowed: false,
      reason: "STATE_LIMIT",
      snapshot,
    };
  }

  return {
    allowed: true,
    reason: null,
    snapshot,
  };
}

function acquireTaskExecutionLock({
  leases,
  tasks,
  taskId,
  holder,
  ttlMs,
  now = new Date(),
  policy = null,
  renewable = true,
}) {
  const timestamp = toIsoTimestamp(now, "now");
  const existingLease = findTaskLease(leases, taskId, timestamp);

  if (!existingLease || existingLease.holder !== holder) {
    const concurrency = evaluateConcurrencyPolicy({
      leases,
      tasks,
      holder,
      candidateTaskId: taskId,
      policy,
      now: timestamp,
    });

    if (!concurrency.allowed) {
      return {
        action: "concurrency_blocked",
        blocker: null,
        concurrency,
        lease: null,
        leases: filterActiveLeases(leases, timestamp),
      };
    }
  }

  const leaseResult = acquireOrRenewLease({
    leases,
    taskId,
    holder,
    now: timestamp,
    ttlMs,
    renewable,
  });

  return {
    ...leaseResult,
    concurrency: evaluateConcurrencyPolicy({
      leases: leaseResult.leases,
      tasks,
      holder,
      candidateTaskId: taskId,
      policy,
      now: timestamp,
    }),
  };
}

function registerExecutionTrigger({
  queueItems,
  deferredWakeups,
  leases,
  taskId,
  source,
  context = {},
  now = new Date(),
  priority = null,
}) {
  const timestamp = toIsoTimestamp(now, "now");
  const activeLease = findTaskLease(leases, taskId, timestamp);
  const sortedQueueItems = sortQueueItems(queueItems);

  if (activeLease) {
    const deferredResult = coalesceDeferredWakeup({
      deferredWakeups,
      taskId,
      source,
      context,
      now: timestamp,
      priority,
    });

    return {
      blocker: buildLeaseConflictBlocker({
        taskId,
        holder: source,
        existingLease: activeLease,
        timestamp,
      }),
      deferredWakeup: deferredResult.deferredWakeup,
      deferredWakeups: deferredResult.deferredWakeups,
      disposition:
        deferredResult.action === "created" ? "DEFERRED" : "COALESCED_DEFERRED",
      queueItem: null,
      queueItems: sortedQueueItems,
    };
  }

  const existingQueueItem = sortedQueueItems.find((queueItem) => queueItem.task_id === taskId) ?? null;

  if (existingQueueItem) {
    return {
      blocker: null,
      deferredWakeup: null,
      deferredWakeups,
      disposition: "COALESCED_QUEUE",
      queueItem: existingQueueItem,
      queueItems: sortedQueueItems,
    };
  }

  const queueItem = createQueueItem({
    taskId,
    priority,
    queuedAt: timestamp,
  });

  return {
    blocker: null,
    deferredWakeup: null,
    deferredWakeups,
    disposition: "ENQUEUED",
    queueItem,
    queueItems: sortQueueItems([...sortedQueueItems, queueItem]),
  };
}

function promoteDeferredWakeup({
  deferredWakeups,
  taskId,
  releasedAt = new Date(),
}) {
  const timestamp = toIsoTimestamp(releasedAt, "releasedAt");
  const orderedWakeups = sortDeferredWakeups(deferredWakeups);
  const deferredWakeup = orderedWakeups.find(
    (wakeup) => wakeup.task_id === taskId && wakeup.status === "DEFERRED",
  ) ?? null;

  if (!deferredWakeup) {
    return {
      deferredWakeup: null,
      deferredWakeups: orderedWakeups,
      disposition: null,
      queueItem: null,
    };
  }

  const promotedWakeup = parseDeferredWakeup({
    ...deferredWakeup,
    promoted_at: timestamp,
    status: "PROMOTED",
  });

  const queueItem = createQueueItem({
    taskId,
    priority: promotedWakeup.priority,
    queuedAt: promotedWakeup.deferred_at,
  });

  return {
    deferredWakeup: promotedWakeup,
    deferredWakeups: orderedWakeups.map((wakeup) =>
      wakeup.wakeup_id === promotedWakeup.wakeup_id ? promotedWakeup : wakeup,
    ),
    disposition: "PROMOTED",
    queueItem,
  };
}

function releaseTaskLock({
  leases,
  deferredWakeups,
  taskId,
  holder = null,
  releasedAt = new Date(),
}) {
  const releaseResult = releaseLease({
    leases,
    taskId,
    holder,
    now: releasedAt,
  });

  const promotionResult = promoteDeferredWakeup({
    deferredWakeups,
    taskId,
    releasedAt,
  });

  return {
    deferredWakeup: promotionResult.deferredWakeup,
    deferredWakeups: promotionResult.deferredWakeups,
    leases: releaseResult.leases,
    promotedQueueItem: promotionResult.queueItem,
    releasedLease: releaseResult.releasedLease,
  };
}

export {
  CONCURRENCY_DENIAL_REASONS,
  DEFERRED_WAKEUP_STATUSES,
  LockError,
  TRIGGER_DISPOSITIONS,
  acquireTaskExecutionLock,
  coalesceDeferredWakeup,
  collectConcurrencySnapshot,
  createConcurrencyPolicy,
  createDeferredWakeup,
  deferredWakeupSchema,
  evaluateConcurrencyPolicy,
  exportDeferredWakeupSchema,
  parseDeferredWakeup,
  promoteDeferredWakeup,
  registerExecutionTrigger,
  releaseTaskLock,
  sortDeferredWakeups,
  validateDeferredWakeup,
};
