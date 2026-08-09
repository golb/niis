import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EvalHarnessError, runScenarioSuite } from "./run-scenarios.js";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("runScenarioSuite executes graders and writes a durable result artifact", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-evals-"));
  const scriptPath = path.join(workspaceRoot, "fixture.js");
  const suitePath = path.join(workspaceRoot, "evals", "suite.json");

  writeFile(
    scriptPath,
    'console.log(JSON.stringify({ ok: true, final_verdict: "PASS" }));\n',
  );
  writeFile(
    suitePath,
    JSON.stringify({
      suite_id: "fixture-suite",
      output_path: ".niis/proofs/evals/fixture-suite.json",
      scenarios: [
        {
          id: "fixture-scenario",
          command: "node",
          args: ["fixture.js"],
          health_assets: [
            { asset_id: "@niis/cli", asset_kind: "package" }
          ],
          graders: [
            { type: "exit_code_zero" },
            { type: "json_field_equals", path: "ok", equals: true },
            { type: "json_field_equals", path: "final_verdict", equals: "PASS" }
          ]
        }
      ]
    }, null, 2),
  );

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  const result = runScenarioSuite({
    suitePath,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.passed, 1);
  assert.equal(fs.existsSync(result.output_path), true);
  assert.equal(fs.existsSync(result.asset_health_output_path), true);
  assert.equal(result.asset_health.assets[0].status, "healthy");
});

test("runScenarioSuite fails when a grader fails", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-evals-fail-"));
  const scriptPath = path.join(workspaceRoot, "fixture.js");
  const suitePath = path.join(workspaceRoot, "evals", "suite.json");

  writeFile(
    scriptPath,
    'console.log(JSON.stringify({ ok: false }));\n',
  );
  writeFile(
    suitePath,
    JSON.stringify({
      suite_id: "fixture-suite-fail",
      scenarios: [
        {
          id: "fixture-scenario-fail",
          command: "node",
          args: ["fixture.js"],
          graders: [
            { type: "exit_code_zero" },
            { type: "json_field_equals", path: "ok", equals: true }
          ]
        }
      ]
    }, null, 2),
  );

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  assert.throws(() => runScenarioSuite({
    suitePath,
    workspaceRoot,
  }), EvalHarnessError);
});

test("runScenarioSuite derives healthy, watch, and failing asset health states from scenario outcomes", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-evals-health-"));
  const passScriptPath = path.join(workspaceRoot, "pass.js");
  const failScriptPath = path.join(workspaceRoot, "fail.js");
  const suitePath = path.join(workspaceRoot, "evals", "suite.json");

  writeFile(passScriptPath, 'console.log(JSON.stringify({ ok: true }));\n');
  writeFile(failScriptPath, 'console.log(JSON.stringify({ ok: false }));\n');
  writeFile(
    suitePath,
    JSON.stringify({
      suite_id: "fixture-suite-health",
      scenarios: [
        {
          id: "pass-a",
          command: "node",
          args: ["pass.js"],
          health_assets: [
            { asset_id: "@niis/cli", asset_kind: "package" }
          ],
          graders: [
            { type: "exit_code_zero" },
            { type: "json_field_equals", path: "ok", equals: true }
          ]
        },
        {
          id: "fail-a",
          command: "node",
          args: ["fail.js"],
          health_assets: [
            { asset_id: "@niis/cli", asset_kind: "package" },
            { asset_id: "completion_proof", asset_kind: "validator" }
          ],
          graders: [
            { type: "exit_code_zero" },
            { type: "json_field_equals", path: "ok", equals: true }
          ]
        }
      ]
    }, null, 2),
  );

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  try {
    runScenarioSuite({
      suitePath,
      workspaceRoot,
    });
    assert.fail("expected suite to fail");
  } catch (error) {
    assert.ok(error instanceof EvalHarnessError);
    assert.equal(error.result.asset_health.summary.watch, 1);
    assert.equal(error.result.asset_health.summary.failing, 1);
    const cliAsset = error.result.asset_health.assets.find((asset) => asset.asset_id === "@niis/cli");
    const validatorAsset = error.result.asset_health.assets.find((asset) => asset.asset_id === "completion_proof");
    assert.equal(cliAsset.status, "watch");
    assert.equal(validatorAsset.status, "failing");
  }
});

test("runScenarioSuite supports file-based artifact graders", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-evals-artifacts-"));
  const scriptPath = path.join(workspaceRoot, "fixture.js");
  const suitePath = path.join(workspaceRoot, "evals", "suite.json");

  writeFile(
    scriptPath,
    [
      'const fs = require("node:fs");',
      'fs.writeFileSync(".niis-output.txt", "runtime artifact ready\\n");',
      'fs.writeFileSync(".niis-output.json", JSON.stringify({ verdict: { status: "PASS" } }, null, 2));',
      'console.log(JSON.stringify({ ok: true }));',
      "",
    ].join("\n"),
  );
  writeFile(
    suitePath,
    JSON.stringify({
      suite_id: "fixture-suite-artifacts",
      scenarios: [
        {
          id: "artifact-graders",
          command: "node",
          args: ["fixture.js"],
          graders: [
            { type: "exit_code_zero" },
            { type: "file_contains", file: ".niis-output.txt", contains: "artifact ready" },
            { type: "file_json_field_equals", file: ".niis-output.json", path: "verdict.status", equals: "PASS" }
          ]
        }
      ]
    }, null, 2),
  );

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  const result = runScenarioSuite({
    suitePath,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.scenarios[0].attempt_results[0].grader_results[1].type, "file_contains");
  assert.equal(result.scenarios[0].attempt_results[0].grader_results[2].type, "file_json_field_equals");
});

test("runScenarioSuite supports structured JSON array graders for stdout and files", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-evals-array-graders-"));
  const scriptPath = path.join(workspaceRoot, "fixture.js");
  const suitePath = path.join(workspaceRoot, "evals", "suite.json");

  writeFile(
    scriptPath,
    [
      'const fs = require("node:fs");',
      'fs.writeFileSync(".niis-array-output.json", JSON.stringify({ explainability: [{ decision_type: "ROUTE", route_chosen: "generalist/runtime-proof-adapter" }, { decision_type: "GATE", route_chosen: "validator_lane" }] }, null, 2));',
      'console.log(JSON.stringify({ prompt_kinds: ["bootstrap_context", "reference_bundle", "task"], assets: [{ asset_id: "pkg-review-skill", asset_kind: "skill", status: "healthy" }] }));',
      "",
    ].join("\n"),
  );
  writeFile(
    suitePath,
    JSON.stringify({
      suite_id: "fixture-suite-array-graders",
      scenarios: [
        {
          id: "array-graders",
          command: "node",
          args: ["fixture.js"],
          graders: [
            { type: "exit_code_zero" },
            { type: "json_array_includes", path: "prompt_kinds", includes: "reference_bundle" },
            {
              type: "json_array_includes",
              path: "assets",
              includes: { asset_id: "pkg-review-skill", status: "healthy" }
            },
            {
              type: "file_json_array_includes",
              file: ".niis-array-output.json",
              path: "explainability",
              includes: { decision_type: "GATE", route_chosen: "validator_lane" }
            }
          ]
        }
      ]
    }, null, 2),
  );

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  const result = runScenarioSuite({
    suitePath,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.scenarios[0].attempt_results[0].grader_results[1].type, "json_array_includes");
  assert.equal(result.scenarios[0].attempt_results[0].grader_results[3].type, "file_json_array_includes");
});

test("runScenarioSuite supports aggregate JSON array and object graders", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-evals-aggregate-graders-"));
  const scriptPath = path.join(workspaceRoot, "fixture.js");
  const suitePath = path.join(workspaceRoot, "evals", "suite.json");

  writeFile(
    scriptPath,
    'console.log(JSON.stringify({ steps: [{ ok: true }, { ok: true }], artifact_checks: { profile: true, workflow: true }, checks: [{ status: "ok" }, { status: "ok" }] }));\n',
  );
  writeFile(
    suitePath,
    JSON.stringify({
      suite_id: "fixture-suite-aggregate-graders",
      scenarios: [
        {
          id: "aggregate-graders",
          command: "node",
          args: ["fixture.js"],
          graders: [
            { type: "exit_code_zero" },
            { type: "json_array_all_field_equals", path: "steps", entry_field: "ok", equals: true },
            { type: "json_object_values_all_equal", path: "artifact_checks", equals: true },
            { type: "json_array_all_field_equals", path: "checks", entry_field: "status", equals: "ok" }
          ]
        }
      ]
    }, null, 2),
  );

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  const result = runScenarioSuite({
    suitePath,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.scenarios[0].attempt_results[0].grader_results[1].type, "json_array_all_field_equals");
  assert.equal(result.scenarios[0].attempt_results[0].grader_results[2].type, "json_object_values_all_equal");
});

test("runScenarioSuite supports numeric minimum JSON field graders", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-evals-numeric-graders-"));
  const scriptPath = path.join(workspaceRoot, "fixture.js");
  const suitePath = path.join(workspaceRoot, "evals", "suite.json");

  writeFile(
    scriptPath,
    'console.log(JSON.stringify({ fragment_count: 4, candidate_count: 1 }));\n',
  );
  writeFile(
    suitePath,
    JSON.stringify({
      suite_id: "fixture-suite-numeric-graders",
      scenarios: [
        {
          id: "numeric-graders",
          command: "node",
          args: ["fixture.js"],
          graders: [
            { type: "exit_code_zero" },
            { type: "json_field_gte", path: "fragment_count", gte: 4 },
            { type: "json_field_equals", path: "candidate_count", equals: 1 }
          ]
        }
      ]
    }, null, 2),
  );

  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  });

  const result = runScenarioSuite({
    suitePath,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.scenarios[0].attempt_results[0].grader_results[1].type, "json_field_gte");
});
