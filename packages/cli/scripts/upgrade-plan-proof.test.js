import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runUpgradePlanProof } from "./upgrade-plan-proof.js";

test("runUpgradePlanProof validates read-only upgrade preflight without mutating local state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-upgrade-proof-test-"));
  const workspaceRoot = path.join(root, "workspace");
  const outputRoot = path.join(root, "artifacts");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = runUpgradePlanProof({
    outputRoot,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.steps[0].command, "init");
  assert.equal(result.steps[1].command, "upgrade-plan");
  assert.equal(result.readonly_state_checks.install_state_unchanged, true);
  assert.equal(result.readonly_state_checks.database_unchanged, true);
  assert.equal(fs.existsSync(result.artifacts.proof_output_path), true);
});
