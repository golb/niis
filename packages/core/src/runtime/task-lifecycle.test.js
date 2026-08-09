import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLifecycleSqliteStore } from "../storage/lifecycle-sqlite.js";
import {
  TaskLifecycleFailedError,
  createTaskLifecycleExecutor,
} from "./task-lifecycle.js";

function createHarness(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-lifecycle-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const store = createLifecycleSqliteStore({
    databasePath: path.join(root, "niis.sqlite"),
  });
  t.after(() => {
    try {
      store.close();
    } catch {

    }
  });
  const calls = [];
  const handlers = {
    async prepareWorkspace(context) {
      calls.push(["prepareWorkspace", context]);
      return { workspacePath: path.join(root, "worktrees", context.attemptId) };
    },
    async execute(context) {
      calls.push(["execute", context]);
      return { diff_ref: `${context.attemptId}:diff` };
    },
    async runGates(context) {
      calls.push(["runGates", context]);
      return { passed: true, evidence_refs: ["test-output"] };
    },
    async review(context) {
      calls.push(["review", context]);
      return { verdict_class: "PASS", reviewer_context: "fresh" };
    },
    async promote(context) {
      calls.push(["promote", context]);
      return {
        targetKind: "BRANCH",
        targetRef: `refs/heads/niis/${context.taskId}`,
        branchName: `niis/${context.taskId}`,
        commitSha: "abc123",
      };
    },
    async finish(context) {
      calls.push(["finish", context]);
      return { notified: true };
    },
    ...overrides,
  };

  return {
    calls,
    handlers,
    root,
    store,
  };
}

test("executeTaskLifecycle runs one ordered supervised path and returns a durable result", async (t) => {
  const harness = createHarness(t);
  const executor = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-1",
  });
  const result = await executor.executeTaskLifecycle({
    taskId: "task-1",
    trigger: "cli",
    attemptId: "attempt-1",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "FINISHED");
  assert.equal(result.canonical_verdict, "PASS");
  assert.equal(result.promoted, true);
  assert.equal(result.promotion.target_kind, "BRANCH");
  assert.deepEqual(
    harness.calls.map(([name]) => name),
    ["prepareWorkspace", "execute", "runGates", "review", "promote", "finish"],
  );
  assert.equal(harness.calls[1][1].workspacePath, result.workspace_path);
  assert.equal(harness.calls[1][1].attemptId, "attempt-1");
  assert.equal(harness.calls[3][1].freshContext, true);
  assert.equal(harness.calls[4][1].sandboxPolicy !== undefined, true);

  const second = await executor.executeTaskLifecycle({
    taskId: "task-1",
    trigger: "cli",
    attemptId: "attempt-1",
    engineVersion: "rc-1",
  });
  assert.deepEqual(second, result);
  assert.equal(harness.calls.length, 6);
});

test("omitting attemptId starts a new attempt after a prior attempt is terminal", async (t) => {
  const harness = createHarness(t);
  const executor = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-new-attempt",
  });

  const first = await executor.executeTaskLifecycle({
    taskId: "task-independent",
    trigger: "cli",
    engineVersion: "rc-1",
  });
  const second = await executor.executeTaskLifecycle({
    taskId: "task-independent",
    trigger: "cli",
    engineVersion: "rc-1",
  });

  assert.equal(first.stage, "FINISHED");
  assert.equal(second.stage, "FINISHED");
  assert.notEqual(second.attempt_id, first.attempt_id);
  assert.equal(harness.calls.length, 12);
});

test("a failing deterministic gate blocks promotion even when review says PASS", async (t) => {
  const harness = createHarness(t, {
    async runGates(context) {
      harness.calls.push(["runGates", context]);
      return { passed: false, reason: "evidence missing" };
    },
  });
  const executor = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-2",
  });
  const result = await executor.executeTaskLifecycle({
    taskId: "task-2",
    trigger: "serve",
    attemptId: "attempt-2",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "BLOCKED");
  assert.equal(result.canonical_verdict, "EVIDENCE_GAP");
  assert.equal(result.promoted, false);
  assert.equal(
    harness.calls.some(([name]) => name === "review"),
    true,
  );
  assert.equal(
    harness.calls.some(([name]) => name === "promote"),
    false,
  );
});

test("a handler-requested terminal stage durably preserves its canonical verdict", async (t) => {
  const harness = createHarness(t, {
    async runGates(context) {
      harness.calls.push(["runGates", context]);
      return {
        canonical_verdict: "DEFECT",
        reason: "deterministic evidence found a defect",
        terminal_stage: "BLOCKED",
      };
    },
  });
  const executor = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-terminal-verdict",
  });
  const result = await executor.executeTaskLifecycle({
    taskId: "task-terminal-verdict",
    trigger: "serve",
    attemptId: "attempt-terminal-verdict",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "BLOCKED");
  assert.equal(result.canonical_verdict, "DEFECT");
  assert.equal(
    (await harness.store.attempts.byId("attempt-terminal-verdict"))
      .canonical_verdict,
    "DEFECT",
  );
});

test("resume skips stages already durably completed after crash injection", async (t) => {
  const harness = createHarness(t);
  let injected = false;
  const firstExecutor = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-3",
    faultInjector({ point }) {
      if (!injected && point === "after:EXECUTED") {
        injected = true;
        throw new Error("simulated process crash");
      }
    },
  });

  await assert.rejects(
    firstExecutor.executeTaskLifecycle({
      taskId: "task-3",
      trigger: "worker",
      attemptId: "attempt-3",
      engineVersion: "rc-1",
    }),
    /simulated process crash/,
  );
  assert.equal(
    (await harness.store.attempts.byId("attempt-3")).stage,
    "EXECUTED",
  );

  const resumedExecutor = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-4",
  });
  const result = await resumedExecutor.executeTaskLifecycle({
    taskId: "task-3",
    trigger: "worker",
    attemptId: "attempt-3",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "FINISHED");
  assert.equal(
    harness.calls.filter(([name]) => name === "prepareWorkspace").length,
    1,
  );
  assert.equal(
    harness.calls.filter(([name]) => name === "execute").length,
    1,
  );
});

test("a crash after claim resumes the same attempt without losing or duplicating work", async (t) => {
  const harness = createHarness(t);
  let injected = false;
  let now = new Date("2026-07-23T10:00:00.000Z");
  const firstExecutor = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-claim-1",
    clock: () => now,
    leaseTtlMs: 1_000,
    faultInjector({ point }) {
      if (!injected && point === "after:CLAIMED") {
        injected = true;
        throw new Error("crash after claim");
      }
    },
  });

  await assert.rejects(
    firstExecutor.executeTaskLifecycle({
      taskId: "task-claim",
      trigger: "serve",
      attemptId: "attempt-claim",
      engineVersion: "rc-1",
    }),
    /crash after claim/,
  );
  assert.equal(
    (await harness.store.attempts.byId("attempt-claim")).stage,
    "CLAIMED",
  );
  assert.equal(harness.calls.length, 0);

  now = new Date("2026-07-23T10:00:01.001Z");
  const resumed = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-claim-2",
    clock: () => now,
    leaseTtlMs: 1_000,
  });
  const result = await resumed.executeTaskLifecycle({
    taskId: "task-claim",
    trigger: "serve",
    attemptId: "attempt-claim",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "FINISHED");
  assert.equal(
    harness.calls.filter(([name]) => name === "prepareWorkspace").length,
    1,
  );
});

test("a crash after review resumes without repeating execution, gates, or review", async (t) => {
  const harness = createHarness(t);
  let injected = false;
  const firstExecutor = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-review-1",
    faultInjector({ point }) {
      if (!injected && point === "after:REVIEWED") {
        injected = true;
        throw new Error("crash after review");
      }
    },
  });

  await assert.rejects(
    firstExecutor.executeTaskLifecycle({
      taskId: "task-review",
      trigger: "ui",
      attemptId: "attempt-review",
      engineVersion: "rc-1",
    }),
    /crash after review/,
  );
  assert.equal(
    (await harness.store.attempts.byId("attempt-review")).stage,
    "REVIEWED",
  );

  const resumed = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-review-2",
  });
  const result = await resumed.executeTaskLifecycle({
    taskId: "task-review",
    trigger: "ui",
    attemptId: "attempt-review",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "FINISHED");
  for (const handlerName of ["execute", "runGates", "review", "promote"]) {
    assert.equal(
      harness.calls.filter(([name]) => name === handlerName).length,
      1,
      `${handlerName} must run exactly once`,
    );
  }
});

test("a crash after promotion recording reuses the promotion idempotently", async (t) => {
  const harness = createHarness(t);
  let injected = false;
  const firstExecutor = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-5",
    faultInjector({ point }) {
      if (!injected && point === "after:promotion_recorded") {
        injected = true;
        throw new Error("crash after push");
      }
    },
  });

  await assert.rejects(
    firstExecutor.executeTaskLifecycle({
      taskId: "task-4",
      trigger: "ui",
      attemptId: "attempt-4",
      engineVersion: "rc-1",
    }),
    /crash after push/,
  );
  assert.equal(
    (await harness.store.attempts.byId("attempt-4")).stage,
    "READY_TO_PROMOTE",
  );
  assert.equal(
    (await harness.store.promotions.byAttempt("attempt-4")).status,
    "PROMOTED",
  );

  const resumed = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-6",
  });
  const result = await resumed.executeTaskLifecycle({
    taskId: "task-4",
    trigger: "ui",
    attemptId: "attempt-4",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "FINISHED");
  assert.equal(
    harness.calls.filter(([name]) => name === "promote").length,
    1,
  );
});

test("an incomplete promotion step uses explicit recovery without republishing", async (t) => {
  let publishCalls = 0;
  let recoveryCalls = 0;
  const harness = createHarness(t, {
    async promote() {
      publishCalls += 1;
      throw new Error("simulated crash after creating the review branch");
    },
    async recoverPromotion(context) {
      recoveryCalls += 1;
      return {
        targetKind: "BRANCH",
        targetRef: `refs/heads/niis/${context.taskId}`,
        branchName: `niis/${context.taskId}`,
        commitSha: "recovered123",
      };
    },
  });
  const first = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-promote-recovery-1",
  });

  await assert.rejects(
    first.executeTaskLifecycle({
      taskId: "task-promote-recovery",
      trigger: "serve",
      attemptId: "attempt-promote-recovery",
      engineVersion: "rc-1",
    }),
    /simulated crash/,
  );

  const resumed = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-promote-recovery-2",
  });
  const result = await resumed.executeTaskLifecycle({
    taskId: "task-promote-recovery",
    trigger: "serve",
    attemptId: "attempt-promote-recovery",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "FINISHED");
  assert.equal(result.promotion.commit_sha, "recovered123");
  assert.equal(publishCalls, 1);
  assert.equal(recoveryCalls, 1);
});

test("an incomplete handler step is never replayed after an ambiguous crash", async (t) => {
  let executeCalls = 0;
  const harness = createHarness(t, {
    async execute() {
      executeCalls += 1;
      throw new Error("simulated crash after external execution started");
    },
  });
  const first = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-ambiguous-1",
  });

  await assert.rejects(
    first.executeTaskLifecycle({
      taskId: "task-ambiguous",
      trigger: "cli",
      attemptId: "attempt-ambiguous",
      engineVersion: "rc-1",
    }),
    /simulated crash/,
  );
  assert.equal(executeCalls, 1);
  assert.equal(
    (await harness.store.attempts.step({
      attemptId: "attempt-ambiguous",
      stage: "EXECUTED",
    })).status,
    "STARTED",
  );

  const resumed = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-ambiguous-2",
  });
  const result = await resumed.executeTaskLifecycle({
    taskId: "task-ambiguous",
    trigger: "cli",
    attemptId: "attempt-ambiguous",
    engineVersion: "rc-1",
  });

  assert.equal(executeCalls, 1);
  assert.equal(result.stage, "BLOCKED");
  assert.match(result.state.terminal.reason, /will not be replayed/);
});

test("an incomplete finish step fails durably after promotion without replay", async (t) => {
  let finishCalls = 0;
  const harness = createHarness(t, {
    async finish() {
      finishCalls += 1;
      throw new Error("simulated crash during finalization");
    },
  });
  const first = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-finish-ambiguous-1",
  });

  await assert.rejects(
    first.executeTaskLifecycle({
      taskId: "task-finish-ambiguous",
      trigger: "cli",
      attemptId: "attempt-finish-ambiguous",
      engineVersion: "rc-1",
    }),
    /simulated crash/,
  );
  assert.equal(
    (await harness.store.attempts.byId("attempt-finish-ambiguous")).stage,
    "PROMOTED",
  );

  const resumed = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-finish-ambiguous-2",
  });
  const result = await resumed.executeTaskLifecycle({
    taskId: "task-finish-ambiguous",
    trigger: "cli",
    attemptId: "attempt-finish-ambiguous",
    engineVersion: "rc-1",
  });

  assert.equal(finishCalls, 1);
  assert.equal(result.stage, "FAILED");
  assert.match(result.state.terminal.reason, /will not be replayed/);
});

test("explicitly non-retryable handler errors terminate as BLOCKED", async (t) => {
  const harness = createHarness(t, {
    async execute() {
      const error = new Error("adapter capability mismatch");
      error.retrySafe = false;
      throw error;
    },
  });
  const executor = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-nonretryable",
  });

  const result = await executor.executeTaskLifecycle({
    taskId: "task-nonretryable",
    trigger: "serve",
    attemptId: "attempt-nonretryable",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "BLOCKED");
  assert.equal(result.promoted, false);
  assert.match(result.state.terminal.reason, /capability mismatch/);
});

test("an abort observed inside a handler terminates as CANCELLED", async (t) => {
  const controller = new AbortController();
  const harness = createHarness(t, {
    async execute() {
      controller.abort();
      const error = new Error("adapter stopped after abort");
      error.retrySafe = false;
      throw error;
    },
  });
  const executor = createTaskLifecycleExecutor({
    abortSignal: controller.signal,
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-cancelled",
  });

  const result = await executor.executeTaskLifecycle({
    taskId: "task-cancelled",
    trigger: "ui",
    attemptId: "attempt-cancelled",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "CANCELLED");
  assert.equal(result.promoted, false);
  assert.match(result.state.terminal.reason, /aborted/u);
});

test("an abort before promotion creates no promotion or branch side effect", async (t) => {
  const controller = new AbortController();
  const harness = createHarness(t);
  const executor = createTaskLifecycleExecutor({
    abortSignal: controller.signal,
    faultInjector({ point }) {
      if (point === "after:READY_TO_PROMOTE") {
        controller.abort();
      }
    },
    handlers: harness.handlers,
    holder: "worker-cancel-before-promotion",
    store: harness.store,
  });

  const result = await executor.executeTaskLifecycle({
    taskId: "task-cancel-before-promotion",
    trigger: "ui",
    attemptId: "attempt-cancel-before-promotion",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "CANCELLED");
  assert.equal(result.promoted, false);
  assert.equal(
    harness.calls.some(([name]) => name === "promote"),
    false,
  );
  assert.equal(
    await harness.store.promotions.byAttempt("attempt-cancel-before-promotion"),
    null,
  );
});

test("an abort after irreversible promotion begins finishes the durable promotion", async (t) => {
  const controller = new AbortController();
  const harness = createHarness(t, {
    async promote(context) {
      harness.calls.push(["promote", context]);
      controller.abort();
      return {
        targetKind: "BRANCH",
        targetRef: `refs/heads/niis/${context.taskId}`,
        branchName: `niis/${context.taskId}`,
        commitSha: "promotion-after-abort",
      };
    },
  });
  const executor = createTaskLifecycleExecutor({
    abortSignal: controller.signal,
    handlers: harness.handlers,
    holder: "worker-cancel-during-promotion",
    store: harness.store,
  });

  const result = await executor.executeTaskLifecycle({
    taskId: "task-cancel-during-promotion",
    trigger: "ui",
    attemptId: "attempt-cancel-during-promotion",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "FINISHED");
  assert.equal(result.promoted, true);
  assert.equal(result.promotion.commit_sha, "promotion-after-abort");
  assert.equal(
    harness.calls.filter(([name]) => name === "promote").length,
    1,
  );
});

test("semantic handler failures can durably terminate an attempt as FAILED", async (t) => {
  const harness = createHarness(t, {
    async execute() {
      throw new TaskLifecycleFailedError("adapter returned a terminal failure");
    },
  });
  const executor = createTaskLifecycleExecutor({
    store: harness.store,
    handlers: harness.handlers,
    holder: "worker-7",
  });
  const result = await executor.executeTaskLifecycle({
    taskId: "task-5",
    trigger: "cli",
    attemptId: "attempt-5",
    engineVersion: "rc-1",
  });

  assert.equal(result.stage, "FAILED");
  assert.equal(result.promoted, false);
  assert.equal(
    (await harness.store.attempts.byId("attempt-5")).last_error,
    "adapter returned a terminal failure",
  );
});
