import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeAdapterResult,
  runAdapterDiagnostics,
} from "../core/src/contracts/adapter.js";
import { createClaudeCodeLocalAdapter } from "./claude-code-local-adapter.js";
import { createCodexLocalAdapter } from "./codex-local-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureRuntimePath = path.join(__dirname, "test-fixtures", "local-runtime-echo.js");
const writeProbeRuntimePath = path.join(
  __dirname,
  "test-fixtures",
  "local-runtime-write-probe.js",
);
const hasStandaloneExecutionSandbox = (
  (
    process.platform === "darwin"
    && fs.existsSync("/usr/bin/sandbox-exec")
  )
  || (
    process.platform === "linux"
    && ["/usr/bin/bwrap", "/bin/bwrap"].some((candidate) => fs.existsSync(candidate))
  )
) && !(
  process.env.CODEX_SANDBOX
  && process.env.NODE_TEST_CONTEXT
);

function createTermResistantProcessTreeFixture(root) {
  const wrapperPath = path.join(root, "term-wrapper.cjs");
  const readyPath = path.join(root, "grandchild.pid");
  const grandchildSource = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  fs.writeFileSync(wrapperPath, [
    "#!/usr/bin/env node",
    "const { spawn } = require('node:child_process');",
    "process.on('SIGTERM', () => process.exit(0));",
    `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: "ignore" });`,
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"), { mode: 0o700 });
  return { readyPath, wrapperPath };
}

function isProcessAlive(pid) {
  if (process.platform === "linux") {
    try {
      if (/\)\s+Z(?:\s|$)/u.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))) return false;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return false;
    throw error;
  }
}

async function waitForReadyProcess(readyPath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyPath)) {
      const pid = Number(fs.readFileSync(readyPath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`grandchild did not become ready: ${readyPath}`);
}

test("createCodexLocalAdapter runs diagnostics and normalized execution as a first-class local runtime", async () => {
  const adapter = createCodexLocalAdapter({
    command: process.execPath,
    args: [fixtureRuntimePath, "--runtime", "codex_local"],
  });

  const diagnostics = await runAdapterDiagnostics({
    adapter,
    config: {},
  });
  const result = await adapter.execute({
    expected_workspace_path: __dirname,
    task: {
      title: "codex prompt",
    },
    workspacePath: __dirname,
  });
  const normalized = normalizeAdapterResult(adapter, result);

  assert.equal(adapter.protocolType, "local_cli");
  assert.equal(adapter.capabilities().adapter_kind, "codex_local");
  assert.equal(diagnostics.ok, true);
  assert.equal(normalized.status, "SUCCESS");
  assert.equal(normalized.summary, "codex_local:codex prompt");
  assert.equal(normalized.cost.input_tokens, 150);
  assert.equal(normalized.cost.output_tokens, 42);
  assert.equal(normalized.cost.estimated_usd, 0.003);
});

test("createClaudeCodeLocalAdapter runs diagnostics and normalized execution as a first-class local runtime", async () => {
  const adapter = createClaudeCodeLocalAdapter({
    command: process.execPath,
    args: [fixtureRuntimePath, "--runtime", "claude_code_local"],
  });

  const diagnostics = await runAdapterDiagnostics({
    adapter,
    config: {},
  });
  const result = await adapter.execute({
    expected_workspace_path: __dirname,
    task: {
      title: "claude prompt",
    },
    workspace_path: __dirname,
  });
  const normalized = normalizeAdapterResult(adapter, result);

  assert.equal(adapter.protocolType, "local_cli");
  assert.equal(adapter.capabilities().adapter_kind, "claude_code_local");
  assert.equal(diagnostics.ok, true);
  assert.equal(normalized.status, "SUCCESS");
  assert.equal(normalized.summary, "claude_code_local:claude prompt");
  assert.equal(normalized.cost.input_tokens, 150);
  assert.equal(normalized.cost.output_tokens, 42);
  assert.equal(normalized.cost.estimated_usd, 0.003);
});

test("local runtime adapters fail closed without a materialized execution workspace", async () => {
  const adapter = createCodexLocalAdapter({
    command: process.execPath,
    args: [fixtureRuntimePath, "--runtime", "codex_local"],
    cwd: __dirname,
  });

  const result = await adapter.execute({
    task: {
      title: "must not run in the caller checkout",
    },
  });

  assert.equal(result.status, "ERROR");
  assert.equal(result.error.category, "env_block");
  assert.equal(result.error.retry_safe, false);
  assert.match(result.error.root_cause, /explicit per-attempt workspace/);
});

test("generic local runtime adapters fail closed when task network policy is declared", async () => {
  const adapter = createCodexLocalAdapter({
    command: process.execPath,
    args: [fixtureRuntimePath, "--runtime", "codex_local"],
  });
  const result = await adapter.execute({
    network_policy: { mode: "disabled" },
    sandbox_policy: { mode: "workspace-write" },
    task: { title: "must use dedicated network enforcement" },
    workspace_path: __dirname,
  });

  assert.equal(result.status, "ERROR");
  assert.equal(result.error.category, "env_block");
  assert.equal(result.error.retry_safe, false);
  assert.match(result.error.root_cause, /cannot enforce task network policy/u);
});

test("local runtime adapters honor cancellation before process start", async () => {
  const adapter = createClaudeCodeLocalAdapter({
    command: process.execPath,
    args: [fixtureRuntimePath, "--runtime", "claude_code_local"],
  });
  const controller = new AbortController();
  controller.abort();

  const result = await adapter.execute({
    abort_signal: controller.signal,
    task: {
      title: "cancelled",
    },
    workspace_path: __dirname,
  });

  assert.equal(result.status, "ERROR");
  assert.equal(result.error.category, "cancelled");
  assert.equal(result.error.retry_safe, false);
});

test("fake Claude can write only to its attempt workspace and isolated runtime temp", {
  skip: !hasStandaloneExecutionSandbox,
}, async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-local-write-sandbox-"),
  );
  const primaryCheckout = path.join(root, "primary-checkout");
  const protectedState = path.join(root, "protected-state");
  const workspaceRoot = path.join(root, "attempt-workspace");
  for (const directory of [primaryCheckout, protectedState, workspaceRoot]) {
    fs.mkdirSync(directory);
  }
  const escapeLink = path.join(workspaceRoot, "primary-link");
  fs.symlinkSync(primaryCheckout, escapeLink, "dir");
  const primaryTarget = path.join(primaryCheckout, "absolute-escape.txt");
  const symlinkTarget = path.join(escapeLink, "symlink-escape.txt");
  const workspaceTarget = path.join(workspaceRoot, "allowed.txt");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const adapter = createClaudeCodeLocalAdapter({
    args: [writeProbeRuntimePath],
    command: process.execPath,
    env: {
      FAKE_PRIMARY_TARGET: primaryTarget,
      FAKE_SYMLINK_TARGET: symlinkTarget,
      FAKE_WORKSPACE_TARGET: workspaceTarget,
    },
  });
  const result = await adapter.execute({
    sandbox_policy: {
      denied_read_roots: [protectedState],
      mode: "workspace-write",
    },
    task: { title: "write containment probe" },
    workspace_path: workspaceRoot,
  });

  assert.equal(result.status, "SUCCESS");
  const outcome = JSON.parse(result.summary);
  assert.match(outcome.backend, /workspace-write-contained/u);
  assert.equal(outcome.workspace, true);
  assert.equal(outcome.runtimeTemp, true);
  assert.equal(outcome.primary, false);
  assert.equal(outcome.symlink, false);
  assert.equal(fs.readFileSync(workspaceTarget, "utf8"), "probe\n");
  assert.equal(fs.existsSync(primaryTarget), false);
  assert.equal(fs.existsSync(path.join(primaryCheckout, "symlink-escape.txt")), false);
});

test("local runtime adapter kills TERM-resistant descendants on cancellation and timeout", {
  skip: process.platform === "win32",
}, async () => {
  for (const mode of ["cancel", "timeout"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-local-tree-"));
    const { readyPath, wrapperPath } = createTermResistantProcessTreeFixture(root);
    let grandchildPid = null;
    try {
      const adapter = createClaudeCodeLocalAdapter({
        command: wrapperPath,
      });
      const controller = new AbortController();
      const pending = adapter.execute({
        abort_signal: controller.signal,
        task: {
          title: `${mode} process tree`,
        },
        timeout_ms: mode === "timeout" ? 2_000 : 5_000,
        workspace_path: root,
      });
      grandchildPid = await waitForReadyProcess(readyPath);
      if (mode === "cancel") controller.abort();
      const result = await pending;

      assert.equal(result.status, "ERROR");
      assert.equal(
        result.error.category,
        mode === "cancel" ? "cancelled" : "transient",
      );
      assert.equal(isProcessAlive(grandchildPid), false);
    } finally {
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      fs.rmSync(root, { force: true, recursive: true });
    }
  }
});
