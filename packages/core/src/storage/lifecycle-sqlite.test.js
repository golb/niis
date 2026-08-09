import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  AttemptConcurrencyError,
  AttemptLeaseConflictError,
  ExecutionLeaseConflictError,
  createLifecycleSqliteStore,
  inspectLifecycleSchemaCompatibility,
  migrateLifecycleSqliteSchema,
} from "./lifecycle-sqlite.js";

function createTempDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-lifecycle-store-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return path.join(root, ".niis", "db", "niis-v1.sqlite");
}

async function seedPromotionArbitrationFixture(store, suffix) {
  const taskId = `task-promotion-arbitration-${suffix}`;
  const attemptId = `attempt-promotion-arbitration-${suffix}`;
  const projectHolder = `project-holder-${suffix}`;
  const attemptHolder = `cli-lifecycle:${process.pid}`;

  await store.executionLeases.acquire({
    scope: "project:execution",
    holder: projectHolder,
    pid: process.pid,
    now: "2026-07-23T10:00:00.000Z",
    ttlMs: 600_000,
  });
  await store.queue.enqueue({
    taskId,
    now: "2026-07-23T10:00:00.000Z",
  });
  await store.queue.claimNext({
    holder: projectHolder,
    now: "2026-07-23T10:00:01.000Z",
    ttlMs: 600_000,
  });
  const bound = await store.queue.bindAttempt({
    attemptId,
    engineVersion: "rc-1",
    holder: projectHolder,
    now: "2026-07-23T10:00:02.000Z",
    taskId,
    trigger: "serve",
  });
  let attempt = await store.attempts.acquireLease({
    attemptId: bound.attempt.id,
    holder: attemptHolder,
    now: "2026-07-23T10:00:03.000Z",
    ttlMs: 600_000,
  });
  const transitions = [
    {
      nextStage: "WORKSPACE_PREPARED",
      workspacePath: `/tmp/${attemptId}`,
    },
    { nextStage: "EXECUTED" },
    { nextStage: "GATES_RUN" },
    { nextStage: "REVIEWED", canonicalVerdict: "PASS" },
    { nextStage: "READY_TO_PROMOTE" },
  ];
  for (const [index, transition] of transitions.entries()) {
    attempt = await store.attempts.transition({
      attemptId,
      expectedStage: attempt.stage,
      expectedVersion: attempt.version,
      holder: attemptHolder,
      now: new Date(Date.parse("2026-07-23T10:00:04.000Z") + index * 1_000),
      ...transition,
    });
  }

  return {
    attempt,
    attemptHolder,
    projectHolder,
    taskId,
  };
}

test("lifecycle migration is additive, idempotent, and preserves the existing storage version", (t) => {
  const databasePath = createTempDatabase(t);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata (key, value) VALUES ('schema_version', '4');
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      goal_id TEXT,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  legacy.close();

  assert.equal(
    inspectLifecycleSchemaCompatibility({ databasePath }).status,
    "migration_required",
  );
  assert.equal(
    migrateLifecycleSqliteSchema({ databasePath }).status,
    "compatible",
  );
  assert.equal(
    migrateLifecycleSqliteSchema({ databasePath }).status,
    "compatible",
  );

  const reopened = new Database(databasePath, { readonly: true });
  assert.equal(
    reopened.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value,
    "4",
  );
  assert.equal(
    reopened.prepare("SELECT COUNT(*) AS count FROM tasks").get().count,
    0,
  );
  reopened.close();
});

test("writable open refuses a future lifecycle schema instead of downgrading it", (t) => {
  const databasePath = createTempDatabase(t);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const future = new Database(databasePath);
  future.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata (key, value)
    VALUES ('task_lifecycle_schema_version', '99');
  `);
  future.close();

  assert.equal(
    inspectLifecycleSchemaCompatibility({ databasePath }).status,
    "blocked",
  );
  assert.throws(
    () => createLifecycleSqliteStore({ databasePath }),
    /cannot be opened/,
  );

  const unchanged = new Database(databasePath, { readonly: true });
  assert.equal(
    unchanged.prepare(
      "SELECT value FROM metadata WHERE key = 'task_lifecycle_schema_version'",
    ).get().value,
    "99",
  );
  unchanged.close();
});

test("schema v1 upgrades add the execution lease surface without replacing lifecycle data", async (t) => {
  const databasePath = createTempDatabase(t);
  const seeded = createLifecycleSqliteStore({ databasePath });
  await seeded.queue.enqueue({
    taskId: "preserved-task",
    now: "2026-07-23T10:00:00.000Z",
  });
  seeded.close();

  const prior = new Database(databasePath);
  prior.exec(`
    DROP TABLE execution_leases;
    UPDATE metadata
    SET value = '1'
    WHERE key = 'task_lifecycle_schema_version';
  `);
  prior.close();

  const before = inspectLifecycleSchemaCompatibility({ databasePath });
  assert.equal(before.status, "migration_required");
  assert.ok(before.missing_tables.includes("execution_leases"));
  assert.equal(migrateLifecycleSqliteSchema({ databasePath }).status, "compatible");

  const reopened = createLifecycleSqliteStore({ databasePath, readonly: true });
  assert.equal((await reopened.queue.byTask("preserved-task")).state, "PENDING");
  assert.equal(
    await reopened.executionLeases.byScope("project:execution"),
    null,
  );
  reopened.close();
});

test("attempt store provides idempotent creation, CAS transitions, leases, and durable reopen", async (t) => {
  const databasePath = createTempDatabase(t);
  const store = createLifecycleSqliteStore({
    databasePath,
    idFactory: () => "fixed",
  });
  const created = await store.attempts.createOrResume({
    attemptId: "attempt-1",
    taskId: "task-1",
    trigger: "cli",
    engineVersion: "rc-1",
    now: "2026-07-23T10:00:00.000Z",
  });
  const resumed = await store.attempts.createOrResume({
    attemptId: "attempt-1",
    taskId: "task-1",
    trigger: "cli",
    engineVersion: "rc-1",
    now: "2026-07-23T10:00:01.000Z",
  });

  assert.deepEqual(resumed, created);

  await store.attempts.acquireLease({
    attemptId: created.id,
    holder: "worker-a",
    now: "2026-07-23T10:00:02.000Z",
    ttlMs: 10_000,
  });
  await assert.rejects(
    store.attempts.acquireLease({
      attemptId: created.id,
      holder: "worker-b",
      now: "2026-07-23T10:00:03.000Z",
      ttlMs: 10_000,
    }),
    AttemptLeaseConflictError,
  );
  const reclaimed = await store.attempts.acquireLease({
    attemptId: created.id,
    holder: "worker-b",
    now: "2026-07-23T10:00:13.000Z",
    ttlMs: 10_000,
  });
  assert.equal(reclaimed.lease_holder, "worker-b");
  await assert.rejects(
    store.attempts.heartbeat({
      attemptId: created.id,
      holder: "worker-a",
      now: "2026-07-23T10:00:14.000Z",
      ttlMs: 10_000,
    }),
    AttemptLeaseConflictError,
  );

  const prepared = await store.attempts.transition({
    attemptId: reclaimed.id,
    expectedStage: "CLAIMED",
    expectedVersion: reclaimed.version,
    nextStage: "WORKSPACE_PREPARED",
    holder: "worker-b",
    workspacePath: "/tmp/task-1",
    statePatch: { workspace: { clean: true } },
    now: "2026-07-23T10:00:15.000Z",
  });
  assert.equal(prepared.version, 1);
  assert.equal(prepared.workspace_path, "/tmp/task-1");

  await assert.rejects(
    store.attempts.transition({
      attemptId: prepared.id,
      expectedStage: "CLAIMED",
      expectedVersion: 0,
      nextStage: "WORKSPACE_PREPARED",
      holder: "worker-b",
      workspacePath: "/tmp/task-1",
      now: "2026-07-23T10:00:16.000Z",
    }),
    AttemptConcurrencyError,
  );
  store.close();

  const readonly = createLifecycleSqliteStore({ databasePath, readonly: true });
  assert.equal(
    (await readonly.attempts.byId("attempt-1")).stage,
    "WORKSPACE_PREPARED",
  );
  assert.deepEqual(
    (await readonly.attempts.list()).map((attempt) => attempt.id),
    ["attempt-1"],
  );
  assert.equal(readonly.compatibility().status, "compatible");
  readonly.close();
});

test("a retry is a new durable attempt and cannot mutate the prior verdict", async (t) => {
  const databasePath = createTempDatabase(t);
  const store = createLifecycleSqliteStore({ databasePath });
  const original = await store.attempts.createOrResume({
    attemptId: "attempt-original",
    taskId: "task-retry",
    trigger: "cli",
    engineVersion: "rc-1",
    now: "2026-07-23T10:00:00.000Z",
  });
  const rejected = await store.attempts.transition({
    attemptId: original.id,
    canonicalVerdict: "DEFECT",
    expectedStage: original.stage,
    expectedVersion: original.version,
    lastError: "deterministic gate rejected the attempt",
    nextStage: "BLOCKED",
    now: "2026-07-23T10:00:01.000Z",
    statePatch: {
      review: {
        canonical_verdict: "DEFECT",
        reason: "focused immutable-verdict fixture",
      },
    },
  });
  const originalSnapshot = structuredClone(rejected);

  const retry = await store.attempts.createOrResume({
    attemptId: "attempt-retry-1",
    taskId: "task-retry",
    trigger: "ui-retry",
    engineVersion: "rc-1",
    now: "2026-07-23T10:00:02.000Z",
  });

  assert.equal(retry.stage, "CLAIMED");
  assert.equal(retry.canonical_verdict, null);
  assert.notEqual(retry.id, rejected.id);
  assert.deepEqual(
    await store.attempts.byId(rejected.id),
    originalSnapshot,
    "creating a retry must leave the original terminal attempt byte-for-byte unchanged",
  );
  assert.deepEqual(
    (await store.attempts.listByTask("task-retry")).map((attempt) => ({
      id: attempt.id,
      stage: attempt.stage,
      verdict: attempt.canonical_verdict,
    })),
    [
      { id: "attempt-original", stage: "BLOCKED", verdict: "DEFECT" },
      { id: "attempt-retry-1", stage: "CLAIMED", verdict: null },
    ],
  );
  store.close();
});

test("execution leases are durable, heartbeatable, owner-bound, and releasable", async (t) => {
  const databasePath = createTempDatabase(t);
  const store = createLifecycleSqliteStore({ databasePath });
  const acquired = await store.executionLeases.acquire({
    scope: "project:execution",
    holder: "serve-a",
    pid: process.pid,
    metadata: { trigger: "serve" },
    now: "2026-07-23T10:00:00.000Z",
    ttlMs: 10_000,
  });

  assert.equal(acquired.scope, "project:execution");
  assert.equal(acquired.holder, "serve-a");
  assert.equal(acquired.pid, process.pid);
  assert.deepEqual(acquired.metadata, { trigger: "serve" });
  assert.deepEqual(
    await store.executionLeases.byScope("project:execution"),
    acquired,
  );
  await assert.rejects(
    store.executionLeases.acquire({
      scope: "project:execution",
      holder: "serve-a",
      pid: process.pid,
      now: "2026-07-23T10:00:01.000Z",
      ttlMs: 10_000,
    }),
    ExecutionLeaseConflictError,
    "a duplicate caller cannot treat the holder identity as a reentrant lock",
  );

  const heartbeated = await store.executionLeases.heartbeat({
    scope: "project:execution",
    holder: "serve-a",
    pid: process.pid,
    now: "2026-07-23T10:00:20.000Z",
    ttlMs: 10_000,
  });
  assert.equal(
    heartbeated.expires_at,
    "2026-07-23T10:00:30.000Z",
    "the owning process can recover from an event-loop stall after TTL",
  );
  assert.equal(heartbeated.version, acquired.version + 1);

  assert.equal(await store.executionLeases.release({
    scope: "project:execution",
    holder: "another-holder",
    pid: process.pid,
  }), false);
  assert.ok(await store.executionLeases.byScope("project:execution"));
  assert.equal(await store.executionLeases.release({
    scope: "project:execution",
    holder: "serve-a",
    pid: process.pid,
  }), true);
  assert.equal(await store.executionLeases.byScope("project:execution"), null);
  store.close();
});

test("expired execution lease stays exclusive while its PID is alive or unknown", async (t) => {
  const databasePath = createTempDatabase(t);
  const liveness = new Map([
    [1101, "alive"],
    [1102, "unknown"],
  ]);
  const store = createLifecycleSqliteStore({
    databasePath,
    pidInspector: (pid) => liveness.get(pid) ?? "dead",
  });
  await store.executionLeases.acquire({
    scope: "project:execution",
    holder: "live-holder",
    pid: 1101,
    now: "2026-07-23T10:00:00.000Z",
    ttlMs: 1_000,
  });

  await assert.rejects(
    store.executionLeases.acquire({
      scope: "project:execution",
      holder: "contender",
      pid: 2201,
      now: "2026-07-23T10:00:02.000Z",
      ttlMs: 1_000,
    }),
    (error) =>
      error instanceof ExecutionLeaseConflictError
      && error.reason === "owner_alive",
  );

  liveness.set(1101, "dead");
  const reclaimed = await store.executionLeases.acquire({
    scope: "project:execution",
    holder: "unknown-holder",
    pid: 1102,
    now: "2026-07-23T10:00:02.000Z",
    ttlMs: 1_000,
  });
  assert.equal(reclaimed.holder, "unknown-holder");

  await assert.rejects(
    store.executionLeases.acquire({
      scope: "project:execution",
      holder: "second-contender",
      pid: 2202,
      now: "2026-07-23T10:00:04.000Z",
      ttlMs: 1_000,
    }),
    (error) =>
      error instanceof ExecutionLeaseConflictError
      && error.reason === "owner_liveness_unknown",
  );
  store.close();
});

test("execution lease handoff atomically transfers PID ownership to a live supervised child", async (t) => {
  const databasePath = createTempDatabase(t);
  const liveness = new Map([
    [3101, "alive"],
    [3102, "alive"],
    [3103, "dead"],
  ]);
  const store = createLifecycleSqliteStore({
    databasePath,
    pidInspector: (pid) => liveness.get(pid) ?? "unknown",
  });
  await store.executionLeases.acquire({
    scope: "project:execution",
    holder: "ui-supervisor",
    pid: 3101,
    now: "2026-07-23T10:00:00.000Z",
    ttlMs: 10_000,
  });

  const handedOff = await store.executionLeases.handoff({
    scope: "project:execution",
    holder: "ui-supervisor",
    fromPid: 3101,
    toPid: 3102,
    now: "2026-07-23T10:00:01.000Z",
    ttlMs: 10_000,
  });
  assert.equal(handedOff.pid, 3102);
  const repeatedHandoff = await store.executionLeases.handoff({
    scope: "project:execution",
    holder: "ui-supervisor",
    fromPid: 3101,
    toPid: 3102,
    now: "2026-07-23T10:00:01.500Z",
    ttlMs: 10_000,
  });
  assert.equal(repeatedHandoff.pid, 3102);
  assert.equal(repeatedHandoff.version, handedOff.version);
  await assert.rejects(
    store.executionLeases.heartbeat({
      scope: "project:execution",
      holder: "ui-supervisor",
      pid: 3101,
      now: "2026-07-23T10:00:02.000Z",
      ttlMs: 10_000,
    }),
    (error) =>
      error instanceof ExecutionLeaseConflictError
      && error.reason === "owner_mismatch",
  );
  const liveHeartbeat = await store.executionLeases.heartbeat({
    scope: "project:execution",
    holder: "ui-supervisor",
    pid: 3102,
    now: "2026-07-23T10:00:02.000Z",
    ttlMs: 10_000,
  });
  assert.equal(liveHeartbeat.pid, 3102);
  liveness.set(3102, "dead");
  await assert.rejects(
    store.executionLeases.heartbeat({
      scope: "project:execution",
      holder: "ui-supervisor",
      pid: 3102,
      now: "2026-07-23T10:00:03.000Z",
      ttlMs: 10_000,
    }),
    (error) =>
      error instanceof ExecutionLeaseConflictError
      && error.reason === "heartbeat_owner_dead",
  );
  assert.equal(
    (await store.executionLeases.byScope("project:execution")).expires_at,
    liveHeartbeat.expires_at,
    "a dead owner heartbeat must not extend the lease",
  );

  await assert.rejects(
    store.executionLeases.handoff({
      scope: "project:execution",
      holder: "ui-supervisor",
      fromPid: 3102,
      toPid: 3103,
      now: "2026-07-23T10:00:03.000Z",
      ttlMs: 10_000,
    }),
    (error) =>
      error instanceof ExecutionLeaseConflictError
      && error.reason === "handoff_target_dead",
  );
  assert.equal(
    (await store.executionLeases.byScope("project:execution")).pid,
    3102,
  );
  store.close();
});

test("two SQLite connections atomically serialize project execution lease acquisition", async (t) => {
  const databasePath = createTempDatabase(t);
  const first = createLifecycleSqliteStore({ databasePath });
  const second = createLifecycleSqliteStore({ databasePath });

  const outcomes = await Promise.allSettled([
    first.executionLeases.acquire({
      scope: "project:execution",
      holder: "first",
      pid: process.pid,
    }),
    second.executionLeases.acquire({
      scope: "project:execution",
      holder: "second",
      pid: process.pid,
    }),
  ]);

  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected.reason instanceof ExecutionLeaseConflictError);
  first.close();
  second.close();
});

test("two SQLite connections atomically arbitrate cancellation against promotion", async (t) => {
  const cancelFirstPath = createTempDatabase(t);
  const cancelFirst = createLifecycleSqliteStore({ databasePath: cancelFirstPath });
  const cancelFirstContender = createLifecycleSqliteStore({
    databasePath: cancelFirstPath,
  });
  const firstFixture = await seedPromotionArbitrationFixture(
    cancelFirst,
    "cancel-first",
  );

  const cancelFirstOutcomes = await Promise.allSettled([
    cancelFirst.queue.requestCancellation({
      attemptHolder: firstFixture.attemptHolder,
      executionLeaseHolder: firstFixture.projectHolder,
      executionLeasePid: process.pid,
      executionLeaseScope: "project:execution",
      requestId: "cancel:cancel-first",
      requestedBy: "test:operator",
      taskId: firstFixture.taskId,
      now: "2026-07-23T10:00:10.000Z",
    }),
    cancelFirstContender.promotions.prepare({
      attemptId: firstFixture.attempt.id,
      now: "2026-07-23T10:00:10.000Z",
    }),
  ]);
  assert.equal(cancelFirstOutcomes[0].status, "fulfilled");
  assert.equal(cancelFirstOutcomes[1].status, "rejected");
  assert.equal(
    cancelFirstOutcomes[1].reason.code,
    "promotion_blocked_by_cancellation",
  );
  assert.equal(
    (await cancelFirst.queue.byTask(firstFixture.taskId))
      .payload.cancel_request.status,
    "REQUESTED",
  );
  assert.equal(
    await cancelFirst.promotions.byAttempt(firstFixture.attempt.id),
    null,
  );
  cancelFirstContender.close();
  cancelFirst.close();

  const promotionFirstPath = createTempDatabase(t);
  const promotionFirst = createLifecycleSqliteStore({
    databasePath: promotionFirstPath,
  });
  const promotionFirstContender = createLifecycleSqliteStore({
    databasePath: promotionFirstPath,
  });
  const secondFixture = await seedPromotionArbitrationFixture(
    promotionFirst,
    "promotion-first",
  );

  const promotionPromise = promotionFirst.promotions.prepare({
    attemptId: secondFixture.attempt.id,
    now: "2026-07-23T10:00:10.000Z",
  });
  const cancellationPromise = promotionFirstContender.queue.requestCancellation({
    attemptHolder: secondFixture.attemptHolder,
    executionLeaseHolder: secondFixture.projectHolder,
    executionLeasePid: process.pid,
    executionLeaseScope: "project:execution",
    requestId: "cancel:promotion-first",
    requestedBy: "test:operator",
    taskId: secondFixture.taskId,
    now: "2026-07-23T10:00:10.000Z",
  });
  const promotionFirstOutcomes = await Promise.allSettled([
    promotionPromise,
    cancellationPromise,
  ]);
  assert.equal(promotionFirstOutcomes[0].status, "fulfilled");
  assert.equal(promotionFirstOutcomes[1].status, "rejected");
  assert.equal(
    promotionFirstOutcomes[1].reason.code,
    "cancellation_after_promotion_started",
  );
  assert.equal(
    (await promotionFirst.queue.byTask(secondFixture.taskId))
      .payload.cancel_request,
    undefined,
  );
  assert.equal(
    (await promotionFirst.promotions.byAttempt(secondFixture.attempt.id)).status,
    "PENDING",
  );
  promotionFirstContender.close();
  promotionFirst.close();
});

test("authoritative queue mutations and projection outbox commit atomically", async (t) => {
  const databasePath = createTempDatabase(t);
  let sequence = 0;
  const store = createLifecycleSqliteStore({
    databasePath,
    idFactory: () => String(++sequence),
  });
  const queued = await store.queue.enqueue({
    taskId: "task-low",
    priority: 10,
    payload: { source: "test" },
    now: "2026-07-23T10:00:00.000Z",
  });
  await store.queue.enqueue({
    taskId: "task-high",
    priority: 1,
    now: "2026-07-23T10:00:01.000Z",
  });
  const claimed = await store.queue.claimNext({
    holder: "scheduler-1",
    now: "2026-07-23T10:00:02.000Z",
    ttlMs: 10_000,
  });

  assert.equal(queued.state, "PENDING");
  assert.equal(claimed.task_id, "task-high");
  assert.equal(claimed.state, "CLAIMED");
  assert.equal((await store.outbox.listPending()).length, 3);
  assert.deepEqual(
    (await store.outbox.list()).map((event) => event.sequence_id),
    [1, 2, 3],
  );

  const completed = await store.queue.transition({
    taskId: claimed.task_id,
    expectedState: "CLAIMED",
    nextState: "COMPLETED",
    holder: "scheduler-1",
    now: "2026-07-23T10:00:03.000Z",
  });
  assert.equal(completed.claimed_by, null);
  assert.equal((await store.outbox.listPending()).length, 4);
  assert.equal((await store.outbox.list()).at(-1).operation, "UPSERT");
  store.close();
});

test("a claimed queue item durably binds one attempt before execution", async (t) => {
  const databasePath = createTempDatabase(t);
  const store = createLifecycleSqliteStore({ databasePath });
  await store.queue.enqueue({
    taskId: "task-bound",
    now: "2026-07-23T10:00:00.000Z",
  });
  await store.queue.claimNext({
    holder: "scheduler-a",
    now: "2026-07-23T10:00:01.000Z",
    ttlMs: 1_000,
  });

  const first = await store.queue.bindAttempt({
    attemptId: "attempt-bound",
    engineVersion: "rc-1",
    holder: "scheduler-a",
    now: "2026-07-23T10:00:01.100Z",
    taskId: "task-bound",
    trigger: "serve",
  });
  assert.equal(first.newly_bound, true);
  assert.equal(first.entry.payload.attempt_id, "attempt-bound");
  assert.equal(first.attempt.stage, "CLAIMED");

  const reclaimed = await store.queue.claimNext({
    holder: "scheduler-b",
    now: "2026-07-23T10:00:02.100Z",
    ttlMs: 1_000,
  });
  assert.equal(reclaimed.payload.attempt_id, "attempt-bound");
  const resumed = await store.queue.bindAttempt({
    engineVersion: "rc-1",
    holder: "scheduler-b",
    now: "2026-07-23T10:00:02.200Z",
    taskId: "task-bound",
    trigger: "serve",
  });
  assert.equal(resumed.newly_bound, false);
  assert.equal(resumed.attempt.id, "attempt-bound");
  assert.equal((await store.attempts.listByTask("task-bound")).length, 1);
  store.close();
});

test("queue removal atomically refuses claims and active attempts", async (t) => {
  const databasePath = createTempDatabase(t);
  const store = createLifecycleSqliteStore({ databasePath });
  await store.queue.enqueue({
    taskId: "task-delete-guard",
    now: "2026-07-23T10:00:00.000Z",
  });
  await store.queue.claimNext({
    holder: "scheduler-a",
    now: "2026-07-23T10:00:01.000Z",
    ttlMs: 60_000,
  });

  await assert.rejects(
    store.queue.remove({
      taskId: "task-delete-guard",
      now: "2026-07-23T10:00:02.000Z",
    }),
    (error) => error instanceof AttemptLeaseConflictError,
  );
  const bound = await store.queue.bindAttempt({
    attemptId: "attempt-delete-guard",
    engineVersion: "rc-1",
    holder: "scheduler-a",
    now: "2026-07-23T10:00:02.000Z",
    taskId: "task-delete-guard",
    trigger: "serve",
  });
  await store.queue.transition({
    expectedState: "CLAIMED",
    holder: "scheduler-a",
    nextState: "CANCELLED",
    now: "2026-07-23T10:00:03.000Z",
    taskId: "task-delete-guard",
  });

  await assert.rejects(
    store.queue.remove({
      taskId: "task-delete-guard",
      now: "2026-07-23T10:00:04.000Z",
    }),
    (error) => error instanceof AttemptConcurrencyError,
  );
  assert.equal(
    (await store.queue.byTask("task-delete-guard")).state,
    "CANCELLED",
  );
  assert.equal(
    (await store.attempts.byId(bound.attempt.id)).stage,
    "CLAIMED",
  );
  store.close();
});

test("two SQLite connections cannot claim the same queue item", async (t) => {
  const databasePath = createTempDatabase(t);
  let sequence = 0;
  const first = createLifecycleSqliteStore({
    databasePath,
    idFactory: () => `first-${++sequence}`,
  });
  const second = createLifecycleSqliteStore({
    databasePath,
    idFactory: () => `second-${++sequence}`,
  });
  await first.queue.enqueue({
    taskId: "task-once",
    now: "2026-07-23T10:00:00.000Z",
  });

  const [left, right] = await Promise.all([
    first.queue.claimNext({
      holder: "scheduler-a",
      now: "2026-07-23T10:00:01.000Z",
      ttlMs: 10_000,
    }),
    second.queue.claimNext({
      holder: "scheduler-b",
      now: "2026-07-23T10:00:01.000Z",
      ttlMs: 10_000,
    }),
  ]);

  assert.equal([left, right].filter(Boolean).length, 1);
  assert.equal((left ?? right).task_id, "task-once");
  first.close();
  second.close();
});

test("external mutations cannot cancel active attempt or queue leases", async (t) => {
  const databasePath = createTempDatabase(t);
  const store = createLifecycleSqliteStore({ databasePath });
  const attempt = await store.attempts.createOrResume({
    attemptId: "attempt-active",
    engineVersion: "rc-1",
    taskId: "task-active",
    trigger: "serve",
    now: "2026-07-23T10:00:00.000Z",
  });
  const leased = await store.attempts.acquireLease({
    attemptId: attempt.id,
    holder: "executor",
    now: "2026-07-23T10:00:01.000Z",
    ttlMs: 10_000,
  });
  await assert.rejects(
    store.attempts.transition({
      attemptId: leased.id,
      expectedStage: leased.stage,
      expectedVersion: leased.version,
      nextStage: "CANCELLED",
      now: "2026-07-23T10:00:02.000Z",
    }),
    AttemptLeaseConflictError,
  );

  await store.queue.enqueue({
    taskId: "task-active",
    now: "2026-07-23T10:00:00.000Z",
  });
  await store.queue.claimNext({
    holder: "scheduler",
    now: "2026-07-23T10:00:01.000Z",
    ttlMs: 10_000,
  });
  await assert.rejects(
    store.queue.transition({
      expectedState: "CLAIMED",
      nextState: "CANCELLED",
      taskId: "task-active",
      now: "2026-07-23T10:00:02.000Z",
    }),
    AttemptLeaseConflictError,
  );
  store.close();
});
