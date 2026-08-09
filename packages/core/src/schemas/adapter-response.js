import {
  arrayOf,
  booleanField,
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

const ADAPTER_RESPONSE_STATUSES = ["SUCCESS", "WARNING", "ERROR", "TIMEOUT"];
const SELF_ASSESSMENT_STATUSES = ["PASS", "FAIL", "UNCERTAIN"];
const ERROR_CATEGORIES = ["transient", "permanent", "env_block", "resource_limit", "auth"];

const adapterResponseSchema = defineSchema({
  name: "adapter_response",
  entity: "adapter_response",
  description: "Canonical normalized adapter result for execution, continuation, and recovery.",
  fields: {
    status: enumField(ADAPTER_RESPONSE_STATUSES),
    summary: string({ minLength: 1 }),
    next_actions: arrayOf(string({ minLength: 1 }), { default: [] }),
    artifacts: arrayOf(
      objectShape({
        path: string({ minLength: 1 }),
        type: string({ minLength: 1 }),
      }),
      { default: [] },
    ),
    cost: objectShape(
      {
        input_tokens: integer({ min: 0 }),
        output_tokens: integer({ min: 0 }),
        cached_input_tokens: integer({ default: 0, min: 0 }),
        estimated_usd: number({ min: 0 }),
        model_id: string({ nullable: true, default: null }),
      },
      { nullable: true, default: null },
    ),
    completion_signal: booleanField({ nullable: true, default: null }),
    self_assessment: arrayOf(
      objectShape({
        criterion: string({ minLength: 1 }),
        status: enumField(SELF_ASSESSMENT_STATUSES),
        note: string({ nullable: true, default: null }),
      }),
      { nullable: true, default: null },
    ),
    error: objectShape(
      {
        root_cause: string({ minLength: 1 }),
        category: enumField(ERROR_CATEGORIES),
        retry_safe: booleanField(),
        retry_instruction: string({ nullable: true, default: null }),
        stop_condition: string({ minLength: 1 }),
        escalation_hint: string({ nullable: true, default: null }),
      },
      { nullable: true, default: null },
    ),
  },
});

function parseAdapterResponse(input) {
  return parseSchema(adapterResponseSchema, input);
}

function validateAdapterResponse(input) {
  return validateSchema(adapterResponseSchema, input);
}

function exportAdapterResponseSchema() {
  return exportSchema(adapterResponseSchema);
}

export {
  ADAPTER_RESPONSE_STATUSES,
  ERROR_CATEGORIES,
  SELF_ASSESSMENT_STATUSES,
  adapterResponseSchema,
  exportAdapterResponseSchema,
  parseAdapterResponse,
  validateAdapterResponse,
};
