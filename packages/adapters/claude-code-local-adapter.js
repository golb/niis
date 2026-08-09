import { createLocalCliAdapter } from "./local-cli-adapter.js";

function createClaudeCodeLocalAdapter({
  id = "claude_code_local",
  command = "claude-code",
  args = [],
  diagnosticArgs = ["--version"],
  cwd = undefined,
  env = {},
  metadata = {},
  capabilities = {},
  requiredEnv = [],
  optionalEnv = [],
  runtimeTools = () => [],
} = {}) {
  const printFlag = args.includes("--print") ? [] : ["--print"];
  const formatFlag = args.some((a) => a.startsWith("--output-format")) ? [] : ["--output-format=json"];
  return createLocalCliAdapter({
    adapterKind: "claude_code_local",
    args: [...args, ...printFlag, ...formatFlag],
    capabilities: {
      ...capabilities,
      toolFamilies: capabilities.toolFamilies ?? ["shell", "local_cli", "claude_code_local"],
    },
    command,
    cwd,
    diagnosticArgs,
    env,
    id,
    metadata: {
      runtime_family: "claude_code_local",
      ...metadata,
    },
    optionalEnv,
    requiredEnv,
    runtimeLabel: "Claude Code Local",
    runtimeTools,
  });
}

export {
  createClaudeCodeLocalAdapter,
};
