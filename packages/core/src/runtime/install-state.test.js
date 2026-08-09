import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_INSTALL_COMMANDS,
  collectInstallStateChecks,
  createActivationInstallStateEntry,
  createBootstrapInstallState,
  readInstallState,
  recordActivationInstallState,
  writeInstallState,
} from "./install-state.js";
import { createPackageManifest } from "../contracts/packages.js";

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-install-state-"));
  const packageRoot = path.join(root, "niis");
  const stateRoot = path.join(packageRoot, ".niis");

  fs.mkdirSync(path.join(packageRoot, "packages", "core"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "packages", "cli", "bin"), { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "niis-workspace",
    version: "0.1.0",
    type: "module",
  }, null, 2));
  fs.writeFileSync(path.join(packageRoot, "packages", "core", "package.json"), JSON.stringify({
    name: "@niis/core",
    version: "0.1.0",
    type: "module",
  }, null, 2));
  fs.writeFileSync(path.join(packageRoot, "packages", "cli", "package.json"), JSON.stringify({
    name: "@niis/cli",
    version: "0.1.0",
    type: "module",
  }, null, 2));
  fs.writeFileSync(path.join(packageRoot, "packages", "cli", "bin", "niis.js"), "#!/usr/bin/env node\n");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  return {
    installStatePath: path.join(stateRoot, "install-state.json"),
    packageRoot,
    stateRoot,
  };
}

test("collectInstallStateChecks reports ok for a fresh bootstrap install-state baseline", (t) => {
  const fixture = createFixture(t);
  const installState = createBootstrapInstallState({
    databasePath: path.join(fixture.stateRoot, "db", "niis.sqlite"),
    packageRoot: fixture.packageRoot,
    stateRoot: fixture.stateRoot,
  });

  writeInstallState(fixture.installStatePath, installState);
  const checks = collectInstallStateChecks(fixture.packageRoot, {
    installStatePath: fixture.installStatePath,
  });

  assert.equal(checks.every((check) => check.status === "ok"), true);
});

test("Reliability RC install metadata does not advertise retired restore", (t) => {
  const fixture = createFixture(t);
  const installState = createBootstrapInstallState({
    databasePath: path.join(fixture.stateRoot, "db", "niis.sqlite"),
    packageRoot: fixture.packageRoot,
    stateRoot: fixture.stateRoot,
  });

  assert.equal(DEFAULT_INSTALL_COMMANDS.includes("restore"), false);
  assert.equal(installState.commands.includes("restore"), false);
});

test("collectInstallStateChecks detects drift when a tracked file changes", (t) => {
  const fixture = createFixture(t);
  const installState = createBootstrapInstallState({
    databasePath: path.join(fixture.stateRoot, "db", "niis.sqlite"),
    packageRoot: fixture.packageRoot,
    stateRoot: fixture.stateRoot,
  });

  writeInstallState(fixture.installStatePath, installState);
  fs.writeFileSync(path.join(fixture.packageRoot, "packages", "cli", "bin", "niis.js"), "# changed\n");

  const checks = collectInstallStateChecks(fixture.packageRoot, {
    installStatePath: fixture.installStatePath,
  });
  const cliCheck = checks.find((check) => check.entry_id === "cli-command-surface");

  assert.equal(cliCheck?.status, "warning");
  assert.match(cliCheck?.details ?? "", /drifted/);
});

test("collectInstallStateChecks warns when no immutable install-state exists yet", (t) => {
  const fixture = createFixture(t);
  const checks = collectInstallStateChecks(fixture.packageRoot, {
    installStatePath: fixture.installStatePath,
  });

  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, "warning");
});

test("createActivationInstallStateEntry tracks local activation files for workspace packages", (t) => {
  const fixture = createFixture(t);
  const sourceRef = path.join(fixture.packageRoot, "extensions", "review-skill", "package.json");

  fs.mkdirSync(path.dirname(sourceRef), { recursive: true });
  fs.writeFileSync(sourceRef, JSON.stringify({ name: "@niis/review-skill" }, null, 2));

  const entry = createActivationInstallStateEntry({
    candidateKind: "package",
    packageManifest: createPackageManifest({
      activationStatus: "ACTIVE",
      capabilities: ["review"],
      compatibility: {
        min_niis_version: "0.1.0",
        max_niis_version: null,
        required_adapters: [],
      },
      id: "pkg-review-skill",
      name: "Review Skill",
      type: "skill",
      version: "0.1.0",
    }),
    packageRoot: fixture.packageRoot,
    sourceKind: "local_filesystem",
    sourceRef,
  });

  assert.equal(entry.target_kind, "runtime_package");
  assert.equal(entry.files.length, 1);
  assert.equal(entry.files[0].path, "extensions/review-skill/package.json");
});

test("createActivationInstallStateEntry treats plugin manifests as plugin targets even without candidateKind override", (t) => {
  const fixture = createFixture(t);
  const sourceRef = path.join(fixture.packageRoot, "extensions", "obs-plugin", "package.json");

  fs.mkdirSync(path.dirname(sourceRef), { recursive: true });
  fs.writeFileSync(sourceRef, JSON.stringify({ name: "@niis/obs-plugin" }, null, 2));

  const entry = createActivationInstallStateEntry({
    candidateKind: "package",
    now: new Date("2026-04-02T11:30:00.000Z"),
    packageManifest: createPackageManifest({
      activationStatus: "ACTIVE",
      capabilities: ["observability"],
      id: "pkg-obs-plugin",
      name: "Obs Plugin",
      type: "plugin",
      version: "0.1.0",
    }),
    packageRoot: fixture.packageRoot,
    sourceKind: "local_filesystem",
    sourceRef,
  });

  assert.equal(entry.target_kind, "plugin");
});

test("recordActivationInstallState appends immutable activation records for packages and plugins", (t) => {
  const fixture = createFixture(t);
  const baseline = createBootstrapInstallState({
    databasePath: path.join(fixture.stateRoot, "db", "niis.sqlite"),
    packageRoot: fixture.packageRoot,
    stateRoot: fixture.stateRoot,
  });
  const sourceRef = path.join(fixture.packageRoot, "extensions", "metrics-plugin", "package.json");

  fs.mkdirSync(path.dirname(sourceRef), { recursive: true });
  fs.writeFileSync(sourceRef, JSON.stringify({ name: "@niis/metrics-plugin" }, null, 2));
  writeInstallState(fixture.installStatePath, baseline);

  const packageRecord = recordActivationInstallState({
    candidateKind: "plugin",
    installStatePath: fixture.installStatePath,
    packageManifest: createPackageManifest({
      activationStatus: "ACTIVE",
      capabilities: ["review"],
      compatibility: {
        min_niis_version: "0.1.0",
        max_niis_version: null,
        required_adapters: [],
      },
      id: "pkg-metrics-plugin",
      name: "Metrics Plugin",
      type: "skill",
      version: "0.2.0",
    }),
    packageRoot: fixture.packageRoot,
    sourceKind: "registry",
    sourceRef: "registry://metrics-plugin",
  });

  assert.equal(packageRecord.install_state_entry.target_kind, "plugin");
  assert.equal(packageRecord.install_state_entry.files.length, 0);

  const workspaceRecord = recordActivationInstallState({
    candidateKind: "package",
    installStatePath: fixture.installStatePath,
    packageManifest: createPackageManifest({
      activationStatus: "ACTIVE",
      capabilities: ["review"],
      compatibility: {
        min_niis_version: "0.1.0",
        max_niis_version: null,
        required_adapters: [],
      },
      id: "pkg-review-skill",
      name: "Review Skill",
      type: "skill",
      version: "0.1.0",
    }),
    packageRoot: fixture.packageRoot,
    sourceKind: "local_filesystem",
    sourceRef,
  });
  const installState = readInstallState(fixture.installStatePath);

  assert.equal(workspaceRecord.install_state_entry.target_kind, "runtime_package");
  assert.equal(
    installState.entries.some((entry) => entry.id === "activation:plugin:pkg-metrics-plugin"),
    true,
  );
  assert.equal(
    installState.entries.some((entry) => entry.id === "activation:runtime_package:pkg-review-skill"),
    true,
  );
});
