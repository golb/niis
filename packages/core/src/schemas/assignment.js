import {
  defineSchema,
  enumField,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const ASSIGNMENT_REASON_TYPES = ["auto_pickup", "manual", "escalation", "retry"];

const assignmentSchema = defineSchema({
  name: "assignment_reason",
  entity: "assignment_reason",
  description: "Canonical assignment reason for task claim and routing explainability.",
  fields: {
    id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    agent_id: string({ minLength: 1 }),
    reason_type: enumField(ASSIGNMENT_REASON_TYPES),
    policy_ref: string({ minLength: 1 }),
    assigned_at: string({ isoTimestamp: true }),
    context: string({ minLength: 1 }),
  },
});

function parseAssignmentReason(input) {
  return parseSchema(assignmentSchema, input);
}

function validateAssignmentReason(input) {
  return validateSchema(assignmentSchema, input);
}

function exportAssignmentSchema() {
  return exportSchema(assignmentSchema);
}

export {
  ASSIGNMENT_REASON_TYPES,
  assignmentSchema,
  exportAssignmentSchema,
  parseAssignmentReason,
  validateAssignmentReason,
};
