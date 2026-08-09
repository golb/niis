const WRITE_PORTS = Object.freeze({
  tasks: ["upsert"],
  goals: ["upsert"],
  agents: ["upsert", "updateStatus", "accumulateCost"],
  runs: ["upsert"],
  events: ["append"],
  ingress: ["record"],
  assignments: ["record"],
  queue: ["enqueue", "claimNext"],
  leases: ["acquireOrRenew"],
  taskSessions: ["upsert"],
  taskRunSessions: ["upsert"],
  taskRunEvents: ["append"],
  taskLiveExcerpts: ["append"],
  taskContentRevisions: ["append"],
  runLogs: ["store"],
  taskNotes: ["append"],
  approvals: ["upsert"],
  verdicts: ["record"],
  evidence: ["savePacket"],
  blockers: ["upsert"],
  checkpoints: ["save"],
  explainability: ["record"],
});

const QUERY_PORTS = Object.freeze({
  tasks: ["list", "byGoal"],
  goals: ["byId", "list"],
  runs: ["byTask"],
  agents: ["list", "byId", "health"],
  taskSessions: ["getByKey", "byTaskKey"],
  taskRunSessions: ["byTask", "byRun"],
  taskRunEvents: ["byTask", "byRun"],
  taskLiveExcerpts: ["byTask", "byRun"],
  taskContentRevisions: ["byTask"],
  runLogs: ["getByRunId", "byRun"],
  taskNotes: ["byTask"],
  approvals: ["byTask", "listPending"],
  blockers: ["active"],
  decisions: ["explain"],
  evidence: ["byVerdict"],
  ingress: ["byTask"],
  assignments: ["byTask"],
  metrics: ["summary"],
});

const CONCURRENCY_SEMANTICS = Object.freeze({
  queue_claim: "atomic_claim",
  lease_renewal: "acquire_or_renew_is_atomic",
  event_append: "append_is_idempotent_when_request_id_matches",
  state_transitions: "compare_and_set_required_when_prior_state_matters",
  direct_sql_access: "forbidden_outside_storage_implementation",
});

const STORAGE_CONTRACT_VERSION = "storage/v1";
const STORAGE_BACKEND_KINDS = ["sqlite_local", "hosted_service"];
const STORAGE_COMPATIBILITY_STATUSES = ["compatible", "migration_required", "blocked"];
const STORAGE_MIGRATION_CHECK_STATUSES = ["ok", "warning", "error"];

class StorageContractError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "StorageContractError";
    this.missingPorts = options.missingPorts ?? [];
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StorageContractError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureNullableString(value, label) {
  if (value === undefined || value === null) {
    return null;
  }

  return ensureNonEmptyString(value, label);
}

function ensurePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageContractError(`${label} must be a plain object`);
  }

  return value;
}

function ensureStringArray(values, label) {
  if (!Array.isArray(values)) {
    throw new StorageContractError(`${label} must be an array`);
  }

  return values.map((value, index) => ensureNonEmptyString(value, `${label}[${index}]`));
}

function ensureEnumValue(value, allowedValues, label) {
  if (!allowedValues.includes(value)) {
    throw new StorageContractError(`${label} must be one of: ${allowedValues.join(", ")}`);
  }

  return value;
}

function ensureIsoTimestamp(value, label) {
  const normalizedValue = value instanceof Date ? value.toISOString() : value;

  if (typeof normalizedValue !== "string" || Number.isNaN(Date.parse(normalizedValue))) {
    throw new StorageContractError(`${label} must be an ISO 8601 timestamp`);
  }

  return new Date(normalizedValue).toISOString();
}

function listPorts(portGroups) {
  return Object.entries(portGroups).flatMap(([group, methods]) =>
    methods.map((method) => `${group}.${method}`),
  );
}

const REQUIRED_WRITE_PORTS = Object.freeze(listPorts(WRITE_PORTS));
const REQUIRED_QUERY_PORTS = Object.freeze(listPorts(QUERY_PORTS));
const REQUIRED_STORAGE_PORTS = Object.freeze([
  ...REQUIRED_WRITE_PORTS,
  ...REQUIRED_QUERY_PORTS,
]);

function uniqueStrings(values) {
  return Object.freeze([...new Set(values)]);
}

function normalizePortList(values, label, fallbackValues) {
  if (values === undefined) {
    return uniqueStrings(fallbackValues);
  }

  return uniqueStrings(ensureStringArray(values, label));
}

function normalizeConcurrencySemantics(concurrencySemantics = {}) {
  const normalized = ensurePlainObject(concurrencySemantics, "concurrencySemantics");

  return Object.freeze({
    direct_sql_access: ensureNonEmptyString(
      normalized.direct_sql_access ?? CONCURRENCY_SEMANTICS.direct_sql_access,
      "concurrencySemantics.direct_sql_access",
    ),
    event_append: ensureNonEmptyString(
      normalized.event_append ?? CONCURRENCY_SEMANTICS.event_append,
      "concurrencySemantics.event_append",
    ),
    lease_renewal: ensureNonEmptyString(
      normalized.lease_renewal ?? CONCURRENCY_SEMANTICS.lease_renewal,
      "concurrencySemantics.lease_renewal",
    ),
    queue_claim: ensureNonEmptyString(
      normalized.queue_claim ?? CONCURRENCY_SEMANTICS.queue_claim,
      "concurrencySemantics.queue_claim",
    ),
    state_transitions: ensureNonEmptyString(
      normalized.state_transitions ?? CONCURRENCY_SEMANTICS.state_transitions,
      "concurrencySemantics.state_transitions",
    ),
  });
}

function normalizeMigrationCapabilities(migrationCapabilities = {}) {
  const normalized = ensurePlainObject(migrationCapabilities, "migrationCapabilities");

  return Object.freeze({
    preflight_readonly:
      normalized.preflight_readonly
      ?? normalized.preflightReadonly
      ?? true,
    snapshot_export:
      normalized.snapshot_export
      ?? normalized.snapshotExport
      ?? true,
    snapshot_import:
      normalized.snapshot_import
      ?? normalized.snapshotImport
      ?? true,
  });
}

function createStorageContractDescriptor() {
  return {
    contractVersion: STORAGE_CONTRACT_VERSION,
    writePorts: WRITE_PORTS,
    queryPorts: QUERY_PORTS,
    concurrencySemantics: CONCURRENCY_SEMANTICS,
    requiredWritePorts: REQUIRED_WRITE_PORTS,
    requiredQueryPorts: REQUIRED_QUERY_PORTS,
    requiredStoragePorts: REQUIRED_STORAGE_PORTS,
  };
}

function createStorageBackendDescriptor(input = {}) {
  const normalizedInput = ensurePlainObject(input, "storageBackend");
  const resolvedBackendId = normalizedInput.backendId ?? normalizedInput.backend_id;
  const resolvedDisplayName = normalizedInput.displayName ?? normalizedInput.display_name;
  const resolvedContractVersion = normalizedInput.contractVersion ?? normalizedInput.contract_version ?? STORAGE_CONTRACT_VERSION;
  const resolvedKind = normalizedInput.kind;
  const resolvedSchemaVersion = normalizedInput.schemaVersion ?? normalizedInput.schema_version ?? null;
  const resolvedSupportedSchemaVersions =
    normalizedInput.supportedSchemaVersions
    ?? normalizedInput.supported_schema_versions
    ?? undefined;
  const resolvedWritePorts = normalizedInput.writePorts ?? normalizedInput.write_ports ?? undefined;
  const resolvedQueryPorts = normalizedInput.queryPorts ?? normalizedInput.query_ports ?? undefined;
  const resolvedConcurrencySemantics =
    normalizedInput.concurrencySemantics
    ?? normalizedInput.concurrency_semantics
    ?? {};
  const resolvedMigrationCapabilities =
    normalizedInput.migrationCapabilities
    ?? normalizedInput.migration_capabilities
    ?? {};
  const resolvedMetadata = normalizedInput.metadata ?? {};
  const normalizedSchemaVersion = ensureNullableString(resolvedSchemaVersion, "schemaVersion");
  const normalizedSupportedSchemaVersions = resolvedSupportedSchemaVersions === undefined
    ? (normalizedSchemaVersion ? [normalizedSchemaVersion] : [])
    : ensureStringArray(resolvedSupportedSchemaVersions, "supportedSchemaVersions");

  return Object.freeze({
    backend_id: ensureNonEmptyString(resolvedBackendId, "backendId"),
    contract_version: ensureNonEmptyString(resolvedContractVersion, "contractVersion"),
    concurrency_semantics: normalizeConcurrencySemantics(resolvedConcurrencySemantics),
    display_name: ensureNonEmptyString(resolvedDisplayName, "displayName"),
    kind: ensureEnumValue(resolvedKind, STORAGE_BACKEND_KINDS, "kind"),
    metadata: ensurePlainObject(resolvedMetadata, "metadata"),
    migration_capabilities: normalizeMigrationCapabilities(resolvedMigrationCapabilities),
    query_ports: normalizePortList(resolvedQueryPorts, "queryPorts", REQUIRED_QUERY_PORTS),
    schema_version: normalizedSchemaVersion,
    supported_schema_versions: uniqueStrings(normalizedSupportedSchemaVersions),
    write_ports: normalizePortList(resolvedWritePorts, "writePorts", REQUIRED_WRITE_PORTS),
  });
}

function createStorageMigrationCheck({
  id,
  status,
  summary,
  details,
} = {}) {
  return Object.freeze({
    details: ensureNonEmptyString(details, "details"),
    id: ensureNonEmptyString(id, "id"),
    status: ensureEnumValue(status, STORAGE_MIGRATION_CHECK_STATUSES, "status"),
    summary: ensureNonEmptyString(summary, "summary"),
  });
}

function createStorageMigrationPlan({
  planId,
  sourceBackend,
  targetBackend,
  compatibilityStatus = "compatible",
  createdAt = new Date(),
  checks = [],
  migrationRefs = [],
  blockedBy = [],
  operatorGuidance = [],
} = {}) {
  if (!Array.isArray(checks)) {
    throw new StorageContractError("checks must be an array");
  }

  return Object.freeze({
    blocked_by: uniqueStrings(ensureStringArray(blockedBy, "blockedBy")),
    checks: Object.freeze(checks.map((check) => createStorageMigrationCheck(check))),
    compatibility_status: ensureEnumValue(
      compatibilityStatus,
      STORAGE_COMPATIBILITY_STATUSES,
      "compatibilityStatus",
    ),
    created_at: ensureIsoTimestamp(createdAt, "createdAt"),
    migration_refs: uniqueStrings(ensureStringArray(migrationRefs, "migrationRefs")),
    operator_guidance: uniqueStrings(ensureStringArray(operatorGuidance, "operatorGuidance")),
    plan_id: ensureNonEmptyString(planId, "planId"),
    source_backend: createStorageBackendDescriptor(sourceBackend),
    target_backend: createStorageBackendDescriptor(targetBackend),
  });
}

function escalateCompatibilityStatus(currentStatus, nextStatus) {
  if (currentStatus === "blocked" || nextStatus === "blocked") {
    return "blocked";
  }

  if (currentStatus === "migration_required" || nextStatus === "migration_required") {
    return "migration_required";
  }

  return "compatible";
}

function evaluateStorageBackendCompatibility({
  planId = "storage-migration-plan",
  sourceBackend,
  targetBackend,
  createdAt = new Date(),
  migrationRefs = [],
  operatorGuidance = [],
} = {}) {
  const normalizedSourceBackend = createStorageBackendDescriptor(sourceBackend);
  const normalizedTargetBackend = createStorageBackendDescriptor(targetBackend);
  const checks = [];
  const blockedBy = [];
  const guidance = [...ensureStringArray(operatorGuidance, "operatorGuidance")];
  let compatibilityStatus = "compatible";

  function addCheck(check) {
    checks.push(createStorageMigrationCheck(check));
  }

  function block(reason) {
    compatibilityStatus = escalateCompatibilityStatus(compatibilityStatus, "blocked");
    blockedBy.push(reason);
  }

  function requireMigration(guidanceLine = null) {
    compatibilityStatus = escalateCompatibilityStatus(compatibilityStatus, "migration_required");

    if (guidanceLine) {
      guidance.push(guidanceLine);
    }
  }

  if (normalizedSourceBackend.contract_version === normalizedTargetBackend.contract_version) {
    addCheck({
      id: "storage-contract-version",
      status: "ok",
      summary: normalizedTargetBackend.contract_version,
      details: "Target backend preserves the current storage contract version.",
    });
  } else {
    addCheck({
      id: "storage-contract-version",
      status: "error",
      summary: `${normalizedSourceBackend.contract_version} -> ${normalizedTargetBackend.contract_version}`,
      details: "Target backend changes the storage contract version and would break the core query contract.",
    });
    block("storage_contract_version_mismatch");
  }

  const missingWritePorts = REQUIRED_WRITE_PORTS.filter((port) =>
    !normalizedTargetBackend.write_ports.includes(port));
  if (missingWritePorts.length === 0) {
    addCheck({
      id: "storage-write-ports",
      status: "ok",
      summary: `${normalizedTargetBackend.write_ports.length} declared write port(s)`,
      details: "Target backend declares the required write surface.",
    });
  } else {
    addCheck({
      id: "storage-write-ports",
      status: "error",
      summary: missingWritePorts.join(", "),
      details: "Target backend is missing required write ports from the canonical storage contract.",
    });
    block("storage_write_ports_missing");
  }

  const missingQueryPorts = REQUIRED_QUERY_PORTS.filter((port) =>
    !normalizedTargetBackend.query_ports.includes(port));
  if (missingQueryPorts.length === 0) {
    addCheck({
      id: "storage-query-ports",
      status: "ok",
      summary: `${normalizedTargetBackend.query_ports.length} declared query port(s)`,
      details: "Target backend preserves the core query contract.",
    });
  } else {
    addCheck({
      id: "storage-query-ports",
      status: "error",
      summary: missingQueryPorts.join(", "),
      details: "Target backend is missing required query ports and would break explainability/metrics callers.",
    });
    block("storage_query_ports_missing");
  }

  const concurrencyMismatches = Object.keys(CONCURRENCY_SEMANTICS).filter((key) =>
    normalizedSourceBackend.concurrency_semantics[key] !== normalizedTargetBackend.concurrency_semantics[key]);
  if (concurrencyMismatches.length === 0) {
    addCheck({
      id: "storage-concurrency-semantics",
      status: "ok",
      summary: "Canonical storage concurrency semantics preserved.",
      details: "Target backend matches the required queue/lease/event/state concurrency guarantees.",
    });
  } else {
    addCheck({
      id: "storage-concurrency-semantics",
      status: "error",
      summary: concurrencyMismatches.join(", "),
      details: "Target backend changes required concurrency guarantees and could corrupt queue or state behavior.",
    });
    block("storage_concurrency_semantics_mismatch");
  }

  if (normalizedSourceBackend.schema_version === null) {
    addCheck({
      id: "storage-schema-version",
      status: "error",
      summary: "source schema version missing",
      details: "Migration planning requires a readable source schema version before any storage mutation is allowed.",
    });
    block("storage_source_schema_unknown");
  } else if (normalizedTargetBackend.supported_schema_versions.length === 0) {
    addCheck({
      id: "storage-schema-version",
      status: "error",
      summary: "target compatibility floor missing",
      details: "Target backend must declare supported schema versions before migration planning can proceed.",
    });
    block("storage_target_schema_floor_missing");
  } else if (normalizedTargetBackend.supported_schema_versions.includes(normalizedSourceBackend.schema_version)) {
    addCheck({
      id: "storage-schema-version",
      status: "ok",
      summary: normalizedSourceBackend.schema_version,
      details: "Target backend accepts the current source schema version.",
    });
  } else {
    addCheck({
      id: "storage-schema-version",
      status: "warning",
      summary: `${normalizedSourceBackend.schema_version} -> [${normalizedTargetBackend.supported_schema_versions.join(", ")}]`,
      details: "Target backend does not accept the current source schema version without an explicit migration step.",
    });
    requireMigration(
      `Apply a storage schema migration from ${normalizedSourceBackend.schema_version} before switching to ${normalizedTargetBackend.display_name}.`,
    );
  }

  if (normalizedSourceBackend.kind === normalizedTargetBackend.kind) {
    addCheck({
      id: "storage-backend-kind",
      status: "ok",
      summary: normalizedSourceBackend.kind,
      details: "Migration stays within the same backend family.",
    });
  } else {
    addCheck({
      id: "storage-backend-kind",
      status: "warning",
      summary: `${normalizedSourceBackend.kind} -> ${normalizedTargetBackend.kind}`,
      details: "Migration crosses backend families and therefore requires an explicit export/import plan.",
    });
    requireMigration(
      `Prepare an operator-reviewed snapshot transfer from ${normalizedSourceBackend.display_name} to ${normalizedTargetBackend.display_name}.`,
    );

    if (!normalizedSourceBackend.migration_capabilities.snapshot_export) {
      addCheck({
        id: "storage-snapshot-export",
        status: "error",
        summary: normalizedSourceBackend.display_name,
        details: "Source backend cannot export a migration snapshot for cross-backend transition.",
      });
      block("storage_snapshot_export_unavailable");
    }

    if (!normalizedTargetBackend.migration_capabilities.snapshot_import) {
      addCheck({
        id: "storage-snapshot-import",
        status: "error",
        summary: normalizedTargetBackend.display_name,
        details: "Target backend cannot import a migration snapshot for cross-backend transition.",
      });
      block("storage_snapshot_import_unavailable");
    }
  }

  if (compatibilityStatus === "compatible") {
    guidance.push("No storage migration is required; preflight compatibility checks passed.");
  }

  return createStorageMigrationPlan({
    blockedBy,
    checks,
    compatibilityStatus,
    createdAt,
    migrationRefs,
    operatorGuidance: guidance,
    planId,
    sourceBackend: normalizedSourceBackend,
    targetBackend: normalizedTargetBackend,
  });
}

function assertStorageImplementation(storageImplementation) {
  const missingPorts = [];

  for (const portPath of REQUIRED_STORAGE_PORTS) {
    const [group, method] = portPath.split(".");
    const implementationGroup = storageImplementation[group];

    if (!implementationGroup || typeof implementationGroup[method] !== "function") {
      missingPorts.push(portPath);
    }
  }

  if (missingPorts.length > 0) {
    throw new StorageContractError(
      `Storage implementation is missing required ports: ${missingPorts.join(", ")}`,
      { missingPorts },
    );
  }

  return true;
}

export {
  CONCURRENCY_SEMANTICS,
  QUERY_PORTS,
  REQUIRED_QUERY_PORTS,
  REQUIRED_STORAGE_PORTS,
  REQUIRED_WRITE_PORTS,
  STORAGE_BACKEND_KINDS,
  STORAGE_COMPATIBILITY_STATUSES,
  STORAGE_CONTRACT_VERSION,
  STORAGE_MIGRATION_CHECK_STATUSES,
  StorageContractError,
  WRITE_PORTS,
  assertStorageImplementation,
  createStorageBackendDescriptor,
  createStorageContractDescriptor,
  createStorageMigrationCheck,
  createStorageMigrationPlan,
  evaluateStorageBackendCompatibility,
};
