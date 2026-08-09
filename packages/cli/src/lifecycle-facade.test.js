import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLifecycleSqliteStore } from "../../core/src/storage/lifecycle-sqlite.js";
import {
  canonicalVerdictFromTaskResult,
  executeCliTaskLifecycle,
  taskResultFromAttempt,
} from "./lifecycle-facade.js";

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-cli-lifecycle-"));
  const store = createLifecycleSqliteStore({
    databasePath: path.join(root, "niis.sqlite"),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { force: true, recursive: true });
  });
  return { root, store };
}

test("CLI facade persists the opaque runner result and resumes without repeating it", async (t) => {
  const { root, store } = createFixture(t);
  let executions = 0;
  const options = {
    taskId: "task-1",
    trigger: "cli",
    attemptId: "attempt-1",
    engineVersion: "test-v1",
    store,
    workspacePath: root,
    promoteTask: async () => ({
      branchName: "niis/task/task-1/attempt-1",
      commitSha: "fixture-commit-1",
      targetKind: "BRANCH",
      targetRef: "niis/task/task-1/attempt-1",
    }),
    executeTask: async () => {
      executions += 1;
      return {
        final_task: { id: "task-1", status: "DONE" },
        final_verdict: { verdict_class: "PASS" },
      };
    },
  };

  const first = await executeCliTaskLifecycle(options);
  const resumed = await executeCliTaskLifecycle(options);

  assert.equal(first.stage, "FINISHED");
  assert.equal(resumed.stage, "FINISHED");
  assert.equal(executions, 1);
  assert.equal(taskResultFromAttempt(resumed).final_task.status, "IN_REVIEW");
  assert.equal(taskResultFromAttempt(resumed).final_verdict.verdict_class, "PASS");
});

test("CLI facade turns a non-PASS result into a durable blocked attempt", async (t) => {
  const { root, store } = createFixture(t);
  const result = await executeCliTaskLifecycle({
    taskId: "task-2",
    trigger: "ui",
    attemptId: "attempt-2",
    engineVersion: "test-v1",
    store,
    workspacePath: root,
    promoteTask: async () => ({
      branchName: "unused-blocked-branch",
      commitSha: "unused-blocked-commit",
      targetKind: "BRANCH",
      targetRef: "unused-blocked-branch",
    }),
    executeTask: async () => ({
      final_task: { id: "task-2", status: "BLOCKED" },
      final_verdict: { verdict_class: "ENV_BLOCK" },
    }),
  });

  assert.equal(result.stage, "BLOCKED");
  assert.equal(result.canonical_verdict, "ENV_BLOCK");
  assert.equal(result.promoted, false);
});

test("CLI verdict mapping does not treat an agent completion string as proof", () => {
  assert.equal(
    canonicalVerdictFromTaskResult({
      final_task: { status: "IN_PROGRESS" },
      summary: "Everything is complete.",
    }),
    "EVIDENCE_GAP",
  );
});

test("CLI facade persists deterministic gate evidence and does not rerun it on resume", async (t) => {
  const { root, store } = createFixture(t);
  let gateRuns = 0;
  const options = {
    attemptId: "attempt-gates",
    engineVersion: "test-v1",
    executeTask: async () => ({
      final_task: { id: "task-gates", status: "IN_REVIEW" },
      final_verdict: { verdict_class: "PASS" },
    }),
    promoteTask: async () => ({
      branchName: "niis/task/task-gates/attempt-gates",
      commitSha: "fixture-gates-commit",
      targetKind: "BRANCH",
      targetRef: "niis/task/task-gates/attempt-gates",
    }),
    runGates: async () => {
      gateRuns += 1;
      return {
        evidence_items: [{ raw_output_ref: "sha256:fixture" }],
        ok: true,
        results: [{ command_id: "fixture", status: "PASS" }],
      };
    },
    store,
    taskId: "task-gates",
    trigger: "cli",
    workspacePath: root,
  };

  const first = await executeCliTaskLifecycle(options);
  const resumed = await executeCliTaskLifecycle(options);

  assert.equal(first.stage, "FINISHED");
  assert.equal(resumed.state.gates.results[0].status, "PASS");
  assert.equal(gateRuns, 1);
});

test("explicit outer gates and fresh review replace the legacy inner verdict", async (t) => {
  const { root, store } = createFixture(t);
  const result = await executeCliTaskLifecycle({
    attemptId: "attempt-outer-canonical",
    engineVersion: "test-v1",
    executeTask: async () => ({
      final_task: { id: "task-outer-canonical", status: "REJECTED" },
      final_verdict: { verdict_class: "DEFECT" },
      run_record: { id: "run-1", status: "COMPLETED" },
    }),
    promoteTask: async () => ({
      branchName: "niis/task/task-outer-canonical/attempt-outer-canonical",
      commitSha: "fixture-outer-commit",
      targetKind: "BRANCH",
      targetRef: "niis/task/task-outer-canonical/attempt-outer-canonical",
    }),
    reviewTask: async () => ({
      canonical_verdict: "PASS",
      source: "fresh-review",
    }),
    runGates: async () => ({
      canonical_verdict: "PASS",
      ok: true,
      source: "approved-argv",
    }),
    store,
    taskId: "task-outer-canonical",
    trigger: "cli",
    workspacePath: root,
  });

  assert.equal(result.stage, "FINISHED");
  assert.equal(result.canonical_verdict, "PASS");
  assert.equal(result.state.gates.source, "approved-argv");
  assert.equal(result.state.review.source, "fresh-review");
});

test("fresh-review cancellation remains CANCELLED without fabricating a verdict", async (t) => {
  const { root, store } = createFixture(t);
  const result = await executeCliTaskLifecycle({
    attemptId: "attempt-review-cancelled",
    engineVersion: "test-v1",
    executeTask: async () => ({
      final_task: { id: "task-review-cancelled", status: "IN_REVIEW" },
      final_verdict: { verdict_class: "PASS" },
      run_record: { id: "run-cancelled", status: "COMPLETED" },
    }),
    promoteTask: async () => {
      throw new Error("cancelled review must not promote");
    },
    reviewTask: async () => ({
      canonical_verdict: null,
      reason: "fresh review was cancelled",
      terminal_stage: "CANCELLED",
    }),
    runGates: async () => ({
      canonical_verdict: "PASS",
      ok: true,
    }),
    store,
    taskId: "task-review-cancelled",
    trigger: "cli",
    workspacePath: root,
  });

  assert.equal(result.stage, "CANCELLED");
  assert.equal(result.canonical_verdict, null);
  assert.equal(result.state.terminal.reason, "fresh review was cancelled");
  assert.equal(result.promoted, false);
});
