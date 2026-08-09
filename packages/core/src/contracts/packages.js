import { parseConversionReport } from "../schemas/conversion-report.js";
import { packageManifestSchema, parsePackageManifest } from "../schemas/package-manifest.js";

class PackageContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageContractError";
  }
}

const PACKAGE_SOURCE_KINDS = [
  "builtin",
  "local_filesystem",
  "registry",
  "converted_external",
  "operator_cli",
];
const RELEASE_CHANNELS = ["stable", "beta", "alpha", "canary"];
const UPGRADE_PLAN_STATUSES = ["compatible", "migration_required", "blocked"];
const DISCOVERY_CANDIDATE_KINDS = ["package", "plugin"];
const DISCOVERY_SOURCE_KINDS = ["local_filesystem", "registry"];
const DISCOVERY_SUGGESTION_CATEGORIES = [
  "shipped_capability",
  "technical_debt",
  "speculative_idea",
];
const INSTALL_TARGET_KINDS = [
  "workspace_package",
  "runtime_package",
  "command_surface",
  "state_bootstrap",
  "adapter",
  "plugin",
];
const DRIFT_REPORT_STATUSES = ["ok", "warning", "error"];
const PACKAGE_MANIFEST_SCHEMA_VERSION = packageManifestSchema.version;

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PackageContractError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageContractError(`${label} must be a plain object`);
  }

  return value;
}

function ensureEnumValue(value, allowedValues, label) {
  if (!allowedValues.includes(value)) {
    throw new PackageContractError(`${label} must be one of: ${allowedValues.join(", ")}`);
  }

  return value;
}

function ensureStringArray(values, label) {
  if (!Array.isArray(values)) {
    throw new PackageContractError(`${label} must be an array`);
  }

  return values.map((value, index) => ensureNonEmptyString(value, `${label}[${index}]`));
}

function ensureIsoTimestamp(value, label) {
  const normalizedValue = value instanceof Date ? value.toISOString() : value;

  if (typeof normalizedValue !== "string" || Number.isNaN(Date.parse(normalizedValue))) {
    throw new PackageContractError(`${label} must be an ISO 8601 timestamp`);
  }

  return new Date(normalizedValue).toISOString();
}

function ensureNullableString(value, label) {
  if (value === undefined || value === null) {
    return null;
  }

  return ensureNonEmptyString(value, label);
}

function normalizeCompatibility(compatibility = {}) {
  const normalizedCompatibility = ensurePlainObject(compatibility, "compatibility");

  return Object.freeze({
    max_niis_version:
      normalizedCompatibility.max_niis_version
      ?? normalizedCompatibility.maxNiisVersion
      ?? null,
    min_niis_version:
      ensureNonEmptyString(
        normalizedCompatibility.min_niis_version
        ?? normalizedCompatibility.minNiisVersion
        ?? "0.1.0",
        "compatibility.min_niis_version",
      ),
    required_adapters: ensureStringArray(
      normalizedCompatibility.required_adapters
      ?? normalizedCompatibility.requiredAdapters
      ?? [],
      "compatibility.required_adapters",
    ),
  });
}

function normalizePackageRuntime(runtime = {}) {
  const normalizedRuntime = runtime ?? {};

  if (normalizedRuntime !== null && (typeof normalizedRuntime !== "object" || Array.isArray(normalizedRuntime))) {
    throw new PackageContractError("runtime must be a plain object");
  }

  return Object.freeze({
    config:
      normalizedRuntime?.config && typeof normalizedRuntime.config === "object" && !Array.isArray(normalizedRuntime.config)
        ? normalizedRuntime.config
        : {},
    definition_kind:
      normalizedRuntime?.definition_kind
      ?? normalizedRuntime?.definitionKind
      ?? null,
    export_name:
      normalizedRuntime?.export_name
      ?? normalizedRuntime?.exportName
      ?? "default",
    module_ref:
      normalizedRuntime?.module_ref
      ?? normalizedRuntime?.moduleRef
      ?? null,
  });
}

function normalizeTrackedFiles(files = []) {
  if (!Array.isArray(files)) {
    throw new PackageContractError("files must be an array");
  }

  return Object.freeze(files.map((file, index) => {
    const normalizedFile = ensurePlainObject(file, `files[${index}]`);

    return Object.freeze({
      path: ensureNonEmptyString(normalizedFile.path, `files[${index}].path`),
      required: normalizedFile.required === undefined ? true : Boolean(normalizedFile.required),
      sha256:
        normalizedFile.sha256 === undefined || normalizedFile.sha256 === null
          ? null
          : ensureNonEmptyString(normalizedFile.sha256, `files[${index}].sha256`),
    });
  }));
}

function createPackageManifest({
  id,
  name,
  version,
  type,
  capabilities = [],
  compatibility = {},
  runtime = {},
  activationStatus = "INACTIVE",
  schemaVersion = packageManifestSchema.version,
} = {}) {
  return parsePackageManifest({
    activation_status: activationStatus,
    capabilities: ensureStringArray(capabilities, "capabilities"),
    compatibility: normalizeCompatibility(compatibility),
    id: ensureNonEmptyString(id, "id"),
    name: ensureNonEmptyString(name, "name"),
    runtime: normalizePackageRuntime(runtime),
    schema_version: ensureNonEmptyString(schemaVersion, "schemaVersion"),
    type,
    version: ensureNonEmptyString(version, "version"),
  });
}

function createReleaseBundle({
  bundleId,
  packageId,
  version,
  channel = "stable",
  createdAt = new Date(),
  sourceKind = "builtin",
  fileRefs = [],
  compatibility = {},
  migrationRefs = [],
} = {}) {
  return Object.freeze({
    bundle_id: ensureNonEmptyString(bundleId, "bundleId"),
    channel: ensureEnumValue(channel, RELEASE_CHANNELS, "channel"),
    compatibility: normalizeCompatibility(compatibility),
    created_at: ensureIsoTimestamp(createdAt, "createdAt"),
    file_refs: ensureStringArray(fileRefs, "fileRefs"),
    migration_refs: ensureStringArray(migrationRefs, "migrationRefs"),
    package_id: ensureNonEmptyString(packageId, "packageId"),
    source_kind: ensureEnumValue(sourceKind, PACKAGE_SOURCE_KINDS, "sourceKind"),
    version: ensureNonEmptyString(version, "version"),
  });
}

function toConversionReportSecurityFinding(finding) {
  const normalizedFinding = ensurePlainObject(finding, "securityFinding");

  return Object.freeze({
    auto_fixable: Boolean(normalizedFinding.auto_fixable ?? normalizedFinding.autoFixable ?? false),
    blocking: Boolean(normalizedFinding.blocking ?? false),
    remediation_hint:
      normalizedFinding.remediation_hint
      ?? normalizedFinding.remediationHint
      ?? null,
    rule_id: ensureNonEmptyString(
      normalizedFinding.rule_id ?? normalizedFinding.ruleId,
      "securityFinding.rule_id",
    ),
    severity: ensureNonEmptyString(normalizedFinding.severity, "securityFinding.severity"),
    summary: ensureNonEmptyString(normalizedFinding.summary, "securityFinding.summary"),
  });
}

function createConversionReport({
  id,
  sourcePack,
  targetPackageId,
  conversionStatus = "SUCCESS",
  warnings = [],
  incompatibilities = [],
  securityFindings = [],
  reviewStatus = "PENDING",
  convertedAt = new Date(),
} = {}) {
  const normalizedSourcePack = ensurePlainObject(sourcePack, "sourcePack");

  return parseConversionReport({
    conversion_status: conversionStatus,
    converted_at: ensureIsoTimestamp(convertedAt, "convertedAt"),
    id: ensureNonEmptyString(id, "id"),
    incompatibilities: ensureStringArray(incompatibilities, "incompatibilities"),
    review_status: reviewStatus,
    security_findings: ensureArrayLikeSecurityFindings(securityFindings),
    source_pack: {
      format: ensureNonEmptyString(normalizedSourcePack.format, "sourcePack.format"),
      origin: ensureNonEmptyString(normalizedSourcePack.origin, "sourcePack.origin"),
      path: ensureNonEmptyString(normalizedSourcePack.path, "sourcePack.path"),
    },
    target_package_id: ensureNonEmptyString(targetPackageId, "targetPackageId"),
    warnings: ensureStringArray(warnings, "warnings"),
  });
}

function ensureArrayLikeSecurityFindings(findings) {
  if (!Array.isArray(findings)) {
    throw new PackageContractError("securityFindings must be an array");
  }

  return findings.map((finding) => toConversionReportSecurityFinding(finding));
}

function createUpgradePlan({
  planId,
  packageId,
  fromVersion,
  toVersion,
  compatibilityStatus = "compatible",
  createdAt = new Date(),
  checks = [],
  migrationRefs = [],
  blockedBy = [],
} = {}) {
  return Object.freeze({
    blocked_by: ensureStringArray(blockedBy, "blockedBy"),
    checks: ensureStringArray(checks, "checks"),
    compatibility_status: ensureEnumValue(
      compatibilityStatus,
      UPGRADE_PLAN_STATUSES,
      "compatibilityStatus",
    ),
    created_at: ensureIsoTimestamp(createdAt, "createdAt"),
    from_version: ensureNonEmptyString(fromVersion, "fromVersion"),
    migration_refs: ensureStringArray(migrationRefs, "migrationRefs"),
    package_id: ensureNonEmptyString(packageId, "packageId"),
    plan_id: ensureNonEmptyString(planId, "planId"),
    to_version: ensureNonEmptyString(toVersion, "toVersion"),
  });
}

function createInstallStateEntry({
  id,
  targetKind,
  displayName,
  version,
  sourceKind,
  sourceRef,
  recordedAt = new Date(),
  files = [],
  operations = [],
  packageId = null,
  metadata = {},
} = {}) {
  return Object.freeze({
    display_name: ensureNonEmptyString(displayName, "displayName"),
    files: normalizeTrackedFiles(files),
    id: ensureNonEmptyString(id, "id"),
    metadata: ensurePlainObject(metadata, "metadata"),
    operations: ensureStringArray(operations, "operations"),
    package_id:
      packageId === undefined || packageId === null
        ? null
        : ensureNonEmptyString(packageId, "packageId"),
    recorded_at: ensureIsoTimestamp(recordedAt, "recordedAt"),
    source_kind: ensureEnumValue(sourceKind, PACKAGE_SOURCE_KINDS, "sourceKind"),
    source_ref: ensureNonEmptyString(sourceRef, "sourceRef"),
    target_kind: ensureEnumValue(targetKind, INSTALL_TARGET_KINDS, "targetKind"),
    version: ensureNonEmptyString(version, "version"),
  });
}

function createDriftReportEntry({
  id,
  entryId = null,
  status,
  summary,
  details,
} = {}) {
  return Object.freeze({
    details: ensureNonEmptyString(details, "details"),
    entry_id:
      entryId === undefined || entryId === null ? null : ensureNonEmptyString(entryId, "entryId"),
    id: ensureNonEmptyString(id, "id"),
    status: ensureEnumValue(status, DRIFT_REPORT_STATUSES, "status"),
    summary: ensureNonEmptyString(summary, "summary"),
  });
}

function normalizeSecurityFindings(findings = [], label = "securityFindings") {
  if (!Array.isArray(findings)) {
    throw new PackageContractError(`${label} must be an array`);
  }

  return Object.freeze(findings.map((finding, index) => {
    const normalizedFinding = ensurePlainObject(finding, `${label}[${index}]`);

    return Object.freeze({
      auto_fixable: Boolean(normalizedFinding.auto_fixable ?? normalizedFinding.autoFixable ?? false),
      blocking: Boolean(normalizedFinding.blocking ?? false),
      category: ensureNullableString(
        normalizedFinding.category ?? null,
        `${label}[${index}].category`,
      ),
      remediation_hint: ensureNonEmptyString(
        normalizedFinding.remediation_hint ?? normalizedFinding.remediationHint,
        `${label}[${index}].remediation_hint`,
      ),
      rule_id: ensureNonEmptyString(
        normalizedFinding.rule_id ?? normalizedFinding.ruleId,
        `${label}[${index}].rule_id`,
      ),
      severity: ensureNonEmptyString(normalizedFinding.severity, `${label}[${index}].severity`),
      source_surface_id: ensureNullableString(
        normalizedFinding.source_surface_id ?? normalizedFinding.sourceSurfaceId ?? null,
        `${label}[${index}].source_surface_id`,
      ),
      source_surface_type: ensureNullableString(
        normalizedFinding.source_surface_type ?? normalizedFinding.sourceSurfaceType ?? null,
        `${label}[${index}].source_surface_type`,
      ),
      summary: ensureNonEmptyString(normalizedFinding.summary, `${label}[${index}].summary`),
    });
  }));
}

function createDiscoveryCandidate({
  candidateId,
  candidateKind = "package",
  sourceKind,
  sourceRef,
  displayName,
  packageId = null,
  version = null,
  dedupKey,
  reviewRequired = true,
  packageManifest = null,
  securityFindings = [],
  metadata = {},
  suggestionCategory = "speculative_idea",
  suggestionReason = null,
} = {}) {
  const normalizedInput = arguments[0] ?? {};
  const resolvedCandidateKind =
    candidateKind === "package" && normalizedInput.candidate_kind !== undefined
      ? normalizedInput.candidate_kind
      : candidateKind;
  const resolvedPackageId =
    packageId === null && normalizedInput.package_id !== undefined
      ? normalizedInput.package_id
      : packageId;
  const resolvedVersion =
    version === null && normalizedInput.version !== undefined
      ? normalizedInput.version
      : version;
  const resolvedPackageManifest =
    packageManifest === null && normalizedInput.package_manifest !== undefined
      ? normalizedInput.package_manifest
      : packageManifest;
  const resolvedSecurityFindings =
    Array.isArray(securityFindings) && securityFindings.length === 0 && normalizedInput.security_findings !== undefined
      ? normalizedInput.security_findings
      : securityFindings;
  const resolvedMetadata =
    metadata && Object.keys(metadata).length === 0 && normalizedInput.metadata !== undefined
      ? normalizedInput.metadata
      : metadata;
  const resolvedSuggestionCategory =
    suggestionCategory === "speculative_idea" && normalizedInput.suggestion_category !== undefined
      ? normalizedInput.suggestion_category
      : suggestionCategory;
  const resolvedSuggestionReason =
    suggestionReason === null && normalizedInput.suggestion_reason !== undefined
      ? normalizedInput.suggestion_reason
      : suggestionReason;

  return Object.freeze({
    candidate_id: ensureNonEmptyString(
      candidateId ?? normalizedInput.candidate_id,
      "candidateId",
    ),
    candidate_kind: ensureEnumValue(
      resolvedCandidateKind ?? "package",
      DISCOVERY_CANDIDATE_KINDS,
      "candidateKind",
    ),
    dedup_key: ensureNonEmptyString(dedupKey ?? normalizedInput.dedup_key, "dedupKey"),
    display_name: ensureNonEmptyString(displayName ?? normalizedInput.display_name, "displayName"),
    metadata: ensurePlainObject(resolvedMetadata ?? {}, "metadata"),
    package_id: ensureNullableString(resolvedPackageId, "packageId"),
    package_manifest:
      resolvedPackageManifest === undefined
      || resolvedPackageManifest === null
        ? null
        : parsePackageManifest(resolvedPackageManifest),
    review_required: Boolean(reviewRequired ?? normalizedInput.review_required ?? true),
    security_findings: normalizeSecurityFindings(resolvedSecurityFindings ?? []),
    suggestion_category: ensureEnumValue(
      resolvedSuggestionCategory ?? "speculative_idea",
      DISCOVERY_SUGGESTION_CATEGORIES,
      "suggestionCategory",
    ),
    suggestion_reason: ensureNullableString(resolvedSuggestionReason, "suggestionReason"),
    source_kind: ensureEnumValue(
      sourceKind ?? normalizedInput.source_kind,
      DISCOVERY_SOURCE_KINDS,
      "sourceKind",
    ),
    source_ref: ensureNonEmptyString(sourceRef ?? normalizedInput.source_ref, "sourceRef"),
    version: ensureNullableString(resolvedVersion, "version"),
  });
}

function createDiscoveryDuplicate({
  candidateId,
  canonicalCandidateId,
  dedupKey,
  reason,
} = {}) {
  const normalizedInput = arguments[0] ?? {};

  return Object.freeze({
    candidate_id: ensureNonEmptyString(candidateId ?? normalizedInput.candidate_id, "candidateId"),
    canonical_candidate_id: ensureNonEmptyString(
      canonicalCandidateId ?? normalizedInput.canonical_candidate_id,
      "canonicalCandidateId",
    ),
    dedup_key: ensureNonEmptyString(dedupKey ?? normalizedInput.dedup_key, "dedupKey"),
    reason: ensureNonEmptyString(reason ?? normalizedInput.reason, "reason"),
  });
}

function createDiscoveryReport({
  reportId,
  generatedAt = new Date(),
  candidates = [],
  duplicates = [],
  sourceKinds = [],
} = {}) {
  if (!Array.isArray(candidates)) {
    throw new PackageContractError("candidates must be an array");
  }

  if (!Array.isArray(duplicates)) {
    throw new PackageContractError("duplicates must be an array");
  }

  return Object.freeze({
    candidates: Object.freeze(candidates.map((candidate, index) =>
      createDiscoveryCandidate(ensurePlainObject(candidate, `candidates[${index}]`)))),
    duplicates: Object.freeze(duplicates.map((duplicate, index) =>
      createDiscoveryDuplicate(ensurePlainObject(duplicate, `duplicates[${index}]`)))),
    generated_at: ensureIsoTimestamp(generatedAt, "generatedAt"),
    report_id: ensureNonEmptyString(reportId, "reportId"),
    source_kinds: ensureStringArray(sourceKinds, "sourceKinds"),
  });
}

function createInstallState({
  packageRoot,
  stateRoot,
  databasePath = null,
  installedAt = new Date(),
  commands = [],
  entries = [],
  status = "BOOTSTRAPPED",
  schemaVersion = 1,
} = {}) {
  const normalizedInput = {
    commands,
    databasePath,
    entries,
    installedAt,
    packageRoot,
    schemaVersion,
    stateRoot,
    status,
  };

  if (normalizedInput.packageRoot === undefined) {
    normalizedInput.packageRoot = arguments[0]?.package_root;
  }

  if (normalizedInput.stateRoot === undefined) {
    normalizedInput.stateRoot = arguments[0]?.state_root;
  }

  if (normalizedInput.databasePath === null && arguments[0]?.database_path !== undefined) {
    normalizedInput.databasePath = arguments[0]?.database_path;
  }

  if (normalizedInput.installedAt instanceof Date === false && arguments[0]?.installed_at !== undefined) {
    normalizedInput.installedAt = arguments[0]?.installed_at;
  }

  if (normalizedInput.schemaVersion === 1 && arguments[0]?.schema_version !== undefined) {
    normalizedInput.schemaVersion = arguments[0]?.schema_version;
  }

  if (normalizedInput.status === "BOOTSTRAPPED" && arguments[0]?.status !== undefined) {
    normalizedInput.status = arguments[0]?.status;
  }

  if (Array.isArray(arguments[0]?.commands)) {
    normalizedInput.commands = arguments[0].commands;
  }

  if (Array.isArray(arguments[0]?.entries)) {
    normalizedInput.entries = arguments[0].entries;
  }

  if (!Number.isInteger(normalizedInput.schemaVersion) || normalizedInput.schemaVersion <= 0) {
    throw new PackageContractError("schemaVersion must be a positive integer");
  }

  return Object.freeze({
    commands: ensureStringArray(normalizedInput.commands, "commands"),
    database_path:
      normalizedInput.databasePath === undefined || normalizedInput.databasePath === null
        ? null
        : ensureNonEmptyString(normalizedInput.databasePath, "databasePath"),
    entries: Object.freeze(normalizedInput.entries.map((entry, index) =>
      createInstallStateEntry({
        ...normalizeInstallStateEntryInput(ensurePlainObject(entry, `entries[${index}]`)),
      }))),
    installed_at: ensureIsoTimestamp(normalizedInput.installedAt, "installedAt"),
    package_root: ensureNonEmptyString(normalizedInput.packageRoot, "packageRoot"),
    schema_version: normalizedInput.schemaVersion,
    state_root: ensureNonEmptyString(normalizedInput.stateRoot, "stateRoot"),
    status: ensureNonEmptyString(normalizedInput.status, "status"),
  });
}

function normalizeInstallStateEntryInput(entry) {
  return {
    displayName: entry.displayName ?? entry.display_name,
    files: entry.files ?? [],
    id: entry.id,
    metadata: entry.metadata ?? {},
    operations: entry.operations ?? [],
    packageId: entry.packageId ?? entry.package_id ?? null,
    recordedAt: entry.recordedAt ?? entry.recorded_at,
    sourceKind: entry.sourceKind ?? entry.source_kind,
    sourceRef: entry.sourceRef ?? entry.source_ref,
    targetKind: entry.targetKind ?? entry.target_kind,
    version: entry.version,
  };
}

export {
  DISCOVERY_CANDIDATE_KINDS,
  DISCOVERY_SOURCE_KINDS,
  DISCOVERY_SUGGESTION_CATEGORIES,
  DRIFT_REPORT_STATUSES,
  INSTALL_TARGET_KINDS,
  PACKAGE_SOURCE_KINDS,
  PACKAGE_MANIFEST_SCHEMA_VERSION,
  PackageContractError,
  RELEASE_CHANNELS,
  UPGRADE_PLAN_STATUSES,
  createDiscoveryCandidate,
  createDiscoveryDuplicate,
  createDiscoveryReport,
  createConversionReport,
  createDriftReportEntry,
  createInstallState,
  createInstallStateEntry,
  createPackageManifest,
  createReleaseBundle,
  createUpgradePlan,
};
