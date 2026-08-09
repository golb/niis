import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

class ExtractionProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "ExtractionProofError";
    this.result = result;
  }
}

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);
const TEXT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".json",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".sh",
  ".toml",
]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".cursor", ".niis"]);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isInside(root, candidatePath) {
  const relativePath = path.relative(root, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function listFiles(rootDirectory, predicate) {
  const files = [];

  function visit(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
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
      if (predicate(absolutePath)) {
        files.push(absolutePath);
      }
    }
  }

  visit(rootDirectory);
  return files.sort((left, right) => left.localeCompare(right));
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function collectRelativeImportViolations(workspaceRoot) {
  const files = listFiles(
    workspaceRoot,
    (filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath)),
  );
  const violations = [];
  const importPattern = /(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]|import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

  for (const filePath of files) {
    const content = readUtf8(filePath);

    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? null;
      if (!specifier || !specifier.startsWith(".")) {
        continue;
      }

      const resolvedPath = path.resolve(path.dirname(filePath), specifier);
      if (isInside(workspaceRoot, resolvedPath)) {
        continue;
      }

      violations.push({
        file: path.relative(workspaceRoot, filePath),
        resolved_path: resolvedPath,
        specifier,
      });
    }
  }

  return Object.freeze(violations);
}

function collectHostRepoReferences({
  hostRoot,
  workspaceRoot,
}) {
  const workspaceName = path.basename(workspaceRoot);
  const hostFiles = listFiles(
    hostRoot,
    (filePath) =>
      !isInside(workspaceRoot, filePath)
      && TEXT_EXTENSIONS.has(path.extname(filePath)),
  );
  const patterns = [
    new RegExp(`--prefix\\s+${escapeRegex(workspaceName)}\\b`),
    new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegex(workspaceName)}/`),
  ];
  const references = [];

  for (const filePath of hostFiles) {
    const content = readUtf8(filePath);
    const lines = content.split("\n");
    const matchedLines = [];

    for (let index = 0; index < lines.length; index += 1) {
      if (patterns.some((pattern) => pattern.test(lines[index]))) {
        matchedLines.push({
          line: index + 1,
          text: lines[index].trim(),
        });
      }
    }

    if (matchedLines.length === 0) {
      continue;
    }

    references.push({
      file: path.relative(hostRoot, filePath),
      matches: matchedLines,
    });
  }

  return Object.freeze(references);
}

function classifyHostReference(relativePath) {
  const normalizedPath = relativePath.split(path.sep).join("/");
  const extension = path.extname(normalizedPath).toLowerCase();

  if (normalizedPath.startsWith(".github/workflows/")) {
    return "integration";
  }

  if ([".md", ".txt"].includes(extension)) {
    return "prose";
  }

  if (
    SOURCE_EXTENSIONS.has(extension)
    || [".json", ".toml", ".yaml", ".yml", ".sh"].includes(extension)
    || /(?:^|\/)(?:dockerfile|makefile)$/i.test(normalizedPath)
  ) {
    return "runtime";
  }

  return "prose";
}

function runExtractionProof({
  workspaceRoot = process.cwd(),
  hostRoot = workspaceRoot,
} = {}) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedHostRoot = path.resolve(hostRoot);
  const internalImportViolations = collectRelativeImportViolations(normalizedWorkspaceRoot);
  const hostRepoReferences = collectHostRepoReferences({
    hostRoot: normalizedHostRoot,
    workspaceRoot: normalizedWorkspaceRoot,
  }).map((entry) => ({
    ...entry,
    classification: classifyHostReference(entry.file),
  }));
  const blockingHostRepoReferences = hostRepoReferences.filter(
    (entry) => entry.classification === "runtime",
  );
  const integrationHostRepoReferences = hostRepoReferences.filter(
    (entry) => entry.classification === "integration",
  );
  const proseHostRepoReferences = hostRepoReferences.filter(
    (entry) => entry.classification === "prose",
  );
  const checks = Object.freeze([
    {
      details:
        internalImportViolations.length === 0
          ? "No relative source imports resolve outside the niis subtree."
          : "Some source imports escape the subtree and must be internalized before extraction.",
      id: "internal-module-boundary",
      status: internalImportViolations.length === 0 ? "ok" : "error",
      summary:
        internalImportViolations.length === 0
          ? "No subtree-escaping imports detected."
          : `${internalImportViolations.length} escaping import(s) detected.`,
    },
    {
      details:
        blockingHostRepoReferences.length === 0
          ? "No host runtime, import, build configuration, or dependency source requires the subtree."
          : "Runtime or build configuration still depends on the subtree and blocks extraction.",
      id: "host-runtime-references",
      status: blockingHostRepoReferences.length === 0 ? "ok" : "error",
      summary:
        blockingHostRepoReferences.length === 0
          ? "No blocking host runtime references detected."
          : `${blockingHostRepoReferences.length} blocking host reference file(s) detected.`,
    },
    {
      details:
        integrationHostRepoReferences.length === 0
          ? "No explicit host integration wrappers reference the subtree."
          : "Explicit host integration wrappers remain and must move with or be retired after extraction.",
      id: "host-integration-references",
      status: integrationHostRepoReferences.length === 0 ? "ok" : "warning",
      summary: `${integrationHostRepoReferences.length} host integration reference file(s).`,
    },
    {
      details:
        proseHostRepoReferences.length === 0
          ? "No prose or archived notes mention the subtree."
          : "Prose and archive references are informational and do not block runtime extraction.",
      id: "host-prose-references",
      status: proseHostRepoReferences.length === 0 ? "ok" : "warning",
      summary: `${proseHostRepoReferences.length} prose reference file(s).`,
    },
  ]);
  const ok = checks.every((check) => check.status !== "error");
  const result = {
    blocking_host_repo_references: blockingHostRepoReferences,
    checks,
    host_repo_references: hostRepoReferences,
    host_root: normalizedHostRoot,
    integration_host_repo_references: integrationHostRepoReferences,
    internal_import_violations: internalImportViolations,
    ok,
    prose_host_repo_references: proseHostRepoReferences,
    workspace_root: normalizedWorkspaceRoot,
  };

  if (!ok) {
    throw new ExtractionProofError(
      "extraction proof failed; inspect blocking runtime references or subtree-escaping imports",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hostRootFlagIndex = process.argv.indexOf("--host-root");
  const hostRoot = hostRootFlagIndex === -1
    ? process.cwd()
    : path.resolve(process.cwd(), process.argv[hostRootFlagIndex + 1] ?? ".");
  const workspaceRoot = process.env.NIIS_EVAL_SOURCE_ROOT
    ? path.resolve(process.env.NIIS_EVAL_SOURCE_ROOT)
    : process.cwd();

  try {
    console.log(JSON.stringify(runExtractionProof({
      hostRoot,
      workspaceRoot,
    }), null, 2));
  } catch (error) {
    if (error instanceof ExtractionProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  ExtractionProofError,
  runExtractionProof,
};
