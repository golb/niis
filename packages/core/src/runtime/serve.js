import fs from "node:fs";
import path from "node:path";
import {
  assertAdapterImplementation,
  runAdapterDiagnostics,
  serializeAdapterSession,
} from "../contracts/adapter.js";
import { assertStorageImplementation } from "../contracts/storage.js";
import {
  buildOperationalMetricsView,
  emitLiveEventBatch,
  normalizeLiveEventSink,
  summarizeBudgetWindow,
} from "../observability/index.js";
import { buildRoutePlan, executeRoutePlan } from "../routing/index.js";
import { createAssignmentReasonRecord, normalizeQueueForScheduling } from "../scheduler/scheduler.js";
import {
  acquireTaskExecutionLock,
  createConcurrencyPolicy,
  registerExecutionTrigger,
  releaseTaskLock,
} from "../scheduler/lock.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import { claimNextAutoPickup, createWatchConfig, runWatchLoopTick } from "../scheduler/watch.js";
import { parseAgentEntity } from "../schemas/agent.js";
import { parseAssignmentReason } from "../schemas/assignment.js";
import { parseBlockerArtifact } from "../schemas/blocker.js";
import { parseCheckpoint } from "../schemas/checkpoint.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { parseTaskIngressRecord } from "../schemas/ingress.js";
import { parseRunRecord } from "../schemas/run.js";
import { parseTaskContentRevision } from "../schemas/task-content-revision.js";
import { parseTaskLiveExcerpt } from "../schemas/task-live-excerpt.js";
import { parseTaskRunEvent } from "../schemas/task-run-event.js";
import { parseTaskRunSession } from "../schemas/task-run-session.js";
import { parseTaskSession } from "../schemas/task-session.js";
import { parseTaskRecord } from "../schemas/task.js";
import { assertTransitionAuthority } from "../state/authority.js";
import { transitionTask } from "../state/task-machine.js";
import { listBackups, materializeAgentEnvConfig, performBackup } from "../storage/index.js";
import {
  createFailureArtifacts,
  createFailurePolicy,
  detectStalledRuns,
  evaluateSelfHealing,
  normalizeFailure,
  reconcileOrphanedRuns,
} from "./failure.js";
import { validateWorkspaceRoot } from "./path-safety.js";
import { createResumePlan, restoreTaskSession } from "./resume.js";
import { createRetryPolicy, planRetryAttempt } from "./retry.js";
import {
  cleanupWorkspace,
  createWorkspacePlan,
  materializeWorkspace,
  runWorkspaceHook,
} from "./workspace.js";

class ServeRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ServeRuntimeError";
  }
}

const SERVE_RUNTIME_TASK_ID = "runtime:serve";
const DEFAULT_PERIODIC_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ASSET_HEALTH_REPORT_PATH = path.join(
  ".niis",
  "proofs",
  "evals",
  "proof-regression-suite.asset-health.json",
);
const SERVE_TICK_ORDER = Object.freeze([
  "reconcile",
  "validate",
  "fetch",
  "sort",
  "dispatch",
  "notify",
]);

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ServeRuntimeError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServeRuntimeError(`${label} must be a plain object`);
  }

  return value;
}

function ensureUnitInterval(value, label) {
  if (value === undefined || value === null) {
    return 0.8;
  }

  const normalizedValue = Number(value);

  if (Number.isNaN(normalizedValue) || normalizedValue < 0 || normalizedValue > 1) {
    throw new ServeRuntimeError(`${label} must be between 0 and 1`);
  }

  return normalizedValue;
}

function ensurePositiveInteger(value, label, defaultValue = null) {
  if (value === undefined || value === null) {
    if (defaultValue !== null) {
      return defaultValue;
    }

    throw new ServeRuntimeError(`${label} must be a positive integer`);
  }

  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    throw new ServeRuntimeError(`${label} must be a positive integer`);
  }

  return normalizedValue;
}

function ensureStringArray(value, label) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new ServeRuntimeError(`${label} must be an array`);
  }

  return value.map((entry, index) => ensureNonEmptyString(entry, `${label}[${index}]`));
}

function ensureAssetHealthAssetArray(value, label) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new ServeRuntimeError(`${label} must be an array`);
  }

  return value.map((entry, index) => {
    const normalizedEntry = ensurePlainObject(entry, `${label}[${index}]`);

    return Object.freeze({
      asset_id: ensureNonEmptyString(
        normalizedEntry.asset_id ?? normalizedEntry.assetId,
        `${label}[${index}].asset_id`,
      ),
      asset_kind: ensureNonEmptyString(
        normalizedEntry.asset_kind ?? normalizedEntry.assetKind,
        `${label}[${index}].asset_kind`,
      ),
    });
  });
}

function clone(value) {
  return structuredClone(value);
}

function normalizeSecretHandlingConfig(secretHandling = {}) {
  const normalizedSecretHandling = ensurePlainObject(secretHandling, "secretHandling");
  const plaintextPersistence =
    normalizedSecretHandling.plaintext_persistence
    ?? normalizedSecretHandling.plaintextPersistence
    ?? "reject";

  if (!["reject", "allow"].includes(plaintextPersistence)) {
    throw new ServeRuntimeError(
      "secretHandling.plaintext_persistence must be either reject or allow",
    );
  }

  return Object.freeze({
    plaintext_persistence: plaintextPersistence,
  });
}

function normalizeSecretStore(secretStore) {
  if (secretStore === undefined || secretStore === null) {
    return null;
  }

  if (typeof secretStore === "function") {
    return secretStore;
  }

  if (typeof secretStore === "object" && !Array.isArray(secretStore)) {
    if (typeof secretStore.resolve === "function") {
      return (secretRef) => secretStore.resolve(secretRef);
    }

    if (typeof secretStore.getSecret === "function") {
      return (secretRef) => secretStore.getSecret(secretRef);
    }

    return secretStore;
  }

  throw new ServeRuntimeError("secretStore must be a function or plain object");
}

function normalizeBackupRuntime(backupRuntime) {
  if (backupRuntime === undefined || backupRuntime === null) {
    return null;
  }

  const normalizedBackupRuntime = ensurePlainObject(backupRuntime, "backupRuntime");
  const stateRoot = ensureNonEmptyString(
    normalizedBackupRuntime.stateRoot ?? normalizedBackupRuntime.state_root,
    "backupRuntime.stateRoot",
  );
  const intervalMs = ensurePositiveInteger(
    normalizedBackupRuntime.intervalMs ?? normalizedBackupRuntime.interval_ms,
    "backupRuntime.intervalMs",
    DEFAULT_PERIODIC_BACKUP_INTERVAL_MS,
  );

  return Object.freeze({
    interval_ms: intervalMs,
    listBackups:
      typeof normalizedBackupRuntime.listBackups === "function"
        ? () => normalizedBackupRuntime.listBackups()
        : () => listBackups(stateRoot),
    performBackup:
      typeof normalizedBackupRuntime.performBackup === "function"
        ? (options) => normalizedBackupRuntime.performBackup(options)
        : (options) => performBackup(stateRoot, options),
    state_root: stateRoot,
  });
}

function createServeEvent({
  runId,
  eventType,
  actor = "runtime",
  taskId = SERVE_RUNTIME_TASK_ID,
  now = new Date(),
  payload = {},
  suffix = eventType.toLowerCase(),
}) {
  const timestamp = toIsoTimestamp(now, "now");

  return parseEventLogEntry({
    actor,
    event_type: eventType,
    id: `${runId}:${suffix}:${timestamp}`,
    payload,
    run_id: runId,
    task_id: taskId,
    timestamp,
  });
}

function createServeLifecycleEvent({
  runId,
  taskId,
  lifecyclePhase,
  phaseStatus = "completed",
  summary,
  now = new Date(),
  actor = "runtime",
  payload = {},
}) {
  return createServeEvent({
    actor,
    eventType: "STATE_CHANGE",
    now,
    payload: {
      ...payload,
      lifecycle_phase: lifecyclePhase,
      phase_status: phaseStatus,
      summary,
    },
    runId,
    suffix: `${lifecyclePhase}-${phaseStatus}`,
    taskId,
  });
}

function createServeExplainability({
  runId,
  routeChosen,
  summary,
  taskId = SERVE_RUNTIME_TASK_ID,
  decisionType = "GATE",
  policyRefs = ["runtime/serve/v1"],
  evidenceRefs = [],
  now = new Date(),
}) {
  const timestamp = toIsoTimestamp(now, "now");

  return parseExplainabilityRecord({
    alternatives_considered: [],
    decision_type: decisionType,
    evidence_refs: evidenceRefs.length > 0 ? evidenceRefs : [runId],
    human_readable_summary: summary,
    id: `${runId}:explain:${timestamp}`,
    policy_refs: policyRefs,
    route_chosen: routeChosen,
    task_id: taskId,
    timestamp,
  });
}

function createServeBlocker({
  taskId = SERVE_RUNTIME_TASK_ID,
  blockerClass = "ENV_BLOCK",
  reason,
  nextAction,
  now = new Date(),
  suffix = "serve",
  idOverride = null,
  resolvedAt = null,
}) {
  const timestamp = toIsoTimestamp(now, "now");

  return parseBlockerArtifact({
    blocker_class: blockerClass,
    created_at: timestamp,
    id: idOverride ?? `${taskId}:${suffix}:${timestamp}`,
    next_action: ensureNonEmptyString(nextAction, "nextAction"),
    reason: ensureNonEmptyString(reason, "reason"),
    resolved_at: resolvedAt ? toIsoTimestamp(resolvedAt, "resolvedAt") : null,
    task_id: taskId,
  });
}

function resolveExistingBlocker(blocker, resolvedAt = new Date()) {
  const normalizedBlocker = parseBlockerArtifact(blocker);
  return parseBlockerArtifact({
    ...normalizedBlocker,
    resolved_at: toIsoTimestamp(resolvedAt, "resolvedAt"),
  });
}

function formatUsd(value) {
  const normalizedValue = Number(value ?? 0);
  return Number.isFinite(normalizedValue) ? normalizedValue.toFixed(2) : "0.00";
}

function summarizeAgentBudget(agent, warningThreshold) {
  const normalizedAgent = parseAgentEntity(agent);
  return summarizeBudgetWindow({
    limitUsd: normalizedAgent.budget_monthly?.limit_usd ?? null,
    spentUsd: normalizedAgent.budget_monthly?.spent_usd ?? null,
    warningThreshold,
  });
}

function createAgentPauseBlockerId(agentId, reason) {
  return `${SERVE_RUNTIME_TASK_ID}:agent:${agentId}:paused:${reason}`;
}

function describePausedAgent(agent, warningThreshold) {
  const normalizedAgent = parseAgentEntity(agent);
  const pauseReason = normalizedAgent.pause_condition?.reason ?? normalizedAgent.status.toLowerCase();

  if (pauseReason === "budget_exhausted") {
    const budget = summarizeAgentBudget(normalizedAgent, warningThreshold);
    return {
      next_action:
        "Increase or reset the monthly budget, or switch the serve loop to another agent before dispatch resumes.",
      reason:
        `Agent ${normalizedAgent.id} exhausted its monthly budget `
        + `(${formatUsd(budget.budget_spent_usd)} / ${formatUsd(budget.budget_limit_usd)} USD), `
        + "so serve dispatch is paused.",
      route_chosen: "serve:skip-dispatch:budget-exhausted",
    };
  }

  if (pauseReason === "error_threshold") {
    return {
      next_action: "Stabilize the agent health state or clear the pause condition before dispatch resumes.",
      reason: `Agent ${normalizedAgent.id} is paused because its error threshold is active.`,
      route_chosen: "serve:skip-dispatch:error-threshold",
    };
  }

  if (pauseReason === "operator_manual") {
    return {
      next_action: "Resume the agent explicitly when you want the serve loop to dispatch work again.",
      reason: `Agent ${normalizedAgent.id} is manually paused by the operator.`,
      route_chosen: "serve:skip-dispatch:operator-manual",
    };
  }

  return {
    next_action: "Clear the agent pause condition before dispatch resumes.",
    reason: `Agent ${normalizedAgent.id} is paused (${pauseReason}).`,
    route_chosen: "serve:skip-dispatch:paused",
  };
}

function createAgentPauseBlocker({
  agent,
  now = new Date(),
  resolvedAt = null,
  warningThreshold,
} = {}) {
  const normalizedAgent = parseAgentEntity(agent);
  const pauseReason = normalizedAgent.pause_condition?.reason ?? normalizedAgent.status.toLowerCase();
  const description = describePausedAgent(normalizedAgent, warningThreshold);

  return createServeBlocker({
    idOverride: createAgentPauseBlockerId(normalizedAgent.id, pauseReason),
    nextAction: description.next_action,
    now,
    reason: description.reason,
    resolvedAt,
    suffix: `agent-${normalizedAgent.id}-paused`,
  });
}

function createBudgetDecisionArtifacts({
  agent,
  previousAlertLevel,
  nextAlertLevel,
  persistedRunRecord = null,
  now = new Date(),
  warningThreshold,
} = {}) {
  const normalizedAgent = parseAgentEntity(agent);
  const budget = summarizeAgentBudget(normalizedAgent, warningThreshold);
  const runId = persistedRunRecord
    ? `serve:budget:${normalizedAgent.id}:${persistedRunRecord.id}`
    : `serve:budget:${normalizedAgent.id}`;
  const evidenceRefs = persistedRunRecord ? [persistedRunRecord.id] : [normalizedAgent.id];

  if (nextAlertLevel === "critical" && previousAlertLevel !== "critical") {
    return {
      blockers: [
        createAgentPauseBlocker({
          agent: normalizedAgent,
          now,
          warningThreshold,
        }),
      ],
      events: [
        createServeEvent({
          eventType: "POLICY_DECISION",
          now,
          payload: {
            action: "auto_pause",
            agent_id: normalizedAgent.id,
            alert_level: nextAlertLevel,
            budget_limit_usd: budget.budget_limit_usd,
            budget_spent_usd: budget.budget_spent_usd,
            task_id: persistedRunRecord?.task_id ?? null,
          },
          runId,
          suffix: "budget-exhausted",
        }),
      ],
      explainability: [
        createServeExplainability({
          decisionType: "GATE",
          evidenceRefs,
          now,
          routeChosen: "agent:budget-exhausted",
          summary:
            `Agent ${normalizedAgent.id} crossed its monthly budget cap `
            + `(${formatUsd(budget.budget_spent_usd)} / ${formatUsd(budget.budget_limit_usd)} USD) `
            + "and was auto-paused before further dispatch.",
        }),
      ],
    };
  }

  if (nextAlertLevel === "warning" && previousAlertLevel !== "warning" && previousAlertLevel !== "critical") {
    return {
      blockers: [],
      events: [
        createServeEvent({
          eventType: "POLICY_DECISION",
          now,
          payload: {
            action: "budget_warning",
            agent_id: normalizedAgent.id,
            alert_level: nextAlertLevel,
            budget_limit_usd: budget.budget_limit_usd,
            budget_spent_usd: budget.budget_spent_usd,
            task_id: persistedRunRecord?.task_id ?? null,
          },
          runId,
          suffix: "budget-warning",
        }),
      ],
      explainability: [
        createServeExplainability({
          decisionType: "GATE",
          evidenceRefs,
          now,
          routeChosen: "agent:budget-warning",
          summary:
            `Agent ${normalizedAgent.id} crossed the budget warning threshold `
            + `(${formatUsd(budget.budget_spent_usd)} / ${formatUsd(budget.budget_limit_usd)} USD). `
            + "Serve remains active, but budget headroom is now low.",
        }),
      ],
    };
  }

  return {
    blockers: [],
    events: [],
    explainability: [],
  };
}

function mergeQueueItem(queueItems, queueItem) {
  if (!queueItem) {
    return queueItems;
  }

  const withoutTask = queueItems.filter((entry) => entry.task_id !== queueItem.task_id);
  return normalizeQueueForScheduling([...withoutTask, queueItem], queueItem.queued_at);
}

function updateIngressStatusForTask(ingressRecords, taskId, ingressStatus) {
  const sourceRef = `task:${taskId}`;
  let updated = false;

  const nextIngressRecords = ingressRecords.map((ingressRecord) => {
    if (ingressRecord.source_ref !== sourceRef) {
      return ingressRecord;
    }

    updated = true;

    return parseTaskIngressRecord({
      ...ingressRecord,
      ingress_status: ingressStatus,
    });
  });

  return {
    updated,
    ingressRecords: nextIngressRecords,
  };
}

function getRetryStateBucket(retryState, taskId) {
  return retryState[taskId] ?? {
    activeToken: null,
    continuationAttempts: 0,
    failureAttempts: 0,
    failureHistory: [],
  };
}

function createServeState({
  currentConfig,
  watchState = {},
  leases = [],
  activeRuns = [],
  recoveryAttempts = {},
  retryPlans = [],
  retryState = {},
  checkpointIdsByRunId = {},
  incidentMode = null,
} = {}) {
  return {
    activeRuns: clone(activeRuns),
    checkpointIdsByRunId: { ...checkpointIdsByRunId },
    currentConfig,
    incidentMode: incidentMode ? clone(incidentMode) : null,
    leases: clone(leases),
    recoveryAttempts: { ...recoveryAttempts },
    retryPlans: clone(retryPlans),
    retryState: clone(retryState),
    watchState: {
      deferredWakeups: clone(watchState.deferredWakeups ?? []),
      ingressRecords: clone(watchState.ingressRecords ?? []),
      queueItems: clone(watchState.queueItems ?? []),
      wakeRecords: clone(watchState.wakeRecords ?? []),
    },
  };
}

function createServeConfig({
  storage,
  adapters,
  watchConfig,
  agentId,
  workspace,
  bootstrapContext = {},
  roleManifests = [],
  routingPolicy = {},
  referenceBundle = {},
  runtimeTools = [],
  grantedApprovals = [],
  grantedAuthorities = [],
  confirmationThreshold = 1,
  maxTurns = 3,
  leaseTtlMs = 5 * 60 * 1000,
  claimTtlMs = 5 * 60 * 1000,
  retryPolicy = {},
  failurePolicy = {},
  concurrencyPolicy = {},
  loadWatchConfig = null,
  evaluatePauseCondition = null,
  budgetWarningThreshold = 0.8,
  backupRuntime = null,
  checkpointsByTaskId = {},
  liveEventSink = null,
  secretHandling = {},
  secretStore = null,
} = {}) {
  assertStorageImplementation(storage);

  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new ServeRuntimeError("adapters must be a non-empty array");
  }

  const normalizedAdapters = adapters.map((adapter) => assertAdapterImplementation(adapter));
  const normalizedWorkspace = ensurePlainObject(workspace, "workspace");
  const workspaceRoot = validateWorkspaceRoot(normalizedWorkspace.root);

  return Object.freeze({
    adapters: normalizedAdapters,
    agentId: ensureNonEmptyString(agentId, "agentId"),
    backupRuntime: normalizeBackupRuntime(backupRuntime),
    bootstrapContext: ensurePlainObject(bootstrapContext, "bootstrapContext"),
    budgetWarningThreshold: ensureUnitInterval(budgetWarningThreshold, "budgetWarningThreshold"),
    checkpointsByTaskId: clone(checkpointsByTaskId),
    claimTtlMs,
    concurrencyPolicy: createConcurrencyPolicy(concurrencyPolicy),
    confirmationThreshold,
    evaluatePauseCondition:
      typeof evaluatePauseCondition === "function" ? evaluatePauseCondition : null,
    failurePolicy: createFailurePolicy(failurePolicy),
    grantedApprovals: [...grantedApprovals],
    grantedAuthorities: [...grantedAuthorities],
    leaseTtlMs,
    loadWatchConfig: typeof loadWatchConfig === "function" ? loadWatchConfig : null,
    maxTurns,
    liveEventSink: normalizeLiveEventSink(liveEventSink),
    referenceBundle: clone(referenceBundle),
    retryPolicy: createRetryPolicy(retryPolicy),
    roleManifests: clone(roleManifests),
    routingPolicy: clone(routingPolicy),
    runtimeTools: clone(runtimeTools),
    secretHandling: normalizeSecretHandlingConfig(secretHandling),
    secretStore: normalizeSecretStore(secretStore),
    storage,
    watchConfig: createWatchConfig(watchConfig),
    workspace: Object.freeze({
      ...clone(normalizedWorkspace),
      projectPrimary: normalizedWorkspace.projectPrimary ?? workspaceRoot,
      root: workspaceRoot,
    }),
  });
}

async function persistServeArtifacts(
  storage,
  { events = [], explainability = [], blockers = [] },
  { liveEventSink = null } = {},
) {
  const normalizedEvents = events.filter(Boolean);

  for (const event of normalizedEvents) {
    await storage.events.append(event);
  }

  await emitLiveEventBatch(liveEventSink, normalizedEvents);

  for (const record of explainability.filter(Boolean)) {
    await storage.explainability.record(record);
  }

  for (const blocker of blockers.filter(Boolean)) {
    await storage.blockers.upsert(blocker);
  }
}

async function validateServeStartup(config, now = new Date()) {
  const diagnostics = [];
  const agent = await config.storage.agents.byId(config.agentId);

  if (!agent) {
    throw new ServeRuntimeError(`agent ${config.agentId} is missing from storage`);
  }

  parseAgentEntity(agent);
  const agentEnvConfig = materializeAgentEnvConfig(agent, {
    plaintextPersistence: config.secretHandling.plaintext_persistence,
  });

  for (const adapter of config.adapters) {
    const result = await runAdapterDiagnostics({
      adapter,
      config: agentEnvConfig,
      runtimeContext: {
        agent_id: config.agentId,
        startup_validation: true,
      },
      secretStore: config.secretStore,
    });

    if (result.ok === false) {
      const failedChecks = result.checks
        .filter((check) => check.status === "FAIL")
        .map((check) => `${check.name}: ${check.message}`)
        .join("; ");
      throw new ServeRuntimeError(
        `adapter startup diagnostics failed for ${adapter.id}${failedChecks ? ` (${failedChecks})` : ""}`,
      );
    }

    diagnostics.push({
      adapter_id: adapter.id,
      checks: result.checks,
      ok: result.ok,
    });
  }

  const event = createServeEvent({
    runId: "serve:startup",
    eventType: "STATE_CHANGE",
    now,
    payload: {
      adapters: config.adapters.map((adapter) => adapter.id),
      agent_id: config.agentId,
      workspace_root: config.workspace.root,
    },
    suffix: "startup",
  });
  const explainability = createServeExplainability({
    runId: "serve:startup",
    routeChosen: "serve:start",
    summary: `Serve startup validation passed for agent ${config.agentId}.`,
    now,
  });

  await persistServeArtifacts(config.storage, {
    events: [event],
    explainability: [explainability],
  }, {
    liveEventSink: config.liveEventSink,
  });

  return {
    diagnostics,
    event,
    explainability,
  };
}

function normalizeAssetHealthGatePolicy(routingPolicy = {}, workspaceRoot) {
  const normalizedRoutingPolicy = ensurePlainObject(routingPolicy, "routingPolicy");
  const gateInput =
    normalizedRoutingPolicy.asset_health_gate
    ?? normalizedRoutingPolicy.assetHealthGate
    ?? null;

  if (!gateInput) {
    return Object.freeze({
      additional_assets: Object.freeze([]),
      asset_kind: "agent",
      blocked_statuses: Object.freeze(["failing"]),
      enabled: false,
      report_path: path.resolve(workspaceRoot, DEFAULT_ASSET_HEALTH_REPORT_PATH),
      warned_statuses: Object.freeze(["watch"]),
    });
  }

  const normalizedGate = ensurePlainObject(gateInput, "routingPolicy.asset_health_gate");

  return Object.freeze({
    additional_assets: Object.freeze(
      ensureAssetHealthAssetArray(
        normalizedGate.additional_assets ?? normalizedGate.additionalAssets ?? [],
        "routingPolicy.asset_health_gate.additional_assets",
      ),
    ),
    asset_kind: ensureNonEmptyString(
      normalizedGate.asset_kind ?? normalizedGate.assetKind ?? "agent",
      "routingPolicy.asset_health_gate.asset_kind",
    ),
    blocked_statuses: Object.freeze(
      ensureStringArray(
        normalizedGate.blocked_statuses ?? normalizedGate.blockedStatuses ?? ["failing"],
        "routingPolicy.asset_health_gate.blocked_statuses",
      ),
    ),
    enabled: Boolean(normalizedGate.enabled ?? true),
    report_path: path.resolve(
      workspaceRoot,
      normalizedGate.report_path ?? normalizedGate.reportPath ?? DEFAULT_ASSET_HEALTH_REPORT_PATH,
    ),
    warned_statuses: Object.freeze(
      ensureStringArray(
        normalizedGate.warned_statuses ?? normalizedGate.warnedStatuses ?? ["watch"],
        "routingPolicy.asset_health_gate.warned_statuses",
      ),
    ),
  });
}

function evaluateAssetHealthGate({
  routingPolicy = {},
  workspaceRoot,
  assetId,
  additionalAssets = [],
} = {}) {
  const gatePolicy = normalizeAssetHealthGatePolicy(routingPolicy, workspaceRoot);

  if (!gatePolicy.enabled) {
    return Object.freeze({
      blocked: false,
      gate_policy: gatePolicy,
      matched_asset: null,
    });
  }

  if (!fs.existsSync(gatePolicy.report_path)) {
    throw new ServeRuntimeError(
      `asset health gate report is missing at ${gatePolicy.report_path}`,
    );
  }

  let report;

  try {
    report = JSON.parse(fs.readFileSync(gatePolicy.report_path, "utf8"));
  } catch (error) {
    throw new ServeRuntimeError(
      `asset health gate report at ${gatePolicy.report_path} is unreadable: ${error.message}`,
    );
  }

  const assets = Array.isArray(report.assets) ? report.assets : [];
  const monitoredAssets = [
    {
      asset_id: assetId,
      asset_kind: gatePolicy.asset_kind,
    },
    ...gatePolicy.additional_assets,
    ...ensureAssetHealthAssetArray(additionalAssets, "additionalAssets"),
  ].filter((entry) => entry.asset_id && entry.asset_kind);
  const monitoredKeys = new Set(
    monitoredAssets.map((entry) => `${entry.asset_kind}:${entry.asset_id}`),
  );
  const matchedAssets = assets.filter((asset) =>
    monitoredKeys.has(`${asset?.asset_kind}:${asset?.asset_id}`),
  );
  const blockedAssets = matchedAssets.filter((asset) =>
    gatePolicy.blocked_statuses.includes(asset.status),
  );
  const warnedAssets = matchedAssets.filter((asset) =>
    gatePolicy.warned_statuses.includes(asset.status),
  );

  return Object.freeze({
    blocked: blockedAssets.length > 0,
    blocked_assets: Object.freeze(blockedAssets),
    gate_policy: gatePolicy,
    matched_assets: Object.freeze(matchedAssets),
    warned: warnedAssets.length > 0,
    warned_assets: Object.freeze(warnedAssets),
  });
}

function createPerTickValidationResult({
  ok,
  blocker = null,
  explainability = null,
}) {
  return {
    blocker,
    explainability,
    ok,
  };
}

async function transitionTaskToBlocked(storage, task, reason, now = new Date()) {
  assertTransitionAuthority({
    actorRole: "validator",
    fromStatus: task.status,
    toStatus: "BLOCKED",
  });

  const transition = transitionTask(task, {
    actor: "validator",
    reason: ensureNonEmptyString(reason, "reason"),
    timestamp: toIsoTimestamp(now, "now"),
    toStatus: "BLOCKED",
  });

  await storage.tasks.upsert(transition.task);
  return transition.task;
}

async function validateServeTick(config, now = new Date()) {
  try {
    validateWorkspaceRoot(config.workspace.root);
    createWatchConfig(config.currentConfig ?? config.watchConfig);
    const agent = await config.storage.agents.byId(config.agentId);

    if (!agent) {
      throw new ServeRuntimeError(`agent ${config.agentId} is missing from storage`);
    }

    const normalizedAgent = parseAgentEntity(agent);

    if (normalizedAgent.status !== "ACTIVE") {
      const pausedDescription = describePausedAgent(normalizedAgent, config.budgetWarningThreshold);

      return createPerTickValidationResult({
        blocker: createAgentPauseBlocker({
          agent: normalizedAgent,
          now,
          warningThreshold: config.budgetWarningThreshold,
        }),
        explainability: createServeExplainability({
          evidenceRefs: [normalizedAgent.id],
          now,
          routeChosen: pausedDescription.route_chosen,
          summary: `${pausedDescription.reason} Dispatch stays skipped until the pause condition is cleared.`,
        }),
        ok: false,
      });
    }

    const assetHealthGate = evaluateAssetHealthGate({
      assetId: normalizedAgent.id,
      routingPolicy: config.routingPolicy,
      workspaceRoot: config.workspace.root,
    });

    if (assetHealthGate.blocked) {
      const blockedAssetSummary = assetHealthGate.blocked_assets
        .map((asset) => `${asset.asset_kind}:${asset.asset_id}=${asset.status}`)
        .join(", ");

      return createPerTickValidationResult({
        blocker: createServeBlocker({
          reason:
            `Asset-health gate reported blocking status for ${blockedAssetSummary}, `
            + "so serve dispatch is paused.",
          nextAction:
            "Refresh regression evidence or override the asset-health gate before dispatch resumes.",
          now,
          suffix: `agent-${normalizedAgent.id}-asset-health`,
        }),
        explainability: createServeExplainability({
          evidenceRefs: [
            normalizedAgent.id,
            ...assetHealthGate.blocked_assets.map((asset) => `${asset.asset_kind}:${asset.asset_id}`),
            assetHealthGate.gate_policy.report_path,
          ],
          now,
          routeChosen: "serve:skip-dispatch:asset-health",
          summary:
            `Serve dispatch skipped because the asset-health gate reported blocking status for `
            + `${blockedAssetSummary}.`,
        }),
        ok: false,
      });
    }

    if (assetHealthGate.warned) {
      const warnedAssetSummary = assetHealthGate.warned_assets
        .map((asset) => `${asset.asset_kind}:${asset.asset_id}=${asset.status}`)
        .join(", ");

      return createPerTickValidationResult({
        explainability: createServeExplainability({
          evidenceRefs: [
            normalizedAgent.id,
            ...assetHealthGate.warned_assets.map((asset) => `${asset.asset_kind}:${asset.asset_id}`),
            assetHealthGate.gate_policy.report_path,
          ],
          now,
          routeChosen: "serve:allow-dispatch:asset-health-watch",
          summary:
            `Serve dispatch continues, but the asset-health gate reported warning status for `
            + `${warnedAssetSummary}.`,
        }),
        ok: true,
      });
    }

    return createPerTickValidationResult({
      ok: true,
    });
  } catch (error) {
    const blocker = createServeBlocker({
      reason: `Serve tick validation failed: ${error.message}`,
      nextAction:
        "Fix the active workspace root or watch configuration; reconciliation may continue but dispatch is skipped.",
      now,
      suffix: "tick-validation",
    });
    const explainability = createServeExplainability({
      runId: "serve:tick-validation",
      routeChosen: "serve:skip-dispatch",
      summary: `Per-tick validation failed, so the serve loop skipped dispatch while keeping reconciliation alive: ${error.message}`,
      now,
    });

    return createPerTickValidationResult({
      blocker,
      explainability,
      ok: false,
    });
  }
}

function evaluateAutoResume(agent, { now, evaluatePauseCondition = null }) {
  const normalizedAgent = parseAgentEntity(agent);

  if (normalizedAgent.status !== "PAUSED" || !normalizedAgent.pause_condition) {
    return {
      allowed: false,
      reason: "not paused",
    };
  }

  if (normalizedAgent.pause_condition.reason === "operator_manual") {
    return {
      allowed: false,
      reason: "operator manual pause",
    };
  }

  if (!normalizedAgent.pause_condition.auto_resume_eligible) {
    return {
      allowed: false,
      reason: "auto resume disabled",
    };
  }

  if (
    normalizedAgent.pause_condition.cleared_at &&
    Date.parse(normalizedAgent.pause_condition.cleared_at) <= Date.parse(toIsoTimestamp(now, "now"))
  ) {
    return {
      allowed: true,
      reason: "pause condition explicitly cleared",
    };
  }

  if (typeof evaluatePauseCondition === "function") {
    const evaluated = evaluatePauseCondition({
      agent: normalizedAgent,
      now,
    });

    if (evaluated && evaluated.active === false) {
      return {
        allowed: true,
        reason: evaluated.reason ?? "custom pause evaluation cleared the condition",
      };
    }

    return {
      allowed: false,
      reason: evaluated?.reason ?? "custom pause evaluation kept the condition active",
    };
  }

  if (
    normalizedAgent.pause_condition.reason === "budget_exhausted" &&
    normalizedAgent.budget_monthly &&
    normalizedAgent.budget_monthly.spent_usd < normalizedAgent.budget_monthly.limit_usd
  ) {
    return {
      allowed: true,
      reason: "monthly budget is below the cap again",
    };
  }

  if (
    normalizedAgent.pause_condition.reason === "error_threshold" &&
    normalizedAgent.health_status !== "error"
  ) {
    return {
      allowed: true,
      reason: "agent health is no longer in the error state",
    };
  }

  return {
    allowed: false,
    reason: "pause condition remains active",
  };
}

async function reconcileAutoResume(config, now = new Date()) {
  const agents = await config.storage.agents.list();
  const resumedAgents = [];
  const events = [];
  const explainability = [];
  const assignments = [];
  const resolvedBlockers = [];

  for (const agentRecord of agents) {
    const normalizedAgent = parseAgentEntity(agentRecord);
    const autoResume = evaluateAutoResume(normalizedAgent, {
      evaluatePauseCondition: config.evaluatePauseCondition,
      now,
    });

    if (!autoResume.allowed) {
      continue;
    }

    const resumedAgent = await config.storage.agents.updateStatus(normalizedAgent.id, {
      last_run_at: toIsoTimestamp(now, "now"),
      pause_condition: null,
      status: "ACTIVE",
    });
    const assignment = createAssignmentReasonRecord({
      agentId: normalizedAgent.id,
      context: `Serve reconciliation auto-resumed paused agent ${normalizedAgent.id}: ${autoResume.reason}`,
      policyRef: "runtime/agent-auto-resume/v1",
      reasonType: "retry",
      taskId: SERVE_RUNTIME_TASK_ID,
      timestamp: toIsoTimestamp(now, "now"),
    });

    resumedAgents.push(resumedAgent);
    assignments.push(assignment);
    resolvedBlockers.push(
      createAgentPauseBlocker({
        agent: normalizedAgent,
        now,
        resolvedAt: now,
        warningThreshold: config.budgetWarningThreshold,
      }),
    );
    events.push(
      createServeEvent({
        runId: `serve:auto-resume:${normalizedAgent.id}`,
        eventType: "POLICY_DECISION",
        now,
        payload: {
          agent_id: normalizedAgent.id,
          previous_status: normalizedAgent.status,
          reason: autoResume.reason,
          resumed_status: "ACTIVE",
        },
        suffix: "auto-resume",
      }),
    );
    explainability.push(
      createServeExplainability({
        runId: `serve:auto-resume:${normalizedAgent.id}`,
        routeChosen: "agent:auto-resume",
        summary: `Agent ${normalizedAgent.id} moved PAUSED -> ACTIVE because the pause condition cleared: ${autoResume.reason}.`,
        decisionType: "ASSIGNMENT",
        now,
      }),
    );
  }

  for (const assignment of assignments) {
    await config.storage.assignments.record(assignment);
  }

  await persistServeArtifacts(config.storage, {
    blockers: resolvedBlockers,
    events,
    explainability,
  }, {
    liveEventSink: config.liveEventSink,
  });

  return {
    assignments,
    events,
    explainability,
    resumedAgents,
  };
}

async function reconcileBudgetEnforcement(config, now = new Date()) {
  const agentRecord = await config.storage.agents.byId(config.agentId);

  if (!agentRecord) {
    throw new ServeRuntimeError(`agent ${config.agentId} is missing from storage`);
  }

  const normalizedAgent = parseAgentEntity(agentRecord);
  const budget = summarizeAgentBudget(normalizedAgent, config.budgetWarningThreshold);

  if (budget.alert_level !== "critical") {
    return {
      blockers: [],
      events: [],
      explainability: [],
    };
  }

  if (
    normalizedAgent.status === "PAUSED"
    && normalizedAgent.pause_condition?.reason === "budget_exhausted"
  ) {
    return {
      blockers: [],
      events: [],
      explainability: [],
    };
  }

  const pausedAgent = await config.storage.agents.updateStatus(normalizedAgent.id, {
    pause_condition: {
      auto_resume_eligible: true,
      cleared_at: null,
      reason: "budget_exhausted",
    },
    status: "PAUSED",
  });
  const artifacts = createBudgetDecisionArtifacts({
    agent: pausedAgent,
    nextAlertLevel: budget.alert_level,
    now,
    previousAlertLevel: normalizedAgent.pause_condition?.reason === "budget_exhausted" ? "critical" : "ok",
    warningThreshold: config.budgetWarningThreshold,
  });

  await persistServeArtifacts(config.storage, artifacts, {
    liveEventSink: config.liveEventSink,
  });

  return artifacts;
}

function createPeriodicBackupBlockerId() {
  return `${SERVE_RUNTIME_TASK_ID}:periodic-backup`;
}

function getLatestBackupCreatedAt(backupRuntime) {
  const backups = backupRuntime.listBackups();
  return backups.length > 0 ? backups.at(-1).created_at : null;
}

async function reconcilePeriodicBackup(config, now = new Date()) {
  if (!config.backupRuntime) {
    return {
      backup: null,
      blockers: [],
      events: [],
      explainability: [],
    };
  }

  const normalizedNow = toIsoTimestamp(now, "now");
  const latestBackupCreatedAt = getLatestBackupCreatedAt(config.backupRuntime);

  if (
    latestBackupCreatedAt
    && (Date.parse(normalizedNow) - Date.parse(latestBackupCreatedAt)) < config.backupRuntime.interval_ms
  ) {
    return {
      backup: null,
      blockers: [],
      events: [],
      explainability: [],
    };
  }

  const activeBackupBlocker = (await config.storage.blockers.active())
    .map(parseBlockerArtifact)
    .find((blocker) => blocker.id === createPeriodicBackupBlockerId()) ?? null;

  try {
    const backup = await config.backupRuntime.performBackup({
      now,
    });
    const events = [
      createServeEvent({
        eventType: "POLICY_DECISION",
        now,
        payload: {
          action: "periodic_backup",
          backup_id: backup.backup_id,
          backup_path: backup.backup_path,
          file_count: backup.manifest.file_count,
          pruned_backup_ids: backup.pruned.map((entry) => entry.backup_id),
          trigger: "serve_reconcile",
        },
        runId: `serve:backup:${backup.backup_id}`,
        suffix: "periodic-backup",
      }),
    ];
    const explainability = [
      createServeExplainability({
        decisionType: "ASSIGNMENT",
        evidenceRefs: [backup.backup_id],
        now,
        routeChosen: "serve:periodic-backup",
        summary:
          `Serve created periodic backup ${backup.backup_id} for local state protection `
          + `(${backup.manifest.file_count} files captured).`,
        runId: `serve:backup:${backup.backup_id}`,
      }),
    ];
    const blockers = activeBackupBlocker
      ? [resolveExistingBlocker(activeBackupBlocker, now)]
      : [];

    await persistServeArtifacts(config.storage, {
      blockers,
      events,
      explainability,
    }, {
      liveEventSink: config.liveEventSink,
    });

    return {
      backup,
      blockers,
      events,
      explainability,
    };
  } catch (error) {
    const blocker = createServeBlocker({
      blockerClass: "ENV_BLOCK",
      idOverride: createPeriodicBackupBlockerId(),
      nextAction:
        "Fix the local backup path/state root or disable periodic backups; once healthy, the serve loop will retry on the next scheduled interval.",
      now,
      reason: `Periodic backup failed: ${error.message}`,
      suffix: "periodic-backup",
    });
    const explainability = createServeExplainability({
      decisionType: "GATE",
      now,
      routeChosen: "serve:periodic-backup-failed",
      summary:
        `Serve attempted a scheduled local backup but it failed: ${error.message}. `
        + "The runtime kept running and left a blocker for operator recovery.",
      runId: "serve:backup:error",
    });

    await persistServeArtifacts(config.storage, {
      blockers: [blocker],
      explainability: [explainability],
    }, {
      liveEventSink: config.liveEventSink,
    });

    return {
      backup: null,
      blockers: [blocker],
      events: [],
      explainability: [explainability],
    };
  }
}

async function reconcileRetryPlans(config, state, now = new Date()) {
  let queueItems = clone(state.watchState.queueItems);
  let deferredWakeups = clone(state.watchState.deferredWakeups);
  const remainingRetryPlans = [];
  const blockers = [];

  for (const retryPlan of state.retryPlans) {
    if (retryPlan.status !== "SCHEDULED" || Date.parse(retryPlan.scheduled_at) > Date.parse(toIsoTimestamp(now, "now"))) {
      remainingRetryPlans.push(retryPlan);
      continue;
    }

    const trigger = registerExecutionTrigger({
      context: {
        retry_mode: retryPlan.retry_mode,
        run_id: retryPlan.run_id,
        token: retryPlan.dispatch_token?.token ?? null,
      },
      deferredWakeups,
      leases: state.leases,
      now,
      priority: null,
      queueItems,
      source: "retry",
      taskId: retryPlan.task_id,
    });

    queueItems = trigger.queueItems;
    deferredWakeups = trigger.deferredWakeups;

    if (trigger.blocker) {
      blockers.push(trigger.blocker);
    }
  }

  await persistServeArtifacts(config.storage, {
    blockers,
  }, {
    liveEventSink: config.liveEventSink,
  });

  return {
    blockers,
    state: {
      ...state,
      retryPlans: remainingRetryPlans,
      watchState: {
        ...state.watchState,
        deferredWakeups,
        queueItems,
      },
    },
  };
}

async function reconcileServeRuntime(config, state, now = new Date()) {
  const periodicBackup = await reconcilePeriodicBackup(config, now);
  const budgetEnforcement = await reconcileBudgetEnforcement(config, now);
  const autoResume = await reconcileAutoResume(config, now);
  const stalledFailures = detectStalledRuns({
    activeRuns: state.activeRuns,
    now,
    stallTimeoutMs: config.failurePolicy.stallTimeoutMs,
  });
  const orphanedRuns = reconcileOrphanedRuns({
    activeRuns: state.activeRuns,
    checkpointIdsByRunId: state.checkpointIdsByRunId,
    leases: state.leases,
    now,
    policy: config.failurePolicy,
    recoveryAttempts: state.recoveryAttempts,
  });
  const selfHealing = evaluateSelfHealing({
    component: "serve",
    crashHistory: [],
    now,
    orphanedRuns,
    policy: config.failurePolicy,
    recoveryAttempts: state.recoveryAttempts,
    stalledFailures,
  });
  const failureArtifacts = stalledFailures.map((failure) =>
    createFailureArtifacts({
      failure,
      now,
    }),
  );

  await persistServeArtifacts(config.storage, {
    blockers: failureArtifacts.map((artifact) => artifact.blocker),
    events: failureArtifacts.map((artifact) => artifact.event),
    explainability: failureArtifacts.map((artifact) => artifact.explainability),
  }, {
    liveEventSink: config.liveEventSink,
  });

  const retryReconciliation = await reconcileRetryPlans(config, state, now);

  return {
    autoResume,
    budgetEnforcement,
    periodicBackup,
    retryReconciliation,
    selfHealing,
    stalledFailures,
    state: {
      ...retryReconciliation.state,
      incidentMode: selfHealing.freeze_dispatch ? selfHealing : null,
    },
  };
}

async function resolveTaskAndAgent(config, taskId) {
  const tasks = await config.storage.tasks.list();
  const task = tasks.map(parseTaskRecord).find((entry) => entry.id === taskId) ?? null;

  if (!task) {
    throw new ServeRuntimeError(`task ${taskId} is missing from storage`);
  }

  const agent = await config.storage.agents.byId(config.agentId);

  if (!agent) {
    throw new ServeRuntimeError(`agent ${config.agentId} is missing from storage`);
  }

  return {
    agent: parseAgentEntity(agent),
    task,
    tasks,
  };
}

async function maybeTransitionTaskToInProgress(storage, task, now = new Date()) {
  if (task.status !== "PENDING") {
    return task;
  }

  assertTransitionAuthority({
    actorRole: "worker",
    fromStatus: task.status,
    toStatus: "IN_PROGRESS",
  });

  const transition = transitionTask(task, {
    actor: "worker",
    reason: "Serve dispatch started route -> run execution.",
    timestamp: toIsoTimestamp(now, "now"),
    toStatus: "IN_PROGRESS",
  });

  const updatedTask = parseTaskRecord({
    ...transition.task,
    assigned_to: task.assigned_to ?? null,
  });
  await storage.tasks.upsert(updatedTask);

  return updatedTask;
}

async function transitionTaskToReview(storage, task, now = new Date()) {
  assertTransitionAuthority({
    actorRole: "worker",
    fromStatus: task.status,
    toStatus: "IN_REVIEW",
  });

  const transition = transitionTask(task, {
    actor: "worker",
    reason: "Serve observed the configured completion-signal threshold and moved the task into review.",
    timestamp: toIsoTimestamp(now, "now"),
    toStatus: "IN_REVIEW",
  });

  await storage.tasks.upsert(transition.task);
  return transition.task;
}

function buildTaskSessionKey({ taskId, agentId, adapterId }) {
  return `${taskId}:${agentId}:${adapterId}`;
}

async function resolveResumeContext(config, routePlan, { task, agent, now }) {
  const taskSessionKey = buildTaskSessionKey({
    adapterId: routePlan.selectedAdapter.id,
    agentId: agent.id,
    taskId: task.id,
  });
  const storedTaskSession = await config.storage.taskSessions.getByKey(taskSessionKey);
  const sessionCodec = routePlan.selectedAdapter.sessionCodec();
  const restoredSession = storedTaskSession
    ? restoreTaskSession({
      sessionCodec,
      taskSession: storedTaskSession,
    })
    : null;
  const checkpoint = config.checkpointsByTaskId[task.id]
    ? parseCheckpoint(config.checkpointsByTaskId[task.id])
    : null;

  if (!checkpoint) {
    return {
      bootstrapContext: config.bootstrapContext,
      invocationSource: "assignment",
      resumeArtifacts: null,
      session: restoredSession?.session_params ?? null,
      taskSessionKey,
    };
  }

  const resumePlan = createResumePlan({
    baseContext: config.bootstrapContext,
    checkpoint,
    now,
    sessionCodec,
    taskId: task.id,
    taskSession: storedTaskSession,
  });

  await config.storage.checkpoints.save(checkpoint);
  await persistServeArtifacts(config.storage, {
    events: [resumePlan.event],
    explainability: [resumePlan.explainability],
  }, {
    liveEventSink: config.liveEventSink,
  });

  return {
    bootstrapContext: {
      ...resumePlan.restored_context,
      ...config.bootstrapContext,
      resume_message: resumePlan.resume_message,
    },
    invocationSource: resumePlan.invocation_source,
    resumeArtifacts: resumePlan,
    session: resumePlan.restored_session?.session_params ?? restoredSession?.session_params ?? null,
    taskSessionKey,
  };
}

async function persistExecutionArtifacts(config, execution, routePlan, { taskSessionKey, agent, now }) {
  const storedRunLog = await config.storage.runLogs.store({
    raw_output: execution.final_response,
    run_id: execution.run_record.id,
    run_log: execution.run_record.run_log,
  });
  const persistedRunRecord = parseRunRecord({
    ...execution.run_record,
    run_log: storedRunLog.run_log,
  });

  await config.storage.runs.upsert(persistedRunRecord);

  await persistServeArtifacts(config.storage, {
    events: execution.runtime_events,
    explainability: execution.explainability ? [execution.explainability] : [],
  }, {
    liveEventSink: config.liveEventSink,
  });

  const taskSession = execution.execution.session;

  if (taskSession && taskSessionKey) {
    const sessionCodec = routePlan.selectedAdapter.sessionCodec();
    const timestamp = toIsoTimestamp(now, "now");

    await config.storage.taskSessions.upsert(parseTaskSession({
      adapter_type: routePlan.selectedAdapter.id,
      agent_id: agent.id,
      created_at: timestamp,
      display_id: taskSession.display_id ?? null,
      last_run_id: persistedRunRecord.id,
      session_params: serializeAdapterSession(sessionCodec, taskSession),
      task_key: taskSessionKey,
      updated_at: timestamp,
    }));
  }

  const previousBudget = summarizeAgentBudget(agent, config.budgetWarningThreshold);
  const costAccumulatedAgent = await config.storage.agents.accumulateCost(agent.id, persistedRunRecord.cost);
  const nextBudget = summarizeAgentBudget(costAccumulatedAgent, config.budgetWarningThreshold);
  const shouldPauseForBudget = nextBudget.alert_level === "critical";
  const updatedAgent = await config.storage.agents.updateStatus(agent.id, {
    health_status: "healthy",
    last_run_at: persistedRunRecord.finished_at,
    last_run_id: persistedRunRecord.id,
    pause_condition: shouldPauseForBudget
      ? {
        auto_resume_eligible: true,
        cleared_at: null,
        reason: "budget_exhausted",
      }
      : null,
    status: shouldPauseForBudget ? "PAUSED" : "ACTIVE",
  });
  const budgetArtifacts = createBudgetDecisionArtifacts({
    agent: updatedAgent,
    nextAlertLevel: nextBudget.alert_level,
    now,
    persistedRunRecord,
    previousAlertLevel: previousBudget.alert_level,
    warningThreshold: config.budgetWarningThreshold,
  });

  await persistServeArtifacts(config.storage, budgetArtifacts, {
    liveEventSink: config.liveEventSink,
  });

  return persistedRunRecord;
}

function scheduleRetry({
  config,
  state,
  taskId,
  runId,
  mode,
  adapterResponse = null,
  failure = null,
  now = new Date(),
  lastAttemptAt = null,
}) {
  const bucket = getRetryStateBucket(state.retryState, taskId);
  const attempt =
    mode === "continuation"
      ? bucket.continuationAttempts + 1
      : bucket.failureAttempts + 1;
  const failureHistory =
    mode === "failure" && failure ? [...bucket.failureHistory, failure] : bucket.failureHistory;
  const retryPlan = planRetryAttempt({
    activeToken: bucket.activeToken,
    adapterResponse,
    attempt,
    failureHistory,
    lastAttemptAt,
    mode,
    now,
    retryPolicy: config.retryPolicy,
    runId,
    taskId,
  });

  return {
    retryPlan,
    retryState: {
      ...state.retryState,
      [taskId]: {
        activeToken: retryPlan.dispatch_token ?? bucket.activeToken,
        continuationAttempts:
          mode === "continuation" && retryPlan.status === "SCHEDULED"
            ? attempt
            : bucket.continuationAttempts,
        failureAttempts:
          mode === "failure" && retryPlan.status === "SCHEDULED"
            ? attempt
            : bucket.failureAttempts,
        failureHistory,
      },
    },
  };
}

async function dispatchClaim(config, state, claim, now = new Date()) {
  const { task, tasks, agent } = await resolveTaskAndAgent(config, claim.claimed.task.id);
  const lockResult = acquireTaskExecutionLock({
    holder: agent.id,
    leases: state.leases,
    now,
    policy: config.concurrencyPolicy,
    taskId: task.id,
    tasks,
    ttlMs: config.leaseTtlMs,
  });

  if (!lockResult.lease) {
    await persistServeArtifacts(config.storage, {
      blockers: [lockResult.blocker],
    }, {
      liveEventSink: config.liveEventSink,
    });

    return {
      execution: null,
      lockResult,
      state: {
        ...state,
        leases: lockResult.leases,
      },
      status: "LOCK_BLOCKED",
    };
  }

  await config.storage.leases.acquireOrRenew(lockResult.lease);
  let runtimeState = {
    ...state,
    leases: lockResult.leases,
  };
  let workspaceRuntime = null;
  let dispatchResult = null;
  const runId = `${task.id}:serve:${toIsoTimestamp(now, "now")}`;
  let updatedTask = await maybeTransitionTaskToInProgress(config.storage, task, now);
  updatedTask = parseTaskRecord({
    ...updatedTask,
    assigned_to: agent.id,
  });
  await config.storage.tasks.upsert(updatedTask);

  try {
    const workspacePlan = createWorkspacePlan({
      agentHome: config.workspace.agentHome ?? null,
      defaultSource: config.workspace.defaultSource ?? null,
      hooks: config.workspace.hooks ?? {},
      projectPrimary: config.workspace.projectPrimary,
      sandbox: config.workspace.sandbox ?? {},
      strategy: config.workspace.strategy ?? {},
      task: updatedTask,
      taskSessionCwd: config.workspace.taskSessionCwd ?? null,
      workspaceRoot: config.workspace.root,
    });
    workspaceRuntime = materializeWorkspace(workspacePlan);
    runWorkspaceHook(workspaceRuntime, "before_run");
    await persistServeArtifacts(config.storage, {
      events: [
        createServeLifecycleEvent({
          lifecyclePhase: "workspace_preparation",
          runId,
          summary: `Workspace prepared at ${workspaceRuntime.workspace_path}.`,
          taskId: updatedTask.id,
          now,
        }),
      ],
    }, {
      liveEventSink: config.liveEventSink,
    });

    const routePlan = buildRoutePlan({
      adapters: config.adapters,
      now,
      referenceBundle: {
        documentationPriority:
          config.referenceBundle.documentationPriority
          ?? config.referenceBundle.documentation_priority
          ?? ["README.md"],
        guides:
          config.referenceBundle.guides
          ?? ["Inspect the target area and keep changes inside the declared task scope."],
        stepCatalog:
          config.referenceBundle.stepCatalog
          ?? config.referenceBundle.step_catalog
          ?? ["Read the relevant files before executing changes."],
        targetPaths:
          config.referenceBundle.targetPaths
          ?? config.referenceBundle.target_paths
          ?? ["."],
        taskId: updatedTask.id,
        ...config.referenceBundle,
      },
      roleManifests: config.roleManifests,
      routingPolicy: config.routingPolicy,
      subtasks: [],
      task: updatedTask,
    });

    const routeSelectedAssets = [
      {
        asset_id: routePlan.selectedAdapter.id,
        asset_kind: "adapter",
      },
      ...routePlan.selected_lane.health_assets,
    ];
    const routeAssetHealthGate = evaluateAssetHealthGate({
      additionalAssets: routeSelectedAssets,
      assetId: agent.id,
      routingPolicy: config.routingPolicy,
      workspaceRoot: config.workspace.root,
    });

    await persistServeArtifacts(config.storage, {
      events: [
        createServeLifecycleEvent({
          lifecyclePhase: "prompt_building",
          payload: {
            adapter_id: routePlan.selectedAdapter.id,
            lane_id: routePlan.selected_lane.lane_id,
          },
          runId,
          summary: `Route plan selected adapter ${routePlan.selectedAdapter.id} on lane ${routePlan.selected_lane.lane_id}.`,
          taskId: updatedTask.id,
          now,
        }),
      ],
    }, {
      liveEventSink: config.liveEventSink,
    });

    if (routeAssetHealthGate.blocked) {
      const blockedAssetSummary = routeAssetHealthGate.blocked_assets
        .map((asset) => `${asset.asset_kind}:${asset.asset_id}=${asset.status}`)
        .join(", ");
      updatedTask = await transitionTaskToBlocked(
        config.storage,
        updatedTask,
        `Serve route execution was blocked because the asset-health gate reported ${blockedAssetSummary}.`,
        now,
      );
      const blocker = createServeBlocker({
        blockerClass: "DEPENDENCY_UNMET",
        nextAction:
          "Refresh regression evidence or override the asset-health gate before retrying this route.",
        now,
        reason:
          `Route-selected assets reported a blocking health status (${blockedAssetSummary}), `
          + "so serve skipped dispatch for this task.",
        suffix: `task-${updatedTask.id}-asset-health-route`,
        taskId: updatedTask.id,
      });
      const explainability = createServeExplainability({
        evidenceRefs: [
          agent.id,
          ...routeAssetHealthGate.blocked_assets.map((asset) => `${asset.asset_kind}:${asset.asset_id}`),
          routeAssetHealthGate.gate_policy.report_path,
        ],
        now,
        routeChosen: "serve:skip-dispatch:route-asset-health",
        summary:
          `Serve skipped dispatch for task ${updatedTask.id} because route-selected assets `
          + `reported blocking status for ${blockedAssetSummary}.`,
        taskId: updatedTask.id,
      });

      await persistServeArtifacts(config.storage, {
        blockers: [blocker],
        explainability: [explainability],
      }, {
        liveEventSink: config.liveEventSink,
      });

      dispatchResult = {
        execution: null,
        lockResult,
        routePlan,
        state: runtimeState,
        status: "ASSET_HEALTH_BLOCKED",
        task: updatedTask,
        workspaceRuntime,
      };
    } else {
      if (routeAssetHealthGate.warned) {
        const warnedAssetSummary = routeAssetHealthGate.warned_assets
          .map((asset) => `${asset.asset_kind}:${asset.asset_id}=${asset.status}`)
          .join(", ");
        await persistServeArtifacts(config.storage, {
          explainability: [
            createServeExplainability({
              evidenceRefs: [
                agent.id,
                ...routeAssetHealthGate.warned_assets.map((asset) => `${asset.asset_kind}:${asset.asset_id}`),
                routeAssetHealthGate.gate_policy.report_path,
              ],
              now,
              routeChosen: "serve:allow-dispatch:route-asset-health-watch",
              summary:
                `Serve dispatch continues for task ${updatedTask.id}, but route-selected assets `
                + `reported warning status for ${warnedAssetSummary}.`,
              taskId: updatedTask.id,
            }),
          ],
        }, {
          liveEventSink: config.liveEventSink,
        });
      }

      const resumeContext = await resolveResumeContext(config, routePlan, {
        agent,
        now,
        task: updatedTask,
      });
      await persistServeArtifacts(config.storage, {
        events: [
          createServeLifecycleEvent({
            lifecyclePhase: "session_initialization",
            payload: {
              invocation_source: resumeContext.invocationSource,
              resumed: Boolean(resumeContext.resumeArtifacts),
            },
            runId,
            summary: resumeContext.resumeArtifacts
              ? "Resume context restored from checkpoint/session state."
              : "Fresh execution context prepared without checkpoint restore.",
            taskId: updatedTask.id,
            now,
          }),
        ],
      }, {
        liveEventSink: config.liveEventSink,
      });
      await persistServeArtifacts(config.storage, {
        events: [
          createServeLifecycleEvent({
            lifecyclePhase: "turn_streaming",
            phaseStatus: "started",
            runId,
            summary: `Prompt execution started for adapter ${routePlan.selectedAdapter.id}.`,
            taskId: updatedTask.id,
            now,
          }),
        ],
      }, {
        liveEventSink: config.liveEventSink,
      });
      const execution = await executeRoutePlan({
        agentId: agent.id,
        bootstrapContext: {
          ...resumeContext.bootstrapContext,
          workspace: {
            branch_name: workspaceRuntime.branch_name,
            sandbox_mode: workspaceRuntime.sandbox.mode,
            workspace_path: workspaceRuntime.workspace_path,
          },
        },
        confirmationThreshold: config.confirmationThreshold,
        invocationSource: resumeContext.invocationSource,
        maxTurns: config.maxTurns,
        now,
        routePlan,
        runId,
        runtimeTools: config.runtimeTools,
        session: resumeContext.session,
        taskSessionKey: resumeContext.taskSessionKey,
        taskStateProvider: async () => {
          const latestTasks = await config.storage.tasks.list();
          return latestTasks.find((entry) => entry.id === updatedTask.id) ?? updatedTask;
        },
      });
      await persistServeArtifacts(config.storage, {
        events: [
          createServeLifecycleEvent({
            lifecyclePhase: "finishing",
            payload: {
              stop_reason: execution.execution.stop_reason,
              turn_count: execution.execution.turns.length,
            },
            runId,
            summary: `Execution finished with stop reason ${execution.execution.stop_reason}.`,
            taskId: updatedTask.id,
            now,
          }),
        ],
      }, {
        liveEventSink: config.liveEventSink,
      });

      const persistedRunRecord = await persistExecutionArtifacts(config, execution, routePlan, {
        agent,
        now,
        taskSessionKey: resumeContext.taskSessionKey,
      });
      const persistedExecution = Object.freeze({
        ...execution,
        run_record: persistedRunRecord,
      });

      const nextRetry = execution.execution.stop_reason === "CONFIRMED_COMPLETION"
        ? null
        : scheduleRetry({
          config,
          lastAttemptAt: persistedExecution.run_record.finished_at,
          mode: "continuation",
          now,
          runId: persistedExecution.run_record.id,
          state: runtimeState,
          taskId: updatedTask.id,
        });

      if (nextRetry?.retryPlan?.event) {
        await persistServeArtifacts(config.storage, {
          events: [nextRetry.retryPlan.event],
          explainability: [nextRetry.retryPlan.explainability],
        }, {
          liveEventSink: config.liveEventSink,
        });
      }

      if (execution.execution.stop_reason === "CONFIRMED_COMPLETION") {
        updatedTask = await transitionTaskToReview(config.storage, updatedTask, now);
      } else if (nextRetry?.retryPlan?.status === "SCHEDULED") {
        runtimeState = {
          ...runtimeState,
          retryPlans: [...runtimeState.retryPlans, nextRetry.retryPlan],
          retryState: nextRetry.retryState,
        };
      }

      dispatchResult = {
        execution: persistedExecution,
        lockResult,
        routePlan,
        state: runtimeState,
        status: "EXECUTED",
        task: updatedTask,
        workspaceRuntime,
      };
    }
  } catch (error) {
    const failure = normalizeFailure({
      error,
      kind: "error",
      now,
      runId,
      taskId: updatedTask.id,
    });
    const failureArtifacts = createFailureArtifacts({
      failure,
      now,
    });
    const nextRetry = scheduleRetry({
      adapterResponse: null,
      config,
      failure,
      lastAttemptAt: now,
      mode: "failure",
      now,
      runId,
      state: runtimeState,
      taskId: updatedTask.id,
    });

    await persistServeArtifacts(config.storage, {
      blockers: [failureArtifacts.blocker],
      events: [failureArtifacts.event, nextRetry.retryPlan.event].filter(Boolean),
      explainability: [failureArtifacts.explainability, nextRetry.retryPlan.explainability].filter(Boolean),
    }, {
      liveEventSink: config.liveEventSink,
    });

    dispatchResult = {
      error,
      failure,
      lockResult,
      state: {
        ...runtimeState,
        retryPlans:
          nextRetry.retryPlan.status === "SCHEDULED"
            ? [...runtimeState.retryPlans, nextRetry.retryPlan]
            : runtimeState.retryPlans,
        retryState: nextRetry.retryState,
      },
      status: "FAILED",
      task: updatedTask,
      workspaceRuntime,
    };
  } finally {
    if (workspaceRuntime) {
      try {
        runWorkspaceHook(workspaceRuntime, "after_run");
      } catch {

      }

      cleanupWorkspace(workspaceRuntime, {
        swallowErrors: true,
      });
    }

    const releaseResult = releaseTaskLock({
      deferredWakeups: runtimeState.watchState.deferredWakeups,
      holder: agent.id,
      leases: runtimeState.leases,
      releasedAt: now,
      taskId: updatedTask.id,
    });

    runtimeState = {
      ...runtimeState,
      leases: releaseResult.leases,
      watchState: {
        ...runtimeState.watchState,
        deferredWakeups: releaseResult.deferredWakeups,
        queueItems: releaseResult.promotedQueueItem
          ? mergeQueueItem(runtimeState.watchState.queueItems, releaseResult.promotedQueueItem)
          : runtimeState.watchState.queueItems,
      },
    };
  }

  return {
    ...dispatchResult,
    state: runtimeState,
  };
}

async function startServeLoop(configInput, now = new Date()) {
  const config = createServeConfig(configInput);
  const startup = await validateServeStartup(config, now);

  return {
    config,
    startup,
    state: createServeState({
      currentConfig: config.watchConfig,
    }),
  };
}

async function runServeTick({ config, state, now = new Date() }) {
  let runtimeState = createServeState({
    ...state,
    currentConfig: state.currentConfig ?? config.watchConfig,
  });
  const phases = [];

  phases.push({
    name: "reconcile",
    status: "started",
  });

  const reconciliation = await reconcileServeRuntime(config, runtimeState, now);
  runtimeState = reconciliation.state;
  phases[phases.length - 1] = {
    name: "reconcile",
    status: "completed",
  };

  phases.push({
    name: "validate",
    status: "started",
  });

  const validation = await validateServeTick({
    ...config,
    currentConfig: runtimeState.currentConfig,
  }, now);
  phases[phases.length - 1] = {
    name: "validate",
    status: validation.ok ? "completed" : "skipped_dispatch",
  };

  if (!validation.ok || runtimeState.incidentMode?.freeze_dispatch) {
    await persistServeArtifacts(config.storage, {
      blockers: [validation.blocker],
      explainability: [validation.explainability],
    }, {
      liveEventSink: config.liveEventSink,
    });
    phases.push(
      {
        name: "fetch",
        status: "skipped",
      },
      {
        name: "sort",
        status: "skipped",
      },
      {
        name: "dispatch",
        status: "skipped",
      },
      {
        name: "notify",
        status: "completed",
      },
    );

    return {
      dispatch: null,
      phases,
      reconciliation,
      state: runtimeState,
      validation,
    };
  }

  if (validation.explainability) {
    await persistServeArtifacts(config.storage, {
      explainability: [validation.explainability],
    }, {
      liveEventSink: config.liveEventSink,
    });
  }

  const tasks = await config.storage.tasks.list();
  phases.push({
    name: "fetch",
    status: "started",
  });

  const watchResult = runWatchLoopTick({
    agentId: null,
    cooldownsByTaskId: {},
    currentConfig: createWatchConfig({
      ...runtimeState.currentConfig,
      autoPickup: false,
      autoPickupAgentId: null,
    }),
    grantedApprovals: config.grantedApprovals,
    grantedAuthorities: config.grantedAuthorities,
    leases: runtimeState.leases,
    loadConfig: config.loadWatchConfig,
    now,
    state: runtimeState.watchState,
    tasks,
  });

  for (const detection of watchResult.detections) {
    await config.storage.ingress.record(detection.ingressRecord);
  }

  await persistServeArtifacts(config.storage, {
    blockers: watchResult.blockers,
  }, {
    liveEventSink: config.liveEventSink,
  });

  runtimeState = {
    ...runtimeState,
    currentConfig: watchResult.config,
    watchState: watchResult.state,
  };
  phases[phases.length - 1] = {
    name: "fetch",
    status: "completed",
  };

  phases.push({
    name: "sort",
    status: "started",
  });

  runtimeState = {
    ...runtimeState,
    watchState: {
      ...runtimeState.watchState,
      queueItems: normalizeQueueForScheduling(runtimeState.watchState.queueItems, now),
    },
  };
  phases[phases.length - 1] = {
    name: "sort",
    status: "completed",
  };

  phases.push({
    name: "dispatch",
    status: "started",
  });

  const claimResult = claimNextAutoPickup({
    agentId: config.agentId,
    claimTtlMs: config.claimTtlMs,
    cooldownsByTaskId: {},
    grantedApprovals: config.grantedApprovals,
    grantedAuthorities: config.grantedAuthorities,
    ingressRecords: runtimeState.watchState.ingressRecords,
    leases: runtimeState.leases,
    now,
    queueItems: runtimeState.watchState.queueItems,
    tasks,
  });

  runtimeState = {
    ...runtimeState,
    watchState: {
      ...runtimeState.watchState,
      ingressRecords: claimResult.claimed
        ? updateIngressStatusForTask(
          runtimeState.watchState.ingressRecords,
          claimResult.claimed.task.id,
          "CLAIMED",
        ).ingressRecords
        : runtimeState.watchState.ingressRecords,
      queueItems: claimResult.queueItems,
    },
  };

  if (claimResult.assignmentReason) {
    await config.storage.assignments.record(claimResult.assignmentReason);
  }

  let dispatch = null;

  if (claimResult.claimed) {
    dispatch = await dispatchClaim(config, runtimeState, claimResult, now);
    runtimeState = dispatch.state;
  }

  phases[phases.length - 1] = {
    name: "dispatch",
    status: claimResult.claimed ? "completed" : "idle",
  };

  phases.push({
    name: "notify",
    status: "completed",
  });

  return {
    claimResult,
    dispatch,
    phases,
    reconciliation,
    state: runtimeState,
    validation,
    watchResult,
  };
}

async function stopServeLoop(config, state, now = new Date()) {
  const event = createServeEvent({
    runId: "serve:shutdown",
    eventType: "STATE_CHANGE",
    now,
    payload: {
      active_leases: state.leases.length,
      queued_items: state.watchState.queueItems.length,
      retry_plans: state.retryPlans.length,
    },
    suffix: "shutdown",
  });
  const explainability = createServeExplainability({
    runId: "serve:shutdown",
    routeChosen: "serve:stop",
    summary: "Serve loop stopped gracefully and left a shutdown diagnostic artifact.",
    now,
  });

  await persistServeArtifacts(config.storage, {
    events: [event],
    explainability: [explainability],
  }, {
    liveEventSink: config.liveEventSink,
  });

  return {
    event,
    explainability,
  };
}

function createInMemoryServeStorage({
  tasks = [],
  goals = [],
  agents = [],
  runs = [],
  events = [],
  ingressRecords = [],
  assignments = [],
  taskSessions = [],
  taskRunSessions = [],
  taskRunEvents = [],
  taskLiveExcerpts = [],
  runLogs = [],
  taskNotes = [],
  taskContentRevisions = [],
  blockers = [],
  evidencePackets = [],
  explainability = [],
  checkpoints = [],
} = {}) {
  const taskStore = new Map(tasks.map((task) => [parseTaskRecord(task).id, parseTaskRecord(task)]));
  const goalStore = new Map(goals.map((goal) => [goal.id, clone(goal)]));
  const agentStore = new Map(agents.map((agent) => [parseAgentEntity(agent).id, parseAgentEntity(agent)]));
  const runStore = new Map(runs.map((run) => [parseRunRecord(run).id, parseRunRecord(run)]));
  const eventStore = events.map(parseEventLogEntry);
  const ingressStore = ingressRecords.map(parseTaskIngressRecord);
  const assignmentStore = assignments.map(parseAssignmentReason);
  const queueWrites = [];
  const leaseWrites = [];
  const taskSessionStore = new Map(
    taskSessions.map((taskSession) => [parseTaskSession(taskSession).task_key, parseTaskSession(taskSession)]),
  );
  const taskRunSessionStore = new Map(
    taskRunSessions.map((taskRunSession) => [parseTaskRunSession(taskRunSession).id, parseTaskRunSession(taskRunSession)]),
  );
  const taskRunEventStore = taskRunEvents.map(parseTaskRunEvent);
  const taskLiveExcerptStore = taskLiveExcerpts.map(parseTaskLiveExcerpt);
  const roleSpendStore = new Map();
  const runLogStore = new Map(
    runLogs.map((runLog) => [runLog.run_id ?? runLog.id, clone(runLog)]),
  );
  const taskNoteStore = taskNotes.map((taskNote) => clone(taskNote));
  const taskContentRevisionStore = taskContentRevisions.map((revision) => parseTaskContentRevision(revision));
  const approvalStore = [];
  const blockerStore = new Map(blockers.map((blocker) => [parseBlockerArtifact(blocker).id, parseBlockerArtifact(blocker)]));
  const verdictStore = [];
  const evidenceStore = evidencePackets.map((packet) => clone(packet));
  const checkpointStore = new Map(
    checkpoints.map((checkpoint) => [parseCheckpoint(checkpoint).id, parseCheckpoint(checkpoint)]),
  );
  const explainabilityStore = explainability.map(parseExplainabilityRecord);

  return {
    tasks: {
      async upsert(task) {
        const normalized = parseTaskRecord(task);
        taskStore.set(normalized.id, normalized);
        return normalized;
      },
      async list() {
        return [...taskStore.values()].map(clone);
      },
      async byGoal(goalId) {
        return [...taskStore.values()]
          .filter((task) => task.goal_id === goalId)
          .map(clone);
      },
    },
    goals: {
      async upsert(goal) {
        goalStore.set(goal.id, clone(goal));
        return goal;
      },
      async byId(goalId) {
        return clone(goalStore.get(goalId) ?? null);
      },
      async list() {
        return [...goalStore.values()].map(clone);
      },
    },
    agents: {
      async upsert(agent) {
        const normalized = parseAgentEntity(agent);
        agentStore.set(normalized.id, normalized);
        return normalized;
      },
      async updateStatus(agentId, update) {
        const current = agentStore.get(agentId);

        if (!current) {
          throw new ServeRuntimeError(`agent ${agentId} not found`);
        }

        const normalized = parseAgentEntity({
          ...current,
          ...clone(update),
          updated_at: toIsoTimestamp(update?.updated_at ?? new Date(), "updated_at"),
        });
        agentStore.set(agentId, normalized);
        return normalized;
      },
      async accumulateCost(agentId, cost) {
        const current = agentStore.get(agentId);

        if (!current) {
          throw new ServeRuntimeError(`agent ${agentId} not found`);
        }

        const normalized = parseAgentEntity({
          ...current,
          accumulated: {
            total_cost_usd: current.accumulated.total_cost_usd + Number(cost?.estimated_usd ?? 0),
            total_runs: current.accumulated.total_runs + 1,
            total_tokens_in: current.accumulated.total_tokens_in + Number(cost?.tokens_in ?? 0),
            total_tokens_out: current.accumulated.total_tokens_out + Number(cost?.tokens_out ?? 0),
          },
          budget_monthly: current.budget_monthly
            ? {
              ...current.budget_monthly,
              spent_usd: current.budget_monthly.spent_usd + Number(cost?.estimated_usd ?? 0),
            }
            : null,
          updated_at: toIsoTimestamp(new Date(), "updated_at"),
        });
        agentStore.set(agentId, normalized);
        return normalized;
      },
      async list() {
        return [...agentStore.values()].map(clone);
      },
      async byId(agentId) {
        return clone(agentStore.get(agentId) ?? null);
      },
      async health() {
        return [...agentStore.values()].map((agent) => ({
          health_status: agent.health_status,
          id: agent.id,
          last_run_at: agent.last_run_at,
        }));
      },
    },
    runs: {
      async upsert(run) {
        const normalized = parseRunRecord(run);
        runStore.set(normalized.id, normalized);
        return normalized;
      },
      async byTask(taskId) {
        return [...runStore.values()]
          .filter((run) => run.task_id === taskId)
          .map(clone);
      },
    },
    events: {
      async append(event) {
        const normalized = parseEventLogEntry(event);
        eventStore.push(normalized);
        return normalized;
      },
    },
    ingress: {
      async record(ingressRecord) {
        const normalized = parseTaskIngressRecord(ingressRecord);
        ingressStore.push(normalized);
        return normalized;
      },
      async byTask(taskId) {
        return ingressStore
          .filter((record) => record.source_ref === `task:${taskId}`)
          .map(clone);
      },
    },
    assignments: {
      async record(assignment) {
        const normalized = parseAssignmentReason(assignment);
        assignmentStore.push(normalized);
        return normalized;
      },
      async byTask(taskId) {
        return assignmentStore.filter((assignment) => assignment.task_id === taskId).map(clone);
      },
    },
    queue: {
      async enqueue(item) {
        queueWrites.push(clone(item));
        return item;
      },
      async claimNext(item) {
        queueWrites.push(clone(item));
        return item;
      },
    },
    leases: {
      async acquireOrRenew(lease) {
        leaseWrites.push(clone(lease));
        return lease;
      },
    },
    taskSessions: {
      async upsert(taskSession) {
        const normalized = parseTaskSession(taskSession);
        taskSessionStore.set(normalized.task_key, normalized);
        return normalized;
      },
      async getByKey(taskKey) {
        return clone(taskSessionStore.get(taskKey) ?? null);
      },
      async byTaskKey(taskKey) {
        const taskSession = taskSessionStore.get(taskKey);
        return taskSession ? [clone(taskSession)] : [];
      },
    },
    taskRunSessions: {
      async upsert(taskRunSession) {
        const normalized = parseTaskRunSession(taskRunSession);
        taskRunSessionStore.set(normalized.id, normalized);
        return clone(normalized);
      },
      async byTask(taskId) {
        return [...taskRunSessionStore.values()]
          .filter((session) => session.task_id === taskId)
          .map(clone);
      },
      async byRun(runId) {
        return [...taskRunSessionStore.values()]
          .filter((session) => session.run_id === runId)
          .map(clone);
      },
    },
    taskRunEvents: {
      async append(taskRunEvent) {
        const normalized = parseTaskRunEvent(taskRunEvent);
        taskRunEventStore.push(normalized);
        return clone(normalized);
      },
      async byTask(taskId) {
        return taskRunEventStore
          .filter((event) => event.task_id === taskId)
          .map(clone);
      },
      async byRun(runId) {
        return taskRunEventStore
          .filter((event) => event.run_id === runId)
          .map(clone);
      },
    },
    taskLiveExcerpts: {
      async append(taskLiveExcerpt) {
        const normalized = parseTaskLiveExcerpt(taskLiveExcerpt);
        taskLiveExcerptStore.push(normalized);
        return clone(normalized);
      },
      async byTask(taskId) {
        return taskLiveExcerptStore
          .filter((excerpt) => excerpt.task_id === taskId)
          .map(clone);
      },
      async byRun(runId) {
        return taskLiveExcerptStore
          .filter((excerpt) => excerpt.run_id === runId)
          .map(clone);
      },
    },
    runLogs: {
      async store(runLog) {
        runLogStore.set(runLog.run_id, clone(runLog));
        return runLog;
      },
      async getByRunId(runId) {
        return clone(runLogStore.get(runId) ?? null);
      },
      async byRun(runId) {
        const runLog = runLogStore.get(runId);
        return runLog ? [clone(runLog)] : [];
      },
    },
    taskNotes: {
      async append(taskNote) {
        taskNoteStore.push(clone(taskNote));
        return taskNote;
      },
      async byTask(taskId) {
        return taskNoteStore.filter((note) => note.task_id === taskId).map(clone);
      },
    },
    taskContentRevisions: {
      async append(taskContentRevision) {
        const normalized = parseTaskContentRevision(taskContentRevision);
        taskContentRevisionStore.push(normalized);
        return normalized;
      },
      async byTask(taskId) {
        return taskContentRevisionStore
          .filter((revision) => revision.task_id === taskId)
          .map(clone);
      },
    },
    approvals: {
      async upsert(approval) {
        const index = approvalStore.findIndex((entry) => entry.id === approval.id);

        if (index >= 0) {
          approvalStore[index] = clone(approval);
        } else {
          approvalStore.push(clone(approval));
        }

        return approval;
      },
      async byTask(taskId) {
        return approvalStore.filter((approval) => approval.task_id === taskId).map(clone);
      },
      async listPending() {
        return approvalStore.filter((approval) => approval.status === "PENDING").map(clone);
      },
    },
    verdicts: {
      async record(verdict) {
        verdictStore.push(clone(verdict));
        return verdict;
      },
    },
    evidence: {
      async savePacket(packet) {
        evidenceStore.push(clone(packet));
        return packet;
      },
      async byVerdict(verdictId) {
        return evidenceStore.filter((packet) => packet.verdict_id === verdictId).map(clone);
      },
    },
    blockers: {
      async upsert(blocker) {
        const normalized = parseBlockerArtifact(blocker);
        blockerStore.set(normalized.id, normalized);
        return normalized;
      },
      async active() {
        return [...blockerStore.values()]
          .filter((blocker) => blocker.resolved_at === null)
          .map(clone);
      },
    },
    checkpoints: {
      async save(checkpoint) {
        const normalized = parseCheckpoint(checkpoint);
        checkpointStore.set(normalized.id, normalized);
        return normalized;
      },
    },
    explainability: {
      async record(record) {
        const normalized = parseExplainabilityRecord(record);
        explainabilityStore.push(normalized);
        return normalized;
      },
    },
    decisions: {
      async explain(taskId) {
        return explainabilityStore
          .filter((record) => record.task_id === taskId)
          .map(clone);
      },
    },
    roleMonthlySpend: {
      async accumulate(roleId, period, deltaUsd, now = new Date()) {
        const key = `${roleId}|${period}`;
        const current = roleSpendStore.get(key) ?? {
          period_yyyy_mm: period,
          role_id: roleId,
          spent_usd: 0,
          updated_at: new Date(now).toISOString(),
        };
        roleSpendStore.set(key, {
          ...current,
          spent_usd: current.spent_usd + (Number(deltaUsd) || 0),
          updated_at: new Date(now).toISOString(),
        });
      },
      async getSpend(roleId, period) {
        return roleSpendStore.get(`${roleId}|${period}`)?.spent_usd ?? 0;
      },
      async list() {
        return [...roleSpendStore.values()].map(clone);
      },
    },
    metrics: {
      async summary({
        agentId = null,
        budgetWarningThreshold = 0.8,
        now = new Date(),
        taskId = null,
      } = {}) {
        return buildOperationalMetricsView({
          agentId,
          budgetWarningThreshold,
          now,
          snapshot: storage.snapshot(),
          taskId,
        });
      },
    },
    snapshot() {
      return {
        agents: [...agentStore.values()].map(clone),
        assignments: assignmentStore.map(clone),
        blockers: [...blockerStore.values()].map(clone),
        checkpoints: [...checkpointStore.values()].map(clone),
        events: eventStore.map(clone),
        explainability: explainabilityStore.map(clone),
        evidence: evidenceStore.map(clone),
        ingressRecords: ingressStore.map(clone),
        leaseWrites: leaseWrites.map(clone),
        queueWrites: queueWrites.map(clone),
        runLogs: [...runLogStore.values()].map(clone),
        runs: [...runStore.values()].map(clone),
        taskContentRevisions: taskContentRevisionStore.map(clone),
        taskSessions: [...taskSessionStore.values()].map(clone),
        taskNotes: taskNoteStore.map(clone),
        tasks: [...taskStore.values()].map(clone),
        verdicts: verdictStore.map(clone),
      };
    },
  };

  return storage;
}

export {
  SERVE_RUNTIME_TASK_ID,
  SERVE_TICK_ORDER,
  ServeRuntimeError,
  createInMemoryServeStorage,
  createServeConfig,
  createServeState,
  dispatchClaim,
  evaluateAutoResume,
  reconcileServeRuntime,
  startServeLoop,
  stopServeLoop,
  validateServeStartup,
  validateServeTick,
  runServeTick,
};
