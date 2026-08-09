import {
  anyObject,
  defineSchema,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const taskSessionSchema = defineSchema({
  name: "task_session",
  entity: "task_session",
  description: "Per-task per-agent per-adapter session linkage for resumable execution.",
  fields: {
    task_key: string({ minLength: 1 }),
    agent_id: string({ minLength: 1 }),
    adapter_type: string({ minLength: 1 }),
    session_params: anyObject({ default: {} }),
    last_run_id: string({ nullable: true, default: null }),
    display_id: string({ nullable: true, default: null }),
    created_at: string({ isoTimestamp: true }),
    updated_at: string({ isoTimestamp: true }),
  },
});

function parseTaskSession(input) {
  return parseSchema(taskSessionSchema, input);
}

function validateTaskSession(input) {
  return validateSchema(taskSessionSchema, input);
}

function exportTaskSessionSchema() {
  return exportSchema(taskSessionSchema);
}

export {
  exportTaskSessionSchema,
  parseTaskSession,
  taskSessionSchema,
  validateTaskSession,
};
