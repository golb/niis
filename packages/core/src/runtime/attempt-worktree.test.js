import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import {
  AttemptWorktreeError,
  captureAttemptWorktreeDiff,
  capturePrimaryCheckoutReadinessDigest,
  commitAttemptWorktreeChanges,
  createOrReuseAttemptWorktree,
  ensureAttemptWorktreePromotionCommit,
  finalizeAttemptWorktree,
  readAttemptWorktreeSidecar,
  removeAttemptWorktreeOnSuccess,
} from "./attempt-worktree.js";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function setupFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-attempt-worktree-"));
  const repositoryPath = path.join(root, "repository");
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(repositoryPath, { recursive: true });
  git(repositoryPath, "init", "-b", "main");
  git(repositoryPath, "config", "user.name", "Attempt Worktree Test");
  git(repositoryPath, "config", "user.email", "attempt-worktree@example.com");
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "seed\n");
  git(repositoryPath, "add", "README.md");
  git(repositoryPath, "commit", "-m", "seed");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return { repositoryPath, root, stateRoot };
}

function primaryState(repositoryPath) {
  return {
    branch: git(repositoryPath, "branch", "--show-current"),
    head: git(repositoryPath, "rev-parse", "HEAD"),
    status: git(repositoryPath, "status", "--porcelain=v1"),
  };
}

test("attempt worktree roots reject non-canonical task IDs", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  for (const taskId of [
    ".",
    "..",
    "../escape",
    "task/escape",
    "TASK",
    "task_name",
    "ｔａｓｋ",
  ]) {
    assert.throws(
      () => createOrReuseAttemptWorktree({
        attemptId: "attempt-safe",
        repositoryPath,
        stateRoot,
        taskId,
      }),
      /canonical lower-case ASCII task id/,
      taskId,
    );
  }
  assert.equal(fs.existsSync(path.join(stateRoot, "worktrees")), false);
});

test("attempt worktree creation rejects a symlinked task root", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  const attemptsRoot = path.join(stateRoot, "worktrees", "attempts");
  const externalRoot = path.join(stateRoot, "external-attempt-root");
  fs.mkdirSync(attemptsRoot, { recursive: true });
  fs.mkdirSync(externalRoot, { recursive: true });
  fs.writeFileSync(path.join(externalRoot, "sentinel.txt"), "must remain\n");
  fs.symlinkSync(
    externalRoot,
    path.join(attemptsRoot, "task-alias"),
    "dir",
  );

  assert.throws(
    () => createOrReuseAttemptWorktree({
      attemptId: "attempt-safe",
      repositoryPath,
      stateRoot,
      taskId: "task-alias",
    }),
    (error) => (
      error instanceof AttemptWorktreeError
      && error.code === "unsafe_attempt_path"
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(externalRoot, "sentinel.txt"), "utf8"),
    "must remain\n",
  );
});

test("attempt worktree creation and reuse preserve a dirty primary checkout", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "operator edit\n");
  fs.writeFileSync(path.join(repositoryPath, "scratch.txt"), "operator scratch\n");
  const before = primaryState(repositoryPath);

  const created = createOrReuseAttemptWorktree({
    repositoryPath,
    stateRoot,
    taskId: "task-1",
    attemptId: "attempt-1",
    now: "2026-07-23T10:00:00.000Z",
  });
  const reused = createOrReuseAttemptWorktree({
    repositoryPath,
    stateRoot,
    taskId: "task-1",
    attemptId: "attempt-1",
    now: "2026-07-23T10:00:01.000Z",
  });

  assert.equal(created.reused, false);
  assert.equal(reused.reused, true);
  assert.equal(reused.worktree_path, created.worktree_path);
  assert.equal(git(created.worktree_path, "branch", "--show-current"), "");
  assert.equal(
    git(repositoryPath, "branch", "--list", created.branch_name),
    "",
  );
  assert.equal(fs.readFileSync(path.join(created.worktree_path, "README.md"), "utf8"), "seed\n");
  assert.deepEqual(primaryState(repositoryPath), before);
  assert.equal(fs.readFileSync(path.join(repositoryPath, "README.md"), "utf8"), "operator edit\n");
  assert.equal(fs.readFileSync(path.join(repositoryPath, "scratch.txt"), "utf8"), "operator scratch\n");
  assert.equal(
    fs.statSync(created.sidecar_path).mode & 0o777,
    0o600,
  );
});

test("primary checkout readiness digest is stable across attempt worktree operations", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "operator edit\n");
  fs.writeFileSync(path.join(repositoryPath, "scratch.txt"), "operator scratch\n");
  const before = capturePrimaryCheckoutReadinessDigest(repositoryPath);

  const worktree = createOrReuseAttemptWorktree({
    repositoryPath,
    stateRoot,
    taskId: "task-digest",
    attemptId: "attempt-digest",
  });
  fs.writeFileSync(path.join(worktree.worktree_path, "task.txt"), "task edit\n");
  const reviewed = captureAttemptWorktreeDiff({
    sidecarPath: worktree.sidecar_path,
  });
  commitAttemptWorktreeChanges({
    sidecarPath: worktree.sidecar_path,
    canonicalVerdict: "PASS",
    expectedTaskSnapshotSha256: reviewed.task_snapshot_sha256,
  });
  finalizeAttemptWorktree({
    sidecarPath: worktree.sidecar_path,
    outcome: "success",
  });

  assert.equal(
    capturePrimaryCheckoutReadinessDigest(repositoryPath),
    before,
  );
});

test("primary checkout readiness digest detects content changes in an already dirty path", (t) => {
  const { repositoryPath } = setupFixture(t);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "dirty-one\n");
  const before = capturePrimaryCheckoutReadinessDigest(repositoryPath);

  fs.writeFileSync(path.join(repositoryPath, "README.md"), "dirty-two\n");

  assert.notEqual(
    capturePrimaryCheckoutReadinessDigest(repositoryPath),
    before,
  );
});

test("primary checkout readiness digest includes ignored environment and config files", (t) => {
  const { repositoryPath } = setupFixture(t);
  fs.writeFileSync(
    path.join(repositoryPath, ".gitignore"),
    ".env\nconfig.local/\n",
  );
  git(repositoryPath, "add", ".gitignore");
  git(repositoryPath, "commit", "-m", "ignore local config");
  fs.mkdirSync(path.join(repositoryPath, "config.local"));
  fs.writeFileSync(path.join(repositoryPath, ".env"), "TOKEN=one\n");
  fs.writeFileSync(
    path.join(repositoryPath, "config.local", "runtime.json"),
    "{\"mode\":\"one\"}\n",
  );
  const initial = capturePrimaryCheckoutReadinessDigest(repositoryPath);

  fs.writeFileSync(path.join(repositoryPath, ".env"), "TOKEN=two\n");
  const environmentChanged = capturePrimaryCheckoutReadinessDigest(repositoryPath);
  assert.notEqual(environmentChanged, initial);

  fs.writeFileSync(
    path.join(repositoryPath, "config.local", "runtime.json"),
    "{\"mode\":\"two\"}\n",
  );
  assert.notEqual(
    capturePrimaryCheckoutReadinessDigest(repositoryPath),
    environmentChanged,
  );
});

test("primary checkout readiness digest excludes state, dependencies, caches, and worktrees", (t) => {
  const { repositoryPath } = setupFixture(t);
  fs.writeFileSync(
    path.join(repositoryPath, ".gitignore"),
    ".niis/\nnode_modules/\n.cache/\nworktrees/\n",
  );
  git(repositoryPath, "add", ".gitignore");
  git(repositoryPath, "commit", "-m", "ignore runtime directories");
  const excludedFiles = [
    [".niis", "state.db"],
    ["node_modules", "dependency.js"],
    [".cache", "entry"],
    ["worktrees", "attempt", "workspace.txt"],
  ];
  for (const segments of excludedFiles) {
    const filePath = path.join(repositoryPath, ...segments);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "one\n");
  }
  const before = capturePrimaryCheckoutReadinessDigest(repositoryPath);

  for (const segments of excludedFiles) {
    fs.writeFileSync(path.join(repositoryPath, ...segments), "two\n");
  }

  assert.equal(
    capturePrimaryCheckoutReadinessDigest(repositoryPath),
    before,
  );
});

test("diff and commit are scoped to the attempt worktree and require PASS", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  const primaryBefore = primaryState(repositoryPath);
  const worktree = createOrReuseAttemptWorktree({
    repositoryPath,
    stateRoot,
    taskId: "task-2",
    attemptId: "attempt-2",
  });
  fs.writeFileSync(path.join(worktree.worktree_path, "README.md"), "task edit\n");
  fs.writeFileSync(path.join(worktree.worktree_path, "feature.txt"), "task-only\n");
  const diff = captureAttemptWorktreeDiff({
    sidecarPath: worktree.sidecar_path,
  });

  assert.equal(
    git(repositoryPath, "branch", "--list", worktree.branch_name),
    "",
  );
  assert.equal(diff.clean, false);
  assert.deepEqual(diff.changed_files, ["README.md", "feature.txt"]);
  assert.deepEqual(diff.untracked_files, ["feature.txt"]);
  assert.match(diff.tracked_diff, /task edit/);
  assert.throws(
    () => commitAttemptWorktreeChanges({
      sidecarPath: worktree.sidecar_path,
      canonicalVerdict: "DEFECT",
    }),
    /requires canonicalVerdict PASS/,
  );

  const committed = commitAttemptWorktreeChanges({
    sidecarPath: worktree.sidecar_path,
    canonicalVerdict: "PASS",
    expectedTaskSnapshotSha256: diff.task_snapshot_sha256,
    now: "2026-07-23T10:05:00.000Z",
  });

  assert.equal(committed.committed, true);
  assert.match(committed.diff.staged_diff, /feature\.txt/);
  assert.equal(
    git(repositoryPath, "rev-parse", worktree.branch_name),
    committed.commit_sha,
  );
  assert.equal(committed.branch_created, true);
  assert.equal(committed.promotion_ready, true);
  assert.deepEqual(primaryState(repositoryPath), primaryBefore);
  assert.equal(fs.existsSync(path.join(repositoryPath, "feature.txt")), false);
  assert.equal(fs.readFileSync(path.join(repositoryPath, "README.md"), "utf8"), "seed\n");
});

test("promotion rejects an earlier commit even when later edits match fresh review", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  const worktree = createOrReuseAttemptWorktree({
    repositoryPath,
    stateRoot,
    taskId: "task-mixed-delta",
    attemptId: "attempt-mixed-delta",
  });
  fs.writeFileSync(path.join(worktree.worktree_path, "README.md"), "agent commit\n");
  git(worktree.worktree_path, "add", "README.md");
  git(worktree.worktree_path, "commit", "-m", "agent change");
  fs.writeFileSync(path.join(worktree.worktree_path, "README.md"), "staged edit\n");
  git(worktree.worktree_path, "add", "README.md");
  fs.writeFileSync(path.join(worktree.worktree_path, "README.md"), "final edit\n");
  fs.writeFileSync(path.join(worktree.worktree_path, "later.txt"), "untracked evidence\n");

  const reviewed = captureAttemptWorktreeDiff({
    sidecarPath: worktree.sidecar_path,
  });

  assert.equal(reviewed.clean, false);
  assert.equal(reviewed.has_committed_changes, true);
  assert.equal(reviewed.has_uncommitted_changes, true);
  assert.deepEqual(reviewed.changed_files, ["README.md", "later.txt"]);
  assert.match(reviewed.committed_diff, /agent commit/);
  assert.match(reviewed.uncommitted_tracked_diff, /final edit/);
  assert.match(reviewed.tracked_diff, /final edit/);
  assert.match(reviewed.untracked_diff, /untracked evidence/);
  assert.match(reviewed.full_diff, /final edit/);
  assert.match(reviewed.full_diff, /untracked evidence/);
  assert.equal(
    git(repositoryPath, "branch", "--list", worktree.branch_name),
    "",
  );

  assert.throws(
    () => ensureAttemptWorktreePromotionCommit({
      canonicalVerdict: "PASS",
      expectedTaskSnapshotSha256: reviewed.task_snapshot_sha256,
      sidecarPath: worktree.sidecar_path,
    }),
    (error) => (
      error instanceof AttemptWorktreeError
      && error.code === "pre_review_commit_forbidden"
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(worktree.worktree_path, "README.md"), "utf8"),
    "final edit\n",
  );
  assert.equal(
    fs.readFileSync(path.join(worktree.worktree_path, "later.txt"), "utf8"),
    "untracked evidence\n",
  );
  assert.equal(
    git(repositoryPath, "branch", "--list", worktree.branch_name),
    "",
  );
  assert.equal(readAttemptWorktreeSidecar(worktree.sidecar_path).status, "ACTIVE");
});

test("promotion rejects a clean commit created before the promotion gate", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  const worktree = createOrReuseAttemptWorktree({
    repositoryPath,
    stateRoot,
    taskId: "task-clean-commit",
    attemptId: "attempt-clean-commit",
  });
  fs.writeFileSync(path.join(worktree.worktree_path, "agent.txt"), "committed\n");
  git(worktree.worktree_path, "add", "agent.txt");
  git(worktree.worktree_path, "commit", "-m", "agent commit");
  const reviewed = captureAttemptWorktreeDiff({
    sidecarPath: worktree.sidecar_path,
  });

  assert.equal(
    git(repositoryPath, "branch", "--list", worktree.branch_name),
    "",
  );
  assert.throws(
    () => ensureAttemptWorktreePromotionCommit({
      canonicalVerdict: "PASS",
      expectedTaskSnapshotSha256: reviewed.task_snapshot_sha256,
      sidecarPath: worktree.sidecar_path,
    }),
    (error) => (
      error instanceof AttemptWorktreeError
      && error.code === "pre_review_commit_forbidden"
    ),
  );
  assert.equal(
    readAttemptWorktreeSidecar(worktree.sidecar_path).status,
    "ACTIVE",
  );
});

test("review diff from base includes a clean committed task change", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  const worktree = createOrReuseAttemptWorktree({
    repositoryPath,
    stateRoot,
    taskId: "task-review-base",
    attemptId: "attempt-review-base",
  });
  fs.writeFileSync(path.join(worktree.worktree_path, "README.md"), "review this\n");
  git(worktree.worktree_path, "add", "README.md");
  git(worktree.worktree_path, "commit", "-m", "reviewed task delta");

  const diff = captureAttemptWorktreeDiff({
    sidecarPath: worktree.sidecar_path,
  });

  assert.equal(diff.clean, true);
  assert.equal(diff.has_committed_changes, true);
  assert.equal(diff.has_task_delta, true);
  assert.equal(diff.has_uncommitted_changes, false);
  assert.deepEqual(diff.changed_files, ["README.md"]);
  assert.match(diff.committed_diff, /review this/);
  assert.match(diff.tracked_diff, /review this/);
  assert.match(diff.full_diff, /review this/);
  assert.equal(diff.uncommitted_tracked_diff, "");
  assert.equal(
    git(repositoryPath, "branch", "--list", worktree.branch_name),
    "",
  );
});

test("promotion rejects a task delta changed after fresh review", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  const worktree = createOrReuseAttemptWorktree({
    repositoryPath,
    stateRoot,
    taskId: "task-review-race",
    attemptId: "attempt-review-race",
  });
  fs.writeFileSync(path.join(worktree.worktree_path, "README.md"), "reviewed\n");
  const reviewed = captureAttemptWorktreeDiff({
    sidecarPath: worktree.sidecar_path,
  });
  fs.writeFileSync(path.join(worktree.worktree_path, "README.md"), "changed later\n");

  assert.throws(
    () => ensureAttemptWorktreePromotionCommit({
      canonicalVerdict: "PASS",
      expectedTaskSnapshotSha256: reviewed.task_snapshot_sha256,
      sidecarPath: worktree.sidecar_path,
    }),
    (error) => (
      error instanceof AttemptWorktreeError
      && error.code === "reviewed_task_delta_changed"
    ),
  );
  assert.equal(
    git(repositoryPath, "branch", "--list", worktree.branch_name),
    "",
  );
  assert.equal(
    git(worktree.worktree_path, "rev-parse", "HEAD"),
    worktree.base_commit,
  );
});

test("promotion refuses to reconcile an unrecorded pre-gate commit", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  const worktree = createOrReuseAttemptWorktree({
    repositoryPath,
    stateRoot,
    taskId: "task-promotion-recovery",
    attemptId: "attempt-promotion-recovery",
  });
  fs.writeFileSync(path.join(worktree.worktree_path, "recovered.txt"), "recover\n");
  git(worktree.worktree_path, "add", "recovered.txt");
  git(worktree.worktree_path, "commit", "-m", "promotion commit before crash");
  const reviewed = captureAttemptWorktreeDiff({
    sidecarPath: worktree.sidecar_path,
  });
  const committedHead = git(worktree.worktree_path, "rev-parse", "HEAD");
  git(repositoryPath, "branch", worktree.branch_name, committedHead);

  assert.throws(
    () => captureAttemptWorktreeDiff({
      sidecarPath: worktree.sidecar_path,
    }),
    (error) => (
      error instanceof AttemptWorktreeError
      && error.code === "attempt_branch_published_early"
    ),
  );

  assert.throws(
    () => ensureAttemptWorktreePromotionCommit({
      canonicalVerdict: "PASS",
      expectedTaskSnapshotSha256: reviewed.task_snapshot_sha256,
      sidecarPath: worktree.sidecar_path,
    }),
    (error) => (
      error instanceof AttemptWorktreeError
      && error.code === "pre_review_commit_forbidden"
    ),
  );
  assert.equal(
    readAttemptWorktreeSidecar(worktree.sidecar_path).status,
    "ACTIVE",
  );
  assert.equal(git(repositoryPath, "rev-parse", worktree.branch_name), committedHead);
});

for (const failAfterStep of ["intent", "commit_object", "commit", "branch"]) {
  test(`promotion resumes exactly once after an injected ${failAfterStep} crash`, (t) => {
    const { repositoryPath, stateRoot } = setupFixture(t);
    const worktree = createOrReuseAttemptWorktree({
      repositoryPath,
      stateRoot,
      taskId: `task-recover-${failAfterStep.replaceAll("_", "-")}`,
      attemptId: `attempt-recover-${failAfterStep}`,
    });
    fs.writeFileSync(
      path.join(worktree.worktree_path, "recovery.txt"),
      `${failAfterStep}\n`,
    );
    const reviewed = captureAttemptWorktreeDiff({
      sidecarPath: worktree.sidecar_path,
    });

    assert.throws(
      () => ensureAttemptWorktreePromotionCommit({
        canonicalVerdict: "PASS",
        expectedTaskSnapshotSha256: reviewed.task_snapshot_sha256,
        failAfterStep,
        now: "2026-07-23T10:09:00.000Z",
        sidecarPath: worktree.sidecar_path,
      }),
      (error) => (
        error instanceof AttemptWorktreeError
        && error.code === "promotion_crash_injected"
      ),
    );

    const recovered = ensureAttemptWorktreePromotionCommit({
      canonicalVerdict: "PASS",
      expectedTaskSnapshotSha256: reviewed.task_snapshot_sha256,
      now: "2026-07-23T10:10:00.000Z",
      sidecarPath: worktree.sidecar_path,
    });
    const sidecar = readAttemptWorktreeSidecar(worktree.sidecar_path);
    assert.equal(recovered.promotion_ready, true);
    assert.equal(sidecar.status, "COMMITTED");
    assert.equal(sidecar.promotion_intent, null);
    assert.equal(
      git(repositoryPath, "rev-parse", worktree.branch_name),
      recovered.commit_sha,
    );
    assert.equal(
      git(worktree.worktree_path, "rev-list", "--count", `${worktree.base_commit}..HEAD`),
      "1",
    );
  });
}

test("failure and blocked outcomes preserve worktree contents for inspection", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  const worktree = createOrReuseAttemptWorktree({
    repositoryPath,
    stateRoot,
    taskId: "task-3",
    attemptId: "attempt-3",
  });
  fs.writeFileSync(path.join(worktree.worktree_path, "evidence.txt"), "keep me\n");

  const preserved = finalizeAttemptWorktree({
    sidecarPath: worktree.sidecar_path,
    outcome: "failed",
    reason: "quality gate failed",
    now: "2026-07-23T10:10:00.000Z",
  });

  assert.equal(preserved.preserved, true);
  assert.equal(preserved.removed, false);
  assert.equal(fs.existsSync(worktree.worktree_path), true);
  assert.equal(
    fs.readFileSync(path.join(worktree.worktree_path, "evidence.txt"), "utf8"),
    "keep me\n",
  );
  assert.equal(
    readAttemptWorktreeSidecar(worktree.sidecar_path).preserved_reason,
    "quality gate failed",
  );
  assert.throws(
    () => removeAttemptWorktreeOnSuccess({
      sidecarPath: worktree.sidecar_path,
      success: true,
    }),
    /uncommitted changes/,
  );
  assert.equal(fs.existsSync(worktree.worktree_path), true);
});

test("worktree removal requires explicit success, keeps the review branch, and retains sidecar", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  const primaryBefore = primaryState(repositoryPath);
  const worktree = createOrReuseAttemptWorktree({
    repositoryPath,
    stateRoot,
    taskId: "task-4",
    attemptId: "attempt-4",
  });
  fs.writeFileSync(path.join(worktree.worktree_path, "ready.txt"), "ready\n");
  const reviewed = captureAttemptWorktreeDiff({
    sidecarPath: worktree.sidecar_path,
  });
  commitAttemptWorktreeChanges({
    sidecarPath: worktree.sidecar_path,
    canonicalVerdict: "PASS",
    expectedTaskSnapshotSha256: reviewed.task_snapshot_sha256,
  });

  assert.throws(
    () => removeAttemptWorktreeOnSuccess({
      sidecarPath: worktree.sidecar_path,
      success: false,
    }),
    (error) => (
      error instanceof AttemptWorktreeError
      && error.code === "explicit_success_required"
    ),
  );
  assert.equal(fs.existsSync(worktree.worktree_path), true);

  const removed = finalizeAttemptWorktree({
    sidecarPath: worktree.sidecar_path,
    outcome: "success",
    now: "2026-07-23T10:15:00.000Z",
  });

  assert.equal(removed.removed, true);
  assert.equal(removed.branch_preserved, true);
  assert.equal(fs.existsSync(worktree.worktree_path), false);
  assert.equal(fs.existsSync(worktree.sidecar_path), true);
  assert.equal(
    readAttemptWorktreeSidecar(worktree.sidecar_path).status,
    "REMOVED",
  );
  assert.notEqual(
    git(repositoryPath, "branch", "--list", worktree.branch_name),
    "",
  );
  assert.deepEqual(primaryState(repositoryPath), primaryBefore);
});

test("creation refuses unowned paths and pre-existing branches without deleting either", (t) => {
  const { repositoryPath, stateRoot } = setupFixture(t);
  const unownedWorkspace = path.join(
    stateRoot,
    "worktrees",
    "attempts",
    "task-5",
    "attempt-5",
    "workspace",
  );
  fs.mkdirSync(unownedWorkspace, { recursive: true });
  fs.writeFileSync(path.join(unownedWorkspace, "operator.txt"), "owned by operator\n");

  assert.throws(
    () => createOrReuseAttemptWorktree({
      repositoryPath,
      stateRoot,
      taskId: "task-5",
      attemptId: "attempt-5",
    }),
    (error) => (
      error instanceof AttemptWorktreeError
      && error.code === "unowned_worktree_path"
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(unownedWorkspace, "operator.txt"), "utf8"),
    "owned by operator\n",
  );

  const branchName = "niis/task/task-6/attempt-6";
  git(repositoryPath, "branch", branchName);
  assert.throws(
    () => createOrReuseAttemptWorktree({
      repositoryPath,
      stateRoot,
      taskId: "task-6",
      attemptId: "attempt-6",
    }),
    (error) => (
      error instanceof AttemptWorktreeError
      && error.code === "attempt_branch_exists"
    ),
  );
  assert.notEqual(git(repositoryPath, "branch", "--list", branchName), "");
});
