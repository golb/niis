import test from "node:test";
import assert from "node:assert/strict";

import {
  STORAGE_CONTRACT_VERSION,
  createStorageBackendDescriptor,
  evaluateStorageBackendCompatibility,
} from "./storage.js";

function createHostedBackend(overrides = {}) {
  return createStorageBackendDescriptor({
    backendId: overrides.backendId ?? "hosted-preview",
    displayName: overrides.displayName ?? "Hosted Preview",
    kind: overrides.kind ?? "hosted_service",
    contractVersion: overrides.contractVersion ?? STORAGE_CONTRACT_VERSION,
    queryPorts: overrides.queryPorts,
    schemaVersion: overrides.schemaVersion ?? null,
    supportedSchemaVersions: overrides.supportedSchemaVersions ?? ["1"],
    writePorts: overrides.writePorts,
    concurrencySemantics: overrides.concurrencySemantics ?? {},
    migrationCapabilities: overrides.migrationCapabilities ?? {
      snapshotImport: true,
      snapshotExport: true,
    },
  });
}

test("createStorageBackendDescriptor normalizes migration-ready backend artifacts", () => {
  const backend = createHostedBackend();

  assert.equal(backend.kind, "hosted_service");
  assert.equal(backend.contract_version, STORAGE_CONTRACT_VERSION);
  assert.deepEqual(backend.supported_schema_versions, ["1"]);
  assert.equal(backend.migration_capabilities.snapshot_import, true);
});

test("evaluateStorageBackendCompatibility preserves contract compatibility across a planned backend transition", () => {
  const plan = evaluateStorageBackendCompatibility({
    planId: "storage-plan-compatible",
    sourceBackend: createStorageBackendDescriptor({
      backendId: "sqlite-local",
      displayName: "Local SQLite",
      kind: "sqlite_local",
      schemaVersion: "1",
    }),
    targetBackend: createHostedBackend(),
  });

  assert.equal(plan.compatibility_status, "migration_required");
  assert.equal(plan.checks.some((check) => check.id === "storage-contract-version" && check.status === "ok"), true);
  assert.equal(plan.checks.some((check) => check.id === "storage-schema-version" && check.status === "ok"), true);
});

test("evaluateStorageBackendCompatibility blocks target backends that break the query contract", () => {
  const plan = evaluateStorageBackendCompatibility({
    planId: "storage-plan-blocked",
    sourceBackend: createStorageBackendDescriptor({
      backendId: "sqlite-local",
      displayName: "Local SQLite",
      kind: "sqlite_local",
      schemaVersion: "1",
    }),
    targetBackend: createHostedBackend({
      queryPorts: ["tasks.list"],
    }),
  });

  assert.equal(plan.compatibility_status, "blocked");
  assert.equal(plan.blocked_by.includes("storage_query_ports_missing"), true);
});

test("evaluateStorageBackendCompatibility requires schema migration when target does not accept current schema version", () => {
  const plan = evaluateStorageBackendCompatibility({
    planId: "storage-plan-schema-migration",
    sourceBackend: createStorageBackendDescriptor({
      backendId: "sqlite-local",
      displayName: "Local SQLite",
      kind: "sqlite_local",
      schemaVersion: "1",
    }),
    targetBackend: createHostedBackend({
      supportedSchemaVersions: ["2"],
    }),
  });

  assert.equal(plan.compatibility_status, "migration_required");
  assert.equal(plan.checks.some((check) => check.id === "storage-schema-version" && check.status === "warning"), true);
  assert.equal(
    plan.operator_guidance.some((line) => line.includes("Apply a storage schema migration from 1")),
    true,
  );
});
