import fs from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  acceptanceCommandRunner,
  adapter,
  adversarialReview,
  attemptWorktree,
  assertSafeExistingStateRoot,
  createInitPlan,
  createAttachPlan,
  collectDoctorChecks,
  contextContract,
  deriveBootstrapProjectId,
  initializeBootstrapState,
  preflightResetBootstrapState,
  resetBootstrapState,
  discoveryPipeline,
  installState,
  instinctPromotion,
  instinctTransfer,
  learningGovernance,
  memoryTaxonomy,
  observationGuardian,
  observationLifecycle,
  skillCandidate,
  onboarding,
  observability,
  pathSafety,
  packageActivation,
  packageDiscovery,
  packageImport,
  packageRuntime,
  pluginRuntime,
  policy,
  queueProjection,
  reliabilityRc,
  routing,
  governance,
  schemas,
  securityDoctor,
  serve as serveRuntime,
  storage,
  storageMigration,
  taskNotes,
  taskIntake,
  upgradePlanning,
} from "../../core/src/index.js";
import { buildLocalDashboardDocument } from "../../ui/src/index.js";
import { buildLocalControlPlaneDocument, buildTaskLiveCardFragment } from "../../ui/src/control-plane.js";
import { escapeHtml } from "../../ui/src/render-utils.js";
import { buildLabPageData, buildManageAgentsPageData, renderLabDocument, renderManageAgentsDocument, renderProjectDocument, buildServicesStatus, buildProjectHealthStatus, buildClaudeCreditNote, setExtraLabAgents } from "../../ui/src/templates/lab-page.js";
import { createClaudeCodeLocalAdapter } from "../../adapters/claude-code-local-adapter.js";
import { createCodexLocalAdapter } from "../../adapters/codex-local-adapter.js";
import { createCursorBridgeAdapter } from "../../adapters/cursor-bridge-adapter.js";
import { createMcpServerAdapter } from "../../adapters/mcp-server-adapter.js";
import { createInMemoryTestAdapter } from "../../adapters/test-adapter.js";
import { resolveRuntimeDeniedReadRoots as resolveExecutorDeniedReadRoots } from "../../adapters/runtime-read-sandbox.js";
import { createDefaultValidators } from "../../validators/index.js";
import { getAutonomousWorkerConfig, getAutoRepairConfig, getGoalsConfig, getIntakeValidationConfig, getLlmReviewConfig, getMergePolicy, getSubtaskTimeoutMs, getWorktreeRetention, loadRoleById, loadRoleConfig } from "../../core/src/routing/role-config-loader.js";
import { getArtifactView, listArtifactViews } from "../../core/src/runtime/artifact-views.js";
import {
  ILLUSTRATOR_ARTIFACTS,
  createLlmRenderer,
  loadManifestBody,
  readArtifactHtml,
  renderAllArtifacts,
} from "../../core/src/runtime/illustrator.js";
import { isSystemRoleId } from "../../core/src/routing/role-manifests.js";
import { createRoleBudgetGuard, createRunCostGuard, currentMonthBucket } from "../../core/src/runtime/cost-guard.js";
import { runQualityGates } from "../../core/src/runtime/quality-gates.js";
import * as subtaskWorktree from "../../core/src/runtime/subtask-worktree.js";
import * as taskBranch from "../../core/src/runtime/task-branch.js";
import * as taskQueue from "../../core/src/runtime/task-queue.js";
import {
  createUiRequestGuard,
  normalizeUiAccessConfig,
} from "./ui-security.js";
import {
  UiLifecycleActionError,
  assertRetryLifecyclePolicy,
  countRetryAttempts,
  resolveUiLifecycleAction,
} from "./ui-actions.js";
import {
  durableQueueStateFromAttempt,
  executeCliTaskLifecycle,
  taskResultFromAttempt,
} from "./lifecycle-facade.js";
import { createFileQueueProjection } from "./file-queue-projection.js";
import {
  assertDaemonReadiness,
  classifyReadinessRepository,
  createReadinessChangedPathsDigest,
  createReadinessRepositoryIdentity,
  normalizeReadinessRuntimeFamily,
  recordDaemonReadinessEvidence,
  verifyDaemonReadiness,
} from "./daemon-readiness.js";
import {
  createPlanApprovalDigest,
  createPlanApprovalDigestNote,
  hasPlanApprovalDigest,
} from "./plan-approval.js";
import {
  AUTO_REPAIR_TRIGGER,
  assertAutoRepairClaimPolicy,
  createAutoRepairQueuePayloadPatch,
  parseAutoRepairEnvelope,
  resolveAutoRepairPriorAttempt,
  resolveBoundedAutoRepairDecision,
} from "./auto-repair.js";



async function loadPackageAgentStaticManifest() {
  return null;
}

async function loadInstalledPackageAgents() {
  return { manifests: [], labAgents: [], taskTemplates: [] };
}






function collectDisabledAgentIds({ projectOverrides, packageManifests }) {
  const ids = new Set();
  const roles = projectOverrides?.roles ?? {};
  for (const [roleId, cfg] of Object.entries(roles)) {
    if (cfg?.enabled === false) ids.add(roleId);
  }
  for (const manifest of packageManifests ?? []) {
    if (manifest?.runtime_disabled === true) ids.add(manifest.id);
  }
  return ids;
}

const ACTIVE_TASK_STATUSES = new Set(["PENDING", "PLANNING", "IN_PROGRESS", "IN_REVIEW"]);

async function sweepStaleWorktreesForWorkspace({
  databasePath,
  stateRoot,
  workspaceRoot,
  olderThanMs = 60 * 60 * 1000,
  force = false,
}) {
  if (!fs.existsSync(path.join(stateRoot, "worktrees"))) return { kept: [], removed: [] };
  const sqliteStorage = storage.createSqliteStorage({ databasePath, readonly: true });
  const activeTaskIds = new Set();
  try {
    const tasks = await sqliteStorage.tasks.list();
    for (const task of tasks) {
      if (ACTIVE_TASK_STATUSES.has(task.status)) activeTaskIds.add(task.id);
    }
  } finally {
    sqliteStorage.close();
  }
  return subtaskWorktree.sweepStaleWorktrees({
    force,
    isActiveTask: (taskId) => activeTaskIds.has(taskId),
    olderThanMs,
    stateRoot,
    workspaceRoot,
  });
}

function applySubtaskBranchAction({ stateRoot, workspaceRoot, taskId, subtaskId, action }) {
  if (!["merge", "discard"].includes(action)) {
    throw new Error(`unknown subtask action: ${action}`);
  }
  const progress = readSubtaskProgress({ stateRoot, taskId });
  const entries = progress?.subtasks ?? [];
  const eligible = entries.filter((entry) => entry.branch && entry.branch.name);
  const targets = subtaskId
    ? eligible.filter((entry) => entry.id === subtaskId)
    : eligible;
  const results = [];
  for (const entry of targets) {
    const branch = entry.branch;
    if (action === "merge") {
      if (!branch.had_changes) {
        results.push({ id: entry.id, status: "skipped_no_changes" });
        continue;
      }


      if (branch.pr_url) {
        const prMerge = mergePullRequest({ prUrl: branch.pr_url, workspaceRoot });
        if (prMerge.merged) {
          const baseBranch = taskBranch.resolveBaseBranch({ workspaceRoot, explicit: getMergePolicy({ workspaceRoot }).base_branch });
          for (const gitArgs of [
            ["fetch", "origin"],
            ["checkout", baseBranch],
            ["pull", "--ff-only", "origin", baseBranch],
          ]) {
            spawnSync("git", gitArgs, { cwd: workspaceRoot, encoding: "utf8" });
          }
          subtaskWorktree.removeSubtaskWorktree({
            branchName: branch.name,
            workspaceRoot,
            worktreePath: branch.worktree_path,
          });
          results.push({
            id: entry.id,
            merged_branch: branch.name,
            merge_via: "gh_pr_merge",
            pr_url: branch.pr_url,
            status: "merged",
          });
          continue;
        }
        results.push({
          id: entry.id,
          message: `PR merge via gh failed: ${prMerge.reason}. PR is still open.`,
          status: "conflict",
        });
        continue;
      }
      const mergeResult = subtaskWorktree.mergeSubtaskBranch({
        branchName: branch.name,
        subtaskId: entry.id,
        workspaceRoot,
      });
      if (mergeResult.ok) {
        subtaskWorktree.removeSubtaskWorktree({
          branchName: branch.name,
          workspaceRoot,
          worktreePath: branch.worktree_path,
        });
        results.push({
          id: entry.id,
          merged_branch: branch.name,
          merge_via: "local_git_merge",
          status: "merged",
        });
      } else {
        results.push({
          conflict_files: mergeResult.conflictFiles,
          id: entry.id,
          message: mergeResult.message,
          status: "conflict",
        });
      }
    } else {
      subtaskWorktree.removeSubtaskWorktree({
        branchName: branch.name,
        workspaceRoot,
        worktreePath: branch.worktree_path,
      });
      let remoteOutcome = null;
      if (branch.pr_url) {
        remoteOutcome = closePullRequestAndBranch({ prUrl: branch.pr_url, workspaceRoot });
      } else {
        remoteOutcome = deleteRemoteBranch({ branchName: branch.name, workspaceRoot });
      }
      results.push({
        discarded_branch: branch.name,
        id: entry.id,
        remote: remoteOutcome,
        status: "discarded",
      });
    }
  }
  const remaining = entries.map((entry) => {
    const decision = results.find((r) => r.id === entry.id);
    if (!decision) return entry;
    if (decision.status === "merged" || decision.status === "discarded") {
      return { ...entry, branch: { ...entry.branch, merge_status: decision.status } };
    }
    return entry;
  });
  const paths = createTaskExecutionProgressPaths(stateRoot, taskId);
  if (fs.existsSync(paths.subtaskProgressPath)) {
    fs.writeFileSync(paths.subtaskProgressPath, `${JSON.stringify({ subtasks: remaining }, null, 2)}\n`);
  }
  try {
    const queueEntry = taskQueue.findTaskState({ stateRoot, taskId });
    if (queueEntry?.state === "in_review") {
      const branchEntries = remaining.filter((entry) => entry.branch?.name && entry.branch.had_changes);
      const allMerged = branchEntries.length > 0 && branchEntries.every((entry) => entry.branch.merge_status === "merged");
      const allDiscarded = branchEntries.length > 0 && branchEntries.every((entry) => entry.branch.merge_status === "discarded");
      if (allMerged) {
        taskQueue.transitionTask({ stateRoot, taskId, toState: "accepted", patch: { closed_via: action } });
      } else if (allDiscarded) {
        taskQueue.transitionTask({ stateRoot, taskId, toState: "rejected", patch: { closed_via: action } });
      }
    }
  } catch (error) {
    process.stderr.write(`[niis] Warning: queue transition after ${action} failed for ${taskId}: ${error.message}\n`);
  }




  try {
    const allTerminal = remaining.length > 0 && remaining.every((entry) =>
      !entry.branch?.name
      || entry.branch.merge_status === "merged"
      || entry.branch.merge_status === "discarded"
      || entry.branch.merge_status === "pr_opened");
    if (allTerminal) {
      const policy = getMergePolicy({ workspaceRoot });
      const taskBranchName = taskBranch.branchNameFor(taskId);
      const outcome = taskBranch.maybeDeleteOrphanTaskBranch({
        branchName: taskBranchName,
        fallbackBranch: taskBranch.resolveBaseBranch({ workspaceRoot, explicit: policy.base_branch }),
        workspaceRoot,
      });
      if (outcome.deleted) {
        results.push({ deleted_task_branch: taskBranchName, status: "task_branch_cleaned" });
      } else if (outcome.reason === "has_unique_commits") {
        process.stderr.write(`[niis] Task branch ${taskBranchName} retained: it still has unique unmerged commits.\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`[niis] Warning: task-branch cleanup failed for ${taskId}: ${error.message}\n`);
  }
  return { matched: targets.length, results };
}

function deleteRemoteBranch({ workspaceRoot, branchName, remote = "origin" }) {



  const lsRemote = spawnSync("git", ["ls-remote", "--heads", remote, branchName], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  if (lsRemote.error) {
    return { deleted: false, reason: `git ls-remote failed: ${lsRemote.error.message}` };
  }
  if (lsRemote.status !== 0) {
    return { deleted: false, reason: `remote ${remote} is not reachable or not configured` };
  }
  if (!(lsRemote.stdout ?? "").trim()) {
    return { deleted: false, reason: "not_on_remote" };
  }
  const push = spawnSync("git", ["push", remote, "--delete", branchName], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  if (push.status !== 0) {
    return { deleted: false, reason: (push.stderr || push.stdout || "git push --delete failed").trim() };
  }
  return { deleted: true, reason: "pushed_delete" };
}

function mergePullRequest({ workspaceRoot, prUrl, mergeStrategy = "--merge" }) {



  if (typeof prUrl !== "string" || prUrl.trim() === "") {
    return { merged: false, reason: "no_pr_url" };
  }
  const result = spawnSync("gh", ["pr", "merge", prUrl, mergeStrategy, "--delete-branch"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  if (result.error) {
    return { merged: false, reason: `gh invocation failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { merged: false, reason: (result.stderr || result.stdout || "gh pr merge failed").trim() };
  }
  return { merged: true, reason: "pr_merged_branch_deleted" };
}

function closePullRequestAndBranch({ workspaceRoot, prUrl }) {



  if (typeof prUrl !== "string" || prUrl.trim() === "") {
    return { closed: false, reason: "no_pr_url" };
  }
  const result = spawnSync("gh", ["pr", "close", prUrl, "--delete-branch"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  if (result.error) {
    return { closed: false, reason: `gh invocation failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { closed: false, reason: (result.stderr || result.stdout || "gh pr close failed").trim() };
  }
  return { closed: true, reason: "pr_closed_branch_deleted" };
}

function readTaskTitleFromIntake({ workspaceRoot, taskId }) {
  try {
    const plan = createInitPlan(workspaceRoot);
    const paths = taskIntake.createTaskIntakePaths(plan.stateRoot, taskId);
    if (!fs.existsSync(paths.intake_path)) return null;
    const intake = JSON.parse(fs.readFileSync(paths.intake_path, "utf8"));
    const t = intake.derived_task?.title ?? intake.title ?? null;
    return typeof t === "string" && t.trim() !== "" ? t.trim() : null;
  } catch {
    return null;
  }
}

function buildPullRequestBody({ workspaceRoot, branch, subtask, taskId, title }) {



  const plan = createInitPlan(workspaceRoot);
  const stateRoot = plan.stateRoot;
  const sections = [];
  sections.push(`## Niis task`);
  sections.push(`- **ID:** \`${taskId}\``);
  sections.push(`- **Title:** ${title ?? taskId}`);
  sections.push(`- **Subtask:** \`${subtask.id}\``);
  sections.push(`- **Role:** \`${subtask.role_id ?? "generalist"}\``);
  sections.push(`- **Worktree:** \`${branch.worktree_path ?? "(inline, no worktree)"}\``);

  try {
    const intakePaths = taskIntake.createTaskIntakePaths(stateRoot, taskId);
    if (fs.existsSync(intakePaths.intake_path)) {
      const intake = JSON.parse(fs.readFileSync(intakePaths.intake_path, "utf8"));
      const brief = (intake.derived_task?.operator_brief_markdown ?? intake.operator_prompt ?? "").trim();
      const details = (intake.derived_task?.details_markdown ?? "").trim();
      const acceptance = (intake.derived_task?.acceptance_markdown ?? "").trim();
      const guidance = Array.isArray(intake.derived_task?.operator_guidance ?? intake.reference_bundle?.guides)
        ? (intake.derived_task?.operator_guidance ?? intake.reference_bundle?.guides).filter(Boolean)
        : [];
      const outOfScope = Array.isArray(intake.derived_task?.out_of_scope) ? intake.derived_task.out_of_scope : [];
      const peerSubtasks = Array.isArray(intake.subtasks) ? intake.subtasks : [];
      const runtime = intake.planner_runtime ?? "unknown";

      if (brief) {
        sections.push(``);
        sections.push(`## Operator brief`);
        sections.push(brief);
      }
      if (details && details !== brief) {
        sections.push(``);
        sections.push(`## Task details`);
        sections.push(details);
      }
      if (acceptance) {
        sections.push(``);
        sections.push(`## Acceptance criteria`);
        sections.push(acceptance);
      }




      const detailsLower = details.toLowerCase();
      const detailsHasGuidance = /^##\s*guidance/im.test(details) || detailsLower.includes("\nguidance\n");
      const detailsHasOutOfScope = /^##\s*out of scope/im.test(details) || detailsLower.includes("\nout of scope\n");
      if (guidance.length > 0 && !detailsHasGuidance) {
        sections.push(``);
        sections.push(`## Operator guidance`);
        for (const line of guidance) {
          const content = typeof line === "string" ? line : line?.content ?? "";
          if (content) sections.push(`- ${content}`);
        }
      }
      if (outOfScope.length > 0 && !detailsHasOutOfScope) {
        sections.push(``);
        sections.push(`## Out of scope`);
        for (const line of outOfScope) sections.push(`- ${line}`);
      }
      if (peerSubtasks.length > 1) {
        sections.push(``);
        sections.push(`## Plan (${peerSubtasks.length} subtasks)`);
        for (const st of peerSubtasks) {
          const here = st.id === subtask.id ? " **(this PR)**" : "";
          sections.push(`- \`${st.id}\` — ${st.title ?? "(untitled)"}${here}`);
        }
      }
      sections.push(``);
      sections.push(`## Execution`);
      sections.push(`- **Planner runtime:** \`${runtime}\``);
    }
  } catch {

  }

  try {
    const progressPaths = createTaskExecutionProgressPaths(stateRoot, taskId);
    if (fs.existsSync(progressPaths.subtaskProgressPath)) {
      const progress = JSON.parse(fs.readFileSync(progressPaths.subtaskProgressPath, "utf8"));
      const entry = (progress.subtasks ?? []).find((s) => s.id === subtask.id);
      if (entry?.summary) {
        sections.push(``);
        sections.push(`## Agent summary`);
        sections.push(entry.summary);
      }
      if (entry?.cost) {
        const { tokens_in: tin, tokens_out: tout, tokens_cached: tcached, estimated_usd: usd, duration_ms: dur, model_id } = entry.cost;
        const parts = [];
        if (Number(usd) > 0) parts.push(`$${Number(usd).toFixed(4)}`);
        if (Number(dur) > 0) parts.push(`${Math.round(Number(dur) / 1000)}s`);
        if (Number(tin) + Number(tout) > 0) parts.push(`${Number(tin)}↓/${Number(tout)}↑ tokens${Number(tcached) > 0 ? ` (${Number(tcached)} cached)` : ""}`);
        if (model_id) parts.push(`model \`${model_id}\``);
        if (parts.length > 0) {
          sections.push(``);
          sections.push(`## Cost & runtime`);
          sections.push(parts.join(" · "));
        }
      }
    }
  } catch {

  }

  sections.push(``);
  sections.push(`---`);
  sections.push(`_Generated by Niis. Review and merge when ready; discard closes this PR and deletes both local & origin branches._`);
  return sections.join("\n");
}

function openSubtaskPullRequest({ workspaceRoot, branch, subtask, taskId, taskTitle = null }) {
  const resolvedTitle = taskTitle ?? readTaskTitleFromIntake({ taskId, workspaceRoot }) ?? subtask.id;
  const body = buildPullRequestBody({ branch, subtask, taskId, title: resolvedTitle, workspaceRoot });
  const result = spawnSync("gh", [
    "pr", "create",
    "--head", branch.name,
    "--title", `niis: ${resolvedTitle}`,
    "--body", body,
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  if (result.error) {
    return { error: `gh invocation failed: ${result.error.message}`, ok: false };
  }
  if (result.status !== 0) {
    return {
      error: (result.stderr || result.stdout || "gh pr create failed").trim(),
      ok: false,
    };
  }
  const urlMatch = (result.stdout || "").match(/https?:\/\/\S+/);
  return { ok: true, stdout: result.stdout.trim(), url: urlMatch ? urlMatch[0] : null };
}

async function runSubtask(args = []) {
  const sub = args[0];
  if (sub !== "list") {
    throw new Error(
      "usage: niis subtask list --task-id <id> [--subtask-id <id>]. "
      + "Legacy merge/discard/PR commands are retired in Reliability RC; "
      + "publication is owned by the canonical lifecycle promotion gate.",
    );
  }
  const workspaceRoot = resolveWorkspaceRoot();
  const plan = createInitPlan(workspaceRoot);
  if (!fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }
  const taskId = resolveFlagValue(args, "--task-id");
  if (!taskId) {
    throw new Error("--task-id is required");
  }
  const subtaskIdFilter = resolveFlagValue(args, "--subtask-id");
  const entries = readSubtaskProgress({ stateRoot: plan.stateRoot, taskId })?.subtasks ?? [];
  const eligible = entries.filter((entry) => entry.branch && entry.branch.name);
  const target = subtaskIdFilter
    ? eligible.filter((entry) => entry.id === subtaskIdFilter)
    : eligible;
  console.log(JSON.stringify({
    count: target.length,
    subtasks: target.map((entry) => ({
      branch: entry.branch,
      id: entry.id,
      role_id: entry.role_id,
      status: entry.status,
    })),
  }, null, 2));
}

async function runQueue(args = []) {
  const sub = args[0];
  if (!["list", "reconcile"].includes(sub)) {
    throw new Error(
      "usage: niis queue <list|reconcile> [--state <durable-state>] [--inspect-only]",
    );
  }
  const workspaceRoot = resolveWorkspaceRoot();
  const plan = createInitPlan(workspaceRoot);
  if (!fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }
  const store = storage.createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  const projection = createFileQueueProjection({
    stateRoot: plan.stateRoot,
  });
  try {
    if (sub === "reconcile") {
      const report = await queueProjection.reconcileQueueProjection({
        applyPending: !args.includes("--inspect-only"),
        projection,
        store,
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.flush?.failed?.length > 0 || report.requires_operator) {
        throw new Error(
          report.requires_operator
            ? "queue reconciliation requires operator resolution; SQLite was not changed"
            : "queue projection outbox delivery failed",
        );
      }
      const compatibility_status_updates = args.includes("--inspect-only")
        ? []
        : await reconcileLifecycleCompatibilityStatuses({
            databasePath: plan.databasePath,
          });
      return {
        ...report,
        compatibility_status_updates,
      };
    }

    const requestedState = resolveFlagValue(args, "--state");
    const stateFilter = requestedState?.toUpperCase() ?? null;
    if (
      stateFilter
      && !queueProjection.DURABLE_QUEUE_STATES.includes(stateFilter)
    ) {
      throw new Error(
        `unknown durable queue state: ${requestedState}. Allowed: `
        + queueProjection.DURABLE_QUEUE_STATES.join(", "),
      );
    }
    const entries = (await store.queue.list())
      .filter((entry) => !stateFilter || entry.state === stateFilter);
    const reconciliation = await queueProjection.inspectQueueProjection({
      projection,
      store,
    });
    const output = {
      authoritative: "sqlite",
      count: entries.length,
      reconciliation,
      state: stateFilter,
      tasks: entries,
    };
    console.log(JSON.stringify(output, null, 2));
    return output;
  } finally {
    store.close();
  }
}

async function runGo(args = []) {
  const workspaceRoot = resolveWorkspaceRoot();
  const plan = createInitPlan(workspaceRoot);
  if (!fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }
  const maxParallelFlag = Number(resolveFlagValue(args, "--max-parallel") ?? "1");
  const maxParallel = Number.isFinite(maxParallelFlag) && maxParallelFlag > 0
    ? Math.floor(maxParallelFlag)
    : 1;
  if (maxParallel !== 1) {
    throw new Error("Reliability RC requires --max-parallel 1");
  }
  const executorRuntime = resolveFlagValue(args, "--executor-runtime");
  const results = [];
  while (true) {
    const tick = await runLifecycleSchedulerOnce({
      executorRuntime,
      trigger: "go",
      workspaceRoot,
    });
    if (!tick.claimed) break;
    results.push(tick);
  }
  console.log(JSON.stringify({
    processed: results.length,
    results,
  }, null, 2));
}

async function runWorktree(args = []) {
  const sub = args[0];
  if (sub !== "prune" && sub !== "list") {
    throw new Error("usage: niis worktree <prune|list> [--older-than <minutes>] [--force]");
  }
  const workspaceRoot = resolveWorkspaceRoot();
  const plan = createInitPlan(workspaceRoot);
  if (!fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }
  if (sub === "list") {
    const entries = subtaskWorktree.listAllWorktrees({ stateRoot: plan.stateRoot });
    console.log(JSON.stringify({ count: entries.length, worktrees: entries }, null, 2));
    return;
  }
  const olderThanMinutes = Number(resolveFlagValue(args, "--older-than") ?? "60");
  const force = args.includes("--force");
  const report = await sweepStaleWorktreesForWorkspace({
    databasePath: plan.databasePath,
    force,
    olderThanMs: Math.max(0, olderThanMinutes) * 60 * 1000,
    stateRoot: plan.stateRoot,
    workspaceRoot,
  });
  console.log(JSON.stringify({
    kept: report.kept.length,
    removed: report.removed.map((e) => ({
      branchName: e.branchName,
      subtaskId: e.subtaskId,
      taskId: e.taskId,
      worktreePath: e.worktreePath,
    })),
  }, null, 2));
}

function collectValidRoleIds(workspaceRoot) {
  try {
    const { manifests } = loadRoleConfig({ workspaceRoot });
    return manifests.map((m) => m.id);
  } catch {
    return null;
  }
}

const DOC_REF_MAX_BYTES = 32 * 1024;
const docRefCache = new Map();

function loadDocRefs(workspaceRoot, docRefs = []) {
  if (!Array.isArray(docRefs) || docRefs.length === 0) {
    return { entries: [], missingRequired: [] };
  }
  const entries = [];
  const missingRequired = [];
  for (const ref of docRefs) {
    const refPath = typeof ref === "string" ? ref : ref?.path;
    const required = typeof ref === "string" ? true : ref?.required !== false;
    if (typeof refPath !== "string" || refPath.trim() === "") continue;
    const absolutePath = path.resolve(workspaceRoot, refPath);
    let stat;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      if (required) missingRequired.push(refPath);
      continue;
    }
    const cacheKey = `${absolutePath}:${stat.mtimeMs}`;
    if (docRefCache.has(cacheKey)) {
      entries.push(docRefCache.get(cacheKey));
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(absolutePath, "utf8");
    } catch {
      if (required) missingRequired.push(refPath);
      continue;
    }
    const truncated = content.length > DOC_REF_MAX_BYTES;
    const body = truncated
      ? `${content.slice(0, DOC_REF_MAX_BYTES)}\n... (truncated at ${DOC_REF_MAX_BYTES} bytes)`
      : content;
    const entry = Object.freeze({
      content: body,
      path: refPath,
      truncated,
    });
    docRefCache.set(cacheKey, entry);
    entries.push(entry);
  }
  return { entries, missingRequired };
}

function enrichReferenceBundleWithDocRefs(bundle, docEntries) {
  if (!Array.isArray(docEntries) || docEntries.length === 0) return bundle;
  const docGuides = docEntries.map((entry) => ({
    content: `Role doc ref [${entry.path}]:\n${entry.content}${entry.truncated ? "\n(truncated)" : ""}`,
    provenance: { source_ref: entry.path, source_type: "doc_ref" },
  }));
  return Object.freeze({
    ...bundle,
    documentationPriority: [
      ...(bundle.documentationPriority ?? []),
      ...docEntries.map((entry) => entry.path),
    ],
    guides: [
      ...docGuides,
      ...(bundle.guides ?? []),
    ],
  });
}






function buildContextContractEvidenceItem({ contract = null, roleId, subtaskId = null }) {
  if (typeof roleId !== "string" || roleId.trim() === "") return null;
  let content = "context contract absent; prompt composed from all default sources";
  try {
    const normalized = contextContract.normalizeContextContract(contract, { roleId });
    if (normalized) {
      content = contextContract.createContextContractDigestNote(
        contextContract.createContextContractDigest(normalized),
      );
    }
  } catch (error) {
    content = `context contract invalid: ${error.message}`.slice(0, 4000);
  }
  return {
    content,
    raw_output_ref: null,
    source: `context-contract:${roleId}`,
    subtask_id: subtaskId,
    type: "context_contract_digest",
  };
}
import {
  createAvailableExecutorAdapters,
  PLANNER_RUNTIME_OPTIONS,
  resolveCodexExecutor,
  resolvePreferredRuntimeDefinitions,
  runClaudeExecution,
  runCodexExecution,
  runStructuredPlanner,
} from "./intake-runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..", "..", "..");
const cliEntrypoint = path.resolve(__dirname, "..", "bin", "niis.js");
const uiAssetRoot = path.resolve(packageRoot, "packages", "ui", "src");
const CONTROL_PLANE_CSS_PATH = path.resolve(uiAssetRoot, "control-plane.css");
const CONTROL_PLANE_CLIENT_PATH = path.resolve(uiAssetRoot, "control-plane-client.js");







const PRISMJS_ROOT = path.resolve(packageRoot, "node_modules", "prismjs");
const PRISM_THEMES_ROOT = path.resolve(packageRoot, "node_modules", "prism-themes", "themes");
const PRISM_BUNDLE_LANGS = ["javascript", "typescript", "yaml", "json", "markdown"];
let cachedPrismJsBundle = null;
function readPrismJsBundle() {
  if (cachedPrismJsBundle) return cachedPrismJsBundle;
  const parts = [fs.readFileSync(path.join(PRISMJS_ROOT, "prism.js"), "utf8")];
  for (const lang of PRISM_BUNDLE_LANGS) {
    const langPath = path.join(PRISMJS_ROOT, "components", `prism-${lang}.min.js`);
    parts.push(fs.readFileSync(langPath, "utf8"));
  }
  cachedPrismJsBundle = parts.join("\n;\n");
  return cachedPrismJsBundle;
}



const PRISM_THEME_SOURCES = {
  "dracula": { source: "prism-themes", file: "prism-dracula.min.css" },
};




const SOURCE_EXTENSION_LANGS = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript",
  ".json": "json", ".jsonc": "json",
  ".yml": "yaml", ".yaml": "yaml",
  ".md": "markdown", ".mdx": "markdown",
  ".css": "css", ".scss": "scss",
  ".html": "markup", ".xml": "markup",
  ".sh": "bash", ".bash": "bash",
  ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
};

const escapeHtmlText = escapeHtml;





function renderMarkdownServer(src) {
  let safe = escapeHtmlText(src || "");
  safe = safe.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const cls = lang ? ` class="language-${lang}"` : "";
    return `<pre${cls}><code${cls}>${code}</code></pre>`;
  });
  const lines = safe.split("\n");
  const out = [];
  let i = 0, inList = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indexOf("<pre") === 0) {
      let buf = line;
      while (buf.indexOf("</pre>") === -1 && i + 1 < lines.length) { i += 1; buf += "\n" + lines[i]; }
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(buf); i += 1; continue;
    }
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<h${h[1].length}>${h[2]}</h${h[1].length}>`);
      i += 1; continue;
    }
    const li = line.match(/^[\s]*[-*]\s+(.+)$/);
    if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${li[1]}</li>`);
      i += 1; continue;
    }
    if (line.trim() === "") {
      if (inList) { out.push("</ul>"); inList = false; }
      i += 1; continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    out.push(`<p>${line}</p>`);
    i += 1;
  }
  if (inList) out.push("</ul>");
  let html = out.join("\n");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return html;
}






function renderSourceFilePage({ content, ext, relPath }) {
  const lang = SOURCE_EXTENSION_LANGS[ext];
  const filename = path.basename(relPath);
  let main;
  if (ext === ".md" || ext === ".mdx") {
    main = `<article class="md">${renderMarkdownServer(content)}</article>`;
  } else if (lang) {
    main = `<pre class="language-${lang}"><code class="language-${lang}">${escapeHtmlText(content)}</code></pre>`;
  } else {
    main = `<pre><code>${escapeHtmlText(content)}</code></pre>`;
  }
  const needsPrism = ext !== ".md" && ext !== ".mdx";



  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtmlText(filename)}</title>
<style>
  :root {
    --ivory: #F5F6F7;
    --slate: #171B20;
    --gray-700: #343A42;
    --gray-500: #5F6670;
    --gray-300: #C7CBD1;
    --gray-150: #E9EBEE;
    --paper: #FFFFFF;
    --clay: #8A5D74;
    --olive: #3F544E;
    --oat: #D9DEE5;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--ivory); color: var(--gray-700); font-family: var(--sans); font-size: 15px; line-height: 1.65; -webkit-font-smoothing: antialiased; padding: 48px 32px 96px; }
  .page { max-width: 1100px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 24px; padding-bottom: 14px; border-bottom: 1.5px solid var(--gray-300); }
  header h1 { font-family: var(--mono); font-size: 14px; color: var(--slate); font-weight: 600; letter-spacing: 0; }
  header .path { font-family: var(--mono); font-size: 12px; color: var(--gray-500); word-break: break-all; }
  header .actions { margin-left: auto; }
  header .actions a { font-family: var(--mono); font-size: 11px; color: var(--gray-500); text-decoration: none; border: 1px solid var(--gray-300); padding: 4px 10px; border-radius: 4px; }
  header .actions a:hover { color: var(--clay); border-color: var(--clay); }
  article.md h1 { font-size: 28px; font-weight: 700; color: var(--slate); letter-spacing: -0.015em; margin: 28px 0 12px; }
  article.md h2 { font-size: 19px; font-weight: 700; color: var(--slate); margin: 28px 0 10px; }
  article.md h3 { font-size: 14px; font-weight: 600; color: var(--slate); text-transform: uppercase; letter-spacing: 0.04em; margin: 22px 0 8px; }
  article.md p { margin: 0 0 14px; }
  article.md ul { padding-left: 22px; margin: 0 0 14px; }
  article.md li { margin: 4px 0; }
  article.md strong { color: var(--slate); font-weight: 600; }
  article.md a { color: var(--clay); text-decoration: none; border-bottom: 1px dashed transparent; }
  article.md a:hover { border-bottom-color: var(--clay); }
  article.md :not(pre) > code { background: var(--gray-150); padding: 1px 6px; border-radius: 4px; font-family: var(--mono); font-size: 13px; }
  article.md pre { background: var(--gray-150); border: 1px solid var(--gray-300); border-radius: 8px; padding: 14px 16px; overflow: auto; line-height: 1.5; margin: 0 0 18px; }
  article.md pre code { font-family: var(--mono); font-size: 13px; background: transparent; padding: 0; }
  body > .page > pre { background: var(--paper); border: 1px solid var(--gray-300); border-radius: 8px; padding: 16px 18px; overflow: auto; line-height: 1.5; font-family: var(--mono); font-size: 13px; color: var(--slate); }
  body > .page > pre code { font-family: var(--mono); background: transparent; }
  .token.comment, .token.prolog, .token.doctype, .token.cdata { color: var(--gray-500); font-style: italic; }
  .token.punctuation { color: var(--gray-700); }
  .token.property, .token.tag, .token.boolean, .token.number, .token.constant, .token.symbol, .token.deleted { color: #B95C0E; }
  .token.selector, .token.attr-name, .token.string, .token.char, .token.builtin, .token.inserted { color: #5B6F47; }
  .token.operator, .token.entity, .token.url, .language-css .token.string, .style .token.string { color: var(--clay); }
  .token.atrule, .token.attr-value, .token.keyword { color: #1F5A9C; }
  .token.function, .token.class-name { color: #6A3B7C; }
  .token.regex, .token.important, .token.variable { color: #B95C0E; }
</style>
${needsPrism ? '<script src="/__niis/assets/prism.js"></script>' : ""}
</head>
<body>
  <div class="page">
    <header>
      <h1>${escapeHtmlText(filename)}</h1>
      <span class="path">${escapeHtmlText(relPath)}</span>
      <span class="actions"><a href="?path=${encodeURIComponent(relPath)}&raw=1" target="_blank" rel="noopener">View raw</a></span>
    </header>
    ${main}
  </div>
</body>
</html>`;
}

function readContainedSourceFile({
  allowedRoot,
  allowedRelativePaths = null,
  baseRoot,
  maxBytes = 2 * 1024 * 1024,
  relativePath,
}) {
  const fail = (message, code) => {
    const error = new Error(message);
    error.code = code;
    throw error;
  };
  const isContained = (rootPath, candidatePath) => {
    const relative = path.relative(rootPath, candidatePath);
    return relative === ""
      || (
        relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)
      );
  };
  if (
    typeof relativePath !== "string"
    || relativePath === ""
    || relativePath.includes("\0")
    || path.isAbsolute(relativePath)
  ) {
    fail("missing or invalid path", "source_file_invalid_path");
  }
  const normalizedRelativePath = relativePath.split(path.sep).join("/");
  if (normalizedRelativePath.split("/").some((segment) =>
    segment.startsWith(".") && segment !== "." && segment !== ".."
  )) {
    fail("hidden files are not available through the source viewer", "source_file_sensitive");
  }
  if (allowedRelativePaths !== null && !allowedRelativePaths.has(normalizedRelativePath)) {
    fail("file is not present in the indexed source artifact", "source_file_not_indexed");
  }
  const canonicalAllowedRoot = fs.realpathSync(path.resolve(allowedRoot));
  const resolvedBaseRoot = path.resolve(baseRoot);
  if (!fs.existsSync(resolvedBaseRoot)) {
    fail("artifact root does not exist", "source_file_root_missing");
  }
  const canonicalBaseRoot = fs.realpathSync(resolvedBaseRoot);
  if (!isContained(canonicalAllowedRoot, canonicalBaseRoot)) {
    fail("artifact root is outside the attached project", "source_file_root_escape");
  }
  const candidatePath = path.resolve(canonicalBaseRoot, relativePath);
  if (!isContained(canonicalBaseRoot, candidatePath)) {
    fail("path escapes artifact root", "source_file_path_escape");
  }
  let currentPath = canonicalBaseRoot;
  for (const segment of path.relative(canonicalBaseRoot, candidatePath).split(path.sep)) {
    if (!segment) continue;
    currentPath = path.join(currentPath, segment);
    if (!fs.existsSync(currentPath)) {
      fail(`file not found: ${candidatePath}`, "source_file_missing");
    }
    if (fs.lstatSync(currentPath).isSymbolicLink()) {
      fail("source-file paths may not traverse symlinks", "source_file_symlink");
    }
  }
  const canonicalFilePath = fs.realpathSync(candidatePath);
  if (!isContained(canonicalBaseRoot, canonicalFilePath)) {
    fail("resolved file escapes artifact root", "source_file_path_escape");
  }
  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fileDescriptor = fs.openSync(canonicalFilePath, openFlags);
  try {
    const stat = fs.fstatSync(fileDescriptor);
    if (!stat.isFile()) {
      fail("not a regular file", "source_file_not_regular");
    }
    if (stat.size > maxBytes) {
      fail(`file too large (${stat.size} bytes; 2 MB cap)`, "source_file_too_large");
    }
    return Object.freeze({
      content: fs.readFileSync(fileDescriptor, "utf8"),
      path: canonicalFilePath,
      stat,
    });
  } finally {
    fs.closeSync(fileDescriptor);
  }
}






function renderLogsTablePage({ events, totalCount, filteredCount, filters }) {
  const fmtTs = (ts) => {
    if (typeof ts !== "string" || !ts) return "—";
    return ts.replace("T", " ").replace(/\.\d+Z$/, "Z");
  };
  const fmtPayload = (p) => {
    if (p === null || p === undefined) return "";
    try {
      const s = JSON.stringify(p);
      return s.length > 240 ? `${s.slice(0, 237)}…` : s;
    } catch {
      return "";
    }
  };
  const rowsHtml = events.length === 0
    ? `<tr><td colspan="6" class="empty">No events match the current filters. ${totalCount === 0 ? "Run a task first." : ""}</td></tr>`
    : events.map((e) => `
        <tr data-level="${escapeHtmlText(e.level || "info")}">
          <td class="ts">${escapeHtmlText(fmtTs(e.ts))}</td>
          <td><span class="chip chip-event">${escapeHtmlText(e.event_type || "—")}</span></td>
          <td><span class="chip chip-actor">${escapeHtmlText(e.actor_type || "—")}/${escapeHtmlText(e.actor_id || "—")}</span></td>
          <td class="taskid"><a href="?task_id=${encodeURIComponent(e.task_id || "")}" title="Filter to this task">${escapeHtmlText((e.task_id || "—").slice(0, 16))}</a></td>
          <td class="runid">${escapeHtmlText((e.run_id || "—").slice(0, 16))}</td>
          <td class="payload"><code>${escapeHtmlText(fmtPayload(e.payload))}</code></td>
        </tr>`).join("");
  const eventTypeOptions = ["", "run_queued", "run_started", "route_selected", "reference_bundle_ready", "agent_invoked", "agent_status", "agent_note", "artifact_emitted", "validator_started", "validator_result", "approval_required", "approval_resolved", "operator_note", "run_completed", "run_failed", "run_log"]
    .map((v) => `<option value="${v}"${v === filters.event_type ? " selected" : ""}>${v || "(any)"}</option>`).join("");
  const levelOptions = ["", "info", "success", "warning", "error"]
    .map((v) => `<option value="${v}"${v === filters.level ? " selected" : ""}>${v || "(any)"}</option>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Logs — niis</title>
<style>
  :root {
    --ivory: #F5F6F7; --slate: #171B20; --gray-700: #343A42; --gray-500: #5F6670;
    --gray-300: #C7CBD1; --gray-150: #E9EBEE; --paper: #FFFFFF; --clay: #8A5D74;
    --olive: #3F544E;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--ivory); color: var(--gray-700); font-family: var(--sans); font-size: 14px; line-height: 1.6; -webkit-font-smoothing: antialiased; padding: 32px; }
  .page { max-width: 1400px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 14px; margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1.5px solid var(--gray-300); }
  header h1 { font-family: var(--mono); font-size: 14px; color: var(--slate); font-weight: 600; }
  header .stats { font-family: var(--mono); font-size: 11px; color: var(--gray-500); }
  header .stats strong { color: var(--slate); font-weight: 600; }
  form.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 18px; padding: 10px 12px; background: var(--paper); border: 1px solid var(--gray-300); border-radius: 8px; align-items: center; }
  form.filters label { font-size: 11px; color: var(--gray-500); font-family: var(--mono); display: inline-flex; gap: 6px; align-items: center; }
  form.filters select, form.filters input { font-family: var(--mono); font-size: 12px; padding: 4px 8px; border: 1px solid var(--gray-300); border-radius: 4px; background: var(--ivory); color: var(--slate); }
  form.filters input[type="text"] { width: 160px; }
  form.filters input[type="number"] { width: 72px; }
  form.filters button { font-family: var(--mono); font-size: 11px; padding: 5px 14px; border: 1px solid var(--slate); border-radius: 4px; background: var(--slate); color: var(--ivory); cursor: pointer; }
  form.filters button:hover { background: var(--clay); border-color: var(--clay); }
  form.filters a.reset { font-family: var(--mono); font-size: 11px; color: var(--gray-500); text-decoration: none; padding: 5px 10px; border-radius: 4px; border: 1px solid var(--gray-300); }
  form.filters a.reset:hover { color: var(--clay); border-color: var(--clay); }
  table { width: 100%; border-collapse: collapse; background: var(--paper); border: 1px solid var(--gray-300); border-radius: 8px; overflow: hidden; }
  th, td { padding: 7px 10px; text-align: left; font-family: var(--mono); font-size: 12px; vertical-align: top; border-bottom: 1px solid var(--gray-150); }
  th { background: var(--gray-150); color: var(--slate); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  tr:last-child td { border-bottom: none; }
  tr { border-left: 3px solid transparent; }
  tr[data-level="info"]    { border-left-color: #9ca3af; }
  tr[data-level="success"] { border-left-color: #10b981; }
  tr[data-level="warning"] { border-left-color: #fbbf24; }
  tr[data-level="error"]   { border-left-color: #dc2626; }
  tr[data-level="error"] td { color: #991b1b; }
  td.ts { white-space: nowrap; color: var(--gray-500); }
  td.taskid a { color: var(--slate); text-decoration: none; border-bottom: 1px dotted var(--gray-300); }
  td.taskid a:hover { color: var(--clay); border-bottom-color: var(--clay); }
  td.runid { color: var(--gray-500); }
  td.payload { color: var(--gray-700); word-break: break-all; max-width: 480px; }
  td.payload code { font-family: var(--mono); font-size: 11px; }
  td.empty { text-align: center; padding: 24px; color: var(--gray-500); font-style: italic; }
  .chip { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-family: var(--mono); border: 1px solid var(--gray-300); background: var(--ivory); }
  .chip-event { color: var(--slate); }
  .chip-actor { color: var(--gray-500); font-size: 10px; }
</style>
</head>
<body>
  <div class="page">
    <header>
      <h1>task_run_events</h1>
      <span class="stats">Showing <strong>${filteredCount}</strong> of <strong>${totalCount}</strong> total. ${filteredCount === filters.limit ? `Cap: ${filters.limit}.` : ""}</span>
    </header>
    <form class="filters" method="get" action="/__niis/logs">
      <label>event_type
        <select name="event_type">${eventTypeOptions}</select>
      </label>
      <label>level
        <select name="level">${levelOptions}</select>
      </label>
      <label>task_id
        <input type="text" name="task_id" value="${escapeHtmlText(filters.task_id || "")}" placeholder="(any)" />
      </label>
      <label>limit
        <input type="number" name="limit" value="${filters.limit}" min="1" max="2000" />
      </label>
      <button type="submit">Apply</button>
      <a class="reset" href="/__niis/logs">Reset</a>
    </form>
    <table>
      <thead><tr><th>ts</th><th>event_type</th><th>actor</th><th>task_id</th><th>run_id</th><th>payload</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
</body>
</html>`;
}

function resolvePrismThemePath(id) {
  const entry = PRISM_THEME_SOURCES[id];
  if (!entry) return null;
  return entry.source === "prismjs"
    ? path.join(PRISMJS_ROOT, "themes", entry.file)
    : path.join(PRISM_THEMES_ROOT, entry.file);
}





const PROJECT_FILE_SOURCES = {
  "project-profile":        { rel: "exports/project-profile.md",        filename: "project-profile.md",        kind: "md"   },
  "workflow":               { rel: "exports/workflow.md",               filename: "workflow.md",               kind: "md"   },
  "codemap":                { rel: "exports/codemap.json",              filename: "codemap.json",              kind: "json" },
  "attached-repository":    { rel: "exports/attached-repository.json",  filename: "attached-repository.json",  kind: "json" },
  "task-sources":           { rel: "exports/task-sources.json",         filename: "task-sources.json",         kind: "json" },
  "reference-bundle-seeds": { rel: "exports/reference-bundle-seeds.json", filename: "reference-bundle-seeds.json", kind: "json" },
  "bootstrap-pack":         { rel: "exports/bootstrap-pack.json",       filename: "bootstrap-pack.json",       kind: "json" },
  "scaffold-plan":          { rel: "exports/scaffold-plan.json",        filename: "scaffold-plan.json",        kind: "json" },
  "install-state":          { rel: "install-state.json",                filename: "install-state.json",        kind: "json" },
};
function readProjectFileSnippets(workspaceRoot, maxChars = 800) {
  const projectFileSnippets = {};
  for (const [snippetId, entry] of Object.entries(PROJECT_FILE_SOURCES)) {
    const absPath = path.join(workspaceRoot, ".niis", entry.rel);
    try {
      if (!fs.existsSync(absPath)) {
        projectFileSnippets[snippetId] = { exists: false, snippet: "" };
        continue;
      }
      const raw = fs.readFileSync(absPath, "utf8");
      let snippet;
      if (entry.kind === "json") {
        try {
          snippet = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          snippet = raw;
        }
      } else {
        snippet = raw;
      }
      projectFileSnippets[snippetId] = {
        exists: true,
        snippet: snippet.slice(0, maxChars),
      };
    } catch {
      projectFileSnippets[snippetId] = { exists: false, snippet: "" };
    }
  }
  return projectFileSnippets;
}
const LAB_CSS_PATH = path.resolve(uiAssetRoot, "lab.css");
const UI_BACKGROUND_ENV = "NIIS_UI_BACKGROUND";
const PROJECT_EXECUTION_LEASE_ENV = "NIIS_PROJECT_EXECUTION_LEASE_HOLDER";
const PROJECT_EXECUTION_LEASE_ID = "__project_execution__";
const SUPERVISED_CANCELLATION_CLEANUP_BARRIER = Symbol(
  "niis.supervised-cancellation-cleanup-barrier",
);
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const LIVE_SOCKET_POLL_MS = 1000;

function getSystemTimeMs() {
  return Date.now();
}

function getSystemNow() {
  return new Date(getSystemTimeMs());
}

function getSystemTimestamp() {
  return getSystemNow().toISOString();
}

function normalizeUiMarkdownContent(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function resolveWorkspaceRoot() {
  return process.cwd();
}

function resolveValidationSurfaceRoot(args, workspaceRoot = resolveWorkspaceRoot()) {
  const explicitRoot = resolveFlagValue(args, "--validation-surface-root");

  return explicitRoot
    ? path.resolve(workspaceRoot, explicitRoot)
    : path.resolve(workspaceRoot);
}

function ensureJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function slugifyTaskIdSegment(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function createGeneratedTaskId(operatorPrompt) {
  const titleSegment = slugifyTaskIdSegment(
    taskIntake.deriveIntakeTaskTitle(operatorPrompt, "task"),
  );
  const randomSegment = randomUUID().slice(0, 8);
  return titleSegment ? `${titleSegment}-${randomSegment}` : `task-${randomSegment}`;
}

function parsePhaseFlagValue(args, flagName) {
  const value = resolveFlagValue(args, flagName);

  if (value === null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flagName} must be a non-negative integer`);
  }

  return parsed;
}

function parsePlannerRuntimeFlag(args = []) {
  const value = resolveFlagValue(args, "--planner-runtime");

  if (value === null) {
    return null;
  }

  const normalizedValue = normalizeRuntimeSelectorValue(value);

  if (!PLANNER_RUNTIME_OPTIONS.includes(normalizedValue)) {
    throw new Error(`--planner-runtime must be one of: ${PLANNER_RUNTIME_OPTIONS.join(", ")}`);
  }

  return normalizedValue;
}

function parseExecutorRuntimeFlag(args = []) {
  const value = resolveFlagValue(args, "--executor-runtime");

  if (value === null) {
    return null;
  }

  const normalizedValue = normalizeRuntimeSelectorValue(value);

  if (!PLANNER_RUNTIME_OPTIONS.includes(normalizedValue)) {
    throw new Error(`--executor-runtime must be one of: ${PLANNER_RUNTIME_OPTIONS.join(", ")}`);
  }

  return normalizedValue;
}

function normalizeRuntimeSelectorValue(value) {
  const normalizedValue = String(value ?? "").trim().toLowerCase();
  if (normalizedValue === "codex_local" || normalizedValue === "codex_app_server") return "codex";
  if (normalizedValue === "claude_code_local" || normalizedValue === "claude-code") return "claude";
  return normalizedValue;
}

async function readTextFromStdin() {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  return chunks.join("");
}

async function resolveIntakePrompt(args = []) {
  const textValue = resolveFlagValue(args, "--text");
  const fileValue = resolveFlagValue(args, "--file");
  const stdinRequested = args.includes("-");
  const selectedSources = [textValue !== null, fileValue !== null, stdinRequested].filter(Boolean).length;

  if (selectedSources !== 1) {
    throw new Error("provide exactly one intake source via --text, --file, or - for stdin");
  }

  if (textValue !== null) {
    return textValue;
  }

  if (fileValue !== null) {
    const resolvedFilePath = path.resolve(resolveWorkspaceRoot(), fileValue);
    return fs.readFileSync(resolvedFilePath, "utf8");
  }

  const stdinValue = await readTextFromStdin();
  if (stdinValue.trim() === "") {
    throw new Error("stdin intake prompt is empty");
  }

  return stdinValue;
}

const FRONTEND_PATH_PATTERNS = Object.freeze([
  "\\.html?$",
  "\\.css$",
  "\\.scss$",
  "\\.less$",
  "\\.sass$",
  "\\.jsx$",
  "\\.tsx$",
  "\\.vue$",
  "\\.svelte$",
  "(^|/)templates/",
  "(^|/)components/",
  "(^|/)styles/",
  "(^|/)assets/",
  "(^|/)public/",
  "(^|/)pages/",
  "(^|/)views/",
]);

const FRONTEND_KEYWORDS = Object.freeze([
  "ui", "frontend", "css", "html", "react", "vue", "component", "style",
  "layout", "responsive", "accessibility", "design", "button", "form",
  "modal", "navigation", "sidebar", "header", "footer",
]);

function buildIntakeAdapterRequirements(adapters = []) {
  const adapterIds = new Set(adapters.map((adapterDefinition) => adapterDefinition.id));
  const preferredRuntime = adapterIds.has("codex_local")
    ? "codex_local"
    : adapterIds.has("claude_code_local")
      ? "claude_code_local"
      : null;

  return {
    operations: ["execute"],
    protocolTypes: ["local_cli"],
    toolFamilies: preferredRuntime ? ["shell", "local_cli", preferredRuntime] : ["shell", "local_cli"],
  };
}

function buildIntakeRoleManifests(adapters = [], { workspaceRoot = resolveWorkspaceRoot() } = {}) {
  const adapter_requirements = buildIntakeAdapterRequirements(adapters);
  const { manifests } = loadRoleConfig({ workspaceRoot });
  const executionLanes = ["frontend", "generalist"];


  const selected = manifests.filter((m) => executionLanes.includes(m.lane) && m.enabled !== false);
  const overlay = selected.map((m) => ({
    ...m,
    adapter_requirements,
  }));
  if (!overlay.some((m) => m.lane === "generalist")) {
    overlay.push({
      adapter_requirements,
      id: "cli-intake-generalist",
      keywords: [],
      lane: "generalist",
      priority: 0,
      quality_bar: ["Keep changes tightly scoped and summarize the verification evidence."],
      safe_fallback: true,
    });
  }
  if (!overlay.some((m) => m.lane === "frontend")) {
    overlay.push({
      adapter_requirements,
      id: "cli-intake-frontend",
      keywords: FRONTEND_KEYWORDS,
      lane: "frontend",
      path_patterns: FRONTEND_PATH_PATTERNS,
      priority: 80,
      quality_bar: ["Apply scoped frontend changes and describe the visual verification step."],
      safe_fallback: false,
    });
  }
  return overlay;
}

function buildIntakeRoleManifest(adapters = []) {
  return buildIntakeRoleManifests(adapters)
    .find((manifest) => manifest.safe_fallback);
}

function createBlockedRoutePreview(taskId, reason) {
  return Object.freeze({
    reason,
    status: "blocked",
    task_id: taskId,
  });
}

function buildIntakeRoutePreview(artifact, {
  executorRuntime = null,
  workspaceRoot = resolveWorkspaceRoot(),
} = {}) {
  const adapters = createAvailableExecutorAdapters({
    preferredRuntime: executorRuntime,
    workspaceRoot,
  });

  if (adapters.length === 0) {
    return createBlockedRoutePreview(
      artifact.task_id,
      "No supported local runtimes are available. Install codex or claude and retry `start-task`.",
    );
  }

  try {
    const routePlan = routing.buildRoutePlan({
      adapters,
      referenceBundle: taskIntake.buildExecutionReferenceBundle(artifact),
      roleManifests: buildIntakeRoleManifests(adapters),
      routingPolicy: {},
      subtasks: artifact.subtasks ?? [],
      task: artifact.derived_task,
    });

    return sanitizeRoutePlan(routePlan);
  } catch (error) {
    return createBlockedRoutePreview(
      artifact.task_id,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function createIntakeAssignment({
  now = getSystemNow(),
  routePlan,
  taskId,
}) {
  const timestamp = now.toISOString();
  const laneId = routePlan.selected_lane?.lane_id ?? routePlan.selected_lane?.id ?? "unknown-lane";

  return {
    agent_id: "cli-agent",
    assigned_at: timestamp,
    context:
      `Selected lane ${laneId} with adapter ${routePlan.selected_adapter.id}`
      + " from CLI intake/start-task.",
    id: `${taskId}:assignment:${Date.parse(timestamp)}`,
    policy_ref: routePlan.routing_policy.policy_refs[0] ?? "routing/coordinator/v1",
    reason_type: "manual",
    task_id: taskId,
  };
}

const VERDICT_PRIORITY = {
  DEFECT: 5,
  REJECTED: 4,
  EVIDENCE_GAP: 3,
  NEEDS_REWORK: 3,
  ENV_BLOCK: 3,
  WARNING: 2,
  CONTINUE: 1,
  PASS: 0,
};

function enforceReliabilityRcMergePolicy(mergePolicy = {}) {
  return reliabilityRc.enforceReliabilityRcMergePolicy(mergePolicy);
}

const RELIABILITY_RC_REVIEW_PRESET = Object.freeze({
  branch_per_task: true,
  isolate_single_shot: false,
  mode: "none",
});

function resolveReliabilityRcMergePreset(preset) {
  return preset === "review"
    ? { ...RELIABILITY_RC_REVIEW_PRESET }
    : null;
}

function inspectWorktreeChanges(worktreePath) {
  try {
    const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: worktreePath,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      return Object.freeze({
        error: (result.stderr || result.stdout || "git status failed").trim(),
        had_changes: false,
        ok: false,
      });
    }
    const changedPaths = String(result.stdout ?? "")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "" && !line.includes(".niis-worktree.json"));
    return Object.freeze({
      changed_paths: Object.freeze(changedPaths),
      had_changes: changedPaths.length > 0,
      ok: true,
    });
  } catch (error) {
    return Object.freeze({
      error: error.message,
      had_changes: false,
      ok: false,
    });
  }
}

function createAcceptanceCommandEvidence({
  gateReport,
  runId,
  stateRoot,
  subtaskId = null,
}) {
  const gateResults = Array.isArray(gateReport?.results) ? gateReport.results : [];
  const evidenceItems = [];
  const commandResults = [];
  const storedRunLogs = [];

  for (const gate of gateResults) {
    let rawOutputRef = null;
    if (stateRoot) {
      const stored = storage.createStoredRunLogRecord({
        inlineBytes: 1,
        rawOutput: {
          args: gate.args ?? null,
          command: gate.command ?? null,
          duration_ms: gate.duration_ms,
          exit_code: gate.exit_code,
          gate_id: gate.gate_id,
          ok: gate.ok,
          stderr: gate.stderr,
          stdout: gate.stdout,
        },
        runId: `${runId}:acceptance:${gate.gate_id}`,
        stateRoot,
      });
      rawOutputRef = stored.raw_output_ref;
      storedRunLogs.push(stored);
    }

    commandResults.push({
      command_id: gate.gate_id,
      exit_code: gate.exit_code,
      ok: gate.ok === true,
      raw_output_ref: rawOutputRef,
    });
    evidenceItems.push({
      content:
        `[${gate.gate_id}] exit=${gate.exit_code} ${gate.ok ? "OK" : "FAIL"} (${gate.fail_mode})`
        + `\n--stdout--\n${gate.stdout}\n--stderr--\n${gate.stderr}`,
      raw_output_ref: rawOutputRef,
      source: `acceptance-command:${gate.gate_id}`,
      subtask_id: subtaskId,
      type: "quality_gate_result",
    });
  }

  return Object.freeze({
    command_results: Object.freeze(commandResults),
    evidence_items: Object.freeze(evidenceItems),
    required_command_ids: Object.freeze(commandResults.map((entry) => entry.command_id)),
    stored_run_logs: Object.freeze(storedRunLogs),
  });
}

function aggregateVerdicts(verdicts) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) return null;
  let worst = verdicts[0];
  let worstScore = VERDICT_PRIORITY[worst.verdict_class] ?? 0;
  for (const v of verdicts) {
    const score = VERDICT_PRIORITY[v.verdict_class] ?? 0;
    if (score > worstScore) {
      worst = v;
      worstScore = score;
    }
  }
  const reasons = verdicts.map((v) => `[${v.subtask_id ?? v.task_id ?? "?"}] ${v.verdict_class}: ${v.reason ?? "no reason"}`);
  return {
    ...worst,
    per_subtask_verdicts: verdicts,
    reason: `Aggregate of ${verdicts.length} subtask verdicts. ${reasons.join(" | ")}`,
  };
}

function aggregateParallelExecutionResults(results, baseRunId, agentId, taskId) {
  if (results.length === 0) return null;
  let totalCostUsd = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalTokensCached = 0;
  let totalDurationMs = 0;
  let earliestStartedAt = null;
  let latestFinishedAt = null;
  let aggregateStatus = "COMPLETED";
  const summaries = [];
  const allRuntimeEvents = [];
  const allTurns = [];
  const evidenceItems = [];
  const observedModelIds = new Set();
  let perSubtaskHardFailures = 0;
  for (const { contextContractEvidence, execution, gateReport, subtask } of results) {
    const summary = execution.final_response?.summary ?? "no summary";



    const subtaskRunLogRef = execution.run_record?.run_log?.ref ?? null;
    evidenceItems.push({
      content: summary,
      raw_output_ref: subtaskRunLogRef,
      source: `subtask:${subtask.id}`,
      subtask_id: subtask.id,
      type: "subtask_summary",
    });
    if (contextContractEvidence) {
      evidenceItems.push(contextContractEvidence);
    }
    if (gateReport && Array.isArray(gateReport.results)) {
      for (const gate of gateReport.results) {
        evidenceItems.push({
          content: `[${gate.gate_id}] exit=${gate.exit_code} ${gate.ok ? "OK" : "FAIL"} (${gate.fail_mode})\n--stdout--\n${gate.stdout}\n--stderr--\n${gate.stderr}`.slice(0, 4000),
          raw_output_ref: subtaskRunLogRef,
          source: `quality-gate:${subtask.id}:${gate.gate_id}`,
          subtask_id: subtask.id,
          type: "quality_gate_result",
        });
      }
      perSubtaskHardFailures += gateReport.hard_failures?.length ?? 0;
    }
    const cost = execution.run_record?.cost ?? {};
    totalCostUsd += Number(cost.estimated_usd ?? 0);
    totalTokensIn += Number(cost.tokens_in ?? 0);
    totalTokensOut += Number(cost.tokens_out ?? 0);
    totalTokensCached += Number(cost.tokens_cached ?? 0);
    totalDurationMs += Number(cost.duration_ms ?? 0);
    if (typeof cost.model_id === "string" && cost.model_id.trim() !== "") {
      observedModelIds.add(cost.model_id.trim());
    }
    const startedAt = execution.run_record?.started_at;
    const finishedAt = execution.run_record?.finished_at;
    if (startedAt && (!earliestStartedAt || startedAt < earliestStartedAt)) earliestStartedAt = startedAt;
    if (finishedAt && (!latestFinishedAt || finishedAt > latestFinishedAt)) latestFinishedAt = finishedAt;
    if (execution.run_record?.status === "FAILED" || execution.run_record?.status === "TIMED_OUT") {
      aggregateStatus = "FAILED";
    }
    summaries.push(`[${subtask.id}] ${summary}`);
    allRuntimeEvents.push(...(execution.runtime_events ?? []));
    if (execution.execution?.turns) allTurns.push(...execution.execution.turns);
  }
  const aggregateRunId = baseRunId;
  const now = new Date().toISOString();
  const adapterId = results[0]?.execution?.run_record?.adapter_id ?? "parallel";
  return {
    execution: {
      execution: { turns: allTurns },
      explainability: results[0]?.execution?.explainability ?? null,
      final_response: {
        artifacts: [],
        completion_signal: aggregateStatus === "COMPLETED",
        error: null,
        next_actions: [],
        status: aggregateStatus === "COMPLETED" ? "SUCCESS" : "ERROR",
        summary: summaries.join("\n\n"),
      },
      run_record: {
        adapter_id: adapterId,
        agent_id: agentId,
        checkpoint_id: null,
        cost: {
          duration_ms: totalDurationMs,
          estimated_usd: totalCostUsd,
          model_id: observedModelIds.size === 1 ? Array.from(observedModelIds)[0] : null,
          tokens_cached: totalTokensCached,
          tokens_in: totalTokensIn,
          tokens_out: totalTokensOut,
        },
        exit_code: aggregateStatus === "COMPLETED" ? 0 : 1,
        finished_at: latestFinishedAt ?? now,
        id: aggregateRunId,
        invocation_source: "on_demand",



        role_id: null,
        run_log: { bytes: 1, ref: null, sha256: "aggregate", storage: "inline" },
        started_at: earliestStartedAt ?? now,
        status: aggregateStatus,
        subtask_id: null,
        task_id: taskId,
        task_session_key: null,
      },
      runtime_events: allRuntimeEvents,
    },
    perSubtaskResults: results,
    aggregateStatus: perSubtaskHardFailures > 0 ? "FAILED" : aggregateStatus,
    evidenceItems,
    perSubtaskHardFailures,
  };
}

async function runParallelSubtaskDispatch({
  artifact,
  availableAdapters,
  baseRunId,
  inProgressTask,
  networkPolicy = { mode: "disabled" },
  sandboxPolicy = { concurrency: 1, mode: "workspace-write" },
  stateRoot = null,
  workspaceRoot,
  taskBranchActive = false,




  databasePath = null,
}) {
  const configuredMergePolicy = getMergePolicy({ workspaceRoot });
  const mergePolicy = enforceReliabilityRcMergePolicy(configuredMergePolicy);
  if (configuredMergePolicy.mode === "auto_merge") {
    process.stderr.write(
      "[niis] Reliability RC disables auto_merge; successful worktrees will be retained for review.\n",
    );
  }
  const subtaskTimeoutMs = getSubtaskTimeoutMs({ workspaceRoot });






  let streamingStorage = null;
  let buildRecordCodexEvent = null;
  if (databasePath) {
    try {
      streamingStorage = storage.createSqliteStorage({ databasePath });
      buildRecordCodexEvent = ({ taskId, runId }) => (evt) => {
        if (!evt || evt.kind !== "notification" || !evt.method) return;
        const now = new Date().toISOString();
        try {
          if (evt.method === "item/agentMessage/delta" && typeof evt.params?.delta === "string") {
            streamingStorage.taskLiveExcerpts.append({
              id: `${runId}:excerpt:${randomUUID()}`,
              task_id: taskId, run_id: runId, ts: now,
              channel: "stdout", level: "info",
              payload: { stream: "stdout", chunk: evt.params.delta, source: "codex" },
            });
            return;
          }
          if (evt.method === "error" || evt.method === "thread/error") {
            streamingStorage.taskRunEvents.append({
              id: `${runId}:rev:${randomUUID()}`,
              task_id: taskId, run_id: runId, ts: now,
              event_type: "run_failed", level: "error",
              actor_type: "runtime", actor_id: "codex_local",
              visibility: "verbose",
              payload: { method: evt.method, params: evt.params },
            });
            return;
          }
          if (evt.method === "turn/completed" || evt.method === "item/started" || evt.method === "item/completed") {
            streamingStorage.taskRunEvents.append({
              id: `${runId}:rev:${randomUUID()}`,
              task_id: taskId, run_id: runId, ts: now,
              event_type: "agent_status", level: "info",
              actor_type: "runtime", actor_id: "codex_local",
              visibility: "debug",
              payload: { method: evt.method, params: evt.params },
            });
          }
        } catch (err) {

          process.stderr.write(`[codex-stream] sink error: ${err.message}\n`);
        }
      };
    } catch (err) {
      process.stderr.write(`[codex-stream] failed to open sqlite for streaming: ${err.message}\n`);
      streamingStorage = null;
    }
  }
  const declaredSubtasks = (artifact.subtasks ?? []).map((s) => ({ ...s, status: s.status ?? "PENDING" }));
  let subtasks = declaredSubtasks;
  let synthesizedSingleShot = false;











  if (declaredSubtasks.length === 0) {
    if (mergePolicy.isolate_single_shot && !taskBranchActive) {
      subtasks = [{
        depends_on: [],
        id: `${inProgressTask.id}:main`,
        parent_task_id: inProgressTask.id,
        reference_bundle_id: `${inProgressTask.id}:reference-bundle`,
        role_id: null,
        status: "PENDING",
        synthetic: true,
        title: inProgressTask.title ?? "Primary execution",
      }];
      synthesizedSingleShot = true;
    } else {
      return null;
    }
  } else if (declaredSubtasks.length === 1) {
    if (taskBranchActive) return null;
    const soloHasRole = Boolean(declaredSubtasks[0].role_id);
    if (!soloHasRole && !mergePolicy.isolate_single_shot) return null;
  }
  const useWorktree = stateRoot && process.env.NIIS_DISABLE_WORKTREE !== "1";
  let sourceBranch = null;
  if (useWorktree) {
    try {
      sourceBranch = subtaskWorktree.deriveSourceBranch({ workspaceRoot });
      if (!subtaskWorktree.isWorkspaceClean({ workspaceRoot })) {
        if (mergePolicy.mode === "auto_merge") {
          const err = new Error("Workspace has uncommitted changes. Commit or stash before running with merge_policy.mode=auto_merge; merging subtask branches back into a dirty base would be unsafe.");
          err.code = "dirty_workspace";
          throw err;
        }
        process.stderr.write(`[niis] Warning: workspace has uncommitted changes. Subtask worktrees will still be isolated; operator-initiated merge may pick them up manually.\n`);
      }
    } catch (error) {
      if (error.code === "dirty_workspace") throw error;
      process.stderr.write(`[niis] Worktree isolation unavailable (${error.message}); falling back to in-place parallel execution.\n`);
      sourceBranch = null;
    }
  }
  const worktreeMap = new Map();
  const allResults = [];
  const activeSubtaskControllers = new Set();
  let externallyCancelled = false;
  let pending = [...subtasks];

  let queueWatcher = null;
  if (stateRoot) {
    try {
      const queuePaths = taskQueue.createQueuePaths(stateRoot);
      const canonicalTaskId = schemas.task.assertCanonicalTaskId(
        inProgressTask.id,
      );
      const expectedName = `${canonicalTaskId}.json`;
      const expectedInProgressFile = path.join(
        queuePaths.in_progress,
        expectedName,
      );
      const inProgressFile = pathSafety.canonicalizePath(
        expectedInProgressFile,
      );
      if (inProgressFile !== expectedInProgressFile) {
        throw new Error(
          "in-progress queue marker must not resolve through a filesystem alias",
        );
      }
      if (fs.existsSync(queuePaths.in_progress)) {
        queueWatcher = fs.watch(queuePaths.in_progress, (eventType, filename) => {
          if (!filename || filename !== expectedName) return;
          if (eventType !== "rename") return;
          if (fs.existsSync(inProgressFile)) return;
          externallyCancelled = true;
          process.stderr.write(`[niis] Task ${inProgressTask.id} removed from queue/in-progress externally; cancelling active subtasks.\n`);
          for (const controller of activeSubtaskControllers) {
            controller.abort();
          }
        });
      }
    } catch (error) {
      process.stderr.write(`[niis] Queue watcher unavailable: ${error.message}\n`);
    }
  }

  try {
    while (true) {
      const batch = routing.planParallelDispatch({
        maxParallel: 1,
        roleManifests: buildIntakeRoleManifests(availableAdapters, { workspaceRoot }),
        subtasks: pending,
      });
      if (batch.length === 0) break;

      if (useWorktree && sourceBranch) {
        for (const subtask of batch) {
          if (worktreeMap.has(subtask.id)) continue;
          try {
            const wt = subtaskWorktree.createSubtaskWorktree({
              sourceBranch,
              stateRoot,
              subtaskId: subtask.id,
              taskId: inProgressTask.id,
              workspaceRoot,
            });
            worktreeMap.set(subtask.id, wt);
          } catch (error) {
            process.stderr.write(`[niis] Failed to create worktree for ${subtask.id}: ${error.message}. Subtask will run in shared workspace.\n`);
          }
        }
      }

      if (stateRoot) {
        for (const subtask of batch) {
          updateSubtaskProgress({
            roleId: subtask.role_id,
            startedAt: new Date().toISOString(),
            stateRoot,
            status: "RUNNING",
            subtaskId: subtask.id,
            taskId: inProgressTask.id,
          });
        }
      }

      const batchResults = await Promise.all(batch.map(async (subtask) => {
        const subtaskAsTask = {
          ...inProgressTask,
          id: subtask.id,
          title: subtask.title ?? inProgressTask.title,
        };
        const subtaskRefBundle = taskIntake.buildExecutionReferenceBundle({
          ...artifact,
          derived_task: subtaskAsTask,
        });
        const wt = worktreeMap.get(subtask.id) ?? null;
        const executionWorkspaceRoot = wt?.worktreePath ?? workspaceRoot;
        const baseAdapters = wt
          ? createAvailableExecutorAdapters({ workspaceRoot: executionWorkspaceRoot })
          : availableAdapters;
        const abortController = new AbortController();
        activeSubtaskControllers.add(abortController);
        if (externallyCancelled) abortController.abort();
        const subtaskRunId = `${baseRunId}:${subtask.id}`;
        const recordCodexEvent = buildRecordCodexEvent
          ? buildRecordCodexEvent({ taskId: inProgressTask.id, runId: subtaskRunId })
          : null;
        const adaptersForSubtask = baseAdapters.map((adapter) => ({
          ...adapter,
          execute: async (context = {}) => adapter.execute({
            ...context,
            abort_signal: abortController.signal,
            network_policy: networkPolicy,
            sandbox_policy: sandboxPolicy,
            ...(recordCodexEvent ? { record_codex_event: recordCodexEvent } : {}),
          }),
        }));
        const timeoutMs = subtaskTimeoutMs;
        const timeoutHandle = timeoutMs > 0
          ? setTimeout(() => {
            abortController.abort();
            process.stderr.write(`[niis] Subtask ${subtask.id} exceeded ${timeoutMs}ms; aborting.\n`);
          }, timeoutMs)
          : null;
        let result;
        try {
          result = await routing.runTaskExecution({
            adapters: adaptersForSubtask,
            agentId: "cli-agent",
            referenceBundle: subtaskRefBundle,
            roleManifests: buildIntakeRoleManifests(adaptersForSubtask, { workspaceRoot }),
            routingPolicy: {},
            runId: `${baseRunId}:${subtask.id}`,
            subtasks: [],
            task: subtaskAsTask,
          });
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          activeSubtaskControllers.delete(abortController);
        }







        if (stateRoot && result?.run_record?.id
          && result.run_record.run_log?.storage !== "ref") {
          const subStoredRunLog = storage.createStoredRunLogRecord({
            inlineBytes: 1,
            rawOutput: result.execution?.turns?.at(-1)?.raw_result?._raw_runtime_output
              ?? result.execution?.turns?.at(-1)?.raw_result
              ?? result.final_response,
            runId: result.run_record.id,
            stateRoot,
          });
          result = {
            ...result,
            run_record: {
              ...result.run_record,
              run_log: subStoredRunLog.run_log,
            },
          };
        }
        let gateReport = null;
        const gateRoleId = subtask.role_id ?? result.run_record?.role_id ?? null;
        if (gateRoleId) {
          const subtaskManifest = loadRoleById(gateRoleId, { workspaceRoot });
          const gates = subtaskManifest?.quality_gates ?? [];
          if (Array.isArray(gates) && gates.length > 0) {
            gateReport = runQualityGates({
              gates,
              subtaskId: subtask.id,
              workspaceRoot: executionWorkspaceRoot,
            });
          }
        }
        if (stateRoot) {
          const failedHard = gateReport?.hard_failures?.length ?? 0;
          const baseFailed = result.run_record?.status === "FAILED" || result.run_record?.status === "TIMED_OUT";
          const status = (baseFailed || failedHard > 0) ? "FAILED" : "DONE";
          updateSubtaskProgress({
            cost: result.run_record?.cost ?? null,
            finishedAt: result.run_record?.finished_at ?? new Date().toISOString(),
            roleId: subtask.role_id,
            stateRoot,
            status,
            subtaskId: subtask.id,
            summary: result.final_response?.summary ?? null,
            taskId: inProgressTask.id,
          });
        }
        const acceptanceCommandEvidence = createAcceptanceCommandEvidence({
          gateReport,
          runId: result.run_record?.id ?? `${baseRunId}:${subtask.id}`,
          stateRoot,
          subtaskId: subtask.id,
        });
        return {
          acceptanceCommandEvidence,
          contextContractEvidence: buildContextContractEvidenceItem({
            contract: result.route_plan?.delegation_payload?.context_contract ?? null,
            roleId: result.run_record?.role_id ?? subtask.role_id ?? null,
            subtaskId: subtask.id,
          }),
          execution: result,
          gateReport,
          subtask,
        };
      }));
      allResults.push(...batchResults);

      if (externallyCancelled) {
        break;
      }

      const batchIds = new Set(batch.map((b) => b.id));
      pending = pending.map((s) => batchIds.has(s.id) ? { ...s, status: "DONE" } : s);
    }

    const aggregate = aggregateParallelExecutionResults(allResults, baseRunId, "cli-agent", inProgressTask.id);
    if (!aggregate) return null;
    aggregate.worktrees = [...worktreeMap.values()];
    aggregate.sourceBranch = sourceBranch;
    aggregate.blockers = [];
    aggregate.subtaskBranches = [];
    aggregate.mergePolicy = mergePolicy.mode;

    if (worktreeMap.size > 0 && sourceBranch && aggregate.aggregateStatus === "COMPLETED") {
      const branchRecords = [];
      for (const { subtask } of allResults) {
        const wt = worktreeMap.get(subtask.id);
        if (!wt) continue;
        const inspection = inspectWorktreeChanges(wt.worktreePath);
        const record = {
          branch_name: wt.branchName,
          committed: false,
          had_changes: inspection.had_changes,
          inspection_error: inspection.ok ? null : inspection.error,
          merge_status: inspection.had_changes ? "awaiting_review" : "no_changes",
          subtask_id: subtask.id,
          worktree_path: wt.worktreePath,
        };
        branchRecords.push(record);
      }
      aggregate.subtaskBranches = branchRecords;

      if (stateRoot) {
        for (const record of branchRecords) {
          updateSubtaskProgress({
            branch: {
              had_changes: record.had_changes,
              merge_status: record.merge_status,
              name: record.branch_name,
              source_branch: sourceBranch,
              worktree_path: record.worktree_path,
            },
            stateRoot,
            status: record.had_changes ? "DONE" : "DONE",
            subtaskId: record.subtask_id,
            taskId: inProgressTask.id,
          });
        }
      }
    }

    if (externallyCancelled) {
      aggregate.externally_cancelled = true;
      aggregate.aggregateStatus = "FAILED";
    }
    aggregate.synthesizedSingleShot = synthesizedSingleShot;
    return aggregate;
  } catch (error) {
    if (worktreeMap.size > 0) {
      process.stderr.write(`[niis] Parallel dispatch failed: ${error.message}. Worktrees preserved at ${stateRoot}/worktrees/${inProgressTask.id}/ for inspection.\n`);
    }
    throw error;
  } finally {
    if (queueWatcher) {
      try { queueWatcher.close(); } catch {  }
    }
    if (streamingStorage) {
      try { streamingStorage.close(); } catch {  }
    }
  }
}

function createStartTaskObservedOutcome(execution, {
  acceptanceCommandResults = [],
  hardGateFailures = [],
  requiredAcceptanceCommandIds = [],
  securityScanSurfaces = [],
  securitySurfaceType = "review",
} = {}) {
  const finalResponse = execution.final_response ?? {};





  const baseSecurity = {
    acceptance_command_results:
      Array.isArray(acceptanceCommandResults) ? acceptanceCommandResults : [],
    hard_gate_failures:
      Array.isArray(hardGateFailures) ? hardGateFailures : [],
    required_acceptance_command_ids:
      Array.isArray(requiredAcceptanceCommandIds) ? requiredAcceptanceCommandIds : [],
    security_scan_surfaces: Array.isArray(securityScanSurfaces) ? securityScanSurfaces : [],
    security_surface_type: securitySurfaceType,
  };

  if (finalResponse.status === "ERROR") {
    return {
      ...baseSecurity,
      completion_confirmed: false,
      environment_blocked:
        finalResponse.error?.category === "env_block"
          ? (finalResponse.error?.root_cause ?? finalResponse.summary)
          : null,
      partial_progress: false,
    };
  }

  return {
    ...baseSecurity,
    completion_confirmed: finalResponse.completion_signal === true,
    environment_blocked: null,
    partial_progress: finalResponse.completion_signal !== true,
  };
}

function writeIntakeReportArtifacts({
  report,
  stateRoot,
  taskId,
}) {
  const paths = taskIntake.createTaskIntakePaths(stateRoot, taskId);
  ensureJsonFile(paths.report_json_path, report);
  fs.writeFileSync(paths.report_markdown_path, taskIntake.renderTaskReportMarkdown(report));
  return paths;
}

function logSelectedRuntime(label, runtimeId) {
  if (typeof runtimeId !== "string" || runtimeId.trim() === "") {
    return;
  }

  process.stderr.write(`Using ${label} runtime: ${runtimeId}\n`);
}

function readInstalledNiisVersion() {
  const coreManifestPath = path.join(packageRoot, "packages", "core", "package.json");
  const coreManifest = JSON.parse(fs.readFileSync(coreManifestPath, "utf8"));
  return coreManifest.version ?? "0.1.0";
}

function resolveRuntimeInstallStatePath(spec, workspaceRoot = resolveWorkspaceRoot()) {
  return path.resolve(
    workspaceRoot,
    spec.installStatePath
      ?? spec.install_state_path
      ?? createInitPlan(workspaceRoot).installStatePath,
  );
}

async function loadActivatedRuntimePackagesForSpec(
  spec,
  {
    packageTypes = [],
    context = {},
    workspaceRoot = resolveWorkspaceRoot(),
  } = {},
) {
  if (spec.includeActivatedPackages === false || spec.include_activated_packages === false) {
    return {
      agents: [],
      adapters: [],
      packages: [],
      roleManifests: [],
      validators: [],
    };
  }

  const installStatePath = resolveRuntimeInstallStatePath(spec, workspaceRoot);
  if (!fs.existsSync(installStatePath)) {
    return {
      agents: [],
      adapters: [],
      packages: [],
      roleManifests: [],
      validators: [],
    };
  }

  return packageRuntime.loadActivatedRuntimePackages({
    context,
    installStatePath,
    packageRoot: path.resolve(
      workspaceRoot,
      spec.packageRoot
        ?? spec.package_root
        ?? workspaceRoot,
    ),
    packageTypes,
  });
}

function resolveActivationAvailableAdapters(spec, installStatePath) {
  const declaredAdapters = Array.isArray(spec.availableAdapters ?? spec.available_adapters)
    ? (spec.availableAdapters ?? spec.available_adapters)
    : [];
  const persistedInstallState = installState.readInstallState(installStatePath);
  const persistedAdapters = persistedInstallState?.entries
    ?.filter((entry) => entry.target_kind === "adapter" && entry.package_id)
    .map((entry) => entry.package_id)
    ?? [];

  return [...new Set([...declaredAdapters, ...persistedAdapters])];
}

async function main(argv) {
  const [command, ...rest] = argv;

  switch (command) {
    case "init":
      return runInit(rest);
    case "reset-state":
      return runResetState(rest);
    case "attach":
      return runAttach(rest);
    case "profile":
      return runProfile(rest);
    case "intake":
      return runIntake(rest);
    case "approve-plan":
      return runApprovePlan(rest);
    case "start-task":
      return runStartTask(rest);
    case "readiness":
      return runReadiness(rest);
    case "delete-task":
      return runDeleteTask(rest);
    case "doctor":
      return runDoctor(rest);
    case "render-artifacts":
      return runRenderArtifacts(rest);
    case "secret-set":
      return runSecretSet(rest);
    case "secret-list":
      return runSecretList();
    case "backup":
      return runBackup(rest);
    case "restore":
      return runRestore(rest);
    case "route":
      return runRoute(rest);
    case "run":
      return runExecution(rest);
    case "review":
      return runReview(rest);
    case "activate":
      return runActivate(rest);
    case "discover":
      return runDiscover(rest);
    case "discover-pipeline":
      return runDiscoverPipeline(rest);
    case "promote-instinct":
      return runPromoteInstinct(rest);
    case "export-instincts":
      return runExportInstincts(rest);
    case "import-instincts":
      return runImportInstincts(rest);
    case "cluster-instincts":
      return runClusterInstincts(rest);
    case "govern-learning":
      return runGovernLearning(rest);
    case "observation-lifecycle":
      return runObservationLifecycle(rest);
    case "guard-observation":
      return runGuardObservation(rest);
    case "memory-taxonomy":
      return runMemoryTaxonomy(rest);
    case "import":
      return runImport(rest);
    case "plugin-plan":
      return runPluginPlan(rest);
    case "storage-plan":
      return runStoragePlan(rest);
    case "upgrade-plan":
      return runUpgradePlan(rest);
    case "serve":
      return runServe(rest);
    case "worker":
      return runAutonomousWorker(rest);
    case "explain":
      return runExplain(rest);
    case "activity":
      return runActivity(rest);
    case "metrics":
      return runMetrics(rest);
    case "ui":
      return runUi(rest);
    case "asset-health":
      return runAssetHealth(rest);
    case "worktree":
      return runWorktree(rest);
    case "subtask":
      return runSubtask(rest);
    case "queue":
      return runQueue(rest);
    case "go":
      return runGo(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return printHelp();
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

function runInit(args = []) {
  if (args.length > 0) {
    throw new Error("usage: niis init");
  }

  const workspaceRoot = resolveWorkspaceRoot();
  const initialized = initializeBootstrapState(workspaceRoot, {
    installRoot: packageRoot,
  });
  const plan = initialized.plan;
  const secretStorePaths = storage.createSecretStorePaths(plan.stateRoot);

  console.log(
    initialized.mode === "created"
      ? "Initialized Niis bootstrap state root:"
      : initialized.mode === "repaired"
        ? "Repaired missing Niis bootstrap artifacts:"
        : "Verified existing Niis bootstrap state root:",
  );
  console.log(`- mode: ${initialized.mode}`);
  console.log(`- package root: ${initialized.install_root}`);
  console.log(`- state root: ${plan.stateRoot}`);
  console.log(`- sqlite db: ${plan.databasePath}`);
  console.log(`- artifacts root: ${plan.artifactsRoot}`);
  console.log(`- run-log store: ${plan.runLogsRoot}`);
  console.log(`- secret store: ${secretStorePaths.secretStorePath}`);
  console.log(`- secret key: ${secretStorePaths.secretMasterKeyPath}`);
  console.log(`- backup policy: ${plan.backupPolicyPath}`);
  console.log(`- install state: ${plan.installStatePath}`);
  if (initialized.repaired.length > 0) {
    console.log(`- repaired: ${initialized.repaired.join(", ")}`);
  }
}

async function runResetState(args = []) {
  const workspaceRoot = resolveWorkspaceRoot();
  const backupTo = resolveFlagValue(args, "--backup-to");
  const confirmProjectId = resolveFlagValue(args, "--confirm");

  if (!backupTo || !confirmProjectId) {
    throw new Error(
      `usage: niis reset-state --backup-to <external-path> --confirm ${deriveBootstrapProjectId(workspaceRoot)}`,
    );
  }

  const resolvedBackupTo = path.resolve(process.cwd(), backupTo);
  const preflight = preflightResetBootstrapState(workspaceRoot, {
    backupTo: resolvedBackupTo,
    confirmProjectId,
  });
  const plan = preflight.plan;
  const maintenanceLease = fs.existsSync(plan.databasePath)
    ? await acquireProjectExecutionLease({
        allowInherited: false,
        databasePath: plan.databasePath,
        holder: `reset-state:${process.pid}:${randomUUID()}`,
        stateRoot: plan.stateRoot,
      })
    : null;
  try {
    if (maintenanceLease) {
      const lifecycleStore = storage.createLifecycleSqliteStore({
        databasePath: plan.databasePath,
        readonly: true,
      });
      try {
        const activeAttempt = (await lifecycleStore.attempts.list())
          .find((attempt) => !["BLOCKED", "FAILED", "CANCELLED", "FINISHED"].includes(
            attempt.stage,
          ));
        if (activeAttempt) {
          throw lifecycleQueueClaimError(
            `cannot reset state while attempt ${activeAttempt.id} is active`,
            "reset_state_active_attempt",
            { attempt_id: activeAttempt.id, attempt_stage: activeAttempt.stage },
          );
        }
        const now = new Date();
        const activeClaim = (await lifecycleStore.queue.list())
          .find((entry) => isActiveLifecycleQueueClaim(entry, now));
        if (activeClaim) {
          throw lifecycleQueueClaimError(
            `cannot reset state while queue claim ${activeClaim.task_id} is active`,
            "reset_state_active_queue_claim",
            { claimed_task_id: activeClaim.task_id },
          );
        }
      } finally {
        lifecycleStore.close();
      }
    }

    const result = resetBootstrapState(workspaceRoot, {
      backupTo: resolvedBackupTo,
      confirmProjectId,
    });

    console.log("Reset Niis state after verified external backup:");
    console.log(`- project id: ${result.project_id}`);
    console.log(`- removed state root: ${result.state_root}`);
    console.log(`- backup directory: ${result.backup_directory}`);
    console.log(`- backup manifest: ${result.backup_manifest}`);
    console.log(`- source tree sha256: ${result.source_tree_sha256}`);
  } finally {
    await maintenanceLease?.release();
  }
}

async function runAttach(args = []) {
  const workspaceRoot = resolveWorkspaceRoot();
  const validationSurfaceRoot = resolveValidationSurfaceRoot(args, workspaceRoot);
  const plan = createAttachPlan(workspaceRoot, {
    validationSurfaceRoot,
  });

  if (!fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }

  const result = onboarding.generateOnboardingArtifacts({
    now: getSystemNow(),
    packageRoot: workspaceRoot,
    validationSurfaceRoot,
  });

  console.log("Recorded validation-surface attachment:");
  console.log(`- validation surface: ${plan.validationSurfaceRoot}`);
  console.log(`- artifact: ${plan.attachmentPath}`);
  console.log("- generated reviewable onboarding artifacts:");
  console.log(`  - project profile: ${result.artifacts.project_profile}`);
  console.log(`  - workflow: ${result.artifacts.workflow}`);
  console.log(`  - codemap: ${result.artifacts.codemap}`);
  console.log(`  - task sources: ${result.artifacts.task_sources}`);
  console.log(`  - reference seeds: ${result.artifacts.reference_seed_model}`);
  console.log(`  - bootstrap pack: ${result.artifacts.bootstrap_pack}`);
  console.log(`  - scaffold plan: ${result.artifacts.scaffold_plan}`);

}

async function runRenderArtifacts(args = []) {
  const workspaceRoot = resolveWorkspaceRoot();
  const force = args.includes("--force");
  const useStub = args.includes("--stub");
  const useCodex = args.includes("--codex");
  const useClaude = args.includes("--claude");
  const useAll = args.includes("--all");
  const confirmProviderCost = args.includes("--confirm-provider-cost");
  const artifactFlagIdx = args.indexOf("--artifact");
  const artifactId = artifactFlagIdx >= 0 ? args[artifactFlagIdx + 1] : null;
  const selectedModes = [useStub, useCodex, useClaude].filter(Boolean).length;
  if (selectedModes !== 1 || useAll === Boolean(artifactId)) {
    throw new Error(
      "usage: niis render-artifacts (--stub|--codex|--claude) (--artifact <id>|--all) [--force] [--confirm-provider-cost]",
    );
  }
  if (artifactId && !ILLUSTRATOR_ARTIFACTS[artifactId]) {
    throw new Error(`unknown illustrator artifact id: ${artifactId}`);
  }
  if (!useStub && !confirmProviderCost) {
    throw new Error("provider rendering requires --confirm-provider-cost");
  }
  const artifactIds = artifactId ? [artifactId] : null;
  const artifactCount = artifactIds?.length ?? Object.keys(ILLUSTRATOR_ARTIFACTS).length;
  let renderer;
  let generator = "stub-v1";
  let model = null;
  if (useStub) {
    renderer = undefined;
    console.log("Using stub renderer (--stub).");
  } else {
    const preferred = useCodex ? "codex" : "claude";
    process.stderr.write(
      `[niis] Confirmed provider rendering for ${artifactCount} artifact(s); each artifact may consume paid credits or API quota.\n`,
    );
    const runtimes = resolvePreferredRuntimeDefinitions({ preferredRuntime: preferred });
    const runtime = runtimes[0];
    if (!runtime) {
      throw new Error(`requested '${preferred}' runtime is unavailable`);
    } else {
      const manifestPath = path.join(packageRoot, "config", "role-manifests", "artifact-illustrator.md");
      const stylePath = path.join(packageRoot, "config", "role-manifests", "artifact-illustrator-style.md");
      const manifestBody = loadManifestBody(manifestPath, { extraFiles: [stylePath] });




      const exec = runtime.runtimeId === "codex_local"
        ? resolveCodexExecutor()
        : runClaudeExecution;
      renderer = createLlmRenderer({
        commandPath: runtime.commandPath,
        runtimeId: runtime.runtimeId,
        exec,
        manifestBody,
        workspaceRoot,
      });
      const transport = runtime.runtimeId === "codex_local" ? "codex_app_server" : runtime.runtimeId;
      generator = `${transport}-v1`;
      model = runtime.runtimeId;
      console.log(`Using ${transport} renderer (${runtime.commandPath}).`);
    }
  }

  const results = await renderAllArtifacts({
    workspaceRoot,
    force,
    artifactIds,
    renderer,
    generator,
    model,
    onProgress: ({ artifactId, phase }) => {
      if (phase === "start") process.stdout.write(`- ${artifactId}: rendering… `);
      if (phase === "end") process.stdout.write("\n");
    },
  });
  let rendered = 0, skipped = 0, missing = 0, failed = 0;
  for (const r of results) {
    if (r.status === "rendered") rendered++;
    else if (r.status === "skipped") skipped++;
    else if (r.status === "missing") missing++;
    else failed++;
    const elapsed = r.elapsedMs ? ` in ${(r.elapsedMs / 1000).toFixed(1)}s` : "";
    console.log(`  ${r.artifactId}: ${r.status}${r.reason ? ` (${r.reason})` : ""}${elapsed}`);
  }
  console.log(`Done. rendered=${rendered} skipped=${skipped} missing=${missing} failed=${failed}`);
}

const ARTIFACT_RENDER_ADAPTERS = Object.freeze({
  claude: { label: "Claude" },
  codex: { label: "Codex" },
});

function normalizeArtifactRenderAdapter(value) {
  return Object.prototype.hasOwnProperty.call(ARTIFACT_RENDER_ADAPTERS, value) ? value : "claude";
}

function createArtifactRenderer({ workspaceRoot, preferredRuntime = "claude" }) {
  const adapterId = normalizeArtifactRenderAdapter(preferredRuntime);
  const runtimes = resolvePreferredRuntimeDefinitions({ preferredRuntime: adapterId });
  const runtime = runtimes[0];
  if (!runtime) return null;

  const manifestPath = path.join(packageRoot, "config", "role-manifests", "artifact-illustrator.md");
  const stylePath = path.join(packageRoot, "config", "role-manifests", "artifact-illustrator-style.md");
  const manifestBody = loadManifestBody(manifestPath, { extraFiles: [stylePath] });
  const exec = runtime.runtimeId === "codex_local"
    ? resolveCodexExecutor()
    : runClaudeExecution;
  const transport = runtime.runtimeId === "codex_local" ? "codex_app_server" : runtime.runtimeId;
  return {
    adapterId,
    adapterLabel: ARTIFACT_RENDER_ADAPTERS[adapterId].label,
    commandPath: runtime.commandPath,
    generator: `${transport}-v1`,
    model: runtime.runtimeId,
    renderer: createLlmRenderer({
      commandPath: runtime.commandPath,
      runtimeId: runtime.runtimeId,
      exec,
      manifestBody,
      workspaceRoot,
    }),
    runtimeId: runtime.runtimeId,
  };
}

async function renderProjectArtifactHtmlWithAdapter({ workspaceRoot, artifactId, adapterId = "claude" }) {
  if (!ILLUSTRATOR_ARTIFACTS[artifactId]) {
    const error = new Error(`unknown illustrator artifact id: ${artifactId}`);
    error.statusCode = 404;
    throw error;
  }

  const normalizedAdapterId = normalizeArtifactRenderAdapter(adapterId);
  const artifactRenderer = createArtifactRenderer({ workspaceRoot, preferredRuntime: normalizedAdapterId });
  if (!artifactRenderer) {
    const label = ARTIFACT_RENDER_ADAPTERS[normalizedAdapterId].label;
    const envHint = normalizedAdapterId === "codex" ? "NIIS_CODEX_LOCAL_BIN" : "NIIS_CLAUDE_CODE_LOCAL_BIN";
    const error = new Error(`${label} runtime is not available. Install/authenticate the local ${label} adapter, or set ${envHint}.`);
    error.statusCode = 503;
    throw error;
  }

  const [result] = await renderAllArtifacts({
    workspaceRoot,
    force: true,
    artifactIds: [artifactId],
    renderer: artifactRenderer.renderer,
    generator: artifactRenderer.generator,
    model: artifactRenderer.model,
  });
  if (!result || result.status !== "rendered") {
    const error = new Error(result?.reason || `${artifactRenderer.adapterLabel} render failed for ${artifactId}`);
    error.statusCode = result?.status === "missing" ? 404 : 500;
    error.renderResult = result ?? null;
    throw error;
  }

  const generated = readArtifactHtml(workspaceRoot, artifactId);
  if (!generated) {
    const error = new Error(`Claude rendered ${artifactId}, but no HTML file was written.`);
    error.statusCode = 500;
    error.renderResult = result;
    throw error;
  }

  return {
    adapterId: artifactRenderer.adapterId,
    adapterLabel: artifactRenderer.adapterLabel,
    body: generated.body,
    generator: artifactRenderer.generator,
    meta: generated.meta,
    model: artifactRenderer.model,
    outputPath: generated.outputPath,
    result,
    runtimeId: artifactRenderer.runtimeId,
  };
}

function runProfile(args = []) {
  const workspaceRoot = resolveWorkspaceRoot();
  const validationSurfaceRoot = resolveValidationSurfaceRoot(args, workspaceRoot);
  const plan = createAttachPlan(workspaceRoot, {
    validationSurfaceRoot,
  });

  if (!fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }

  if (!fs.existsSync(plan.attachmentPath)) {
    throw new Error("attached repository artifact is missing; run `attach` first");
  }

  const result = onboarding.generateOnboardingArtifacts({
    now: getSystemNow(),
    packageRoot: workspaceRoot,
    validationSurfaceRoot,
  });

  console.log("Generated reviewable project profile:");
  console.log(`- validation surface: ${plan.validationSurfaceRoot}`);
  console.log(`- project profile: ${result.artifacts.project_profile}`);
  console.log(`- workflow: ${result.artifacts.workflow}`);
  console.log(`- task sources: ${result.artifacts.task_sources}`);
  console.log(`- primary type: ${result.profile.primary_type}`);
  console.log(`- frameworks: ${result.profile.frameworks.join(", ") || "none"}`);
  console.log(`- languages: ${result.profile.languages.join(", ") || "none"}`);
}

async function runIntake(args = []) {
  const workspaceRoot = resolveWorkspaceRoot();
  const plan = createInitPlan(workspaceRoot);

  if (!fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }
  if (args.includes("--auto-run")) {
    throw new Error(
      "intake --auto-run is disabled in Reliability RC; create the task, run approve-plan, then run start-task",
    );
  }

  const operatorPrompt = await resolveIntakePrompt(args);
  const taskId = resolveFlagValue(args, "--task-id") ?? createGeneratedTaskId(operatorPrompt);
  const overrides = {
    phase: parsePhaseFlagValue(args, "--phase") ?? undefined,
    priority: resolveFlagValue(args, "--priority") ?? undefined,
    title: resolveFlagValue(args, "--title") ?? undefined,
  };
  const plannerRuntimePreference = parsePlannerRuntimeFlag(args);
  const executorRuntimePreference = parseExecutorRuntimeFlag(args);
  const planner = await runStructuredPlanner({
    onRuntimeAttempt: async (runtime) => {
      logSelectedRuntime("planner", runtime.runtimeId);
    },
    operatorPrompt,
    preferredRuntime: plannerRuntimePreference,
    workspaceRoot,
  });
  const artifact = taskIntake.createTaskIntakeArtifact({
    now: getSystemNow(),
    operatorPrompt,
    overrides,
    plannerCost: planner.cost,
    plannerMode: planner.planner_mode,
    plannerOutput: planner.output,
    plannerRuntime: planner.runtime_id,
    taskId,
    validRoleIds: collectValidRoleIds(workspaceRoot),
  });
  const routePreview = buildIntakeRoutePreview(artifact, {
    executorRuntime: executorRuntimePreference,
    workspaceRoot,
  });
  const finalizedArtifact = {
    ...artifact,
    route_preview: routePreview,
  };
  const sqliteStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
  });

  try {
    await storage.seedStorage(sqliteStorage, {
      ingressRecords: [
        taskIntake.createOperatorPromptIngressRecord({
          now: getSystemNow(),
          routeCandidate: routePreview.selected_lane?.lane_id ?? routePreview.selected_lane?.id ?? null,
          taskId,
        }),
      ],
      taskNotes: [
        taskIntake.createOperatorPromptTaskNote({
          now: getSystemNow(),
          operatorPrompt,
          taskId,
        }),
      ],
      tasks: [finalizedArtifact.derived_task],
    });
  } finally {
    sqliteStorage.close();
  }

  const artifactPaths = taskIntake.writeTaskIntakeArtifacts({
    artifact: finalizedArtifact,
    stateRoot: plan.stateRoot,
  });
  await enqueueLifecycleTask({
    databasePath: plan.databasePath,
    metadata: {
      created_by: "cli:intake",
      title: finalizedArtifact.derived_task?.title ?? taskId,
    },
    priority: finalizedArtifact.derived_task?.priority ?? "medium",
    stateRoot: plan.stateRoot,
    taskId,
  });
  const output = {
    artifact_paths: artifactPaths,
    executor_runtime_requested: executorRuntimePreference,
    intake: finalizedArtifact,
    next_command: `niis approve-plan --task-id ${taskId}`,
    planner_attempts: planner.attempts,
    planner_runtime_requested: plannerRuntimePreference,
    route_preview: routePreview,
    task_id: taskId,
  };

  console.log(JSON.stringify(output, null, 2));
}

function hasPendingSubtaskBranches({ stateRoot, taskId }) {
  try {
    const progress = readSubtaskProgress({ stateRoot, taskId });
    const entries = progress?.subtasks ?? [];
    return entries.some((entry) =>
      entry.branch?.name
      && entry.branch.had_changes
      && entry.branch.merge_status !== "merged"
      && entry.branch.merge_status !== "discarded");
  } catch {
    return false;
  }
}

function finalizeTaskBranchForTask({
  branchInfo,
  canonicalVerdict = null,
  finalTaskStatus,
  mergePolicyMode,
  stateRoot = null,
  taskId,
  workspaceRoot,
}) {
  if (!branchInfo) return null;
  const { branchName, baseBranch, previousBranch } = branchInfo;
  const succeeded = canonicalVerdict === "PASS";
  const effectiveMergePolicyMode =
    mergePolicyMode === "auto_merge"
      ? "review"
      : mergePolicyMode;
  const result = {
    base_branch: baseBranch,
    branch_name: branchName,
    final_status: null,
    merge_result: null,
    pr_result: null,
  };
  if (succeeded) {
    const commit = taskBranch.commitPendingChanges({ taskId, workspaceRoot });
    result.committed = commit.committed === true;
    result.had_changes = commit.hadChanges !== false;
  } else {
    result.committed = false;
    result.had_changes = false;
  }
  if (!succeeded) {
    const restore = taskBranch.switchToBranch({ branchName: previousBranch ?? baseBranch, workspaceRoot });
    if (!restore.ok) {
      process.stderr.write(`[niis] Warning: failed to switch back to ${previousBranch ?? baseBranch}: ${restore.message}\n`);
    }
    result.final_status = "retained_for_inspection";
    return result;
  }
  if (effectiveMergePolicyMode === "create_pr" && result.had_changes) {
    const push = spawnSync("git", ["push", "-u", "origin", branchName], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    if (push.status !== 0) {
      result.pr_result = {
        error: (push.stderr || push.stdout || "git push failed").trim(),
        status: "push_failed",
      };
    } else {
      const pr = openSubtaskPullRequest({
        branch: { name: branchName },
        subtask: { id: taskId, role_id: null },
        taskId,
        workspaceRoot,
      });
      result.pr_result = pr.ok
        ? { status: "pr_created", url: pr.url }
        : { error: pr.error, status: "pr_failed" };
    }



    if (stateRoot) {
      try {
        writeTaskBranchInfo({
          info: {
            base_branch: baseBranch,
            branch_name: branchName,
            had_changes: result.had_changes === true,
            pr_url: result.pr_result?.url ?? null,
            push_failed_reason: result.pr_result?.status === "push_failed" ? result.pr_result.error : null,
          },
          stateRoot,
          taskId,
        });
      } catch {  }
    }
    const restore = taskBranch.switchToBranch({ branchName: previousBranch ?? baseBranch, workspaceRoot });
    if (!restore.ok) {
      process.stderr.write(`[niis] Warning: failed to switch back to ${previousBranch ?? baseBranch}: ${restore.message}\n`);
    }
    result.final_status = "pushed_for_pr";
    return result;
  }
  const restore = taskBranch.switchToBranch({ branchName: previousBranch ?? baseBranch, workspaceRoot });
  if (!restore.ok) {
    process.stderr.write(`[niis] Warning: failed to switch back to ${previousBranch ?? baseBranch}: ${restore.message}\n`);
  }
  if (!result.had_changes) {
    taskBranch.deleteTaskBranch({ branchName, workspaceRoot });
    result.final_status = "empty_branch_deleted";
    return result;
  }
  if (stateRoot) {
    try {
      writeTaskBranchInfo({
        info: {
          base_branch: baseBranch,
          branch_name: branchName,
          had_changes: true,
          pr_url: null,
        },
        stateRoot,
        taskId,
      });
    } catch {

    }
  }
  result.final_status = "retained_for_review";
  return result;
}

function promoteParallelSubtaskBranchesAfterPass({
  canonicalVerdict,
  mergePolicyMode,
  parallelDispatch,
  stateRoot,
  taskId,
  workspaceRoot,
}) {
  const records = Array.isArray(parallelDispatch?.subtaskBranches)
    ? parallelDispatch.subtaskBranches
    : [];
  const effectiveMergePolicyMode =
    mergePolicyMode === "auto_merge"
      ? "review"
      : mergePolicyMode;

  if (canonicalVerdict !== "PASS") {
    return Object.freeze({
      attempted: false,
      ok: true,
      reason: "canonical_verdict_not_pass",
      results: Object.freeze([]),
    });
  }

  const results = [];
  for (const record of records) {
    if (!record.had_changes) {
      results.push({
        branch_name: record.branch_name,
        status: "no_changes",
        subtask_id: record.subtask_id,
      });
      continue;
    }

    const commit = subtaskWorktree.commitSubtaskChanges({
      subtaskId: record.subtask_id,
      worktreePath: record.worktree_path,
    });
    if (!commit.committed) {
      results.push({
        branch_name: record.branch_name,
        error: commit.error ?? "failed to create review commit",
        status: "commit_failed",
        subtask_id: record.subtask_id,
      });
      continue;
    }

    let promotion = {
      branch_name: record.branch_name,
      status: "retained_for_review",
      subtask_id: record.subtask_id,
    };
    if (effectiveMergePolicyMode === "create_pr") {
      const push = spawnSync("git", ["push", "-u", "origin", record.branch_name], {
        cwd: workspaceRoot,
        encoding: "utf8",
      });
      if (push.status !== 0) {
        promotion = {
          ...promotion,
          error: (push.stderr || push.stdout || "git push failed").trim(),
          status: "push_failed",
        };
      } else {
        const pr = openSubtaskPullRequest({
          branch: {
            name: record.branch_name,
            worktree_path: record.worktree_path,
          },
          subtask: {
            id: record.subtask_id,
            role_id: null,
          },
          taskId,
          workspaceRoot,
        });
        promotion = pr.ok
          ? {
            ...promotion,
            pr_url: pr.url,
            status: "pr_created",
          }
          : {
            ...promotion,
            error: pr.error,
            status: "pr_failed",
          };
      }
    }
    results.push(promotion);

    if (stateRoot) {
      updateSubtaskProgress({
        branch: {
          had_changes: true,
          merge_status:
            promotion.status === "pr_created"
              ? "pr_opened"
              : promotion.status,
          name: record.branch_name,
          pr_url: promotion.pr_url ?? null,
          source_branch: parallelDispatch.sourceBranch ?? null,
          worktree_path: record.worktree_path,
        },
        stateRoot,
        status: "DONE",
        subtaskId: record.subtask_id,
        taskId,
      });
    }
  }

  return Object.freeze({
    attempted: records.length > 0,
    ok: results.every((result) =>
      ["no_changes", "retained_for_review", "pr_created"].includes(result.status)),
    results: Object.freeze(results),
  });
}

function finalizeQueueStateForTask({ stateRoot, taskId, finalTaskStatus, verdictClass }) {
  try {
    const existing = taskQueue.findTaskState({ stateRoot, taskId });
    if (!existing) return;
    const isBlockedOrFailed = finalTaskStatus === "BLOCKED"
      || finalTaskStatus === "FAILED"
      || verdictClass === "REJECTED"
      || verdictClass === "DEFECT"
      || verdictClass === "ENV_BLOCK";
    const pendingBranches = hasPendingSubtaskBranches({ stateRoot, taskId });
    let target = "accepted";
    if (isBlockedOrFailed) target = "rejected";
    else if (pendingBranches || finalTaskStatus === "IN_REVIEW") target = "in_review";
    taskQueue.transitionTask({
      patch: {
        final_task_status: finalTaskStatus ?? null,
        final_verdict_class: verdictClass ?? null,
        finished_at: new Date().toISOString(),
        pid: null,
      },
      stateRoot,
      taskId,
      toState: target,
    });
  } catch (error) {
    process.stderr.write(`[niis] Warning: failed to finalize queue state for ${taskId}: ${error.message}\n`);
  }
}

const TRUSTED_READ_ENFORCEMENT_BACKENDS = new Set([
  "darwin-seatbelt-read-contained",
  "darwin-seatbelt-workspace-write-contained",
  "linux-bubblewrap-read-contained",
  "linux-bubblewrap-workspace-write-contained",
]);
const TRUSTED_WRITE_ENFORCEMENT_BACKENDS = new Set([
  "codex-app-server-turn-workspace-write",
  "darwin-seatbelt-workspace-write-contained",
  "linux-bubblewrap-workspace-write-contained",
]);
const TRUSTED_NETWORK_ENFORCEMENT_BACKENDS = new Set([
  "claude-tool-allowlist",
  "codex-app-server-turn-sandbox",
]);

function hasTrustedRuntimeEnforcementEvidence(evidence) {
  return evidence?.read_enforced === true
    && evidence?.write_enforced === true
    && evidence?.network_enforced === true
    && TRUSTED_READ_ENFORCEMENT_BACKENDS.has(evidence?.read_backend)
    && TRUSTED_WRITE_ENFORCEMENT_BACKENDS.has(evidence?.write_backend)
    && TRUSTED_NETWORK_ENFORCEMENT_BACKENDS.has(evidence?.network_backend);
}















async function runAgentTickTask({ task, plan, workspaceRoot = resolveWorkspaceRoot() }) {
  const sqliteStorage = storage.createSqliteStorage({ databasePath: plan.databasePath });
  const taskId = task.id;
  const startedAt = new Date().toISOString();

  if (!task.assigned_to || typeof task.assigned_to !== "string") {
    throw new Error(`agent_tick task ${taskId} has no assigned_to`);
  }

  const transitionInProgress = (current, ts) => schemas.task.parseTaskRecord({
    ...current,
    status: "IN_PROGRESS",
    updated_at: ts,
    transition_log: [
      ...(current.transition_log ?? []),
      { timestamp: ts, from_status: current.status, to_status: "IN_PROGRESS",
        actor: "start-task:agent_tick_dispatch", reason: "dispatching generic agent_tick to mcp_server agent" },
    ],
  });

  const transitionFinal = (current, ts, finalStatus, reason) => schemas.task.parseTaskRecord({
    ...current,
    status: finalStatus,
    updated_at: ts,
    transition_log: [
      ...(current.transition_log ?? []),
      { timestamp: ts, from_status: "IN_PROGRESS", to_status: finalStatus,
        actor: "start-task:agent_tick_dispatch", reason },
    ],
  });

  let dispatched = null;
  try {
    dispatched = await sqliteStorage.tasks.upsert(transitionInProgress(task, startedAt));

    const agentRecord = await sqliteStorage.agents.byId(task.assigned_to);
    if (!agentRecord) {
      throw new Error(`agent ${task.assigned_to} not found in storage`);
    }
    if (!isRoleEnabledForWorkspace(task.assigned_to, workspaceRoot)) {
      throw new Error(`agent ${task.assigned_to} is disabled in project settings; enable it or pause/delete the parent collection task`);
    }
    if (agentRecord.adapter_type !== "mcp_server") {
      throw new Error(
        `agent_tick expects an mcp_server agent; ${task.assigned_to} has adapter_type=${agentRecord.adapter_type}`,
      );
    }






    const staticManifest = await loadPackageAgentStaticManifest(task.assigned_to);
    const tickContract = contextContract.normalizeContextContract(
      staticManifest?.context_contract ?? null,
      { roleId: task.assigned_to },
    );
    const configuredToolName = typeof task.tool_call?.name === "string" && task.tool_call.name.trim() !== ""
      ? task.tool_call.name.trim()
      : agentRecord.config?.default_tool_name;
    const toolCall = {
      name: configuredToolName ?? "run",
      arguments: task.tool_call?.arguments && typeof task.tool_call.arguments === "object"
        ? task.tool_call.arguments
        : {},
    };
    contextContract.assertAgentTickWithinContextContract({
      contract: tickContract,
      roleId: task.assigned_to,
      task,
      toolCall,
    });
    const tickContractDigestNote = contextContract.createContextContractDigestNote(
      contextContract.createContextContractDigest(tickContract),
    );

    const secretStore = storage.createLocalSecretStore({ stateRoot: plan.stateRoot, createIfMissing: false });





    const resolvedEnv = {};
    for (const binding of agentRecord.env_bindings ?? []) {
      if (!binding?.key) continue;
      if (binding.type === "plain") {
        resolvedEnv[binding.key] = String(binding.value ?? "");
      } else if (binding.type === "secret_ref") {
        try {
          const value = secretStore.getSecret(binding.value);
          if (value !== undefined && value !== null && value !== "") {
            resolvedEnv[binding.key] = String(value);
          }
        } catch {

        }
      }
    }

    const mcpAdapter = createMcpServerAdapter({
      id: `mcp-server:${agentRecord.id}`,
      command: agentRecord.config?.command,
      args: agentRecord.config?.args ?? [],
      cwd: agentRecord.config?.cwd ?? undefined,
      env: resolvedEnv,
      defaultToolName: agentRecord.config?.default_tool_name ?? null,
      messageFraming: agentRecord.config?.message_framing ?? "content_length",
    });

    const adapterResult = await mcpAdapter.execute({ tool_call: toolCall });

    const finishedAt = new Date().toISOString();
    const succeeded = adapterResult.status === "SUCCESS";
    const finalStatus = succeeded ? "DONE" : "REJECTED";
    const reason = succeeded
      ? `tick completed; summary: ${String(adapterResult.summary ?? "").slice(0, 200)}`
      : `tick failed: ${String(adapterResult.summary ?? adapterResult.error?.root_cause ?? "unknown").slice(0, 200)}`;

    await sqliteStorage.tasks.upsert(transitionFinal(dispatched, finishedAt, finalStatus, reason));

    return {
      task_id: taskId,
      task_kind: "agent_tick",
      context_contract: { digest_note: tickContractDigestNote },
      final_status: finalStatus,
      final_task: {
        id: taskId,
        status: finalStatus,
      },
      final_verdict: {
        verdict_class: succeeded ? "PASS" : "DEFECT",
      },
      mcp_result: {
        status: adapterResult.status,
        summary: adapterResult.summary,
        artifacts: adapterResult.artifacts ?? [],
      },
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();




    if (error?.code === "context_contract_violation") {
      const reason = error.message.slice(0, 300);
      try {
        await sqliteStorage.tasks.upsert(transitionFinal(dispatched ?? task, finishedAt, "BLOCKED", reason));
        await sqliteStorage.blockers.upsert({
          blocker_class: "SECURITY_FINDING",
          created_at: finishedAt,
          id: `${taskId}:context-contract:${Date.now()}`,
          next_action: "Fix the package agent's context_contract (or the tick's tool_call) and rerun the collection tick.",
          reason: error.message,
          resolved_at: null,
          task_id: taskId,
        });
      } catch (writeError) {
        process.stderr.write(`[niis] Failed to record context-contract blocker for ${taskId}: ${writeError.message}\n`);
      }
      return {
        task_id: taskId,
        task_kind: "agent_tick",
        final_status: "BLOCKED",
        final_task: {
          id: taskId,
          status: "BLOCKED",
        },
        final_verdict: {
          verdict_class: "ENV_BLOCK",
          reason,
        },
        error: {
          code: error.code,
          message: error.message,
        },
      };
    }
    const reason = `dispatch failed: ${(error?.message ?? String(error)).slice(0, 300)}`;
    try {
      await sqliteStorage.tasks.upsert(transitionFinal(dispatched ?? task, finishedAt, "REJECTED", reason));
    } catch (writeError) {
      process.stderr.write(`[niis] Failed to mark task ${taskId} as REJECTED after dispatch error: ${writeError.message}\n`);
    }
    return {
      task_id: taskId,
      task_kind: "agent_tick",
      final_status: "REJECTED",
      final_task: {
        id: taskId,
        status: "REJECTED",
      },
      final_verdict: {
        verdict_class: "DEFECT",
        reason,
      },
      error: {
        message: error?.message ?? String(error),
      },
    };
  } finally {
    sqliteStorage.close?.();
  }
}

function throwIfTaskExecutionAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("task execution was cancelled");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  error.retrySafe = false;
  throw error;
}

async function startTaskFromArtifact({
  abortSignal = null,
  artifact,
  attemptId = null,
  deferPromotion = true,
  executorRuntime = null,
  networkPolicy = {},
  sandboxPolicy = {},
  stateRoot,
  timeoutMs = null,
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  throwIfTaskExecutionAborted(abortSignal);
  const databasePath = storage.createSqliteDatabasePath(stateRoot);
  const taskRunSessionId = createTaskRunSessionId(artifact.task_id);





  const leaseInheritedHolder = process.env.NIIS_LEASE_HOLDER ?? null;
  const leaseHolder = leaseInheritedHolder ?? `cli:${process.pid}`;
  let leaseAcquiredHere = false;
  let leaseRenewTimer = null;
  if (!leaseInheritedHolder) {
    const lease = tryAcquireTaskLease({ holder: leaseHolder, stateRoot, taskId: artifact.task_id });
    if (!lease.ok) {
      const conflict = lease.conflict
        ? ` (held by ${lease.conflict.holder}, pid ${lease.conflict.pid}, expires ${lease.conflict.expires_at})`
        : "";
      throw new Error(`Failed to acquire task lease for ${artifact.task_id}${conflict}`);
    }
    leaseAcquiredHere = true;
    leaseRenewTimer = setInterval(() => {
      renewTaskLease({ holder: leaseHolder, stateRoot, taskId: artifact.task_id });
    }, TASK_LEASE_RENEW_INTERVAL_MS);
  }






  const intakeValidation = artifact.acceptance_validation ?? { issues: [], ok: true };
  if (!intakeValidation.ok) {
    const strictConfig = getIntakeValidationConfig({ workspaceRoot });
    if (strictConfig.strict) {
      const issueLines = (intakeValidation.issues ?? [])
        .map((issue) => `- ${issue.field}: ${issue.message}`)
        .join("\n");
      const blockerStorage = storage.createSqliteStorage({ databasePath });
      try {
        const now = getSystemNow();
        const tasksPreblock = await blockerStorage.tasks.list();
        const preblockTask = tasksPreblock.find((task) => task.id === artifact.task_id) ?? artifact.derived_task;
        const blockedTask = taskIntake.transitionTaskStatus(preblockTask, {
          actor: "cli:start-task",
          now,
          reason: "Intake validation failed (pre-dispatch gate).",
          status: "BLOCKED",
        });
        await blockerStorage.tasks.upsert(blockedTask);
        await storage.seedStorage(blockerStorage, {
          blockers: [{
            blocker_class: "MISSING_APPROVAL",
            created_at: getSystemTimestamp(),
            id: `${artifact.task_id}:intake-validation:${getSystemTimeMs()}`,
            next_action: "Edit the task's acceptance criteria / out-of-scope and re-run start-task.",
            reason: `Intake validation failed:\n${issueLines}`,
            resolved_at: null,
            task_id: artifact.task_id,
          }],
        });
      } finally {
        blockerStorage.close();
      }
      if (leaseAcquiredHere) {
        if (leaseRenewTimer) clearInterval(leaseRenewTimer);
        releaseTaskLease({ holder: leaseHolder, stateRoot, taskId: artifact.task_id });
      }
      return {
        blocker_class: "MISSING_APPROVAL",
        final_task: { id: artifact.task_id, status: "BLOCKED" },
        intake_validation: intakeValidation,
      };
    }
  }
  const sqliteStorage = storage.createSqliteStorage({
    databasePath,
  });
  const tasks = await sqliteStorage.tasks.list();
  const persistedTask = tasks.find((task) => task.id === artifact.task_id) ?? artifact.derived_task;
  const inProgressTask = taskIntake.transitionTaskStatus(persistedTask, {
    actor: "cli:start-task",
    now: new Date(),
    reason: "Operator started execution from the CLI intake surface.",
    status: "IN_PROGRESS",
  });
  await sqliteStorage.tasks.upsert(inProgressTask);
  sqliteStorage.close();
  if (!deferPromotion) {
    try {
      const currentQueue = taskQueue.findTaskState({ stateRoot, taskId: artifact.task_id });
      if (currentQueue) {
        taskQueue.transitionTask({
          patch: { pid: process.pid, started_at: new Date().toISOString() },
          stateRoot,
          taskId: artifact.task_id,
          toState: "in_progress",
        });
      } else {
        taskQueue.enqueueTask({
          metadata: {
            created_by: "cli:start-task",
            pid: process.pid,
            priority: inProgressTask.priority ?? "medium",
            started_at: new Date().toISOString(),
            title: inProgressTask.title ?? artifact.task_id,
          },
          state: "in_progress",
          stateRoot,
          taskId: artifact.task_id,
        });
      }
    } catch (error) {
      process.stderr.write(`[niis] Warning: failed to transition queue to in_progress for ${artifact.task_id}: ${error.message}\n`);
    }
  }
  await updateTaskExecutionProgress({
    active: true,
    databasePath,
    sessionId: taskRunSessionId,
    stage: "preparing",
    stateRoot,
    summary: "Task status moved to IN_PROGRESS and execution is starting.",
    taskId: artifact.task_id,
    taskStatus: "IN_PROGRESS",
  });

  const configuredGlobalMergePolicy = getMergePolicy({ workspaceRoot });
  const globalMergePolicy = enforceReliabilityRcMergePolicy(configuredGlobalMergePolicy);
  if (configuredGlobalMergePolicy.mode === "auto_merge") {
    process.stderr.write(
      "[niis] Reliability RC disables auto_merge; canonical PASS will retain a review branch instead.\n",
    );
  }
  let taskBranchInfo = null;
  if (globalMergePolicy.branch_per_task) {
    try {
      if (!subtaskWorktree.isWorkspaceClean({ workspaceRoot })) {
        if (globalMergePolicy.mode === "auto_merge") {
          throw new Error("Workspace has uncommitted changes; commit or stash before running with branch_per_task + auto_merge.");
        }
        process.stderr.write(`[niis] Warning: workspace has uncommitted changes. branch_per_task will carry them into the task branch—commit them yourself first if that is not what you want.\n`);
      }
      taskBranchInfo = taskBranch.createTaskBranch({
        baseBranch: taskBranch.resolveBaseBranch({ workspaceRoot, explicit: globalMergePolicy.base_branch }),
        taskId: artifact.task_id,
        workspaceRoot,
      });
      process.stderr.write(`[niis] branch_per_task: created ${taskBranchInfo.branchName} from ${taskBranchInfo.baseBranch}.\n`);
    } catch (error) {
      process.stderr.write(`[niis] branch_per_task disabled for this run: ${error.message}\n`);
      taskBranchInfo = null;
    }
  }

  const availableAdapters = createAvailableExecutorAdapters({
    preferredRuntime: executorRuntime,
    workspaceRoot,
  }).map((runtimeAdapter) => ({
    ...runtimeAdapter,
    execute: (context = {}) => runtimeAdapter.execute({
      ...context,
      abortSignal,
      abort_signal: abortSignal,
      attemptId,
      attempt_id: attemptId,
      networkPolicy,
      network_policy: networkPolicy,
      sandboxPolicy,
      sandbox_policy: sandboxPolicy,
      timeoutMs,
      timeout_ms: timeoutMs,
      workspacePath: workspaceRoot,
      workspace_path: workspaceRoot,
    }),
  }));

  if (availableAdapters.length === 0) {
    const blockedTask = taskIntake.transitionTaskStatus(inProgressTask, {
      actor: "cli:start-task",
      now: getSystemNow(),
      reason: executorRuntime
        ? `Requested executor runtime ${executorRuntime} is not available. Install or authenticate it and retry.`
        : "No supported local runtime is available for execution.",
      status: "BLOCKED",
    });
    const blockedStorage = storage.createSqliteStorage({
      databasePath,
    });

    try {
      await updateTaskExecutionProgress({
        active: false,
        databasePath,
        sessionId: taskRunSessionId,
        stage: "blocked",
        stateRoot,
        summary: "No supported local runtime is available for execution.",
        taskId: artifact.task_id,
        taskStatus: "BLOCKED",
        verdictClass: "ENV_BLOCK",
      });
      await storage.seedStorage(blockedStorage, {
        blockers: [{
          blocker_class: "ENV_BLOCK",
          created_at: getSystemTimestamp(),
          id: `${artifact.task_id}:start-task:blocker:${getSystemTimeMs()}`,
          next_action: "Install or authenticate codex_local or claude_code_local and retry `start-task`.",
          reason: "No supported local runtime is available for CLI intake execution.",
          resolved_at: null,
          task_id: artifact.task_id,
        }],
        tasks: [blockedTask],
      });
      const report = taskIntake.buildTaskReport({
        now: getSystemNow(),
        snapshot: blockedStorage.snapshot(),
        taskId: artifact.task_id,
      });
      const reportPaths = writeIntakeReportArtifacts({
        report,
        stateRoot,
        taskId: artifact.task_id,
      });

      finalizeTaskBranchForTask({
        branchInfo: taskBranchInfo,
        finalTaskStatus: "BLOCKED",
        mergePolicyMode: globalMergePolicy.mode,
        stateRoot,
        taskId: artifact.task_id,
        workspaceRoot,
      });
      if (!deferPromotion) {
        finalizeQueueStateForTask({
          finalTaskStatus: "BLOCKED",
          stateRoot,
          taskId: artifact.task_id,
          verdictClass: "ENV_BLOCK",
        });
      }
      return {
        artifact_paths: reportPaths,
        final_task: blockedTask,
        final_verdict: {
          verdict_class: "ENV_BLOCK",
        },
        report,
        route_preview: artifact.route_preview,
        task_id: artifact.task_id,
      };
    } finally {
      blockedStorage.close();
    }
  }







  const blockTaskForContextContractViolation = async (error) => {
    const blockedTask = taskIntake.transitionTaskStatus(inProgressTask, {
      actor: "cli:start-task",
      now: getSystemNow(),
      reason: error.message,
      status: "BLOCKED",
    });
    const blockedStorage = storage.createSqliteStorage({ databasePath });
    try {
      await storage.seedStorage(blockedStorage, {
        blockers: [{
          blocker_class: "SECURITY_FINDING",
          created_at: getSystemTimestamp(),
          id: `${artifact.task_id}:context-contract:${getSystemTimeMs()}`,
          next_action: "Extend the role's context_contract allow-list or remove the out-of-contract context source, then rerun start-task.",
          reason: error.message,
          resolved_at: null,
          task_id: artifact.task_id,
        }],
        tasks: [blockedTask],
      });
    } finally {
      blockedStorage.close();
    }
    await markTaskExecutionProgressFailure({
      databasePath,
      error,
      sessionId: taskRunSessionId,
      stateRoot,
      taskId: artifact.task_id,
    });
    finalizeTaskBranchForTask({
      branchInfo: taskBranchInfo,
      finalTaskStatus: "BLOCKED",
      mergePolicyMode: globalMergePolicy.mode,
      stateRoot,
      taskId: artifact.task_id,
      workspaceRoot,
    });
    if (!deferPromotion) {
      finalizeQueueStateForTask({
        finalTaskStatus: "BLOCKED",
        stateRoot,
        taskId: artifact.task_id,
        verdictClass: "ENV_BLOCK",
      });
    }
    return {
      artifact_paths: {},
      final_task: blockedTask,
      final_verdict: { verdict_class: "ENV_BLOCK" },
      report: null,
      route_preview: artifact.route_preview,
      task_id: artifact.task_id,
    };
  };

  let routePlan;
  try {
    routePlan = routing.buildRoutePlan({
      adapters: availableAdapters,
      referenceBundle: taskIntake.buildExecutionReferenceBundle(artifact),
      roleManifests: buildIntakeRoleManifests(availableAdapters),
      routingPolicy: {},
      subtasks: artifact.subtasks ?? [],
      task: inProgressTask,
    });
  } catch (error) {
    if (error.code === "context_contract_violation") {
      return blockTaskForContextContractViolation(error);
    }
    throw error;
  }
  const selectedRoleId = routePlan.selected_lane?.manifest_id ?? null;
  const projectRoleManifest = selectedRoleId
    ? (loadRoleById(selectedRoleId, { workspaceRoot }) ?? null)
    : null;
  const roleBudget = projectRoleManifest?.budget ?? null;
  const monthBucket = currentMonthBucket(getSystemNow());
  let roleMonthlySpendBefore = null;
  if (roleBudget?.monthly_usd) {
    const spendStorage = storage.createSqliteStorage({ databasePath, readonly: true });
    let currentSpend = 0;
    try {
      currentSpend = await spendStorage.roleMonthlySpend.getSpend(selectedRoleId, monthBucket);
    } finally {
      spendStorage.close();
    }
    roleMonthlySpendBefore = currentSpend;
    const guard = createRoleBudgetGuard({
      currentSpend,
      monthlyCap: roleBudget.monthly_usd,
      roleId: selectedRoleId,
    });
    if (!guard.canDispatch(0)) {
      const blockedTask = taskIntake.transitionTaskStatus(inProgressTask, {
        actor: "cli:start-task",
        now: getSystemNow(),
        reason: `Role ${selectedRoleId} monthly budget exhausted ($${currentSpend.toFixed(4)} / $${roleBudget.monthly_usd}).`,
        status: "BLOCKED",
      });
      const budgetStorage = storage.createSqliteStorage({ databasePath });
      try {
        await storage.seedStorage(budgetStorage, {
          blockers: [{
            blocker_class: "ENV_BLOCK",
            created_at: getSystemTimestamp(),
            id: `${artifact.task_id}:role-budget:${getSystemTimeMs()}`,
            next_action: "Increase role monthly budget in /project settings or wait for the next billing cycle.",
            reason: `Role ${selectedRoleId} monthly budget exhausted ($${currentSpend.toFixed(4)} / $${roleBudget.monthly_usd}).`,
            resolved_at: null,
            task_id: artifact.task_id,
          }],
          tasks: [blockedTask],
        });
      } finally {
        budgetStorage.close();
      }
      await markTaskExecutionProgressFailure({
        databasePath,
        error: new Error(`Role ${selectedRoleId} monthly budget exhausted.`),
        sessionId: taskRunSessionId,
        stateRoot,
        taskId: artifact.task_id,
      });
      finalizeTaskBranchForTask({
        branchInfo: taskBranchInfo,
        finalTaskStatus: "BLOCKED",
        mergePolicyMode: globalMergePolicy.mode,
        stateRoot,
        taskId: artifact.task_id,
        workspaceRoot,
      });
      if (!deferPromotion) {
        finalizeQueueStateForTask({
          finalTaskStatus: "BLOCKED",
          stateRoot,
          taskId: artifact.task_id,
          verdictClass: "ENV_BLOCK",
        });
      }
      return {
        artifact_paths: {},
        final_task: blockedTask,
        final_verdict: { verdict_class: "ENV_BLOCK" },
        report: null,
        route_preview: artifact.route_preview,
        task_id: artifact.task_id,
      };
    }
  }
  await updateTaskExecutionProgress({
    active: true,
    adapterId: routePlan.selected_adapter?.id ?? null,
    databasePath,
    laneId: routePlan.selected_lane?.lane_id ?? "generalist",
    sessionId: taskRunSessionId,
    stage: "routing",
    stateRoot,
    summary: `Selected lane ${routePlan.selected_lane?.lane_id ?? "generalist"} with adapter ${routePlan.selected_adapter?.id ?? "unknown"}.`,
    taskId: artifact.task_id,
    taskStatus: "IN_PROGRESS",
  });
  logSelectedRuntime("execution", routePlan.selected_adapter?.id ?? null);
  const assignment = createIntakeAssignment({
    now: getSystemNow(),
    routePlan,
    taskId: artifact.task_id,
  });
  await updateTaskExecutionProgress({
    active: true,
    adapterId: routePlan.selected_adapter?.id ?? null,
    databasePath,
    laneId: routePlan.selected_lane?.lane_id ?? "generalist",
    sessionId: taskRunSessionId,
    stage: "executing",
    stateRoot,
    summary: `Agent execution is running via ${routePlan.selected_adapter?.id ?? "unknown"}.`,
    taskId: artifact.task_id,
    taskStatus: "IN_PROGRESS",
  });
  const docRefs = projectRoleManifest?.doc_refs ?? [];
  const docRefLoad = loadDocRefs(workspaceRoot, docRefs);
  const canonicalHardGateFailures = [];
  if (docRefLoad.missingRequired.length > 0) {
    console.error(`[niis] Missing required role doc refs: ${docRefLoad.missingRequired.join(", ")}`);
    canonicalHardGateFailures.push({
      blocker_class: "MISSING_EVIDENCE",
      gate_id: "documentation.required_refs",
      next_action: "Restore the required role documentation references and create a new review attempt.",
      reason: `Missing required role documentation references: ${docRefLoad.missingRequired.join(", ")}.`,
      verdict_class: "ENV_BLOCK",
    });
  }
  const baseReferenceBundle = taskIntake.buildExecutionReferenceBundle(artifact);
  const enrichedReferenceBundle = enrichReferenceBundleWithDocRefs(baseReferenceBundle, docRefLoad.entries);
  const baseRunId = `${artifact.task_id}:run:${getSystemTimeMs()}`;
  let parallelDispatch;
  try {
    parallelDispatch = deferPromotion
      ? null
      : await runParallelSubtaskDispatch({
      artifact,
      availableAdapters,
      baseRunId,
      databasePath,
      inProgressTask,
      networkPolicy,
      sandboxPolicy,
      stateRoot,
      taskBranchActive: Boolean(taskBranchInfo),
      workspaceRoot,
    });
  } catch (error) {
    if (error.code === "dirty_workspace") {
      const blockedTask = taskIntake.transitionTaskStatus(inProgressTask, {
        actor: "cli:start-task",
        now: getSystemNow(),
        reason: error.message,
        status: "BLOCKED",
      });
      const blockedStorage = storage.createSqliteStorage({ databasePath });
      try {
        await storage.seedStorage(blockedStorage, {
          blockers: [{
            blocker_class: "DEPENDENCY_UNMET",
            created_at: getSystemTimestamp(),
            id: `${artifact.task_id}:dirty-workspace:${getSystemTimeMs()}`,
            next_action: "Commit or stash the working tree changes, then rerun start-task.",
            reason: error.message,
            resolved_at: null,
            task_id: artifact.task_id,
          }],
          tasks: [blockedTask],
        });
      } finally {
        blockedStorage.close();
      }
      await markTaskExecutionProgressFailure({
        databasePath,
        error,
        sessionId: taskRunSessionId,
        stateRoot,
        taskId: artifact.task_id,
      });
      finalizeTaskBranchForTask({
        branchInfo: taskBranchInfo,
        finalTaskStatus: "BLOCKED",
        mergePolicyMode: globalMergePolicy.mode,
        stateRoot,
        taskId: artifact.task_id,
        workspaceRoot,
      });
      if (!deferPromotion) {
        finalizeQueueStateForTask({
          finalTaskStatus: "BLOCKED",
          stateRoot,
          taskId: artifact.task_id,
          verdictClass: "ENV_BLOCK",
        });
      }
      return {
        artifact_paths: {},
        final_task: blockedTask,
        final_verdict: { verdict_class: "ENV_BLOCK" },
        report: null,
        route_preview: artifact.route_preview,
        task_id: artifact.task_id,
      };
    }
    if (error.code === "context_contract_violation") {
      return blockTaskForContextContractViolation(error);
    }
    throw error;
  }
  let execution;
  try {
    execution = parallelDispatch?.execution ?? await routing.runTaskExecution({
      adapters: availableAdapters,
      agentId: "cli-agent",
      bootstrapContext: {
        workspace: {
          branch_name: null,
          sandbox_mode: sandboxPolicy.mode ?? "workspace-write",
          workspace_path: workspaceRoot,
        },
      },
      referenceBundle: enrichedReferenceBundle,
      roleManifests: buildIntakeRoleManifests(availableAdapters),
      routingPolicy: {},
      runId: baseRunId,
      subtasks: artifact.subtasks ?? [],
      task: inProgressTask,
    });
  } catch (error) {
    if (error.code === "context_contract_violation") {
      return blockTaskForContextContractViolation(error);
    }
    throw error;
  }
  throwIfTaskExecutionAborted(abortSignal);
  if (parallelDispatch) {
    process.stderr.write(`Parallel dispatch ran ${parallelDispatch.perSubtaskResults.length} subtask(s) in role-aware batches.\n`);
  }
  if (parallelDispatch?.blockers?.length > 0) {
    const conflictBlockers = parallelDispatch.blockers;
    const conflictReason = conflictBlockers
      .map((b) => `${b.subtask_id}: ${(b.files ?? []).join(", ") || "merge failed"}`)
      .join(" | ");
    const blockedTask = taskIntake.transitionTaskStatus(inProgressTask, {
      actor: "cli:start-task",
      now: getSystemNow(),
      reason: `Merge conflict on parallel subtask(s); worktrees preserved. ${conflictReason}`,
      status: "BLOCKED",
    });
    const blockedStorage = storage.createSqliteStorage({ databasePath });
    try {
      await storage.seedStorage(blockedStorage, {
        blockers: conflictBlockers.map((b, idx) => ({
          blocker_class: b.blocker_class,
          created_at: getSystemTimestamp(),
          id: `${artifact.task_id}:merge-conflict:${idx}:${getSystemTimeMs()}`,
          next_action: `Resolve merge conflict in ${(b.files ?? []).join(", ")} or inspect worktree at ${b.worktree_path}`,
          reason: `Subtask ${b.subtask_id} produced merge conflict on files: ${(b.files ?? []).join(", ") || "(unknown)"}`,
          resolved_at: null,
          task_id: artifact.task_id,
        })),
        tasks: [blockedTask],
      });
    } finally {
      blockedStorage.close();
    }
    await markTaskExecutionProgressFailure({
      databasePath,
      error: new Error(`Merge conflict on parallel dispatch: ${conflictReason}`),
      sessionId: taskRunSessionId,
      stateRoot,
      taskId: artifact.task_id,
    });
    if (!deferPromotion) {
      finalizeQueueStateForTask({
        finalTaskStatus: "BLOCKED",
        stateRoot,
        taskId: artifact.task_id,
        verdictClass: "ENV_BLOCK",
      });
    }
    return {
      artifact_paths: {},
      final_task: blockedTask,
      final_verdict: { verdict_class: "ENV_BLOCK" },
      report: null,
      route_preview: artifact.route_preview,
      task_id: artifact.task_id,
    };
  }
  const executionSecurityEvidence = (parallelDispatch
    ? parallelDispatch.perSubtaskResults.map((entry) => entry.execution)
    : [execution]
  ).map((entry) =>
    entry?.execution?.turns?.at(-1)?.raw_result?._raw_runtime_output?.security_evidence,
  );
  if (
    executionSecurityEvidence.length === 0
    || executionSecurityEvidence.some((evidence) =>
      !hasTrustedRuntimeEnforcementEvidence(evidence))
  ) {
    canonicalHardGateFailures.push({
      blocker_class: "MISSING_EVIDENCE",
      gate_id: "security.runtime_enforcement",
      next_action: "Use a dedicated executor that emits trusted filesystem and network enforcement evidence.",
      reason: "Execution lacks trusted read containment, write containment, or agent-tool network-policy evidence.",
      verdict_class: "EVIDENCE_GAP",
    });
  }




  const contextContractEvidenceItems = parallelDispatch
    ? (parallelDispatch.perSubtaskResults ?? [])
      .map((entry) => entry.contextContractEvidence)
      .filter(Boolean)
    : [
      buildContextContractEvidenceItem({
        contract: execution.route_plan?.delegation_payload?.context_contract ?? null,
        roleId: execution.run_record?.role_id ?? selectedRoleId ?? null,
        subtaskId: artifact.task_id,
      }),
    ].filter(Boolean);
  await updateTaskExecutionProgress({
    active: true,
    adapterId: routePlan.selected_adapter?.id ?? null,
    databasePath,
    laneId: routePlan.selected_lane?.lane_id ?? "generalist",
    runId: execution.run_record.id,
    sessionId: taskRunSessionId,
    stage: "reviewing",
    stateRoot,
    summary: execution.final_response?.summary ?? "Execution finished; validator lane is reviewing evidence.",
    taskId: artifact.task_id,
    taskStatus: "IN_PROGRESS",
  });
  await appendTaskCardLiveRecords({
    databasePath,
    taskLiveExcerpts: execution.final_response?.summary
      ? [createTaskLiveExcerptRecord({
        channel: "summary",
        content: execution.final_response.summary,
        id: `${taskRunSessionId}:agent-summary:${getSystemTimeMs()}`,
        level: "info",
        metadata: {
          adapter_id: routePlan.selected_adapter?.id ?? null,
        },
        runId: execution.run_record.id,
        source: routePlan.selected_adapter?.id ?? "cli-agent",
        taskId: artifact.task_id,
        timestamp: getSystemTimestamp(),
      })]
      : [],
  });
  const storedRunLog = storage.createStoredRunLogRecord({
    inlineBytes: 1,
    rawOutput: execution.execution.turns.at(-1)?.raw_result?._raw_runtime_output
      ?? execution.execution.turns.at(-1)?.raw_result
      ?? execution.final_response,
    runId: execution.run_record.id,
    stateRoot,
  });
  const persistedRunRecord = {
    ...execution.run_record,
    run_log: storedRunLog.run_log,
  };
  const rawRunCostUsd = persistedRunRecord.cost?.estimated_usd;
  const hasRunCostEvidence =
    typeof rawRunCostUsd === "number"
    && Number.isFinite(rawRunCostUsd)
    && rawRunCostUsd >= 0;
  const runCostUsd = hasRunCostEvidence ? rawRunCostUsd : 0;
  const perRunCapUsd = Number(roleBudget?.per_run_usd ?? 0);
  const monthlyCapUsd = Number(roleBudget?.monthly_usd ?? 0);
  if (
    !hasRunCostEvidence
    && (
      (Number.isFinite(perRunCapUsd) && perRunCapUsd > 0)
      || (Number.isFinite(monthlyCapUsd) && monthlyCapUsd > 0)
    )
  ) {
    canonicalHardGateFailures.push({
      blocker_class: "MISSING_EVIDENCE",
      gate_id: "budget.run_cost_evidence",
      next_action: "Use an executor that reports a finite non-negative run cost, then create a new attempt.",
      reason: "The configured budget cannot be evaluated because run cost evidence is missing.",
      verdict_class: "EVIDENCE_GAP",
    });
  }
  if (selectedRoleId && hasRunCostEvidence && runCostUsd > 0) {
    const accStorage = storage.createSqliteStorage({ databasePath });
    try {
      await accStorage.roleMonthlySpend.accumulate(selectedRoleId, monthBucket, runCostUsd, getSystemNow());
    } finally {
      accStorage.close();
    }
  }
  if (
    hasRunCostEvidence
    && Number.isFinite(monthlyCapUsd)
    && monthlyCapUsd > 0
    && Number.isFinite(roleMonthlySpendBefore)
    && roleMonthlySpendBefore + runCostUsd >= monthlyCapUsd
  ) {
    canonicalHardGateFailures.push({
      blocker_class: "ENV_BLOCK",
      gate_id: "budget.monthly",
      next_action: `Increase the monthly budget for role ${selectedRoleId} or wait for the next budget window.`,
      reason:
        `Run would raise monthly spend to $${(roleMonthlySpendBefore + runCostUsd).toFixed(4)} `
        + `against a $${monthlyCapUsd.toFixed(4)} cap.`,
      verdict_class: "ENV_BLOCK",
    });
  }
  if (hasRunCostEvidence && perRunCapUsd > 0) {
    const guard = createRunCostGuard({ capUsd: perRunCapUsd });
    guard.accumulate(runCostUsd);
    if (guard.shouldAbort()) {
      canonicalHardGateFailures.push({
        blocker_class: "ENV_BLOCK",
        gate_id: "budget.per_run",
        next_action: `Increase per_run_usd cap for role ${selectedRoleId} or split the task into smaller subtasks.`,
        reason: `Run exceeded per_run_usd cap ($${runCostUsd.toFixed(4)} >= $${perRunCapUsd}).`,
        verdict_class: "ENV_BLOCK",
      });
      const blockerStorage = storage.createSqliteStorage({ databasePath });
      try {
        await storage.seedStorage(blockerStorage, {
          blockers: [{
            blocker_class: "ENV_BLOCK",
            created_at: getSystemTimestamp(),
            id: `${artifact.task_id}:per-run-cap:${getSystemTimeMs()}`,
            next_action: `Increase per_run_usd cap for role ${selectedRoleId} or split the task into smaller subtasks.`,
            reason: `Run exceeded per_run_usd cap ($${runCostUsd.toFixed(4)} >= $${perRunCapUsd}).`,
            resolved_at: null,
            task_id: artifact.task_id,
          }],
        });
      } finally {
        blockerStorage.close();
      }
    }
  }
  const qualityGates = projectRoleManifest?.quality_gates ?? [];
  throwIfTaskExecutionAborted(abortSignal);
  let qualityGateReport = null;
  if (
    !deferPromotion
    && !parallelDispatch
    && Array.isArray(qualityGates)
    && qualityGates.length > 0
  ) {
    qualityGateReport = runQualityGates({ gates: qualityGates, workspaceRoot });
    if (qualityGateReport.hard_failures.length > 0) {
      const failedIds = qualityGateReport.hard_failures.map((entry) => entry.gate_id).join(", ");
      const gateBlockerStorage = storage.createSqliteStorage({ databasePath });
      try {
        await storage.seedStorage(gateBlockerStorage, {
          blockers: [{
            blocker_class: "ENV_BLOCK",
            created_at: getSystemTimestamp(),
            id: `${artifact.task_id}:quality-gate:${getSystemTimeMs()}`,
            next_action: `Fix the failing gates (${failedIds}) and rerun start-task.`,
            reason: `Hard quality gate failure(s): ${failedIds}.`,
            resolved_at: null,
            task_id: artifact.task_id,
          }],
        });
      } finally {
        gateBlockerStorage.close();
      }
    }
  }
  const singleAcceptanceCommandEvidence = createAcceptanceCommandEvidence({
    gateReport: qualityGateReport,
    runId: persistedRunRecord.id,
    stateRoot,
  });
  const reviewSpec = {
    executorAdapterId: persistedRunRecord?.adapter_id ?? null,
    runLogStateRoot: stateRoot,
    workspaceRoot,
  };
  let review;
  if (deferPromotion) {
    review = {
      blocker: null,
      completion_gate: null,
      events: [],
      explainability: [],
      final_verdict: {
        reason: "Legacy validator lane is non-canonical in Reliability RC; durable gates and fresh review run next.",
        verdict_class: null,
      },
      non_canonical: true,
      results: [],
    };
  } else if (parallelDispatch && Array.isArray(parallelDispatch.perSubtaskResults) && parallelDispatch.perSubtaskResults.length > 0) {



    const subtaskBranchById = new Map(
      (parallelDispatch.subtaskBranches ?? []).map((entry) => [entry.subtask_id, entry]),
    );
    const sourceBranch = parallelDispatch.sourceBranch ?? null;
    const perSubtaskReviews = await Promise.all(parallelDispatch.perSubtaskResults.map(async ({
      acceptanceCommandEvidence,
      contextContractEvidence,
      execution: subExec,
      subtask,
    }) => {
      const subtaskTask = { ...inProgressTask, id: subtask.id, title: subtask.title ?? inProgressTask.title };
      const branchEntry = subtaskBranchById.get(subtask.id) ?? null;
      const diffEvidence = collectSubtaskDiffEvidence({
        branchName: branchEntry?.branch_name ?? null,
        sourceBranch,
        subtaskId: subtask.id,
        workspaceRoot,
        worktreePath: branchEntry?.worktree_path ?? null,
      });





      const securityScanSurfaces = diffEvidence.rawDiff
        ? policy.codeChangesToSurfaces(diffEvidence.rawDiff)
        : [];
      const reviewTargetItems = branchEntry?.branch_name && sourceBranch
        ? [{
          content: JSON.stringify({
            branch_name: branchEntry.branch_name,
            source_branch: sourceBranch,
            worktree_path: branchEntry.worktree_path ?? null,
          }),
          raw_output_ref: null,
          source: `review-target:${subtask.id}`,
          subtask_id: subtask.id,
          type: "review_target",
        }]
        : [];
      const subtaskSummaryItems = subExec.final_response?.summary
        ? [{
          content: subExec.final_response.summary,
          raw_output_ref: subExec.run_record?.run_log?.ref ?? null,
          source: `subtask:${subtask.id}`,
          subtask_id: subtask.id,
          type: "subtask_summary",
        }]
        : [];
      const seedItems = [
        ...subtaskSummaryItems,
        ...diffEvidence.items,
        ...reviewTargetItems,
        ...(acceptanceCommandEvidence?.evidence_items ?? []),
        ...(contextContractEvidence ? [contextContractEvidence] : []),
      ];
      const seedEvidencePacket = seedItems.length > 0
        ? {
          authenticity_status: "UNVERIFIED",
          items: seedItems,
          markers: {
            auth_surfaces_attempted: [],
            browser_live_checks: [],
            checked_urls: [],
            runtime_evidence_succeeded: false,
          },
        }
        : null;
      const subReview = await policy.runValidatorLane({
        actorRole: "validator",
        evidencePacket: seedEvidencePacket,
        evidenceRuntime: createReviewEvidenceRuntime(reviewSpec),
        executorAgentId: subExec.run_record?.agent_id ?? "cli-agent",
        observedOutcome: createStartTaskObservedOutcome(subExec, {
          acceptanceCommandResults: acceptanceCommandEvidence?.command_results ?? [],
          hardGateFailures: canonicalHardGateFailures,
          requiredAcceptanceCommandIds:
            acceptanceCommandEvidence?.required_command_ids ?? [],
          securityScanSurfaces,
          securitySurfaceType: "code_review",
        }),
        policy: {},
        reviewerAgentId: "cli:start-task-review",
        runRecord: subExec.run_record,
        task: subtaskTask,
        validators: createDefaultValidators(),
      });
      return { subReview, subtaskId: subtask.id };
    }));
    const verdictsForAggregation = perSubtaskReviews.map(({ subReview, subtaskId }) => ({
      ...subReview.final_verdict,
      subtask_id: subtaskId,
    }));
    const aggregated = aggregateVerdicts(verdictsForAggregation);
    review = {
      blocker: perSubtaskReviews.find(({ subReview }) => subReview.blocker)?.subReview.blocker ?? null,
      completion_gate: perSubtaskReviews[0]?.subReview.completion_gate ?? null,
      events: perSubtaskReviews.flatMap(({ subReview }) => subReview.events ?? []),
      explainability: perSubtaskReviews.flatMap(({ subReview }) => subReview.explainability ?? []),
      final_verdict: aggregated,
      per_subtask_verdicts: verdictsForAggregation,
      results: perSubtaskReviews.flatMap(({ subReview }) => subReview.results ?? []),
    };
  } else {
    let deterministicDiffBase = taskBranchInfo?.baseBranch ?? "HEAD";
    if (deferPromotion && attemptId) {
      const attemptPaths = attemptWorktree.createAttemptWorktreePaths({
        attemptId,
        stateRoot,
        taskId: artifact.task_id,
      });
      const attemptSidecar = attemptWorktree.readAttemptWorktreeSidecar(
        attemptPaths.sidecar_path,
      );
      if (!attemptSidecar) {
        throw new Error(
          `attempt worktree sidecar is missing during deterministic review: ${attemptPaths.sidecar_path}`,
        );
      }
      deterministicDiffBase = attemptSidecar.base_commit;
    }
    const singleDiffEvidence = collectSubtaskDiffEvidence({
      branchName: taskBranchInfo?.branchName ?? "HEAD",
      sourceBranch: deterministicDiffBase,
      subtaskId: artifact.task_id,
      workspaceRoot,
      worktreePath: workspaceRoot,
    });
    const singleSecurityScanSurfaces = singleDiffEvidence.rawDiff
      ? policy.codeChangesToSurfaces(singleDiffEvidence.rawDiff)
      : [];
    const singleReviewTargetItems = taskBranchInfo?.branchName && taskBranchInfo?.baseBranch
      ? [{
        content: JSON.stringify({
          branch_name: taskBranchInfo.branchName,
          source_branch: taskBranchInfo.baseBranch,
          worktree_path: workspaceRoot,
        }),
        raw_output_ref: null,
        source: `review-target:${artifact.task_id}`,
        subtask_id: artifact.task_id,
        type: "review_target",
      }]
      : [];
    const singleSummaryItems = execution.final_response?.summary
      ? [{
        content: execution.final_response.summary,
        raw_output_ref: persistedRunRecord.run_log?.ref ?? null,
        source: `task:${artifact.task_id}`,
        subtask_id: artifact.task_id,
        type: "subtask_summary",
      }]
      : [];
    const singleSeedItems = [
      ...singleSummaryItems,
      ...singleDiffEvidence.items,
      ...singleReviewTargetItems,
      ...singleAcceptanceCommandEvidence.evidence_items,
      ...contextContractEvidenceItems,
    ];
    review = await policy.runValidatorLane({
      actorRole: "validator",
      evidencePacket: singleSeedItems.length > 0
        ? {
          authenticity_status: "UNVERIFIED",
          items: singleSeedItems,
          markers: {
            auth_surfaces_attempted: [],
            browser_live_checks: [],
            checked_urls: [],
            runtime_evidence_succeeded: false,
          },
        }
        : null,
      evidenceRuntime: createReviewEvidenceRuntime(reviewSpec),
      executorAgentId: persistedRunRecord.agent_id,
      observedOutcome: createStartTaskObservedOutcome(execution, {
        acceptanceCommandResults: singleAcceptanceCommandEvidence.command_results,
        hardGateFailures: canonicalHardGateFailures,
        requiredAcceptanceCommandIds: singleAcceptanceCommandEvidence.required_command_ids,
        securityScanSurfaces: singleSecurityScanSurfaces,
        securitySurfaceType: "code_review",
      }),
      policy: {},
      reviewerAgentId: "cli:start-task-review",
      runRecord: persistedRunRecord,
      task: inProgressTask,
      validators: createDefaultValidators(),
    });
  }
  const parallelPromotion = deferPromotion
    ? Object.freeze({
        attempted: false,
        ok: true,
        reason: "deferred_to_durable_lifecycle",
        results: Object.freeze([]),
      })
    : promoteParallelSubtaskBranchesAfterPass({
        canonicalVerdict: review.final_verdict?.verdict_class ?? null,
        mergePolicyMode: globalMergePolicy.mode,
        parallelDispatch,
        stateRoot,
        taskId: artifact.task_id,
        workspaceRoot,
      });
  const promotionBlocked =
    review.final_verdict?.verdict_class === "PASS"
    && parallelPromotion.attempted
    && !parallelPromotion.ok;
  const parallelReviewPending = parallelPromotion.results.some((result) =>
    result.status !== "no_changes");
  const singleReviewPending =
    !parallelDispatch
    && Boolean(taskBranchInfo)
    && inspectWorktreeChanges(workspaceRoot).had_changes;
  const humanReviewPending =
    !deferPromotion
    &&
    review.final_verdict?.verdict_class === "PASS"
    && (parallelReviewPending || singleReviewPending);
  const mappedFinalStatus = deferPromotion
    ? "IN_PROGRESS"
    : taskIntake.mapVerdictClassToTaskStatus(
        review.final_verdict.verdict_class,
      );
  const finalTask = taskIntake.transitionTaskStatus(inProgressTask, {
    actor: "cli:start-task",
    now: getSystemNow(),
    reason: deferPromotion
      ? "Execution was captured; durable gates and fresh review remain pending."
      : promotionBlocked
      ? "Validator lane returned PASS, but branch promotion failed; task remains in review."
      : humanReviewPending
        ? "Validator lane returned PASS; a reviewable branch or pull request awaits human merge."
      : `Validator lane returned ${review.final_verdict.verdict_class}.`,
    status: deferPromotion
      ? "IN_PROGRESS"
      : promotionBlocked || humanReviewPending
        ? "IN_REVIEW"
        : mappedFinalStatus,
  });
  let autoRepairReport = null;
  const persistedArtifacts = await persistReviewArtifacts({
    persistedArtifacts: {
      assignments: [assignment],
      events: execution.runtime_events,
      explainability: [execution.explainability],
      ingressRecords: [],
      runLogs: [
        storedRunLog,
        ...singleAcceptanceCommandEvidence.stored_run_logs,
        ...(parallelDispatch?.perSubtaskResults ?? [])
          .flatMap((entry) => entry.acceptanceCommandEvidence?.stored_run_logs ?? []),
      ],
    },
    runLogStateRoot: stateRoot,
    runRecord: persistedRunRecord,
    task: finalTask,
  }, review);


  if (!deferPromotion && finalTask.status === "REJECTED") {
    autoRepairReport = {
      ok: false,
      reason: "disabled_outside_durable_lifecycle",
    };
  }
  const reportStorage = storage.createSqliteStorage({
    databasePath,
    readonly: true,
  });

  try {
    const report = taskIntake.buildTaskReport({
      now: getSystemNow(),
      snapshot: reportStorage.snapshot(),
      taskId: artifact.task_id,
    });
    const reportPaths = writeIntakeReportArtifacts({
      report,
      stateRoot,
      taskId: artifact.task_id,
    });

    const taskBranchOutcome = finalizeTaskBranchForTask({
      branchInfo: taskBranchInfo,
      canonicalVerdict: review.final_verdict?.verdict_class ?? null,
      finalTaskStatus: finalTask.status ?? null,
      mergePolicyMode: globalMergePolicy.mode,
      stateRoot,
      taskId: artifact.task_id,
      workspaceRoot,
    });
    if (!deferPromotion) {
      finalizeQueueStateForTask({
        finalTaskStatus: finalTask.status ?? null,
        stateRoot,
        taskId: artifact.task_id,
        verdictClass: review.final_verdict?.verdict_class ?? null,
      });
    }
    if (taskBranchOutcome) {
      process.stderr.write(`[niis] task branch ${taskBranchOutcome.branch_name}: ${taskBranchOutcome.final_status}\n`);
    }

    return {
      artifact_paths: reportPaths,
      assignment,
      auto_repair: autoRepairReport,
      completion_gate: review.completion_gate,
      final_task: finalTask,
      final_verdict: review.final_verdict,
      parallel_promotion: parallelPromotion,
      persisted_artifacts: persistedArtifacts,
      promotion_plan: {
        deferred: deferPromotion,
        target: deferPromotion ? "attempt_worktree_branch" : null,
      },
      report,
      route_preview: sanitizeRoutePlan(routePlan),
      role_quality_gates: qualityGates,
      run_record: persistedRunRecord,
      canonical_hard_gate_failures: canonicalHardGateFailures,
      context_contract_evidence: contextContractEvidenceItems,
      task_id: artifact.task_id,
    };
  } finally {
    await updateTaskExecutionProgress({
      active: false,
      adapterId: routePlan.selected_adapter?.id ?? null,
      databasePath,
      laneId: routePlan.selected_lane?.lane_id ?? "generalist",
      runId: persistedRunRecord.id,
      sessionId: taskRunSessionId,
      stage: "completed",
      stateRoot,
      summary: `Task finished with ${finalTask.status} and verdict ${review.final_verdict.verdict_class}.`,
      taskId: artifact.task_id,
      taskStatus: finalTask.status,
      verdictClass: review.final_verdict.verdict_class,
    });
    reportStorage.close();



    if (leaseAcquiredHere) {
      if (leaseRenewTimer) clearInterval(leaseRenewTimer);
      releaseTaskLease({ holder: leaseHolder, stateRoot, taskId: artifact.task_id });
    }
  }
}

async function runDeleteTask(args = []) {
  const workspaceRoot = resolveWorkspaceRoot();
  const taskId = resolveFlagValue(args, "--task-id");
  if (!taskId) {
    throw new Error("usage: niis delete-task --task-id <id> [--force]");
  }
  const force = args.includes("--force");
  const report = await deleteTaskEverywhere({ force, taskId, workspaceRoot });
  console.log(JSON.stringify(report, null, 2));
}

async function ensureTaskIntakeArtifact({
  taskId,
  workspaceRoot,
  stateRoot,
  databasePath,
  plannerRuntime = null,
  executorRuntime = null,
}) {
  try {
    return taskIntake.readTaskIntakeArtifact({ stateRoot, taskId });
  } catch (error) {
    const intakeMissing = error instanceof taskIntake.TaskIntakeError
      || /intake artifact is missing/.test(error?.message ?? "");
    if (!intakeMissing) throw error;
  }
  const sqliteStorage = storage.createSqliteStorage({ databasePath, readonly: true });
  let persistedTask = null;
  try {
    const tasks = await sqliteStorage.tasks.list();
    persistedTask = tasks.find((task) => task.id === taskId) ?? null;
  } finally {
    sqliteStorage.close();
  }
  if (!persistedTask) {
    throw new Error(`intake artifact missing and task ${taskId} not found in SQLite; cannot synthesize a plan`);
  }
  const operatorPrompt = (persistedTask.operator_brief_markdown ?? persistedTask.title ?? "").trim();
  if (!operatorPrompt) {
    throw new Error(`task ${taskId} has no operator_brief_markdown; cannot synthesize an intake artifact`);
  }



  let resolvedPlannerRuntime = plannerRuntime;
  let resolvedExecutorRuntime = executorRuntime;
  if (resolvedPlannerRuntime === null || resolvedExecutorRuntime === null) {
    const prefs = taskIntake.readRuntimePreferences({ stateRoot, taskId });
    if (resolvedPlannerRuntime === null && prefs.planner_runtime) {
      resolvedPlannerRuntime = prefs.planner_runtime;
    }
    if (resolvedExecutorRuntime === null && prefs.executor_runtime) {
      resolvedExecutorRuntime = prefs.executor_runtime;
    }
  }
  process.stderr.write(`[niis] Synthesizing missing intake artifact for ${taskId} via planner (planner=${resolvedPlannerRuntime ?? "auto"}, executor=${resolvedExecutorRuntime ?? "auto"}).\n`);
  const derived = await deriveUiIntakeArtifact({
    executorRuntime: resolvedExecutorRuntime,
    plannerRuntime: resolvedPlannerRuntime,
    priority: persistedTask.priority ?? null,
    prompt: operatorPrompt,
    taskId,
    title: persistedTask.title ?? null,
    workspaceRoot,
  });
  taskIntake.writeTaskIntakeArtifacts({
    artifact: derived.artifact,
    stateRoot,
  });
  return derived.artifact;
}

const LIFECYCLE_QUEUE_PRIORITY = Object.freeze({
  urgent: 0,
  high: 10,
  medium: 20,
  low: 30,
});

function normalizeLifecycleQueuePriority(priority) {
  if (Number.isInteger(priority)) return priority;
  return LIFECYCLE_QUEUE_PRIORITY[String(priority ?? "medium").toLowerCase()]
    ?? LIFECYCLE_QUEUE_PRIORITY.medium;
}

function copyAttemptConfigTree(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) return;
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`refusing to materialize symlinked attempt config: ${sourcePath}`);
  }
  if (sourceStat.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      copyAttemptConfigTree(
        path.join(sourcePath, entry.name),
        path.join(destinationPath, entry.name),
      );
    }
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`refusing to materialize non-file attempt config: ${sourcePath}`);
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourcePath, destinationPath);
  fs.chmodSync(destinationPath, 0o600);
}

function materializeAttemptRuntimeConfig({
  attemptWorkspacePath,
  canonicalStateRoot,
}) {
  const destinationStateRoot = path.join(attemptWorkspacePath, ".niis");
  fs.mkdirSync(destinationStateRoot, { recursive: true, mode: 0o700 });
  for (const relativePath of ["project-config.json", "roles"]) {
    copyAttemptConfigTree(
      path.join(canonicalStateRoot, relativePath),
      path.join(destinationStateRoot, relativePath),
    );
  }
  return {
    copied_surfaces: ["project-config.json", "roles"],
    destination_state_root: destinationStateRoot,
  };
}

function computePrimaryCheckoutDigest(workspaceRoot) {
  return attemptWorktree.capturePrimaryCheckoutReadinessDigest(workspaceRoot);
}

function resolveLifecycleSelfHostScope(repositoryRoot) {
  const normalizedRepositoryRoot = fs.realpathSync.native(
    path.resolve(repositoryRoot),
  );
  const installedPackageRoot = fs.realpathSync.native(
    path.resolve(__dirname, "../../.."),
  );
  const relative = path.relative(
    normalizedRepositoryRoot,
    installedPackageRoot,
  );
  if (
    relative.startsWith("..")
    || path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative === ""
    ? "."
    : relative.split(path.sep).join("/");
}

function computeProtectedStateDigest(stateRoot) {
  const root = path.resolve(stateRoot);
  const targets = [
    "backup-policy.json",
    "install-state.json",
    "project-config.json",
    "roles",
    "secrets",
  ];
  const entries = [];
  const visit = (absolutePath, relativePath) => {
    if (!fs.existsSync(absolutePath)) {
      entries.push({ path: relativePath, type: "missing" });
      return;
    }
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      entries.push({
        path: relativePath,
        target: fs.readlinkSync(absolutePath),
        type: "symlink",
      });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: relativePath, type: "directory" });
      for (const name of fs.readdirSync(absolutePath).sort()) {
        visit(
          path.join(absolutePath, name),
          path.posix.join(relativePath, name),
        );
      }
      return;
    }
    if (!stat.isFile()) {
      entries.push({ path: relativePath, type: "other" });
      return;
    }
    entries.push({
      mode: stat.mode & 0o777,
      path: relativePath,
      sha256: createHash("sha256")
        .update(fs.readFileSync(absolutePath))
        .digest("hex"),
      type: "file",
    });
  };
  for (const relativePath of targets) {
    visit(path.join(root, relativePath), relativePath);
  }
  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
}

async function resolveLifecycleBudgetReadinessEvidence({
  databasePath,
  taskResult,
  workspacePath,
}) {
  const rawUsed = taskResult?.run_record?.cost?.estimated_usd;
  if (rawUsed === null || rawUsed === undefined || rawUsed === "") return null;
  const used = Number(rawUsed);
  if (!Number.isFinite(used) || used < 0) return null;
  const roleId =
    taskResult?.route_preview?.selected_lane?.manifest_id
    ?? taskResult?.run_record?.role_id
    ?? null;
  if (!roleId) return null;
  const role = loadRoleById(roleId, { workspaceRoot: workspacePath });
  const perRunLimit = Number(role?.budget?.per_run_usd);
  if (Number.isFinite(perRunLimit) && perRunLimit > 0) {
    return {
      limit: perRunLimit,
      used,
    };
  }
  const monthlyLimit = Number(role?.budget?.monthly_usd);
  if (!Number.isFinite(monthlyLimit) || monthlyLimit <= 0) return null;
  const sqliteStorage = storage.createSqliteStorage({
    databasePath,
    readonly: true,
  });
  try {
    const monthlyUsed = await sqliteStorage.roleMonthlySpend.getSpend(
      roleId,
      currentMonthBucket(getSystemNow()),
    );
    if (!Number.isFinite(monthlyUsed) || monthlyUsed < 0) return null;
    return {
      limit: monthlyLimit,
      used: monthlyUsed,
    };
  } finally {
    sqliteStorage.close();
  }
}

async function enqueueLifecycleTask({
  databasePath,
  metadata = {},
  priority = "medium",
  stateRoot,
  taskId,
}) {
  const lifecycleStore = storage.createLifecycleSqliteStore({ databasePath });
  try {
    const current = await lifecycleStore.queue.byTask(taskId);
    let entry = current;
    if (!current) {
      entry = await lifecycleStore.queue.enqueue({
        payload: metadata,
        priority: normalizeLifecycleQueuePriority(priority),
        taskId,
      });
    } else if (["BLOCKED", "FAILED", "CANCELLED", "COMPLETED"].includes(current.state)) {
      entry = await lifecycleStore.queue.transition({
        expectedState: current.state,
        nextState: "PENDING",
        payloadPatch: {
          ...metadata,
          attempt_id: null,
          attempt_engine_version: null,
          attempt_trigger: null,
          auto_repair: null,
          cancel_request: null,
        },
        taskId,
      });
    }
    await reconcileFileQueueProjection({
      applyPending: true,
      stateRoot,
      store: lifecycleStore,
    });
    return entry;
  } finally {
    lifecycleStore.close();
  }
}

const LIFECYCLE_QUEUE_CLAIM_TTL_MS = 120_000;
const LIFECYCLE_QUEUE_HEARTBEAT_MS = 30_000;

function lifecycleQueueClaimError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isActiveLifecycleQueueClaim(entry, now = new Date()) {
  return entry?.state === "CLAIMED"
    && typeof entry.claim_expires_at === "string"
    && Date.parse(entry.claim_expires_at) > now.getTime();
}

async function releaseDisplacedLifecycleClaims({
  claims,
  holder,
  store,
}) {
  for (const entry of claims) {
    const current = await store.queue.byTask(entry.task_id);
    if (current?.state !== "CLAIMED" || current.claimed_by !== holder) continue;
    await store.queue.transition({
      expectedState: "CLAIMED",
      holder,
      nextState: "PENDING",
      taskId: entry.task_id,
    });
  }
}






async function claimSpecificLifecycleTask({
  holder,
  store,
  taskId,
  ttlMs = LIFECYCLE_QUEUE_CLAIM_TTL_MS,
}) {
  const current = await store.queue.byTask(taskId);
  if (!current) {
    throw lifecycleQueueClaimError(
      `task ${taskId} is not present in the authoritative lifecycle queue`,
      "lifecycle_queue_entry_missing",
    );
  }
  const cancellationRequest = parseLifecycleCancellationRequest(current);
  if (cancellationRequest?.status === "REQUESTED") {
    throw lifecycleQueueClaimError(
      `task ${taskId} has durable cancellation request ${cancellationRequest.request_id}`,
      "lifecycle_cancellation_pending",
      {
        attempt_id: cancellationRequest.attempt_id,
        cancel_request_id: cancellationRequest.request_id,
      },
    );
  }
  if (current.state === "CLAIMED" && current.claimed_by === holder) {
    return {
      displaced: [],
      entry: current,
      resumed: true,
    };
  }
  const now = new Date();
  if (current.state === "CLAIMED" && isActiveLifecycleQueueClaim(current, now)) {
    throw lifecycleQueueClaimError(
      `project execution is busy with ${current.task_id}`,
      "project_execution_busy",
      { claimed_task_id: current.task_id },
    );
  }
  if (!["PENDING", "CLAIMED"].includes(current.state)) {
    throw lifecycleQueueClaimError(
      `task ${taskId} cannot start while its durable queue state is ${current.state}`,
      "lifecycle_queue_task_not_pending",
      { queue_state: current.state },
    );
  }

  const foreignActiveClaims = (await store.queue.list()).filter((entry) =>
    entry.claimed_by !== holder && isActiveLifecycleQueueClaim(entry, now));
  if (foreignActiveClaims.length > 0) {
    throw lifecycleQueueClaimError(
      `project execution is busy with ${foreignActiveClaims[0].task_id}`,
      "project_execution_busy",
      { claimed_task_id: foreignActiveClaims[0].task_id },
    );
  }

  const displaced = [];
  try {
    while (true) {
      const claimed = await store.queue.claimNext({
        holder,
        ttlMs,
      });
      if (!claimed) {
        throw lifecycleQueueClaimError(
          `task ${taskId} is not currently claimable from the authoritative queue`,
          "lifecycle_queue_task_not_claimable",
        );
      }
      if (claimed.task_id === taskId) {
        await releaseDisplacedLifecycleClaims({
          claims: displaced,
          holder,
          store,
        });
        return {
          displaced: displaced.map((entry) => entry.task_id),
          entry: claimed,
          resumed: false,
        };
      }
      displaced.push(claimed);
    }
  } catch (error) {
    await releaseDisplacedLifecycleClaims({
      claims: displaced,
      holder,
      store,
    });
    throw error;
  }
}

async function failOwnedLifecycleQueueClaim({
  error,
  holder,
  stateRoot,
  store,
  taskId,
}) {
  const current = await store.queue.byTask(taskId);
  if (current?.state !== "CLAIMED" || current.claimed_by !== holder) {
    return current;
  }
  const failed = await store.queue.transition({
    expectedState: "CLAIMED",
    holder,
    nextState: "FAILED",
    payloadPatch: {
      failure_reason: error instanceof Error ? error.message : String(error),
    },
    taskId,
  });
  await reconcileFileQueueProjection({
    applyPending: true,
    stateRoot,
    store,
  });
  return failed;
}

const TERMINAL_LIFECYCLE_ATTEMPT_STAGES = new Set([
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "FINISHED",
]);

async function settleOwnedLifecycleQueueClaimAfterError({
  attemptId = null,
  error,
  holder,
  stateRoot,
  store,
  taskId,
}) {
  const currentQueue = await store.queue.byTask(taskId);
  const cancellationRequest = currentQueue
    ? parseLifecycleCancellationRequest(currentQueue)
    : null;
  const queueAttemptId =
    typeof currentQueue?.payload?.attempt_id === "string"
    && currentQueue.payload.attempt_id.trim() !== ""
      ? currentQueue.payload.attempt_id.trim()
      : null;
  const persistedAttempt = queueAttemptId
    ? await store.attempts.byId(queueAttemptId)
    : attemptId
      ? await store.attempts.byId(attemptId)
      : await store.attempts.activeByTask(taskId);
  const ownsClaim =
    currentQueue?.state === "CLAIMED"
    && currentQueue.claimed_by === holder;
  const errorMessage = error instanceof Error ? error.message : String(error);

  if (cancellationRequest) {
    return Object.freeze({
      attempt: persistedAttempt,
      cancellationRequest,
      kind: "CANCELLATION_REQUESTED",
      lifecycleResult: persistedAttempt
        ? {
            attempt_id: persistedAttempt.id,
            canonical_verdict: persistedAttempt.canonical_verdict,
            stage: persistedAttempt.stage,
            state: persistedAttempt.state,
          }
        : null,
      queue: currentQueue,
    });
  }

  if (
    persistedAttempt
    && !TERMINAL_LIFECYCLE_ATTEMPT_STAGES.has(persistedAttempt.stage)
  ) {
    const queue = ownsClaim
      ? await store.queue.transition({
          expectedState: "CLAIMED",
          holder,
          nextState: "PENDING",
          payloadPatch: {
            attempt_id: persistedAttempt.id,
            last_retryable_error: errorMessage,
            resume_required: true,
          },
          taskId,
        })
      : currentQueue;
    if (ownsClaim) {
      await reconcileFileQueueProjection({
        applyPending: true,
        stateRoot,
        store,
      });
    }
    return Object.freeze({
      attempt: persistedAttempt,
      kind: "RESUMABLE",
      lifecycleResult: {
        attempt_id: persistedAttempt.id,
        canonical_verdict: persistedAttempt.canonical_verdict,
        stage: persistedAttempt.stage,
        state: persistedAttempt.state,
      },
      queue,
    });
  }

  if (persistedAttempt) {
    const lifecycleResult = {
      attempt_id: persistedAttempt.id,
      canonical_verdict: persistedAttempt.canonical_verdict,
      stage: persistedAttempt.stage,
      state: persistedAttempt.state,
    };
    const queue = await finalizeLifecycleQueue({
      claimHolder: ownsClaim ? holder : null,
      lifecycleResult,
      store,
      taskId,
    });
    await reconcileFileQueueProjection({
      applyPending: true,
      stateRoot,
      store,
    });
    return Object.freeze({
      attempt: persistedAttempt,
      kind: "TERMINAL",
      lifecycleResult,
      queue,
    });
  }

  const queue = ownsClaim
    ? await failOwnedLifecycleQueueClaim({
        error,
        holder,
        stateRoot,
        store,
        taskId,
      })
    : currentQueue;
  return Object.freeze({
    attempt: null,
    kind: "PRE_ATTEMPT_FAILURE",
    lifecycleResult: {
      attempt_id: attemptId,
      canonical_verdict: null,
      stage: "FAILED",
    },
    queue,
  });
}

function canonicalTaskStatusFromAttempt(lifecycleResult) {
  if (lifecycleResult?.stage === "FINISHED") {
    return lifecycleResult.canonical_verdict === "PASS"
      ? "IN_REVIEW"
      : "BLOCKED";
  }
  if (["BLOCKED", "CANCELLED", "FAILED"].includes(lifecycleResult?.stage)) {
    return "BLOCKED";
  }
  return null;
}

function assertNoDirectUiReviewRerun(actionPlan) {
  if (actionPlan?.rerunReview !== true) return actionPlan;
  throw new UiLifecycleActionError(
    "Direct review reruns are retired; resolve findings by creating a new supervised attempt",
    { code: "direct_review_rerun_retired" },
  );
}

async function synchronizeTaskStatusFromLifecycleResult({
  databasePath,
  lifecycleResult,
  taskId,
}) {
  const nextStatus = canonicalTaskStatusFromAttempt(lifecycleResult);
  if (!nextStatus) return null;
  const sqliteStorage = storage.createSqliteStorage({ databasePath });
  try {
    const current = (await sqliteStorage.tasks.list())
      .find((entry) => entry.id === taskId) ?? null;
    if (!current || current.status === nextStatus) return current;
    const updated = taskIntake.transitionTaskStatus(current, {
      actor: "task-attempt:lifecycle",
      now: getSystemNow(),
      reason:
        `Canonical attempt ${lifecycleResult.attempt_id ?? "unknown"} ended at `
        + `${lifecycleResult.stage} with ${lifecycleResult.canonical_verdict ?? "no verdict"}.`,
      status: nextStatus,
    });
    await sqliteStorage.tasks.upsert(updated);
    return updated;
  } finally {
    sqliteStorage.close();
  }
}

async function reconcileLifecycleCompatibilityStatuses({
  databasePath,
  taskId = null,
}) {
  const lifecycleStore = storage.createLifecycleSqliteStore({
    databasePath,
    readonly: true,
  });
  let attempts;
  let queueEntries;
  try {
    attempts = taskId
      ? await lifecycleStore.attempts.listByTask(taskId)
      : await lifecycleStore.attempts.list();
    queueEntries = taskId
      ? [await lifecycleStore.queue.byTask(taskId)].filter(Boolean)
      : await lifecycleStore.queue.list();
  } finally {
    lifecycleStore.close();
  }
  const latestAttemptByTask = new Map();
  for (const attempt of attempts) {
    latestAttemptByTask.set(attempt.task_id, attempt);
  }
  const queueByTask = new Map(
    queueEntries.map((entry) => [entry.task_id, entry]),
  );
  const sqliteStorage = storage.createSqliteStorage({ databasePath });
  const updated = [];
  try {
    const tasks = await sqliteStorage.tasks.list();
    for (const task of tasks) {
      if (taskId && task.id !== taskId) continue;
      if (task.status === "DONE") continue;
      const attempt = latestAttemptByTask.get(task.id) ?? null;
      const queueEntry = queueByTask.get(task.id) ?? null;
      const pendingAutoRepair =
        queueEntry?.state === "PENDING"
          ? parseAutoRepairEnvelope(queueEntry)
          : null;
      let desiredStatus = null;
      if (pendingAutoRepair) {
        desiredStatus = "PENDING";
      } else if (attempt?.stage === "FINISHED" && attempt.canonical_verdict === "PASS") {
        desiredStatus = "IN_REVIEW";
      } else if (
        attempt
        && ["BLOCKED", "FAILED", "CANCELLED"].includes(attempt.stage)
      ) {
        desiredStatus = "BLOCKED";
      } else if (attempt) {
        desiredStatus = "IN_PROGRESS";
      } else if (queueEntry?.state === "BLOCKED") {
        desiredStatus = "BLOCKED";
      }
      if (!desiredStatus || desiredStatus === task.status) continue;
      const reconciled = taskIntake.transitionTaskStatus(task, {
        actor: "task-attempt:reconciler",
        now: getSystemNow(),
        reason:
          `Reconciled compatible task status from durable lifecycle `
          + `${attempt?.id ?? queueEntry?.task_id ?? task.id}.`,
        status: desiredStatus,
      });
      await sqliteStorage.tasks.upsert(reconciled);
      updated.push({
        from_status: task.status,
        task_id: task.id,
        to_status: desiredStatus,
      });
    }
  } finally {
    sqliteStorage.close();
  }
  return Object.freeze(updated);
}

async function cancelLifecycleTask({
  databasePath,
  reason = "cancelled by operator",
  stateRoot,
  taskId,
  terminatedPid = null,
}) {
  const store = storage.createLifecycleSqliteStore({ databasePath });
  try {
    const normalizedTerminatedPid = terminatedPid === null
      ? null
      : Number(terminatedPid);
    if (
      normalizedTerminatedPid !== null
      && (
        !Number.isInteger(normalizedTerminatedPid)
        || normalizedTerminatedPid <= 0
      )
    ) {
      throw lifecycleQueueClaimError(
        "terminatedPid must be a positive integer",
        "invalid_terminated_process",
      );
    }
    if (
      normalizedTerminatedPid !== null
      && isPidAlive(normalizedTerminatedPid)
    ) {
      throw lifecycleQueueClaimError(
        `refusing cancellation takeover while process ${normalizedTerminatedPid} is still alive`,
        "cancellation_owner_still_alive",
        { terminated_pid: normalizedTerminatedPid },
      );
    }

    let activeAttempt = await store.attempts.activeByTask(taskId);
    let queueEntry = await store.queue.byTask(taskId);
    const cancellationRequest = parseLifecycleCancellationRequest(queueEntry);
    const executionLease = normalizedTerminatedPid === null
      ? null
      : await store.executionLeases.byScope(PROJECT_EXECUTION_LEASE_ID);
    const expectedAttemptHolder = normalizedTerminatedPid === null
      ? null
      : `cli-lifecycle:${normalizedTerminatedPid}`;
    if (
      cancellationRequest
      && normalizedTerminatedPid !== null
      && (
        cancellationRequest.status !== "REQUESTED"
        || cancellationRequest.project_pid !== normalizedTerminatedPid
        || cancellationRequest.project_scope !== PROJECT_EXECUTION_LEASE_ID
      )
    ) {
      throw lifecycleQueueClaimError(
        `cancellation request ${cancellationRequest.request_id} is not bound to process ${normalizedTerminatedPid}`,
        "cancellation_request_owner_mismatch",
        {
          cancel_request_id: cancellationRequest.request_id,
          request_pid: cancellationRequest.project_pid,
          terminated_pid: normalizedTerminatedPid,
        },
      );
    }
    if (
      cancellationRequest?.attempt_id
      && activeAttempt
      && cancellationRequest.attempt_id !== activeAttempt.id
    ) {
      throw lifecycleQueueClaimError(
        `cancellation request ${cancellationRequest.request_id} is bound to a different attempt`,
        "cancellation_request_attempt_mismatch",
        {
          active_attempt_id: activeAttempt.id,
          cancel_request_attempt_id: cancellationRequest.attempt_id,
        },
      );
    }
    const cancellationBoundAttempt =
      cancellationRequest?.attempt_id
        ? await store.attempts.byId(cancellationRequest.attempt_id)
        : null;
    if (
      cancellationBoundAttempt
      && !activeAttempt
      && cancellationBoundAttempt.stage !== "CANCELLED"
    ) {
      throw lifecycleQueueClaimError(
        `cancellation request ${cancellationRequest.request_id} conflicts with terminal attempt stage ${cancellationBoundAttempt.stage}`,
        "cancellation_attempt_terminal_conflict",
        {
          attempt_id: cancellationBoundAttempt.id,
          attempt_stage: cancellationBoundAttempt.stage,
          cancel_request_id: cancellationRequest.request_id,
        },
      );
    }

    let cancelledAttempt = null;
    let cancellationPromotion = null;
    if (activeAttempt) {
      const promotion = await store.promotions.byAttempt(activeAttempt.id);
      if (
        promotion
        && (
          !cancellationRequest
          || promotion.status === "PROMOTED"
        )
      ) {
        throw lifecycleQueueClaimError(
          `attempt ${activeAttempt.id} already entered the irreversible promotion zone`,
          "cancellation_after_promotion_started",
          { attempt_id: activeAttempt.id, promotion_status: promotion.status },
        );
      }
      cancellationPromotion = promotion;

      if (
        normalizedTerminatedPid !== null
        && activeAttempt.lease_holder !== null
        && activeAttempt.lease_holder !== expectedAttemptHolder
      ) {
        throw lifecycleQueueClaimError(
          `attempt ${activeAttempt.id} is owned by a different executor`,
          "cancellation_attempt_owner_mismatch",
          {
            attempt_id: activeAttempt.id,
            lease_holder: activeAttempt.lease_holder,
            terminated_pid: normalizedTerminatedPid,
          },
        );
      }
    }

    const queueIsClaimed = queueEntry?.state === "CLAIMED";
    const deadOwnerTakeoverRequired = normalizedTerminatedPid !== null
      && (
        activeAttempt?.lease_holder === expectedAttemptHolder
        || queueIsClaimed
      );
    const requestProvesDeadOwner =
      cancellationRequest?.status === "REQUESTED"
      && cancellationRequest.project_pid === normalizedTerminatedPid
      && cancellationRequest.project_scope === PROJECT_EXECUTION_LEASE_ID
      && (
        !queueIsClaimed
        || cancellationRequest.project_holder === queueEntry.claimed_by
      );
    if (
      normalizedTerminatedPid !== null
      && executionLease
      && executionLease.pid !== normalizedTerminatedPid
    ) {
      throw lifecycleQueueClaimError(
        `project execution is owned by process ${executionLease.pid}, not the reaped process ${normalizedTerminatedPid}`,
        "cancellation_project_owner_mismatch",
        {
          lease_holder: executionLease.holder,
          lease_pid: executionLease.pid,
          terminated_pid: normalizedTerminatedPid,
        },
      );
    }
    if (
      normalizedTerminatedPid !== null
      && executionLease
      && cancellationRequest
      && (
        executionLease.holder !== cancellationRequest.project_holder
        || executionLease.acquired_at !== cancellationRequest.project_acquired_at
      )
    ) {
      throw lifecycleQueueClaimError(
        "project execution lease no longer matches the durable cancellation request",
        "cancellation_project_owner_mismatch",
        {
          cancel_request_id: cancellationRequest.request_id,
          lease_holder: executionLease.holder,
          lease_acquired_at: executionLease.acquired_at,
          request_holder: cancellationRequest.project_holder,
          request_acquired_at: cancellationRequest.project_acquired_at,
        },
      );
    }
    if (
      deadOwnerTakeoverRequired
      && !executionLease
      && !requestProvesDeadOwner
    ) {
      throw lifecycleQueueClaimError(
        "cannot prove the reaped process owned the active project execution lease",
        "cancellation_project_lease_missing",
        { terminated_pid: normalizedTerminatedPid },
      );
    }
    if (
      normalizedTerminatedPid !== null
      && queueIsClaimed
      && (
        executionLease?.holder
        ?? cancellationRequest?.project_holder
        ?? null
      ) !== queueEntry.claimed_by
    ) {
      throw lifecycleQueueClaimError(
        `queue claim ${taskId} is owned by a different project executor`,
        "cancellation_queue_owner_mismatch",
        {
          claimed_by: queueEntry.claimed_by,
          lease_holder: executionLease?.holder ?? null,
          terminated_pid: normalizedTerminatedPid,
        },
      );
    }

    if (activeAttempt) {
      if (
        normalizedTerminatedPid !== null
        && activeAttempt.lease_holder === expectedAttemptHolder
      ) {
        const releasedAttempt = await store.attempts.releaseLease({
          attemptId: activeAttempt.id,
          holder: expectedAttemptHolder,
        });
        if (releasedAttempt?.lease_holder !== null) {
          throw lifecycleQueueClaimError(
            `attempt ${activeAttempt.id} lease changed during cancellation takeover`,
            "cancellation_attempt_lease_changed",
            {
              attempt_id: activeAttempt.id,
              lease_holder: releasedAttempt?.lease_holder ?? null,
            },
          );
        }
        activeAttempt = releasedAttempt;
      }

      const cancellationHolder = `cancel:${process.pid}:${randomUUID()}`;
      const leasedAttempt = await store.attempts.acquireLease({
        attemptId: activeAttempt.id,
        holder: cancellationHolder,
      });
      cancelledAttempt = await store.attempts.transition({
        attemptId: leasedAttempt.id,
        expectedStage: leasedAttempt.stage,
        expectedVersion: leasedAttempt.version,
        holder: cancellationHolder,
        lastError: null,
        nextStage: "CANCELLED",
        statePatch: {
          terminal: {
            cancel_request_id: cancellationRequest?.request_id ?? null,
            reason,
            source_stage: leasedAttempt.stage,
          },
        },
      });
      if (
        cancellationPromotion
        && cancellationPromotion.status !== "PROMOTED"
      ) {
        await store.promotions.markFailed({
          attemptId: leasedAttempt.id,
          error: `cancelled by durable request ${cancellationRequest.request_id}`,
        });
      }
      const paths = attemptWorktree.createAttemptWorktreePaths({
        attemptId: leasedAttempt.id,
        stateRoot,
        taskId,
      });
      const sidecar = attemptWorktree.readAttemptWorktreeSidecar(paths.sidecar_path);
      if (sidecar && sidecar.status !== "REMOVED") {
        reliabilityRc.finalizeReliabilityRcAttemptWorkspace({
          canonicalVerdict: null,
          promoted: false,
          reason,
          sidecarPath: paths.sidecar_path,
        });
      }
    }

    if (normalizedTerminatedPid !== null && executionLease) {
      const releasedExecutionLease = await store.executionLeases.release({
        scope: PROJECT_EXECUTION_LEASE_ID,
        holder: executionLease.holder,
        pid: normalizedTerminatedPid,
      });
      if (!releasedExecutionLease) {
        throw lifecycleQueueClaimError(
          "project execution lease changed during cancellation takeover",
          "cancellation_project_lease_changed",
          {
            lease_holder: executionLease.holder,
            terminated_pid: normalizedTerminatedPid,
          },
        );
      }
    }

    queueEntry = await store.queue.byTask(taskId);
    const currentCancellationRequest =
      parseLifecycleCancellationRequest(queueEntry)
      ?? cancellationRequest;
    const finalizedCancellationRequest = currentCancellationRequest
      ? {
          ...currentCancellationRequest,
          finalized_at: getSystemTimestamp(),
          status: "FINALIZED",
        }
      : null;
    let cancelledQueue = queueEntry;
    if (
      queueEntry
      && !["COMPLETED", "FAILED", "CANCELLED"].includes(queueEntry.state)
    ) {
      const queueHolder = queueEntry.state === "CLAIMED"
        && normalizedTerminatedPid !== null
        && (
          executionLease?.holder
          ?? currentCancellationRequest?.project_holder
          ?? null
        ) === queueEntry.claimed_by
          ? queueEntry.claimed_by
          : null;
      cancelledQueue = await store.queue.transition({
        expectedState: queueEntry.state,
        holder: queueHolder,
        nextState: "CANCELLED",
        payloadPatch: {
          ...(finalizedCancellationRequest
            ? { cancel_request: finalizedCancellationRequest }
            : {}),
          cancelled_reason: reason,
        },
        taskId,
      });
    } else if (
      queueEntry?.state === "CANCELLED"
      && currentCancellationRequest?.status === "REQUESTED"
    ) {
      cancelledQueue = await store.queue.transition({
        expectedState: "CANCELLED",
        nextState: "CANCELLED",
        payloadPatch: {
          cancel_request: finalizedCancellationRequest,
          cancelled_reason: reason,
        },
        taskId,
      });
    } else if (
      currentCancellationRequest?.status === "REQUESTED"
      && queueEntry
    ) {
      throw lifecycleQueueClaimError(
        `cancellation request ${currentCancellationRequest.request_id} conflicts with queue state ${queueEntry.state}`,
        "cancellation_queue_terminal_conflict",
        {
          cancel_request_id: currentCancellationRequest.request_id,
          queue_state: queueEntry.state,
        },
      );
    }
    await reconcileFileQueueProjection({
      applyPending: true,
      stateRoot,
      store,
    });
    return {
      attempt: cancelledAttempt,
      queue: cancelledQueue,
    };
  } finally {
    store.close();
  }
}

function queueProjectionOperatorError(report) {
  const divergenceSummary = report.after.unexplained_divergences
    .map((entry) => `${entry.task_id}:${entry.kind}`)
    .join(", ");
  const error = new Error(
    "file queue projection diverges from authoritative SQLite state"
    + `${divergenceSummary ? ` (${divergenceSummary})` : ""}; `
    + "run `niis queue reconcile` and resolve the reported entries",
  );
  error.code = "queue_projection_requires_operator";
  error.reconciliation = report;
  return error;
}

async function reconcileFileQueueProjection({
  applyPending = true,
  stateRoot,
  store,
}) {
  if (typeof stateRoot !== "string" || stateRoot.trim() === "") {
    throw new Error("stateRoot is required for queue projection reconciliation");
  }
  const projection = createFileQueueProjection({ stateRoot });
  const report = await queueProjection.reconcileQueueProjection({
    applyPending,
    projection,
    store,
  });
  if (report.flush?.failed?.length > 0) {
    const first = report.flush.failed[0];
    throw new Error(
      `file queue projection outbox failed at ${first.event_id}: ${first.error}`,
    );
  }
  if (report.requires_operator) {
    throw queueProjectionOperatorError(report);
  }
  return report;
}

function parseLifecycleCancellationRequest(queueEntry) {
  const raw = queueEntry?.payload?.cancel_request ?? null;
  if (raw === null || raw === undefined) return null;
  const invalid = (reason) => {
    throw lifecycleQueueClaimError(
      `invalid durable cancellation request for ${queueEntry?.task_id ?? "unknown task"}: ${reason}`,
      "invalid_lifecycle_cancel_request",
      { task_id: queueEntry?.task_id ?? null },
    );
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalid("request must be an object");
  }
  if (raw.schema_version !== 1) return invalid("unsupported schema version");
  if (
    typeof raw.request_id !== "string"
    || raw.request_id.trim() === ""
  ) {
    return invalid("request_id is required");
  }
  if (raw.task_id !== queueEntry.task_id) {
    return invalid("task binding does not match the queue entry");
  }
  if (!["REQUESTED", "FINALIZED"].includes(raw.status)) {
    return invalid("status must be REQUESTED or FINALIZED");
  }
  if (
    typeof raw.requested_at !== "string"
    || !Number.isFinite(Date.parse(raw.requested_at))
  ) {
    return invalid("requested_at must be an ISO timestamp");
  }
  if (
    typeof raw.requested_by !== "string"
    || raw.requested_by.trim() === ""
  ) {
    return invalid("requested_by is required");
  }
  if (
    !Number.isInteger(raw.project_pid)
    || raw.project_pid <= 0
    || typeof raw.project_holder !== "string"
    || raw.project_holder.trim() === ""
  ) {
    return invalid("project owner binding is invalid");
  }
  if (
    typeof raw.project_scope !== "string"
    || raw.project_scope.trim() === ""
    || typeof raw.project_acquired_at !== "string"
    || !Number.isFinite(Date.parse(raw.project_acquired_at))
    || !Number.isInteger(raw.project_lease_version)
    || raw.project_lease_version < 0
  ) {
    return invalid("project lease identity is invalid");
  }
  if (!["PENDING", "CLAIMED"].includes(raw.queue_state)) {
    return invalid("queue_state binding is invalid");
  }
  if (
    !Number.isInteger(raw.queue_version)
    || raw.queue_version < 0
  ) {
    return invalid("queue_version binding is invalid");
  }
  if (
    raw.queue_state === "CLAIMED"
    && (
      typeof raw.queue_holder !== "string"
      || raw.queue_holder.trim() === ""
      || raw.queue_holder !== raw.project_holder
    )
  ) {
    return invalid("claimed queue owner does not match the project owner");
  }
  if (raw.queue_state === "PENDING" && raw.queue_holder !== null) {
    return invalid("pending queue binding must not name a claimant");
  }
  if (
    raw.attempt_id !== null
    && (
      typeof raw.attempt_id !== "string"
      || raw.attempt_id.trim() === ""
    )
  ) {
    return invalid("attempt_id binding is invalid");
  }
  if (
    raw.attempt_holder !== null
    && (
      typeof raw.attempt_holder !== "string"
      || raw.attempt_holder
        !== `cli-lifecycle:${raw.project_pid}`
    )
  ) {
    return invalid("attempt owner does not match the project PID");
  }
  if (
    raw.attempt_id === null
    && (
      raw.attempt_holder !== null
      || raw.attempt_stage !== null
      || raw.attempt_version !== null
    )
  ) {
    return invalid("missing attempt cannot carry attempt owner metadata");
  }
  if (
    raw.attempt_id !== null
    && (
      !Number.isInteger(raw.attempt_version)
      || raw.attempt_version < 0
      || typeof raw.attempt_stage !== "string"
      || raw.attempt_stage.trim() === ""
    )
  ) {
    return invalid("attempt stage/version binding is invalid");
  }
  if (
    raw.status === "FINALIZED"
    && (
      typeof raw.finalized_at !== "string"
      || !Number.isFinite(Date.parse(raw.finalized_at))
    )
  ) {
    return invalid("finalized request requires finalized_at");
  }
  return Object.freeze({ ...raw });
}

function lifecycleCancellationTerminalResult(request, attemptId = null) {
  return {
    attempt_id: attemptId ?? request.attempt_id,
    cancel_request_id: request.request_id,
    canonical_verdict: null,
    reason: "durable operator cancellation was requested",
    terminal_stage: "CANCELLED",
  };
}

async function readLifecycleCancellationRequest({
  attemptId = null,
  store,
  taskId,
}) {
  const queueEntry = await store.queue.byTask(taskId);
  const request = parseLifecycleCancellationRequest(queueEntry);
  if (!request || request.status !== "REQUESTED") return null;
  const boundAttemptId =
    request.attempt_id
    ?? (
      typeof queueEntry.payload?.attempt_id === "string"
      && queueEntry.payload.attempt_id.trim() !== ""
        ? queueEntry.payload.attempt_id.trim()
        : null
    );
  if (
    attemptId
    && boundAttemptId
    && boundAttemptId !== attemptId
  ) {
    throw lifecycleQueueClaimError(
      `cancellation request ${request.request_id} is bound to ${boundAttemptId}, not ${attemptId}`,
      "lifecycle_cancel_attempt_mismatch",
      {
        attempt_id: attemptId,
        cancel_request_attempt_id: boundAttemptId,
        cancel_request_id: request.request_id,
      },
    );
  }
  return request;
}

async function requestLifecycleCancellation({
  databasePath,
  requestedBy = `operator:${process.pid}`,
  stateRoot,
  supervisedPid,
  taskId,
}) {
  if (!Number.isInteger(supervisedPid) || supervisedPid <= 0) {
    throw lifecycleQueueClaimError(
      "supervisedPid must be a positive integer",
      "invalid_cancel_supervised_pid",
    );
  }
  if (typeof requestedBy !== "string" || requestedBy.trim() === "") {
    throw lifecycleQueueClaimError(
      "requestedBy must be a non-empty string",
      "invalid_cancel_requester",
    );
  }
  const store = storage.createLifecycleSqliteStore({ databasePath });
  try {
    const queueEntry = await store.queue.byTask(taskId);
    if (!queueEntry || !["PENDING", "CLAIMED"].includes(queueEntry.state)) {
      throw lifecycleQueueClaimError(
        `task ${taskId} is not cancellable from queue state ${queueEntry?.state ?? "missing"}`,
        "lifecycle_cancel_queue_not_active",
        { queue_state: queueEntry?.state ?? null },
      );
    }
    const existingRequest = parseLifecycleCancellationRequest(queueEntry);
    if (existingRequest) {
      if (
        existingRequest.status !== "REQUESTED"
        || existingRequest.project_pid !== supervisedPid
      ) {
        throw lifecycleQueueClaimError(
          `task ${taskId} already has cancellation request ${existingRequest.request_id}`,
          "lifecycle_cancel_request_conflict",
          { cancel_request_id: existingRequest.request_id },
        );
      }
    }

    const executionLease = await store.executionLeases.byScope(
      PROJECT_EXECUTION_LEASE_ID,
    );
    if (
      !executionLease
      || executionLease.pid !== supervisedPid
    ) {
      throw lifecycleQueueClaimError(
        `process ${supervisedPid} does not own the durable project execution lease`,
        "lifecycle_cancel_project_owner_mismatch",
        {
          lease_holder: executionLease?.holder ?? null,
          lease_pid: executionLease?.pid ?? null,
          supervised_pid: supervisedPid,
        },
      );
    }
    if (
      existingRequest
      && (
        existingRequest.project_scope !== executionLease.scope
        || existingRequest.project_holder !== executionLease.holder
        || existingRequest.project_acquired_at !== executionLease.acquired_at
      )
    ) {
      throw lifecycleQueueClaimError(
        `cancellation request ${existingRequest.request_id} belongs to a different project lease`,
        "lifecycle_cancel_request_conflict",
        { cancel_request_id: existingRequest.request_id },
      );
    }
    if (
      queueEntry.state === "CLAIMED"
      && queueEntry.claimed_by !== executionLease.holder
    ) {
      throw lifecycleQueueClaimError(
        `queue claim ${taskId} is not owned by process ${supervisedPid}`,
        "lifecycle_cancel_queue_owner_mismatch",
        {
          claimed_by: queueEntry.claimed_by,
          lease_holder: executionLease.holder,
        },
      );
    }

    const queueAttemptId =
      typeof queueEntry.payload?.attempt_id === "string"
      && queueEntry.payload.attempt_id.trim() !== ""
        ? queueEntry.payload.attempt_id.trim()
        : null;
    const activeAttempt = await store.attempts.activeByTask(taskId);
    if (
      queueAttemptId
      && activeAttempt
      && queueAttemptId !== activeAttempt.id
    ) {
      throw lifecycleQueueClaimError(
        `queue attempt ${queueAttemptId} does not match active attempt ${activeAttempt.id}`,
        "lifecycle_cancel_attempt_mismatch",
      );
    }
    const attempt = queueAttemptId
      ? await store.attempts.byId(queueAttemptId)
      : activeAttempt;
    if (attempt && attempt.task_id !== taskId) {
      throw lifecycleQueueClaimError(
        `attempt ${attempt.id} is not bound to task ${taskId}`,
        "lifecycle_cancel_attempt_mismatch",
      );
    }
    if (
      attempt
      && TERMINAL_LIFECYCLE_ATTEMPT_STAGES.has(attempt.stage)
    ) {
      throw lifecycleQueueClaimError(
        `attempt ${attempt.id} is already terminal at ${attempt.stage}`,
        "lifecycle_cancel_attempt_terminal",
        {
          attempt_id: attempt.id,
          attempt_stage: attempt.stage,
        },
      );
    }
    if (
      attempt
      && attempt.lease_holder !== null
      && attempt.lease_holder !== `cli-lifecycle:${supervisedPid}`
    ) {
      throw lifecycleQueueClaimError(
        `attempt ${attempt.id} is owned by a different executor`,
        "lifecycle_cancel_attempt_owner_mismatch",
        {
          attempt_id: attempt.id,
          lease_holder: attempt.lease_holder,
          supervised_pid: supervisedPid,
        },
      );
    }
    if (attempt) {
      const promotion = await store.promotions.byAttempt(attempt.id);
      if (promotion) {
        throw lifecycleQueueClaimError(
          `attempt ${attempt.id} already entered the irreversible promotion zone`,
          "cancellation_after_promotion_started",
          {
            attempt_id: attempt.id,
            promotion_status: promotion.status,
          },
        );
      }
    }

    const updated = await store.queue.requestCancellation({
      attemptHolder: `cli-lifecycle:${supervisedPid}`,
      executionLeaseHolder: executionLease.holder,
      executionLeasePid: supervisedPid,
      executionLeaseScope: PROJECT_EXECUTION_LEASE_ID,
      requestId: `cancel:${randomUUID()}`,
      requestedBy: String(requestedBy),
      taskId,
      now: getSystemTimestamp(),
    });
    await reconcileFileQueueProjection({
      applyPending: true,
      stateRoot,
      store,
    });
    return parseLifecycleCancellationRequest(updated);
  } finally {
    store.close();
  }
}

async function recoverDurableLifecycleCancellations({
  databasePath,
  stateRoot,
  taskId = null,
}) {
  const reader = storage.createLifecycleSqliteStore({
    databasePath,
    readonly: true,
  });
  let candidates;
  try {
    const entries = taskId
      ? [await reader.queue.byTask(taskId)].filter(Boolean)
      : await reader.queue.list();
    candidates = entries
      .map((entry) => ({
        entry,
        request: parseLifecycleCancellationRequest(entry),
      }))
      .filter(({ request }) => request?.status === "REQUESTED");
  } finally {
    reader.close();
  }

  const finalized = [];
  const pending = [];
  for (const candidate of candidates) {
    const { entry, request } = candidate;
    if (isPidAlive(request.project_pid)) {
      pending.push({
        cancel_request_id: request.request_id,
        pid: request.project_pid,
        task_id: entry.task_id,
      });
      continue;
    }
    const result = await cancelLifecycleTask({
      databasePath,
      reason: "recovered durable cancellation after the supervised owner exited",
      stateRoot,
      taskId: entry.task_id,
      terminatedPid: request.project_pid,
    });
    const probe = storage.createLifecycleSqliteStore({
      databasePath,
      readonly: true,
    });
    let attempt;
    let queue;
    try {
      queue = await probe.queue.byTask(entry.task_id);
      const attemptId =
        request.attempt_id
        ?? (
          typeof queue?.payload?.attempt_id === "string"
          && queue.payload.attempt_id.trim() !== ""
            ? queue.payload.attempt_id.trim()
            : null
        );
      attempt = attemptId
        ? await probe.attempts.byId(attemptId)
        : null;
    } finally {
      probe.close();
    }
    if (attempt && attempt.stage !== "CANCELLED") {
      throw lifecycleQueueClaimError(
        `recovered cancellation ${request.request_id} did not converge attempt ${attempt.id}`,
        "cancellation_recovery_not_terminal",
        {
          attempt_id: attempt.id,
          attempt_stage: attempt.stage,
          cancel_request_id: request.request_id,
        },
      );
    }
    const lifecycle = {
      attempt_id: attempt?.id ?? request.attempt_id,
      canonical_verdict: null,
      stage: "CANCELLED",
      state:
        attempt?.state
        ?? {
          terminal: {
            cancel_request_id: request.request_id,
            reason: "durable operator cancellation was recovered",
          },
        },
    };
    await synchronizeTaskStatusFromLifecycleResult({
      databasePath,
      lifecycleResult: lifecycle,
      taskId: entry.task_id,
    });
    finalized.push({
      attempt: result.attempt ?? attempt,
      cancel_request_id: request.request_id,
      lifecycle,
      queue: result.queue ?? queue,
      task_id: entry.task_id,
    });
  }
  return Object.freeze({
    finalized: Object.freeze(finalized),
    pending: Object.freeze(pending),
  });
}

function promoteLifecycleAttempt({
  attemptId,
  expectedTaskSnapshotSha256,
  failAfterStep = null,
  stateRoot,
  taskId,
}) {
  const paths = attemptWorktree.createAttemptWorktreePaths({
    attemptId,
    stateRoot,
    taskId,
  });
  if (!attemptWorktree.readAttemptWorktreeSidecar(paths.sidecar_path)) {
    throw new Error(`attempt worktree sidecar is missing: ${paths.sidecar_path}`);
  }
  const promotionCommit = attemptWorktree.ensureAttemptWorktreePromotionCommit({
    canonicalVerdict: "PASS",
    expectedTaskSnapshotSha256,
    failAfterStep,
    sidecarPath: paths.sidecar_path,
  });
  if (!promotionCommit.promotion_ready) {
    return {
      terminal_stage: "BLOCKED",
      reason: "canonical PASS produced no task-worktree diff; no promotion was recorded",
    };
  }
  const committedSidecar = attemptWorktree.readAttemptWorktreeSidecar(
    paths.sidecar_path,
  ) ?? promotionCommit.sidecar;
  return {
    targetKind: "BRANCH",
    targetRef: committedSidecar.branch_name,
    branchName: committedSidecar.branch_name,
    commitSha: promotionCommit.commit_sha,
    metadata: {
      attempt_id: attemptId,
      changed_files: promotionCommit.verified_diff.changed_files,
      reviewed_task_snapshot_sha256: expectedTaskSnapshotSha256,
      source: "owned_attempt_worktree",
    },
  };
}

function resolveTestPromotionFailureStep() {
  const requested = process.env.NIIS_TEST_PROMOTION_FAIL_AFTER_STEP;
  if (!requested) return null;
  if (process.env.NIIS_TEST_RUN !== "1") {
    throw new Error(
      "NIIS_TEST_PROMOTION_FAIL_AFTER_STEP is permitted only during an explicit test run",
    );
  }
  const allowed = new Set(["intent", "commit_object", "commit", "branch"]);
  if (!allowed.has(requested)) {
    throw new Error(
      "NIIS_TEST_PROMOTION_FAIL_AFTER_STEP must be intent, commit_object, commit, or branch",
    );
  }
  return requested;
}

function shouldInjectCancelCrashAfterReap() {
  if (process.env.NIIS_TEST_CANCEL_CRASH_AFTER_REAP !== "1") return false;
  if (process.env.NIIS_TEST_RUN !== "1") {
    throw new Error(
      "NIIS_TEST_CANCEL_CRASH_AFTER_REAP is permitted only during an explicit test run",
    );
  }
  return true;
}

function finalizePromotedAttemptWorkspace({
  attemptId,
  stateRoot,
  taskId,
}) {
  const paths = attemptWorktree.createAttemptWorktreePaths({
    attemptId,
    stateRoot,
    taskId,
  });
  const sidecar = attemptWorktree.readAttemptWorktreeSidecar(paths.sidecar_path);
  if (sidecar?.status === "REMOVED") {
    return {
      already_finalized: true,
      branch_name: sidecar.branch_name,
      removed: true,
    };
  }
  return reliabilityRc.finalizeReliabilityRcAttemptWorkspace({
    canonicalVerdict: "PASS",
    promoted: true,
    sidecarPath: paths.sidecar_path,
  });
}

function classifyAcceptanceGateReport(report) {
  if (!report || typeof report !== "object") {
    return {
      canonical_verdict: "EVIDENCE_GAP",
      reason: "acceptance command report is missing",
    };
  }
  if (
    report.aborted === true
    || report.results?.some((result) => result.status === "CANCELLED")
  ) {
    return {
      canonical_verdict: null,
      reason: "acceptance command execution was cancelled",
      terminal_stage: "CANCELLED",
    };
  }
  const requiredFailures = Array.isArray(report.hard_failures)
    ? report.hard_failures
    : [];
  if (requiredFailures.length > 0) {
    const environmentFailure = requiredFailures.some((result) =>
      result.status === "TIMEOUT"
      || result.status === "ERROR"
      || result.timed_out === true
      || Boolean(result.spawn_error));
    return {
      canonical_verdict: environmentFailure ? "ENV_BLOCK" : "DEFECT",
      reason: environmentFailure
        ? "a required acceptance command could not complete in the execution environment"
        : "a required acceptance command failed",
    };
  }
  if (report.ok === true) {
    return {
      canonical_verdict: "PASS",
      reason: "all required acceptance commands passed",
    };
  }
  return {
    canonical_verdict: "EVIDENCE_GAP",
    reason: "acceptance command evidence is incomplete",
  };
}

async function runLifecycleAcceptanceCommands({
  acceptanceCommands,
  context,
}) {
  if (!Array.isArray(acceptanceCommands) || acceptanceCommands.length === 0) {
    return {
      canonical_verdict: "EVIDENCE_GAP",
      evidence_items: [],
      hard_failures: [],
      ok: false,
      reason: "no deterministic acceptance commands were approved",
      results: [],
      source: "acceptance_command_runner",
    };
  }
  const runnerOptions = {
    acceptanceCommands,
    deniedReadRoots: context.deniedReadRoots ?? [],
    signal: context.abortSignal,
    workspacePath: context.workspacePath,
  };
  if (Number.isInteger(context.timeoutMs) && context.timeoutMs > 0) {
    runnerOptions.timeoutMs = context.timeoutMs;
  }
  try {
    const report = await acceptanceCommandRunner.runAcceptanceCommandPlan(
      runnerOptions,
    );
    return {
      ...report,
      ...classifyAcceptanceGateReport(report),
      source: "acceptance_command_runner",
    };
  } catch (error) {
    if (
      error?.name === "AcceptanceCommandRunnerError"
      || error?.name === "AcceptanceCommandPlanError"
      || error?.code === "invalid_acceptance_command_plan"
      || error?.code === "invalid_acceptance_command_runner_options"
      || error?.code === "invalid_attempt_workspace"
    ) {
      return {
        canonical_verdict: "EVIDENCE_GAP",
        evidence_items: [],
        hard_failures: [],
        ok: false,
        reason: `acceptance command plan is non-runnable: ${error.message}`,
        results: [],
        source: "acceptance_command_runner",
        terminal_stage: "BLOCKED",
      };
    }
    throw error;
  }
}

function roleQualityGatesToAcceptanceCommands(gates) {
  if (!Array.isArray(gates)) return [];
  return gates.map((gate) => ({
    argv: [
      gate.command,
      ...(Array.isArray(gate.args) ? gate.args : []),
    ],
    id: `role:${gate.id}`,
    required: gate.fail_mode !== "soft",
  }));
}

async function reviewLifecycleAcceptanceEvidence({
  artifact,
  context,
  stateRoot,
  taskId,
  taskResult,
}) {
  const gateResult = context.gateResult ?? {};
  const gateVerdict = gateResult.canonical_verdict ?? "EVIDENCE_GAP";
  if (gateVerdict !== "PASS") {
    return {
      canonical_verdict: gateVerdict,
      fresh_context: true,
      reason: gateResult.reason ?? `deterministic gate returned ${gateVerdict}`,
      source: "fresh_outer_validator",
    };
  }
  const protectedStateBefore =
    context.state?.workspace?.protected_state_digest
    ?? null;
  if (
    typeof protectedStateBefore !== "string"
    || protectedStateBefore !== computeProtectedStateDigest(stateRoot)
  ) {
    return {
      canonical_verdict: "ENV_BLOCK",
      fresh_context: true,
      reason: "protected canonical state changed before fresh review",
      source: "protected_state_gate",
    };
  }

  const reviewConfig = getLlmReviewConfig({
    workspaceRoot: context.workspacePath,
  });

  const paths = attemptWorktree.createAttemptWorktreePaths({
    attemptId: context.attemptId,
    stateRoot,
    taskId,
  });
  const sidecar = attemptWorktree.readAttemptWorktreeSidecar(paths.sidecar_path);
  const diff = attemptWorktree.captureAttemptWorktreeDiff({
    sidecarPath: paths.sidecar_path,
  });
  if (
    typeof gateResult.task_snapshot_sha256 === "string"
    && gateResult.task_snapshot_sha256 !== diff.task_snapshot_sha256
  ) {
    return {
      canonical_verdict: "DEFECT",
      fresh_context: true,
      reason: "the task delta changed after deterministic gates completed",
      source: "fresh_outer_validator",
      task_snapshot_sha256: diff.task_snapshot_sha256,
    };
  }
  if (!diff.has_task_delta) {
    return {
      canonical_verdict: "DEFECT",
      fresh_context: true,
      reason: "the attempt produced no reviewable task-worktree delta",
      source: "fresh_outer_validator",
      task_snapshot_sha256: diff.task_snapshot_sha256,
    };
  }
  if (diff.has_committed_changes) {
    return {
      canonical_verdict: "DEFECT",
      fresh_context: true,
      reason: "the executor created a commit before the canonical PASS promotion gate",
      source: "fresh_outer_validator",
      task_snapshot_sha256: diff.task_snapshot_sha256,
    };
  }
  const summaries = [
    ...(gateResult.evidence_items ?? []).map((item) => ({
      content: item.content,
      source: item.source ?? "acceptance-command",
    })),
    {
      content: JSON.stringify({
        inner_final_verdict: taskResult.final_verdict ?? null,
        run_record: taskResult.run_record ?? null,
      }),
      source: "persisted-inner-review",
    },
  ];
  const reviewer = createLlmReviewer({
    deniedReadRoots: resolveExecutorDeniedReadRoots(stateRoot),
    executorAdapterId: taskResult.run_record?.adapter_id ?? null,
    legacyModelPreference: reviewConfig.legacy_model_preference,
    mode: reviewConfig.mode,
    modelPreferences: reviewConfig.model_preferences,
    workspaceRoot: context.workspacePath,
  });
  try {
    const verdict = await reviewer({
      acceptance:
        artifact?.derived_task?.acceptance_markdown
        ?? artifact?.acceptance_markdown
        ?? null,
      brief:
        artifact?.derived_task?.operator_brief_markdown
        ?? artifact?.operator_prompt
        ?? null,
      diffs: diff.full_diff || diff.status
        ? [{
            content: `${diff.status}\n\n${diff.full_diff}`,
            source: `attempt-diff:${context.attemptId}`,
          }]
        : [],
      outOfScope:
        artifact?.derived_task?.out_of_scope
        ?? artifact?.out_of_scope
        ?? [],
      reviewTarget: sidecar
        ? {
            branch_name: sidecar.branch_name,
            source_branch: sidecar.base_ref,
            worktree_path: sidecar.worktree_path,
          }
        : null,
      summaries,
      title: artifact?.derived_task?.title ?? taskId,
      signal: context.abortSignal,
      timeoutMs: context.timeoutMs,
    });
    const reviewedSnapshot = attemptWorktree.captureAttemptWorktreeDiff({
      sidecarPath: paths.sidecar_path,
    });
    if (protectedStateBefore !== computeProtectedStateDigest(stateRoot)) {
      return {
        canonical_verdict: "ENV_BLOCK",
        fresh_context: true,
        reason: "protected canonical state changed while fresh review was running",
        source: "protected_state_gate",
      };
    }
    if (
      reviewedSnapshot.task_snapshot_sha256
      !== diff.task_snapshot_sha256
    ) {
      return {
        canonical_verdict: "DEFECT",
        fresh_context: true,
        reason: "task worktree changed while the fresh reviewer was running",
        source: "fresh_outer_llm_review",
      };
    }
    return {
      canonical_verdict: ["PASS", "DEFECT", "EVIDENCE_GAP"].includes(verdict.verdict)
        ? verdict.verdict
        : "EVIDENCE_GAP",
      fresh_context: true,
      llm_review: verdict,
      reason: verdict.reason ?? "fresh LLM review completed",
      source: "fresh_outer_llm_review",
      task_snapshot_sha256: diff.task_snapshot_sha256,
    };
  } catch (error) {
    if (context.abortSignal?.aborted) {
      return {
        canonical_verdict: null,
        fresh_context: true,
        reason: "fresh LLM review was cancelled",
        source: "fresh_outer_llm_review",
        terminal_stage: "CANCELLED",
      };
    }
    return {
      canonical_verdict: "ENV_BLOCK",
      fresh_context: true,
      reason: `fresh LLM review could not run: ${error instanceof Error ? error.message : String(error)}`,
      source: "fresh_outer_llm_review",
    };
  }
}

async function finalizeLifecycleQueue({
  claimHolder = null,
  lifecycleResult,
  store,
  taskId,
}) {
  const nextState = durableQueueStateFromAttempt(lifecycleResult);
  if (!nextState) return null;
  const current = await store.queue.byTask(taskId);
  if (!current || current.state === nextState) return current;

  if (current.state === "CLAIMED") {
    if (!claimHolder || current.claimed_by !== claimHolder) {
      return current;
    }
    return store.queue.transition({
      expectedState: "CLAIMED",
      holder: claimHolder,
      nextState,
      payloadPatch: {
        attempt_id: lifecycleResult.attempt_id,
        canonical_verdict: lifecycleResult.canonical_verdict,
      },
      taskId,
    });
  }

  if (current.state !== "PENDING") {
    return current;
  }
  return store.queue.transition({
    expectedState: "PENDING",
    nextState,
    payloadPatch: {
      attempt_id: lifecycleResult.attempt_id,
      canonical_verdict: lifecycleResult.canonical_verdict,
    },
    taskId,
  });
}

async function executeTaskViaLifecycle({
  abortSignal = null,
  agentTickTask = null,
  artifact = null,
  attemptId = null,
  executorRuntime = null,
  plan,
  promotionFailAfterStep = null,
  queueClaimHolder = null,
  taskId,
  timeoutMs = null,
  trigger,
  workspaceRoot,
}) {
  const approvedPlan = await readApprovedPlan({
    databasePath: plan.databasePath,
    stateRoot: plan.stateRoot,
    taskId,
  });
  if (!approvedPlan) {
    throw new Error(
      `task ${taskId} has no approved plan; run \`niis approve-plan --task-id ${taskId}\` before execution`,
    );
  }
  const lifecycleStore = storage.createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  const networkPolicy = Object.freeze({
    mode: "disabled",
  });
  const sandboxPolicy = Object.freeze({
    concurrency: 1,
    denied_read_roots: resolveExecutorDeniedReadRoots(plan.stateRoot),
    mode: "workspace-write",
  });
  const configuredTimeoutMs = timeoutMs
    ?? getSubtaskTimeoutMs({ workspaceRoot });
  const lifecycleTimeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? Math.floor(configuredTimeoutMs)
      : 15 * 60 * 1000;
  const lifecycleAbortController = new AbortController();
  const abortLifecycle = () => lifecycleAbortController.abort();
  const timeoutHandle = setTimeout(abortLifecycle, lifecycleTimeoutMs);
  timeoutHandle.unref?.();
  if (abortSignal) {
    if (abortSignal.aborted) {
      lifecycleAbortController.abort();
    } else {
      abortSignal.addEventListener("abort", abortLifecycle, { once: true });
    }
  }
  process.once("SIGINT", abortLifecycle);
  process.once("SIGTERM", abortLifecycle);
  let effectiveAttemptId = attemptId;
  let cancellationPollTimer = null;
  let cancellationPollPromise = null;

  try {
    const currentEngineVersion = `niis-cli/${readInstalledNiisVersion()}`;
    const claimedQueueEntry = queueClaimHolder
      ? await lifecycleStore.queue.byTask(taskId)
      : null;
    const persistedAttemptId =
      typeof claimedQueueEntry?.payload?.attempt_id === "string"
      && claimedQueueEntry.payload.attempt_id.trim() !== ""
        ? claimedQueueEntry.payload.attempt_id.trim()
        : null;
    const persistedAttempt = persistedAttemptId
      ? await lifecycleStore.attempts.byId(persistedAttemptId)
      : null;
    const activeAttempt = await lifecycleStore.attempts.activeByTask(taskId);
    if (persistedAttemptId && !persistedAttempt) {
      throw lifecycleQueueClaimError(
        `queue entry ${taskId} references missing attempt ${persistedAttemptId}`,
        "lifecycle_queue_attempt_missing",
      );
    }
    if (claimedQueueEntry) {
      await assertQueuedAutoRepairClaimPolicy({
        databasePath: plan.databasePath,
        queueEntry: claimedQueueEntry,
        workspaceRoot,
      });
    }
    const repairContext = claimedQueueEntry
      ? attachQueuedAutoRepairContext({
          approvedPlanDigest: approvedPlan.plan_digest,
          artifact,
          attempts: await lifecycleStore.attempts.listByTask(taskId),
          boundAttempt: persistedAttempt,
          queueEntry: claimedQueueEntry,
        })
      : Object.freeze({ artifact, priorAttempt: null });
    const repairPriorAttempt = repairContext.priorAttempt;
    artifact = repairContext.artifact;
    const intendedAttemptId = persistedAttempt?.id
      ?? attemptId
      ?? activeAttempt?.id
      ?? `attempt:${randomUUID()}`;
    const intendedTrigger = persistedAttempt?.trigger
      ?? activeAttempt?.trigger
      ?? (repairPriorAttempt ? AUTO_REPAIR_TRIGGER : null)
      ?? trigger;
    const intendedEngineVersion = persistedAttempt?.engine_version
      ?? activeAttempt?.engine_version
      ?? currentEngineVersion;
    if (queueClaimHolder) {
      const binding = await lifecycleStore.queue.bindAttempt({
        attemptId: intendedAttemptId,
        engineVersion: intendedEngineVersion,
        holder: queueClaimHolder,
        taskId,
        trigger: intendedTrigger,
      });
      effectiveAttemptId = binding.attempt.id;
    } else {
      effectiveAttemptId = intendedAttemptId;
    }
    const persistedCancellation = await readLifecycleCancellationRequest({
      attemptId: effectiveAttemptId,
      store: lifecycleStore,
      taskId,
    });
    if (persistedCancellation) {
      lifecycleAbortController.abort();
    }
    cancellationPollTimer = setInterval(() => {
      if (cancellationPollPromise) return;
      cancellationPollPromise = readLifecycleCancellationRequest({
        attemptId: effectiveAttemptId,
        store: lifecycleStore,
        taskId,
      }).then((request) => {
        if (request) lifecycleAbortController.abort();
      }).catch((error) => {
        process.stderr.write(
          `[niis] Cancellation request check failed: `
          + `${error instanceof Error ? error.message : String(error)}\n`,
        );
        lifecycleAbortController.abort();
      }).finally(() => {
        cancellationPollPromise = null;
      });
    }, 100);
    cancellationPollTimer.unref?.();
    const lifecycleResult = await executeCliTaskLifecycle({
      attemptId: effectiveAttemptId,
      engineVersion: intendedEngineVersion,
      executeTask: async (context) => {
        if (agentTickTask) {
          const error = new Error(
            "agent_tick execution is deferred in Reliability RC because its "
            + "adapter does not yet satisfy the per-attempt workspace and policy contract",
          );
          error.code = "agent_tick_adapter_deferred";
          error.retrySafe = false;
          error.retry_safe = false;
          throw error;
        }
        return startTaskFromArtifact({
          abortSignal: context.abortSignal,
          artifact,
          attemptId: context.attemptId,
          deferPromotion: true,
          executorRuntime,
          networkPolicy: context.networkPolicy,
          sandboxPolicy: context.sandboxPolicy,
          stateRoot: plan.stateRoot,
          timeoutMs: context.timeoutMs,
          workspaceRoot: context.workspacePath,
        });
      },
      finishTask: async (context) => {
        const beforeDigest =
          context.state?.workspace?.primary_checkout_digest
          ?? null;
        const afterDigest = computePrimaryCheckoutDigest(workspaceRoot);
        const protectedStateDigest =
          context.state?.workspace?.protected_state_digest
          ?? null;
        if (
          typeof beforeDigest !== "string"
          || !/^[a-f0-9]{64}$/u.test(beforeDigest)
          || beforeDigest !== afterDigest
          || typeof protectedStateDigest !== "string"
          || protectedStateDigest
            !== computeProtectedStateDigest(plan.stateRoot)
        ) {
          return {
            reason: "primary checkout changed during the isolated task lifecycle",
            terminal_stage: "FAILED",
          };
        }
        const budgetEvidence = await resolveLifecycleBudgetReadinessEvidence({
          databasePath: plan.databasePath,
          taskResult: context.taskResult,
          workspacePath: context.workspacePath,
        });
        const workspaceFinalization = finalizePromotedAttemptWorkspace({
          attemptId: context.attemptId,
          stateRoot: plan.stateRoot,
          taskId,
        });
        const result = {
          queue_finalization_deferred_to_sqlite: true,
          workspace: workspaceFinalization,
        };
        const repositoryRoot =
          context.state?.workspace?.repository_root
          ?? workspaceRoot;
        const changedFiles =
          context.state?.promotion?.metadata?.changed_files
          ?? null;
        const adapterId = context.taskResult?.run_record?.adapter_id ?? null;
        let repositoryEvidence = null;
        let runtimeEvidence = null;
        try {
          const canonicalRepositoryRoot = fs.realpathSync.native(
            path.resolve(repositoryRoot),
          );
          const selfHostScope = resolveLifecycleSelfHostScope(
            canonicalRepositoryRoot,
          );
          repositoryEvidence = {
            ...createReadinessRepositoryIdentity(canonicalRepositoryRoot),
            changed_paths_sha256:
              createReadinessChangedPathsDigest(changedFiles),
            checkout_sha256: afterDigest,
            class: classifyReadinessRepository({
              changedFiles,
              repositoryRoot: canonicalRepositoryRoot,
              selfHostScope,
            }),
            self_host_scope: selfHostScope,
          };
          const runtimeFamily = normalizeReadinessRuntimeFamily(adapterId);
          if (runtimeFamily && typeof adapterId === "string") {
            runtimeEvidence = {
              adapter_id: adapterId,
              family: runtimeFamily,
            };
          }
        } catch {
          repositoryEvidence = null;
          runtimeEvidence = null;
        }
        if (
          typeof beforeDigest === "string"
          && /^[a-f0-9]{64}$/u.test(beforeDigest)
          && budgetEvidence
          && repositoryEvidence
          && runtimeEvidence
        ) {
          result.readiness_evidence = {
            budget: budgetEvidence,
            primary_checkout: {
              after_digest: afterDigest,
              before_digest: beforeDigest,
            },
            repository: repositoryEvidence,
            runtime: runtimeEvidence,
            schema_version: 2,
          };
        }
        return result;
      },
      holder: `cli-lifecycle:${process.pid}`,
      networkPolicy,
      prepareWorkspace: ({ attemptId: lifecycleAttemptId }) => {
        const primaryCheckoutDigest = computePrimaryCheckoutDigest(workspaceRoot);
        const protectedStateDigest = computeProtectedStateDigest(plan.stateRoot);
        const prepared = reliabilityRc.prepareReliabilityRcAttemptWorkspace({
          attemptId: lifecycleAttemptId,
          repositoryPath: workspaceRoot,
          stateRoot: plan.stateRoot,
          taskId,
        });
        const configMaterialization = materializeAttemptRuntimeConfig({
          attemptWorkspacePath: prepared.worktree_path,
          canonicalStateRoot: plan.stateRoot,
        });
        return {
          ...prepared,
          config_materialization: configMaterialization,
          plan_approval_digest: approvedPlan.plan_digest,
          primary_checkout_digest: primaryCheckoutDigest,
          protected_state_digest: protectedStateDigest,
          workspacePath: prepared.worktree_path,
        };
      },
      promoteTask: async (context) => {
        const cancellationRequest = await readLifecycleCancellationRequest({
          attemptId: context.attemptId,
          store: lifecycleStore,
          taskId,
        });
        if (cancellationRequest) {
          return lifecycleCancellationTerminalResult(
            cancellationRequest,
            context.attemptId,
          );
        }
        const currentApproval = await readApprovedPlan({
          databasePath: plan.databasePath,
          stateRoot: plan.stateRoot,
          taskId,
        });
        if (
          !currentApproval
          || currentApproval.plan_digest
            !== context.state?.workspace?.plan_approval_digest
        ) {
          return {
            canonical_verdict: "EVIDENCE_GAP",
            reason: "the approved plan changed during execution; a new attempt is required",
            terminal_stage: "BLOCKED",
          };
        }
        if (
          context.state?.workspace?.protected_state_digest
          !== computeProtectedStateDigest(plan.stateRoot)
        ) {
          return {
            canonical_verdict: "ENV_BLOCK",
            reason: "protected canonical state changed before promotion",
            terminal_stage: "BLOCKED",
          };
        }
        const beforeDigest =
          context.state?.workspace?.primary_checkout_digest
          ?? null;
        const currentDigest = computePrimaryCheckoutDigest(workspaceRoot);
        if (
          typeof beforeDigest !== "string"
          || !/^[a-f0-9]{64}$/u.test(beforeDigest)
          || beforeDigest !== currentDigest
        ) {
          return {
            canonical_verdict: "ENV_BLOCK",
            reason: "primary checkout changed before promotion",
            terminal_stage: "BLOCKED",
          };
        }
        return promoteLifecycleAttempt({
          attemptId: context.attemptId,
          expectedTaskSnapshotSha256:
            context.state?.review?.task_snapshot_sha256
            ?? null,
          failAfterStep: promotionFailAfterStep,
          stateRoot: plan.stateRoot,
          taskId,
        });
      },
      runGates: async (context) => {
        const currentApproval = await readApprovedPlan({
          databasePath: plan.databasePath,
          stateRoot: plan.stateRoot,
          taskId,
        });
        if (
          !currentApproval
          || currentApproval.plan_digest
            !== context.state?.workspace?.plan_approval_digest
        ) {
          return {
            canonical_verdict: "EVIDENCE_GAP",
            evidence_items: [],
            hard_failures: [],
            ok: false,
            reason: "the plan approval changed after this attempt was claimed",
            results: [],
            source: "approval_integrity_gate",
            terminal_stage: "BLOCKED",
          };
        }
        const protectedStateDigest =
          context.state?.workspace?.protected_state_digest
          ?? null;
        if (
          typeof protectedStateDigest !== "string"
          || protectedStateDigest
            !== computeProtectedStateDigest(plan.stateRoot)
        ) {
          return {
            canonical_verdict: "ENV_BLOCK",
            evidence_items: [],
            hard_failures: [],
            ok: false,
            reason: "protected canonical state changed before deterministic gates",
            results: [],
            source: "protected_state_gate",
            terminal_stage: "BLOCKED",
          };
        }
        const paths = attemptWorktree.createAttemptWorktreePaths({
          attemptId: context.attemptId,
          stateRoot: plan.stateRoot,
          taskId,
        });
        const diff = attemptWorktree.captureAttemptWorktreeDiff({
          sidecarPath: paths.sidecar_path,
        });
        if (diff.has_committed_changes || !diff.has_task_delta) {
          return {
            canonical_verdict: "DEFECT",
            evidence_items: [],
            hard_failures: [],
            ok: false,
            reason: diff.has_committed_changes
              ? "executor commits are forbidden before canonical PASS"
              : "the attempt produced no reviewable task-worktree delta",
            results: [],
            source: "task_delta_integrity_gate",
            terminal_stage: "BLOCKED",
          };
        }
        const hardGateFailures = Array.isArray(
          context.taskResult?.canonical_hard_gate_failures,
        )
          ? context.taskResult.canonical_hard_gate_failures
          : [];
        if (hardGateFailures.length > 0) {
          return {
            canonical_verdict:
              hardGateFailures.find((failure) =>
                failure.verdict_class === "NEEDS_ESCALATION")?.verdict_class
              ?? hardGateFailures.find((failure) =>
                failure.verdict_class === "ENV_BLOCK")?.verdict_class
              ?? hardGateFailures[0].verdict_class
              ?? "EVIDENCE_GAP",
            evidence_items: hardGateFailures.map((failure) => ({
              content: JSON.stringify(failure),
              source: `hard-gate:${failure.gate_id ?? "unknown"}`,
              type: "hard_gate_failure",
            })),
            hard_failures: hardGateFailures,
            ok: false,
            reason: "one or more budget, documentation, or role policy gates failed",
            results: [],
            source: "canonical_hard_gate",
            terminal_stage: "BLOCKED",
          };
        }
        const securityScan = policy.scanSecuritySurfaces({
          surfaceType: "code_review",
          surfaces: policy.codeChangesToSurfaces(diff.full_diff),
        });
        const blockingSecurityFindings = securityScan.findings.filter(
          (finding) => finding.blocking,
        );
        if (blockingSecurityFindings.length > 0) {
          return {
            canonical_verdict: "NEEDS_ESCALATION",
            evidence_items: [{
              content: JSON.stringify({
                findings: blockingSecurityFindings,
                summary: securityScan.summary,
              }),
              source: "security-scan:task-delta",
              type: "security_scan",
            }],
            hard_failures: blockingSecurityFindings,
            ok: false,
            reason: "the deterministic task-delta security scan found blocking findings",
            results: [],
            source: "security_gate",
            terminal_stage: "BLOCKED",
          };
        }
        const acceptanceCommands =
          artifact?.acceptance_commands
          ?? artifact?.derived_task?.acceptance_commands
          ?? agentTickTask?.acceptance_commands
          ?? [];
        const roleAcceptanceCommands = roleQualityGatesToAcceptanceCommands(
          context.taskResult?.role_quality_gates,
        );
        const report = await runLifecycleAcceptanceCommands({
          acceptanceCommands: [
            ...roleAcceptanceCommands,
            ...acceptanceCommands,
          ],
          context: {
            abortSignal: context.abortSignal,
            deniedReadRoots: resolveExecutorDeniedReadRoots(plan.stateRoot),
            timeoutMs: context.timeoutMs,
            workspacePath: context.workspacePath,
          },
        });
        const afterGateDiff = attemptWorktree.captureAttemptWorktreeDiff({
          sidecarPath: paths.sidecar_path,
        });
        if (
          protectedStateDigest
          !== computeProtectedStateDigest(plan.stateRoot)
        ) {
          return {
            ...report,
            canonical_verdict: "ENV_BLOCK",
            ok: false,
            reason: "an acceptance command changed protected canonical state",
            source: "protected_state_gate",
            terminal_stage: "BLOCKED",
          };
        }
        if (
          afterGateDiff.task_snapshot_sha256 !== diff.task_snapshot_sha256
          || afterGateDiff.has_committed_changes
        ) {
          return {
            ...report,
            canonical_verdict: "DEFECT",
            ok: false,
            reason: "an acceptance command changed or committed the task delta",
            source: "acceptance_command_integrity_gate",
            task_snapshot_sha256: afterGateDiff.task_snapshot_sha256,
            terminal_stage: "BLOCKED",
          };
        }
        const afterGateSecurityScan = policy.scanSecuritySurfaces({
          surfaceType: "code_review",
          surfaces: policy.codeChangesToSurfaces(afterGateDiff.full_diff),
        });
        const afterGateBlockingFindings = afterGateSecurityScan.findings.filter(
          (finding) => finding.blocking,
        );
        if (afterGateBlockingFindings.length > 0) {
          return {
            ...report,
            canonical_verdict: "NEEDS_ESCALATION",
            hard_failures: [
              ...(report.hard_failures ?? []),
              ...afterGateBlockingFindings,
            ],
            ok: false,
            reason: "the post-command task-delta security scan found blocking findings",
            security_scan: afterGateSecurityScan,
            source: "security_gate",
            task_snapshot_sha256: afterGateDiff.task_snapshot_sha256,
            terminal_stage: "BLOCKED",
          };
        }
        return {
          ...report,
          evidence_items: [
            {
              content: JSON.stringify({
                blocking_findings: 0,
                finding_count: securityScan.findings.length,
              }),
              source: "security-scan:task-delta",
              type: "security_scan",
            },



            ...(Array.isArray(context.taskResult?.context_contract_evidence)
              ? context.taskResult.context_contract_evidence
              : []),
            ...(report.evidence_items ?? []),
          ],
          security_scan: afterGateSecurityScan,
          task_snapshot_sha256: afterGateDiff.task_snapshot_sha256,
        };
      },
      reviewTask: (context) => reviewLifecycleAcceptanceEvidence({
        artifact,
        context,
        stateRoot: plan.stateRoot,
        taskId,
        taskResult: context.taskResult,
      }),
      sandboxPolicy,
      store: lifecycleStore,
      taskId,
      timeoutMs: lifecycleTimeoutMs,
      trigger: intendedTrigger,
      abortSignal: lifecycleAbortController.signal,
    });
    if (
      lifecycleResult.stage !== "FINISHED"
      && lifecycleResult.state?.workspace?.sidecar_path
    ) {
      reliabilityRc.finalizeReliabilityRcAttemptWorkspace({
        canonicalVerdict: lifecycleResult.canonical_verdict,
        promoted: false,
        reason:
          lifecycleResult.state?.terminal?.reason
          ?? `attempt stopped at ${lifecycleResult.stage}`,
        sidecarPath: lifecycleResult.state.workspace.sidecar_path,
      });
    }
    await finalizeLifecycleQueue({
      claimHolder: queueClaimHolder,
      lifecycleResult,
      store: lifecycleStore,
      taskId,
    });
    await reconcileFileQueueProjection({
      applyPending: true,
      stateRoot: plan.stateRoot,
      store: lifecycleStore,
    });
    await synchronizeTaskStatusFromLifecycleResult({
      databasePath: plan.databasePath,
      lifecycleResult,
      taskId,
    });
    await scheduleBoundedAutoRepairForQueueEntry({
      approvedPlan,
      databasePath: plan.databasePath,
      queueEntry: await lifecycleStore.queue.byTask(taskId),
      stateRoot: plan.stateRoot,
      store: lifecycleStore,
      workspaceRoot,
    });
    return lifecycleResult;
  } catch (error) {
    if (effectiveAttemptId) {
      try {
        const currentAttempt = await lifecycleStore.attempts.byId(effectiveAttemptId);
        if (
          currentAttempt
          && TERMINAL_LIFECYCLE_ATTEMPT_STAGES.has(currentAttempt.stage)
          && currentAttempt.stage !== "FINISHED"
        ) {
          const paths = attemptWorktree.createAttemptWorktreePaths({
            attemptId: effectiveAttemptId,
            stateRoot: plan.stateRoot,
            taskId,
          });
          const sidecar = attemptWorktree.readAttemptWorktreeSidecar(
            paths.sidecar_path,
          );
          const promotion = await lifecycleStore.promotions.byAttempt(
            currentAttempt.id,
          );
          if (sidecar && sidecar.status !== "REMOVED") {
          reliabilityRc.finalizeReliabilityRcAttemptWorkspace({
              canonicalVerdict: currentAttempt.canonical_verdict,
              promoted: promotion?.status === "PROMOTED",
              reason:
                currentAttempt.state?.terminal?.reason
                ?? `lifecycle error: ${error instanceof Error ? error.message : String(error)}`,
            sidecarPath: paths.sidecar_path,
          });
          }
        }
      } catch (persistenceError) {
        process.stderr.write(
          `[niis] Warning: failed to preserve terminal lifecycle state for ${taskId}: `
          + `${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}\n`,
        );
      }
    }
    throw error;
  } finally {
    if (cancellationPollTimer) clearInterval(cancellationPollTimer);
    if (cancellationPollPromise) {
      await cancellationPollPromise.catch(() => {});
    }
    clearTimeout(timeoutHandle);
    abortSignal?.removeEventListener?.("abort", abortLifecycle);
    process.off("SIGINT", abortLifecycle);
    process.off("SIGTERM", abortLifecycle);
    lifecycleStore.close();
  }
}

async function readApprovedPlan({
  databasePath,
  stateRoot,
  taskId,
}) {
  const sqliteStorage = storage.createSqliteStorage({
    databasePath,
    readonly: true,
  });
  try {
    const approval = (await sqliteStorage.approvals.byTask(taskId)).find((entry) =>
      entry.action_id === `plan:${taskId}`
      && entry.status === "APPROVED"
      && typeof entry.approved_at === "string") ?? null;
    if (!approval) return null;
    const task = (await sqliteStorage.tasks.list())
      .find((entry) => entry.id === taskId) ?? null;
    if (!task) return null;
    let artifact;
    try {
      artifact = taskIntake.readTaskIntakeArtifact({ stateRoot, taskId });
    } catch {
      return null;
    }
    const digest = createPlanApprovalDigest({
      artifact,
      runtimePreferences: taskIntake.readRuntimePreferences({
        stateRoot,
        taskId,
      }),
      task,
    });
    return hasPlanApprovalDigest(approval, digest)
      ? Object.freeze({
          ...approval,
          plan_digest: digest,
        })
      : null;
  } finally {
    sqliteStorage.close();
  }
}

async function readTaskRetryPolicyState({
  databasePath,
  taskId,
  workspaceRoot,
}) {
  const sqliteStorage = storage.createSqliteStorage({
    databasePath,
    readonly: true,
  });
  let task = null;
  let activeBlockerCount = 0;
  try {
    task = (await sqliteStorage.tasks.list())
      .find((entry) => entry.id === taskId) ?? null;
    activeBlockerCount = (await sqliteStorage.blockers.active())
      .filter((entry) => entry.task_id === taskId).length;
  } finally {
    sqliteStorage.close();
  }

  const lifecycleStore = storage.createLifecycleSqliteStore({
    databasePath,
    readonly: true,
  });
  let attempts = [];
  try {
    attempts = await lifecycleStore.attempts.listByTask(taskId);
  } finally {
    lifecycleStore.close();
  }

  return Object.freeze({
    activeBlockerCount,
    attempts: Object.freeze(attempts),
    maxRejections: task?.max_rejections ?? null,
    maxRetryAttempts: getAutoRepairConfig({ workspaceRoot }).max_attempts,
    rejectionCount: task?.rejection_count ?? null,
    retryAttemptCount: countRetryAttempts(attempts),
    task,
  });
}

function attachBoundedRepairContext(artifact, priorAttempt) {
  if (!artifact || !priorAttempt) return artifact;
  const verdict = priorAttempt.canonical_verdict ?? "unknown";
  const reason = String(
    priorAttempt.state?.review?.reason
    ?? priorAttempt.state?.gates?.reason
    ?? priorAttempt.last_error
    ?? "No prior failure reason was recorded.",
  ).slice(0, 2_000);
  const previousGuides = Array.isArray(artifact.reference_bundle?.guides)
    ? artifact.reference_bundle.guides
    : [];
  return {
    ...artifact,
    reference_bundle: {
      ...(artifact.reference_bundle ?? {}),
      guides: [
        ...previousGuides,
        {
          content: `Bounded repair attempt. The immutable prior attempt ${priorAttempt.id} ended with ${verdict}: ${reason}`,
          provenance: { source_ref: String(priorAttempt.id ?? "prior-attempt"), source_type: "prior_attempt" },
        },
        {
          content: "Repair the prior finding without expanding the approved task scope.",
          provenance: { source_ref: String(priorAttempt.id ?? "prior-attempt"), source_type: "prior_attempt" },
        },
      ],
    },
  };
}

function attachQueuedAutoRepairContext({
  approvedPlanDigest,
  artifact,
  attempts,
  boundAttempt = null,
  queueEntry,
}) {
  const priorAttempt = resolveAutoRepairPriorAttempt({
    approvedPlanDigest,
    attempts,
    boundAttempt,
    queueEntry,
  });
  return Object.freeze({
    artifact: priorAttempt
      ? attachBoundedRepairContext(artifact, priorAttempt)
      : artifact,
    priorAttempt,
  });
}

async function assertQueuedAutoRepairClaimPolicy({
  databasePath,
  queueEntry,
  workspaceRoot,
}) {
  if (!parseAutoRepairEnvelope(queueEntry)) return null;
  const sqliteStorage = storage.createSqliteStorage({
    databasePath,
    readonly: true,
  });
  let task = null;
  let activeBlockerCount = 0;
  try {
    task = (await sqliteStorage.tasks.list())
      .find((entry) => entry.id === queueEntry.task_id) ?? null;
    activeBlockerCount = (await sqliteStorage.blockers.active())
      .filter((entry) => entry.task_id === queueEntry.task_id).length;
  } finally {
    sqliteStorage.close();
  }
  return assertAutoRepairClaimPolicy({
    activeBlockerCount,
    config: getAutoRepairConfig({ workspaceRoot }),
    queueEntry,
    task,
  });
}

async function readBoundedAutoRepairDecision({
  approvedPlan = null,
  databasePath,
  queueEntry,
  store,
  workspaceRoot,
}) {
  if (!queueEntry || !store) {
    return Object.freeze({
      eligible: false,
      reason: "policy_state_unavailable",
    });
  }
  const sqliteStorage = storage.createSqliteStorage({
    databasePath,
    readonly: true,
  });
  let task = null;
  let activeBlockerCount = 0;
  try {
    task = (await sqliteStorage.tasks.list())
      .find((entry) => entry.id === queueEntry.task_id) ?? null;
    activeBlockerCount = (await sqliteStorage.blockers.active())
      .filter((entry) => entry.task_id === queueEntry.task_id).length;
  } finally {
    sqliteStorage.close();
  }
  const attempts = await store.attempts.listByTask(queueEntry.task_id);
  const priorAttempt = attempts.at(-1) ?? null;
  const promotionRecord = priorAttempt
    ? await store.promotions.byAttempt(priorAttempt.id)
    : null;
  const currentApproval = approvedPlan ?? await readApprovedPlan({
    databasePath,
    stateRoot: createInitPlan(workspaceRoot).stateRoot,
    taskId: queueEntry.task_id,
  });
  return resolveBoundedAutoRepairDecision({
    activeBlockerCount,
    approvedPlanDigest: currentApproval?.plan_digest ?? null,
    attempts,
    config: getAutoRepairConfig({ workspaceRoot }),
    planApproved: Boolean(currentApproval),
    promotionRecord,
    queueEntry,
    task,
  });
}

async function synchronizeTaskStatusForAutoRepair({
  databasePath,
  decision,
  taskId,
}) {
  const sqliteStorage = storage.createSqliteStorage({ databasePath });
  try {
    const task = (await sqliteStorage.tasks.list())
      .find((entry) => entry.id === taskId) ?? null;
    if (!task || task.status === "PENDING") return task;
    if (!["BLOCKED", "REJECTED"].includes(task.status)) return task;
    const pending = taskIntake.transitionTaskStatus(task, {
      actor: "task-attempt:auto-repair",
      now: getSystemNow(),
      reason:
        `Queued bounded repair ${decision.sequence}/${decision.max_attempts} `
        + `after immutable attempt ${decision.prior_attempt_id}.`,
      status: "PENDING",
    });
    await sqliteStorage.tasks.upsert(pending);
    return pending;
  } finally {
    sqliteStorage.close();
  }
}

async function scheduleBoundedAutoRepairForQueueEntry({
  approvedPlan = null,
  databasePath,
  queueEntry,
  stateRoot,
  store,
  workspaceRoot,
}) {
  const current = await store.queue.byTask(queueEntry?.task_id);
  if (!current || current.state !== "BLOCKED") {
    return Object.freeze({
      decision: Object.freeze({
        eligible: false,
        reason: "queue_not_repairable",
      }),
      entry: current,
      scheduled: false,
    });
  }
  const decision = await readBoundedAutoRepairDecision({
    approvedPlan,
    databasePath,
    queueEntry: current,
    store,
    workspaceRoot,
  });
  if (!decision.eligible) {
    return Object.freeze({
      decision,
      entry: current,
      scheduled: false,
    });
  }
  const entry = await store.queue.transition({
    expectedState: "BLOCKED",
    nextState: "PENDING",
    payloadPatch: createAutoRepairQueuePayloadPatch({
      decision,
      now: getSystemNow(),
    }),
    taskId: current.task_id,
  });




  try {
    await synchronizeTaskStatusForAutoRepair({
      databasePath,
      decision,
      taskId: current.task_id,
    });
  } catch (error) {
    process.stderr.write(
      `[niis] Warning: failed to project auto-repair task status for `
      + `${current.task_id}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  try {
    await reconcileFileQueueProjection({
      applyPending: true,
      stateRoot,
      store,
    });
  } catch (error) {
    process.stderr.write(
      `[niis] Warning: failed to project auto-repair queue entry for `
      + `${current.task_id}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  return Object.freeze({
    decision,
    entry,
    scheduled: true,
  });
}

async function reconcileEligibleAutoRepairs({
  databasePath,
  stateRoot,
  store,
  workspaceRoot,
}) {
  const config = getAutoRepairConfig({ workspaceRoot });
  if (config.enabled !== true) {
    return Object.freeze({
      scheduled: Object.freeze([]),
    });
  }
  const scheduled = [];
  for (const queueEntry of await store.queue.list()) {
    if (queueEntry.state !== "BLOCKED") continue;
    const result = await scheduleBoundedAutoRepairForQueueEntry({
      databasePath,
      queueEntry,
      stateRoot,
      store,
      workspaceRoot,
    });
    if (result.scheduled) {
      scheduled.push(Object.freeze({
        prior_attempt_id: result.decision.prior_attempt_id,
        sequence: result.decision.sequence,
        task_id: queueEntry.task_id,
      }));
    }
  }
  return Object.freeze({
    scheduled: Object.freeze(scheduled),
  });
}

async function runApprovePlan(args = []) {
  const taskId = resolveFlagValue(args, "--task-id");
  if (!taskId) {
    throw new Error("task id is required via --task-id");
  }
  const workspaceRoot = resolveWorkspaceRoot();
  const plan = createInitPlan(workspaceRoot);
  if (!fs.existsSync(plan.databasePath)) {
    throw new Error("state database is missing; run `init` first");
  }
  const taskStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
    readonly: true,
  });
  let task = null;
  try {
    task = (await taskStorage.tasks.list()).find((entry) => entry.id === taskId) ?? null;
  } finally {
    taskStorage.close();
  }
  if (!task) {
    throw new Error(`task not found: ${taskId}`);
  }
  if (task.status !== "PENDING") {
    throw new Error(
      `task ${taskId} must be PENDING before plan approval; current status is ${task.status}`,
    );
  }

  const note = resolveFlagValue(args, "--note")
    ?? "Plan approved for supervised execution from the CLI.";
  const approval = await applyUiApprovalDecision({
    approvalId: `${taskId}:plan-approval`,
    blockerId: `plan:${taskId}`,
    decision: "approve",
    note,
    taskId,
    workspaceRoot,
  });
  await enqueueLifecycleTask({
    databasePath: plan.databasePath,
    metadata: {
      approved_by: "operator",
      plan_approval_id: approval.id,
    },
    priority: task.priority ?? "medium",
    stateRoot: plan.stateRoot,
    taskId,
  });
  console.log(JSON.stringify({
    approval,
    next_command: `niis start-task --task-id ${taskId}`,
    task_id: taskId,
  }, null, 2));
}

async function runStartTask(args = []) {
  const taskId = resolveFlagValue(args, "--task-id");

  if (!taskId) {
    throw new Error("task id is required via --task-id");
  }

  const workspaceRoot = resolveWorkspaceRoot();
  const plan = createInitPlan(workspaceRoot);

  if (!fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }
  const cancellationRecovery = await recoverDurableLifecycleCancellations({
    databasePath: plan.databasePath,
    stateRoot: plan.stateRoot,
    taskId,
  });
  if (cancellationRecovery.finalized.length > 0) {
    const recovered = cancellationRecovery.finalized[0];
    if (process.env[UI_BACKGROUND_ENV] === "1") {
      process.stderr.write(
        `[niis-ui] Recovered cancellation for ${taskId} before execution.\n`,
      );
    } else {
      console.log(JSON.stringify({
        lifecycle: recovered.lifecycle,
        recovered_cancellation: true,
      }, null, 2));
    }
    return recovered.lifecycle;
  }
  if (cancellationRecovery.pending.length > 0) {
    const pending = cancellationRecovery.pending[0];
    throw lifecycleQueueClaimError(
      `task ${taskId} has pending cancellation request ${pending.cancel_request_id}`,
      "lifecycle_cancellation_pending",
      {
        cancel_request_id: pending.cancel_request_id,
        pid: pending.pid,
      },
    );
  }
  await reconcileLifecycleCompatibilityStatuses({
    databasePath: plan.databasePath,
    taskId,
  });
  const approvedPlan = await readApprovedPlan({
    databasePath: plan.databasePath,
    stateRoot: plan.stateRoot,
    taskId,
  });
  if (!approvedPlan) {
    throw new Error(
      `task ${taskId} has no approved plan; run \`niis approve-plan --task-id ${taskId}\` before start-task`,
    );
  }

  const requestedTriggerFlag = resolveFlagValue(args, "--trigger");
  let requestedTrigger = requestedTriggerFlag ?? "cli";
  let requestedAttemptId = resolveFlagValue(args, "--attempt-id");
  const retryPolicyState = await readTaskRetryPolicyState({
    databasePath: plan.databasePath,
    taskId,
    workspaceRoot,
  });
  if (!retryPolicyState.task) {
    throw new Error(`task not found: ${taskId}`);
  }
  const activeAttempt = retryPolicyState.attempts.find((attempt) =>
    !["BLOCKED", "CANCELLED", "FAILED", "FINISHED"].includes(attempt.stage)) ?? null;
  if (
    activeAttempt
    && requestedAttemptId
    && requestedAttemptId !== activeAttempt.id
  ) {
    throw new UiLifecycleActionError(
      `Task ${taskId} already has active attempt ${activeAttempt.id}`,
      { code: "attempt_concurrency_conflict" },
    );
  }
  if (
    activeAttempt
    && requestedTriggerFlag
    && requestedTriggerFlag !== activeAttempt.trigger
  ) {
    throw new UiLifecycleActionError(
      `Active attempt ${activeAttempt.id} must resume with trigger ${activeAttempt.trigger}`,
      { code: "attempt_identity_mismatch" },
    );
  }
  if (activeAttempt) {
    requestedAttemptId = activeAttempt.id;
    requestedTrigger = activeAttempt.trigger;
  }
  if (
    !activeAttempt
    && !["PENDING", "BLOCKED", "REJECTED"].includes(retryPolicyState.task.status)
  ) {
    throw new UiLifecycleActionError(
      `Execution is not allowed while task status is ${retryPolicyState.task.status}`,
      { code: "invalid_lifecycle_action" },
    );
  }
  const isRetryExecution = !activeAttempt && (
    ["BLOCKED", "REJECTED"].includes(retryPolicyState.task.status)
    || (
      retryPolicyState.task.status === "PENDING"
      && retryPolicyState.attempts.length > 0
    )
  );
  if (isRetryExecution) {
    assertRetryLifecyclePolicy({
      activeBlockerCount: retryPolicyState.activeBlockerCount,
      maxRejections: retryPolicyState.maxRejections,
      maxRetryAttempts: retryPolicyState.maxRetryAttempts,
      planApproved: true,
      rejectionCount: retryPolicyState.rejectionCount,
      retryAttemptCount: retryPolicyState.retryAttemptCount,
    });
    if (
      requestedAttemptId
      && retryPolicyState.attempts.some((attempt) => attempt.id === requestedAttemptId)
    ) {
      throw new UiLifecycleActionError(
        `Retry attempt id must be new; ${requestedAttemptId} already exists`,
        { code: "retry_attempt_must_be_new" },
      );
    }
    requestedAttemptId ??= `attempt:${randomUUID()}`;
    requestedTrigger = requestedTriggerFlag ?? "cli-retry";
  }
  const queueClaimHolder =
    process.env[PROJECT_EXECUTION_LEASE_ENV]
    ?? `start-task:${process.pid}:${randomUUID()}`;
  const projectExecutionLease = await acquireProjectExecutionLease({
    holder: queueClaimHolder,
    stateRoot: plan.stateRoot,
  });
  let queueStore = null;
  let claimHeartbeatError = null;
  let claimHeartbeatTimer = null;
  let ownsQueueClaim = false;

  try {
    queueStore = storage.createLifecycleSqliteStore({
      databasePath: plan.databasePath,
    });
    await enqueueLifecycleTask({
      databasePath: plan.databasePath,
      metadata: {
        requeued_by: `cli:${requestedTrigger}`,
      },
      priority: "medium",
      stateRoot: plan.stateRoot,
      taskId,
    });
    await reconcileFileQueueProjection({
      applyPending: true,
      stateRoot: plan.stateRoot,
      store: queueStore,
    });
    await claimSpecificLifecycleTask({
      holder: projectExecutionLease.holder,
      store: queueStore,
      taskId,
    });
    ownsQueueClaim = true;
    await reconcileFileQueueProjection({
      applyPending: true,
      stateRoot: plan.stateRoot,
      store: queueStore,
    });
    claimHeartbeatTimer = setInterval(() => {
      if (claimHeartbeatError) return;
      queueStore.queue.heartbeatClaim({
        holder: projectExecutionLease.holder,
        taskId,
        ttlMs: LIFECYCLE_QUEUE_CLAIM_TTL_MS,
      }).catch((error) => {
        claimHeartbeatError = error;
      });
    }, LIFECYCLE_QUEUE_HEARTBEAT_MS);
    claimHeartbeatTimer.unref?.();



    let agentTickTask = null;
    const previewStorage = storage.createSqliteStorage({
      databasePath: plan.databasePath,
      readonly: true,
    });
    try {
      const allTasks = await previewStorage.tasks.list();
      const candidate = allTasks.find((task) => task.id === taskId);
      if (candidate?.task_kind === "agent_tick") {
        agentTickTask = candidate;
      }
    } finally {
      previewStorage.close?.();
    }

    try {
      await sweepStaleWorktreesForWorkspace({
        databasePath: plan.databasePath,
        stateRoot: plan.stateRoot,
        workspaceRoot,
      });
    } catch (error) {
      process.stderr.write(`[niis] Worktree sweep failed (non-fatal): ${error.message}\n`);
    }

    let artifact = null;
    let effectiveExecutorRuntime = null;
    if (!agentTickTask) {
      const executorRuntimeFlag = parseExecutorRuntimeFlag(args);
      const plannerRuntimeFlag = parsePlannerRuntimeFlag(args);


      const savedPrefs = taskIntake.readRuntimePreferences({
        stateRoot: plan.stateRoot,
        taskId,
      });
      effectiveExecutorRuntime = executorRuntimeFlag ?? savedPrefs.executor_runtime ?? null;
      const effectivePlannerRuntime = plannerRuntimeFlag ?? savedPrefs.planner_runtime ?? null;
      artifact = await ensureTaskIntakeArtifact({
        databasePath: plan.databasePath,
        executorRuntime: effectiveExecutorRuntime,
        plannerRuntime: effectivePlannerRuntime,
        stateRoot: plan.stateRoot,
        taskId,
        workspaceRoot,
      });
      if (isRetryExecution) {
        const priorAttempt = [...retryPolicyState.attempts]
          .reverse()
          .find((attempt) =>
            ["BLOCKED", "CANCELLED", "FAILED", "FINISHED"].includes(attempt.stage));
        artifact = attachBoundedRepairContext(artifact, priorAttempt);
      }
    }

    const lifecycleResult = await executeTaskViaLifecycle({
      agentTickTask,
      artifact,
      attemptId: requestedAttemptId,
      executorRuntime: effectiveExecutorRuntime,
      plan,
      promotionFailAfterStep: resolveTestPromotionFailureStep(),
      queueClaimHolder: projectExecutionLease.holder,
      taskId,
      trigger: requestedTrigger,
      workspaceRoot,
    });
    if (claimHeartbeatTimer) {
      clearInterval(claimHeartbeatTimer);
      claimHeartbeatTimer = null;
    }
    const finalizedQueueEntry = await queueStore.queue.byTask(taskId);
    ownsQueueClaim =
      finalizedQueueEntry?.state === "CLAIMED"
      && finalizedQueueEntry.claimed_by === projectExecutionLease.holder;
    if (claimHeartbeatError) {
      if (ownsQueueClaim) {
        throw claimHeartbeatError;
      }
    }
    ownsQueueClaim = false;
    const taskResult = taskResultFromAttempt(lifecycleResult);

    if (process.env[UI_BACKGROUND_ENV] === "1") {
      console.error(
        `[niis-ui] Task ${taskId} lifecycle finished at ${lifecycleResult.stage}`
        + ` with ${lifecycleResult.canonical_verdict ?? "no verdict"}.`,
      );
      return;
    }

    console.log(JSON.stringify({
      ...(taskResult ?? {}),
      lifecycle: lifecycleResult,
    }, null, 2));
  } catch (error) {
    if (ownsQueueClaim) {
      let disposition = null;
      try {
        disposition = await settleOwnedLifecycleQueueClaimAfterError({
          attemptId: requestedAttemptId,
          error,
          holder: projectExecutionLease.holder,
          stateRoot: plan.stateRoot,
          store: queueStore,
          taskId,
        });
      } catch (claimError) {
        process.stderr.write(
          `[niis] Warning: failed to settle durable queue claim for ${taskId}: `
          + `${claimError instanceof Error ? claimError.message : String(claimError)}\n`,
        );
      }
      try {
        if (
          disposition?.kind === "RESUMABLE"
          || disposition?.kind === "CANCELLATION_REQUESTED"
        ) {
          await reconcileLifecycleCompatibilityStatuses({
            databasePath: plan.databasePath,
            taskId,
          });
        } else {
          await synchronizeTaskStatusFromLifecycleResult({
            databasePath: plan.databasePath,
            lifecycleResult:
              disposition?.lifecycleResult
              ?? {
                attempt_id: requestedAttemptId,
                canonical_verdict: null,
                stage: "FAILED",
              },
            taskId,
          });
          if (disposition?.kind !== "TERMINAL") {
            await markTaskExecutionProgressFailure({
              databasePath: plan.databasePath,
              error,
              sessionId: createTaskRunSessionId(taskId),
              stateRoot: plan.stateRoot,
              taskId,
            });
          }
        }
      } catch (progressError) {
        process.stderr.write(
          `[niis] Warning: failed to persist lifecycle error state for ${taskId}: `
          + `${progressError instanceof Error ? progressError.message : String(progressError)}\n`,
        );
      }
      ownsQueueClaim = false;
    }
    throw error;
  } finally {
    if (claimHeartbeatTimer) clearInterval(claimHeartbeatTimer);
    queueStore?.close();
    await projectExecutionLease.release();
  }
}

function runDoctor(args = []) {
  const workspaceRoot = resolveWorkspaceRoot();
  const checks = collectDoctorChecks(packageRoot, {
    workspaceRoot,
  });
  const securityChecks = args.includes("--security")
    ? securityDoctor.collectDoctorSecurityChecks(packageRoot, {
      threatCatalog: policy.DEFAULT_THREAT_CATALOG,
      workspaceRoot,
    })
    : [];
  const allChecks = [...checks, ...securityChecks];
  const hasError = allChecks.some((check) => check.status === "error");

  if (args.includes("--json")) {
    console.log(JSON.stringify({
      checks: allChecks,
      command: "doctor",
      has_error: hasError,
      security_enabled: args.includes("--security"),
      workspace_root: workspaceRoot,
    }, null, 2));
    process.exitCode = hasError ? 1 : 0;
    return;
  }

  console.log(args.includes("--security") ? "Niis bootstrap doctor --security" : "Niis bootstrap doctor");

  for (const check of allChecks) {
    console.log(`- [${check.status}] ${check.id}: ${check.summary}`);
    console.log(`  ${check.details}`);
  }

  process.exitCode = hasError ? 1 : 0;
}

function openCliSecretStore({ createIfMissing = false } = {}) {
  const plan = createInitPlan(resolveWorkspaceRoot());

  if (!createIfMissing && !fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }

  return storage.createLocalSecretStore({
    createIfMissing,
    stateRoot: plan.stateRoot,
  });
}

function resolveSecretValue(args) {
  const directValue = resolveFlagValue(args, "--value");
  const envName = resolveFlagValue(args, "--value-env");

  if (directValue !== null && envName !== null) {
    throw new Error("use either --value or --value-env");
  }

  if (envName !== null) {
    const envValue = process.env[envName];

    if (typeof envValue !== "string" || envValue.length === 0) {
      throw new Error(`environment variable ${envName} is missing or empty`);
    }

    return envValue;
  }

  if (directValue !== null) {
    return directValue;
  }

  throw new Error("secret value is required via --value or --value-env");
}

function runSecretSet(args) {
  const ref = resolveFlagValue(args, "--ref");

  if (!ref) {
    throw new Error("secret ref is required via --ref");
  }

  const secretStore = openCliSecretStore();
  const record = secretStore.putSecret({
    metadata: {
      source_kind: "cli_operator",
    },
    ref,
    value: resolveSecretValue(args),
  });

  console.log("Stored secret ref:");
  console.log(`- ref: ${record.ref}`);
  console.log(`- updated at: ${record.updated_at}`);
}

function runSecretList() {
  const secretStore = openCliSecretStore();
  console.log(JSON.stringify(secretStore.listSecrets(), null, 2));
}














async function rerunValidatorLaneForTask({ taskId, workspaceRoot }) {
  const plan = createInitPlan(workspaceRoot);
  const stateRoot = plan.stateRoot;
  const subtaskProgress = readSubtaskProgress({ stateRoot, taskId });
  if (!subtaskProgress || !Array.isArray(subtaskProgress.subtasks) || subtaskProgress.subtasks.length === 0) {
    return {
      error: "No subtask progress on disk. Re-review currently supports parallel-dispatch tasks only.",
      ok: false,
    };
  }
  const sqliteStorage = storage.createSqliteStorage({ databasePath: plan.databasePath });
  let finalTask = null;
  let aggregated = null;
  try {
    const tasks = await sqliteStorage.tasks.list();
    const persistedTask = tasks.find((task) => task.id === taskId);
    if (!persistedTask) {
      sqliteStorage.close();
      return { error: `Task ${taskId} not found in storage.`, ok: false };
    }
    const reviewSpec = { runLogStateRoot: stateRoot, workspaceRoot };
    const evidenceRuntime = createReviewEvidenceRuntime(reviewSpec);
    const sourceBranch = subtaskProgress.subtasks.find((entry) => entry?.branch?.source_branch)?.branch?.source_branch ?? null;
    const perSubtaskReviews = await Promise.all(subtaskProgress.subtasks.map(async (subtask) => {
      const subtaskTask = { ...persistedTask, id: subtask.id, title: subtask.summary?.slice(0, 80) ?? persistedTask.title };
      const branchName = subtask.branch?.name ?? null;
      const worktreePath = subtask.branch?.worktree_path ?? null;
      const diffEvidence = collectSubtaskDiffEvidence({
        branchName,
        sourceBranch,
        subtaskId: subtask.id,
        workspaceRoot,
        worktreePath,
      });
      const securityScanSurfaces = diffEvidence.rawDiff
        ? policy.codeChangesToSurfaces(diffEvidence.rawDiff)
        : [];
      const seedItems = [];
      if (subtask.summary && subtask.summary.trim() !== "") {
        seedItems.push({
          content: subtask.summary,
          raw_output_ref: null,
          source: `subtask:${subtask.id}`,
          subtask_id: subtask.id,
          type: "subtask_summary",
        });
      }
      for (const item of diffEvidence.items) seedItems.push(item);
      if (branchName && sourceBranch) {
        seedItems.push({
          content: JSON.stringify({ branch_name: branchName, source_branch: sourceBranch, worktree_path: worktreePath }),
          raw_output_ref: null,
          source: `review-target:${subtask.id}`,
          subtask_id: subtask.id,
          type: "review_target",
        });
      }
      const seedEvidencePacket = seedItems.length > 0
        ? {
          authenticity_status: "UNVERIFIED",
          items: seedItems,
          markers: {
            auth_surfaces_attempted: [],
            browser_live_checks: [],
            checked_urls: [],
            runtime_evidence_succeeded: false,
          },
        }
        : null;





      const fakeRunRecord = {
        adapter_id: "rerun",
        agent_id: "cli:rerun-review",
        cost: subtask.cost ?? null,
        finished_at: subtask.finished_at ?? new Date().toISOString(),
        id: `${taskId}:rerun:${subtask.id}:${Date.now()}`,
        run_log: { bytes: 0, ref: null, sha256: "rerun", storage: "inline" },
        started_at: subtask.started_at ?? new Date().toISOString(),
        status: subtask.status === "FAILED" ? "FAILED" : "COMPLETED",
        task_id: taskId,
      };
      const subReview = await policy.runValidatorLane({
        actorRole: "validator",
        evidencePacket: seedEvidencePacket,
        evidenceRuntime,
        executorAgentId: fakeRunRecord.agent_id,
        observedOutcome: {
          completion_confirmed: subtask.status === "DONE",
          environment_blocked: null,
          partial_progress: false,
          security_scan_surfaces: securityScanSurfaces,
          security_surface_type: "code_review",
        },
        policy: {},
        reviewerAgentId: "cli:rerun-review",
        runRecord: fakeRunRecord,
        task: subtaskTask,
        validators: createDefaultValidators(),
      });
      return { subReview, subtaskId: subtask.id };
    }));
    const verdictsForAggregation = perSubtaskReviews.map(({ subReview, subtaskId }) => ({
      ...subReview.final_verdict,
      subtask_id: subtaskId,
    }));
    aggregated = aggregateVerdicts(verdictsForAggregation);
    finalTask = taskIntake.transitionTaskStatus(persistedTask, {
      actor: "cli:rerun-review",
      now: getSystemNow(),
      reason: `Re-review returned ${aggregated.verdict_class}.`,
      status: taskIntake.mapVerdictClassToTaskStatus(aggregated.verdict_class),
    });
    await sqliteStorage.tasks.upsert(finalTask);
    for (const { subReview } of perSubtaskReviews) {
      for (const event of subReview.events ?? []) {
        await sqliteStorage.events.append(event);
      }
      for (const record of subReview.explainability ?? []) {
        await sqliteStorage.explainability.record(record);
      }
      for (const result of subReview.results ?? []) {
        if (result.verdict) {
          await sqliteStorage.verdicts.record(result.verdict);
        }
        if (result.evidence_packet) {
          await sqliteStorage.evidence.savePacket(result.evidence_packet);
        }
      }
    }
  } finally {
    sqliteStorage.close();
  }
  finalizeQueueStateForTask({
    finalTaskStatus: finalTask?.status ?? null,
    stateRoot,
    taskId,
    verdictClass: aggregated?.verdict_class ?? null,
  });
  return {
    final_task: { id: taskId, status: finalTask?.status ?? null },
    final_verdict: aggregated,
    ok: true,
  };
}

function parseOptionalIntegerFlag(args, flagName) {
  const value = resolveFlagValue(args, flagName);

  if (value === null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }

  return parsed;
}

function runBackup(args) {
  const plan = createInitPlan(resolveWorkspaceRoot());

  if (!fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }

  const retentionDays = parseOptionalIntegerFlag(args, "--retention-days");

  if (retentionDays !== null) {
    storage.writeBackupPolicy(plan.stateRoot, {
      retentionDays,
      freshnessWarningDays: storage.readBackupPolicy(plan.stateRoot).freshness_warning_days,
    });
  }

  const result = storage.performBackup(plan.stateRoot, {
    retentionDays,
  });

  console.log("Created local backup:");
  console.log(`- backup id: ${result.backup_id}`);
  console.log(`- backup path: ${result.backup_path}`);
  console.log(`- created at: ${result.created_at}`);
  console.log(`- pruned backups: ${result.pruned.map((entry) => entry.backup_id).join(", ") || "none"}`);
}

function runRestore() {
  const error = new Error(
    "restore is retired in Reliability RC because in-place state replacement "
    + "is not a supervised recovery operation; live state was not modified",
  );
  error.code = "restore_retired_reliability_rc";
  error.status = 410;
  throw error;
}

function resolveSpecPath(args) {
  const [specPath] = args;

  if (!specPath) {
    throw new Error("spec path is required");
  }

  return path.resolve(process.cwd(), specPath);
}

function resolveOptionalSpecPath(args) {
  const [specPath] = args;

  if (!specPath || specPath.startsWith("-")) {
    return null;
  }

  return path.resolve(process.cwd(), specPath);
}

function loadExecutionSpec(specPath) {
  return JSON.parse(fs.readFileSync(specPath, "utf8"));
}

function resolveReviewStateRoot(spec = {}) {
  const explicitStateRoot = spec.runLogStateRoot ?? spec.stateRoot ?? null;

  if (explicitStateRoot) {
    return path.resolve(process.cwd(), explicitStateRoot);
  }

  const defaultStateRoot = createInitPlan(resolveWorkspaceRoot()).stateRoot;
  return fs.existsSync(defaultStateRoot) ? defaultStateRoot : null;
}








function collectSubtaskDiffEvidence({
  branchName,
  sourceBranch,
  subtaskId,
  workspaceRoot,
  worktreePath,
}) {
  const empty = Object.freeze({ items: Object.freeze([]), rawDiff: null });
  if (!sourceBranch || !branchName) return empty;
  const MAX_DIFF_BYTES = 32000;
  const runGit = (args, cwd) => {
    try {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      if (result.status !== 0) return null;
      return typeof result.stdout === "string" ? result.stdout : null;
    } catch {
      return null;
    }
  };
  const collectUntrackedDiff = (cwd) => {
    const status = runGit(["status", "--porcelain", "--untracked-files=all"], cwd);
    if (status === null) return "";
    const untrackedPaths = status
      .split(/\r?\n/)
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim())
      .filter((entry) => entry !== "" && !entry.endsWith(".niis-worktree.json"));
    const chunks = [];
    for (const relativePath of untrackedPaths) {
      try {
        const result = spawnSync(
          "git",
          ["diff", "--no-index", "--", "/dev/null", relativePath],
          {
            cwd,
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
          },
        );
        if (result.status === 0 || result.status === 1) {
          chunks.push(String(result.stdout ?? ""));
        }
      } catch {


      }
    }
    return chunks.join("\n");
  };



  let stat = runGit(["diff", "--stat", `${sourceBranch}..${branchName}`], workspaceRoot);
  let full = stat !== null
    ? runGit(["diff", `${sourceBranch}..${branchName}`], workspaceRoot)
    : null;
  if (worktreePath && fs.existsSync(worktreePath)) {
    const worktreeStat = runGit(["diff", "--stat", sourceBranch], worktreePath);
    const worktreeFull = worktreeStat !== null
      ? runGit(["diff", sourceBranch], worktreePath)
      : null;
    const untrackedDiff = collectUntrackedDiff(worktreePath);
    if (worktreeStat !== null && worktreeFull !== null) {
      stat = worktreeStat;
      full = [worktreeFull, untrackedDiff].filter((value) => value.trim() !== "").join("\n");
    }
  }
  if (stat === null || full === null) return empty;
  if (stat.trim() === "" && full.trim() === "") return empty;
  const truncated = full.length > MAX_DIFF_BYTES
    ? `${full.slice(0, MAX_DIFF_BYTES)}\n\n...(truncated, ${full.length - MAX_DIFF_BYTES} bytes omitted)...`
    : full;
  return Object.freeze({




    items: Object.freeze([Object.freeze({
      content: `git diff --stat ${sourceBranch}..${branchName}\n${stat}\n\ngit diff ${sourceBranch}..${branchName}\n${truncated}`,
      raw_output_ref: null,
      source: `git-diff:${subtaskId}`,
      subtask_id: subtaskId,
      type: "git_diff",
    })]),
    rawDiff: full,
  });
}

function buildLlmReviewPrompt({ acceptance, brief, diffs = [], outOfScope, summaries, title }) {
  const parts = [
    "You are a strict acceptance-criteria reviewer for a software engineering task.",
    "Your job: decide if the agent's work SATISFIES the operator's acceptance criteria.",
    "Be conservative — if you are not sure, answer EVIDENCE_GAP rather than PASS.",
    "",
    `Task title: ${title ?? "(untitled)"}`,
    "",
    "Operator brief (what the operator asked for):",
    brief ?? "(no brief recorded)",
    "",
    "Acceptance criteria (what MUST be true to accept the work):",
    acceptance ?? "(none explicitly listed — infer from the brief and agent report)",
    "",
  ];
  if (Array.isArray(outOfScope) && outOfScope.length > 0) {
    parts.push("Out of scope (the agent MUST NOT do these):");
    for (const item of outOfScope) parts.push(`- ${item}`);
    parts.push("");
  }
  parts.push("Agent self-reports (what the agent claims was done):");
  for (let i = 0; i < summaries.length; i += 1) {
    const entry = summaries[i];
    const header = entry.subtask_id
      ? `--- Summary ${i + 1} (${entry.source}, subtask ${entry.subtask_id}) ---`
      : `--- Summary ${i + 1} (${entry.source}) ---`;
    parts.push(header);
    parts.push(entry.content);
    parts.push("");
  }
  if (Array.isArray(diffs) && diffs.length > 0) {
    parts.push("Actual code changes (`git diff <source>..<branch>`) — trust THIS over the self-report when they disagree:");
    for (let i = 0; i < diffs.length; i += 1) {
      const entry = diffs[i];
      const header = entry.subtask_id
        ? `--- Diff ${i + 1} (subtask ${entry.subtask_id}) ---`
        : `--- Diff ${i + 1} ---`;
      parts.push(header);
      parts.push(entry.content);
      parts.push("");
    }
  }
  parts.push(
    "Return your verdict as a STRICT JSON object on the LAST line of your response (no prose after it):",
    '{"verdict": "PASS" | "DEFECT" | "EVIDENCE_GAP", "reason": "<one sentence why>", "next_action": "<operator hint>"}',
    "",
    "Rules:",
    "- PASS: acceptance criteria clearly satisfied by the diff, no obvious gaps.",
    "- DEFECT: diff is empty / wrong files / missed a stated requirement / agent claimed something the diff does not show.",
    "- EVIDENCE_GAP: summary+diff do not contain enough information to decide; operator should inspect manually.",
  );
  return parts.join("\n");
}

function parseReviewerVerdictFromSummary(summary) {
  const text = typeof summary === "string" ? summary : "";
  const match = text.match(/\{[^{}]*"verdict"\s*:\s*"[^"]+"[^{}]*\}/);
  if (!match) {
    return { next_action: "Review reviewer output manually.", reason: "Reviewer did not return a parseable JSON verdict.", verdict: "EVIDENCE_GAP" };
  }
  try {
    return JSON.parse(match[0]);
  } catch {
    return { next_action: "Review reviewer output manually.", reason: "Reviewer JSON failed to parse.", verdict: "EVIDENCE_GAP" };
  }
}

function buildAdversarialReviewPrompt({ acceptance, brief, outOfScope, reviewTarget, title }) {
  const parts = [
    "You are a strict code reviewer. A git worktree has been prepared at your current working directory.",
    "HEAD is DETACHED — any edits or commits you make here are thrown away after the review, so you can freely `git checkout`, `git stash`, run scripts, touch files; nothing persists back to the real branch.",
    "",
    `Task title: ${title ?? "(untitled)"}`,
    "",
    "Operator brief (what the operator asked for):",
    brief ?? "(no brief recorded)",
    "",
    "Acceptance criteria (what MUST be true to accept the work):",
    acceptance ?? "(none explicitly listed — infer from the brief)",
    "",
  ];
  if (Array.isArray(outOfScope) && outOfScope.length > 0) {
    parts.push("Out of scope (agent MUST NOT have done these):");
    for (const item of outOfScope) parts.push(`- ${item}`);
    parts.push("");
  }
  if (reviewTarget?.source_branch && reviewTarget?.branch_name) {
    parts.push(
      `Subtask branch: ${reviewTarget.branch_name}`,
      `Source branch: ${reviewTarget.source_branch}`,
      `Key commands to get started:`,
      `  git log --oneline ${reviewTarget.source_branch}..HEAD`,
      `  git diff --stat ${reviewTarget.source_branch}`,
      `  git diff ${reviewTarget.source_branch} -- <file>`,
      "",
    );
  }
  parts.push(
    "Your job:",
    "1. Inspect the actual changes (`git diff`, read files, run tests/linters if useful).",
    "2. Decide whether the changes clearly satisfy every acceptance criterion.",
    "3. Verify nothing out-of-scope was done and no existing behavior is broken.",
    "",
    "Be conservative — if you are not sure, return EVIDENCE_GAP rather than PASS.",
    "",
    "When finished, output your verdict on the LAST line of your response as STRICT JSON (no prose after it):",
    '{"verdict": "PASS" | "DEFECT" | "EVIDENCE_GAP", "reason": "<one sentence why>", "next_action": "<operator hint>"}',
    "",
    "Rules:",
    "- PASS: changes clearly meet every acceptance criterion, nothing out-of-scope, no obvious regressions.",
    "- DEFECT: a criterion is missed, wrong files changed, tests fail, agent claimed something the code does not show, or out-of-scope work is present.",
    "- EVIDENCE_GAP: you could not gather enough information to decide; operator must inspect manually.",
  );
  return parts.join("\n");
}





async function runAdversarialReview({
  acceptance,
  brief,
  deniedReadRoots = null,
  modelPreference,
  outOfScope,
  reviewTarget,
  runtime,
  signal = null,
  timeoutMs = null,
  title,
  workspaceRoot,
}) {
  if (
    !reviewTarget?.worktree_path
    || !fs.existsSync(reviewTarget.worktree_path)
  ) {
    return {
      next_action: "Inspect the retained attempt worktree manually.",
      reason: "No materialized attempt worktree is available for adversarial review.",
      verdict: "EVIDENCE_GAP",
    };
  }
  const worktreePath = fs.realpathSync(reviewTarget.worktree_path);
  const repositoryCheck = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  if (repositoryCheck.status !== 0) {
    return {
      next_action: "Inspect the retained attempt worktree manually.",
      reason: "The adversarial review target is not a Git worktree.",
      verdict: "EVIDENCE_GAP",
    };
  }
  const prompt = buildAdversarialReviewPrompt({
    acceptance,
    brief,
    outOfScope,
    reviewTarget,
    title,
  });
  const exec = runtime.runtimeId === "codex_local"
    ? resolveCodexExecutor()
    : runClaudeExecution;
  const result = await exec({
    commandPath: runtime.commandPath,
    deniedReadRoots,
    ...(runtime.runtimeId === "claude_code_local"
      ? {
          permissionMode: "dontAsk",
        }
      : {
          approvalPolicy: "never",
          sandbox: "read-only",
        }),
    modelPreference,
    prompt,
    signal,
    timeoutMs,
    workspaceRoot: worktreePath,
  });
  return parseReviewerVerdictFromSummary(result?.summary);
}

function createLlmReviewer({
  workspaceRoot,
  deniedReadRoots = null,
  executorAdapterId = null,
  modelPreferences = null,
  legacyModelPreference = null,
  mode = "standard",
}) {
  return async ({
    acceptance,
    brief,
    diffs = [],
    outOfScope,
    reviewTarget = null,
    signal = null,
    summaries,
    timeoutMs = null,
    title,
  }) => {




    const allRuntimes = resolvePreferredRuntimeDefinitions({});
    let runtime = null;
    if (allRuntimes.length === 0) {
      throw new Error("no LLM reviewer runtime available (install `codex` or `claude` CLI)");
    } else if (allRuntimes.length === 1) {
      runtime = allRuntimes[0];
    } else if (executorAdapterId === "codex_local") {
      runtime = allRuntimes.find((r) => r.runtimeId === "claude_code_local") ?? allRuntimes[0];
    } else if (executorAdapterId === "claude_code_local") {
      runtime = allRuntimes.find((r) => r.runtimeId === "codex_local") ?? allRuntimes[0];
    } else {
      runtime = allRuntimes[0];
    }



    const modelPreference = modelPreferences && typeof modelPreferences === "object"
      ? (modelPreferences[runtime.runtimeId] ?? legacyModelPreference ?? null)
      : (legacyModelPreference ?? null);
    if (mode === "adversarial") {
      return runAdversarialReview({
        acceptance,
        brief,
        deniedReadRoots,
        modelPreference,
        outOfScope,
        reviewTarget,
        runtime,
        signal,
        timeoutMs,
        title,
        workspaceRoot,
      });
    }
    const prompt = buildLlmReviewPrompt({ acceptance, brief, diffs, outOfScope, summaries, title });

    const exec = runtime.runtimeId === "codex_local" ? resolveCodexExecutor() : runClaudeExecution;
    const result = await exec({
      commandPath: runtime.commandPath,
      deniedReadRoots,
      ...(runtime.runtimeId === "claude_code_local"
        ? {
            disallowedTools: [
              "Edit",
              "Write",
              "NotebookEdit",
              "Bash(git commit *)",
              "Bash(git push *)",
              "Bash(git tag *)",
              "Bash(gh *)",
              "Bash(glab *)",
              "WebFetch",
              "WebSearch",
            ],
            permissionMode: "dontAsk",
          }
        : {
            approvalPolicy: "never",
            sandbox: "read-only",
          }),
      modelPreference,
      prompt,
      signal,
      timeoutMs,
      workspaceRoot,
    });
    return parseReviewerVerdictFromSummary(result?.summary);
  };
}

function createReviewEvidenceRuntime(spec = {}) {
  const stateRoot = resolveReviewStateRoot(spec);

  if (!stateRoot) {
    return null;
  }

  const workspaceRoot = spec.workspaceRoot ?? resolveWorkspaceRoot();
  const runtime = {
    verifyRawOutputRef({ expectedSha256 = null, rawOutputRef }) {
      return storage.verifyRunLogReference({
        expectedSha256,
        ref: rawOutputRef,
        stateRoot,
      });
    },
  };

  try {
    const reviewConfig = getLlmReviewConfig({ workspaceRoot });
    if (reviewConfig.enabled) {



      const executorAdapterId = spec.executorAdapterId
        ?? spec.runRecord?.adapter_id
        ?? null;
      runtime.llmReviewer = createLlmReviewer({
        deniedReadRoots: resolveExecutorDeniedReadRoots(stateRoot),
        executorAdapterId,
        legacyModelPreference: reviewConfig.legacy_model_preference,
        mode: reviewConfig.mode,
        modelPreferences: reviewConfig.model_preferences,
        workspaceRoot,
      });
    }
  } catch {



  }

  return runtime;
}

function normalizePersistedArtifactList(value) {
  return Array.isArray(value) ? value : [];
}

async function persistReviewArtifacts(spec, review) {
  const stateRoot = resolveReviewStateRoot(spec);

  if (!stateRoot || !fs.existsSync(stateRoot)) {
    throw new Error("state root is missing; run `init` first before using `review --persist`");
  }

  const persistedArtifacts = spec.persistedArtifacts ?? spec.persisted_artifacts ?? {};
  const databasePath = storage.createSqliteDatabasePath(stateRoot);
  const sqliteStorage = storage.createSqliteStorage({
    databasePath,
  });

  try {
    await storage.seedStorage(sqliteStorage, {
      assignments: normalizePersistedArtifactList(persistedArtifacts.assignments),
      blockers: [
        ...normalizePersistedArtifactList(persistedArtifacts.blockers),
        ...(review.blocker ? [review.blocker] : []),
      ],
      evidencePackets: review.results.map((result) => result.evidence_packet),
      events: [
        ...normalizePersistedArtifactList(persistedArtifacts.events),
        ...review.events,
      ],
      explainability: [
        ...normalizePersistedArtifactList(persistedArtifacts.explainability),
        ...review.explainability,
      ],
      ingressRecords: normalizePersistedArtifactList(
        persistedArtifacts.ingressRecords ?? persistedArtifacts.ingress_records,
      ),
      runLogs: normalizePersistedArtifactList(
        persistedArtifacts.runLogs ?? persistedArtifacts.run_logs,
      ),
      runs: [
        ...normalizePersistedArtifactList(persistedArtifacts.runs),
        ...(spec.runRecord ? [spec.runRecord] : []),
      ],
      taskNotes: normalizePersistedArtifactList(
        persistedArtifacts.taskNotes ?? persistedArtifacts.task_notes,
      ),
      tasks: [
        ...normalizePersistedArtifactList(persistedArtifacts.tasks),
        ...(spec.task ? [spec.task] : []),
      ],
      verdicts: review.results.map((result) => result.verdict),
    });
  } finally {
    sqliteStorage.close();
  }

  return {
    counts: {
      assignments: normalizePersistedArtifactList(persistedArtifacts.assignments).length,
      blockers:
        normalizePersistedArtifactList(persistedArtifacts.blockers).length
        + (review.blocker ? 1 : 0),
      events:
        normalizePersistedArtifactList(persistedArtifacts.events).length
        + review.events.length,
      explainability:
        normalizePersistedArtifactList(persistedArtifacts.explainability).length
        + review.explainability.length,
      evidence_packets: review.results.length,
      ingress_records: normalizePersistedArtifactList(
        persistedArtifacts.ingressRecords ?? persistedArtifacts.ingress_records,
      ).length,
      run_logs: normalizePersistedArtifactList(
        persistedArtifacts.runLogs ?? persistedArtifacts.run_logs,
      ).length,
      runs:
        normalizePersistedArtifactList(persistedArtifacts.runs).length
        + (spec.runRecord ? 1 : 0),
      task_notes: normalizePersistedArtifactList(
        persistedArtifacts.taskNotes ?? persistedArtifacts.task_notes,
      ).length,
      tasks:
        normalizePersistedArtifactList(persistedArtifacts.tasks).length
        + (spec.task ? 1 : 0),
      verdicts: review.results.length,
    },
    database_path: databasePath,
    state_root: stateRoot,
  };
}

function instantiateServeTaskSources(taskSourceSpecs = []) {
  if (!Array.isArray(taskSourceSpecs) || taskSourceSpecs.length === 0) {
    return [
      {
        id: "cli-empty-source",
        type: "backlog_file",
        wakeSource: "automation",
        poll: () => [],
      },
    ];
  }

  return taskSourceSpecs.map((taskSourceSpec, index) => ({
    id: taskSourceSpec.id ?? `cli-source-${index + 1}`,
    type: taskSourceSpec.type ?? "backlog_file",
    wakeSource: taskSourceSpec.wakeSource ?? "automation",
    routeTask:
      taskSourceSpec.routeDecision || taskSourceSpec.routeDecisions
        ? (detection) => {
          const byTaskId = taskSourceSpec.routeDecisions?.[detection.normalized.identifier] ?? null;
          return byTaskId ?? taskSourceSpec.routeDecision ?? {};
        }
        : undefined,
    poll: () => taskSourceSpec.records ?? [],
  }));
}

function ensureServeWorkspace(specWorkspace = {}) {
  const workspaceRoot = path.resolve(
    process.cwd(),
    specWorkspace.root ?? path.join(".niis", "tmp-workspaces"),
  );

  fs.mkdirSync(workspaceRoot, { recursive: true });

  return {
    ...specWorkspace,
    projectPrimary: specWorkspace.projectPrimary
      ? path.resolve(process.cwd(), specWorkspace.projectPrimary)
      : process.cwd(),
    root: workspaceRoot,
  };
}

function createServeSeed(spec = {}) {
  return {
    agents: spec.agents ?? [
      {
        id: spec.agentId ?? "cli-agent",
        name: "CLI Agent",
        adapter_type: "in_memory",
        status: "ACTIVE",
        pause_condition: null,
        capabilities: ["execute"],
        budget_monthly: {
          limit_usd: 100,
          spent_usd: 0,
        },
        config: {},
        env_bindings: [],
        health_status: "healthy",
        last_run_id: null,
        last_run_at: null,
        accumulated: {
          total_tokens_in: 0,
          total_tokens_out: 0,
          total_cost_usd: 0,
          total_runs: 0,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    checkpoints: spec.checkpoints ?? [],
    assignments: spec.assignments ?? [],
    blockers: spec.blockers ?? [],
    evidencePackets: spec.evidencePackets ?? [],
    events: spec.events ?? [],
    explainability: spec.explainability ?? [],
    goals: spec.goals ?? [],
    ingressRecords: spec.ingressRecords ?? [],
    runLogs: spec.runLogs ?? [],
    runs: spec.runs ?? [],
    tasks: spec.tasks ?? [],
    taskSessions: spec.taskSessions ?? [],
    taskNotes: spec.taskNotes ?? [],
    verdicts: spec.verdicts ?? [],
  };
}

async function createServeSpecStorage(spec = {}) {
  const seed = createServeSeed(spec);
  const kind = spec.storage?.kind ?? "memory";

  if (kind === "sqlite") {
    const plan = createInitPlan(resolveWorkspaceRoot());
    const databasePath = resolveServeSqliteDatabasePath(spec, plan);
    const secretStore = storage.createLocalSecretStore({
      stateRoot: plan.stateRoot,
    });
    const normalizedSeed = {
      ...seed,
      agents: seed.agents.map((agent) =>
        storage.persistSensitiveAgentEnvBindings(agent, {
          plaintextPersistence: "reject",
          secretStore,
        })),
    };
    const sqliteStorage = storage.createSqliteStorage({
      databasePath,
    });
    await storage.seedStorage(sqliteStorage, normalizedSeed);
    return sqliteStorage;
  }

  return serveRuntime.createInMemoryServeStorage(seed);
}

function resolveServeSqliteDatabasePath(spec = {}, plan = createInitPlan(resolveWorkspaceRoot())) {
  return path.resolve(process.cwd(), spec.storage?.databasePath ?? plan.databasePath);
}

function createServeBackupRuntime(spec = {}, plan = createInitPlan(resolveWorkspaceRoot())) {
  const backupSpec = spec.backupRuntime ?? null;
  const sqliteMode = (spec.storage?.kind ?? "memory") === "sqlite";

  if (!backupSpec && !sqliteMode) {
    return null;
  }

  const normalizedBackupSpec = backupSpec ?? {};

  return {
    intervalMs:
      normalizedBackupSpec.intervalMs
      ?? normalizedBackupSpec.interval_ms
      ?? (24 * 60 * 60 * 1000),
    stateRoot: path.resolve(
      process.cwd(),
      normalizedBackupSpec.stateRoot
      ?? normalizedBackupSpec.state_root
      ?? path.dirname(resolveServeSqliteDatabasePath(spec, plan)),
    ),
  };
}

function instantiateSpecAdapters(adapterSpecs = []) {
  if (!Array.isArray(adapterSpecs) || adapterSpecs.length === 0) {
    return [
      createInMemoryTestAdapter({
        id: "default-cli-adapter",
        metadata: {
          cost_tier: "standard",
        },
      }),
    ];
  }

  return adapterSpecs.map((adapterSpec, index) =>
    adapterSpec.protocolType === "mcp_server"
      ? createMcpServerAdapter({
        args: adapterSpec.args ?? [],
        capabilities: adapterSpec.capabilities ?? {},
        command: adapterSpec.command,
        cwd: adapterSpec.cwd,
        defaultToolName: adapterSpec.defaultToolName ?? null,
        env: adapterSpec.env ?? {},
        id: adapterSpec.id ?? `cli-adapter-${index + 1}`,
        metadata: adapterSpec.metadata ?? {},
        optionalEnv: adapterSpec.optionalEnv ?? [],
        requiredEnv: adapterSpec.requiredEnv ?? [],
      })
      : adapterSpec.protocolType === "local_cli"
        && (adapterSpec.id === "codex_local" || adapterSpec.adapterKind === "codex_local")
        ? createCodexLocalAdapter({
          args: adapterSpec.args ?? [],
          capabilities: adapterSpec.capabilities ?? {},
          command: adapterSpec.command,
          cwd: adapterSpec.cwd,
          diagnosticArgs: adapterSpec.diagnosticArgs ?? adapterSpec.diagnostic_args ?? ["--version"],
          env: adapterSpec.env ?? {},
          id: adapterSpec.id ?? "codex_local",
          metadata: adapterSpec.metadata ?? {},
          optionalEnv: adapterSpec.optionalEnv ?? [],
          requiredEnv: adapterSpec.requiredEnv ?? [],
        })
      : adapterSpec.protocolType === "local_cli"
        && (adapterSpec.id === "claude_code_local" || adapterSpec.adapterKind === "claude_code_local")
        ? createClaudeCodeLocalAdapter({
          args: adapterSpec.args ?? [],
          capabilities: adapterSpec.capabilities ?? {},
          command: adapterSpec.command,
          cwd: adapterSpec.cwd,
          diagnosticArgs: adapterSpec.diagnosticArgs ?? adapterSpec.diagnostic_args ?? ["--version"],
          env: adapterSpec.env ?? {},
          id: adapterSpec.id ?? "claude_code_local",
          metadata: adapterSpec.metadata ?? {},
          optionalEnv: adapterSpec.optionalEnv ?? [],
          requiredEnv: adapterSpec.requiredEnv ?? [],
        })
      : adapterSpec.protocolType === "cursor_bridge"
        ? createCursorBridgeAdapter({
          args: adapterSpec.args ?? [],
          capabilities: adapterSpec.capabilities ?? {},
          command: adapterSpec.command,
          cwd: adapterSpec.cwd,
          defaultToolName: adapterSpec.defaultToolName ?? null,
          env: adapterSpec.env ?? {},
          id: adapterSpec.id ?? `cli-adapter-${index + 1}`,
          metadata: adapterSpec.metadata ?? {},
          optionalEnv: adapterSpec.optionalEnv ?? [],
          requiredEnv: adapterSpec.requiredEnv ?? [],
        })
      : createInMemoryTestAdapter({
        capabilities: adapterSpec.capabilities ?? {},
        diagnostics: adapterSpec.diagnostics ?? {},
        id: adapterSpec.id ?? `cli-adapter-${index + 1}`,
        metadata: adapterSpec.metadata ?? {},
        protocolType: adapterSpec.protocolType ?? "in_memory",
        scriptedResults: adapterSpec.scriptedResults ?? [],
      }),
  );
}

function instantiateSpecAdversarialReviewers(reviewerSpecs = []) {
  if (!Array.isArray(reviewerSpecs) || reviewerSpecs.length === 0) {
    return [];
  }

  function truncateTextPreview(value, maxLength = 140) {
    const normalized = typeof value === "string"
      ? value.replace(/\s+/g, " ").trim()
      : JSON.stringify(value ?? {});

    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength - 3)}...`;
  }

  function defaultVerdictClassForRole(role) {
    switch (role) {
      case "attacker":
        return "DEFECT";
      case "defender":
      case "auditor":
        return "PASS";
      default:
        return "PASS";
    }
  }

  function defaultNextActionForRole(role) {
    switch (role) {
      case "attacker":
        return "Require the defender to rebut the candidate concern.";
      case "defender":
        return "Escalate to the auditor for the final adversarial decision.";
      case "auditor":
        return "Apply the final adversarial review decision.";
      default:
        return "Continue the configured adversarial review flow.";
    }
  }

  function derivePrimaryReviewSurface(context) {
    const subject = context?.subject && typeof context.subject === "object"
      ? context.subject
      : {};

    if (subject.security_scan_surface || subject.conversion_candidate) {
      return subject.security_scan_surface ?? null;
    }

    const surfaces = Array.isArray(subject.security_scan_surfaces)
      ? subject.security_scan_surfaces
      : [];

    return surfaces.find((surface) => surface?.type !== "package_manifest")
      ?? surfaces[0]
      ?? null;
  }

  function deriveSurfaceSourcePath(subject, surface) {
    if (typeof subject?.conversion_candidate?.path === "string" && subject.conversion_candidate.path.trim() !== "") {
      return subject.conversion_candidate.path.trim();
    }

    if (typeof surface?.id === "string" && surface.id.startsWith("source-pack:")) {
      const segments = surface.id.split(":");
      return segments[segments.length - 1] ?? null;
    }

    return null;
  }

  function describeReviewContext(context) {
    const subject = context?.subject && typeof context.subject === "object"
      ? context.subject
      : {};
    const packageManifest = subject.package_manifest ?? {};
    const surface = derivePrimaryReviewSurface(context);
    const sourcePath = deriveSurfaceSourcePath(subject, surface);
    const sourceLabel = sourcePath
      ? path.basename(sourcePath)
      : surface?.id
        ?? packageManifest.id
        ?? context?.subjectKind
        ?? "unknown-surface";
    const previousVerdicts = Array.isArray(context?.previous_results)
      ? context.previous_results.map((entry) => entry?.verdict?.verdict_class).filter(Boolean)
      : [];
    const previewSource = subject?.conversion_candidate?.content
      ?? surface?.content
      ?? packageManifest;

    return Object.freeze({
      package_id: packageManifest.id ?? "unknown-package",
      previous_verdicts: previousVerdicts,
      source_label: sourceLabel,
      source_path: sourcePath,
      surface_id: surface?.id ?? null,
      surface_type: surface?.type ?? null,
      text_preview: truncateTextPreview(previewSource),
    });
  }

  function createSubjectSummaryResult(normalizedSpec, context) {
    const summary = describeReviewContext(context);
    const reviewerRole = normalizedSpec.role;
    const verdictClass = normalizedSpec.verdictClass
      ?? normalizedSpec.verdict_class
      ?? defaultVerdictClassForRole(reviewerRole);
    const nextAction = normalizedSpec.nextAction
      ?? normalizedSpec.next_action
      ?? defaultNextActionForRole(reviewerRole);
    const previousVerdictSummary = summary.previous_verdicts.length > 0
      ? summary.previous_verdicts.join(" -> ")
      : "none";
    let content;
    let reason;

    switch (reviewerRole) {
      case "attacker":
        content =
          `Attacker reviewed ${summary.package_id} on ${summary.source_label}`
          + ` (${summary.surface_type ?? "unknown-surface"}) and flagged a candidate concern.`
          + ` Preview: ${summary.text_preview}`;
        reason =
          `Candidate risk remains review-worthy for ${summary.package_id} on ${summary.source_label}.`;
        break;
      case "defender":
        content =
          `Defender reviewed ${summary.package_id} on ${summary.source_label}`
          + ` after prior verdicts ${previousVerdictSummary} and found the concern bounded by current evidence.`;
        reason =
          `The rebuttal addressed the candidate concern for ${summary.package_id} on ${summary.source_label}.`;
        break;
      case "auditor":
        content =
          `Auditor reviewed ${summary.package_id} on ${summary.source_label}`
          + ` after prior verdicts ${previousVerdictSummary} and issued the final adversarial decision.`;
        reason = verdictClass === "PASS"
          ? `The final adversarial review approved ${summary.package_id} on ${summary.source_label}.`
          : `The final adversarial review requires escalation for ${summary.package_id} on ${summary.source_label}.`;
        break;
      default:
        content = `Reviewer ${normalizedSpec.id ?? reviewerRole} evaluated ${summary.package_id}.`;
        reason = `Adversarial review completed for ${summary.package_id}.`;
        break;
    }

    return {
      evidence_packet: {
        authenticity_status: "VERIFIED",
        items: [{
          content,
          source: reviewerRole,
          type: "review_note",
        }],
        markers: {
          auth_surfaces_attempted: [],
          browser_live_checks: [],
          checked_urls: [],
          runtime_evidence_succeeded: true,
        },
      },
      next_action: nextAction,
      reason,
      verdict_class: verdictClass,
    };
  }

  return reviewerSpecs.map((reviewerSpec, index) => {
    const normalizedSpec = reviewerSpec ?? {};
    const scriptedResults = normalizedSpec.scriptedResults
      ?? normalizedSpec.scripted_results
      ?? (normalizedSpec.result ?? normalizedSpec.reviewResult ?? normalizedSpec.review_result
        ? [normalizedSpec.result ?? normalizedSpec.reviewResult ?? normalizedSpec.review_result]
        : []);
    const strategy = normalizedSpec.strategy
      ?? normalizedSpec.reviewStrategy
      ?? normalizedSpec.review_strategy
      ?? null;
    let cursor = 0;

    return adversarialReview.createAdversarialReviewer({
      description: normalizedSpec.description ?? null,
      id: normalizedSpec.id ?? `cli-adversarial-reviewer-${index + 1}`,
      role: normalizedSpec.role,
      review(context) {
        const expectedPreviousResultsCount =
          normalizedSpec.expectedPreviousResultsCount
          ?? normalizedSpec.expected_previous_results_count
          ?? null;

        if (
          expectedPreviousResultsCount !== null
          && context.previous_results.length !== expectedPreviousResultsCount
        ) {
          throw new Error(
            `expected ${expectedPreviousResultsCount} previous result(s); got `
            + `${context.previous_results.length}`,
          );
        }

        if (strategy === "subject_summary") {
          return createSubjectSummaryResult(normalizedSpec, context);
        }

        if (!Array.isArray(scriptedResults) || scriptedResults.length === 0) {
          throw new Error(`reviewer ${normalizedSpec.id ?? index + 1} is missing a scripted result`);
        }

        const result = scriptedResults[Math.min(cursor, scriptedResults.length - 1)];
        cursor += 1;
        return result;
      },
    });
  });
}

function sanitizeRoutePlan(routePlan) {
  return {
    delegation_payload: routePlan.delegation_payload,
    dispatchable_subtasks: routePlan.dispatchable_subtasks,
    event: routePlan.event,
    explainability: routePlan.explainability,
    reference_bundle: routePlan.reference_bundle,
    routing_policy: routePlan.routing_policy,
    selected_adapter: routePlan.selected_adapter,
    selected_lane: routePlan.selected_lane,
    task: routePlan.task,
  };
}

async function runRoute(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const activatedPackages = await loadActivatedRuntimePackagesForSpec(spec, {
    packageTypes: ["role", "adapter"],
    context: {
      command: "route",
      task: spec.task,
    },
  });
  const routePlan = routing.buildRoutePlan({
    adapters: [
      ...instantiateSpecAdapters(spec.adapters),
      ...activatedPackages.adapters,
    ],
    referenceBundle: spec.referenceBundle ?? {},
    roleManifests: [
      ...(spec.roleManifests ?? []),
      ...activatedPackages.roleManifests,
    ],
    routingPolicy: spec.routingPolicy ?? {},
    subtasks: spec.subtasks ?? [],
    task: spec.task,
  });

  console.log(JSON.stringify(sanitizeRoutePlan(routePlan), null, 2));
}

async function runExecution(args) {
  void args;
  throw new Error(
    "`niis run` execution is retired in Reliability RC because it bypasses "
    + "the canonical TaskAttempt lifecycle; use intake, approve-plan, and start-task",
  );
}

async function runReview(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const activatedPackages = await loadActivatedRuntimePackagesForSpec(spec, {
    packageTypes: ["validator"],
    context: {
      command: "review",
      task: spec.task,
    },
  });
  const review = await policy.runValidatorLane({
    actorRole: spec.actorRole ?? "validator",
    evidencePacket: spec.evidencePacket ?? null,
    evidenceRuntime: createReviewEvidenceRuntime(spec),
    executorAgentId: spec.executorAgentId ?? spec.runRecord?.agent_id ?? null,
    observedOutcome: spec.observedOutcome ?? {},
    policy: spec.policy ?? {},
    projectProfile: spec.projectProfile ?? spec.project_profile ?? {},
    reviewerAgentId: spec.reviewerAgentId ?? "cli-review",
    runRecord: spec.runRecord,
    task: spec.task,
    validatorIds: spec.validatorIds ?? [],
    validators: [
      ...createDefaultValidators(),
      ...activatedPackages.validators,
    ],
  });
  const persistedArtifacts = args.includes("--persist")
    ? await persistReviewArtifacts(spec, review)
    : null;

  console.log(JSON.stringify({
    blocker: review.blocker,
    completion_gate: review.completion_gate,
    continuation_request: review.continuation_request,
    events: review.events,
    explainability: review.explainability,
    final_evidence_packet: review.final_evidence_packet,
    final_verdict: review.final_verdict,
    observations: review.observations,
    persisted_artifacts: persistedArtifacts,
    resolved_policy: review.resolved_policy,
    results: review.results.map((result) => ({
      continuation_rule: result.continuation_rule,
      evidence_packet: result.evidence_packet,
      validator: {
        description: result.validator.description,
        domain: result.validator.domain,
        excluded_concerns: result.validator.excluded_concerns,
        id: result.validator.id,
      },
      verdict: result.verdict,
    })),
  }, null, 2));
}

function runActivate(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const now = spec.now ?? new Date();
  const resolvedInstallStatePath =
    spec.installStatePath
    ?? spec.install_state_path
    ?? createInitPlan(resolveWorkspaceRoot()).installStatePath;
  const activation = packageActivation.evaluatePackageActivation({
    adversarialReviewers: instantiateSpecAdversarialReviewers(
      spec.adversarialReviewers ?? spec.adversarial_reviewers ?? [],
    ),
    availableAdapters: resolveActivationAvailableAdapters(spec, resolvedInstallStatePath),
    currentNiisVersion:
      spec.currentNiisVersion
      ?? spec.current_niis_version
      ?? readInstalledNiisVersion(),
    now,
    packageManifest: spec.packageManifest ?? spec.package_manifest,
    policy: spec.policy ?? {},
    runId: spec.runId ?? spec.run_id ?? null,
    securityScanSurfaces: spec.securityScanSurfaces ?? spec.security_scan_surfaces ?? [],
    taskId: spec.taskId ?? spec.task_id ?? spec.task?.id ?? null,
    threatCatalog: spec.policy?.threat_catalog ?? policy.DEFAULT_THREAT_CATALOG,
  });
  const shouldRecordInstallState = Boolean(
    spec.recordInstallState ?? spec.record_install_state ?? false,
  );
  const activationSource = spec.discoveryCandidate
    ?? spec.discovery_candidate
    ?? spec.activationSource
    ?? spec.activation_source
    ?? {};
  const activationInstallState = activation.allowed && shouldRecordInstallState
    ? installState.recordActivationInstallState({
      candidateKind:
        spec.candidateKind
        ?? spec.candidate_kind
        ?? activationSource.candidate_kind
        ?? activationSource.candidateKind
        ?? "package",
      installStatePath:
        resolvedInstallStatePath,
      now,
      packageManifest: activation.package_manifest,
      packageRoot: path.resolve(
        process.cwd(),
        spec.packageRoot
          ?? spec.package_root
          ?? resolveWorkspaceRoot(),
      ),
      sourceKind:
        spec.sourceKind
        ?? spec.source_kind
        ?? activationSource.source_kind
        ?? activationSource.sourceKind
        ?? null,
      sourceRef:
        spec.sourceRef
        ?? spec.source_ref
        ?? activationSource.source_ref
        ?? activationSource.sourceRef
        ?? null,
    })
    : null;

  console.log(JSON.stringify({
    allowed: activation.allowed,
    adversarial_review: activation.adversarial_review ?? null,
    blocker: activation.blocker,
    compatibility_evaluation: activation.compatibility_evaluation ?? null,
    event: activation.event,
    explainability: activation.explainability,
    findings: activation.findings,
    install_state: activationInstallState?.install_state ?? null,
    install_state_entry: activationInstallState?.install_state_entry ?? null,
    install_state_path: activationInstallState?.install_state_path ?? null,
    observations: activation.observations,
    package_manifest: activation.package_manifest,
    review_plan: activation.review_plan,
  }, null, 2));
}

function runDiscover(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const report = packageDiscovery.discoverPackageCandidates({
    alreadyReported:
      spec.alreadyReported
      ?? spec.already_reported
      ?? spec.previousReport
      ?? spec.previous_report
      ?? null,
    now: spec.now ?? new Date(),
    reportId: spec.reportId ?? spec.report_id ?? "package-discovery-report",
    sources: spec.sources ?? spec.discoverySources ?? spec.discovery_sources ?? [],
    threatCatalog: spec.policy?.threat_catalog ?? policy.DEFAULT_THREAT_CATALOG,
  });

  console.log(JSON.stringify(report, null, 2));
}

function runDiscoverPipeline(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const pipeline = discoveryPipeline.runIncrementalDiscoveryPipeline({
    alreadyReported:
      spec.alreadyReported
      ?? spec.already_reported
      ?? spec.previousReport
      ?? spec.previous_report
      ?? null,
    maxParallel:
      spec.maxParallel
      ?? spec.max_parallel
      ?? spec.routingPolicy?.maxParallel
      ?? spec.routingPolicy?.max_parallel
      ?? 2,
    now: spec.now ?? new Date(),
    reportId: spec.reportId ?? spec.report_id ?? "discovery-pipeline-report",
    sources: spec.sources ?? spec.discoverySources ?? spec.discovery_sources ?? [],
    taskId: spec.taskId ?? spec.task_id ?? "runtime:discovery-pipeline",
    threatCatalog: spec.policy?.threat_catalog ?? policy.DEFAULT_THREAT_CATALOG,
  });

  console.log(JSON.stringify(pipeline, null, 2));
}

function runPromoteInstinct(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const commonArgs = {
    confidence: spec.confidence,
    confidencePolicy:
      spec.confidencePolicy
      ?? spec.confidence_policy
      ?? spec.policy?.confidencePolicy
      ?? spec.policy?.confidence_policy
      ?? {},
    domain: spec.domain ?? null,
    evidence: spec.evidence ?? {},
    instinctId: spec.instinctId ?? spec.instinct_id ?? null,
    now: spec.now ?? new Date(),
    projectId: spec.projectId ?? spec.project_id ?? null,
    review: spec.review ?? {},
    securityReview: spec.securityReview ?? spec.security_review ?? null,
    scope: spec.scope ?? "project",
    status: spec.status ?? "tentative",
    trigger: spec.trigger ?? null,
  };
  const promotion = spec.observation ?? spec.policyObservation ?? spec.policy_observation
    ? instinctPromotion.promoteObservationToInstinct({
      ...commonArgs,
      observation: spec.observation ?? spec.policyObservation ?? spec.policy_observation,
    })
    : instinctPromotion.promoteDiscoveryCandidateToInstinct({
      ...commonArgs,
      candidate: spec.candidate ?? spec.discoveryCandidate ?? spec.discovery_candidate,
      provenance: spec.provenance ?? {},
      source: spec.source ?? "promoted",
    });

  console.log(JSON.stringify(promotion, null, 2));
}

function runExportInstincts(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const exported = instinctTransfer.exportReviewedInstinctBundle({
    bundleId: spec.bundleId ?? spec.bundle_id ?? null,
    instincts: spec.instincts ?? [],
    now: spec.now ?? new Date(),
    review: spec.review ?? {},
    summary: spec.summary ?? null,
    title: spec.title ?? null,
  });

  console.log(JSON.stringify(exported, null, 2));
}

function runImportInstincts(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const imported = instinctTransfer.importReviewedInstinctBundle({
    bundle: spec.bundle ?? spec.instinctBundle ?? spec.instinct_bundle,
    existingInstincts:
      spec.existingInstincts
      ?? spec.existing_instincts
      ?? spec.instincts
      ?? [],
    now: spec.now ?? new Date(),
    review: spec.review ?? {},
  });

  console.log(JSON.stringify(imported, null, 2));
}

function runClusterInstincts(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const clustered = skillCandidate.clusterInstinctsToSkillCandidate({
    instincts: spec.instincts ?? [],
    now: spec.now ?? new Date(),
    projectId: spec.projectId ?? spec.project_id ?? null,
    review: spec.review ?? {},
    scope: spec.scope ?? null,
    securityReview: spec.securityReview ?? spec.security_review ?? null,
    skillCandidateId: spec.skillCandidateId ?? spec.skill_candidate_id ?? null,
    status: spec.status ?? "candidate",
    summary: spec.summary ?? null,
    title: spec.title ?? null,
  });

  console.log(JSON.stringify(clustered, null, 2));
}

function runGovernLearning(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const evaluation = learningGovernance.evaluateLearningGovernance({
    approval: spec.approval ?? null,
    instinct: spec.instinct ?? null,
    now: spec.now ?? new Date(),
    runId: spec.runId ?? spec.run_id ?? null,
    skillCandidate: spec.skillCandidate ?? spec.skill_candidate ?? null,
    taskId: spec.taskId ?? spec.task_id ?? null,
  });

  console.log(JSON.stringify(evaluation, null, 2));
}

function runObservationLifecycle(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const result = observationLifecycle.applyObservationLifecycle({
    artifacts: spec.artifacts ?? [],
    now: spec.now ?? new Date(),
    policy: spec.policy ?? {},
  });

  console.log(JSON.stringify(result, null, 2));
}

function runGuardObservation(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const result = observationGuardian.evaluateObservationGuardian({
    activitySignal: spec.activitySignal ?? spec.activity_signal ?? null,
    lastObservationAt: spec.lastObservationAt ?? spec.last_observation_at ?? null,
    now: spec.now ?? new Date(),
    observerTurn: spec.observerTurn ?? spec.observer_turn ?? 1,
    policy: spec.policy ?? {},
    projectId: spec.projectId ?? spec.project_id,
    runId: spec.runId ?? spec.run_id ?? null,
    taskId: spec.taskId ?? spec.task_id ?? undefined,
  });

  console.log(JSON.stringify(result, null, 2));
}

function runMemoryTaxonomy(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const result = memoryTaxonomy.classifyMemoryTaxonomy({
    instincts: spec.instincts ?? [],
    observationArtifacts:
      spec.observationArtifacts
      ?? spec.observation_artifacts
      ?? spec.artifacts
      ?? [],
    skillCandidates: spec.skillCandidates ?? spec.skill_candidates ?? [],
  });

  console.log(JSON.stringify(result, null, 2));
}

function runImport(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const imported = packageImport.importExternalPack({
    adversarialReviewers: instantiateSpecAdversarialReviewers(
      spec.adversarialReviewers ?? spec.adversarial_reviewers ?? [],
    ),
    now: spec.now ?? new Date(),
    policy: spec.policy ?? {},
    runId: spec.runId ?? spec.run_id ?? null,
    sourcePack: spec.sourcePack ?? spec.source_pack,
    taskId: spec.taskId ?? spec.task_id ?? spec.task?.id ?? null,
    threatCatalog: spec.policy?.threat_catalog ?? policy.DEFAULT_THREAT_CATALOG,
  });

  console.log(JSON.stringify(imported, null, 2));
}

async function runPluginPlan(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const plan = pluginRuntime.createPluginRuntimePlan({
    action: spec.action ?? "load",
    plugin: spec.plugin ?? spec.pluginDefinition ?? spec.plugin_definition ?? spec,
  });
  const shouldRunDiagnostics = Boolean(
    spec.runIntegrationDiagnostics ?? spec.run_integration_diagnostics ?? false,
  );
  const integrationConfig = spec.integrationConfig ?? spec.integration_config ?? {};
  const integrationDiagnostics = shouldRunDiagnostics
    ? await Promise.all(plan.adapter_diagnostic_requests.map(async (request) => {
      if (request.kind !== "mcp_server") {
        return {
          integration_id: request.id,
          protocol_type: request.protocol_type,
          status: "skipped",
        };
      }

      const mcpAdapter = createMcpServerAdapter({
        id: request.adapter_id,
        args: request.args,
        capabilities: request.capabilities,
        command: request.command,
        cwd: request.cwd ?? undefined,
        defaultToolName: request.default_tool_name,
        metadata: request.metadata,
        optionalEnv: request.optional_env,
        requiredEnv: request.required_env,
      });
      const diagnostics = await adapter.runAdapterDiagnostics({
        adapter: mcpAdapter,
        config: integrationConfig[request.id] ?? {},
      });

      return {
        adapter_id: request.adapter_id,
        diagnostics,
        integration_id: request.id,
        protocol_type: request.protocol_type,
      };
    }))
    : [];

  console.log(JSON.stringify({
    ...plan,
    integration_diagnostics: integrationDiagnostics,
  }, null, 2));
}

function runStoragePlan(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const workspaceRoot = resolveWorkspaceRoot();
  const defaultDatabasePath = createInitPlan(workspaceRoot).databasePath;
  const plan = storageMigration.planStorageBackendMigration({
    databasePath: path.resolve(
      workspaceRoot,
      spec.databasePath
        ?? spec.database_path
        ?? defaultDatabasePath,
    ),
    migrationRefs: spec.migrationRefs ?? spec.migration_refs ?? [],
    operatorGuidance: spec.operatorGuidance ?? spec.operator_guidance ?? [],
    planId: spec.planId ?? spec.plan_id ?? "storage-migration-plan",
    targetBackend: spec.targetBackend ?? spec.target_backend,
  });

  console.log(JSON.stringify(plan, null, 2));
}

function runUpgradePlan(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  const workspaceRoot = resolveWorkspaceRoot();
  const initPlan = createInitPlan(workspaceRoot);
  const plan = upgradePlanning.evaluateReleaseUpgradePlan({
    availableAdapters: spec.availableAdapters ?? spec.available_adapters ?? [],
    databasePath:
      spec.databasePath === undefined && spec.database_path === undefined
        ? null
        : path.resolve(
          workspaceRoot,
          spec.databasePath ?? spec.database_path,
        ),
    installStatePath:
      spec.installStatePath === undefined && spec.install_state_path === undefined
        ? initPlan.installStatePath
        : path.resolve(
          workspaceRoot,
          spec.installStatePath ?? spec.install_state_path,
        ),
    now: spec.now ?? new Date(),
    operatorGuidance: spec.operatorGuidance ?? spec.operator_guidance ?? [],
    packageRoot: path.resolve(
      workspaceRoot,
      spec.packageRoot ?? spec.package_root ?? packageRoot,
    ),
    planId: spec.planId ?? spec.plan_id ?? null,
    releaseBundle: spec.releaseBundle ?? spec.release_bundle,
    storageTargetBackend: spec.storageTargetBackend ?? spec.storage_target_backend ?? null,
  });

  console.log(JSON.stringify(plan, null, 2));
}

function resolveFlagValue(args, flagName) {
  const flagIndex = args.indexOf(flagName);
  if (flagIndex === -1) {
    return null;
  }

  return args[flagIndex + 1] ?? null;
}

function resolveFlagValues(args, flagName) {
  const values = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flagName) {
      const value = args[index + 1] ?? null;
      if (value === null || value.startsWith("--")) {
        throw new Error(`${flagName} requires a value`);
      }
      values.push(value);
      index += 1;
    }
  }

  return values;
}

function resolveAssetHealthPath(args) {
  const explicitPath = resolveFlagValue(args, "--path");

  if (explicitPath) {
    return path.resolve(resolveWorkspaceRoot(), explicitPath);
  }

  const plan = createInitPlan(resolveWorkspaceRoot());
  return path.join(plan.stateRoot, "proofs", "evals", "proof-regression-suite.asset-health.json");
}

function summarizeAssetHealthAssets(assets = []) {
  return Object.freeze({
    failing: assets.filter((asset) => asset.status === "failing").length,
    healthy: assets.filter((asset) => asset.status === "healthy").length,
    total: assets.length,
    watch: assets.filter((asset) => asset.status === "watch").length,
  });
}

async function runExplain(args) {
  const taskId = resolveFlagValue(args, "--task-id");

  if (!taskId) {
    throw new Error("task id is required via --task-id");
  }

  const plan = createInitPlan(resolveWorkspaceRoot());
  const sqliteStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
    readonly: true,
  });

  try {
    const tasks = await sqliteStorage.tasks.list();
    const blockers = await sqliteStorage.blockers.active();

    console.log(JSON.stringify(policy.redactValue({
      assignments: await sqliteStorage.assignments.byTask(taskId),
      blockers: blockers.filter((blocker) => blocker.task_id === taskId),
      explainability: await sqliteStorage.decisions.explain(taskId),
      ingress: await sqliteStorage.ingress.byTask(taskId),
      runs: await sqliteStorage.runs.byTask(taskId),
      task: tasks.find((task) => task.id === taskId) ?? null,
      task_notes: await sqliteStorage.taskNotes.byTask(taskId),
    }), null, 2));
  } finally {
    sqliteStorage.close();
  }
}

async function runActivity(args) {
  const taskId = resolveFlagValue(args, "--task-id");

  if (!taskId) {
    throw new Error("task id is required via --task-id");
  }

  const plan = createInitPlan(resolveWorkspaceRoot());
  const sqliteStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
    readonly: true,
  });

  try {
    const activityView = observability.buildTaskObservabilityView({
      snapshot: sqliteStorage.snapshot(),
      taskId,
    });

    console.log(JSON.stringify(policy.redactValue(activityView), null, 2));
  } finally {
    sqliteStorage.close();
  }
}

function runAssetHealth(args) {
  const assetHealthPath = resolveAssetHealthPath(args);

  if (!fs.existsSync(assetHealthPath)) {
    throw new Error(
      `asset health report not found at ${assetHealthPath}; run \`npm run evals:proofs\` or pass --path`,
    );
  }

  const assetId = resolveFlagValue(args, "--asset-id");
  const assetKind = resolveFlagValue(args, "--asset-kind");
  const status = resolveFlagValue(args, "--status");
  const report = JSON.parse(fs.readFileSync(assetHealthPath, "utf8"));
  const assets = Array.isArray(report.assets) ? report.assets : [];
  const filteredAssets = assets.filter((asset) => {
    if (assetId && asset.asset_id !== assetId) {
      return false;
    }

    if (assetKind && asset.asset_kind !== assetKind) {
      return false;
    }

    if (status && asset.status !== status) {
      return false;
    }

    return true;
  });

  console.log(JSON.stringify(policy.redactValue({
    assets: filteredAssets,
    filters: {
      asset_id: assetId ?? null,
      asset_kind: assetKind ?? null,
      status: status ?? null,
    },
    generated_at: report.generated_at ?? null,
    report_path: assetHealthPath,
    source_suite_id: report.source_suite_id ?? null,
    summary: summarizeAssetHealthAssets(filteredAssets),
  }), null, 2));
}

async function runMetrics(args) {
  const taskId = resolveFlagValue(args, "--task-id");
  const agentId = resolveFlagValue(args, "--agent-id");
  const plan = createInitPlan(resolveWorkspaceRoot());
  const sqliteStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
    readonly: true,
  });

  try {
    console.log(JSON.stringify(policy.redactValue(await sqliteStorage.metrics.summary({
      agentId: agentId ?? null,
      taskId: taskId ?? null,
    })), null, 2));
  } finally {
    sqliteStorage.close();
  }
}

function normalizeUiFilters(args, spec = {}) {
  const statusFlags = resolveFlagValues(args, "--status");
  const phaseFlags = resolveFlagValues(args, "--phase");
  const taskIdFlags = resolveFlagValues(args, "--task-id");

  const phaseValues = phaseFlags.map((value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error("--phase must be a non-negative integer");
    }
    return parsed;
  });

  return {
    phases: phaseFlags.length > 0
      ? phaseValues
      : (spec.filters?.phases ?? spec.filters?.phase_ids ?? []),
    statuses: statusFlags.length > 0
      ? statusFlags
      : (spec.filters?.statuses ?? []),
    taskIds: taskIdFlags.length > 0
      ? taskIdFlags
      : (spec.filters?.taskIds ?? spec.filters?.task_ids ?? []),
  };
}

function loadUiSnapshot(spec = {}, workspaceRoot = resolveWorkspaceRoot()) {
  const inlineSnapshot = spec.snapshot ?? null;
  if (inlineSnapshot) {
    return inlineSnapshot;
  }

  const snapshotPath = spec.snapshotPath ?? spec.snapshot_path ?? null;
  if (snapshotPath) {
    const resolvedSnapshotPath = path.resolve(workspaceRoot, snapshotPath);
    return JSON.parse(fs.readFileSync(resolvedSnapshotPath, "utf8"));
  }

  const plan = createInitPlan(workspaceRoot);
  if (!fs.existsSync(plan.databasePath)) {
    throw new Error(
      "dashboard snapshot is required via spec.snapshot/spec.snapshotPath, or initialize local state first",
    );
  }

  const sqliteStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
    readonly: true,
  });

  try {
    return sqliteStorage.snapshot();
  } finally {
    sqliteStorage.close();
  }
}

function loadUiTaskCard({
  connectionState = "ready",
  spec = {},
  taskId,
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const snapshot = loadUiSnapshot(spec, workspaceRoot);
  const taskWorkbenchArtifacts = loadTaskWorkbenchArtifacts(taskId, workspaceRoot);

  return observability.buildTaskCardView({
    connectionState,
    snapshot,
    taskId,
    taskWorkbenchArtifacts,
  });
}

function ensureUiSchemaReady(spec = {}, workspaceRoot = resolveWorkspaceRoot()) {
  if (!resolveUiMutableState(spec, workspaceRoot)) {
    return;
  }

  const plan = createInitPlan(workspaceRoot);

  if (!fs.existsSync(plan.databasePath)) {
    return;
  }

  const sqliteStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
  });
  sqliteStorage.close();
}

function resolveUiOutputPath(args, spec = {}, { openRequested = false } = {}) {
  const explicitOutputPath = resolveFlagValue(args, "--output")
    ?? spec.outputPath
    ?? spec.output_path
    ?? null;

  if (explicitOutputPath) {
    return path.resolve(resolveWorkspaceRoot(), explicitOutputPath);
  }

  if (!openRequested) {
    return null;
  }

  return path.join(createInitPlan(resolveWorkspaceRoot()).stateRoot, "ui", "dashboard.html");
}

function launchUiTarget(target, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const recorderPath = env.NIIS_UI_OPEN_RECORD_PATH ?? null;

  if (recorderPath) {
    const resolvedRecorderPath = path.resolve(resolveWorkspaceRoot(), recorderPath);
    fs.mkdirSync(path.dirname(resolvedRecorderPath), { recursive: true });
    fs.writeFileSync(resolvedRecorderPath, `${target}\n`, { mode: 0o600 });

    return {
      command: "record-only",
      target,
    };
  }

  let command;
  let commandArgs;

  if (platform === "darwin") {
    command = "open";
    commandArgs = [target];
  } else if (platform === "win32") {
    command = "cmd";
    commandArgs = ["/c", "start", "", target];
  } else {
    command = "xdg-open";
    commandArgs = [target];
  }

  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`failed to open local dashboard via ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`failed to open local dashboard via ${command} (exit ${result.status})`);
  }

  return {
    command,
    target,
  };
}

function normalizeUiServeConfig(args, spec = {}) {
  const unsupportedRemoteFlag = ["--remote", "--token", "--allowed-origin"].find((flag) => args.includes(flag));
  if (unsupportedRemoteFlag) {
    throw new Error(`${unsupportedRemoteFlag} is not available in this release; the UI is loopback-only`);
  }
  const serveRequested = args.includes("--serve") || Boolean(spec.serve ?? spec.serve_ui ?? false);
  const host = resolveFlagValue(args, "--host") ?? spec.host ?? "127.0.0.1";
  const portValue = resolveFlagValue(args, "--port") ?? spec.port ?? null;
  const access = normalizeUiAccessConfig({
    allowedOrigins: spec.allowedOrigins ?? spec.allowed_origins ?? [],
    host,
    remoteRequested: Boolean(spec.remote ?? spec.remote_ui ?? false),
    token: spec.token ?? null,
  });

  if (portValue === null) {
    return {
      allowedOrigins: access.allowedOrigins,
      host: access.host,
      port: 4173,
      remote: access.remote,
      serve_requested: serveRequested,
      token: access.token,
    };
  }

  const port = Number.parseInt(String(portValue), 10);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }

  return {
    allowedOrigins: access.allowedOrigins,
    host: access.host,
    port,
    remote: access.remote,
    serve_requested: serveRequested,
    token: access.token,
  };
}

function formatUiServerUrl(host, port) {
  const normalizedHost = host.includes(":") && !host.startsWith("[")
    ? `[${host}]`
    : host;

  return `http://${normalizedHost}:${port}/`;
}

function resolveUiMutableState(spec = {}, workspaceRoot = resolveWorkspaceRoot()) {
  const hasInlineSnapshot = spec.snapshot !== undefined || spec.snapshotPath !== undefined || spec.snapshot_path !== undefined;
  return !hasInlineSnapshot && fs.existsSync(createInitPlan(workspaceRoot).databasePath);
}

function loadUiProjectContext(spec = {}, workspaceRoot = resolveWorkspaceRoot()) {
  const validationSurfaceRoot = resolveValidationSurfaceRoot([], workspaceRoot);
  const baseContext = onboarding.loadAttachedProjectContext({
    packageRoot,
    validationSurfaceRoot,
    workspaceRoot,
  });
  let roleConfig = null;
  try {
    const config = loadRoleConfig({ workspaceRoot });
    roleConfig = {
      manifests: config.manifests,
      overrides: readProjectConfigOrDefault(workspaceRoot),
      routing_policy_defaults: routing.DEFAULT_ROUTING_POLICY,
    };
  } catch (error) {
    console.error(`[niis] Failed to load role config: ${error.message}`);
  }
  return {
    ...baseContext,
    roleConfig,
  };
}

function readProjectConfigOrDefault(workspaceRoot) {
  try {
    const filePath = path.join(workspaceRoot, ".niis/project-config.json");
    const base = { auto_repair: null, autonomous_worker: null, billing: null, effective_merge_policy: null, intake_validation: null, llm_review: null, merge_policy: null, roles: {}, routing_policy: null };
    let parsed = null;
    if (fs.existsSync(filePath)) {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      base.merge_policy = parsed.merge_policy && typeof parsed.merge_policy === "object"
        ? { ...RELIABILITY_RC_REVIEW_PRESET }
        : null;
      base.roles = parsed.roles && typeof parsed.roles === "object" ? parsed.roles : {};
      base.routing_policy = parsed.routing_policy && typeof parsed.routing_policy === "object" ? parsed.routing_policy : null;


      base.auto_repair = parsed.auto_repair && typeof parsed.auto_repair === "object" ? parsed.auto_repair : null;
      base.autonomous_worker = parsed.autonomous_worker && typeof parsed.autonomous_worker === "object" ? parsed.autonomous_worker : null;
      base.intake_validation = parsed.intake_validation && typeof parsed.intake_validation === "object" ? parsed.intake_validation : null;
      base.llm_review = parsed.llm_review && typeof parsed.llm_review === "object" ? parsed.llm_review : null;
      base.billing = parsed.billing && typeof parsed.billing === "object" ? parsed.billing : null;
    }


    base.effective_merge_policy = { ...RELIABILITY_RC_REVIEW_PRESET };
    return base;
  } catch {
    return { auto_repair: null, autonomous_worker: null, effective_merge_policy: null, intake_validation: null, llm_review: null, merge_policy: null, roles: {}, routing_policy: null };
  }
}

function isRoleEnabledForWorkspace(roleId, workspaceRoot) {
  const config = readProjectConfigOrDefault(workspaceRoot);
  return config.roles?.[roleId]?.enabled !== false;
}





async function sumCurrentMonthRoleSpend(workspaceRoot) {
  try {
    const plan = createInitPlan(workspaceRoot);
    if (!fs.existsSync(plan.databasePath)) return 0;
    const period = currentMonthBucket(getSystemNow());
    const db = storage.createSqliteStorage({ databasePath: plan.databasePath, readonly: true });
    try {
      const rows = await db.roleMonthlySpend.list();
      let total = 0;
      for (const r of rows) {
        if (r?.period_yyyy_mm === period) total += Number(r.spent_usd) || 0;
      }
      return total;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

function writeProjectConfigUpdate(workspaceRoot, mutator) {
  const filePath = path.join(workspaceRoot, ".niis/project-config.json");
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  let current = { roles: {}, routing_policy: null };
  if (fs.existsSync(filePath)) {
    try {
      current = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      current = { roles: {}, routing_policy: null };
    }
  }
  if (!current.roles || typeof current.roles !== "object") current.roles = {};
  const next = mutator(current) ?? current;
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

function loadTaskWorkbenchArtifacts(taskId, workspaceRoot = resolveWorkspaceRoot()) {
  if (typeof taskId !== "string" || taskId.trim() === "") {
    return null;
  }

  const paths = taskIntake.createTaskIntakePaths(createInitPlan(workspaceRoot).stateRoot, taskId);
  const executionProgress = readTaskExecutionProgress({
    stateRoot: createInitPlan(workspaceRoot).stateRoot,
    taskId,
  });
  const executionLogTail = readTaskExecutionLogTail({
    maxLines: 40,
    stateRoot: createInitPlan(workspaceRoot).stateRoot,
    taskId,
  });
  const intakeArtifact = fs.existsSync(paths.intake_path)
    ? JSON.parse(fs.readFileSync(paths.intake_path, "utf8"))
    : null;
  const subtaskProgress = readSubtaskProgress({
    stateRoot: createInitPlan(workspaceRoot).stateRoot,
    taskId,
  });
  let queueEntry = null;
  try {
    queueEntry = taskQueue.findTaskState({
      stateRoot: createInitPlan(workspaceRoot).stateRoot,
      taskId,
    });
  } catch {
    queueEntry = null;
  }

  return Object.freeze({
    executionLogPath: createTaskExecutionProgressPaths(createInitPlan(workspaceRoot).stateRoot, taskId).progressLogPath,
    executionLogTail,
    executionProgress,
    intakeArtifact,
    intakeJsonPath: paths.intake_path,
    queueEntry: queueEntry ? { data: queueEntry.data, state: queueEntry.state } : null,
    reportJsonPath: paths.report_json_path,
    reportMarkdownPath: paths.report_markdown_path,
    report_json_url: fs.existsSync(paths.report_json_path)
      ? `/artifacts/task/${encodeURIComponent(taskId)}/report.json`
      : null,
    report_markdown_url: fs.existsSync(paths.report_markdown_path)
      ? `/artifacts/task/${encodeURIComponent(taskId)}/report.md`
      : null,
    subtaskProgress,
    taskRoot: paths.task_root,
  });
}

function createTaskExecutionProgressPaths(stateRoot, taskId) {
  const intakePaths = taskIntake.createTaskIntakePaths(stateRoot, taskId);

  return Object.freeze({
    progressJsonPath: path.join(intakePaths.task_root, "execution-progress.json"),
    progressLogPath: path.join(intakePaths.task_root, "execution-progress.log"),
    subtaskProgressPath: path.join(intakePaths.task_root, "subtask-progress.json"),
    taskBranchInfoPath: path.join(intakePaths.task_root, "task-branch.json"),
    taskRoot: intakePaths.task_root,
  });
}

function writeTaskBranchInfo({ stateRoot, taskId, info }) {
  const paths = createTaskExecutionProgressPaths(stateRoot, taskId);
  fs.mkdirSync(paths.taskRoot, { recursive: true });
  fs.writeFileSync(paths.taskBranchInfoPath, `${JSON.stringify({ ...info, updated_at: new Date().toISOString() }, null, 2)}\n`);
}

function readTaskBranchInfo({ stateRoot, taskId }) {
  try {
    const paths = createTaskExecutionProgressPaths(stateRoot, taskId);
    if (!fs.existsSync(paths.taskBranchInfoPath)) return null;
    return JSON.parse(fs.readFileSync(paths.taskBranchInfoPath, "utf8"));
  } catch {
    return null;
  }
}

function readSubtaskProgress({ stateRoot, taskId }) {
  const paths = createTaskExecutionProgressPaths(stateRoot, taskId);
  if (!fs.existsSync(paths.subtaskProgressPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.subtaskProgressPath, "utf8"));
    return Array.isArray(parsed?.subtasks) ? parsed : null;
  } catch {
    return null;
  }
}

function updateSubtaskProgress({
  stateRoot,
  taskId,
  subtaskId,
  status,
  roleId = null,
  summary = null,
  cost = null,
  startedAt = null,
  finishedAt = null,
  branch = null,
}) {
  const paths = createTaskExecutionProgressPaths(stateRoot, taskId);
  fs.mkdirSync(paths.taskRoot, { recursive: true });
  let current = { subtasks: [] };
  if (fs.existsSync(paths.subtaskProgressPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(paths.subtaskProgressPath, "utf8"));
      if (Array.isArray(parsed?.subtasks)) current = parsed;
    } catch {
      current = { subtasks: [] };
    }
  }
  const existing = current.subtasks.find((entry) => entry.id === subtaskId);
  const now = new Date().toISOString();
  const nextEntry = {
    branch: branch ?? existing?.branch ?? null,
    cost: cost ?? existing?.cost ?? null,
    finished_at: finishedAt ?? existing?.finished_at ?? null,
    id: subtaskId,
    role_id: roleId ?? existing?.role_id ?? null,
    started_at: startedAt ?? existing?.started_at ?? now,
    status,
    summary: summary ?? existing?.summary ?? null,
    updated_at: now,
  };
  if (existing) {
    current.subtasks = current.subtasks.map((entry) => entry.id === subtaskId ? nextEntry : entry);
  } else {
    current.subtasks = [...current.subtasks, nextEntry];
  }
  fs.writeFileSync(paths.subtaskProgressPath, `${JSON.stringify(current, null, 2)}\n`);
}

function readTaskExecutionProgress({
  stateRoot,
  taskId,
}) {
  const paths = createTaskExecutionProgressPaths(stateRoot, taskId);

  if (!fs.existsSync(paths.progressJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(paths.progressJsonPath, "utf8"));
  } catch {
    return null;
  }
}

function readTaskExecutionLogTail({
  maxLines = 40,
  stateRoot,
  taskId,
}) {
  const paths = createTaskExecutionProgressPaths(stateRoot, taskId);

  if (!fs.existsSync(paths.progressLogPath)) {
    return null;
  }

  const lines = fs.readFileSync(paths.progressLogPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  return lines.slice(-maxLines).join("\n");
}

function createTaskRunSessionId(taskId) {
  return `${taskId}:live-session`;
}

function createTaskRunSessionRecord({
  activePhase,
  adapterId = null,
  finishedAt = null,
  laneId = null,
  runId = null,
  runtimeFamily = null,
  sessionId,
  startedAt,
  status,
  summary = null,
  taskId,
  updatedAt = startedAt,
}) {
  return schemas.taskRunSession.parseTaskRunSession({
    active_phase: activePhase,
    adapter_id: adapterId,
    finished_at: finishedAt,
    id: sessionId,
    lane_id: laneId,
    run_id: runId,
    runtime_family: runtimeFamily,
    started_at: startedAt,
    status,
    summary,
    task_id: taskId,
    updated_at: updatedAt,
  });
}

function createTaskRunEventRecord({
  actorId,
  actorType,
  eventType,
  id,
  level = "info",
  payload = {},
  runId = null,
  taskId,
  timestamp,
  visibility = "curated",
}) {
  return schemas.taskRunEvent.parseTaskRunEvent({
    actor_id: actorId,
    actor_type: actorType,
    event_type: eventType,
    id,
    level,
    payload,
    run_id: runId,
    task_id: taskId,
    ts: timestamp,
    visibility,
  });
}

function createTaskLiveExcerptRecord({
  channel,
  content,
  id,
  level = "info",
  metadata = {},
  runId = null,
  source,
  taskId,
  timestamp,
}) {
  return schemas.taskLiveExcerpt.parseTaskLiveExcerpt({
    channel,
    content,
    id,
    level,
    metadata,
    run_id: runId,
    source,
    task_id: taskId,
    ts: timestamp,
  });
}

function createTaskContentRevisionRecord({
  changedFields = [],
  editorId,
  editorType,
  id,
  source = "ui",
  task,
  timestamp,
}) {
  return schemas.taskContentRevision.parseTaskContentRevision({
    acceptance_markdown: task.acceptance_markdown ?? null,
    changed_fields: changedFields,
    created_at: timestamp,
    details_markdown: task.details_markdown ?? null,
    editor_id: editorId,
    editor_type: editorType,
    id,
    operator_brief_markdown: task.operator_brief_markdown ?? null,
    phase: task.phase,
    priority: task.priority,
    source,
    task_id: task.id,
    title: task.title,
  });
}

async function appendTaskCardLiveRecords({
  databasePath,
  taskRunEvents = [],
  taskRunSession = null,
  taskLiveExcerpts = [],
}) {
  if (!taskRunSession && taskRunEvents.length === 0 && taskLiveExcerpts.length === 0) {
    return;
  }

  const sqliteStorage = storage.createSqliteStorage({ databasePath });

  try {
    if (taskRunSession) {
      await sqliteStorage.taskRunSessions.upsert(taskRunSession);
    }
    for (const event of taskRunEvents) {
      await sqliteStorage.taskRunEvents.append(event);
    }
    for (const excerpt of taskLiveExcerpts) {
      await sqliteStorage.taskLiveExcerpts.append(excerpt);
    }
  } finally {
    sqliteStorage.close();
  }
}

function mapTaskExecutionStageToSessionStatus(stage) {
  switch (stage) {
    case "queued":
      return "queued";
    case "preparing":
      return "preparing";
    case "routing":
      return "routing";
    case "executing":
      return "executing";
    case "reviewing":
      return "reviewing";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    default:
      return "executing";
  }
}

function mapTaskExecutionStageToEventType(stage, {
  verdictClass = null,
} = {}) {
  switch (stage) {
    case "queued":
      return "run_queued";
    case "preparing":
      return "run_started";
    case "routing":
      return "route_selected";
    case "executing":
      return "agent_status";
    case "reviewing":
      return "validator_started";
    case "blocked":
      return verdictClass === "ENV_BLOCK" ? "run_failed" : "approval_required";
    case "failed":
      return "run_failed";
    case "completed":
      return verdictClass && verdictClass !== "PASS" ? "run_failed" : "run_completed";
    default:
      return "agent_status";
  }
}

async function updateTaskExecutionProgress({
  active = true,
  adapterId = undefined,
  databasePath = null,
  laneId = undefined,
  runId = undefined,
  sessionId = null,
  stage,
  stateRoot,
  summary = null,
  taskId,
  taskStatus = undefined,
  verdictClass = undefined,
}) {
  const paths = createTaskExecutionProgressPaths(stateRoot, taskId);
  fs.mkdirSync(paths.taskRoot, { recursive: true });

  const existing = readTaskExecutionProgress({
    stateRoot,
    taskId,
  }) ?? {
    active: true,
    adapter_id: null,
    created_at: getSystemTimestamp(),
    run_id: null,
    stage: "queued",
    summary: null,
    task_id: taskId,
    task_status: "PENDING",
    updated_at: getSystemTimestamp(),
    verdict_class: null,
  };

  const updated = {
    ...existing,
    active,
    adapter_id: adapterId === undefined ? existing.adapter_id : adapterId,
    run_id: runId === undefined ? existing.run_id : runId,
    stage,
    summary,
    task_id: taskId,
    task_status: taskStatus === undefined ? existing.task_status : taskStatus,
    updated_at: getSystemTimestamp(),
    verdict_class: verdictClass === undefined ? existing.verdict_class : verdictClass,
  };

  fs.writeFileSync(paths.progressJsonPath, `${JSON.stringify(updated, null, 2)}\n`);
  fs.appendFileSync(
    paths.progressLogPath,
    `[${updated.updated_at}] ${stage}${summary ? `: ${summary}` : ""}\n`,
  );

  const effectiveSessionId = sessionId ?? createTaskRunSessionId(taskId);
  const sessionRecord = createTaskRunSessionRecord({
    activePhase: stage,
    adapterId: updated.adapter_id,
    finishedAt: active ? null : updated.updated_at,
    laneId: laneId === undefined ? null : laneId,
    runId: updated.run_id,
    runtimeFamily: updated.adapter_id,
    sessionId: effectiveSessionId,
    startedAt: existing.created_at ?? updated.updated_at,
    status: mapTaskExecutionStageToSessionStatus(stage),
    summary,
    taskId,
    updatedAt: updated.updated_at,
  });
  const timelineEvent = createTaskRunEventRecord({
    actorId: updated.adapter_id ?? "runtime",
    actorType: "runtime",
    eventType: mapTaskExecutionStageToEventType(stage, {
      verdictClass,
    }),
    id: `${effectiveSessionId}:event:${Date.parse(updated.updated_at)}:${stage}`,
    level: verdictClass === "ENV_BLOCK" || stage === "failed" ? "error" : "info",
    payload: {
      adapter_id: updated.adapter_id,
      lane_id: laneId === undefined ? null : laneId,
      stage,
      summary,
      task_status: updated.task_status,
      verdict_class: verdictClass ?? null,
    },
    runId: updated.run_id,
    taskId,
    timestamp: updated.updated_at,
    visibility: "curated",
  });
  const summaryExcerpt = summary
    ? createTaskLiveExcerptRecord({
      channel: stage === "reviewing" || stage === "completed" ? "validator" : "summary",
      content: summary,
      id: `${effectiveSessionId}:excerpt:${Date.parse(updated.updated_at)}:${stage}`,
      level: verdictClass === "ENV_BLOCK" || stage === "failed" ? "error" : "info",
      metadata: {
        adapter_id: updated.adapter_id,
        stage,
        verdict_class: verdictClass ?? null,
      },
      runId: updated.run_id,
      source: updated.adapter_id ?? "runtime",
      taskId,
      timestamp: updated.updated_at,
    })
    : null;

  if (databasePath) {
    await appendTaskCardLiveRecords({
      databasePath,
      taskRunEvents: [timelineEvent],
      taskRunSession: sessionRecord,
      taskLiveExcerpts: summaryExcerpt ? [summaryExcerpt] : [],
    });
  }

  return {
    progress: updated,
    taskRunEvent: timelineEvent,
    taskRunSession: sessionRecord,
    taskLiveExcerpt: summaryExcerpt,
  };
}

async function markTaskExecutionProgressFailure({
  databasePath = null,
  error,
  sessionId = null,
  stateRoot,
  taskId,
}) {
  const message = error instanceof Error ? error.message : String(error);

  await updateTaskExecutionProgress({
    active: false,
    databasePath,
    sessionId,
    stage: "failed",
    stateRoot,
    summary: message,
    taskId,
    taskStatus: "BLOCKED",
    verdictClass: "ENV_BLOCK",
  });
}








const TASK_LEASE_DEFAULT_TTL_MS = 90_000;
const TASK_LEASE_RENEW_INTERVAL_MS = 30_000;

function createTaskLeasesDirectory(stateRoot) {
  const canonicalStateRoot = pathSafety.canonicalizePath(stateRoot);
  const expectedDirectory = path.join(canonicalStateRoot, "leases");
  const directory = pathSafety.canonicalizePath(expectedDirectory);
  if (directory !== expectedDirectory) {
    throw new Error("task leases directory must not resolve through a filesystem alias");
  }
  return directory;
}

function createTaskLeasePath(stateRoot, taskId) {
  const canonicalTaskId = schemas.task.assertCanonicalTaskId(taskId);
  const leasesDirectory = createTaskLeasesDirectory(stateRoot);
  const expectedPath = path.join(leasesDirectory, `${canonicalTaskId}.json`);
  const leasePath = pathSafety.canonicalizePath(expectedPath);
  if (leasePath !== expectedPath) {
    throw new Error("task lease path must not resolve through a filesystem alias");
  }
  return leasePath;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {

    return error.code === "EPERM";
  }
}

function tryAcquireTaskLease({
  stateRoot,
  taskId,
  holder,
  ttlMs = TASK_LEASE_DEFAULT_TTL_MS,
  reclaimExpiredAlive = true,
}) {
  const leasePath = createTaskLeasePath(stateRoot, taskId);
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  const now = Date.now();
  const record = {
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    holder,
    pid: process.pid,
    task_id: taskId,
  };
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  try {

    const fd = fs.openSync(leasePath, "wx");
    fs.writeSync(fd, serialized);
    fs.closeSync(fd);
    return { lease: record, ok: true, reclaimed: false };
  } catch (error) {
    if (error.code !== "EEXIST") return { error: error.message, ok: false };
  }
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(leasePath, "utf8")); } catch { existing = null; }
  const expiredAt = existing?.expires_at ? Date.parse(existing.expires_at) : NaN;
  const expired = Number.isFinite(expiredAt) && expiredAt <= now;
  const holderDead = existing?.pid ? !isPidAlive(existing.pid) : true;
  if (!existing || holderDead || (expired && reclaimExpiredAlive)) {
    const stalePath = `${leasePath}.stale.${process.pid}.${randomUUID()}`;
    try {


      fs.renameSync(leasePath, stalePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        return { error: error.message, ok: false };
      }
    }
    try {
      const fd = fs.openSync(leasePath, "wx");
      fs.writeSync(fd, serialized);
      fs.closeSync(fd);
      return { lease: record, ok: true, reclaimed: true };
    } catch (error) {
      if (error.code !== "EEXIST") {
        return { error: error.message, ok: false };
      }
      let conflict = null;
      try {
        conflict = JSON.parse(fs.readFileSync(leasePath, "utf8"));
      } catch {
        conflict = null;
      }
      return {
        conflict,
        ok: false,
        reason: "held_by_other",
      };
    } finally {
      try { fs.unlinkSync(stalePath); } catch {  }
    }
  }
  return { conflict: existing, ok: false, reason: "held_by_other" };
}

function renewTaskLease({ stateRoot, taskId, holder, ttlMs = TASK_LEASE_DEFAULT_TTL_MS }) {
  const leasePath = createTaskLeasePath(stateRoot, taskId);
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(leasePath, "utf8")); } catch { return { ok: false, reason: "missing" }; }
  if (existing.holder !== holder) return { ok: false, reason: "holder_mismatch" };
  const now = Date.now();
  const updated = { ...existing, expires_at: new Date(now + ttlMs).toISOString(), pid: process.pid };
  try {
    fs.writeFileSync(leasePath, `${JSON.stringify(updated, null, 2)}\n`);
    return { lease: updated, ok: true };
  } catch (error) {
    return { error: error.message, ok: false };
  }
}

function releaseTaskLease({ stateRoot, taskId, holder }) {
  const leasePath = createTaskLeasePath(stateRoot, taskId);
  try {
    const existing = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    if (existing.holder !== holder) return { ok: false, reason: "holder_mismatch" };
    fs.unlinkSync(leasePath);
    return { ok: true };
  } catch {
    return { ok: false, reason: "missing" };
  }
}

async function acquireProjectExecutionLease({
  allowInherited = true,
  databasePath = null,
  holder,
  stateRoot,
  ttlMs = TASK_LEASE_DEFAULT_TTL_MS,
}) {
  const resolvedDatabasePath = databasePath
    ?? storage.createSqliteDatabasePath(stateRoot);
  const leaseStore = storage.createLifecycleSqliteStore({
    databasePath: resolvedDatabasePath,
  });
  const inheritedHolder = allowInherited
    ? process.env[PROJECT_EXECUTION_LEASE_ENV] ?? null
    : null;
  if (inheritedHolder) {
    try {
      const record = await leaseStore.executionLeases.byScope(
        PROJECT_EXECUTION_LEASE_ID,
      );
      if (
        !record
        || record.holder !== inheritedHolder
        || !isPidAlive(record.pid)
        || ![process.pid, process.ppid].includes(record.pid)
      ) {
        throw lifecycleQueueClaimError(
          "inherited project execution lease is missing, expired, or owned by another process",
          "invalid_inherited_project_execution_lease",
        );
      }
      const inheritedRecord = record.pid === process.pid
        ? record
        : await leaseStore.executionLeases.handoff({
            scope: PROJECT_EXECUTION_LEASE_ID,
            holder: inheritedHolder,
            fromPid: process.ppid,
            toPid: process.pid,
            ttlMs,
          });
      return {
        holder: inheritedHolder,
        inherited: true,
        record: inheritedRecord,
        async release() {},
      };
    } finally {
      leaseStore.close();
    }
  }

  let lease;
  try {
    lease = await leaseStore.executionLeases.acquire({
      scope: PROJECT_EXECUTION_LEASE_ID,
      holder,
      pid: process.pid,
      ttlMs,
    });
  } catch (error) {
    leaseStore.close();
    if (error?.code !== "execution_lease_conflict") {
      throw error;
    }
    const conflict = error.holder
      ? ` (held by ${error.holder}, pid ${error.pid}, expires ${error.expiresAt})`
      : "";
    throw lifecycleQueueClaimError(
      `project execution is already active${conflict}`,
      "project_execution_busy",
      {
        lease_reason: error.reason ?? "held_by_other",
      },
    );
  }
  let ownerPid = process.pid;
  let currentRecord = lease;
  let heartbeatInFlight = null;
  let heartbeatError = null;
  const renewTimer = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = leaseStore.executionLeases.heartbeat({
      scope: PROJECT_EXECUTION_LEASE_ID,
      holder,
      pid: ownerPid,
      ttlMs,
    }).then((record) => {
      currentRecord = record;
      heartbeatError = null;
    }).catch((error) => {
      heartbeatError = error;
      process.stderr.write(
        `[niis] Project execution lease renewal failed: `
        + `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }).finally(() => {
      heartbeatInFlight = null;
    });
  }, TASK_LEASE_RENEW_INTERVAL_MS);
  renewTimer.unref?.();
  let released = false;
  return {
    holder,
    inherited: false,
    get record() {
      return currentRecord;
    },
    get heartbeatError() {
      return heartbeatError;
    },
    async handoff(toPid) {
      if (released) {
        throw lifecycleQueueClaimError(
          "cannot hand off a released project execution lease",
          "project_execution_lease_released",
        );
      }
      if (heartbeatInFlight) {
        await heartbeatInFlight;
      }
      const handedOff = await leaseStore.executionLeases.handoff({
        scope: PROJECT_EXECUTION_LEASE_ID,
        holder,
        fromPid: ownerPid,
        toPid,
        ttlMs,
      });
      ownerPid = handedOff.pid;
      currentRecord = handedOff;
      return handedOff;
    },
    async release() {
      if (released) return false;
      released = true;
      clearInterval(renewTimer);
      if (heartbeatInFlight) {
        await heartbeatInFlight;
      }
      try {
        return await leaseStore.executionLeases.release({
          scope: PROJECT_EXECUTION_LEASE_ID,
          holder,
          pid: ownerPid,
        });
      } finally {
        leaseStore.close();
      }
    },
  };
}

function reclaimExpiredTaskLeases({ stateRoot }) {
  const leasesDir = createTaskLeasesDirectory(stateRoot);
  if (!fs.existsSync(leasesDir)) return { reclaimed: 0, total: 0 };
  const files = fs.readdirSync(leasesDir).filter((file) => {
    if (!file.endsWith(".json")) return false;
    try {
      return `${schemas.task.assertCanonicalTaskId(file.slice(0, -5))}.json` === file;
    } catch {
      return false;
    }
  });
  const now = Date.now();
  let reclaimed = 0;
  for (const file of files) {
    const full = path.join(leasesDir, file);
    try {
      if (fs.lstatSync(full).isSymbolicLink()) {
        continue;
      }
      const lease = JSON.parse(fs.readFileSync(full, "utf8"));
      const expiredAt = lease?.expires_at ? Date.parse(lease.expires_at) : NaN;
      const expired = Number.isFinite(expiredAt) && expiredAt <= now;
      const dead = lease?.pid ? !isPidAlive(lease.pid) : true;
      if (expired || dead) {
        fs.unlinkSync(full);
        reclaimed += 1;
      }
    } catch {
      try { fs.unlinkSync(full); reclaimed += 1; } catch {  }
    }
  }
  return { reclaimed, total: files.length };
}





function createUiPidFilePath(stateRoot) {
  return path.join(stateRoot, "ui.pid");
}

function readUiPidFile(stateRoot) {
  const pidPath = createUiPidFilePath(stateRoot);
  try { return JSON.parse(fs.readFileSync(pidPath, "utf8")); } catch { return null; }
}

function writeUiPidFile(stateRoot) {
  const pidPath = createUiPidFilePath(stateRoot);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2)}\n`);
}

function removeUiPidFile(stateRoot) {
  const pidPath = createUiPidFilePath(stateRoot);
  try {
    const record = JSON.parse(fs.readFileSync(pidPath, "utf8"));
    if (record.pid !== process.pid) return { ok: false, reason: "not_owner" };
  } catch {  }
  try { fs.unlinkSync(pidPath); } catch {  }
  return { ok: true };
}







function createProcessSupervisor() {
  const entries = new Map();
  return {
    register({ taskId, child, startedAt = new Date() }) {
      if (!taskId || !child || typeof child.pid !== "number") return;
      entries.set(taskId, { child, pid: child.pid, startedAt });
      child.on("close", () => { entries.delete(taskId); });
    },
    has(taskId) {
      return entries.has(taskId);
    },
    get(taskId) {
      return entries.get(taskId) ?? null;
    },
    list() {
      const now = Date.now();
      return Array.from(entries.entries()).map(([taskId, entry]) => ({
        pid: entry.pid,
        started_at: entry.startedAt.toISOString(),
        task_id: taskId,
        uptime_ms: now - entry.startedAt.getTime(),
      }));
    },
    async cancel({
      taskId,
      graceMs = 10_000,
      reapMs = 5_000,
      cleanupHoldMs = 10_000,
    }) {
      const entry = entries.get(taskId);
      if (!entry) {
        return {
          forced: false,
          ok: false,
          pid: null,
          reason: "not_found",
          reaped: false,
        };
      }
      if (
        !Number.isFinite(graceMs)
        || graceMs < 0
        || !Number.isFinite(reapMs)
        || reapMs <= 0
        || !Number.isFinite(cleanupHoldMs)
        || cleanupHoldMs <= 0
      ) {
        return {
          forced: false,
          ok: false,
          pid: entry.pid,
          reason: "invalid_cancel_timeout",
          reaped: false,
        };
      }

      let releaseCleanupBarrier;
      let armCleanupBarrierTimeout;
      const cleanupBarrierPromise = new Promise((resolveBarrier) => {
        let released = false;
        let releaseTimer = null;
        releaseCleanupBarrier = () => {
          if (released) return;
          released = true;
          if (releaseTimer) clearTimeout(releaseTimer);
          resolveBarrier();
        };
        armCleanupBarrierTimeout = () => {
          if (released || releaseTimer) return;
          releaseTimer = setTimeout(releaseCleanupBarrier, cleanupHoldMs);
          releaseTimer.unref?.();
        };
      });
      entry.child[SUPERVISED_CANCELLATION_CLEANUP_BARRIER] = {
        promise: cleanupBarrierPromise,
        release: releaseCleanupBarrier,
      };

      return await new Promise((resolve) => {
        let settled = false;
        let forced = false;
        let graceTimer = null;
        let reapTimer = null;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (graceTimer) clearTimeout(graceTimer);
          if (reapTimer) clearTimeout(reapTimer);
          resolve(result);
        };
        const onClose = () => {
          if (settled) return;
          entries.delete(taskId);
          armCleanupBarrierTimeout();
          finish({
            forced,
            ok: true,
            pid: entry.pid,
            reaped: true,
            releaseCleanup: releaseCleanupBarrier,
          });
        };
        entry.child.once("close", onClose);

        try {


          process.kill(entry.pid, "SIGTERM");
        } catch (error) {
          entry.child.off("close", onClose);
          releaseCleanupBarrier();
          finish({
            error: error.message,
            forced: false,
            ok: false,
            pid: entry.pid,
            reason: "kill_failed",
            reaped: false,
          });
          return;
        }

        graceTimer = setTimeout(() => {
          if (settled) return;
          forced = true;
          try {
            process.kill(entry.pid, "SIGKILL");
          } catch {


          }
          reapTimer = setTimeout(() => {
            if (settled) return;
            entry.child.off("close", onClose);
            releaseCleanupBarrier();
            finish({
              forced: true,
              ok: false,
              pid: entry.pid,
              reason: "reap_timeout",
              reaped: false,
            });
          }, reapMs);
          reapTimer.unref?.();
        }, graceMs);
        graceTimer.unref?.();
      });
    },
    async cancelAll({
      afterReap,
      beforeSignal,
      graceMs = 2_000,
      reapMs = 5_000,
    } = {}) {
      if (
        typeof beforeSignal !== "function"
        || typeof afterReap !== "function"
      ) {
        throw new Error(
          "cancelAll requires durable beforeSignal and afterReap hooks",
        );
      }
      const ids = Array.from(entries.keys());
      const results = [];
      for (const taskId of ids) {
        const captured = entries.get(taskId);
        if (!captured) continue;
        let preparation;
        try {
          preparation = await beforeSignal({
            pid: captured.pid,
            taskId,
          });
          if (preparation === null || preparation === undefined) {
            throw new Error("beforeSignal did not return durable cancellation evidence");
          }
        } catch (error) {
          results.push({
            error: error instanceof Error ? error.message : String(error),
            finalized: false,
            forced: false,
            ok: false,
            pid: captured.pid,
            pre_signal_persisted: false,
            reaped: false,
            reason: "pre_signal_failed",
            signal_sent: false,
            task_id: taskId,
          });
          continue;
        }

        const current = entries.get(taskId);
        let cancellation;
        if (!current) {
          cancellation = {
            forced: false,
            ok: true,
            pid: captured.pid,
            reaped: true,
            reason: "closed_before_signal",
          };
        } else if (current.pid !== captured.pid) {
          results.push({
            finalized: false,
            forced: false,
            ok: false,
            pid: captured.pid,
            pre_signal_persisted: true,
            preparation,
            reaped: false,
            reason: "supervised_owner_changed",
            signal_sent: false,
            task_id: taskId,
          });
          continue;
        } else {
          cancellation = await this.cancel({
            graceMs,
            reapMs,
            taskId,
          });
        }

        let takeover = null;
        let takeoverError = null;
        try {
          if (
            cancellation.ok
            && cancellation.reaped
            && cancellation.pid === captured.pid
          ) {
            takeover = await afterReap({
              cancellation,
              preparation,
              taskId,
            });
          }
        } catch (error) {
          takeoverError = error instanceof Error ? error.message : String(error);
        } finally {
          cancellation.releaseCleanup?.();
        }
        const finalized = takeoverError === null && takeover !== null;
        results.push({
          cancellation,
          error: takeoverError ?? cancellation.error ?? null,
          finalized,
          forced: cancellation.forced,
          ok: cancellation.ok && cancellation.reaped && finalized,
          pid: captured.pid,
          pre_signal_persisted: true,
          preparation,
          reaped: cancellation.reaped,
          reason:
            takeoverError
              ? "durable_takeover_failed"
              : cancellation.ok && cancellation.reaped
                ? finalized
                  ? "cancelled"
                  : "durable_takeover_missing"
                : cancellation.reason ?? "cancel_failed",
          signal_sent: cancellation.reason !== "closed_before_signal",
          task_id: taskId,
          takeover,
        });
      }
      return results;
    },
  };
}

async function cancelAllSupervisedLifecycleTasks({
  graceMs = 2_000,
  reapMs = 5_000,
  requestedBy = `ui-shutdown:${process.pid}`,
  supervisor,
  workspaceRoot,
} = {}) {
  if (
    !supervisor
    || typeof supervisor.cancelAll !== "function"
  ) {
    throw new Error("supervisor with cancelAll() is required");
  }
  const plan = createInitPlan(workspaceRoot);
  return supervisor.cancelAll({
    graceMs,
    reapMs,
    beforeSignal: ({ pid, taskId }) =>
      requestLifecycleCancellation({
        databasePath: plan.databasePath,
        requestedBy,
        stateRoot: plan.stateRoot,
        supervisedPid: pid,
        taskId,
      }),
    afterReap: ({ cancellation, taskId }) =>
      cancelLifecycleTask({
        databasePath: plan.databasePath,
        reason: "cancelled during supervised UI shutdown",
        stateRoot: plan.stateRoot,
        taskId,
        terminatedPid: cancellation.pid,
      }),
  });
}

const UI_SHUTDOWN_CANCEL_GRACE_MS = 2_000;
const UI_SHUTDOWN_CANCEL_REAP_MS = 5_000;
const UI_SHUTDOWN_FORCE_EXIT_MS =
  UI_SHUTDOWN_CANCEL_GRACE_MS
  + UI_SHUTDOWN_CANCEL_REAP_MS
  + 3_000;







function createAutonomousWorkerController({ liveBus, supervisor, workspaceRoot }) {
  let mode = "semi";
  let readinessActivation = null;
  let tickTimer = null;
  let tickRunning = false;
  let tickConfig = { maxConcurrent: 1, pollIntervalMs: 5000 };





  const readConfigMode = () => {
    try {
      const config = getAutonomousWorkerConfig({ workspaceRoot });
      tickConfig = { maxConcurrent: 1, pollIntervalMs: config.poll_interval_ms };
      return config.enabled ? "auto" : "semi";
    } catch {
      return "semi";
    }
  };

  const tick = async () => {
    if (mode !== "auto" || tickRunning) return;
    tickRunning = true;
    try {
      if (!readinessActivation) {
        readinessActivation = await assertDaemonReadinessForWorkspace(
          workspaceRoot,
        );
      }
      const result = await runLifecycleSchedulerOnce({
        trigger: "ui-daemon",
        workspaceRoot,
      });
      if (result.claimed && liveBus) {
        liveBus.publish({
          queue_state: result.queue_state,
          task_id: result.task_id,
          type: "task.lifecycle.finished",
        });
      }
    } catch (error) {
      process.stderr.write(`[niis ui-worker] tick failed: ${error instanceof Error ? error.message : String(error)}\n`);
      if (
        error?.code === "daemon_readiness_required"
        || error?.code === "queue_projection_requires_operator"
      ) {
        mode = "semi";
        if (tickTimer !== null) {
          clearInterval(tickTimer);
          tickTimer = null;
        }
        try {
          writeProjectConfigUpdate(workspaceRoot, (current) => {
            current.autonomous_worker = {
              ...(current.autonomous_worker ?? {}),
              enabled: false,
              max_concurrent: 1,
            };
            return current;
          });
        } catch {

        }
      }
    } finally {
      tickRunning = false;
    }
  };

  return {
    get mode() { return mode; },
    get tickConfig() { return tickConfig; },
    async start() {
      mode = readConfigMode();
      if (mode === "auto") {
        try {
          readinessActivation = await assertDaemonReadinessForWorkspace(
            workspaceRoot,
          );
        } catch (error) {
          mode = "semi";
          readinessActivation = null;
          try {
            writeProjectConfigUpdate(workspaceRoot, (current) => {
              current.autonomous_worker = {
                ...(current.autonomous_worker ?? {}),
                enabled: false,
                max_concurrent: 1,
              };
              return current;
            });
          } catch {

          }
          process.stderr.write(
            `[niis ui-worker] auto mode disabled: `
            + `${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      if (mode === "auto" && tickTimer === null) {
        process.stderr.write(`[niis ui-worker] auto mode active: poll ${tickConfig.pollIntervalMs}ms, max ${tickConfig.maxConcurrent} concurrent.\n`);
        tickTimer = setInterval(tick, tickConfig.pollIntervalMs);
        await tick();
      } else if (mode === "semi") {
        process.stderr.write(`[niis ui-worker] semi-auto mode: operator triggers start-task manually.\n`);
      }
    },
    stop() {
      if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      readinessActivation = null;
    },
    async setMode(nextMode) {
      if (nextMode !== "auto" && nextMode !== "semi") throw new Error(`invalid mode: ${nextMode}`);
      if (nextMode === "auto") {
        readinessActivation = await assertDaemonReadinessForWorkspace(
          workspaceRoot,
        );
      } else {
        readinessActivation = null;
      }
      if (mode === nextMode) return { changed: false, mode };
      mode = nextMode;
      const enabled = mode === "auto";
      try {
        writeProjectConfigUpdate(workspaceRoot, (current) => {
          current.autonomous_worker = {
            ...(current.autonomous_worker ?? {}),
            enabled,
            max_concurrent: 1,
          };
          return current;
        });
      } catch (error) {
        process.stderr.write(`[niis ui-worker] failed to persist mode: ${error.message}\n`);
      }
      if (enabled) {
        const cfg = getAutonomousWorkerConfig({ workspaceRoot });
        tickConfig = { maxConcurrent: 1, pollIntervalMs: cfg.poll_interval_ms };
        if (tickTimer === null) {
          tickTimer = setInterval(tick, tickConfig.pollIntervalMs);
          await tick();
        }
        process.stderr.write(`[niis ui-worker] switched to auto.\n`);
      } else if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
        process.stderr.write(`[niis ui-worker] switched to semi.\n`);
      }
      if (liveBus) liveBus.publish({ mode, type: "project.mode.changed" });
      return { changed: true, mode };
    },
  };
}




async function runAutonomousWorkerTickWithSupervisor({ liveBus = null, maxConcurrent, spawnedRecently, spawnDedupTtlMs, stateRoot, supervisor, workspaceRoot }) {
  const now = Date.now();
  for (const [taskId, ts] of spawnedRecently) {
    if (now - ts > spawnDedupTtlMs) spawnedRecently.delete(taskId);
  }
  const inProgressCount = taskQueue.listState({
    state: "in_progress",
    stateRoot,
  }).length;
  const availableSlots = maxConcurrent - inProgressCount - spawnedRecently.size;
  if (availableSlots <= 0) return;
  const pendingEntries = taskQueue.listState({
    state: "pending",
    stateRoot,
  })
    .map((entry) => {
      try {
        return {
          entry,
          mtimeMs: fs.statSync(entry.file).mtimeMs,
        };
      } catch {
        return { entry, mtimeMs: 0 };
      }
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map(({ entry }) => entry);
  let spawned = 0;
  for (const entry of pendingEntries) {
    if (spawned >= availableSlots) break;
    const taskId = entry.task_id;
    if (spawnedRecently.has(taskId) || supervisor.has(taskId)) continue;
    if (taskQueue.findTaskState({ stateRoot, taskId })?.state === "in_progress") {
      continue;
    }
    process.stderr.write(`[niis ui-worker] spawning start-task for ${taskId}\n`);
    try {
      await spawnSupervisedStartTask({
        liveBus,
        supervisor,
        taskId,
        trigger: "ui-daemon",
        workspaceRoot,
      });
      spawnedRecently.set(taskId, now);
      spawned += 1;
    } catch (error) {
      process.stderr.write(`[niis ui-worker] spawn failed for ${taskId}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}










function createLiveLogPublisher({ databasePath, liveBus, stream, taskId }) {
  const MAX_CHUNK_BYTES = 16 * 1024;
  const FLUSH_IDLE_MS = 500;
  let buffer = "";
  let idleTimer = null;
  let seq = 0;
  let closed = false;

  const emitOne = (chunk) => {
    if (chunk === "") return;
    const now = getSystemNow();
    const ts = now.toISOString();
    seq += 1;
    const event = {
      actor_id: stream === "stderr" ? "supervisor.stderr" : "supervisor.stdout",
      actor_type: "runtime",
      event_type: "run_log",
      id: `${taskId}:run-log:${stream}:${Date.parse(ts)}:${seq}`,
      level: stream === "stderr" ? "warning" : "info",
      payload: { chunk, stream },
      run_id: null,
      task_id: taskId,
      ts,
      visibility: "verbose",
    };
    const sqliteStorage = storage.createSqliteStorage({ databasePath });
    try {
      sqliteStorage.taskRunEvents.append(event).catch(() => {});
    } finally {
      try { sqliteStorage.close(); } catch {  }
    }
    if (liveBus) {
      try { liveBus.publish({ task_id: taskId, type: "task.run.log" }); } catch {  }
    }
  };





  const flush = () => {
    if (closed || buffer === "") return;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    let remaining = buffer;
    buffer = "";
    while (remaining.length > MAX_CHUNK_BYTES) {
      const slice = remaining.slice(0, MAX_CHUNK_BYTES);
      const lastNewline = slice.lastIndexOf("\n");
      const cut = lastNewline > MAX_CHUNK_BYTES / 2 ? lastNewline + 1 : MAX_CHUNK_BYTES;
      emitOne(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (remaining !== "") emitOne(remaining);
  };

  return {
    write(text) {
      if (closed) return;
      buffer += text;
      if (buffer.length >= MAX_CHUNK_BYTES || buffer.includes("\n")) {
        flush();
      } else {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(flush, FLUSH_IDLE_MS);
      }
    },
    close() {
      if (closed) return;

      flush();
      closed = true;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    },
  };
}





async function spawnSupervisedStartTask({
  attemptId = null,
  liveBus = null,
  spawnChild = spawn,
  supervisor,
  taskId,
  trigger = "ui",
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const plan = createInitPlan(workspaceRoot);
  const stateRoot = plan.stateRoot;
  const leaseHolder =
    `ui-supervisor:${process.pid}:${taskId}:${randomUUID()}`;
  const lease = tryAcquireTaskLease({ holder: leaseHolder, stateRoot, taskId });
  if (!lease.ok) {
    const conflict = lease.conflict
      ? ` (held by ${lease.conflict.holder}, pid ${lease.conflict.pid}, expires ${lease.conflict.expires_at})`
      : "";
    throw new Error(`Failed to acquire task lease for ${taskId}${conflict}`);
  }
  let projectExecutionLease;
  try {
    projectExecutionLease = await acquireProjectExecutionLease({
      allowInherited: false,
      holder: leaseHolder,
      stateRoot,
    });
  } catch (error) {
    releaseTaskLease({ holder: leaseHolder, stateRoot, taskId });
    throw error;
  }
  try {
  await enqueueLifecycleTask({
    databasePath: plan.databasePath,
    metadata: {
      requeued_by: `ui:${trigger}`,
    },
    priority: "medium",
    stateRoot,
    taskId,
  });
  const preferences = taskIntake.readRuntimePreferences({ stateRoot, taskId });
  const progressPaths = createTaskExecutionProgressPaths(stateRoot, taskId);
  fs.mkdirSync(progressPaths.taskRoot, { recursive: true });
  fs.writeFileSync(progressPaths.progressLogPath, "");
  await updateTaskExecutionProgress({
    active: true,
    databasePath: plan.databasePath,
    sessionId: createTaskRunSessionId(taskId),
    stage: "queued",
    stateRoot,
    summary: "Task queued from the control plane supervisor.",
    taskId,
    taskStatus: "IN_PROGRESS",
  });
  const childArgs = [
    cliEntrypoint,
    "start-task",
    "--task-id",
    taskId,
    "--trigger",
    trigger,
  ];
  if (attemptId) childArgs.push("--attempt-id", attemptId);
  if (preferences.executor_runtime) childArgs.push("--executor-runtime", preferences.executor_runtime);
  if (preferences.planner_runtime) childArgs.push("--planner-runtime", preferences.planner_runtime);
  const logStream = fs.createWriteStream(progressPaths.progressLogPath, {
    autoClose: true,
    fd: fs.openSync(progressPaths.progressLogPath, "a"),
  });
  const taskTag = `[task ${taskId}]`;
  const stdoutPublisher = createLiveLogPublisher({
    databasePath: plan.databasePath,
    liveBus,
    stream: "stdout",
    taskId,
  });
  const stderrPublisher = createLiveLogPublisher({
    databasePath: plan.databasePath,
    liveBus,
    stream: "stderr",
    taskId,
  });
  const child = spawnChild(process.execPath, childArgs, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      [UI_BACKGROUND_ENV]: "1",


      NIIS_LEASE_HOLDER: leaseHolder,
      [PROJECT_EXECUTION_LEASE_ENV]: projectExecutionLease.holder,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childClosed = child.exitCode !== null || child.signalCode !== null;
  let handoffPromise = null;
  let renewTimer = null;
  let cleanupPromise = null;
  const cleanupChild = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
      try { stdoutPublisher.close(); } catch {  }
      try { stderrPublisher.close(); } catch {  }
      try {
        logStream.end();
        await finished(logStream);
      } catch {  }
      if (handoffPromise) {
        try {
          await handoffPromise;
        } catch {

        }
      }
      const cancellationBarrier =
        child[SUPERVISED_CANCELLATION_CLEANUP_BARRIER] ?? null;
      if (cancellationBarrier?.promise) {
        await cancellationBarrier.promise;
      }
      try {
        await projectExecutionLease.release();
      } catch (error) {
        process.stderr.write(
          `[niis supervisor] Project execution lease release failed: `
          + `${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        releaseTaskLease({ holder: leaseHolder, stateRoot, taskId });
      }
    })();
    return cleanupPromise;
  };
  const observeChildClose = () => {
    childClosed = true;
    void cleanupChild();
  };



  child.once("close", observeChildClose);
  child.once("error", observeChildClose);
  supervisor.register({ child, startedAt: new Date(), taskId });
  handoffPromise = projectExecutionLease.handoff(child.pid);
  try {
    await handoffPromise;
  } catch (error) {
    try {
      child.kill("SIGTERM");
    } catch {

    }
    await cleanupChild();
    throw error;
  }
  if (childClosed || child.exitCode !== null || child.signalCode !== null) {
    await cleanupChild();
    throw new Error(`supervised start-task child exited before setup completed: ${taskId}`);
  }
  const tee = (stream, publisher) => {
    if (!stream) return;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      try { logStream.write(chunk); } catch {  }
      try { process.stderr.write(`${taskTag} ${chunk}`); } catch {  }
      try { publisher.write(chunk); } catch {  }
    });
  };
  tee(child.stdout, stdoutPublisher);
  tee(child.stderr, stderrPublisher);



  renewTimer = setInterval(() => {
    const result = renewTaskLease({ holder: leaseHolder, stateRoot, taskId });
    if (!result.ok) {
      process.stderr.write(`[niis supervisor] Lease renew failed for ${taskId}: ${result.reason ?? result.error ?? "unknown"}\n`);
    }
  }, TASK_LEASE_RENEW_INTERVAL_MS);
  return child;
  } catch (error) {
    await projectExecutionLease.release();
    releaseTaskLease({ holder: leaseHolder, stateRoot, taskId });
    throw error;
  }
}

async function spawnUiBackgroundStartTask({
  taskId,
  trigger = "ui",
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const plan = createInitPlan(workspaceRoot);
  const stateRoot = plan.stateRoot;
  const preferences = taskIntake.readRuntimePreferences({
    stateRoot,
    taskId,
  });
  const progressPaths = createTaskExecutionProgressPaths(stateRoot, taskId);
  fs.mkdirSync(progressPaths.taskRoot, { recursive: true });
  fs.writeFileSync(progressPaths.progressLogPath, "");
  await updateTaskExecutionProgress({
    active: true,
    databasePath: plan.databasePath,
    sessionId: createTaskRunSessionId(taskId),
    stage: "queued",
    stateRoot,
    summary: "Task queued from the control plane.",
    taskId,
    taskStatus: "IN_PROGRESS",
  });

  const childArgs = [
    cliEntrypoint,
    "start-task",
    "--task-id",
    taskId,
    "--trigger",
    trigger,
  ];
  if (preferences.executor_runtime) {
    childArgs.push("--executor-runtime", preferences.executor_runtime);
  }
  if (preferences.planner_runtime) {
    childArgs.push("--planner-runtime", preferences.planner_runtime);
  }




  const logStream = fs.createWriteStream(progressPaths.progressLogPath, {
    autoClose: true,
    fd: fs.openSync(progressPaths.progressLogPath, "a"),
  });
  const child = spawn(process.execPath, childArgs, {
    cwd: workspaceRoot,
    detached: true,
    env: {
      ...process.env,
      [UI_BACKGROUND_ENV]: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const taskTag = `[task ${taskId}]`;
  const tee = (stream) => {
    if (!stream) return;
    stream.on("data", (chunk) => {
      try { logStream.write(chunk); } catch {  }
      try { process.stderr.write(`${taskTag} ${chunk}`); } catch {  }
    });
  };
  tee(child.stdout);
  tee(child.stderr);
  child.on("close", () => {
    try { logStream.end(); } catch {  }
  });
  child.unref();
}

function resolveUiTaskWorkbenchArtifactTarget(route, snapshot = {}) {
  if (!route) {
    return null;
  }

  if (route.kind === "task-detail") {
    return route.taskId ?? null;
  }

  if (route.kind !== "run-detail") {
    return null;
  }

  const runs = Array.isArray(snapshot.runs) ? snapshot.runs.map((run) => schemas.run.parseRunRecord(run)) : [];
  const run = runs.find((entry) => entry.id === route.runId) ?? null;
  return run?.task_id ?? null;
}

function normalizeUiRoute(pathname) {
  if (pathname === "/" || pathname === "/index.html") {
    return Object.freeze({
      kind: "home",
      path: pathname,
      runId: null,
      taskId: null,
    });
  }

  if (pathname === "/tasks") {
    return Object.freeze({
      kind: "tasks",
      path: pathname,
      runId: null,
      taskId: null,
    });
  }

  if (pathname === "/tasks/new") {
    return Object.freeze({
      kind: "task-new",
      path: pathname,
      runId: null,
      taskId: null,
    });
  }

  if (pathname === "/approvals") {
    return Object.freeze({
      kind: "approvals",
      path: pathname,
      runId: null,
      taskId: null,
    });
  }

  const approvalActionMatch = pathname.match(/^\/approvals\/[^/]+$/);
  if (approvalActionMatch) {
    return Object.freeze({
      kind: "approvals",
      path: pathname,
      runId: null,
      taskId: null,
    });
  }

  if (pathname === "/project") {
    return Object.freeze({
      kind: "project",
      path: pathname,
      runId: null,
      taskId: null,
    });
  }

  if (pathname === "/agents") {
    return Object.freeze({
      kind: "agents",
      path: pathname,
      runId: null,
      taskId: null,
    });
  }

  if (pathname === "/insights") {
    return Object.freeze({
      kind: "insights",
      path: pathname,
      runId: null,
      taskId: null,
    });
  }

  const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
  if (taskMatch) {
    return Object.freeze({
      kind: "task-detail",
      path: pathname,
      runId: null,
      taskId: decodeURIComponent(taskMatch[1]),
    });
  }

  const runMatch = pathname.match(/^\/runs\/([^/]+)$/);
  if (runMatch) {
    return Object.freeze({
      kind: "run-detail",
      path: pathname,
      runId: decodeURIComponent(runMatch[1]),
      taskId: null,
    });
  }

  return null;
}

async function readUiRequestFormData(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  return new URLSearchParams(chunks.join(""));
}

function buildUiRedirectTarget(pathname, { error = null, notice = null } = {}) {
  const params = new URLSearchParams();

  if (notice) {
    params.set("notice", notice);
  }

  if (error) {
    params.set("error", error);
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function redirectUiResponse(response, pathname, options = {}) {
  response.writeHead(303, {
    "cache-control": "no-store",
    location: buildUiRedirectTarget(pathname, options),
  });
  response.end();
}

function writeUiHtmlResponse(response, html, statusCode = 200) {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function writeUiJsonResponse(response, payload, statusCode = 200) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function wantsUiJsonResponse(request, requestUrl) {
  if (requestUrl.searchParams.get("format") === "json") return true;
  const accept = String(request.headers.accept ?? "");
  if (accept.split(",").some((entry) => entry.trim().toLowerCase().startsWith("application/json"))) return true;
  return String(request.headers["x-requested-with"] ?? "").toLowerCase() === "fetch";
}

function createUiLiveBus() {
  const emitter = new EventEmitter();

  return Object.freeze({
    on(listener) {
      emitter.on("task-update", listener);
      return () => emitter.off("task-update", listener);
    },
    publish(event) {
      emitter.emit("task-update", Object.freeze({
        task_id: event.task_id ?? null,
        run_id: event.run_id ?? null,
        type: event.type ?? "task.card.updated",
      }));
    },
  });
}

function computeWebSocketAcceptKey(clientKey) {
  return createHash("sha1")
    .update(`${clientKey}${WEBSOCKET_GUID}`, "utf8")
    .digest("base64");
}

function writeWebSocketTextFrame(socket, text) {
  const payload = Buffer.from(String(text), "utf8");
  let header = null;

  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

function closeWebSocket(socket) {
  try {
    socket.end(Buffer.from([0x88, 0x00]));
  } catch {
    socket.destroy();
  }
}

function buildTaskCardApiPayload({
  spec = {},
  taskId,
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const taskCard = loadUiTaskCard({
    connectionState: "ready",
    spec,
    taskId,
    workspaceRoot,
  });

  if (!taskCard) {
    return null;
  }

  return taskCard;
}

async function buildTaskRunEventsApiPayload({
  afterTs = null,
  eventTypes = null,
  limit = 500,
  spec = {},
  runId = null,
  taskId,
  workspaceRoot = resolveWorkspaceRoot(),
}) {





  if (spec && spec.snapshot) {
    const allEvents = Array.isArray(spec.snapshot.taskRunEvents) ? spec.snapshot.taskRunEvents : [];
    const afterMs = afterTs ? Date.parse(afterTs) : null;
    const events = allEvents
      .map((event) => schemas.taskRunEvent.parseTaskRunEvent(event))
      .filter((event) => {
        if (event.task_id !== taskId) return false;
        if (runId !== null && event.run_id !== runId) return false;
        if (Array.isArray(eventTypes) && eventTypes.length > 0 && !eventTypes.includes(event.event_type)) return false;
        if (Number.isFinite(afterMs)) {
          const ts = Date.parse(event.ts);
          if (!Number.isFinite(ts) || ts <= afterMs) return false;
        }
        return true;
      });
    return Object.freeze({
      events,
      run_id: runId,
      task_id: taskId,
      version: `${events.at(-1)?.ts ?? "none"}|${events.length}`,
    });
  }
  const plan = createInitPlan(workspaceRoot);
  if (!fs.existsSync(plan.databasePath)) {
    return Object.freeze({ events: [], run_id: runId, task_id: taskId, version: "none|0" });
  }
  const sqliteStorage = storage.createSqliteStorage({ databasePath: plan.databasePath, readonly: true });
  let events;
  try {
    events = await sqliteStorage.taskRunEvents.byTaskFiltered({ afterTs, eventTypes, limit, taskId });
    if (runId !== null) {
      events = events.filter((event) => event.run_id === runId);
    }
  } finally {
    sqliteStorage.close();
  }
  return Object.freeze({
    events,
    run_id: runId,
    task_id: taskId,
    version: `${events.at(-1)?.ts ?? "none"}|${events.length}`,
  });
}

function buildTaskRunLogExcerptsApiPayload({
  spec = {},
  runId,
  taskId,
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const snapshot = loadUiSnapshot(spec, workspaceRoot);
  const allExcerpts = Array.isArray(snapshot.taskLiveExcerpts) ? snapshot.taskLiveExcerpts : [];
  const excerpts = allExcerpts
    .map((excerpt) => schemas.taskLiveExcerpt.parseTaskLiveExcerpt(excerpt))
    .filter((excerpt) => excerpt.task_id === taskId && excerpt.run_id === runId);

  return Object.freeze({
    excerpts,
    run_id: runId,
    task_id: taskId,
    version: `${excerpts.at(-1)?.ts ?? "none"}|${excerpts.length}`,
  });
}

function createUiLiveSocketHub({
  authorizeUpgrade = null,
  liveBus,
  spec = {},
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const clients = new Set();
  const unsubscribe = liveBus.on((event) => {
    for (const client of clients) {
      if (client.taskId && client.taskId !== event.task_id) {
        continue;
      }
      try {
        writeWebSocketTextFrame(client.socket, JSON.stringify({
          run_id: event.run_id ?? null,
          task_id: event.task_id ?? null,
          type: event.type ?? "task.card.updated",
        }));
      } catch {
        client.socket.destroy();
      }
    }
  });

  const pollTimer = setInterval(() => {
    for (const client of clients) {
      try {
        const taskCard = buildTaskCardApiPayload({
          spec,
          taskId: client.taskId,
          workspaceRoot,
        });

        if (!taskCard) {
          continue;
        }

        if (taskCard.version !== client.lastVersion) {
          client.lastVersion = taskCard.version;
          writeWebSocketTextFrame(client.socket, JSON.stringify({
            run_id: client.runId,
            task_id: client.taskId,
            type: "task.card.updated",
            version: taskCard.version,
          }));
        }
      } catch {
        client.socket.destroy();
      }
    }
  }, LIVE_SOCKET_POLL_MS);
  pollTimer.unref?.();

  function removeClient(client) {
    clients.delete(client);
  }

  return Object.freeze({
    close() {
      clearInterval(pollTimer);
      unsubscribe();
      for (const client of clients) {
        client.socket.destroy();
      }
      clients.clear();
    },
    handleUpgrade(request, socket) {
      if (typeof authorizeUpgrade === "function" && !authorizeUpgrade(request)) {
        socket.write([
          "HTTP/1.1 403 Forbidden",
          "Connection: close",
          "Content-Length: 0",
          "",
          "",
        ].join("\r\n"));
        socket.destroy();
        return;
      }
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/__niis/live/ws") {
        socket.destroy();
        return;
      }

      const websocketKey = request.headers["sec-websocket-key"];
      if (typeof websocketKey !== "string" || websocketKey.trim() === "") {
        socket.destroy();
        return;
      }

      const taskId = requestUrl.searchParams.get("task_id") ?? null;
      const runId = requestUrl.searchParams.get("run_id") ?? null;
      const taskCard = taskId
        ? buildTaskCardApiPayload({
          spec,
          taskId,
          workspaceRoot,
        })
        : null;
      const acceptKey = computeWebSocketAcceptKey(websocketKey.trim());

      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "",
        "",
      ].join("\r\n"));

      const client = {
        lastVersion: taskCard?.version ?? null,
        runId,
        socket,
        taskId,
      };
      clients.add(client);
      socket.on("close", () => removeClient(client));
      socket.on("end", () => removeClient(client));
      socket.on("error", () => removeClient(client));
      socket.on("data", (buffer) => {
        if ((buffer?.[0] & 0x0f) === 0x8) {
          closeWebSocket(socket);
          removeClient(client);
        }
      });

      writeWebSocketTextFrame(socket, JSON.stringify({
        run_id: runId,
        task_id: taskId,
        type: "connected",
        version: taskCard?.version ?? null,
      }));
    },
  });
}

function buildControlPlaneHtml({
  error = null,
  mutableState = false,
  notice = null,
  operatorDecisions = null,
  taskCard = null,
  taskNewPreview = null,
  taskWorkbenchArtifacts = null,
  projectContext,
  queueSummary = null,
  route,
  scriptNonce = null,
  snapshot,
  subtaskProgressByTaskId = null,
  title = "Niis Local Control Plane",
  workerMode = "semi",
  returnTo = "",
}) {
  return buildLocalControlPlaneDocument({
    error,
    mutableState,
    notice,
    operatorDecisions,
    taskCard,
    taskNewPreview,
    taskWorkbenchArtifacts,
    projectContext,
    queueSummary,
    returnTo,
    route,
    scriptNonce,
    snapshot,
    subtaskProgressByTaskId,
    title,
    workerMode,
  });
}

async function deleteTaskEverywhere({ taskId, workspaceRoot = resolveWorkspaceRoot(), force = false }) {


  void force;
  const canonicalTaskId = schemas.task.assertCanonicalTaskId(taskId);
  const plan = createInitPlan(workspaceRoot);
  const stateRoot = plan.stateRoot;
  if (!fs.existsSync(stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }
  if (!fs.existsSync(plan.databasePath)) {
    const error = new Error("state database is missing; refusing task deletion");
    error.code = "task_delete_state_missing";
    throw error;
  }




  const canonicalWorkspaceRoot = fs.realpathSync.native(path.resolve(workspaceRoot));
  const expectedStateRoot = path.join(canonicalWorkspaceRoot, ".niis");
  const canonicalStateRoot = fs.realpathSync.native(stateRoot);
  if (
    canonicalStateRoot !== expectedStateRoot
    || fs.lstatSync(stateRoot).isSymbolicLink()
  ) {
    const error = new Error(
      "state root must be the real .niis directory inside the workspace",
    );
    error.code = "unsafe_task_delete_target";
    throw error;
  }
  const intakeRoot = path.join(canonicalStateRoot, "intake");
  const expectedTaskRoot = path.join(intakeRoot, canonicalTaskId);
  const intakePaths = taskIntake.createTaskIntakePaths(
    canonicalStateRoot,
    canonicalTaskId,
  );
  const relativeTaskRoot = path.relative(intakeRoot, intakePaths.task_root);
  if (
    intakePaths.task_root !== expectedTaskRoot
    || relativeTaskRoot !== canonicalTaskId
    || path.isAbsolute(relativeTaskRoot)
  ) {
    const error = new Error("computed task intake target is not the exact expected child");
    error.code = "unsafe_task_delete_target";
    throw error;
  }
  if (
    (fs.existsSync(intakeRoot) && fs.lstatSync(intakeRoot).isSymbolicLink())
    || (
      fs.existsSync(expectedTaskRoot)
      && (
        fs.lstatSync(expectedTaskRoot).isSymbolicLink()
        || fs.realpathSync.native(expectedTaskRoot) !== expectedTaskRoot
      )
    )
  ) {
    const error = new Error("task intake deletion target must not use symlink aliases");
    error.code = "unsafe_task_delete_target";
    throw error;
  }

  const dbStorage = storage.createSqliteStorage({ databasePath: plan.databasePath });
  let exactTask = null;
  try {
    const tasks = await dbStorage.tasks.list();
    exactTask = tasks.find((task) => task.id === canonicalTaskId) ?? null;
    if (!exactTask) {
      const error = new Error(`task ${canonicalTaskId} does not exist; refusing deletion`);
      error.code = "task_not_found";
      throw error;
    }
  } finally {
    dbStorage.close();
  }

  const removed = [];
  const lifecycleStore = storage.createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  try {
    const activeAttempt = await lifecycleStore.attempts.activeByTask(
      canonicalTaskId,
    );
    if (activeAttempt) {
      const error = new Error(
        `task ${canonicalTaskId} has active attempt ${activeAttempt.id} `
        + `at ${activeAttempt.stage}; cancel it before deletion`,
      );
      error.code = "task_in_progress";
      error.attempt_id = activeAttempt.id;
      error.attempt_stage = activeAttempt.stage;
      throw error;
    }

    const authoritativeQueueEntry = await lifecycleStore.queue.byTask(
      canonicalTaskId,
    );
    if (authoritativeQueueEntry?.state === "CLAIMED") {
      const error = new Error(
        `task ${canonicalTaskId} has an authoritative queue claim by `
        + `${authoritativeQueueEntry.claimed_by}; cancel it before deletion`,
      );
      error.code = "task_in_progress";
      error.claimed_by = authoritativeQueueEntry.claimed_by;
      error.claim_expires_at = authoritativeQueueEntry.claim_expires_at;
      throw error;
    }

    const projectionEntry = taskQueue.findTaskState({
      stateRoot,
      taskId: canonicalTaskId,
    });
    if (projectionEntry?.state === "in_progress") {
      const pid = Number.isInteger(projectionEntry.data?.pid)
        ? projectionEntry.data.pid
        : null;
      if (pid !== null && taskQueue.isPidAlive(pid)) {
        const error = new Error(
          `task ${canonicalTaskId} is currently being executed by pid ${pid}; `
          + "cancel it before deletion",
        );
        error.code = "task_in_progress";
        error.pid = pid;
        throw error;
      }
    }



    const queueEntry = await lifecycleStore.queue.remove({
      taskId: canonicalTaskId,
    });
    await reconcileFileQueueProjection({
      applyPending: true,
      stateRoot,
      store: lifecycleStore,
    });
    if (queueEntry) {
      removed.push("queue_entry");
    }
  } finally {
    lifecycleStore.close();
  }

  const mutableStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
  });
  try {
    const result = await mutableStorage.tasks.deleteById(canonicalTaskId);
    if (result.counts?.tasks !== 1) {
      const error = new Error(
        `task ${canonicalTaskId} changed during deletion; intake was preserved`,
      );
      error.code = "task_delete_concurrent_change";
      throw error;
    }
    if (result.deleted.length > 0) {
      removed.push(`sqlite:${result.deleted.join("/")}`);
    }
  } finally {
    mutableStorage.close();
  }

  if (fs.existsSync(intakePaths.task_root)) {
    fs.rmSync(intakePaths.task_root, { force: true, recursive: true });
    removed.push("intake_dir");
  }

  try {
    const worktrees = subtaskWorktree.listSubtaskWorktrees({
      stateRoot,
      taskId: canonicalTaskId,
    });
    for (const wt of worktrees) {
      subtaskWorktree.removeSubtaskWorktree({
        branchName: wt.branchName,
        workspaceRoot,
        worktreePath: wt.worktreePath,
      });
    }
    if (worktrees.length > 0) removed.push(`worktrees:${worktrees.length}`);
  } catch (error) {
    process.stderr.write(`[niis] Warning: worktree cleanup failed for ${canonicalTaskId}: ${error.message}\n`);
  }

  try {
    const taskBranchName = taskBranch.branchNameFor(canonicalTaskId);
    const onTaskBranch = taskBranch.getCurrentBranch(workspaceRoot) === taskBranchName;
    if (onTaskBranch) {
      const policy = getMergePolicy({ workspaceRoot });
      const fallback = taskBranch.resolveBaseBranch({ workspaceRoot, explicit: policy.base_branch });
      taskBranch.switchToBranch({ branchName: fallback, workspaceRoot });
    }
    if (taskBranch.deleteTaskBranch({ branchName: taskBranchName, workspaceRoot })) {
      removed.push("task_branch");
    }
  } catch {

  }

  return { removed, task_id: canonicalTaskId };
}

function readTaskDependsOnMap({ stateRoot, taskId }) {



  try {
    const paths = taskIntake.createTaskIntakePaths(stateRoot, taskId);
    if (!fs.existsSync(paths.intake_path)) return new Map();
    const intake = JSON.parse(fs.readFileSync(paths.intake_path, "utf8"));
    const subtasks = Array.isArray(intake.subtasks) ? intake.subtasks : [];
    const known = new Set(subtasks.map((s) => s.id).filter(Boolean));
    const map = new Map();
    for (const st of subtasks) {
      if (!st?.id) continue;
      const deps = Array.isArray(st.depends_on) ? st.depends_on.filter((d) => known.has(d)) : [];
      map.set(st.id, deps);
    }
    return map;
  } catch {
    return new Map();
  }
}

function toposortSubtaskMergeOrder(ids, dependsOnMap) {



  const inGraph = new Set(ids);
  const inDegree = new Map();
  const revEdges = new Map();
  for (const id of ids) {
    inDegree.set(id, 0);
    revEdges.set(id, []);
  }
  for (const id of ids) {
    const deps = (dependsOnMap.get(id) ?? []).filter((d) => inGraph.has(d));
    inDegree.set(id, deps.length);
    for (const dep of deps) {
      revEdges.get(dep).push(id);
    }
  }
  const order = [];
  let step = 1;
  let ready = ids.filter((id) => inDegree.get(id) === 0);
  const emitted = new Set();
  while (ready.length > 0) {
    for (const id of ready) {
      const blocksOn = (dependsOnMap.get(id) ?? []).filter((d) => inGraph.has(d));
      order.push({ blocks_on: blocksOn, step, subtask_id: id });
      emitted.add(id);
    }
    const next = [];
    for (const id of ready) {
      for (const dependent of revEdges.get(id) ?? []) {
        inDegree.set(dependent, inDegree.get(dependent) - 1);
        if (inDegree.get(dependent) === 0) next.push(dependent);
      }
    }
    step += 1;
    ready = next;
  }

  for (const id of ids) {
    if (!emitted.has(id)) {
      order.push({ blocks_on: dependsOnMap.get(id) ?? [], step: null, subtask_id: id });
    }
  }
  return order;
}

function collectOperatorDecisionsForUi({ workspaceRoot = resolveWorkspaceRoot() } = {}) {
  try {
    const plan = createInitPlan(workspaceRoot);
    const stateRoot = plan.stateRoot;
    if (!fs.existsSync(stateRoot)) {
      return { subtask_branches: [], task_branches: [] };
    }
    const all = taskQueue.listAll({ stateRoot });
    const flat = [
      ...(all.in_progress ?? []),
      ...(all.in_review ?? []),
      ...(all.pending ?? []),
      ...(all.accepted ?? []),
      ...(all.rejected ?? []),
    ];
    const queueByTaskId = new Map(flat.map((entry) => [entry.task_id, entry]));
    const subtaskBranches = [];

    const pendingByTask = new Map();
    for (const queueEntry of flat) {
      const progress = readSubtaskProgress({ stateRoot, taskId: queueEntry.task_id });
      const entries = progress?.subtasks ?? [];
      for (const entry of entries) {
        if (!entry.branch?.name) continue;
        if (!entry.branch.had_changes) continue;
        if (entry.branch.merge_status === "merged" || entry.branch.merge_status === "discarded" || entry.branch.merge_status === "pr_opened") continue;
        subtaskBranches.push({
          branch: entry.branch,
          role_id: entry.role_id ?? null,
          subtask_id: entry.id,
          task_id: queueEntry.task_id,
          task_title: queueEntry.data?.title ?? queueEntry.task_id,
        });
        if (!pendingByTask.has(queueEntry.task_id)) pendingByTask.set(queueEntry.task_id, []);
        pendingByTask.get(queueEntry.task_id).push(entry.id);
      }
    }

    for (const [taskId, ids] of pendingByTask) {
      if (ids.length < 2) continue;
      const depsMap = readTaskDependsOnMap({ stateRoot, taskId });
      const hasAnyDeps = Array.from(depsMap.values()).some((arr) => arr.length > 0);
      if (!hasAnyDeps) continue;
      const order = toposortSubtaskMergeOrder(ids, depsMap);
      const stepBySubtask = new Map(order.map((o) => [o.subtask_id, o]));
      for (const record of subtaskBranches) {
        if (record.task_id !== taskId) continue;
        const hint = stepBySubtask.get(record.subtask_id);
        if (hint) {
          record.merge_step = hint.step;
          record.blocks_on = hint.blocks_on;
        }
      }
    }
    const taskBranches = [];
    try {
      const result = spawnSync("git", ["branch", "--list", "niis/task/*"], {
        cwd: workspaceRoot,
        encoding: "utf8",
      });
      if (result.status === 0) {
        const branchNames = (result.stdout ?? "")
          .split("\n")
          .map((line) => line.replace(/^\*?\s+/, "").trim())
          .filter(Boolean);
        for (const branchName of branchNames) {
          const match = branchName.match(/^niis\/task\/(.+)$/);
          if (!match) continue;
          const taskId = match[1];
          const queueEntry = queueByTaskId.get(taskId);
          const persistedInfo = readTaskBranchInfo({ stateRoot, taskId });
          taskBranches.push({
            branch_name: branchName,
            pr_url: persistedInfo?.pr_url ?? null,
            queue_state: queueEntry?.state ?? null,
            task_id: taskId,
            task_title: queueEntry?.data?.title ?? taskId,
          });
        }
      }
    } catch {

    }
    return { subtask_branches: subtaskBranches, task_branches: taskBranches };
  } catch {
    return { subtask_branches: [], task_branches: [] };
  }
}

function buildQueueSummaryForUi({ workspaceRoot = resolveWorkspaceRoot() } = {}) {
  try {
    const plan = createInitPlan(workspaceRoot);
    if (!fs.existsSync(plan.stateRoot)) return null;
    const all = taskQueue.listAll({ stateRoot: plan.stateRoot });
    const counts = {};
    for (const [state, entries] of Object.entries(all)) {
      counts[state] = entries.length;
    }
    const pendingPreview = taskQueue.sortByPriority(all.pending ?? []).slice(0, 5).map((entry) => ({
      priority: entry.data?.priority ?? null,
      task_id: entry.task_id,
      title: entry.data?.title ?? entry.task_id,
    }));
    const inReviewPreview = (all.in_review ?? []).slice(0, 5).map((entry) => ({
      task_id: entry.task_id,
      title: entry.data?.title ?? entry.task_id,
    }));
    return {
      counts,
      in_review_preview: inReviewPreview,
      pending_preview: pendingPreview,
    };
  } catch {
    return null;
  }
}

async function deriveUiIntakeArtifact({
  contentOverrides = {},
  executorRuntime = null,
  phaseValue = "",
  plannerRuntime = null,
  priority = null,
  taskId = null,
  title = null,
  workspaceRoot = resolveWorkspaceRoot(),
  prompt,
}) {
  const plan = createInitPlan(workspaceRoot);

  if (!fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }

  const operatorPrompt = String(prompt ?? "").trim();

  if (operatorPrompt === "") {
    throw new Error("task prompt is required");
  }

  const overrides = {
    phase: phaseValue === "" ? undefined : parsePhaseFlagValue(["--phase", String(phaseValue)], "--phase"),
    priority: typeof priority === "string" && priority.trim() !== "" ? priority.trim() : undefined,
    title: typeof title === "string" && title.trim() !== "" ? title.trim() : undefined,
  };
  const normalizedTaskId = typeof taskId === "string" && taskId.trim() !== ""
    ? taskId.trim()
    : createGeneratedTaskId(operatorPrompt);
  const normalizedPlannerRuntime = typeof plannerRuntime === "string" && plannerRuntime.trim() !== ""
    ? parsePlannerRuntimeFlag(["--planner-runtime", plannerRuntime.trim()])
    : null;
  const normalizedExecutorRuntime = typeof executorRuntime === "string" && executorRuntime.trim() !== ""
    ? parseExecutorRuntimeFlag(["--executor-runtime", executorRuntime.trim()])
    : null;
  const planner = await runStructuredPlanner({
    onRuntimeAttempt: async (runtime) => {
      logSelectedRuntime("planner", runtime.runtimeId);
    },
    operatorPrompt,
    preferredRuntime: normalizedPlannerRuntime,
    workspaceRoot,
  });

  const artifact = taskIntake.createTaskIntakeArtifact({
    contentOverrides,
    now: getSystemNow(),
    operatorPrompt,
    overrides,
    plannerCost: planner.cost,
    plannerMode: planner.planner_mode,
    plannerOutput: planner.output,
    plannerRuntime: planner.runtime_id,
    taskId: normalizedTaskId,
    validRoleIds: collectValidRoleIds(workspaceRoot),
  });
  const routePreview = buildIntakeRoutePreview(artifact, {
    executorRuntime: normalizedExecutorRuntime,
    workspaceRoot,
  });
  const finalizedArtifact = {
    ...artifact,
    route_preview: routePreview,
  };

  return {
    artifact: finalizedArtifact,
    executorRuntime: normalizedExecutorRuntime,
    planner,
    routePreview,
    stateRoot: plan.stateRoot,
    taskId: normalizedTaskId,
  };
}

async function createUiIntakeArtifact(options = {}) {
  const {
    artifact,
    executorRuntime,
    planner,
    routePreview,
    stateRoot,
    taskId,
  } = await deriveUiIntakeArtifact(options);
  const sqliteStorage = storage.createSqliteStorage({
    databasePath: createInitPlan(options.workspaceRoot ?? resolveWorkspaceRoot()).databasePath,
  });

  try {
    await storage.seedStorage(sqliteStorage, {
      ingressRecords: [
        taskIntake.createOperatorPromptIngressRecord({
          now: getSystemNow(),
          routeCandidate: routePreview.selected_lane?.lane_id ?? routePreview.selected_lane?.id ?? null,
          taskId,
        }),
      ],
      taskNotes: [
        taskIntake.createOperatorPromptTaskNote({
          now: getSystemNow(),
          operatorPrompt: artifact.operator_prompt,
          taskId,
        }),
      ],
      tasks: [artifact.derived_task],
    });
  } finally {
    sqliteStorage.close();
  }

  const artifactPaths = taskIntake.writeTaskIntakeArtifacts({
    artifact,
    stateRoot,
  });

  return {
    artifact,
    artifactPaths,
    executorRuntime,
    planner,
    routePreview,
    stateRoot,
    taskId,
  };
}




async function suggestGoalForTaskViaLLM({
  goals,
  plannerRuntime = null,
  taskPrompt,
  taskTitle,
  timeoutMs = 60000,
  workspaceRoot,
}) {
  if (!Array.isArray(goals) || goals.length === 0) return null;
  const active = goals.filter((g) => g?.status !== "abandoned");
  if (active.length === 0) return null;
  let candidates;
  try {
    candidates = resolvePreferredRuntimeDefinitions({
      preferredRuntime: plannerRuntime ?? null,
    });
  } catch {
    return null;
  }
  if (!candidates || candidates.length === 0) return null;
  const runtime = candidates[0];
  const goalsList = active.map((g, i) =>
    `${i + 1}. id="${g.id}" — title="${(g.title ?? "").replace(/"/g, "'")}" — desc="${(g.description ?? "").replace(/"/g, "'")}"`,
  ).join("\n");
  const prompt = [
    "You are a strict task classifier. Pick the goal id that best matches the new task, or return null if none clearly applies.",
    "",
    `New task title: ${taskTitle ?? ""}`,
    `New task description: ${taskPrompt ?? ""}`,
    "",
    "Available goals:",
    goalsList,
    "",
    "Respond with ONLY a single JSON object on one line. No preamble, no markdown:",
    '{"goal_id": "<exact-id-from-list-above>"} or {"goal_id": null}',
  ].join("\n");
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const codexExec = resolveCodexExecutor();
    const execution = runtime.runtimeId === "codex_local"
      ? await codexExec({
        commandPath: runtime.commandPath,
        prompt,
        signal: abortController.signal,
        workspaceRoot,
      })
      : await runClaudeExecution({
        commandPath: runtime.commandPath,
        prompt,
        signal: abortController.signal,
        workspaceRoot,
      });
    const text = String(execution.summary ?? "").trim();
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    let parsed;
    try { parsed = JSON.parse(match[0]); } catch { return null; }
    const candidateId = parsed?.goal_id;
    if (typeof candidateId !== "string" || candidateId.trim() === "") return null;
    const found = active.find((g) => g.id === candidateId);
    return found ? found.id : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}





async function suggestAndAttachGoalForTask({
  plannerRuntime = null,
  taskId,
  taskPrompt,
  taskTitle,
  workspaceRoot,
}) {
  let sqliteStorage = null;
  try {
    const plan = createInitPlan(workspaceRoot);
    sqliteStorage = storage.createSqliteStorage({ databasePath: plan.databasePath });
    const goals = await sqliteStorage.goals.list();
    const suggestedId = await suggestGoalForTaskViaLLM({
      goals,
      plannerRuntime,
      taskPrompt,
      taskTitle,
      workspaceRoot,
    });
    if (!suggestedId) return;
    const tasks = await sqliteStorage.tasks.list();
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.goal_id) return;
    const now = getSystemNow();
    const timestamp = now.toISOString();
    const next = schemas.task.parseTaskRecord({
      ...task,
      goal_id: suggestedId,
      updated_at: timestamp,
    });
    await sqliteStorage.tasks.upsert(next);

    try {
      const goal = goals.find((g) => g.id === suggestedId);
      const goalTitle = goal?.title ?? suggestedId;
      const note = taskNotes.createTaskNote({
        authorId: "system:goal-suggester",
        authorType: "system",
        content: `Auto-attached to goal "${goalTitle}" via LLM classifier.`,
        createdAt: now,
        id: `${taskId}:note:goal-suggest:${getSystemTimeMs()}`,
        taskId,
      });
      await taskNotes.appendTaskNote({ storage: sqliteStorage, taskNote: note });
    } catch {}
  } catch {

  } finally {
    if (sqliteStorage) {
      try { sqliteStorage.close(); } catch {}
    }
  }
}

async function createUnplannedTask({
  executorRuntime = null,
  plannerRuntime = null,
  prompt,
  title = null,
  priority = "medium",
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const plan = createInitPlan(workspaceRoot);

  if (!fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }

  const normalizedPlannerRuntime = typeof plannerRuntime === "string" && plannerRuntime.trim() !== ""
    ? parsePlannerRuntimeFlag(["--planner-runtime", plannerRuntime.trim()])
    : null;
  const normalizedExecutorRuntime = typeof executorRuntime === "string" && executorRuntime.trim() !== ""
    ? parseExecutorRuntimeFlag(["--executor-runtime", executorRuntime.trim()])
    : null;

  const operatorPrompt = String(prompt ?? "").trim();

  if (operatorPrompt === "") {
    throw new Error("task prompt is required");
  }

  const now = getSystemNow();
  const timestamp = now.toISOString();
  const taskId = createGeneratedTaskId(operatorPrompt);
  const normalizedTitle = typeof title === "string" && title.trim() !== ""
    ? title.trim()
    : taskIntake.deriveIntakeTaskTitle(operatorPrompt, taskId);
  const normalizedPriority = typeof priority === "string" && priority.trim() !== ""
    ? priority.trim().toLowerCase()
    : "medium";

  const taskRecord = {
    acceptance_markdown: null,
    assigned_to: null,
    created_at: timestamp,
    depends_on: [],
    details_markdown: null,
    goal_id: null,
    id: taskId,
    max_rejections: 5,
    operator_brief_markdown: operatorPrompt,
    out_of_scope: [],
    phase: 0,
    priority: normalizedPriority,
    rejection_count: 0,
    status: "UNPLANNED",
    title: normalizedTitle,
    transition_log: [{
      actor: "ui:intake",
      from_status: null,
      reason: "Created from operator natural-language intake as unplanned task.",
      timestamp,
      to_status: "UNPLANNED",
    }],
    updated_at: timestamp,
  };

  const sqliteStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
  });

  try {
    await storage.seedStorage(sqliteStorage, {
      ingressRecords: [
        taskIntake.createOperatorPromptIngressRecord({
          now,
          routeCandidate: null,
          taskId,
        }),
      ],
      taskNotes: [
        taskIntake.createOperatorPromptTaskNote({
          now,
          operatorPrompt,
          taskId,
        }),
      ],
      tasks: [taskRecord],
    });
  } finally {
    sqliteStorage.close();
  }

  if (normalizedPlannerRuntime || normalizedExecutorRuntime) {
    taskIntake.writeRuntimePreferences({
      executorRuntime: normalizedExecutorRuntime,
      plannerRuntime: normalizedPlannerRuntime,
      stateRoot: plan.stateRoot,
      taskId,
    });
  }





  try {
    const goalsConfig = getGoalsConfig({ workspaceRoot });
    if (goalsConfig.auto_suggest_on_intake) {
      const plannerSelector = normalizedPlannerRuntime
        ?? (typeof plannerRuntime === "string" && plannerRuntime.trim() !== "" ? plannerRuntime.trim() : null);
      suggestAndAttachGoalForTask({
        plannerRuntime: plannerSelector,
        taskId,
        taskPrompt: operatorPrompt,
        taskTitle: normalizedTitle,
        workspaceRoot,
      }).catch(() => {});
    }
  } catch {}

  return {
    taskId,
    taskRecord,
  };
}

async function appendUiTaskNote({
  content,
  taskId,
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const plan = createInitPlan(workspaceRoot);
  const sqliteStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
  });

  try {
    const taskNote = taskNotes.createTaskNote({
      authorId: "ui:operator",
      authorType: "operator",
      content,
      createdAt: getSystemNow(),
      id: `${taskId}:note:${getSystemTimeMs()}`,
      taskId,
    });

    await taskNotes.appendTaskNote({
      storage: sqliteStorage,
      taskNote,
    });

    const latestSession = (await sqliteStorage.taskRunSessions.byTask(taskId))
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at) || left.id.localeCompare(right.id))[0]
      ?? null;
    await sqliteStorage.taskRunEvents.append(createTaskRunEventRecord({
      actorId: "ui:operator",
      actorType: "operator",
      eventType: "operator_note",
      id: `${taskId}:operator-note-event:${Date.parse(taskNote.created_at)}`,
      level: "info",
      payload: {
        note_id: taskNote.id,
        summary: taskNote.content,
      },
      runId: latestSession?.run_id ?? null,
      taskId,
      timestamp: taskNote.created_at,
      visibility: "curated",
    }));
    await sqliteStorage.taskLiveExcerpts.append(createTaskLiveExcerptRecord({
      channel: "event",
      content: taskNote.content,
      id: `${taskId}:operator-note-excerpt:${Date.parse(taskNote.created_at)}`,
      level: "info",
      metadata: {
        note_id: taskNote.id,
      },
      runId: latestSession?.run_id ?? null,
      source: "ui:operator",
      taskId,
      timestamp: taskNote.created_at,
    }));
  } finally {
    sqliteStorage.close();
  }
}

async function updateUiTaskContent({
  acceptanceMarkdown = null,
  detailsMarkdown = null,
  editorId = "ui:operator",
  editorType = "operator",
  operatorBriefMarkdown = null,
  phase = null,
  priority = null,
  source = "ui",
  taskId,
  title = null,
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const plan = createInitPlan(workspaceRoot);
  const lifecycleStore = storage.createLifecycleSqliteStore({
    databasePath: plan.databasePath,
    readonly: true,
  });
  try {
    const activeAttempt = await lifecycleStore.attempts.activeByTask(taskId);
    if (activeAttempt) {
      throw new UiLifecycleActionError(
        `Task ${taskId} cannot be edited while attempt ${activeAttempt.id} is active`,
        { code: "task_edit_during_active_attempt" },
      );
    }
  } finally {
    lifecycleStore.close();
  }
  const sqliteStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
  });
  const timestamp = getSystemTimestamp();

  try {
    const currentTask = (await sqliteStorage.tasks.list()).find((task) => task.id === taskId) ?? null;

    if (!currentTask) {
      throw new Error(`task not found: ${taskId}`);
    }

    const nextTask = schemas.task.parseTaskRecord({
      ...currentTask,
      acceptance_markdown: normalizeUiMarkdownContent(acceptanceMarkdown),
      details_markdown: normalizeUiMarkdownContent(detailsMarkdown),
      operator_brief_markdown: normalizeUiMarkdownContent(operatorBriefMarkdown),
      phase: phase === null || phase === undefined || phase === ""
        ? currentTask.phase
        : parsePhaseFlagValue(["--phase", String(phase)], "--phase"),
      priority: typeof priority === "string" && priority.trim() !== ""
        ? priority.trim().toLowerCase()
        : currentTask.priority,
      title: typeof title === "string" && title.trim() !== ""
        ? title.trim()
        : currentTask.title,
      updated_at: timestamp,
    });
    const changedFields = [
      currentTask.title !== nextTask.title ? "title" : null,
      currentTask.priority !== nextTask.priority ? "priority" : null,
      currentTask.phase !== nextTask.phase ? "phase" : null,
      currentTask.operator_brief_markdown !== nextTask.operator_brief_markdown ? "operator_brief_markdown" : null,
      currentTask.details_markdown !== nextTask.details_markdown ? "details_markdown" : null,
      currentTask.acceptance_markdown !== nextTask.acceptance_markdown ? "acceptance_markdown" : null,
    ].filter(Boolean);

    if (changedFields.length === 0) {
      return {
        revision: null,
        task: currentTask,
      };
    }

    await sqliteStorage.tasks.upsert(nextTask);
    const revision = createTaskContentRevisionRecord({
      changedFields,
      editorId,
      editorType,
      id: `${taskId}:content-revision:${Date.parse(timestamp)}`,
      source,
      task: nextTask,
      timestamp,
    });
    await sqliteStorage.taskContentRevisions.append(revision);
    try {
      const artifact = taskIntake.readTaskIntakeArtifact({
        stateRoot: plan.stateRoot,
        taskId,
      });
      taskIntake.writeTaskIntakeArtifacts({
        artifact: {
          ...artifact,
          acceptance_commands:
            nextTask.acceptance_commands
            ?? artifact.acceptance_commands
            ?? [],
          derived_task: {
            ...(artifact.derived_task ?? {}),
            acceptance_commands:
              nextTask.acceptance_commands
              ?? artifact.derived_task?.acceptance_commands
              ?? artifact.acceptance_commands
              ?? [],
            acceptance_markdown: nextTask.acceptance_markdown,
            details_markdown: nextTask.details_markdown,
            operator_brief_markdown: nextTask.operator_brief_markdown,
            out_of_scope: nextTask.out_of_scope ?? [],
            phase: nextTask.phase,
            priority: nextTask.priority,
            title: nextTask.title,
            updated_at: nextTask.updated_at,
          },
          operator_prompt:
            nextTask.operator_brief_markdown
            ?? artifact.operator_prompt,
        },
        stateRoot: plan.stateRoot,
      });
    } catch (error) {
      throw new Error(
        `task content changed but its intake artifact could not be updated: ${error.message}`,
      );
    }

    const approvals = await sqliteStorage.approvals.byTask(taskId);
    for (const approval of approvals) {
      if (
        approval.action_id === `plan:${taskId}`
        && approval.status === "APPROVED"
      ) {
        await sqliteStorage.approvals.upsert({
          ...approval,
          approved_at: null,
          notes: [
            ...(approval.notes ?? []),
            `plan approval invalidated by task revision ${revision.id}`,
          ],
          status: "PENDING",
        });
      }
    }

    return {
      revision,
      task: nextTask,
    };
  } finally {
    sqliteStorage.close();
  }
}

async function runBackgroundPlanning({
  liveBus = null,
  taskId,
  taskPrompt,
  taskTitle,
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const plan = createInitPlan(workspaceRoot);
  const preferences = taskIntake.readRuntimePreferences({
    stateRoot: plan.stateRoot,
    taskId,
  });

  let plannerResult = null;
  let planningFailed = false;
  let plannerError = null;

  try {
    plannerResult = await deriveUiIntakeArtifact({
      executorRuntime: preferences.executor_runtime,
      plannerRuntime: preferences.planner_runtime,
      prompt: taskPrompt,
      taskId,
      title: taskTitle,
      workspaceRoot,
    });
  } catch (error) {
    planningFailed = true;
    plannerError = error;
  }

  const finalStatus = planningFailed ? "BLOCKED" : "PENDING";
  const planStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
  });

  try {
    const updatedTask = (await planStorage.tasks.list()).find((t) => t.id === taskId) ?? null;
    if (updatedTask) {
      const finalTimestamp = getSystemNow().toISOString();
      const planningTransition = {
        actor: "planner:task-planner",
        from_status: "PLANNING",
        reason: planningFailed
          ? `Planning failed: ${plannerError?.message ?? "Unknown error"}`
          : "Planning completed successfully.",
        timestamp: finalTimestamp,
        to_status: finalStatus,
      };

      const plannerTask = schemas.task.parseTaskRecord({
        ...updatedTask,
        acceptance_markdown: plannerResult?.artifact?.derived_task?.acceptance_markdown ?? updatedTask.acceptance_markdown,
        details_markdown: plannerResult?.artifact?.derived_task?.details_markdown ?? updatedTask.details_markdown,
        status: finalStatus,
        transition_log: [...(updatedTask.transition_log ?? []), planningTransition],
        updated_at: finalTimestamp,
      });
      await planStorage.tasks.upsert(plannerTask);
    }

    if (plannerResult?.artifact) {
      taskIntake.writeTaskIntakeArtifacts({
        artifact: plannerResult.artifact,
        stateRoot: plan.stateRoot,
      });
    }






    if (!planningFailed && plannerResult?.artifact) {
      await enqueueLifecycleTask({
        databasePath: plan.databasePath,
        metadata: {
          created_by: "ui:intake",
          title: plannerResult.artifact.derived_task?.title ?? taskId,
        },
        priority: plannerResult.artifact.derived_task?.priority ?? "medium",
        stateRoot: plan.stateRoot,
        taskId,
      });
    }
  } finally {
    planStorage.close();
  }

  if (liveBus) {
    liveBus.publish({
      task_id: taskId,
      type: "task.card.updated",
    });
  }

  return {
    plannerResult,
    planningFailed,
    plannerError,
    finalStatus,
  };
}

async function updateUiTaskStatus({
  liveBus = null,
  newStatus,
  taskId,
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const plan = createInitPlan(workspaceRoot);
  const now = getSystemNow();
  const timestamp = now.toISOString();

  let currentTask = null;
  let previousStatus = null;

  {
    const sqliteStorage = storage.createSqliteStorage({
      databasePath: plan.databasePath,
    });

    try {
      currentTask = (await sqliteStorage.tasks.list()).find((task) => task.id === taskId) ?? null;

      if (!currentTask) {
        throw new Error(`task not found: ${taskId}`);
      }

      previousStatus = currentTask.status;

      const shouldTransitionToPlanning = previousStatus === "UNPLANNED" && newStatus !== "UNPLANNED" && newStatus !== "REJECTED";
      const immediateStatus = shouldTransitionToPlanning ? "PLANNING" : newStatus;

      const transitionEntry = {
        actor: "ui:operator",
        from_status: previousStatus,
        reason: shouldTransitionToPlanning
          ? "Planning initiated by operator."
          : `Status changed from ${previousStatus} to ${newStatus}.`,
        timestamp,
        to_status: immediateStatus,
      };

      const nextTask = schemas.task.parseTaskRecord({
        ...currentTask,
        status: immediateStatus,
        transition_log: [...(currentTask.transition_log ?? []), transitionEntry],
        updated_at: timestamp,
      });

      await sqliteStorage.tasks.upsert(nextTask);
      currentTask = nextTask;
    } finally {
      sqliteStorage.close();
    }
  }

  const shouldRunPlanner = previousStatus === "UNPLANNED" && newStatus !== "UNPLANNED" && newStatus !== "REJECTED";

  if (!shouldRunPlanner) {
    return {
      plannedNow: false,
      planningInBackground: false,
      planningStatus: null,
      previousStatus,
      task: currentTask,
    };
  }


  runBackgroundPlanning({
    liveBus,
    taskId,
    taskPrompt: currentTask.operator_brief_markdown ?? currentTask.title,
    taskTitle: currentTask.title,
    workspaceRoot,
  }).catch((error) => {
    console.error(`[niis] Background planning failed for task ${taskId}:`, error);
  });

  return {
    plannedNow: false,
    planningInBackground: true,
    planningStatus: "PLANNING",
    previousStatus,
    task: currentTask,
  };
}

async function applyUiApprovalDecision({
  approvalId,
  blockerId = null,
  decision,
  note = "",
  taskId,
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const plan = createInitPlan(workspaceRoot);
  const databasePath = plan.databasePath;
  const sqliteStorage = storage.createSqliteStorage({
    databasePath,
  });
  const now = getSystemNow();
  const timestamp = now.toISOString();
  const normalizedDecision = String(decision ?? "").trim().toLowerCase();
  const normalizedNote = String(note ?? "").trim();

  if (!governance.APPROVAL_DECISION_ACTIONS.includes(normalizedDecision)) {
    sqliteStorage.close();
    throw new Error("approval decision must be approve, reject, or defer");
  }

  try {
    const existingApprovals = await sqliteStorage.approvals.byTask(taskId);
    const existingApproval = existingApprovals.find((entry) => entry.id === approvalId || entry.action_id === blockerId) ?? null;
    const activeBlockers = await sqliteStorage.blockers.active();
    const blocker = activeBlockers.find((entry) => entry.id === blockerId && entry.task_id === taskId) ?? null;
    const status = normalizedDecision === "approve"
      ? "APPROVED"
      : normalizedDecision === "reject"
        ? "REJECTED"
        : "PENDING";
    const decisionState = normalizedDecision === "approve"
      ? "approved"
      : normalizedDecision === "reject"
        ? "rejected"
        : "deferred";
    const actionId = blockerId ?? existingApproval?.action_id ?? approvalId;
    let planDigestNote = null;
    if (
      status === "APPROVED"
      && actionId === `plan:${taskId}`
    ) {
      const task = (await sqliteStorage.tasks.list())
        .find((entry) => entry.id === taskId) ?? null;
      if (!task) {
        throw new Error(`task not found while binding plan approval: ${taskId}`);
      }
      const artifact = taskIntake.readTaskIntakeArtifact({
        stateRoot: plan.stateRoot,
        taskId,
      });
      planDigestNote = createPlanApprovalDigestNote(
        createPlanApprovalDigest({
          artifact,
          runtimePreferences: taskIntake.readRuntimePreferences({
            stateRoot: plan.stateRoot,
            taskId,
          }),
          task,
        }),
      );
    }
    const approvalRecord = governance.createApprovalRecord({
      actionId,
      approvedAt: status === "APPROVED" ? now : null,
      createdAt: existingApproval?.created_at ?? now,
      id: existingApproval?.id ?? approvalId.replace(/^derived:/, `${taskId}:approval:`),
      notes: [
        ...(existingApproval?.notes ?? []),
        ...(normalizedNote ? [normalizedNote] : []),
        ...(planDigestNote ? [planDigestNote] : []),
      ],
      ownerRole: existingApproval?.owner_role ?? "operator",
      reason: blocker?.reason ?? existingApproval?.reason ?? "Operator approval decision recorded from the served UI.",
      requestedBy: existingApproval?.requested_by ?? "operator",
      riskLevel: existingApproval?.risk_level ?? "high",
      status,
      taskId,
    });

    await sqliteStorage.approvals.upsert(approvalRecord);

    if (blocker && status === "APPROVED") {
      await sqliteStorage.blockers.upsert({
        ...blocker,
        resolved_at: timestamp,
      });
    } else if (blocker && status === "REJECTED") {
      await sqliteStorage.blockers.upsert({
        ...blocker,
        next_action: "Address the rejection note, revise the plan, and request a new approval when ready.",
        reason: `Approval request rejected: ${approvalRecord.reason}`,
      });
    } else if (blocker && normalizedDecision === "defer") {
      await sqliteStorage.blockers.upsert({
        ...blocker,
        next_action: "Collect more evidence or operator context, then revisit the approval request.",
        reason: `Approval request deferred pending follow-up: ${approvalRecord.reason}`,
      });
    }

    if (normalizedNote) {
      await taskNotes.appendTaskNote({
        storage: sqliteStorage,
        taskNote: taskNotes.createTaskNote({
          authorId: "ui:operator",
          authorType: "operator",
          content: normalizedNote,
          createdAt: now,
          id: `${taskId}:approval-note:${getSystemTimeMs()}`,
          taskId,
        }),
      });
    }

    await sqliteStorage.explainability.record(schemas.explainability.parseExplainabilityRecord({
      alternatives_considered: [],
      decision_type: "APPROVAL",
      evidence_refs: blocker ? [blocker.id] : [approvalRecord.action_id],
      human_readable_summary: `Operator ${decisionState} approval action ${approvalRecord.action_id}.`,
      id: `${taskId}:approval:${Date.parse(timestamp)}`,
      policy_refs: ["ui/control-plane/v1"],
      route_chosen: `approval:${decisionState}`,
      task_id: taskId,
      timestamp,
    }));

    const latestSession = (await sqliteStorage.taskRunSessions.byTask(taskId))
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at) || left.id.localeCompare(right.id))[0]
      ?? null;
    await sqliteStorage.taskRunEvents.append(createTaskRunEventRecord({
      actorId: "ui:operator",
      actorType: "governance",
      eventType: "approval_resolved",
      id: `${taskId}:approval-event:${Date.parse(timestamp)}`,
      level: status === "REJECTED" ? "warning" : "info",
      payload: {
        action_id: approvalRecord.action_id,
        approval_id: approvalRecord.id,
        decision: decisionState,
        status,
        summary: `Operator ${decisionState} approval action ${approvalRecord.action_id}.`,
      },
      runId: latestSession?.run_id ?? null,
      taskId,
      timestamp,
      visibility: "curated",
    }));
    await sqliteStorage.taskLiveExcerpts.append(createTaskLiveExcerptRecord({
      channel: "validator",
      content: `Approval ${decisionState}: ${approvalRecord.reason}`,
      id: `${taskId}:approval-excerpt:${Date.parse(timestamp)}`,
      level: status === "REJECTED" ? "warning" : "info",
      metadata: {
        action_id: approvalRecord.action_id,
        approval_id: approvalRecord.id,
        status,
      },
      runId: latestSession?.run_id ?? null,
      source: "ui:operator",
      taskId,
      timestamp,
    }));

    return approvalRecord;
  } finally {
    sqliteStorage.close();
  }
}

async function renderUiServePage({
  error = null,
  notice = null,
  requestUrl,
  response,
  scriptNonce = null,
  spec = {},
  taskNewPreview = null,
  taskWorkbenchArtifacts = null,
  title = "Niis Local Control Plane",
  workspaceRoot = resolveWorkspaceRoot(),
  workerMode = "semi",
}) {
  const route = normalizeUiRoute(requestUrl.pathname);
  const resolvedRoute = route
    ? Object.freeze({
      ...route,
      mode: requestUrl.searchParams.get("mode") ?? null,
      view: requestUrl.searchParams.get("view") ?? null,
    })
    : null;

  if (!resolvedRoute) {
    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("not found");
    return;
  }

  const rawSnapshot = loadUiSnapshot(spec, workspaceRoot);
  const snapshot = policy.redactValue(rawSnapshot);
  const taskId = resolveUiTaskWorkbenchArtifactTarget(resolvedRoute, rawSnapshot);
  const subtaskProgressByTaskId = resolvedRoute?.kind === "tasks" && resolvedRoute?.view === "board"
    ? loadSubtaskProgressByTaskId({ snapshot: rawSnapshot, workspaceRoot })
    : null;
  const html = buildControlPlaneHtml({
    error,
    mutableState: resolveUiMutableState(spec, workspaceRoot),
    notice,
    taskCard: taskId
      ? loadUiTaskCard({
        connectionState: "ready",
        spec,
        taskId,
        workspaceRoot,
      })
      : null,
    taskNewPreview,
    taskWorkbenchArtifacts: taskWorkbenchArtifacts
      ?? loadTaskWorkbenchArtifacts(taskId, workspaceRoot),
    projectContext: loadUiProjectContext(spec, workspaceRoot),
    operatorDecisions: collectOperatorDecisionsForUi({ workspaceRoot }),
    queueSummary: buildQueueSummaryForUi({ workspaceRoot }),
    returnTo: requestUrl.pathname + requestUrl.search,
    route: resolvedRoute,
    scriptNonce,
    snapshot,
    subtaskProgressByTaskId,
    title,
    workerMode,
  });
  writeUiHtmlResponse(response, html);
}






function loadSubtaskProgressByTaskId({ snapshot, workspaceRoot }) {
  const stateRoot = createInitPlan(workspaceRoot).stateRoot;
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  const result = Object.create(null);
  for (const task of tasks) {
    if (!task?.id) continue;
    const progress = readSubtaskProgress({ stateRoot, taskId: task.id });
    if (!progress?.subtasks?.length) continue;
    const total = progress.subtasks.length;
    const done = progress.subtasks.filter((s) => s.status === "DONE").length;
    const active = progress.subtasks.find((s) => s.status === "IN_PROGRESS") ?? null;
    result[task.id] = {
      active_title: active?.title ?? null,
      done,
      total,
    };
  }
  return result;
}

async function serveUiApp({
  allowedOrigins = [],
  host,
  openRequested = false,
  port,
  spec = {},
  title = "Niis Local Control Plane",
  workspaceRoot = resolveWorkspaceRoot(),
} = {}) {
  const bootstrapSecret = randomBytes(32).toString("base64url");
  let requestGuard = null;
  ensureUiSchemaReady(spec, workspaceRoot);




  const bootStateRoot = createInitPlan(workspaceRoot).stateRoot;
  const existingUi = readUiPidFile(bootStateRoot);
  if (existingUi && isPidAlive(existingUi.pid) && existingUi.pid !== process.pid) {
    throw new Error(`Another niis UI is already running for this workspace (pid ${existingUi.pid}, started ${existingUi.started_at}). Stop it first or delete ${createUiPidFilePath(bootStateRoot)} if you are sure it crashed.`);
  }
  if (existingUi && !isPidAlive(existingUi.pid)) {
    const reclaim = reclaimExpiredTaskLeases({ stateRoot: bootStateRoot });
    process.stderr.write(`[niis ui] Previous UI (pid ${existingUi.pid}) crashed without cleanup. Reclaimed ${reclaim.reclaimed}/${reclaim.total} orphan task leases.\n`);
  }
  writeUiPidFile(bootStateRoot);
  const liveBus = createUiLiveBus();
  let liveSocketHub = null;




  const processSupervisor = createProcessSupervisor();
  const workerController = createAutonomousWorkerController({
    liveBus,
    supervisor: processSupervisor,
    workspaceRoot,
  });
  await workerController.start();
  let shutdownSupervisorPromise = null;
  const shutdownSupervisor = () => {
    if (shutdownSupervisorPromise) return shutdownSupervisorPromise;
    shutdownSupervisorPromise = (async () => {
      workerController.stop();
      try {
        const cancellations = await cancelAllSupervisedLifecycleTasks({
          graceMs: UI_SHUTDOWN_CANCEL_GRACE_MS,
          reapMs: UI_SHUTDOWN_CANCEL_REAP_MS,
          supervisor: processSupervisor,
          workspaceRoot,
        });
        for (const cancellation of cancellations) {
          if (cancellation.ok) continue;
          process.stderr.write(
            `[niis-ui] Shutdown cancellation for ${cancellation.task_id} `
            + `did not finalize: ${cancellation.reason}`
            + `${cancellation.error ? ` (${cancellation.error})` : ""}.\n`,
          );
        }
      } finally {
        removeUiPidFile(bootStateRoot);
      }
    })();
    return shutdownSupervisorPromise;
  };
  process.once("exit", () => {


    try { removeUiPidFile(bootStateRoot); } catch {  }
  });
  const server = createServer(async (request, response) => {
    let scriptNonce = null;
    try {
      if (!requestGuard) {
        response.writeHead(503, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("UI security policy is not ready");
        return;
      }
      scriptNonce = requestGuard.applyResponseHeaders(response);
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const authorization = requestGuard.authorizeHttp(request, requestUrl);
      if (!authorization.ok) {
        response.writeHead(authorization.status, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(`${JSON.stringify({
          error: authorization.code,
          ok: false,
        })}\n`);
        return;
      }
      requestGuard.attachCookies(response, authorization);
      if (authorization.redirectTo) {
        response.writeHead(303, {
          "cache-control": "no-store",
          location: authorization.redirectTo,
        });
        response.end();
        return;
      }
      const reportMatch = requestUrl.pathname.match(/^\/artifacts\/task\/([^/]+)\/report\.(json|md)$/);
      const taskCardApiMatch = requestUrl.pathname.match(/^\/api\/tasks\/([^/]+)\/card$/);
      const runEventsApiMatch = requestUrl.pathname.match(/^\/api\/tasks\/([^/]+)\/runs\/([^/]+)\/events$/);
      const runExcerptsApiMatch = requestUrl.pathname.match(/^\/api\/tasks\/([^/]+)\/runs\/([^/]+)\/log-excerpts$/);
      const taskLiveLogApiMatch = requestUrl.pathname.match(/^\/api\/tasks\/([^/]+)\/log\/events$/);

      if (requestUrl.pathname === "/health") {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({
          ok: true,
          surface: "niis_ui",
        }));
        return;
      }





      if (request.method === "GET" && requestUrl.pathname === "/tasks/new") {
        response.writeHead(303, { location: "/pipeline" });
        response.end();
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/__niis/assets/control-plane.css") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/css; charset=utf-8",
        });
        response.end(fs.readFileSync(CONTROL_PLANE_CSS_PATH, "utf8"));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/__niis/assets/lab.css") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/css; charset=utf-8",
        });
        response.end(fs.readFileSync(LAB_CSS_PATH, "utf8"));
        return;
      }




      if (request.method === "GET" && requestUrl.pathname === "/pipeline") {
        const installedPackageAgents = await loadInstalledPackageAgents({ workspaceRoot });
        setExtraLabAgents(installedPackageAgents.labAgents);
        const labSnapshot = loadUiSnapshot(spec, workspaceRoot);
        const labDashboard = observability.buildDashboardView({ snapshot: labSnapshot });



        const labStateRoot = createInitPlan(workspaceRoot).stateRoot;
        const labSubtaskProgress = {};
        for (const task of labSnapshot?.tasks ?? []) {
          if (!task?.id) continue;
          const progress = readSubtaskProgress({ stateRoot: labStateRoot, taskId: task.id });
          if (progress?.subtasks?.length) labSubtaskProgress[task.id] = progress;
        }
        let labRoleSpend = [];
        try {
          const plan = createInitPlan(workspaceRoot);
          if (fs.existsSync(plan.databasePath)) {
            const sqliteStorage = storage.createSqliteStorage({
              databasePath: plan.databasePath,
              readonly: true,
            });
            try {
              labRoleSpend = await sqliteStorage.roleMonthlySpend.list();
            } finally {
              sqliteStorage.close();
            }
          }
        } catch {
          labRoleSpend = [];
        }
        const labProjectOverrides = readProjectConfigOrDefault(workspaceRoot);
        const labDisabledAgentIds = collectDisabledAgentIds({
          projectOverrides: labProjectOverrides,
          packageManifests: installedPackageAgents.manifests,
        });
        const labData = buildLabPageData({
          buildActivityStream: observability.buildActivityStream,
          dashboard: labDashboard,
          disabledAgentIds: labDisabledAgentIds,
          now: new Date(),
          roleSpend: labRoleSpend,
          snapshot: labSnapshot,
          subtaskProgressByTaskId: labSubtaskProgress,
          summarizeGoalProgress: governance.summarizeGoalProgress,
        });
        labData.workerMode = workerController.mode;
        labData.taskTemplates = installedPackageAgents.taskTemplates ?? [];
        labData.scriptNonce = scriptNonce;
        writeUiHtmlResponse(response, renderLabDocument(labData));
        return;
      }





      if (request.method === "GET" && requestUrl.pathname === "/agents") {
        const installedPackageAgents = await loadInstalledPackageAgents({ workspaceRoot });
        setExtraLabAgents(installedPackageAgents.labAgents);
        const agentsSnapshot = loadUiSnapshot(spec, workspaceRoot);
        const agentsDashboard = observability.buildDashboardView({ snapshot: agentsSnapshot });
        const agentsStateRoot = createInitPlan(workspaceRoot).stateRoot;
        const agentsSubtaskProgress = {};
        for (const task of agentsSnapshot?.tasks ?? []) {
          if (!task?.id) continue;
          const progress = readSubtaskProgress({ stateRoot: agentsStateRoot, taskId: task.id });
          if (progress?.subtasks?.length) agentsSubtaskProgress[task.id] = progress;
        }
        let agentsRoleSpend = [];
        try {
          const plan = createInitPlan(workspaceRoot);
          if (fs.existsSync(plan.databasePath)) {
            const sqliteStorage = storage.createSqliteStorage({
              databasePath: plan.databasePath,
              readonly: true,
            });
            try {
              agentsRoleSpend = await sqliteStorage.roleMonthlySpend.list();
            } finally {
              sqliteStorage.close();
            }
          }
        } catch {
          agentsRoleSpend = [];
        }


        const projectOverrides = readProjectConfigOrDefault(workspaceRoot);
        const agentsDisabledIds = collectDisabledAgentIds({
          projectOverrides,
          packageManifests: installedPackageAgents.manifests,
        });
        const labDataForAgents = buildLabPageData({
          buildActivityStream: observability.buildActivityStream,
          dashboard: agentsDashboard,
          disabledAgentIds: agentsDisabledIds,
          now: new Date(),
          roleSpend: agentsRoleSpend,
          snapshot: agentsSnapshot,
          subtaskProgressByTaskId: agentsSubtaskProgress,
          summarizeGoalProgress: governance.summarizeGoalProgress,
        });
        const { manifests } = loadRoleConfig({ workspaceRoot });
        const agentManifests = [...manifests, ...installedPackageAgents.manifests];
        const nowDate = new Date();
        const periodCurrent = `${nowDate.getUTCFullYear()}-${String(nowDate.getUTCMonth() + 1).padStart(2, "0")}`;


        const prevMonthDate = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - 1, 1));
        const periodPrev = `${prevMonthDate.getUTCFullYear()}-${String(prevMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
        const sumSpend = (period) => (agentsRoleSpend ?? [])
          .filter((row) => row.period_yyyy_mm === period)
          .reduce((s, row) => s + Number(row.spent_usd ?? 0), 0);
        const spentThisMonth = sumSpend(periodCurrent);
        const spentLastMonth = sumSpend(periodPrev);

        const sevenDayCutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const recentRuns = (agentsSnapshot?.runs ?? []).filter((r) => {
          const ts = Date.parse(r.started_at ?? "");
          return Number.isFinite(ts) && ts >= sevenDayCutoffMs;
        });
        const recentFinalized = recentRuns.filter((r) => r.status === "COMPLETED" || r.status === "FAILED" || r.status === "TIMED_OUT");
        const recentDone = recentRuns.filter((r) => r.status === "COMPLETED").length;
        const successLast7d = recentFinalized.length >= 5
          ? Math.round((recentDone / recentFinalized.length) * 100)
          : null;
        const agentsPageData = buildManageAgentsPageData({
          agentStatusMap: labDataForAgents.agentStatusMap,
          manifests: agentManifests,
          overrides: projectOverrides?.roles ?? {},
          performance: labDataForAgents.performance,
          runsLast7d: recentRuns.length,
          snapshotRunsTotal: Array.isArray(agentsSnapshot?.runs) ? agentsSnapshot.runs.length : 0,
          spentLastMonth,
          spentThisMonth,
          successLast7d,
          workerMode: workerController.mode,
        });
        agentsPageData.scriptNonce = scriptNonce;
        writeUiHtmlResponse(response, renderManageAgentsDocument(agentsPageData));
        return;
      }







      if (request.method === "GET" && requestUrl.pathname === "/project") {
        const projectSnapshot = loadUiSnapshot(spec, workspaceRoot);
        const projectContextForUi = loadUiProjectContext(spec, workspaceRoot);


        let gitUserName = "Operator";
        let gitUserEmail = "operator@niis.local";
        try {
          const r = spawnSync("git", ["config", "user.name"], { cwd: workspaceRoot, encoding: "utf8" });
          if (r.status === 0 && r.stdout && r.stdout.trim()) gitUserName = r.stdout.trim();
        } catch {}
        try {
          const r = spawnSync("git", ["config", "user.email"], { cwd: workspaceRoot, encoding: "utf8" });
          if (r.status === 0 && r.stdout && r.stdout.trim()) gitUserEmail = r.stdout.trim();
        } catch {}
        let detectedTimezone = "UTC";
        try { detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch {}

        try {
          const cfgPath = path.join(workspaceRoot, ".niis/project-config.json");
          if (fs.existsSync(cfgPath)) {
            const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            if (parsed && typeof parsed === "object") {
              const savedTz = parsed.project_general && typeof parsed.project_general === "object"
                ? parsed.project_general.timezone
                : null;
              if (typeof savedTz === "string" && savedTz.trim() !== "") {
                detectedTimezone = savedTz.trim();
              }
            }
          }
        } catch {}
        let goalsAutoSuggest = false;
        try {
          goalsAutoSuggest = getGoalsConfig({ workspaceRoot }).auto_suggest_on_intake === true;
        } catch {}


        const projectFileSnippets = readProjectFileSnippets(workspaceRoot);
        const monthlySpendUsd = await sumCurrentMonthRoleSpend(workspaceRoot);
        writeUiHtmlResponse(response, renderProjectDocument({
          error: requestUrl.searchParams.get("error"),
          gitUser: { name: gitUserName, email: gitUserEmail },
          goalsAutoSuggest,
          monthlySpendUsd,
          notice: requestUrl.searchParams.get("notice"),
          projectContext: projectContextForUi,
          projectFileSnippets,
          snapshot: projectSnapshot,
          scriptNonce,
          timezone: detectedTimezone,
          workerMode: workerController.mode,
        }));
        return;
      }




      if (request.method === "POST" && requestUrl.pathname.startsWith("/__niis/project-file/") && requestUrl.pathname.endsWith("/render-html")) {
        if (!resolveUiMutableState(spec, workspaceRoot)) {
          writeUiJsonResponse(response, {
            error: "UI actions are disabled for immutable snapshot mode.",
            ok: false,
          }, 403);
          return;
        }
        const prefix = "/__niis/project-file/";
        const suffix = "/render-html";
        const id = requestUrl.pathname.slice(prefix.length, -suffix.length);
        const adapterId = normalizeArtifactRenderAdapter(requestUrl.searchParams.get("adapter") || "claude");
        const entry = PROJECT_FILE_SOURCES[id];
        if (!entry || !ILLUSTRATOR_ARTIFACTS[id]) {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "unknown renderable artifact id" }));
          return;
        }
        const absPath = path.join(workspaceRoot, ".niis", entry.rel);
        if (!fs.existsSync(absPath)) {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: `source artifact is missing: ${entry.rel}` }));
          return;
        }
        try {
          const rendered = await renderProjectArtifactHtmlWithAdapter({ workspaceRoot, artifactId: id, adapterId });
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          });
          response.end(JSON.stringify({
            adapterId: rendered.adapterId,
            adapterLabel: rendered.adapterLabel,
            artifactId: id,
            generator: rendered.generator,
            meta: rendered.meta,
            model: rendered.model,
            ok: true,
            outputPath: rendered.outputPath,
            result: rendered.result,
            runtimeId: rendered.runtimeId,
            views: listArtifactViews(id, { hasGeneratedHtml: true, canGenerateHtml: true }),
          }));
        } catch (error) {
          response.writeHead(error.statusCode || 500, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({
            adapterId,
            adapterLabel: ARTIFACT_RENDER_ADAPTERS[adapterId].label,
            error: error.message,
            result: error.renderResult ?? null,
          }));
        }
        return;
      }






      if (request.method === "GET" && requestUrl.pathname.startsWith("/__niis/project-file/")) {
        const id = requestUrl.pathname.slice("/__niis/project-file/".length);
        const entry = PROJECT_FILE_SOURCES[id];
        if (!entry) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unknown file id" }));
          return;
        }
        const absPath = path.join(workspaceRoot, ".niis", entry.rel);
        const hasGeneratedHtml = readArtifactHtml(workspaceRoot, id) !== null;
        const canGenerateHtml = Boolean(ILLUSTRATOR_ARTIFACTS[id]);
        const base = {
          canGenerateHtml,
          filename: path.basename(absPath),
          kind: entry.kind,
          path: absPath,
          views: listArtifactViews(id, { hasGeneratedHtml, canGenerateHtml }),
        };
        if (!fs.existsSync(absPath)) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ...base, missing: true }));
          return;
        }
        try {
          const stat = fs.statSync(absPath);
          const content = fs.readFileSync(absPath, "utf8");




          const viewKind = requestUrl.searchParams.get("view");
          if (viewKind && viewKind !== "raw") {




            if (viewKind === "html") {
              const onDisk = readArtifactHtml(workspaceRoot, id);
              if (onDisk) {
                response.setHeader("content-security-policy", "default-src 'none'; sandbox");
                response.writeHead(200, {
                  "cache-control": "no-cache",
                  "content-type": "text/plain; charset=utf-8",
                });
                response.end(onDisk.body);
                return;
              }
            }
            let parsed;
            try { parsed = entry.kind === "json" ? JSON.parse(content) : content; }
            catch (e) {
              response.writeHead(500, { "content-type": "application/json" });
              response.end(JSON.stringify({ ...base, error: `Parse failed: ${e.message}` }));
              return;
            }
            const view = getArtifactView(id, viewKind, parsed);
            if (view) {
              response.writeHead(200, {
                "cache-control": "no-cache",
                "content-type": view.contentType,
              });
              response.end(view.body);
              return;
            }
            if (viewKind === "html" && canGenerateHtml) {
              const [renderResult] = await renderAllArtifacts({
                workspaceRoot,
                artifactIds: [id],
                generator: "stub-v1",
              });
              const generated = renderResult?.status === "rendered" || renderResult?.status === "skipped"
                ? readArtifactHtml(workspaceRoot, id)
                : null;
              if (generated) {
                response.setHeader("content-security-policy", "default-src 'none'; sandbox");
                response.writeHead(200, {
                  "cache-control": "no-cache",
                  "content-type": "text/plain; charset=utf-8",
                });
                response.end(generated.body);
                return;
              }
            }
            {
              response.writeHead(404, { "content-type": "text/plain" });
              response.end(`no '${viewKind}' view for ${id}`);
              return;
            }
          }
          response.writeHead(200, {
            "cache-control": "no-cache",
            "content-type": "application/json",
          });
          response.end(JSON.stringify({
            ...base,
            content,
            modifiedAt: stat.mtime.toISOString(),
            size: stat.size,
          }));
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ ...base, error: error.message }));
        }
        return;
      }






      if (request.method === "GET" && requestUrl.pathname === "/__niis/source-file") {
        const rel = requestUrl.searchParams.get("path") || "";
        const artifactId = requestUrl.searchParams.get("id") || "";
        if (!rel || rel.includes("\0")) {
          response.writeHead(400, { "content-type": "text/plain" });
          response.end("missing or invalid path");
          return;
        }
        if (artifactId !== "codemap") {
          response.writeHead(400, { "content-type": "text/plain" });
          response.end("source-file requires the codemap artifact");
          return;
        }
        const artifactPath = path.join(workspaceRoot, ".niis", PROJECT_FILE_SOURCES.codemap.rel);
        if (!fs.existsSync(artifactPath)) {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("codemap artifact not found");
          return;
        }
        let codemap;
        try {
          codemap = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
        } catch {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end("codemap artifact is invalid");
          return;
        }
        if (typeof codemap?.root !== "string" || !Array.isArray(codemap?.entries)) {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end("codemap artifact is incomplete");
          return;
        }
        const indexedPaths = new Set(codemap.entries
          .map((entry) => entry?.path)
          .filter((entryPath) => typeof entryPath === "string" && entryPath !== ""));
        let sourceFile;
        try {
          sourceFile = readContainedSourceFile({
            allowedRoot: workspaceRoot,
            allowedRelativePaths: indexedPaths,
            baseRoot: codemap.root,
            relativePath: rel,
          });
        } catch (error) {
          const statusByCode = {
            source_file_invalid_path: 400,
            source_file_missing: 404,
            source_file_not_indexed: 403,
            source_file_not_regular: 400,
            source_file_path_escape: 403,
            source_file_root_escape: 403,
            source_file_root_missing: 404,
            source_file_symlink: 403,
            source_file_sensitive: 403,
            source_file_too_large: 413,
          };
          response.writeHead(statusByCode[error?.code] ?? 500, {
            "content-type": "text/plain",
          });
          response.end(error instanceof Error ? error.message : String(error));
          return;
        }
        const absPath = sourceFile.path;
        const raw = sourceFile.content;




        if (requestUrl.searchParams.get("raw") === "1") {
          response.writeHead(200, {
            "cache-control": "no-cache",
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
          });
          response.end(raw);
          return;
        }
        const ext = path.extname(absPath).toLowerCase();
        const page = renderSourceFilePage({ content: raw, ext, relPath: rel, absPath });
        response.writeHead(200, {
          "cache-control": "no-cache",
          "content-type": "text/html; charset=utf-8",
        });
        response.end(page);
        return;
      }





      if (request.method === "GET" && requestUrl.pathname === "/__niis/services-status") {
        try {
          const checks = collectDoctorChecks(packageRoot, { workspaceRoot });


          const cfg = readProjectConfigOrDefault(workspaceRoot);
          const creditUsd = Number(cfg?.billing?.claude_agent_sdk_credit_usd) || 0;
          const monthlySpend = await sumCurrentMonthRoleSpend(workspaceRoot);
          const claudeCreditNote = buildClaudeCreditNote(creditUsd, cfg?.roles, monthlySpend);
          let gitUser = null;
          try {
            const n = spawnSync("git", ["config", "user.name"], { cwd: workspaceRoot, encoding: "utf8" });
            const e = spawnSync("git", ["config", "user.email"], { cwd: workspaceRoot, encoding: "utf8" });
            const name = n.status === 0 ? (n.stdout || "").trim() : "";
            const email = e.status === 0 ? (e.stdout || "").trim() : "";
            if (name || email) gitUser = { name, email };
          } catch {  }
          const status = buildServicesStatus(checks, { claudeCreditNote, gitUser });
          const projectFileSnippets = readProjectFileSnippets(workspaceRoot);
          const projectHealthIssues = buildProjectHealthStatus({
            doctorChecks: checks,
            projectFileSnippets,
            claudeCreditNote,
            gitUser,
          });
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          });
          response.end(JSON.stringify({ ...status, checks, project_health_issues: projectHealthIssues }));
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: error.message }));
        }
        return;
      }







      if (request.method === "GET" && requestUrl.pathname === "/__niis/logs") {
        try {
          const snapshot = loadUiSnapshot({}, workspaceRoot);
          const events = Array.isArray(snapshot.taskRunEvents) ? snapshot.taskRunEvents : [];
          const fEventType = String(requestUrl.searchParams.get("event_type") ?? "").trim();
          const fLevel = String(requestUrl.searchParams.get("level") ?? "").trim();
          const fTaskId = String(requestUrl.searchParams.get("task_id") ?? "").trim();
          const limitRaw = Number(requestUrl.searchParams.get("limit"));
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : 500;
          const filtered = events.filter((e) => {
            if (fEventType && e.event_type !== fEventType) return false;
            if (fLevel && e.level !== fLevel) return false;
            if (fTaskId && e.task_id !== fTaskId) return false;
            return true;
          }).slice().sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || ""))).slice(0, limit);
          const page = renderLogsTablePage({
            events: filtered,
            totalCount: events.length,
            filteredCount: filtered.length,
            filters: { event_type: fEventType, level: fLevel, task_id: fTaskId, limit },
          });
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8",
          });
          response.end(page);
        } catch (error) {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          response.end(`logs error: ${error.message}`);
        }
        return;
      }





      if (request.method === "POST" && requestUrl.pathname === "/__niis/run-fix") {
        if (!resolveUiMutableState(spec, workspaceRoot)) {
          writeUiJsonResponse(response, {
            error: "UI actions are disabled for immutable snapshot mode.",
            ok: false,
          }, 403);
          return;
        }
        try {
          const form = await readUiRequestFormData(request);
          const action = String(form.get("action") ?? "").trim();
          let summary = "";
          if (action === "backup") {
            const plan = createInitPlan(workspaceRoot);
            if (!fs.existsSync(plan.stateRoot)) {
              throw new Error("state root missing; run init first");
            }
            const result = storage.performBackup(plan.stateRoot, {});
            summary = `Backup created: ${result.backup_id}`;
          } else if (action === "init") {
            const initialized = initializeBootstrapState(workspaceRoot, { installRoot: packageRoot });
            summary = `Initialized state root at ${initialized.plan.stateRoot}`;
          } else {
            response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ ok: false, error: `Unknown fix action: ${action || "(empty)"}` }));
            return;
          }
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          });
          response.end(JSON.stringify({ ok: true, action, summary }));
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ ok: false, error: error.message }));
        }
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/__niis/assets/prism.js") {
        response.writeHead(200, {
          "cache-control": "public, max-age=86400",
          "content-type": "application/javascript; charset=utf-8",
        });
        response.end(readPrismJsBundle());
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/__niis/assets/prism-theme/")) {
        const themeId = requestUrl.pathname.slice("/__niis/assets/prism-theme/".length).replace(/\.css$/, "");
        const themePath = resolvePrismThemePath(themeId);
        if (!themePath || !fs.existsSync(themePath)) {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("unknown prism theme");
          return;
        }
        response.writeHead(200, {
          "cache-control": "public, max-age=86400",
          "content-type": "text/css; charset=utf-8",
        });
        response.end(fs.readFileSync(themePath));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/__niis/assets/control-plane.js") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
        });
        response.end(fs.readFileSync(CONTROL_PLANE_CLIENT_PATH, "utf8"));
        return;
      }

      if (request.method === "GET" && reportMatch) {
        const taskId = decodeURIComponent(reportMatch[1]);
        const format = reportMatch[2];
        const artifacts = loadTaskWorkbenchArtifacts(taskId, workspaceRoot);
        const filePath = format === "json" ? artifacts.reportJsonPath : artifacts.reportMarkdownPath;

        if (!fs.existsSync(filePath)) {
          response.writeHead(404, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end("not found");
          return;
        }

        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": format === "json"
            ? "application/json; charset=utf-8"
            : "text/markdown; charset=utf-8",
        });
        response.end(fs.readFileSync(filePath, "utf8"));
        return;
      }

      if (request.method === "GET" && taskCardApiMatch) {
        const taskId = decodeURIComponent(taskCardApiMatch[1]);
        const rawSnapshot = loadUiSnapshot(spec, workspaceRoot);
        const snapshot = policy.redactValue(rawSnapshot);
        const dashboard = observability.buildDashboardView({
          focusTaskId: taskId,
          snapshot,
        });
        const detail = dashboard.task_detail;
        const taskWorkbenchArtifacts = loadTaskWorkbenchArtifacts(taskId, workspaceRoot);
        const taskCard = buildTaskCardApiPayload({
          spec,
          taskId,
          workspaceRoot,
        });

        if (!taskCard && !detail) {
          writeUiJsonResponse(response, {
            error: "task not found",
            task_id: taskId,
          }, 404);
          return;
        }

        if (requestUrl.searchParams.get("format") === "html") {
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(buildTaskLiveCardFragment({
            taskCard: policy.redactValue(taskCard),
            detail,
            taskWorkbenchArtifacts,
          }));
          return;
        }

        writeUiJsonResponse(response, policy.redactValue(taskCard));
        return;
      }

      if (request.method === "GET" && runEventsApiMatch) {
        const taskId = decodeURIComponent(runEventsApiMatch[1]);
        const runId = decodeURIComponent(runEventsApiMatch[2]);
        const payload = await buildTaskRunEventsApiPayload({
          runId,
          spec,
          taskId,
          workspaceRoot,
        });
        writeUiJsonResponse(response, policy.redactValue(payload));
        return;
      }




      if (request.method === "GET" && taskLiveLogApiMatch) {
        const taskId = decodeURIComponent(taskLiveLogApiMatch[1]);
        const afterTs = requestUrl.searchParams.get("after") ?? null;
        const limitRaw = requestUrl.searchParams.get("limit");
        const limit = limitRaw ? Math.max(1, Math.min(5000, Number.parseInt(limitRaw, 10) || 500)) : 500;
        const payload = await buildTaskRunEventsApiPayload({
          afterTs,
          eventTypes: ["run_log"],
          limit,
          runId: null,
          spec,
          taskId,
          workspaceRoot,
        });
        writeUiJsonResponse(response, policy.redactValue(payload));
        return;
      }

      if (request.method === "GET" && runExcerptsApiMatch) {
        const taskId = decodeURIComponent(runExcerptsApiMatch[1]);
        const runId = decodeURIComponent(runExcerptsApiMatch[2]);
        writeUiJsonResponse(response, policy.redactValue(buildTaskRunLogExcerptsApiPayload({
          runId,
          spec,
          taskId,
          workspaceRoot,
        })));
        return;
      }

      if (request.method === "GET") {
        await renderUiServePage({
          error: requestUrl.searchParams.get("error"),
          notice: requestUrl.searchParams.get("notice"),
          requestUrl,
          response,
          scriptNonce,
          spec,
          taskNewPreview: null,
          taskWorkbenchArtifacts: loadTaskWorkbenchArtifacts(
            normalizeUiRoute(requestUrl.pathname)?.taskId ?? null,
            workspaceRoot,
          ),
          title,
          workerMode: workerController.mode,
          workspaceRoot,
        });
        return;
      }

      if (request.method !== "POST") {
        response.writeHead(405, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end("method not allowed");
        return;
      }

      if (!resolveUiMutableState(spec, workspaceRoot)) {
        if (wantsUiJsonResponse(request, requestUrl)) {
          writeUiJsonResponse(response, {
            error: "UI actions are disabled for immutable snapshot mode.",
            ok: false,
          }, 403);
          return;
        }
        redirectUiResponse(response, requestUrl.pathname, {
          error: "UI actions are disabled for immutable snapshot mode.",
        });
        return;
      }

      const formData = await readUiRequestFormData(request);

      if (requestUrl.pathname === "/tasks/new") {
        const wantsJson = wantsUiJsonResponse(request, requestUrl);
        const returnTo = String(formData.get("return_to") ?? "").trim();
        const returnPath = returnTo === "/pipeline" ? "/pipeline" : null;
        const intakeOptions = {
          contentOverrides: {
            acceptance_markdown: formData.get("acceptance_markdown") ?? null,
            details_markdown: formData.get("details_markdown") ?? null,
            operator_brief_markdown: formData.get("operator_brief_markdown") ?? null,
          },
          executorRuntime: formData.get("executor_runtime") ?? null,
          phaseValue: formData.get("phase") ?? "",
          plannerRuntime: formData.get("planner_runtime") ?? null,
          priority: formData.get("priority") ?? null,
          prompt: formData.get("prompt"),
          taskId: String(formData.get("task_id") ?? "").trim() || null,
          title: formData.get("title") ?? null,
          workspaceRoot,
        };

        const created = await createUnplannedTask({
          executorRuntime: intakeOptions.executorRuntime,
          plannerRuntime: intakeOptions.plannerRuntime,
          priority: intakeOptions.priority,
          prompt: intakeOptions.prompt,
          title: intakeOptions.title,
          workspaceRoot,
        });

        liveBus.publish({
          task_id: created.taskId,
          type: "task.card.updated",
        });

        const intent = String(formData.get("intent") ?? "").trim();
        if (intent === "create_and_start") {
          if (wantsJson) {
            writeUiJsonResponse(response, {
              error: "Immediate execution is disabled in supervised mode; approve each lifecycle step explicitly.",
              ok: false,
              redirect: returnPath ?? `/tasks/${created.taskId}`,
              status: "unplanned",
              taskId: created.taskId,
            }, 409);
            return;
          }
          redirectUiResponse(response, `/tasks/${encodeURIComponent(created.taskId)}`, {
            error: "Task created, but immediate execution is disabled. Start planning explicitly.",
          });
          return;
        }

        if (wantsJson) {
          writeUiJsonResponse(response, {
            ok: true,
            redirect: returnPath ?? `/tasks/${created.taskId}`,
            status: "unplanned",
            taskId: created.taskId,
          });
          return;
        }
        if (returnPath) {
          redirectUiResponse(response, returnPath, {
            notice: "Task created as unplanned.",
          });
          return;
        }
        redirectUiResponse(response, `/tasks/${encodeURIComponent(created.taskId)}`, {
          notice: "Task created as unplanned.",
        });
        return;
      }

      const editMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)\/edit$/);
      if (editMatch) {
        const taskId = decodeURIComponent(editMatch[1]);
        const updated = await updateUiTaskContent({
          acceptanceMarkdown: formData.get("acceptance_markdown") ?? null,
          detailsMarkdown: formData.get("details_markdown") ?? null,
          operatorBriefMarkdown: formData.get("operator_brief_markdown") ?? null,
          phase: formData.get("phase") ?? null,
          priority: formData.get("priority") ?? null,
          taskId,
          title: formData.get("title") ?? null,
          workspaceRoot,
        });
        liveBus.publish({
          task_id: taskId,
          type: "task.card.updated",
        });
        redirectUiResponse(response, `/tasks/${encodeURIComponent(taskId)}`, {
          notice: updated.revision ? "Task content updated." : "No task content changes detected.",
        });
        return;
      }

      const lifecycleActionMatch = requestUrl.pathname.match(
        /^\/tasks\/([^/]+)\/actions\/(approve|start|cancel|retry|resolve)$/,
      );
      if (lifecycleActionMatch) {
        const wantsJson = wantsUiJsonResponse(request, requestUrl);
        const taskId = decodeURIComponent(lifecycleActionMatch[1]);
        const action = lifecycleActionMatch[2];
        const actionStorage = storage.createSqliteStorage({
          databasePath: createInitPlan(workspaceRoot).databasePath,
        });
        let task;
        let activeBlockers;
        let planApproved = false;
        try {
          task = (await actionStorage.tasks.list()).find((entry) => entry.id === taskId) ?? null;
          if (!task) {
            throw new UiLifecycleActionError(`Task not found: ${taskId}`, {
              code: "task_not_found",
              status: 404,
            });
          }
          activeBlockers = (await actionStorage.blockers.active())
            .filter((entry) => entry.task_id === taskId);
        } finally {
          actionStorage.close();
        }
        planApproved = Boolean(await readApprovedPlan({
          databasePath: createInitPlan(workspaceRoot).databasePath,
          stateRoot: createInitPlan(workspaceRoot).stateRoot,
          taskId,
        }));
        const retryPolicyState = action === "retry"
          ? await readTaskRetryPolicyState({
              databasePath: createInitPlan(workspaceRoot).databasePath,
              taskId,
              workspaceRoot,
            })
          : null;

        const actionPlan = resolveUiLifecycleAction({
          action,
          activeBlockerCount: activeBlockers.length,
          maxRejections: retryPolicyState?.maxRejections ?? null,
          maxRetryAttempts: retryPolicyState?.maxRetryAttempts ?? null,
          planApproved,
          rejectionCount: retryPolicyState?.rejectionCount ?? null,
          retryAttemptCount: retryPolicyState?.retryAttemptCount ?? null,
          taskStatus: task.status,
        });
        let updated = null;
        let notice = `Lifecycle action ${action} completed.`;

        if (actionPlan.recordPlanApproval) {
          const approval = await applyUiApprovalDecision({
            approvalId: `${taskId}:plan-approval`,
            blockerId: `plan:${taskId}`,
            decision: "approve",
            note: String(formData.get("note") ?? "Plan approved for supervised execution."),
            taskId,
            workspaceRoot,
          });
          const lifecyclePlan = createInitPlan(workspaceRoot);
          await enqueueLifecycleTask({
            databasePath: lifecyclePlan.databasePath,
            metadata: {
              approved_by: "operator",
              plan_approval_id: approval.id,
            },
            priority: task.priority ?? "medium",
            stateRoot: lifecyclePlan.stateRoot,
            taskId,
          });
          notice = "Plan approved. Execution remains operator-controlled.";
        }

        if (actionPlan.cancelExecution) {
          const supervisedEntry = processSupervisor.get(taskId);
          let cancellationRequest = null;
          if (supervisedEntry) {
            const lifecyclePlan = createInitPlan(workspaceRoot);
            cancellationRequest = await requestLifecycleCancellation({
              databasePath: lifecyclePlan.databasePath,
              requestedBy: `ui:${process.pid}`,
              stateRoot: lifecyclePlan.stateRoot,
              supervisedPid: supervisedEntry.pid,
              taskId,
            });
          }
          const cancellation = await processSupervisor.cancel({ taskId });
          let durableCancellation = null;
          try {
            if (!cancellation.ok && cancellation.reason !== "not_found") {
              throw new UiLifecycleActionError(
                `Cancel failed: ${cancellation.reason ?? "supervised child could not be reaped"}`,
                { code: "cancel_failed" },
              );
            }
            if (
              cancellationRequest
              && cancellation.ok
              && cancellation.reaped
              && shouldInjectCancelCrashAfterReap()
            ) {
              const error = new Error(
                "injected crash after supervised reap and before cancellation takeover",
              );
              error.code = "injected_cancel_crash_after_reap";
              throw error;
            }
            const lifecyclePlan = createInitPlan(workspaceRoot);
            durableCancellation = await cancelLifecycleTask({
              databasePath: lifecyclePlan.databasePath,
              reason: "cancelled from the lifecycle action UI",
              stateRoot: lifecyclePlan.stateRoot,
              taskId,
              terminatedPid:
                cancellation.ok && cancellation.reaped
                  ? cancellation.pid
                  : null,
            });
          } finally {
            cancellation.releaseCleanup?.();
          }
          if (
            !cancellation.ok
            && !durableCancellation.attempt
            && !durableCancellation.queue
          ) {
            throw new UiLifecycleActionError(
              `Cancel failed: ${cancellation.reason ?? "task is not supervised by this UI"}`,
              { code: "cancel_failed" },
            );
          }
          notice = cancellation.forced
            ? "Task cancelled after the graceful-stop timeout."
            : "Task cancellation recorded durably.";
        }

        if (actionPlan.rerunReview) {
          assertNoDirectUiReviewRerun(actionPlan);
        } else if (
          actionPlan.nextStatus
          && !actionPlan.recordPlanApproval
          && !actionPlan.startExecution
        ) {
          if (action === "retry" || action === "resolve") {
            const lifecyclePlan = createInitPlan(workspaceRoot);
            await enqueueLifecycleTask({
              databasePath: lifecyclePlan.databasePath,
              metadata: {
                requeued_by: `ui:${action}`,
              },
              priority: task.priority ?? "medium",
              stateRoot: lifecyclePlan.stateRoot,
              taskId,
            });
          }
          updated = await updateUiTaskStatus({
            liveBus,
            newStatus: actionPlan.nextStatus,
            taskId,
            workspaceRoot,
          });
          if (updated.planningInBackground) {
            notice = "Planning started. Review and approve the resulting plan before execution.";
          } else if (action === "resolve") {
            notice = "Task blocker state resolved; task returned to pending.";
          }
        }

        if (actionPlan.startExecution) {
          await spawnSupervisedStartTask({
            attemptId: actionPlan.createNewAttempt
              ? `attempt:${randomUUID()}`
              : null,
            liveBus,
            supervisor: processSupervisor,
            taskId,
            trigger: action === "retry" ? "ui-retry" : "ui",
            workspaceRoot,
          });
          liveBus.publish({
            task_id: taskId,
            type: "task.card.updated",
          });
          notice = "Task execution started.";
        }

        liveBus.publish({
          task_id: taskId,
          type: "task.card.updated",
        });

        if (wantsJson) {
          writeUiJsonResponse(response, {
            action,
            notice,
            ok: true,
            planningInBackground: Boolean(updated?.planningInBackground),
            redirect: "/pipeline",
            status: updated?.task?.status ?? task.status,
            taskId,
          });
          return;
        }

        redirectUiResponse(response, `/tasks/${encodeURIComponent(taskId)}`, {
          notice,
        });
        return;
      }

      const statusMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)\/status$/);
      if (statusMatch) {
        const payload = {
          error: "Direct task status mutation is retired; use a lifecycle action.",
          ok: false,
        };
        if (wantsUiJsonResponse(request, requestUrl)) {
          writeUiJsonResponse(response, payload, 410);
          return;
        }
        response.writeHead(410, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(payload.error);
        return;
      }

      const deleteMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)\/delete$/);
      if (deleteMatch) {
        response.writeHead(410, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(
          "UI task deletion is retired in Reliability RC; "
          + "use only approve, start, cancel, retry, or resolve actions.",
        );
        return;
      }

      const startMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)\/(start|retry)$/);
      if (startMatch) {
        response.writeHead(410, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("Legacy start/retry route retired; use /tasks/:id/actions/:action.");
        return;
      }

      const retiredBranchMutationMatch = requestUrl.pathname.match(
        /^\/tasks\/[^/]+\/(?:task-branch\/(?:merge|discard|pr)|subtasks\/[^/]+\/(?:merge|discard|pr))$/,
      );
      if (retiredBranchMutationMatch) {
        response.writeHead(410, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(
          "Legacy branch mutation route retired in Reliability RC; "
          + "only canonical lifecycle promotion after PASS may publish changes.",
        );
        return;
      }

      if (requestUrl.pathname === "/project/goals/create") {
        const title = String(formData.get("title") ?? "").trim();
        const description = String(formData.get("description") ?? "").trim();
        const levelRaw = String(formData.get("level") ?? "project").trim();
        const taskIds = formData.getAll("task_ids[]").map((t) => String(t).trim()).filter(Boolean);
        if (title === "") {
          redirectUiResponse(response, "/project#goals", { error: "Goal title is required." });
          return;
        }
        if (description === "") {
          redirectUiResponse(response, "/project#goals", { error: "Goal description is required." });
          return;
        }
        if (!schemas.goal.GOAL_LEVELS.includes(levelRaw)) {
          redirectUiResponse(response, "/project#goals", { error: `Invalid goal level: ${levelRaw}` });
          return;
        }
        const plan = createInitPlan(workspaceRoot);
        const sqliteStorage = storage.createSqliteStorage({ databasePath: plan.databasePath });
        let opError = null;
        try {
          const now = getSystemTimestamp();
          const goalId = `goal-${randomUUID().slice(0, 8)}`;
          const goal = schemas.goal.parseGoalRecord({
            id: goalId,
            title,
            description,
            level: levelRaw,
            status: "active",
            parent_goal_id: null,
            project_id: null,
            owner_agent_id: null,
            created_at: now,
            updated_at: now,
          });
          await sqliteStorage.goals.upsert(goal);
          if (taskIds.length > 0) {
            const tasks = await sqliteStorage.tasks.list();
            for (const tid of taskIds) {
              const task = tasks.find((t) => t.id === tid);
              if (!task) continue;
              const next = schemas.task.parseTaskRecord({
                ...task,
                goal_id: goalId,
                updated_at: now,
              });
              await sqliteStorage.tasks.upsert(next);
            }
          }
        } catch (error) {
          opError = error;
        } finally {
          sqliteStorage.close();
        }
        if (opError) {
          redirectUiResponse(response, "/project#goals", { error: `Failed to create goal: ${opError.message}` });
          return;
        }
        redirectUiResponse(response, "/project#goals", { notice: "Goal created." });
        return;
      }





      const goalEditMatch = requestUrl.pathname.match(/^\/project\/goals\/([^/]+)\/edit$/);
      if (goalEditMatch) {
        const goalId = decodeURIComponent(goalEditMatch[1]);
        const hasTitle = formData.has("title");
        const hasDescription = formData.has("description");
        const hasLevel = formData.has("level");
        const syncTasks = formData.get("sync_tasks") === "1";
        const title = hasTitle ? String(formData.get("title") ?? "").trim() : null;
        const description = hasDescription ? String(formData.get("description") ?? "").trim() : null;
        const levelRaw = hasLevel ? String(formData.get("level") ?? "").trim() : null;
        const taskIds = syncTasks
          ? formData.getAll("task_ids[]").map((t) => String(t).trim()).filter(Boolean)
          : null;
        if (hasTitle && title === "") {
          redirectUiResponse(response, "/project#goals", { error: "Goal title cannot be empty." });
          return;
        }
        if (hasDescription && description === "") {
          redirectUiResponse(response, "/project#goals", { error: "Goal description cannot be empty." });
          return;
        }
        if (hasLevel && !schemas.goal.GOAL_LEVELS.includes(levelRaw)) {
          redirectUiResponse(response, "/project#goals", { error: `Invalid goal level: ${levelRaw}` });
          return;
        }
        const plan = createInitPlan(workspaceRoot);
        const sqliteStorage = storage.createSqliteStorage({ databasePath: plan.databasePath });
        let opError = null;
        try {
          const current = await sqliteStorage.goals.byId(goalId);
          if (!current) throw new Error(`Goal not found: ${goalId}`);
          const now = getSystemTimestamp();
          const updated = schemas.goal.parseGoalRecord({
            ...current,
            ...(hasTitle ? { title } : {}),
            ...(hasDescription ? { description } : {}),
            ...(hasLevel ? { level: levelRaw } : {}),
            updated_at: now,
          });
          await sqliteStorage.goals.upsert(updated);
          if (syncTasks && taskIds) {
            const linked = await sqliteStorage.tasks.byGoal(goalId);
            const linkedIds = new Set(linked.map((t) => t.id));
            const requestedIds = new Set(taskIds);
            for (const t of linked) {
              if (!requestedIds.has(t.id)) {
                const next = schemas.task.parseTaskRecord({ ...t, goal_id: null, updated_at: now });
                await sqliteStorage.tasks.upsert(next);
              }
            }
            if (taskIds.length > 0) {
              const allTasks = await sqliteStorage.tasks.list();
              for (const tid of taskIds) {
                if (linkedIds.has(tid)) continue;
                const task = allTasks.find((t) => t.id === tid);
                if (!task) continue;
                const next = schemas.task.parseTaskRecord({ ...task, goal_id: goalId, updated_at: now });
                await sqliteStorage.tasks.upsert(next);
              }
            }
          }
        } catch (error) {
          opError = error;
        } finally {
          sqliteStorage.close();
        }
        if (opError) {
          redirectUiResponse(response, "/project#goals", { error: `Failed to update goal: ${opError.message}` });
          return;
        }
        redirectUiResponse(response, "/project#goals", { notice: "Goal updated." });
        return;
      }




      if (requestUrl.pathname === "/project/goals/attach") {
        const goalId = String(formData.get("goal_id") ?? "").trim();
        const taskId = String(formData.get("task_id") ?? "").trim();
        if (goalId === "" || taskId === "") {
          redirectUiResponse(response, "/project#goals", { error: "goal_id and task_id are required." });
          return;
        }
        const plan = createInitPlan(workspaceRoot);
        const sqliteStorage = storage.createSqliteStorage({ databasePath: plan.databasePath });
        let opError = null;
        try {
          const goal = await sqliteStorage.goals.byId(goalId);
          if (!goal) throw new Error(`Goal not found: ${goalId}`);
          const tasks = await sqliteStorage.tasks.list();
          const task = tasks.find((t) => t.id === taskId);
          if (!task) throw new Error(`Task not found: ${taskId}`);
          const now = getSystemTimestamp();
          const next = schemas.task.parseTaskRecord({ ...task, goal_id: goalId, updated_at: now });
          await sqliteStorage.tasks.upsert(next);
        } catch (error) {
          opError = error;
        } finally {
          sqliteStorage.close();
        }
        if (opError) {
          redirectUiResponse(response, "/project#goals", { error: `Failed to attach task: ${opError.message}` });
          return;
        }
        redirectUiResponse(response, "/project#goals", { notice: "Task attached to goal." });
        return;
      }

      const goalDeleteMatch = requestUrl.pathname.match(/^\/project\/goals\/([^/]+)\/delete$/);
      if (goalDeleteMatch) {
        const goalId = decodeURIComponent(goalDeleteMatch[1]);
        const plan = createInitPlan(workspaceRoot);
        const sqliteStorage = storage.createSqliteStorage({ databasePath: plan.databasePath });
        let opError = null;
        try {
          const current = await sqliteStorage.goals.byId(goalId);
          if (!current) throw new Error(`Goal not found: ${goalId}`);
          const now = getSystemTimestamp();
          const abandoned = schemas.goal.parseGoalRecord({
            ...current,
            status: "abandoned",
            updated_at: now,
          });
          await sqliteStorage.goals.upsert(abandoned);
          const linked = await sqliteStorage.tasks.byGoal(goalId);
          for (const t of linked) {
            const next = schemas.task.parseTaskRecord({ ...t, goal_id: null, updated_at: now });
            await sqliteStorage.tasks.upsert(next);
          }
        } catch (error) {
          opError = error;
        } finally {
          sqliteStorage.close();
        }
        if (opError) {
          redirectUiResponse(response, "/project#goals", { error: `Failed to delete goal: ${opError.message}` });
          return;
        }
        redirectUiResponse(response, "/project#goals", { notice: "Goal deleted." });
        return;
      }





      if (requestUrl.pathname === "/project/settings/goals") {
        const autoSuggest = formData.get("auto_suggest_on_intake") === "1";
        try {
          writeProjectConfigUpdate(workspaceRoot, (current) => {
            current.goals = {
              ...(current.goals && typeof current.goals === "object" ? current.goals : {}),
              auto_suggest_on_intake: autoSuggest,
            };
            return current;
          });
        } catch (error) {
          redirectUiResponse(response, "/project#goals", { error: `Failed to save goals settings: ${error.message}` });
          return;
        }
        redirectUiResponse(response, "/project#goals", { notice: autoSuggest ? "Auto-suggest enabled." : "Auto-suggest disabled." });
        return;
      }




      const taskSuggestGoalMatch = requestUrl.pathname.match(/^\/project\/tasks\/([^/]+)\/suggest-goal$/);
      if (taskSuggestGoalMatch) {
        const taskId = decodeURIComponent(taskSuggestGoalMatch[1]);
        const plan = createInitPlan(workspaceRoot);
        const sqliteStorage = storage.createSqliteStorage({ databasePath: plan.databasePath, readonly: true });
        let task = null;
        let goalsCount = 0;
        try {
          const tasks = await sqliteStorage.tasks.list();
          task = tasks.find((t) => t.id === taskId) ?? null;
          const goals = await sqliteStorage.goals.list();
          goalsCount = goals.filter((g) => g?.status !== "abandoned").length;
        } finally {
          try { sqliteStorage.close(); } catch {}
        }
        if (!task) {
          redirectUiResponse(response, "/project#goals", { error: `Task not found: ${taskId}` });
          return;
        }
        if (task.goal_id) {
          redirectUiResponse(response, "/project#goals", { error: "Task already has a goal. Detach it first to re-suggest." });
          return;
        }
        if (goalsCount === 0) {
          redirectUiResponse(response, "/project#goals", { error: "No active goals available to suggest from." });
          return;
        }
        const prompt = task.operator_brief_markdown
          ?? task.details_markdown
          ?? task.title
          ?? "";
        suggestAndAttachGoalForTask({
          plannerRuntime: null,
          taskId,
          taskPrompt: prompt,
          taskTitle: task.title ?? "",
          workspaceRoot,
        }).catch(() => {});
        redirectUiResponse(response, "/project#goals", { notice: "Suggesting goal in background. Refresh in a moment to see the result." });
        return;
      }

      const taskGoalMatch = requestUrl.pathname.match(/^\/project\/tasks\/([^/]+)\/goal$/);
      if (taskGoalMatch) {
        const taskId = decodeURIComponent(taskGoalMatch[1]);
        const rawGoalId = String(formData.get("goal_id") ?? "").trim();
        const newGoalId = rawGoalId === "" ? null : rawGoalId;
        const plan = createInitPlan(workspaceRoot);
        const sqliteStorage = storage.createSqliteStorage({ databasePath: plan.databasePath });
        let opError = null;
        try {
          if (newGoalId !== null) {
            const goal = await sqliteStorage.goals.byId(newGoalId);
            if (!goal) throw new Error(`Goal not found: ${newGoalId}`);
          }
          const tasks = await sqliteStorage.tasks.list();
          const task = tasks.find((t) => t.id === taskId);
          if (!task) throw new Error(`Task not found: ${taskId}`);
          const now = getSystemTimestamp();
          const next = schemas.task.parseTaskRecord({ ...task, goal_id: newGoalId, updated_at: now });
          await sqliteStorage.tasks.upsert(next);
        } catch (error) {
          opError = error;
        } finally {
          sqliteStorage.close();
        }
        if (opError) {
          redirectUiResponse(response, "/project#goals", { error: `Failed to link task: ${opError.message}` });
          return;
        }
        redirectUiResponse(response, "/project#goals", { notice: newGoalId === null ? "Task unlinked from goal." : "Task linked to goal." });
        return;
      }

      if (requestUrl.pathname === "/project/settings") {





        const maxParallelRaw = formData.get("max_parallel");
        const maxParallel = Number(maxParallelRaw);
        if (maxParallelRaw !== null && maxParallel !== 1) {
          redirectUiResponse(response, "/project#settings", { error: "Reliability RC fixes max_parallel at 1." });
          return;
        }
        const maxConcurrentRaw = formData.get("max_concurrent");
        const maxConcurrent = Number(maxConcurrentRaw);
        if (maxConcurrentRaw !== null && maxConcurrent !== 1) {
          redirectUiResponse(response, "/project#settings", { error: "Reliability RC fixes max_concurrent at 1." });
          return;
        }
        try {
          writeProjectConfigUpdate(workspaceRoot, (current) => {
            current.routing_policy = {
              ...(current.routing_policy ?? {}),
              ...(maxParallelRaw !== null ? { max_parallel: maxParallel } : {}),
            };
            if (maxConcurrentRaw !== null) {
              current.autonomous_worker = {
                ...(current.autonomous_worker ?? {}),
                max_concurrent: maxConcurrent,
              };
            }
            return current;
          });
        } catch (error) {
          redirectUiResponse(response, "/project#settings", { error: `Failed to save: ${error.message}` });
          return;
        }
        redirectUiResponse(response, "/project#settings", { notice: "Parallel streams updated" });
        return;
      }

      if (requestUrl.pathname === "/project/settings/review") {






        const llmEnabled = formData.get("llm_review_enabled") === "1";
        const llmModeRaw = String(formData.get("llm_review_mode") ?? "").trim();
        const codexPrefRaw = String(formData.get("llm_review_model_preference_codex_local") ?? "").trim();
        const claudePrefRaw = String(formData.get("llm_review_model_preference_claude_code_local") ?? "").trim();
        const hasAutoRepairFields =
          formData.has("auto_repair_enabled")
          || formData.has("auto_repair_max_attempts");
        const autoRepairEnabled = formData.get("auto_repair_enabled") === "1";
        const autoRepairMaxRaw = hasAutoRepairFields
          ? String(formData.get("auto_repair_max_attempts") ?? "").trim()
          : null;
        const autoRepairMax = autoRepairMaxRaw === null
          ? null
          : Number(autoRepairMaxRaw);
        const allowedModes = ["standard", "adversarial"];
        if (llmEnabled && llmModeRaw !== "" && !allowedModes.includes(llmModeRaw)) {
          redirectUiResponse(response, "/project#settings", { error: `Invalid llm_review.mode: ${llmModeRaw}` });
          return;
        }
        if (
          hasAutoRepairFields
          && (
            !Number.isInteger(autoRepairMax)
            || autoRepairMax < 1
            || autoRepairMax > 5
          )
        ) {
          redirectUiResponse(response, "/project#settings", {
            error: "auto_repair.max_attempts must be an integer from 1 to 5",
          });
          return;
        }
        try {
          writeProjectConfigUpdate(workspaceRoot, (current) => {



            const existingLegacy = current.llm_review?.model_preference ?? null;
            current.llm_review = {
              enabled: llmEnabled,
              mode: llmModeRaw !== "" ? llmModeRaw : "standard",
              model_preferences: {
                codex_local: codexPrefRaw !== "" ? codexPrefRaw : null,
                claude_code_local: claudePrefRaw !== "" ? claudePrefRaw : null,
              },
              ...(existingLegacy ? { model_preference: existingLegacy } : {}),
            };
            if (hasAutoRepairFields) {
              current.auto_repair = {
                enabled: autoRepairEnabled,
                max_attempts: autoRepairMax,
              };
            }
            return current;
          });
        } catch (error) {
          redirectUiResponse(response, "/project#settings", { error: `Failed to save review settings: ${error.message}` });
          return;
        }
        redirectUiResponse(response, "/project#settings", { notice: "Review settings updated." });
        return;
      }




      if (requestUrl.pathname === "/project/settings/general") {
        const tz = String(formData.get("project_timezone") ?? "").trim();
        if (tz === "") {
          redirectUiResponse(response, "/project", { error: "project_timezone is required" });
          return;
        }
        const creditRaw = String(formData.get("claude_agent_sdk_credit_usd") ?? "").trim();
        let creditUsd = null;
        if (creditRaw !== "") {
          const n = Number(creditRaw);
          if (!Number.isFinite(n) || n < 0) {
            redirectUiResponse(response, "/project", { error: "Invalid Claude monthly reference value" });
            return;
          }
          creditUsd = n;
        }
        try {
          writeProjectConfigUpdate(workspaceRoot, (current) => {
            current.project_general = {
              ...(current.project_general ?? {}),
              timezone: tz,
            };

            if (creditUsd && creditUsd > 0) {
              current.billing = { ...(current.billing ?? {}), claude_agent_sdk_credit_usd: creditUsd };
            } else if (current.billing) {
              const next = { ...current.billing };
              delete next.claude_agent_sdk_credit_usd;
              current.billing = Object.keys(next).length > 0 ? next : null;
            }
            return current;
          });
        } catch (error) {
          redirectUiResponse(response, "/project", { error: `Failed to save: ${error.message}` });
          return;
        }
        redirectUiResponse(response, "/project", { notice: "Settings updated" });
        return;
      }




      if (requestUrl.pathname === "/project/settings/merge-policy") {
        const presetRaw = String(formData.get("preset") ?? "").trim();
        const nextPolicy = resolveReliabilityRcMergePreset(presetRaw);
        if (!nextPolicy) {
          redirectUiResponse(response, "/project#settings", {
            error: "Reliability RC permits only the supervised review merge policy.",
          });
          return;
        }
        try {
          writeProjectConfigUpdate(workspaceRoot, (current) => {
            current.merge_policy = nextPolicy;
            return current;
          });
        } catch (error) {
          redirectUiResponse(response, "/project#settings", { error: `Failed to save merge policy: ${error.message}` });
          return;
        }
        redirectUiResponse(response, "/project#settings", { notice: "Merge policy updated." });
        return;
      }

      const projectRoleMatch = requestUrl.pathname.match(/^\/project\/settings\/role\/([^/]+)$/);
      if (projectRoleMatch) {
        const roleId = decodeURIComponent(projectRoleMatch[1]);






        const intent = String(formData.get("intent") ?? "").trim();

        if (intent === "enabled") {
          const enabledRaw = String(formData.get("enabled") ?? "").trim();
          const nextEnabled = enabledRaw === "1" || enabledRaw === "true";



          if (!nextEnabled && isSystemRoleId(roleId)) {
            redirectUiResponse(response, "/project#settings", {
              error: `Role ${roleId} is required for niis — cannot be disabled.`,
            });
            return;
          }
          try {
            writeProjectConfigUpdate(workspaceRoot, (current) => {
              const existing = current.roles[roleId] ?? {};
              const next = { ...existing };
              if (nextEnabled) {


                delete next.enabled;
              } else {
                next.enabled = false;
              }
              if (Object.keys(next).length === 0) {
                delete current.roles[roleId];
              } else {
                current.roles[roleId] = next;
              }
              return current;
            });
          } catch (error) {
            redirectUiResponse(response, "/project#settings", { error: `Failed to toggle role ${roleId}: ${error.message}` });
            return;
          }
          redirectUiResponse(response, "/project#settings", {
            notice: `Role ${roleId} ${nextEnabled ? "enabled" : "disabled"}.`,
          });
          return;
        }

        const modelRuntimeRaw = String(formData.get("model_runtime") ?? "").trim();
        const modelNameRaw = String(formData.get("model_name") ?? "").trim();
        const monthlyRaw = String(formData.get("budget_monthly_usd") ?? "").trim();
        const perRunRaw = String(formData.get("budget_per_run_usd") ?? "").trim();
        const personaNameRaw = String(formData.get("persona_name") ?? "").trim();

        const monthlyUsd = monthlyRaw === "" ? null : Number(monthlyRaw);
        const perRunUsd = perRunRaw === "" ? null : Number(perRunRaw);
        if (monthlyUsd !== null && (!Number.isFinite(monthlyUsd) || monthlyUsd < 0)) {
          redirectUiResponse(response, "/project#settings", { error: `Invalid monthly budget for role ${roleId}.` });
          return;
        }
        if (perRunUsd !== null && (!Number.isFinite(perRunUsd) || perRunUsd < 0)) {
          redirectUiResponse(response, "/project#settings", { error: `Invalid per-run cap for role ${roleId}.` });
          return;
        }
        if (personaNameRaw.length > 40) {
          redirectUiResponse(response, "/project#settings", { error: `Display name for ${roleId} is too long (max 40 chars).` });
          return;
        }

        try {
          writeProjectConfigUpdate(workspaceRoot, (current) => {
            const existing = current.roles[roleId] ?? {};
            const next = { ...existing };
            if (modelRuntimeRaw !== "" && modelNameRaw !== "") {
              next.model_preference = { runtime: modelRuntimeRaw, model: modelNameRaw };
            } else if (modelRuntimeRaw === "" && modelNameRaw === "") {
              delete next.model_preference;
            }
            const budgetUpdate = {};
            if (monthlyUsd !== null && monthlyUsd > 0) budgetUpdate.monthly_usd = monthlyUsd;
            if (perRunUsd !== null && perRunUsd > 0) budgetUpdate.per_run_usd = perRunUsd;
            if (Object.keys(budgetUpdate).length > 0) {
              next.budget = { ...(existing.budget ?? {}), ...budgetUpdate };
            } else if (monthlyRaw === "" && perRunRaw === "") {
              delete next.budget;
            }
            if (personaNameRaw !== "") {
              next.persona = { ...(existing.persona ?? {}), name: personaNameRaw };
            } else if (existing.persona && Object.keys(existing.persona).length === 1 && "name" in existing.persona) {

              delete next.persona;
            } else if (existing.persona) {
              const cleared = { ...existing.persona };
              delete cleared.name;
              if (Object.keys(cleared).length === 0) delete next.persona;
              else next.persona = cleared;
            }
            if (Object.keys(next).length === 0) {
              delete current.roles[roleId];
            } else {
              current.roles[roleId] = next;
            }
            return current;
          });
        } catch (error) {
          redirectUiResponse(response, "/project#settings", { error: `Failed to save: ${error.message}` });
          return;
        }
        redirectUiResponse(response, "/project#settings", { notice: `Role ${roleId} settings updated.` });
        return;
      }

      const noteMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)\/notes$/);
      if (noteMatch) {
        const taskId = decodeURIComponent(noteMatch[1]);
        const content = String(formData.get("content") ?? "").trim();

        if (content === "") {
          redirectUiResponse(response, `/tasks/${encodeURIComponent(taskId)}`, {
            error: "Task note content is required.",
          });
          return;
        }

        await appendUiTaskNote({
          content,
          taskId,
          workspaceRoot,
        });
        liveBus.publish({
          task_id: taskId,
          type: "task.note.created",
        });
        redirectUiResponse(response, `/tasks/${encodeURIComponent(taskId)}`, {
          notice: "Operator note added.",
        });
        return;
      }




      if (requestUrl.pathname === "/project/mode" && request.method === "POST") {
        const nextMode = String(formData.get("mode") ?? "").trim();
        try {
          const result = await workerController.setMode(nextMode);
          redirectUiResponse(response, requestUrl.searchParams.get("return_to") || "/project#settings", {
            notice: result.changed
              ? `Mode switched to ${result.mode}.`
              : `Mode already ${result.mode}.`,
          });
        } catch (error) {
          redirectUiResponse(response, requestUrl.searchParams.get("return_to") || "/project#settings", {
            error: `Failed to switch mode: ${error.message}`,
          });
        }
        return;
      }





      const cancelMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)\/cancel$/);
      if (cancelMatch && request.method === "POST") {
        response.writeHead(410, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("Legacy cancel route retired; use /tasks/:id/actions/cancel.");
        return;
      }

      const reReviewMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)\/re-review$/);
      if (reReviewMatch) {
        response.writeHead(410, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("Legacy review route retired; use /tasks/:id/actions/resolve.");
        return;
      }

      const approvalMatch = requestUrl.pathname.match(/^\/approvals\/([^/]+)$/);
      if (approvalMatch) {
        writeUiJsonResponse(response, {
          error:
            "Direct approval mutation is retired; "
            + "use /tasks/:id/actions/approve.",
          ok: false,
        }, 410);
        return;
      }

      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("not found");
    } catch (error) {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const route = normalizeUiRoute(requestUrl.pathname);




      console.error(`[ui-serve] unhandled error for ${request.method} ${request.url}: ${error?.stack ?? error?.message ?? error}`);

      if (request.method === "POST" && wantsUiJsonResponse(request, requestUrl)) {
        writeUiJsonResponse(response, {
          error: error instanceof Error ? error.message : String(error),
          ok: false,
        }, error instanceof UiLifecycleActionError ? error.status : 500);
        return;
      }

      if (request.method === "POST" && route) {
        const fallbackPath = route.kind === "task-new"
          ? "/tasks/new"
          : route.kind === "task-detail"
            ? requestUrl.pathname.endsWith("/edit")
              ? `/tasks/${encodeURIComponent(route.taskId)}?mode=edit`
              : `/tasks/${encodeURIComponent(route.taskId)}`
            : route.kind === "approvals"
              ? "/approvals"
              : route.path;
        redirectUiResponse(response, fallbackPath, {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const html = buildControlPlaneHtml({
        error: error instanceof Error ? error.message : String(error),
        mutableState: resolveUiMutableState(spec, workspaceRoot),
        notice: null,
        taskCard: route?.taskId
          ? loadUiTaskCard({
            connectionState: "ready",
            spec,
            taskId: route.taskId,
            workspaceRoot,
          })
          : null,
        taskNewPreview: null,
        taskWorkbenchArtifacts: loadTaskWorkbenchArtifacts(
          resolveUiTaskWorkbenchArtifactTarget(route, loadUiSnapshot(spec, workspaceRoot)),
          workspaceRoot,
        ),
        projectContext: loadUiProjectContext(spec, workspaceRoot),
        operatorDecisions: collectOperatorDecisionsForUi({ workspaceRoot }),
        queueSummary: buildQueueSummaryForUi({ workspaceRoot }),
        returnTo: request.url ?? "",
        route: route ?? {
          kind: "home",
          path: "/",
          runId: null,
          taskId: null,
        },
        snapshot: {},
        scriptNonce,
        title,
        workerMode: workerController.mode,
      });
      writeUiHtmlResponse(response, html, 500);
    }
  });

  const listening = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });

  if (!listening || typeof listening !== "object") {
    throw new Error("failed to resolve UI server address");
  }
  requestGuard = createUiRequestGuard({
    allowedOrigins,
    bindHost: host,
    bindPort: listening.port,
    bootstrapSecret,
  });
  liveSocketHub = createUiLiveSocketHub({
    authorizeUpgrade: requestGuard.authorizeWebSocket,
    liveBus,
    spec,
    workspaceRoot,
  });
  server.on("upgrade", (request, socket) => {
    try {
      liveSocketHub.handleUpgrade(request, socket);
    } catch {
      socket.destroy();
    }
  });

  const url = formatUiServerUrl(host, listening.port);
  const bootstrapUrl = new URL("/__niis/auth/bootstrap", url);
  bootstrapUrl.searchParams.set("token", bootstrapSecret);

  console.log(`Serving local control plane at ${url}`);

  if (openRequested) {
    const launched = launchUiTarget(bootstrapUrl.href);
    console.log(`Opened local control-plane viewer via ${launched.command}`);
  } else {
    process.stdout.write(`Open this one-time operator URL:\n${bootstrapUrl.href}\n`);
  }

  await new Promise((resolve) => {
    let shutdownPromise = null;
    const shutdown = () => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {



        const forceExit = setTimeout(
          () => process.exit(0),
          UI_SHUTDOWN_FORCE_EXIT_MS,
        );
        forceExit.unref?.();
        try {
          try {
            await shutdownSupervisor();
          } catch (error) {
            process.stderr.write(
              `[niis-ui] Durable supervisor shutdown failed: `
              + `${error instanceof Error ? error.message : String(error)}.\n`,
            );
          }

          try {
            liveSocketHub?.close();
          } catch (error) {
            process.stderr.write(
              `[niis-ui] Live socket shutdown failed: `
              + `${error instanceof Error ? error.message : String(error)}.\n`,
            );
          }

          await new Promise((resolveClose) => {
            try {
              server.close(resolveClose);
            } catch (error) {
              process.stderr.write(
                `[niis-ui] HTTP server shutdown failed: `
                + `${error instanceof Error ? error.message : String(error)}.\n`,
              );
              resolveClose();
            }
          });
        } finally {
          clearTimeout(forceExit);
        }
      })().finally(() => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        resolve();
      });
      return shutdownPromise;
    };

    const onSignal = () => {
      void shutdown();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

async function runUi(args = []) {
  const specPath = resolveOptionalSpecPath(args);
  const spec = specPath ? loadExecutionSpec(specPath) : {};
  ensureUiSchemaReady(spec, resolveWorkspaceRoot());
  const snapshot = policy.redactValue(loadUiSnapshot(spec, resolveWorkspaceRoot()));
  const serveConfig = normalizeUiServeConfig(args, spec);
  const openRequested = args.includes("--open") || Boolean(spec.open ?? spec.open_viewer ?? false);
  const outputPath = resolveUiOutputPath(args, spec, {
    openRequested,
  });
  const title = resolveFlagValue(args, "--title")
    ?? spec.title
    ?? (serveConfig.serve_requested ? "Niis Local Control Plane" : "Niis Local Dashboard");

  if (serveConfig.serve_requested) {
    await serveUiApp({
      allowedOrigins: serveConfig.allowedOrigins,
      host: serveConfig.host,
      openRequested,
      port: serveConfig.port,
      spec,
      title,
    });
    return;
  }

  const html = buildLocalDashboardDocument({
    filters: normalizeUiFilters(args, spec),
    focusTaskId:
      resolveFlagValue(args, "--focus-task-id")
      ?? spec.focusTaskId
      ?? spec.focus_task_id
      ?? null,
    now: spec.now ?? new Date(),
    recentBlockerLimit:
      spec.recentBlockerLimit
      ?? spec.recent_blocker_limit
      ?? 5,
    recentRunLimit:
      spec.recentRunLimit
      ?? spec.recent_run_limit
      ?? 5,
    snapshot,
    title,
  });

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, html);
    console.log(`Wrote local dashboard HTML to ${outputPath}`);

    if (openRequested) {
      const launched = launchUiTarget(outputPath);
      console.log(`Opened local dashboard viewer via ${launched.command}`);
    }

    return;
  }

  process.stdout.write(html);
}

async function loadLifecycleTaskInput({
  executorRuntime = null,
  plan,
  taskId,
  workspaceRoot,
}) {
  const sqliteStorage = storage.createSqliteStorage({
    databasePath: plan.databasePath,
    readonly: true,
  });
  let task = null;
  try {
    task = (await sqliteStorage.tasks.list()).find((entry) => entry.id === taskId) ?? null;
  } finally {
    sqliteStorage.close();
  }
  if (!task) {
    throw new Error(`task not found in SQLite: ${taskId}`);
  }
  if (task.task_kind === "agent_tick") {
    return {
      agentTickTask: task,
      artifact: null,
      executorRuntime: null,
    };
  }

  const savedPrefs = taskIntake.readRuntimePreferences({
    stateRoot: plan.stateRoot,
    taskId,
  });
  const effectiveExecutorRuntime = executorRuntime
    ?? savedPrefs.executor_runtime
    ?? null;
  const artifact = await ensureTaskIntakeArtifact({
    databasePath: plan.databasePath,
    executorRuntime: effectiveExecutorRuntime,
    plannerRuntime: savedPrefs.planner_runtime ?? null,
    stateRoot: plan.stateRoot,
    taskId,
    workspaceRoot,
  });
  return {
    agentTickTask: null,
    artifact,
    executorRuntime: effectiveExecutorRuntime,
  };
}

async function runLifecycleSchedulerOnce({
  executorRuntime = null,
  trigger = "serve",
  workspaceRoot = resolveWorkspaceRoot(),
}) {
  const plan = createInitPlan(workspaceRoot);
  if (!fs.existsSync(plan.stateRoot)) {
    throw new Error("state root is missing; run `init` first");
  }
  const cancellationRecovery = await recoverDurableLifecycleCancellations({
    databasePath: plan.databasePath,
    stateRoot: plan.stateRoot,
  });
  if (cancellationRecovery.finalized.length > 0) {
    const recovered = cancellationRecovery.finalized[0];
    return {
      cancellation_recovery: cancellationRecovery,
      claimed: false,
      lifecycle: recovered.lifecycle,
      queue_state: "CANCELLED",
      task_id: recovered.task_id,
    };
  }
  if (cancellationRecovery.pending.length > 0) {
    return {
      busy: true,
      cancellation_pending: cancellationRecovery.pending,
      claimed: false,
    };
  }
  const holder = `serve:${process.pid}:${randomUUID()}`;
  const projectExecutionLease = await acquireProjectExecutionLease({
    allowInherited: false,
    holder,
    stateRoot: plan.stateRoot,
  });
  let store = null;
  const claimTtlMs = LIFECYCLE_QUEUE_CLAIM_TTL_MS;
  let heartbeatTimer = null;
  let heartbeatError = null;
  let claimed = null;

  try {
    store = storage.createLifecycleSqliteStore({
      databasePath: plan.databasePath,
    });
    const reconciliation = await reconcileFileQueueProjection({
      applyPending: true,
      stateRoot: plan.stateRoot,
      store,
    });
    await reconcileLifecycleCompatibilityStatuses({
      databasePath: plan.databasePath,
    });
    const autoRepairReconciliation = await reconcileEligibleAutoRepairs({
      databasePath: plan.databasePath,
      stateRoot: plan.stateRoot,
      store,
      workspaceRoot,
    });
    if (autoRepairReconciliation.scheduled.length > 0) {
      await reconcileLifecycleCompatibilityStatuses({
        databasePath: plan.databasePath,
      });
    }
    const foreignActiveClaim = (await store.queue.list()).find((entry) =>
      entry.claimed_by !== holder
      && isActiveLifecycleQueueClaim(entry));
    if (foreignActiveClaim) {
      return {
        busy: true,
        claimed: false,
        claimed_task_id: foreignActiveClaim.task_id,
        auto_repair_reconciliation: autoRepairReconciliation,
        reconciliation,
      };
    }
    claimed = await store.queue.claimNext({
      holder,
      ttlMs: claimTtlMs,
    });
    if (!claimed) {
      return {
        auto_repair_reconciliation: autoRepairReconciliation,
        claimed: false,
        reconciliation,
      };
    }
    await reconcileFileQueueProjection({
      applyPending: true,
      stateRoot: plan.stateRoot,
      store,
    });

    const approvedPlan = await readApprovedPlan({
      databasePath: plan.databasePath,
      stateRoot: plan.stateRoot,
      taskId: claimed.task_id,
    });
    if (!approvedPlan) {
      await store.queue.transition({
        expectedState: "CLAIMED",
        holder,
        nextState: "BLOCKED",
        payloadPatch: {
          blocked_reason: "plan_approval_required",
        },
        taskId: claimed.task_id,
      });
      await reconcileFileQueueProjection({
        applyPending: true,
        stateRoot: plan.stateRoot,
        store,
      });
      return {
        claimed: true,
        lifecycle: null,
        queue_state: "BLOCKED",
        reconciliation,
        reason: "plan_approval_required",
        task_id: claimed.task_id,
      };
    }

    let heartbeatRunning = false;
    heartbeatTimer = setInterval(() => {
      if (heartbeatRunning || heartbeatError) return;
      heartbeatRunning = true;
      store.queue.heartbeatClaim({
        holder,
        taskId: claimed.task_id,
        ttlMs: claimTtlMs,
      }).catch((error) => {
        heartbeatError = error;
      }).finally(() => {
        heartbeatRunning = false;
      });
    }, LIFECYCLE_QUEUE_HEARTBEAT_MS);
    heartbeatTimer.unref?.();

    const input = await loadLifecycleTaskInput({
      executorRuntime,
      plan,
      taskId: claimed.task_id,
      workspaceRoot,
    });
    const lifecycleResult = await executeTaskViaLifecycle({
      ...input,
      plan,
      promotionFailAfterStep: resolveTestPromotionFailureStep(),
      queueClaimHolder: holder,
      taskId: claimed.task_id,
      trigger,
      workspaceRoot,
    });
    if (heartbeatError) throw heartbeatError;
    const finalizedQueueEntry = await store.queue.byTask(claimed.task_id);
    return {
      auto_repair_reconciliation: autoRepairReconciliation,
      claimed: true,
      lifecycle: lifecycleResult,
      queue_state:
        finalizedQueueEntry?.state
        ?? durableQueueStateFromAttempt(lifecycleResult),
      reconciliation,
      task_id: claimed.task_id,
      task_result: taskResultFromAttempt(lifecycleResult),
    };
  } catch (error) {
    if (claimed) {
      try {
        const disposition = await settleOwnedLifecycleQueueClaimAfterError({
          attemptId:
            typeof claimed.payload?.attempt_id === "string"
              ? claimed.payload.attempt_id
              : null,
          error,
          holder,
          stateRoot: plan.stateRoot,
          store,
          taskId: claimed.task_id,
        });
        if (
          disposition.kind === "RESUMABLE"
          || disposition.kind === "CANCELLATION_REQUESTED"
        ) {
          await reconcileLifecycleCompatibilityStatuses({
            databasePath: plan.databasePath,
            taskId: claimed.task_id,
          });
        } else {
          await synchronizeTaskStatusFromLifecycleResult({
            databasePath: plan.databasePath,
            lifecycleResult: disposition.lifecycleResult,
            taskId: claimed.task_id,
          });
        }
      } catch (finalizationError) {
        process.stderr.write(
          `[niis serve] failed to settle claim for ${claimed.task_id}: `
          + `${finalizationError instanceof Error ? finalizationError.message : String(finalizationError)}\n`,
        );
      }
    }
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    store?.close();
    await projectExecutionLease.release();
  }
}



async function runAutonomousWorker(args) {
  process.stderr.write(
    "[niis] `worker` is deprecated; delegating to `serve --daemon` at concurrency 1.\n",
  );
  return runServe([
    ...args.filter((arg) => arg !== "--once" && arg !== "--daemon"),
    "--daemon",
    "--trigger",
    "worker",
  ]);
}

async function assertDaemonReadinessForWorkspace(workspaceRoot) {
  const plan = createInitPlan(workspaceRoot);
  if (!fs.existsSync(plan.databasePath)) {
    throw new Error("state database is missing; run `init` first");
  }
  const store = storage.createLifecycleSqliteStore({
    databasePath: plan.databasePath,
    readonly: true,
  });
  try {
    return await assertDaemonReadiness({
      projectId: deriveBootstrapProjectId(workspaceRoot),
      resolveSourceStore: createReadinessSourceStoreResolver(),
      stateRoot: plan.stateRoot,
      store,
    });
  } finally {
    store.close();
  }
}

function createReadinessSourceStoreResolver() {
  return async (source) => {
    const stateRoot = path.resolve(source?.state_root ?? "");
    const workspaceRoot = path.dirname(stateRoot);
    if (!assertSafeExistingStateRoot({ stateRoot, workspaceRoot })) {
      throw new Error(`readiness source state is missing: ${stateRoot}`);
    }
    if (deriveBootstrapProjectId(workspaceRoot) !== source?.project_id) {
      throw new Error("readiness source project identity does not match its state root");
    }
    const sourcePlan = createInitPlan(workspaceRoot);
    if (sourcePlan.stateRoot !== fs.realpathSync.native(stateRoot)) {
      throw new Error("readiness source does not resolve to the expected state root");
    }
    if (!fs.existsSync(sourcePlan.databasePath)) {
      throw new Error(`readiness source database is missing: ${sourcePlan.databasePath}`);
    }
    const sourceStore = storage.createLifecycleSqliteStore({
      databasePath: sourcePlan.databasePath,
      readonly: true,
    });
    return {
      release() {
        sourceStore.close();
      },
      store: sourceStore,
    };
  };
}

async function runReadiness(args = []) {
  const action = args[0] ?? "status";
  if (!["status", "record"].includes(action)) {
    throw new Error(
      "readiness accepts `status` or `record --kind <rollout_phase|canary_task> --task-id <id> --attempt-id <id> [--source-workspace <path>]`; rollout phases are derived from durable attempt evidence",
    );
  }
  const workspaceRoot = resolveWorkspaceRoot();
  const plan = createInitPlan(workspaceRoot);
  if (!fs.existsSync(plan.databasePath)) {
    throw new Error("state database is missing; run `init` first");
  }
  const store = storage.createLifecycleSqliteStore({
    databasePath: plan.databasePath,
    readonly: true,
  });
  try {
    if (action === "status") {
      const status = await verifyDaemonReadiness({
        projectId: deriveBootstrapProjectId(workspaceRoot),
        resolveSourceStore: createReadinessSourceStoreResolver(),
        stateRoot: plan.stateRoot,
        store,
      });
      console.log(JSON.stringify(status, null, 2));
      return status;
    }

    const kind = resolveFlagValue(args, "--kind");
    const taskId = resolveFlagValue(args, "--task-id");
    const attemptId = resolveFlagValue(args, "--attempt-id");
    if (!["rollout_phase", "canary_task"].includes(kind)) {
      throw new Error("--kind must be rollout_phase or canary_task");
    }
    if (!taskId || !attemptId) {
      throw new Error("--task-id and --attempt-id are required");
    }
    if (resolveFlagValue(args, "--phase")) {
      throw new Error(
        "--phase is not accepted; rollout phase identity is derived from durable attempt evidence",
      );
    }
    const sourceWorkspace = path.resolve(
      process.cwd(),
      resolveFlagValue(args, "--source-workspace") ?? workspaceRoot,
    );
    const sourcePlan = createInitPlan(sourceWorkspace);
    if (!assertSafeExistingStateRoot({
      stateRoot: sourcePlan.stateRoot,
      workspaceRoot: sourceWorkspace,
    })) {
      throw new Error(`readiness source state is missing: ${sourcePlan.stateRoot}`);
    }
    if (!fs.existsSync(sourcePlan.databasePath)) {
      throw new Error(`readiness source database is missing: ${sourcePlan.databasePath}`);
    }
    const usesCanonicalStore =
      fs.realpathSync.native(sourcePlan.stateRoot)
      === fs.realpathSync.native(plan.stateRoot);
    const sourceStore = usesCanonicalStore
      ? store
      : storage.createLifecycleSqliteStore({
          databasePath: sourcePlan.databasePath,
          readonly: true,
        });
    let recorded;
    try {
      recorded = await recordDaemonReadinessEvidence({
        attemptId,
        destinationProjectId: deriveBootstrapProjectId(workspaceRoot),
        kind,
        sourceProjectId: deriveBootstrapProjectId(sourceWorkspace),
        sourceStateRoot: sourcePlan.stateRoot,
        stateRoot: plan.stateRoot,
        store: sourceStore,
        taskId,
      });
    } finally {
      if (!usesCanonicalStore) {
        sourceStore.close();
      }
    }
    const status = await verifyDaemonReadiness({
      projectId: deriveBootstrapProjectId(workspaceRoot),
      resolveSourceStore: createReadinessSourceStoreResolver(),
      stateRoot: plan.stateRoot,
      store,
    });
    const result = { recorded, status };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    store.close();
  }
}

async function runServe(args = []) {
  const once = args.includes("--once");
  const daemon = args.includes("--daemon");
  if (once === daemon) {
    throw new Error("serve accepts exactly one of --once or --daemon");
  }
  const firstArg = args[0] ?? null;
  if (firstArg && !firstArg.startsWith("-")) {
    if (daemon) {
      throw new Error("spec-driven serve compatibility is read-only and accepts only --once");
    }
    process.stderr.write(
      "[niis] Spec-driven serve startup is deprecated; task dispatch is disabled on this compatibility path.\n",
    );
    return runLegacyServeSpec(args);
  }

  const concurrency = Number.parseInt(
    resolveFlagValue(args, "--max-concurrent") ?? "1",
    10,
  );
  if (concurrency !== 1) {
    throw new Error("Reliability RC serve concurrency is fixed at 1");
  }
  const workspaceRoot = resolveWorkspaceRoot();
  const config = getAutonomousWorkerConfig({ workspaceRoot });
  const requestedPoll = Number.parseInt(
    resolveFlagValue(args, "--poll-interval") ?? String(config.poll_interval_ms),
    10,
  );
  const pollMs = Number.isFinite(requestedPoll)
    ? Math.max(500, requestedPoll)
    : Math.max(500, config.poll_interval_ms);
  const trigger = resolveFlagValue(args, "--trigger") ?? "serve";

  if (once) {
    const result = await runLifecycleSchedulerOnce({
      executorRuntime: resolveFlagValue(args, "--executor-runtime"),
      trigger,
      workspaceRoot,
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const readiness = await assertDaemonReadinessForWorkspace(workspaceRoot);
  process.stderr.write(
    `[niis serve] daemon started; poll=${pollMs}ms, concurrency=1, `
    + `verified_canaries=${readiness.observed_consecutive_clean_tasks}\n`,
  );
  let stopping = false;
  let wake = null;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`[niis serve] received ${signal}; stopping after the current lifecycle.\n`);
    wake?.();
  };
  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    while (!stopping) {
      try {
        const result = await runLifecycleSchedulerOnce({
          executorRuntime: resolveFlagValue(args, "--executor-runtime"),
          trigger,
          workspaceRoot,
        });
        if (result.claimed) {
          process.stderr.write(
            `[niis serve] ${result.task_id}: ${result.queue_state ?? result.reason ?? "processed"}\n`,
          );
          continue;
        }
      } catch (error) {
        process.stderr.write(
          `[niis serve] tick failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        if (error?.code === "queue_projection_requires_operator") {
          throw error;
        }
      }
      if (stopping) break;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, pollMs);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  process.stderr.write("[niis serve] stopped.\n");
}

async function runLegacyServeSpec(args) {
  const spec = loadExecutionSpec(resolveSpecPath(args));
  if ((spec.maxTicks ?? 1) !== 0) {
    throw new Error(
      "spec-driven serve task dispatch is disabled; use `niis serve --once` or `niis serve --daemon`",
    );
  }
  const activatedPackages = await loadActivatedRuntimePackagesForSpec(spec, {
    packageTypes: ["role", "adapter", "agent"],
    context: {
      command: "serve",
      task: null,
    },
  });
  const plan = createInitPlan(resolveWorkspaceRoot());
  const backupRuntime = createServeBackupRuntime(spec, plan);
  const secretStore = fs.existsSync(plan.stateRoot)
    ? storage.createLocalSecretStore({
      stateRoot: plan.stateRoot,
    })
    : null;
  const runtimeStorage = await createServeSpecStorage({
    ...spec,
    agents: [
      ...(spec.agents ?? []),
      ...activatedPackages.agents,
    ],
  });
  const started = await serveRuntime.startServeLoop({
    adapters: [
      ...instantiateSpecAdapters(spec.adapters),
      ...activatedPackages.adapters,
    ],
    agentId: spec.agentId ?? "cli-agent",
    backupRuntime,
    bootstrapContext: spec.bootstrapContext ?? {},
    checkpointsByTaskId: spec.checkpointsByTaskId ?? {},
    confirmationThreshold: spec.confirmationThreshold ?? 1,
    grantedApprovals: spec.grantedApprovals ?? [],
    grantedAuthorities: spec.grantedAuthorities ?? [],
    maxTurns: spec.maxTurns ?? 3,
    referenceBundle: spec.referenceBundle ?? {},
    retryPolicy: spec.retryPolicy ?? {},
    roleManifests: [
      ...(spec.roleManifests ?? []),
      ...activatedPackages.roleManifests,
    ],
    routingPolicy: spec.routingPolicy ?? {},
    secretStore,
    storage: runtimeStorage,
    watchConfig: {
      ...(spec.watchConfig ?? {}),
      taskSources: instantiateServeTaskSources(spec.watchConfig?.taskSources ?? []),
    },
    workspace: ensureServeWorkspace(spec.workspace ?? {}),
  });
  const ticks = [];
  let state = started.state;
  const maxTicks = spec.maxTicks ?? 1;

  for (let tickIndex = 0; tickIndex < maxTicks; tickIndex += 1) {
    const tickResult = await serveRuntime.runServeTick({
      config: started.config,
      now: spec.now ?? new Date(),
      state,
    });
    state = tickResult.state;
    ticks.push({
      claimed_task_id: tickResult.claimResult?.claimed?.task.id ?? null,
      dispatch_status: tickResult.dispatch?.status ?? null,
      phases: tickResult.phases,
    });
  }

  const shutdown = await serveRuntime.stopServeLoop(started.config, state, spec.now ?? new Date());
  const snapshot = typeof runtimeStorage.snapshot === "function" ? runtimeStorage.snapshot() : null;

  if (typeof runtimeStorage.close === "function") {
    runtimeStorage.close();
  }

  console.log(JSON.stringify({
    shutdown,
    snapshot,
    startup: started.startup,
    ticks,
  }, null, 2));
}

function printHelp() {
  console.log("Usage: niis <command>");
  console.log("");
  console.log("Bootstrap commands:");
  console.log("- init   Create missing bootstrap state or verify/repair an existing compatible state without overwriting it");
  console.log("- reset-state --backup-to <external-path> --confirm <project-id> Reset state only after a verified external backup");
  console.log("- attach [--validation-surface-root <path>] Record the attached validation surface and generate reviewable onboarding artifacts");
  console.log("- profile [--validation-surface-root <path>] Generate or refresh the reviewable project profile from the attached repository");
  console.log("- intake [--text <text> | --file <path> | -] [--task-id <id>] [--title <title>] [--priority <p>] [--phase <n>] [--planner-runtime <codex|claude>] Create a task card and plan without starting execution");
  console.log("- approve-plan --task-id <id> [--note <text>] Record explicit operator approval for the current plan");
  console.log("- start-task --task-id <id> Start an approved task through the durable lifecycle");
  console.log("- readiness status|record Read or append machine-verified rollout/canary evidence; daemon remains locked until all required evidence is present");
  console.log("- delete-task --task-id <id> Permanently remove a task: SQLite rows, intake artifacts, queue entry, subtask worktrees, and niis branches");
  console.log("- doctor [--security] Report bootstrap package health and optional read-only security findings");
  console.log("- render-artifacts (--stub|--codex|--claude) (--artifact <id>|--all) [--force] [--confirm-provider-cost] Render explicit project artifact previews; provider modes may consume paid credits");
  console.log("- secret-set --ref <secret://...> [--value <v> | --value-env <ENV>] Store or rotate an encrypted local secret");
  console.log("- secret-list List stored secret refs and metadata without revealing plaintext values");
  console.log("- backup [--retention-days N] Create a manual backup of the local state root");
  console.log("");
  console.log("Coordinator commands:");
  console.log("- route <spec.json> Build and print a coordinator route plan from a JSON spec");
  console.log("- run <spec.json>   Retired execution entrypoint; use intake, approve-plan, and start-task");
  console.log("- review <spec.json> [--persist] Run the policy/validator lane against a JSON spec");
  console.log("- activate <spec.json> Evaluate the package activation security gate from a JSON spec");
  console.log("- discover <spec.json> Discover reviewable package/plugin candidates from configured sources");
  console.log("- discover-pipeline <spec.json> Partition discovery into seeker scopes with incremental downstream subtasks");
  console.log("- promote-instinct <spec.json> Promote a reviewed discovery candidate or policy observation into a durable instinct artifact");
  console.log("- export-instincts <spec.json> Export reviewed instinct artifacts into a reviewable sharing bundle");
  console.log("- import-instincts <spec.json> Import a reviewed instinct bundle with deduplication and confidence-aware merge");
  console.log("- cluster-instincts <spec.json> Cluster related instincts into a reviewed skill candidate artifact");
  console.log("- govern-learning <spec.json> Evaluate the governance gate before learned artifacts may affect active behavior");
  console.log("- observation-lifecycle <spec.json> Evaluate retain/archive/purge lifecycle decisions for observation artifacts");
  console.log("- guard-observation <spec.json> Evaluate cheapest-first guardian checks before background observation runs");
  console.log("- memory-taxonomy <spec.json> Classify learning artifacts into daily, projects, and facts memory tiers");
  console.log("- import <spec.json> Convert an external pack into a reviewable package and conversion report");
  console.log("- plugin-plan <spec.json> Evaluate plugin runtime lifecycle/capability/integration readiness");
  console.log("- storage-plan <spec.json> Read-only storage backend compatibility and migration preflight plan");
  console.log("- upgrade-plan <spec.json> Read-only release/upgrade compatibility and migration preflight plan");
  console.log("- serve --once|--daemon [--poll-interval <ms>] [--executor-runtime <codex|claude>] Reconcile and execute the durable queue at concurrency 1");
  console.log("- worker [--poll-interval <ms>] Deprecated alias for `serve --daemon`");
  console.log("- explain --task-id <id> Read persisted explainability and blocker views from SQLite");
  console.log("- activity --task-id <id> Read the humanized persisted activity stream from SQLite");
  console.log("- metrics [--task-id <id>] [--agent-id <id>] Read cost, budget, queue, and operational metrics from SQLite");
  console.log("- ui [<spec.json>] [--output <file>] [--open] [--serve] [--host <loopback>] [--port <n>] [--status <status>] [--phase <n>] [--task-id <id>] [--focus-task-id <id>] Render the static dashboard or serve the authenticated loopback-only control-plane UI");
  console.log("- asset-health [--path <file>] [--asset-kind <kind>] [--asset-id <id>] [--status <status>] Read the latest derived reusable-asset health report");
  console.log("- worktree <list|prune> [--older-than <minutes>] [--force] Manage per-subtask git worktrees");
  console.log("- subtask list --task-id <id> [--subtask-id <id>] Inspect retained legacy subtask branches; mutation commands are retired in Reliability RC");
  console.log("- queue list [--state <durable-state>] Read authoritative SQLite queue state and projection health");
  console.log("- queue reconcile [--inspect-only] Flush the transactional outbox and report projection divergence without importing file-only entries");
  console.log("- go [--max-parallel 1] [--executor-runtime <codex|claude>] Drain the authoritative durable queue sequentially");
}

export {
  acquireProjectExecutionLease,
  attachBoundedRepairContext,
  attachQueuedAutoRepairContext,
  assertNoDirectUiReviewRerun,
  buildTaskRunEventsApiPayload,
  cancelAllSupervisedLifecycleTasks,
  cancelLifecycleTask,
  claimSpecificLifecycleTask,
  classifyAcceptanceGateReport,
  computePrimaryCheckoutDigest,
  createProcessSupervisor,
  enforceReliabilityRcMergePolicy,
  hasTrustedRuntimeEnforcementEvidence,
  isPidAlive,
  main,
  promoteParallelSubtaskBranchesAfterPass,
  readContainedSourceFile,
  reclaimExpiredTaskLeases,
  reconcileEligibleAutoRepairs,
  reconcileLifecycleCompatibilityStatuses,
  recoverDurableLifecycleCancellations,
  loadPackageAgentStaticManifest,
  releaseTaskLease,
  runAgentTickTask,
  requestLifecycleCancellation,
  renewTaskLease,
  runLifecycleAcceptanceCommands,
  runLifecycleSchedulerOnce,
  resolveLifecycleBudgetReadinessEvidence,
  resolveExecutorDeniedReadRoots,
  resolveReliabilityRcMergePreset,
  settleOwnedLifecycleQueueClaimAfterError,
  scheduleBoundedAutoRepairForQueueEntry,
  spawnSupervisedStartTask,
  synchronizeTaskStatusFromLifecycleResult,
  tryAcquireTaskLease,
};
