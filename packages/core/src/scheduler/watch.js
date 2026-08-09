import { parseBlockerArtifact } from "../schemas/blocker.js";
import {
  INGRESS_SOURCE_TYPES,
  parseTaskIngressRecord,
} from "../schemas/ingress.js";
import { findTaskLease } from "./lease.js";
import {
  claimQueueItem,
  normalizeTaskSourceRecord,
  sortQueueItems,
  toIsoTimestamp,
} from "./queue.js";
import {
  buildTaskLookup,
  CLAIMABLE_TASK_STATUSES,
  createAssignmentReasonRecord,
  getIncompleteDependencies,
  normalizeQueueForScheduling,
} from "./scheduler.js";
import { registerTaskWake } from "./wake.js";

class WatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "WatchError";
  }
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_READY_STATES = ["pending", "ready", "queued", "todo", "next"];
const WATCH_RUNTIME_TASK_ID = "runtime:watch";
const DEFAULT_WATCH_POLICY_REF = "scheduler/watch-loop/v1";
const WATCH_SKIP_REASONS = [
  "ACTIVE_LEASE",
  "APPROVALS_PENDING",
  "AUTHORITY_DENIED",
  "COOLDOWN_ACTIVE",
  "NOT_READY",
  "TASK_NOT_FOUND",
  "TASK_NOT_CLAIMABLE",
  "DEPENDENCIES_PENDING",
];

function createWatchConfig({
  version = "watch-config/v1",
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  taskSources = [],
  readyStates = DEFAULT_READY_STATES,
  autoPickup = true,
  autoPickupAgentId = null,
  policyRef = DEFAULT_WATCH_POLICY_REF,
} = {}) {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new WatchError("pollIntervalMs must be a positive integer");
  }

  if (!Array.isArray(taskSources) || taskSources.length === 0) {
    throw new WatchError("taskSources must be a non-empty array");
  }

  const sourceIds = new Set();
  const normalizedSources = taskSources.map((taskSource, index) => {
    if (!taskSource || typeof taskSource !== "object") {
      throw new WatchError(`taskSources[${index}] must be an object`);
    }

    const sourceId = taskSource.id;

    if (typeof sourceId !== "string" || sourceId.trim() === "") {
      throw new WatchError(`taskSources[${index}].id must be a non-empty string`);
    }

    if (sourceIds.has(sourceId)) {
      throw new WatchError(`duplicate task source id: ${sourceId}`);
    }

    sourceIds.add(sourceId);

    const sourceType = taskSource.type ?? "backlog_file";

    if (!INGRESS_SOURCE_TYPES.includes(sourceType)) {
      throw new WatchError(`unsupported task source type: ${sourceType}`);
    }

    if (typeof taskSource.poll !== "function") {
      throw new WatchError(`task source ${sourceId} must define poll({ now })`);
    }

    return {
      ...taskSource,
      id: sourceId,
      type: sourceType,
    };
  });

  if (!Array.isArray(readyStates) || readyStates.length === 0) {
    throw new WatchError("readyStates must be a non-empty array");
  }

  return Object.freeze({
    autoPickup,
    autoPickupAgentId,
    policyRef,
    pollIntervalMs,
    readyStates: readyStates.map((state) => {
      if (typeof state !== "string" || state.trim() === "") {
        throw new WatchError("readyStates must contain non-empty strings");
      }

      return state.trim().toLowerCase();
    }),
    taskSources: normalizedSources,
    version,
  });
}

function createReloadBlocker({ error, now }) {
  const timestamp = toIsoTimestamp(now, "now");
  const reason = error instanceof Error ? error.message : String(error);

  return parseBlockerArtifact({
    id: `${WATCH_RUNTIME_TASK_ID}:reload:${timestamp}`,
    task_id: WATCH_RUNTIME_TASK_ID,
    blocker_class: "ENV_BLOCK",
    reason: `Watch config reload failed: ${reason}`,
    next_action:
      "Fix the workflow/profile configuration and retry reload; the last-known-good watch config remains active.",
    created_at: timestamp,
    resolved_at: null,
  });
}

function reloadWatchConfig({
  currentConfig,
  loadConfig = null,
  now = new Date(),
}) {
  if (typeof loadConfig !== "function") {
    return {
      blocker: null,
      changed: false,
      config: currentConfig,
      usedLastKnownGood: false,
    };
  }

  try {
    const nextConfig = createWatchConfig(loadConfig());

    return {
      blocker: null,
      changed: nextConfig.version !== currentConfig.version,
      config: nextConfig,
      usedLastKnownGood: false,
    };
  } catch (error) {
    return {
      blocker: createReloadBlocker({ error, now }),
      changed: false,
      config: currentConfig,
      usedLastKnownGood: true,
    };
  }
}

function pollTaskSource(taskSource, now = new Date()) {
  const polled = taskSource.poll({ now });

  if (!Array.isArray(polled)) {
    throw new WatchError(`task source ${taskSource.id} poll() must return an array`);
  }

  return polled.map((record, index) => ({
    raw: record,
    normalized: normalizeTaskSourceRecord(record),
    source: {
      id: taskSource.id,
      type: taskSource.type,
    },
    sourceIndex: index,
  }));
}

function pollTaskSources(taskSources, now = new Date()) {
  return taskSources.flatMap((taskSource) => pollTaskSource(taskSource, now));
}

function resolveIngressRoute({ taskSource, detection }) {
  if (typeof taskSource.routeTask === "function") {
    const result = taskSource.routeTask(detection);

    return {
      approvalsRequired: [...new Set(result?.approvalsRequired ?? [])],
      authorityConstraints: [...new Set(result?.authorityConstraints ?? [])],
      routeCandidate: result?.routeCandidate ?? null,
    };
  }

  return {
    approvalsRequired: [],
    authorityConstraints: [],
    routeCandidate: taskSource.routeCandidate ?? null,
  };
}

function createIngressRecord({
  taskId,
  sourceType,
  sourceRef,
  detectedAt,
  routeCandidate = null,
  authorityConstraints = [],
  approvalsRequired = [],
  ingressStatus = "DETECTED",
}) {
  const timestamp = toIsoTimestamp(detectedAt, "detectedAt");

  return parseTaskIngressRecord({
    id: `${sourceRef}:${timestamp}`,
    source_type: sourceType,
    source_ref: sourceRef,
    detected_at: timestamp,
    route_candidate: routeCandidate,
    authority_constraints: authorityConstraints,
    approvals_required: approvalsRequired,
    ingress_status: ingressStatus,
  });
}

function updateIngressStatus(ingressRecord, ingressStatus) {
  return parseTaskIngressRecord({
    ...ingressRecord,
    ingress_status: ingressStatus,
  });
}

function createLatestIngressLookup(ingressRecords) {
  const lookup = new Map();

  for (const ingressRecord of ingressRecords.map(parseTaskIngressRecord)) {
    const existing = lookup.get(ingressRecord.source_ref) ?? null;

    if (!existing || Date.parse(ingressRecord.detected_at) >= Date.parse(existing.detected_at)) {
      lookup.set(ingressRecord.source_ref, ingressRecord);
    }
  }

  return lookup;
}

function isReadyTaskSourceState(normalizedState, readyStates) {
  return readyStates.includes(normalizedState);
}

function evaluateIngressEligibility({
  detection,
  routeDecision,
  grantedApprovals = [],
  grantedAuthorities = [],
  cooldownsByTaskId = {},
  now = new Date(),
  readyStates = DEFAULT_READY_STATES,
}) {
  if (!isReadyTaskSourceState(detection.normalized.state, readyStates)) {
    return {
      allowed: false,
      reason: "NOT_READY",
    };
  }

  const missingApprovals = routeDecision.approvalsRequired.filter(
    (approval) => !grantedApprovals.includes(approval),
  );

  if (missingApprovals.length > 0) {
    return {
      allowed: false,
      missingApprovals,
      reason: "APPROVALS_PENDING",
    };
  }

  const missingAuthorities = routeDecision.authorityConstraints.filter(
    (authority) => !grantedAuthorities.includes(authority),
  );

  if (missingAuthorities.length > 0) {
    return {
      allowed: false,
      missingAuthorities,
      reason: "AUTHORITY_DENIED",
    };
  }

  const cooldownUntil = cooldownsByTaskId[detection.normalized.identifier] ?? null;

  if (cooldownUntil && Date.parse(toIsoTimestamp(now, "now")) < Date.parse(toIsoTimestamp(cooldownUntil, "cooldownUntil"))) {
    return {
      allowed: false,
      cooldownUntil: toIsoTimestamp(cooldownUntil, "cooldownUntil"),
      reason: "COOLDOWN_ACTIVE",
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

function createClaimGateFromIngress({
  taskId,
  latestIngressLookup,
  leases,
  grantedApprovals = [],
  grantedAuthorities = [],
  cooldownsByTaskId = {},
  now = new Date(),
}) {
  const sourceRef = `task:${taskId}`;
  const ingressRecord = latestIngressLookup.get(sourceRef) ?? null;

  if (findTaskLease(leases, taskId, now)) {
    return {
      allowed: false,
      reason: "ACTIVE_LEASE",
    };
  }

  if (ingressRecord) {
    const missingApprovals = ingressRecord.approvals_required.filter(
      (approval) => !grantedApprovals.includes(approval),
    );

    if (missingApprovals.length > 0) {
      return {
        allowed: false,
        missingApprovals,
        reason: "APPROVALS_PENDING",
      };
    }

    const missingAuthorities = ingressRecord.authority_constraints.filter(
      (authority) => !grantedAuthorities.includes(authority),
    );

    if (missingAuthorities.length > 0) {
      return {
        allowed: false,
        missingAuthorities,
        reason: "AUTHORITY_DENIED",
      };
    }
  }

  const cooldownUntil = cooldownsByTaskId[taskId] ?? null;

  if (cooldownUntil && Date.parse(toIsoTimestamp(now, "now")) < Date.parse(toIsoTimestamp(cooldownUntil, "cooldownUntil"))) {
    return {
      allowed: false,
      cooldownUntil: toIsoTimestamp(cooldownUntil, "cooldownUntil"),
      reason: "COOLDOWN_ACTIVE",
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

function addMilliseconds(timestamp, milliseconds) {
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
    throw new WatchError("claimTtlMs must be a positive integer");
  }

  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function claimNextAutoPickup({
  queueItems,
  tasks,
  leases,
  ingressRecords = [],
  agentId,
  now = new Date(),
  claimTtlMs = 5 * 60 * 1000,
  grantedApprovals = [],
  grantedAuthorities = [],
  cooldownsByTaskId = {},
  reasonType = "auto_pickup",
  policyRef = DEFAULT_WATCH_POLICY_REF,
  context = "Claimed by watch auto-pickup after gating approvals, authority, cooldowns, and queue order",
}) {
  if (!agentId) {
    throw new WatchError("claimNextAutoPickup requires agentId");
  }

  const timestamp = toIsoTimestamp(now, "now");
  const normalizedQueueItems = normalizeQueueForScheduling(queueItems, timestamp);
  const taskLookup = buildTaskLookup(tasks);
  const latestIngressLookup = createLatestIngressLookup(ingressRecords);
  const skipped = [];
  const candidateQueueItems = [...normalizedQueueItems];

  while (candidateQueueItems.length > 0) {
    const queueItem = candidateQueueItems.shift();
    const task = taskLookup.get(queueItem.task_id) ?? null;

    if (!task) {
      skipped.push({
        task_id: queueItem.task_id,
        reason: "TASK_NOT_FOUND",
      });
      continue;
    }

    if (queueItem.status === "CLAIMED") {
      continue;
    }

    if (!CLAIMABLE_TASK_STATUSES.includes(task.status)) {
      skipped.push({
        task_id: queueItem.task_id,
        reason: "TASK_NOT_CLAIMABLE",
        task_status: task.status,
      });
      continue;
    }

    const incompleteDependencies = getIncompleteDependencies(task, taskLookup);

    if (incompleteDependencies.length > 0) {
      skipped.push({
        task_id: queueItem.task_id,
        reason: "DEPENDENCIES_PENDING",
        dependencies: incompleteDependencies,
      });
      continue;
    }

    const gate = createClaimGateFromIngress({
      taskId: task.id,
      latestIngressLookup,
      leases,
      grantedApprovals,
      grantedAuthorities,
      cooldownsByTaskId,
      now: timestamp,
    });

    if (!gate.allowed) {
      skipped.push({
        task_id: task.id,
        reason: gate.reason,
        ...(gate.missingApprovals ? { missing_approvals: gate.missingApprovals } : {}),
        ...(gate.missingAuthorities ? { missing_authorities: gate.missingAuthorities } : {}),
        ...(gate.cooldownUntil ? { cooldown_until: gate.cooldownUntil } : {}),
      });
      continue;
    }

    const claimedQueueItem = claimQueueItem(queueItem, {
      claimedBy: agentId,
      claimExpiresAt: addMilliseconds(timestamp, claimTtlMs),
    });
    const updatedQueueItems = normalizedQueueItems.map((existingQueueItem) =>
      existingQueueItem.task_id === claimedQueueItem.task_id ? claimedQueueItem : existingQueueItem,
    );
    const assignmentReason = createAssignmentReasonRecord({
      taskId: task.id,
      agentId,
      timestamp,
      reasonType,
      policyRef,
      context,
    });

    return {
      assignmentReason,
      claimed: {
        queueItem: claimedQueueItem,
        task,
      },
      queueItems: updatedQueueItems,
      skipped,
    };
  }

  return {
    assignmentReason: null,
    claimed: null,
    queueItems: normalizedQueueItems,
    skipped,
  };
}

function runWatchLoopTick({
  currentConfig,
  loadConfig = null,
  state = {},
  tasks = [],
  leases = [],
  now = new Date(),
  agentId = null,
  grantedApprovals = [],
  grantedAuthorities = [],
  cooldownsByTaskId = {},
}) {
  const timestamp = toIsoTimestamp(now, "now");
  const reload = reloadWatchConfig({
    currentConfig,
    loadConfig,
    now: timestamp,
  });
  const activeConfig = reload.config;
  const blockers = reload.blocker ? [reload.blocker] : [];
  let queueItems = state.queueItems ? sortQueueItems(state.queueItems) : [];
  let deferredWakeups = state.deferredWakeups ?? [];
  let ingressRecords = state.ingressRecords?.map(parseTaskIngressRecord) ?? [];
  let wakeRecords = state.wakeRecords ?? [];
  const detections = [];
  const skipped = [];

  for (const taskSource of activeConfig.taskSources) {
    for (const detection of pollTaskSource(taskSource, timestamp)) {
      const routeDecision = resolveIngressRoute({
        taskSource,
        detection,
      });
      const sourceRef = `task:${detection.normalized.identifier}`;
      let ingressRecord = createIngressRecord({
        taskId: detection.normalized.identifier,
        sourceType: detection.source.type,
        sourceRef,
        detectedAt: detection.normalized.detected_at ?? timestamp,
        routeCandidate: routeDecision.routeCandidate,
        authorityConstraints: routeDecision.authorityConstraints,
        approvalsRequired: routeDecision.approvalsRequired,
        ingressStatus: "ROUTED",
      });
      ingressRecords = [...ingressRecords, ingressRecord];

      const eligibility = evaluateIngressEligibility({
        detection,
        routeDecision,
        grantedApprovals,
        grantedAuthorities,
        cooldownsByTaskId,
        now: timestamp,
        readyStates: activeConfig.readyStates,
      });

      if (!eligibility.allowed) {
        skipped.push({
          task_id: detection.normalized.identifier,
          reason: eligibility.reason,
          ...(eligibility.missingApprovals ? { missing_approvals: eligibility.missingApprovals } : {}),
          ...(eligibility.missingAuthorities ? { missing_authorities: eligibility.missingAuthorities } : {}),
          ...(eligibility.cooldownUntil ? { cooldown_until: eligibility.cooldownUntil } : {}),
        });
        detections.push({
          detection,
          eligibility,
          ingressRecord,
          routeDecision,
        });
        continue;
      }

      const wakeResult = registerTaskWake({
        wakeRecords,
        queueItems,
        deferredWakeups,
        leases,
        taskId: detection.normalized.identifier,
        source: taskSource.wakeSource ?? "automation",
        context: {
          source_id: taskSource.id,
          source_index: detection.sourceIndex,
          state: detection.normalized.state,
        },
        now: detection.normalized.detected_at ?? timestamp,
        priority: detection.normalized.priority,
      });

      wakeRecords = wakeResult.wakeRecords;
      queueItems = wakeResult.queueItems;
      deferredWakeups = wakeResult.deferredWakeups;

      if (wakeResult.blocker) {
        blockers.push(wakeResult.blocker);
      }

      ingressRecord = updateIngressStatus(ingressRecord, "QUEUED");
      ingressRecords[ingressRecords.length - 1] = ingressRecord;
      detections.push({
        detection,
        eligibility,
        ingressRecord,
        routeDecision,
        wakeRecord: wakeResult.wakeRecord,
      });
    }
  }

  let claimResult = {
    assignmentReason: null,
    claimed: null,
    queueItems,
    skipped: [],
  };

  if (activeConfig.autoPickup && (agentId ?? activeConfig.autoPickupAgentId)) {
    claimResult = claimNextAutoPickup({
      queueItems,
      tasks,
      leases,
      ingressRecords,
      agentId: agentId ?? activeConfig.autoPickupAgentId,
      now: timestamp,
      grantedApprovals,
      grantedAuthorities,
      cooldownsByTaskId,
      policyRef: activeConfig.policyRef,
    });
    queueItems = claimResult.queueItems;

    if (claimResult.claimed) {
      const sourceRef = `task:${claimResult.claimed.task.id}`;

      ingressRecords = ingressRecords.map((ingressRecord) =>
        ingressRecord.source_ref === sourceRef
          ? updateIngressStatus(ingressRecord, "CLAIMED")
          : ingressRecord,
      );
    }
  }

  return {
    blocker: reload.blocker,
    blockers,
    claimResult,
    config: activeConfig,
    detections,
    reload,
    skipped: [...skipped, ...claimResult.skipped],
    state: {
      deferredWakeups,
      ingressRecords,
      queueItems,
      wakeRecords,
    },
  };
}

export {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READY_STATES,
  DEFAULT_WATCH_POLICY_REF,
  WATCH_RUNTIME_TASK_ID,
  WATCH_SKIP_REASONS,
  WatchError,
  claimNextAutoPickup,
  createIngressRecord,
  createReloadBlocker,
  createWatchConfig,
  evaluateIngressEligibility,
  pollTaskSource,
  pollTaskSources,
  reloadWatchConfig,
  resolveIngressRoute,
  runWatchLoopTick,
  updateIngressStatus,
};
