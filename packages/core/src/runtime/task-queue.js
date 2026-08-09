import fs from "node:fs";
import path from "node:path";

import { assertCanonicalTaskId } from "../schemas/task.js";
import { canonicalizePath } from "./path-safety.js";

class TaskQueueError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "TaskQueueError";
    this.code = options.code ?? "task_queue_error";
  }
}

const QUEUE_STATES = Object.freeze(["pending", "in_progress", "in_review", "accepted", "rejected"]);
const QUEUE_DIR_NAMES = Object.freeze({
  accepted: "accepted",
  in_progress: "in-progress",
  in_review: "in-review",
  pending: "pending",
  rejected: "rejected",
});

const PRIORITY_RANK = Object.freeze({
  blocker: 0,
  critical: 1,
  high: 2,
  medium: 3,
  normal: 3,
  low: 4,
});

function priorityRank(priority) {
  const key = typeof priority === "string" ? priority.toLowerCase() : "";
  return PRIORITY_RANK[key] ?? PRIORITY_RANK.medium;
}

function sortByPriority(entries) {
  return [...entries].sort((a, b) => {
    const ra = priorityRank(a.data?.priority);
    const rb = priorityRank(b.data?.priority);
    if (ra !== rb) return ra - rb;
    return (a.data?.updated_at ?? "").localeCompare(b.data?.updated_at ?? "");
  });
}

function createQueuePaths(stateRoot) {
  if (typeof stateRoot !== "string" || stateRoot.trim() === "") {
    throw new TaskQueueError("stateRoot is required");
  }
  const canonicalStateRoot = canonicalizePath(stateRoot);
  const expectedRoot = path.join(canonicalStateRoot, "queue");
  const root = canonicalizePath(expectedRoot);
  if (root !== expectedRoot) {
    throw new TaskQueueError("queue root must not resolve through a filesystem alias");
  }
  const dirs = {};
  for (const state of QUEUE_STATES) {
    const expectedDirectory = path.join(root, QUEUE_DIR_NAMES[state]);
    dirs[state] = canonicalizePath(expectedDirectory);
    if (dirs[state] !== expectedDirectory) {
      throw new TaskQueueError(
        `queue state directory ${state} must not resolve through a filesystem alias`,
      );
    }
  }
  return Object.freeze({ root, ...dirs });
}

function ensureQueueDirs(stateRoot) {
  const paths = createQueuePaths(stateRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  for (const state of QUEUE_STATES) {
    fs.mkdirSync(paths[state], { recursive: true });
  }
  return paths;
}

function sanitizeTaskId(taskId) {
  return assertCanonicalTaskId(taskId);
}

function filePathFor({ stateRoot, state, taskId }) {
  const paths = createQueuePaths(stateRoot);
  if (!paths[state]) throw new TaskQueueError(`unknown queue state: ${state}`);
  const expectedPath = path.join(
    paths[state],
    `${sanitizeTaskId(taskId)}.json`,
  );
  const filePath = canonicalizePath(expectedPath);
  if (filePath !== expectedPath) {
    throw new TaskQueueError("queue entry must not resolve through a filesystem alias");
  }
  return filePath;
}

function enqueueTask({ stateRoot, taskId, metadata = {}, state = "pending", now = new Date() }) {
  ensureQueueDirs(stateRoot);
  const existing = findTaskState({ stateRoot, taskId });
  if (existing) {
    throw new TaskQueueError(
      `task ${taskId} already queued in state ${existing.state}`,
      { code: "already_queued" },
    );
  }
  const payload = {
    created_at: new Date(now).toISOString(),
    task_id: taskId,
    updated_at: new Date(now).toISOString(),
    ...metadata,
  };
  fs.writeFileSync(filePathFor({ stateRoot, state, taskId }), `${JSON.stringify(payload, null, 2)}\n`);
  return { data: payload, state };
}

function readEntryFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function findTaskState({ stateRoot, taskId }) {
  const paths = createQueuePaths(stateRoot);
  const fileName = `${sanitizeTaskId(taskId)}.json`;
  for (const state of QUEUE_STATES) {
    const candidate = filePathFor({ state, stateRoot, taskId });
    if (fs.existsSync(candidate)) {
      const data = readEntryFile(candidate) ?? { task_id: taskId };
      return { data, file: candidate, state };
    }
  }
  return null;
}

function transitionTask({ stateRoot, taskId, toState, patch = {}, now = new Date() }) {
  if (!QUEUE_STATES.includes(toState)) {
    throw new TaskQueueError(`unknown queue state: ${toState}`);
  }
  ensureQueueDirs(stateRoot);
  const existing = findTaskState({ stateRoot, taskId });
  if (!existing) {
    throw new TaskQueueError(`task ${taskId} not found in queue`, { code: "not_queued" });
  }
  if (existing.state === toState) {
    const merged = { ...existing.data, ...patch, updated_at: new Date(now).toISOString() };
    fs.writeFileSync(existing.file, `${JSON.stringify(merged, null, 2)}\n`);
    return { data: merged, fromState: existing.state, toState };
  }
  const targetFile = filePathFor({ stateRoot, state: toState, taskId });
  const merged = { ...existing.data, ...patch, updated_at: new Date(now).toISOString() };
  fs.writeFileSync(existing.file, `${JSON.stringify(merged, null, 2)}\n`);
  fs.renameSync(existing.file, targetFile);
  return { data: merged, fromState: existing.state, toState };
}

function listState({ stateRoot, state }) {
  if (!QUEUE_STATES.includes(state)) {
    throw new TaskQueueError(`unknown queue state: ${state}`);
  }
  const paths = createQueuePaths(stateRoot);
  if (!fs.existsSync(paths[state])) return [];
  const entries = [];
  for (const entry of fs.readdirSync(paths[state])) {
    if (!entry.endsWith(".json")) continue;
    let taskId;
    let filePath;
    try {
      taskId = sanitizeTaskId(entry.slice(0, -".json".length));
      if (entry !== `${taskId}.json`) continue;
      filePath = filePathFor({ state, stateRoot, taskId });
      if (fs.lstatSync(filePath).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const data = readEntryFile(filePath);
    if (!data || data.task_id !== taskId) continue;
    entries.push({ data, file: filePath, state, task_id: taskId });
  }
  return entries.sort((a, b) => (a.data.updated_at ?? "").localeCompare(b.data.updated_at ?? ""));
}

function listAll({ stateRoot }) {
  const result = {};
  for (const state of QUEUE_STATES) {
    result[state] = listState({ stateRoot, state });
  }
  return result;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    return false;
  }
}

function resumeStaleInProgress({ stateRoot, now = new Date(), pidChecker = isPidAlive }) {
  ensureQueueDirs(stateRoot);
  const stale = [];
  const active = [];
  for (const entry of listState({ stateRoot, state: "in_progress" })) {
    const pid = Number.isInteger(entry.data.pid) ? entry.data.pid : null;
    if (pid !== null && pidChecker(pid)) {
      active.push(entry);
      continue;
    }
    transitionTask({
      now,
      patch: {
        pid: null,
        resumed_from: "in_progress",
        resume_reason: pid === null ? "no_pid_recorded" : "pid_not_alive",
      },
      stateRoot,
      taskId: entry.task_id,
      toState: "pending",
    });
    stale.push(entry);
  }
  return { active, revived: stale };
}

function removeFromQueue({ stateRoot, taskId }) {
  const existing = findTaskState({ stateRoot, taskId });
  if (!existing) return false;
  fs.rmSync(existing.file, { force: true });
  return true;
}

export {
  PRIORITY_RANK,
  QUEUE_DIR_NAMES,
  QUEUE_STATES,
  TaskQueueError,
  createQueuePaths,
  enqueueTask,
  ensureQueueDirs,
  findTaskState,
  isPidAlive,
  listAll,
  listState,
  priorityRank,
  removeFromQueue,
  resumeStaleInProgress,
  sortByPriority,
  transitionTask,
};
