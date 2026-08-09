import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLocalControlPlaneDocument,
  buildTaskLiveCardFragment,
} from "./control-plane.js";
import { escapeHtml } from "./render-utils.js";

test("escapeHtml escapes text and attribute delimiters", () => {
  assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
});

function createSnapshot() {
  return {
    approvals: [
      {
        action_id: "blocker-approval",
        approved_at: null,
        created_at: "2026-04-08T10:08:00.000Z",
        id: "approval-1",
        notes: ["Need one more rollout confirmation before approval."],
        owner_role: "operator",
        reason: "Deploy approval is required before rollout.",
        requested_by: "validator",
        risk_level: "high",
        status: "PENDING",
        task_id: "task-blocked",
      },
    ],
    blockers: [
      {
        blocker_class: "MISSING_APPROVAL",
        created_at: "2026-04-08T10:08:00.000Z",
        id: "blocker-approval",
        next_action: "Approve deploy rollout.",
        reason: "Deploy approval is required before rollout.",
        resolved_at: null,
        task_id: "task-blocked",
      },
    ],
    checkpoints: [
      {
        context_summary: "Saved checkpoint before validator replay.",
        created_at: "2026-04-08T10:15:30.000Z",
        id: "checkpoint-progress",
        resumable: true,
        resume_instructions: "Resume from validator replay boundary.",
        run_id: "run-progress",
        state_snapshot: {
          cursor: 3,
        },
      },
    ],
    events: [
      {
        actor: "runtime",
        event_type: "STATE_CHANGE",
        id: "event-progress-workspace",
        payload: {
          lifecycle_phase: "workspace_preparation",
          phase_status: "completed",
          summary: "Workspace prepared for focused parser edit.",
        },
        run_id: "run-progress",
        task_id: "task-progress",
        timestamp: "2026-04-08T10:15:05.000Z",
      },
      {
        actor: "codex_local",
        event_type: "ADAPTER_CALL",
        id: "event-progress-adapter",
        payload: {
          status: "SUCCESS",
          summary: "Applied parser source toggle and summarized the change.",
        },
        run_id: "run-progress",
        task_id: "task-progress",
        timestamp: "2026-04-08T10:15:20.000Z",
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
        finished_at: "2026-04-08T10:12:00.000Z",
        id: "run-done",
        invocation_source: "on_demand",
        run_log: {
          bytes: 42,
          ref: null,
          sha256: "abc123",
          storage: "inline",
        },
        started_at: "2026-04-08T10:10:00.000Z",
        status: "COMPLETED",
        subtask_id: null,
        task_id: "task-done",
        task_session_key: null,
      },
      {
        adapter_id: "claude_code_local",
        agent_id: "agent-ui",
        checkpoint_id: null,
        cost: {
          duration_ms: 2200,
          estimated_usd: 0.24,
          tokens_in: 20,
          tokens_out: 40,
        },
        exit_code: 0,
        finished_at: null,
        id: "run-progress",
        invocation_source: "on_demand",
        run_log: {
          bytes: 84,
          ref: null,
          sha256: "def456",
          storage: "inline",
        },
        started_at: "2026-04-08T10:15:00.000Z",
        status: "RUNNING",
        subtask_id: null,
        task_id: "task-progress",
        task_session_key: null,
      },
    ],
    tasks: [
      {
        assigned_to: null,
        created_at: "2026-04-08T09:55:00.000Z",
        depends_on: [],
        goal_id: null,
        id: "task-pending",
        max_rejections: 5,
        out_of_scope: [],
        phase: 11,
        priority: "medium",
        rejection_count: 0,
        status: "PENDING",
        title: "Pending task",
        transition_log: [],
        updated_at: "2026-04-08T09:55:00.000Z",
      },
      {
        assigned_to: null,
        created_at: "2026-04-08T10:00:00.000Z",
        depends_on: [],
        goal_id: null,
        id: "task-progress",
        max_rejections: 5,
        acceptance_markdown: "- The parser label uses `Sample Inputs`.\n- No parser behavior changes.",
        details_markdown: "## Context\nThis task updates the parser UI copy only.",
        operator_brief_markdown: "Rename parser label in a copy-only change.",
        out_of_scope: [],
        phase: 11,
        priority: "high",
        rejection_count: 0,
        status: "IN_PROGRESS",
        title: "In progress task",
        transition_log: [],
        updated_at: "2026-04-08T10:15:00.000Z",
      },
      {
        assigned_to: null,
        created_at: "2026-04-08T10:05:00.000Z",
        depends_on: [],
        goal_id: null,
        id: "task-blocked",
        max_rejections: 5,
        out_of_scope: [],
        phase: 11,
        priority: "high",
        rejection_count: 0,
        status: "BLOCKED",
        title: "Blocked task",
        transition_log: [],
        updated_at: "2026-04-08T10:08:00.000Z",
      },
      {
        assigned_to: null,
        created_at: "2026-04-08T09:40:00.000Z",
        depends_on: [],
        goal_id: null,
        id: "task-done",
        max_rejections: 5,
        out_of_scope: [],
        phase: 10,
        priority: "medium",
        rejection_count: 0,
        status: "DONE",
        title: "Done task",
        transition_log: [],
        updated_at: "2026-04-08T10:12:00.000Z",
      },
    ],
    taskNotes: [
      {
        author_id: "cli:intake",
        author_type: "operator",
        content: "Add parser source toggle.",
        created_at: "2026-04-08T09:54:00.000Z",
        id: "note-intake",
        mentions: [],
        task_id: "task-progress",
      },
    ],
    assignments: [
      {
        agent_id: "cli-agent",
        assigned_at: "2026-04-08T10:01:00.000Z",
        context: "Selected lane generalist with adapter codex_local.",
        id: "assignment-1",
        policy_ref: "routing/coordinator/v1",
        reason_type: "manual",
        task_id: "task-progress",
      },
    ],
    explainability: [
      {
        alternatives_considered: [],
        decision_type: "ROUTE",
        evidence_refs: ["task-progress:reference-bundle"],
        human_readable_summary: "Selected lane generalist with adapter codex_local.",
        id: "decision-route-1",
        policy_refs: ["routing/coordinator/v1"],
        route_chosen: "generalist/codex_local",
        task_id: "task-progress",
        timestamp: "2026-04-08T10:00:30.000Z",
      },
      {
        alternatives_considered: [],
        decision_type: "APPROVAL",
        evidence_refs: ["blocker-approval"],
        human_readable_summary: "Operator deferred the deploy approval until rollout evidence is refreshed.",
        id: "decision-approval-1",
        policy_refs: ["ui/control-plane/v1"],
        route_chosen: "approval:deferred",
        task_id: "task-blocked",
        timestamp: "2026-04-08T10:09:00.000Z",
      },
    ],
    runLogs: [
      {
        raw_output: {
          status: "SUCCESS",
          summary: "Focused parser-source update completed with validator-ready output.",
        },
        raw_output_kind: "json",
        raw_output_ref: null,
        run_id: "run-progress",
        run_log: {
          bytes: 144,
          ref: null,
          sha256: "runprogress123",
          storage: "inline",
        },
      },
    ],
    verdicts: [
      {
        created_at: "2026-04-08T10:16:00.000Z",
        evidence_packet_id: "evidence-1",
        failure_attribution: "none",
        id: "verdict-1",
        next_action: "Close the task.",
        reason: "Focused runtime evidence confirms completion.",
        reviewer_id: "validator-1",
        run_id: "run-progress",
        task_id: "task-progress",
        verdict_class: "PASS",
      },
    ],
    evidence: [
      {
        authenticity_status: "VERIFIED",
        id: "evidence-1",
        items: [
          {
            content: "Focused verification passed.",
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
        verdict_id: "verdict-1",
      },
    ],
    taskRunSessions: [
      {
        active_phase: "reviewing",
        adapter_id: "codex_local",
        finished_at: null,
        id: "task-progress:live-session",
        lane_id: "generalist",
        run_id: "run-progress",
        runtime_family: "codex_local",
        started_at: "2026-04-08T10:15:00.000Z",
        status: "reviewing",
        summary: "Execution finished; validator lane is reviewing evidence.",
        task_id: "task-progress",
        updated_at: "2026-04-08T10:15:40.000Z",
      },
    ],
    taskRunEvents: [
      {
        actor_id: "coordinator",
        actor_type: "runtime",
        event_type: "route_selected",
        id: "task-progress:live-event:route",
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
      },
      {
        actor_id: "codex_local",
        actor_type: "runtime",
        event_type: "validator_started",
        id: "task-progress:live-event:validator",
        level: "info",
        payload: {
          summary: "Validator lane started reviewing runtime evidence.",
        },
        run_id: "run-progress",
        task_id: "task-progress",
        ts: "2026-04-08T10:15:40.000Z",
        visibility: "curated",
      },
    ],
    taskLiveExcerpts: [
      {
        channel: "summary",
        content: "Applied the label-only parser update and prepared validator evidence.",
        id: "task-progress:live-excerpt:summary",
        level: "info",
        metadata: {},
        run_id: "run-progress",
        source: "codex_local",
        task_id: "task-progress",
        ts: "2026-04-08T10:15:25.000Z",
      },
      {
        channel: "stdout",
        content: "[2026-04-08T10:15:26.000Z] parser label updated",
        id: "task-progress:live-excerpt:stdout",
        level: "info",
        metadata: {},
        run_id: "run-progress",
        source: "codex_local",
        task_id: "task-progress",
        ts: "2026-04-08T10:15:26.000Z",
      },
    ],
  };
}

function createTaskCard() {
  return {
    active_run: {
      adapter_id: "codex_local",
      id: "run-progress",
      status: "RUNNING",
      task_id: "task-progress",
    },
    active_run_id: "run-progress",
    artifacts: {
      report_json_url: "/artifacts/task/task-progress/report.json",
      report_markdown_url: "/artifacts/task/task-progress/report.md",
    },
    blockers: [],
    connection_state: "ready",
    intake_prompt: "Add parser source toggle.",
    latest_assignment: {
      agent_id: "cli-agent",
    },
    latest_verdict: {
      verdict_class: "PASS",
    },
    live_excerpts: [
      {
        channel: "summary",
        content: "Applied the label-only parser update and prepared validator evidence.",
        source: "codex_local",
        ts: "2026-04-08T10:15:25.000Z",
      },
      {
        channel: "stdout",
        content: "[2026-04-08T10:15:26.000Z] parser label updated",
        source: "codex_local",
        ts: "2026-04-08T10:15:26.000Z",
      },
    ],
    live_timeline: [
      {
        actor_id: "coordinator",
        actor_type: "runtime",
        event_type: "route_selected",
        payload: {
          adapter_id: "codex_local",
          lane_id: "generalist",
          summary: "Selected generalist via codex_local.",
        },
        ts: "2026-04-08T10:15:02.000Z",
      },
      {
        actor_id: "codex_local",
        actor_type: "runtime",
        event_type: "validator_started",
        payload: {
          summary: "Validator lane started reviewing runtime evidence.",
        },
        ts: "2026-04-08T10:15:40.000Z",
      },
    ],
    pending_approvals: [],
    run_sessions: [
      {
        active_phase: "reviewing",
        runtime_family: "codex_local",
      },
    ],
    task: {
      id: "task-progress",
      status: "IN_PROGRESS",
    },
    task_notes: [],
    validator_summary: {
      gate_decisions: [
        {
          decision_type: "GATE",
          human_readable_summary: "completion_proof returned PASS.",
          route_chosen: "validator_lane:completion_proof",
        },
      ],
      latest_verdict: {
        verdict_class: "PASS",
      },
    },
    version: "task-progress|1",
  };
}

test("buildLocalControlPlaneDocument renders home as tasks page", () => {
  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "home",
      path: "/",
    },
    snapshot: createSnapshot(),
    title: "Niis Local Control Plane",
  });

  assert.match(html, /Task Inbox/);
  assert.match(html, /PENDING/);
  assert.match(html, /IN_PROGRESS/);
  assert.match(html, /BLOCKED/);
  assert.match(html, /DONE/);
  assert.match(html, /In progress task/);
  assert.match(html, /Blocked task/);
  assert.match(html, /Done task/);
});

test("buildLocalControlPlaneDocument renders the task inbox grouped by canonical task status", () => {
  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "tasks",
      path: "/tasks",
    },
    snapshot: createSnapshot(),
    title: "Niis Local Control Plane",
  });

  assert.match(html, /Task Inbox/);
  assert.match(html, /Filtered:/);
  assert.match(html, /PENDING/);
  assert.match(html, /IN_PROGRESS/);
  assert.match(html, /BLOCKED/);
  assert.match(html, /DONE/);
  assert.match(html, /Latest run: RUNNING via claude_code_local/);
  assert.match(html, /Blockers: 1 \/ Approvals: 1/);
});

test("buildLocalControlPlaneDocument renders task intake preview without immediate execution", () => {
  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "task-new",
      path: "/tasks/new",
    },
    snapshot: createSnapshot(),
    taskNewPreview: {
      artifact: {
        acceptance_checks: ["Keep the parser export flow intact."],
        derived_task: {
          phase: 11,
          priority: "high",
          title: "Add parser source toggle",
        },
        operator_prompt: "Add parser source toggle",
        planner_mode: "structured_planner",
        planner_runtime: "codex_local",
        reference_bundle: {
          guides: ["Inspect parser template files before editing."],
          target_paths: ["templates/parser/parser.html"],
        },
        subtasks: [
          { id: "subtask-1", title: "Inspect parser template files" },
          { id: "subtask-2", title: "Apply the smallest coherent UI change" },
        ],
        summary: "Add a small toggle and keep URL mode stable.",
      },
      planner_attempts: [
        { ok: true, runtime_id: "codex_local" },
      ],
      planner_runtime_requested: "codex",
      route_preview: {
        selected_adapter: { id: "codex_local" },
        selected_lane: { lane_id: "generalist" },
      },
      task_id: "preview-task-id",
    },
    title: "Niis Local Control Plane",
  });

  assert.match(html, /Create task/);
  assert.match(html, /class="niis-shell"/);
  assert.match(html, /<link rel="stylesheet" href="\/__niis\/assets\/control-plane\.css"/);
  assert.match(html, /On this page/);
  assert.match(html, /name="title"/);
  assert.match(html, /name="prompt"/);
  assert.match(html, /Task title/);
  assert.match(html, /Create task/);
  assert.doesNotMatch(html, /Create and start/);
  assert.doesNotMatch(html, /value="create_and_start"/);
});

test("buildLocalControlPlaneDocument renders task workbench verdict, evidence, and report links", () => {
  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "task-detail",
      path: "/tasks/task-progress",
      taskId: "task-progress",
    },
    snapshot: createSnapshot(),
    taskCard: createTaskCard(),
    taskWorkbenchArtifacts: {
      executionLogTail: "[2026-04-08T10:15:10.000Z] executing: Agent execution is running via claude_code_local.",
      executionProgress: {
        active: true,
        adapter_id: "claude_code_local",
        run_id: "run-progress",
        stage: "executing",
        summary: "Agent execution is running via claude_code_local.",
        task_status: "IN_PROGRESS",
        updated_at: "2026-04-08T10:15:10.000Z",
        verdict_class: null,
      },
      report_json_url: "/artifacts/task/task-progress/report.json",
      report_markdown_url: "/artifacts/task/task-progress/report.md",
    },
    title: "Niis Local Control Plane",
  });

  assert.match(html, /class="route-task-detail"/);
  assert.match(html, /class="niis-shell"/);
  assert.match(html, /<script type="module" src="\/__niis\/assets\/control-plane\.js"><\/script>/);
  assert.match(html, /niis-sidebar-link/);



  assert.match(html, /data-sidebar-group="tasks"/);
  assert.match(html, /data-sidebar-group="approvals"/);
  assert.match(html, /data-sidebar-group="project"/);
  assert.match(html, /Overview/);
  assert.match(html, /niis/);
  assert.match(html, /New task/);
  assert.match(html, /In Progress/);
  assert.match(html, /Overview/);
  assert.match(html, /Add parser source toggle\./);
  assert.match(html, /This task updates the parser UI copy only\./);
  assert.match(html, /Acceptance criteria/);
  assert.match(html, /The parser label uses <code>Sample Inputs<\/code>/);
  assert.match(html, /Sub-tasks/);
  assert.match(html, /Single-track execution|Planner is decomposing|Task is unplanned/);
  assert.match(html, /niis-task-detail-track-table/);
  assert.doesNotMatch(html, /Review details/);
  assert.doesNotMatch(html, /Follow lifecycle/);
  assert.match(html, /Task Lifecycle/);
  assert.match(html, /href="#lifecycle"/);
  assert.match(html, /Task History/);
  assert.match(html, /Comments/);
  assert.match(html, /href="#comments"/);
  assert.doesNotMatch(html, /<strong>cli:intake<\/strong>/);
  assert.match(html, /Intake/);
  assert.match(html, /Planning/);
  assert.match(html, /Route/);
  assert.match(html, /Run/);
  assert.match(html, /Review/);
  assert.match(html, /Report/);
  assert.match(html, /data-active="true"/);
  assert.match(html, /Active now: Validator lane started reviewing runtime evidence\./);
  assert.match(html, /reviewing/);
  assert.match(html, /PASS/);
  assert.match(html, /Report JSON/);
  assert.match(html, /Report Markdown/);
  assert.match(html, /Artifacts and State/);
  assert.match(html, /Selected:<\/strong> <code>generalist<\/code> lane via <code>codex_local<\/code> adapter/);
  assert.match(html, /Routing details/);
  assert.match(html, /generalist\/codex_local/);
  assert.match(html, /routing\/coordinator\/v1/);
  assert.match(html, /generalist-worker report:<\/strong>/);
  assert.match(html, /Applied the label-only parser update and prepared validator evidence\./);
  assert.match(html, /niis-cost-badge[^>]*data-kind="duration"[^>]*>[^<]*<[^>]*>Duration<\/span>[^<]*<[^>]*>2\.2s/);
  assert.match(html, /niis-cost-badge[^>]*data-kind="cost"[^>]*>[^<]*<[^>]*>Cost<\/span>[^<]*<[^>]*>\$0\.24/);
  assert.match(html, /Run Phases/);
  assert.match(html, /Activity Timeline/);
  assert.match(html, /completion_proof returned PASS\./);
  assert.match(html, /Validator lane stopped with PASS after 1 validator/);
  assert.match(html, /<strong>Verdict:<\/strong> PASS\./);
  assert.match(html, /Verdict Details/);
  assert.match(html, /validator-1/);
  assert.match(html, /Close the task\./);
  assert.match(html, /Evidence Summary/);
  assert.match(html, /VERIFIED/);
  assert.match(html, /Focused verification passed\./);
  assert.match(html, /Applied the label-only parser update and prepared validator evidence\./);
  assert.match(html, /Logs/);
  assert.match(html, /Task History/);
  assert.match(html, /Lifecycle workspace preparation completed\./);
  assert.match(html, /codex_local returned SUCCESS: Applied parser source toggle and summarized the change\./);
  assert.match(html, /Leave a comment/);
  assert.doesNotMatch(html, /\/tasks\/task-progress\/delete/u);
  assert.doesNotMatch(html, />Delete task</u);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.doesNotMatch(html, /<style>/);
});

test("buildLocalControlPlaneDocument renders planning section with completed planning details", () => {
  const snapshot = createSnapshot();
  snapshot.tasks = snapshot.tasks.map((task) => {
    if (task.id === "task-progress") {
      return {
        ...task,
        transition_log: [
          { from_status: "UNPLANNED", to_status: "PLANNING", actor: "ui:intake", reason: "Transitioning to planning.", timestamp: "2026-04-08T10:00:00.000Z" },
          { from_status: "PLANNING", to_status: "PENDING", actor: "planner:task-planner", reason: "Planning completed successfully.", timestamp: "2026-04-08T10:00:30.000Z" },
        ],
      };
    }
    return task;
  });

  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "task-detail",
      path: "/tasks/task-progress",
      taskId: "task-progress",
    },
    snapshot,
    taskCard: createTaskCard(),
    taskWorkbenchArtifacts: {
      intakeArtifact: {
        acceptance_checks: ["Keep the parser export flow intact."],
        planner_mode: "structured_planner",
        planner_runtime: "codex_local",
        reference_bundle: {
          guides: ["Inspect parser template files."],
          target_paths: ["templates/parser/parser.html"],
        },
        route_preview: {
          selected_adapter: { id: "codex_local" },
          selected_lane: { lane_id: "generalist" },
        },
      },
    },
    title: "Niis Local Control Plane",
  });

  assert.match(html, /id="lifecycle"/);
  assert.match(html, /Task Lifecycle/);
  assert.match(html, /Planned/);
  assert.match(html, /niis-cost-badge-label">planner<\/span>/);
  assert.match(html, /structured_planner/);
  assert.match(html, /codex_local/);
  assert.match(html, /Target paths/);
  assert.match(html, /templates\/parser\/parser\.html/);
});

test("buildLocalControlPlaneDocument renders planning section with failure summary when blocked", () => {
  const snapshot = createSnapshot();
  snapshot.tasks = snapshot.tasks.map((task) => {
    if (task.id === "task-blocked") {
      return {
        ...task,
        transition_log: [
          { from_status: "UNPLANNED", to_status: "PLANNING", actor: "ui:intake", reason: "Transitioning to planning.", timestamp: "2026-04-08T10:00:00.000Z" },
          { from_status: "PLANNING", to_status: "BLOCKED", actor: "planner:task-planner", reason: "Planning failed: Planner runtime timed out.", timestamp: "2026-04-08T10:00:30.000Z" },
        ],
      };
    }
    return task;
  });

  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "task-detail",
      path: "/tasks/task-blocked",
      taskId: "task-blocked",
    },
    snapshot,
    title: "Niis Local Control Plane",
  });

  assert.match(html, /id="lifecycle"/);
  assert.match(html, /Task Lifecycle/);
  assert.match(html, /Planning/);
  assert.match(html, /Planning failed/);
  assert.match(html, /Planner runtime timed out/);
});

test("buildLocalControlPlaneDocument renders planning section with pending state for UNPLANNED tasks", () => {
  const snapshot = createSnapshot();
  snapshot.tasks = [
    {
      assigned_to: null,
      created_at: "2026-04-08T09:55:00.000Z",
      depends_on: [],
      goal_id: null,
      id: "task-unplanned",
      max_rejections: 5,
      out_of_scope: [],
      phase: 11,
      priority: "medium",
      rejection_count: 0,
      status: "UNPLANNED",
      title: "Unplanned task",
      transition_log: [
        { from_status: null, to_status: "UNPLANNED", actor: "ui:intake", reason: "Created from operator intake.", timestamp: "2026-04-08T09:55:00.000Z" },
      ],
      updated_at: "2026-04-08T09:55:00.000Z",
    },
  ];

  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "task-detail",
      path: "/tasks/task-unplanned",
      taskId: "task-unplanned",
    },
    snapshot,
    title: "Niis Local Control Plane",
  });

  assert.match(html, /id="lifecycle"/);
  assert.match(html, /Task Lifecycle/);
  assert.match(html, /Intake/);


  assert.match(html, /Decomposing task/, "Planning step should render in active state for UNPLANNED tasks");
});

test("buildLocalControlPlaneDocument renders planning section with active state for PLANNING tasks", () => {
  const snapshot = createSnapshot();
  snapshot.tasks = [
    {
      assigned_to: null,
      created_at: "2026-04-08T09:55:00.000Z",
      depends_on: [],
      goal_id: null,
      id: "task-planning",
      max_rejections: 5,
      out_of_scope: [],
      phase: 11,
      priority: "medium",
      rejection_count: 0,
      status: "PLANNING",
      title: "Planning task",
      transition_log: [
        { from_status: null, to_status: "UNPLANNED", actor: "ui:intake", reason: "Created from operator intake.", timestamp: "2026-04-08T09:55:00.000Z" },
        { from_status: "UNPLANNED", to_status: "PLANNING", actor: "ui:intake", reason: "Transitioning to planning.", timestamp: "2026-04-08T09:56:00.000Z" },
      ],
      updated_at: "2026-04-08T09:56:00.000Z",
    },
  ];

  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "task-detail",
      path: "/tasks/task-planning",
      taskId: "task-planning",
    },
    snapshot,
    title: "Niis Local Control Plane",
  });

  assert.match(html, /id="lifecycle"/);
  assert.match(html, /Task Lifecycle/);
  assert.match(html, /Planning/);
  assert.match(html, /Decomposing task/);

  assert.doesNotMatch(html, /http-equiv="refresh"/);
});

test("buildLocalControlPlaneDocument renders approval history on the blocked task workbench", () => {
  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "task-detail",
      path: "/tasks/task-blocked",
      taskId: "task-blocked",
    },
    snapshot: createSnapshot(),
    title: "Niis Local Control Plane",
  });

  assert.match(html, /Artifacts and State/);
  assert.match(html, /Need one more rollout confirmation before approval\./);
  assert.match(html, /Requested action: blocker-approval/);
  assert.match(html, /APPROVAL/);
  assert.match(html, /Operator deferred the deploy approval until rollout evidence is refreshed\./);
  assert.match(html, /Leave a comment/);
});

test("buildLocalControlPlaneDocument renders task content edit mode with textarea editors and preview", () => {
  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "task-detail",
      mode: "edit",
      path: "/tasks/task-progress",
      taskId: "task-progress",
    },
    snapshot: createSnapshot(),
    title: "Niis Local Control Plane",
  });

  assert.match(html, /Task Properties/);
  assert.match(html, /name="title"/);
  assert.match(html, /name="priority"/);
  assert.match(html, /name="phase"/);
  assert.match(html, /name="operator_brief_markdown"/);
  assert.match(html, /name="details_markdown"/);
  assert.match(html, /name="acceptance_markdown"/);
  assert.match(html, /Preview/);
  assert.match(html, /Task content updated|Save/);
  assert.match(html, /Cancel/);
});

test("buildLocalControlPlaneDocument renders the approval queue grouped by governance state", () => {
  const html = buildLocalControlPlaneDocument({
    mutableState: true,
    route: {
      kind: "approvals",
      path: "/approvals",
    },
    snapshot: createSnapshot(),
    title: "Niis Local Control Plane",
  });

  assert.match(html, /Operator Decisions/);
  assert.match(html, /Governance approval queue/);
  assert.match(html, /Deferred Pending Follow-Up/);
  assert.match(html, /Blocked task/);
  assert.match(html, /Requested action: blocker-approval/);
  assert.match(html, /Risk summary: high risk requested by validator: Deploy approval is required before rollout\./);
  assert.match(html, /Latest governance note: Operator deferred the deploy approval until rollout evidence is refreshed\./);
  assert.match(html, /Read-only governance evidence/);
  assert.doesNotMatch(html, /action="\/approvals\//);
  assert.doesNotMatch(html, /name="decision"/);
  assert.match(html, /Reviewable subtask branches/);
  assert.match(html, /Reviewable task branches/);
});

test("approval queue uses only the strict plan lifecycle action", () => {
  const snapshot = createSnapshot();
  snapshot.tasks = snapshot.tasks.map((task) =>
    task.id === "task-blocked"
      ? { ...task, status: "PENDING" }
      : task);
  snapshot.blockers = snapshot.blockers.map((blocker) =>
    blocker.task_id === "task-blocked"
      ? { ...blocker, id: "plan:task-blocked" }
      : blocker);
  snapshot.approvals = snapshot.approvals.map((approval) =>
    approval.task_id === "task-blocked"
      ? { ...approval, action_id: "plan:task-blocked" }
      : approval);

  const html = buildLocalControlPlaneDocument({
    mutableState: true,
    route: {
      kind: "approvals",
      path: "/approvals",
    },
    snapshot,
    title: "Niis Local Control Plane",
  });

  assert.match(
    html,
    /action="\/tasks\/task-blocked\/actions\/approve"/,
  );
  assert.match(html, /Approve current plan/);
  assert.doesNotMatch(html, /action="\/approvals\//);
  assert.doesNotMatch(html, /name="blocker_id"/);
  assert.doesNotMatch(html, /name="decision"/);
});

test("operator branch inventories are read-only in Reliability RC", () => {
  const html = buildLocalControlPlaneDocument({
    operatorDecisions: {
      subtask_branches: [
        {
          branch: {
            merge_status: "pending",
            name: "niis/attempt-subtask",
            pr_url: "https://example.test/reviews/42",
          },
          merge_step: 1,
          role_id: "generalist-worker",
          subtask_id: "subtask-1",
          task_id: "task-progress",
          task_title: "In progress task",
        },
      ],
      task_branches: [
        {
          branch_name: "niis/attempt-task",
          pr_url: null,
          queue_state: "COMPLETED",
          task_id: "task-progress",
          task_title: "In progress task",
        },
      ],
    },
    route: {
      kind: "approvals",
      path: "/approvals",
    },
    snapshot: createSnapshot(),
    title: "Niis Local Control Plane",
  });

  assert.match(html, /Read-only inspection of legacy subtask branches/);
  assert.match(html, /Open remote review/);
  assert.match(html, /Local branch only/);
  assert.match(html, /canonical <code>PASS<\/code>/);
  assert.doesNotMatch(html, /\/subtasks\/[^"]+\/(?:merge|discard|pr)/);
  assert.doesNotMatch(html, /\/task-branch\/(?:merge|discard|pr)/);
  assert.doesNotMatch(html, /<th>Actions<\/th>/);
});

test("task workbench renders attempt branches as evidence without mutation actions", () => {
  const html = buildTaskLiveCardFragment({
    detail: {
      activity: [],
      runs: [],
      task: {
        created_at: "2026-07-23T10:00:00.000Z",
        id: "task-1",
        status: "IN_REVIEW",
        transition_log: [],
      },
    },
    taskCard: null,
    taskWorkbenchArtifacts: {
      subtaskProgress: {
        subtasks: [
          {
            branch: {
              had_changes: true,
              merge_status: "pending",
              name: "niis/attempt-1",
              worktree_path: "/tmp/niis-attempt-1",
            },
            id: "task-1:main",
            role_id: "generalist-worker",
            status: "completed",
          },
        ],
      },
    },
  });

  assert.match(html, /Read-only branch inspection/);
  assert.match(html, /canonical <code>PASS<\/code>/);
  assert.match(html, /niis\/attempt-1/);
  assert.doesNotMatch(html, /\/subtasks\/[^"]+\/(?:merge|discard|pr)/);
  assert.doesNotMatch(html, /<th>Actions<\/th>/);
});

test("buildLocalControlPlaneDocument renders run detail timeline, validator decisions, and artifacts", () => {
  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "run-detail",
      path: "/runs/run-progress",
      runId: "run-progress",
    },
    snapshot: createSnapshot(),
    taskWorkbenchArtifacts: {
      report_json_url: "/artifacts/task/task-progress/report.json",
      report_markdown_url: "/artifacts/task/task-progress/report.md",
    },
    title: "Niis Local Control Plane",
  });

  assert.match(html, /Run Detail/);
  assert.match(html, /Runtime Choice/);
  assert.match(html, /Run Phases/);
  assert.match(html, /workspace preparation/);
  assert.match(html, /Activity Timeline/);
  assert.match(html, /ADAPTER_CALL/);
  assert.match(html, /Validator Decisions/);
  assert.match(html, /PASS/);
  assert.match(html, /Evidence Summary/);
  assert.match(html, /Produced Artifacts/);
  assert.match(html, /Saved checkpoint before validator replay\./);
  assert.match(html, /Focused parser-source update completed with validator-ready output\./);
  assert.match(html, /Report JSON/);
  assert.match(html, /Report Markdown/);
});

test("buildLocalControlPlaneDocument renders attached-project overview with workflow and runtime signals", () => {
  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "project",
      path: "/project",
    },
    snapshot: createSnapshot(),
    projectContext: {
      attachment: {
        attached_at: "2026-04-08T10:00:00.000Z",
        generated_artifacts: [
          ".niis/exports/project-profile.md",
          ".niis/exports/workflow.md",
          ".niis/exports/codemap.json",
        ],
      },
      codemap: {
        language_breakdown: [
          { files: 4, language: "typescript" },
          { files: 2, language: "javascript" },
        ],
        root: "/tmp/repo",
        stats: {
          docs_count: 2,
          files_indexed: 8,
          source_count: 6,
        },
      },
      codemapPath: ".niis/exports/codemap.json",
      doctor: {
        counts: {
          error: 0,
          ok: 5,
          warning: 1,
        },
        highlights: [
          {
            details: "Immutable install-state baseline is present.",
            id: "install-state",
            status: "ok",
            summary: "install-state.json",
          },
        ],
        runtime_availability: [
          {
            details: "Resolved adapter runtime command at /usr/local/bin/codex.",
            id: "codex_local",
            status: "ok",
            summary: "codex_local",
          },
          {
            details: "None of the expected commands are available on PATH: claude-code, claude.",
            id: "claude_code_local",
            status: "warning",
            summary: "claude_code_local",
          },
        ],
      },
      hasCodemap: true,
      hasProjectProfile: true,
      hasWorkflow: true,
      install: {
        status: "BOOTSTRAPPED",
      },
      profile: {
        build_systems: ["npm", "vite"],
        context_boundary: {
          project_root: "/tmp/repo",
          scope: "project",
        },
        frameworks: ["react"],
        languages: ["typescript", "javascript"],
        primary_type: "react",
        project_id: "demo-project",
        repo_root: "/tmp/repo",
        task_sources: {
          declared_sources: ["docs", "backlog"],
          documentation_staleness_candidates: ["stale-doc"],
        },
        test_frameworks: ["playwright"],
        validation_surface: {
          indexed_files: 8,
        },
      },
      projectProfilePath: ".niis/exports/project-profile.md",
      validationSurfaceRoot: "/tmp/repo",
      workflow: {
        summary: "Reviewable workflow manifest generated from declarative marker-file and dependency detection.",
        task_source_types: ["documentation", "backlog", "source"],
        workspace_strategy: {
          branch_template: "{{task.id}}-{{slug}}",
          mode: "worktree",
          provision_command: "npm install",
          workspace_source_priority: ["git_worktree", "local_copy"],
        },
      },
      workflowPath: ".niis/exports/workflow.md",
    },
    title: "Niis Local Control Plane",
  });

  assert.match(html, /Project Overview/);
  assert.match(html, /demo-project/);
  assert.match(html, /Technology profile/);
  assert.match(html, /typescript, javascript/);
  assert.match(html, /Workflow/);
  assert.match(html, /npm install/);
  assert.match(html, /Codemap/);
  assert.match(html, /typescript \(4\), javascript \(2\)/);
  assert.match(html, /Runtime availability/);
  assert.match(html, /codex_local/);
  assert.match(html, /Doctor signals/);
  assert.match(html, /5 ok \/ 1 warning \/ 0 error/);
  assert.match(html, /Start intake/);
  assert.match(html, /Open active workbench for In progress task/);
});

test("buildLocalControlPlaneDocument renders lifecycle step ownership badges", () => {
  const snapshot = createSnapshot();


  snapshot.tasks = snapshot.tasks.map((task) => {
    if (task.id === "task-progress") {
      return {
        ...task,
        status: "PLANNING",
        transition_log: [
          { from_status: "UNPLANNED", to_status: "PLANNING", actor: "ui:intake", reason: "Operator initiated planning.", timestamp: "2026-04-08T10:00:00.000Z" },
        ],
      };
    }
    return task;
  });

  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "task-detail",
      path: "/tasks/task-progress",
      taskId: "task-progress",
    },
    snapshot,
    title: "Niis Local Control Plane",
  });


  assert.match(html, /id="lifecycle"/);
  assert.match(html, /Task Lifecycle/);


  assert.match(html, /Intake/);
  assert.match(html, /Planning/);
  assert.doesNotMatch(html, /niis-task-lifecycle-phase.*data-accent="route"/, "Route step should not render during PLANNING");


  assert.match(html, /niis-task-lifecycle-owner.*operator/);

  assert.match(html, /niis-task-lifecycle-owner.*analytic/);
});

test("buildLocalControlPlaneDocument renders lifecycle with completed planning ownership", () => {
  const snapshot = createSnapshot();
  snapshot.tasks = snapshot.tasks.map((task) => {
    if (task.id === "task-progress") {
      return {
        ...task,
        status: "IN_PROGRESS",
        transition_log: [
          { from_status: "UNPLANNED", to_status: "PLANNING", actor: "ui:intake", reason: "Operator initiated planning.", timestamp: "2026-04-08T10:00:00.000Z" },
          { from_status: "PLANNING", to_status: "PENDING", actor: "planner:task-planner", reason: "Planning completed.", timestamp: "2026-04-08T10:01:00.000Z" },
        ],
      };
    }
    return task;
  });

  const html = buildLocalControlPlaneDocument({
    route: {
      kind: "task-detail",
      path: "/tasks/task-progress",
      taskId: "task-progress",
    },
    snapshot,
    taskWorkbenchArtifacts: {
      intakeArtifact: {
        planner_mode: "structured_planner",
        planner_runtime: "codex_local",
        route_preview: {
          selected_adapter: { id: "codex_local" },
          selected_lane: { lane_id: "generalist" },
        },
      },
    },
    title: "Niis Local Control Plane",
  });


  assert.match(html, /niis-task-lifecycle-owner.*analytic/);
});
