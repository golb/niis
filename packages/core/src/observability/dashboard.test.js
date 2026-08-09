import test from "node:test";
import assert from "node:assert/strict";

import { buildDashboardView } from "./dashboard.js";

function createTask(overrides = {}) {
  return {
    assigned_to: null,
    created_at: "2026-04-05T08:00:00.000Z",
    depends_on: [],
    goal_id: null,
    id: "task-default",
    max_rejections: 5,
    out_of_scope: [],
    phase: 10,
    priority: "medium",
    rejection_count: 0,
    status: "PENDING",
    title: "Default task",
    transition_log: [],
    updated_at: "2026-04-05T08:00:00.000Z",
    ...overrides,
  };
}

function createRun(overrides = {}) {
  return {
    adapter_id: "codex_local",
    agent_id: "agent-1",
    checkpoint_id: null,
    cost: {
      duration_ms: 1200,
      estimated_usd: 0.12,
      tokens_in: 10,
      tokens_out: 20,
    },
    exit_code: 0,
    finished_at: "2026-04-05T09:05:00.000Z",
    id: "run-default",
    invocation_source: "on_demand",
    run_log: {
      bytes: 42,
      ref: null,
      sha256: "abc123",
      storage: "inline",
    },
    started_at: "2026-04-05T09:00:00.000Z",
    status: "COMPLETED",
    subtask_id: null,
    task_id: "task-default",
    task_session_key: null,
    ...overrides,
  };
}

function createBlocker(overrides = {}) {
  return {
    blocker_class: "ENV_BLOCK",
    created_at: "2026-04-05T09:10:00.000Z",
    id: "blocker-default",
    next_action: "Retry once the environment is stable.",
    reason: "The adapter environment is not available.",
    resolved_at: null,
    task_id: "task-default",
    ...overrides,
  };
}

function createApproval(overrides = {}) {
  return {
    action_id: "blocker-default",
    approved_at: null,
    created_at: "2026-04-05T09:12:30.000Z",
    id: "approval-default",
    notes: [],
    owner_role: "operator",
    reason: "Operator approval is still required before the task may continue.",
    requested_by: "validator",
    risk_level: "high",
    status: "PENDING",
    task_id: "task-default",
    ...overrides,
  };
}

function createExplainability(overrides = {}) {
  return {
    alternatives_considered: [],
    decision_type: "ROUTE",
    evidence_refs: [],
    human_readable_summary: "Coordinator routed the task to the default lane.",
    id: "decision-default",
    policy_refs: ["policy.route.default"],
    route_chosen: "default_lane",
    task_id: "task-default",
    timestamp: "2026-04-05T09:07:00.000Z",
    ...overrides,
  };
}

function createAssignment(overrides = {}) {
  return {
    agent_id: "agent-1",
    assigned_at: "2026-04-05T09:06:00.000Z",
    context: "Selected because the task matches the local dashboard route.",
    id: "assignment-default",
    policy_ref: "policy.route.default",
    reason_type: "manual",
    task_id: "task-default",
    ...overrides,
  };
}

function createEvent(overrides = {}) {
  return {
    actor: "runtime",
    event_type: "STATE_CHANGE",
    id: "event-default",
    payload: {
      from_status: "PENDING",
      to_status: "IN_PROGRESS",
    },
    run_id: "run-default",
    task_id: "task-default",
    timestamp: "2026-04-05T09:09:00.000Z",
    ...overrides,
  };
}

function createTaskNote(overrides = {}) {
  return {
    author_id: "cli:intake",
    author_type: "operator",
    content: "Ship the dashboard safely.",
    created_at: "2026-04-05T09:04:00.000Z",
    id: "note-default",
    mentions: [],
    task_id: "task-default",
    ...overrides,
  };
}

test("buildDashboardView summarizes phase progress, blockers, approvals, and recent runs", () => {
  const dashboard = buildDashboardView({
    now: "2026-04-05T09:53:46.000Z",
    recentBlockerLimit: 10,
    recentRunLimit: 10,
    snapshot: {
      approvals: [
        createApproval({
          action_id: "blocker-approval",
          id: "approval-release",
          task_id: "task-approve",
        }),
      ],
      blockers: [
        createBlocker({
          blocker_class: "MISSING_APPROVAL",
          created_at: "2026-04-05T09:12:00.000Z",
          id: "blocker-approval",
          next_action: "Grant deploy approval.",
          reason: "Deploy approval is still required.",
          task_id: "task-approve",
        }),
        createBlocker({
          created_at: "2026-04-05T09:11:00.000Z",
          id: "blocker-env",
          task_id: "task-run",
        }),
      ],
      runs: [
        createRun({
          finished_at: "2026-04-05T09:15:00.000Z",
          id: "run-latest",
          status: "FAILED",
          task_id: "task-run",
        }),
        createRun({
          finished_at: "2026-04-05T09:08:00.000Z",
          id: "run-earlier",
          task_id: "task-approve",
        }),
      ],
      tasks: [
        createTask({
          id: "task-run",
          phase: 10,
          status: "IN_PROGRESS",
          title: "Render operator dashboard",
        }),
        createTask({
          id: "task-approve",
          phase: 10,
          status: "BLOCKED",
          title: "Release gated dashboard",
        }),
        createTask({
          id: "task-done",
          phase: 9,
          status: "DONE",
          title: "Ship discovery pipeline",
        }),
      ],
    },
  });

  assert.equal(dashboard.summary.total_tasks, 3);
  assert.equal(dashboard.summary.total_phases, 2);
  assert.equal(dashboard.summary.active_blocker_count, 2);
  assert.equal(dashboard.summary.pending_approval_count, 1);
  assert.equal(dashboard.summary.in_progress_task_count, 1);
  assert.equal(dashboard.summary.blocked_task_count, 1);
  assert.equal(dashboard.summary.done_task_count, 1);
  assert.equal(dashboard.summary.running_work_count, 1);
  assert.equal(dashboard.phase_progress[0].phase, 9);
  assert.equal(dashboard.phase_progress[0].done_count, 1);
  assert.equal(dashboard.phase_progress[1].phase, 10);
  assert.equal(dashboard.phase_progress[1].in_progress_count, 1);
  assert.equal(dashboard.phase_progress[1].blocked_count, 1);
  assert.equal(dashboard.pending_approvals[0].task_title, "Release gated dashboard");
  assert.equal(dashboard.approval_queue[0].task_title, "Release gated dashboard");
  assert.equal(dashboard.approval_queue[0].governance_state, "AWAITING_OPERATOR_DECISION");
  assert.equal(dashboard.active_blockers[0].id, "blocker-approval");
  assert.equal(dashboard.recent_runs[0].id, "run-latest");
  assert.equal(dashboard.recent_runs[0].task_title, "Render operator dashboard");
  assert.equal(dashboard.recent_completed_runs[0].id, "run-earlier");
  assert.equal(dashboard.running_work[0].task_id, "task-run");
  assert.equal(dashboard.task_board.find((group) => group.status === "BLOCKED").entries[0].task_id, "task-approve");
  assert.equal(dashboard.task_detail.task.id, "task-approve");
  assert.equal(dashboard.task_detail.selection_reason, "latest_active_blocker");
  assert.equal(dashboard.task_navigation[0].task_id, "task-approve");
  assert.equal(dashboard.task_navigation[0].view_kind, "selected");
  assert.equal(dashboard.task_navigation[0].pending_approval_count, 1);
  assert.equal(dashboard.task_details.length, 3);
});

test("buildDashboardView groups approval queue entries by canonical governance state", () => {
  const dashboard = buildDashboardView({
    snapshot: {
      approvals: [
        createApproval({
          action_id: "blocker-awaiting",
          id: "approval-awaiting",
          task_id: "task-awaiting",
        }),
        createApproval({
          action_id: "blocker-deferred",
          id: "approval-deferred",
          notes: ["Need more release evidence."],
          task_id: "task-deferred",
        }),
        createApproval({
          action_id: "blocker-rejected",
          id: "approval-rejected",
          status: "REJECTED",
          task_id: "task-rejected",
        }),
      ],
      blockers: [
        createBlocker({
          blocker_class: "MISSING_APPROVAL",
          id: "blocker-awaiting",
          task_id: "task-awaiting",
        }),
        createBlocker({
          blocker_class: "MISSING_APPROVAL",
          id: "blocker-deferred",
          task_id: "task-deferred",
        }),
        createBlocker({
          blocker_class: "MISSING_APPROVAL",
          id: "blocker-rejected",
          task_id: "task-rejected",
        }),
        createBlocker({
          blocker_class: "MISSING_APPROVAL",
          id: "blocker-missing-record",
          task_id: "task-missing-record",
        }),
      ],
      explainability: [
        createExplainability({
          decision_type: "APPROVAL",
          evidence_refs: ["blocker-deferred"],
          id: "approval-decision-deferred",
          route_chosen: "approval:deferred",
          task_id: "task-deferred",
          timestamp: "2026-04-05T09:13:00.000Z",
        }),
        createExplainability({
          decision_type: "APPROVAL",
          evidence_refs: ["blocker-rejected"],
          id: "approval-decision-rejected",
          route_chosen: "approval:rejected",
          task_id: "task-rejected",
          timestamp: "2026-04-05T09:14:00.000Z",
        }),
      ],
      runs: [],
      tasks: [
        createTask({ id: "task-awaiting", status: "BLOCKED", title: "Awaiting approval" }),
        createTask({ id: "task-deferred", status: "BLOCKED", title: "Deferred approval" }),
        createTask({ id: "task-rejected", status: "BLOCKED", title: "Rejected approval" }),
        createTask({ id: "task-missing-record", status: "BLOCKED", title: "Missing approval record" }),
      ],
    },
  });

  assert.equal(dashboard.approval_queue.length, 4);
  assert.equal(dashboard.approval_queue_groups[0].label, "Awaiting Operator Decision");
  assert.equal(dashboard.approval_queue_groups[0].entries[0].task_title, "Awaiting approval");
  assert.equal(dashboard.approval_queue_groups[1].entries[0].task_title, "Deferred approval");
  assert.equal(dashboard.approval_queue_groups[1].entries[0].latest_decision_action, "deferred");
  assert.equal(dashboard.approval_queue_groups[2].entries[0].task_title, "Rejected approval");
  assert.equal(dashboard.approval_queue_groups[3].entries[0].task_title, "Missing approval record");
});

test("buildDashboardView enforces non-negative limits", () => {
  assert.throws(
    () =>
      buildDashboardView({
        recentRunLimit: -1,
        snapshot: {
          blockers: [],
          runs: [],
          tasks: [],
        },
      }),
    /recentRunLimit must be a non-negative integer/i,
  );
});

test("buildDashboardView includes focus-task detail with assignments, decisions, and activity", () => {
  const dashboard = buildDashboardView({
    detailActivityLimit: 2,
    focusTaskId: "task-run",
    now: "2026-04-05T09:53:46.000Z",
    snapshot: {
      approvals: [
        createApproval({
          action_id: "blocker-run",
          id: "approval-run",
          task_id: "task-run",
        }),
      ],
      assignments: [
        createAssignment({
          agent_id: "agent-ui",
          assigned_at: "2026-04-05T09:13:00.000Z",
          id: "assignment-ui",
          task_id: "task-run",
        }),
      ],
      blockers: [
        createBlocker({
          created_at: "2026-04-05T09:12:00.000Z",
          id: "blocker-run",
          task_id: "task-run",
        }),
      ],
      events: [
        createEvent({
          id: "event-run",
          run_id: "run-latest",
          task_id: "task-run",
          timestamp: "2026-04-05T09:14:00.000Z",
        }),
      ],
      explainability: [
        createExplainability({
          decision_type: "ASSIGNMENT",
          human_readable_summary: "Assigned to the UI-capable agent because a dashboard render is needed.",
          id: "decision-run",
          task_id: "task-run",
          timestamp: "2026-04-05T09:11:00.000Z",
        }),
      ],
      runs: [
        createRun({
          finished_at: "2026-04-05T09:15:00.000Z",
          id: "run-latest",
          status: "FAILED",
          task_id: "task-run",
        }),
      ],
      taskNotes: [
        createTaskNote({
          content: "Operator prompt for the dashboard task.",
          id: "note-run",
          task_id: "task-run",
        }),
      ],
      tasks: [
        createTask({
          id: "task-run",
          phase: 10,
          priority: "high",
          status: "IN_PROGRESS",
          title: "Render operator dashboard",
          updated_at: "2026-04-05T09:16:00.000Z",
        }),
      ],
    },
  });

  assert.equal(dashboard.task_detail.task.title, "Render operator dashboard");
  assert.equal(dashboard.task_detail.selection_reason, "requested_task");
  assert.equal(dashboard.task_detail.assignments[0].id, "assignment-ui");
  assert.equal(dashboard.task_detail.decisions[0].id, "decision-run");
  assert.equal(dashboard.task_detail.task_notes[0].id, "note-run");
  assert.equal(dashboard.task_detail.activity.length, 2);
  assert.equal(dashboard.task_detail.activity[0].id, "event:event-run");
  assert.equal(dashboard.task_detail.runs[0].id, "run-latest");
  assert.equal(dashboard.task_detail.latest_approval.id, "approval-run");
  assert.equal(dashboard.task_detail.summary.approval_count, 1);
  assert.equal(dashboard.task_detail.summary.decision_count, 1);
  assert.equal(dashboard.task_detail.summary.note_count, 1);
  assert.equal(dashboard.task_detail.summary.pending_approval_count, 0);
  assert.equal(dashboard.task_navigation[0].task_id, "task-run");
  assert.equal(dashboard.task_navigation[0].view_kind, "selected");
  assert.equal(dashboard.task_details[0].task.id, "task-run");
});

test("buildDashboardView filters tasks, runs, blockers, and scope metadata", () => {
  const dashboard = buildDashboardView({
    filters: {
      phases: [10],
      statuses: ["BLOCKED"],
      taskIds: ["task-approve", "task-run"],
    },
    now: "2026-04-05T10:23:15.000Z",
    snapshot: {
      blockers: [
        createBlocker({
          blocker_class: "MISSING_APPROVAL",
          id: "blocker-approval",
          task_id: "task-approve",
        }),
        createBlocker({
          id: "blocker-run",
          task_id: "task-run",
        }),
      ],
      runs: [
        createRun({
          id: "run-approve",
          task_id: "task-approve",
        }),
        createRun({
          id: "run-run",
          task_id: "task-run",
        }),
      ],
      tasks: [
        createTask({
          id: "task-approve",
          phase: 10,
          status: "BLOCKED",
          title: "Release gated dashboard",
        }),
        createTask({
          id: "task-run",
          phase: 10,
          status: "IN_PROGRESS",
          title: "Render operator dashboard",
        }),
        createTask({
          id: "task-done",
          phase: 9,
          status: "DONE",
          title: "Ship discovery pipeline",
        }),
      ],
    },
  });

  assert.equal(dashboard.summary.total_tasks, 1);
  assert.equal(dashboard.scope.has_filters, true);
  assert.deepEqual(dashboard.scope.filters.statuses, ["BLOCKED"]);
  assert.deepEqual(dashboard.scope.filters.phases, [10]);
  assert.deepEqual(dashboard.scope.filters.task_ids, ["task-approve", "task-run"]);
  assert.equal(dashboard.recent_runs.length, 1);
  assert.equal(dashboard.recent_runs[0].task_id, "task-approve");
  assert.equal(dashboard.recent_completed_runs.length, 1);
  assert.equal(dashboard.active_blockers.length, 1);
  assert.equal(dashboard.running_work.length, 0);
  assert.equal(dashboard.task_navigation.length, 1);
  assert.equal(dashboard.task_navigation[0].task_id, "task-approve");
  assert.equal(dashboard.task_board.find((group) => group.status === "BLOCKED").total, 1);
  assert.equal(dashboard.task_details.length, 1);
});
