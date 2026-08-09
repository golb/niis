import { createHash } from "node:crypto";

import {
  DurableQueueState,
  QueueProjectionOperation,
  createQueueProjectionContentDigest,
  parseQueueProjectionEvent,
} from "../../core/src/scheduler/queue-projection.js";
import * as taskQueue from "../../core/src/runtime/task-queue.js";

const FILE_STATE_BY_DURABLE_STATE = Object.freeze({
  [DurableQueueState.PENDING]: "pending",
  [DurableQueueState.CLAIMED]: "in_progress",
  [DurableQueueState.BLOCKED]: "rejected",
  [DurableQueueState.COMPLETED]: "accepted",
  [DurableQueueState.FAILED]: "rejected",
  [DurableQueueState.CANCELLED]: "rejected",
});

const DURABLE_STATE_BY_FILE_STATE = Object.freeze({
  pending: DurableQueueState.PENDING,
  in_progress: DurableQueueState.CLAIMED,
  in_review: DurableQueueState.CLAIMED,
  accepted: DurableQueueState.COMPLETED,
  rejected: DurableQueueState.FAILED,
});

const FILE_PROJECTION_RESERVED_KEYS = new Set([
  "available_at",
  "claim_expires_at",
  "claimed_by",
  "created_at",
  "lifecycle_queue_content_digest",
  "lifecycle_queue_created_at",
  "lifecycle_queue_payload",
  "lifecycle_queue_state",
  "lifecycle_queue_updated_at",
  "lifecycle_queue_version",
  "priority",
  "projection_event_id",
  "task_id",
  "updated_at",
]);

function assertStateRoot(stateRoot) {
  if (typeof stateRoot !== "string" || stateRoot.trim() === "") {
    throw new Error("stateRoot is required");
  }
  return stateRoot;
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

function invalidProjectionDigest(value) {
  return createHash("sha256")
    .update(canonicalJson({ invalid_projection: value }))
    .digest("hex");
}

function jsonValuesEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function contentDigestForFileEntry(entry) {
  const data = entry?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return invalidProjectionDigest(data ?? null);
  }

  const nestedPayload = data.lifecycle_queue_payload;
  if (
    !nestedPayload
    || typeof nestedPayload !== "object"
    || Array.isArray(nestedPayload)
  ) {
    return invalidProjectionDigest(data);
  }

  const actualPayload = {};
  let materializationMatches = true;
  for (const [key, expectedValue] of Object.entries(nestedPayload)) {
    if (FILE_PROJECTION_RESERVED_KEYS.has(key)) {
      actualPayload[key] = expectedValue;
      continue;
    }
    if (!Object.hasOwn(data, key)) {
      materializationMatches = false;
      continue;
    }
    actualPayload[key] = data[key];
    if (!jsonValuesEqual(data[key], expectedValue)) {
      materializationMatches = false;
    }
  }
  for (const [key, value] of Object.entries(data)) {
    if (
      !FILE_PROJECTION_RESERVED_KEYS.has(key)
      && !Object.hasOwn(nestedPayload, key)
    ) {
      actualPayload[key] = value;
      materializationMatches = false;
    }
  }

  if (!materializationMatches) {
    return invalidProjectionDigest(data);
  }

  try {
    return createQueueProjectionContentDigest({
      available_at: data.available_at,
      claim_expires_at: data.claim_expires_at ?? null,
      claimed_by: data.claimed_by ?? null,
      created_at: data.lifecycle_queue_created_at,
      payload: actualPayload,
      priority: data.priority ?? null,
      state: data.lifecycle_queue_state,
      task_id: data.task_id,
      updated_at: data.lifecycle_queue_updated_at,
      version: data.lifecycle_queue_version,
    });
  } catch {
    return invalidProjectionDigest(data);
  }
}

function durableStateForFileEntry(entry) {
  const persisted = entry.data?.lifecycle_queue_state;
  if (
    typeof persisted === "string"
    && Object.values(DurableQueueState).includes(persisted)
    && FILE_STATE_BY_DURABLE_STATE[persisted] === entry.state
  ) {
    return persisted;
  }
  return DURABLE_STATE_BY_FILE_STATE[entry.state] ?? DurableQueueState.FAILED;
}

function durableVersionForFileEntry(entry) {
  const persisted = entry.data?.lifecycle_queue_version;
  return Number.isInteger(persisted) && persisted >= 0 ? persisted : 0;
}

function projectionMetadata(event) {
  const { entry } = event;
  return {
    ...entry.payload,
    available_at: entry.available_at,
    claim_expires_at: entry.claim_expires_at,
    claimed_by: entry.claimed_by,
    lifecycle_queue_content_digest:
      createQueueProjectionContentDigest(entry),
    lifecycle_queue_created_at: entry.created_at,
    lifecycle_queue_payload: entry.payload,
    lifecycle_queue_state: entry.state,
    lifecycle_queue_updated_at: entry.updated_at,
    lifecycle_queue_version: entry.version,
    priority: entry.priority ?? entry.payload?.priority ?? null,
    projection_event_id: event.event_id,
    task_id: entry.task_id,
  };
}

function createFileQueueProjection({ stateRoot } = {}) {
  const resolvedStateRoot = assertStateRoot(stateRoot);

  return Object.freeze({
    async snapshot() {
      const all = taskQueue.listAll({ stateRoot: resolvedStateRoot });
      return Object.values(all)
        .flat()
        .map((entry) => ({
          content_digest: contentDigestForFileEntry(entry),
          state: durableStateForFileEntry(entry),
          task_id: entry.task_id,
          version: durableVersionForFileEntry(entry),
        }));
    },

    async apply(rawEvent) {
      const event = parseQueueProjectionEvent(rawEvent);
      if (event.operation === QueueProjectionOperation.REMOVE) {
        return {
          operation: event.operation,
          removed: taskQueue.removeFromQueue({
            stateRoot: resolvedStateRoot,
            taskId: event.task_id,
          }),
          task_id: event.task_id,
        };
      }

      const targetState = FILE_STATE_BY_DURABLE_STATE[event.entry.state];
      const current = taskQueue.findTaskState({
        stateRoot: resolvedStateRoot,
        taskId: event.task_id,
      });
      const currentVersion = current
        ? durableVersionForFileEntry(current)
        : -1;

      if (currentVersion > event.entry.version) {
        throw new Error(
          `file queue projection for ${event.task_id} is ahead of outbox event `
          + `${event.entry.version} at version ${currentVersion}`,
        );
      }
      if (
        current
        && currentVersion === event.entry.version
        && durableStateForFileEntry(current) === event.entry.state
        && current.state === targetState
        && contentDigestForFileEntry(current)
          === createQueueProjectionContentDigest(event.entry)
      ) {
        return {
          idempotent: true,
          operation: event.operation,
          task_id: event.task_id,
        };
      }

      const metadata = projectionMetadata(event);
      if (current) {
        taskQueue.removeFromQueue({
          stateRoot: resolvedStateRoot,
          taskId: event.task_id,
        });
      }
      const result = taskQueue.enqueueTask({
        metadata,
        state: targetState,
        stateRoot: resolvedStateRoot,
        taskId: event.task_id,
      });

      return {
        operation: event.operation,
        result,
        task_id: event.task_id,
      };
    },
  });
}

export {
  DURABLE_STATE_BY_FILE_STATE,
  FILE_STATE_BY_DURABLE_STATE,
  contentDigestForFileEntry,
  createFileQueueProjection,
  durableStateForFileEntry,
  durableVersionForFileEntry,
};
