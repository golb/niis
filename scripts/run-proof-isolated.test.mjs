import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  normalizeProofArgs,
  runIsolatedProof,
} from "./run-proof-isolated.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function createSourceFixture(t, scriptContents) {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-proof-source-"));
  const scriptPath = path.join(sourceRoot, "proof.mjs");
  fs.writeFileSync(scriptPath, scriptContents);
  t.after(() => fs.rmSync(sourceRoot, { force: true, recursive: true }));
  return { scriptPath, sourceRoot };
}

test("isolated proof runner owns a disposable workspace and preserves read-only path inputs", (t) => {
  const { scriptPath, sourceRoot } = createSourceFixture(t, `
    import fs from "node:fs";
    import path from "node:path";
    fs.mkdirSync(".niis", { recursive: true });
    fs.writeFileSync(".niis/proof.txt", "disposable\\n");
    console.log(JSON.stringify({
      argument: process.argv[3],
      cwd: process.cwd(),
      source: process.env.NIIS_PROOF_SOURCE_ROOT,
      temp: process.env.TMPDIR,
      workspace: process.env.NIIS_PROOF_WORKSPACE_ROOT,
      wroteState: fs.existsSync(path.join(process.cwd(), ".niis", "proof.txt")),
    }));
  `);
  const validationRoot = path.join(sourceRoot, "validation");
  fs.mkdirSync(validationRoot);

  const result = runIsolatedProof({
    args: ["--validation-surface-root", "validation"],
    keepWorkspace: true,
    scriptPath,
    sourceRoot,
  });
  t.after(() => fs.rmSync(result.workspaceRoot, { force: true, recursive: true }));

  const output = JSON.parse(result.stdout);
  assert.equal(result.ok, true);
  assert.equal(output.argument, path.join(result.isolatedSourceRoot, "validation"));
  assert.equal(output.cwd, result.workspaceRoot);
  assert.equal(output.workspace, result.workspaceRoot);
  assert.equal(output.source, result.isolatedSourceRoot);
  assert.equal(output.temp, path.join(result.workspaceRoot, ".tmp"));
  assert.equal(output.wroteState, true);
  assert.equal(fs.existsSync(path.join(sourceRoot, ".niis")), false);
  assert.equal(fs.lstatSync(result.isolatedSourceRoot).isSymbolicLink(), false);
});

test("isolated proof runner propagates status and blocks workspace overrides", (t) => {
  const { scriptPath, sourceRoot } = createSourceFixture(t, "process.exitCode = 7;\n");
  const result = runIsolatedProof({
    scriptPath,
    sourceRoot,
  });

  assert.equal(result.proofExitCode, 7);
  assert.equal(result.exitCode, 7);
  assert.equal(result.ok, false);
  assert.throws(
    () => normalizeProofArgs(["--workspace-root", sourceRoot], sourceRoot),
    /controlled by the isolated proof runner/,
  );
  assert.throws(
    () => normalizeProofArgs(
      ["--validation-surface-root", path.dirname(sourceRoot)],
      sourceRoot,
    ),
    /must resolve inside the isolated source/,
  );
  assert.deepEqual(
    normalizeProofArgs(
      ["--validation-surface-root", path.dirname(sourceRoot)],
      sourceRoot,
      sourceRoot,
      { allowExternalReadPaths: true },
    ),
    ["--validation-surface-root", path.dirname(sourceRoot)],
  );
  assert.throws(
    () => normalizeProofArgs([`--output-root=${sourceRoot}`], sourceRoot),
    /controlled by the isolated proof runner/,
  );
});

test("isolated proof runner blocks writes through the copied source environment", (t) => {
  const { scriptPath, sourceRoot } = createSourceFixture(t, `
    import fs from "node:fs";
    import path from "node:path";
    fs.mkdirSync(path.join(process.env.NIIS_PROOF_SOURCE_ROOT, ".niis"));
  `);
  const result = runIsolatedProof({
    scriptPath,
    sourceRoot,
  });

  assert.equal(result.proofExitCode, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(result.mutations.length, 0);
  assert.equal(fs.existsSync(path.join(sourceRoot, ".niis")), false);
});

test("isolated proof runner detects a direct bypass that mutates live source", (t) => {
  const { scriptPath, sourceRoot } = createSourceFixture(t, "");
  fs.writeFileSync(scriptPath, `
    import fs from "node:fs";
    fs.mkdirSync(${JSON.stringify(path.join(sourceRoot, ".niis"))});
  `);
  const result = runIsolatedProof({
    scriptPath,
    sourceRoot,
  });

  assert.equal(result.proofExitCode, 0);
  assert.equal(result.exitCode, 1);
  assert.equal(result.mutations.length, 1);
});

test("every standalone proof package script goes through the isolated runner", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  const proofScripts = Object.entries(manifest.scripts)
    .filter(([name]) => name.startsWith("proof:"));

  assert.ok(proofScripts.length > 0);
  for (const [name, command] of proofScripts) {
    assert.match(
      command,
      /^node scripts\/run-proof-isolated\.mjs (?:--allow-live-host )?packages\/cli\/scripts\/[a-z0-9-]+-proof\.js(?: |$)/u,
      `${name} must use the isolated proof runner`,
    );
  }
});
