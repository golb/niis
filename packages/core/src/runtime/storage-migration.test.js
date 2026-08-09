import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SQLITE_SCHEMA_VERSION, createSqliteDatabasePath, createSqliteStorage } from "../storage/index.js";
import {
  createSqliteStorageBackendDescriptor,
  planStorageBackendMigration,
} from "./storage-migration.js";

const CURRENT_SCHEMA_VERSION = String(SQLITE_SCHEMA_VERSION);
const FUTURE_SCHEMA_VERSION = String(SQLITE_SCHEMA_VERSION + 1);

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-storage-migration-"));
  const stateRoot = path.join(root, ".niis");
  const databasePath = createSqliteDatabasePath(stateRoot);
  const storage = createSqliteStorage({ databasePath });
  storage.close();

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  return {
    databasePath,
    root,
    stateRoot,
  };
}

test("createSqliteStorageBackendDescriptor reads local SQLite metadata", (t) => {
  const fixture = createFixture(t);
  const descriptor = createSqliteStorageBackendDescriptor({
    databasePath: fixture.databasePath,
  });

  assert.equal(descriptor.kind, "sqlite_local");
  assert.equal(descriptor.schema_version, CURRENT_SCHEMA_VERSION);
  assert.equal(descriptor.metadata.database_path, fixture.databasePath);
});

test("planStorageBackendMigration returns compatible for another sqlite-local backend on the same schema", (t) => {
  const fixture = createFixture(t);
  const plan = planStorageBackendMigration({
    databasePath: fixture.databasePath,
    targetBackend: {
      backendId: "sqlite-next",
      displayName: "SQLite Next",
      kind: "sqlite_local",
      supportedSchemaVersions: [CURRENT_SCHEMA_VERSION],
    },
  });

  assert.equal(plan.compatibility_status, "compatible");
  assert.equal(plan.blocked_by.length, 0);
});

test("planStorageBackendMigration returns migration_required for a hosted backend with a higher schema floor", (t) => {
  const fixture = createFixture(t);
  const plan = planStorageBackendMigration({
    databasePath: fixture.databasePath,
    targetBackend: {
      backendId: "hosted-preview",
      displayName: "Hosted Preview",
      kind: "hosted_service",
      supportedSchemaVersions: [FUTURE_SCHEMA_VERSION],
      migrationCapabilities: {
        snapshotImport: true,
      },
    },
  });

  assert.equal(plan.compatibility_status, "migration_required");
  assert.equal(plan.checks.some((check) => check.id === "storage-schema-version" && check.status === "warning"), true);
  assert.equal(plan.checks.some((check) => check.id === "storage-backend-kind" && check.status === "warning"), true);
});
