import test from "node:test";
import assert from "node:assert/strict";

import { createSessionCodec } from "../contracts/adapter.js";
import { createResumePlan, restoreCheckpointState, restoreTaskSession } from "./resume.js";

const checkpoint = {
  id: "checkpoint-1",
  run_id: "run-1",
  state_snapshot: {
    budget: {
      spent: 12,
    },
    routing: {
      lane: "worker",
    },
  },
  context_summary: "Task context was already assembled and the workspace is ready.",
  created_at: "2026-03-21T10:20:00.000Z",
  resumable: true,
  resume_instructions: "Continue from the existing workspace and verify remaining acceptance criteria.",
};

const taskSession = {
  task_key: "TASK-1:worker",
  agent_id: "agent-1",
  adapter_type: "codex_local",
  session_params: {
    session_id: "raw-session",
  },
  last_run_id: "run-1",
  display_id: "codex-1",
  created_at: "2026-03-21T10:00:00.000Z",
  updated_at: "2026-03-21T10:20:00.000Z",
};

test("restoreCheckpointState deep-merges checkpoint snapshot onto base state", () => {
  const restored = restoreCheckpointState({
    checkpoint,
    baseState: {
      budget: {
        limit: 100,
      },
      workflow: {
        strictness: "strict",
      },
    },
  });

  assert.deepEqual(restored, {
    budget: {
      limit: 100,
      spent: 12,
    },
    routing: {
      lane: "worker",
    },
    workflow: {
      strictness: "strict",
    },
  });
});

test("restoreTaskSession uses the adapter session codec when present", () => {
  const sessionCodec = createSessionCodec({
    deserialize: (stored) => ({
      ...stored,
      restored: true,
    }),
  });

  const restored = restoreTaskSession({
    taskSession,
    sessionCodec,
  });

  assert.equal(restored?.task_key, "TASK-1:worker");
  assert.equal(restored?.session_params.restored, true);
});

test("createResumePlan restores state, session, and checkpoint artifacts", () => {
  const sessionCodec = createSessionCodec({
    deserialize: (stored) => ({
      ...stored,
      restored: true,
    }),
  });
  const plan = createResumePlan({
    taskId: "TASK-1",
    checkpoint,
    taskSession,
    sessionCodec,
    baseState: {
      budget: {
        limit: 100,
      },
    },
    baseContext: {
      workflow_id: "workflow-1",
    },
    now: "2026-03-21T10:30:00.000Z",
  });

  assert.equal(plan.invocation_source, "resume");
  assert.equal(plan.run_id, "run-1");
  assert.equal(plan.restored_state.budget.limit, 100);
  assert.equal(plan.restored_state.budget.spent, 12);
  assert.equal(plan.restored_context.workflow_id, "workflow-1");
  assert.equal(plan.restored_context.session?.session_params.restored, true);
  assert.equal(plan.event.event_type, "CHECKPOINT");
  assert.equal(plan.explainability.route_chosen, "resume:checkpoint-1");
});

test("createResumePlan rejects checkpoints explicitly marked non-resumable", () => {
  assert.throws(
    () =>
      createResumePlan({
        taskId: "TASK-1",
        checkpoint: {
          ...checkpoint,
          id: "checkpoint-2",
          resumable: false,
        },
      }),
    /marked non-resumable/,
  );
});
