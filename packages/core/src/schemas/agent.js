import {
  anyObject,
  arrayOf,
  booleanField,
  defineSchema,
  enumField,
  exportSchema,
  number,
  integer,
  objectShape,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const AGENT_STATUSES = ["ACTIVE", "PAUSED", "TERMINATED", "ERROR"];
const PAUSE_REASONS = ["budget_exhausted", "error_threshold", "operator_manual", "policy_violation"];
const HEALTH_STATUSES = ["healthy", "degraded", "error", "unknown"];
const ENV_BINDING_TYPES = ["plain", "secret_ref"];

const agentSchema = defineSchema({
  name: "agent_entity",
  entity: "agent",
  description: "Canonical first-class runtime agent entity.",
  fields: {
    id: string({ minLength: 1 }),
    name: string({ minLength: 1 }),
    adapter_type: string({ minLength: 1 }),
    status: enumField(AGENT_STATUSES),
    pause_condition: objectShape(
      {
        reason: enumField(PAUSE_REASONS),
        cleared_at: string({ isoTimestamp: true, nullable: true, default: null }),
        auto_resume_eligible: booleanField(),
      },
      { nullable: true, default: null },
    ),
    capabilities: arrayOf(string({ minLength: 1 }), { default: [] }),
    budget_monthly: objectShape(
      {
        limit_usd: number({ min: 0 }),
        spent_usd: number({ min: 0 }),
      },
      { nullable: true, default: null },
    ),
    config: anyObject({ default: {} }),
    env_bindings: arrayOf(
      objectShape({
        key: string({ minLength: 1 }),
        type: enumField(ENV_BINDING_TYPES),
        value: string({ minLength: 1 }),
      }),
      { default: [] },
    ),
    health_status: enumField(HEALTH_STATUSES),
    last_run_id: string({ nullable: true, default: null }),
    last_run_at: string({ isoTimestamp: true, nullable: true, default: null }),
    accumulated: objectShape({
      total_tokens_in: integer({ min: 0, default: 0 }),
      total_tokens_out: integer({ min: 0, default: 0 }),
      total_cost_usd: number({ min: 0, default: 0 }),
      total_runs: integer({ min: 0, default: 0 }),
    }),
    created_at: string({ isoTimestamp: true }),
    updated_at: string({ isoTimestamp: true }),
  },
});

function parseAgentEntity(input) {
  return parseSchema(agentSchema, input);
}

function validateAgentEntity(input) {
  return validateSchema(agentSchema, input);
}

function exportAgentSchema() {
  return exportSchema(agentSchema);
}

export {
  AGENT_STATUSES,
  ENV_BINDING_TYPES,
  HEALTH_STATUSES,
  PAUSE_REASONS,
  agentSchema,
  exportAgentSchema,
  parseAgentEntity,
  validateAgentEntity,
};
