import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runInstallAttachProof } from "./install-attach-proof.js";

test("runInstallAttachProof validates the packaged init -> attach -> doctor contour", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-install-attach-proof-test-"));
  const workspaceRoot = path.join(root, "workspace");
  const validationSurfaceRoot = path.join(root, "validation-surface");
  const outputRoot = path.join(root, "dist");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = runInstallAttachProof({
    outputRoot,
    validationSurfaceRoot,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.steps[1].command, "install packed bundle into local node_modules");
  assert.equal(result.steps[2].command, "init");
  assert.equal(result.steps[3].command, "attach");
  assert.equal(result.steps[4].command, "doctor");
  assert.equal(result.artifact_checks.install_state, true);
  assert.equal(result.artifact_checks.attached_repository, true);
  assert.equal(result.doctor_checks["runtime-dependency:better-sqlite3"]?.status, "ok");
  assert.equal(result.doctor_checks["git-workspace"]?.status, "ok");
  assert.equal(result.doctor_checks["adapter-availability:codex_local"]?.status, "ok");
  assert.equal(result.doctor_checks["adapter-availability:claude_code_local"]?.status, "ok");
  assert.equal(fs.existsSync(result.tarball_path), true);
  assert.equal(fs.existsSync(path.join(result.workspace_root, ".niis", "exports", "html")), false);
  assert.doesNotMatch(result.steps[3].stdout, /generated HTML previews|Phase/u);
});
