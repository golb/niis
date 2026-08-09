import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAdversarialImportProof } from "./adversarial-import-proof.js";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("runAdversarialImportProof imports a disposable fixture file through adversarial review", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-adversarial-import-proof-"));
  const workspaceRoot = path.join(root, "niis");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "host-repo",
    version: "0.1.0",
    type: "module",
  }, null, 2));
  writeFile(path.join(root, "README.md"), "# Adversarial Import Proof Fixture\n");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = runAdversarialImportProof({
    validationSurfaceRoot: root,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.steps.map((step) => step.command).join(" -> "),
    "init -> attach -> profile -> import",
  );
  assert.equal(result.final_review_status, "APPROVED");
  assert.equal(result.final_verdict, "PASS");
  assert.equal(result.artifact_checks.import_spec, true);
  assert.equal(result.artifact_checks.import_output, true);
});
