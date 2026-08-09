import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

class UpgradePlanProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "UpgradePlanProofError";
    this.result = result;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntrypoint = path.resolve(__dirname, "..", "bin", "niis.js");

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function runCliStep({
  command,
  commandArgs = [],
  workspaceRoot,
  parseJson = false,
}) {
  const result = spawnSync(process.execPath, [cliEntrypoint, command, ...commandArgs], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const stdout = result.stdout?.trim() ?? "";
  const step = {
    command,
    command_args: commandArgs,
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    stderr: result.stderr?.trim() ?? "",
    stdout,
  };

  if (!parseJson || result.status !== 0) {
    return step;
  }

  return Object.freeze({
    ...step,
    parsed_json: stdout ? JSON.parse(stdout) : null,
  });
}

function resolveFlagValue(args, flagName) {
  const index = args.indexOf(flagName);
  if (index === -1) {
    return null;
  }

  return args[index + 1] ?? null;
}

function runUpgradePlanProof({
  outputRoot = null,
  workspaceRoot = null,
} = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-upgrade-plan-proof-"));
  const resolvedWorkspaceRoot = workspaceRoot
    ? path.resolve(workspaceRoot)
    : path.join(tempRoot, "workspace");
  const resolvedOutputRoot = outputRoot
    ? path.resolve(outputRoot)
    : path.join(tempRoot, "artifacts");

  ensureDirectory(resolvedWorkspaceRoot);
  ensureDirectory(resolvedOutputRoot);

  const initStep = runCliStep({
    command: "init",
    workspaceRoot: resolvedWorkspaceRoot,
  });

  const installStatePath = path.join(resolvedWorkspaceRoot, ".niis", "install-state.json");
  const databasePath = path.join(resolvedWorkspaceRoot, ".niis", "db", "niis-v1.sqlite");
  const installState = JSON.parse(fs.readFileSync(installStatePath, "utf8"));
  const specPath = path.join(resolvedOutputRoot, "upgrade-plan-spec.json");

  writeJson(specPath, {
    installStatePath,
    packageRoot: installState.package_root,
    releaseBundle: {
      bundleId: "bundle-core-0.2.0",
      compatibility: {
        min_niis_version: "0.1.0",
        required_adapters: [],
      },
      fileRefs: ["package.json"],
      migrationRefs: ["migrations/0002.sql"],
      packageId: "@niis/core",
      version: "0.2.0",
    },
    storageTargetBackend: {
      backendId: "hosted-preview",
      displayName: "Hosted Preview",
      kind: "hosted_service",
      migrationCapabilities: {
        snapshotImport: true,
      },
      supportedSchemaVersions: ["2"],
    },
  });

  const installStateHashBefore = hashFile(installStatePath);
  const databaseHashBefore = hashFile(databasePath);
  const planStep = runCliStep({
    command: "upgrade-plan",
    commandArgs: [specPath],
    parseJson: true,
    workspaceRoot: resolvedWorkspaceRoot,
  });
  const installStateHashAfter = hashFile(installStatePath);
  const databaseHashAfter = hashFile(databasePath);
  const proofOutputPath = path.join(resolvedOutputRoot, "upgrade-plan-proof.json");
  const parsedPlan = planStep.parsed_json ?? null;
  const readonlyStateChecks = Object.freeze({
    database_unchanged: databaseHashBefore === databaseHashAfter,
    install_state_unchanged: installStateHashBefore === installStateHashAfter,
  });
  const ok = [
    initStep.ok,
    planStep.ok,
    parsedPlan?.compatibility_status === "migration_required",
    parsedPlan?.storage_plan?.compatibility_status === "migration_required",
    parsedPlan?.blocked_by?.length === 0,
    parsedPlan?.readonly_preflight === true,
    readonlyStateChecks.install_state_unchanged,
    readonlyStateChecks.database_unchanged,
  ].every(Boolean);
  const result = {
    artifacts: {
      database_path: databasePath,
      install_state_path: installStatePath,
      proof_output_path: proofOutputPath,
      spec_path: specPath,
    },
    ok,
    readonly_state_checks: readonlyStateChecks,
    steps: [initStep, planStep],
    temp_root: tempRoot,
    workspace_root: resolvedWorkspaceRoot,
  };

  writeJson(proofOutputPath, result);

  if (!ok) {
    throw new UpgradePlanProofError(
      "upgrade-plan proof failed; inspect preflight output or readonly-state checks",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runUpgradePlanProof({
      outputRoot: resolveFlagValue(process.argv, "--output-root"),
      workspaceRoot: resolveFlagValue(process.argv, "--workspace-root"),
    }), null, 2));
  } catch (error) {
    if (error instanceof UpgradePlanProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  UpgradePlanProofError,
  runUpgradePlanProof,
};
