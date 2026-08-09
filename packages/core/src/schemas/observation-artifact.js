import {
  arrayOf,
  anyObject,
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
import { OBSERVATION_PATTERN_CATEGORIES } from "../policy/observations.js";

const OBSERVATION_STORAGE_TIERS = ["hot", "archive", "purged"];
const OBSERVATION_LIFECYCLE_ACTIONS = ["retain_hot", "archive", "purge"];

const observationArtifactSchema = defineSchema({
  name: "observation_artifact",
  entity: "observation_artifact",
  description: "Lifecycle-managed redacted observation artifact derived from the hook and gate pipeline.",
  fields: {
    id: string({ minLength: 1 }),
    observation: objectShape({
      category: string({ minLength: 1 }),
      confidence: number({ min: 0 }),
      payload: anyObject({ default: {} }),
      pattern_category: enumField(OBSERVATION_PATTERN_CATEGORIES, { nullable: true, default: null }),
      policy_refs: arrayOf(string({ minLength: 1 }), { default: [] }),
      source_id: string({ minLength: 1 }),
      source_kind: string({ minLength: 1 }),
      summary: string({ minLength: 1 }),
    }, { allowUnknownKeys: false }),
    storage_tier: enumField(OBSERVATION_STORAGE_TIERS),
    processed_at: string({ isoTimestamp: true, nullable: true, default: null }),
    archived_at: string({ isoTimestamp: true, nullable: true, default: null }),
    purged_at: string({ isoTimestamp: true, nullable: true, default: null }),
    lifecycle: objectShape({
      archive_after_days: integer({ min: 1 }),
      purge_after_days: integer({ min: 1 }),
      policy_id: string({ minLength: 1 }),
      retain_unprocessed: booleanField({ default: true }),
      last_action: enumField(OBSERVATION_LIFECYCLE_ACTIONS),
      last_evaluated_at: string({ isoTimestamp: true }),
    }),
    created_at: string({ isoTimestamp: true }),
    updated_at: string({ isoTimestamp: true }),
  },
});

function parseObservationArtifact(input) {
  return parseSchema(observationArtifactSchema, input);
}

function validateObservationArtifact(input) {
  return validateSchema(observationArtifactSchema, input);
}

function exportObservationArtifactSchema() {
  return exportSchema(observationArtifactSchema);
}

export {
  OBSERVATION_LIFECYCLE_ACTIONS,
  OBSERVATION_STORAGE_TIERS,
  exportObservationArtifactSchema,
  observationArtifactSchema,
  parseObservationArtifact,
  validateObservationArtifact,
};
