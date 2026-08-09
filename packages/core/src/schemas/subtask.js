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

const SUBTASK_STATUSES = ["PENDING", "IN_PROGRESS", "DONE", "BLOCKED"];

const subtaskSchema = defineSchema({
  name: "subtask_record",
  entity: "subtask",
  description: "Canonical subtask record for dependency-aware execution planning.",
  fields: {
    id: string({ minLength: 1 }),
    parent_task_id: string({ minLength: 1 }),
    title: string({ minLength: 1 }),
    status: enumField(SUBTASK_STATUSES),
    depends_on: arrayOf(string({ minLength: 1 }), { default: [] }),
    assigned_agent: string({ nullable: true, default: null }),
    role_id: string({ nullable: true, default: null }),
    reference_bundle_id: string({ nullable: true, default: null }),
    created_at: string({ isoTimestamp: true }),
  },
});

function parseSubtaskRecord(input) {
  return parseSchema(subtaskSchema, input);
}

function validateSubtaskRecord(input) {
  return validateSchema(subtaskSchema, input);
}

function exportSubtaskSchema() {
  return exportSchema(subtaskSchema);
}

export {
  SUBTASK_STATUSES,
  exportSubtaskSchema,
  parseSubtaskRecord,
  subtaskSchema,
  validateSubtaskRecord,
};
