import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActivityStream,
  buildRunObservabilityView,
  buildTaskObservabilityView,
  humanizeEvent,
} from "./activity-stream.js";

function createSnapshot() {
  return {
    tasks: [{
      id: "task-1",
      title: "Task 1",
      status: "IN_PROGRESS",
      phase: 6,
      priority: "high",
      goal_id: null,
      depends_on: [],
      assigned_to: "agent-1",
      out_of_scope: [],
      rejection_count: 0,
      max_rejections: 5,
      created_at: "2026-04-01T19:00:00.000Z",
      updated_at: "2026-04-01T19:00:00.000Z",
      transition_log: [],
    }],
    runs: [{
      id: "run-1",
      task_id: "task-1",
      subtask_id: null,
      agent_id: "agent-1",
      adapter_id: "adapter-1",
      status: "COMPLETED",
      started_at: "2026-04-01T19:00:00.000Z",
      finished_at: "2026-04-01T19:02:00.000Z",
      checkpoint_id: null,
      exit_code: 0,
      cost: {
        tokens_in: 10,
        tokens_out: 20,
        duration_ms: 1000,
        estimated_usd: 1,
      },
      invocation_source: "assignment",
      run_log: {
        storage: "inline",
        ref: null,
        bytes: 32,
        sha256: "abc",
      },
      task_session_key: null,
    }],
    events: [
      {
        id: "run-1:workspace",
        run_id: "run-1",
        task_id: "task-1",
        event_type: "STATE_CHANGE",
        timestamp: "2026-04-01T19:00:10.000Z",
        actor: "runtime",
        payload: {
          lifecycle_phase: "workspace_preparation",
          phase_status: "completed",
          summary: "Workspace prepared.",
        },
      },
      {
        id: "run-1:adapter",
        run_id: "run-1",
        task_id: "task-1",
        event_type: "ADAPTER_CALL",
        timestamp: "2026-04-01T19:01:00.000Z",
        actor: "adapter-1",
        payload: {
          status: "SUCCESS",
          summary: "All good.",
        },
      },
    ],
    explainability: [{
      id: "explain-1",
      decision_type: "ROUTE",
      task_id: "task-1",
      route_chosen: "lane-1/adapter-1",
      alternatives_considered: [],
      policy_refs: ["routing/v1"],
      evidence_refs: ["run-1"],
      timestamp: "2026-04-01T19:00:20.000Z",
      human_readable_summary: "Selected lane 1.",
    }],
    approvals: [{
      id: "approval-1",
      task_id: "task-1",
      action_id: "danger.full_access",
      requested_by: "validator",
      owner_role: "operator",
      risk_level: "high",
      reason: "Operator approval is still required before the risky action may continue.",
      created_at: "2026-04-01T19:01:40.000Z",
      status: "PENDING",
      approved_at: null,
      notes: ["Need operator review."],
    }],
    blockers: [{
      id: "blocker-1",
      task_id: "task-1",
      blocker_class: "ENV_BLOCK",
      reason: "Workspace dirty",
      next_action: "Clean workspace",
      created_at: "2026-04-01T19:01:30.000Z",
      resolved_at: null,
    }],
    assignments: [{
      id: "assignment-1",
      task_id: "task-1",
      agent_id: "agent-1",
      reason_type: "manual",
      policy_ref: "runtime/serve/v1",
      assigned_at: "2026-04-01T19:00:05.000Z",
      context: "manual assignment",
    }],
    checkpoints: [{
      id: "checkpoint-1",
      run_id: "run-1",
      state_snapshot: { a: 1 },
      context_summary: "Checkpoint saved",
      created_at: "2026-04-01T19:01:10.000Z",
      resumable: true,
      resume_instructions: "resume",
    }],
    verdicts: [{
      id: "verdict-1",
      run_id: "run-1",
      task_id: "task-1",
      verdict_class: "PASS",
      reviewer_id: "validator-1",
      evidence_packet_id: "evidence-1",
      failure_attribution: "none",
      reason: "Authentic runtime evidence confirms task completion.",
      next_action: "Close the task.",
      created_at: "2026-04-01T19:02:10.000Z",
    }],
    evidence: [{
      id: "evidence-1",
      verdict_id: "verdict-1",
      items: [{
        type: "command_output",
        source: "runtime",
        content: "Focused verification passed.",
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
    runLogs: [{
      raw_output: {
        status: "SUCCESS",
        summary: "Focused runtime execution completed successfully.",
      },
      raw_output_kind: "json",
      raw_output_ref: null,
      run_id: "run-1",
      run_log: {
        bytes: 128,
        ref: null,
        sha256: "abc",
        storage: "inline",
      },
    }],
  };
}

test("humanizeEvent renders lifecycle and adapter-call summaries", () => {
  assert.equal(humanizeEvent({
    id: "event-1",
    run_id: "run-1",
    task_id: "task-1",
    event_type: "STATE_CHANGE",
    timestamp: "2026-04-01T19:00:00.000Z",
    actor: "runtime",
    payload: {
      lifecycle_phase: "workspace_preparation",
      phase_status: "completed",
    },
  }), "Lifecycle workspace preparation completed.");

  assert.match(humanizeEvent({
    id: "event-2",
    run_id: "run-1",
    task_id: "task-1",
    event_type: "ADAPTER_CALL",
    timestamp: "2026-04-01T19:00:00.000Z",
    actor: "adapter-1",
    payload: {
      status: "SUCCESS",
      summary: "Done",
    },
  }), /adapter-1 returned SUCCESS: Done/);
});

test("buildActivityStream and buildTaskObservabilityView combine persisted records into one ordered stream", () => {
  const snapshot = createSnapshot();
  const activity = buildActivityStream({
    snapshot,
    taskId: "task-1",
  });
  const view = buildTaskObservabilityView({
    snapshot,
    taskId: "task-1",
  });

  assert.equal(activity.length, 7);
  assert.equal(activity[0].source_kind, "assignment");
  assert.equal(activity[1].source_kind, "event");
  assert.equal(activity[2].source_kind, "explainability");
  assert.equal(activity[3].source_kind, "event");
  assert.equal(activity[4].source_kind, "checkpoint");
  assert.equal(activity[5].source_kind, "blocker");
  assert.equal(activity[6].source_kind, "approval");
  assert.equal(view.approvals.length, 1);
  assert.equal(view.latest_approval.status, "PENDING");
  assert.equal(view.blockers.length, 1);
  assert.equal(view.decisions.length, 1);
  assert.equal(view.verdicts.length, 1);
  assert.equal(view.latest_verdict.verdict_class, "PASS");
  assert.equal(view.evidence_packets.length, 1);
  assert.equal(view.latest_evidence_packet.authenticity_status, "VERIFIED");
  assert.equal(view.runs.length, 1);
  assert.equal(view.task.id, "task-1");
});

test("buildRunObservabilityView combines run timeline, runtime choice, validator verdicts, and artifacts", () => {
  const snapshot = createSnapshot();
  const view = buildRunObservabilityView({
    runId: "run-1",
    snapshot,
  });

  assert.equal(view.run.id, "run-1");
  assert.equal(view.task.id, "task-1");
  assert.equal(view.phases.length, 1);
  assert.equal(view.phases[0].value, "workspace preparation");
  assert.equal(view.activity.length, 3);
  assert.equal(view.activity[0].source_kind, "event");
  assert.equal(view.activity[2].source_kind, "checkpoint");
  assert.equal(view.runtime_choice.route_chosen, "lane-1/adapter-1");
  assert.equal(view.verdicts.length, 1);
  assert.equal(view.latest_verdict.verdict_class, "PASS");
  assert.equal(view.latest_evidence_packet.authenticity_status, "VERIFIED");
  assert.equal(view.run_log.raw_output.summary, "Focused runtime execution completed successfully.");
});
