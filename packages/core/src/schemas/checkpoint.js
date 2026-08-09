import {
  anyObject,
  booleanField,
  defineSchema,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const checkpointSchema = defineSchema({
  name: "checkpoint",
  entity: "checkpoint",
  description: "Canonical resumable checkpoint for interrupted execution state.",
  fields: {
    id: string({ minLength: 1 }),
    run_id: string({ minLength: 1 }),
    state_snapshot: anyObject(),
    context_summary: string({ minLength: 1 }),
    created_at: string({ isoTimestamp: true }),
    resumable: booleanField(),
    resume_instructions: string({ minLength: 1 }),
  },
});

function parseCheckpoint(input) {
  return parseSchema(checkpointSchema, input);
}

function validateCheckpoint(input) {
  return validateSchema(checkpointSchema, input);
}

function exportCheckpointSchema() {
  return exportSchema(checkpointSchema);
}

export {
  checkpointSchema,
  exportCheckpointSchema,
  parseCheckpoint,
  validateCheckpoint,
};
