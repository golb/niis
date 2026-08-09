import { toIsoTimestamp } from "../scheduler/queue.js";

class ReferenceBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReferenceBundleError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReferenceBundleError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new ReferenceBundleError(`${label} must be an array`);
  }

  return values.map((value, index) => ensureNonEmptyString(value, `${label}[${index}]`));
}

function ensurePlainObject(value, label) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ReferenceBundleError(`${label} must be a plain object`);
  }

  return value;
}

function normalizeTrustLevel(entry) {
  const trustLevel = entry?.trust_level ?? entry?.trustLevel;

  if (trustLevel === "external") {
    return "external";
  }

  if (trustLevel === "authoritative") {
    return "authoritative";
  }

  return entry?.external === true || entry?.trusted === false ? "external" : "authoritative";
}

function normalizeProvenance(entry, fallbackSourceType) {
  const provenance = ensurePlainObject(entry?.provenance, "reference provenance");
  const sourceType = provenance.source_type ?? entry?.source_type ?? fallbackSourceType;
  const sourceRef = provenance.source_ref ?? entry?.source_ref ?? entry?.path ?? entry?.source ?? "inline";

  return Object.freeze({
    retrieved_at:
      provenance.retrieved_at === undefined || provenance.retrieved_at === null
        ? null
        : toIsoTimestamp(provenance.retrieved_at, "provenance.retrieved_at"),
    source_ref: ensureNonEmptyString(sourceRef, "reference provenance source_ref"),
    source_type: ensureNonEmptyString(sourceType, "reference provenance source_type"),
  });
}

function normalizeReferenceEntry(entry, index, sectionLabel) {
  if (typeof entry === "string") {
    return Object.freeze({
      content: ensureNonEmptyString(entry, `${sectionLabel}[${index}]`),
      id: `${sectionLabel}-${index + 1}`,
      provenance: normalizeProvenance({}, "inline"),
      title: `${sectionLabel} ${index + 1}`,
      trust_level: "authoritative",
    });
  }

  const normalizedEntry = ensurePlainObject(entry, `${sectionLabel}[${index}]`);
  const trustLevel = normalizeTrustLevel(normalizedEntry);

  return Object.freeze({
    content: ensureNonEmptyString(
      normalizedEntry.content ?? normalizedEntry.text ?? normalizedEntry.summary,
      `${sectionLabel}[${index}].content`,
    ),
    id: ensureNonEmptyString(
      normalizedEntry.id ?? `${sectionLabel}-${index + 1}`,
      `${sectionLabel}[${index}].id`,
    ),
    provenance: normalizeProvenance(
      normalizedEntry,
      trustLevel === "external" ? "external" : "project",
    ),
    title: ensureNonEmptyString(
      normalizedEntry.title ?? `${sectionLabel} ${index + 1}`,
      `${sectionLabel}[${index}].title`,
    ),
    trust_level: trustLevel,
  });
}

function normalizeReferenceEntries(entries, sectionLabel) {
  if (entries === undefined || entries === null) {
    return [];
  }

  if (!Array.isArray(entries)) {
    throw new ReferenceBundleError(`${sectionLabel} must be an array`);
  }

  return Object.freeze(entries.map((entry, index) => normalizeReferenceEntry(entry, index, sectionLabel)));
}

function normalizeStep(step, index) {
  if (typeof step === "string") {
    return Object.freeze({
      id: `step-${index + 1}`,
      instruction: ensureNonEmptyString(step, `step_catalog[${index}]`),
      title: `Step ${index + 1}`,
    });
  }

  const normalizedStep = ensurePlainObject(step, `step_catalog[${index}]`);

  return Object.freeze({
    id: ensureNonEmptyString(
      normalizedStep.id ?? `step-${index + 1}`,
      `step_catalog[${index}].id`,
    ),
    instruction: ensureNonEmptyString(
      normalizedStep.instruction ?? normalizedStep.content ?? normalizedStep.text,
      `step_catalog[${index}].instruction`,
    ),
    title: ensureNonEmptyString(
      normalizedStep.title ?? `Step ${index + 1}`,
      `step_catalog[${index}].title`,
    ),
  });
}

function normalizeStepCatalog(stepCatalog = []) {
  if (!Array.isArray(stepCatalog)) {
    throw new ReferenceBundleError("step_catalog must be an array");
  }

  return Object.freeze(stepCatalog.map((step, index) => normalizeStep(step, index)));
}

function createColdStartAudit(bundle) {
  const missingRequirements = [];

  if (bundle.target_paths.length === 0) {
    missingRequirements.push("target_paths");
  }

  if (
    bundle.guides.length === 0
    && bundle.examples.length === 0
    && bundle.step_catalog.length === 0
    && bundle.verifier_refs.length === 0
  ) {
    missingRequirements.push("execution_context");
  }

  if (bundle.documentation_priority.length === 0) {
    missingRequirements.push("documentation_priority");
  }

  return Object.freeze({
    executable: missingRequirements.length === 0,
    missing_requirements: Object.freeze(missingRequirements),
  });
}

function createReferenceBundle(input = {}) {
  const {
    id = null,
    taskId,
    targetPaths = [],
    guides = [],
    examples = [],
    stepCatalog = [],
    entityMapping = {},
    verifierRefs = [],
    documentationPriority = [],
    now = new Date(),
    refinementHistory = [],
  } = input;
  const taskIdentifier = taskId ?? input.task_id;
  const normalizedTargetPaths = targetPaths.length > 0 ? targetPaths : (input.target_paths ?? []);
  const normalizedStepCatalog = stepCatalog.length > 0 ? stepCatalog : (input.step_catalog ?? []);
  const normalizedEntityMapping =
    Object.keys(entityMapping).length > 0 ? entityMapping : (input.entity_mapping ?? {});
  const normalizedVerifierRefs =
    verifierRefs.length > 0 ? verifierRefs : (input.verifier_refs ?? []);
  const normalizedDocumentationPriority =
    documentationPriority.length > 0
      ? documentationPriority
      : (input.documentation_priority ?? []);
  const normalizedRefinementHistory =
    refinementHistory.length > 0
      ? refinementHistory
      : (input.refinement_history ?? []);
  const normalizedBundle = {
    assembled_at: toIsoTimestamp(now, "now"),
    documentation_priority: Object.freeze(
      ensureStringArray(normalizedDocumentationPriority, "documentationPriority"),
    ),
    entity_mapping: Object.freeze({
      ...ensurePlainObject(normalizedEntityMapping, "entityMapping"),
    }),
    examples: normalizeReferenceEntries(examples, "examples"),
    guides: normalizeReferenceEntries(guides, "guides"),
    id: ensureNonEmptyString(id ?? input.id ?? `${taskIdentifier}:reference-bundle`, "reference bundle id"),
    refinement_history: Object.freeze(
      (Array.isArray(normalizedRefinementHistory) ? normalizedRefinementHistory : []).map((entry, index) => {
        const normalizedEntry = ensurePlainObject(entry, `refinementHistory[${index}]`);

        return Object.freeze({
          applied_at: toIsoTimestamp(
            normalizedEntry.applied_at ?? normalizedEntry.appliedAt ?? now,
            `refinementHistory[${index}].applied_at`,
          ),
          reason: ensureNonEmptyString(
            normalizedEntry.reason ?? "reference refinement",
            `refinementHistory[${index}].reason`,
          ),
        });
      }),
    ),
    step_catalog: normalizeStepCatalog(normalizedStepCatalog),
    target_paths: Object.freeze(ensureStringArray(normalizedTargetPaths, "targetPaths")),
    task_id: ensureNonEmptyString(taskIdentifier, "taskId"),
    verifier_refs: normalizeReferenceEntries(normalizedVerifierRefs, "verifier_refs"),
  };

  return Object.freeze({
    ...normalizedBundle,
    cold_start: createColdStartAudit(normalizedBundle),
  });
}

function assertColdStartExecutable(referenceBundle) {
  const bundle = createReferenceBundle(referenceBundle);

  if (!bundle.cold_start.executable) {
    throw new ReferenceBundleError(
      `reference bundle ${bundle.id} is not cold-start executable; missing ${bundle.cold_start.missing_requirements.join(", ")}`,
    );
  }

  return bundle;
}

function refineReferenceBundle({
  bundle,
  additions = {},
  reason = "context refinement",
  now = new Date(),
}) {
  const normalizedBundle = createReferenceBundle(bundle);
  const normalizedAdditions = ensurePlainObject(additions, "additions");

  return createReferenceBundle({
    ...normalizedBundle,
    documentationPriority:
      normalizedAdditions.documentationPriority ?? normalizedBundle.documentation_priority,
    entityMapping: {
      ...normalizedBundle.entity_mapping,
      ...ensurePlainObject(normalizedAdditions.entityMapping, "additions.entityMapping"),
    },
    examples: [...normalizedBundle.examples, ...(normalizedAdditions.examples ?? [])],
    guides: [...normalizedBundle.guides, ...(normalizedAdditions.guides ?? [])],
    now,
    refinementHistory: [
      ...normalizedBundle.refinement_history,
      {
        applied_at: now,
        reason,
      },
    ],
    stepCatalog: [...normalizedBundle.step_catalog, ...(normalizedAdditions.stepCatalog ?? [])],
    targetPaths: [...normalizedBundle.target_paths, ...(normalizedAdditions.targetPaths ?? [])],
    verifierRefs: [
      ...normalizedBundle.verifier_refs,
      ...(normalizedAdditions.verifierRefs ?? []),
    ],
  });
}

export {
  ReferenceBundleError,
  assertColdStartExecutable,
  createReferenceBundle,
  createColdStartAudit,
  refineReferenceBundle,
};
