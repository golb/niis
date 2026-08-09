#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
const READ_ONLY_PATH_FLAGS = new Set([
  "--host-root",
  "--source-path",
  "--validation-surface-root",
]);
const ISOLATION_CONTROLLED_FLAGS = new Set([
  "--npm-cache-root",
  "--output-root",
  "--state-root",
  "--workspace-root",
]);

function isPathInside(rootPath, candidatePath) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function mapSourcePathToIsolatedCopy(sourcePath, sourceRoot, isolatedSourceRoot) {
  if (!isPathInside(sourceRoot, sourcePath)) {
    return sourcePath;
  }
  return path.join(
    isolatedSourceRoot,
    path.relative(path.resolve(sourceRoot), path.resolve(sourcePath)),
  );
}

function normalizeProofArgs(
  args,
  sourceRoot,
  isolatedSourceRoot = sourceRoot,
  { allowExternalReadPaths = false } = {},
) {
  const normalized = [...args];

  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    const controlledFlag = [...ISOLATION_CONTROLLED_FLAGS].find((flag) =>
      argument === flag || argument.startsWith(`${flag}=`));
    if (controlledFlag) {
      throw new Error(
        `${controlledFlag} is controlled by the isolated proof runner and cannot be overridden`,
      );
    }
    if (!READ_ONLY_PATH_FLAGS.has(argument)) {
      continue;
    }

    const value = normalized[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a path value`);
    }
    const sourcePath = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(sourceRoot, value);
    if (!allowExternalReadPaths && !isPathInside(sourceRoot, sourcePath)) {
      throw new Error(
        `${argument} must resolve inside the isolated source; use --allow-live-host explicitly`,
      );
    }
    normalized[index + 1] = mapSourcePathToIsolatedCopy(
      sourcePath,
      sourceRoot,
      isolatedSourceRoot,
    );
    index += 1;
  }

  return normalized.map((argument) =>
    path.isAbsolute(argument)
      ? mapSourcePathToIsolatedCopy(
          argument,
          sourceRoot,
          isolatedSourceRoot,
        )
      : argument);
}

function resolveProtectedLiveRoots(sourceRoot) {
  return [
    sourceRoot,
    path.join(path.dirname(sourceRoot), ".niis"),
  ].filter((entry, index, entries) => entries.indexOf(entry) === index);
}

function cloneSourceTree(sourceRoot, isolatedSourceRoot) {
  const sourceRootPath = path.resolve(sourceRoot);
  const copyEntry = (sourcePath, destinationPath, relativePath) => {
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
      const resolvedTarget = path.resolve(
        path.dirname(sourcePath),
        fs.readlinkSync(sourcePath),
      );
      if (!isPathInside(sourceRootPath, resolvedTarget)) {
        throw new Error(`source symlink escapes the isolated copy: ${sourcePath}`);
      }
      const isolatedTarget = path.join(
        isolatedSourceRoot,
        path.relative(sourceRootPath, resolvedTarget),
      );
      fs.symlinkSync(
        path.relative(path.dirname(destinationPath), isolatedTarget),
        destinationPath,
      );
      return;
    }
    if (stat.isDirectory()) {
      if (relativePath === ".git" || relativePath === ".niis") {
        return;
      }
      fs.mkdirSync(destinationPath, {
        mode: stat.mode & 0o777,
        recursive: true,
      });
      for (const childName of fs.readdirSync(sourcePath)) {
        const childRelativePath = relativePath === ""
          ? childName
          : `${relativePath}/${childName}`;
        copyEntry(
          path.join(sourcePath, childName),
          path.join(destinationPath, childName),
          childRelativePath,
        );
      }
      return;
    }
    if (stat.isFile()) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(
        sourcePath,
        destinationPath,
        fs.constants.COPYFILE_FICLONE,
      );
      fs.chmodSync(destinationPath, stat.mode & 0o777);
      return;
    }
    throw new Error(`unsupported source entry in isolated copy: ${sourcePath}`);
  };

  fs.mkdirSync(isolatedSourceRoot, { mode: 0o700, recursive: true });
  for (const entryName of fs.readdirSync(sourceRootPath)) {
    copyEntry(
      path.join(sourceRootPath, entryName),
      path.join(isolatedSourceRoot, entryName),
      entryName,
    );
  }
}

function setTreeOwnerWritable(rootPath, writable) {
  if (!fs.existsSync(rootPath)) return;
  const visit = (entryPath) => {
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) return;
    const currentMode = stat.mode & 0o777;
    fs.chmodSync(
      entryPath,
      writable ? currentMode | 0o200 : currentMode & ~0o222,
    );
    if (stat.isDirectory()) {
      for (const childName of fs.readdirSync(entryPath)) {
        visit(path.join(entryPath, childName));
      }
    }
  };
  visit(rootPath);
}

function runIsolatedProof({
  args = [],
  env = {},
  keepWorkspace = false,
  allowExternalReadPaths = false,
  scriptPath,
  sourceRoot = PROJECT_ROOT,
  stdio = "pipe",
} = {}) {
  if (typeof scriptPath !== "string" || scriptPath.trim() === "") {
    throw new Error("isolated proof runner requires a proof script path");
  }

  const normalizedSourceRoot = fs.realpathSync(path.resolve(sourceRoot));
  const requestedScriptPath = path.isAbsolute(scriptPath)
    ? path.resolve(scriptPath)
    : path.resolve(normalizedSourceRoot, scriptPath);
  const resolvedScriptPath = fs.realpathSync(requestedScriptPath);
  if (!isPathInside(normalizedSourceRoot, resolvedScriptPath)) {
    throw new Error("proof script must resolve inside the source repository");
  }

  const protectedBefore = resolveProtectedLiveRoots(normalizedSourceRoot).map((stateRoot) =>
    createProtectedStateSnapshot(stateRoot));
  const workspaceRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "niis-proof-")),
  );
  fs.chmodSync(workspaceRoot, 0o700);
  const isolatedSourceRoot = path.join(workspaceRoot, ".source");
  cloneSourceTree(normalizedSourceRoot, isolatedSourceRoot);
  setTreeOwnerWritable(isolatedSourceRoot, false);
  const isolatedScriptPath = mapSourcePathToIsolatedCopy(
    resolvedScriptPath,
    normalizedSourceRoot,
    isolatedSourceRoot,
  );
  const normalizedArgs = normalizeProofArgs(
    args,
    normalizedSourceRoot,
    isolatedSourceRoot,
    { allowExternalReadPaths },
  );
  const temporaryRoot = path.join(workspaceRoot, ".tmp");
  fs.mkdirSync(temporaryRoot, { mode: 0o700 });
  const isolatedSourceBefore = createProtectedStateSnapshot(isolatedSourceRoot);
  let childResult;

  try {
    childResult = spawnSync(
      process.execPath,
      [isolatedScriptPath, ...normalizedArgs],
      {
        cwd: workspaceRoot,
        encoding: stdio === "pipe" ? "utf8" : undefined,
        env: {
          ...process.env,
          ...env,
          NIIS_EVAL_SOURCE_ROOT: isolatedSourceRoot,
          NIIS_PROOF_SOURCE_ROOT: isolatedSourceRoot,
          NIIS_PROOF_WORKSPACE_ROOT: workspaceRoot,
          TEMP: temporaryRoot,
          TMP: temporaryRoot,
          TMPDIR: temporaryRoot,
        },
        stdio,
      },
    );
  } finally {
    if (!childResult) {
      setTreeOwnerWritable(isolatedSourceRoot, true);
      if (!keepWorkspace) {
        fs.rmSync(workspaceRoot, { force: true, recursive: true });
      }
    }
  }

  const protectedAfter = protectedBefore.map((snapshot) =>
    createProtectedStateSnapshot(snapshot.root));
  const mutations = protectedBefore
    .map((snapshot, index) =>
      compareProtectedStateSnapshots(snapshot, protectedAfter[index]))
    .filter((comparison) => comparison.changed);
  const isolatedSourceAfter = createProtectedStateSnapshot(isolatedSourceRoot);
  const isolatedSourceMutation = compareProtectedStateSnapshots(
    isolatedSourceBefore,
    isolatedSourceAfter,
  );
  if (isolatedSourceMutation.changed) {
    mutations.push(isolatedSourceMutation);
  }
  const proofExitCode = childResult.status ?? 1;
  const exitCode = mutations.length > 0 ? 1 : proofExitCode;

  setTreeOwnerWritable(isolatedSourceRoot, true);
  if (!keepWorkspace) {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  }

  return Object.freeze({
    error: childResult.error ?? null,
    exitCode,
    mutations: Object.freeze(mutations),
    ok: exitCode === 0,
    proofExitCode,
    signal: childResult.signal ?? null,
    stderr: typeof childResult.stderr === "string" ? childResult.stderr : null,
    stdout: typeof childResult.stdout === "string" ? childResult.stdout : null,
    isolatedSourceRoot: keepWorkspace ? isolatedSourceRoot : null,
    workspaceRoot: keepWorkspace ? workspaceRoot : null,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliArgs = process.argv.slice(2);
  const allowExternalReadPaths = cliArgs[0] === "--allow-live-host";
  const [scriptPath, ...args] = allowExternalReadPaths ? cliArgs.slice(1) : cliArgs;
  const result = runIsolatedProof({
    args,
    allowExternalReadPaths,
    scriptPath,
    stdio: "inherit",
  });

  if (result.mutations.length > 0) {
    for (const mutation of result.mutations) {
      process.stderr.write(
        `[niis proof guard] protected live state changed: ${mutation.before.root} `
        + `(before=${mutation.before.sha256}, after=${mutation.after.sha256})\n`,
      );
    }
  }
  if (result.error) {
    process.stderr.write(`[niis proof runner] ${result.error.message}\n`);
  }
  if (result.signal) {
    process.stderr.write(`[niis proof runner] proof stopped by ${result.signal}\n`);
  }
  process.exitCode = result.exitCode;
}

export {
  normalizeProofArgs,
  runIsolatedProof,
};
