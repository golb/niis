import {
  arrayOf,
  booleanField,
  defineSchema,
  enumField,
  exportSchema,
  objectShape,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const AUTHENTICITY_STATUSES = ["VERIFIED", "UNVERIFIED", "SUSPICIOUS"];

const evidenceSchema = defineSchema({
  name: "evidence_packet",
  entity: "evidence_packet",
  description: "Canonical evidence packet used as the proof artifact for review outcomes.",
  fields: {
    id: string({ minLength: 1 }),
    verdict_id: string({ minLength: 1 }),
    items: arrayOf(
      objectShape({
        type: string({ minLength: 1 }),
        source: string({ minLength: 1 }),
        content: string({ minLength: 1 }),
        raw_output_ref: string({ nullable: true, default: null }),
        subtask_id: string({ nullable: true, default: null }),
      }),
      { default: [] },
    ),
    authenticity_status: enumField(AUTHENTICITY_STATUSES),
    markers: objectShape({
      checked_urls: arrayOf(string({ minLength: 1 }), { default: [] }),
      auth_surfaces_attempted: arrayOf(string({ minLength: 1 }), { default: [] }),
      browser_live_checks: arrayOf(string({ minLength: 1 }), { default: [] }),
      runtime_evidence_succeeded: booleanField({ default: false }),
    }),
  },
});

function parseEvidencePacket(input) {
  return parseSchema(evidenceSchema, input);
}

function validateEvidencePacket(input) {
  return validateSchema(evidenceSchema, input);
}

function exportEvidenceSchema() {
  return exportSchema(evidenceSchema);
}

export {
  AUTHENTICITY_STATUSES,
  evidenceSchema,
  exportEvidenceSchema,
  parseEvidencePacket,
  validateEvidencePacket,
};
