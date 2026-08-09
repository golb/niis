import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  createDriftReportEntry,
  createInstallState,
  createInstallStateEntry,
} from "../contracts/packages.js";
import { parsePackageManifest } from "../schemas/package-manifest.js";

const DEFAULT_INSTALL_COMMANDS = Object.freeze([
  "init",
  "attach",
  "profile",
  "doctor",
  "secret-set",
  "secret-list",
  "backup",
  "explain",
  "activity",
  "metrics",
]);
const ACTIVATION_TARGET_KINDS = Object.freeze({
  adapter: "adapter",
  package: "runtime_package",
  plugin: "plugin",
});

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function resolveInstallStatePath(packageRoot) {
  return path.join(path.resolve(ensureNonEmptyString(packageRoot, "packageRoot")), ".niis", "install-state.json");
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createTrackedFile(packageRoot, relativePath, { required = true } = {}) {
  const normalizedPackageRoot = path.resolve(packageRoot);
  const normalizedRelativePath = ensureNonEmptyString(relativePath, "relativePath");
  const absolutePath = path.join(normalizedPackageRoot, normalizedRelativePath);

  if (!fs.existsSync(absolutePath)) {
    if (!required) {
      return {
        path: normalizedRelativePath,
        required: false,
        sha256: null,
      };
    }

    throw new Error(`tracked install-state file is missing: ${absolutePath}`);
  }

  return {
    path: normalizedRelativePath,
    required,
    sha256: hashFile(absolutePath),
  };
}

function resolveTrackedActivationFile(packageRoot, sourceRef) {
  if (typeof sourceRef !== "string" || sourceRef.trim() === "") {
    return null;
  }

  const normalizedPackageRoot = path.resolve(packageRoot);
  const absolutePath = path.isAbsolute(sourceRef)
    ? path.resolve(sourceRef)
    : path.resolve(normalizedPackageRoot, sourceRef);
  const relativePath = path.relative(normalizedPackageRoot, absolutePath);

  if (
    relativePath.startsWith("..")
    || path.isAbsolute(relativePath)
    || !fs.existsSync(absolutePath)
    || !fs.statSync(absolutePath).isFile()
  ) {
    return null;
  }

  return createTrackedFile(normalizedPackageRoot, relativePath);
}

function resolveTrackedActivationFiles(packageRoot, packageManifest, sourceRef) {
  const trackedFiles = [];
  const trackedRefs = new Set();
  const manifestFile = resolveTrackedActivationFile(packageRoot, sourceRef);

  if (manifestFile) {
    trackedFiles.push(manifestFile);
    trackedRefs.add(manifestFile.path);
  }

  const moduleRef = packageManifest?.runtime?.module_ref ?? null;
  if (typeof moduleRef !== "string" || moduleRef.trim() === "") {
    return trackedFiles;
  }

  const normalizedPackageRoot = path.resolve(packageRoot);
  const absoluteSourceRef = typeof sourceRef === "string" && sourceRef.trim() !== ""
    ? path.isAbsolute(sourceRef)
      ? path.resolve(sourceRef)
      : path.resolve(normalizedPackageRoot, sourceRef)
    : normalizedPackageRoot;
  const sourceBaseDirectory = fs.existsSync(absoluteSourceRef) && fs.statSync(absoluteSourceRef).isFile()
    ? path.dirname(absoluteSourceRef)
    : normalizedPackageRoot;
  const absoluteModulePath = path.isAbsolute(moduleRef)
    ? path.resolve(moduleRef)
    : path.resolve(sourceBaseDirectory, moduleRef);
  const relativeModulePath = path.relative(normalizedPackageRoot, absoluteModulePath);

  if (
    relativeModulePath.startsWith("..")
    || path.isAbsolute(relativeModulePath)
    || !fs.existsSync(absoluteModulePath)
    || !fs.statSync(absoluteModulePath).isFile()
    || trackedRefs.has(relativeModulePath)
  ) {
    return trackedFiles;
  }

  trackedFiles.push(createTrackedFile(normalizedPackageRoot, relativeModulePath));
  return trackedFiles;
}

function resolveActivationTargetKind(candidateKind, packageManifest) {
  if (candidateKind === "plugin") {
    return ACTIVATION_TARGET_KINDS.plugin;
  }

  if (packageManifest.type === "plugin") {
    return ACTIVATION_TARGET_KINDS.plugin;
  }

  if (packageManifest.type === "adapter") {
    return ACTIVATION_TARGET_KINDS.adapter;
  }

  return ACTIVATION_TARGET_KINDS.package;
}

function createBootstrapInstallEntries(packageRoot, now = new Date()) {
  const workspaceManifestPath = "package.json";
  const coreManifestPath = "packages/core/package.json";
  const cliManifestPath = "packages/cli/package.json";
  const cliBinPath = "packages/cli/bin/niis.js";
  const workspaceManifest = readJsonFile(path.join(packageRoot, workspaceManifestPath));
  const coreManifest = readJsonFile(path.join(packageRoot, coreManifestPath));
  const cliManifest = readJsonFile(path.join(packageRoot, cliManifestPath));

  return [
    createInstallStateEntry({
      displayName: "Workspace package manifest",
      files: [createTrackedFile(packageRoot, workspaceManifestPath)],
      id: "workspace-package",
      operations: ["bootstrap_install"],
      packageId: workspaceManifest.name ?? "workspace",
      recordedAt: now,
      sourceKind: "builtin",
      sourceRef: workspaceManifestPath,
      targetKind: "workspace_package",
      version: workspaceManifest.version ?? "0.0.0",
    }),
    createInstallStateEntry({
      displayName: "Core package manifest",
      files: [createTrackedFile(packageRoot, coreManifestPath)],
      id: "core-package",
      operations: ["bootstrap_install"],
      packageId: coreManifest.name ?? "@niis/core",
      recordedAt: now,
      sourceKind: "builtin",
      sourceRef: coreManifestPath,
      targetKind: "runtime_package",
      version: coreManifest.version ?? "0.0.0",
    }),
    createInstallStateEntry({
      displayName: "CLI package manifest",
      files: [createTrackedFile(packageRoot, cliManifestPath)],
      id: "cli-package",
      operations: ["bootstrap_install"],
      packageId: cliManifest.name ?? "@niis/cli",
      recordedAt: now,
      sourceKind: "builtin",
      sourceRef: cliManifestPath,
      targetKind: "runtime_package",
      version: cliManifest.version ?? "0.0.0",
    }),
    createInstallStateEntry({
      displayName: "CLI command surface",
      files: [createTrackedFile(packageRoot, cliBinPath)],
      id: "cli-command-surface",
      operations: ["bootstrap_command_surface"],
      packageId: cliManifest.name ?? "@niis/cli",
      recordedAt: now,
      sourceKind: "builtin",
      sourceRef: cliBinPath,
      targetKind: "command_surface",
      version: cliManifest.version ?? "0.0.0",
    }),
  ];
}

function createBootstrapInstallState({
  packageRoot,
  stateRoot,
  databasePath = null,
  commands = DEFAULT_INSTALL_COMMANDS,
  now = new Date(),
} = {}) {
  const normalizedPackageRoot = path.resolve(ensureNonEmptyString(packageRoot, "packageRoot"));
  const normalizedStateRoot = path.resolve(ensureNonEmptyString(stateRoot, "stateRoot"));

  return createInstallState({
    commands,
    databasePath,
    entries: createBootstrapInstallEntries(normalizedPackageRoot, now),
    installedAt: now,
    packageRoot: normalizedPackageRoot,
    stateRoot: normalizedStateRoot,
    status: "BOOTSTRAPPED",
  });
}

function createActivationInstallStateEntry({
  packageRoot,
  packageManifest,
  sourceKind,
  sourceRef,
  candidateKind = "package",
  now = new Date(),
} = {}) {
  const normalizedPackageRoot = path.resolve(ensureNonEmptyString(packageRoot, "packageRoot"));
  const normalizedManifest = parsePackageManifest(packageManifest);
  const normalizedCandidateKind = ensureNonEmptyString(candidateKind, "candidateKind");
  const targetKind = resolveActivationTargetKind(normalizedCandidateKind, normalizedManifest);
  const trackedFiles = resolveTrackedActivationFiles(
    normalizedPackageRoot,
    normalizedManifest,
    sourceRef,
  );

  return createInstallStateEntry({
    displayName:
      targetKind === "plugin"
        ? `Activated plugin ${normalizedManifest.name}`
        : `Activated package ${normalizedManifest.name}`,
    files: trackedFiles,
    id: `activation:${targetKind}:${normalizedManifest.id}`,
    metadata: {
      activation_status: normalizedManifest.activation_status,
      candidate_kind: normalizedCandidateKind,
      manifest_type: normalizedManifest.type,
      package_manifest: normalizedManifest,
      runtime_binding: normalizedManifest.runtime,
    },
    operations: [targetKind === "plugin" ? "plugin_activation" : "package_activation"],
    packageId: normalizedManifest.id,
    recordedAt: now,
    sourceKind,
    sourceRef: ensureNonEmptyString(sourceRef, "sourceRef"),
    targetKind,
    version: normalizedManifest.version,
  });
}

function writeInstallState(installStatePath, installState) {
  const normalizedInstallStatePath = path.resolve(
    ensureNonEmptyString(installStatePath, "installStatePath"),
  );

  fs.mkdirSync(path.dirname(normalizedInstallStatePath), { recursive: true });
  fs.writeFileSync(normalizedInstallStatePath, `${JSON.stringify(installState, null, 2)}\n`);
  return installState;
}

function readInstallState(installStatePath) {
  const normalizedInstallStatePath = path.resolve(
    ensureNonEmptyString(installStatePath, "installStatePath"),
  );

  if (!fs.existsSync(normalizedInstallStatePath)) {
    return null;
  }

  return createInstallState(readJsonFile(normalizedInstallStatePath));
}

function recordActivationInstallState({
  installStatePath = null,
  packageRoot,
  packageManifest,
  sourceKind,
  sourceRef,
  candidateKind = "package",
  now = new Date(),
} = {}) {
  const normalizedPackageRoot = path.resolve(ensureNonEmptyString(packageRoot, "packageRoot"));
  const normalizedInstallStatePath = installStatePath
    ? path.resolve(installStatePath)
    : resolveInstallStatePath(normalizedPackageRoot);
  const currentInstallState = readInstallState(normalizedInstallStatePath);

  if (!currentInstallState) {
    throw new Error(
      `install-state baseline is missing at ${normalizedInstallStatePath}; run \`init\` first or provide an existing install-state path`,
    );
  }

  const nextEntry = createActivationInstallStateEntry({
    candidateKind,
    now,
    packageManifest,
    packageRoot: normalizedPackageRoot,
    sourceKind,
    sourceRef,
  });
  const nextInstallState = createInstallState({
    commands: currentInstallState.commands,
    databasePath: currentInstallState.database_path,
    entries: [
      ...currentInstallState.entries.filter((entry) => entry.id !== nextEntry.id),
      nextEntry,
    ],
    installedAt: currentInstallState.installed_at,
    packageRoot: currentInstallState.package_root,
    schemaVersion: currentInstallState.schema_version,
    stateRoot: currentInstallState.state_root,
    status: currentInstallState.status,
  });

  writeInstallState(normalizedInstallStatePath, nextInstallState);

  return {
    install_state: nextInstallState,
    install_state_entry: nextEntry,
    install_state_path: normalizedInstallStatePath,
  };
}

function compareInstallState(installState, { packageRoot, commands = DEFAULT_INSTALL_COMMANDS } = {}) {
  const normalizedPackageRoot = path.resolve(ensureNonEmptyString(packageRoot, "packageRoot"));
  const normalizedInstallState = createInstallState(installState);
  const checks = [];
  const expectedCommands = [...commands].sort();
  const actualCommands = [...normalizedInstallState.commands].sort();

  checks.push(
    createDriftReportEntry({
      details:
        expectedCommands.join(",") === actualCommands.join(",")
          ? "Stored install-state command surface matches the current bootstrap command set."
          : `Stored commands (${actualCommands.join(", ")}) differ from the current bootstrap commands (${expectedCommands.join(", ")}).`,
      id: "install-state-commands",
      status: expectedCommands.join(",") === actualCommands.join(",") ? "ok" : "warning",
      summary: normalizedInstallState.commands.join(", "),
    }),
  );

  for (const entry of normalizedInstallState.entries) {
    let status = "ok";
    let details = "Tracked files match the immutable install-state record.";

    for (const trackedFile of entry.files) {
      const absolutePath = path.join(normalizedPackageRoot, trackedFile.path);

      if (!fs.existsSync(absolutePath)) {
        status = trackedFile.required ? "error" : "warning";
        details = `Tracked file is missing from the current installation: ${trackedFile.path}`;
        break;
      }

      if (trackedFile.sha256 && hashFile(absolutePath) !== trackedFile.sha256) {
        status = "warning";
        details = `Tracked file contents drifted from the immutable install-state record: ${trackedFile.path}`;
        break;
      }
    }

    checks.push(
      createDriftReportEntry({
        details,
        entryId: entry.id,
        id: `install-state:${entry.id}`,
        status,
        summary: entry.display_name,
      }),
    );
  }

  return checks;
}

function collectInstallStateChecks(packageRoot, { installStatePath = null } = {}) {
  const normalizedPackageRoot = path.resolve(ensureNonEmptyString(packageRoot, "packageRoot"));
  const normalizedInstallStatePath = installStatePath
    ? path.resolve(installStatePath)
    : resolveInstallStatePath(normalizedPackageRoot);

  if (!fs.existsSync(normalizedInstallStatePath)) {
    return [
      createDriftReportEntry({
        details: "Run `init` to create the immutable install-state baseline for doctor drift checks.",
        id: "install-state",
        status: "warning",
        summary: normalizedInstallStatePath,
      }),
    ];
  }

  try {
    const installState = readInstallState(normalizedInstallStatePath);
    return compareInstallState(installState, {
      packageRoot: normalizedPackageRoot,
    });
  } catch (error) {
    return [
      createDriftReportEntry({
        details: `Install-state file could not be parsed or validated: ${error.message}`,
        id: "install-state",
        status: "error",
        summary: normalizedInstallStatePath,
      }),
    ];
  }
}

export {
  ACTIVATION_TARGET_KINDS,
  DEFAULT_INSTALL_COMMANDS,
  collectInstallStateChecks,
  createActivationInstallStateEntry,
  compareInstallState,
  createBootstrapInstallState,
  recordActivationInstallState,
  readInstallState,
  resolveInstallStatePath,
  writeInstallState,
};
