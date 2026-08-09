import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createInMemoryTestAdapter } from "../../../adapters/test-adapter.js";
import { createSqliteDatabasePath, createSqliteStorage } from "../storage/index.js";
import { createRunLogPaths } from "../storage/run-logs.js";
import {
  SERVE_TICK_ORDER,
  createInMemoryServeStorage,
  runServeTick,
  startServeLoop,
  stopServeLoop,
} from "./serve.js";

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function createTask({
  id,
  status = "PENDING",
  title = null,
} = {}) {
  return {
    id,
    title: title ?? `Task ${id}`,
    status,
    phase: 2,
    priority: "high",
    goal_id: null,
    depends_on: [],
    assigned_to: null,
    out_of_scope: [],
    rejection_count: 0,
    max_rejections: 5,
    created_at: "2026-03-21T10:00:00Z",
    updated_at: "2026-03-21T10:00:00Z",
    transition_log: [],
  };
}

function createAgent({
  id,
  status = "ACTIVE",
  pauseCondition = null,
  healthStatus = "healthy",
  spentUsd = 0,
  limitUsd = 100,
  envBindings = [],
} = {}) {
  return {
    id,
    name: `Agent ${id}`,
    adapter_type: "in_memory",
    status,
    pause_condition: pauseCondition,
    capabilities: ["execute"],
    budget_monthly: {
      limit_usd: limitUsd,
      spent_usd: spentUsd,
    },
    config: {},
    env_bindings: envBindings,
    health_status: healthStatus,
    last_run_id: null,
    last_run_at: null,
    accumulated: {
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_cost_usd: 0,
      total_runs: 0,
    },
    created_at: "2026-03-21T10:00:00Z",
    updated_at: "2026-03-21T10:00:00Z",
  };
}

function createGitFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-serve-"));
  const repoRoot = path.join(root, "repo");
  const workspaceRoot = path.join(root, "workspaces");

  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Fixture\n");
  runGit(repoRoot, ["init"]);
  runGit(repoRoot, ["config", "user.email", "serve@example.com"]);
  runGit(repoRoot, ["config", "user.name", "Serve Test"]);
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "init"]);
  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  return {
    repoRoot,
    workspaceRoot,
  };
}

test("serve tick follows canonical order and executes route -> run inside an isolated workspace", async (t) => {
  const fixture = createGitFixture(t);
  const storage = createInMemoryServeStorage({
    agents: [createAgent({ id: "serve-agent" })],
    tasks: [createTask({ id: "task-serve-1" })],
  });
  const adapter = createInMemoryTestAdapter({
    id: "serve-test-adapter",
    capabilities: {
      toolFamilies: ["shell"],
    },
    metadata: {
      cost_tier: "standard",
    },
    scriptedResults: [
      {
        completion_signal: true,
        cost: {
          estimated_usd: 0.01,
          input_tokens: 10,
          output_tokens: 5,
        },
        next_actions: [],
        status: "SUCCESS",
        summary: "First completion confirmation.",
      },
      {
        completion_signal: true,
        cost: {
          estimated_usd: 0.01,
          input_tokens: 8,
          output_tokens: 4,
        },
        next_actions: [],
        status: "SUCCESS",
        summary: "Second completion confirmation.",
      },
    ],
  });
  const started = await startServeLoop({
    adapters: [adapter],
    agentId: "serve-agent",
    confirmationThreshold: 2,
    maxTurns: 2,
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "backlog",
          poll: () => [
            {
              detected_at: "2026-03-21T10:05:00Z",
              id: "task-serve-1",
              priority: 1,
              state: "READY",
            },
          ],
          type: "backlog_file",
          wakeSource: "automation",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      sandbox: {
        mode: "workspace-write",
      },
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T10:05:00Z");

  const tick = await runServeTick({
    config: started.config,
    now: "2026-03-21T10:05:00Z",
    state: started.state,
  });
  const shutdown = await stopServeLoop(started.config, tick.state, "2026-03-21T10:05:10Z");
  const snapshot = storage.snapshot();

  assert.deepEqual(
    tick.phases.map((phase) => phase.name),
    SERVE_TICK_ORDER,
  );
  assert.equal(tick.dispatch?.status, "EXECUTED");
  assert.equal(snapshot.tasks.find((task) => task.id === "task-serve-1")?.status, "IN_REVIEW");
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].status, "COMPLETED");
  assert.equal(snapshot.assignments.some((assignment) => assignment.task_id === "task-serve-1"), true);
  assert.equal(snapshot.events.some((event) => event.run_id === "serve:shutdown"), true);
  assert.equal(shutdown.event.run_id, "serve:shutdown");
  assert.deepEqual(fs.readdirSync(fixture.workspaceRoot), []);
});

test("serve persists large run logs as file refs in sqlite-backed storage", async (t) => {
  const fixture = createGitFixture(t);
  const stateRoot = path.join(path.dirname(fixture.workspaceRoot), ".niis");
  const storage = createSqliteStorage({
    databasePath: createSqliteDatabasePath(stateRoot),
    runLogInlineBytes: 64,
  });
  const adapter = createInMemoryTestAdapter({
    id: "serve-sqlite-adapter",
    capabilities: {
      toolFamilies: ["shell"],
    },
    metadata: {
      cost_tier: "standard",
    },
    scriptedResults: [
      {
        completion_signal: true,
        cost: {
          estimated_usd: 0.01,
          input_tokens: 12,
          output_tokens: 8,
        },
        next_actions: [],
        status: "SUCCESS",
        summary: "x".repeat(2048),
      },
    ],
  });

  await storage.agents.upsert(createAgent({ id: "serve-agent" }));
  await storage.tasks.upsert(createTask({ id: "task-serve-sqlite" }));

  const started = await startServeLoop({
    adapters: [adapter],
    agentId: "serve-agent",
    confirmationThreshold: 1,
    maxTurns: 1,
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "backlog",
          poll: () => [
            {
              detected_at: "2026-03-21T10:15:00Z",
              id: "task-serve-sqlite",
              priority: 1,
              state: "READY",
            },
          ],
          type: "backlog_file",
          wakeSource: "automation",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T10:15:00Z");
  const tick = await runServeTick({
    config: started.config,
    now: "2026-03-21T10:15:00Z",
    state: started.state,
  });
  const snapshot = storage.snapshot();
  const runId = snapshot.runs[0].id;
  const persistedRunLog = await storage.runLogs.getByRunId(runId);
  const runLogPaths = createRunLogPaths(stateRoot, runId);

  assert.equal(tick.dispatch?.status, "EXECUTED");
  assert.equal(snapshot.runs[0].run_log.storage, "ref");
  assert.equal(fs.existsSync(runLogPaths.jsonArtifactPath), true);
  assert.equal(snapshot.runs[0].run_log.ref, persistedRunLog.raw_output_ref);
  assert.equal(persistedRunLog.run_log.storage, "ref");
  assert.equal(typeof persistedRunLog.raw_output.summary, "string");
  assert.equal(persistedRunLog.raw_output.summary.length, 2048);

  storage.close();
});

test("serve startup resolves agent secret refs during adapter diagnostics", async (t) => {
  const fixture = createGitFixture(t);
  const storage = createInMemoryServeStorage({
    agents: [
      createAgent({
        envBindings: [
          {
            key: "OPENAI_API_KEY",
            type: "secret_ref",
            value: "secret://local/agent/serve-agent/openai-api-key",
          },
          {
            key: "NIIS_LOG_LEVEL",
            type: "plain",
            value: "debug",
          },
        ],
        id: "serve-agent",
      }),
    ],
    tasks: [],
  });
  const adapter = createInMemoryTestAdapter({
    id: "startup-secret-adapter",
    capabilities: {
      optionalEnv: [
        {
          key: "NIIS_LOG_LEVEL",
          description: "Log level",
        },
      ],
      requiredEnv: [
        {
          key: "OPENAI_API_KEY",
          description: "API key",
          sensitive: true,
        },
      ],
    },
  });

  await startServeLoop({
    adapters: [adapter],
    agentId: "serve-agent",
    secretStore: {
      "secret://local/agent/serve-agent/openai-api-key": "sk-test-secret",
    },
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "empty",
          poll: () => [],
          type: "backlog_file",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T10:10:00Z");

  assert.deepEqual(adapter.getHistory().map((entry) => entry.type), ["test"]);
  assert.deepEqual(adapter.getHistory()[0].env, {
    OPENAI_API_KEY: "sk-test-secret",
    NIIS_LOG_LEVEL: "debug",
  });
});

test("serve reconciliation auto-resumes eligible paused agents before dispatch", async (t) => {
  const fixture = createGitFixture(t);
  const storage = createInMemoryServeStorage({
    agents: [
      createAgent({
        id: "paused-agent",
        status: "PAUSED",
        pauseCondition: {
          reason: "budget_exhausted",
          cleared_at: null,
          auto_resume_eligible: true,
        },
        spentUsd: 10,
      }),
    ],
    tasks: [],
  });
  const started = await startServeLoop({
    adapters: [createInMemoryTestAdapter({ id: "resume-adapter" })],
    agentId: "paused-agent",
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "empty",
          poll: () => [],
          type: "backlog_file",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T11:00:00Z");

  const tick = await runServeTick({
    config: started.config,
    now: "2026-03-21T11:00:00Z",
    state: started.state,
  });
  const snapshot = storage.snapshot();

  assert.equal(snapshot.agents.find((agent) => agent.id === "paused-agent")?.status, "ACTIVE");
  assert.equal(
    snapshot.assignments.some(
      (assignment) =>
        assignment.task_id === "runtime:serve" && assignment.agent_id === "paused-agent",
    ),
    true,
  );
  assert.equal(tick.dispatch, null);
  assert.deepEqual(
    tick.phases.map((phase) => phase.name),
    SERVE_TICK_ORDER,
  );
});

test("serve pauses an over-budget agent before dispatch and creates a runtime blocker", async (t) => {
  const fixture = createGitFixture(t);
  const storage = createInMemoryServeStorage({
    agents: [
      createAgent({
        id: "budget-agent",
        limitUsd: 1,
        spentUsd: 1,
      }),
    ],
    tasks: [
      createTask({ id: "task-budget-blocked" }),
    ],
  });
  const started = await startServeLoop({
    adapters: [createInMemoryTestAdapter({ id: "budget-adapter" })],
    agentId: "budget-agent",
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "budget-backlog",
          poll: () => [
            {
              detected_at: "2026-03-21T12:00:00Z",
              id: "task-budget-blocked",
              priority: 1,
              state: "READY",
            },
          ],
          type: "backlog_file",
          wakeSource: "automation",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T12:00:00Z");

  const tick = await runServeTick({
    config: started.config,
    now: "2026-03-21T12:00:00Z",
    state: started.state,
  });
  const snapshot = storage.snapshot();
  const pausedAgent = snapshot.agents.find((agent) => agent.id === "budget-agent");

  assert.equal(tick.dispatch, null);
  assert.equal(pausedAgent?.status, "PAUSED");
  assert.equal(pausedAgent?.pause_condition?.reason, "budget_exhausted");
  assert.equal(snapshot.tasks.find((task) => task.id === "task-budget-blocked")?.status, "PENDING");
  assert.equal(
    snapshot.blockers.some(
      (blocker) =>
        blocker.task_id === "runtime:serve"
        && blocker.reason.includes("budget-agent exhausted its monthly budget"),
    ),
    true,
  );
});

test("serve skips dispatch when the asset-health gate marks the active agent as failing", async (t) => {
  const fixture = createGitFixture(t);
  const reportPath = path.join(
    fixture.workspaceRoot,
    ".niis",
    "proofs",
    "evals",
    "proof-regression-suite.asset-health.json",
  );

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    assets: [
      {
        asset_id: "failing-agent",
        asset_kind: "agent",
        evidence_refs: ["proof-regression-suite:runtime-proof-baseline"],
        failed_scenarios: 1,
        passed_scenarios: 0,
        scenario_refs: [],
        status: "failing",
      },
    ],
    generated_at: "2026-03-21T12:15:00Z",
    output_path: reportPath,
    source_suite_id: "proof-regression-suite",
    summary: {
      failing: 1,
      healthy: 0,
      total: 1,
      watch: 0,
    },
  }, null, 2)}\n`);
  const storage = createInMemoryServeStorage({
    agents: [createAgent({ id: "failing-agent" })],
    tasks: [createTask({ id: "task-asset-health-blocked" })],
  });
  const started = await startServeLoop({
    adapters: [createInMemoryTestAdapter({ id: "asset-health-adapter" })],
    agentId: "failing-agent",
    routingPolicy: {
      assetHealthGate: {
        enabled: true,
        reportPath,
      },
    },
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "asset-health-backlog",
          poll: () => [
            {
              detected_at: "2026-03-21T12:15:00Z",
              id: "task-asset-health-blocked",
              priority: 1,
              state: "READY",
            },
          ],
          type: "backlog_file",
          wakeSource: "automation",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T12:15:00Z");

  const tick = await runServeTick({
    config: started.config,
    now: "2026-03-21T12:15:00Z",
    state: started.state,
  });
  const snapshot = storage.snapshot();

  assert.equal(tick.dispatch, null);
  assert.equal(
    snapshot.tasks.find((task) => task.id === "task-asset-health-blocked")?.status,
    "PENDING",
  );
  assert.equal(
    snapshot.blockers.some(
      (blocker) =>
        blocker.task_id === "runtime:serve"
        && blocker.reason.includes("agent:failing-agent=failing"),
    ),
    true,
  );
  assert.equal(
    snapshot.explainability.some(
      (record) => record.route_chosen === "serve:skip-dispatch:asset-health",
    ),
    true,
  );
});

test("serve records watch-status asset-health explainability while allowing dispatch", async (t) => {
  const fixture = createGitFixture(t);
  const reportPath = path.join(
    fixture.workspaceRoot,
    ".niis",
    "proofs",
    "evals",
    "proof-regression-suite.asset-health.json",
  );

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    assets: [
      {
        asset_id: "watch-agent",
        asset_kind: "agent",
        evidence_refs: ["proof-regression-suite:runtime-proof-baseline"],
        failed_scenarios: 1,
        passed_scenarios: 1,
        scenario_refs: [],
        status: "watch",
      },
    ],
    generated_at: "2026-03-21T12:20:00Z",
    output_path: reportPath,
    source_suite_id: "proof-regression-suite",
    summary: {
      failing: 0,
      healthy: 0,
      total: 1,
      watch: 1,
    },
  }, null, 2)}\n`);
  const storage = createInMemoryServeStorage({
    agents: [createAgent({ id: "watch-agent" })],
    tasks: [createTask({ id: "task-asset-health-watch" })],
  });
  const adapter = createInMemoryTestAdapter({
    id: "watch-asset-health-adapter",
    capabilities: {
      toolFamilies: ["shell"],
    },
    scriptedResults: [
      {
        completion_signal: true,
        next_actions: [],
        status: "SUCCESS",
        summary: "Watch-status execution still completed.",
      },
    ],
  });
  const started = await startServeLoop({
    adapters: [adapter],
    agentId: "watch-agent",
    routingPolicy: {
      assetHealthGate: {
        enabled: true,
        reportPath,
      },
    },
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "asset-health-watch-backlog",
          poll: () => [
            {
              detected_at: "2026-03-21T12:20:00Z",
              id: "task-asset-health-watch",
              priority: 1,
              state: "READY",
            },
          ],
          type: "backlog_file",
          wakeSource: "automation",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T12:20:00Z");

  const tick = await runServeTick({
    config: started.config,
    now: "2026-03-21T12:20:00Z",
    state: started.state,
  });
  const snapshot = storage.snapshot();

  assert.equal(tick.dispatch?.status, "EXECUTED");
  assert.equal(
    snapshot.explainability.some(
      (record) => record.route_chosen === "serve:allow-dispatch:asset-health-watch",
    ),
    true,
  );
  assert.equal(
    snapshot.tasks.find((task) => task.id === "task-asset-health-watch")?.status,
    "IN_REVIEW",
  );
});

test("serve skips dispatch when a declared additional asset is failing", async (t) => {
  const fixture = createGitFixture(t);
  const reportPath = path.join(
    fixture.workspaceRoot,
    ".niis",
    "proofs",
    "evals",
    "proof-regression-suite.asset-health.json",
  );

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    assets: [
      {
        asset_id: "prompt-agent",
        asset_kind: "agent",
        evidence_refs: ["proof-regression-suite:runtime-proof-baseline"],
        failed_scenarios: 0,
        passed_scenarios: 1,
        scenario_refs: [],
        status: "healthy",
      },
      {
        asset_id: "runtime-default-prompt-surface",
        asset_kind: "prompt",
        evidence_refs: ["proof-regression-suite:prompt-surface-health"],
        failed_scenarios: 1,
        passed_scenarios: 0,
        scenario_refs: [],
        status: "failing",
      },
    ],
    generated_at: "2026-03-21T12:25:00Z",
    output_path: reportPath,
    source_suite_id: "proof-regression-suite",
    summary: {
      failing: 1,
      healthy: 1,
      total: 2,
      watch: 0,
    },
  }, null, 2)}\n`);
  const storage = createInMemoryServeStorage({
    agents: [createAgent({ id: "prompt-agent" })],
    tasks: [createTask({ id: "task-additional-asset-blocked" })],
  });
  const started = await startServeLoop({
    adapters: [createInMemoryTestAdapter({ id: "additional-asset-adapter" })],
    agentId: "prompt-agent",
    routingPolicy: {
      assetHealthGate: {
        additionalAssets: [
          {
            assetId: "runtime-default-prompt-surface",
            assetKind: "prompt",
          },
        ],
        enabled: true,
        reportPath,
      },
    },
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "additional-asset-backlog",
          poll: () => [
            {
              detected_at: "2026-03-21T12:25:00Z",
              id: "task-additional-asset-blocked",
              priority: 1,
              state: "READY",
            },
          ],
          type: "backlog_file",
          wakeSource: "automation",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T12:25:00Z");

  const tick = await runServeTick({
    config: started.config,
    now: "2026-03-21T12:25:00Z",
    state: started.state,
  });
  const snapshot = storage.snapshot();

  assert.equal(tick.dispatch, null);
  assert.equal(
    snapshot.blockers.some(
      (blocker) =>
        blocker.task_id === "runtime:serve"
        && blocker.reason.includes("prompt:runtime-default-prompt-surface=failing"),
    ),
    true,
  );
  assert.equal(
    snapshot.explainability.some(
      (record) =>
        record.route_chosen === "serve:skip-dispatch:asset-health"
        && record.human_readable_summary.includes("prompt:runtime-default-prompt-surface=failing"),
    ),
    true,
  );
});

test("serve skips dispatch when the selected route manifest declares a failing related asset", async (t) => {
  const fixture = createGitFixture(t);
  const reportPath = path.join(
    fixture.workspaceRoot,
    ".niis",
    "proofs",
    "evals",
    "proof-regression-suite.asset-health.json",
  );

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    assets: [
      {
        asset_id: "route-agent",
        asset_kind: "agent",
        evidence_refs: ["proof-regression-suite:runtime-proof-baseline"],
        failed_scenarios: 0,
        passed_scenarios: 1,
        scenario_refs: [],
        status: "healthy",
      },
      {
        asset_id: "runtime-default-prompt-surface",
        asset_kind: "prompt",
        evidence_refs: ["proof-regression-suite:prompt-surface-health"],
        failed_scenarios: 1,
        passed_scenarios: 0,
        scenario_refs: [],
        status: "failing",
      },
    ],
    generated_at: "2026-03-21T12:30:00Z",
    output_path: reportPath,
    source_suite_id: "proof-regression-suite",
    summary: {
      failing: 1,
      healthy: 1,
      total: 2,
      watch: 0,
    },
  }, null, 2)}\n`);
  const storage = createInMemoryServeStorage({
    agents: [createAgent({ id: "route-agent" })],
    tasks: [
      createTask({
        id: "task-route-derived-asset-blocked",
        title: "Update the UI route",
      }),
    ],
  });
  const started = await startServeLoop({
    adapters: [createInMemoryTestAdapter({ id: "route-derived-asset-adapter", capabilities: { toolFamilies: ["shell"] } })],
    agentId: "route-agent",
    roleManifests: [
      {
        healthAssets: [
          {
            assetId: "runtime-default-prompt-surface",
            assetKind: "prompt",
          },
        ],
        id: "frontend-specialist",
        keywords: ["ui", "frontend"],
        lane: "frontend",
        priority: 10,
        toolFamilies: ["shell"],
      },
      {
        id: "default-generalist",
        lane: "generalist",
        safe_fallback: true,
      },
    ],
    routingPolicy: {
      assetHealthGate: {
        enabled: true,
        reportPath,
      },
    },
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "route-derived-asset-backlog",
          poll: () => [
            {
              detected_at: "2026-03-21T12:30:00Z",
              id: "task-route-derived-asset-blocked",
              priority: 1,
              state: "READY",
            },
          ],
          type: "backlog_file",
          wakeSource: "automation",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T12:30:00Z");

  const tick = await runServeTick({
    config: started.config,
    now: "2026-03-21T12:30:00Z",
    state: started.state,
  });
  const snapshot = storage.snapshot();

  assert.equal(tick.dispatch?.status, "ASSET_HEALTH_BLOCKED");
  assert.equal(
    snapshot.tasks.find((task) => task.id === "task-route-derived-asset-blocked")?.status,
    "BLOCKED",
  );
  assert.equal(
    snapshot.blockers.some(
      (blocker) =>
        blocker.task_id === "task-route-derived-asset-blocked"
        && blocker.reason.includes("prompt:runtime-default-prompt-surface=failing"),
    ),
    true,
  );
  assert.equal(
    snapshot.explainability.some(
      (record) =>
        record.route_chosen === "serve:skip-dispatch:route-asset-health"
        && record.task_id === "task-route-derived-asset-blocked",
    ),
    true,
  );
});

test("serve skips dispatch when the selected adapter asset is failing", async (t) => {
  const fixture = createGitFixture(t);
  const reportPath = path.join(
    fixture.workspaceRoot,
    ".niis",
    "proofs",
    "evals",
    "proof-regression-suite.asset-health.json",
  );

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    assets: [
      {
        asset_id: "adapter-route-agent",
        asset_kind: "agent",
        evidence_refs: ["proof-regression-suite:runtime-proof-baseline"],
        failed_scenarios: 0,
        passed_scenarios: 1,
        scenario_refs: [],
        status: "healthy",
      },
      {
        asset_id: "adapter-health-adapter",
        asset_kind: "adapter",
        evidence_refs: ["proof-regression-suite:route-derived-health-assets"],
        failed_scenarios: 1,
        passed_scenarios: 0,
        scenario_refs: [],
        status: "failing",
      },
    ],
    generated_at: "2026-03-21T12:35:00Z",
    output_path: reportPath,
    source_suite_id: "proof-regression-suite",
    summary: {
      failing: 1,
      healthy: 1,
      total: 2,
      watch: 0,
    },
  }, null, 2)}\n`);
  const storage = createInMemoryServeStorage({
    agents: [createAgent({ id: "adapter-route-agent" })],
    tasks: [createTask({ id: "task-adapter-asset-blocked" })],
  });
  const started = await startServeLoop({
    adapters: [createInMemoryTestAdapter({ id: "adapter-health-adapter", capabilities: { toolFamilies: ["shell"] } })],
    agentId: "adapter-route-agent",
    routingPolicy: {
      assetHealthGate: {
        enabled: true,
        reportPath,
      },
    },
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "adapter-asset-backlog",
          poll: () => [
            {
              detected_at: "2026-03-21T12:35:00Z",
              id: "task-adapter-asset-blocked",
              priority: 1,
              state: "READY",
            },
          ],
          type: "backlog_file",
          wakeSource: "automation",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T12:35:00Z");

  const tick = await runServeTick({
    config: started.config,
    now: "2026-03-21T12:35:00Z",
    state: started.state,
  });
  const snapshot = storage.snapshot();

  assert.equal(tick.dispatch?.status, "ASSET_HEALTH_BLOCKED");
  assert.equal(
    snapshot.tasks.find((task) => task.id === "task-adapter-asset-blocked")?.status,
    "BLOCKED",
  );
  assert.equal(
    snapshot.blockers.some(
      (blocker) =>
        blocker.task_id === "task-adapter-asset-blocked"
        && blocker.reason.includes("adapter:adapter-health-adapter=failing"),
    ),
    true,
  );
  assert.equal(
    snapshot.explainability.some(
      (record) =>
        record.route_chosen === "serve:skip-dispatch:route-asset-health"
        && record.human_readable_summary.includes("adapter:adapter-health-adapter=failing"),
    ),
    true,
  );
});

test("serve records watch-status explainability when the selected adapter asset is watch", async (t) => {
  const fixture = createGitFixture(t);
  const reportPath = path.join(
    fixture.workspaceRoot,
    ".niis",
    "proofs",
    "evals",
    "proof-regression-suite.asset-health.json",
  );

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    assets: [
      {
        asset_id: "adapter-watch-agent",
        asset_kind: "agent",
        evidence_refs: ["proof-regression-suite:runtime-proof-baseline"],
        failed_scenarios: 0,
        passed_scenarios: 1,
        scenario_refs: [],
        status: "healthy",
      },
      {
        asset_id: "adapter-watch-adapter",
        asset_kind: "adapter",
        evidence_refs: ["proof-regression-suite:route-derived-health-assets"],
        failed_scenarios: 1,
        passed_scenarios: 1,
        scenario_refs: [],
        status: "watch",
      },
    ],
    generated_at: "2026-03-21T12:40:00Z",
    output_path: reportPath,
    source_suite_id: "proof-regression-suite",
    summary: {
      failing: 0,
      healthy: 1,
      total: 2,
      watch: 1,
    },
  }, null, 2)}\n`);
  const storage = createInMemoryServeStorage({
    agents: [createAgent({ id: "adapter-watch-agent" })],
    tasks: [createTask({ id: "task-adapter-asset-watch" })],
  });
  const adapter = createInMemoryTestAdapter({
    id: "adapter-watch-adapter",
    capabilities: {
      toolFamilies: ["shell"],
    },
    scriptedResults: [
      {
        completion_signal: true,
        next_actions: [],
        status: "SUCCESS",
        summary: "Watch-status adapter still completed execution.",
      },
    ],
  });
  const started = await startServeLoop({
    adapters: [adapter],
    agentId: "adapter-watch-agent",
    routingPolicy: {
      assetHealthGate: {
        enabled: true,
        reportPath,
      },
    },
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "adapter-watch-backlog",
          poll: () => [
            {
              detected_at: "2026-03-21T12:40:00Z",
              id: "task-adapter-asset-watch",
              priority: 1,
              state: "READY",
            },
          ],
          type: "backlog_file",
          wakeSource: "automation",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T12:40:00Z");

  const tick = await runServeTick({
    config: started.config,
    now: "2026-03-21T12:40:00Z",
    state: started.state,
  });
  const snapshot = storage.snapshot();

  assert.equal(tick.dispatch?.status, "EXECUTED");
  assert.equal(
    snapshot.explainability.some(
      (record) =>
        record.route_chosen === "serve:allow-dispatch:route-asset-health-watch"
        && record.human_readable_summary.includes("adapter:adapter-watch-adapter=watch"),
    ),
    true,
  );
  assert.equal(
    snapshot.tasks.find((task) => task.id === "task-adapter-asset-watch")?.status,
    "IN_REVIEW",
  );
});

test("serve auto-pauses an agent when a run exhausts the monthly budget", async (t) => {
  const fixture = createGitFixture(t);
  const storage = createInMemoryServeStorage({
    agents: [
      createAgent({
        id: "threshold-agent",
        limitUsd: 1,
        spentUsd: 0.96,
      }),
    ],
    tasks: [
      createTask({ id: "task-budget-crossing" }),
    ],
  });
  const adapter = createInMemoryTestAdapter({
    id: "threshold-adapter",
    capabilities: {
      toolFamilies: ["shell"],
    },
    scriptedResults: [
      {
        completion_signal: true,
        cost: {
          estimated_usd: 0.06,
          input_tokens: 10,
          output_tokens: 5,
        },
        next_actions: [],
        status: "SUCCESS",
        summary: "Budget cap crossed during execution.",
      },
    ],
  });
  const started = await startServeLoop({
    adapters: [adapter],
    agentId: "threshold-agent",
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "threshold-backlog",
          poll: () => [
            {
              detected_at: "2026-03-21T12:30:00Z",
              id: "task-budget-crossing",
              priority: 1,
              state: "READY",
            },
          ],
          type: "backlog_file",
          wakeSource: "automation",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T12:30:00Z");

  const tick = await runServeTick({
    config: started.config,
    now: "2026-03-21T12:30:00Z",
    state: started.state,
  });
  const snapshot = storage.snapshot();
  const pausedAgent = snapshot.agents.find((agent) => agent.id === "threshold-agent");

  assert.equal(tick.dispatch?.status, "EXECUTED");
  assert.equal(pausedAgent?.status, "PAUSED");
  assert.equal(pausedAgent?.pause_condition?.reason, "budget_exhausted");
  assert.equal(pausedAgent?.budget_monthly?.spent_usd, 1.02);
  assert.equal(
    snapshot.blockers.some(
      (blocker) =>
        blocker.task_id === "runtime:serve"
        && blocker.reason.includes("threshold-agent exhausted its monthly budget"),
    ),
    true,
  );
  assert.equal(
    snapshot.explainability.some((record) => record.route_chosen === "agent:budget-exhausted"),
    true,
  );
});

test("serve reconcile schedules periodic backups and does not repeat them before the interval", async (t) => {
  const fixture = createGitFixture(t);
  const stateRoot = path.join(path.dirname(fixture.workspaceRoot), ".niis");
  const storage = createInMemoryServeStorage({
    agents: [createAgent({ id: "backup-agent" })],
    tasks: [],
  });

  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "state.json"), JSON.stringify({ ok: true }));

  const started = await startServeLoop({
    adapters: [createInMemoryTestAdapter({ id: "backup-adapter" })],
    agentId: "backup-agent",
    backupRuntime: {
      intervalMs: 60_000,
      stateRoot,
    },
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "empty",
          poll: () => [],
          type: "backlog_file",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T13:00:00Z");

  const firstTick = await runServeTick({
    config: started.config,
    now: "2026-03-21T13:00:00Z",
    state: started.state,
  });
  const secondTick = await runServeTick({
    config: started.config,
    now: "2026-03-21T13:00:30Z",
    state: firstTick.state,
  });
  const backupsRoot = path.join(stateRoot, "backups");
  const backups = fs.readdirSync(backupsRoot);

  assert.ok(firstTick.reconciliation.periodicBackup.backup);
  assert.equal(secondTick.reconciliation.periodicBackup.backup, null);
  assert.equal(backups.length, 1);
  assert.equal(
    storage.snapshot().events.some((event) => event.payload?.action === "periodic_backup"),
    true,
  );
});

test("serve emits canonical live event envelopes for persisted events", async (t) => {
  const fixture = createGitFixture(t);
  const storage = createInMemoryServeStorage({
    agents: [createAgent({ id: "events-agent" })],
    tasks: [createTask({ id: "task-live-events" })],
  });
  const emittedEvents = [];
  const adapter = createInMemoryTestAdapter({
    id: "events-adapter",
    capabilities: {
      toolFamilies: ["shell"],
    },
    scriptedResults: [
      {
        completion_signal: true,
        cost: {
          estimated_usd: 0.01,
          input_tokens: 5,
          output_tokens: 3,
        },
        next_actions: [],
        status: "SUCCESS",
        summary: "Emit a few runtime events.",
      },
    ],
  });
  const started = await startServeLoop({
    adapters: [adapter],
    agentId: "events-agent",
    liveEventSink: {
      emitBatch(events) {
        emittedEvents.push(...events);
      },
    },
    storage,
    watchConfig: {
      taskSources: [
        {
          id: "events-backlog",
          poll: () => [
            {
              detected_at: "2026-03-21T13:30:00Z",
              id: "task-live-events",
              priority: 1,
              state: "READY",
            },
          ],
          type: "backlog_file",
          wakeSource: "automation",
        },
      ],
    },
    workspace: {
      projectPrimary: fixture.repoRoot,
      root: fixture.workspaceRoot,
      strategy: {
        mode: "branch",
      },
    },
  }, "2026-03-21T13:30:00Z");

  const tick = await runServeTick({
    config: started.config,
    now: "2026-03-21T13:30:00Z",
    state: started.state,
  });
  await stopServeLoop(started.config, tick.state, "2026-03-21T13:30:10Z");

  assert.equal(tick.dispatch?.status, "EXECUTED");
  assert.equal(emittedEvents.length > 0, true);
  assert.equal(typeof emittedEvents[0].event_id, "string");
  assert.equal(typeof emittedEvents[0].event_type, "string");
  assert.equal(typeof emittedEvents[0].timestamp, "string");
  assert.equal(typeof emittedEvents[0].payload.actor, "string");
  assert.equal(typeof emittedEvents[0].payload.run_id, "string");
  assert.equal(typeof emittedEvents[0].payload.task_id, "string");
  assert.equal(typeof emittedEvents[0].payload.data, "object");
});
