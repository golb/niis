import test from "node:test";
import assert from "node:assert/strict";

import { createLiveEventEnvelope, emitLiveEventBatch } from "./live-events.js";

test("createLiveEventEnvelope maps canonical event records into the reserved live-event shape", () => {
  const envelope = createLiveEventEnvelope({
    id: "run-1:event-1",
    run_id: "run-1",
    task_id: "task-1",
    event_type: "STATE_CHANGE",
    timestamp: "2026-04-02T07:40:00.000Z",
    actor: "runtime",
    payload: {
      summary: "Runtime state changed.",
    },
  });

  assert.deepEqual(envelope, {
    event_id: "run-1:event-1",
    event_type: "STATE_CHANGE",
    timestamp: "2026-04-02T07:40:00.000Z",
    payload: {
      actor: "runtime",
      data: {
        summary: "Runtime state changed.",
      },
      run_id: "run-1",
      task_id: "task-1",
    },
  });
});

test("emitLiveEventBatch supports batch-oriented sinks", async () => {
  const events = [];

  const emitted = await emitLiveEventBatch({
    emitBatch(batch) {
      events.push(...batch);
    },
  }, [{
    id: "run-2:event-1",
    run_id: "run-2",
    task_id: "task-2",
    event_type: "POLICY_DECISION",
    timestamp: "2026-04-02T07:41:00.000Z",
    actor: "runtime",
    payload: {
      action: "periodic_backup",
    },
  }]);

  assert.equal(emitted.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, "run-2:event-1");
  assert.equal(events[0].payload.data.action, "periodic_backup");
});
