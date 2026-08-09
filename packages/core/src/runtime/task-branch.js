import { spawnSync } from "node:child_process";
import { assertCanonicalTaskId } from "../schemas/task.js";
import { runGitCommand } from "./workspace.js";

class TaskBranchError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "TaskBranchError";
    this.code = options.code ?? "task_branch_error";
  }
}

function sanitizeForBranch(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^[/-]+|[/-]+$/g, "");
}

function branchNameFor(taskId) {
  const safe = sanitizeForBranch(`niis/task/${assertCanonicalTaskId(taskId)}`);
  if (!safe) throw new TaskBranchError("taskId produced empty branch name after sanitization");
  return safe;
}

function getCurrentBranch(workspaceRoot) {
  const result = runGitCommand({ args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: workspaceRoot });
  const branch = (result.output ?? "").trim();
  if (!branch || branch === "HEAD") {
    throw new TaskBranchError(
      "detached HEAD or empty branch; branch_per_task requires a named branch",
      { code: "detached_head" },
    );
  }
  return branch;
}

function branchExists(workspaceRoot, name) {
  try {
    runGitCommand({ args: ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], cwd: workspaceRoot });
    return true;
  } catch {
    return false;
  }
}

function createTaskBranch({ workspaceRoot, taskId, baseBranch = null }) {
  const branchName = branchNameFor(taskId);
  const previousBranch = getCurrentBranch(workspaceRoot);
  const startPoint = baseBranch && baseBranch.trim() !== "" ? baseBranch.trim() : previousBranch;

  if (branchExists(workspaceRoot, branchName)) {
    try {
      runGitCommand({ args: ["checkout", branchName], cwd: workspaceRoot });
      return { alreadyExisted: true, baseBranch: startPoint, branchName, previousBranch };
    } catch (error) {
      throw new TaskBranchError(`failed to checkout existing branch ${branchName}: ${error.message}`);
    }
  }

  try {
    runGitCommand({ args: ["checkout", "-b", branchName, startPoint], cwd: workspaceRoot });
  } catch (error) {
    throw new TaskBranchError(
      `failed to create task branch ${branchName} from ${startPoint}: ${error.message}`,
    );
  }
  return { alreadyExisted: false, baseBranch: startPoint, branchName, previousBranch };
}

function switchToBranch({ workspaceRoot, branchName }) {
  try {
    runGitCommand({ args: ["checkout", branchName], cwd: workspaceRoot });
    return { ok: true };
  } catch (error) {
    return { message: error.message, ok: false };
  }
}

function mergeTaskBranchIntoBase({ workspaceRoot, taskBranch, baseBranch }) {
  const restore = switchToBranch({ workspaceRoot, branchName: baseBranch });
  if (!restore.ok) {
    return { message: `failed to checkout ${baseBranch}: ${restore.message}`, ok: false };
  }
  try {
    runGitCommand({
      args: ["merge", "--no-ff", "--no-edit", "-m", `niis: merge task ${taskBranch}`, taskBranch],
      cwd: workspaceRoot,
    });
    return { conflictFiles: [], ok: true };
  } catch (error) {
    const conflictFiles = listConflictFiles({ workspaceRoot });
    try {
      runGitCommand({ args: ["merge", "--abort"], cwd: workspaceRoot });
    } catch {

    }
    return { conflictFiles, message: error.message, ok: false };
  }
}

function listConflictFiles({ workspaceRoot }) {
  try {
    const result = runGitCommand({ args: ["diff", "--name-only", "--diff-filter=U"], cwd: workspaceRoot });
    return (result.output ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function deleteTaskBranch({ workspaceRoot, branchName }) {
  try {
    runGitCommand({ args: ["branch", "-D", branchName], cwd: workspaceRoot });
    return true;
  } catch {
    return false;
  }
}



function maybeDeleteOrphanTaskBranch({ workspaceRoot, branchName, fallbackBranch = "main" }) {
  if (!branchExists(workspaceRoot, branchName)) {
    return { deleted: false, reason: "not_found" };
  }
  try {
    const current = getCurrentBranch(workspaceRoot);
    if (current === branchName) {
      const restore = switchToBranch({ branchName: fallbackBranch, workspaceRoot });
      if (!restore.ok) {
        return { deleted: false, reason: "checked_out_and_switch_failed" };
      }
    }
  } catch {
    return { deleted: false, reason: "detached_head" };
  }
  try {
    runGitCommand({ args: ["branch", "-d", branchName], cwd: workspaceRoot });
    return { deleted: true, reason: "empty_or_merged" };
  } catch {
    return { deleted: false, reason: "has_unique_commits" };
  }
}

function commitPendingChanges({ workspaceRoot, taskId }) {
  try {
    runGitCommand({ args: ["add", "--all"], cwd: workspaceRoot });
  } catch {
    return { committed: false };
  }
  try {
    const status = runGitCommand({ args: ["status", "--porcelain"], cwd: workspaceRoot });
    const lines = (status.output ?? "").split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) {
      return { committed: false, hadChanges: false };
    }
  } catch {
    return { committed: false };
  }
  try {
    runGitCommand({
      args: [
        "-c", "user.email=niis@local",
        "-c", "user.name=niis",
        "commit", "-m", `niis: task ${taskId}`,
      ],
      cwd: workspaceRoot,
    });
    return { committed: true, hadChanges: true };
  } catch (error) {
    return { committed: false, error: error.message };
  }
}












function resolveBaseBranch({ workspaceRoot, explicit = null } = {}) {
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return explicit.trim();
  }
  try {
    const result = runGitCommand({
      args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      cwd: workspaceRoot,
    });
    const ref = (result.output ?? "").trim();
    if (ref.startsWith("origin/")) {
      const candidate = ref.slice("origin/".length);
      if (candidate) return candidate;
    }
  } catch {

  }
  try {
    const remoteResult = runGitCommand({
      args: ["remote", "get-url", "origin"],
      cwd: workspaceRoot,
    });
    const url = (remoteResult.output ?? "").trim();
    const githubMatch = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (githubMatch) {
      const ghResult = spawnSync(
        "gh",
        ["api", `repos/${githubMatch[1]}/${githubMatch[2]}`, "--jq", ".default_branch"],
        { cwd: workspaceRoot, encoding: "utf8" },
      );
      if (ghResult.status === 0) {
        const branch = (ghResult.stdout ?? "").trim();
        if (branch) return branch;
      }
    }
  } catch {

  }
  throw new TaskBranchError(
    "unable to determine base branch (origin/HEAD not set, gh api unavailable). " +
    "Fix by either: (a) set `merge_policy.base_branch` in `.niis/project-config.json` " +
    "(e.g. \"base_branch\": \"main\"), or (b) run `git remote set-head origin --auto` " +
    "to populate origin/HEAD, or (c) authenticate with `gh auth login` on a GitHub remote.",
    { code: "base_branch_ambiguous" },
  );
}

export {
  TaskBranchError,
  branchNameFor,
  commitPendingChanges,
  createTaskBranch,
  deleteTaskBranch,
  getCurrentBranch,
  listConflictFiles,
  maybeDeleteOrphanTaskBranch,
  mergeTaskBranchIntoBase,
  resolveBaseBranch,
  switchToBranch,
};
