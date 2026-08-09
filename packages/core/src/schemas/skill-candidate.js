import {
  arrayOf,
  defineSchema,
  enumField,
  exportSchema,
  integer,
  number,
  objectShape,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";
import {
  INSTINCT_DOMAINS,
  INSTINCT_PROMOTION_REVIEW_LEVELS,
  INSTINCT_SCOPES,
  INSTINCT_SECURITY_REVIEW_DECISIONS,
  INSTINCT_SECURITY_RISK_LEVELS,
} from "./instinct.js";

const SKILL_CANDIDATE_STATUSES = ["candidate", "archived"];
const SKILL_CANDIDATE_PROVENANCE_SOURCE_TYPES = ["instinct_cluster"];

const skillCandidateSchema = defineSchema({
  name: "skill_candidate",
  entity: "skill_candidate",
  description: "Reviewed clustering artifact that groups related instincts into a reusable skill candidate without auto-activation.",
  fields: {
    id: string({ minLength: 1 }),
    title: string({ minLength: 1 }),
    summary: string({ minLength: 1 }),
    scope: enumField(INSTINCT_SCOPES),
    project_id: string({ nullable: true, default: null }),
    domains: arrayOf(enumField(INSTINCT_DOMAINS), { default: [] }),
    evidence: objectShape({
      instinct_count: integer({ min: 2 }),
      total_observation_count: integer({ min: 0 }),
      last_observed: string({ isoTimestamp: true }),
      project_ids: arrayOf(string({ minLength: 1 }), { default: [] }),
    }),
    clustering: objectShape({
      shared_trigger_tokens: arrayOf(string({ minLength: 1 }), { default: [] }),
      shared_context_signals: arrayOf(string({ minLength: 1 }), { default: [] }),
      similarity_score: number({ min: 0 }),
    }),
    provenance: objectShape({
      source_type: enumField(SKILL_CANDIDATE_PROVENANCE_SOURCE_TYPES),
      source_ref: string({ minLength: 1 }),
      source_summary: string({ nullable: true, default: null }),
      evidence_refs: arrayOf(string({ minLength: 1 }), { default: [] }),
    }),
    promotion_review: objectShape({
      reviewer_id: string({ minLength: 1 }),
      reviewed_at: string({ isoTimestamp: true }),
      rationale: string({ minLength: 1 }),
      review_level: enumField(INSTINCT_PROMOTION_REVIEW_LEVELS, { default: "standard" }),
    }),
    security_review: objectShape({
      decision: enumField(INSTINCT_SECURITY_REVIEW_DECISIONS),
      rationale: string({ minLength: 1 }),
      reviewed_at: string({ isoTimestamp: true }),
      reviewer_id: string({ minLength: 1 }),
      risk_level: enumField(INSTINCT_SECURITY_RISK_LEVELS),
      trigger_refs: arrayOf(string({ minLength: 1 }), { default: [] }),
    }, { nullable: true, default: null }),
    status: enumField(SKILL_CANDIDATE_STATUSES),
    created_at: string({ isoTimestamp: true }),
    updated_at: string({ isoTimestamp: true }),
  },
});

function parseSkillCandidate(input) {
  return parseSchema(skillCandidateSchema, input);
}

function validateSkillCandidate(input) {
  return validateSchema(skillCandidateSchema, input);
}

function exportSkillCandidateSchema() {
  return exportSchema(skillCandidateSchema);
}

export {
  SKILL_CANDIDATE_PROVENANCE_SOURCE_TYPES,
  SKILL_CANDIDATE_STATUSES,
  exportSkillCandidateSchema,
  parseSkillCandidate,
  skillCandidateSchema,
  validateSkillCandidate,
};
