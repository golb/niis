import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isPidAlive,
  reclaimExpiredTaskLeases,
  releaseTaskLease,
  renewTaskLease,
  tryAcquireTaskLease,
} from "./main.js";

function createStateRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niis-lease-test-"));
  t.after(() => { try { fs.rmSync(dir, { force: true, recursive: true }); } catch {  } });
  return dir;
}

test("tryAcquireTaskLease creates a fresh lease when none exists", (t) => {
  const stateRoot = createStateRoot(t);
  const result = tryAcquireTaskLease({ holder: "cli:1", stateRoot, taskId: "task-a" });
  assert.equal(result.ok, true);
  assert.equal(result.reclaimed, false);
  assert.equal(result.lease.holder, "cli:1");
  assert.equal(result.lease.task_id, "task-a");
  assert.ok(fs.existsSync(path.join(stateRoot, "leases", "task-a.json")));
});

test("task leases reject traversal and collision-prone IDs without writing", (t) => {
  const stateRoot = createStateRoot(t);
  for (const taskId of [
    ".",
    "..",
    "../escape",
    "task/escape",
    "TASK",
    "task_name",
    "ｔａｓｋ",
  ]) {
    assert.throws(
      () => tryAcquireTaskLease({ holder: "cli:test", stateRoot, taskId }),
      /canonical lower-case ASCII task id/,
      taskId,
    );
  }
  assert.equal(fs.existsSync(path.join(stateRoot, "leases")), false);
});

test("task leases reject an existing symlink alias", (t) => {
  const stateRoot = createStateRoot(t);
  const leasesRoot = path.join(stateRoot, "leases");
  const external = path.join(stateRoot, "external.json");
  fs.mkdirSync(leasesRoot, { recursive: true });
  fs.writeFileSync(external, "external\n");
  fs.symlinkSync(external, path.join(leasesRoot, "task-alias.json"));

  assert.throws(
    () => tryAcquireTaskLease({
      holder: "cli:test",
      stateRoot,
      taskId: "task-alias",
    }),
    /filesystem alias/,
  );
  assert.equal(fs.readFileSync(external, "utf8"), "external\n");
});

test("tryAcquireTaskLease refuses a second acquire while the first holder is alive", (t) => {
  const stateRoot = createStateRoot(t);
  const first = tryAcquireTaskLease({ holder: "cli:first", stateRoot, taskId: "task-b", ttlMs: 60_000 });
  assert.equal(first.ok, true);
  const second = tryAcquireTaskLease({ holder: "cli:second", stateRoot, taskId: "task-b" });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "held_by_other");
  assert.equal(second.conflict.holder, "cli:first");
});

test("tryAcquireTaskLease reclaims a lease whose PID is dead", (t) => {
  const stateRoot = createStateRoot(t);

  const leasePath = path.join(stateRoot, "leases", "task-c.json");
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  fs.writeFileSync(leasePath, JSON.stringify({
    acquired_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    holder: "cli:ghost",
    pid: 999_999_999,
    task_id: "task-c",
  }));
  const result = tryAcquireTaskLease({ holder: "cli:new", stateRoot, taskId: "task-c" });
  assert.equal(result.ok, true);
  assert.equal(result.reclaimed, true);
  assert.equal(result.lease.holder, "cli:new");
});

test("tryAcquireTaskLease reclaims an expired lease even if PID is alive", (t) => {
  const stateRoot = createStateRoot(t);
  const leasePath = path.join(stateRoot, "leases", "task-d.json");
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  fs.writeFileSync(leasePath, JSON.stringify({
    acquired_at: new Date(Date.now() - 120_000).toISOString(),
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    holder: "cli:slow",
    pid: process.pid,
    task_id: "task-d",
  }));
  const result = tryAcquireTaskLease({ holder: "cli:fast", stateRoot, taskId: "task-d" });
  assert.equal(result.ok, true);
  assert.equal(result.reclaimed, true);
});

test("renewTaskLease extends expiry and rejects foreign holders", (t) => {
  const stateRoot = createStateRoot(t);
  const acquired = tryAcquireTaskLease({ holder: "cli:owner", stateRoot, taskId: "task-e", ttlMs: 1000 });
  assert.equal(acquired.ok, true);
  const originalExpiry = Date.parse(acquired.lease.expires_at);
  const renewed = renewTaskLease({ holder: "cli:owner", stateRoot, taskId: "task-e", ttlMs: 60_000 });
  assert.equal(renewed.ok, true);
  assert.ok(Date.parse(renewed.lease.expires_at) > originalExpiry);
  const foreign = renewTaskLease({ holder: "cli:other", stateRoot, taskId: "task-e" });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, "holder_mismatch");
});

test("releaseTaskLease removes only a matching holder's lease", (t) => {
  const stateRoot = createStateRoot(t);
  tryAcquireTaskLease({ holder: "cli:X", stateRoot, taskId: "task-f" });
  const wrongHolder = releaseTaskLease({ holder: "cli:Y", stateRoot, taskId: "task-f" });
  assert.equal(wrongHolder.ok, false);
  assert.equal(wrongHolder.reason, "holder_mismatch");
  assert.ok(fs.existsSync(path.join(stateRoot, "leases", "task-f.json")));
  const ok = releaseTaskLease({ holder: "cli:X", stateRoot, taskId: "task-f" });
  assert.equal(ok.ok, true);
  assert.ok(!fs.existsSync(path.join(stateRoot, "leases", "task-f.json")));
});

test("reclaimExpiredTaskLeases drops dead and expired records, keeps fresh ones", (t) => {
  const stateRoot = createStateRoot(t);
  const leasesDir = path.join(stateRoot, "leases");
  fs.mkdirSync(leasesDir, { recursive: true });

  fs.writeFileSync(path.join(leasesDir, "alive.json"), JSON.stringify({
    expires_at: new Date(Date.now() + 60_000).toISOString(), holder: "ui", pid: process.pid,
  }));

  fs.writeFileSync(path.join(leasesDir, "expired.json"), JSON.stringify({
    expires_at: new Date(Date.now() - 1000).toISOString(), holder: "ui", pid: process.pid,
  }));

  fs.writeFileSync(path.join(leasesDir, "dead.json"), JSON.stringify({
    expires_at: new Date(Date.now() + 60_000).toISOString(), holder: "ui", pid: 999_999_999,
  }));

  fs.writeFileSync(path.join(leasesDir, "corrupt.json"), "not json {");
  const report = reclaimExpiredTaskLeases({ stateRoot });
  assert.equal(report.total, 4);
  assert.equal(report.reclaimed, 3);
  assert.ok(fs.existsSync(path.join(leasesDir, "alive.json")));
  assert.ok(!fs.existsSync(path.join(leasesDir, "expired.json")));
  assert.ok(!fs.existsSync(path.join(leasesDir, "dead.json")));
  assert.ok(!fs.existsSync(path.join(leasesDir, "corrupt.json")));
});

test("isPidAlive returns true for the current process and false for impossible PIDs", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999_999_999), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive("foo"), false);
});
