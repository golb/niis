import { parseEventLogEntry } from "../schemas/event.js";
import { parseEvidencePacket } from "../schemas/evidence.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";

const DEFAULT_REDACTION_POLICY = Object.freeze({
  jwt: true,
  operator_pii: true,
  secret_assignments: true,
});

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|secret|token|password|authorization)\b(\s*[:=]\s*|\s+)(["']?)([^"'\s,}]+)\3/gi;
const BEARER_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._-]+)/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }

  return value;
}

function redactString(value, policy = DEFAULT_REDACTION_POLICY) {
  let redacted = value.replaceAll(PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]");

  if (policy.jwt !== false) {
    redacted = redacted.replaceAll(JWT_PATTERN, "[REDACTED_JWT]");
  }

  if (policy.secret_assignments !== false) {
    redacted = redacted
      .replaceAll(BEARER_PATTERN, "$1[REDACTED_TOKEN]")
      .replaceAll(SECRET_ASSIGNMENT_PATTERN, (_, label, separator) =>
        `${label}${separator}[REDACTED_SECRET]`);
  }

  if (policy.operator_pii !== false) {
    redacted = redacted.replaceAll(EMAIL_PATTERN, "[REDACTED_EMAIL]");
  }

  return redacted;
}

function redactValue(value, policy = DEFAULT_REDACTION_POLICY) {
  if (typeof value === "string") {
    return redactString(value, policy);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, policy));
  }

  if (value && typeof value === "object") {
    const output = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = redactValue(nestedValue, policy);
    }

    return output;
  }

  return value;
}

function redactEventLogEntry(eventLogEntry, policy = DEFAULT_REDACTION_POLICY) {
  const normalizedEventLogEntry = ensurePlainObject(eventLogEntry, "eventLogEntry");

  return parseEventLogEntry({
    ...normalizedEventLogEntry,
    actor: redactString(normalizedEventLogEntry.actor, policy),
    payload: redactValue(normalizedEventLogEntry.payload ?? {}, policy),
  });
}

function redactExplainabilityRecord(explainabilityRecord, policy = DEFAULT_REDACTION_POLICY) {
  const normalizedExplainabilityRecord = ensurePlainObject(
    explainabilityRecord,
    "explainabilityRecord",
  );

  return parseExplainabilityRecord({
    ...normalizedExplainabilityRecord,
    alternatives_considered: (normalizedExplainabilityRecord.alternatives_considered ?? []).map(
      (entry) => ({
        ...entry,
        option: redactString(entry.option, policy),
        reason_rejected: redactString(entry.reason_rejected, policy),
      }),
    ),
    evidence_refs: (normalizedExplainabilityRecord.evidence_refs ?? []).map((value) =>
      redactString(value, policy)),
    human_readable_summary: redactString(
      normalizedExplainabilityRecord.human_readable_summary,
      policy,
    ),
    policy_refs: (normalizedExplainabilityRecord.policy_refs ?? []).map((value) =>
      redactString(value, policy)),
    route_chosen: redactString(normalizedExplainabilityRecord.route_chosen, policy),
  });
}

function redactEvidencePacket(evidencePacket, policy = DEFAULT_REDACTION_POLICY) {
  const normalizedEvidencePacket = ensurePlainObject(evidencePacket, "evidencePacket");

  return parseEvidencePacket({
    ...normalizedEvidencePacket,
    items: (normalizedEvidencePacket.items ?? []).map((item) => ({
      ...item,
      content: redactString(item.content, policy),
      raw_output_ref:
        item.raw_output_ref === null || item.raw_output_ref === undefined
          ? null
          : redactString(item.raw_output_ref, policy),
      source: redactString(item.source, policy),
      type: redactString(item.type, policy),
    })),
    markers: redactValue(normalizedEvidencePacket.markers ?? {}, policy),
  });
}

export {
  DEFAULT_REDACTION_POLICY,
  redactEventLogEntry,
  redactEvidencePacket,
  redactExplainabilityRecord,
  redactString,
  redactValue,
};
