import {
  assertAdapterImplementation,
  normalizeAdapterResult,
} from "../contracts/adapter.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseRunRecord } from "../schemas/run.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import { createRunLogDescriptor } from "../storage/run-logs.js";

class ResultNormalizerError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResultNormalizerError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ResultNormalizerError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureInvocationSource(value) {
  return ensureNonEmptyString(value ?? "on_demand", "invocationSource");
}

function mapAdapterStatusToRunStatus(adapterStatus) {
  switch (adapterStatus) {
    case "ERROR":
      return "FAILED";
    case "TIMEOUT":
      return "TIMED_OUT";
    case "SUCCESS":
    case "WARNING":
    default:
      return "COMPLETED";
  }
}

function createCanonicalCostObject({
  cost,
  startedAt,
  finishedAt,
} = {}) {
  const startedAtTimestamp = Date.parse(toIsoTimestamp(startedAt, "startedAt"));
  const finishedAtTimestamp = Date.parse(toIsoTimestamp(finishedAt, "finishedAt"));
  const normalizedCost = cost ?? {};

  const modelId = typeof normalizedCost.model_id === "string" && normalizedCost.model_id.trim() !== ""
    ? normalizedCost.model_id.trim()
    : null;
  return Object.freeze({
    duration_ms: Math.max(0, finishedAtTimestamp - startedAtTimestamp),
    estimated_usd: Number(normalizedCost.estimated_usd ?? 0),
    model_id: modelId,
    tokens_cached: Number.isInteger(normalizedCost.cached_input_tokens) ? normalizedCost.cached_input_tokens : 0,
    tokens_in: Number.isInteger(normalizedCost.input_tokens) ? normalizedCost.input_tokens : 0,
    tokens_out: Number.isInteger(normalizedCost.output_tokens) ? normalizedCost.output_tokens : 0,
  });
}

function normalizeExecutionResult({
  taskId,
  runId,
  agentId,
  adapter,
  rawResult,
  invocationSource = "on_demand",
  startedAt,
  finishedAt = new Date(),
  subtaskId = null,
  roleId = null,
  taskSessionKey = null,
} = {}) {
  const normalizedAdapter = assertAdapterImplementation(adapter);
  const normalizedResponse = normalizeAdapterResult(normalizedAdapter, rawResult);
  const normalizedStartedAt = toIsoTimestamp(startedAt, "startedAt");
  const normalizedFinishedAt = toIsoTimestamp(finishedAt, "finishedAt");
  const cost = createCanonicalCostObject({
    cost: normalizedResponse.cost,
    finishedAt: normalizedFinishedAt,
    startedAt: normalizedStartedAt,
  });
  const runLog = createRunLogDescriptor({
    rawOutput: rawResult,
  });
  const runRecord = parseRunRecord({
    adapter_id: normalizedAdapter.id,
    agent_id: ensureNonEmptyString(agentId, "agentId"),
    checkpoint_id: null,
    cost,
    exit_code: normalizedResponse.status === "ERROR" ? 1 : 0,
    finished_at: normalizedFinishedAt,
    id: ensureNonEmptyString(runId, "runId"),
    invocation_source: ensureInvocationSource(invocationSource),
    run_log: runLog,
    role_id: roleId === null || roleId === undefined ? null : String(roleId),
    started_at: normalizedStartedAt,
    status: mapAdapterStatusToRunStatus(normalizedResponse.status),
    subtask_id: subtaskId,
    task_id: ensureNonEmptyString(taskId, "taskId"),
    task_session_key: taskSessionKey,
  });
  const event = parseEventLogEntry({
    actor: normalizedAdapter.id,
    event_type: "ADAPTER_CALL",
    id: `${runRecord.id}:adapter-call:${normalizedFinishedAt}`,
    payload: {
      adapter_id: normalizedAdapter.id,
      artifacts: normalizedResponse.artifacts,
      completion_signal: normalizedResponse.completion_signal,
      cost,
      error: normalizedResponse.error,
      next_actions: normalizedResponse.next_actions,
      status: normalizedResponse.status,
      summary: normalizedResponse.summary,
    },
    run_id: runRecord.id,
    task_id: runRecord.task_id,
    timestamp: normalizedFinishedAt,
  });

  return Object.freeze({
    adapter_response: normalizedResponse,
    cost,
    events: Object.freeze([event]),
    run_record: runRecord,
  });
}

export {
  ResultNormalizerError,
  createCanonicalCostObject,
  createRunLogDescriptor,
  mapAdapterStatusToRunStatus,
  normalizeExecutionResult,
};
