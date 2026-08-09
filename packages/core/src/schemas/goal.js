import {
  defineSchema,
  enumField,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const GOAL_LEVELS = ["project", "global"];
const GOAL_STATUSES = ["planned", "active", "achieved", "abandoned"];

const goalSchema = defineSchema({
  name: "goal_record",
  entity: "goal",
  description: "Canonical optional goal schema for higher-level task linkage, reporting, and cost attribution.",
  fields: {
    id: string({ minLength: 1 }),
    title: string({ minLength: 1 }),
    description: string({ minLength: 1 }),
    level: enumField(GOAL_LEVELS),
    status: enumField(GOAL_STATUSES),
    parent_goal_id: string({ nullable: true, default: null }),
    project_id: string({ nullable: true, default: null }),
    owner_agent_id: string({ nullable: true, default: null }),
    created_at: string({ isoTimestamp: true }),
    updated_at: string({ isoTimestamp: true }),
  },
});

function parseGoalRecord(input) {
  return parseSchema(goalSchema, input);
}

function validateGoalRecord(input) {
  return validateSchema(goalSchema, input);
}

function exportGoalSchema() {
  return exportSchema(goalSchema);
}

export {
  GOAL_LEVELS,
  GOAL_STATUSES,
  exportGoalSchema,
  goalSchema,
  parseGoalRecord,
  validateGoalRecord,
};
