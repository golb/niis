import { APPROVAL_GOVERNANCE_STATES } from "../contracts/governance.js";
import { parseApprovalRecord } from "../schemas/approval.js";
import { TASK_STATUSES, parseTaskRecord } from "../schemas/task.js";
import { parseRunRecord } from "../schemas/run.js";
import { parseBlockerArtifact } from "../schemas/blocker.js";
import { buildTaskObservabilityView } from "./activity-stream.js";

class DashboardViewError extends Error {
  constructor(message) {
    super(message);
    this.name = "DashboardViewError";
  }
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DashboardViewError(`${label} must be a plain object`);
  }

  return value;
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new DashboardViewError(`${label} must be an array`);
  }

  return value;
}

function ensureLimit(value, label, defaultValue) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new DashboardViewError(`${label} must be a non-negative integer`);
  }

  return value;
}

function ensureOptionalTaskId(value, label) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new DashboardViewError(`${label} must be a non-empty string when provided`);
  }

  return value.trim();
}

function ensureOptionalStringArray(value, label) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new DashboardViewError(`${label} must be an array when provided`);
  }

  return value.map((entry, index) => ensureOptionalTaskId(entry, `${label}[${index}]`));
}

function ensureOptionalIntegerArray(value, label) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new DashboardViewError(`${label} must be an array when provided`);
  }

  return value.map((entry, index) => {
    if (!Number.isInteger(entry) || entry < 0) {
      throw new DashboardViewError(`${label}[${index}] must be a non-negative integer`);
    }

    return entry;
  });
}

function ensureOptionalEnumArray(value, allowedValues, label) {
  const normalized = ensureOptionalStringArray(value, label);

  return normalized.map((entry, index) => {
    if (!allowedValues.includes(entry)) {
      throw new DashboardViewError(`${label}[${index}] must be one of: ${allowedValues.join(", ")}`);
    }

    return entry;
  });
}

function toIsoTimestamp(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function normalizeFilters(filters = {}) {
  const normalizedFilters = ensurePlainObject(filters, "filters");

  return Object.freeze({
    phases: Object.freeze(ensureOptionalIntegerArray(normalizedFilters.phases, "filters.phases")),
    statuses: Object.freeze(
      ensureOptionalEnumArray(normalizedFilters.statuses, TASK_STATUSES, "filters.statuses"),
    ),
    task_ids: Object.freeze(ensureOptionalStringArray(normalizedFilters.taskIds ?? normalizedFilters.task_ids, "filters.taskIds")),
  });
}

function sortNewestFirst(leftTimestamp, rightTimestamp, leftId, rightId) {
  const timeDiff = Date.parse(rightTimestamp) - Date.parse(leftTimestamp);

  if (timeDiff !== 0) {
    return timeDiff;
  }

  return String(leftId).localeCompare(String(rightId));
}

function createPhaseBucket(phase) {
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));

  return {
    phase,
    status_counts: counts,
    total: 0,
  };
}

function buildPhaseProgress(tasks) {
  const buckets = new Map();

  for (const task of tasks) {
    const bucket = buckets.get(task.phase) ?? createPhaseBucket(task.phase);
    bucket.total += 1;
    bucket.status_counts[task.status] += 1;
    buckets.set(task.phase, bucket);
  }

  return Object.freeze(
    [...buckets.values()]
      .sort((left, right) => left.phase - right.phase)
      .map((bucket) =>
        Object.freeze({
          blocked_count: bucket.status_counts.BLOCKED,
          completion_ratio: bucket.total === 0 ? 0 : bucket.status_counts.DONE / bucket.total,
          done_count: bucket.status_counts.DONE,
          in_progress_count:
            bucket.status_counts.IN_PROGRESS + bucket.status_counts.IN_REVIEW,
          pending_count: bucket.status_counts.PENDING,
          phase: bucket.phase,
          rejected_count: bucket.status_counts.REJECTED,
          total: bucket.total,
        })),
  );
}

function buildSortedBlockerEntries(blockers, tasksById) {
  return [...blockers]
    .sort((left, right) =>
      sortNewestFirst(left.created_at, right.created_at, left.id, right.id))
    .map((blocker) =>
      Object.freeze({
        blocker_class: blocker.blocker_class,
        created_at: blocker.created_at,
        id: blocker.id,
        next_action: blocker.next_action,
        reason: blocker.reason,
        task_id: blocker.task_id,
        task_title: tasksById.get(blocker.task_id)?.title ?? blocker.task_id,
      }));
}

function buildSortedRecentRuns(runs, tasksById) {
  return [...runs]
    .sort((left, right) =>
      sortNewestFirst(
        left.finished_at ?? left.started_at,
        right.finished_at ?? right.started_at,
        left.id,
        right.id,
      ))
    .map((run) =>
      Object.freeze({
        adapter_id: run.adapter_id,
        agent_id: run.agent_id,
        estimated_usd: run.cost.estimated_usd,
        finished_at: run.finished_at,
        id: run.id,
        started_at: run.started_at,
        status: run.status,
        task_id: run.task_id,
        task_title: tasksById.get(run.task_id)?.title ?? run.task_id,
      }));
}

function pickFocusTask({
  requestedTaskId,
  tasks,
  tasksById,
  blockerEntries,
  recentRuns,
}) {
  if (requestedTaskId && tasksById.has(requestedTaskId)) {
    return Object.freeze({
      selection_reason: "requested_task",
      task_id: requestedTaskId,
    });
  }

  const blockerTaskId = blockerEntries[0]?.task_id ?? null;
  if (blockerTaskId && tasksById.has(blockerTaskId)) {
    return Object.freeze({
      selection_reason: "latest_active_blocker",
      task_id: blockerTaskId,
    });
  }

  const recentRunTaskId = recentRuns[0]?.task_id ?? null;
  if (recentRunTaskId && tasksById.has(recentRunTaskId)) {
    return Object.freeze({
      selection_reason: "latest_run",
      task_id: recentRunTaskId,
    });
  }

  const latestTask = [...tasks].sort((left, right) =>
    sortNewestFirst(left.updated_at, right.updated_at, left.id, right.id))[0] ?? null;

  if (!latestTask) {
    return null;
  }

  return Object.freeze({
    selection_reason: "latest_task_update",
    task_id: latestTask.id,
  });
}

function sortEntriesByTimestamp(entries, timestampSelector, idSelector) {
  return [...entries].sort((left, right) =>
    sortNewestFirst(
      timestampSelector(left),
      timestampSelector(right),
      idSelector(left),
      idSelector(right),
    ));
}

function buildTaskDetailForTask({
  snapshot,
  taskId,
  detailActivityLimit,
  selectionReason = null,
}) {
  const detail = buildTaskObservabilityView({
    snapshot,
    taskId,
  });

  if (!detail.task) {
    return null;
  }

  const assignments = sortEntriesByTimestamp(
    detail.assignments,
    (assignment) => assignment.assigned_at,
    (assignment) => assignment.id,
  );
  const blockers = sortEntriesByTimestamp(
    detail.blockers,
    (blocker) => blocker.created_at,
    (blocker) => blocker.id,
  );
  const decisions = sortEntriesByTimestamp(
    detail.decisions,
    (decision) => decision.timestamp,
    (decision) => decision.id,
  );
  const runs = sortEntriesByTimestamp(
    detail.runs,
    (run) => run.finished_at ?? run.started_at,
    (run) => run.id,
  );
  const activity = sortEntriesByTimestamp(
    detail.activity,
    (entry) => entry.timestamp,
    (entry) => entry.id,
  ).slice(0, detailActivityLimit);
  const taskNotes = sortEntriesByTimestamp(
    detail.task_notes ?? [],
    (note) => note.created_at,
    (note) => note.id,
  );
  const approvals = sortEntriesByTimestamp(
    detail.approvals ?? [],
    (approval) => approval.approved_at ?? approval.created_at,
    (approval) => approval.id,
  );
  const verdicts = sortEntriesByTimestamp(
    detail.verdicts ?? [],
    (verdict) => verdict.created_at,
    (verdict) => verdict.id,
  );
  const evidencePackets = Object.freeze(detail.evidence_packets ?? []);

  return Object.freeze({
    activity: Object.freeze(activity),
    approvals: Object.freeze(approvals),
    assignments: Object.freeze(assignments),
    blockers: Object.freeze(blockers),
    decisions: Object.freeze(decisions),
    evidence_packets: evidencePackets,
    focus_task_id: taskId,
    latest_approval: detail.latest_approval ?? null,
    latest_evidence_packet: detail.latest_evidence_packet ?? null,
    latest_verdict: detail.latest_verdict ?? null,
    runs: Object.freeze(runs),
    selection_reason: selectionReason,
    summary: Object.freeze({
      active_blocker_count: blockers.length,
      approval_count: approvals.length,
      assignment_count: assignments.length,
      decision_count: decisions.length,
      evidence_packet_count: evidencePackets.length,
      latest_approval_status: detail.latest_approval?.status ?? null,
      latest_verdict_class: detail.latest_verdict?.verdict_class ?? null,
      note_count: taskNotes.length,
      pending_approval_count: blockers.filter((blocker) => blocker.blocker_class === "MISSING_APPROVAL").length,
      recent_activity_count: activity.length,
      run_count: runs.length,
      verdict_count: verdicts.length,
    }),
    task: detail.task,
    task_notes: Object.freeze(taskNotes),
    verdicts: Object.freeze(verdicts),
  });
}

function buildTaskNavigation({
  tasks,
  taskDetailsById,
  selectedTaskId,
}) {
  return Object.freeze(
    [...tasks]
      .sort((left, right) =>
        sortNewestFirst(left.updated_at, right.updated_at, left.id, right.id))
      .map((task) => {
        const detail = taskDetailsById.get(task.id) ?? null;
        const latestRun = detail?.runs[0] ?? null;

        return Object.freeze({
          active_blocker_count: detail?.summary.active_blocker_count ?? 0,



          assigned_to: task.assigned_to ?? null,
          task_kind: task.task_kind ?? null,
          latest_run_adapter_id: latestRun?.adapter_id ?? null,
          latest_run_id: latestRun?.id ?? null,
          latest_run_status: latestRun?.status ?? null,
          latest_run_timestamp: latestRun?.finished_at ?? latestRun?.started_at ?? null,
          pending_approval_count: detail?.summary.pending_approval_count ?? 0,
          phase: task.phase,
          priority: task.priority,
          status: task.status,
          task_id: task.id,
          task_title: task.title,
          updated_at: task.updated_at,
          view_kind: task.id === selectedTaskId ? "selected" : "available",
        });
      }),
  );
}

function buildStatusCounts(tasks) {
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));

  for (const task of tasks) {
    counts[task.status] += 1;
  }

  return Object.freeze(counts);
}

function buildStatusGroups(taskNavigation = []) {
  return Object.freeze(
    TASK_STATUSES.map((status) => {
      const entries = taskNavigation.filter((task) => task.status === status);

      return Object.freeze({
        entries: Object.freeze(entries),
        status,
        total: entries.length,
      });
    }),
  );
}

function buildRunningWork(taskNavigation = []) {
  return Object.freeze(
    taskNavigation.filter((task) => task.status === "IN_PROGRESS" || task.status === "IN_REVIEW"),
  );
}

function buildRecentCompletedRuns(recentRuns = [], limit = 5) {
  return Object.freeze(
    recentRuns.filter((run) => run.status === "COMPLETED").slice(0, limit),
  );
}

const APPROVAL_QUEUE_GROUPS = Object.freeze([
  Object.freeze({
    label: "Awaiting Operator Decision",
    state: APPROVAL_GOVERNANCE_STATES[0],
  }),
  Object.freeze({
    label: "Deferred Pending Follow-Up",
    state: APPROVAL_GOVERNANCE_STATES[1],
  }),
  Object.freeze({
    label: "Rejected Pending Rework",
    state: APPROVAL_GOVERNANCE_STATES[2],
  }),
  Object.freeze({
    label: "Missing Approval Record",
    state: APPROVAL_GOVERNANCE_STATES[3],
  }),
]);

function pickLatestApprovalRecord(approvals = []) {
  return [...approvals].sort((left, right) =>
    sortNewestFirst(
      left.approved_at ?? left.created_at,
      right.approved_at ?? right.created_at,
      left.id,
      right.id,
    ))[0] ?? null;
}

function parseApprovalDecisionAction(routeChosen) {
  if (typeof routeChosen !== "string" || !routeChosen.startsWith("approval:")) {
    return null;
  }

  return routeChosen.slice("approval:".length);
}

function buildApprovalDecisionIndex(taskDetails = []) {
  const decisionIndex = new Map();

  for (const detail of taskDetails) {
    for (const decision of detail.decisions.filter((entry) => entry.decision_type === "APPROVAL")) {
      for (const reference of decision.evidence_refs ?? []) {
        const key = `${detail.task.id}:${reference}`;
        if (!decisionIndex.has(key)) {
          decisionIndex.set(key, decision);
        }
      }
    }
  }

  return decisionIndex;
}

function findLatestApprovalDecision(decisionIndex, taskId, references = []) {
  for (const reference of references) {
    const decision = decisionIndex.get(`${taskId}:${reference}`);
    if (decision) {
      return decision;
    }
  }

  return null;
}

function deriveApprovalQueueState({ approval, latestDecisionAction }) {
  if (!approval) {
    return APPROVAL_GOVERNANCE_STATES[3];
  }

  if (approval.status === "REJECTED" || latestDecisionAction === "rejected") {
    return APPROVAL_GOVERNANCE_STATES[2];
  }

  if (latestDecisionAction === "deferred") {
    return APPROVAL_GOVERNANCE_STATES[1];
  }

  return APPROVAL_GOVERNANCE_STATES[0];
}

function buildApprovalQueueEntry({
  approval = null,
  blocker = null,
  decisionIndex,
  taskDetail = null,
  tasksById,
}) {
  const taskId = blocker?.task_id ?? approval?.task_id ?? null;
  const task = taskId ? tasksById.get(taskId) ?? null : null;
  const latestDecision = taskId
    ? findLatestApprovalDecision(
      decisionIndex,
      taskId,
      [
        blocker?.id ?? null,
        approval?.action_id ?? null,
        approval?.id ?? null,
      ].filter(Boolean),
    )
    : null;
  const latestDecisionAction = parseApprovalDecisionAction(latestDecision?.route_chosen ?? null);
  const governanceState = deriveApprovalQueueState({
    approval,
    latestDecisionAction,
  });
  const latestRun = taskDetail?.runs[0] ?? null;
  const requestedAction = blocker?.id
    ? `Resolve approval action ${blocker.id}.`
    : approval
      ? `Resolve approval action ${approval.action_id}.`
      : "Resolve approval action.";
  const riskSummary = approval
    ? `${approval.risk_level} risk requested by ${approval.requested_by}: ${approval.reason}`
    : `${blocker?.blocker_class ?? "MISSING_APPROVAL"}: ${blocker?.reason ?? "Approval is required."}`;
  const nextAction = blocker?.next_action
    ?? (approval?.status === "REJECTED"
      ? "Revise the plan or request a new approval after addressing the rejection."
      : latestDecisionAction === "deferred"
        ? "Collect more evidence or operator context before revisiting this approval."
        : "Await operator decision.");

  return Object.freeze({
    action_id: approval?.action_id ?? blocker?.id ?? null,
    approval_id: approval?.id ?? null,
    approval_status: approval?.status ?? "PENDING",
    blocker_id: blocker?.id ?? null,
    created_at: approval?.created_at ?? blocker?.created_at ?? null,
    governance_state: governanceState,
    id: approval?.id ?? `derived:${blocker?.id ?? approval?.action_id ?? taskId ?? "approval"}`,
    latest_decision_action: latestDecisionAction,
    latest_decision_summary: latestDecision?.human_readable_summary ?? null,
    latest_run_adapter_id: latestRun?.adapter_id ?? null,
    latest_run_status: latestRun?.status ?? null,
    next_action: nextAction,
    notes: Object.freeze(approval?.notes ?? []),
    owner_role: approval?.owner_role ?? "operator",
    requested_action: requestedAction,
    requested_by: approval?.requested_by ?? "operator",
    risk_level: approval?.risk_level ?? "high",
    risk_summary: riskSummary,
    task_id: taskId,
    task_phase: task?.phase ?? null,
    task_priority: task?.priority ?? null,
    task_status: task?.status ?? null,
    task_title: task?.title ?? taskId,
  });
}

function buildApprovalQueueGroups({
  blockers,
  approvals,
  taskDetailsById,
  tasksById,
}) {
  const activeApprovalBlockers = blockers.filter((blocker) => blocker.blocker_class === "MISSING_APPROVAL");
  const approvalsByActionId = new Map();
  const decisionIndex = buildApprovalDecisionIndex([...taskDetailsById.values()]);

  for (const approval of approvals) {
    const bucket = approvalsByActionId.get(approval.action_id) ?? [];
    bucket.push(approval);
    approvalsByActionId.set(approval.action_id, bucket);
  }

  const blockerEntries = activeApprovalBlockers.map((blocker) =>
    buildApprovalQueueEntry({
      approval: pickLatestApprovalRecord(approvalsByActionId.get(blocker.id) ?? []),
      blocker,
      decisionIndex,
      taskDetail: taskDetailsById.get(blocker.task_id) ?? null,
      tasksById,
    }));
  const blockerActionIds = new Set(activeApprovalBlockers.map((blocker) => blocker.id));
  const standaloneApprovals = new Map();

  for (const approval of approvals) {
    if (approval.status === "APPROVED" || blockerActionIds.has(approval.action_id)) {
      continue;
    }

    const key = `${approval.task_id}:${approval.action_id}`;
    const current = standaloneApprovals.get(key);
    if (!current || sortNewestFirst(
      approval.approved_at ?? approval.created_at,
      current.approved_at ?? current.created_at,
      approval.id,
      current.id,
    ) < 0) {
      standaloneApprovals.set(key, approval);
    }
  }

  const standaloneEntries = [...standaloneApprovals.values()]
    .map((approval) =>
      buildApprovalQueueEntry({
        approval,
        blocker: null,
        decisionIndex,
        taskDetail: taskDetailsById.get(approval.task_id) ?? null,
        tasksById,
      }));
  const entries = Object.freeze(
    [...blockerEntries, ...standaloneEntries].sort((left, right) =>
      sortNewestFirst(left.created_at, right.created_at, left.id, right.id)),
  );

  return Object.freeze(APPROVAL_QUEUE_GROUPS.map((group) => {
    const groupEntries = entries.filter((entry) => entry.governance_state === group.state);

    return Object.freeze({
      entries: Object.freeze(groupEntries),
      label: group.label,
      state: group.state,
      total: groupEntries.length,
    });
  }));
}

function taskMatchesFilters(task, filters) {
  if (filters.statuses.length > 0 && !filters.statuses.includes(task.status)) {
    return false;
  }

  if (filters.phases.length > 0 && !filters.phases.includes(task.phase)) {
    return false;
  }

  if (filters.task_ids.length > 0 && !filters.task_ids.includes(task.id)) {
    return false;
  }

  return true;
}

function buildDashboardView({
  snapshot,
  now = new Date(),
  focusTaskId = null,
  filters = {},
  detailActivityLimit = 6,
  recentBlockerLimit = 5,
  recentRunLimit = 5,
} = {}) {
  const normalizedSnapshot = ensurePlainObject(snapshot, "snapshot");
  const normalizedFocusTaskId = ensureOptionalTaskId(focusTaskId, "focusTaskId");
  const normalizedFilters = normalizeFilters(filters);
  const normalizedDetailActivityLimit = ensureLimit(
    detailActivityLimit,
    "detailActivityLimit",
    6,
  );
  const normalizedRecentRunLimit = ensureLimit(recentRunLimit, "recentRunLimit", 5);
  const normalizedRecentBlockerLimit = ensureLimit(
    recentBlockerLimit,
    "recentBlockerLimit",
    5,
  );
  const allTasks = ensureArray(normalizedSnapshot.tasks ?? [], "snapshot.tasks").map(parseTaskRecord);
  const tasks = allTasks.filter((task) => taskMatchesFilters(task, normalizedFilters));
  const visibleTaskIds = new Set(tasks.map((task) => task.id));
  const approvals = ensureArray(normalizedSnapshot.approvals ?? [], "snapshot.approvals")
    .map(parseApprovalRecord)
    .filter((approval) => visibleTaskIds.has(approval.task_id));
  const runs = ensureArray(normalizedSnapshot.runs ?? [], "snapshot.runs")
    .map(parseRunRecord)
    .filter((run) => visibleTaskIds.has(run.task_id));
  const blockers = ensureArray(normalizedSnapshot.blockers ?? [], "snapshot.blockers")
    .map(parseBlockerArtifact)
    .filter((blocker) => blocker.resolved_at === null && visibleTaskIds.has(blocker.task_id));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const phaseProgress = buildPhaseProgress(tasks);
  const allBlockerEntries = buildSortedBlockerEntries(blockers, tasksById);
  const activeBlockers = Object.freeze(allBlockerEntries.slice(0, normalizedRecentBlockerLimit));
  const pendingApprovals = Object.freeze(
    activeBlockers.filter((blocker) => blocker.blocker_class === "MISSING_APPROVAL"),
  );
  const allRecentRuns = buildSortedRecentRuns(runs, tasksById);
  const recentRuns = Object.freeze(allRecentRuns.slice(0, normalizedRecentRunLimit));
  const selectedTask = pickFocusTask({
    blockerEntries: allBlockerEntries,
    recentRuns: allRecentRuns,
    requestedTaskId: normalizedFocusTaskId,
    tasks,
    tasksById,
  });
  const taskDetails = Object.freeze(
    tasks
      .map((task) =>
        buildTaskDetailForTask({
          detailActivityLimit: normalizedDetailActivityLimit,
          selectionReason: task.id === selectedTask?.task_id ? selectedTask.selection_reason : null,
          snapshot: normalizedSnapshot,
          taskId: task.id,
        }))
      .filter(Boolean),
  );
  const taskDetailsById = new Map(taskDetails.map((detail) => [detail.task.id, detail]));
  const approvalQueueGroups = buildApprovalQueueGroups({
    approvals,
    blockers,
    taskDetailsById,
    tasksById,
  });
  const approvalQueue = Object.freeze(approvalQueueGroups.flatMap((group) => group.entries));
  const taskDetail = selectedTask ? (taskDetailsById.get(selectedTask.task_id) ?? null) : null;
  const taskNavigation = buildTaskNavigation({
    selectedTaskId: taskDetail?.task.id ?? null,
    taskDetailsById,
    tasks,
  });
  const statusCounts = buildStatusCounts(tasks);
  const statusGroups = buildStatusGroups(taskNavigation);
  const runningWork = buildRunningWork(taskNavigation);
  const recentCompletedRuns = buildRecentCompletedRuns(allRecentRuns, normalizedRecentRunLimit);

  return Object.freeze({
    active_blockers: activeBlockers,
    approval_queue: approvalQueue,
    approval_queue_groups: approvalQueueGroups,
    generated_at: toIsoTimestamp(now),
    pending_approvals: pendingApprovals,
    phase_progress: phaseProgress,
    recent_runs: recentRuns,
    recent_completed_runs: recentCompletedRuns,
    running_work: runningWork,
    scope: Object.freeze({
      filters: normalizedFilters,
      focus_task_id: normalizedFocusTaskId,
      has_filters:
        normalizedFilters.statuses.length > 0
        || normalizedFilters.phases.length > 0
        || normalizedFilters.task_ids.length > 0,
    }),
    summary: Object.freeze({
      active_blocker_count: activeBlockers.length,
      approval_queue_count: approvalQueue.length,
      blocked_task_count: statusCounts.BLOCKED,
      done_task_count: statusCounts.DONE,
      in_progress_task_count: statusCounts.IN_PROGRESS,
      in_review_task_count: statusCounts.IN_REVIEW,
      pending_approval_count: pendingApprovals.length,
      pending_task_count: statusCounts.PENDING,
      recent_completed_run_count: recentCompletedRuns.length,
      recent_run_count: recentRuns.length,
      rejected_task_count: statusCounts.REJECTED,
      running_work_count: runningWork.length,
      total_phases: phaseProgress.length,
      total_tasks: tasks.length,
    }),
    task_board: statusGroups,
    task_detail: taskDetail,
    task_details: taskDetails,
    task_navigation: taskNavigation,
  });
}

export {
  DashboardViewError,
  buildDashboardView,
};
