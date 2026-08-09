import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskCardView } from "./task-card.js";

test("buildTaskCardView assembles a curated live task card from persisted task-run records", () => {
  const taskCard = buildTaskCardView({
    snapshot: {
      approvals: [],
      assignments: [{
        agent_id: "cli-agent",
        assigned_at: "2026-04-08T10:01:00.000Z",
        context: "Selected lane generalist with adapter codex_local.",
        id: "assignment-1",
        policy_ref: "routing/coordinator/v1",
        reason_type: "manual",
        task_id: "task-progress",
      }],
      blockers: [],
      evidence: [],
      explainability: [{
        alternatives_considered: [],
        decision_type: "GATE",
        evidence_refs: ["run-progress"],
        human_readable_summary: "completion_proof returned PASS.",
        id: "decision-1",
        policy_refs: ["validator-lane/v1"],
        route_chosen: "validator_lane:completion_proof",
        task_id: "task-progress",
        timestamp: "2026-04-08T10:16:00.000Z",
      }],
      runs: [{
        adapter_id: "codex_local",
        agent_id: "cli-agent",
        checkpoint_id: null,
        cost: {
          duration_ms: 1000,
          estimated_usd: 0.1,
          tokens_in: 10,
          tokens_out: 20,
        },
        exit_code: 0,
        finished_at: null,
        id: "run-progress",
        invocation_source: "on_demand",
        run_log: {
          bytes: 12,
          ref: null,
          sha256: "abc123",
          storage: "inline",
        },
        started_at: "2026-04-08T10:15:00.000Z",
        status: "RUNNING",
        subtask_id: null,
        task_id: "task-progress",
        task_session_key: null,
      }],
      taskLiveExcerpts: [{
        channel: "summary",
        content: "Applied the parser label update only.",
        id: "excerpt-1",
        level: "info",
        metadata: {},
        run_id: "run-progress",
        source: "codex_local",
        task_id: "task-progress",
        ts: "2026-04-08T10:15:25.000Z",
      }],
      taskNotes: [{
        author_id: "cli:intake",
        author_type: "operator",
        content: "Rename Sample Input to Sample Inputs.",
        created_at: "2026-04-08T10:00:00.000Z",
        id: "note-1",
        mentions: [],
        task_id: "task-progress",
      }],
      taskRunEvents: [{
        actor_id: "coordinator",
        actor_type: "runtime",
        event_type: "route_selected",
        id: "event-1",
        level: "info",
        payload: {
          adapter_id: "codex_local",
          lane_id: "generalist",
          summary: "Selected generalist via codex_local.",
        },
        run_id: "run-progress",
        task_id: "task-progress",
        ts: "2026-04-08T10:15:02.000Z",
        visibility: "curated",
      }],
      taskRunSessions: [{
        active_phase: "executing",
        adapter_id: "codex_local",
        finished_at: null,
        id: "task-progress:live-session",
        lane_id: "generalist",
        run_id: "run-progress",
        runtime_family: "codex_local",
        started_at: "2026-04-08T10:15:00.000Z",
        status: "executing",
        summary: "Agent execution is running via codex_local.",
        task_id: "task-progress",
        updated_at: "2026-04-08T10:15:20.000Z",
      }],
      tasks: [{
        assigned_to: null,
        created_at: "2026-04-08T10:00:00.000Z",
        depends_on: [],
        goal_id: null,
        id: "task-progress",
        max_rejections: 5,
        out_of_scope: [],
        phase: 11,
        priority: "medium",
        rejection_count: 0,
        status: "IN_PROGRESS",
        title: "Rename parser label",
        transition_log: [],
        updated_at: "2026-04-08T10:15:20.000Z",
      }],
      verdicts: [{
        created_at: "2026-04-08T10:16:10.000Z",
        evidence_packet_id: "evidence-1",
        id: "verdict-1",
        next_action: "Close the task.",
        reason: "Validator passed.",
        reviewer_id: "validator-1",
        run_id: "run-progress",
        task_id: "task-progress",
        verdict_class: "PASS",
      }],
    },
    taskId: "task-progress",
    taskWorkbenchArtifacts: {
      executionLogTail: "[2026-04-08T10:15:22.000Z] executing: Agent execution is running via codex_local.",
      executionProgress: {
        active: true,
        adapter_id: "codex_local",
        run_id: "run-progress",
        stage: "executing",
        summary: "Agent execution is running via codex_local.",
        task_id: "task-progress",
        task_status: "IN_PROGRESS",
        updated_at: "2026-04-08T10:15:22.000Z",
        verdict_class: null,
      },
      report_json_url: "/artifacts/task/task-progress/report.json",
      report_markdown_url: "/artifacts/task/task-progress/report.md",
    },
  });

  assert.equal(taskCard.task.id, "task-progress");
  assert.equal(taskCard.active_run_id, "run-progress");
  assert.equal(taskCard.run_sessions.length, 1);
  assert.equal(taskCard.live_timeline.length, 1);
  assert.equal(taskCard.live_excerpts.length, 1);
  assert.equal(taskCard.execution_progress.stage, "executing");
  assert.match(taskCard.execution_log_tail, /Agent execution is running/);
  assert.equal(taskCard.intake_prompt, "Rename Sample Input to Sample Inputs.");
  assert.equal(taskCard.artifacts.report_json_url, "/artifacts/task/task-progress/report.json");
  assert.match(taskCard.version, /2026-04-08T10:15:22.000Z/);
});
