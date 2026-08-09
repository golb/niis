import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_DECISION_ACTIONS,
  APPROVAL_GOVERNANCE_STATES,
  GovernanceContractError,
  createApprovalRecord,
  createEscalationRecord,
  createGovernanceDecisionArtifact,
  createHandoffRecord,
  createPhaseExitRecord,
  createReviewWorkflowDefinition,
  createRoadmapChangeRequest,
  linkTaskToGoal,
  summarizeGoalProgress,
} from "./governance.js";

function createTask({
  id,
  status = "PENDING",
  goalId = null,
} = {}) {
  return {
    id: id ?? "task-1",
    title: `Task ${id ?? "task-1"}`,
    status,
    phase: 4,
    priority: "medium",
    goal_id: goalId,
    depends_on: [],
    assigned_to: null,
    out_of_scope: [],
    rejection_count: 0,
    max_rejections: 5,
    created_at: "2026-03-17T10:00:00.000Z",
    updated_at: "2026-03-17T10:00:00.000Z",
    transition_log: [],
  };
}

function createRun({
  id,
  taskId,
  estimatedUsd,
} = {}) {
  return {
    id: id ?? "run-1",
    task_id: taskId ?? "task-1",
    subtask_id: null,
    agent_id: "agent-1",
    adapter_id: "adapter-1",
    status: "COMPLETED",
    started_at: "2026-03-17T10:00:00.000Z",
    finished_at: "2026-03-17T10:05:00.000Z",
    checkpoint_id: null,
    exit_code: 0,
    cost: {
      tokens_in: 10,
      tokens_out: 20,
      duration_ms: 1000,
      estimated_usd: estimatedUsd ?? 0.25,
    },
    invocation_source: "assignment",
    run_log: {
      storage: "inline",
      ref: null,
      bytes: 12,
      sha256: "abc123",
    },
    task_session_key: null,
  };
}

function createGoal({
  id = "goal-1",
} = {}) {
  return {
    id,
    title: "Governance review",
    description: "Track governance work",
    level: "project",
    status: "active",
    parent_goal_id: null,
    project_id: "project-1",
    owner_agent_id: null,
    created_at: "2026-03-17T10:00:00.000Z",
    updated_at: "2026-03-17T10:00:00.000Z",
  };
}

test("createReviewWorkflowDefinition keeps review, approval, and release ownership explicit", () => {
  const workflow = createReviewWorkflowDefinition({
    reviewOwners: ["reviewer", "validator"],
    approvalOwners: ["operator"],
    releaseOwners: ["operator"],
  });

  assert.deepEqual(workflow.review_owners, ["reviewer", "validator"]);
  assert.deepEqual(workflow.approval_owners, ["operator"]);
  assert.deepEqual(workflow.release_owners, ["operator"]);
});

test("governance exports canonical approval actions and queue states", () => {
  assert.deepEqual(APPROVAL_DECISION_ACTIONS, ["approve", "reject", "defer"]);
  assert.deepEqual(APPROVAL_GOVERNANCE_STATES, [
    "AWAITING_OPERATOR_DECISION",
    "DEFERRED_PENDING_FOLLOWUP",
    "REJECTED_PENDING_REWORK",
    "MISSING_APPROVAL_RECORD",
  ]);
});

test("governance artifacts normalize durable approval, escalation, handoff, and phase-exit records", () => {
  const approval = createApprovalRecord({
    id: "approval-1",
    taskId: "task-1",
    actionId: "danger.full_access",
    requestedBy: "worker",
    reason: "Need a risky action for proof.",
  });
  const escalation = createEscalationRecord({
    id: "escalation-1",
    taskId: "task-1",
    sourceRole: "worker",
    targetRole: "operator",
    reason: "Need operator intervention.",
    contextSummary: "Workspace policy blocks completion proof.",
  });
  const handoff = createHandoffRecord({
    id: "handoff-1",
    taskId: "task-1",
    fromRole: "worker",
    toRole: "reviewer",
    reason: "Implementation slice finished.",
    contextSummary: "Runtime evidence is attached for review.",
    expectedOutcome: "Review verdict with cited evidence.",
  });
  const phaseExit = createPhaseExitRecord({
    id: "phase-4-exit",
    phase: 4,
    checkedBy: "operator",
    entryContext: ["required deliverables implemented"],
    exitCriteria: [
      { passed: true, summary: "Ownership is explicit." },
      { passed: true, summary: "Task notes exist." },
    ],
    summary: "Governance exit criteria pass.",
    status: "PASSED",
  });

  assert.equal(approval.status, "PENDING");
  assert.equal(escalation.status, "OPEN");
  assert.equal(handoff.to_role, "reviewer");
  assert.equal(phaseExit.status, "PASSED");
  assert.equal(phaseExit.exit_criteria.length, 2);
});

test("createRoadmapChangeRequest requires decision log references except for emergency deviations", () => {
  assert.throws(
    () => createRoadmapChangeRequest({
      id: "proposal-1",
      title: "Adjust roadmap",
      summary: "Normal change",
      proposedBy: "operator",
    }),
    GovernanceContractError,
  );

  const proposal = createRoadmapChangeRequest({
    id: "proposal-2",
    title: "Adjust roadmap",
    summary: "Normal change",
    proposedBy: "operator",
    decisionLogRef: "docs/decisions/2026-03-17-example.md",
  });
  const emergency = createRoadmapChangeRequest({
    id: "proposal-3",
    title: "Emergency deviation",
    summary: "Temporary deviation for proof.",
    proposedBy: "operator",
    kind: "emergency_deviation",
    emergencyJustification: "Critical runtime corruption blocks any further progress.",
  });
  const decision = createGovernanceDecisionArtifact({
    id: "decision-1",
    taskId: "task-1",
    decisionType: "roadmap_change",
    title: "Roadmap change accepted",
    summary: "The proposal may proceed through approval.",
    ownerRole: "operator",
    policyRefs: ["governance/roadmap-evolution/v1"],
  });

  assert.equal(proposal.kind, "proposal");
  assert.equal(emergency.kind, "emergency_deviation");
  assert.equal(decision.decision_type, "roadmap_change");
});

test("goal linkage stays optional while enabling progress and cost reporting", () => {
  const linkedTask = linkTaskToGoal(createTask({ id: "task-2" }), "goal-1");
  const summary = summarizeGoalProgress({
    goal: createGoal(),
    tasks: [
      linkedTask,
      createTask({ id: "task-3", goalId: "goal-1", status: "DONE" }),
      createTask({ id: "task-4", goalId: null }),
    ],
    runs: [
      createRun({ id: "run-1", taskId: "task-2", estimatedUsd: 1.25 }),
      createRun({ id: "run-2", taskId: "task-3", estimatedUsd: 0.5 }),
      createRun({ id: "run-3", taskId: "task-4", estimatedUsd: 99 }),
    ],
  });

  assert.equal(linkedTask.goal_id, "goal-1");
  assert.equal(summary.task_count, 2);
  assert.equal(summary.task_status_counts.DONE, 1);
  assert.equal(summary.total_runs, 2);
  assert.equal(summary.total_cost_usd, 1.75);
});
