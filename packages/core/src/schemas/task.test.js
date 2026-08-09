import test from "node:test";
import assert from "node:assert/strict";

import { SchemaValidationError } from "./shared.js";
import {
  TASK_ID_MAX_LENGTH,
  TASK_KINDS,
  TaskIdValidationError,
  assertCanonicalTaskId,
  parseTaskRecord,
} from "./task.js";

const BASE_TASK = Object.freeze({
  id: "task-001",
  title: "Sample",
  status: "PENDING",
  phase: 0,
  priority: "medium",
  created_at: "2026-05-26T10:00:00Z",
  updated_at: "2026-05-26T10:00:00Z",
});

test("parseTaskRecord hydrates task_kind default 'work' when field is absent (backward compat for pre-task_kind records)", () => {
  const parsed = parseTaskRecord({ ...BASE_TASK });
  assert.deepEqual(parsed.acceptance_commands, []);
  assert.equal(parsed.task_kind, "work");
  assert.equal(parsed.source_kind, null);
  assert.equal(parsed.source_id, null);
  assert.equal(parsed.parent_task_id, null);
  assert.equal(parsed.collection_spec, null);
  assert.equal(parsed.schedule, null);
  assert.equal(parsed.runtime_state_ref, null);
  assert.equal(parsed.tool_call, null);
});

test("parseTaskRecord persists a validated argv-only acceptance command plan", () => {
  const parsed = parseTaskRecord({
    ...BASE_TASK,
    acceptance_commands: [
      {
        argv: ["npm", "run", "verify"],
        id: "verify",
        required: true,
      },
    ],
  });

  assert.deepEqual(parsed.acceptance_commands, [
    {
      argv: ["npm", "run", "verify"],
      id: "verify",
      required: true,
    },
  ]);
});

test("parseTaskRecord rejects unsafe acceptance command plans", () => {
  assert.throws(
    () => parseTaskRecord({
      ...BASE_TASK,
      acceptance_commands: [
        {
          argv: ["npm", "test&&publish"],
          id: "unsafe",
          required: true,
        },
      ],
    }),
    SchemaValidationError,
  );
});

test("parseTaskRecord accepts a continuous_collection task with generic schedule and collection_spec", () => {
  const parsed = parseTaskRecord({
    ...BASE_TASK,
    status: "IN_PROGRESS",
    task_kind: "continuous_collection",
    assigned_to: "source-agent",
    collection_spec: {
      kind: "external_source_collection",
      sources: [{ type: "example", id: "source-1" }],
      topic: "signals",
    },
    schedule: { every_ms: 3600000 },
    runtime_state_ref: "packages/example/runtime/task-001/state.json",
  });
  assert.equal(parsed.task_kind, "continuous_collection");
  assert.equal(parsed.status, "IN_PROGRESS");
  assert.equal(parsed.collection_spec.kind, "external_source_collection");
  assert.equal(parsed.schedule.every_ms, 3600000);
  assert.equal(parsed.runtime_state_ref, "packages/example/runtime/task-001/state.json");
});

test("parseTaskRecord accepts an agent_tick task with a generic tool call", () => {
  const parsed = parseTaskRecord({
    ...BASE_TASK,
    task_kind: "agent_tick",
    parent_task_id: "task-collect",
    assigned_to: "source-agent",
    tool_call: {
      name: "collect.run",
      arguments: { task_id: "task-collect" },
    },
  });
  assert.equal(parsed.task_kind, "agent_tick");
  assert.equal(parsed.parent_task_id, "task-collect");
  assert.equal(parsed.tool_call.name, "collect.run");
  assert.equal(parsed.tool_call.arguments.task_id, "task-collect");
});

test("canonical task IDs are injective lower-case ASCII kebab-case", () => {
  assert.equal(assertCanonicalTaskId("task-001"), "task-001");
  assert.equal(assertCanonicalTaskId("7"), "7");
  assert.equal(
    assertCanonicalTaskId("a".repeat(TASK_ID_MAX_LENGTH)),
    "a".repeat(TASK_ID_MAX_LENGTH),
  );
});

test("canonical task IDs reject traversal and collision-prone aliases", () => {
  for (const candidate of [
    ".",
    "..",
    "../task",
    "task/child",
    "task\\child",
    "/absolute",
    "C:\\absolute",
    "Task",
    "TASK",
    "task_id",
    "task.id",
    "task--id",
    " task-id",
    "task-id ",
    "ｔａｓｋ",
    "ta\u0301sk",
    "task%2fchild",
    "con",
    "nul",
    "com1",
    "lpt9",
    "a".repeat(TASK_ID_MAX_LENGTH + 1),
  ]) {
    assert.throws(
      () => assertCanonicalTaskId(candidate),
      TaskIdValidationError,
      candidate,
    );
  }
});

test("task records enforce canonical IDs for id, parent, and dependencies", () => {
  assert.throws(
    () => parseTaskRecord({ ...BASE_TASK, id: "../task" }),
    SchemaValidationError,
  );
  assert.throws(
    () => parseTaskRecord({ ...BASE_TASK, parent_task_id: "TASK-PARENT" }),
    SchemaValidationError,
  );
  assert.throws(
    () => parseTaskRecord({ ...BASE_TASK, depends_on: ["task-ok", "task/escape"] }),
    SchemaValidationError,
  );
});

test("parseTaskRecord rejects unknown task_kind values", () => {
  assert.throws(
    () => parseTaskRecord({ ...BASE_TASK, task_kind: "imaginary_kind" }),
    SchemaValidationError,
  );
});

test("TASK_KINDS enumerates package-neutral canonical kinds and nothing else", () => {
  assert.deepEqual([...TASK_KINDS].sort(), ["agent_tick", "continuous_collection", "work"]);
});
