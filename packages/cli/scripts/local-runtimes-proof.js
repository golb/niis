import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runAdapterDiagnostics } from "../../core/src/contracts/adapter.js";
import { createClaudeCodeLocalAdapter } from "../../adapters/claude-code-local-adapter.js";
import { createCodexLocalAdapter } from "../../adapters/codex-local-adapter.js";

class LocalRuntimesProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "LocalRuntimesProofError";
    this.result = result;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntrypoint = path.resolve(__dirname, "..", "bin", "niis.js");
const fixtureRuntimePath = path.resolve(
  __dirname,
  "..",
  "..",
  "adapters",
  "test-fixtures",
  "local-runtime-echo.js",
);

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createRouteSpec({ runtimeId, workspaceRoot }) {
  return {
    adapters: [{
      args: [fixtureRuntimePath, "--runtime", runtimeId],
      capabilities: {
        toolFamilies: ["shell", "local_cli", runtimeId],
      },
      command: process.execPath,
      id: runtimeId,
      protocolType: "local_cli",
    }],
    referenceBundle: {
      guides: [],
      targetPaths: [],
    },
    roleManifests: [{
      adapter_requirements: {
        operations: ["execute"],
        protocolTypes: ["local_cli"],
        toolFamilies: ["shell", "local_cli", runtimeId],
      },
      id: `${runtimeId}-role`,
      lane: "generalist",
      safe_fallback: true,
      toolFamilies: ["shell"],
    }],
    task: {
      id: `${runtimeId.replaceAll("_", "-")}-task`,
      priority: "medium",
      title: `Use ${runtimeId} local runtime`,
    },
    workspaceRoot,
  };
}

function runRouteStep({ runtimeId, workspaceRoot }) {
  const specPath = path.join(workspaceRoot, `${runtimeId}-route.json`);
  writeJson(specPath, createRouteSpec({ runtimeId, workspaceRoot }));
  const result = spawnSync(process.execPath, [cliEntrypoint, "route", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const stdout = result.stdout?.trim() ?? "";

  return Object.freeze({
    command: "route",
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    parsed_json: stdout ? JSON.parse(stdout) : null,
    runtime_id: runtimeId,
    stderr: result.stderr?.trim() ?? "",
    stdout,
  });
}

async function runLocalRuntimesProof({
  workspaceRoot = null,
  outputRoot = null,
} = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-local-runtimes-proof-"));
  const resolvedWorkspaceRoot = workspaceRoot
    ? path.resolve(workspaceRoot)
    : path.join(tempRoot, "workspace");
  const resolvedOutputRoot = outputRoot
    ? path.resolve(outputRoot)
    : path.join(tempRoot, "artifacts");

  ensureDirectory(resolvedWorkspaceRoot);
  ensureDirectory(resolvedOutputRoot);

  const codexAdapter = createCodexLocalAdapter({
    command: process.execPath,
    args: [fixtureRuntimePath, "--runtime", "codex_local"],
  });
  const claudeAdapter = createClaudeCodeLocalAdapter({
    command: process.execPath,
    args: [fixtureRuntimePath, "--runtime", "claude_code_local"],
  });
  const codexDiagnostics = await runAdapterDiagnostics({
    adapter: codexAdapter,
    config: {},
  });
  const claudeDiagnostics = await runAdapterDiagnostics({
    adapter: claudeAdapter,
    config: {},
  });
  const codexRoute = runRouteStep({
    runtimeId: "codex_local",
    workspaceRoot: resolvedWorkspaceRoot,
  });
  const claudeRoute = runRouteStep({
    runtimeId: "claude_code_local",
    workspaceRoot: resolvedWorkspaceRoot,
  });
  const proofOutputPath = path.join(resolvedOutputRoot, "local-runtimes-proof.json");
  const ok = [
    codexDiagnostics.ok,
    claudeDiagnostics.ok,
    codexRoute.ok,
    claudeRoute.ok,
    codexRoute.parsed_json?.selected_adapter?.id === "codex_local",
    claudeRoute.parsed_json?.selected_adapter?.id === "claude_code_local",
    codexRoute.parsed_json?.selected_adapter?.capabilities?.adapter_kind === "codex_local",
    claudeRoute.parsed_json?.selected_adapter?.capabilities?.adapter_kind === "claude_code_local",
  ].every(Boolean);
  const result = {
    artifacts: {
      proof_output_path: proofOutputPath,
    },
    diagnostics: {
      claude_code_local: claudeDiagnostics,
      codex_local: codexDiagnostics,
    },
    ok,
    route_steps: [codexRoute, claudeRoute],
    temp_root: tempRoot,
    workspace_root: resolvedWorkspaceRoot,
  };

  writeJson(proofOutputPath, result);

  if (!ok) {
    throw new LocalRuntimesProofError(
      "local runtimes proof failed; inspect diagnostics or route selection output",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runLocalRuntimesProof(), null, 2));
  } catch (error) {
    if (error instanceof LocalRuntimesProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  LocalRuntimesProofError,
  runLocalRuntimesProof,
};
