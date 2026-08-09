import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PathSafetyError,
  assertNoSymlinkEscape,
  assertPathWithinRoot,
  canonicalizePath,
  resolveWorkspacePath,
  sanitizeWorkspaceIdentifier,
  validateWorkspaceRoot,
} from "./path-safety.js";

function createTempDir(testContext) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "niis-path-safety-"));
  testContext.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

test("sanitizeWorkspaceIdentifier enforces safe workspace identifiers", () => {
  assert.equal(sanitizeWorkspaceIdentifier("feature / ABC-123"), "feature-ABC-123");
  assert.throws(() => sanitizeWorkspaceIdentifier("////"), PathSafetyError);
});

test("validateWorkspaceRoot and resolveWorkspacePath keep workspaces under the canonical root", (t) => {
  const workspaceRoot = createTempDir(t);
  const canonicalRoot = validateWorkspaceRoot(workspaceRoot);

  assert.equal(canonicalRoot, canonicalizePath(workspaceRoot));

  const workspacePath = resolveWorkspacePath({
    workspaceRoot,
    identifier: "task-123",
    segments: ["artifacts"],
  });

  assert.equal(workspacePath, canonicalizePath(path.join(workspaceRoot, "task-123", "artifacts")));
  assert.throws(
    () =>
      assertPathWithinRoot(workspaceRoot, path.join(workspaceRoot, "..", "escape"), "workspace path"),
    PathSafetyError,
  );
});

test("assertNoSymlinkEscape rejects symlink targets that leave the workspace root", (t) => {
  const workspaceRoot = createTempDir(t);
  const outsideRoot = createTempDir(t);
  const linkPath = path.join(workspaceRoot, "linked");

  fs.symlinkSync(outsideRoot, linkPath, "dir");

  assert.throws(
    () => assertNoSymlinkEscape({ workspaceRoot, targetPath: path.join(linkPath, "child.txt") }),
    PathSafetyError,
  );
});
