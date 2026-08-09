import test from "node:test";
import assert from "node:assert/strict";

import { acquireTaskExecutionLock } from "./lock.js";
import { listWakeSourcesForTask, registerTaskWake } from "./wake.js";

function createTask(id) {
  return {
    id,
    title: `Task ${id}`,
    status: "PENDING",
    phase: 2,
    priority: "medium",
    goal_id: null,
    depends_on: [],
    assigned_to: null,
    out_of_scope: [],
    rejection_count: 0,
    max_rejections: 5,
    created_at: "2026-03-21T08:00:00Z",
    updated_at: "2026-03-21T08:00:00Z",
    transition_log: [],
  };
}

test("registerTaskWake records wake sources for queued and coalesced queue triggers", () => {
  const first = registerTaskWake({
    wakeRecords: [],
    queueItems: [],
    deferredWakeups: [],
    leases: [],
    taskId: "task-1",
    source: "automation",
    context: { source: "watch" },
    now: "2026-03-21T09:00:00Z",
    priority: 2,
  });

  const second = registerTaskWake({
    wakeRecords: first.wakeRecords,
    queueItems: first.queueItems,
    deferredWakeups: first.deferredWakeups,
    leases: [],
    taskId: "task-1",
    source: "mention",
    context: { user: "synthetic-user" },
    now: "2026-03-21T09:00:02Z",
    priority: 1,
  });

  assert.equal(first.wakeRecord.disposition, "ENQUEUED");
  assert.equal(second.wakeRecord.disposition, "COALESCED_QUEUE");
  assert.deepEqual(listWakeSourcesForTask(second.wakeRecords, "task-1"), ["automation", "mention"]);
});

test("registerTaskWake records deferred and coalesced-deferred wake sources behind an active lease", () => {
  const tasks = [createTask("task-2")];
  const locked = acquireTaskExecutionLock({
    leases: [],
    tasks,
    taskId: "task-2",
    holder: "agent-a",
    ttlMs: 60_000,
    now: "2026-03-21T09:00:00Z",
  });

  const first = registerTaskWake({
    wakeRecords: [],
    queueItems: [],
    deferredWakeups: [],
    leases: locked.leases,
    taskId: "task-2",
    source: "timer",
    context: { tick: 1 },
    now: "2026-03-21T09:00:05Z",
    priority: 2,
  });

  const second = registerTaskWake({
    wakeRecords: first.wakeRecords,
    queueItems: first.queueItems,
    deferredWakeups: first.deferredWakeups,
    leases: locked.leases,
    taskId: "task-2",
    source: "assignment",
    context: { by: "scheduler" },
    now: "2026-03-21T09:00:06Z",
    priority: 1,
  });

  assert.equal(first.wakeRecord.disposition, "DEFERRED");
  assert.equal(second.wakeRecord.disposition, "COALESCED_DEFERRED");
  assert.equal(second.deferredWakeup?.coalesced_count, 2);
  assert.deepEqual(listWakeSourcesForTask(second.wakeRecords, "task-2"), ["timer", "assignment"]);
});
