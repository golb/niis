#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareProtectedStateSnapshots,
  createProtectedStateSnapshot,
} from "./protected-state-snapshot.mjs";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function captureProtectedState(stateRoot) {
  return createProtectedStateSnapshot(stateRoot);
}

function compareProtectedState(before, after) {
  return compareProtectedStateSnapshots(before, after);
}

function runTestsWithStateGuard({
  projectRoot = PROJECT_ROOT,
  testArgs = [],
} = {}) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const protectedRoots = [
    path.join(resolvedProjectRoot, ".niis"),
    path.join(path.dirname(resolvedProjectRoot), ".niis"),
  ];
  const before = protectedRoots.map(captureProtectedState);
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", ...testArgs],
    {
      cwd: resolvedProjectRoot,
      env: {
        ...process.env,
        NIIS_TEST_RUN: "1",
      },
      stdio: "inherit",
    },
  );
  const comparisons = protectedRoots.map((stateRoot, index) =>
    compareProtectedState(before[index], captureProtectedState(stateRoot)));
  const mutations = comparisons.filter((entry) => entry.changed);

  if (mutations.length > 0) {
    for (const mutation of mutations) {
      process.stderr.write(
        `[niis test guard] protected live state changed: ${mutation.before.root} `
        + `(before=${mutation.before.sha256 ?? "missing"}, `
        + `after=${mutation.after.sha256 ?? "missing"})\n`,
      );
    }
  }

  return Object.freeze({
    exitCode: mutations.length > 0 ? 1 : (result.status ?? 1),
    mutations: Object.freeze(mutations),
    signal: result.signal ?? null,
    testExitCode: result.status ?? 1,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = runTestsWithStateGuard({
    testArgs: process.argv.slice(2),
  });
  if (outcome.signal) {
    process.stderr.write(
      `[niis test guard] test process stopped by ${outcome.signal}\n`,
    );
  }
  process.exitCode = outcome.exitCode;
}

export {
  captureProtectedState,
  compareProtectedState,
  runTestsWithStateGuard,
};
