import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runBootstrapProof } from "./bootstrap-proof.js";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("runBootstrapProof executes init -> attach -> profile on a temp host repository", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-bootstrap-proof-"));
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
  writeFile(path.join(root, "src", "index.js"), "export const value = 1;\n");
  writeFile(path.join(root, "README.md"), "# Host Repo\n");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = runBootstrapProof({
    validationSurfaceRoot: root,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.steps.map((step) => step.command).join(" -> "), "init -> attach -> profile");
  assert.equal(result.artifact_checks.project_profile, true);
  assert.equal(result.artifact_checks.attached_repository, true);
});
