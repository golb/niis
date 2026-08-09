import {
  escapeHtml,
  formatDisplayLabel,
  formatMaybeList,
  formatTimestamp,
  truncateText,
} from "../render-utils.js";
import {
  buildNiisSidebarTree,
  renderNiisLayout,
  renderNiisSidebar,
  renderNiisToc,
  renderNiisTopbar,
} from "./layout.js";

function renderTaskNewPreview(preview) {
  if (!preview?.artifact) {
    return "";
  }

  const artifact = preview.artifact;
  const routePreview = preview.route_preview ?? {};
  const selectedLane = routePreview.selected_lane?.lane_id ?? routePreview.selected_lane?.id ?? "blocked";
  const selectedAdapter = routePreview.selected_adapter?.id ?? routePreview.status ?? "unavailable";
  const plannerAttemptDetails = (preview.planner_attempts ?? []).map((attempt) => {
    const parts = [
      `${attempt.runtime_id}:${attempt.ok ? "ok" : "fallback"}`,
      attempt.exit_code !== null && attempt.exit_code !== undefined ? `exit=${attempt.exit_code}` : null,
      attempt.error ? `error=${attempt.error}` : null,
      attempt.stderr_excerpt ? `stderr=${attempt.stderr_excerpt}` : null,
      attempt.stdout_excerpt ? `stdout=${attempt.stdout_excerpt}` : null,
      attempt.raw_excerpt ? `raw=${attempt.raw_excerpt}` : null,
    ].filter(Boolean);

    return parts.join(" | ");
  });

  return `
    <section class="niis-panel">
      <h3>Planner Output</h3>
      <div class="niis-card-grid">
        <div class="niis-card"><span class="niis-label">Planner mode</span><span class="niis-value niis-value-small">${escapeHtml(artifact.planner_mode)}</span></div>
        <div class="niis-card"><span class="niis-label">Planner runtime</span><span class="niis-value niis-value-small">${escapeHtml(artifact.planner_runtime ?? "fallback")}</span></div>
        <div class="niis-card"><span class="niis-label">Route lane</span><span class="niis-value niis-value-small">${escapeHtml(selectedLane)}</span></div>
        <div class="niis-card"><span class="niis-label">Adapter</span><span class="niis-value niis-value-small">${escapeHtml(selectedAdapter)}</span></div>
      </div>
      <p><strong>Derived title:</strong> ${escapeHtml(artifact.derived_task.title)}</p>
      <p><strong>Summary:</strong> ${escapeHtml(artifact.summary)}</p>
      <p><strong>Target paths:</strong> ${escapeHtml(formatMaybeList(artifact.reference_bundle?.target_paths))}</p>
      <p><strong>Guidance:</strong> ${escapeHtml(formatMaybeList(artifact.reference_bundle?.guides))}</p>
      <p><strong>Acceptance checks:</strong> ${escapeHtml(formatMaybeList(artifact.acceptance_checks))}</p>
      <p><strong>Subtasks:</strong> ${escapeHtml(formatMaybeList((artifact.subtasks ?? []).map((subtask) => subtask.title ?? subtask.id)))}</p>
      <p><strong>Planner attempts:</strong> ${escapeHtml(formatMaybeList(preview.planner_attempts.map((attempt) => `${attempt.runtime_id}:${attempt.ok ? "ok" : "fallback"}`)))}</p>
      ${plannerAttemptDetails.length > 0 ? `<details class="niis-details-panel"><summary>Planner diagnostics</summary><pre>${escapeHtml(plannerAttemptDetails.join("\n\n"))}</pre></details>` : ""}
      ${routePreview.reason ? `<p><strong>Route status:</strong> ${escapeHtml(routePreview.reason)}</p>` : ""}
    </section>`;
}

function renderMarkdownInline(text) {
  let out = escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  return out;
}

function renderMarkdownPreview(content, emptyLabel) {
  if (typeof content !== "string" || content.trim() === "") {
    return `<p>${escapeHtml(emptyLabel)}</p>`;
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const chunks = [];
  let paragraph = [];
  let listItems = [];
  let codeLines = [];
  let inCodeBlock = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    chunks.push(`<p>${renderMarkdownInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }
    chunks.push(`<ul>${listItems.map((item) => `<li>${renderMarkdownInline(item)}</li>`).join("")}</ul>`);
    listItems = [];
  };

  const flushCode = () => {
    if (codeLines.length === 0) {
      return;
    }
    chunks.push(`<pre class="niis-prompt-block"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushParagraph();
      flushList();
      if (inCodeBlock) {
        flushCode();
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = Math.min(4, headingMatch[1].length + 1);
      chunks.push(`<h${level}>${renderMarkdownInline(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    const listMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1].trim());
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCode();

  return `<div class="niis-markdown-preview">${chunks.join("")}</div>`;
}

function renderMarkdownEditorField({
  hint = null,
  label,
  name,
  placeholder,
  value,
}) {
  return `
    <section class="niis-panel niis-task-detail-panel niis-markdown-editor-panel">
      <div class="niis-task-detail-section-head">
        <h3>${escapeHtml(label)}</h3>
        <span>${escapeHtml(hint ?? "Markdown is stored in SQLite and rendered safely.")}</span>
      </div>
      <div class="niis-markdown-editor-shell">
        <label class="niis-markdown-editor-field">
          <span>${escapeHtml(label)} markdown</span>
          <textarea name="${escapeHtml(name)}" rows="10" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value ?? "")}</textarea>
        </label>
        <div class="niis-markdown-editor-preview">
          <span>Preview</span>
          ${renderMarkdownPreview(value, `${label} preview will appear here.`)}
        </div>
      </div>
    </section>`;
}

function renderTaskMarkdown(content, emptyLabel) {
  return renderMarkdownPreview(content, emptyLabel);
}

function renderExecutionProgress(taskWorkbenchArtifacts = null) {
  const progress = taskWorkbenchArtifacts?.executionProgress ?? null;
  const logTail = taskWorkbenchArtifacts?.executionLogTail ?? null;

  if (!progress) {
    return "<p>No active execution progress recorded.</p>";
  }

  return `
    <div class="niis-stack-list">
      <article class="niis-task-card">
        <h4>${escapeHtml(progress.stage ?? "unknown")}</h4>
        <div>Task status: ${escapeHtml(progress.task_status ?? "unknown")}</div>
        <div>Adapter: ${escapeHtml(progress.adapter_id ?? "pending")}</div>
        <div>Run: ${escapeHtml(progress.run_id ?? "pending")}</div>
        <div>Verdict: ${escapeHtml(progress.verdict_class ?? "pending")}</div>
        <div>Updated: ${escapeHtml(formatTimestamp(progress.updated_at))}</div>
        <div>${escapeHtml(progress.summary ?? "Execution progress is being recorded.")}</div>
      </article>
      <article class="niis-task-card">
        <h4>Runtime Stream</h4>
        <div class="niis-muted">Shows staged execution updates and captured runtime log output, not private model reasoning.</div>
        ${logTail ? `<pre class="niis-prompt-block">${escapeHtml(logTail)}</pre>` : "<div>No runtime output captured yet.</div>"}
      </article>
    </div>`;
}

function summarizeLiveTimelineEntry(entry) {
  if (!entry) {
    return "No summary recorded.";
  }

  if (typeof entry.payload?.summary === "string" && entry.payload.summary.trim() !== "") {
    return entry.payload.summary.trim();
  }

  if (entry.event_type === "route_selected" && entry.payload?.adapter_id) {
    return `Selected ${entry.payload.lane_id ?? "generalist"} via ${entry.payload.adapter_id}.`;
  }

  if (entry.event_type === "approval_resolved" && entry.payload?.decision) {
    return `Approval ${entry.payload.decision}: ${entry.payload.action_id ?? "action"}.`;
  }

  if (entry.payload?.stage) {
    return `${entry.payload.stage}: ${entry.payload.task_status ?? "updated"}.`;
  }

  return entry.event_type.replaceAll("_", " ");
}

function renderLifecycleDetail(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    return "";
  }

  return `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value.trim())}</p>`;
}

function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount === 0) {
    return "0";
  }
  if (amount >= 0.01) {
    return amount.toFixed(2);
  }
  return amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function formatDurationHuman(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function formatTokenNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1000) return n.toLocaleString("en-US");
  return String(n);
}

const PLANNER_PERSONA = {
  accent: "#a855f7",
  avatar_url: null,
  bio: "Pedantic planner — splits a task into the smallest atomic subtasks.",
  name: "Vera",
  role: "Planner",
};





const PLANNER_BUBBLE_FRAMES = [

  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6"/><path d="m21 21-5-5"/></svg>`,

  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a6 6 0 0 0-3.5 10.5c.5.5 1 1.2 1 2V14h5v-1.5c0-.8.5-1.5 1-2A6 6 0 0 0 12 2z"/></svg>`,

  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 14.5a2 2 0 1 0-3 0V17h-2.5a2 2 0 1 0 0 3H17v2.5a2 2 0 1 0 3 0V20h2.5a2 2 0 1 0 0-3H20v-2.5z"/><path d="M12 4a2 2 0 1 0-2.83 2.83L9 7v3H6l.17-.17a2 2 0 1 0-2.83 2.83A2 2 0 1 0 6.17 15.17L6 15h3v3l-.17-.17a2 2 0 1 0 0 2.83A2 2 0 1 0 11.66 18L12 18.17V15h3a2 2 0 1 0 0-3h-3V9l.17.17a2 2 0 1 0 0-2.83z" opacity="0"/></svg>`,

  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4-12 12H5v-4z"/><path d="M14.5 5.5l4 4"/></svg>`,
];

function renderPlannerPersonaHeader({ state }) {
  if (state === "waiting") return "";
  const stateClass = `niis-persona-card-${state}`;
  const statusText = state === "active"
    ? "is planning the task"
    : state === "complete"
      ? "plan ready"
      : "planning failed";
  const dotsHtml = state === "active"
    ? `<span class="niis-persona-typing"><span></span><span></span><span></span></span>`
    : "";


  const bubbleHtml = state === "active"
    ? `<div class="niis-persona-bubble" aria-hidden="true">
        ${PLANNER_BUBBLE_FRAMES.map((svg) => `<span class="niis-persona-bubble-frame">${svg}</span>`).join("")}
      </div>`
    : "";
  return `
    <div class="niis-persona-card ${stateClass}" style="--persona-accent: ${PLANNER_PERSONA.accent};">
      <div class="niis-persona-avatar-wrap">
        ${bubbleHtml}
        <div class="niis-persona-avatar" aria-hidden="true">
          <img src="${escapeHtml(PLANNER_PERSONA.avatar_url)}" alt="" loading="lazy" />
        </div>
      </div>
      <div class="niis-persona-meta">
        <div class="niis-persona-name-row">
          <span class="niis-persona-name">${escapeHtml(PLANNER_PERSONA.name)}</span>
          <span class="niis-persona-role">${escapeHtml(PLANNER_PERSONA.role)}</span>
        </div>
        <div class="niis-persona-status">
          <span class="niis-persona-status-text">${escapeHtml(statusText)}</span>
          ${dotsHtml}
        </div>
      </div>
    </div>`;
}

function renderPlanningBody({ intakeArtifact, plannerCostBadges, plannerMode, plannerRuntime }) {
  const derived = intakeArtifact.derived_task ?? {};
  const summary = typeof intakeArtifact.summary === "string" && intakeArtifact.summary.trim() !== ""
    ? intakeArtifact.summary.trim()
    : null;
  const targetPaths = intakeArtifact.reference_bundle?.target_paths ?? [];
  const acceptanceChecks = Array.isArray(intakeArtifact.acceptance_checks) ? intakeArtifact.acceptance_checks : [];
  const guides = Array.isArray(intakeArtifact.reference_bundle?.guides) ? intakeArtifact.reference_bundle.guides : [];
  const outOfScope = Array.isArray(derived.out_of_scope) ? derived.out_of_scope : [];
  const subtasks = Array.isArray(intakeArtifact.subtasks) ? intakeArtifact.subtasks : [];

  const headerBadges = [
    derived.priority ? `<span class="niis-cost-badge" data-kind="duration"><span class="niis-cost-badge-label">priority</span><span class="niis-cost-badge-value">${escapeHtml(derived.priority)}</span></span>` : "",
    Number.isFinite(derived.phase) ? `<span class="niis-cost-badge" data-kind="duration"><span class="niis-cost-badge-label">phase</span><span class="niis-cost-badge-value">${escapeHtml(String(derived.phase))}</span></span>` : "",
    `<span class="niis-cost-badge" data-kind="duration"><span class="niis-cost-badge-label">planner</span><span class="niis-cost-badge-value">${escapeHtml(plannerMode)} / ${escapeHtml(plannerRuntime)}</span></span>`,
  ].filter(Boolean).join("");

  const subtaskAnchor = subtasks.length > 0
    ? `<p style="margin-top: 0.75rem;"><strong>Subtasks:</strong> ${subtasks.length} planned — see <a href="#subtasks">Sub-tasks</a> above for full breakdown.</p>`
    : "";

  const collapsibleSections = [];
  if (acceptanceChecks.length > 0) {
    collapsibleSections.push(`
      <details class="niis-details-panel niis-task-lifecycle-details">
        <summary>Acceptance checks (${acceptanceChecks.length})</summary>
        <ul class="niis-task-lifecycle-details-list">
          ${acceptanceChecks.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}
        </ul>
      </details>`);
  }
  if (guides.length > 0) {
    collapsibleSections.push(`
      <details class="niis-details-panel niis-task-lifecycle-details">
        <summary>Operator guidance (${guides.length})</summary>
        <ul class="niis-task-lifecycle-details-list">
          ${guides.map((g) => `<li>${escapeHtml(typeof g === "string" ? g : g?.content ?? "")}</li>`).join("")}
        </ul>
      </details>`);
  }
  if (outOfScope.length > 0) {
    collapsibleSections.push(`
      <details class="niis-details-panel niis-task-lifecycle-details">
        <summary>Out of scope (${outOfScope.length})</summary>
        <ul class="niis-task-lifecycle-details-list">
          ${outOfScope.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}
        </ul>
      </details>`);
  }

  return `
    <div class="niis-task-lifecycle-copy">
      ${derived.title ? `<p><strong>${escapeHtml(derived.title)}</strong></p>` : ""}
      <div class="niis-cost-badges">${headerBadges}</div>
      ${summary ? `<p>${escapeHtml(summary)}</p>` : ""}
      ${targetPaths.length > 0
        ? `<p><strong>Target paths:</strong> ${escapeHtml(formatMaybeList(targetPaths))}</p>`
        : ""}
      ${subtaskAnchor}
      ${plannerCostBadges}
      ${collapsibleSections.join("")}
    </div>`;
}

function renderSubtaskSummariesMarkdown(entries) {
  const withSummary = (Array.isArray(entries) ? entries : []).filter(
    (entry) => typeof entry?.summary === "string" && entry.summary.trim() !== "",
  );
  if (withSummary.length === 0) return "";
  return `
    <details class="niis-details-panel niis-task-lifecycle-details">
      <summary>Subtask reports (${withSummary.length})</summary>
      <div class="niis-task-lifecycle-details-body">
        ${withSummary.map((entry) => `
          <article class="niis-task-lifecycle-details-body" style="margin-top: 0.75rem;">
            <p><strong>${escapeHtml(entry.id)}</strong>${entry.role_id ? ` <span class="niis-task-lifecycle-owner" data-accent="run">${escapeHtml(entry.role_id)}</span>` : ""}</p>
            ${renderMarkdownPreview(entry.summary, "")}
          </article>`).join("")}
      </div>
    </details>`;
}

function renderEvidenceItem(item) {
  return `<li><strong>${escapeHtml(item.type)}</strong> <span class="niis-text-muted">${escapeHtml(item.source)}</span><br/>${escapeHtml(truncateText(item.content, 200))}</li>`;
}

function renderEvidenceItems(items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  const grouped = new Map();
  const ungrouped = [];
  for (const item of items) {
    if (item.subtask_id) {
      const list = grouped.get(item.subtask_id) ?? [];
      list.push(item);
      grouped.set(item.subtask_id, list);
    } else {
      ungrouped.push(item);
    }
  }
  if (grouped.size === 0) {
    return `<ul class="niis-task-lifecycle-details-list">${ungrouped.map(renderEvidenceItem).join("")}</ul>`;
  }
  const groupBlocks = [...grouped.entries()].map(([subtaskId, group]) => `
    <div class="niis-task-lifecycle-details-body" style="margin-top: 0.5rem;">
      <p><strong>Subtask:</strong> <code>${escapeHtml(subtaskId)}</code></p>
      <ul class="niis-task-lifecycle-details-list">${group.map(renderEvidenceItem).join("")}</ul>
    </div>`).join("");
  const ungroupedBlock = ungrouped.length > 0
    ? `<ul class="niis-task-lifecycle-details-list">${ungrouped.map(renderEvidenceItem).join("")}</ul>`
    : "";
  return groupBlocks + ungroupedBlock;
}

function formatCostInline(cost) {
  if (!cost || typeof cost !== "object") return "—";
  const parts = [];
  if (Number(cost.estimated_usd) > 0) parts.push(`$${formatUsd(Number(cost.estimated_usd))}`);
  if (Number(cost.duration_ms) > 0) parts.push(formatDurationHuman(Number(cost.duration_ms)));
  if (Number(cost.tokens_in) > 0 || Number(cost.tokens_out) > 0) {
    parts.push(`${formatTokenNumber(Number(cost.tokens_in))}↓/${formatTokenNumber(Number(cost.tokens_out))}↑`);
  }
  return parts.length > 0 ? escapeHtml(parts.join(" · ")) : "—";
}

function renderCostBadges(cost) {
  if (!cost) {
    return "";
  }

  const durationMs = Number(cost.duration_ms ?? 0);
  const estimatedUsd = Number(cost.estimated_usd ?? 0);
  const tokensIn = Number(cost.tokens_in ?? cost.input_tokens ?? 0);
  const tokensOut = Number(cost.tokens_out ?? cost.output_tokens ?? 0);
  const tokensCached = Number(cost.tokens_cached ?? cost.cached_input_tokens ?? 0);
  const modelId = typeof cost.model_id === "string" && cost.model_id.trim() !== "" ? cost.model_id.trim() : null;

  const badges = [];
  if (modelId) {
    badges.push(`<span class="niis-cost-badge" data-kind="model"><span class="niis-cost-badge-label">Model</span><span class="niis-cost-badge-value">${escapeHtml(modelId)}</span></span>`);
  }
  if (durationMs > 0) {
    badges.push(`<span class="niis-cost-badge" data-kind="duration"><span class="niis-cost-badge-label">Duration</span><span class="niis-cost-badge-value">${escapeHtml(formatDurationHuman(durationMs))}</span></span>`);
  }
  if (estimatedUsd > 0) {
    badges.push(`<span class="niis-cost-badge" data-kind="cost"><span class="niis-cost-badge-label">Cost</span><span class="niis-cost-badge-value">$${escapeHtml(formatUsd(estimatedUsd))}</span></span>`);
  }
  if (tokensIn > 0) {
    badges.push(`<span class="niis-cost-badge" data-kind="tokens-in"><span class="niis-cost-badge-label">Tokens in</span><span class="niis-cost-badge-value">${escapeHtml(formatTokenNumber(tokensIn))}</span></span>`);
  }
  if (tokensCached > 0) {
    badges.push(`<span class="niis-cost-badge" data-kind="tokens-cached"><span class="niis-cost-badge-label">Cached</span><span class="niis-cost-badge-value">${escapeHtml(formatTokenNumber(tokensCached))}</span></span>`);
  }
  if (tokensOut > 0) {
    badges.push(`<span class="niis-cost-badge" data-kind="tokens-out"><span class="niis-cost-badge-label">Tokens out</span><span class="niis-cost-badge-value">${escapeHtml(formatTokenNumber(tokensOut))}</span></span>`);
  }

  return badges.length > 0 ? `<div class="niis-cost-badges">${badges.join("")}</div>` : "";
}


function deriveLifecycleStepState({
  activeSession,
  executionProgress,
  latestVerdict,
  reportLinks,
  routeEntry,
  taskStatus = null,
  planningCompleted = false,
  validatorEntry = null,
}) {
  const phase = String(activeSession?.active_phase ?? executionProgress?.stage ?? "").toLowerCase();
  const isIdle = taskStatus === "PENDING" || taskStatus === "BLOCKED" || taskStatus === "REJECTED" || taskStatus === "DONE";
  const validatorStarted = Boolean(validatorEntry) || Boolean(latestVerdict);



  let activeStep = 0;

  if (taskStatus === "UNPLANNED") {
    activeStep = 1;
  } else if (taskStatus === "PLANNING") {
    activeStep = 2;
  } else if (taskStatus === "DONE" && (reportLinks.length > 0 || latestVerdict)) {
    activeStep = 0;
  } else if (phase === "blocked" || phase === "failed") {


    if (validatorStarted) activeStep = 5;
    else if (routeEntry) activeStep = 4;
    else if (planningCompleted) activeStep = 3;
    else activeStep = 0;
  } else if (phase === "completed") {
    activeStep = 6;
  } else if (phase === "reviewing") {
    activeStep = 5;
  } else if (phase === "preparing" || phase === "executing") {
    activeStep = 4;
  } else if (phase === "queued" || phase === "routing") {
    activeStep = routeEntry ? 4 : 3;
  } else if (taskStatus === "IN_PROGRESS" || taskStatus === "IN_REVIEW") {
    activeStep = routeEntry ? 4 : 3;
  } else if (isIdle && !routeEntry && phase === "") {
    activeStep = 0;
  } else if (routeEntry) {
    activeStep = 4;
  }

  return {
    activeStep,
    phase,
  };
}

function buildLifecyclePhaseStatus({
  activeStep,
  executionProgress,
  latestVerdict,
  planningStatus = null,
  reportLinks,
  routeEntry,
  step,
  taskCard,
  validatorEntry,
}) {
  if (activeStep !== step) {
    return null;
  }


  if (step === 2) {
    return planningStatus ?? "Planner is decomposing the task into structured artifacts.";
  }


  if (step === 3) {
    return routeEntry
      ? summarizeLiveTimelineEntry(routeEntry)
      : executionProgress?.summary ?? "Selecting execution lane and adapter.";
  }


  if (step === 4) {
    return executionProgress?.summary
      ?? taskCard?.live_excerpts?.find((excerpt) => excerpt.channel === "summary")?.content
      ?? "Run is active. Operator-safe execution updates will stream here.";
  }


  if (step === 5) {
    return taskCard?.run_sessions?.find((session) => !session.finished_at)?.summary
      ?? latestVerdict?.reason
      ?? summarizeLiveTimelineEntry(validatorEntry)
      ?? "Validator review is active.";
  }


  if (step === 6) {
    return reportLinks.length > 0
      ? "Publishing audit artifacts and final reports."
      : "Final report packaging is in progress.";
  }

  return null;
}

function renderLifecyclePhase(index, title, body, {
  active = false,
  completed = false,
  accent = "default",
  owner = null,
  statusText = null,
} = {}) {
  const ownerBadge = owner
    ? `<span class="niis-task-lifecycle-owner" data-accent="${escapeHtml(accent)}">${escapeHtml(owner)}</span>`
    : "";
  return `
    <section class="niis-task-lifecycle-phase" data-accent="${escapeHtml(accent)}" data-active="${active ? "true" : "false"}" data-completed="${completed ? "true" : "false"}">
      <div class="niis-task-lifecycle-marker">${index}</div>
      <div class="niis-task-lifecycle-phase-body">
        <h4>${escapeHtml(title)}${ownerBadge}</h4>
        ${statusText ? `<p class="niis-task-lifecycle-phase-status" data-active="${active ? "true" : "false"}">${escapeHtml(`Active now: ${statusText}`)}</p>` : ""}
        ${body}
      </div>
    </section>`;
}

function buildTaskLiveCardFragment({ taskCard, detail = null, taskWorkbenchArtifacts = null }) {
  if (!taskCard?.task && !detail?.task) {
    return "<div class=\"niis-muted\">Live task card is unavailable.</div>";
  }

  const taskStatus = detail?.task?.status ?? taskCard?.task?.status ?? "PENDING";
  const transitionLog = detail?.task?.transition_log ?? [];
  const planningExitTransition = transitionLog.find((t) =>
    t.from_status === "PLANNING" && (t.to_status === "BLOCKED" || t.to_status === "PENDING"));
  const planningCompleted = taskStatus !== "UNPLANNED" && taskStatus !== "PLANNING";

  const routeEntry = taskCard?.live_timeline?.find((entry) => entry.event_type === "route_selected") ?? null;
  const validatorEntry = taskCard?.live_timeline?.find((entry) => entry.event_type === "validator_started") ?? null;
  const activeSession = taskCard?.run_sessions?.find((session) => !session.finished_at) ?? taskCard?.run_sessions?.[0] ?? null;
  const curatedExcerpts = (taskCard?.live_excerpts ?? []).filter((excerpt) => excerpt.channel !== "stdout" && excerpt.channel !== "stderr");
  const workerExcerpts = curatedExcerpts.filter((excerpt) => excerpt.channel !== "validator");
  const rawExcerpts = (taskCard?.live_excerpts ?? []).filter((excerpt) => excerpt.channel === "stdout" || excerpt.channel === "stderr");
  const summaryExcerpt = workerExcerpts.find((excerpt) => excerpt.channel === "summary") ?? null;
  const validatorExcerpt = curatedExcerpts.find((excerpt) => excerpt.channel === "validator") ?? null;
  const reportLinks = [
    taskCard?.artifacts?.report_json_url ? `<a href="${escapeHtml(taskCard.artifacts.report_json_url)}">Report JSON</a>` : "",
    taskCard?.artifacts?.report_markdown_url ? `<a href="${escapeHtml(taskCard.artifacts.report_markdown_url)}">Report Markdown</a>` : "",
    taskWorkbenchArtifacts?.report_json_url ? `<a href="${escapeHtml(taskWorkbenchArtifacts.report_json_url)}">Report JSON</a>` : "",
    taskWorkbenchArtifacts?.report_markdown_url ? `<a href="${escapeHtml(taskWorkbenchArtifacts.report_markdown_url)}">Report Markdown</a>` : "",
  ].filter(Boolean);
  const intakeArtifact = taskWorkbenchArtifacts?.intakeArtifact;
  const routePreview = taskWorkbenchArtifacts?.routePreview ?? intakeArtifact?.route_preview;

  const lifecycleState = deriveLifecycleStepState({
    activeSession,
    executionProgress: taskCard?.execution_progress,
    latestVerdict: taskCard?.latest_verdict,
    planningCompleted,
    reportLinks,
    routeEntry,
    taskStatus,
    validatorEntry,
  });


  const intakeBody = `
    <div class="niis-task-lifecycle-copy">
      <p><code>${escapeHtml(taskCard?.intake_prompt ?? detail?.task?.operator_brief_markdown ?? "No intake prompt recorded.")}</code></p>
      <p>Recorded at ${escapeHtml(formatTimestamp(detail?.task?.created_at ?? taskCard?.task?.created_at ?? taskCard?.live_timeline?.[0]?.ts))}.</p>
    </div>`;


  const plannerMode = intakeArtifact?.planner_mode ?? "pending";
  const plannerRuntime = intakeArtifact?.planner_runtime ?? "unknown";
  const plannerCost = intakeArtifact?.planner_cost ?? null;
  const plannerCostBadges = renderCostBadges(plannerCost);
  const planningFailed = Boolean(planningExitTransition?.reason?.includes("Planning failed"));
  const isPlanning = taskStatus === "PLANNING";
  const planningStepTitle = isPlanning
    ? "Planning"
    : planningCompleted && !planningFailed
      ? "Planned"
      : planningFailed
        ? "Planning failed"
        : "Planning";


  const isPlannerWorking = isPlanning || taskStatus === "UNPLANNED";
  const personaState = isPlannerWorking && !planningCompleted
    ? "active"
    : planningCompleted && intakeArtifact
      ? "complete"
      : planningFailed
        ? "failed"
        : "waiting";
  const personaHeader = renderPlannerPersonaHeader({ state: personaState });
  const planningInner = isPlannerWorking && !planningCompleted
    ? `
      <div class="niis-task-lifecycle-copy niis-planning-active">
        <p class="niis-planning-active-hint">Decomposing task, defining acceptance criteria and target paths.</p>
      </div>`
    : planningCompleted && intakeArtifact
      ? `<div class="niis-planning-stream" data-planning-stream>${renderPlanningBody({ intakeArtifact, plannerCostBadges, plannerMode, plannerRuntime })}</div>`
      : planningFailed
        ? `
          <div class="niis-task-lifecycle-copy niis-planning-failed">
            <p>${escapeHtml(planningExitTransition?.reason ?? "Planning failed with unknown error.")}</p>
          </div>`
        : `
          <div class="niis-task-lifecycle-copy">
            <p>Waiting for planning to begin.</p>
          </div>`;
  const planningBody = `${personaHeader}${planningInner}`;


  const hasRealRoute = Boolean(routeEntry) || Boolean(routePreview?.selected_adapter);
  const runtimeChoice = (detail?.decisions ?? []).find((d) => d.decision_type === "ROUTE")
    ?? (detail?.decisions ?? []).find((d) => d.decision_type === "ASSIGNMENT")
    ?? null;
  const selectedLaneData = routePreview?.selected_lane ?? null;
  const selectedAdapterData = routePreview?.selected_adapter ?? null;
  const routeAlternatives = runtimeChoice?.alternatives_considered
    ?? routeEntry?.payload?.alternatives_considered
    ?? [];
  const costTier = selectedLaneData?.cost_tier ?? routeEntry?.payload?.cost_tier ?? null;
  const adapterToolFamilies = selectedAdapterData?.capabilities?.toolFamilies
    ?? selectedAdapterData?.capabilities?.tool_families
    ?? [];
  const healthAssets = selectedLaneData?.health_assets ?? routeEntry?.payload?.health_assets ?? [];
  const policyRefs = runtimeChoice?.policy_refs
    ?? routeEntry?.payload?.policy_refs
    ?? routePreview?.routing_policy?.policy_refs
    ?? [];
  const routeSelectedLaneId = routeEntry?.payload?.lane_id
    ?? routePreview?.selected_lane?.lane_id
    ?? "generalist";
  const routeSelectedAdapterId = routeEntry?.payload?.adapter_id
    ?? routePreview?.selected_adapter?.id
    ?? "pending";
  const whyParts = [];
  if (costTier?.tier) {
    whyParts.push(
      Number.isFinite(costTier.complexity_score)
        ? `cost tier <strong>${escapeHtml(costTier.tier)}</strong> (complexity ${escapeHtml(String(costTier.complexity_score))})`
        : `cost tier <strong>${escapeHtml(costTier.tier)}</strong>`,
    );
  }
  if (selectedLaneData?.manifest_id) {
    whyParts.push(`matched manifest <code>${escapeHtml(selectedLaneData.manifest_id)}</code>`);
  }
  const whyLine = whyParts.length > 0
    ? `<p><strong>Why:</strong> ${whyParts.join(" · ")}</p>`
    : "";
  const routeBody = hasRealRoute
    ? `
      <div class="niis-task-lifecycle-copy">
        <p><strong>Selected:</strong> <code>${escapeHtml(routeSelectedLaneId)}</code> lane via <code>${escapeHtml(routeSelectedAdapterId)}</code> adapter${routeEntry ? ` <span class="niis-text-muted">at ${escapeHtml(formatTimestamp(routeEntry?.ts ?? activeSession?.started_at))}</span>` : ""}.</p>
        ${whyLine}
        ${routeAlternatives.length > 0 ? `
          <details class="niis-details-panel niis-task-lifecycle-details">
            <summary>Alternatives considered (${routeAlternatives.length})</summary>
            <ul class="niis-task-lifecycle-details-list">
              ${routeAlternatives.map((alt) => `<li><strong>${escapeHtml(alt.option ?? "option")}</strong><br/>${escapeHtml(alt.reason_rejected ?? alt.reason ?? "No reason recorded.")}</li>`).join("")}
            </ul>
          </details>` : ""}
        <details class="niis-details-panel niis-task-lifecycle-details">
          <summary>Routing details</summary>
          <div class="niis-task-lifecycle-details-body">
            ${adapterToolFamilies.length > 0 ? renderLifecycleDetail("Adapter capabilities", formatMaybeList(adapterToolFamilies)) : ""}
            ${healthAssets.length > 0 ? renderLifecycleDetail("Health assets", formatMaybeList(healthAssets)) : ""}
            ${policyRefs.length > 0 ? renderLifecycleDetail("Policy refs", formatMaybeList(policyRefs)) : ""}
            ${runtimeChoice?.route_chosen ? renderLifecycleDetail("Internal route id", runtimeChoice.route_chosen) : ""}
          </div>
        </details>
      </div>`
    : `
      <div class="niis-task-lifecycle-copy">
        <p>Routing decision not recorded yet.</p>
      </div>`;

  const selectedLaneId = routeEntry?.payload?.lane_id ?? routePreview?.selected_lane?.lane_id ?? null;
  const runRoleName = selectedLaneId === "frontend" ? "frontend-specialist"
    : selectedLaneId === "validator" ? "validator"
    : selectedLaneId ? `${selectedLaneId}-worker`
    : "generalist-worker";


  const hasExecutionSession = Boolean(activeSession) || Boolean(taskCard?.execution_progress);
  const activeRunRecord = (detail?.runs ?? []).find((r) => r.id === activeSession?.run_id) ?? (detail?.runs ?? [])[0] ?? null;
  const runAdapterId = activeSession?.runtime_family ?? taskCard?.execution_progress?.adapter_id ?? activeRunRecord?.adapter_id ?? null;
  const runSessionStatus = activeSession?.status ?? (taskCard?.execution_progress?.active === false ? "COMPLETED" : activeRunRecord?.status ?? null);
  const runProgressSummary = taskCard?.execution_progress?.summary ?? null;
  const workerReport = summaryExcerpt?.content ?? runProgressSummary ?? null;
  const runStatusLine = runAdapterId
    ? `${(runSessionStatus ?? "RUNNING").toUpperCase()} via ${runAdapterId}.`
    : null;
  const runCostBadges = renderCostBadges(activeRunRecord?.cost ?? null);
  const runPhases = (detail?.activity ?? [])
    .filter((entry) => entry.title === "STATE_CHANGE" && entry.payload?.lifecycle_phase)
    .map((entry) => ({
      phase: entry.payload.lifecycle_phase,
      status: entry.payload.phase_status ?? "recorded",
      summary: entry.summary,
      ts: entry.timestamp,
    }));
  const runActivityEntries = (detail?.activity ?? [])
    .filter((entry) => entry.run_id === (activeRunRecord?.id ?? activeSession?.run_id));
  const subtaskProgressEntries = Array.isArray(taskWorkbenchArtifacts?.subtaskProgress?.subtasks)
    ? taskWorkbenchArtifacts.subtaskProgress.subtasks
    : [];
  const subtaskBlockSummary = subtaskProgressEntries.length === 1 && subtaskProgressEntries[0].id?.endsWith(":main")
    ? "Isolated run"
    : `Parallel Subtasks (${subtaskProgressEntries.length})`;




  const subtaskLaneGrid = subtaskProgressEntries.length >= 2
    ? `
      <div class="niis-subtask-lane-grid niis-parallel-tree" data-lane-count="${escapeHtml(subtaskProgressEntries.length)}">
        ${subtaskProgressEntries.map((entry) => {
          const laneStatus = (entry.status ?? "pending").toLowerCase();
          const summaryInline = entry.summary
            ? (entry.summary.length > 220 ? `${entry.summary.slice(0, 220)}…` : entry.summary)
            : null;
          return `
            <article class="niis-subtask-lane" data-lane-status="${escapeHtml(laneStatus)}">
              <header class="niis-subtask-lane-header">
                <code>${escapeHtml(entry.id)}</code>
                <span class="niis-task-status-badge" data-status="${escapeHtml(laneStatus)}">${escapeHtml(entry.status ?? "—")}</span>
              </header>
              <div class="niis-subtask-lane-meta">
                <span class="niis-muted">role</span> <strong>${escapeHtml(entry.role_id ?? "generalist")}</strong>
                <span class="niis-muted" style="margin-left: 0.5rem;">model</span> <strong>${escapeHtml(entry.cost?.model_id ?? "—")}</strong>
              </div>
              <div class="niis-subtask-lane-cost">${entry.cost ? formatCostInline(entry.cost) : "<span class=\"niis-text-muted\">—</span>"}</div>
              ${summaryInline ? `<p class="niis-subtask-lane-summary">${escapeHtml(summaryInline)}</p>` : ""}
              ${entry.branch?.name
                ? `<p class="niis-muted" style="font-size: 0.8125rem;">branch: <code>${escapeHtml(entry.branch.name)}</code> — ${escapeHtml(entry.branch.merge_status ?? "pending")}</p>`
                : ""}
            </article>`;
        }).join("")}
      </div>`
    : "";
  const subtaskProgressBlock = subtaskProgressEntries.length > 0
    ? `
      <details class="niis-details-panel niis-task-lifecycle-details">
        <summary>${escapeHtml(subtaskBlockSummary)} — table view</summary>
        <table class="niis-table">
          <thead>
            <tr><th>Subtask</th><th>Role</th><th>Model</th><th>Status</th><th>Cost</th></tr>
          </thead>
          <tbody>
            ${subtaskProgressEntries.map((entry) => `
              <tr>
                <td><strong>${escapeHtml(entry.id)}</strong></td>
                <td>${escapeHtml(entry.role_id ?? "—")}</td>
                <td>${escapeHtml(entry.cost?.model_id ?? "—")}</td>
                <td>${escapeHtml(entry.status ?? "—")}</td>
                <td>${entry.cost ? formatCostInline(entry.cost) : "<span class=\"niis-text-muted\">—</span>"}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </details>`
    : "";
  const parallelBatchBadge = subtaskProgressEntries.length > 1
    ? `<div class="niis-cost-badges"><span class="niis-cost-badge" data-kind="parallel"><span class="niis-cost-badge-label">Parallel</span><span class="niis-cost-badge-value">\u00d7 ${subtaskProgressEntries.length}</span></span></div>`
    : "";
  const pendingBranches = subtaskProgressEntries.filter((entry) =>
    entry.branch?.name
    && entry.branch.had_changes
    && entry.branch.merge_status !== "merged"
    && entry.branch.merge_status !== "discarded"
    && entry.branch.merge_status !== "pr_opened");
  const isolationIsSingleShot = subtaskProgressEntries.length === 1
    && subtaskProgressEntries[0].id?.endsWith(":main");
  const pendingBranchesHeading = isolationIsSingleShot
    ? "Isolated workspace report"
    : `Reviewable attempt branches (${pendingBranches.length})`;
  const pendingBranchesIntro = "Read-only branch inspection. Reliability RC requires canonical <code>PASS</code> before promotion creates a reviewable branch. This screen cannot publish, land, or delete branch data; finish the landing manually with your normal Git workflow.";
  const pendingBranchesBlock = pendingBranches.length > 0
    ? `
      <section class="niis-section niis-section--callout" data-niis-pending-branches>
        <h3>${escapeHtml(pendingBranchesHeading)}</h3>
        <p>${pendingBranchesIntro}</p>
        <table class="niis-table">
          <thead>
            <tr><th>Subtask</th><th>Branch</th><th>Worktree</th><th>Recorded status</th></tr>
          </thead>
          <tbody>
            ${pendingBranches.map((entry) => {
              return `
              <tr>
                <td><strong>${escapeHtml(entry.id)}</strong><br/><span class="niis-text-muted">${escapeHtml(entry.role_id ?? "—")}</span></td>
                <td><code>${escapeHtml(entry.branch.name)}</code></td>
                <td><code>${escapeHtml(entry.branch.worktree_path ?? "—")}</code></td>
                <td>${escapeHtml(entry.branch.merge_status ?? "pending")}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </section>`
    : "";
  const runRoleHeading = (() => {
    if (subtaskProgressEntries.length === 0) {
      return runRoleName;
    }
    const roles = Array.from(new Set(subtaskProgressEntries.map((entry) => entry.role_id).filter(Boolean)));
    const models = Array.from(new Set(subtaskProgressEntries.map((entry) => entry.cost?.model_id).filter(Boolean)));
    const roleLabel = roles.length === 1 ? roles[0] : (roles.length === 0 ? runRoleName : `${roles.length} roles`);
    const modelSuffix = models.length === 1 ? ` \u00b7 ${models[0]}` : "";
    return `${roleLabel}${modelSuffix}`;
  })();
  const subtaskMarkdownBlock = renderSubtaskSummariesMarkdown(taskWorkbenchArtifacts?.subtaskProgress?.subtasks ?? []);
  const stageNoiseRegex = /Task queued from the control plane\.|Task status moved to IN_PROGRESS|Selected lane .+ with adapter|Agent execution is running via/i;
  const stageExcerpts = workerExcerpts.filter((excerpt) => stageNoiseRegex.test(excerpt.content));
  const informativeExcerpts = workerExcerpts.filter((excerpt) =>
    excerpt !== summaryExcerpt
    && !stageNoiseRegex.test(excerpt.content));
  const workerReportRendered = workerReport
    ? renderMarkdownPreview(workerReport, "")
    : "<p>Execution progress is being recorded.</p>";
  const hasAnyRunSignal = hasExecutionSession || subtaskProgressEntries.length > 0;
  const runBody = hasAnyRunSignal
    ? `
      <div class="niis-task-lifecycle-copy">
        ${hasExecutionSession
          ? `<p><strong>${escapeHtml(`${runRoleHeading} report`)}:</strong></p>`
          : `<p class="niis-muted">Dispatching ${escapeHtml(String(subtaskProgressEntries.length))} subtask${subtaskProgressEntries.length === 1 ? "" : "s"}…</p>`}
        ${parallelBatchBadge}
        ${hasExecutionSession ? workerReportRendered : ""}
        ${hasExecutionSession ? renderLifecycleDetail("Adapter", runStatusLine) : ""}
        ${runCostBadges}
        ${pendingBranchesBlock}
        ${subtaskLaneGrid}
        ${subtaskProgressBlock}
        ${subtaskMarkdownBlock}
        ${detail?.task?.id
          ? `<details class="niis-details-panel niis-task-lifecycle-details"${taskStatus === "IN_PROGRESS" ? " open" : ""} data-live-log-panel>
              <summary>${taskStatus === "IN_PROGRESS" ? "Live log" : "Run log"} <span class="niis-muted" data-live-log-status>(loading…)</span></summary>
              <pre class="niis-prompt-block niis-live-log" data-live-log-stream data-task-id="${escapeHtml(detail.task.id)}" data-live-log-mode="${taskStatus === "IN_PROGRESS" ? "live" : "history"}"></pre>
            </details>`
          : ""}
        ${informativeExcerpts.map((excerpt) => renderMarkdownPreview(excerpt.content, "")).join("")}
        ${stageExcerpts.length > 0 ? `
          <details class="niis-details-panel niis-task-lifecycle-details">
            <summary>Stage timeline (${stageExcerpts.length})</summary>
            <ul class="niis-task-lifecycle-details-list">
              ${stageExcerpts.map((e) => `<li>${escapeHtml(e.content)}</li>`).join("")}
            </ul>
          </details>` : ""}
        ${runPhases.length > 0 ? `
          <details class="niis-details-panel niis-task-lifecycle-details">
            <summary>Run Phases</summary>
            <ul class="niis-task-lifecycle-details-list">
              ${runPhases.map((p) => `<li><strong>${escapeHtml(p.phase)}</strong> <span class="niis-text-muted">${escapeHtml(p.status)}</span><br/>${escapeHtml(p.summary)}<br/><span class="niis-text-muted">${escapeHtml(formatTimestamp(p.ts))}</span></li>`).join("")}
            </ul>
          </details>` : ""}
        ${runActivityEntries.length > 0 ? `
          <details class="niis-details-panel niis-task-lifecycle-details">
            <summary>Activity Timeline</summary>
            <ul class="niis-task-lifecycle-details-list">
              ${runActivityEntries.map((e) => `<li><strong>${escapeHtml(e.title)}</strong><br/>${escapeHtml(e.summary)}<br/><span class="niis-text-muted">${escapeHtml(e.source_kind)} at ${escapeHtml(formatTimestamp(e.timestamp))}</span></li>`).join("")}
            </ul>
          </details>` : ""}
        ${rawExcerpts.length > 0 || taskCard?.execution_log_tail
            ? `<details class="niis-details-panel niis-task-lifecycle-details">
              <summary>Logs</summary>
              <pre class="niis-prompt-block">${escapeHtml(
                rawExcerpts.length > 0
                  ? rawExcerpts.map((excerpt) => `[${excerpt.ts}] ${excerpt.content}`).join("\n\n")
                  : taskCard.execution_log_tail,
              )}</pre>
            </details>`
          : ""}
      </div>`
    : `
      <div class="niis-task-lifecycle-copy">
        <p>No execution session started yet.</p>
      </div>`;


  const hasReviewData = Boolean(taskCard?.latest_verdict) || Boolean(validatorEntry);
  const gateDecisions = taskCard?.validator_summary?.gate_decisions ?? [];
  const detailVerdicts = detail?.verdicts ?? [];
  const finalVerdict = taskCard?.latest_verdict?.verdict_class ?? "pending";
  const finalVerdictReason = taskCard?.latest_verdict?.reason ?? null;
  const validatorCount = gateDecisions.length;
  const evidencePacket = detail?.latest_evidence_packet ?? null;






  const reReviewAction = detail?.task?.id
    ? `/tasks/${encodeURIComponent(detail.task.id)}/actions/resolve`
    : null;
  const reReviewButton = reReviewAction
    ? `
      <form method="post" action="${escapeHtml(reReviewAction)}" style="display:inline-block;margin-top:0.5rem;" data-niis-confirm="Re-run the full validator chain for this task? This repeats git diff + LLM review against the current subtask branches. Costs LLM tokens.">
        <button type="submit" class="niis-btn-secondary" title="Re-run validator chain (authenticity + security + LLM + completion-proof) against the current subtask branches.">↻ Re-review</button>
      </form>`
    : "";




  const cancelAction = detail?.task?.id
    ? `/tasks/${encodeURIComponent(detail.task.id)}/actions/cancel`
    : null;
  const cancelButton = cancelAction && taskStatus === "IN_PROGRESS"
    ? `
      <form method="post" action="${escapeHtml(cancelAction)}" style="display:inline-block;margin-left:0.5rem;margin-top:0.5rem;" data-niis-confirm="Cancel this running task? Sends SIGTERM, then SIGKILL after 10s grace. Worktrees and intake artifacts are preserved.">
        <button type="submit" class="niis-btn-danger" title="Kill the start-task child process tracked by the UI supervisor.">✕ Cancel</button>
      </form>`
    : "";
  const reviewBody = hasReviewData
    ? `
      <div class="niis-task-lifecycle-copy">
        ${gateDecisions.length > 0
          ? gateDecisions.map((decision) =>
              `<p>${escapeHtml(decision.human_readable_summary)}</p>`
            ).join("")
          : renderLifecycleDetail("Validator report", finalVerdictReason ?? "Review completed.")}
        ${validatorCount > 0
          ? `<p><strong>Result:</strong> ${escapeHtml(`Validator lane stopped with ${finalVerdict} after ${validatorCount} validator(s).`)}</p>`
          : ""}
        <p><strong>Verdict:</strong> ${escapeHtml(finalVerdict)}.</p>
        ${reReviewButton}
        ${cancelButton}
        ${detailVerdicts.length > 0 ? `
          <details class="niis-details-panel niis-task-lifecycle-details">
            <summary>Verdict Details</summary>
            <ul class="niis-task-lifecycle-details-list">
              ${detailVerdicts.map((v) => `<li><strong>${escapeHtml(v.verdict_class)}</strong>${v.reviewer_id ? ` <span class="niis-text-muted">by ${escapeHtml(v.reviewer_id)}</span>` : ""}<br/>${escapeHtml(v.reason ?? "No reason recorded.")}${v.next_action ? `<br/>Next: ${escapeHtml(v.next_action)}` : ""}</li>`).join("")}
            </ul>
          </details>` : ""}
        ${evidencePacket ? `
          <details class="niis-details-panel niis-task-lifecycle-details">
            <summary>Evidence Summary</summary>
            <div class="niis-task-lifecycle-details-body">
              ${renderLifecycleDetail("Authenticity", evidencePacket.authenticity_status)}
              ${renderLifecycleDetail("Items", String(evidencePacket.items?.length ?? 0))}
              ${renderLifecycleDetail("Runtime evidence", evidencePacket.markers?.runtime_evidence_succeeded ? "yes" : "no")}
              ${renderEvidenceItems(evidencePacket.items ?? [])}
            </div>
          </details>` : ""}
      </div>`
    : `
      <div class="niis-task-lifecycle-copy">
        ${taskStatus === "BLOCKED" || taskStatus === "FAILED" || taskStatus === "REJECTED"
          ? `<p>Validator review did not run — task ended as <strong>${escapeHtml(taskStatus)}</strong> before reaching this step.</p>`
          : "<p>Validator review not started yet.</p>"}
      </div>`;


  const reportBody = `
    <div class="niis-task-lifecycle-copy">
      ${renderLifecycleDetail("Dispatcher report", reportLinks.length > 0 ? "Published final task reports and audit artifacts." : "Report artifacts are not available yet.")}
      ${reportLinks.length > 0
        ? `<div class="niis-task-lifecycle-link-list">${reportLinks.join("")}</div>`
        : "<p>No report artifacts available yet.</p>"}
    </div>`;


  const plannerOwner = isPlanning || planningCompleted ? "analytic" : null;
  const routeOwner = hasRealRoute || lifecycleState.activeStep === 3 ? "dispatcher" : null;
  const runOwner = hasExecutionSession || lifecycleState.activeStep === 4 ? runRoleName : null;
  const reviewOwner = hasReviewData ? "validator" : null;

  const runCompleted = hasExecutionSession && lifecycleState.activeStep !== 4;
  const reviewCompleted = hasReviewData && lifecycleState.activeStep !== 5;

  const steps = [
    { index: 1, title: "Intake", body: intakeBody, active: false, accent: "intake", completed: true, owner: "operator" },
    { index: 2, title: planningStepTitle, body: planningBody, active: isPlanning, accent: "planning", completed: planningCompleted && !planningFailed, owner: plannerOwner },
    { index: 3, title: "Route", body: routeBody, active: lifecycleState.activeStep === 3, accent: "route", completed: hasRealRoute, owner: routeOwner, step: 3 },
    { index: 4, title: "Run", body: runBody, active: lifecycleState.activeStep === 4 || (subtaskProgressEntries.length > 0 && !runCompleted), accent: "run", completed: runCompleted, owner: runOwner, step: 4 },
    { index: 5, title: "Review", body: reviewBody, active: lifecycleState.activeStep === 5, accent: "review", completed: reviewCompleted, owner: reviewOwner, step: 5 },
    { index: 6, title: "Report", body: reportBody, active: lifecycleState.activeStep === 6, accent: "report", completed: reportLinks.length > 0, owner: reportLinks.length > 0 ? "dispatcher" : null, step: 6 },
  ];




  const visibleSteps = steps.filter((s) => s.completed || s.active || (s.index === 2 && (planningFailed || isPlannerWorking)));

  const subtasksSection = detail
    ? `
      <section class="niis-section" id="subtasks">
        <h2>Sub-tasks</h2>
        <p>Planned checkpoints and follow-up work.</p>
        ${renderTaskWorkbenchTracks({ detail, taskWorkbenchArtifacts })}
      </section>`
    : "";




  const liveHeaderCostPayload = renderTaskHeaderCostBadge(
    computeTotalTaskCost({ detail, taskWorkbenchArtifacts }),
  );

  return `
    <template data-live-header-cost>${liveHeaderCostPayload}</template>
    ${subtasksSection}
    <section class="niis-section" id="lifecycle">
      <h2>Task Lifecycle</h2>
      <p>Intake, planning, routing, execution, review, and report phases.</p>
      <div class="niis-task-lifecycle-shell" data-task-status="${escapeHtml(taskStatus)}">
        ${visibleSteps.map((s) => renderLifecyclePhase(s.index, s.title, s.body, {
          active: s.active,
          accent: s.accent,
          completed: s.completed,
          owner: s.owner,
          statusText: s.step ? buildLifecyclePhaseStatus({
            activeStep: lifecycleState.activeStep,
            executionProgress: taskCard?.execution_progress,
            latestVerdict: taskCard?.latest_verdict,
            reportLinks,
            routeEntry,
            step: s.step,
            taskCard,
            validatorEntry,
          }) : null,
        })).join("")}
      </div>
    </section>`;
}

function getTaskPromptText(detail) {
  return (detail.task_notes ?? []).find((note) => note.author_id === "cli:intake" || note.author_id === "ui:intake")?.content
    ?? (detail.task_notes ?? []).find((note) => note.author_type === "operator")?.content
    ?? null;
}

function renderTaskPrompt(detail) {
  const intakePrompt = getTaskPromptText(detail);

  if (!intakePrompt) {
    return "<p>No task prompt recorded.</p>";
  }

  return `<div class="niis-prompt-block">${escapeHtml(intakePrompt)}</div>`;
}

function renderTrackStateBadge(state) {
  return `<span class="niis-task-detail-track-badge" data-state="${escapeHtml(state)}">${escapeHtml(formatDisplayLabel(state))}</span>`;
}

function renderTaskWorkbenchTracks({
  detail,
  taskWorkbenchArtifacts = null,
}) {
  const subtasks = Array.isArray(taskWorkbenchArtifacts?.intakeArtifact?.subtasks)
    ? taskWorkbenchArtifacts.intakeArtifact.subtasks
    : [];
  if (subtasks.length === 0) {
    const status = detail.task.status;
    const [emptyTitle, emptySummary] = status === "PLANNING"
      ? ["Planner is decomposing the task", "Sub-tasks will appear here once planning finishes."]
      : status === "UNPLANNED"
        ? ["Task is unplanned", "Move the task out of UNPLANNED to trigger planner decomposition."]
        : ["Single-track execution", "Planner did not decompose this task into sub-tasks. The run executes against the full task scope."];
    return `
      <div class="niis-task-detail-track-table-wrap">
        <table class="niis-task-detail-track-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Sub-task</th>
              <th>Summary</th>
              <th>Meta</th>
            </tr>
          </thead>
          <tbody>
            <tr data-state="pending">
              <td>${renderTrackStateBadge("pending")}</td>
              <td><strong>${escapeHtml(emptyTitle)}</strong></td>
              <td>${escapeHtml(emptySummary)}</td>
              <td>${escapeHtml(formatDisplayLabel(status))}</td>
            </tr>
          </tbody>
        </table>
      </div>`;
  }

  const subtaskProgressMap = new Map(
    (taskWorkbenchArtifacts?.subtaskProgress?.subtasks ?? []).map((entry) => [entry.id, entry]),
  );

  function deriveSubtaskState(subtask) {
    const progress = subtaskProgressMap.get(subtask.id);
    if (progress?.status) {
      const normalized = String(progress.status).toUpperCase();
      if (normalized === "DONE") return "done";
      if (normalized === "FAILED" || normalized === "TIMED_OUT") return "blocked";
      if (normalized === "RUNNING" || normalized === "IN_PROGRESS") return "running";
      return "pending";
    }
    if (detail.task.status === "DONE") return "done";
    if (detail.task.status === "BLOCKED") return "blocked";
    if (detail.task.status === "IN_PROGRESS") return "running";
    return "pending";
  }

  const tracks = subtasks.length > 0
    ? subtasks.map((subtask, index) => {
      const roleBadge = subtask.role_id
        ? `<span class="niis-task-lifecycle-owner" data-accent="planning" style="margin-left: 0.5rem;">${escapeHtml(subtask.role_id)}</span>`
        : "";
      const deps = Array.isArray(subtask.depends_on) && subtask.depends_on.length > 0
        ? `<br/><span class="niis-text-muted">depends on: ${escapeHtml(subtask.depends_on.join(", "))}</span>`
        : "";
      const state = deriveSubtaskState(subtask);
      const progress = subtaskProgressMap.get(subtask.id);
      const summary = progress?.summary
        ? progress.summary
        : (state === "pending" ? "Awaiting execution." : "Current planned step from intake decomposition.");
      return {
        id: subtask.id,
        label: `${escapeHtml(subtask.title ?? `Sub-task ${index + 1}`)}${roleBadge}${deps}`,
        meta: `step ${index + 1}${subtask.role_id ? ` · role ${escapeHtml(subtask.role_id)}` : ""}`,
        state,
        summary,
      };
    })
    : [];

  return `
    <div class="niis-task-detail-track-table-wrap">
      <table class="niis-task-detail-track-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Sub-task</th>
            <th>Summary</th>
            <th>Meta</th>
          </tr>
        </thead>
        <tbody>
          ${tracks.map((track) => `
            <tr data-state="${escapeHtml(track.state)}">
              <td>${renderTrackStateBadge(track.state)}</td>
              <td><strong>${track.label}</strong></td>
              <td>${escapeHtml(track.summary)}</td>
              <td>${track.meta}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function renderTaskActivityStream(detail) {
  const activity = [...(detail.activity ?? [])].reverse();

  if (activity.length === 0) {
    return "<p>No recent activity recorded.</p>";
  }

  return `
    <div class="niis-task-detail-activity-list">
      ${activity.map((entry) => `
        <article class="niis-task-detail-activity-entry" data-kind="${escapeHtml(entry.source_kind ?? "activity")}">
          <span class="niis-task-detail-activity-dot" aria-hidden="true"></span>
          <div class="niis-task-detail-activity-copy">
            <div class="niis-task-detail-activity-meta">
              <strong>${escapeHtml(entry.title)}</strong>
              <span>${escapeHtml(formatTimestamp(entry.timestamp))}</span>
            </div>
            <p>${escapeHtml(entry.summary)}</p>
          </div>
        </article>`).join("")}
    </div>`;
}

function renderPlanningSection(detail, taskWorkbenchArtifacts) {
  const taskStatus = detail.task?.status ?? "UNPLANNED";
  const isPlanning = taskStatus === "PLANNING";
  const hasCompletedPlanning = taskStatus !== "UNPLANNED" && taskStatus !== "PLANNING";

  const intakeArtifact = taskWorkbenchArtifacts?.intakeArtifact;
  const routePreview = taskWorkbenchArtifacts?.routePreview ?? intakeArtifact?.route_preview;

  const transitionLog = detail.task?.transition_log ?? [];
  const planningExitTransition = transitionLog.find((t) =>
    t.from_status === "PLANNING" && (t.to_status === "BLOCKED" || t.to_status === "PENDING"));
  const planningFailed = Boolean(planningExitTransition?.reason?.includes("Planning failed"));
  const planningReason = planningExitTransition?.reason ?? "";

  const plannerMode = intakeArtifact?.planner_mode ?? "pending";
  const plannerRuntime = intakeArtifact?.planner_runtime ?? "unknown";
  const selectedLane = routePreview?.selected_lane?.lane_id ?? routePreview?.selected_lane?.id ?? "pending";
  const selectedAdapter = routePreview?.selected_adapter?.id ?? routePreview?.status ?? "pending";

  const statusIcon = isPlanning
    ? `<svg class="niis-planning-status-icon niis-planning-status-active" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="8"/><path d="M10 6v4"/><circle cx="10" cy="14" r="0.5" fill="currentColor"/></svg>`
    : hasCompletedPlanning && !planningFailed
      ? `<svg class="niis-planning-status-icon niis-planning-status-complete" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="8"/><path d="M7 10l2 2 4-4"/></svg>`
      : planningFailed
        ? `<svg class="niis-planning-status-icon niis-planning-status-failed" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="8"/><path d="M7 7l6 6"/><path d="M13 7l-6 6"/></svg>`
        : `<svg class="niis-planning-status-icon niis-planning-status-pending" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="8"/></svg>`;

  const statusLabel = isPlanning
    ? "Planning in progress..."
    : hasCompletedPlanning && !planningFailed
      ? "Planning completed"
      : planningFailed
        ? "Planning failed"
        : "Planning not started";

  const planningDetails = hasCompletedPlanning && intakeArtifact
    ? `
      <div class="niis-planning-details">
        <div class="niis-card-grid">
          <div class="niis-card"><span class="niis-label">Planner mode</span><span class="niis-value niis-value-small">${escapeHtml(plannerMode)}</span></div>
          <div class="niis-card"><span class="niis-label">Planner runtime</span><span class="niis-value niis-value-small">${escapeHtml(plannerRuntime)}</span></div>
          <div class="niis-card"><span class="niis-label">Route lane</span><span class="niis-value niis-value-small">${escapeHtml(selectedLane)}</span></div>
          <div class="niis-card"><span class="niis-label">Adapter</span><span class="niis-value niis-value-small">${escapeHtml(selectedAdapter)}</span></div>
        </div>
        ${intakeArtifact.reference_bundle?.target_paths?.length > 0
          ? `<p><strong>Target paths:</strong> ${escapeHtml(formatMaybeList(intakeArtifact.reference_bundle.target_paths))}</p>`
          : ""}
        ${intakeArtifact.acceptance_checks?.length > 0
          ? `<p><strong>Acceptance checks:</strong> ${escapeHtml(formatMaybeList(intakeArtifact.acceptance_checks))}</p>`
          : ""}
      </div>`
    : isPlanning
      ? `<p class="niis-planning-progress">The planner is decomposing the task into structured artifacts...</p>`
      : planningFailed
        ? `<div class="niis-planning-failure">
            <p><strong>Planning failed.</strong> ${escapeHtml(planningReason)}</p>
            <p>Check the blocker details and retry planning when the issue is resolved.</p>
          </div>`
        : `<p class="niis-planning-idle">Planning will begin when the task transitions from UNPLANNED status.</p>`;

  return `
    <div class="niis-planning-header">
      ${statusIcon}
      <span class="niis-planning-status-label">${escapeHtml(statusLabel)}</span>
    </div>
    ${planningDetails}`;
}

function renderTaskConversation(detail, mutableState) {
  const notes = (detail.task_notes ?? []).filter((note) => note.author_id !== "cli:intake" && note.author_id !== "ui:intake");

  return `
    <div class="niis-task-detail-section-head">
      <h2>Comments</h2>
      <span>Operator notes and follow-up questions.</span>
    </div>
    <div class="niis-task-comment-thread">
      ${notes.map((note) => `
        <article class="niis-task-comment-card">
          <div class="niis-task-comment-avatar">${escapeHtml((note.author_id ?? "op").slice(0, 2).toUpperCase())}</div>
          <div class="niis-task-comment-copy">
            <div class="niis-task-comment-meta">
              <strong>${escapeHtml(note.author_id)}</strong>
              <span>${escapeHtml(formatTimestamp(note.created_at))}</span>
            </div>
            <p>${escapeHtml(note.content)}</p>
          </div>
        </article>`).join("")}
      <form class="niis-task-comment-form" method="post" action="/tasks/${encodeURIComponent(detail.task.id)}/notes">
        <textarea name="content" rows="3" placeholder="Leave a comment..." ${mutableState ? "required" : "disabled"}></textarea>
        <div class="niis-task-comment-actions">
          <button type="submit" ${mutableState ? "" : "disabled"}>↑</button>
        </div>
      </form>
    </div>`;
}

function renderTaskApprovals(taskApprovals) {
  if (taskApprovals.length === 0) {
    return "<p>No approval records stored for this task.</p>";
  }

  return `
    <ul class="niis-item-list">
      ${taskApprovals.map((approval) => `
        <li>
          <strong>${escapeHtml(approval.status)}</strong>
          <div>Requested action: ${escapeHtml(approval.action_id)}</div>
          <div>Risk: ${escapeHtml(approval.risk_level)} / ${escapeHtml(approval.requested_by)} -> ${escapeHtml(approval.owner_role)}</div>
          <div>${escapeHtml(approval.reason)}</div>
          <div>Recorded: ${escapeHtml(formatTimestamp(approval.created_at))}${approval.approved_at ? ` / Approved: ${escapeHtml(formatTimestamp(approval.approved_at))}` : ""}</div>
          ${approval.notes.length > 0 ? `<div>Notes: ${escapeHtml(approval.notes.join(" | "))}</div>` : ""}
        </li>`).join("")}
    </ul>`;
}

function renderTaskAssignments(detail) {
  if (detail.assignments.length === 0) {
    return "<p>No assignments recorded.</p>";
  }

  return `
    <ul class="niis-item-list">
      ${detail.assignments.map((assignment) => `
        <li>
          <strong>${escapeHtml(assignment.agent_id)}</strong>
          <div>${escapeHtml(assignment.reason_type)} via ${escapeHtml(assignment.policy_ref)}</div>
          <div>${escapeHtml(assignment.context)}</div>
        </li>`).join("")}
    </ul>`;
}




const LIFECYCLE_MINI_STAGES = [
  { id: "UNPLANNED", label: "Created" },
  { id: "PLANNING", label: "Planning" },
  { id: "PENDING", label: "Queued" },
  { id: "IN_PROGRESS", label: "Running" },
  { id: "IN_REVIEW", label: "Reviewing" },
  { id: "DONE", label: "Done" },
];

const LIFECYCLE_MINI_RUNNER_SVG = `<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="M504.4 111.4l-1.3-1.3c-11.8-11.8-31-11.8-42.8 0l-46.1 46.6c-2.4 2.4-6.3 2.5-8.8.2l-64.6-59.7c-6.3-5.8-14.4-9-23-9h-96.1c-2.3 0-4.4.9-6.1 2.4l-81.5 77.4c-11.9 11.9-12.8 31.2-1.8 42.9 5.8 6.3 13.7 9.7 22.2 9.7h.2c8.4 0 16.5-3.6 22.1-9.7l57.5-60.9h20.6L120.6 300.2H37.8c-19.6 0-35.8 14.7-36.8 33.4-.5 9.8 2.9 19.1 9.6 26.2 6.6 7 16 11 25.6 11h123.6c2.4 0 4.8-1 6.4-2.8l63.3-67.6 53.3 55.7-16.1 102.7c-4.1 17 4.1 34.4 19.4 41.2 4.7 2.1 9.7 3.2 14.7 3.2 5.4 0 10.7-1.2 15.6-3.7 9.5-4.7 16.3-13.3 18.8-24l27.5-147.3c.5-2.9-.4-5.8-2.4-7.9l-73.3-73.2 58.2-58.1 40.6 40.6c11.3 11.3 31.1 11.3 42.4 0l76.2-76.1c5.6-5.6 8.7-13.1 8.7-21.1s-3.1-15.4-8.7-21zm-97.4 3.4c29.2 0 53-23.8 53-53s-23.8-53-53-53-53 23.8-53 53 23.8 53 53 53z"/></svg>`;

const LIFECYCLE_MINI_CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>`;

const LIFECYCLE_MINI_DOT_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="3"/></svg>`;

function renderTaskLifecycleMini(taskStatus) {
  const status = String(taskStatus || "").toUpperCase();
  const isFailed = status === "REJECTED";
  const isBlocked = status === "BLOCKED";
  const order = LIFECYCLE_MINI_STAGES.map((s) => s.id);
  let activeIdx;
  if (isFailed) {
    activeIdx = order.indexOf("IN_REVIEW");
  } else if (isBlocked) {
    activeIdx = -1;
  } else {
    activeIdx = order.indexOf(status);
  }
  const items = LIFECYCLE_MINI_STAGES.map((stage, i) => {
    let stateClass;
    let icon;
    if (activeIdx === -1) {
      stateClass = "upcoming";
      icon = LIFECYCLE_MINI_DOT_SVG;
    } else if (i < activeIdx) {
      stateClass = "passed";
      icon = LIFECYCLE_MINI_CHECK_SVG;
    } else if (i === activeIdx) {
      stateClass = isFailed ? "failed" : "active";
      icon = LIFECYCLE_MINI_DOT_SVG;
    } else {
      stateClass = "upcoming";
      icon = LIFECYCLE_MINI_DOT_SVG;
    }



    const adornment = i === activeIdx && stage.id === "IN_PROGRESS" && !isFailed
      ? `<span class="niis-lifecycle-mini-runner" aria-hidden="true">${LIFECYCLE_MINI_RUNNER_SVG}</span>`
      : "";
    return `
      <li class="niis-lifecycle-mini-item niis-lifecycle-mini-${stateClass}" data-stage="${escapeHtml(stage.id)}">
        <span class="niis-lifecycle-mini-icon">${icon}</span>
        <span class="niis-lifecycle-mini-label">${escapeHtml(stage.label)}</span>
        ${adornment}
      </li>`;
  }).join("");
  const banner = isBlocked
    ? `<div class="niis-lifecycle-mini-banner niis-lifecycle-mini-banner-blocked">Blocked</div>`
    : isFailed
      ? `<div class="niis-lifecycle-mini-banner niis-lifecycle-mini-banner-failed">Rejected</div>`
      : "";
  return `
    <nav class="niis-toc-card niis-lifecycle-mini" aria-label="Task lifecycle" data-lifecycle-mini data-current-status="${escapeHtml(status)}">
      <h4>Task lifecycle</h4>
      <ul>${items}</ul>
      ${banner}
    </nav>`;
}

function renderTaskRuns(detail) {
  if (detail.runs.length === 0) {
    return "<p>No runs recorded.</p>";
  }

  return `
    <ul class="niis-item-list">
      ${detail.runs.map((run) => `
        <li>
          <a href="#lifecycle">${escapeHtml(run.id)}</a>
          <div>${escapeHtml(run.status)} via ${escapeHtml(run.adapter_id)} / ${escapeHtml(run.agent_id)}</div>
          <div>Finished: ${escapeHtml(formatTimestamp(run.finished_at))}</div>
        </li>`).join("")}
    </ul>`;
}

function renderReportLinks(taskWorkbenchArtifacts) {
  if (!taskWorkbenchArtifacts?.report_json_url && !taskWorkbenchArtifacts?.report_markdown_url) {
    return "<p>No report artifacts available yet.</p>";
  }

  return `
    <ul class="niis-item-list">
      ${taskWorkbenchArtifacts.report_json_url ? `<li><a href="${escapeHtml(taskWorkbenchArtifacts.report_json_url)}">Report JSON</a></li>` : ""}
      ${taskWorkbenchArtifacts.report_markdown_url ? `<li><a href="${escapeHtml(taskWorkbenchArtifacts.report_markdown_url)}">Report Markdown</a></li>` : ""}
    </ul>`;
}

function renderTaskBlockers(detail) {
  if (detail.blockers.length === 0) {
    return "<p>No active blockers.</p>";
  }

  return `
    <ul class="niis-item-list">
      ${detail.blockers.map((blocker) => `
        <li>
          <strong>${escapeHtml(blocker.blocker_class)}</strong>
          <div>${escapeHtml(blocker.reason)}</div>
          <div>Next: ${escapeHtml(blocker.next_action)}</div>
        </li>`).join("")}
    </ul>`;
}

function renderTaskStatusIcon(status) {
  const icons = {
    UNPLANNED: `<svg class="niis-task-status-icon" data-status="unplanned" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2.26946V6.4C14 6.96005 14 7.24008 14.109 7.45399C14.2049 7.64215 14.3578 7.79513 14.546 7.89101C14.7599 8 15.0399 8 15.6 8H19.7305M20 9.98822V17.2C20 18.8802 20 19.7202 19.673 20.362C19.3854 20.9265 18.9265 21.3854 18.362 21.673C17.7202 22 16.8802 22 15.2 22H8.8C7.11984 22 6.27976 22 5.63803 21.673C5.07354 21.3854 4.6146 20.9265 4.32698 20.362C4 19.7202 4 18.8802 4 17.2V6.8C4 5.11984 4 4.27976 4.32698 3.63803C4.6146 3.07354 5.07354 2.6146 5.63803 2.32698C6.27976 2 7.11984 2 8.8 2H12.0118C12.7455 2 13.1124 2 13.4577 2.08289C13.7638 2.15638 14.0564 2.27759 14.3249 2.44208C14.6276 2.6276 14.887 2.88703 15.4059 3.40589L18.5941 6.59411C19.113 7.11297 19.3724 7.3724 19.5579 7.67515C19.7224 7.94356 19.8436 8.2362 19.9171 8.5423C20 8.88757 20 9.25445 20 9.98822Z"/></svg>`,
    PLANNING: `<svg class="niis-task-status-icon" data-status="planning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 18L19.9999 19.094C19.4695 19.6741 18.7502 20 18.0002 20C17.2501 20 16.5308 19.6741 16.0004 19.094C15.4693 18.5151 14.75 18.1901 14.0002 18.1901C13.2504 18.1901 12.5312 18.5151 12 19.094M3.00003 20H4.67457C5.16376 20 5.40835 20 5.63852 19.9447C5.84259 19.8957 6.03768 19.8149 6.21663 19.7053C6.41846 19.5816 6.59141 19.4086 6.93732 19.0627L19.5001 6.49998C20.3285 5.67156 20.3285 4.32841 19.5001 3.49998C18.6716 2.67156 17.3285 2.67156 16.5001 3.49998L3.93729 16.0627C3.59139 16.4086 3.41843 16.5816 3.29475 16.7834C3.18509 16.9624 3.10428 17.1574 3.05529 17.3615C3.00003 17.5917 3.00003 17.8363 3.00003 18.3255V20Z"/></svg>`,
    PENDING: `<svg class="niis-task-status-icon" data-status="pending" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/></svg>`,
    IN_PROGRESS: `<svg class="niis-task-status-icon" data-status="in-progress" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6V12L16 14M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z"/></svg>`,
    BLOCKED: `<svg class="niis-task-status-icon" data-status="blocked" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M6 6l4 4"/><path d="M10 6l-4 4"/></svg>`,
    IN_REVIEW: `<svg class="niis-task-status-icon" data-status="in-review" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5708 20C19.8328 20 20.8568 18.977 20.8568 17.714V13.143L21.9998 12L20.8568 10.857V6.286C20.8568 5.023 19.8338 4 18.5708 4M5.429 4C4.166 4 3.143 5.023 3.143 6.286V10.857L2 12L3.143 13.143V17.714C3.143 18.977 4.166 20 5.429 20M7.5 12L9.93431 14.4343C10.1323 14.6323 10.2313 14.7313 10.3455 14.7684C10.4459 14.8011 10.5541 14.8011 10.6545 14.7684C10.7687 14.7313 10.8677 14.6323 11.0657 14.4343L16.5 9"/></svg>`,
    DONE: `<svg class="niis-task-status-icon" data-status="done" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 12L10.5 15L16.5 9M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z"/></svg>`,
    REJECTED: `<svg class="niis-task-status-icon" data-status="rejected" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M5 8h6"/></svg>`,
  };
  return icons[status] || icons.UNPLANNED;
}

function renderStatusDropdown(taskId, currentStatus) {
  const statusLabels = {
    UNPLANNED: "Unplanned",
    PLANNING: "Planning",
    PENDING: "Pending",
    IN_PROGRESS: "In Progress",
    BLOCKED: "Blocked",
    IN_REVIEW: "In Review",
    DONE: "Done",
    REJECTED: "Rejected",
  };
  const actionsByStatus = {
    UNPLANNED: [{ action: "start", iconStatus: "PLANNING", label: "Start planning" }],
    PLANNING: [],
    PENDING: [
      { action: "approve", iconStatus: "PENDING", label: "Approve plan" },
      { action: "start", iconStatus: "IN_PROGRESS", label: "Start execution" },
    ],
    IN_PROGRESS: [{ action: "cancel", iconStatus: "BLOCKED", label: "Cancel" }],
    BLOCKED: [
      { action: "resolve", iconStatus: "PENDING", label: "Resolve blocker state" },
      { action: "retry", iconStatus: "IN_PROGRESS", label: "Retry" },
    ],
    IN_REVIEW: [{ action: "resolve", iconStatus: "IN_REVIEW", label: "Run fresh review" }],
    REJECTED: [{ action: "retry", iconStatus: "IN_PROGRESS", label: "Retry" }],
  };
  const actions = actionsByStatus[currentStatus] ?? [];

  if (actions.length === 0) {
    return `<span class="niis-task-status-badge" data-status="${escapeHtml(currentStatus.toLowerCase())}">${renderTaskStatusIcon(currentStatus)} ${escapeHtml(statusLabels[currentStatus] || currentStatus)}</span>`;
  }

  return `
    <div class="niis-status-dropdown" data-current-status="${escapeHtml(currentStatus)}" data-task-id="${escapeHtml(taskId)}">
      <button type="button" class="niis-status-dropdown-trigger" aria-haspopup="true" aria-expanded="false">
        ${renderTaskStatusIcon(currentStatus)}
        <span class="niis-status-dropdown-label" data-task-status-display="label" data-task-status-value="${escapeHtml(currentStatus)}">${escapeHtml(statusLabels[currentStatus] || currentStatus)}</span>
        <svg class="niis-status-dropdown-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="niis-status-dropdown-menu" role="menu">
        ${actions.map(({ action, iconStatus, label }) => `
          <button type="button" class="niis-status-dropdown-item" data-action="${escapeHtml(action)}" role="menuitem">
            ${renderTaskStatusIcon(iconStatus)}
            <span class="niis-status-dropdown-label">${escapeHtml(label)}</span>
          </button>
        `).join("")}
      </div>
    </div>`;
}

function renderTaskNewRoute({ dashboard = null, mutableState, preview = null, notice = null, error = null, renderBanner, returnTo = "", workerMode = "semi" }) {
  const draftTask = preview?.artifact?.derived_task ?? null;
  const dashboardTasks = Array.isArray(dashboard?.task_board)
    ? dashboard.task_board.flatMap((group) => group.entries)
    : [];
  const sidebarSections = buildNiisSidebarTree({
    approvalCount: 0,
    approvalEntries: [],
    currentRoute: "task-new",
    currentTaskId: null,
    tasks: dashboardTasks,
  });

  const toc = [
    { href: "#create", label: "Create task" },
  ];

  const actionsCard = `
    <div class="niis-toc-card niis-toc-card-secondary">
      <h4>Actions</h4>
      <div class="niis-toc-actions">
        <button type="submit" name="intent" value="create" ${mutableState ? "" : "disabled"}>Create task</button>
      </div>
    </div>`;

  return `
    <form method="post" action="/tasks/new">
      ${renderNiisLayout({
        header: renderNiisTopbar({ currentRoute: "task-new", returnTo, workerMode }),
        leftSidebar: renderNiisSidebar({ sections: sidebarSections, renderStatusIcon: renderTaskStatusIcon }),
        main: `
          <article class="niis-article niis-article-wide">
            ${renderBanner({ notice, error })}
            <header class="niis-page-header">
              <h1>Create task</h1>
              <p>Create a new task with a title and description.</p>
            </header>
            <section id="create" class="niis-section">
              <h2>Task details</h2>
              <div class="niis-form-stack">
                <label class="niis-form-field">
                  <span>Title</span>
                  <input name="title" type="text" placeholder="Task title" value="${escapeHtml(draftTask?.title ?? "")}" required ${mutableState ? "" : "disabled"} />
                </label>
                <label class="niis-form-field">
                  <span>Description</span>
                  <textarea name="prompt" rows="8" placeholder="Describe what needs to be done..." required ${mutableState ? "" : "disabled"}>${escapeHtml(preview?.artifact?.operator_prompt ?? "")}</textarea>
                </label>
                <div class="niis-field-row">
                  <label class="niis-form-field">
                    <span>Planner runtime</span>
                    <select name="planner_runtime" ${mutableState ? "" : "disabled"}>
                      <option value="">auto (first available)</option>
                      <option value="codex">codex</option>
                      <option value="claude">claude</option>
                    </select>
                  </label>
                  <label class="niis-form-field">
                    <span>Executor runtime</span>
                    <select name="executor_runtime" ${mutableState ? "" : "disabled"}>
                      <option value="">auto (first available)</option>
                      <option value="codex">codex</option>
                      <option value="claude">claude</option>
                    </select>
                  </label>
                </div>
              </div>
              <div class="niis-button-row" style="margin-top: 1.5rem;">
                <button type="submit" name="intent" value="create" ${mutableState ? "" : "disabled"}>Create task</button>
              </div>
            </section>
          </article>`,
        rightSidebar: renderNiisToc(toc, { extra: actionsCard }),
      })}
    </form>`;
}

function computeTotalTaskCost({ detail, taskWorkbenchArtifacts }) {
  let totalUsd = 0;
  let totalDurationMs = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalTokensCached = 0;
  let contributors = 0;
  const accumulate = (cost) => {
    if (!cost || typeof cost !== "object") return;
    totalUsd += Number(cost.estimated_usd ?? 0);
    totalDurationMs += Number(cost.duration_ms ?? 0);
    totalTokensIn += Number(cost.tokens_in ?? cost.input_tokens ?? 0);
    totalTokensOut += Number(cost.tokens_out ?? cost.output_tokens ?? 0);
    totalTokensCached += Number(cost.tokens_cached ?? cost.cached_input_tokens ?? 0);
    contributors += 1;
  };
  accumulate(taskWorkbenchArtifacts?.intakeArtifact?.planner_cost);
  for (const run of detail?.runs ?? []) accumulate(run.cost);
  if (contributors === 0) return null;
  return {
    duration_ms: totalDurationMs,
    estimated_usd: totalUsd,
    tokens_cached: totalTokensCached,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
  };
}

function renderTaskHeaderCostBadge(totalCost) {
  if (!totalCost || Number(totalCost.estimated_usd) === 0) return "";
  const usd = formatUsd(Number(totalCost.estimated_usd));
  const duration = Number(totalCost.duration_ms) > 0 ? formatDurationHuman(Number(totalCost.duration_ms)) : null;
  const tokens = Number(totalCost.tokens_in) + Number(totalCost.tokens_out) + Number(totalCost.tokens_cached);
  const tokenLabel = tokens > 0 ? formatTokenNumber(tokens) : null;
  const subtitle = [duration, tokenLabel ? `${tokenLabel} tok` : null].filter(Boolean).join(" · ");
  return `<span class="niis-task-status-badge" data-kind="total-cost" title="Task-wide spend: planner + all runs${subtitle ? ` — ${escapeHtml(subtitle)}` : ""}">Σ $${escapeHtml(usd)}${subtitle ? ` <span class="niis-text-muted" style="font-weight: normal;">${escapeHtml(subtitle)}</span>` : ""}</span>`;
}

function renderTaskDetailRoute({
  detail,
  mutableState,
  taskCard = null,
  taskList = [],
  taskWorkbenchArtifacts = null,
  notice = null,
  error = null,
  route = {},
  renderBanner,
  returnTo = "",
  workerMode = "semi",
}) {
  if (!detail?.task) {
    return `
      <section class="niis-panel">
        <h2>Task Workbench</h2>
        <p>Task not found.</p>
      </section>`;
  }

  const editMode = route.mode === "edit";
  const startDisabled = !mutableState;
  const promptText = getTaskPromptText(detail);
  const activeRun = detail.runs.find((run) => run.finished_at === null) ?? detail.runs[0] ?? null;
  const activeSession = taskCard?.run_sessions?.find((session) => !session.finished_at) ?? taskCard?.run_sessions?.[0] ?? null;
  const latestAssignment = detail.assignments[0] ?? null;
  const pendingApprovalCount = (detail.approvals ?? []).filter((approval) => approval.status === "PENDING").length;
  const contentPanels = editMode
    ? `
      <section class="niis-section">
        <div class="niis-task-detail-section-head">
          <h3>Task Properties</h3>
          <span>Update the canonical task metadata together with markdown content.</span>
        </div>
        <div class="niis-field-row">
          <label>
            <span>Title</span>
            <input name="title" type="text" value="${escapeHtml(detail.task.title)}" ${mutableState ? "" : "disabled"} />
          </label>
          <label>
            <span>Priority</span>
            <select name="priority" ${mutableState ? "" : "disabled"}>
              <option value="low"${detail.task.priority === "low" ? " selected" : ""}>low</option>
              <option value="medium"${detail.task.priority === "medium" ? " selected" : ""}>medium</option>
              <option value="high"${detail.task.priority === "high" ? " selected" : ""}>high</option>
              <option value="critical"${detail.task.priority === "critical" ? " selected" : ""}>critical</option>
              <option value="blocker"${detail.task.priority === "blocker" ? " selected" : ""}>blocker</option>
            </select>
          </label>
          <label>
            <span>Task phase</span>
            <input name="phase" type="number" min="0" value="${escapeHtml(detail.task.phase)}" ${mutableState ? "" : "disabled"} />
          </label>
        </div>
      </section>
      ${renderMarkdownEditorField({
        hint: "Brief for operators and future agents.",
        label: "Brief",
        name: "operator_brief_markdown",
        placeholder: "Capture the task brief in markdown.",
        value: detail.task.operator_brief_markdown ?? "",
      })}
      ${renderMarkdownEditorField({
        hint: "Long-form task details and scoped implementation notes.",
        label: "Task Details",
        name: "details_markdown",
        placeholder: "Document context, guidance, and out-of-scope decisions.",
        value: detail.task.details_markdown ?? "",
      })}
      ${renderMarkdownEditorField({
        hint: "Expanded acceptance criteria rendered from markdown.",
        label: "Acceptance Criteria",
        name: "acceptance_markdown",
        placeholder: "Write detailed acceptance criteria in markdown.",
        value: detail.task.acceptance_markdown ?? "",
      })}
      <section class="niis-section">
        <div class="niis-button-row">
          <button type="submit" ${mutableState ? "" : "disabled"}>Save</button>
          <a class="niis-task-detail-secondary-action" href="/tasks/${encodeURIComponent(detail.task.id)}">Cancel</a>
        </div>
      </section>`
    : `
      <section class="niis-section" id="overview">
        <h2>Overview</h2>
        <p>Primary brief and scoped implementation context.</p>
        ${promptText ? `<div class="niis-task-detail-inline-brief">${renderTaskPrompt(detail)}</div>` : ""}
        ${renderTaskMarkdown(detail.task.details_markdown, "No markdown task details recorded.")}
      </section>
      <section class="niis-section" id="acceptance">
        <h2>Acceptance criteria</h2>
        <p>Explicit completion and review surface.</p>
        ${renderTaskMarkdown(detail.task.acceptance_markdown, "No markdown acceptance criteria recorded.")}
      </section>
      <div id="task-live-card-root" data-task-live-card-root="true" data-task-id="${escapeHtml(detail.task.id)}">
        ${buildTaskLiveCardFragment({ taskCard, detail, taskWorkbenchArtifacts })}
      </div>
      <section class="niis-section" id="included">
        <h2>Artifacts and State</h2>
        <p>Artifacts, runtime records, governance state, and current summary.</p>
        <div class="niis-callout-grid">
          <article class="niis-callout-card">
            <h3>Reports</h3>
            ${renderReportLinks(taskWorkbenchArtifacts)}
          </article>
          <article class="niis-callout-card">
            <h3>Runs</h3>
            ${renderTaskRuns(detail)}
          </article>
          <article class="niis-callout-card">
            <h3>Assignments</h3>
            ${renderTaskAssignments(detail)}
          </article>
          <article class="niis-callout-card">
            <h3>Approvals / Blockers</h3>
            ${detail.approvals?.length ? renderTaskApprovals(detail.approvals ?? []) : renderTaskBlockers(detail)}
          </article>
        </div>
      </section>
      <section class="niis-section" id="activity">
        <h2>Task History</h2>
        <p>${escapeHtml(detail.activity.length)} recorded events.</p>
        ${renderTaskActivityStream(detail)}
      </section>
      <section class="niis-section" id="comments">
        ${renderTaskConversation(detail, mutableState)}
      </section>`;
  const sidebarSections = buildNiisSidebarTree({
    approvalCount: 0,
    approvalEntries: [],
    currentRoute: "task-detail",
    currentTaskId: detail.task.id,
    tasks: taskList,
  });
  const toc = editMode
    ? [
      { href: "#brief", label: "Edit task" },
      { href: "#details", label: "Task details" },
      { href: "#acceptance", label: "Acceptance criteria" },
    ]
    : [
      { href: "#overview", label: "Overview" },
      { href: "#acceptance", label: "Acceptance criteria" },
      { href: "#subtasks", label: "Sub-tasks" },
      { href: "#lifecycle", label: "Task Lifecycle" },
      { href: "#included", label: "Artifacts and State" },
      { href: "#activity", label: "Task History" },
      { href: "#comments", label: "Comments" },
    ];

  const headerActions = `
    <div class="niis-page-header-actions">
      ${editMode ? "" : `<a class="niis-task-detail-secondary-action" href="/tasks/${encodeURIComponent(detail.task.id)}?mode=edit">Edit content</a>`}
      ${detail.task.status === "UNPLANNED" ? `
      <form method="post" action="/tasks/${encodeURIComponent(detail.task.id)}/actions/start">
        <button type="submit" ${startDisabled ? "disabled" : ""}>Start planning</button>
      </form>` : ""}
      ${detail.task.status === "PENDING" ? `
      <form method="post" action="/tasks/${encodeURIComponent(detail.task.id)}/actions/approve">
        <button type="submit" ${startDisabled ? "disabled" : ""}>Approve plan</button>
      </form>
      <form method="post" action="/tasks/${encodeURIComponent(detail.task.id)}/actions/start">
        <button type="submit" ${startDisabled ? "disabled" : ""}>Start execution</button>
      </form>` : ""}
      ${["BLOCKED", "REJECTED"].includes(detail.task.status) ? `
      <form method="post" action="/tasks/${encodeURIComponent(detail.task.id)}/actions/retry">
        <button type="submit" ${startDisabled ? "disabled" : ""}>Retry task</button>
      </form>` : ""}
      ${["PLANNING", "IN_PROGRESS"].includes(detail.task.status) ? `
      <form method="post" action="/tasks/${encodeURIComponent(detail.task.id)}/actions/cancel" data-niis-confirm="Stop this task? Sends SIGTERM to the running child, then SIGKILL after 10s grace. Worktrees and intake artifacts are preserved.">
        <button type="submit" class="niis-btn-danger" title="Kill the supervised child process for this task.">Stop</button>
      </form>` : ""}
    </div>`;

  return renderNiisLayout({
    header: renderNiisTopbar({ currentRoute: "task-detail", returnTo, workerMode }),
    leftSidebar: renderNiisSidebar({ sections: sidebarSections, renderStatusIcon: renderTaskStatusIcon }),
    main: `
      <article class="niis-article">
        ${renderBanner({ notice, error })}
        <header class="niis-page-header niis-page-header-task">
          <div class="niis-page-header-title-row">
            <h1>${escapeHtml(detail.task.title)}</h1>
            ${mutableState ? renderStatusDropdown(detail.task.id, detail.task.status) : `<span class="niis-task-status-badge" data-status="${escapeHtml(detail.task.status.toLowerCase())}">${escapeHtml(detail.task.status)}</span>`}
            ${taskWorkbenchArtifacts?.queueEntry?.state ? `<span class="niis-task-status-badge" data-queue-state="${escapeHtml(taskWorkbenchArtifacts.queueEntry.state)}" title="Queue state (.niis/queue/${escapeHtml(taskWorkbenchArtifacts.queueEntry.state.replace("_", "-"))})">queue: ${escapeHtml(taskWorkbenchArtifacts.queueEntry.state.replace("_", "-"))}</span>` : ""}
            <span data-task-header-cost-slot>${renderTaskHeaderCostBadge(computeTotalTaskCost({ detail, taskWorkbenchArtifacts }))}</span>
          </div>
          <p>${escapeHtml(promptText ?? detail.task.operator_brief_markdown ?? "Canonical task workbench with routing, runtime, approval, and evidence signals.")}</p>
          ${headerActions}
        </header>
        ${editMode ? `<form class="niis-stack-form" method="post" action="/tasks/${encodeURIComponent(detail.task.id)}/edit">` : ""}
        ${contentPanels}
        ${editMode ? "</form>" : ""}
      </article>`,
    rightSidebar: renderNiisToc(toc, { lifecycle: renderTaskLifecycleMini(detail.task.status) }),
  });
}

export {
  buildTaskLiveCardFragment,
  renderReportLinks,
  renderStatusDropdown,
  renderTaskDetailRoute,
  renderTaskNewRoute,
  renderTaskStatusIcon,
};
