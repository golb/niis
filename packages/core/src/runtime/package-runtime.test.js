import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createInstallState,
  createInstallStateEntry,
  createPackageManifest,
} from "../contracts/packages.js";
import { writeInstallState } from "./install-state.js";
import {
  PackageRuntimeError,
  listActivatedRuntimePackages,
} from "./package-runtime.js";

function createFixture(t) {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-package-runtime-"));
  const stateRoot = path.join(packageRoot, ".niis");
  const installStatePath = path.join(stateRoot, "install-state.json");

  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "fixture-workspace", type: "module", version: "1.0.0" })}\n`,
  );
  t.after(() => {
    fs.rmSync(packageRoot, { force: true, recursive: true });
  });

  return {
    installStatePath,
    packageRoot,
    stateRoot,
  };
}

function createEntry({
  id,
  packageId,
  sourceRef,
  metadata = {},
  operations = [],
  sourceKind = "operator_cli",
  targetKind = "runtime_package",
}) {
  return createInstallStateEntry({
    displayName: id,
    id,
    metadata,
    operations,
    packageId,
    recordedAt: "2026-03-21T10:00:00.000Z",
    sourceKind,
    sourceRef,
    targetKind,
    version: "1.0.0",
  });
}

function writeFixtureInstallState(fixture, entries) {
  writeInstallState(
    fixture.installStatePath,
    createInstallState({
      commands: [],
      entries,
      installedAt: "2026-03-21T10:00:00.000Z",
      packageRoot: fixture.packageRoot,
      stateRoot: fixture.stateRoot,
    }),
  );
}

test("listActivatedRuntimePackages filters bootstrap and unrelated package entries before manifest parsing", (t) => {
  const fixture = createFixture(t);
  const roleManifest = createPackageManifest({
    activationStatus: "ACTIVE",
    id: "fixture-role",
    name: "Fixture Role",
    runtime: {
      definition_kind: "role_manifest",
      module_ref: "./fixture-role.js",
    },
    type: "role",
    version: "1.0.0",
  });
  writeFixtureInstallState(fixture, [
    createEntry({
      id: "workspace-package",
      packageId: "fixture-workspace",
      sourceKind: "builtin",
      sourceRef: "package.json",
      targetKind: "workspace_package",
    }),
    createEntry({
      id: "activation:plugin:malformed",
      metadata: {
        activation_status: "ACTIVE",
        manifest_type: "plugin",
        package_manifest: {
          activation_status: "ACTIVE",
          type: "plugin",
        },
      },
      operations: ["plugin_activation"],
      packageId: "malformed-plugin",
      sourceRef: "malformed-plugin.json",
      targetKind: "plugin",
    }),
    createEntry({
      id: "activation:runtime_package:inactive-malformed-role",
      metadata: {
        activation_status: "REVIEW",
        manifest_type: "role",
        package_manifest: {
          activation_status: "REVIEW",
          type: "role",
        },
      },
      operations: ["package_activation"],
      packageId: "inactive-malformed-role",
      sourceRef: "inactive-malformed-role.json",
    }),
    createEntry({
      id: "activation:runtime_package:fixture-role",
      metadata: {
        activation_status: "ACTIVE",
        manifest_type: "role",
        package_manifest: roleManifest,
      },
      operations: ["package_activation"],
      packageId: roleManifest.id,
      sourceRef: "fixture-role.json",
    }),
  ]);

  const packages = listActivatedRuntimePackages({
    installStatePath: fixture.installStatePath,
    packageRoot: fixture.packageRoot,
    packageTypes: ["role"],
  });

  assert.equal(packages.length, 1);
  assert.equal(packages[0].package_manifest.id, "fixture-role");
});

test("listActivatedRuntimePackages reports malformed selected manifests with structured diagnostics", (t) => {
  const fixture = createFixture(t);
  writeFixtureInstallState(fixture, [
    createEntry({
      id: "activation:runtime_package:broken-role",
      metadata: {
        activation_status: "ACTIVE",
        manifest_type: "role",
        package_manifest: {
          activation_status: "ACTIVE",
          id: "broken-role",
          type: "role",
        },
      },
      operations: ["package_activation"],
      packageId: "broken-role",
      sourceRef: "broken-role.json",
    }),
  ]);

  assert.throws(
    () => listActivatedRuntimePackages({
      installStatePath: fixture.installStatePath,
      packageRoot: fixture.packageRoot,
      packageTypes: ["role"],
    }),
    (error) => {
      assert.equal(error instanceof PackageRuntimeError, true);
      assert.equal(error.code, "PACKAGE_MANIFEST_INVALID");
      assert.equal(error.diagnostic.entry_id, "activation:runtime_package:broken-role");
      assert.equal(error.diagnostic.package_id, "broken-role");
      assert.equal(error.diagnostic.manifest_type, "role");
      assert.equal(error.diagnostic.phase, "parse");
      assert.equal(error.diagnostic.schema_name, "package_manifest");
      assert.equal(typeof error.diagnostic.reason, "string");
      assert.equal(error.diagnostic.validation_errors.length > 0, true);
      return true;
    },
  );
});
