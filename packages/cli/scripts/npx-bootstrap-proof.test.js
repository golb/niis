import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runNpxBootstrapProof } from "./npx-bootstrap-proof.js";

test("runNpxBootstrapProof packs a local tarball and bootstraps a temp workspace via npm exec", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-npx-bootstrap-test-"));
  const workspaceRoot = path.join(root, "workspace");
  const outputRoot = path.join(root, "dist");
  const npmCacheRoot = path.join(root, "npm-cache");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = runNpxBootstrapProof({
    npmCacheRoot,
    outputRoot,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.steps[0].command, "pack-npx-cli");
  assert.match(result.steps[1].command, /npm exec/);
  assert.equal(result.artifact_checks.install_state, true);
  assert.equal(result.artifact_checks.backup_policy, true);
  assert.equal(result.artifact_checks.sqlite_database, true);
  assert.equal(result.state_root_targets_workspace, true);
  assert.equal(
    fs.realpathSync(result.install_state_summary?.state_root ?? ""),
    fs.realpathSync(path.join(workspaceRoot, ".niis")),
  );
  assert.equal(fs.existsSync(result.tarball_path), true);
});
