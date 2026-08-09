import { createLocalCliAdapter } from "./local-cli-adapter.js";

function createCodexLocalAdapter({
  id = "codex_local",
  command = "codex",
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
  const jsonFlag = args.includes("--json") ? [] : ["--json"];
  return createLocalCliAdapter({
    adapterKind: "codex_local",
    args: [...args, ...jsonFlag],
    capabilities: {
      ...capabilities,
      toolFamilies: capabilities.toolFamilies ?? ["shell", "local_cli", "codex_local"],
    },
    command,
    cwd,
    diagnosticArgs,
    env,
    id,
    metadata: {
      runtime_family: "codex_local",
      ...metadata,
    },
    optionalEnv,
    requiredEnv,
    runtimeLabel: "Codex Local",
    runtimeTools,
  });
}

export {
  createCodexLocalAdapter,
};
