import { randomUUID } from "node:crypto";

import {
  AttemptStage,
  CANONICAL_VERDICTS,
  CanonicalVerdict,
  PromotionStatus,
  createTaskAttemptResult,
  isTerminalAttemptStage,
} from "../contracts/task-attempt.js";

class TaskLifecycleError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "TaskLifecycleError";
    this.code = options.code ?? "task_lifecycle_error";
  }
}

class TaskLifecycleBlockedError extends TaskLifecycleError {
  constructor(message) {
    super(message, { code: "task_lifecycle_blocked" });
    this.name = "TaskLifecycleBlockedError";
  }
}

class TaskLifecycleFailedError extends TaskLifecycleError {
  constructor(message) {
    super(message, { code: "task_lifecycle_failed" });
    this.name = "TaskLifecycleFailedError";
  }
}

const REQUIRED_LIFECYCLE_HANDLERS = Object.freeze([
  "prepareWorkspace",
  "execute",
  "runGates",
  "review",
  "promote",
]);

const TERMINAL_HANDLER_STAGES = Object.freeze([
  AttemptStage.BLOCKED,
  AttemptStage.FAILED,
  AttemptStage.CANCELLED,
]);

function clone(value) {
  return structuredClone(value);
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TaskLifecycleError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskLifecycleError(`${label} must be a plain object`);
  }

  return value;
}

function normalizeHandlerResult(result, label) {
  if (result === undefined || result === null) {
    return {};
  }

  if (typeof result !== "object" || Array.isArray(result)) {
    throw new TaskLifecycleError(`${label} must return a plain object`);
  }

  try {
    return clone(result);
  } catch (error) {
    throw new TaskLifecycleError(
      `${label} returned a non-serializable result: ${error.message}`,
    );
  }
}

function assertLifecycleStore(store) {
  const requiredMethods = [
    "attempts.createOrResume",
    "attempts.byId",
    "attempts.acquireLease",
    "attempts.heartbeat",
    "attempts.releaseLease",
    "attempts.transition",
    "attempts.recordStepStarted",
    "attempts.recordStepCompleted",
    "attempts.step",
    "promotions.prepare",
    "promotions.complete",
    "promotions.byAttempt",
  ];

  for (const methodPath of requiredMethods) {
    const [group, method] = methodPath.split(".");
    if (typeof store?.[group]?.[method] !== "function") {
      throw new TaskLifecycleError(`store.${methodPath}() is required`);
    }
  }

  return store;
}

function normalizeHandlers(handlers) {
  const normalized = ensurePlainObject(handlers, "handlers");

  for (const handlerName of REQUIRED_LIFECYCLE_HANDLERS) {
    if (typeof normalized[handlerName] !== "function") {
      throw new TaskLifecycleError(`handlers.${handlerName}() is required`);
    }
  }

  if (normalized.finish !== undefined && typeof normalized.finish !== "function") {
    throw new TaskLifecycleError("handlers.finish must be a function when provided");
  }
  for (const recoveryName of [
    "recoverPrepareWorkspace",
    "recoverPromotion",
    "recoverFinish",
  ]) {
    if (
      normalized[recoveryName] !== undefined
      && typeof normalized[recoveryName] !== "function"
    ) {
      throw new TaskLifecycleError(
        `handlers.${recoveryName} must be a function when provided`,
      );
    }
  }

  return normalized;
}

function resolveVerdictCandidate(result) {
  return (
    result?.canonical_verdict
    ?? result?.canonicalVerdict
    ?? result?.verdict_class
    ?? result?.verdictClass
    ?? result?.final_verdict?.verdict_class
    ?? result?.finalVerdict?.verdictClass
    ?? result?.verdict?.verdict_class
    ?? result?.verdict?.verdictClass
    ?? null
  );
}

function normalizeCanonicalVerdict(value, label) {
  if (!CANONICAL_VERDICTS.includes(value)) {
    throw new TaskLifecycleError(
      `${label} must resolve to one of: ${CANONICAL_VERDICTS.join(", ")}`,
    );
  }

  return value;
}

function resolveGateVerdict(result) {
  const directVerdict = resolveVerdictCandidate(result);
  if (directVerdict !== null) {
    return normalizeCanonicalVerdict(directVerdict, "gate verdict");
  }

  if (typeof result.passed === "boolean") {
    return result.passed ? CanonicalVerdict.PASS : CanonicalVerdict.EVIDENCE_GAP;
  }

  if (typeof result.ok === "boolean") {
    return result.ok ? CanonicalVerdict.PASS : CanonicalVerdict.EVIDENCE_GAP;
  }

  if (Array.isArray(result.results)) {
    if (result.results.length === 0) {
      throw new TaskLifecycleError("gate results must not be empty");
    }

    const verdicts = result.results.map((entry) => resolveGateVerdict(
      entry && typeof entry === "object" ? entry : { passed: Boolean(entry) },
    ));
    return verdicts.find((verdict) => verdict !== CanonicalVerdict.PASS)
      ?? CanonicalVerdict.PASS;
  }

  throw new TaskLifecycleError(
    "runGates must return passed, ok, results, or a canonical verdict",
  );
}

function resolveReviewVerdict(result) {
  return normalizeCanonicalVerdict(
    resolveVerdictCandidate(result),
    "review verdict",
  );
}

function combineVerdicts(gateVerdict, reviewVerdict) {
  if (gateVerdict !== CanonicalVerdict.PASS) {
    return gateVerdict;
  }

  return reviewVerdict;
}

function requestedTerminalStage(result) {
  const stage = result.terminal_stage ?? result.terminalStage ?? null;

  if (stage === null) {
    return null;
  }

  if (!TERMINAL_HANDLER_STAGES.includes(stage)) {
    throw new TaskLifecycleError(
      `handler terminal stage must be one of: ${TERMINAL_HANDLER_STAGES.join(", ")}`,
    );
  }

  return stage;
}

function terminalReason(result, fallback) {
  const reason = result.reason ?? result.error ?? result.message ?? fallback;
  return ensureNonEmptyString(reason, "terminal reason");
}

function readWorkspacePath(result) {
  return ensureNonEmptyString(
    result.workspacePath ?? result.workspace_path,
    "prepareWorkspace result workspacePath",
  );
}

function throwIfLifecycleAborted(abortSignal) {
  if (!abortSignal?.aborted) return;
  const error = new TaskLifecycleBlockedError("execution aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  error.retrySafe = false;
  throw error;
}

function createHandlerContext({
  attempt,
  abortSignal,
  heartbeat,
  idempotencyKey,
  networkPolicy,
  sandboxPolicy,
  timeoutMs,
  freshContext = false,
  recovery = false,
}) {
  return Object.freeze({
    abortSignal,
    attempt: clone(attempt),
    attemptId: attempt.id,
    engineVersion: attempt.engine_version,
    freshContext,
    heartbeat,
    idempotencyKey,
    networkPolicy: clone(networkPolicy),
    recovery,
    sandboxPolicy: clone(sandboxPolicy),
    state: clone(attempt.state),
    taskId: attempt.task_id,
    timeoutMs,
    trigger: attempt.trigger,
    workspacePath: attempt.workspace_path,
  });
}

async function callFaultInjector(faultInjector, point, attempt) {
  if (typeof faultInjector === "function") {
    await faultInjector(Object.freeze({
      point,
      attempt: clone(attempt),
    }));
  }
}

async function invokeDurableHandler({
  store,
  handler,
  handlerName,
  stepStage,
  attempt,
  holder,
  leaseTtlMs,
  heartbeatIntervalMs,
  clock,
  abortSignal,
  networkPolicy,
  sandboxPolicy,
  timeoutMs,
  freshContext = false,
  recoverHandler = null,
  abortBeforeHandler = true,
}) {
  const idempotencyKey = `${attempt.id}:${stepStage}`;
  const existingStep = await store.attempts.step({
    attemptId: attempt.id,
    stage: stepStage,
  });

  if (existingStep?.status === "COMPLETED") {
    return normalizeHandlerResult(existingStep.result, `${handlerName} persisted result`);
  }
  const recovering = existingStep?.status === "STARTED";
  if (recovering && typeof recoverHandler !== "function") {
    throw new TaskLifecycleBlockedError(
      `${handlerName} has an incomplete durable step from an earlier process; `
      + "the handler will not be replayed because its external side effects are unknown",
    );
  }

  await store.attempts.heartbeat({
    attemptId: attempt.id,
    holder,
    now: clock(),
    ttlMs: leaseTtlMs,
  });
  if (abortBeforeHandler) {
    throwIfLifecycleAborted(abortSignal);
  }
  if (!recovering) {
    await store.attempts.recordStepStarted({
      attemptId: attempt.id,
      stage: stepStage,
      idempotencyKey,
      now: clock(),
    });
  }

  let heartbeatError = null;
  let heartbeatPromise = null;
  const heartbeat = async () => {
    await store.attempts.heartbeat({
      attemptId: attempt.id,
      holder,
      now: clock(),
      ttlMs: leaseTtlMs,
    });
  };
  const timer = setInterval(() => {
    if (heartbeatPromise) {
      return;
    }

    heartbeatPromise = heartbeat()
      .catch((error) => {
        heartbeatError = error;
      })
      .finally(() => {
        heartbeatPromise = null;
      });
  }, heartbeatIntervalMs);
  timer.unref?.();

  try {
    await heartbeat();
    if (abortBeforeHandler) {
      throwIfLifecycleAborted(abortSignal);
    }
    const result = normalizeHandlerResult(
      await (recovering ? recoverHandler : handler)(createHandlerContext({
        attempt,
        abortSignal,
        heartbeat,
        idempotencyKey,
        networkPolicy,
        sandboxPolicy,
        timeoutMs,
        freshContext,
        recovery: recovering,
      })),
      recovering ? `${handlerName} recovery` : handlerName,
    );

    if (heartbeatPromise) {
      await heartbeatPromise;
    }
    if (heartbeatError) {
      throw heartbeatError;
    }
    await heartbeat();

    await store.attempts.recordStepCompleted({
      attemptId: attempt.id,
      stage: stepStage,
      result,
      now: clock(),
    });
    return result;
  } finally {
    clearInterval(timer);
  }
}

async function transitionAttempt({
  store,
  attempt,
  holder,
  nextStage,
  clock,
  canonicalVerdict = undefined,
  workspacePath = undefined,
  statePatch = {},
  lastError = undefined,
  faultInjector,
}) {
  const next = await store.attempts.transition({
    attemptId: attempt.id,
    expectedStage: attempt.stage,
    expectedVersion: attempt.version,
    nextStage,
    holder,
    canonicalVerdict,
    workspacePath,
    statePatch,
    lastError,
    now: clock(),
  });
  await callFaultInjector(faultInjector, `after:${nextStage}`, next);
  return next;
}

async function transitionRequestedTerminal({
  result,
  fallbackReason,
  store,
  attempt,
  holder,
  clock,
  faultInjector,
}) {
  const terminalStage = requestedTerminalStage(result);
  if (!terminalStage) {
    return null;
  }

  const reason = terminalReason(result, fallbackReason);
  const effectiveTerminalStage =
    attempt.stage === AttemptStage.PROMOTED
    && terminalStage === AttemptStage.CANCELLED
      ? AttemptStage.FAILED
      : terminalStage;
  const verdictCandidate = resolveVerdictCandidate(result);
  const terminalVerdict = verdictCandidate === null
    ? (
        effectiveTerminalStage === AttemptStage.BLOCKED
        && attempt.canonical_verdict === CanonicalVerdict.PASS
          ? CanonicalVerdict.ENV_BLOCK
          : undefined
      )
    : normalizeCanonicalVerdict(
        verdictCandidate,
        "requested terminal verdict",
      );
  return transitionAttempt({
    store,
    attempt,
    holder,
    nextStage: effectiveTerminalStage,
    clock,
    canonicalVerdict: terminalVerdict,
    statePatch: {
      terminal: {
        reason,
        source_stage: attempt.stage,
      },
    },
    lastError: effectiveTerminalStage === AttemptStage.FAILED ? reason : null,
    faultInjector,
  });
}

async function executeTaskLifecycle({
  taskId,
  trigger,
  attemptId = null,
  engineVersion,
}, {
  store,
  handlers,
  holder = `lifecycle:${process.pid}:${randomUUID()}`,
  leaseTtlMs = 30_000,
  heartbeatIntervalMs = null,
  clock = () => new Date(),
  abortSignal = null,
  networkPolicy = {},
  sandboxPolicy = {},
  timeoutMs = null,
  faultInjector = null,
} = {}) {
  const normalizedStore = assertLifecycleStore(store);
  const normalizedHandlers = normalizeHandlers(handlers);
  const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
  const normalizedTrigger = ensureNonEmptyString(trigger, "trigger");
  const normalizedEngineVersion = ensureNonEmptyString(
    engineVersion,
    "engineVersion",
  );
  const normalizedHolder = ensureNonEmptyString(holder, "holder");

  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new TaskLifecycleError("leaseTtlMs must be a positive integer");
  }

  const normalizedHeartbeatInterval = heartbeatIntervalMs ?? Math.max(
    50,
    Math.floor(leaseTtlMs / 3),
  );

  if (!Number.isInteger(normalizedHeartbeatInterval) || normalizedHeartbeatInterval <= 0) {
    throw new TaskLifecycleError("heartbeatIntervalMs must be a positive integer");
  }

  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new TaskLifecycleError("timeoutMs must be a positive integer or null");
  }

  let attempt = await normalizedStore.attempts.createOrResume({
    attemptId,
    taskId: normalizedTaskId,
    trigger: normalizedTrigger,
    engineVersion: normalizedEngineVersion,
    now: clock(),
  });

  if (isTerminalAttemptStage(attempt.stage)) {
    const promotion = await normalizedStore.promotions.byAttempt(attempt.id);
    return createTaskAttemptResult({ attempt, promotion });
  }

  attempt = await normalizedStore.attempts.acquireLease({
    attemptId: attempt.id,
    holder: normalizedHolder,
    now: clock(),
    ttlMs: leaseTtlMs,
  });
  await callFaultInjector(faultInjector, "after:CLAIMED", attempt);

  try {
    for (let transitionCount = 0; transitionCount < 16; transitionCount += 1) {
      if (
        abortSignal?.aborted
        && !isTerminalAttemptStage(attempt.stage)
        && attempt.stage !== AttemptStage.PROMOTED
      ) {
        const recordedPromotion = attempt.stage === AttemptStage.READY_TO_PROMOTE
          ? await normalizedStore.promotions.byAttempt(attempt.id)
          : null;
        if (recordedPromotion?.status === PromotionStatus.PROMOTED) {
          attempt = await transitionAttempt({
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            nextStage: AttemptStage.PROMOTED,
            clock,
            statePatch: { promotion: recordedPromotion },
            faultInjector,
          });
          continue;
        }
        if (!recordedPromotion) {
          attempt = await transitionAttempt({
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            nextStage: AttemptStage.CANCELLED,
            clock,
            statePatch: {
              terminal: {
                reason: "execution aborted",
                source_stage: attempt.stage,
              },
            },
            faultInjector,
          });
        }
      }

      if (isTerminalAttemptStage(attempt.stage)) {
        const promotion = await normalizedStore.promotions.byAttempt(attempt.id);
        return createTaskAttemptResult({ attempt, promotion });
      }

      switch (attempt.stage) {
        case AttemptStage.CLAIMED: {
          const result = await invokeDurableHandler({
            store: normalizedStore,
            handler: normalizedHandlers.prepareWorkspace,
            handlerName: "prepareWorkspace",
            stepStage: AttemptStage.WORKSPACE_PREPARED,
            attempt,
            holder: normalizedHolder,
            leaseTtlMs,
            heartbeatIntervalMs: normalizedHeartbeatInterval,
            clock,
            abortSignal,
            networkPolicy,
            sandboxPolicy,
            timeoutMs,
            recoverHandler: normalizedHandlers.recoverPrepareWorkspace,
          });
          const terminal = await transitionRequestedTerminal({
            result,
            fallbackReason: "workspace preparation stopped the attempt",
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            clock,
            faultInjector,
          });
          if (terminal) {
            attempt = terminal;
            break;
          }

          const workspacePath = readWorkspacePath(result);
          attempt = await transitionAttempt({
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            nextStage: AttemptStage.WORKSPACE_PREPARED,
            clock,
            workspacePath,
            statePatch: { workspace: result },
            faultInjector,
          });
          break;
        }
        case AttemptStage.WORKSPACE_PREPARED: {
          const result = await invokeDurableHandler({
            store: normalizedStore,
            handler: normalizedHandlers.execute,
            handlerName: "execute",
            stepStage: AttemptStage.EXECUTED,
            attempt,
            holder: normalizedHolder,
            leaseTtlMs,
            heartbeatIntervalMs: normalizedHeartbeatInterval,
            clock,
            abortSignal,
            networkPolicy,
            sandboxPolicy,
            timeoutMs,
          });
          const terminal = await transitionRequestedTerminal({
            result,
            fallbackReason: "execution stopped the attempt",
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            clock,
            faultInjector,
          });
          if (terminal) {
            attempt = terminal;
            break;
          }

          attempt = await transitionAttempt({
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            nextStage: AttemptStage.EXECUTED,
            clock,
            statePatch: { execution: result },
            faultInjector,
          });
          break;
        }
        case AttemptStage.EXECUTED: {
          const result = await invokeDurableHandler({
            store: normalizedStore,
            handler: normalizedHandlers.runGates,
            handlerName: "runGates",
            stepStage: AttemptStage.GATES_RUN,
            attempt,
            holder: normalizedHolder,
            leaseTtlMs,
            heartbeatIntervalMs: normalizedHeartbeatInterval,
            clock,
            abortSignal,
            networkPolicy,
            sandboxPolicy,
            timeoutMs,
          });
          const terminal = await transitionRequestedTerminal({
            result,
            fallbackReason: "deterministic gates stopped the attempt",
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            clock,
            faultInjector,
          });
          if (terminal) {
            attempt = terminal;
            break;
          }

          const gateVerdict = resolveGateVerdict(result);
          attempt = await transitionAttempt({
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            nextStage: AttemptStage.GATES_RUN,
            clock,
            statePatch: {
              gates: result,
              gate_verdict: gateVerdict,
            },
            faultInjector,
          });
          break;
        }
        case AttemptStage.GATES_RUN: {
          const result = await invokeDurableHandler({
            store: normalizedStore,
            handler: normalizedHandlers.review,
            handlerName: "review",
            stepStage: AttemptStage.REVIEWED,
            attempt,
            holder: normalizedHolder,
            leaseTtlMs,
            heartbeatIntervalMs: normalizedHeartbeatInterval,
            clock,
            abortSignal,
            networkPolicy,
            sandboxPolicy,
            timeoutMs,
            freshContext: true,
          });
          const terminal = await transitionRequestedTerminal({
            result,
            fallbackReason: "review stopped the attempt",
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            clock,
            faultInjector,
          });
          if (terminal) {
            attempt = terminal;
            break;
          }

          const reviewVerdict = resolveReviewVerdict(result);
          const canonicalVerdict = combineVerdicts(
            normalizeCanonicalVerdict(
              attempt.state.gate_verdict,
              "persisted gate verdict",
            ),
            reviewVerdict,
          );
          attempt = await transitionAttempt({
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            nextStage: AttemptStage.REVIEWED,
            clock,
            canonicalVerdict,
            statePatch: {
              review: result,
              review_verdict: reviewVerdict,
            },
            faultInjector,
          });
          break;
        }
        case AttemptStage.REVIEWED: {
          if (attempt.canonical_verdict !== CanonicalVerdict.PASS) {
            const reason = `promotion blocked by canonical verdict ${attempt.canonical_verdict}`;
            attempt = await transitionAttempt({
              store: normalizedStore,
              attempt,
              holder: normalizedHolder,
              nextStage: AttemptStage.BLOCKED,
              clock,
              statePatch: {
                terminal: {
                  reason,
                  source_stage: AttemptStage.REVIEWED,
                },
              },
              faultInjector,
            });
            break;
          }

          attempt = await transitionAttempt({
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            nextStage: AttemptStage.READY_TO_PROMOTE,
            clock,
            faultInjector,
          });
          break;
        }
        case AttemptStage.READY_TO_PROMOTE: {
          let promotion = await normalizedStore.promotions.prepare({
            attemptId: attempt.id,
            now: clock(),
            metadata: {
              auto_merge: false,
              engine_version: attempt.engine_version,
            },
          });

          if (promotion.status !== PromotionStatus.PROMOTED) {
            const result = await invokeDurableHandler({
              store: normalizedStore,
              handler: normalizedHandlers.promote,
              handlerName: "promote",
              stepStage: AttemptStage.PROMOTED,
              attempt,
              holder: normalizedHolder,
              leaseTtlMs,
              heartbeatIntervalMs: normalizedHeartbeatInterval,
              clock,
              abortSignal,
              networkPolicy,
              sandboxPolicy,
              timeoutMs,
              recoverHandler: normalizedHandlers.recoverPromotion,
              abortBeforeHandler: false,
            });
            const terminal = await transitionRequestedTerminal({
              result,
              fallbackReason: "promotion stopped the attempt",
              store: normalizedStore,
              attempt,
              holder: normalizedHolder,
              clock,
              faultInjector,
            });
            if (terminal) {
              attempt = terminal;
              break;
            }

            promotion = await normalizedStore.promotions.complete({
              attemptId: attempt.id,
              expectedAttemptVersion: attempt.version,
              holder: normalizedHolder,
              targetKind: result.targetKind ?? result.target_kind ?? null,
              targetRef: result.targetRef ?? result.target_ref ?? null,
              branchName: result.branchName ?? result.branch_name ?? null,
              commitSha: result.commitSha ?? result.commit_sha ?? null,
              prUrl: result.prUrl ?? result.pr_url ?? null,
              metadata: result.metadata ?? {},
              now: clock(),
            });
            await callFaultInjector(
              faultInjector,
              "after:promotion_recorded",
              attempt,
            );
          }

          attempt = await transitionAttempt({
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            nextStage: AttemptStage.PROMOTED,
            clock,
            statePatch: { promotion },
            faultInjector,
          });
          break;
        }
        case AttemptStage.PROMOTED: {
          let result = {};
          if (normalizedHandlers.finish) {
            result = await invokeDurableHandler({
              store: normalizedStore,
              handler: normalizedHandlers.finish,
              handlerName: "finish",
              stepStage: AttemptStage.FINISHED,
              attempt,
              holder: normalizedHolder,
              leaseTtlMs,
              heartbeatIntervalMs: normalizedHeartbeatInterval,
              clock,
              abortSignal,
              networkPolicy,
              sandboxPolicy,
              timeoutMs,
              recoverHandler: normalizedHandlers.recoverFinish,
              abortBeforeHandler: false,
            });
          }

          const terminal = await transitionRequestedTerminal({
            result,
            fallbackReason: "finalization stopped the attempt",
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            clock,
            faultInjector,
          });
          if (terminal) {
            attempt = terminal;
            break;
          }

          attempt = await transitionAttempt({
            store: normalizedStore,
            attempt,
            holder: normalizedHolder,
            nextStage: AttemptStage.FINISHED,
            clock,
            statePatch: { finish: result },
            faultInjector,
          });
          break;
        }
        default:
          throw new TaskLifecycleError(
            `task attempt ${attempt.id} has unsupported active stage ${attempt.stage}`,
          );
      }
    }

    throw new TaskLifecycleError(
      `task attempt ${attempt.id} exceeded the lifecycle transition limit`,
    );
  } catch (error) {
    if (abortSignal?.aborted) {
      const current = await normalizedStore.attempts.byId(attempt.id);
      const recordedPromotion = current
        ? await normalizedStore.promotions.byAttempt(current.id)
        : null;
      if (
        current
        && !isTerminalAttemptStage(current.stage)
        && current.stage !== AttemptStage.PROMOTED
        && !recordedPromotion
      ) {
        attempt = await transitionAttempt({
          store: normalizedStore,
          attempt: current,
          holder: normalizedHolder,
          nextStage: AttemptStage.CANCELLED,
          clock,
          statePatch: {
            terminal: {
              reason: "execution aborted",
              source_stage: current.stage,
            },
          },
          faultInjector,
        });
        const promotion = await normalizedStore.promotions.byAttempt(attempt.id);
        return createTaskAttemptResult({ attempt, promotion });
      }
    }
    if (
      error instanceof TaskLifecycleBlockedError
      || error instanceof TaskLifecycleFailedError
      || isExplicitlyNonRetryable(error)
    ) {
      const current = await normalizedStore.attempts.byId(attempt.id);
      if (current && !isTerminalAttemptStage(current.stage)) {
        const blockedRequested = (
          error instanceof TaskLifecycleBlockedError
          || isExplicitlyNonRetryable(error)
        );
        const nextStage = blockedRequested
          && current.stage !== AttemptStage.PROMOTED
          ? AttemptStage.BLOCKED
          : AttemptStage.FAILED;
        attempt = await transitionAttempt({
          store: normalizedStore,
          attempt: current,
          holder: normalizedHolder,
          nextStage,
          clock,
          statePatch: {
            terminal: {
              reason: error.message,
              source_stage: current.stage,
            },
          },
          lastError: nextStage === AttemptStage.FAILED ? error.message : null,
          faultInjector,
        });
        const promotion = await normalizedStore.promotions.byAttempt(attempt.id);
        return createTaskAttemptResult({ attempt, promotion });
      }
    }

    throw error;
  } finally {
    await normalizedStore.attempts.releaseLease({
      attemptId: attempt.id,
      holder: normalizedHolder,
      now: clock(),
    });
  }
}

function createTaskLifecycleExecutor(options = {}) {
  assertLifecycleStore(options.store);
  normalizeHandlers(options.handlers);

  return Object.freeze({
    executeTaskLifecycle(input) {
      return executeTaskLifecycle(input, options);
    },
  });
}

function isExplicitlyNonRetryable(error) {
  return Boolean(
    error
    && typeof error === "object"
    && (
      error.retrySafe === false
      || error.retry_safe === false
    )
  );
}

export {
  REQUIRED_LIFECYCLE_HANDLERS,
  TaskLifecycleBlockedError,
  TaskLifecycleError,
  TaskLifecycleFailedError,
  combineVerdicts,
  createTaskLifecycleExecutor,
  executeTaskLifecycle,
  resolveGateVerdict,
  resolveReviewVerdict,
};
