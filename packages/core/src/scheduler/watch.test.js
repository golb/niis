import test from "node:test";
import assert from "node:assert/strict";

import { acquireTaskExecutionLock } from "./lock.js";
import {
  claimNextAutoPickup,
  createIngressRecord,
  createWatchConfig,
  reloadWatchConfig,
  runWatchLoopTick,
} from "./watch.js";

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

test("runWatchLoopTick polls task sources, creates ingress, enqueues tasks, and auto-claims by queue order", () => {
  const config = createWatchConfig({
    version: "watch-config/v1",
    autoPickupAgentId: "watch-agent",
    taskSources: [
      {
        id: "backlog",
        type: "backlog_file",
        wakeSource: "automation",
        poll: () => [
          {
            id: "task-b",
            state: "READY",
            priority: 2,
            detected_at: "2026-03-21T09:00:05Z",
          },
          {
            id: "task-a",
            state: "READY",
            priority: 1,
            detected_at: "2026-03-21T09:00:00Z",
          },
        ],
      },
    ],
  });

  const result = runWatchLoopTick({
    currentConfig: config,
    state: {},
    tasks: [
      createTask({ id: "task-a", priority: "high" }),
      createTask({ id: "task-b", priority: "medium" }),
    ],
    leases: [],
    now: "2026-03-21T09:00:10Z",
  });

  assert.equal(result.state.ingressRecords.length, 2);
  assert.equal(result.state.wakeRecords.length, 2);
  assert.equal(result.claimResult.claimed?.task.id, "task-a");
  assert.equal(result.claimResult.assignmentReason?.agent_id, "watch-agent");
  assert.deepEqual(
    result.state.ingressRecords.map((ingressRecord) => `${ingressRecord.source_ref}:${ingressRecord.ingress_status}`),
    ["task:task-b:QUEUED", "task:task-a:CLAIMED"],
  );
});

test("claimNextAutoPickup skips authority-, cooldown-, and approval-blocked candidates before claiming the next eligible task", () => {
  const queueItems = [
    {
      task_id: "task-a",
      priority: 1,
      queued_at: "2026-03-21T09:00:00Z",
      claimed_by: null,
      claim_expires_at: null,
      status: "QUEUED",
    },
    {
      task_id: "task-b",
      priority: 2,
      queued_at: "2026-03-21T09:00:01Z",
      claimed_by: null,
      claim_expires_at: null,
      status: "QUEUED",
    },
    {
      task_id: "task-c",
      priority: 3,
      queued_at: "2026-03-21T09:00:02Z",
      claimed_by: null,
      claim_expires_at: null,
      status: "QUEUED",
    },
    {
      task_id: "task-d",
      priority: 4,
      queued_at: "2026-03-21T09:00:03Z",
      claimed_by: null,
      claim_expires_at: null,
      status: "QUEUED",
    },
  ];

  const ingressRecords = [
    createIngressRecord({
      taskId: "task-a",
      sourceType: "backlog_file",
      sourceRef: "task:task-a",
      detectedAt: "2026-03-21T09:00:00Z",
      authorityConstraints: ["repo.write"],
      approvalsRequired: [],
      ingressStatus: "QUEUED",
    }),
    createIngressRecord({
      taskId: "task-b",
      sourceType: "backlog_file",
      sourceRef: "task:task-b",
      detectedAt: "2026-03-21T09:00:01Z",
      authorityConstraints: [],
      approvalsRequired: ["release"],
      ingressStatus: "QUEUED",
    }),
    createIngressRecord({
      taskId: "task-c",
      sourceType: "backlog_file",
      sourceRef: "task:task-c",
      detectedAt: "2026-03-21T09:00:02Z",
      authorityConstraints: [],
      approvalsRequired: [],
      ingressStatus: "QUEUED",
    }),
  ];

  const result = claimNextAutoPickup({
    queueItems,
    tasks: [
      createTask({ id: "task-a" }),
      createTask({ id: "task-b" }),
      createTask({ id: "task-c" }),
      createTask({ id: "task-d" }),
    ],
    leases: [],
    ingressRecords,
    agentId: "watch-agent",
    now: "2026-03-21T09:01:00Z",
    grantedAuthorities: [],
    grantedApprovals: [],
    cooldownsByTaskId: {
      "task-c": "2026-03-21T09:05:00Z",
    },
  });

  assert.equal(result.claimed?.task.id, "task-d");
  assert.deepEqual(
    result.skipped.map((entry) => [entry.task_id, entry.reason]),
    [
      ["task-a", "AUTHORITY_DENIED"],
      ["task-b", "APPROVALS_PENDING"],
      ["task-c", "COOLDOWN_ACTIVE"],
    ],
  );
});

test("runWatchLoopTick defers locked tasks, leaves approval-blocked tasks unqueued, and claims the next eligible item", () => {
  const config = createWatchConfig({
    version: "watch-config/v1",
    autoPickupAgentId: "watch-agent",
    taskSources: [
      {
        id: "backlog",
        type: "backlog_file",
        wakeSource: "automation",
        routeTask(detection) {
          if (detection.normalized.identifier === "task-needs-approval") {
            return {
              routeCandidate: "writer",
              approvalsRequired: ["deploy"],
              authorityConstraints: [],
            };
          }

          return {
            routeCandidate: "writer",
            approvalsRequired: [],
            authorityConstraints: [],
          };
        },
        poll: () => [
          {
            id: "task-locked",
            state: "READY",
            priority: 1,
            detected_at: "2026-03-21T09:00:00Z",
          },
          {
            id: "task-needs-approval",
            state: "READY",
            priority: 2,
            detected_at: "2026-03-21T09:00:01Z",
          },
          {
            id: "task-open",
            state: "READY",
            priority: 3,
            detected_at: "2026-03-21T09:00:02Z",
          },
        ],
      },
    ],
  });

  const tasks = [
    createTask({ id: "task-locked" }),
    createTask({ id: "task-needs-approval" }),
    createTask({ id: "task-open" }),
  ];
  const locked = acquireTaskExecutionLock({
    leases: [],
    tasks,
    taskId: "task-locked",
    holder: "agent-a",
    ttlMs: 60_000,
    now: "2026-03-21T09:00:00Z",
  });

  const result = runWatchLoopTick({
    currentConfig: config,
    state: {},
    tasks,
    leases: locked.leases,
    grantedApprovals: [],
    grantedAuthorities: [],
    now: "2026-03-21T09:00:05Z",
  });

  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].blocker_class, "LOCK_CONFLICT");
  assert.equal(result.state.deferredWakeups.length, 1);
  assert.equal(result.claimResult.claimed?.task.id, "task-open");
  assert.deepEqual(
    result.skipped.map((entry) => [entry.task_id, entry.reason]),
    [["task-needs-approval", "APPROVALS_PENDING"]],
  );
});

test("reloadWatchConfig keeps the last-known-good config and creates a blocker on invalid reload", () => {
  const currentConfig = createWatchConfig({
    version: "watch-config/v1",
    taskSources: [
      {
        id: "backlog",
        type: "backlog_file",
        poll: () => [],
      },
    ],
  });

  const reload = reloadWatchConfig({
    currentConfig,
    loadConfig: () => ({
      version: "watch-config/v2",
      taskSources: [
        {
          id: "broken",
          type: "backlog_file",
        },
      ],
    }),
    now: "2026-03-21T09:00:00Z",
  });

  assert.equal(reload.usedLastKnownGood, true);
  assert.equal(reload.config.version, "watch-config/v1");
  assert.equal(reload.blocker?.task_id, "runtime:watch");
  assert.equal(reload.blocker?.blocker_class, "ENV_BLOCK");
});
