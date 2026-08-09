import test from "node:test";
import assert from "node:assert/strict";

import {
  createQueueItem,
  normalizeTaskSourceRecord,
  sortQueueItems,
} from "./queue.js";
import { claimNextQueueItem, selectNextReadyQueueItem } from "./scheduler.js";

test("sortQueueItems uses deterministic priority, queued_at, and task_id ordering", () => {
  const queueItems = [
    createQueueItem({
      taskId: "task-z",
      priority: null,
      queuedAt: "2026-03-21T09:00:00Z",
    }),
    createQueueItem({
      taskId: "task-b",
      priority: 1,
      queuedAt: "2026-03-21T09:10:00Z",
    }),
    createQueueItem({
      taskId: "task-a",
      priority: 1,
      queuedAt: "2026-03-21T09:10:00Z",
    }),
    createQueueItem({
      taskId: "task-c",
      priority: 2,
      queuedAt: "2026-03-21T08:55:00Z",
    }),
  ];

  const orderedTaskIds = sortQueueItems(queueItems).map((queueItem) => queueItem.task_id);

  assert.deepEqual(orderedTaskIds, ["task-a", "task-b", "task-c", "task-z"]);
});

test("normalizeTaskSourceRecord lowercases states and labels and sanitizes identifiers", () => {
  const normalized = normalizeTaskSourceRecord({
    id: "Feature / ABC-1 ",
    state: " IN_PROGRESS ",
    labels: ["Backend", " P1 ", "Backend"],
    priority: "3",
    created_at: "2026-03-21T09:00:00+01:00",
  });

  assert.deepEqual(normalized, {
    identifier: "Feature-ABC-1",
    state: "in_progress",
    labels: ["backend", "p1"],
    priority: 3,
    created_at: "2026-03-21T08:00:00.000Z",
  });
});

test("selectNextReadyQueueItem skips blocked dependencies and already claimed items", () => {
  const queueItems = [
    createQueueItem({
      taskId: "task-blocked",
      priority: 1,
      queuedAt: "2026-03-21T09:00:00Z",
    }),
    createQueueItem({
      taskId: "task-busy",
      priority: 1,
      queuedAt: "2026-03-21T09:01:00Z",
      claimedBy: "agent-busy",
      claimExpiresAt: "2026-03-21T09:10:00Z",
      status: "CLAIMED",
    }),
    createQueueItem({
      taskId: "task-ready",
      priority: 2,
      queuedAt: "2026-03-21T09:02:00Z",
    }),
  ];

  const tasks = [
    {
      id: "task-blocked",
      title: "Blocked task",
      status: "PENDING",
      phase: 2,
      priority: "high",
      goal_id: null,
      depends_on: ["dep-a"],
      assigned_to: null,
      out_of_scope: [],
      rejection_count: 0,
      max_rejections: 5,
      created_at: "2026-03-21T08:00:00Z",
      updated_at: "2026-03-21T08:00:00Z",
      transition_log: [],
    },
    {
      id: "task-busy",
      title: "Busy task",
      status: "PENDING",
      phase: 2,
      priority: "high",
      goal_id: null,
      depends_on: [],
      assigned_to: null,
      out_of_scope: [],
      rejection_count: 0,
      max_rejections: 5,
      created_at: "2026-03-21T08:00:00Z",
      updated_at: "2026-03-21T08:00:00Z",
      transition_log: [],
    },
    {
      id: "task-ready",
      title: "Ready task",
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
    },
    {
      id: "dep-a",
      title: "Dependency",
      status: "IN_PROGRESS",
      phase: 2,
      priority: "critical",
      goal_id: null,
      depends_on: [],
      assigned_to: null,
      out_of_scope: [],
      rejection_count: 0,
      max_rejections: 5,
      created_at: "2026-03-21T08:00:00Z",
      updated_at: "2026-03-21T08:00:00Z",
      transition_log: [],
    },
  ];

  const selection = selectNextReadyQueueItem({
    queueItems,
    tasks,
    now: "2026-03-21T09:05:00Z",
  });

  assert.equal(selection.queueItem?.task_id, "task-ready");
  assert.deepEqual(selection.skipped, [
    {
      task_id: "task-blocked",
      reason: "DEPENDENCIES_PENDING",
      dependencies: ["dep-a"],
    },
    {
      task_id: "task-busy",
      reason: "ALREADY_CLAIMED",
    },
  ]);
});

test("claimNextQueueItem releases expired claims and records assignment reasons", () => {
  const queueItems = [
    createQueueItem({
      taskId: "task-expired",
      priority: 1,
      queuedAt: "2026-03-21T09:00:00Z",
      claimedBy: "agent-old",
      claimExpiresAt: "2026-03-21T09:01:00Z",
      status: "CLAIMED",
    }),
  ];

  const tasks = [
    {
      id: "task-expired",
      title: "Expired claim task",
      status: "PENDING",
      phase: 2,
      priority: "critical",
      goal_id: null,
      depends_on: [],
      assigned_to: null,
      out_of_scope: [],
      rejection_count: 0,
      max_rejections: 5,
      created_at: "2026-03-21T08:00:00Z",
      updated_at: "2026-03-21T08:00:00Z",
      transition_log: [],
    },
  ];

  const result = claimNextQueueItem({
    queueItems,
    tasks,
    agentId: "agent-new",
    now: "2026-03-21T09:05:00Z",
    claimTtlMs: 60_000,
    policyRef: "scheduler/tests",
    context: "unit test claim",
  });

  assert.equal(result.claimed?.queueItem.task_id, "task-expired");
  assert.equal(result.claimed?.queueItem.claimed_by, "agent-new");
  assert.equal(result.claimed?.queueItem.claim_expires_at, "2026-03-21T09:06:00.000Z");
  assert.equal(result.assignmentReason?.task_id, "task-expired");
  assert.equal(result.assignmentReason?.agent_id, "agent-new");
  assert.equal(result.assignmentReason?.policy_ref, "scheduler/tests");
  assert.equal(result.assignmentReason?.context, "unit test claim");
});
