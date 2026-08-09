import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  ACTIVE_ATTEMPT_STAGES,
  PromotionStatus,
  PromotionTargetKind,
  assertAttemptStageTransition,
  createPromotionRecord,
  createTaskAttempt,
  isPromotionAllowed,
  isTerminalAttemptStage,
  parsePromotionRecord,
  parseTaskAttempt,
} from "../contracts/task-attempt.js";
import {
  DURABLE_QUEUE_STATES,
  DurableQueueState,
  QueueProjectionOperation,
  parseDurableQueueEntry,
  parseQueueProjectionEvent,
} from "../scheduler/queue-projection.js";

class LifecycleSqliteError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "LifecycleSqliteError";
    this.code = options.code ?? "lifecycle_sqlite_error";
  }
}

class AttemptConcurrencyError extends LifecycleSqliteError {
  constructor(message) {
    super(message, { code: "attempt_concurrency_conflict" });
    this.name = "AttemptConcurrencyError";
  }
}

class AttemptLeaseConflictError extends LifecycleSqliteError {
  constructor(message, options = {}) {
    super(message, { code: "attempt_lease_conflict" });
    this.name = "AttemptLeaseConflictError";
    this.holder = options.holder ?? null;
    this.expiresAt = options.expiresAt ?? null;
  }
}

class ExecutionLeaseConflictError extends LifecycleSqliteError {
  constructor(message, options = {}) {
    super(message, { code: "execution_lease_conflict" });
    this.name = "ExecutionLeaseConflictError";
    this.scope = options.scope ?? null;
    this.holder = options.holder ?? null;
    this.pid = options.pid ?? null;
    this.expiresAt = options.expiresAt ?? null;
    this.reason = options.reason ?? "held_by_other";
  }
}

const LIFECYCLE_SQLITE_SCHEMA_VERSION = 2;
const LIFECYCLE_SCHEMA_METADATA_KEY = "task_lifecycle_schema_version";
const REQUIRED_LIFECYCLE_TABLES = Object.freeze({
  task_attempts: Object.freeze([
    "id",
    "task_id",
    "trigger",
    "engine_version",
    "stage",
    "canonical_verdict",
    "version",
    "lease_holder",
    "lease_expires_at",
    "heartbeat_at",
    "created_at",
    "updated_at",
    "finished_at",
    "payload",
  ]),
  task_attempt_steps: Object.freeze([
    "attempt_id",
    "stage",
    "idempotency_key",
    "status",
    "started_at",
    "completed_at",
    "payload",
  ]),
  task_promotions: Object.freeze([
    "id",
    "attempt_id",
    "task_id",
    "status",
    "version",
    "created_at",
    "updated_at",
    "payload",
  ]),
  lifecycle_queue: Object.freeze([
    "task_id",
    "state",
    "priority",
    "available_at",
    "claimed_by",
    "claim_expires_at",
    "version",
    "created_at",
    "updated_at",
    "payload",
  ]),
  queue_projection_outbox: Object.freeze([
    "sequence_id",
    "event_id",
    "task_id",
    "operation",
    "created_at",
    "delivered_at",
    "delivery_attempts",
    "last_error",
    "payload",
  ]),
  execution_leases: Object.freeze([
    "scope",
    "holder",
    "pid",
    "acquired_at",
    "heartbeat_at",
    "expires_at",
    "version",
    "metadata",
  ]),
});

function clone(value) {
  return structuredClone(value);
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LifecycleSqliteError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LifecycleSqliteError(`${label} must be a plain object`);
  }

  return value;
}

function toIsoTimestamp(value, label = "timestamp") {
  const normalized = value instanceof Date ? value.toISOString() : value;

  if (typeof normalized !== "string" || Number.isNaN(Date.parse(normalized))) {
    throw new LifecycleSqliteError(`${label} must be an ISO 8601 timestamp`);
  }

  return new Date(normalized).toISOString();
}

function addMilliseconds(timestamp, milliseconds, label = "ttlMs") {
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
    throw new LifecycleSqliteError(`${label} must be a positive integer`);
  }

  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function ensurePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new LifecycleSqliteError(`${label} must be a positive integer`);
  }

  return value;
}

function inspectProcessLiveness(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") {
      return "dead";
    }
    if (error?.code === "EPERM") {
      return "alive";
    }
    return "unknown";
  }
}

function normalizeProcessLiveness(value) {
  if (value === true) return "alive";
  if (value === false) return "dead";
  if (["alive", "dead", "unknown"].includes(value)) return value;
  return "unknown";
}

function serializeJson(value, label) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new LifecycleSqliteError(`${label} must be JSON serializable: ${error.message}`);
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new LifecycleSqliteError(`failed to parse ${label}: ${error.message}`);
  }
}

function normalizeDatabasePath(databasePath) {
  return path.resolve(ensureNonEmptyString(databasePath, "databasePath"));
}

function listTables(database) {
  return new Set(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => row.name),
  );
}

function listTableColumns(database, tableName) {
  return new Set(
    database.prepare(`PRAGMA table_info(${tableName})`).all()
      .map((row) => row.name),
  );
}

function readStoredLifecycleVersion(database) {
  if (!listTables(database).has("metadata")) {
    return null;
  }

  return database.prepare(
    "SELECT value FROM metadata WHERE key = ?",
  ).get(LIFECYCLE_SCHEMA_METADATA_KEY)?.value ?? null;
}

function assertWritableLifecycleVersion(database) {
  const currentVersion = readStoredLifecycleVersion(database);

  if (currentVersion === null) {
    return;
  }

  const parsedVersion = Number.parseInt(currentVersion, 10);
  if (
    !Number.isInteger(parsedVersion)
    || String(parsedVersion) !== currentVersion
    || parsedVersion > LIFECYCLE_SQLITE_SCHEMA_VERSION
  ) {
    throw new LifecycleSqliteError(
      `lifecycle schema version ${currentVersion} cannot be opened by version ${LIFECYCLE_SQLITE_SCHEMA_VERSION}`,
      { code: "lifecycle_schema_incompatible" },
    );
  }
}

function assertLifecycleTables(database) {
  const tables = listTables(database);
  const missing = [];

  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_LIFECYCLE_TABLES)) {
    if (!tables.has(tableName)) {
      missing.push(tableName);
      continue;
    }

    const columns = listTableColumns(database, tableName);
    for (const columnName of requiredColumns) {
      if (!columns.has(columnName)) {
        missing.push(`${tableName}.${columnName}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new LifecycleSqliteError(
      `lifecycle schema is missing required surfaces: ${missing.join(", ")}`,
      { code: "lifecycle_schema_incompatible" },
    );
  }
}

function initializeLifecycleSchema(database) {
  const activeStageSql = ACTIVE_ATTEMPT_STAGES.map((stage) => `'${stage}'`).join(", ");

  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      stage TEXT NOT NULL,
      canonical_verdict TEXT,
      version INTEGER NOT NULL,
      lease_holder TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_attempts_task
      ON task_attempts(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_attempts_stage
      ON task_attempts(stage, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_one_active_per_task
      ON task_attempts(task_id)
      WHERE stage IN (${activeStageSql});

    CREATE TABLE IF NOT EXISTS task_attempt_steps (
      attempt_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      payload TEXT NOT NULL,
      PRIMARY KEY (attempt_id, stage)
    );
    CREATE INDEX IF NOT EXISTS idx_task_attempt_steps_attempt
      ON task_attempt_steps(attempt_id);

    CREATE TABLE IF NOT EXISTS task_promotions (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_promotions_task
      ON task_promotions(task_id, created_at);

    CREATE TABLE IF NOT EXISTS lifecycle_queue (
      task_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      priority INTEGER,
      available_at TEXT NOT NULL,
      claimed_by TEXT,
      claim_expires_at TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_queue_dispatch
      ON lifecycle_queue(state, priority, available_at, created_at);

    CREATE TABLE IF NOT EXISTS queue_projection_outbox (
      sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_queue_projection_outbox_pending
      ON queue_projection_outbox(delivered_at, sequence_id);

    CREATE TABLE IF NOT EXISTS execution_leases (
      scope TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      pid INTEGER NOT NULL,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      version INTEGER NOT NULL,
      metadata TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_leases_expiry
      ON execution_leases(expires_at);
  `);

  database.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(metadata.value AS INTEGER) < CAST(excluded.value AS INTEGER)
  `).run({
    key: LIFECYCLE_SCHEMA_METADATA_KEY,
    value: String(LIFECYCLE_SQLITE_SCHEMA_VERSION),
  });
}

function inspectLifecycleSchemaCompatibility({ databasePath } = {}) {
  const resolvedPath = normalizeDatabasePath(databasePath);

  if (!fs.existsSync(resolvedPath)) {
    return Object.freeze({
      database_path: resolvedPath,
      current_version: null,
      target_version: LIFECYCLE_SQLITE_SCHEMA_VERSION,
      status: "missing",
      missing_tables: Object.freeze(Object.keys(REQUIRED_LIFECYCLE_TABLES)),
      missing_columns: Object.freeze([]),
      compatible: false,
    });
  }

  let database;

  try {
    database = new Database(resolvedPath, { readonly: true });
    const tables = listTables(database);
    const missingTables = Object.keys(REQUIRED_LIFECYCLE_TABLES)
      .filter((tableName) => !tables.has(tableName));
    const missingColumns = [];

    for (const [tableName, requiredColumns] of Object.entries(REQUIRED_LIFECYCLE_TABLES)) {
      if (!tables.has(tableName)) {
        continue;
      }

      const columns = listTableColumns(database, tableName);
      for (const columnName of requiredColumns) {
        if (!columns.has(columnName)) {
          missingColumns.push(`${tableName}.${columnName}`);
        }
      }
    }

    let currentVersion = null;
    if (tables.has("metadata")) {
      currentVersion = database.prepare(
        "SELECT value FROM metadata WHERE key = ?",
      ).get(LIFECYCLE_SCHEMA_METADATA_KEY)?.value ?? null;
    }

    const parsedVersion = currentVersion === null
      ? null
      : Number.parseInt(currentVersion, 10);
    const versionIsValid = currentVersion === null
      || (Number.isInteger(parsedVersion) && String(parsedVersion) === currentVersion);
    let status = "compatible";

    if (!versionIsValid || (parsedVersion ?? 0) > LIFECYCLE_SQLITE_SCHEMA_VERSION) {
      status = "blocked";
    } else if (
      parsedVersion !== LIFECYCLE_SQLITE_SCHEMA_VERSION
      || missingTables.length > 0
      || missingColumns.length > 0
    ) {
      status = "migration_required";
    }

    return Object.freeze({
      database_path: resolvedPath,
      current_version: currentVersion,
      target_version: LIFECYCLE_SQLITE_SCHEMA_VERSION,
      status,
      missing_tables: Object.freeze(missingTables),
      missing_columns: Object.freeze(missingColumns),
      compatible: status === "compatible",
    });
  } catch (error) {
    return Object.freeze({
      database_path: resolvedPath,
      current_version: null,
      target_version: LIFECYCLE_SQLITE_SCHEMA_VERSION,
      status: "blocked",
      missing_tables: Object.freeze([]),
      missing_columns: Object.freeze([]),
      compatible: false,
      error: error.message,
    });
  } finally {
    database?.close();
  }
}

function migrateLifecycleSqliteSchema({ databasePath } = {}) {
  const resolvedPath = normalizeDatabasePath(databasePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const database = new Database(resolvedPath);

  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.transaction(() => {
      assertWritableLifecycleVersion(database);
      initializeLifecycleSchema(database);
      assertLifecycleTables(database);
    }).immediate();
  } finally {
    database.close();
  }

  return inspectLifecycleSchemaCompatibility({ databasePath: resolvedPath });
}

function attemptFromRow(row) {
  if (!row) {
    return null;
  }

  return parseTaskAttempt(parseJson(row.payload, `task_attempts.${row.id ?? "row"}`));
}

function promotionFromRow(row) {
  if (!row) {
    return null;
  }

  return parsePromotionRecord(parseJson(row.payload, `task_promotions.${row.id ?? "row"}`));
}

function queueEntryFromRow(row) {
  if (!row) {
    return null;
  }

  return parseDurableQueueEntry(parseJson(row.payload, `lifecycle_queue.${row.task_id ?? "row"}`));
}

function writeAttempt(database, attempt, { expectedVersion = null } = {}) {
  const normalized = parseTaskAttempt(attempt);
  const params = {
    id: normalized.id,
    task_id: normalized.task_id,
    trigger: normalized.trigger,
    engine_version: normalized.engine_version,
    stage: normalized.stage,
    canonical_verdict: normalized.canonical_verdict,
    version: normalized.version,
    lease_holder: normalized.lease_holder,
    lease_expires_at: normalized.lease_expires_at,
    heartbeat_at: normalized.heartbeat_at,
    created_at: normalized.created_at,
    updated_at: normalized.updated_at,
    finished_at: normalized.finished_at,
    payload: serializeJson(normalized, "taskAttempt"),
  };

  if (expectedVersion === null) {
    database.prepare(`
      INSERT INTO task_attempts (
        id, task_id, trigger, engine_version, stage, canonical_verdict, version,
        lease_holder, lease_expires_at, heartbeat_at, created_at, updated_at,
        finished_at, payload
      ) VALUES (
        @id, @task_id, @trigger, @engine_version, @stage, @canonical_verdict,
        @version, @lease_holder, @lease_expires_at, @heartbeat_at, @created_at,
        @updated_at, @finished_at, @payload
      )
    `).run(params);
    return normalized;
  }

  const result = database.prepare(`
    UPDATE task_attempts SET
      stage = @stage,
      canonical_verdict = @canonical_verdict,
      version = @version,
      lease_holder = @lease_holder,
      lease_expires_at = @lease_expires_at,
      heartbeat_at = @heartbeat_at,
      updated_at = @updated_at,
      finished_at = @finished_at,
      payload = @payload
    WHERE id = @id AND version = @expected_version
  `).run({
    ...params,
    expected_version: expectedVersion,
  });

  if (result.changes !== 1) {
    throw new AttemptConcurrencyError(
      `task attempt ${normalized.id} changed while applying version ${expectedVersion}`,
    );
  }

  return normalized;
}

function writeAttemptLease(database, nextAttempt, currentAttempt) {
  const next = parseTaskAttempt(nextAttempt);
  const current = parseTaskAttempt(currentAttempt);
  const result = database.prepare(`
    UPDATE task_attempts SET
      lease_holder = @next_lease_holder,
      lease_expires_at = @next_lease_expires_at,
      heartbeat_at = @next_heartbeat_at,
      updated_at = @next_updated_at,
      payload = @next_payload
    WHERE id = @id
      AND version = @expected_version
      AND lease_holder IS @expected_lease_holder
      AND lease_expires_at IS @expected_lease_expires_at
  `).run({
    id: next.id,
    expected_version: current.version,
    expected_lease_holder: current.lease_holder,
    expected_lease_expires_at: current.lease_expires_at,
    next_lease_holder: next.lease_holder,
    next_lease_expires_at: next.lease_expires_at,
    next_heartbeat_at: next.heartbeat_at,
    next_updated_at: next.updated_at,
    next_payload: serializeJson(next, "taskAttempt"),
  });

  if (result.changes !== 1) {
    throw new AttemptLeaseConflictError(
      `task attempt ${next.id} lease changed concurrently`,
    );
  }

  return next;
}

function readAttemptById(database, attemptId) {
  return attemptFromRow(
    database.prepare("SELECT id, payload FROM task_attempts WHERE id = ?").get(attemptId),
  );
}

function createOrResumeAttemptInTransaction(database, {
  attemptId = null,
  engineVersion,
  nextId,
  taskId,
  timestamp,
  trigger,
}) {
  if (attemptId) {
    const existing = readAttemptById(database, attemptId);

    if (existing) {
      if (
        existing.task_id !== taskId
        || existing.trigger !== trigger
        || existing.engine_version !== engineVersion
      ) {
        throw new LifecycleSqliteError(
          `attempt ${attemptId} does not match task, trigger, and engine version`,
          { code: "attempt_identity_mismatch" },
        );
      }

      return existing;
    }
  }

  const active = attemptFromRow(database.prepare(`
    SELECT id, payload
    FROM task_attempts
    WHERE task_id = ? AND stage IN (${ACTIVE_ATTEMPT_STAGES.map(() => "?").join(", ")})
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(taskId, ...ACTIVE_ATTEMPT_STAGES));

  if (active) {
    if (attemptId && attemptId !== active.id) {
      throw new AttemptConcurrencyError(
        `task ${taskId} already has active attempt ${active.id}`,
      );
    }
    if (
      active.trigger !== trigger
      || active.engine_version !== engineVersion
    ) {
      throw new AttemptConcurrencyError(
        `task ${taskId} has active attempt ${active.id} for ${active.trigger}/${active.engine_version}`,
      );
    }

    return active;
  }

  const attempt = createTaskAttempt({
    id: attemptId ?? nextId("attempt"),
    taskId,
    trigger,
    engineVersion,
    now: timestamp,
  });
  writeAttempt(database, attempt);
  return attempt;
}

function mergeState(currentState, statePatch) {
  const patch = ensurePlainObject(statePatch ?? {}, "statePatch");

  return {
    ...clone(currentState),
    ...clone(patch),
  };
}

function writePromotion(database, promotion, { expectedVersion = null } = {}) {
  const normalized = parsePromotionRecord(promotion);
  const params = {
    id: normalized.id,
    attempt_id: normalized.attempt_id,
    task_id: normalized.task_id,
    status: normalized.status,
    version: normalized.version,
    created_at: normalized.created_at,
    updated_at: normalized.updated_at,
    payload: serializeJson(normalized, "promotionRecord"),
  };

  if (expectedVersion === null) {
    database.prepare(`
      INSERT INTO task_promotions (
        id, attempt_id, task_id, status, version, created_at, updated_at, payload
      ) VALUES (
        @id, @attempt_id, @task_id, @status, @version, @created_at, @updated_at,
        @payload
      )
    `).run(params);
    return normalized;
  }

  const result = database.prepare(`
    UPDATE task_promotions SET
      status = @status,
      version = @version,
      updated_at = @updated_at,
      payload = @payload
    WHERE id = @id AND version = @expected_version
  `).run({
    ...params,
    expected_version: expectedVersion,
  });

  if (result.changes !== 1) {
    throw new AttemptConcurrencyError(
      `promotion ${normalized.id} changed while applying version ${expectedVersion}`,
    );
  }

  return normalized;
}

function readPromotionByAttempt(database, attemptId) {
  return promotionFromRow(
    database.prepare(
      "SELECT id, payload FROM task_promotions WHERE attempt_id = ?",
    ).get(attemptId),
  );
}

function readQueueEntryByTask(database, taskId) {
  return queueEntryFromRow(database.prepare(
    "SELECT task_id, payload FROM lifecycle_queue WHERE task_id = ?",
  ).get(taskId));
}

function readActiveAttemptByTask(database, taskId) {
  return attemptFromRow(database.prepare(`
    SELECT id, payload
    FROM task_attempts
    WHERE task_id = ? AND stage IN (${ACTIVE_ATTEMPT_STAGES.map(() => "?").join(", ")})
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(taskId, ...ACTIVE_ATTEMPT_STAGES));
}

function readRequestedCancellation(queueEntry) {
  const request = queueEntry?.payload?.cancel_request;
  return request
    && typeof request === "object"
    && !Array.isArray(request)
    && request.status === "REQUESTED"
      ? request
      : null;
}

function writeQueueEntry(database, entry, { insert = false, expectedVersion = null } = {}) {
  const normalized = parseDurableQueueEntry(entry);
  const params = {
    task_id: normalized.task_id,
    state: normalized.state,
    priority: normalized.priority,
    available_at: normalized.available_at,
    claimed_by: normalized.claimed_by,
    claim_expires_at: normalized.claim_expires_at,
    version: normalized.version,
    created_at: normalized.created_at,
    updated_at: normalized.updated_at,
    payload: serializeJson(normalized, "queueEntry"),
  };

  if (insert) {
    database.prepare(`
      INSERT INTO lifecycle_queue (
        task_id, state, priority, available_at, claimed_by, claim_expires_at,
        version, created_at, updated_at, payload
      ) VALUES (
        @task_id, @state, @priority, @available_at, @claimed_by,
        @claim_expires_at, @version, @created_at, @updated_at, @payload
      )
    `).run(params);
    return normalized;
  }

  const result = database.prepare(`
    UPDATE lifecycle_queue SET
      state = @state,
      priority = @priority,
      available_at = @available_at,
      claimed_by = @claimed_by,
      claim_expires_at = @claim_expires_at,
      version = @version,
      updated_at = @updated_at,
      payload = @payload
    WHERE task_id = @task_id AND version = @expected_version
  `).run({
    ...params,
    expected_version: expectedVersion,
  });

  if (result.changes !== 1) {
    throw new AttemptConcurrencyError(
      `queue entry ${normalized.task_id} changed while applying version ${expectedVersion}`,
    );
  }

  return normalized;
}

function writeQueueClaim(database, nextEntry, currentEntry) {
  const next = parseDurableQueueEntry(nextEntry);
  const current = parseDurableQueueEntry(currentEntry);
  const result = database.prepare(`
    UPDATE lifecycle_queue SET
      claim_expires_at = @next_claim_expires_at,
      updated_at = @next_updated_at,
      payload = @next_payload
    WHERE task_id = @task_id
      AND version = @expected_version
      AND state = 'CLAIMED'
      AND claimed_by = @expected_claimed_by
      AND claim_expires_at = @expected_claim_expires_at
  `).run({
    task_id: next.task_id,
    expected_version: current.version,
    expected_claimed_by: current.claimed_by,
    expected_claim_expires_at: current.claim_expires_at,
    next_claim_expires_at: next.claim_expires_at,
    next_updated_at: next.updated_at,
    next_payload: serializeJson(next, "queueEntry"),
  });

  if (result.changes !== 1) {
    throw new AttemptLeaseConflictError(
      `queue claim ${next.task_id} changed concurrently`,
    );
  }

  return next;
}

function appendOutboxEvent(database, {
  eventId,
  taskId,
  operation,
  entry,
  now,
}) {
  const timestamp = toIsoTimestamp(now, "now");
  database.prepare(`
    INSERT INTO queue_projection_outbox (
      event_id, task_id, operation, created_at, delivered_at,
      delivery_attempts, last_error, payload
    ) VALUES (
      @event_id, @task_id, @operation, @created_at, NULL, 0, NULL, @payload
    )
  `).run({
    event_id: ensureNonEmptyString(eventId, "eventId"),
    task_id: ensureNonEmptyString(taskId, "taskId"),
    operation,
    created_at: timestamp,
    payload: serializeJson(entry, "outbox entry"),
  });
}

function outboxEventFromRow(row) {
  const entry = row.payload === "null"
    ? null
    : parseDurableQueueEntry(parseJson(row.payload, `outbox.${row.event_id}`));

  return parseQueueProjectionEvent({
    sequence_id: row.sequence_id,
    event_id: row.event_id,
    task_id: row.task_id,
    operation: row.operation,
    entry,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
    delivery_attempts: row.delivery_attempts,
    last_error: row.last_error,
  });
}

function executionLeaseFromRow(row) {
  if (!row) {
    return null;
  }

  return Object.freeze({
    scope: row.scope,
    holder: row.holder,
    pid: row.pid,
    acquired_at: row.acquired_at,
    heartbeat_at: row.heartbeat_at,
    expires_at: row.expires_at,
    version: row.version,
    metadata: Object.freeze(clone(parseJson(
      row.metadata,
      `execution_leases.${row.scope}`,
    ))),
  });
}

function readExecutionLeaseByScope(database, scope) {
  return executionLeaseFromRow(database.prepare(`
    SELECT scope, holder, pid, acquired_at, heartbeat_at, expires_at,
           version, metadata
    FROM execution_leases
    WHERE scope = ?
  `).get(scope));
}

function createLifecycleSqliteStore({
  databasePath,
  readonly = false,
  idFactory = randomUUID,
  pidInspector = inspectProcessLiveness,
} = {}) {
  const resolvedPath = normalizeDatabasePath(databasePath);

  if (!readonly) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  } else if (!fs.existsSync(resolvedPath)) {
    throw new LifecycleSqliteError(`SQLite database does not exist: ${resolvedPath}`);
  }

  const database = new Database(resolvedPath, { readonly });
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");

  if (!readonly) {
    try {
      database.pragma("journal_mode = WAL");
      database.transaction(() => {
        assertWritableLifecycleVersion(database);
        initializeLifecycleSchema(database);
        assertLifecycleTables(database);
      }).immediate();
    } catch (error) {
      database.close();
      throw error;
    }
  } else {
    const compatibility = inspectLifecycleSchemaCompatibility({
      databasePath: resolvedPath,
    });

    if (!compatibility.compatible) {
      database.close();
      throw new LifecycleSqliteError(
        `lifecycle schema is not readable: ${compatibility.status}`,
        { code: "lifecycle_schema_incompatible" },
      );
    }
  }

  const nextId = (prefix) => `${prefix}:${ensureNonEmptyString(idFactory(), "generated id")}`;
  if (typeof pidInspector !== "function") {
    database.close();
    throw new LifecycleSqliteError("pidInspector must be a function");
  }

  const store = {
    kind: "sqlite_task_lifecycle",
    databasePath: resolvedPath,
    executionLeases: {
      async acquire({
        scope,
        holder,
        pid = process.pid,
        now = new Date(),
        ttlMs = 90_000,
        metadata = {},
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError(
            "readonly lifecycle store cannot acquire execution leases",
          );
        }

        const normalizedScope = ensureNonEmptyString(scope, "scope");
        const normalizedHolder = ensureNonEmptyString(holder, "holder");
        const normalizedPid = ensurePositiveInteger(pid, "pid");
        const normalizedMetadata = clone(ensurePlainObject(metadata, "metadata"));
        const timestamp = toIsoTimestamp(now, "now");
        const expiresAt = addMilliseconds(timestamp, ttlMs);

        return database.transaction(() => {
          const current = readExecutionLeaseByScope(database, normalizedScope);
          if (!current) {
            database.prepare(`
              INSERT INTO execution_leases (
                scope, holder, pid, acquired_at, heartbeat_at, expires_at,
                version, metadata
              ) VALUES (
                @scope, @holder, @pid, @acquired_at, @heartbeat_at, @expires_at,
                0, @metadata
              )
            `).run({
              scope: normalizedScope,
              holder: normalizedHolder,
              pid: normalizedPid,
              acquired_at: timestamp,
              heartbeat_at: timestamp,
              expires_at: expiresAt,
              metadata: serializeJson(normalizedMetadata, "execution lease metadata"),
            });
            return readExecutionLeaseByScope(database, normalizedScope);
          }

          const expired =
            Date.parse(current.expires_at) <= Date.parse(timestamp);
          let ownerLiveness = "alive";
          if (expired) {
            try {
              ownerLiveness = normalizeProcessLiveness(pidInspector(current.pid));
            } catch {
              ownerLiveness = "unknown";
            }
          }

          if (!expired || ownerLiveness !== "dead") {
            const reason = !expired
              ? "lease_not_expired"
              : ownerLiveness === "alive"
                ? "owner_alive"
                : "owner_liveness_unknown";
            throw new ExecutionLeaseConflictError(
              `execution lease ${normalizedScope} is held by ${current.holder}`,
              {
                scope: normalizedScope,
                holder: current.holder,
                pid: current.pid,
                expiresAt: current.expires_at,
                reason,
              },
            );
          }

          const result = database.prepare(`
            UPDATE execution_leases
            SET holder = @holder,
                pid = @pid,
                acquired_at = @acquired_at,
                heartbeat_at = @heartbeat_at,
                expires_at = @expires_at,
                version = version + 1,
                metadata = @metadata
            WHERE scope = @scope
              AND holder = @expected_holder
              AND pid = @expected_pid
              AND version = @expected_version
          `).run({
            scope: normalizedScope,
            holder: normalizedHolder,
            pid: normalizedPid,
            acquired_at: timestamp,
            heartbeat_at: timestamp,
            expires_at: expiresAt,
            expected_holder: current.holder,
            expected_pid: current.pid,
            expected_version: current.version,
            metadata: serializeJson(normalizedMetadata, "execution lease metadata"),
          });
          if (result.changes !== 1) {
            throw new ExecutionLeaseConflictError(
              `execution lease ${normalizedScope} changed while reclaiming it`,
              {
                scope: normalizedScope,
                holder: current.holder,
                pid: current.pid,
                expiresAt: current.expires_at,
                reason: "concurrent_change",
              },
            );
          }
          return readExecutionLeaseByScope(database, normalizedScope);
        }).immediate();
      },
      async heartbeat({
        scope,
        holder,
        pid = process.pid,
        now = new Date(),
        ttlMs = 90_000,
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError(
            "readonly lifecycle store cannot heartbeat execution leases",
          );
        }

        const normalizedScope = ensureNonEmptyString(scope, "scope");
        const normalizedHolder = ensureNonEmptyString(holder, "holder");
        const normalizedPid = ensurePositiveInteger(pid, "pid");
        const timestamp = toIsoTimestamp(now, "now");
        const expiresAt = addMilliseconds(timestamp, ttlMs);

        return database.transaction(() => {
          const current = readExecutionLeaseByScope(database, normalizedScope);
          if (
            !current
            || current.holder !== normalizedHolder
            || current.pid !== normalizedPid
          ) {
            throw new ExecutionLeaseConflictError(
              `execution lease ${normalizedScope} is not owned by ${normalizedHolder}/${normalizedPid}`,
              {
                scope: normalizedScope,
                holder: current?.holder ?? null,
                pid: current?.pid ?? null,
                expiresAt: current?.expires_at ?? null,
                reason: current ? "owner_mismatch" : "lease_missing",
              },
            );
          }
          let ownerLiveness;
          try {
            ownerLiveness = normalizeProcessLiveness(pidInspector(normalizedPid));
          } catch {
            ownerLiveness = "unknown";
          }
          if (ownerLiveness !== "alive") {
            throw new ExecutionLeaseConflictError(
              `execution lease ${normalizedScope} owner PID ${normalizedPid} is not confirmed alive`,
              {
                scope: normalizedScope,
                holder: current.holder,
                pid: current.pid,
                expiresAt: current.expires_at,
                reason: ownerLiveness === "dead"
                  ? "heartbeat_owner_dead"
                  : "heartbeat_owner_liveness_unknown",
              },
            );
          }

          const result = database.prepare(`
            UPDATE execution_leases
            SET heartbeat_at = @heartbeat_at,
                expires_at = @expires_at,
                version = version + 1
            WHERE scope = @scope
              AND holder = @holder
              AND pid = @pid
              AND version = @expected_version
          `).run({
            scope: normalizedScope,
            holder: normalizedHolder,
            pid: normalizedPid,
            heartbeat_at: timestamp,
            expires_at: expiresAt,
            expected_version: current.version,
          });
          if (result.changes !== 1) {
            throw new ExecutionLeaseConflictError(
              `execution lease ${normalizedScope} changed while heartbeating`,
              {
                scope: normalizedScope,
                holder: current.holder,
                pid: current.pid,
                expiresAt: current.expires_at,
                reason: "concurrent_change",
              },
            );
          }
          return readExecutionLeaseByScope(database, normalizedScope);
        }).immediate();
      },
      async handoff({
        scope,
        holder,
        fromPid = process.pid,
        toPid,
        now = new Date(),
        ttlMs = 90_000,
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError(
            "readonly lifecycle store cannot hand off execution leases",
          );
        }

        const normalizedScope = ensureNonEmptyString(scope, "scope");
        const normalizedHolder = ensureNonEmptyString(holder, "holder");
        const normalizedFromPid = ensurePositiveInteger(fromPid, "fromPid");
        const normalizedToPid = ensurePositiveInteger(toPid, "toPid");
        if (normalizedFromPid === normalizedToPid) {
          throw new LifecycleSqliteError(
            "execution lease handoff requires a different target PID",
          );
        }
        const timestamp = toIsoTimestamp(now, "now");
        const expiresAt = addMilliseconds(timestamp, ttlMs);

        return database.transaction(() => {
          const current = readExecutionLeaseByScope(database, normalizedScope);
          if (!current || current.holder !== normalizedHolder) {
            throw new ExecutionLeaseConflictError(
              `execution lease ${normalizedScope} cannot be handed off by ${normalizedHolder}/${normalizedFromPid}`,
              {
                scope: normalizedScope,
                holder: current?.holder ?? null,
                pid: current?.pid ?? null,
                expiresAt: current?.expires_at ?? null,
                reason: current ? "owner_mismatch" : "lease_missing",
              },
            );
          }

          let targetLiveness;
          try {
            targetLiveness = normalizeProcessLiveness(pidInspector(normalizedToPid));
          } catch {
            targetLiveness = "unknown";
          }
          if (targetLiveness !== "alive") {
            throw new ExecutionLeaseConflictError(
              `execution lease ${normalizedScope} target PID ${normalizedToPid} is not confirmed alive`,
              {
                scope: normalizedScope,
                holder: current.holder,
                pid: current.pid,
                expiresAt: current.expires_at,
                reason: targetLiveness === "dead"
                  ? "handoff_target_dead"
                  : "handoff_target_liveness_unknown",
              },
            );
          }
          if (current.pid === normalizedToPid) {
            return current;
          }
          if (current.pid !== normalizedFromPid) {
            throw new ExecutionLeaseConflictError(
              `execution lease ${normalizedScope} cannot be handed off by ${normalizedHolder}/${normalizedFromPid}`,
              {
                scope: normalizedScope,
                holder: current.holder,
                pid: current.pid,
                expiresAt: current.expires_at,
                reason: "owner_mismatch",
              },
            );
          }

          const result = database.prepare(`
            UPDATE execution_leases
            SET pid = @to_pid,
                heartbeat_at = @heartbeat_at,
                expires_at = @expires_at,
                version = version + 1
            WHERE scope = @scope
              AND holder = @holder
              AND pid = @from_pid
              AND version = @expected_version
          `).run({
            scope: normalizedScope,
            holder: normalizedHolder,
            from_pid: normalizedFromPid,
            to_pid: normalizedToPid,
            heartbeat_at: timestamp,
            expires_at: expiresAt,
            expected_version: current.version,
          });
          if (result.changes !== 1) {
            throw new ExecutionLeaseConflictError(
              `execution lease ${normalizedScope} changed while handing it off`,
              {
                scope: normalizedScope,
                holder: current.holder,
                pid: current.pid,
                expiresAt: current.expires_at,
                reason: "concurrent_change",
              },
            );
          }
          return readExecutionLeaseByScope(database, normalizedScope);
        }).immediate();
      },
      async release({
        scope,
        holder,
        pid = process.pid,
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError(
            "readonly lifecycle store cannot release execution leases",
          );
        }

        const normalizedScope = ensureNonEmptyString(scope, "scope");
        const normalizedHolder = ensureNonEmptyString(holder, "holder");
        const normalizedPid = ensurePositiveInteger(pid, "pid");
        const result = database.prepare(`
          DELETE FROM execution_leases
          WHERE scope = ? AND holder = ? AND pid = ?
        `).run(normalizedScope, normalizedHolder, normalizedPid);
        return result.changes === 1;
      },
      async byScope(scope) {
        return readExecutionLeaseByScope(
          database,
          ensureNonEmptyString(scope, "scope"),
        );
      },
    },
    attempts: {
      async createOrResume({
        attemptId = null,
        taskId,
        trigger,
        engineVersion,
        now = new Date(),
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot create attempts");
        }

        const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
        const normalizedTrigger = ensureNonEmptyString(trigger, "trigger");
        const normalizedEngineVersion = ensureNonEmptyString(
          engineVersion,
          "engineVersion",
        );
        const normalizedAttemptId = attemptId === null || attemptId === undefined
          ? null
          : ensureNonEmptyString(attemptId, "attemptId");
        const timestamp = toIsoTimestamp(now, "now");

        return database.transaction(() => createOrResumeAttemptInTransaction(
          database,
          {
            attemptId: normalizedAttemptId,
            engineVersion: normalizedEngineVersion,
            nextId,
            taskId: normalizedTaskId,
            timestamp,
            trigger: normalizedTrigger,
          },
        )).immediate();
      },
      async byId(attemptId) {
        return readAttemptById(
          database,
          ensureNonEmptyString(attemptId, "attemptId"),
        );
      },
      async activeByTask(taskId) {
        return attemptFromRow(database.prepare(`
          SELECT id, payload
          FROM task_attempts
          WHERE task_id = ? AND stage IN (${ACTIVE_ATTEMPT_STAGES.map(() => "?").join(", ")})
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `).get(ensureNonEmptyString(taskId, "taskId"), ...ACTIVE_ATTEMPT_STAGES));
      },
      async listByTask(taskId) {
        return database.prepare(`
          SELECT id, payload
          FROM task_attempts
          WHERE task_id = ?
          ORDER BY created_at ASC, id ASC
        `).all(ensureNonEmptyString(taskId, "taskId")).map(attemptFromRow);
      },
      async list() {
        return database.prepare(`
          SELECT id, payload
          FROM task_attempts
          ORDER BY created_at ASC, id ASC
        `).all().map(attemptFromRow);
      },
      async acquireLease({
        attemptId,
        holder,
        now = new Date(),
        ttlMs = 30_000,
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot acquire leases");
        }

        const normalizedAttemptId = ensureNonEmptyString(attemptId, "attemptId");
        const normalizedHolder = ensureNonEmptyString(holder, "holder");
        const timestamp = toIsoTimestamp(now, "now");
        const expiresAt = addMilliseconds(timestamp, ttlMs);

        return database.transaction(() => {
          const current = readAttemptById(database, normalizedAttemptId);

          if (!current) {
            throw new LifecycleSqliteError(`task attempt ${normalizedAttemptId} not found`);
          }

          if (isTerminalAttemptStage(current.stage)) {
            return current;
          }

          const leaseActive = current.lease_holder
            && current.lease_expires_at
            && Date.parse(current.lease_expires_at) > Date.parse(timestamp);

          if (leaseActive && current.lease_holder !== normalizedHolder) {
            throw new AttemptLeaseConflictError(
              `task attempt ${normalizedAttemptId} is leased by ${current.lease_holder} until ${current.lease_expires_at}`,
              {
                holder: current.lease_holder,
                expiresAt: current.lease_expires_at,
              },
            );
          }

          const next = parseTaskAttempt({
            ...current,
            lease_holder: normalizedHolder,
            lease_expires_at: expiresAt,
            heartbeat_at: timestamp,
            updated_at: timestamp,
          });
          writeAttempt(database, next, { expectedVersion: current.version });
          return next;
        }).immediate();
      },
      async heartbeat({
        attemptId,
        holder,
        now = new Date(),
        ttlMs = 30_000,
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot heartbeat leases");
        }

        const normalizedAttemptId = ensureNonEmptyString(attemptId, "attemptId");
        const normalizedHolder = ensureNonEmptyString(holder, "holder");
        const timestamp = toIsoTimestamp(now, "now");
        const current = readAttemptById(database, normalizedAttemptId);

        if (!current) {
          throw new LifecycleSqliteError(`task attempt ${normalizedAttemptId} not found`);
        }

        if (isTerminalAttemptStage(current.stage)) {
          return current;
        }

        if (
          current.lease_holder !== normalizedHolder
          || !current.lease_expires_at
          || Date.parse(current.lease_expires_at) <= Date.parse(timestamp)
        ) {
          throw new AttemptLeaseConflictError(
            `task attempt ${normalizedAttemptId} lease is not active for ${normalizedHolder}`,
            {
              holder: current.lease_holder,
              expiresAt: current.lease_expires_at,
            },
          );
        }

        const next = parseTaskAttempt({
          ...current,
          lease_expires_at: addMilliseconds(timestamp, ttlMs),
          heartbeat_at: timestamp,
          updated_at: timestamp,
        });
        writeAttemptLease(database, next, current);
        return next;
      },
      async releaseLease({
        attemptId,
        holder,
        now = new Date(),
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot release leases");
        }

        const normalizedAttemptId = ensureNonEmptyString(attemptId, "attemptId");
        const normalizedHolder = ensureNonEmptyString(holder, "holder");
        const timestamp = toIsoTimestamp(now, "now");
        const current = readAttemptById(database, normalizedAttemptId);

        if (!current || current.lease_holder !== normalizedHolder) {
          return current;
        }

        const next = parseTaskAttempt({
          ...current,
          lease_holder: null,
          lease_expires_at: null,
          heartbeat_at: current.heartbeat_at,
          updated_at: timestamp,
        });
        try {
          writeAttemptLease(database, next, current);
          return next;
        } catch (error) {
          if (error instanceof AttemptLeaseConflictError) {
            return readAttemptById(database, normalizedAttemptId);
          }
          throw error;
        }
      },
      async transition({
        attemptId,
        expectedStage,
        expectedVersion,
        nextStage,
        holder = null,
        canonicalVerdict = undefined,
        workspacePath = undefined,
        statePatch = {},
        lastError = undefined,
        now = new Date(),
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot transition attempts");
        }

        const normalizedAttemptId = ensureNonEmptyString(attemptId, "attemptId");
        const timestamp = toIsoTimestamp(now, "now");

        return database.transaction(() => {
          const current = readAttemptById(database, normalizedAttemptId);

          if (!current) {
            throw new LifecycleSqliteError(`task attempt ${normalizedAttemptId} not found`);
          }

          if (current.stage !== expectedStage || current.version !== expectedVersion) {
            throw new AttemptConcurrencyError(
              `task attempt ${normalizedAttemptId} expected ${expectedStage}@${expectedVersion}, found ${current.stage}@${current.version}`,
            );
          }

          if (
            holder !== null
            && (
              current.lease_holder !== holder
              || !current.lease_expires_at
              || Date.parse(current.lease_expires_at) <= Date.parse(timestamp)
            )
          ) {
            throw new AttemptLeaseConflictError(
              `task attempt ${normalizedAttemptId} does not have an active lease for ${holder}`,
              {
                holder: current.lease_holder,
                expiresAt: current.lease_expires_at,
              },
            );
          }
          if (
            holder === null
            && current.lease_holder !== null
            && current.lease_expires_at
            && Date.parse(current.lease_expires_at) > Date.parse(timestamp)
          ) {
            throw new AttemptLeaseConflictError(
              `task attempt ${normalizedAttemptId} has an active lease and cannot be changed externally`,
              {
                holder: current.lease_holder,
                expiresAt: current.lease_expires_at,
              },
            );
          }

          assertAttemptStageTransition(current.stage, nextStage);
          const terminal = isTerminalAttemptStage(nextStage);
          const next = parseTaskAttempt({
            ...current,
            stage: nextStage,
            canonical_verdict: canonicalVerdict === undefined
              ? current.canonical_verdict
              : canonicalVerdict,
            workspace_path: workspacePath === undefined
              ? current.workspace_path
              : workspacePath,
            lease_holder: terminal ? null : current.lease_holder,
            lease_expires_at: terminal ? null : current.lease_expires_at,
            updated_at: timestamp,
            finished_at: terminal ? timestamp : null,
            version: current.version + 1,
            state: mergeState(current.state, statePatch),
            last_error: lastError === undefined ? current.last_error : lastError,
          });
          writeAttempt(database, next, { expectedVersion: current.version });
          return next;
        }).immediate();
      },
      async recordStepStarted({
        attemptId,
        stage,
        idempotencyKey,
        now = new Date(),
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot record steps");
        }

        const timestamp = toIsoTimestamp(now, "now");
        database.prepare(`
          INSERT INTO task_attempt_steps (
            attempt_id, stage, idempotency_key, status, started_at,
            completed_at, payload
          ) VALUES (
            @attempt_id, @stage, @idempotency_key, 'STARTED', @started_at,
            NULL, @payload
          )
          ON CONFLICT(attempt_id, stage) DO NOTHING
        `).run({
          attempt_id: ensureNonEmptyString(attemptId, "attemptId"),
          stage: ensureNonEmptyString(stage, "stage"),
          idempotency_key: ensureNonEmptyString(idempotencyKey, "idempotencyKey"),
          started_at: timestamp,
          payload: "{}",
        });

        return store.attempts.step({ attemptId, stage });
      },
      async recordStepCompleted({
        attemptId,
        stage,
        result,
        now = new Date(),
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot record steps");
        }

        const normalizedAttemptId = ensureNonEmptyString(attemptId, "attemptId");
        const normalizedStage = ensureNonEmptyString(stage, "stage");
        const timestamp = toIsoTimestamp(now, "now");
        const updated = database.prepare(`
          UPDATE task_attempt_steps
          SET status = 'COMPLETED', completed_at = @completed_at, payload = @payload
          WHERE attempt_id = @attempt_id AND stage = @stage
        `).run({
          attempt_id: normalizedAttemptId,
          stage: normalizedStage,
          completed_at: timestamp,
          payload: serializeJson(result ?? {}, "step result"),
        });

        if (updated.changes !== 1) {
          throw new LifecycleSqliteError(
            `attempt step ${normalizedAttemptId}:${normalizedStage} was not started`,
          );
        }

        return store.attempts.step({
          attemptId: normalizedAttemptId,
          stage: normalizedStage,
        });
      },
      async step({ attemptId, stage } = {}) {
        const row = database.prepare(`
          SELECT attempt_id, stage, idempotency_key, status, started_at,
                 completed_at, payload
          FROM task_attempt_steps
          WHERE attempt_id = ? AND stage = ?
        `).get(
          ensureNonEmptyString(attemptId, "attemptId"),
          ensureNonEmptyString(stage, "stage"),
        );

        if (!row) {
          return null;
        }

        return Object.freeze({
          attempt_id: row.attempt_id,
          stage: row.stage,
          idempotency_key: row.idempotency_key,
          status: row.status,
          started_at: row.started_at,
          completed_at: row.completed_at,
          result: clone(parseJson(row.payload, "attempt step payload")),
        });
      },
    },
    promotions: {
      async prepare({
        attemptId,
        now = new Date(),
        metadata = {},
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot prepare promotions");
        }

        const normalizedAttemptId = ensureNonEmptyString(attemptId, "attemptId");
        const timestamp = toIsoTimestamp(now, "now");

        return database.transaction(() => {
          const attempt = readAttemptById(database, normalizedAttemptId);
          if (!attempt) {
            throw new LifecycleSqliteError(`task attempt ${normalizedAttemptId} not found`);
          }

          const queueEntry = readQueueEntryByTask(database, attempt.task_id);
          const cancellationRequest = readRequestedCancellation(queueEntry);
          if (cancellationRequest) {
            throw new LifecycleSqliteError(
              `promotion for attempt ${normalizedAttemptId} is blocked by durable cancellation request ${cancellationRequest.request_id ?? "unknown"}`,
              { code: "promotion_blocked_by_cancellation" },
            );
          }

          const existing = readPromotionByAttempt(database, normalizedAttemptId);
          if (existing) {
            return existing;
          }

          if (!isPromotionAllowed(attempt)) {
            throw new LifecycleSqliteError(
              `task attempt ${normalizedAttemptId} is not eligible for promotion`,
              { code: "promotion_not_allowed" },
            );
          }

          const promotion = createPromotionRecord({
            id: `promotion:${normalizedAttemptId}`,
            attemptId: normalizedAttemptId,
            taskId: attempt.task_id,
            now: timestamp,
            metadata,
          });
          writePromotion(database, promotion);
          return promotion;
        }).immediate();
      },
      async complete({
        attemptId,
        expectedAttemptVersion,
        holder,
        targetKind = null,
        targetRef = null,
        branchName = null,
        commitSha = null,
        prUrl = null,
        metadata = {},
        now = new Date(),
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot complete promotions");
        }

        const normalizedAttemptId = ensureNonEmptyString(attemptId, "attemptId");
        const normalizedHolder = ensureNonEmptyString(holder, "holder");
        if (!Number.isInteger(expectedAttemptVersion) || expectedAttemptVersion < 0) {
          throw new LifecycleSqliteError(
            "expectedAttemptVersion must be a non-negative integer",
          );
        }
        const timestamp = toIsoTimestamp(now, "now");

        return database.transaction(() => {
          const current = readPromotionByAttempt(database, normalizedAttemptId);
          if (!current) {
            throw new LifecycleSqliteError(
              `promotion for attempt ${normalizedAttemptId} was not prepared`,
            );
          }

          if (current.status === PromotionStatus.PROMOTED) {
            return current;
          }

          const attempt = readAttemptById(database, normalizedAttemptId);
          if (
            !attempt
            || attempt.stage !== "READY_TO_PROMOTE"
            || attempt.version !== expectedAttemptVersion
            || attempt.canonical_verdict !== "PASS"
            || attempt.lease_holder !== normalizedHolder
            || !attempt.lease_expires_at
            || Date.parse(attempt.lease_expires_at) <= Date.parse(timestamp)
          ) {
            throw new AttemptConcurrencyError(
              `task attempt ${normalizedAttemptId} changed before promotion completion`,
            );
          }

          const inferredTargetKind = targetKind
            ?? (prUrl ? PromotionTargetKind.PULL_REQUEST : PromotionTargetKind.BRANCH);
          const inferredTargetRef = targetRef ?? prUrl ?? branchName;

          if (!inferredTargetRef) {
            throw new LifecycleSqliteError(
              "completed promotion requires targetRef, prUrl, or branchName",
            );
          }

          const next = parsePromotionRecord({
            ...current,
            status: PromotionStatus.PROMOTED,
            target_kind: inferredTargetKind,
            target_ref: inferredTargetRef,
            branch_name: branchName,
            commit_sha: commitSha,
            pr_url: prUrl,
            error: null,
            updated_at: timestamp,
            promoted_at: timestamp,
            version: current.version + 1,
            metadata: {
              ...current.metadata,
              ...clone(ensurePlainObject(metadata, "metadata")),
            },
          });
          writePromotion(database, next, { expectedVersion: current.version });
          return next;
        }).immediate();
      },
      async markFailed({
        attemptId,
        error,
        now = new Date(),
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot fail promotions");
        }

        const normalizedAttemptId = ensureNonEmptyString(attemptId, "attemptId");
        const current = readPromotionByAttempt(database, normalizedAttemptId);

        if (!current || current.status === PromotionStatus.PROMOTED) {
          return current;
        }

        const next = parsePromotionRecord({
          ...current,
          status: PromotionStatus.FAILED,
          error: ensureNonEmptyString(error, "error"),
          updated_at: toIsoTimestamp(now, "now"),
          version: current.version + 1,
        });
        writePromotion(database, next, { expectedVersion: current.version });
        return next;
      },
      async byAttempt(attemptId) {
        return readPromotionByAttempt(
          database,
          ensureNonEmptyString(attemptId, "attemptId"),
        );
      },
    },
    queue: {
      async requestCancellation({
        attemptHolder,
        executionLeaseHolder,
        executionLeasePid,
        executionLeaseScope,
        requestId,
        requestedBy,
        taskId,
        now = new Date(),
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError(
            "readonly lifecycle store cannot request cancellation",
          );
        }

        const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
        const normalizedAttemptHolder = ensureNonEmptyString(
          attemptHolder,
          "attemptHolder",
        );
        const normalizedExecutionLeaseHolder = ensureNonEmptyString(
          executionLeaseHolder,
          "executionLeaseHolder",
        );
        const normalizedExecutionLeasePid = ensurePositiveInteger(
          executionLeasePid,
          "executionLeasePid",
        );
        const normalizedExecutionLeaseScope = ensureNonEmptyString(
          executionLeaseScope,
          "executionLeaseScope",
        );
        const normalizedRequestId = ensureNonEmptyString(requestId, "requestId");
        const normalizedRequestedBy = ensureNonEmptyString(requestedBy, "requestedBy");
        const timestamp = toIsoTimestamp(now, "now");

        return database.transaction(() => {
          const current = readQueueEntryByTask(database, normalizedTaskId);
          if (
            !current
            || ![
              DurableQueueState.PENDING,
              DurableQueueState.CLAIMED,
            ].includes(current.state)
          ) {
            throw new LifecycleSqliteError(
              `task ${normalizedTaskId} is not cancellable from queue state ${current?.state ?? "missing"}`,
              { code: "lifecycle_cancel_queue_not_active" },
            );
          }

          const executionLease = readExecutionLeaseByScope(
            database,
            normalizedExecutionLeaseScope,
          );
          if (
            !executionLease
            || executionLease.holder !== normalizedExecutionLeaseHolder
            || executionLease.pid !== normalizedExecutionLeasePid
          ) {
            throw new LifecycleSqliteError(
              `process ${normalizedExecutionLeasePid} does not own execution lease ${normalizedExecutionLeaseScope}`,
              { code: "lifecycle_cancel_project_owner_mismatch" },
            );
          }

          const existingRequest = current.payload?.cancel_request ?? null;
          let repeatsExistingRequest = false;
          if (existingRequest !== null && existingRequest !== undefined) {
            if (
              readRequestedCancellation(current)
              && existingRequest.project_scope === executionLease.scope
              && existingRequest.project_holder === executionLease.holder
              && existingRequest.project_pid === executionLease.pid
              && existingRequest.project_acquired_at === executionLease.acquired_at
            ) {
              repeatsExistingRequest = true;
            } else {
              throw new LifecycleSqliteError(
                `task ${normalizedTaskId} already has a cancellation request`,
                { code: "lifecycle_cancel_request_conflict" },
              );
            }
          }

          if (
            current.state === DurableQueueState.CLAIMED
            && current.claimed_by !== executionLease.holder
          ) {
            throw new LifecycleSqliteError(
              `queue claim ${normalizedTaskId} is not owned by process ${normalizedExecutionLeasePid}`,
              { code: "lifecycle_cancel_queue_owner_mismatch" },
            );
          }

          const queueAttemptId =
            typeof current.payload?.attempt_id === "string"
            && current.payload.attempt_id.trim() !== ""
              ? current.payload.attempt_id.trim()
              : null;
          const activeAttempt = readActiveAttemptByTask(database, normalizedTaskId);
          if (
            queueAttemptId
            && activeAttempt
            && queueAttemptId !== activeAttempt.id
          ) {
            throw new LifecycleSqliteError(
              `queue attempt ${queueAttemptId} does not match active attempt ${activeAttempt.id}`,
              { code: "lifecycle_cancel_attempt_mismatch" },
            );
          }
          const attempt = queueAttemptId
            ? readAttemptById(database, queueAttemptId)
            : activeAttempt;
          if (attempt && attempt.task_id !== normalizedTaskId) {
            throw new LifecycleSqliteError(
              `attempt ${attempt.id} is not bound to task ${normalizedTaskId}`,
              { code: "lifecycle_cancel_attempt_mismatch" },
            );
          }
          if (
            repeatsExistingRequest
            && existingRequest.attempt_id !== (attempt?.id ?? null)
          ) {
            throw new LifecycleSqliteError(
              `cancellation request for ${normalizedTaskId} is bound to a different attempt`,
              { code: "lifecycle_cancel_attempt_mismatch" },
            );
          }

          const promotion = attempt
            ? readPromotionByAttempt(database, attempt.id)
            : null;
          if (promotion) {
            throw new LifecycleSqliteError(
              `attempt ${attempt.id} already entered the irreversible promotion zone`,
              { code: "cancellation_after_promotion_started" },
            );
          }
          if (repeatsExistingRequest) {
            return current;
          }

          if (attempt && isTerminalAttemptStage(attempt.stage)) {
            throw new LifecycleSqliteError(
              `attempt ${attempt.id} is already terminal at ${attempt.stage}`,
              { code: "lifecycle_cancel_attempt_terminal" },
            );
          }
          if (
            attempt
            && attempt.lease_holder !== null
            && attempt.lease_holder !== normalizedAttemptHolder
          ) {
            throw new LifecycleSqliteError(
              `attempt ${attempt.id} is owned by a different executor`,
              { code: "lifecycle_cancel_attempt_owner_mismatch" },
            );
          }

          const request = Object.freeze({
            attempt_holder: attempt?.lease_holder ?? null,
            attempt_id: attempt?.id ?? null,
            attempt_stage: attempt?.stage ?? null,
            attempt_version: attempt?.version ?? null,
            finalized_at: null,
            project_acquired_at: executionLease.acquired_at,
            project_holder: executionLease.holder,
            project_lease_version: executionLease.version,
            project_pid: executionLease.pid,
            project_scope: executionLease.scope,
            queue_holder:
              current.state === DurableQueueState.CLAIMED
                ? current.claimed_by
                : null,
            queue_state: current.state,
            queue_version: current.version + 1,
            request_id: normalizedRequestId,
            requested_at: timestamp,
            requested_by: normalizedRequestedBy,
            schema_version: 1,
            status: "REQUESTED",
            task_id: normalizedTaskId,
          });
          const next = parseDurableQueueEntry({
            ...current,
            updated_at: timestamp,
            version: current.version + 1,
            payload: {
              ...current.payload,
              cancel_request: request,
            },
          });
          writeQueueEntry(database, next, { expectedVersion: current.version });
          appendOutboxEvent(database, {
            eventId: nextId("queue-event"),
            taskId: normalizedTaskId,
            operation: QueueProjectionOperation.UPSERT,
            entry: next,
            now: timestamp,
          });
          return next;
        }).immediate();
      },
      async bindAttempt({
        attemptId = null,
        engineVersion,
        holder,
        now = new Date(),
        taskId,
        trigger,
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot bind attempts");
        }

        const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
        const normalizedHolder = ensureNonEmptyString(holder, "holder");
        const normalizedTrigger = ensureNonEmptyString(trigger, "trigger");
        const normalizedEngineVersion = ensureNonEmptyString(
          engineVersion,
          "engineVersion",
        );
        const requestedAttemptId = attemptId === null || attemptId === undefined
          ? null
          : ensureNonEmptyString(attemptId, "attemptId");
        const timestamp = toIsoTimestamp(now, "now");

        return database.transaction(() => {
          const current = queueEntryFromRow(database.prepare(
            "SELECT task_id, payload FROM lifecycle_queue WHERE task_id = ?",
          ).get(normalizedTaskId));
          if (
            !current
            || current.state !== DurableQueueState.CLAIMED
            || current.claimed_by !== normalizedHolder
            || !current.claim_expires_at
            || Date.parse(current.claim_expires_at) <= Date.parse(timestamp)
          ) {
            throw new AttemptLeaseConflictError(
              `queue claim ${normalizedTaskId} is not active for ${normalizedHolder}`,
              {
                holder: current?.claimed_by ?? null,
                expiresAt: current?.claim_expires_at ?? null,
              },
            );
          }

          const persistedAttemptId =
            typeof current.payload?.attempt_id === "string"
            && current.payload.attempt_id.trim() !== ""
              ? current.payload.attempt_id.trim()
              : null;
          if (
            persistedAttemptId
            && requestedAttemptId
            && persistedAttemptId !== requestedAttemptId
          ) {
            throw new AttemptConcurrencyError(
              `queue entry ${normalizedTaskId} is already bound to ${persistedAttemptId}`,
            );
          }
          const effectiveAttemptId = persistedAttemptId ?? requestedAttemptId;
          const attempt = createOrResumeAttemptInTransaction(database, {
            attemptId: effectiveAttemptId,
            engineVersion: normalizedEngineVersion,
            nextId,
            taskId: normalizedTaskId,
            timestamp,
            trigger: normalizedTrigger,
          });
          if (persistedAttemptId) {
            return Object.freeze({
              attempt,
              entry: current,
              newly_bound: false,
            });
          }

          const next = parseDurableQueueEntry({
            ...current,
            updated_at: timestamp,
            version: current.version + 1,
            payload: {
              ...current.payload,
              attempt_id: attempt.id,
              attempt_engine_version: attempt.engine_version,
              attempt_trigger: attempt.trigger,
            },
          });
          writeQueueEntry(database, next, { expectedVersion: current.version });
          appendOutboxEvent(database, {
            eventId: nextId("queue-event"),
            taskId: normalizedTaskId,
            operation: QueueProjectionOperation.UPSERT,
            entry: next,
            now: timestamp,
          });
          return Object.freeze({
            attempt,
            entry: next,
            newly_bound: true,
          });
        }).immediate();
      },
      async enqueue({
        taskId,
        priority = null,
        availableAt = undefined,
        payload = {},
        now = new Date(),
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot enqueue tasks");
        }

        const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
        const timestamp = toIsoTimestamp(now, "now");
        const normalizedAvailableAt = toIsoTimestamp(
          availableAt ?? timestamp,
          "availableAt",
        );
        const normalizedPriority = priority === null || priority === undefined
          ? null
          : Number(priority);

        if (normalizedPriority !== null && !Number.isInteger(normalizedPriority)) {
          throw new LifecycleSqliteError("priority must be an integer or null");
        }

        return database.transaction(() => {
          const current = queueEntryFromRow(database.prepare(
            "SELECT task_id, payload FROM lifecycle_queue WHERE task_id = ?",
          ).get(normalizedTaskId));
          const normalizedPayload = clone(ensurePlainObject(payload, "payload"));

          if (current) {
            return current;
          }

          const next = parseDurableQueueEntry({
            task_id: normalizedTaskId,
            state: DurableQueueState.PENDING,
            priority: normalizedPriority,
            available_at: normalizedAvailableAt,
            claimed_by: null,
            claim_expires_at: null,
            created_at: timestamp,
            updated_at: timestamp,
            version: 0,
            payload: normalizedPayload,
          });

          writeQueueEntry(database, next, {
            insert: true,
          });
          appendOutboxEvent(database, {
            eventId: nextId("queue-event"),
            taskId: normalizedTaskId,
            operation: QueueProjectionOperation.UPSERT,
            entry: next,
            now: timestamp,
          });
          return next;
        }).immediate();
      },
      async claimNext({
        holder,
        now = new Date(),
        ttlMs = 30_000,
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot claim tasks");
        }

        const normalizedHolder = ensureNonEmptyString(holder, "holder");
        const timestamp = toIsoTimestamp(now, "now");
        const expiresAt = addMilliseconds(timestamp, ttlMs);

        return database.transaction(() => {
          const row = database.prepare(`
            SELECT task_id, payload
            FROM lifecycle_queue
            WHERE available_at <= @now
              AND (
                state = 'PENDING'
                OR (
                  state = 'CLAIMED'
                  AND claim_expires_at IS NOT NULL
                  AND claim_expires_at <= @now
                )
              )
            ORDER BY
              CASE WHEN priority IS NULL THEN 1 ELSE 0 END ASC,
              priority ASC,
              available_at ASC,
              created_at ASC,
              task_id ASC
            LIMIT 1
          `).get({ now: timestamp });

          if (!row) {
            return null;
          }

          const current = queueEntryFromRow(row);
          const next = parseDurableQueueEntry({
            ...current,
            state: DurableQueueState.CLAIMED,
            claimed_by: normalizedHolder,
            claim_expires_at: expiresAt,
            updated_at: timestamp,
            version: current.version + 1,
          });
          writeQueueEntry(database, next, { expectedVersion: current.version });
          appendOutboxEvent(database, {
            eventId: nextId("queue-event"),
            taskId: next.task_id,
            operation: QueueProjectionOperation.UPSERT,
            entry: next,
            now: timestamp,
          });
          return next;
        }).immediate();
      },
      async heartbeatClaim({
        taskId,
        holder,
        now = new Date(),
        ttlMs = 30_000,
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot heartbeat claims");
        }

        const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
        const normalizedHolder = ensureNonEmptyString(holder, "holder");
        const timestamp = toIsoTimestamp(now, "now");
        const current = queueEntryFromRow(database.prepare(
          "SELECT task_id, payload FROM lifecycle_queue WHERE task_id = ?",
        ).get(normalizedTaskId));

        if (
          !current
          || current.state !== DurableQueueState.CLAIMED
          || current.claimed_by !== normalizedHolder
          || Date.parse(current.claim_expires_at) <= Date.parse(timestamp)
        ) {
          throw new AttemptLeaseConflictError(
            `queue claim ${normalizedTaskId} is not active for ${normalizedHolder}`,
            {
              holder: current?.claimed_by ?? null,
              expiresAt: current?.claim_expires_at ?? null,
            },
          );
        }

        const next = parseDurableQueueEntry({
          ...current,
          claim_expires_at: addMilliseconds(timestamp, ttlMs),
          updated_at: timestamp,
        });
        writeQueueClaim(database, next, current);
        return next;
      },
      async transition({
        taskId,
        expectedState,
        nextState,
        holder = null,
        availableAt = undefined,
        payloadPatch = {},
        now = new Date(),
      } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot transition queue");
        }

        if (!DURABLE_QUEUE_STATES.includes(nextState)) {
          throw new LifecycleSqliteError(
            `nextState must be one of: ${DURABLE_QUEUE_STATES.join(", ")}`,
          );
        }

        const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
        const timestamp = toIsoTimestamp(now, "now");
        const normalizedPayloadPatch = clone(
          ensurePlainObject(payloadPatch, "payloadPatch"),
        );
        const hasCancellationPatch = Object.prototype.hasOwnProperty.call(
          normalizedPayloadPatch,
          "cancel_request",
        );
        if (
          normalizedPayloadPatch.cancel_request
          && normalizedPayloadPatch.cancel_request.status === "REQUESTED"
        ) {
          throw new LifecycleSqliteError(
            "REQUESTED cancellation tombstones must use queue.requestCancellation",
            { code: "non_atomic_cancellation_request" },
          );
        }

        return database.transaction(() => {
          const current = queueEntryFromRow(database.prepare(
            "SELECT task_id, payload FROM lifecycle_queue WHERE task_id = ?",
          ).get(normalizedTaskId));

          if (!current) {
            throw new LifecycleSqliteError(`queue entry ${normalizedTaskId} not found`);
          }

          const persistedCancellation = current.payload?.cancel_request ?? null;
          const requestedCancellation = readRequestedCancellation(current);
          if (requestedCancellation) {
            const finalizedCancellation = normalizedPayloadPatch.cancel_request;
            if (
              !hasCancellationPatch
              || !finalizedCancellation
              || typeof finalizedCancellation !== "object"
              || Array.isArray(finalizedCancellation)
              || finalizedCancellation.status !== "FINALIZED"
              || finalizedCancellation.request_id !== requestedCancellation.request_id
              || nextState !== DurableQueueState.CANCELLED
            ) {
              throw new LifecycleSqliteError(
                `queue entry ${normalizedTaskId} has a pending durable cancellation`,
                { code: "lifecycle_cancellation_pending" },
              );
            }

            if (requestedCancellation.attempt_id) {
              const cancellationAttempt = readAttemptById(
                database,
                requestedCancellation.attempt_id,
              );
              if (
                !cancellationAttempt
                || cancellationAttempt.task_id !== normalizedTaskId
                || cancellationAttempt.stage !== "CANCELLED"
              ) {
                throw new LifecycleSqliteError(
                  `attempt ${requestedCancellation.attempt_id} must be CANCELLED before finalizing its queue tombstone`,
                  { code: "cancellation_attempt_not_terminal" },
                );
              }
              const cancellationPromotion = readPromotionByAttempt(
                database,
                requestedCancellation.attempt_id,
              );
              if (
                cancellationPromotion
                && cancellationPromotion.status !== PromotionStatus.FAILED
              ) {
                throw new LifecycleSqliteError(
                  `attempt ${requestedCancellation.attempt_id} has an active or completed promotion`,
                  { code: "cancellation_after_promotion_started" },
                );
              }
            }
          } else if (hasCancellationPatch) {
            if (normalizedPayloadPatch.cancel_request !== null) {
              throw new LifecycleSqliteError(
                "cancellation tombstones must be created atomically",
                { code: "non_atomic_cancellation_request" },
              );
            }
            if (
              persistedCancellation !== null
              && (
                persistedCancellation?.status !== "FINALIZED"
                || nextState !== DurableQueueState.PENDING
              )
            ) {
              throw new LifecycleSqliteError(
                `queue entry ${normalizedTaskId} cannot clear its cancellation tombstone`,
                { code: "lifecycle_cancel_request_conflict" },
              );
            }
          }

          if (current.state !== expectedState) {
            throw new AttemptConcurrencyError(
              `queue entry ${normalizedTaskId} expected ${expectedState}, found ${current.state}`,
            );
          }

          if (holder !== null && current.claimed_by !== holder) {
            throw new AttemptLeaseConflictError(
              `queue entry ${normalizedTaskId} is not claimed by ${holder}`,
              {
                holder: current.claimed_by,
                expiresAt: current.claim_expires_at,
              },
            );
          }
          if (
            holder === null
            && current.state === DurableQueueState.CLAIMED
            && current.claimed_by !== null
            && current.claim_expires_at
            && Date.parse(current.claim_expires_at) > Date.parse(timestamp)
          ) {
            throw new AttemptLeaseConflictError(
              `queue entry ${normalizedTaskId} has an active claim and cannot be changed externally`,
              {
                holder: current.claimed_by,
                expiresAt: current.claim_expires_at,
              },
            );
          }

          const next = parseDurableQueueEntry({
            ...current,
            state: nextState,
            available_at: availableAt === undefined
              ? current.available_at
              : toIsoTimestamp(availableAt, "availableAt"),
            claimed_by: nextState === DurableQueueState.CLAIMED
              ? current.claimed_by
              : null,
            claim_expires_at: nextState === DurableQueueState.CLAIMED
              ? current.claim_expires_at
              : null,
            updated_at: timestamp,
            version: current.version + 1,
            payload: {
              ...current.payload,
              ...normalizedPayloadPatch,
            },
          });
          writeQueueEntry(database, next, { expectedVersion: current.version });
          appendOutboxEvent(database, {
            eventId: nextId("queue-event"),
            taskId: normalizedTaskId,
            operation: QueueProjectionOperation.UPSERT,
            entry: next,
            now: timestamp,
          });
          return next;
        }).immediate();
      },
      async remove({ taskId, now = new Date() } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot remove queue entries");
        }

        const normalizedTaskId = ensureNonEmptyString(taskId, "taskId");
        const timestamp = toIsoTimestamp(now, "now");

        return database.transaction(() => {
          const activeAttempt = attemptFromRow(database.prepare(`
            SELECT id, payload
            FROM task_attempts
            WHERE task_id = ? AND stage IN (${ACTIVE_ATTEMPT_STAGES.map(() => "?").join(", ")})
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `).get(normalizedTaskId, ...ACTIVE_ATTEMPT_STAGES));
          if (activeAttempt) {
            throw new AttemptConcurrencyError(
              `queue entry ${normalizedTaskId} cannot be removed while attempt `
              + `${activeAttempt.id} is active at ${activeAttempt.stage}`,
            );
          }

          const current = queueEntryFromRow(database.prepare(
            "SELECT task_id, payload FROM lifecycle_queue WHERE task_id = ?",
          ).get(normalizedTaskId));

          if (!current) {
            return null;
          }
          if (current.state === DurableQueueState.CLAIMED) {
            throw new AttemptLeaseConflictError(
              `queue entry ${normalizedTaskId} cannot be removed while it is claimed`,
              {
                expiresAt: current.claim_expires_at,
                holder: current.claimed_by,
              },
            );
          }

          database.prepare("DELETE FROM lifecycle_queue WHERE task_id = ?")
            .run(normalizedTaskId);
          appendOutboxEvent(database, {
            eventId: nextId("queue-event"),
            taskId: normalizedTaskId,
            operation: QueueProjectionOperation.REMOVE,
            entry: null,
            now: timestamp,
          });
          return current;
        }).immediate();
      },
      async byTask(taskId) {
        return queueEntryFromRow(database.prepare(
          "SELECT task_id, payload FROM lifecycle_queue WHERE task_id = ?",
        ).get(ensureNonEmptyString(taskId, "taskId")));
      },
      async list() {
        return database.prepare(`
          SELECT task_id, payload
          FROM lifecycle_queue
          ORDER BY
            CASE WHEN priority IS NULL THEN 1 ELSE 0 END ASC,
            priority ASC,
            available_at ASC,
            created_at ASC,
            task_id ASC
        `).all().map(queueEntryFromRow);
      },
    },
    outbox: {
      async list() {
        return database.prepare(`
          SELECT sequence_id, event_id, task_id, operation, created_at,
                 delivered_at, delivery_attempts, last_error, payload
          FROM queue_projection_outbox
          ORDER BY sequence_id ASC
        `).all().map(outboxEventFromRow);
      },
      async listPending({ limit = 100 } = {}) {
        const safeLimit = ensurePositiveInteger(limit, "limit");

        return database.prepare(`
          SELECT sequence_id, event_id, task_id, operation, created_at,
                 delivered_at, delivery_attempts, last_error, payload
          FROM queue_projection_outbox
          WHERE delivered_at IS NULL
          ORDER BY sequence_id ASC
          LIMIT ?
        `).all(safeLimit).map(outboxEventFromRow);
      },
      async markDelivered({ eventId, now = new Date() } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot update outbox");
        }

        const normalizedEventId = ensureNonEmptyString(eventId, "eventId");
        const timestamp = toIsoTimestamp(now, "now");
        const result = database.prepare(`
          UPDATE queue_projection_outbox
          SET delivered_at = @delivered_at,
              delivery_attempts = delivery_attempts + 1,
              last_error = NULL
          WHERE event_id = @event_id AND delivered_at IS NULL
        `).run({
          event_id: normalizedEventId,
          delivered_at: timestamp,
        });

        return result.changes === 1;
      },
      async markFailed({ eventId, error } = {}) {
        if (readonly) {
          throw new LifecycleSqliteError("readonly lifecycle store cannot update outbox");
        }

        const result = database.prepare(`
          UPDATE queue_projection_outbox
          SET delivery_attempts = delivery_attempts + 1,
              last_error = @last_error
          WHERE event_id = @event_id AND delivered_at IS NULL
        `).run({
          event_id: ensureNonEmptyString(eventId, "eventId"),
          last_error: ensureNonEmptyString(error, "error"),
        });

        return result.changes === 1;
      },
    },
    compatibility() {
      return inspectLifecycleSchemaCompatibility({ databasePath: resolvedPath });
    },
    close() {
      database.close();
    },
  };

  return Object.freeze(store);
}

const createTaskAttemptStore = createLifecycleSqliteStore;

export {
  AttemptConcurrencyError,
  AttemptLeaseConflictError,
  ExecutionLeaseConflictError,
  LIFECYCLE_SCHEMA_METADATA_KEY,
  LIFECYCLE_SQLITE_SCHEMA_VERSION,
  LifecycleSqliteError,
  REQUIRED_LIFECYCLE_TABLES,
  createLifecycleSqliteStore,
  createTaskAttemptStore,
  inspectLifecycleSchemaCompatibility,
  migrateLifecycleSqliteSchema,
};
