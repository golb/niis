import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { createAdapterDefinition } from "../core/src/contracts/adapter.js";
import {
  RuntimeReadSandboxError,
  createRuntimeExecutionSandboxInvocation,
} from "./runtime-read-sandbox.js";

class LocalCliAdapterError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "LocalCliAdapterError";
    this.category = options.category ?? "transient";
    this.retrySafe = options.retrySafe ?? false;
    this.escalationHint = options.escalationHint ?? null;
  }
}

function buildErrorResponse(error, summaryPrefix) {
  const normalizedError = error instanceof LocalCliAdapterError
    ? error
    : new LocalCliAdapterError(error instanceof Error ? error.message : String(error), {
      category: error instanceof RuntimeReadSandboxError
        ? error.category
        : "transient",
      retrySafe: error instanceof RuntimeReadSandboxError
        ? error.retrySafe
        : true,
      escalationHint: error instanceof RuntimeReadSandboxError
        ? "Restore the supported OS execution sandbox before starting a new attempt."
        : "Inspect the local runtime command and retry after the CLI shim is healthy.",
    });

  return {
    status: "ERROR",
    summary: `${summaryPrefix}: ${normalizedError.message}`,
    next_actions: [
      "Inspect the configured local runtime command and arguments.",
      "Retry only after the local CLI shim reports healthy diagnostics.",
    ],
    artifacts: [],
    cost: null,
    completion_signal: null,
    self_assessment: null,
    error: {
      root_cause: normalizedError.message,
      category: normalizedError.category,
      retry_safe: normalizedError.retrySafe,
      retry_instruction: normalizedError.retrySafe
        ? "Retry after the local runtime CLI issue is resolved."
        : null,
      stop_condition: "Local runtime adapter could not complete the requested CLI interaction.",
      escalation_hint: normalizedError.escalationHint,
    },
  };
}

function parseStructuredOutput(stdout) {
  const trimmed = stdout.trim();

  if (trimmed === "") {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractCostFromJsonlStream(stdout) {
  const lines = stdout.trim().split("\n");
  let usage = null;
  let totalCostUsd = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.usage) {
        usage = event.usage;
        totalCostUsd = Number(event.total_cost_usd ?? usage.total_cost_usd ?? 0);
        break;
      }
      if (event.type === "turn.completed" && event.usage) {
        usage = event.usage;
        totalCostUsd = Number(event.total_cost_usd ?? usage.total_cost_usd ?? 0);
        break;
      }
    } catch {
      continue;
    }
  }
  if (!usage) return null;
  return {
    cached_input_tokens: Number(usage.cached_input_tokens ?? 0),
    estimated_usd: totalCostUsd,
    input_tokens: Number(usage.input_tokens ?? 0),
    output_tokens: Number(usage.output_tokens ?? 0),
  };
}

function extractCostFromClaudeJson(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const usage = parsed.usage;
  if (!usage) return null;
  return {
    cached_input_tokens: Number(usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? 0),
    estimated_usd: Number(parsed.total_cost_usd ?? 0),
    input_tokens: Number(usage.input_tokens ?? 0),
    output_tokens: Number(usage.output_tokens ?? 0),
  };
}

function extractCostFromStderr(stderr) {
  if (!stderr || typeof stderr !== "string") return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  const tokenPatterns = [
    /(\d[\d,]*)\s*input\s*tokens?/i,
    /input[_\s]*tokens?\s*[:=]\s*(\d[\d,]*)/i,
  ];
  for (const pattern of tokenPatterns) {
    const match = stderr.match(pattern);
    if (match) { inputTokens = Number(match[1].replace(/,/g, "")); break; }
  }

  const outputPatterns = [
    /(\d[\d,]*)\s*output\s*tokens?/i,
    /output[_\s]*tokens?\s*[:=]\s*(\d[\d,]*)/i,
  ];
  for (const pattern of outputPatterns) {
    const match = stderr.match(pattern);
    if (match) { outputTokens = Number(match[1].replace(/,/g, "")); break; }
  }

  const costPatterns = [
    /\$\s*([\d.]+)/,
    /cost\s*[:=]\s*\$?([\d.]+)/i,
    /total_cost_usd\s*[:=]\s*([\d.]+)/i,
  ];
  for (const pattern of costPatterns) {
    const match = stderr.match(pattern);
    if (match) { costUsd = Number(match[1]); break; }
  }

  if (inputTokens === 0 && outputTokens === 0 && costUsd === 0) return null;
  return { input_tokens: inputTokens, output_tokens: outputTokens, estimated_usd: costUsd };
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const PROCESS_TREE_TERM_GRACE_MS = 250;
const PROCESS_TREE_KILL_WAIT_MS = 2_000;
const PROCESS_TREE_POLL_MS = 20;

function waitForProcessTreePoll(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isProcessGroupAlive(processGroupId) {
  if (process.platform === "win32" || !Number.isInteger(processGroupId)) {
    return null;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalProcessTree(child, signalName) {
  if (process.platform !== "win32" && Number.isInteger(child?.pid)) {
    try {
      process.kill(-child.pid, signalName);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  }
  return child?.kill(signalName) ?? false;
}

async function waitForProcessTreeExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const groupAlive = isProcessGroupAlive(child?.pid);
    const alive = groupAlive === null
      ? child?.exitCode === null && child?.signalCode === null
      : groupAlive;
    if (!alive) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await waitForProcessTreePoll(Math.min(PROCESS_TREE_POLL_MS, remainingMs));
  }
}

async function terminateProcessTree(child) {
  let termError = null;
  try {
    signalProcessTree(child, "SIGTERM");
  } catch (error) {
    termError = error;
  }

  if (await waitForProcessTreeExit(child, PROCESS_TREE_TERM_GRACE_MS)) {
    return;
  }

  try {
    signalProcessTree(child, "SIGKILL");
  } catch (error) {
    termError ??= error;
  }

  if (await waitForProcessTreeExit(child, PROCESS_TREE_KILL_WAIT_MS)) {
    return;
  }

  const suffix = termError instanceof Error ? `: ${termError.message}` : "";
  throw new LocalCliAdapterError(
    `Local runtime process group ${child?.pid ?? "unknown"} remained alive after SIGKILL${suffix}`,
    {
      category: "env_block",
      retrySafe: false,
      escalationHint: "Stop the leaked local runtime process group before starting another attempt.",
    },
  );
}

function resolveExecutionWorkspace(context) {
  const requestedWorkspace = context.workspacePath
    ?? context.workspace_path
    ?? context.bootstrap_context?.workspace?.workspace_path;

  if (typeof requestedWorkspace !== "string" || requestedWorkspace.trim() === "") {
    throw new LocalCliAdapterError("Execution requires an explicit per-attempt workspace path.", {
      category: "env_block",
      retrySafe: false,
      escalationHint: "Materialize an isolated task worktree and pass workspace_path to the adapter.",
    });
  }

  const workspacePath = path.resolve(requestedWorkspace);
  if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
    throw new LocalCliAdapterError(`Execution workspace does not exist: ${workspacePath}`, {
      category: "env_block",
      retrySafe: false,
      escalationHint: "Repair or recreate the isolated task worktree before retrying.",
    });
  }

  return fs.realpathSync(workspacePath);
}

function resolveExecutionSandboxPolicy(context) {
  const snakePolicy = context.sandbox_policy;
  const camelPolicy = context.sandboxPolicy;
  if (
    snakePolicy
    && camelPolicy
    && !isDeepStrictEqual(snakePolicy, camelPolicy)
  ) {
    throw new LocalCliAdapterError(
      "Conflicting sandbox_policy and sandboxPolicy values.",
      {
        category: "env_block",
        retrySafe: false,
        escalationHint: "Pass one canonical workspace-write sandbox policy.",
      },
    );
  }
  const policy = snakePolicy ?? camelPolicy ?? {};
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new LocalCliAdapterError(
      "Local runtime sandbox policy must be an object.",
      {
        category: "env_block",
        retrySafe: false,
        escalationHint: "Pass a canonical workspace-write sandbox policy object.",
      },
    );
  }
  if (
    policy.mode !== undefined
    && policy.mode !== "workspace-write"
  ) {
    throw new LocalCliAdapterError(
      `Unsupported local runtime sandbox mode: ${policy.mode}.`,
      {
        category: "env_block",
        retrySafe: false,
        escalationHint: "Use workspace-write for isolated task execution.",
      },
    );
  }
  const deniedReadRoots =
    policy.denied_read_roots
    ?? policy.deniedReadRoots
    ?? [];
  return Object.freeze({
    deniedReadRoots,
    policy,
  });
}

function assertNoUnenforcedNetworkPolicy(context) {
  const snakePolicy = context.network_policy;
  const camelPolicy = context.networkPolicy;
  if (
    snakePolicy
    && camelPolicy
    && !isDeepStrictEqual(snakePolicy, camelPolicy)
  ) {
    throw new LocalCliAdapterError(
      "Conflicting network_policy and networkPolicy values.",
      { category: "env_block", retrySafe: false },
    );
  }
  const policy = snakePolicy ?? camelPolicy;
  if (policy !== undefined) {
    throw new LocalCliAdapterError(
      "Generic local CLI adapters cannot enforce task network policy; use a dedicated runtime adapter.",
      {
        category: "env_block",
        retrySafe: false,
        escalationHint: "Route the task through a runtime adapter with trusted network enforcement.",
      },
    );
  }
}

function runCliCommand({
  command,
  args = [],
  cwd = undefined,
  env = {},
  input = "",
  outputLimitBytes = 8 * 1024 * 1024,
  signal = null,
  timeoutMs = 30 * 60 * 1000,
}) {
  if (typeof command !== "string" || command.trim() === "") {
    throw new LocalCliAdapterError("Local CLI adapter requires a non-empty command.", {
      category: "env_block",
      retrySafe: false,
      escalationHint: "Provide a valid local runtime executable before running diagnostics or execution.",
    });
  }

  if (signal?.aborted) {
    throw new LocalCliAdapterError("Local runtime execution was cancelled before start.", {
      category: "cancelled",
      retrySafe: false,
      escalationHint: "Start a new attempt only if the operator still wants the task executed.",
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const normalizedTimeoutMs = normalizePositiveInteger(timeoutMs, 30 * 60 * 1000);
    const normalizedOutputLimit = normalizePositiveInteger(outputLimitBytes, 8 * 1024 * 1024);
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let cancelled = false;
    let terminationError = null;
    let terminationPromise = null;

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener?.("abort", abortHandler);
    };
    const stopTree = () => {
      if (!terminationPromise) {
        terminationPromise = terminateProcessTree(child).catch((error) => {
          terminationError = error;
        });
      }
    };
    const finishWithError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const appendOutput = (channel, chunk) => {
      const text = chunk.toString("utf8");
      capturedBytes += Buffer.byteLength(text);
      if (capturedBytes > normalizedOutputLimit) {
        outputExceeded = true;
        stopTree();
        return;
      }

      if (channel === "stdout") stdout += text;
      else stderr += text;
    };
    const abortHandler = () => {
      cancelled = true;
      stopTree();
    };
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      stopTree();
    }, normalizedTimeoutMs);
    timeoutHandle.unref?.();

    signal?.addEventListener?.("abort", abortHandler, { once: true });
    child.stdout.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => appendOutput("stderr", chunk));
    child.stdin.on("error", (error) => {
      if (error?.code === "EPIPE") return;
      finishWithError(new LocalCliAdapterError(`Failed to send input to local runtime: ${error.message}`, {
        category: "transient",
        retrySafe: true,
        escalationHint: "Inspect the local runtime command before retrying.",
      }));
    });
    child.once("error", (error) => {
      finishWithError(new LocalCliAdapterError(`Failed to start local runtime command: ${error.message}`, {
        category: "env_block",
        retrySafe: false,
        escalationHint: "Install or fix the local runtime executable and retry diagnostics.",
      }));
    });
    child.once("close", async (exitCode) => {
      if (settled) return;
      if (terminationPromise) {
        await terminationPromise;
      }
      settled = true;
      cleanup();

      if (terminationError) {
        reject(terminationError);
        return;
      }
      if (cancelled) {
        reject(new LocalCliAdapterError("Local runtime execution was cancelled.", {
          category: "cancelled",
          retrySafe: false,
          escalationHint: "Start a new attempt only after explicit operator action.",
        }));
        return;
      }
      if (timedOut) {
        reject(new LocalCliAdapterError(`Local runtime exceeded timeout ${normalizedTimeoutMs}ms.`, {
          category: "transient",
          retrySafe: false,
          escalationHint: "Inspect the preserved task workspace before starting a bounded new attempt.",
        }));
        return;
      }
      if (outputExceeded) {
        reject(new LocalCliAdapterError(`Local runtime exceeded output limit ${normalizedOutputLimit} bytes.`, {
          category: "env_block",
          retrySafe: false,
          escalationHint: "Inspect the runtime for runaway output before retrying.",
        }));
        return;
      }

      resolve(Object.freeze({
        exit_code: exitCode ?? 1,
        ok: exitCode === 0,
        stderr: stderr.trim(),
        stdout: stdout.trim(),
      }));
    });

    child.stdin.end(input);
  });
}

function normalizeExecutionResult(rawResult, runtimeLabel) {
  const structured = parseStructuredOutput(rawResult.stdout);

  if (rawResult.ok && structured?.status) {
    if (!structured.cost) {
      structured.cost = extractCostFromClaudeJson(structured)
        ?? extractCostFromStderr(rawResult.stderr);
    }
    return structured;
  }

  const jsonlCost = extractCostFromJsonlStream(rawResult.stdout);
  const stderrCost = extractCostFromStderr(rawResult.stderr);
  const cost = jsonlCost ?? extractCostFromClaudeJson(structured) ?? stderrCost ?? null;

  if (rawResult.ok) {
    const rawSummary = structured?.result
      ?? rawResult.stdout?.split("\n").filter((l) => !l.startsWith("{")).join("\n").trim();
    const summary = rawSummary || `${runtimeLabel} local runtime command completed successfully.`;
    return {
      status: "SUCCESS",
      summary,
      next_actions: [],
      artifacts: [],
      cost,
      completion_signal: true,
      self_assessment: null,
      error: null,
    };
  }

  return buildErrorResponse(
    new LocalCliAdapterError(
      rawResult.stderr || rawResult.stdout || `${runtimeLabel} local runtime command failed`,
      {
        category: "env_block",
        retrySafe: false,
        escalationHint: "Inspect the local runtime stderr output and fix the CLI shim before retrying.",
      },
    ),
    `${runtimeLabel} execution failed`,
  );
}

function createLocalCliAdapter({
  id,
  runtimeLabel,
  adapterKind,
  command,
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
  const sharedConfig = {
    args,
    command,
    cwd,
    env,
  };

  return createAdapterDefinition({
    id,
    protocolType: "local_cli",
    capabilities: {
      adapterKind,
      operations: ["execute", "runtime_tools.execute", ...(capabilities.operations ?? [])],
      permissions: capabilities.permissions ?? [],
      privilegedOperations: capabilities.privilegedOperations ?? [],
      toolFamilies: capabilities.toolFamilies ?? ["shell", "local_cli"],
      allow: capabilities.allow ?? {},
      deny: capabilities.deny ?? {},
    },
    execute: async (context = {}) => {
      try {
        const workspacePath = resolveExecutionWorkspace(context);
        assertNoUnenforcedNetworkPolicy(context);
        const attemptId = context.attemptId ?? context.attempt_id ?? null;
        const executionSandbox = resolveExecutionSandboxPolicy(context);
        const invocation = createRuntimeExecutionSandboxInvocation({
          args: sharedConfig.args,
          commandPath: sharedConfig.command,
          deniedReadRoots: executionSandbox.deniedReadRoots,
          workspaceRoot: workspacePath,
        });
        let result;
        try {
          result = await runCliCommand({
            args: invocation.args,
            command: invocation.command,
            cwd: workspacePath,
            env: {
              ...sharedConfig.env,
              ...invocation.env,
              ...(attemptId ? { NIIS_ATTEMPT_ID: String(attemptId) } : {}),
              NIIS_EXECUTION_SANDBOX_BACKEND: invocation.backend,
              NIIS_EXECUTION_WORKSPACE: workspacePath,
              ...(context.sandbox_policy
                ? { NIIS_SANDBOX_POLICY: JSON.stringify(context.sandbox_policy) }
                : {}),
            },
            input: JSON.stringify(context),
            outputLimitBytes:
              context.output_limit_bytes
              ?? context.outputLimitBytes,
            signal: context.abort_signal ?? context.abortSignal ?? null,
            timeoutMs: context.timeout_ms ?? context.timeoutMs,
          });
        } finally {
          invocation.cleanup();
        }
        return normalizeExecutionResult(result, runtimeLabel);
      } catch (error) {
        return buildErrorResponse(error, `${runtimeLabel} execution failed`);
      }
    },
    normalize: (result) => {
      if (result?.status) {
        return result;
      }

      return buildErrorResponse(
        new LocalCliAdapterError("Local runtime adapter received an opaque result payload.", {
          retrySafe: false,
        }),
        `${runtimeLabel} normalization failed`,
      );
    },
    requiredEnv: () => requiredEnv,
    optionalEnv: () => optionalEnv,
    runtimeTools,
    sessionCodec: {
      serialize: (sessionParams) => ({
        ...sessionParams,
      }),
      deserialize: (stored) => ({
        ...stored,
      }),
      compactionHandoff: (sessions) =>
        `${runtimeLabel} handoff for ${sessions.length} session(s)`,
    },
    test: async () => {
      try {
        const result = await runCliCommand({
          ...sharedConfig,
          args: diagnosticArgs,
          timeoutMs: 30_000,
        });

        return {
          ok: result.ok,
          checks: [
            {
              name: `${adapterKind}.version`,
              status: result.ok ? "PASS" : "FAIL",
              message: result.ok
                ? (result.stdout || `${runtimeLabel} local runtime CLI is available.`)
                : (result.stderr || result.stdout || `${runtimeLabel} local runtime CLI failed diagnostics.`),
            },
          ],
        };
      } catch (error) {
        return {
          ok: false,
          checks: [
            {
              name: `${adapterKind}.version`,
              status: "FAIL",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
    metadata,
  });
}

export {
  LocalCliAdapterError,
  createLocalCliAdapter,
};
