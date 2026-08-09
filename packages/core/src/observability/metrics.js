import { parseAgentEntity } from "../schemas/agent.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseRunRecord } from "../schemas/run.js";
import { parseTaskRecord } from "../schemas/task.js";
import { parseQueueItem, toIsoTimestamp } from "../scheduler/queue.js";

class MetricsViewError extends Error {
  constructor(message) {
    super(message);
    this.name = "MetricsViewError";
  }
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MetricsViewError(`${label} must be a plain object`);
  }

  return value;
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new MetricsViewError(`${label} must be an array`);
  }

  return value;
}

function ensureOptionalString(value, label) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new MetricsViewError(`${label} must be a non-empty string when provided`);
  }

  return value.trim();
}

function ensureThreshold(value, label) {
  if (value === undefined || value === null) {
    return 0.8;
  }

  const normalizedValue = Number(value);

  if (Number.isNaN(normalizedValue) || normalizedValue < 0 || normalizedValue > 1) {
    throw new MetricsViewError(`${label} must be between 0 and 1`);
  }

  return normalizedValue;
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function isRunSuccessful(run) {
  return run.status === "COMPLETED";
}

function isRunFailure(run) {
  return run.status === "FAILED" || run.status === "TIMED_OUT";
}

function sortRunsChronologically(runs) {
  return [...runs].sort((left, right) => {
    const leftTime = Date.parse(left.finished_at ?? left.started_at);
    const rightTime = Date.parse(right.finished_at ?? right.started_at);

    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.id.localeCompare(right.id);
  });
}

function groupBy(values, keySelector) {
  const groups = new Map();

  for (const value of values) {
    const key = keySelector(value);
    const bucket = groups.get(key) ?? [];
    bucket.push(value);
    groups.set(key, bucket);
  }

  return groups;
}

function getLatestRun(runs) {
  return sortRunsChronologically(runs).at(-1) ?? null;
}

function deriveScopedTaskIds({ taskId, tasks, runs, agentId }) {
  if (taskId) {
    return new Set([taskId]);
  }

  const taskIds = new Set();

  for (const run of runs) {
    taskIds.add(run.task_id);
  }

  if (agentId) {
    for (const task of tasks) {
      if (task.assigned_to === agentId) {
        taskIds.add(task.id);
      }
    }
  }

  return taskIds;
}

function deriveRelevantAgents({ agentId, agents, runs, tasks, taskIds }) {
  if (agentId) {
    return agents.filter((agent) => agent.id === agentId);
  }

  if (taskIds.size === 0) {
    return agents;
  }

  const relevantAgentIds = new Set();

  for (const run of runs) {
    if (taskIds.has(run.task_id)) {
      relevantAgentIds.add(run.agent_id);
    }
  }

  for (const task of tasks) {
    if (taskIds.has(task.id) && task.assigned_to) {
      relevantAgentIds.add(task.assigned_to);
    }
  }

  return agents.filter((agent) => relevantAgentIds.has(agent.id));
}

function normalizeQueueState(queueWrites = []) {
  const latestByTask = new Map();

  queueWrites.forEach((queueItem, index) => {
    latestByTask.set(queueItem.task_id, {
      index,
      queue_item: queueItem,
    });
  });

  return [...latestByTask.values()]
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.queue_item);
}

function createBudgetAlertLevel({ limitUsd, spentUsd, warningThreshold }) {
  if (limitUsd === null || limitUsd === undefined || limitUsd <= 0) {
    return "unbounded";
  }

  const utilizationRatio = spentUsd / limitUsd;

  if (utilizationRatio >= 1) {
    return "critical";
  }

  if (utilizationRatio >= warningThreshold) {
    return "warning";
  }

  return "ok";
}

function summarizeBudgetWindow({
  limitUsd,
  spentUsd,
  warningThreshold,
} = {}) {
  const normalizedLimitUsd =
    limitUsd === null || limitUsd === undefined ? null : Number(limitUsd);
  const normalizedSpentUsd =
    spentUsd === null || spentUsd === undefined ? null : Number(spentUsd);
  const alertLevel = createBudgetAlertLevel({
    limitUsd: normalizedLimitUsd,
    spentUsd: Number(normalizedSpentUsd ?? 0),
    warningThreshold,
  });

  return Object.freeze({
    alert_level: alertLevel,
    budget_limit_usd: normalizedLimitUsd,
    budget_spent_usd: normalizedSpentUsd,
    remaining_budget_usd:
      normalizedLimitUsd === null || normalizedSpentUsd === null
        ? null
        : Math.max(0, normalizedLimitUsd - normalizedSpentUsd),
    utilization_ratio:
      normalizedLimitUsd && normalizedLimitUsd > 0 && normalizedSpentUsd !== null
        ? normalizedSpentUsd / normalizedLimitUsd
        : 0,
  });
}

function buildPerTaskCostView(taskRuns, tasksById) {
  return [...taskRuns.entries()]
    .map(([taskId, runs]) => {
      const orderedRuns = sortRunsChronologically(runs);
      const latestRun = orderedRuns.at(-1);

      return {
        latest_run_status: latestRun?.status ?? null,
        retries: Math.max(0, orderedRuns.length - 1),
        run_count: orderedRuns.length,
        successful: isRunSuccessful(latestRun),
        task_id: taskId,
        task_status: tasksById.get(taskId)?.status ?? null,
        total_estimated_usd: sum(orderedRuns.map((run) => Number(run.cost.estimated_usd ?? 0))),
        total_tokens_in: sum(orderedRuns.map((run) => Number(run.cost.tokens_in ?? 0))),
        total_tokens_out: sum(orderedRuns.map((run) => Number(run.cost.tokens_out ?? 0))),
      };
    })
    .sort((left, right) => left.task_id.localeCompare(right.task_id));
}

function buildPerAgentCostView({ agents, runs, warningThreshold }) {
  const runsByAgent = groupBy(runs, (run) => run.agent_id);
  const totalRuns = runs.length;

  return agents.map((agent) => {
    const agentRuns = runsByAgent.get(agent.id) ?? [];
    const budgetSummary = summarizeBudgetWindow({
      limitUsd: agent.budget_monthly?.limit_usd ?? null,
      spentUsd: agent.budget_monthly?.spent_usd ?? null,
      warningThreshold,
    });

    return {
      accumulated_cost_usd: Number(agent.accumulated?.total_cost_usd ?? 0),
      alert_level: budgetSummary.alert_level,
      agent_id: agent.id,
      budget_limit_usd: budgetSummary.budget_limit_usd,
      budget_spent_usd: budgetSummary.budget_spent_usd,
      remaining_budget_usd: budgetSummary.remaining_budget_usd,
      run_count: agentRuns.length,
      total_estimated_usd: sum(agentRuns.map((run) => Number(run.cost.estimated_usd ?? 0))),
      total_tokens_in: sum(agentRuns.map((run) => Number(run.cost.tokens_in ?? 0))),
      total_tokens_out: sum(agentRuns.map((run) => Number(run.cost.tokens_out ?? 0))),
      utilization_ratio: totalRuns === 0 ? 0 : agentRuns.length / totalRuns,
    };
  }).sort((left, right) => left.agent_id.localeCompare(right.agent_id));
}

function buildTaskSuccessMetrics({ runs, taskIdGroups }) {
  const successfulTasks = [...taskIdGroups.values()]
    .map(getLatestRun)
    .filter((run) => run && isRunSuccessful(run))
    .length;
  const taskCount = taskIdGroups.size;
  const runsByAdapter = groupBy(runs, (run) => run.adapter_id);

  return {
    overall: {
      rate: taskCount === 0 ? 0 : successfulTasks / taskCount,
      successful_tasks: successfulTasks,
      tasks_with_runs: taskCount,
    },
    per_adapter: [...runsByAdapter.entries()].map(([adapterId, adapterRuns]) => {
      const adapterTaskGroups = groupBy(adapterRuns, (run) => run.task_id);
      const successfulAdapterTasks = [...adapterTaskGroups.values()]
        .map(getLatestRun)
        .filter((run) => run && isRunSuccessful(run))
        .length;

      return {
        adapter_id: adapterId,
        rate: adapterTaskGroups.size === 0 ? 0 : successfulAdapterTasks / adapterTaskGroups.size,
        successful_tasks: successfulAdapterTasks,
        tasks_with_runs: adapterTaskGroups.size,
      };
    }).sort((left, right) => left.adapter_id.localeCompare(right.adapter_id)),
    per_project: [{
      project_id: "local",
      rate: taskCount === 0 ? 0 : successfulTasks / taskCount,
      successful_tasks: successfulTasks,
      tasks_with_runs: taskCount,
    }],
  };
}

function buildRetryMetrics(taskIdGroups) {
  const retryCounts = [...taskIdGroups.values()].map((runs) => Math.max(0, runs.length - 1));

  return {
    max_retries_on_task: retryCounts.length === 0 ? 0 : Math.max(...retryCounts),
    mean_retries_per_task: average(retryCounts),
    tasks_with_retries: retryCounts.filter((count) => count > 0).length,
  };
}

function buildTimeMetrics(taskIdGroups) {
  const completionDurations = [];
  const recoveryDurations = [];

  for (const runs of taskIdGroups.values()) {
    const orderedRuns = sortRunsChronologically(runs);
    const latestRun = orderedRuns.at(-1);

    if (latestRun && isRunSuccessful(latestRun)) {
      completionDurations.push(
        Date.parse(latestRun.finished_at ?? latestRun.started_at) - Date.parse(orderedRuns[0].started_at),
      );
    }

    const firstFailure = orderedRuns.find((run) => isRunFailure(run));

    if (!firstFailure) {
      continue;
    }

    const firstRecoveredRun = orderedRuns.find((run) =>
      isRunSuccessful(run)
      && Date.parse(run.finished_at ?? run.started_at)
        > Date.parse(firstFailure.finished_at ?? firstFailure.started_at)
    );

    if (!firstRecoveredRun) {
      continue;
    }

    recoveryDurations.push(
      Date.parse(firstRecoveredRun.finished_at ?? firstRecoveredRun.started_at)
      - Date.parse(firstFailure.finished_at ?? firstFailure.started_at),
    );
  }

  return {
    mean_time_to_completion_ms: average(completionDurations),
    mean_time_to_recovery_ms: average(recoveryDurations),
    recovered_task_count: recoveryDurations.length,
    successful_task_count: completionDurations.length,
  };
}

function buildFailureMetrics(events) {
  const failureEvents = events
    .filter((event) => event.event_type === "ERROR")
    .map((event) => event.payload?.failure_class ?? "UNKNOWN");
  const counts = groupBy(failureEvents, (failureClass) => failureClass);

  return {
    distribution: [...counts.entries()].map(([failureClass, entries]) => ({
      count: entries.length,
      failure_class: failureClass,
    })).sort((left, right) => left.failure_class.localeCompare(right.failure_class)),
    total_failure_events: failureEvents.length,
  };
}

function buildQueueMetrics({ queueWrites, scopedTaskIds, now }) {
  const normalizedNow = toIsoTimestamp(now, "now");
  const currentQueue = normalizeQueueState(queueWrites)
    .filter((queueItem) => scopedTaskIds.size === 0 || scopedTaskIds.has(queueItem.task_id));
  const activeQueue = currentQueue.filter((queueItem) =>
    queueItem.status === "QUEUED" || queueItem.status === "CLAIMED");
  const waitTimes = activeQueue.map((queueItem) =>
    Math.max(0, Date.parse(normalizedNow) - Date.parse(queueItem.queued_at)));

  return {
    active_depth: activeQueue.length,
    claimed_depth: activeQueue.filter((queueItem) => queueItem.status === "CLAIMED").length,
    max_wait_ms: waitTimes.length === 0 ? 0 : Math.max(...waitTimes),
    mean_wait_ms: average(waitTimes),
    queued_depth: activeQueue.filter((queueItem) => queueItem.status === "QUEUED").length,
  };
}

function buildBudgetMetrics({ agents, warningThreshold }) {
  const perAgent = buildPerAgentCostView({
    agents,
    runs: [],
    warningThreshold,
  }).map((entry) => ({
    agent_id: entry.agent_id,
    alert_level: entry.alert_level,
    budget_limit_usd: entry.budget_limit_usd,
    budget_spent_usd: entry.budget_spent_usd,
    remaining_budget_usd: entry.remaining_budget_usd,
  }));
  const boundedAgents = perAgent.filter((agent) => agent.budget_limit_usd !== null);
  const totalLimitUsd = sum(boundedAgents.map((agent) => Number(agent.budget_limit_usd ?? 0)));
  const totalSpentUsd = sum(boundedAgents.map((agent) => Number(agent.budget_spent_usd ?? 0)));

  return {
    agents: perAgent,
    alerts: perAgent
      .filter((agent) => agent.alert_level === "warning" || agent.alert_level === "critical")
      .map((agent) => ({
        agent_id: agent.agent_id,
        alert_level: agent.alert_level,
        remaining_budget_usd: agent.remaining_budget_usd,
      })),
    project: {
      alert_level: createBudgetAlertLevel({
        limitUsd: totalLimitUsd,
        spentUsd: totalSpentUsd,
        warningThreshold,
      }),
      total_limit_usd: boundedAgents.length === 0 ? null : totalLimitUsd,
      total_spent_usd: boundedAgents.length === 0 ? null : totalSpentUsd,
      utilization_ratio: totalLimitUsd > 0 ? totalSpentUsd / totalLimitUsd : 0,
    },
  };
}

function buildProjectCostSummary({ agents, perAgentCost, perTaskCost, runs }) {
  return {
    accumulated_cost_usd: sum(agents.map((agent) => Number(agent.accumulated?.total_cost_usd ?? 0))),
    cost_per_successful_task_usd: (() => {
      const successfulTasks = perTaskCost.filter((entry) => entry.successful);
      return successfulTasks.length === 0
        ? 0
        : sum(successfulTasks.map((entry) => entry.total_estimated_usd)) / successfulTasks.length;
    })(),
    total_estimated_usd: sum(runs.map((run) => Number(run.cost.estimated_usd ?? 0))),
    total_runs: runs.length,
    total_tasks_with_runs: perTaskCost.length,
    total_tokens_in: sum(perAgentCost.map((entry) => entry.total_tokens_in)),
    total_tokens_out: sum(perAgentCost.map((entry) => entry.total_tokens_out)),
  };
}

function buildOperationalMetricsView({
  snapshot,
  taskId = null,
  agentId = null,
  now = new Date(),
  budgetWarningThreshold = 0.8,
} = {}) {
  const normalizedSnapshot = ensurePlainObject(snapshot, "snapshot");
  const normalizedTaskId = ensureOptionalString(taskId, "taskId");
  const normalizedAgentId = ensureOptionalString(agentId, "agentId");
  const warningThreshold = ensureThreshold(budgetWarningThreshold, "budgetWarningThreshold");
  const tasks = ensureArray(normalizedSnapshot.tasks ?? [], "snapshot.tasks").map(parseTaskRecord);
  const agents = ensureArray(normalizedSnapshot.agents ?? [], "snapshot.agents").map(parseAgentEntity);
  const allRuns = ensureArray(normalizedSnapshot.runs ?? [], "snapshot.runs").map(parseRunRecord);
  const runs = allRuns.filter((run) =>
    (!normalizedTaskId || run.task_id === normalizedTaskId)
    && (!normalizedAgentId || run.agent_id === normalizedAgentId));
  const scopedTaskIds = deriveScopedTaskIds({
    agentId: normalizedAgentId,
    runs,
    taskId: normalizedTaskId,
    tasks,
  });
  const scopedTasks = tasks.filter((task) => scopedTaskIds.size === 0 || scopedTaskIds.has(task.id));
  const tasksById = new Map(scopedTasks.map((task) => [task.id, task]));
  const scopedAgents = deriveRelevantAgents({
    agentId: normalizedAgentId,
    agents,
    runs,
    taskIds: scopedTaskIds,
    tasks: scopedTasks,
  });
  const runIds = new Set(runs.map((run) => run.id));
  const events = ensureArray(normalizedSnapshot.events ?? [], "snapshot.events")
    .map(parseEventLogEntry)
    .filter((event) =>
      (scopedTaskIds.size === 0 || scopedTaskIds.has(event.task_id))
      || runIds.has(event.run_id));
  const queueWrites = ensureArray(normalizedSnapshot.queueWrites ?? [], "snapshot.queueWrites")
    .map(parseQueueItem);
  const taskRuns = groupBy(runs, (run) => run.task_id);
  const perTaskCost = buildPerTaskCostView(taskRuns, tasksById);
  const perAgentCost = buildPerAgentCostView({
    agents: scopedAgents,
    runs,
    warningThreshold,
  });

  return Object.freeze({
    budget: buildBudgetMetrics({
      agents: scopedAgents,
      warningThreshold,
    }),
    cost: {
      per_agent: perAgentCost,
      per_task: perTaskCost,
      project: buildProjectCostSummary({
        agents: scopedAgents,
        perAgentCost,
        perTaskCost,
        runs,
      }),
    },
    failures: buildFailureMetrics(events),
    queue: buildQueueMetrics({
      now,
      queueWrites,
      scopedTaskIds,
    }),
    retries: buildRetryMetrics(taskRuns),
    scope: Object.freeze({
      agent_id: normalizedAgentId,
      project_id: "local",
      task_id: normalizedTaskId,
    }),
    success: buildTaskSuccessMetrics({
      runs,
      taskIdGroups: taskRuns,
    }),
    timing: buildTimeMetrics(taskRuns),
  });
}

export {
  MetricsViewError,
  buildOperationalMetricsView,
  summarizeBudgetWindow,
};
