import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLifecycleSqliteStore } from "../storage/lifecycle-sqlite.js";
import {
  QueueProjectionOperation,
  createQueueProjectionContentDigest,
  inspectQueueProjection,
  reconcileQueueProjection,
} from "./queue-projection.js";

function createProjection() {
  const entries = new Map();

  return {
    async snapshot() {
      return [...entries.values()];
    },
    async apply(event) {
      if (event.operation === QueueProjectionOperation.REMOVE) {
        entries.delete(event.task_id);
        return;
      }

      entries.set(event.task_id, {
        content_digest: createQueueProjectionContentDigest(event.entry),
        task_id: event.entry.task_id,
        state: event.entry.state,
        version: event.entry.version,
      });
    },
    set(entry) {
      entries.set(entry.task_id, entry);
    },
  };
}

test("reconciliation applies only durable outbox events and reaches in-sync state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-queue-projection-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const store = createLifecycleSqliteStore({
    databasePath: path.join(root, "niis.sqlite"),
    idFactory: () => "event-1",
  });
  const projection = createProjection();

  await store.queue.enqueue({
    taskId: "task-1",
    now: "2026-07-23T10:00:00.000Z",
  });

  const before = await inspectQueueProjection({ store, projection });
  assert.equal(before.status, "lagging");
  assert.equal(before.requires_operator, false);
  assert.equal(before.divergences[0].covered_by_pending_outbox, true);

  const reconciled = await reconcileQueueProjection({
    store,
    projection,
    applyPending: true,
  });
  assert.equal(reconciled.flush.delivered.length, 1);
  assert.equal(reconciled.after.status, "in_sync");
  assert.equal(reconciled.requires_operator, false);
  store.close();
});

test("unexplained file projection drift is reported for operator resolution", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-queue-drift-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const store = createLifecycleSqliteStore({
    databasePath: path.join(root, "niis.sqlite"),
    idFactory: () => "event-2",
  });
  const projection = createProjection();

  await store.queue.enqueue({
    taskId: "task-2",
    now: "2026-07-23T10:00:00.000Z",
  });
  await reconcileQueueProjection({ store, projection, applyPending: true });
  projection.set({
    task_id: "task-2",
    state: "FAILED",
    version: 99,
  });

  const report = await inspectQueueProjection({ store, projection });
  assert.equal(report.status, "diverged");
  assert.equal(report.requires_operator, true);
  assert.equal(report.unexplained_divergences[0].kind, "state_mismatch");
  store.close();
});

test("same-state same-version payload drift is detected without exposing payload", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-queue-content-drift-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const store = createLifecycleSqliteStore({
    databasePath: path.join(root, "niis.sqlite"),
    idFactory: () => "event-content",
  });
  const projection = createProjection();

  await store.queue.enqueue({
    payload: {
      private_value: "not-for-diagnostics",
      title: "Expected title",
    },
    taskId: "task-content",
    now: "2026-07-23T10:00:00.000Z",
  });
  await reconcileQueueProjection({ store, projection, applyPending: true });
  const authoritative = await store.queue.byTask("task-content");
  projection.set({
    content_digest: createQueueProjectionContentDigest({
      ...authoritative,
      payload: {
        ...authoritative.payload,
        title: "Tampered title",
      },
    }),
    state: authoritative.state,
    task_id: authoritative.task_id,
    version: authoritative.version,
  });

  const report = await inspectQueueProjection({ store, projection });
  assert.equal(report.status, "diverged");
  assert.equal(report.requires_operator, true);
  assert.equal(report.unexplained_divergences[0].kind, "content_mismatch");
  assert.match(
    report.unexplained_divergences[0].authoritative.content_digest,
    /^[a-f0-9]{64}$/u,
  );
  assert.doesNotMatch(JSON.stringify(report), /not-for-diagnostics/u);
  store.close();
});
