import { parseBlockerArtifact } from "../schemas/blocker.js";
import {
  booleanField,
  defineSchema,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "../schemas/shared.js";
import { toIsoTimestamp } from "./queue.js";

class LeaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "LeaseError";
  }
}

const leaseSchema = defineSchema({
  name: "lease_record",
  entity: "lease",
  description: "Canonical task-scoped lease used as the execution lock primitive.",
  fields: {
    lease_id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    holder: string({ minLength: 1 }),
    acquired_at: string({ isoTimestamp: true }),
    expires_at: string({ isoTimestamp: true }),
    renewable: booleanField({ default: true }),
  },
});

function parseLeaseRecord(input) {
  return parseSchema(leaseSchema, input);
}

function validateLeaseRecord(input) {
  return validateSchema(leaseSchema, input);
}

function exportLeaseSchema() {
  return exportSchema(leaseSchema);
}

function createLease({
  leaseId,
  taskId,
  holder,
  acquiredAt,
  expiresAt,
  renewable = true,
}) {
  return parseLeaseRecord({
    lease_id: leaseId,
    task_id: taskId,
    holder,
    acquired_at: toIsoTimestamp(acquiredAt, "acquiredAt"),
    expires_at: toIsoTimestamp(expiresAt, "expiresAt"),
    renewable,
  });
}

function addMilliseconds(timestamp, milliseconds) {
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
    throw new LeaseError("ttlMs must be a positive integer");
  }

  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function isLeaseExpired(leaseRecord, now) {
  const lease = parseLeaseRecord(leaseRecord);
  return Date.parse(lease.expires_at) <= Date.parse(toIsoTimestamp(now, "now"));
}

function isLeaseActive(leaseRecord, now) {
  return !isLeaseExpired(leaseRecord, now);
}

function filterActiveLeases(leases, now) {
  return leases.map(parseLeaseRecord).filter((lease) => isLeaseActive(lease, now));
}

function findTaskLease(leases, taskId, now) {
  return filterActiveLeases(leases, now).find((lease) => lease.task_id === taskId) ?? null;
}

function buildLeaseConflictBlocker({ taskId, holder, existingLease, timestamp }) {
  const activeLease = parseLeaseRecord(existingLease);

  return parseBlockerArtifact({
    id: `${taskId}:lock-conflict:${timestamp}`,
    task_id: taskId,
    blocker_class: "LOCK_CONFLICT",
    reason: `Task ${taskId} is locked by ${activeLease.holder} until ${activeLease.expires_at}; ${holder} cannot acquire the task lock yet.`,
    next_action: `Wait for the active lease to expire or be released before allowing ${holder} to run task ${taskId}.`,
    created_at: timestamp,
    resolved_at: null,
  });
}

function acquireOrRenewLease({
  leases,
  taskId,
  holder,
  now = new Date(),
  ttlMs,
  leaseId = `lease:${taskId}`,
  renewable = true,
}) {
  if (!taskId || !holder) {
    throw new LeaseError("acquireOrRenewLease requires taskId and holder");
  }

  const timestamp = toIsoTimestamp(now, "now");
  const activeLeases = filterActiveLeases(leases, timestamp);
  const existingLease = activeLeases.find((lease) => lease.task_id === taskId) ?? null;

  if (!existingLease) {
    const lease = createLease({
      leaseId,
      taskId,
      holder,
      acquiredAt: timestamp,
      expiresAt: addMilliseconds(timestamp, ttlMs),
      renewable,
    });

    return {
      action: "acquired",
      blocker: null,
      lease,
      leases: [...activeLeases, lease],
    };
  }

  if (existingLease.holder !== holder) {
    return {
      action: "conflict",
      blocker: buildLeaseConflictBlocker({
        taskId,
        holder,
        existingLease,
        timestamp,
      }),
      lease: null,
      leases: activeLeases,
    };
  }

  if (!existingLease.renewable) {
    return {
      action: "held",
      blocker: null,
      lease: existingLease,
      leases: activeLeases,
    };
  }

  const renewedLease = createLease({
    leaseId: existingLease.lease_id,
    taskId,
    holder,
    acquiredAt: existingLease.acquired_at,
    expiresAt: addMilliseconds(timestamp, ttlMs),
    renewable: existingLease.renewable,
  });

  return {
    action: "renewed",
    blocker: null,
    lease: renewedLease,
    leases: activeLeases.map((lease) => (lease.task_id === taskId ? renewedLease : lease)),
  };
}

function releaseLease({ leases, taskId, holder = null, now = new Date() }) {
  const timestamp = toIsoTimestamp(now, "now");
  const activeLeases = filterActiveLeases(leases, timestamp);
  let releasedLease = null;

  const remainingLeases = activeLeases.filter((lease) => {
    const sameTask = lease.task_id === taskId;
    const sameHolder = holder === null || lease.holder === holder;

    if (sameTask && sameHolder && releasedLease === null) {
      releasedLease = lease;
      return false;
    }

    return true;
  });

  return {
    leases: remainingLeases,
    releasedLease,
  };
}

export {
  LeaseError,
  acquireOrRenewLease,
  buildLeaseConflictBlocker,
  createLease,
  exportLeaseSchema,
  filterActiveLeases,
  findTaskLease,
  isLeaseActive,
  isLeaseExpired,
  leaseSchema,
  parseLeaseRecord,
  releaseLease,
  validateLeaseRecord,
};
