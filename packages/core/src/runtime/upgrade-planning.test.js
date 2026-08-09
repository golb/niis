import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBootstrapInstallState, writeInstallState } from "./install-state.js";
import { evaluateReleaseUpgradePlan } from "./upgrade-planning.js";
import { createSqliteDatabasePath, createSqliteStorage } from "../storage/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..", "..", "..", "..");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-upgrade-plan-"));
  const stateRoot = path.join(root, ".niis");
  const databasePath = createSqliteDatabasePath(stateRoot);
  const installStatePath = path.join(stateRoot, "install-state.json");
  const sqliteStorage = createSqliteStorage({ databasePath });

  sqliteStorage.close();

  writeInstallState(
    installStatePath,
    createBootstrapInstallState({
      databasePath,
      packageRoot,
      stateRoot,
    }),
  );

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  return {
    databasePath,
    installStatePath,
    root,
    stateRoot,
  };
}

test("evaluateReleaseUpgradePlan returns migration_required for reviewed storage transition preflight", (t) => {
  const fixture = createFixture(t);
  const installStateBefore = fs.readFileSync(fixture.installStatePath, "utf8");
  const databaseBefore = fs.readFileSync(fixture.databasePath);
  const plan = evaluateReleaseUpgradePlan({
    installStatePath: fixture.installStatePath,
    packageRoot,
    releaseBundle: {
      bundleId: "bundle-core-0.2.0",
      compatibility: {
        min_niis_version: "0.1.0",
        required_adapters: [],
      },
      fileRefs: ["package.json"],
      migrationRefs: ["migrations/0002.sql"],
      packageId: "@niis/core",
      version: "0.2.0",
    },
    storageTargetBackend: {
      backendId: "hosted-preview",
      displayName: "Hosted Preview",
      kind: "hosted_service",
      migrationCapabilities: {
        snapshotImport: true,
      },
      supportedSchemaVersions: ["2"],
    },
  });

  assert.equal(plan.compatibility_status, "migration_required");
  assert.equal(plan.blocked_by.length, 0);
  assert.equal(plan.storage_plan?.compatibility_status, "migration_required");
  assert.equal(plan.readonly_preflight, true);
  assert.equal(
    plan.check_results.some((check) => check.id === "storage-preflight" && check.status === "warning"),
    true,
  );
  assert.equal(fs.readFileSync(fixture.installStatePath, "utf8"), installStateBefore);
  assert.deepEqual(fs.readFileSync(fixture.databasePath), databaseBefore);
});

test("evaluateReleaseUpgradePlan blocks when migration is required but reviewed migration refs are missing", (t) => {
  const fixture = createFixture(t);
  const plan = evaluateReleaseUpgradePlan({
    installStatePath: fixture.installStatePath,
    packageRoot,
    releaseBundle: {
      bundleId: "bundle-core-0.2.0",
      compatibility: {
        min_niis_version: "0.1.0",
        required_adapters: [],
      },
      fileRefs: ["package.json"],
      packageId: "@niis/core",
      version: "0.2.0",
    },
    storageTargetBackend: {
      backendId: "hosted-preview",
      displayName: "Hosted Preview",
      kind: "hosted_service",
      migrationCapabilities: {
        snapshotImport: true,
      },
      supportedSchemaVersions: ["2"],
    },
  });

  assert.equal(plan.compatibility_status, "blocked");
  assert.equal(plan.blocked_by.includes("upgrade_migration_refs_missing"), true);
  assert.equal(
    plan.check_results.some((check) => check.id === "upgrade-migration-refs" && check.status === "error"),
    true,
  );
});
