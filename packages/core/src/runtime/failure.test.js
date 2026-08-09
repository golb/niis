import test from "node:test";
import assert from "node:assert/strict";

import { RoutingPlanError } from "../routing/plan-builder.js";
import { createLease } from "../scheduler/lease.js";
import {
  createFailureArtifacts,
  createFailurePolicy,
  createFailureReport,
  createIncidentSnapshot,
  detectStalledRuns,
  evaluateSelfHealing,
  normalizeFailure,
  reconcileOrphanedRuns,
} from "./failure.js";

function createRunRecord({
  id = "run-1",
  taskId = "TASK-1",
  agentId = "agent-1",
  status = "RUNNING",
  startedAt = "2026-03-21T10:00:00.000Z",
  lastProgressAt = startedAt,
} = {}) {
  return {
    id,
    task_id: taskId,
    subtask_id: null,
    agent_id: agentId,
    adapter_id: "adapter-1",
    status,
    started_at: startedAt,
    finished_at: null,
    checkpoint_id: null,
    exit_code: null,
    cost: {
      tokens_in: 0,
      tokens_out: 0,
      duration_ms: 0,
      estimated_usd: 0,
    },
    invocation_source: "retry",
    run_log: {
      storage: "inline",
      ref: null,
      bytes: 0,
      sha256: "abc123",
    },
    task_session_key: null,
    last_progress_at: lastProgressAt,
  };
}

test("normalizeFailure maps adapter env_block errors into actionable artifacts", () => {
  const failure = normalizeFailure({
    taskId: "TASK-1",
    runId: "run-1",
    now: "2026-03-21T15:40:00.000Z",
    adapterResponse: {
      status: "ERROR",
      summary: "Workspace root is invalid",
      next_actions: [],
      artifacts: [],
      cost: null,
      completion_signal: null,
      self_assessment: null,
      error: {
        root_cause: "workspace root escaped the sandbox",
        category: "env_block",
        retry_safe: false,
        retry_instruction: null,
        stop_condition: "Stop until the workspace root is corrected.",
        escalation_hint: "Fix workflow workspace settings before retrying.",
      },
    },
  });

  assert.equal(failure.failure_class, "ENVIRONMENT_BLOCK");
  assert.equal(failure.next_action, "escalate");
  assert.equal(failure.retry_safe, false);

  const artifacts = createFailureArtifacts({ failure, now: "2026-03-21T15:40:05.000Z" });
  assert.equal(artifacts.event.event_type, "ERROR");
  assert.equal(artifacts.explainability.decision_type, "BLOCKER");
  assert.equal(artifacts.blocker?.blocker_class, "ENV_BLOCK");
});

test("normalizeFailure preserves non-retryable routing incompatibility", () => {
  const routingError = new RoutingPlanError(
    "no adapter satisfies the declared routing requirements for manifest shell-worker",
    {
      code: "ROUTING_CAPABILITY_MISMATCH",
      retrySafe: false,
    },
  );
  const failure = normalizeFailure({
    taskId: "TASK-ROUTE",
    runId: "run-route",
    now: "2026-03-21T15:41:00.000Z",
    error: routingError,
  });

  assert.equal(failure.failure_class, "PERMANENT_FAILURE");
  assert.equal(failure.category, "permanent");
  assert.equal(failure.next_action, "block");
  assert.equal(failure.retry_safe, false);
  assert.equal(failure.details.error_code, "ROUTING_CAPABILITY_MISMATCH");
});

test("detectStalledRuns classifies long-running active work as recoverable stalls", () => {
  const stalledRuns = detectStalledRuns({
    activeRuns: [
      createRunRecord({
        id: "run-stalled",
        taskId: "TASK-STALL",
        startedAt: "2026-03-21T10:00:00.000Z",
        lastProgressAt: "2026-03-21T10:02:00.000Z",
      }),
      createRunRecord({
        id: "run-fresh",
        taskId: "TASK-FRESH",
        startedAt: "2026-03-21T10:25:00.000Z",
        lastProgressAt: "2026-03-21T10:29:30.000Z",
      }),
    ],
    now: "2026-03-21T10:30:00.000Z",
    stallTimeoutMs: 10 * 60 * 1000,
  });

  assert.equal(stalledRuns.length, 1);
  assert.equal(stalledRuns[0].run_id, "run-stalled");
  assert.equal(stalledRuns[0].failure_class, "STALL_DETECTED");
  assert.equal(stalledRuns[0].next_action, "recovery");
});

test("reconcileOrphanedRuns chooses resume when a checkpoint exists and retry otherwise", () => {
  const orphaned = reconcileOrphanedRuns({
    activeRuns: [
      createRunRecord({
        id: "run-with-checkpoint",
        taskId: "TASK-A",
        agentId: "agent-a",
      }),
      createRunRecord({
        id: "run-without-checkpoint",
        taskId: "TASK-B",
        agentId: "agent-b",
      }),
      createRunRecord({
        id: "run-healthy",
        taskId: "TASK-C",
        agentId: "agent-c",
      }),
    ],
    leases: [
      createLease({
        leaseId: "lease:TASK-C",
        taskId: "TASK-C",
        holder: "agent-c",
        acquiredAt: "2026-03-21T10:00:00.000Z",
        expiresAt: "2026-03-21T11:00:00.000Z",
      }),
    ],
    checkpointIdsByRunId: {
      "run-with-checkpoint": "checkpoint-1",
    },
    now: "2026-03-21T10:30:00.000Z",
  });

  assert.equal(orphaned.length, 2);
  assert.equal(orphaned[0].recovery_action, "resume");
  assert.equal(orphaned[1].recovery_action, "retry");
});

test("evaluateSelfHealing enters incident mode when crash or recovery budgets are exhausted", () => {
  const stalledFailure = normalizeFailure({
    taskId: "TASK-STALL",
    runId: "run-stall",
    kind: "stall",
    now: "2026-03-21T10:30:00.000Z",
  });
  const orphanedRun = reconcileOrphanedRuns({
    activeRuns: [createRunRecord({ id: "run-orphan", taskId: "TASK-ORPHAN" })],
    leases: [],
    checkpointIdsByRunId: {},
    now: "2026-03-21T10:30:00.000Z",
  })[0];
  const healingState = evaluateSelfHealing({
    component: "serve",
    crashHistory: [
      "2026-03-21T10:10:00.000Z",
      "2026-03-21T10:15:00.000Z",
      "2026-03-21T10:20:00.000Z",
      "2026-03-21T10:25:00.000Z",
    ],
    stalledFailures: [stalledFailure],
    orphanedRuns: [orphanedRun],
    recoveryAttempts: {
      "run-stall": 2,
    },
    now: "2026-03-21T10:30:00.000Z",
    policy: createFailurePolicy({
      maxCrashRecoveryAttempts: 3,
      maxOrphanRecoveryAttempts: 2,
      maxStallRecoveryAttempts: 2,
      stallTimeoutMs: 60000,
      crashWindowMs: 30 * 60 * 1000,
    }),
  });

  assert.equal(healingState.mode, "incident");
  assert.equal(healingState.freeze_dispatch, true);
  assert.equal(healingState.actions[0].type, "freeze_dispatch");
  assert.equal(healingState.diagnostic_snapshot.component, "serve");
});

test("createFailureReport preserves attempts, failures, fixes, and blockers", () => {
  const firstFailure = normalizeFailure({
    taskId: "TASK-1",
    runId: "run-1",
    kind: "timeout",
    error: new Error("adapter timed out"),
    now: "2026-03-21T10:30:00.000Z",
  });
  const secondFailure = normalizeFailure({
    taskId: "TASK-1",
    runId: "run-2",
    kind: "validation",
    error: new Error("invalid workspace root"),
    now: "2026-03-21T10:35:00.000Z",
  });

  const report = createFailureReport({
    taskId: "TASK-1",
    attempts: 2,
    failures: [firstFailure, secondFailure],
    attemptedFixes: ["recreated workspace", { note: "re-ran validation", actor: "runtime" }],
    blockers: ["operator approval required"],
    generatedAt: "2026-03-21T10:36:00.000Z",
  });

  assert.equal(report.attempts, 2);
  assert.equal(report.failures.length, 2);
  assert.equal(report.terminal_action, "block");
  assert.equal(report.attempted_fixes[0].note, "recreated workspace");
});

test("createIncidentSnapshot captures bounded incident diagnostics", () => {
  const snapshot = createIncidentSnapshot({
    component: "serve",
    crashHistory: ["2026-03-21T10:00:00.000Z"],
    stalledFailures: [
      normalizeFailure({
        taskId: "TASK-1",
        runId: "run-1",
        kind: "stall",
        now: "2026-03-21T10:30:00.000Z",
      }),
    ],
    orphanedRuns: [
      {
        run: createRunRecord({
          id: "run-2",
          taskId: "TASK-2",
        }),
      },
    ],
    generatedAt: "2026-03-21T10:31:00.000Z",
  });

  assert.equal(snapshot.freeze_dispatch, true);
  assert.deepEqual(snapshot.isolated_components, ["serve"]);
  assert.deepEqual(snapshot.stalled_run_ids, ["run-1"]);
  assert.deepEqual(snapshot.orphaned_run_ids, ["run-2"]);
});
