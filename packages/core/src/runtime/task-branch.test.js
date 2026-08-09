import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  TaskBranchError,
  branchNameFor,
  commitPendingChanges,
  createTaskBranch,
  deleteTaskBranch,
  getCurrentBranch,
  maybeDeleteOrphanTaskBranch,
  mergeTaskBranchIntoBase,
  resolveBaseBranch,
  switchToBranch,
} from "./task-branch.js";

function setupGitFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-task-branch-"));
  execSync("git init -q -b main", { cwd: root });
  execSync("git config user.email t@example.com", { cwd: root });
  execSync("git config user.name test", { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "# Test\n");
  execSync("git add . && git commit -q -m init", { cwd: root });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

test("branchNameFor preserves a canonical task id without aliases", () => {
  assert.equal(branchNameFor("my-task-1"), "niis/task/my-task-1");
  for (const taskId of ["my-task_1", "../escape", "TASK", "ｔａｓｋ"]) {
    assert.throws(
      () => branchNameFor(taskId),
      /canonical lower-case ASCII task id/,
      taskId,
    );
  }
});

test("createTaskBranch creates and checks out a branch from current HEAD", (t) => {
  const repo = setupGitFixture(t);
  const result = createTaskBranch({ taskId: "task-001", workspaceRoot: repo });
  assert.equal(result.branchName, "niis/task/task-001");
  assert.equal(result.baseBranch, "main");
  assert.equal(result.previousBranch, "main");
  assert.equal(result.alreadyExisted, false);
  assert.equal(getCurrentBranch(repo), "niis/task/task-001");
});

test("createTaskBranch reuses existing branch when present", (t) => {
  const repo = setupGitFixture(t);
  createTaskBranch({ taskId: "task-002", workspaceRoot: repo });
  switchToBranch({ branchName: "main", workspaceRoot: repo });
  const retry = createTaskBranch({ taskId: "task-002", workspaceRoot: repo });
  assert.equal(retry.alreadyExisted, true);
  assert.equal(getCurrentBranch(repo), "niis/task/task-002");
});

test("commitPendingChanges commits workspace changes on current branch", (t) => {
  const repo = setupGitFixture(t);
  createTaskBranch({ taskId: "task-003", workspaceRoot: repo });
  fs.writeFileSync(path.join(repo, "feature.txt"), "hello\n");
  const outcome = commitPendingChanges({ taskId: "task-003", workspaceRoot: repo });
  assert.equal(outcome.committed, true);
  assert.equal(outcome.hadChanges, true);
  const log = execSync("git log --oneline", { cwd: repo, encoding: "utf8" });
  assert.ok(/niis: task task-003/.test(log));
});

test("commitPendingChanges reports no-op when workspace is clean", (t) => {
  const repo = setupGitFixture(t);
  createTaskBranch({ taskId: "task-004", workspaceRoot: repo });
  const outcome = commitPendingChanges({ taskId: "task-004", workspaceRoot: repo });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.hadChanges, false);
});

test("mergeTaskBranchIntoBase merges clean changes and switches back", (t) => {
  const repo = setupGitFixture(t);
  createTaskBranch({ taskId: "task-005", workspaceRoot: repo });
  fs.writeFileSync(path.join(repo, "added.txt"), "new\n");
  commitPendingChanges({ taskId: "task-005", workspaceRoot: repo });
  const merged = mergeTaskBranchIntoBase({
    baseBranch: "main",
    taskBranch: "niis/task/task-005",
    workspaceRoot: repo,
  });
  assert.equal(merged.ok, true);
  assert.equal(getCurrentBranch(repo), "main");
  assert.ok(fs.existsSync(path.join(repo, "added.txt")));
});

test("deleteTaskBranch removes an unused branch", (t) => {
  const repo = setupGitFixture(t);
  createTaskBranch({ taskId: "task-006", workspaceRoot: repo });
  switchToBranch({ branchName: "main", workspaceRoot: repo });
  assert.equal(deleteTaskBranch({ branchName: "niis/task/task-006", workspaceRoot: repo }), true);
  const branches = execSync("git branch --list", { cwd: repo, encoding: "utf8" });
  assert.equal(branches.includes("niis/task/task-006"), false);
});

test("mergeTaskBranchIntoBase surfaces conflict files and aborts", (t) => {
  const repo = setupGitFixture(t);
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  execSync("git add . && git commit -q -m base", { cwd: repo });
  createTaskBranch({ taskId: "task-conflict", workspaceRoot: repo });
  fs.writeFileSync(path.join(repo, "shared.txt"), "task edit\n");
  commitPendingChanges({ taskId: "task-conflict", workspaceRoot: repo });
  switchToBranch({ branchName: "main", workspaceRoot: repo });
  fs.writeFileSync(path.join(repo, "shared.txt"), "operator edit\n");
  execSync("git add . && git commit -q -m operator", { cwd: repo });
  const merged = mergeTaskBranchIntoBase({
    baseBranch: "main",
    taskBranch: "niis/task/task-conflict",
    workspaceRoot: repo,
  });
  assert.equal(merged.ok, false);
  assert.deepEqual(merged.conflictFiles, ["shared.txt"]);
});

test("maybeDeleteOrphanTaskBranch removes empty branches and switches off them", (t) => {
  const repo = setupGitFixture(t);
  createTaskBranch({ taskId: "task-orphan", workspaceRoot: repo });

  const outcome = maybeDeleteOrphanTaskBranch({
    branchName: "niis/task/task-orphan",
    fallbackBranch: "main",
    workspaceRoot: repo,
  });
  assert.equal(outcome.deleted, true);
  assert.equal(outcome.reason, "empty_or_merged");
  assert.equal(getCurrentBranch(repo), "main");
  const branches = execSync("git branch --list", { cwd: repo, encoding: "utf8" });
  assert.equal(branches.includes("niis/task/task-orphan"), false);
});

test("maybeDeleteOrphanTaskBranch refuses branches with unique commits", (t) => {
  const repo = setupGitFixture(t);
  createTaskBranch({ taskId: "task-with-work", workspaceRoot: repo });
  fs.writeFileSync(path.join(repo, "work.txt"), "operator-made-changes\n");
  commitPendingChanges({ taskId: "task-with-work", workspaceRoot: repo });
  switchToBranch({ branchName: "main", workspaceRoot: repo });
  const outcome = maybeDeleteOrphanTaskBranch({
    branchName: "niis/task/task-with-work",
    fallbackBranch: "main",
    workspaceRoot: repo,
  });
  assert.equal(outcome.deleted, false);
  assert.equal(outcome.reason, "has_unique_commits");
});

test("maybeDeleteOrphanTaskBranch returns not_found for missing branches", (t) => {
  const repo = setupGitFixture(t);
  const outcome = maybeDeleteOrphanTaskBranch({
    branchName: "niis/task/does-not-exist",
    fallbackBranch: "main",
    workspaceRoot: repo,
  });
  assert.equal(outcome.deleted, false);
  assert.equal(outcome.reason, "not_found");
});

test("resolveBaseBranch honors explicit value without probing git", (t) => {
  const repo = setupGitFixture(t);
  assert.equal(resolveBaseBranch({ workspaceRoot: repo, explicit: "release/v2" }), "release/v2");

  assert.equal(resolveBaseBranch({ workspaceRoot: repo, explicit: "  develop  " }), "develop");
});

test("resolveBaseBranch reads origin/HEAD when set", (t) => {
  const repo = setupGitFixture(t);

  const upstream = fs.mkdtempSync(path.join(os.tmpdir(), "niis-upstream-"));
  t.after(() => fs.rmSync(upstream, { force: true, recursive: true }));
  execSync(`git init --bare -q -b main "${upstream}"`);
  execSync(`git remote add origin "${upstream}"`, { cwd: repo });
  execSync("git push -q origin main", { cwd: repo });
  execSync("git remote set-head origin main", { cwd: repo });
  assert.equal(resolveBaseBranch({ workspaceRoot: repo }), "main");
});

test("resolveBaseBranch throws explicit error when nothing resolves", (t) => {
  const repo = setupGitFixture(t);

  assert.throws(
    () => resolveBaseBranch({ workspaceRoot: repo }),
    (err) => err instanceof TaskBranchError && err.code === "base_branch_ambiguous",
  );
});
