import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

class BootstrapProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "BootstrapProofError";
    this.result = result;
  }
}

function runCliStep({
  cliEntrypoint,
  command,
  commandArgs = [],
  workspaceRoot,
}) {
  const result = spawnSync(
    process.execPath,
    [cliEntrypoint, command, ...commandArgs],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
    },
  );

  return {
    command,
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    stderr: result.stderr?.trim() ?? "",
    stdout: result.stdout?.trim() ?? "",
  };
}

function buildProofArtifacts(workspaceRoot) {
  const stateRoot = path.join(workspaceRoot, ".niis");
  const exportsRoot = path.join(stateRoot, "exports");

  return Object.freeze({
    attached_repository: path.join(exportsRoot, "attached-repository.json"),
    backup_policy: path.join(stateRoot, "backup-policy.json"),
    install_state: path.join(stateRoot, "install-state.json"),
    project_profile: path.join(exportsRoot, "project-profile.md"),
    sqlite_database: path.join(stateRoot, "db", "niis-v1.sqlite"),
    workflow: path.join(exportsRoot, "workflow.md"),
  });
}

function verifyProofArtifacts(artifacts) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(artifacts).map(([key, artifactPath]) => [key, fs.existsSync(artifactPath)]),
    ),
  );
}

function runBootstrapProof({
  workspaceRoot = process.cwd(),
  cliEntrypoint = null,
  validationSurfaceRoot = workspaceRoot,
} = {}) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedValidationSurfaceRoot = path.resolve(validationSurfaceRoot);
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const resolvedCliEntrypoint = cliEntrypoint
    ? path.resolve(cliEntrypoint)
    : path.resolve(scriptDirectory, "..", "bin", "niis.js");
  const steps = [
    runCliStep({
      cliEntrypoint: resolvedCliEntrypoint,
      command: "init",
      workspaceRoot: normalizedWorkspaceRoot,
    }),
    runCliStep({
      cliEntrypoint: resolvedCliEntrypoint,
      command: "attach",
      commandArgs: ["--validation-surface-root", normalizedValidationSurfaceRoot],
      workspaceRoot: normalizedWorkspaceRoot,
    }),
    runCliStep({
      cliEntrypoint: resolvedCliEntrypoint,
      command: "profile",
      commandArgs: ["--validation-surface-root", normalizedValidationSurfaceRoot],
      workspaceRoot: normalizedWorkspaceRoot,
    }),
  ];
  const artifacts = buildProofArtifacts(normalizedWorkspaceRoot);
  const artifactChecks = verifyProofArtifacts(artifacts);
  const ok = steps.every((step) => step.ok) && Object.values(artifactChecks).every(Boolean);
  const result = {
    artifact_checks: artifactChecks,
    artifacts,
    cli_entrypoint: resolvedCliEntrypoint,
    ok,
    steps,
    validation_surface_root: normalizedValidationSurfaceRoot,
    workspace_root: normalizedWorkspaceRoot,
  };

  if (!ok) {
    throw new BootstrapProofError(
      "bootstrap proof failed; inspect failed step output or missing artifacts",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const validationSurfaceRootFlagIndex = process.argv.indexOf("--validation-surface-root");
    const validationSurfaceRoot = validationSurfaceRootFlagIndex === -1
      ? process.cwd()
      : path.resolve(process.cwd(), process.argv[validationSurfaceRootFlagIndex + 1] ?? ".");

    console.log(JSON.stringify(runBootstrapProof({
      validationSurfaceRoot,
    }), null, 2));
  } catch (error) {
    if (error instanceof BootstrapProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  BootstrapProofError,
  runBootstrapProof,
};
