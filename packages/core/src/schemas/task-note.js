import {
  arrayOf,
  defineSchema,
  enumField,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const TASK_NOTE_AUTHOR_TYPES = ["operator", "agent", "system"];

const taskNoteSchema = defineSchema({
  name: "task_note",
  entity: "task_note",
  description: "Canonical task-note schema for task-level communication and mention-driven coordination.",
  fields: {
    id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    author_type: enumField(TASK_NOTE_AUTHOR_TYPES),
    author_id: string({ minLength: 1 }),
    content: string({ minLength: 1 }),
    mentions: arrayOf(string({ minLength: 1 }), { default: [] }),
    created_at: string({ isoTimestamp: true }),
  },
});

function parseTaskNote(input) {
  return parseSchema(taskNoteSchema, input);
}

function validateTaskNote(input) {
  return validateSchema(taskNoteSchema, input);
}

function exportTaskNoteSchema() {
  return exportSchema(taskNoteSchema);
}

export {
  TASK_NOTE_AUTHOR_TYPES,
  exportTaskNoteSchema,
  parseTaskNote,
  taskNoteSchema,
  validateTaskNote,
};
