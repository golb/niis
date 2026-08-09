import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createCodexAppServerClient,
} from "./codex-app-server-adapter.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  currentDirectory,
  "test-fixtures",
  "codex-app-server-fixture.js",
);
const supportsProcessGroups = process.platform !== "win32";

function makeFixtureWorkspace({
  grandchild = false,
  ignoreTerm = false,
  mode,
}) {
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-codex-app-server-"),
  );
  const pidFile = path.join(workspaceRoot, "pids.json");
  const requestLog = path.join(workspaceRoot, "requests.log");
  const requestPayloadLog = path.join(workspaceRoot, "request-payloads.jsonl");
  const wrapperPidFile = path.join(workspaceRoot, "wrapper.pid");
  fs.writeFileSync(
    path.join(workspaceRoot, "app-server"),
    [
      'printf "%s\\n" "$$" > "$NIIS_CODEX_FIXTURE_WRAPPER_PID_FILE"',
      '"$NIIS_TEST_NODE" "$NIIS_TEST_FIXTURE"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return {
    env: {
      ...process.env,
      NIIS_CODEX_FIXTURE_GRANDCHILD: grandchild ? "1" : "0",
      NIIS_CODEX_FIXTURE_IGNORE_TERM: ignoreTerm ? "1" : "0",
      NIIS_CODEX_FIXTURE_MODE: mode,
      NIIS_CODEX_FIXTURE_PID_FILE: pidFile,
      NIIS_CODEX_FIXTURE_REQUEST_LOG: requestLog,
      NIIS_CODEX_FIXTURE_REQUEST_PAYLOAD_LOG: requestPayloadLog,
      NIIS_CODEX_FIXTURE_WRAPPER_PID_FILE: wrapperPidFile,
      NIIS_TEST_FIXTURE: fixturePath,
      NIIS_TEST_NODE: process.execPath,
    },
    pidFile,
    requestLog,
    requestPayloadLog,
    wrapperPidFile,
    workspaceRoot,
  };
}

async function waitFor(predicate, {
  description,
  timeoutMs = 2_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description ?? "condition"}`);
}

async function waitForRequest(requestLog, method) {
  await waitFor(() =>
    fs.existsSync(requestLog)
    && fs.readFileSync(requestLog, "utf8").split("\n").includes(method), {
    description: `${method} request`,
  });
}

function readFixturePids(fixture) {
  return {
    ...JSON.parse(fs.readFileSync(fixture.pidFile, "utf8")),
    wrapperPid: Number.parseInt(
      fs.readFileSync(fixture.wrapperPidFile, "utf8").trim(),
      10,
    ),
  };
}

function readFixtureRequests(fixture) {
  return fs.readFileSync(fixture.requestPayloadLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function isProcessGroupAlive(processGroupId) {
  if (!supportsProcessGroups || !Number.isInteger(processGroupId)) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function assertFixtureTreeGone(pids) {
  await waitFor(() =>
    !isProcessAlive(pids.wrapperPid)
    && !isProcessAlive(pids.parentPid)
    && !isProcessAlive(pids.grandchildPid)
    && !isProcessGroupAlive(pids.wrapperPid), {
    description: "fixture process group to be reaped",
  });
}

function forceFixtureTreeExit(fixture) {
  if (
    !supportsProcessGroups
    || !fs.existsSync(fixture.pidFile)
    || !fs.existsSync(fixture.wrapperPidFile)
  ) return;
  const { wrapperPid } = readFixturePids(fixture);
  try {
    process.kill(-wrapperPid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

test("pre-aborted initialization signal prevents app-server spawn", () => {
  const controller = new AbortController();
  controller.abort();

  assert.throws(() => createCodexAppServerClient({
    commandPath: path.join(os.tmpdir(), "must-not-be-spawned"),
    signal: controller.signal,
    workspaceRoot: os.tmpdir(),
  }), (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "ABORT_ERR");
    return true;
  });
});

test("runTurn aborts a hung initialize request and reaps the app-server", {
  skip: !supportsProcessGroups,
}, async (t) => {
  const fixture = makeFixtureWorkspace({ mode: "hang-initialize" });
  let client = null;
  t.after(async () => {
    await client?.dispose().catch(() => {});
    forceFixtureTreeExit(fixture);
    fs.rmSync(fixture.workspaceRoot, { force: true, recursive: true });
  });
  client = createCodexAppServerClient({
    commandPath: "/bin/sh",
    env: fixture.env,
    shutdownKillTimeoutMs: 1_000,
    shutdownTermTimeoutMs: 50,
    workspaceRoot: fixture.workspaceRoot,
  });
  const controller = new AbortController();
  const execution = client.runTurn({
    prompt: "never runs",
    signal: controller.signal,
  });

  await waitForRequest(fixture.requestLog, "initialize");
  const pids = readFixturePids(fixture);
  controller.abort();

  await assert.rejects(execution, (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "ABORT_ERR");
    assert.match(error.message, /initialize aborted/);
    return true;
  });
  await client.dispose();
  await assertFixtureTreeGone(pids);
});

test("runTurn aborts a hung thread/start request and rejects the pending RPC", {
  skip: !supportsProcessGroups,
}, async (t) => {
  const fixture = makeFixtureWorkspace({ mode: "hang-thread-start" });
  let client = null;
  t.after(async () => {
    await client?.dispose().catch(() => {});
    forceFixtureTreeExit(fixture);
    fs.rmSync(fixture.workspaceRoot, { force: true, recursive: true });
  });
  client = createCodexAppServerClient({
    commandPath: "/bin/sh",
    env: fixture.env,
    shutdownKillTimeoutMs: 1_000,
    shutdownTermTimeoutMs: 50,
    workspaceRoot: fixture.workspaceRoot,
  });
  const controller = new AbortController();
  const execution = client.runTurn({
    prompt: "never reaches turn/start",
    signal: controller.signal,
  });

  await waitForRequest(fixture.requestLog, "thread/start");
  const pids = readFixturePids(fixture);
  controller.abort();

  await assert.rejects(execution, (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "ABORT_ERR");
    assert.match(error.message, /thread\/start aborted/);
    return true;
  });
  await client.dispose();
  await assertFixtureTreeGone(pids);
});

test("runTurn pins a network-disabled workspace sandbox to the attempt worktree", async (t) => {
  const fixture = makeFixtureWorkspace({ mode: "complete" });
  let client = null;
  t.after(async () => {
    await client?.dispose().catch(() => {});
    forceFixtureTreeExit(fixture);
    fs.rmSync(fixture.workspaceRoot, { force: true, recursive: true });
  });
  client = createCodexAppServerClient({
    commandPath: "/bin/sh",
    env: fixture.env,
    workspaceRoot: fixture.workspaceRoot,
  });

  const result = await client.runTurn({
    prompt: "apply the requested change",
    sandbox: "workspace-write",
  });

  const turnStart = readFixtureRequests(fixture)
    .find((request) => request.method === "turn/start");
  assert.ok(turnStart);
  assert.deepEqual(turnStart.params.sandboxPolicy, {
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
    networkAccess: false,
    type: "workspaceWrite",
    writableRoots: [fs.realpathSync(fixture.workspaceRoot)],
  });
  assert.deepEqual(result.sandboxPolicy, turnStart.params.sandboxPolicy);
});

test("dispose is bounded, escalates to SIGKILL, and reaps the detached process group", {
  skip: !supportsProcessGroups,
}, async (t) => {
  const fixture = makeFixtureWorkspace({
    grandchild: true,
    ignoreTerm: true,
    mode: "hang-initialize",
  });
  let client = null;
  t.after(async () => {
    await client?.dispose().catch(() => {});
    forceFixtureTreeExit(fixture);
    fs.rmSync(fixture.workspaceRoot, { force: true, recursive: true });
  });
  client = createCodexAppServerClient({
    commandPath: "/bin/sh",
    env: fixture.env,
    shutdownKillTimeoutMs: 1_000,
    shutdownTermTimeoutMs: 75,
    workspaceRoot: fixture.workspaceRoot,
  });
  client.ready.catch(() => {});

  await waitForRequest(fixture.requestLog, "initialize");
  const pids = readFixturePids(fixture);
  assert.equal(isProcessAlive(pids.wrapperPid), true);
  assert.equal(isProcessAlive(pids.parentPid), true);
  assert.equal(isProcessAlive(pids.grandchildPid), true);
  assert.equal(isProcessGroupAlive(pids.wrapperPid), true);

  const startedAt = Date.now();
  const [firstResult, secondResult] = await Promise.all([
    client.dispose(),
    client.dispose(),
  ]);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(firstResult.escalated, true);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(firstResult.shutdownSignal, "SIGKILL");
  assert.ok(elapsedMs >= 60, `expected TERM grace period, got ${elapsedMs}ms`);
  assert.ok(elapsedMs < 1_500, `dispose exceeded its bound: ${elapsedMs}ms`);
  await assertFixtureTreeGone(pids);
});
