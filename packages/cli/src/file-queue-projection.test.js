import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  flushQueueProjectionOutbox,
  reconcileQueueProjection,
} from "../../core/src/scheduler/queue-projection.js";
import { createLifecycleSqliteStore } from "../../core/src/storage/lifecycle-sqlite.js";
import * as taskQueue from "../../core/src/runtime/task-queue.js";
import { createFileQueueProjection } from "./file-queue-projection.js";

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-file-queue-"));
  const stateRoot = path.join(root, ".niis");
  const store = createLifecycleSqliteStore({
    databasePath: path.join(stateRoot, "niis.sqlite"),
  });
  const projection = createFileQueueProjection({ stateRoot });
  t.after(() => {
    store.close();
    fs.rmSync(root, { force: true, recursive: true });
  });
  return { projection, stateRoot, store };
}

test("file projection is rebuilt only from durable outbox events", async (t) => {
  const { projection, stateRoot, store } = createFixture(t);
  await store.queue.enqueue({
    payload: { title: "Projected task" },
    priority: 10,
    taskId: "task-1",
  });

  const before = await reconcileQueueProjection({ projection, store });
  assert.equal(before.after.status, "lagging");
  assert.equal(before.requires_operator, false);

  const flush = await flushQueueProjectionOutbox({ projection, store });
  assert.equal(flush.failed.length, 0);
  const projected = taskQueue.findTaskState({ stateRoot, taskId: "task-1" });
  assert.equal(projected.state, "pending");
  assert.equal(projected.data.lifecycle_queue_state, "PENDING");
  assert.equal(projected.data.lifecycle_queue_version, 0);

  const after = await reconcileQueueProjection({ projection, store });
  assert.equal(after.after.status, "in_sync");
});

test("projection-only file entries require explicit operator reconciliation", async (t) => {
  const { projection, stateRoot, store } = createFixture(t);
  taskQueue.enqueueTask({
    metadata: { title: "Legacy-only task" },
    stateRoot,
    taskId: "legacy-only",
  });

  const report = await reconcileQueueProjection({
    applyPending: true,
    projection,
    store,
  });

  assert.equal(report.requires_operator, true);
  assert.equal(report.after.unexplained_divergences[0].kind, "projection_only");
  assert.equal(await store.queue.byTask("legacy-only"), null);
});

test("manual file projection moves are reported instead of becoming queue input", async (t) => {
  const { projection, stateRoot, store } = createFixture(t);
  await store.queue.enqueue({ taskId: "task-manual-move" });
  await flushQueueProjectionOutbox({ projection, store });
  taskQueue.transitionTask({
    stateRoot,
    taskId: "task-manual-move",
    toState: "accepted",
  });

  const report = await reconcileQueueProjection({
    applyPending: true,
    projection,
    store,
  });
  assert.equal(report.requires_operator, true);
  assert.equal(report.after.unexplained_divergences[0].kind, "state_mismatch");
  assert.equal((await store.queue.byTask("task-manual-move")).state, "PENDING");
});

test("file projection follows claim and terminal transitions idempotently", async (t) => {
  const { projection, stateRoot, store } = createFixture(t);
  await store.queue.enqueue({ taskId: "task-2" });
  await flushQueueProjectionOutbox({ projection, store });
  await store.queue.claimNext({ holder: "fixture", ttlMs: 30_000 });
  await flushQueueProjectionOutbox({ projection, store });
  assert.equal(
    taskQueue.findTaskState({ stateRoot, taskId: "task-2" }).state,
    "in_progress",
  );

  await store.queue.transition({
    expectedState: "CLAIMED",
    holder: "fixture",
    nextState: "COMPLETED",
    taskId: "task-2",
  });
  await flushQueueProjectionOutbox({ projection, store });
  await flushQueueProjectionOutbox({ projection, store });

  const projected = taskQueue.findTaskState({ stateRoot, taskId: "task-2" });
  assert.equal(projected.state, "accepted");
  assert.equal(projected.data.lifecycle_queue_state, "COMPLETED");
  assert.equal(projected.data.lifecycle_queue_version, 2);
});

test("file projection detects and repairs payload drift at the same version", async (t) => {
  const { projection, stateRoot, store } = createFixture(t);
  await store.queue.enqueue({
    payload: {
      private_value: "must-not-leak",
      title: "Expected title",
    },
    taskId: "task-payload",
    now: "2026-07-23T10:00:00.000Z",
  });
  await flushQueueProjectionOutbox({ projection, store });

  const projected = taskQueue.findTaskState({
    stateRoot,
    taskId: "task-payload",
  });
  fs.writeFileSync(
    projected.file,
    `${JSON.stringify({
      ...projected.data,
      title: "Tampered title",
    }, null, 2)}\n`,
  );

  const drift = await reconcileQueueProjection({ projection, store });
  assert.equal(drift.requires_operator, true);
  assert.equal(drift.after.unexplained_divergences[0].kind, "content_mismatch");
  assert.doesNotMatch(JSON.stringify(drift), /must-not-leak/u);

  const authoritative = await store.queue.byTask("task-payload");
  await projection.apply({
    created_at: "2026-07-23T10:01:00.000Z",
    delivery_attempts: 0,
    delivered_at: null,
    entry: authoritative,
    event_id: "repair-task-payload",
    last_error: null,
    operation: "UPSERT",
    sequence_id: 1,
    task_id: "task-payload",
  });

  const repaired = await reconcileQueueProjection({ projection, store });
  assert.equal(repaired.after.status, "in_sync");
  assert.equal(
    taskQueue.findTaskState({
      stateRoot,
      taskId: "task-payload",
    }).data.title,
    "Expected title",
  );
});
