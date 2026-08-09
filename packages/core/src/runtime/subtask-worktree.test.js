import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  SIDECAR_FILENAME,
  createSubtaskWorktree,
  isWorkspaceClean,
  listSubtaskWorktrees,
  mergeSubtaskBranch,
  pruneOldWorktrees,
  removeSubtaskWorktree,
} from "./subtask-worktree.js";

function setupGitFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-worktree-test-"));
  const repo = path.join(root, "repo");
  const stateRoot = path.join(repo, ".niis");
  fs.mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main", { cwd: repo });
  execSync("git config user.email t@example.com", { cwd: repo });
  execSync("git config user.name test", { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# Test\n");
  execSync("git add . && git commit -q -m init", { cwd: repo });
  fs.mkdirSync(stateRoot, { recursive: true });
  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });
  return { repo, root, stateRoot };
}

test("createSubtaskWorktree creates worktree, branch, and sidecar", (t) => {
  const { repo, stateRoot } = setupGitFixture(t);
  const wt = createSubtaskWorktree({
    stateRoot,
    subtaskId: "task-x:subtask:1",
    taskId: "task-x",
    workspaceRoot: repo,
  });
  assert.equal(wt.sourceBranch, "main");
  assert.match(wt.branchName, /^niis\/task-x\/task-x-subtask-1$/);
  assert.ok(fs.existsSync(wt.worktreePath));
  assert.ok(fs.existsSync(path.join(wt.worktreePath, "README.md")));
  assert.ok(fs.existsSync(path.join(wt.worktreePath, SIDECAR_FILENAME)));
  const sidecar = JSON.parse(fs.readFileSync(path.join(wt.worktreePath, SIDECAR_FILENAME), "utf8"));
  assert.equal(sidecar.taskId, "task-x");
  assert.equal(sidecar.subtaskId, "task-x:subtask:1");
});

test("removeSubtaskWorktree removes worktree dir and branch", (t) => {
  const { repo, stateRoot } = setupGitFixture(t);
  const wt = createSubtaskWorktree({
    stateRoot,
    subtaskId: "subtask-1",
    taskId: "task-y",
    workspaceRoot: repo,
  });
  removeSubtaskWorktree({
    branchName: wt.branchName,
    workspaceRoot: repo,
    worktreePath: wt.worktreePath,
  });
  assert.equal(fs.existsSync(wt.worktreePath), false);
  const branches = execSync("git branch --list", { cwd: repo, encoding: "utf8" });
  assert.equal(branches.includes(wt.branchName), false);
});

test("mergeSubtaskBranch merges non-conflicting changes", (t) => {
  const { repo, stateRoot } = setupGitFixture(t);
  const wt = createSubtaskWorktree({
    stateRoot,
    subtaskId: "subtask-merge-ok",
    taskId: "task-merge",
    workspaceRoot: repo,
  });
  fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "added by subtask\n");
  execSync("git add . && git commit -q -m subtask-edit", { cwd: wt.worktreePath });
  const result = mergeSubtaskBranch({
    branchName: wt.branchName,
    subtaskId: "subtask-merge-ok",
    workspaceRoot: repo,
  });
  assert.equal(result.ok, true);
  assert.equal(result.conflictFiles.length, 0);
  assert.ok(fs.existsSync(path.join(repo, "feature.txt")));
});

test("mergeSubtaskBranch reports conflict files and aborts", (t) => {
  const { repo, stateRoot } = setupGitFixture(t);
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  execSync("git add . && git commit -q -m base-shared", { cwd: repo });
  const wt = createSubtaskWorktree({
    stateRoot,
    subtaskId: "subtask-conflict",
    taskId: "task-conflict",
    workspaceRoot: repo,
  });
  fs.writeFileSync(path.join(wt.worktreePath, "shared.txt"), "subtask change\n");
  execSync("git add . && git commit -q -m subtask-change", { cwd: wt.worktreePath });
  fs.writeFileSync(path.join(repo, "shared.txt"), "operator change\n");
  execSync("git add . && git commit -q -m operator-change", { cwd: repo });
  const result = mergeSubtaskBranch({
    branchName: wt.branchName,
    subtaskId: "subtask-conflict",
    workspaceRoot: repo,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflictFiles, ["shared.txt"]);
});

test("pruneOldWorktrees keeps last N", (t) => {
  const { repo, stateRoot } = setupGitFixture(t);
  for (let i = 1; i <= 4; i += 1) {
    createSubtaskWorktree({
      stateRoot,
      subtaskId: `subtask-${i}`,
      taskId: "task-prune",
      workspaceRoot: repo,
    });
  }
  const removed = pruneOldWorktrees({
    keepLastN: 2,
    stateRoot,
    taskId: "task-prune",
    workspaceRoot: repo,
  });
  assert.equal(removed, 2);
  const remaining = listSubtaskWorktrees({ stateRoot, taskId: "task-prune" });
  assert.equal(remaining.length, 2);
});

test("isWorkspaceClean reports porcelain state", (t) => {
  const { repo } = setupGitFixture(t);
  assert.equal(isWorkspaceClean({ workspaceRoot: repo }), true);
  fs.writeFileSync(path.join(repo, "README.md"), "# Modified tracked file\n");
  assert.equal(isWorkspaceClean({ workspaceRoot: repo }), false);
});

test("isWorkspaceClean ignores untracked files outside .niis/", (t) => {
  const { repo } = setupGitFixture(t);
  fs.writeFileSync(path.join(repo, "scratch.txt"), "untracked scratch file\n");
  assert.equal(isWorkspaceClean({ workspaceRoot: repo }), true);
});

test("isWorkspaceClean ignores .niis/ by default", (t) => {
  const { repo } = setupGitFixture(t);
  fs.mkdirSync(path.join(repo, ".niis/intake/task-x"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".niis/intake/task-x/intake.json"), "{}");
  assert.equal(isWorkspaceClean({ workspaceRoot: repo }), true);
});

import { sweepStaleWorktrees } from "./subtask-worktree.js";

test("sweepStaleWorktrees keeps active task worktrees", (t) => {
  const { repo, stateRoot } = setupGitFixture(t);
  createSubtaskWorktree({
    stateRoot,
    subtaskId: "subtask-active",
    taskId: "task-active",
    workspaceRoot: repo,
  });
  const report = sweepStaleWorktrees({
    force: true,
    isActiveTask: (id) => id === "task-active",
    stateRoot,
    workspaceRoot: repo,
  });
  assert.equal(report.removed.length, 0);
  assert.equal(report.kept.length, 1);
  assert.equal(report.kept[0].reason, "active_task");
});

test("sweepStaleWorktrees removes inactive aged worktrees", (t) => {
  const { repo, stateRoot } = setupGitFixture(t);
  createSubtaskWorktree({
    stateRoot,
    subtaskId: "subtask-stale",
    taskId: "task-stale",
    workspaceRoot: repo,
  });
  const report = sweepStaleWorktrees({
    force: true,
    isActiveTask: () => false,
    stateRoot,
    workspaceRoot: repo,
  });
  assert.equal(report.removed.length, 1);
  assert.equal(report.removed[0].taskId, "task-stale");
});
