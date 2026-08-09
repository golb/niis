import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { packNpxCliBundle } from "./pack-npx-cli.js";

class InstallAttachProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "InstallAttachProofError";
    this.result = result;
  }
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function writeFile(filePath, content, { executable = false } = {}) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, content);

  if (executable) {
    fs.chmodSync(filePath, 0o755);
  }
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createValidationSurface(validationSurfaceRoot) {
  writeJson(path.join(validationSurfaceRoot, "package.json"), {
    name: "proof-host",
    private: true,
    type: "module",
    dependencies: {
      "@hapi/hapi": "^20.0.0",
    },
  });
  writeFile(path.join(validationSurfaceRoot, "README.md"), "# Install Attach Proof\n");
  writeFile(path.join(validationSurfaceRoot, "src/server.js"), "export const server = true;\n");
}

function createFakeRuntimeBin(binRoot, name, versionText) {
  writeFile(path.join(binRoot, name), `#!/bin/sh\necho "${versionText}"\n`, {
    executable: true,
  });
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

function runNpxCliStep({
  command,
  commandArgs = [],
  env,
  workspaceRoot,
}) {
  const result = spawnSync(
    "npx",
    ["--no-install", "niis", command, ...commandArgs],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env,
    },
  );
  const stdout = result.stdout?.trim() ?? "";

  return Object.freeze({
    command,
    command_args: commandArgs,
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    parsed_json: commandArgs.includes("--json") && stdout ? JSON.parse(stdout) : null,
    stderr: result.stderr?.trim() ?? "",
    stdout,
  });
}

function buildProofArtifacts(workspaceRoot) {
  const stateRoot = path.join(workspaceRoot, ".niis");
  const exportsRoot = path.join(stateRoot, "exports");

  return Object.freeze({
    attached_repository: path.join(exportsRoot, "attached-repository.json"),
    install_state: path.join(stateRoot, "install-state.json"),
    project_profile: path.join(exportsRoot, "project-profile.md"),
    sqlite_database: path.join(stateRoot, "db", "niis-v1.sqlite"),
  });
}

function copyDirectory(sourcePath, targetPath) {
  ensureDirectory(targetPath);

  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceEntryPath = path.join(sourcePath, entry.name);
    const targetEntryPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourceEntryPath, targetEntryPath);
      continue;
    }

    if (entry.isFile()) {
      fs.copyFileSync(sourceEntryPath, targetEntryPath);
    }
  }
}

function installPackedBundle({
  bundleRoot,
  workspaceRoot,
}) {
  const installRoot = path.join(workspaceRoot, "node_modules", "@niis", "cli");
  const binPath = path.join(workspaceRoot, "node_modules", ".bin", "niis");

  fs.rmSync(path.join(workspaceRoot, "node_modules"), { force: true, recursive: true });
  copyDirectory(bundleRoot, installRoot);
  writeFile(
    binPath,
    [
      "#!/bin/sh",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(installRoot, "packages", "cli", "bin", "niis.js"))} "$@"`,
      "",
    ].join("\n"),
    { executable: true },
  );

  return Object.freeze({
    command: "install packed bundle into local node_modules",
    exit_code: 0,
    ok: true,
    stderr: "",
    stdout: installRoot,
  });
}

function verifyProofArtifacts(artifacts) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(artifacts).map(([key, artifactPath]) => [key, fs.existsSync(artifactPath)]),
    ),
  );
}

function findCheck(checks, id) {
  return Array.isArray(checks)
    ? checks.find((check) => check?.id === id) ?? null
    : null;
}

function runInstallAttachProof({
  outputRoot = null,
  validationSurfaceRoot = null,
  workspaceRoot = null,
} = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-install-attach-proof-"));
  const resolvedWorkspaceRoot = workspaceRoot
    ? path.resolve(workspaceRoot)
    : path.join(tempRoot, "workspace");
  const resolvedValidationSurfaceRoot = validationSurfaceRoot
    ? path.resolve(validationSurfaceRoot)
    : path.join(tempRoot, "validation-surface");
  const resolvedOutputRoot = outputRoot
    ? path.resolve(outputRoot)
    : path.join(tempRoot, "dist");
  const binRoot = path.join(tempRoot, "bin");

  ensureDirectory(resolvedWorkspaceRoot);
  ensureDirectory(resolvedValidationSurfaceRoot);
  ensureDirectory(resolvedOutputRoot);
  ensureDirectory(binRoot);
  const gitInit = spawnSync("git", ["init", "--quiet"], {
    cwd: resolvedWorkspaceRoot,
    encoding: "utf8",
  });
  if (gitInit.status !== 0) {
    throw new InstallAttachProofError(
      gitInit.stderr?.trim() || "failed to initialize proof Git workspace",
    );
  }
  createValidationSurface(resolvedValidationSurfaceRoot);
  createFakeRuntimeBin(binRoot, "codex", "codex-cli 0.0.0-proof");
  createFakeRuntimeBin(binRoot, "claude-code", "1.0.0-proof (Claude Code)");

  const proofEnv = {
    ...process.env,
    PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const packStep = runPackStep({
    outputRoot: resolvedOutputRoot,
  });
  const steps = [
    packStep,
    installPackedBundle({
      bundleRoot: packStep.bundle_root,
      workspaceRoot: resolvedWorkspaceRoot,
    }),
    runNpxCliStep({
      command: "init",
      env: proofEnv,
      workspaceRoot: resolvedWorkspaceRoot,
    }),
    runNpxCliStep({
      command: "attach",
      commandArgs: ["--validation-surface-root", resolvedValidationSurfaceRoot],
      env: proofEnv,
      workspaceRoot: resolvedWorkspaceRoot,
    }),
    runNpxCliStep({
      command: "doctor",
      commandArgs: ["--json"],
      env: proofEnv,
      workspaceRoot: resolvedWorkspaceRoot,
    }),
  ];
  const artifacts = buildProofArtifacts(resolvedWorkspaceRoot);
  const artifactChecks = verifyProofArtifacts(artifacts);
  const doctorStep = steps.at(-1);
  const doctorChecks = doctorStep?.parsed_json?.checks ?? [];
  const requiredDoctorChecks = {
    "adapter-availability:claude_code_local": findCheck(doctorChecks, "adapter-availability:claude_code_local"),
    "adapter-availability:codex_local": findCheck(doctorChecks, "adapter-availability:codex_local"),
    "runtime-dependency:better-sqlite3": findCheck(doctorChecks, "runtime-dependency:better-sqlite3"),
    "git-workspace": findCheck(doctorChecks, "git-workspace"),
    "sqlite-db": findCheck(doctorChecks, "sqlite-db"),
    "install-state-commands": findCheck(doctorChecks, "install-state-commands"),
  };
  const ok = [
    steps.every((step) => step.ok),
    Object.values(artifactChecks).every(Boolean),
    requiredDoctorChecks["adapter-availability:claude_code_local"]?.status === "ok",
    requiredDoctorChecks["adapter-availability:codex_local"]?.status === "ok",
    requiredDoctorChecks["runtime-dependency:better-sqlite3"]?.status === "ok",
    requiredDoctorChecks["git-workspace"]?.status === "ok",
    requiredDoctorChecks["sqlite-db"]?.status === "ok",
    requiredDoctorChecks["install-state-commands"]?.status === "ok",
  ].every(Boolean);
  const result = {
    artifact_checks: artifactChecks,
    artifacts,
    doctor_checks: requiredDoctorChecks,
    ok,
    steps,
    tarball_path: packStep.tarball_path,
    temp_root: tempRoot,
    validation_surface_root: resolvedValidationSurfaceRoot,
    workspace_root: resolvedWorkspaceRoot,
  };

  if (!ok) {
    throw new InstallAttachProofError(
      "install/attach proof failed; inspect the packaged CLI step output or doctor checks",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runInstallAttachProof(), null, 2));
  } catch (error) {
    if (error instanceof InstallAttachProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  InstallAttachProofError,
  runInstallAttachProof,
};
