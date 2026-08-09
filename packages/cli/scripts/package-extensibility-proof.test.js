import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPackageExtensibilityProof } from "./package-extensibility-proof.js";

test("runPackageExtensibilityProof loads activated role/adapter/validator/agent packages without kernel edits", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-package-extensibility-proof-test-"));
  const workspaceRoot = path.join(root, "workspace");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = runPackageExtensibilityProof({
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.init_step.ok, true);
  assert.equal(result.route_step.parsed_json?.selected_adapter?.id, result.package_ids.adapter);
  assert.equal(result.route_step.parsed_json?.selected_lane?.manifest_id, result.package_ids.role);
  assert.equal(result.review_step.parsed_json?.results?.[0]?.validator?.id, result.package_ids.validator);
  assert.equal(result.serve_step.command_args.at(-1), "--once");
  assert.equal(result.serve_step.command_args.includes("--daemon"), false);
  assert.equal(
    result.serve_step.parsed_json?.snapshot?.agents?.some((agent) => agent.id === result.package_ids.agent),
    true,
  );
});
