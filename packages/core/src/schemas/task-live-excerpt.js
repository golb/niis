import {
  anyObject,
  defineSchema,
  enumField,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const TASK_LIVE_EXCERPT_CHANNELS = ["summary", "event", "stdout", "stderr", "artifact", "validator"];
const TASK_LIVE_EXCERPT_LEVELS = ["info", "success", "warning", "error"];

const taskLiveExcerptSchema = defineSchema({
  name: "task_live_excerpt",
  entity: "task_live_excerpt",
  description: "Curated persisted live excerpt safe to show in the task card by default.",
  fields: {
    id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    run_id: string({ minLength: 1, nullable: true, default: null }),
    ts: string({ isoTimestamp: true }),
    channel: enumField(TASK_LIVE_EXCERPT_CHANNELS),
    level: enumField(TASK_LIVE_EXCERPT_LEVELS),
    source: string({ minLength: 1 }),
    content: string({ minLength: 1 }),
    metadata: anyObject({ default: {} }),
  },
});

function parseTaskLiveExcerpt(input) {
  return parseSchema(taskLiveExcerptSchema, input);
}

function validateTaskLiveExcerpt(input) {
  return validateSchema(taskLiveExcerptSchema, input);
}

function exportTaskLiveExcerptSchema() {
  return exportSchema(taskLiveExcerptSchema);
}

export {
  TASK_LIVE_EXCERPT_CHANNELS,
  TASK_LIVE_EXCERPT_LEVELS,
  exportTaskLiveExcerptSchema,
  parseTaskLiveExcerpt,
  taskLiveExcerptSchema,
  validateTaskLiveExcerpt,
};
