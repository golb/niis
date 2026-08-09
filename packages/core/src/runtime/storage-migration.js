import {
  SQLITE_SCHEMA_VERSION,
  createStorageBackendDescriptor,
  evaluateStorageBackendCompatibility,
  readSqliteStorageMetadata,
} from "../storage/index.js";

class StorageMigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageMigrationError";
  }
}

function createSqliteStorageBackendDescriptor({
  backendId = "local-sqlite",
  databasePath,
  displayName = "Local SQLite",
} = {}) {
  const metadata = readSqliteStorageMetadata({ databasePath });

  return createStorageBackendDescriptor({
    backendId,
    displayName,
    kind: "sqlite_local",
    metadata: {
      database_path: metadata.database_path,
      exists: metadata.exists,
      readonly_preflight: true,
      state_root: metadata.state_root,
    },
    schemaVersion: metadata.schema_version,
    supportedSchemaVersions: [String(SQLITE_SCHEMA_VERSION)],
  });
}

function planStorageBackendMigration({
  databasePath,
  targetBackend,
  planId = "storage-migration-plan",
  migrationRefs = [],
  operatorGuidance = [],
} = {}) {
  if (!targetBackend || typeof targetBackend !== "object" || Array.isArray(targetBackend)) {
    throw new StorageMigrationError("targetBackend must be a plain object");
  }

  const sourceBackend = createSqliteStorageBackendDescriptor({ databasePath });

  return evaluateStorageBackendCompatibility({
    migrationRefs,
    operatorGuidance,
    planId,
    sourceBackend,
    targetBackend,
  });
}

export {
  StorageMigrationError,
  createSqliteStorageBackendDescriptor,
  planStorageBackendMigration,
};
