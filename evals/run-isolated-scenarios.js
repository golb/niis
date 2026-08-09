import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareProtectedStateSnapshots,
  createProtectedStateSnapshot,
} from "../scripts/protected-state-snapshot.mjs";
import { EvalHarnessError, runScenarioSuite } from "./run-scenarios.js";

class IsolatedEvalError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "IsolatedEvalError";
    this.result = result;
  }
}

const PATH_FLAGS_RESOLVED_FROM_SOURCE = new Set([
  "--host-root",
  "--source-path",
  "--validation-surface-root",
]);

function resolveFlagValue(args, flagName) {
  const index = args.indexOf(flagName);
  return index === -1 ? null : args[index + 1] ?? null;
}

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

function normalizeScenarioArgs(args, sourceCwd, {
  isolatedSourceRoot = sourceCwd,
  sourceRoot = sourceCwd,
} = {}) {
  const normalized = [...(args ?? [])];

  if (
    normalized.length > 0
    && !normalized[0].startsWith("-")
    && !path.isAbsolute(normalized[0])
  ) {
    const sourceScriptPath = path.resolve(sourceCwd, normalized[0]);
    if (fs.existsSync(sourceScriptPath)) {
      normalized[0] = mapSourcePathToIsolatedCopy(
        sourceScriptPath,
        sourceRoot,
        isolatedSourceRoot,
      );
    }
  }

  for (let index = 0; index < normalized.length - 1; index += 1) {
    if (!PATH_FLAGS_RESOLVED_FROM_SOURCE.has(normalized[index])) {
      continue;
    }

    normalized[index + 1] = mapSourcePathToIsolatedCopy(
      (() => {
        const resolvedPath = path.resolve(sourceCwd, normalized[index + 1]);
        if (!isPathInside(sourceRoot, resolvedPath)) {
          throw new IsolatedEvalError(
            `${normalized[index]} must resolve inside the isolated eval source`,
          );
        }
        return resolvedPath;
      })(),
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

function normalizeScenarioCommand(command, sourceCwd, {
  isolatedSourceRoot,
  sourceRoot,
}) {
  if (
    typeof command !== "string"
    || (
      !path.isAbsolute(command)
      && !command.includes("/")
      && !command.includes("\\")
    )
  ) {
    return command;
  }
  const sourceCommandPath = path.isAbsolute(command)
    ? path.resolve(command)
    : path.resolve(sourceCwd, command);
  if (!fs.existsSync(sourceCommandPath)) {
    return command;
  }
  return mapSourcePathToIsolatedCopy(
    sourceCommandPath,
    sourceRoot,
    isolatedSourceRoot,
  );
}

function createIsolatedSuiteDefinition({
  outputDirectory,
  isolatedSourceRoot,
  sourceRoot,
  suite,
  workspaceRoot,
}) {
  const normalizedSuite = structuredClone(suite);
  normalizedSuite.scenarios = (normalizedSuite.scenarios ?? []).map((scenario) => {
    const sourceCwd = path.resolve(sourceRoot, scenario.cwd ?? ".");
    return {
      ...scenario,
      args: normalizeScenarioArgs(scenario.args, sourceCwd, {
        isolatedSourceRoot,
        sourceRoot,
      }),
      command: normalizeScenarioCommand(scenario.command, sourceCwd, {
        isolatedSourceRoot,
        sourceRoot,
      }),
      cwd: ".",
    };
  });

  if (outputDirectory) {
    const suiteId = normalizedSuite.suite_id ?? normalizedSuite.suiteId ?? "eval-suite";
    normalizedSuite.output_path = path.join(outputDirectory, `${suiteId}.json`);
    normalizedSuite.asset_health_output_path = path.join(
      outputDirectory,
      `${suiteId}.asset-health.json`,
    );
  } else {
    normalizedSuite.output_path = path.join(
      workspaceRoot,
      ".niis",
      "proofs",
      "evals",
      "result.json",
    );
    normalizedSuite.asset_health_output_path = path.join(
      workspaceRoot,
      ".niis",
      "proofs",
      "evals",
      "asset-health.json",
    );
  }

  return normalizedSuite;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
        throw new IsolatedEvalError(
          `source symlink escapes the isolated copy: ${sourcePath}`,
        );
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
    throw new IsolatedEvalError(
      `unsupported source entry in isolated copy: ${sourcePath}`,
    );
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

function createIsolatedWorkspaceFacade(isolatedSourceRoot, workspaceRoot) {
  for (const entryName of [
    "config",
    "docs",
    "evals",
    "node_modules",
    "package-lock.json",
    "package.json",
    "packages",
    "scripts",
  ]) {
    if (!fs.existsSync(path.join(isolatedSourceRoot, entryName))) {
      continue;
    }
    fs.symlinkSync(
      path.join(".source", entryName),
      path.join(workspaceRoot, entryName),
    );
  }
}

function resolveProtectedLiveRoots(sourceRoot) {
  return [
    sourceRoot,
    path.join(path.dirname(sourceRoot), ".niis"),
  ].filter((entry, index, entries) => entries.indexOf(entry) === index);
}

function snapshotProtectedState(sourceRoot) {
  return resolveProtectedLiveRoots(sourceRoot).map((stateRoot) => ({
    snapshot: createProtectedStateSnapshot(stateRoot),
    state_root: stateRoot,
  }));
}

function assertProtectedStateUnchanged(beforeSnapshots) {
  const mutations = [];

  for (const before of beforeSnapshots) {
    const after = createProtectedStateSnapshot(before.state_root);
    if (compareProtectedStateSnapshots(before.snapshot, after).changed) {
      mutations.push({
        after_sha256: after.sha256,
        before_sha256: before.snapshot.sha256,
        state_root: before.state_root,
      });
    }
  }

  if (mutations.length > 0) {
    throw new IsolatedEvalError(
      "eval suite mutated a protected live source or .niis state root",
      { mutations },
    );
  }
}

function runIsolatedScenarioSuite({
  keepWorkspace = false,
  outputDirectory = null,
  sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  suitePath = path.join("evals", "scenarios", "proof-regression-suite.json"),
} = {}) {
  const normalizedSourceRoot = path.resolve(sourceRoot);
  const normalizedOutputDirectory = outputDirectory
    ? path.resolve(outputDirectory)
    : null;
  const resolvedSuitePath = path.isAbsolute(suitePath)
    ? path.resolve(suitePath)
    : path.resolve(normalizedSourceRoot, suitePath);
  if (
    normalizedOutputDirectory
    && resolveProtectedLiveRoots(normalizedSourceRoot).some((protectedRoot) =>
      isPathInside(protectedRoot, normalizedOutputDirectory))
  ) {
    throw new IsolatedEvalError(
      "eval output directory must be outside the protected source repository",
    );
  }
  const workspaceRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "niis-eval-suite-")),
  );
  const isolatedSourceRoot = path.join(workspaceRoot, ".source");
  const isolatedSuitePath = path.join(workspaceRoot, "suite.json");
  const protectedState = snapshotProtectedState(normalizedSourceRoot);
  const previousWorkspaceRoot = process.env.NIIS_PROOF_WORKSPACE_ROOT;
  const previousSourceRoot = process.env.NIIS_EVAL_SOURCE_ROOT;
  let isolatedSourceSnapshot = null;
  let suiteResult = null;
  let suiteError = null;

  if (normalizedOutputDirectory) {
    fs.mkdirSync(normalizedOutputDirectory, { recursive: true });
  }

  try {
    cloneSourceTree(normalizedSourceRoot, isolatedSourceRoot);
    setTreeOwnerWritable(isolatedSourceRoot, false);
    createIsolatedWorkspaceFacade(isolatedSourceRoot, workspaceRoot);
    isolatedSourceSnapshot = createProtectedStateSnapshot(isolatedSourceRoot);
    const suite = JSON.parse(fs.readFileSync(resolvedSuitePath, "utf8"));
    const isolatedSuite = createIsolatedSuiteDefinition({
      isolatedSourceRoot,
      outputDirectory: normalizedOutputDirectory,
      sourceRoot: normalizedSourceRoot,
      suite,
      workspaceRoot,
    });
    writeJson(isolatedSuitePath, isolatedSuite);
    process.env.NIIS_PROOF_WORKSPACE_ROOT = workspaceRoot;
    process.env.NIIS_EVAL_SOURCE_ROOT = isolatedSourceRoot;

    try {
      suiteResult = runScenarioSuite({
        suitePath: isolatedSuitePath,
        workspaceRoot,
      });
    } catch (error) {
      suiteError = error;
      suiteResult = error instanceof EvalHarnessError ? error.result : null;
    }
  } finally {
    if (previousWorkspaceRoot === undefined) {
      delete process.env.NIIS_PROOF_WORKSPACE_ROOT;
    } else {
      process.env.NIIS_PROOF_WORKSPACE_ROOT = previousWorkspaceRoot;
    }
    if (previousSourceRoot === undefined) {
      delete process.env.NIIS_EVAL_SOURCE_ROOT;
    } else {
      process.env.NIIS_EVAL_SOURCE_ROOT = previousSourceRoot;
    }
  }

  try {
    assertProtectedStateUnchanged(protectedState);
    if (isolatedSourceSnapshot) {
      const isolatedSourceAfter = createProtectedStateSnapshot(isolatedSourceRoot);
      if (
        compareProtectedStateSnapshots(
          isolatedSourceSnapshot,
          isolatedSourceAfter,
        ).changed
      ) {
        throw new IsolatedEvalError(
          "eval suite mutated its read-only isolated source copy",
          {
            after_sha256: isolatedSourceAfter.sha256,
            before_sha256: isolatedSourceSnapshot.sha256,
          },
        );
      }
    }
  } finally {
    setTreeOwnerWritable(isolatedSourceRoot, true);
    if (!keepWorkspace) {
      fs.rmSync(workspaceRoot, { force: true, recursive: true });
    }
  }

  const result = suiteResult
    ? Object.freeze({
      ...suiteResult,
      ephemeral_workspace: !keepWorkspace,
      isolated: true,
      output_path: normalizedOutputDirectory ? suiteResult.output_path : null,
      asset_health_output_path:
        normalizedOutputDirectory ? suiteResult.asset_health_output_path : null,
      workspace_root: keepWorkspace ? workspaceRoot : null,
      isolated_source_root: keepWorkspace ? isolatedSourceRoot : null,
    })
    : null;

  if (suiteError) {
    throw new IsolatedEvalError(
      suiteError.message,
      result,
    );
  }

  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const positionalSuitePath = process.argv
    .slice(2)
    .find((arg, index, args) =>
      !arg.startsWith("-")
      && args[index - 1] !== "--output-dir");
  const outputDirectory = resolveFlagValue(process.argv, "--output-dir");
  const keepWorkspace = process.argv.includes("--keep-workspace");

  try {
    console.log(JSON.stringify(runIsolatedScenarioSuite({
      keepWorkspace,
      outputDirectory,
      suitePath: positionalSuitePath
        ?? path.join("evals", "scenarios", "proof-regression-suite.json"),
    }), null, 2));
  } catch (error) {
    if (error instanceof IsolatedEvalError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  IsolatedEvalError,
  runIsolatedScenarioSuite,
};
