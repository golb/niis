import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createStoredRunLogRecord,
  createRunLogPaths,
  hydrateRunLogRecord,
} from "./run-logs.js";

function createStateRoot(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-run-logs-"));
  t.after(() => {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  });

  return path.join(tempRoot, ".niis");
}

test("createStoredRunLogRecord keeps small payloads inline", (t) => {
  const stateRoot = createStateRoot(t);
  const record = createStoredRunLogRecord({
    inlineBytes: 128,
    rawOutput: "ok",
    runId: "run-inline",
    stateRoot,
  });

  assert.equal(record.run_log.storage, "inline");
  assert.equal(record.raw_output, "ok");
  assert.equal(record.raw_output_ref, null);
});

test("createStoredRunLogRecord writes large payloads to file refs and hydrates them back", (t) => {
  const stateRoot = createStateRoot(t);
  const rawOutput = {
    status: "SUCCESS",
    summary: "x".repeat(2048),
  };
  const record = createStoredRunLogRecord({
    inlineBytes: 64,
    rawOutput,
    runId: "run-ref",
    stateRoot,
  });
  const hydrated = hydrateRunLogRecord(record, { stateRoot });
  const paths = createRunLogPaths(stateRoot, "run-ref");

  assert.equal(record.run_log.storage, "ref");
  assert.equal(record.raw_output, null);
  assert.equal(record.raw_output_ref, ".niis/artifacts/run-logs/run-ref.json");
  assert.equal(fs.existsSync(paths.jsonArtifactPath), true);
  assert.deepEqual(hydrated.raw_output, rawOutput);
});

test("hydrateRunLogRecord detects tampered run log artifacts", (t) => {
  const stateRoot = createStateRoot(t);
  const record = createStoredRunLogRecord({
    inlineBytes: 10,
    rawOutput: {
      summary: "tamper-me".repeat(100),
    },
    runId: "run-tampered",
    stateRoot,
  });
  const paths = createRunLogPaths(stateRoot, "run-tampered");

  fs.writeFileSync(paths.jsonArtifactPath, JSON.stringify({ summary: "mutated" }), "utf8");

  assert.throws(
    () => hydrateRunLogRecord(record, { stateRoot }),
    /run log integrity mismatch/,
  );
});
