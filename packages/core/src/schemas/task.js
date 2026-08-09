import {
  SchemaValidationError,
  anyObject,
  arrayOf,
  booleanField,
  defineSchema,
  enumField,
  exportSchema,
  integer,
  objectShape,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";
import {
  AcceptanceCommandPlanError,
  normalizeAcceptanceCommandPlan,
} from "../contracts/acceptance-command-plan.js";





const TASK_STATUSES = ["UNPLANNED", "PLANNING", "PENDING", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "REJECTED"];
const TASK_PRIORITIES = ["blocker", "critical", "high", "medium", "low"];




const TASK_KINDS = ["work", "continuous_collection", "agent_tick"];
const TASK_ID_MAX_LENGTH = 128;




const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID_WINDOWS_RESERVED_PATTERN = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)$/;

class TaskIdValidationError extends Error {
  constructor(label, value) {
    super(
      `${label} must be a canonical lower-case ASCII task id `
      + `(1-${TASK_ID_MAX_LENGTH} characters; letters, digits, and single hyphens; `
      + "reserved device names are not allowed)",
    );
    this.name = "TaskIdValidationError";
    this.code = "invalid_task_id";
    this.label = label;
    this.value = value;
  }
}

function assertCanonicalTaskId(value, label = "taskId") {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > TASK_ID_MAX_LENGTH
    || !TASK_ID_PATTERN.test(value)
    || TASK_ID_WINDOWS_RESERVED_PATTERN.test(value)
  ) {
    throw new TaskIdValidationError(label, value);
  }

  return value;
}

const taskSchema = defineSchema({
  name: "task_record",
  entity: "task",
  description: "Canonical task record for the Niis kernel state model.",
  fields: {
    id: string({ minLength: 1 }),
    title: string({ minLength: 1 }),
    details_markdown: string({ nullable: true, default: null }),
    acceptance_markdown: string({ nullable: true, default: null }),
    acceptance_commands: arrayOf(
      objectShape({
        argv: arrayOf(string({ minLength: 1 })),
        id: string({ minLength: 1 }),
        required: booleanField(),
      }),
      { default: [] },
    ),
    operator_brief_markdown: string({ nullable: true, default: null }),
    status: enumField(TASK_STATUSES),
    phase: integer({ min: 0 }),
    priority: enumField(TASK_PRIORITIES),
    task_kind: enumField(TASK_KINDS, { default: "work" }),
    source_kind: string({ nullable: true, default: null }),
    source_id: string({ nullable: true, default: null }),
    parent_task_id: string({ nullable: true, default: null }),
    goal_id: string({ nullable: true, default: null }),
    depends_on: arrayOf(string({ minLength: 1 }), { default: [] }),
    assigned_to: string({ nullable: true, default: null }),
    collection_spec: anyObject({ nullable: true, default: null }),
    schedule: anyObject({ nullable: true, default: null }),
    runtime_state_ref: string({ nullable: true, default: null }),
    tool_call: anyObject({ nullable: true, default: null }),
    out_of_scope: arrayOf(string({ minLength: 1 }), { default: [] }),
    rejection_count: integer({ min: 0, default: 0 }),
    max_rejections: integer({ min: 0, default: 5 }),
    created_at: string({ isoTimestamp: true }),
    updated_at: string({ isoTimestamp: true }),
    transition_log: arrayOf(
      objectShape({
        timestamp: string({ isoTimestamp: true }),
        from_status: enumField(TASK_STATUSES, { nullable: true, default: null }),
        to_status: enumField(TASK_STATUSES),
        actor: string({ minLength: 1 }),
        reason: string({ minLength: 1 }),
      }),
      { default: [] },
    ),
  },
});

function parseTaskRecord(input) {
  const parsed = parseSchema(taskSchema, input);
  try {
    return {
      ...parsed,
      id: assertCanonicalTaskId(parsed.id, "id"),
      parent_task_id: parsed.parent_task_id === null
        ? null
        : assertCanonicalTaskId(parsed.parent_task_id, "parent_task_id"),
      depends_on: parsed.depends_on.map((taskId, index) =>
        assertCanonicalTaskId(taskId, `depends_on[${index}]`)),
      acceptance_commands: normalizeAcceptanceCommandPlan(parsed.acceptance_commands),
    };
  } catch (error) {
    if (
      error instanceof AcceptanceCommandPlanError
      || error instanceof TaskIdValidationError
    ) {
      throw new SchemaValidationError(taskSchema.name, [error.message]);
    }
    throw error;
  }
}

function validateTaskRecord(input) {
  const structural = validateSchema(taskSchema, input);
  if (!structural.ok) {
    return structural;
  }

  try {
    return {
      ok: true,
      errors: [],
      value: parseTaskRecord(input),
    };
  } catch (error) {
    if (Array.isArray(error?.errors)) {
      return {
        ok: false,
        errors: error.errors,
        value: null,
      };
    }
    throw error;
  }
}

function exportTaskSchema() {
  return exportSchema(taskSchema);
}

export {
  TASK_ID_MAX_LENGTH,
  TASK_ID_PATTERN,
  TASK_ID_WINDOWS_RESERVED_PATTERN,
  TASK_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskIdValidationError,
  exportTaskSchema,
  assertCanonicalTaskId,
  parseTaskRecord,
  taskSchema,
  validateTaskRecord,
};
