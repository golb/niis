import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runAdversarialActivationProof,
} from "./adversarial-activation-proof.js";

class AdversarialHostSurfacesProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "AdversarialHostSurfacesProofError";
    this.result = result;
  }
}

const DISCOVERY_CATEGORIES = Object.freeze([
  "documentation",
  "package_manifest",
  "playwright_config",
  "source_view",
  "source_api",
  "server_route",
  "prehandler",
  "server_plugin",
  "server_runtime",
]);

const TEST_DIRECTORY_CANDIDATES = Object.freeze([
  "e2e",
  "tests",
  "test",
  "specs",
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".git",
  ".niis",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "niis",
  "output",
  "vendor",
  "venv",
]);

const RESOLVED_DEPENDENCY_GRAPH_MAX_DEPTH = 3;

function resolveFlagValue(args, flagName) {
  const flagIndex = args.indexOf(flagName);

  if (flagIndex === -1) {
    return null;
  }

  return args[flagIndex + 1] ?? null;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function pathExistsAsFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function pathExistsAsDirectory(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
}

function createDiscoveredSurface({
  candidateCount,
  category,
  relativePath,
  score,
  selectionReason,
  selectionSignals,
  validationSurfaceRoot,
}) {
  return Object.freeze({
    candidate_count: candidateCount,
    category,
    relative_path: relativePath,
    score,
    selection_reason: selectionReason,
    selection_signals: Object.freeze(selectionSignals),
    source_path: path.join(validationSurfaceRoot, relativePath),
  });
}

function pathDepth(relativePath) {
  return relativePath.split("/").filter(Boolean).length - 1;
}

function addScoreSignal(signals, condition, score, reason) {
  if (!condition) {
    return 0;
  }

  signals.push(`${score >= 0 ? "+" : ""}${score}:${reason}`);
  return score;
}

function readTextFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function extractImportSpecifiers(text) {
  const specifiers = new Set();

  for (const match of text.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) {
    specifiers.add(match[1]);
  }

  for (const match of text.matchAll(/\b(?:import|export)\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g)) {
    specifiers.add(match[1]);
  }

  for (const match of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.add(match[1]);
  }

  for (const match of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.add(match[1]);
  }

  return specifiers;
}

function extractImportedBindings(text) {
  const bindings = new Set();

  for (const match of text.matchAll(/\bimport\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = match[1].trim();

    if (!clause) {
      continue;
    }

    const normalizedClause = clause
      .replace(/^\*\s+as\s+/i, "")
      .replace(/[{}]/g, ",");

    for (const token of normalizedClause.split(",")) {
      const normalizedToken = token
        .trim()
        .replace(/\s+as\s+.+$/i, "")
        .trim();

      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalizedToken)) {
        bindings.add(normalizedToken);
      }
    }
  }

  return bindings;
}

function extractMemberAccessPaths(text) {
  const memberAccessPaths = new Set();

  for (const match of text.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){1,4}\b/g)) {
    memberAccessPaths.add(match[0]);
  }

  return memberAccessPaths;
}

function countPatternMatches(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function sortCandidates(candidates) {
  return [...candidates].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return left.relative_path.localeCompare(right.relative_path);
  });
}

function walkHostTree(validationSurfaceRoot, visitor, currentRelativePath = "") {
  const currentAbsolutePath = currentRelativePath
    ? path.join(validationSurfaceRoot, currentRelativePath)
    : validationSurfaceRoot;
  const entries = fs.readdirSync(currentAbsolutePath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }

    const relativePath = currentRelativePath
      ? path.posix.join(currentRelativePath, entry.name)
      : entry.name;
    const absolutePath = path.join(currentAbsolutePath, entry.name);
    visitor({
      absolute_path: absolutePath,
      dirent: entry,
      relative_path: relativePath,
    });

    if (entry.isDirectory()) {
      walkHostTree(validationSurfaceRoot, visitor, relativePath);
    }
  }
}

function collectHostFileCandidates(validationSurfaceRoot, predicate) {
  const matches = [];
  walkHostTree(validationSurfaceRoot, (entry) => {
    if (entry.dirent.isFile() && predicate(entry)) {
      matches.push(entry);
    }
  });
  return matches;
}

function collectHostDirectoryCandidates(validationSurfaceRoot, predicate) {
  const matches = [];
  walkHostTree(validationSurfaceRoot, (entry) => {
    if (entry.dirent.isDirectory() && predicate(entry)) {
      matches.push(entry);
    }
  });
  return matches;
}

function scoreDocumentationCandidate(candidate) {
  const signals = [];
  const content = readTextFileSafe(candidate.absolute_path);
  let score = 0;

  score += addScoreSignal(signals, pathDepth(candidate.relative_path) === 0, 60, "root-readme");
  score += addScoreSignal(signals, /playwright|e2e|proof/i.test(content), 40, "playwright-or-e2e-content");
  score += addScoreSignal(signals, /architecture|usage|testing|workflow/i.test(content), 20, "project-guidance-content");

  return Object.freeze({
    category: "documentation",
    relative_path: candidate.relative_path,
    score,
    signals: Object.freeze(signals),
  });
}

function scorePackageManifestCandidate(candidate) {
  const signals = [];
  const content = readTextFileSafe(candidate.absolute_path);
  const packageJson = JSON.parse(content || "{}");
  const scripts = packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const scriptText = Object.entries(scripts).map(([key, value]) => `${key}:${value}`).join("\n");
  let score = 0;

  score += addScoreSignal(signals, pathDepth(candidate.relative_path) === 0, 120, "root-package-manifest");
  score += addScoreSignal(signals, /playwright|test:e2e/i.test(scriptText), 60, "playwright-or-e2e-scripts");
  score += addScoreSignal(signals, /start|build|test/i.test(scriptText), 20, "core-lifecycle-scripts");

  return Object.freeze({
    category: "package_manifest",
    relative_path: candidate.relative_path,
    score,
    signals: Object.freeze(signals),
  });
}

function scorePlaywrightConfigCandidate(candidate) {
  const signals = [];
  let score = 0;

  score += addScoreSignal(signals, pathDepth(candidate.relative_path) === 0, 120, "root-playwright-config");
  score += addScoreSignal(signals, candidate.relative_path.endsWith(".ts"), 40, "typescript-config");

  return Object.freeze({
    category: "playwright_config",
    relative_path: candidate.relative_path,
    score,
    signals: Object.freeze(signals),
  });
}

function isIgnoredSourceLikePath(relativePath) {
  return /(__tests__|__mocks__|\.spec\.|\.test\.)/i.test(relativePath);
}

function inferServerRuntimeFamily(relativePath) {
  if (/^src\/server\/routes\//i.test(relativePath)) {
    return "route";
  }

  if (/^src\/server\/prehandlers\//i.test(relativePath)) {
    return "prehandler";
  }

  if (/^src\/server\/plugins\//i.test(relativePath)) {
    return "plugin";
  }

  if (/^src\/server\/index\.(ts|tsx|js|jsx)$/i.test(relativePath)) {
    return "bootstrap";
  }

  if (/^src\/server\/.+\.(ts|tsx|js|jsx)$/i.test(relativePath)) {
    return "other";
  }

  return "unknown";
}

function toPascalCase(value) {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

function stripSrcPrefix(relativePath) {
  return relativePath.replace(/^src\//, "");
}

function normalizeSourceModulePath(relativePath) {
  return relativePath
    .split(path.sep)
    .join("/")
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, "")
    .replace(/\/index$/i, "");
}

function extractNamedExports(text) {
  const bindings = new Set();

  for (const match of text.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    bindings.add(match[1]);
  }

  for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    const entries = match[1].split(",");

    for (const entry of entries) {
      const normalizedEntry = entry.trim();

      if (!normalizedEntry) {
        continue;
      }

      const aliasMatch = normalizedEntry.match(/\bas\s+([A-Za-z_$][A-Za-z0-9_$]*)$/i);

      if (aliasMatch) {
        bindings.add(aliasMatch[1]);
        continue;
      }

      const nameMatch = normalizedEntry.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);

      if (nameMatch) {
        bindings.add(nameMatch[1]);
      }
    }
  }

  return bindings;
}

function extractDefaultObjectExportProperties(text) {
  const properties = new Set();
  const match = text.match(/\bexport\s+default\s*\{([\s\S]*?)\}\s*;?/);

  if (!match) {
    return properties;
  }

  for (const entry of match[1].split(",")) {
    const normalizedEntry = entry.trim();

    if (!normalizedEntry) {
      continue;
    }

    const propertyMatch = normalizedEntry.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);

    if (propertyMatch) {
      properties.add(propertyMatch[1]);
    }
  }

  return properties;
}

function findExistingSourceFile(basePath) {
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath;
  }

  for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
    const candidatePath = `${basePath}${extension}`;

    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }

  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
      const candidatePath = path.join(basePath, `index${extension}`);

      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        return candidatePath;
      }
    }
  }

  return null;
}

function resolveFilePathToSourceModulePath(resolvedFilePath, validationSurfaceRoot) {
  return normalizeSourceModulePath(
    path.relative(path.join(validationSurfaceRoot, "src"), resolvedFilePath),
  );
}

function loadServerAliasMappings(validationSurfaceRoot) {
  const tsconfig = readJsonFileSafe(path.join(validationSurfaceRoot, "tsconfig.json"));
  const paths = tsconfig?.compilerOptions?.paths;

  if (!paths || typeof paths !== "object") {
    return [];
  }

  return Object.entries(paths)
    .flatMap(([alias, targets]) => Array.isArray(targets)
      ? targets.map((target) => ({ alias, target }))
      : [])
    .filter((entry) => typeof entry.alias === "string"
      && typeof entry.target === "string"
      && /^@[^/]+(?:\/\*)?$/.test(entry.alias)
      && /^server\/.+/.test(entry.target))
    .map((entry) => Object.freeze(entry));
}

function resolveImportSpecifierToFilePath(importerFilePath, specifier, validationSurfaceRoot, aliasMappings) {
  if (!specifier) {
    return null;
  }

  if (specifier.startsWith(".")) {
    return findExistingSourceFile(path.resolve(path.dirname(importerFilePath), specifier));
  }

  for (const mapping of aliasMappings) {
    if (mapping.alias.includes("*") && mapping.target.includes("*")) {
      const aliasPrefix = mapping.alias.split("*")[0];
      const targetPrefix = mapping.target.split("*")[0];

      if (specifier.startsWith(aliasPrefix)) {
        const wildcardValue = specifier.slice(aliasPrefix.length).replace(/^\/+/, "");
        return findExistingSourceFile(path.join(validationSurfaceRoot, "src", targetPrefix, wildcardValue));
      }

      continue;
    }

    if (specifier === mapping.alias) {
      return findExistingSourceFile(path.join(validationSurfaceRoot, "src", mapping.target));
    }
  }

  return null;
}

function parseImportBindingTargets(text) {
  const bindingTargets = new Map();

  for (const importStatement of parseImportStatements(text)) {
    if (importStatement.default_import) {
      bindingTargets.set(importStatement.default_import, Object.freeze({
        imported: "default",
        specifier: importStatement.specifier,
      }));
    }

    if (importStatement.namespace_import) {
      bindingTargets.set(importStatement.namespace_import, Object.freeze({
        imported: "*",
        specifier: importStatement.specifier,
      }));
    }

    for (const namedImport of importStatement.named_imports) {
      bindingTargets.set(namedImport.local, Object.freeze({
        imported: namedImport.imported,
        specifier: importStatement.specifier,
      }));
    }
  }

  return bindingTargets;
}

function parseNamedExportStatements(text) {
  const namedExports = [];

  for (const match of text.matchAll(/\bexport\s*\{([\s\S]*?)\}\s*(?:from\s+['"]([^'"]+)['"])?/g)) {
    const specifier = match[2] || null;

    for (const entry of match[1].split(",")) {
      const normalizedEntry = entry.trim();

      if (!normalizedEntry) {
        continue;
      }

      const aliasMatch = normalizedEntry.match(/^([A-Za-z_$][A-Za-z0-9_$]*|default)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/);

      if (!aliasMatch) {
        continue;
      }

      namedExports.push(Object.freeze({
        exported: aliasMatch[2] || aliasMatch[1],
        imported: aliasMatch[1],
        specifier,
      }));
    }
  }

  return Object.freeze(namedExports);
}

function parseNamespaceExportStatements(text) {
  const namespaceExports = [];

  for (const match of text.matchAll(/\bexport\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (match[1] && match[2]) {
      namespaceExports.push(Object.freeze({
        exported: match[1],
        specifier: match[2],
      }));
    }
  }

  return Object.freeze(namespaceExports);
}

function parseExportAllStatements(text) {
  const exportAllStatements = [];

  for (const match of text.matchAll(/\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/g)) {
    if (match[1]) {
      exportAllStatements.push(match[1]);
    }
  }

  return Object.freeze(exportAllStatements);
}

function parseSideEffectImportSpecifiers(text) {
  const sideEffectImportSpecifiers = [];

  for (const match of text.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) {
    if (match[1]) {
      sideEffectImportSpecifiers.push(match[1]);
    }
  }

  return Object.freeze(sideEffectImportSpecifiers);
}

function resolveImportedBindingTarget(
  importerFilePath,
  specifier,
  importedBinding,
  validationSurfaceRoot,
  aliasMappings,
  resolvedExportTargetCache = new Map(),
) {
  const resolvedFilePath = resolveImportSpecifierToFilePath(
    importerFilePath,
    specifier,
    validationSurfaceRoot,
    aliasMappings,
  );

  if (!resolvedFilePath) {
    return null;
  }

  const normalizedResolvedFilePath = path.resolve(resolvedFilePath);

  if (importedBinding === "default" || importedBinding === "*") {
    return normalizedResolvedFilePath;
  }

  const nestedResolvedExportTargets = deriveResolvedExportTargets(
    normalizedResolvedFilePath,
    validationSurfaceRoot,
    aliasMappings,
    resolvedExportTargetCache,
  );

  return nestedResolvedExportTargets.get(importedBinding) || normalizedResolvedFilePath;
}

function parseImportStatements(text) {
  const importStatements = [];

  for (const match of text.matchAll(/\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = match[1].trim();
    const specifier = match[2];

    if (!clause || !specifier) {
      continue;
    }

    let defaultImport = null;
    let namespaceImport = null;
    const namedImports = [];

    const namedImportsMatch = clause.match(/\{([\s\S]*?)\}/);

    if (namedImportsMatch) {
      for (const entry of namedImportsMatch[1].split(",")) {
        const normalizedEntry = entry.trim();

        if (!normalizedEntry) {
          continue;
        }

        const aliasMatch = normalizedEntry.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/);

        if (aliasMatch) {
          namedImports.push(Object.freeze({
            imported: aliasMatch[1],
            local: aliasMatch[2] || aliasMatch[1],
          }));
        }
      }
    }

    const namespaceImportMatch = clause.match(/(?:^|,)\s*\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);

    if (namespaceImportMatch) {
      namespaceImport = namespaceImportMatch[1];
    }

    const defaultClause = clause
      .split(",")[0]
      ?.trim()
      .replace(/^\*\s+as\s+.+$/i, "")
      .trim();

    if (defaultClause && !defaultClause.startsWith("{") && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(defaultClause)) {
      defaultImport = defaultClause;
    }

    importStatements.push(Object.freeze({
      default_import: defaultImport,
      namespace_import: namespaceImport,
      named_imports: Object.freeze(namedImports),
      specifier,
    }));
  }

  return Object.freeze(importStatements);
}

function deriveResolvedExportTargets(
  filePath,
  validationSurfaceRoot,
  aliasMappings,
  resolvedExportTargetCache = new Map(),
) {
  const normalizedFilePath = path.resolve(filePath);
  const cacheKey = normalizedFilePath;

  if (resolvedExportTargetCache.has(cacheKey)) {
    return resolvedExportTargetCache.get(cacheKey);
  }

  const resolvedExportTargets = new Map();
  resolvedExportTargetCache.set(cacheKey, resolvedExportTargets);

  const fileText = readTextFileSafe(normalizedFilePath);
  const directExportBindings = extractNamedExports(fileText);
  const bindingTargets = parseImportBindingTargets(fileText);
  const namedExportStatements = parseNamedExportStatements(fileText);
  const namespaceExportStatements = parseNamespaceExportStatements(fileText);

  for (const directExportBinding of directExportBindings) {
    resolvedExportTargets.set(directExportBinding, normalizedFilePath);
  }

  for (const namedExport of namedExportStatements) {
    if (!namedExport.specifier) {
      const bindingTarget = bindingTargets.get(namedExport.imported);

      if (!bindingTarget) {
        continue;
      }

      const resolvedTargetFilePath = resolveImportedBindingTarget(
        normalizedFilePath,
        bindingTarget.specifier,
        bindingTarget.imported,
        validationSurfaceRoot,
        aliasMappings,
        resolvedExportTargetCache,
      );

      if (resolvedTargetFilePath) {
        resolvedExportTargets.set(namedExport.exported, resolvedTargetFilePath);
      }

      continue;
    }

    const resolvedTargetFilePath = resolveImportedBindingTarget(
      normalizedFilePath,
      namedExport.specifier,
      namedExport.imported,
      validationSurfaceRoot,
      aliasMappings,
      resolvedExportTargetCache,
    );

    if (resolvedTargetFilePath) {
      resolvedExportTargets.set(namedExport.exported, resolvedTargetFilePath);
    }
  }

  for (const namespaceExport of namespaceExportStatements) {
    const resolvedTargetFilePath = resolveImportedBindingTarget(
      normalizedFilePath,
      namespaceExport.specifier,
      "*",
      validationSurfaceRoot,
      aliasMappings,
      resolvedExportTargetCache,
    );

    if (resolvedTargetFilePath) {
      resolvedExportTargets.set(namespaceExport.exported, resolvedTargetFilePath);
    }
  }

  for (const exportAllSpecifier of parseExportAllStatements(fileText)) {
    const resolvedFilePath = resolveImportSpecifierToFilePath(
      normalizedFilePath,
      exportAllSpecifier,
      validationSurfaceRoot,
      aliasMappings,
    );

    if (!resolvedFilePath) {
      continue;
    }

    const nestedResolvedExportTargets = deriveResolvedExportTargets(
      resolvedFilePath,
      validationSurfaceRoot,
      aliasMappings,
      resolvedExportTargetCache,
    );

    for (const [binding, resolvedTargetFilePath] of nestedResolvedExportTargets.entries()) {
      if (!resolvedExportTargets.has(binding)) {
        resolvedExportTargets.set(binding, resolvedTargetFilePath);
      }
    }
  }

  return resolvedExportTargets;
}

function deriveResolvedDependencySourcePathsForFile(
  filePath,
  validationSurfaceRoot,
  aliasMappings,
  {
    maxDepth = RESOLVED_DEPENDENCY_GRAPH_MAX_DEPTH,
    resolvedDependencyGraphCache = new Map(),
    resolvedExportTargetCache = new Map(),
  } = {},
) {
  const normalizedFilePath = path.resolve(filePath);
  const cacheKey = `${normalizedFilePath}:${maxDepth}`;

  if (resolvedDependencyGraphCache.has(cacheKey)) {
    return resolvedDependencyGraphCache.get(cacheKey);
  }

  const resolvedSourcePaths = new Set([
    resolveFilePathToSourceModulePath(normalizedFilePath, validationSurfaceRoot),
  ]);
  const queue = [{ depth: 0, file_path: normalizedFilePath }];
  const exploredDepthByFile = new Map();

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    const existingDepth = exploredDepthByFile.get(current.file_path);

    if (existingDepth !== undefined && existingDepth <= current.depth) {
      continue;
    }

    exploredDepthByFile.set(current.file_path, current.depth);

    if (current.depth >= maxDepth) {
      continue;
    }

    const fileText = readTextFileSafe(current.file_path);

    if (!fileText) {
      continue;
    }

    const currentFileResolvedExportTargets = deriveResolvedExportTargets(
      current.file_path,
      validationSurfaceRoot,
      aliasMappings,
      resolvedExportTargetCache,
    );

    for (const resolvedTargetFilePath of new Set(currentFileResolvedExportTargets.values())) {
      if (path.resolve(resolvedTargetFilePath) === current.file_path) {
        continue;
      }

      resolvedSourcePaths.add(
        resolveFilePathToSourceModulePath(resolvedTargetFilePath, validationSurfaceRoot),
      );
      queue.push({
        depth: current.depth + 1,
        file_path: resolvedTargetFilePath,
      });
    }

    for (const sideEffectImportSpecifier of parseSideEffectImportSpecifiers(fileText)) {
      const resolvedFilePath = resolveImportSpecifierToFilePath(
        current.file_path,
        sideEffectImportSpecifier,
        validationSurfaceRoot,
        aliasMappings,
      );

      if (!resolvedFilePath) {
        continue;
      }

      const normalizedResolvedFilePath = path.resolve(resolvedFilePath);
      resolvedSourcePaths.add(
        resolveFilePathToSourceModulePath(normalizedResolvedFilePath, validationSurfaceRoot),
      );
      queue.push({
        depth: current.depth + 1,
        file_path: normalizedResolvedFilePath,
      });
    }

    for (const importStatement of parseImportStatements(fileText)) {
      const resolvedFilePath = resolveImportSpecifierToFilePath(
        current.file_path,
        importStatement.specifier,
        validationSurfaceRoot,
        aliasMappings,
      );

      if (!resolvedFilePath) {
        continue;
      }

      const normalizedResolvedFilePath = path.resolve(resolvedFilePath);
      resolvedSourcePaths.add(
        resolveFilePathToSourceModulePath(normalizedResolvedFilePath, validationSurfaceRoot),
      );
      queue.push({
        depth: current.depth + 1,
        file_path: normalizedResolvedFilePath,
      });

      if (importStatement.named_imports.length === 0) {
        if (!importStatement.namespace_import) {
          continue;
        }
      }

      const resolvedExportTargets = deriveResolvedExportTargets(
        normalizedResolvedFilePath,
        validationSurfaceRoot,
        aliasMappings,
        resolvedExportTargetCache,
      );

      if (importStatement.namespace_import) {
        for (const resolvedTargetFilePath of new Set(resolvedExportTargets.values())) {
          resolvedSourcePaths.add(
            resolveFilePathToSourceModulePath(resolvedTargetFilePath, validationSurfaceRoot),
          );
          queue.push({
            depth: current.depth + 1,
            file_path: resolvedTargetFilePath,
          });
        }
      }

      for (const namedImport of importStatement.named_imports) {
        const resolvedTargetFilePath = resolvedExportTargets.get(namedImport.imported);

        if (!resolvedTargetFilePath) {
          continue;
        }

        resolvedSourcePaths.add(
          resolveFilePathToSourceModulePath(resolvedTargetFilePath, validationSurfaceRoot),
        );
        queue.push({
          depth: current.depth + 1,
          file_path: resolvedTargetFilePath,
        });
      }
    }
  }

  resolvedDependencyGraphCache.set(cacheKey, resolvedSourcePaths);
  return resolvedSourcePaths;
}

function deriveSelectedSurfaceGraphHint(
  surface,
  aliasMappings,
  validationSurfaceRoot,
  {
    resolvedDependencyGraphCache = new Map(),
    resolvedExportTargetCache = new Map(),
  } = {},
) {
  const surfaceFilePath = path.join(validationSurfaceRoot, surface.relative_path);

  return Object.freeze({
    category: surface.category,
    resolved_source_paths: Object.freeze([
      ...deriveResolvedDependencySourcePathsForFile(
        surfaceFilePath,
        validationSurfaceRoot,
        aliasMappings,
        {
          resolvedDependencyGraphCache,
          resolvedExportTargetCache,
        },
      ),
    ].sort()),
    relative_path: surface.relative_path,
    signal: `selected-${surface.category.replace(/_/g, "-")}-surface-resolved-dependency-overlap`,
  });
}

function getSelectedServerRuntimeSupportSurfaces(surfaces) {
  return surfaces.filter((surface) =>
    surface.category === "server_route"
    || surface.category === "prehandler"
    || surface.category === "server_plugin");
}

function deriveSelectedServerSurfaceGraphHints(
  selectedSurfaces,
  validationSurfaceRoot,
  {
    aliasMappings = [],
    resolvedDependencyGraphCache = new Map(),
    resolvedExportTargetCache = new Map(),
  } = {},
) {
  return selectedSurfaces
    .map((surface) => deriveSelectedSurfaceGraphHint(
      surface,
      aliasMappings,
      validationSurfaceRoot,
      {
        resolvedDependencyGraphCache,
        resolvedExportTargetCache,
      },
    ))
    .filter(Boolean);
}

function scoreSourceViewCandidate(candidate) {
  const signals = [];
  const content = readTextFileSafe(candidate.absolute_path);
  const uiKeywordCount = countPatternMatches(
    `${candidate.relative_path}\n${content}`,
    /component|view|render|props|state|fetch/gi,
  );
  let score = 0;

  score += addScoreSignal(
    signals,
    /^src\/.+\/(?:components|views)\/[^/]+\/index\.(ts|tsx|js|jsx)$/i.test(candidate.relative_path),
    120,
    "ui-entrypoint",
  );
  score += addScoreSignal(signals, candidate.relative_path.endsWith(".tsx"), 30, "tsx-view");
  score += addScoreSignal(signals, /\/(?:components|views)\//i.test(candidate.relative_path), 80, "ui-surface-path");
  score += addScoreSignal(signals, /export\s+default|function\s+[A-Z]|const\s+[A-Z]/.test(content), 60, "component-export");
  score += addScoreSignal(signals, /render|props|state|fetch|use[A-Z]/.test(content), 40, "ui-behavior");
  score += addScoreSignal(signals, uiKeywordCount > 0, Math.min(uiKeywordCount * 5, 50), "ui-keyword-density");
  score += addScoreSignal(signals, isIgnoredSourceLikePath(candidate.relative_path), -120, "ignored-source-path-penalty");

  return Object.freeze({
    category: "source_view",
    relative_path: candidate.relative_path,
    score,
    signals: Object.freeze(signals),
  });
}

function scoreSourceApiCandidate(candidate) {
  const signals = [];
  const content = readTextFileSafe(candidate.absolute_path);
  const apiKeywordCount = countPatternMatches(
    `${candidate.relative_path}\n${content}`,
    /api|fetch|request|response|headers|body|params|query/gi,
  );
  let score = 0;

  score += addScoreSignal(
    signals,
    /^src\/.+\/api\/[^/]+\/index\.(ts|tsx|js|jsx)$/i.test(candidate.relative_path),
    120,
    "api-entrypoint",
  );
  score += addScoreSignal(signals, candidate.relative_path.endsWith(".ts"), 20, "ts-api");
  score += addScoreSignal(signals, /\/api\//i.test(candidate.relative_path), 80, "api-surface-path");
  score += addScoreSignal(signals, /fetch\(|axios\.|http\(/i.test(content), 70, "http-client-call");
  score += addScoreSignal(signals, /['"]\/[a-z0-9/_-]+['"]/i.test(content), 50, "endpoint-literal");
  score += addScoreSignal(
    signals,
    /headers|body|params|query|token/i.test(content),
    40,
    "request-shape",
  );
  score += addScoreSignal(
    signals,
    apiKeywordCount > 0,
    Math.min(apiKeywordCount * 5, 30),
    "api-keyword-density",
  );
  score += addScoreSignal(signals, isIgnoredSourceLikePath(candidate.relative_path), -120, "ignored-source-path-penalty");

  return Object.freeze({
    category: "source_api",
    relative_path: candidate.relative_path,
    score,
    signals: Object.freeze(signals),
  });
}

function scoreServerRouteCandidate(candidate) {
  const signals = [];
  const content = readTextFileSafe(candidate.absolute_path);
  let score = 0;

  score += addScoreSignal(
    signals,
    candidate.relative_path === "src/server/routes/index.ts"
      || candidate.relative_path === "src/server/routes/index.tsx",
    140,
    "routes-entrypoint",
  );
  score += addScoreSignal(signals, /\/routes\//i.test(candidate.relative_path), 90, "routes-path");
  score += addScoreSignal(signals, candidate.relative_path === "src/server/index.ts", 30, "server-bootstrap-path");
  score += addScoreSignal(signals, /server\.route\(/i.test(content), 80, "hapi-route-registration");
  score += addScoreSignal(
    signals,
    /method\s*:|path\s*:|handler\s*:|options\s*:/i.test(content),
    60,
    "route-definition-shape",
  );
  score += addScoreSignal(
    signals,
    /\bpre\s*:|preHandler|prehandler/i.test(content),
    40,
    "route-prehandlers",
  );
  score += addScoreSignal(signals, /routes\.init\(/i.test(content), 40, "routes-bootstrap-content");
  score += addScoreSignal(signals, /@hapi\/hapi|Hapi\.Server/i.test(content), 20, "hapi-server-contract");
  score += addScoreSignal(signals, isIgnoredSourceLikePath(candidate.relative_path), -120, "ignored-source-path-penalty");

  return Object.freeze({
    category: "server_route",
    relative_path: candidate.relative_path,
    score,
    signals: Object.freeze(signals),
  });
}

function scorePrehandlerCandidate(candidate) {
  const signals = [];
  const content = readTextFileSafe(candidate.absolute_path);
  let score = 0;

  score += addScoreSignal(signals, /\/prehandlers\//i.test(candidate.relative_path), 90, "prehandlers-path");
  score += addScoreSignal(signals, /\/handlers\/[^/]+\.(ts|tsx|js|jsx)$/i.test(candidate.relative_path), 80, "prehandler-implementation-path");
  score += addScoreSignal(signals, /h\.redirect\(/i.test(content), 80, "redirect-toolkit-usage");
  score += addScoreSignal(signals, /h\.continue|return\s+next|done\(/i.test(content), 60, "request-continuation");
  score += addScoreSignal(signals, /request|headers|searchParams|query/i.test(content), 40, "request-context-access");
  score += addScoreSignal(
    signals,
    /assign|request\.pre|\bpre\s*:/i.test(content),
    30,
    "prehandler-pipeline-content",
  );
  score += addScoreSignal(signals, isIgnoredSourceLikePath(candidate.relative_path), -120, "ignored-source-path-penalty");

  return Object.freeze({
    category: "prehandler",
    relative_path: candidate.relative_path,
    score,
    signals: Object.freeze(signals),
  });
}

function scoreServerPluginCandidate(candidate) {
  const signals = [];
  const content = readTextFileSafe(candidate.absolute_path);
  let score = 0;

  score += addScoreSignal(signals, /\/plugins\//i.test(candidate.relative_path), 90, "plugins-path");
  score += addScoreSignal(signals, /\/plugins\/[^/]+\/index\.(ts|tsx|js|jsx)$/i.test(candidate.relative_path), 80, "plugin-entrypoint");
  score += addScoreSignal(signals, /register:\s*async function|register:\s*function/i.test(content), 60, "hapi-plugin-register");
  score += addScoreSignal(
    signals,
    /renderToString|renderToPipeableStream|server\.decorate\(['"]handler['"]/i.test(content),
    60,
    "rendering-surface",
  );
  score += addScoreSignal(
    signals,
    /server\.register|server\.decorate|server\.expose|server\.method/i.test(content),
    40,
    "plugin-wiring-surface",
  );
  score += addScoreSignal(signals, /name:\s*'[^']+'|version:\s*'[^']+'/i.test(content), 20, "plugin-contract-shape");
  score += addScoreSignal(signals, isIgnoredSourceLikePath(candidate.relative_path), -120, "ignored-source-path-penalty");

  return Object.freeze({
    category: "server_plugin",
    relative_path: candidate.relative_path,
    score,
    signals: Object.freeze(signals),
  });
}

function scoreServerRuntimeCandidate(
  candidate,
  {
    aliasMappings = [],
    representedFamilies = new Set(),
    resolvedDependencyGraphCache = new Map(),
    resolvedExportTargetCache = new Map(),
    selectedServerSurfaces = [],
    validationSurfaceRoot,
  } = {},
) {
  const signals = [];
  const content = readTextFileSafe(candidate.absolute_path);
  const runtimeFamily = inferServerRuntimeFamily(candidate.relative_path);
  const candidateGraph = Object.freeze({
    resolved_source_paths: deriveResolvedDependencySourcePathsForFile(
      candidate.absolute_path,
      validationSurfaceRoot,
      aliasMappings,
      {
        resolvedDependencyGraphCache,
        resolvedExportTargetCache,
      },
    ),
  });
  const selectedSurfaceGraphHints = deriveSelectedServerSurfaceGraphHints(
    selectedServerSurfaces,
    validationSurfaceRoot,
    {
      aliasMappings,
      resolvedDependencyGraphCache,
      resolvedExportTargetCache,
    },
  );
  const overlappedSelectedSurfaceCategories = [];
  let score = 0;

  score += addScoreSignal(signals, /^src\/server\/.+\.(ts|tsx|js|jsx)$/i.test(candidate.relative_path), 120, "server-runtime-path");
  score += addScoreSignal(signals, /\/plugins\//i.test(candidate.relative_path), 80, "plugin-runtime-family");
  score += addScoreSignal(signals, /\/routes\//i.test(candidate.relative_path), 70, "route-runtime-family");
  score += addScoreSignal(signals, /\/prehandlers\//i.test(candidate.relative_path), 60, "prehandler-runtime-family");
  score += addScoreSignal(signals, runtimeFamily === "bootstrap", 50, "bootstrap-runtime-family");
  for (const graphHint of selectedSurfaceGraphHints) {
    if (graphHint.relative_path === candidate.relative_path) {
      continue;
    }

    const hasGraphOverlap = graphHint.resolved_source_paths
      .some((entry) => candidateGraph.resolved_source_paths.has(entry));

    if (hasGraphOverlap) {
      overlappedSelectedSurfaceCategories.push(graphHint.category);
      score += addScoreSignal(signals, true, 55, graphHint.signal);
    }
  }

  score += addScoreSignal(
    signals,
    overlappedSelectedSurfaceCategories.length > 1,
    Math.min((overlappedSelectedSurfaceCategories.length - 1) * 35, 70),
    "selected-surface-resolved-dependency-coverage",
  );
  score += addScoreSignal(
    signals,
    /register:\s*async function|register:\s*function/i.test(content),
    50,
    "plugin-register-contract",
  );
  score += addScoreSignal(
    signals,
    /renderToString|renderToPipeableStream|render[A-Z][A-Za-z0-9_]*\(/.test(content),
    80,
    "render-runtime-surface",
  );
  score += addScoreSignal(signals, /server\.route\(/i.test(content), 40, "route-registration-runtime");
  score += addScoreSignal(signals, /h\.redirect\(/i.test(content), 35, "redirect-runtime");
  score += addScoreSignal(
    signals,
    /server\.register|server\.decorate|server\.expose|server\.method|server\.auth\./i.test(content),
    40,
    "server-wiring-runtime",
  );
  score += addScoreSignal(
    signals,
    /new Hapi\.Server|routes\.init\(|server\.start\(|server\.initialize\(|plugins?\.init\(|createServer/i.test(content),
    50,
    "bootstrap-runtime-content",
  );
  score += addScoreSignal(
    signals,
    runtimeFamily !== "unknown" && !representedFamilies.has(runtimeFamily) && overlappedSelectedSurfaceCategories.length > 0,
    Math.min(overlappedSelectedSurfaceCategories.length * 35, 105),
    "selected-surface-resolved-dependency-bridge",
  );
  score += addScoreSignal(
    signals,
    /route|plugin|prehandler|middleware|render/i.test(content),
    25,
    "server-runtime-keywords",
  );
  score += addScoreSignal(signals, /@hapi\/hapi|Hapi\.Server/i.test(content), 20, "hapi-runtime-contract");
  score += addScoreSignal(
    signals,
    runtimeFamily !== "unknown" && !representedFamilies.has(runtimeFamily),
    90,
    "unrepresented-runtime-family",
  );
  score += addScoreSignal(
    signals,
    representedFamilies.has(runtimeFamily),
    -220,
    "represented-runtime-family-penalty",
  );
  score += addScoreSignal(signals, isIgnoredSourceLikePath(candidate.relative_path), -120, "ignored-source-path-penalty");

  return Object.freeze({
    category: "server_runtime",
    relative_path: candidate.relative_path,
    score,
    signals: Object.freeze(signals),
  });
}

function createSelectedSurfaceFromCandidates({
  candidates,
  category,
  selectionContext = null,
  validationSurfaceRoot,
}) {
  if (candidates.length === 0) {
    return null;
  }

  const sortedCandidates = sortCandidates(candidates);
  const selectedCandidate = sortedCandidates[0];

  return createDiscoveredSurface({
    candidateCount: sortedCandidates.length,
    category,
    relativePath: selectedCandidate.relative_path,
    score: selectedCandidate.score,
    selectionReason:
      `selected ${selectedCandidate.relative_path} as top-ranked ${category} candidate `
      + `(${selectedCandidate.score})`
      + (selectionContext ? ` after ${selectionContext}` : ""),
    selectionSignals: selectedCandidate.signals,
    validationSurfaceRoot,
  });
}

function discoverDocumentationSurface(validationSurfaceRoot) {
  const candidates = collectHostFileCandidates(
    validationSurfaceRoot,
    (entry) => /^README(?:[-.].+)?\.md$/i.test(path.basename(entry.relative_path)),
  ).map(scoreDocumentationCandidate);

  return createSelectedSurfaceFromCandidates({
    candidates,
    category: "documentation",
    validationSurfaceRoot,
  });
}

function discoverPackageManifestSurface(validationSurfaceRoot) {
  const candidates = collectHostFileCandidates(
    validationSurfaceRoot,
    (entry) => path.basename(entry.relative_path) === "package.json",
  ).map(scorePackageManifestCandidate);

  return createSelectedSurfaceFromCandidates({
    candidates,
    category: "package_manifest",
    validationSurfaceRoot,
  });
}

function discoverPlaywrightConfigSurface(validationSurfaceRoot) {
  const candidates = collectHostFileCandidates(
    validationSurfaceRoot,
    (entry) => /^playwright\.config\.(ts|js|mjs|cjs)$/i.test(path.basename(entry.relative_path)),
  ).map(scorePlaywrightConfigCandidate);

  return createSelectedSurfaceFromCandidates({
    candidates,
    category: "playwright_config",
    validationSurfaceRoot,
  });
}

function discoverSourceViewSurface(validationSurfaceRoot) {
  const candidates = collectHostFileCandidates(
    validationSurfaceRoot,
    (entry) => /^src\/.+\/index\.(ts|tsx|js|jsx)$/i.test(entry.relative_path)
      && !isIgnoredSourceLikePath(entry.relative_path)
      && /\/(?:components|views)\//i.test(entry.relative_path),
  ).map(scoreSourceViewCandidate)
    .filter((candidate) => candidate.score > 0);

  return createSelectedSurfaceFromCandidates({
    candidates,
    category: "source_view",
    validationSurfaceRoot,
  });
}

function discoverSourceApiSurface(validationSurfaceRoot) {
  const candidates = collectHostFileCandidates(
    validationSurfaceRoot,
    (entry) => /^src\/.+\/api\/[^/]+\/index\.(ts|tsx|js|jsx)$/i.test(entry.relative_path)
      && !isIgnoredSourceLikePath(entry.relative_path),
  ).map(scoreSourceApiCandidate)
    .filter((candidate) => candidate.score > 0);

  return createSelectedSurfaceFromCandidates({
    candidates,
    category: "source_api",
    validationSurfaceRoot,
  });
}

function discoverServerRouteSurface(validationSurfaceRoot) {
  const candidates = collectHostFileCandidates(
    validationSurfaceRoot,
    (entry) => /^src\/server\/.+\.(ts|tsx|js|jsx)$/i.test(entry.relative_path)
      && !isIgnoredSourceLikePath(entry.relative_path),
  ).map(scoreServerRouteCandidate)
    .filter((candidate) => candidate.score > 0);

  return createSelectedSurfaceFromCandidates({
    candidates,
    category: "server_route",
    validationSurfaceRoot,
  });
}

function discoverPrehandlerSurface(validationSurfaceRoot) {
  const candidates = collectHostFileCandidates(
    validationSurfaceRoot,
    (entry) => /^src\/server\/prehandlers\/.+\.(ts|tsx|js|jsx)$/i.test(entry.relative_path)
      && !isIgnoredSourceLikePath(entry.relative_path),
  ).map(scorePrehandlerCandidate)
    .filter((candidate) => candidate.score > 0);

  return createSelectedSurfaceFromCandidates({
    candidates,
    category: "prehandler",
    validationSurfaceRoot,
  });
}

function discoverServerPluginSurface(validationSurfaceRoot) {
  const candidates = collectHostFileCandidates(
    validationSurfaceRoot,
    (entry) => /^src\/server\/plugins\/[^/]+\/index\.(ts|tsx|js|jsx)$/i.test(entry.relative_path)
      && !isIgnoredSourceLikePath(entry.relative_path),
  ).map(scoreServerPluginCandidate)
    .filter((candidate) => candidate.score > 0);

  return createSelectedSurfaceFromCandidates({
    candidates,
    category: "server_plugin",
    validationSurfaceRoot,
  });
}

function discoverServerRuntimeSurface(
  validationSurfaceRoot,
  {
    representedFamilies = new Set(),
    selectedServerSurfaces = [],
  } = {},
) {
  const aliasMappings = loadServerAliasMappings(validationSurfaceRoot);
  const resolvedDependencyGraphCache = new Map();
  const resolvedExportTargetCache = new Map();
  const candidates = collectHostFileCandidates(
    validationSurfaceRoot,
    (entry) => /^src\/server\/.+\.(ts|tsx|js|jsx)$/i.test(entry.relative_path)
      && !isIgnoredSourceLikePath(entry.relative_path),
  ).map((entry) => scoreServerRuntimeCandidate(entry, {
    aliasMappings,
    representedFamilies,
    resolvedDependencyGraphCache,
    resolvedExportTargetCache,
    selectedServerSurfaces,
    validationSurfaceRoot,
  }))
    .filter((candidate) => candidate.score > 0);

  return createSelectedSurfaceFromCandidates({
    candidates,
    category: "server_runtime",
    selectionContext: representedFamilies.size > 0
      ? `ranking by runtime evidence and selected-surface resolved dependency overlap while preferring unrepresented server families over ${[...representedFamilies].sort().join(", ")}`
      : null,
    validationSurfaceRoot,
  });
}

function countSpecFiles(rootPath) {
  return collectSpecCandidates(rootPath).length;
}

function scoreTestDirectoryCandidate(candidate, validationSurfaceRoot) {
  const signals = [];
  const absolutePath = path.join(validationSurfaceRoot, candidate.relative_path);
  const specCount = countSpecFiles(absolutePath);
  let score = 0;

  score += addScoreSignal(signals, path.basename(candidate.relative_path) === "e2e", 100, "e2e-directory-name");
  score += addScoreSignal(signals, pathDepth(candidate.relative_path) === 0, 30, "top-level-test-directory");
  score += addScoreSignal(signals, specCount > 0, Math.min(specCount * 20, 60), "spec-count");

  return Object.freeze({
    category: "test_directory",
    relative_path: candidate.relative_path,
    score,
    signals: Object.freeze(signals),
  });
}

function discoverTestDirectorySurface(validationSurfaceRoot) {
  const candidates = collectHostDirectoryCandidates(
    validationSurfaceRoot,
    (entry) => TEST_DIRECTORY_CANDIDATES.includes(path.basename(entry.relative_path)),
  ).map((entry) => scoreTestDirectoryCandidate(entry, validationSurfaceRoot));

  return createSelectedSurfaceFromCandidates({
    candidates,
    category: "test_directory",
    validationSurfaceRoot,
  });
}

function collectSpecCandidates(rootPath, currentRelativePath = "") {
  const entries = fs.readdirSync(rootPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const matches = [];

  for (const entry of entries) {
    const relativePath = currentRelativePath
      ? path.posix.join(currentRelativePath, entry.name)
      : entry.name;
    const absolutePath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      matches.push(...collectSpecCandidates(absolutePath, relativePath));
      continue;
    }

    if (/\.(spec|test)\.[a-z0-9]+$/i.test(entry.name)) {
      matches.push(relativePath);
    }
  }

  return matches;
}

function scoreTestSpecCandidate(relativePath, absolutePath) {
  const signals = [];
  const content = readTextFileSafe(absolutePath);
  let score = 0;

  score += addScoreSignal(signals, /page\.goto|page\.(?:click|fill)|request\./i.test(content), 60, "concrete-browser-actions");
  score += addScoreSignal(signals, /expect\(/i.test(content), 40, "explicit-assertions");
  score += addScoreSignal(signals, /test\.describe|describe\(/i.test(content), 20, "structured-test-suite");
  score += addScoreSignal(signals, /seed/i.test(relativePath), -40, "seed-spec-penalty");
  score += addScoreSignal(signals, /generate code here/i.test(content), -30, "placeholder-content-penalty");

  return Object.freeze({
    category: "test_spec",
    relative_path: relativePath,
    score,
    signals: Object.freeze(signals),
  });
}

function discoverTestSpecSurface(validationSurfaceRoot, testDirectorySurface) {
  const searchRoots = testDirectorySurface
    ? [testDirectorySurface.relative_path]
    : TEST_DIRECTORY_CANDIDATES.filter((relativePath) =>
      pathExistsAsDirectory(path.join(validationSurfaceRoot, relativePath)));

  for (const relativeRoot of searchRoots) {
    const absoluteRoot = path.join(validationSurfaceRoot, relativeRoot);
    const specCandidates = collectSpecCandidates(absoluteRoot, relativeRoot);

    if (specCandidates.length > 0) {
      const scoredCandidates = specCandidates.map((relativePath) =>
        scoreTestSpecCandidate(relativePath, path.join(validationSurfaceRoot, relativePath)));

      return createSelectedSurfaceFromCandidates({
        candidates: scoredCandidates,
        category: "test_spec",
        validationSurfaceRoot,
      });
    }
  }

  return null;
}

function resolveSurfacePaths(validationSurfaceRoot) {
  const preferredSurfaces = [];

  for (const category of DISCOVERY_CATEGORIES) {
    let discoveredSurface = null;

    switch (category) {
      case "documentation":
        discoveredSurface = discoverDocumentationSurface(validationSurfaceRoot);
        break;
      case "package_manifest":
        discoveredSurface = discoverPackageManifestSurface(validationSurfaceRoot);
        break;
      case "playwright_config":
        discoveredSurface = discoverPlaywrightConfigSurface(validationSurfaceRoot);
        break;
      case "source_view":
        discoveredSurface = discoverSourceViewSurface(validationSurfaceRoot);
        break;
      case "source_api":
        discoveredSurface = discoverSourceApiSurface(validationSurfaceRoot);
        break;
      case "server_route":
        discoveredSurface = discoverServerRouteSurface(validationSurfaceRoot);
        break;
      case "prehandler":
        discoveredSurface = discoverPrehandlerSurface(validationSurfaceRoot);
        break;
      case "server_plugin":
        discoveredSurface = discoverServerPluginSurface(validationSurfaceRoot);
        break;
      case "server_runtime":
        {
          const selectedServerSurfaces = getSelectedServerRuntimeSupportSurfaces(preferredSurfaces);
        discoveredSurface = discoverServerRuntimeSurface(
          validationSurfaceRoot,
          {
            representedFamilies: new Set(
              selectedServerSurfaces
                .map((surface) => inferServerRuntimeFamily(surface.relative_path))
                .filter((family) => family === "route" || family === "prehandler" || family === "plugin"),
            ),
            selectedServerSurfaces,
          },
        );
        break;
        }
      default:
        discoveredSurface = null;
        break;
    }

    if (discoveredSurface) {
      preferredSurfaces.push(discoveredSurface);
    }
  }

  const testDirectorySurface = discoverTestDirectorySurface(validationSurfaceRoot);
  const testSpecSurface = discoverTestSpecSurface(validationSurfaceRoot, testDirectorySurface);

  return [
    ...preferredSurfaces,
    ...(testDirectorySurface ? [testDirectorySurface] : []),
    ...(testSpecSurface ? [testSpecSurface] : []),
  ];
}

function createSummaryArtifacts(workspaceRoot) {
  const proofRoot = path.join(workspaceRoot, ".niis", "proofs", "adversarial-host-surfaces");
  return Object.freeze({
    summary: path.join(proofRoot, "summary.json"),
  });
}

function runAdversarialHostSurfacesProof({
  workspaceRoot = process.cwd(),
  validationSurfaceRoot = workspaceRoot,
  cliEntrypoint = null,
} = {}) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedValidationSurfaceRoot = path.resolve(validationSurfaceRoot);
  const resolvedSurfacePaths = resolveSurfacePaths(normalizedValidationSurfaceRoot);

  if (resolvedSurfacePaths.length === 0) {
    throw new AdversarialHostSurfacesProofError(
      `no supported host surfaces found under ${normalizedValidationSurfaceRoot}`,
    );
  }

  const surfaceResults = resolvedSurfacePaths.map((entry) => {
    const proofLabel = entry.relative_path
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const result = runAdversarialActivationProof({
      cliEntrypoint,
      proofLabel,
      sourcePath: entry.relative_path,
      validationSurfaceRoot: normalizedValidationSurfaceRoot,
      workspaceRoot: normalizedWorkspaceRoot,
    });

    return Object.freeze({
      activation_allowed: result.activation_allowed,
      candidate_count: entry.candidate_count,
      category: entry.category,
      final_activation_status: result.final_activation_status,
      final_verdict: result.final_verdict,
      import_final_review_status: result.import_final_review_status,
      ok: result.ok,
      proof_label: result.proof_label,
      selection_reason: entry.selection_reason,
      selection_score: entry.score,
      selection_signals: entry.selection_signals,
      source_path: result.source_path,
    });
  });

  const summaryArtifacts = createSummaryArtifacts(normalizedWorkspaceRoot);
  const allOk = surfaceResults.every((entry) => entry.ok);
  const result = {
    all_ok: allOk,
    artifacts: summaryArtifacts,
    cli_entrypoint: cliEntrypoint,
    surface_count: surfaceResults.length,
    surface_results: surfaceResults,
    validation_surface_root: normalizedValidationSurfaceRoot,
    workspace_root: normalizedWorkspaceRoot,
  };
  writeJson(summaryArtifacts.summary, result);

  if (!allOk) {
    throw new AdversarialHostSurfacesProofError(
      "adversarial host-surfaces proof failed; inspect per-surface results",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const validationSurfaceRoot = (() => {
      const flagValue = resolveFlagValue(process.argv, "--validation-surface-root");
      return flagValue === null ? process.cwd() : path.resolve(process.cwd(), flagValue);
    })();

    console.log(JSON.stringify(runAdversarialHostSurfacesProof({
      validationSurfaceRoot,
    }), null, 2));
  } catch (error) {
    if (error instanceof AdversarialHostSurfacesProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  AdversarialHostSurfacesProofError,
  runAdversarialHostSurfacesProof,
};
