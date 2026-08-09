import test from "node:test";
import assert from "node:assert/strict";

import { isCommandAllowed, runQualityGate, runQualityGates } from "./quality-gates.js";

test("isCommandAllowed accepts exact allowlisted CLIs and rejects path spoofing", () => {
  assert.equal(isCommandAllowed("npm"), true);
  assert.equal(isCommandAllowed("/usr/local/bin/npm"), false);
  assert.equal(isCommandAllowed("rm"), false);
  assert.equal(isCommandAllowed(""), false);
});

test("runQualityGate refuses non-whitelisted command without spawning", () => {
  const result = runQualityGate({
    gate: { args: [], command: "rm", fail_mode: "hard", id: "danger" },
    workspaceRoot: process.cwd(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.exit_code, -1);
  assert.match(result.stderr, /not whitelisted/);
});

test("runQualityGates returns hard_failures for failing hard gates", () => {
  const report = runQualityGates({
    gates: [
      { args: [], command: "rm", fail_mode: "hard", id: "blocked-cmd" },
    ],
    workspaceRoot: process.cwd(),
  });
  assert.equal(report.hard_failures.length, 1);
  assert.equal(report.hard_failures[0].gate_id, "blocked-cmd");
});

test("runQualityGates returns empty when no gates declared", () => {
  const report = runQualityGates({ gates: [], workspaceRoot: process.cwd() });
  assert.equal(report.results.length, 0);
  assert.equal(report.hard_failures.length, 0);
});
