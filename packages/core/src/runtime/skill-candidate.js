import { toIsoTimestamp } from "../scheduler/queue.js";
import {
  INSTINCT_PROMOTION_REVIEW_LEVELS,
  INSTINCT_SCOPES,
  INSTINCT_SECURITY_REVIEW_DECISIONS,
  INSTINCT_SECURITY_RISK_LEVELS,
  parseInstinctArtifact,
} from "../schemas/instinct.js";
import {
  SKILL_CANDIDATE_STATUSES,
  parseSkillCandidate,
} from "../schemas/skill-candidate.js";

class SkillCandidateError extends Error {
  constructor(message) {
    super(message);
    this.name = "SkillCandidateError";
  }
}

const MIN_INSTINCTS_FOR_SKILL_CANDIDATE = 2;
const HIGH_RISK_SECURITY_LEVELS = ["high", "critical"];
const CLUSTER_STOPWORDS = new Set([
  "about",
  "after",
  "before",
  "candidate",
  "context",
  "could",
  "discovery",
  "during",
  "evidence",
  "explicit",
  "instinct",
  "into",
  "memory",
  "operator",
  "pattern",
  "policy",
  "project",
  "promote",
  "promotion",
  "review",
  "reviewed",
  "scope",
  "should",
  "signal",
  "skill",
  "source",
  "summary",
  "task",
  "through",
  "trigger",
]);

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SkillCandidateError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillCandidateError(`${label} must be a plain object`);
  }

  return value;
}

function ensureEnumValue(value, allowedValues, label) {
  if (!allowedValues.includes(value)) {
    throw new SkillCandidateError(`${label} must be one of: ${allowedValues.join(", ")}`);
  }

  return value;
}

function ensureStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new SkillCandidateError(`${label} must be an array`);
  }

  return Object.freeze(values.map((value, index) =>
    ensureNonEmptyString(value, `${label}[${index}]`)));
}

function normalizeReview(review = {}, now = new Date()) {
  const normalizedReview = ensurePlainObject(review, "review");

  return Object.freeze({
    decision: ensureEnumValue(
      normalizedReview.decision ?? "approve",
      ["approve", "reject"],
      "review.decision",
    ),
    rationale: ensureNonEmptyString(
      normalizedReview.rationale ?? normalizedReview.reason ?? normalizedReview.summary,
      "review.rationale",
    ),
    review_level: ensureEnumValue(
      normalizedReview.reviewLevel ?? normalizedReview.review_level ?? "standard",
      INSTINCT_PROMOTION_REVIEW_LEVELS,
      "review.review_level",
    ),
    reviewed_at: toIsoTimestamp(
      normalizedReview.reviewedAt ?? normalizedReview.reviewed_at ?? now,
      "review.reviewed_at",
    ),
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

function tokenizeText(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }

  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 4 && !CLUSTER_STOPWORDS.has(token)),
  )];
}

function collectInstinctTokens(instinct) {
  return new Set([
    ...tokenizeText(instinct.trigger),
    ...tokenizeText(instinct.provenance.source_summary ?? ""),
    ...tokenizeText(instinct.provenance.source_ref),
  ]);
}

function deriveSharedTriggerTokens(instincts) {
  const tokenCounts = new Map();

  for (const instinct of instincts) {
    for (const token of collectInstinctTokens(instinct)) {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }

  return Object.freeze(
    [...tokenCounts.entries()]
      .filter(([, count]) => count >= MIN_INSTINCTS_FOR_SKILL_CANDIDATE)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([token]) => token),
  );
}

function deriveSharedContextSignals({
  domain,
  projectId,
  scope,
  sourceTypes,
}) {
  const signals = [`scope:${scope}`, `domain:${domain}`];

  if (projectId !== null) {
    signals.push(`project:${projectId}`);
  }

  if (sourceTypes.length === 1) {
    signals.push(`provenance:${sourceTypes[0]}`);
  }

  return Object.freeze(signals);
}

function evaluateInstinctCluster({
  instincts,
  projectId = null,
  scope = null,
}) {
  if (!Array.isArray(instincts)) {
    throw new SkillCandidateError("instincts must be an array");
  }

  const normalizedInstincts = Object.freeze(instincts.map((instinct) => parseInstinctArtifact(instinct)));

  if (normalizedInstincts.length < MIN_INSTINCTS_FOR_SKILL_CANDIDATE) {
    return Object.freeze({
      domain: null,
      normalized_instincts: normalizedInstincts,
      ok: false,
      project_id: null,
      reason: `skill clustering requires at least ${MIN_INSTINCTS_FOR_SKILL_CANDIDATE} instincts.`,
      scope: null,
      shared_context_signals: Object.freeze([]),
      shared_trigger_tokens: Object.freeze([]),
      similarity_score: 0,
    });
  }

  const domains = [...new Set(normalizedInstincts.map((instinct) => instinct.domain))];
  const scopes = [...new Set(normalizedInstincts.map((instinct) => instinct.scope))];
  const projectIds = [...new Set(
    normalizedInstincts
      .map((instinct) => instinct.project_id)
      .filter((value) => value !== null),
  )];

  if (domains.length !== 1) {
    return Object.freeze({
      domain: null,
      normalized_instincts: normalizedInstincts,
      ok: false,
      project_id: null,
      reason: "skill clustering currently requires instincts to share one domain.",
      scope: null,
      shared_context_signals: Object.freeze([]),
      shared_trigger_tokens: Object.freeze([]),
      similarity_score: 0,
    });
  }

  if (scopes.length !== 1) {
    return Object.freeze({
      domain: domains[0],
      normalized_instincts: normalizedInstincts,
      ok: false,
      project_id: null,
      reason: "skill clustering currently requires instincts to share one scope.",
      scope: null,
      shared_context_signals: Object.freeze([]),
      shared_trigger_tokens: Object.freeze([]),
      similarity_score: 0,
    });
  }

  const derivedScope = scopes[0];

  if (scope !== null && scope !== undefined && ensureEnumValue(scope, INSTINCT_SCOPES, "scope") !== derivedScope) {
    return Object.freeze({
      domain: domains[0],
      normalized_instincts: normalizedInstincts,
      ok: false,
      project_id: null,
      reason: `requested scope ${scope} does not match clustered instinct scope ${derivedScope}.`,
      scope: derivedScope,
      shared_context_signals: Object.freeze([]),
      shared_trigger_tokens: Object.freeze([]),
      similarity_score: 0,
    });
  }

  if (derivedScope === "project" && projectIds.length !== 1) {
    return Object.freeze({
      domain: domains[0],
      normalized_instincts: normalizedInstincts,
      ok: false,
      project_id: null,
      reason: "project-scoped skill clustering requires instincts from one project.",
      scope: derivedScope,
      shared_context_signals: Object.freeze([]),
      shared_trigger_tokens: Object.freeze([]),
      similarity_score: 0,
    });
  }

  const derivedProjectId = derivedScope === "project" ? projectIds[0] ?? null : null;

  if (projectId !== null && projectId !== undefined && derivedProjectId !== null && projectId !== derivedProjectId) {
    return Object.freeze({
      domain: domains[0],
      normalized_instincts: normalizedInstincts,
      ok: false,
      project_id: derivedProjectId,
      reason: `requested projectId ${projectId} does not match clustered instinct project ${derivedProjectId}.`,
      scope: derivedScope,
      shared_context_signals: Object.freeze([]),
      shared_trigger_tokens: Object.freeze([]),
      similarity_score: 0,
    });
  }

  const sharedTriggerTokens = deriveSharedTriggerTokens(normalizedInstincts);

  if (sharedTriggerTokens.length === 0) {
    return Object.freeze({
      domain: domains[0],
      normalized_instincts: normalizedInstincts,
      ok: false,
      project_id: derivedProjectId,
      reason: "skill clustering requires at least one shared trigger/context token across the instincts.",
      scope: derivedScope,
      shared_context_signals: Object.freeze([]),
      shared_trigger_tokens: sharedTriggerTokens,
      similarity_score: 0,
    });
  }

  const sourceTypes = [...new Set(normalizedInstincts.map((instinct) => instinct.provenance.source_type))];
  const sharedContextSignals = deriveSharedContextSignals({
    domain: domains[0],
    projectId: derivedProjectId,
    scope: derivedScope,
    sourceTypes,
  });
  const similarityScore = Number((
    0.4
    + Math.min(sharedTriggerTokens.length, 3) * 0.15
    + (sourceTypes.length === 1 ? 0.1 : 0)
    + (derivedProjectId !== null ? 0.05 : 0)
  ).toFixed(2));

  return Object.freeze({
    domain: domains[0],
    normalized_instincts: normalizedInstincts,
    ok: true,
    project_id: derivedProjectId,
    reason: null,
    scope: derivedScope,
    shared_context_signals: sharedContextSignals,
    shared_trigger_tokens: sharedTriggerTokens,
    similarity_score: similarityScore,
  });
}

function deriveSecurityRiskLevel(instincts) {
  if (instincts.some((instinct) => instinct.security_review?.risk_level === "critical")) {
    return "critical";
  }

  if (instincts.some((instinct) => instinct.security_review?.risk_level === "high")) {
    return "high";
  }

  return "medium";
}

function evaluateSkillCandidateSecurity({
  instincts,
  securityReview = null,
}) {
  const suspiciousInstincts = instincts.filter((instinct) =>
    HIGH_RISK_SECURITY_LEVELS.includes(instinct.security_review?.risk_level ?? "")
    || instinct.provenance.suggestion_category === "technical_debt");
  const triggerRefs = Object.freeze([...new Set(suspiciousInstincts.flatMap((instinct) =>
    instinct.security_review?.trigger_refs?.length
      ? instinct.security_review.trigger_refs
      : [instinct.id],
  ))]);
  const reasons = Object.freeze(suspiciousInstincts.map((instinct) =>
    `${instinct.id}:${instinct.provenance.suggestion_category ?? instinct.security_review?.risk_level ?? "review"}`));
  const suspicious = suspiciousInstincts.length > 0;
  const riskLevel = suspicious ? deriveSecurityRiskLevel(suspiciousInstincts) : null;

  if (!suspicious) {
    return Object.freeze({
      ok: true,
      reason: null,
      reasons,
      requires_security_review: false,
      reviewed: securityReview !== null,
      risk_level: riskLevel,
      security_review: securityReview,
      status: "clear",
      suspicious,
      trigger_refs: triggerRefs,
    });
  }

  if (securityReview === null) {
    return Object.freeze({
      ok: false,
      reason: "suspicious instinct clusters require explicit security review before becoming skill candidates.",
      reasons,
      requires_security_review: true,
      reviewed: false,
      risk_level: riskLevel,
      security_review: null,
      status: "requires_review",
      suspicious,
      trigger_refs: triggerRefs,
    });
  }

  if (securityReview.decision === "reject") {
    return Object.freeze({
      ok: false,
      reason: securityReview.rationale,
      reasons,
      requires_security_review: true,
      reviewed: true,
      risk_level: riskLevel,
      security_review: securityReview,
      status: "rejected",
      suspicious,
      trigger_refs: triggerRefs,
    });
  }

  return Object.freeze({
    ok: true,
    reason: null,
    reasons,
    requires_security_review: true,
    reviewed: true,
    risk_level: riskLevel,
    security_review: securityReview,
    status: "allowed_with_review",
    suspicious,
    trigger_refs: triggerRefs,
  });
}

function deriveSkillCandidateId({
  domain,
  projectId,
  scope,
  sharedTriggerTokens,
}) {
  const identity = [
    "skill-candidate",
    domain,
    ...sharedTriggerTokens.slice(0, 3),
    scope,
    projectId ?? "global",
  ]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return identity || "skill-candidate";
}

function deriveLastObserved(instincts) {
  return instincts
    .map((instinct) => instinct.evidence.last_observed)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function clusterInstinctsToSkillCandidate({
  instincts,
  now = new Date(),
  projectId = null,
  review = {},
  scope = null,
  securityReview = null,
  skillCandidateId = null,
  status = "candidate",
  summary = null,
  title = null,
} = {}) {
  const normalizedReview = normalizeReview(review, now);
  const normalizedSecurityReview = normalizeSecurityReview(securityReview, now);
  const clusterEvaluation = evaluateInstinctCluster({
    instincts,
    projectId,
    scope,
  });
  const normalizedStatus = ensureEnumValue(status, SKILL_CANDIDATE_STATUSES, "status");
  const securityEvaluation = evaluateSkillCandidateSecurity({
    instincts: clusterEvaluation.normalized_instincts,
    securityReview: normalizedSecurityReview,
  });

  if (normalizedReview.decision === "reject" || !clusterEvaluation.ok || !securityEvaluation.ok) {
    return Object.freeze({
      approved: false,
      cluster_evaluation: clusterEvaluation,
      reason_rejected:
        normalizedReview.decision === "reject"
          ? normalizedReview.rationale
          : clusterEvaluation.ok
            ? securityEvaluation.reason
            : clusterEvaluation.reason,
      review_record: normalizedReview,
      security_evaluation: securityEvaluation,
      skill_candidate: null,
      source_instincts: clusterEvaluation.normalized_instincts,
    });
  }

  const totalObservationCount = clusterEvaluation.normalized_instincts.reduce(
    (sum, instinct) => sum + instinct.evidence.observation_count,
    0,
  );
  const observedProjectIds = [...new Set(
    clusterEvaluation.normalized_instincts.flatMap((instinct) =>
      instinct.evidence.project_ids.length > 0
        ? instinct.evidence.project_ids
        : instinct.project_id === null
          ? []
          : [instinct.project_id],
    ),
  )];
  const resolvedTitle =
    title === null || title === undefined
      ? `${clusterEvaluation.domain.replace(/_/g, " ")} skill candidate: ${clusterEvaluation.shared_trigger_tokens.slice(0, 3).join(", ")}`
      : ensureNonEmptyString(title, "title");
  const resolvedSummary =
    summary === null || summary === undefined
      ? `Clustered ${clusterEvaluation.normalized_instincts.length} related instincts by shared trigger/context signals (${clusterEvaluation.shared_trigger_tokens.slice(0, 3).join(", ")}).`
      : ensureNonEmptyString(summary, "summary");
  const skillCandidate = parseSkillCandidate({
    id:
      skillCandidateId === null || skillCandidateId === undefined
        ? deriveSkillCandidateId({
          domain: clusterEvaluation.domain,
          projectId: clusterEvaluation.project_id,
          scope: clusterEvaluation.scope,
          sharedTriggerTokens: clusterEvaluation.shared_trigger_tokens,
        })
        : ensureNonEmptyString(skillCandidateId, "skillCandidateId"),
    title: resolvedTitle,
    summary: resolvedSummary,
    scope: clusterEvaluation.scope,
    project_id: clusterEvaluation.project_id,
    domains: [clusterEvaluation.domain],
    evidence: {
      instinct_count: clusterEvaluation.normalized_instincts.length,
      total_observation_count: totalObservationCount,
      last_observed: deriveLastObserved(clusterEvaluation.normalized_instincts),
      project_ids: observedProjectIds,
    },
    clustering: {
      shared_trigger_tokens: clusterEvaluation.shared_trigger_tokens,
      shared_context_signals: clusterEvaluation.shared_context_signals,
      similarity_score: clusterEvaluation.similarity_score,
    },
    provenance: {
      source_type: "instinct_cluster",
      source_ref: `instinct-cluster:${clusterEvaluation.normalized_instincts.map((instinct) => instinct.id).sort().join(",")}`,
      source_summary: `Reviewed cluster over ${clusterEvaluation.normalized_instincts.length} instincts.`,
      evidence_refs: clusterEvaluation.normalized_instincts.map((instinct) => instinct.id),
    },
    promotion_review: {
      reviewer_id: normalizedReview.reviewer_id,
      reviewed_at: normalizedReview.reviewed_at,
      rationale: normalizedReview.rationale,
      review_level: normalizedReview.review_level,
    },
    security_review:
      securityEvaluation.reviewed && securityEvaluation.security_review
        ? {
          decision: securityEvaluation.security_review.decision,
          rationale: securityEvaluation.security_review.rationale,
          reviewed_at: securityEvaluation.security_review.reviewed_at,
          reviewer_id: securityEvaluation.security_review.reviewer_id,
          risk_level: ensureEnumValue(
            securityEvaluation.risk_level ?? "medium",
            INSTINCT_SECURITY_RISK_LEVELS,
            "securityEvaluation.risk_level",
          ),
          trigger_refs: securityEvaluation.trigger_refs,
        }
        : null,
    status: normalizedStatus,
    created_at: normalizedReview.reviewed_at,
    updated_at: normalizedReview.reviewed_at,
  });

  return Object.freeze({
    approved: true,
    cluster_evaluation: clusterEvaluation,
    reason_rejected: null,
    review_record: normalizedReview,
    security_evaluation: securityEvaluation,
    skill_candidate: skillCandidate,
    source_instincts: clusterEvaluation.normalized_instincts,
  });
}

export {
  MIN_INSTINCTS_FOR_SKILL_CANDIDATE,
  SkillCandidateError,
  clusterInstinctsToSkillCandidate,
  evaluateInstinctCluster,
};
