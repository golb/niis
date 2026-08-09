import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import {
  RELIABILITY_RC_CONCURRENCY,
  ReliabilityRcPolicyError,
  assertReliabilityRcAttemptWorkspace,
  enforceReliabilityRcExecutionPolicy,
  enforceReliabilityRcMergePolicy,
  finalizeReliabilityRcAttemptWorkspace,
  prepareReliabilityRcAttemptWorkspace,
} from "./reliability-rc.js";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function setupFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-rc-policy-"));
  const repositoryPath = path.join(root, "repository");
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(repositoryPath, { recursive: true });
  git(repositoryPath, "init", "-b", "main");
  git(repositoryPath, "config", "user.name", "RC Policy Test");
  git(repositoryPath, "config", "user.email", "rc-policy@example.com");
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "seed\n");
  git(repositoryPath, "add", "README.md");
  git(repositoryPath, "commit", "-m", "seed");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return { repositoryPath, stateRoot };
}

function primaryState(repositoryPath) {
  return {
    branch: git(repositoryPath, "branch", "--show-current"),
    head: git(repositoryPath, "rev-parse", "HEAD"),
    status: git(repositoryPath, "status", "--porcelain=v1"),
  };
}

test("Reliability RC fixes all execution concurrency at one", () => {
  const policy = enforceReliabilityRcExecutionPolicy({
    routingPolicy: { max_parallel: 8, policy_refs: ["routing/test/v1"] },
    workerConfig: { enabled: true, max_concurrent: 6 },
  });

  assert.equal(RELIABILITY_RC_CONCURRENCY, 1);
  assert.equal(policy.concurrency, 1);
  assert.equal(policy.routing_policy.max_parallel, 1);
  assert.deepEqual(policy.routing_policy.policy_refs, ["routing/test/v1"]);
  assert.equal(policy.worker_config.max_concurrent, 1);
  assert.equal(policy.worker_config.enabled, true);
});

test("Reliability RC disables task-branch checkout and forces isolated single-shot work", () => {
  const policy = enforceReliabilityRcMergePolicy({
    base_branch: "release",
    branch_per_task: true,
    isolate_single_shot: false,
    mode: "auto_merge",
  });

  assert.equal(policy.base_branch, "release");
  assert.equal(policy.branch_per_task, false);
  assert.equal(policy.isolate_single_shot, true);
  assert.equal(policy.mode, "review");
  assert.equal(policy.requested_mode, "auto_merge");
  assert.equal(policy.reliability_rc_override, "auto_merge_disabled");
});

test("Reliability RC prepares only the attempt-owned worktree and leaves primary untouched", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "operator edit\n");
  const before = primaryState(repositoryPath);
  const prepared = prepareReliabilityRcAttemptWorkspace({
    repositoryPath,
    stateRoot,
    taskId: "task-1",
    attemptId: "attempt-1",
  });

  const checked = assertReliabilityRcAttemptWorkspace({
    repositoryPath,
    stateRoot,
    taskId: "task-1",
    attemptId: "attempt-1",
    workspacePath: prepared.worktree_path,
  });

  assert.equal(checked.workspace_path, prepared.worktree_path);
  assert.notEqual(checked.workspace_path, checked.repository_root);
  assert.deepEqual(primaryState(repositoryPath), before);
  assert.throws(
    () => assertReliabilityRcAttemptWorkspace({
      repositoryPath,
      stateRoot,
      taskId: "task-1",
      attemptId: "attempt-1",
      workspacePath: repositoryPath,
    }),
    (error) => (
      error instanceof ReliabilityRcPolicyError
      && error.code === "primary_checkout_execution_forbidden"
    ),
  );
});

test("Reliability RC fails closed when worktree preparation cannot establish ownership", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  const collision = path.join(
    stateRoot,
    "worktrees",
    "attempts",
    "task-2",
    "attempt-2",
    "workspace",
  );
  fs.mkdirSync(collision, { recursive: true });
  fs.writeFileSync(path.join(collision, "operator.txt"), "do not replace\n");

  assert.throws(
    () => prepareReliabilityRcAttemptWorkspace({
      repositoryPath,
      stateRoot,
      taskId: "task-2",
      attemptId: "attempt-2",
    }),
    (error) => (
      error instanceof ReliabilityRcPolicyError
      && error.code === "attempt_workspace_preparation_failed"
      && error.retrySafe === false
      && error.worktreeErrorCode === "unowned_worktree_path"
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(collision, "operator.txt"), "utf8"),
    "do not replace\n",
  );
});

test("failed gates and reviewable PASS both preserve the attempt worktree", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  const failed = prepareReliabilityRcAttemptWorkspace({
    repositoryPath,
    stateRoot,
    taskId: "task-3",
    attemptId: "attempt-failed",
  });
  fs.writeFileSync(path.join(failed.worktree_path, "evidence.txt"), "failed gate\n");

  const failedFinalization = finalizeReliabilityRcAttemptWorkspace({
    sidecarPath: failed.sidecar_path,
    canonicalVerdict: "EVIDENCE_GAP",
    promoted: false,
    reason: "deterministic gate failed",
  });
  assert.equal(failedFinalization.preserved, true);
  assert.equal(fs.existsSync(failed.worktree_path), true);

  const review = prepareReliabilityRcAttemptWorkspace({
    repositoryPath,
    stateRoot,
    taskId: "task-3",
    attemptId: "attempt-review",
  });
  const reviewFinalization = finalizeReliabilityRcAttemptWorkspace({
    sidecarPath: review.sidecar_path,
    canonicalVerdict: "PASS",
    promoted: false,
  });
  assert.equal(reviewFinalization.preserved, true);
  assert.equal(fs.existsSync(review.worktree_path), true);
  assert.match(reviewFinalization.sidecar.preserved_reason, /not been promoted/);
});
