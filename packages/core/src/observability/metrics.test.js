import assert from "node:assert/strict";
import test from "node:test";

import { buildOperationalMetricsView } from "./metrics.js";

function createSnapshot() {
  return {
    tasks: [
      {
        id: "task-1",
        title: "Task 1",
        status: "DONE",
        phase: 6,
        priority: "high",
        goal_id: null,
        depends_on: [],
        assigned_to: "agent-1",
        out_of_scope: [],
        rejection_count: 0,
        max_rejections: 5,
        created_at: "2026-04-02T05:00:00.000Z",
        updated_at: "2026-04-02T05:10:00.000Z",
        transition_log: [],
      },
      {
        id: "task-2",
        title: "Task 2",
        status: "IN_PROGRESS",
        phase: 6,
        priority: "high",
        goal_id: null,
        depends_on: [],
        assigned_to: "agent-2",
        out_of_scope: [],
        rejection_count: 0,
        max_rejections: 5,
        created_at: "2026-04-02T05:00:00.000Z",
        updated_at: "2026-04-02T05:10:00.000Z",
        transition_log: [],
      },
    ],
    agents: [
      {
        id: "agent-1",
        name: "Agent 1",
        adapter_type: "adapter-a",
        status: "ACTIVE",
        pause_condition: null,
        capabilities: ["execute"],
        budget_monthly: {
          limit_usd: 10,
          spent_usd: 8.5,
        },
        config: {},
        env_bindings: [],
        health_status: "healthy",
        last_run_id: "run-2",
        last_run_at: "2026-04-02T05:04:00.000Z",
        accumulated: {
          total_tokens_in: 30,
          total_tokens_out: 12,
          total_cost_usd: 8.5,
          total_runs: 2,
        },
        created_at: "2026-04-02T05:00:00.000Z",
        updated_at: "2026-04-02T05:04:00.000Z",
      },
      {
        id: "agent-2",
        name: "Agent 2",
        adapter_type: "adapter-b",
        status: "ACTIVE",
        pause_condition: null,
        capabilities: ["execute"],
        budget_monthly: {
          limit_usd: 5,
          spent_usd: 5,
        },
        config: {},
        env_bindings: [],
        health_status: "degraded",
        last_run_id: "run-3",
        last_run_at: "2026-04-02T05:08:00.000Z",
        accumulated: {
          total_tokens_in: 4,
          total_tokens_out: 2,
          total_cost_usd: 5,
          total_runs: 1,
        },
        created_at: "2026-04-02T05:00:00.000Z",
        updated_at: "2026-04-02T05:08:00.000Z",
      },
    ],
    runs: [
      {
        id: "run-1",
        task_id: "task-1",
        subtask_id: null,
        agent_id: "agent-1",
        adapter_id: "adapter-a",
        status: "FAILED",
        started_at: "2026-04-02T05:01:00.000Z",
        finished_at: "2026-04-02T05:02:00.000Z",
        checkpoint_id: null,
        exit_code: 1,
        cost: {
          tokens_in: 10,
          tokens_out: 4,
          duration_ms: 60000,
          estimated_usd: 3,
        },
        invocation_source: "assignment",
        run_log: {
          storage: "ref",
          ref: ".niis/artifacts/run-logs/run-1.json",
          bytes: 100,
          sha256: "a",
        },
        task_session_key: null,
      },
      {
        id: "run-2",
        task_id: "task-1",
        subtask_id: null,
        agent_id: "agent-1",
        adapter_id: "adapter-a",
        status: "COMPLETED",
        started_at: "2026-04-02T05:03:00.000Z",
        finished_at: "2026-04-02T05:04:00.000Z",
        checkpoint_id: null,
        exit_code: 0,
        cost: {
          tokens_in: 20,
          tokens_out: 8,
          duration_ms: 60000,
          estimated_usd: 5.5,
        },
        invocation_source: "retry",
        run_log: {
          storage: "ref",
          ref: ".niis/artifacts/run-logs/run-2.json",
          bytes: 100,
          sha256: "b",
        },
        task_session_key: null,
      },
      {
        id: "run-3",
        task_id: "task-2",
        subtask_id: null,
        agent_id: "agent-2",
        adapter_id: "adapter-b",
        status: "FAILED",
        started_at: "2026-04-02T05:07:00.000Z",
        finished_at: "2026-04-02T05:08:00.000Z",
        checkpoint_id: null,
        exit_code: 1,
        cost: {
          tokens_in: 4,
          tokens_out: 2,
          duration_ms: 60000,
          estimated_usd: 5,
        },
        invocation_source: "assignment",
        run_log: {
          storage: "inline",
          ref: null,
          bytes: 50,
          sha256: "c",
        },
        task_session_key: null,
      },
    ],
    events: [
      {
        id: "run-1:failure",
        run_id: "run-1",
        task_id: "task-1",
        event_type: "ERROR",
        timestamp: "2026-04-02T05:02:00.000Z",
        actor: "runtime",
        payload: {
          failure_class: "ADAPTER_ERROR",
        },
      },
      {
        id: "run-3:failure",
        run_id: "run-3",
        task_id: "task-2",
        event_type: "ERROR",
        timestamp: "2026-04-02T05:08:00.000Z",
        actor: "runtime",
        payload: {
          failure_class: "AUTH_FAILURE",
        },
      },
    ],
    queueWrites: [
      {
        task_id: "task-1",
        priority: 1,
        queued_at: "2026-04-02T05:00:30.000Z",
        claimed_by: "agent-1",
        claim_expires_at: "2026-04-02T05:05:30.000Z",
        status: "CLAIMED",
      },
      {
        task_id: "task-2",
        priority: 2,
        queued_at: "2026-04-02T05:06:00.000Z",
        claimed_by: null,
        claim_expires_at: null,
        status: "QUEUED",
      },
    ],
  };
}

test("buildOperationalMetricsView computes cost, success, retry, queue, and budget aggregates", () => {
  const metrics = buildOperationalMetricsView({
    now: "2026-04-02T05:10:00.000Z",
    snapshot: createSnapshot(),
  });

  assert.equal(metrics.cost.project.total_runs, 3);
  assert.equal(metrics.cost.project.total_estimated_usd, 13.5);
  assert.equal(metrics.success.overall.successful_tasks, 1);
  assert.equal(metrics.success.overall.tasks_with_runs, 2);
  assert.equal(metrics.retries.mean_retries_per_task, 0.5);
  assert.equal(metrics.timing.recovered_task_count, 1);
  assert.equal(metrics.failures.total_failure_events, 2);
  assert.equal(metrics.queue.queued_depth, 1);
  assert.equal(metrics.queue.claimed_depth, 1);
  assert.equal(metrics.budget.project.alert_level, "warning");
  assert.equal(metrics.budget.agents.find((agent) => agent.agent_id === "agent-2")?.alert_level, "critical");
  assert.equal(metrics.cost.per_task.find((entry) => entry.task_id === "task-1")?.retries, 1);
});
