import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { assertCanonicalTaskId } from "../schemas/task.js";
import {
  assertNoSymlinkEscape,
  assertPathWithinRoot,
  canonicalizePath,
  resolveWorkspacePath,
  sanitizeWorkspaceIdentifier,
  validateWorkspaceRoot,
} from "./path-safety.js";

class WorkspaceRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceRuntimeError";
  }
}

const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
const WORKSPACE_SOURCE_PRIORITIES = [
  "project_primary",
  "task_session_cwd",
  "agent_home",
  "default",
];
const HOOK_FAILURE_SEVERITY = Object.freeze({
  after_create: "fatal",
  before_run: "fatal",
  after_run: "logged",
  before_remove: "logged",
});
const HOOK_OUTPUT_LIMIT_BYTES = 2048;
const WORKSPACE_STRATEGIES = ["worktree", "branch"];

function ensureSandboxMode(mode) {
  if (!SANDBOX_MODES.includes(mode)) {
    throw new WorkspaceRuntimeError(`unsupported sandbox mode: ${mode}`);
  }

  return mode;
}

function classifyHookFailureSeverity(hookName) {
  const severity = HOOK_FAILURE_SEVERITY[hookName];

  if (!severity) {
    throw new WorkspaceRuntimeError(`unsupported workspace hook: ${hookName}`);
  }

  return severity;
}

function truncateHookOutput(output, limitBytes = HOOK_OUTPUT_LIMIT_BYTES) {
  const normalizedOutput = typeof output === "string" ? output : String(output ?? "");

  if (!Number.isInteger(limitBytes) || limitBytes <= 0) {
    throw new WorkspaceRuntimeError("hook output limit must be a positive integer");
  }

  const outputBuffer = Buffer.from(normalizedOutput, "utf8");

  if (outputBuffer.length <= limitBytes) {
    return normalizedOutput;
  }

  return `${outputBuffer.subarray(0, limitBytes).toString("utf8")}…[truncated]`;
}

function ensureWorkspacePlan(workspacePlan) {
  if (!workspacePlan?.workspace_path || !workspacePlan?.source_resolution?.path) {
    throw new WorkspaceRuntimeError("workspace runtime requires a workspace plan from createWorkspacePlan()");
  }

  return workspacePlan;
}

function normalizeWorkspaceSlug(taskTitle) {
  return sanitizeWorkspaceIdentifier(taskTitle || "workspace");
}

function renderBranchTemplate(template, { task, slug }) {
  if (typeof template !== "string" || template.trim() === "") {
    throw new WorkspaceRuntimeError("branch template must be a non-empty string");
  }

  const branchName = template.replaceAll("{{task.id}}", task.id).replaceAll("{{slug}}", slug);
  return sanitizeWorkspaceIdentifier(branchName);
}

function resolveWorkspaceSource({
  priority = WORKSPACE_SOURCE_PRIORITIES,
  projectPrimary = null,
  taskSessionCwd = null,
  agentHome = null,
  defaultSource = null,
}) {
  const sources = {
    project_primary: projectPrimary,
    task_session_cwd: taskSessionCwd,
    agent_home: agentHome,
    default: defaultSource,
  };

  for (const sourceKey of priority) {
    if (!WORKSPACE_SOURCE_PRIORITIES.includes(sourceKey)) {
      throw new WorkspaceRuntimeError(`unsupported workspace source priority: ${sourceKey}`);
    }

    const sourcePath = sources[sourceKey];

    if (typeof sourcePath === "string" && sourcePath.trim() !== "") {
      return {
        source: sourceKey,
        path: canonicalizePath(sourcePath),
      };
    }
  }

  throw new WorkspaceRuntimeError("workspace source resolution found no usable source path");
}

function validatePathList({
  workspaceRoot,
  paths,
  label,
}) {
  return paths.map((entry) => assertPathWithinRoot(workspaceRoot, entry, label));
}

function createSandboxPolicy({
  mode = "workspace-write",
  workspaceRoot,
  writableRoots = [],
  readOnlyAccess = [],
  networkAccess = false,
  networkPolicyRef = null,
}) {
  const sandboxMode = ensureSandboxMode(mode);
  const canonicalWorkspaceRoot = validateWorkspaceRoot(workspaceRoot);
  const normalizedWritableRoots = validatePathList({
    workspaceRoot: canonicalWorkspaceRoot,
    paths: writableRoots,
    label: "writable root",
  });
  const normalizedReadOnlyAccess = validatePathList({
    workspaceRoot: canonicalWorkspaceRoot,
    paths: readOnlyAccess,
    label: "read-only access path",
  });

  if (sandboxMode === "read-only" && normalizedWritableRoots.length > 0) {
    throw new WorkspaceRuntimeError("read-only sandbox must not declare writable roots");
  }

  if (networkAccess && (!networkPolicyRef || networkPolicyRef.trim() === "")) {
    throw new WorkspaceRuntimeError("network access requires an explicit network policy reference");
  }

  return {
    mode: sandboxMode,
    workspace_root: canonicalWorkspaceRoot,
    writable_roots: normalizedWritableRoots,
    read_only_access: normalizedReadOnlyAccess,
    network_access: networkAccess,
    network_policy_ref: networkAccess ? networkPolicyRef : null,
  };
}

function createPatchSafetyPolicy({
  workspaceRoot,
  workspacePath,
  protectedRoots = [],
}) {
  const canonicalWorkspaceRoot = validateWorkspaceRoot(workspaceRoot);
  const canonicalWorkspacePath = assertPathWithinRoot(
    canonicalWorkspaceRoot,
    workspacePath,
    "workspace path",
  );
  const normalizedProtectedRoots = protectedRoots.map((protectedRoot) => canonicalizePath(protectedRoot));

  if (normalizedProtectedRoots.includes(canonicalWorkspacePath)) {
    throw new WorkspaceRuntimeError("protected roots must not include the isolated workspace path");
  }

  return Object.freeze({
    isolated_write_root: canonicalWorkspacePath,
    canonical_workspace_root: canonicalWorkspaceRoot,
    protected_roots: normalizedProtectedRoots,
    symlink_escape_prevention: true,
    protect_user_working_copy: true,
  });
}

function createHookPolicy(hooks = {}) {
  const normalizedHooks = {};

  for (const hookName of Object.keys(HOOK_FAILURE_SEVERITY)) {
    const hookCommand = hooks[hookName] ?? null;

    normalizedHooks[hookName] = {
      command: hookCommand,
      severity: classifyHookFailureSeverity(hookName),
      output_limit_bytes: HOOK_OUTPUT_LIMIT_BYTES,
    };
  }

  return normalizedHooks;
}

function createProvisionPolicy({ command = null, allow = false, policyRef = null } = {}) {
  if (!command) {
    return {
      command: null,
      allow: false,
      policy_ref: null,
    };
  }

  if (!allow || !policyRef) {
    throw new WorkspaceRuntimeError(
      "post-provision command requires explicit policy approval and a policy reference",
    );
  }

  return {
    command,
    allow: true,
    policy_ref: policyRef,
  };
}

function createWorkspacePlan({
  workspaceRoot,
  task,
  projectPrimary,
  taskSessionCwd = null,
  agentHome = null,
  defaultSource = null,
  strategy = {},
  sandbox = {},
  hooks = {},
}) {
  const canonicalWorkspaceRoot = validateWorkspaceRoot(workspaceRoot);

  if (!task?.id) {
    throw new WorkspaceRuntimeError("workspace plan requires task.id");
  }

  const taskId = assertCanonicalTaskId(task.id, "task.id");
  const normalizedTask = { ...task, id: taskId };
  const slug = normalizeWorkspaceSlug(task.title ?? taskId);
  const workspaceIdentifier = taskId;
  const expectedWorkspacePath = path.resolve(
    canonicalWorkspaceRoot,
    `${workspaceIdentifier}-${slug}`,
  );
  const workspacePath = resolveWorkspacePath({
    workspaceRoot: canonicalWorkspaceRoot,
    identifier: `${workspaceIdentifier}-${slug}`,
  });
  if (workspacePath !== expectedWorkspacePath) {
    throw new WorkspaceRuntimeError(
      "task workspace path must not resolve through a filesystem alias",
    );
  }
  const workspaceStrategy = strategy.mode ?? "worktree";

  if (!WORKSPACE_STRATEGIES.includes(workspaceStrategy)) {
    throw new WorkspaceRuntimeError(`unsupported workspace strategy: ${workspaceStrategy}`);
  }

  const sourceResolution = resolveWorkspaceSource({
    priority: strategy.sourcePriority ?? WORKSPACE_SOURCE_PRIORITIES,
    projectPrimary,
    taskSessionCwd,
    agentHome,
    defaultSource,
  });

  assertNoSymlinkEscape({
    workspaceRoot: canonicalWorkspaceRoot,
    targetPath: workspacePath,
  });

  const branchTemplate = strategy.branchTemplate ?? "{{task.id}}-{{slug}}";
  const branchName = renderBranchTemplate(branchTemplate, {
    task: normalizedTask,
    slug,
  });
  const sandboxPolicy = createSandboxPolicy({
    mode: sandbox.mode ?? "workspace-write",
    workspaceRoot: canonicalWorkspaceRoot,
    writableRoots: sandbox.writableRoots ?? [workspacePath],
    readOnlyAccess: sandbox.readOnlyAccess ?? [],
    networkAccess: sandbox.networkAccess ?? false,
    networkPolicyRef: sandbox.networkPolicyRef ?? null,
  });
  const patchSafetyPolicy = createPatchSafetyPolicy({
    workspaceRoot: canonicalWorkspaceRoot,
    workspacePath,
    protectedRoots: [
      sourceResolution.path,
      ...(strategy.protectedRoots ?? []),
    ],
  });

  return {
    branch_name: branchName,
    hooks: createHookPolicy(hooks),
    patch_safety_policy: patchSafetyPolicy,
    provision: createProvisionPolicy(strategy.provision ?? {}),
    sandbox: sandboxPolicy,
    source_resolution: sourceResolution,
    strategy: workspaceStrategy,
    workspace_path: workspacePath,
    workspace_root: canonicalWorkspaceRoot,
    write_target: {
      mode: workspaceStrategy,
      path: workspacePath,
      source_path: sourceResolution.path,
    },
  };
}

function runGitCommand({ cwd, args }) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });

  if (result.error) {
    throw new WorkspaceRuntimeError(`git ${args.join(" ")} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const output = truncateHookOutput(
      `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    );
    throw new WorkspaceRuntimeError(
      `git ${args.join(" ")} failed with exit code ${result.status}${output ? `: ${output}` : ""}`,
    );
  }

  return {
    exit_code: result.status ?? 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function runWorkspaceCommand({
  command,
  cwd,
  env = {},
  outputLimitBytes = HOOK_OUTPUT_LIMIT_BYTES,
}) {
  const result = spawnSync(command, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
    shell: true,
  });

  if (result.error) {
    throw new WorkspaceRuntimeError(
      `workspace command failed before launch: ${result.error.message}`,
    );
  }

  const combinedOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

  return {
    command,
    cwd,
    exit_code: result.status ?? 0,
    ok: result.status === 0,
    output: truncateHookOutput(combinedOutput, outputLimitBytes),
  };
}

function getGitRepositoryRoot(sourcePath) {
  const result = runGitCommand({
    cwd: sourcePath,
    args: ["rev-parse", "--show-toplevel"],
  });

  return canonicalizePath(result.output);
}

function workspaceCommandEnvironment(workspaceRuntime) {
  return {
    NIIS_BRANCH_NAME: workspaceRuntime.branch_name,
    NIIS_SANDBOX_MODE: workspaceRuntime.sandbox.mode,
    NIIS_SOURCE_PATH: workspaceRuntime.source_resolution.path,
    NIIS_WORKSPACE_PATH: workspaceRuntime.workspace_path,
    NIIS_WORKSPACE_ROOT: workspaceRuntime.workspace_root,
  };
}

function appendLifecycleEntry(workspaceRuntime, entry) {
  workspaceRuntime.lifecycle.push(entry);
  return entry;
}

function createWorkspaceRecord(workspacePlan) {
  const plan = ensureWorkspacePlan(workspacePlan);

  return {
    ...plan,
    lifecycle: [],
    repository_root: getGitRepositoryRoot(plan.source_resolution.path),
    status: "prepared",
  };
}

function materializeWorkspace(workspacePlan) {
  const workspaceRuntime = createWorkspaceRecord(workspacePlan);

  try {
    fs.mkdirSync(path.dirname(workspaceRuntime.workspace_path), {
      recursive: true,
    });

    if (fs.existsSync(workspaceRuntime.workspace_path)) {
      throw new WorkspaceRuntimeError(
        `workspace path already exists: ${workspaceRuntime.workspace_path}`,
      );
    }

    if (workspaceRuntime.strategy === "worktree") {
      runGitCommand({
        cwd: workspaceRuntime.repository_root,
        args: [
          "worktree",
          "add",
          "-b",
          workspaceRuntime.branch_name,
          workspaceRuntime.workspace_path,
          "HEAD",
        ],
      });
    } else if (workspaceRuntime.strategy === "branch") {
      runGitCommand({
        cwd: workspaceRuntime.workspace_root,
        args: [
          "clone",
          "--local",
          "--no-hardlinks",
          workspaceRuntime.repository_root,
          workspaceRuntime.workspace_path,
        ],
      });
      runGitCommand({
        cwd: workspaceRuntime.workspace_path,
        args: ["switch", "-c", workspaceRuntime.branch_name],
      });
    } else {
      throw new WorkspaceRuntimeError(
        `unsupported workspace strategy at runtime: ${workspaceRuntime.strategy}`,
      );
    }

    assertNoSymlinkEscape({
      workspaceRoot: workspaceRuntime.workspace_root,
      targetPath: workspaceRuntime.workspace_path,
    });

    workspaceRuntime.status = "materialized";
    runWorkspaceHook(workspaceRuntime, "after_create");
    runProvisionCommand(workspaceRuntime);

    return workspaceRuntime;
  } catch (error) {
    cleanupWorkspace(workspaceRuntime, {
      skipHooks: true,
      swallowErrors: true,
    });
    throw error;
  }
}

function runWorkspaceHook(workspaceRuntime, hookName) {
  const runtime = workspaceRuntime;
  const hook = runtime.hooks?.[hookName];

  if (!hook) {
    throw new WorkspaceRuntimeError(`unsupported workspace hook: ${hookName}`);
  }

  if (!hook.command) {
    return appendLifecycleEntry(runtime, {
      command: null,
      exit_code: 0,
      ignored: false,
      kind: "hook",
      name: hookName,
      output: "",
      severity: hook.severity,
      status: "skipped",
    });
  }

  const result = runWorkspaceCommand({
    command: hook.command,
    cwd: runtime.workspace_path,
    env: workspaceCommandEnvironment(runtime),
    outputLimitBytes: hook.output_limit_bytes,
  });
  const lifecycleEntry = appendLifecycleEntry(runtime, {
    ...result,
    ignored: !result.ok && hook.severity === "logged",
    kind: "hook",
    name: hookName,
    severity: hook.severity,
    status: result.ok ? "succeeded" : "failed",
  });

  if (!result.ok && hook.severity === "fatal") {
    throw new WorkspaceRuntimeError(
      `workspace hook ${hookName} failed with exit code ${result.exit_code}${result.output ? `: ${result.output}` : ""}`,
    );
  }

  return lifecycleEntry;
}

function runProvisionCommand(workspaceRuntime) {
  const runtime = workspaceRuntime;

  if (!runtime.provision?.command) {
    return appendLifecycleEntry(runtime, {
      command: null,
      exit_code: 0,
      ignored: false,
      kind: "provision",
      name: "provision",
      output: "",
      policy_ref: runtime.provision?.policy_ref ?? null,
      status: "skipped",
    });
  }

  const result = runWorkspaceCommand({
    command: runtime.provision.command,
    cwd: runtime.workspace_path,
    env: workspaceCommandEnvironment(runtime),
  });
  const lifecycleEntry = appendLifecycleEntry(runtime, {
    ...result,
    ignored: false,
    kind: "provision",
    name: "provision",
    policy_ref: runtime.provision.policy_ref,
    status: result.ok ? "succeeded" : "failed",
  });

  if (!result.ok) {
    throw new WorkspaceRuntimeError(
      `workspace provision failed with exit code ${result.exit_code}${result.output ? `: ${result.output}` : ""}`,
    );
  }

  return lifecycleEntry;
}

function cleanupWorkspace(workspaceRuntime, { skipHooks = false, swallowErrors = false } = {}) {
  const runtime = workspaceRuntime;
  const cleanupSummary = {
    branch_deleted: false,
    removed: false,
  };

  try {
    if (!skipHooks) {
      runWorkspaceHook(runtime, "before_remove");
    }

    if (runtime.strategy === "worktree" && fs.existsSync(runtime.workspace_path)) {
      runGitCommand({
        cwd: runtime.repository_root,
        args: ["worktree", "remove", "--force", runtime.workspace_path],
      });
      cleanupSummary.removed = !fs.existsSync(runtime.workspace_path);
    } else if (runtime.strategy === "branch" && fs.existsSync(runtime.workspace_path)) {
      fs.rmSync(runtime.workspace_path, { recursive: true, force: true });
      cleanupSummary.removed = !fs.existsSync(runtime.workspace_path);
    } else {
      cleanupSummary.removed = !fs.existsSync(runtime.workspace_path);
    }

    if (runtime.strategy === "worktree") {
      const branchDelete = spawnSync(
        "git",
        ["branch", "-D", runtime.branch_name],
        {
          cwd: runtime.repository_root,
          encoding: "utf8",
        },
      );

      cleanupSummary.branch_deleted = branchDelete.status === 0;
    }

    runtime.status = "cleaned";

    return cleanupSummary;
  } catch (error) {
    if (!swallowErrors) {
      throw error;
    }

    return cleanupSummary;
  } finally {
    if (fs.existsSync(runtime.workspace_path)) {
      fs.rmSync(runtime.workspace_path, { recursive: true, force: true });
      cleanupSummary.removed = !fs.existsSync(runtime.workspace_path);
    }
  }
}

export {
  HOOK_FAILURE_SEVERITY,
  HOOK_OUTPUT_LIMIT_BYTES,
  SANDBOX_MODES,
  WORKSPACE_SOURCE_PRIORITIES,
  WORKSPACE_STRATEGIES,
  WorkspaceRuntimeError,
  classifyHookFailureSeverity,
  cleanupWorkspace,
  createHookPolicy,
  createPatchSafetyPolicy,
  createProvisionPolicy,
  createSandboxPolicy,
  createWorkspacePlan,
  materializeWorkspace,
  normalizeWorkspaceSlug,
  renderBranchTemplate,
  resolveWorkspaceSource,
  runGitCommand,
  runProvisionCommand,
  runWorkspaceHook,
  truncateHookOutput,
};
