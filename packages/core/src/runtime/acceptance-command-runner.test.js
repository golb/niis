import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  AcceptanceCommandRunnerError,
  normalizeDeniedReadRoots,
  runAcceptanceCommand,
  runAcceptanceCommandPlan,
  sanitizeAcceptanceCommandEnvironment,
} from "./acceptance-command-runner.js";

function createWorkspace(t) {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "niis-acceptance-runner-"));
  t.after(() => fs.rmSync(workspacePath, { force: true, recursive: true }));
  return workspacePath;
}

function writeTestFile(workspacePath, fileName, body) {
  const filePath = path.join(workspacePath, fileName);
  fs.writeFileSync(
    filePath,
    `import test from "node:test";\n${body}\n`,
  );
  return fileName;
}

function createTermResistantProcessTreeFixture(workspacePath, name) {
  const wrapperName = `${name}.cjs`;
  const wrapperPath = path.join(workspacePath, wrapperName);
  const readyPath = path.join(workspacePath, `${name}.pid`);
  const grandchildSource = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  fs.writeFileSync(wrapperPath, [
    "const { spawn } = require('node:child_process');",
    "const test = require('node:test');",
    "process.on('SIGTERM', () => process.exit(0));",
    "test('term-resistant process tree', async () => {",
    `  spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: "ignore" });`,
    "  await new Promise(() => {});",
    "});",
    "",
  ].join("\n"));
  return { readyPath, wrapperName };
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

async function waitForReadyProcess(readyPath, timeoutMs = 2_000) {
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

test("runs normalized argv without a shell and returns hash-linked evidence", async (t) => {
  const workspacePath = createWorkspace(t);
  const testFile = writeTestFile(
    workspacePath,
    "output.test.js",
    'test("output", () => { process.stdout.write("verified"); process.stderr.write("notice"); });',
  );
  const result = await runAcceptanceCommand({
    command: {
      argv: [process.execPath, "--test", testFile],
      id: "focused-check",
      required: true,
    },
    workspacePath,
  });

  assert.equal(result.ok, true);
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout.text, /verified/);
  assert.match(`${result.stdout.text}\n${result.stderr.text}`, /notice/);
  assert.equal(
    result.stdout.sha256,
    createHash("sha256").update(result.stdout.text).digest("hex"),
  );
  assert.equal(
    result.stderr.sha256,
    createHash("sha256").update(result.stderr.text).digest("hex"),
  );
  assert.equal(result.raw_output_ref, `sha256:${result.evidence_sha256}`);
  assert.equal(result.evidence_item.raw_output_ref, result.raw_output_ref);
  assert.equal(result.evidence_item.source, "acceptance-command:focused-check");
});

test("sanitizes the command environment to runtime essentials without inheriting secrets", async (t) => {
  const sanitized = sanitizeAcceptanceCommandEnvironment({
    CI: "1",
    HOME: "/safe-home",
    NODE_OPTIONS: "--require=untrusted-module",
    NPM_CONFIG_CACHE: "/safe-cache",
    PATH: process.env.PATH ?? "",
    PRIVATE_TEST_SECRET: "must-not-pass",
  });

  assert.deepEqual(sanitized, {
    PATH: process.env.PATH ?? "",
    HOME: "/safe-home",
    CI: "1",
    NPM_CONFIG_CACHE: "/safe-cache",
  });
  assert.equal(Object.isFrozen(sanitized), true);

  const workspacePath = createWorkspace(t);
  const testFile = writeTestFile(
    workspacePath,
    "environment.test.js",
    'test("environment", () => { if (process.env.PRIVATE_TEST_SECRET !== undefined) throw new Error("secret inherited"); });',
  );
  const result = await runAcceptanceCommand({
    command: {
      argv: [process.execPath, "--test", testFile],
      id: "environment-check",
      required: true,
    },
    env: {
      PATH: process.env.PATH ?? "",
      PRIVATE_TEST_SECRET: "must-not-pass",
    },
    workspacePath,
  });
  assert.equal(result.ok, true);
});

test("normalizes protected read roots without collapsing an attempt worktree inside one", (t) => {
  const protectedRoot = createWorkspace(t);
  const workspacePath = path.join(protectedRoot, "worktrees", "attempt");
  fs.mkdirSync(workspacePath, { recursive: true });

  assert.deepEqual(
    normalizeDeniedReadRoots(
      [protectedRoot, `${protectedRoot}${path.sep}.`],
      fs.realpathSync(workspacePath),
    ),
    [fs.realpathSync(protectedRoot)],
  );
  assert.throws(
    () => normalizeDeniedReadRoots([workspacePath], fs.realpathSync(workspacePath)),
    (error) =>
      error instanceof AcceptanceCommandRunnerError
      && error.code === "invalid_acceptance_command_runner_options",
  );
});

const hasStandaloneReadSandbox = (
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

test("OS sandbox denies a script access to canonical protected state", {
  skip: !hasStandaloneReadSandbox,
}, async (t) => {
  const protectedRoot = createWorkspace(t);
  const workspacePath = path.join(protectedRoot, "worktrees", "attempt");
  fs.mkdirSync(workspacePath, { recursive: true });
  const secretPath = path.join(protectedRoot, "secrets", "master-key");
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, "must-not-escape\n", { mode: 0o600 });
  const scriptPath = path.join(workspacePath, "read-protected.mjs");
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(secretPath)}, "utf8"));\n`,
  );

  const result = await runAcceptanceCommand({
    command: {
      argv: [process.execPath, "--test", path.basename(scriptPath)],
      id: "protected-read",
      required: true,
    },
    deniedReadRoots: [protectedRoot],
    workspacePath,
  });

  assert.equal(result.ok, false);
  assert.doesNotMatch(result.stdout.text, /must-not-escape/u);
});

test("bounds displayed output while hashing the complete stream", async (t) => {
  const workspacePath = createWorkspace(t);
  const fullOutput = "x".repeat(4096);
  const testFile = writeTestFile(
    workspacePath,
    "bounded.test.js",
    `test("bounded", () => { process.stdout.write("x".repeat(${fullOutput.length})); });`,
  );
  const result = await runAcceptanceCommand({
    command: {
      argv: [process.execPath, "--test", testFile],
      id: "bounded-output",
      required: true,
    },
    maxOutputBytes: 32,
    workspacePath,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout.bytes >= fullOutput.length, true);
  assert.equal(result.stdout.captured_bytes, 32);
  assert.equal(result.stdout.text.length, 32);
  assert.match(result.stdout.text, /x/u);
  assert.equal(result.stdout.truncated, true);
  assert.match(result.stdout.sha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(
    result.stdout.sha256,
    createHash("sha256").update(result.stdout.text).digest("hex"),
    "the digest must cover more than the displayed prefix",
  );
});

test("passes an argv item containing spaces without shell tokenization", async (t) => {
  const workspacePath = createWorkspace(t);
  const testFile = writeTestFile(
    workspacePath,
    "one argument.test.js",
    'test("space path", () => {});',
  );
  const result = await runAcceptanceCommand({
    command: {
      argv: [process.execPath, "--check", testFile],
      id: "literal-argv",
      required: true,
    },
    workspacePath,
  });

  assert.equal(result.ok, true);
});

test("runs in the attempt workspace and rejects a missing workspace", async (t) => {
  const workspacePath = createWorkspace(t);
  execFileSync("git", ["init"], { cwd: workspacePath });
  const result = await runAcceptanceCommand({
    command: {
      argv: ["git", "rev-parse", "--show-toplevel"],
      id: "workspace-check",
      required: true,
    },
    workspacePath,
  });

  assert.equal(result.stdout.text.trim(), fs.realpathSync(workspacePath));
  await assert.rejects(
    runAcceptanceCommand({
      command: {
        argv: [process.execPath, "--version"],
        id: "missing-workspace",
        required: true,
      },
      workspacePath: path.join(workspacePath, "missing"),
    }),
    AcceptanceCommandRunnerError,
  );
});

test("reports an allowlisted executable spawn failure without throwing away evidence", async (t) => {
  const workspacePath = createWorkspace(t);
  const result = await runAcceptanceCommand({
    command: {
      argv: ["node", "--version"],
      id: "spawn-error",
      required: true,
    },
    env: { PATH: "" },
    workspacePath,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "ERROR");
  assert.equal(result.exit_code, -1);
  assert.match(result.spawn_error, /ENOENT/);
  assert.equal(result.evidence_item.raw_output_ref, result.raw_output_ref);
});




test("keeps a resolvable command that exits non-zero classified as FAIL", async (t) => {
  const workspacePath = createWorkspace(t);
  const testFile = writeTestFile(
    workspacePath,
    "resolvable-failure.test.js",
    'test("boom", () => { throw new Error("boom"); });',
  );
  const result = await runAcceptanceCommand({
    command: {
      argv: ["node", "--test", testFile],
      id: "resolvable-failure",
      required: true,
    },
    workspacePath,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "FAIL");
  assert.equal(result.spawn_error, null);
  assert.notEqual(result.exit_code, -1);
});

test("times out and force-stops a long-running command", async (t) => {
  const workspacePath = createWorkspace(t);
  const testFile = writeTestFile(
    workspacePath,
    "timeout.test.js",
    'test("wait", async () => { await new Promise((resolve) => setTimeout(resolve, 10000)); });',
  );
  const result = await runAcceptanceCommand({
    command: {
      argv: [process.execPath, "--test", testFile],
      id: "timeout-check",
      required: true,
    },
    timeoutMs: 30,
    workspacePath,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "TIMEOUT");
  assert.equal(result.timed_out, true);
  assert.equal(result.exit_code, 124);
});

test("honors AbortSignal and reports cancellation as evidence", async (t) => {
  const workspacePath = createWorkspace(t);
  const testFile = writeTestFile(
    workspacePath,
    "cancel.test.js",
    'test("wait", async () => { await new Promise((resolve) => setTimeout(resolve, 10000)); });',
  );
  const controller = new AbortController();
  const pending = runAcceptanceCommand({
    command: {
      argv: [process.execPath, "--test", testFile],
      id: "cancel-check",
      required: true,
    },
    signal: controller.signal,
    workspacePath,
  });
  setTimeout(() => controller.abort(), 30);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.aborted, true);
  assert.equal(result.exit_code, 130);
  assert.equal(result.evidence_item.raw_output_ref, result.raw_output_ref);

  await assert.rejects(
    runAcceptanceCommand({
      command: {
        argv: [process.execPath, "--version"],
        id: "invalid-signal",
        required: true,
      },
      signal: { aborted: false },
      workspacePath,
    }),
    /signal must be an AbortSignal/,
  );
});

test("timeout and cancellation kill TERM-resistant descendants before returning", {
  skip: process.platform === "win32",
}, async (t) => {
  for (const mode of ["timeout", "cancel"]) {
    const workspacePath = createWorkspace(t);
    const { readyPath, wrapperName } =
      createTermResistantProcessTreeFixture(workspacePath, mode);
    const controller = new AbortController();
    let grandchildPid = null;
    try {
      const pending = runAcceptanceCommand({
        command: {
          argv: [process.execPath, "--test", wrapperName],
          id: `${mode}-tree-check`,
          required: true,
        },
        signal: controller.signal,
        timeoutMs: mode === "timeout" ? 500 : 5_000,
        workspacePath,
      });
      grandchildPid = await waitForReadyProcess(readyPath);
      if (mode === "cancel") controller.abort();
      const result = await pending;

      assert.equal(result.status, mode === "timeout" ? "TIMEOUT" : "CANCELLED");
      assert.equal(isProcessAlive(grandchildPid), false);
    } finally {
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
    }
  }
});

test("runs a plan sequentially and identifies required failures", async (t) => {
  const workspacePath = createWorkspace(t);
  const requiredFile = writeTestFile(
    workspacePath,
    "required-failure.test.js",
    'test("required failure", () => { throw new Error("required"); });',
  );
  const optionalFile = writeTestFile(
    workspacePath,
    "optional-failure.test.js",
    'test("optional failure", () => { throw new Error("optional"); });',
  );
  const report = await runAcceptanceCommandPlan({
    acceptanceCommands: [
      {
        argv: [process.execPath, "--test", requiredFile],
        id: "required-failure",
        required: true,
      },
      {
        argv: [process.execPath, "--test", optionalFile],
        id: "optional-failure",
        required: false,
      },
    ],
    workspacePath,
  });

  assert.equal(report.results.length, 2);
  assert.equal(report.evidence_items.length, 2);
  assert.equal(report.hard_failures.length, 1);
  assert.equal(report.hard_failures[0].command_id, "required-failure");
  assert.equal(report.ok, false);
});

test("rejects traversal, absolute paths, and symlink escapes before spawn", async (t) => {
  const workspacePath = createWorkspace(t);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "niis-acceptance-outside-"));
  t.after(() => fs.rmSync(outsidePath, { force: true, recursive: true }));
  fs.writeFileSync(path.join(outsidePath, "outside.test.js"), "export {};\n");
  fs.symlinkSync(
    path.join(outsidePath, "outside.test.js"),
    path.join(workspacePath, "escaped.test.js"),
  );

  for (const operand of [
    "../outside.test.js",
    path.join(outsidePath, "outside.test.js"),
    "escaped.test.js",
    "file:///tmp/outside.test.js",
  ]) {
    await assert.rejects(
      runAcceptanceCommand({
        command: {
          argv: [process.execPath, "--check", operand],
          id: "path-policy",
          required: true,
        },
        workspacePath,
      }),
      (error) =>
        error instanceof AcceptanceCommandRunnerError
        && error.code === "acceptance_path_escape",
    );
  }
});

test("package-manager gates bind unchanged pre/main/post scripts to HEAD", async (t) => {
  const workspacePath = createWorkspace(t);
  execFileSync("git", ["init"], { cwd: workspacePath });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: workspacePath });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: workspacePath,
  });
  fs.writeFileSync(
    path.join(workspacePath, "package.json"),
    `${JSON.stringify({
      scripts: {
        posttest: "node --version",
        pretest: "node --version",
        test: "node --version",
      },
    }, null, 2)}\n`,
  );
  execFileSync("git", ["add", "package.json"], { cwd: workspacePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: workspacePath });

  const passed = await runAcceptanceCommand({
    command: {
      argv: ["npm", "test"],
      id: "bound-script",
      required: true,
    },
    workspacePath,
  });
  assert.equal(passed.ok, true);
  assert.equal(passed.manifest_binding.script_name, "test");
  assert.match(passed.manifest_binding.definitions_sha256, /^[a-f0-9]{64}$/u);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(workspacePath, "package.json"), "utf8"),
  );
  manifest.scripts.pretest = "node --check changed.js";
  fs.writeFileSync(
    path.join(workspacePath, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await assert.rejects(
    runAcceptanceCommand({
      command: {
        argv: ["npm", "test"],
        id: "mutated-script",
        required: true,
      },
      workspacePath,
    }),
    (error) =>
      error instanceof AcceptanceCommandRunnerError
      && error.code === "acceptance_manifest_changed",
  );
});
