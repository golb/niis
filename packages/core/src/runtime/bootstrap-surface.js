import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  collectInstallStateChecks,
  createBootstrapInstallState,
  readInstallState,
  writeInstallState,
} from "./install-state.js";
import {
  collectBackupHealthChecks,
  collectRunLogStorageChecks,
  collectSecretStoreChecks,
  collectSqliteStorageChecks,
  createSqliteDatabasePath,
  createBackupPaths,
  createRunLogPaths,
  createSecretStorePaths,
  createLocalSecretStore,
  createLifecycleSqliteStore,
  writeBackupPolicy,
  createSqliteStorage,
} from "../storage/index.js";

const require = createRequire(import.meta.url);

function readPackageType(packageManifestPath) {
  if (!fs.existsSync(packageManifestPath)) {
    return null;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(packageManifestPath, "utf8"));
    return manifest?.type || null;
  } catch {
    return null;
  }
}

function createInitPlan(workspaceRoot) {
  return createInitPlanForStateRoot(workspaceRoot, path.join(path.resolve(workspaceRoot), ".niis"));
}

function createInitPlanForStateRoot(workspaceRoot, stateRoot) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedStateRoot = path.resolve(stateRoot);
  const backupPaths = createBackupPaths(normalizedStateRoot);
  const runLogPaths = createRunLogPaths(normalizedStateRoot, "bootstrap");
  const secretStorePaths = createSecretStorePaths(normalizedStateRoot);

  return {
    artifactsRoot: runLogPaths.artifactsRoot,
    backupPolicyPath: backupPaths.backupPolicyPath,
    backupsRoot: backupPaths.backupsRoot,
    databasePath: createSqliteDatabasePath(normalizedStateRoot),
    packageRoot: normalizedWorkspaceRoot,
    stateRoot: normalizedStateRoot,
    runLogsRoot: runLogPaths.runLogsRoot,
    secretMasterKeyPath: secretStorePaths.secretMasterKeyPath,
    secretStorePath: secretStorePaths.secretStorePath,
    secretsRoot: secretStorePaths.secretsRoot,
    directories: [
      normalizedStateRoot,
      path.join(normalizedStateRoot, "db"),
      path.join(normalizedStateRoot, "exports"),
      runLogPaths.artifactsRoot,
      path.join(normalizedStateRoot, "cache"),
      backupPaths.backupsRoot,
      secretStorePaths.secretsRoot,
    ],
    installStatePath: path.join(normalizedStateRoot, "install-state.json"),
    stateIgnorePath: path.join(normalizedStateRoot, ".gitignore"),
  };
}

function maybeFailBootstrapStep(failAfterStep, stepName) {
  if (failAfterStep === stepName) {
    throw new Error(`simulated bootstrap failure after ${stepName}`);
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function removePathIfExists(targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { force: true, recursive: true });
  }
}

class BootstrapStateCompatibilityError extends Error {
  constructor(message, diagnostics = []) {
    super(`${message} Run \`niis upgrade-plan\` before changing this state.`);
    this.name = "BootstrapStateCompatibilityError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

function assertSafeExistingStateRoot({ stateRoot, workspaceRoot }) {
  let stateStat;
  try {
    stateStat = fs.lstatSync(stateRoot);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }

  const diagnostics = [];
  if (stateStat.isSymbolicLink()) {
    diagnostics.push({
      id: "state-root-symlink",
      message: "the .niis state root must not be a symbolic link",
    });
  } else if (!stateStat.isDirectory()) {
    diagnostics.push({
      id: "state-root-type",
      message: "the .niis state root must be a directory",
    });
  } else {
    const canonicalWorkspaceRoot = fs.realpathSync(workspaceRoot);
    const canonicalStateRoot = fs.realpathSync(stateRoot);
    const expectedStateRoot = path.join(canonicalWorkspaceRoot, ".niis");
    if (canonicalStateRoot !== expectedStateRoot) {
      diagnostics.push({
        id: "state-root-location",
        message:
          `resolved state root ${canonicalStateRoot} is not the exact .niis `
          + `directory inside ${canonicalWorkspaceRoot}`,
      });
    }
  }

  if (diagnostics.length > 0) {
    throw new BootstrapStateCompatibilityError(
      "Existing .niis state is unsafe and was left untouched.",
      diagnostics,
    );
  }

  return true;
}

function isPathInside(rootPath, candidatePath) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolvePathThroughExistingAncestor(targetPath) {
  const missingSegments = [];
  let currentPath = path.resolve(targetPath);

  while (true) {
    let stat = null;
    try {
      stat = fs.lstatSync(currentPath);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw error;
      }
    }

    if (stat) {
      const canonicalAncestor = fs.realpathSync(currentPath);
      return path.resolve(canonicalAncestor, ...missingSegments);
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`could not resolve an existing ancestor for path: ${targetPath}`);
    }
    missingSegments.unshift(path.basename(currentPath));
    currentPath = parentPath;
  }
}

function assertExternalBackupRoot({ backupRoot, stateRoot, workspaceRoot }) {
  const canonicalBackupRoot = resolvePathThroughExistingAncestor(backupRoot);
  const canonicalStateRoot = resolvePathThroughExistingAncestor(stateRoot);
  const canonicalWorkspaceRoot = resolvePathThroughExistingAncestor(workspaceRoot);

  if (
    isPathInside(canonicalWorkspaceRoot, canonicalBackupRoot)
    || isPathInside(canonicalStateRoot, canonicalBackupRoot)
  ) {
    throw new Error(
      "reset backup root must resolve outside the project workspace and live state",
    );
  }

  return canonicalBackupRoot;
}

function listStateFiles(rootPath) {
  const normalizedRoot = path.resolve(rootPath);
  const entries = [];

  function visit(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(normalizedRoot, absolutePath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        entries.push({
          kind: "symlink",
          path: relativePath,
          target: fs.readlinkSync(absolutePath),
        });
        continue;
      }

      if (entry.isFile()) {
        const contents = fs.readFileSync(absolutePath);
        entries.push({
          bytes: contents.byteLength,
          kind: "file",
          path: relativePath,
          sha256: crypto.createHash("sha256").update(contents).digest("hex"),
        });
      }
    }
  }

  if (fs.existsSync(normalizedRoot)) {
    visit(normalizedRoot);
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function createStateTreeDigest(rootPath) {
  const files = listStateFiles(rootPath);
  const sha256 = crypto
    .createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");

  return Object.freeze({
    file_count: files.length,
    files: Object.freeze(files),
    root: path.resolve(rootPath),
    sha256,
  });
}

function assertCompatibleExistingState(finalPlan) {
  const diagnostics = [];
  const installStateExists = fs.existsSync(finalPlan.installStatePath);
  const databaseExists = fs.existsSync(finalPlan.databasePath);
  const secretKeyExists = fs.existsSync(finalPlan.secretMasterKeyPath);
  const secretStoreExists = fs.existsSync(finalPlan.secretStorePath);

  if (installStateExists) {
    try {
      const currentInstallState = readInstallState(finalPlan.installStatePath);
      if (
        currentInstallState?.state_root
        && path.resolve(currentInstallState.state_root) !== finalPlan.stateRoot
      ) {
        diagnostics.push({
          id: "install-state-root",
          message: `stored state root ${currentInstallState.state_root} does not match ${finalPlan.stateRoot}`,
        });
      }
    } catch (error) {
      diagnostics.push({
        id: "install-state",
        message: `install-state is invalid: ${error.message}`,
      });
    }
  }

  if (databaseExists) {
    const checkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-init-db-check-"));
    const checkDatabasePath = path.join(checkRoot, path.basename(finalPlan.databasePath));

    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        const sourcePath = `${finalPlan.databasePath}${suffix}`;
        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, `${checkDatabasePath}${suffix}`);
        }
      }

      const sqliteChecks = collectSqliteStorageChecks(checkDatabasePath);
      for (const check of sqliteChecks.filter((entry) => entry.status === "error")) {
        diagnostics.push({
          id: check.id,
          message: check.details,
        });
      }
    } finally {
      removePathIfExists(checkRoot);
    }
  }

  if (secretKeyExists !== secretStoreExists) {
    diagnostics.push({
      id: "secret-store-pair",
      message: "secret master key and encrypted store must either both exist or both be absent",
    });
  } else if (secretKeyExists && secretStoreExists) {
    try {
      const secretStore = createLocalSecretStore({
        createIfMissing: false,
        stateRoot: finalPlan.stateRoot,
      });
      secretStore.listSecrets();
    } catch (error) {
      diagnostics.push({
        id: "secret-store",
        message: `secret store is invalid: ${error.message}`,
      });
    }
  }

  if (diagnostics.length > 0) {
    throw new BootstrapStateCompatibilityError(
      "Existing .niis state is incompatible and was left untouched.",
      diagnostics,
    );
  }
}

function copyMissingBootstrapState(tempPlan, finalPlan) {
  const repaired = [];

  for (const directory of finalPlan.directories) {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
      repaired.push(path.relative(finalPlan.stateRoot, directory) || ".");
    }
  }

  const filePairs = [
    [tempPlan.stateIgnorePath, finalPlan.stateIgnorePath],
    [tempPlan.installStatePath, finalPlan.installStatePath],
    [tempPlan.backupPolicyPath, finalPlan.backupPolicyPath],
    [tempPlan.databasePath, finalPlan.databasePath],
    [tempPlan.secretMasterKeyPath, finalPlan.secretMasterKeyPath],
    [tempPlan.secretStorePath, finalPlan.secretStorePath],
  ];

  for (const [sourcePath, targetPath] of filePairs) {
    if (fs.existsSync(targetPath)) {
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(targetPath, fs.statSync(sourcePath).mode & 0o777);
    repaired.push(path.relative(finalPlan.stateRoot, targetPath));
  }

  return repaired.sort();
}

function initializeBootstrapState(
  workspaceRoot,
  {
    failAfterStep = null,
    installRoot = workspaceRoot,
    now = new Date(),
  } = {},
) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedInstallRoot = path.resolve(installRoot);
  const finalPlan = createInitPlan(normalizedWorkspaceRoot);
  const tempStateRoot = path.join(
    path.dirname(finalPlan.stateRoot),
    `.niis-init-${process.pid}-${Date.now()}`,
  );
  const tempPlan = createInitPlanForStateRoot(normalizedWorkspaceRoot, tempStateRoot);
  const stateAlreadyExists = assertSafeExistingStateRoot({
    stateRoot: finalPlan.stateRoot,
    workspaceRoot: normalizedWorkspaceRoot,
  });

  removePathIfExists(tempStateRoot);

  if (stateAlreadyExists) {
    assertCompatibleExistingState(finalPlan);
  }

  try {
    for (const directory of tempPlan.directories) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(tempPlan.stateIgnorePath, "*\n", { mode: 0o600 });
    fs.chmodSync(tempPlan.stateIgnorePath, 0o600);
    maybeFailBootstrapStep(failAfterStep, "directories");

    const bootstrapInstallState = createBootstrapInstallState({
      databasePath: finalPlan.databasePath,
      now,
      packageRoot: normalizedInstallRoot,
      stateRoot: finalPlan.stateRoot,
    });
    writeInstallState(tempPlan.installStatePath, bootstrapInstallState);
    maybeFailBootstrapStep(failAfterStep, "install_state");

    writeBackupPolicy(tempPlan.stateRoot);
    maybeFailBootstrapStep(failAfterStep, "backup_policy");

    createLocalSecretStore({
      stateRoot: tempPlan.stateRoot,
    });
    maybeFailBootstrapStep(failAfterStep, "secret_store");

    const sqliteStorage = createSqliteStorage({
      databasePath: tempPlan.databasePath,
    });
    sqliteStorage.close();
    const lifecycleStorage = createLifecycleSqliteStore({
      databasePath: tempPlan.databasePath,
    });
    lifecycleStorage.close();
    maybeFailBootstrapStep(failAfterStep, "sqlite");

    if (stateAlreadyExists) {
      const repaired = copyMissingBootstrapState(tempPlan, finalPlan);
      removePathIfExists(tempPlan.stateRoot);

      return {
        install_root: normalizedInstallRoot,
        mode: repaired.length === 0 ? "verified" : "repaired",
        plan: finalPlan,
        repaired: Object.freeze(repaired),
      };
    }

    fs.renameSync(tempPlan.stateRoot, finalPlan.stateRoot);

    return {
      install_root: normalizedInstallRoot,
      mode: "created",
      plan: finalPlan,
      repaired: Object.freeze([]),
    };
  } catch (error) {
    removePathIfExists(tempPlan.stateRoot);
    throw error;
  }
}

function deriveBootstrapProjectId(workspaceRoot) {
  const normalizedName = path.basename(path.resolve(workspaceRoot))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalizedName || "project";
}

function preflightResetBootstrapState(
  workspaceRoot,
  {
    backupTo,
    confirmProjectId,
  } = {},
) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const plan = createInitPlan(normalizedWorkspaceRoot);
  const projectId = deriveBootstrapProjectId(normalizedWorkspaceRoot);

  if (!assertSafeExistingStateRoot({
    stateRoot: plan.stateRoot,
    workspaceRoot: normalizedWorkspaceRoot,
  })) {
    throw new Error(`state root does not exist: ${plan.stateRoot}`);
  }

  if (confirmProjectId !== projectId) {
    throw new Error(`reset confirmation must exactly match project id: ${projectId}`);
  }

  if (typeof backupTo !== "string" || backupTo.trim() === "") {
    throw new Error("reset requires an external backup root via --backup-to");
  }

  const backupRoot = assertExternalBackupRoot({
    backupRoot: backupTo,
    stateRoot: plan.stateRoot,
    workspaceRoot: normalizedWorkspaceRoot,
  });

  return Object.freeze({
    backupRoot,
    plan,
    projectId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
}

function resetBootstrapState(
  workspaceRoot,
  {
    backupTo,
    confirmProjectId,
    failAfterStep = null,
    now = new Date(),
  } = {},
) {
  const preflight = preflightResetBootstrapState(workspaceRoot, {
    backupTo,
    confirmProjectId,
  });
  const normalizedWorkspaceRoot = preflight.workspaceRoot;
  const normalizedBackupRoot = preflight.backupRoot;
  const plan = preflight.plan;
  const projectId = preflight.projectId;

  const timestamp = new Date(now);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("now must be a valid timestamp");
  }

  fs.mkdirSync(normalizedBackupRoot, { mode: 0o700, recursive: true });
  const verifiedBackupRoot = assertExternalBackupRoot({
    backupRoot: fs.realpathSync(normalizedBackupRoot),
    stateRoot: plan.stateRoot,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const backupId = `${projectId}-${timestamp.toISOString().replace(/[:.]/g, "-")}`;
  const backupDirectory = path.join(verifiedBackupRoot, backupId);
  const snapshotPath = path.join(backupDirectory, "snapshot");
  const manifestPath = path.join(backupDirectory, "manifest.json");

  if (fs.existsSync(backupDirectory)) {
    throw new Error(`reset backup destination already exists: ${backupDirectory}`);
  }

  fs.mkdirSync(snapshotPath, { mode: 0o700, recursive: true });
  fs.chmodSync(backupDirectory, 0o700);
  fs.chmodSync(snapshotPath, 0o700);
  const sourceDigest = createStateTreeDigest(plan.stateRoot);
  fs.cpSync(plan.stateRoot, snapshotPath, {
    dereference: false,
    preserveTimestamps: true,
    recursive: true,
  });
  const backupDigest = createStateTreeDigest(snapshotPath);

  if (sourceDigest.sha256 !== backupDigest.sha256) {
    removePathIfExists(backupDirectory);
    throw new Error("external reset backup verification failed; live state was left untouched");
  }

  const manifest = {
    backup_id: backupId,
    created_at: timestamp.toISOString(),
    project_id: projectId,
    source_state_root: plan.stateRoot,
    source_tree_sha256: sourceDigest.sha256,
    file_count: sourceDigest.file_count,
    snapshot_path: snapshotPath,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);
  maybeFailBootstrapStep(failAfterStep, "verified_backup");

  const preRemovalDigest = createStateTreeDigest(plan.stateRoot);
  if (preRemovalDigest.sha256 !== sourceDigest.sha256) {
    throw new Error(
      "live state changed while the reset backup was being created; "
      + "the verified backup was retained and live state was left untouched",
    );
  }

  const stagedRemovalPath = path.join(
    path.dirname(plan.stateRoot),
    `.niis-reset-${process.pid}-${Date.now()}`,
  );

  try {
    fs.renameSync(plan.stateRoot, stagedRemovalPath);
    maybeFailBootstrapStep(failAfterStep, "staged_removal");
    fs.rmSync(stagedRemovalPath, { force: true, recursive: true });
  } catch (error) {
    if (fs.existsSync(stagedRemovalPath) && !fs.existsSync(plan.stateRoot)) {
      fs.renameSync(stagedRemovalPath, plan.stateRoot);
    }
    throw error;
  }

  return Object.freeze({
    backup_directory: backupDirectory,
    backup_manifest: manifestPath,
    project_id: projectId,
    source_tree_sha256: sourceDigest.sha256,
    state_root: plan.stateRoot,
  });
}

function createAttachPlan(workspaceRoot, { validationSurfaceRoot = workspaceRoot } = {}) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedValidationSurfaceRoot = path.resolve(validationSurfaceRoot);
  const stateRoot = path.join(normalizedWorkspaceRoot, ".niis");
  const exportsRoot = path.join(stateRoot, "exports");
  const cacheRoot = path.join(stateRoot, "cache");

  return {
    cacheRoot,
    packageRoot: normalizedWorkspaceRoot,
    exportsRoot,
    registryPath: path.join(stateRoot, "registry.json"),
    stateRoot,
    validationSurfaceRoot: normalizedValidationSurfaceRoot,
    attachmentPath: path.join(exportsRoot, "attached-repository.json"),
  };
}

function collectDoctorChecks(installRoot, { workspaceRoot = installRoot } = {}) {
  const normalizedInstallRoot = path.resolve(installRoot);
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const initPlan = createInitPlan(normalizedWorkspaceRoot);
  const cliBinPath = path.join(normalizedInstallRoot, "packages", "cli", "bin", "niis.js");
  const packageManifestPath = path.join(normalizedInstallRoot, "package.json");
  const coreManifestPath = path.join(normalizedInstallRoot, "packages", "core", "package.json");
  const cliManifestPath = path.join(normalizedInstallRoot, "packages", "cli", "package.json");
  const nodeMajorVersion = Number.parseInt(process.versions.node.split(".")[0], 10);
  const workspacePackageType = readPackageType(packageManifestPath);
  const corePackageType = readPackageType(coreManifestPath);
  const cliPackageType = readPackageType(cliManifestPath);
  const builtinAdapterChecks = collectBuiltinAdapterAvailabilityChecks();
  const hasBuiltinRuntime = builtinAdapterChecks.some((check) => check.status === "ok");
  const gitCommand = resolveRuntimeCommand({ commandNames: ["git"] });
  const gitWorkspaceProbe = gitCommand
    ? spawnSync(gitCommand, ["-C", normalizedWorkspaceRoot, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    })
    : null;
  const isGitWorkspace = gitWorkspaceProbe?.status === 0
    && gitWorkspaceProbe.stdout.trim() === "true";
  const sandboxCommand = process.platform === "darwin"
    ? resolveRuntimeCommand({ fallbackPaths: ["/usr/bin/sandbox-exec"] })
    : process.platform === "linux"
      ? resolveRuntimeCommand({ commandNames: ["bwrap"], fallbackPaths: ["/usr/bin/bwrap", "/bin/bwrap"] })
      : null;
  const runtimeDependencyChecks = collectRuntimeDependencyChecks({
    installRoot: normalizedInstallRoot,
    workspaceRoot: normalizedWorkspaceRoot,
  });

  const codeHostCheck = collectCodeHostCheck(normalizedWorkspaceRoot);

  return [
    {
      id: "node-version",
      status: nodeMajorVersion >= 20 ? "ok" : "error",
      summary: `Node.js ${process.versions.node}`,
      details: "Bootstrap surface expects Node.js 20+.",
    },
    {
      id: "workspace-package",
      status: fs.existsSync(packageManifestPath) ? "ok" : "error",
      summary: packageManifestPath,
      details: "Root workspace package manifest must exist.",
    },
    {
      id: "workspace-module-format",
      status: workspacePackageType === "module" ? "ok" : "error",
      summary: workspacePackageType || "missing type field",
      details: 'Root workspace manifest must enforce native ESM via `"type": "module"`.',
    },
    {
      id: "core-module-format",
      status: corePackageType === "module" ? "ok" : "error",
      summary: corePackageType || "missing type field",
      details: 'Core package manifest must enforce native ESM via `"type": "module"`.',
    },
    {
      id: "cli-module-format",
      status: cliPackageType === "module" ? "ok" : "error",
      summary: cliPackageType || "missing type field",
      details: 'CLI package manifest must enforce native ESM via `"type": "module"`.',
    },
    {
      id: "cli-bin",
      status: fs.existsSync(cliBinPath) ? "ok" : "error",
      summary: cliBinPath,
      details: "CLI bin entrypoint must exist for the bootstrap command surface.",
    },
    {
      id: "git-command",
      status: gitCommand ? "ok" : "error",
      summary: gitCommand ?? "Git is unavailable",
      details: "Git with worktree support is required before intake or execution.",
    },
    {
      id: "git-workspace",
      status: isGitWorkspace ? "ok" : "error",
      summary: isGitWorkspace ? normalizedWorkspaceRoot : "Workspace is not a Git worktree",
      details: "Attach and execution require a Git worktree as the active workspace.",
    },
    {
      id: "runtime-sandbox",
      status: sandboxCommand ? "ok" : "error",
      summary: sandboxCommand ?? `No supported sandbox for ${process.platform}`,
      details: "macOS requires sandbox-exec; Linux requires Bubblewrap (bwrap).",
    },
    {
      id: "agent-runtime",
      status: hasBuiltinRuntime ? "ok" : "error",
      summary: hasBuiltinRuntime ? "At least one local agent runtime is available" : "No local agent runtime is available",
      details: "Install or configure Codex or Claude before intake.",
    },
    {
      id: "state-root",
      status: fs.existsSync(initPlan.stateRoot) ? "ok" : "warning",
      summary: initPlan.stateRoot,
      details: "Run `init` to scaffold the local state root if it is missing.",
    },
    ...collectInstallStateChecks(normalizedInstallRoot, {
      installStatePath: initPlan.installStatePath,
    }),
    ...collectSqliteStorageChecks(initPlan.databasePath),
    ...collectBackupHealthChecks(initPlan.stateRoot),
    ...collectRunLogStorageChecks(initPlan.stateRoot),
    ...collectSecretStoreChecks(initPlan.stateRoot),
    ...runtimeDependencyChecks,
    ...builtinAdapterChecks,
    codeHostCheck,
  ];
}











function collectCodeHostCheck(workspaceRoot) {
  const id = "code-host";
  let host = "None";
  let remoteUrl = null;
  try {
    const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: workspaceRoot, encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      remoteUrl = r.stdout.trim();
      if (/github\.com/i.test(remoteUrl)) host = "GitHub";
      else if (/gitlab\.com/i.test(remoteUrl)) host = "GitLab";
      else if (/bitbucket\.org/i.test(remoteUrl)) host = "Bitbucket";
      else if (/dev\.azure\.com|visualstudio\.com/i.test(remoteUrl)) host = "Azure DevOps";
      else if (remoteUrl) host = "Other";
    }
  } catch {  }

  if (host === "None") {
    return {
      id,
      status: "warning",
      summary: "No code host",
      details: "Workspace has no `origin` git remote. PR commands (`gh pr create / merge`) won't work.",
      host,
      remote: null,
    };
  }
  if (host !== "GitHub") {
    return {
      id,
      status: "warning",
      summary: host,
      details: `Remote: ${remoteUrl}. niis's PR flow uses the gh CLI which only supports GitHub today.`,
      host,
      remote: remoteUrl,
    };
  }

  let ghAuthed = false;
  let ghDetails = "";
  try {
    const r = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
    if (r.status === 0) {
      ghAuthed = true;
      const line = (r.stderr || r.stdout || "").split("\n").find((l) => /Logged in to/i.test(l));
      ghDetails = line ? line.trim() : `Authenticated. Remote: ${remoteUrl}.`;
    } else {
      ghDetails = (r.stderr || r.stdout || "gh auth status returned non-zero").split("\n")[0].trim();
    }
  } catch (error) {
    ghDetails = `gh CLI not found on PATH (${error.message || "unknown"}).`;
  }
  return {
    id,
    status: ghAuthed ? "ok" : "warning",
    summary: ghAuthed ? "GitHub (authenticated)" : "GitHub (not authenticated)",
    details: `${ghDetails} Remote: ${remoteUrl}.`,
    host,
    remote: remoteUrl,
  };
}

function resolveRuntimeCommand({
  commandNames = [],
  envKey = null,
  environment = process.env,
  fallbackPaths = [],
} = {}) {
  const isExecutable = (candidatePath) => {
    try {
      fs.accessSync(candidatePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const expandPath = (candidatePath) => candidatePath.startsWith("~/")
    ? path.join(os.homedir(), candidatePath.slice(2))
    : path.resolve(candidatePath);

  if (envKey && Object.prototype.hasOwnProperty.call(environment, envKey)) {
    const explicitPath = String(environment[envKey] ?? "").trim();
    return explicitPath !== "" && isExecutable(expandPath(explicitPath))
      ? expandPath(explicitPath)
      : null;
  }

  const pathEntries = (environment.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);

  for (const commandName of commandNames) {
    for (const pathEntry of pathEntries) {
      const candidatePath = path.join(pathEntry, commandName);

      try {
        fs.accessSync(candidatePath, fs.constants.X_OK);
        return path.resolve(candidatePath);
      } catch {
        continue;
      }
    }
  }

  for (const candidatePath of fallbackPaths) {
    const expandedPath = expandPath(candidatePath);
    if (isExecutable(expandedPath)) return expandedPath;
  }

  return null;
}

function collectBuiltinAdapterAvailabilityChecks() {
  const definitions = [
    {
      id: "adapter-availability:codex_local",
      summary: "codex_local",
      commands: ["codex"],
      envKey: "NIIS_CODEX_LOCAL_BIN",
      fallbackPaths: ["/Applications/Codex.app/Contents/Resources/codex"],
    },
    {
      id: "adapter-availability:claude_code_local",
      summary: "claude_code_local",
      commands: ["claude-code", "claude"],
      envKey: "NIIS_CLAUDE_CODE_LOCAL_BIN",
      fallbackPaths: ["~/.local/bin/claude", "/Applications/Claude.app/Contents/MacOS/claude"],
    },
  ];

  return definitions.map((definition) => {
    const resolvedCommand = resolveRuntimeCommand({
      commandNames: definition.commands,
      envKey: definition.envKey,
      fallbackPaths: definition.fallbackPaths,
    });

    return {
      id: definition.id,
      status: resolvedCommand ? "ok" : "warning",
      summary: definition.summary,
      details: resolvedCommand
        ? `Resolved adapter runtime command at ${resolvedCommand}.`
        : `None of the expected commands are available on PATH: ${definition.commands.join(", ")}.`,
    };
  });
}

function collectRuntimeDependencyChecks({
  installRoot,
  workspaceRoot,
}) {
  const checks = [];
  const dependencyName = "better-sqlite3";
  const resolutionRoots = [
    path.resolve(installRoot),
    path.resolve(workspaceRoot),
  ].filter((root, index, roots) => roots.indexOf(root) === index);
  let resolvedDependency = null;
  let resolvedRoot = null;

  for (const root of resolutionRoots) {
    try {
      resolvedDependency = require.resolve(dependencyName, {
        paths: [root],
      });
      resolvedRoot = root;
      break;
    } catch {
      continue;
    }
  }

  if (resolvedDependency) {
    checks.push({
      id: "runtime-dependency:better-sqlite3",
      status: "ok",
      summary: dependencyName,
      details: `Resolved runtime dependency at ${resolvedDependency} using ${resolvedRoot}.`,
    });
  } else {
    checks.push({
      id: "runtime-dependency:better-sqlite3",
      status: "error",
      summary: dependencyName,
      details: `Runtime dependency could not be resolved from the active install roots: ${resolutionRoots.join(", ")}.`,
    });
  }

  return checks;
}

export {
  BootstrapStateCompatibilityError,
  assertSafeExistingStateRoot,
  createStateTreeDigest,
  createInitPlan,
  createAttachPlan,
  collectDoctorChecks,
  resolveRuntimeCommand,
  deriveBootstrapProjectId,
  initializeBootstrapState,
  preflightResetBootstrapState,
  resetBootstrapState,
};
