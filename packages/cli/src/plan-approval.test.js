import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlanApprovalDigest,
  createPlanApprovalDigestNote,
  hasPlanApprovalDigest,
} from "./plan-approval.js";

function createFixture() {
  return {
    artifact: {
      acceptance_commands: [{
        argv: ["npm", "test"],
        id: "unit",
        required: true,
      }],
      derived_task: { title: "Bound plan" },
      task_id: "task-1",
    },
    runtimePreferences: {
      executor_runtime: "codex_local",
      planner_runtime: "codex_local",
    },
    task: {
      acceptance_commands: [{
        argv: ["npm", "test"],
        id: "unit",
        required: true,
      }],
      acceptance_markdown: "- tests pass",
      details_markdown: "Implement the focused change.",
      id: "task-1",
      operator_brief_markdown: "Make the change.",
      out_of_scope: [],
      phase: 1,
      priority: "medium",
      title: "Bound plan",
      updated_at: "2026-07-23T10:00:00.000Z",
    },
  };
}

test("plan approval digest is canonical and binds task, artifact, and runtime", () => {
  const fixture = createFixture();
  const digest = createPlanApprovalDigest(fixture);
  const reorderedArtifact = {
    task_id: fixture.artifact.task_id,
    derived_task: fixture.artifact.derived_task,
    acceptance_commands: fixture.artifact.acceptance_commands,
  };

  assert.equal(
    createPlanApprovalDigest({ ...fixture, artifact: reorderedArtifact }),
    digest,
  );
  assert.notEqual(
    createPlanApprovalDigest({
      ...fixture,
      task: {
        ...fixture.task,
        acceptance_markdown: "- a different acceptance bar",
        updated_at: "2026-07-23T10:01:00.000Z",
      },
    }),
    digest,
  );
  assert.equal(
    createPlanApprovalDigest({
      ...fixture,
      task: {
        ...fixture.task,
        rejection_count: 1,
        status: "BLOCKED",
        updated_at: "2026-07-23T10:02:00.000Z",
      },
    }),
    digest,
    "runtime status bookkeeping must not invalidate an otherwise unchanged approved plan",
  );
  assert.notEqual(
    createPlanApprovalDigest({
      ...fixture,
      runtimePreferences: {
        ...fixture.runtimePreferences,
        executor_runtime: "claude_code_local",
      },
    }),
    digest,
  );
});

test("approval accepts only the exact machine-authored digest note", () => {
  const digest = createPlanApprovalDigest(createFixture());
  const note = createPlanApprovalDigestNote(digest);

  assert.equal(hasPlanApprovalDigest({ notes: [note] }, digest), true);
  assert.equal(
    hasPlanApprovalDigest({ notes: [`operator said ${note}`] }, digest),
    false,
  );
  assert.equal(hasPlanApprovalDigest({ notes: [] }, digest), false);
});
