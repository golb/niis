import { parseAssignmentReason } from "../schemas/assignment.js";
import { parseTaskRecord } from "../schemas/task.js";
import { claimQueueItem, releaseExpiredClaim, sortQueueItems, toIsoTimestamp } from "./queue.js";

class SchedulerError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchedulerError";
  }
}

const CLAIMABLE_TASK_STATUSES = ["PENDING"];
const DEFAULT_CLAIM_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REASON_TYPE = "auto_pickup";
const DEFAULT_POLICY_REF = "scheduler/deterministic-dispatch/v1";
const DEFAULT_ASSIGNMENT_CONTEXT =
  "Claimed by deterministic dispatch sort (priority -> queued_at -> task_id)";

function addMilliseconds(timestamp, milliseconds) {
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
    throw new SchedulerError("claimTtlMs must be a positive integer");
  }

  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function buildTaskLookup(tasks) {
  const taskLookup = new Map();

  for (const taskRecord of tasks) {
    const normalizedTask = parseTaskRecord(taskRecord);
    taskLookup.set(normalizedTask.id, normalizedTask);
  }

  return taskLookup;
}

function getIncompleteDependencies(taskRecord, taskLookup) {
  const task = parseTaskRecord(taskRecord);

  return task.depends_on.filter((dependencyId) => {
    const dependency = taskLookup.get(dependencyId);
    return !dependency || dependency.status !== "DONE";
  });
}

function isTaskClaimable(taskRecord, taskLookup) {
  const task = parseTaskRecord(taskRecord);
  return CLAIMABLE_TASK_STATUSES.includes(task.status) && getIncompleteDependencies(task, taskLookup).length === 0;
}

function createAssignmentReasonRecord({
  taskId,
  agentId,
  timestamp,
  reasonType = DEFAULT_REASON_TYPE,
  policyRef = DEFAULT_POLICY_REF,
  context = DEFAULT_ASSIGNMENT_CONTEXT,
}) {
  return parseAssignmentReason({
    id: `${taskId}:${agentId}:${timestamp}`,
    task_id: taskId,
    agent_id: agentId,
    reason_type: reasonType,
    policy_ref: policyRef,
    assigned_at: timestamp,
    context,
  });
}

function normalizeQueueForScheduling(queueItems, now) {
  return sortQueueItems(queueItems.map((queueItem) => releaseExpiredClaim(queueItem, now)));
}

function selectNextReadyQueueItem({ queueItems, tasks, now }) {
  const timestamp = toIsoTimestamp(now, "now");
  const normalizedQueueItems = normalizeQueueForScheduling(queueItems, timestamp);
  const taskLookup = buildTaskLookup(tasks);
  const skipped = [];

  for (const queueItem of normalizedQueueItems) {
    const task = taskLookup.get(queueItem.task_id);

    if (!task) {
      skipped.push({
        task_id: queueItem.task_id,
        reason: "TASK_NOT_FOUND",
      });
      continue;
    }

    if (queueItem.status === "CLAIMED") {
      skipped.push({
        task_id: queueItem.task_id,
        reason: "ALREADY_CLAIMED",
      });
      continue;
    }

    if (!CLAIMABLE_TASK_STATUSES.includes(task.status)) {
      skipped.push({
        task_id: queueItem.task_id,
        reason: "TASK_NOT_CLAIMABLE",
        task_status: task.status,
      });
      continue;
    }

    const incompleteDependencies = getIncompleteDependencies(task, taskLookup);

    if (incompleteDependencies.length > 0) {
      skipped.push({
        task_id: queueItem.task_id,
        reason: "DEPENDENCIES_PENDING",
        dependencies: incompleteDependencies,
      });
      continue;
    }

    return {
      queueItems: normalizedQueueItems,
      queueItem,
      skipped,
      task,
      timestamp,
    };
  }

  return {
    queueItems: normalizedQueueItems,
    queueItem: null,
    skipped,
    task: null,
    timestamp,
  };
}

function claimNextQueueItem({
  queueItems,
  tasks,
  agentId,
  now = new Date(),
  claimTtlMs = DEFAULT_CLAIM_TTL_MS,
  reasonType = DEFAULT_REASON_TYPE,
  policyRef = DEFAULT_POLICY_REF,
  context = DEFAULT_ASSIGNMENT_CONTEXT,
}) {
  if (!agentId) {
    throw new SchedulerError("claimNextQueueItem requires agentId");
  }

  const selection = selectNextReadyQueueItem({ queueItems, tasks, now });

  if (!selection.queueItem || !selection.task) {
    return {
      assignmentReason: null,
      claimed: null,
      queueItems: selection.queueItems,
      skipped: selection.skipped,
    };
  }

  const claimedQueueItem = claimQueueItem(selection.queueItem, {
    claimedBy: agentId,
    claimExpiresAt: addMilliseconds(selection.timestamp, claimTtlMs),
  });

  const updatedQueueItems = selection.queueItems.map((queueItem) =>
    queueItem.task_id === claimedQueueItem.task_id ? claimedQueueItem : queueItem,
  );

  const assignmentReason = createAssignmentReasonRecord({
    taskId: selection.task.id,
    agentId,
    timestamp: selection.timestamp,
    reasonType,
    policyRef,
    context,
  });

  return {
    assignmentReason,
    claimed: {
      queueItem: claimedQueueItem,
      task: selection.task,
    },
    queueItems: updatedQueueItems,
    skipped: selection.skipped,
  };
}

export {
  CLAIMABLE_TASK_STATUSES,
  DEFAULT_ASSIGNMENT_CONTEXT,
  DEFAULT_CLAIM_TTL_MS,
  DEFAULT_POLICY_REF,
  DEFAULT_REASON_TYPE,
  SchedulerError,
  buildTaskLookup,
  claimNextQueueItem,
  createAssignmentReasonRecord,
  getIncompleteDependencies,
  isTaskClaimable,
  normalizeQueueForScheduling,
  selectNextReadyQueueItem,
};
