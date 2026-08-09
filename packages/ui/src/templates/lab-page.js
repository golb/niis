import { escapeHtml } from "../render-utils.js";
import { summarizeGoalProgress } from "../../../core/src/contracts/governance.js";









const BUILT_IN_LAB_AGENTS = [
  { id: "marcus", name: "Marcus", role: "Coordinator", role_id: "coordinator-generalist", accent: "#3b82f6", avatar: "", bg: "#d0d0d0", bg_dark: "#161616" },
  { id: "vera", name: "Vera", role: "Planner", role_id: "task-planner", accent: "#a855f7", avatar: "", bg: "#c5b3a4", bg_dark: "#161616" },
  { id: "kai", name: "Kai", role: "Generalist", role_id: "generalist-worker", accent: "#6b7280", avatar: "", bg: "#b8c8d4", bg_dark: "#16202a" },
  { id: "nova", name: "Nova", role: "Frontend", role_id: "frontend-specialist", accent: "#ec4899", avatar: "", bg: "#4e7b7e" },
  { id: "theo", name: "Theo", role: "Node Backend", role_id: "nodejs-worker", accent: "#10b981", avatar: "", bg: "#b5cdb0", bg_dark: "#142019" },
  { id: "mira", name: "Mira", role: "Python Backend", role_id: "python-worker", accent: "#f97316", avatar: "", bg: "#e8d5c4", bg_dark: "#1d1815" },
  { id: "iris", name: "Iris", role: "Validator", role_id: "validator", accent: "#6366f1", avatar: "", bg: "#99ada9", bg_dark: "#1a2426" },
];

let LAB_AGENTS = [...BUILT_IN_LAB_AGENTS];
let ROLE_TO_PERSONA = Object.fromEntries(LAB_AGENTS.map((a) => [a.role_id, a.id]));
let AGENT_ID_SET = new Set(LAB_AGENTS.map((a) => a.id));





function setExtraLabAgents(extras = []) {
  const sanitized = Array.isArray(extras)
    ? extras.filter((entry) => entry && typeof entry.id === "string" && entry.id.trim() !== "")
    : [];
  const seen = new Set(BUILT_IN_LAB_AGENTS.map((a) => a.id));
  const merged = [...BUILT_IN_LAB_AGENTS];
  for (const entry of sanitized) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  LAB_AGENTS = merged;
  ROLE_TO_PERSONA = Object.fromEntries(LAB_AGENTS.map((a) => [a.role_id, a.id]));
  AGENT_ID_SET = new Set(LAB_AGENTS.map((a) => a.id));
}

const LAB_COLUMNS = [
  { id: "pending", label: "Pending", accent: "#9ca3af", tint: "#f3f4f6" },
  { id: "in_progress", label: "In Progress", accent: "#8b5cf6", tint: "#f5f1ff" },
  { id: "done", label: "Done", accent: "#16a34a", tint: "#f0fdf4" },
  { id: "rejected", label: "Rejected", accent: "#dc2626", tint: "#fef2f2" },
];

const LAB_PHASES = {
  Unplanned:  { color: "#9ca3af" },
  Planning:   { color: "#a855f7" },
  Pending:    { color: "#5b8def" },
  Running:    { color: "#eab308" },
  Blocked:    { color: "#f97316" },
  Reviewing:  { color: "#0ea5e9" },
  Active:     { color: "#16a34a" },
  Paused:     { color: "#9ca3af" },
  Done:       { color: "#16a34a" },
  Rejected:   { color: "#dc2626" },
};





const STATUS_TO_COLUMN = {
  UNPLANNED: { col: "pending", phase: "Unplanned" },
  PENDING:   { col: "pending", phase: "Pending" },
  PLANNING:  { col: "in_progress", phase: "Planning" },
  IN_PROGRESS: { col: "in_progress", phase: "Running" },
  IN_REVIEW: { col: "in_progress", phase: "Reviewing" },
  BLOCKED:   { col: "in_progress", phase: "Blocked" },
  DONE:      { col: "done", phase: "Done" },
  REJECTED:  { col: "rejected", phase: "Rejected" },
};

const LAB_PERF_MIN_SAMPLE = 5;










function statusDotColor(status) {
  if (status === "active") return "#10b981";
  if (status === "idle") return "#fbbf24";
  if (status === "disabled") return "#dc2626";
  return "#9ca3af";
}




function statusLabel(status) {
  if (status === "active") return "working";
  if (status === "idle") return "idle";
  if (status === "disabled") return "disabled";
  return "offline";
}

const HEARTBEAT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12 H6 L9 3 L15 21 L18 12 H22" pathLength="100"/></svg>`;

function renderAvatar(agent, size = 40, opts = {}) {
  if (!agent) return "";
  const status = opts.status ?? "idle";
  const color = statusDotColor(status);
  const showHeartbeat = opts.showDot !== false;
  const stateClass = status === "active" ? " lab-avatar-heartbeat-active" : "";



  const hb = showHeartbeat
    ? `<span class="lab-avatar-heartbeat${stateClass}" style="background: ${color}; color: #fff;" title="${escapeHtml(statusLabel(status))}">${HEARTBEAT_SVG}</span>`
    : "";
  const accentVar = agent.bg ? `; --avatar-accent: ${agent.bg}` : "";
  return `
    <span class="lab-avatar" data-lab-agent-id="${escapeHtml(agent.id)}" style="--avatar-size: ${size}px${accentVar};">
      <img src="${escapeHtml(agent.avatar)}" alt="${escapeHtml(agent.name)}" loading="lazy" />
      ${hb}
    </span>`;
}

function renderModeToggle(workerMode, returnTo = "/pipeline") {



  const isAuto = workerMode === "auto";
  return `
    <form method="post" action="/project/mode" class="lab-mode-toggle" data-lab-mode-form title="Autonomous worker: AUTO picks up new tasks automatically; SEMI waits for operator to press Start.">
      <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />
      <input type="hidden" name="mode" value="${isAuto ? "auto" : "semi"}" data-lab-mode-value />
      <span class="lab-mode-toggle-label" data-lab-mode-label>${isAuto ? "Auto" : "Semi"}</span>
      <label class="lab-mode-toggle-switch">
        <input type="checkbox" class="lab-mode-toggle-input" data-lab-mode-input ${isAuto ? "checked" : ""} aria-label="Toggle autonomous worker mode" />
        <span class="lab-mode-toggle-track" aria-hidden="true"></span>
      </label>
    </form>`;
}

const SOUND_ON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const SOUND_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`;
const THEME_SUN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const THEME_MOON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;

function renderTopbar({ workerMode = "semi", breadcrumb = "pipeline", activeRoute = "pipeline", systemStatus = null }) {
  const navItems = [
    { id: "pipeline", label: "Pipeline", href: "/pipeline" },
    { id: "agents", label: "Agents", href: "/agents" },
    { id: "project", label: "Project", href: "/project" },
  ];



  const systemBadge = systemStatus
    ? `<a class="lab-project-system-badge" data-status="${escapeHtml(systemStatus)}" href="/project#runtime" title="Open Runtime availability">
        <span class="lab-project-system-badge-dot" aria-hidden="true"></span>
        <span class="lab-project-system-badge-label">${escapeHtml(systemStatus)}</span>
      </a>`
    : "";
  return `
    <header class="lab-topbar">
      <div class="lab-topbar-left">
        <span class="lab-topbar-logo"></span>
        <span>niis<span style="color: var(--lab-text-subtle);">/${escapeHtml(breadcrumb)}</span></span>
      </div>
      <nav class="lab-topbar-nav">
        ${navItems.map((it) => it.id === activeRoute
          ? `<span class="lab-active" aria-current="page">${escapeHtml(it.label)}</span>`
          : `<a href="${escapeHtml(it.href)}">${escapeHtml(it.label)}</a>`).join("")}
      </nav>
      <div class="lab-topbar-right">
        ${systemBadge}
        ${renderModeToggle(workerMode, "/" + breadcrumb)}
        <button type="button" class="lab-topbar-icon-btn" data-lab-sound-toggle aria-label="Toggle sound notifications" title="Sound notifications">
          <span class="lab-topbar-icon-btn-on" aria-hidden="true">${SOUND_ON_SVG}</span>
          <span class="lab-topbar-icon-btn-off" aria-hidden="true">${SOUND_OFF_SVG}</span>
        </button>
        <span class="lab-topbar-icon" title="Notifications"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.9997 19C14.9997 20.6569 13.6566 22 11.9997 22C10.3429 22 8.99972 20.6569 8.99972 19M13.7962 6.23856C14.2317 5.78864 14.4997 5.17562 14.4997 4.5C14.4997 3.11929 13.3804 2 11.9997 2C10.619 2 9.49972 3.11929 9.49972 4.5C9.49972 5.17562 9.76772 5.78864 10.2032 6.23856M17.9997 11.2C17.9997 9.82087 17.3676 8.49823 16.2424 7.52304C15.1171 6.54786 13.591 6 11.9997 6C10.4084 6 8.8823 6.54786 7.75708 7.52304C6.63186 8.49823 5.99972 9.82087 5.99972 11.2C5.99972 13.4818 5.43385 15.1506 4.72778 16.3447C3.92306 17.7056 3.5207 18.3861 3.53659 18.5486C3.55476 18.7346 3.58824 18.7933 3.73906 18.9036C3.87089 19 4.53323 19 5.85791 19H18.1415C19.4662 19 20.1286 19 20.2604 18.9036C20.4112 18.7933 20.4447 18.7346 20.4629 18.5486C20.4787 18.3861 20.0764 17.7056 19.2717 16.3447C18.5656 15.1506 17.9997 13.4818 17.9997 11.2Z"/></svg><span class="lab-topbar-icon-dot"></span></span>
        <button type="button" class="lab-topbar-icon-btn" data-lab-theme-toggle aria-label="Toggle theme" title="Light / dark theme">
          <span class="lab-topbar-icon-btn-light" aria-hidden="true">${THEME_SUN_SVG}</span>
          <span class="lab-topbar-icon-btn-dark" aria-hidden="true">${THEME_MOON_SVG}</span>
        </button>
      </div>
    </header>`;
}

function renderRoster({ agentStatusMap }) {
  const activeCount = LAB_AGENTS.filter((a) => agentStatusMap[a.id] === "active").length;
  return `
    <section class="lab-roster">
      <div class="lab-roster-heading">
        <h2>Your team</h2>
        <span class="lab-topbar-status" title="Agents currently doing work">
          <span class="lab-topbar-status-dot"></span>
          <span><strong>${activeCount}</strong> / ${LAB_AGENTS.length} working</span>
        </span>
      </div>
      <div class="lab-roster-list">
        ${LAB_AGENTS.map((a) => {
          const status = agentStatusMap[a.id] ?? "idle";
          return `
          <div class="lab-roster-item" title="${escapeHtml(a.name)} — ${escapeHtml(a.role)} (${escapeHtml(statusLabel(status))})">
            ${renderAvatar(a, 56, { showDot: true, status })}
            <div class="lab-roster-name">${escapeHtml(a.name)}</div>
            <div class="lab-roster-role">${escapeHtml(a.role)}</div>
          </div>`;
        }).join("")}
        <button type="button" class="lab-roster-add" data-marketplace-open title="Browse agent marketplace"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5V19M5 12H19"/></svg></button>
        <a class="lab-roster-manage" href="/agents" title="Configure roles, runtimes, and budgets"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.0005 15C13.6573 15 15.0005 13.6569 15.0005 12C15.0005 10.3431 13.6573 9 12.0005 9C10.3436 9 9.00049 10.3431 9.00049 12C9.00049 13.6569 10.3436 15 12.0005 15Z"/><path d="M9.28957 19.3711L9.87402 20.6856C10.0478 21.0768 10.3313 21.4093 10.6902 21.6426C11.0492 21.8759 11.4681 22.0001 11.8962 22C12.3244 22.0001 12.7433 21.8759 13.1022 21.6426C13.4612 21.4093 13.7447 21.0768 13.9185 20.6856L14.5029 19.3711C14.711 18.9047 15.0609 18.5159 15.5029 18.26C15.9477 18.0034 16.4622 17.8941 16.9729 17.9478L18.4029 18.1C18.8286 18.145 19.2582 18.0656 19.6396 17.8713C20.021 17.6771 20.3379 17.3763 20.5518 17.0056C20.766 16.635 20.868 16.2103 20.8455 15.7829C20.823 15.3555 20.677 14.9438 20.4251 14.5978L19.5785 13.4344C19.277 13.0171 19.1159 12.5148 19.1185 12C19.1184 11.4866 19.281 10.9864 19.5829 10.5711L20.4296 9.40778C20.6814 9.06175 20.8275 8.65007 20.85 8.22267C20.8725 7.79528 20.7704 7.37054 20.5562 7C20.3423 6.62923 20.0255 6.32849 19.644 6.13423C19.2626 5.93997 18.833 5.86053 18.4074 5.90556L16.9774 6.05778C16.4667 6.11141 15.9521 6.00212 15.5074 5.74556C15.0645 5.48825 14.7144 5.09736 14.5074 4.62889L13.9185 3.31444C13.7447 2.92317 13.4612 2.59072 13.1022 2.3574C12.7433 2.12408 12.3244 1.99993 11.8962 2C11.4681 1.99993 11.0492 2.12408 10.6902 2.3574C10.3313 2.59072 10.0478 2.92317 9.87402 3.31444L9.28957 4.62889C9.0825 5.09736 8.73245 5.48825 8.28957 5.74556C7.84479 6.00212 7.33024 6.11141 6.81957 6.05778L5.38513 5.90556C4.95946 5.86053 4.52987 5.93997 4.14844 6.13423C3.76702 6.32849 3.45014 6.62923 3.23624 7C3.02206 7.37054 2.92002 7.79528 2.94251 8.22267C2.96499 8.65007 3.11103 9.06175 3.36291 9.40778L4.20957 10.5711C4.51151 10.9864 4.67411 11.4866 4.67402 12C4.67411 12.5134 4.51151 13.0137 4.20957 13.4289L3.36291 14.5922C3.11103 14.9382 2.96499 15.3499 2.94251 15.7773C2.92002 16.2047 3.02206 16.6295 3.23624 17C3.45036 17.3706 3.76727 17.6712 4.14864 17.8654C4.53001 18.0596 4.95949 18.1392 5.38513 18.0944L6.81513 17.9422C7.3258 17.8886 7.84034 17.9979 8.28513 18.2544C8.72966 18.511 9.08134 18.902 9.28957 19.3711Z"/></svg><span>Manage Agents</span></a>
      </div>
    </section>`;
}

const PLAY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"/><path d="M9.5 8.96533C9.5 8.48805 9.5 8.24941 9.59974 8.11618C9.68666 8.00007 9.81971 7.92744 9.96438 7.9171C10.1304 7.90525 10.3311 8.03429 10.7326 8.29239L15.4532 11.3271C15.8016 11.551 15.9758 11.663 16.0359 11.8054C16.0885 11.9298 16.0885 12.0702 16.0359 12.1946C15.9758 12.337 15.8016 12.449 15.4532 12.6729L10.7326 15.7076C10.3311 15.9657 10.1304 16.0948 9.96438 16.0829C9.81971 16.0726 9.68666 15.9999 9.59974 15.8838C9.5 15.7506 9.5 15.512 9.5 15.0347V8.96533Z"/></svg>`;
const PAUSE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 15V9M14.5 15V9M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 17.5228 6.47715 22 12 22Z"/></svg>`;

function actionForPhase(phase) {
  if (phase === "Unplanned") return { action: "start", kind: "play", title: "Start planning" };
  if (phase === "Pending") return { action: "approve", kind: "play", title: "Approve plan" };
  if (phase === "Blocked") return { action: "retry", kind: "play", title: "Retry task" };
  if (phase === "Running") {
    return { action: "cancel", kind: "pause", title: "Cancel task" };
  }
  return null;
}

function renderKanbanCard(task, agentStatusMap) {
  const agent = LAB_AGENTS.find((a) => a.id === task.agent);
  const phase = LAB_PHASES[task.phase];
  const phaseBadge = task.phase
    ? `<span class="lab-kanban-card-phase" style="--phase-color: ${phase?.color ?? "#6b7280"};">${escapeHtml(task.phase)}</span>`
    : "";
  const action = task.task_id ? actionForPhase(task.phase) : null;
  const actionBtn = action
    ? `<button type="button" class="lab-kanban-card-action lab-kanban-card-action-${action.kind}" title="${escapeHtml(action.title)}" aria-label="${escapeHtml(action.title)}: ${escapeHtml(task.title)}" data-lab-task-action="lifecycle" data-task-id="${escapeHtml(task.task_id)}" data-action="${escapeHtml(action.action)}">${action.kind === "play" ? PLAY_SVG : PAUSE_SVG}</button>`
    : "";

  let progressBlock = "";
  if (task.subtasks_total) {
    const dots = Array.from({ length: task.subtasks_total }, (_, i) => {
      let cls = "lab-kanban-step lab-kanban-step-pending";
      if (i < task.subtasks_done) cls = "lab-kanban-step lab-kanban-step-done";
      else if (i === task.subtasks_done) cls = "lab-kanban-step lab-kanban-step-active";
      return `<span class="${cls}"></span>`;
    }).join("");
    progressBlock = `
      <div class="lab-kanban-progress-real">
        <div class="lab-kanban-stepper">${dots}</div>
        <div class="lab-kanban-progress-meta">
          <span class="lab-kanban-progress-ratio">${task.subtasks_done}/${task.subtasks_total} subtasks</span>
          ${task.current ? `<span class="lab-kanban-progress-current">· ${escapeHtml(task.current)}</span>` : ""}
        </div>
      </div>`;
  } else if (task.single_shot) {
    progressBlock = `
      <div class="lab-kanban-running">
        <span class="lab-kanban-running-pulse"></span>
        <span>Running — single shot</span>
      </div>`;
  } else if (task.note) {
    progressBlock = `<div class="lab-kanban-note">${escapeHtml(task.note)}</div>`;
  }

  const titleEl = task.task_id
    ? `<div class="lab-kanban-card-title" title="${escapeHtml(task.task_id)}">${escapeHtml(task.title)}</div>`
    : `<div class="lab-kanban-card-title">${escapeHtml(task.title)}</div>`;
  const agentStatus = agent ? agentStatusMap[agent.id] ?? "idle" : "idle";

  const cardAttrs = task.task_id
    ? ` data-task-id="${escapeHtml(task.task_id)}"`
    : "";




  const subLabel = task.task_kind === "agent_tick"
    ? "Agent tick"
    : (agent ? agent.role : "");
  return `
    <div class="lab-kanban-card"${cardAttrs}>
      <div class="lab-kanban-card-row">
        ${renderAvatar(agent, 28, { showDot: false, status: agentStatus })}
        <div class="lab-kanban-card-meta">
          ${titleEl}
          <div class="lab-kanban-card-sub">${escapeHtml(subLabel)} · ${escapeHtml(task.duration ?? "—")}</div>
        </div>
        ${phaseBadge}
        ${actionBtn}
      </div>
      ${progressBlock}
    </div>`;
}

function renderKanban({ tasks, agentStatusMap }) {
  return `
    <div class="lab-kanban-toolbar">
      <div class="lab-kanban-toolbar-text">
        <span class="lab-kanban-toolbar-title">Pipeline board</span>
        <span class="lab-kanban-toolbar-subtitle">Create work here; open the legacy task list only when you need the old table.</span>
      </div>
      <a class="lab-kanban-all-tasks" href="/tasks">All tasks</a>
    </div>
    <section class="lab-kanban">
      ${LAB_COLUMNS.map((col) => {
        const colTasks = tasks.filter((t) => t.col === col.id);
        const addBtn = col.id === "pending"
          ? `<button type="button" class="lab-kanban-add" data-task-form-open>+ Add Task</button>`
          : "";
        return `
          <div class="lab-kanban-col" data-lab-kanban-col="${escapeHtml(col.id)}" style="--col-accent: ${col.accent}; --col-tint: ${col.tint};">
            <div class="lab-kanban-col-header">
              <span class="lab-kanban-col-title">${escapeHtml(col.label)}</span>
              <span class="lab-kanban-col-count">${colTasks.length} tasks</span>
              <button class="lab-kanban-col-arrow" title="Open ${escapeHtml(col.label)}">→</button>
            </div>
            ${colTasks.map((t) => renderKanbanCard(t, agentStatusMap)).join("")}
            ${addBtn}
          </div>`;
      }).join("")}
    </section>`;
}

function renderPerformance({ performance, agentStatusMap }) {
  const ratedAgents = LAB_AGENTS.filter((a) => {
    const p = performance[a.id];
    return p && p.success_pct != null;
  });
  const overall = ratedAgents.length > 0
    ? Math.round(ratedAgents.reduce((s, a) => s + performance[a.id].success_pct, 0) / ratedAgents.length)
    : null;
  const totalRuns = LAB_AGENTS.reduce((s, a) => s + (performance[a.id]?.runs ?? 0), 0);

  const rateColor = (pct) => {
    if (pct == null) return "#d1d5db";
    if (pct >= 90) return "#16a34a";
    if (pct >= 75) return "#eab308";
    return "#dc2626";
  };
  const rows = LAB_AGENTS.map((a) => {
    const p = performance[a.id];
    if (!p) return "";
    const hasSample = p.success_pct != null;
    const color = rateColor(p.success_pct);
    const barFill = hasSample
      ? `<div class="lab-perf-bar-fill" style="width: ${p.success_pct}%; background: ${color};"></div>`
      : "";
    const pctText = hasSample
      ? `<span style="color: ${color};">${p.success_pct}%</span>`
      : `<span class="lab-perf-pct-empty" title="Need at least ${LAB_PERF_MIN_SAMPLE} runs to compute a stable success rate. Currently ${p.runs} run${p.runs === 1 ? "" : "s"}.">—</span>`;
    const meta = `${p.runs} run${p.runs === 1 ? "" : "s"} · ${p.avg_minutes != null ? `${p.avg_minutes}m avg` : "—"} · $${(p.total_cost ?? 0).toFixed(2)}`;
    const status = agentStatusMap[a.id] ?? "idle";
    return `
      <div class="lab-perf-row">
        ${renderAvatar(a, 24, { showDot: false, status })}
        <div class="lab-perf-name-block">
          <span class="lab-perf-name">${escapeHtml(a.name)}</span>
          <span class="lab-perf-meta">${escapeHtml(meta)}</span>
        </div>
        <div class="lab-perf-bar">${barFill}</div>
        <span class="lab-perf-pct">${pctText}</span>
      </div>`;
  }).join("");

  return `
    <section class="lab-perf-card">
      <div class="lab-perf-header">
        <h2>Agent Performance</h2>
        <button class="lab-perf-period">Last 7 days ▾</button>
      </div>
      <div class="lab-perf-grid">
        <div>${rows}</div>
        <div class="lab-perf-overall">
          <h3>Overall Success</h3>
          <div class="lab-perf-donut" style="--pct: ${overall ?? 0};">
            <span class="lab-perf-donut-value">${overall != null ? overall + "%" : "—"}</span>
          </div>
          <div class="lab-perf-overall-delta">${ratedAgents.length} of ${LAB_AGENTS.length} agents rated · ${totalRuns} runs total</div>
          <button class="lab-perf-view-btn">View Analytics</button>
        </div>
      </div>
    </section>`;
}

function renderGoals({ goals, agentStatusMap }) {
  if (goals.length === 0) {
    return `
      <section class="lab-card">
        <div class="lab-card-header">
          <h2>Active Goals</h2>
        </div>
        <p class="lab-empty">No goals defined yet. Goals link related tasks for higher-level progress and cost attribution.</p>
      </section>`;
  }
  return `
    <section class="lab-card">
      <div class="lab-card-header">
        <h2>Active Goals</h2>
        <a href="/project#goals" class="lab-card-link">View all →</a>
      </div>
      ${goals.map((g) => {
        const owner = LAB_AGENTS.find((a) => a.id === g.owner);
        const pct = g.task_count > 0 ? Math.round((g.done_count / g.task_count) * 100) : 0;
        const statusColor = g.status === "active" ? "#16a34a" : g.status === "planned" ? "#9ca3af" : g.status === "achieved" ? "#16a34a" : "#5b8def";
        const ownerStatus = owner ? agentStatusMap[owner.id] ?? "idle" : "idle";
        return `
          <div class="lab-goal-row">
            <div class="lab-goal-row-top">
              ${owner ? renderAvatar(owner, 24, { showDot: false, status: ownerStatus }) : ""}
              <div class="lab-goal-meta">
                <div class="lab-goal-name">${escapeHtml(g.title)}</div>
                <div class="lab-goal-sub">${g.done_count}/${g.task_count} tasks · $${(g.total_cost_usd ?? 0).toFixed(2)}</div>
              </div>
              <span class="lab-goal-status" style="--status-color: ${statusColor};">${escapeHtml(g.status)}</span>
            </div>
            <div class="lab-goal-bar"><div class="lab-goal-bar-fill" style="width: ${pct}%;"></div></div>
          </div>`;
      }).join("")}
    </section>`;
}

function renderActivity({ activity, agentStatusMap }) {
  if (activity.length === 0) {
    return `
      <section class="lab-card">
        <div class="lab-card-header">
          <h2>Recent Activity</h2>
        </div>
        <p class="lab-empty">No activity recorded yet.</p>
      </section>`;
  }
  const toneColor = (tone) => {
    if (tone === "good") return "#16a34a";
    if (tone === "bad") return "#dc2626";
    return "#9ca3af";
  };
  return `
    <section class="lab-card">
      <div class="lab-card-header">
        <h2>Recent Activity</h2>
        <a href="/insights" class="lab-card-link">Full log →</a>
      </div>
      <div class="lab-activity-list">
        ${activity.map((e) => {
          const agent = LAB_AGENTS.find((a) => a.id === e.agent);
          const verdict = e.verdict
            ? `<span class="lab-activity-verdict" style="--v-color: ${toneColor(e.tone)};">${escapeHtml(e.verdict)}</span>`
            : "";
          const status = agent ? agentStatusMap[agent.id] ?? "idle" : "idle";
          return `
            <div class="lab-activity-row">
              <span class="lab-activity-dot" style="background: ${toneColor(e.tone)};"></span>
              ${agent ? renderAvatar(agent, 22, { showDot: false, status }) : ""}
              <div class="lab-activity-text">
                <strong>${agent ? escapeHtml(agent.name) : "—"}</strong>
                <span>${escapeHtml(e.verb)}</span>
                <em>${escapeHtml(e.target)}</em>
                ${verdict}
              </div>
              <span class="lab-activity-ts">${escapeHtml(e.ts)}</span>
            </div>`;
        }).join("")}
      </div>
    </section>`;
}



function relativeTimeFromNow(timestamp, now) {
  if (!timestamp) return "—";
  const ms = now - Date.parse(timestamp);
  if (Number.isNaN(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function durationLabel(taskNav, now) {
  const ts = taskNav.latest_run_timestamp ?? taskNav.updated_at;
  return relativeTimeFromNow(ts, now);
}




function pickPersonaForTask(taskNav, subtaskProgress) {

  if (taskNav.assigned_to && AGENT_ID_SET.has(taskNav.assigned_to)) {
    return taskNav.assigned_to;
  }
  if (taskNav.status === "PLANNING" || taskNav.status === "UNPLANNED") return "vera";
  if (taskNav.status === "IN_REVIEW") return "iris";
  if (taskNav.status === "REJECTED") return "iris";
  const subtasks = subtaskProgress?.subtasks ?? [];
  const active = subtasks.find((s) => s.status === "IN_PROGRESS");
  if (active?.role_id && ROLE_TO_PERSONA[active.role_id]) return ROLE_TO_PERSONA[active.role_id];
  const next = subtasks.find((s) => s.status !== "DONE");
  if (next?.role_id && ROLE_TO_PERSONA[next.role_id]) return ROLE_TO_PERSONA[next.role_id];
  const last = subtasks[subtasks.length - 1];
  if (last?.role_id && ROLE_TO_PERSONA[last.role_id]) return ROLE_TO_PERSONA[last.role_id];
  return "marcus";
}

function buildLabTasks({ dashboard, subtaskProgressByTaskId, now }) {
  const allTaskNavs = dashboard.task_board.flatMap((g) => g.entries);
  return allTaskNavs.map((taskNav) => {
    const mapping = STATUS_TO_COLUMN[taskNav.status] ?? { col: "pending", phase: "Pending" };
    const subtaskProgress = subtaskProgressByTaskId?.[taskNav.task_id] ?? null;
    const subtasks = subtaskProgress?.subtasks ?? [];
    const total = subtasks.length;
    const done = subtasks.filter((s) => s.status === "DONE").length;
    const active = subtasks.find((s) => s.status === "IN_PROGRESS") ?? null;

    const lab = {
      task_id: taskNav.task_id,
      col: mapping.col,
      phase: mapping.phase,
      title: taskNav.task_title,
      agent: pickPersonaForTask(taskNav, subtaskProgress),
      duration: durationLabel(taskNav, now),



      task_kind: taskNav.task_kind ?? null,
    };

    if (total > 0) {
      lab.subtasks_total = total;
      lab.subtasks_done = done;
      if (active?.title) lab.current = active.title;
    } else if (taskNav.status === "IN_PROGRESS") {
      lab.single_shot = true;
    }


    if (taskNav.status === "PLANNING" || taskNav.status === "UNPLANNED") {
      lab.note = "Drafting subtasks";
    } else if (taskNav.status === "BLOCKED") {
      lab.note = taskNav.active_blocker_count > 0
        ? `Blocked · ${taskNav.active_blocker_count} blocker${taskNav.active_blocker_count === 1 ? "" : "s"}`
        : "Blocked";
    } else if (taskNav.status === "IN_REVIEW") {
      lab.note = "Validating";
    } else if (taskNav.status === "REJECTED") {
      lab.note = taskNav.latest_run_status ? `Rejected: ${taskNav.latest_run_status}` : "Rejected";
    }

    return lab;
  });
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;








function buildLabPerformance({ subtaskProgressByTaskId, runs, roleSpend, now }) {
  const cutoffMs = now.getTime() - SEVEN_DAYS_MS;
  const counters = Object.fromEntries(LAB_AGENTS.map((a) => [a.id, {
    runs: 0, done: 0, failed: 0, durations_ms: [], cost: 0,
  }]));


  const runsWithRole = (runs ?? []).filter((r) => {
    if (!r.role_id) return false;
    const startedMs = Date.parse(r.started_at ?? "");
    return Number.isFinite(startedMs) && startedMs >= cutoffMs;
  });
  const runsWithRoleIds = new Set(runsWithRole.map((r) => r.id));

  for (const run of runsWithRole) {
    const persona = ROLE_TO_PERSONA[run.role_id];
    if (!persona) continue;
    counters[persona].runs += 1;
    if (run.status === "COMPLETED") counters[persona].done += 1;
    else if (run.status === "FAILED" || run.status === "TIMED_OUT") counters[persona].failed += 1;
    if (run.started_at && run.finished_at) {
      const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
      if (ms >= 0) counters[persona].durations_ms.push(ms);
    }
  }




  const tasksWithRecentLegacyRuns = new Set(
    (runs ?? [])
      .filter((r) => !r.role_id)
      .filter((r) => {
        const startedMs = Date.parse(r.started_at ?? "");
        return Number.isFinite(startedMs) && startedMs >= cutoffMs;
      })
      .map((r) => r.task_id),
  );
  for (const taskId of Object.keys(subtaskProgressByTaskId ?? {})) {
    if (!tasksWithRecentLegacyRuns.has(taskId)) continue;
    const progress = subtaskProgressByTaskId[taskId];
    for (const subtask of progress?.subtasks ?? []) {
      const persona = ROLE_TO_PERSONA[subtask.role_id];
      if (!persona) continue;
      counters[persona].runs += 1;
      if (subtask.status === "DONE") counters[persona].done += 1;
      else if (subtask.status === "FAILED" || subtask.status === "BLOCKED" || subtask.status === "REJECTED") {
        counters[persona].failed += 1;
      }
    }
  }



  const taskPersonaMap = new Map();
  for (const taskId of Object.keys(subtaskProgressByTaskId ?? {})) {
    const subtasks = subtaskProgressByTaskId[taskId]?.subtasks ?? [];
    const personas = new Set(subtasks.map((s) => ROLE_TO_PERSONA[s.role_id]).filter(Boolean));
    if (personas.size > 0) taskPersonaMap.set(taskId, personas);
  }
  for (const run of runs ?? []) {
    if (run.role_id) continue;
    if (runsWithRoleIds.has(run.id)) continue;
    if (!run.started_at || !run.finished_at) continue;
    const startedMs = Date.parse(run.started_at);
    if (!Number.isFinite(startedMs) || startedMs < cutoffMs) continue;
    const ms = Date.parse(run.finished_at) - startedMs;
    if (ms < 0) continue;
    const personas = taskPersonaMap.get(run.task_id);
    if (!personas) continue;
    for (const persona of personas) counters[persona].durations_ms.push(ms);
  }



  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const spendByRole = new Map();
  for (const row of roleSpend ?? []) {
    if (row.period_yyyy_mm !== period) continue;
    spendByRole.set(row.role_id, (spendByRole.get(row.role_id) ?? 0) + Number(row.spent_usd ?? 0));
  }
  for (const agent of LAB_AGENTS) {
    counters[agent.id].cost = spendByRole.get(agent.role_id) ?? 0;
  }

  const result = {};
  for (const agent of LAB_AGENTS) {
    const c = counters[agent.id];
    const finalized = c.done + c.failed;
    const successPct = finalized >= LAB_PERF_MIN_SAMPLE
      ? Math.round((c.done / finalized) * 100)
      : null;
    const avgMs = c.durations_ms.length > 0
      ? c.durations_ms.reduce((a, b) => a + b, 0) / c.durations_ms.length
      : null;
    result[agent.id] = {
      runs: c.runs,
      success_pct: successPct,
      avg_minutes: avgMs != null ? Math.round(avgMs / 60000) : null,
      total_cost: c.cost,
    };
  }
  return result;
}

function buildLabGoals({ snapshot, summarizeGoalProgress }) {
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
    const ownerPersona = goal.owner_agent_id && ROLE_TO_PERSONA[goal.owner_agent_id]
      ? ROLE_TO_PERSONA[goal.owner_agent_id]
      : "marcus";
    return {
      id: goal.id,
      title: goal.title,
      status: goal.status,
      owner: ownerPersona,
      task_count: progress?.task_count ?? 0,
      done_count: progress?.task_status_counts?.DONE ?? 0,
      total_cost_usd: progress?.total_cost_usd ?? 0,
    };
  });
}



function buildLabActivity({ snapshot, dashboard, subtaskProgressByTaskId, buildActivityStream, now }) {
  const taskNavById = new Map();
  for (const group of dashboard.task_board) {
    for (const entry of group.entries) taskNavById.set(entry.task_id, entry);
  }
  let stream = [];
  try {
    stream = buildActivityStream({ snapshot, taskId: null });
  } catch {
    stream = [];
  }
  const taskTitle = (id) => taskNavById.get(id)?.task_title ?? id ?? "—";


  const events = stream.map((entry) => {
    const taskNav = taskNavById.get(entry.task_id) ?? null;
    const subtaskProgress = subtaskProgressByTaskId?.[entry.task_id] ?? null;
    const persona = taskNav ? pickPersonaForTask(taskNav, subtaskProgress) : "marcus";
    let verb = "updated";
    let tone = "neutral";
    let verdict = null;
    const payload = entry.payload ?? {};

    if (entry.source_kind === "approval") {
      const status = payload.status ?? "";
      if (status === "APPROVED") { verb = "approved"; tone = "good"; verdict = "PASS"; }
      else if (status === "REJECTED") { verb = "rejected"; tone = "bad"; verdict = "FAIL"; }
      else verb = "decided on";
    } else if (entry.source_kind === "blocker") {
      verb = "flagged blocker on";
      tone = "bad";
    } else if (entry.source_kind === "event") {
      const phaseStatus = String(payload.phase_status ?? "").toLowerCase();
      if (payload.to_status === "DONE" || phaseStatus === "completed") { verb = "completed"; tone = "good"; }
      else if (payload.to_status === "BLOCKED" || phaseStatus === "blocked") { verb = "blocked"; tone = "bad"; }
      else if (payload.to_status === "REJECTED") { verb = "rejected"; tone = "bad"; }
      else if (payload.to_status === "IN_PROGRESS") verb = "started running";
      else if (payload.to_status === "PLANNING") verb = "drafted plan for";
      else if (payload.to_status === "IN_REVIEW") verb = "submitted for review";
      else if (payload.to_status === "PENDING") verb = "queued";
      else if (payload.from_status && payload.to_status) verb = `moved ${payload.from_status} → ${payload.to_status}`;
      else verb = "updated";
    } else if (entry.source_kind === "assignment") {
      verb = "claimed";
    }

    return {
      ts: relativeTimeFromNow(entry.timestamp, now),
      _ts_ms: Date.parse(entry.timestamp),
      agent: persona,
      verb,
      target: taskTitle(entry.task_id),
      tone,
      verdict,
    };
  });


  const verdictRows = (snapshot?.verdicts ?? [])
    .filter((v) => v.created_at)
    .map((v) => {
      const taskNav = taskNavById.get(v.task_id) ?? null;

      const persona = taskNav ? "iris" : "iris";
      const isPass = v.verdict_class === "PASS";
      return {
        ts: relativeTimeFromNow(v.created_at, now),
        _ts_ms: Date.parse(v.created_at),
        agent: persona,
        verb: isPass ? "approved" : `flagged ${String(v.verdict_class).toLowerCase()} on`,
        target: taskTitle(v.task_id),
        tone: isPass ? "good" : "bad",
        verdict: isPass ? "PASS" : "FAIL",
      };
    });

  return [...events, ...verdictRows]
    .sort((a, b) => b._ts_ms - a._ts_ms)
    .slice(0, 7)
    .map(({ _ts_ms, ...rest }) => rest);
}





function buildAgentStatusMap({ runs, subtaskProgressByTaskId, now, disabledAgentIds = null }) {
  const taskPersonaMap = new Map();
  for (const taskId of Object.keys(subtaskProgressByTaskId ?? {})) {
    const subtasks = subtaskProgressByTaskId[taskId]?.subtasks ?? [];
    const personas = new Set(subtasks.map((s) => ROLE_TO_PERSONA[s.role_id]).filter(Boolean));
    if (personas.size > 0) taskPersonaMap.set(taskId, personas);
  }
  const lastRunByPersona = new Map();
  for (const run of runs ?? []) {
    const ts = Date.parse(run.finished_at ?? run.started_at ?? "");
    if (Number.isNaN(ts)) continue;
    const personas = taskPersonaMap.get(run.task_id);
    if (!personas) continue;
    for (const persona of personas) {
      const prev = lastRunByPersona.get(persona) ?? 0;
      if (ts > prev) lastRunByPersona.set(persona, ts);
    }
  }
  const disabled = disabledAgentIds instanceof Set ? disabledAgentIds : new Set();
  const result = {};
  for (const agent of LAB_AGENTS) {
    if (disabled.has(agent.id)) { result[agent.id] = "disabled"; continue; }
    const ts = lastRunByPersona.get(agent.id);
    if (!ts) { result[agent.id] = "idle"; continue; }
    const sinceMs = now - ts;
    if (sinceMs <= 60 * 1000) result[agent.id] = "active";
    else if (sinceMs <= 24 * 60 * 60 * 1000) result[agent.id] = "idle";
    else result[agent.id] = "offline";
  }
  return result;
}

function buildLabPageData({
  snapshot = {},
  dashboard,
  subtaskProgressByTaskId = {},
  roleSpend = [],
  buildActivityStream,
  summarizeGoalProgress,
  disabledAgentIds = null,
  now = new Date(),
}) {
  const nowMs = now.getTime();
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  const agentStatusMap = buildAgentStatusMap({ runs, subtaskProgressByTaskId, now: nowMs, disabledAgentIds });
  return {
    agentStatusMap,
    tasks: buildLabTasks({ dashboard, subtaskProgressByTaskId, now: nowMs }),
    performance: buildLabPerformance({ subtaskProgressByTaskId, runs, roleSpend, now }),
    goals: buildLabGoals({ snapshot, summarizeGoalProgress }),
    activity: buildLabActivity({ snapshot, dashboard, subtaskProgressByTaskId, buildActivityStream, now: nowMs }),
  };
}










const ADD_TASK_ICONS = {
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>`,
};

const PRIORITY_CHIPS = [
  { value: "low", label: "Low", color: "#9ca3af" },
  { value: "medium", label: "Medium", color: "#5b8def", checked: true },
  { value: "high", label: "High", color: "#dc2626" },
];

const RUNTIME_OPTIONS = [
  { value: "", label: "Auto (let coordinator decide)" },
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
];

function renderAddTaskSidebar({ taskTemplates = [] } = {}) {
  const priorityChips = PRIORITY_CHIPS.map((p) => `
    <label class="lab-task-form-chip">
      <input type="radio" name="priority" value="${escapeHtml(p.value)}"${p.checked ? " checked" : ""} />
      <span class="lab-task-form-chip-dot" style="background: ${p.color};"></span>
      <span class="lab-task-form-chip-label">${escapeHtml(p.label)}</span>
    </label>`).join("");

  const runtimeOptions = RUNTIME_OPTIONS.map((o) =>
    `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("");





  const tabHtml = [
    `<button type="button" class="lab-task-form-tab" data-task-form-tab="work" data-task-form-target="lab-task-form-form" aria-selected="true">Work task</button>`,
    ...taskTemplates.map((tpl) =>
      `<button type="button" class="lab-task-form-tab" data-task-form-tab="${escapeHtml(tpl.id)}" data-task-form-target="${escapeHtml(tpl.form_id)}">${escapeHtml(tpl.label)}</button>`),
  ].join("");

  const templatePanes = taskTemplates.map((tpl) => `
    <form id="${escapeHtml(tpl.form_id)}" class="lab-task-form-body lab-task-form-pane" method="post" action="${escapeHtml(tpl.action)}" data-task-form-pane="${escapeHtml(tpl.id)}" hidden>
      ${tpl.fields_html}
    </form>`).join("");

  return `
    <div class="lab-task-form" data-task-form hidden aria-hidden="true">
      <div class="lab-task-form-backdrop" data-task-form-close></div>
      <aside class="lab-task-form-sidebar" role="dialog" aria-label="Add new task">
        <header class="lab-task-form-head">
          <div class="lab-task-form-head-text">
            <h2>Add New Task</h2>
            <p>Describe the work — the planner decomposes it, the coordinator routes it to the right role.</p>
          </div>
          <button type="button" class="lab-task-form-close" data-task-form-close aria-label="Close">${ADD_TASK_ICONS.close}</button>
        </header>
        ${taskTemplates.length > 0 ? `
        <nav class="lab-task-form-tabs" role="tablist" aria-label="Task type">${tabHtml}</nav>` : ""}
        <form id="lab-task-form-form" class="lab-task-form-body lab-task-form-pane" method="post" action="/tasks/new" data-task-form-pane="work">
          <input type="hidden" name="return_to" value="/pipeline" />
          <div class="lab-task-form-field">
            <label class="lab-task-form-label" for="lab-task-form-title">Task Title <span class="lab-task-form-req">*</span></label>
            <input type="text" id="lab-task-form-title" name="title" required class="lab-task-form-input" placeholder="Short, action-oriented title" />
          </div>

          <div class="lab-task-form-field">
            <label class="lab-task-form-label" for="lab-task-form-prompt">Description <span class="lab-task-form-req">*</span></label>
            <p class="lab-task-form-hint">This is the prompt the planner reads. Include intent, constraints, and the success criteria — target paths, frameworks, or relevant docs help the planner pick the right role.</p>
            <div class="lab-task-form-textarea-wrap">
              <textarea id="lab-task-form-prompt" name="prompt" required class="lab-task-form-textarea" rows="6" maxlength="2000" placeholder="What needs to be done, why it matters, what 'done' looks like..." data-task-form-counter="2000"></textarea>
              <span class="lab-task-form-counter" data-task-form-counter-display>0/2000</span>
            </div>
          </div>

          <div class="lab-task-form-field">
            <label class="lab-task-form-label">Priority</label>
            <div class="lab-task-form-chips" role="radiogroup" aria-label="Priority">
              ${priorityChips}
            </div>
          </div>

          <div class="lab-task-form-row">
            <div class="lab-task-form-field">
              <label class="lab-task-form-label" for="lab-task-form-planner">Planner runtime</label>
              <div class="lab-task-form-select-native">
                <select id="lab-task-form-planner" name="planner_runtime">${runtimeOptions}</select>
                <span class="lab-task-form-chevron">${ADD_TASK_ICONS.chevron}</span>
              </div>
            </div>
            <div class="lab-task-form-field">
              <label class="lab-task-form-label" for="lab-task-form-executor">Executor runtime</label>
              <div class="lab-task-form-select-native">
                <select id="lab-task-form-executor" name="executor_runtime">${runtimeOptions}</select>
                <span class="lab-task-form-chevron">${ADD_TASK_ICONS.chevron}</span>
              </div>
            </div>
          </div>

          <p class="lab-task-form-hint">Tasks are created as <code>UNPLANNED</code>. Planning, plan approval, and execution are separate supervised actions.</p>
        </form>
        ${templatePanes}
        <footer class="lab-task-form-foot">
          <div class="lab-task-form-status" data-task-form-status hidden></div>
          <button type="button" class="lab-task-form-cancel" data-task-form-close>Cancel</button>
          <button type="submit" form="lab-task-form-form" class="lab-task-form-submit" data-task-form-submit>Create Task <span class="lab-task-form-submit-icon">${ADD_TASK_ICONS.sparkle}</span></button>
        </footer>
      </aside>
    </div>`;
}

const ADD_TASK_SCRIPT = `
(function(){
  function setOpen(open){
    var el = document.querySelector('[data-task-form]');
    if (!el) return;
    if (open){
      el.hidden = false;
      el.setAttribute('aria-hidden', 'false');
      document.body.classList.add('lab-task-form-locked');
      var titleInput = el.querySelector('input[name="title"]');
      if (titleInput) setTimeout(function(){ titleInput.focus(); }, 50);
    } else {
      el.hidden = true;
      el.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('lab-task-form-locked');
    }
  }
  function setCardStatus(card, kind, message){
    if (!card) return;
    var status = card.querySelector('[data-lab-kanban-card-status]');
    if (!status) {
      status = document.createElement('div');
      status.className = 'lab-kanban-card-status';
      status.setAttribute('data-lab-kanban-card-status', '');
      card.appendChild(status);
    }
    status.setAttribute('data-kind', kind);
    status.textContent = message;
  }
  function requestTaskAction(taskId, actionName, originEl){
    var card = originEl && originEl.closest ? originEl.closest('.lab-kanban-card') : null;
    if (!card && taskId) {
      document.querySelectorAll('.lab-kanban-card[data-task-id]').forEach(function(candidate){
        if (!card && candidate.getAttribute('data-task-id') === taskId) card = candidate;
      });
    }
    var action = card ? card.querySelector('[data-lab-task-action]') : null;
    if (!taskId || !actionName) return Promise.resolve();
    if (card) {
      card.setAttribute('data-busy', 'true');
      setCardStatus(card, 'pending', 'Applying lifecycle action...');
    }
    if (action) {
      action.disabled = true;
      action.setAttribute('aria-busy', 'true');
    }
    var body = new URLSearchParams();
    return fetch('/tasks/' + encodeURIComponent(taskId) + '/actions/' + actionName + '?format=json', {
      body: body,
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'x-requested-with': 'fetch',
      },
    })
      .then(function(resp){
        return resp.json().catch(function(){ return {}; }).then(function(payload){
          if (!resp.ok || payload.ok === false) throw new Error(payload.error || ('Task update failed (' + resp.status + ')'));
          return payload;
        });
      })
      .then(function(payload){
        if (card) setCardStatus(card, 'success', payload.notice || 'Pipeline updated. Refreshing...');
        window.setTimeout(function(){
          window.location.href = payload.redirect || '/pipeline';
        }, 500);
        return payload;
      })
      .catch(function(err){
        if (card) {
          setCardStatus(card, 'error', err && err.message ? err.message : String(err));
          card.removeAttribute('data-busy');
        }
        if (action) {
          action.disabled = false;
          action.setAttribute('aria-busy', 'false');
        }
      });
  }
  document.addEventListener('click', function(e){
    var taskAction = e.target.closest && e.target.closest('[data-lab-task-action="lifecycle"]');
    if (taskAction) {
      e.preventDefault();
      requestTaskAction(taskAction.getAttribute('data-task-id'), taskAction.getAttribute('data-action'), taskAction);
      return;
    }
    if (e.target.closest('[data-task-form-open]')) { e.preventDefault(); setOpen(true); return; }
    if (e.target.closest('[data-task-form-close]')) { e.preventDefault(); setOpen(false); return; }
    var tab = e.target.closest('[data-task-form-tab]');
    if (tab) {
      e.preventDefault();
      var targetFormId = tab.getAttribute('data-task-form-target');
      var sidebar = tab.closest('.lab-task-form-sidebar');
      if (!sidebar || !targetFormId) return;
      sidebar.querySelectorAll('[data-task-form-tab]').forEach(function(t){
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      sidebar.querySelectorAll('[data-task-form-pane]').forEach(function(pane){
        if (pane.id === targetFormId) pane.removeAttribute('hidden');
        else pane.setAttribute('hidden', '');
      });
      var submit = sidebar.querySelector('[data-task-form-submit]');
      if (submit) submit.setAttribute('form', targetFormId);
      var focusInput = sidebar.querySelector('#' + CSS.escape(targetFormId) + ' input:not([type=hidden]), #' + CSS.escape(targetFormId) + ' textarea, #' + CSS.escape(targetFormId) + ' select');
      if (focusInput) setTimeout(function(){ focusInput.focus(); }, 30);
      return;
    }
  });
  document.addEventListener('submit', function(e){
    var form = e.target;
    if (!form.matches || !form.matches('#lab-task-form-form')) return;
    e.preventDefault();
    if (form.getAttribute('data-busy') === 'true') return;
    var submit = document.querySelector('[data-task-form-submit]');
    var status = document.querySelector('[data-task-form-status]');
    var setStatus = function(kind, message){
      if (!status) return;
      status.hidden = false;
      status.setAttribute('data-kind', kind);
      status.textContent = message;
    };
    form.setAttribute('data-busy', 'true');
    if (submit) {
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
    }
    setStatus('pending', 'Creating task on the pipeline...');
    var body = new URLSearchParams();
    new FormData(form).forEach(function(value, key){ body.append(key, value); });
    var action = form.getAttribute('action') || '/tasks/new';
    var jsonAction = action + (action.indexOf('?') === -1 ? '?' : '&') + 'format=json';
    fetch(jsonAction, {
      body: body,
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'x-requested-with': 'fetch',
      },
    })
      .then(function(resp){
        return resp.json().catch(function(){ return {}; }).then(function(payload){
          if (!resp.ok || payload.ok === false) throw new Error(payload.error || ('Task creation failed (' + resp.status + ')'));
          return payload;
        });
      })
      .then(function(payload){
        setStatus('success', payload.status === 'started' ? 'Task created and started. Refreshing pipeline...' : 'Task created. Refreshing pipeline...');
        window.setTimeout(function(){
          window.location.href = payload.redirect || '/pipeline';
        }, 700);
      })
      .catch(function(err){
        setStatus('error', err && err.message ? err.message : String(err));
      })
      .finally(function(){
        form.removeAttribute('data-busy');
        if (submit) {
          submit.disabled = false;
          submit.setAttribute('aria-busy', 'false');
        }
      });
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') setOpen(false);
  });
  document.addEventListener('input', function(e){
    var el = e.target;
    if (!el.matches || !el.matches('[data-task-form-counter]')) return;
    var max = parseInt(el.getAttribute('data-task-form-counter'), 10) || 0;
    var wrap = el.closest('.lab-task-form-textarea-wrap');
    if (!wrap) return;
    var display = wrap.querySelector('[data-task-form-counter-display]');
    if (display) display.textContent = (el.value.length) + '/' + max;
  });
})();
`;





const MARKETPLACE_ICONS = {
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  hero: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`,
  discover: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`,
  compare: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6M8 11h6"/></svg>`,
  deploy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>`,
};

function renderMarketplaceModal() {
  return `
    <div class="lab-marketplace" data-marketplace hidden aria-hidden="true">
      <div class="lab-marketplace-backdrop" data-marketplace-close></div>
      <div class="lab-marketplace-card" role="dialog" aria-label="Agent Marketplace">
        <button type="button" class="lab-marketplace-close" data-marketplace-close aria-label="Close">${MARKETPLACE_ICONS.close}</button>
        <div class="lab-marketplace-hero">
          <span class="lab-marketplace-hero-circle">${MARKETPLACE_ICONS.hero}</span>
          <span class="lab-marketplace-hero-spark lab-marketplace-hero-spark-1"></span>
          <span class="lab-marketplace-hero-spark lab-marketplace-hero-spark-2"></span>
          <span class="lab-marketplace-hero-spark lab-marketplace-hero-spark-3"></span>
          <span class="lab-marketplace-hero-spark lab-marketplace-hero-spark-4"></span>
        </div>
        <h2 class="lab-marketplace-title">Agent Marketplace</h2>
        <p class="lab-marketplace-subtitle">The Agent Marketplace is coming soon. Here you'll be able to discover, explore, and add specialized agents to your team.</p>
        <div class="lab-marketplace-features">
          <div class="lab-marketplace-feature">
            <span class="lab-marketplace-feature-icon">${MARKETPLACE_ICONS.discover}</span>
            <div class="lab-marketplace-feature-text">
              <strong>Discover</strong>
              <span>Explore a wide range of pre-built agents for every use case</span>
            </div>
          </div>
          <div class="lab-marketplace-feature">
            <span class="lab-marketplace-feature-icon">${MARKETPLACE_ICONS.compare}</span>
            <div class="lab-marketplace-feature-text">
              <strong>Compare</strong>
              <span>View capabilities, skills, and performance before adding</span>
            </div>
          </div>
          <div class="lab-marketplace-feature">
            <span class="lab-marketplace-feature-icon">${MARKETPLACE_ICONS.deploy}</span>
            <div class="lab-marketplace-feature-text">
              <strong>Add &amp; Deploy</strong>
              <span>Seamlessly add agents to your team and start automating</span>
            </div>
          </div>
        </div>
        <p class="lab-marketplace-footer">Stay tuned! We're building something amazing. 🚀</p>
      </div>
    </div>`;
}

const MARKETPLACE_SCRIPT = `
(function(){
  function setOpen(open){
    var el = document.querySelector('[data-marketplace]');
    if (!el) return;
    if (open){
      el.hidden = false;
      el.setAttribute('aria-hidden', 'false');
      document.body.classList.add('lab-task-form-locked');
    } else {
      el.hidden = true;
      el.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('lab-task-form-locked');
    }
  }
  document.addEventListener('click', function(e){
    if (e.target.closest('[data-marketplace-open]')) { e.preventDefault(); setOpen(true); return; }
    if (e.target.closest('[data-marketplace-close]')) { e.preventDefault(); setOpen(false); return; }
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') setOpen(false);
  });
})();
`;






const LAB_INIT_SCRIPT = `
(function(){
  try {
    var savedTheme = localStorage.getItem('niis-theme');
    var theme = savedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    var savedSound = localStorage.getItem('niis-sound');
    document.documentElement.setAttribute('data-sound', savedSound === 'off' ? 'off' : 'on');
  } catch (_e) {}
})();
`;

const LAB_TOPBAR_SCRIPT = `
(function(){
  document.addEventListener('submit', function(e){
    var message = e.target.getAttribute('data-niis-confirm');
    if (message && !window.confirm(message)) e.preventDefault();
  });
  document.addEventListener('change', function(e){
    if (!e.target.matches || !e.target.matches('[data-lab-mode-input]')) return;
    var input = e.target;
    var form = input.closest('form');
    if (!form || form.getAttribute('data-busy') === 'true') return;
    var hidden = form.querySelector('[data-lab-mode-value]');
    var label = form.querySelector('[data-lab-mode-label]');
    var nextMode = input.checked ? 'auto' : 'semi';
    if (hidden) hidden.value = nextMode;
    if (label) label.textContent = nextMode === 'auto' ? 'Auto' : 'Semi';
    form.setAttribute('data-busy', 'true');
    var fd = new FormData(form);
    var body = new URLSearchParams();
    fd.forEach(function(value, key){ body.append(key, value); });
    var rollback = function(){
      input.checked = !input.checked;
      var rollbackMode = input.checked ? 'auto' : 'semi';
      if (hidden) hidden.value = rollbackMode;
      if (label) label.textContent = input.checked ? 'Auto' : 'Semi';
    };
    fetch(form.getAttribute('action') || '/project/mode', {
      body: body,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    }).then(function(resp){
      var ok = resp.type === 'opaqueredirect' || (resp.status >= 200 && resp.status < 400);
      if (!ok) rollback();
    }).catch(function(){ rollback(); }).finally(function(){
      form.removeAttribute('data-busy');
    });
  });
  document.addEventListener('click', function(e){
    if (e.target.closest('[data-lab-theme-toggle]')) {
      var current = document.documentElement.getAttribute('data-theme') || 'light';
      var next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('niis-theme', next); } catch (_e) {}
      return;
    }
    if (e.target.closest('[data-lab-sound-toggle]')) {
      var current = document.documentElement.getAttribute('data-sound') || 'on';
      var next = current === 'on' ? 'off' : 'on';
      document.documentElement.setAttribute('data-sound', next);
      try { localStorage.setItem('niis-sound', next); } catch (_e) {}
      return;
    }
  });
})();
`;






const RUNTIME_OPTIONS_LIST = [
  { value: "", label: "Auto (let coordinator decide)" },
  { value: "codex_local", label: "codex_local" },
  { value: "claude_code_local", label: "claude_code_local" },
];

const AGENTS_PAGE_ICONS = {
  chevron_down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9v6"/><path d="M9 5h6"/><path d="M15 19H9"/><path d="M19 15V9"/><path d="M12 9v6"/><path d="M9 12h6"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 18-8-8 18-2-8z"/></svg>`,
};

function provenanceLabel(p) {
  if (p === "built-in") return "built-in";
  if (p === "local-markdown") return "local";
  if (p === "local") return "local";
  if (typeof p === "string" && p.startsWith("marketplace")) return "marketplace";
  return p ?? "—";
}

function rateColorAgentsPage(pct) {
  if (pct == null) return "#9ca3af";
  if (pct >= 90) return "#16a34a";
  if (pct >= 75) return "#eab308";
  return "#dc2626";
}

function renderAgentCard({ persona, manifest, override, perf, status }) {
  const enabled = override.enabled !== false;
  const provenance = manifest._provenance ?? "built-in";
  const description = manifest.description || "Specialized agent role.";

  const runs = perf?.runs ?? 0;
  const successPct = perf?.success_pct ?? null;
  const avgMin = perf?.avg_minutes ?? null;
  const totalCost = perf?.total_cost ?? 0;
  const successColor = rateColorAgentsPage(successPct);
  const primaryActionHtml = manifest.management_href
    ? `<a href="${escapeHtml(manifest.management_href)}" class="lab-agent-card-config-btn lab-agent-card-action-link">
        <span>${escapeHtml(manifest.management_label ?? "Open")}</span>
        <span class="lab-agent-card-config-chevron" aria-hidden="true">${AGENTS_PAGE_ICONS.chevron_down}</span>
      </a>`
    : "";
  const toggleHtml = manifest._system
      ? `<span class="lab-agent-toggle-locked" title="System role — cannot be disabled" aria-label="System role (locked)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </span>`
      : `<form method="post" action="/project/settings/role/${encodeURIComponent(manifest.id)}" class="lab-agent-toggle-form" data-lab-role-toggle-form>
              <input type="hidden" name="intent" value="enabled" />
              <input type="hidden" name="enabled" value="${enabled ? "1" : "0"}" data-lab-role-toggle-value />
              <label class="lab-agent-toggle-switch" title="${enabled ? "Disable" : "Enable"} ${escapeHtml(persona.name)}">
                <input type="checkbox" class="lab-agent-toggle-input" data-lab-role-toggle-input ${enabled ? "checked" : ""} aria-label="Toggle ${escapeHtml(persona.name)}" />
                <span class="lab-agent-toggle-track" aria-hidden="true"></span>
              </label>
            </form>`;

  return `
    <article class="lab-agent-card${enabled ? "" : " lab-agent-card-disabled"}" data-agent-status="${escapeHtml(status)}" data-agent-enabled="${enabled ? "true" : "false"}" data-agent-lane="${escapeHtml(manifest.lane ?? "")}" data-agent-runs="${escapeHtml(runs)}" data-agent-cost="${escapeHtml(totalCost)}" data-agent-success="${successPct ?? -1}" data-agent-name="${escapeHtml(persona.name.toLowerCase())} ${escapeHtml(persona.role.toLowerCase())} ${escapeHtml(manifest.id)}">
      <header class="lab-agent-card-head">
        <div class="lab-agent-card-identity">
          ${renderAvatar(persona, 56, { showDot: true, status })}
          <div class="lab-agent-card-name-block">
            <h3 class="lab-agent-card-name">${escapeHtml(persona.name)}</h3>
            <div class="lab-agent-card-meta">
              <span>${escapeHtml(persona.role)}</span>
              <span class="lab-agent-card-dot">·</span>
              <span class="lab-agent-card-provenance lab-agent-card-provenance-${provenance.startsWith("marketplace") ? "marketplace" : provenance}">${escapeHtml(provenanceLabel(provenance))}</span>
              ${manifest._system ? '<span class="lab-agent-card-system-badge" title="Required for niis to function — cannot be disabled">system</span>' : ""}
              ${!enabled ? '<span class="lab-agent-card-disabled-badge">disabled</span>' : ""}
            </div>
          </div>
        </div>
        ${toggleHtml}
      </header>

      <p class="lab-agent-card-description">${escapeHtml(description)}</p>

      <div class="lab-agent-card-stats">
        <div class="lab-agent-stat">
          <strong>${escapeHtml(runs)}</strong>
          <span>runs</span>
        </div>
        <div class="lab-agent-stat">
          <strong style="color: ${successColor};">${successPct != null ? successPct + "%" : "—"}</strong>
          <span title="${successPct == null ? "Need ≥5 runs for stable rate" : ""}">pass rate</span>
        </div>
        <div class="lab-agent-stat">
          <strong>${avgMin != null ? avgMin + "m" : "—"}</strong>
          <span>avg. duration</span>
        </div>
        <div class="lab-agent-stat">
          <strong>$${(typeof totalCost === "number" ? totalCost : 0).toFixed(2)}</strong>
          <span>spend</span>
        </div>
      </div>

      ${primaryActionHtml}

      <button type="button" class="lab-agent-card-config-btn" data-agent-config-open="${escapeHtml(manifest.id)}">
        <span>Configure</span>
        <span class="lab-agent-card-config-chevron" aria-hidden="true">${AGENTS_PAGE_ICONS.chevron_down}</span>
      </button>
    </article>`;
}





function renderAgentManifestSettings(settings) {
  if (!settings) return "";
  const hasRows = Array.isArray(settings.rows) && settings.rows.length > 0;
  const hasBody = typeof settings.body_html === "string" && settings.body_html.trim() !== "";
  if (!hasRows && !hasBody) return "";
  return `
            <section class="lab-agent-config-section">
              <h3 class="lab-agent-config-section-title">${escapeHtml(settings.title ?? "Agent runtime")}</h3>
              ${settings.hint ? `<p class="lab-agent-config-section-hint">${escapeHtml(settings.hint)}</p>` : ""}
              ${hasRows ? settings.rows.map((row) => {
                const value = row.code
                  ? `<code>${escapeHtml(row.value ?? "—")}</code>`
                  : `<strong>${escapeHtml(row.value ?? "—")}</strong>`;
                return `
              <div class="lab-agent-config-prop${row.tone ? ` lab-agent-config-prop-${escapeHtml(row.tone)}` : ""}">
                <span>${escapeHtml(row.label ?? "")}</span>
                ${value}
              </div>`;
              }).join("") : ""}
              ${hasBody ? settings.body_html : ""}
            </section>`;
}







function renderAgentConfigOverlay({ persona, manifest, override, perf }) {
  const enabled = override.enabled !== false;





  const runtimeDisabled = manifest.runtime_disabled === true;
  const showDisabledPill = !enabled || runtimeDisabled;
  const runtimeReason = typeof manifest.runtime_disabled_reason === "string" && manifest.runtime_disabled_reason.trim() !== ""
    ? manifest.runtime_disabled_reason.trim()
    : "Not operational";
  const disabledReason = !enabled ? "Disabled by operator" : (runtimeDisabled ? runtimeReason : "");
  const provenance = manifest._provenance ?? "built-in";
  const description = manifest.description || "Specialized agent role.";
  const modelRuntime = override.model_preference?.runtime ?? manifest.model_preference?.runtime ?? "";
  const modelName = override.model_preference?.model ?? manifest.model_preference?.model ?? "";
  const monthlyUsd = override.budget?.monthly_usd ?? manifest.budget?.monthly_usd ?? "";
  const perRunUsd = override.budget?.per_run_usd ?? manifest.budget?.per_run_usd ?? "";
  const runtimeOptions = RUNTIME_OPTIONS_LIST.map((o) => `
    <option value="${escapeHtml(o.value)}"${o.value === modelRuntime ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("");

  const runs = perf?.runs ?? 0;
  const successPct = perf?.success_pct ?? null;
  const avgMin = perf?.avg_minutes ?? null;



  const toolFamilies = Array.isArray(manifest.adapter_requirements?.toolFamilies)
    ? manifest.adapter_requirements.toolFamilies
    : [];



  const contractAllow = Array.isArray(manifest.context_contract?.allow)
    ? manifest.context_contract.allow
    : null;
  const operations = Array.isArray(manifest.adapter_requirements?.operations)
    ? manifest.adapter_requirements.operations
    : [];
  const keywords = Array.isArray(manifest.keywords) ? manifest.keywords.slice(0, 8) : [];
  const systemPromptText = typeof manifest.system_prompt === "string" && manifest.system_prompt.trim() !== ""
    ? manifest.system_prompt
    : `(no system prompt declared in manifest — defaults to runtime adapter's baseline)`;





  const successKind = successPct != null && successPct >= 90 ? "good" : successPct != null && successPct < 75 ? "bad" : "neutral";
  const floatingChips = [
    { pos: "tr", label: successPct != null ? `${successPct}% pass` : null, kind: successKind },
    { pos: "br", label: avgMin != null ? `${avgMin}m avg` : null, kind: "neutral" },
  ].filter((c) => c.label != null);

  return `
    <div class="lab-agent-config-overlay" data-agent-config="${escapeHtml(manifest.id)}" data-runtime-disabled="${runtimeDisabled ? "true" : "false"}" data-runtime-disabled-reason="${escapeHtml(runtimeDisabled ? runtimeReason : "")}" hidden aria-hidden="true">
      <div class="lab-agent-config-backdrop" data-agent-config-close></div>
      <form method="post" action="/project/settings/role/${encodeURIComponent(manifest.id)}" class="lab-agent-config-shell" data-agent-config-form role="dialog" aria-label="Configure ${escapeHtml(persona.name)}">
        <header class="lab-agent-config-head">
          <div class="lab-agent-config-head-spacer"></div>
          <div class="lab-agent-config-head-title-block">
            <input class="lab-agent-config-head-pixeltitle" name="persona_name" value="${escapeHtml(persona.name)}" maxlength="40" autocomplete="off" spellcheck="false" aria-label="Display name (click to edit)" title="Click to rename" />
            <div class="lab-agent-config-head-pixelsub">${escapeHtml(persona.role)}-agent <span class="lab-agent-config-head-version">v${escapeHtml(manifest.version ?? "0.1.0")}</span></div>
          </div>
          <div class="lab-agent-config-head-spacer lab-agent-config-head-spacer-right">
            <button type="button" class="lab-agent-config-tool-circle" data-lab-theme-toggle aria-label="Toggle theme" title="Light / dark theme">
              <span class="lab-topbar-icon-btn-light" aria-hidden="true">${THEME_SUN_SVG}</span>
              <span class="lab-topbar-icon-btn-dark" aria-hidden="true">${THEME_MOON_SVG}</span>
            </button>
            <button type="button" class="lab-agent-config-head-pill" title="Close" data-agent-config-close>
              ${MARKETPLACE_ICONS.close}
            </button>
          </div>
        </header>

        <div class="lab-agent-config-stage" style="--lab-agent-bg: url('${escapeHtml(persona.avatar)}');${persona.bg ? ` --lab-agent-bg-color: ${escapeHtml(persona.bg)};` : ""}${persona.bg_dark ? ` --lab-agent-bg-color-dark: ${escapeHtml(persona.bg_dark)};` : ""}">
          <span class="lab-agent-config-blob-mask lab-agent-config-blob-mask-left" aria-hidden="true"><span class="lab-agent-config-blob"></span></span>
          <span class="lab-agent-config-blob-mask lab-agent-config-blob-mask-right" aria-hidden="true"><span class="lab-agent-config-blob"></span></span>
          <aside class="lab-agent-config-side lab-agent-config-side-left">
            <section class="lab-agent-config-section">
              <h3 class="lab-agent-config-section-title">Identity</h3>
              <div class="lab-agent-config-prop">
                <span>Role id</span>
                <code>${escapeHtml(manifest.id)}</code>
              </div>
              <div class="lab-agent-config-prop">
                <span>Lane</span>
                <strong>${escapeHtml(manifest.lane ?? "—")}</strong>
              </div>
              <div class="lab-agent-config-prop">
                <span>Provenance</span>
                <span class="lab-agent-card-provenance lab-agent-card-provenance-${provenance.startsWith("marketplace") ? "marketplace" : provenance}">${escapeHtml(provenance)}</span>
              </div>
              ${manifest._system ? `
              <div class="lab-agent-config-prop">
                <span>Role kind</span>
                <span class="lab-agent-card-system-badge" title="Required for niis to function — cannot be disabled or removed">system</span>
              </div>` : ""}
            </section>

            <section class="lab-agent-config-section">
              <h3 class="lab-agent-config-section-title">Runtime</h3>
              <div class="lab-agent-config-field">
                <label for="cfg-runtime-${escapeHtml(manifest.id)}">Adapter</label>
                <div class="lab-agent-config-select">
                  <select id="cfg-runtime-${escapeHtml(manifest.id)}" name="model_runtime">${runtimeOptions}</select>
                  <span class="lab-agent-config-select-chevron" aria-hidden="true">${AGENTS_PAGE_ICONS.chevron_down}</span>
                </div>
              </div>
              <div class="lab-agent-config-field">
                <label for="cfg-model-${escapeHtml(manifest.id)}">Model</label>
                <input id="cfg-model-${escapeHtml(manifest.id)}" type="text" name="model_name" value="${escapeHtml(String(modelName))}" placeholder="(default for runtime)" />
              </div>
            </section>

            <section class="lab-agent-config-section">
              <h3 class="lab-agent-config-section-title">Budget</h3>
              <div class="lab-agent-config-row">
                <div class="lab-agent-config-field">
                  <label for="cfg-monthly-${escapeHtml(manifest.id)}">Monthly $</label>
                  <input id="cfg-monthly-${escapeHtml(manifest.id)}" type="number" min="0" step="0.01" name="budget_monthly_usd" value="${escapeHtml(String(monthlyUsd))}" placeholder="—" />
                </div>
                <div class="lab-agent-config-field">
                  <label for="cfg-perrun-${escapeHtml(manifest.id)}">Per-run $</label>
                  <input id="cfg-perrun-${escapeHtml(manifest.id)}" type="number" min="0" step="0.01" name="budget_per_run_usd" value="${escapeHtml(String(perRunUsd))}" placeholder="—" />
                </div>
              </div>
            </section>
          </aside>

          <aside class="lab-agent-config-side lab-agent-config-side-right">
            <section class="lab-agent-config-section">
              <h3 class="lab-agent-config-section-title">Capabilities</h3>
              <p class="lab-agent-config-section-hint">Tool families this role can request.</p>
              <div class="lab-agent-config-chips">
                ${toolFamilies.length === 0
                  ? '<span class="lab-agent-config-chip-empty">none declared</span>'
                  : toolFamilies.map((f) => `<span class="lab-agent-config-chip">${escapeHtml(f)}</span>`).join("")}
              </div>
            </section>

            <section class="lab-agent-config-section">
              <h3 class="lab-agent-config-section-title">Operations</h3>
              <div class="lab-agent-config-chips">
                ${operations.length === 0
                  ? '<span class="lab-agent-config-chip-empty">none</span>'
                  : operations.map((op) => `<span class="lab-agent-config-chip lab-agent-config-chip-soft">${escapeHtml(op)}</span>`).join("")}
              </div>
            </section>

            <section class="lab-agent-config-section">
              <h3 class="lab-agent-config-section-title">Context contract</h3>
              <p class="lab-agent-config-section-hint">Prompt context sources this role is allowed to see; everything else is denied.</p>
              <div class="lab-agent-config-chips">
                ${contractAllow === null
                  ? '<span class="lab-agent-config-chip-empty">no contract — all default sources</span>'
                  : contractAllow.length === 0
                    ? '<span class="lab-agent-config-chip-empty">deny all (task spec only)</span>'
                    : contractAllow.map((s) => `<span class="lab-agent-config-chip">${escapeHtml(s)}</span>`).join("")}
              </div>
            </section>

            <section class="lab-agent-config-section">
              <h3 class="lab-agent-config-section-title">Routing keywords</h3>
              <p class="lab-agent-config-section-hint">Coordinator picks this role when task content matches.</p>
              <div class="lab-agent-config-chips">
                ${keywords.length === 0
                  ? '<span class="lab-agent-config-chip-empty">none</span>'
                  : keywords.map((k) => `<span class="lab-agent-config-chip lab-agent-config-chip-soft">${escapeHtml(k)}</span>`).join("")}
              </div>
            </section>
            ${renderAgentManifestSettings(manifest.agent_settings)}
          </aside>

          <div class="lab-agent-config-floating" aria-hidden="true">
            ${floatingChips.map((chip) => `
              <span class="lab-agent-config-floating-chip lab-agent-config-floating-chip-${chip.pos} lab-agent-config-floating-chip-${chip.kind}">
                <span class="lab-agent-config-floating-pin">${AGENTS_PAGE_ICONS.pin}</span>
                <span class="lab-agent-config-floating-label">${escapeHtml(chip.label)}</span>
              </span>`).join("")}
            ${showDisabledPill ? `<span class="lab-agent-config-floating-disabled" data-lab-disabled-pill><span>disabled</span>${disabledReason ? `<small data-lab-disabled-reason>${escapeHtml(disabledReason)}</small>` : ""}</span>` : '<span class="lab-agent-config-floating-disabled" data-lab-disabled-pill hidden><span>disabled</span><small data-lab-disabled-reason></small></span>'}
          </div>

          <div class="lab-agent-config-prompt-card">
            <div class="lab-agent-config-prompt-meta">
              <div class="lab-agent-config-prompt-head">
                <strong>System prompt</strong>
                <span>${escapeHtml(persona.name)} · <code>${escapeHtml(manifest.id)}</code> · read-only</span>
              </div>
              <p class="lab-agent-config-prompt-desc">${escapeHtml(description)}</p>
            </div>
            <div class="lab-agent-config-prompt-input">
              <textarea class="lab-agent-config-prompt" readonly rows="2">${escapeHtml(systemPromptText)}</textarea>
              <span class="lab-agent-config-prompt-send" aria-hidden="true">${AGENTS_PAGE_ICONS.send}</span>
            </div>
            <div class="lab-agent-config-prompt-tabs">
              <span class="lab-agent-config-prompt-tab"><span class="lab-agent-config-prompt-dot lab-agent-config-prompt-dot-good"></span>${runs} runs</span>
              <span class="lab-agent-config-prompt-tab"><span class="lab-agent-config-prompt-dot ${successPct != null && successPct >= 75 ? "lab-agent-config-prompt-dot-good" : "lab-agent-config-prompt-dot-bad"}"></span>${successPct != null ? successPct + "% pass" : "no rate"}</span>
            </div>
          </div>
        </div>
      </form>
    </div>`;
}

function renderAddAgentCard() {
  return `
    <button type="button" class="lab-agent-card lab-agent-card-add" data-marketplace-open aria-label="Browse agent marketplace">
      <span class="lab-agent-card-add-icon">${AGENTS_PAGE_ICONS.plus}</span>
      <span class="lab-agent-card-add-title">Add agent</span>
      <span class="lab-agent-card-add-sub">Browse the marketplace</span>
    </button>`;
}

function renderManageAgentsDocument(data) {
  const {
    scriptNonce = null,
    workerMode = "semi",
    agentStatusMap = {},
    performance = {},
    personaOrder = [],
    rolesByPersonaId = {},
    personasByPersonaId = {},
    overrides = {},
    snapshotRunsTotal = 0,
    runsLast7d = 0,
    successLast7d = null,
    spentThisMonth = 0,
    spentLastMonth = 0,
  } = data;
  const nonceAttribute = scriptNonce ? ` nonce="${escapeHtml(scriptNonce)}"` : "";


  const cards = [];
  const overlays = [];
  for (const personaId of personaOrder) {
    const manifest = rolesByPersonaId[personaId];
    if (!manifest) continue;
    const persona = personasByPersonaId[personaId];
    if (!persona) continue;
    const override = overrides[manifest.id] ?? {};
    const perf = performance[personaId] ?? null;
    const status = agentStatusMap[personaId] ?? "idle";
    cards.push(renderAgentCard({ persona, manifest, override, perf, status }));
    overlays.push(renderAgentConfigOverlay({ persona, manifest, override, perf, status }));
  }

  const workingCount = personaOrder.filter((personaId) => agentStatusMap[personaId] === "active").length;



  const ratedPerf = Object.values(performance).filter((p) => p && p.success_pct != null);
  const aggSuccess = successLast7d != null
    ? successLast7d
    : (ratedPerf.length > 0
        ? Math.round(ratedPerf.reduce((s, p) => s + p.success_pct, 0) / ratedPerf.length)
        : null);


  const spendDeltaPct = (spentLastMonth > 0)
    ? Math.round(((spentThisMonth - spentLastMonth) / spentLastMonth) * 100)
    : null;
  const spendDeltaText = spendDeltaPct != null
    ? `${spendDeltaPct >= 0 ? "+" : ""}${spendDeltaPct}% vs last`
    : "this month";
  const spendDeltaClass = spendDeltaPct == null
    ? ""
    : spendDeltaPct > 0
      ? " lab-agents-stat-sub-up"
      : spendDeltaPct < 0 ? " lab-agents-stat-sub-down" : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Niis — Manage Agents</title>
    <script${nonceAttribute}>${LAB_INIT_SCRIPT}</script>
    <link rel="stylesheet" href="/__niis/assets/lab.css" />
  </head>
  <body class="lab-body">
    ${renderTopbar({ workerMode, breadcrumb: "agents", activeRoute: "agents" })}
    <main class="lab-main lab-main-agents">
      <header class="lab-agents-header">
        <div>
          <h1 class="lab-agents-title">Manage Agents</h1>
          <p class="lab-agents-subtitle">Configure your team — model, budget, and provenance per role.</p>
        </div>
        <button type="button" class="lab-agents-cta" data-marketplace-open>
          <span>Browse marketplace</span>
          <span class="lab-agents-cta-icon">${AGENTS_PAGE_ICONS.plus}</span>
        </button>
      </header>

      <section class="lab-agents-stats">
        <div class="lab-agents-stat-tile">
          <div class="lab-agents-stat-row">
            <span class="lab-agents-stat-num">${escapeHtml(cards.length)}</span>
            <span class="lab-agents-stat-label">agents</span>
          </div>
          <span class="lab-agents-stat-sub">total</span>
        </div>
        <div class="lab-agents-stat-tile">
          <div class="lab-agents-stat-row">
            <span class="lab-agents-stat-num">${escapeHtml(workingCount)}</span>
            <span class="lab-agents-stat-label"><span class="lab-agents-stat-dot"></span>working</span>
          </div>
          <span class="lab-agents-stat-sub">active now</span>
        </div>
        <div class="lab-agents-stat-tile">
          <div class="lab-agents-stat-row">
            <span class="lab-agents-stat-num">$${(typeof spentThisMonth === "number" ? spentThisMonth : 0).toFixed(2)}</span>
            <span class="lab-agents-stat-label">spent</span>
          </div>
          <span class="lab-agents-stat-sub${spendDeltaClass}" title="Previous month: $${(typeof spentLastMonth === "number" ? spentLastMonth : 0).toFixed(2)}">${escapeHtml(spendDeltaText)}</span>
        </div>
        <div class="lab-agents-stat-tile">
          <div class="lab-agents-stat-row">
            <span class="lab-agents-stat-num">${escapeHtml(runsLast7d)}</span>
            <span class="lab-agents-stat-label">runs</span>
          </div>
          <span class="lab-agents-stat-sub" title="${escapeHtml(snapshotRunsTotal)} all-time">last 7d</span>
        </div>
        <div class="lab-agents-stat-tile">
          <div class="lab-agents-stat-row">
            <span class="lab-agents-stat-num">${aggSuccess != null ? aggSuccess + "%" : "—"}</span>
            <span class="lab-agents-stat-label">success</span>
          </div>
          <span class="lab-agents-stat-sub">last 7d</span>
        </div>
      </section>

      <section class="lab-agents-filters">
        <div class="lab-agents-filter-pills" role="tablist" aria-label="Filter by status">
          <button type="button" class="lab-agents-filter-pill lab-agents-filter-pill-active" data-lab-agents-filter="all">All</button>
          <button type="button" class="lab-agents-filter-pill" data-lab-agents-filter="working">Working</button>
          <button type="button" class="lab-agents-filter-pill" data-lab-agents-filter="disabled">Disabled</button>
        </div>
        <div class="lab-agents-filter-right">
          <div class="lab-agents-filter-select">
            <select aria-label="Filter by lane" data-lab-agents-lane>
              <option value="">Lane: All</option>
              <option value="coordinator">Coordinator</option>
              <option value="planner">Planner</option>
              <option value="generalist">Generalist</option>
              <option value="frontend">Frontend</option>
              <option value="nodejs">Node Backend</option>
              <option value="python">Python Backend</option>
              <option value="ingestion">Ingestion</option>
              <option value="validator">Validator</option>
            </select>
            <span class="lab-agents-filter-select-chevron" aria-hidden="true">${AGENTS_PAGE_ICONS.chevron_down}</span>
          </div>
          <div class="lab-agents-filter-select">
            <select aria-label="Sort" data-lab-agents-sort>
              <option value="active">Sort: Most active</option>
              <option value="cost">Sort: Cost</option>
              <option value="success">Sort: Success rate</option>
              <option value="name">Sort: Name</option>
            </select>
            <span class="lab-agents-filter-select-chevron" aria-hidden="true">${AGENTS_PAGE_ICONS.chevron_down}</span>
          </div>
          <div class="lab-agents-filter-search">
            <span class="lab-agents-filter-search-icon">${AGENTS_PAGE_ICONS.search}</span>
            <input type="text" placeholder="Search agents..." data-lab-agents-search aria-label="Search agents" />
          </div>
        </div>
      </section>

      <section class="lab-agents-grid" data-lab-agents-grid data-filter="all">
        ${cards.join("")}
        ${renderAddAgentCard()}
      </section>
    </main>
    ${renderMarketplaceModal()}
    ${overlays.join("")}
    <script${nonceAttribute}>${MARKETPLACE_SCRIPT}</script>
    <script${nonceAttribute}>${LAB_TOPBAR_SCRIPT}</script>
    <script${nonceAttribute}>${AGENTS_PAGE_SCRIPT}</script>
  </body>
</html>`;
}

const AGENTS_PAGE_SCRIPT = `
(function(){
  function applyFilters(){
    var grid = document.querySelector('[data-lab-agents-grid]');
    if (!grid) return;
    var activeFilter = grid.getAttribute('data-filter') || 'all';
    var lane = (grid.getAttribute('data-lane') || '').trim();
    var sortKey = (grid.getAttribute('data-sort') || 'active');
    var query = (grid.getAttribute('data-search') || '').trim().toLowerCase();
    var cards = Array.from(grid.querySelectorAll('.lab-agent-card:not(.lab-agent-card-add)'));
    var addCard = grid.querySelector('.lab-agent-card-add');

    cards.forEach(function(card){
      var status = card.getAttribute('data-agent-status') || '';
      var enabled = card.getAttribute('data-agent-enabled') === 'true';
      var cardLane = (card.getAttribute('data-agent-lane') || '').toLowerCase();
      var name = card.getAttribute('data-agent-name') || '';
      var statusOk = activeFilter === 'all'
        || (activeFilter === 'working' && status === 'active')
        || (activeFilter === 'disabled' && !enabled);
      var laneOk = lane === '' || cardLane === lane;
      var queryOk = query === '' || name.indexOf(query) !== -1;
      card.style.display = (statusOk && laneOk && queryOk) ? '' : 'none';
    });

    var visible = cards.filter(function(c){ return c.style.display !== 'none'; });
    visible.sort(function(a, b){
      if (sortKey === 'cost') {
        return parseFloat(b.getAttribute('data-agent-cost') || 0) - parseFloat(a.getAttribute('data-agent-cost') || 0);
      }
      if (sortKey === 'success') {
        return parseFloat(b.getAttribute('data-agent-success') || -1) - parseFloat(a.getAttribute('data-agent-success') || -1);
      }
      if (sortKey === 'name') {
        return (a.getAttribute('data-agent-name') || '').localeCompare(b.getAttribute('data-agent-name') || '');
      }
      var ra = parseInt(a.getAttribute('data-agent-runs') || 0, 10);
      var rb = parseInt(b.getAttribute('data-agent-runs') || 0, 10);
      if (rb !== ra) return rb - ra;
      var sa = a.getAttribute('data-agent-status') === 'active' ? 0 : 1;
      var sb = b.getAttribute('data-agent-status') === 'active' ? 0 : 1;
      return sa - sb;
    });
    visible.forEach(function(c){ grid.appendChild(c); });
    if (addCard) grid.appendChild(addCard);
  }
  document.addEventListener('click', function(e){
    var pill = e.target.closest('[data-lab-agents-filter]');
    if (!pill) return;
    var grid = document.querySelector('[data-lab-agents-grid]');
    if (!grid) return;
    document.querySelectorAll('[data-lab-agents-filter]').forEach(function(p){ p.classList.remove('lab-agents-filter-pill-active'); });
    pill.classList.add('lab-agents-filter-pill-active');
    grid.setAttribute('data-filter', pill.getAttribute('data-lab-agents-filter'));
    applyFilters();
  });
  document.addEventListener('input', function(e){
    if (!e.target.matches || !e.target.matches('[data-lab-agents-search]')) return;
    var grid = document.querySelector('[data-lab-agents-grid]');
    if (!grid) return;
    grid.setAttribute('data-search', e.target.value);
    applyFilters();
  });
  document.addEventListener('change', function(e){
    var grid = document.querySelector('[data-lab-agents-grid]');
    if (!grid) return;
    if (e.target.matches && e.target.matches('[data-lab-agents-lane]')) {
      grid.setAttribute('data-lane', e.target.value);
      applyFilters();
    } else if (e.target.matches && e.target.matches('[data-lab-agents-sort]')) {
      grid.setAttribute('data-sort', e.target.value);
      applyFilters();
    }
  });
  applyFilters();

  function setOverlayOpen(roleId, open){
    var el = roleId ? document.querySelector('[data-agent-config=\"' + roleId + '\"]') : null;
    if (!open) {
      document.querySelectorAll('.lab-agent-config-overlay').forEach(function(o){
        o.hidden = true;
        o.setAttribute('aria-hidden', 'true');
      });
      document.body.classList.remove('lab-task-form-locked');
      return;
    }
    if (!el) return;
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lab-task-form-locked');
  }
  document.addEventListener('click', function(e){
    var opener = e.target.closest('[data-agent-config-open]');
    if (opener) { e.preventDefault(); setOverlayOpen(opener.getAttribute('data-agent-config-open'), true); return; }
    if (e.target.closest('[data-agent-config-close]')) { e.preventDefault(); setOverlayOpen(null, false); return; }
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') setOverlayOpen(null, false);
  });
  var configSaveTimers = new WeakMap();
  function scheduleConfigSave(form){
    var prev = configSaveTimers.get(form);
    if (prev) clearTimeout(prev);
    configSaveTimers.set(form, setTimeout(function(){ submitConfigForm(form); }, 400));
  }
  function syncAgentCardFromForm(form){
    var action = form.getAttribute('action') || '';
    var m = action.match(/role\\/([^\\/?#]+)/);
    if (!m) return;
    var roleId = decodeURIComponent(m[1]);
    var opener = document.querySelector('[data-agent-config-open="' + roleId + '"]');
    var card = opener ? opener.closest('.lab-agent-card') : null;
    if (!card) return;
    var nameInput = form.querySelector('[name="persona_name"]');
    if (nameInput) {
      var newName = nameInput.value.trim() || roleId;
      var nameEl = card.querySelector('.lab-agent-card-name');
      if (nameEl && nameEl.textContent !== newName) nameEl.textContent = newName;
      var roleLabelEl = card.querySelector('.lab-agent-card-meta > span');
      var roleLabel = roleLabelEl ? roleLabelEl.textContent.trim() : '';
      card.setAttribute('data-agent-name', (newName + ' ' + roleLabel + ' ' + roleId).toLowerCase());
    }
  }
  function submitConfigForm(form){
    if (form.getAttribute('data-busy') === 'true') {
      scheduleConfigSave(form);
      return;
    }
    form.setAttribute('data-busy', 'true');
    form.setAttribute('data-save-state', 'saving');
    var fd = new FormData(form);
    var body = new URLSearchParams();
    fd.forEach(function(v, k){ body.append(k, v); });
    fetch(form.getAttribute('action'), {
      body: body, method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }).then(function(resp){
      var ok = resp.type === 'opaqueredirect' || (resp.status >= 200 && resp.status < 400);
      form.setAttribute('data-save-state', ok ? 'saved' : 'error');
      if (ok) syncAgentCardFromForm(form);
      if (!ok) form.removeAttribute('data-busy');
      else setTimeout(function(){ form.removeAttribute('data-busy'); form.removeAttribute('data-save-state'); }, 600);
    }).catch(function(){
      form.setAttribute('data-save-state', 'error');
      form.removeAttribute('data-busy');
    });
  }
  function handleConfigFieldEvent(e){
    var form = e.target.closest('[data-agent-config-form]');
    if (!form) return;
    if (!e.target.matches('input, select, textarea')) return;
    scheduleConfigSave(form);
  }
  document.addEventListener('input', handleConfigFieldEvent);
  document.addEventListener('change', handleConfigFieldEvent);
  document.addEventListener('submit', function(e){
    if (e.target.closest('[data-agent-config-form]')) e.preventDefault();
  });
  function labStatusDotColor(status){
    if (status === 'active') return '#10b981';
    if (status === 'idle') return '#fbbf24';
    if (status === 'disabled') return '#dc2626';
    return '#9ca3af';
  }
  function labStatusLabel(status){
    if (status === 'active') return 'working';
    if (status === 'idle') return 'idle';
    if (status === 'disabled') return 'disabled';
    return 'offline';
  }
  function applyAgentStatus(agentId, status){
    var color = labStatusDotColor(status);
    var label = labStatusLabel(status);
    var avatars = document.querySelectorAll('[data-lab-agent-id="' + agentId + '"]');
    avatars.forEach(function(avatar){
      var hb = avatar.querySelector('.lab-avatar-heartbeat');
      if (!hb) return;
      hb.style.background = color;
      hb.setAttribute('title', label);
      hb.classList.toggle('lab-avatar-heartbeat-active', status === 'active');
    });
    var rosterItem = avatars[0] ? avatars[0].closest('.lab-roster-item') : null;
    if (rosterItem) {
      var rosterName = rosterItem.querySelector('.lab-roster-name');
      var rosterRole = rosterItem.querySelector('.lab-roster-role');
      var name = rosterName ? rosterName.textContent.trim() : '';
      var role = rosterRole ? rosterRole.textContent.trim() : '';
      rosterItem.setAttribute('title', name + ' — ' + role + ' (' + label + ')');
    }
  }
  function updateOverlayDisabledPill(overlay, nextEnabled){
    if (!overlay) return;
    var pill = overlay.querySelector('[data-lab-disabled-pill]');
    if (!pill) return;
    var runtimeDisabled = overlay.getAttribute('data-runtime-disabled') === 'true';
    var runtimeReason = overlay.getAttribute('data-runtime-disabled-reason') || 'Not operational';
    var show = !nextEnabled || runtimeDisabled;
    var reasonText = !nextEnabled ? 'Disabled by operator' : (runtimeDisabled ? runtimeReason : '');
    if (show) {
      pill.removeAttribute('hidden');
      var reasonEl = pill.querySelector('[data-lab-disabled-reason]');
      if (reasonEl) reasonEl.textContent = reasonText;
    } else {
      pill.setAttribute('hidden', '');
    }
  }
  document.addEventListener('change', function(e){
    if (!e.target.matches || !e.target.matches('[data-lab-role-toggle-input]')) return;
    var input = e.target;
    var form = input.closest('form');
    if (!form || form.getAttribute('data-busy') === 'true') return;
    var card = form.closest('.lab-agent-card');
    var hidden = form.querySelector('[data-lab-role-toggle-value]');
    var nextEnabled = input.checked;
    if (hidden) hidden.value = nextEnabled ? '1' : '0';
    form.setAttribute('data-busy', 'true');
    var fd = new FormData(form);
    var body = new URLSearchParams();
    fd.forEach(function(v, k){ body.append(k, v); });
    var rollback = function(){
      input.checked = !input.checked;
      if (hidden) hidden.value = input.checked ? '1' : '0';
    };
    fetch(form.getAttribute('action'), {
      body: body, method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }).then(function(resp){
      var ok = resp.type === 'opaqueredirect' || (resp.status >= 200 && resp.status < 400);
      if (!ok) { rollback(); return; }
      if (card) {
        card.classList.toggle('lab-agent-card-disabled', !nextEnabled);
        card.setAttribute('data-agent-enabled', nextEnabled ? 'true' : 'false');
        var badge = card.querySelector('.lab-agent-card-disabled-badge');
        if (nextEnabled && badge) badge.remove();
        if (!nextEnabled && !badge) {
          var meta = card.querySelector('.lab-agent-card-meta');
          if (meta) meta.insertAdjacentHTML('beforeend', '<span class="lab-agent-card-disabled-badge">disabled</span>');
        }
      }
      var roleId = (form.getAttribute('action') || '').split('/').pop();
      try { roleId = decodeURIComponent(roleId); } catch (err) {}
      var overlay = roleId ? document.querySelector('[data-agent-config="' + roleId + '"]') : null;
      updateOverlayDisabledPill(overlay, nextEnabled);
      var cardAvatar = card ? card.querySelector('[data-lab-agent-id]') : null;
      var personaId = cardAvatar ? cardAvatar.getAttribute('data-lab-agent-id') : roleId;
      var runtimeDisabled = overlay && overlay.getAttribute('data-runtime-disabled') === 'true';
      var nextStatus = (!nextEnabled || runtimeDisabled) ? 'disabled' : 'idle';
      if (personaId) applyAgentStatus(personaId, nextStatus);
      applyFilters();
    }).catch(function(){ rollback(); }).finally(function(){
      form.removeAttribute('data-busy');
    });
  });
})();
`;

function renderLabDocument(data) {
  const { agentStatusMap, tasks, performance, goals, activity, scriptNonce = null, workerMode = "semi", taskTemplates = [] } = data;
  const nonceAttribute = scriptNonce ? ` nonce="${escapeHtml(scriptNonce)}"` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Niis Pipeline — Agent Task Flow</title>
    <script${nonceAttribute}>${LAB_INIT_SCRIPT}</script>
    <link rel="stylesheet" href="/__niis/assets/lab.css" />
  </head>
  <body class="lab-body">
    ${renderTopbar({ workerMode, breadcrumb: "pipeline", activeRoute: "pipeline" })}
    <main class="lab-main">
      ${renderRoster({ agentStatusMap })}
      ${renderKanban({ tasks, agentStatusMap })}
      <div class="lab-bottom">
        ${renderPerformance({ performance, agentStatusMap })}
        ${renderGoals({ goals, agentStatusMap })}
        ${renderActivity({ activity, agentStatusMap })}
      </div>
    </main>
    ${renderAddTaskSidebar({ taskTemplates })}
    ${renderMarketplaceModal()}
    <script${nonceAttribute}>${ADD_TASK_SCRIPT}</script>
    <script${nonceAttribute}>${MARKETPLACE_SCRIPT}</script>
    <script${nonceAttribute}>${LAB_TOPBAR_SCRIPT}</script>
  </body>
</html>`;
}








function effectivePersona(manifest) {
  const personaId = ROLE_TO_PERSONA[manifest.id];
  const fallback = LAB_AGENTS.find((a) => a.id === personaId);
  if (!fallback && !manifest.persona) return null;
  return {
    id: personaId ?? manifest.id,
    name: manifest.persona?.name ?? fallback?.name ?? manifest.id,
    avatar: manifest.persona?.avatar_url ?? fallback?.avatar ?? "",
    accent: manifest.persona?.accent ?? fallback?.accent ?? "#6b7280",
    bg: manifest.persona?.bg ?? fallback?.bg ?? null,
    bg_dark: manifest.persona?.bg_dark ?? fallback?.bg_dark ?? null,
    role: manifest.role_label ?? fallback?.role ?? manifest.id,
    role_id: manifest.id,
  };
}

function buildManageAgentsPageData({
  manifests = [],
  overrides = {},
  performance = {},
  agentStatusMap = {},
  workerMode = "semi",
  snapshotRunsTotal = 0,
  spentThisMonth = 0,
  spentLastMonth = 0,
  runsLast7d = 0,
  successLast7d = null,
}) {
  const rolesByPersonaId = {};
  const personasByPersonaId = {};
  const personaOrder = [];
  for (const manifest of manifests) {
    const persona = effectivePersona(manifest);
    if (!persona) continue;
    rolesByPersonaId[persona.id] = manifest;
    personasByPersonaId[persona.id] = persona;
  }
  const seen = new Set();
  for (const builtIn of LAB_AGENTS) {
    if (rolesByPersonaId[builtIn.id]) {
      personaOrder.push(builtIn.id);
      seen.add(builtIn.id);
    }
  }
  for (const personaId of Object.keys(personasByPersonaId).sort()) {
    if (!seen.has(personaId)) {
      personaOrder.push(personaId);
      seen.add(personaId);
    }
  }
  return {
    rolesByPersonaId,
    personasByPersonaId,
    personaOrder,
    overrides,
    performance,
    agentStatusMap,
    workerMode,
    snapshotRunsTotal,
    runsLast7d,
    successLast7d,
    spentThisMonth,
    spentLastMonth,
  };
}








const PROJECT_GOAL_STATUS_COLORS = {
  achieved: "#16a34a",
  active: "#5b8def",
  abandoned: "#9ca3af",
  planned: "#a855f7",
};

function formatCostUsd(usd) {
  if (typeof usd !== "number" || usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function renderProjectBanner({ notice, error }) {
  if (!notice && !error) return "";
  const cls = error ? "lab-project-banner lab-project-banner-error" : "lab-project-banner lab-project-banner-notice";
  const text = error ?? notice;
  return `<div class="${cls}">${escapeHtml(text)}</div>`;
}















const SERVICE_NODE_ICONS = {
  artifacts: '<svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true" fill="none"><path d="M3 7.8C3 6.6799 3 6.11984 3.21799 5.69202C3.40973 5.31569 3.71569 5.00973 4.09202 4.81799C4.51984 4.6 5.0799 4.6 6.2 4.6H8.6738C9.16357 4.6 9.40846 4.6 9.63896 4.6554C9.84337 4.70453 10.0386 4.78539 10.2168 4.896C10.4178 5.02079 10.591 5.19401 10.9374 5.54044L12.0596 6.66256C12.406 7.00899 12.5792 7.18221 12.7802 7.307C12.9584 7.41761 13.1536 7.49847 13.358 7.5476C13.5885 7.603 13.8334 7.603 14.3232 7.603H17.8C18.9201 7.603 19.4802 7.603 19.908 7.82099C20.2843 8.01273 20.5903 8.31869 20.782 8.69502C21 9.12284 21 9.6829 21 10.803V16.8C21 17.9201 21 18.4802 20.782 18.908C20.5903 19.2843 20.2843 19.5903 19.908 19.782C19.4802 20 18.9201 20 17.8 20H6.2C5.0799 20 4.51984 20 4.09202 19.782C3.71569 19.5903 3.40973 19.2843 3.21799 18.908C3 18.4802 3 17.9201 3 16.8V7.8Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  binding: '<svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true" fill="none"><path d="M10 13C10.4305 13.5741 10.9791 14.0491 11.6091 14.3931C12.2391 14.7372 12.936 14.9423 13.6529 14.9947C14.3698 15.0471 15.0902 14.9457 15.7655 14.6971C16.4408 14.4486 17.0552 14.0588 17.5667 13.5556L20.5667 10.5556C21.4775 9.61251 21.9815 8.34937 21.9701 7.03822C21.9587 5.72707 21.4329 4.47278 20.5058 3.54567C19.5787 2.61856 18.3244 2.09279 17.0132 2.0814C15.7021 2.07001 14.4389 2.57397 13.4959 3.48477L11.7759 5.19477M14 11C13.5695 10.4259 13.0209 9.95088 12.3909 9.60687C11.7609 9.26286 11.064 9.05767 10.3471 9.0053C9.63022 8.95293 8.90981 9.0543 8.23452 9.30285C7.55922 9.5514 6.94481 9.94119 6.43333 10.4444L3.43333 13.4444C2.5225 14.3875 2.01855 15.6506 2.02994 16.9618C2.04133 18.2729 2.5671 19.5272 3.49421 20.4543C4.42132 21.3814 5.67561 21.9072 6.98676 21.9186C8.29791 21.93 9.56105 21.426 10.5041 20.5152L12.2141 18.8052" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  database: '<svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true"><path d="M14 20C14 21.1046 13.1046 22 12 22C10.8954 22 10 21.1046 10 20M14 20C14 18.8954 13.1046 18 12 18M14 20H21M10 20C10 18.8954 10.8954 18 12 18M10 20H3M12 18V14M21 5C21 6.65685 16.9706 8 12 8C7.02944 8 3 6.65685 3 5M21 5C21 3.34315 16.9706 2 12 2C7.02944 2 3 3.34315 3 5M21 5V11C21 12.66 17 14 12 14M3 5V11C3 12.66 7 14 12 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  backups: '<svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true"><path d="M20.5 7.27783L12 12.0001M12 12.0001L3.49997 7.27783M12 12.0001L12 21.5001M21 16.0586V7.94153C21 7.59889 21 7.42757 20.9495 7.27477C20.9049 7.13959 20.8318 7.01551 20.7354 6.91082C20.6263 6.79248 20.4766 6.70928 20.177 6.54288L12.777 2.43177C12.4934 2.27421 12.3516 2.19543 12.2015 2.16454C12.0685 2.13721 11.9315 2.13721 11.7986 2.16454C11.6484 2.19543 11.5066 2.27421 11.223 2.43177L3.82297 6.54288C3.52345 6.70928 3.37369 6.79248 3.26463 6.91082C3.16816 7.01551 3.09515 7.13959 3.05048 7.27477C3 7.42757 3 7.59889 3 7.94153V16.0586C3 16.4013 3 16.5726 3.05048 16.7254C3.09515 16.8606 3.16816 16.9847 3.26463 17.0893C3.37369 17.2077 3.52345 17.2909 3.82297 17.4573L11.223 21.5684C11.5066 21.726 11.6484 21.8047 11.7986 21.8356C11.9315 21.863 12.0685 21.863 12.2015 21.8356C12.3516 21.8047 12.4934 21.726 12.777 21.5684L20.177 17.4573C20.4766 17.2909 20.6263 17.2077 20.7354 17.0893C20.8318 16.9847 20.9049 16.8606 20.9495 16.7254C21 16.5726 21 16.4013 21 16.0586Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.5 9.5L7.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  install: '<svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true" fill="none"><path d="M21.2 22C21.48 22 21.62 22 21.727 21.9455C21.8211 21.8976 21.8976 21.8211 21.9455 21.727C22 21.62 22 21.48 22 21.2V10.8C22 10.52 22 10.38 21.9455 10.273C21.8976 10.1789 21.8211 10.1024 21.727 10.0545C21.62 10 21.48 10 21.2 10L18.8 10C18.52 10 18.38 10 18.273 10.0545C18.1789 10.1024 18.1024 10.1789 18.0545 10.273C18 10.38 18 10.52 18 10.8V13.2C18 13.48 18 13.62 17.9455 13.727C17.8976 13.8211 17.8211 13.8976 17.727 13.9455C17.62 14 17.48 14 17.2 14H14.8C14.52 14 14.38 14 14.273 14.0545C14.1789 14.1024 14.1024 14.1789 14.0545 14.273C14 14.38 14 14.52 14 14.8V17.2C14 17.48 14 17.62 13.9455 17.727C13.8976 17.8211 13.8211 17.8976 13.727 17.9455C13.62 18 13.48 18 13.2 18H10.8C10.52 18 10.38 18 10.273 18.0545C10.1789 18.1024 10.1024 18.1789 10.0545 18.273C10 18.38 10 18.52 10 18.8V21.2C10 21.48 10 21.62 10.0545 21.727C10.1024 21.8211 10.1789 21.8976 10.273 21.9455C10.38 22 10.52 22 10.8 22L21.2 22Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 6.8C10 6.51997 10 6.37996 10.0545 6.273C10.1024 6.17892 10.1789 6.10243 10.273 6.0545C10.38 6 10.52 6 10.8 6H13.2C13.48 6 13.62 6 13.727 6.0545C13.8211 6.10243 13.8976 6.17892 13.9455 6.273C14 6.37996 14 6.51997 14 6.8V9.2C14 9.48003 14 9.62004 13.9455 9.727C13.8976 9.82108 13.8211 9.89757 13.727 9.9455C13.62 10 13.48 10 13.2 10H10.8C10.52 10 10.38 10 10.273 9.9455C10.1789 9.89757 10.1024 9.82108 10.0545 9.727C10 9.62004 10 9.48003 10 9.2V6.8Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12.8C3 12.52 3 12.38 3.0545 12.273C3.10243 12.1789 3.17892 12.1024 3.273 12.0545C3.37996 12 3.51997 12 3.8 12H6.2C6.48003 12 6.62004 12 6.727 12.0545C6.82108 12.1024 6.89757 12.1789 6.9455 12.273C7 12.38 7 12.52 7 12.8V15.2C7 15.48 7 15.62 6.9455 15.727C6.89757 15.8211 6.82108 15.8976 6.727 15.9455C6.62004 16 6.48003 16 6.2 16H3.8C3.51997 16 3.37996 16 3.273 15.9455C3.17892 15.8976 3.10243 15.8211 3.0545 15.727C3 15.62 3 15.48 3 15.2V12.8Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 2.8C2 2.51997 2 2.37996 2.0545 2.273C2.10243 2.17892 2.17892 2.10243 2.273 2.0545C2.37996 2 2.51997 2 2.8 2H5.2C5.48003 2 5.62004 2 5.727 2.0545C5.82108 2.10243 5.89757 2.17892 5.9455 2.273C6 2.37996 6 2.51997 6 2.8V5.2C6 5.48003 6 5.62004 5.9455 5.727C5.89757 5.82108 5.82108 5.89757 5.727 5.9455C5.62004 6 5.48003 6 5.2 6H2.8C2.51997 6 2.37996 6 2.273 5.9455C2.17892 5.89757 2.10243 5.82108 2.0545 5.727C2 5.62004 2 5.48003 2 5.2V2.8Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  codex: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M4 5h16v14H4zM7 9l3 3-3 3m5 0h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  claude: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M4 5h16v14H4zM7 9l3 3-3 3m5 0h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  github: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M5 5h14v14H5zM8 9h8M8 12h8M8 15h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  state: '<svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true" fill="none"><path d="M17 20H16.8C15.1198 20 14.2798 20 13.638 19.673C13.0735 19.3854 12.6146 18.9265 12.327 18.362C12 17.7202 12 16.8802 12 15.2V8.8C12 7.11984 12 6.27976 12.327 5.63803C12.6146 5.07354 13.0735 4.6146 13.638 4.32698C14.2798 4 15.1198 4 16.8 4H17M17 20C17 21.1046 17.8954 22 19 22C20.1046 22 21 21.1046 21 20C21 18.8954 20.1046 18 19 18C17.8954 18 17 18.8954 17 20ZM17 4C17 5.10457 17.8954 6 19 6C20.1046 6 21 5.10457 21 4C21 2.89543 20.1046 2 19 2C17.8954 2 17 2.89543 17 4ZM7 12L17 12M7 12C7 13.1046 6.10457 14 5 14C3.89543 14 3 13.1046 3 12C3 10.8954 3.89543 10 5 10C6.10457 10 7 10.8954 7 12ZM17 12C17 13.1046 17.8954 14 19 14C20.1046 14 21 13.1046 21 12C21 10.8954 20.1046 10 19 10C17.8954 10 17 10.8954 17 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  workspace: '<svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true" fill="none"><path d="M2.39019 18.0983L10.6151 3.89171C11.0696 3.10655 11.2969 2.71396 11.5935 2.58211C11.8521 2.4671 12.1474 2.4671 12.4061 2.58211C12.7026 2.71396 12.9299 3.10654 13.3844 3.89171L21.6093 18.0983C22.0655 18.8863 22.2936 19.2803 22.2599 19.6037C22.2305 19.8857 22.0827 20.142 21.8534 20.3088C21.5904 20.5 21.1352 20.5 20.2246 20.5H3.77487C2.86435 20.5 2.40908 20.5 2.14613 20.3088C1.91677 20.142 1.769 19.8857 1.73959 19.6037C1.70588 19.2803 1.93398 18.8863 2.39019 18.0983Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const SERVICE_SCHEMA_NODES = [

  { id: "node",       label: "Node.js",      tier: 0, source: "node-version" },

  { id: "workspace",  label: "Workspace",    tier: 1, source: "workspace-package", icon: "workspace" },

  { id: "install",    label: "Install state", tier: 2, sources: ["install-state-commands"], prefix: "install-state:", icon: "install" },
  { id: "binding",    label: "sqlite binding", tier: 2, source: "runtime-dependency:better-sqlite3", icon: "binding" },
  { id: "state",      label: "State root",    tier: 2, source: "state-root", icon: "state" },






  { id: "code_host",  label: "GitHub",       tier: 2, source: "code-host", icon: "github" },

  { id: "database",   label: "Database",     tier: 3, source: "sqlite-db", icon: "database" },
  { id: "artifacts",  label: "Logs",         tier: 3, source: "artifacts-root", icon: "artifacts", link: "/__niis/logs" },
  { id: "backups",    label: "Backups",      tier: 3, source: "backup-freshness", icon: "backups" },
  { id: "codex",      label: "Codex",        tier: 3, source: "adapter-availability:codex_local", icon: "codex" },
  { id: "claude",     label: "Claude",       tier: 3, source: "adapter-availability:claude_code_local", icon: "claude" },
];
const SERVICE_SCHEMA_EDGES = [
  ["node",      "workspace"],
  ["workspace", "install"],
  ["workspace", "binding"],
  ["workspace", "state"],
  ["binding",   "database"],
  ["state",     "artifacts"],
  ["state",     "backups"],
  ["state",     "codex"],
  ["state",     "claude"],
  ["workspace", "code_host"],
];




















const SERVICE_PIPELINE_NODES = [




  { id: "pipe_validators", label: "Validators",       x: 1221, y: 160, hidden: true },
  { id: "pipe_reviewer",   label: "LLM reviewer",     x: 1410, y: 80,  hidden: true },
  { id: "pipe_proof",      label: "Completion proof", x: 1410, y: 240, hidden: true },
  { id: "pipe_verdict",    label: "Verdict",          x: 1588, y: 160, hidden: true },
];
const SERVICE_PIPELINE_EDGES = [

  ["pipe_validators",  "pipe_reviewer", "edge_reviewer"],
  ["pipe_validators",  "pipe_proof",    "edge_proof"],

  ["pipe_reviewer",    "pipe_verdict",  "edge_reviewer"],
  ["pipe_proof",       "pipe_verdict",  "edge_proof"],

];



const SERVICE_PIPELINE_ICONS = {
  shield: '<svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  brain:  '<svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/></svg>',
  check:  '<svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  scale:  '<svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>',
  branch: '<svg width="18" height="18" viewBox="0 0 24 24" overflow="visible" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
};








const SERVICE_REMEDIATION = {
  "backup-freshness": { command: "niis backup", action: "backup", description: "Create a fresh backup manifest." },
  "runtime-dependency:better-sqlite3": { command: "npm install", action: null, description: "Reinstall native deps." },
  "sqlite-db": { command: "niis init", action: "init", description: "Re-scaffold the state root." },
  "state-root": { command: "niis init", action: "init", description: "Scaffold the state root." },
  "adapter-availability:codex_local": { command: "brew install --cask codex", action: null, description: "Install Codex CLI." },
  "adapter-availability:claude_code_local": { command: "Install from claude.ai/download", action: null, description: "Install Claude Code." },
  "node-version": { command: "Upgrade to Node 20+", action: null, description: "Upgrade Node.js." },
  "workspace-package": { command: "niis init", action: "init", description: "Restore workspace scaffolding." },
  "artifacts-root": { command: "niis init", action: "init", description: "Scaffold the artifacts directory." },
};







function nodeMetaFromChecks(node, byId, allChecks) {
  const matching = [];
  if (node.source && byId.has(node.source)) matching.push(byId.get(node.source));
  if (Array.isArray(node.sources)) {
    for (const id of node.sources) if (byId.has(id)) matching.push(byId.get(id));
  }
  if (node.prefix) {
    for (const c of allChecks) {
      if (typeof c.id === "string" && c.id.startsWith(node.prefix)) matching.push(c);
    }
  }
  if (matching.length === 0) {
    return {
      status: "unknown",
      payload: { label: node.label, status: "unknown", items: [{ status: "unknown", summary: "No doctor check recorded.", details: null, fix: null }], note: node.note || null },
    };
  }
  const statuses = matching.map((c) => c.status);
  let status;
  if (statuses.includes("error")) status = "error";
  else if (statuses.includes("warning")) status = "warning";
  else if (statuses.every((s) => s === "ok")) status = "ok";
  else status = "unknown";
  const interesting = status === "ok" ? matching.slice(0, 1) : matching.filter((c) => c.status !== "ok");
  const items = interesting.map((c) => ({
    status: c.status,
    summary: c.summary || c.id,
    details: c.details || null,
    fix: c.status !== "ok" ? (SERVICE_REMEDIATION[c.id] || null) : null,
  }));
  return { status, payload: { label: node.label, status, items, note: node.note || null } };
}








function buildClaudeCreditNote(creditUsd, rolesConfig, spentUsd = null) {
  if (!Number.isFinite(creditUsd) || creditUsd <= 0) return null;
  const roles = rolesConfig && typeof rolesConfig === "object" ? rolesConfig : {};
  let configured = 0;
  for (const r of Object.values(roles)) {
    const m = r?.budget?.monthly_usd;
    if (Number.isFinite(m) && m > 0) configured += m;
  }
  const fmt = (n) => `$${n.toFixed(2)}`;
  const spendLine = (Number.isFinite(spentUsd) && spentUsd > 0)
    ? (() => {
        const remaining = Math.max(creditUsd - spentUsd, 0);
        const pct = Math.round((spentUsd / creditUsd) * 100);
        const over = spentUsd > creditUsd ? ` (⚠ ${fmt(spentUsd - creditUsd)} over)` : "";
        return ` Spent this month: ${fmt(spentUsd)} (${pct}% of the reference). Remaining: ${fmt(remaining)}${over}. Spend aggregates all adapters.`;
      })()
    : "";
  if (configured === 0) {
    return `Monthly reference recorded: ${fmt(creditUsd)}. No role monthly budgets are configured. This value is operator-entered; Niis does not verify provider billing or quota rules.${spendLine}`;
  }
  if (configured > creditUsd) {
    const over = configured - creditUsd;
    return `⚠ Sum of role monthly budgets (${fmt(configured)}) exceeds the operator-entered monthly reference (${fmt(creditUsd)}) by ${fmt(over)}.${spendLine}`;
  }
  const headroom = creditUsd - configured;
  const pct = Math.round((configured / creditUsd) * 100);
  return `Monthly reference: ${fmt(creditUsd)}. Role monthly budgets configured: ${fmt(configured)} (${pct}% of the reference). Headroom: ${fmt(headroom)}.${spendLine}`;
}











function renderSystemLoadPills({ snapshot, monthlySpendUsd = 0, claudeCreditUsd = 0 }) {
  const safe = snapshot ?? {};
  const blockers = Array.isArray(safe.blockers) ? safe.blockers : [];
  const approvals = Array.isArray(safe.approvals) ? safe.approvals : [];

  const activeBlockers = blockers.filter((b) => !b?.resolved_at).length;
  const pendingApprovals = approvals.filter((a) => String(a?.status || "").toUpperCase() === "PENDING").length;
  const gates = activeBlockers + pendingApprovals;

  const pills = [
    {
      label: "Waiting / Pending",
      value: String(gates),
      tone: gates === 0 ? "ok" : "warn",
      icon: PROJECT_NAV_ICONS.plug,
      hint: gates === 0
        ? "No active blockers, no pending approvals"
        : `${activeBlockers} active blocker${activeBlockers === 1 ? "" : "s"} · ${pendingApprovals} pending approval${pendingApprovals === 1 ? "" : "s"}`,
    },
  ];
  if (Number.isFinite(claudeCreditUsd) && claudeCreditUsd > 0) {
    const spent = Number.isFinite(monthlySpendUsd) ? Math.max(monthlySpendUsd, 0) : 0;
    const pct = Math.min(Math.round((spent / claudeCreditUsd) * 100), 999);
    let tone = "ok";
    if (pct >= 80) tone = "error";
    else if (pct >= 50) tone = "warn";
    pills.push({
      label: "Spent (this month)",
      value: `${pct}%`,
      tone,
      icon: PROJECT_NAV_ICONS.card,
      hint: `$${spent.toFixed(2)} of the $${claudeCreditUsd.toFixed(2)} operator-entered monthly reference (all adapters).`,
    });
  }
  const pillsHtml = pills.map((p) => `
    <div class="lab-project-services-pill" data-tone="${escapeHtml(p.tone)}" title="${escapeHtml(p.hint)}">
      <span class="lab-project-services-pill-icon" aria-hidden="true">${p.icon || ""}</span>
      <span class="lab-project-services-pill-value">${escapeHtml(p.value)}</span>
      <span class="lab-project-services-pill-label">${escapeHtml(p.label)}</span>
    </div>`).join("");
  return `<div class="lab-project-services-pills" role="group" aria-label="System load">${pillsHtml}</div>`;
}









function renderAdapterPoolBadges(allChecks, { claudeCreditNote = null } = {}) {
  const checks = Array.isArray(allChecks) ? allChecks : [];
  const byId = new Map(checks.map((c) => [c.id, c]));
  const isAgentNode = (n) => typeof n.source === "string" && n.source.startsWith("adapter-availability:");
  const agentNodes = SERVICE_SCHEMA_NODES.filter(isAgentNode);
  if (agentNodes.length === 0) {
    return `<div class="lab-project-adapter-badge-empty">No adapters installed</div>`;
  }
  return agentNodes.map((node) => {
    const meta = nodeMetaFromChecks(node, byId, checks);
    if (node.id === "claude" && claudeCreditNote) {
      meta.payload.note = claudeCreditNote;
    }
    const icon = node.icon ? SERVICE_NODE_ICONS[node.icon] : "";
    const payloadJson = escapeHtml(JSON.stringify(meta.payload));
    return `<div class="lab-project-service-node lab-project-adapter-badge" data-status="${meta.status}" data-id="${escapeHtml(node.id)}" data-popover="${payloadJson}" tabindex="0">
      <span class="lab-project-adapter-badge-icon">${icon}</span>
      <span class="lab-project-adapter-badge-label">${escapeHtml(node.label)}</span>
    </div>`;
  }).join("");
}

const PROJECT_ARTIFACT_FILES = [
  { id: "project-profile",        filename: "project-profile.md",        kind: "md"   },
  { id: "workflow",               filename: "workflow.md",               kind: "md"   },
  { id: "codemap",                filename: "codemap.json",              kind: "json" },
  { id: "attached-repository",    filename: "attached-repository.json",  kind: "json" },
  { id: "task-sources",           filename: "task-sources.json",         kind: "json" },
  { id: "reference-bundle-seeds", filename: "reference-bundle-seeds.json", kind: "json" },
  { id: "bootstrap-pack",         filename: "bootstrap-pack.json",       kind: "json" },
  { id: "scaffold-plan",          filename: "scaffold-plan.json",        kind: "json" },
  { id: "install-state",          filename: "install-state.json",        kind: "json" },
];

const PROJECT_HEALTH_ZONE_LABELS = {
  "task-in": "Task in",
  "project-artifacts": "Project artifacts",
  adapters: "Adapter pool",
  validators: "Validators",
  "llm-reviewer": "LLM reviewer",
  proof: "Completion proof",
  verdict: "Verdict",
  delivery: "Delivery",
};

const PROJECT_HEALTH_ZONE_ORDER = [
  "validators",
  "adapters",
  "delivery",
  "project-artifacts",
  "llm-reviewer",
  "proof",
  "verdict",
  "task-in",
];

const PROJECT_HEALTH_WARNING_ICON = `
  <svg class="lab-project-health-warning-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <path d="M12 8V12M12 16H12.01M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

const PROJECT_HEALTH_DANGER_ICON = `
  <svg class="lab-project-health-warning-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <path d="M11.9998 8.99999V13M11.9998 17H12.0098M10.6151 3.89171L2.39019 18.0983C1.93398 18.8863 1.70588 19.2803 1.73959 19.6037C1.769 19.8857 1.91677 20.142 2.14613 20.3088C2.40908 20.5 2.86435 20.5 3.77487 20.5H20.2246C21.1352 20.5 21.5904 20.5 21.8534 20.3088C22.0827 20.142 22.2305 19.8857 22.2599 19.6037C22.2936 19.2803 22.0655 18.8863 21.6093 18.0983L13.3844 3.89171C12.9299 3.10654 12.7026 2.71396 12.4061 2.58211C12.1474 2.4671 11.8521 2.4671 11.5935 2.58211C11.2969 2.71396 11.0696 3.10655 10.6151 3.89171Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

function projectHealthWorstStatus(issues) {
  const list = Array.isArray(issues) ? issues : [];
  if (list.some((issue) => issue.status === "error")) return "error";
  if (list.some((issue) => issue.status === "warning")) return "warning";
  return "ok";
}

function projectHealthIssueSeverityRank(issue) {
  if (issue?.status === "error") return 0;
  if (issue?.status === "warning") return 1;
  return 2;
}

function projectServiceDisplayLabel(node, byId, meta, gitUser = null) {
  if (!node) return "";
  let label = node.label;
  if (node.id === "code_host") {
    const c = byId.get("code-host");
    if (c?.host) {
      label = c.host === "None" ? "No remote" : c.host;
      if (meta?.payload) meta.payload.label = label;
    }
    if ((gitUser?.name || gitUser?.email) && meta?.payload) {
      const identity = `${gitUser.name || "(no name)"} <${gitUser.email || "(no email)"}>`;
      const idNote = `Commits authored as ${identity} (from git config user.name / user.email).`;
      meta.payload.note = meta.payload.note ? `${meta.payload.note} ${idNote}` : idNote;
    }
  }
  return label;
}

function collectProjectServiceIssues(zone, serviceIds, checks, { claudeCreditNote = null, gitUser = null } = {}) {
  const byId = new Map(checks.map((c) => [c.id, c]));
  const issues = [];
  for (const serviceId of serviceIds) {
    const node = SERVICE_SCHEMA_NODES.find((n) => n.id === serviceId);
    if (!node) continue;
    const meta = nodeMetaFromChecks(node, byId, checks);
    if (node.id === "claude" && claudeCreditNote) meta.payload.note = claudeCreditNote;
    const label = projectServiceDisplayLabel(node, byId, meta, gitUser);
    const failingItems = (meta.payload?.items || []).filter((item) => item.status === "warning" || item.status === "error");
    for (const [index, item] of failingItems.entries()) {
      issues.push({
        id: `${zone}:${serviceId}:${index}`,
        zone,
        status: item.status,
        title: label,
        summary: item.summary || label,
        details: item.details || null,
        fix: item.fix || null,
        source: serviceId,
      });
    }
  }
  return issues;
}

function collectProjectArtifactIssues(fileSnippets) {
  const snippets = fileSnippets ?? {};
  return PROJECT_ARTIFACT_FILES.flatMap((file) => {
    const data = snippets[file.id] ?? { exists: false, snippet: "" };
    if (data.exists === true) return [];
    return [{
      id: `project-artifacts:${file.id}`,
      zone: "project-artifacts",
      target: file.id,
      status: "warning",
      title: file.filename,
      summary: "Project artifact has not been generated yet.",
      details: `Run the project bootstrap/attach flow to create ${file.filename}.`,
      fix: null,
      source: "project-artifact",
    }];
  });
}

function buildProjectOperationalIssues({
  doctorChecks = [],
  projectFileSnippets = {},
  claudeCreditNote = null,
  gitUser = null,
} = {}) {
  const checks = Array.isArray(doctorChecks) ? doctorChecks : [];
  const issues = [
    ...collectProjectServiceIssues("adapters", ["codex", "claude"], checks, { claudeCreditNote, gitUser }),
    ...collectProjectServiceIssues("validators", ["node", "workspace", "install", "binding", "state", "database", "artifacts"], checks, { claudeCreditNote, gitUser }),
    ...collectProjectServiceIssues("delivery", ["code_host", "backups"], checks, { claudeCreditNote, gitUser }),
    ...collectProjectArtifactIssues(projectFileSnippets),
  ];
  return issues.sort((a, b) => {
    const severity = projectHealthIssueSeverityRank(a) - projectHealthIssueSeverityRank(b);
    if (severity !== 0) return severity;
    const zoneA = PROJECT_HEALTH_ZONE_ORDER.indexOf(a.zone);
    const zoneB = PROJECT_HEALTH_ZONE_ORDER.indexOf(b.zone);
    return (zoneA === -1 ? 99 : zoneA) - (zoneB === -1 ? 99 : zoneB);
  });
}

function buildProjectHealthStatus({
  doctorChecks = [],
  projectFileSnippets = {},
  claudeCreditNote = null,
  gitUser = null,
} = {}) {
  return sortProjectHealthIssues([
    ...buildProjectOperationalIssues({
      doctorChecks,
      projectFileSnippets,
      claudeCreditNote,
      gitUser,
    }),
  ]);
}

function sortProjectHealthIssues(issues) {
  return (Array.isArray(issues) ? [...issues] : []).sort((a, b) => {
    const severity = projectHealthIssueSeverityRank(a) - projectHealthIssueSeverityRank(b);
    if (severity !== 0) return severity;
    const zoneA = PROJECT_HEALTH_ZONE_ORDER.indexOf(a.zone);
    const zoneB = PROJECT_HEALTH_ZONE_ORDER.indexOf(b.zone);
    return (zoneA === -1 ? 99 : zoneA) - (zoneB === -1 ? 99 : zoneB);
  });
}

function renderProjectHealthMarker(issues, zone, label, extraClass = "") {
  const zoneIssues = (Array.isArray(issues) ? issues : []).filter((issue) => issue.zone === zone);
  if (zoneIssues.length === 0) return "";
  const status = projectHealthWorstStatus(zoneIssues);
  const readableStatus = status === "error" ? "danger" : "warning";
  const title = `${label}: ${zoneIssues.length} ${readableStatus}${zoneIssues.length === 1 ? "" : "s"}`;
  return `<button type="button" class="lab-project-health-marker${extraClass}" data-lab-health-marker data-zone="${escapeHtml(zone)}" data-status="${escapeHtml(status)}" aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}">
    ${status === "error" ? PROJECT_HEALTH_DANGER_ICON : PROJECT_HEALTH_WARNING_ICON}
  </button>`;
}

function renderProjectArtifactMarkerSpan(status = "warning") {
  return `<span class="lab-project-file-health-marker" data-status="${escapeHtml(status)}" aria-hidden="true">${status === "error" ? PROJECT_HEALTH_DANGER_ICON : PROJECT_HEALTH_WARNING_ICON}</span>`;
}

function renderProjectHealthDrawerRows(issue) {
  const rows = [];
  rows.push({
    title: issue.summary || issue.title,
    meta: "now",
    detail: PROJECT_HEALTH_ZONE_LABELS[issue.zone] || issue.zone,
  });
    if (issue.details) {
      rows.push({
        title: issue.details,
        meta: "recorded",
        detail: issue.source ? `Source: ${issue.source}` : "",
      });
  }
  const fixCommand = issue.fix?.command || "";
  const fixText = fixCommand || issue.fix?.description || "";
  if (fixText && !issue.fix?.action) {
    rows.push({
      title: fixText,
      meta: "manual",
      detail: "Suggested operator action",
      code: true,
    });
  }
  return rows.map((row) => `
    <div class="lab-project-health-drawer-timeline-row">
      <div>
        <strong${row.code ? " class=\"lab-project-health-drawer-timeline-code\"" : ""}>${escapeHtml(row.title)}</strong>
        ${row.detail ? `<span>${escapeHtml(row.detail)}</span>` : ""}
      </div>
      <em>${escapeHtml(row.meta)}</em>
    </div>`).join("");
}

function renderProjectHealthFix(issue) {
  if (!issue.fix || typeof issue.fix !== "object") return "";
  const command = issue.fix.command || "";
  const description = issue.fix.description || "";
  const action = issue.fix.action || "";
  if (!action) {
    if (!command && !description) return "";
    return `
      <div class="lab-project-health-drawer-fix">
        <span class="lab-project-health-drawer-fix-label">Manual fix</span>
        ${command ? `<code>${escapeHtml(command)}</code>` : ""}
        ${description ? `<p>${escapeHtml(description)}</p>` : ""}
      </div>`;
  }
  return `
    <div class="lab-project-health-drawer-fix" data-lab-health-fix-row>
      <button type="button" class="lab-project-services-fix-button lab-project-health-drawer-fix-button" data-lab-health-fix-run="${escapeHtml(action)}">
        <span class="lab-project-services-fix-button-label">Run fix</span>
        ${command ? `<code class="lab-project-services-fix-button-cmd">${escapeHtml(command)}</code>` : ""}
      </button>
      ${description ? `<div class="lab-project-services-fix-desc">${escapeHtml(description)}</div>` : ""}
    </div>`;
}

function renderProjectHealthDrawerRecord(issue, index, expanded = false) {
  const zoneLabel = PROJECT_HEALTH_ZONE_LABELS[issue.zone] || issue.zone;
  return `
    <article class="lab-project-health-drawer-record" data-lab-health-record data-zone="${escapeHtml(issue.zone)}" data-status="${escapeHtml(issue.status)}"${expanded ? " data-expanded" : ""}>
      <button type="button" class="lab-project-health-drawer-record-head" data-lab-health-record-toggle aria-expanded="${expanded ? "true" : "false"}">
        <span class="lab-project-health-drawer-chevron" aria-hidden="true"></span>
        <span class="lab-project-health-drawer-record-index">${escapeHtml(String(index + 1))}</span>
        <span class="lab-project-health-drawer-record-title">
          <strong>${escapeHtml(issue.title)}</strong>
          <em>${escapeHtml(zoneLabel)}</em>
        </span>
      </button>
      <div class="lab-project-health-drawer-record-body">
        <p class="lab-project-health-drawer-record-summary">${escapeHtml(issue.summary || issue.title)}</p>
        <div class="lab-project-health-drawer-timeline">
          ${renderProjectHealthDrawerRows(issue)}
        </div>
        ${renderProjectHealthFix(issue)}
      </div>
    </article>`;
}

function renderProjectHealthDrawer(issues) {
  const list = Array.isArray(issues) ? issues.filter((issue) => issue.status === "warning" || issue.status === "error") : [];
  if (list.length === 0) return "";
  const status = projectHealthWorstStatus(list);
  const title = status === "error" ? "Danger" : "Warning";
  const recordsHtml = list.map((issue, index) => renderProjectHealthDrawerRecord(issue, index, index === 0)).join("");
  return `
    <aside class="lab-project-health-drawer" data-lab-health-drawer data-status="${escapeHtml(status)}" aria-label="Project health attention">
      <header class="lab-project-health-drawer-head">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>Project problems <span>(${escapeHtml(String(list.length))} recorded)</span></p>
        </div>
        <button type="button" class="lab-project-health-drawer-close" data-lab-health-close aria-label="Close project health drawer">
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div class="lab-project-health-drawer-list">
        ${recordsHtml}
      </div>
    </aside>`;
}







function renderProjectServiceSchema(allChecks, { claudeCreditNote = null, systemLoadHtml = "", gitUser = null, section = "full", orientation = "horizontal" } = {}) {
  const isVertical = orientation === "vertical";
  const checks = Array.isArray(allChecks) ? allChecks : [];
  const byId = new Map(checks.map((c) => [c.id, c]));



  const isAgentNode = (n) => typeof n.source === "string" && n.source.startsWith("adapter-availability:");



  const tierNodesAll = section === "right"
    ? []
    : section === "left"
    ? SERVICE_SCHEMA_NODES.filter((n) => !isAgentNode(n))
    : SERVICE_SCHEMA_NODES;
  const byTier = new Map();
  for (const node of tierNodesAll) {
    const arr = byTier.get(node.tier) ?? [];
    arr.push(node);
    byTier.set(node.tier, arr);
  }




  const VIEWBOX_W = 1920;
  const VIEWBOX_H = 320;
  const TIER_COUNT = Math.max(...SERVICE_SCHEMA_NODES.map((n) => n.tier)) + 1;




  const TIER_SECTION_W = 1000;


  const positions = new Map();
  for (let t = 0; t < TIER_COUNT; t += 1) {
    const tierNodes = byTier.get(t) ?? [];
    const tierPos = (TIER_SECTION_W / (TIER_COUNT + 1)) * (t + 1);
    const slotCount = tierNodes.length;
    const spacing = VIEWBOX_H / (slotCount + 1);
    tierNodes.forEach((node, i) => {
      const meta = nodeMetaFromChecks(node, byId, checks);


      if (node.id === "claude" && claudeCreditNote) {
        meta.payload.note = claudeCreditNote;
      }







      let dynamicLabel = node.label;
      if (node.id === "code_host") {
        const c = byId.get("code-host");
        if (c?.host) {
          dynamicLabel = c.host === "None" ? "No remote" : c.host;
          meta.payload.label = dynamicLabel;
        }
        if (gitUser?.name || gitUser?.email) {
          const identity = `${gitUser.name || "(no name)"} <${gitUser.email || "(no email)"}>`;
          const idNote = `Commits authored as ${identity} (from \`git config user.name / user.email\`).`;
          meta.payload.note = meta.payload.note ? `${meta.payload.note} ${idNote}` : idNote;
        }
      }
      const slotPos = spacing * (i + 1);
      positions.set(node.id, {
        x: isVertical ? slotPos : tierPos,
        y: isVertical ? tierPos : slotPos,
        status: meta.status,
        payload: meta.payload,
        label: dynamicLabel,
        id: node.id,
        iconSvg: node.icon ? SERVICE_NODE_ICONS[node.icon] : null,
        link: typeof node.link === "string" && node.link.length > 0 ? node.link : null,
      });
    });
  }





  if (section !== "left") {
    for (const node of SERVICE_PIPELINE_NODES) {
      positions.set(node.id, {

        x: isVertical ? node.y : node.x,
        y: isVertical ? node.x : node.y,
        status: "unknown",
        payload: { label: node.label, status: "unknown", items: [], note: null },
        label: node.label,
        sub: node.sub || null,
        id: node.id,
        iconSvg: node.icon ? SERVICE_PIPELINE_ICONS[node.icon] : null,
        kind: node.kind,
        link: null,
        hidden: node.hidden === true,
      });
    }
  }


  const edgeClass = (kind) => {
    if (kind === "edge_reviewer") return "lab-project-service-edge lab-project-service-edge-reviewer";
    if (kind === "edge_proof") return "lab-project-service-edge lab-project-service-edge-proof";
    if (kind === "edge_trunk") return "lab-project-service-edge lab-project-service-edge-trunk";
    if (kind === "edge_agent") return "lab-project-service-edge lab-project-service-edge-agent";
    return "lab-project-service-edge";
  };





  const bezier = (a, b) => {
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    if (dx >= dy) {
      const mx = (a.x + b.x) / 2;
      return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
    }
    const my = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y} C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y}`;
  };



  const agentEdges = SERVICE_SCHEMA_NODES
    .filter(isAgentNode)
    .map((n) => [n.id, "pipe_validators", "edge_agent"]);




  const allEdges = section === "left"
    ? SERVICE_SCHEMA_EDGES.map(([f, t]) => [f, t, null])
    : section === "right"
    ? [...agentEdges, ...SERVICE_PIPELINE_EDGES]
    : [
      ...SERVICE_SCHEMA_EDGES.map(([f, t]) => [f, t, null]),
      ...agentEdges,
      ...SERVICE_PIPELINE_EDGES,
    ];
  const edgesSvg = allEdges.map(([fromId, toId, kind]) => {
    const a = positions.get(fromId);
    const b = positions.get(toId);
    if (!a || !b) return "";
    return `<path class="${edgeClass(kind)}" d="${bezier(a, b)}" />`;
  }).join("");
  const nodesSvg = [...positions.values()].map((p) => {



    if (p.hidden) return "";








    const iconSvg = p.iconSvg
      ? `<g class="lab-project-service-icon" transform="translate(-9, -9)">${p.iconSvg}</g>`
      : "";
    const dotSvg = p.iconSvg ? "" : `<circle class="lab-project-service-dot" r="6" />`;
    const labelX = p.iconSvg ? 17 : 14;
    const payloadJson = escapeHtml(JSON.stringify(p.payload));




    const kindAttr = p.kind ? ` data-kind="${escapeHtml(p.kind)}"` : "";



    const subSvg = p.sub
      ? `<text class="lab-project-service-sublabel" x="${labelX}" y="14" dominant-baseline="central">${escapeHtml(p.sub)}</text>`
      : "";
    const inner = `<g class="lab-project-service-node" data-status="${p.status}" data-id="${escapeHtml(p.id)}" data-popover="${payloadJson}"${kindAttr} transform="translate(${p.x},${p.y})">
      ${dotSvg}
      ${iconSvg}
      <text class="lab-project-service-label" x="${labelX}" y="0" dominant-baseline="central">${escapeHtml(p.label)}</text>
      ${subSvg}
    </g>`;
    return p.link
      ? `<a class="lab-project-service-link" href="${escapeHtml(p.link)}" target="_blank" rel="noopener">${inner}</a>`
      : inner;
  }).join("");






  const viewBox = (() => {
    if (section === "left") {
      return isVertical
        ? `0 0 ${VIEWBOX_H} ${TIER_SECTION_W}`
        : `0 0 ${TIER_SECTION_W} ${VIEWBOX_H}`;
    }
    if (section === "right") {






      return isVertical
        ? `0 1050 ${VIEWBOX_H} 780`
        : `1050 0 780 ${VIEWBOX_H}`;
    }
    return isVertical
      ? `0 0 ${VIEWBOX_H} ${VIEWBOX_W}`
      : `0 0 ${VIEWBOX_W} ${VIEWBOX_H}`;
  })();
  const wrapperClass = section === "full"
    ? "lab-project-services"
    : `lab-project-services lab-project-services-${section}`;


  const headerHtml = section === "right"
    ? ""
    : `<header class="lab-project-services-header">
      <h3 class="lab-project-services-title">Services Health</h3>
    </header>`;
  const promotionFlowHtml = section === "left"
    ? ""
    : renderServicePromotionFlow({ orientation });
  return `<div class="${wrapperClass}">
    ${headerHtml}
    <svg class="lab-project-services-svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Service dependency graph">
      <g class="lab-project-service-edges">${edgesSvg}</g>
      <g class="lab-project-service-nodes">${nodesSvg}</g>
      <g class="lab-project-service-promotion-flow-container">
        ${promotionFlowHtml}
      </g>
    </svg>
    ${systemLoadHtml || ""}
    <div class="lab-project-services-popover" data-lab-services-popover hidden role="tooltip" aria-hidden="true"></div>
  </div>`;
}




function computeSystemStatus(allChecks) {
  if (!Array.isArray(allChecks) || allChecks.length === 0) return null;
  if (allChecks.some((c) => c.status === "error")) return "error";
  if (allChecks.some((c) => c.status === "warning")) return "warning";
  return "ok";
}

function renderProjectGoalTaskCheckboxes({ tasks, checkedIds = new Set(), name = "task_ids[]" }) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return `<p class="lab-project-goal-form-empty">No tasks available.</p>`;
  }
  return `<div class="lab-project-goal-task-checks">
    ${tasks.map((t) => `
      <label class="lab-project-goal-task-check">
        <input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(t.id)}" ${checkedIds.has(t.id) ? "checked" : ""} />
        <span class="lab-project-goal-task-check-title">${escapeHtml(t.title ?? t.id)}</span>
        ${t.status ? `<span class="lab-project-goal-task-check-status">${escapeHtml(t.status)}</span>` : ""}
      </label>`).join("")}
  </div>`;
}

function renderProjectGoalCreateForm({ tasks }) {
  const unassigned = (Array.isArray(tasks) ? tasks : []).filter((t) => !t.goal_id);
  return `<details class="lab-project-goal-create">
    <summary class="lab-project-goal-create-summary">+ New goal</summary>
    <form action="/project/goals/create" method="post" class="lab-project-goal-form">
      <label class="lab-project-goal-form-field">
        <span class="lab-project-goal-form-label">Title</span>
        <input type="text" name="title" required maxlength="120" placeholder="e.g. Q2 auth rewrite" />
      </label>
      <label class="lab-project-goal-form-field">
        <span class="lab-project-goal-form-label">Description</span>
        <textarea name="description" required rows="2" placeholder="Why this goal exists, what success looks like"></textarea>
      </label>
      <label class="lab-project-goal-form-field">
        <span class="lab-project-goal-form-label">Level</span>
        <select name="level">
          <option value="project" selected>Project</option>
          <option value="global">Global</option>
        </select>
      </label>
      <fieldset class="lab-project-goal-form-field">
        <legend class="lab-project-goal-form-label">Attach existing tasks (optional)</legend>
        ${renderProjectGoalTaskCheckboxes({ tasks: unassigned })}
      </fieldset>
      <div class="lab-project-goal-form-actions">
        <button type="submit" class="lab-project-button lab-project-button-primary">Create goal</button>
      </div>
    </form>
  </details>`;
}

function renderProjectGoalCard({ goal, progress, tasks }) {
  const accent = PROJECT_GOAL_STATUS_COLORS[goal.status] ?? "#9ca3af";
  const taskCount = progress?.task_count ?? 0;
  const doneCount = progress?.task_status_counts?.DONE ?? 0;
  const completionPct = taskCount > 0 ? Math.round((doneCount / taskCount) * 100) : null;
  const totalCost = progress?.total_cost_usd ?? 0;
  const totalRuns = progress?.total_runs ?? 0;
  const segments = Object.entries(progress?.task_status_counts ?? {})
    .filter(([, count]) => count > 0);
  const allTasks = Array.isArray(tasks) ? tasks : [];
  const linkedTasks = allTasks.filter((t) => t.goal_id === goal.id);
  const editAction = `/project/goals/${encodeURIComponent(goal.id)}/edit`;
  const unattached = allTasks.filter((t) => !t.goal_id);
  return `
    <article class="lab-project-goal-card" style="--goal-accent: ${accent};">
      <header class="lab-project-goal-card-header">
        <div class="lab-project-goal-card-title-block">
          <form action="${editAction}" method="post" class="lab-project-goal-card-inline-form">
            <input type="text" name="title" value="${escapeHtml(goal.title ?? "")}" maxlength="120" required
              data-lab-project-autosave class="lab-project-goal-card-title-input" aria-label="Goal title" />
          </form>
          <form action="${editAction}" method="post" class="lab-project-goal-card-inline-form">
            <textarea name="description" rows="2" required data-lab-project-autosave
              class="lab-project-goal-card-desc-input" aria-label="Goal description">${escapeHtml(goal.description ?? "")}</textarea>
          </form>
        </div>
        <span class="lab-project-goal-card-status lab-project-goal-card-status-${escapeHtml(goal.status ?? "active")}">${escapeHtml(goal.status ?? "—")}</span>
      </header>
      <div class="lab-project-goal-card-progress">
        <div class="lab-project-goal-card-progress-meta">
          <span>${completionPct == null ? "No tasks linked" : `${doneCount}/${taskCount} tasks done`}</span>
          ${completionPct != null ? `<span class="lab-project-goal-card-progress-pct">${completionPct}%</span>` : ""}
        </div>
        ${completionPct != null ? `
          <div class="lab-project-goal-card-progress-track">
            <div class="lab-project-goal-card-progress-fill" style="width: ${completionPct}%;"></div>
          </div>` : ""}
      </div>
      ${segments.length > 0 ? `
        <div class="lab-project-goal-card-segments">
          ${segments.map(([status, count]) => `
            <span class="lab-project-goal-card-segment lab-project-goal-card-segment-${escapeHtml(status.toLowerCase())}">${escapeHtml(status)} ${escapeHtml(count)}</span>`).join("")}
        </div>` : ""}
      ${linkedTasks.length > 0 ? `
        <ul class="lab-project-goal-card-linked">
          ${linkedTasks.map((t) => `
            <li class="lab-project-goal-card-linked-item">
              <span class="lab-project-goal-card-linked-title">${escapeHtml(t.title ?? t.id)}</span>
              <form action="/project/tasks/${encodeURIComponent(t.id)}/goal" method="post" class="lab-project-goal-card-linked-form">
                <input type="hidden" name="goal_id" value="" />
                <button type="submit" class="lab-project-goal-card-linked-unlink" title="Unlink task">×</button>
              </form>
            </li>`).join("")}
        </ul>` : ""}
      ${unattached.length > 0 ? `
        <form action="/project/goals/attach" method="post" class="lab-project-goal-card-add-task-form">
          <input type="hidden" name="goal_id" value="${escapeHtml(goal.id)}" />
          <select name="task_id" required class="lab-project-goal-card-add-task-select" data-lab-project-autosave>
            <option value="" disabled selected>+ Add task…</option>
            ${unattached.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.title ?? t.id)}</option>`).join("")}
          </select>
        </form>` : ""}
      <footer class="lab-project-goal-card-footer">
        <form action="${editAction}" method="post" class="lab-project-goal-card-inline-form">
          <select name="level" data-lab-project-autosave class="lab-project-goal-card-level-select" aria-label="Goal level">
            <option value="project" ${goal.level === "project" ? "selected" : ""}>Project</option>
            <option value="global" ${goal.level === "global" ? "selected" : ""}>Global</option>
          </select>
        </form>
        <span>${escapeHtml(totalRuns)} run${totalRuns === 1 ? "" : "s"}</span>
        <span>${escapeHtml(formatCostUsd(totalCost))}</span>
        <form action="/project/goals/${encodeURIComponent(goal.id)}/delete" method="post" class="lab-project-goal-card-delete-form" data-niis-confirm="Delete this goal? Linked tasks will be unattached.">
          <button type="submit" class="lab-project-button lab-project-button-ghost lab-project-button-danger-ghost" title="Delete goal">Delete</button>
        </form>
      </footer>
    </article>`;
}

function renderProjectGoalsUnassignedTasks({ tasks, goals }) {
  if (!Array.isArray(tasks) || tasks.length === 0 || !Array.isArray(goals) || goals.length === 0) return "";
  return `<div class="lab-project-goals-unassigned">
    <h4 class="lab-project-goals-unassigned-title">Unassigned tasks</h4>
    <ul class="lab-project-goals-unassigned-list">
      ${tasks.map((t) => `
        <li class="lab-project-goals-unassigned-item">
          <span class="lab-project-goals-unassigned-task-title">${escapeHtml(t.title ?? t.id)}</span>
          <form action="/project/tasks/${encodeURIComponent(t.id)}/goal" method="post" class="lab-project-goals-unassigned-form">
            <select name="goal_id" required>
              <option value="" disabled selected>— select goal —</option>
              ${goals.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.title)}</option>`).join("")}
            </select>
            <button type="submit" class="lab-project-button">Attach</button>
          </form>
          <form action="/project/tasks/${encodeURIComponent(t.id)}/suggest-goal" method="post" class="lab-project-goals-unassigned-suggest-form" title="Ask the planner runtime to pick a matching goal">
            <button type="submit" class="lab-project-button lab-project-button-ghost">Suggest</button>
          </form>
        </li>`).join("")}
    </ul>
  </div>`;
}

function renderProjectGoalsAutoSuggestToggle({ enabled }) {
  return `<form action="/project/settings/goals" method="post" class="lab-project-goals-autosuggest">
    <label class="lab-project-goals-autosuggest-label">
      <input type="checkbox" name="auto_suggest_on_intake" value="1" ${enabled ? "checked" : ""} data-lab-project-autosave />
      <span class="lab-project-goals-autosuggest-text">
        <span class="lab-project-goals-autosuggest-title">Auto-suggest via LLM</span>
        <span class="lab-project-goals-autosuggest-desc">New tasks get a goal proposed by the planner runtime in the background. Best-effort; no goal attached if the model is unsure or unavailable.</span>
      </span>
    </label>
  </form>`;
}

function renderProjectGoalsSection(snapshot, options = {}) {
  const allGoals = Array.isArray(snapshot?.goals) ? snapshot.goals : [];
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];


  const goals = allGoals.filter((g) => g?.status !== "abandoned");
  const autoSuggestToggle = renderProjectGoalsAutoSuggestToggle({ enabled: options.goalsAutoSuggest === true });
  const createForm = renderProjectGoalCreateForm({ tasks });
  let cardsHtml;
  if (goals.length === 0) {
    cardsHtml = `<p class="lab-project-empty">No active goals. Create one above to link related tasks for higher-level progress and cost attribution.</p>`;
  } else {
    const cards = goals.map((goal) => {
      let progress = null;
      try { progress = summarizeGoalProgress({ goal, tasks, runs }); } catch { progress = null; }
      return renderProjectGoalCard({ goal, progress, tasks });
    }).join("");
    cardsHtml = `<div class="lab-project-goals-grid">${cards}</div>`;
  }
  const unassigned = tasks.filter((t) => !t.goal_id);
  const unassignedHtml = renderProjectGoalsUnassignedTasks({ tasks: unassigned, goals });
  return `${autoSuggestToggle}${createForm}${cardsHtml}${unassignedHtml}`;
}






const PROMOTION_DIAGRAM_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

function renderServicePromotionFlow({ orientation = "horizontal" } = {}) {
  const isVertical = orientation === "vertical";
  const NODE_R = 18;
  const STRIDE = 180;



  const SHARED_X = isVertical ? 160 : 1588;
  const SHARED_Y = isVertical ? 1588 : 160;
  const position = isVertical
    ? { x: 160, y: SHARED_Y + STRIDE }
    : { x: SHARED_X + STRIDE, y: 160 };

  let inboundEdge;
  if (isVertical) {
    const head = position.y - NODE_R;
    const midY = (SHARED_Y + head) / 2;
    inboundEdge = `<path class="lab-project-service-edge lab-project-service-edge-trunk" d="M ${SHARED_X} ${SHARED_Y} C ${SHARED_X} ${midY}, ${position.x} ${midY}, ${position.x} ${head}" />`;
  } else {
    const head = position.x - NODE_R;
    const midX = (SHARED_X + head) / 2;
    inboundEdge = `<path class="lab-project-service-edge lab-project-service-edge-trunk" d="M ${SHARED_X} ${SHARED_Y} C ${midX} ${SHARED_Y}, ${midX} ${position.y}, ${head} ${position.y}" />`;
  }

  return `<g class="lab-project-service-promotion-flow">
    ${inboundEdge}
    <g class="lab-project-promotion-node" data-tone="review" transform="translate(${position.x},${position.y})">
      <rect class="lab-project-promotion-node-surface" x="-${NODE_R}" y="-${NODE_R}" width="${NODE_R * 2}" height="${NODE_R * 2}" rx="6" ry="6" />
      <g class="lab-project-promotion-node-icon" transform="translate(-11, -11)">${PROMOTION_DIAGRAM_ICON}</g>
      <text class="lab-project-promotion-node-label" x="0" y="${NODE_R + 18}" text-anchor="middle">Reviewable branch</text>
      <text class="lab-project-promotion-node-sub" x="0" y="${NODE_R + 32}" text-anchor="middle">manual landing</text>
    </g>
  </g>`;
}

function renderProjectPromotionPolicy(projectContext) {
  const overrides = projectContext?.roleConfig?.overrides?.merge_policy ?? {};
  const effective = projectContext?.roleConfig?.overrides?.effective_merge_policy ?? null;
  const configuredMode = typeof overrides.mode === "string" ? overrides.mode : effective?.mode;
  const legacyNotice = configuredMode && configuredMode !== "none"
    ? '<p class="lab-project-form-warning"><strong>Legacy configuration detected.</strong> Reliability RC does not expose or execute that promotion override from this UI.</p>'
    : "";

  return `
    <div class="lab-project-promotion-summary" role="note" aria-label="Reliability RC promotion policy">
      <span class="lab-project-promotion-badge">Reliability RC</span>
      <h3>Supervised manual promotion</h3>
      <p>Each attempt runs in an isolated worktree. Deterministic gates and a fresh review must produce canonical <code>PASS</code> before Niis creates one reviewable branch.</p>
      <p>The primary checkout stays untouched. Inspect the evidence and branch, then complete the final landing manually with your normal Git workflow.</p>
      ${legacyNotice}
    </div>`;
}

function renderProjectReviewForm(projectContext) {
  const overrides = projectContext?.roleConfig?.overrides ?? {};
  const llmReview = overrides.llm_review ?? {};
  const llmEnabledChecked = llmReview.enabled === true ? "checked" : "";
  const llmMode = typeof llmReview.mode === "string" ? llmReview.mode : "standard";



  const legacyPref = typeof llmReview.model_preference === "string" ? llmReview.model_preference : "";
  const prefs = llmReview.model_preferences && typeof llmReview.model_preferences === "object"
    ? llmReview.model_preferences
    : {};
  const codexPref = typeof prefs.codex_local === "string" ? prefs.codex_local : (legacyPref || "");
  const claudePref = typeof prefs.claude_code_local === "string" ? prefs.claude_code_local : (legacyPref || "");


  const adapterChecks = Array.isArray(projectContext?.doctor?.runtime_availability)
    ? projectContext.doctor.runtime_availability
    : [];
  const isInstalled = (id) => adapterChecks.some((c) => c.id === id && c.status === "ok");
  const codexInstalled = isInstalled("codex_local");
  const claudeInstalled = isInstalled("claude_code_local");




  const llmModeOptions = [
    { label: "fast + cheap", value: "standard" },
    { label: "deep + thorough", value: "adversarial" },
  ];
  const modeDescriptions = {
    off: "Only the deterministic completion proof runs: artifacts present, validators green, no out-of-scope edits. Cheapest and fastest path; doesn't catch logical defects in the change itself.",
    standard: "LLM judge reads the diff, brief and run summary, returns a JSON PASS/DEFECT verdict. Read-only — no side effects, no test execution. Cheap and fast, but limited to what's visible in the diff.",
    adversarial: "Spawns a detached worktree with shell + test access. The reviewer agent can run tests, inspect arbitrary files, replay scenarios. Slower and pricier; catches regressions that aren't visible in the diff alone.",
  };
  const modeDescHtml = `
    <div class="lab-project-review-mode-descs" aria-live="polite">
      <p class="lab-project-review-mode-desc" data-mode="off">${modeDescriptions.off}</p>
      <p class="lab-project-review-mode-desc" data-mode="standard">${modeDescriptions.standard}</p>
      <p class="lab-project-review-mode-desc" data-mode="adversarial">${modeDescriptions.adversarial}</p>
    </div>`;



  const modelInputsHtml = (codexInstalled || claudeInstalled)
    ? `
      ${codexInstalled ? `
        <label class="lab-project-form-field">
          <span>Codex model preference (optional)</span>
          <input class="lab-project-input" type="text" name="llm_review_model_preference_codex_local" value="${escapeHtml(codexPref)}" placeholder="leave blank for codex default" data-lab-project-autosave />
        </label>` : ""}
      ${claudeInstalled ? `
        <label class="lab-project-form-field">
          <span>Claude model preference (optional)</span>
          <input class="lab-project-input" type="text" name="llm_review_model_preference_claude_code_local" value="${escapeHtml(claudePref)}" placeholder="leave blank for claude default" data-lab-project-autosave />
        </label>` : ""}`
    : `<p class="lab-project-form-hint">No LLM runtimes detected on PATH. Install codex or claude to enable model preferences.</p>`;




  const modeChipsHtml = llmModeOptions.map((option) => `
    <label class="lab-project-review-mode-chip" data-mode="${escapeHtml(option.value)}">
      <input type="radio" name="llm_review_mode" value="${escapeHtml(option.value)}" ${llmMode === option.value ? "checked" : ""} data-lab-project-autosave />
      <span>${escapeHtml(option.label)}</span>
    </label>`).join("");
  return `
    <form method="post" action="/project/settings/review" class="lab-project-form">
      <div class="lab-project-review-canvas" role="group" aria-label="Review chain">
        <div class="lab-project-review-controls">
          <label class="lab-project-review-enable-switch" title="Toggle the LLM acceptance judge. When off, validator lane falls back to deterministic completion-proof.">
            <input type="checkbox" name="llm_review_enabled" value="1" ${llmEnabledChecked} data-lab-project-autosave />
            <span class="lab-project-review-enable-switch-track" aria-hidden="true"><span class="lab-project-review-enable-switch-thumb"></span></span>
            <span class="lab-project-review-enable-switch-label">LLM reviewer</span>
          </label>
          <div class="lab-project-review-mode-chips" role="radiogroup" aria-label="Reviewer mode">
            ${modeChipsHtml}
          </div>
        </div>
        ${modeDescHtml}
        <footer class="lab-project-review-canvas-footer">
          ${modelInputsHtml}
        </footer>
      </div>
    </form>`;
}




function resolveRoutingPolicyValues(projectContext) {
  const overrides = projectContext?.roleConfig?.overrides?.routing_policy ?? {};
  const policyDefaults = projectContext?.roleConfig?.routing_policy_defaults ?? {};
  const FALLBACK_TIERS = [
    { tier: "budget", max_score: 4 },
    { tier: "standard", max_score: 8 },
    { tier: "premium", max_score: Infinity },
  ];
  const FALLBACK_MAX_PARALLEL = 2;
  const tiers = Array.isArray(overrides.complexity_tiers)
    ? overrides.complexity_tiers
    : (Array.isArray(policyDefaults.complexity_tiers) ? policyDefaults.complexity_tiers : FALLBACK_TIERS);
  const defaultMaxParallel = Number.isInteger(policyDefaults.max_parallel) ? policyDefaults.max_parallel : FALLBACK_MAX_PARALLEL;
  const findTierMax = (tier) => {
    const entry = tiers.find((t) => t.tier === tier);
    if (!entry) return null;
    if (!Number.isFinite(entry.max_score)) return null;
    return entry.max_score;
  };
  return {
    overrides,
    findTierMax,
    findTierMaxStr: (tier) => {
      const v = findTierMax(tier);
      return v == null ? "" : String(v);
    },
    budgetMax: findTierMax("budget") ?? 4,
    standardMax: findTierMax("standard") ?? 8,
    maxParallel: Number.isInteger(overrides.max_parallel) ? overrides.max_parallel : defaultMaxParallel,
  };
}






function renderProjectFlowEngineCardHtml(projectContext) {
  const { maxParallel } = resolveRoutingPolicyValues(projectContext);
  const workerOverrides = projectContext?.roleConfig?.overrides?.autonomous_worker ?? {};
  const maxConcurrent = Number.isInteger(workerOverrides.max_concurrent) && workerOverrides.max_concurrent > 0
    ? workerOverrides.max_concurrent
    : 1;
  const MAX_PARALLEL_RANGE = 32;
  const activePct = ((maxParallel - 1) / (MAX_PARALLEL_RANGE - 1)) * 100;
  return `
    <form method="post" action="/project/settings" class="lab-project-flow-engine-card">
      <div class="lab-project-flow-engine-header">
        <div class="lab-project-flow-engine-title-block">
          <div class="lab-project-flow-engine-title">Parallel streams</div>
        </div>
        <div class="lab-project-flow-engine-stat">
          <span>Active: <span class="lab-project-rp-splitbar-num">${escapeHtml(String(maxParallel))}</span><span class="lab-project-flow-engine-stat-max"> / ${MAX_PARALLEL_RANGE}</span></span>
        </div>
      </div>
      <div class="lab-project-flow-engine-inner">
        <div class="lab-project-flow-engine-sparkles" aria-hidden="true">
          <span style="top:18%;--sparkle-size:2px;--sparkle-opacity:0.55;animation-delay:0s;animation-duration:4.2s"></span>
          <span style="top:42%;--sparkle-size:3px;--sparkle-opacity:0.9;animation-delay:0.7s;animation-duration:3.6s"></span>
          <span style="top:68%;--sparkle-size:1.5px;--sparkle-opacity:0.4;animation-delay:1.4s;animation-duration:4.6s"></span>
          <span style="top:28%;--sparkle-size:2.5px;--sparkle-opacity:0.7;animation-delay:2.1s;animation-duration:3.9s"></span>
          <span style="top:82%;--sparkle-size:1.5px;--sparkle-opacity:0.3;animation-delay:2.8s;animation-duration:4.4s"></span>
          <span style="top:56%;--sparkle-size:2px;--sparkle-opacity:0.6;animation-delay:3.5s;animation-duration:3.7s"></span>
        </div>
        <div class="lab-project-rp-splitbar lab-project-flow-engine-bar" data-target-input="routing-max-parallel-hero" role="slider" aria-label="Max parallel runs" aria-valuemin="1" aria-valuemax="${MAX_PARALLEL_RANGE}" aria-valuenow="${maxParallel}" tabindex="0">
          <div class="lab-project-rp-splitbar-active" style="width:${activePct}%">
            <span class="lab-project-rp-splitbar-handle" title="Drag to adjust"></span>
          </div>
        </div>
        <div class="lab-project-flow-engine-ticks" aria-hidden="true">
          <span>1</span><span>8</span><span>16</span><span>24</span><span>32</span>
        </div>
        <div class="lab-project-flow-engine-secondary">
          <label class="lab-project-flow-engine-stepper">
            <span class="lab-project-flow-engine-stepper-label">Concurrent tasks</span>
            <input type="number" name="max_concurrent" min="1" max="10" step="1" value="${escapeHtml(String(maxConcurrent))}" data-lab-project-autosave />
            <span class="lab-project-flow-engine-stepper-hint" title="How many tasks the autonomous worker picks up from the PENDING queue in parallel. Independent of Parallel streams (which controls subtask concurrency WITHIN one task).">?</span>
          </label>
        </div>
      </div>
      <input id="routing-max-parallel-hero" type="hidden" min="1" max="32" name="max_parallel" value="${escapeHtml(String(maxParallel))}" />
    </form>`;
}

const PROJECT_PAGE_SCRIPT = `
(function(){
  var modal = document.querySelector('[data-lab-file-modal]');
  if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
  if (modal) {
    var titleEl = modal.querySelector('[data-lab-file-modal-filename]');
    var metaEl  = modal.querySelector('[data-lab-file-modal-meta]');
    var bodyEl  = modal.querySelector('[data-lab-file-modal-body]');
    var paperEl = modal.querySelector('.lab-project-file-modal-paper');
    function openModal(){ modal.hidden = false; modal.setAttribute('aria-hidden','false'); document.body.style.overflow = 'hidden'; }
    function closeModal(){ modal.hidden = true; modal.setAttribute('aria-hidden','true'); document.body.style.overflow = ''; }
    modal.addEventListener('click', function(e){
      if (e.target.matches && e.target.matches('[data-lab-file-modal-close]')) closeModal();
    });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && !modal.hidden) closeModal();
    });

    function escapeHtmlClient(s){
      return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function renderMarkdown(src){
      var safe = escapeHtmlClient(src || '');
      safe = safe.replace(/\`\`\`(\\w+)?\\n?([\\s\\S]*?)\`\`\`/g, function(_, lang, code){
        var cls = lang ? ' class="language-' + lang + '"' : '';
        return '<pre' + cls + '><code' + cls + '>' + code + '</code></pre>';
      });
      var lines = safe.split('\\n');
      var out = []; var i = 0; var inList = false;
      while (i < lines.length) {
        var line = lines[i];
        if (line.indexOf('<pre>') === 0) {
          var preBuf = line;
          while (preBuf.indexOf('</pre>') === -1 && i + 1 < lines.length) { i++; preBuf += '\\n' + lines[i]; }
          if (inList) { out.push('</ul>'); inList = false; }
          out.push(preBuf); i++; continue;
        }
        var h = line.match(/^(#{1,3})\\s+(.+)$/);
        if (h) {
          if (inList) { out.push('</ul>'); inList = false; }
          out.push('<h' + h[1].length + '>' + h[2] + '</h' + h[1].length + '>');
          i++; continue;
        }
        var li = line.match(/^[\\s]*[-*]\\s+(.+)$/);
        if (li) {
          if (!inList) { out.push('<ul>'); inList = true; }
          out.push('<li>' + li[1] + '</li>');
          i++; continue;
        }
        if (line.trim() === '') {
          if (inList) { out.push('</ul>'); inList = false; }
          i++; continue;
        }
        if (inList) { out.push('</ul>'); inList = false; }
        out.push('<p>' + line + '</p>');
        i++;
      }
      if (inList) out.push('</ul>');
      var html = out.join('\\n');
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/(^|[^*])\\*([^*]+)\\*/g, '$1<em>$2</em>');
      return html;
    }

    function renderJson(obj){
      var json = JSON.stringify(obj, null, 2);
      return '<pre class="language-json"><code class="language-json">'
        + escapeHtmlClient(json) + '</code></pre>';
    }

    function formatSize(bytes){
      if (!Number.isFinite(bytes)) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    function renderFile(payload){
      if (!payload) {
        bodyEl.innerHTML = '<div class="lab-project-file-modal-error">Empty response.</div>';
        return;
      }
      titleEl.textContent = payload.filename || 'file';
      var metaBits = [];
      if (payload.path) metaBits.push(payload.path);
      if (Number.isFinite(payload.size)) metaBits.push(formatSize(payload.size));
      if (payload.modifiedAt) metaBits.push(payload.modifiedAt);
      metaEl.textContent = metaBits.join(' · ');

      if (paperEl) paperEl.setAttribute('data-kind', payload.kind === 'json' ? 'json' : 'md');

      if (payload.missing) {
        bodyEl.innerHTML = '<p class="lab-project-file-modal-empty">This file has not been generated yet. Run <code>niis attach</code> / <code>niis init</code> in the workspace.</p>';
        return;
      }
      if (payload.error) {
        bodyEl.innerHTML = '<div class="lab-project-file-modal-error">' + escapeHtmlClient(payload.error) + '</div>';
        return;
      }
      if (payload.kind === 'md') {
        bodyEl.innerHTML = renderMarkdown(payload.content);
      } else {
        var parsed = null;
        try { parsed = JSON.parse(payload.content); } catch (err) {
          bodyEl.innerHTML = '<div class="lab-project-file-modal-error">JSON parse failed: ' + escapeHtmlClient(err.message) + '</div>';
          return;
        }
        bodyEl.innerHTML = renderJson(parsed);
      }
      if (window.Prism && typeof window.Prism.highlightAllUnder === 'function') {
        window.Prism.highlightAllUnder(bodyEl);
      } else {
        window.addEventListener('load', function once(){
          window.removeEventListener('load', once);
          if (window.Prism) window.Prism.highlightAllUnder(bodyEl);
        });
      }
    }

    var openFileId = null;
    var availableViews = [];
    var canGenerateHtml = false;
    var viewsEl = modal && modal.querySelector('[data-lab-file-views]');
    var renderHtmlAdapterSelect = modal && modal.querySelector('[data-lab-render-html-adapter]');
    var renderHtmlBtn = modal && modal.querySelector('[data-lab-render-html]');
    var renderHtmlLabel = modal && modal.querySelector('[data-lab-render-html-label]');
    var renderAdapterLabels = { claude: 'Claude', codex: 'Codex' };
    var codemapFilter = { lang: null, kind: null, query: '' };
    var codemapSnapshot = null;
    function applyCodemapFilter(root){
      var files = root.querySelectorAll('.cv-file');
      for (var i = 0; i < files.length; i++){
        var f = files[i];
        var ok = true;
        if (codemapFilter.lang && f.getAttribute('data-lang') !== codemapFilter.lang) ok = false;
        if (codemapFilter.kind && f.getAttribute('data-kind') !== codemapFilter.kind) ok = false;
        if (codemapFilter.query) {
          var p = (f.getAttribute('data-path') || '').toLowerCase();
          if (p.indexOf(codemapFilter.query) === -1) ok = false;
        }
        f.hidden = !ok;
      }
      var dirs = root.querySelectorAll('.cv-dir');
      for (var j = dirs.length - 1; j >= 0; j--){
        var d = dirs[j];
        var anyVisible = d.querySelector('.cv-file:not([hidden])');
        d.hidden = !anyVisible;
        if (codemapFilter.query && anyVisible) d.open = true;
      }
    }
    function wireCodemapHandlers(){
      var root = bodyEl.querySelector('.codemap-view');
      if (!root) return;
      root.querySelectorAll('[data-filter-lang]').forEach(function(b){
        b.setAttribute('data-active', b.getAttribute('data-filter-lang') === codemapFilter.lang ? '1' : '0');
      });
      root.querySelectorAll('[data-filter-kind]').forEach(function(b){
        b.setAttribute('data-active', b.getAttribute('data-filter-kind') === codemapFilter.kind ? '1' : '0');
      });
      var search = root.querySelector('[data-cv-search]');
      if (search) search.value = codemapFilter.query;
      applyCodemapFilter(root);
      root.querySelectorAll('[data-filter-lang]').forEach(function(btn){
        btn.addEventListener('click', function(){
          var v = btn.getAttribute('data-filter-lang');
          codemapFilter.lang = codemapFilter.lang === v ? null : v;
          root.querySelectorAll('[data-filter-lang]').forEach(function(b){
            b.setAttribute('data-active', b.getAttribute('data-filter-lang') === codemapFilter.lang ? '1' : '0');
          });
          applyCodemapFilter(root);
        });
      });
      root.querySelectorAll('[data-filter-kind]').forEach(function(btn){
        btn.addEventListener('click', function(){
          var v = btn.getAttribute('data-filter-kind');
          codemapFilter.kind = codemapFilter.kind === v ? null : v;
          root.querySelectorAll('[data-filter-kind]').forEach(function(b){
            b.setAttribute('data-active', b.getAttribute('data-filter-kind') === codemapFilter.kind ? '1' : '0');
          });
          applyCodemapFilter(root);
        });
      });
      if (search) search.addEventListener('input', function(){
        codemapFilter.query = (search.value || '').toLowerCase();
        applyCodemapFilter(root);
      });
      root.querySelectorAll('a[data-cv-source]').forEach(function(a){
        a.addEventListener('click', function(ev){
          ev.preventDefault();
          var p = a.getAttribute('data-cv-source');
          codemapSnapshot = bodyEl.innerHTML;
          fetch('/__niis/source-file?id=codemap&path=' + encodeURIComponent(p), { credentials: 'same-origin' })
            .then(function(r){
              return r.text().then(function(t){
                if (!r.ok) throw new Error(t || ('HTTP ' + r.status));
                return t;
              });
            })
            .then(function(text){ showCodemapSource(p, text); })
            .catch(function(err){ showCodemapSource(p, null, err.message || String(err)); });
        });
      });
    }
    function isFullHtmlDocument(text){
      var head = String(text || "").trimStart().slice(0, 100).toLowerCase();
      return head.startsWith('<!doctype') || head.startsWith('<html');
    }
    function showCodemapSource(p, text, errMsg){
      bodyEl.innerHTML =
        '<div class="cv-source">' +
          '<div class="cv-source-bar">' +
            '<button type="button" class="cv-source-back">&larr; codemap</button>' +
            '<span class="cv-source-path">' + escapeHtmlClient(p) + '</span>' +
          '</div>' +
          '<div class="cv-source-body" data-cv-source-body></div>' +
        '</div>';
      var sourceBody = bodyEl.querySelector('[data-cv-source-body]');
      if (errMsg) {
        sourceBody.innerHTML = '<div class="cv-source-error">' + escapeHtmlClient(errMsg) + '</div>';
      } else {
        var fullHtml = isFullHtmlDocument(text);
        if (fullHtml) {
          sourceBody.className = 'cv-source-rendered cv-source-rendered-html-doc';
          mountHtmlDocumentInSandbox(sourceBody, text || '');
        } else {
          var lower = (p || '').toLowerCase();
          var isMarkdown = /\\.(md|markdown)$/.test(lower);
          var isHtml = /\\.(html?)$/.test(lower);
          if (isMarkdown) {
            sourceBody.className = 'cv-source-rendered cv-source-rendered-md';
            sourceBody.innerHTML = renderMarkdown(text || '');
          } else if (isHtml) {
            sourceBody.className = 'cv-source-rendered cv-source-rendered-html';
            sourceBody.innerHTML = text || '';
          } else {
            sourceBody.outerHTML = '<pre class="cv-source-pre"><code>' + escapeHtmlClient(text) + '</code></pre>';
          }
        }
      }
      bodyEl.querySelector('.cv-source-back').addEventListener('click', function(){
        if (codemapSnapshot === null) return;
        bodyEl.innerHTML = codemapSnapshot;
        codemapSnapshot = null;
        wireCodemapHandlers();
      });
    }
    function renderViewHtml(text){
      if (isFullHtmlDocument(text)) {
        mountHtmlDocumentInSandbox(bodyEl, text);
        codemapSnapshot = null;
        return;
      }
      bodyEl.innerHTML = text;
      codemapSnapshot = null;
      wireCodemapHandlers();
    }
    function mountHtmlDocumentInSandbox(host, text){
      host.textContent = '';
      var frame = document.createElement('iframe');
      frame.className = 'lab-project-file-modal-preview';
      frame.setAttribute('sandbox', '');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('title', 'Generated artifact preview');
      frame.srcdoc = text;
      host.appendChild(frame);
    }
    function setActiveTab(viewName){
      if (paperEl) {
        if (viewName === 'raw' || !viewName) paperEl.removeAttribute('data-view');
        else paperEl.setAttribute('data-view', viewName);
      }
      if (!viewsEl) return;
      var tabs = viewsEl.querySelectorAll('[data-lab-view]');
      for (var i = 0; i < tabs.length; i++){
        var t = tabs[i];
        var on = t.getAttribute('data-lab-view') === viewName;
        t.setAttribute('data-active', on ? '1' : '0');
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      }
    }
    function setRenderHtmlLoading(isLoading){
      if (!renderHtmlBtn) return;
      renderHtmlBtn.disabled = !!isLoading || !canGenerateHtml || !openFileId;
      renderHtmlBtn.setAttribute('aria-busy', isLoading ? 'true' : 'false');
      renderHtmlBtn.setAttribute('data-loading', isLoading ? '1' : '0');
      if (renderHtmlAdapterSelect) renderHtmlAdapterSelect.disabled = !!isLoading || !canGenerateHtml || !openFileId;
      if (renderHtmlLabel) renderHtmlLabel.textContent = isLoading ? 'Generating…' : 'Regenerate';
    }
    function syncRenderHtmlButton(){
      if (!renderHtmlBtn) return;
      renderHtmlBtn.hidden = !canGenerateHtml || !openFileId;
      if (renderHtmlAdapterSelect) renderHtmlAdapterSelect.hidden = !canGenerateHtml || !openFileId;
      setRenderHtmlLoading(false);
    }
    function getRenderHtmlAdapter(){
      var value = renderHtmlAdapterSelect ? renderHtmlAdapterSelect.value : 'claude';
      return renderAdapterLabels[value] ? value : 'claude';
    }
    function getRenderHtmlAdapterLabel(adapterId){
      return renderAdapterLabels[adapterId] || renderAdapterLabels.claude;
    }
    function renderHtmlGenerationStatus(adapterLabel){
      return '<div class="lab-project-file-modal-render-status">' +
        '<p class="lab-project-file-modal-render-status-title">Generating HTML with ' + escapeHtmlClient(adapterLabel) + '...</p>' +
        '<p>This can take a minute or two. You can close this dialog; closing it will not cancel the server-side render.</p>' +
        '<p>If the dialog stays open, the refreshed HTML will appear automatically when generation finishes.</p>' +
      '</div>';
    }
    function fetchView(viewName){
      if (!openFileId) return;
      setActiveTab(viewName);
      if (viewName === 'raw') {
        bodyEl.innerHTML = '<p class="lab-project-file-modal-empty">Fetching file…</p>';
        fetch('/__niis/project-file/' + encodeURIComponent(openFileId), { credentials: 'same-origin' })
          .then(function(r){ return r.json(); }).then(renderFile)
          .catch(function(err){ bodyEl.innerHTML = '<div class="lab-project-file-modal-error">Fetch failed: ' + escapeHtmlClient(err.message || String(err)) + '</div>'; });
        return;
      }
      bodyEl.innerHTML = '<p class="lab-project-file-modal-empty">Loading view…</p>';
      fetch('/__niis/project-file/' + encodeURIComponent(openFileId) + '?view=' + encodeURIComponent(viewName), { credentials: 'same-origin' })
        .then(function(r){
          if (r.status === 404 && viewName === 'html') {
            fetchView('raw');
            return null;
          }
          if (!r.ok) throw new Error('view ' + viewName + ' unavailable (' + r.status + ')');
          return r.text();
        })
        .then(function(text){
          if (text === null) return;
          if (viewName === 'html') return renderViewHtml(text);
          bodyEl.innerHTML = text;
        })
        .catch(function(err){
          bodyEl.innerHTML = '<div class="lab-project-file-modal-error">' + escapeHtmlClient(err.message || String(err)) + '</div>';
        });
    }
    if (viewsEl) {
      viewsEl.addEventListener('click', function(e){
        var t = e.target.closest && e.target.closest('[data-lab-view]');
        if (!t) return;
        var v = t.getAttribute('data-lab-view');
        fetchView(v);
      });
    }
    if (renderHtmlBtn) {
      renderHtmlBtn.addEventListener('click', function(e){
        e.preventDefault();
        if (!openFileId || !canGenerateHtml || renderHtmlBtn.disabled) return;
        var renderFileId = openFileId;
        var renderAdapterId = getRenderHtmlAdapter();
        var renderAdapterLabel = getRenderHtmlAdapterLabel(renderAdapterId);
        setActiveTab('html');
        setRenderHtmlLoading(true);
        bodyEl.innerHTML = renderHtmlGenerationStatus(renderAdapterLabel);
        fetch('/__niis/project-file/' + encodeURIComponent(renderFileId) + '/render-html?adapter=' + encodeURIComponent(renderAdapterId), {
          credentials: 'same-origin',
          method: 'POST',
        })
          .then(function(r){
            return r.json().catch(function(){ return {}; }).then(function(payload){
              if (!r.ok) throw new Error(payload.error || ('Claude render failed (' + r.status + ')'));
              return payload;
            });
          })
          .then(function(payload){
            if (openFileId !== renderFileId) return;
            availableViews = Array.isArray(payload?.views) ? payload.views : Array.from(new Set(availableViews.concat(['html'])));
            if (viewsEl) {
              viewsEl.hidden = false;
              var tabs = viewsEl.querySelectorAll('[data-lab-view]');
              for (var i = 0; i < tabs.length; i++){
                var name = tabs[i].getAttribute('data-lab-view');
                tabs[i].hidden = (name !== 'raw' && availableViews.indexOf(name) === -1);
              }
            }
            fetchView('html');
          })
          .catch(function(err){
            if (openFileId !== renderFileId) return;
            bodyEl.innerHTML = '<div class="lab-project-file-modal-error">' + escapeHtmlClient(renderAdapterLabel) + ' render failed: ' + escapeHtmlClient(err.message || String(err)) + '</div>';
          })
          .finally(function(){
            if (openFileId === renderFileId) setRenderHtmlLoading(false);
          });
      });
    }

    document.addEventListener('click', function(e){
      var btn = e.target.closest && e.target.closest('[data-lab-file-id]');
      if (!btn || btn.disabled) return;
      var id = btn.getAttribute('data-lab-file-id');
      var kind = btn.getAttribute('data-lab-file-kind') === 'json' ? 'json' : 'md';
      if (paperEl) paperEl.setAttribute('data-kind', kind);
      titleEl.textContent = btn.querySelector('.lab-project-flow-paper-title')?.textContent || id;
      metaEl.textContent = 'Loading…';
      bodyEl.innerHTML = '<p class="lab-project-file-modal-empty">Fetching file…</p>';
      openFileId = id;
      canGenerateHtml = false;
      setActiveTab('raw');
      if (viewsEl) viewsEl.hidden = true;
      syncRenderHtmlButton();
      openModal();
      fetch('/__niis/project-file/' + encodeURIComponent(id), { credentials: 'same-origin' })
        .then(function(r){ return r.json(); })
        .then(function(payload){
          availableViews = Array.isArray(payload?.views) ? payload.views : [];
          canGenerateHtml = payload?.canGenerateHtml === true;
          if (viewsEl) {
            viewsEl.hidden = availableViews.length === 0;
            var tabs = viewsEl.querySelectorAll('[data-lab-view]');
            for (var i = 0; i < tabs.length; i++){
              var name = tabs[i].getAttribute('data-lab-view');
              tabs[i].hidden = (name !== 'raw' && availableViews.indexOf(name) === -1);
            }
          }
          syncRenderHtmlButton();
          renderFile(payload);
        })
        .catch(function(err){
          bodyEl.innerHTML = '<div class="lab-project-file-modal-error">Fetch failed: ' + escapeHtmlClient(err && err.message ? err.message : String(err)) + '</div>';
        });
    });
  }

  function setProjectHealthFilter(zone){
    var drawer = document.querySelector('[data-lab-health-drawer]');
    if (!drawer) return;
    var activeZone = zone || '';
    drawer.hidden = false;
    drawer.setAttribute('data-active-zone', activeZone);
    document.querySelectorAll('[data-lab-health-marker]').forEach(function(marker){
      marker.toggleAttribute('data-active', !!activeZone && marker.getAttribute('data-zone') === activeZone);
    });
    var firstVisible = null;
    drawer.querySelectorAll('[data-lab-health-record]').forEach(function(record){
      var match = !activeZone || record.getAttribute('data-zone') === activeZone;
      record.hidden = false;
      record.removeAttribute('data-expanded');
      var toggle = record.querySelector('[data-lab-health-record-toggle]');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
      if (match && !firstVisible) firstVisible = record;
    });
    if (firstVisible) {
      firstVisible.setAttribute('data-expanded', '');
      var firstToggle = firstVisible.querySelector('[data-lab-health-record-toggle]');
      if (firstToggle) firstToggle.setAttribute('aria-expanded', 'true');
      firstVisible.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function projectHealthEscapeHtml(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  var projectHealthZoneLabels = {
    'task-in': 'Task in',
    'project-artifacts': 'Project artifacts',
    adapters: 'Adapter pool',
    validators: 'Validators',
    'llm-reviewer': 'LLM reviewer',
    proof: 'Completion proof',
    verdict: 'Verdict',
    delivery: 'Delivery'
  };

  var projectHealthMarkerTargets = {
    adapters: { selector: '.lab-project-flow-adapter-pool', placement: 'afterbegin', label: 'Adapter pool', extraClass: '' },
    validators: { selector: '.lab-project-flow-validators-pool', placement: 'afterbegin', label: 'Validators', extraClass: '' },
    'llm-reviewer': { selector: '.lab-project-flow-pipeline-block-reviewer', placement: 'afterbegin', label: 'LLM reviewer', extraClass: '' },
    proof: { selector: '.lab-project-flow-pipeline-block-proof', placement: 'afterbegin', label: 'Completion proof', extraClass: '' },
    verdict: { selector: '.lab-project-flow-pipeline-block-verdict', placement: 'afterbegin', label: 'Verdict', extraClass: '' },
    delivery: { selector: '.lab-project-flow-stage', placement: 'beforeend', label: 'Delivery', extraClass: ' lab-project-health-marker--delivery' }
  };

  function projectHealthIconHtml(status){
    if (status === 'error') {
      return '<svg class="lab-project-health-warning-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M11.9998 8.99999V13M11.9998 17H12.0098M10.6151 3.89171L2.39019 18.0983C1.93398 18.8863 1.70588 19.2803 1.73959 19.6037C1.769 19.8857 1.91677 20.142 2.14613 20.3088C2.40908 20.5 2.86435 20.5 3.77487 20.5H20.2246C21.1352 20.5 21.5904 20.5 21.8534 20.3088C22.0827 20.142 22.2305 19.8857 22.2599 19.6037C22.2936 19.2803 22.0655 18.8863 21.6093 18.0983L13.3844 3.89171C12.9299 3.10654 12.7026 2.71396 12.4061 2.58211C12.1474 2.4671 11.8521 2.4671 11.5935 2.58211C11.2969 2.71396 11.0696 3.10655 10.6151 3.89171Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    return '<svg class="lab-project-health-warning-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M12 8V12M12 16H12.01M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function projectHealthWorstStatus(issues){
    if ((issues || []).some(function(issue){ return issue.status === 'error'; })) return 'error';
    if ((issues || []).some(function(issue){ return issue.status === 'warning'; })) return 'warning';
    return 'ok';
  }

  function projectHealthMarkerHtml(zone, zoneIssues, target){
    var status = projectHealthWorstStatus(zoneIssues);
    var readable = status === 'error' ? 'danger' : 'warning';
    var label = target.label || projectHealthZoneLabels[zone] || zone;
    var title = label + ': ' + zoneIssues.length + ' ' + readable + (zoneIssues.length === 1 ? '' : 's');
    return '<button type="button" class="lab-project-health-marker' + (target.extraClass || '') + '" data-lab-health-marker data-zone="' + projectHealthEscapeHtml(zone) + '" data-status="' + projectHealthEscapeHtml(status) + '" aria-label="' + projectHealthEscapeHtml(title) + '" title="' + projectHealthEscapeHtml(title) + '">' + projectHealthIconHtml(status) + '</button>';
  }

  function projectHealthRenderRows(issue){
    var rows = [{
      title: issue.summary || issue.title,
      meta: 'now',
      detail: projectHealthZoneLabels[issue.zone] || issue.zone
    }];
    if (issue.details) {
      rows.push({
        title: issue.details,
        meta: 'recorded',
        detail: issue.source ? 'Source: ' + issue.source : ''
      });
    }
    if (issue.fix && !issue.fix.action) {
      var fixText = issue.fix.command || issue.fix.description || '';
      if (fixText) rows.push({ title: fixText, meta: 'manual', detail: 'Suggested operator action', code: true });
    }
    return rows.map(function(row){
      return '<div class="lab-project-health-drawer-timeline-row"><div><strong' + (row.code ? ' class="lab-project-health-drawer-timeline-code"' : '') + '>' + projectHealthEscapeHtml(row.title) + '</strong>' + (row.detail ? '<span>' + projectHealthEscapeHtml(row.detail) + '</span>' : '') + '</div><em>' + projectHealthEscapeHtml(row.meta) + '</em></div>';
    }).join('');
  }

  function projectHealthRenderFix(issue){
    if (!issue.fix || typeof issue.fix !== 'object') return '';
    var command = issue.fix.command || '';
    var description = issue.fix.description || '';
    var action = issue.fix.action || '';
    if (!action) {
      if (!command && !description) return '';
      return '<div class="lab-project-health-drawer-fix"><span class="lab-project-health-drawer-fix-label">Manual fix</span>' + (command ? '<code>' + projectHealthEscapeHtml(command) + '</code>' : '') + (description ? '<p>' + projectHealthEscapeHtml(description) + '</p>' : '') + '</div>';
    }
    return '<div class="lab-project-health-drawer-fix" data-lab-health-fix-row><button type="button" class="lab-project-services-fix-button lab-project-health-drawer-fix-button" data-lab-health-fix-run="' + projectHealthEscapeHtml(action) + '"><span class="lab-project-services-fix-button-label">Run fix</span>' + (command ? '<code class="lab-project-services-fix-button-cmd">' + projectHealthEscapeHtml(command) + '</code>' : '') + '</button>' + (description ? '<div class="lab-project-services-fix-desc">' + projectHealthEscapeHtml(description) + '</div>' : '') + '</div>';
  }

  function projectHealthRecordHtml(issue, index, expanded){
    var zoneLabel = projectHealthZoneLabels[issue.zone] || issue.zone;
    return '<article class="lab-project-health-drawer-record" data-lab-health-record data-zone="' + projectHealthEscapeHtml(issue.zone) + '" data-status="' + projectHealthEscapeHtml(issue.status) + '"' + (expanded ? ' data-expanded' : '') + '><button type="button" class="lab-project-health-drawer-record-head" data-lab-health-record-toggle aria-expanded="' + (expanded ? 'true' : 'false') + '"><span class="lab-project-health-drawer-chevron" aria-hidden="true"></span><span class="lab-project-health-drawer-record-index">' + projectHealthEscapeHtml(String(index + 1)) + '</span><span class="lab-project-health-drawer-record-title"><strong>' + projectHealthEscapeHtml(issue.title) + '</strong><em>' + projectHealthEscapeHtml(zoneLabel) + '</em></span></button><div class="lab-project-health-drawer-record-body"><p class="lab-project-health-drawer-record-summary">' + projectHealthEscapeHtml(issue.summary || issue.title) + '</p><div class="lab-project-health-drawer-timeline">' + projectHealthRenderRows(issue) + '</div>' + projectHealthRenderFix(issue) + '</div></article>';
  }

  function projectHealthDrawerHtml(issues){
    var list = (issues || []).filter(function(issue){ return issue.status === 'warning' || issue.status === 'error'; });
    if (list.length === 0) return '';
    var status = projectHealthWorstStatus(list);
    var title = status === 'error' ? 'Danger' : 'Warning';
    return '<aside class="lab-project-health-drawer" data-lab-health-drawer data-status="' + projectHealthEscapeHtml(status) + '" aria-label="Project health attention"><header class="lab-project-health-drawer-head"><div><h3>' + projectHealthEscapeHtml(title) + '</h3><p>Project problems <span>(' + projectHealthEscapeHtml(String(list.length)) + ' recorded)</span></p></div><button type="button" class="lab-project-health-drawer-close" data-lab-health-close aria-label="Close project health drawer"><span aria-hidden="true">×</span></button></header><div class="lab-project-health-drawer-list">' + list.map(function(issue, index){ return projectHealthRecordHtml(issue, index, index === 0); }).join('') + '</div></aside>';
  }

  function refreshProjectHealthUi(issues){
    var list = (Array.isArray(issues) ? issues : []).filter(function(issue){ return issue.status === 'warning' || issue.status === 'error'; });
    var byZone = {};
    list.forEach(function(issue){
      (byZone[issue.zone] || (byZone[issue.zone] = [])).push(issue);
    });
    document.querySelectorAll('[data-lab-health-marker]').forEach(function(marker){
      var zone = marker.getAttribute('data-zone') || '';
      var zoneIssues = byZone[zone] || [];
      if (zoneIssues.length === 0) {
        marker.remove();
        return;
      }
      var target = projectHealthMarkerTargets[zone] || { label: projectHealthZoneLabels[zone] || zone, extraClass: '' };
      marker.outerHTML = projectHealthMarkerHtml(zone, zoneIssues, target);
      delete byZone[zone];
    });
    Object.keys(byZone).forEach(function(zone){
      var target = projectHealthMarkerTargets[zone];
      if (!target) return;
      var host = document.querySelector(target.selector);
      if (!host) return;
      host.insertAdjacentHTML(target.placement || 'afterbegin', projectHealthMarkerHtml(zone, byZone[zone], target));
    });
    var oldDrawer = document.querySelector('[data-lab-health-drawer]');
    var html = projectHealthDrawerHtml(list);
    if (!html) {
      if (oldDrawer) oldDrawer.remove();
      return;
    }
    if (oldDrawer) oldDrawer.outerHTML = html;
    else {
      var overlay = document.querySelector('.lab-project-hero-info-overlay');
      if (overlay) overlay.insertAdjacentHTML('afterbegin', html);
    }
  }

  function projectHealthMeterHtml(){
    var bars = '';
    for (var i = 0; i < 24; i++) bars += '<span class="lab-project-services-meter-bar"></span>';
    return '<div class="lab-project-services-meter" role="status" aria-label="Running fix">' + bars + '</div>';
  }

  function refreshProjectServicesStatus(){
    return fetch('/__niis/services-status', { headers: { 'accept': 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(data){
        if (!data) return;
        var nodes = document.querySelectorAll('.lab-project-service-node');
        for (var i = 0; i < nodes.length; i++) {
          var id = nodes[i].getAttribute('data-id');
          var entry = data.nodes && data.nodes[id];
          if (!entry) continue;
          nodes[i].setAttribute('data-status', entry.status);
          try { nodes[i].setAttribute('data-popover', JSON.stringify(entry.payload)); } catch(_) {}
        }
        var badge = document.querySelector('.lab-project-system-badge');
        if (badge && data.system_status) {
          badge.setAttribute('data-status', data.system_status);
          var label = badge.querySelector('.lab-project-system-badge-label');
            if (label) label.textContent = data.system_status;
          }
        if (Array.isArray(data.project_health_issues)) {
          refreshProjectHealthUi(data.project_health_issues);
        }
      })
      .catch(function(){});
  }

  document.addEventListener('click', function(e){
    var marker = e.target.closest && e.target.closest('[data-lab-health-marker]');
    if (marker) {
      e.preventDefault();
      setProjectHealthFilter(marker.getAttribute('data-zone') || '');
      var drawer = document.querySelector('[data-lab-health-drawer]');
      if (drawer) drawer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    var recordToggle = e.target.closest && e.target.closest('[data-lab-health-record-toggle]');
    if (recordToggle) {
      e.preventDefault();
      var record = recordToggle.closest('[data-lab-health-record]');
      var drawerForRecord = recordToggle.closest('[data-lab-health-drawer]');
      if (!record || !drawerForRecord) return;
      var shouldExpand = !record.hasAttribute('data-expanded');
      drawerForRecord.querySelectorAll('[data-lab-health-record]').forEach(function(item){
        var expanded = shouldExpand && item === record;
        item.toggleAttribute('data-expanded', expanded);
        var itemToggle = item.querySelector('[data-lab-health-record-toggle]');
        if (itemToggle) itemToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      });
      return;
    }
    var fixButton = e.target.closest && e.target.closest('[data-lab-health-fix-run]');
    if (fixButton) {
      e.preventDefault();
      e.stopPropagation();
      var action = fixButton.getAttribute('data-lab-health-fix-run');
      if (!action || fixButton.disabled) return;
      var fixRow = fixButton.closest('[data-lab-health-fix-row]');
      fixButton.disabled = true;
      if (fixRow) {
        fixRow.innerHTML = projectHealthMeterHtml() + '<div class="lab-project-services-fix-desc lab-project-services-fix-status">Running ' + projectHealthEscapeHtml(action) + '…</div>';
      }
      fetch('/__niis/run-fix', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
        body: 'action=' + encodeURIComponent(action),
      }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
        .then(function(res){
          if (fixRow) {
            if (res.ok && res.body && res.body.ok) {
              fixRow.innerHTML = '<div class="lab-project-services-fix-status lab-project-services-fix-status-ok">' + projectHealthEscapeHtml(res.body.summary || 'Done') + '</div>';
            } else {
              var msg = (res.body && (res.body.error || res.body.summary)) || ('HTTP ' + (res.ok ? '200' : 'error'));
              fixRow.innerHTML = '<div class="lab-project-services-fix-status lab-project-services-fix-status-error">' + projectHealthEscapeHtml(msg) + '</div>';
            }
          }
          return refreshProjectServicesStatus();
        })
        .catch(function(err){
          if (fixRow) fixRow.innerHTML = '<div class="lab-project-services-fix-status lab-project-services-fix-status-error">' + projectHealthEscapeHtml(String(err && err.message || err)) + '</div>';
        });
      return;
    }
    var filter = e.target.closest && e.target.closest('[data-lab-health-filter]');
    if (filter) {
      e.preventDefault();
      setProjectHealthFilter(filter.getAttribute('data-lab-health-filter') || '');
      return;
    }
    if (e.target.closest && e.target.closest('[data-lab-health-close]')) {
      e.preventDefault();
      var drawerToClose = document.querySelector('[data-lab-health-drawer]');
      if (drawerToClose) {
        drawerToClose.hidden = true;
        drawerToClose.setAttribute('data-active-zone', '');
      }
      document.querySelectorAll('[data-lab-health-marker]').forEach(function(markerEl){
        markerEl.removeAttribute('data-active');
      });
    }
  });

  document.addEventListener('change', function(e){
    if (!e.target.matches || !e.target.matches('[data-lab-project-pref-toggle]')) return;
    var input = e.target;
    var form = input.closest('form');
    if (!form) return;
    form.submit();
  });

  document.addEventListener('click', function(e){
    var btn = e.target.closest && e.target.closest('[data-stepper-step]');
    if (!btn) return;
    var step = Number(btn.getAttribute('data-stepper-step') || '0');
    var wrap = btn.closest('.lab-project-stepper');
    if (!wrap) return;
    var input = wrap.querySelector('[data-stepper-input]');
    if (!input) return;
    var min = Number(input.getAttribute('min') || '-Infinity');
    var max = Number(input.getAttribute('max') || 'Infinity');
    var current = Number(input.value || '0');
    var next = current + step;
    if (next < min) next = min;
    if (next > max) next = max;
    input.value = String(next);
    var form = wrap.closest('form');
    if (form) form.submit();
  });

  document.addEventListener('input', function(e){
    if (!e.target.matches || !e.target.matches('[data-counter-source]')) return;
    var ta = e.target;
    var max = Number(ta.getAttribute('maxlength') || '200');
    var counterId = ta.getAttribute('data-counter-target');
    var counter = counterId ? document.getElementById(counterId) : null;
    if (counter) counter.textContent = ta.value.length + '/' + max;
  });

  function setConstellationActive(state, sourcePanel){
    var stage = document.querySelector('.lab-project-constellation');
    if (stage) stage.setAttribute('data-active', state);
    var heroStage = document.querySelector('.lab-project-hero-stage');
    if (heroStage) heroStage.setAttribute('data-active', state);
    document.querySelectorAll('[data-lab-project-target]').forEach(function(p){
      if (p === sourcePanel) {
        p.classList.add('lab-project-panel-active');
      } else {
        p.classList.remove('lab-project-panel-active');
      }
    });
  }
  document.addEventListener('click', function(e){
    var panel = e.target.closest && e.target.closest('[data-lab-project-target]');
    if (panel) {
      var inControl = e.target.closest && e.target.closest('input, select, textarea, button, a, label');
      var state = panel.getAttribute('data-lab-project-target');
      setConstellationActive(state, panel);
      if (!inControl) {
        panel.setAttribute('tabindex', panel.getAttribute('tabindex') || '-1');
      }
      return;
    }
    var anyActive = document.querySelector('.lab-project-panel-active');
    if (anyActive) {
      setConstellationActive('info', null);
    }
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') setConstellationActive('info', null);
  });

  var autosaveTimer = null;
  function showAutosaveAck(form, ok){
    if (!form) return;
    var ack = form.querySelector('[data-autosave-ack]');
    if (!ack) {
      ack = document.createElement('span');
      ack.setAttribute('data-autosave-ack', '');
      ack.className = 'lab-project-rp-autosave-ack';
      form.appendChild(ack);
    }
    ack.innerHTML = ok
      ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8 6.5 11.5 13 4.5"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
    ack.classList.toggle('lab-project-rp-autosave-ack-error', !ok);
    ack.classList.add('lab-project-rp-autosave-ack-visible');
    clearTimeout(ack._hideTimer);
    ack._hideTimer = setTimeout(function(){
      ack.classList.remove('lab-project-rp-autosave-ack-visible');
    }, 1400);
  }
  function scheduleAutosave(form, delay){
    if (!form) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function(){
      autosaveTimer = null;
      var body;
      try {
        var params = new URLSearchParams();
        var fd = new FormData(form);
        fd.forEach(function(value, key){
          if (typeof value === 'string') params.append(key, value);
        });
        body = params;
      } catch (e) { return; }
      var action = form.getAttribute('action') || window.location.pathname;
      var method = (form.getAttribute('method') || 'POST').toUpperCase();
      fetch(action, {
        method: method,
        body: body,
        credentials: 'same-origin',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      }).then(function(res){
        showAutosaveAck(form, res.ok || (res.status >= 200 && res.status < 400));
      }).catch(function(err){
        console.warn('autosave failed', err);
        showAutosaveAck(form, false);
      });
    }, typeof delay === 'number' ? delay : 400);
  }

  document.addEventListener('change', function(e){
    if (!e.target.matches || !e.target.matches('[data-lab-project-autosave]')) return;
    var form = e.target.form || (e.target.closest && e.target.closest('form'));
    if (form) scheduleAutosave(form, 0);
  });

  function valueToActivePct(value, min, max){
    var raw = ((value - min) / (max - min)) * 100;
    return Math.max(0, Math.min(raw, 100));
  }
  function applySplitbarValue(state, raw){
    var clamped = Math.max(state.min, Math.min(state.max, Math.round(raw)));
    var pct = valueToActivePct(clamped, state.min, state.max);
    if (state.activeZone) state.activeZone.style.width = pct + '%';
    if (state.num) state.num.textContent = String(clamped);
    var headroom = Math.max(0, state.max - clamped);
    if (state.headnum) state.headnum.textContent = String(headroom);
    if (state.input && state.input.value !== String(clamped)) {
      state.input.value = String(clamped);
      scheduleAutosave(state.input.form);
    }
    if (state.bar) state.bar.setAttribute('aria-valuenow', String(clamped));
    syncFlowDiagrams(state.input && state.input.id, clamped);
    return clamped;
  }

  function buildFlowSvg(parallelN, concurrentN){
    var N = Math.max(1, Math.min(32, Math.round(parallelN) || 1));
    var Nc = Math.max(1, Math.min(10, Math.round(concurrentN) || 1));
    var W = 1100, H = 600;
    var TOP_ROW_Y = Math.round(H * 0.5);
    var POOL_LEFT_X = Math.round(W * 0.2565);
    var POOL_RIGHT_X = Math.round(W * 0.3265);
    var POOL_TOP_Y = Math.round(H * 0.4455);
    var POOL_BOT_Y = POOL_TOP_Y + Math.round((POOL_RIGHT_X - POOL_LEFT_X) * 68 / 80);
    var VALIDATORS_X = Math.round(W * 0.465);
    var VALIDATORS_Y = Math.round(H * 0.5);
    var VALIDATORS_LEFT_X = Math.round(W * 0.43);
    var TASKIN_SCALE = 1.5;
    var TASKIN_W = Math.round(50 * TASKIN_SCALE);
    var TASKIN_H = Math.round(TASKIN_W * 20 / 16);
    var TASKIN_X = 90;
    var TASKIN_TOP = TOP_ROW_Y - Math.round(TASKIN_H / 2);
    var TASKIN_BOTTOM = TASKIN_TOP + TASKIN_H;
    var PAPER_LIFT = 10;
    var TOP_PAPER_DX = 10;
    var BACK_PAPER_EXTRA_LIFT = 10;
    var TOP_PAPER_X = TASKIN_X - Math.round(14 * TASKIN_SCALE) + TOP_PAPER_DX;
    var TOP_PAPER_TOP = TASKIN_TOP - Math.round(5 * TASKIN_SCALE) - PAPER_LIFT;
    var FOLDER_W = Math.round(80 * TASKIN_SCALE);
    var FOLDER_H = Math.round(FOLDER_W * 68 / 80);
    var POOL_V_SPLAY_IN = 22;
    var POOL_V_SPLAY_OUT = 22;
    var statusFor = function(i){
      var seed = (i * 31 + 7) % 17;
      if (seed === 1 || seed === 11) return 'error';
      return 'success';
    };
    var ribbonsHtml = '';
    var TASKIN_RIBBON_X = TASKIN_X + Math.round(TASKIN_W / 2);
    for (var i = 0; i < N; i++) {
      var t = N === 1 ? 0.5 : i / (N - 1);
      var x1 = POOL_RIGHT_X;
      var y1 = (TOP_ROW_Y - POOL_V_SPLAY_OUT) + t * POOL_V_SPLAY_OUT * 2;
      var x2 = VALIDATORS_X;
      var y2 = VALIDATORS_Y;
      var midX = (x1 + x2) / 2;
      var d = 'M ' + x1 + ' ' + y1
        + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2;
      var s = statusFor(i);
      var BEAM_W = 0.9;
      ribbonsHtml += '<path d="' + d + '" class="lab-project-flow-ribbon lab-project-flow-ribbon-' + s
        + '" stroke-width="' + BEAM_W + '"></path>';
      var sparkDelay = (i * 0.35).toFixed(2);
      var sparkStyle = ' style="animation-delay:' + sparkDelay + 's"';
      ribbonsHtml += '<path d="' + d + '" class="lab-project-flow-ribbon-spark lab-project-flow-ribbon-spark-trail"' + sparkStyle + '/>';
      ribbonsHtml += '<path d="' + d + '" class="lab-project-flow-ribbon-spark lab-project-flow-ribbon-spark-mid"' + sparkStyle + '/>';
      ribbonsHtml += '<path d="' + d + '" class="lab-project-flow-ribbon-spark lab-project-flow-ribbon-spark-core"' + sparkStyle + '/>';
    }
    var concRibbonsHtml = '';
    for (var j = 0; j < Nc; j++) {
      var tj = Nc === 1 ? 0.5 : j / (Nc - 1);
      var cx1 = TASKIN_RIBBON_X;
      var cy1 = TOP_ROW_Y;
      var cx2 = POOL_LEFT_X;
      var cy2 = (TOP_ROW_Y - POOL_V_SPLAY_IN) + tj * POOL_V_SPLAY_IN * 2;
      var cMidX = (cx1 + cx2) / 2;
      var cd = 'M ' + cx1 + ' ' + cy1
        + ' C ' + cMidX + ' ' + cy1 + ', ' + cMidX + ' ' + cy2 + ', ' + cx2 + ' ' + cy2;
      concRibbonsHtml += '<path d="' + cd + '" class="lab-project-flow-ribbon lab-project-flow-ribbon-success" stroke-width="0.9"/>';
      var cSparkDelay = (j * 0.35).toFixed(2);
      var cSparkStyle = ' style="animation-delay:' + cSparkDelay + 's"';
      concRibbonsHtml += '<path d="' + cd + '" class="lab-project-flow-ribbon-spark lab-project-flow-ribbon-spark-trail"' + cSparkStyle + '/>';
      concRibbonsHtml += '<path d="' + cd + '" class="lab-project-flow-ribbon-spark lab-project-flow-ribbon-spark-mid"' + cSparkStyle + '/>';
      concRibbonsHtml += '<path d="' + cd + '" class="lab-project-flow-ribbon-spark lab-project-flow-ribbon-spark-core"' + cSparkStyle + '/>';
    }
    var DEMO_TASK_BODY_2 = ''
      + '<div class="paper-meta"><span>ORC-2047</span><span>P3 · frontend</span></div>'
      + '<div class="paper-section-title">Goal</div>'
      + '<p>Migrate dashboard charts to v4 of Recharts.</p>'
      + '<div class="paper-section-title">Scope</div>'
      + '<ul>'
        + '<li>Replace deprecated AreaChart props</li>'
        + '<li>Regenerate visual snapshots</li>'
      + '</ul>'
      + '<div class="paper-section-title">Acceptance</div>'
      + '<table class="paper-table">'
        + '<thead><tr><th>Component</th><th>Status</th><th>Tests</th></tr></thead>'
        + '<tbody>'
          + '<tr><td>DashboardCard</td><td>required</td><td>18 ✓</td></tr>'
          + '<tr><td>StatBlock</td><td>required</td><td>9 ✓</td></tr>'
          + '<tr><td>TimeRange</td><td>optional</td><td>5 ✓</td></tr>'
        + '</tbody>'
      + '</table>';
    var DEMO_TASK_BODY = ''
      + '<div class="paper-meta"><span>ORC-2046</span><span>P2 · backend</span></div>'
      + '<div class="paper-section-title">Goal</div>'
      + '<p>Replace legacy session-token auth with shared OAuth.</p>'
      + '<div class="paper-section-title">Scope</div>'
      + '<ul>'
        + '<li>Add Google, GitHub, Apple sign-in</li>'
        + '<li>Migrate email/password users</li>'
        + '<li>Keep refresh-token rotation</li>'
      + '</ul>'
      + '<div class="paper-section-title">Acceptance</div>'
      + '<table class="paper-table">'
        + '<thead><tr><th>Provider</th><th>Tier</th><th>Tests</th></tr></thead>'
        + '<tbody>'
          + '<tr><td>Google</td><td>required</td><td>12 ✓</td></tr>'
          + '<tr><td>GitHub</td><td>required</td><td>8 ✓</td></tr>'
          + '<tr><td>Apple</td><td>optional</td><td>4 ✓</td></tr>'
          + '<tr><td>Email/Pwd</td><td>legacy</td><td>24 ✓</td></tr>'
        + '</tbody>'
      + '</table>';
    var FOLDER_X = Math.round((TASKIN_X + TASKIN_W / 2) - FOLDER_W / 2);
    var FOLDER_BOTTOM = TASKIN_BOTTOM;
    var FOLDER_TOP = FOLDER_BOTTOM - FOLDER_H;
    var folderScale = FOLDER_W / 80;
    var folderTransform = 'translate(' + FOLDER_X + ' ' + FOLDER_TOP + ') scale(' + folderScale + ')';
    var folderBackPath = 'M 14 2 L 66 2 Q 78 2 78 12 L 78 56 Q 78 66 66 66 L 14 66 Q 2 66 2 56 L 2 12 Q 2 2 14 2 Z';
    var folderFrontPath = 'M 14 12 L 30 12 L 38 22 L 66 22 Q 78 22 78 32 L 78 56 Q 78 66 66 66 L 14 66 Q 2 66 2 56 L 2 22 Q 2 12 14 12 Z';
    var folderBackSvg = '<g transform="' + folderTransform + '">'
      + '<path class="lab-project-flow-folder-back-panel" d="' + folderBackPath + '"/>'
      + '</g>';
    var folderFrontSvg = '<g transform="' + folderTransform + '">'
      + '<path class="lab-project-flow-folder-front-pocket" d="' + folderFrontPath + '"/>'
      + '</g>';
    var BACK_PAPER_DX = Math.round(7 * TASKIN_SCALE);
    var BACK_PAPER_DY = Math.round(6 * TASKIN_SCALE) - PAPER_LIFT - BACK_PAPER_EXTRA_LIFT;
    var glassFO = '<foreignObject x="0" y="0" width="' + W + '" height="' + H + '">'
      + '<div xmlns="http://www.w3.org/1999/xhtml" class="lab-project-flow-glass-layer">'
      + '<div class="lab-project-flow-glass-paper lab-project-flow-glass-paper-back" style="left:'
      + (TASKIN_X + BACK_PAPER_DX) + 'px;top:' + (TASKIN_TOP + BACK_PAPER_DY) + 'px;width:' + TASKIN_W + 'px;height:' + TASKIN_H + 'px;">'
      + '<div class="lab-project-flow-paper-title">Task in</div>'
      + '<div class="lab-project-flow-paper-body">' + DEMO_TASK_BODY_2 + '</div>'
      + '</div>'
      + '<div class="lab-project-flow-glass-paper" style="left:' + TOP_PAPER_X + 'px;top:' + TOP_PAPER_TOP
      + 'px;width:' + TASKIN_W + 'px;height:' + TASKIN_H + 'px;">'
      + '<div class="lab-project-flow-paper-title">Task in</div>'
      + '<div class="lab-project-flow-paper-body">' + DEMO_TASK_BODY + '</div>'
      + '</div>'
      + '</div></foreignObject>';
    return '<svg class="lab-project-flow-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">'
      + '<g class="lab-project-flow-ribbons lab-project-flow-ribbons-concurrent">' + concRibbonsHtml + '</g>'
      + '<g class="lab-project-flow-ribbons lab-project-flow-ribbons-parallel">' + ribbonsHtml + '</g>'
      + folderBackSvg
      + glassFO
      + folderFrontSvg
      + '</svg>';
  }
  function readConcurrentN(){
    var concInput = document.querySelector('.lab-project-flow-engine-card input[name="max_concurrent"]');
    var v = concInput ? Number(concInput.value) : 1;
    return Number.isFinite(v) && v > 0 ? v : 1;
  }
  function renderFlowDiagram(container, parallelN, concurrentN){
    if (!container) return;
    if (parallelN == null) {
      var srcId = container.getAttribute('data-flow-source');
      var srcInput = srcId ? document.getElementById(srcId) : null;
      parallelN = srcInput ? Number(srcInput.value) : 1;
      if (!Number.isFinite(parallelN)) parallelN = 1;
    }
    if (concurrentN == null) concurrentN = readConcurrentN();
    var host = container.querySelector('.lab-project-flow-svg-host');
    if (host) host.innerHTML = buildFlowSvg(parallelN, concurrentN);
    else container.innerHTML = buildFlowSvg(parallelN, concurrentN);
  }
  function syncFlowDiagrams(sourceInputId, n){
    if (!sourceInputId) return;
    var concurrentN = readConcurrentN();
    document.querySelectorAll('.lab-project-flow').forEach(function(el){
      if (el.getAttribute('data-flow-source') === sourceInputId) renderFlowDiagram(el, n, concurrentN);
    });
  }
  function initFlowDiagrams(){
    var concurrentN = readConcurrentN();
    document.querySelectorAll('.lab-project-flow').forEach(function(el){
      var inputId = el.getAttribute('data-flow-source');
      var input = inputId ? document.getElementById(inputId) : null;
      var n = input ? Number(input.value) : 2;
      renderFlowDiagram(el, Number.isFinite(n) ? n : 2, concurrentN);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFlowDiagrams);
  } else {
    initFlowDiagrams();
  }
  function onConcurrentInputChange(e){
    if (!e.target || e.target.name !== 'max_concurrent') return;
    document.querySelectorAll('.lab-project-flow').forEach(function(el){
      renderFlowDiagram(el);
    });
  }
  document.addEventListener('input', onConcurrentInputChange);
  document.addEventListener('change', onConcurrentInputChange);
  function buildSplitbarState(bar){
    var inputId = bar.getAttribute('data-target-input');
    var input = inputId ? document.getElementById(inputId) : null;
    if (!input) return null;
    var scope = bar.closest('form') || bar.closest('.lab-project-flow-engine-card') || bar.parentElement || bar;
    return {
      bar: bar,
      input: input,
      min: Number(input.getAttribute('min') || '1'),
      max: Number(input.getAttribute('max') || '100'),
      activeZone: bar.querySelector('.lab-project-rp-splitbar-active'),
      num: scope.querySelector('.lab-project-rp-splitbar-num'),
      headnum: scope.querySelector('.lab-project-rp-splitbar-headnum'),
    };
  }
  var splitDrag = null;
  document.addEventListener('pointerdown', function(e){
    var bar = e.target.closest && e.target.closest('.lab-project-rp-splitbar');
    if (!bar) return;
    var state = buildSplitbarState(bar);
    if (!state) return;
    var hitHandle = !!e.target.closest('.lab-project-rp-splitbar-handle');
    if (!hitHandle) {
      var rect = bar.getBoundingClientRect();
      if (rect.width > 0) {
        var ratio = (e.clientX - rect.left) / rect.width;
        if (ratio < 0) ratio = 0;
        if (ratio > 1) ratio = 1;
        var raw = state.min + ratio * (state.max - state.min);
        applySplitbarValue(state, raw);
      }
    }
    splitDrag = state;
    bar.classList.add('lab-project-rp-splitbar-dragging');
    if (bar.setPointerCapture) {
      try { bar.setPointerCapture(e.pointerId); } catch (_) {}
    }
    e.preventDefault();
  });
  document.addEventListener('pointermove', function(e){
    if (!splitDrag) return;
    var rect = splitDrag.bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    var ratio = (e.clientX - rect.left) / rect.width;
    if (ratio < 0) ratio = 0;
    if (ratio > 1) ratio = 1;
    var raw = splitDrag.min + ratio * (splitDrag.max - splitDrag.min);
    applySplitbarValue(splitDrag, raw);
  });
  function endSplitDrag(){
    if (!splitDrag) return;
    splitDrag.bar.classList.remove('lab-project-rp-splitbar-dragging');
    splitDrag = null;
  }
  document.addEventListener('pointerup', endSplitDrag);
  document.addEventListener('pointercancel', endSplitDrag);

  document.addEventListener('keydown', function(e){
    var bar = e.target.closest && e.target.closest('.lab-project-rp-splitbar');
    if (!bar) return;
    var step = 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step = -1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step = 1;
    else if (e.key === 'PageDown') step = -8;
    else if (e.key === 'PageUp') step = 8;
    else if (e.key === 'Home') { var s1 = buildSplitbarState(bar); if (s1) applySplitbarValue(s1, s1.min); e.preventDefault(); return; }
    else if (e.key === 'End')  { var s2 = buildSplitbarState(bar); if (s2) applySplitbarValue(s2, s2.max); e.preventDefault(); return; }
    if (step === 0) return;
    var state = buildSplitbarState(bar);
    if (!state) return;
    var current = Number(state.input.value || state.min);
    applySplitbarValue(state, current + step);
    e.preventDefault();
  });

  document.addEventListener('input', function(e){
    if (!e.target.matches || !e.target.matches('input[type="number"]')) return;
    var bars = document.querySelectorAll('.lab-project-rp-splitbar');
    for (var i = 0; i < bars.length; i++) {
      if (bars[i].getAttribute('data-target-input') !== e.target.id) continue;
      var state = buildSplitbarState(bars[i]);
      if (!state) continue;
      var v = Number(e.target.value);
      if (Number.isFinite(v)) applySplitbarValue(state, v);
    }
  });

  var svcPopover = document.querySelector('[data-lab-services-popover]');
  var svcContainer = svcPopover && svcPopover.parentElement;
  if (svcPopover && svcContainer) {
    if (svcPopover.parentElement !== document.body) document.body.appendChild(svcPopover);
    var svcHideTimer = null;
    function svcCancelHide(){ if (svcHideTimer) { clearTimeout(svcHideTimer); svcHideTimer = null; } }
    function svcScheduleHide(){ svcCancelHide(); svcHideTimer = setTimeout(svcHide, 150); }
    function svcMeterHtml(){
      var bars = '';
      for (var i = 0; i < 24; i++) bars += '<span class="lab-project-services-meter-bar"></span>';
      return '<div class="lab-project-services-meter" role="status" aria-label="Running fix">' + bars + '</div>';
    }
    function svcShow(node){
      svcCancelHide();
      var raw = node.getAttribute('data-popover');
      if (!raw) return;
      var data; try { data = JSON.parse(raw); } catch(_) { return; }
      var headStatus = (data.status || 'unknown').toUpperCase();
      var itemsHtml = (data.items || []).map(function(it){
        var parts = ['<div class="lab-project-services-popover-item" data-status="' + projectHealthEscapeHtml(it.status) + '">'];
        if (it.summary) parts.push('<div class="lab-project-services-popover-summary">' + projectHealthEscapeHtml(it.summary) + '</div>');
        if (it.details) parts.push('<div class="lab-project-services-popover-details">' + projectHealthEscapeHtml(it.details) + '</div>');
        if (it.fix && typeof it.fix === 'object') {
          var fxCmd = it.fix.command || '';
          var fxDesc = it.fix.description || '';
          var fxAction = it.fix.action || '';
          if (fxAction) {
            parts.push(
              '<div class="lab-project-services-popover-fix" data-fix-action="' + projectHealthEscapeHtml(fxAction) + '">' +
                '<button type="button" class="lab-project-services-fix-button" data-fix-run="' + projectHealthEscapeHtml(fxAction) + '">' +
                  '<span class="lab-project-services-fix-button-label">Run fix</span>' +
                  (fxCmd ? '<code class="lab-project-services-fix-button-cmd">' + projectHealthEscapeHtml(fxCmd) + '</code>' : '') +
                '</button>' +
                (fxDesc ? '<div class="lab-project-services-fix-desc">' + projectHealthEscapeHtml(fxDesc) + '</div>' : '') +
              '</div>'
            );
          } else if (fxCmd) {
            parts.push(
              '<div class="lab-project-services-popover-fix">' +
                '<span class="lab-project-services-popover-fix-label">Fix</span>' +
                '<code>' + projectHealthEscapeHtml(fxCmd) + '</code>' +
              '</div>' +
              (fxDesc ? '<div class="lab-project-services-fix-desc">' + projectHealthEscapeHtml(fxDesc) + '</div>' : '')
            );
          }
        }
        parts.push('</div>');
        return parts.join('');
      }).join('');
      var noteHtml = data.note
        ? '<div class="lab-project-services-popover-note">' + projectHealthEscapeHtml(data.note) + '</div>'
        : '';
      svcPopover.setAttribute('data-status', data.status || 'unknown');
      svcPopover.innerHTML =
        '<header class="lab-project-services-popover-head">' +
          '<span class="lab-project-services-popover-label">' + projectHealthEscapeHtml(data.label) + '</span>' +
          '<span class="lab-project-services-popover-status">' + projectHealthEscapeHtml(headStatus) + '</span>' +
        '</header>' +
        itemsHtml +
        noteHtml;
      var fixButtons = svcPopover.querySelectorAll('[data-fix-run]');
      for (var fi = 0; fi < fixButtons.length; fi++) {
        fixButtons[fi].addEventListener('click', svcOnFixClick);
      }
      svcPopover.style.visibility = 'hidden';
      svcPopover.hidden = false;
      svcPopover.setAttribute('aria-hidden', 'false');
      var rect = node.getBoundingClientRect();
      var margin = 12;
      var pw = svcPopover.offsetWidth;
      var ph = svcPopover.offsetHeight;
      var top = rect.bottom + margin;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - margin);
      var left = rect.left + rect.width / 2 - pw / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
      svcPopover.style.top = top + 'px';
      svcPopover.style.left = left + 'px';
      svcPopover.style.visibility = '';
    }
    function svcHide(){
      svcCancelHide();
      svcPopover.hidden = true;
      svcPopover.setAttribute('aria-hidden', 'true');
      svcPopover.style.visibility = '';
    }
    function svcOnFixClick(e){
      e.preventDefault();
      e.stopPropagation();
      var btn = e.currentTarget;
      var action = btn.getAttribute('data-fix-run');
      if (!action || btn.disabled) return;
      svcCancelHide();
      btn.disabled = true;
      var fixRow = btn.closest('.lab-project-services-popover-fix');
      var origHtml = fixRow ? fixRow.innerHTML : '';
      if (fixRow) fixRow.innerHTML = svcMeterHtml() + '<div class="lab-project-services-fix-desc lab-project-services-fix-status">Running ' + projectHealthEscapeHtml(action) + '…</div>';
      var body = 'action=' + encodeURIComponent(action);
      fetch('/__niis/run-fix', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
        body: body,
      }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
        .then(function(res){
          if (!fixRow) return res;
          if (res.ok && res.body && res.body.ok) {
            fixRow.innerHTML = '<div class="lab-project-services-fix-status lab-project-services-fix-status-ok">' + projectHealthEscapeHtml(res.body.summary || 'Done') + '</div>';
          } else {
            var msg = (res.body && (res.body.error || res.body.summary)) || ('HTTP ' + (res.ok ? '200' : 'error'));
            fixRow.innerHTML = '<div class="lab-project-services-fix-status lab-project-services-fix-status-error">' + projectHealthEscapeHtml(msg) + '</div>';
          }
          return res;
        })
        .then(function(){ return svcRefreshStatus(); })
        .catch(function(err){
          if (fixRow) fixRow.innerHTML = '<div class="lab-project-services-fix-status lab-project-services-fix-status-error">' + projectHealthEscapeHtml(String(err && err.message || err)) + '</div>';
        });
      void origHtml;
    }
    function svcRefreshStatus(){
      return fetch('/__niis/services-status', { headers: { 'accept': 'application/json' } })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(data){
          if (!data) return;
          var nodes = document.querySelectorAll('.lab-project-service-node');
          for (var i = 0; i < nodes.length; i++) {
            var id = nodes[i].getAttribute('data-id');
            var entry = data.nodes && data.nodes[id];
            if (!entry) continue;
            nodes[i].setAttribute('data-status', entry.status);
            try { nodes[i].setAttribute('data-popover', JSON.stringify(entry.payload)); } catch(_) {}
          }
          var badge = document.querySelector('.lab-project-system-badge');
          if (badge && data.system_status) {
            badge.setAttribute('data-status', data.system_status);
            var label = badge.querySelector('.lab-project-system-badge-label');
            if (label) label.textContent = data.system_status;
          }
        })
        .catch(function(){});
    }
    var svcNodes = document.querySelectorAll('.lab-project-service-node');
    for (var si = 0; si < svcNodes.length; si++) {
      svcNodes[si].addEventListener('mouseenter', function(e){ svcShow(e.currentTarget); });
      svcNodes[si].addEventListener('mouseleave', svcScheduleHide);
      svcNodes[si].addEventListener('focus', function(e){ svcShow(e.currentTarget); });
      svcNodes[si].addEventListener('blur', svcScheduleHide);
    }
    svcPopover.addEventListener('mouseenter', svcCancelHide);
    svcPopover.addEventListener('mouseleave', svcHide);
  }

})();
`;



const PROJECT_NAV_ICONS = {
  gear: AGENTS_PAGE_ICONS.gear,
  users: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  bot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`,
  cube: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 16-9 5-9-5V8l9-5 9 5z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`,
  plug: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M12 22v-4"/><path d="M6 14V8h12v6a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z"/></svg>`,
  code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  card: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/></svg>`,
  list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
  chevron_right: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
  chevron_down: AGENTS_PAGE_ICONS.chevron_down,
  stack: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 9 4-9 4-9-4z"/><path d="m3 12 9 4 9-4"/><path d="m3 17 9 4 9-4"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>`,
  plus: AGENTS_PAGE_ICONS.plus,
  github: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14v14H5zM8 9h8M8 12h8M8 15h5"/></svg>`,
  jira: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.78c0 2.4 1.97 4.35 4.35 4.35V2.84a.84.84 0 0 0-.84-.84zM6.77 6.78c0 2.4 1.97 4.35 4.35 4.35h1.78v1.78c0 2.4 1.95 4.35 4.35 4.35V7.62a.84.84 0 0 0-.84-.84zM2 11.53c0 2.4 1.95 4.35 4.35 4.35h1.78v1.78c0 2.4 1.97 4.35 4.35 4.35V12.37a.84.84 0 0 0-.84-.84z"/></svg>`,
  slack: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5.04 15.16a2.52 2.52 0 0 1-2.52 2.52A2.52 2.52 0 0 1 0 15.16a2.52 2.52 0 0 1 2.52-2.52h2.52zM6.3 15.16a2.52 2.52 0 0 1 2.52-2.52 2.52 2.52 0 0 1 2.52 2.52v6.32A2.52 2.52 0 0 1 8.82 24a2.52 2.52 0 0 1-2.52-2.52zM8.82 5.04a2.52 2.52 0 0 1-2.52-2.52A2.52 2.52 0 0 1 8.82 0a2.52 2.52 0 0 1 2.52 2.52v2.52zM8.82 6.3a2.52 2.52 0 0 1 2.52 2.52 2.52 2.52 0 0 1-2.52 2.52H2.52A2.52 2.52 0 0 1 0 8.82a2.52 2.52 0 0 1 2.52-2.52zM18.96 8.82a2.52 2.52 0 0 1 2.52-2.52A2.52 2.52 0 0 1 24 8.82a2.52 2.52 0 0 1-2.52 2.52h-2.52zM17.7 8.82a2.52 2.52 0 0 1-2.52 2.52 2.52 2.52 0 0 1-2.52-2.52V2.52A2.52 2.52 0 0 1 15.18 0a2.52 2.52 0 0 1 2.52 2.52zM15.18 18.96a2.52 2.52 0 0 1 2.52 2.52A2.52 2.52 0 0 1 15.18 24a2.52 2.52 0 0 1-2.52-2.52v-2.52zM15.18 17.7a2.52 2.52 0 0 1-2.52-2.52 2.52 2.52 0 0 1 2.52-2.52h6.3A2.52 2.52 0 0 1 24 15.18a2.52 2.52 0 0 1-2.52 2.52z"/></svg>`,
  linear: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.45 8.6 15.4 20.55a10.05 10.05 0 0 1-7.83-2.12L3.45 8.6zm-.86 2.32 8.49 8.49a10.06 10.06 0 0 1-7.04-7.05zm-.13-2.71L15.79 21.53A10 10 0 1 1 2.46 8.21zM5.96 4.65a10.05 10.05 0 0 1 13.39 13.39L5.96 4.65z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>`,
};

function renderProjectGeneralForm({ profile, timezone, claudeCreditUsd = 0 }) {
  const tzCanonical = timezone || "UTC";
  const TZ_OPTIONS = [
    "UTC",
    "America/Los_Angeles",
    "America/Denver",
    "America/Chicago",
    "America/New_York",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Moscow",
    "Asia/Dubai",
    "Asia/Kolkata",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Australia/Sydney",
  ];
  const tzList = TZ_OPTIONS.includes(tzCanonical) ? TZ_OPTIONS : [tzCanonical, ...TZ_OPTIONS];
  const tzOptionsHtml = tzList.map((tz) => `<option value="${escapeHtml(tz)}"${tz === tzCanonical ? " selected" : ""}>${escapeHtml(tz)}</option>`).join("");
  return `
    <form method="post" action="/project/settings/general" class="lab-project-form">
      <div class="lab-project-form-field">
        <span>Project ID</span>
        <code class="lab-project-id-readout">${escapeHtml(profile?.project_id || "niis-local")}</code>
      </div>
      <label class="lab-project-form-field">
        <span>Default timezone</span>
        <select class="lab-project-select" name="project_timezone" data-lab-project-autosave>${tzOptionsHtml}</select>
      </label>
      <label class="lab-project-form-field">
        <span>Claude monthly reference (USD) — operator-entered</span>
        <input class="lab-project-input" type="number" min="0" step="1" name="claude_agent_sdk_credit_usd" value="${escapeHtml(String(claudeCreditUsd || ""))}" placeholder="e.g. 100" data-lab-project-autosave />
      </label>
    </form>`;
}


function renderProjectFilesCard(fileSnippets, { healthIssues = [] } = {}) {
  const snippets = fileSnippets ?? {};
  const artifactIssues = (Array.isArray(healthIssues) ? healthIssues : []).filter((issue) => issue.zone === "project-artifacts");
  const issuesByTarget = new Map();
  for (const issue of artifactIssues) {
    if (!issue.target) continue;
    const arr = issuesByTarget.get(issue.target) ?? [];
    arr.push(issue);
    issuesByTarget.set(issue.target, arr);
  }
  const thumbsHtml = PROJECT_ARTIFACT_FILES.map((f, idx) => {
    const data = snippets[f.id] ?? { exists: false, snippet: "" };
    const targetIssues = issuesByTarget.get(f.id) ?? [];
    const issueStatus = targetIssues.length > 0 ? projectHealthWorstStatus(targetIssues) : null;
    return renderProjectFileThumb({ ...f, exists: data.exists === true, snippet: data.snippet || "", tiltIndex: idx, issueStatus });
  }).join("");

  return `
    <header class="lab-project-files-header">
      <h2 class="lab-project-files-title">Project artifacts</h2>
      ${renderProjectHealthMarker(healthIssues, "project-artifacts", "Project artifacts", " lab-project-health-marker--project-artifacts")}
    </header>
    <div class="lab-project-files-row">
      ${thumbsHtml}
    </div>
    <div class="lab-project-file-modal" data-lab-file-modal hidden aria-hidden="true">
      <div class="lab-project-file-modal-backdrop" data-lab-file-modal-close></div>
      <div class="lab-project-file-modal-paper lab-project-flow-glass-paper" role="dialog" aria-modal="true" aria-labelledby="lab-project-file-modal-title">
        <header class="lab-project-file-modal-head">
          <div class="lab-project-file-modal-head-text">
            <h2 class="lab-project-flow-paper-title" id="lab-project-file-modal-title" data-lab-file-modal-filename>—</h2>
            <p class="lab-project-file-modal-meta" data-lab-file-modal-meta></p>
          </div>
          <div class="lab-project-file-modal-actions">
            <div class="lab-project-file-modal-views" data-lab-file-views hidden role="tablist">
              <button type="button" class="lab-project-file-modal-view-btn" data-lab-view="raw" data-active="1" role="tab" aria-selected="true">Raw</button>
              <button type="button" class="lab-project-file-modal-view-btn" data-lab-view="html" role="tab" aria-selected="false">HTML</button>
            </div>
            <select class="lab-project-file-modal-render-select" data-lab-render-html-adapter hidden aria-label="HTML generation adapter" title="HTML generation adapter">
              <option value="claude" selected>Claude</option>
              <option value="codex">Codex</option>
            </select>
            <button type="button" class="lab-project-file-modal-render-btn" data-lab-render-html hidden aria-label="Regenerate HTML" title="Regenerate HTML">
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
                <path d="M21 12A9 9 0 0 1 6.2 18.9M3 12A9 9 0 0 1 17.8 5.1M17 19H6V8M7 5h11v11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span data-lab-render-html-label>Regenerate</span>
            </button>
          </div>
          <button type="button" class="lab-project-file-modal-close" data-lab-file-modal-close aria-label="Close">×</button>
        </header>
        <div class="lab-project-file-modal-body" data-lab-file-modal-body></div>
      </div>
    </div>`;
}

function renderProjectFileThumb(file) {
  const stateClass = file.exists ? "" : " lab-project-file-thumb-missing";



  const tiltClass = file.exists ? ` lab-project-file-thumb-tilt-${file.tiltIndex % 4}` : "";
  return `
    <button
      type="button"
      class="lab-project-file-thumb${stateClass}${tiltClass}"
      data-lab-file-id="${escapeHtml(file.id)}"
      data-lab-file-kind="${escapeHtml(file.kind)}"
      ${file.exists ? "" : "disabled aria-disabled=\"true\""}
      title="${escapeHtml(file.exists ? `Open ${file.filename}` : `${file.filename} — not yet generated`)}"
    >
      ${file.issueStatus ? renderProjectArtifactMarkerSpan(file.issueStatus) : ""}
      <div class="lab-project-flow-glass-paper lab-project-file-thumb-paper" aria-hidden="true">
        <div class="lab-project-flow-paper-title">${escapeHtml(file.filename)}</div>
        <div class="lab-project-flow-paper-body lab-project-file-thumb-body">${
          file.exists
            ? `<pre>${escapeHtml(file.snippet)}</pre>`
            : `<p class="lab-project-file-thumb-empty">Not yet generated</p>`
        }</div>
      </div>
    </button>`;
}

function renderProjectDocument({
  projectContext,
  projectFileSnippets = {},
  snapshot,
  workerMode = "semi",
  error = null,
  notice = null,
  gitUser = null,
  timezone = null,
  goalsAutoSuggest = false,
  monthlySpendUsd = null,
  scriptNonce = null,
}) {
  const nonceAttribute = scriptNonce ? ` nonce="${escapeHtml(scriptNonce)}"` : "";
  const safeContext = projectContext ?? {};
  const profile = safeContext.profile ?? null;
  const doctorChecks = safeContext.doctor?.all_checks ?? safeContext.doctor?.runtime_availability ?? [];
  const safeSnapshot = snapshot ?? {};
  const safeGitUser = gitUser && typeof gitUser === "object"
    ? { name: gitUser.name || "Operator", email: gitUser.email || "operator@niis.local" }
    : { name: "Operator", email: "operator@niis.local" };

  const systemStatus = computeSystemStatus(doctorChecks);
  const claudeCreditUsd = Number(safeContext.roleConfig?.overrides?.billing?.claude_agent_sdk_credit_usd) || 0;
  const claudeCreditNote = buildClaudeCreditNote(
    claudeCreditUsd,
    safeContext.roleConfig?.overrides?.roles,
    Number.isFinite(monthlySpendUsd) ? monthlySpendUsd : null,
  );
  const projectHealthIssues = buildProjectHealthStatus({
    doctorChecks,
    projectFileSnippets,
    claudeCreditNote,
    gitUser: safeGitUser,
  });


  const projectInfoPanel = `
    <section class="lab-project-card lab-project-hero-panel" data-lab-project-target="info" id="general">
      <header class="lab-project-card-head">
        <div class="lab-project-card-head-text">
          <h2 class="lab-project-card-title">Project information</h2>
          <p class="lab-project-card-subtitle">Basic identity and locale for this workspace.</p>
        </div>
      </header>
      <div class="lab-project-card-body">
        ${renderProjectGeneralForm({ profile, timezone, claudeCreditUsd })}
        <div class="lab-project-card-goals-section">
          <h3 class="lab-project-card-subhead">Goals</h3>
          <p class="lab-project-card-subhead-sub">Higher-level objectives this project is pursuing. Each goal aggregates linked tasks, total runs, and total cost.</p>
          ${renderProjectGoalsSection(safeSnapshot, { goalsAutoSuggest })}
        </div>
      </div>
    </section>`;

  const heroSection = `
    <section class="lab-project-hero" aria-label="Project at a glance">
      <div class="lab-project-hero-bg">
        <div class="lab-project-hero-sticky-stack">
          <div class="lab-project-flow" data-flow-source="routing-max-parallel-hero" aria-label="Project processing flow">
            <div class="lab-project-flow-stage">
              <div class="lab-project-flow-svg-host"></div>
              <div class="lab-project-flow-taskin-label-wrap" aria-hidden="true">
                <div class="lab-project-flow-block-label lab-project-flow-block-label--lg">Task in</div>
              </div>
              <div class="lab-project-flow-adapter-pool" aria-label="Adapter pool">
                ${renderProjectHealthMarker(projectHealthIssues, "adapters", "Adapter pool")}
                <div class="lab-project-flow-adapter-pool-badges">
                  ${renderAdapterPoolBadges(doctorChecks, { claudeCreditNote })}
                </div>
                <div class="lab-project-flow-block-label lab-project-flow-block-label--lg">Adapters</div>
              </div>
              <div class="lab-project-flow-pipeline-overlay" aria-label="Validators → reviewer / proof → verdict → reviewable branch">
                ${renderProjectServiceSchema(doctorChecks, {
                  claudeCreditNote,
                  gitUser: safeGitUser,
                  section: "right",
                  orientation: "horizontal",
                })}
              </div>
              <div class="lab-project-flow-validators-pool" aria-label="Validators">
                ${renderProjectHealthMarker(projectHealthIssues, "validators", "Validators")}
                <svg class="lab-project-flow-validators-pool-svg lab-project-flow-validators-pool-svg-back" viewBox="0 0 80 68" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                  <path class="lab-project-flow-folder-back-panel" d="M 14 2 L 66 2 Q 78 2 78 12 L 78 56 Q 78 66 66 66 L 14 66 Q 2 66 2 56 L 2 12 Q 2 2 14 2 Z"/>
                </svg>
                <div class="lab-project-flow-glass-paper lab-project-flow-glass-paper-back" style="left:15px;top:-7px;width:50px;height:63px;">
                  <div class="lab-project-flow-paper-title">Acceptance</div>
                  <div class="lab-project-flow-paper-body"><div class="paper-meta"><span>VAL-2047</span><span>frontend</span></div><div class="paper-section-title">Required</div><ul><li>Snapshot tests match baseline</li><li>Type-check clean (0 errors)</li><li>Bundle size within budget</li></ul><div class="paper-section-title">Status</div><table class="paper-table"><thead><tr><th>Check</th><th>Target</th><th>Result</th></tr></thead><tbody><tr><td>Snapshots</td><td>match</td><td>42 ✓</td></tr><tr><td>TypeScript</td><td>0 err</td><td>0 ✓</td></tr><tr><td>Bundle</td><td>≤ 250kb</td><td>234kb ✓</td></tr></tbody></table></div>
                </div>
                <div class="lab-project-flow-glass-paper" style="left:10px;top:-8px;width:50px;height:63px;">
                  <div class="lab-project-flow-paper-title">Acceptance</div>
                  <div class="lab-project-flow-paper-body"><div class="paper-meta"><span>VAL-2046</span><span>backend</span></div><div class="paper-section-title">Required</div><ul><li>Unit + integration tests pass</li><li>Coverage ≥ 80%</li><li>Lint: 0 new warnings</li><li>Security scan clean</li></ul><div class="paper-section-title">Status</div><table class="paper-table"><thead><tr><th>Check</th><th>Target</th><th>Result</th></tr></thead><tbody><tr><td>Unit</td><td>pass</td><td>247 ✓</td></tr><tr><td>Integration</td><td>pass</td><td>38 ✓</td></tr><tr><td>Coverage</td><td>≥ 80%</td><td>87% ✓</td></tr><tr><td>Lint</td><td>0 warn</td><td>0 ✓</td></tr></tbody></table></div>
                </div>
                <svg class="lab-project-flow-validators-pool-svg lab-project-flow-validators-pool-svg-front" viewBox="0 0 80 68" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                  <path class="lab-project-flow-folder-front-pocket" d="M 14 12 L 30 12 L 38 22 L 66 22 Q 78 22 78 32 L 78 56 Q 78 66 66 66 L 14 66 Q 2 66 2 56 L 2 22 Q 2 12 14 12 Z"/>
                  <g class="lab-project-flow-validators-pool-shield" transform="translate(28 26)">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </g>
                </svg>
                <div class="lab-project-flow-block-label lab-project-flow-block-label--lg">Validators</div>
              </div>
              <div class="lab-project-flow-pipeline-block lab-project-flow-pipeline-block-reviewer" aria-label="LLM reviewer">
                ${renderProjectHealthMarker(projectHealthIssues, "llm-reviewer", "LLM reviewer")}
                <div class="lab-project-flow-pipeline-block-icon">${SERVICE_PIPELINE_ICONS.brain}</div>
                <div class="lab-project-flow-block-label lab-project-flow-block-label--lg">LLM<br>reviewer</div>
              </div>
              <div class="lab-project-flow-pipeline-block lab-project-flow-pipeline-block-proof" aria-label="Completion proof">
                ${renderProjectHealthMarker(projectHealthIssues, "proof", "Completion proof")}
                <div class="lab-project-flow-pipeline-block-icon">${SERVICE_PIPELINE_ICONS.check}</div>
                <div class="lab-project-flow-block-label lab-project-flow-block-label--lg">Completion<br>proof</div>
              </div>
              <div class="lab-project-flow-pipeline-block lab-project-flow-pipeline-block-verdict" aria-label="Verdict">
                ${renderProjectHealthMarker(projectHealthIssues, "verdict", "Verdict")}
                <div class="lab-project-flow-pipeline-block-icon">${SERVICE_PIPELINE_ICONS.scale}</div>
                <div class="lab-project-flow-block-label lab-project-flow-block-label--lg">Verdict</div>
              </div>
              ${renderProjectHealthMarker(projectHealthIssues, "delivery", "Delivery", " lab-project-health-marker--delivery")}
            </div>
          </div>
          <div class="lab-project-hero-files">
            ${renderProjectFilesCard(projectFileSnippets, { healthIssues: projectHealthIssues })}
          </div>
        </div>
      </div>
      <div class="lab-project-hero-info-overlay">
        ${renderProjectHealthDrawer(projectHealthIssues)}
        ${renderProjectFlowEngineCardHtml(safeContext)}
        <section class="lab-project-card lab-project-hero-panel" data-lab-project-target="review" id="review-chain">
          <header class="lab-project-card-head">
            <div class="lab-project-card-head-text">
              <h2 class="lab-project-card-title">Review chain</h2>
              <p class="lab-project-card-subtitle">How niis judges a run after validators pass.</p>
            </div>
          </header>
          <div class="lab-project-card-body">
            ${renderProjectReviewForm(safeContext)}
          </div>
        </section>
        <section class="lab-project-card lab-project-hero-panel" data-lab-project-target="promotion" id="promotion-policy">
          <header class="lab-project-card-head">
            <div class="lab-project-card-head-text">
              <h2 class="lab-project-card-title">Promotion policy</h2>
              <p class="lab-project-card-subtitle">The fixed supervised boundary after a canonical verdict.</p>
            </div>
          </header>
          <div class="lab-project-card-body">
            ${renderProjectPromotionPolicy(safeContext)}
          </div>
        </section>
        ${projectInfoPanel}
      </div>
    </section>`;


  const secondarySection = ``;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Niis — Project</title>
    <script${nonceAttribute}>${LAB_INIT_SCRIPT}</script>
    <link rel="stylesheet" href="/__niis/assets/lab.css" />
    <link rel="stylesheet" href="/__niis/assets/prism-theme/dracula.css" />
    <script${nonceAttribute} src="/__niis/assets/prism.js" defer></script>
  </head>
  <body class="lab-body">
    ${renderTopbar({ workerMode, breadcrumb: "project", activeRoute: "project", systemStatus })}
    <main class="lab-main lab-main-project">
      ${renderProjectBanner({ notice, error })}
      <div class="lab-project-center">
        ${heroSection}
        ${secondarySection}
      </div>
    </main>
    <script${nonceAttribute}>${LAB_TOPBAR_SCRIPT}</script>
    <script${nonceAttribute}>${PROJECT_PAGE_SCRIPT}</script>
  </body>
</html>`;
}







function buildServicesStatus(allChecks, { claudeCreditNote = null, gitUser = null } = {}) {
  const checks = Array.isArray(allChecks) ? allChecks : [];
  const byId = new Map(checks.map((c) => [c.id, c]));
  const nodes = {};
  for (const node of SERVICE_SCHEMA_NODES) {
    const meta = nodeMetaFromChecks(node, byId, checks);
    if (node.id === "claude" && claudeCreditNote) {
      meta.payload.note = claudeCreditNote;
    }
    if (node.id === "code_host") {
      const c = byId.get("code-host");
      if (c?.host) {
        const dyn = c.host === "None" ? "No remote" : c.host;
        meta.payload.label = dyn;
      }
      if (gitUser?.name || gitUser?.email) {
        const identity = `${gitUser.name || "(no name)"} <${gitUser.email || "(no email)"}>`;
        const idNote = `Commits authored as ${identity} (from \`git config user.name / user.email\`).`;
        meta.payload.note = meta.payload.note ? `${meta.payload.note} ${idNote}` : idNote;
      }
    }
    nodes[node.id] = { status: meta.status, payload: meta.payload };
  }
  return { nodes, system_status: computeSystemStatus(checks) };
}

export {
  buildLabPageData,
  buildManageAgentsPageData,
  renderLabDocument,
  renderManageAgentsDocument,
  renderProjectDocument,
  buildServicesStatus,
  buildProjectHealthStatus,
  buildClaudeCreditNote,
  LAB_AGENTS,
  ROLE_TO_PERSONA,
  setExtraLabAgents,


  pickPersonaForTask,
};
