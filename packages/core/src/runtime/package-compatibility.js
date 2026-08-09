import { parsePackageManifest } from "../schemas/package-manifest.js";

const PACKAGE_COMPATIBILITY_CHECK_STATUSES = Object.freeze(["ok", "error"]);
const DEFAULT_NIIS_COMPATIBILITY_VERSION = "0.1.0";

class PackageCompatibilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageCompatibilityError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PackageCompatibilityError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureOptionalStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new PackageCompatibilityError(`${label} must be an array`);
  }

  return values.map((value, index) => ensureNonEmptyString(value, `${label}[${index}]`));
}

function createPackageCompatibilityCheck({
  id,
  status,
  summary,
  details,
} = {}) {
  const normalizedStatus = ensureNonEmptyString(status, "status");

  if (!PACKAGE_COMPATIBILITY_CHECK_STATUSES.includes(normalizedStatus)) {
    throw new PackageCompatibilityError(
      `status must be one of: ${PACKAGE_COMPATIBILITY_CHECK_STATUSES.join(", ")}`,
    );
  }

  return Object.freeze({
    details: ensureNonEmptyString(details, "details"),
    id: ensureNonEmptyString(id, "id"),
    status: normalizedStatus,
    summary: ensureNonEmptyString(summary, "summary"),
  });
}

function normalizeVersionSegment(segment) {
  const match = String(segment ?? "").match(/^(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function compareVersions(leftVersion, rightVersion) {
  const leftSegments = ensureNonEmptyString(leftVersion, "leftVersion").split(".");
  const rightSegments = ensureNonEmptyString(rightVersion, "rightVersion").split(".");
  const maxLength = Math.max(leftSegments.length, rightSegments.length);

  for (let index = 0; index < maxLength; index += 1) {
    const left = normalizeVersionSegment(leftSegments[index]);
    const right = normalizeVersionSegment(rightSegments[index]);

    if (left > right) {
      return 1;
    }

    if (left < right) {
      return -1;
    }
  }

  return 0;
}

function evaluatePackageManifestCompatibility({
  packageManifest,
  currentNiisVersion = DEFAULT_NIIS_COMPATIBILITY_VERSION,
  availableAdapters = [],
} = {}) {
  const normalizedManifest = parsePackageManifest(packageManifest);
  const normalizedCurrentNiisVersion = ensureNonEmptyString(
    currentNiisVersion,
    "currentNiisVersion",
  );
  const normalizedAvailableAdapters = ensureOptionalStringArray(
    availableAdapters,
    "availableAdapters",
  );
  const checks = [];
  const blockedBy = [];

  function addCheck(check) {
    checks.push(createPackageCompatibilityCheck(check));
  }

  function block(reason) {
    if (!blockedBy.includes(reason)) {
      blockedBy.push(reason);
    }
  }

  if (
    compareVersions(
      normalizedCurrentNiisVersion,
      normalizedManifest.compatibility.min_niis_version,
    ) < 0
  ) {
    addCheck({
      id: "manifest-min-niis-version",
      status: "error",
      summary: `${normalizedCurrentNiisVersion} < ${normalizedManifest.compatibility.min_niis_version}`,
      details: "Package manifest requires a newer Niis version before activation is allowed.",
    });
    block("min_niis_version_unmet");
  } else {
    addCheck({
      id: "manifest-min-niis-version",
      status: "ok",
      summary: normalizedCurrentNiisVersion,
      details: "Package manifest minimum Niis version is satisfied.",
    });
  }

  if (
    normalizedManifest.compatibility.max_niis_version
    && compareVersions(
      normalizedCurrentNiisVersion,
      normalizedManifest.compatibility.max_niis_version,
    ) > 0
  ) {
    addCheck({
      id: "manifest-max-niis-version",
      status: "error",
      summary: `${normalizedCurrentNiisVersion} > ${normalizedManifest.compatibility.max_niis_version}`,
      details: "Package manifest maximum Niis version is exceeded by the current runtime.",
    });
    block("max_niis_version_exceeded");
  } else {
    addCheck({
      id: "manifest-max-niis-version",
      status: "ok",
      summary: normalizedManifest.compatibility.max_niis_version ?? "unbounded",
      details: "Package manifest maximum Niis version does not block activation.",
    });
  }

  const missingAdapters = normalizedManifest.compatibility.required_adapters.filter((adapterId) =>
    !normalizedAvailableAdapters.includes(adapterId));

  if (missingAdapters.length > 0) {
    addCheck({
      id: "manifest-required-adapters",
      status: "error",
      summary: missingAdapters.join(", "),
      details: "Package manifest declares required adapters that are not currently available for activation.",
    });
    block("required_adapters_missing");
  } else {
    addCheck({
      id: "manifest-required-adapters",
      status: "ok",
      summary: `${normalizedManifest.compatibility.required_adapters.length} required adapter(s)`,
      details: "Package manifest adapter prerequisites are satisfied.",
    });
  }

  return Object.freeze({
    available_adapters: Object.freeze(normalizedAvailableAdapters),
    blocked_by: Object.freeze(blockedBy),
    checks: Object.freeze(checks),
    compatible: blockedBy.length === 0,
    current_niis_version: normalizedCurrentNiisVersion,
    manifest_id: normalizedManifest.id,
  });
}

export {
  DEFAULT_NIIS_COMPATIBILITY_VERSION,
  PackageCompatibilityError,
  compareVersions,
  createPackageCompatibilityCheck,
  evaluatePackageManifestCompatibility,
};
