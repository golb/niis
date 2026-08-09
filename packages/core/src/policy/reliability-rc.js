import path from "node:path";

import {
  AttemptWorktreeError,
  createAttemptWorktreePaths,
  prepareAttemptWorktree,
  preserveAttemptWorktree,
  removeAttemptWorktreeOnSuccess,
  resolveRepositoryRoot,
} from "../runtime/attempt-worktree.js";
import { canonicalizePath } from "../runtime/path-safety.js";

const RELIABILITY_RC_CONCURRENCY = 1;

class ReliabilityRcPolicyError extends Error {
  constructor(message, {
    code = "reliability_rc_policy_error",
    cause = undefined,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReliabilityRcPolicyError";
    this.code = code;
    this.retrySafe = false;
    this.retry_safe = false;
  }
}

function ensurePlainObject(value, label) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ReliabilityRcPolicyError(`${label} must be a plain object`);
  }

  return value;
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReliabilityRcPolicyError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function enforceReliabilityRcMergePolicy(mergePolicy = {}) {
  const normalized = ensurePlainObject(mergePolicy, "mergePolicy");
  const requestedMode = typeof normalized.mode === "string"
    ? normalized.mode
    : "none";
  const mode = requestedMode === "auto_merge" ? "review" : requestedMode;

  return Object.freeze({
    ...normalized,
    branch_per_task: false,
    isolate_single_shot: true,
    mode,
    ...(requestedMode === "auto_merge"
      ? {
          requested_mode: requestedMode,
          reliability_rc_override: "auto_merge_disabled",
        }
      : {}),
  });
}

function enforceReliabilityRcRoutingPolicy(routingPolicy = {}) {
  const normalized = ensurePlainObject(routingPolicy, "routingPolicy");

  return Object.freeze({
    ...normalized,
    max_parallel: RELIABILITY_RC_CONCURRENCY,
  });
}

function enforceReliabilityRcWorkerConfig(workerConfig = {}) {
  const normalized = ensurePlainObject(workerConfig, "workerConfig");

  return Object.freeze({
    ...normalized,
    max_concurrent: RELIABILITY_RC_CONCURRENCY,
  });
}

function enforceReliabilityRcExecutionPolicy({
  mergePolicy = {},
  routingPolicy = {},
  workerConfig = {},
} = {}) {
  return Object.freeze({
    concurrency: RELIABILITY_RC_CONCURRENCY,
    merge_policy: enforceReliabilityRcMergePolicy(mergePolicy),
    routing_policy: enforceReliabilityRcRoutingPolicy(routingPolicy),
    worker_config: enforceReliabilityRcWorkerConfig(workerConfig),
  });
}

function assertReliabilityRcAttemptWorkspace({
  repositoryPath,
  stateRoot,
  taskId,
  attemptId,
  workspacePath,
} = {}) {
  const repositoryRoot = canonicalizePath(resolveRepositoryRoot(repositoryPath));
  const paths = createAttemptWorktreePaths({ stateRoot, taskId, attemptId });
  const resolvedWorkspacePath = canonicalizePath(
    ensureNonEmptyString(workspacePath, "workspacePath"),
  );

  if (resolvedWorkspacePath === repositoryRoot) {
    throw new ReliabilityRcPolicyError(
      "Reliability RC refuses execution in the primary checkout",
      { code: "primary_checkout_execution_forbidden" },
    );
  }

  if (resolvedWorkspacePath !== canonicalizePath(paths.worktree_path)) {
    throw new ReliabilityRcPolicyError(
      `Reliability RC workspace must be the attempt-owned worktree ${paths.worktree_path}`,
      { code: "attempt_workspace_mismatch" },
    );
  }

  const relativePath = path.relative(
    canonicalizePath(paths.state_root),
    resolvedWorkspacePath,
  );
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new ReliabilityRcPolicyError(
      "Reliability RC attempt worktree must be contained by stateRoot",
      { code: "attempt_workspace_outside_state" },
    );
  }

  return Object.freeze({
    attempt_root: paths.attempt_root,
    repository_root: repositoryRoot,
    state_root: paths.state_root,
    workspace_path: resolvedWorkspacePath,
  });
}

function prepareReliabilityRcAttemptWorkspace(options = {}) {
  try {
    const worktree = prepareAttemptWorktree(options);
    assertReliabilityRcAttemptWorkspace({
      ...options,
      workspacePath: worktree.worktree_path,
    });
    return worktree;
  } catch (error) {
    if (error instanceof ReliabilityRcPolicyError) {
      throw error;
    }

    const wrapped = new ReliabilityRcPolicyError(
      `Reliability RC could not prepare an isolated attempt worktree: ${error.message}`,
      {
        code: "attempt_workspace_preparation_failed",
        cause: error,
      },
    );
    if (error instanceof AttemptWorktreeError) {
      wrapped.worktreeErrorCode = error.code;
      wrapped.worktree_error_code = error.code;
    }
    throw wrapped;
  }
}

function finalizeReliabilityRcAttemptWorkspace({
  canonicalVerdict = null,
  promoted = false,
  reason = null,
  ...worktreeOptions
} = {}) {
  if (canonicalVerdict !== "PASS" || promoted !== true) {
    return preserveAttemptWorktree({
      ...worktreeOptions,
      reason: reason ?? (
        canonicalVerdict === "PASS"
          ? "reviewable attempt has not been promoted"
          : `canonical verdict ${canonicalVerdict ?? "unavailable"} requires preservation`
      ),
    });
  }

  return removeAttemptWorktreeOnSuccess({
    ...worktreeOptions,
    success: true,
  });
}

export {
  RELIABILITY_RC_CONCURRENCY,
  ReliabilityRcPolicyError,
  assertReliabilityRcAttemptWorkspace,
  enforceReliabilityRcExecutionPolicy,
  enforceReliabilityRcMergePolicy,
  enforceReliabilityRcRoutingPolicy,
  enforceReliabilityRcWorkerConfig,
  finalizeReliabilityRcAttemptWorkspace,
  prepareReliabilityRcAttemptWorkspace,
};
