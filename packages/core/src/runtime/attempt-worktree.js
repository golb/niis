import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { assertCanonicalTaskId } from "../schemas/task.js";
import { runGitCommand } from "./workspace.js";
import { canonicalizePath } from "./path-safety.js";

class AttemptWorktreeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AttemptWorktreeError";
    this.code = options.code ?? "attempt_worktree_error";
  }
}

const ATTEMPT_WORKTREE_SIDECAR_FILENAME = "attempt-worktree.json";
const ATTEMPT_WORKTREE_SCHEMA_VERSION = 1;
const ATTEMPT_WORKTREE_STATUSES = Object.freeze([
  "ACTIVE",
  "COMMITTED",
  "PRESERVED",
  "REMOVED",
]);
const PRIMARY_CHECKOUT_DIGEST_EXCLUDED_DIRECTORIES = Object.freeze([
  ".git",
  ".niis",
  ".worktrees",
  "worktrees",
  "node_modules",
  "bower_components",
  ".venv",
  "venv",
  ".cache",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".turbo",
  ".next",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "__pycache__",
]);

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AttemptWorktreeError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureIsoTimestamp(value, label) {
  const normalized = value instanceof Date ? value.toISOString() : value;

  if (typeof normalized !== "string" || Number.isNaN(Date.parse(normalized))) {
    throw new AttemptWorktreeError(`${label} must be an ISO 8601 timestamp`);
  }

  return new Date(normalized).toISOString();
}

function ensureNullableString(value, label) {
  if (value === null || value === undefined) {
    return null;
  }

  return ensureNonEmptyString(value, label);
}

function normalizePromotionIntent(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AttemptWorktreeError("sidecar.promotion_intent must be an object");
  }
  const expectedSnapshot = ensureNonEmptyString(
    value.expected_task_snapshot_sha256,
    "sidecar.promotion_intent.expected_task_snapshot_sha256",
  ).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expectedSnapshot)) {
    throw new AttemptWorktreeError(
      "sidecar.promotion_intent expected snapshot must be a SHA-256 digest",
    );
  }
  return Object.freeze({
    author_email: ensureNonEmptyString(
      value.author_email,
      "sidecar.promotion_intent.author_email",
    ),
    author_name: ensureNonEmptyString(
      value.author_name,
      "sidecar.promotion_intent.author_name",
    ),
    base_commit: ensureNonEmptyString(
      value.base_commit,
      "sidecar.promotion_intent.base_commit",
    ),
    created_at: ensureIsoTimestamp(
      value.created_at,
      "sidecar.promotion_intent.created_at",
    ),
    expected_task_snapshot_sha256: expectedSnapshot,
    expected_commit: ensureNullableString(
      value.expected_commit,
      "sidecar.promotion_intent.expected_commit",
    ),
    expected_tree: ensureNonEmptyString(
      value.expected_tree,
      "sidecar.promotion_intent.expected_tree",
    ),
    message: ensureNonEmptyString(
      value.message,
      "sidecar.promotion_intent.message",
    ),
    author_date: ensureIsoTimestamp(
      value.author_date,
      "sidecar.promotion_intent.author_date",
    ),
    committer_date: ensureIsoTimestamp(
      value.committer_date,
      "sidecar.promotion_intent.committer_date",
    ),
  });
}

function sanitizeIdentifier(value, label) {
  const normalized = ensureNonEmptyString(value, label)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  if (!normalized) {
    throw new AttemptWorktreeError(
      `${label} must contain at least one path-safe character`,
    );
  }

  return normalized;
}

function sanitizeBranchPart(value, label) {
  const normalized = sanitizeIdentifier(value, label)
    .replace(/\.lock$/u, "-lock")
    .replace(/@\{/gu, "-");

  if (!normalized) {
    throw new AttemptWorktreeError(
      `${label} must contain at least one branch-safe character`,
    );
  }

  return normalized;
}

function resolveRepositoryRoot(repositoryPath) {
  const candidate = path.resolve(
    ensureNonEmptyString(repositoryPath, "repositoryPath"),
  );

  try {
    return path.resolve(runGitCommand({
      cwd: candidate,
      args: ["rev-parse", "--show-toplevel"],
    }).output);
  } catch (error) {
    throw new AttemptWorktreeError(
      `repositoryPath is not a usable Git checkout: ${error.message}`,
      { code: "invalid_repository" },
    );
  }
}

function assertPathWithin(parentPath, childPath, label) {
  const parent = canonicalizePath(parentPath);
  const child = canonicalizePath(childPath);
  const relativePath = path.relative(parent, child);

  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new AttemptWorktreeError(`${label} must be a child of ${parent}`);
  }

  return child;
}

function createAttemptWorktreePaths({ stateRoot, taskId, attemptId } = {}) {
  const resolvedStateRoot = canonicalizePath(
    ensureNonEmptyString(stateRoot, "stateRoot"),
  );
  const safeTaskId = assertCanonicalTaskId(taskId);
  const safeAttemptId = sanitizeIdentifier(attemptId, "attemptId");
  const expectedAttemptRoot = path.join(
    resolvedStateRoot,
    "worktrees",
    "attempts",
    safeTaskId,
    safeAttemptId,
  );
  const attemptRoot = assertPathWithin(
    resolvedStateRoot,
    expectedAttemptRoot,
    "attemptRoot",
  );
  if (attemptRoot !== expectedAttemptRoot) {
    throw new AttemptWorktreeError(
      "attemptRoot must not resolve through a filesystem alias",
      { code: "unsafe_attempt_path" },
    );
  }

  return Object.freeze({
    attempt_root: attemptRoot,
    sidecar_path: path.join(attemptRoot, ATTEMPT_WORKTREE_SIDECAR_FILENAME),
    state_root: resolvedStateRoot,
    worktree_path: path.join(attemptRoot, "workspace"),
  });
}

function normalizeAttemptWorktreeSidecar(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AttemptWorktreeError("attempt worktree sidecar must be an object");
  }

  if (input.schema_version !== ATTEMPT_WORKTREE_SCHEMA_VERSION) {
    throw new AttemptWorktreeError(
      `unsupported attempt worktree sidecar schema ${input.schema_version}`,
      { code: "sidecar_incompatible" },
    );
  }

  if (!ATTEMPT_WORKTREE_STATUSES.includes(input.status)) {
    throw new AttemptWorktreeError(
      `sidecar status must be one of: ${ATTEMPT_WORKTREE_STATUSES.join(", ")}`,
    );
  }

  if (input.preserve_on_failure !== true) {
    throw new AttemptWorktreeError(
      "attempt worktree sidecars must preserve the workspace on failure",
    );
  }

  return Object.freeze({
    schema_version: ATTEMPT_WORKTREE_SCHEMA_VERSION,
    attempt_id: ensureNonEmptyString(input.attempt_id, "sidecar.attempt_id"),
    task_id: assertCanonicalTaskId(input.task_id, "sidecar.task_id"),
    repository_root: path.resolve(
      ensureNonEmptyString(input.repository_root, "sidecar.repository_root"),
    ),
    state_root: path.resolve(
      ensureNonEmptyString(input.state_root, "sidecar.state_root"),
    ),
    attempt_root: path.resolve(
      ensureNonEmptyString(input.attempt_root, "sidecar.attempt_root"),
    ),
    worktree_path: path.resolve(
      ensureNonEmptyString(input.worktree_path, "sidecar.worktree_path"),
    ),
    branch_name: ensureNonEmptyString(input.branch_name, "sidecar.branch_name"),
    base_ref: ensureNonEmptyString(input.base_ref, "sidecar.base_ref"),
    base_commit: ensureNonEmptyString(input.base_commit, "sidecar.base_commit"),
    head_commit: ensureNonEmptyString(input.head_commit, "sidecar.head_commit"),
    status: input.status,
    preserve_on_failure: true,
    created_at: ensureIsoTimestamp(input.created_at, "sidecar.created_at"),
    updated_at: ensureIsoTimestamp(input.updated_at, "sidecar.updated_at"),
    committed_at: input.committed_at === null
      ? null
      : ensureIsoTimestamp(input.committed_at, "sidecar.committed_at"),
    removed_at: input.removed_at === null
      ? null
      : ensureIsoTimestamp(input.removed_at, "sidecar.removed_at"),
    preserved_reason: ensureNullableString(
      input.preserved_reason,
      "sidecar.preserved_reason",
    ),
    promotion_intent: normalizePromotionIntent(input.promotion_intent),
  });
}

function maybeFailPromotionStep(failAfterStep, step) {
  if (failAfterStep !== step) return;
  throw new AttemptWorktreeError(
    `injected promotion failure after ${step}`,
    { code: "promotion_crash_injected" },
  );
}

function runDeterministicGit({
  args,
  cwd,
  env = {},
  input = undefined,
}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new AttemptWorktreeError(
      `git ${args.join(" ")} failed during deterministic promotion: `
      + `${result.error?.message ?? result.stderr ?? result.stdout ?? "unknown error"}`,
      { code: "promotion_git_failed" },
    );
  }
  return String(result.stdout ?? "").trim();
}

function writeAttemptWorktreeSidecar(sidecarPath, sidecar) {
  const normalized = normalizeAttemptWorktreeSidecar(sidecar);
  const directory = path.dirname(sidecarPath);
  const temporaryPath = path.join(
    directory,
    `.${ATTEMPT_WORKTREE_SIDECAR_FILENAME}.${process.pid}.tmp`,
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  fs.renameSync(temporaryPath, sidecarPath);
  fs.chmodSync(sidecarPath, 0o600);
  return normalized;
}

function readAttemptWorktreeSidecar(sidecarPath) {
  const resolvedPath = path.resolve(
    ensureNonEmptyString(sidecarPath, "sidecarPath"),
  );

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  try {
    return normalizeAttemptWorktreeSidecar(
      JSON.parse(fs.readFileSync(resolvedPath, "utf8")),
    );
  } catch (error) {
    if (error instanceof AttemptWorktreeError) {
      throw error;
    }

    throw new AttemptWorktreeError(
      `failed to read attempt worktree sidecar ${resolvedPath}: ${error.message}`,
      { code: "sidecar_invalid" },
    );
  }
}

function capturePrimaryCheckoutState(repositoryRoot) {
  return Object.freeze({
    branch: runGitCommand({
      cwd: repositoryRoot,
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
    }).output,
    head: runGitCommand({
      cwd: repositoryRoot,
      args: ["rev-parse", "HEAD"],
    }).output,
    tracked_status: runGitCommand({
      cwd: repositoryRoot,
      args: ["status", "--porcelain=v1", "--untracked-files=no"],
    }).output,
  });
}

function runGitDigestCommand(repositoryRoot, args, { input = undefined } = {}) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "buffer",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new AttemptWorktreeError(
      `git ${args.join(" ")} failed while capturing primary checkout evidence: `
      + result.error.message,
      { code: "primary_checkout_digest_failed" },
    );
  }
  if (result.status !== 0) {
    throw new AttemptWorktreeError(
      `git ${args.join(" ")} failed while capturing primary checkout evidence`,
      { code: "primary_checkout_digest_failed" },
    );
  }
  return result.stdout;
}

function runGitNoIndexDiff(repositoryRoot, relativePath) {
  const result = spawnSync(
    "git",
    [
      "diff",
      "--no-index",
      "--binary",
      "--no-ext-diff",
      "--",
      "/dev/null",
      relativePath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw new AttemptWorktreeError(
      `failed to capture untracked task diff for ${relativePath}: `
      + result.error.message,
      { code: "attempt_diff_failed" },
    );
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new AttemptWorktreeError(
      `failed to capture untracked task diff for ${relativePath}`,
      { code: "attempt_diff_failed" },
    );
  }
  return result.stdout.trim();
}

function splitNullTerminated(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "");
}

function assertCheckoutRelativePath(repositoryRoot, relativePath) {
  const absolutePath = path.resolve(repositoryRoot, relativePath);
  const relative = path.relative(repositoryRoot, absolutePath);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new AttemptWorktreeError(
      "Git returned a path outside the attempt checkout",
      { code: "attempt_diff_failed" },
    );
  }
  return absolutePath;
}

function gitObjectHashForBuffer(repositoryRoot, relativePath, contents) {
  return runGitDigestCommand(
    repositoryRoot,
    ["hash-object", "--stdin", `--path=${relativePath}`],
    { input: contents },
  ).toString("utf8").trim();
}

function readTaskDeltaEntry(repositoryRoot, relativePath) {
  const absolutePath = assertCheckoutRelativePath(
    repositoryRoot,
    relativePath,
  );
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        exists: false,
        path: relativePath,
      });
    }
    throw error;
  }

  if (stat.isFile()) {
    return Object.freeze({
      blob: gitObjectHashForBuffer(
        repositoryRoot,
        relativePath,
        fs.readFileSync(absolutePath),
      ),
      exists: true,
      mode: (stat.mode & 0o111) === 0 ? "100644" : "100755",
      path: relativePath,
      type: "blob",
    });
  }

  if (stat.isSymbolicLink()) {
    return Object.freeze({
      blob: gitObjectHashForBuffer(
        repositoryRoot,
        relativePath,
        Buffer.from(fs.readlinkSync(absolutePath), "utf8"),
      ),
      exists: true,
      mode: "120000",
      path: relativePath,
      type: "symlink",
    });
  }

  if (stat.isDirectory()) {
    try {
      return Object.freeze({
        commit: runGitDigestCommand(
          absolutePath,
          ["rev-parse", "--verify", "HEAD^{commit}"],
        ).toString("utf8").trim(),
        exists: true,
        mode: "160000",
        path: relativePath,
        type: "gitlink",
      });
    } catch (error) {
      throw new AttemptWorktreeError(
        `task delta contains an unsupported directory entry: ${relativePath}`,
        {
          code: "attempt_diff_failed",
          cause: error,
        },
      );
    }
  }

  throw new AttemptWorktreeError(
    `task delta contains an unsupported filesystem entry: ${relativePath}`,
    { code: "attempt_diff_failed" },
  );
}

function readCheckoutPathMetadata(repositoryRoot, relativePath, {
  hashContents = false,
} = {}) {
  const absolutePath = path.resolve(repositoryRoot, relativePath);
  const relative = path.relative(repositoryRoot, absolutePath);
  if (
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new AttemptWorktreeError(
      "Git returned a path outside the primary checkout",
      { code: "primary_checkout_digest_failed" },
    );
  }

  let stat;
  try {
    stat = fs.lstatSync(absolutePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        exists: false,
        path: relativePath,
      });
    }
    throw error;
  }

  const metadata = {
    exists: true,
    kind: stat.isFile()
      ? "file"
      : stat.isDirectory()
        ? "directory"
        : stat.isSymbolicLink()
          ? "symlink"
          : "other",
    mode: (stat.mode & 0o7777n).toString(8),
    mtime_ns: stat.mtimeNs.toString(),
    path: relativePath,
    size: stat.size.toString(),
  };
  if (stat.isSymbolicLink()) {
    metadata.target = fs.readlinkSync(absolutePath);
  } else if (hashContents && stat.isFile()) {
    metadata.content_git_hash = runGitDigestCommand(
      repositoryRoot,
      ["hash-object", "--no-filters", "--", relativePath],
    ).toString("utf8").trim();
  }
  return Object.freeze(metadata);
}

function primaryCheckoutDigestPathspecs() {
  return [
    ".",
    ...PRIMARY_CHECKOUT_DIGEST_EXCLUDED_DIRECTORIES.flatMap((directoryName) => [
      `:(exclude,top,glob)${directoryName}/**`,
      `:(exclude,glob)**/${directoryName}/**`,
    ]),
  ];
}

function isPrimaryCheckoutDigestExcluded(relativePath) {
  const segments = relativePath.split("/");
  return segments.some((segment) =>
    PRIMARY_CHECKOUT_DIGEST_EXCLUDED_DIRECTORIES.includes(segment));
}

function listPrimaryCheckoutNonTrackedPaths(repositoryRoot, {
  ignored = false,
} = {}) {
  const args = [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ];
  if (ignored) {
    args.push("--ignored");
  }
  args.push("--", ...primaryCheckoutDigestPathspecs());

  return splitNullTerminated(runGitDigestCommand(repositoryRoot, args))
    .filter((relativePath) => !isPrimaryCheckoutDigestExcluded(relativePath))
    .sort();
}

function capturePrimaryCheckoutReadinessDigest(repositoryPath) {
  const repositoryRoot = resolveRepositoryRoot(repositoryPath);
  const trackedPaths = [
    ...splitNullTerminated(runGitDigestCommand(
      repositoryRoot,
      ["diff", "--name-only", "-z", "--"],
    )),
    ...splitNullTerminated(runGitDigestCommand(
      repositoryRoot,
      ["diff", "--cached", "--name-only", "-z", "--"],
    )),
  ];
  const changedTrackedPaths = [...new Set(trackedPaths)].sort();
  const untrackedPaths = listPrimaryCheckoutNonTrackedPaths(repositoryRoot);
  const ignoredPaths = listPrimaryCheckoutNonTrackedPaths(repositoryRoot, {
    ignored: true,
  });
  const evidence = {
    branch: runGitDigestCommand(
      repositoryRoot,
      ["rev-parse", "--abbrev-ref", "HEAD"],
    ).toString("utf8").trim(),
    changed_tracked: changedTrackedPaths.map((relativePath) =>
      readCheckoutPathMetadata(repositoryRoot, relativePath, {
        hashContents: true,
      })),
    head: runGitDigestCommand(
      repositoryRoot,
      ["rev-parse", "HEAD"],
    ).toString("utf8").trim(),
    ignored: ignoredPaths.map((relativePath) =>
      readCheckoutPathMetadata(repositoryRoot, relativePath, {
        hashContents: true,
      })),
    staged_index: runGitDigestCommand(
      repositoryRoot,
      ["ls-files", "--stage", "-z"],
    ).toString("base64"),
    untracked: untrackedPaths.map((relativePath) =>
      readCheckoutPathMetadata(repositoryRoot, relativePath, {
        hashContents: true,
      })),
  };

  return createHash("sha256")
    .update(JSON.stringify(evidence))
    .digest("hex");
}

function assertPrimaryCheckoutUnchanged(before, repositoryRoot) {
  const after = capturePrimaryCheckoutState(repositoryRoot);

  if (
    before.branch !== after.branch
    || before.head !== after.head
    || before.tracked_status !== after.tracked_status
  ) {
    throw new AttemptWorktreeError(
      "attempt worktree operation changed the primary checkout",
      { code: "primary_checkout_changed" },
    );
  }

  return after;
}

function branchExists(repositoryRoot, branchName) {
  try {
    runGitCommand({
      cwd: repositoryRoot,
      args: ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    });
    return true;
  } catch {
    return false;
  }
}

function worktreeRegistration(repositoryRoot, worktreePath) {
  const normalizedPath = fs.realpathSync.native(path.resolve(worktreePath));
  const output = runGitCommand({
    cwd: repositoryRoot,
    args: ["worktree", "list", "--porcelain"],
  }).output;
  const records = output.split(/\r?\n\r?\n/u);

  for (const record of records) {
    const lines = record.split(/\r?\n/u);
    const registeredPath = lines.find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length);

    if (
      registeredPath
      && fs.realpathSync.native(path.resolve(registeredPath)) === normalizedPath
    ) {
      return Object.freeze({
        path: normalizedPath,
        head: lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? null,
        branch_ref: lines.find((line) => line.startsWith("branch "))?.slice(7) ?? null,
      });
    }
  }

  return null;
}

function assertSidecarIdentity(sidecar, {
  taskId,
  attemptId,
  repositoryRoot,
  stateRoot,
  paths,
}) {
  const mismatches = [];
  const expected = {
    attempt_id: attemptId,
    task_id: taskId,
    repository_root: repositoryRoot,
    state_root: stateRoot,
    attempt_root: paths.attempt_root,
    worktree_path: paths.worktree_path,
  };

  for (const [field, expectedValue] of Object.entries(expected)) {
    if (sidecar[field] !== expectedValue) {
      mismatches.push(field);
    }
  }

  if (mismatches.length > 0) {
    throw new AttemptWorktreeError(
      `attempt worktree sidecar identity mismatch: ${mismatches.join(", ")}`,
      { code: "sidecar_identity_mismatch" },
    );
  }
}

function validateReusableWorktree(sidecar, {
  allowPromotionReconciliation = false,
} = {}) {
  if (sidecar.status === "REMOVED") {
    throw new AttemptWorktreeError(
      `attempt worktree ${sidecar.attempt_id} was already removed after success`,
      { code: "attempt_worktree_finalized" },
    );
  }

  if (!fs.existsSync(sidecar.worktree_path)) {
    throw new AttemptWorktreeError(
      `attempt worktree path is missing: ${sidecar.worktree_path}`,
      { code: "attempt_worktree_missing" },
    );
  }

  const registration = worktreeRegistration(
    sidecar.repository_root,
    sidecar.worktree_path,
  );
  if (!registration) {
    throw new AttemptWorktreeError(
      `attempt worktree is not registered: ${sidecar.worktree_path}`,
      { code: "attempt_worktree_unregistered" },
    );
  }

  if (registration.branch_ref !== null) {
    throw new AttemptWorktreeError(
      `attempt worktree must remain detached for ${sidecar.attempt_id}`,
      { code: "attempt_worktree_branch_mismatch" },
    );
  }
  if (sidecar.status === "COMMITTED") {
    if (!branchExists(sidecar.repository_root, sidecar.branch_name)) {
      throw new AttemptWorktreeError(
        `promoted attempt branch is missing for ${sidecar.attempt_id}`,
        { code: "attempt_branch_missing" },
      );
    }
    const branchCommit = runGitCommand({
      cwd: sidecar.repository_root,
      args: ["rev-parse", `refs/heads/${sidecar.branch_name}`],
    }).output;
    if (branchCommit !== sidecar.head_commit) {
      throw new AttemptWorktreeError(
        `promoted attempt branch does not match sidecar for ${sidecar.attempt_id}`,
        { code: "attempt_branch_mismatch" },
      );
    }
  } else if (branchExists(sidecar.repository_root, sidecar.branch_name)) {
    const branchCommit = runGitCommand({
      cwd: sidecar.repository_root,
      args: ["rev-parse", `refs/heads/${sidecar.branch_name}`],
    }).output;
    if (!allowPromotionReconciliation || branchCommit !== registration.head) {
      throw new AttemptWorktreeError(
        `review branch exists before PASS for ${sidecar.attempt_id}`,
        { code: "attempt_branch_published_early" },
      );
    }
  }

  return registration;
}

function createOrReuseAttemptWorktree({
  repositoryPath,
  stateRoot,
  taskId,
  attemptId,
  baseRef = "HEAD",
  now = new Date(),
} = {}) {
  const normalizedTaskId = assertCanonicalTaskId(taskId);
  const normalizedAttemptId = ensureNonEmptyString(attemptId, "attemptId");
  const repositoryRoot = resolveRepositoryRoot(repositoryPath);
  const paths = createAttemptWorktreePaths({
    stateRoot,
    taskId: normalizedTaskId,
    attemptId: normalizedAttemptId,
  });
  const normalizedBaseRef = ensureNonEmptyString(baseRef, "baseRef");
  const branchName = [
    "niis",
    "task",
    sanitizeBranchPart(normalizedTaskId, "taskId"),
    sanitizeBranchPart(normalizedAttemptId, "attemptId"),
  ].join("/");
  const existingSidecar = readAttemptWorktreeSidecar(paths.sidecar_path);

  if (existingSidecar) {
    assertSidecarIdentity(existingSidecar, {
      taskId: normalizedTaskId,
      attemptId: normalizedAttemptId,
      repositoryRoot,
      stateRoot: paths.state_root,
      paths,
    });
    validateReusableWorktree(existingSidecar);
    return Object.freeze({
      ...existingSidecar,
      reused: true,
      sidecar_path: paths.sidecar_path,
    });
  }

  if (fs.existsSync(paths.worktree_path)) {
    throw new AttemptWorktreeError(
      `refusing to replace worktree path without a valid sidecar: ${paths.worktree_path}`,
      { code: "unowned_worktree_path" },
    );
  }

  if (branchExists(repositoryRoot, branchName)) {
    throw new AttemptWorktreeError(
      `refusing to replace existing attempt branch ${branchName}`,
      { code: "attempt_branch_exists" },
    );
  }

  const primaryBefore = capturePrimaryCheckoutState(repositoryRoot);
  const baseCommit = runGitCommand({
    cwd: repositoryRoot,
    args: ["rev-parse", "--verify", `${normalizedBaseRef}^{commit}`],
  }).output;
  const timestamp = ensureIsoTimestamp(now, "now");
  let worktreeCreated = false;

  try {
    fs.mkdirSync(paths.attempt_root, { recursive: true, mode: 0o700 });
    runGitCommand({
      cwd: repositoryRoot,
      args: [
        "worktree",
        "add",
        "--detach",
        paths.worktree_path,
        baseCommit,
      ],
    });
    worktreeCreated = true;

    const headCommit = runGitCommand({
      cwd: paths.worktree_path,
      args: ["rev-parse", "HEAD"],
    }).output;
    const sidecar = writeAttemptWorktreeSidecar(paths.sidecar_path, {
      schema_version: ATTEMPT_WORKTREE_SCHEMA_VERSION,
      attempt_id: normalizedAttemptId,
      task_id: normalizedTaskId,
      repository_root: repositoryRoot,
      state_root: paths.state_root,
      attempt_root: paths.attempt_root,
      worktree_path: paths.worktree_path,
      branch_name: branchName,
      base_ref: normalizedBaseRef,
      base_commit: baseCommit,
      head_commit: headCommit,
      status: "ACTIVE",
      preserve_on_failure: true,
      created_at: timestamp,
      updated_at: timestamp,
      committed_at: null,
      removed_at: null,
      preserved_reason: null,
    });
    assertPrimaryCheckoutUnchanged(primaryBefore, repositoryRoot);

    return Object.freeze({
      ...sidecar,
      reused: false,
      sidecar_path: paths.sidecar_path,
    });
  } catch (error) {
    if (worktreeCreated) {
      try {
        runGitCommand({
          cwd: repositoryRoot,
          args: ["worktree", "remove", "--force", paths.worktree_path],
        });
      } catch {

      }
    }

    if (error instanceof AttemptWorktreeError) {
      throw error;
    }
    throw new AttemptWorktreeError(
      `failed to create attempt worktree: ${error.message}`,
      { code: "attempt_worktree_create_failed" },
    );
  }
}

function resolveOwnedWorktree({
  allowPromotionReconciliation = false,
  sidecarPath = null,
  stateRoot = null,
  taskId = null,
  attemptId = null,
} = {}) {
  const resolvedSidecarPath = sidecarPath
    ? canonicalizePath(sidecarPath)
    : createAttemptWorktreePaths({ stateRoot, taskId, attemptId }).sidecar_path;
  const sidecar = readAttemptWorktreeSidecar(resolvedSidecarPath);

  if (!sidecar) {
    throw new AttemptWorktreeError(
      `attempt worktree sidecar not found: ${resolvedSidecarPath}`,
      { code: "sidecar_missing" },
    );
  }
  const expectedPaths = createAttemptWorktreePaths({
    stateRoot: sidecar.state_root,
    taskId: sidecar.task_id,
    attemptId: sidecar.attempt_id,
  });
  assertSidecarIdentity(sidecar, {
    taskId: sidecar.task_id,
    attemptId: sidecar.attempt_id,
    repositoryRoot: sidecar.repository_root,
    stateRoot: expectedPaths.state_root,
    paths: expectedPaths,
  });
  if (canonicalizePath(expectedPaths.sidecar_path) !== resolvedSidecarPath) {
    throw new AttemptWorktreeError(
      "sidecarPath does not match the attempt-owned sidecar location",
      { code: "sidecar_identity_mismatch" },
    );
  }

  if (attemptId !== null && sidecar.attempt_id !== attemptId) {
    throw new AttemptWorktreeError("attemptId does not match worktree sidecar");
  }
  if (taskId !== null && sidecar.task_id !== taskId) {
    throw new AttemptWorktreeError("taskId does not match worktree sidecar");
  }

  validateReusableWorktree(sidecar, { allowPromotionReconciliation });
  return Object.freeze({
    sidecar,
    sidecar_path: resolvedSidecarPath,
  });
}

function captureAttemptWorktreeDiff(options = {}) {
  const owned = resolveOwnedWorktree(options);
  const { sidecar } = owned;
  const primaryBefore = capturePrimaryCheckoutState(sidecar.repository_root);
  const headCommit = runGitCommand({
    cwd: sidecar.worktree_path,
    args: ["rev-parse", "HEAD"],
  }).output;
  const baseTree = runGitCommand({
    cwd: sidecar.worktree_path,
    args: ["rev-parse", `${sidecar.base_commit}^{tree}`],
  }).output;
  const headTree = runGitCommand({
    cwd: sidecar.worktree_path,
    args: ["rev-parse", `${headCommit}^{tree}`],
  }).output;
  const status = runGitCommand({
    cwd: sidecar.worktree_path,
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
  }).output;
  const trackedDiff = runGitCommand({
    cwd: sidecar.worktree_path,
    args: [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-renames",
      sidecar.base_commit,
      "--",
    ],
  }).output;
  const committedDiff = runGitCommand({
    cwd: sidecar.worktree_path,
    args: [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-renames",
      sidecar.base_commit,
      headCommit,
      "--",
    ],
  }).output;
  const uncommittedTrackedDiff = runGitCommand({
    cwd: sidecar.worktree_path,
    args: ["diff", "--binary", "--no-ext-diff", "--no-renames", "HEAD", "--"],
  }).output;
  const trackedFiles = splitNullTerminated(runGitDigestCommand(
    sidecar.worktree_path,
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      sidecar.base_commit,
      "--",
    ],
  ));
  const untrackedFiles = splitNullTerminated(runGitDigestCommand(
    sidecar.worktree_path,
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ));
  const changedFiles = [...new Set([
    ...trackedFiles,
    ...untrackedFiles,
  ])].sort();
  const taskSnapshot = changedFiles.map((relativePath) =>
    readTaskDeltaEntry(sidecar.worktree_path, relativePath));
  const taskSnapshotSha256 = createHash("sha256")
    .update(JSON.stringify({
      base_commit: sidecar.base_commit,
      entries: taskSnapshot,
    }))
    .digest("hex");
  const untrackedDiff = untrackedFiles
    .map((relativePath) =>
      runGitNoIndexDiff(sidecar.worktree_path, relativePath))
    .filter(Boolean)
    .join("\n");
  const fullDiff = [trackedDiff, untrackedDiff]
    .filter(Boolean)
    .join("\n");
  assertPrimaryCheckoutUnchanged(primaryBefore, sidecar.repository_root);

  return Object.freeze({
    attempt_id: sidecar.attempt_id,
    task_id: sidecar.task_id,
    worktree_path: sidecar.worktree_path,
    base_commit: sidecar.base_commit,
    base_tree: baseTree,
    head_commit: headCommit,
    head_tree: headTree,
    status,
    committed_diff: committedDiff,
    full_diff: fullDiff,
    review_diff: fullDiff,
    tracked_diff: trackedDiff,
    uncommitted_tracked_diff: uncommittedTrackedDiff,
    untracked_diff: untrackedDiff,
    changed_files: Object.freeze(changedFiles),
    untracked_files: Object.freeze([...new Set(untrackedFiles)].sort()),
    has_committed_changes: headTree !== baseTree,
    has_task_delta: changedFiles.length > 0,
    has_uncommitted_changes: status !== "",
    task_snapshot: Object.freeze(taskSnapshot),
    task_snapshot_sha256: taskSnapshotSha256,
    worktree_clean: status === "",
    clean: status === "",
  });
}

function ensureAttemptWorktreePromotionCommit({
  canonicalVerdict,
  expectedTaskSnapshotSha256,
  message = null,
  authorName = "niis",
  authorEmail = "niis@local",
  failAfterStep = null,
  now = new Date(),
  ...worktreeOptions
} = {}) {
  if (canonicalVerdict !== "PASS") {
    throw new AttemptWorktreeError(
      "attempt worktree commit requires canonicalVerdict PASS",
      { code: "promotion_gate_not_passed" },
    );
  }
  const expectedSnapshot = ensureNonEmptyString(
    expectedTaskSnapshotSha256,
    "expectedTaskSnapshotSha256",
  ).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expectedSnapshot)) {
    throw new AttemptWorktreeError(
      "expectedTaskSnapshotSha256 must be a SHA-256 digest from fresh review",
      { code: "review_snapshot_invalid" },
    );
  }

  const owned = resolveOwnedWorktree({
    ...worktreeOptions,
    allowPromotionReconciliation: true,
  });
  let { sidecar } = owned;
  const { sidecar_path: sidecarPath } = owned;
  const primaryBefore = capturePrimaryCheckoutState(sidecar.repository_root);
  const before = captureAttemptWorktreeDiff({
    allowPromotionReconciliation: true,
    sidecarPath,
  });
  if (before.task_snapshot_sha256 !== expectedSnapshot) {
    throw new AttemptWorktreeError(
      "attempt task delta changed after fresh review",
      { code: "reviewed_task_delta_changed" },
    );
  }

  const isRecordedPromotion = (
    sidecar.status === "COMMITTED"
    && sidecar.head_commit === before.head_commit
  );
  const existingIntent = sidecar.promotion_intent;
  if (
    existingIntent
    && (
      existingIntent.expected_task_snapshot_sha256 !== expectedSnapshot
      || existingIntent.base_commit !== sidecar.base_commit
    )
  ) {
    throw new AttemptWorktreeError(
      "durable promotion intent does not match the reviewed task delta",
      { code: "promotion_intent_mismatch" },
    );
  }
  if (
    before.head_commit !== before.base_commit
    && !isRecordedPromotion
    && !existingIntent
  ) {
    throw new AttemptWorktreeError(
      "attempt worktree contains a commit created before promotion",
      { code: "pre_review_commit_forbidden" },
    );
  }

  let createdCommit = false;
  let stagedDiff = "";
  let intendedTree = before.head_tree;
  const timestamp = ensureIsoTimestamp(now, "now");
  const commitMessage =
    message ?? `niis: task ${sidecar.task_id} attempt ${sidecar.attempt_id}`;
  const normalizedAuthorName = ensureNonEmptyString(authorName, "authorName");
  const normalizedAuthorEmail = ensureNonEmptyString(authorEmail, "authorEmail");
  let activeIntent = existingIntent;

  if (before.head_commit === before.base_commit && !before.clean) {
    runGitCommand({
      cwd: sidecar.worktree_path,
      args: ["add", "--all", "--"],
    });
    stagedDiff = runGitCommand({
      cwd: sidecar.worktree_path,
      args: [
        "diff",
        "--cached",
        "--binary",
        "--no-ext-diff",
        "--no-renames",
        "HEAD",
        "--",
      ],
    }).output;

    if (!stagedDiff) {
      throw new AttemptWorktreeError(
        "worktree reported changes but produced no staged task diff",
        { code: "empty_staged_diff" },
      );
    }

    intendedTree = runGitCommand({
      cwd: sidecar.worktree_path,
      args: ["write-tree"],
    }).output;

    if (!activeIntent) {
      activeIntent = {
        author_date: timestamp,
        author_email: normalizedAuthorEmail,
        author_name: normalizedAuthorName,
        base_commit: sidecar.base_commit,
        committer_date: timestamp,
        created_at: timestamp,
        expected_commit: null,
        expected_task_snapshot_sha256: expectedSnapshot,
        expected_tree: intendedTree,
        message: commitMessage,
      };
      sidecar = writeAttemptWorktreeSidecar(sidecarPath, {
        ...sidecar,
        promotion_intent: activeIntent,
        updated_at: timestamp,
      });
      activeIntent = sidecar.promotion_intent;
      maybeFailPromotionStep(failAfterStep, "intent");
    } else if (
      activeIntent.expected_tree !== intendedTree
      || activeIntent.message !== commitMessage
      || activeIntent.author_name !== normalizedAuthorName
      || activeIntent.author_email !== normalizedAuthorEmail
    ) {
      throw new AttemptWorktreeError(
        "task delta or commit identity changed after durable promotion intent",
        { code: "promotion_intent_mismatch" },
      );
    }

    const expectedCommit = runDeterministicGit({
      args: [
        "commit-tree",
        activeIntent.expected_tree,
        "-p",
        activeIntent.base_commit,
      ],
      cwd: sidecar.worktree_path,
      env: {
        GIT_AUTHOR_DATE: activeIntent.author_date,
        GIT_AUTHOR_EMAIL: activeIntent.author_email,
        GIT_AUTHOR_NAME: activeIntent.author_name,
        GIT_COMMITTER_DATE: activeIntent.committer_date,
        GIT_COMMITTER_EMAIL: activeIntent.author_email,
        GIT_COMMITTER_NAME: activeIntent.author_name,
      },
      input: `${activeIntent.message}\n`,
    });
    if (
      activeIntent.expected_commit
      && activeIntent.expected_commit !== expectedCommit
    ) {
      throw new AttemptWorktreeError(
        "deterministic promotion commit does not match durable intent",
        { code: "promotion_intent_mismatch" },
      );
    }
    if (!activeIntent.expected_commit) {
      sidecar = writeAttemptWorktreeSidecar(sidecarPath, {
        ...sidecar,
        promotion_intent: {
          ...activeIntent,
          expected_commit: expectedCommit,
        },
        updated_at: timestamp,
      });
      activeIntent = sidecar.promotion_intent;
    }
    maybeFailPromotionStep(failAfterStep, "commit_object");
    runDeterministicGit({
      args: [
        "update-ref",
        "HEAD",
        expectedCommit,
        sidecar.base_commit,
      ],
      cwd: sidecar.worktree_path,
    });
    createdCommit = true;
    maybeFailPromotionStep(failAfterStep, "commit");
  } else if (
    before.head_commit !== before.base_commit
    && !isRecordedPromotion
    && activeIntent
  ) {
    if (
      !activeIntent.expected_commit
      || before.head_commit !== activeIntent.expected_commit
      || before.head_tree !== activeIntent.expected_tree
    ) {
      throw new AttemptWorktreeError(
        "worktree HEAD does not match the durable promotion intent",
        { code: "promotion_intent_mismatch" },
      );
    }
    const parentCommit = runGitCommand({
      cwd: sidecar.worktree_path,
      args: ["rev-parse", `${before.head_commit}^`],
    }).output;
    if (parentCommit !== activeIntent.base_commit) {
      throw new AttemptWorktreeError(
        "promotion commit parent does not match durable intent",
        { code: "promotion_intent_mismatch" },
      );
    }
    intendedTree = activeIntent.expected_tree;
  }

  const after = captureAttemptWorktreeDiff({
    allowPromotionReconciliation: true,
    sidecarPath,
  });
  if (!after.clean) {
    throw new AttemptWorktreeError(
      "attempt worktree changed while preparing the promotion commit",
      { code: "promotion_snapshot_changed" },
    );
  }
  if (after.head_tree !== intendedTree) {
    throw new AttemptWorktreeError(
      "promotion commit tree does not match the staged task snapshot",
      { code: "promotion_tree_mismatch" },
    );
  }
  if (after.task_snapshot_sha256 !== before.task_snapshot_sha256) {
    throw new AttemptWorktreeError(
      "promotion commit does not match the task delta presented for review",
      { code: "promotion_snapshot_changed" },
    );
  }

  if (!after.has_task_delta) {
    assertPrimaryCheckoutUnchanged(primaryBefore, sidecar.repository_root);
    return Object.freeze({
      already_committed: false,
      branch_created: false,
      committed: createdCommit,
      commit_sha: after.head_commit,
      diff: Object.freeze({
        ...before,
        staged_diff: stagedDiff,
      }),
      had_changes: false,
      promotion_ready: false,
      sidecar,
      task_snapshot_sha256: after.task_snapshot_sha256,
      verified_diff: after,
      worktree_clean: true,
    });
  }

  let branchCreated = false;
  if (branchExists(sidecar.repository_root, sidecar.branch_name)) {
    const existingBranchCommit = runGitCommand({
      cwd: sidecar.repository_root,
      args: ["rev-parse", `refs/heads/${sidecar.branch_name}`],
    }).output;
    if (existingBranchCommit !== after.head_commit) {
      throw new AttemptWorktreeError(
        `refusing to replace review branch ${sidecar.branch_name}`,
        { code: "attempt_branch_mismatch" },
      );
    }
  } else {
    runDeterministicGit({
      cwd: sidecar.repository_root,
      args: [
        "update-ref",
        `refs/heads/${sidecar.branch_name}`,
        after.head_commit,
        "0000000000000000000000000000000000000000",
      ],
    });
    branchCreated = true;
  }
  maybeFailPromotionStep(failAfterStep, "branch");

  const updatedSidecar = (
    sidecar.head_commit === after.head_commit
    && sidecar.status === "COMMITTED"
  )
    ? sidecar
    : writeAttemptWorktreeSidecar(sidecarPath, {
        ...sidecar,
        head_commit: after.head_commit,
        status: "COMMITTED",
        updated_at: timestamp,
        committed_at: sidecar.committed_at ?? timestamp,
        preserved_reason: null,
        promotion_intent: null,
      });
  assertPrimaryCheckoutUnchanged(primaryBefore, sidecar.repository_root);

  return Object.freeze({
    already_committed: !createdCommit,
    branch_created: branchCreated,
    committed: createdCommit,
    commit_sha: after.head_commit,
    had_changes: true,
    promotion_ready: true,
    task_snapshot_sha256: after.task_snapshot_sha256,
    verified_diff: after,
    worktree_clean: true,
    diff: Object.freeze({
      ...before,
      staged_diff: stagedDiff,
    }),
    sidecar: updatedSidecar,
  });
}

const commitAttemptWorktreeChanges = ensureAttemptWorktreePromotionCommit;

function preserveAttemptWorktree({
  reason,
  now = new Date(),
  ...worktreeOptions
} = {}) {
  const owned = resolveOwnedWorktree(worktreeOptions);
  const timestamp = ensureIsoTimestamp(now, "now");
  const updated = writeAttemptWorktreeSidecar(owned.sidecar_path, {
    ...owned.sidecar,
    status: "PRESERVED",
    updated_at: timestamp,
    preserved_reason: ensureNonEmptyString(reason, "reason"),
  });

  return Object.freeze({
    preserved: true,
    removed: false,
    sidecar: updated,
    sidecar_path: owned.sidecar_path,
    worktree_path: updated.worktree_path,
  });
}

function removeAttemptWorktreeOnSuccess({
  success,
  now = new Date(),
  ...worktreeOptions
} = {}) {
  if (success !== true) {
    throw new AttemptWorktreeError(
      "attempt worktree removal requires success === true",
      { code: "explicit_success_required" },
    );
  }

  const owned = resolveOwnedWorktree(worktreeOptions);
  const { sidecar } = owned;
  const primaryBefore = capturePrimaryCheckoutState(sidecar.repository_root);
  const diff = captureAttemptWorktreeDiff({ sidecarPath: owned.sidecar_path });

  if (!diff.clean) {
    throw new AttemptWorktreeError(
      "refusing to remove an attempt worktree with uncommitted changes",
      { code: "dirty_attempt_worktree" },
    );
  }

  runGitCommand({
    cwd: sidecar.repository_root,
    args: ["worktree", "remove", sidecar.worktree_path],
  });

  if (fs.existsSync(sidecar.worktree_path)) {
    throw new AttemptWorktreeError(
      `Git reported success but worktree still exists: ${sidecar.worktree_path}`,
      { code: "attempt_worktree_remove_failed" },
    );
  }

  const timestamp = ensureIsoTimestamp(now, "now");
  const updated = writeAttemptWorktreeSidecar(owned.sidecar_path, {
    ...sidecar,
    status: "REMOVED",
    updated_at: timestamp,
    removed_at: timestamp,
    preserved_reason: null,
  });
  assertPrimaryCheckoutUnchanged(primaryBefore, sidecar.repository_root);

  return Object.freeze({
    branch_name: updated.branch_name,
    branch_preserved: branchExists(
      updated.repository_root,
      updated.branch_name,
    ),
    preserved: false,
    removed: true,
    sidecar: updated,
    sidecar_path: owned.sidecar_path,
    worktree_path: updated.worktree_path,
  });
}

function finalizeAttemptWorktree({
  outcome,
  reason = null,
  ...worktreeOptions
} = {}) {
  if (outcome === "success") {
    return removeAttemptWorktreeOnSuccess({
      ...worktreeOptions,
      success: true,
    });
  }

  return preserveAttemptWorktree({
    ...worktreeOptions,
    reason: reason ?? `attempt outcome ${outcome ?? "unknown"} requires preservation`,
  });
}

const prepareAttemptWorktree = createOrReuseAttemptWorktree;

export {
  ATTEMPT_WORKTREE_SCHEMA_VERSION,
  ATTEMPT_WORKTREE_SIDECAR_FILENAME,
  ATTEMPT_WORKTREE_STATUSES,
  AttemptWorktreeError,
  captureAttemptWorktreeDiff,
  capturePrimaryCheckoutReadinessDigest,
  commitAttemptWorktreeChanges,
  createAttemptWorktreePaths,
  createOrReuseAttemptWorktree,
  ensureAttemptWorktreePromotionCommit,
  finalizeAttemptWorktree,
  normalizeAttemptWorktreeSidecar,
  prepareAttemptWorktree,
  preserveAttemptWorktree,
  readAttemptWorktreeSidecar,
  removeAttemptWorktreeOnSuccess,
  resolveRepositoryRoot,
};
