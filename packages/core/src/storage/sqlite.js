import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { assertStorageImplementation } from "../contracts/storage.js";
import { buildOperationalMetricsView } from "../observability/index.js";
import { parseAgentEntity } from "../schemas/agent.js";
import { parseAssignmentReason } from "../schemas/assignment.js";
import { parseApprovalRecord } from "../schemas/approval.js";
import { parseBlockerArtifact } from "../schemas/blocker.js";
import { parseCheckpoint } from "../schemas/checkpoint.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseEvidencePacket } from "../schemas/evidence.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { parseGoalRecord } from "../schemas/goal.js";
import { parseTaskIngressRecord } from "../schemas/ingress.js";
import { parseRunRecord } from "../schemas/run.js";
import { parseTaskContentRevision } from "../schemas/task-content-revision.js";
import { parseTaskLiveExcerpt } from "../schemas/task-live-excerpt.js";
import { parseTaskRunEvent } from "../schemas/task-run-event.js";
import { parseTaskRunSession } from "../schemas/task-run-session.js";
import { parseTaskSession } from "../schemas/task-session.js";
import { parseTaskNote } from "../schemas/task-note.js";
import { parseTaskRecord } from "../schemas/task.js";
import { parseReviewVerdict } from "../schemas/verdict.js";
import { parseLeaseRecord } from "../scheduler/lease.js";
import { parseQueueItem, toIsoTimestamp } from "../scheduler/queue.js";
import {
  DEFAULT_RUN_LOG_INLINE_BYTES,
  createStoredRunLogRecord,
  hydrateRunLogRecord,
  normalizeRunLogRecord,
} from "./run-logs.js";

class SqliteStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = "SqliteStorageError";
  }
}

const SQLITE_DEFAULT_FILENAME = "niis-v1.sqlite";





const SQLITE_SCHEMA_VERSION = 4;

function clone(value) {
  return structuredClone(value);
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SqliteStorageError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function createSqliteDatabasePath(stateRoot) {
  return path.join(stateRoot, "db", SQLITE_DEFAULT_FILENAME);
}

function deriveStateRootFromDatabasePath(databasePath) {
  return path.resolve(path.dirname(path.dirname(databasePath)));
}

function ensureDatabaseDirectory(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
}

function initializeSqliteSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, goal_id TEXT, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_tasks_goal_id ON tasks(goal_id);
    CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, status TEXT NOT NULL, health_status TEXT NOT NULL, last_run_at TEXT, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, event_type TEXT NOT NULL, timestamp TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id);
    CREATE TABLE IF NOT EXISTS ingress (id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, detected_at TEXT NOT NULL, ingress_status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_ingress_source_ref ON ingress(source_ref);
    CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, assigned_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_assignments_task_id ON assignments(task_id);
    CREATE TABLE IF NOT EXISTS queue_writes (sequence_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, operation TEXT NOT NULL, written_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lease_writes (sequence_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, written_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_sessions (task_key TEXT PRIMARY KEY, last_run_id TEXT, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_run_sessions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_task_run_sessions_task_id ON task_run_sessions(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_run_sessions_run_id ON task_run_sessions(run_id);
    CREATE TABLE IF NOT EXISTS task_run_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, ts TEXT NOT NULL, event_type TEXT NOT NULL, visibility TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_task_run_events_task_id ON task_run_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_run_events_run_id ON task_run_events(run_id);
    CREATE TABLE IF NOT EXISTS task_live_excerpts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, ts TEXT NOT NULL, channel TEXT NOT NULL, level TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_task_live_excerpts_task_id ON task_live_excerpts(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_live_excerpts_run_id ON task_live_excerpts(run_id);
    CREATE TABLE IF NOT EXISTS task_content_revisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_task_content_revisions_task_id ON task_content_revisions(task_id);
    CREATE TABLE IF NOT EXISTS run_logs (run_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_notes (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_task_notes_task_id ON task_notes(task_id);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, action_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, approved_at TEXT, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_approvals_task_id ON approvals(task_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    CREATE TABLE IF NOT EXISTS verdicts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, verdict_class TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, verdict_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_evidence_verdict_id ON evidence(verdict_id);
    CREATE TABLE IF NOT EXISTS blockers (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, blocker_class TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_blockers_resolved_at ON blockers(resolved_at);
    CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS explainability (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, timestamp TEXT NOT NULL, decision_type TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_explainability_task_id ON explainability(task_id);
    CREATE TABLE IF NOT EXISTS role_monthly_spend (role_id TEXT NOT NULL, period_yyyy_mm TEXT NOT NULL, spent_usd REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (role_id, period_yyyy_mm));
    CREATE INDEX IF NOT EXISTS idx_role_monthly_spend_role_id ON role_monthly_spend(role_id);
  `);
  database.prepare(`
    INSERT INTO metadata (key, value) VALUES ('schema_version', @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({ value: String(SQLITE_SCHEMA_VERSION) });
}

function openSqliteDatabase({ databasePath, readonly = false }) {
  const resolvedPath = path.resolve(ensureNonEmptyString(databasePath, "databasePath"));

  if (!readonly) {
    ensureDatabaseDirectory(resolvedPath);
  } else if (!fs.existsSync(resolvedPath)) {
    throw new SqliteStorageError(`SQLite database does not exist: ${resolvedPath}`);
  }

  const database = new Database(resolvedPath, { readonly });
  database.pragma("foreign_keys = ON");

  if (!readonly) {
    database.pragma("journal_mode = WAL");
    initializeSqliteSchema(database);
  }

  return {
    database,
    databasePath: resolvedPath,
  };
}

function readSqliteStorageMetadata({ databasePath } = {}) {
  const resolvedPath = path.resolve(ensureNonEmptyString(databasePath, "databasePath"));

  if (!fs.existsSync(resolvedPath)) {
    return Object.freeze({
      database_path: resolvedPath,
      exists: false,
      schema_version: null,
      state_root: deriveStateRootFromDatabasePath(resolvedPath),
    });
  }

  const opened = openSqliteDatabase({ databasePath: resolvedPath, readonly: true });

  try {
    return Object.freeze({
      database_path: opened.databasePath,
      exists: true,
      schema_version:
        opened.database.prepare(`
          SELECT value FROM metadata WHERE key = 'schema_version'
        `).get()?.value ?? null,
      state_root: deriveStateRootFromDatabasePath(opened.databasePath),
    });
  } finally {
    opened.database.close();
  }
}

function parsePayloadRow(row, parse, label) {
  if (!row) {
    return null;
  }

  try {
    return clone(parse(JSON.parse(row.payload)));
  } catch (error) {
    throw new SqliteStorageError(`Failed to parse ${label}: ${error.message}`);
  }
}

function parsePayloadRows(rows, parse, label) {
  return rows.map((row, index) => parsePayloadRow(row, parse, `${label}[${index}]`));
}

function writePayloadRecord(database, { table, keyColumn, keyValue, payload, columns = {} }) {
  const columnNames = [keyColumn, ...Object.keys(columns), "payload"];
  const values = {
    [keyColumn]: keyValue,
    ...columns,
    payload: JSON.stringify(payload),
  };
  const placeholders = columnNames.map((columnName) => `@${columnName}`).join(", ");
  const assignments = [...Object.keys(columns), "payload"]
    .map((columnName) => `${columnName} = excluded.${columnName}`)
    .join(", ");

  database.prepare(`
    INSERT INTO ${table} (${columnNames.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT(${keyColumn}) DO UPDATE SET ${assignments}
  `).run(values);
}

function readPayloadByKey(database, { table, keyColumn, keyValue, parse, label }) {
  return parsePayloadRow(
    database.prepare(`SELECT payload FROM ${table} WHERE ${keyColumn} = ?`).get(keyValue) ?? null,
    parse,
    label,
  );
}

function readPayloadList(database, { sql, params = [], parse, label }) {
  return parsePayloadRows(database.prepare(sql).all(...params), parse, label);
}

function listQueueWrites(database) {
  return database.prepare(`
    SELECT payload FROM queue_writes ORDER BY sequence_id ASC
  `).all().map((row, index) => parsePayloadRow(row, parseQueueItem, `queue_writes[${index}]`));
}

function listLeaseWrites(database) {
  return database.prepare(`
    SELECT payload FROM lease_writes ORDER BY sequence_id ASC
  `).all().map((row, index) => parsePayloadRow(row, parseLeaseRecord, `lease_writes[${index}]`));
}

function listAvailableTables(database) {
  return new Set(
    database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map((row) => row.name),
  );
}

function tableExists(availableTables, tableName) {
  return availableTables.has(tableName);
}

function createSqliteStorage({
  databasePath,
  readonly = false,
  runLogInlineBytes = DEFAULT_RUN_LOG_INLINE_BYTES,
  stateRoot = null,
} = {}) {
  const opened = openSqliteDatabase({ databasePath, readonly });
  const { database } = opened;
  const resolvedStateRoot = path.resolve(stateRoot ?? deriveStateRootFromDatabasePath(opened.databasePath));
  const normalizedRunLogInlineBytes = Number(runLogInlineBytes);
  const availableTables = listAvailableTables(database);

  const storage = {
    kind: "sqlite",
    databasePath: opened.databasePath,
    stateRoot: resolvedStateRoot,
    tasks: {
      async upsert(task) {
        const normalized = parseTaskRecord(task);
        writePayloadRecord(database, {
          table: "tasks",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: {
            goal_id: normalized.goal_id,
            updated_at: normalized.updated_at,
          },
        });
        return clone(normalized);
      },
      async list() {
        return readPayloadList(database, {
          sql: "SELECT payload FROM tasks ORDER BY updated_at ASC, id ASC",
          parse: parseTaskRecord,
          label: "tasks",
        });
      },
      async byGoal(goalId) {
        return readPayloadList(database, {
          sql: "SELECT payload FROM tasks WHERE goal_id IS ? ORDER BY updated_at ASC, id ASC",
          params: [goalId ?? null],
          parse: parseTaskRecord,
          label: "tasks.byGoal",
        });
      },
      async deleteById(taskId) {
        if (typeof taskId !== "string" || taskId.trim() === "") return { deleted: [] };
        const runIds = database.prepare("SELECT id FROM runs WHERE task_id = ?").all(taskId).map((r) => r.id);
        const verdictIds = database.prepare("SELECT id FROM verdicts WHERE task_id = ?").all(taskId).map((r) => r.id);
        const tx = database.transaction(() => {
          const counts = {};
          const tables = [
            "runs", "events", "assignments", "queue_writes", "lease_writes",
            "task_run_sessions", "task_run_events", "task_live_excerpts",
            "task_content_revisions", "task_notes", "approvals", "verdicts",
            "blockers", "explainability",
          ];
          for (const table of tables) {
            const info = database.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(taskId);
            if (info.changes > 0) counts[table] = info.changes;
          }
          if (runIds.length > 0) {
            const placeholders = runIds.map(() => "?").join(",");
            const checkpointInfo = database.prepare(`DELETE FROM checkpoints WHERE run_id IN (${placeholders})`).run(...runIds);
            if (checkpointInfo.changes > 0) counts.checkpoints = checkpointInfo.changes;
            const runLogInfo = database.prepare(`DELETE FROM run_logs WHERE run_id IN (${placeholders})`).run(...runIds);
            if (runLogInfo.changes > 0) counts.run_logs = runLogInfo.changes;
          }
          if (verdictIds.length > 0) {
            const placeholders = verdictIds.map(() => "?").join(",");
            const evidenceInfo = database.prepare(`DELETE FROM evidence WHERE verdict_id IN (${placeholders})`).run(...verdictIds);
            if (evidenceInfo.changes > 0) counts.evidence = evidenceInfo.changes;
          }
          const taskInfo = database.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
          if (taskInfo.changes > 0) counts.tasks = taskInfo.changes;
          return counts;
        });
        const counts = tx();
        return { counts, deleted: Object.keys(counts) };
      },
    },
    goals: {
      async upsert(goal) {
        const normalized = parseGoalRecord(goal);
        writePayloadRecord(database, {
          table: "goals",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: { updated_at: normalized.updated_at },
        });
        return clone(normalized);
      },
      async byId(goalId) {
        return readPayloadByKey(database, {
          table: "goals",
          keyColumn: "id",
          keyValue: goalId,
          parse: parseGoalRecord,
          label: "goals.byId",
        });
      },
      async list() {
        return readPayloadList(database, {
          sql: "SELECT payload FROM goals ORDER BY updated_at ASC, id ASC",
          parse: parseGoalRecord,
          label: "goals.list",
        });
      },
    },
    agents: {
      async upsert(agent) {
        const normalized = parseAgentEntity(agent);
        writePayloadRecord(database, {
          table: "agents",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: {
            health_status: normalized.health_status,
            last_run_at: normalized.last_run_at,
            status: normalized.status,
            updated_at: normalized.updated_at,
          },
        });
        return clone(normalized);
      },
      async updateStatus(agentId, update) {
        const current = await storage.agents.byId(agentId);
        if (!current) {
          throw new SqliteStorageError(`agent ${agentId} not found`);
        }

        const normalized = parseAgentEntity({
          ...current,
          ...clone(update),
          updated_at: toIsoTimestamp(update?.updated_at ?? new Date(), "updated_at"),
        });
        return storage.agents.upsert(normalized);
      },
      async accumulateCost(agentId, cost) {
        const current = await storage.agents.byId(agentId);
        if (!current) {
          throw new SqliteStorageError(`agent ${agentId} not found`);
        }

        return storage.agents.upsert(parseAgentEntity({
          ...current,
          accumulated: {
            total_cost_usd: current.accumulated.total_cost_usd + Number(cost?.estimated_usd ?? 0),
            total_runs: current.accumulated.total_runs + 1,
            total_tokens_in: current.accumulated.total_tokens_in + Number(cost?.tokens_in ?? 0),
            total_tokens_out: current.accumulated.total_tokens_out + Number(cost?.tokens_out ?? 0),
          },
          budget_monthly: current.budget_monthly
            ? {
              ...current.budget_monthly,
              spent_usd: current.budget_monthly.spent_usd + Number(cost?.estimated_usd ?? 0),
            }
            : null,
          updated_at: toIsoTimestamp(new Date(), "updated_at"),
        }));
      },
      async list() {
        return readPayloadList(database, {
          sql: "SELECT payload FROM agents ORDER BY updated_at ASC, id ASC",
          parse: parseAgentEntity,
          label: "agents.list",
        });
      },
      async byId(agentId) {
        return readPayloadByKey(database, {
          table: "agents",
          keyColumn: "id",
          keyValue: agentId,
          parse: parseAgentEntity,
          label: "agents.byId",
        });
      },
      async health() {
        return database.prepare(`
          SELECT id, health_status, last_run_at FROM agents ORDER BY id ASC
        `).all().map((row) => ({
          health_status: row.health_status,
          id: row.id,
          last_run_at: row.last_run_at,
        }));
      },
    },
    runs: {
      async upsert(run) {
        const normalized = parseRunRecord(run);
        writePayloadRecord(database, {
          table: "runs",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: {
            finished_at: normalized.finished_at,
            started_at: normalized.started_at,
            task_id: normalized.task_id,
          },
        });
        return clone(normalized);
      },
      async byTask(taskId) {
        return readPayloadList(database, {
          sql: "SELECT payload FROM runs WHERE task_id = ? ORDER BY started_at ASC, id ASC",
          params: [taskId],
          parse: parseRunRecord,
          label: "runs.byTask",
        });
      },
    },
    events: {
      async append(event) {
        const normalized = parseEventLogEntry(event);
        database.prepare(`
          INSERT INTO events (id, run_id, task_id, event_type, timestamp, actor, payload)
          VALUES (@id, @run_id, @task_id, @event_type, @timestamp, @actor, @payload)
          ON CONFLICT(id) DO NOTHING
        `).run({
          actor: normalized.actor,
          event_type: normalized.event_type,
          id: normalized.id,
          payload: JSON.stringify(normalized),
          run_id: normalized.run_id,
          task_id: normalized.task_id,
          timestamp: normalized.timestamp,
        });
        return clone(normalized);
      },
    },
    ingress: {
      async record(ingressRecord) {
        const normalized = parseTaskIngressRecord(ingressRecord);
        writePayloadRecord(database, {
          table: "ingress",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: {
            detected_at: normalized.detected_at,
            ingress_status: normalized.ingress_status,
            source_ref: normalized.source_ref,
          },
        });
        return clone(normalized);
      },
      async byTask(taskId) {
        return readPayloadList(database, {
          sql: "SELECT payload FROM ingress WHERE source_ref = ? ORDER BY detected_at ASC, id ASC",
          params: [`task:${taskId}`],
          parse: parseTaskIngressRecord,
          label: "ingress.byTask",
        });
      },
    },
    assignments: {
      async record(assignment) {
        const normalized = parseAssignmentReason(assignment);
        writePayloadRecord(database, {
          table: "assignments",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: {
            assigned_at: normalized.assigned_at,
            task_id: normalized.task_id,
          },
        });
        return clone(normalized);
      },
      async byTask(taskId) {
        return readPayloadList(database, {
          sql: "SELECT payload FROM assignments WHERE task_id = ? ORDER BY assigned_at ASC, id ASC",
          params: [taskId],
          parse: parseAssignmentReason,
          label: "assignments.byTask",
        });
      },
    },
    queue: {
      async enqueue(item) {
        const normalized = parseQueueItem(item);
        database.prepare(`
          INSERT INTO queue_writes (task_id, operation, written_at, payload)
          VALUES (@task_id, 'enqueue', @written_at, @payload)
        `).run({
          payload: JSON.stringify(normalized),
          task_id: normalized.task_id,
          written_at: normalized.queued_at,
        });
        return clone(normalized);
      },
      async claimNext(item) {
        const normalized = parseQueueItem(item);
        database.prepare(`
          INSERT INTO queue_writes (task_id, operation, written_at, payload)
          VALUES (@task_id, 'claimNext', @written_at, @payload)
        `).run({
          payload: JSON.stringify(normalized),
          task_id: normalized.task_id,
          written_at: normalized.queued_at,
        });
        return clone(normalized);
      },
    },
    leases: {
      async acquireOrRenew(lease) {
        const normalized = parseLeaseRecord(lease);
        database.prepare(`
          INSERT INTO lease_writes (task_id, written_at, payload)
          VALUES (@task_id, @written_at, @payload)
        `).run({
          payload: JSON.stringify(normalized),
          task_id: normalized.task_id,
          written_at: normalized.acquired_at,
        });
        return clone(normalized);
      },
    },
    taskSessions: {
      async upsert(taskSession) {
        const normalized = parseTaskSession(taskSession);
        writePayloadRecord(database, {
          table: "task_sessions",
          keyColumn: "task_key",
          keyValue: normalized.task_key,
          payload: normalized,
          columns: {
            last_run_id: normalized.last_run_id,
            updated_at: normalized.updated_at,
          },
        });
        return clone(normalized);
      },
      async getByKey(taskKey) {
        return readPayloadByKey(database, {
          table: "task_sessions",
          keyColumn: "task_key",
          keyValue: taskKey,
          parse: parseTaskSession,
          label: "taskSessions.getByKey",
        });
      },
      async byTaskKey(taskKey) {
        const record = await storage.taskSessions.getByKey(taskKey);
        return record ? [record] : [];
      },
    },
    taskRunSessions: {
      async upsert(taskRunSession) {
        const normalized = parseTaskRunSession(taskRunSession);
        writePayloadRecord(database, {
          table: "task_run_sessions",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: {
            run_id: normalized.run_id,
            status: normalized.status,
            task_id: normalized.task_id,
            updated_at: normalized.updated_at,
          },
        });
        return clone(normalized);
      },
      async byTask(taskId) {
        if (!tableExists(availableTables, "task_run_sessions")) {
          return [];
        }
        return readPayloadList(database, {
          sql: "SELECT payload FROM task_run_sessions WHERE task_id = ? ORDER BY updated_at ASC, id ASC",
          params: [taskId],
          parse: parseTaskRunSession,
          label: "taskRunSessions.byTask",
        });
      },
      async byRun(runId) {
        if (!tableExists(availableTables, "task_run_sessions")) {
          return [];
        }
        return readPayloadList(database, {
          sql: "SELECT payload FROM task_run_sessions WHERE run_id = ? ORDER BY updated_at ASC, id ASC",
          params: [runId],
          parse: parseTaskRunSession,
          label: "taskRunSessions.byRun",
        });
      },
    },
    taskRunEvents: {
      async append(taskRunEvent) {
        const normalized = parseTaskRunEvent(taskRunEvent);
        database.prepare(`
          INSERT INTO task_run_events (id, task_id, run_id, ts, event_type, visibility, payload)
          VALUES (@id, @task_id, @run_id, @ts, @event_type, @visibility, @payload)
          ON CONFLICT(id) DO NOTHING
        `).run({
          event_type: normalized.event_type,
          id: normalized.id,
          payload: JSON.stringify(normalized),
          run_id: normalized.run_id,
          task_id: normalized.task_id,
          ts: normalized.ts,
          visibility: normalized.visibility,
        });
        return clone(normalized);
      },
      async byTask(taskId) {
        if (!tableExists(availableTables, "task_run_events")) {
          return [];
        }
        return readPayloadList(database, {
          sql: "SELECT payload FROM task_run_events WHERE task_id = ? ORDER BY ts ASC, id ASC",
          params: [taskId],
          parse: parseTaskRunEvent,
          label: "taskRunEvents.byTask",
        });
      },
      async byRun(runId) {
        if (!tableExists(availableTables, "task_run_events")) {
          return [];
        }
        return readPayloadList(database, {
          sql: "SELECT payload FROM task_run_events WHERE run_id = ? ORDER BY ts ASC, id ASC",
          params: [runId],
          parse: parseTaskRunEvent,
          label: "taskRunEvents.byRun",
        });
      },






      async byTaskFiltered({ taskId, afterTs = null, eventTypes = null, limit = 500 }) {
        if (!tableExists(availableTables, "task_run_events")) return [];
        const clauses = ["task_id = ?"];
        const params = [taskId];
        if (typeof afterTs === "string" && afterTs !== "") {
          clauses.push("ts > ?");
          params.push(afterTs);
        }
        if (Array.isArray(eventTypes) && eventTypes.length > 0) {
          clauses.push(`event_type IN (${eventTypes.map(() => "?").join(", ")})`);
          for (const entry of eventTypes) params.push(entry);
        }
        const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
        const sql = `SELECT payload FROM task_run_events WHERE ${clauses.join(" AND ")} ORDER BY ts ASC, id ASC LIMIT ${safeLimit}`;
        return readPayloadList(database, {
          sql,
          params,
          parse: parseTaskRunEvent,
          label: "taskRunEvents.byTaskFiltered",
        });
      },
    },
    taskLiveExcerpts: {
      async append(taskLiveExcerpt) {
        const normalized = parseTaskLiveExcerpt(taskLiveExcerpt);
        database.prepare(`
          INSERT INTO task_live_excerpts (id, task_id, run_id, ts, channel, level, payload)
          VALUES (@id, @task_id, @run_id, @ts, @channel, @level, @payload)
          ON CONFLICT(id) DO NOTHING
        `).run({
          channel: normalized.channel,
          id: normalized.id,
          level: normalized.level,
          payload: JSON.stringify(normalized),
          run_id: normalized.run_id,
          task_id: normalized.task_id,
          ts: normalized.ts,
        });
        return clone(normalized);
      },
      async byTask(taskId) {
        if (!tableExists(availableTables, "task_live_excerpts")) {
          return [];
        }
        return readPayloadList(database, {
          sql: "SELECT payload FROM task_live_excerpts WHERE task_id = ? ORDER BY ts ASC, id ASC",
          params: [taskId],
          parse: parseTaskLiveExcerpt,
          label: "taskLiveExcerpts.byTask",
        });
      },
      async byRun(runId) {
        if (!tableExists(availableTables, "task_live_excerpts")) {
          return [];
        }
        return readPayloadList(database, {
          sql: "SELECT payload FROM task_live_excerpts WHERE run_id = ? ORDER BY ts ASC, id ASC",
          params: [runId],
          parse: parseTaskLiveExcerpt,
          label: "taskLiveExcerpts.byRun",
        });
      },
    },
    taskContentRevisions: {
      async append(taskContentRevision) {
        const normalized = parseTaskContentRevision(taskContentRevision);
        database.prepare(`
          INSERT INTO task_content_revisions (id, task_id, created_at, payload)
          VALUES (@id, @task_id, @created_at, @payload)
          ON CONFLICT(id) DO NOTHING
        `).run({
          created_at: normalized.created_at,
          id: normalized.id,
          payload: JSON.stringify(normalized),
          task_id: normalized.task_id,
        });
        return clone(normalized);
      },
      async byTask(taskId) {
        if (!tableExists(availableTables, "task_content_revisions")) {
          return [];
        }
        return readPayloadList(database, {
          sql: "SELECT payload FROM task_content_revisions WHERE task_id = ? ORDER BY created_at ASC, id ASC",
          params: [taskId],
          parse: parseTaskContentRevision,
          label: "taskContentRevisions.byTask",
        });
      },
    },
    runLogs: {
      async store(runLog) {
        const normalized = createStoredRunLogRecord({
          inlineBytes: normalizedRunLogInlineBytes,
          rawOutput: runLog?.raw_output,
          runId: runLog?.run_id,
          stateRoot: resolvedStateRoot,
        });
        writePayloadRecord(database, {
          table: "run_logs",
          keyColumn: "run_id",
          keyValue: normalized.run_id,
          payload: normalized,
        });
        return clone(normalized);
      },
      async getByRunId(runId) {
        const row = database.prepare("SELECT payload FROM run_logs WHERE run_id = ?").get(runId) ?? null;

        if (!row) {
          return null;
        }

        return hydrateRunLogRecord(JSON.parse(row.payload), {
          stateRoot: resolvedStateRoot,
        });
      },
      async byRun(runId) {
        const runLog = await storage.runLogs.getByRunId(runId);
        return runLog ? [runLog] : [];
      },
    },
    taskNotes: {
      async append(taskNote) {
        const normalized = parseTaskNote(taskNote);
        writePayloadRecord(database, {
          table: "task_notes",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: {
            created_at: normalized.created_at,
            task_id: normalized.task_id,
          },
        });
        return clone(normalized);
      },
      async byTask(taskId) {
        return readPayloadList(database, {
          sql: "SELECT payload FROM task_notes WHERE task_id = ? ORDER BY created_at ASC, id ASC",
          params: [taskId],
          parse: parseTaskNote,
          label: "taskNotes.byTask",
        });
      },
    },
    approvals: {
      async upsert(approval) {
        const normalized = parseApprovalRecord(approval);
        writePayloadRecord(database, {
          table: "approvals",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: {
            action_id: normalized.action_id,
            approved_at: normalized.approved_at,
            created_at: normalized.created_at,
            status: normalized.status,
            task_id: normalized.task_id,
          },
        });
        return clone(normalized);
      },
      async byTask(taskId) {
        return readPayloadList(database, {
          sql: "SELECT payload FROM approvals WHERE task_id = ? ORDER BY created_at ASC, id ASC",
          params: [taskId],
          parse: parseApprovalRecord,
          label: "approvals.byTask",
        });
      },
      async listPending() {
        return readPayloadList(database, {
          sql: "SELECT payload FROM approvals WHERE status = 'PENDING' ORDER BY created_at ASC, id ASC",
          parse: parseApprovalRecord,
          label: "approvals.listPending",
        });
      },
    },
    verdicts: {
      async record(verdict) {
        const normalized = parseReviewVerdict(verdict);
        writePayloadRecord(database, {
          table: "verdicts",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: {
            created_at: normalized.created_at,
            run_id: normalized.run_id,
            task_id: normalized.task_id,
            verdict_class: normalized.verdict_class,
          },
        });
        return clone(normalized);
      },
    },
    evidence: {
      async savePacket(packet) {
        const normalized = parseEvidencePacket(packet);
        writePayloadRecord(database, {
          table: "evidence",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: { verdict_id: normalized.verdict_id },
        });
        return clone(normalized);
      },
      async byVerdict(verdictId) {
        return readPayloadList(database, {
          sql: "SELECT payload FROM evidence WHERE verdict_id = ? ORDER BY id ASC",
          params: [verdictId],
          parse: parseEvidencePacket,
          label: "evidence.byVerdict",
        });
      },
    },
    blockers: {
      async upsert(blocker) {
        const normalized = parseBlockerArtifact(blocker);
        writePayloadRecord(database, {
          table: "blockers",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: {
            blocker_class: normalized.blocker_class,
            created_at: normalized.created_at,
            resolved_at: normalized.resolved_at,
            task_id: normalized.task_id,
          },
        });
        return clone(normalized);
      },
      async active() {
        return readPayloadList(database, {
          sql: "SELECT payload FROM blockers WHERE resolved_at IS NULL ORDER BY created_at ASC, id ASC",
          parse: parseBlockerArtifact,
          label: "blockers.active",
        });
      },
    },
    checkpoints: {
      async save(checkpoint) {
        const normalized = parseCheckpoint(checkpoint);
        writePayloadRecord(database, {
          table: "checkpoints",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: {
            created_at: normalized.created_at,
            run_id: normalized.run_id,
          },
        });
        return clone(normalized);
      },
    },
    explainability: {
      async record(record) {
        const normalized = parseExplainabilityRecord(record);
        writePayloadRecord(database, {
          table: "explainability",
          keyColumn: "id",
          keyValue: normalized.id,
          payload: normalized,
          columns: {
            decision_type: normalized.decision_type,
            task_id: normalized.task_id,
            timestamp: normalized.timestamp,
          },
        });
        return clone(normalized);
      },
    },
    decisions: {
      async explain(taskId) {
        return readPayloadList(database, {
          sql: "SELECT payload FROM explainability WHERE task_id = ? ORDER BY timestamp ASC, id ASC",
          params: [taskId],
          parse: parseExplainabilityRecord,
          label: "decisions.explain",
        });
      },
    },
    roleMonthlySpend: {
      async accumulate(roleId, period, deltaUsd, now = new Date()) {
        if (!tableExists(availableTables, "role_monthly_spend")) return;
        const updatedAt = new Date(now).toISOString();
        database.prepare(`
          INSERT INTO role_monthly_spend (role_id, period_yyyy_mm, spent_usd, updated_at)
          VALUES (@role_id, @period, @delta, @updated_at)
          ON CONFLICT(role_id, period_yyyy_mm) DO UPDATE SET
            spent_usd = spent_usd + @delta,
            updated_at = @updated_at
        `).run({
          delta: Number(deltaUsd) || 0,
          period,
          role_id: roleId,
          updated_at: updatedAt,
        });
      },
      async getSpend(roleId, period) {
        if (!tableExists(availableTables, "role_monthly_spend")) return 0;
        const row = database.prepare(`
          SELECT spent_usd FROM role_monthly_spend
          WHERE role_id = ? AND period_yyyy_mm = ?
        `).get(roleId, period);
        return row?.spent_usd ?? 0;
      },
      async list() {
        if (!tableExists(availableTables, "role_monthly_spend")) return [];
        return database.prepare(`
          SELECT role_id, period_yyyy_mm, spent_usd, updated_at
          FROM role_monthly_spend
          ORDER BY period_yyyy_mm DESC, role_id ASC
        `).all();
      },
    },
    metrics: {
      async summary({
        agentId = null,
        budgetWarningThreshold = 0.8,
        now = new Date(),
        taskId = null,
      } = {}) {
        return buildOperationalMetricsView({
          agentId,
          budgetWarningThreshold,
          now,
          snapshot: storage.snapshot(),
          taskId,
        });
      },
    },
    snapshot() {
      return {
        agents: database.prepare("SELECT payload FROM agents ORDER BY updated_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseAgentEntity, `snapshot.agents[${index}]`)),
        assignments: database.prepare("SELECT payload FROM assignments ORDER BY assigned_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseAssignmentReason, `snapshot.assignments[${index}]`)),
        approvals: database.prepare("SELECT payload FROM approvals ORDER BY created_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseApprovalRecord, `snapshot.approvals[${index}]`)),
        blockers: database.prepare("SELECT payload FROM blockers ORDER BY created_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseBlockerArtifact, `snapshot.blockers[${index}]`)),
        checkpoints: database.prepare("SELECT payload FROM checkpoints ORDER BY created_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseCheckpoint, `snapshot.checkpoints[${index}]`)),
        events: database.prepare("SELECT payload FROM events ORDER BY timestamp ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseEventLogEntry, `snapshot.events[${index}]`)),
        goals: database.prepare("SELECT payload FROM goals ORDER BY updated_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseGoalRecord, `snapshot.goals[${index}]`)),
        explainability: database.prepare("SELECT payload FROM explainability ORDER BY timestamp ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseExplainabilityRecord, `snapshot.explainability[${index}]`)),
        evidence: database.prepare("SELECT payload FROM evidence ORDER BY id ASC").all().map((row, index) => parsePayloadRow(row, parseEvidencePacket, `snapshot.evidence[${index}]`)),
        ingressRecords: database.prepare("SELECT payload FROM ingress ORDER BY detected_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseTaskIngressRecord, `snapshot.ingress[${index}]`)),
        leaseWrites: listLeaseWrites(database),
        queueWrites: listQueueWrites(database),
        runLogs: database.prepare("SELECT payload FROM run_logs ORDER BY run_id ASC").all().map((row, index) =>
          hydrateRunLogRecord(normalizeRunLogRecord(JSON.parse(row.payload), `snapshot.runLogs[${index}]`), {
            stateRoot: resolvedStateRoot,
          })),
        taskLiveExcerpts: tableExists(availableTables, "task_live_excerpts")
          ? database.prepare("SELECT payload FROM task_live_excerpts ORDER BY ts ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseTaskLiveExcerpt, `snapshot.taskLiveExcerpts[${index}]`))
          : [],
        taskContentRevisions: tableExists(availableTables, "task_content_revisions")
          ? database.prepare("SELECT payload FROM task_content_revisions ORDER BY created_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseTaskContentRevision, `snapshot.taskContentRevisions[${index}]`))
          : [],
        taskRunEvents: tableExists(availableTables, "task_run_events")
          ? database.prepare("SELECT payload FROM task_run_events ORDER BY ts ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseTaskRunEvent, `snapshot.taskRunEvents[${index}]`))
          : [],
        taskRunSessions: tableExists(availableTables, "task_run_sessions")
          ? database.prepare("SELECT payload FROM task_run_sessions ORDER BY updated_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseTaskRunSession, `snapshot.taskRunSessions[${index}]`))
          : [],
        runs: database.prepare("SELECT payload FROM runs ORDER BY started_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseRunRecord, `snapshot.runs[${index}]`)),
        taskSessions: database.prepare("SELECT payload FROM task_sessions ORDER BY updated_at ASC, task_key ASC").all().map((row, index) => parsePayloadRow(row, parseTaskSession, `snapshot.taskSessions[${index}]`)),
        taskNotes: database.prepare("SELECT payload FROM task_notes ORDER BY created_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseTaskNote, `snapshot.taskNotes[${index}]`)),
        tasks: database.prepare("SELECT payload FROM tasks ORDER BY updated_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseTaskRecord, `snapshot.tasks[${index}]`)),
        verdicts: database.prepare("SELECT payload FROM verdicts ORDER BY created_at ASC, id ASC").all().map((row, index) => parsePayloadRow(row, parseReviewVerdict, `snapshot.verdicts[${index}]`)),
      };
    },
    close() {
      database.close();
    },
  };

  assertStorageImplementation(storage);
  return storage;
}

async function seedStorage(storage, seed = {}) {
  for (const task of seed.tasks ?? []) await storage.tasks.upsert(task);
  for (const goal of seed.goals ?? []) await storage.goals.upsert(goal);
  for (const agent of seed.agents ?? []) await storage.agents.upsert(agent);
  for (const run of seed.runs ?? []) await storage.runs.upsert(run);
  for (const event of seed.events ?? []) await storage.events.append(event);
  for (const ingressRecord of seed.ingressRecords ?? []) await storage.ingress.record(ingressRecord);
  for (const assignment of seed.assignments ?? []) await storage.assignments.record(assignment);
  for (const queueItem of seed.queueItems ?? []) await storage.queue.enqueue(queueItem);
  for (const lease of seed.leases ?? []) await storage.leases.acquireOrRenew(lease);
  for (const taskSession of seed.taskSessions ?? []) await storage.taskSessions.upsert(taskSession);
  for (const taskRunSession of seed.taskRunSessions ?? []) await storage.taskRunSessions.upsert(taskRunSession);
  for (const taskRunEvent of seed.taskRunEvents ?? []) await storage.taskRunEvents.append(taskRunEvent);
  for (const taskLiveExcerpt of seed.taskLiveExcerpts ?? []) await storage.taskLiveExcerpts.append(taskLiveExcerpt);
  for (const taskContentRevision of seed.taskContentRevisions ?? []) await storage.taskContentRevisions.append(taskContentRevision);
  for (const runLog of seed.runLogs ?? []) await storage.runLogs.store(runLog);
  for (const taskNote of seed.taskNotes ?? []) await storage.taskNotes.append(taskNote);
  for (const approval of seed.approvals ?? []) await storage.approvals.upsert(approval);
  for (const verdict of seed.verdicts ?? []) await storage.verdicts.record(verdict);
  for (const evidencePacket of seed.evidencePackets ?? []) await storage.evidence.savePacket(evidencePacket);
  for (const blocker of seed.blockers ?? []) await storage.blockers.upsert(blocker);
  for (const checkpoint of seed.checkpoints ?? []) await storage.checkpoints.save(checkpoint);
  for (const explainabilityRecord of seed.explainability ?? []) await storage.explainability.record(explainabilityRecord);

  return storage;
}

function collectSqliteStorageChecks(databasePath) {
  const metadata = readSqliteStorageMetadata({ databasePath });

  if (!metadata.exists) {
    return [{
      id: "sqlite-db",
      status: "warning",
      summary: metadata.database_path,
      details: "Run `init` to create the local SQLite database and schema.",
    }];
  }

  try {
    return [{
      id: "sqlite-db",
      status: metadata.schema_version === String(SQLITE_SCHEMA_VERSION) ? "ok" : "error",
      summary: metadata.database_path,
      details:
        metadata.schema_version === String(SQLITE_SCHEMA_VERSION)
          ? `SQLite database is readable and matches schema version ${SQLITE_SCHEMA_VERSION}.`
          : `SQLite schema version mismatch: expected ${SQLITE_SCHEMA_VERSION}, received ${metadata.schema_version ?? "missing"}.`,
    }];
  } catch (error) {
    return [{
      id: "sqlite-db",
      status: "error",
      summary: metadata.database_path,
      details: `SQLite database health check failed: ${error.message}`,
    }];
  }
}

export {
  SQLITE_DEFAULT_FILENAME,
  SQLITE_SCHEMA_VERSION,
  SqliteStorageError,
  collectSqliteStorageChecks,
  createSqliteDatabasePath,
  createSqliteStorage,
  readSqliteStorageMetadata,
  seedStorage,
};
