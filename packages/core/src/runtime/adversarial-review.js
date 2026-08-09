import {
  ADVERSARIAL_REVIEW_STAGE_ROLES,
} from "../policy/activation-review.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import { parseBlockerArtifact } from "../schemas/blocker.js";
import { parseEvidencePacket } from "../schemas/evidence.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { parseReviewVerdict } from "../schemas/verdict.js";
import { normalizeValidatorResult } from "../contracts/validator.js";

class AdversarialReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdversarialReviewError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AdversarialReviewError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdversarialReviewError(`${label} must be a plain object`);
  }

  return value;
}

function ensureReviewPlan(reviewPlan) {
  const normalizedReviewPlan = ensurePlainObject(reviewPlan, "reviewPlan");

  if (normalizedReviewPlan.required !== true) {
    throw new AdversarialReviewError("reviewPlan.required must be true for adversarial execution");
  }

  if (!Array.isArray(normalizedReviewPlan.stages) || normalizedReviewPlan.stages.length === 0) {
    throw new AdversarialReviewError("reviewPlan.stages must contain at least one stage");
  }

  return normalizedReviewPlan;
}

function ensureStageRole(role, label) {
  const normalizedRole = ensureNonEmptyString(role, label);

  if (!ADVERSARIAL_REVIEW_STAGE_ROLES.includes(normalizedRole)) {
    throw new AdversarialReviewError(
      `${label} must be one of ${ADVERSARIAL_REVIEW_STAGE_ROLES.join(", ")}`,
    );
  }

  return normalizedRole;
}

function createAdversarialReviewer({
  id,
  role,
  description = null,
  review: reviewFn,
}) {
  const reviewerId = ensureNonEmptyString(id, "reviewer.id");
  const reviewerRole = ensureStageRole(role, "reviewer.role");

  if (typeof reviewFn !== "function") {
    throw new AdversarialReviewError(`reviewer ${reviewerId} must expose review()`);
  }

  return Object.freeze({
    description: description === null ? reviewerId : ensureNonEmptyString(description, "reviewer.description"),
    id: reviewerId,
    role: reviewerRole,
    review(context) {
      return normalizeAdversarialResult(reviewFn(context), reviewerId);
    },
  });
}

function normalizeAdversarialResult(result, reviewerId) {
  const candidate = result && typeof result === "object" && !Array.isArray(result)
    ? { ...result }
    : result;

  if (candidate && typeof candidate === "object" && candidate.human_summary === null) {
    delete candidate.human_summary;
  }

  return normalizeValidatorResult(candidate, reviewerId);
}

function createCanonicalVerdict({
  taskId,
  runId,
  reviewer,
  stage,
  result,
  now,
}) {
  const timestamp = toIsoTimestamp(now, "adversarial reviewer verdict timestamp");

  return parseReviewVerdict({
    created_at: timestamp,
    evidence_packet_id: `${runId}:${stage.stage_id}:${reviewer.id}:verdict:${timestamp}:evidence`,
    failure_attribution: result.failure_attribution,
    id: `${runId}:${stage.stage_id}:${reviewer.id}:verdict:${timestamp}`,
    next_action: result.next_action,
    reason: result.reason,
    reviewer_id: reviewer.id,
    run_id: runId,
    task_id: taskId,
    verdict_class: result.verdict_class,
  });
}

function createCanonicalEvidencePacket({
  verdict,
  result,
}) {
  return parseEvidencePacket({
    ...result.evidence_packet,
    id: `${verdict.id}:evidence`,
    verdict_id: verdict.id,
  });
}

function createReviewEvent({
  reviewer,
  stage,
  verdict,
  subjectKind,
  runId,
  taskId,
  now,
}) {
  const timestamp = toIsoTimestamp(now, "adversarial reviewer event timestamp");

  return parseEventLogEntry({
    actor: reviewer.id,
    event_type: "VALIDATOR_RUN",
    id: `${runId}:${stage.stage_id}:${reviewer.id}:event:${timestamp}`,
    payload: {
      review_role: reviewer.role,
      review_stage_id: stage.stage_id,
      subject_kind: subjectKind,
      verdict_class: verdict.verdict_class,
      failure_attribution: verdict.failure_attribution,
    },
    run_id: runId,
    task_id: taskId,
    timestamp,
  });
}

function createReviewExplainability({
  reviewer,
  stage,
  verdict,
  now,
  policyRefs,
  taskId,
  runId,
}) {
  const timestamp = toIsoTimestamp(now, "adversarial reviewer explainability timestamp");

  return parseExplainabilityRecord({
    alternatives_considered: [],
    decision_type: "GATE",
    evidence_refs: [verdict.evidence_packet_id],
    human_readable_summary:
      `${reviewer.role} reviewer ${reviewer.id} returned ${verdict.verdict_class}`
      + (verdict.failure_attribution !== "none"
        ? ` (${verdict.failure_attribution})`
        : "")
      + `: ${verdict.reason}`,
    id: `${runId}:${stage.stage_id}:${reviewer.id}:explainability:${timestamp}`,
    policy_refs: policyRefs,
    route_chosen: `adversarial_review:${stage.stage_id}`,
    task_id: taskId,
    timestamp,
  });
}

function createReviewSummary({
  finalVerdict,
  resultCount,
  runId,
  taskId,
  now,
  policyRefs,
}) {
  const timestamp = toIsoTimestamp(now, "adversarial review summary timestamp");

  return parseExplainabilityRecord({
    alternatives_considered: [],
    decision_type: "GATE",
    evidence_refs: [finalVerdict.evidence_packet_id],
    human_readable_summary:
      `adversarial review completed with ${finalVerdict.verdict_class} after ${resultCount} stage(s)`,
    id: `${runId}:adversarial-review-summary:${timestamp}`,
    policy_refs: policyRefs,
    route_chosen: "adversarial_review",
    task_id: taskId,
    timestamp,
  });
}

function mapVerdictClassToBlockerClass(verdictClass) {
  switch (verdictClass) {
    case "ENV_BLOCK":
      return "ENV_BLOCK";
    case "NEEDS_ESCALATION":
      return "MISSING_APPROVAL";
    case "DEFECT":
    case "EVIDENCE_GAP":
    case "PARTIAL_PROGRESS":
      return "MISSING_EVIDENCE";
    default:
      return null;
  }
}

function createBlockerFromVerdict({
  verdict,
  now,
  taskId,
  reviewPlan,
}) {
  const blockerClass = mapVerdictClassToBlockerClass(verdict.verdict_class);

  if (!blockerClass) {
    return null;
  }

  const timestamp = toIsoTimestamp(now, "adversarial review blocker timestamp");

  return parseBlockerArtifact({
    blocker_class: blockerClass,
    created_at: timestamp,
    id: `${taskId}:adversarial-review:${reviewPlan.pattern_id ?? "review"}:${Date.parse(timestamp)}`,
    next_action: verdict.next_action,
    reason: verdict.reason,
    task_id: taskId,
  });
}

function createSyntheticEscalationResult(message) {
  return normalizeValidatorResult({
    blocker_class: "MISSING_APPROVAL",
    evidence_packet: {
      authenticity_status: "UNVERIFIED",
      items: [{
        content: message,
        source: "adversarial_review",
        type: "review_note",
      }],
      markers: {
        auth_surfaces_attempted: [],
        browser_live_checks: [],
        checked_urls: [],
        runtime_evidence_succeeded: false,
      },
    },
    next_action: "Repair the adversarial review stage wiring before trusting the high-stakes review result.",
    observation_signals: [],
    policy_refs: ["policy/activation_review/v1"],
    reason: message,
    verdict_class: "NEEDS_ESCALATION",
  }, "adversarial-review");
}

function runAdversarialReview({
  now = new Date(),
  reviewPlan,
  reviewers = [],
  runId,
  subject = {},
  subjectKind = "package_activation",
  taskId,
} = {}) {
  const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
  const normalizedRunId = ensureNonEmptyString(runId, "runId");
  const normalizedReviewPlan = ensureReviewPlan(reviewPlan);
  const normalizedSubjectKind = ensureNonEmptyString(subjectKind, "subjectKind");
  const normalizedReviewers = Array.isArray(reviewers) ? reviewers : [];
  const reviewersByRole = new Map();

  for (const reviewer of normalizedReviewers) {
    const normalizedReviewer = ensurePlainObject(reviewer, "reviewer");
    const reviewerRole = ensureStageRole(normalizedReviewer.role, "reviewer.role");

    if (reviewersByRole.has(reviewerRole)) {
      throw new AdversarialReviewError(`duplicate adversarial reviewer role: ${reviewerRole}`);
    }

    if (typeof normalizedReviewer.review !== "function") {
      throw new AdversarialReviewError(`reviewer ${normalizedReviewer.id ?? reviewerRole} must expose review()`);
    }

    reviewersByRole.set(reviewerRole, normalizedReviewer);
  }

  const results = [];
  const events = [];
  const explainability = [];
  let finalVerdict = null;
  let finalEvidencePacket = null;

  for (const stage of normalizedReviewPlan.stages) {
    const reviewer = reviewersByRole.get(stage.reviewer_role);
    let result;

    if (!reviewer) {
      result = createSyntheticEscalationResult(
        `adversarial review stage ${stage.stage_id} is missing reviewer role ${stage.reviewer_role}`,
      );
    } else {
      try {
        result = normalizeAdversarialResult(reviewer.review({
          previous_results: Object.freeze([...results]),
          reviewPlan: normalizedReviewPlan,
          stage,
          subject,
        }), reviewer.id);
      } catch (error) {
        result = createSyntheticEscalationResult(
          `adversarial reviewer ${reviewer.id} failed during ${stage.stage_id}: ${error.message}`,
        );
      }
    }

    const effectiveReviewer = reviewer ?? {
      id: `${stage.reviewer_role}-missing-reviewer`,
      role: stage.reviewer_role,
    };
    const verdict = createCanonicalVerdict({
      now,
      reviewer: effectiveReviewer,
      result,
      runId: normalizedRunId,
      stage,
      taskId: normalizedTaskId,
    });
    const evidencePacket = createCanonicalEvidencePacket({
      result,
      verdict,
    });
    const event = createReviewEvent({
      now,
      reviewer: effectiveReviewer,
      runId: normalizedRunId,
      stage,
      subjectKind: normalizedSubjectKind,
      taskId: normalizedTaskId,
      verdict,
    });
    const explainabilityRecord = createReviewExplainability({
      now,
      policyRefs: ["policy/activation_review/v1", ...result.policy_refs],
      reviewer: effectiveReviewer,
      runId: normalizedRunId,
      stage,
      taskId: normalizedTaskId,
      verdict,
    });

    results.push(Object.freeze({
      evidence_packet: evidencePacket,
      event,
      explainability: explainabilityRecord,
      reviewer_id: effectiveReviewer.id,
      reviewer_role: effectiveReviewer.role,
      stage,
      verdict,
    }));
    events.push(event);
    explainability.push(explainabilityRecord);
    finalVerdict = verdict;
    finalEvidencePacket = evidencePacket;

    if (verdict.verdict_class === "NEEDS_ESCALATION" || verdict.verdict_class === "ENV_BLOCK") {
      break;
    }
  }

  if (!finalVerdict || !finalEvidencePacket) {
    throw new AdversarialReviewError("adversarial review did not produce a final verdict");
  }

  const summary = createReviewSummary({
    finalVerdict,
    now,
    policyRefs: ["policy/activation_review/v1"],
    resultCount: results.length,
    runId: normalizedRunId,
    taskId: normalizedTaskId,
  });

  return Object.freeze({
    allowed: finalVerdict.verdict_class === "PASS",
    blocker: createBlockerFromVerdict({
      now,
      reviewPlan: normalizedReviewPlan,
      taskId: normalizedTaskId,
      verdict: finalVerdict,
    }),
    events: Object.freeze(events),
    explainability: Object.freeze([...explainability, summary]),
    final_evidence_packet: finalEvidencePacket,
    final_verdict: finalVerdict,
    results: Object.freeze(results),
    review_plan: normalizedReviewPlan,
    subject,
    subject_kind: normalizedSubjectKind,
    summary,
  });
}

export {
  AdversarialReviewError,
  createAdversarialReviewer,
  runAdversarialReview,
};
