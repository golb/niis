import {
  defineSchema,
  enumField,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const TASK_RUN_SESSION_STATUSES = [
  "queued",
  "preparing",
  "routing",
  "executing",
  "awaiting_approval",
  "reviewing",
  "completed",
  "failed",
  "blocked",
];

const taskRunSessionSchema = defineSchema({
  name: "task_run_session",
  entity: "task_run_session",
  description: "Canonical persisted live execution session for one task run.",
  fields: {
    id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    run_id: string({ minLength: 1, nullable: true, default: null }),
    adapter_id: string({ minLength: 1, nullable: true, default: null }),
    lane_id: string({ minLength: 1, nullable: true, default: null }),
    runtime_family: string({ minLength: 1, nullable: true, default: null }),
    status: enumField(TASK_RUN_SESSION_STATUSES),
    active_phase: string({ minLength: 1 }),
    summary: string({ minLength: 1, nullable: true, default: null }),
    started_at: string({ isoTimestamp: true }),
    updated_at: string({ isoTimestamp: true }),
    finished_at: string({ isoTimestamp: true, nullable: true, default: null }),
  },
});

function parseTaskRunSession(input) {
  return parseSchema(taskRunSessionSchema, input);
}

function validateTaskRunSession(input) {
  return validateSchema(taskRunSessionSchema, input);
}

function exportTaskRunSessionSchema() {
  return exportSchema(taskRunSessionSchema);
}

export {
  TASK_RUN_SESSION_STATUSES,
  exportTaskRunSessionSchema,
  parseTaskRunSession,
  taskRunSessionSchema,
  validateTaskRunSession,
};
