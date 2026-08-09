import fs from "node:fs";
import path from "node:path";

import { scanSecuritySurfaces } from "../policy/security-scan.js";
import { DEFAULT_THREAT_CATALOG } from "../policy/threat-catalog.js";
import { createInitPlan } from "./bootstrap-surface.js";

const TEXT_EXTENSIONS = new Set([
  ".json",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".toml",
  ".js",
  ".mjs",
  ".cjs",
]);
const TEXT_FILENAMES = new Set([
  "package.json",
  "workflow.md",
  "project-profile.md",
  "attached-repository.json",
  "registry.json",
  "install-state.json",
  "backup-policy.json",
  "store.json",
]);
const MAX_SURFACE_BYTES = 256 * 1024;

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTextLikeFile(absolutePath) {
  const baseName = path.basename(absolutePath);
  return TEXT_FILENAMES.has(baseName) || TEXT_EXTENSIONS.has(path.extname(baseName));
}

function listFilesRecursively(rootDirectory) {
  if (!fs.existsSync(rootDirectory)) {
    return [];
  }

  const files = [];

  function visit(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const absolutePath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      files.push(absolutePath);
    }
  }

  visit(rootDirectory);
  return files.sort((left, right) => left.localeCompare(right));
}

function listPackageSurfaceFiles(packageRoot) {
  const packagesRoot = path.join(packageRoot, "packages");

  if (!fs.existsSync(packagesRoot)) {
    return [];
  }

  return listFilesRecursively(packagesRoot)
    .filter((absolutePath) => path.basename(absolutePath) === "package.json");
}

function readSurfaceFile(absolutePath) {
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  const stats = fs.statSync(absolutePath);

  if (stats.size > MAX_SURFACE_BYTES || !isTextLikeFile(absolutePath)) {
    return null;
  }

  return fs.readFileSync(absolutePath, "utf8");
}

function collectCapabilitiesFromObject(value) {
  if (!isPlainObject(value)) {
    return [];
  }

  const collected = [];

  for (const key of [
    "capabilities",
    "permissions",
    "required_capabilities",
    "requiredCapabilities",
  ]) {
    const candidate = value[key];

    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (typeof entry === "string" && entry.trim() !== "") {
          collected.push(entry.trim());
        }
      }
    }
  }

  if (isPlainObject(value.required_permissions ?? value.requiredPermissions)) {
    for (const [operation, permissions] of Object.entries(
      value.required_permissions ?? value.requiredPermissions,
    )) {
      if (typeof operation === "string" && operation.trim() !== "") {
        collected.push(operation.trim());
      }

      if (Array.isArray(permissions)) {
        for (const permission of permissions) {
          if (typeof permission === "string" && permission.trim() !== "") {
            collected.push(permission.trim());
          }
        }
      }
    }
  }

  return [...new Set(collected)];
}

function collectHooksFromObject(value) {
  if (!isPlainObject(value)) {
    return [];
  }

  const hooks = [];

  if (isPlainObject(value.scripts)) {
    for (const script of Object.values(value.scripts)) {
      if (typeof script === "string" && script.trim() !== "") {
        hooks.push(script.trim());
      }
    }
  }

  if (Array.isArray(value.hooks)) {
    for (const hook of value.hooks) {
      if (typeof hook === "string" && hook.trim() !== "") {
        hooks.push(hook.trim());
      }
    }
  }

  return [...new Set(hooks)];
}

function collectHooksFromMarkdown(content) {
  const hooks = [];
  const hookPattern = /^\s*(?:provision_command|command)\s*:\s*(.+)$/gim;
  let match = hookPattern.exec(content);

  while (match) {
    hooks.push(match[1].trim().replace(/^["']|["']$/g, ""));
    match = hookPattern.exec(content);
  }

  return [...new Set(hooks)];
}

function classifySurfaceType(relativePath) {
  const normalizedPath = relativePath.split(path.sep).join("/");

  if (normalizedPath.endsWith("/workflow.md")) {
    return "workflow";
  }

  if (normalizedPath.endsWith("/project-profile.md")) {
    return "project_profile";
  }

  if (normalizedPath.endsWith("/package.json")) {
    return "package_surface";
  }

  if (normalizedPath.startsWith(".niis/")) {
    return "niis_state";
  }

  return "package_surface";
}

function createSecuritySurface(packageRoot, absolutePath) {
  const content = readSurfaceFile(absolutePath);

  if (content === null) {
    return null;
  }

  const relativePath = path.relative(packageRoot, absolutePath).split(path.sep).join("/");
  let parsed = null;

  if (path.extname(absolutePath) === ".json") {
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }
  }

  return Object.freeze({
    capabilities: collectCapabilitiesFromObject(parsed),
    content,
    hooks: [
      ...collectHooksFromObject(parsed),
      ...collectHooksFromMarkdown(content),
    ],
    id: relativePath,
    name:
      (isPlainObject(parsed) && typeof parsed.name === "string" && parsed.name.trim() !== "")
        ? parsed.name.trim()
        : path.basename(absolutePath),
    similar_to:
      isPlainObject(parsed) && typeof parsed.similar_to === "string"
        ? parsed.similar_to
        : null,
    typosquatting_candidate:
      isPlainObject(parsed) ? Boolean(parsed.typosquatting_candidate ?? false) : false,
    type: classifySurfaceType(relativePath),
  });
}

function collectDoctorSecuritySurfaces(packageRoot, { workspaceRoot = packageRoot } = {}) {
  const normalizedPackageRoot = path.resolve(ensureNonEmptyString(packageRoot, "packageRoot"));
  const normalizedWorkspaceRoot = path.resolve(ensureNonEmptyString(workspaceRoot, "workspaceRoot"));
  const initPlan = createInitPlan(normalizedWorkspaceRoot);
  const surfaceMap = new Map();

  const workspaceManifestSurface = createSecuritySurface(
    normalizedPackageRoot,
    path.join(normalizedPackageRoot, "package.json"),
  );

  if (workspaceManifestSurface) {
    surfaceMap.set(workspaceManifestSurface.id, workspaceManifestSurface);
  }

  for (const absolutePath of [
    ...listFilesRecursively(initPlan.stateRoot),
  ]) {
    const surface = createSecuritySurface(normalizedWorkspaceRoot, absolutePath);

    if (!surface) {
      continue;
    }

    surfaceMap.set(surface.id, surface);
  }

  for (const absolutePath of listPackageSurfaceFiles(normalizedPackageRoot)) {
    const surface = createSecuritySurface(normalizedPackageRoot, absolutePath);

    if (!surface) {
      continue;
    }

    surfaceMap.set(surface.id, surface);
  }

  return [...surfaceMap.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function mapFindingToDoctorCheck(finding, index) {
  return Object.freeze({
    details: `[${finding.severity}] ${finding.summary} Remediation: ${finding.remediation_hint}`,
    id: `security-finding-${index + 1}`,
    status: finding.blocking ? "error" : "warning",
    summary: `${finding.rule_id} @ ${finding.source_surface_id}`,
  });
}

function collectDoctorSecurityChecks(packageRoot, {
  threatCatalog = DEFAULT_THREAT_CATALOG,
  workspaceRoot = packageRoot,
} = {}) {
  const surfaces = collectDoctorSecuritySurfaces(packageRoot, { workspaceRoot });
  const scan = scanSecuritySurfaces({
    surfaceType: "doctor",
    surfaces,
    threatCatalog,
  });
  const blockingFindings = scan.findings.filter((finding) => finding.blocking).length;
  const checks = [
    {
      details:
        scan.findings.length === 0
          ? `Scanned ${surfaces.length} config/package surfaces against the named threat catalog and found no issues.`
          : `Scanned ${surfaces.length} config/package surfaces and found ${scan.findings.length} issue(s), ${blockingFindings} of them blocking.`,
      id: "security-scan-summary",
      status:
        blockingFindings > 0
          ? "error"
          : scan.findings.length > 0
            ? "warning"
            : "ok",
      summary: scan.summary.summary,
    },
    ...scan.findings.map(mapFindingToDoctorCheck),
  ];

  return checks;
}

export {
  collectDoctorSecurityChecks,
  collectDoctorSecuritySurfaces,
};
