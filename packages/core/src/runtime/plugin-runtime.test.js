import test from "node:test";
import assert from "node:assert/strict";

import { createPluginRuntimePlan } from "./plugin-runtime.js";

function createPluginSpec(overrides = {}) {
  return {
    action: overrides.action ?? "load",
    eventSubscriptions: overrides.eventSubscriptions ?? [{ topic: "run.finished" }],
    hooks: overrides.hooks ?? {
      setup: true,
      shutdown: true,
      health: true,
    },
    integrations: overrides.integrations ?? [{
      id: "mcp-echo",
      kind: "mcp_server",
      displayName: "Echo MCP",
      command: "node",
      args: ["server.js"],
      defaultToolName: "echo",
    }],
    jobs: overrides.jobs ?? [{
      id: "job-1",
      description: "Job 1",
      schedule: "*/5 * * * *",
    }],
    lifecycleState: overrides.lifecycleState ?? "installed",
    manifest: overrides.manifest ?? {
      id: "pkg-observability-plugin",
      name: "Observability Plugin",
      version: "0.1.0",
      type: "plugin",
      capabilities: ["observability"],
      compatibility: {
        min_niis_version: "0.1.0",
        max_niis_version: null,
        required_adapters: [],
      },
      activation_status: overrides.activationStatus ?? "ACTIVE",
      schema_version: "1.0.0",
    },
    runtimeCapabilities: overrides.runtimeCapabilities ?? {
      operations: [
        "events.subscribe",
        "jobs.schedule",
        "runtime_tools.register",
        "state.write",
        "integration.mcp_server",
      ],
      toolFamilies: ["mcp", "plugin"],
    },
    stateScopes: overrides.stateScopes ?? [{
      kind: "project",
      access: "read_write",
      scopeKey: "project:example-project",
    }],
    tools: overrides.tools ?? [{
      name: "observability.summary",
      description: "Summarize observability state",
    }],
    worker: overrides.worker ?? {},
  };
}

test("createPluginRuntimePlan returns a ready runtime plan for active plugins", () => {
  const plan = createPluginRuntimePlan({
    plugin: createPluginSpec(),
  });

  assert.equal(plan.allowed, true);
  assert.equal(plan.runtime_status, "ready");
  assert.equal(plan.lifecycle_transition.to_state, "ready");
  assert.equal(plan.adapter_diagnostic_requests[0].protocol_type, "mcp_server");
});

test("createPluginRuntimePlan blocks plugins that are not active yet", () => {
  const plan = createPluginRuntimePlan({
    plugin: createPluginSpec({
      activationStatus: "REVIEW",
    }),
  });

  assert.equal(plan.allowed, false);
  assert.equal(plan.checks.some((check) => check.id === "plugin-activation-status" && check.status === "error"), true);
});

test("createPluginRuntimePlan blocks plugins when capability gating is insufficient", () => {
  const plan = createPluginRuntimePlan({
    plugin: createPluginSpec({
      runtimeCapabilities: {
        operations: ["events.subscribe"],
        toolFamilies: [],
      },
    }),
  });

  assert.equal(plan.allowed, false);
  assert.equal(plan.checks.some((check) => check.id === "plugin-integrations" && check.status === "error"), true);
  assert.equal(plan.checks.some((check) => check.id === "plugin-jobs" && check.status === "error"), true);
});
