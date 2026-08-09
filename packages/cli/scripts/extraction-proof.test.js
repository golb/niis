import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ExtractionProofError, runExtractionProof } from "./extraction-proof.js";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("runExtractionProof passes when subtree imports stay local and host repo has no references", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-extraction-proof-"));
  const workspaceRoot = path.join(root, "niis");

  writeFile(path.join(workspaceRoot, "packages", "cli", "src", "main.js"), 'import "../bin/niis.js";\n');
  writeFile(path.join(root, "README.md"), "# Host Repo\n");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = runExtractionProof({
    hostRoot: root,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.host_repo_references.length, 0);
  assert.equal(result.internal_import_violations.length, 0);
});

test("runExtractionProof reports prose references without blocking extraction", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-extraction-proof-fail-"));
  const workspaceRoot = path.join(root, "niis");

  writeFile(path.join(workspaceRoot, "packages", "cli", "src", "main.js"), 'import "../bin/niis.js";\n');
  writeFile(path.join(root, "README.md"), "Use npm --prefix niis run init\n");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = runExtractionProof({
    hostRoot: root,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.prose_host_repo_references.length, 1);
  assert.equal(
    result.checks.find((check) => check.id === "host-prose-references").status,
    "warning",
  );
});

test("runExtractionProof fails when host runtime configuration depends on the subtree", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-extraction-proof-runtime-fail-"));
  const workspaceRoot = path.join(root, "niis");

  writeFile(path.join(workspaceRoot, "packages", "cli", "src", "main.js"), 'import "../bin/niis.js";\n');
  writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      niis: "node niis/packages/cli/bin/niis.js",
    },
  }));

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  assert.throws(
    () => runExtractionProof({
      hostRoot: root,
      workspaceRoot,
    }),
    ExtractionProofError,
  );
});
