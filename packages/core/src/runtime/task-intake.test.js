import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildExecutionReferenceBundle,
  createTaskIntakeArtifact,
  createTaskIntakePaths,
  mapVerdictClassToTaskStatus,
  readTaskIntakeArtifact,
  transitionTaskStatus,
  validateIntakeAcceptance,
  writeTaskIntakeArtifacts,
} from "./task-intake.js";

test("task intake paths reject traversal, case, and Unicode aliases", (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-intake-path-"));
  t.after(() => fs.rmSync(stateRoot, { force: true, recursive: true }));

  const canonical = createTaskIntakePaths(stateRoot, "task-safe");
  assert.equal(
    canonical.task_root,
    path.join(fs.realpathSync.native(stateRoot), "intake", "task-safe"),
  );

  for (const taskId of [
    ".",
    "..",
    "../escape",
    "task/escape",
    "task\\escape",
    "/absolute",
    "TASK-SAFE",
    "task_safe",
    "ｔａｓｋ",
  ]) {
    assert.throws(
      () => createTaskIntakePaths(stateRoot, taskId),
      /canonical lower-case ASCII task id/,
      taskId,
    );
  }
});

test("task intake paths reject an existing symlink alias", (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-intake-link-"));
  t.after(() => fs.rmSync(stateRoot, { force: true, recursive: true }));
  const intakeRoot = path.join(stateRoot, "intake");
  const targetRoot = path.join(intakeRoot, "task-target");
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.symlinkSync(targetRoot, path.join(intakeRoot, "task-alias"), "dir");

  assert.throws(
    () => createTaskIntakePaths(stateRoot, "task-alias"),
    /exact canonical child/,
  );
});

test("task intake paths reject a symlinked intake root", (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-intake-root-link-"));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-intake-external-"));
  t.after(() => fs.rmSync(stateRoot, { force: true, recursive: true }));
  t.after(() => fs.rmSync(externalRoot, { force: true, recursive: true }));
  fs.symlinkSync(externalRoot, path.join(stateRoot, "intake"), "dir");

  assert.throws(
    () => createTaskIntakePaths(stateRoot, "task-safe"),
    /intake root must not resolve through a filesystem alias/,
  );
  assert.deepEqual(fs.readdirSync(externalRoot), []);
});

test("createTaskIntakeArtifact falls back deterministically when planner output is unavailable", () => {
  const artifact = createTaskIntakeArtifact({
    now: "2026-04-08T10:00:00.000Z",
    operatorPrompt: "Add a target source switch to parser.",
    plannerMode: "fallback",
    taskId: "task-parser-intake",
  });

  assert.equal(artifact.planner_mode, "fallback");
  assert.equal(artifact.derived_task.id, "task-parser-intake");
  assert.equal(artifact.derived_task.status, "PENDING");
  assert.equal(artifact.derived_task.phase, 0);
  assert.equal(artifact.derived_task.priority, "medium");
  assert.equal(artifact.derived_task.operator_brief_markdown, "Add a target source switch to parser.");
  assert.equal(artifact.derived_task.acceptance_markdown, null);
  assert.equal(artifact.reference_bundle.target_paths.length, 0);
  assert.equal(artifact.acceptance_checks.length, 0);
  assert.equal(artifact.subtasks.length, 0);
});

test("createTaskIntakeArtifact includes confident subtasks and execution bundle defaults", () => {
  const artifact = createTaskIntakeArtifact({
    now: "2026-04-08T10:00:00.000Z",
    operatorPrompt: "Implement parser improvements.",
    plannerMode: "structured_planner",
    plannerOutput: {
      acceptance_checks: ["Keep existing URL flow working."],
      acceptance_commands: [
        { argv: ["npm", "test"], id: "unit-tests", required: true },
      ],
      operator_guidance: ["Touch only parser files."],
      out_of_scope: ["Backend changes"],
      phase: 7,
      priority: "high",
      subtasks: [
        { title: "Add the source mode toggle" },
        { title: "Wire local file input behavior" },
      ],
      summary: "Add a small parser UI enhancement.",
      target_paths: ["templates/parser/parser.html"],
      title: "Add parser source-mode toggle",
    },
    taskId: "task-parser-structured",
  });
  const referenceBundle = buildExecutionReferenceBundle(artifact);

  assert.equal(artifact.planner_mode, "structured_planner");
  assert.equal(artifact.derived_task.phase, 7);
  assert.equal(artifact.derived_task.priority, "high");
  assert.match(artifact.derived_task.details_markdown, /## Target Paths/);
  assert.match(artifact.derived_task.details_markdown, /templates\/parser\/parser\.html/);
  assert.match(artifact.derived_task.acceptance_markdown, /Keep existing URL flow working\./);
  assert.deepEqual(artifact.acceptance_commands, [
    { argv: ["npm", "test"], id: "unit-tests", required: true },
  ]);
  assert.deepEqual(artifact.derived_task.acceptance_commands, artifact.acceptance_commands);
  assert.equal(artifact.acceptance_validation.ok, true);
  assert.equal(artifact.subtasks.length, 2);
  assert.deepEqual(referenceBundle.targetPaths, ["templates/parser/parser.html"]);
  assert.match(
    referenceBundle.guides
      .map((guide) => (typeof guide === "string" ? guide : guide.content))
      .join("\n"),
    /Acceptance check:/,
  );
  assert.equal(referenceBundle.documentationPriority[0], "templates/parser/parser.html");
});

test("task intake artifact round-trip persists acceptance commands", (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-acceptance-plan-"));
  t.after(() => fs.rmSync(stateRoot, { force: true, recursive: true }));
  const artifact = createTaskIntakeArtifact({
    operatorPrompt: "Implement and verify the focused change.",
    plannerMode: "structured_planner",
    plannerOutput: {
      acceptance_checks: ["The focused verification suite passes after the requested change."],
      acceptance_commands: [
        { argv: ["npm", "run", "verify"], id: "verify", required: true },
      ],
      operator_guidance: [],
      out_of_scope: ["NONE"],
      phase: 0,
      priority: "medium",
      subtasks: [],
      summary: "Implement the focused change.",
      target_paths: [],
      title: "Focused change",
    },
    taskId: "task-acceptance-plan-round-trip",
  });

  writeTaskIntakeArtifacts({ artifact, stateRoot });
  const restored = readTaskIntakeArtifact({
    stateRoot,
    taskId: artifact.task_id,
  });

  assert.deepEqual(restored.acceptance_commands, artifact.acceptance_commands);
  assert.deepEqual(
    restored.derived_task.acceptance_commands,
    artifact.derived_task.acceptance_commands,
  );
});

test("createTaskIntakeArtifact lets an explicit operator title override planner title", () => {
  const artifact = createTaskIntakeArtifact({
    now: "2026-04-11T15:53:49.000Z",
    operatorPrompt: "Add parser target source toggle.",
    overrides: {
      title: "Parser source toggle",
    },
    plannerMode: "structured_planner",
    plannerOutput: {
      acceptance_checks: [],
      operator_guidance: [],
      out_of_scope: [],
      phase: 3,
      priority: "high",
      subtasks: [
        { title: "Inspect parser surfaces" },
        { title: "Apply the route-safe toggle change" },
      ],
      summary: "Add parser target source toggle.",
      target_paths: ["templates/parser/parser.html"],
      title: "Planner title",
    },
    taskId: "task-operator-title",
  });

  assert.equal(artifact.derived_task.title, "Parser source toggle");
});

test("createTaskIntakeArtifact drops vague or duplicate subtasks", () => {
  const artifact = createTaskIntakeArtifact({
    operatorPrompt: "Do a thing.",
    plannerMode: "structured_planner",
    plannerOutput: {
      acceptance_checks: [],
      operator_guidance: [],
      out_of_scope: [],
      phase: 0,
      priority: "medium",
      subtasks: [
        { title: "Inspect code" },
        { title: "Inspect code" },
      ],
      summary: "Do a thing.",
      target_paths: [],
      title: "Do a thing",
    },
    taskId: "task-duplicate-subtasks",
  });

  assert.equal(artifact.subtasks.length, 0);
});

test("createTaskIntakeArtifact preserves planner role_id when in whitelist", () => {
  const artifact = createTaskIntakeArtifact({
    operatorPrompt: "Mixed task.",
    plannerMode: "structured_planner",
    plannerOutput: {
      acceptance_checks: [],
      operator_guidance: [],
      out_of_scope: [],
      phase: 0,
      priority: "medium",
      subtasks: [
        { title: "Touch frontend file", role_id: "frontend-specialist" },
        { title: "Touch backend file", role_id: "generalist-worker" },
      ],
      summary: "Mixed task.",
      target_paths: [],
      title: "Mixed task",
    },
    taskId: "task-role-whitelist",
    validRoleIds: ["frontend-specialist", "generalist-worker", "validator"],
  });

  assert.equal(artifact.subtasks.length, 2);
  assert.equal(artifact.subtasks[0].role_id, "frontend-specialist");
  assert.equal(artifact.subtasks[1].role_id, "generalist-worker");
});

test("createTaskIntakeArtifact drops unknown role_id and falls back to null", () => {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try {
    const artifact = createTaskIntakeArtifact({
      operatorPrompt: "Task with bad role hint.",
      plannerMode: "structured_planner",
      plannerOutput: {
        acceptance_checks: [],
        operator_guidance: [],
        out_of_scope: [],
        phase: 0,
        priority: "medium",
        subtasks: [
          { title: "First step", role_id: "made-up-specialist" },
          { title: "Second step", role_id: "frontend-specialist" },
        ],
        summary: "Task with bad role hint.",
        target_paths: [],
        title: "Task with bad role hint",
      },
      taskId: "task-bad-role",
      validRoleIds: ["frontend-specialist", "generalist-worker"],
    });
    assert.equal(artifact.subtasks[0].role_id, null);
    assert.equal(artifact.subtasks[1].role_id, "frontend-specialist");
    assert.match(captured, /unknown role_id "made-up-specialist"/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("mapVerdictClassToTaskStatus maps validator outcomes to task lifecycle states", () => {
  assert.equal(mapVerdictClassToTaskStatus("PASS"), "DONE");
  assert.equal(mapVerdictClassToTaskStatus("PARTIAL_PROGRESS"), "IN_PROGRESS");
  assert.equal(mapVerdictClassToTaskStatus("EVIDENCE_GAP"), "IN_REVIEW");
  assert.equal(mapVerdictClassToTaskStatus("ENV_BLOCK"), "BLOCKED");


  assert.equal(mapVerdictClassToTaskStatus("DEFECT"), "REJECTED");
  assert.equal(mapVerdictClassToTaskStatus("NEEDS_ESCALATION"), "BLOCKED");
});

test("transitionTaskStatus appends a transition log entry", () => {
  const artifact = createTaskIntakeArtifact({
    operatorPrompt: "Ship the parser change.",
    plannerMode: "fallback",
    taskId: "task-transition",
  });
  const updatedTask = transitionTaskStatus(artifact.derived_task, {
    actor: "cli:start-task",
    now: "2026-04-08T11:00:00.000Z",
    reason: "Started execution.",
    status: "IN_PROGRESS",
  });

  assert.equal(updatedTask.status, "IN_PROGRESS");
  assert.equal(updatedTask.transition_log.length, 2);
  assert.equal(updatedTask.transition_log.at(-1).from_status, "PENDING");
  assert.equal(updatedTask.transition_log.at(-1).to_status, "IN_PROGRESS");
});

test("validateIntakeAcceptance exempts fallback-mode drafts", () => {
  const verdict = validateIntakeAcceptance({ draft: { acceptance_checks: [], out_of_scope: [] }, plannerMode: "fallback" });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.issues.length, 0);
});

test("validateIntakeAcceptance flags empty acceptance criteria and out-of-scope", () => {
  const verdict = validateIntakeAcceptance({
    draft: { acceptance_checks: [], acceptance_commands: [], out_of_scope: [] },
    plannerMode: "structured_planner",
  });
  assert.equal(verdict.ok, false);
  const fields = verdict.issues.map((issue) => issue.field);
  assert.ok(fields.includes("acceptance_checks"));
  assert.ok(fields.includes("acceptance_commands"));
  assert.ok(fields.includes("out_of_scope"));
});

test("validateIntakeAcceptance rejects vague acceptance criteria", () => {
  const verdict = validateIntakeAcceptance({
    draft: {
      acceptance_checks: ["done", "Works"],
      acceptance_commands: [
        { argv: ["npm", "test"], id: "unit-tests", required: true },
      ],
      out_of_scope: ["NONE"],
    },
    plannerMode: "structured_planner",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.issues.length, 1);
  assert.equal(verdict.issues[0].field, "acceptance_checks");
});

test("validateIntakeAcceptance accepts testable criteria + explicit NONE out-of-scope", () => {
  const verdict = validateIntakeAcceptance({
    draft: {
      acceptance_checks: ["The parser toggles between source modes without breaking existing tests."],
      acceptance_commands: [
        { argv: ["npm", "test"], id: "unit-tests", required: true },
      ],
      out_of_scope: ["NONE"],
    },
    plannerMode: "structured_planner",
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.issues.length, 0);
});

test("validateIntakeAcceptance requires a verdict-participating command", () => {
  const verdict = validateIntakeAcceptance({
    draft: {
      acceptance_checks: ["The focused parser tests pass after the requested update."],
      acceptance_commands: [
        { argv: ["npm", "test"], id: "informational-tests", required: false },
      ],
      out_of_scope: ["NONE"],
    },
    plannerMode: "structured_planner",
  });

  assert.equal(verdict.ok, false);
  assert.match(verdict.issues[0].message, /no required acceptance command/i);
});

test("createTaskIntakeArtifact rejects unsafe planner acceptance commands fail-closed", () => {
  assert.throws(
    () => createTaskIntakeArtifact({
      operatorPrompt: "Update the parser and verify it.",
      plannerMode: "structured_planner",
      plannerOutput: {
        acceptance_checks: ["The focused parser tests pass after the requested update."],
        acceptance_commands: [
          { argv: ["npm", "test;publish"], id: "unsafe", required: true },
        ],
        operator_guidance: [],
        out_of_scope: ["NONE"],
        phase: 0,
        priority: "medium",
        subtasks: [],
        summary: "Update and verify the parser.",
        target_paths: [],
        title: "Update parser",
      },
      taskId: "task-unsafe-acceptance-command",
    }),
    /plannerOutput\.acceptance_commands\[0\]\.argv\[1\]/,
  );
});

test("transitionTaskStatus increments rejection_count on REJECTED", () => {
  const artifact = createTaskIntakeArtifact({
    operatorPrompt: "Refactor the parser.",
    plannerMode: "fallback",
    taskId: "task-reject-count",
  });
  const rejectedTask = transitionTaskStatus(artifact.derived_task, {
    actor: "cli:start-task-review",
    now: "2026-04-23T12:00:00.000Z",
    reason: "Validator returned DEFECT.",
    status: "REJECTED",
  });
  assert.equal(rejectedTask.status, "REJECTED");
  assert.equal(rejectedTask.rejection_count, 1);
});

test("transitionTaskStatus auto-blocks on reaching max_rejections", () => {
  const artifact = createTaskIntakeArtifact({
    operatorPrompt: "Refactor the parser.",
    plannerMode: "fallback",
    taskId: "task-reject-max",
  });
  const taskNearLimit = { ...artifact.derived_task, rejection_count: 4 };
  const blockedTask = transitionTaskStatus(taskNearLimit, {
    actor: "cli:start-task-review",
    now: "2026-04-23T12:30:00.000Z",
    reason: "Validator returned DEFECT (5th time).",
    status: "REJECTED",
  });
  assert.equal(blockedTask.status, "BLOCKED");
  assert.equal(blockedTask.rejection_count, 5);

  assert.equal(blockedTask.transition_log.at(-1).to_status, "BLOCKED");
  assert.equal(blockedTask.transition_log.at(-2).to_status, "REJECTED");
});
