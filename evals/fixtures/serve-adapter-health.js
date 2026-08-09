import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createInMemoryTestAdapter } from "../../packages/adapters/test-adapter.js";
import {
  createInMemoryServeStorage,
  runServeTick,
  startServeLoop,
} from "../../packages/core/src/runtime/serve.js";

const scenarioMode = process.argv[2] ?? "block";

if (!["block", "watch"].includes(scenarioMode)) {
  throw new Error(`unsupported scenario mode: ${scenarioMode}`);
}

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
    phase: 8,
    priority: "high",
    goal_id: null,
    depends_on: [],
    assigned_to: null,
    out_of_scope: [],
    rejection_count: 0,
    max_rejections: 5,
    created_at: "2026-03-21T12:35:00Z",
    updated_at: "2026-03-21T12:35:00Z",
    transition_log: [],
  };
}

function createAgent({
  id,
  status = "ACTIVE",
} = {}) {
  return {
    id,
    name: `Agent ${id}`,
    adapter_type: "in_memory",
    status,
    pause_condition: null,
    capabilities: ["execute"],
    budget_monthly: {
      limit_usd: 100,
      spent_usd: 0,
    },
    config: {},
    env_bindings: [],
    health_status: "healthy",
    last_run_id: null,
    last_run_at: null,
    accumulated: {
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_cost_usd: 0,
      total_runs: 0,
    },
    created_at: "2026-03-21T12:35:00Z",
    updated_at: "2026-03-21T12:35:00Z",
  };
}

function extractAssetSummaries(text) {
  return [...String(text ?? "").matchAll(/\b([a-z_]+:[^=,\s]+=(?:healthy|watch|failing))\b/gu)]
    .map((match) => match[1]);
}

const root = fs.mkdtempSync(path.join(process.cwd(), ".serve-adapter-health-"));
const repoRoot = path.join(root, "repo");
const workspaceRoot = path.join(root, "workspaces");
const reportPath = path.join(
  workspaceRoot,
  ".niis",
  "proofs",
  "evals",
  "proof-regression-suite.asset-health.json",
);

try {
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Fixture\n");
  runGit(repoRoot, ["init"]);
  runGit(repoRoot, ["config", "user.email", "serve-fixture@example.com"]);
  runGit(repoRoot, ["config", "user.name", "Serve Fixture"]);
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "init"]);

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    assets: [
      {
        asset_id: scenarioMode === "block" ? "adapter-route-agent" : "adapter-watch-agent",
        asset_kind: "agent",
        evidence_refs: ["proof-regression-suite:runtime-proof-baseline"],
        failed_scenarios: 0,
        passed_scenarios: 1,
        scenario_refs: [],
        status: "healthy",
      },
      {
        asset_id: scenarioMode === "block" ? "adapter-health-adapter" : "adapter-watch-adapter",
        asset_kind: "adapter",
        evidence_refs: ["proof-regression-suite:route-derived-health-assets"],
        failed_scenarios: 1,
        passed_scenarios: scenarioMode === "block" ? 0 : 1,
        scenario_refs: [],
        status: scenarioMode === "block" ? "failing" : "watch",
      },
    ],
    generated_at: "2026-03-21T12:35:00Z",
    output_path: reportPath,
    source_suite_id: "proof-regression-suite",
    summary: {
      failing: scenarioMode === "block" ? 1 : 0,
      healthy: 1,
      total: 2,
      watch: scenarioMode === "block" ? 0 : 1,
    },
  }, null, 2)}\n`);

  const storage = createInMemoryServeStorage({
    agents: [createAgent({ id: scenarioMode === "block" ? "adapter-route-agent" : "adapter-watch-agent" })],
    tasks: [createTask({ id: scenarioMode === "block" ? "task-adapter-asset-blocked" : "task-adapter-asset-watch" })],
  });

  const adapter = createInMemoryTestAdapter({
    id: scenarioMode === "block" ? "adapter-health-adapter" : "adapter-watch-adapter",
    capabilities: {
      toolFamilies: ["shell"],
    },
    scriptedResults: scenarioMode === "watch"
      ? [
        {
          completion_signal: true,
          next_actions: [],
          status: "SUCCESS",
          summary: "Watch-status adapter still completed execution.",
        },
      ]
      : [],
  });
  const started = await startServeLoop({
    adapters: [adapter],
    agentId: scenarioMode === "block" ? "adapter-route-agent" : "adapter-watch-agent",
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
          id: scenarioMode === "block" ? "adapter-asset-backlog" : "adapter-watch-backlog",
          poll: () => [
            {
              detected_at: "2026-03-21T12:35:00Z",
              id: scenarioMode === "block" ? "task-adapter-asset-blocked" : "task-adapter-asset-watch",
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
      projectPrimary: repoRoot,
      root: workspaceRoot,
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
  const taskStatus = snapshot.tasks.find((task) =>
    task.id === (scenarioMode === "block" ? "task-adapter-asset-blocked" : "task-adapter-asset-watch"))?.status ?? null;

  console.log(JSON.stringify({
    blocker_asset_summaries: [
      ...new Set(snapshot.blockers.flatMap((blocker) => extractAssetSummaries(blocker.reason))),
    ],
    dispatch_status: tick.dispatch?.status ?? null,
    explainability_asset_summaries: [
      ...new Set(snapshot.explainability.flatMap((record) => extractAssetSummaries(record.human_readable_summary))),
    ],
    explainability_routes: snapshot.explainability.map((record) => record.route_chosen),
    scenario_mode: scenarioMode,
    task_status: taskStatus,
  }, null, 2));
} finally {
  fs.rmSync(root, { force: true, recursive: true });
}
