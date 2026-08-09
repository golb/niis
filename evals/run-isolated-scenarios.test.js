import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  IsolatedEvalError,
  runIsolatedScenarioSuite,
} from "./run-isolated-scenarios.js";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("runIsolatedScenarioSuite keeps live state unchanged and writes only to explicit output", (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-isolated-eval-source-"));
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niis-isolated-eval-output-"));
  const liveStateRoot = path.join(sourceRoot, ".niis");
  const suitePath = path.join(sourceRoot, "evals", "suite.json");

  t.after(() => {
    fs.rmSync(sourceRoot, { force: true, recursive: true });
    fs.rmSync(outputDirectory, { force: true, recursive: true });
  });

  fs.mkdirSync(liveStateRoot, { recursive: true });
  fs.writeFileSync(path.join(liveStateRoot, "sentinel.txt"), "live\n");
  writeJson(suitePath, {
    suite_id: "isolated-fixture",
    scenarios: [{
      args: [
        "-e",
        "require('node:fs').mkdirSync('.niis',{recursive:true});require('node:fs').writeFileSync('.niis/proof.txt','ok');console.log(JSON.stringify({ok:true}))",
      ],
      command: process.execPath,
      graders: [
        { type: "exit_code_zero" },
        { equals: true, path: "ok", type: "json_field_equals" },
      ],
      id: "writes-only-in-sandbox",
    }],
  });

  const result = runIsolatedScenarioSuite({
    outputDirectory,
    sourceRoot,
    suitePath,
  });

  assert.equal(result.ok, true);
  assert.equal(result.isolated, true);
  assert.equal(result.workspace_root, null);
  assert.equal(fs.readFileSync(path.join(liveStateRoot, "sentinel.txt"), "utf8"), "live\n");
  assert.equal(fs.existsSync(path.join(liveStateRoot, "proof.txt")), false);
  assert.equal(fs.existsSync(result.output_path), true);
  assert.equal(fs.existsSync(result.asset_health_output_path), true);
});

test("runIsolatedScenarioSuite fails closed when a scenario mutates protected live state", (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-isolated-eval-mutation-"));
  const liveStateRoot = path.join(sourceRoot, ".niis");
  const suitePath = path.join(sourceRoot, "evals", "suite.json");

  t.after(() => {
    fs.rmSync(sourceRoot, { force: true, recursive: true });
  });

  fs.mkdirSync(liveStateRoot, { recursive: true });
  fs.writeFileSync(path.join(liveStateRoot, "sentinel.txt"), "before\n");
  writeJson(suitePath, {
    suite_id: "mutation-fixture",
    scenarios: [{
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(path.join(liveStateRoot, "sentinel.txt"))},'after\\n');console.log('{}')`,
      ],
      command: process.execPath,
      graders: [{ type: "exit_code_zero" }],
      id: "mutates-live-state",
    }],
  });

  assert.throws(
    () => runIsolatedScenarioSuite({
      sourceRoot,
      suitePath,
    }),
    (error) =>
      error instanceof IsolatedEvalError
      && /mutated a protected live/.test(error.message),
  );
});

test("runIsolatedScenarioSuite detects absent-to-empty and metadata-only live-state changes", (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-isolated-eval-metadata-"));
  const suitePath = path.join(sourceRoot, "evals", "suite.json");

  t.after(() => {
    fs.rmSync(sourceRoot, { force: true, recursive: true });
  });

  writeJson(suitePath, {
    suite_id: "metadata-mutation-fixture",
    scenarios: [{
      args: [
        "-e",
        `require('node:fs').mkdirSync(${JSON.stringify(path.join(sourceRoot, ".niis"))});console.log('{}')`,
      ],
      command: process.execPath,
      graders: [{ type: "exit_code_zero" }],
      id: "creates-empty-live-state",
    }],
  });

  assert.throws(
    () => runIsolatedScenarioSuite({
      sourceRoot,
      suitePath,
    }),
    (error) =>
      error instanceof IsolatedEvalError
      && /mutated a protected live/.test(error.message),
  );

  fs.writeFileSync(path.join(sourceRoot, ".niis", "sentinel"), "unchanged\n", {
    mode: 0o600,
  });
  writeJson(suitePath, {
    suite_id: "mode-mutation-fixture",
    scenarios: [{
      args: [
        "-e",
        `const fs=require('node:fs');fs.chmodSync(${JSON.stringify(path.join(sourceRoot, ".niis", "sentinel"))},0o400);console.log('{}')`,
      ],
      command: process.execPath,
      graders: [{ type: "exit_code_zero" }],
      id: "changes-live-state-mode",
    }],
  });

  assert.throws(
    () => runIsolatedScenarioSuite({
      sourceRoot,
      suitePath,
    }),
    (error) =>
      error instanceof IsolatedEvalError
      && /mutated a protected live/.test(error.message),
  );
});

test("runIsolatedScenarioSuite executes a copied read-only source tree, not live symlinks", (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-isolated-eval-copy-"));
  const suitePath = path.join(sourceRoot, "evals", "suite.json");
  const liveFile = path.join(sourceRoot, "packages", "sentinel.txt");
  const liveLink = path.join(sourceRoot, "packages", "current.txt");
  fs.mkdirSync(path.dirname(liveFile), { recursive: true });
  fs.writeFileSync(liveFile, "live\n");
  fs.symlinkSync(liveFile, liveLink);
  t.after(() => fs.rmSync(sourceRoot, { force: true, recursive: true }));

  writeJson(suitePath, {
    suite_id: "copied-source-fixture",
    scenarios: [{
      args: [
        "-e",
        [
          "const fs=require('node:fs');const path=require('node:path');",
          "const target=path.join(process.env.NIIS_EVAL_SOURCE_ROOT,'packages','sentinel.txt');",
          "let blocked=false;try{fs.writeFileSync(target,'changed\\n')}catch{blocked=true}",
          "console.log(JSON.stringify({blocked,source:process.env.NIIS_EVAL_SOURCE_ROOT}))",
        ].join(""),
      ],
      command: process.execPath,
      graders: [
        { equals: true, path: "blocked", type: "json_field_equals" },
      ],
      id: "source-copy-is-read-only",
    }],
  });

  const result = runIsolatedScenarioSuite({
    keepWorkspace: true,
    sourceRoot,
    suitePath,
  });
  t.after(() => fs.rmSync(result.workspace_root, { force: true, recursive: true }));
  const attempt = result.scenarios[0].attempt_results[0];

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(liveFile, "utf8"), "live\n");
  assert.equal(
    fs.readFileSync(path.join(result.isolated_source_root, "packages", "sentinel.txt"), "utf8"),
    "live\n",
  );
  assert.equal(fs.lstatSync(path.join(result.isolated_source_root, "packages")).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(result.workspace_root, "packages")).isSymbolicLink(), true);
  assert.ok(
    fs.realpathSync(path.join(result.workspace_root, "packages"))
      .startsWith(`${result.isolated_source_root}${path.sep}`),
  );
  assert.equal(
    fs.realpathSync(path.join(result.isolated_source_root, "packages", "current.txt")),
    path.join(result.isolated_source_root, "packages", "sentinel.txt"),
  );
  assert.equal(attempt.stdout_json.source, result.isolated_source_root);
});

test("runIsolatedScenarioSuite rejects validation paths outside the isolated source", (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-isolated-eval-path-"));
  const suitePath = path.join(sourceRoot, "evals", "suite.json");
  t.after(() => fs.rmSync(sourceRoot, { force: true, recursive: true }));
  writeJson(suitePath, {
    suite_id: "external-path-fixture",
    scenarios: [{
      args: ["--validation-surface-root", ".."],
      command: process.execPath,
      graders: [{ type: "exit_code_zero" }],
      id: "external-validation-root",
    }],
  });

  assert.throws(
    () => runIsolatedScenarioSuite({ sourceRoot, suitePath }),
    (error) => error instanceof IsolatedEvalError
      && /must resolve inside the isolated eval source/.test(error.message),
  );
});
