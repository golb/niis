import { createDiscoveryCandidate } from "../contracts/packages.js";
import { calculateInstinctConfidence } from "./instinct-confidence.js";
import { createPolicyObservation } from "../policy/observations.js";
import {
  INSTINCT_DOMAINS,
  INSTINCT_PROMOTION_REVIEW_LEVELS,
  INSTINCT_SCOPES,
  INSTINCT_SECURITY_REVIEW_DECISIONS,
  INSTINCT_SECURITY_RISK_LEVELS,
  INSTINCT_SOURCES,
  INSTINCT_STATUSES,
  parseInstinctArtifact,
} from "../schemas/instinct.js";
import { toIsoTimestamp } from "../scheduler/queue.js";

class InstinctPromotionError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstinctPromotionError";
  }
}

const INSTINCT_REVIEW_DECISIONS = ["approve", "reject"];
const GLOBAL_PROMOTION_MIN_PROJECTS = 2;
const MIN_OBSERVATION_COUNT_FOR_INSTINCT_PROMOTION = 2;
const HIGH_RISK_SECURITY_SEVERITIES = ["high", "critical"];
const BLOCKED_OBSERVATION_SOURCE_KINDS = [
  "instinct_promotion",
  "learning_observer",
  "learning_observation",
];
const DEFAULT_OBSERVATION_CATEGORY_DOMAIN_MAP = Object.freeze({
  blocker_resolution: "blocker_resolution",
  evidence_pattern: "evidence_patterns",
  operator_override: "policy_tuning",
  policy_guardrail: "policy_tuning",
  routing_preference: "agent_routing",
  task_decomposition: "task_decomposition",
  workflow_pattern: "workflow_optimization",
});

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InstinctPromotionError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InstinctPromotionError(`${label} must be a plain object`);
  }

  return value;
}

function ensureEnumValue(value, allowedValues, label) {
  if (!allowedValues.includes(value)) {
    throw new InstinctPromotionError(`${label} must be one of: ${allowedValues.join(", ")}`);
  }

  return value;
}

function ensureNumber(value, label) {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new InstinctPromotionError(`${label} must be a non-negative number`);
  }

  return value;
}

function ensureInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new InstinctPromotionError(`${label} must be a non-negative integer`);
  }

  return value;
}

function ensureStringArray(value, label) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new InstinctPromotionError(`${label} must be an array`);
  }

  return Object.freeze(value.map((entry, index) => ensureNonEmptyString(entry, `${label}[${index}]`)));
}

function deriveInstinctId(candidate, domain, scope, projectId) {
  const identity = [
    "instinct",
    candidate.package_id ?? candidate.display_name ?? candidate.candidate_id,
    domain,
    scope,
    projectId ?? "global",
  ]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return identity || "instinct-artifact";
}

function normalizeEvidence(evidence = {}, reviewedAt) {
  const normalizedEvidence = ensurePlainObject(evidence, "evidence");

  return Object.freeze({
    confirming_sessions: ensureStringArray(
      normalizedEvidence.confirmingSessions ?? normalizedEvidence.confirming_sessions ?? [],
      "evidence.confirming_sessions",
    ),
    contradicting_count: ensureInteger(
      normalizedEvidence.contradictingCount ?? normalizedEvidence.contradicting_count ?? 0,
      "evidence.contradicting_count",
    ),
    last_observed: toIsoTimestamp(
      normalizedEvidence.lastObserved ?? normalizedEvidence.last_observed ?? reviewedAt,
      "evidence.last_observed",
    ),
    observation_count: ensureInteger(
      normalizedEvidence.observationCount ?? normalizedEvidence.observation_count ?? 1,
      "evidence.observation_count",
    ),
    project_ids: ensureStringArray(
      normalizedEvidence.projectIds ?? normalizedEvidence.project_ids ?? [],
      "evidence.project_ids",
    ),
  });
}

function normalizeReview(review = {}, now = new Date()) {
  const normalizedReview = ensurePlainObject(review, "review");
  const decision = ensureEnumValue(
    normalizedReview.decision ?? "approve",
    INSTINCT_REVIEW_DECISIONS,
    "review.decision",
  );
  const reviewedAt = toIsoTimestamp(
    normalizedReview.reviewedAt ?? normalizedReview.reviewed_at ?? now,
    "review.reviewed_at",
  );

  return Object.freeze({
    decision,
    rationale: ensureNonEmptyString(
      normalizedReview.rationale ?? normalizedReview.reason ?? normalizedReview.summary,
      "review.rationale",
    ),
    review_level: ensureEnumValue(
      normalizedReview.reviewLevel ?? normalizedReview.review_level ?? "standard",
      INSTINCT_PROMOTION_REVIEW_LEVELS,
      "review.review_level",
    ),
    reviewed_at: reviewedAt,
    reviewer_id: ensureNonEmptyString(
      normalizedReview.reviewerId ?? normalizedReview.reviewer_id,
      "review.reviewer_id",
    ),
  });
}

function normalizeSecurityReview(securityReview = {}, now = new Date()) {
  if (securityReview === undefined || securityReview === null) {
    return null;
  }

  const normalizedSecurityReview = ensurePlainObject(securityReview, "securityReview");

  return Object.freeze({
    decision: ensureEnumValue(
      normalizedSecurityReview.decision,
      INSTINCT_SECURITY_REVIEW_DECISIONS,
      "securityReview.decision",
    ),
    rationale: ensureNonEmptyString(
      normalizedSecurityReview.rationale ?? normalizedSecurityReview.reason,
      "securityReview.rationale",
    ),
    reviewed_at: toIsoTimestamp(
      normalizedSecurityReview.reviewedAt ?? normalizedSecurityReview.reviewed_at ?? now,
      "securityReview.reviewed_at",
    ),
    reviewer_id: ensureNonEmptyString(
      normalizedSecurityReview.reviewerId ?? normalizedSecurityReview.reviewer_id,
      "securityReview.reviewer_id",
    ),
  });
}

function normalizeObservation(observation = {}) {
  const normalizedObservation = ensurePlainObject(observation, "observation");

  return createPolicyObservation({
    category: normalizedObservation.category ?? "policy_signal",
    confidence: typeof normalizedObservation.confidence === "number"
      ? normalizedObservation.confidence
      : 0,
    patternCategory:
      normalizedObservation.patternCategory ?? normalizedObservation.pattern_category ?? null,
    payload: normalizedObservation.payload ?? {},
    policyRefs: normalizedObservation.policy_refs ?? normalizedObservation.policyRefs ?? [],
    sourceId: normalizedObservation.source_id ?? normalizedObservation.sourceId,
    sourceKind: normalizedObservation.source_kind ?? normalizedObservation.sourceKind,
    summary: normalizedObservation.summary,
  });
}

function deriveDomainFromObservation(observation, explicitDomain = null) {
  if (explicitDomain !== null && explicitDomain !== undefined) {
    return ensureEnumValue(explicitDomain, INSTINCT_DOMAINS, "domain");
  }

  return DEFAULT_OBSERVATION_CATEGORY_DOMAIN_MAP[observation.pattern_category] ?? "workflow_optimization";
}

function evaluatePromotionThresholds({
  evidence,
  projectId,
  review,
  scope,
}) {
  const uniqueProjectIds = [...new Set(
    [
      ...evidence.project_ids,
      ...(projectId ? [projectId] : []),
    ],
  )];

  if (scope === "global") {
    const hasEnoughProjects = uniqueProjectIds.length >= GLOBAL_PROMOTION_MIN_PROJECTS;
    const hasElevatedReview = review.review_level === "elevated";
    const reasons = [];

    if (!hasEnoughProjects) {
      reasons.push(
        `global promotion requires multi-project proof from at least ${GLOBAL_PROMOTION_MIN_PROJECTS} projects`,
      );
    }

    if (!hasElevatedReview) {
      reasons.push("global promotion requires elevated review");
    }

    return Object.freeze({
      observed_project_ids: Object.freeze(uniqueProjectIds),
      ok: hasEnoughProjects && hasElevatedReview,
      reason:
        reasons.length === 0
          ? null
          : `${reasons.join(" and ")}.`,
      required_review_level: "elevated",
      scope,
    });
  }

  return Object.freeze({
    observed_project_ids: Object.freeze(uniqueProjectIds),
    ok: projectId !== null,
    reason:
      projectId !== null
        ? null
        : "project-scoped promotion requires a project id.",
    required_review_level: "standard",
    scope,
  });
}

function evaluateObservationIngress({
  evidence,
  explicitDomain = null,
  observation,
}) {
  const normalizedObservation = normalizeObservation(observation);
  const derivedDomain = deriveDomainFromObservation(normalizedObservation, explicitDomain);

  if (BLOCKED_OBSERVATION_SOURCE_KINDS.includes(normalizedObservation.source_kind)) {
    return Object.freeze({
      derived_domain: derivedDomain,
      normalized_observation: normalizedObservation,
      ok: false,
      reason:
        `observation ingress rejected self-referential source kind ${normalizedObservation.source_kind}.`,
    });
  }

  if (evidence.observation_count < MIN_OBSERVATION_COUNT_FOR_INSTINCT_PROMOTION) {
    return Object.freeze({
      derived_domain: derivedDomain,
      normalized_observation: normalizedObservation,
      ok: false,
      reason:
        `single observations remain observations; instinct promotion requires observation_count >= ${MIN_OBSERVATION_COUNT_FOR_INSTINCT_PROMOTION}.`,
    });
  }

  return Object.freeze({
    derived_domain: derivedDomain,
    normalized_observation: normalizedObservation,
    ok: true,
    reason: null,
  });
}

function deriveRiskLevelFromFindings(findings = []) {
  if (findings.some((finding) => finding.severity === "critical")) {
    return "critical";
  }

  if (findings.some((finding) => finding.severity === "high")) {
    return "high";
  }

  return "medium";
}

function createSecurityEvaluation({
  reasons = [],
  riskLevel = null,
  securityReview = null,
  suspicious = false,
}) {
  const normalizedRiskLevel = riskLevel === null
    ? null
    : ensureEnumValue(riskLevel, INSTINCT_SECURITY_RISK_LEVELS, "securityEvaluation.riskLevel");
  const normalizedReasons = Object.freeze(reasons);

  if (!suspicious) {
    return Object.freeze({
      ok: true,
      reason: null,
      reasons: normalizedReasons,
      requires_security_review: false,
      risk_level: normalizedRiskLevel,
      reviewed: securityReview !== null,
      security_review: securityReview,
      status: "clear",
      suspicious,
      trigger_refs: Object.freeze([]),
    });
  }

  if (securityReview === null) {
    return Object.freeze({
      ok: false,
      reason: "suspicious learned candidate requires explicit security review before promotion.",
      reasons: normalizedReasons,
      requires_security_review: true,
      risk_level: normalizedRiskLevel,
      reviewed: false,
      security_review: null,
      status: "requires_review",
      suspicious,
      trigger_refs: Object.freeze([]),
    });
  }

  if (securityReview.decision === "reject") {
    return Object.freeze({
      ok: false,
      reason: securityReview.rationale,
      reasons: normalizedReasons,
      requires_security_review: true,
      risk_level: normalizedRiskLevel,
      reviewed: true,
      security_review: securityReview,
      status: "rejected",
      suspicious,
      trigger_refs: Object.freeze([]),
    });
  }

  return Object.freeze({
    ok: true,
    reason: null,
    reasons: normalizedReasons,
    requires_security_review: true,
    risk_level: normalizedRiskLevel,
    reviewed: true,
    security_review: securityReview,
    status: "allowed_with_review",
    suspicious,
    trigger_refs: Object.freeze([]),
  });
}

function evaluateCandidateSecurity({
  candidate,
  securityReview = null,
}) {
  const suspiciousFindings = candidate.security_findings.filter((finding) =>
    Boolean(finding.blocking) || HIGH_RISK_SECURITY_SEVERITIES.includes(finding.severity));
  const reasons = suspiciousFindings.map((finding) =>
    `${finding.severity}:${finding.rule_id}:${finding.summary}`);
  const evaluation = createSecurityEvaluation({
    reasons,
    riskLevel: suspiciousFindings.length > 0 ? deriveRiskLevelFromFindings(suspiciousFindings) : null,
    securityReview,
    suspicious: suspiciousFindings.length > 0,
  });

  return Object.freeze({
    ...evaluation,
    trigger_refs: Object.freeze(suspiciousFindings.map((finding) => finding.rule_id)),
  });
}

function evaluateObservationSecurity({
  observation,
  securityReview = null,
}) {
  const blockingFindings = Number.isInteger(observation.payload?.blocking_findings)
    ? observation.payload.blocking_findings
    : 0;
  const suspicious =
    (observation.source_kind === "security_scan_finding"
      && (observation.payload?.blocking === true
        || HIGH_RISK_SECURITY_SEVERITIES.includes(observation.payload?.severity ?? "")))
    || (observation.category === "security_scan_summary" && blockingFindings > 0);
  const reasons = suspicious
    ? [observation.summary]
    : [];
  const riskLevel =
    observation.payload?.severity && HIGH_RISK_SECURITY_SEVERITIES.includes(observation.payload.severity)
      ? observation.payload.severity
      : blockingFindings > 0 || observation.payload?.blocking === true
        ? "high"
        : null;
  const evaluation = createSecurityEvaluation({
    reasons,
    riskLevel,
    securityReview,
    suspicious,
  });

  return Object.freeze({
    ...evaluation,
    trigger_refs: Object.freeze(suspicious ? [observation.source_id] : []),
  });
}

function normalizeProvenance({
  candidate,
  provenance = {},
}) {
  const normalizedProvenance = provenance === null ? {} : ensurePlainObject(provenance, "provenance");

  return Object.freeze({
    evidence_refs: ensureStringArray(
      normalizedProvenance.evidenceRefs
      ?? normalizedProvenance.evidence_refs
      ?? [candidate.candidate_id],
      "provenance.evidence_refs",
    ),
    source_ref: ensureNonEmptyString(
      normalizedProvenance.sourceRef
      ?? normalizedProvenance.source_ref
      ?? candidate.source_ref,
      "provenance.source_ref",
    ),
    source_summary:
      normalizedProvenance.sourceSummary
      ?? normalizedProvenance.source_summary
      ?? `${candidate.display_name} (${candidate.suggestion_category})`,
    source_type: ensureEnumValue(
      normalizedProvenance.sourceType
      ?? normalizedProvenance.source_type
      ?? "discovery_candidate",
      ["discovery_candidate", "runtime_observation", "manual_note", "instinct_import"],
      "provenance.source_type",
    ),
    suggestion_category:
      normalizedProvenance.suggestionCategory
      ?? normalizedProvenance.suggestion_category
      ?? candidate.suggestion_category
      ?? null,
  });
}

function promoteDiscoveryCandidateToInstinct({
  candidate,
  confidence,
  confidencePolicy = {},
  domain,
  evidence = {},
  instinctId = null,
  now = new Date(),
  projectId = null,
  provenance = {},
  review = {},
  securityReview = null,
  scope = "project",
  source = "promoted",
  status = "tentative",
  trigger = null,
} = {}) {
  const normalizedCandidate = createDiscoveryCandidate(candidate);
  const normalizedScope = ensureEnumValue(scope, INSTINCT_SCOPES, "scope");
  const normalizedSource = ensureEnumValue(source, INSTINCT_SOURCES, "source");
  const normalizedStatus = ensureEnumValue(status, INSTINCT_STATUSES, "status");
  const normalizedDomain = ensureEnumValue(domain, INSTINCT_DOMAINS, "domain");
  const normalizedProjectId =
    projectId === undefined || projectId === null ? null : ensureNonEmptyString(projectId, "projectId");

  if (normalizedScope === "project" && normalizedProjectId === null) {
    throw new InstinctPromotionError("projectId is required when scope is project");
  }

  const normalizedReview = normalizeReview(review, now);
  const normalizedSecurityReview = normalizeSecurityReview(securityReview, now);
  const normalizedEvidence = normalizeEvidence(evidence, normalizedReview.reviewed_at);
  const normalizedProvenance = normalizeProvenance({
    candidate: normalizedCandidate,
    provenance,
  });
  const confidenceEvaluation = calculateInstinctConfidence({
    confidencePolicy,
    evidence: normalizedEvidence,
    reviewedAt: normalizedReview.reviewed_at,
  });
  const thresholdEvaluation = evaluatePromotionThresholds({
    evidence: normalizedEvidence,
    projectId: normalizedProjectId,
    review: normalizedReview,
    scope: normalizedScope,
  });
  const securityEvaluation = evaluateCandidateSecurity({
    candidate: normalizedCandidate,
    securityReview: normalizedSecurityReview,
  });
  const resolvedConfidence =
    confidence === undefined || confidence === null
      ? confidenceEvaluation.final_confidence
      : ensureNumber(confidence, "confidence");

  if (normalizedReview.decision === "reject" || !thresholdEvaluation.ok || !securityEvaluation.ok) {
    return Object.freeze({
      approved: false,
      confidence_evaluation: confidenceEvaluation,
      instinct_artifact: null,
      reason_rejected:
        normalizedReview.decision === "reject"
          ? normalizedReview.rationale
          : thresholdEvaluation.ok
            ? securityEvaluation.reason
            : thresholdEvaluation.reason,
      review_record: normalizedReview,
      security_evaluation: securityEvaluation,
      source_candidate: normalizedCandidate,
      threshold_evaluation: thresholdEvaluation,
    });
  }

  const instinctArtifact = parseInstinctArtifact({
    confidence: resolvedConfidence,
    created_at: normalizedReview.reviewed_at,
    domain: normalizedDomain,
    evidence: normalizedEvidence,
    id:
      instinctId === null || instinctId === undefined
        ? deriveInstinctId(
          normalizedCandidate,
          normalizedDomain,
          normalizedScope,
          normalizedProjectId,
        )
        : ensureNonEmptyString(instinctId, "instinctId"),
    project_id: normalizedScope === "project" ? normalizedProjectId : null,
    promotion_review: {
      rationale: normalizedReview.rationale,
      review_level: normalizedReview.review_level,
      reviewed_at: normalizedReview.reviewed_at,
      reviewer_id: normalizedReview.reviewer_id,
    },
    security_review:
      securityEvaluation.reviewed && securityEvaluation.security_review
        ? {
          decision: securityEvaluation.security_review.decision,
          rationale: securityEvaluation.security_review.rationale,
          reviewed_at: securityEvaluation.security_review.reviewed_at,
          reviewer_id: securityEvaluation.security_review.reviewer_id,
          risk_level: securityEvaluation.risk_level,
          trigger_refs: securityEvaluation.trigger_refs,
        }
        : null,
    provenance: normalizedProvenance,
    scope: normalizedScope,
    source: normalizedSource,
    status: normalizedStatus,
    trigger:
      trigger === null || trigger === undefined
        ? `Promote discovery candidate ${normalizedCandidate.candidate_id} into reviewed durable memory.`
        : ensureNonEmptyString(trigger, "trigger"),
    updated_at: normalizedReview.reviewed_at,
  });

  return Object.freeze({
    approved: true,
    confidence_evaluation: confidenceEvaluation,
    instinct_artifact: instinctArtifact,
    reason_rejected: null,
    review_record: normalizedReview,
    security_evaluation: securityEvaluation,
    source_candidate: normalizedCandidate,
    threshold_evaluation: thresholdEvaluation,
  });
}

function promoteObservationToInstinct({
  confidence,
  confidencePolicy = {},
  domain = null,
  evidence = {},
  instinctId = null,
  now = new Date(),
  observation,
  projectId = null,
  review = {},
  securityReview = null,
  scope = "project",
  status = "tentative",
  trigger = null,
} = {}) {
  const normalizedScope = ensureEnumValue(scope, INSTINCT_SCOPES, "scope");
  const normalizedStatus = ensureEnumValue(status, INSTINCT_STATUSES, "status");
  const normalizedProjectId =
    projectId === undefined || projectId === null ? null : ensureNonEmptyString(projectId, "projectId");

  if (normalizedScope === "project" && normalizedProjectId === null) {
    throw new InstinctPromotionError("projectId is required when scope is project");
  }

  const normalizedReview = normalizeReview(review, now);
  const normalizedSecurityReview = normalizeSecurityReview(securityReview, now);
  const normalizedEvidence = normalizeEvidence(evidence, normalizedReview.reviewed_at);
  const ingressEvaluation = evaluateObservationIngress({
    evidence: normalizedEvidence,
    explicitDomain: domain,
    observation,
  });
  const normalizedObservation = ingressEvaluation.normalized_observation;
  const normalizedDomain = ensureEnumValue(ingressEvaluation.derived_domain, INSTINCT_DOMAINS, "domain");
  const normalizedProvenance = Object.freeze({
    evidence_refs: [normalizedObservation.source_id],
    source_ref: normalizedObservation.source_id,
    source_summary: normalizedObservation.summary,
    source_type: "runtime_observation",
    suggestion_category: null,
  });
  const confidenceEvaluation = calculateInstinctConfidence({
    confidencePolicy,
    evidence: normalizedEvidence,
    reviewedAt: normalizedReview.reviewed_at,
  });
  const thresholdEvaluation = evaluatePromotionThresholds({
    evidence: normalizedEvidence,
    projectId: normalizedProjectId,
    review: normalizedReview,
    scope: normalizedScope,
  });
  const securityEvaluation = evaluateObservationSecurity({
    observation: normalizedObservation,
    securityReview: normalizedSecurityReview,
  });
  const resolvedConfidence =
    confidence === undefined || confidence === null
      ? confidenceEvaluation.final_confidence
      : ensureNumber(confidence, "confidence");

  if (
    normalizedReview.decision === "reject"
    || !ingressEvaluation.ok
    || !thresholdEvaluation.ok
    || !securityEvaluation.ok
  ) {
    return Object.freeze({
      approved: false,
      confidence_evaluation: confidenceEvaluation,
      ingress_evaluation: ingressEvaluation,
      instinct_artifact: null,
      reason_rejected:
        normalizedReview.decision === "reject"
          ? normalizedReview.rationale
          : ingressEvaluation.ok
            ? thresholdEvaluation.ok
              ? securityEvaluation.reason
              : thresholdEvaluation.reason
            : ingressEvaluation.reason,
      review_record: normalizedReview,
      security_evaluation: securityEvaluation,
      source_observation: normalizedObservation,
      threshold_evaluation: thresholdEvaluation,
    });
  }

  const instinctArtifact = parseInstinctArtifact({
    confidence: resolvedConfidence,
    created_at: normalizedReview.reviewed_at,
    domain: normalizedDomain,
    evidence: normalizedEvidence,
    id:
      instinctId === null || instinctId === undefined
        ? deriveInstinctId(
          {
            candidate_id: normalizedObservation.source_id,
            display_name: normalizedObservation.category,
            package_id: null,
          },
          normalizedDomain,
          normalizedScope,
          normalizedProjectId,
        )
        : ensureNonEmptyString(instinctId, "instinctId"),
    project_id: normalizedScope === "project" ? normalizedProjectId : null,
    promotion_review: {
      rationale: normalizedReview.rationale,
      review_level: normalizedReview.review_level,
      reviewed_at: normalizedReview.reviewed_at,
      reviewer_id: normalizedReview.reviewer_id,
    },
    security_review:
      securityEvaluation.reviewed && securityEvaluation.security_review
        ? {
          decision: securityEvaluation.security_review.decision,
          rationale: securityEvaluation.security_review.rationale,
          reviewed_at: securityEvaluation.security_review.reviewed_at,
          reviewer_id: securityEvaluation.security_review.reviewer_id,
          risk_level: securityEvaluation.risk_level,
          trigger_refs: securityEvaluation.trigger_refs,
        }
        : null,
    provenance: normalizedProvenance,
    scope: normalizedScope,
    source: "runtime_observation",
    status: normalizedStatus,
    trigger:
      trigger === null || trigger === undefined
        ? `Promote observation ${normalizedObservation.source_id} into reviewed durable memory.`
        : ensureNonEmptyString(trigger, "trigger"),
    updated_at: normalizedReview.reviewed_at,
  });

  return Object.freeze({
    approved: true,
    confidence_evaluation: confidenceEvaluation,
    ingress_evaluation: ingressEvaluation,
    instinct_artifact: instinctArtifact,
    reason_rejected: null,
    review_record: normalizedReview,
    security_evaluation: securityEvaluation,
    source_observation: normalizedObservation,
    threshold_evaluation: thresholdEvaluation,
  });
}

export {
  GLOBAL_PROMOTION_MIN_PROJECTS,
  INSTINCT_REVIEW_DECISIONS,
  InstinctPromotionError,
  MIN_OBSERVATION_COUNT_FOR_INSTINCT_PROMOTION,
  promoteDiscoveryCandidateToInstinct,
  promoteObservationToInstinct,
};
