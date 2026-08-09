import fs from "node:fs";
import path from "node:path";

class BackupStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupStorageError";
  }
}

const BACKUP_POLICY_FILENAME = "backup-policy.json";
const BACKUP_MANIFEST_FILENAME = "manifest.json";
const DEFAULT_BACKUP_RETENTION_DAYS = 30;
const DEFAULT_BACKUP_FRESHNESS_WARNING_DAYS = 30;

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BackupStorageError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePositiveInteger(value, label, defaultValue) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new BackupStorageError(`${label} must be a positive integer`);
  }

  return value;
}

function createBackupPolicy({
  retentionDays = DEFAULT_BACKUP_RETENTION_DAYS,
  freshnessWarningDays = DEFAULT_BACKUP_FRESHNESS_WARNING_DAYS,
} = {}) {
  return Object.freeze({
    freshness_warning_days: ensurePositiveInteger(
      freshnessWarningDays,
      "freshnessWarningDays",
      DEFAULT_BACKUP_FRESHNESS_WARNING_DAYS,
    ),
    retention_days: ensurePositiveInteger(
      retentionDays,
      "retentionDays",
      DEFAULT_BACKUP_RETENTION_DAYS,
    ),
    schema_version: 1,
  });
}

function createBackupPaths(stateRoot) {
  const normalizedStateRoot = path.resolve(ensureNonEmptyString(stateRoot, "stateRoot"));
  return Object.freeze({
    backupPolicyPath: path.join(normalizedStateRoot, BACKUP_POLICY_FILENAME),
    backupsRoot: path.join(normalizedStateRoot, "backups"),
    stateRoot: normalizedStateRoot,
  });
}

function writeBackupPolicy(stateRoot, policy = {}) {
  const paths = createBackupPaths(stateRoot);
  const normalizedPolicy = createBackupPolicy(policy);

  fs.mkdirSync(paths.stateRoot, { recursive: true });
  fs.writeFileSync(paths.backupPolicyPath, `${JSON.stringify(normalizedPolicy, null, 2)}\n`);
  return normalizedPolicy;
}

function readBackupPolicy(stateRoot) {
  const paths = createBackupPaths(stateRoot);

  if (!fs.existsSync(paths.backupPolicyPath)) {
    return createBackupPolicy();
  }

  try {
    const rawPolicy = JSON.parse(fs.readFileSync(paths.backupPolicyPath, "utf8"));
    return createBackupPolicy({
      freshnessWarningDays: rawPolicy.freshness_warning_days ?? rawPolicy.freshnessWarningDays,
      retentionDays: rawPolicy.retention_days ?? rawPolicy.retentionDays,
    });
  } catch (error) {
    throw new BackupStorageError(`Backup policy is invalid JSON: ${error.message}`);
  }
}

function sanitizeTimestampForPath(timestamp) {
  return timestamp.replace(/[:.]/g, "-");
}

function createBackupId(now = new Date()) {
  const timestamp = new Date(now);

  if (Number.isNaN(timestamp.getTime())) {
    throw new BackupStorageError("now must be a valid timestamp");
  }

  return `backup-${sanitizeTimestampForPath(timestamp.toISOString())}`;
}

function listRelativeFiles(rootDirectory) {
  const files = [];

  function visit(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(rootDirectory, absolutePath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        const stats = fs.statSync(absolutePath);
        files.push({
          path: relativePath,
          size_bytes: stats.size,
        });
      }
    }
  }

  visit(rootDirectory);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function listBackups(stateRoot) {
  const { backupsRoot } = createBackupPaths(stateRoot);

  if (!fs.existsSync(backupsRoot)) {
    return [];
  }

  return fs.readdirSync(backupsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const backupPath = path.join(backupsRoot, entry.name);
      const manifestPath = path.join(backupPath, BACKUP_MANIFEST_FILENAME);

      if (!fs.existsSync(manifestPath)) {
        return null;
      }

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        return {
          backup_id: manifest.backup_id ?? entry.name,
          backup_path: backupPath,
          created_at: manifest.created_at,
          manifest,
          manifest_path: manifestPath,
          snapshot_path: path.join(backupPath, "snapshot"),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
}

function pruneExpiredBackups(stateRoot, { now = new Date(), retentionDays } = {}) {
  const policy = createBackupPolicy({
    retentionDays: retentionDays ?? readBackupPolicy(stateRoot).retention_days,
  });
  const threshold = Date.parse(new Date(now).toISOString()) - (policy.retention_days * 24 * 60 * 60 * 1000);
  const pruned = [];

  for (const backup of listBackups(stateRoot)) {
    if (Date.parse(backup.created_at) >= threshold) {
      continue;
    }

    fs.rmSync(backup.backup_path, { force: true, recursive: true });
    pruned.push({
      backup_id: backup.backup_id,
      created_at: backup.created_at,
    });
  }

  return pruned;
}

function performBackup(stateRoot, { now = new Date(), retentionDays = null } = {}) {
  const paths = createBackupPaths(stateRoot);

  if (!fs.existsSync(paths.stateRoot)) {
    throw new BackupStorageError(`State root does not exist: ${paths.stateRoot}`);
  }

  fs.mkdirSync(paths.backupsRoot, { recursive: true });

  const backupId = createBackupId(now);
  const backupDirectory = path.join(paths.backupsRoot, backupId);
  const snapshotPath = path.join(backupDirectory, "snapshot");

  fs.mkdirSync(snapshotPath, { recursive: true });

  for (const entry of fs.readdirSync(paths.stateRoot, { withFileTypes: true })) {
    if (entry.name === "backups") {
      continue;
    }

    const sourcePath = path.join(paths.stateRoot, entry.name);
    const targetPath = path.join(snapshotPath, entry.name);
    fs.cpSync(sourcePath, targetPath, { recursive: true });
  }

  const createdAt = new Date(now).toISOString();
  const manifest = {
    backup_id: backupId,
    created_at: createdAt,
    file_count: listRelativeFiles(snapshotPath).length,
    files: listRelativeFiles(snapshotPath),
    retention_days:
      retentionDays ?? readBackupPolicy(paths.stateRoot).retention_days,
    schema_version: 1,
    snapshot_path: snapshotPath,
    source_state_root: paths.stateRoot,
  };

  fs.writeFileSync(
    path.join(backupDirectory, BACKUP_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const pruned = pruneExpiredBackups(paths.stateRoot, {
    now,
    retentionDays: manifest.retention_days,
  });

  return {
    backup_id: backupId,
    backup_path: backupDirectory,
    created_at: createdAt,
    manifest,
    pruned,
  };
}

function collectBackupHealthChecks(stateRoot, { now = new Date() } = {}) {
  const paths = createBackupPaths(stateRoot);
  const policy = readBackupPolicy(paths.stateRoot);
  const backups = listBackups(paths.stateRoot);

  if (!fs.existsSync(paths.backupsRoot)) {
    return [{
      id: "backup-root",
      status: "warning",
      summary: paths.backupsRoot,
      details: "No backups directory exists yet; run `niis backup` to create the first recovery point.",
    }];
  }

  if (backups.length === 0) {
    return [{
      id: "backup-freshness",
      status: "warning",
      summary: paths.backupsRoot,
      details: "Backups directory exists, but no backup manifests were found yet.",
    }];
  }

  const latestBackup = backups[backups.length - 1];
  const ageMs = Date.parse(new Date(now).toISOString()) - Date.parse(latestBackup.created_at);
  const thresholdMs = policy.freshness_warning_days * 24 * 60 * 60 * 1000;

  return [{
    id: "backup-freshness",
    status: ageMs > thresholdMs ? "warning" : "ok",
    summary: latestBackup.created_at,
    details:
      ageMs > thresholdMs
        ? `Latest backup ${latestBackup.backup_id} is older than the configured freshness threshold (${policy.freshness_warning_days} days).`
        : `Latest backup ${latestBackup.backup_id} is within the configured freshness threshold (${policy.freshness_warning_days} days).`,
  }];
}

export {
  BACKUP_MANIFEST_FILENAME,
  BACKUP_POLICY_FILENAME,
  BackupStorageError,
  DEFAULT_BACKUP_FRESHNESS_WARNING_DAYS,
  DEFAULT_BACKUP_RETENTION_DAYS,
  collectBackupHealthChecks,
  createBackupId,
  createBackupPaths,
  createBackupPolicy,
  listBackups,
  performBackup,
  pruneExpiredBackups,
  readBackupPolicy,
  writeBackupPolicy,
};
