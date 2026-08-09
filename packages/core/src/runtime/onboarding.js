import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  createBootstrapPack,
  createCodemapArtifact,
  createProjectProfile,
  createProjectRegistryEntry,
  createReferenceSeedModel,
  createScaffoldPlan,
  createWorkflowManifest,
  renderProjectProfileMarkdown,
  renderWorkflowMarkdown,
} from "../contracts/onboarding.js";
import { DEFAULT_REDACTION_POLICY, redactString, redactValue } from "../policy/redaction.js";
import { collectDoctorChecks, createAttachPlan, createInitPlan } from "./bootstrap-surface.js";
import { readInstallState } from "./install-state.js";
import { WORKSPACE_SOURCE_PRIORITIES } from "./workspace.js";

class OnboardingRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "OnboardingRuntimeError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OnboardingRuntimeError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".niis",
  ".cursor",
  "node_modules",
  "build",
  "dist",
  "coverage",
  ".next",
  ".turbo",
]);

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".swift",
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt"]);
const MANIFEST_FILENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "playwright.config.ts",
  "playwright.config.js",
  "jest.config.js",
  "jest.config.ts",
  "webpack.config.js",
  "webpack.config.ts",
  "vite.config.ts",
  "vite.config.js",
  "Jenkinsfile",
]);

const DETECTION_RULES = Object.freeze([
  { category: "language", value: "typescript", markers: ["tsconfig.json"], extensions: [".ts", ".tsx"] },
  { category: "language", value: "javascript", markers: ["package.json"], extensions: [".js", ".jsx", ".mjs", ".cjs"] },
  { category: "language", value: "python", markers: ["pyproject.toml"], extensions: [".py"] },
  { category: "language", value: "rust", markers: ["Cargo.toml"], extensions: [".rs"] },
  { category: "language", value: "go", markers: ["go.mod"], extensions: [".go"] },
  { category: "framework", value: "react", dependencies: ["react"] },
  { category: "framework", value: "hapi", dependencies: ["@hapi/hapi"] },
  { category: "framework", value: "nextjs", dependencies: ["next"] },
  { category: "framework", value: "express", dependencies: ["express"] },
  { category: "build_system", value: "webpack", dependencies: ["webpack"], markers: ["webpack.config.js", "webpack.config.ts"] },
  { category: "build_system", value: "vite", dependencies: ["vite"], markers: ["vite.config.ts", "vite.config.js"] },
  { category: "build_system", value: "npm", markers: ["package.json"] },
  { category: "test_framework", value: "jest", dependencies: ["jest"], markers: ["jest.config.js", "jest.config.ts"] },
  { category: "test_framework", value: "playwright", dependencies: ["@playwright/test"], markers: ["playwright.config.ts", "playwright.config.js"] },
]);

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function sanitizeProjectId(value) {
  const normalizedValue = path.basename(value).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return normalizedValue.replace(/^-+|-+$/g, "") || "project";
}

function listRepositoryFiles(rootDirectory) {
  const files = [];

  function visit(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".gitignore" && entry.name !== ".github") {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
      }

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }

        visit(path.join(directoryPath, entry.name));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = toPosixPath(path.relative(rootDirectory, absolutePath));
      const stats = fs.statSync(absolutePath);

      files.push({
        absolute_path: absolutePath,
        extension: path.extname(entry.name),
        name: entry.name,
        relative_path: relativePath,
        size_bytes: stats.size,
        updated_at_ms: stats.mtimeMs,
      });
    }
  }

  visit(rootDirectory);
  return files.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

function classifyFileKind(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  const baseName = path.posix.basename(normalizedPath);
  const extension = path.posix.extname(normalizedPath);

  if (DOC_EXTENSIONS.has(extension) || baseName.toLowerCase().startsWith("readme")) {
    return "documentation";
  }

  if (MANIFEST_FILENAMES.has(baseName)) {
    return "manifest";
  }

  if (SOURCE_EXTENSIONS.has(extension)) {
    return "source";
  }

  if (baseName === "Dockerfile" || normalizedPath.includes("/config/")) {
    return "config";
  }

  return "other";
}

function detectLanguageFromPath(relativePath) {
  const extension = path.posix.extname(relativePath);

  switch (extension) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    default:
      return null;
  }
}

function readJsonManifest(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function collectPackageDependencies(files) {
  const dependencies = new Set();
  const packageManifests = [];

  for (const file of files) {
    if (path.posix.basename(file.relative_path) !== "package.json") {
      continue;
    }

    const manifest = readJsonManifest(file.absolute_path);
    if (!manifest) {
      continue;
    }

    packageManifests.push({
      manifest,
      path: file.relative_path,
    });

    for (const dependencyGroup of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const dependencyName of Object.keys(manifest[dependencyGroup] ?? {})) {
        dependencies.add(dependencyName);
      }
    }
  }

  return {
    dependencies,
    packageManifests,
  };
}

function detectTechnologyProfile(files) {
  const detected = {
    build_systems: new Set(),
    classification_matrix: [],
    frameworks: new Set(),
    languages: new Set(),
    manifests: [],
    marker_evidence: [],
    test_frameworks: new Set(),
  };
  const fileSet = new Set(files.map((file) => path.posix.basename(file.relative_path)));
  const extensionSet = new Set(files.map((file) => file.extension));
  const { dependencies, packageManifests } = collectPackageDependencies(files);

  for (const packageManifest of packageManifests) {
    detected.manifests.push({
      kind: "package_manifest",
      path: packageManifest.path,
    });
  }

  for (const file of files) {
    if (classifyFileKind(file.relative_path) === "manifest" && path.posix.basename(file.relative_path) !== "package.json") {
      detected.manifests.push({
        kind: "config_manifest",
        path: file.relative_path,
      });
    }
  }

  for (const rule of DETECTION_RULES) {
    const markerMatch = (rule.markers ?? []).find((marker) => fileSet.has(marker));
    const dependencyMatch = (rule.dependencies ?? []).find((dependency) => dependencies.has(dependency));
    const extensionMatch = (rule.extensions ?? []).find((extension) => extensionSet.has(extension));

    if (!markerMatch && !dependencyMatch && !extensionMatch) {
      continue;
    }

    const evidence = markerMatch
      ? `marker file ${markerMatch}`
      : dependencyMatch
        ? `dependency ${dependencyMatch}`
        : `source extension ${extensionMatch}`;

    if (rule.category === "language") {
      detected.languages.add(rule.value);
    } else if (rule.category === "framework") {
      detected.frameworks.add(rule.value);
    } else if (rule.category === "build_system") {
      detected.build_systems.add(rule.value);
    } else if (rule.category === "test_framework") {
      detected.test_frameworks.add(rule.value);
    }

    detected.classification_matrix.push({
      category: rule.category,
      evidence,
      value: rule.value,
    });
    detected.marker_evidence.push({
      marker: markerMatch ?? dependencyMatch ?? extensionMatch,
      reason: `${rule.category} -> ${rule.value}`,
    });
  }

  if (detected.languages.size === 0 && packageManifests.length > 0) {
    detected.languages.add("javascript");
    detected.classification_matrix.push({
      category: "language",
      evidence: "package.json",
      value: "javascript",
    });
    detected.marker_evidence.push({
      marker: "package.json",
      reason: "language -> javascript fallback from package manifest",
    });
  }

  const primaryType = [...detected.frameworks][0] ?? [...detected.languages][0] ?? "unknown";

  return {
    build_systems: [...detected.build_systems].sort(),
    classification_matrix: detected.classification_matrix,
    frameworks: [...detected.frameworks].sort(),
    languages: [...detected.languages].sort(),
    manifests: detected.manifests.sort((left, right) => left.path.localeCompare(right.path)),
    marker_evidence: detected.marker_evidence,
    primary_type: primaryType,
    test_frameworks: [...detected.test_frameworks].sort(),
  };
}

function selectSurfaceFiles(files, segmentMatchers) {
  return files
    .filter((file) => segmentMatchers.some((matcher) => matcher.test(file.relative_path)))
    .slice(0, 20)
    .map((file) => ({
      path: file.relative_path,
      type: classifyFileKind(file.relative_path),
    }));
}

function collectValidationSurface(files) {
  return {
    plugins: selectSurfaceFiles(files, [/(^|\/)(plugin|plugins)(\/|$)/i]),
    routes: selectSurfaceFiles(files, [/(^|\/)(route|routes|api)(\/|$)/i]),
    services: selectSurfaceFiles(files, [/(^|\/)(service|services)(\/|$)/i]),
    templates: selectSurfaceFiles(files, [/(^|\/)(template|templates|views)(\/|$)/i]),
    total_files_indexed: files.length,
  };
}

function collectTopLevelRoots(files, kinds) {
  const roots = new Set();

  for (const file of files) {
    if (!kinds.includes(classifyFileKind(file.relative_path))) {
      continue;
    }

    const [rootSegment] = file.relative_path.split("/");
    if (rootSegment) {
      roots.add(rootSegment);
    }
  }

  return [...roots].sort();
}

function collectDocumentationStalenessCandidates(files) {
  const codeFiles = files.filter((file) => classifyFileKind(file.relative_path) === "source");
  const docFiles = files.filter((file) => classifyFileKind(file.relative_path) === "documentation");

  if (codeFiles.length === 0) {
    return [];
  }

  const latestCodeFile = codeFiles.reduce((latest, file) =>
    file.updated_at_ms > latest.updated_at_ms ? file : latest);
  const latestDocFile = docFiles.length > 0
    ? docFiles.reduce((latest, file) => file.updated_at_ms > latest.updated_at_ms ? file : latest)
    : null;

  if (!latestDocFile) {
    return [{
      id: "documentation-staleness:no-docs",
      reason: `Code exists (latest: ${latestCodeFile.relative_path}) but no documentation files were detected.`,
      title: "Create baseline documentation coverage candidates",
    }];
  }

  if (latestCodeFile.updated_at_ms <= latestDocFile.updated_at_ms) {
    return [];
  }

  return [{
    id: "documentation-staleness:recent-code",
    reason: `Latest code change (${latestCodeFile.relative_path}) is newer than latest documentation (${latestDocFile.relative_path}).`,
    title: "Review documentation freshness after recent code changes",
  }];
}

function collectTaskSources(files) {
  const backlogPaths = files
    .filter((file) => /(backlog|roadmap|todo|tasks?)/i.test(path.posix.basename(file.relative_path)))
    .map((file) => file.relative_path)
    .slice(0, 20);

  const documentationPaths = files
    .filter((file) => classifyFileKind(file.relative_path) === "documentation")
    .map((file) => file.relative_path)
    .slice(0, 40);

  return {
    backlog_paths: backlogPaths,
    code_roots: collectTopLevelRoots(files, ["source"]),
    declared_sources: [
      "backlog_file",
      "documentation_staleness",
      "repository_history",
      "workspace_profile",
    ],
    documentation_paths: documentationPaths,
    documentation_staleness_candidates: collectDocumentationStalenessCandidates(files),
  };
}

function runGitSummary(validationSurfaceRoot) {
  const countResult = spawnSync("git", ["rev-list", "--count", "HEAD"], {
    cwd: validationSurfaceRoot,
    encoding: "utf8",
  });
  const lastCommitResult = spawnSync("git", ["log", "-1", "--format=%cI"], {
    cwd: validationSurfaceRoot,
    encoding: "utf8",
  });
  const recentPathsResult = spawnSync("git", ["log", "-5", "--name-only", "--pretty=format:"], {
    cwd: validationSurfaceRoot,
    encoding: "utf8",
  });

  if (countResult.status !== 0 || lastCommitResult.status !== 0 || recentPathsResult.status !== 0) {
    return {
      available: false,
      last_commit_at: null,
      recent_paths: [],
      total_commits: 0,
    };
  }

  return {
    available: true,
    last_commit_at: lastCommitResult.stdout.trim() || null,
    recent_paths: [...new Set(
      recentPathsResult.stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
    )].slice(0, 20),
    total_commits: Number.parseInt(countResult.stdout.trim(), 10) || 0,
  };
}

function createContentHash(files) {
  const hash = createHash("sha256");

  for (const file of files) {
    hash.update(file.relative_path);
    hash.update("\0");
    hash.update(fs.readFileSync(file.absolute_path));
    hash.update("\0");
  }

  return hash.digest("hex");
}

function readCachedArtifact(cachePath, artifactType, expectedHash) {
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(cachePath, "utf8"));

    if (payload?.artifact_type !== artifactType) {
      return null;
    }

    if (payload?.content_hash !== expectedHash) {
      return null;
    }

    return payload.artifact ?? null;
  } catch {
    return null;
  }
}

function writeCachedArtifact(cachePath, artifactType, contentHash, artifact) {
  fs.writeFileSync(cachePath, `${JSON.stringify({
    artifact,
    artifact_type: artifactType,
    content_hash: contentHash,
    schema_version: 1,
  }, null, 2)}\n`);
}

function buildCodemap(files, validationSurfaceRoot, now, cacheRoot) {
  const inputFiles = files.filter((file) => ["documentation", "manifest", "source", "config"].includes(classifyFileKind(file.relative_path)));
  const contentHash = createContentHash(inputFiles);
  const cachePath = path.join(cacheRoot, "onboarding-codemap-cache.json");
  const cached = readCachedArtifact(cachePath, "codemap", contentHash);

  if (cached) {
    return {
      artifact: cached,
      cache: {
        content_hash: contentHash,
        hit: true,
        path: cachePath,
      },
    };
  }

  const artifact = createCodemapArtifact({
    contentHash,
    entries: inputFiles.slice(0, 250).map((file) => ({
      kind: classifyFileKind(file.relative_path),
      language: detectLanguageFromPath(file.relative_path),
      path: file.relative_path,
      size_bytes: file.size_bytes,
    })),
    generatedAt: now,
    root: validationSurfaceRoot,
    stats: {
      docs_count: files.filter((file) => classifyFileKind(file.relative_path) === "documentation").length,
      files_indexed: inputFiles.length,
      source_count: files.filter((file) => classifyFileKind(file.relative_path) === "source").length,
    },
  });

  writeCachedArtifact(cachePath, "codemap", contentHash, artifact);

  return {
    artifact,
    cache: {
      content_hash: contentHash,
      hit: false,
      path: cachePath,
    },
  };
}

function buildReferenceSeeds(files, now, cacheRoot) {
  const inputFiles = files.filter((file) => ["documentation", "manifest", "config"].includes(classifyFileKind(file.relative_path)));
  const contentHash = createContentHash(inputFiles);
  const cachePath = path.join(cacheRoot, "onboarding-reference-seeds-cache.json");
  const cached = readCachedArtifact(cachePath, "reference_seed_model", contentHash);

  if (cached) {
    return {
      artifact: cached,
      cache: {
        content_hash: contentHash,
        hit: true,
        path: cachePath,
      },
    };
  }

  const artifact = createReferenceSeedModel({
    contentHash,
    generatedAt: now,
    seeds: inputFiles.slice(0, 40).map((file, index) => ({
      id: `seed-${index + 1}`,
      kind: classifyFileKind(file.relative_path),
      path: file.relative_path,
      reason:
        classifyFileKind(file.relative_path) === "documentation"
          ? "documentation seed for initial execution context"
          : "manifest/config seed for project structure and execution context",
      title: path.posix.basename(file.relative_path),
    })),
  });

  writeCachedArtifact(cachePath, "reference_seed_model", contentHash, artifact);

  return {
    artifact,
    cache: {
      content_hash: contentHash,
      hit: false,
      path: cachePath,
    },
  };
}

function writeJsonArtifact(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(redactValue(value, DEFAULT_REDACTION_POLICY), null, 2)}\n`);
}

function writeMarkdownArtifact(filePath, value) {
  fs.writeFileSync(filePath, `${redactString(value, DEFAULT_REDACTION_POLICY)}\n`);
}

function readTextArtifact(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath, "utf8");
}

function readJsonArtifact(filePath) {
  const content = readTextArtifact(filePath);

  if (content === null) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMarkdownDecorators(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedValue = value
    .replaceAll(/`([^`]+)`/g, "$1")
    .replaceAll(/\*\*([^*]+)\*\*/g, "$1")
    .trim();

  if (normalizedValue === "" || normalizedValue === "_none_" || normalizedValue === "_unknown_") {
    return null;
  }

  return normalizedValue;
}

function parseMarkdownScalar(content, label) {
  if (typeof content !== "string" || content.trim() === "") {
    return null;
  }

  const match = content.match(new RegExp(`^- ${escapeRegex(label)}:\\s*(.+)$`, "m"));
  return stripMarkdownDecorators(match?.[1] ?? null);
}

function parseMarkdownList(value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("_none_")) {
    return [];
  }

  const backtickMatches = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean);

  if (backtickMatches.length > 0) {
    return [...new Set(backtickMatches)];
  }

  return [...new Set(
    value
      .split(",")
      .map((entry) => stripMarkdownDecorators(entry))
      .filter(Boolean),
  )];
}

function parseMarkdownListField(content, label) {
  const rawValue = parseMarkdownScalar(content, label);
  return rawValue ? parseMarkdownList(rawValue) : [];
}

function collectMarkdownSectionBullets(content, heading) {
  if (typeof content !== "string" || content.trim() === "") {
    return [];
  }

  const lines = content.split(/\r?\n/u);
  const collected = [];
  let insideSection = false;

  for (const line of lines) {
    if (line.trim() === heading) {
      insideSection = true;
      continue;
    }

    if (!insideSection) {
      continue;
    }

    if (line.startsWith("#") && line.trim() !== heading) {
      break;
    }

    if (line.startsWith("- ")) {
      const value = stripMarkdownDecorators(line.slice(2));
      if (value) {
        collected.push(value);
      }
    }
  }

  return collected;
}

function extractWorkflowSummary(content) {
  if (typeof content !== "string" || content.trim() === "") {
    return null;
  }

  const lines = content.split(/\r?\n/u);
  let afterHeading = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine === "# Workflow") {
      afterHeading = true;
      continue;
    }

    if (!afterHeading || trimmedLine === "") {
      continue;
    }

    if (trimmedLine.startsWith("#")) {
      break;
    }

    return trimmedLine;
  }

  return null;
}

function parseProjectProfileMarkdown(content) {
  if (typeof content !== "string" || content.trim() === "") {
    return null;
  }

  const indexedFiles = Number.parseInt(parseMarkdownScalar(content, "indexed files") ?? "0", 10);
  const documentationCandidates = collectMarkdownSectionBullets(content, "### Documentation Staleness Candidates");

  return Object.freeze({
    build_systems: Object.freeze(parseMarkdownListField(content, "build systems")),
    context_boundary: Object.freeze({
      cross_repo_promotion_required: parseMarkdownScalar(content, "cross-repo promotion required") === "true",
      project_root: parseMarkdownScalar(content, "project root"),
      scope: parseMarkdownScalar(content, "scope"),
    }),
    frameworks: Object.freeze(parseMarkdownListField(content, "frameworks")),
    languages: Object.freeze(parseMarkdownListField(content, "languages")),
    primary_type: parseMarkdownScalar(content, "primary type"),
    project_id: parseMarkdownScalar(content, "project id"),
    repo_root: parseMarkdownScalar(content, "repo root"),
    task_sources: Object.freeze({
      backlog_paths: Object.freeze(parseMarkdownListField(content, "backlog paths")),
      code_roots: Object.freeze(parseMarkdownListField(content, "code roots")),
      declared_sources: Object.freeze(parseMarkdownListField(content, "declared sources")),
      documentation_paths: Object.freeze(parseMarkdownListField(content, "documentation paths")),
      documentation_staleness_candidates: Object.freeze(documentationCandidates),
    }),
    test_frameworks: Object.freeze(parseMarkdownListField(content, "test frameworks")),
    validation_surface: Object.freeze({
      indexed_files: Number.isFinite(indexedFiles) ? indexedFiles : 0,
    }),
  });
}

function parseWorkflowMarkdown(content) {
  if (typeof content !== "string" || content.trim() === "") {
    return null;
  }

  return Object.freeze({
    summary: extractWorkflowSummary(content),
    task_source_types: Object.freeze(collectMarkdownSectionBullets(content, "## Task Sources")),
    workspace_strategy: Object.freeze({
      branch_template: parseMarkdownScalar(content, "branch template"),
      mode: parseMarkdownScalar(content, "mode"),
      provision_command: parseMarkdownScalar(content, "provision command"),
      workspace_source_priority: Object.freeze(parseMarkdownListField(content, "workspace source priority")),
    }),
  });
}

function summarizeCodemapArtifact(codemapArtifact) {
  if (!codemapArtifact || typeof codemapArtifact !== "object" || Array.isArray(codemapArtifact)) {
    return null;
  }

  const entries = Array.isArray(codemapArtifact.entries) ? codemapArtifact.entries : [];
  const languageCounts = new Map();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.language !== "string") {
      continue;
    }

    languageCounts.set(entry.language, (languageCounts.get(entry.language) ?? 0) + 1);
  }

  return Object.freeze({
    generated_at: typeof codemapArtifact.generated_at === "string" ? codemapArtifact.generated_at : null,
    language_breakdown: Object.freeze(
      [...languageCounts.entries()]
        .map(([language, files]) => Object.freeze({ files, language }))
        .sort((left, right) => {
          if (right.files !== left.files) {
            return right.files - left.files;
          }

          return left.language.localeCompare(right.language);
        }),
    ),
    root: typeof codemapArtifact.root === "string" ? codemapArtifact.root : null,
    stats: Object.freeze({
      docs_count: Number.isFinite(codemapArtifact.stats?.docs_count) ? codemapArtifact.stats.docs_count : 0,
      files_indexed: Number.isFinite(codemapArtifact.stats?.files_indexed) ? codemapArtifact.stats.files_indexed : 0,
      source_count: Number.isFinite(codemapArtifact.stats?.source_count) ? codemapArtifact.stats.source_count : 0,
    }),
  });
}

function summarizeInstallState(installStateArtifact) {
  if (!installStateArtifact || typeof installStateArtifact !== "object" || Array.isArray(installStateArtifact)) {
    return null;
  }

  return Object.freeze({
    commands: Object.freeze(Array.isArray(installStateArtifact.commands) ? [...installStateArtifact.commands] : []),
    entry_count: Array.isArray(installStateArtifact.entries) ? installStateArtifact.entries.length : 0,
    installed_at: typeof installStateArtifact.installed_at === "string" ? installStateArtifact.installed_at : null,
    status: typeof installStateArtifact.status === "string" ? installStateArtifact.status : null,
  });
}

function summarizeDoctorChecks(doctorChecks) {
  const checks = Array.isArray(doctorChecks) ? doctorChecks : [];
  const counts = {
    error: 0,
    ok: 0,
    warning: 0,
  };

  for (const check of checks) {
    if (check && typeof check.status === "string" && Object.hasOwn(counts, check.status)) {
      counts[check.status] += 1;
    }
  }

  const highlightOrder = [
    "install-state",
    "state-root",
    "runtime-dependency:better-sqlite3",
    "adapter-availability:codex_local",
    "adapter-availability:claude_code_local",
  ];
  const highlightIds = new Set();
  const highlights = [];

  for (const highlightId of highlightOrder) {
    const match = checks.find((check) => check?.id === highlightId);
    if (match) {
      highlightIds.add(match.id);
      highlights.push(Object.freeze({
        details: match.details,
        id: match.id,
        status: match.status,
        summary: match.summary,
      }));
    }
  }

  for (const check of checks) {
    if (!check || highlightIds.has(check.id) || check.status === "ok") {
      continue;
    }

    highlights.push(Object.freeze({
      details: check.details,
      id: check.id,
      status: check.status,
      summary: check.summary,
    }));
  }

  return Object.freeze({
    counts: Object.freeze(counts),
    highlights: Object.freeze(highlights),
    runtime_availability: Object.freeze(
      checks
        .filter((check) => typeof check?.id === "string" && check.id.startsWith("adapter-availability:"))
        .map((check) => Object.freeze({
          details: check.details,
          id: check.id.replace("adapter-availability:", ""),
          status: check.status,
          summary: check.summary,
        })),
    ),




    all_checks: Object.freeze(
      checks.map((check) => {
        const fullId = String(check?.id ?? "unknown");
        const sepIdx = fullId.indexOf(":");
        const kind = sepIdx > 0 ? fullId.slice(0, sepIdx) : fullId;
        const label = sepIdx > 0 ? fullId.slice(sepIdx + 1) : fullId;
        return Object.freeze({
          id: fullId,
          kind,
          label,
          status: check?.status ?? "unknown",
          summary: check?.summary ?? "",
          details: check?.details ?? "",
        });
      }),
    ),
  });
}

function loadAttachedProjectContext({
  packageRoot,
  workspaceRoot,
  validationSurfaceRoot = workspaceRoot,
} = {}) {
  const normalizedPackageRoot = path.resolve(ensureNonEmptyString(packageRoot, "packageRoot"));
  const normalizedWorkspaceRoot = path.resolve(ensureNonEmptyString(workspaceRoot, "workspaceRoot"));
  const normalizedValidationSurfaceRoot = path.resolve(
    ensureNonEmptyString(validationSurfaceRoot, "validationSurfaceRoot"),
  );
  const attachPlan = createAttachPlan(normalizedWorkspaceRoot, {
    validationSurfaceRoot: normalizedValidationSurfaceRoot,
  });
  const initPlan = createInitPlan(normalizedWorkspaceRoot);
  const projectProfilePath = path.join(attachPlan.exportsRoot, "project-profile.md");
  const workflowPath = path.join(attachPlan.exportsRoot, "workflow.md");
  const codemapPath = path.join(attachPlan.exportsRoot, "codemap.json");
  const attachment = readJsonArtifact(attachPlan.attachmentPath);
  const projectProfileMarkdown = readTextArtifact(projectProfilePath);
  const workflowMarkdown = readTextArtifact(workflowPath);
  const codemap = readJsonArtifact(codemapPath);
  const doctorChecks = collectDoctorChecks(normalizedPackageRoot, {
    workspaceRoot: normalizedWorkspaceRoot,
  });

  return Object.freeze({
    attachment,
    codemap: summarizeCodemapArtifact(codemap),
    codemapPath,
    doctor: summarizeDoctorChecks(doctorChecks),
    doctor_checks: Object.freeze(doctorChecks.map((check) => Object.freeze({ ...check }))),
    hasCodemap: codemap !== null,
    hasProjectProfile: projectProfileMarkdown !== null,
    hasWorkflow: workflowMarkdown !== null,
    install: summarizeInstallState(readInstallState(initPlan.installStatePath)),
    projectProfilePath,
    profile: parseProjectProfileMarkdown(projectProfileMarkdown),
    validationSurfaceRoot: attachment?.validation_surface_root ?? normalizedValidationSurfaceRoot,
    workflow: parseWorkflowMarkdown(workflowMarkdown),
    workflowPath,
  });
}

function updateProjectRegistry(registryPath, entry, now) {
  let registry = {
    projects: [],
    schema_version: 1,
    updated_at: null,
  };

  if (fs.existsSync(registryPath)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    } catch {
      registry = {
        projects: [],
        schema_version: 1,
        updated_at: null,
      };
    }
  }

  const filteredProjects = (Array.isArray(registry.projects) ? registry.projects : []).filter((projectEntry) =>
    projectEntry.project_id !== entry.project_id
    && projectEntry.validation_surface_root !== entry.validation_surface_root);

  const nextRegistry = {
    projects: [...filteredProjects, entry],
    schema_version: 1,
    updated_at: now,
  };

  writeJsonArtifact(registryPath, nextRegistry);
  return nextRegistry;
}

function generateOnboardingArtifacts({
  packageRoot,
  validationSurfaceRoot = packageRoot,
  now = new Date(),
}) {
  const attachPlan = createAttachPlan(packageRoot, {
    validationSurfaceRoot,
  });
  const timestamp = typeof now === "string" ? now : now.toISOString();
  const exportsRoot = attachPlan.exportsRoot ?? path.join(attachPlan.stateRoot, "exports");
  const cacheRoot = attachPlan.cacheRoot ?? path.join(attachPlan.stateRoot, "cache");
  const registryPath = attachPlan.registryPath ?? path.join(attachPlan.stateRoot, "registry.json");

  ensureDirectory(exportsRoot);
  ensureDirectory(cacheRoot);

  const files = listRepositoryFiles(attachPlan.validationSurfaceRoot);
  if (files.length === 0) {
    throw new OnboardingRuntimeError("validation surface is empty; cannot generate onboarding artifacts");
  }

  const projectId = sanitizeProjectId(attachPlan.validationSurfaceRoot);
  const technologyProfile = detectTechnologyProfile(files);
  const taskSources = collectTaskSources(files);
  const validationSurface = collectValidationSurface(files);
  const repositoryHistory = runGitSummary(attachPlan.validationSurfaceRoot);
  const workflowManifest = createWorkflowManifest({
    buildSystems: technologyProfile.build_systems,
    frameworks: technologyProfile.frameworks,
    generatedAt: timestamp,
    languages: technologyProfile.languages,
    primaryType: technologyProfile.primary_type,
    projectId,
    summary: "Reviewable workflow manifest generated from declarative marker-file and dependency detection.",
    taskSourceTypes: taskSources.declared_sources,
    testFrameworks: technologyProfile.test_frameworks,
    workspaceStrategy: {
      branch_template: "{{task.id}}-{{slug}}",
      mode: "worktree",
      provision_command: null,
      workspace_source_priority: WORKSPACE_SOURCE_PRIORITIES,
    },
  });
  const projectProfile = createProjectProfile({
    buildSystems: technologyProfile.build_systems,
    classificationMatrix: technologyProfile.classification_matrix,
    contextBoundary: {
      cross_repo_promotion_required: true,
      project_root: attachPlan.validationSurfaceRoot,
      scope: "project",
    },
    frameworks: technologyProfile.frameworks,
    generatedAt: timestamp,
    languages: technologyProfile.languages,
    manifests: technologyProfile.manifests,
    markerEvidence: technologyProfile.marker_evidence,
    primaryType: technologyProfile.primary_type,
    projectId,
    repoRoot: attachPlan.validationSurfaceRoot,
    repositoryHistory,
    taskSources,
    testFrameworks: technologyProfile.test_frameworks,
    validationSurface,
  });
  const codemap = buildCodemap(files, attachPlan.validationSurfaceRoot, timestamp, cacheRoot);
  const referenceSeeds = buildReferenceSeeds(files, timestamp, cacheRoot);
  const taskSourcesPath = path.join(exportsRoot, "task-sources.json");
  const projectProfilePath = path.join(exportsRoot, "project-profile.md");
  const workflowPath = path.join(exportsRoot, "workflow.md");
  const codemapPath = path.join(exportsRoot, "codemap.json");
  const referenceSeedsPath = path.join(exportsRoot, "reference-bundle-seeds.json");
  const bootstrapPackPath = path.join(exportsRoot, "bootstrap-pack.json");
  const scaffoldPlanPath = path.join(exportsRoot, "scaffold-plan.json");
  const registryEntry = createProjectRegistryEntry({
    attachedAt: timestamp,
    packageRoot,
    projectId,
    validationSurfaceRoot: attachPlan.validationSurfaceRoot,
  });
  const bootstrapPack = createBootstrapPack({
    artifacts: [
      { kind: "project_profile", path: projectProfilePath },
      { kind: "workflow_manifest", path: workflowPath },
      { kind: "codemap", path: codemapPath },
      { kind: "task_sources", path: taskSourcesPath },
      { kind: "reference_seed_model", path: referenceSeedsPath },
      { kind: "scaffold_plan", path: scaffoldPlanPath },
    ],
    generatedAt: timestamp,
    projectId,
  });
  const scaffoldPlan = createScaffoldPlan({
    generatedAt: timestamp,
    projectId,
    steps: [
      {
        action: "review_artifact",
        detail: "Review project-profile.md for classification, task sources, and context boundary accuracy.",
        id: "review-project-profile",
      },
      {
        action: "review_artifact",
        detail: "Review workflow.md before enabling any workspace, provisioning, or task-source behavior.",
        id: "review-workflow",
      },
      {
        action: "review_artifact",
        detail: "Inspect codemap and reference seeds; treat missing structure as an explicit gap, not silent guesswork.",
        id: "review-codemap-and-seeds",
      },
      {
        action: "manual_activation_only",
        detail: "No onboarding artifact activates rules or mutations automatically; operator review is required first.",
        id: "manual-activation",
      },
    ],
  });
  const attachment = {
    attached_at: timestamp,
    cache: {
      codemap: codemap.cache,
      reference_seeds: referenceSeeds.cache,
    },
    context_boundary: projectProfile.context_boundary,
    destructive: false,
    generated_artifacts: [
      projectProfilePath,
      workflowPath,
      taskSourcesPath,
      codemapPath,
      referenceSeedsPath,
      bootstrapPackPath,
      scaffoldPlanPath,
    ],
    mode: "REVIEWABLE_ONBOARDING_V1",
    package_root: attachPlan.packageRoot,
    project_id: projectId,
    reviewable: true,
    schema_version: 1,
    validation_surface_profile: {
      plugins: validationSurface.plugins.length,
      routes: validationSurface.routes.length,
      services: validationSurface.services.length,
      templates: validationSurface.templates.length,
      total_files_indexed: validationSurface.total_files_indexed,
    },
    validation_surface_root: attachPlan.validationSurfaceRoot,
  };

  writeMarkdownArtifact(projectProfilePath, renderProjectProfileMarkdown(projectProfile));
  writeMarkdownArtifact(workflowPath, renderWorkflowMarkdown(workflowManifest));
  writeJsonArtifact(taskSourcesPath, {
    generated_at: timestamp,
    project_id: projectId,
    reviewable: true,
    schema_version: 1,
    task_sources: taskSources,
  });
  writeJsonArtifact(codemapPath, codemap.artifact);
  writeJsonArtifact(referenceSeedsPath, referenceSeeds.artifact);
  writeJsonArtifact(bootstrapPackPath, bootstrapPack);
  writeJsonArtifact(scaffoldPlanPath, scaffoldPlan);
  writeJsonArtifact(attachPlan.attachmentPath, attachment);
  const registry = updateProjectRegistry(registryPath, registryEntry, timestamp);

  return {
    artifacts: {
      attachment: attachPlan.attachmentPath,
      bootstrap_pack: bootstrapPackPath,
      codemap: codemapPath,
      project_profile: projectProfilePath,
      reference_seed_model: referenceSeedsPath,
      scaffold_plan: scaffoldPlanPath,
      task_sources: taskSourcesPath,
      workflow: workflowPath,
    },
    attachment,
    bootstrap_pack: bootstrapPack,
    codemap: codemap.artifact,
    profile: projectProfile,
    reference_seed_model: referenceSeeds.artifact,
    registry,
    scaffold_plan: scaffoldPlan,
    workflow: workflowManifest,
  };
}

export {
  OnboardingRuntimeError,
  collectDocumentationStalenessCandidates,
  collectTaskSources,
  createContentHash,
  detectTechnologyProfile,
  generateOnboardingArtifacts,
  listRepositoryFiles,
  loadAttachedProjectContext,
};
