import fs from "node:fs";
import path from "node:path";

import {
  createDiscoveryCandidate,
  createDiscoveryReport,
  createPackageManifest,
} from "../contracts/packages.js";
import { scanSecuritySurfaces } from "../policy/security-scan.js";
import { DEFAULT_THREAT_CATALOG } from "../policy/threat-catalog.js";

class PackageDiscoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageDiscoveryError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PackageDiscoveryError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageDiscoveryError(`${label} must be a plain object`);
  }

  return value;
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new PackageDiscoveryError(`${label} must be an array`);
  }

  return value;
}

function normalizeSources(sources = []) {
  return ensureArray(sources, "sources").map((source, index) => {
    const normalizedSource = ensurePlainObject(source, `sources[${index}]`);
    const sourceKind = normalizedSource.kind ?? normalizedSource.sourceKind;

    if (!["local_filesystem", "registry"].includes(sourceKind)) {
      throw new PackageDiscoveryError(
        `sources[${index}].kind must be one of: local_filesystem, registry`,
      );
    }

    return Object.freeze({
      entries: normalizedSource.entries ?? null,
      kind: sourceKind,
      registry_path: normalizedSource.registryPath ?? normalizedSource.registry_path ?? null,
      root_directory: normalizedSource.rootDirectory ?? normalizedSource.root_directory ?? null,
      source_id: normalizedSource.id ?? `${sourceKind}-${index + 1}`,
    });
  });
}

function normalizeAlreadyReported(alreadyReported = null) {
  if (alreadyReported === null || alreadyReported === undefined) {
    return [];
  }

  const rawEntries = Array.isArray(alreadyReported)
    ? alreadyReported
    : Array.isArray(alreadyReported.candidates)
      ? alreadyReported.candidates
      : null;

  if (rawEntries === null) {
    throw new PackageDiscoveryError(
      "alreadyReported must be either an array of prior candidates or a discovery report with candidates",
    );
  }

  return rawEntries.map((entry, index) => {
    const normalizedEntry = ensurePlainObject(entry, `alreadyReported[${index}]`);

    return Object.freeze({
      canonical_candidate_id: ensureNonEmptyString(
        normalizedEntry.canonical_candidate_id
          ?? normalizedEntry.canonicalCandidateId
          ?? normalizedEntry.candidate_id
          ?? normalizedEntry.candidateId,
        `alreadyReported[${index}].canonical_candidate_id`,
      ),
      dedup_key: ensureNonEmptyString(
        normalizedEntry.dedup_key ?? normalizedEntry.dedupKey,
        `alreadyReported[${index}].dedup_key`,
      ),
    });
  });
}

function listFilesRecursively(rootDirectory) {
  if (!fs.existsSync(rootDirectory)) {
    return [];
  }

  const files = [];
  const IGNORED_DIRECTORY_NAMES = new Set(["node_modules"]);

  function visit(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const absolutePath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          continue;
        }

        visit(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  visit(rootDirectory);
  return files.sort((left, right) => left.localeCompare(right));
}

function looksLikeNiisManifest(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.version === "string"
    && typeof value.type === "string"
    && Array.isArray(value.capabilities)
    && value.compatibility
    && typeof value.schema_version === "string";
}

function resolveCandidateKindFromPackageJson(packageJson) {
  const niis = packageJson.niis ?? {};
  const explicitKind = niis.candidate_kind ?? niis.candidateKind ?? null;

  if (explicitKind === "plugin") {
    return "plugin";
  }

  if (explicitKind === "package") {
    return "package";
  }

  const keywords = Array.isArray(packageJson.keywords) ? packageJson.keywords : [];

  if (keywords.includes("niis-plugin")) {
    return "plugin";
  }

  return "package";
}

function normalizeReviewManifest(manifestInput) {
  if (!looksLikeNiisManifest(manifestInput)) {
    return null;
  }

  return createPackageManifest({
    activationStatus: "REVIEW",
    capabilities: manifestInput.capabilities,
    compatibility: manifestInput.compatibility,
    id: manifestInput.id,
    name: manifestInput.name,
    schemaVersion: manifestInput.schema_version,
    type: manifestInput.type,
    version: manifestInput.version,
  });
}

function createDiscoverySurface({
  candidateKind,
  content,
  capabilities = [],
  hooks = [],
  id,
  similarTo = null,
  typosquattingCandidate = false,
}) {
  return {
    capabilities,
    content,
    hooks,
    id,
    similar_to: similarTo,
    typosquatting_candidate: typosquattingCandidate,
    type: `${candidateKind}_candidate`,
  };
}

function classifyDiscoverySuggestion({
  nativeManifest,
  scanFindings,
  sourceKind,
}) {
  if (scanFindings.some((finding) => finding.blocking)) {
    return Object.freeze({
      category: "technical_debt",
      reason:
        "Discovery found a candidate with blocking review or security findings, so it should be tracked as debt before promotion.",
    });
  }

  if (sourceKind === "local_filesystem" && nativeManifest) {
    return Object.freeze({
      category: "shipped_capability",
      reason:
        "Discovery found an existing local reviewable package manifest, so the result represents already shipped capability rather than a new import idea.",
    });
  }

  return Object.freeze({
    category: "speculative_idea",
    reason:
      "Discovery found a reviewable candidate, but it is not yet proven as an existing shipped local capability and remains a low-confidence suggestion.",
  });
}

function createCandidateFromResolvedInput({
  candidateKind,
  content,
  dedupKey,
  displayName,
  hooks,
  metadata,
  nativeManifest,
  packageId,
  similarTo,
  sourceKind,
  sourceRef,
  threatCatalog,
  typosquattingCandidate,
  version,
}) {
  const scan = scanSecuritySurfaces({
    surfaceType: "discovery",
    surfaces: [
      createDiscoverySurface({
        candidateKind,
        capabilities: nativeManifest?.capabilities ?? metadata.capabilities ?? [],
        content,
        hooks,
        id: sourceRef,
        similarTo,
        typosquattingCandidate,
      }),
    ],
    threatCatalog,
  });
  const suggestion = classifyDiscoverySuggestion({
    nativeManifest,
    scanFindings: scan.findings,
    sourceKind,
  });

  return createDiscoveryCandidate({
    candidateId: `${sourceKind}:${sourceRef}`,
    candidateKind,
    dedupKey,
    displayName,
    metadata,
    packageId,
    packageManifest: nativeManifest,
    securityFindings: scan.findings,
    sourceKind,
    sourceRef,
    suggestionCategory: suggestion.category,
    suggestionReason: suggestion.reason,
    version,
  });
}

function discoverFilesystemCandidates(source, threatCatalog) {
  const rootDirectory = path.resolve(ensureNonEmptyString(source.root_directory, "rootDirectory"));
  const packageJsonFiles = listFilesRecursively(rootDirectory)
    .filter((absolutePath) => path.basename(absolutePath) === "package.json");

  return packageJsonFiles.flatMap((packageJsonPath) => {
    let packageJson;
    let fileContent;

    try {
      fileContent = fs.readFileSync(packageJsonPath, "utf8");
      packageJson = JSON.parse(fileContent);
    } catch {
      return [];
    }

    const candidateKind = resolveCandidateKindFromPackageJson(packageJson);
    const nativeManifest = normalizeReviewManifest(
      packageJson.niisManifest ?? packageJson.niis_manifest ?? packageJson,
    );
    const packageId = nativeManifest?.id ?? packageJson.name ?? null;
    const displayName = nativeManifest?.name ?? packageJson.name ?? path.basename(path.dirname(packageJsonPath));
    const version = nativeManifest?.version ?? packageJson.version ?? null;
    const niisMetadata = packageJson.niis ?? {};

    return [
      createCandidateFromResolvedInput({
        candidateKind,
        content: fileContent,
        dedupKey:
          packageId !== null
            ? `${candidateKind}:${packageId}`
            : `${candidateKind}:${displayName.toLowerCase()}:${version ?? "unknown"}`,
        displayName,
        hooks: Object.values(packageJson.scripts ?? {}).filter((value) => typeof value === "string"),
        metadata: {
          capabilities: nativeManifest?.capabilities ?? niisMetadata.capabilities ?? [],
          filesystem_root: rootDirectory,
          source_id: source.source_id,
        },
        nativeManifest,
        packageId,
        similarTo: niisMetadata.similar_to ?? niisMetadata.similarTo ?? null,
        sourceKind: "local_filesystem",
        sourceRef: packageJsonPath,
        threatCatalog,
        typosquattingCandidate: Boolean(
          niisMetadata.typosquatting_candidate ?? niisMetadata.typosquattingCandidate ?? false,
        ),
        version,
      }),
    ];
  });
}

function loadRegistryEntries(source) {
  if (Array.isArray(source.entries)) {
    return source.entries;
  }

  const registryPath = path.resolve(ensureNonEmptyString(source.registry_path, "registryPath"));
  const payload = JSON.parse(fs.readFileSync(registryPath, "utf8"));

  if (Array.isArray(payload)) {
    return payload;
  }

  return payload.entries ?? [];
}

function discoverRegistryCandidates(source, threatCatalog) {
  return ensureArray(loadRegistryEntries(source), "registry entries").map((entry, index) => {
    const normalizedEntry = ensurePlainObject(entry, `registry.entries[${index}]`);
    const candidateKind = normalizedEntry.candidate_kind ?? normalizedEntry.candidateKind ?? "package";
    const sourceRef = ensureNonEmptyString(
      normalizedEntry.source_ref ?? normalizedEntry.sourceRef ?? `registry-entry-${index + 1}`,
      `registry.entries[${index}].source_ref`,
    );
    const nativeManifest = normalizeReviewManifest(
      normalizedEntry.package_manifest ?? normalizedEntry.packageManifest ?? null,
    );
    const displayName = normalizedEntry.display_name
      ?? normalizedEntry.displayName
      ?? nativeManifest?.name
      ?? normalizedEntry.package_id
      ?? normalizedEntry.packageId
      ?? sourceRef;
    const packageId = normalizedEntry.package_id ?? normalizedEntry.packageId ?? nativeManifest?.id ?? null;
    const version = normalizedEntry.version ?? nativeManifest?.version ?? null;

    return createCandidateFromResolvedInput({
      candidateKind,
      content:
        normalizedEntry.content
        ?? JSON.stringify(normalizedEntry.package_manifest ?? normalizedEntry.packageManifest ?? normalizedEntry),
      dedupKey:
        packageId !== null
          ? `${candidateKind}:${packageId}`
          : `${candidateKind}:${String(displayName).toLowerCase()}:${version ?? "unknown"}`,
      displayName: String(displayName),
      hooks: ensureArray(normalizedEntry.hooks ?? [], `registry.entries[${index}].hooks`),
      metadata: {
        capabilities: normalizedEntry.capabilities ?? nativeManifest?.capabilities ?? [],
        registry_source_id: source.source_id,
      },
      nativeManifest,
      packageId,
      similarTo: normalizedEntry.similar_to ?? normalizedEntry.similarTo ?? null,
      sourceKind: "registry",
      sourceRef,
      threatCatalog,
      typosquattingCandidate: Boolean(
        normalizedEntry.typosquatting_candidate ?? normalizedEntry.typosquattingCandidate ?? false,
      ),
      version,
    });
  });
}

function dedupeCandidates(candidates, { alreadyReported = [] } = {}) {
  const dedupedCandidates = [];
  const duplicates = [];
  const canonicalByKey = new Map();

  for (const reported of normalizeAlreadyReported(alreadyReported)) {
    canonicalByKey.set(reported.dedup_key, {
      candidate_id: reported.canonical_candidate_id,
      reported_previously: true,
    });
  }

  for (const candidate of candidates) {
    const existing = canonicalByKey.get(candidate.dedup_key);

    if (existing) {
      duplicates.push({
        candidateId: candidate.candidate_id,
        canonicalCandidateId: existing.candidate_id,
        dedupKey: candidate.dedup_key,
        reason: existing.reported_previously
          ? `candidate was already reported as ${existing.candidate_id} on dedup key ${candidate.dedup_key}`
          : `candidate duplicates ${existing.candidate_id} on dedup key ${candidate.dedup_key}`,
      });
      continue;
    }

    canonicalByKey.set(candidate.dedup_key, candidate);
    dedupedCandidates.push(candidate);
  }

  return {
    candidates: dedupedCandidates,
    duplicates,
  };
}

function discoverPackageCandidates({
  alreadyReported = null,
  reportId = "package-discovery-report",
  sources = [],
  threatCatalog = DEFAULT_THREAT_CATALOG,
  now = new Date(),
} = {}) {
  const normalizedSources = normalizeSources(sources);
  const rawCandidates = normalizedSources.flatMap((source) => {
    switch (source.kind) {
      case "local_filesystem":
        return discoverFilesystemCandidates(source, threatCatalog);
      case "registry":
        return discoverRegistryCandidates(source, threatCatalog);
      default:
        throw new PackageDiscoveryError(`unsupported discovery source kind: ${source.kind}`);
    }
  });
  const deduped = dedupeCandidates(rawCandidates, { alreadyReported });

  return createDiscoveryReport({
    candidates: deduped.candidates,
    duplicates: deduped.duplicates,
    generatedAt: now,
    reportId,
    sourceKinds: [...new Set(normalizedSources.map((source) => source.kind))],
  });
}

export {
  PackageDiscoveryError,
  discoverPackageCandidates,
};
