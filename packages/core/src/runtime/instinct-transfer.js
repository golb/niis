import { toIsoTimestamp } from "../scheduler/queue.js";
import {
  INSTINCT_PROMOTION_REVIEW_LEVELS,
  parseInstinctArtifact,
} from "../schemas/instinct.js";

class InstinctTransferError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstinctTransferError";
  }
}

const INSTINCT_TRANSFER_REVIEW_DECISIONS = ["approve", "reject"];
const INSTINCT_TRANSFER_BUNDLE_KIND = "instinct_bundle";
const INSTINCT_TRANSFER_MERGE_POLICY = "keep_local_provenance_raise_confidence";

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InstinctTransferError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InstinctTransferError(`${label} must be a plain object`);
  }

  return value;
}

function ensureEnumValue(value, allowedValues, label) {
  if (!allowedValues.includes(value)) {
    throw new InstinctTransferError(`${label} must be one of: ${allowedValues.join(", ")}`);
  }

  return value;
}

function ensureStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new InstinctTransferError(`${label} must be an array`);
  }

  return dedupeStrings(values.map((value, index) =>
    ensureNonEmptyString(value, `${label}[${index}]`)));
}

function dedupeStrings(values = []) {
  return Object.freeze([...new Set(values.filter(Boolean))]);
}

function slugify(value) {
  return ensureNonEmptyString(value, "value")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeReview(review = {}, now = new Date()) {
  const normalizedReview = ensurePlainObject(review, "review");

  return Object.freeze({
    decision: ensureEnumValue(
      normalizedReview.decision ?? "approve",
      INSTINCT_TRANSFER_REVIEW_DECISIONS,
      "review.decision",
    ),
    rationale: ensureNonEmptyString(
      normalizedReview.rationale ?? normalizedReview.reason ?? normalizedReview.summary,
      "review.rationale",
    ),
    review_level: ensureEnumValue(
      normalizedReview.reviewLevel ?? normalizedReview.review_level ?? "standard",
      INSTINCT_PROMOTION_REVIEW_LEVELS,
      "review.review_level",
    ),
    reviewed_at: toIsoTimestamp(
      normalizedReview.reviewedAt ?? normalizedReview.reviewed_at ?? now,
      "review.reviewed_at",
    ),
    reviewer_id: ensureNonEmptyString(
      normalizedReview.reviewerId ?? normalizedReview.reviewer_id,
      "review.reviewer_id",
    ),
  });
}

function deriveInstinctDedupKey(instinct) {
  const normalizedInstinct = parseInstinctArtifact(instinct);
  const projectIdentity =
    normalizedInstinct.scope === "project"
      ? normalizedInstinct.project_id ?? "project-missing"
      : "global";

  return [
    normalizedInstinct.domain,
    normalizedInstinct.scope,
    projectIdentity,
    slugify(normalizedInstinct.trigger),
  ].join(":");
}

function mergeEvidence(existingEvidence, incomingEvidence) {
  return Object.freeze({
    confirming_sessions: dedupeStrings([
      ...existingEvidence.confirming_sessions,
      ...incomingEvidence.confirming_sessions,
    ]),
    contradicting_count:
      existingEvidence.contradicting_count + incomingEvidence.contradicting_count,
    last_observed:
      Date.parse(existingEvidence.last_observed) >= Date.parse(incomingEvidence.last_observed)
        ? existingEvidence.last_observed
        : incomingEvidence.last_observed,
    observation_count:
      existingEvidence.observation_count + incomingEvidence.observation_count,
    project_ids: dedupeStrings([
      ...existingEvidence.project_ids,
      ...incomingEvidence.project_ids,
    ]),
  });
}

function summarizeInstincts(instincts) {
  const normalizedInstincts = instincts.map((instinct) => parseInstinctArtifact(instinct));

  return Object.freeze({
    domains: dedupeStrings(normalizedInstincts.map((instinct) => instinct.domain)),
    highest_confidence: normalizedInstincts.reduce(
      (highest, instinct) => Math.max(highest, instinct.confidence),
      0,
    ),
    instinct_count: normalizedInstincts.length,
    project_ids: dedupeStrings(
      normalizedInstincts
        .map((instinct) => instinct.project_id)
        .filter((value) => typeof value === "string" && value.trim() !== ""),
    ),
    scopes: dedupeStrings(normalizedInstincts.map((instinct) => instinct.scope)),
    total_observation_count: normalizedInstincts.reduce(
      (sum, instinct) => sum + instinct.evidence.observation_count,
      0,
    ),
  });
}

function normalizeBundle(bundle) {
  const normalizedBundle = ensurePlainObject(bundle, "bundle");
  const bundleKind = ensureNonEmptyString(
    normalizedBundle.bundleKind ?? normalizedBundle.bundle_kind ?? INSTINCT_TRANSFER_BUNDLE_KIND,
    "bundle.bundle_kind",
  );

  if (bundleKind !== INSTINCT_TRANSFER_BUNDLE_KIND) {
    throw new InstinctTransferError(
      `bundle.bundle_kind must be ${INSTINCT_TRANSFER_BUNDLE_KIND}`,
    );
  }

  const instincts = Array.isArray(normalizedBundle.instincts)
    ? normalizedBundle.instincts.map((instinct) => parseInstinctArtifact(instinct))
    : null;

  if (!instincts || instincts.length === 0) {
    throw new InstinctTransferError("bundle.instincts must contain at least one instinct artifact");
  }

  return Object.freeze({
    bundle_id: ensureNonEmptyString(
      normalizedBundle.bundleId ?? normalizedBundle.bundle_id,
      "bundle.bundle_id",
    ),
    bundle_kind: bundleKind,
    exported_at: toIsoTimestamp(
      normalizedBundle.exportedAt ?? normalizedBundle.exported_at,
      "bundle.exported_at",
    ),
    export_review: ensurePlainObject(
      normalizedBundle.exportReview ?? normalizedBundle.export_review ?? {},
      "bundle.export_review",
    ),
    instincts: Object.freeze(instincts),
    summary: ensurePlainObject(normalizedBundle.summary ?? {}, "bundle.summary"),
    title: ensureNonEmptyString(
      normalizedBundle.title ?? `Reviewed instinct bundle ${normalizedBundle.bundleId ?? normalizedBundle.bundle_id}`,
      "bundle.title",
    ),
  });
}

function dedupeImportedInstincts(instincts = []) {
  const canonicalByKey = new Map();
  const duplicates = [];

  for (const instinct of instincts.map((entry) => parseInstinctArtifact(entry))) {
    const dedupKey = deriveInstinctDedupKey(instinct);
    const existing = canonicalByKey.get(dedupKey);

    if (!existing) {
      canonicalByKey.set(dedupKey, instinct);
      continue;
    }

    const canonical = existing.confidence >= instinct.confidence ? existing : instinct;
    const duplicate = canonical === existing ? instinct : existing;
    const merged = parseInstinctArtifact({
      ...canonical,
      confidence: Math.max(existing.confidence, instinct.confidence),
      evidence: mergeEvidence(existing.evidence, instinct.evidence),
      provenance: {
        ...canonical.provenance,
        evidence_refs: dedupeStrings([
          ...canonical.provenance.evidence_refs,
          ...duplicate.provenance.evidence_refs,
        ]),
      },
      updated_at:
        Date.parse(existing.updated_at) >= Date.parse(instinct.updated_at)
          ? existing.updated_at
          : instinct.updated_at,
    });

    canonicalByKey.set(dedupKey, merged);
    duplicates.push(Object.freeze({
      dedup_key: dedupKey,
      duplicate_instinct_id: duplicate.id,
      kept_instinct_id: canonical.id,
      reason: `bundle instinct ${duplicate.id} duplicates ${canonical.id} on dedup key ${dedupKey}`,
    }));
  }

  return Object.freeze({
    duplicates: Object.freeze(duplicates),
    instincts: Object.freeze([...canonicalByKey.values()]),
  });
}

function deriveImportedInstinctId(bundleId, instinctId) {
  return `instinct-import-${slugify(bundleId)}-${slugify(instinctId)}`;
}

function exportReviewedInstinctBundle({
  bundleId = null,
  instincts = [],
  now = new Date(),
  review = {},
  summary = null,
  title = null,
} = {}) {
  if (!Array.isArray(instincts) || instincts.length === 0) {
    throw new InstinctTransferError("instincts must contain at least one instinct artifact");
  }

  const normalizedInstincts = Object.freeze(instincts.map((instinct) => parseInstinctArtifact(instinct)));
  const normalizedReview = normalizeReview(review, now);

  if (normalizedReview.decision === "reject") {
    return Object.freeze({
      approved: false,
      bundle: null,
      reason_rejected: normalizedReview.rationale,
      review_record: normalizedReview,
    });
  }

  const bundleSummary = summarizeInstincts(normalizedInstincts);
  const resolvedBundleId =
    bundleId === null || bundleId === undefined
      ? `instinct-bundle-${Date.parse(normalizedReview.reviewed_at)}`
      : ensureNonEmptyString(bundleId, "bundleId");

  return Object.freeze({
    approved: true,
    bundle: Object.freeze({
      bundle_id: resolvedBundleId,
      bundle_kind: INSTINCT_TRANSFER_BUNDLE_KIND,
      export_review: {
        rationale: normalizedReview.rationale,
        review_level: normalizedReview.review_level,
        reviewed_at: normalizedReview.reviewed_at,
        reviewer_id: normalizedReview.reviewer_id,
      },
      exported_at: normalizedReview.reviewed_at,
      instincts: normalizedInstincts,
      summary: {
        ...bundleSummary,
        human_summary:
          summary === null || summary === undefined
            ? `Reviewed export of ${bundleSummary.instinct_count} instinct artifact(s).`
            : ensureNonEmptyString(summary, "summary"),
      },
      title:
        title === null || title === undefined
          ? `Reviewed instinct export ${resolvedBundleId}`
          : ensureNonEmptyString(title, "title"),
    }),
    reason_rejected: null,
    review_record: normalizedReview,
  });
}

function importReviewedInstinctBundle({
  bundle,
  existingInstincts = [],
  now = new Date(),
  review = {},
} = {}) {
  if (!Array.isArray(existingInstincts)) {
    throw new InstinctTransferError("existingInstincts must be an array");
  }

  const normalizedBundle = normalizeBundle(bundle);
  const normalizedReview = normalizeReview(review, now);
  const normalizedExistingInstincts = existingInstincts.map((instinct) => parseInstinctArtifact(instinct));

  if (normalizedReview.decision === "reject") {
    return Object.freeze({
      approved: false,
      bundle: normalizedBundle,
      duplicates: Object.freeze([]),
      imported_instincts: Object.freeze([]),
      merged_instincts: Object.freeze([]),
      reason_rejected: normalizedReview.rationale,
      review_record: normalizedReview,
      summary: Object.freeze({
        duplicate_count: 0,
        imported_count: 0,
        merged_count: 0,
        total_processed: 0,
      }),
    });
  }

  const dedupedBundle = dedupeImportedInstincts(normalizedBundle.instincts);
  const existingByKey = new Map(
    normalizedExistingInstincts.map((instinct) => [deriveInstinctDedupKey(instinct), instinct]),
  );
  const importedInstincts = [];
  const mergedInstincts = [];

  for (const importedInstinct of dedupedBundle.instincts) {
    const dedupKey = deriveInstinctDedupKey(importedInstinct);
    const existingInstinct = existingByKey.get(dedupKey);
    const importedBundleRef = `${normalizedBundle.bundle_id}:${importedInstinct.id}`;

    if (existingInstinct) {
      const mergedInstinct = parseInstinctArtifact({
        ...existingInstinct,
        confidence: Math.max(existingInstinct.confidence, importedInstinct.confidence),
        evidence: mergeEvidence(existingInstinct.evidence, importedInstinct.evidence),
        provenance: {
          ...existingInstinct.provenance,
          evidence_refs: dedupeStrings([
            ...existingInstinct.provenance.evidence_refs,
            ...importedInstinct.provenance.evidence_refs,
            importedBundleRef,
          ]),
        },
        updated_at: normalizedReview.reviewed_at,
      });

      existingByKey.set(dedupKey, mergedInstinct);
      mergedInstincts.push(Object.freeze({
        dedup_key: dedupKey,
        existing_instinct_id: existingInstinct.id,
        imported_bundle_ref: importedBundleRef,
        imported_confidence: importedInstinct.confidence,
        imported_instinct_id: importedInstinct.id,
        local_confidence: existingInstinct.confidence,
        merge_policy: INSTINCT_TRANSFER_MERGE_POLICY,
        merged_instinct: mergedInstinct,
      }));
      continue;
    }

    const newImportedInstinct = parseInstinctArtifact({
      ...importedInstinct,
      created_at: normalizedReview.reviewed_at,
      id: deriveImportedInstinctId(normalizedBundle.bundle_id, importedInstinct.id),
      promotion_review: {
        rationale: normalizedReview.rationale,
        review_level: normalizedReview.review_level,
        reviewed_at: normalizedReview.reviewed_at,
        reviewer_id: normalizedReview.reviewer_id,
      },
      provenance: {
        evidence_refs: dedupeStrings([
          ...importedInstinct.provenance.evidence_refs,
          importedBundleRef,
        ]),
        source_ref: importedBundleRef,
        source_summary: `Imported reviewed instinct ${importedInstinct.id} from bundle ${normalizedBundle.bundle_id}.`,
        source_type: "instinct_import",
        suggestion_category: importedInstinct.provenance.suggestion_category ?? null,
      },
      source: "imported",
      status: "tentative",
      updated_at: normalizedReview.reviewed_at,
    });

    importedInstincts.push(newImportedInstinct);
  }

  return Object.freeze({
    approved: true,
    bundle: normalizedBundle,
    duplicates: dedupedBundle.duplicates,
    imported_instincts: Object.freeze(importedInstincts),
    merged_instincts: Object.freeze(mergedInstincts),
    reason_rejected: null,
    review_record: normalizedReview,
    summary: Object.freeze({
      duplicate_count: dedupedBundle.duplicates.length,
      imported_count: importedInstincts.length,
      merged_count: mergedInstincts.length,
      total_processed: dedupedBundle.instincts.length,
    }),
  });
}

export {
  INSTINCT_TRANSFER_BUNDLE_KIND,
  INSTINCT_TRANSFER_MERGE_POLICY,
  InstinctTransferError,
  deriveInstinctDedupKey,
  exportReviewedInstinctBundle,
  importReviewedInstinctBundle,
};
