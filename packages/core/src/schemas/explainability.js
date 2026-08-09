import {
  arrayOf,
  defineSchema,
  enumField,
  exportSchema,
  objectShape,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const DECISION_TYPES = ["ROUTE", "GATE", "APPROVAL", "BLOCKER", "ASSIGNMENT", "REJECTION"];

const explainabilitySchema = defineSchema({
  name: "explainability_record",
  entity: "explainability_record",
  description: "Canonical explainability record for routing, gating, approval, and blocker decisions.",
  fields: {
    id: string({ minLength: 1 }),
    decision_type: enumField(DECISION_TYPES),
    task_id: string({ minLength: 1 }),
    route_chosen: string({ minLength: 1 }),
    alternatives_considered: arrayOf(
      objectShape({
        option: string({ minLength: 1 }),
        reason_rejected: string({ minLength: 1 }),
      }),
      { default: [] },
    ),
    policy_refs: arrayOf(string({ minLength: 1 }), { default: [] }),
    evidence_refs: arrayOf(string({ minLength: 1 }), { default: [] }),
    timestamp: string({ isoTimestamp: true }),
    human_readable_summary: string({ minLength: 1 }),
  },
});

function parseExplainabilityRecord(input) {
  return parseSchema(explainabilitySchema, input);
}

function validateExplainabilityRecord(input) {
  return validateSchema(explainabilitySchema, input);
}

function exportExplainabilitySchema() {
  return exportSchema(explainabilitySchema);
}

export {
  DECISION_TYPES,
  explainabilitySchema,
  exportExplainabilitySchema,
  parseExplainabilityRecord,
  validateExplainabilityRecord,
};
