import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { assertStorageImplementation } from "../contracts/storage.js";
import {
  collectSqliteStorageChecks,
  createSqliteDatabasePath,
  createSqliteStorage,
  seedStorage,
} from "./sqlite.js";
import { createRunLogPaths } from "./run-logs.js";

function createTask({
  id = "task-1",
  goalId = "goal-1",
  status = "IN_PROGRESS",
} = {}) {
  return {
    acceptance_markdown: "- Verify rollout evidence remains intact.",
    acceptance_commands: [
      { argv: ["npm", "test"], id: "unit-tests", required: true },
    ],
    details_markdown: "Parser task details in markdown.",
    id,
    title: `Task ${id}`,
    operator_brief_markdown: "Original operator brief in markdown.",
    status,
    phase: 6,
    priority: "high",
    goal_id: goalId,
    depends_on: [],
    assigned_to: "agent-1",
    out_of_scope: [],
    rejection_count: 0,
    max_rejections: 5,
    created_at: "2026-04-01T18:20:00.000Z",
    updated_at: "2026-04-01T18:20:00.000Z",
    transition_log: [],
  };
}

function createGoal() {
  return {
    id: "goal-1",
    title: "Storage rollout",
    description: "Durable storage work",
    level: "project",
    status: "active",
    parent_goal_id: null,
    project_id: "example-project",
    owner_agent_id: null,
    created_at: "2026-04-01T18:20:00.000Z",
    updated_at: "2026-04-01T18:20:00.000Z",
  };
}

function createAgent() {
  return {
    id: "agent-1",
    name: "Storage Agent",
    adapter_type: "sqlite-test",
    status: "ACTIVE",
    pause_condition: null,
    capabilities: ["execute"],
    budget_monthly: {
      limit_usd: 100,
      spent_usd: 0,
    },
    config: {},
    env_bindings: [
      {
        key: "API_KEY",
        type: "secret_ref",
        value: "secret://agent-1/api-key",
      },
    ],
    health_status: "healthy",
    last_run_id: null,
    last_run_at: null,
    accumulated: {
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_cost_usd: 0,
      total_runs: 0,
    },
    created_at: "2026-04-01T18:20:00.000Z",
    updated_at: "2026-04-01T18:20:00.000Z",
  };
}

function createRun() {
  return {
    id: "run-1",
    task_id: "task-1",
    subtask_id: null,
    agent_id: "agent-1",
    adapter_id: "sqlite-test",
    status: "COMPLETED",
    started_at: "2026-04-01T18:21:00.000Z",
    finished_at: "2026-04-01T18:22:00.000Z",
    checkpoint_id: null,
    exit_code: 0,
    cost: {
      tokens_in: 10,
      tokens_out: 20,
      duration_ms: 1000,
      estimated_usd: 1.5,
    },
    invocation_source: "assignment",
    run_log: {
      storage: "inline",
      ref: null,
      bytes: 128,
      sha256: "abc123",
    },
    task_session_key: "task-1:agent-1:sqlite-test",
  };
}

test("sqlite storage satisfies the contract, persists records, and exposes query views after reopen", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-sqlite-storage-"));
  const stateRoot = path.join(tempRoot, ".niis");
  const databasePath = createSqliteDatabasePath(stateRoot);
  const storage = createSqliteStorage({ databasePath });

  assert.equal(assertStorageImplementation(storage), true);

  await seedStorage(storage, {
    agents: [createAgent()],
    assignments: [{
      id: "assignment-1",
      task_id: "task-1",
      agent_id: "agent-1",
      reason_type: "manual",
      policy_ref: "runtime/serve/v1",
      assigned_at: "2026-04-01T18:21:00.000Z",
      context: "manual assignment",
    }],
    blockers: [{
      id: "blocker-1",
      task_id: "task-1",
      blocker_class: "ENV_BLOCK",
      reason: "workspace issue",
      next_action: "fix workspace",
      created_at: "2026-04-01T18:23:00.000Z",
      resolved_at: null,
    }],
    checkpoints: [{
      id: "checkpoint-1",
      run_id: "run-1",
      state_snapshot: { foo: "bar" },
      context_summary: "mid-run checkpoint",
      created_at: "2026-04-01T18:21:30.000Z",
      resumable: true,
      resume_instructions: "resume safely",
    }],
    events: [{
      id: "run-1:event-1",
      run_id: "run-1",
      task_id: "task-1",
      event_type: "STATE_CHANGE",
      timestamp: "2026-04-01T18:21:00.000Z",
      actor: "runtime",
      payload: { status: "started" },
    }],
    evidencePackets: [{
      id: "evidence-1",
      verdict_id: "verdict-1",
      items: [{
        type: "stdout",
        source: "run-1",
        content: "ok",
        raw_output_ref: null,
      }],
      authenticity_status: "VERIFIED",
      markers: {
        checked_urls: [],
        auth_surfaces_attempted: [],
        browser_live_checks: [],
        runtime_evidence_succeeded: true,
      },
    }],
    explainability: [{
      id: "explain-1",
      decision_type: "ROUTE",
      task_id: "task-1",
      route_chosen: "sqlite-route",
      alternatives_considered: [],
      policy_refs: ["runtime/serve/v1"],
      evidence_refs: ["run-1"],
      timestamp: "2026-04-01T18:22:00.000Z",
      human_readable_summary: "SQLite route selected.",
    }],
    goals: [createGoal()],
    ingressRecords: [{
      id: "ingress-1",
      source_type: "backlog_file",
      source_ref: "task:task-1",
      detected_at: "2026-04-01T18:20:30.000Z",
      route_candidate: "worker",
      authority_constraints: [],
      approvals_required: [],
      ingress_status: "QUEUED",
    }],
    leases: [{
      lease_id: "lease:task-1",
      task_id: "task-1",
      holder: "agent-1",
      acquired_at: "2026-04-01T18:21:00.000Z",
      expires_at: "2026-04-01T18:26:00.000Z",
      renewable: true,
    }],
    queueItems: [{
      task_id: "task-1",
      priority: 1,
      queued_at: "2026-04-01T18:20:45.000Z",
      claimed_by: null,
      claim_expires_at: null,
      status: "QUEUED",
    }],
    runLogs: [{
      run_id: "run-1",
      raw_output: "all good",
      run_log: createRun().run_log,
    }],
    runs: [createRun()],
    taskNotes: [{
      id: "note-1",
      task_id: "task-1",
      author_type: "operator",
      author_id: "ops-1",
      content: "review @agent-1",
      mentions: ["agent-1"],
      created_at: "2026-04-01T18:22:30.000Z",
    }],
    approvals: [{
      id: "approval-1",
      task_id: "task-1",
      action_id: "blocker-1",
      requested_by: "validator",
      owner_role: "operator",
      risk_level: "high",
      reason: "Operator approval is required before the task may continue.",
      created_at: "2026-04-01T18:22:40.000Z",
      status: "PENDING",
      approved_at: null,
      notes: [],
    }],
    taskSessions: [{
      task_key: "task-1:agent-1:sqlite-test",
      agent_id: "agent-1",
      adapter_type: "sqlite-test",
      session_params: { cursor: 1 },
      last_run_id: "run-1",
      display_id: "session-1",
      created_at: "2026-04-01T18:21:00.000Z",
      updated_at: "2026-04-01T18:22:00.000Z",
    }],
    taskRunSessions: [{
      id: "task-run-session-1",
      task_id: "task-1",
      run_id: "run-1",
      adapter_id: "sqlite-test",
      lane_id: "generalist",
      runtime_family: "codex_local",
      status: "completed",
      active_phase: "reviewing",
      summary: "Validator lane completed successfully.",
      started_at: "2026-04-01T18:21:00.000Z",
      updated_at: "2026-04-01T18:22:15.000Z",
      finished_at: "2026-04-01T18:22:15.000Z",
    }],
    taskRunEvents: [{
      id: "task-run-event-1",
      task_id: "task-1",
      run_id: "run-1",
      ts: "2026-04-01T18:21:10.000Z",
      event_type: "route_selected",
      level: "info",
      actor_type: "runtime",
      actor_id: "coordinator",
      visibility: "curated",
      payload: {
        adapter_id: "sqlite-test",
        lane_id: "generalist",
        summary: "Selected sqlite-test.",
      },
    }],
    taskLiveExcerpts: [{
      id: "task-live-excerpt-1",
      task_id: "task-1",
      run_id: "run-1",
      ts: "2026-04-01T18:21:20.000Z",
      channel: "summary",
      level: "info",
      source: "agent",
      content: "Reviewed parser template and updated the label only.",
      metadata: {
        adapter_id: "sqlite-test",
      },
    }],
    taskContentRevisions: [{
      acceptance_markdown: "- Verify rollout evidence remains intact.\n- Preserve parser behavior.",
      changed_fields: ["details_markdown", "acceptance_markdown"],
      created_at: "2026-04-01T18:22:20.000Z",
      details_markdown: "## Context\nUpdated parser task details in markdown.",
      editor_id: "ui:operator",
      editor_type: "operator",
      id: "task-content-revision-1",
      operator_brief_markdown: "Original operator brief in markdown.",
      phase: 6,
      priority: "high",
      source: "ui",
      task_id: "task-1",
      title: "Task task-1",
    }],
    tasks: [createTask()],
    verdicts: [{
      id: "verdict-1",
      run_id: "run-1",
      task_id: "task-1",
      verdict_class: "PASS",
      reviewer_id: "reviewer-1",
      evidence_packet_id: "evidence-1",
      reason: "looks good",
      next_action: "complete",
      created_at: "2026-04-01T18:22:10.000Z",
    }],
  });

  await storage.agents.updateStatus("agent-1", {
    health_status: "degraded",
    status: "PAUSED",
  });
  await storage.agents.accumulateCost("agent-1", {
    estimated_usd: 0.5,
    tokens_in: 5,
    tokens_out: 6,
  });
  storage.close();

  const reopened = createSqliteStorage({ databasePath, readonly: true });

  assert.equal((await reopened.tasks.list()).length, 1);
  assert.equal((await reopened.tasks.list())[0].details_markdown, "Parser task details in markdown.");
  assert.equal((await reopened.tasks.list())[0].acceptance_markdown, "- Verify rollout evidence remains intact.");
  assert.deepEqual((await reopened.tasks.list())[0].acceptance_commands, [
    { argv: ["npm", "test"], id: "unit-tests", required: true },
  ]);
  assert.equal((await reopened.tasks.byGoal("goal-1")).length, 1);
  assert.equal((await reopened.goals.list()).length, 1);
  assert.equal((await reopened.goals.byId("goal-1")).id, "goal-1");
  assert.equal((await reopened.runs.byTask("task-1")).length, 1);
  assert.equal((await reopened.agents.list()).length, 1);
  assert.equal((await reopened.agents.byId("agent-1")).status, "PAUSED");
  assert.equal((await reopened.agents.byId("agent-1")).budget_monthly.spent_usd, 0.5);
  assert.equal((await reopened.agents.health())[0].health_status, "degraded");
  assert.equal((await reopened.taskSessions.getByKey("task-1:agent-1:sqlite-test")).last_run_id, "run-1");
  assert.equal((await reopened.taskSessions.byTaskKey("task-1:agent-1:sqlite-test")).length, 1);
  assert.equal((await reopened.taskRunSessions.byTask("task-1")).length, 1);
  assert.equal((await reopened.taskRunSessions.byRun("run-1")).length, 1);
  assert.equal((await reopened.taskRunEvents.byTask("task-1")).length, 1);
  assert.equal((await reopened.taskRunEvents.byRun("run-1")).length, 1);
  assert.equal((await reopened.taskLiveExcerpts.byTask("task-1")).length, 1);
  assert.equal((await reopened.taskLiveExcerpts.byRun("run-1")).length, 1);
  assert.equal((await reopened.taskContentRevisions.byTask("task-1")).length, 1);
  assert.equal((await reopened.runLogs.getByRunId("run-1")).raw_output, "all good");
  assert.equal((await reopened.runLogs.byRun("run-1")).length, 1);
  assert.equal((await reopened.taskNotes.byTask("task-1")).length, 1);
  assert.equal((await reopened.approvals.byTask("task-1")).length, 1);
  assert.equal((await reopened.approvals.listPending()).length, 1);
  assert.equal((await reopened.blockers.active()).length, 1);
  assert.equal((await reopened.decisions.explain("task-1")).length, 1);
  assert.equal((await reopened.evidence.byVerdict("verdict-1")).length, 1);
  assert.equal((await reopened.ingress.byTask("task-1")).length, 1);
  assert.equal((await reopened.assignments.byTask("task-1")).length, 1);
  assert.equal((await reopened.metrics.summary()).cost.project.total_runs, 1);
  assert.equal((await reopened.metrics.summary()).budget.agents[0].budget_spent_usd, 0.5);
  assert.equal(reopened.snapshot().queueWrites.length, 1);
  assert.equal(reopened.snapshot().leaseWrites.length, 1);
  assert.equal(reopened.snapshot().approvals.length, 1);
  assert.equal(reopened.snapshot().taskRunSessions.length, 1);
  assert.equal(reopened.snapshot().taskRunEvents.length, 1);
  assert.equal(reopened.snapshot().taskLiveExcerpts.length, 1);
  assert.equal(reopened.snapshot().taskContentRevisions.length, 1);

  const checks = collectSqliteStorageChecks(databasePath);
  assert.equal(checks[0].status, "ok");

  reopened.close();
});

test("sqlite run logs spill large payloads to file refs and hydrate them on read", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-sqlite-runlog-"));
  const stateRoot = path.join(tempRoot, ".niis");
  const databasePath = createSqliteDatabasePath(stateRoot);
  const storage = createSqliteStorage({
    databasePath,
    runLogInlineBytes: 64,
  });
  const largeRawOutput = {
    status: "SUCCESS",
    summary: "x".repeat(2048),
  };
  const storedRunLog = await storage.runLogs.store({
    run_id: "run-big",
    raw_output: largeRawOutput,
    run_log: createRun().run_log,
  });

  await storage.runs.upsert({
    ...createRun(),
    id: "run-big",
    run_log: storedRunLog.run_log,
  });
  storage.close();

  const reopened = createSqliteStorage({
    databasePath,
    readonly: true,
  });
  const hydratedRunLog = await reopened.runLogs.getByRunId("run-big");
  const persistedRun = (await reopened.runs.byTask("task-1")).find((run) => run.id === "run-big");

  assert.equal(storedRunLog.run_log.storage, "ref");
  assert.equal(
    fs.existsSync(createRunLogPaths(stateRoot, "run-big").jsonArtifactPath),
    true,
  );
  assert.deepEqual(hydratedRunLog.raw_output, largeRawOutput);
  assert.equal(hydratedRunLog.raw_output_ref, ".niis/artifacts/run-logs/run-big.json");
  assert.equal(persistedRun?.run_log.storage, "ref");

  reopened.close();
});

test("sqlite storage tolerates legacy readonly databases that predate live task-card tables", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-sqlite-legacy-"));
  const stateRoot = path.join(tempRoot, ".niis");
  const databasePath = createSqliteDatabasePath(stateRoot);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const legacyDb = new Database(databasePath);
  legacyDb.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata (key, value) VALUES ('schema_version', '1');
    CREATE TABLE tasks (id TEXT PRIMARY KEY, goal_id TEXT, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE goals (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, status TEXT NOT NULL, health_status TEXT NOT NULL, last_run_at TEXT, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, payload TEXT NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, event_type TEXT NOT NULL, timestamp TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE ingress (id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, detected_at TEXT NOT NULL, ingress_status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE assignments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, assigned_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE queue_writes (sequence_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, operation TEXT NOT NULL, written_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE lease_writes (sequence_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, written_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE task_sessions (task_key TEXT PRIMARY KEY, last_run_id TEXT, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE run_logs (run_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE task_notes (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, action_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, approved_at TEXT, payload TEXT NOT NULL);
    CREATE TABLE verdicts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, verdict_class TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE evidence (id TEXT PRIMARY KEY, verdict_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE blockers (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, blocker_class TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, payload TEXT NOT NULL);
    CREATE TABLE checkpoints (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE explainability (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, timestamp TEXT NOT NULL, decision_type TEXT NOT NULL, payload TEXT NOT NULL);
  `);
  legacyDb.close();

  const reopened = createSqliteStorage({ databasePath, readonly: true });
  const snapshot = reopened.snapshot();

  assert.deepEqual(snapshot.taskRunSessions, []);
  assert.deepEqual(snapshot.taskRunEvents, []);
  assert.deepEqual(snapshot.taskLiveExcerpts, []);
  assert.deepEqual(await reopened.taskRunSessions.byTask("task-1"), []);
  assert.deepEqual(await reopened.taskRunEvents.byTask("task-1"), []);
  assert.deepEqual(await reopened.taskLiveExcerpts.byTask("task-1"), []);

  reopened.close();
});

test("tasks.deleteById removes the task and related child rows", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-sqlite-delete-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const databasePath = createSqliteDatabasePath(root);
  const storage = createSqliteStorage({ databasePath });
  await storage.tasks.upsert(createTask({ id: "task-delete", goalId: null }));
  await seedStorage(storage, {
    blockers: [{
      blocker_class: "ENV_BLOCK",
      created_at: "2026-04-01T18:20:00.000Z",
      id: "blocker-delete",
      next_action: "investigate",
      reason: "test reason",
      resolved_at: null,
      task_id: "task-delete",
    }],
  });
  const before = await storage.tasks.list();
  assert.ok(before.some((t) => t.id === "task-delete"));
  const report = await storage.tasks.deleteById("task-delete");
  assert.ok(report.deleted.includes("tasks"));
  assert.ok(report.deleted.includes("blockers"));
  const after = await storage.tasks.list();
  assert.equal(after.find((t) => t.id === "task-delete"), undefined);
  storage.close();
});

test("tasks.deleteById is a no-op for unknown task id", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-sqlite-delete-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const databasePath = createSqliteDatabasePath(root);
  const storage = createSqliteStorage({ databasePath });
  const report = await storage.tasks.deleteById("does-not-exist");
  assert.deepEqual(report.deleted, []);
  storage.close();
});
