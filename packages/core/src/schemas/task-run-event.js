import {
  anyObject,
  defineSchema,
  enumField,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const TASK_RUN_EVENT_TYPES = [
  "run_queued",
  "run_started",
  "route_selected",
  "reference_bundle_ready",
  "agent_invoked",
  "agent_status",
  "agent_note",
  "artifact_emitted",
  "validator_started",
  "validator_result",
  "approval_required",
  "approval_resolved",
  "operator_note",
  "run_completed",
  "run_failed",



  "run_log",
];
const TASK_RUN_EVENT_LEVELS = ["info", "success", "warning", "error"];
const TASK_RUN_EVENT_VISIBILITIES = ["curated", "verbose", "debug"];
const TASK_RUN_EVENT_ACTOR_TYPES = ["system", "runtime", "agent", "validator", "operator", "governance"];

const taskRunEventSchema = defineSchema({
  name: "task_run_event",
  entity: "task_run_event",
  description: "Canonical persisted live timeline event for one task execution flow.",
  fields: {
    id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    run_id: string({ minLength: 1, nullable: true, default: null }),
    ts: string({ isoTimestamp: true }),
    event_type: enumField(TASK_RUN_EVENT_TYPES),
    level: enumField(TASK_RUN_EVENT_LEVELS),
    actor_type: enumField(TASK_RUN_EVENT_ACTOR_TYPES),
    actor_id: string({ minLength: 1 }),
    visibility: enumField(TASK_RUN_EVENT_VISIBILITIES),
    payload: anyObject({ default: {} }),
  },
});

function parseTaskRunEvent(input) {
  return parseSchema(taskRunEventSchema, input);
}

function validateTaskRunEvent(input) {
  return validateSchema(taskRunEventSchema, input);
}

function exportTaskRunEventSchema() {
  return exportSchema(taskRunEventSchema);
}

export {
  TASK_RUN_EVENT_ACTOR_TYPES,
  TASK_RUN_EVENT_LEVELS,
  TASK_RUN_EVENT_TYPES,
  TASK_RUN_EVENT_VISIBILITIES,
  exportTaskRunEventSchema,
  parseTaskRunEvent,
  taskRunEventSchema,
  validateTaskRunEvent,
};
