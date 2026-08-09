import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { createAdapterDefinition } from "../../core/src/contracts/adapter.js";
import { resolveRuntimeCommand } from "../../core/src/runtime/bootstrap-surface.js";
import {
  isContextSourceAllowed,
  partitionExecutionGuides,
} from "../../core/src/contracts/context-contract.js";
import { computeEstimatedUsd } from "./pricing.js";
import { runCodexAppServerExecution } from "../../adapters/codex-app-server-adapter.js";
import {
  createRuntimeExecutionSandboxInvocation,
  createRuntimeReadSandboxInvocation,
  normalizeRuntimeDeniedReadRoots,
  resolveRuntimeDeniedReadRoots,
} from "../../adapters/runtime-read-sandbox.js";





function resolveCodexExecutor() {
  return runCodexAppServerExecution;
}

class IntakeRuntimeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "IntakeRuntimeError";
    this.category = options.category ?? "env_block";
    this.retrySafe = options.retrySafe ?? false;
  }
}

const PLANNER_RUNTIME_OPTIONS = Object.freeze(["codex", "claude"]);
const DEFAULT_PLANNER_TIMEOUT_MS = 60_000;
const CLAUDE_READ_ONLY_TOOLS = Object.freeze(["Read", "Glob", "Grep"]);
const CLAUDE_EDITING_TOOLS = Object.freeze([
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
]);
const CLAUDE_SUPPORTED_TOOLS = new Set(CLAUDE_EDITING_TOOLS);

const INTAKE_PLANNER_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    target_paths: {
      type: "array",
      items: { type: "string" },
    },
    operator_guidance: {
      type: "array",
      items: { type: "string" },
    },
    acceptance_checks: {
      type: "array",
      items: { type: "string" },
    },
    acceptance_commands: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          argv: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
          },
          required: { type: "boolean" },
        },
        required: ["id", "argv", "required"],
      },
    },
    out_of_scope: {
      type: "array",
      items: { type: "string" },
    },
    priority: { type: "string" },
    phase: { type: "integer" },
    subtasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          role_id: { type: ["string", "null"] },
          depends_on: {
            type: "array",
            items: { type: "integer" },
          },
        },
        required: ["title", "role_id", "depends_on"],
      },
    },
  },
  required: ["title", "summary", "target_paths", "operator_guidance", "acceptance_checks", "acceptance_commands", "out_of_scope", "priority", "phase", "subtasks"],
});

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new IntakeRuntimeError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeClaudeToolList(value, label = "allowedTools") {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((tool) =>
      typeof tool !== "string"
      || tool.trim() === ""
      || /[\r\n\0]/u.test(tool))
  ) {
    throw new IntakeRuntimeError(
      `Claude execution ${label} must be a non-empty array of single-line strings`,
    );
  }

  const normalized = [...new Set(value.map((tool) => tool.trim()))];
  const unsupported = normalized.filter((tool) => !CLAUDE_SUPPORTED_TOOLS.has(tool));
  if (unsupported.length > 0) {
    throw new IntakeRuntimeError(
      `Claude execution ${label} contains unsupported tools: ${unsupported.join(", ")}`,
      { category: "env_block", retrySafe: false },
    );
  }
  return normalized;
}

function appendClaudeSecurityArgs(args, {
  allowedTools = CLAUDE_READ_ONLY_TOOLS,
  permissionMode = "plan",
  workspaceRoot,
} = {}) {
  if (!["acceptEdits", "dontAsk", "plan"].includes(permissionMode)) {
    throw new IntakeRuntimeError(
      "Claude execution permissionMode must be acceptEdits, dontAsk, or plan",
    );
  }
  const normalizedAllowedTools = normalizeClaudeToolList(allowedTools);
  const scopedAllowedTools = workspaceRoot
    ? normalizedAllowedTools.map((tool) => `${tool}(./**)`)
    : normalizedAllowedTools;
  args.push(
    "--tools",
    normalizedAllowedTools.join(","),
    "--allowedTools",
    scopedAllowedTools.join(","),
    "--mcp-config",
    "{}",
    "--strict-mcp-config",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--no-chrome",
    "--permission-mode",
    permissionMode,
  );
  return normalizedAllowedTools;
}

function resolveExecutionPolicy(context, camelKey, snakeKey, label) {
  const camelValue = context?.[camelKey];
  const snakeValue = context?.[snakeKey];
  if (
    camelValue !== undefined
    && snakeValue !== undefined
    && JSON.stringify(camelValue) !== JSON.stringify(snakeValue)
  ) {
    throw new IntakeRuntimeError(
      `${label} declarations conflict`,
      { category: "env_block", retrySafe: false },
    );
  }
  const value = snakeValue ?? camelValue;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IntakeRuntimeError(
      `${label} is required by the executor adapter`,
      { category: "env_block", retrySafe: false },
    );
  }
  return value;
}

function assertBuiltinExecutorPolicies(context, workspaceRoot) {
  const networkPolicy = resolveExecutionPolicy(
    context,
    "networkPolicy",
    "network_policy",
    "network policy",
  );
  const sandboxPolicy = resolveExecutionPolicy(
    context,
    "sandboxPolicy",
    "sandbox_policy",
    "sandbox policy",
  );

  if (networkPolicy.mode !== "disabled") {
    throw new IntakeRuntimeError(
      `unsupported executor network policy mode: ${networkPolicy.mode ?? "missing"}`,
      { category: "env_block", retrySafe: false },
    );
  }
  if (sandboxPolicy.mode !== "workspace-write") {
    throw new IntakeRuntimeError(
      `unsupported executor sandbox policy mode: ${sandboxPolicy.mode ?? "missing"}`,
      { category: "env_block", retrySafe: false },
    );
  }
  if (
    sandboxPolicy.concurrency !== undefined
    && sandboxPolicy.concurrency !== 1
  ) {
    throw new IntakeRuntimeError(
      "executor sandbox policy supports concurrency 1 only",
      { category: "env_block", retrySafe: false },
    );
  }

  const deniedReadRoots =
    sandboxPolicy.denied_read_roots
    ?? sandboxPolicy.deniedReadRoots;
  normalizeRuntimeDeniedReadRoots({
    deniedReadRoots,
    workspaceRoot,
  });

  return Object.freeze({
    deniedReadRoots: Object.freeze([...deniedReadRoots]),
    networkPolicy,
    sandboxPolicy,
  });
}

function buildErrorAdapterResponse(error, runtimeId, summaryPrefix) {
  const normalizedError = error instanceof IntakeRuntimeError
    ? error
    : new IntakeRuntimeError(error instanceof Error ? error.message : String(error));

  return {
    status: "ERROR",
    summary: `${summaryPrefix}: ${normalizedError.message}`,
    next_actions: [
      "Inspect the selected local runtime command and authentication state.",
      "Retry only after the local runtime reports healthy diagnostics.",
    ],
    artifacts: [],
    cost: null,
    completion_signal: false,
    self_assessment: null,
    error: {
      root_cause: normalizedError.message,
      category: normalizedError.category,
      retry_safe: normalizedError.retrySafe,
      retry_instruction: normalizedError.retrySafe ? "Retry once the local runtime issue is resolved." : null,
      stop_condition: `${runtimeId} could not complete the requested Niis operation.`,
      escalation_hint: "Fix or authenticate the local runtime before retrying the task.",
    },
  };
}

function resolveRuntimeBinary({ envKey, fallbackCommands, fallbackPaths = [] }) {
  return resolveRuntimeCommand({
    commandNames: fallbackCommands,
    envKey,
    fallbackPaths,
  });
}

function resolvePreferredRuntimeDefinitions({ preferredRuntime = null } = {}) {
  const codexPath = resolveRuntimeBinary({
    envKey: "NIIS_CODEX_LOCAL_BIN",
    fallbackCommands: ["codex"],
    fallbackPaths: [
      "/Applications/Codex.app/Contents/Resources/codex",
    ],
  });
  const claudePath = resolveRuntimeBinary({
    envKey: "NIIS_CLAUDE_CODE_LOCAL_BIN",
    fallbackCommands: ["claude-code", "claude"],
    fallbackPaths: [
      "~/.local/bin/claude",
      "/Applications/Claude.app/Contents/MacOS/claude",
    ],
  });

  const runtimes = [
    ...(codexPath ? [{
      commandPath: codexPath,
      runtimeId: "codex_local",
      selector: "codex",
    }] : []),
    ...(claudePath ? [{
      commandPath: claudePath,
      runtimeId: "claude_code_local",
      selector: "claude",
    }] : []),
  ];

  if (preferredRuntime === null || preferredRuntime === undefined) {
    return Object.freeze(runtimes);
  }

  if (!PLANNER_RUNTIME_OPTIONS.includes(preferredRuntime)) {
    throw new IntakeRuntimeError(
      `preferredRuntime must be one of ${PLANNER_RUNTIME_OPTIONS.join(", ")}`,
    );
  }

  return Object.freeze(runtimes.filter((runtime) => runtime.selector === preferredRuntime));
}

function extractTextOutput(rawValue) {
  if (typeof rawValue === "string") {
    return rawValue.trim();
  }

  if (rawValue && typeof rawValue === "object" && typeof rawValue.result === "string") {
    return rawValue.result.trim();
  }

  return "";
}

function parseJsonText(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikePlannerPayload(value) {
  return isPlainObject(value) && (
    "title" in value
    || "summary" in value
    || "target_paths" in value
    || "operator_guidance" in value
    || "acceptance_checks" in value
    || "acceptance_commands" in value
    || "out_of_scope" in value
    || "priority" in value
    || "phase" in value
    || "subtasks" in value
  );
}

function summarizeText(value, maxLength = 280) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, " ");

  if (normalized === "") {
    return null;
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
    : normalized;
}

function extractFencedJson(text) {
  if (typeof text !== "string") {
    return null;
  }

  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() || null;
}

function extractBalancedJsonCandidate(text) {
  if (typeof text !== "string") {
    return null;
  }

  const openingIndex = text.search(/[{\[]/);
  if (openingIndex < 0) {
    return null;
  }

  const opener = text[openingIndex];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openingIndex; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === opener) {
      depth += 1;
      continue;
    }

    if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openingIndex, index + 1);
      }
    }
  }

  return null;
}

function parseCodexJsonl(stdout) {
  const messages = [];
  let errorMessage = null;

  for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const event = parseJsonText(line);
    if (!isPlainObject(event)) {
      continue;
    }

    const type = typeof event.type === "string" ? event.type : "";

    if (type === "error") {
      const message = typeof event.message === "string" ? event.message.trim() : "";
      if (message) {
        errorMessage = message;
      }
      continue;
    }

    if (type === "turn.failed") {
      const error = isPlainObject(event.error) ? event.error : {};
      const message = typeof error.message === "string" ? error.message.trim() : "";
      if (message) {
        errorMessage = message;
      }
      continue;
    }

    if (type === "item.completed") {
      const item = isPlainObject(event.item) ? event.item : {};
      if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim() !== "") {
        messages.push(item.text.trim());
      }
    }
  }

  return Object.freeze({
    errorMessage,
    summary: messages.join("\n\n").trim(),
  });
}

function normalizePlannerParsedValue(value, seen = new Set()) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const normalizedText = value.trim();

    if (normalizedText === "" || seen.has(normalizedText)) {
      return null;
    }

    seen.add(normalizedText);

    const direct = parseJsonText(normalizedText);
    if (direct !== null) {
      const directNormalized = normalizePlannerParsedValue(direct, seen);
      if (looksLikePlannerPayload(directNormalized)) {
        return directNormalized;
      }
    }

    const fenced = extractFencedJson(normalizedText);
    if (fenced) {
      const fencedNormalized = normalizePlannerParsedValue(fenced, seen);
      if (looksLikePlannerPayload(fencedNormalized)) {
        return fencedNormalized;
      }
    }

    const balanced = extractBalancedJsonCandidate(normalizedText);
    if (balanced && balanced !== normalizedText) {
      const balancedNormalized = normalizePlannerParsedValue(balanced, seen);
      if (looksLikePlannerPayload(balancedNormalized)) {
        return balancedNormalized;
      }
    }

    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalizedEntry = normalizePlannerParsedValue(entry, seen);
      if (looksLikePlannerPayload(normalizedEntry)) {
        return normalizedEntry;
      }
    }

    return null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  if (looksLikePlannerPayload(value)) {
    return value;
  }

  for (const key of ["result", "content", "output", "text", "message"]) {
    if (key in value) {
      const normalizedNested = normalizePlannerParsedValue(value[key], seen);
      if (looksLikePlannerPayload(normalizedNested)) {
        return normalizedNested;
      }
    }
  }

  for (const key of ["data", "payload", "response", "planner"]) {
    if (key in value) {
      const normalizedNested = normalizePlannerParsedValue(value[key], seen);
      if (looksLikePlannerPayload(normalizedNested)) {
        return normalizedNested;
      }
    }
  }

  if (Array.isArray(value.messages)) {
    const normalizedMessages = normalizePlannerParsedValue(value.messages, seen);
    if (looksLikePlannerPayload(normalizedMessages)) {
      return normalizedMessages;
    }
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (["result", "content", "output", "text", "message", "data", "payload", "response", "planner", "messages"].includes(key)) {
      continue;
    }

    const normalizedNested = normalizePlannerParsedValue(nestedValue, seen);
    if (looksLikePlannerPayload(normalizedNested)) {
      return normalizedNested;
    }
  }

  return null;
}

function runCommand(command, args, {
  cwd,
  env = {},
  input = "",
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    input,
  });

  if (result.error) {
    throw new IntakeRuntimeError(`failed to start local runtime: ${result.error.message}`);
  }

  return Object.freeze({
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    stderr: result.stderr?.trim() ?? "",
    stdout: result.stdout?.trim() ?? "",
  });
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
  throw new IntakeRuntimeError(
    `local runtime process group ${child?.pid ?? "unknown"} remained alive after SIGKILL${suffix}`,
    { category: "env_block", retrySafe: false },
  );
}

function runCommandAsync(command, args, {
  cwd,
  env = {},
  input = "",
  signal = null,
  timeoutMs = null,
} = {}) {
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

    const stdoutChunks = [];
    const stderrChunks = [];
    let aborted = false;
    let abortListener = null;
    let closed = false;
    let terminationError = null;
    let terminationPromise = null;
    let timeoutHandle = null;
    const abortTree = () => {
      if (aborted) return;
      aborted = true;
      terminationPromise = terminateProcessTree(child).catch((error) => {
        terminationError = error;
      });
    };
    const cleanup = () => {
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };

    if (signal) {
      if (signal.aborted) {
        abortTree();
      } else {
        abortListener = abortTree;
        signal.addEventListener("abort", abortListener, { once: true });
      }
    }
    if (Number.isInteger(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeout(abortTree, timeoutMs);
      timeoutHandle.unref?.();
    }

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      if (closed) return;
      closed = true;
      cleanup();
      reject(new IntakeRuntimeError(`failed to start local runtime: ${error.message}`));
    });

    child.on("close", async (code) => {
      if (closed) return;
      if (terminationPromise) {
        await terminationPromise;
      }
      closed = true;
      cleanup();
      if (terminationError) {
        reject(terminationError);
        return;
      }
      if (aborted) {
        reject(new IntakeRuntimeError("subtask aborted (timeout or cancellation)"));
        return;
      }
      resolve(Object.freeze({
        exit_code: code ?? 1,
        ok: code === 0,
        stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
      }));
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

async function runReadContainedRuntimeCommand(command, args, {
  cwd,
  deniedReadRoots = [],
  input = "",
  signal = null,
  timeoutMs = null,
} = {}) {
  const invocation = createRuntimeReadSandboxInvocation({
    args,
    commandPath: command,
    deniedReadRoots,
    workspaceRoot: cwd,
  });
  try {
    const result = await runCommandAsync(invocation.command, invocation.args, {
      cwd,
      input,
      signal,
      timeoutMs,
    });
    return Object.freeze({
      ...result,
      runtime_sandbox_backend: invocation.backend,
      sandbox_evidence: Object.freeze({
        applied_denied_read_roots: invocation.appliedDeniedReadRoots,
        skipped_denied_read_roots: invocation.skippedDeniedReadRoots,
      }),
    });
  } finally {
    invocation.cleanup();
  }
}

function runOptionalCommand(command, args, {
  cwd,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
  });

  if (result.error) {
    return null;
  }

  return Object.freeze({
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    stderr: result.stderr?.trim() ?? "",
    stdout: result.stdout?.trim() ?? "",
  });
}

function extractQuotedPromptLiterals(operatorPrompt) {
  const prompt = typeof operatorPrompt === "string" ? operatorPrompt : "";
  const literals = [];
  const patterns = [
    /"([^"\n]{3,120})"/g,
    /'([^'\n]{3,120})'/g,
    /`([^`\n]{3,120})`/g,
  ];

  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value) {
        literals.push(value);
      }
    }
  }

  return Array.from(new Set(literals));
}

function extractPromptPathFragments(operatorPrompt) {
  const prompt = typeof operatorPrompt === "string" ? operatorPrompt : "";
  const matches = prompt.match(/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g) ?? [];
  return Array.from(new Set(matches.map((entry) => entry.trim()).filter(Boolean)));
}

function extractPromptKeywords(operatorPrompt) {
  const prompt = typeof operatorPrompt === "string" ? operatorPrompt.toLowerCase() : "";
  const matches = prompt.match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  const stopwords = new Set([
    "page", "label", "rename", "related", "without", "change", "changes",
    "parser",
    "sources", "source", "target", "english", "string", "strings",
  ]);

  return Array.from(new Set(matches.filter((entry) => !stopwords.has(entry))));
}

function plannerPromptMentionsTests(operatorPrompt) {
  const prompt = typeof operatorPrompt === "string" ? operatorPrompt.toLowerCase() : "";
  return /\b(test|tests|testing|spec|specs|jest|vitest|mocha|cypress|playwright)\b/.test(prompt);
}

function isTestLikePath(candidatePath) {
  const normalized = String(candidatePath ?? "").toLowerCase();
  return (
    normalized.endsWith(".test.js")
    || normalized.endsWith(".test.ts")
    || normalized.endsWith(".test.tsx")
    || normalized.endsWith(".test.jsx")
    || normalized.endsWith(".spec.js")
    || normalized.endsWith(".spec.ts")
    || normalized.endsWith(".spec.tsx")
    || normalized.endsWith(".spec.jsx")
    || normalized.includes("/__tests__/")
  );
}

function shouldIncludePlannerHintPath(candidatePath, { includeTests = false } = {}) {
  const normalized = String(candidatePath ?? "").replace(/^\.\//, "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.startsWith("niis/") || normalized.startsWith(".niis/")) {
    return false;
  }

  if (!includeTests && isTestLikePath(normalized)) {
    return false;
  }

  return true;
}

function listWorkspaceFiles(workspaceRoot) {
  if (
    typeof workspaceRoot !== "string"
    || workspaceRoot.trim() === ""
    || !fs.existsSync(workspaceRoot)
    || !fs.statSync(workspaceRoot).isDirectory()
  ) {
    return [];
  }

  const result = runOptionalCommand("rg", ["--files"], {
    cwd: workspaceRoot,
  });

  if (result && (result.ok || result.exit_code === 1)) {
    return result.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  const files = [];
  const pending = [workspaceRoot];
  const ignoredDirectories = new Set([".git", ".niis", "node_modules"]);
  while (pending.length > 0) {
    const directoryPath = pending.pop();
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          pending.push(path.join(directoryPath, entry.name));
        }
      } else if (entry.isFile()) {
        files.push(path.relative(workspaceRoot, path.join(directoryPath, entry.name)).split(path.sep).join("/"));
      }
    }
  }
  return files.sort();
}

function searchFilesContainingLiteral(workspaceRoot, literal, maxMatches = 6) {
  if (typeof literal !== "string" || literal.trim() === "") {
    return [];
  }

  const result = runOptionalCommand("rg", ["-l", "-F", literal, "."], {
    cwd: workspaceRoot,
  });

  if (!result || (!result.ok && result.exit_code !== 1)) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.replace(/^\.\//, "").trim())
    .filter(Boolean)
    .slice(0, maxMatches);
}

function searchFilesByPathFragment(workspaceFiles, fragment, maxMatches = 6) {
  const normalized = typeof fragment === "string" ? fragment.trim().toLowerCase() : "";
  if (!normalized) {
    return [];
  }

  const normalizedParts = normalized.split("/").filter(Boolean);

  return workspaceFiles
    .filter((entry) => {
      const candidate = entry.toLowerCase();
      return normalizedParts.every((part) => candidate.includes(part));
    })
    .slice(0, maxMatches);
}

function searchFilesByPathFragmentWithFallback(workspaceFiles, fragment, maxMatches = 6) {
  const directMatches = searchFilesByPathFragment(workspaceFiles, fragment, maxMatches);
  if (directMatches.length > 0) {
    return directMatches;
  }

  const normalized = typeof fragment === "string" ? fragment.trim().toLowerCase() : "";
  const segments = normalized.split("/").filter(Boolean);

  for (const segment of segments.reverse()) {
    const segmentMatches = searchFilesByPathFragment(workspaceFiles, segment, maxMatches);
    if (segmentMatches.length > 0) {
      return segmentMatches;
    }
  }

  return [];
}

function buildPlannerContextHints({ operatorPrompt, workspaceRoot }) {
  const includeTests = plannerPromptMentionsTests(operatorPrompt);
  const workspaceFiles = listWorkspaceFiles(workspaceRoot)
    .filter((entry) => shouldIncludePlannerHintPath(entry, { includeTests }));
  if (workspaceFiles.length === 0) {
    return Object.freeze({
      candidatePaths: Object.freeze([]),
      promptBlock: "",
    });
  }

  const candidatePaths = [];
  const hintLines = [];

  const pushPaths = (paths = []) => {
    for (const candidatePath of paths) {
      if (typeof candidatePath !== "string" || candidatePath.trim() === "") {
        continue;
      }

      if (!shouldIncludePlannerHintPath(candidatePath, { includeTests })) {
        continue;
      }

      if (!candidatePaths.includes(candidatePath)) {
        candidatePaths.push(candidatePath);
      }
    }
  };

  for (const literal of extractQuotedPromptLiterals(operatorPrompt)) {
    const matches = searchFilesContainingLiteral(workspaceRoot, literal)
      .filter((entry) => shouldIncludePlannerHintPath(entry, { includeTests }));
    if (matches.length > 0) {
      pushPaths(matches);
      hintLines.push(`Files containing "${literal}": ${matches.join(", ")}`);
    }
  }

  const pathFragments = extractPromptPathFragments(operatorPrompt);
  for (const fragment of pathFragments) {
    const matches = searchFilesByPathFragmentWithFallback(workspaceFiles, fragment);
    if (matches.length > 0) {
      pushPaths(matches);
      hintLines.push(`Files matching path fragment "${fragment}": ${matches.join(", ")}`);
    }
  }

  const keywordMatches = [];
  for (const keyword of extractPromptKeywords(operatorPrompt)) {
    const matches = searchFilesByPathFragment(workspaceFiles, keyword);
    for (const match of matches) {
      if (!keywordMatches.includes(match)) {
        keywordMatches.push(match);
      }
    }
    if (keywordMatches.length >= 4) {
      break;
    }
  }
  if (keywordMatches.length > 0) {
    pushPaths(keywordMatches);
    hintLines.push(`Additional keyword-matched files: ${keywordMatches.join(", ")}`);
  }

  const promptBlock = hintLines.length > 0
    ? [
      "",
      "Local repository hints from a lightweight pre-scan:",
      ...hintLines.map((line) => `- ${line}`),
      "Prefer these files when setting target_paths if they actually match the task.",
    ].join("\n")
    : "";

  return Object.freeze({
    candidatePaths: Object.freeze(candidatePaths.slice(0, 8)),
    promptBlock,
  });
}






function loadCodemapSummaryForPlanner(workspaceRoot) {
  try {
    if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") return null;
    const codemapPath = path.join(workspaceRoot, ".niis", "exports", "codemap.json");
    if (!fs.existsSync(codemapPath)) return null;
    const codemap = JSON.parse(fs.readFileSync(codemapPath, "utf8"));
    if (!codemap || typeof codemap !== "object" || Array.isArray(codemap)) return null;
    const entries = Array.isArray(codemap.entries) ? codemap.entries : [];
    const stats = codemap.stats && typeof codemap.stats === "object" ? codemap.stats : {};
    const langCounts = new Map();
    const dirCounts = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (typeof entry.language === "string" && entry.language.trim() !== "") {
        langCounts.set(entry.language, (langCounts.get(entry.language) ?? 0) + 1);
      }
      if (typeof entry.path === "string" && entry.path.includes("/")) {
        const top = entry.path.split("/")[0];
        if (top !== "") dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
      }
    }
    const languages = [...langCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6)
      .map(([lang, count]) => `${lang} (${count})`);
    const topDirs = [...dirCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6)
      .map(([dir, count]) => `${dir}/ (${count})`);
    return {
      docsCount: Number.isFinite(stats.docs_count) ? stats.docs_count : 0,
      languages,
      sourceCount: Number.isFinite(stats.source_count) ? stats.source_count : 0,
      topDirs,
      totalFiles: Number.isFinite(stats.files_indexed) ? stats.files_indexed : entries.length,
    };
  } catch {
    return null;
  }
}

function formatCodemapForPlannerPrompt(summary) {
  if (!summary) return "";
  const lines = ["", "Project structure (from .niis/exports/codemap.json snapshot):"];
  lines.push(`- ${summary.totalFiles} files indexed (${summary.sourceCount} source, ${summary.docsCount} docs)`);
  if (summary.languages.length > 0) {
    lines.push(`- Languages: ${summary.languages.join(", ")}`);
  }
  if (summary.topDirs.length > 0) {
    lines.push(`- Top directories: ${summary.topDirs.join(", ")}`);
  }
  lines.push("Use this only to ground conventions/structure; live workspace hints below are authoritative for paths.");
  return lines.join("\n");
}

function buildPlannerPrompt({ operatorPrompt, workspaceRoot }) {
  const hints = buildPlannerContextHints({
    operatorPrompt,
    workspaceRoot,
  });
  const codemapBlock = formatCodemapForPlannerPrompt(
    loadCodemapSummaryForPlanner(workspaceRoot),
  );

  return [
    "You are the Niis intake planner.",
    "Read the operator request and return only JSON matching the provided schema.",
    "Do not include markdown fences or extra commentary.",
    "Infer likely target_paths when confident; otherwise return an empty array.",
    "Decompose only when the work has independent, parallelizable parts touching different files or different concerns.",
    "Default to a SINGLE subtask. Trivial tasks (rename one label, edit one file, change one config) MUST be a single subtask — do not split into grep/edit/verify ceremony.",
    "Only emit 2-5 subtasks when you can name concrete, non-duplicate steps that meaningfully differ in scope.",
    "DO decompose when the operator explicitly names multiple subtasks, or when the work cleanly splits across independent modules (e.g. add an API in one file + consume it in another, or implement + write tests for it). These are classic 2-subtask cases; emit them as such with depends_on reflecting the data flow.",
    "When subtasks are present, each subtask is an object with `title`, `role_id` (string or null), and `depends_on` (array of 1-based indices of prior subtasks it requires; empty if independent).",
    "Use depends_on to mark sequential work: subtask N that consumes the output of subtask M sets depends_on:[M]. Independent subtasks (different files, no data flow) keep depends_on:[].",
    "Examples of correct depends_on:",
    "  - [grep \u2192 edit \u2192 verify]: depends_on for edit is [1], for verify is [2] (sequential).",
    "  - [edit file A, edit file B (no overlap)]: both depends_on:[] (parallel-safe).",
    "  - [refactor module \u2192 update tests]: tests depend on refactor; depends_on:[1].",
    "Set `role_id` only when the subtask clearly belongs to a specialist:",
    "  - `frontend-specialist` for UI/CSS/HTML/JSX/Vue/Svelte/templates work",
    "  - `validator` for review/audit/test verification work",
    "Otherwise set `role_id` to null so the safe-fallback generalist-worker handles it. Do not invent role ids.",
    "Prefer concrete repository-relative file paths in target_paths when the task clearly points to them.",
    "Declare at least one deterministic acceptance command in `acceptance_commands`.",
    "Each command must have a stable lowercase `id`, an explicit boolean `required`, and a non-empty `argv` string array such as [\"npm\", \"test\"]. At least one command must set `required` to true.",
    "Never emit a shell command string, shell operator, redirection, variable expansion, command substitution, or shell interpolation in acceptance_commands.",
    "Acceptance commands are read-only verification. Use only: npm/yarn/pnpm test or run <non-lifecycle-script>; node --check <file> or node --test <file>; read-only git inspection; go test/vet; cargo check/clippy/fmt/test; tsc --noEmit; or non-writing eslint/prettier.",
    "Never request install, publish, release, version, commit, push, tag, formatter write/fix mode, node eval/import hooks, or an absolute executable path.",
    codemapBlock,
    hints.promptBlock,
    "",
    "Operator request:",
    operatorPrompt,
  ].filter(Boolean).join("\n");
}




const contextContractWarnedRoles = new Set();

function buildExecutionPrompt(context = {}) {
  const task = context.task ?? {};
  const referenceBundle = context.reference_bundle ?? {};
  const delegationPayload = context.delegation_payload ?? {};
  const contextContract = delegationPayload.context_contract ?? null;
  const roleId = typeof delegationPayload.role_id === "string" && delegationPayload.role_id.trim() !== ""
    ? delegationPayload.role_id
    : "unknown-role";
  if (!contextContract && !contextContractWarnedRoles.has(roleId)) {
    contextContractWarnedRoles.add(roleId);
    process.stderr.write(`[niis] Role ${roleId} has no context contract; execution prompt is composed from all default sources.\n`);
  }
  const allowSource = (source) => isContextSourceAllowed(contextContract, source);



  const guides = partitionExecutionGuides({
    contract: contextContract,
    guides: Array.isArray(referenceBundle.guides) ? referenceBundle.guides : [],
    roleId,
  }).map((entry) => entry.content);
  const targetPaths = Array.isArray(referenceBundle.target_paths) ? referenceBundle.target_paths : [];
  const acceptanceChecks = guides
    .filter((guide) => typeof guide === "string" && guide.startsWith("Acceptance check:"));
  const systemPrompt = typeof delegationPayload.system_prompt === "string" && delegationPayload.system_prompt.trim() !== ""
    ? delegationPayload.system_prompt.trim()
    : null;
  const authority = delegationPayload.authority ?? { can: [], cannot: [] };
  const qualityBar = Array.isArray(delegationPayload.quality_bar) ? delegationPayload.quality_bar : [];
  const qualityGates = Array.isArray(delegationPayload.quality_gates) ? delegationPayload.quality_gates : [];

  const sections = [];

  if (systemPrompt && allowSource("role_persona")) {
    sections.push("# Role persona");
    sections.push(systemPrompt);
    sections.push("");
  }

  sections.push(`Task ID: ${task.id ?? "unknown-task"}`);
  sections.push(`Task: ${task.title ?? "Unnamed task"}`);
  sections.push("");
  sections.push("Execute the task inside the current repository.");
  if (allowSource("routing_rationale")) {
    sections.push(`Why this lane: ${delegationPayload.why_this_lane ?? "Selected by routing policy."}`);
    sections.push(`Expected output: ${delegationPayload.expected_output ?? "Deliver the requested task outcome."}`);
  }

  if (allowSource("authority")) {
    if (Array.isArray(authority.can) && authority.can.length > 0) {
      sections.push("");
      sections.push("You CAN:");
      sections.push(...authority.can.map((entry) => `- ${entry}`));
    }
    if (Array.isArray(authority.cannot) && authority.cannot.length > 0) {
      sections.push("");
      sections.push("You CANNOT:");
      sections.push(...authority.cannot.map((entry) => `- ${entry}`));
    }
  }

  if (allowSource("target_paths")) {
    sections.push("");
    sections.push("Target paths:");
    sections.push(...(targetPaths.length > 0 ? targetPaths.map((entry) => `- ${entry}`) : ["- ."]));
  }
  if (allowSource("operator_guidance") || guides.length > 0) {
    sections.push("");
    sections.push("Operator guidance:");
    sections.push(...(guides.length > 0 ? guides.map((entry) => `- ${entry}`) : ["- Keep changes tightly scoped."]));
  }
  if (allowSource("acceptance_checks")) {
    sections.push("");
    sections.push("Acceptance checks:");
    sections.push(...(acceptanceChecks.length > 0
      ? acceptanceChecks.map((entry) => `- ${entry.replace(/^Acceptance check:\s*/, "")}`)
      : ["- Provide a concise summary and verification note."]));
  }

  if (qualityBar.length > 0 && allowSource("quality_bar")) {
    sections.push("");
    sections.push("Quality bar:");
    sections.push(...qualityBar.map((entry) => `- ${entry}`));
  }

  if (qualityGates.length > 0 && allowSource("quality_gates")) {
    sections.push("");
    sections.push("Quality gates (these will be executed by the validator; ensure your changes pass them):");
    sections.push(...qualityGates.map((gate) => {
      const cmd = [gate.command, ...(Array.isArray(gate.args) ? gate.args : [])].filter(Boolean).join(" ");
      const failHint = gate.fail_mode === "soft" ? " (soft)" : " (hard)";
      return `- [${gate.id}] ${cmd}${failHint}`;
    }));
  }

  sections.push("");
  sections.push("Return a short plain-text summary of changed files, behavior, and verification.");

  return sections.join("\n");
}

async function runCodexPlanner({ commandPath, operatorPrompt, timeoutMs = DEFAULT_PLANNER_TIMEOUT_MS, workspaceRoot }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-intake-codex-planner-"));
  const schemaPath = path.join(tempRoot, "planner-schema.json");
  fs.writeFileSync(schemaPath, `${JSON.stringify(INTAKE_PLANNER_SCHEMA, null, 2)}\n`);

  try {
    const result = await runReadContainedRuntimeCommand(commandPath, [
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--output-schema",
      schemaPath,
      "--skip-git-repo-check",
      "-C",
      workspaceRoot,
      "-",
    ], {
      cwd: workspaceRoot,
      deniedReadRoots: resolveRuntimeDeniedReadRoots(path.join(workspaceRoot, ".niis")),
      input: buildPlannerPrompt({
        operatorPrompt,
        workspaceRoot,
      }),
      timeoutMs,
    });
    const parsedJsonl = parseCodexJsonl(result.stdout);
    const raw = parsedJsonl.summary || result.stdout;

    return {
      cost: extractCostFromOutput({ runtimeId: "codex_local", stderr: result.stderr, stdout: result.stdout }),
      parsed: normalizePlannerParsedValue(raw),
      raw,
      result: {
        ...result,
        stderr: [result.stderr, parsedJsonl.errorMessage].filter(Boolean).join("\n"),
      },
    };
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
}

async function runClaudePlanner({ commandPath, operatorPrompt, timeoutMs = DEFAULT_PLANNER_TIMEOUT_MS, workspaceRoot }) {
  const baseArgs = ["-p"];
  appendClaudeSecurityArgs(baseArgs, {
    permissionMode: "dontAsk",
    workspaceRoot,
  });
  baseArgs.push(
    "--json-schema",
    JSON.stringify(INTAKE_PLANNER_SCHEMA),
    buildPlannerPrompt({
      operatorPrompt,
      workspaceRoot,
    }),
  );
  const deniedReadRoots = resolveRuntimeDeniedReadRoots(path.join(workspaceRoot, ".niis"));
  const jsonResult = await runReadContainedRuntimeCommand(commandPath, [
    ...baseArgs,
    "--output-format",
    "json",
  ], {
    cwd: workspaceRoot,
    deniedReadRoots,
    timeoutMs,
  });
  const parsedOuter = parseJsonText(jsonResult.stdout);
  const plannerText = extractTextOutput(parsedOuter ?? jsonResult.stdout);
  const parsedFromJsonEnvelope = normalizePlannerParsedValue(plannerText)
    ?? normalizePlannerParsedValue(parsedOuter);

  if (isPlainObject(parsedFromJsonEnvelope)) {
    return {
      cost: extractCostFromOutput({
        parsed: parsedOuter,
        runtimeId: "claude_code_local",
        stderr: jsonResult.stderr,
        stdout: jsonResult.stdout,
      }),
      parsed: parsedFromJsonEnvelope,
      raw: plannerText || jsonResult.stdout,
      result: jsonResult,
    };
  }

  const textResult = await runReadContainedRuntimeCommand(commandPath, baseArgs, {
    cwd: workspaceRoot,
    deniedReadRoots,
    timeoutMs,
  });
  const parsedFromTextMode = normalizePlannerParsedValue(textResult.stdout);

  return {
    cost: extractCostFromOutput({
      parsed: parsedOuter,
      runtimeId: "claude_code_local",
      stderr: [jsonResult.stderr, textResult.stderr].filter(Boolean).join("\n"),
      stdout: [jsonResult.stdout, textResult.stdout].filter(Boolean).join("\n"),
    }),
    parsed: parsedFromTextMode,
    raw: textResult.stdout || plannerText || jsonResult.stdout,
    result: parsedFromTextMode
      ? textResult
      : {
        exit_code: textResult.exit_code,
        ok: textResult.ok,
        runtime_sandbox_backend: textResult.runtime_sandbox_backend,
        sandbox_evidence: textResult.sandbox_evidence,
        stderr: [jsonResult.stderr, textResult.stderr].filter(Boolean).join("\n"),
        stdout: [jsonResult.stdout, textResult.stdout].filter(Boolean).join("\n"),
      },
  };
}

function createPlannerAttempt(runtimeId, output) {
  const parsed = isPlainObject(output?.parsed);
  const exitCode = output?.result?.exit_code ?? null;
  const stderr = summarizeText(output?.result?.stderr);
  return {
    error: parsed
      ? null
      : output?.result?.ok
        ? "runtime returned invalid structured plan output"
        : `runtime exited with code ${exitCode ?? "unknown"}${stderr ? `: ${stderr}` : ""}`,
    exit_code: exitCode,
    ok: parsed,
    raw_excerpt: summarizeText(output?.raw),
    runtime_id: runtimeId,
    runtime_sandbox_backend: output?.result?.runtime_sandbox_backend ?? null,
    sandbox_evidence: output?.result?.sandbox_evidence ?? null,
    stderr_excerpt: stderr,
    stdout_excerpt: summarizeText(output?.result?.stdout),
  };
}

async function runStructuredPlanner({
  operatorPrompt,
  onRuntimeAttempt = () => undefined,
  preferredRuntime = null,
  timeoutMs = DEFAULT_PLANNER_TIMEOUT_MS,
  workspaceRoot,
}) {
  const runtimes = resolvePreferredRuntimeDefinitions({
    preferredRuntime,
  });
  const attempts = [];

  for (const runtime of runtimes) {
    await onRuntimeAttempt(runtime);

    try {
      const output = await (runtime.runtimeId === "codex_local"
        ? runCodexPlanner({
          commandPath: runtime.commandPath,
          operatorPrompt,
          timeoutMs,
          workspaceRoot,
        })
        : runClaudePlanner({
          commandPath: runtime.commandPath,
          operatorPrompt,
          timeoutMs,
          workspaceRoot,
        }));
      attempts.push({
        ...createPlannerAttempt(runtime.runtimeId, output),
        cost: output?.cost ?? null,
      });

      if (isPlainObject(output.parsed)) {
        return Object.freeze({
          attempts: Object.freeze(attempts),
          cost: output?.cost ?? null,
          output: output.parsed,
          planner_mode: "structured_planner",
          runtime_id: runtime.runtimeId,
        });
      }
    } catch (error) {
      attempts.push({
        error: error instanceof Error ? error.message : String(error),
        exit_code: null,
        ok: false,
        raw_excerpt: null,
        runtime_id: runtime.runtimeId,
        stderr_excerpt: null,
        stdout_excerpt: null,
      });
    }
  }

  const attemptDetails = attempts
    .map((attempt) => `${attempt.runtime_id}: ${attempt.error ?? "invalid structured plan output"}`)
    .join("; ");
  const error = new IntakeRuntimeError(
    `no planner produced a valid plan${attemptDetails ? ` (${attemptDetails})` : ""}; install or configure Codex/Claude, then run \`niis doctor\``,
    { category: "planner_unavailable", retrySafe: true },
  );
  error.attempts = Object.freeze(attempts);
  throw error;
}

function estimateWhenMissing({ inputTokens, cachedInputTokens, outputTokens, estimatedUsd, modelId, runtimeId }) {
  if (estimatedUsd > 0) {
    return estimatedUsd;
  }

  return computeEstimatedUsd({
    cachedInputTokens,
    inputTokens,
    modelId,
    outputTokens,
    runtimeId,
  });
}

function extractCostFromOutput({ stdout = "", stderr = "", parsed = null, runtimeId = null }) {
  if (parsed && typeof parsed === "object") {
    const usage = parsed.usage;
    if (usage) {
      const inputTokens = Number(usage.input_tokens ?? 0);
      const cachedInputTokens = Number(usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? 0);
      const outputTokens = Number(usage.output_tokens ?? 0);
      const estimatedUsd = estimateWhenMissing({
        cachedInputTokens,
        estimatedUsd: Number(parsed.total_cost_usd ?? 0),
        inputTokens,
        modelId: typeof parsed.model === "string" ? parsed.model : null,
        outputTokens,
        runtimeId,
      });

      return {
        cached_input_tokens: cachedInputTokens,
        estimated_usd: estimatedUsd,
        input_tokens: inputTokens,
        model_id: typeof parsed.model === "string" ? parsed.model : null,
        output_tokens: outputTokens,
      };
    }
  }

  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (event.usage) {
      const inputTokens = Number(event.usage.input_tokens ?? 0);
      const cachedInputTokens = Number(event.usage.cached_input_tokens ?? 0);
      const outputTokens = Number(event.usage.output_tokens ?? 0);
      const estimatedUsd = estimateWhenMissing({
        cachedInputTokens,
        estimatedUsd: Number(event.total_cost_usd ?? 0),
        inputTokens,
        modelId: typeof event.model === "string" ? event.model : null,
        outputTokens,
        runtimeId,
      });

      return {
        cached_input_tokens: cachedInputTokens,
        estimated_usd: estimatedUsd,
        input_tokens: inputTokens,
        model_id: typeof event.model === "string" ? event.model : null,
        output_tokens: outputTokens,
      };
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  const text = stderr || "";
  const inputMatch = text.match(/(\d[\d,]*)\s*input\s*tokens?/i) ?? text.match(/input[_\s]*tokens?\s*[:=]\s*(\d[\d,]*)/i);
  if (inputMatch) inputTokens = Number(inputMatch[1].replace(/,/g, ""));
  const outputMatch = text.match(/(\d[\d,]*)\s*output\s*tokens?/i) ?? text.match(/output[_\s]*tokens?\s*[:=]\s*(\d[\d,]*)/i);
  if (outputMatch) outputTokens = Number(outputMatch[1].replace(/,/g, ""));
  const costMatch = text.match(/\$\s*([\d.]+)/) ?? text.match(/cost\s*[:=]\s*\$?([\d.]+)/i);
  if (costMatch) costUsd = Number(costMatch[1]);

  if (inputTokens === 0 && outputTokens === 0 && costUsd === 0) return null;
  const estimatedUsd = estimateWhenMissing({
    cachedInputTokens: 0,
    estimatedUsd: costUsd,
    inputTokens,
    modelId: null,
    outputTokens,
    runtimeId,
  });
  return {
    cached_input_tokens: 0,
    estimated_usd: estimatedUsd,
    input_tokens: inputTokens,
    model_id: null,
    output_tokens: outputTokens,
  };
}

function resolveModelOverride(runtimeId, modelPreference) {
  if (!modelPreference || typeof modelPreference !== "object") return null;
  if (modelPreference.runtime !== runtimeId) return null;
  const model = typeof modelPreference.model === "string" ? modelPreference.model.trim() : "";
  return model === "" ? null : model;
}

async function runCodexExecution({
  commandPath,
  prompt,
  workspaceRoot,
  modelPreference = null,
  signal = null,
  sandbox = "read-only",
  approvalPolicy = "never",
}) {
  if (sandbox !== "read-only") {
    throw new IntakeRuntimeError(
      `unsupported direct Codex sandbox mode: ${sandbox}`,
      { category: "env_block", retrySafe: false },
    );
  }
  if (approvalPolicy !== "never") {
    throw new IntakeRuntimeError(
      `unsupported direct Codex approval policy: ${approvalPolicy}`,
      { category: "env_block", retrySafe: false },
    );
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-intake-codex-run-"));
  const lastMessagePath = path.join(tempRoot, "last-message.txt");
  const modelOverride = resolveModelOverride("codex_local", modelPreference);
  const baseArgs = [
    "--ask-for-approval",
    approvalPolicy,
    "exec",
    "--json",
    "--sandbox",
    sandbox,
    "--ephemeral",
    "--skip-git-repo-check",
  ];
  if (modelOverride) {
    baseArgs.push("--model", modelOverride);
  }
  baseArgs.push("-C", workspaceRoot, "-o", lastMessagePath, "-");
  const result = await runCommandAsync(commandPath, baseArgs, {
    cwd: workspaceRoot,
    input: prompt,
    signal,
  });
  const lastMessage = fs.existsSync(lastMessagePath)
    ? fs.readFileSync(lastMessagePath, "utf8").trim()
    : "";
  const jsonlSummary = parseCodexJsonl(result.stdout).summary;

  return {
    artifactPath: fs.existsSync(lastMessagePath) ? lastMessagePath : null,
    cost: extractCostFromOutput({ runtimeId: "codex_local", stderr: result.stderr, stdout: result.stdout }),
    raw: {
      exit_code: result.exit_code,
      stderr: result.stderr,
      stdout: result.stdout,
    },
    summary: lastMessage || jsonlSummary || "Codex completed the requested task.",
  };
}

async function runClaudeExecution({
  commandPath,
  allowedTools = CLAUDE_READ_ONLY_TOOLS,
  deniedReadRoots = null,
  disallowedTools = [],
  prompt,
  workspaceRoot,
  modelPreference = null,
  permissionMode = "dontAsk",
  signal = null,
  timeoutMs = null,
}) {
  if (
    !Array.isArray(disallowedTools)
    || disallowedTools.some((tool) =>
      typeof tool !== "string"
      || tool.trim() === ""
      || /[\r\n\0]/u.test(tool))
  ) {
    throw new IntakeRuntimeError(
      "Claude execution disallowedTools must be an array of non-empty single-line strings",
    );
  }
  const modelOverride = resolveModelOverride("claude_code_local", modelPreference);
  const args = [
    "-p",
    "--output-format",
    "json",
  ];
  const appliedAllowedTools = appendClaudeSecurityArgs(args, {
    allowedTools,
    permissionMode,
    workspaceRoot,
  });
  if (disallowedTools.length > 0) {
    args.push(
      "--disallowedTools",
      disallowedTools.map((tool) => tool.trim()).join(","),
    );
  }
  if (modelOverride) {
    args.push("--model", modelOverride);
  }
  args.push(prompt);
  const invocation = createRuntimeExecutionSandboxInvocation({
    args,
    commandPath,
    deniedReadRoots: deniedReadRoots ?? [],
    workspaceRoot,
  });
  let result;
  try {
    result = await runCommandAsync(invocation.command, invocation.args, {
      cwd: workspaceRoot,
      env: invocation.env,
      signal,
      timeoutMs,
    });
  } finally {
    invocation.cleanup();
  }
  const parsed = parseJsonText(result.stdout);

  return {
    artifactPath: null,
    cost: extractCostFromOutput({ parsed, runtimeId: "claude_code_local", stderr: result.stderr, stdout: result.stdout }),
    raw: {
      exit_code: result.exit_code,
      runtime_sandbox_backend: invocation.backend,
      security_evidence: {
        applied_denied_read_roots: invocation.appliedDeniedReadRoots ?? [],
        filesystem_backend: invocation.backend,
        filesystem_enforced: invocation.backend !== "uncontained-read-only-caller",
        network_backend: "claude-tool-allowlist",
        network_enforced:
          appliedAllowedTools.length > 0
          && appliedAllowedTools.every((tool) => CLAUDE_SUPPORTED_TOOLS.has(tool)),
        read_backend: invocation.backend,
        read_enforced: invocation.backend !== "uncontained-read-only-caller",
        skipped_denied_read_roots: invocation.skippedDeniedReadRoots ?? [],
        write_backend: invocation.backend,
        write_enforced: invocation.backend !== "uncontained-read-only-caller",
      },
      stderr: result.stderr,
      stdout: result.stdout,
    },
    summary: extractTextOutput(parsed ?? result.stdout) || "Claude Code completed the requested task.",
  };
}

function createBuiltinExecutorAdapter({
  commandPath,
  runtimeId,
  workspaceRoot,
}) {
  const normalizedRuntimeId = ensureNonEmptyString(runtimeId, "runtimeId");
  const normalizedCommandPath = ensureNonEmptyString(commandPath, "commandPath");

  return createAdapterDefinition({
    capabilities: {
      adapterKind: normalizedRuntimeId,
      operations: ["execute"],
      protocolType: "local_cli",
      toolFamilies: ["shell", "local_cli", normalizedRuntimeId],
    },
    execute: async (context = {}) => {
      try {
        const modelPreference = context.delegation_payload?.model_preference
          ?? context.model_preference
          ?? null;
        const effectiveWorkspaceRoot = context.execution_workspace_root
          ?? context.delegation_payload?.execution_workspace_root
          ?? workspaceRoot;
        const executionPolicies = assertBuiltinExecutorPolicies(
          context,
          effectiveWorkspaceRoot,
        );
        const signal = context.abort_signal ?? context.delegation_payload?.abort_signal ?? null;








        const onEvent = typeof context.record_codex_event === "function"
          ? context.record_codex_event
          : undefined;
        const codexExec = resolveCodexExecutor();
        const execution = normalizedRuntimeId === "codex_local"
          ? await codexExec({
            commandPath: normalizedCommandPath,
            deniedReadRoots: executionPolicies.deniedReadRoots,
            modelPreference,
            prompt: buildExecutionPrompt(context),
            signal,
            workspaceRoot: effectiveWorkspaceRoot,
            sandbox: "workspace-write",
            approvalPolicy: "never",
            ...(onEvent ? { onEvent } : {}),
          })
          : await runClaudeExecution({
            allowedTools: CLAUDE_EDITING_TOOLS,
            commandPath: normalizedCommandPath,
            deniedReadRoots: executionPolicies.deniedReadRoots,
            modelPreference,
            permissionMode: "dontAsk",
            prompt: buildExecutionPrompt(context),
            signal,
            timeoutMs:
              context.timeout_ms
              ?? context.delegation_payload?.timeout_ms
              ?? null,
            workspaceRoot: effectiveWorkspaceRoot,
          });

        return {
          artifacts: execution.artifactPath
            ? [{
              path: execution.artifactPath,
              type: "runtime_output",
            }]
            : [],
          completion_signal: true,
          cost: execution.cost ?? null,
          error: null,
          next_actions: [],
          self_assessment: null,
          status: "SUCCESS",
          summary: execution.summary,
          _raw_runtime_output: execution.raw,
        };
      } catch (error) {





        if (error?.code === "context_contract_violation") {
          throw error;
        }
        return buildErrorAdapterResponse(
          error,
          normalizedRuntimeId,
          `${normalizedRuntimeId} execution failed`,
        );
      }
    },
    id: normalizedRuntimeId,
    metadata: {
      runtime_family: normalizedRuntimeId,
      wrapper_kind: "niis_builtin_executor",
    },
    normalize: (result) => {
      if (result?.status) {
        return {
          artifacts: result.artifacts ?? [],
          completion_signal: result.completion_signal ?? false,
          cost: result.cost ?? null,
          error: result.error ?? null,
          next_actions: result.next_actions ?? [],
          self_assessment: result.self_assessment ?? null,
          status: result.status,
          summary: result.summary ?? `${normalizedRuntimeId} completed the requested task.`,
        };
      }

      return buildErrorAdapterResponse(
        new IntakeRuntimeError("runtime wrapper returned an opaque execution result"),
        normalizedRuntimeId,
        `${normalizedRuntimeId} normalization failed`,
      );
    },
    test: async () => {
      try {
        const result = runCommand(normalizedCommandPath, ["--version"], {
          cwd: workspaceRoot,
        });

        return {
          checks: [{
            message: result.ok
              ? (result.stdout || `${normalizedRuntimeId} is available.`)
              : (result.stderr || result.stdout || `${normalizedRuntimeId} diagnostics failed.`),
            name: `${normalizedRuntimeId}.version`,
            status: result.ok ? "PASS" : "FAIL",
          }],
          ok: result.ok,
        };
      } catch (error) {
        return {
          checks: [{
            message: error instanceof Error ? error.message : String(error),
            name: `${normalizedRuntimeId}.version`,
            status: "FAIL",
          }],
          ok: false,
        };
      }
    },
  });
}

function createAvailableExecutorAdapters({
  preferredRuntime = null,
  workspaceRoot,
}) {
  return resolvePreferredRuntimeDefinitions({
    preferredRuntime,
  }).map((runtime) =>
    createBuiltinExecutorAdapter({
      commandPath: runtime.commandPath,
      runtimeId: runtime.runtimeId,
      workspaceRoot,
    }));
}

export {
  CLAUDE_EDITING_TOOLS,
  CLAUDE_READ_ONLY_TOOLS,
  INTAKE_PLANNER_SCHEMA,
  IntakeRuntimeError,
  PLANNER_RUNTIME_OPTIONS,
  buildExecutionPrompt,
  buildPlannerContextHints,
  buildPlannerPrompt,
  createAvailableExecutorAdapters,
  createBuiltinExecutorAdapter,
  formatCodemapForPlannerPrompt,
  loadCodemapSummaryForPlanner,
  resolveCodexExecutor,
  resolvePreferredRuntimeDefinitions,
  runClaudeExecution,
  runClaudePlanner,
  runCodexExecution,
  runCodexPlanner,
  runStructuredPlanner,
};
