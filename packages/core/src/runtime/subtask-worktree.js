import fs from "node:fs";
import path from "node:path";

import { assertCanonicalTaskId } from "../schemas/task.js";
import { canonicalizePath } from "./path-safety.js";
import { runGitCommand } from "./workspace.js";

class SubtaskWorktreeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "SubtaskWorktreeError";
    this.code = options.code ?? "subtask_worktree_error";
  }
}

const SIDECAR_FILENAME = ".niis-worktree.json";

function sanitizeForPath(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function sanitizeForBranch(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^[/-]+|[/-]+$/g, "");
}

function deriveSourceBranch({ workspaceRoot }) {
  try {
    const result = runGitCommand({
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd: workspaceRoot,
    });
    const branch = (result.output ?? "").trim();
    if (!branch || branch === "HEAD") {
      throw new SubtaskWorktreeError(
        "detached HEAD; parallel dispatch with worktree isolation requires a named branch",
        { code: "detached_head" },
      );
    }
    return branch;
  } catch (error) {
    if (error instanceof SubtaskWorktreeError) throw error;
    throw new SubtaskWorktreeError(
      `failed to resolve HEAD branch in ${workspaceRoot}: ${error.message}`,
      { code: "head_resolution_failed" },
    );
  }
}

function worktreeRootForTask({ stateRoot, taskId }) {
  const canonicalStateRoot = canonicalizePath(stateRoot);
  const expectedRoot = path.join(
    canonicalStateRoot,
    "worktrees",
    assertCanonicalTaskId(taskId),
  );
  const root = canonicalizePath(expectedRoot);
  if (root !== expectedRoot) {
    throw new SubtaskWorktreeError(
      "task worktree root must not resolve through a filesystem alias",
      { code: "unsafe_task_worktree_path" },
    );
  }
  return root;
}

function createSubtaskWorktree({ workspaceRoot, taskId, subtaskId, stateRoot, sourceBranch = null }) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") {
    throw new SubtaskWorktreeError("workspaceRoot is required");
  }
  if (typeof stateRoot !== "string" || stateRoot.trim() === "") {
    throw new SubtaskWorktreeError("stateRoot is required");
  }
  const safeTask = assertCanonicalTaskId(taskId);
  const safeSubtask = sanitizeForPath(subtaskId);
  if (!safeSubtask) {
    throw new SubtaskWorktreeError("subtaskId must be non-empty after sanitization");
  }

  const resolvedSourceBranch = sourceBranch ?? deriveSourceBranch({ workspaceRoot });
  const branchName = sanitizeForBranch(`niis/${safeTask}/${safeSubtask}`);
  const worktreeDir = worktreeRootForTask({ stateRoot, taskId });
  const worktreePath = path.join(worktreeDir, safeSubtask);

  if (fs.existsSync(worktreePath)) {
    try {
      runGitCommand({ args: ["worktree", "remove", "--force", worktreePath], cwd: workspaceRoot });
    } catch {
      fs.rmSync(worktreePath, { force: true, recursive: true });
    }
  }
  try {
    runGitCommand({ args: ["branch", "-D", branchName], cwd: workspaceRoot });
  } catch {

  }

  fs.mkdirSync(worktreeDir, { recursive: true });
  runGitCommand({
    args: ["worktree", "add", "-b", branchName, worktreePath, "HEAD"],
    cwd: workspaceRoot,
  });

  const createdAt = new Date().toISOString();
  const sidecar = {
    branchName,
    createdAt,
    sourceBranch: resolvedSourceBranch,
    subtaskId,
    taskId,
    worktreePath,
  };
  fs.writeFileSync(path.join(worktreePath, SIDECAR_FILENAME), `${JSON.stringify(sidecar, null, 2)}\n`);

  return Object.freeze({
    branchName,
    createdAt,
    sourceBranch: resolvedSourceBranch,
    subtaskId,
    taskId,
    worktreePath,
  });
}

function removeSubtaskWorktree({ workspaceRoot, worktreePath, branchName }) {
  let worktreeRemoveOk = false;
  if (worktreePath && fs.existsSync(worktreePath)) {
    try {
      runGitCommand({ args: ["worktree", "remove", "--force", worktreePath], cwd: workspaceRoot });
      worktreeRemoveOk = true;
    } catch {
      try {
        fs.rmSync(worktreePath, { force: true, recursive: true });
      } catch {

      }
    }
  }



  if (!worktreeRemoveOk) {
    try {
      runGitCommand({ args: ["worktree", "prune"], cwd: workspaceRoot });
    } catch {

    }
  }
  if (branchName) {
    try {
      runGitCommand({ args: ["branch", "-D", branchName], cwd: workspaceRoot });
    } catch {



      try {
        runGitCommand({ args: ["worktree", "prune"], cwd: workspaceRoot });
        runGitCommand({ args: ["branch", "-D", branchName], cwd: workspaceRoot });
      } catch {

      }
    }
  }
  if (worktreePath) {
    const parent = path.dirname(worktreePath);
    try {
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmdirSync(parent);
      }
    } catch {

    }
  }
}

function listSubtaskWorktrees({ stateRoot, taskId }) {
  const root = worktreeRootForTask({ stateRoot, taskId });
  if (!fs.existsSync(root)) return [];
  const entries = [];
  for (const entry of fs.readdirSync(root)) {
    const full = path.join(root, entry);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const sidecarPath = path.join(full, SIDECAR_FILENAME);
    if (!fs.existsSync(sidecarPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
      entries.push({
        branchName: parsed.branchName,
        createdAt: parsed.createdAt,
        sourceBranch: parsed.sourceBranch,
        subtaskId: parsed.subtaskId,
        taskId: parsed.taskId,
        worktreePath: full,
      });
    } catch {
      continue;
    }
  }
  return entries.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

function pruneOldWorktrees({ stateRoot, taskId, keepLastN, workspaceRoot }) {
  const limit = Number.isInteger(keepLastN) && keepLastN > 0 ? keepLastN : 5;
  const all = listSubtaskWorktrees({ stateRoot, taskId });
  const stale = all.slice(limit);
  for (const entry of stale) {
    removeSubtaskWorktree({
      branchName: entry.branchName,
      worktreePath: entry.worktreePath,
      workspaceRoot,
    });
  }
  return stale.length;
}

function listAllWorktrees({ stateRoot }) {
  const root = path.join(stateRoot, "worktrees");
  if (!fs.existsSync(root)) return [];
  const entries = [];
  for (const taskDir of fs.readdirSync(root)) {
    try {
      assertCanonicalTaskId(taskDir);
    } catch {
      continue;
    }
    const taskPath = path.join(root, taskDir);
    let stat;
    try {
      stat = fs.statSync(taskPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    entries.push(...listSubtaskWorktrees({ stateRoot, taskId: taskDir }));
  }
  return entries;
}

function sweepStaleWorktrees({
  stateRoot,
  workspaceRoot,
  olderThanMs = 60 * 60 * 1000,
  isActiveTask = () => false,
  now = Date.now(),
  force = false,
}) {
  const removed = [];
  const kept = [];
  const candidates = listAllWorktrees({ stateRoot });
  for (const entry of candidates) {
    const ageMs = entry.createdAt ? now - Date.parse(entry.createdAt) : Infinity;
    const tooYoung = !force && ageMs < olderThanMs;
    const active = isActiveTask(entry.taskId);
    if (tooYoung || active) {
      kept.push({ reason: active ? "active_task" : "too_young", ...entry });
      continue;
    }
    removeSubtaskWorktree({
      branchName: entry.branchName,
      workspaceRoot,
      worktreePath: entry.worktreePath,
    });
    removed.push(entry);
  }
  return { kept, removed };
}

function listConflictFiles({ workspaceRoot }) {
  try {
    const result = runGitCommand({
      args: ["diff", "--name-only", "--diff-filter=U"],
      cwd: workspaceRoot,
    });
    return (result.output ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function commitSubtaskChanges({ worktreePath, subtaskId }) {
  try {
    runGitCommand({
      args: ["add", "--all", ":!.niis-worktree.json"],
      cwd: worktreePath,
    });
  } catch {
    return { committed: false };
  }
  try {
    const status = runGitCommand({
      args: ["status", "--porcelain"],
      cwd: worktreePath,
    });
    const lines = (status.output ?? "")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "" && !line.includes(".niis-worktree.json"));
    if (lines.length === 0) {
      return { committed: false, hadChanges: false };
    }
  } catch {
    return { committed: false };
  }
  try {
    runGitCommand({
      args: ["-c", "user.email=niis@local", "-c", "user.name=niis",
        "commit", "-m", `niis: subtask ${subtaskId}`],
      cwd: worktreePath,
    });
    return { committed: true, hadChanges: true };
  } catch (error) {
    return { committed: false, error: error.message };
  }
}

function mergeSubtaskBranch({ workspaceRoot, branchName, subtaskId }) {
  try {
    runGitCommand({
      args: [
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        `niis: merge subtask ${subtaskId}`,
        branchName,
      ],
      cwd: workspaceRoot,
    });
    return { conflictFiles: [], ok: true };
  } catch (error) {
    const conflictFiles = listConflictFiles({ workspaceRoot });
    try {
      runGitCommand({ args: ["merge", "--abort"], cwd: workspaceRoot });
    } catch {

    }
    return {
      conflictFiles,
      message: error.message,
      ok: false,
    };
  }
}

function isWorkspaceClean({ workspaceRoot, ignorePrefixes = [".niis/", ".niis"] }) {
  try {
    const result = runGitCommand({
      args: ["status", "--porcelain"],
      cwd: workspaceRoot,
    });
    const lines = (result.output ?? "").split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return true;
    const prefixes = Array.isArray(ignorePrefixes) ? ignorePrefixes : [];
    const offending = lines.filter((line) => {
      const statusCode = line.slice(0, 2);
      if (statusCode === "??") return false;
      const filePath = line.slice(3).trim();
      return !prefixes.some((prefix) => filePath === prefix || filePath.startsWith(prefix));
    });
    return offending.length === 0;
  } catch {
    return false;
  }
}

export {
  SIDECAR_FILENAME,
  SubtaskWorktreeError,
  commitSubtaskChanges,
  createSubtaskWorktree,
  deriveSourceBranch,
  isWorkspaceClean,
  listAllWorktrees,
  listConflictFiles,
  listSubtaskWorktrees,
  mergeSubtaskBranch,
  pruneOldWorktrees,
  removeSubtaskWorktree,
  sweepStaleWorktrees,
  worktreeRootForTask,
};
