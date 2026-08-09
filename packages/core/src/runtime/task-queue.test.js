import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  QUEUE_STATES,
  enqueueTask,
  ensureQueueDirs,
  findTaskState,
  listAll,
  listState,
  removeFromQueue,
  resumeStaleInProgress,
  sortByPriority,
  transitionTask,
} from "./task-queue.js";

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-queue-test-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

test("enqueueTask writes to pending and records metadata", (t) => {
  const root = makeRoot(t);
  const result = enqueueTask({ metadata: { priority: "high", title: "Tidy UI" }, stateRoot: root, taskId: "task-001" });
  assert.equal(result.state, "pending");
  assert.equal(result.data.task_id, "task-001");
  assert.equal(result.data.priority, "high");
  const found = findTaskState({ stateRoot: root, taskId: "task-001" });
  assert.equal(found?.state, "pending");
});

test("transitionTask moves file between state directories", (t) => {
  const root = makeRoot(t);
  enqueueTask({ stateRoot: root, taskId: "task-002" });
  const outcome = transitionTask({ stateRoot: root, taskId: "task-002", toState: "in_progress", patch: { pid: 42 } });
  assert.equal(outcome.fromState, "pending");
  assert.equal(outcome.toState, "in_progress");
  assert.equal(outcome.data.pid, 42);
  const after = findTaskState({ stateRoot: root, taskId: "task-002" });
  assert.equal(after?.state, "in_progress");
  assert.equal(after?.data.pid, 42);
});

test("enqueueTask rejects duplicates", (t) => {
  const root = makeRoot(t);
  enqueueTask({ stateRoot: root, taskId: "task-003" });
  assert.throws(() => enqueueTask({ stateRoot: root, taskId: "task-003" }), /already queued/);
});

test("queue paths reject traversal and normalization aliases without writing", (t) => {
  const root = makeRoot(t);
  for (const taskId of [
    ".",
    "..",
    "../escape",
    "task/escape",
    "task\\escape",
    "TASK",
    "task_name",
    "task--name",
    "ｔａｓｋ",
  ]) {
    assert.throws(
      () => enqueueTask({ stateRoot: root, taskId }),
      /canonical lower-case ASCII task id/,
      taskId,
    );
  }
  assert.deepEqual(listAll({ stateRoot: root }), {
    accepted: [],
    in_progress: [],
    in_review: [],
    pending: [],
    rejected: [],
  });
});

test("queue entries reject an existing symlink alias", (t) => {
  const root = makeRoot(t);
  const paths = ensureQueueDirs(root);
  const external = path.join(root, "external.json");
  fs.writeFileSync(external, "external\n");
  fs.symlinkSync(external, path.join(paths.pending, "task-alias.json"));

  assert.throws(
    () => enqueueTask({ stateRoot: root, taskId: "task-alias" }),
    /filesystem alias/,
  );
  assert.equal(fs.readFileSync(external, "utf8"), "external\n");
});

test("transitionTask with same target state patches metadata in place", (t) => {
  const root = makeRoot(t);
  enqueueTask({ stateRoot: root, taskId: "task-004" });
  transitionTask({ stateRoot: root, taskId: "task-004", toState: "pending", patch: { note: "retained" } });
  const found = findTaskState({ stateRoot: root, taskId: "task-004" });
  assert.equal(found?.state, "pending");
  assert.equal(found?.data.note, "retained");
});

test("listState/listAll produces expected counts", (t) => {
  const root = makeRoot(t);
  enqueueTask({ stateRoot: root, taskId: "t-a" });
  enqueueTask({ stateRoot: root, taskId: "t-b" });
  transitionTask({ stateRoot: root, taskId: "t-b", toState: "in_progress" });
  const counts = Object.fromEntries(QUEUE_STATES.map((s) => [s, listState({ stateRoot: root, state: s }).length]));
  assert.deepEqual(counts, { accepted: 0, in_progress: 1, in_review: 0, pending: 1, rejected: 0 });
  const all = listAll({ stateRoot: root });
  assert.equal(all.pending[0].task_id, "t-a");
  assert.equal(all.in_progress[0].task_id, "t-b");
});

test("resumeStaleInProgress revives tasks with dead PIDs", (t) => {
  const root = makeRoot(t);
  enqueueTask({ stateRoot: root, taskId: "task-zombie" });
  transitionTask({ stateRoot: root, taskId: "task-zombie", toState: "in_progress", patch: { pid: 99 } });
  const report = resumeStaleInProgress({ pidChecker: () => false, stateRoot: root });
  assert.equal(report.revived.length, 1);
  assert.equal(report.active.length, 0);
  const after = findTaskState({ stateRoot: root, taskId: "task-zombie" });
  assert.equal(after?.state, "pending");
  assert.equal(after?.data.resume_reason, "pid_not_alive");
});

test("resumeStaleInProgress keeps live PIDs in place", (t) => {
  const root = makeRoot(t);
  enqueueTask({ stateRoot: root, taskId: "task-live" });
  transitionTask({ stateRoot: root, taskId: "task-live", toState: "in_progress", patch: { pid: 99 } });
  const report = resumeStaleInProgress({ pidChecker: () => true, stateRoot: root });
  assert.equal(report.revived.length, 0);
  assert.equal(report.active.length, 1);
  const after = findTaskState({ stateRoot: root, taskId: "task-live" });
  assert.equal(after?.state, "in_progress");
});

test("sortByPriority orders blocker > critical > high > medium > low, then by updated_at", () => {
  const entries = [
    { data: { priority: "low", updated_at: "2026-01-01" }, task_id: "t-low" },
    { data: { priority: "blocker", updated_at: "2026-01-05" }, task_id: "t-blocker" },
    { data: { priority: "medium", updated_at: "2026-01-02" }, task_id: "t-med-older" },
    { data: { priority: "medium", updated_at: "2026-01-03" }, task_id: "t-med-newer" },
    { data: { priority: "critical", updated_at: "2026-01-04" }, task_id: "t-critical" },
    { data: { priority: "high", updated_at: "2026-01-06" }, task_id: "t-high" },
    { data: { updated_at: "2026-01-07" }, task_id: "t-no-priority" },
  ];
  const ordered = sortByPriority(entries).map((e) => e.task_id);
  assert.deepEqual(ordered, [
    "t-blocker",
    "t-critical",
    "t-high",
    "t-med-older",
    "t-med-newer",
    "t-no-priority",
    "t-low",
  ]);
});

test("removeFromQueue deletes the entry file", (t) => {
  const root = makeRoot(t);
  enqueueTask({ stateRoot: root, taskId: "task-gone" });
  assert.equal(removeFromQueue({ stateRoot: root, taskId: "task-gone" }), true);
  assert.equal(findTaskState({ stateRoot: root, taskId: "task-gone" }), null);
});
