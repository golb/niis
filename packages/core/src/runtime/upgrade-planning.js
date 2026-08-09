import fs from "node:fs";
import path from "node:path";

import { createReleaseBundle, createUpgradePlan } from "../contracts/packages.js";
import { collectInstallStateChecks, readInstallState, resolveInstallStatePath } from "./install-state.js";
import { compareVersions } from "./package-compatibility.js";
import { planStorageBackendMigration } from "./storage-migration.js";

const UPGRADE_CHECK_STATUSES = Object.freeze(["ok", "warning", "error"]);

class UpgradePlanningError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpgradePlanningError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new UpgradePlanningError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureOptionalStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new UpgradePlanningError(`${label} must be an array`);
  }

  return values.map((value, index) => ensureNonEmptyString(value, `${label}[${index}]`));
}

function ensureOptionalPlainObject(value, label) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new UpgradePlanningError(`${label} must be a plain object`);
  }

  return value;
}

function createUpgradeCheck({
  id,
  status,
  summary,
  details,
} = {}) {
  const normalizedStatus = ensureNonEmptyString(status, "status");

  if (!UPGRADE_CHECK_STATUSES.includes(normalizedStatus)) {
    throw new UpgradePlanningError(
      `status must be one of: ${UPGRADE_CHECK_STATUSES.join(", ")}`,
    );
  }

  return Object.freeze({
    details: ensureNonEmptyString(details, "details"),
    id: ensureNonEmptyString(id, "id"),
    status: normalizedStatus,
    summary: ensureNonEmptyString(summary, "summary"),
  });
}

function resolveInstalledPackageVersion(installState, packageId) {
  const normalizedPackageId = ensureNonEmptyString(packageId, "packageId");
  const preferredEntry = installState.entries.find((entry) =>
    entry.package_id === normalizedPackageId && entry.target_kind === "runtime_package");

  if (preferredEntry) {
    return preferredEntry.version;
  }

  return installState.entries.find((entry) => entry.package_id === normalizedPackageId)?.version ?? null;
}

function resolveAvailableAdapters(installState, availableAdapters) {
  const manifestAdapters = installState?.entries
    ?.filter((entry) => entry.target_kind === "adapter" && entry.package_id)
    .map((entry) => entry.package_id)
    ?? [];

  return Object.freeze([
    ...new Set([
      ...manifestAdapters,
      ...ensureOptionalStringArray(availableAdapters, "availableAdapters"),
    ]),
  ]);
}

function evaluateReleaseUpgradePlan({
  packageRoot,
  releaseBundle,
  installStatePath = null,
  databasePath = null,
  storageTargetBackend = null,
  availableAdapters = [],
  planId = null,
  now = new Date(),
  operatorGuidance = [],
} = {}) {
  const normalizedPackageRoot = path.resolve(ensureNonEmptyString(packageRoot, "packageRoot"));
  const normalizedReleaseBundle = createReleaseBundle(releaseBundle);
  const normalizedInstallStatePath = installStatePath
    ? path.resolve(installStatePath)
    : resolveInstallStatePath(normalizedPackageRoot);
  const normalizedGuidance = ensureOptionalStringArray(operatorGuidance, "operatorGuidance");
  const normalizedStorageTargetBackend = ensureOptionalPlainObject(
    storageTargetBackend,
    "storageTargetBackend",
  );
  const checks = [];
  const blockedBy = [];
  const guidance = [...normalizedGuidance];
  let compatibilityStatus = "compatible";
  let currentInstallState = null;
  let currentPackageVersion = null;
  let storagePlan = null;

  function addCheck(check) {
    checks.push(createUpgradeCheck(check));
  }

  function block(reason) {
    if (!blockedBy.includes(reason)) {
      blockedBy.push(reason);
    }

    compatibilityStatus = "blocked";
  }

  function requireMigration(guidanceLine = null) {
    if (compatibilityStatus !== "blocked") {
      compatibilityStatus = "migration_required";
    }

    if (guidanceLine && !guidance.includes(guidanceLine)) {
      guidance.push(guidanceLine);
    }
  }

  currentInstallState = readInstallState(normalizedInstallStatePath);

  if (!currentInstallState) {
    addCheck({
      id: "install-state-baseline",
      status: "error",
      summary: normalizedInstallStatePath,
      details: "Upgrade planning requires an immutable install-state baseline before any local mutation is allowed.",
    });
    block("install_state_missing");
  } else {
    addCheck({
      id: "install-state-baseline",
      status: "ok",
      summary: currentInstallState.status,
      details: "Upgrade planning is anchored to the current immutable install-state baseline.",
    });

    const driftChecks = collectInstallStateChecks(normalizedPackageRoot, {
      installStatePath: normalizedInstallStatePath,
    });
    const driftWarnings = driftChecks.filter((check) => check.status === "warning");
    const driftErrors = driftChecks.filter((check) => check.status === "error");

    if (driftErrors.length > 0) {
      addCheck({
        id: "install-state-drift",
        status: "error",
        summary: `${driftErrors.length} error check(s)`,
        details: "Current install-state drift must be resolved before an upgrade may proceed.",
      });
      block("install_state_drift_error");
      guidance.push("Resolve install-state errors before attempting a release or upgrade transition.");
    } else if (driftWarnings.length > 0) {
      addCheck({
        id: "install-state-drift",
        status: "warning",
        summary: `${driftWarnings.length} warning check(s)`,
        details: "Current install-state drift makes the upgrade preflight non-trustworthy and blocks mutation until reviewed.",
      });
      block("install_state_drift_warning");
      guidance.push("Review install-state drift warnings before attempting upgrade execution.");
    } else {
      addCheck({
        id: "install-state-drift",
        status: "ok",
        summary: `${driftChecks.length} check(s)`,
        details: "Current installation still matches the immutable install-state baseline.",
      });
    }

    currentPackageVersion = resolveInstalledPackageVersion(
      currentInstallState,
      normalizedReleaseBundle.package_id,
    );

    if (!currentPackageVersion) {
      addCheck({
        id: "installed-package-version",
        status: "error",
        summary: normalizedReleaseBundle.package_id,
        details: "Upgrade planning could not find the currently installed package version in install-state.",
      });
      block("installed_package_version_missing");
    } else {
      const versionComparison = compareVersions(
        normalizedReleaseBundle.version,
        currentPackageVersion,
      );

      if (versionComparison > 0) {
        addCheck({
          id: "release-version-direction",
          status: "ok",
          summary: `${currentPackageVersion} -> ${normalizedReleaseBundle.version}`,
          details: "Target bundle version is newer than the installed package version.",
        });
      } else if (versionComparison === 0) {
        addCheck({
          id: "release-version-direction",
          status: "warning",
          summary: `${currentPackageVersion} -> ${normalizedReleaseBundle.version}`,
          details: "Target bundle matches the installed version; upgrade execution would be a no-op.",
        });
      } else {
        addCheck({
          id: "release-version-direction",
          status: "error",
          summary: `${currentPackageVersion} -> ${normalizedReleaseBundle.version}`,
          details: "Upgrade planning does not allow version regression without a separate rollback path.",
        });
        block("release_version_regression");
      }
    }

    const currentNiisVersion = resolveInstalledPackageVersion(currentInstallState, "@niis/core")
      ?? currentPackageVersion
      ?? normalizedReleaseBundle.version;
    const minNiisVersion = normalizedReleaseBundle.compatibility.min_niis_version;
    const maxNiisVersion = normalizedReleaseBundle.compatibility.max_niis_version;

    if (compareVersions(currentNiisVersion, minNiisVersion) < 0) {
      addCheck({
        id: "release-niis-compatibility",
        status: "error",
        summary: `${currentNiisVersion} < ${minNiisVersion}`,
        details: "Target bundle declares a minimum Niis version that is higher than the current installation.",
      });
      block("release_min_niis_version_unmet");
    } else if (
      maxNiisVersion
      && compareVersions(currentNiisVersion, maxNiisVersion) > 0
    ) {
      addCheck({
        id: "release-niis-compatibility",
        status: "error",
        summary: `${currentNiisVersion} > ${maxNiisVersion}`,
        details: "Target bundle declares a maximum Niis version below the current installation.",
      });
      block("release_max_niis_version_exceeded");
    } else {
      addCheck({
        id: "release-niis-compatibility",
        status: "ok",
        summary: currentNiisVersion,
        details: "Target bundle compatibility range accepts the current Niis version.",
      });
    }

    const resolvedAvailableAdapters = resolveAvailableAdapters(currentInstallState, availableAdapters);
    const missingAdapters = normalizedReleaseBundle.compatibility.required_adapters.filter((adapterId) =>
      !resolvedAvailableAdapters.includes(adapterId));

    if (missingAdapters.length > 0) {
      addCheck({
        id: "release-required-adapters",
        status: "error",
        summary: missingAdapters.join(", "),
        details: "Target bundle requires adapters that are not currently declared as available.",
      });
      block("release_required_adapters_missing");
    } else {
      addCheck({
        id: "release-required-adapters",
        status: "ok",
        summary: `${resolvedAvailableAdapters.length} available adapter(s)`,
        details: "Target bundle adapter prerequisites are satisfied.",
      });
    }
  }

  if (normalizedReleaseBundle.file_refs.length === 0) {
    addCheck({
      id: "release-bundle-files",
      status: "error",
      summary: "no file refs",
      details: "Upgrade planning requires at least one reviewable bundle artifact reference before mutation is allowed.",
    });
    block("release_bundle_files_missing");
  } else {
    const missingBundleFiles = normalizedReleaseBundle.file_refs.filter((fileRef) =>
      !fs.existsSync(path.resolve(normalizedPackageRoot, fileRef)));

    if (missingBundleFiles.length > 0) {
      addCheck({
        id: "release-bundle-files",
        status: "error",
        summary: missingBundleFiles.join(", "),
        details: "One or more declared release bundle artifacts are missing from the expected local path.",
      });
      block("release_bundle_file_missing");
    } else {
      addCheck({
        id: "release-bundle-files",
        status: "ok",
        summary: `${normalizedReleaseBundle.file_refs.length} file ref(s)`,
        details: "Declared release bundle artifacts are present for operator review.",
      });
    }
  }

  if (normalizedStorageTargetBackend && currentInstallState?.database_path) {
    storagePlan = planStorageBackendMigration({
      databasePath: path.resolve(databasePath ?? currentInstallState.database_path),
      migrationRefs: normalizedReleaseBundle.migration_refs,
      operatorGuidance: [],
      planId: `${planId ?? "upgrade-plan"}:storage`,
      targetBackend: normalizedStorageTargetBackend,
    });

    if (storagePlan.compatibility_status === "blocked") {
      addCheck({
        id: "storage-preflight",
        status: "error",
        summary: storagePlan.compatibility_status,
        details: "Storage backend compatibility checks blocked the upgrade before any state mutation.",
      });
      block("storage_preflight_blocked");
    } else if (storagePlan.compatibility_status === "migration_required") {
      addCheck({
        id: "storage-preflight",
        status: "warning",
        summary: storagePlan.compatibility_status,
        details: "Storage transition requires an explicit migration plan before upgrade execution.",
      });
      requireMigration("Complete the reviewed storage migration plan before applying the release bundle.");
    } else {
      addCheck({
        id: "storage-preflight",
        status: "ok",
        summary: storagePlan.compatibility_status,
        details: "Storage backend compatibility checks passed without requiring migration.",
      });
    }
  } else if (normalizedStorageTargetBackend) {
    addCheck({
      id: "storage-preflight",
      status: "error",
      summary: "database path unavailable",
      details: "Storage upgrade planning requires a readable current database path from install-state or explicit input.",
    });
    block("storage_database_path_missing");
  }

  if (compatibilityStatus === "migration_required" && normalizedReleaseBundle.migration_refs.length === 0) {
    addCheck({
      id: "upgrade-migration-refs",
      status: "error",
      summary: "missing migration refs",
      details: "Preflight detected a required migration but the release bundle does not declare reviewed migration references.",
    });
    block("upgrade_migration_refs_missing");
  } else if (normalizedReleaseBundle.migration_refs.length > 0) {
    addCheck({
      id: "upgrade-migration-refs",
      status: "ok",
      summary: `${normalizedReleaseBundle.migration_refs.length} migration ref(s)`,
      details: "Release bundle declares reviewable migration references for upgrade planning.",
    });
  } else {
    addCheck({
      id: "upgrade-migration-refs",
      status: "ok",
      summary: "no migration refs required",
      details: "Current preflight did not require any migration references.",
    });
  }

  if (compatibilityStatus === "compatible") {
    guidance.push("Upgrade preflight passed without requiring migration; execution may remain read-only until an explicit upgrade runner exists.");
  }

  const plan = createUpgradePlan({
    blockedBy,
    checks: checks.map((check) => `${check.id}:${check.status}`),
    compatibilityStatus,
    createdAt: now,
    fromVersion: currentPackageVersion ?? "unknown",
    migrationRefs: normalizedReleaseBundle.migration_refs,
    packageId: normalizedReleaseBundle.package_id,
    planId:
      planId
      ?? `upgrade-plan:${normalizedReleaseBundle.package_id}:${normalizedReleaseBundle.version}`,
    toVersion: normalizedReleaseBundle.version,
  });

  return Object.freeze({
    ...plan,
    check_results: Object.freeze(checks),
    install_state_path: normalizedInstallStatePath,
    install_state_summary: currentInstallState
      ? Object.freeze({
        package_root: currentInstallState.package_root,
        state_root: currentInstallState.state_root,
        status: currentInstallState.status,
      })
      : null,
    operator_guidance: Object.freeze([
      ...new Set([
        ...guidance,
        ...(storagePlan?.operator_guidance ?? []),
      ]),
    ]),
    readonly_preflight: true,
    release_bundle: normalizedReleaseBundle,
    storage_plan: storagePlan,
  });
}

export {
  UpgradePlanningError,
  compareVersions,
  createUpgradeCheck,
  evaluateReleaseUpgradePlan,
};
