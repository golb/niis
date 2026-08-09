import {
  arrayOf,
  defineSchema,
  enumField,
  exportSchema,
  integer,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const TASK_CONTENT_REVISION_SOURCES = ["ui", "runtime", "agent"];
const TASK_CONTENT_EDITOR_TYPES = ["operator", "runtime", "agent", "system"];

const taskContentRevisionSchema = defineSchema({
  name: "task_content_revision",
  entity: "task_content_revision",
  description: "Append-only revision snapshot for editable task content and metadata.",
  fields: {
    id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    created_at: string({ isoTimestamp: true }),
    source: enumField(TASK_CONTENT_REVISION_SOURCES),
    editor_id: string({ minLength: 1 }),
    editor_type: enumField(TASK_CONTENT_EDITOR_TYPES),
    changed_fields: arrayOf(string({ minLength: 1 }), { default: [] }),
    title: string({ minLength: 1 }),
    phase: integer({ min: 0 }),
    priority: string({ minLength: 1 }),
    operator_brief_markdown: string({ nullable: true, default: null }),
    details_markdown: string({ nullable: true, default: null }),
    acceptance_markdown: string({ nullable: true, default: null }),
  },
});

function parseTaskContentRevision(input) {
  return parseSchema(taskContentRevisionSchema, input);
}

function validateTaskContentRevision(input) {
  return validateSchema(taskContentRevisionSchema, input);
}

function exportTaskContentRevisionSchema() {
  return exportSchema(taskContentRevisionSchema);
}

export {
  TASK_CONTENT_EDITOR_TYPES,
  TASK_CONTENT_REVISION_SOURCES,
  exportTaskContentRevisionSchema,
  parseTaskContentRevision,
  taskContentRevisionSchema,
  validateTaskContentRevision,
};
