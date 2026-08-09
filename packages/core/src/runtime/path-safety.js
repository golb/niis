import fs from "node:fs";
import path from "node:path";

class PathSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathSafetyError";
  }
}

const WORKSPACE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]+$/;

function sanitizeWorkspaceIdentifier(identifier) {
  if (typeof identifier !== "string" || identifier.trim() === "") {
    throw new PathSafetyError("workspace identifier must be a non-empty string");
  }

  const sanitized = identifier
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  if (!sanitized || !WORKSPACE_IDENTIFIER_PATTERN.test(sanitized)) {
    throw new PathSafetyError("workspace identifier must contain only [A-Za-z0-9._-]");
  }

  return sanitized;
}

function isDirectory(directoryPath) {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function findNearestExistingParent(targetPath) {
  const suffix = [];
  let currentPath = path.resolve(targetPath);

  while (!fs.existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);

    if (parentPath === currentPath) {
      return {
        existingPath: null,
        suffix: [path.basename(currentPath), ...suffix].filter(Boolean),
      };
    }

    suffix.unshift(path.basename(currentPath));
    currentPath = parentPath;
  }

  return {
    existingPath: currentPath,
    suffix,
  };
}

function canonicalizePath(targetPath) {
  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    throw new PathSafetyError("path must be a non-empty string");
  }

  const resolvedPath = path.resolve(targetPath);
  const { existingPath, suffix } = findNearestExistingParent(resolvedPath);

  if (!existingPath) {
    return resolvedPath;
  }

  const canonicalBase = fs.realpathSync.native(existingPath);
  return suffix.length > 0 ? path.join(canonicalBase, ...suffix) : canonicalBase;
}

function validateWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") {
    throw new PathSafetyError("workspace root must be a non-empty string");
  }

  const canonicalWorkspaceRoot = canonicalizePath(workspaceRoot);

  if (!fs.existsSync(canonicalWorkspaceRoot)) {
    throw new PathSafetyError(`workspace root does not exist: ${canonicalWorkspaceRoot}`);
  }

  if (!isDirectory(canonicalWorkspaceRoot)) {
    throw new PathSafetyError(`workspace root is not a directory: ${canonicalWorkspaceRoot}`);
  }

  return canonicalWorkspaceRoot;
}

function isPathWithinRoot(rootPath, targetPath) {
  const canonicalRoot = canonicalizePath(rootPath);
  const canonicalTarget = canonicalizePath(targetPath);
  const relativePath = path.relative(canonicalRoot, canonicalTarget);

  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function assertPathWithinRoot(rootPath, targetPath, label = "path") {
  const canonicalRoot = canonicalizePath(rootPath);
  const canonicalTarget = canonicalizePath(targetPath);

  if (!isPathWithinRoot(canonicalRoot, canonicalTarget)) {
    throw new PathSafetyError(
      `${label} escapes the workspace root: ${canonicalTarget} is outside ${canonicalRoot}`,
    );
  }

  return canonicalTarget;
}

function resolveWorkspacePath({ workspaceRoot, identifier, segments = [] }) {
  const canonicalWorkspaceRoot = validateWorkspaceRoot(workspaceRoot);
  const workspaceIdentifier = sanitizeWorkspaceIdentifier(identifier);
  const candidatePath = path.resolve(canonicalWorkspaceRoot, workspaceIdentifier, ...segments);

  return assertPathWithinRoot(canonicalWorkspaceRoot, candidatePath, "workspace path");
}

function assertNoSymlinkEscape({ workspaceRoot, targetPath }) {
  const canonicalWorkspaceRoot = validateWorkspaceRoot(workspaceRoot);
  const canonicalTarget = canonicalizePath(targetPath);

  return assertPathWithinRoot(canonicalWorkspaceRoot, canonicalTarget, "symlink target");
}

export {
  PathSafetyError,
  WORKSPACE_IDENTIFIER_PATTERN,
  assertNoSymlinkEscape,
  assertPathWithinRoot,
  canonicalizePath,
  isPathWithinRoot,
  resolveWorkspacePath,
  sanitizeWorkspaceIdentifier,
  validateWorkspaceRoot,
};
