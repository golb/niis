import { parseGoalRecord } from "../schemas/goal.js";
import { parseRunRecord } from "../schemas/run.js";
import { parseTaskRecord } from "../schemas/task.js";
import { toIsoTimestamp } from "../scheduler/queue.js";

class GovernanceContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "GovernanceContractError";
  }
}

const GOVERNANCE_OWNER_ROLES = Object.freeze(["worker", "reviewer", "validator", "operator", "system"]);
const GOVERNANCE_DECISION_TYPES = Object.freeze([
  "roadmap_change",
  "scope_exception",
  "phase_exit",
  "release_acceptance",
  "shared_governance",
]);
const APPROVAL_DECISION_ACTIONS = Object.freeze(["approve", "reject", "defer"]);
const APPROVAL_STATUSES = Object.freeze(["PENDING", "APPROVED", "REJECTED", "EXPIRED"]);
const APPROVAL_GOVERNANCE_STATES = Object.freeze([
  "AWAITING_OPERATOR_DECISION",
  "DEFERRED_PENDING_FOLLOWUP",
  "REJECTED_PENDING_REWORK",
  "MISSING_APPROVAL_RECORD",
]);
const ESCALATION_STATUSES = Object.freeze(["OPEN", "ACKNOWLEDGED", "RESOLVED", "CANCELLED"]);
const PHASE_EXIT_STATUSES = Object.freeze(["PENDING", "PASSED", "FAILED"]);
const ROADMAP_CHANGE_KINDS = Object.freeze(["proposal", "emergency_deviation"]);

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GovernanceContractError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureRole(value, label) {
  const normalizedRole = ensureNonEmptyString(value, label);

  if (!GOVERNANCE_OWNER_ROLES.includes(normalizedRole)) {
    throw new GovernanceContractError(
      `${label} must be one of ${GOVERNANCE_OWNER_ROLES.join(", ")}`,
    );
  }

  return normalizedRole;
}

function ensureEnum(value, label, allowedValues) {
  const normalizedValue = ensureNonEmptyString(value, label);

  if (!allowedValues.includes(normalizedValue)) {
    throw new GovernanceContractError(
      `${label} must be one of ${allowedValues.join(", ")}`,
    );
  }

  return normalizedValue;
}

function ensureStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new GovernanceContractError(`${label} must be an array`);
  }

  return [...new Set(values.map((value, index) =>
    ensureNonEmptyString(value, `${label}[${index}]`)))];
}

function ensureRoleArray(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new GovernanceContractError(`${label} must be a non-empty array`);
  }

  return [...new Set(values.map((value, index) =>
    ensureRole(value, `${label}[${index}]`)))];
}

function createReviewWorkflowDefinition({
  id = "governance/review-workflow/v1",
  reviewOwners = ["reviewer", "validator", "operator"],
  approvalOwners = ["operator"],
  releaseOwners = ["operator"],
}) {
  return Object.freeze({
    approval_owners: Object.freeze(ensureRoleArray(approvalOwners, "approvalOwners")),
    id: ensureNonEmptyString(id, "review workflow id"),
    release_owners: Object.freeze(ensureRoleArray(releaseOwners, "releaseOwners")),
    review_owners: Object.freeze(ensureRoleArray(reviewOwners, "reviewOwners")),
  });
}

function createGovernanceDecisionArtifact({
  id,
  taskId,
  decisionType,
  title,
  summary,
  ownerRole,
  policyRefs = [],
  createdAt = new Date(),
  status = "OPEN",
}) {
  return Object.freeze({
    created_at: toIsoTimestamp(createdAt, "createdAt"),
    decision_type: ensureEnum(decisionType, "decisionType", GOVERNANCE_DECISION_TYPES),
    id: ensureNonEmptyString(id, "governance decision id"),
    owner_role: ensureRole(ownerRole, "ownerRole"),
    policy_refs: Object.freeze(ensureStringArray(policyRefs, "policyRefs")),
    status: ensureNonEmptyString(status, "status"),
    summary: ensureNonEmptyString(summary, "summary"),
    task_id: ensureNonEmptyString(taskId, "taskId"),
    title: ensureNonEmptyString(title, "title"),
  });
}

function createApprovalRecord({
  id,
  taskId,
  actionId,
  requestedBy,
  ownerRole = "operator",
  riskLevel = "high",
  reason,
  createdAt = new Date(),
  status = "PENDING",
  approvedAt = null,
  notes = [],
}) {
  return Object.freeze({
    action_id: ensureNonEmptyString(actionId, "actionId"),
    approved_at: approvedAt === null ? null : toIsoTimestamp(approvedAt, "approvedAt"),
    created_at: toIsoTimestamp(createdAt, "createdAt"),
    id: ensureNonEmptyString(id, "approval id"),
    notes: Object.freeze(ensureStringArray(notes, "notes")),
    owner_role: ensureRole(ownerRole, "ownerRole"),
    reason: ensureNonEmptyString(reason, "reason"),
    requested_by: ensureRole(requestedBy, "requestedBy"),
    risk_level: ensureNonEmptyString(riskLevel, "riskLevel"),
    status: ensureEnum(status, "status", APPROVAL_STATUSES),
    task_id: ensureNonEmptyString(taskId, "taskId"),
  });
}

function createEscalationRecord({
  id,
  taskId,
  sourceRole,
  targetRole,
  reason,
  contextSummary,
  createdAt = new Date(),
  status = "OPEN",
}) {
  return Object.freeze({
    context_summary: ensureNonEmptyString(contextSummary, "contextSummary"),
    created_at: toIsoTimestamp(createdAt, "createdAt"),
    id: ensureNonEmptyString(id, "escalation id"),
    reason: ensureNonEmptyString(reason, "reason"),
    source_role: ensureRole(sourceRole, "sourceRole"),
    status: ensureEnum(status, "status", ESCALATION_STATUSES),
    target_role: ensureRole(targetRole, "targetRole"),
    task_id: ensureNonEmptyString(taskId, "taskId"),
  });
}

function createHandoffRecord({
  id,
  taskId,
  fromRole,
  toRole,
  reason,
  contextSummary,
  expectedOutcome,
  createdAt = new Date(),
}) {
  return Object.freeze({
    context_summary: ensureNonEmptyString(contextSummary, "contextSummary"),
    created_at: toIsoTimestamp(createdAt, "createdAt"),
    expected_outcome: ensureNonEmptyString(expectedOutcome, "expectedOutcome"),
    from_role: ensureRole(fromRole, "fromRole"),
    id: ensureNonEmptyString(id, "handoff id"),
    reason: ensureNonEmptyString(reason, "reason"),
    task_id: ensureNonEmptyString(taskId, "taskId"),
    to_role: ensureRole(toRole, "toRole"),
  });
}

function createPhaseExitRecord({
  id,
  phase,
  checkedBy,
  entryContext = [],
  exitCriteria = [],
  summary,
  checkedAt = new Date(),
  status = "PENDING",
}) {
  if (!Number.isInteger(phase) || phase < 0) {
    throw new GovernanceContractError("phase must be a non-negative integer");
  }

  if (!Array.isArray(exitCriteria) || exitCriteria.length === 0) {
    throw new GovernanceContractError("exitCriteria must be a non-empty array");
  }

  const normalizedExitCriteria = exitCriteria.map((criterion, index) => {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
      throw new GovernanceContractError(`exitCriteria[${index}] must be a plain object`);
    }

    return Object.freeze({
      passed: Boolean(criterion.passed),
      summary: ensureNonEmptyString(
        criterion.summary ?? criterion.id ?? `criterion-${index + 1}`,
        `exitCriteria[${index}].summary`,
      ),
    });
  });

  return Object.freeze({
    checked_at: toIsoTimestamp(checkedAt, "checkedAt"),
    checked_by: ensureRole(checkedBy, "checkedBy"),
    entry_context: Object.freeze(ensureStringArray(entryContext, "entryContext")),
    exit_criteria: Object.freeze(normalizedExitCriteria),
    id: ensureNonEmptyString(id, "phase exit id"),
    phase,
    status: ensureEnum(status, "status", PHASE_EXIT_STATUSES),
    summary: ensureNonEmptyString(summary, "summary"),
  });
}

function createRoadmapChangeRequest({
  id,
  title,
  summary,
  proposedBy,
  kind = "proposal",
  decisionLogRef = null,
  approvalGate = "operator",
  createdAt = new Date(),
  emergencyJustification = null,
}) {
  const normalizedKind = ensureEnum(kind, "kind", ROADMAP_CHANGE_KINDS);

  if (normalizedKind === "proposal" && !decisionLogRef) {
    throw new GovernanceContractError(
      "roadmap proposals require decisionLogRef before they can pass the approval gate",
    );
  }

  if (normalizedKind === "emergency_deviation" && !emergencyJustification) {
    throw new GovernanceContractError(
      "emergency roadmap deviations require emergencyJustification",
    );
  }

  return Object.freeze({
    approval_gate: ensureRole(approvalGate, "approvalGate"),
    created_at: toIsoTimestamp(createdAt, "createdAt"),
    decision_log_ref: decisionLogRef ? ensureNonEmptyString(decisionLogRef, "decisionLogRef") : null,
    emergency_justification:
      emergencyJustification === null ? null : ensureNonEmptyString(emergencyJustification, "emergencyJustification"),
    id: ensureNonEmptyString(id, "roadmap change id"),
    kind: normalizedKind,
    proposed_by: ensureRole(proposedBy, "proposedBy"),
    summary: ensureNonEmptyString(summary, "summary"),
    title: ensureNonEmptyString(title, "title"),
  });
}

function linkTaskToGoal(taskRecord, goalId) {
  const task = parseTaskRecord(taskRecord);

  return parseTaskRecord({
    ...task,
    goal_id: goalId === null ? null : ensureNonEmptyString(goalId, "goalId"),
  });
}

function summarizeGoalProgress({ goal, tasks = [], runs = [] }) {
  const normalizedGoal = parseGoalRecord(goal);
  const normalizedTasks = tasks.map((task) => parseTaskRecord(task))
    .filter((task) => task.goal_id === normalizedGoal.id);
  const taskIds = new Set(normalizedTasks.map((task) => task.id));
  const normalizedRuns = runs.map((run) => parseRunRecord(run))
    .filter((run) => taskIds.has(run.task_id));

  return Object.freeze({
    goal_id: normalizedGoal.id,
    task_count: normalizedTasks.length,
    task_status_counts: Object.freeze({
      BLOCKED: normalizedTasks.filter((task) => task.status === "BLOCKED").length,
      DONE: normalizedTasks.filter((task) => task.status === "DONE").length,
      IN_PROGRESS: normalizedTasks.filter((task) => task.status === "IN_PROGRESS").length,
      IN_REVIEW: normalizedTasks.filter((task) => task.status === "IN_REVIEW").length,
      PENDING: normalizedTasks.filter((task) => task.status === "PENDING").length,
      REJECTED: normalizedTasks.filter((task) => task.status === "REJECTED").length,
    }),
    total_cost_usd: normalizedRuns.reduce((total, run) => total + Number(run.cost.estimated_usd), 0),
    total_runs: normalizedRuns.length,
  });
}

export {
  APPROVAL_DECISION_ACTIONS,
  APPROVAL_GOVERNANCE_STATES,
  APPROVAL_STATUSES,
  ESCALATION_STATUSES,
  GOVERNANCE_DECISION_TYPES,
  GOVERNANCE_OWNER_ROLES,
  GovernanceContractError,
  PHASE_EXIT_STATUSES,
  ROADMAP_CHANGE_KINDS,
  createApprovalRecord,
  createEscalationRecord,
  createGovernanceDecisionArtifact,
  createHandoffRecord,
  createPhaseExitRecord,
  createReviewWorkflowDefinition,
  createRoadmapChangeRequest,
  linkTaskToGoal,
  summarizeGoalProgress,
};
