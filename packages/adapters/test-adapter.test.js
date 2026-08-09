import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCapabilityAccess,
  normalizeAdapterResult,
  renderSessionCompactionHandoff,
  runAdapterDiagnostics,
} from "../core/src/contracts/adapter.js";
import { createInMemoryTestAdapter } from "./test-adapter.js";

test("createInMemoryTestAdapter exposes the production adapter interface and records execution history", async () => {
  const adapter = createInMemoryTestAdapter({
    scriptedResults: [
      {
        status: "SUCCESS",
        summary: "scripted success",
        next_actions: ["continue"],
        artifacts: [],
        cost: {
          input_tokens: 10,
          output_tokens: 5,
          estimated_usd: 0.01,
        },
        completion_signal: true,
        self_assessment: null,
        error: null,
      },
    ],
  });

  const executeResult = await adapter.execute({
    task_id: "task-1",
  });
  const normalized = normalizeAdapterResult(adapter, executeResult);

  assert.equal(normalized.summary, "scripted success");
  assert.equal(normalized.completion_signal, true);
  assert.deepEqual(adapter.getHistory().map((entry) => entry.type), ["execute"]);
});

test("createInMemoryTestAdapter participates in diagnostics, capability checks, and session handoff", async () => {
  const adapter = createInMemoryTestAdapter();
  const diagnostics = await runAdapterDiagnostics({
    adapter,
    config: {},
  });
  const access = evaluateCapabilityAccess({
    capabilities: adapter.capabilities(),
    operation: "runtime_tools.execute",
    toolFamily: "task_source.query",
    sensitivePathClass: "workspace",
  });
  const handoff = renderSessionCompactionHandoff(adapter.sessionCodec(), [
    {
      run: 1,
    },
    {
      run: 2,
    },
  ]);

  assert.equal(diagnostics.ok, true);
  assert.equal(access.allowed, true);
  assert.equal(handoff, "test-adapter handoff for 2 session(s)");
});
