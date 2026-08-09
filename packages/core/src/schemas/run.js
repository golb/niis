import {
  defineSchema,
  enumField,
  exportSchema,
  integer,
  number,
  objectShape,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const RUN_STATUSES = ["STARTED", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "TIMED_OUT"];
const INVOCATION_SOURCES = ["timer", "assignment", "on_demand", "retry", "resume", "mention"];
const RUN_LOG_STORAGES = ["inline", "ref"];

const runSchema = defineSchema({
  name: "run_record",
  entity: "run",
  description: "Canonical run record for execution attempts and adapter output tracking.",
  fields: {
    id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    subtask_id: string({ nullable: true, default: null }),
    role_id: string({ nullable: true, default: null }),
    agent_id: string({ minLength: 1 }),
    adapter_id: string({ minLength: 1 }),
    status: enumField(RUN_STATUSES),
    started_at: string({ isoTimestamp: true }),
    finished_at: string({ isoTimestamp: true, nullable: true, default: null }),
    checkpoint_id: string({ nullable: true, default: null }),
    exit_code: integer({ nullable: true, default: null }),
    cost: objectShape({
      tokens_in: integer({ min: 0 }),
      tokens_out: integer({ min: 0 }),
      tokens_cached: integer({ default: 0, min: 0 }),
      duration_ms: integer({ min: 0 }),
      estimated_usd: number({ min: 0 }),
      model_id: string({ nullable: true, default: null }),
    }),
    invocation_source: enumField(INVOCATION_SOURCES),
    run_log: objectShape({
      storage: enumField(RUN_LOG_STORAGES),
      ref: string({ nullable: true, default: null }),
      bytes: integer({ min: 0 }),
      sha256: string({ minLength: 1 }),
    }),
    task_session_key: string({ nullable: true, default: null }),
  },
});

function parseRunRecord(input) {
  return parseSchema(runSchema, input);
}

function validateRunRecord(input) {
  return validateSchema(runSchema, input);
}

function exportRunSchema() {
  return exportSchema(runSchema);
}

export {
  INVOCATION_SOURCES,
  RUN_LOG_STORAGES,
  RUN_STATUSES,
  exportRunSchema,
  parseRunRecord,
  runSchema,
  validateRunRecord,
};
