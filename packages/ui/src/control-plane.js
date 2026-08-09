import {
  buildActivityStream,
  buildDashboardView,
  buildRunObservabilityView,
  buildTaskObservabilityView,
} from "../../core/src/observability/index.js";
import { summarizeGoalProgress } from "../../core/src/contracts/governance.js";
import {
  escapeHtml,
  formatMaybeList,
  formatTimestamp,
} from "./render-utils.js";
import {
  buildNiisSidebarTree,
  renderControlPlaneDocumentFrame,
  renderControlPlaneDocumentHead,
  renderNiisLayout,
  renderNiisSidebar,
  renderNiisToc,
  renderNiisTopbar,
} from "./templates/layout.js";
import {
  buildTaskLiveCardFragment,
  renderReportLinks,
  renderTaskDetailRoute,
  renderTaskNewRoute,
  renderTaskStatusIcon,
} from "./templates/task-pages.js";

const DEFAULT_CONTROL_PLANE_ASSETS = Object.freeze({
  css: "/__niis/assets/control-plane.css",
  js: "/__niis/assets/control-plane.js",
});

function normalizeSnapshot(snapshot = {}) {
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
}

function normalizeRoute(route = {}) {
  return {
    kind: route.kind === "home" ? "tasks" : (route.kind ?? "tasks"),
    mode: route.mode ?? null,
    path: route.path ?? "/",
    runId: route.runId ?? null,
    taskId: route.taskId ?? null,
    view: route.view ?? null,
  };
}

function normalizeProjectContext(projectContext = {}) {
  return {
    attachment: projectContext.attachment ?? null,
    codemap: projectContext.codemap ?? null,
    codemapPath: projectContext.codemapPath ?? null,
    doctor: projectContext.doctor ?? {
      counts: { error: 0, ok: 0, warning: 0 },
      highlights: [],
      runtime_availability: [],
    },
    hasCodemap: Boolean(projectContext.hasCodemap),
    hasProjectProfile: Boolean(projectContext.hasProjectProfile),
    hasWorkflow: Boolean(projectContext.hasWorkflow),
    install: projectContext.install ?? null,
    profile: projectContext.profile ?? null,
    projectProfilePath: projectContext.projectProfilePath ?? null,
    roleConfig: projectContext.roleConfig ?? null,
    validationSurfaceRoot: projectContext.validationSurfaceRoot ?? null,
    workflow: projectContext.workflow ?? null,
    workflowPath: projectContext.workflowPath ?? null,
  };
}

function normalizeTaskNewPreview(taskNewPreview = null) {
  if (!taskNewPreview || typeof taskNewPreview !== "object" || Array.isArray(taskNewPreview)) {
    return null;
  }

  return {
    artifact: taskNewPreview.artifact ?? null,
    planner_attempts: Array.isArray(taskNewPreview.planner_attempts) ? taskNewPreview.planner_attempts : [],
    planner_runtime_requested: taskNewPreview.planner_runtime_requested ?? null,
    route_preview: taskNewPreview.route_preview ?? null,
    task_id: taskNewPreview.task_id ?? null,
  };
}

function normalizeTaskWorkbenchArtifacts(taskWorkbenchArtifacts = null) {
  if (!taskWorkbenchArtifacts || typeof taskWorkbenchArtifacts !== "object" || Array.isArray(taskWorkbenchArtifacts)) {
    return null;
  }

  return {
    executionLogPath: taskWorkbenchArtifacts.executionLogPath ?? null,
    executionLogTail: taskWorkbenchArtifacts.executionLogTail ?? null,
    executionProgress: taskWorkbenchArtifacts.executionProgress ?? null,
    intakeArtifact: taskWorkbenchArtifacts.intakeArtifact ?? null,
    intakeJsonPath: taskWorkbenchArtifacts.intakeJsonPath ?? null,
    reportJsonPath: taskWorkbenchArtifacts.reportJsonPath ?? null,
    reportMarkdownPath: taskWorkbenchArtifacts.reportMarkdownPath ?? null,
    report_json_url: taskWorkbenchArtifacts.report_json_url ?? null,
    report_markdown_url: taskWorkbenchArtifacts.report_markdown_url ?? null,
    subtaskProgress: taskWorkbenchArtifacts.subtaskProgress ?? null,
    taskRoot: taskWorkbenchArtifacts.taskRoot ?? null,
  };
}

function normalizeTaskCard(taskCard = null) {
  if (!taskCard || typeof taskCard !== "object" || Array.isArray(taskCard)) {
    return null;
  }

  return {
    active_run: taskCard.active_run ?? null,
    active_run_id: taskCard.active_run_id ?? null,
    artifacts: taskCard.artifacts ?? {},
    blockers: Array.isArray(taskCard.blockers) ? taskCard.blockers : [],
    connection_state: taskCard.connection_state ?? "ready",
    intake_prompt: taskCard.intake_prompt ?? null,
    latest_assignment: taskCard.latest_assignment ?? null,
    latest_verdict: taskCard.latest_verdict ?? null,
    execution_log_tail: taskCard.execution_log_tail ?? null,
    execution_progress: taskCard.execution_progress ?? null,
    live_excerpts: Array.isArray(taskCard.live_excerpts) ? taskCard.live_excerpts : [],
    live_timeline: Array.isArray(taskCard.live_timeline) ? taskCard.live_timeline : [],
    pending_approvals: Array.isArray(taskCard.pending_approvals) ? taskCard.pending_approvals : [],
    run_sessions: Array.isArray(taskCard.run_sessions) ? taskCard.run_sessions : [],
    task: taskCard.task ?? null,
    task_notes: Array.isArray(taskCard.task_notes) ? taskCard.task_notes : [],
    validator_summary: taskCard.validator_summary ?? {
      gate_decisions: [],
      latest_verdict: null,
    },
    version: taskCard.version ?? null,
  };
}

function normalizeControlPlaneAssets(assetUrls = {}) {
  return {
    css: assetUrls.css ?? DEFAULT_CONTROL_PLANE_ASSETS.css,
    js: assetUrls.js ?? DEFAULT_CONTROL_PLANE_ASSETS.js,
  };
}

function isActiveExecutionProgress(taskWorkbenchArtifacts = null) {
  return Boolean(taskWorkbenchArtifacts?.executionProgress?.active);
}

function renderBanner({ notice = null, error = null } = {}) {
  if (!notice && !error) {
    return "";
  }

  const className = error ? "niis-banner niis-banner-error" : "niis-banner niis-banner-notice";
  const text = error ?? notice;

  return `<div class="${className}">${escapeHtml(text)}</div>`;
}

function renderNavItem({ href, label, active = false }) {
  return `<a class="niis-nav-link${active ? " niis-nav-link-active" : ""}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function renderNavigation(route) {
  return `
    <nav class="niis-nav-shell">
      ${renderNavItem({ href: "/tasks", label: "Tasks", active: route.kind === "tasks" || route.kind === "task-detail" })}
      ${renderNavItem({ href: "/approvals", label: "Approvals", active: route.kind === "approvals" })}
      ${renderNavItem({ href: "/agents", label: "Agents", active: route.kind === "agents" })}
      ${renderNavItem({ href: "/insights", label: "Insights", active: route.kind === "insights" })}
      ${renderNavItem({ href: "/project", label: "Project", active: route.kind === "project" })}
    </nav>`;
}

function renderSummaryCards(dashboard) {
  return `
    <div class="niis-card-grid">
      <div class="niis-card"><span class="niis-label">Tasks</span><span class="niis-value">${escapeHtml(dashboard.summary.total_tasks)}</span></div>
      <div class="niis-card"><span class="niis-label">Active blockers</span><span class="niis-value">${escapeHtml(dashboard.summary.active_blocker_count)}</span></div>
      <div class="niis-card"><span class="niis-label">Pending approvals</span><span class="niis-value">${escapeHtml(dashboard.summary.pending_approval_count)}</span></div>
      <div class="niis-card"><span class="niis-label">Running work</span><span class="niis-value">${escapeHtml(dashboard.summary.running_work_count)}</span></div>
      <div class="niis-card"><span class="niis-label">Pending</span><span class="niis-value">${escapeHtml(dashboard.summary.pending_task_count)}</span></div>
      <div class="niis-card"><span class="niis-label">In progress</span><span class="niis-value">${escapeHtml(dashboard.summary.in_progress_task_count)}</span></div>
      <div class="niis-card"><span class="niis-label">Blocked</span><span class="niis-value">${escapeHtml(dashboard.summary.blocked_task_count)}</span></div>
      <div class="niis-card"><span class="niis-label">Done</span><span class="niis-value">${escapeHtml(dashboard.summary.done_task_count)}</span></div>
    </div>`;
}

function renderRunList(runs = [], { emptyLabel = "No runs recorded." } = {}) {
  if (runs.length === 0) {
    return `<p>${escapeHtml(emptyLabel)}</p>`;
  }

  return `
    <ul class="niis-item-list">
      ${runs.map((run) => `
        <li>
          <a href="/tasks/${encodeURIComponent(run.task_id)}#lifecycle">${escapeHtml(run.task_title)}</a>
          <div>${escapeHtml(run.status)} via ${escapeHtml(run.adapter_id)}</div>
          <div>Finished: ${escapeHtml(formatTimestamp(run.finished_at))}</div>
        </li>`).join("")}
    </ul>`;
}

function renderBlockerList(blockers = [], { emptyLabel = "No active blockers." } = {}) {
  if (blockers.length === 0) {
    return `<p>${escapeHtml(emptyLabel)}</p>`;
  }

  return `
    <ul class="niis-item-list">
      ${blockers.map((blocker) => `
        <li>
          <a href="/tasks/${encodeURIComponent(blocker.task_id)}">${escapeHtml(blocker.task_title)}</a>
          <div>${escapeHtml(blocker.blocker_class)}: ${escapeHtml(blocker.reason)}</div>
          <div>Next: ${escapeHtml(blocker.next_action)}</div>
        </li>`).join("")}
    </ul>`;
}

function renderApprovalPreviewList(dashboard) {
  if (dashboard.pending_approvals.length === 0) {
    return "<p>No pending approvals.</p>";
  }

  return `
    <ul class="niis-item-list">
      ${dashboard.pending_approvals.map((approval) => `
        <li>
          <a href="/tasks/${encodeURIComponent(approval.task_id)}">${escapeHtml(approval.task_title)}</a>
          <div>${escapeHtml(approval.reason)}</div>
          <div>Next: ${escapeHtml(approval.next_action)}</div>
        </li>`).join("")}
    </ul>`;
}

function renderRunningWork(dashboard) {
  if (dashboard.running_work.length === 0) {
    return "<p>No running work right now.</p>";
  }

  return `
    <ul class="niis-item-list">
      ${dashboard.running_work.map((task) => `
        <li>
          <a href="/tasks/${encodeURIComponent(task.task_id)}">${escapeHtml(task.task_title)}</a>
          <div>${escapeHtml(task.status)} / task phase ${escapeHtml(task.phase)} / priority ${escapeHtml(task.priority)}</div>
          <div>${task.latest_run_status ? `Latest run: ${escapeHtml(task.latest_run_status)}` : "No run recorded yet."}${task.latest_run_adapter_id ? ` via ${escapeHtml(task.latest_run_adapter_id)}` : ""}</div>
        </li>`).join("")}
    </ul>`;
}

function renderScopeSummary(dashboard) {
  return `
    <div class="niis-scope-summary">
      <span><strong>Filtered:</strong> ${escapeHtml(dashboard.scope.has_filters ? "yes" : "no")}</span>
      <span><strong>Status:</strong> ${escapeHtml(formatMaybeList(dashboard.scope.filters.statuses))}</span>
      <span><strong>Task Phase:</strong> ${escapeHtml(formatMaybeList(dashboard.scope.filters.phases))}</span>
      <span><strong>Task IDs:</strong> ${escapeHtml(formatMaybeList(dashboard.scope.filters.task_ids))}</span>
    </div>`;
}

function renderTaskBoardCard(task) {





  return `
    <article class="niis-task-card" data-task-id="${escapeHtml(task.task_id)}" data-task-status="${escapeHtml(task.status)}">
      <h4><a href="/tasks/${encodeURIComponent(task.task_id)}">${escapeHtml(task.task_title)}</a></h4>
      <div>${escapeHtml(task.status)} / task phase ${escapeHtml(task.phase)} / priority ${escapeHtml(task.priority)}</div>
      <div>Blockers: ${escapeHtml(task.active_blocker_count)} / Approvals: ${escapeHtml(task.pending_approval_count)}</div>
      <div>${task.latest_run_status ? `Latest run: ${escapeHtml(task.latest_run_status)}` : "Latest run: none"}${task.latest_run_adapter_id ? ` via ${escapeHtml(task.latest_run_adapter_id)}` : ""}</div>
      <div>Updated: ${escapeHtml(formatTimestamp(task.updated_at))}</div>
    </article>`;
}

function renderTaskBoardGroup(group) {
  return `
    <section class="niis-panel niis-board-group">
      <h3>${escapeHtml(group.status)} <span class="niis-muted">(${escapeHtml(group.total)})</span></h3>
      ${group.total === 0
    ? "<p>No tasks in this status.</p>"
    : `<div class="niis-board-grid">${group.entries.map((task) => renderTaskBoardCard(task)).join("")}</div>`}
    </section>`;
}

function renderQueueSummaryBlock(queueSummary) {
  if (!queueSummary || typeof queueSummary.counts !== "object") return "";
  const counts = queueSummary.counts;
  const cells = [
    { key: "pending", label: "Pending" },
    { key: "in_progress", label: "In progress" },
    { key: "in_review", label: "In review" },
    { key: "accepted", label: "Accepted" },
    { key: "rejected", label: "Rejected" },
  ];
  const hasAny = cells.some((c) => (counts[c.key] ?? 0) > 0);
  if (!hasAny && queueSummary.pending_preview?.length === 0 && queueSummary.in_review_preview?.length === 0) {
    return "";
  }
  const countsRow = cells.map((c) => `
    <div class="niis-task-detail-property-row">
      <span>${escapeHtml(c.label)}</span>
      <strong>${escapeHtml(counts[c.key] ?? 0)}</strong>
    </div>`).join("");
  const pendingList = (queueSummary.pending_preview ?? []).map((entry) => `
    <li><a href="/tasks/${encodeURIComponent(entry.task_id)}">${escapeHtml(entry.title)}</a>${entry.priority ? ` <span class="niis-muted">(${escapeHtml(entry.priority)})</span>` : ""}</li>`).join("");
  const reviewList = (queueSummary.in_review_preview ?? []).map((entry) => `
    <li><a href="/tasks/${encodeURIComponent(entry.task_id)}">${escapeHtml(entry.title)}</a></li>`).join("");
  return `
    <section class="niis-section" id="queue">
      <h2>File-based queue <span class="niis-muted">(.niis/queue/)</span></h2>
      <p>Operator-facing mirror of task state. Move files between directories to reroute, run <code>niis go</code> to process <code>pending/</code>.</p>
      <div class="niis-callout-grid">
        <article class="niis-callout-card">
          <h3>Counts</h3>
          <div class="niis-task-detail-property-list">${countsRow}</div>
        </article>
        <article class="niis-callout-card">
          <h3>Top pending (priority-sorted)</h3>
          ${pendingList ? `<ul class="niis-item-list">${pendingList}</ul>` : '<p class="niis-muted">No pending tasks.</p>'}
        </article>
        <article class="niis-callout-card">
          <h3>Awaiting review</h3>
          ${reviewList ? `<ul class="niis-item-list">${reviewList}</ul>` : '<p class="niis-muted">No tasks awaiting operator review.</p>'}
        </article>
      </div>
    </section>`;
}




const BOARD_COLUMNS = [
  { id: "pending", label: "Pending", statuses: ["UNPLANNED", "PENDING", "PAUSED"] },
  { id: "in_progress", label: "In Progress", statuses: ["PLANNING", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "ACTIVE"] },
  { id: "done", label: "Done", statuses: ["DONE"] },
  { id: "rejected", label: "Rejected", statuses: ["REJECTED"] },
];



const BOARD_PHASE_COLORS = {
  UNPLANNED: "#9ca3af",
  PLANNING: "#a855f7",
  PENDING: "#5b8def",
  IN_PROGRESS: "#eab308",
  BLOCKED: "#f97316",
  IN_REVIEW: "#0ea5e9",
  ACTIVE: "#16a34a",
  PAUSED: "#9ca3af",
  DONE: "#16a34a",
  REJECTED: "#dc2626",
};

function humanizeBoardStatus(status) {
  if (!status) return "";
  return String(status)
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function renderBoardCard(task, subtaskProgressByTaskId) {
  const phaseColor = BOARD_PHASE_COLORS[task.status] ?? "#6b7280";
  const phaseBadge = `<span class="niis-board-card-phase" style="--phase-color: ${phaseColor};">${escapeHtml(humanizeBoardStatus(task.status))}</span>`;






  const progress = subtaskProgressByTaskId?.[task.task_id] ?? null;
  let progressBlock = "";
  if (progress && progress.total > 0) {
    const dots = Array.from({ length: progress.total }, (_, i) => {
      let cls = "niis-board-step niis-board-step-pending";
      if (i < progress.done) cls = "niis-board-step niis-board-step-done";
      else if (i === progress.done && task.status === "IN_PROGRESS") cls = "niis-board-step niis-board-step-active";
      return `<span class="${cls}"></span>`;
    }).join("");
    progressBlock = `
      <div class="niis-board-progress">
        <div class="niis-board-stepper">${dots}</div>
        <div class="niis-board-progress-meta">
          <span class="niis-board-progress-ratio">${progress.done}/${progress.total} subtasks</span>
          ${progress.active_title ? `<span class="niis-board-progress-current">· ${escapeHtml(progress.active_title)}</span>` : ""}
        </div>
      </div>`;
  } else if (task.status === "IN_PROGRESS") {
    progressBlock = `
      <div class="niis-board-running">
        <span class="niis-board-running-pulse"></span>
        <span>Running — single shot</span>
      </div>`;
  } else if (task.latest_run_status) {
    progressBlock = `<div class="niis-board-note">Latest run: ${escapeHtml(task.latest_run_status)}${task.latest_run_adapter_id ? ` · ${escapeHtml(task.latest_run_adapter_id)}` : ""}</div>`;
  }



  const counts = [];
  if (task.active_blocker_count > 0) {
    counts.push(`<span class="niis-board-count niis-board-count-blocker">${escapeHtml(task.active_blocker_count)} blocker${task.active_blocker_count === 1 ? "" : "s"}</span>`);
  }
  if (task.pending_approval_count > 0) {
    counts.push(`<span class="niis-board-count niis-board-count-approval">${escapeHtml(task.pending_approval_count)} approval${task.pending_approval_count === 1 ? "" : "s"}</span>`);
  }
  const countsBlock = counts.length > 0
    ? `<div class="niis-board-counts">${counts.join("")}</div>`
    : "";

  return `
    <a class="niis-board-card" href="/tasks/${encodeURIComponent(task.task_id)}" data-task-id="${escapeHtml(task.task_id)}" data-task-status="${escapeHtml(task.status)}">
      <div class="niis-board-card-row">
        <div class="niis-board-card-meta">
          <div class="niis-board-card-title">${escapeHtml(task.task_title)}</div>
          <div class="niis-board-card-sub">${escapeHtml(task.priority)} priority</div>
        </div>
        ${phaseBadge}
      </div>
      ${progressBlock}
      ${countsBlock}
    </a>`;
}

function renderTaskBoardView({ dashboard, subtaskProgressByTaskId }) {



  const entriesByStatus = new Map(dashboard.task_board.map((group) => [group.status, group.entries]));
  const columns = BOARD_COLUMNS.map((col) => {
    const entries = col.statuses.flatMap((status) => entriesByStatus.get(status) ?? []);
    return { ...col, entries };
  });

  const cols = columns.map((col) => {
    const cards = col.entries.length === 0
      ? `<p class="niis-board-empty">No tasks.</p>`
      : col.entries.map((task) => renderBoardCard(task, subtaskProgressByTaskId)).join("");


    const addBtn = col.id === "pending"
      ? `<a class="niis-board-add" href="/pipeline#new-task">+ Add Task</a>`
      : "";
    return `
      <div class="niis-board-col niis-board-col-${col.id}">
        <div class="niis-board-col-header">
          <span class="niis-board-col-title">${escapeHtml(col.label)}</span>
          <span class="niis-board-col-count">${col.entries.length} task${col.entries.length === 1 ? "" : "s"}</span>
        </div>
        <div class="niis-board-col-body">
          ${cards}
        </div>
        ${addBtn}
      </div>`;
  }).join("");

  return `
    <section class="niis-board" id="board">
      ${cols}
    </section>`;
}

function renderTasksRoute({ dashboard, queueSummary = null, returnTo = "", route = {}, subtaskProgressByTaskId = null, workerMode = "semi" }) {
  const view = route?.view === "board" ? "board" : "list";
  const allTasks = dashboard.task_board.flatMap((group) => group.entries);
  const sidebarSections = buildNiisSidebarTree({
    approvalCount: buildApprovalEntries(dashboard).length,
    approvalEntries: buildApprovalEntries(dashboard),
    currentRoute: "tasks",
    currentTaskId: null,
    tasks: allTasks,
  });
  const toc = view === "board"
    ? [{ href: "#board", label: "Board" }]
    : [
      { href: "#overview", label: "Overview" },
      { href: "#queue", label: "Queue" },
      { href: "#pending", label: "Pending" },
      { href: "#in-progress", label: "In Progress" },
      { href: "#blocked", label: "Blocked" },
      { href: "#done", label: "Done" },
    ];
  const summaryCard = `
    <div class="niis-toc-card niis-toc-card-secondary">
      <h4>Task summary</h4>
      <div class="niis-task-detail-property-list">
        <div class="niis-task-detail-property-row"><span>Total tasks</span><strong>${escapeHtml(dashboard.summary.total_tasks)}</strong></div>
        <div class="niis-task-detail-property-row"><span>Active blockers</span><strong>${escapeHtml(dashboard.summary.active_blocker_count)}</strong></div>
        <div class="niis-task-detail-property-row"><span>Pending approvals</span><strong>${escapeHtml(dashboard.summary.pending_approval_count)}</strong></div>
      </div>
      <div class="niis-toc-actions">
        <a href="/pipeline#new-task" class="niis-button">Create task</a>
      </div>
    </div>`;



  const viewSwitcher = `
    <div class="niis-view-switcher" role="tablist" aria-label="Task view">
      <a class="niis-view-switcher-tab${view === "list" ? " niis-view-switcher-tab-active" : ""}" href="/tasks" role="tab" aria-selected="${view === "list"}">List</a>
      <a class="niis-view-switcher-tab${view === "board" ? " niis-view-switcher-tab-active" : ""}" href="/tasks?view=board" role="tab" aria-selected="${view === "board"}">Board</a>
    </div>`;

  const listGroups = dashboard.task_board.map((group) => {
    const groupId = group.status.toLowerCase().replace(/_/g, "-");
    return `
      <section class="niis-section" id="${escapeHtml(groupId)}">
        <h2>${escapeHtml(group.status)} <span class="niis-muted">(${escapeHtml(group.total)})</span></h2>
        ${group.total === 0
          ? '<p class="niis-muted">No tasks in this status.</p>'
          : `<div class="niis-callout-grid">${group.entries.map((task) => `
            <article class="niis-callout-card">
              <h3><a href="/tasks/${encodeURIComponent(task.task_id)}">${escapeHtml(task.task_title)}</a></h3>
              <p>Phase ${escapeHtml(task.phase)} / ${escapeHtml(task.priority)} priority</p>
              <p>${task.latest_run_status ? `Latest run: ${escapeHtml(task.latest_run_status)}` : "No runs yet"}${task.latest_run_adapter_id ? ` via ${escapeHtml(task.latest_run_adapter_id)}` : ""}</p>
              <p class="niis-muted">Blockers: ${escapeHtml(task.active_blocker_count)} / Approvals: ${escapeHtml(task.pending_approval_count)}</p>
            </article>`).join("")}</div>`}
      </section>`;
  }).join("");

  const mainBody = view === "board"
    ? `
      <article class="niis-article">
        <header class="niis-page-header">
          <h1>Task Inbox</h1>
          <p>Kanban view consolidating the 8 underlying statuses into 4 columns.</p>
        </header>
        ${viewSwitcher}
        ${renderTaskBoardView({ dashboard, subtaskProgressByTaskId })}
      </article>`
    : `
      <article class="niis-article">
        <header class="niis-page-header">
          <h1>Task Inbox</h1>
          <p>Canonical task board grouped by task status.</p>
        </header>
        ${viewSwitcher}
        <section class="niis-section" id="overview">
          <h2>Overview</h2>
          <p>Task board over the shared query model.</p>
          ${renderScopeSummary(dashboard)}
        </section>
        ${renderQueueSummaryBlock(queueSummary)}
        ${listGroups}
      </article>`;

  return renderNiisLayout({
    header: renderNiisTopbar({ currentRoute: "tasks", returnTo, workerMode }),
    leftSidebar: renderNiisSidebar({ sections: sidebarSections, renderStatusIcon: renderTaskStatusIcon }),
    main: mainBody,
    rightSidebar: renderNiisToc(toc, { extra: summaryCard }),
  });
}

function renderRunPhases(phases = []) {
  if (phases.length === 0) {
    return "<p>No lifecycle phases recorded.</p>";
  }

  return `
    <ul class="niis-item-list">
      ${phases.map((phase) => `
        <li>
          <strong>${escapeHtml(phase.value ?? "unknown phase")}</strong>
          <div>${escapeHtml(phase.phase_status ?? "recorded")}</div>
          <div>${escapeHtml(phase.summary)}</div>
          <div>${escapeHtml(formatTimestamp(phase.timestamp))}</div>
        </li>`).join("")}
    </ul>`;
}

function renderRunTimeline(activity = []) {
  if (activity.length === 0) {
    return "<p>No run activity recorded.</p>";
  }

  return `
    <ul class="niis-item-list">
      ${activity.map((entry) => `
        <li>
          <strong>${escapeHtml(entry.title)}</strong>
          <div>${escapeHtml(entry.summary)}</div>
          <div>${escapeHtml(entry.source_kind)} at ${escapeHtml(formatTimestamp(entry.timestamp))}</div>
        </li>`).join("")}
    </ul>`;
}

function renderRunValidatorDecisions(detail) {
  if (detail.verdicts.length === 0) {
    return "<p>No validator decisions recorded for this run.</p>";
  }

  return `
    <ul class="niis-item-list">
      ${detail.verdicts.map((verdict) => `
        <li>
          <strong>${escapeHtml(verdict.verdict_class)}</strong>
          <div>${escapeHtml(verdict.reason)}</div>
          <div>Reviewer: ${escapeHtml(verdict.reviewer_id)}</div>
          <div>Next: ${escapeHtml(verdict.next_action)}</div>
        </li>`).join("")}
    </ul>`;
}

function renderRunEvidenceSummary(detail) {
  if (!detail.latest_evidence_packet) {
    return "<p>No evidence packet recorded for this run.</p>";
  }

  const evidence = detail.latest_evidence_packet;
  return `
    <div class="niis-stack-list">
      <article class="niis-task-card">
        <h4>${escapeHtml(detail.latest_verdict?.verdict_class ?? "Evidence")}</h4>
        <div>Authenticity: ${escapeHtml(evidence.authenticity_status)}</div>
        <div>Items: ${escapeHtml(evidence.items.length)}</div>
        <div>Runtime evidence: ${escapeHtml(evidence.markers.runtime_evidence_succeeded ? "yes" : "no")}</div>
      </article>
      <ul class="niis-item-list">
        ${evidence.items.map((item) => `
          <li>
            <strong>${escapeHtml(item.type)}</strong>
            <div>${escapeHtml(item.source)}</div>
            <div>${escapeHtml(item.content)}</div>
            ${item.raw_output_ref ? `<div>Raw output ref: ${escapeHtml(item.raw_output_ref)}</div>` : ""}
          </li>`).join("")}
      </ul>
    </div>`;
}

function renderRunArtifacts(detail, taskWorkbenchArtifacts = null) {
  const runLog = detail.run_log;
  const checkpoints = detail.checkpoints ?? [];

  return `
    <div class="niis-stack-list">
      <article class="niis-task-card">
        <h4>Run Log</h4>
        ${runLog
    ? `
            <div>Storage: ${escapeHtml(runLog.run_log?.storage ?? detail.run.run_log.storage)}</div>
            <div>Bytes: ${escapeHtml(runLog.run_log?.bytes ?? detail.run.run_log.bytes)}</div>
            <div>SHA256: ${escapeHtml(runLog.run_log?.sha256 ?? detail.run.run_log.sha256)}</div>
            ${runLog.raw_output_ref ? `<div>Ref: ${escapeHtml(runLog.raw_output_ref)}</div>` : ""}
            ${runLog.raw_output !== null && runLog.raw_output !== undefined
        ? `<pre class="niis-prompt-block">${escapeHtml(typeof runLog.raw_output === "string" ? runLog.raw_output : JSON.stringify(runLog.raw_output, null, 2))}</pre>`
        : ""}
          `
    : "<div>No persisted run log artifact.</div>"}
      </article>
      <article class="niis-task-card">
        <h4>Checkpoints</h4>
        ${checkpoints.length === 0
    ? "<div>No checkpoints captured.</div>"
    : `<ul class="niis-item-list">${checkpoints.map((checkpoint) => `
              <li>
                <strong>${escapeHtml(checkpoint.id)}</strong>
                <div>${escapeHtml(checkpoint.context_summary)}</div>
                <div>${escapeHtml(checkpoint.resume_instructions)}</div>
              </li>`).join("")}</ul>`}
      </article>
      <article class="niis-task-card">
        <h4>Final Report</h4>
        ${renderReportLinks(taskWorkbenchArtifacts)}
      </article>
    </div>`;
}

function renderProjectSignalList(signals, emptyLabel) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return `<p>${escapeHtml(emptyLabel)}</p>`;
  }

  return `
    <ul class="niis-item-list">
      ${signals.map((signal) => `
        <li>
          <strong>${escapeHtml(signal.summary ?? signal.id ?? "signal")}</strong>
          <div>Status: ${escapeHtml(signal.status ?? "unknown")}</div>
          ${signal.details ? `<div>${escapeHtml(signal.details)}</div>` : ""}
        </li>`).join("")}
    </ul>`;
}

function renderProjectWorkbenchLink(dashboard) {
  const activeTask = dashboard.running_work?.[0] ?? null;

  if (activeTask?.task_id) {
    return `<a href="/tasks/${encodeURIComponent(activeTask.task_id)}">Open active workbench for ${escapeHtml(activeTask.task_title ?? activeTask.task_id)}</a>`;
  }

  const approvalTask = dashboard.approval_queue?.[0] ?? null;

  if (approvalTask?.task_id) {
    return `<a href="/tasks/${encodeURIComponent(approvalTask.task_id)}">Open approval-gated workbench for ${escapeHtml(approvalTask.task_title ?? approvalTask.task_id)}</a>`;
  }

  return `<a href="/tasks">Open the task inbox</a>`;
}

function renderRunRuntimeChoice(detail) {
  const runtimeChoice = detail.runtime_choice;

  if (!runtimeChoice) {
    return "<p>No runtime-choice record found; using persisted run metadata only.</p>";
  }

  return `
    <article class="niis-task-card">
      <h4>${escapeHtml(runtimeChoice.decision_type)}</h4>
      <div>${escapeHtml(runtimeChoice.human_readable_summary)}</div>
      <div>Route: ${escapeHtml(runtimeChoice.route_chosen)}</div>
      <div>Policy refs: ${escapeHtml(formatMaybeList(runtimeChoice.policy_refs))}</div>
    </article>`;
}

function renderLatestVerdict(detail) {
  if (!detail.latest_verdict) {
    return "<p>No verdict recorded yet.</p>";
  }

  const verdict = detail.latest_verdict;
  const evidence = detail.latest_evidence_packet;

  return `
    <div class="niis-stack-list">
      <article class="niis-task-card">
        <h4>${escapeHtml(verdict.verdict_class)}</h4>
        <div>${escapeHtml(verdict.reason)}</div>
        <div>Next: ${escapeHtml(verdict.next_action)}</div>
        <div>Reviewer: ${escapeHtml(verdict.reviewer_id)}</div>
      </article>
      ${evidence ? `
        <article class="niis-task-card">
          <h4>Evidence Summary</h4>
          <div>Authenticity: ${escapeHtml(evidence.authenticity_status)}</div>
          <div>Items: ${escapeHtml(evidence.items.length)}</div>
          <div>Runtime evidence: ${escapeHtml(evidence.markers.runtime_evidence_succeeded ? "yes" : "no")}</div>
          <div>Browser checks: ${escapeHtml(evidence.markers.browser_live_checks.length)}</div>
          <div>Auth surfaces: ${escapeHtml(evidence.markers.auth_surfaces_attempted.length)}</div>
        </article>` : ""}
    </div>`;
}

function buildApprovalEntries(dashboard) {
  return dashboard.approval_queue ?? [];
}

function renderApprovalQueueEntry(entry, mutableState) {
  const canApproveCurrentPlan =
    mutableState
    && entry.task_status === "PENDING";
  return `
    <article class="niis-approval-card">
      <h4>${escapeHtml(entry.task_title)}</h4>
      <div>${escapeHtml(entry.task_status ?? "unknown")} / task phase ${escapeHtml(entry.task_phase ?? "n/a")} / priority ${escapeHtml(entry.task_priority ?? "n/a")}</div>
      <div>Approval status: ${escapeHtml(entry.approval_status)}</div>
      <div>Requested action: ${escapeHtml(entry.action_id ?? entry.requested_action)}</div>
      <div>Risk summary: ${escapeHtml(entry.risk_summary)}</div>
      <div>Next: ${escapeHtml(entry.next_action)}</div>
      ${entry.latest_decision_summary ? `<div>Latest governance note: ${escapeHtml(entry.latest_decision_summary)}</div>` : ""}
      ${entry.notes.length > 0 ? `<div>Notes: ${escapeHtml(entry.notes.join(" | "))}</div>` : ""}
      <div class="niis-button-row">
        <a href="/tasks/${encodeURIComponent(entry.task_id)}">Open task</a>
      </div>
      ${canApproveCurrentPlan ? `
      <form class="niis-stack-form" method="post" action="/tasks/${encodeURIComponent(entry.task_id)}/actions/approve">
        <label>
          <span>Note</span>
          <textarea name="note" rows="3" placeholder="Optional plan approval note."></textarea>
        </label>
        <div class="niis-button-row">
          <button type="submit">Approve current plan</button>
        </div>
      </form>` : `
      <p class="niis-muted">
        Read-only governance evidence. Use the task's allowed lifecycle
        actions to resolve its current state.
      </p>`}
    </article>`;
}

function renderApprovalQueueGroup(group, mutableState) {
  if (group.total === 0) {
    return "";
  }

  return `
    <section class="niis-panel">
      <h3>${escapeHtml(group.label)} <span class="niis-muted">(${escapeHtml(group.total)})</span></h3>
      <div class="niis-stack-list">
        ${group.entries.map((entry) => renderApprovalQueueEntry(entry, mutableState)).join("")}
      </div>
    </section>`;
}

function renderOperatorSubtaskBranchSection(subtaskBranches) {
  if (subtaskBranches.length === 0) {
    return `
      <section class="niis-section" id="subtask-branches">
        <h2>Reviewable subtask branches <span class="niis-muted">(0)</span></h2>
        <p class="niis-muted">No legacy subtask branches are available for read-only inspection.</p>
      </section>`;
  }
  const grouped = new Map();
  for (const entry of subtaskBranches) {
    if (!grouped.has(entry.task_id)) grouped.set(entry.task_id, { task_id: entry.task_id, task_title: entry.task_title, entries: [] });
    grouped.get(entry.task_id).entries.push(entry);
  }
  const groups = Array.from(grouped.values()).map((group) => {


    const hasSteps = group.entries.some((entry) => typeof entry.merge_step === "number");
    const sortedEntries = hasSteps
      ? [...group.entries].sort((a, b) => {
        const sa = typeof a.merge_step === "number" ? a.merge_step : 999;
        const sb = typeof b.merge_step === "number" ? b.merge_step : 999;
        return sa - sb;
      })
      : group.entries;
    const rows = sortedEntries.map((entry) => {
      const stepLabel = typeof entry.merge_step === "number"
        ? `<span class="niis-task-status-badge" data-kind="review-step" title="Recorded dependency order for branch review.">review ${escapeHtml(entry.merge_step)}</span>`
        : "";
      const blocksOn = Array.isArray(entry.blocks_on) && entry.blocks_on.length > 0
        ? `<br/><span class="niis-muted" style="font-size: 0.8125rem;">blocks on: ${entry.blocks_on.map((d) => `<code>${escapeHtml(d)}</code>`).join(", ")}</span>`
        : "";
      const reviewTarget = entry.branch.pr_url
        ? `<a href="${escapeHtml(entry.branch.pr_url)}" target="_blank" rel="noopener">Open remote review</a>`
        : '<span class="niis-muted">Local branch only</span>';
      return `
        <tr>
          <td><strong>${escapeHtml(entry.subtask_id)}</strong> ${stepLabel}<br/><span class="niis-muted">${escapeHtml(entry.role_id ?? "—")}</span>${blocksOn}</td>
          <td><code>${escapeHtml(entry.branch.name)}</code></td>
          <td>${escapeHtml(entry.branch.merge_status ?? "pending")}</td>
          <td>${reviewTarget}</td>
        </tr>`;
    }).join("");
    const advisory = hasSteps
      ? `<p class="niis-muted" style="font-size: 0.8125rem;">Recorded dependency order for review: ${sortedEntries.map((e, idx) => `<strong>${idx + 1}.</strong> <code>${escapeHtml(e.subtask_id)}</code>`).join(" &rarr; ")}</p>`
      : "";
    return `
      <article class="niis-callout-card">
        <h3><a href="/tasks/${encodeURIComponent(group.task_id)}">${escapeHtml(group.task_title)}</a></h3>
        ${advisory}
        <table class="niis-table">
          <thead><tr><th>Subtask</th><th>Branch</th><th>Recorded status</th><th>Review target</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </article>`;
  }).join("");
  return `
    <section class="niis-section" id="subtask-branches">
      <h2>Reviewable subtask branches <span class="niis-muted">(${subtaskBranches.length})</span></h2>
      <p>Read-only inspection of legacy subtask branches. Reliability RC requires a canonical <code>PASS</code> before a reviewable branch is promoted. Niis does not publish, land, or delete branches from this screen; complete the final landing manually with your normal Git workflow.</p>
      <div class="niis-stack-list">${groups}</div>
    </section>`;
}

function renderOperatorTaskBranchSection(taskBranches) {
  if (taskBranches.length === 0) {
    return `
      <section class="niis-section" id="task-branches">
        <h2>Reviewable task branches <span class="niis-muted">(0)</span></h2>
        <p class="niis-muted">No task branches are available for read-only inspection.</p>
      </section>`;
  }
  const rows = taskBranches.map((entry) => {
    const reviewTarget = entry.pr_url
      ? `<a href="${escapeHtml(entry.pr_url)}" target="_blank" rel="noopener">Open remote review</a>`
      : '<span class="niis-muted">Local branch only</span>';
    return `
      <tr>
        <td><a href="/tasks/${encodeURIComponent(entry.task_id)}"><strong>${escapeHtml(entry.task_title)}</strong></a><br/><span class="niis-muted">${escapeHtml(entry.queue_state ?? "—")}</span></td>
        <td><code>${escapeHtml(entry.branch_name)}</code></td>
        <td>${reviewTarget}</td>
      </tr>`;
  }).join("");
  return `
    <section class="niis-section" id="task-branches">
      <h2>Reviewable task branches <span class="niis-muted">(${taskBranches.length})</span></h2>
      <p>Read-only task-branch inventory. A successful attempt leaves one reviewable branch; Niis never lands it into the primary checkout. Finish the landing manually after reviewing the recorded evidence.</p>
      <table class="niis-table">
        <thead><tr><th>Task</th><th>Branch</th><th>Review target</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function buildApprovalsAuditEntries({ snapshot, dashboard }) {
  const stream = Array.isArray(dashboard?.activity_stream) ? dashboard.activity_stream : [];
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  if (stream.length > 0) {
    return stream.slice(0, 20).map((e) => ({
      ts: e?.ts || e?.timestamp || "—",
      desc: `${e?.verb ?? ""} ${e?.target ?? e?.task_id ?? ""}`.trim() || "event",
      actor: e?.agent || e?.actor || "system",
    }));
  }
  if (runs.length > 0) {
    return runs.slice(0, 20).map((r) => ({
      ts: r?.completed_at || r?.started_at || r?.created_at || "—",
      desc: `Run ${r?.run_id ?? r?.id ?? ""} → ${r?.status ?? "unknown"}`,
      actor: r?.role_id || r?.agent_id || "executor",
    }));
  }
  return [];
}

function renderApprovalsAuditLogSection({ snapshot, dashboard }) {
  const entries = buildApprovalsAuditEntries({ snapshot, dashboard });
  const body = entries.length === 0
    ? '<p class="niis-muted">No recent events.</p>'
    : `<table class="niis-table">
        <thead><tr><th>When</th><th>Event</th><th>Actor</th></tr></thead>
        <tbody>
          ${entries.map((e) => `
            <tr>
              <td><code>${escapeHtml(e.ts)}</code></td>
              <td>${escapeHtml(e.desc)}</td>
              <td>${escapeHtml(e.actor)}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  return `
    <section class="niis-section" id="audit-log">
      <h2>Audit log <span class="niis-muted">(${entries.length})</span></h2>
      <p>Read-only history of recent runs and operator-relevant activity. Approvals above are the live queue; this list is what already happened.</p>
      ${body}
    </section>`;
}

function renderApprovalsRoute({ dashboard, mutableState, operatorDecisions = null, returnTo = "", snapshot = {}, workerMode = "semi" }) {
  const entries = buildApprovalEntries(dashboard);
  const subtaskBranches = operatorDecisions?.subtask_branches ?? [];
  const taskBranches = operatorDecisions?.task_branches ?? [];
  const sidebarSections = buildNiisSidebarTree({
    approvalCount: entries.length,
    approvalEntries: entries,
    currentRoute: "approvals",
    currentTaskId: null,
    tasks: dashboard.task_board.flatMap((group) => group.entries),
  });
  const toc = [
    { href: "#overview", label: "Overview" },
    { href: "#subtask-branches", label: "Subtask branches" },
    { href: "#task-branches", label: "Task branches" },
    { href: "#governance", label: "Governance queue" },
    { href: "#audit-log", label: "Audit log" },
  ];
  const summaryCard = `
    <div class="niis-toc-card niis-toc-card-secondary">
      <h4>Decision summary</h4>
      <div class="niis-task-detail-property-list">
        <div class="niis-task-detail-property-row"><span>Subtask branches</span><strong>${escapeHtml(subtaskBranches.length)}</strong></div>
        <div class="niis-task-detail-property-row"><span>Task branches</span><strong>${escapeHtml(taskBranches.length)}</strong></div>
        <div class="niis-task-detail-property-row"><span>Governance gates</span><strong>${escapeHtml(entries.length)}</strong></div>
      </div>
    </div>`;

  const queueContent = entries.length > 0
    ? dashboard.approval_queue_groups.map((group) => renderApprovalQueueGroup(group, mutableState)).join("")
    : '<p class="niis-muted">No pending governance approvals.</p>';

  return renderNiisLayout({
    header: renderNiisTopbar({ currentRoute: "approvals", returnTo, workerMode }),
    leftSidebar: renderNiisSidebar({ sections: sidebarSections, renderStatusIcon: renderTaskStatusIcon }),
    main: `
      <article class="niis-article">
        <header class="niis-page-header">
          <h1>Operator Decisions</h1>
          <p>Governance decisions plus read-only inspection of reviewable and legacy branches.</p>
        </header>
        <section class="niis-section" id="overview">
          <h2>Overview</h2>
          <p>Governance actions remain explicit. Branch inventories are evidence surfaces only and never expose publish, landing, or deletion controls.</p>
        </section>
        ${renderOperatorSubtaskBranchSection(subtaskBranches)}
        ${renderOperatorTaskBranchSection(taskBranches)}
        <section class="niis-section" id="governance">
          <h2>Governance approval queue <span class="niis-muted">(${entries.length})</span></h2>
          <p>Plan approval is available only through the task lifecycle. Other policy-gate records remain read-only evidence.</p>
          ${queueContent}
        </section>
        ${renderApprovalsAuditLogSection({ snapshot, dashboard })}
      </article>`,
    rightSidebar: renderNiisToc(toc, { extra: summaryCard }),
  });
}

function renderRunDetailRoute({ route, snapshot, taskWorkbenchArtifacts = null }) {
  const detail = buildRunObservabilityView({
    runId: route.runId,
    snapshot,
  });

  if (!detail?.run) {
    return `
      <section class="niis-panel">
        <h2>Run Detail</h2>
        <p>Run not found.</p>
      </section>`;
  }

  return `
    <section class="niis-panel">
      <h2>Run Detail</h2>
      <div class="niis-card-grid">
        <div class="niis-card"><span class="niis-label">Run</span><span class="niis-value">${escapeHtml(detail.run.id)}</span></div>
        <div class="niis-card"><span class="niis-label">Status</span><span class="niis-value">${escapeHtml(detail.run.status)}</span></div>
        <div class="niis-card"><span class="niis-label">Adapter</span><span class="niis-value">${escapeHtml(detail.run.adapter_id)}</span></div>
        <div class="niis-card"><span class="niis-label">Agent</span><span class="niis-value">${escapeHtml(detail.run.agent_id)}</span></div>
        <div class="niis-card"><span class="niis-label">Invocation</span><span class="niis-value niis-value-small">${escapeHtml(detail.run.invocation_source)}</span></div>
        <div class="niis-card"><span class="niis-label">Exit Code</span><span class="niis-value">${escapeHtml(detail.run.exit_code ?? "running")}</span></div>
        <div class="niis-card"><span class="niis-label">Duration</span><span class="niis-value niis-value-small">${escapeHtml(detail.run.cost.duration_ms)} ms</span></div>
        <div class="niis-card"><span class="niis-label">Cost</span><span class="niis-value niis-value-small">$${escapeHtml(detail.run.cost.estimated_usd)}</span></div>
      </div>
      <p>Task: <a href="/tasks/${encodeURIComponent(detail.run.task_id)}">${escapeHtml(detail.task?.title ?? detail.run.task_id)}</a></p>
      <p>Started: ${escapeHtml(formatTimestamp(detail.run.started_at))}</p>
      <p>Finished: ${escapeHtml(formatTimestamp(detail.run.finished_at))}</p>
    </section>
    <section class="niis-panel niis-two-column">
      <div>
        <h3>Runtime Choice</h3>
        ${renderRunRuntimeChoice(detail)}
      </div>
      <div>
        <h3>Run Phases</h3>
        ${renderRunPhases(detail.phases)}
      </div>
    </section>
    <section class="niis-panel niis-two-column">
      <div>
        <h3>Activity Timeline</h3>
        ${renderRunTimeline(detail.activity)}
      </div>
      <div>
        <h3>Validator Decisions</h3>
        ${renderRunValidatorDecisions(detail)}
      </div>
    </section>
    <section class="niis-panel niis-two-column">
      <div>
        <h3>Evidence Summary</h3>
        ${renderRunEvidenceSummary(detail)}
      </div>
      <div>
        <h3>Produced Artifacts</h3>
        ${renderRunArtifacts(detail, taskWorkbenchArtifacts)}
      </div>
    </section>`;
}

function renderRoleSettingsTable(projectContext) {
  const roles = Array.isArray(projectContext.roleConfig?.manifests)
    ? projectContext.roleConfig.manifests
    : [];
  const overrides = projectContext.roleConfig?.overrides?.roles ?? {};
  if (roles.length === 0) {
    return "<p>No role manifests loaded.</p>";
  }
  const provenanceLabel = (p) => {
    if (p === "built-in") return "built-in";
    if (p === "local-markdown") return "local (markdown)";
    if (p === "local") return "local";
    return p ?? "—";
  };
  const rows = roles.map((manifest) => {
    const override = overrides[manifest.id] ?? {};
    const modelRuntime = override.model_preference?.runtime ?? manifest.model_preference?.runtime ?? "";
    const modelName = override.model_preference?.model ?? manifest.model_preference?.model ?? "";
    const monthlyUsd = override.budget?.monthly_usd ?? manifest.budget?.monthly_usd ?? "";
    const perRunUsd = override.budget?.per_run_usd ?? manifest.budget?.per_run_usd ?? "";
    const isEnabled = override.enabled !== false;
    const overriddenBadge = overrides[manifest.id] ? '<span class="niis-cost-badge" data-kind="duration"><span class="niis-cost-badge-label">override</span></span>' : "";
    const disabledBadge = !isEnabled ? '<span class="niis-cost-badge" data-kind="alert"><span class="niis-cost-badge-label">disabled</span></span>' : "";
    const scopeCount = Array.isArray(manifest.scope?.path_globs) ? manifest.scope.path_globs.length : 0;
    const authoritySummary = `${manifest.authority?.can?.length ?? 0} can / ${manifest.authority?.cannot?.length ?? 0} cannot`;
    const provenance = manifest._provenance ?? "—";


    const enabledToggle = `
      <form method="post" action="/project/settings/role/${encodeURIComponent(manifest.id)}" class="niis-role-toggle-form" data-role-toggle-form>
        <input type="hidden" name="intent" value="enabled" />
        <input type="hidden" name="enabled" value="${isEnabled ? "1" : "0"}" data-role-toggle-value />
        <label class="niis-role-toggle-switch" title="${isEnabled ? "Disable" : "Enable"} role">
          <input type="checkbox" class="niis-role-toggle-input" data-role-toggle-input ${isEnabled ? "checked" : ""} aria-label="Toggle role enabled" />
          <span class="niis-role-toggle-track" aria-hidden="true"></span>
        </label>
      </form>`;
    return `
      <tr${!isEnabled ? ' class="niis-role-row-disabled"' : ""}>
        <td>
          <strong>${escapeHtml(manifest.id)}</strong> ${overriddenBadge} ${disabledBadge}<br/>
          <span class="niis-text-muted">${escapeHtml(manifest.lane ?? "")} · ${escapeHtml(provenanceLabel(provenance))}</span>
        </td>
        <td>${enabledToggle}</td>
        <td>${escapeHtml(String(manifest.priority ?? 0))}${manifest.safe_fallback ? " (fallback)" : ""}</td>
        <td>${escapeHtml(String(scopeCount))}</td>
        <td>${escapeHtml(authoritySummary)}</td>
        <td>
          <form method="post" action="/project/settings/role/${encodeURIComponent(manifest.id)}" class="niis-form-inline">
            <label class="niis-form-field"><span>Runtime</span><select name="model_runtime"><option value=""${modelRuntime === "" ? " selected" : ""}>(default)</option><option value="codex_local"${modelRuntime === "codex_local" ? " selected" : ""}>codex_local</option><option value="claude_code_local"${modelRuntime === "claude_code_local" ? " selected" : ""}>claude_code_local</option></select></label>
            <label class="niis-form-field"><span>Model</span><input type="text" name="model_name" value="${escapeHtml(String(modelName))}" placeholder="(default)" /></label>
            <label class="niis-form-field"><span>Monthly $</span><input type="number" min="0" step="0.01" name="budget_monthly_usd" value="${escapeHtml(String(monthlyUsd))}" /></label>
            <label class="niis-form-field"><span>Per-run $</span><input type="number" min="0" step="0.01" name="budget_per_run_usd" value="${escapeHtml(String(perRunUsd))}" /></label>
            <button type="submit">Save</button>
          </form>
        </td>
      </tr>`;
  }).join("");
  return `
    <table class="niis-table">
      <thead>
        <tr>
          <th>Role / Source</th>
          <th>Enabled</th>
          <th>Priority</th>
          <th>Scope globs</th>
          <th>Authority</th>
          <th>Configuration</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderRoutingPolicyForm(projectContext) {
  const overrides = projectContext.roleConfig?.overrides?.routing_policy ?? {};
  const policyDefaults = projectContext.roleConfig?.routing_policy_defaults ?? {
    complexity_tiers: [
      { tier: "budget", max_score: 4 },
      { tier: "standard", max_score: 8 },
      { tier: "premium", max_score: Infinity },
    ],
    max_parallel: 2,
  };
  const tiers = Array.isArray(overrides.complexity_tiers) ? overrides.complexity_tiers : policyDefaults.complexity_tiers;
  const findTierMax = (tier) => {
    const entry = tiers.find((t) => t.tier === tier);
    if (!entry) return "";
    if (!Number.isFinite(entry.max_score)) return "";
    return String(entry.max_score);
  };
  return `
    <form method="post" action="/project/settings" class="niis-form-stack">
      <label class="niis-form-field"><span>Max parallel (fixed for Reliability RC)</span><input type="number" min="1" max="1" name="max_parallel" value="1" readonly /></label>
      <label class="niis-form-field"><span>Budget tier max score</span><input type="number" min="0" name="complexity_tier_budget_max" value="${escapeHtml(findTierMax("budget"))}" /></label>
      <label class="niis-form-field"><span>Standard tier max score</span><input type="number" min="0" name="complexity_tier_standard_max" value="${escapeHtml(findTierMax("standard"))}" /></label>
      <button type="submit">Save routing policy</button>
    </form>`;
}

function renderMergePolicyForm(projectContext) {
  const overrides = projectContext?.roleConfig?.overrides?.merge_policy ?? {};
  const effective = projectContext?.roleConfig?.overrides?.effective_merge_policy ?? null;
  const configuredMode = typeof overrides.mode === "string" ? overrides.mode : effective?.mode;
  const legacyOverrideNotice = configuredMode && configuredMode !== "none"
    ? '<p class="niis-muted">A legacy promotion override is recorded in project configuration. Reliability RC does not expose or execute that override from the UI.</p>'
    : "";
  return `
    <section class="niis-callout-card" aria-label="Reliability RC promotion policy">
      <h4>Supervised promotion</h4>
      <p>Every attempt runs in its own worktree. Deterministic gates and a fresh review must produce canonical <code>PASS</code> before Niis creates one reviewable branch.</p>
      <p>The primary checkout is never changed by the UI. Review the branch and evidence, then land it manually with your normal Git workflow.</p>
      ${legacyOverrideNotice}
    </section>`;
}

function renderAutonomousWorkerForm(projectContext) {
  const overrides = projectContext?.roleConfig?.overrides ?? {};
  const worker = overrides.autonomous_worker ?? { enabled: false, max_concurrent: 1, poll_interval_ms: 5000 };
  const pollMs = Number.isInteger(worker.poll_interval_ms) && worker.poll_interval_ms >= 500 ? worker.poll_interval_ms : 5000;
  const configuredMode = worker.enabled === true ? "auto" : "supervised";
  return `
    <section class="niis-callout-card" aria-label="Reliability RC daemon policy">
      <h4>Readiness-gated scheduler</h4>
      <p>Reliability RC fixes scheduler concurrency at <code>1</code>. The current project mode is <code>${escapeHtml(configuredMode)}</code> with a configured poll interval of <code>${escapeHtml(String(pollMs))} ms</code>.</p>
      <p><code>niis serve --once</code> is the supervised daily-driver path. <code>niis serve --daemon</code> remains locked until the durable rollout and clean-task streak verify successfully.</p>
    </section>`;
}

function renderReviewAndAutoRepairForm(projectContext) {
  const overrides = projectContext?.roleConfig?.overrides ?? {};
  const llmReview = overrides.llm_review ?? { enabled: false, mode: "standard", model_preference: null, runtime: null };
  const autoRepair = overrides.auto_repair ?? { enabled: false, max_attempts: 2 };
  const llmEnabledChecked = llmReview.enabled === true ? "checked" : "";
  const llmMode = typeof llmReview.mode === "string" ? llmReview.mode : "standard";
  const llmRuntime = typeof llmReview.runtime === "string" ? llmReview.runtime : "";
  const llmModel = typeof llmReview.model_preference === "string" ? llmReview.model_preference : "";
  const repairMax = Number.isInteger(autoRepair.max_attempts) && autoRepair.max_attempts > 0 ? autoRepair.max_attempts : 2;
  const repairEnabledChecked = autoRepair.enabled === true ? "checked" : "";
  const runtimeOptions = [
    { label: "Auto (first available)", value: "" },
    { label: "codex_local", value: "codex_local" },
    { label: "claude_code_local", value: "claude_code_local" },
  ];
  const llmModeOptions = [
    { description: "Fast + cheap: LLM sees summary + diff only.", label: "Standard", value: "standard" },
    { description: "Spawns detached worktree, agent has shell + test access. Slower, pricier, deeper.", label: "Adversarial", value: "adversarial" },
  ];
  return `
    <form method="post" action="/project/settings/review" class="niis-form-stack">
      <fieldset class="niis-form-fieldset">
        <legend>LLM reviewer</legend>
        <label class="niis-form-choice">
          <input type="checkbox" name="llm_review_enabled" value="1" ${llmEnabledChecked} />
          <span class="niis-form-choice-text">
            <span class="niis-form-choice-title">Run LLM reviewer as part of the validator chain</span>
            <span class="niis-form-choice-description">Adds an acceptance-criteria judge after authenticity + security validators. Returns PASS / DEFECT / EVIDENCE_GAP. Disabled means validator lane falls back to deterministic completion-proof only.</span>
          </span>
        </label>
        <fieldset class="niis-form-fieldset" style="margin-top: 0.75rem;">
          <legend>Mode</legend>
          ${llmModeOptions.map((option) => `
            <label class="niis-form-choice">
              <input type="radio" name="llm_review_mode" value="${escapeHtml(option.value)}" ${llmMode === option.value ? "checked" : ""} />
              <span class="niis-form-choice-text">
                <span class="niis-form-choice-title">${escapeHtml(option.label)}</span>
                <span class="niis-form-choice-description">${escapeHtml(option.description)}</span>
              </span>
            </label>`).join("")}
        </fieldset>
        <label class="niis-form-field" style="margin-top: 0.5rem;">
          <span>Runtime</span>
          <select name="llm_review_runtime">
            ${runtimeOptions.map((opt) => `<option value="${escapeHtml(opt.value)}" ${llmRuntime === opt.value ? "selected" : ""}>${escapeHtml(opt.label)}</option>`).join("")}
          </select>
        </label>
        <label class="niis-form-field">
          <span>Model preference (optional)</span>
          <input type="text" name="llm_review_model_preference" value="${escapeHtml(llmModel)}" placeholder="leave blank for runtime default" />
        </label>
      </fieldset>
      <fieldset class="niis-form-fieldset">
        <legend>Bounded auto-repair</legend>
        <label class="niis-form-choice">
          <input type="checkbox" name="auto_repair_enabled" value="1" ${repairEnabledChecked} />
          <span class="niis-form-choice-text">
            <span class="niis-form-choice-title">Queue a new attempt after a repairable defect</span>
            <span class="niis-form-choice-description">Keeps the approved task and prior verdict immutable. Only a separate, sandboxed attempt receives the prior finding as context.</span>
          </span>
        </label>
        <label class="niis-form-field" style="margin-top: 0.5rem;">
          <span>Max auto-repair attempts</span>
          <input type="number" name="auto_repair_max_attempts" min="1" max="5" value="${escapeHtml(String(repairMax))}" />
        </label>
      </fieldset>
      <div><button type="submit">Save review + auto-repair settings</button></div>
    </form>`;
}





function buildGoalsView(snapshot) {
  const goals = Array.isArray(snapshot?.goals) ? snapshot.goals : [];
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  return goals.map((goal) => {
    let progress = null;
    try {
      progress = summarizeGoalProgress({ goal, tasks, runs });
    } catch {
      progress = null;
    }
    return { goal, progress };
  });
}

const GOAL_STATUS_COLORS = {
  achieved: "#16a34a",
  active: "#5b8def",
  abandoned: "#9ca3af",
  planned: "#a855f7",
};

function renderGoalCard({ goal, progress }) {
  const accent = GOAL_STATUS_COLORS[goal.status] ?? "#9ca3af";
  const taskCount = progress?.task_count ?? 0;
  const doneCount = progress?.task_status_counts?.DONE ?? 0;
  const completionPct = taskCount > 0 ? Math.round((doneCount / taskCount) * 100) : null;
  const totalCost = progress?.total_cost_usd ?? 0;
  const totalRuns = progress?.total_runs ?? 0;
  const segments = Object.entries(progress?.task_status_counts ?? {})
    .filter(([, count]) => count > 0);
  return `
    <article class="niis-goal-card" style="--goal-accent: ${accent};">
      <header class="niis-goal-card-header">
        <div class="niis-goal-card-title-block">
          <h3 class="niis-goal-card-title">${escapeHtml(goal.title)}</h3>
          <p class="niis-goal-card-desc">${escapeHtml(goal.description)}</p>
        </div>
        <span class="niis-goal-card-status niis-goal-card-status-${goal.status}">${escapeHtml(goal.status)}</span>
      </header>
      <div class="niis-goal-card-progress">
        <div class="niis-goal-card-progress-meta">
          <span class="niis-goal-card-progress-label">${completionPct == null ? "No tasks linked" : `${doneCount}/${taskCount} tasks done`}</span>
          ${completionPct != null ? `<span class="niis-goal-card-progress-pct">${completionPct}%</span>` : ""}
        </div>
        ${completionPct != null ? `
          <div class="niis-goal-card-progress-track">
            <div class="niis-goal-card-progress-fill" style="width: ${completionPct}%;"></div>
          </div>` : ""}
      </div>
      ${segments.length > 0 ? `
        <div class="niis-goal-card-segments">
          ${segments.map(([status, count]) => `
            <span class="niis-goal-card-segment niis-goal-card-segment-${status.toLowerCase()}">${escapeHtml(status)} ${escapeHtml(count)}</span>`).join("")}
        </div>` : ""}
      <footer class="niis-goal-card-footer">
        <span>${escapeHtml(totalRuns)} run${totalRuns === 1 ? "" : "s"}</span>
        <span>${escapeHtml(formatCost(totalCost))}</span>
        <span>${escapeHtml(goal.level)}</span>
      </footer>
    </article>`;
}

function renderGoalsSection(snapshot) {
  const goalsView = buildGoalsView(snapshot);
  if (goalsView.length === 0) {
    return `
      <p class="niis-muted">No goals defined yet. Goals link related tasks together for higher-level reporting and cost attribution. The schema and storage exist; CRUD UI is on the roadmap.</p>`;
  }
  return `
    <div class="niis-goals-grid">
      ${goalsView.map(renderGoalCard).join("")}
    </div>`;
}

function renderProjectRoute({ dashboard, projectContext, returnTo = "", snapshot = {}, workerMode = "semi" }) {
  const attachment = projectContext.attachment;
  const profile = projectContext.profile;
  const workflow = projectContext.workflow;
  const codemap = projectContext.codemap;
  const runtimeAvailability = projectContext.doctor?.runtime_availability ?? [];
  const doctorCounts = projectContext.doctor?.counts ?? {
    error: 0,
    ok: 0,
    warning: 0,
  };
  const doctorHighlights = projectContext.doctor?.highlights ?? [];
  const validationSurface = projectContext.validationSurfaceRoot ?? attachment?.validation_surface_root ?? "unknown";
  const artifactCount = Array.isArray(attachment?.generated_artifacts) ? attachment.generated_artifacts.length : 0;
  const codemapLanguages = Array.isArray(codemap?.language_breakdown)
    ? codemap.language_breakdown.map((entry) => `${entry.language} (${entry.files})`)
    : [];

  const dashboardTasks = Array.isArray(dashboard?.task_board)
    ? dashboard.task_board.flatMap((group) => group.entries)
    : [];
  const projectApprovalEntries = buildApprovalEntries(dashboard ?? {});
  const sidebarSections = buildNiisSidebarTree({
    approvalCount: projectApprovalEntries.length,
    approvalEntries: projectApprovalEntries,
    currentRoute: "project",
    currentTaskId: null,
    tasks: dashboardTasks,
  });
  const toc = [
    { href: "#overview", label: "Overview" },
    { href: "#goals", label: "Goals" },
    { href: "#attachment", label: "Attached project" },
    { href: "#technology", label: "Technology profile" },
    { href: "#workflow", label: "Workflow" },
    { href: "#codemap", label: "Codemap" },
    { href: "#runtime", label: "Runtime availability" },
    { href: "#settings", label: "Settings" },
  ];
  const summaryCard = `
    <div class="niis-toc-card niis-toc-card-secondary">
      <h4>Project summary</h4>
      <div class="niis-task-detail-property-list">
        <div class="niis-task-detail-property-row"><span>Project</span><strong>${escapeHtml(profile?.project_id ?? "unattached")}</strong></div>
        <div class="niis-task-detail-property-row"><span>Type</span><strong>${escapeHtml(profile?.primary_type ?? "unknown")}</strong></div>
        <div class="niis-task-detail-property-row"><span>Install</span><strong>${escapeHtml(projectContext.install?.status ?? "missing")}</strong></div>
        <div class="niis-task-detail-property-row"><span>Artifacts</span><strong>${escapeHtml(artifactCount)}</strong></div>
        <div class="niis-task-detail-property-row"><span>Doctor</span><strong>${escapeHtml(doctorCounts.ok)} ok / ${escapeHtml(doctorCounts.warning)} warn</strong></div>
      </div>
    </div>`;

  return renderNiisLayout({
    header: renderNiisTopbar({ currentRoute: "project", returnTo, workerMode }),
    leftSidebar: renderNiisSidebar({ sections: sidebarSections, renderStatusIcon: renderTaskStatusIcon }),
    main: `
      <article class="niis-article">
        <header class="niis-page-header">
          <h1>Project Overview</h1>
          <p>Attached-project context for the local control plane.</p>
        </header>
        <section class="niis-section" id="overview">
          <h2>Overview</h2>
          <p>Single-project context linking into intake, inbox, approvals, and workbench flows.</p>
          <div class="niis-callout-grid">
            <article class="niis-callout-card">
              <h3>Project</h3>
              <p><strong>${escapeHtml(profile?.project_id ?? "unattached")}</strong></p>
              <p>Primary type: ${escapeHtml(profile?.primary_type ?? "unknown")}</p>
            </article>
            <article class="niis-callout-card">
              <h3>Validation Surface</h3>
              <p>${escapeHtml(validationSurface)}</p>
            </article>
            <article class="niis-callout-card">
              <h3>Install State</h3>
              <p>${escapeHtml(projectContext.install?.status ?? "missing")}</p>
            </article>
            <article class="niis-callout-card">
              <h3>Quick Links</h3>
              <ul class="niis-item-list">
                <li><a href="/pipeline#new-task">Start intake</a></li>
                <li><a href="/tasks">Task inbox</a></li>
                <li>${renderProjectWorkbenchLink(dashboard)}</li>
              </ul>
            </article>
          </div>
        </section>
        <section class="niis-section" id="goals">
          <h2>Goals</h2>
          <p>Higher-level objectives this project is pursuing. Each goal aggregates linked tasks, total runs, and total cost from <code>tasks.goal_id</code>.</p>
          ${renderGoalsSection(snapshot)}
        </section>
        <section class="niis-section" id="attachment">
          <h2>Attached project</h2>
          <p>Project attachment and generated artifact context.</p>
          <ul class="niis-item-list">
            <li>Attachment recorded at: ${escapeHtml(attachment?.attached_at ?? "missing")}</li>
            <li>Repo root: ${escapeHtml(profile?.repo_root ?? "missing")}</li>
            <li>Context boundary: ${escapeHtml(profile?.context_boundary?.scope ?? "missing")} @ ${escapeHtml(profile?.context_boundary?.project_root ?? "missing")}</li>
            <li>Generated artifacts: ${escapeHtml(artifactCount)}</li>
            <li>Project profile: ${escapeHtml(projectContext.projectProfilePath ?? "missing")}</li>
            <li>Workflow: ${escapeHtml(projectContext.workflowPath ?? "missing")}</li>
            <li>Codemap: ${escapeHtml(projectContext.codemapPath ?? "missing")}</li>
          </ul>
        </section>
        <section class="niis-section" id="technology">
          <h2>Technology profile</h2>
          <p>Detected languages, frameworks, and build systems.</p>
          <ul class="niis-item-list">
            <li>Languages: ${escapeHtml(formatMaybeList(profile?.languages))}</li>
            <li>Frameworks: ${escapeHtml(formatMaybeList(profile?.frameworks))}</li>
            <li>Build systems: ${escapeHtml(formatMaybeList(profile?.build_systems))}</li>
            <li>Test frameworks: ${escapeHtml(formatMaybeList(profile?.test_frameworks))}</li>
            <li>Declared task sources: ${escapeHtml(formatMaybeList(profile?.task_sources?.declared_sources))}</li>
            <li>Documentation staleness candidates: ${escapeHtml(profile?.task_sources?.documentation_staleness_candidates?.length ?? 0)}</li>
          </ul>
        </section>
        <section class="niis-section" id="workflow">
          <h2>Workflow</h2>
          <p>Workspace strategy and task source configuration.</p>
          <ul class="niis-item-list">
            <li>Summary: ${escapeHtml(workflow?.summary ?? "missing")}</li>
            <li>Workspace mode: ${escapeHtml(workflow?.workspace_strategy?.mode ?? "missing")}</li>
            <li>Branch template: ${escapeHtml(workflow?.workspace_strategy?.branch_template ?? "missing")}</li>
            <li>Provision command: ${escapeHtml(workflow?.workspace_strategy?.provision_command ?? "missing")}</li>
            <li>Workspace source priority: ${escapeHtml(formatMaybeList(workflow?.workspace_strategy?.workspace_source_priority))}</li>
            <li>Task source types: ${escapeHtml(formatMaybeList(workflow?.task_source_types))}</li>
          </ul>
        </section>
        <section class="niis-section" id="codemap">
          <h2>Codemap</h2>
          <p>Indexed files and language coverage.</p>
          <ul class="niis-item-list">
            <li>Files indexed: ${escapeHtml(codemap?.stats?.files_indexed ?? profile?.validation_surface?.indexed_files ?? 0)}</li>
            <li>Source files: ${escapeHtml(codemap?.stats?.source_count ?? 0)}</li>
            <li>Documentation files: ${escapeHtml(codemap?.stats?.docs_count ?? 0)}</li>
            <li>Codemap root: ${escapeHtml(codemap?.root ?? "missing")}</li>
            <li>Language coverage: ${escapeHtml(formatMaybeList(codemapLanguages))}</li>
          </ul>
        </section>
        <section class="niis-section" id="runtime">
          <h2>Runtime availability</h2>
          <p>Adapter availability and doctor signals.</p>
          <div class="niis-callout-grid">
            <article class="niis-callout-card">
              <h3>Adapters</h3>
              ${renderProjectSignalList(runtimeAvailability, "No adapter availability checks recorded.")}
            </article>
            <article class="niis-callout-card">
              <h3>Doctor signals</h3>
              <p>Checks: ${escapeHtml(doctorCounts.ok)} ok / ${escapeHtml(doctorCounts.warning)} warning / ${escapeHtml(doctorCounts.error)} error</p>
              ${renderProjectSignalList(doctorHighlights, "No doctor highlights recorded.")}
            </article>
          </div>
        </section>
        <section class="niis-section" id="settings">
          <h2>Settings</h2>
          <p>Operator overrides for routing policy and per-role configuration. Changes persist to <code>.niis/project-config.json</code>.</p>
          <h3>Promotion policy</h3>
          ${renderMergePolicyForm(projectContext)}
          <h3 style="margin-top: 1.5rem;">Review chain &amp; auto-repair</h3>
          ${renderReviewAndAutoRepairForm(projectContext)}
          <h3 style="margin-top: 1.5rem;">Autonomous worker</h3>
          ${renderAutonomousWorkerForm(projectContext)}
          <h3 style="margin-top: 1.5rem;">Global routing policy</h3>
          ${renderRoutingPolicyForm(projectContext)}
          <h3 style="margin-top: 1.5rem;">Roles</h3>
          ${renderRoleSettingsTable(projectContext)}
        </section>
      </article>`,
    rightSidebar: renderNiisToc(toc, { extra: summaryCard }),
  });
}












const AGENTS_MIN_SAMPLE = 5;
const AGENT_STATUS_ACTIVE_WINDOW_MS = 60 * 1000;
const AGENT_STATUS_IDLE_WINDOW_MS = 24 * 60 * 60 * 1000;

function deriveAgentRuntimeStatus(agent, now) {
  if (agent.status === "PAUSED") return "paused";
  if (agent.status === "TERMINATED") return "offline";
  if (agent.status === "ERROR") return "error";
  if (!agent.last_run_at) return "idle";
  const sinceMs = now - Date.parse(agent.last_run_at);
  if (sinceMs <= AGENT_STATUS_ACTIVE_WINDOW_MS) return "active";
  if (sinceMs <= AGENT_STATUS_IDLE_WINDOW_MS) return "idle";
  return "offline";
}

function buildAgentMetrics({ agent, runs }) {
  const agentRuns = runs.filter((r) => r.agent_id === agent.id);
  const completed = agentRuns.filter((r) => r.status === "COMPLETED");
  const failed = agentRuns.filter((r) => r.status === "FAILED" || r.status === "TIMED_OUT");
  const finalizedCount = completed.length + failed.length;
  const successRate = finalizedCount >= AGENTS_MIN_SAMPLE
    ? Math.round((completed.length / finalizedCount) * 100)
    : null;
  const durations = completed
    .map((r) => r.finished_at && r.started_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null)
    .filter((d) => d !== null && d >= 0);
  const avgDurationMs = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;
  return {
    avg_duration_ms: avgDurationMs,
    failed_runs: failed.length,
    finalized_runs: finalizedCount,
    successful_runs: completed.length,
    success_rate: successRate,
    total_cost_usd: agent.accumulated?.total_cost_usd ?? 0,
    total_runs: agent.accumulated?.total_runs ?? agentRuns.length,
  };
}

function rateBandColor(pct) {
  if (pct == null) return "var(--niis-border-strong)";
  if (pct >= 90) return "#16a34a";
  if (pct >= 75) return "#eab308";
  return "#dc2626";
}

function formatDurationMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}

function formatCost(usd) {
  if (typeof usd !== "number" || usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function agentInitial(agent) {
  const name = String(agent.name ?? agent.id ?? "?");
  return name.charAt(0).toUpperCase();
}

function renderAgentAvatar(agent, runtimeStatus) {
  const dotClass = `niis-agents-dot niis-agents-dot-${runtimeStatus}`;
  return `
    <span class="niis-agents-avatar">
      <span class="niis-agents-avatar-initial">${escapeHtml(agentInitial(agent))}</span>
      <span class="${dotClass}" title="${escapeHtml(runtimeStatus)}"></span>
    </span>`;
}

function renderAgentsRosterCard(agent, runtimeStatus) {
  return `
    <div class="niis-agents-roster-item">
      ${renderAgentAvatar(agent, runtimeStatus)}
      <div class="niis-agents-roster-name">${escapeHtml(agent.name)}</div>
      <div class="niis-agents-roster-role">${escapeHtml(agent.adapter_type)}</div>
    </div>`;
}

function renderAgentsPerformanceRow(agent, runtimeStatus, metrics) {
  const rateColor = rateBandColor(metrics.success_rate);
  const rateWidth = metrics.success_rate ?? 0;
  const rateLabel = metrics.success_rate != null
    ? `${metrics.success_rate}%`
    : "—";
  const sampleHint = metrics.success_rate == null
    ? `<span class="niis-agents-perf-sample" title="Need ≥${AGENTS_MIN_SAMPLE} finalized runs to compute rate">${escapeHtml(metrics.finalized_runs)} run${metrics.finalized_runs === 1 ? "" : "s"}</span>`
    : `<span class="niis-agents-perf-sample">${escapeHtml(metrics.finalized_runs)} run${metrics.finalized_runs === 1 ? "" : "s"}</span>`;
  return `
    <div class="niis-agents-perf-row">
      <div class="niis-agents-perf-name">
        ${renderAgentAvatar(agent, runtimeStatus)}
        <div>
          <div class="niis-agents-perf-title">${escapeHtml(agent.name)}</div>
          <div class="niis-agents-perf-sub">${escapeHtml(agent.adapter_type)}</div>
        </div>
      </div>
      <div class="niis-agents-perf-bar">
        <div class="niis-agents-perf-bar-track">
          <div class="niis-agents-perf-bar-fill" style="width: ${rateWidth}%; background: ${rateColor};"></div>
        </div>
        <div class="niis-agents-perf-bar-meta">
          <span class="niis-agents-perf-rate" style="color: ${rateColor};">${escapeHtml(rateLabel)}</span>
          ${sampleHint}
        </div>
      </div>
      <div class="niis-agents-perf-cell">${escapeHtml(formatDurationMs(metrics.avg_duration_ms))}</div>
      <div class="niis-agents-perf-cell">${escapeHtml(formatCost(metrics.total_cost_usd))}</div>
    </div>`;
}

function renderAgentsRoute({ dashboard, returnTo = "", snapshot, workerMode = "semi" }) {
  const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  const allTasks = dashboard.task_board.flatMap((group) => group.entries);
  const sidebarSections = buildNiisSidebarTree({
    approvalCount: buildApprovalEntries(dashboard).length,
    approvalEntries: buildApprovalEntries(dashboard),
    currentRoute: "agents",
    currentTaskId: null,
    tasks: allTasks,
  });
  const now = Date.now();
  const enrichedAgents = agents.map((agent) => ({
    agent,
    metrics: buildAgentMetrics({ agent, runs }),
    runtimeStatus: deriveAgentRuntimeStatus(agent, now),
  }));
  const activeCount = enrichedAgents.filter((e) => e.runtimeStatus === "active").length;

  const toc = [
    { href: "#roster", label: "Roster" },
    { href: "#performance", label: "Performance" },
  ];

  const summaryCard = `
    <div class="niis-toc-card niis-toc-card-secondary">
      <h4>Agents summary</h4>
      <div class="niis-task-detail-property-list">
        <div class="niis-task-detail-property-row"><span>Total agents</span><strong>${escapeHtml(enrichedAgents.length)}</strong></div>
        <div class="niis-task-detail-property-row"><span>Active now</span><strong>${escapeHtml(activeCount)}</strong></div>
        <div class="niis-task-detail-property-row"><span>Total runs</span><strong>${escapeHtml(runs.length)}</strong></div>
      </div>
    </div>`;

  const emptyState = `
    <p class="niis-muted">No agents registered yet. Run <code>niis import</code> with an agent manifest to register one.</p>`;

  const rosterBlock = enrichedAgents.length === 0
    ? emptyState
    : `
      <div class="niis-agents-roster">
        ${enrichedAgents.map(({ agent, runtimeStatus }) => renderAgentsRosterCard(agent, runtimeStatus)).join("")}
      </div>`;

  const performanceBlock = enrichedAgents.length === 0
    ? emptyState
    : `
      <div class="niis-agents-perf-table">
        <div class="niis-agents-perf-header">
          <div>Agent</div>
          <div>Success rate</div>
          <div>Avg duration</div>
          <div>Total cost</div>
        </div>
        ${enrichedAgents.map(({ agent, metrics, runtimeStatus }) => renderAgentsPerformanceRow(agent, runtimeStatus, metrics)).join("")}
      </div>
      <p class="niis-muted niis-agents-perf-foot">Success rate hidden until ≥${AGENTS_MIN_SAMPLE} finalized runs (avoids misleading single-run percentages). Rate colors: ≥90% green, 75–89% amber, &lt;75% red.</p>`;

  return renderNiisLayout({
    header: renderNiisTopbar({ currentRoute: "agents", returnTo, workerMode }),
    leftSidebar: renderNiisSidebar({ sections: sidebarSections, renderStatusIcon: renderTaskStatusIcon }),
    main: `
      <article class="niis-article">
        <header class="niis-page-header">
          <h1>Agents</h1>
          <p>Runtime agents registered to this workspace, with live runtime status and per-agent metrics from the runs table.</p>
        </header>
        <section class="niis-section" id="roster">
          <h2>Your team <span class="niis-muted">(${escapeHtml(activeCount)} of ${escapeHtml(enrichedAgents.length)} active)</span></h2>
          ${rosterBlock}
        </section>
        <section class="niis-section" id="performance">
          <h2>Performance</h2>
          ${performanceBlock}
        </section>
      </article>`,
    rightSidebar: renderNiisToc(toc, { extra: summaryCard }),
  });
}












const INSIGHTS_FEED_LIMIT = 100;
const INSIGHTS_BAD_VERDICT_CLASSES = new Set(["DEFECT", "EVIDENCE_GAP", "ENV_BLOCK", "NEEDS_ESCALATION"]);

function classifyActivityTone(entry) {

  if (entry.source_kind === "approval") {
    const status = entry.payload?.status ?? "";
    if (status === "APPROVED") return "good";
    if (status === "REJECTED") return "bad";
    return "neutral";
  }

  if (entry.source_kind === "blocker") return "bad";

  if (entry.source_kind === "event") {
    const payload = entry.payload ?? {};
    const phaseStatus = String(payload.phase_status ?? "").toLowerCase();
    if (phaseStatus === "completed" || phaseStatus === "succeeded" || phaseStatus === "approved") return "good";
    if (phaseStatus === "failed" || phaseStatus === "blocked" || phaseStatus === "rejected") return "bad";
    if (payload.to_status === "DONE") return "good";
    if (payload.to_status === "BLOCKED" || payload.to_status === "REJECTED") return "bad";
    if (entry.title === "ERROR") return "bad";
    return "neutral";
  }
  return "neutral";
}

function classifyVerdictTone(verdict) {
  if (verdict.verdict_class === "PASS") return "good";
  if (INSIGHTS_BAD_VERDICT_CLASSES.has(verdict.verdict_class)) return "bad";
  return "neutral";
}

function buildInsightsFeed({ snapshot }) {
  let activity = [];
  try {
    activity = buildActivityStream({ snapshot, taskId: null });
  } catch {
    activity = [];
  }
  const taskTitleById = new Map(
    (snapshot?.tasks ?? []).map((t) => [t.id, t.title]),
  );
  const enrichedActivity = activity.map((entry) => ({
    id: entry.id,
    payload: entry.payload,
    source_kind: entry.source_kind,
    summary: entry.summary,
    task_id: entry.task_id,
    task_title: taskTitleById.get(entry.task_id) ?? null,
    timestamp: entry.timestamp,
    title: entry.title,
    tone: classifyActivityTone(entry),
    verdict: null,
  }));


  const verdicts = Array.isArray(snapshot?.verdicts) ? snapshot.verdicts : [];
  const verdictEntries = verdicts.map((v) => ({
    id: `verdict:${v.id}`,
    payload: v,
    source_kind: "verdict",
    summary: v.reason ?? `Verdict ${v.verdict_class} by ${v.reviewer_id}`,
    task_id: v.task_id,
    task_title: taskTitleById.get(v.task_id) ?? null,
    timestamp: v.created_at ?? v.timestamp ?? null,
    title: `Verdict ${v.verdict_class}`,
    tone: classifyVerdictTone(v),
    verdict: { class: v.verdict_class, reviewer: v.reviewer_id ?? null },
  })).filter((e) => e.timestamp);
  const merged = [...enrichedActivity, ...verdictEntries];
  return merged
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, INSIGHTS_FEED_LIMIT);
}

function bucketActivityByDay(entries, now) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
  const startOfThisWeek = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);
  const buckets = { today: [], yesterday: [], this_week: [], earlier: [] };
  for (const entry of entries) {
    const ts = Date.parse(entry.timestamp);
    if (ts >= startOfToday.getTime()) buckets.today.push(entry);
    else if (ts >= startOfYesterday.getTime()) buckets.yesterday.push(entry);
    else if (ts >= startOfThisWeek.getTime()) buckets.this_week.push(entry);
    else buckets.earlier.push(entry);
  }
  return buckets;
}

function renderInsightsEntry(entry) {
  const verdictPill = entry.verdict
    ? `<span class="niis-insights-verdict niis-insights-verdict-${entry.tone}">${escapeHtml(entry.verdict.class)}</span>`
    : "";
  const taskLink = entry.task_id
    ? `<a class="niis-insights-task-link" href="/tasks/${encodeURIComponent(entry.task_id)}">${escapeHtml(entry.task_title ?? entry.task_id)}</a>`
    : "";
  return `
    <li class="niis-insights-entry niis-insights-tone-${entry.tone}">
      <span class="niis-insights-dot"></span>
      <div class="niis-insights-body">
        <div class="niis-insights-head">
          <span class="niis-insights-title">${escapeHtml(entry.title)}</span>
          ${verdictPill}
          <span class="niis-insights-time">${escapeHtml(formatTimestamp(entry.timestamp))}</span>
        </div>
        <div class="niis-insights-summary">${escapeHtml(entry.summary)}</div>
        ${taskLink ? `<div class="niis-insights-task">${taskLink}</div>` : ""}
      </div>
    </li>`;
}

function renderInsightsBucket(label, entries) {
  if (entries.length === 0) return "";
  return `
    <section class="niis-section">
      <h2>${escapeHtml(label)} <span class="niis-muted">(${escapeHtml(entries.length)})</span></h2>
      <ul class="niis-insights-list">
        ${entries.map(renderInsightsEntry).join("")}
      </ul>
    </section>`;
}

function renderInsightsRoute({ dashboard, returnTo = "", snapshot, workerMode = "semi" }) {
  const allTasks = dashboard.task_board.flatMap((group) => group.entries);
  const sidebarSections = buildNiisSidebarTree({
    approvalCount: buildApprovalEntries(dashboard).length,
    approvalEntries: buildApprovalEntries(dashboard),
    currentRoute: "insights",
    currentTaskId: null,
    tasks: allTasks,
  });
  const feed = buildInsightsFeed({ snapshot });
  const buckets = bucketActivityByDay(feed, new Date());
  const counts = {
    bad: feed.filter((e) => e.tone === "bad").length,
    good: feed.filter((e) => e.tone === "good").length,
    neutral: feed.filter((e) => e.tone === "neutral").length,
  };

  const toc = [
    buckets.today.length > 0 ? { href: "#today", label: "Today" } : null,
    buckets.yesterday.length > 0 ? { href: "#yesterday", label: "Yesterday" } : null,
    buckets.this_week.length > 0 ? { href: "#this-week", label: "This week" } : null,
    buckets.earlier.length > 0 ? { href: "#earlier", label: "Earlier" } : null,
  ].filter(Boolean);

  const summaryCard = `
    <div class="niis-toc-card niis-toc-card-secondary">
      <h4>Activity summary</h4>
      <div class="niis-task-detail-property-list">
        <div class="niis-task-detail-property-row"><span>Recent events</span><strong>${escapeHtml(feed.length)}</strong></div>
        <div class="niis-task-detail-property-row"><span>Wins</span><strong style="color: #16a34a;">${escapeHtml(counts.good)}</strong></div>
        <div class="niis-task-detail-property-row"><span>Failures</span><strong style="color: #dc2626;">${escapeHtml(counts.bad)}</strong></div>
        <div class="niis-task-detail-property-row"><span>Other</span><strong>${escapeHtml(counts.neutral)}</strong></div>
      </div>
    </div>`;

  const empty = `<p class="niis-muted">No activity recorded yet. Activity is recorded when tasks transition state, when approvals are granted/rejected, when blockers fire, and when validators return verdicts.</p>`;

  const body = feed.length === 0
    ? empty
    : `
      <section class="niis-section" id="today">${renderInsightsBucket("Today", buckets.today)}</section>
      <section class="niis-section" id="yesterday">${renderInsightsBucket("Yesterday", buckets.yesterday)}</section>
      <section class="niis-section" id="this-week">${renderInsightsBucket("This week", buckets.this_week)}</section>
      <section class="niis-section" id="earlier">${renderInsightsBucket("Earlier", buckets.earlier)}</section>`;

  return renderNiisLayout({
    header: renderNiisTopbar({ currentRoute: "insights", returnTo, workerMode }),
    leftSidebar: renderNiisSidebar({ sections: sidebarSections, renderStatusIcon: renderTaskStatusIcon }),
    main: `
      <article class="niis-article">
        <header class="niis-page-header">
          <h1>Insights</h1>
          <p>Cross-task activity feed: lifecycle transitions, approvals, blockers, validator verdicts. Newest first, capped at ${INSIGHTS_FEED_LIMIT} entries.</p>
        </header>
        ${body}
      </article>`,
    rightSidebar: renderNiisToc(toc, { extra: summaryCard }),
  });
}

function renderControlPlaneBody({
  dashboard,
  mutableState,
  operatorDecisions,
  projectContext,
  queueSummary,
  returnTo = "",
  route,
  snapshot,
  subtaskProgressByTaskId = null,
  taskCard,
  taskNewPreview,
  taskWorkbenchArtifacts,
  workerMode = "semi",
  error,
  notice,
}) {
  switch (route.kind) {
    case "tasks":
      return renderTasksRoute({ dashboard, queueSummary, returnTo, route, subtaskProgressByTaskId, workerMode });
    case "task-new":
      return renderTaskNewRoute({
        dashboard,
        error,
        mutableState,
        notice,
        preview: taskNewPreview,
        renderBanner,
        returnTo,
        workerMode,
      });
    case "task-detail":
      return renderTaskDetailRoute({
        detail: dashboard.task_detail?.task?.id === route.taskId ? dashboard.task_detail : null,
        error,
        mutableState,
        notice,
        renderBanner,
        returnTo,
        route,
        taskCard,
        taskList: dashboard.task_board.flatMap((group) => group.entries),
        taskWorkbenchArtifacts,
        workerMode,
      });
    case "approvals":
      return renderApprovalsRoute({ dashboard, mutableState, operatorDecisions, returnTo, snapshot, workerMode });
    case "run-detail":
      return renderRunDetailRoute({ returnTo, route, snapshot, taskWorkbenchArtifacts, workerMode });
    case "project":
      return renderProjectRoute({ dashboard, projectContext, returnTo, snapshot, workerMode });
    case "agents":
      return renderAgentsRoute({ dashboard, returnTo, snapshot, workerMode });
    case "insights":
      return renderInsightsRoute({ dashboard, returnTo, snapshot, workerMode });
    default:
      return renderTasksRoute({ dashboard, queueSummary, returnTo, route, subtaskProgressByTaskId, workerMode });
  }
}

function renderControlPlaneHtml({
  assetUrls = {},
  error = null,
  mutableState = false,
  notice = null,
  operatorDecisions = null,
  projectContext = {},
  queueSummary = null,
  returnTo = "",
  route = {},
  scriptNonce = null,
  snapshot = {},
  subtaskProgressByTaskId = null,
  taskCard = null,
  taskNewPreview = null,
  taskWorkbenchArtifacts = null,
  title = "Niis Local Control Plane",
  workerMode = "semi",
} = {}) {
  const normalizedRoute = normalizeRoute(route);
  const normalizedProjectContext = normalizeProjectContext(projectContext);
  const normalizedSnapshot = normalizeSnapshot(snapshot);
  const normalizedTaskCard = normalizeTaskCard(taskCard);
  const normalizedTaskNewPreview = normalizeTaskNewPreview(taskNewPreview);
  const normalizedTaskWorkbenchArtifacts = normalizeTaskWorkbenchArtifacts(taskWorkbenchArtifacts);
  const dashboard = buildDashboardView({
    focusTaskId: normalizedRoute.taskId,
    snapshot: normalizedSnapshot,
  });
  const normalizedAssetUrls = normalizeControlPlaneAssets(assetUrls);
  const refreshSeconds = normalizedRoute.kind === "task-detail" && !normalizedTaskCard && isActiveExecutionProgress(normalizedTaskWorkbenchArtifacts)
    ? 2
    : null;
  const bodyClass = normalizedRoute.kind === "task-detail"
    ? "route-task-detail"
    : normalizedRoute.kind === "task-new"
      ? "route-task-intake"
      : normalizedRoute.kind === "approvals"
        ? "route-approvals"
        : normalizedRoute.kind === "project"
          ? "route-project"
          : normalizedRoute.kind === "tasks"
            ? "route-tasks"
            : normalizedRoute.kind === "agents"
              ? "route-agents"
              : normalizedRoute.kind === "insights"
                ? "route-insights"
                : "";
  const bodyHtml = normalizedRoute.kind === "task-detail" || normalizedRoute.kind === "task-new" || normalizedRoute.kind === "approvals" || normalizedRoute.kind === "project" || normalizedRoute.kind === "tasks" || normalizedRoute.kind === "agents" || normalizedRoute.kind === "insights"
    ? renderControlPlaneBody({
      dashboard,
      mutableState,
      error,
      notice,
      operatorDecisions,
      projectContext: normalizedProjectContext,
      queueSummary,
      returnTo,
      route: normalizedRoute,
      snapshot: normalizedSnapshot,
      subtaskProgressByTaskId,
      taskCard: normalizedTaskCard,
      taskNewPreview: normalizedTaskNewPreview,
      taskWorkbenchArtifacts: normalizedTaskWorkbenchArtifacts,
      title,
      workerMode,
    })
    : `<main>
      <h1>${escapeHtml(title)}</h1>
      <p class="niis-muted">Route shell for the local single-project control plane served by <code>niis ui --serve</code>.</p>
      ${renderNavigation(normalizedRoute)}
      ${renderBanner({ notice, error })}
      ${renderControlPlaneBody({
        dashboard,
        mutableState,
        error,
        notice,
        projectContext: normalizedProjectContext,
        returnTo,
        route: normalizedRoute,
        snapshot: normalizedSnapshot,
        subtaskProgressByTaskId,
        taskCard: normalizedTaskCard,
        taskNewPreview: normalizedTaskNewPreview,
        taskWorkbenchArtifacts: normalizedTaskWorkbenchArtifacts,
        title,
        workerMode,
      })}
    </main>`;




  const nonceAttribute = scriptNonce ? ` nonce="${escapeHtml(scriptNonce)}"` : "";
  const scripts = `<script${nonceAttribute} type="module" src="${escapeHtml(normalizedAssetUrls.js)}"></script>`;

  return renderControlPlaneDocumentFrame({
    bodyClass,
    bodyHtml,
    headHtml: renderControlPlaneDocumentHead({
      assetUrls: normalizedAssetUrls,
      refreshSeconds,
      scriptNonce,
      title,
    }),
    scripts,
  });
}

function buildLocalControlPlaneDocument(options = {}) {
  return renderControlPlaneHtml(options);
}

export {
  buildApprovalEntries,
  buildTaskLiveCardFragment,
  buildLocalControlPlaneDocument,
  renderControlPlaneHtml,
};
