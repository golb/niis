import { parseEventLogEntry } from "../schemas/event.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { parseApprovalRecord } from "../schemas/approval.js";
import { parseBlockerArtifact } from "../schemas/blocker.js";
import { parseAssignmentReason } from "../schemas/assignment.js";
import { parseEvidencePacket } from "../schemas/evidence.js";
import { parseRunRecord } from "../schemas/run.js";
import { parseTaskRecord } from "../schemas/task.js";
import { parseTaskContentRevision } from "../schemas/task-content-revision.js";
import { parseCheckpoint } from "../schemas/checkpoint.js";
import { parseTaskNote } from "../schemas/task-note.js";
import { parseReviewVerdict } from "../schemas/verdict.js";

class ActivityStreamError extends Error {
  constructor(message) {
    super(message);
    this.name = "ActivityStreamError";
  }
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ActivityStreamError(`${label} must be a plain object`);
  }

  return value;
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new ActivityStreamError(`${label} must be an array`);
  }

  return value;
}

function normalizeLifecyclePhase(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  return value.trim().replace(/_/g, " ");
}

function humanizeEvent(eventLogEntry) {
  const event = parseEventLogEntry(eventLogEntry);
  const phase = normalizeLifecyclePhase(event.payload?.lifecycle_phase);
  const phaseStatus = event.payload?.phase_status ?? null;

  if (phase) {
    return `Lifecycle ${phase}${phaseStatus ? ` ${phaseStatus}` : ""}.`;
  }

  switch (event.event_type) {
    case "ADAPTER_CALL":
      return `${event.actor} returned ${event.payload?.status ?? "UNKNOWN"}${event.payload?.summary ? `: ${event.payload.summary}` : "."}`;
    case "POLICY_DECISION":
      if (event.payload?.retry_mode) {
        return `Retry policy scheduled ${event.payload.retry_mode} attempt ${event.payload.attempt} for ${event.payload.scheduled_at}.`;
      }

      if (event.payload?.lane_id && event.payload?.adapter_id) {
        return `Coordinator selected lane ${event.payload.lane_id} with adapter ${event.payload.adapter_id}.`;
      }

      return `Policy decision recorded by ${event.actor}.`;
    case "CHECKPOINT":
      return "Checkpoint captured for resumable execution.";
    case "ERROR":
      return event.payload?.summary
        ? `Failure recorded: ${event.payload.summary}`
        : "Failure recorded in runtime activity.";
    case "VALIDATOR_RUN":
      return `Validator run recorded by ${event.actor}.`;
    case "STATE_CHANGE":
      if (event.payload?.from_status && event.payload?.to_status) {
        return `State changed ${event.payload.from_status} -> ${event.payload.to_status}.`;
      }

      return `State change recorded by ${event.actor}.`;
    default:
      return `${event.event_type} recorded by ${event.actor}.`;
  }
}

function humanizeApproval(approvalRecord) {
  const approval = parseApprovalRecord(approvalRecord);
  const latestNote = approval.notes.at(-1) ?? null;
  return `Approval ${approval.status} for ${approval.action_id} (${approval.risk_level} risk).`
    + ` ${approval.reason}${latestNote ? ` Latest note: ${latestNote}` : ""}`;
}

function humanizeCheckpoint(checkpointRecord) {
  const checkpoint = parseCheckpoint(checkpointRecord);
  return `${checkpoint.context_summary}${checkpoint.resumable ? ` Resume: ${checkpoint.resume_instructions}` : ""}`;
}

function humanizeTaskContentRevision(taskContentRevisionRecord) {
  const revision = parseTaskContentRevision(taskContentRevisionRecord);
  const changedFields = Array.isArray(revision.changed_fields) ? revision.changed_fields : [];

  if (changedFields.length === 0) {
    return `Task content updated by ${revision.editor_id}.`;
  }

  return `Task content updated by ${revision.editor_id}: ${changedFields.join(", ")}.`;
}

function createActivityEntry({
  id,
  taskId,
  runId = null,
  timestamp,
  sourceKind,
  title,
  summary,
  payload,
}) {
  return Object.freeze({
    id,
    payload,
    run_id: runId,
    source_kind: sourceKind,
    summary,
    task_id: taskId,
    timestamp,
    title,
  });
}

function buildActivityStream({
  snapshot,
  taskId,
}) {
  const normalizedSnapshot = ensurePlainObject(snapshot, "snapshot");
  const taskIdentifier = typeof taskId === "string" && taskId.trim() !== "" ? taskId : null;
  const runs = ensureArray(normalizedSnapshot.runs ?? [], "snapshot.runs").map(parseRunRecord);
  const runIdsForTask = new Set(
    runs.filter((run) => taskIdentifier === null || run.task_id === taskIdentifier).map((run) => run.id),
  );
  const checkpoints = ensureArray(normalizedSnapshot.checkpoints ?? [], "snapshot.checkpoints").map(parseCheckpoint);

  const entries = [
    ...ensureArray(normalizedSnapshot.events ?? [], "snapshot.events")
      .map(parseEventLogEntry)
      .filter((event) => taskIdentifier === null || event.task_id === taskIdentifier)
      .map((event) => createActivityEntry({
        id: `event:${event.id}`,
        payload: event.payload,
        runId: event.run_id,
        sourceKind: "event",
        summary: humanizeEvent(event),
        taskId: event.task_id,
        timestamp: event.timestamp,
        title: event.event_type,
      })),
    ...ensureArray(normalizedSnapshot.explainability ?? [], "snapshot.explainability")
      .map(parseExplainabilityRecord)
      .filter((record) => taskIdentifier === null || record.task_id === taskIdentifier)
      .map((record) => createActivityEntry({
        id: `explainability:${record.id}`,
        payload: record,
        sourceKind: "explainability",
        summary: record.human_readable_summary,
        taskId: record.task_id,
        timestamp: record.timestamp,
        title: `${record.decision_type} decision`,
      })),
    ...ensureArray(normalizedSnapshot.approvals ?? [], "snapshot.approvals")
      .map(parseApprovalRecord)
      .filter((approval) => taskIdentifier === null || approval.task_id === taskIdentifier)
      .map((approval) => createActivityEntry({
        id: `approval:${approval.id}`,
        payload: approval,
        sourceKind: "approval",
        summary: humanizeApproval(approval),
        taskId: approval.task_id,
        timestamp: approval.approved_at ?? approval.created_at,
        title: `Approval ${approval.status}`,
      })),
    ...ensureArray(normalizedSnapshot.blockers ?? [], "snapshot.blockers")
      .map(parseBlockerArtifact)
      .filter((blocker) => taskIdentifier === null || blocker.task_id === taskIdentifier)
      .map((blocker) => createActivityEntry({
        id: `blocker:${blocker.id}`,
        payload: blocker,
        sourceKind: "blocker",
        summary: `${blocker.reason} Next action: ${blocker.next_action}`,
        taskId: blocker.task_id,
        timestamp: blocker.created_at,
        title: `${blocker.blocker_class} blocker`,
      })),
    ...ensureArray(normalizedSnapshot.assignments ?? [], "snapshot.assignments")
      .map(parseAssignmentReason)
      .filter((assignment) => taskIdentifier === null || assignment.task_id === taskIdentifier)
      .map((assignment) => createActivityEntry({
        id: `assignment:${assignment.id}`,
        payload: assignment,
        sourceKind: "assignment",
        summary: `Assigned to ${assignment.agent_id} via ${assignment.reason_type}: ${assignment.context}`,
        taskId: assignment.task_id,
        timestamp: assignment.assigned_at,
        title: "Assignment",
      })),
    ...checkpoints
      .filter((checkpoint) => runIdsForTask.has(checkpoint.run_id))
      .map((checkpoint) => {
        const run = runs.find((entry) => entry.id === checkpoint.run_id) ?? null;
        return createActivityEntry({
          id: `checkpoint:${checkpoint.id}`,
          payload: checkpoint,
          runId: checkpoint.run_id,
          sourceKind: "checkpoint",
          summary: checkpoint.context_summary,
          taskId: run?.task_id ?? taskIdentifier ?? "unknown-task",
          timestamp: checkpoint.created_at,
          title: "Checkpoint",
        });
      }),
    ...ensureArray(normalizedSnapshot.taskContentRevisions ?? [], "snapshot.taskContentRevisions")
      .map(parseTaskContentRevision)
      .filter((revision) => taskIdentifier === null || revision.task_id === taskIdentifier)
      .map((revision) => createActivityEntry({
        id: `task-content-revision:${revision.id}`,
        payload: revision,
        sourceKind: "task_content",
        summary: humanizeTaskContentRevision(revision),
        taskId: revision.task_id,
        timestamp: revision.created_at,
        title: "Task content updated",
      })),
  ];

  return Object.freeze(entries.sort((left, right) => {
    const timeDiff = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    if (timeDiff !== 0) {
      return timeDiff;
    }

    return left.id.localeCompare(right.id);
  }));
}

function buildRunActivityStream({
  snapshot,
  runId,
}) {
  const normalizedSnapshot = ensurePlainObject(snapshot, "snapshot");
  const normalizedRunId = typeof runId === "string" && runId.trim() !== "" ? runId.trim() : null;

  if (!normalizedRunId) {
    return Object.freeze([]);
  }

  const runs = ensureArray(normalizedSnapshot.runs ?? [], "snapshot.runs").map(parseRunRecord);
  const run = runs.find((entry) => entry.id === normalizedRunId) ?? null;

  if (!run) {
    return Object.freeze([]);
  }

  const entries = [
    ...ensureArray(normalizedSnapshot.events ?? [], "snapshot.events")
      .map(parseEventLogEntry)
      .filter((event) => event.run_id === normalizedRunId)
      .map((event) => createActivityEntry({
        id: `event:${event.id}`,
        payload: event.payload,
        runId: event.run_id,
        sourceKind: "event",
        summary: humanizeEvent(event),
        taskId: event.task_id,
        timestamp: event.timestamp,
        title: event.event_type,
      })),
    ...ensureArray(normalizedSnapshot.checkpoints ?? [], "snapshot.checkpoints")
      .map(parseCheckpoint)
      .filter((checkpoint) => checkpoint.run_id === normalizedRunId)
      .map((checkpoint) => createActivityEntry({
        id: `checkpoint:${checkpoint.id}`,
        payload: checkpoint,
        runId: checkpoint.run_id,
        sourceKind: "checkpoint",
        summary: humanizeCheckpoint(checkpoint),
        taskId: run.task_id,
        timestamp: checkpoint.created_at,
        title: "Checkpoint",
      })),
  ];

  return Object.freeze(entries.sort((left, right) => {
    const timeDiff = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    if (timeDiff !== 0) {
      return timeDiff;
    }

    return left.id.localeCompare(right.id);
  }));
}

function buildRunObservabilityView({
  snapshot,
  runId,
}) {
  const normalizedSnapshot = ensurePlainObject(snapshot, "snapshot");
  const normalizedRunId = typeof runId === "string" && runId.trim() !== "" ? runId.trim() : null;
  const runs = ensureArray(normalizedSnapshot.runs ?? [], "snapshot.runs").map(parseRunRecord);
  const run = runs.find((entry) => entry.id === normalizedRunId) ?? null;

  if (!run) {
    return null;
  }

  const task = ensureArray(normalizedSnapshot.tasks ?? [], "snapshot.tasks")
    .map(parseTaskRecord)
    .find((entry) => entry.id === run.task_id) ?? null;
  const assignments = ensureArray(normalizedSnapshot.assignments ?? [], "snapshot.assignments")
    .map(parseAssignmentReason)
    .filter((assignment) => assignment.task_id === run.task_id)
    .sort((left, right) => Date.parse(right.assigned_at) - Date.parse(left.assigned_at) || left.id.localeCompare(right.id));
  const decisions = ensureArray(normalizedSnapshot.explainability ?? [], "snapshot.explainability")
    .map(parseExplainabilityRecord)
    .filter((record) => record.task_id === run.task_id)
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp) || left.id.localeCompare(right.id));
  const verdicts = ensureArray(normalizedSnapshot.verdicts ?? [], "snapshot.verdicts")
    .map(parseReviewVerdict)
    .filter((verdict) => verdict.run_id === run.id)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || left.id.localeCompare(right.id));
  const evidencePackets = ensureArray(normalizedSnapshot.evidence ?? [], "snapshot.evidence")
    .map(parseEvidencePacket)
    .filter((packet) => verdicts.some((verdict) => verdict.id === packet.verdict_id));
  const checkpoints = ensureArray(normalizedSnapshot.checkpoints ?? [], "snapshot.checkpoints")
    .map(parseCheckpoint)
    .filter((checkpoint) => checkpoint.run_id === run.id)
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at) || left.id.localeCompare(right.id));
  const events = ensureArray(normalizedSnapshot.events ?? [], "snapshot.events")
    .map(parseEventLogEntry)
    .filter((event) => event.run_id === run.id)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id));
  const runLogs = ensureArray(normalizedSnapshot.runLogs ?? normalizedSnapshot.run_logs ?? [], "snapshot.runLogs")
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  const runLog = runLogs.find((entry) => (entry.run_id ?? entry.id) === run.id) ?? null;
  const phases = events
    .filter((event) => event.event_type === "STATE_CHANGE" && event.payload?.lifecycle_phase)
    .map((event) => Object.freeze({
      id: event.id,
      phase_status: event.payload?.phase_status ?? null,
      summary: event.payload?.summary ?? humanizeEvent(event),
      timestamp: event.timestamp,
      value: normalizeLifecyclePhase(event.payload?.lifecycle_phase),
    }));
  const runtimeChoice = decisions.find((decision) => decision.decision_type === "ROUTE")
    ?? decisions.find((decision) => decision.decision_type === "ASSIGNMENT")
    ?? null;
  const latestVerdict = verdicts[0] ?? null;
  const latestEvidencePacket = latestVerdict
    ? evidencePackets.find((packet) => packet.verdict_id === latestVerdict.id) ?? null
    : null;

  return Object.freeze({
    activity: buildRunActivityStream({
      runId: run.id,
      snapshot: normalizedSnapshot,
    }),
    assignments: Object.freeze(assignments),
    checkpoints: Object.freeze(checkpoints),
    decisions: Object.freeze(decisions),
    evidence_packets: Object.freeze(evidencePackets),
    events: Object.freeze(events),
    latest_evidence_packet: latestEvidencePacket,
    latest_verdict: latestVerdict,
    phases: Object.freeze(phases),
    run,
    run_log: runLog,
    runtime_choice: runtimeChoice,
    task,
    verdicts: Object.freeze(verdicts),
  });
}

function buildTaskObservabilityView({
  snapshot,
  taskId,
}) {
  const normalizedSnapshot = ensurePlainObject(snapshot, "snapshot");
  const task = ensureArray(normalizedSnapshot.tasks ?? [], "snapshot.tasks")
    .map(parseTaskRecord)
    .find((entry) => entry.id === taskId) ?? null;
  const runs = ensureArray(normalizedSnapshot.runs ?? [], "snapshot.runs")
    .map(parseRunRecord)
    .filter((run) => run.task_id === taskId);
  const blockers = ensureArray(normalizedSnapshot.blockers ?? [], "snapshot.blockers")
    .map(parseBlockerArtifact)
    .filter((blocker) => blocker.task_id === taskId && blocker.resolved_at === null);
  const decisions = ensureArray(normalizedSnapshot.explainability ?? [], "snapshot.explainability")
    .map(parseExplainabilityRecord)
    .filter((record) => record.task_id === taskId);
  const assignments = ensureArray(normalizedSnapshot.assignments ?? [], "snapshot.assignments")
    .map(parseAssignmentReason)
    .filter((assignment) => assignment.task_id === taskId);
  const taskNotes = ensureArray(
    normalizedSnapshot.taskNotes ?? normalizedSnapshot.task_notes ?? [],
    "snapshot.taskNotes",
  )
    .map(parseTaskNote)
    .filter((note) => note.task_id === taskId);
  const taskContentRevisions = ensureArray(
    normalizedSnapshot.taskContentRevisions ?? normalizedSnapshot.task_content_revisions ?? [],
    "snapshot.taskContentRevisions",
  )
    .map(parseTaskContentRevision)
    .filter((revision) => revision.task_id === taskId)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || left.id.localeCompare(right.id));
  const approvals = ensureArray(normalizedSnapshot.approvals ?? [], "snapshot.approvals")
    .map(parseApprovalRecord)
    .filter((approval) => approval.task_id === taskId)
    .sort((left, right) =>
      Date.parse(right.approved_at ?? right.created_at) - Date.parse(left.approved_at ?? left.created_at)
      || left.id.localeCompare(right.id));
  const verdicts = ensureArray(normalizedSnapshot.verdicts ?? [], "snapshot.verdicts")
    .map(parseReviewVerdict)
    .filter((verdict) => verdict.task_id === taskId)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || left.id.localeCompare(right.id));
  const evidencePackets = ensureArray(normalizedSnapshot.evidence ?? [], "snapshot.evidence")
    .map(parseEvidencePacket)
    .filter((packet) => verdicts.some((verdict) => verdict.id === packet.verdict_id));
  const latestApproval = approvals[0] ?? null;
  const latestVerdict = verdicts[0] ?? null;
  const latestEvidencePacket = latestVerdict
    ? evidencePackets.find((packet) => packet.verdict_id === latestVerdict.id) ?? null
    : null;

  return Object.freeze({
    activity: buildActivityStream({
      snapshot: normalizedSnapshot,
      taskId,
    }),
    approvals,
    assignments,
    blockers,
    decisions,
    evidence_packets: evidencePackets,
    latest_approval: latestApproval,
    latest_evidence_packet: latestEvidencePacket,
    latest_verdict: latestVerdict,
    runs,
    task,
    task_content_revisions: taskContentRevisions,
    task_notes: taskNotes,
    verdicts,
  });
}

export {
  ActivityStreamError,
  buildActivityStream,
  buildRunActivityStream,
  buildRunObservabilityView,
  buildTaskObservabilityView,
  humanizeEvent,
};
