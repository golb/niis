import {
  anyObject,
  defineSchema,
  enumField,
  exportSchema,
  integer,
  parseSchema,
  string,
  validateSchema,
} from "../schemas/shared.js";
import { registerExecutionTrigger, TRIGGER_DISPOSITIONS } from "./lock.js";
import { toIsoTimestamp } from "./queue.js";

class WakeError extends Error {
  constructor(message) {
    super(message);
    this.name = "WakeError";
  }
}

const WAKEUP_SOURCES = ["timer", "assignment", "on_demand", "automation", "mention"];

const wakeRecordSchema = defineSchema({
  name: "wake_record",
  entity: "wake_record",
  description: "Canonical wake observation for autonomous pickup and coalescing traceability.",
  fields: {
    id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    source: enumField(WAKEUP_SOURCES),
    context: anyObject({ default: {} }),
    priority: integer({ nullable: true, default: null }),
    observed_at: string({ isoTimestamp: true }),
    disposition: enumField(TRIGGER_DISPOSITIONS),
  },
});

function parseWakeRecord(input) {
  return parseSchema(wakeRecordSchema, input);
}

function validateWakeRecord(input) {
  return validateSchema(wakeRecordSchema, input);
}

function exportWakeSchema() {
  return exportSchema(wakeRecordSchema);
}

function assertWakeSource(source) {
  if (!WAKEUP_SOURCES.includes(source)) {
    throw new WakeError(`unsupported wake source: ${source}`);
  }

  return source;
}

function createWakeRecord({
  taskId,
  source,
  context = {},
  priority = null,
  observedAt,
  disposition,
}) {
  const timestamp = toIsoTimestamp(observedAt, "observedAt");

  return parseWakeRecord({
    id: `${taskId}:${source}:${timestamp}`,
    task_id: taskId,
    source: assertWakeSource(source),
    context,
    priority,
    observed_at: timestamp,
    disposition,
  });
}

function registerTaskWake({
  wakeRecords = [],
  queueItems,
  deferredWakeups,
  leases,
  taskId,
  source,
  context = {},
  now = new Date(),
  priority = null,
}) {
  const wakeSource = assertWakeSource(source);
  const timestamp = toIsoTimestamp(now, "now");
  const triggerResult = registerExecutionTrigger({
    queueItems,
    deferredWakeups,
    leases,
    taskId,
    source: wakeSource,
    context,
    now: timestamp,
    priority,
  });
  const wakeRecord = createWakeRecord({
    taskId,
    source: wakeSource,
    context,
    priority,
    observedAt: timestamp,
    disposition: triggerResult.disposition,
  });

  return {
    ...triggerResult,
    wakeRecord,
    wakeRecords: [...wakeRecords.map(parseWakeRecord), wakeRecord],
  };
}

function listWakeSourcesForTask(wakeRecords, taskId) {
  return wakeRecords
    .map(parseWakeRecord)
    .filter((wakeRecord) => wakeRecord.task_id === taskId)
    .map((wakeRecord) => wakeRecord.source);
}

export {
  WAKEUP_SOURCES,
  WakeError,
  assertWakeSource,
  createWakeRecord,
  exportWakeSchema,
  listWakeSourcesForTask,
  parseWakeRecord,
  registerTaskWake,
  validateWakeRecord,
  wakeRecordSchema,
};
