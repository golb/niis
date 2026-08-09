import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RuntimeReadSandboxError,
  createRuntimeExecutionSandboxInvocation,
  createRuntimeReadSandboxInvocation,
  normalizeRuntimeDeniedReadRoots,
  normalizeRuntimeExecutionPolicy,
} from "./runtime-read-sandbox.js";
import { createBubblewrapMaskEntries } from "../core/src/runtime/sandbox-path-rules.js";

function createFixture(t) {
  const protectedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-runtime-read-sandbox-"),
  );
  const workspaceRoot = path.join(protectedRoot, "worktrees", "attempt");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  t.after(() => fs.rmSync(protectedRoot, { force: true, recursive: true }));
  return { protectedRoot, workspaceRoot };
}

test("runtime read policy requires an explicit protected root distinct from the workspace", (t) => {
  const { protectedRoot, workspaceRoot } = createFixture(t);
  assert.deepEqual(
    normalizeRuntimeDeniedReadRoots({
      deniedReadRoots: [protectedRoot, protectedRoot],
      workspaceRoot,
    }),
    {
      deniedReadRoots: [fs.realpathSync(protectedRoot)],
      skippedDeniedReadRoots: [],
      workspaceRoot: fs.realpathSync(workspaceRoot),
    },
  );
  assert.throws(
    () => normalizeRuntimeDeniedReadRoots({
      deniedReadRoots: [],
      workspaceRoot,
    }),
    (error) =>
      error instanceof RuntimeReadSandboxError
      && error.code === "runtime_denied_read_roots_missing",
  );
  assert.throws(
    () => normalizeRuntimeDeniedReadRoots({
      deniedReadRoots: [workspaceRoot],
      workspaceRoot,
    }),
    (error) =>
      error instanceof RuntimeReadSandboxError
      && error.code === "runtime_workspace_denied",
  );
});

test("runtime read policy records unavailable roots and fails when none can be applied", (t) => {
  const { protectedRoot, workspaceRoot } = createFixture(t);
  const missingRoot = path.join(protectedRoot, "missing");
  assert.deepEqual(
    normalizeRuntimeDeniedReadRoots({
      deniedReadRoots: [protectedRoot, missingRoot],
      workspaceRoot,
    }),
    {
      deniedReadRoots: [fs.realpathSync(protectedRoot)],
      skippedDeniedReadRoots: [missingRoot],
      workspaceRoot: fs.realpathSync(workspaceRoot),
    },
  );
  assert.throws(
    () => normalizeRuntimeDeniedReadRoots({
      deniedReadRoots: [missingRoot],
      workspaceRoot,
    }),
    (error) =>
      error instanceof RuntimeReadSandboxError
      && error.code === "runtime_denied_read_roots_unavailable"
      && error.skippedDeniedReadRoots.includes(missingRoot),
  );
});

test("bubblewrap masks directories and files with compatible mount types", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bwrap-mask-"));
  const directoryRoot = path.join(root, "directory");
  const fileRoot = path.join(root, "file");
  const missingRoot = path.join(root, "missing");
  fs.mkdirSync(directoryRoot);
  fs.writeFileSync(fileRoot, "secret\n");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  assert.deepEqual(createBubblewrapMaskEntries(
    [directoryRoot, fileRoot, missingRoot],
    [],
  ), [
    { lines: ["--tmpfs", directoryRoot], path: directoryRoot, rank: 0 },
    { lines: ["--ro-bind", "/dev/null", fileRoot], path: fileRoot, rank: 0 },
  ]);
});

test("runtime execution policy canonicalizes the workspace and validates optional denied roots", (t) => {
  const { protectedRoot, workspaceRoot } = createFixture(t);
  assert.deepEqual(
    normalizeRuntimeExecutionPolicy({
      workspaceRoot,
    }),
    {
      deniedReadRoots: [],
      skippedDeniedReadRoots: [],
      workspaceRoot: fs.realpathSync(workspaceRoot),
    },
  );
  assert.deepEqual(
    normalizeRuntimeExecutionPolicy({
      deniedReadRoots: [protectedRoot],
      workspaceRoot,
    }),
    {
      deniedReadRoots: [fs.realpathSync(protectedRoot)],
      skippedDeniedReadRoots: [],
      workspaceRoot: fs.realpathSync(workspaceRoot),
    },
  );
  assert.throws(
    () => normalizeRuntimeExecutionPolicy({
      deniedReadRoots: "not-an-array",
      workspaceRoot,
    }),
    (error) =>
      error instanceof RuntimeReadSandboxError
      && error.code === "runtime_denied_read_roots_invalid",
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

test("runtime OS sandbox hides canonical state while preserving the attempt workspace", {
  skip: !hasStandaloneReadSandbox,
}, (t) => {
  const { protectedRoot, workspaceRoot } = createFixture(t);
  const secretPath = path.join(protectedRoot, "secrets", "master-key");
  const workspaceMarkerPath = path.join(workspaceRoot, "workspace-marker.txt");
  const scriptPath = path.join(workspaceRoot, "probe.mjs");
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, "must-not-escape\n", { mode: 0o600 });
  fs.writeFileSync(workspaceMarkerPath, "workspace-visible\n", { mode: 0o600 });
  fs.writeFileSync(
    scriptPath,
    [
      'import fs from "node:fs";',
      `process.stdout.write(fs.readFileSync(${JSON.stringify(workspaceMarkerPath)}, "utf8"));`,
      `process.stdout.write(fs.readFileSync(${JSON.stringify(secretPath)}, "utf8"));`,
      "",
    ].join("\n"),
  );
  const invocation = createRuntimeReadSandboxInvocation({
    args: [scriptPath],
    commandPath: process.execPath,
    deniedReadRoots: [protectedRoot],
    workspaceRoot,
  });
  t.after(() => invocation.cleanup());

  const result = spawnSync(invocation.command, invocation.args, {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /^workspace-visible$/mu);
  assert.doesNotMatch(result.stdout, /must-not-escape/u);
});

test("execution sandbox exposes only workspace/runtime write roots and keeps network shared", (t) => {
  const { protectedRoot, workspaceRoot } = createFixture(t);
  const invocation = createRuntimeExecutionSandboxInvocation({
    args: ["--version"],
    commandPath: process.execPath,
    deniedReadRoots: [protectedRoot],
    workspaceRoot,
  });
  t.after(() => invocation.cleanup());

  assert.equal(fs.statSync(invocation.runtimeRoot).isDirectory(), true);
  for (const variable of [
    "npm_config_cache",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
  ]) {
    const candidate = path.resolve(invocation.env[variable]);
    assert.equal(
      candidate === invocation.runtimeRoot
      || candidate.startsWith(`${invocation.runtimeRoot}${path.sep}`),
      true,
      `${variable} escaped the isolated runtime root`,
    );
  }

  if (invocation.backend === "darwin-seatbelt-workspace-write-contained") {
    const profile = fs.readFileSync(invocation.args[1], "utf8");
    assert.match(profile, /\(deny file-write\*\)/u);
    assert.match(profile, new RegExp(
      workspaceRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
      "u",
    ));
    assert.match(profile, new RegExp(
      invocation.runtimeRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
      "u",
    ));
    assert.doesNotMatch(profile, /\bnetwork\b/u);
  }
  if (invocation.backend === "linux-bubblewrap-workspace-write-contained") {
    assert.deepEqual(invocation.args.slice(0, 7), [
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--ro-bind",
      "/",
      "/",
      "--dev",
    ]);
    assert.equal(invocation.args.includes("--unshare-net"), false);
    assert.equal(invocation.args.includes("--share-net"), false);
  }
});





function createNestedDeniedRootFixture(t) {
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-nested-denied-root-"),
  ));
  const deniedRoot = path.join(workspaceRoot, ".niis");
  fs.mkdirSync(path.join(deniedRoot, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(deniedRoot, "secrets", "master-key"), "must-not-escape\n", { mode: 0o600 });
  t.after(() => fs.rmSync(workspaceRoot, { force: true, recursive: true }));
  return { deniedRoot, workspaceRoot };
}

test("a denied read root nested inside the workspace is not re-opened by the workspace rule", (t) => {
  const { deniedRoot, workspaceRoot } = createNestedDeniedRootFixture(t);

  for (const invocation of [
    createRuntimeReadSandboxInvocation({
      args: ["--version"],
      commandPath: process.execPath,
      deniedReadRoots: [deniedRoot],
      workspaceRoot,
    }),
    createRuntimeExecutionSandboxInvocation({
      args: ["--version"],
      commandPath: process.execPath,
      deniedReadRoots: [deniedRoot],
      workspaceRoot,
    }),
  ]) {
    t.after(() => invocation.cleanup());

    if (invocation.backend.startsWith("darwin-seatbelt")) {
      const profile = fs.readFileSync(invocation.args[1], "utf8");
      const allowIndex = profile.indexOf(`(subpath "${workspaceRoot}")`);
      const denyReadIndex = profile.indexOf(`(deny file-read* (subpath "${deniedRoot}"))`);
      const denyWriteIndex = profile.indexOf(`(deny file-write* (subpath "${deniedRoot}"))`);
      assert.notEqual(allowIndex, -1, `${invocation.backend}: workspace allow missing`);
      assert.notEqual(denyReadIndex, -1, `${invocation.backend}: read deny missing`);
      assert.notEqual(denyWriteIndex, -1, `${invocation.backend}: write deny missing`);
      assert.equal(denyReadIndex > allowIndex, true, `${invocation.backend}: read deny must outrank the workspace allow`);
      assert.equal(denyWriteIndex > allowIndex, true, `${invocation.backend}: write deny must outrank the workspace allow`);
    }

    if (invocation.backend.startsWith("linux-bubblewrap")) {
      const bindIndex = invocation.args.findIndex((entry, index) =>
        entry === "--bind" && invocation.args[index + 1] === workspaceRoot);
      const maskIndex = invocation.args.findIndex((entry, index) =>
        entry === "--tmpfs" && invocation.args[index + 1] === deniedRoot);
      assert.notEqual(bindIndex, -1, `${invocation.backend}: workspace bind missing`);
      assert.notEqual(maskIndex, -1, `${invocation.backend}: denied root mask missing`);
      assert.equal(maskIndex > bindIndex, true, `${invocation.backend}: mask must be applied after the workspace bind`);
    }
  }
});

test("the OS sandbox keeps a workspace-nested denied root unreadable and unwritable", {
  skip: !hasStandaloneReadSandbox,
}, (t) => {
  const { deniedRoot, workspaceRoot } = createNestedDeniedRootFixture(t);
  const secretPath = path.join(deniedRoot, "secrets", "master-key");
  const scriptPath = path.join(workspaceRoot, "probe.mjs");
  fs.writeFileSync(
    scriptPath,
    [
      'import fs from "node:fs";',
      "const report = (label, run) => {",
      '  try { process.stdout.write(`${label}:ALLOWED:${run() ?? ""}\\n`); }',
      "  catch (error) { process.stdout.write(`${label}:${error.code}\\n`); }",
      "};",
      `report("workspace", () => fs.writeFileSync(${JSON.stringify(path.join(workspaceRoot, "written.txt"))}, "ok"));`,
      `report("read", () => fs.readFileSync(${JSON.stringify(secretPath)}, "utf8"));`,
      `report("list", () => fs.readdirSync(${JSON.stringify(deniedRoot)}).join("|"));`,
      `report("write", () => fs.writeFileSync(${JSON.stringify(path.join(deniedRoot, "pwned.txt"))}, "x"));`,
      "",
    ].join("\n"),
  );
  const invocation = createRuntimeReadSandboxInvocation({
    args: [scriptPath],
    commandPath: process.execPath,
    deniedReadRoots: [deniedRoot],
    workspaceRoot,
  });
  t.after(() => invocation.cleanup());

  const result = spawnSync(invocation.command, invocation.args, {
    cwd: workspaceRoot,
    encoding: "utf8",
  });


  assert.match(result.stdout, /^workspace:ALLOWED/mu);
  assert.doesNotMatch(result.stdout, /must-not-escape/u);
  assert.equal(fs.existsSync(path.join(deniedRoot, "pwned.txt")), false);
  assert.equal(fs.readFileSync(secretPath, "utf8"), "must-not-escape\n");


  if (invocation.backend.startsWith("darwin-seatbelt")) {
    assert.match(result.stdout, /^read:EPERM$/mu);
    assert.match(result.stdout, /^list:EPERM$/mu);
    assert.match(result.stdout, /^write:EPERM$/mu);
  }


  if (invocation.backend.startsWith("linux-bubblewrap")) {
    assert.match(result.stdout, /^read:ENOENT$/mu);
    assert.match(result.stdout, /^list:ALLOWED:$/mu);
    assert.match(result.stdout, /^write:ALLOWED/mu);
  }
});

test("sandbox paths carrying control characters are rejected instead of injecting profile syntax", (t) => {
  const { protectedRoot, workspaceRoot } = createFixture(t);
  const injectedWorkspace = path.join(workspaceRoot, 'x")\n(allow file-read* (subpath "/');
  fs.mkdirSync(injectedWorkspace, { recursive: true });

  assert.throws(
    () => createRuntimeReadSandboxInvocation({
      args: [],
      commandPath: process.execPath,
      deniedReadRoots: [protectedRoot],
      workspaceRoot: injectedWorkspace,
    }),
    (error) =>
      error instanceof RuntimeReadSandboxError
      && error.code === "runtime_workspace_root_invalid",
  );
});
