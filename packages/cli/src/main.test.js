import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync as spawnSyncWithoutTimeout } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createInitPlan } from "../../core/src/index.js";
import {
  createLifecycleSqliteStore,
  createSqliteStorage,
  performBackup,
  seedStorage,
} from "../../core/src/storage/index.js";
import { buildPlannerContextHints } from "./intake-runtime.js";

import {
  acquireProjectExecutionLease,
  attachBoundedRepairContext,
  attachQueuedAutoRepairContext,
  assertNoDirectUiReviewRerun,
  cancelAllSupervisedLifecycleTasks,
  cancelLifecycleTask,
  claimSpecificLifecycleTask,
  classifyAcceptanceGateReport,
  computePrimaryCheckoutDigest,
  createProcessSupervisor,
  enforceReliabilityRcMergePolicy,
  hasTrustedRuntimeEnforcementEvidence,
  isPidAlive,
  main,
  promoteParallelSubtaskBranchesAfterPass,
  readContainedSourceFile,
  reconcileLifecycleCompatibilityStatuses,
  recoverDurableLifecycleCancellations,
  requestLifecycleCancellation,
  runAgentTickTask,
  runLifecycleAcceptanceCommands,
  runLifecycleSchedulerOnce,
  scheduleBoundedAutoRepairForQueueEntry,
  resolveLifecycleBudgetReadinessEvidence,
  resolveExecutorDeniedReadRoots,
  resolveReliabilityRcMergePreset,
  spawnSupervisedStartTask,
  synchronizeTaskStatusFromLifecycleResult,
} from "./main.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntrypoint = path.resolve(__dirname, "..", "bin", "niis.js");
const cursorBridgeFixtureServerPath = path.resolve(
  __dirname,
  "..",
  "..",
  "adapters",
  "test-fixtures",
  "mcp-echo-server.js",
);
const localRuntimeFixturePath = path.resolve(
  __dirname,
  "..",
  "..",
  "adapters",
  "test-fixtures",
  "local-runtime-echo.js",
);

function spawnSync(command, args, options = {}) {
  return spawnSyncWithoutTimeout(command, args, { timeout: 30_000, ...options });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createWorkspaceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-cli-main-"));

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  return root;
}

function snapshotFilesystemTree(rootPath) {
  const normalizedRoot = path.resolve(rootPath);
  const entries = [];

  function visit(absolutePath, relativePath) {
    const stat = fs.lstatSync(absolutePath);
    const record = {
      mode: stat.mode & 0o777,
      mtime_ms: stat.mtimeMs,
      path: relativePath || ".",
      size: stat.size,
      type: stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : stat.isFile()
            ? "file"
            : "other",
    };
    if (stat.isSymbolicLink()) {
      record.target = fs.readlinkSync(absolutePath);
    } else if (stat.isFile()) {
      record.sha256 = createHash("sha256")
        .update(fs.readFileSync(absolutePath))
        .digest("hex");
    }
    entries.push(record);

    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolutePath).sort()) {
        visit(
          path.join(absolutePath, name),
          relativePath ? `${relativePath}/${name}` : name,
        );
      }
    }
  }

  visit(normalizedRoot, "");
  return entries;
}

test("private package commands use the ordinary unknown-command path", async () => {
  const command = "unregistered-package-command";
  await assert.rejects(() => main([command]), (error) => error.message === `unknown command: ${command}`);
});

test("Reliability RC disables auto_merge and refuses parallel promotion before canonical PASS", () => {
  const policy = enforceReliabilityRcMergePolicy({
    branch_per_task: true,
    isolate_single_shot: true,
    mode: "auto_merge",
  });
  assert.equal(policy.mode, "review");
  assert.equal(policy.requested_mode, "auto_merge");

  const promotion = promoteParallelSubtaskBranchesAfterPass({
    canonicalVerdict: "EVIDENCE_GAP",
    mergePolicyMode: "create_pr",
    parallelDispatch: {
      subtaskBranches: [{
        branch_name: "niis/task/subtask",
        had_changes: true,
        subtask_id: "subtask",
        worktree_path: "/does/not/exist",
      }],
    },
    stateRoot: null,
    taskId: "task",
    workspaceRoot: "/does/not/exist",
  });

  assert.equal(promotion.attempted, false);
  assert.equal(promotion.reason, "canonical_verdict_not_pass");
  assert.deepEqual(promotion.results, []);
});

test("Reliability RC settings accept only the supervised review preset", () => {
  assert.deepEqual(resolveReliabilityRcMergePreset("review"), {
    branch_per_task: true,
    isolate_single_shot: false,
    mode: "none",
  });
  assert.equal(resolveReliabilityRcMergePreset("auto_merge"), null);
  assert.equal(resolveReliabilityRcMergePreset("create_pr"), null);
  assert.equal(resolveReliabilityRcMergePreset("custom"), null);
});

test("Reliability RC classifies deterministic acceptance command outcomes", () => {
  assert.deepEqual(
    classifyAcceptanceGateReport({ aborted: true, hard_failures: [], ok: false, results: [] }),
    {
      canonical_verdict: null,
      reason: "acceptance command execution was cancelled",
      terminal_stage: "CANCELLED",
    },
  );
  assert.equal(
    classifyAcceptanceGateReport({
      hard_failures: [{ status: "FAIL" }],
      ok: false,
      results: [],
    }).canonical_verdict,
    "DEFECT",
  );
  assert.equal(
    classifyAcceptanceGateReport({
      hard_failures: [{ status: "TIMEOUT", timed_out: true }],
      ok: false,
      results: [],
    }).canonical_verdict,
    "ENV_BLOCK",
  );
  assert.equal(
    classifyAcceptanceGateReport(null).canonical_verdict,
    "EVIDENCE_GAP",
  );
});

test("bounded repair context preserves the approved artifact and cites the prior verdict", () => {
  const artifact = {
    reference_bundle: {
      guides: ["Keep the change scoped."],
    },
    task_id: "task-repair",
  };
  const enriched = attachBoundedRepairContext(artifact, {
    canonical_verdict: "DEFECT",
    id: "attempt-prior",
    state: {
      review: {
        reason: "The focused regression still fails.",
      },
    },
  });

  assert.notStrictEqual(enriched, artifact);
  assert.deepEqual(artifact.reference_bundle.guides, ["Keep the change scoped."]);
  assert.match(enriched.reference_bundle.guides.at(-2).content, /attempt-prior.*DEFECT/u);
  assert.match(enriched.reference_bundle.guides.at(-2).content, /focused regression still fails/u);
  assert.match(enriched.reference_bundle.guides.at(-1).content, /without expanding/u);
  assert.equal(enriched.reference_bundle.guides.at(-1).provenance.source_type, "prior_attempt");
  assert.equal(enriched.reference_bundle.guides.at(-1).provenance.source_ref, "attempt-prior");
});

test("bounded auto-repair atomically requeues a distinct attempt and preserves the prior verdict", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initResult.status, 0, initResult.stderr);
  const plan = createInitPlan(workspaceRoot);
  writeJson(path.join(plan.stateRoot, "project-config.json"), {
    auto_repair: {
      enabled: true,
      max_attempts: 1,
    },
  });

  const sqliteStorage = createSqliteStorage({
    databasePath: plan.databasePath,
  });
  await seedStorage(sqliteStorage, {
    tasks: [{
      assigned_to: null,
      created_at: "2026-07-23T10:00:00.000Z",
      depends_on: [],
      goal_id: null,
      id: "task-auto-repair",
      max_rejections: 5,
      out_of_scope: ["No unrelated changes."],
      phase: 1,
      priority: "medium",
      rejection_count: 1,
      status: "BLOCKED",
      title: "Repair a focused regression",
      transition_log: [],
      updated_at: "2026-07-23T10:00:00.000Z",
    }],
  });
  sqliteStorage.close();

  const lifecycleStore = createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  let priorAttempt = await lifecycleStore.attempts.createOrResume({
    attemptId: "attempt:auto-repair-prior",
    engineVersion: "test-v1",
    taskId: "task-auto-repair",
    trigger: "serve",
  });
  priorAttempt = await lifecycleStore.attempts.transition({
    attemptId: priorAttempt.id,
    canonicalVerdict: "DEFECT",
    expectedStage: priorAttempt.stage,
    expectedVersion: priorAttempt.version,
    nextStage: "BLOCKED",
    statePatch: {
      review: {
        reason: "The focused regression still fails.",
      },
      workspace: {
        plan_approval_digest: "plan-digest-auto-repair",
      },
    },
  });
  await lifecycleStore.queue.enqueue({
    taskId: "task-auto-repair",
  });
  await lifecycleStore.queue.claimNext({
    holder: "test:prior",
  });
  const terminalQueue = await lifecycleStore.queue.transition({
    expectedState: "CLAIMED",
    holder: "test:prior",
    nextState: "BLOCKED",
    payloadPatch: {
      attempt_id: priorAttempt.id,
      canonical_verdict: priorAttempt.canonical_verdict,
    },
    taskId: "task-auto-repair",
  });
  const priorSnapshot = structuredClone(priorAttempt);

  const scheduled = await scheduleBoundedAutoRepairForQueueEntry({
    approvedPlan: {
      plan_digest: "plan-digest-auto-repair",
    },
    databasePath: plan.databasePath,
    queueEntry: terminalQueue,
    stateRoot: plan.stateRoot,
    store: lifecycleStore,
    workspaceRoot,
  });
  assert.equal(scheduled.scheduled, true);
  assert.equal(scheduled.entry.state, "PENDING");
  assert.equal(scheduled.entry.payload.attempt_id, null);
  assert.equal(
    scheduled.entry.payload.auto_repair.prior_attempt_id,
    priorAttempt.id,
  );
  assert.deepEqual(
    await lifecycleStore.attempts.byId(priorAttempt.id),
    priorSnapshot,
  );

  const claimedRepair = await lifecycleStore.queue.claimNext({
    holder: "test:repair",
  });
  const binding = await lifecycleStore.queue.bindAttempt({
    engineVersion: "test-v1",
    holder: "test:repair",
    taskId: "task-auto-repair",
    trigger: "auto-repair",
  });
  assert.notEqual(binding.attempt.id, priorAttempt.id);
  assert.equal(binding.attempt.trigger, "auto-repair");
  assert.equal(claimedRepair.task_id, "task-auto-repair");
  const repairContext = attachQueuedAutoRepairContext({
    approvedPlanDigest: "plan-digest-auto-repair",
    artifact: {
      reference_bundle: {
        guides: ["Keep the approved scope."],
      },
    },
    attempts: await lifecycleStore.attempts.listByTask("task-auto-repair"),
    boundAttempt: binding.attempt,
    queueEntry: await lifecycleStore.queue.byTask("task-auto-repair"),
  });
  assert.equal(repairContext.priorAttempt.id, priorAttempt.id);
  assert.match(
    repairContext.artifact.reference_bundle.guides.at(-2).content,
    /attempt:auto-repair-prior.*DEFECT/u,
  );
  assert.deepEqual(
    await lifecycleStore.attempts.byId(priorAttempt.id),
    priorSnapshot,
  );

  const secondAttempt = await lifecycleStore.attempts.transition({
    attemptId: binding.attempt.id,
    canonicalVerdict: "DEFECT",
    expectedStage: binding.attempt.stage,
    expectedVersion: binding.attempt.version,
    nextStage: "BLOCKED",
    statePatch: {
      review: {
        reason: "The bounded repair still did not satisfy the gate.",
      },
      workspace: {
        plan_approval_digest: "plan-digest-auto-repair",
      },
    },
  });
  const secondTerminalQueue = await lifecycleStore.queue.transition({
    expectedState: "CLAIMED",
    holder: "test:repair",
    nextState: "BLOCKED",
    payloadPatch: {
      attempt_id: secondAttempt.id,
      canonical_verdict: secondAttempt.canonical_verdict,
    },
    taskId: "task-auto-repair",
  });
  await synchronizeTaskStatusFromLifecycleResult({
    databasePath: plan.databasePath,
    lifecycleResult: {
      attempt_id: secondAttempt.id,
      canonical_verdict: secondAttempt.canonical_verdict,
      stage: secondAttempt.stage,
    },
    taskId: "task-auto-repair",
  });
  const capped = await scheduleBoundedAutoRepairForQueueEntry({
    approvedPlan: {
      plan_digest: "plan-digest-auto-repair",
    },
    databasePath: plan.databasePath,
    queueEntry: secondTerminalQueue,
    stateRoot: plan.stateRoot,
    store: lifecycleStore,
    workspaceRoot,
  });
  assert.equal(capped.scheduled, false);
  assert.equal(capped.decision.reason, "retry_attempt_limit_reached");
  assert.equal(
    (await lifecycleStore.queue.byTask("task-auto-repair")).state,
    "BLOCKED",
  );
  assert.equal(
    (await lifecycleStore.attempts.listByTask("task-auto-repair")).length,
    2,
  );
  assert.deepEqual(
    await lifecycleStore.attempts.byId(priorAttempt.id),
    priorSnapshot,
  );

  const projectedStorage = createSqliteStorage({
    databasePath: plan.databasePath,
    readonly: true,
  });
  try {
    const task = (await projectedStorage.tasks.list())
      .find((entry) => entry.id === "task-auto-repair");
    assert.equal(task.status, "BLOCKED");
  } finally {
    projectedStorage.close();
    lifecycleStore.close();
  }
});

test("invalid acceptance command plans block durably without executing input", async (t) => {
  const workspacePath = createWorkspaceFixture(t);
  const markerPath = path.join(workspacePath, "must-not-exist.txt");
  const result = await runLifecycleAcceptanceCommands({
    acceptanceCommands: [{
      argv: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "unsafe");`,
      ],
      id: "invalid-shell-input",
      required: true,
    }],
    context: {
      abortSignal: null,
      timeoutMs: null,
      workspacePath,
    },
  });

  assert.equal(result.terminal_stage, "BLOCKED");
  assert.equal(result.canonical_verdict, "EVIDENCE_GAP");
  assert.match(result.reason, /non-runnable/);
  assert.equal(fs.existsSync(markerPath), false);
});

test("source-file reads only indexed non-hidden files inside the attached project", (t) => {
  const workspacePath = createWorkspaceFixture(t);
  const sourceRoot = path.join(workspacePath, "source");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "safe.txt"), "safe\n");
  fs.writeFileSync(path.join(sourceRoot, "unindexed.txt"), "not indexed\n");
  fs.writeFileSync(path.join(sourceRoot, ".env"), "TOKEN=must-not-read\n");
  fs.mkdirSync(path.join(sourceRoot, ".niis", "secrets"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, ".niis", "secrets", "master.key"), "must-not-read\n");
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-source-outside-"));
  t.after(() => fs.rmSync(outsideRoot, { force: true, recursive: true }));
  fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "must-not-read\n");
  fs.symlinkSync(
    path.join(outsideRoot, "secret.txt"),
    path.join(sourceRoot, "escape.txt"),
  );

  assert.equal(
    readContainedSourceFile({
      allowedRoot: workspacePath,
      allowedRelativePaths: new Set(["safe.txt"]),
      baseRoot: sourceRoot,
      relativePath: "safe.txt",
    }).content,
    "safe\n",
  );
  assert.throws(
    () => readContainedSourceFile({
      allowedRoot: workspacePath,
      allowedRelativePaths: new Set(["escape.txt"]),
      baseRoot: sourceRoot,
      relativePath: "escape.txt",
    }),
    (error) => error?.code === "source_file_symlink",
  );
  assert.throws(
    () => readContainedSourceFile({
      allowedRoot: workspacePath,
      allowedRelativePaths: new Set(["secret.txt"]),
      baseRoot: outsideRoot,
      relativePath: "secret.txt",
    }),
    (error) => error?.code === "source_file_root_escape",
  );
  assert.throws(
    () => readContainedSourceFile({
      allowedRoot: workspacePath,
      allowedRelativePaths: new Set(["../outside.txt"]),
      baseRoot: sourceRoot,
      relativePath: "../outside.txt",
    }),
    (error) => error?.code === "source_file_path_escape",
  );
  assert.throws(
    () => readContainedSourceFile({
      allowedRoot: workspacePath,
      allowedRelativePaths: new Set([".env"]),
      baseRoot: sourceRoot,
      relativePath: ".env",
    }),
    (error) => error?.code === "source_file_sensitive",
  );
  assert.throws(
    () => readContainedSourceFile({
      allowedRoot: workspacePath,
      allowedRelativePaths: new Set([".niis/secrets/master.key"]),
      baseRoot: sourceRoot,
      relativePath: ".niis/secrets/master.key",
    }),
    (error) => error?.code === "source_file_sensitive",
  );
  assert.throws(
    () => readContainedSourceFile({
      allowedRoot: workspacePath,
      allowedRelativePaths: new Set(["safe.txt"]),
      baseRoot: sourceRoot,
      relativePath: "unindexed.txt",
    }),
    (error) => error?.code === "source_file_not_indexed",
  );
});

test("manual execution claims its requested SQLite queue entry and refuses a foreign active claim", async (t) => {
  const workspacePath = createWorkspaceFixture(t);
  const databasePath = path.join(workspacePath, "state.sqlite");
  const store = createLifecycleSqliteStore({ databasePath });
  t.after(() => store.close());

  await store.queue.enqueue({
    priority: 0,
    taskId: "task-before",
  });
  await store.queue.enqueue({
    priority: 1,
    taskId: "task-requested",
  });

  const claim = await claimSpecificLifecycleTask({
    holder: "manual-holder",
    store,
    taskId: "task-requested",
  });
  assert.equal(claim.entry.task_id, "task-requested");
  assert.deepEqual(claim.displaced, ["task-before"]);
  assert.equal((await store.queue.byTask("task-before")).state, "PENDING");
  assert.equal((await store.queue.byTask("task-requested")).state, "CLAIMED");

  await assert.rejects(
    claimSpecificLifecycleTask({
      holder: "second-holder",
      store,
      taskId: "task-before",
    }),
    (error) => error?.code === "project_execution_busy",
  );
});

test("manual execution reclaims an expired requested queue claim", async (t) => {
  const workspacePath = createWorkspaceFixture(t);
  const databasePath = path.join(workspacePath, "state.sqlite");
  const store = createLifecycleSqliteStore({ databasePath });
  t.after(() => store.close());

  await store.queue.enqueue({
    taskId: "task-expired",
  });
  await store.queue.claimNext({
    holder: "dead-holder",
    now: new Date(Date.now() - 10_000),
    ttlMs: 1,
  });

  const claim = await claimSpecificLifecycleTask({
    holder: "recovery-holder",
    store,
    taskId: "task-expired",
  });

  assert.equal(claim.entry.task_id, "task-expired");
  assert.equal(claim.entry.claimed_by, "recovery-holder");
  assert.equal(claim.resumed, false);
});

test("project execution lease enforces one SQLite-authoritative holder for the workspace", async (t) => {
  const workspacePath = createWorkspaceFixture(t);
  const stateRoot = path.join(workspacePath, ".niis");
  const first = await acquireProjectExecutionLease({
    allowInherited: false,
    holder: "first-holder",
    stateRoot,
    ttlMs: 1,
  });
  t.after(() => first.release());

  await assert.rejects(
    acquireProjectExecutionLease({
      allowInherited: false,
      holder: "second-holder",
      stateRoot,
    }),
    (error) => error?.code === "project_execution_busy",
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    acquireProjectExecutionLease({
      allowInherited: false,
      holder: "second-holder",
      stateRoot,
    }),
    (error) => error?.code === "project_execution_busy",
    "an event-loop stall must not make a live project holder reclaimable",
  );
  const leaseStore = createLifecycleSqliteStore({
    databasePath: path.join(stateRoot, "db", "niis-v1.sqlite"),
    readonly: true,
  });
  assert.equal(
    (await leaseStore.executionLeases.byScope("__project_execution__")).holder,
    "first-holder",
  );
  leaseStore.close();
  assert.equal(
    fs.existsSync(path.join(stateRoot, "leases", "__project_execution__.json")),
    false,
  );
  await first.release();

  const second = await acquireProjectExecutionLease({
    allowInherited: false,
    holder: "second-holder",
    stateRoot,
  });
  await second.release();
});

test("supervised child validates and inherits the parent's durable project lease", async (t) => {
  const workspacePath = createWorkspaceFixture(t);
  const stateRoot = path.join(workspacePath, ".niis");
  const parentLease = await acquireProjectExecutionLease({
    allowInherited: false,
    holder: "ui-parent",
    stateRoot,
  });
  const envName = "NIIS_PROJECT_EXECUTION_LEASE_HOLDER";
  const priorEnv = process.env[envName];

  try {
    process.env[envName] = parentLease.holder;
    const inherited = await acquireProjectExecutionLease({
      holder: "child-must-not-replace-parent",
      stateRoot,
    });
    assert.equal(inherited.inherited, true);
    assert.equal(inherited.holder, parentLease.holder);
    assert.equal(inherited.record.pid, process.pid);
    await inherited.release();

    const readonly = createLifecycleSqliteStore({
      databasePath: path.join(stateRoot, "db", "niis-v1.sqlite"),
      readonly: true,
    });
    assert.equal(
      (await readonly.executionLeases.byScope("__project_execution__")).holder,
      parentLease.holder,
    );
    readonly.close();
  } finally {
    if (priorEnv === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = priorEnv;
    }
    await parentLease.release();
  }
});

test("an inherited child adopts the durable lease before starting execution", async (t) => {
  const workspacePath = createWorkspaceFixture(t);
  const stateRoot = path.join(workspacePath, ".niis");
  const parentLease = await acquireProjectExecutionLease({
    allowInherited: false,
    holder: "ui-parent-adoption",
    stateRoot,
  });
  const mainModuleUrl = new URL("./main.js", import.meta.url).href;
  const childSource = `
    const { acquireProjectExecutionLease } = await import(${JSON.stringify(mainModuleUrl)});
    const inherited = await acquireProjectExecutionLease({
      holder: "child-cannot-replace-token",
      stateRoot: process.argv[1],
    });
    process.stdout.write(JSON.stringify({
      inherited: inherited.inherited,
      owner_pid: inherited.record.pid,
      pid: process.pid,
    }) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    childSource,
    stateRoot,
  ], {
    env: {
      ...process.env,
      NIIS_PROJECT_EXECUTION_LEASE_HOLDER: parentLease.holder,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closePromise = new Promise((resolve) => child.once("close", resolve));

  try {
    const readyLine = await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        reject(new Error(`child lease adoption timed out: ${stderr}`));
      }, 5_000);
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const newline = stdout.indexOf("\n");
        if (newline === -1) return;
        clearTimeout(timeout);
        resolve(stdout.slice(0, newline));
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        if (!stdout.includes("\n")) {
          clearTimeout(timeout);
          reject(new Error(`child exited ${code} before lease adoption: ${stderr}`));
        }
      });
    });
    const adoption = JSON.parse(readyLine);
    assert.equal(adoption.inherited, true);
    assert.equal(adoption.owner_pid, child.pid);
    assert.equal(adoption.pid, child.pid);

    const readonly = createLifecycleSqliteStore({
      databasePath: path.join(stateRoot, "db", "niis-v1.sqlite"),
      readonly: true,
    });
    assert.equal(
      (await readonly.executionLeases.byScope("__project_execution__")).pid,
      child.pid,
    );
    readonly.close();

    const parentView = await parentLease.handoff(child.pid);
    assert.equal(parentView.pid, child.pid);
  } finally {
    child.kill("SIGTERM");
    await closePromise;
    await parentLease.release();
  }
});

test("project lease handoff keeps an orphaned supervised child exclusive after TTL", async (t) => {
  const workspacePath = createWorkspaceFixture(t);
  const stateRoot = path.join(workspacePath, ".niis");
  const parentLease = await acquireProjectExecutionLease({
    allowInherited: false,
    holder: "ui-parent-handoff",
    stateRoot,
    ttlMs: 1,
  });
  const child = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000);",
  ], {
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  try {
    const handedOff = await parentLease.handoff(child.pid);
    assert.equal(handedOff.pid, child.pid);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(
      acquireProjectExecutionLease({
        allowInherited: false,
        holder: "contender-after-parent-crash",
        stateRoot,
      }),
      (error) =>
        error?.code === "project_execution_busy"
        && error?.lease_reason === "owner_alive",
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    await parentLease.release();
  }
});

test("forced supervisor cancellation reaps the exact owner before durable takeover", async (t) => {
  if (process.platform === "win32") {
    t.skip("the forced process-reaping contract uses POSIX SIGTERM/SIGKILL");
    return;
  }

  const workspaceRoot = createWorkspaceFixture(t);
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const child = spawn(process.execPath, [
    "-e",
    [
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('ready\\n');",
      "setInterval(() => {}, 1000);",
    ].join(""),
  ], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const childClosed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let releaseCleanup = null;
  t.after(async () => {
    releaseCleanup?.();
    if (isPidAlive(child.pid)) {
      try { process.kill(child.pid, "SIGKILL"); } catch {  }
    }
    await Promise.race([
      childClosed,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  });
  await new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("ready\n")) resolve();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!stdout.includes("ready\n")) {
        reject(new Error(`TERM-resistant child exited before readiness (${code}/${signal})`));
      }
    });
  });

  const plan = createInitPlan(workspaceRoot);
  const taskId = "task-forced-cancel";
  const attemptId = "attempt:forced-cancel";
  const supervisor = createProcessSupervisor();
  assert.equal(
    await spawnSupervisedStartTask({
      spawnChild: () => child,
      supervisor,
      taskId,
      workspaceRoot,
    }),
    child,
  );
  const lifecycleStore = createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  try {
    const executionLease = await lifecycleStore.executionLeases.byScope(
      "__project_execution__",
    );
    assert.equal(executionLease.pid, child.pid);
    await claimSpecificLifecycleTask({
      holder: executionLease.holder,
      store: lifecycleStore,
      taskId,
    });
    await lifecycleStore.queue.bindAttempt({
      attemptId,
      engineVersion: "niis-cli/test",
      holder: executionLease.holder,
      taskId,
      trigger: "ui",
    });
    await lifecycleStore.attempts.acquireLease({
      attemptId,
      holder: `cli-lifecycle:${child.pid}`,
      ttlMs: 60_000,
    });
  } finally {
    lifecycleStore.close();
  }

  const cancelRequest = await requestLifecycleCancellation({
    databasePath: plan.databasePath,
    requestedBy: "test:operator",
    stateRoot: plan.stateRoot,
    supervisedPid: child.pid,
    taskId,
  });
  assert.equal(cancelRequest.attempt_id, attemptId);
  assert.equal(cancelRequest.project_pid, child.pid);
  assert.equal(cancelRequest.status, "REQUESTED");

  await assert.rejects(
    cancelLifecycleTask({
      databasePath: plan.databasePath,
      reason: "mismatched cancellation must not mutate state",
      stateRoot: plan.stateRoot,
      taskId,
      terminatedPid: 999_999_999,
    }),
    (error) => error?.code === "cancellation_request_owner_mismatch",
  );
  const unchanged = createLifecycleSqliteStore({
    databasePath: plan.databasePath,
    readonly: true,
  });
  try {
    assert.equal((await unchanged.attempts.byId(attemptId)).stage, "CLAIMED");
    assert.equal((await unchanged.queue.byTask(taskId)).state, "CLAIMED");
    assert.equal(
      (await unchanged.executionLeases.byScope("__project_execution__")).pid,
      child.pid,
    );
  } finally {
    unchanged.close();
  }

  const cancellation = await supervisor.cancel({
    cleanupHoldMs: 2_000,
    graceMs: 50,
    reapMs: 2_000,
    taskId,
  });
  releaseCleanup = cancellation.releaseCleanup ?? null;
  assert.deepEqual(
    {
      forced: cancellation.forced,
      ok: cancellation.ok,
      pid: cancellation.pid,
      reaped: cancellation.reaped,
    },
    {
      forced: true,
      ok: true,
      pid: child.pid,
      reaped: true,
    },
  );
  assert.equal(isPidAlive(child.pid), false);
  const retainedForTakeover = createLifecycleSqliteStore({
    databasePath: plan.databasePath,
    readonly: true,
  });
  try {
    assert.equal(
      (await retainedForTakeover.executionLeases.byScope(
        "__project_execution__",
      )).pid,
      child.pid,
      "supervised close cleanup must retain the exact lease until durable takeover",
    );
  } finally {
    retainedForTakeover.close();
  }

  try {
    await cancelLifecycleTask({
      databasePath: plan.databasePath,
      reason: "forced child was reaped by its UI supervisor",
      stateRoot: plan.stateRoot,
      taskId,
      terminatedPid: cancellation.pid,
    });
  } finally {
    releaseCleanup?.();
    releaseCleanup = null;
  }

  const durable = createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  try {
    const attempt = await durable.attempts.byId(attemptId);
    const queueEntry = await durable.queue.byTask(taskId);
    assert.equal(attempt.stage, "CANCELLED");
    assert.equal(attempt.canonical_verdict, null);
    assert.equal(queueEntry.state, "CANCELLED");
    assert.equal(queueEntry.payload.attempt_id, attemptId);
    assert.equal(queueEntry.payload.cancel_request.status, "FINALIZED");
    assert.equal(
      queueEntry.payload.cancel_request.request_id,
      cancelRequest.request_id,
    );
    assert.equal(
      await durable.executionLeases.byScope("__project_execution__"),
      null,
    );
    await assert.rejects(
      claimSpecificLifecycleTask({
        holder: "scheduler-must-not-resume",
        store: durable,
        taskId,
      }),
      (error) =>
        error?.code === "lifecycle_queue_task_not_pending"
        && error?.queue_state === "CANCELLED",
    );
    assert.equal(
      (await durable.attempts.createOrResume({
        attemptId,
        engineVersion: "niis-cli/test",
        taskId,
        trigger: "ui",
      })).stage,
      "CANCELLED",
      "the cancelled attempt identity must remain terminal",
    );
  } finally {
    durable.close();
  }
});

test("shutdown cancelAll persists each tombstone before forced reap and finalizes takeover", async (t) => {
  if (process.platform === "win32") {
    t.skip("the shutdown process-reaping contract uses POSIX SIGTERM/SIGKILL");
    return;
  }

  const workspaceRoot = createWorkspaceFixture(t);
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const child = spawn(process.execPath, [
    "-e",
    [
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('ready\\n');",
      "setInterval(() => {}, 1000);",
    ].join(""),
  ], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const childClosed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (isPidAlive(child.pid)) {
      try { process.kill(child.pid, "SIGKILL"); } catch {  }
    }
    await Promise.race([
      childClosed,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  });
  await new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("ready\n")) resolve();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!stdout.includes("ready\n")) {
        reject(new Error(`shutdown child exited before readiness (${code}/${signal})`));
      }
    });
  });

  const plan = createInitPlan(workspaceRoot);
  const taskId = "task-shutdown-cancel-all";
  const attemptId = "attempt:shutdown-cancel-all";
  const supervisor = createProcessSupervisor();
  await spawnSupervisedStartTask({
    spawnChild: () => child,
    supervisor,
    taskId,
    workspaceRoot,
  });
  const setup = createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  try {
    const executionLease = await setup.executionLeases.byScope(
      "__project_execution__",
    );
    assert.equal(executionLease.pid, child.pid);
    await claimSpecificLifecycleTask({
      holder: executionLease.holder,
      store: setup,
      taskId,
    });
    await setup.queue.bindAttempt({
      attemptId,
      engineVersion: "niis-cli/test",
      holder: executionLease.holder,
      taskId,
      trigger: "ui",
    });
    await setup.attempts.acquireLease({
      attemptId,
      holder: `cli-lifecycle:${child.pid}`,
      ttlMs: 60_000,
    });
  } finally {
    setup.close();
  }

  const cancellations = await cancelAllSupervisedLifecycleTasks({
    graceMs: 50,
    reapMs: 2_000,
    requestedBy: "test:shutdown",
    supervisor,
    workspaceRoot,
  });
  assert.equal(cancellations.length, 1);
  assert.deepEqual(
    {
      finalized: cancellations[0].finalized,
      forced: cancellations[0].forced,
      ok: cancellations[0].ok,
      pid: cancellations[0].pid,
      preSignalPersisted: cancellations[0].pre_signal_persisted,
      reaped: cancellations[0].reaped,
      signalSent: cancellations[0].signal_sent,
      taskId: cancellations[0].task_id,
    },
    {
      finalized: true,
      forced: true,
      ok: true,
      pid: child.pid,
      preSignalPersisted: true,
      reaped: true,
      signalSent: true,
      taskId,
    },
  );
  assert.equal(
    cancellations[0].preparation.request_id,
    cancellations[0].takeover.queue.payload.cancel_request.request_id,
  );
  assert.equal(isPidAlive(child.pid), false);

  const durable = createLifecycleSqliteStore({
    databasePath: plan.databasePath,
    readonly: true,
  });
  try {
    assert.equal((await durable.attempts.byId(attemptId)).stage, "CANCELLED");
    assert.equal(await durable.promotions.byAttempt(attemptId), null);
    const queueEntry = await durable.queue.byTask(taskId);
    assert.equal(queueEntry.state, "CANCELLED");
    assert.equal(queueEntry.payload.cancel_request.status, "FINALIZED");
    assert.equal(
      await durable.executionLeases.byScope("__project_execution__"),
      null,
    );
  } finally {
    durable.close();
  }
});

test("crash after reap before takeover recovers the durable cancellation without resume or promotion", async (t) => {
  if (process.platform === "win32") {
    t.skip("the crash-window process fixture uses POSIX SIGTERM/SIGKILL");
    return;
  }

  const workspaceRoot = createWorkspaceFixture(t);
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const child = spawn(process.execPath, [
    "-e",
    [
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('ready\\n');",
      "setInterval(() => {}, 1000);",
    ].join(""),
  ], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const childClosed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (isPidAlive(child.pid)) {
      try { process.kill(child.pid, "SIGKILL"); } catch {  }
    }
    await Promise.race([
      childClosed,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  });
  await new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("ready\n")) resolve();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!stdout.includes("ready\n")) {
        reject(new Error(`crash-window child exited before readiness (${code}/${signal})`));
      }
    });
  });

  const plan = createInitPlan(workspaceRoot);
  const taskId = "task-cancel-crash-window";
  const attemptId = "attempt:cancel-crash-window";
  const queueHolder = "ui-supervisor:cancel-crash-window";
  const store = createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  try {
    await store.executionLeases.acquire({
      holder: queueHolder,
      pid: child.pid,
      scope: "__project_execution__",
      ttlMs: 60_000,
    });
    await store.queue.enqueue({ taskId });
    await store.queue.claimNext({
      holder: queueHolder,
      ttlMs: 60_000,
    });
    await store.queue.bindAttempt({
      attemptId,
      engineVersion: "niis-cli/test",
      holder: queueHolder,
      taskId,
      trigger: "ui",
    });
    await store.attempts.acquireLease({
      attemptId,
      holder: `cli-lifecycle:${child.pid}`,
      ttlMs: 60_000,
    });
  } finally {
    store.close();
  }

  const request = await requestLifecycleCancellation({
    databasePath: plan.databasePath,
    requestedBy: "test:crash-injector",
    stateRoot: plan.stateRoot,
    supervisedPid: child.pid,
    taskId,
  });
  const whileAlive = await recoverDurableLifecycleCancellations({
    databasePath: plan.databasePath,
    stateRoot: plan.stateRoot,
    taskId,
  });
  assert.equal(whileAlive.finalized.length, 0);
  assert.deepEqual(whileAlive.pending, [{
    cancel_request_id: request.request_id,
    pid: child.pid,
    task_id: taskId,
  }]);

  const supervisor = createProcessSupervisor();
  supervisor.register({ child, taskId });
  const reaped = await supervisor.cancel({
    cleanupHoldMs: 2_000,
    graceMs: 50,
    reapMs: 2_000,
    taskId,
  });
  reaped.releaseCleanup?.();
  assert.equal(reaped.forced, true);
  assert.equal(reaped.reaped, true);
  assert.equal(isPidAlive(child.pid), false);



  const restarted = await runLifecycleSchedulerOnce({ workspaceRoot });
  assert.equal(restarted.claimed, false);
  assert.equal(restarted.lifecycle.stage, "CANCELLED");
  assert.equal(restarted.lifecycle.attempt_id, attemptId);
  assert.equal(restarted.queue_state, "CANCELLED");

  const durable = createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  try {
    const attempts = await durable.attempts.listByTask(taskId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].id, attemptId);
    assert.equal(attempts[0].stage, "CANCELLED");
    assert.equal(await durable.promotions.byAttempt(attemptId), null);
    const queueEntry = await durable.queue.byTask(taskId);
    assert.equal(queueEntry.state, "CANCELLED");
    assert.equal(queueEntry.payload.cancel_request.status, "FINALIZED");
    assert.equal(queueEntry.payload.cancel_request.request_id, request.request_id);
    assert.equal(
      await durable.executionLeases.byScope("__project_execution__"),
      null,
    );
    await assert.rejects(
      claimSpecificLifecycleTask({
        holder: "scheduler-after-restart",
        store: durable,
        taskId,
      }),
      (error) =>
        error?.code === "lifecycle_queue_task_not_pending"
        && error?.queue_state === "CANCELLED",
    );
  } finally {
    durable.close();
  }

  const nextTick = await runLifecycleSchedulerOnce({ workspaceRoot });
  assert.equal(nextTick.claimed, false);
  assert.equal(nextTick.lifecycle, undefined);
});

test("delete-task rejects traversal before touching live state", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const plan = createInitPlan(workspaceRoot);
  const sentinelPath = path.join(plan.stateRoot, "delete-traversal-sentinel");
  fs.writeFileSync(sentinelPath, "must remain\n");
  const databaseHash = createHash("sha256")
    .update(fs.readFileSync(plan.databasePath))
    .digest("hex");

  const result = spawnSync(process.execPath, [
    cliEntrypoint,
    "delete-task",
    "--task-id",
    "..",
    "--force",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical lower-case ASCII task id/);
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), "must remain\n");
  assert.equal(
    createHash("sha256").update(fs.readFileSync(plan.databasePath)).digest("hex"),
    databaseHash,
  );
});

test("delete-task refuses an unknown canonical ID before removing intake data", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const plan = createInitPlan(workspaceRoot);
  const unknownRoot = path.join(plan.stateRoot, "intake", "unknown-task");
  const sentinelPath = path.join(unknownRoot, "operator-data.txt");
  fs.mkdirSync(unknownRoot, { recursive: true });
  fs.writeFileSync(sentinelPath, "must remain\n");

  const result = spawnSync(process.execPath, [
    cliEntrypoint,
    "delete-task",
    "--task-id",
    "unknown-task",
    "--force",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not exist; refusing deletion/);
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), "must remain\n");
});

test("delete-task refuses a symlinked state root before touching the target", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const binDir = path.join(workspaceRoot, "bin");
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  createFakeCodexBinary(binDir);
  const intake = spawnSync(process.execPath, [
    cliEntrypoint,
    "intake",
    "--text",
    "Create a task that must remain intact.",
    "--task-id",
    "delete-symlink-state",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    timeout: 10_000,
  });
  assert.equal(intake.status, 0, intake.stderr);

  const plan = createInitPlan(workspaceRoot);
  const movedStateRoot = path.join(workspaceRoot, "external-state");
  fs.renameSync(plan.stateRoot, movedStateRoot);
  fs.symlinkSync(movedStateRoot, plan.stateRoot, "dir");
  const taskRoot = path.join(
    movedStateRoot,
    "intake",
    "delete-symlink-state",
  );
  const movedDatabasePath = path.join(
    movedStateRoot,
    path.relative(plan.stateRoot, plan.databasePath),
  );
  const databaseHash = createHash("sha256")
    .update(fs.readFileSync(movedDatabasePath))
    .digest("hex");

  const result = spawnSync(process.execPath, [
    cliEntrypoint,
    "delete-task",
    "--task-id",
    "delete-symlink-state",
    "--force",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /state root must be the real \.niis directory/);
  assert.equal(fs.existsSync(taskRoot), true);
  assert.equal(
    createHash("sha256")
      .update(fs.readFileSync(movedDatabasePath))
      .digest("hex"),
    databaseHash,
  );
});

test("delete-task force refuses authoritative claims and active attempts", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const binDir = path.join(workspaceRoot, "bin");
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  createFakeCodexBinary(binDir);
  for (const taskId of ["delete-claimed-task", "delete-active-attempt"]) {
    const intake = spawnSync(process.execPath, [
      cliEntrypoint,
      "intake",
      "--text",
      `Create ${taskId}.`,
      "--task-id",
      taskId,
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NIIS_CLAUDE_CODE_LOCAL_BIN: "",
        NIIS_CODEX_LOCAL_BIN: undefined,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      timeout: 10_000,
    });
    assert.equal(intake.status, 0, intake.stderr);
  }

  const plan = createInitPlan(workspaceRoot);
  const lifecycle = createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  try {
    await lifecycle.queue.enqueue({
      taskId: "delete-claimed-task",
    });
    const claimed = await lifecycle.queue.claimNext({
      holder: "delete-guard-test",
      ttlMs: 60_000,
    });
    assert.equal(claimed.task_id, "delete-claimed-task");
    await lifecycle.attempts.createOrResume({
      attemptId: "attempt-delete-active",
      engineVersion: "test",
      taskId: "delete-active-attempt",
      trigger: "test",
    });
  } finally {
    lifecycle.close();
  }

  const claimedDelete = spawnSync(process.execPath, [
    cliEntrypoint,
    "delete-task",
    "--task-id",
    "delete-claimed-task",
    "--force",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.notEqual(claimedDelete.status, 0);
  assert.match(claimedDelete.stderr, /authoritative queue claim/);

  const activeDelete = spawnSync(process.execPath, [
    cliEntrypoint,
    "delete-task",
    "--task-id",
    "delete-active-attempt",
    "--force",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.notEqual(activeDelete.status, 0);
  assert.match(activeDelete.stderr, /active attempt attempt-delete-active/);

  const verificationLifecycle = createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  try {
    assert.equal(
      (await verificationLifecycle.queue.byTask("delete-claimed-task")).state,
      "CLAIMED",
    );
    assert.equal(
      (await verificationLifecycle.attempts.activeByTask("delete-active-attempt")).id,
      "attempt-delete-active",
    );
  } finally {
    verificationLifecycle.close();
  }
  const sqlite = createSqliteStorage({
    databasePath: plan.databasePath,
    readonly: true,
  });
  try {
    const taskIds = new Set((await sqlite.tasks.list()).map((task) => task.id));
    assert.equal(taskIds.has("delete-claimed-task"), true);
    assert.equal(taskIds.has("delete-active-attempt"), true);
  } finally {
    sqlite.close();
  }
  assert.equal(
    fs.existsSync(path.join(plan.stateRoot, "intake", "delete-claimed-task")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(plan.stateRoot, "intake", "delete-active-attempt")),
    true,
  );
});

test("delete-task removes only the exact canonical task", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const binDir = path.join(workspaceRoot, "bin");
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  createFakeCodexBinary(binDir);
  const intake = spawnSync(process.execPath, [
    cliEntrypoint,
    "intake",
    "--text",
    "Create a disposable task.",
    "--task-id",
    "delete-exact-task",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    timeout: 10_000,
  });
  assert.equal(intake.status, 0, intake.stderr);

  const plan = createInitPlan(workspaceRoot);
  const taskRoot = path.join(plan.stateRoot, "intake", "delete-exact-task");
  assert.equal(fs.existsSync(taskRoot), true);
  const deleted = spawnSync(process.execPath, [
    cliEntrypoint,
    "delete-task",
    "--task-id",
    "delete-exact-task",
    "--force",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(fs.existsSync(taskRoot), false);

  const sqlite = createSqliteStorage({
    databasePath: plan.databasePath,
    readonly: true,
  });
  try {
    assert.equal(
      (await sqlite.tasks.list()).some((task) => task.id === "delete-exact-task"),
      false,
    );
  } finally {
    sqlite.close();
  }
});

test("supervisor observes child close before awaiting PID handoff", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const pidHolder = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000);",
  ], {
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    pidHolder.once("spawn", resolve);
    pidHolder.once("error", reject);
  });
  const pidHolderClosed = new Promise((resolve) => pidHolder.once("close", resolve));
  let registered = false;
  let syntheticChild = null;
  let syntheticChildArgs = null;

  try {
    await assert.rejects(
      spawnSupervisedStartTask({
        attemptId: "attempt:retry-focused",
        spawnChild(_command, childArgs) {
          syntheticChildArgs = childArgs;
          syntheticChild = new EventEmitter();
          syntheticChild.pid = pidHolder.pid;
          syntheticChild.exitCode = null;
          syntheticChild.signalCode = null;
          syntheticChild.stdout = null;
          syntheticChild.stderr = null;
          syntheticChild.kill = () => true;
          queueMicrotask(() => {
            syntheticChild.exitCode = 0;
            syntheticChild.emit("close", 0, null);
          });
          return syntheticChild;
        },
        supervisor: {
          register({ child, taskId }) {
            registered = child === syntheticChild && taskId === "instant-exit";
          },
        },
        taskId: "instant-exit",
        trigger: "ui-retry",
        workspaceRoot,
      }),
      /child exited before setup completed/,
    );
    assert.equal(registered, true);
    assert.deepEqual(
      syntheticChildArgs.slice(syntheticChildArgs.indexOf("--trigger")),
      [
        "--trigger",
        "ui-retry",
        "--attempt-id",
        "attempt:retry-focused",
      ],
      "the supervised retry child must receive a caller-minted durable attempt id",
    );

    const plan = createInitPlan(workspaceRoot);
    const readonly = createLifecycleSqliteStore({
      databasePath: plan.databasePath,
      readonly: true,
    });
    assert.equal(
      await readonly.executionLeases.byScope("__project_execution__"),
      null,
      "close cleanup must release the handed-off SQLite lease",
    );
    readonly.close();
    assert.equal(
      fs.existsSync(path.join(
        plan.stateRoot,
        "leases",
        "instant-exit.json",
      )),
      false,
      "close cleanup must release the per-task projection lease",
    );
  } finally {
    pidHolder.kill("SIGTERM");
    await pidHolderClosed;
  }
});

test("primary checkout digest covers tracked diffs and untracked metadata", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  fs.writeFileSync(path.join(workspaceRoot, "tracked.txt"), "baseline\n");
  assert.equal(
    spawnSync("git", ["init", "-b", "main"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    }).status,
    0,
  );
  assert.equal(
    spawnSync("git", ["add", "tracked.txt"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    }).status,
    0,
  );
  assert.equal(
    spawnSync("git", [
      "-c",
      "user.name=Niis Test",
      "-c",
      "user.email=niis-test@local",
      "commit",
      "-m",
      "baseline",
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
    }).status,
    0,
  );

  const baseline = computePrimaryCheckoutDigest(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, "tracked.txt"), "changed\n");
  const trackedChange = computePrimaryCheckoutDigest(workspaceRoot);
  assert.notEqual(trackedChange, baseline);

  fs.writeFileSync(path.join(workspaceRoot, "tracked.txt"), "baseline\n");
  assert.equal(computePrimaryCheckoutDigest(workspaceRoot), baseline);
  const untrackedPath = path.join(workspaceRoot, "untracked.txt");
  fs.writeFileSync(untrackedPath, "metadata proof\n");
  const untracked = computePrimaryCheckoutDigest(workspaceRoot);
  assert.notEqual(untracked, baseline);
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(untrackedPath, future, future);
  assert.notEqual(computePrimaryCheckoutDigest(workspaceRoot), untracked);
});

test("readiness budget evidence uses a configured finite cap and never invents one", async (t) => {
  const cappedWorkspace = createWorkspaceFixture(t);
  writeJson(path.join(cappedWorkspace, ".niis", "project-config.json"), {
    roles: {
      "generalist-worker": {
        budget: {
          per_run_usd: 5,
        },
      },
    },
  });
  const taskResult = {
    route_preview: {
      selected_lane: {
        manifest_id: "generalist-worker",
      },
    },
    run_record: {
      cost: {
        estimated_usd: 1.25,
      },
    },
  };
  assert.deepEqual(
    await resolveLifecycleBudgetReadinessEvidence({
      databasePath: path.join(cappedWorkspace, "unused.sqlite"),
      taskResult,
      workspacePath: cappedWorkspace,
    }),
    {
      limit: 5,
      used: 1.25,
    },
  );

  const uncappedWorkspace = createWorkspaceFixture(t);
  assert.equal(
    await resolveLifecycleBudgetReadinessEvidence({
      databasePath: path.join(uncappedWorkspace, "unused.sqlite"),
      taskResult,
      workspacePath: uncappedWorkspace,
    }),
    null,
  );
});

test("runtime enforcement evidence requires recognized backends", () => {
  assert.equal(hasTrustedRuntimeEnforcementEvidence({
    network_backend: "codex-app-server-turn-sandbox",
    network_enforced: true,
    read_backend: "darwin-seatbelt-read-contained",
    read_enforced: true,
    write_backend: "codex-app-server-turn-workspace-write",
    write_enforced: true,
  }), true);
  for (const evidence of [
    {
      network_backend: "codex-app-server-turn-sandbox",
      network_enforced: true,
      read_backend: "darwin-seatbelt-read-contained",
      read_enforced: true,
      write_backend: "darwin-seatbelt-read-contained",
      write_enforced: true,
    },
    {
      network_backend: "new-adapter-self-assertion",
      network_enforced: true,
      read_backend: "new-adapter-self-assertion",
      read_enforced: true,
      write_backend: "new-adapter-self-assertion",
      write_enforced: true,
    },
  ]) {
    assert.equal(hasTrustedRuntimeEnforcementEvidence(evidence), false);
  }
});

test("executor denied read roots include state, sensitive home paths, and configured additions", () => {
  const configured = [path.resolve("custom-secret-a"), path.resolve("custom-secret-b")];
  const roots = resolveExecutorDeniedReadRoots(path.resolve("project-state"), {
    NIIS_DENIED_READ_ROOTS: configured.join(path.delimiter),
  });
  assert.ok(roots.includes(path.resolve("project-state")));
  assert.ok(roots.includes(path.join(os.homedir(), ".ssh")));
  assert.ok(roots.includes(path.join(os.homedir(), ".aws")));
  assert.ok(roots.includes(path.join(os.homedir(), ".gnupg")));
  assert.ok(roots.includes(path.join(os.homedir(), ".config", "gh")));
  assert.ok(roots.includes(path.join(os.homedir(), ".npmrc")));
  assert.ok(configured.every((entry) => roots.includes(entry)));
});

test("terminal attempts synchronize the canonical task away from IN_REVIEW on failure", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initResult.status, 0, initResult.stderr);
  const plan = createInitPlan(workspaceRoot);
  const sqliteStorage = createSqliteStorage({
    databasePath: plan.databasePath,
  });
  const task = (id) => ({
    assigned_to: null,
    created_at: "2026-07-23T10:00:00.000Z",
    depends_on: [],
    goal_id: null,
    id,
    max_rejections: 5,
    out_of_scope: ["No unrelated changes."],
    phase: 1,
    priority: "medium",
    rejection_count: 0,
    status: "IN_REVIEW",
    title: `Task ${id}`,
    transition_log: [],
    updated_at: "2026-07-23T10:00:00.000Z",
  });
  await seedStorage(sqliteStorage, {
    tasks: [
      task("task-blocked"),
      task("task-cancelled"),
      task("task-failed"),
    ],
  });
  sqliteStorage.close();

  for (const [taskId, stage] of [
    ["task-blocked", "BLOCKED"],
    ["task-cancelled", "CANCELLED"],
    ["task-failed", "FAILED"],
  ]) {
    await synchronizeTaskStatusFromLifecycleResult({
      databasePath: plan.databasePath,
      lifecycleResult: {
        attempt_id: `attempt:${taskId}`,
        canonical_verdict: stage === "BLOCKED" ? "EVIDENCE_GAP" : null,
        stage,
      },
      taskId,
    });
  }

  const reopened = createSqliteStorage({
    databasePath: plan.databasePath,
    readonly: true,
  });
  try {
    const statuses = Object.fromEntries(
      (await reopened.tasks.list()).map((entry) => [entry.id, entry.status]),
    );
    assert.equal(statuses["task-blocked"], "BLOCKED");
    assert.equal(statuses["task-cancelled"], "BLOCKED");
    assert.equal(statuses["task-failed"], "BLOCKED");
  } finally {
    reopened.close();
  }
});

test("startup reconciliation projects active attempts and blocked queue entries into task status", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initResult.status, 0, initResult.stderr);
  const plan = createInitPlan(workspaceRoot);
  const baseTask = (id, status) => ({
    assigned_to: null,
    created_at: "2026-07-23T10:00:00.000Z",
    depends_on: [],
    goal_id: null,
    id,
    max_rejections: 5,
    out_of_scope: ["No unrelated changes."],
    phase: 1,
    priority: "medium",
    rejection_count: 0,
    status,
    title: `Task ${id}`,
    transition_log: [],
    updated_at: "2026-07-23T10:00:00.000Z",
  });
  const sqliteStorage = createSqliteStorage({ databasePath: plan.databasePath });
  await seedStorage(sqliteStorage, {
    tasks: [
      baseTask("task-active-projection", "IN_REVIEW"),
      baseTask("task-blocked-projection", "PENDING"),
    ],
  });
  sqliteStorage.close();
  const lifecycleStore = createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  try {
    await lifecycleStore.attempts.createOrResume({
      attemptId: "attempt-active-projection",
      engineVersion: "test",
      taskId: "task-active-projection",
      trigger: "test",
    });
    await lifecycleStore.queue.enqueue({
      taskId: "task-blocked-projection",
    });
    await lifecycleStore.queue.transition({
      expectedState: "PENDING",
      nextState: "BLOCKED",
      taskId: "task-blocked-projection",
    });
  } finally {
    lifecycleStore.close();
  }

  const changes = await reconcileLifecycleCompatibilityStatuses({
    databasePath: plan.databasePath,
  });
  assert.deepEqual(
    changes.map((entry) => [entry.task_id, entry.to_status]).sort(),
    [
      ["task-active-projection", "IN_PROGRESS"],
      ["task-blocked-projection", "BLOCKED"],
    ],
  );
  const reopened = createSqliteStorage({
    databasePath: plan.databasePath,
    readonly: true,
  });
  try {
    const statuses = Object.fromEntries(
      (await reopened.tasks.list()).map((entry) => [entry.id, entry.status]),
    );
    assert.equal(statuses["task-active-projection"], "IN_PROGRESS");
    assert.equal(statuses["task-blocked-projection"], "BLOCKED");
  } finally {
    reopened.close();
  }
});

test("UI resolve cannot invoke a legacy review rerun outside the lifecycle", () => {
  assert.throws(
    () => assertNoDirectUiReviewRerun({ rerunReview: true }),
    (error) =>
      error?.name === "UiLifecycleActionError"
      && error?.code === "direct_review_rerun_retired",
  );
  assert.deepEqual(
    assertNoDirectUiReviewRerun({ rerunReview: false }),
    { rerunReview: false },
  );
});

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, {
    mode: 0o755,
  });
}







function writeFakeCodexAppServerBinary(
  scriptPath,
  decideSrc,
  {
    executionMutationPath = null,
    hangReviewer = false,
    reviewerMarkerPath = null,
  } = {},
) {







  writeExecutable(scriptPath, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli test");
  process.exit(0);
}
const decidePayload = ${decideSrc};
const executionMutationPath = ${JSON.stringify(executionMutationPath)};
const hangReviewer = ${JSON.stringify(hangReviewer)};
const reviewerMarkerPath = ${JSON.stringify(reviewerMarkerPath)};

if (args.includes("exec")) {
  const outputIndex = args.indexOf("-o");
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const decision = decidePayload(input);
    if (decision && decision.error) {
      console.error(decision.error.message || "fake codex exec error");
      process.exit(1);
    }
    const payload = (decision && decision.text) || "";
    if (args.includes("--json")) {
      process.stdout.write(JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: payload },
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }) + "\\n");
    } else if (outputPath) {
      fs.writeFileSync(outputPath, payload);
    } else {
      process.stdout.write(payload);
    }
  });
  return;
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
let threadCounter = 0, turnCounter = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { userAgent: "fake-app-server/1.0", codexHome: "/tmp/.codex" } });
    return;
  }
  if (msg.method === "thread/start") {
    const threadId = "thread-" + (++threadCounter);
    send({ id: msg.id, result: { thread: { id: threadId } } });
    send({ method: "thread/started", params: { thread: { id: threadId } } });
    return;
  }
  if (msg.method === "turn/start") {
    const threadId = msg.params && msg.params.threadId;
    const turnId = "turn-" + (++turnCounter);
    const promptText = (msg.params && Array.isArray(msg.params.input) && msg.params.input[0] && msg.params.input[0].text) || "";
    send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
    const isReviewer = promptText.includes("strict acceptance-criteria reviewer")
      || promptText.includes("strict code reviewer");
    if (isReviewer && reviewerMarkerPath) {
      fs.mkdirSync(path.dirname(reviewerMarkerPath), { recursive: true });
      fs.writeFileSync(reviewerMarkerPath, "reviewer-ready\\n");
    }
    if (isReviewer && hangReviewer) {
      return;
    }
    if (executionMutationPath && !promptText.includes("Niis intake planner") && !isReviewer) {
      const mutationPath = path.resolve(process.cwd(), executionMutationPath);
      fs.mkdirSync(path.dirname(mutationPath), { recursive: true });
      fs.writeFileSync(mutationPath, "after execution\\n");
    }
    const decision = decidePayload(promptText);
    if (decision && decision.error) {
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error: decision.error } } });
    } else {
      const text = (decision && typeof decision.text === "string") ? decision.text : "";
      const itemId = "msg-" + turnId;
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: text } });
      send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", error: null } } });
    }
    return;
  }
});
`);
  return scriptPath;
}




function buildCodexDecideSrc({ plannerPayload, executionSummary }) {
  return `(function(prompt){
  if (prompt.includes("Niis intake planner")) return { text: ${JSON.stringify(plannerPayload)} };
  if (prompt.includes("strict acceptance-criteria reviewer") || prompt.includes("strict code reviewer")) {
    return { text: ${JSON.stringify('{"verdict":"PASS","reason":"The diff and deterministic evidence satisfy the approved criteria.","next_action":"Review the local branch before manual merge."}')} };
  }
  return { text: ${JSON.stringify(executionSummary)} };
})`;
}

function createFakeCodexBinary(binDir, {
  executionMutationPath = null,
  hangReviewer = false,
  plannerJson = null,
  plannerOutputText = null,
  reviewerMarkerPath = null,
  executionSummary = "codex execution summary",
} = {}) {
  const plannerPayload = plannerOutputText ?? JSON.stringify(plannerJson ?? {
    acceptance_checks: ["Keep the change scoped."],
    acceptance_commands: [
      { argv: ["npm", "test"], id: "unit-tests", required: true },
    ],
    operator_guidance: ["Inspect files first."],
    out_of_scope: [],
    phase: 3,
    priority: "high",
    subtasks: [
      { title: "Inspect the target files" },
      { title: "Apply the code change" },
    ],
    summary: "Planner summary",
    target_paths: ["src/example.js"],
    title: "Planner title",
  });
  const scriptPath = path.join(binDir, "codex");
  return writeFakeCodexAppServerBinary(
    scriptPath,
    buildCodexDecideSrc({ plannerPayload, executionSummary }),
    {
      executionMutationPath,
      hangReviewer,
      reviewerMarkerPath,
    },
  );
}

function createHintAwareCodexBinary(binDir) {
  const scriptPath = path.join(binDir, "codex");
  const decideSrc = `(function(prompt){
  if (prompt.includes("src/pages/settings.html")) {
    return { text: JSON.stringify({
      title: "Hint-aware planner title",
      summary: "Hint-aware planner summary",
      target_paths: ["src/pages/settings.html"],
      operator_guidance: ["Use repo hints."],
      acceptance_checks: ["Update the settings label only."],
      acceptance_commands: [
        { argv: ["npm", "test"], id: "unit-tests", required: true },
      ],
      out_of_scope: [],
      priority: "medium",
      phase: 0,
      subtasks: [
        { title: "Update settings label" },
        { title: "Verify no behavior changes" },
      ],
    }) };
  }
  return { text: JSON.stringify({
    title: "No hints",
    summary: "No hints",
    target_paths: [],
    operator_guidance: [],
    acceptance_checks: [],
    acceptance_commands: [
      { argv: ["npm", "test"], id: "unit-tests", required: true },
    ],
    out_of_scope: [],
    priority: "medium",
    phase: 0,
    subtasks: [],
  }) };
})`;
  return writeFakeCodexAppServerBinary(scriptPath, decideSrc);
}

function createFailingPlannerBinary(binDir) {
  const scriptPath = path.join(binDir, "codex");

  const decideSrc = `(function(prompt){
  if (prompt.includes("Niis intake planner")) {
    return { error: { message: "Planner runtime crashed unexpectedly", codexErrorInfo: "other" } };
  }
  return { text: "normal execution" };
})`;
  return writeFakeCodexAppServerBinary(scriptPath, decideSrc);
}

function createFakeClaudeBinary(binDir, {
  plannerJson = null,
  plannerJsonEnvelopeResult = null,
  plannerOutputText = null,
  executionSummary = "claude execution summary",
} = {}) {
  const plannerPayload = plannerOutputText ?? JSON.stringify(plannerJson ?? {
    acceptance_checks: ["Keep the change scoped."],
    acceptance_commands: [
      { argv: ["npm", "test"], id: "unit-tests", required: true },
    ],
    operator_guidance: ["Inspect files first."],
    out_of_scope: [],
    phase: 4,
    priority: "medium",
    subtasks: [
      { title: "Inspect the code" },
      { title: "Apply the fix" },
    ],
    summary: "Claude planner summary",
    target_paths: ["src/claude.js"],
    title: "Claude planner title",
  });
  const scriptPath = path.join(binDir, "claude");

  writeExecutable(scriptPath, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("claude-code test");
  process.exit(0);
}
const isPlanner = args.includes("--json-schema");
if (isPlanner) {
  if (args.includes("--output-format")) {
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: ${JSON.stringify(plannerJsonEnvelopeResult)} ?? ${JSON.stringify(plannerPayload)},
    }));
  } else {
    process.stdout.write(${JSON.stringify(plannerPayload)});
  }
} else {
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: ${JSON.stringify(executionSummary)},
  }));
}
`);

  return scriptPath;
}

function waitForChildStdoutMatch(child, pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const cleanup = () => {
      clearTimeout(timeoutId);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    const onStdout = (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(pattern);

      if (match) {
        if (match[1] && child.uiBootstrapRecordPath) {
          uiBootstrapRecordPaths.set(new URL(match[1]).origin, child.uiBootstrapRecordPath);
        }
        cleanup();
        resolve({
          match,
          stderr,
          stdout,
        });
      }
    };

    const onStderr = (chunk) => {
      stderr += chunk.toString();
    };

    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`child exited before readiness (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for child readiness\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

async function stopChildProcess(child) {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

const uiBootstrapRecordPaths = new Map();

function spawnUiTestServer(args, workspaceRoot, env = {}) {
  const bootstrapRecordPath = path.join(workspaceRoot, ".niis", "ui-bootstrap-test-url.txt");
  const child = spawn(process.execPath, [...args, "--open"], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      ...env,
      NIIS_UI_OPEN_RECORD_PATH: bootstrapRecordPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.uiBootstrapRecordPath = bootstrapRecordPath;
  return child;
}

async function createUiTestClient(baseUrl) {
  const origin = new URL(baseUrl).origin;
  const bootstrapRecordPath = uiBootstrapRecordPaths.get(origin);
  assert.ok(bootstrapRecordPath, `missing UI bootstrap record for ${origin}`);
  await waitForCondition(() => assert.equal(fs.existsSync(bootstrapRecordPath), true));
  const bootstrapUrl = fs.readFileSync(bootstrapRecordPath, "utf8").trim();
  fs.rmSync(bootstrapRecordPath, { force: true });
  const exchangeResponse = await fetch(bootstrapUrl, { redirect: "manual" });
  const setCookieHeaders = typeof exchangeResponse.headers.getSetCookie === "function"
    ? exchangeResponse.headers.getSetCookie()
    : [exchangeResponse.headers.get("set-cookie")].filter(Boolean);
  const cookie = setCookieHeaders
    .flatMap((header) => String(header).split(/,(?=\s*[^;,=\s]+=[^;,]+)/u))
    .map((header) => header.trim().split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
  assert.notEqual(cookie, "", "UI bootstrap must issue a session cookie");
  const bootstrapResponse = await fetch(baseUrl, {
    headers: { cookie },
  });

  return {
    bootstrapResponse,
    async fetch(input, init = {}) {
      const requestUrl = input instanceof URL ? input : new URL(input, baseUrl);
      const headers = new Headers(init.headers ?? {});
      headers.set("cookie", cookie);
      const method = String(init.method ?? "GET").toUpperCase();
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        headers.set("origin", origin);
      }
      return fetch(requestUrl, {
        ...init,
        headers,
      });
    },
  };
}

async function waitForCondition(assertFn, timeoutMs = 5000, intervalMs = 50) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await assertFn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw lastError ?? new Error("timed out waiting for condition");
}

test("niis help lists ui, upgrade-plan, asset-health, discover-pipeline, export-instincts, import-instincts, cluster-instincts, govern-learning, observation-lifecycle, guard-observation, and memory-taxonomy commands", () => {
  const result = spawnSync("node", [cliEntrypoint, "help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /- ui /);
  assert.match(result.stdout, /--open/);
  assert.match(result.stdout, /--serve/);
  assert.match(result.stdout, /asset-health/);
  assert.match(result.stdout, /discover-pipeline/);
  assert.match(result.stdout, /intake/);
  assert.match(result.stdout, /planner-runtime/);
  assert.match(result.stdout, /approve-plan/);
  assert.match(result.stdout, /start-task/);
  assert.match(result.stdout, /serve --once\|--daemon/);
  assert.match(result.stdout, /reset-state/);
  assert.match(result.stdout, /- backup /);
  assert.doesNotMatch(result.stdout, /^- restore\b/m);
  assert.match(result.stdout, /export-instincts/);
  assert.match(result.stdout, /import-instincts/);
  assert.match(result.stdout, /cluster-instincts/);
  assert.match(result.stdout, /govern-learning/);
  assert.match(result.stdout, /observation-lifecycle/);
  assert.match(result.stdout, /guard-observation/);
  assert.match(result.stdout, /memory-taxonomy/);
  assert.match(result.stdout, /upgrade-plan/);
  assert.match(result.stdout, /render-artifacts/);
  assert.match(result.stdout, /confirm-provider-cost/);
});

test("render-artifacts requires explicit mode, scope, and provider-cost confirmation", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const missingMode = spawnSync(process.execPath, [cliEntrypoint, "render-artifacts", "--all"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const missingConfirmation = spawnSync(process.execPath, [
    cliEntrypoint,
    "render-artifacts",
    "--claude",
    "--all",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.notEqual(missingMode.status, 0);
  assert.match(missingMode.stderr, /usage: niis render-artifacts/u);
  assert.notEqual(missingConfirmation.status, 0);
  assert.match(missingConfirmation.stderr, /requires --confirm-provider-cost/u);
});

test("doctor --security scans the active workspace state", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  fs.writeFileSync(
    path.join(workspaceRoot, ".niis", "local-config.txt"),
    'OPENAI_API_KEY="sk-synthetic-doctor-secret"\n',
  );

  const result = spawnSync(process.execPath, [cliEntrypoint, "doctor", "--security", "--json"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(report.has_error, true);
  assert.equal(
    report.checks.some((check) => check.summary.includes("security/plaintext-secret-persistence")),
    true,
  );
});

test("niis run fails closed instead of executing outside TaskAttempt lifecycle", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const result = spawnSync(process.execPath, [
    cliEntrypoint,
    "run",
    path.join(workspaceRoot, "execution-spec.json"),
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /execution is retired/i);
  assert.match(result.stderr, /canonical TaskAttempt lifecycle/);
});

test("niis serve requires exactly one explicit mode flag", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const missingMode = spawnSync(process.execPath, [cliEntrypoint, "serve"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const conflictingModes = spawnSync(process.execPath, [
    cliEntrypoint,
    "serve",
    "--once",
    "--daemon",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.notEqual(missingMode.status, 0);
  assert.match(missingMode.stderr, /exactly one of --once or --daemon/);
  assert.notEqual(conflictingModes.status, 0);
  assert.match(conflictingModes.stderr, /exactly one of --once or --daemon/);
});

test("niis readiness exposes the durable rollout gate without inventing evidence", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const status = spawnSync(process.execPath, [
    cliEntrypoint,
    "readiness",
    "status",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(status.status, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.ready, false);
  assert.equal(parsed.reason, "missing_readiness_record");

  const invalidRecord = spawnSync(process.execPath, [
    cliEntrypoint,
    "readiness",
    "record",
    "--kind",
    "canary_task",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.notEqual(invalidRecord.status, 0);
  assert.match(invalidRecord.stderr, /--task-id and --attempt-id are required/u);
});

test("Reliability RC restore fails closed without reaching destructive storage", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const externalBackupRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-cli-retired-restore-"),
  );
  t.after(() => {
    fs.rmSync(externalBackupRoot, { force: true, recursive: true });
  });

  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const plan = createInitPlan(workspaceRoot);
  const sentinelPath = path.join(plan.stateRoot, "restore-sentinel.txt");
  fs.writeFileSync(sentinelPath, "backup-version\n", { mode: 0o600 });
  const backup = performBackup(plan.stateRoot, {
    now: "2026-07-23T12:00:00.000Z",
  });
  const externalBackupPath = path.join(
    externalBackupRoot,
    path.basename(backup.backup_path),
  );
  fs.cpSync(backup.backup_path, externalBackupPath, {
    recursive: true,
  });

  fs.writeFileSync(sentinelPath, "live-version\n", { mode: 0o600 });
  const liveOnlyPath = path.join(plan.stateRoot, "live-only.txt");
  fs.writeFileSync(liveOnlyPath, "must-survive\n", { mode: 0o640 });
  const stableTimestamp = new Date("2026-07-23T12:05:00.000Z");
  fs.utimesSync(sentinelPath, stableTimestamp, stableTimestamp);
  fs.utimesSync(liveOnlyPath, stableTimestamp, stableTimestamp);
  const before = snapshotFilesystemTree(plan.stateRoot);

  await assert.rejects(
    main(["restore", "--from", externalBackupPath]),
    (error) =>
      error?.code === "restore_retired_reliability_rc"
      && error?.status === 410,
  );
  const retired = spawnSync(process.execPath, [
    cliEntrypoint,
    "restore",
    "--from",
    externalBackupPath,
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(retired.status, 1);
  assert.match(retired.stderr, /restore is retired in Reliability RC/);
  assert.match(retired.stderr, /live state was not modified/);
  assert.equal(retired.stdout, "");
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), "live-version\n");
  assert.equal(fs.readFileSync(liveOnlyPath, "utf8"), "must-survive\n");
  assert.deepEqual(
    snapshotFilesystemTree(plan.stateRoot),
    before,
    "retired restore must preserve every live-state byte and metadata record",
  );
});

test("niis init is idempotent and reset-state requires a verified external backup", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-cli-reset-backups-"));

  t.after(() => {
    fs.rmSync(backupRoot, { force: true, recursive: true });
  });

  const first = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /mode: created/);

  const stateRoot = path.join(workspaceRoot, ".niis");
  const sentinelPath = path.join(stateRoot, "sentinel.txt");
  fs.writeFileSync(sentinelPath, "preserve me\n");
  const keyPath = path.join(stateRoot, "secrets", "master.key");
  const keyHash = createHash("sha256").update(fs.readFileSync(keyPath)).digest("hex");

  const second = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /mode: verified/);
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), "preserve me\n");
  assert.equal(
    createHash("sha256").update(fs.readFileSync(keyPath)).digest("hex"),
    keyHash,
  );

  const wrongConfirmation = spawnSync(process.execPath, [
    cliEntrypoint,
    "reset-state",
    "--backup-to",
    backupRoot,
    "--confirm",
    "wrong",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.notEqual(wrongConfirmation.status, 0);
  assert.equal(fs.existsSync(stateRoot), true);

  const projectId = path.basename(workspaceRoot).toLowerCase();
  const reset = spawnSync(process.execPath, [
    cliEntrypoint,
    "reset-state",
    "--backup-to",
    backupRoot,
    "--confirm",
    projectId,
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal(fs.existsSync(stateRoot), false);
  const backupDirectories = fs.readdirSync(backupRoot);
  assert.equal(backupDirectories.length, 1);
  assert.equal(
    fs.readFileSync(
      path.join(backupRoot, backupDirectories[0], "snapshot", "sentinel.txt"),
      "utf8",
    ),
    "preserve me\n",
  );
});

test("reset-state refuses active attempts and live queue claims before backup or deletion", async (t) => {
  const backupRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-cli-reset-active-backups-"),
  );
  t.after(() => {
    fs.rmSync(backupRoot, { force: true, recursive: true });
  });

  const activeWorkspace = createWorkspaceFixture(t);
  const activeInit = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: activeWorkspace,
    encoding: "utf8",
  });
  assert.equal(activeInit.status, 0, activeInit.stderr);
  const activeStateRoot = path.join(activeWorkspace, ".niis");
  const activeSentinel = path.join(activeStateRoot, "active-sentinel.txt");
  fs.writeFileSync(activeSentinel, "active attempt must survive\n");
  const activeStore = createLifecycleSqliteStore({
    databasePath: createInitPlan(activeWorkspace).databasePath,
  });
  await activeStore.attempts.createOrResume({
    attemptId: "attempt-reset-active",
    engineVersion: "test",
    taskId: "task-reset-active",
    trigger: "test",
  });
  activeStore.close();

  const activeReset = spawnSync(process.execPath, [
    cliEntrypoint,
    "reset-state",
    "--backup-to",
    backupRoot,
    "--confirm",
    path.basename(activeWorkspace).toLowerCase(),
  ], {
    cwd: activeWorkspace,
    encoding: "utf8",
  });
  assert.notEqual(activeReset.status, 0);
  assert.match(activeReset.stderr, /attempt attempt-reset-active is active/u);
  assert.equal(fs.readFileSync(activeSentinel, "utf8"), "active attempt must survive\n");
  assert.deepEqual(fs.readdirSync(backupRoot), []);

  const claimedWorkspace = createWorkspaceFixture(t);
  const claimedInit = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: claimedWorkspace,
    encoding: "utf8",
  });
  assert.equal(claimedInit.status, 0, claimedInit.stderr);
  const claimedStateRoot = path.join(claimedWorkspace, ".niis");
  const claimedSentinel = path.join(claimedStateRoot, "claim-sentinel.txt");
  fs.writeFileSync(claimedSentinel, "live claim must survive\n");
  const claimedStore = createLifecycleSqliteStore({
    databasePath: createInitPlan(claimedWorkspace).databasePath,
  });
  await claimedStore.queue.enqueue({ taskId: "task-reset-claimed" });
  await claimedStore.queue.claimNext({
    holder: "reset-test-holder",
    ttlMs: 10 * 60 * 1000,
  });
  claimedStore.close();

  const claimedReset = spawnSync(process.execPath, [
    cliEntrypoint,
    "reset-state",
    "--backup-to",
    backupRoot,
    "--confirm",
    path.basename(claimedWorkspace).toLowerCase(),
  ], {
    cwd: claimedWorkspace,
    encoding: "utf8",
  });
  assert.notEqual(claimedReset.status, 0);
  assert.match(claimedReset.stderr, /queue claim task-reset-claimed is active/u);
  assert.equal(fs.readFileSync(claimedSentinel, "utf8"), "live claim must survive\n");
  assert.deepEqual(fs.readdirSync(backupRoot), []);
});

test("reset-state rejects a symlinked live root before opening or mutating its target", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const externalRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-cli-reset-state-target-"),
  );
  const backupRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-cli-reset-state-link-backups-"),
  );
  const sentinelPath = path.join(externalRoot, "sentinel.txt");
  fs.writeFileSync(sentinelPath, "external target remains exact\n");
  const beforeEntries = fs.readdirSync(externalRoot).sort();
  const beforeHash = createHash("sha256")
    .update(fs.readFileSync(sentinelPath))
    .digest("hex");
  fs.symlinkSync(externalRoot, path.join(workspaceRoot, ".niis"), "dir");

  t.after(() => {
    fs.rmSync(externalRoot, { force: true, recursive: true });
    fs.rmSync(backupRoot, { force: true, recursive: true });
  });

  const reset = spawnSync(process.execPath, [
    cliEntrypoint,
    "reset-state",
    "--backup-to",
    backupRoot,
    "--confirm",
    path.basename(workspaceRoot).toLowerCase(),
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.notEqual(reset.status, 0);
  assert.match(reset.stderr, /state is unsafe and was left untouched/u);
  assert.equal(fs.lstatSync(path.join(workspaceRoot, ".niis")).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(externalRoot).sort(), beforeEntries);
  assert.equal(
    createHash("sha256").update(fs.readFileSync(sentinelPath)).digest("hex"),
    beforeHash,
  );
  assert.deepEqual(fs.readdirSync(backupRoot), []);
});

test("reset-state invalid preflight is read-only even for partial state without SQLite", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const stateRoot = path.join(workspaceRoot, ".niis");
  const externalBackupRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-cli-reset-preflight-backups-"),
  );
  const externalLinkRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-cli-reset-preflight-links-"),
  );
  const stateLink = path.join(externalLinkRoot, "state-link");
  const projectId = path.basename(workspaceRoot).toLowerCase();
  const plan = createInitPlan(workspaceRoot);

  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(stateRoot, "sentinel.txt"), "partial state is immutable\n", {
    mode: 0o600,
  });
  fs.symlinkSync(stateRoot, stateLink, "dir");

  t.after(() => {
    fs.rmSync(externalBackupRoot, { force: true, recursive: true });
    fs.rmSync(externalLinkRoot, { force: true, recursive: true });
  });

  const rejectedCommands = [
    {
      args: ["--confirm", projectId],
      error: /usage: niis reset-state/u,
    },
    {
      args: [
        "--backup-to",
        externalBackupRoot,
        "--confirm",
        "wrong-project",
      ],
      error: /reset confirmation must exactly match project id/u,
    },
    {
      args: [
        "--backup-to",
        path.join(workspaceRoot, "inside-project"),
        "--confirm",
        projectId,
      ],
      error: /resolve outside the project workspace and live state/u,
    },
    {
      args: [
        "--backup-to",
        path.join(stateLink, "through-symlink"),
        "--confirm",
        projectId,
      ],
      error: /resolve outside the project workspace and live state/u,
    },
  ];

  for (const rejected of rejectedCommands) {
    const before = snapshotFilesystemTree(workspaceRoot);
    const result = spawnSync(process.execPath, [
      cliEntrypoint,
      "reset-state",
      ...rejected.args,
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, rejected.error);
    assert.deepEqual(snapshotFilesystemTree(workspaceRoot), before);
    assert.equal(fs.existsSync(plan.databasePath), false);
  }

  assert.deepEqual(fs.readdirSync(externalBackupRoot), []);
});

test("Reliability RC rejects intake --auto-run before creating a task", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initResult.status, 0, initResult.stderr);

  const result = spawnSync(process.execPath, [
    cliEntrypoint,
    "intake",
    "--auto-run",
    "--task-id",
    "task-auto-run-denied",
    "--text",
    "This must remain a plan only.",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--auto-run is disabled/);

  const sqliteStorage = createSqliteStorage({
    databasePath: createInitPlan(workspaceRoot).databasePath,
    readonly: true,
  });
  try {
    assert.equal(
      (await sqliteStorage.tasks.list()).some((task) => task.id === "task-auto-run-denied"),
      false,
    );
  } finally {
    sqliteStorage.close();
  }
});

test("niis intake fails closed without persisting a task when runtimes are missing", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(initResult.status, 0);

  const result = spawnSync(process.execPath, [
    cliEntrypoint,
    "intake",
    "--task-id",
    "task-intake-missing-runtimes",
    "--text",
    "Add a parser source toggle.",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: "",
      PATH: "/usr/bin:/bin",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no planner produced a valid plan/);
  const intakePath = path.join(workspaceRoot, ".niis", "intake", "task-intake-missing-runtimes", "intake.json");
  const routePreviewPath = path.join(workspaceRoot, ".niis", "intake", "task-intake-missing-runtimes", "route-preview.json");
  const sqliteStorage = createSqliteStorage({
    databasePath: createInitPlan(workspaceRoot).databasePath,
    readonly: true,
  });

  try {
    assert.equal(fs.existsSync(intakePath), false);
    assert.equal(fs.existsSync(routePreviewPath), false);
    assert.equal((await sqliteStorage.tasks.list()).some((task) => task.id === "task-intake-missing-runtimes"), false);
    assert.equal((await sqliteStorage.taskNotes.byTask("task-intake-missing-runtimes")).length, 0);
    assert.equal((await sqliteStorage.ingress.byTask("task-intake-missing-runtimes")).length, 0);
  } finally {
    sqliteStorage.close();
  }
});

test("niis intake fails closed when the planner runtime returns invalid JSON", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const binDir = path.join(workspaceRoot, "bin");

  assert.equal(initResult.status, 0);
  createFakeCodexBinary(binDir, {
    plannerOutputText: "not-json-at-all",
  });

  const result = spawnSync(process.execPath, [
    cliEntrypoint,
    "intake",
    "--task-id",
    "task-invalid-planner",
    "--text",
    "Implement a small parser change.",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no planner produced a valid plan/);
  assert.match(result.stderr, /codex_local: runtime returned invalid structured plan output/);
  assert.match(result.stderr, /Using planner runtime: codex_local/);
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, ".niis", "intake", "task-invalid-planner")),
    false,
  );
});

test("niis intake supports --planner-runtime and logs the selected planner runtime", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const binDir = path.join(workspaceRoot, "bin");

  assert.equal(initResult.status, 0);
  createFakeCodexBinary(binDir, {
    executionSummary: "codex execution summary",
  });
  createFakeClaudeBinary(binDir, {
    executionSummary: "claude execution summary",
  });

  const result = spawnSync(process.execPath, [
    cliEntrypoint,
    "intake",
    "--planner-runtime",
    "claude",
    "--task-id",
    "task-planner-runtime-claude",
    "--text",
    "Implement a parser task.",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: path.join(binDir, "claude"),
      NIIS_CODEX_LOCAL_BIN: path.join(binDir, "codex"),
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.planner_runtime_requested, "claude");
  assert.equal(output.planner_attempts.length, 1);
  assert.equal(output.planner_attempts[0].runtime_id, "claude_code_local");
  assert.match(result.stderr, /Using planner runtime: claude_code_local/);
});

test("niis intake accepts codex planner output wrapped in markdown fences and commentary", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const binDir = path.join(workspaceRoot, "bin");

  assert.equal(initResult.status, 0);
  createFakeCodexBinary(binDir, {
    plannerOutputText: [
      "Here is the structured planner result:",
      "```json",
      JSON.stringify({
        acceptance_checks: ["Keep UI behavior unchanged."],
        acceptance_commands: [
          { argv: ["npm", "test"], id: "unit-tests", required: true },
        ],
        operator_guidance: ["Inspect the settings page labels before editing."],
        out_of_scope: [],
        phase: 11,
        priority: "medium",
        subtasks: [
          { title: "Inspect settings labels" },
          { title: "Rename the UI copy" },
        ],
        summary: "Rename the label without changing behavior.",
        target_paths: ["src/pages/settings.html"],
        title: "Rename Sample Input label",
      }, null, 2),
      "```",
    ].join("\n"),
  });

  const result = spawnSync(process.execPath, [
    cliEntrypoint,
    "intake",
    "--planner-runtime",
    "codex",
    "--task-id",
    "task-planner-fenced-json",
    "--text",
    "Rename Sample Input to Sample Inputs on the settings page without changing behavior.",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.intake.planner_mode, "structured_planner");
  assert.equal(output.intake.planner_runtime, "codex_local");
  assert.deepEqual(output.intake.reference_bundle.target_paths, ["src/pages/settings.html"]);
  assert.deepEqual(output.intake.acceptance_checks, ["Keep UI behavior unchanged."]);
  assert.equal(output.intake.subtasks.length, 2);
  assert.equal(output.next_command, "niis approve-plan --task-id task-planner-fenced-json");
  assert.match(output.planner_attempts[0].raw_excerpt, /structured planner result/i);
});

test("niis intake accepts codex planner output wrapped inside a JSON envelope", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const binDir = path.join(workspaceRoot, "bin");

  assert.equal(initResult.status, 0);
  createFakeCodexBinary(binDir, {
    plannerOutputText: JSON.stringify({
      content: [
        {
          text: [
            "```json",
            JSON.stringify({
              acceptance_checks: ["Keep UI behavior unchanged."],
              acceptance_commands: [
                { argv: ["npm", "test"], id: "unit-tests", required: true },
              ],
              operator_guidance: ["Inspect the settings page labels before editing."],
              out_of_scope: [],
              phase: 11,
              priority: "medium",
              subtasks: [
                { title: "Inspect settings labels" },
                { title: "Rename the UI copy" },
              ],
              summary: "Rename the label without changing behavior.",
              target_paths: ["src/pages/settings.html"],
              title: "Rename Sample Input label",
            }, null, 2),
            "```",
          ].join("\n"),
        },
      ],
    }),
  });

  const result = spawnSync(process.execPath, [
    cliEntrypoint,
    "intake",
    "--planner-runtime",
    "codex",
    "--task-id",
    "task-planner-json-envelope",
    "--text",
    "Rename Sample Input to Sample Inputs on the settings page without changing behavior.",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.intake.planner_mode, "structured_planner");
  assert.equal(output.intake.planner_runtime, "codex_local");
  assert.deepEqual(output.intake.reference_bundle.target_paths, ["src/pages/settings.html"]);
  assert.deepEqual(output.intake.acceptance_checks, ["Keep UI behavior unchanged."]);
  assert.equal(output.intake.subtasks.length, 2);
  assert.match(output.planner_attempts[0].raw_excerpt, /content/i);
});

test("buildPlannerContextHints uses quoted literals without product-specific path pinning", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  fs.mkdirSync(path.join(workspaceRoot, "src", "pages"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "niis", "packages", "cli", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, "src", "pages", "settings.html"),
    "<label>Sample Input</label>\n",
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "src", "pages", "settings.test.js"),
    'it("mentions Sample Input", () => {});\n',
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "niis", "packages", "cli", "src", "main.test.js"),
    'test("Sample Input", () => {});\n',
  );
  const hints = buildPlannerContextHints({
    operatorPrompt: 'Rename "Sample Input" to "Sample Inputs" on the settings page without changing behavior.',
    workspaceRoot,
  });

  assert.deepEqual(hints.candidatePaths, ["src/pages/settings.html"]);
  assert.match(hints.promptBlock, /src\/pages\/settings\.html/);
  assert.doesNotMatch(hints.promptBlock, /niis\/packages\/cli\/src\/main\.test\.js/);
  assert.doesNotMatch(hints.promptBlock, /src\/pages\/settings\.test\.js/);
});

test("buildPlannerContextHints does not inject unrelated parser files", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "src", "csv-parser.js"), "export const parse = () => [];\n");
  fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Example\n");

  const hints = buildPlannerContextHints({
    operatorPrompt: "Add a dark theme.",
    workspaceRoot,
  });

  assert.deepEqual(hints.candidatePaths, []);
  assert.equal(hints.promptBlock, "");
});

test("niis intake retries claude planner in text mode when json envelope result is empty", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const binDir = path.join(workspaceRoot, "bin");

  assert.equal(initResult.status, 0);
  createFakeClaudeBinary(binDir, {
    plannerJsonEnvelopeResult: "",
    plannerOutputText: JSON.stringify({
      acceptance_checks: ["Keep UI behavior unchanged."],
      acceptance_commands: [
        { argv: ["npm", "test"], id: "unit-tests", required: true },
      ],
      operator_guidance: ["Inspect the settings page labels before editing."],
      out_of_scope: [],
      phase: 11,
      priority: "medium",
      subtasks: [
        { title: "Inspect settings labels" },
        { title: "Rename the UI copy" },
      ],
      summary: "Rename the label without changing behavior.",
      target_paths: ["src/pages/settings.html"],
      title: "Rename Sample Input label",
    }),
  });

  const result = spawnSync(process.execPath, [
    cliEntrypoint,
    "intake",
    "--planner-runtime",
    "claude",
    "--task-id",
    "task-planner-claude-text-retry",
    "--text",
    "Rename Sample Input to Sample Inputs on the settings page without changing behavior.",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: path.join(binDir, "claude"),
      NIIS_CODEX_LOCAL_BIN: "",
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.intake.planner_mode, "structured_planner");
  assert.equal(output.intake.planner_runtime, "claude_code_local");
  assert.deepEqual(output.intake.reference_bundle.target_paths, ["src/pages/settings.html"]);
  assert.deepEqual(output.intake.acceptance_checks, ["Keep UI behavior unchanged."]);
  assert.equal(output.intake.subtasks.length, 2);
});

test("niis start-task uses persisted intake artifacts and writes a final report", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "src", "example.js"), "before execution\n");
  fs.writeFileSync(path.join(workspaceRoot, ".gitignore"), ".niis/\n");
  const gitInit = spawnSync("git", ["init", "-b", "main"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(gitInit.status, 0, gitInit.stderr);
  assert.equal(
    spawnSync("git", ["add", ".gitignore", "src/example.js"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    }).status,
    0,
  );
  const initialCommit = spawnSync("git", [
    "-c",
    "user.name=Niis Test",
    "-c",
    "user.email=niis-test@local",
    "commit",
    "-m",
    "fixture baseline",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialCommit.status, 0, initialCommit.stderr);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const binDir = path.join(workspaceRoot, "bin");

  assert.equal(initResult.status, 0);



  const projectConfigPath = path.join(workspaceRoot, ".niis", "project-config.json");
  const projectConfig = fs.existsSync(projectConfigPath)
    ? JSON.parse(fs.readFileSync(projectConfigPath, "utf8"))
    : {};
  projectConfig.roles = {
    ...(projectConfig.roles ?? {}),
    "generalist-worker": {
      ...(projectConfig.roles?.["generalist-worker"] ?? {}),
      budget: {
        per_run_usd: 5,
      },
      quality_gates: [{
        args: ["diff", "--check"],
        command: "git",
        fail_mode: "hard",
        id: "fixture.acceptance",
      }],
    },
  };
  writeJson(projectConfigPath, projectConfig);
  createFakeCodexBinary(binDir, {
    executionMutationPath: "src/example.js",
    executionSummary: "Changed parser source mode and verified with focused checks.",
    plannerJson: {


      acceptance_checks: ["Parser source toggle flips between modes and existing tests pass."],
      acceptance_commands: [
        {
          argv: ["git", "diff", "--check"],
          id: "fixture.acceptance",
          required: true,
        },
      ],
      operator_guidance: ["Inspect files first."],
      out_of_scope: ["NONE"],
      phase: 3,
      priority: "high",
      subtasks: [],
      summary: "Planner summary",
      target_paths: ["src/example.js"],
      title: "Planner title",
    },
  });

  const intakeResult = spawnSync(process.execPath, [
    cliEntrypoint,
    "intake",
    "--task-id",
    "task-start-task",
    "--text",
    "Add a parser source toggle and keep existing behavior intact.",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });

  assert.equal(intakeResult.status, 0, intakeResult.stderr);

  const unapprovedStart = spawnSync(process.execPath, [
    cliEntrypoint,
    "start-task",
    "--task-id",
    "task-start-task",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });
  assert.notEqual(unapprovedStart.status, 0);
  assert.match(unapprovedStart.stderr, /no approved plan/);

  const approveResult = spawnSync(process.execPath, [
    cliEntrypoint,
    "approve-plan",
    "--task-id",
    "task-start-task",
    "--note",
    "Approved by the focused CLI fixture.",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(approveResult.status, 0, approveResult.stderr);
  assert.equal(JSON.parse(approveResult.stdout).approval.status, "APPROVED");

  const approvedArtifactPath = path.join(
    workspaceRoot,
    ".niis",
    "intake",
    "task-start-task",
    "intake.json",
  );
  const approvedArtifact = JSON.parse(
    fs.readFileSync(approvedArtifactPath, "utf8"),
  );
  writeJson(approvedArtifactPath, {
    ...approvedArtifact,
    summary: `${approvedArtifact.summary} revised after approval`,
  });
  const staleApprovalStart = spawnSync(process.execPath, [
    cliEntrypoint,
    "start-task",
    "--task-id",
    "task-start-task",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });
  assert.notEqual(staleApprovalStart.status, 0);
  assert.match(staleApprovalStart.stderr, /no approved plan/u);

  const reapproveResult = spawnSync(process.execPath, [
    cliEntrypoint,
    "approve-plan",
    "--task-id",
    "task-start-task",
    "--note",
    "Approved again after the plan revision.",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(reapproveResult.status, 0, reapproveResult.stderr);

  const injectedCrash = spawnSync(process.execPath, [
    cliEntrypoint,
    "serve",
    "--once",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      NIIS_TEST_PROMOTION_FAIL_AFTER_STEP: "branch",
      NIIS_TEST_RUN: "1",
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });
  assert.notEqual(injectedCrash.status, 0);
  assert.match(injectedCrash.stderr, /injected promotion failure after branch/u);

  const crashStore = createLifecycleSqliteStore({
    databasePath: createInitPlan(workspaceRoot).databasePath,
    readonly: true,
  });
  let crashedAttemptId;
  let publishedBranch;
  try {
    const attempts = await crashStore.attempts.listByTask("task-start-task");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].stage, "READY_TO_PROMOTE");
    crashedAttemptId = attempts[0].id;
    const queueEntry = await crashStore.queue.byTask("task-start-task");
    assert.equal(queueEntry.state, "PENDING");
    assert.equal(queueEntry.payload.attempt_id, crashedAttemptId);
    assert.equal(queueEntry.payload.resume_required, true);
    const promotion = await crashStore.promotions.byAttempt(crashedAttemptId);
    assert.equal(promotion.status, "PENDING");
    const branches = spawnSync("git", [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/niis/task/",
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    assert.equal(branches.status, 0, branches.stderr);
    const publishedBranches = branches.stdout.trim().split("\n").filter(Boolean);
    assert.equal(publishedBranches.length, 1);
    [publishedBranch] = publishedBranches;
    assert.match(publishedBranch, /^niis\/task\//u);
  } finally {
    crashStore.close();
  }

  const startResult = spawnSync(process.execPath, [
    cliEntrypoint,
    "start-task",
    "--task-id",
    "task-start-task",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  });

  assert.equal(startResult.status, 0, startResult.stderr);

  const output = JSON.parse(startResult.stdout);
  assert.equal(output.lifecycle.attempt_id, crashedAttemptId);
  const branchesAfterRecovery = spawnSync("git", [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/niis/task/",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(branchesAfterRecovery.status, 0, branchesAfterRecovery.stderr);
  assert.deepEqual(
    branchesAfterRecovery.stdout.trim().split("\n").filter(Boolean),
    [publishedBranch],
  );
  const reportJsonPath = path.join(workspaceRoot, ".niis", "intake", "task-start-task", "report.json");
  const reportMarkdownPath = path.join(workspaceRoot, ".niis", "intake", "task-start-task", "report.md");
  const progressJsonPath = path.join(workspaceRoot, ".niis", "intake", "task-start-task", "execution-progress.json");
  const progressLogPath = path.join(workspaceRoot, ".niis", "intake", "task-start-task", "execution-progress.log");
  const sqliteStorage = createSqliteStorage({
    databasePath: createInitPlan(workspaceRoot).databasePath,
    readonly: true,
  });

  try {
    assert.equal(output.final_task.status, "IN_REVIEW");
    assert.equal(output.final_verdict.verdict_class, "PASS");
    assert.equal(output.lifecycle.stage, "FINISHED");
    assert.equal(output.lifecycle.state.gates.source, "acceptance_command_runner");
    assert.equal(output.lifecycle.state.gates.results[0].status, "PASS");
    assert.equal(output.lifecycle.state.review.fresh_context, true);
    assert.equal(output.lifecycle.state.review.source, "fresh_outer_llm_review");
    assert.equal(output.lifecycle.state.review.llm_review.verdict, "PASS");
    assert.match(
      output.lifecycle.state.workspace.primary_checkout_digest,
      /^[a-f0-9]{64}$/u,
    );
    assert.deepEqual(
      output.lifecycle.state.finish.readiness_evidence.primary_checkout,
      {
        after_digest: output.lifecycle.state.workspace.primary_checkout_digest,
        before_digest: output.lifecycle.state.workspace.primary_checkout_digest,
      },
    );
    assert.equal(output.lifecycle.state.finish.readiness_evidence.schema_version, 2);
    assert.equal(
      output.lifecycle.state.finish.readiness_evidence.repository.class,
      "disposable_fixture",
    );
    assert.match(
      output.lifecycle.state.finish.readiness_evidence.repository.identity_sha256,
      /^[a-f0-9]{64}$/u,
    );
    assert.match(
      output.lifecycle.state.finish.readiness_evidence.repository.changed_paths_sha256,
      /^[a-f0-9]{64}$/u,
    );
    assert.equal(
      output.lifecycle.state.finish.readiness_evidence.runtime.adapter_id,
      output.run_record.adapter_id,
    );
    assert.equal(output.lifecycle.state.finish.readiness_evidence.budget.limit, 5);
    assert.equal(
      Number.isFinite(output.lifecycle.state.finish.readiness_evidence.budget.used),
      true,
    );
    assert.equal(output.lifecycle.promotion.target_kind, "BRANCH");
    assert.match(output.lifecycle.promotion.target_ref, /^niis\/task\//);
    assert.equal(typeof output.lifecycle.promotion.commit_sha, "string");
    assert.equal(output.assignment.context.includes("Selected lane generalist"), true);
    assert.equal(fs.existsSync(reportJsonPath), true);
    assert.equal(fs.existsSync(reportMarkdownPath), true);
    assert.equal(fs.existsSync(progressJsonPath), true);
    assert.equal(fs.existsSync(progressLogPath), true);
    assert.match(fs.readFileSync(reportMarkdownPath, "utf8"), /Intake Prompt/);
    assert.match(fs.readFileSync(progressLogPath, "utf8"), /executing/i);
    assert.equal(JSON.parse(fs.readFileSync(progressJsonPath, "utf8")).stage, "completed");
    assert.equal((await sqliteStorage.runs.byTask("task-start-task")).length, 1);
    assert.equal((await sqliteStorage.taskNotes.byTask("task-start-task")).length, 3);
    assert.equal(
      (await sqliteStorage.tasks.list())
        .find((entry) => entry.id === "task-start-task")?.status,
      "IN_REVIEW",
    );
    assert.match(
      `${injectedCrash.stderr}\n${startResult.stderr}`,
      /Using execution runtime: codex_local/,
    );
    const lifecycleStore = createLifecycleSqliteStore({
      databasePath: createInitPlan(workspaceRoot).databasePath,
      readonly: true,
    });
    try {
      const queueEntry = await lifecycleStore.queue.byTask("task-start-task");
      assert.equal(queueEntry.state, "COMPLETED");
      assert.equal(queueEntry.payload.attempt_id, output.lifecycle.attempt_id);
      assert.equal(queueEntry.payload.canonical_verdict, "PASS");
    } finally {
      lifecycleStore.close();
    }
    const repeatedStart = spawnSync(process.execPath, [
      cliEntrypoint,
      "start-task",
      "--task-id",
      "task-start-task",
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NIIS_CLAUDE_CODE_LOCAL_BIN: "",
        NIIS_CODEX_LOCAL_BIN: undefined,
        PATH: `${binDir}:/usr/bin:/bin`,
      },
    });
    assert.notEqual(repeatedStart.status, 0);
    assert.match(repeatedStart.stderr, /Execution is not allowed while task status is IN_REVIEW/u);
    const afterRepeatStore = createLifecycleSqliteStore({
      databasePath: createInitPlan(workspaceRoot).databasePath,
      readonly: true,
    });
    try {
      assert.equal(
        (await afterRepeatStore.attempts.listByTask("task-start-task")).length,
        1,
        "a successful task must not be replayed into a second attempt",
      );
    } finally {
      afterRepeatStore.close();
    }
    assert.equal(
      fs.existsSync(path.join(
        workspaceRoot,
        ".niis",
        "leases",
        "__project_execution__.json",
      )),
      false,
    );

    const explainResult = spawnSync(process.execPath, [
      cliEntrypoint,
      "explain",
      "--task-id",
      "task-start-task",
    ], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    assert.equal(explainResult.status, 0);
    assert.equal(JSON.parse(explainResult.stdout).task_notes.length, 3);
  } finally {
    sqliteStorage.close();
  }
});

test("SIGTERM during fresh review durably cancels the attempt and queue", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "src", "cancel.js"), "before cancellation\n");
  fs.writeFileSync(path.join(workspaceRoot, ".gitignore"), ".niis/\n");
  assert.equal(
    spawnSync("git", ["init", "-b", "main"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    }).status,
    0,
  );
  assert.equal(
    spawnSync("git", ["add", ".gitignore", "src/cancel.js"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    }).status,
    0,
  );
  const initialCommit = spawnSync("git", [
    "-c",
    "user.name=Niis Test",
    "-c",
    "user.email=niis-test@local",
    "commit",
    "-m",
    "cancellation fixture baseline",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialCommit.status, 0, initialCommit.stderr);
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const projectConfigPath = path.join(
    workspaceRoot,
    ".niis",
    "project-config.json",
  );
  const projectConfig = fs.existsSync(projectConfigPath)
    ? JSON.parse(fs.readFileSync(projectConfigPath, "utf8"))
    : {};
  projectConfig.roles = {
    ...(projectConfig.roles ?? {}),
    "generalist-worker": {
      ...(projectConfig.roles?.["generalist-worker"] ?? {}),
      budget: { per_run_usd: 5 },
      quality_gates: [{
        args: ["diff", "--check"],
        command: "git",
        fail_mode: "hard",
        id: "fixture.cancel.acceptance",
      }],
    },
  };
  writeJson(projectConfigPath, projectConfig);

  const binDir = path.join(workspaceRoot, "bin");
  createFakeCodexBinary(binDir, {
    executionMutationPath: "src/cancel.js",
    executionSummary: "Prepared the cancellation fixture change.",
    hangReviewer: true,
    plannerJson: {
      acceptance_checks: ["The scoped source change passes diff checks."],
      acceptance_commands: [{
        argv: ["git", "diff", "--check"],
        id: "fixture.cancel.acceptance",
        required: true,
      }],
      operator_guidance: ["Keep the change scoped."],
      out_of_scope: ["No unrelated changes."],
      phase: 3,
      priority: "medium",
      subtasks: [],
      summary: "Cancellation review fixture",
      target_paths: ["src/cancel.js"],
      title: "Cancellation review fixture",
    },
  });
  const runtimeEnv = {
    ...process.env,
    NIIS_CLAUDE_CODE_LOCAL_BIN: "",
    NIIS_CODEX_LOCAL_BIN: undefined,
    PATH: `${binDir}:/usr/bin:/bin`,
  };
  const intake = spawnSync(process.execPath, [
    cliEntrypoint,
    "intake",
    "--task-id",
    "task-cancel-review",
    "--text",
    "Prepare a scoped change so cancellation can be tested during fresh review.",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: runtimeEnv,
  });
  assert.equal(intake.status, 0, intake.stderr);
  const approval = spawnSync(process.execPath, [
    cliEntrypoint,
    "approve-plan",
    "--task-id",
    "task-cancel-review",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(approval.status, 0, approval.stderr);

  const child = spawn(process.execPath, [
    cliEntrypoint,
    "start-task",
    "--task-id",
    "task-cancel-review",
  ], {
    cwd: workspaceRoot,
    env: runtimeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });

  const databasePath = createInitPlan(workspaceRoot).databasePath;
  const reviewDeadline = Date.now() + 10_000;
  let reviewStarted = false;
  while (Date.now() < reviewDeadline && !reviewStarted) {
    const probe = createLifecycleSqliteStore({
      databasePath,
      readonly: true,
    });
    try {
      const [attempt] = await probe.attempts.listByTask("task-cancel-review");
      if (attempt) {
        const reviewStep = await probe.attempts.step({
          attemptId: attempt.id,
          stage: "REVIEWED",
        });
        reviewStarted = reviewStep?.status === "STARTED";
      }
    } finally {
      probe.close();
    }
    if (!reviewStarted) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.equal(reviewStarted, true, `fresh review did not start\n${stderr}`);
  assert.equal(child.kill("SIGTERM"), true);
  let closeTimeout;
  const exit = await Promise.race([
    new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    new Promise((_, reject) => {
      closeTimeout = setTimeout(
        () => reject(new Error(`cancelled CLI did not exit\n${stdout}\n${stderr}`)),
        10_000,
      );
      closeTimeout.unref?.();
    }),
  ]);
  clearTimeout(closeTimeout);
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0, stderr);
  const output = JSON.parse(stdout);
  assert.equal(output.lifecycle.stage, "CANCELLED");
  assert.equal(output.lifecycle.canonical_verdict, null);
  assert.equal(
    output.lifecycle.state.terminal.reason,
    "fresh LLM review was cancelled",
  );

  const lifecycleStore = createLifecycleSqliteStore({
    databasePath,
    readonly: true,
  });
  try {
    const attempts = await lifecycleStore.attempts.listByTask("task-cancel-review");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].stage, "CANCELLED");
    const queueEntry = await lifecycleStore.queue.byTask("task-cancel-review");
    assert.equal(queueEntry.state, "CANCELLED");
    assert.equal(queueEntry.payload.attempt_id, attempts[0].id);
  } finally {
    lifecycleStore.close();
  }
  const reviewBranches = spawnSync("git", [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/niis/task/",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(reviewBranches.status, 0, reviewBranches.stderr);
  assert.equal(reviewBranches.stdout.trim(), "");
});

test("niis upgrade-plan returns a read-only migration preflight without mutating install-state", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync("node", [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(initResult.status, 0);

  const installStatePath = path.join(workspaceRoot, ".niis", "install-state.json");
  const installState = JSON.parse(fs.readFileSync(installStatePath, "utf8"));
  const installStateBefore = fs.readFileSync(installStatePath, "utf8");
  const specPath = path.join(workspaceRoot, "upgrade-plan-spec.json");

  writeJson(specPath, {
    installStatePath,
    packageRoot: installState.package_root,
    releaseBundle: {
      bundleId: "bundle-core-0.2.0",
      compatibility: {
        min_niis_version: "0.1.0",
        required_adapters: [],
      },
      fileRefs: ["package.json"],
      migrationRefs: ["migrations/0002.sql"],
      packageId: "@niis/core",
      version: "0.2.0",
    },
    storageTargetBackend: {
      backendId: "hosted-preview",
      displayName: "Hosted Preview",
      kind: "hosted_service",
      migrationCapabilities: {
        snapshotImport: true,
      },
      supportedSchemaVersions: ["2"],
    },
  });

  const result = spawnSync("node", [cliEntrypoint, "upgrade-plan", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.compatibility_status, "migration_required");
  assert.equal(output.readonly_preflight, true);
  assert.equal(output.storage_plan.compatibility_status, "migration_required");
  assert.equal(output.blocked_by.length, 0);
  assert.equal(fs.readFileSync(installStatePath, "utf8"), installStateBefore);
});

test("niis activate supports compatibility-checked manifest activation for role, agent, adapter, and validator packages", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);

  for (const type of ["role", "agent", "adapter", "validator"]) {
    const specPath = path.join(workspaceRoot, `activate-${type}.json`);
    writeJson(specPath, {
      availableAdapters: ["cursor-bridge"],
      packageManifest: {
        activation_status: "REVIEW",
        capabilities: ["review"],
        compatibility: {
          max_niis_version: null,
          min_niis_version: "0.1.0",
          required_adapters: type === "adapter" ? [] : ["cursor-bridge"],
        },
        id: `cli-${type}`,
        name: `CLI ${type}`,
        schema_version: "1.0.0",
        type,
        version: "0.1.0",
      },
      securityScanSurfaces: [{
        content: "Reviewed onboarding content only.",
        hooks: [],
        id: `surface:${type}`,
        type: "workflow",
      }],
    });

    const result = spawnSync("node", [cliEntrypoint, "activate", specPath], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0);

    const output = JSON.parse(result.stdout);

    assert.equal(output.allowed, true);
    assert.equal(output.package_manifest.type, type);
    assert.equal(output.package_manifest.activation_status, "ACTIVE");
    assert.equal(output.compatibility_evaluation.compatible, true);
  }
});

test("niis route selects cursor_bridge as a declared compatibility path", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "route-cursor-bridge.json");

  writeJson(specPath, {
    adapters: [{
      args: [cursorBridgeFixtureServerPath],
      capabilities: {
        toolFamilies: ["cursor_bridge", "shell"],
      },
      command: process.execPath,
      defaultToolName: "echo",
      id: "cursor-bridge-adapter",
      protocolType: "cursor_bridge",
    }],
    referenceBundle: {
      guides: [],
      targetPaths: [],
    },
    roleManifests: [{
      adapter_requirements: {
        operations: ["execute"],
        protocolTypes: ["cursor_bridge"],
      },
      id: "cursor-compatible-role",
      lane: "cursor",
      safe_fallback: true,
      toolFamilies: ["cursor_bridge", "shell"],
    }],
    task: {
      id: "route-cursor-task",
      priority: "medium",
      title: "Use declared cursor bridge compatibility path",
    },
  });

  const result = spawnSync("node", [cliEntrypoint, "route", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.selected_adapter.id, "cursor-bridge-adapter");
  assert.equal(output.selected_adapter.protocol_type, "cursor_bridge");
});

test("niis route supports codex_local and claude_code_local as first-class local runtimes", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "route-local-runtimes.json");

  writeJson(specPath, {
    adapters: [
      {
        args: [localRuntimeFixturePath, "--runtime", "claude_code_local"],
        capabilities: {
          toolFamilies: ["shell", "local_cli", "claude_code_local"],
        },
        command: process.execPath,
        id: "claude_code_local",
        protocolType: "local_cli",
      },
      {
        args: [localRuntimeFixturePath, "--runtime", "codex_local"],
        capabilities: {
          toolFamilies: ["shell", "local_cli", "codex_local"],
        },
        command: process.execPath,
        id: "codex_local",
        protocolType: "local_cli",
      },
    ],
    referenceBundle: {
      guides: [],
      targetPaths: [],
    },
    roleManifests: [{
      adapter_requirements: {
        operations: ["execute"],
        protocolTypes: ["local_cli"],
        toolFamilies: ["shell", "local_cli", "codex_local"],
      },
      id: "codex-role",
      lane: "generalist",
      safe_fallback: true,
      toolFamilies: ["shell"],
    }],
    task: {
      id: "route-local-runtime-task",
      priority: "medium",
      title: "Use first-class codex local runtime",
    },
  });

  const result = spawnSync("node", [cliEntrypoint, "route", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.selected_adapter.id, "codex_local");
  assert.equal(output.selected_adapter.protocol_type, "local_cli");
  assert.equal(output.selected_adapter.capabilities.adapter_kind, "codex_local");
});

test("niis ui renders scoped dashboard HTML to an output file", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "ui-spec.json");
  const outputPath = path.join(workspaceRoot, "dashboard.html");

  writeJson(specPath, {
    filters: {
      statuses: ["BLOCKED"],
    },
    outputPath,
    snapshot: {
      assignments: [
        {
          agent_id: "agent-ui",
          assigned_at: "2026-04-05T09:06:00.000Z",
          context: "The UI-capable agent was selected for the dashboard slice.",
          id: "assignment-ui",
          policy_ref: "policy.route.ui",
          reason_type: "manual",
          task_id: "task-release",
        },
      ],
      blockers: [
        {
          blocker_class: "MISSING_APPROVAL",
          created_at: "2026-04-05T09:10:00.000Z",
          id: "blocker-approval",
          next_action: "Grant release approval.",
          reason: "Release approval is required before deploy.",
          resolved_at: null,
          task_id: "task-release",
        },
      ],
      events: [
        {
          actor: "runtime",
          event_type: "STATE_CHANGE",
          id: "event-ui",
          payload: {
            from_status: "IN_PROGRESS",
            to_status: "BLOCKED",
          },
          run_id: "run-ui",
          task_id: "task-release",
          timestamp: "2026-04-05T09:09:00.000Z",
        },
      ],
      explainability: [
        {
          alternatives_considered: [],
          decision_type: "APPROVAL",
          evidence_refs: [],
          human_readable_summary: "The release is blocked until operator approval is granted.",
          id: "decision-ui",
          policy_refs: ["policy.approval.release"],
          route_chosen: "await_operator_approval",
          task_id: "task-release",
          timestamp: "2026-04-05T09:07:00.000Z",
        },
      ],
      runs: [
        {
          adapter_id: "codex_local",
          agent_id: "agent-ui",
          checkpoint_id: null,
          cost: {
            duration_ms: 3400,
            estimated_usd: 0.31,
            tokens_in: 100,
            tokens_out: 80,
          },
          exit_code: 0,
          finished_at: "2026-04-05T09:08:00.000Z",
          id: "run-ui",
          invocation_source: "on_demand",
          run_log: {
            bytes: 128,
            ref: null,
            sha256: "deadbeef",
            storage: "inline",
          },
          started_at: "2026-04-05T09:05:00.000Z",
          status: "COMPLETED",
          subtask_id: null,
          task_id: "task-release",
          task_session_key: null,
        },
      ],
      tasks: [
        {
          assigned_to: null,
          created_at: "2026-04-05T08:00:00.000Z",
          depends_on: [],
          goal_id: null,
          id: "task-release",
          max_rejections: 5,
          out_of_scope: [],
          phase: 10,
          priority: "high",
          rejection_count: 0,
          status: "BLOCKED",
          title: "Release local dashboard",
          transition_log: [],
          updated_at: "2026-04-05T09:00:00.000Z",
        },
        {
          assigned_to: null,
          created_at: "2026-04-05T07:00:00.000Z",
          depends_on: [],
          goal_id: null,
          id: "task-query",
          max_rejections: 5,
          out_of_scope: [],
          phase: 10,
          priority: "medium",
          rejection_count: 0,
          status: "PENDING",
          title: "Inspect query substrate",
          transition_log: [],
          updated_at: "2026-04-05T08:30:00.000Z",
        },
      ],
    },
    title: "CLI Dashboard",
  });

  const result = spawnSync("node", [cliEntrypoint, "ui", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Wrote local dashboard HTML to/);

  const html = fs.readFileSync(outputPath, "utf8");

  assert.match(html, /CLI Dashboard/);
  assert.match(html, /Scope/);
  assert.match(html, /Task Navigation/);
  assert.match(html, /Release local dashboard/);
  assert.doesNotMatch(html, /Inspect query substrate/);
  assert.match(html, /data-task-detail="true"/);
});

test("niis ui --open writes the default dashboard file and records a viewer launch", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "ui-open-spec.json");
  const launchRecordPath = path.join(workspaceRoot, "ui-open-record.txt");
  const expectedOutputPath = path.join(workspaceRoot, ".niis", "ui", "dashboard.html");

  writeJson(specPath, {
    snapshot: {
      explainability: [
        {
          alternatives_considered: [],
          decision_type: "ROUTE",
          evidence_refs: ["run-release"],
          human_readable_summary: "Selected the local route for the served release task.",
          id: "decision-release-run",
          policy_refs: ["routing/coordinator/v1"],
          route_chosen: "generalist/codex_local",
          task_id: "task-release",
          timestamp: "2026-04-05T09:02:00.000Z",
        },
      ],
      events: [
        {
          actor: "runtime",
          event_type: "STATE_CHANGE",
          id: "event-release-workspace",
          payload: {
            lifecycle_phase: "workspace_preparation",
            phase_status: "completed",
            summary: "Workspace prepared for served release task.",
          },
          run_id: "run-release",
          task_id: "task-release",
          timestamp: "2026-04-05T09:03:00.000Z",
        },
      ],
      runLogs: [
        {
          raw_output: {
            status: "SUCCESS",
            summary: "Served release run completed.",
          },
          raw_output_kind: "json",
          raw_output_ref: null,
          run_id: "run-release",
          run_log: {
            bytes: 96,
            ref: null,
            sha256: "runrelease123",
            storage: "inline",
          },
        },
      ],
      runs: [
        {
          adapter_id: "codex_local",
          agent_id: "agent-ui",
          checkpoint_id: null,
          cost: {
            duration_ms: 1200,
            estimated_usd: 0.12,
            tokens_in: 10,
            tokens_out: 20,
          },
          exit_code: 0,
          finished_at: "2026-04-05T09:05:00.000Z",
          id: "run-release",
          invocation_source: "on_demand",
          run_log: {
            bytes: 96,
            ref: null,
            sha256: "runrelease123",
            storage: "inline",
          },
          started_at: "2026-04-05T09:03:00.000Z",
          status: "COMPLETED",
          subtask_id: null,
          task_id: "task-release",
          task_session_key: null,
        },
      ],
      blockers: [
        {
          blocker_class: "MISSING_APPROVAL",
          created_at: "2026-04-05T09:10:00.000Z",
          id: "blocker-approval",
          next_action: "Grant release approval.",
          reason: "Release approval is required before deploy.",
          resolved_at: null,
          task_id: "task-release",
        },
      ],
      tasks: [
        {
          assigned_to: null,
          created_at: "2026-04-05T08:00:00.000Z",
          depends_on: [],
          goal_id: null,
          id: "task-release",
          max_rejections: 5,
          out_of_scope: [],
          phase: 10,
          priority: "high",
          rejection_count: 0,
          status: "BLOCKED",
          title: "Release local dashboard",
          transition_log: [],
          updated_at: "2026-04-05T09:00:00.000Z",
        },
      ],
    },
    title: "Open Dashboard",
  });

  const result = spawnSync("node", [cliEntrypoint, "ui", specPath, "--open"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIIS_UI_OPEN_RECORD_PATH: launchRecordPath,
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Wrote local dashboard HTML to/);
  assert.match(result.stdout, /Opened local dashboard viewer via record-only/);
  assert.equal(
    fs.realpathSync(fs.readFileSync(launchRecordPath, "utf8").trim()),
    fs.realpathSync(expectedOutputPath),
  );

  const html = fs.readFileSync(expectedOutputPath, "utf8");

  assert.match(html, /Open Dashboard/);
  assert.match(html, /Release local dashboard/);
});

test("niis ui --serve hosts the local control plane over HTTP routes", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "ui-serve-spec.json");
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  writeJson(specPath, {
    snapshot: {
      blockers: [
        {
          blocker_class: "MISSING_APPROVAL",
          created_at: "2026-04-05T09:10:00.000Z",
          id: "blocker-approval",
          next_action: "Grant release approval.",
          reason: "Release approval is required before deploy.",
          resolved_at: null,
          task_id: "task-release",
        },
      ],
      tasks: [
        {
          assigned_to: null,
          created_at: "2026-04-05T08:00:00.000Z",
          depends_on: [],
          goal_id: null,
          id: "task-release",
          max_rejections: 5,
          out_of_scope: [],
          phase: 10,
          priority: "high",
          rejection_count: 0,
          status: "BLOCKED",
          title: "Serve local dashboard",
          transition_log: [],
          updated_at: "2026-04-05T09:00:00.000Z",
        },
      ],
    },
    title: "Served Control Plane",
  });

  const child = spawnUiTestServer(
    [cliEntrypoint, "ui", specPath, "--serve", "--host", "127.0.0.1", "--port", "0"],
    workspaceRoot,
  );

  t.after(async () => {
    await stopChildProcess(child);
  });

  let ready;

  try {
    ready = await waitForChildStdoutMatch(child, /Serving local control plane at (http:\/\/[^\s]+)/);
  } catch (error) {
    if (String(error.message).includes("listen EPERM")) {
      t.skip("sandbox blocks local TCP listen in this environment");
      return;
    }

    throw error;
  }

  const url = ready.match[1];
  const uiClient = await createUiTestClient(url);

  const homeResponse = uiClient.bootstrapResponse;
  assert.equal(homeResponse.status, 200);

  const html = await homeResponse.text();
  assert.match(html, /Served Control Plane|Niis Local Control Plane/);
  assert.match(html, /Task Inbox/);
  const contentSecurityPolicy = homeResponse.headers.get("content-security-policy");
  const nonce = contentSecurityPolicy.match(/script-src 'self' 'nonce-([A-Za-z0-9_-]+)'/u)?.[1];
  assert.ok(nonce);
  assert.doesNotMatch(contentSecurityPolicy, /script-src[^;]*'unsafe-inline'/u);
  assert.match(html, new RegExp(`<script nonce="${nonce}"`, "u"));
  assert.doesNotMatch(html, /\son[a-z]+=/iu);

  const reflectedPayload = `" autofocus onfocus="alert(document.domain)`;
  const logsResponse = await uiClient.fetch(new URL(`/__niis/logs?task_id=${encodeURIComponent(reflectedPayload)}`, url));
  assert.equal(logsResponse.status, 200);
  const logsHtml = await logsResponse.text();
  assert.match(logsHtml, /value="&quot; autofocus onfocus=&quot;alert\(document\.domain\)"/u);
  assert.doesNotMatch(logsHtml, /value=""\s+autofocus\s+onfocus=/u);

  const tasksResponse = await uiClient.fetch(new URL("/tasks", url));
  assert.equal(tasksResponse.status, 200);
  assert.match(await tasksResponse.text(), /Task Inbox/);

  const taskDetailResponse = await uiClient.fetch(new URL("/tasks/task-release", url));
  assert.equal(taskDetailResponse.status, 200);
  assert.match(await taskDetailResponse.text(), /Serve local dashboard|Overview|Task Workbench/);

  const approvalsResponse = await uiClient.fetch(new URL("/approvals", url));
  assert.equal(approvalsResponse.status, 200);
  assert.match(await approvalsResponse.text(), /Operator Decisions/);

  const runDetailResponse = await uiClient.fetch(new URL("/runs/run-release", url));
  assert.equal(runDetailResponse.status, 200);
  assert.match(await runDetailResponse.text(), /Run Detail/);

  for (const [pathname, expectedText] of [
    ["/pipeline", /Pipeline|Agent Task Flow/u],
    ["/agents", /Manage Agents/u],
    ["/project", /Project information/u],
  ]) {
    const pageResponse = await uiClient.fetch(new URL(pathname, url));
    assert.equal(pageResponse.status, 200);
    const pageHtml = await pageResponse.text();
    const pageNonce = pageResponse.headers.get("content-security-policy")
      .match(/script-src 'self' 'nonce-([A-Za-z0-9_-]+)'/u)?.[1];
    assert.ok(pageNonce);
    assert.match(pageHtml, expectedText);
    assert.doesNotMatch(pageHtml, /<script(?! nonce=)/u);
  }

  const healthResponse = await uiClient.fetch(new URL("/health", url));
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    ok: true,
    surface: "niis_ui",
  });

  for (const pathname of [
    "/__niis/project-file/project-profile/render-html",
    "/__niis/run-fix",
  ]) {
    const mutationResponse = await uiClient.fetch(new URL(pathname, url), {
      body: new URLSearchParams({ action: "init" }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(mutationResponse.status, 403);
    assert.match(
      (await mutationResponse.json()).error,
      /immutable snapshot mode/u,
    );
  }

});

test("niis ui --serve starts without a terminal and prints the bootstrap URL", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initialized = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const child = spawn(process.execPath, [
    cliEntrypoint,
    "ui",
    "--serve",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
  ], {
    cwd: workspaceRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    await stopChildProcess(child);
  });

  let ready;
  try {
    ready = await waitForChildStdoutMatch(
      child,
      /Open this one-time operator URL:\n(http:\/\/[^\s]+token=[^\s]+)/u,
    );
  } catch (error) {
    if (String(error.message).includes("listen EPERM")) {
      t.skip("sandbox blocks local TCP listen in this environment");
      return;
    }
    throw error;
  }

  const bootstrapUrl = new URL(ready.match[1]);
  assert.equal(bootstrapUrl.hostname, "127.0.0.1");
  assert.ok(bootstrapUrl.searchParams.get("token"));
});

test("niis ui --serve renders attached project overview from local onboarding artifacts", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);

  fs.writeFileSync(path.join(workspaceRoot, "package.json"), `${JSON.stringify({
    dependencies: {
      react: "^18.3.1",
      vite: "^5.0.0",
    },
    type: "module",
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(workspaceRoot, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      module: "esnext",
    },
  }, null, 2)}\n`);
  fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "src", "app.tsx"), "export const App = () => null;\n");
  fs.writeFileSync(path.join(workspaceRoot, ".env"), "TOKEN=must-not-read\n");

  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(initResult.status, 0);

  const attachResult = spawnSync(process.execPath, [cliEntrypoint, "attach"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(attachResult.status, 0);

  const child = spawnUiTestServer(
    [cliEntrypoint, "ui", "--serve", "--host", "127.0.0.1", "--port", "0"],
    workspaceRoot,
  );

  t.after(async () => {
    await stopChildProcess(child);
  });

  let ready;

  try {
    ready = await waitForChildStdoutMatch(child, /Serving local control plane at (http:\/\/[^\s]+)/);
  } catch (error) {
    if (String(error.message).includes("listen EPERM")) {
      t.skip("sandbox blocks local TCP listen in this environment");
      return;
    }

    throw error;
  }

  const url = ready.match[1];
  const uiClient = await createUiTestClient(url);
  const projectResponse = await uiClient.fetch(new URL("/project", url));

  assert.equal(projectResponse.status, 200);

  const html = await projectResponse.text();
  assert.match(html, /Project information/);


  assert.match(html, /Project artifacts/i);
  assert.match(html, /project-profile\.md/);
  assert.match(html, /workflow\.md/);
  assert.match(html, /codemap\.json/);
  assert.match(html, /attached-repository\.json/);
  assert.match(html, /task-sources\.json/);
  assert.match(html, /bootstrap-pack\.json/);
  assert.match(html, /install-state\.json/);

  assert.match(html, /Runtime availability/i);
  assert.match(html, /Doctor/i);



  const profileResponse = await uiClient.fetch(new URL("/__niis/project-file/project-profile", url));
  assert.equal(profileResponse.status, 200);
  const profilePayload = await profileResponse.json();
  assert.match(profilePayload.content, /react/i);
  assert.match(profilePayload.content, /typescript/i);

  const workflowResponse = await uiClient.fetch(new URL("/__niis/project-file/workflow", url));
  const workflowPayload = await workflowResponse.json();
  assert.match(workflowPayload.content, /worktree/i);

  const sourceResponse = await uiClient.fetch(new URL(
    "/__niis/source-file?id=codemap&path=src%2Fapp.tsx&raw=1",
    url,
  ));
  assert.equal(sourceResponse.status, 200);
  assert.match(await sourceResponse.text(), /export const App/);

  for (const sourcePath of [".env", ".niis/secrets/master.key"]) {
    const hiddenResponse = await uiClient.fetch(new URL(
      `/__niis/source-file?id=codemap&path=${encodeURIComponent(sourcePath)}&raw=1`,
      url,
    ));
    assert.equal(hiddenResponse.status, 403);
    assert.doesNotMatch(await hiddenResponse.text(), /must-not-read/);
  }

  fs.writeFileSync(path.join(workspaceRoot, "src", "after-attach.txt"), "must-not-read\n");
  const unindexedResponse = await uiClient.fetch(new URL(
    "/__niis/source-file?id=codemap&path=src%2Fafter-attach.txt&raw=1",
    url,
  ));
  assert.equal(unindexedResponse.status, 403);
  assert.doesNotMatch(await unindexedResponse.text(), /must-not-read/);
});

test("niis ui --serve can create, start, and annotate tasks through the local control plane", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const binDir = path.join(workspaceRoot, "bin");
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(initResult.status, 0);
  createFakeCodexBinary(binDir, {
    executionSummary: "Changed parser source mode and verified focused checks.",
  });

  const child = spawnUiTestServer(
    [cliEntrypoint, "ui", "--serve", "--host", "127.0.0.1", "--port", "0"],
    workspaceRoot,
    {
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  );

  t.after(async () => {
    await stopChildProcess(child);
  });

  let ready;

  try {
    ready = await waitForChildStdoutMatch(child, /Serving local control plane at (http:\/\/[^\s]+)/);
  } catch (error) {
    if (String(error.message).includes("listen EPERM")) {
      t.skip("sandbox blocks local TCP listen in this environment");
      return;
    }

    throw error;
  }

  const url = ready.match[1];
  const uiClient = await createUiTestClient(url);

  for (const route of [
    "/tasks/task-release/task-branch/merge",
    "/tasks/task-release/task-branch/discard",
    "/tasks/task-release/task-branch/pr",
    "/tasks/task-release/subtasks/subtask-a/merge",
    "/tasks/task-release/subtasks/subtask-a/discard",
    "/tasks/task-release/subtasks/subtask-a/pr",
  ]) {
    const retiredBranchResponse = await uiClient.fetch(new URL(route, url), {
      body: new URLSearchParams(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(retiredBranchResponse.status, 410, route);
    assert.match(await retiredBranchResponse.text(), /Legacy branch mutation route retired/u);
  }

  const createResponse = await uiClient.fetch(new URL("/tasks/new", url), {
    body: new URLSearchParams({
      intent: "create",
      prompt: "Add parser target source toggle.",
      title: "Parser source toggle",
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "manual",
  });

  assert.equal(createResponse.status, 303);

  const taskLocation = createResponse.headers.get("location");
  assert.match(taskLocation, /^\/tasks\/[^?]+\?notice=/);
  assert.match(taskLocation, /unplanned/i);

  const taskIdMatch = taskLocation.match(/\/tasks\/([^?]+)/);
  assert.ok(taskIdMatch);
  const taskId = decodeURIComponent(taskIdMatch[1]);

  const taskUrl = new URL(taskLocation, url);
  const taskPage = await uiClient.fetch(taskUrl);

  assert.equal(taskPage.status, 200);

  const taskHtml = await taskPage.text();

  assert.match(taskHtml, /Overview/);
  assert.match(taskHtml, /Parser source toggle/);
  assert.match(taskHtml, /status.*unplanned/i);

  const statusChangeResponse = await uiClient.fetch(new URL(`/tasks/${encodeURIComponent(taskId)}/actions/start`, url), {
    body: new URLSearchParams(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "manual",
  });

  assert.equal(statusChangeResponse.status, 303);
  const statusLocation = statusChangeResponse.headers.get("location");
  assert.match(statusLocation, /notice=/);
  assert.match(statusLocation, /Planning/i);

  const noteResponse = await uiClient.fetch(new URL(`/tasks/${encodeURIComponent(taskId)}/notes`, url), {
    body: new URLSearchParams({
      content: "Operator note from served UI.",
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "manual",
  });

  assert.equal(noteResponse.status, 303);

  let task = null;
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const sqliteStorage = createSqliteStorage({
      databasePath: createInitPlan(workspaceRoot).databasePath,
      readonly: true,
    });
    try {
      const tasks = await sqliteStorage.tasks.list();
      task = tasks.find((t) => t.id === taskId);
      if (task && task.status !== "PLANNING") {
        break;
      }
    } finally {
      sqliteStorage.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.ok(task, "Task should exist");
  assert.equal(task.status, "PENDING");

  const noteStorage = createSqliteStorage({
    databasePath: createInitPlan(workspaceRoot).databasePath,
    readonly: true,
  });
  try {
    assert.equal((await noteStorage.taskNotes.byTask(taskId)).length, 2);
  } finally {
    noteStorage.close();
  }

  assert.ok(task.transition_log.length >= 2, "Should have transition log entries for status changes");
  const transitionToPlanning = task.transition_log.find((t) => t.to_status === "PLANNING");
  assert.ok(transitionToPlanning, "Should have transition to PLANNING");
  assert.equal(transitionToPlanning.from_status, "UNPLANNED");
  const transitionToPending = task.transition_log.find((t) => t.to_status === "PENDING" && t.from_status === "PLANNING");
  assert.ok(transitionToPending, "Should have transition from PLANNING to PENDING");
});

test("niis ui --serve transitions task to BLOCKED when planner fails", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const binDir = path.join(workspaceRoot, "bin");
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(initResult.status, 0);
  createFailingPlannerBinary(binDir);

  const child = spawnUiTestServer(
    [cliEntrypoint, "ui", "--serve", "--host", "127.0.0.1", "--port", "0"],
    workspaceRoot,
    {
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  );

  t.after(async () => {
    await stopChildProcess(child);
  });

  let ready;

  try {
    ready = await waitForChildStdoutMatch(child, /Serving local control plane at (http:\/\/[^\s]+)/);
  } catch (error) {
    if (String(error.message).includes("listen EPERM")) {
      t.skip("sandbox blocks local TCP listen in this environment");
      return;
    }

    throw error;
  }

  const url = ready.match[1];
  const uiClient = await createUiTestClient(url);
  const createResponse = await uiClient.fetch(new URL("/tasks/new", url), {
    body: new URLSearchParams({
      intent: "create",
      prompt: "Task that will fail planning.",
      title: "Failing planner task",
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "manual",
  });

  assert.equal(createResponse.status, 303);

  const taskLocation = createResponse.headers.get("location");
  const taskIdMatch = taskLocation.match(/\/tasks\/([^?]+)/);
  assert.ok(taskIdMatch);
  const taskId = decodeURIComponent(taskIdMatch[1]);

  const statusChangeResponse = await uiClient.fetch(new URL(`/tasks/${encodeURIComponent(taskId)}/actions/start`, url), {
    body: new URLSearchParams(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "manual",
  });

  assert.equal(statusChangeResponse.status, 303);
  const statusLocation = statusChangeResponse.headers.get("location");
  assert.match(statusLocation, /notice=/);

  assert.match(statusLocation, /Planning.started/i);


  let task = null;
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const sqliteStorage = createSqliteStorage({
      databasePath: createInitPlan(workspaceRoot).databasePath,
      readonly: true,
    });
    try {
      const tasks = await sqliteStorage.tasks.list();
      task = tasks.find((t) => t.id === taskId);
      if (task && task.status !== "PLANNING") {
        break;
      }
    } finally {
      sqliteStorage.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.ok(task, "Task should exist");
  assert.equal(task.status, "BLOCKED", "Task should be BLOCKED after planner failure");
  assert.ok(task.transition_log.length >= 2, "Should have transition log entries for status changes");
  const transitionToPlanning = task.transition_log.find((t) => t.to_status === "PLANNING");
  assert.ok(transitionToPlanning, "Should have transition to PLANNING");
  assert.equal(transitionToPlanning.from_status, "UNPLANNED");
  const transitionToBlocked = task.transition_log.find((t) => t.to_status === "BLOCKED" && t.from_status === "PLANNING");
  assert.ok(transitionToBlocked, "Should have transition from PLANNING to BLOCKED");
  assert.match(transitionToBlocked.reason, /Planning failed/i);
});

test("niis ui --serve shows PLANNING lifecycle message while planner runs", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const binDir = path.join(workspaceRoot, "bin");
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(initResult.status, 0);

  const slowScriptPath = path.join(binDir, "codex");
  writeExecutable(slowScriptPath, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli test");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  setTimeout(() => {
    const payload = JSON.stringify({
      title: "Slow planner title",
      summary: "Slow planner summary",
      target_paths: ["src/example.js"],
      operator_guidance: [],
      acceptance_checks: [],
      out_of_scope: [],
      priority: "medium",
      phase: 0,
      subtasks: [{ title: "Step 1" }],
    });
    process.stdout.write(payload);
  }, 5000);
});
`);

  const child = spawnUiTestServer(
    [cliEntrypoint, "ui", "--serve", "--host", "127.0.0.1", "--port", "0"],
    workspaceRoot,
    {
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  );

  t.after(async () => {
    await stopChildProcess(child);
  });

  let ready;

  try {
    ready = await waitForChildStdoutMatch(child, /Serving local control plane at (http:\/\/[^\s]+)/);
  } catch (error) {
    if (String(error.message).includes("listen EPERM")) {
      t.skip("sandbox blocks local TCP listen in this environment");
      return;
    }

    throw error;
  }

  const url = ready.match[1];
  const uiClient = await createUiTestClient(url);
  const createResponse = await uiClient.fetch(new URL("/tasks/new", url), {
    body: new URLSearchParams({
      intent: "create",
      prompt: "Task for planning visibility test.",
      title: "Planning visibility test",
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });

  assert.equal(createResponse.status, 303);
  const taskLocation = createResponse.headers.get("location");
  const taskIdMatch = taskLocation.match(/\/tasks\/([^?]+)/);
  assert.ok(taskIdMatch);
  const taskId = decodeURIComponent(taskIdMatch[1]);

  const statusChangeResponse = await uiClient.fetch(new URL(`/tasks/${encodeURIComponent(taskId)}/actions/start`, url), {
    body: new URLSearchParams(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });

  assert.equal(statusChangeResponse.status, 303);
  const statusLocation = statusChangeResponse.headers.get("location");
  assert.match(statusLocation, /Planning.started/i);


  const taskPageResponse = await uiClient.fetch(new URL(`/tasks/${encodeURIComponent(taskId)}`, url));
  assert.equal(taskPageResponse.status, 200);
  const html = await taskPageResponse.text();

  assert.match(html, /data-current-status="PLANNING"/, "status dropdown should show PLANNING");
  assert.match(html, /Decomposing task, defining acceptance criteria and target paths/, "lifecycle should show active planning message");
  assert.doesNotMatch(html, /Waiting for planning to begin/, "should not show the idle planning message");
});

test("niis ui --serve creates a task directly without preview step", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const binDir = path.join(workspaceRoot, "bin");
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(initResult.status, 0);
  createFakeCodexBinary(binDir);

  const child = spawnUiTestServer(
    [cliEntrypoint, "ui", "--serve", "--host", "127.0.0.1", "--port", "0"],
    workspaceRoot,
    {
      NIIS_CLAUDE_CODE_LOCAL_BIN: "",
      NIIS_CODEX_LOCAL_BIN: undefined,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  );

  t.after(async () => {
    await stopChildProcess(child);
  });

  let ready;

  try {
    ready = await waitForChildStdoutMatch(child, /Serving local control plane at (http:\/\/[^\s]+)/);
  } catch (error) {
    if (String(error.message).includes("listen EPERM")) {
      t.skip("sandbox blocks local TCP listen in this environment");
      return;
    }

    throw error;
  }

  const url = ready.match[1];
  const uiClient = await createUiTestClient(url);
  const createResponse = await uiClient.fetch(new URL("/tasks/new", url), {
    body: new URLSearchParams({
      intent: "create",
      prompt: "Create without preview.",
      title: "No preview task",
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "manual",
  });

  assert.equal(createResponse.status, 303);
  assert.match(createResponse.headers.get("location"), /\/tasks\/[^?]+\?notice=/);
  assert.doesNotMatch(createResponse.headers.get("location"), /error=/);
});

test("niis ui --serve retires arbitrary approval mutation", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(initResult.status, 0);

  const sqliteStorage = createSqliteStorage({
    databasePath: createInitPlan(workspaceRoot).databasePath,
  });

  await seedStorage(sqliteStorage, {
    blockers: [{
      blocker_class: "MISSING_APPROVAL",
      created_at: "2026-04-08T11:30:00.000Z",
      id: "blocker-release-approval",
      next_action: "Grant operator approval from the control plane.",
      reason: "Release approval is required.",
      resolved_at: null,
      task_id: "task-release-approval",
    }],
    tasks: [{
      assigned_to: null,
      created_at: "2026-04-08T11:25:00.000Z",
      depends_on: [],
      goal_id: null,
      id: "task-release-approval",
      max_rejections: 5,
      out_of_scope: [],
      phase: 11,
      priority: "high",
      rejection_count: 0,
      status: "BLOCKED",
      title: "Approve release rollout",
      transition_log: [],
      updated_at: "2026-04-08T11:30:00.000Z",
    }],
  });
  sqliteStorage.close();

  const child = spawnUiTestServer(
    [cliEntrypoint, "ui", "--serve", "--host", "127.0.0.1", "--port", "0"],
    workspaceRoot,
  );

  t.after(async () => {
    await stopChildProcess(child);
  });

  let ready;

  try {
    ready = await waitForChildStdoutMatch(child, /Serving local control plane at (http:\/\/[^\s]+)/);
  } catch (error) {
    if (String(error.message).includes("listen EPERM")) {
      t.skip("sandbox blocks local TCP listen in this environment");
      return;
    }

    throw error;
  }

  const url = ready.match[1];
  const uiClient = await createUiTestClient(url);
  const approvalResponse = await uiClient.fetch(new URL("/approvals/derived%3Ablocker-release-approval", url), {
    body: new URLSearchParams({
      blocker_id: "blocker-release-approval",
      decision: "approve",
      note: "Approved from browser proof.",
      task_id: "task-release-approval",
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "manual",
  });

  assert.equal(approvalResponse.status, 410);
  assert.match(
    (await approvalResponse.json()).error,
    /Direct approval mutation is retired/u,
  );

  const reopenedStorage = createSqliteStorage({
    databasePath: createInitPlan(workspaceRoot).databasePath,
    readonly: true,
  });

  try {
    assert.equal((await reopenedStorage.approvals.byTask("task-release-approval")).length, 0);
    assert.equal((await reopenedStorage.blockers.active()).some((entry) => entry.id === "blocker-release-approval"), true);
    assert.equal((await reopenedStorage.taskNotes.byTask("task-release-approval")).length, 0);
    assert.equal((await reopenedStorage.decisions.explain("task-release-approval")).some((entry) => entry.decision_type === "APPROVAL"), false);
  } finally {
    reopenedStorage.close();
  }
});

test("niis ui --serve keeps governance approvals read-only outside lifecycle actions", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const initResult = spawnSync(process.execPath, [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(initResult.status, 0);

  const sqliteStorage = createSqliteStorage({
    databasePath: createInitPlan(workspaceRoot).databasePath,
  });

  await seedStorage(sqliteStorage, {
    blockers: [{
      blocker_class: "MISSING_APPROVAL",
      created_at: "2026-04-08T11:30:00.000Z",
      id: "blocker-release-approval",
      next_action: "Grant operator approval from the control plane.",
      reason: "Release approval is required.",
      resolved_at: null,
      task_id: "task-release-approval",
    }],
    tasks: [{
      assigned_to: null,
      created_at: "2026-04-08T11:25:00.000Z",
      depends_on: [],
      goal_id: null,
      id: "task-release-approval",
      max_rejections: 5,
      out_of_scope: [],
      phase: 11,
      priority: "high",
      rejection_count: 0,
      status: "BLOCKED",
      title: "Approve release rollout",
      transition_log: [],
      updated_at: "2026-04-08T11:30:00.000Z",
    }],
  });
  sqliteStorage.close();

  const child = spawnUiTestServer(
    [cliEntrypoint, "ui", "--serve", "--host", "127.0.0.1", "--port", "0"],
    workspaceRoot,
  );

  t.after(async () => {
    await stopChildProcess(child);
  });

  let ready;

  try {
    ready = await waitForChildStdoutMatch(child, /Serving local control plane at (http:\/\/[^\s]+)/);
  } catch (error) {
    if (String(error.message).includes("listen EPERM")) {
      t.skip("sandbox blocks local TCP listen in this environment");
      return;
    }

    throw error;
  }

  const url = ready.match[1];
  const uiClient = await createUiTestClient(url);
  const approvalPath = new URL("/approvals/derived%3Ablocker-release-approval", url);

  const deferResponse = await uiClient.fetch(approvalPath, {
    body: new URLSearchParams({
      blocker_id: "blocker-release-approval",
      decision: "defer",
      note: "Need stronger rollout evidence.",
      task_id: "task-release-approval",
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "manual",
  });

  assert.equal(deferResponse.status, 410);

  const approvalsAfterDefer = await uiClient.fetch(new URL("/approvals", url));
  assert.equal(approvalsAfterDefer.status, 200);
  const approvalsAfterDeferHtml = await approvalsAfterDefer.text();
  assert.match(approvalsAfterDeferHtml, /Read-only governance evidence/);
  assert.doesNotMatch(approvalsAfterDeferHtml, /action="\/approvals\//u);

  const rejectResponse = await uiClient.fetch(approvalPath, {
    body: new URLSearchParams({
      blocker_id: "blocker-release-approval",
      decision: "reject",
      note: "Reject until the release evidence is refreshed.",
      task_id: "task-release-approval",
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "manual",
  });

  assert.equal(rejectResponse.status, 410);

  const approvalsAfterReject = await uiClient.fetch(new URL("/approvals", url));
  const approvalsHtml = await approvalsAfterReject.text();
  assert.equal(approvalsAfterReject.status, 200);
  assert.match(approvalsHtml, /Read-only governance evidence/);
  assert.doesNotMatch(approvalsHtml, /Latest governance note: Operator rejected/u);

  const taskViewResponse = await uiClient.fetch(new URL("/tasks/task-release-approval", url));
  const taskViewHtml = await taskViewResponse.text();
  assert.equal(taskViewResponse.status, 200);
  assert.match(taskViewHtml, /Approvals|Blockers/i);
  assert.match(taskViewHtml, /BLOCKED/);
  assert.doesNotMatch(taskViewHtml, /Reject until the release evidence is refreshed\./u);

  const reopenedStorage = createSqliteStorage({
    databasePath: createInitPlan(workspaceRoot).databasePath,
    readonly: true,
  });

  try {
    const approvals = await reopenedStorage.approvals.byTask("task-release-approval");
    const activeBlockers = await reopenedStorage.blockers.active();
    const explainability = await reopenedStorage.decisions.explain("task-release-approval");
    const taskNotes = await reopenedStorage.taskNotes.byTask("task-release-approval");

    assert.equal(approvals.length, 0);
    assert.equal(activeBlockers[0].id, "blocker-release-approval");
    assert.equal(activeBlockers[0].reason, "Release approval is required.");
    assert.equal(activeBlockers[0].next_action, "Grant operator approval from the control plane.");
    assert.equal(taskNotes.length, 0);
    assert.equal(explainability.some((entry) => entry.route_chosen === "approval:deferred"), false);
    assert.equal(explainability.some((entry) => entry.route_chosen === "approval:rejected"), false);
  } finally {
    reopenedStorage.close();
  }
});

test("niis ui renders dashboard HTML from the default SQLite snapshot", async (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const outputPath = path.join(workspaceRoot, "dashboard-from-sqlite.html");
  const initResult = spawnSync("node", [cliEntrypoint, "init"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(initResult.status, 0);

  const plan = createInitPlan(workspaceRoot);
  const sqliteStorage = createSqliteStorage({
    databasePath: plan.databasePath,
  });

  await seedStorage(sqliteStorage, {
    assignments: [{
      agent_id: "agent-ui",
      assigned_at: "2026-04-05T09:06:00.000Z",
      context: "The SQLite-backed dashboard slice was assigned to the UI-capable agent.",
      id: "assignment-sqlite-ui",
      policy_ref: "policy.route.ui",
      reason_type: "manual",
      task_id: "task-release",
    }],
    blockers: [{
      blocker_class: "MISSING_APPROVAL",
      created_at: "2026-04-05T09:10:00.000Z",
      id: "blocker-sqlite-approval",
      next_action: "Grant SQLite release approval.",
      reason: "Release approval is required before deploy.",
      resolved_at: null,
      task_id: "task-release",
    }],
    events: [{
      actor: "runtime",
      event_type: "STATE_CHANGE",
      id: "event-sqlite-ui",
      payload: {
        from_status: "IN_PROGRESS",
        to_status: "BLOCKED",
      },
      run_id: "run-sqlite-ui",
      task_id: "task-release",
      timestamp: "2026-04-05T09:09:00.000Z",
    }],
    explainability: [{
      alternatives_considered: [],
      decision_type: "APPROVAL",
      evidence_refs: [],
      human_readable_summary: "The SQLite-backed release is blocked until operator approval is granted.",
      id: "decision-sqlite-ui",
      policy_refs: ["policy.approval.release"],
      route_chosen: "await_operator_approval",
      task_id: "task-release",
      timestamp: "2026-04-05T09:07:00.000Z",
    }],
    runs: [{
      adapter_id: "codex_local",
      agent_id: "agent-ui",
      checkpoint_id: null,
      cost: {
        duration_ms: 3400,
        estimated_usd: 0.31,
        tokens_in: 100,
        tokens_out: 80,
      },
      exit_code: 0,
      finished_at: "2026-04-05T09:08:00.000Z",
      id: "run-sqlite-ui",
      invocation_source: "on_demand",
      run_log: {
        bytes: 128,
        ref: null,
        sha256: "deadbeef",
        storage: "inline",
      },
      started_at: "2026-04-05T09:05:00.000Z",
      status: "COMPLETED",
      subtask_id: null,
      task_id: "task-release",
      task_session_key: null,
    }],
    tasks: [
      {
        assigned_to: null,
        created_at: "2026-04-05T08:00:00.000Z",
        depends_on: [],
        goal_id: null,
        id: "task-release",
        max_rejections: 5,
        out_of_scope: [],
        phase: 10,
        priority: "high",
        rejection_count: 0,
        status: "BLOCKED",
        title: "Release local dashboard from SQLite",
        transition_log: [],
        updated_at: "2026-04-05T09:00:00.000Z",
      },
      {
        assigned_to: null,
        created_at: "2026-04-05T07:00:00.000Z",
        depends_on: [],
        goal_id: null,
        id: "task-query",
        max_rejections: 5,
        out_of_scope: [],
        phase: 10,
        priority: "medium",
        rejection_count: 0,
        status: "PENDING",
        title: "Inspect query substrate",
        transition_log: [],
        updated_at: "2026-04-05T08:30:00.000Z",
      },
    ],
  });
  sqliteStorage.close();

  const result = spawnSync(
    "node",
    [cliEntrypoint, "ui", "--output", outputPath, "--status", "BLOCKED"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Wrote local dashboard HTML to/);

  const html = fs.readFileSync(outputPath, "utf8");

  assert.match(html, /Release local dashboard from SQLite/);
  assert.match(html, /Task Navigation/);
  assert.match(html, /The SQLite-backed release is blocked until operator approval is granted\./);
  assert.doesNotMatch(html, /Inspect query substrate/);
});

test("niis asset-health reads and filters the derived asset-health report", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const reportPath = path.join(
    workspaceRoot,
    ".niis",
    "proofs",
    "evals",
    "proof-regression-suite.asset-health.json",
  );

  writeJson(reportPath, {
    assets: [
      {
        asset_id: "pkg-review-skill",
        asset_kind: "skill",
        evidence_refs: ["proof-regression-suite:skill-surface-health"],
        failed_scenarios: 0,
        passed_scenarios: 1,
        scenario_refs: [],
        status: "healthy",
      },
      {
        asset_id: "runtime-default-prompt-surface",
        asset_kind: "prompt",
        evidence_refs: ["proof-regression-suite:prompt-surface-health"],
        failed_scenarios: 0,
        passed_scenarios: 1,
        scenario_refs: [],
        status: "healthy",
      },
      {
        asset_id: "cheap-adapter",
        asset_kind: "adapter",
        evidence_refs: ["proof-regression-suite:route-derived-health-assets"],
        failed_scenarios: 0,
        passed_scenarios: 1,
        scenario_refs: [],
        status: "healthy",
      },
    ],
    generated_at: "2026-04-02T14:42:00Z",
    output_path: reportPath,
    source_suite_id: "proof-regression-suite",
    summary: {
      failing: 0,
      healthy: 3,
      total: 3,
      watch: 0,
    },
  });

  const result = spawnSync("node", [cliEntrypoint, "asset-health", "--asset-kind", "skill"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.summary.total, 1);
  assert.equal(output.assets.length, 1);
  assert.equal(output.assets[0].asset_id, "pkg-review-skill");
  assert.equal(output.filters.asset_kind, "skill");
});

test("niis asset-health filters the derived asset-health report for adapters", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const reportPath = path.join(
    workspaceRoot,
    ".niis",
    "proofs",
    "evals",
    "proof-regression-suite.asset-health.json",
  );

  writeJson(reportPath, {
    assets: [
      {
        asset_id: "pkg-review-skill",
        asset_kind: "skill",
        evidence_refs: ["proof-regression-suite:skill-surface-health"],
        failed_scenarios: 0,
        passed_scenarios: 1,
        scenario_refs: [],
        status: "healthy",
      },
      {
        asset_id: "cheap-adapter",
        asset_kind: "adapter",
        evidence_refs: ["proof-regression-suite:route-derived-health-assets"],
        failed_scenarios: 0,
        passed_scenarios: 1,
        scenario_refs: [],
        status: "healthy",
      },
    ],
    generated_at: "2026-04-03T09:09:03Z",
    output_path: reportPath,
    source_suite_id: "proof-regression-suite",
    summary: {
      failing: 0,
      healthy: 2,
      total: 2,
      watch: 0,
    },
  });

  const result = spawnSync("node", [cliEntrypoint, "asset-health", "--asset-kind", "adapter"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.summary.total, 1);
  assert.equal(output.assets.length, 1);
  assert.equal(output.assets[0].asset_id, "cheap-adapter");
  assert.equal(output.filters.asset_kind, "adapter");
});

test("niis discover returns read-only discovery suggestions with taxonomy", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const registryPath = path.join(workspaceRoot, "registry.json");
  const specPath = path.join(workspaceRoot, "discover-spec.json");

  writeJson(registryPath, {
    entries: [{
      candidate_kind: "package",
      display_name: "Workflow Helper",
      package_id: "pkg-workflow-helper",
      source_ref: "registry://workflow-helper",
      version: "0.3.0",
      capabilities: ["review"],
      content: "{\"notes\":\"candidate package\"}",
    }],
  });
  writeJson(specPath, {
    reportId: "cli-discovery-report",
    sources: [{
      kind: "registry",
      registryPath,
    }],
  });

  const result = spawnSync("node", [cliEntrypoint, "discover", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.report_id, "cli-discovery-report");
  assert.equal(output.candidates.length, 1);
  assert.equal(output.candidates[0].suggestion_category, "speculative_idea");
});

test("niis discover filters already reported candidates from prior seeker output", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const firstSpecPath = path.join(workspaceRoot, "discover-first-spec.json");
  const secondSpecPath = path.join(workspaceRoot, "discover-second-spec.json");
  const registryPath = path.join(workspaceRoot, "registry.json");

  writeJson(registryPath, {
    entries: [{
      candidate_kind: "package",
      display_name: "Review Skill Registry Mirror",
      package_id: "pkg-review-skill",
      source_ref: "registry://review-skill",
      version: "0.1.0",
    }],
  });
  writeJson(path.join(workspaceRoot, "packages", "review-skill", "package.json"), {
    name: "@niis/review-skill",
    version: "0.1.0",
    niisManifest: {
      id: "pkg-review-skill",
      name: "Review Skill",
      version: "0.1.0",
      type: "skill",
      capabilities: ["review"],
      compatibility: {
        min_niis_version: "0.1.0",
        max_niis_version: null,
        required_adapters: [],
      },
      activation_status: "INACTIVE",
      schema_version: "1.0.0",
    },
  });
  writeJson(firstSpecPath, {
    reportId: "cli-discovery-first",
    sources: [{
      kind: "local_filesystem",
      rootDirectory: path.join(workspaceRoot, "packages"),
    }],
  });

  const firstResult = spawnSync("node", [cliEntrypoint, "discover", firstSpecPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(firstResult.status, 0);

  const firstOutput = JSON.parse(firstResult.stdout);

  writeJson(secondSpecPath, {
    alreadyReported: firstOutput,
    reportId: "cli-discovery-second",
    sources: [{
      kind: "registry",
      registryPath,
    }],
  });

  const secondResult = spawnSync("node", [cliEntrypoint, "discover", secondSpecPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(secondResult.status, 0);

  const secondOutput = JSON.parse(secondResult.stdout);

  assert.equal(secondOutput.candidates.length, 0);
  assert.equal(secondOutput.duplicates.length, 1);
  assert.equal(
    secondOutput.duplicates[0].canonical_candidate_id,
    firstOutput.candidates[0].candidate_id,
  );
  assert.match(secondOutput.duplicates[0].reason, /already reported/i);
});

test("niis discover-pipeline partitions seeker scopes and emits downstream follow-up subtasks", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const registryPath = path.join(workspaceRoot, "registry.json");
  const specPath = path.join(workspaceRoot, "discover-pipeline-spec.json");

  writeJson(path.join(workspaceRoot, "packages", "alpha", "package.json"), {
    name: "@niis/alpha",
    version: "0.1.0",
    niisManifest: {
      id: "pkg-alpha",
      name: "Alpha",
      version: "0.1.0",
      type: "skill",
      capabilities: ["review"],
      compatibility: {
        min_niis_version: "0.1.0",
        max_niis_version: null,
        required_adapters: [],
      },
      activation_status: "INACTIVE",
      schema_version: "1.0.0",
    },
  });
  writeJson(registryPath, {
    entries: [
      {
        candidate_kind: "package",
        display_name: "Alpha Mirror",
        package_id: "pkg-alpha",
        source_ref: "registry://alpha",
        version: "0.1.0",
      },
      {
        candidate_kind: "package",
        display_name: "Gamma",
        package_id: "pkg-gamma",
        source_ref: "registry://gamma",
        version: "0.1.0",
      },
    ],
  });
  writeJson(specPath, {
    maxParallel: 2,
    now: "2026-04-04T21:30:00Z",
    reportId: "cli-discovery-pipeline",
    sources: [
      {
        kind: "local_filesystem",
        rootDirectory: path.join(workspaceRoot, "packages"),
      },
      {
        kind: "registry",
        registryPath,
      },
    ],
    taskId: "task-discovery",
  });

  const result = spawnSync("node", [cliEntrypoint, "discover-pipeline", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.seeker_scopes.length, 3);
  assert.equal(output.ready_seekers.length, 2);
  assert.equal(output.final_report.candidates.length, 2);
  assert.equal(output.final_report.duplicates.length, 1);
  assert.equal(output.summary.downstream_subtasks_created, 2);
  assert.match(
    output.seeker_reports[0].downstream_subtasks[0].title,
    /Review discovery candidate Alpha/i,
  );
});

test("niis promote-instinct returns a reviewed instinct artifact with provenance", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "promote-instinct-spec.json");

  writeJson(specPath, {
    candidate: {
      candidate_id: "local_filesystem:/tmp/review-skill/package.json",
      candidate_kind: "package",
      dedup_key: "package:pkg-review-skill",
      display_name: "Review Skill",
      metadata: {
        filesystem_root: "/tmp/packages",
        source_id: "local-filesystem-1",
      },
      package_id: "pkg-review-skill",
      package_manifest: null,
      review_required: true,
      security_findings: [],
      source_kind: "local_filesystem",
      source_ref: "/tmp/review-skill/package.json",
      suggestion_category: "shipped_capability",
      suggestion_reason: "Local manifest already exists and should be documented before duplication.",
      version: "0.1.0",
    },
    domain: "workflow_optimization",
    evidence: {
      confirmingSessions: ["task-1", "task-2"],
      lastObserved: "2026-04-04T17:30:00.000Z",
      observationCount: 4,
    },
    projectId: "example-project",
    review: {
      decision: "approve",
      rationale: "Repeated evidence justifies a reviewed project-scoped instinct artifact.",
      reviewedAt: "2026-04-04T17:31:00.000Z",
      reviewerId: "operator",
    },
  });

  const result = spawnSync("node", [cliEntrypoint, "promote-instinct", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.approved, true);
  assert.equal(output.confidence_evaluation.final_confidence, 0.6);
  assert.equal(output.instinct_artifact.confidence, 0.6);
  assert.equal(output.instinct_artifact.provenance.source_type, "discovery_candidate");
  assert.equal(output.instinct_artifact.provenance.suggestion_category, "shipped_capability");
  assert.equal(output.instinct_artifact.promotion_review.reviewer_id, "operator");
});

test("niis export-instincts returns a reviewed instinct sharing bundle", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "export-instincts-spec.json");

  writeJson(specPath, {
    instincts: [{
      id: "instinct-routing-1",
      trigger: "Prefer fast reviewer for repeated routing conflicts",
      confidence: 0.7,
      domain: "agent_routing",
      source: "runtime_observation",
      scope: "project",
      project_id: "example-project",
      evidence: {
        observation_count: 4,
        last_observed: "2026-04-04T20:00:00.000Z",
        confirming_sessions: ["task-1", "task-2"],
        contradicting_count: 0,
        project_ids: ["example-project"],
      },
      provenance: {
        source_type: "runtime_observation",
        source_ref: "task-1:routing",
        source_summary: "Repeated routing preference for fast reviewer",
        evidence_refs: ["task-1:routing"],
        suggestion_category: null,
      },
      promotion_review: {
        reviewer_id: "operator",
        reviewed_at: "2026-04-04T20:01:00.000Z",
        rationale: "Repeated routing preference justified a reviewed instinct.",
        review_level: "standard",
      },
      security_review: null,
      status: "tentative",
      created_at: "2026-04-04T20:01:00.000Z",
      updated_at: "2026-04-04T20:01:00.000Z",
    }],
    review: {
      decision: "approve",
      rationale: "The instinct is export-safe as a reviewed learning artifact.",
      reviewedAt: "2026-04-04T20:10:00.000Z",
      reviewerId: "operator",
    },
  });

  const result = spawnSync("node", [cliEntrypoint, "export-instincts", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.approved, true);
  assert.equal(output.bundle.bundle_kind, "instinct_bundle");
  assert.equal(output.bundle.instincts.length, 1);
  assert.equal(output.bundle.export_review.reviewer_id, "operator");
});

test("niis import-instincts merges reviewed duplicate instincts without replacing local provenance", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const exportSpecPath = path.join(workspaceRoot, "export-instincts-spec.json");
  const importSpecPath = path.join(workspaceRoot, "import-instincts-spec.json");

  writeJson(exportSpecPath, {
    bundleId: "routing-review-bundle",
    instincts: [
      {
        id: "instinct-routing-duplicate-a",
        trigger: "Prefer fast reviewer for repeated routing conflicts",
        confidence: 0.6,
        domain: "agent_routing",
        source: "runtime_observation",
        scope: "project",
        project_id: "example-project",
        evidence: {
          observation_count: 2,
          last_observed: "2026-04-04T20:03:00.000Z",
          confirming_sessions: ["task-a"],
          contradicting_count: 0,
          project_ids: ["example-project"],
        },
        provenance: {
          source_type: "runtime_observation",
          source_ref: "task-a:routing",
          source_summary: "Imported duplicate routing instinct",
          evidence_refs: ["task-a:routing"],
          suggestion_category: null,
        },
        promotion_review: {
          reviewer_id: "operator",
          reviewed_at: "2026-04-04T20:04:00.000Z",
          rationale: "Reviewed routing instinct from another environment.",
          review_level: "standard",
        },
        security_review: null,
        status: "tentative",
        created_at: "2026-04-04T20:04:00.000Z",
        updated_at: "2026-04-04T20:04:00.000Z",
      },
      {
        id: "instinct-routing-duplicate-b",
        trigger: "Prefer fast reviewer for repeated routing conflicts",
        confidence: 0.9,
        domain: "agent_routing",
        source: "runtime_observation",
        scope: "project",
        project_id: "example-project",
        evidence: {
          observation_count: 5,
          last_observed: "2026-04-04T20:09:00.000Z",
          confirming_sessions: ["task-b"],
          contradicting_count: 1,
          project_ids: ["example-project"],
        },
        provenance: {
          source_type: "runtime_observation",
          source_ref: "task-b:routing",
          source_summary: "Higher-confidence imported duplicate routing instinct",
          evidence_refs: ["task-b:routing"],
          suggestion_category: null,
        },
        promotion_review: {
          reviewer_id: "operator",
          reviewed_at: "2026-04-04T20:09:30.000Z",
          rationale: "Reviewed routing instinct from another environment.",
          review_level: "standard",
        },
        security_review: null,
        status: "tentative",
        created_at: "2026-04-04T20:09:30.000Z",
        updated_at: "2026-04-04T20:09:30.000Z",
      },
    ],
    review: {
      decision: "approve",
      rationale: "The instincts are export-safe for reviewed sharing.",
      reviewedAt: "2026-04-04T20:10:00.000Z",
      reviewerId: "operator",
    },
  });

  const exported = spawnSync("node", [cliEntrypoint, "export-instincts", exportSpecPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(exported.status, 0);

  writeJson(importSpecPath, {
    bundle: JSON.parse(exported.stdout).bundle,
    existingInstincts: [{
      id: "instinct-routing-1",
      trigger: "Prefer fast reviewer for repeated routing conflicts",
      confidence: 0.7,
      domain: "agent_routing",
      source: "runtime_observation",
      scope: "project",
      project_id: "example-project",
      evidence: {
        observation_count: 4,
        last_observed: "2026-04-04T20:00:00.000Z",
        confirming_sessions: ["task-1"],
        contradicting_count: 0,
        project_ids: ["example-project"],
      },
      provenance: {
        source_type: "runtime_observation",
        source_ref: "task-local:routing",
        source_summary: "Local reviewed routing instinct",
        evidence_refs: ["task-local:routing"],
        suggestion_category: null,
      },
      promotion_review: {
        reviewer_id: "operator",
        reviewed_at: "2026-04-04T20:01:00.000Z",
        rationale: "Repeated routing preference justified a reviewed instinct.",
        review_level: "standard",
      },
      security_review: null,
      status: "tentative",
      created_at: "2026-04-04T20:01:00.000Z",
      updated_at: "2026-04-04T20:01:00.000Z",
    }],
    review: {
      decision: "approve",
      rationale: "Import should merge duplicate routing instincts while keeping the local canonical provenance.",
      reviewedAt: "2026-04-04T20:12:00.000Z",
      reviewerId: "operator",
    },
  });

  const result = spawnSync("node", [cliEntrypoint, "import-instincts", importSpecPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.approved, true);
  assert.equal(output.summary.duplicate_count, 1);
  assert.equal(output.summary.imported_count, 0);
  assert.equal(output.summary.merged_count, 1);
  assert.equal(output.merged_instincts[0].merged_instinct.provenance.source_ref, "task-local:routing");
  assert.equal(output.merged_instincts[0].merged_instinct.confidence, 0.9);
  assert.ok(
    output.merged_instincts[0].merged_instinct.provenance.evidence_refs.includes(
      "routing-review-bundle:instinct-routing-duplicate-b",
    ),
  );
});

test("niis promote-instinct blocks suspicious candidates without explicit security review", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "promote-instinct-security-spec.json");

  writeJson(specPath, {
    candidate: {
      candidate_id: "registry://review-skill",
      candidate_kind: "package",
      dedup_key: "package:pkg-review-skill",
      display_name: "Review Skill",
      metadata: {
        registry_source_id: "registry-1",
      },
      package_id: "pkg-review-skill",
      package_manifest: null,
      review_required: true,
      security_findings: [{
        auto_fixable: false,
        blocking: true,
        category: "supply_chain",
        remediation_hint: "Review before promotion.",
        rule_id: "security/prompt-injection-carrier",
        severity: "high",
        source_surface_id: "registry-entry",
        source_surface_type: "discovery",
        summary: "Imported content may carry prompt-injection instructions.",
      }],
      source_kind: "registry",
      source_ref: "registry://review-skill",
      suggestion_category: "technical_debt",
      suggestion_reason: "Candidate remains suspicious until security review.",
      version: "0.1.0",
    },
    domain: "evidence_patterns",
    evidence: {
      confirmingSessions: ["task-1", "task-2"],
      lastObserved: "2026-04-04T17:30:00.000Z",
      observationCount: 4,
    },
    projectId: "example-project",
    review: {
      decision: "approve",
      rationale: "Promotion is otherwise acceptable, but security review is still required.",
      reviewedAt: "2026-04-04T17:31:00.000Z",
      reviewerId: "operator",
    },
  });

  const result = spawnSync("node", [cliEntrypoint, "promote-instinct", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.approved, false);
  assert.equal(output.security_evaluation.status, "requires_review");
  assert.match(output.reason_rejected, /explicit security review/i);
});

test("niis cluster-instincts returns a reviewed skill candidate artifact", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "cluster-instincts-spec.json");

  writeJson(specPath, {
    instincts: [
      {
        id: "instinct-gate-block-1",
        trigger: "Respond to repeated gate block publish failures",
        confidence: 0.7,
        domain: "blocker_resolution",
        source: "runtime_observation",
        scope: "project",
        project_id: "example-project",
        evidence: {
          observation_count: 4,
          last_observed: "2026-04-04T19:00:00.000Z",
          confirming_sessions: ["task-1", "task-2"],
          contradicting_count: 0,
          project_ids: ["example-project"],
        },
        provenance: {
          source_type: "runtime_observation",
          source_ref: "task-1:gate-block",
          source_summary: "Repeated gate block while publishing",
          evidence_refs: ["task-1:gate-block"],
          suggestion_category: null,
        },
        promotion_review: {
          reviewer_id: "operator",
          reviewed_at: "2026-04-04T19:01:00.000Z",
          rationale: "Repeated gate block justified a reviewed instinct.",
          review_level: "standard",
        },
        security_review: null,
        status: "tentative",
        created_at: "2026-04-04T19:01:00.000Z",
        updated_at: "2026-04-04T19:01:00.000Z",
      },
      {
        id: "instinct-gate-block-2",
        trigger: "Route around repeated gate block publish failures",
        confidence: 0.75,
        domain: "blocker_resolution",
        source: "runtime_observation",
        scope: "project",
        project_id: "example-project",
        evidence: {
          observation_count: 3,
          last_observed: "2026-04-04T19:05:00.000Z",
          confirming_sessions: ["task-3"],
          contradicting_count: 0,
          project_ids: ["example-project"],
        },
        provenance: {
          source_type: "runtime_observation",
          source_ref: "task-2:gate-block",
          source_summary: "Repeated gate block before publish retry",
          evidence_refs: ["task-2:gate-block"],
          suggestion_category: null,
        },
        promotion_review: {
          reviewer_id: "operator",
          reviewed_at: "2026-04-04T19:06:00.000Z",
          rationale: "Repeated gate block justified a reviewed instinct.",
          review_level: "standard",
        },
        security_review: null,
        status: "tentative",
        created_at: "2026-04-04T19:06:00.000Z",
        updated_at: "2026-04-04T19:06:00.000Z",
      },
    ],
    review: {
      decision: "approve",
      rationale: "Two related blocker instincts are strong enough to review as one reusable skill candidate.",
      reviewedAt: "2026-04-04T19:10:00.000Z",
      reviewerId: "operator",
    },
  });

  const result = spawnSync("node", [cliEntrypoint, "cluster-instincts", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.approved, true);
  assert.equal(output.skill_candidate.scope, "project");
  assert.equal(output.skill_candidate.project_id, "example-project");
  assert.equal(output.skill_candidate.provenance.source_type, "instinct_cluster");
  assert.ok(output.skill_candidate.clustering.shared_trigger_tokens.includes("gate"));
  assert.ok(output.skill_candidate.clustering.shared_trigger_tokens.includes("publish"));
});

test("niis govern-learning only emits REVIEW skill manifests after approved governance", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "govern-learning-spec.json");

  writeJson(specPath, {
    approval: {
      approvedAt: "2026-04-04T19:16:00.000Z",
      id: "approval-learning-1",
      ownerRole: "operator",
      reason: "This candidate may proceed to reviewed package form.",
      requestedBy: "reviewer",
      status: "APPROVED",
      taskId: "learning-governance-approved",
    },
    skillCandidate: {
      id: "skill-candidate-blocker-resolution-gate-publish-project-example-project",
      title: "blocker resolution skill candidate: gate, publish",
      summary: "Clustered 2 related instincts by shared trigger/context signals (gate, publish).",
      scope: "project",
      project_id: "example-project",
      domains: ["blocker_resolution"],
      evidence: {
        instinct_count: 2,
        total_observation_count: 7,
        last_observed: "2026-04-04T19:05:00.000Z",
        project_ids: ["example-project"],
      },
      clustering: {
        shared_trigger_tokens: ["gate", "publish"],
        shared_context_signals: ["scope:project", "domain:blocker_resolution", "project:example-project"],
        similarity_score: 0.75,
      },
      provenance: {
        source_type: "instinct_cluster",
        source_ref: "instinct-cluster:instinct-gate-block-1,instinct-gate-block-2",
        source_summary: "Reviewed cluster over 2 instincts.",
        evidence_refs: ["instinct-gate-block-1", "instinct-gate-block-2"],
      },
      promotion_review: {
        reviewer_id: "operator",
        reviewed_at: "2026-04-04T19:10:00.000Z",
        rationale: "Two related blocker instincts are strong enough to review as one reusable skill candidate.",
        review_level: "standard",
      },
      security_review: null,
      status: "candidate",
      created_at: "2026-04-04T19:10:00.000Z",
      updated_at: "2026-04-04T19:10:00.000Z",
    },
    taskId: "learning-governance-approved",
  });

  const result = spawnSync("node", [cliEntrypoint, "govern-learning", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.allowed, true);
  assert.equal(output.package_manifest.type, "skill");
  assert.equal(output.package_manifest.activation_status, "REVIEW");
  assert.equal(output.target_status, "REVIEW");
  assert.equal(output.blocker, null);
});

test("niis govern-learning blocks reviewed skill packaging without durable evidence", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "govern-learning-insufficient-evidence-spec.json");

  writeJson(specPath, {
    approval: {
      approvedAt: "2026-04-04T19:16:00.000Z",
      id: "approval-learning-insufficient-evidence",
      ownerRole: "operator",
      reason: "This candidate may proceed to reviewed package form.",
      requestedBy: "reviewer",
      status: "APPROVED",
      taskId: "learning-governance-insufficient-evidence",
    },
    skillCandidate: {
      id: "skill-candidate-blocker-resolution-gate-publish-project-example-project",
      title: "blocker resolution skill candidate: gate, publish",
      summary: "Clustered 2 related instincts by shared trigger/context signals (gate, publish).",
      scope: "project",
      project_id: "example-project",
      domains: ["blocker_resolution"],
      evidence: {
        instinct_count: 2,
        total_observation_count: 2,
        last_observed: "2026-04-04T19:05:00.000Z",
        project_ids: ["example-project"],
      },
      clustering: {
        shared_trigger_tokens: ["gate", "publish"],
        shared_context_signals: ["scope:project", "domain:blocker_resolution", "project:example-project"],
        similarity_score: 0.75,
      },
      provenance: {
        source_type: "instinct_cluster",
        source_ref: "instinct-cluster:instinct-gate-block-1,instinct-gate-block-2",
        source_summary: "Reviewed cluster over 2 instincts.",
        evidence_refs: ["instinct-gate-block-1", "instinct-gate-block-2"],
      },
      promotion_review: {
        reviewer_id: "operator",
        reviewed_at: "2026-04-04T19:10:00.000Z",
        rationale: "Two related blocker instincts are strong enough to review as one reusable skill candidate.",
        review_level: "standard",
      },
      security_review: null,
      status: "candidate",
      created_at: "2026-04-04T19:10:00.000Z",
      updated_at: "2026-04-04T19:10:00.000Z",
    },
    taskId: "learning-governance-insufficient-evidence",
  });

  const result = spawnSync("node", [cliEntrypoint, "govern-learning", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.allowed, false);
  assert.equal(output.blocker.blocker_class, "DEPENDENCY_UNMET");
  assert.equal(output.evidence_evaluation.ok, false);
  assert.equal(output.package_manifest, null);
});

test("niis memory-taxonomy classifies learning artifacts into daily, projects, and facts", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "memory-taxonomy-spec.json");

  writeJson(specPath, {
    observationArtifacts: [{
      id: "observation-task-1-gate-block",
      observation: {
        category: "pre_execution_gate",
        confidence: 1,
        payload: {
          decision: "blocked",
          operation: "danger.full_access",
        },
        pattern_category: "blocker_resolution",
        policy_refs: ["policy/pre_execution_gate/v1"],
        source_id: "task-1:gate-block",
        source_kind: "pre_execution_gate",
        summary: "blocked dangerous operation",
      },
      storage_tier: "hot",
      processed_at: null,
      archived_at: null,
      purged_at: null,
      lifecycle: {
        archive_after_days: 7,
        purge_after_days: 30,
        policy_id: "policy/observation-lifecycle/v1",
        retain_unprocessed: true,
        last_action: "retain_hot",
        last_evaluated_at: "2026-04-04T00:00:00.000Z",
      },
      created_at: "2026-04-04T00:00:00.000Z",
      updated_at: "2026-04-04T00:00:00.000Z",
    }],
    instincts: [{
      id: "instinct-routing-global",
      trigger: "Prefer fast reviewer for repeated routing conflicts",
      confidence: 0.8,
      domain: "agent_routing",
      source: "runtime_observation",
      scope: "global",
      project_id: null,
      evidence: {
        observation_count: 6,
        last_observed: "2026-04-04T20:00:00.000Z",
        confirming_sessions: ["task-1", "task-2"],
        contradicting_count: 0,
        project_ids: ["example-project", "secondary-project"],
      },
      provenance: {
        source_type: "runtime_observation",
        source_ref: "task-1:routing",
        source_summary: "Repeated routing preference for fast reviewer",
        evidence_refs: ["task-1:routing"],
        suggestion_category: null,
      },
      promotion_review: {
        reviewer_id: "operator",
        reviewed_at: "2026-04-04T20:01:00.000Z",
        rationale: "Repeated routing preference justified a reviewed global instinct.",
        review_level: "elevated",
      },
      security_review: null,
      status: "tentative",
      created_at: "2026-04-04T20:01:00.000Z",
      updated_at: "2026-04-04T20:01:00.000Z",
    }],
    skillCandidates: [{
      id: "skill-candidate-routing-project-example-project",
      title: "routing skill candidate: fast reviewer",
      summary: "Clustered 2 related routing instincts by shared trigger/context signals.",
      scope: "project",
      project_id: "example-project",
      domains: ["agent_routing"],
      evidence: {
        instinct_count: 2,
        total_observation_count: 7,
        last_observed: "2026-04-04T20:05:00.000Z",
        project_ids: ["example-project"],
      },
      clustering: {
        shared_trigger_tokens: ["routing", "reviewer"],
        shared_context_signals: ["scope:project", "domain:agent_routing", "project:example-project"],
        similarity_score: 0.8,
      },
      provenance: {
        source_type: "instinct_cluster",
        source_ref: "instinct-cluster:instinct-routing-1,instinct-routing-2",
        source_summary: "Reviewed cluster over 2 routing instincts.",
        evidence_refs: ["instinct-routing-1", "instinct-routing-2"],
      },
      promotion_review: {
        reviewer_id: "operator",
        reviewed_at: "2026-04-04T20:10:00.000Z",
        rationale: "Two related routing instincts are strong enough to review as one reusable skill candidate.",
        review_level: "standard",
      },
      security_review: null,
      status: "candidate",
      created_at: "2026-04-04T20:10:00.000Z",
      updated_at: "2026-04-04T20:10:00.000Z",
    }],
  });

  const result = spawnSync("node", [cliEntrypoint, "memory-taxonomy", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.deepEqual(output.summary, {
    daily: 1,
    facts: 1,
    projects: 1,
    total: 3,
  });
  assert.equal(output.evaluations[0].memory_tier, "daily");
  assert.equal(output.evaluations[1].memory_tier, "facts");
  assert.equal(output.evaluations[2].memory_tier, "projects");
});

test("niis observation-lifecycle evaluates retain, archive, and purge actions", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "observation-lifecycle-spec.json");

  writeJson(specPath, {
    artifacts: [
      {
        id: "observation-task-1-gate-block",
        observation: {
          category: "pre_execution_gate",
          confidence: 1,
          payload: {
            decision: "blocked",
            operation: "danger.full_access",
          },
          policy_refs: ["policy/pre_execution_gate/v1"],
          source_id: "task-1:gate-block",
          source_kind: "pre_execution_gate",
          summary: "blocked dangerous operation",
        },
        storage_tier: "hot",
        processed_at: null,
        archived_at: null,
        purged_at: null,
        lifecycle: {
          archive_after_days: 7,
          purge_after_days: 30,
          policy_id: "policy/observation-lifecycle/v1",
          retain_unprocessed: true,
          last_action: "retain_hot",
          last_evaluated_at: "2026-03-01T00:00:00.000Z",
        },
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:00:00.000Z",
      },
      {
        id: "observation-task-2-gate-block",
        observation: {
          category: "pre_execution_gate",
          confidence: 1,
          payload: {
            decision: "blocked",
            operation: "workspace.write",
          },
          policy_refs: ["policy/pre_execution_gate/v1"],
          source_id: "task-2:gate-block",
          source_kind: "pre_execution_gate",
          summary: "blocked workspace write",
        },
        storage_tier: "hot",
        processed_at: "2026-03-22T00:00:00.000Z",
        archived_at: null,
        purged_at: null,
        lifecycle: {
          archive_after_days: 7,
          purge_after_days: 30,
          policy_id: "policy/observation-lifecycle/v1",
          retain_unprocessed: true,
          last_action: "retain_hot",
          last_evaluated_at: "2026-03-22T00:00:00.000Z",
        },
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-22T00:00:00.000Z",
      },
      {
        id: "observation-task-3-gate-block",
        observation: {
          category: "pre_execution_gate",
          confidence: 1,
          payload: {
            decision: "blocked",
            operation: "network.access",
          },
          policy_refs: ["policy/pre_execution_gate/v1"],
          source_id: "task-3:gate-block",
          source_kind: "pre_execution_gate",
          summary: "blocked network access",
        },
        storage_tier: "archive",
        processed_at: "2026-02-20T00:00:00.000Z",
        archived_at: "2026-03-01T00:00:00.000Z",
        purged_at: null,
        lifecycle: {
          archive_after_days: 7,
          purge_after_days: 30,
          policy_id: "policy/observation-lifecycle/v1",
          retain_unprocessed: true,
          last_action: "archive",
          last_evaluated_at: "2026-03-01T00:00:00.000Z",
        },
        created_at: "2026-02-15T00:00:00.000Z",
        updated_at: "2026-03-01T00:00:00.000Z",
      },
    ],
    now: "2026-04-04T00:00:00.000Z",
  });

  const result = spawnSync("node", [cliEntrypoint, "observation-lifecycle", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.deepEqual(output.summary, {
    archive: 1,
    purge: 1,
    retain_hot: 1,
    total: 3,
  });
  assert.equal(output.decisions[1].action, "archive");
  assert.equal(output.decisions[2].action, "purge");
});

test("niis guard-observation blocks unsupported activity signals under skip fail mode", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "guard-observation-spec.json");

  writeJson(specPath, {
    activitySignal: {
      supported: false,
    },
    now: "2026-04-04T11:00:00.000Z",
    observerTurn: 1,
    projectId: "example-project",
  });

  const result = spawnSync("node", [cliEntrypoint, "guard-observation", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.allowed, false);
  assert.equal(output.checks.at(-1).name, "activity_signal");
  assert.match(output.checks.at(-1).reason, /activity signal is unavailable/i);
  assert.equal(output.observation_signal.category, "background_observer_guard");
});

test("niis promote-instinct blocks global promotion without elevated multi-project proof", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "promote-instinct-global-spec.json");

  writeJson(specPath, {
    candidate: {
      candidate_id: "local_filesystem:/tmp/review-skill/package.json",
      candidate_kind: "package",
      dedup_key: "package:pkg-review-skill",
      display_name: "Review Skill",
      metadata: {
        filesystem_root: "/tmp/packages",
        source_id: "local-filesystem-1",
      },
      package_id: "pkg-review-skill",
      package_manifest: null,
      review_required: true,
      security_findings: [],
      source_kind: "local_filesystem",
      source_ref: "/tmp/review-skill/package.json",
      suggestion_category: "shipped_capability",
      suggestion_reason: "Local manifest already exists and should be documented before duplication.",
      version: "0.1.0",
    },
    domain: "agent_routing",
    evidence: {
      confirmingSessions: ["task-1", "task-2"],
      lastObserved: "2026-04-04T17:30:00.000Z",
      observationCount: 6,
      projectIds: ["example-project"],
    },
    review: {
      decision: "approve",
      rationale: "Attempted global promotion without sufficient threshold proof.",
      reviewedAt: "2026-04-04T17:31:00.000Z",
      reviewerId: "operator",
      reviewLevel: "standard",
    },
    scope: "global",
  });

  const result = spawnSync("node", [cliEntrypoint, "promote-instinct", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.approved, false);
  assert.equal(output.instinct_artifact, null);
  assert.equal(output.threshold_evaluation.required_review_level, "elevated");
  assert.match(output.reason_rejected, /multi-project proof/i);
});

test("niis promote-instinct accepts policy observations from the existing hook pipeline", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "promote-observation-spec.json");

  writeJson(specPath, {
    evidence: {
      confirmingSessions: ["task-1", "task-2"],
      lastObserved: "2026-04-04T18:10:00.000Z",
      observationCount: 3,
      projectIds: ["example-project"],
    },
    observation: {
      category: "pre_execution_gate",
      confidence: 1,
      payload: {
        decision: "blocked",
        operation: "danger.full_access",
      },
      policyRefs: ["policy/pre_execution_gate/v1"],
      sourceId: "task-1:gate-block",
      sourceKind: "pre_execution_gate",
      summary: "blocked dangerous operation",
    },
    projectId: "example-project",
    review: {
      decision: "approve",
      rationale: "Repeated gate blocks justify a reusable blocker-resolution instinct.",
      reviewedAt: "2026-04-04T18:11:00.000Z",
      reviewerId: "operator",
    },
  });

  const result = spawnSync("node", [cliEntrypoint, "promote-instinct", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.approved, true);
  assert.equal(output.ingress_evaluation.derived_domain, "blocker_resolution");
  assert.equal(output.source_observation.source_kind, "pre_execution_gate");
  assert.equal(output.instinct_artifact.provenance.source_type, "runtime_observation");
});

test("niis review assembles validators from project profile when validatorIds are omitted", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "review-spec.json");

  writeJson(specPath, {
    evidencePacket: {
      authenticity_status: "VERIFIED",
      items: [
        {
          content: "README refresh is complete.",
          raw_output_ref: null,
          source: "runtime",
          type: "command_output",
        },
      ],
      markers: {
        auth_surfaces_attempted: [],
        browser_live_checks: [],
        checked_urls: [],
        runtime_evidence_succeeded: true,
      },
    },
    observedOutcome: {
      completion_confirmed: true,
    },
    projectProfile: {
      frameworks: ["react", "hapi"],
      primary_type: "web_application",
      validation_surface: {
        routes: ["src/server/routes/index.ts"],
      },
    },
    runRecord: {
      adapter_id: "test-adapter",
      agent_id: "executor-agent",
      checkpoint_id: null,
      cost: {
        duration_ms: 50,
        estimated_usd: 0.01,
        tokens_in: 10,
        tokens_out: 20,
      },
      exit_code: 0,
      finished_at: "2026-04-04T18:10:10.000Z",
      id: "run-review-profile",
      invocation_source: "on_demand",
      run_log: {
        bytes: 32,
        ref: null,
        sha256: "abc123",
        storage: "inline",
      },
      started_at: "2026-04-04T18:10:00.000Z",
      status: "COMPLETED",
      subtask_id: null,
      task_id: "task-review-profile",
      task_session_key: null,
    },
    task: {
      id: "task-review-profile",
      refs: ["README.md"],
      title: "Refresh README after validation",
    },
  });

  const result = spawnSync("node", [cliEntrypoint, "review", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.deepEqual(
    output.results.map((entry) => entry.validator.id),
    ["evidence_authenticity", "completion_proof"],
  );
});

test("niis import supports declarative adversarial reviewers from JSON spec", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const sourcePath = path.join(workspaceRoot, "README.md");
  const specPath = path.join(workspaceRoot, "import-spec.json");

  fs.writeFileSync(sourcePath, "# Host Review Surface\n");
  writeJson(specPath, {
    adversarialReviewers: [
      {
        id: "cli-import-attacker",
        role: "attacker",
        expectedPreviousResultsCount: 0,
        result: {
          evidence_packet: {
            authenticity_status: "VERIFIED",
            items: [{
              content: "Attacker identified a candidate import-side concern.",
              source: "attacker",
              type: "review_note",
            }],
            markers: {
              auth_surfaces_attempted: [],
              browser_live_checks: [],
              checked_urls: [],
              runtime_evidence_succeeded: true,
            },
          },
          next_action: "Require the defender to rebut the import-side concern.",
          reason: "Adversarial import review identified a candidate concern.",
          verdict_class: "DEFECT",
        },
      },
      {
        id: "cli-import-defender",
        role: "defender",
        expectedPreviousResultsCount: 1,
        result: {
          evidence_packet: {
            authenticity_status: "VERIFIED",
            items: [{
              content: "Defender rebutted the import-side concern.",
              source: "defender",
              type: "review_note",
            }],
            markers: {
              auth_surfaces_attempted: [],
              browser_live_checks: [],
              checked_urls: [],
              runtime_evidence_succeeded: true,
            },
          },
          next_action: "Escalate to the auditor for final import approval.",
          reason: "The rebuttal resolved the attacker concern for the import candidate.",
          verdict_class: "PASS",
        },
      },
      {
        id: "cli-import-auditor",
        role: "auditor",
        expectedPreviousResultsCount: 2,
        result: {
          evidence_packet: {
            authenticity_status: "VERIFIED",
            items: [{
              content: "Auditor approved the conversion report.",
              source: "auditor",
              type: "review_note",
            }],
            markers: {
              auth_surfaces_attempted: [],
              browser_live_checks: [],
              checked_urls: [],
              runtime_evidence_succeeded: true,
            },
          },
          next_action: "Mark the conversion report approved and keep activation explicit.",
          reason: "The final adversarial import review approved the conversion report.",
          verdict_class: "PASS",
        },
      },
    ],
    policy: {
      activation_review: {
        mode: "auto",
      },
    },
    sourcePack: {
      capabilities: ["review"],
      foreignType: "rule",
      format: "cursor_rule_bundle",
      origin: "host_repository",
      path: sourcePath,
      version: "0.1.0",
    },
    taskId: "cli-adversarial-import-task",
  });

  const result = spawnSync("node", [cliEntrypoint, "import", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.conversion_report.review_status, "APPROVED");
  assert.equal(output.package_manifest.activation_status, "REVIEW");
  assert.equal(output.adversarial_review.final_verdict.verdict_class, "PASS");
  assert.equal(output.event.payload.adversarial_review_executed, true);
});

test("niis activate supports declarative adversarial reviewers from JSON spec", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const specPath = path.join(workspaceRoot, "activate-spec.json");

  writeJson(specPath, {
    adversarialReviewers: [
      {
        id: "cli-activation-attacker",
        role: "attacker",
        expectedPreviousResultsCount: 0,
        result: {
          evidence_packet: {
            authenticity_status: "VERIFIED",
            items: [{
              content: "Attacker identified a candidate activation-side concern.",
              source: "attacker",
              type: "review_note",
            }],
            markers: {
              auth_surfaces_attempted: [],
              browser_live_checks: [],
              checked_urls: [],
              runtime_evidence_succeeded: true,
            },
          },
          next_action: "Require the defender to rebut the activation-side concern.",
          reason: "Adversarial activation review identified a candidate concern.",
          verdict_class: "DEFECT",
        },
      },
      {
        id: "cli-activation-defender",
        role: "defender",
        expectedPreviousResultsCount: 1,
        result: {
          evidence_packet: {
            authenticity_status: "VERIFIED",
            items: [{
              content: "Defender rebutted the activation-side concern.",
              source: "defender",
              type: "review_note",
            }],
            markers: {
              auth_surfaces_attempted: [],
              browser_live_checks: [],
              checked_urls: [],
              runtime_evidence_succeeded: true,
            },
          },
          next_action: "Escalate to the auditor for final activation approval.",
          reason: "The rebuttal resolved the attacker concern for the activation candidate.",
          verdict_class: "PASS",
        },
      },
      {
        id: "cli-activation-auditor",
        role: "auditor",
        expectedPreviousResultsCount: 2,
        result: {
          evidence_packet: {
            authenticity_status: "VERIFIED",
            items: [{
              content: "Auditor approved the package activation.",
              source: "auditor",
              type: "review_note",
            }],
            markers: {
              auth_surfaces_attempted: [],
              browser_live_checks: [],
              checked_urls: [],
              runtime_evidence_succeeded: true,
            },
          },
          next_action: "Promote the package to ACTIVE.",
          reason: "The final adversarial activation review approved the package.",
          verdict_class: "PASS",
        },
      },
    ],
    packageManifest: {
      activation_status: "REVIEW",
      capabilities: ["review"],
      compatibility: {
        max_niis_version: null,
        min_niis_version: "0.1.0",
        required_adapters: [],
      },
      id: "cli-activation-skill",
      name: "CLI Activation Skill",
      schema_version: "1.0.0",
      type: "skill",
      version: "0.1.0",
    },
    policy: {
      activation_review: {
        mode: "auto",
      },
    },
    securityScanSurfaces: [{
      content: "Reviewed onboarding content only.",
      hooks: [],
      id: "candidate-import",
      type: "conversion_candidate",
    }],
    taskId: "cli-adversarial-activation-task",
  });

  const result = spawnSync("node", [cliEntrypoint, "activate", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);

  assert.equal(output.allowed, true);
  assert.equal(output.package_manifest.activation_status, "ACTIVE");
  assert.equal(output.adversarial_review.final_verdict.verdict_class, "PASS");
  assert.equal(output.event.payload.adversarial_review_executed, true);
});

test("niis import supports context-aware adversarial reviewer strategy", (t) => {
  const workspaceRoot = createWorkspaceFixture(t);
  const sourcePath = path.join(workspaceRoot, "README.md");
  const specPath = path.join(workspaceRoot, "import-contextual-spec.json");

  fs.writeFileSync(sourcePath, "# Contextual Host Surface\n");
  writeJson(specPath, {
    adversarialReviewers: [
      {
        expectedPreviousResultsCount: 0,
        id: "contextual-import-attacker",
        role: "attacker",
        strategy: "subject_summary",
        verdictClass: "DEFECT",
      },
      {
        expectedPreviousResultsCount: 1,
        id: "contextual-import-defender",
        role: "defender",
        strategy: "subject_summary",
        verdictClass: "PASS",
      },
      {
        expectedPreviousResultsCount: 2,
        id: "contextual-import-auditor",
        role: "auditor",
        strategy: "subject_summary",
        verdictClass: "PASS",
      },
    ],
    policy: {
      activation_review: {
        mode: "auto",
      },
    },
    sourcePack: {
      capabilities: ["review"],
      foreignType: "rule",
      format: "cursor_rule_bundle",
      origin: "host_repository",
      path: sourcePath,
      version: "0.1.0",
    },
    taskId: "cli-contextual-import-task",
  });

  const result = spawnSync("node", [cliEntrypoint, "import", specPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);

  const output = JSON.parse(result.stdout);
  const firstReviewNote = output.adversarial_review.results[0].evidence_packet.items[0].content;

  assert.equal(output.adversarial_review.final_verdict.verdict_class, "PASS");
  assert.match(firstReviewNote, /README\.md/);
  assert.match(firstReviewNote, /Contextual Host Surface/);
});
