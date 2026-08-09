import {
  anyObject,
  defineSchema,
  enumField,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const EVENT_TYPES = [
  "STATE_CHANGE",
  "CHECKPOINT",
  "ADAPTER_CALL",
  "VALIDATOR_RUN",
  "POLICY_DECISION",
  "ERROR",
  "ESCALATION",
];

const eventSchema = defineSchema({
  name: "event_log_entry",
  entity: "event_log_entry",
  description: "Canonical execution event entry for auditability and replay.",
  fields: {
    id: string({ minLength: 1 }),
    run_id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    event_type: enumField(EVENT_TYPES),
    timestamp: string({ isoTimestamp: true }),
    actor: string({ minLength: 1 }),
    payload: anyObject({ default: {} }),
  },
});

function parseEventLogEntry(input) {
  return parseSchema(eventSchema, input);
}

function validateEventLogEntry(input) {
  return validateSchema(eventSchema, input);
}

function exportEventSchema() {
  return exportSchema(eventSchema);
}

export {
  EVENT_TYPES,
  eventSchema,
  exportEventSchema,
  parseEventLogEntry,
  validateEventLogEntry,
};
