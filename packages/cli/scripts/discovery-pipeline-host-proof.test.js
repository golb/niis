import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runDiscoveryPipelineHostProof } from "./discovery-pipeline-host-proof.js";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("runDiscoveryPipelineHostProof discovers real filesystem package candidates and registry dedup", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-discovery-pipeline-host-proof-"));
  const workspaceRoot = path.join(root, "niis");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  writeJson(path.join(workspaceRoot, "packages", "core", "package.json"), {
    name: "@niis/core",
    version: "0.1.0",
    private: true,
    type: "module",
  });
  writeJson(path.join(workspaceRoot, "packages", "cli", "package.json"), {
    name: "@niis/cli",
    version: "0.1.0",
    private: true,
    type: "module",
  });

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = runDiscoveryPipelineHostProof({
    validationSurfaceRoot: workspaceRoot,
    workspaceRoot,
  });

  assert.equal(result.has_core_candidate, true);
  assert.equal(result.has_cli_candidate, true);
  assert.equal(result.helper_candidate_detected, true);
  assert.equal(result.duplicate_core_detected, true);
  assert.equal(result.parallel_ready_seeker_count, 2);
  assert.equal(result.report_id, "discovery-pipeline-host-proof");
  assert.equal(fs.existsSync(result.artifacts.summary), true);
});
