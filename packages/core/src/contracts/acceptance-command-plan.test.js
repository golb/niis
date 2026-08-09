import test from "node:test";
import assert from "node:assert/strict";

import {
  AcceptanceCommandPlanError,
  normalizeAcceptanceCommandPlan,
  toQualityGateDefinitions,
} from "./acceptance-command-plan.js";

test("normalizes a JSON-serializable argv-only acceptance command plan", () => {
  const plan = normalizeAcceptanceCommandPlan([
    {
      argv: ["npm", "run", "verify"],
      id: "verify",
      required: true,
    },
    {
      argv: ["node", "--test", "packages/core/src/example.test.js"],
      id: "focused-tests",
      required: false,
    },
  ], { allowEmpty: false });

  assert.deepEqual(JSON.parse(JSON.stringify(plan)), [
    {
      argv: ["npm", "run", "verify"],
      id: "verify",
      required: true,
    },
    {
      argv: ["node", "--test", "packages/core/src/example.test.js"],
      id: "focused-tests",
      required: false,
    },
  ]);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan[0]), true);
  assert.equal(Object.isFrozen(plan[0].argv), true);
});

test("converts required flags to deterministic hard and soft quality gates", () => {
  const gates = toQualityGateDefinitions([
    { argv: ["npm", "test"], id: "unit", required: true },
    { argv: ["npm", "run", "lint"], id: "lint", required: false },
  ]);

  assert.deepEqual(gates, [
    { args: ["test"], command: "npm", fail_mode: "hard", id: "unit" },
    { args: ["run", "lint"], command: "npm", fail_mode: "soft", id: "lint" },
  ]);
});

test("rejects empty plans when a command is required", () => {
  assert.throws(
    () => normalizeAcceptanceCommandPlan([], { allowEmpty: false }),
    /must declare at least one command/,
  );
});

test("rejects non-allowlisted executables, malformed argv, ids, and flags", () => {
  for (const invalidPlan of [null, {}, "npm test"]) {
    assert.throws(
      () => normalizeAcceptanceCommandPlan(invalidPlan),
      AcceptanceCommandPlanError,
    );
  }

  const invalidCommands = [
    { argv: ["shell-tool", "verify"], id: "verify", required: true },
    { argv: [], id: "verify", required: true },
    { argv: ["npm", ""], id: "verify", required: true },
    { argv: ["npm", 42], id: "verify", required: true },
    { argv: ["npm", "test"], id: "Verify Once", required: true },
    { argv: ["npm", "test"], id: "verify" },
    { argv: ["npm", "test"], extra: true, id: "verify", required: true },
  ];

  for (const command of invalidCommands) {
    assert.throws(
      () => normalizeAcceptanceCommandPlan([command]),
      AcceptanceCommandPlanError,
    );
  }
});

test("rejects duplicate ids and shell syntax in every argv position", () => {
  assert.throws(
    () => normalizeAcceptanceCommandPlan([
      { argv: ["npm", "test"], id: "verify", required: true },
      { argv: ["node", "--test", "example.test.js"], id: "verify", required: true },
    ]),
    /duplicate id/,
  );

  const unsafeTokens = [
    "test;other",
    "test&&other",
    "test||other",
    "test|other",
    "output>file",
    "input<file",
    "`command`",
    "$(command)",
    "${VARIABLE}",
    "$VARIABLE",
    "$1",
    "%PATH%",
    "!PATH!",
    "*.test.js",
    "file?.js",
    "first\nsecond",
    "\0",
  ];
  for (const token of unsafeTokens) {
    assert.throws(
      () => normalizeAcceptanceCommandPlan([
        { argv: ["npm", token], id: "verify", required: true },
      ]),
      AcceptanceCommandPlanError,
      token,
    );
  }
});

test("rejects publication, mutation, dynamic execution, and spoofed executable paths", () => {
  const unsafeCommands = [
    ["/tmp/node", "--test", "safe.test.js"],
    ["node", "-e", "process.exit(0)"],
    ["node", "--import=./hook.js", "--test", "safe.test.js"],
    ["git", "commit", "-m", "unsafe"],
    ["git", "push", "origin", "HEAD"],
    ["git", "branch", "prepass"],
    ["git", "diff", "--output=outside.patch"],
    ["git", "log", "--output", "outside.log"],
    ["git", "diff", "--ext-diff"],
    ["npm", "publish"],
    ["npm", "run", "release"],
    ["pnpm", "install"],
    ["cargo", "publish"],
    ["cargo", "fmt"],
    ["go", "install", "./..."],
    ["ruff", "format", "src"],
    ["ruff", "check", "--fix", "src"],
    ["tsc", "-p", "tsconfig.json"],
    ["eslint", "--fix", "src"],
    ["prettier", "--write", "src"],
  ];

  for (const [index, argv] of unsafeCommands.entries()) {
    assert.throws(
      () => normalizeAcceptanceCommandPlan([{
        argv,
        id: `unsafe-${index}`,
        required: true,
      }]),
      AcceptanceCommandPlanError,
      argv.join(" "),
    );
  }
});
