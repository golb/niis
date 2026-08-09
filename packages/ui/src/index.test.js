import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLocalDashboardDocument,
  parseCliArguments,
  renderLocalDashboardHtml,
} from "./index.js";

function createSnapshot() {
  return {
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
    taskNotes: [
      {
        author_id: "cli:intake",
        author_type: "operator",
        content: "Release the local dashboard safely.",
        created_at: "2026-04-05T09:04:00.000Z",
        id: "note-ui",
        mentions: [],
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
  };
}

test("buildLocalDashboardDocument renders dashboard sections from snapshot data", () => {
  const html = buildLocalDashboardDocument({
    now: "2026-04-05T09:53:46.000Z",
    snapshot: createSnapshot(),
  });

  assert.match(html, /Niis Local Dashboard/);
  assert.match(html, /Scope/);
  assert.match(html, /Phase Progress/);
  assert.match(html, /Approval Blockers/);
  assert.match(html, /Task Navigation/);
  assert.match(html, /Focus Task Detail/);
  assert.match(html, /Task Detail Catalog/);
  assert.match(html, /<details class="panel-shell" open>/);
  assert.match(html, /data-task-detail="true"/);
  assert.match(html, /window\.addEventListener\("hashchange", openHashTarget\)/);
  assert.match(html, /Release local dashboard/);
  assert.match(html, /Inspect query substrate/);
  assert.match(html, /The release is blocked until operator approval is granted\./);
  assert.match(html, /The UI-capable agent was selected for the dashboard slice\./);
  assert.match(html, /Release the local dashboard safely\./);
  assert.match(html, /Grant release approval\./);
  assert.match(html, /href="#task-detail-task-release"/);
  assert.match(html, /\$0\.31/);
});

test("buildLocalDashboardDocument applies shared filters to the rendered scope", () => {
  const html = buildLocalDashboardDocument({
    filters: {
      phases: [10],
      statuses: ["BLOCKED"],
      taskIds: ["task-release"],
    },
    now: "2026-04-05T10:23:15.000Z",
    snapshot: createSnapshot(),
  });

  assert.match(html, /BLOCKED/);
  assert.match(html, /Filtered/);
  assert.match(html, /yes/);
  assert.match(html, /Release local dashboard/);
  assert.doesNotMatch(html, /Inspect query substrate/);
});

test("parseCliArguments parses repeated scope flags", () => {
  const parsed = parseCliArguments([
    "snapshot.json",
    "--status",
    "BLOCKED",
    "--phase",
    "10",
    "--task-id",
    "task-release",
    "--focus-task-id",
    "task-release",
  ]);

  assert.equal(parsed.snapshotPath, "snapshot.json");
  assert.equal(parsed.focusTaskId, "task-release");
  assert.deepEqual(parsed.filters.statuses, ["BLOCKED"]);
  assert.deepEqual(parsed.filters.phases, [10]);
  assert.deepEqual(parsed.filters.taskIds, ["task-release"]);
});

test("renderLocalDashboardHtml escapes injected content", () => {
  const html = renderLocalDashboardHtml({
    dashboard: {
      active_blockers: [],
      generated_at: "2026-04-05T09:53:46.000Z",
      pending_approvals: [],
      phase_progress: [],
      recent_runs: [],
      scope: {
        filters: {
          phases: [],
          statuses: [],
          task_ids: [],
        },
        focus_task_id: null,
        has_filters: false,
      },
      summary: {
        active_blocker_count: 0,
        pending_approval_count: 0,
        recent_run_count: 0,
        total_phases: 0,
        total_tasks: 0,
      },
      task_detail: null,
      task_details: [],
      task_navigation: [],
    },
    title: "<script>alert('x')</script>",
  });

  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
});
