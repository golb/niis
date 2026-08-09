import { parseTaskRecord, TASK_STATUSES } from "../schemas/task.js";

class TaskTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskTransitionError";
  }
}

const ALLOWED_TRANSITIONS = Object.freeze({
  PENDING: ["IN_PROGRESS", "BLOCKED"],
  IN_PROGRESS: ["IN_REVIEW", "BLOCKED"],
  IN_REVIEW: ["DONE", "REJECTED"],
  REJECTED: ["IN_PROGRESS"],
  BLOCKED: [],
  DONE: [],
});

function canTransition(fromStatus, toStatus) {
  return Boolean(ALLOWED_TRANSITIONS[fromStatus]?.includes(toStatus));
}

function createTransitionEntry({ timestamp, fromStatus, toStatus, actor, reason }) {
  return {
    timestamp,
    from_status: fromStatus,
    to_status: toStatus,
    actor,
    reason,
  };
}

function transitionTask(taskRecord, transition) {
  const task = parseTaskRecord(taskRecord);
  const {
    toStatus,
    actor,
    reason,
    timestamp,
    verdictClass = null,
    evidencePacketId = null,
  } = transition;

  if (!TASK_STATUSES.includes(toStatus)) {
    throw new TaskTransitionError(`Unknown target status: ${toStatus}`);
  }

  if (!timestamp || !actor || !reason) {
    throw new TaskTransitionError("Task transitions require timestamp, actor, and reason");
  }

  if (!canTransition(task.status, toStatus)) {
    throw new TaskTransitionError(`Invalid task transition: ${task.status} -> ${toStatus}`);
  }

  if (toStatus === "DONE") {
    if (verdictClass !== "PASS") {
      throw new TaskTransitionError("Completion requires verdict_class PASS");
    }

    if (!evidencePacketId) {
      throw new TaskTransitionError("Completion requires evidence_packet_id");
    }
  }

  const nextTask = {
    ...task,
    status: toStatus,
    updated_at: timestamp,
    transition_log: [
      ...task.transition_log,
      createTransitionEntry({
        timestamp,
        fromStatus: task.status,
        toStatus,
        actor,
        reason,
      }),
    ],
  };

  if (toStatus === "REJECTED") {
    const rejectionCount = task.rejection_count + 1;
    nextTask.rejection_count = rejectionCount;

    if (rejectionCount >= task.max_rejections) {
      nextTask.status = "BLOCKED";
      nextTask.transition_log = [
        ...nextTask.transition_log,
        createTransitionEntry({
          timestamp,
          fromStatus: "REJECTED",
          toStatus: "BLOCKED",
          actor: "system",
          reason: "max rejections reached",
        }),
      ];

      return {
        task: nextTask,
        blocker: {
          blocker_class: "MAX_REJECTIONS",
          reason: "Task exceeded max_rejections and was blocked.",
          next_action: "Redesign task scope or escalate before retrying.",
        },
      };
    }
  }

  return {
    task: nextTask,
    blocker: null,
  };
}

export {
  ALLOWED_TRANSITIONS,
  TaskTransitionError,
  canTransition,
  transitionTask,
};
