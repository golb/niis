import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  normalizeAcceptanceCommandPlan,
} from "../contracts/acceptance-command-plan.js";
import {
  createBubblewrapMaskEntries,
  createSeatbeltTraversalEntries,
  escapeSandboxLiteral,
  isPathWithin,
  orderPathScopedRules,
} from "./sandbox-path-rules.js";

const DEFAULT_ACCEPTANCE_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_ACCEPTANCE_OUTPUT_LIMIT_BYTES = 64 * 1024;
const MAX_ACCEPTANCE_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const FORCE_KILL_GRACE_MS = 250;
const FORCE_KILL_WAIT_MS = 2_000;
const PROCESS_TREE_POLL_MS = 20;
const ACCEPTANCE_COMMAND_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "CI",
  "CONTINUOUS_INTEGRATION",
  "NO_COLOR",
  "FORCE_COLOR",
  "TERM",
  "COLORTERM",
  "npm_config_cache",
  "NPM_CONFIG_CACHE",
  "PNPM_HOME",
  "YARN_CACHE_FOLDER",
  "COREPACK_HOME",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
]);

class AcceptanceCommandRunnerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AcceptanceCommandRunnerError";
    this.code = options.code ?? "acceptance_command_runner_error";
    this.retrySafe = options.retrySafe ?? false;
  }
}

function ensurePositiveInteger(value, label, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new AcceptanceCommandRunnerError(
      `${label} must be a positive integer not greater than ${max}`,
      { code: "invalid_acceptance_command_runner_options" },
    );
  }
  return value;
}

function ensureAbortSignal(signal) {
  if (signal === null || signal === undefined) {
    return null;
  }
  if (
    typeof signal !== "object"
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new AcceptanceCommandRunnerError(
      "signal must be an AbortSignal",
      { code: "invalid_acceptance_command_runner_options" },
    );
  }
  return signal;
}

function resolveAttemptWorkspace(workspacePath) {
  if (typeof workspacePath !== "string" || workspacePath.trim() === "") {
    throw new AcceptanceCommandRunnerError(
      "workspacePath must identify a materialized attempt workspace",
      { code: "invalid_attempt_workspace" },
    );
  }

  const resolved = path.resolve(workspacePath);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new AcceptanceCommandRunnerError(
      `attempt workspace does not exist: ${resolved}`,
      { code: "invalid_attempt_workspace" },
    );
  }
  if (!stats.isDirectory()) {
    throw new AcceptanceCommandRunnerError(
      `attempt workspace is not a directory: ${resolved}`,
      { code: "invalid_attempt_workspace" },
    );
  }

  return fs.realpathSync(resolved);
}


function validatePathOperand(rawOperand, workspacePath, label) {
  if (typeof rawOperand !== "string" || rawOperand === "") return;
  if (/^file:/iu.test(rawOperand)) {
    throw new AcceptanceCommandRunnerError(
      `${label} may not use file URLs`,
      { code: "acceptance_path_escape" },
    );
  }
  const pathSegments = rawOperand.split(/[\\/]/u);
  if (pathSegments.includes("..")) {
    throw new AcceptanceCommandRunnerError(
      `${label} may not traverse outside the attempt workspace`,
      { code: "acceptance_path_escape" },
    );
  }

  const looksLikePath =
    path.isAbsolute(rawOperand)
    || rawOperand.startsWith(".")
    || /[\\/]/u.test(rawOperand)
    || fs.existsSync(path.resolve(workspacePath, rawOperand));
  if (!looksLikePath) return;

  const resolved = path.resolve(workspacePath, rawOperand);
  if (!isPathWithin(workspacePath, resolved)) {
    throw new AcceptanceCommandRunnerError(
      `${label} resolves outside the attempt workspace`,
      { code: "acceptance_path_escape" },
    );
  }
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved);
    if (!isPathWithin(workspacePath, real)) {
      throw new AcceptanceCommandRunnerError(
        `${label} follows a symlink outside the attempt workspace`,
        { code: "acceptance_path_escape" },
      );
    }
  }
}

function assertAcceptanceCommandPathPolicy(command, workspacePath) {
  command.argv.slice(1).forEach((token, index) => {
    if (token.startsWith("-") && token.includes("=")) {
      validatePathOperand(
        token.slice(token.indexOf("=") + 1),
        workspacePath,
        `argv[${index + 1}]`,
      );
      return;
    }
    if (!token.startsWith("-")) {
      validatePathOperand(token, workspacePath, `argv[${index + 1}]`);
    }
  });
}

function readJsonObject(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new AcceptanceCommandRunnerError(
      `${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
      { code: "acceptance_manifest_binding_failed" },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AcceptanceCommandRunnerError(
      `${label} must contain a JSON object`,
      { code: "acceptance_manifest_binding_failed" },
    );
  }
  return parsed;
}

function bindPackageScriptDefinition(command, workspacePath) {
  const executable = path.basename(command.argv[0]);
  if (!["npm", "pnpm", "yarn"].includes(executable)) return null;
  const scriptName = command.argv[1] === "test"
    ? "test"
    : command.argv[2];
  const manifestPath = path.join(workspacePath, "package.json");
  if (!fs.existsSync(manifestPath)) {
    throw new AcceptanceCommandRunnerError(
      "package-manager acceptance commands require package.json in the attempt workspace",
      { code: "acceptance_manifest_binding_failed" },
    );
  }
  const currentManifest = readJsonObject(manifestPath, "package.json");
  const baseManifestResult = spawnSync(
    "git",
    ["show", "HEAD:package.json"],
    {
      cwd: workspacePath,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (baseManifestResult.status !== 0) {
    throw new AcceptanceCommandRunnerError(
      "package script definitions cannot be bound to the attempt base commit",
      { code: "acceptance_manifest_binding_failed" },
    );
  }
  let baseManifest;
  try {
    baseManifest = JSON.parse(baseManifestResult.stdout);
  } catch {
    throw new AcceptanceCommandRunnerError(
      "base-commit package.json is invalid",
      { code: "acceptance_manifest_binding_failed" },
    );
  }
  const scriptNames = [`pre${scriptName}`, scriptName, `post${scriptName}`];
  const definitions = Object.fromEntries(scriptNames.map((name) => [
    name,
    currentManifest.scripts?.[name] ?? null,
  ]));
  for (const name of scriptNames) {
    if (
      (baseManifest.scripts?.[name] ?? null)
      !== definitions[name]
    ) {
      throw new AcceptanceCommandRunnerError(
        `package script ${name} changed after plan approval; use an explicit argv gate or approve a new attempt`,
        { code: "acceptance_manifest_changed" },
      );
    }
  }
  if (typeof definitions[scriptName] !== "string") {
    throw new AcceptanceCommandRunnerError(
      `package script ${scriptName} is missing`,
      { code: "acceptance_manifest_binding_failed" },
    );
  }
  return Object.freeze({
    definitions_sha256: createHash("sha256")
      .update(JSON.stringify(definitions))
      .digest("hex"),
    manifest: "package.json",
    script_name: scriptName,
  });
}

function normalizeDeniedReadRoots(deniedReadRoots, workspacePath) {
  if (deniedReadRoots === null || deniedReadRoots === undefined) {
    return Object.freeze([]);
  }
  if (
    !Array.isArray(deniedReadRoots)
    || deniedReadRoots.some((entry) =>
      typeof entry !== "string"
      || entry.trim() === ""
      || /[\r\n\0]/u.test(entry))
  ) {
    throw new AcceptanceCommandRunnerError(
      "deniedReadRoots must be an array of non-empty path strings",
      { code: "invalid_acceptance_command_runner_options" },
    );
  }
  const normalized = [];
  for (const entry of deniedReadRoots) {
    const resolved = path.resolve(entry);
    const canonical = fs.existsSync(resolved)
      ? fs.realpathSync(resolved)
      : resolved;
    if (canonical === workspacePath) {
      throw new AcceptanceCommandRunnerError(
        "the attempt workspace cannot itself be a denied read root",
        { code: "invalid_acceptance_command_runner_options" },
      );
    }
    if (!normalized.some((existing) =>
      canonical === existing || isPathWithin(existing, canonical))) {
      normalized.push(canonical);
    }
  }
  return Object.freeze(normalized.sort());
}

function createAcceptanceSandboxInvocation({
  argv,
  deniedReadRoots = [],
  environmentRoot,
  workspacePath,
}) {
  const normalizedDeniedReadRoots = normalizeDeniedReadRoots(
    deniedReadRoots,
    workspacePath,
  );
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    const profilePath = path.join(environmentRoot, "acceptance.sb");
    const allowedWorkspace = escapeSandboxLiteral(workspacePath);
    const allowedEnvironment = escapeSandboxLiteral(environmentRoot);
    fs.writeFileSync(profilePath, [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow signal (target self))",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow file-read*)",
      ...orderPathScopedRules([
        ...normalizedDeniedReadRoots.map((root) => ({


          lines: [
            `(deny file-read* (subpath "${escapeSandboxLiteral(root)}"))`,
            `(deny file-write* (subpath "${escapeSandboxLiteral(root)}"))`,
          ],
          path: root,
          rank: 0,
        })),
        ...createSeatbeltTraversalEntries(
          normalizedDeniedReadRoots,
          [workspacePath, environmentRoot],
        ),
        {
          lines: [
            `(allow file-read* (subpath "${allowedWorkspace}"))`,
            `(allow file-write* (subpath "${allowedWorkspace}"))`,
          ],
          path: workspacePath,
          rank: 1,
        },
        {
          lines: [
            `(allow file-read* (subpath "${allowedEnvironment}"))`,
            `(allow file-write* (subpath "${allowedEnvironment}"))`,
          ],
          path: environmentRoot,
          rank: 1,
        },
      ]),
      '(allow file-write* (literal "/dev/null"))',
      "(deny network*)",
      "",
    ].join("\n"), { mode: 0o600 });
    return Object.freeze({
      args: ["-f", profilePath, ...argv],
      backend: "darwin-seatbelt-network-disabled",
      command: "/usr/bin/sandbox-exec",
    });
  }

  if (process.platform === "linux") {
    const bubblewrapPath = ["/usr/bin/bwrap", "/bin/bwrap"]
      .find((candidate) => fs.existsSync(candidate));
    if (bubblewrapPath) {
      const mounts = orderPathScopedRules([
        ...createBubblewrapMaskEntries(
          normalizedDeniedReadRoots,
          [workspacePath, environmentRoot],
        ),
        { lines: ["--bind", workspacePath, workspacePath], path: workspacePath, rank: 2 },
        { lines: ["--bind", environmentRoot, environmentRoot], path: environmentRoot, rank: 2 },
      ]);
      return Object.freeze({
        args: [
          "--die-with-parent",
          "--new-session",
          "--unshare-pid",
          "--unshare-net",
          "--ro-bind", "/", "/",
          "--dev", "/dev",
          "--proc", "/proc",
          ...mounts,
          "--chdir", workspacePath,
          "--",
          ...argv,
        ],
        backend: "linux-bubblewrap-network-disabled",
        command: bubblewrapPath,
      });
    }
  }

  throw new AcceptanceCommandRunnerError(
    "no supported network-disabled OS sandbox is available for acceptance commands",
    { code: "acceptance_sandbox_unavailable" },
  );
}

function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}



function createSpawnEnoentError(commandName) {
  const error = new Error(`spawn ${commandName} ENOENT`);
  error.code = "ENOENT";
  error.errno = -2;
  error.path = commandName;
  error.syscall = "spawn";
  return error;
}







function resolveCommandExecutableError(commandName, environment) {
  if (commandName.includes(path.sep)) {
    return isExecutableFile(path.resolve(commandName))
      ? null
      : createSpawnEnoentError(commandName);
  }
  const searchPath = typeof environment.PATH === "string" ? environment.PATH : "";
  const resolved = searchPath
    .split(path.delimiter)
    .filter((entry) => entry !== "")
    .some((entry) => isExecutableFile(path.join(entry, commandName)));
  return resolved ? null : createSpawnEnoentError(commandName);
}

function sanitizeAcceptanceCommandEnvironment(environment = process.env) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new AcceptanceCommandRunnerError(
      "env must be an object when provided",
      { code: "invalid_acceptance_command_runner_options" },
    );
  }

  const sanitized = {};
  for (const key of ACCEPTANCE_COMMAND_ENV_KEYS) {
    if (
      Object.prototype.hasOwnProperty.call(environment, key)
      && typeof environment[key] === "string"
    ) {
      sanitized[key] = environment[key];
    }
  }
  return Object.freeze(sanitized);
}

function createIsolatedAcceptanceEnvironment(environment) {
  const sanitized = sanitizeAcceptanceCommandEnvironment(environment);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-acceptance-env-"));
  const home = path.join(root, "home");
  const cache = path.join(root, "cache");
  const temp = path.join(root, "tmp");
  const gitConfig = path.join(root, "gitconfig");
  for (const directory of [home, cache, temp]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(gitConfig, "", { mode: 0o600 });

  return Object.freeze({
    cleanup() {
      fs.rmSync(root, { force: true, recursive: true });
    },
    env: Object.freeze({
      ...sanitized,
      ALL_PROXY: "http://127.0.0.1:9",
      CI: "1",
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      HOME: home,
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      NPM_CONFIG_CACHE: cache,
      NO_PROXY: "127.0.0.1,localhost,::1",
      TMPDIR: temp,
      USERPROFILE: home,
      npm_config_cache: cache,
      npm_config_offline: "true",
    }),
    root,
  });
}

function signalChildProcessTree(child, signal) {
  if (!child) return false;
  if (process.platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  }
  return child.kill(signal);
}

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

async function terminateChildProcessTree(child) {
  let termError = null;
  try {
    signalChildProcessTree(child, "SIGTERM");
  } catch (error) {
    termError = error;
  }

  if (await waitForProcessTreeExit(child, FORCE_KILL_GRACE_MS)) {
    return;
  }

  try {
    signalChildProcessTree(child, "SIGKILL");
  } catch (error) {
    termError ??= error;
  }

  if (await waitForProcessTreeExit(child, FORCE_KILL_WAIT_MS)) {
    return;
  }

  const suffix = termError instanceof Error ? `: ${termError.message}` : "";
  throw new AcceptanceCommandRunnerError(
    `acceptance command process group ${child?.pid ?? "unknown"} remained alive after SIGKILL${suffix}`,
    {
      code: "acceptance_process_tree_cleanup_failed",
      retrySafe: false,
    },
  );
}

function createBoundedStreamCapture(limitBytes) {
  const hash = createHash("sha256");
  const chunks = [];
  let bytes = 0;
  let capturedBytes = 0;

  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      hash.update(buffer);
      const remaining = limitBytes - capturedBytes;
      if (remaining > 0) {
        const captured = buffer.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
    },
    finish() {
      return Object.freeze({
        bytes,
        captured_bytes: capturedBytes,
        sha256: hash.digest("hex"),
        text: Buffer.concat(chunks).toString("utf8"),
        truncated: bytes > capturedBytes,
      });
    },
  };
}

function buildEvidenceDigestPayload({
  command,
  exitCode,
  signal,
  spawnError,
  status,
  stderr,
  stdout,
  sandboxBackend,
  manifestBinding,
}) {
  return JSON.stringify({
    argv: command.argv,
    command_id: command.id,
    exit_code: exitCode,
    required: command.required,
    manifest_binding: manifestBinding,
    sandbox_backend: sandboxBackend,
    signal,
    spawn_error: spawnError instanceof Error ? spawnError.message : null,
    status,
    stderr_bytes: stderr.bytes,
    stderr_sha256: stderr.sha256,
    stdout_bytes: stdout.bytes,
    stdout_sha256: stdout.sha256,
  });
}

function renderBoundedEvidenceContent({
  command,
  exitCode,
  signal,
  spawnError,
  status,
  stderr,
  stdout,
  sandboxBackend,
  manifestBinding,
}) {
  const lines = [
    `argv_json=${JSON.stringify(command.argv)}`,
    `status=${status}`,
    `exit_code=${exitCode}`,
    `signal=${signal ?? ""}`,
    `spawn_error=${spawnError instanceof Error ? spawnError.message : ""}`,
    `sandbox_backend=${sandboxBackend}`,
    `manifest_binding=${JSON.stringify(manifestBinding)}`,
    `stdout_sha256=${stdout.sha256}`,
    `stderr_sha256=${stderr.sha256}`,
    `stdout_bytes=${stdout.bytes}`,
    `stderr_bytes=${stderr.bytes}`,
    "",
    "[stdout]",
    stdout.text,
  ];
  if (stdout.truncated) {
    lines.push(`[stdout truncated at ${stdout.captured_bytes} bytes]`);
  }
  lines.push("", "[stderr]", stderr.text);
  if (stderr.truncated) {
    lines.push(`[stderr truncated at ${stderr.captured_bytes} bytes]`);
  }
  return lines.join("\n");
}

function finalizeCommandResult({
  aborted,
  command,
  durationMs,
  exitCode,
  signal,
  spawnError,
  stderrCapture,
  stdoutCapture,
  timedOut,
  sandboxBackend,
  manifestBinding,
}) {
  const stdout = stdoutCapture.finish();
  const stderr = stderrCapture.finish();
  const status = aborted
    ? "CANCELLED"
    : timedOut
      ? "TIMEOUT"
      : spawnError
        ? "ERROR"
        : exitCode === 0
          ? "PASS"
          : "FAIL";
  let normalizedExitCode = -1;
  if (aborted) {
    normalizedExitCode = 130;
  } else if (timedOut) {
    normalizedExitCode = 124;
  } else if (!spawnError && Number.isInteger(exitCode)) {
    normalizedExitCode = exitCode;
  }
  const evidenceSha256 = createHash("sha256")
    .update(buildEvidenceDigestPayload({
      command,
      exitCode: normalizedExitCode,
      signal,
      spawnError,
      status,
      stderr,
      stdout,
      sandboxBackend,
      manifestBinding,
    }))
    .digest("hex");
  const rawOutputRef = `sha256:${evidenceSha256}`;
  const evidenceItem = Object.freeze({
    content: renderBoundedEvidenceContent({
      command,
      exitCode: normalizedExitCode,
      signal,
      spawnError,
      status,
      stderr,
      stdout,
      sandboxBackend,
      manifestBinding,
    }),
    raw_output_ref: rawOutputRef,
    source: `acceptance-command:${command.id}`,
    type: "acceptance_command_output",
  });

  return Object.freeze({
    aborted,
    argv: command.argv,
    command_id: command.id,
    duration_ms: durationMs,
    evidence_item: evidenceItem,
    evidence_sha256: evidenceSha256,
    exit_code: normalizedExitCode,
    ok: status === "PASS",
    manifest_binding: manifestBinding,
    raw_output_ref: rawOutputRef,
    required: command.required,
    sandbox_backend: sandboxBackend,
    signal: signal ?? null,
    spawn_error: spawnError instanceof Error ? spawnError.message : null,
    status,
    stderr,
    stdout,
    timed_out: timedOut,
  });
}

function createCancelledResult(command, outputLimitBytes) {
  return finalizeCommandResult({
    aborted: true,
    command,
    durationMs: 0,
    exitCode: null,
    signal: null,
    spawnError: null,
    stderrCapture: createBoundedStreamCapture(outputLimitBytes),
    stdoutCapture: createBoundedStreamCapture(outputLimitBytes),
    timedOut: false,
    sandboxBackend: "not-started",
    manifestBinding: null,
  });
}

async function runAcceptanceCommand({
  command,
  deniedReadRoots = [],
  env = process.env,
  maxOutputBytes = DEFAULT_ACCEPTANCE_OUTPUT_LIMIT_BYTES,
  signal = null,
  timeoutMs = DEFAULT_ACCEPTANCE_COMMAND_TIMEOUT_MS,
  workspacePath,
} = {}) {
  const [normalizedCommand] = normalizeAcceptanceCommandPlan([command], { allowEmpty: false });
  const normalizedWorkspacePath = resolveAttemptWorkspace(workspacePath);
  const normalizedTimeoutMs = ensurePositiveInteger(timeoutMs, "timeoutMs");
  const normalizedOutputLimit = ensurePositiveInteger(
    maxOutputBytes,
    "maxOutputBytes",
    { max: MAX_ACCEPTANCE_OUTPUT_LIMIT_BYTES },
  );
  const normalizedSignal = ensureAbortSignal(signal);
  assertAcceptanceCommandPathPolicy(
    normalizedCommand,
    normalizedWorkspacePath,
  );
  const manifestBinding = bindPackageScriptDefinition(
    normalizedCommand,
    normalizedWorkspacePath,
  );
  const isolatedEnvironment = createIsolatedAcceptanceEnvironment(env);
  const sandboxInvocation = createAcceptanceSandboxInvocation({
    argv: normalizedCommand.argv,
    deniedReadRoots,
    environmentRoot: isolatedEnvironment.root,
    workspacePath: normalizedWorkspacePath,
  });

  if (normalizedSignal?.aborted) {
    isolatedEnvironment.cleanup();
    return createCancelledResult(normalizedCommand, normalizedOutputLimit);
  }

  const stdoutCapture = createBoundedStreamCapture(normalizedOutputLimit);
  const stderrCapture = createBoundedStreamCapture(normalizedOutputLimit);
  const startedAt = Date.now();

  const executableError = resolveCommandExecutableError(
    normalizedCommand.argv[0],
    isolatedEnvironment.env,
  );
  if (executableError) {
    isolatedEnvironment.cleanup();
    return finalizeCommandResult({
      aborted: false,
      command: normalizedCommand,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      signal: null,
      spawnError: executableError,
      stderrCapture,
      stdoutCapture,
      timedOut: false,
      sandboxBackend: sandboxInvocation.backend,
      manifestBinding,
    });
  }

  return new Promise((resolve, reject) => {
    let aborted = false;
    let child = null;
    let closed = false;
    let spawnError = null;
    let terminationError = null;
    let terminationPromise = null;
    let timedOut = false;

    const requestStop = (reason) => {
      if (reason === "abort") aborted = true;
      if (reason === "timeout") timedOut = true;
      if (closed || !child || terminationPromise) return;
      terminationPromise = terminateChildProcessTree(child).catch((error) => {
        terminationError = error;
      });
    };
    const onAbort = () => requestStop("abort");
    normalizedSignal?.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(() => requestStop("timeout"), normalizedTimeoutMs);
    timeout.unref?.();

    try {
      child = spawn(sandboxInvocation.command, sandboxInvocation.args, {
        cwd: normalizedWorkspacePath,
        detached: process.platform !== "win32",
        env: isolatedEnvironment.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = error;
      closed = true;
      clearTimeout(timeout);
      normalizedSignal?.removeEventListener("abort", onAbort);
      isolatedEnvironment.cleanup();
      resolve(finalizeCommandResult({
        aborted,
        command: normalizedCommand,
        durationMs: Date.now() - startedAt,
        exitCode: null,
        signal: null,
        spawnError,
        stderrCapture,
        stdoutCapture,
        timedOut,
        sandboxBackend: sandboxInvocation.backend,
        manifestBinding,
      }));
      return;
    }

    child.stdout?.on("data", (chunk) => stdoutCapture.append(chunk));
    child.stderr?.on("data", (chunk) => stderrCapture.append(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", async (exitCode, closeSignal) => {
      if (closed) return;
      if (terminationPromise) {
        await terminationPromise;
      }
      closed = true;
      clearTimeout(timeout);
      normalizedSignal?.removeEventListener("abort", onAbort);
      if (terminationError) {
        reject(terminationError);
        return;
      }
      isolatedEnvironment.cleanup();
      resolve(finalizeCommandResult({
        aborted,
        command: normalizedCommand,
        durationMs: Date.now() - startedAt,
        exitCode,
        signal: closeSignal,
        spawnError,
        stderrCapture,
        stdoutCapture,
        timedOut,
        sandboxBackend: sandboxInvocation.backend,
        manifestBinding,
      }));
    });
    if (normalizedSignal?.aborted) {
      requestStop("abort");
    }
  });
}

async function runAcceptanceCommandPlan({
  acceptanceCommands,
  deniedReadRoots = [],
  env = process.env,
  maxOutputBytes = DEFAULT_ACCEPTANCE_OUTPUT_LIMIT_BYTES,
  signal = null,
  timeoutMs = DEFAULT_ACCEPTANCE_COMMAND_TIMEOUT_MS,
  workspacePath,
} = {}) {
  const commands = normalizeAcceptanceCommandPlan(acceptanceCommands, { allowEmpty: false });
  const normalizedWorkspacePath = resolveAttemptWorkspace(workspacePath);
  const results = [];

  for (const command of commands) {
    const result = await runAcceptanceCommand({
      command,
      deniedReadRoots,
      env,
      maxOutputBytes,
      signal,
      timeoutMs,
      workspacePath: normalizedWorkspacePath,
    });
    results.push(result);
    if (result.aborted) break;
  }

  const hardFailures = results.filter((result) => result.required && !result.ok);
  return Object.freeze({
    aborted: results.some((result) => result.aborted),
    evidence_items: Object.freeze(results.map((result) => result.evidence_item)),
    hard_failures: Object.freeze(hardFailures),
    ok: !results.some((result) => result.required && !result.ok)
      && results.length === commands.length,
    results: Object.freeze(results),
  });
}

export {
  ACCEPTANCE_COMMAND_ENV_KEYS,
  AcceptanceCommandRunnerError,
  DEFAULT_ACCEPTANCE_COMMAND_TIMEOUT_MS,
  DEFAULT_ACCEPTANCE_OUTPUT_LIMIT_BYTES,
  MAX_ACCEPTANCE_OUTPUT_LIMIT_BYTES,
  runAcceptanceCommand,
  runAcceptanceCommandPlan,
  assertAcceptanceCommandPathPolicy,
  bindPackageScriptDefinition,
  createAcceptanceSandboxInvocation,
  createIsolatedAcceptanceEnvironment,
  normalizeDeniedReadRoots,
  sanitizeAcceptanceCommandEnvironment,
  signalChildProcessTree,
};
