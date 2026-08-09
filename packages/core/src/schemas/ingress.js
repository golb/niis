import {
  arrayOf,
  defineSchema,
  enumField,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const INGRESS_SOURCE_TYPES = ["backlog_file", "webhook", "api", "watch_detect", "operator_prompt"];
const INGRESS_STATUSES = ["DETECTED", "ROUTED", "QUEUED", "CLAIMED", "REJECTED"];

const ingressSchema = defineSchema({
  name: "task_ingress_record",
  entity: "task_ingress",
  description: "Canonical record for task appearance and ingress routing state.",
  fields: {
    id: string({ minLength: 1 }),
    source_type: enumField(INGRESS_SOURCE_TYPES),
    source_ref: string({ minLength: 1 }),
    detected_at: string({ isoTimestamp: true }),
    route_candidate: string({ nullable: true, default: null }),
    authority_constraints: arrayOf(string({ minLength: 1 }), { default: [] }),
    approvals_required: arrayOf(string({ minLength: 1 }), { default: [] }),
    ingress_status: enumField(INGRESS_STATUSES),
  },
});

function parseTaskIngressRecord(input) {
  return parseSchema(ingressSchema, input);
}

function validateTaskIngressRecord(input) {
  return validateSchema(ingressSchema, input);
}

function exportIngressSchema() {
  return exportSchema(ingressSchema);
}

export {
  INGRESS_SOURCE_TYPES,
  INGRESS_STATUSES,
  exportIngressSchema,
  ingressSchema,
  parseTaskIngressRecord,
  validateTaskIngressRecord,
};
