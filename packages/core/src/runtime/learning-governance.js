import { createPackageManifest } from "../contracts/packages.js";
import {
  createApprovalRecord,
  createGovernanceDecisionArtifact,
} from "../contracts/governance.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import { parseBlockerArtifact } from "../schemas/blocker.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { parseInstinctArtifact } from "../schemas/instinct.js";
import { parseSkillCandidate } from "../schemas/skill-candidate.js";

class LearningGovernanceError extends Error {
  constructor(message) {
    super(message);
    this.name = "LearningGovernanceError";
  }
}

const MIN_SKILL_CANDIDATE_OBSERVATIONS_FOR_REVIEW = 4;
const MIN_GLOBAL_SKILL_CANDIDATE_PROJECTS = 2;

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LearningGovernanceError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function slugify(value) {
  return ensureNonEmptyString(value, "value")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveArtifactIdentity({ instinct = null, skillCandidate = null }) {
  if (skillCandidate !== null) {
    return Object.freeze({
      artifact: parseSkillCandidate(skillCandidate),
      artifact_kind: "skill_candidate",
      artifact_id: skillCandidate.id,
    });
  }

  if (instinct !== null) {
    return Object.freeze({
      artifact: parseInstinctArtifact(instinct),
      artifact_kind: "instinct_artifact",
      artifact_id: instinct.id,
    });
  }

  throw new LearningGovernanceError("provide either instinct or skillCandidate");
}

function normalizeApproval({
  approval = null,
  artifactId,
  artifactKind,
  now,
  taskId,
}) {
  if (approval === null || approval === undefined) {
    return createApprovalRecord({
      actionId: `learning-governance:${artifactKind}:${artifactId}`,
      createdAt: now,
      id: `${taskId}:learning-governance:${artifactId}:approval`,
      notes: [
        "Operator approval is required before a learned artifact may proceed toward active behavior.",
      ],
      ownerRole: "operator",
      reason:
        `Learned artifact ${artifactId} requested progression toward active behavior and requires governance review.`,
      requestedBy: "reviewer",
      riskLevel: "high",
      status: "PENDING",
      taskId,
    });
  }

  return createApprovalRecord({
    actionId: approval.actionId ?? approval.action_id ?? `learning-governance:${artifactKind}:${artifactId}`,
    approvedAt: approval.approvedAt ?? approval.approved_at ?? null,
    createdAt: approval.createdAt ?? approval.created_at ?? now,
    id: approval.id ?? `${taskId}:learning-governance:${artifactId}:approval`,
    notes: approval.notes ?? [],
    ownerRole: approval.ownerRole ?? approval.owner_role ?? "operator",
    reason: approval.reason,
    requestedBy: approval.requestedBy ?? approval.requested_by ?? "reviewer",
    riskLevel: approval.riskLevel ?? approval.risk_level ?? "high",
    status: approval.status ?? "PENDING",
    taskId: approval.taskId ?? approval.task_id ?? taskId,
  });
}

function createGovernanceBlocker({
  artifactId,
  artifactKind,
  now,
  taskId,
  reason,
  blockerClass = "MISSING_APPROVAL",
  nextAction,
}) {
  const timestamp = toIsoTimestamp(now, "learning governance blocker timestamp");

  return parseBlockerArtifact({
    blocker_class: blockerClass,
    created_at: timestamp,
    id: `${taskId}:learning-governance:${artifactKind}:${artifactId}:${Date.parse(timestamp)}`,
    next_action: nextAction,
    reason,
    task_id: taskId,
  });
}

function createGovernanceEvent({
  allowed,
  approval,
  artifactId,
  artifactKind,
  now,
  packageManifest,
  runId,
  taskId,
}) {
  const timestamp = toIsoTimestamp(now, "learning governance event timestamp");

  return parseEventLogEntry({
    actor: "learning_governance_gate",
    event_type: "POLICY_DECISION",
    id: `${runId}:learning-governance:${timestamp}`,
    payload: {
      allowed,
      approval_status: approval.status,
      artifact_id: artifactId,
      artifact_kind: artifactKind,
      package_manifest_id: packageManifest?.id ?? null,
      target_status: packageManifest?.activation_status ?? null,
    },
    run_id: runId,
    task_id: taskId,
    timestamp,
  });
}

function createGovernanceExplainability({
  allowed,
  approval,
  artifactId,
  artifactKind,
  artifactSummary,
  now,
  packageManifest,
  taskId,
}) {
  const timestamp = toIsoTimestamp(now, "learning governance explainability timestamp");
  const policyRefs = ["governance/review-workflow/v1", "governance/shared-learning-activation/v1"];

  return parseExplainabilityRecord({
    alternatives_considered: allowed
      ? [{
        option: "Activate the learned artifact directly",
        reason_rejected: "Learned artifacts still require package activation after governance review; they do not become active behavior directly.",
      }]
      : [{
        option: "Allow learned artifact to affect active behavior immediately",
        reason_rejected: "The governance gate requires explicit operator approval before learned artifacts may proceed toward active behavior.",
      }],
    decision_type: allowed ? "APPROVAL" : "GATE",
    evidence_refs: [artifactId, approval.id],
    human_readable_summary: allowed
      ? `${artifactKind} ${artifactId} passed governance review and may proceed to a reviewable skill package manifest in REVIEW.`
      : `${artifactKind} ${artifactId} remains non-active because governance approval is still required before it may affect active behavior.`,
    id: `${taskId}:learning-governance:${Date.parse(timestamp)}`,
    policy_refs: policyRefs,
    route_chosen: allowed ? "learning_governance_approved" : "learning_governance_blocked",
    task_id: taskId,
    timestamp,
  });
}

function createDecisionArtifact({
  allowed,
  approval,
  artifactId,
  artifactKind,
  now,
  taskId,
}) {
  return createGovernanceDecisionArtifact({
    createdAt: now,
    decisionType: "shared_governance",
    id: `${taskId}:learning-governance:${artifactId}:decision`,
    ownerRole: "operator",
    policyRefs: ["governance/shared-learning-activation/v1"],
    status: allowed ? "APPROVED" : "OPEN",
    summary: allowed
      ? `Governance approved ${artifactKind} ${artifactId} for progression into a reviewable skill package manifest.`
      : `Governance blocked ${artifactKind} ${artifactId} from affecting active behavior until approval is granted.`,
    taskId,
    title: allowed ? "Learning governance approved" : "Learning governance blocked",
  });
}

function createSkillPackageManifestFromCandidate(skillCandidate) {
  return createPackageManifest({
    activationStatus: "REVIEW",
    capabilities: skillCandidate.domains.map((domain) => `learned.${domain}`),
    compatibility: {
      max_niis_version: null,
      min_niis_version: "0.1.0",
      required_adapters: [],
    },
    id: `pkg-${slugify(skillCandidate.id)}`,
    name: skillCandidate.title,
    type: "skill",
    version: "0.1.0",
  });
}

function evaluateSkillCandidateReadiness(skillCandidate) {
  const reasons = [];
  const distinctProjectIds = [...new Set(skillCandidate.evidence.project_ids)];
  const hasEnoughObservations =
    skillCandidate.evidence.total_observation_count >= MIN_SKILL_CANDIDATE_OBSERVATIONS_FOR_REVIEW;

  if (!hasEnoughObservations) {
    reasons.push(
      `skill candidates require at least ${MIN_SKILL_CANDIDATE_OBSERVATIONS_FOR_REVIEW} total observations before they may become reusable skill packages`,
    );
  }

  if (skillCandidate.scope === "project") {
    const matchesProject =
      skillCandidate.project_id !== null
      && distinctProjectIds.includes(skillCandidate.project_id);

    if (!matchesProject) {
      reasons.push(
        "project-scoped skill candidates require project-linked evidence before reviewed packaging",
      );
    }
  }

  if (skillCandidate.scope === "global") {
    if (distinctProjectIds.length < MIN_GLOBAL_SKILL_CANDIDATE_PROJECTS) {
      reasons.push(
        `global skill candidates require evidence from at least ${MIN_GLOBAL_SKILL_CANDIDATE_PROJECTS} projects`,
      );
    }

    if (skillCandidate.promotion_review.review_level !== "elevated") {
      reasons.push("global skill candidates require elevated review before reviewed packaging");
    }
  }

  return Object.freeze({
    observed_project_ids: Object.freeze(distinctProjectIds),
    ok: reasons.length === 0,
    reason: reasons.length === 0 ? null : `${reasons.join(" and ")}.`,
    required_observation_count: MIN_SKILL_CANDIDATE_OBSERVATIONS_FOR_REVIEW,
    scope: skillCandidate.scope,
    total_observation_count: skillCandidate.evidence.total_observation_count,
  });
}

function evaluateLearningGovernance({
  approval = null,
  instinct = null,
  now = new Date(),
  runId = null,
  skillCandidate = null,
  taskId = null,
} = {}) {
  const identity = deriveArtifactIdentity({ instinct, skillCandidate });
  const resolvedTaskId = taskId ?? `learning-governance:${identity.artifact_id}`;
  const resolvedRunId = runId ?? `${resolvedTaskId}:run`;
  const normalizedApproval = normalizeApproval({
    approval,
    artifactId: identity.artifact_id,
    artifactKind: identity.artifact_kind,
    now,
    taskId: resolvedTaskId,
  });

  if (identity.artifact_kind === "instinct_artifact") {
    const reason =
      `Instinct ${identity.artifact_id} cannot directly affect active behavior; it must first be clustered `
      + "into a reviewed skill candidate and then pass a separate governance path.";
    const blocker = createGovernanceBlocker({
      artifactId: identity.artifact_id,
      artifactKind: identity.artifact_kind,
      blockerClass: "DEPENDENCY_UNMET",
      nextAction:
        "Cluster the instinct into a reviewed skill candidate before requesting governance progression toward active behavior.",
      now,
      reason,
      taskId: resolvedTaskId,
    });

    return Object.freeze({
      allowed: false,
      approval: normalizedApproval,
      blocker,
      decision: createDecisionArtifact({
        allowed: false,
        approval: normalizedApproval,
        artifactId: identity.artifact_id,
        artifactKind: identity.artifact_kind,
        now,
        taskId: resolvedTaskId,
      }),
      event: createGovernanceEvent({
        allowed: false,
        approval: normalizedApproval,
        artifactId: identity.artifact_id,
        artifactKind: identity.artifact_kind,
        now,
        packageManifest: null,
        runId: resolvedRunId,
        taskId: resolvedTaskId,
      }),
      explainability: createGovernanceExplainability({
        allowed: false,
        approval: normalizedApproval,
        artifactId: identity.artifact_id,
        artifactKind: identity.artifact_kind,
        artifactSummary: identity.artifact.trigger,
        now,
        packageManifest: null,
        taskId: resolvedTaskId,
      }),
      package_manifest: null,
      target_status: null,
    });
  }

  const evidenceEvaluation = evaluateSkillCandidateReadiness(identity.artifact);
  const approvalGranted =
    evidenceEvaluation.ok
    && normalizedApproval.status === "APPROVED"
    && normalizedApproval.owner_role === "operator";
  const blocker = !evidenceEvaluation.ok
    ? createGovernanceBlocker({
      artifactId: identity.artifact_id,
      artifactKind: identity.artifact_kind,
      blockerClass: "DEPENDENCY_UNMET",
      nextAction:
        "Accumulate repeated evidence for the reviewed skill candidate before requesting governance progression toward a reusable skill package.",
      now,
      reason:
        `Skill candidate ${identity.artifact_id} does not yet have durable evidence for reviewed reusable-skill packaging: `
        + evidenceEvaluation.reason,
      taskId: resolvedTaskId,
    })
    : !(
      normalizedApproval.status === "APPROVED"
      && normalizedApproval.owner_role === "operator"
    )
      ? createGovernanceBlocker({
        artifactId: identity.artifact_id,
        artifactKind: identity.artifact_kind,
        nextAction:
          "Record operator approval for the learned skill candidate before generating a reviewable skill package manifest.",
        now,
        reason:
          `Skill candidate ${identity.artifact_id} cannot proceed toward active behavior until an operator `
          + "approval artifact is granted.",
        taskId: resolvedTaskId,
      })
      : null;
  const packageManifest = approvalGranted
    ? createSkillPackageManifestFromCandidate(identity.artifact)
    : null;

  return Object.freeze({
    allowed: approvalGranted,
    approval: normalizedApproval,
    blocker,
    decision: createDecisionArtifact({
      allowed: approvalGranted,
      approval: normalizedApproval,
      artifactId: identity.artifact_id,
      artifactKind: identity.artifact_kind,
      now,
      taskId: resolvedTaskId,
    }),
    evidence_evaluation: evidenceEvaluation,
    event: createGovernanceEvent({
      allowed: approvalGranted,
      approval: normalizedApproval,
      artifactId: identity.artifact_id,
      artifactKind: identity.artifact_kind,
      now,
      packageManifest,
      runId: resolvedRunId,
      taskId: resolvedTaskId,
    }),
    explainability: createGovernanceExplainability({
      allowed: approvalGranted,
      approval: normalizedApproval,
      artifactId: identity.artifact_id,
      artifactKind: identity.artifact_kind,
      artifactSummary: identity.artifact.summary,
      now,
      packageManifest,
      taskId: resolvedTaskId,
    }),
    package_manifest: packageManifest,
    target_status: packageManifest?.activation_status ?? null,
  });
}

export {
  LearningGovernanceError,
  evaluateLearningGovernance,
};
