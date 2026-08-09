import test from "node:test";
import assert from "node:assert/strict";

import {
  createAdapterDefinition,
  createCapabilityDeniedResponse,
  createCapabilityProfile,
  createRuntimeToolSpec,
  createSessionCodec,
  deserializeAdapterSession,
  evaluateCapabilityAccess,
  normalizeAdapterResult,
  resolveAdapterEnv,
  runAdapterDiagnostics,
  selectAdapterByCapabilities,
  serializeAdapterSession,
} from "./adapter.js";

function createAdapter({
  id,
  protocolType = "local_cli",
  capabilities = {},
  test = async () => ({ ok: true, checks: [] }),
} = {}) {
  return createAdapterDefinition({
    id,
    protocolType,
    capabilities: {
      operations: ["execute", "runtime_tools.execute", ...(capabilities.operations ?? [])],
      permissions: capabilities.permissions ?? [],
      privilegedOperations: capabilities.privilegedOperations ?? [],
      toolFamilies: capabilities.toolFamilies ?? [],
      allow: capabilities.allow ?? {},
      deny: capabilities.deny ?? {},
    },
    execute: async (context) => ({ context }),
    normalize: (result) => ({
      status: "SUCCESS",
      summary: `normalized by ${id}`,
      next_actions: [],
      artifacts: [],
      cost: null,
      completion_signal: result?.completion_signal ?? null,
      self_assessment: result?.self_assessment ?? null,
      error: null,
    }),
    requiredEnv: () => capabilities.requiredEnv ?? [],
    optionalEnv: () => capabilities.optionalEnv ?? [],
    runtimeTools: () => [
      createRuntimeToolSpec({
        name: "niis.query_blockers",
        description: "Query active blockers.",
        requiredCapabilities: ["runtime_tools.execute"],
      }),
    ],
    sessionCodec: createSessionCodec({
      serialize: (sessionParams) => ({ saved: sessionParams }),
      deserialize: (stored) => stored.saved,
      compactionHandoff: (sessions) => `handoff:${sessions.length}`,
    }),
    callbackChannel: {
      onProgress: async () => "progress",
    },
    test,
  });
}

test("evaluateCapabilityAccess enforces declared operations, privileged permissions, and allow/deny envelopes", () => {
  const capabilityProfile = createCapabilityProfile({
    protocolType: "mcp_server",
    operations: ["execute", "runtime_tools.execute", "workspace.write"],
    permissions: ["workspace.write"],
    privilegedOperations: ["workspace.write"],
    toolFamilies: ["shell", "fs"],
    allow: {
      toolFamilies: ["shell"],
      sensitivePathClasses: ["workspace"],
    },
    deny: {
      toolFamilies: ["network"],
      sensitivePathClasses: ["home"],
    },
  });

  assert.deepEqual(
    evaluateCapabilityAccess({
      capabilities: capabilityProfile,
      operation: "workspace.write",
      toolFamily: "shell",
      sensitivePathClass: "workspace",
    }),
    {
      allowed: true,
      reason: null,
    },
  );
  assert.equal(
    evaluateCapabilityAccess({
      capabilities: capabilityProfile,
      operation: "workspace.write",
      toolFamily: "network",
      sensitivePathClass: "workspace",
    }).allowed,
    false,
  );
  assert.equal(
    evaluateCapabilityAccess({
      capabilities: capabilityProfile,
      operation: "workspace.write",
      toolFamily: "shell",
      sensitivePathClass: "home",
    }).allowed,
    false,
  );
});

test("createCapabilityDeniedResponse returns canonical adapter-response error payload", () => {
  const denied = createCapabilityDeniedResponse({
    adapterId: "mcp-test",
    operation: "workspace.write",
    toolFamily: "network",
    reason: "network tool family is denied",
  });

  assert.equal(denied.status, "ERROR");
  assert.equal(denied.error?.category, "auth");
  assert.equal(denied.error?.retry_safe, false);
});

test("resolveAdapterEnv supports direct values and secret_ref resolution", () => {
  const envMap = resolveAdapterEnv({
    config: {
      OPENAI_API_KEY: {
        secret_ref: "secrets/openai",
      },
      NIIS_LOG_LEVEL: "debug",
    },
    secretStore: {
      "secrets/openai": "sk-test",
    },
    requiredEnv: [
      {
        key: "OPENAI_API_KEY",
        description: "API key",
        sensitive: true,
      },
    ],
    optionalEnv: [
      {
        key: "NIIS_LOG_LEVEL",
        description: "Log level",
      },
    ],
  });

  assert.deepEqual(envMap, {
    OPENAI_API_KEY: "sk-test",
    NIIS_LOG_LEVEL: "debug",
  });
});

test("selectAdapterByCapabilities chooses adapters by declared capability match rather than adapter name", () => {
  const localAdapter = createAdapter({
    id: "zzz-local",
    protocolType: "local_cli",
    capabilities: {
      toolFamilies: ["shell"],
    },
  });
  const mcpAdapter = createAdapter({
    id: "aaa-mcp",
    protocolType: "mcp_server",
    capabilities: {
      toolFamilies: ["task_source.query", "shell"],
    },
  });

  const selection = selectAdapterByCapabilities([localAdapter, mcpAdapter], {
    protocolTypes: ["mcp_server"],
    toolFamilies: ["task_source.query"],
    operations: ["execute"],
  });

  assert.equal(selection.selected?.id, "aaa-mcp");
  assert.equal(selection.candidates.length, 1);
});

test("selectAdapterByCapabilities supports cursor_bridge as a declared compatibility path", () => {
  const localAdapter = createAdapter({
    id: "local-shell",
    protocolType: "local_cli",
    capabilities: {
      toolFamilies: ["shell"],
    },
  });
  const cursorBridgeAdapter = createAdapter({
    id: "cursor-bridge",
    protocolType: "cursor_bridge",
    capabilities: {
      toolFamilies: ["cursor_bridge", "shell"],
    },
  });

  const selection = selectAdapterByCapabilities([localAdapter, cursorBridgeAdapter], {
    protocolTypes: ["cursor_bridge"],
    toolFamilies: ["shell"],
    operations: ["execute"],
  });

  assert.equal(selection.selected?.id, "cursor-bridge");
  assert.equal(selection.selected?.protocolType, "cursor_bridge");
});

test("createAdapterDefinition normalizes results, diagnostics, runtime tools, callbacks, and session codec", async () => {
  const adapter = createAdapter({
    id: "test-adapter",
    protocolType: "local_cli",
    capabilities: {
      permissions: ["runtime_tools.execute"],
      toolFamilies: ["shell"],
      requiredEnv: [
        {
          key: "TEST_TOKEN",
          description: "Test token",
          sensitive: true,
        },
      ],
    },
    test: async ({ env }) => ({
      ok: env.TEST_TOKEN === "token",
      checks: [
        {
          name: "adapter.test",
          status: "PASS",
          message: "adapter ready",
        },
      ],
    }),
  });

  const normalized = normalizeAdapterResult(adapter, {
    completion_signal: true,
    self_assessment: [
      {
        criterion: "AC-1",
        status: "PASS",
        note: "covered",
      },
    ],
  });
  const diagnostics = await runAdapterDiagnostics({
    adapter,
    config: {
      TEST_TOKEN: "token",
    },
  });
  const stored = serializeAdapterSession(adapter.sessionCodec(), {
    thread: "session-1",
  });
  const restored = deserializeAdapterSession(adapter.sessionCodec(), stored);

  assert.equal(normalized.status, "SUCCESS");
  assert.equal(normalized.completion_signal, true);
  assert.equal(normalized.self_assessment?.[0].criterion, "AC-1");
  assert.equal(diagnostics.ok, true);
  assert.equal(adapter.runtimeTools()[0].name, "niis.query_blockers");
  assert.equal(await adapter.callbackChannel().onProgress({}), "progress");
  assert.deepEqual(restored, { thread: "session-1" });
});
