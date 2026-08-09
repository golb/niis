import test from "node:test";
import assert from "node:assert/strict";

import { createInMemoryTestAdapter } from "../../../adapters/test-adapter.js";
import { runTaskExecution } from "./executor.js";

test("runTaskExecution routes and executes through the normalized runtime path", async () => {
  const adapter = createInMemoryTestAdapter({
    id: "executor-adapter",
    capabilities: {
      toolFamilies: ["shell"],
    },
    metadata: {
      cost_tier: "standard",
    },
    scriptedResults: [
      {
        completion_signal: true,
        next_actions: [],
        status: "SUCCESS",
        summary: "Task complete.",
      },
    ],
  });
  const execution = await runTaskExecution({
    adapters: [adapter],
    agentId: "agent-route",
    bootstrapContext: {
      projectProfile: "Strict mode.",
      workflow: "route -> run",
    },
    confirmationThreshold: 1,
    referenceBundle: {
      documentationPriority: ["docs/guide.md"],
      guides: ["Inspect before patching."],
      stepCatalog: ["Read the target file."],
      targetPaths: ["src/feature.js"],
    },
    roleManifests: [
      {
        id: "default-generalist",
        lane: "generalist",
        safe_fallback: true,
        toolFamilies: ["shell"],
      },
    ],
    runId: "run-route-1",
    task: {
      id: "task-route-1",
      title: "Execute the coordinator path",
    },
  });

  assert.equal(execution.route_plan.selected_adapter.id, "executor-adapter");
  assert.equal(execution.final_response.summary, "Task complete.");
  assert.equal(execution.run_record.status, "COMPLETED");
  assert.equal(execution.runtime_events.length >= 2, true);
});
