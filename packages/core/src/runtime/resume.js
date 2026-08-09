import { deserializeAdapterSession } from "../contracts/adapter.js";
import { parseCheckpoint } from "../schemas/checkpoint.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { parseTaskSession } from "../schemas/task-session.js";
import { toIsoTimestamp } from "../scheduler/queue.js";

class ResumeRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResumeRuntimeError";
  }
}

function ensurePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ResumeRuntimeError(`${label} must be a plain object`);
  }

  return value;
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ResumeRuntimeError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function deepMergeState(baseValue, incomingValue) {
  if (
    baseValue === null ||
    incomingValue === null ||
    Array.isArray(baseValue) ||
    Array.isArray(incomingValue) ||
    typeof baseValue !== "object" ||
    typeof incomingValue !== "object"
  ) {
    return structuredClone(incomingValue);
  }

  const output = {
    ...structuredClone(baseValue),
  };

  for (const [key, value] of Object.entries(incomingValue)) {
    if (Object.prototype.hasOwnProperty.call(output, key)) {
      output[key] = deepMergeState(output[key], value);
    } else {
      output[key] = structuredClone(value);
    }
  }

  return output;
}

function restoreCheckpointState({
  checkpoint,
  baseState = {},
}) {
  const normalizedCheckpoint = parseCheckpoint(checkpoint);
  ensurePlainObject(baseState, "baseState");

  return deepMergeState(baseState, normalizedCheckpoint.state_snapshot);
}

function restoreTaskSession({
  taskSession = null,
  sessionCodec = null,
}) {
  if (!taskSession) {
    return null;
  }

  const normalizedSession = parseTaskSession(taskSession);
  const sessionParams = sessionCodec
    ? deserializeAdapterSession(sessionCodec, normalizedSession.session_params)
    : structuredClone(normalizedSession.session_params);

  return Object.freeze({
    adapter_type: normalizedSession.adapter_type,
    agent_id: normalizedSession.agent_id,
    display_id: normalizedSession.display_id,
    last_run_id: normalizedSession.last_run_id,
    session_params: sessionParams,
    task_key: normalizedSession.task_key,
  });
}

function createResumePlan({
  taskId,
  checkpoint,
  taskSession = null,
  sessionCodec = null,
  baseState = {},
  baseContext = {},
  now = new Date(),
  actor = "runtime",
  policyRef = "runtime/resume/v1",
}) {
  const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
  const normalizedCheckpoint = parseCheckpoint(checkpoint);

  if (!normalizedCheckpoint.resumable) {
    throw new ResumeRuntimeError(
      `checkpoint ${normalizedCheckpoint.id} is marked non-resumable and cannot restore execution`,
    );
  }

  ensurePlainObject(baseContext, "baseContext");

  const timestamp = toIsoTimestamp(now, "now");
  const restoredState = restoreCheckpointState({
    checkpoint: normalizedCheckpoint,
    baseState,
  });
  const restoredSession = restoreTaskSession({
    taskSession,
    sessionCodec,
  });
  const restoredContext = Object.freeze({
    ...structuredClone(baseContext),
    checkpoint_context_summary: normalizedCheckpoint.context_summary,
    checkpoint_id: normalizedCheckpoint.id,
    resumed_from_run_id: normalizedCheckpoint.run_id,
    resume_instructions: normalizedCheckpoint.resume_instructions,
    session: restoredSession,
  });
  const resumeMessage = `Resume from checkpoint ${normalizedCheckpoint.id}: ${normalizedCheckpoint.resume_instructions}`;

  const event = parseEventLogEntry({
    id: `${normalizedCheckpoint.run_id}:resume:${timestamp}`,
    run_id: normalizedCheckpoint.run_id,
    task_id: normalizedTaskId,
    event_type: "CHECKPOINT",
    timestamp,
    actor,
    payload: {
      checkpoint_id: normalizedCheckpoint.id,
      context_summary: normalizedCheckpoint.context_summary,
      resume_instructions: normalizedCheckpoint.resume_instructions,
      task_session_key: restoredSession?.task_key ?? null,
    },
  });

  const explainability = parseExplainabilityRecord({
    id: `${normalizedCheckpoint.run_id}:resume-explain:${timestamp}`,
    decision_type: "ASSIGNMENT",
    task_id: normalizedTaskId,
    route_chosen: `resume:${normalizedCheckpoint.id}`,
    alternatives_considered: [],
    policy_refs: [policyRef],
    evidence_refs: [normalizedCheckpoint.id],
    timestamp,
    human_readable_summary: `Restored state from checkpoint ${normalizedCheckpoint.id} and prepared resume instructions for run ${normalizedCheckpoint.run_id}.`,
  });

  return Object.freeze({
    checkpoint_id: normalizedCheckpoint.id,
    event,
    explainability,
    invocation_source: "resume",
    restored_context: restoredContext,
    restored_session: restoredSession,
    restored_state: restoredState,
    resume_instructions: normalizedCheckpoint.resume_instructions,
    resume_message: resumeMessage,
    run_id: normalizedCheckpoint.run_id,
    task_id: normalizedTaskId,
  });
}

export {
  ResumeRuntimeError,
  createResumePlan,
  restoreCheckpointState,
  restoreTaskSession,
};
