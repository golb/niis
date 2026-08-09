import {
  arrayOf,
  defineSchema,
  enumField,
  exportSchema,
  integer,
  parseSchema,
  validateSchema,
} from "./shared.js";







const CONTEXT_SOURCES = [
  "task_spec",
  "role_persona",
  "routing_rationale",
  "authority",
  "target_paths",
  "operator_guidance",
  "acceptance_checks",
  "doc_refs",
  "prior_attempt",
  "quality_bar",
  "quality_gates",
];

const contextContractSchema = defineSchema({
  name: "context_contract",
  entity: "context_contract",
  description: "Canonical per-role context contract: deny-by-default allow-list of execution prompt context sources.",
  fields: {
    version: integer({ default: 1, min: 1 }),
    allow: arrayOf(enumField(CONTEXT_SOURCES), { default: [] }),
  },
});

function parseContextContract(input) {
  return parseSchema(contextContractSchema, input);
}

function validateContextContract(input) {
  return validateSchema(contextContractSchema, input);
}

function exportContextContractSchema() {
  return exportSchema(contextContractSchema);
}

export {
  CONTEXT_SOURCES,
  contextContractSchema,
  exportContextContractSchema,
  parseContextContract,
  validateContextContract,
};
