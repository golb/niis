import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runLocalRuntimesProof } from "./local-runtimes-proof.js";

test("runLocalRuntimesProof validates codex_local and claude_code_local as first-class runtimes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-local-runtimes-proof-test-"));
  const workspaceRoot = path.join(root, "workspace");
  const outputRoot = path.join(root, "artifacts");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = await runLocalRuntimesProof({
    outputRoot,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.codex_local.ok, true);
  assert.equal(result.diagnostics.claude_code_local.ok, true);
  assert.equal(result.route_steps[0].parsed_json.selected_adapter.id, "codex_local");
  assert.equal(result.route_steps[1].parsed_json.selected_adapter.id, "claude_code_local");
  assert.equal(fs.existsSync(result.artifacts.proof_output_path), true);
});
