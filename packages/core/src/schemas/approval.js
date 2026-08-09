import {
  arrayOf,
  defineSchema,
  enumField,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const APPROVAL_OWNER_ROLES = ["worker", "reviewer", "validator", "operator", "system"];
const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED"];

const approvalSchema = defineSchema({
  name: "approval_record",
  entity: "approval_record",
  description: "Canonical approval record for operator-governed risky or gated actions.",
  fields: {
    id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    action_id: string({ minLength: 1 }),
    requested_by: enumField(APPROVAL_OWNER_ROLES),
    owner_role: enumField(APPROVAL_OWNER_ROLES),
    risk_level: string({ minLength: 1 }),
    reason: string({ minLength: 1 }),
    created_at: string({ isoTimestamp: true }),
    status: enumField(APPROVAL_STATUSES),
    approved_at: string({ isoTimestamp: true, nullable: true, default: null }),
    notes: arrayOf(string({ minLength: 1 }), { default: [] }),
  },
});

function parseApprovalRecord(input) {
  return parseSchema(approvalSchema, input);
}

function validateApprovalRecord(input) {
  return validateSchema(approvalSchema, input);
}

function exportApprovalSchema() {
  return exportSchema(approvalSchema);
}

export {
  APPROVAL_OWNER_ROLES,
  APPROVAL_STATUSES,
  approvalSchema,
  exportApprovalSchema,
  parseApprovalRecord,
  validateApprovalRecord,
};
