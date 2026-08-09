import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { capturePrimaryCheckoutReadinessDigest } from "../../core/src/runtime/attempt-worktree.js";

const DAEMON_READINESS_SCHEMA_VERSION = 3;
const DAEMON_READINESS_EVIDENCE_SCHEMA_VERSION = 2;
const DURABLE_CANARY_EVIDENCE_SCHEMA_VERSION = 2;
const MINIMUM_CLEAN_CANARY_TASKS = 20;
const REQUIRED_CLEAN_INVARIANTS = Object.freeze([
  "no_task_loss",
  "no_duplicate_attempt",
  "primary_checkout_unchanged",
  "no_early_promotion",
  "budget_within_limit",
]);
const REQUIRED_ROLLOUT_PHASES = Object.freeze([
  "disposable_fixture",
  "self_hosted",
  "runtime_a",
  "runtime_b",
]);
const REQUIRED_DURABLE_STEP_STAGES = Object.freeze([
  "GATES_RUN",
  "REVIEWED",
  "PROMOTED",
  "FINISHED",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const READINESS_LOCK_STALE_MS = 60_000;

function createDaemonReadinessPath(stateRoot) {
  if (typeof stateRoot !== "string" || stateRoot.trim() === "") {
    throw new Error("stateRoot is required");
  }
  return path.join(stateRoot, "reliability", "canary-readiness.json");
}

function inspectReadinessStorage(recordPath, {
  createDirectory = false,
} = {}) {
  const normalizedRecordPath = path.resolve(recordPath);
  const directory = path.dirname(normalizedRecordPath);
  const stateRoot = path.dirname(directory);
  const expectedDirectory = path.join(stateRoot, "reliability");
  if (directory !== expectedDirectory) {
    return { ok: false, reason: "unsafe_readiness_path" };
  }
  let stateStat;
  try {
    stateStat = fs.lstatSync(stateRoot);
  } catch {
    return { ok: false, reason: "unsafe_readiness_path" };
  }
  if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
    return { ok: false, reason: "unsafe_readiness_path" };
  }
  const canonicalStateRoot = fs.realpathSync.native(stateRoot);

  let directoryStat;
  try {
    directoryStat = fs.lstatSync(directory);
  } catch (error) {
    if (error?.code !== "ENOENT" || !createDirectory) {
      return error?.code === "ENOENT"
        ? { directory_missing: true, ok: true, record_exists: false }
        : { ok: false, reason: "unsafe_readiness_path" };
    }
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      directoryStat = fs.lstatSync(directory);
    } catch {
      return { ok: false, reason: "unsafe_readiness_path" };
    }
  }
  if (
    directoryStat.isSymbolicLink()
    || !directoryStat.isDirectory()
    || fs.realpathSync.native(directory)
      !== path.join(canonicalStateRoot, "reliability")
  ) {
    return { ok: false, reason: "unsafe_readiness_path" };
  }

  let recordStat;
  try {
    recordStat = fs.lstatSync(normalizedRecordPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: true, record_exists: false };
    }
    return { ok: false, reason: "unsafe_readiness_path" };
  }
  if (recordStat.isSymbolicLink() || !recordStat.isFile()) {
    return { ok: false, reason: "unsafe_readiness_path" };
  }
  return { ok: true, record_exists: true };
}

function invalidReadiness(recordPath, reason, details = {}) {
  return Object.freeze({
    ...details,
    ready: false,
    reason,
    record_path: recordPath,
    required_consecutive_clean_tasks: MINIMUM_CLEAN_CANARY_TASKS,
  });
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error("readiness evidence must be JSON serializable");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function normalizeIsoTimestamp(value) {
  return new Date(value).toISOString();
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(
    path.resolve(rootPath),
    path.resolve(candidatePath),
  );
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeChangedPaths(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    throw new Error("changedFiles must contain at least one repository-relative path");
  }
  return [...new Set(changedFiles.map((entry) => {
    if (!isNonEmptyString(entry)) {
      throw new Error("changedFiles entries must be non-empty strings");
    }
    const normalized = entry.replaceAll("\\", "/").replace(/^\.\/+/u, "");
    if (
      normalized === ""
      || path.posix.isAbsolute(normalized)
      || normalized === ".."
      || normalized.startsWith("../")
      || normalized.includes("/../")
    ) {
      throw new Error("changedFiles entries must remain inside the repository");
    }
    return normalized;
  }))].sort();
}

function normalizeSelfHostScope(selfHostScope) {
  if (selfHostScope === null || selfHostScope === undefined) return null;
  if (!isNonEmptyString(selfHostScope)) {
    throw new Error("selfHostScope must be null or a repository-relative path");
  }
  const normalized = selfHostScope
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "")
    .replace(/\/+$/u, "");
  if (normalized === "" || normalized === ".") return ".";
  if (
    path.posix.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
  ) {
    throw new Error("selfHostScope must remain inside the repository");
  }
  return normalized;
}

function createReadinessRepositoryIdentityFromComponents({
  gitCommonDirectory,
  originUrl = null,
  repositoryRoot,
  rootCommits,
} = {}) {
  if (
    !isNonEmptyString(repositoryRoot)
    || !isNonEmptyString(gitCommonDirectory)
    || !Array.isArray(rootCommits)
    || rootCommits.length === 0
    || rootCommits.some((commit) => !isNonEmptyString(commit))
  ) {
    throw new Error("complete repository identity components are required");
  }
  if (originUrl !== null && !isNonEmptyString(originUrl)) {
    throw new Error("originUrl must be null or a non-empty string");
  }
  const repositoryRootPath = path.resolve(repositoryRoot);
  const commonDirectoryPath = path.resolve(gitCommonDirectory);
  const commonDirectorySha256 = sha256({
    git_common_directory: commonDirectoryPath,
  });
  const originSha256 = originUrl === null
    ? null
    : sha256({ origin_url: originUrl.trim() });
  const rootCommitsSha256 = sha256(
    [...new Set(rootCommits.map((commit) => commit.trim()))].sort(),
  );
  return Object.freeze({
    common_directory_sha256: commonDirectorySha256,
    identity_sha256: sha256({
      common_directory_sha256: commonDirectorySha256,
      origin_sha256: originSha256,
      repository_root: repositoryRootPath,
      root_commits_sha256: rootCommitsSha256,
    }),
    origin_sha256: originSha256,
    root_commits_sha256: rootCommitsSha256,
  });
}

function runReadinessGit(repositoryRoot, args, {
  allowFailure = false,
} = {}) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(
      `repository identity command failed: git ${args.join(" ")}: `
      + `${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`,
    );
  }
  return result.stdout.trim();
}

function createReadinessRepositoryIdentity(repositoryRoot) {
  if (!isNonEmptyString(repositoryRoot)) {
    throw new Error("repositoryRoot is required");
  }
  const rootStat = fs.lstatSync(repositoryRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("repositoryRoot must be a real directory");
  }
  const canonicalRepositoryRoot = fs.realpathSync.native(
    path.resolve(repositoryRoot),
  );
  const reportedRoot = runReadinessGit(
    canonicalRepositoryRoot,
    ["rev-parse", "--show-toplevel"],
  );
  if (
    fs.realpathSync.native(path.resolve(reportedRoot))
    !== canonicalRepositoryRoot
  ) {
    throw new Error("repositoryRoot is not the exact Git toplevel");
  }
  const commonDirectoryOutput = runReadinessGit(
    canonicalRepositoryRoot,
    ["rev-parse", "--git-common-dir"],
  );
  const commonDirectory = fs.realpathSync.native(
    path.resolve(canonicalRepositoryRoot, commonDirectoryOutput),
  );
  const rootCommits = runReadinessGit(
    canonicalRepositoryRoot,
    ["rev-list", "--max-parents=0", "--all"],
  ).split(/\r?\n/u).filter(Boolean);
  const originUrl = runReadinessGit(
    canonicalRepositoryRoot,
    ["remote", "get-url", "origin"],
    { allowFailure: true },
  );
  return createReadinessRepositoryIdentityFromComponents({
    gitCommonDirectory: commonDirectory,
    originUrl: originUrl || null,
    repositoryRoot: canonicalRepositoryRoot,
    rootCommits,
  });
}

function createReadinessRepositoryIdentityDigest(repositoryRoot) {
  return createReadinessRepositoryIdentity(repositoryRoot).identity_sha256;
}

function createReadinessChangedPathsDigest(changedFiles) {
  return sha256(normalizeChangedPaths(changedFiles));
}

function normalizeReadinessRuntimeFamily(adapterId) {
  if (!isNonEmptyString(adapterId)) return null;
  const normalized = adapterId.trim().toLowerCase();
  if (["codex_local", "codex_app_server"].includes(normalized)) {
    return "codex";
  }
  if (["claude_code_local", "claude-code"].includes(normalized)) {
    return "claude";
  }
  return "other";
}

function classifyReadinessRepository({
  changedFiles,
  repositoryRoot,
  selfHostScope = null,
} = {}) {
  if (!isNonEmptyString(repositoryRoot)) {
    throw new Error("repositoryRoot is required");
  }
  const normalizedChangedFiles = normalizeChangedPaths(changedFiles);
  const normalizedSelfHostScope = normalizeSelfHostScope(selfHostScope);
  let temporaryRoot = path.resolve(os.tmpdir());
  try {
    temporaryRoot = fs.realpathSync.native(temporaryRoot);
  } catch {


  }
  const normalizedRepositoryRoot = path.resolve(repositoryRoot);
  if (isPathInside(temporaryRoot, normalizedRepositoryRoot)) {
    return "disposable_fixture";
  }
  if (
    normalizedSelfHostScope !== null
    && normalizedChangedFiles.every((relativePath) =>
      normalizedSelfHostScope === "."
      || relativePath === normalizedSelfHostScope
      || relativePath.startsWith(`${normalizedSelfHostScope}/`))
  ) {
    return "self_hosted";
  }
  return "project";
}

function createReadinessSourceIdentity({
  sourceProjectId,
  sourceStateRoot,
} = {}) {
  if (!isNonEmptyString(sourceProjectId)) {
    throw new Error("sourceProjectId is required");
  }
  if (!isNonEmptyString(sourceStateRoot)) {
    throw new Error("sourceStateRoot is required");
  }
  const stateStat = fs.lstatSync(sourceStateRoot);
  if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
    throw new Error("sourceStateRoot must be a real directory, not a symlink");
  }
  const canonicalStateRoot = fs.realpathSync.native(
    path.resolve(sourceStateRoot),
  );
  if (path.basename(canonicalStateRoot) !== ".niis") {
    throw new Error("sourceStateRoot must be an exact .niis directory");
  }
  const projectId = sourceProjectId.trim();
  return Object.freeze({
    project_id: projectId,
    state_root: canonicalStateRoot,
    state_root_identity_sha256: sha256({
      project_id: projectId,
      state_root: canonicalStateRoot,
    }),
  });
}

function validateReadinessSourceIdentity(source) {
  if (
    !isPlainObject(source)
    || !isNonEmptyString(source.project_id)
    || !isNonEmptyString(source.state_root)
    || path.basename(path.resolve(source.state_root)) !== ".niis"
    || !isSha256(source.state_root_identity_sha256)
    || source.state_root_identity_sha256 !== sha256({
      project_id: source.project_id,
      state_root: path.resolve(source.state_root),
    })
  ) {
    return { ok: false, reason: "readiness_source_identity_invalid" };
  }
  return { ok: true };
}

function assertLifecycleReadinessStore(store) {
  const requiredMethods = [
    "attempts.byId",
    "attempts.list",
    "attempts.listByTask",
    "attempts.step",
    "outbox.list",
    "promotions.byAttempt",
    "queue.byTask",
    "queue.list",
  ];
  for (const methodPath of requiredMethods) {
    const [group, method] = methodPath.split(".");
    if (typeof store?.[group]?.[method] !== "function") {
      throw new Error(`store.${methodPath}() is required`);
    }
  }
  return store;
}

async function createQueueIntegrityCheckpoint({
  store,
  through,
  windowStartedAt,
} = {}) {
  const normalizedStore = assertLifecycleReadinessStore(store);
  if (!isIsoTimestamp(windowStartedAt) || !isIsoTimestamp(through)) {
    throw new Error("queue integrity window requires ISO timestamps");
  }
  const windowStart = normalizeIsoTimestamp(windowStartedAt);
  const windowEnd = normalizeIsoTimestamp(through);
  if (Date.parse(windowEnd) < Date.parse(windowStart)) {
    throw new Error("queue integrity window end precedes its start");
  }
  const [queueEntries, outboxEvents] = await Promise.all([
    normalizedStore.queue.list(),
    normalizedStore.outbox.list(),
  ]);
  if (!Array.isArray(queueEntries) || !Array.isArray(outboxEvents)) {
    throw new Error("queue and outbox history must be arrays");
  }
  const relevantEvents = outboxEvents.filter((event) =>
    isIsoTimestamp(event?.created_at)
    && Date.parse(event.created_at) >= Date.parse(windowStart)
    && Date.parse(event.created_at) <= Date.parse(windowEnd));
  if (relevantEvents.length === 0) {
    throw new Error("queue integrity window contains no durable outbox events");
  }
  if (relevantEvents.some((event) =>
    event.operation === "REMOVE" || !isIsoTimestamp(event.delivered_at))) {
    throw new Error("queue integrity window contains removal or undelivered events");
  }
  const taskIds = [...new Set(
    relevantEvents.map((event) => event.task_id),
  )].sort();
  const queueByTask = new Map(
    queueEntries.map((entry) => [entry.task_id, entry]),
  );
  const taskRecords = [];
  for (const taskId of taskIds) {
    const queueEntry = queueByTask.get(taskId) ?? null;
    if (
      !queueEntry
      || queueEntry.state !== "COMPLETED"
      || !isIsoTimestamp(queueEntry.created_at)
      || Date.parse(queueEntry.created_at) < Date.parse(windowStart)
      || Date.parse(queueEntry.created_at) > Date.parse(windowEnd)
      || !isIsoTimestamp(queueEntry.updated_at)
      || Date.parse(queueEntry.updated_at) > Date.parse(windowEnd)
      || !isNonEmptyString(queueEntry.payload?.attempt_id)
      || queueEntry.payload?.canonical_verdict !== "PASS"
    ) {
      throw new Error(`queue task ${taskId} is not a completed PASS in the window`);
    }
    const attempts = await normalizedStore.attempts.listByTask(taskId);
    if (
      !Array.isArray(attempts)
      || attempts.length !== 1
      || attempts[0]?.id !== queueEntry.payload.attempt_id
      || attempts[0]?.stage !== "FINISHED"
      || attempts[0]?.canonical_verdict !== "PASS"
    ) {
      throw new Error(`queue task ${taskId} does not have exactly one FINISHED PASS attempt`);
    }
    taskRecords.push({
      attempt_id: attempts[0].id,
      queue_version: queueEntry.version,
      task_id: taskId,
    });
  }
  return Object.freeze({
    event_count: relevantEvents.length,
    event_sequence_sha256: sha256(relevantEvents.map((event) => ({
      created_at: normalizeIsoTimestamp(event.created_at),
      delivered_at: normalizeIsoTimestamp(event.delivered_at),
      event_id: event.event_id,
      operation: event.operation,
      sequence_id: event.sequence_id,
      task_id: event.task_id,
    }))),
    task_count: taskRecords.length,
    tasks_sha256: sha256(taskRecords),
    through: windowEnd,
    window_started_at: windowStart,
  });
}

function validateConsecutiveAttemptTail(allAttempts, entries) {
  if (!Array.isArray(allAttempts)) {
    return { ok: false, reason: "durable_attempt_sequence_unavailable" };
  }
  const expectedIds = entries.map((entry) => entry.attempt_id);
  if (expectedIds.length === 0) {
    return { ok: true };
  }
  const firstIndex = allAttempts.findIndex(
    (attempt) => attempt?.id === expectedIds[0],
  );
  if (firstIndex < 0) {
    return { ok: false, reason: "durable_attempt_sequence_missing" };
  }
  const actualIds = allAttempts
    .slice(firstIndex)
    .map((attempt) => attempt?.id);
  if (
    actualIds.length !== expectedIds.length
    || actualIds.some((attemptId, index) => attemptId !== expectedIds[index])
  ) {
    return { ok: false, reason: "canary_attempts_not_consecutive" };
  }
  return { ok: true };
}

async function loadDurableReadinessBundle({ store, attemptId, taskId }) {
  const normalizedStore = assertLifecycleReadinessStore(store);
  const [attempt, promotion, queueEntry, taskAttempts, ...steps] =
    await Promise.all([
      normalizedStore.attempts.byId(attemptId),
      normalizedStore.promotions.byAttempt(attemptId),
      normalizedStore.queue.byTask(taskId),
      normalizedStore.attempts.listByTask(taskId),
      ...REQUIRED_DURABLE_STEP_STAGES.map((stage) =>
        normalizedStore.attempts.step({ attemptId, stage })),
    ]);

  return Object.freeze({
    attempt,
    promotion,
    queue_entry: queueEntry,
    task_attempts: Array.isArray(taskAttempts)
      ? [...taskAttempts].sort((left, right) =>
          String(left?.id ?? "").localeCompare(String(right?.id ?? "")))
      : taskAttempts,
    steps: Object.freeze(Object.fromEntries(
      REQUIRED_DURABLE_STEP_STAGES.map((stage, index) => [stage, steps[index]]),
    )),
  });
}

function validateDurableReadinessBundle(bundle, {
  attemptId,
  resolveRepositoryIdentity = createReadinessRepositoryIdentity,
  taskId,
}) {
  const attempt = bundle.attempt;
  if (
    !attempt
    || attempt.id !== attemptId
    || attempt.task_id !== taskId
    || attempt.stage !== "FINISHED"
    || attempt.canonical_verdict !== "PASS"
    || !isIsoTimestamp(attempt.finished_at)
  ) {
    return { ok: false, reason: "attempt_not_finished_pass" };
  }

  const promotion = bundle.promotion;
  if (
    !promotion
    || promotion.attempt_id !== attemptId
    || promotion.task_id !== taskId
    || promotion.status !== "PROMOTED"
    || !isNonEmptyString(promotion.target_ref)
    || !isIsoTimestamp(promotion.promoted_at)
    || promotion.metadata?.auto_merge !== false
  ) {
    return { ok: false, reason: "promotion_not_reviewable" };
  }

  const queueEntry = bundle.queue_entry;
  if (
    !queueEntry
    || queueEntry.task_id !== taskId
    || queueEntry.state !== "COMPLETED"
    || queueEntry.payload?.attempt_id !== attemptId
    || queueEntry.payload?.canonical_verdict !== "PASS"
    || !isIsoTimestamp(queueEntry.updated_at)
    || Date.parse(queueEntry.updated_at) < Date.parse(attempt.finished_at)
  ) {
    return { ok: false, reason: "queue_completion_not_linked" };
  }

  if (
    !Array.isArray(bundle.task_attempts)
    || bundle.task_attempts.length !== 1
    || bundle.task_attempts[0]?.id !== attemptId
  ) {
    return { ok: false, reason: "duplicate_or_missing_task_attempt" };
  }

  const proof = attempt.state?.finish?.readiness_evidence;
  const checkoutProof = proof?.primary_checkout;
  const budgetProof = proof?.budget;
  if (
    !isPlainObject(proof)
    || proof.schema_version !== DURABLE_CANARY_EVIDENCE_SCHEMA_VERSION
    || !isPlainObject(checkoutProof)
    || !isSha256(checkoutProof.before_digest)
    || !isSha256(checkoutProof.after_digest)
    || checkoutProof.before_digest !== checkoutProof.after_digest
  ) {
    return { ok: false, reason: "primary_checkout_proof_missing" };
  }
  if (
    !isPlainObject(budgetProof)
    || typeof budgetProof.limit !== "number"
    || !Number.isFinite(budgetProof.limit)
    || budgetProof.limit < 0
    || typeof budgetProof.used !== "number"
    || !Number.isFinite(budgetProof.used)
    || budgetProof.used < 0
    || budgetProof.used > budgetProof.limit
  ) {
    return { ok: false, reason: "budget_proof_missing_or_exceeded" };
  }

  const repositoryProof = proof?.repository;
  const runtimeProof = proof?.runtime;
  const repositoryRoot = attempt.state?.workspace?.repository_root;
  const changedFiles = attempt.state?.promotion?.metadata?.changed_files;
  const adapterId =
    attempt.state?.execution?.task_result?.run_record?.adapter_id
    ?? null;
  let expectedRepositoryClass;
  let expectedRepositoryIdentity;
  let expectedChangedPathsDigest;
  let expectedRuntimeFamily;
  try {
    expectedRepositoryClass = classifyReadinessRepository({
      changedFiles,
      repositoryRoot,
      selfHostScope: repositoryProof?.self_host_scope ?? null,
    });
    expectedRepositoryIdentity = resolveRepositoryIdentity(repositoryRoot);
    expectedChangedPathsDigest = createReadinessChangedPathsDigest(changedFiles);
    expectedRuntimeFamily = normalizeReadinessRuntimeFamily(adapterId);
  } catch {
    return { ok: false, reason: "repository_identity_proof_missing" };
  }
  if (
    !isPlainObject(repositoryProof)
    || !isSha256(repositoryProof.identity_sha256)
    || !isPlainObject(expectedRepositoryIdentity)
    || repositoryProof.identity_sha256
      !== expectedRepositoryIdentity.identity_sha256
    || repositoryProof.common_directory_sha256
      !== expectedRepositoryIdentity.common_directory_sha256
    || repositoryProof.origin_sha256
      !== expectedRepositoryIdentity.origin_sha256
    || repositoryProof.root_commits_sha256
      !== expectedRepositoryIdentity.root_commits_sha256
    || !isSha256(repositoryProof.changed_paths_sha256)
    || repositoryProof.changed_paths_sha256 !== expectedChangedPathsDigest
    || repositoryProof.checkout_sha256 !== checkoutProof.before_digest
    || repositoryProof.class !== expectedRepositoryClass
    || normalizeSelfHostScope(repositoryProof.self_host_scope)
      !== (repositoryProof.self_host_scope === null
        ? null
        : repositoryProof.self_host_scope)
  ) {
    return { ok: false, reason: "repository_identity_proof_missing" };
  }
  if (
    !isPlainObject(runtimeProof)
    || !isNonEmptyString(runtimeProof.adapter_id)
    || runtimeProof.adapter_id !== adapterId
    || runtimeProof.family !== expectedRuntimeFamily
  ) {
    return { ok: false, reason: "runtime_identity_proof_missing" };
  }

  if (
    !isNonEmptyString(attempt.workspace_path)
    || !isNonEmptyString(attempt.state?.workspace?.repository_root)
    || !isNonEmptyString(attempt.state?.workspace?.worktree_path)
    || path.resolve(attempt.workspace_path)
      !== path.resolve(attempt.state.workspace.worktree_path)
    || path.resolve(attempt.workspace_path)
      === path.resolve(attempt.state.workspace.repository_root)
  ) {
    return { ok: false, reason: "isolated_workspace_not_proven" };
  }

  const orderedStepTimes = [];
  for (const stage of REQUIRED_DURABLE_STEP_STAGES) {
    const step = bundle.steps?.[stage];
    if (
      !step
      || step.attempt_id !== attemptId
      || step.stage !== stage
      || step.status !== "COMPLETED"
      || !isIsoTimestamp(step.completed_at)
    ) {
      return { ok: false, reason: "durable_stage_evidence_missing", stage };
    }
    orderedStepTimes.push(Date.parse(step.completed_at));
  }
  if (
    bundle.steps.GATES_RUN.result?.canonical_verdict !== "PASS"
    || bundle.steps.GATES_RUN.result?.source !== "acceptance_command_runner"
    || bundle.steps.GATES_RUN.result?.ok !== true
  ) {
    return { ok: false, reason: "deterministic_gate_not_proven" };
  }
  if (
    bundle.steps.REVIEWED.result?.canonical_verdict !== "PASS"
    || bundle.steps.REVIEWED.result?.source !== "fresh_outer_llm_review"
    || bundle.steps.REVIEWED.result?.fresh_context !== true
  ) {
    return { ok: false, reason: "fresh_review_not_proven" };
  }
  for (let index = 1; index < orderedStepTimes.length; index += 1) {
    if (orderedStepTimes[index] < orderedStepTimes[index - 1]) {
      return { ok: false, reason: "durable_stage_order_invalid" };
    }
  }
  const promotionTimestamp = Date.parse(promotion.promoted_at);
  if (
    promotionTimestamp < orderedStepTimes[2]
    || promotionTimestamp > orderedStepTimes[3]
    || orderedStepTimes[3] > Date.parse(attempt.finished_at)
  ) {
    return { ok: false, reason: "promotion_order_invalid" };
  }

  return { ok: true };
}

function durableReadinessIdentity(bundle) {
  return Object.freeze({
    repository: Object.freeze({
      ...bundle.attempt.state.finish.readiness_evidence.repository,
    }),
    runtime: Object.freeze({
      ...bundle.attempt.state.finish.readiness_evidence.runtime,
    }),
  });
}

function validateRolloutIdentity({
  destinationSource,
  phase,
  priorRolloutEntries = [],
  repository,
  runtime,
  source,
} = {}) {
  if (!REQUIRED_ROLLOUT_PHASES.includes(phase)) {
    return { ok: false, reason: "invalid_rollout_phase" };
  }
  if (
    !isPlainObject(destinationSource)
    || !isPlainObject(repository)
    || !isPlainObject(runtime)
    || !isPlainObject(source)
  ) {
    return { ok: false, reason: "rollout_identity_missing" };
  }

  if (phase === "disposable_fixture") {
    return (
      repository.class === "disposable_fixture"
      && source.state_root_identity_sha256
        !== destinationSource.state_root_identity_sha256
    )
      ? { ok: true }
      : { ok: false, reason: "rollout_repository_class_mismatch" };
  }

  const fixture = priorRolloutEntries[0]?.repository ?? null;
  const fixtureSource = priorRolloutEntries[0]?.source ?? null;
  if (phase === "self_hosted") {
    if (
      repository.class !== "self_hosted"
      || !fixture
      || !fixtureSource
      || repository.identity_sha256 === fixture.identity_sha256
      || source.state_root_identity_sha256
        !== destinationSource.state_root_identity_sha256
      || source.state_root_identity_sha256
        === fixtureSource.state_root_identity_sha256
    ) {
      return { ok: false, reason: "rollout_repository_class_mismatch" };
    }
    return { ok: true };
  }

  const selfHosted = priorRolloutEntries[1]?.repository ?? null;
  if (
    repository.class !== "project"
    || !selfHosted
    || repository.identity_sha256 !== selfHosted.identity_sha256
    || source.state_root_identity_sha256
      !== destinationSource.state_root_identity_sha256
  ) {
    return { ok: false, reason: "rollout_repository_identity_mismatch" };
  }
  if (phase === "runtime_a" && runtime.family !== "codex") {
    return { ok: false, reason: "rollout_runtime_a_mismatch" };
  }
  if (phase === "runtime_b") {
    const runtimeA = priorRolloutEntries[2]?.runtime ?? null;
    if (
      runtime.family !== "claude"
      || !runtimeA
      || runtime.adapter_id === runtimeA.adapter_id
      || runtime.family === runtimeA.family
    ) {
      return { ok: false, reason: "rollout_runtime_b_mismatch" };
    }
  }
  return { ok: true };
}

function validateCanaryIdentity({
  destinationSource,
  repository,
  rolloutEntries,
  runtime,
  source,
} = {}) {
  const projectIdentity =
    rolloutEntries?.[3]?.repository?.identity_sha256
    ?? rolloutEntries?.[2]?.repository?.identity_sha256
    ?? null;
  if (
    !projectIdentity
    || !isPlainObject(repository)
    || repository.identity_sha256 !== projectIdentity
    || repository.class === "disposable_fixture"
    || !isPlainObject(source)
    || source.state_root_identity_sha256
      !== destinationSource?.state_root_identity_sha256
  ) {
    return { ok: false, reason: "canary_repository_identity_mismatch" };
  }
  if (!isPlainObject(runtime) || !["codex", "claude"].includes(runtime.family)) {
    return { ok: false, reason: "canary_runtime_identity_mismatch" };
  }
  return { ok: true };
}

function createDurableBundleDigest(bundle) {
  return sha256({
    attempt: bundle.attempt,
    promotion: bundle.promotion,
    queue_entry: bundle.queue_entry,
    steps: bundle.steps,
    task_attempts: bundle.task_attempts,
  });
}

function createDaemonReadinessEvidenceLink({
  bundle,
  entry,
  previousDigest = null,
  sequenceIndex,
  sequenceKind,
} = {}) {
  if (!["rollout_phase", "canary_task"].includes(sequenceKind)) {
    throw new Error("sequenceKind must be rollout_phase or canary_task");
  }
  if (!Number.isInteger(sequenceIndex) || sequenceIndex < 0) {
    throw new Error("sequenceIndex must be a non-negative integer");
  }
  if (previousDigest !== null && !isSha256(previousDigest)) {
    throw new Error("previousDigest must be null or a SHA-256 digest");
  }
  if (!isPlainObject(entry)) {
    throw new Error("entry is required");
  }

  const durableDigest = createDurableBundleDigest(bundle);
  const recordDigest = sha256({
    attempt_id: entry.attempt_id,
    completed_at: normalizeIsoTimestamp(entry.completed_at),
    durable_digest: durableDigest,
    phase: entry.phase ?? null,
    previous_digest: previousDigest,
    queue_integrity: entry.queue_integrity,
    repository: entry.repository,
    runtime: entry.runtime,
    source: entry.source,
    schema_version: DAEMON_READINESS_EVIDENCE_SCHEMA_VERSION,
    sequence_index: sequenceIndex,
    sequence_kind: sequenceKind,
    task_id: entry.task_id,
  });

  return Object.freeze({
    durable_digest: durableDigest,
    previous_digest: previousDigest,
    record_digest: recordDigest,
    schema_version: DAEMON_READINESS_EVIDENCE_SCHEMA_VERSION,
    sequence_index: sequenceIndex,
    sequence_kind: sequenceKind,
  });
}

function parseReadinessRecord(recordPath) {
  const storageInspection = inspectReadinessStorage(recordPath);
  if (!storageInspection.ok) {
    return invalidReadiness(
      recordPath,
      storageInspection.reason ?? "unsafe_readiness_path",
    );
  }
  if (!storageInspection.record_exists) {
    return invalidReadiness(recordPath, "missing_readiness_record");
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch {
    return invalidReadiness(recordPath, "invalid_readiness_json");
  }

  if (
    !isPlainObject(record)
    || record.schema_version !== DAEMON_READINESS_SCHEMA_VERSION
  ) {
    return invalidReadiness(recordPath, "unsupported_readiness_schema");
  }
  if (!isIsoTimestamp(record.generated_at)) {
    return invalidReadiness(recordPath, "invalid_generated_at");
  }
  if (!Array.isArray(record.consecutive_clean_tasks)) {
    return invalidReadiness(recordPath, "missing_consecutive_clean_tasks");
  }
  if (!Array.isArray(record.rollout_phases)) {
    return invalidReadiness(recordPath, "missing_ordered_rollout_phases");
  }
  if (!isSha256(record.chain_head)) {
    return invalidReadiness(recordPath, "invalid_chain_head");
  }

  return { ready: null, record, record_path: recordPath };
}

function validateReadinessEntryIdentity(entry, {
  expectedPhase = null,
  index,
  sequenceKind,
}) {
  if (
    !isPlainObject(entry)
    || !isNonEmptyString(entry.attempt_id)
    || !isNonEmptyString(entry.task_id)
    || !isIsoTimestamp(entry.completed_at)
    || !isPlainObject(entry.repository)
    || !isPlainObject(entry.runtime)
    || !isPlainObject(entry.queue_integrity)
    || !validateReadinessSourceIdentity(entry.source).ok
    || (sequenceKind === "rollout_phase" && entry.phase !== expectedPhase)
    || (sequenceKind === "canary_task" && entry.phase !== undefined)
  ) {
    return {
      ok: false,
      reason: sequenceKind === "rollout_phase"
        ? "invalid_rollout_phase"
        : "invalid_canary_identity",
      details: sequenceKind === "rollout_phase"
        ? { expected_phase: expectedPhase, index }
        : { index },
    };
  }
  return { ok: true };
}

async function verifyReadinessEntry({
  bundle,
  entry,
  expectedEvidence,
  queueIntegrity,
  resolveRepositoryIdentity,
}) {
  const invariantResult = validateDurableReadinessBundle(bundle, {
    attemptId: entry.attempt_id,
    resolveRepositoryIdentity,
    taskId: entry.task_id,
  });
  if (!invariantResult.ok) {
    return invariantResult;
  }
  const durableIdentity = durableReadinessIdentity(bundle);
  if (
    canonicalJson(entry.repository) !== canonicalJson(durableIdentity.repository)
    || canonicalJson(entry.runtime) !== canonicalJson(durableIdentity.runtime)
    || canonicalJson(entry.queue_integrity) !== canonicalJson(queueIntegrity)
  ) {
    return { ok: false, reason: "readiness_identity_link_invalid" };
  }
  if (
    !isPlainObject(entry.evidence)
    || entry.evidence.schema_version
      !== DAEMON_READINESS_EVIDENCE_SCHEMA_VERSION
    || entry.evidence.sequence_kind !== expectedEvidence.sequence_kind
    || entry.evidence.sequence_index !== expectedEvidence.sequence_index
    || entry.evidence.previous_digest !== expectedEvidence.previous_digest
  ) {
    return { ok: false, reason: "readiness_evidence_link_invalid" };
  }

  const recomputed = createDaemonReadinessEvidenceLink({
    bundle,
    entry,
    previousDigest: expectedEvidence.previous_digest,
    sequenceIndex: expectedEvidence.sequence_index,
    sequenceKind: expectedEvidence.sequence_kind,
  });
  if (
    entry.evidence.durable_digest !== recomputed.durable_digest
    || entry.evidence.record_digest !== recomputed.record_digest
  ) {
    return { ok: false, reason: "readiness_evidence_digest_mismatch" };
  }

  return {
    ...durableIdentity,
    ok: true,
    record_digest: recomputed.record_digest,
  };
}

async function loadReadinessEntrySource({
  canonicalSource,
  entry,
  resolveSourceStore,
  store,
}) {
  const isCanonical =
    entry.source.state_root_identity_sha256
    === canonicalSource.state_root_identity_sha256;
  let sourceStore = store;
  let release = null;
  if (!isCanonical) {
    if (typeof resolveSourceStore !== "function") {
      throw new Error("external readiness source resolver is unavailable");
    }
    const resolved = await resolveSourceStore(entry.source);
    sourceStore = resolved?.store ?? resolved;
    release = resolved?.release ?? resolved?.close ?? null;
  }
  assertLifecycleReadinessStore(sourceStore);
  try {
    const [bundle, allAttempts] = await Promise.all([
      loadDurableReadinessBundle({
        attemptId: entry.attempt_id,
        store: sourceStore,
        taskId: entry.task_id,
      }),
      sourceStore.attempts.list(),
    ]);
    const queueIntegrity = await createQueueIntegrityCheckpoint({
      store: sourceStore,
      through: bundle.queue_entry?.updated_at,
      windowStartedAt: entry.queue_integrity?.window_started_at,
    });
    return {
      allAttempts,
      bundle,
      queueIntegrity,
      source_identity_sha256: entry.source.state_root_identity_sha256,
    };
  } finally {
    if (typeof release === "function") {
      await release();
    }
  }
}

async function verifyDaemonReadiness({
  captureCurrentCheckoutDigest = capturePrimaryCheckoutReadinessDigest,
  projectId,
  resolveRepositoryIdentity = createReadinessRepositoryIdentity,
  resolveSourceStore = null,
  stateRoot,
  store,
  minimumCleanTasks = MINIMUM_CLEAN_CANARY_TASKS,
} = {}) {
  assertLifecycleReadinessStore(store);
  const canonicalSource = createReadinessSourceIdentity({
    sourceProjectId: projectId,
    sourceStateRoot: stateRoot,
  });
  if (
    !Number.isInteger(minimumCleanTasks)
    || minimumCleanTasks < MINIMUM_CLEAN_CANARY_TASKS
  ) {
    throw new Error(
      `minimumCleanTasks must be an integer >= ${MINIMUM_CLEAN_CANARY_TASKS}`,
    );
  }

  const recordPath = createDaemonReadinessPath(stateRoot);
  const parsed = parseReadinessRecord(recordPath);
  if (parsed.ready === false) return parsed;

  const rolloutPhases = parsed.record.rollout_phases;
  const entries = parsed.record.consecutive_clean_tasks;
  if (rolloutPhases.length !== REQUIRED_ROLLOUT_PHASES.length) {
    return invalidReadiness(recordPath, "missing_ordered_rollout_phases");
  }
  if (entries.length < minimumCleanTasks) {
    return invalidReadiness(recordPath, "insufficient_clean_canary_tasks", {
      observed_consecutive_clean_tasks: entries.length,
    });
  }

  const attemptIds = new Set();
  const taskIds = new Set();
  let previousDigest = null;
  let previousTimestamp = null;
  let sequenceIndex = 0;
  let finalCanonicalCheckout = null;
  const verifiedRolloutEntries = [];

  const sequences = [
    ...rolloutPhases.map((entry, index) => ({
      entry,
      expectedPhase: REQUIRED_ROLLOUT_PHASES[index],
      index,
      sequenceKind: "rollout_phase",
    })),
    ...entries.map((entry, index) => ({
      entry,
      expectedPhase: null,
      index,
      sequenceKind: "canary_task",
    })),
  ];
  const sourceSequences = new Map();

  for (const sequence of sequences) {
    const identity = validateReadinessEntryIdentity(sequence.entry, sequence);
    if (!identity.ok) {
      return invalidReadiness(recordPath, identity.reason, identity.details);
    }
    if (
      attemptIds.has(sequence.entry.attempt_id)
      || taskIds.has(sequence.entry.task_id)
    ) {
      return invalidReadiness(recordPath, "duplicate_canary_identity", {
        index: sequence.index,
      });
    }
    const timestamp = Date.parse(sequence.entry.completed_at);
    if (previousTimestamp !== null && timestamp < previousTimestamp) {
      return invalidReadiness(recordPath, "canary_sequence_order_invalid", {
        attempt_id: sequence.entry.attempt_id,
      });
    }

    let sourceLoad;
    try {
      sourceLoad = await loadReadinessEntrySource({
        canonicalSource,
        entry: sequence.entry,
        resolveSourceStore,
        store,
      });
    } catch (error) {
      return invalidReadiness(recordPath, "readiness_source_unavailable", {
        attempt_id: sequence.entry.attempt_id,
        source_error: error instanceof Error ? error.message : String(error),
      });
    }
    const verification = await verifyReadinessEntry({
      bundle: sourceLoad.bundle,
      entry: sequence.entry,
      expectedEvidence: {
        previous_digest: previousDigest,
        sequence_index: sequenceIndex,
        sequence_kind: sequence.sequenceKind,
      },
      queueIntegrity: sourceLoad.queueIntegrity,
      resolveRepositoryIdentity,
    });
    if (!verification.ok) {
      return invalidReadiness(recordPath, verification.reason, {
        attempt_id: sequence.entry.attempt_id,
        ...(verification.stage ? { stage: verification.stage } : {}),
      });
    }
    const rolloutIdentity = sequence.sequenceKind === "rollout_phase"
      ? validateRolloutIdentity({
          destinationSource: canonicalSource,
          phase: sequence.expectedPhase,
          priorRolloutEntries: verifiedRolloutEntries,
          repository: verification.repository,
          runtime: verification.runtime,
          source: sequence.entry.source,
        })
      : validateCanaryIdentity({
          destinationSource: canonicalSource,
          repository: verification.repository,
          rolloutEntries: verifiedRolloutEntries,
          runtime: verification.runtime,
          source: sequence.entry.source,
        });
    if (!rolloutIdentity.ok) {
      return invalidReadiness(recordPath, rolloutIdentity.reason, {
        attempt_id: sequence.entry.attempt_id,
      });
    }
    if (sequence.sequenceKind === "rollout_phase") {
      verifiedRolloutEntries.push({
        repository: verification.repository,
        runtime: verification.runtime,
        source: sequence.entry.source,
      });
    }
    const priorSourceSequence = sourceSequences.get(
      sourceLoad.source_identity_sha256,
    );
    const expectedWindowStart =
      priorSourceSequence?.entries?.[0]?.queue_integrity?.window_started_at
      ?? sourceLoad.bundle.queue_entry?.created_at;
    if (
      sequence.entry.queue_integrity.window_started_at
      !== normalizeIsoTimestamp(expectedWindowStart)
    ) {
      return invalidReadiness(recordPath, "queue_integrity_window_mismatch", {
        attempt_id: sequence.entry.attempt_id,
      });
    }
    sourceSequences.set(
      sourceLoad.source_identity_sha256,
      {
        allAttempts: sourceLoad.allAttempts,
        entries: [
          ...(sourceSequences.get(sourceLoad.source_identity_sha256)?.entries
            ?? []),
          sequence.entry,
        ],
      },
    );
    if (
      sequence.sequenceKind === "canary_task"
      && sourceLoad.source_identity_sha256
        === canonicalSource.state_root_identity_sha256
    ) {
      finalCanonicalCheckout = {
        expected_digest: verification.repository.checkout_sha256,
        repository_root:
          sourceLoad.bundle.attempt.state?.workspace?.repository_root,
      };
    }

    attemptIds.add(sequence.entry.attempt_id);
    taskIds.add(sequence.entry.task_id);
    previousDigest = verification.record_digest;
    previousTimestamp = timestamp;
    sequenceIndex += 1;
  }

  for (const sourceSequence of sourceSequences.values()) {
    const sequenceResult = validateConsecutiveAttemptTail(
      sourceSequence.allAttempts,
      sourceSequence.entries,
    );
    if (!sequenceResult.ok) {
      return invalidReadiness(recordPath, sequenceResult.reason);
    }
  }

  if (parsed.record.chain_head !== previousDigest) {
    return invalidReadiness(recordPath, "chain_head_mismatch");
  }
  if (
    !finalCanonicalCheckout
    || !isSha256(finalCanonicalCheckout.expected_digest)
    || !isNonEmptyString(finalCanonicalCheckout.repository_root)
    || typeof captureCurrentCheckoutDigest !== "function"
  ) {
    return invalidReadiness(recordPath, "current_checkout_proof_missing");
  }
  let currentCheckoutDigest;
  try {
    currentCheckoutDigest = captureCurrentCheckoutDigest(
      finalCanonicalCheckout.repository_root,
    );
  } catch (error) {
    return invalidReadiness(recordPath, "current_checkout_unavailable", {
      checkout_error: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    !isSha256(currentCheckoutDigest)
    || currentCheckoutDigest !== finalCanonicalCheckout.expected_digest
  ) {
    return invalidReadiness(recordPath, "primary_checkout_changed_since_canary");
  }

  return Object.freeze({
    generated_at: normalizeIsoTimestamp(parsed.record.generated_at),
    observed_consecutive_clean_tasks: entries.length,
    ready: true,
    reason: "verified",
    record_path: recordPath,
    required_consecutive_clean_tasks: minimumCleanTasks,
    verified_primary_checkout_sha256: currentCheckoutDigest,
    verified_attempt_ids: Object.freeze([...attemptIds]),
  });
}

function writeReadinessRecord(recordPath, record) {
  const storageInspection = inspectReadinessStorage(recordPath, {
    createDirectory: true,
  });
  if (!storageInspection.ok) {
    throw new Error(
      `refusing unsafe readiness storage: ${storageInspection.reason}`,
    );
  }
  const directory = path.dirname(recordPath);
  const temporaryPath = path.join(
    directory,
    `.canary-readiness.${process.pid}.${Date.now()}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify(record, null, 2)}\n`,
      { encoding: "utf8" },
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, recordPath);
    fs.chmodSync(recordPath, 0o600);
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
  }
}

function isReadinessLockOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readReadinessWriterLock(lockPath) {
  let descriptor = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error(`unsafe readiness writer lock: ${lockPath}`);
    }
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    } catch {
      owner = null;
    }
    return { mtime_ms: stat.mtimeMs, owner };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function acquireReadinessWriterLock(lockPath) {
  const owner = Object.freeze({
    created_at: new Date().toISOString(),
    owner_token: randomUUID(),
    pid: process.pid,
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let descriptor = null;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
      });
      fs.fsyncSync(descriptor);
      return { descriptor, owner };
    } catch (error) {
      if (descriptor !== null) {
        fs.closeSync(descriptor);
        fs.rmSync(lockPath, { force: true });
      }
      if (error?.code !== "EEXIST") throw error;

      let existing;
      try {
        const stat = fs.lstatSync(lockPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`unsafe readiness writer lock: ${lockPath}`);
        }
        existing = readReadinessWriterLock(lockPath);
      } catch (inspectionError) {
        if (inspectionError?.code === "ENOENT") continue;
        throw inspectionError;
      }
      const existingOwner = existing.owner;
      const validOwner = isPlainObject(existingOwner)
        && Number.isInteger(existingOwner.pid)
        && existingOwner.pid > 0
        && isIsoTimestamp(existingOwner.created_at)
        && isNonEmptyString(existingOwner.owner_token);
      const reclaimable = validOwner
        ? !isReadinessLockOwnerAlive(existingOwner.pid)
        : Date.now() - existing.mtime_ms >= READINESS_LOCK_STALE_MS;
      if (!reclaimable) {
        throw new Error(
          `readiness evidence writer is already locked: ${lockPath}`,
        );
      }
      const stalePath =
        `${lockPath}.stale.${process.pid}.${randomUUID()}`;
      try {
        fs.renameSync(lockPath, stalePath);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      fs.rmSync(stalePath, { force: true });
    }
  }
  throw new Error(`could not acquire readiness evidence writer lock: ${lockPath}`);
}

async function withReadinessWriterLock(recordPath, callback) {
  const storageInspection = inspectReadinessStorage(recordPath, {
    createDirectory: true,
  });
  if (!storageInspection.ok) {
    throw new Error(
      `refusing unsafe readiness storage: ${storageInspection.reason}`,
    );
  }
  const lockPath = `${recordPath}.lock`;
  const { descriptor, owner } = acquireReadinessWriterLock(lockPath);

  try {
    return await callback();
  } finally {
    fs.closeSync(descriptor);
    try {
      const current = readReadinessWriterLock(lockPath);
      if (current.owner?.owner_token === owner.owner_token) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function recordDaemonReadinessEvidence({
  attemptId,
  destinationProjectId,
  kind,
  now = new Date(),
  resolveRepositoryIdentity = createReadinessRepositoryIdentity,
  sourceProjectId,
  sourceStateRoot,
  stateRoot,
  store,
  taskId,
} = {}) {
  if (!["rollout_phase", "canary_task"].includes(kind)) {
    throw new Error("kind must be rollout_phase or canary_task");
  }
  if (!isNonEmptyString(attemptId) || !isNonEmptyString(taskId)) {
    throw new Error("attemptId and taskId are required");
  }
  const destinationSource = createReadinessSourceIdentity({
    sourceProjectId: destinationProjectId,
    sourceStateRoot: stateRoot,
  });
  const source = createReadinessSourceIdentity({
    sourceProjectId,
    sourceStateRoot,
  });
  const generatedAt = now instanceof Date ? now.toISOString() : now;
  if (!isIsoTimestamp(generatedAt)) {
    throw new Error("now must be a valid timestamp");
  }

  const recordPath = createDaemonReadinessPath(stateRoot);
  return withReadinessWriterLock(recordPath, async () => {
    let record = {
      chain_head: null,
      consecutive_clean_tasks: [],
      generated_at: normalizeIsoTimestamp(generatedAt),
      rollout_phases: [],
      schema_version: DAEMON_READINESS_SCHEMA_VERSION,
    };
    if (fs.existsSync(recordPath)) {
      const parsed = parseReadinessRecord(recordPath);
      if (parsed.ready === false) {
        throw new Error(`readiness record cannot be extended: ${parsed.reason}`);
      }
      record = structuredClone(parsed.record);
    }

    const allEntries = [
      ...record.rollout_phases,
      ...record.consecutive_clean_tasks,
    ];
    if (allEntries.some((entry) =>
      entry.attempt_id === attemptId || entry.task_id === taskId)) {
      throw new Error("readiness evidence already contains this task or attempt");
    }
    if (kind === "rollout_phase") {
      const expectedPhase = REQUIRED_ROLLOUT_PHASES[record.rollout_phases.length];
      if (!expectedPhase) {
        throw new Error("all rollout phases are already recorded");
      }
      if (record.consecutive_clean_tasks.length > 0) {
        throw new Error("rollout phases cannot be added after canary tasks");
      }
    } else if (record.rollout_phases.length !== REQUIRED_ROLLOUT_PHASES.length) {
      throw new Error("all rollout phases must be recorded before canary tasks");
    }

    const bundle = await loadDurableReadinessBundle({
      attemptId,
      store,
      taskId,
    });
    const invariantResult = validateDurableReadinessBundle(bundle, {
      attemptId,
      resolveRepositoryIdentity,
      taskId,
    });
    if (!invariantResult.ok) {
      throw new Error(
        `durable readiness evidence rejected: ${invariantResult.reason}`,
      );
    }
    const durableIdentity = durableReadinessIdentity(bundle);
    const expectedPhase = kind === "rollout_phase"
      ? REQUIRED_ROLLOUT_PHASES[record.rollout_phases.length]
      : null;
    const rolloutIdentity = kind === "rollout_phase"
      ? validateRolloutIdentity({
          destinationSource,
          phase: expectedPhase,
          priorRolloutEntries: record.rollout_phases,
          repository: durableIdentity.repository,
          runtime: durableIdentity.runtime,
          source,
        })
      : validateCanaryIdentity({
          destinationSource,
          repository: durableIdentity.repository,
          rolloutEntries: record.rollout_phases,
          runtime: durableIdentity.runtime,
          source,
        });
    if (!rolloutIdentity.ok) {
      throw new Error(
        `durable readiness evidence rejected: ${rolloutIdentity.reason}`,
      );
    }
    const priorSourceEntries = allEntries.filter((entry) =>
      entry.source?.state_root_identity_sha256
      === source.state_root_identity_sha256);
    const queueWindowStartedAt =
      priorSourceEntries[0]?.queue_integrity?.window_started_at
      ?? bundle.queue_entry?.created_at;
    let queueIntegrity;
    try {
      queueIntegrity = await createQueueIntegrityCheckpoint({
        store,
        through: bundle.queue_entry?.updated_at,
        windowStartedAt: queueWindowStartedAt,
      });
    } catch (error) {
      throw new Error(
        "durable readiness evidence rejected: no_task_loss_not_proven: "
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const candidateEntries = [
      ...allEntries.filter((entry) =>
        entry.source?.state_root_identity_sha256
        === source.state_root_identity_sha256),
      {
        attempt_id: attemptId,
        task_id: taskId,
      },
    ];
    const sequenceResult = validateConsecutiveAttemptTail(
      await store.attempts.list(),
      candidateEntries,
    );
    if (!sequenceResult.ok) {
      throw new Error(
        `durable readiness evidence rejected: ${sequenceResult.reason}`,
      );
    }
    const priorEntry = allEntries.at(-1);
    if (
      priorEntry
      && Date.parse(bundle.attempt.finished_at)
        < Date.parse(priorEntry.completed_at)
    ) {
      throw new Error(
        "durable readiness evidence rejected: canary_sequence_order_invalid",
      );
    }

    const entry = {
      attempt_id: attemptId,
      completed_at: normalizeIsoTimestamp(bundle.attempt.finished_at),
      ...(kind === "rollout_phase" ? { phase: expectedPhase } : {}),
      repository: durableIdentity.repository,
      runtime: durableIdentity.runtime,
      queue_integrity: queueIntegrity,
      source,
      task_id: taskId,
    };
    entry.evidence = createDaemonReadinessEvidenceLink({
      bundle,
      entry,
      previousDigest: record.chain_head,
      sequenceIndex: allEntries.length,
      sequenceKind: kind,
    });

    if (kind === "rollout_phase") {
      record.rollout_phases.push(entry);
    } else {
      record.consecutive_clean_tasks.push(entry);
    }
    record.chain_head = entry.evidence.record_digest;
    record.generated_at = normalizeIsoTimestamp(generatedAt);
    writeReadinessRecord(recordPath, record);

    return Object.freeze({
      attempt_id: attemptId,
      chain_head: record.chain_head,
      kind,
      ...(kind === "rollout_phase" ? { phase: expectedPhase } : {}),
      record_path: recordPath,
      task_id: taskId,
    });
  });
}

async function assertDaemonReadiness(options = {}) {
  const result = await verifyDaemonReadiness(options);
  if (!result.ready) {
    const error = new Error(
      "daemon mode is locked for Reliability RC: "
      + `${result.reason}; complete ${result.required_consecutive_clean_tasks} `
      + "consecutive clean supervised canary tasks through the durable "
      + `readiness evidence writer at ${result.record_path}`,
    );
    error.code = "daemon_readiness_required";
    error.readiness = result;
    throw error;
  }
  return result;
}

export {
  DAEMON_READINESS_EVIDENCE_SCHEMA_VERSION,
  DAEMON_READINESS_SCHEMA_VERSION,
  DURABLE_CANARY_EVIDENCE_SCHEMA_VERSION,
  MINIMUM_CLEAN_CANARY_TASKS,
  REQUIRED_CLEAN_INVARIANTS,
  REQUIRED_DURABLE_STEP_STAGES,
  REQUIRED_ROLLOUT_PHASES,
  assertDaemonReadiness,
  createDaemonReadinessEvidenceLink,
  createDaemonReadinessPath,
  createReadinessChangedPathsDigest,
  createReadinessRepositoryIdentity,
  createReadinessRepositoryIdentityDigest,
  createReadinessRepositoryIdentityFromComponents,
  createReadinessSourceIdentity,
  classifyReadinessRepository,
  normalizeReadinessRuntimeFamily,
  recordDaemonReadinessEvidence,
  verifyDaemonReadiness,
};
