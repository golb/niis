import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareProtectedStateSnapshots,
  createProtectedStateSnapshot,
} from "./protected-state-snapshot.mjs";

test("protected state distinguishes missing roots from empty directories", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-state-snapshot-"));
  const stateRoot = path.join(fixtureRoot, ".niis");
  t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }));

  const missing = createProtectedStateSnapshot(stateRoot);
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const empty = createProtectedStateSnapshot(stateRoot);

  assert.equal(missing.exists, false);
  assert.equal(empty.exists, true);
  assert.equal(empty.entry_count, 1);
  assert.equal(compareProtectedStateSnapshots(missing, empty).changed, true);
});

test("protected state detects permission, symlink, and timestamp-only changes", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-state-metadata-"));
  const stateRoot = path.join(fixtureRoot, ".niis");
  const directoryPath = path.join(stateRoot, "private");
  const filePath = path.join(directoryPath, "secret");
  const linkPath = path.join(stateRoot, "current");
  t.after(() => {
    fs.chmodSync(directoryPath, 0o700);
    fs.rmSync(fixtureRoot, { force: true, recursive: true });
  });

  fs.mkdirSync(directoryPath, { mode: 0o700, recursive: true });
  fs.writeFileSync(filePath, "sensitive-value\n", { mode: 0o600 });
  fs.symlinkSync("private/secret", linkPath);

  const baseline = createProtectedStateSnapshot(stateRoot);
  assert.equal(JSON.stringify(baseline).includes("sensitive-value"), false);

  fs.chmodSync(filePath, 0o400);
  const fileModeChanged = createProtectedStateSnapshot(stateRoot);
  assert.equal(compareProtectedStateSnapshots(baseline, fileModeChanged).changed, true);

  fs.chmodSync(filePath, 0o600);
  fs.chmodSync(directoryPath, 0o500);
  const directoryModeChanged = createProtectedStateSnapshot(stateRoot);
  assert.equal(compareProtectedStateSnapshots(baseline, directoryModeChanged).changed, true);

  fs.chmodSync(directoryPath, 0o700);
  fs.unlinkSync(linkPath);
  fs.symlinkSync("private", linkPath);
  const symlinkChanged = createProtectedStateSnapshot(stateRoot);
  assert.equal(compareProtectedStateSnapshots(baseline, symlinkChanged).changed, true);

  fs.unlinkSync(linkPath);
  fs.symlinkSync("private/secret", linkPath);
  fs.utimesSync(filePath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
  const timestampChanged = createProtectedStateSnapshot(stateRoot);
  assert.equal(compareProtectedStateSnapshots(baseline, timestampChanged).changed, true);
});
