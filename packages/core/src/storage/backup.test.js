import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as coreApi from "../index.js";
import * as backupApi from "./backup.js";
import {
  BACKUP_MANIFEST_FILENAME,
  collectBackupHealthChecks,
  createBackupPaths,
  listBackups,
  performBackup,
  readBackupPolicy,
  writeBackupPolicy,
} from "./backup.js";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("performBackup writes a snapshot manifest and prunes expired backups under retention policy", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-backup-"));
  const stateRoot = path.join(tempRoot, ".niis");
  const backupPaths = createBackupPaths(stateRoot);

  fs.mkdirSync(path.join(stateRoot, "db"), { recursive: true });
  fs.mkdirSync(path.join(stateRoot, "exports"), { recursive: true });
  writeFile(path.join(stateRoot, "db", "niis-v1.sqlite"), "sqlite-bytes");
  writeFile(path.join(stateRoot, "exports", "workflow.md"), "# workflow");
  writeBackupPolicy(stateRoot, {
    retentionDays: 1,
    freshnessWarningDays: 2,
  });

  const staleBackupRoot = path.join(backupPaths.backupsRoot, "backup-old");
  const staleSnapshotRoot = path.join(staleBackupRoot, "snapshot");
  fs.mkdirSync(staleSnapshotRoot, { recursive: true });
  fs.writeFileSync(path.join(staleBackupRoot, BACKUP_MANIFEST_FILENAME), `${JSON.stringify({
    backup_id: "backup-old",
    created_at: "2026-03-25T00:00:00.000Z",
    file_count: 0,
    files: [],
    retention_days: 1,
    schema_version: 1,
    snapshot_path: staleSnapshotRoot,
    source_state_root: stateRoot,
  }, null, 2)}\n`);

  const result = performBackup(stateRoot, {
    now: "2026-04-01T18:45:00.000Z",
  });

  assert.equal(result.manifest.retention_days, 1);
  assert.ok(fs.existsSync(path.join(result.backup_path, BACKUP_MANIFEST_FILENAME)));
  assert.ok(fs.existsSync(path.join(result.backup_path, "snapshot", "db", "niis-v1.sqlite")));
  assert.equal(result.pruned.length, 1);
  assert.equal(result.pruned[0].backup_id, "backup-old");
  assert.equal(listBackups(stateRoot).length, 1);
  assert.equal(readBackupPolicy(stateRoot).freshness_warning_days, 2);
});

test("backup health reports freshness correctly", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-backup-health-"));
  const stateRoot = path.join(tempRoot, ".niis");

  fs.mkdirSync(path.join(stateRoot, "db"), { recursive: true });
  writeFile(path.join(stateRoot, "db", "niis-v1.sqlite"), "v1");
  writeBackupPolicy(stateRoot, {
    retentionDays: 30,
    freshnessWarningDays: 1,
  });

  const backup = performBackup(stateRoot, {
    now: "2026-04-01T18:50:00.000Z",
  });

  assert.ok(fs.existsSync(backup.backup_path));

  const okChecks = collectBackupHealthChecks(stateRoot, {
    now: "2026-04-02T10:00:00.000Z",
  });
  const staleChecks = collectBackupHealthChecks(stateRoot, {
    now: "2026-04-05T10:00:00.000Z",
  });

  assert.equal(okChecks[0].status, "ok");
  assert.equal(staleChecks[0].status, "warning");
});

test("Reliability RC public core API has no destructive in-place restore primitive", () => {
  assert.equal(Object.hasOwn(backupApi, "restoreBackup"), false);
  assert.equal(Object.hasOwn(coreApi.storage, "restoreBackup"), false);
});
