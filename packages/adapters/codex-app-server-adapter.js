


















































import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createRuntimeReadSandboxInvocation,
} from "./runtime-read-sandbox.js";

const JSONRPC = "2.0";
const DEFAULT_SHUTDOWN_TERM_TIMEOUT_MS = 1_000;
const DEFAULT_SHUTDOWN_KILL_TIMEOUT_MS = 1_000;

function nowMs() { return Date.now(); }

function createAbortError(message = "codex app-server operation aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function normalizeShutdownTimeout(value, fallback, name) {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return Math.floor(normalized);
}

function createTurnSandboxPolicy({ sandbox, workdir }) {
  const canonicalWorkdir = fs.realpathSync(path.resolve(workdir));
  if (sandbox === "read-only") {
    return Object.freeze({
      canonicalWorkdir,
      policy: Object.freeze({
        networkAccess: false,
        type: "readOnly",
      }),
    });
  }
  if (sandbox === "workspace-write") {
    return Object.freeze({
      canonicalWorkdir,
      policy: Object.freeze({
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
        networkAccess: false,
        type: "workspaceWrite",
        writableRoots: Object.freeze([canonicalWorkdir]),
      }),
    });
  }
  throw new Error(`unsupported Codex app-server sandbox mode: ${sandbox}`);
}

export function createCodexAppServerClient({
  commandPath,
  workspaceRoot,
  deniedReadRoots = null,
  env = process.env,
  debug = false,
  signal: initializationSignal = null,
  shutdownTermTimeoutMs = DEFAULT_SHUTDOWN_TERM_TIMEOUT_MS,
  shutdownKillTimeoutMs = DEFAULT_SHUTDOWN_KILL_TIMEOUT_MS,
}) {
  if (!commandPath) throw new Error("createCodexAppServerClient: commandPath required");
  if (initializationSignal?.aborted) throw createAbortError();
  const termTimeoutMs = normalizeShutdownTimeout(
    shutdownTermTimeoutMs,
    DEFAULT_SHUTDOWN_TERM_TIMEOUT_MS,
    "shutdownTermTimeoutMs",
  );
  const killTimeoutMs = normalizeShutdownTimeout(
    shutdownKillTimeoutMs,
    DEFAULT_SHUTDOWN_KILL_TIMEOUT_MS,
    "shutdownKillTimeoutMs",
  );

  const invocation = Array.isArray(deniedReadRoots) && deniedReadRoots.length > 0
    ? createRuntimeReadSandboxInvocation({
        args: ["app-server"],
        commandPath,
        deniedReadRoots,
        workspaceRoot,
      })
    : {
        args: ["app-server"],
        backend: "uncontained-read-only-caller",
        cleanup() {},
        command: commandPath,
      };
  const usesDetachedProcessGroup = process.platform !== "win32";
  const child = spawn(invocation.command, invocation.args, {
    cwd: workspaceRoot,
    detached: usesDetachedProcessGroup,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  const pendingRequests = new Map();
  const pendingNotificationListeners = new Set();
  let stderrTail = "";
  let exited = false;
  let exitInfo = null;
  const processGroupId = usesDetachedProcessGroup && Number.isInteger(child.pid)
    ? child.pid
    : null;
  let disposePromise = null;
  let sandboxCleaned = false;
  let resolveChildExit;
  const childExit = new Promise((resolve) => {
    resolveChildExit = resolve;
  });
  const cleanupSandbox = () => {
    if (sandboxCleaned) return;
    sandboxCleaned = true;
    invocation.cleanup();
  };
  function beginDispose() {
    dispose().catch((error) => {
      if (debug) {
        process.stderr.write(`[codex-as ⚠] shutdown failed: ${error.message}\n`);
      }
    });
  }

  function takePendingRequest(id) {
    const pending = pendingRequests.get(id);
    if (!pending) return null;
    pendingRequests.delete(id);
    pending.cleanupAbort?.();
    return pending;
  }

  function rejectAllPendingRequests(error) {
    for (const id of [...pendingRequests.keys()]) {
      takePendingRequest(id)?.reject(error);
    }
  }

  function rejectPendingRequestsByMethod(method, error) {
    for (const [id, pending] of [...pendingRequests.entries()]) {
      if (pending.method === method) takePendingRequest(id)?.reject(error);
    }
  }

  function send(message) {
    if (exited) throw new Error(`codex app-server exited (${exitInfo?.code ?? "unknown"}); cannot send`);
    if (debug) process.stderr.write(`[codex-as ▶] ${JSON.stringify(message)}\n`);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function sendRequest(method, params = {}, {
    signal = null,
    shutdownOnAbort = false,
  } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError(`${method} aborted`));
        if (shutdownOnAbort) beginDispose();
        return;
      }
      const onAbort = () => {
        const pending = takePendingRequest(id);
        if (!pending) return;
        pending.reject(createAbortError(`${method} aborted`));
        if (shutdownOnAbort) beginDispose();
      };
      const cleanupAbort = signal
        ? () => signal.removeEventListener("abort", onAbort)
        : null;
      pendingRequests.set(id, {
        cleanupAbort,
        method,
        reject,
        resolve,
        sentAt: nowMs(),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        send({ jsonrpc: JSONRPC, id, method, params });
      } catch (err) {
        takePendingRequest(id)?.reject(err);
      }
    });
  }

  function sendResponse(id, result) {
    send({ jsonrpc: JSONRPC, id, result });
  }

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let idx;
    while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch (err) {
        if (debug) process.stderr.write(`[codex-as ✗] non-JSON line: ${line.slice(0, 200)}\n`);
        continue;
      }
      if (debug) process.stderr.write(`[codex-as ◀] ${JSON.stringify(msg).slice(0, 300)}\n`);
      handleMessage(msg);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
    if (debug) process.stderr.write(`[codex-as ⚠] ${chunk}`);
  });
  child.stdin.on("error", (error) => {
    if (debug && error?.code !== "EPIPE") {
      process.stderr.write(`[codex-as ⚠] stdin error: ${error.message}\n`);
    }
  });

  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    cleanupSandbox();
    resolveChildExit(exitInfo);
    const err = new Error(`codex app-server exited (code=${code}, signal=${signal}). stderr tail: ${stderrTail.slice(-400)}`);
    rejectAllPendingRequests(err);
    for (const listener of pendingNotificationListeners) {
      try { listener({ kind: "_exit", code, signal, stderr: stderrTail }); } catch {}
    }
  });

  child.on("error", (err) => {
    exited = true;
    exitInfo = { error: err.message };
    cleanupSandbox();
    resolveChildExit(exitInfo);
    rejectAllPendingRequests(err);
  });

  function handleMessage(msg) {



    if (typeof msg.id !== "undefined" && msg.method) {
      const denyReason = `niis-app-server-client: ${msg.method} not allowed in this context`;
      sendResponse(msg.id, { decision: "deny", reason: denyReason });
      return;
    }

    if (typeof msg.id !== "undefined") {
      const pending = takePendingRequest(msg.id);
      if (!pending) return;
      if (msg.error) pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(msg.error)}`));
      else pending.resolve(msg.result);
      return;
    }

    if (msg.method) {
      for (const listener of pendingNotificationListeners) {
        try { listener({ kind: "notification", method: msg.method, params: msg.params }); }
        catch (err) { if (debug) process.stderr.write(`[codex-as] notification listener threw: ${err.message}\n`); }
      }
    }
  }

  function onNotification(listener) {
    pendingNotificationListeners.add(listener);
    return () => pendingNotificationListeners.delete(listener);
  }

  function waitForPromiseWithSignal(promise, signal, operation, {
    pendingMethod = null,
  } = {}) {
    if (!signal) return promise;
    if (signal.aborted) {
      if (pendingMethod) {
        rejectPendingRequestsByMethod(
          pendingMethod,
          createAbortError(`${operation} aborted`),
        );
      }
      beginDispose();
      return Promise.reject(createAbortError(`${operation} aborted`));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback(value);
      };
      const onAbort = () => {
        const error = createAbortError(`${operation} aborted`);
        if (pendingMethod) rejectPendingRequestsByMethod(pendingMethod, error);
        finish(reject, error);
        beginDispose();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      promise.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }


  const ready = sendRequest("initialize", {
    clientInfo: { name: "niis", version: "0.1.0" },
    capabilities: {},
  }, {
    shutdownOnAbort: true,
    signal: initializationSignal,
  });

  async function runTurn({
    prompt,
    workdir = workspaceRoot,
    baseInstructions = null,
    model = null,
    approvalPolicy = "never",
    sandbox = "read-only",
    signal = null,
    onEvent = null,
  }) {
    await waitForPromiseWithSignal(ready, signal, "initialize", {
      pendingMethod: "initialize",
    });
    const turnSandbox = createTurnSandboxPolicy({
      sandbox,
      workdir,
    });




    const threadParams = {
      cwd: turnSandbox.canonicalWorkdir,
      approvalPolicy,
      sandbox,
      ephemeral: true,
    };
    if (baseInstructions) threadParams.baseInstructions = baseInstructions;
    if (model) threadParams.config = { model };
    const threadResult = await sendRequest("thread/start", threadParams, {
      shutdownOnAbort: true,
      signal,
    });
    const threadId = threadResult?.thread?.id ?? threadResult?.threadId;
    if (!threadId) throw new Error(`thread/start returned no thread id: ${JSON.stringify(threadResult).slice(0, 200)}`);

    const events = [];
    let assembledText = "";
    let lastTurnId = null;
    let usage = null;
    let errorInfo = null;
    let removeTurnListener = null;
    let removeTurnAbortListener = null;

    const turnDone = new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        removeTurnListener?.();
        removeTurnAbortListener?.();
        removeTurnListener = null;
        removeTurnAbortListener = null;
        callback(value);
      };
      removeTurnListener = onNotification((evt) => {
        if (evt.kind === "_exit") {
          finish(
            reject,
            new Error(`codex exited mid-turn (code=${evt.code}, signal=${evt.signal}). stderr: ${evt.stderr.slice(-400)}`),
          );
          return;
        }
        if (evt.kind !== "notification") return;
        events.push({ at: nowMs(), method: evt.method, params: evt.params });
        if (onEvent) try { onEvent(evt); } catch {}




        switch (evt.method) {
          case "item/agentMessage/delta": {
            if (evt.params?.threadId === threadId && typeof evt.params?.delta === "string") {
              assembledText += evt.params.delta;
              lastTurnId = evt.params.turnId ?? lastTurnId;
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            if (evt.params?.threadId === threadId && evt.params?.tokenUsage) {
              usage = evt.params.tokenUsage;
            }
            break;
          }
          case "turn/completed": {
            if (evt.params?.threadId === threadId) {
              const turn = evt.params.turn ?? {};
              errorInfo = turn.error ?? turn.errorInfo ?? null;
              if (errorInfo) {
                finish(
                  reject,
                  new Error(`turn completed with error: ${JSON.stringify(errorInfo).slice(0, 400)}`),
                );
              } else {
                finish(resolve);
              }
            }
            break;
          }
          case "error":
          case "thread/error": {
            finish(
              reject,
              new Error(`server error notification: ${JSON.stringify(evt.params).slice(0, 400)}`),
            );
            break;
          }
        }
      });

      if (signal) {
        const onAbort = () => {
          sendRequest("turn/interrupt", { threadId }).catch(() => {});
          finish(reject, createAbortError("turn aborted"));
          beginDispose();
        };
        removeTurnAbortListener = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });

    try {
      await Promise.all([
        sendRequest("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt }],
          sandboxPolicy: turnSandbox.policy,
        }, {
          shutdownOnAbort: true,
          signal,
        }),
        turnDone,
      ]);
    } finally {
      removeTurnListener?.();
      removeTurnAbortListener?.();
    }

    return {
      text: assembledText,
      threadId,
      turnId: lastTurnId,
      events,
      usage,
      errorInfo,
      sandboxPolicy: turnSandbox.policy,
    };
  }

  function isProcessTreeAlive() {
    if (processGroupId !== null) {
      try {
        process.kill(-processGroupId, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        return true;
      }
    }
    return !exited;
  }

  function signalProcessTree(signal) {
    if (processGroupId !== null) {
      try {
        process.kill(-processGroupId, signal);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    }
    if (exited) return false;
    return child.kill(signal);
  }

  async function waitForProcessTreeExit(timeoutMs) {
    const deadline = nowMs() + timeoutMs;
    while (isProcessTreeAlive() || !exited) {
      const remaining = deadline - nowMs();
      if (remaining <= 0) return false;
      const tick = new Promise((resolve) =>
        setTimeout(resolve, Math.min(remaining, 10)));
      await (exited ? tick : Promise.race([childExit, tick]));
    }
    return true;
  }

  async function dispose() {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      let escalated = false;
      let shutdownSignal = null;
      try {
        try { child.stdin.end(); } catch {}
        if (!isProcessTreeAlive() && exited) {
          return {
            escalated,
            exitInfo,
            processGroupId,
            shutdownSignal,
          };
        }

        if (signalProcessTree("SIGTERM")) shutdownSignal = "SIGTERM";
        if (!await waitForProcessTreeExit(termTimeoutMs)) {
          escalated = true;
          if (signalProcessTree("SIGKILL")) shutdownSignal = "SIGKILL";
          if (!await waitForProcessTreeExit(killTimeoutMs)) {
            const error = new Error(
              `codex app-server process tree did not exit within ${termTimeoutMs + killTimeoutMs}ms`,
            );
            error.code = "CODEX_APP_SERVER_SHUTDOWN_TIMEOUT";
            throw error;
          }
        }
        return {
          escalated,
          exitInfo,
          processGroupId,
          shutdownSignal,
        };
      } finally {
        cleanupSandbox();
      }
    })();
    return disposePromise;
  }

  return {
    appliedDeniedReadRoots: invocation.appliedDeniedReadRoots ?? [],
    runTurn,
    dispose,
    ready,
    onNotification,
    sandboxBackend: invocation.backend,
    skippedDeniedReadRoots: invocation.skippedDeniedReadRoots ?? [],
  };
}












const STREAM_VISIBLE_METHODS = new Set([
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "thread/started",
  "thread/status/changed",
  "turn/started",
  "turn/completed",
  "error",
  "thread/error",
  "exec/output/delta",
]);

function defaultStderrStream(evt) {
  if (evt.kind !== "notification") return;
  if (!STREAM_VISIBLE_METHODS.has(evt.method)) return;
  let summary = "";
  if (evt.method === "item/agentMessage/delta") {
    const d = String(evt.params?.delta ?? "");
    summary = `delta(${d.length})`;
  } else if (evt.method === "item/started" || evt.method === "item/completed") {
    summary = `item:${evt.params?.item?.type ?? "?"}`;
  } else if (evt.method === "thread/status/changed") {
    summary = `status:${evt.params?.status?.type ?? "?"}`;
  } else if (evt.method === "turn/completed") {
    summary = `status:${evt.params?.turn?.status ?? "?"}`;
  } else if (evt.method === "error" || evt.method === "thread/error") {
    summary = `err:${(evt.params?.error?.message ?? String(evt.params)).slice(0, 200)}`;
  }
  process.stderr.write(`[codex-stream] ${evt.method} ${summary}\n`);
}

export async function runCodexAppServerExecution({
  commandPath,
  deniedReadRoots = null,
  prompt,
  workspaceRoot,
  modelPreference = null,
  signal = null,
  baseInstructions = null,
  onEvent = defaultStderrStream,
  debug = false,




  sandbox = "read-only",
  approvalPolicy = "never",
  shutdownTermTimeoutMs = DEFAULT_SHUTDOWN_TERM_TIMEOUT_MS,
  shutdownKillTimeoutMs = DEFAULT_SHUTDOWN_KILL_TIMEOUT_MS,
}) {
  if (!Array.isArray(deniedReadRoots) || deniedReadRoots.length === 0) {
    const error = new Error("Codex execution requires at least one denied read root");
    error.code = "runtime_denied_read_roots_missing";
    error.category = "env_block";
    error.retrySafe = false;
    throw error;
  }
  const model = (modelPreference && modelPreference.runtime === "codex_local"
    && typeof modelPreference.model === "string" && modelPreference.model.trim())
    ? modelPreference.model.trim()
    : null;
  const client = createCodexAppServerClient({
    commandPath,
    deniedReadRoots,
    workspaceRoot,
    debug,
    signal,
    shutdownTermTimeoutMs,
    shutdownKillTimeoutMs,
  });
  try {
    const result = await client.runTurn({
      prompt,
      workdir: workspaceRoot,
      baseInstructions,
      model,
      signal,
      onEvent,
      sandbox,
      approvalPolicy,
    });
    if (result.errorInfo) {
      throw new Error(`codex app-server returned errorInfo: ${JSON.stringify(result.errorInfo).slice(0, 300)}`);
    }
    const readEnforced = [
      "darwin-seatbelt-read-contained",
      "darwin-seatbelt-workspace-write-contained",
      "linux-bubblewrap-read-contained",
      "linux-bubblewrap-workspace-write-contained",
    ].includes(client.sandboxBackend);
    const writeEnforced = result.sandboxPolicy?.type === "workspaceWrite";
    return {
      artifactPath: null,
      cost: result.usage ? extractCostFromUsage(result.usage) : null,
      raw: {
        exit_code: 0,
        runtime_sandbox_backend: client.sandboxBackend,
        security_evidence: {
          applied_denied_read_roots: client.appliedDeniedReadRoots,
          filesystem_backend: writeEnforced ? "codex-app-server-turn-workspace-write" : null,
          filesystem_enforced: readEnforced && writeEnforced,
          network_backend: "codex-app-server-turn-sandbox",
          network_enforced: result.sandboxPolicy?.networkAccess === false,
          read_backend: client.sandboxBackend,
          read_enforced: readEnforced,
          skipped_denied_read_roots: client.skippedDeniedReadRoots,
          write_backend: writeEnforced ? "codex-app-server-turn-workspace-write" : null,
          write_enforced: writeEnforced,
        },
        stderr: "",
        stdout: JSON.stringify({ threadId: result.threadId, turnId: result.turnId, events: result.events.length }),
      },
      summary: result.text || "(empty agent message)",
      events: result.events,
      usage: result.usage,
      threadId: result.threadId,
      turnId: result.turnId,
    };
  } finally {
    await client.dispose();
  }
}

function extractCostFromUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = usage.inputTokens ?? usage.input_tokens ?? null;
  const output = usage.outputTokens ?? usage.output_tokens ?? null;
  if (input === null && output === null) return null;
  return { input_tokens: input, output_tokens: output };
}
