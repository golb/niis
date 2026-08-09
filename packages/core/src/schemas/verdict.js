import {
  defineSchema,
  enumField,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const VERDICT_CLASSES = [
  "PASS",
  "DEFECT",
  "EVIDENCE_GAP",
  "ENV_BLOCK",
  "NEEDS_ESCALATION",
  "PARTIAL_PROGRESS",
];
const FAILURE_ATTRIBUTIONS = [
  "none",
  "task_local",
  "pre_existing_product",
];

const verdictSchema = defineSchema({
  name: "review_verdict",
  entity: "review_verdict",
  description: "Canonical review and validator verdict for task completion decisions.",
  fields: {
    id: string({ minLength: 1 }),
    run_id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    verdict_class: enumField(VERDICT_CLASSES),
    reviewer_id: string({ minLength: 1 }),
    evidence_packet_id: string({ minLength: 1 }),
    failure_attribution: enumField(FAILURE_ATTRIBUTIONS, { default: "none" }),
    reason: string({ minLength: 1 }),
    next_action: string({ minLength: 1 }),
    created_at: string({ isoTimestamp: true }),
  },
});

function parseReviewVerdict(input) {
  return parseSchema(verdictSchema, input);
}

function validateReviewVerdict(input) {
  return validateSchema(verdictSchema, input);
}

function exportVerdictSchema() {
  return exportSchema(verdictSchema);
}

export {
  FAILURE_ATTRIBUTIONS,
  VERDICT_CLASSES,
  exportVerdictSchema,
  parseReviewVerdict,
  validateReviewVerdict,
  verdictSchema,
};
