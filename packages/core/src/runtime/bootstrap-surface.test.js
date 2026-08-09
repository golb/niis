import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  BootstrapStateCompatibilityError,
  collectDoctorChecks,
  createInitPlan,
  createStateTreeDigest,
  deriveBootstrapProjectId,
  initializeBootstrapState,
  resolveRuntimeCommand,
  resetBootstrapState,
} from "./bootstrap-surface.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const installRoot = path.resolve(__dirname, "..", "..", "..", "..");

test("initializeBootstrapState rolls back staged state when init fails mid-flight", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-init-fail-"));
  const existingStateRoot = path.join(workspaceRoot, ".niis");

  fs.mkdirSync(existingStateRoot, { recursive: true });
  fs.writeFileSync(path.join(existingStateRoot, "sentinel.txt"), "keep me\n");

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  assert.throws(
    () =>
      initializeBootstrapState(workspaceRoot, {
        failAfterStep: "backup_policy",
        installRoot,
      }),
    /simulated bootstrap failure/,
  );

  assert.equal(fs.existsSync(path.join(existingStateRoot, "sentinel.txt")), true);
  assert.equal(fs.existsSync(path.join(existingStateRoot, "install-state.json")), false);
});

test("initializeBootstrapState creates a usable bootstrap state root transactionally", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-init-ok-"));

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  const initialized = initializeBootstrapState(workspaceRoot, {
    installRoot,
  });
  const plan = createInitPlan(workspaceRoot);

  assert.equal(initialized.plan.stateRoot, plan.stateRoot);
  assert.equal(initialized.mode, "created");
  assert.equal(fs.existsSync(plan.installStatePath), true);
  assert.equal(fs.existsSync(plan.backupPolicyPath), true);
  assert.equal(fs.existsSync(plan.databasePath), true);
  assert.equal(fs.readFileSync(plan.stateIgnorePath, "utf8"), "*\n");
  assert.equal(fs.statSync(plan.stateIgnorePath).mode & 0o777, 0o600);

  assert.equal(spawnSync("git", ["init", "-q"], { cwd: workspaceRoot }).status, 0);
  assert.equal(
    spawnSync("git", ["check-ignore", "-q", ".niis/secrets/master.key"], {
      cwd: workspaceRoot,
    }).status,
    0,
  );
  assert.equal(spawnSync("git", ["add", "-A"], { cwd: workspaceRoot }).status, 0);
  assert.notEqual(
    spawnSync("git", ["ls-files", "--error-unmatch", ".niis/secrets/master.key"], {
      cwd: workspaceRoot,
    }).status,
    0,
  );
});

test("initializeBootstrapState is idempotent and preserves existing state byte-for-byte", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-idempotent-"));

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  const first = initializeBootstrapState(workspaceRoot, {
    installRoot,
    now: new Date("2026-07-23T09:00:00.000Z"),
  });
  fs.writeFileSync(path.join(first.plan.stateRoot, "project-config.json"), "{\"keep\":true}\n");
  fs.writeFileSync(first.plan.secretStorePath, JSON.stringify({
    created_at: "2026-07-23T09:00:00.000Z",
    schema_version: 1,
    secrets: {},
    updated_at: "2026-07-23T09:00:00.000Z",
  }, null, 2));
  const before = createStateTreeDigest(first.plan.stateRoot);

  const second = initializeBootstrapState(workspaceRoot, {
    installRoot,
    now: new Date("2027-01-01T00:00:00.000Z"),
  });
  const after = createStateTreeDigest(first.plan.stateRoot);

  assert.equal(second.mode, "verified");
  assert.deepEqual(second.repaired, []);
  assert.equal(after.sha256, before.sha256);
  assert.equal(fs.readFileSync(path.join(first.plan.stateRoot, "project-config.json"), "utf8"), "{\"keep\":true}\n");
});

test("initializeBootstrapState repairs only missing bootstrap artifacts", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-repair-"));

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  const initialized = initializeBootstrapState(workspaceRoot, { installRoot });
  const originalKey = fs.readFileSync(initialized.plan.secretMasterKeyPath);
  fs.rmSync(initialized.plan.stateIgnorePath);
  fs.rmSync(initialized.plan.backupPolicyPath);
  fs.rmSync(path.join(initialized.plan.stateRoot, "cache"), { recursive: true });

  const repaired = initializeBootstrapState(workspaceRoot, { installRoot });

  assert.equal(repaired.mode, "repaired");
  assert.equal(repaired.repaired.includes("backup-policy.json"), true);
  assert.equal(repaired.repaired.includes("cache"), true);
  assert.equal(repaired.repaired.includes(".gitignore"), true);
  assert.equal(fs.readFileSync(initialized.plan.stateIgnorePath, "utf8"), "*\n");
  assert.deepEqual(fs.readFileSync(initialized.plan.secretMasterKeyPath), originalKey);
});

test("initializeBootstrapState aborts incompatible state without mutation", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-incompatible-"));

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  const initialized = initializeBootstrapState(workspaceRoot, { installRoot });
  fs.writeFileSync(initialized.plan.installStatePath, "{invalid json\n");
  const before = createStateTreeDigest(initialized.plan.stateRoot);

  assert.throws(
    () => initializeBootstrapState(workspaceRoot, { installRoot }),
    BootstrapStateCompatibilityError,
  );
  assert.equal(createStateTreeDigest(initialized.plan.stateRoot).sha256, before.sha256);
});

test("initializeBootstrapState rejects a symlinked state root without touching its target", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-state-link-"));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-state-link-target-"));
  const sentinelPath = path.join(externalRoot, "sentinel.txt");
  fs.writeFileSync(sentinelPath, "external-state-must-remain-unchanged\n", {
    mode: 0o600,
  });
  const before = createStateTreeDigest(externalRoot);
  const stateRoot = path.join(workspaceRoot, ".niis");
  fs.symlinkSync(externalRoot, stateRoot, "dir");

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
    fs.rmSync(externalRoot, { force: true, recursive: true });
  });

  assert.throws(
    () => initializeBootstrapState(workspaceRoot, { installRoot }),
    (error) =>
      error instanceof BootstrapStateCompatibilityError
      && error.diagnostics.some((entry) => entry.id === "state-root-symlink"),
  );
  assert.equal(fs.lstatSync(stateRoot).isSymbolicLink(), true);
  assert.equal(createStateTreeDigest(externalRoot).sha256, before.sha256);
  assert.equal(
    fs.readFileSync(sentinelPath, "utf8"),
    "external-state-must-remain-unchanged\n",
  );
});

test("resetBootstrapState requires exact confirmation and a verified external backup", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-reset-"));
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-reset-backups-"));

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
    fs.rmSync(backupRoot, { force: true, recursive: true });
  });

  const initialized = initializeBootstrapState(workspaceRoot, { installRoot });
  fs.writeFileSync(path.join(initialized.plan.stateRoot, "sentinel.txt"), "recoverable\n");
  const projectId = deriveBootstrapProjectId(workspaceRoot);

  assert.throws(
    () => resetBootstrapState(workspaceRoot, {
      backupTo: backupRoot,
      confirmProjectId: "wrong-project",
    }),
    /exactly match/,
  );
  assert.equal(fs.existsSync(initialized.plan.stateRoot), true);

  const reset = resetBootstrapState(workspaceRoot, {
    backupTo: backupRoot,
    confirmProjectId: projectId,
    now: new Date("2026-07-23T09:30:00.000Z"),
  });

  assert.equal(fs.existsSync(initialized.plan.stateRoot), false);
  assert.equal(fs.existsSync(path.join(reset.backup_directory, "snapshot", "sentinel.txt")), true);
  assert.equal(fs.statSync(reset.backup_directory).mode & 0o777, 0o700);
  assert.equal(
    fs.statSync(path.join(reset.backup_directory, "snapshot")).mode & 0o777,
    0o700,
  );
  assert.equal(fs.statSync(reset.backup_manifest).mode & 0o777, 0o600);
  assert.equal(
    createStateTreeDigest(path.join(reset.backup_directory, "snapshot")).sha256,
    reset.source_tree_sha256,
  );
});

test("resetBootstrapState restores live state when staged deletion fails", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-reset-rollback-"));
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-reset-rollback-backups-"));

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
    fs.rmSync(backupRoot, { force: true, recursive: true });
  });

  const initialized = initializeBootstrapState(workspaceRoot, { installRoot });

  assert.throws(
    () => resetBootstrapState(workspaceRoot, {
      backupTo: backupRoot,
      confirmProjectId: deriveBootstrapProjectId(workspaceRoot),
      failAfterStep: "staged_removal",
    }),
    /simulated bootstrap failure/,
  );
  assert.equal(fs.existsSync(initialized.plan.stateRoot), true);
  assert.equal(fs.existsSync(initialized.plan.installStatePath), true);
});

test("resetBootstrapState rejects external paths that resolve through a symlink into live state", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-reset-link-"));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-reset-link-external-"));
  const initialized = initializeBootstrapState(workspaceRoot, { installRoot });
  const stateLink = path.join(externalRoot, "apparently-external");
  const sentinelPath = path.join(initialized.plan.stateRoot, "sentinel.txt");

  t.after(() => {
    fs.rmSync(externalRoot, { force: true, recursive: true });
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  fs.writeFileSync(sentinelPath, "live-state\n");
  fs.symlinkSync(initialized.plan.stateRoot, stateLink, "dir");

  assert.throws(
    () => resetBootstrapState(workspaceRoot, {
      backupTo: path.join(stateLink, "unsafe-backup-destination"),
      confirmProjectId: deriveBootstrapProjectId(workspaceRoot),
    }),
    /resolve outside the project workspace and live state/,
  );
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), "live-state\n");
  assert.equal(
    fs.existsSync(path.join(initialized.plan.stateRoot, "unsafe-backup-destination")),
    false,
  );
});

test("resetBootstrapState rejects a symlinked live state root without touching its target", (t) => {
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-bootstrap-reset-state-link-"),
  );
  const externalWorkspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-bootstrap-reset-state-target-"),
  );
  const backupRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-bootstrap-reset-state-backups-"),
  );
  const externalState = initializeBootstrapState(externalWorkspace, {
    installRoot,
  }).plan.stateRoot;
  const sentinelPath = path.join(externalState, "sentinel.txt");
  fs.writeFileSync(sentinelPath, "external reset target must survive\n");
  const before = createStateTreeDigest(externalState);
  const linkedStateRoot = path.join(workspaceRoot, ".niis");
  fs.symlinkSync(externalState, linkedStateRoot, "dir");

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
    fs.rmSync(externalWorkspace, { force: true, recursive: true });
    fs.rmSync(backupRoot, { force: true, recursive: true });
  });

  assert.throws(
    () => resetBootstrapState(workspaceRoot, {
      backupTo: backupRoot,
      confirmProjectId: deriveBootstrapProjectId(workspaceRoot),
    }),
    (error) =>
      error instanceof BootstrapStateCompatibilityError
      && error.diagnostics.some((entry) => entry.id === "state-root-symlink"),
  );
  assert.equal(fs.lstatSync(linkedStateRoot).isSymbolicLink(), true);
  assert.equal(createStateTreeDigest(externalState).sha256, before.sha256);
  assert.equal(
    fs.readFileSync(sentinelPath, "utf8"),
    "external reset target must survive\n",
  );
  assert.deepEqual(fs.readdirSync(backupRoot), []);
});

test("collectDoctorChecks includes runtime dependency and adapter availability diagnostics", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-doctor-"));

  try {
    const checks = collectDoctorChecks(
      installRoot,
      { workspaceRoot },
    );
    const byId = new Map(checks.map((check) => [check.id, check]));

    assert.equal(byId.has("runtime-dependency:better-sqlite3"), true);
    assert.equal(byId.has("adapter-availability:codex_local"), true);
    assert.equal(byId.has("adapter-availability:claude_code_local"), true);
    assert.equal(byId.has("git-command"), true);
    assert.equal(byId.get("git-workspace")?.status, "error");
    assert.equal(byId.has("runtime-sandbox"), true);
    assert.equal(byId.has("agent-runtime"), true);

    assert.equal(spawnSync("git", ["init", "--quiet", workspaceRoot]).status, 0);
    const initializedChecks = collectDoctorChecks(installRoot, { workspaceRoot });
    const initializedById = new Map(initializedChecks.map((check) => [check.id, check]));
    assert.equal(initializedById.get("git-workspace")?.status, "ok");
  } finally {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  }
});

test("resolveRuntimeCommand applies the same executable lookup used by doctor and intake", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-runtime-command-"));
  const executable = path.join(root, "sample-runtime");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  assert.equal(resolveRuntimeCommand({ commandNames: ["sample-runtime"], environment: { PATH: root } }), executable);
  assert.equal(resolveRuntimeCommand({ envKey: "RUNTIME_BIN", environment: { RUNTIME_BIN: executable } }), executable);
  assert.equal(resolveRuntimeCommand({ envKey: "RUNTIME_BIN", environment: { RUNTIME_BIN: path.join(root, "missing") } }), null);
});
