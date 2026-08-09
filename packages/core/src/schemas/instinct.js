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

const INSTINCT_DOMAINS = [
  "task_decomposition",
  "evidence_patterns",
  "policy_tuning",
  "agent_routing",
  "blocker_resolution",
  "workflow_optimization",
];

const INSTINCT_SOURCES = ["runtime_observation", "imported", "promoted"];
const INSTINCT_SCOPES = ["project", "global"];
const INSTINCT_STATUSES = ["tentative", "active", "promoted", "archived"];
const INSTINCT_PROVENANCE_SOURCE_TYPES = [
  "discovery_candidate",
  "runtime_observation",
  "manual_note",
  "instinct_import",
];
const INSTINCT_SUGGESTION_CATEGORIES = [
  "shipped_capability",
  "technical_debt",
  "speculative_idea",
];
const INSTINCT_PROMOTION_REVIEW_LEVELS = ["standard", "elevated"];
const INSTINCT_SECURITY_REVIEW_DECISIONS = ["allow", "reject"];
const INSTINCT_SECURITY_RISK_LEVELS = ["low", "medium", "high", "critical"];

const instinctSchema = defineSchema({
  name: "instinct_artifact",
  entity: "instinct_artifact",
  description: "Reserved learning artifact for reviewed observation-to-instinct promotion in later phases.",
  fields: {
    id: string({ minLength: 1 }),
    trigger: string({ minLength: 1 }),
    confidence: number({ min: 0 }),
    domain: enumField(INSTINCT_DOMAINS),
    source: enumField(INSTINCT_SOURCES),
    scope: enumField(INSTINCT_SCOPES),
    project_id: string({ nullable: true, default: null }),
    evidence: objectShape({
      observation_count: integer({ min: 0 }),
      last_observed: string({ isoTimestamp: true }),
      confirming_sessions: arrayOf(string({ minLength: 1 }), { default: [] }),
      contradicting_count: integer({ min: 0, default: 0 }),
      project_ids: arrayOf(string({ minLength: 1 }), { default: [] }),
    }),
    provenance: objectShape({
      source_type: enumField(INSTINCT_PROVENANCE_SOURCE_TYPES),
      source_ref: string({ minLength: 1 }),
      source_summary: string({ nullable: true, default: null }),
      evidence_refs: arrayOf(string({ minLength: 1 }), { default: [] }),
      suggestion_category: enumField(INSTINCT_SUGGESTION_CATEGORIES, { nullable: true, default: null }),
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
    status: enumField(INSTINCT_STATUSES),
    created_at: string({ isoTimestamp: true }),
    updated_at: string({ isoTimestamp: true }),
  },
});

function parseInstinctArtifact(input) {
  return parseSchema(instinctSchema, input);
}

function validateInstinctArtifact(input) {
  return validateSchema(instinctSchema, input);
}

function exportInstinctSchema() {
  return exportSchema(instinctSchema);
}

export {
  INSTINCT_DOMAINS,
  INSTINCT_PROVENANCE_SOURCE_TYPES,
  INSTINCT_PROMOTION_REVIEW_LEVELS,
  INSTINCT_SCOPES,
  INSTINCT_SECURITY_REVIEW_DECISIONS,
  INSTINCT_SECURITY_RISK_LEVELS,
  INSTINCT_SUGGESTION_CATEGORIES,
  INSTINCT_SOURCES,
  INSTINCT_STATUSES,
  exportInstinctSchema,
  instinctSchema,
  parseInstinctArtifact,
  validateInstinctArtifact,
};
