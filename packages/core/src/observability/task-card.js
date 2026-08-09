import { parseApprovalRecord } from "../schemas/approval.js";
import { parseAssignmentReason } from "../schemas/assignment.js";
import { parseBlockerArtifact } from "../schemas/blocker.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { parseRunRecord } from "../schemas/run.js";
import { parseTaskLiveExcerpt } from "../schemas/task-live-excerpt.js";
import { parseTaskNote } from "../schemas/task-note.js";
import { parseTaskRecord } from "../schemas/task.js";
import { parseTaskRunEvent } from "../schemas/task-run-event.js";
import { parseTaskRunSession } from "../schemas/task-run-session.js";
import { parseReviewVerdict } from "../schemas/verdict.js";
import { buildTaskObservabilityView } from "./activity-stream.js";

class TaskCardViewError extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskCardViewError";
  }
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskCardViewError(`${label} must be a plain object`);
  }

  return value;
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TaskCardViewError(`${label} must be an array`);
  }

  return value;
}

function sortNewestFirst(leftTimestamp, rightTimestamp, leftId, rightId) {
  const timeDiff = Date.parse(rightTimestamp) - Date.parse(leftTimestamp);

  if (timeDiff !== 0) {
    return timeDiff;
  }

  return String(leftId).localeCompare(String(rightId));
}

function buildTaskCardVersion({
  artifacts,
  task,
  liveEvents,
  liveExcerpts,
  runSessions,
  latestVerdict,
  pendingApprovals,
  taskContentRevisions,
}) {





  const subtaskEntries = Array.isArray(artifacts.subtaskProgress?.subtasks)
    ? artifacts.subtaskProgress.subtasks
    : [];
  const subtaskLastUpdatedAt = subtaskEntries.reduce((acc, entry) => {
    const ts = entry?.updated_at ?? entry?.finished_at ?? entry?.started_at ?? null;
    if (typeof ts === "string" && (acc === null || ts > acc)) return ts;
    return acc;
  }, null);
  const subtaskStatuses = subtaskEntries
    .map((entry) => `${entry?.id ?? "?"}:${entry?.status ?? "?"}:${entry?.branch?.merge_status ?? "-"}`)
    .join(",");

  const parts = [
    task?.updated_at ?? "no-task",
    runSessions[0]?.updated_at ?? "no-session",
    liveEvents.at(-1)?.ts ?? "no-event",
    liveExcerpts.at(-1)?.ts ?? "no-excerpt",
    latestVerdict?.created_at ?? "no-verdict",
    pendingApprovals[0]?.created_at ?? "no-approval",
    artifacts.executionProgress?.updated_at ?? "no-progress",
    artifacts.executionLogTail ?? "no-log-tail",
    taskContentRevisions[0]?.created_at ?? "no-content-revision",
    subtaskLastUpdatedAt ?? "no-subtask-progress",
    subtaskStatuses || "no-subtask-statuses",
    String(liveEvents.length),
    String(liveExcerpts.length),
    String(subtaskEntries.length),
  ];

  return parts.join("|");
}

function normalizeArtifacts(taskWorkbenchArtifacts = null) {
  if (!taskWorkbenchArtifacts || typeof taskWorkbenchArtifacts !== "object" || Array.isArray(taskWorkbenchArtifacts)) {
    return Object.freeze({
      executionLogPath: null,
      executionLogTail: null,
      executionProgress: null,
      report_json_url: null,
      report_markdown_url: null,
      subtaskProgress: null,
      taskRoot: null,
    });
  }

  return Object.freeze({
    executionLogPath: taskWorkbenchArtifacts.executionLogPath ?? null,
    executionLogTail: taskWorkbenchArtifacts.executionLogTail ?? null,
    executionProgress: taskWorkbenchArtifacts.executionProgress ?? null,
    report_json_url: taskWorkbenchArtifacts.report_json_url ?? null,
    report_markdown_url: taskWorkbenchArtifacts.report_markdown_url ?? null,
    subtaskProgress: taskWorkbenchArtifacts.subtaskProgress ?? null,
    taskRoot: taskWorkbenchArtifacts.taskRoot ?? null,
  });
}

function createCompatibilityTimelineFromProgress(taskId, progress = null) {
  if (!progress || typeof progress !== "object") {
    return [];
  }

  return [
    Object.freeze({
      id: `${taskId}:compat-progress:${progress.updated_at ?? "unknown"}`,
      task_id: taskId,
      run_id: progress.run_id ?? null,
      ts: progress.updated_at ?? new Date(0).toISOString(),
      event_type: progress.active ? "agent_status" : "run_completed",
      level: progress.verdict_class === "ENV_BLOCK" ? "error" : "info",
      actor_type: "runtime",
      actor_id: progress.adapter_id ?? "runtime",
      visibility: "curated",
      payload: {
        adapter_id: progress.adapter_id ?? null,
        stage: progress.stage ?? "unknown",
        summary: progress.summary ?? null,
        task_status: progress.task_status ?? null,
        verdict_class: progress.verdict_class ?? null,
      },
    }),
  ];
}

function createCompatibilityExcerptFromProgress(taskId, artifacts) {
  if (!artifacts.executionLogTail) {
    return [];
  }

  const updatedAt = artifacts.executionProgress?.updated_at ?? new Date(0).toISOString();

  return [
    Object.freeze({
      id: `${taskId}:compat-excerpt:${updatedAt}`,
      task_id: taskId,
      run_id: artifacts.executionProgress?.run_id ?? null,
      ts: updatedAt,
      channel: "stdout",
      level: "info",
      source: "execution-progress-log",
      content: artifacts.executionLogTail,
      metadata: {
        compatibility_mode: true,
      },
    }),
  ];
}

function buildTaskCardView({
  connectionState = "ready",
  snapshot,
  taskId,
  taskWorkbenchArtifacts = null,
}) {
  const normalizedSnapshot = ensurePlainObject(snapshot, "snapshot");
  const normalizedTaskId = typeof taskId === "string" && taskId.trim() !== "" ? taskId.trim() : null;

  if (!normalizedTaskId) {
    throw new TaskCardViewError("taskId must be a non-empty string");
  }

  const detail = buildTaskObservabilityView({
    snapshot: normalizedSnapshot,
    taskId: normalizedTaskId,
  });

  const task = detail?.task ? parseTaskRecord(detail.task) : null;
  if (!task) {
    return null;
  }

  const artifacts = normalizeArtifacts(taskWorkbenchArtifacts);
  const runSessions = ensureArray(normalizedSnapshot.taskRunSessions ?? [], "snapshot.taskRunSessions")
    .map(parseTaskRunSession)
    .filter((session) => session.task_id === normalizedTaskId)
    .sort((left, right) => sortNewestFirst(left.updated_at, right.updated_at, left.id, right.id));
  const liveEvents = ensureArray(normalizedSnapshot.taskRunEvents ?? [], "snapshot.taskRunEvents")
    .map(parseTaskRunEvent)
    .filter((event) => event.task_id === normalizedTaskId)
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id));
  const liveExcerpts = ensureArray(normalizedSnapshot.taskLiveExcerpts ?? [], "snapshot.taskLiveExcerpts")
    .map(parseTaskLiveExcerpt)
    .filter((excerpt) => excerpt.task_id === normalizedTaskId)
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id));
  const assignments = ensureArray(detail.assignments ?? [], "detail.assignments")
    .map(parseAssignmentReason)
    .sort((left, right) => sortNewestFirst(left.assigned_at, right.assigned_at, left.id, right.id));
  const approvals = ensureArray(detail.approvals ?? [], "detail.approvals").map(parseApprovalRecord);
  const blockers = ensureArray(detail.blockers ?? [], "detail.blockers").map(parseBlockerArtifact);
  const decisions = ensureArray(detail.decisions ?? [], "detail.decisions")
    .map(parseExplainabilityRecord)
    .sort((left, right) => sortNewestFirst(left.timestamp, right.timestamp, left.id, right.id));
  const taskNotes = ensureArray(detail.task_notes ?? [], "detail.task_notes")
    .map(parseTaskNote)
    .sort((left, right) => sortNewestFirst(left.created_at, right.created_at, left.id, right.id));
  const verdicts = ensureArray(detail.verdicts ?? [], "detail.verdicts")
    .map(parseReviewVerdict)
    .sort((left, right) => sortNewestFirst(left.created_at, right.created_at, left.id, right.id));
  const taskContentRevisions = ensureArray(detail.task_content_revisions ?? [], "detail.task_content_revisions")
    .sort((left, right) => sortNewestFirst(left.created_at, right.created_at, left.id, right.id));
  const latestAssignment = assignments[0] ?? null;
  const latestVerdict = verdicts[0] ?? null;
  const pendingApprovals = approvals
    .filter((approval) => approval.status === "PENDING")
    .sort((left, right) => sortNewestFirst(left.created_at, right.created_at, left.id, right.id));
  const intakePrompt = taskNotes.find((note) => note.author_id === "cli:intake")?.content ?? taskNotes.at(-1)?.content ?? null;
  const activeSession = runSessions.find((session) => !session.finished_at) ?? runSessions[0] ?? null;
  const activeRun = activeSession?.run_id
    ? ensureArray(detail.runs ?? [], "detail.runs").map(parseRunRecord).find((run) => run.id === activeSession.run_id) ?? null
    : ensureArray(detail.runs ?? [], "detail.runs").map(parseRunRecord).sort((left, right) =>
      sortNewestFirst(
        left.finished_at ?? left.started_at,
        right.finished_at ?? right.started_at,
        left.id,
        right.id,
      ))[0] ?? null;
  const compatibilityEvents = liveEvents.length === 0
    ? createCompatibilityTimelineFromProgress(normalizedTaskId, artifacts.executionProgress)
    : [];
  const compatibilityExcerpts = liveExcerpts.length === 0
    ? createCompatibilityExcerptFromProgress(normalizedTaskId, artifacts)
    : [];
  const curatedTimeline = [...liveEvents, ...compatibilityEvents]
    .filter((event) => event.visibility !== "debug")
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id));
  const curatedExcerpts = [...liveExcerpts, ...compatibilityExcerpts]
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id));
  const validatorSummary = Object.freeze({
    gate_decisions: decisions.filter((decision) => decision.decision_type === "GATE"),
    latest_verdict: latestVerdict,
  });

  return Object.freeze({
    active_run: activeRun,
    active_run_id: activeSession?.run_id ?? activeRun?.id ?? null,
    artifacts: Object.freeze({
      execution_log_path: artifacts.executionLogPath,
      report_json_url: artifacts.report_json_url,
      report_markdown_url: artifacts.report_markdown_url,
      task_root: artifacts.taskRoot,
    }),
    blockers: Object.freeze(blockers),
    connection_state: connectionState,
    execution_log_tail: artifacts.executionLogTail,
    execution_progress: artifacts.executionProgress,
    intake_prompt: intakePrompt,
    latest_assignment: latestAssignment,
    latest_verdict: latestVerdict,
    live_excerpts: Object.freeze(curatedExcerpts),
    live_timeline: Object.freeze(curatedTimeline),
    pending_approvals: Object.freeze(pendingApprovals),
    run_sessions: Object.freeze(runSessions),
    task,
    task_notes: Object.freeze(taskNotes),
    validator_summary: validatorSummary,
    version: buildTaskCardVersion({
      artifacts,
    liveEvents: curatedTimeline,
    liveExcerpts: curatedExcerpts,
    latestVerdict,
    pendingApprovals,
    runSessions,
    taskContentRevisions,
    task,
  }),
  });
}

export {
  TaskCardViewError,
  buildTaskCardVersion,
  buildTaskCardView,
};
