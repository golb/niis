import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureProtectedState,
  compareProtectedState,
} from "./run-tests-with-state-guard.mjs";

test("protected-state snapshots distinguish missing, unchanged, and mutated state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-test-state-guard-"));
  const stateRoot = path.join(root, ".niis");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const missing = captureProtectedState(stateRoot);
  assert.equal(missing.exists, false);

  fs.mkdirSync(stateRoot, { recursive: true });
  const empty = captureProtectedState(stateRoot);
  assert.equal(compareProtectedState(missing, empty).changed, true);

  fs.writeFileSync(path.join(stateRoot, "sentinel"), "before\n");
  const before = captureProtectedState(stateRoot);
  const unchanged = captureProtectedState(stateRoot);
  assert.equal(compareProtectedState(before, unchanged).changed, false);

  fs.writeFileSync(path.join(stateRoot, "sentinel"), "after\n");
  const after = captureProtectedState(stateRoot);
  assert.equal(compareProtectedState(before, after).changed, true);
  assert.equal(compareProtectedState(missing, after).changed, true);

  fs.chmodSync(path.join(stateRoot, "sentinel"), 0o400);
  assert.equal(
    compareProtectedState(after, captureProtectedState(stateRoot)).changed,
    true,
  );
});
