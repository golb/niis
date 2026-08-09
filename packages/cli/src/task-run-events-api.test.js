import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskRunEventsApiPayload } from "./main.js";

function createEvent(overrides) {
  return {
    actor_id: "supervisor.stdout",
    actor_type: "runtime",
    event_type: "run_log",
    id: `evt-${overrides.ts}`,
    level: "info",
    payload: { chunk: "data", stream: "stdout" },
    run_id: null,
    task_id: "task-a",
    ts: overrides.ts,
    visibility: "verbose",
    ...overrides,
  };
}

test("buildTaskRunEventsApiPayload returns all events for a task when no cursor", async () => {
  const spec = {
    snapshot: {
      taskRunEvents: [
        createEvent({ ts: "2026-04-24T10:00:00.000Z" }),
        createEvent({ ts: "2026-04-24T10:00:01.000Z" }),
        createEvent({ id: "evt-other", task_id: "task-b", ts: "2026-04-24T10:00:02.000Z" }),
      ],
    },
  };
  const result = await buildTaskRunEventsApiPayload({ runId: null, spec, taskId: "task-a", workspaceRoot: "/tmp/none" });
  assert.equal(result.events.length, 2);
  assert.ok(result.events.every((event) => event.task_id === "task-a"));
});

test("buildTaskRunEventsApiPayload filters by afterTs cursor", async () => {
  const spec = {
    snapshot: {
      taskRunEvents: [
        createEvent({ ts: "2026-04-24T10:00:00.000Z" }),
        createEvent({ ts: "2026-04-24T10:00:05.000Z" }),
        createEvent({ ts: "2026-04-24T10:00:10.000Z" }),
      ],
    },
  };
  const result = await buildTaskRunEventsApiPayload({
    afterTs: "2026-04-24T10:00:05.000Z",
    runId: null,
    spec,
    taskId: "task-a",
    workspaceRoot: "/tmp/none",
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].ts, "2026-04-24T10:00:10.000Z");
});

test("buildTaskRunEventsApiPayload filters by eventTypes whitelist", async () => {
  const spec = {
    snapshot: {
      taskRunEvents: [
        createEvent({ event_type: "run_log", ts: "2026-04-24T10:00:00.000Z" }),
        createEvent({ event_type: "agent_status", ts: "2026-04-24T10:00:01.000Z" }),
        createEvent({ event_type: "run_log", ts: "2026-04-24T10:00:02.000Z" }),
      ],
    },
  };
  const result = await buildTaskRunEventsApiPayload({
    eventTypes: ["run_log"],
    runId: null,
    spec,
    taskId: "task-a",
    workspaceRoot: "/tmp/none",
  });
  assert.equal(result.events.length, 2);
  assert.ok(result.events.every((event) => event.event_type === "run_log"));
});

test("buildTaskRunEventsApiPayload includes run_id=null events when runId is null", async () => {
  const spec = {
    snapshot: {
      taskRunEvents: [
        createEvent({ run_id: null, ts: "2026-04-24T10:00:00.000Z" }),
        createEvent({ run_id: "run-1", ts: "2026-04-24T10:00:01.000Z" }),
      ],
    },
  };
  const result = await buildTaskRunEventsApiPayload({ runId: null, spec, taskId: "task-a", workspaceRoot: "/tmp/none" });
  assert.equal(result.events.length, 2);
});

test("buildTaskRunEventsApiPayload scopes to a specific runId when provided", async () => {
  const spec = {
    snapshot: {
      taskRunEvents: [
        createEvent({ run_id: null, ts: "2026-04-24T10:00:00.000Z" }),
        createEvent({ run_id: "run-1", ts: "2026-04-24T10:00:01.000Z" }),
        createEvent({ run_id: "run-2", ts: "2026-04-24T10:00:02.000Z" }),
      ],
    },
  };
  const result = await buildTaskRunEventsApiPayload({ runId: "run-1", spec, taskId: "task-a", workspaceRoot: "/tmp/none" });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].run_id, "run-1");
});

test("buildTaskRunEventsApiPayload version reflects last ts + count for cursor polling", async () => {
  const spec = {
    snapshot: {
      taskRunEvents: [
        createEvent({ ts: "2026-04-24T10:00:00.000Z" }),
        createEvent({ ts: "2026-04-24T10:00:05.000Z" }),
      ],
    },
  };
  const result = await buildTaskRunEventsApiPayload({ runId: null, spec, taskId: "task-a", workspaceRoot: "/tmp/none" });
  assert.equal(result.version, "2026-04-24T10:00:05.000Z|2");
});
