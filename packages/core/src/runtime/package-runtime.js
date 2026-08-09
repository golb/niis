import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readInstallState } from "./install-state.js";
import { parsePackageManifest } from "../schemas/package-manifest.js";

class PackageRuntimeError extends Error {
  constructor(message, {
    cause = null,
    code = "PACKAGE_RUNTIME_ERROR",
    diagnostic = {},
  } = {}) {
    super(message);
    this.name = "PackageRuntimeError";
    this.code = code;
    this.diagnostic = Object.freeze({ ...diagnostic });
    this.details = this.diagnostic;

    if (cause !== null) {
      this.cause = cause;
    }
  }
}

const ACTIVATION_OPERATIONS = Object.freeze([
  "package_activation",
  "plugin_activation",
]);

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PackageRuntimeError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageRuntimeError(`${label} must be a plain object`);
  }

  return value;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isActivatedPackageEntry(installStateEntry) {
  const metadata = installStateEntry?.metadata ?? {};
  const operations = Array.isArray(installStateEntry?.operations)
    ? installStateEntry.operations
    : [];

  if (
    isPlainObject(metadata.package_manifest)
    || typeof metadata.manifest_type === "string"
    || typeof metadata.activation_status === "string"
    || operations.some((operation) => ACTIVATION_OPERATIONS.includes(operation))
    || String(installStateEntry?.id ?? "").startsWith("activation:")
  ) {
    return true;
  }

  return installStateEntry?.source_kind !== "builtin"
    && ["adapter", "plugin", "runtime_package"].includes(installStateEntry?.target_kind);
}

function getDeclaredPackageType(installStateEntry, manifestInput = null) {
  const metadataType = installStateEntry?.metadata?.manifest_type;
  if (typeof metadataType === "string" && metadataType.trim() !== "") {
    return metadataType.trim();
  }

  const manifestType = manifestInput?.type;
  return typeof manifestType === "string" && manifestType.trim() !== ""
    ? manifestType.trim()
    : null;
}

function getDeclaredActivationStatus(installStateEntry, manifestInput = null) {
  const metadataStatus = installStateEntry?.metadata?.activation_status;
  if (typeof metadataStatus === "string" && metadataStatus.trim() !== "") {
    return metadataStatus.trim();
  }

  const manifestStatus = manifestInput?.activation_status;
  return typeof manifestStatus === "string" && manifestStatus.trim() !== ""
    ? manifestStatus.trim()
    : null;
}

function createManifestDiagnostic(installStateEntry, {
  cause,
  phase,
  packageRoot,
}) {
  return Object.freeze({
    entry_id: installStateEntry?.id ?? null,
    manifest_type: getDeclaredPackageType(
      installStateEntry,
      installStateEntry?.metadata?.package_manifest,
    ),
    package_id: installStateEntry?.package_id ?? null,
    package_root: path.resolve(packageRoot),
    phase,
    reason: cause instanceof Error ? cause.message : String(cause),
    schema_name:
      typeof cause?.schemaName === "string"
        ? cause.schemaName
        : null,
    source_ref: installStateEntry?.source_ref ?? null,
    target_kind: installStateEntry?.target_kind ?? null,
    validation_errors: Array.isArray(cause?.errors)
      ? Object.freeze([...cause.errors])
      : Object.freeze([]),
  });
}

function readActivatedPackageManifestInput(installStateEntry, packageRoot) {
  const metadataManifest = installStateEntry?.metadata?.package_manifest;

  if (isPlainObject(metadataManifest)) {
    return metadataManifest;
  }

  const sourceRef = installStateEntry?.source_ref;
  if (typeof sourceRef !== "string" || sourceRef.trim() === "") {
    return null;
  }

  const absoluteSourcePath = path.isAbsolute(sourceRef)
    ? path.resolve(sourceRef)
    : path.resolve(packageRoot, sourceRef);

  if (!fs.existsSync(absoluteSourcePath)) {
    return null;
  }

  try {
    return readJsonFile(absoluteSourcePath);
  } catch (cause) {
    const diagnostic = createManifestDiagnostic(installStateEntry, {
      cause,
      packageRoot,
      phase: "read",
    });
    throw new PackageRuntimeError(
      `failed to read activated package manifest for install-state entry ${diagnostic.entry_id}: ${diagnostic.reason}`,
      {
        cause,
        code: "PACKAGE_MANIFEST_READ_FAILED",
        diagnostic,
      },
    );
  }
}

function parseActivatedPackageManifest(manifestInput, installStateEntry, packageRoot) {
  try {
    return parsePackageManifest(manifestInput);
  } catch (cause) {
    const diagnostic = createManifestDiagnostic(installStateEntry, {
      cause,
      packageRoot,
      phase: "parse",
    });
    throw new PackageRuntimeError(
      `invalid activated package manifest for install-state entry ${diagnostic.entry_id}: ${diagnostic.reason}`,
      {
        cause,
        code: "PACKAGE_MANIFEST_INVALID",
        diagnostic,
      },
    );
  }
}

function extractActivatedPackageManifest(installStateEntry, packageRoot) {
  const manifestInput = readActivatedPackageManifestInput(installStateEntry, packageRoot);
  return manifestInput === null
    ? null
    : parseActivatedPackageManifest(manifestInput, installStateEntry, packageRoot);
}

function resolveRuntimeModulePath({
  packageManifest,
  sourceRef,
  packageRoot,
}) {
  const moduleRef = packageManifest?.runtime?.module_ref ?? null;
  if (typeof moduleRef !== "string" || moduleRef.trim() === "") {
    return null;
  }

  const normalizedPackageRoot = path.resolve(ensureNonEmptyString(packageRoot, "packageRoot"));
  const absoluteSourcePath = typeof sourceRef === "string" && sourceRef.trim() !== ""
    ? path.isAbsolute(sourceRef)
      ? path.resolve(sourceRef)
      : path.resolve(normalizedPackageRoot, sourceRef)
    : normalizedPackageRoot;
  const baseDirectory = fs.existsSync(absoluteSourcePath) && fs.statSync(absoluteSourcePath).isFile()
    ? path.dirname(absoluteSourcePath)
    : normalizedPackageRoot;

  return path.isAbsolute(moduleRef)
    ? path.resolve(moduleRef)
    : path.resolve(baseDirectory, moduleRef);
}

function sortByRecordedAt(left, right) {
  const leftTimestamp = Date.parse(left.recorded_at ?? 0) || 0;
  const rightTimestamp = Date.parse(right.recorded_at ?? 0) || 0;

  if (rightTimestamp !== leftTimestamp) {
    return rightTimestamp - leftTimestamp;
  }

  return String(left.id).localeCompare(String(right.id));
}

function listActivatedRuntimePackages({
  installStatePath,
  packageRoot,
  packageTypes = [],
} = {}) {
  const normalizedInstallStatePath = path.resolve(ensureNonEmptyString(installStatePath, "installStatePath"));
  const normalizedPackageRoot = path.resolve(ensureNonEmptyString(packageRoot, "packageRoot"));
  const installState = readInstallState(normalizedInstallStatePath);

  if (!installState) {
    return [];
  }

  const allowedPackageTypes = new Set(
    Array.isArray(packageTypes)
      ? packageTypes.map((packageType) => ensureNonEmptyString(packageType, "packageType"))
      : [],
  );
  const seenPackageIds = new Set();

  const runtimePackages = [];
  const candidateEntries = installState.entries
    .filter((entry) => entry.package_id)
    .filter(isActivatedPackageEntry)
    .filter((entry) => {
      const declaredType = getDeclaredPackageType(entry);
      const activationStatus = getDeclaredActivationStatus(
        entry,
        entry.metadata?.package_manifest,
      );
      const packageTypeAllowed = allowedPackageTypes.size === 0
        || declaredType === null
        || allowedPackageTypes.has(declaredType);
      return packageTypeAllowed
        && (activationStatus === null || activationStatus === "ACTIVE");
    })
    .sort(sortByRecordedAt);

  for (const entry of candidateEntries) {
    const manifestInput = readActivatedPackageManifestInput(entry, normalizedPackageRoot);
    if (manifestInput === null) {
      continue;
    }

    const activationStatus = getDeclaredActivationStatus(entry, manifestInput);
    if (activationStatus !== null && activationStatus !== "ACTIVE") {
      continue;
    }

    const declaredType = getDeclaredPackageType(entry, manifestInput);
    if (
      allowedPackageTypes.size > 0
      && declaredType !== null
      && !allowedPackageTypes.has(declaredType)
    ) {
      continue;
    }

    const packageManifest = parseActivatedPackageManifest(
      manifestInput,
      entry,
      normalizedPackageRoot,
    );
    if (packageManifest.activation_status !== "ACTIVE") {
      continue;
    }

    if (allowedPackageTypes.size > 0 && !allowedPackageTypes.has(packageManifest.type)) {
      continue;
    }

    if (seenPackageIds.has(packageManifest.id)) {
      continue;
    }

    seenPackageIds.add(packageManifest.id);

    runtimePackages.push(Object.freeze({
      install_state_entry: entry,
      package_manifest: packageManifest,
      package_root: normalizedPackageRoot,
      runtime_module_path: resolveRuntimeModulePath({
        packageManifest,
        packageRoot: normalizedPackageRoot,
        sourceRef: entry.source_ref,
      }),
      source_ref: entry.source_ref,
    }));
  }

  return runtimePackages;
}

async function importRuntimeModule(runtimeModulePath) {
  const normalizedPath = path.resolve(ensureNonEmptyString(runtimeModulePath, "runtimeModulePath"));

  if (!fs.existsSync(normalizedPath)) {
    throw new PackageRuntimeError(`runtime module is missing: ${normalizedPath}`);
  }

  return import(pathToFileURL(normalizedPath).href);
}

function normalizeRoleManifestExport(exportedValue, packageManifest) {
  const values = Array.isArray(exportedValue) ? exportedValue : [exportedValue];

  return values.map((value, index) => {
    const normalizedValue = ensurePlainObject(
      value,
      `${packageManifest.id} role manifest export[${index}]`,
    );

    return Object.freeze({
      ...normalizedValue,
      id: normalizedValue.id ?? `${packageManifest.id}:role`,
    });
  });
}

async function loadRuntimeBindingValue(runtimeRecord, context = {}) {
  const runtimeBinding = runtimeRecord.package_manifest.runtime ?? {};
  const definitionKind = runtimeBinding.definition_kind ?? null;

  if (!runtimeRecord.runtime_module_path || !definitionKind) {
    return null;
  }

  const runtimeModule = await importRuntimeModule(runtimeRecord.runtime_module_path);
  const exportName = runtimeBinding.export_name ?? "default";
  const exportedSymbol = exportName === "default"
    ? runtimeModule.default ?? runtimeModule
    : runtimeModule[exportName];

  if (exportedSymbol === undefined) {
    throw new PackageRuntimeError(
      `runtime export ${exportName} is missing for package ${runtimeRecord.package_manifest.id}`,
    );
  }

  const runtimeContext = Object.freeze({
    installStateEntry: runtimeRecord.install_state_entry,
    packageManifest: runtimeRecord.package_manifest,
    packageRoot: runtimeRecord.package_root,
    runtimeConfig: runtimeBinding.config ?? {},
    sourceRef: runtimeRecord.source_ref,
    ...context,
  });
  const loadedValue = typeof exportedSymbol === "function"
    ? await exportedSymbol(runtimeContext)
    : exportedSymbol;

  switch (definitionKind) {
    case "role_manifest":
      return Object.freeze({
        definition_kind: definitionKind,
        value: normalizeRoleManifestExport(loadedValue, runtimeRecord.package_manifest),
      });
    case "adapter_factory":
    case "validator_factory":
    case "agent_entity":
      return Object.freeze({
        definition_kind: definitionKind,
        value: loadedValue,
      });
    default:
      throw new PackageRuntimeError(
        `unsupported runtime definition_kind ${definitionKind} for package ${runtimeRecord.package_manifest.id}`,
      );
  }
}

async function loadActivatedRuntimePackages({
  installStatePath,
  packageRoot,
  packageTypes = [],
  context = {},
} = {}) {
  const runtimeRecords = listActivatedRuntimePackages({
    installStatePath,
    packageRoot,
    packageTypes,
  });
  const agents = [];
  const adapters = [];
  const roleManifests = [];
  const validators = [];
  const packages = [];

  for (const runtimeRecord of runtimeRecords) {
    const loadedBinding = await loadRuntimeBindingValue(runtimeRecord, context);
    packages.push({
      ...runtimeRecord,
      loaded_binding: loadedBinding,
    });

    if (!loadedBinding) {
      continue;
    }

    switch (loadedBinding.definition_kind) {
      case "adapter_factory":
        adapters.push(loadedBinding.value);
        break;
      case "validator_factory":
        validators.push(loadedBinding.value);
        break;
      case "role_manifest":
        roleManifests.push(...loadedBinding.value);
        break;
      case "agent_entity":
        agents.push(loadedBinding.value);
        break;
      default:
        break;
    }
  }

  return Object.freeze({
    agents: Object.freeze(agents),
    adapters: Object.freeze(adapters),
    packages: Object.freeze(packages),
    roleManifests: Object.freeze(roleManifests),
    validators: Object.freeze(validators),
  });
}

export {
  PackageRuntimeError,
  extractActivatedPackageManifest,
  listActivatedRuntimePackages,
  loadActivatedRuntimePackages,
  resolveRuntimeModulePath,
};
