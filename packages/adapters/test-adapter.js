import {
  createAdapterDefinition,
  createRuntimeToolSpec,
  createSessionCodec,
} from "../core/src/contracts/adapter.js";

function createInMemoryTestAdapter({
  id = "test-adapter",
  protocolType = "in_memory",
  scriptedResults = [],
  diagnostics = {},
  capabilities = {},
  metadata = {},
} = {}) {
  const history = [];
  const queue = [...scriptedResults];

  const adapter = createAdapterDefinition({
    id,
    protocolType,
    capabilities: {
      adapterKind: "test",
      operations: ["execute", "runtime_tools.execute", ...(capabilities.operations ?? [])],
      permissions: capabilities.permissions ?? ["runtime_tools.execute"],
      privilegedOperations: capabilities.privilegedOperations ?? ["runtime_tools.execute"],
      toolFamilies: capabilities.toolFamilies ?? ["memory", "task_source.query"],
      allow: capabilities.allow ?? {
        toolFamilies: ["memory", "task_source.query"],
        sensitivePathClasses: ["workspace"],
      },
      deny: capabilities.deny ?? {
        toolFamilies: ["destructive"],
        sensitivePathClasses: ["home"],
      },
    },
    metadata,
    execute: async (context) => {
      history.push({
        type: "execute",
        context,
      });

      if (queue.length === 0) {
        return {
          status: "SUCCESS",
          summary: "In-memory adapter executed with default success result.",
          next_actions: [],
          artifacts: [],
          cost: {
            input_tokens: 0,
            output_tokens: 0,
            estimated_usd: 0,
          },
          completion_signal: null,
          self_assessment: null,
          error: null,
        };
      }

      return queue.shift();
    },
    normalize: (result) => {
      if (result?.status) {
        return result;
      }

      return {
        status: "SUCCESS",
        summary: String(result?.summary ?? "In-memory adapter normalized an opaque result."),
        next_actions: result?.next_actions ?? [],
        artifacts: result?.artifacts ?? [],
        cost: result?.cost ?? {
          input_tokens: 0,
          output_tokens: 0,
          estimated_usd: 0,
        },
        completion_signal: result?.completion_signal ?? null,
        self_assessment: result?.self_assessment ?? null,
        error: result?.error ?? null,
      };
    },
    test: async ({ env }) => {
      history.push({
        type: "test",
        env,
      });

      return {
        ok: diagnostics.ok ?? true,
        checks: [
          {
            name: "memory-runtime",
            status: diagnostics.ok === false ? "FAIL" : "PASS",
            message:
              diagnostics.message ?? "In-memory adapter is ready without external runtime dependencies.",
          },
        ],
      };
    },
    requiredEnv: () => capabilities.requiredEnv ?? [],
    optionalEnv: () => capabilities.optionalEnv ?? [],
    sessionCodec: createSessionCodec({
      serialize: (sessionParams) => ({
        saved_session: sessionParams,
      }),
      deserialize: (stored) => stored.saved_session,
      compactionHandoff: (sessions) => `test-adapter handoff for ${sessions.length} session(s)`,
    }),
    runtimeTools: () => [
      createRuntimeToolSpec({
        name: "task_source.query",
        description: "Query task-source state through the orchestrator runtime.",
        requiredCapabilities: ["runtime_tools.execute"],
      }),
    ],
  });

  return Object.freeze({
    ...adapter,
    getHistory() {
      return history.slice();
    },
  });
}

export {
  createInMemoryTestAdapter,
};
