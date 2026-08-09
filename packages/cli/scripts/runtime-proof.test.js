import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runRuntimeProof } from "./runtime-proof.js";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("runRuntimeProof executes the durable lifecycle and persists review evidence on a disposable repository", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-runtime-proof-"));
  const workspaceRoot = path.join(root, "niis");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "host-repo",
    version: "0.1.0",
    type: "module",
    dependencies: {
      react: "18.0.0",
    },
  }, null, 2));
  writeFile(path.join(root, "README.md"), "# Runtime Proof Fixture\n");
  writeFile(path.join(root, "playwright.config.ts"), "export default {};\n");
  writeFile(path.join(root, "src", "index.js"), "export const value = 1;\n");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = await runRuntimeProof({
    validationSurfaceRoot: root,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.steps.map((step) => step.command).join(" -> "),
    "init -> attach -> profile -> route -> execute-task-lifecycle -> explain",
  );
  assert.equal(result.final_verdict, "PASS");
  assert.equal(result.lifecycle.stage, "FINISHED");
  assert.equal(result.lifecycle.promoted, true);
  assert.equal(result.lifecycle.state.review.fresh_context, true);
  assert.equal(result.explain_summary.task_id, "runtime-proof-task");
  assert.equal(result.artifact_checks.lifecycle_input, true);
  assert.equal(result.artifact_checks.lifecycle_output, true);
  assert.equal(result.artifact_checks.review_output, true);
  assert.equal(result.artifact_checks.explain_output, true);
});
