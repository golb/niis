import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSqliteStorage } from "./sqlite.js";

function createStorage(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niis-events-filter-"));
  const databasePath = path.join(dir, "state.sqlite");
  const storage = createSqliteStorage({ databasePath });
  t.after(() => {
    try { storage.close(); } catch {  }
    try { fs.rmSync(dir, { force: true, recursive: true }); } catch {  }
  });
  return storage;
}

function createEvent(overrides) {
  return {
    actor_id: "supervisor.stdout",
    actor_type: "runtime",
    event_type: "run_log",
    id: `evt-${Math.random().toString(36).slice(2)}`,
    level: "info",
    payload: { chunk: "x", stream: "stdout" },
    run_id: null,
    task_id: "task-a",
    ts: "2026-04-24T10:00:00.000Z",
    visibility: "verbose",
    ...overrides,
  };
}

test("taskRunEvents.byTaskFiltered returns all events for a task when no filters", async (t) => {
  const storage = createStorage(t);
  await storage.taskRunEvents.append(createEvent({ id: "a", ts: "2026-04-24T10:00:00.000Z" }));
  await storage.taskRunEvents.append(createEvent({ id: "b", ts: "2026-04-24T10:00:01.000Z" }));
  await storage.taskRunEvents.append(createEvent({ id: "c", task_id: "other", ts: "2026-04-24T10:00:02.000Z" }));
  const rows = await storage.taskRunEvents.byTaskFiltered({ taskId: "task-a" });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.task_id === "task-a"));
});

test("taskRunEvents.byTaskFiltered afterTs is strict (>)", async (t) => {
  const storage = createStorage(t);
  await storage.taskRunEvents.append(createEvent({ id: "a", ts: "2026-04-24T10:00:00.000Z" }));
  await storage.taskRunEvents.append(createEvent({ id: "b", ts: "2026-04-24T10:00:05.000Z" }));
  await storage.taskRunEvents.append(createEvent({ id: "c", ts: "2026-04-24T10:00:10.000Z" }));
  const rows = await storage.taskRunEvents.byTaskFiltered({ afterTs: "2026-04-24T10:00:05.000Z", taskId: "task-a" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "c");
});

test("taskRunEvents.byTaskFiltered eventTypes whitelist filters at SQL", async (t) => {
  const storage = createStorage(t);
  await storage.taskRunEvents.append(createEvent({ event_type: "run_log", id: "a", ts: "2026-04-24T10:00:00.000Z" }));
  await storage.taskRunEvents.append(createEvent({ event_type: "agent_status", id: "b", ts: "2026-04-24T10:00:01.000Z" }));
  await storage.taskRunEvents.append(createEvent({ event_type: "run_log", id: "c", ts: "2026-04-24T10:00:02.000Z" }));
  const rows = await storage.taskRunEvents.byTaskFiltered({ eventTypes: ["run_log"], taskId: "task-a" });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.event_type === "run_log"));
});

test("taskRunEvents.byTaskFiltered caps rows via limit parameter", async (t) => {
  const storage = createStorage(t);
  for (let i = 0; i < 50; i += 1) {
    await storage.taskRunEvents.append(createEvent({
      id: `evt-${i}`,
      ts: new Date(Date.parse("2026-04-24T10:00:00.000Z") + i).toISOString(),
    }));
  }
  const capped = await storage.taskRunEvents.byTaskFiltered({ limit: 10, taskId: "task-a" });
  assert.equal(capped.length, 10);
  const clampedHigh = await storage.taskRunEvents.byTaskFiltered({ limit: 10_000, taskId: "task-a" });
  assert.equal(clampedHigh.length, 50);
  const clampedLow = await storage.taskRunEvents.byTaskFiltered({ limit: 0, taskId: "task-a" });
  assert.ok(clampedLow.length >= 50 || clampedLow.length === 500);
});

test("taskRunEvents.byTaskFiltered combines afterTs + eventTypes + taskId", async (t) => {
  const storage = createStorage(t);
  await storage.taskRunEvents.append(createEvent({ event_type: "run_log", id: "a", ts: "2026-04-24T10:00:00.000Z" }));
  await storage.taskRunEvents.append(createEvent({ event_type: "agent_status", id: "b", ts: "2026-04-24T10:00:05.000Z" }));
  await storage.taskRunEvents.append(createEvent({ event_type: "run_log", id: "c", ts: "2026-04-24T10:00:10.000Z" }));
  await storage.taskRunEvents.append(createEvent({ event_type: "run_log", id: "d", task_id: "other", ts: "2026-04-24T10:00:15.000Z" }));
  const rows = await storage.taskRunEvents.byTaskFiltered({
    afterTs: "2026-04-24T10:00:00.000Z",
    eventTypes: ["run_log"],
    taskId: "task-a",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "c");
});
