import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runAdapterDiagnostics } from "../../core/src/contracts/adapter.js";
import { createClaudeCodeLocalAdapter } from "../../adapters/claude-code-local-adapter.js";
import { createCodexLocalAdapter } from "../../adapters/codex-local-adapter.js";

class HostLocalRuntimesProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "HostLocalRuntimesProofError";
    this.result = result;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntrypoint = path.resolve(__dirname, "..", "bin", "niis.js");

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveFlagValue(args, flagName) {
  const index = args.indexOf(flagName);
  if (index === -1) {
    return null;
  }

  return args[index + 1] ?? null;
}

function findCommandOnPath(commandNames) {
  for (const commandName of commandNames) {
    const result = spawnSync("which", [commandName], {
      encoding: "utf8",
    });

    if (result.status === 0) {
      return result.stdout.trim();
    }
  }

  return null;
}

function resolveRuntimeBinary({ envKey, fallbackCommands }) {
  const explicitPath = process.env[envKey];

  if (typeof explicitPath === "string" && explicitPath.trim() !== "") {
    return path.resolve(explicitPath.trim());
  }

  return findCommandOnPath(fallbackCommands);
}

function createRouteSpec({ runtimeId, commandPath, workspaceRoot }) {
  return {
    adapters: [{
      command: commandPath,
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
      id: `${runtimeId}-host-role`,
      lane: "generalist",
      safe_fallback: true,
      toolFamilies: ["shell"],
    }],
    task: {
      id: `${runtimeId.replaceAll("_", "-")}-host-task`,
      priority: "medium",
      title: `Use ${runtimeId} host runtime`,
    },
    workspaceRoot,
  };
}

function runRouteStep({ runtimeId, commandPath, workspaceRoot }) {
  const specPath = path.join(workspaceRoot, `${runtimeId}-host-route.json`);
  writeJson(specPath, createRouteSpec({ runtimeId, commandPath, workspaceRoot }));
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

async function runHostLocalRuntimesProof({
  workspaceRoot = null,
  outputRoot = null,
} = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-host-local-runtimes-proof-"));
  const resolvedWorkspaceRoot = workspaceRoot
    ? path.resolve(workspaceRoot)
    : path.join(tempRoot, "workspace");
  const resolvedOutputRoot = outputRoot
    ? path.resolve(outputRoot)
    : path.join(tempRoot, "artifacts");

  ensureDirectory(resolvedWorkspaceRoot);
  ensureDirectory(resolvedOutputRoot);

  const codexPath = resolveRuntimeBinary({
    envKey: "NIIS_CODEX_LOCAL_BIN",
    fallbackCommands: ["codex"],
  });
  const claudePath = resolveRuntimeBinary({
    envKey: "NIIS_CLAUDE_CODE_LOCAL_BIN",
    fallbackCommands: ["claude-code", "claude"],
  });
  const missingRuntimes = [
    ...(codexPath ? [] : ["codex_local"]),
    ...(claudePath ? [] : ["claude_code_local"]),
  ];
  const proofOutputPath = path.join(resolvedOutputRoot, "host-local-runtimes-proof.json");

  if (missingRuntimes.length > 0) {
    const blockedResult = {
      artifacts: {
        proof_output_path: proofOutputPath,
      },
      missing_runtimes: missingRuntimes,
      ok: false,
      reason:
        "Host-installed local runtime smoke is blocked because one or more required binaries are missing from PATH. "
        + "Set NIIS_CODEX_LOCAL_BIN / NIIS_CLAUDE_CODE_LOCAL_BIN to explicit paths after installation.",
      status: "blocked",
      temp_root: tempRoot,
      workspace_root: resolvedWorkspaceRoot,
    };

    writeJson(proofOutputPath, blockedResult);
    throw new HostLocalRuntimesProofError(
      "host local runtimes proof blocked; required binaries are missing",
      blockedResult,
    );
  }

  const codexAdapter = createCodexLocalAdapter({
    command: codexPath,
  });
  const claudeAdapter = createClaudeCodeLocalAdapter({
    command: claudePath,
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
    commandPath: codexPath,
    runtimeId: "codex_local",
    workspaceRoot: resolvedWorkspaceRoot,
  });
  const claudeRoute = runRouteStep({
    commandPath: claudePath,
    runtimeId: "claude_code_local",
    workspaceRoot: resolvedWorkspaceRoot,
  });
  const result = {
    artifacts: {
      proof_output_path: proofOutputPath,
    },
    diagnostics: {
      claude_code_local: claudeDiagnostics,
      codex_local: codexDiagnostics,
    },
    host_binaries: {
      claude_code_local: claudePath,
      codex_local: codexPath,
    },
    ok: [
      codexDiagnostics.ok,
      claudeDiagnostics.ok,
      codexRoute.ok,
      claudeRoute.ok,
      codexRoute.parsed_json?.selected_adapter?.id === "codex_local",
      claudeRoute.parsed_json?.selected_adapter?.id === "claude_code_local",
    ].every(Boolean),
    route_steps: [codexRoute, claudeRoute],
    status: "ok",
    temp_root: tempRoot,
    workspace_root: resolvedWorkspaceRoot,
  };

  writeJson(proofOutputPath, result);

  if (!result.ok) {
    throw new HostLocalRuntimesProofError(
      "host local runtimes proof failed; inspect diagnostics or route selection output",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runHostLocalRuntimesProof({
      outputRoot: resolveFlagValue(process.argv, "--output-root"),
      workspaceRoot: resolveFlagValue(process.argv, "--workspace-root"),
    }), null, 2));
  } catch (error) {
    if (error instanceof HostLocalRuntimesProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  HostLocalRuntimesProofError,
  runHostLocalRuntimesProof,
};
