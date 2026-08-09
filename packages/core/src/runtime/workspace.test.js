import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  HOOK_OUTPUT_LIMIT_BYTES,
  WorkspaceRuntimeError,
  cleanupWorkspace,
  createSandboxPolicy,
  createWorkspacePlan,
  materializeWorkspace,
  renderBranchTemplate,
  resolveWorkspaceSource,
  runWorkspaceHook,
  truncateHookOutput,
} from "./workspace.js";
import { canonicalizePath } from "./path-safety.js";

function createTempDir(testContext) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "niis-workspace-"));
  testContext.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

function runGit(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function createGitRepo(testContext) {
  const repoDir = createTempDir(testContext);

  runGit(repoDir, "init");
  runGit(repoDir, "config", "user.name", "Niis Tests");
  runGit(repoDir, "config", "user.email", "niis-tests@example.com");
  fs.writeFileSync(path.join(repoDir, "README.md"), "seed\n");
  runGit(repoDir, "add", "README.md");
  runGit(repoDir, "commit", "-m", "seed");

  return repoDir;
}

function nodeCommand(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

test("resolveWorkspaceSource uses project -> task session -> agent home -> default priority", (t) => {
  const projectPrimary = createTempDir(t);
  const agentHome = createTempDir(t);

  const resolved = resolveWorkspaceSource({
    projectPrimary,
    taskSessionCwd: null,
    agentHome,
    defaultSource: "/fallback",
  });

  assert.deepEqual(resolved, {
    source: "project_primary",
    path: canonicalizePath(projectPrimary),
  });
});

test("createSandboxPolicy keeps access rooted at the canonical workspace root", (t) => {
  const workspaceRoot = createTempDir(t);
  const writableRoot = path.join(workspaceRoot, "task-1");
  fs.mkdirSync(writableRoot);

  const sandbox = createSandboxPolicy({
    mode: "workspace-write",
    workspaceRoot,
    writableRoots: [writableRoot],
    readOnlyAccess: [workspaceRoot],
  });

  assert.equal(sandbox.mode, "workspace-write");
  assert.deepEqual(sandbox.writable_roots, [canonicalizePath(writableRoot)]);
  assert.throws(
    () =>
      createSandboxPolicy({
        mode: "read-only",
        workspaceRoot,
        writableRoots: [writableRoot],
      }),
    WorkspaceRuntimeError,
  );
  assert.throws(
    () =>
      createSandboxPolicy({
        mode: "workspace-write",
        workspaceRoot,
        writableRoots: [path.join(workspaceRoot, "..", "escape")],
      }),
    /escapes the workspace root/,
  );
});

test("createWorkspacePlan builds an isolated write plan with protected working copy and gated provision command", (t) => {
  const workspaceRoot = createTempDir(t);
  const projectPrimary = createTempDir(t);

  const workspacePlan = createWorkspacePlan({
    workspaceRoot,
    projectPrimary,
    task: {
      id: "worktree-isolation",
      title: "Worktree isolation and patch safety",
    },
    strategy: {
      mode: "worktree",
      branchTemplate: "{{task.id}}-{{slug}}",
      provision: {
        command: "npm install",
        allow: true,
        policyRef: "workflow.workspace.provision",
      },
    },
    hooks: {
      after_create: "npm install",
      before_run: "npm test",
      after_run: "git status --short",
    },
  });

  assert.equal(workspacePlan.strategy, "worktree");
  assert.equal(workspacePlan.branch_name, "worktree-isolation-Worktree-isolation-and-patch-safety");
  assert.equal(workspacePlan.source_resolution.source, "project_primary");
  assert.equal(workspacePlan.provision.command, "npm install");
  assert.equal(workspacePlan.provision.policy_ref, "workflow.workspace.provision");
  assert.equal(workspacePlan.sandbox.network_access, false);
  assert.equal(workspacePlan.patch_safety_policy.protect_user_working_copy, true);
  assert.equal(
    workspacePlan.patch_safety_policy.protected_roots.includes(canonicalizePath(projectPrimary)),
    true,
  );
  assert.equal(
    workspacePlan.sandbox.writable_roots[0],
    workspacePlan.workspace_path,
  );
});

test("createWorkspacePlan rejects non-canonical task IDs before deriving a path", (t) => {
  const workspaceRoot = createTempDir(t);
  const projectPrimary = createTempDir(t);

  for (const taskId of ["..", "../escape", "TASK", "task_name", "ｔａｓｋ"]) {
    assert.throws(
      () => createWorkspacePlan({
        projectPrimary,
        task: { id: taskId, title: "Unsafe identifier" },
        workspaceRoot,
      }),
      /canonical lower-case ASCII task id/,
      taskId,
    );
  }
  assert.deepEqual(fs.readdirSync(workspaceRoot), []);
});

test("materializeWorkspace creates an isolated worktree and cleanup removes it without touching the source repo", (t) => {
  const workspaceRoot = createTempDir(t);
  const projectPrimary = createGitRepo(t);
  const workspacePlan = createWorkspacePlan({
    workspaceRoot,
    projectPrimary,
    task: {
      id: "worktree-materialization",
      title: "Materialize worktree",
    },
    strategy: {
      mode: "worktree",
      branchTemplate: "{{task.id}}-{{slug}}",
      provision: {
        command: nodeCommand("require('fs').writeFileSync('provisioned.txt', 'ok')"),
        allow: true,
        policyRef: "workflow.workspace.provision",
      },
    },
    hooks: {
      after_create: nodeCommand("require('fs').writeFileSync('created.txt', 'ok')"),
    },
  });

  const workspaceRuntime = materializeWorkspace(workspacePlan);

  assert.equal(fs.existsSync(path.join(workspaceRuntime.workspace_path, "created.txt")), true);
  assert.equal(fs.existsSync(path.join(workspaceRuntime.workspace_path, "provisioned.txt")), true);

  fs.writeFileSync(path.join(workspaceRuntime.workspace_path, "workspace-only.txt"), "isolated\n");

  assert.equal(fs.existsSync(path.join(projectPrimary, "workspace-only.txt")), false);
  assert.equal(runGit(projectPrimary, "status", "--short"), "");

  const cleanupResult = cleanupWorkspace(workspaceRuntime);

  assert.equal(cleanupResult.removed, true);
  assert.equal(fs.existsSync(workspaceRuntime.workspace_path), false);
  assert.equal(
    runGit(projectPrimary, "branch", "--list", workspaceRuntime.branch_name),
    "",
  );
});

test("materializeWorkspace supports isolated branch strategy via local clone", (t) => {
  const workspaceRoot = createTempDir(t);
  const projectPrimary = createGitRepo(t);
  const workspacePlan = createWorkspacePlan({
    workspaceRoot,
    projectPrimary,
    task: {
      id: "branch-materialization",
      title: "Materialize branch clone",
    },
    strategy: {
      mode: "branch",
      branchTemplate: "{{task.id}}-{{slug}}",
    },
  });

  const workspaceRuntime = materializeWorkspace(workspacePlan);

  fs.writeFileSync(path.join(workspaceRuntime.workspace_path, "clone-only.txt"), "isolated\n");

  assert.equal(fs.existsSync(path.join(projectPrimary, "clone-only.txt")), false);
  assert.equal(runGit(workspaceRuntime.workspace_path, "branch", "--show-current"), workspaceRuntime.branch_name);

  cleanupWorkspace(workspaceRuntime);
  assert.equal(fs.existsSync(workspaceRuntime.workspace_path), false);
});

test("fatal workspace hooks abort materialization and clean up the isolated workspace", (t) => {
  const workspaceRoot = createTempDir(t);
  const projectPrimary = createGitRepo(t);
  const workspacePlan = createWorkspacePlan({
    workspaceRoot,
    projectPrimary,
    task: {
      id: "workspace-hook-fail",
      title: "Failing after create hook",
    },
    hooks: {
      after_create: nodeCommand("process.stderr.write('after-create failed'); process.exit(7)"),
    },
  });

  assert.throws(
    () => materializeWorkspace(workspacePlan),
    /workspace hook after_create failed with exit code 7: after-create failed/,
  );
  assert.equal(fs.existsSync(workspacePlan.workspace_path), false);
});

test("logged hooks do not block run completion or cleanup", (t) => {
  const workspaceRoot = createTempDir(t);
  const projectPrimary = createGitRepo(t);
  const workspacePlan = createWorkspacePlan({
    workspaceRoot,
    projectPrimary,
    task: {
      id: "workspace-logged-hooks",
      title: "Logged hooks",
    },
    hooks: {
      after_run: nodeCommand("process.stderr.write('after-run failed'); process.exit(9)"),
      before_remove: nodeCommand("process.stderr.write('before-remove failed'); process.exit(11)"),
    },
  });
  const workspaceRuntime = materializeWorkspace(workspacePlan);

  const afterRunResult = runWorkspaceHook(workspaceRuntime, "after_run");
  const cleanupResult = cleanupWorkspace(workspaceRuntime);

  assert.equal(afterRunResult.status, "failed");
  assert.equal(afterRunResult.ignored, true);
  assert.equal(cleanupResult.removed, true);
  assert.equal(fs.existsSync(workspaceRuntime.workspace_path), false);
});

test("renderBranchTemplate and truncateHookOutput apply workspace safety constraints", () => {
  assert.equal(
    renderBranchTemplate("{{task.id}}-{{slug}}", {
      task: { id: "task-1" },
      slug: "feature-branch",
    }),
    "task-1-feature-branch",
  );

  const longOutput = "x".repeat(HOOK_OUTPUT_LIMIT_BYTES + 32);
  const truncated = truncateHookOutput(longOutput);

  assert.equal(truncated.endsWith("…[truncated]"), true);
  assert.throws(
    () =>
      createWorkspacePlan({
        workspaceRoot: "/tmp",
        projectPrimary: "/tmp",
        task: { id: "task-2", title: "title" },
        strategy: {
          provision: {
            command: "npm install",
            allow: false,
          },
        },
      }),
    WorkspaceRuntimeError,
  );
});
