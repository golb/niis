import { parseEventLogEntry } from "../schemas/event.js";
import { buildHeartbeatContext, createPromptExecutionPlan, executePromptPlan } from "../runtime/prompt-execution.js";
import { normalizeExecutionResult } from "../runtime/result-normalizer.js";
import { buildRoutePlan } from "./plan-builder.js";

class RoutingExecutorError extends Error {
  constructor(message) {
    super(message);
    this.name = "RoutingExecutorError";
  }
}

function ensurePlainObject(value, label) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RoutingExecutorError(`${label} must be a plain object`);
  }

  return value;
}

function createExecutionArtifacts({
  taskId,
  runId,
  routePlan,
  execution,
  finishedAt,
}) {
  return routePlan.explainability
    ? [
      routePlan.event,
      parseEventLogEntry({
        actor: "runtime",
        event_type: "POLICY_DECISION",
        id: `${runId}:execution-finished:${finishedAt.toISOString()}`,
        payload: {
          route: routePlan.selected_lane,
          stop_reason: execution.stop_reason,
          turn_count: execution.turns.length,
        },
        run_id: runId,
        task_id: taskId,
        timestamp: finishedAt.toISOString(),
      }),
    ]
    : [];
}

async function executeRoutePlan({
  routePlan,
  runId,
  agentId,
  taskSessionKey = null,
  session = null,
  bootstrapContext = {},
  assignments = [],
  events = [],
  notes = [],
  previousCursor = {},
  runtimeTools = [],
  taskStateProvider,
  evaluateContextSufficiency,
  maxTurns = 3,
  confirmationThreshold = 1,
  now = new Date(),
  invocationSource = "on_demand",
} = {}) {
  if (!routePlan?.selectedAdapter) {
    throw new RoutingExecutorError("routePlan.selectedAdapter is required");
  }

  const startedAt = new Date(now);
  const heartbeatContext = buildHeartbeatContext({
    assignments,
    events,
    notes,
    previousCursor,
  });
  const plan = createPromptExecutionPlan({
    bootstrapContext,
    confirmationThreshold,
    delegationPayload: routePlan.delegation_payload,
    heartbeatContext,
    maxTurns,
    referenceBundle: routePlan.reference_bundle,
    session,
    task: routePlan.task,
  });
  const execution = await executePromptPlan({
    adapter: routePlan.selectedAdapter,
    evaluateContextSufficiency,
    plan,
    runtimeTools,
    taskStateProvider,
  });
  const finishedAt = new Date();
  const normalizedResult = normalizeExecutionResult({
    adapter: routePlan.selectedAdapter,
    agentId,
    finishedAt,
    invocationSource,
    rawResult: execution.final_response ?? {
      completion_signal: false,
      next_actions: [],
      status: "WARNING",
      summary: `Execution stopped with ${execution.stop_reason}.`,
    },
    roleId: routePlan.selected_lane?.manifest_id ?? null,
    runId,
    taskSessionKey,
    startedAt,
    taskId: routePlan.task.id,
  });

  return Object.freeze({
    execution,
    explainability: routePlan.explainability,
    route_plan: routePlan,
    runtime_events: Object.freeze([
      ...createExecutionArtifacts({
        execution,
        finishedAt,
        routePlan,
        runId,
        taskId: routePlan.task.id,
      }),
      ...normalizedResult.events,
    ]),
    run_record: normalizedResult.run_record,
    final_response: execution.final_response,
  });
}

async function runTaskExecution({
  task,
  adapters,
  roleManifests = [],
  referenceBundle = {},
  routingPolicy = {},
  subtasks = [],
  runId,
  agentId,
  taskSessionKey = null,
  session = null,
  bootstrapContext = {},
  assignments = [],
  events = [],
  notes = [],
  previousCursor = {},
  runtimeTools = [],
  taskStateProvider,
  evaluateContextSufficiency,
  maxTurns = 3,
  confirmationThreshold = 1,
  now = new Date(),
  invocationSource = "on_demand",
} = {}) {
  const routePlan = buildRoutePlan({
    adapters,
    now,
    referenceBundle,
    roleManifests,
    routingPolicy,
    subtasks,
    task,
  });

  return executeRoutePlan({
    agentId,
    assignments,
    bootstrapContext,
    confirmationThreshold,
    evaluateContextSufficiency,
    events,
    invocationSource,
    maxTurns,
    notes,
    now,
    previousCursor,
    routePlan,
    runId,
    session,
    taskSessionKey,
    runtimeTools,
    taskStateProvider,
  });
}

export {
  RoutingExecutorError,
  executeRoutePlan,
  runTaskExecution,
};
