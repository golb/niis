import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { packNpxCliBundle } from "./pack-npx-cli.js";

class NpxBootstrapProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "NpxBootstrapProofError";
    this.result = result;
  }
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildProofArtifacts(workspaceRoot) {
  const stateRoot = path.join(workspaceRoot, ".niis");

  return Object.freeze({
    backup_policy: path.join(stateRoot, "backup-policy.json"),
    install_state: path.join(stateRoot, "install-state.json"),
    sqlite_database: path.join(stateRoot, "db", "niis-v1.sqlite"),
  });
}

function verifyProofArtifacts(artifacts) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(artifacts).map(([key, artifactPath]) => [key, fs.existsSync(artifactPath)]),
    ),
  );
}

function summarizeInstallState(installStatePath) {
  if (!fs.existsSync(installStatePath)) {
    return null;
  }

  const installState = readJson(installStatePath);

  return Object.freeze({
    package_root: installState.package_root ?? null,
    state_root: installState.state_root ?? null,
    status: installState.status ?? null,
  });
}

function canonicalizeExistingPath(filePath) {
  return fs.existsSync(filePath) ? fs.realpathSync(filePath) : path.resolve(filePath);
}

function runPackStep({ outputRoot }) {
  const packed = packNpxCliBundle({
    outputRoot,
  });

  return Object.freeze({
    bundle_root: packed.bundle_root,
    command: "pack-npx-cli",
    exit_code: 0,
    ok: true,
    stderr: "",
    stdout: packed.tarball_path,
    tarball_path: packed.tarball_path,
  });
}

function runNpxInitStep({
  npmCacheRoot,
  tarballPath,
  workspaceRoot,
}) {
  const result = spawnSync(
    "npm",
    ["exec", "--yes", "--package", tarballPath, "--", "niis", "init"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_cache: npmCacheRoot,
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
    },
  );

  return Object.freeze({
    command: "npm exec --yes --package <local-tgz> -- niis init",
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    stderr: result.stderr?.trim() ?? "",
    stdout: result.stdout?.trim() ?? "",
  });
}

function resolveFlagValue(args, flagName) {
  const index = args.indexOf(flagName);
  if (index === -1) {
    return null;
  }

  return args[index + 1] ?? null;
}

function runNpxBootstrapProof({
  npmCacheRoot = null,
  outputRoot = null,
  workspaceRoot = null,
} = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-npx-bootstrap-proof-"));
  const resolvedWorkspaceRoot = workspaceRoot
    ? path.resolve(workspaceRoot)
    : path.join(tempRoot, "workspace");
  const resolvedOutputRoot = outputRoot
    ? path.resolve(outputRoot)
    : path.join(tempRoot, "dist");
  const resolvedNpmCacheRoot = npmCacheRoot
    ? path.resolve(npmCacheRoot)
    : path.join(tempRoot, "npm-cache");

  ensureDirectory(resolvedWorkspaceRoot);
  ensureDirectory(resolvedNpmCacheRoot);

  const packStep = runPackStep({
    outputRoot: resolvedOutputRoot,
  });
  const initStep = runNpxInitStep({
    npmCacheRoot: resolvedNpmCacheRoot,
    tarballPath: packStep.tarball_path,
    workspaceRoot: resolvedWorkspaceRoot,
  });
  const artifacts = buildProofArtifacts(resolvedWorkspaceRoot);
  const artifactChecks = verifyProofArtifacts(artifacts);
  const installStateSummary = summarizeInstallState(artifacts.install_state);
  const workspaceStateRoot = path.join(resolvedWorkspaceRoot, ".niis");
  const stateRootTargetsWorkspace = installStateSummary?.state_root
    ? canonicalizeExistingPath(installStateSummary.state_root) === canonicalizeExistingPath(workspaceStateRoot)
    : false;
  const ok = [
    packStep.ok,
    initStep.ok,
    Object.values(artifactChecks).every(Boolean),
    stateRootTargetsWorkspace,
  ].every(Boolean);
  const result = {
    artifact_checks: artifactChecks,
    artifacts,
    install_state_summary: installStateSummary,
    npx_cache_root: resolvedNpmCacheRoot,
    ok,
    steps: [packStep, initStep],
    state_root_targets_workspace: stateRootTargetsWorkspace,
    tarball_path: packStep.tarball_path,
    temp_root: tempRoot,
    workspace_root: resolvedWorkspaceRoot,
  };

  if (!ok) {
    throw new NpxBootstrapProofError(
      "npx bootstrap proof failed; inspect the packaged init step output or missing artifacts",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runNpxBootstrapProof({
      npmCacheRoot: resolveFlagValue(process.argv, "--npm-cache-root"),
      outputRoot: resolveFlagValue(process.argv, "--output-root"),
      workspaceRoot: resolveFlagValue(process.argv, "--workspace-root"),
    }), null, 2));
  } catch (error) {
    if (error instanceof NpxBootstrapProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  NpxBootstrapProofError,
  runNpxBootstrapProof,
};
