import fs from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildDashboardView } from "../../core/src/observability/index.js";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestamp(value) {
  return value ?? "in progress";
}

function formatUsd(value) {
  return Number(value ?? 0).toFixed(2);
}

function formatRatio(value) {
  return `${Math.round(Number(value ?? 0) * 100)}%`;
}

function formatList(values, emptyLabel = "all") {
  return values.length === 0 ? emptyLabel : values.join(", ");
}

function formatTaskAnchorId(taskId) {
  return `task-detail-${encodeURIComponent(taskId).replaceAll("%", "_")}`;
}

function renderPhaseRows(phaseProgress) {
  if (phaseProgress.length === 0) {
    return "<tr><td colspan=\"6\">No task data available.</td></tr>";
  }

  return phaseProgress
    .map(
      (phase) => `
        <tr>
          <td>Phase ${escapeHtml(phase.phase)}</td>
          <td>${escapeHtml(phase.total)}</td>
          <td>${escapeHtml(phase.done_count)}</td>
          <td>${escapeHtml(phase.in_progress_count)}</td>
          <td>${escapeHtml(phase.blocked_count)}</td>
          <td>${escapeHtml(formatRatio(phase.completion_ratio))}</td>
        </tr>`,
    )
    .join("");
}

function renderBlockerItems(blockers, emptyLabel) {
  if (blockers.length === 0) {
    return `<li>${escapeHtml(emptyLabel)}</li>`;
  }

  return blockers
    .map(
      (blocker) => `
        <li>
          <strong>${escapeHtml(blocker.task_title)}</strong>
          <div>${escapeHtml(blocker.blocker_class)}: ${escapeHtml(blocker.reason)}</div>
          <div>Next: ${escapeHtml(blocker.next_action)}</div>
        </li>`,
    )
    .join("");
}

function renderRunItems(runs) {
  if (runs.length === 0) {
    return "<li>No runs recorded.</li>";
  }

  return runs
    .map(
      (run) => `
        <li>
          <strong>${escapeHtml(run.task_title)}</strong>
          <div>${escapeHtml(run.status)} via ${escapeHtml(run.adapter_id)} / ${escapeHtml(run.agent_id)}</div>
          <div>Started: ${escapeHtml(formatTimestamp(run.started_at))}</div>
          <div>Finished: ${escapeHtml(formatTimestamp(run.finished_at))}</div>
          <div>Estimated cost: $${escapeHtml(formatUsd(run.estimated_usd))}</div>
        </li>`,
    )
    .join("");
}

function renderTaskMeta(detail) {
  if (!detail) {
    return "<p>No focus task selected.</p>";
  }

  return `
    <div class="summary detail-grid">
      <div class="card"><span class="label">Task</span><span class="value detail-value">${escapeHtml(detail.task.title)}</span></div>
      <div class="card"><span class="label">Status</span><span class="value detail-value">${escapeHtml(detail.task.status)}</span></div>
      <div class="card"><span class="label">Phase</span><span class="value detail-value">${escapeHtml(detail.task.phase)}</span></div>
      <div class="card"><span class="label">Priority</span><span class="value detail-value">${escapeHtml(detail.task.priority)}</span></div>
      <div class="card"><span class="label">Selection</span><span class="value detail-value">${escapeHtml(detail.selection_reason)}</span></div>
    </div>
    <p>Task ID: ${escapeHtml(detail.task.id)}</p>`;
}

function renderAssignmentItems(assignments) {
  if (assignments.length === 0) {
    return "<li>No assignments recorded.</li>";
  }

  return assignments
    .map(
      (assignment) => `
        <li>
          <strong>${escapeHtml(assignment.agent_id)}</strong>
          <div>${escapeHtml(assignment.reason_type)} via ${escapeHtml(assignment.policy_ref)}</div>
          <div>${escapeHtml(assignment.context)}</div>
        </li>`,
    )
    .join("");
}

function renderDecisionItems(decisions) {
  if (decisions.length === 0) {
    return "<li>No explainability decisions recorded.</li>";
  }

  return decisions
    .map(
      (decision) => `
        <li>
          <strong>${escapeHtml(decision.decision_type)}</strong>
          <div>${escapeHtml(decision.human_readable_summary)}</div>
          <div>Route: ${escapeHtml(decision.route_chosen)}</div>
        </li>`,
    )
    .join("");
}

function renderTaskNoteItems(taskNotes) {
  if (taskNotes.length === 0) {
    return "<li>No task notes recorded.</li>";
  }

  return taskNotes
    .map(
      (taskNote) => `
        <li>
          <strong>${escapeHtml(taskNote.author_id)}</strong>
          <div>${escapeHtml(taskNote.content)}</div>
          <div>${escapeHtml(taskNote.author_type)} at ${escapeHtml(formatTimestamp(taskNote.created_at))}</div>
        </li>`,
    )
    .join("");
}

function renderActivityItems(activity) {
  if (activity.length === 0) {
    return "<li>No recent activity recorded.</li>";
  }

  return activity
    .map(
      (entry) => `
        <li>
          <strong>${escapeHtml(entry.title)}</strong>
          <div>${escapeHtml(entry.summary)}</div>
          <div>${escapeHtml(entry.source_kind)} at ${escapeHtml(formatTimestamp(entry.timestamp))}</div>
        </li>`,
    )
    .join("");
}

function renderTaskNavigationItems(taskNavigation) {
  if (taskNavigation.length === 0) {
    return "<li>No tasks available.</li>";
  }

  return taskNavigation
    .map(
      (task) => `
        <li>
          <a href="#${escapeHtml(formatTaskAnchorId(task.task_id))}">${escapeHtml(task.task_title)}</a>
          <div>${escapeHtml(task.status)} / phase ${escapeHtml(task.phase)} / priority ${escapeHtml(task.priority)}</div>
          <div>Blockers: ${escapeHtml(task.active_blocker_count)}${task.latest_run_status ? ` / Latest run: ${escapeHtml(task.latest_run_status)}` : ""}</div>
          <div>${task.view_kind === "selected" ? "Suggested default detail" : "Available detail section"}</div>
        </li>`,
    )
    .join("");
}

function renderTaskDetailCatalog(taskDetails) {
  if (taskDetails.length === 0) {
    return "<p>No task details available.</p>";
  }

  return taskDetails
    .map(
      (detail) => `
        <details
          class="task-detail-shell"
          data-task-detail="true"
          id="${escapeHtml(formatTaskAnchorId(detail.task.id))}"
          ${detail.selection_reason !== null ? "open" : ""}
        >
          <summary>${escapeHtml(detail.task.title)} · ${escapeHtml(detail.task.status)} · phase ${escapeHtml(detail.task.phase)}</summary>
          ${renderTaskMeta(detail)}
          <h4>Task Notes</h4>
          <ul>${renderTaskNoteItems(detail.task_notes ?? [])}</ul>
          <h4>Assignments</h4>
          <ul>${renderAssignmentItems(detail.assignments)}</ul>
          <h4>Explainability Decisions</h4>
          <ul>${renderDecisionItems(detail.decisions)}</ul>
          <h4>Recent Activity</h4>
          <ul>${renderActivityItems(detail.activity)}</ul>
        </details>`,
    )
    .join("");
}

function renderPanel({
  title,
  body,
  open = true,
  className = "",
} = {}) {
  const normalizedClassName = className.trim() === "" ? "panel-shell" : `panel-shell ${className}`;

  return `
    <details class="${escapeHtml(normalizedClassName)}" ${open ? "open" : ""}>
      <summary>${escapeHtml(title)}</summary>
      <div class="panel-body">${body}</div>
    </details>`;
}

function renderScopeSummary(scope) {
  if (!scope) {
    return "<p>No scope metadata available.</p>";
  }

  return `
    <div class="summary">
      <div class="card"><span class="label">Statuses</span><span class="value detail-value">${escapeHtml(formatList(scope.filters.statuses))}</span></div>
      <div class="card"><span class="label">Phases</span><span class="value detail-value">${escapeHtml(formatList(scope.filters.phases.map(String)))}</span></div>
      <div class="card"><span class="label">Task IDs</span><span class="value detail-value">${escapeHtml(formatList(scope.filters.task_ids))}</span></div>
      <div class="card"><span class="label">Focus Task</span><span class="value detail-value">${escapeHtml(scope.focus_task_id ?? "auto")}</span></div>
      <div class="card"><span class="label">Filtered</span><span class="value detail-value">${escapeHtml(scope.has_filters ? "yes" : "no")}</span></div>
    </div>`;
}

function renderInteractiveScript() {
  return `<script>
(() => {
  const openHashTarget = () => {
    const hash = window.location.hash.slice(1);
    if (!hash) {
      return;
    }

    const target = document.getElementById(hash);
    if (!target) {
      return;
    }

    const details = target.closest("details");
    if (details) {
      details.open = true;
    }

    target.scrollIntoView({ block: "start" });
  };

  window.addEventListener("DOMContentLoaded", openHashTarget);
  window.addEventListener("hashchange", openHashTarget);
})();
</script>`;
}

function renderLocalDashboardHtml({
  dashboard,
  title = "Niis Local Dashboard",
} = {}) {
  const normalizedDashboard = dashboard ?? buildDashboardView({ snapshot: {} });
  const normalizedTitle = escapeHtml(title);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${normalizedTitle}</title>
    <style>
      body { font-family: sans-serif; margin: 2rem; color: #1f2937; background: #f8fafc; }
      h1, h2, h3, h4 { margin-bottom: 0.5rem; }
      .panel-shell, .task-detail-shell { background: white; border: 1px solid #dbe2ea; border-radius: 12px; margin-bottom: 1rem; }
      .panel-shell > summary, .task-detail-shell > summary { cursor: pointer; font-weight: 700; padding: 1rem 1.25rem; }
      .panel-body, .task-detail-shell { padding-bottom: 1rem; }
      .panel-body { padding-left: 1.25rem; padding-right: 1.25rem; }
      .task-detail-shell[open] { box-shadow: 0 0 0 2px #dbeafe inset; }
      .task-detail-shell > :not(summary) { padding-left: 1.25rem; padding-right: 1.25rem; }
      .summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0.75rem; }
      .card { background: #f8fafc; border-radius: 8px; padding: 0.75rem; }
      .label { display: block; font-size: 0.85rem; color: #64748b; }
      .value { font-size: 1.5rem; font-weight: 700; }
      .detail-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
      .detail-value { font-size: 1rem; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #e2e8f0; }
      ul { padding-left: 1.25rem; margin: 0; }
      li { margin-bottom: 0.75rem; }
    </style>
  </head>
  <body>
    <h1>${normalizedTitle}</h1>
    <p>Generated at ${escapeHtml(normalizedDashboard.generated_at)}</p>
    ${renderPanel({
      title: "Summary",
      body: `
      <div class="summary">
        <div class="card"><span class="label">Tasks</span><span class="value">${escapeHtml(normalizedDashboard.summary.total_tasks)}</span></div>
        <div class="card"><span class="label">Phases</span><span class="value">${escapeHtml(normalizedDashboard.summary.total_phases)}</span></div>
        <div class="card"><span class="label">Active blockers</span><span class="value">${escapeHtml(normalizedDashboard.summary.active_blocker_count)}</span></div>
        <div class="card"><span class="label">Approval blockers</span><span class="value">${escapeHtml(normalizedDashboard.summary.pending_approval_count)}</span></div>
        <div class="card"><span class="label">Recent runs</span><span class="value">${escapeHtml(normalizedDashboard.summary.recent_run_count)}</span></div>
      </div>`,
    })}
    ${renderPanel({
      title: "Scope",
      body: renderScopeSummary(normalizedDashboard.scope),
    })}
    ${renderPanel({
      title: "Phase Progress",
      body: `
      <table>
        <thead>
          <tr>
            <th>Phase</th>
            <th>Total</th>
            <th>Done</th>
            <th>Active</th>
            <th>Blocked</th>
            <th>Completion</th>
          </tr>
        </thead>
        <tbody>${renderPhaseRows(normalizedDashboard.phase_progress)}</tbody>
      </table>`,
    })}
    ${renderPanel({
      title: "Active Blockers",
      body: `<ul>${renderBlockerItems(normalizedDashboard.active_blockers, "No active blockers.")}</ul>`,
    })}
    ${renderPanel({
      title: "Approval Blockers",
      body: `<ul>${renderBlockerItems(normalizedDashboard.pending_approvals, "No approval blockers.")}</ul>`,
    })}
    ${renderPanel({
      title: "Recent Runs",
      body: `<ul>${renderRunItems(normalizedDashboard.recent_runs)}</ul>`,
      open: false,
    })}
    ${renderPanel({
      title: "Task Navigation",
      body: `<ul>${renderTaskNavigationItems(normalizedDashboard.task_navigation ?? [])}</ul>`,
    })}
    ${renderPanel({
      title: "Focus Task Detail",
      body: `
      ${renderTaskMeta(normalizedDashboard.task_detail)}
      <h3>Assignments</h3>
      <ul>${renderAssignmentItems(normalizedDashboard.task_detail?.assignments ?? [])}</ul>
      <h3>Explainability Decisions</h3>
      <ul>${renderDecisionItems(normalizedDashboard.task_detail?.decisions ?? [])}</ul>
      <h3>Recent Activity</h3>
      <ul>${renderActivityItems(normalizedDashboard.task_detail?.activity ?? [])}</ul>`,
    })}
    ${renderPanel({
      title: "Task Detail Catalog",
      body: renderTaskDetailCatalog(normalizedDashboard.task_details ?? []),
      className: "task-catalog-panel",
    })}
    ${renderInteractiveScript()}
  </body>
</html>`;
}

function buildLocalDashboardDocument({
  focusTaskId = null,
  filters = {},
  now = new Date(),
  recentBlockerLimit = 5,
  recentRunLimit = 5,
  snapshot,
  title = "Niis Local Dashboard",
} = {}) {
  const dashboard = buildDashboardView({
    focusTaskId,
    filters,
    now,
    recentBlockerLimit,
    recentRunLimit,
    snapshot,
  });

  return renderLocalDashboardHtml({
    dashboard,
    title,
  });
}

function parseCliArguments(argv = []) {
  if (argv.length === 0) {
    throw new Error(
      "Usage: node packages/ui/src/index.js <snapshot.json> [--status STATUS] [--phase PHASE] [--task-id TASK_ID] [--focus-task-id TASK_ID]",
    );
  }

  const snapshotPath = argv[0];
  const filters = {
    phases: [],
    statuses: [],
    taskIds: [],
  };
  let focusTaskId = null;

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    const nextValue = argv[index + 1];

    if (token === "--status") {
      if (!nextValue) {
        throw new Error("--status requires a value");
      }
      filters.statuses.push(nextValue);
      index += 1;
      continue;
    }

    if (token === "--phase") {
      if (!nextValue) {
        throw new Error("--phase requires a value");
      }
      const phase = Number(nextValue);
      if (!Number.isInteger(phase) || phase < 0) {
        throw new Error("--phase must be a non-negative integer");
      }
      filters.phases.push(phase);
      index += 1;
      continue;
    }

    if (token === "--task-id") {
      if (!nextValue) {
        throw new Error("--task-id requires a value");
      }
      filters.taskIds.push(nextValue);
      index += 1;
      continue;
    }

    if (token === "--focus-task-id") {
      if (!nextValue) {
        throw new Error("--focus-task-id requires a value");
      }
      focusTaskId = nextValue;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return {
    filters,
    focusTaskId,
    snapshotPath,
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseCliArguments(argv);
  const { filters, focusTaskId, snapshotPath } = parsed;
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  const html = buildLocalDashboardDocument({
    filters,
    focusTaskId,
    snapshot,
  });
  process.stdout.write(html);
}

const executedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (executedPath) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export {
  buildLocalDashboardDocument,
  parseCliArguments,
  renderLocalDashboardHtml,
};
