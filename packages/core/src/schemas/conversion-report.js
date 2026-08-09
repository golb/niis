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

const CONVERSION_STATUSES = ["SUCCESS", "PARTIAL", "FAILED"];
const CONVERSION_REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED"];
const SECURITY_FINDING_SEVERITIES = ["low", "medium", "high", "critical"];

const conversionReportSchema = defineSchema({
  name: "conversion_report",
  entity: "conversion_report",
  description: "Canonical reviewed conversion report for imported external packs.",
  fields: {
    id: string({ minLength: 1 }),
    source_pack: objectShape({
      origin: string({ minLength: 1 }),
      format: string({ minLength: 1 }),
      path: string({ minLength: 1 }),
    }),
    target_package_id: string({ minLength: 1 }),
    conversion_status: enumField(CONVERSION_STATUSES),
    warnings: arrayOf(string({ minLength: 1 }), { default: [] }),
    incompatibilities: arrayOf(string({ minLength: 1 }), { default: [] }),
    security_findings: arrayOf(
      objectShape({
        severity: enumField(SECURITY_FINDING_SEVERITIES),
        rule_id: string({ minLength: 1 }),
        summary: string({ minLength: 1 }),
        blocking: booleanField(),
        remediation_hint: string({ nullable: true, default: null }),
        auto_fixable: booleanField({ default: false }),
      }),
      { default: [] },
    ),
    review_status: enumField(CONVERSION_REVIEW_STATUSES),
    converted_at: string({ isoTimestamp: true }),
  },
});

function parseConversionReport(input) {
  return parseSchema(conversionReportSchema, input);
}

function validateConversionReport(input) {
  return validateSchema(conversionReportSchema, input);
}

function exportConversionReportSchema() {
  return exportSchema(conversionReportSchema);
}

export {
  CONVERSION_REVIEW_STATUSES,
  CONVERSION_STATUSES,
  SECURITY_FINDING_SEVERITIES,
  conversionReportSchema,
  exportConversionReportSchema,
  parseConversionReport,
  validateConversionReport,
};
