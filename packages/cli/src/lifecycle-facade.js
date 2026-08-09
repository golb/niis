import {
  AttemptStage,
  CanonicalVerdict,
  executeTaskLifecycle,
} from "../../core/src/index.js";

const TERMINAL_FAILURE_STATUSES = new Set([
  "BLOCKED",
  "FAILED",
  "REJECTED",
]);

function ensureObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function resolveTaskResult(state) {
  return state?.execution?.task_result ?? null;
}

function canonicalVerdictFromTaskResult(taskResult) {
  const result = ensureObject(taskResult, "taskResult");
  const explicit = result.final_verdict?.verdict_class
    ?? result.final_verdict?.verdictClass
    ?? result.canonical_verdict
    ?? null;

  if (explicit && Object.values(CanonicalVerdict).includes(explicit)) {
    return explicit;
  }

  const status = result.final_task?.status ?? result.final_status ?? null;
  if (status === "DONE" || status === "IN_REVIEW") {
    return CanonicalVerdict.PASS;
  }
  if (status === "BLOCKED") {
    return CanonicalVerdict.ENV_BLOCK;
  }
  if (status === "REJECTED" || status === "FAILED") {
    return CanonicalVerdict.DEFECT;
  }

  return CanonicalVerdict.EVIDENCE_GAP;
}

function executionFailureVerdict(taskResult) {
  const result = ensureObject(taskResult, "taskResult");
  const runStatus = String(
    result.run_record?.status
    ?? result.final_response?.status
    ?? "",
  ).toUpperCase();
  if (["FAILED", "ERROR", "TIMED_OUT", "CANCELLED"].includes(runStatus)) {
    return runStatus === "FAILED" || runStatus === "ERROR"
      ? CanonicalVerdict.DEFECT
      : CanonicalVerdict.ENV_BLOCK;
  }
  if (!result.run_record && TERMINAL_FAILURE_STATUSES.has(
    result.final_task?.status ?? result.final_status ?? "",
  )) {
    return canonicalVerdictFromTaskResult(result);
  }
  return null;
}

function createCliLifecycleHandlers({
  executeTask,
  finishTask = null,
  prepareWorkspace = null,
  promoteTask,
  reviewTask = null,
  runGates = null,
  workspacePath,
} = {}) {
  if (typeof executeTask !== "function") {
    throw new Error("executeTask must be a function");
  }
  if (typeof promoteTask !== "function") {
    throw new Error("promoteTask must be a function");
  }
  if (runGates !== null && typeof runGates !== "function") {
    throw new Error("runGates must be a function when provided");
  }
  if (reviewTask !== null && typeof reviewTask !== "function") {
    throw new Error("reviewTask must be a function when provided");
  }
  if (
    typeof prepareWorkspace !== "function"
    && (typeof workspacePath !== "string" || workspacePath.trim() === "")
  ) {
    throw new Error("workspacePath is required");
  }

  return Object.freeze({
    async prepareWorkspace(context) {
      if (prepareWorkspace) {
        return prepareWorkspace(context);
      }
      return { workspacePath };
    },
    async recoverPrepareWorkspace(context) {
      if (prepareWorkspace) {
        return prepareWorkspace(context);
      }
      return { workspacePath };
    },
    async execute(context) {
      return {
        task_result: ensureObject(
          await executeTask(context),
          "executeTask result",
        ),
      };
    },
    async runGates(context) {
      const taskResult = resolveTaskResult(context.state);
      const taskVerdict = canonicalVerdictFromTaskResult(taskResult);
      if (runGates) {
        const gateResult = ensureObject(
          await runGates({ ...context, taskResult }),
          "runGates result",
        );
        const explicitGateVerdict =
          gateResult.canonical_verdict
          ?? gateResult.canonicalVerdict
          ?? null;
        const cancelled =
          (gateResult.terminal_stage ?? gateResult.terminalStage) === AttemptStage.CANCELLED;
        const canonicalVerdict = cancelled
          ? null
          : executionFailureVerdict(taskResult)
            ?? explicitGateVerdict
            ?? (gateResult.ok === true
              ? CanonicalVerdict.PASS
              : CanonicalVerdict.EVIDENCE_GAP);
        return {
          ...gateResult,
          canonical_verdict: canonicalVerdict,
          deterministic: true,
        };
      }
      return {
        canonical_verdict: taskVerdict,
        deterministic: true,
        source: "persisted_task_result",
      };
    },
    async review(context) {
      const taskResult = resolveTaskResult(context.state);
      const taskVerdict = canonicalVerdictFromTaskResult(taskResult);
      if (reviewTask) {
        const reviewResult = ensureObject(
          await reviewTask({
            ...context,
            gateResult: context.state.gates ?? null,
            taskResult,
          }),
          "reviewTask result",
        );
        const reviewVerdict =
          reviewResult.canonical_verdict
          ?? reviewResult.canonicalVerdict
          ?? null;
        const cancelled =
          (reviewResult.terminal_stage ?? reviewResult.terminalStage)
          === AttemptStage.CANCELLED;
        return {
          ...reviewResult,
          canonical_verdict: cancelled
            ? null
            : executionFailureVerdict(taskResult)
              ?? reviewVerdict
              ?? CanonicalVerdict.EVIDENCE_GAP,
          fresh_context: context.freshContext === true,
        };
      }
      return {
        canonical_verdict: taskVerdict,
        fresh_context: context.freshContext === true,
        source: "persisted_canonical_review",
      };
    },
    async promote(context) {
      const taskResult = resolveTaskResult(context.state);
      const target = await promoteTask({ ...context, taskResult });
      return ensureObject(target, "promoteTask result");
    },
    async recoverPromotion(context) {
      const taskResult = resolveTaskResult(context.state);
      const target = await promoteTask({ ...context, taskResult });
      return ensureObject(target, "promoteTask recovery result");
    },
    async finish(context) {
      const taskResult = resolveTaskResult(context.state);
      if (finishTask) {
        return ensureObject(
          await finishTask({ ...context, taskResult }),
          "finishTask result",
        );
      }
      return {
        final_status:
          taskResult?.final_task?.status
          ?? taskResult?.final_status
          ?? "DONE",
      };
    },
    async recoverFinish(context) {
      const taskResult = resolveTaskResult(context.state);
      if (finishTask) {
        return ensureObject(
          await finishTask({ ...context, taskResult }),
          "finishTask recovery result",
        );
      }
      return {
        final_status:
          taskResult?.final_task?.status
          ?? taskResult?.final_status
          ?? "DONE",
      };
    },
  });
}

async function executeCliTaskLifecycle({
  taskId,
  trigger,
  attemptId = null,
  engineVersion,
  store,
  workspacePath,
  executeTask,
  finishTask = null,
  prepareWorkspace = null,
  promoteTask = null,
  reviewTask = null,
  runGates = null,
  holder = undefined,
  abortSignal = null,
  networkPolicy = {},
  sandboxPolicy = {},
  timeoutMs = null,
} = {}) {
  const active = attemptId
    ? await store.attempts.byId(attemptId)
    : await store.attempts.activeByTask(taskId);
  const effectiveAttemptId = active?.id ?? attemptId;
  const effectiveTrigger = active?.trigger ?? trigger;
  const effectiveEngineVersion = active?.engine_version ?? engineVersion;
  const handlers = createCliLifecycleHandlers({
    executeTask,
    finishTask,
    prepareWorkspace,
    promoteTask,
    reviewTask,
    runGates,
    workspacePath,
  });
  const options = {
    abortSignal,
    handlers,
    networkPolicy,
    sandboxPolicy,
    store,
    timeoutMs,
  };
  if (holder !== undefined) {
    options.holder = holder;
  }

  return executeTaskLifecycle({
    attemptId: effectiveAttemptId,
    engineVersion: effectiveEngineVersion,
    taskId,
    trigger: effectiveTrigger,
  }, options);
}

function durableQueueStateFromAttempt(result) {
  if (result.stage === AttemptStage.FINISHED) return "COMPLETED";
  if (result.stage === AttemptStage.BLOCKED) return "BLOCKED";
  if (result.stage === AttemptStage.CANCELLED) return "CANCELLED";
  if (result.stage === AttemptStage.FAILED) return "FAILED";
  return null;
}

function taskResultFromAttempt(result) {
  const taskResult = result?.state?.execution?.task_result ?? null;
  if (!taskResult) return null;
  let compatibleStatus = null;
  if (result.stage === AttemptStage.FINISHED) {
    compatibleStatus = result.canonical_verdict === CanonicalVerdict.PASS
      ? "IN_REVIEW"
      : "BLOCKED";
  } else if (
    [
      AttemptStage.BLOCKED,
      AttemptStage.CANCELLED,
      AttemptStage.FAILED,
    ].includes(result.stage)
  ) {
    compatibleStatus = "BLOCKED";
  }
  if (!compatibleStatus) return taskResult;
  return {
    ...taskResult,
    final_task: {
      ...(taskResult.final_task ?? {}),
      status: compatibleStatus,
    },
    final_verdict: {
      ...(taskResult.final_verdict ?? {}),
      reason:
        result.state?.review?.reason
        ?? taskResult.final_verdict?.reason
        ?? `durable attempt ended at ${result.stage}`,
      verdict_class: result.canonical_verdict,
    },
  };
}

function taskResultFailed(taskResult) {
  const status = taskResult?.final_task?.status ?? taskResult?.final_status;
  return TERMINAL_FAILURE_STATUSES.has(status);
}

export {
  canonicalVerdictFromTaskResult,
  createCliLifecycleHandlers,
  durableQueueStateFromAttempt,
  executionFailureVerdict,
  executeCliTaskLifecycle,
  taskResultFailed,
  taskResultFromAttempt,
};
