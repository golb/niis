import test from "node:test";
import assert from "node:assert/strict";

import { createInMemoryTestAdapter } from "../../../adapters/test-adapter.js";
import { normalizeExecutionResult } from "./result-normalizer.js";

test("normalizeExecutionResult produces canonical run record and adapter-call event", () => {
  const adapter = createInMemoryTestAdapter({
    id: "normalizer-adapter",
  });
  const normalized = normalizeExecutionResult({
    adapter,
    agentId: "agent-1",
    finishedAt: "2026-03-21T16:00:03Z",
    rawResult: {
      completion_signal: true,
      cost: {
        estimated_usd: 0.02,
        input_tokens: 120,
        output_tokens: 45,
      },
      next_actions: [],
      status: "SUCCESS",
      summary: "Completed.",
    },
    runId: "run-1",
    startedAt: "2026-03-21T16:00:00Z",
    taskId: "task-1",
  });

  assert.equal(normalized.run_record.status, "COMPLETED");
  assert.equal(normalized.run_record.cost.tokens_in, 120);
  assert.equal(normalized.run_record.cost.duration_ms, 3000);
  assert.equal(normalized.events[0].event_type, "ADAPTER_CALL");
});
