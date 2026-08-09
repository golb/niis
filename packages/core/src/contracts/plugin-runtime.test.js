import test from "node:test";
import assert from "node:assert/strict";

import {
  createPluginDefinition,
  createPluginIntegrationSpec,
  evaluatePluginLifecycleTransition,
} from "./plugin-runtime.js";

function createPluginManifest(overrides = {}) {
  return {
    id: overrides.id ?? "pkg-observability-plugin",
    name: overrides.name ?? "Observability Plugin",
    version: overrides.version ?? "0.1.0",
    type: "plugin",
    capabilities: overrides.capabilities ?? ["observability"],
    compatibility: overrides.compatibility ?? {
      min_niis_version: "0.1.0",
      max_niis_version: null,
      required_adapters: [],
    },
    activation_status: overrides.activation_status ?? "ACTIVE",
    schema_version: overrides.schema_version ?? "1.0.0",
  };
}

test("createPluginDefinition normalizes plugin runtime descriptors", () => {
  const definition = createPluginDefinition({
    eventSubscriptions: [{ topic: "run.finished" }],
    hooks: {
      setup: true,
      shutdown: true,
      health: true,
    },
    integrations: [{
      id: "mcp-observability",
      kind: "mcp_server",
      displayName: "Observability MCP",
      command: "node",
      args: ["server.js"],
    }],
    jobs: [{
      id: "sync-observability",
      description: "Sync observability state",
      schedule: "*/5 * * * *",
    }],
    lifecycleState: "installed",
    manifest: createPluginManifest(),
    runtimeCapabilities: {
      operations: [
        "events.subscribe",
        "jobs.schedule",
        "runtime_tools.register",
        "state.write",
        "integration.mcp_server",
      ],
      toolFamilies: ["mcp", "plugin"],
    },
    stateScopes: [{
      kind: "project",
      access: "read_write",
      scopeKey: "project:example-project",
    }],
    tools: [{
      name: "observability.summary",
      description: "Summarize observability state",
    }],
  });

  assert.equal(definition.package_manifest.type, "plugin");
  assert.equal(definition.integrations[0].protocol_type, "mcp_server");
  assert.equal(definition.worker.isolation_kind, "process_rpc");
  assert.equal(definition.tools[0].name, "observability.summary");
});

test("createPluginIntegrationSpec creates mcp_server integrations as first-class extension types", () => {
  const integration = createPluginIntegrationSpec({
    id: "mcp-echo",
    kind: "mcp_server",
    displayName: "Echo MCP",
    command: "node",
    args: ["server.js"],
    defaultToolName: "echo",
    capabilities: {
      operations: ["execute"],
      toolFamilies: ["mcp"],
    },
  });

  assert.equal(integration.kind, "mcp_server");
  assert.equal(integration.default_tool_name, "echo");
  assert.equal(integration.capabilities.protocol_type, "mcp_server");
});

test("evaluatePluginLifecycleTransition enforces the lifecycle state machine", () => {
  const valid = evaluatePluginLifecycleTransition({
    fromState: "installed",
    action: "load",
  });
  const invalid = evaluatePluginLifecycleTransition({
    fromState: "disabled",
    action: "disable",
  });

  assert.equal(valid.allowed, true);
  assert.equal(valid.to_state, "ready");
  assert.equal(invalid.allowed, false);
});
