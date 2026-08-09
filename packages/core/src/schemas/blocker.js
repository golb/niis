import {
  defineSchema,
  enumField,
  exportSchema,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const BLOCKER_CLASSES = [
  "MISSING_VERDICT",
  "MISSING_EVIDENCE",
  "MISSING_APPROVAL",
  "LOCK_CONFLICT",
  "ENV_BLOCK",
  "MAX_REJECTIONS",
  "DEPENDENCY_UNMET",
  "SECURITY_FINDING",
];

const blockerSchema = defineSchema({
  name: "blocker_artifact",
  entity: "blocker_artifact",
  description: "Canonical blocker artifact for halted or forbidden state transitions.",
  fields: {
    id: string({ minLength: 1 }),
    task_id: string({ minLength: 1 }),
    blocker_class: enumField(BLOCKER_CLASSES),
    reason: string({ minLength: 1 }),
    next_action: string({ minLength: 1 }),
    created_at: string({ isoTimestamp: true }),
    resolved_at: string({ isoTimestamp: true, nullable: true, default: null }),
  },
});

function parseBlockerArtifact(input) {
  return parseSchema(blockerSchema, input);
}

function validateBlockerArtifact(input) {
  return validateSchema(blockerSchema, input);
}

function exportBlockerSchema() {
  return exportSchema(blockerSchema);
}

export {
  BLOCKER_CLASSES,
  blockerSchema,
  exportBlockerSchema,
  parseBlockerArtifact,
  validateBlockerArtifact,
};
