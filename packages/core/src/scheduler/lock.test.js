import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireTaskExecutionLock,
  createConcurrencyPolicy,
  evaluateConcurrencyPolicy,
  registerExecutionTrigger,
  releaseTaskLock,
} from "./lock.js";

function createTask({
  id,
  status = "PENDING",
  priority = "medium",
  dependsOn = [],
}) {
  return {
    id,
    title: `Task ${id}`,
    status,
    phase: 2,
    priority,
    goal_id: null,
    depends_on: dependsOn,
    assigned_to: null,
    out_of_scope: [],
    rejection_count: 0,
    max_rejections: 5,
    created_at: "2026-03-21T08:00:00Z",
    updated_at: "2026-03-21T08:00:00Z",
    transition_log: [],
  };
}

test("acquireTaskExecutionLock acquires, renews, and reclaims expired leases", () => {
  const tasks = [createTask({ id: "task-1" })];

  const acquired = acquireTaskExecutionLock({
    leases: [],
    tasks,
    taskId: "task-1",
    holder: "agent-a",
    ttlMs: 60_000,
    now: "2026-03-21T09:00:00Z",
  });

  assert.equal(acquired.action, "acquired");
  assert.equal(acquired.lease?.holder, "agent-a");

  const renewed = acquireTaskExecutionLock({
    leases: acquired.leases,
    tasks,
    taskId: "task-1",
    holder: "agent-a",
    ttlMs: 60_000,
    now: "2026-03-21T09:00:30Z",
  });

  assert.equal(renewed.action, "renewed");
  assert.equal(renewed.lease?.expires_at, "2026-03-21T09:01:30.000Z");

  const reclaimed = acquireTaskExecutionLock({
    leases: renewed.leases,
    tasks,
    taskId: "task-1",
    holder: "agent-b",
    ttlMs: 60_000,
    now: "2026-03-21T09:02:00Z",
  });

  assert.equal(reclaimed.action, "acquired");
  assert.equal(reclaimed.lease?.holder, "agent-b");
});

test("acquireTaskExecutionLock returns LOCK_CONFLICT blocker for competing holder", () => {
  const tasks = [createTask({ id: "task-1" })];

  const acquired = acquireTaskExecutionLock({
    leases: [],
    tasks,
    taskId: "task-1",
    holder: "agent-a",
    ttlMs: 60_000,
    now: "2026-03-21T09:00:00Z",
  });

  const conflicted = acquireTaskExecutionLock({
    leases: acquired.leases,
    tasks,
    taskId: "task-1",
    holder: "agent-b",
    ttlMs: 60_000,
    now: "2026-03-21T09:00:30Z",
  });

  assert.equal(conflicted.action, "conflict");
  assert.equal(conflicted.blocker?.blocker_class, "LOCK_CONFLICT");
  assert.equal(conflicted.lease, null);
});

test("evaluateConcurrencyPolicy enforces global, agent, and state limits", () => {
  const tasks = [
    createTask({ id: "task-1", status: "PENDING" }),
    createTask({ id: "task-2", status: "PENDING" }),
    createTask({ id: "task-3", status: "IN_PROGRESS" }),
  ];

  const first = acquireTaskExecutionLock({
    leases: [],
    tasks,
    taskId: "task-1",
    holder: "agent-a",
    ttlMs: 60_000,
    now: "2026-03-21T09:00:00Z",
  });

  const second = acquireTaskExecutionLock({
    leases: first.leases,
    tasks,
    taskId: "task-3",
    holder: "agent-b",
    ttlMs: 60_000,
    now: "2026-03-21T09:00:10Z",
  });

  const globalPolicy = createConcurrencyPolicy({ globalLimit: 2 });
  const agentPolicy = createConcurrencyPolicy({ perAgentLimit: 1 });
  const statePolicy = createConcurrencyPolicy({ perStateThrottle: { PENDING: 1 } });

  const globalResult = evaluateConcurrencyPolicy({
    leases: second.leases,
    tasks,
    holder: "agent-c",
    candidateTaskId: "task-2",
    policy: globalPolicy,
    now: "2026-03-21T09:00:20Z",
  });

  const agentResult = evaluateConcurrencyPolicy({
    leases: second.leases,
    tasks,
    holder: "agent-a",
    candidateTaskId: "task-2",
    policy: agentPolicy,
    now: "2026-03-21T09:00:20Z",
  });

  const stateResult = evaluateConcurrencyPolicy({
    leases: second.leases,
    tasks,
    holder: "agent-c",
    candidateTaskId: "task-2",
    policy: statePolicy,
    now: "2026-03-21T09:00:20Z",
  });

  assert.deepEqual(
    [globalResult.reason, agentResult.reason, stateResult.reason],
    ["GLOBAL_LIMIT", "AGENT_LIMIT", "STATE_LIMIT"],
  );
});

test("registerExecutionTrigger coalesces queued triggers and defers locked triggers with traceability", () => {
  const queued = registerExecutionTrigger({
    queueItems: [],
    deferredWakeups: [],
    leases: [],
    taskId: "task-1",
    source: "assignment",
    context: { reason: "first enqueue" },
    now: "2026-03-21T09:00:00Z",
    priority: 3,
  });

  assert.equal(queued.disposition, "ENQUEUED");

  const coalescedQueue = registerExecutionTrigger({
    queueItems: queued.queueItems,
    deferredWakeups: [],
    leases: [],
    taskId: "task-1",
    source: "mention",
    context: { reason: "duplicate enqueue" },
    now: "2026-03-21T09:00:10Z",
    priority: 2,
  });

  assert.equal(coalescedQueue.disposition, "COALESCED_QUEUE");
  assert.equal(coalescedQueue.queueItems.length, 1);

  const tasks = [createTask({ id: "task-2" })];
  const locked = acquireTaskExecutionLock({
    leases: [],
    tasks,
    taskId: "task-2",
    holder: "agent-a",
    ttlMs: 60_000,
    now: "2026-03-21T09:00:00Z",
  });

  const firstDeferred = registerExecutionTrigger({
    queueItems: [],
    deferredWakeups: [],
    leases: locked.leases,
    taskId: "task-2",
    source: "retry",
    context: { attempt: 1 },
    now: "2026-03-21T09:00:05Z",
    priority: 5,
  });

  const secondDeferred = registerExecutionTrigger({
    queueItems: [],
    deferredWakeups: firstDeferred.deferredWakeups,
    leases: locked.leases,
    taskId: "task-2",
    source: "mention",
    context: { user: "synthetic-user" },
    now: "2026-03-21T09:00:06Z",
    priority: 1,
  });

  assert.equal(secondDeferred.disposition, "COALESCED_DEFERRED");
  assert.equal(secondDeferred.blocker?.blocker_class, "LOCK_CONFLICT");
  assert.equal(secondDeferred.deferredWakeup?.original_source, "retry");
  assert.deepEqual(secondDeferred.deferredWakeup?.original_context, { attempt: 1 });
  assert.equal(secondDeferred.deferredWakeup?.coalesced_count, 2);
  assert.equal(secondDeferred.deferredWakeup?.priority, 1);
});

test("releaseTaskLock promotes deferred wakeups back into the queue", () => {
  const tasks = [createTask({ id: "task-1" })];
  const locked = acquireTaskExecutionLock({
    leases: [],
    tasks,
    taskId: "task-1",
    holder: "agent-a",
    ttlMs: 60_000,
    now: "2026-03-21T09:00:00Z",
  });

  const deferred = registerExecutionTrigger({
    queueItems: [],
    deferredWakeups: [],
    leases: locked.leases,
    taskId: "task-1",
    source: "retry",
    context: { attempt: 1 },
    now: "2026-03-21T09:00:05Z",
    priority: 2,
  });

  const released = releaseTaskLock({
    leases: locked.leases,
    deferredWakeups: deferred.deferredWakeups,
    taskId: "task-1",
    holder: "agent-a",
    releasedAt: "2026-03-21T09:00:10Z",
  });

  assert.equal(released.releasedLease?.holder, "agent-a");
  assert.equal(released.promotedQueueItem?.task_id, "task-1");
  assert.equal(released.promotedQueueItem?.queued_at, "2026-03-21T09:00:05.000Z");
  assert.equal(released.promotedQueueItem?.priority, 2);
  assert.equal(released.deferredWakeup?.status, "PROMOTED");
});
