import { createMcpServerAdapter } from "./mcp-server-adapter.js";

function createCursorBridgeAdapter({
  id = "cursor-bridge-adapter",
  command,
  args = [],
  cwd = undefined,
  env = {},
  metadata = {},
  defaultToolName = null,
  capabilities = {},
  requiredEnv = [],
  optionalEnv = [],
  runtimeTools = () => [],
} = {}) {
  return createMcpServerAdapter({
    args,
    capabilities: {
      ...capabilities,
      toolFamilies: capabilities.toolFamilies ?? ["cursor_bridge", "mcp"],
    },
    command,
    cwd,
    defaultToolName,
    env,
    id,
    metadata: {
      compatibility_path: "cursor_bridge",
      ...metadata,
    },
    optionalEnv,
    protocolType: "cursor_bridge",
    adapterKind: "cursor_bridge",
    requiredEnv,
    runtimeTools,
  });
}

export {
  createCursorBridgeAdapter,
};
