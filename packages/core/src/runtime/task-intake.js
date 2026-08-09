import fs from "node:fs";
import path from "node:path";

import {
  AcceptanceCommandPlanError,
  normalizeAcceptanceCommandPlan,
} from "../contracts/acceptance-command-plan.js";
import { createTaskNote } from "../contracts/task-notes.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import { parseTaskIngressRecord } from "../schemas/ingress.js";
import {
  TASK_PRIORITIES,
  assertCanonicalTaskId,
  parseTaskRecord,
} from "../schemas/task.js";
import { parseSubtaskRecord } from "../schemas/subtask.js";
import { canonicalizePath } from "./path-safety.js";

class TaskIntakeError extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskIntakeError";
  }
}

const TASK_INTAKE_PLANNER_MODES = Object.freeze(["structured_planner", "fallback"]);
const DEFAULT_INTAKE_PRIORITY = "medium";
const DEFAULT_INTAKE_PHASE = 0;
const DEFAULT_MAX_REJECTIONS = 5;

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TaskIntakeError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskIntakeError(`${label} must be a plain object`);
  }

  return value;
}

function ensureOptionalStringArray(value) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
}





function ensureOptionalGuideEntryArray(value) {
  if (value === undefined || value === null || !Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim() === "" ? null : entry.trim();
      }
      if (
        entry
        && typeof entry === "object"
        && !Array.isArray(entry)
        && typeof entry.content === "string"
        && entry.content.trim() !== ""
      ) {
        return entry;
      }
      return null;
    })
    .filter(Boolean);
}

function normalizePlannerAcceptanceCommands(value) {
  try {
    return normalizeAcceptanceCommandPlan(value === undefined ? [] : value);
  } catch (error) {
    if (error instanceof AcceptanceCommandPlanError) {
      throw new TaskIntakeError(`plannerOutput.${error.message}`);
    }
    throw error;
  }
}

function buildMarkdownList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function buildDraftDetailsMarkdown(draft) {
  const sections = [];

  if (typeof draft.summary === "string" && draft.summary.trim() !== "") {
    sections.push(draft.summary.trim());
  }

  const targetPaths = buildMarkdownList(draft.target_paths);
  if (targetPaths) {
    sections.push(`## Target Paths\n${targetPaths}`);
  }

  const guidance = buildMarkdownList(draft.operator_guidance);
  if (guidance) {
    sections.push(`## Guidance\n${guidance}`);
  }

  const outOfScope = buildMarkdownList(draft.out_of_scope);
  if (outOfScope) {
    sections.push(`## Out of Scope\n${outOfScope}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

function normalizeMarkdownOverride(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function ensureOptionalPhase(value) {
  if (!Number.isInteger(value) || value < 0) {
    return DEFAULT_INTAKE_PHASE;
  }

  return value;
}

function ensureOptionalPriority(value) {
  if (typeof value !== "string") {
    return DEFAULT_INTAKE_PRIORITY;
  }

  const normalized = value.trim().toLowerCase();
  return TASK_PRIORITIES.includes(normalized) ? normalized : DEFAULT_INTAKE_PRIORITY;
}

function pickFirstMeaningfulLine(operatorPrompt, fallbackValue) {
  const normalizedPrompt = typeof operatorPrompt === "string" ? operatorPrompt : "";
  const meaningfulLine = normalizedPrompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");

  return meaningfulLine ?? fallbackValue;
}

function deriveIntakeTaskTitle(operatorPrompt, fallbackTaskId = "task") {
  const baseTitle = pickFirstMeaningfulLine(operatorPrompt, fallbackTaskId);
  return baseTitle.length > 120 ? `${baseTitle.slice(0, 117)}...` : baseTitle;
}

function normalizePlannerSubtasks(subtasks, { taskId, now, validRoleIds = null }) {
  if (!Array.isArray(subtasks) || subtasks.length < 2 || subtasks.length > 5) {
    return [];
  }

  const allowedRoleIds = Array.isArray(validRoleIds) && validRoleIds.length > 0
    ? new Set(validRoleIds)
    : null;

  const normalizedEntries = subtasks
    .map((subtask, sourceIndex) => {
      if (typeof subtask === "string") {
        return { depends_on_indices: [], role_id: null, sourceIndex, title: subtask.trim() };
      }

      if (subtask && typeof subtask === "object" && typeof subtask.title === "string") {
        const rawRole = typeof subtask.role_id === "string" && subtask.role_id.trim() !== ""
          ? subtask.role_id.trim()
          : null;
        let roleId = rawRole;
        if (rawRole && allowedRoleIds && !allowedRoleIds.has(rawRole)) {
          process.stderr.write(`[niis] Planner emitted unknown role_id "${rawRole}" for subtask "${subtask.title}"; falling back to safe default.\n`);
          roleId = null;
        }
        const dependsOnIndices = Array.isArray(subtask.depends_on)
          ? subtask.depends_on
            .map((value) => Number.parseInt(value, 10))
            .filter((value) => Number.isInteger(value) && value >= 1 && value <= subtasks.length && value !== sourceIndex + 1)
          : [];
        return { depends_on_indices: dependsOnIndices, role_id: roleId, sourceIndex, title: subtask.title.trim() };
      }

      return { depends_on_indices: [], role_id: null, sourceIndex, title: "" };
    })
    .filter((entry) => entry.title !== "");

  if (normalizedEntries.length !== subtasks.length) {
    return [];
  }

  const uniqueTitles = new Set(normalizedEntries.map((entry) => entry.title.toLowerCase()));
  if (uniqueTitles.size !== normalizedEntries.length) {
    return [];
  }

  const idForIndex = (index) => `${taskId}:subtask:${index + 1}`;

  return normalizedEntries.map((entry, index) =>
    parseSubtaskRecord({
      assigned_agent: null,
      created_at: toIsoTimestamp(now, "now"),
      depends_on: entry.depends_on_indices
        .filter((sourceOneBased) => sourceOneBased - 1 < index)
        .map((sourceOneBased) => idForIndex(sourceOneBased - 1)),
      id: idForIndex(index),
      parent_task_id: taskId,
      reference_bundle_id: `${taskId}:reference-bundle`,
      role_id: entry.role_id,
      status: "PENDING",
      title: entry.title,
    }));
}

function normalizePlannerDraft(plannerOutput, {
  operatorPrompt,
  overrides = {},
  taskId,
  now = new Date(),
  validRoleIds = null,
}) {
  const candidate = ensurePlainObject(plannerOutput, "plannerOutput");
  const fallbackTitle = overrides.title ?? deriveIntakeTaskTitle(operatorPrompt, taskId);
  const title = typeof overrides.title === "string" && overrides.title.trim() !== ""
    ? overrides.title.trim()
    : typeof candidate.title === "string" && candidate.title.trim() !== ""
      ? candidate.title.trim()
      : fallbackTitle;
  const summary = typeof candidate.summary === "string" && candidate.summary.trim() !== ""
    ? candidate.summary.trim()
    : operatorPrompt.trim();

  return Object.freeze({
    acceptance_checks: ensureOptionalStringArray(candidate.acceptance_checks),
    acceptance_commands: normalizePlannerAcceptanceCommands(candidate.acceptance_commands),
    operator_guidance: ensureOptionalStringArray(candidate.operator_guidance),
    out_of_scope: ensureOptionalStringArray(candidate.out_of_scope),
    phase: ensureOptionalPhase(overrides.phase ?? candidate.phase),
    priority: ensureOptionalPriority(overrides.priority ?? candidate.priority),
    subtasks: normalizePlannerSubtasks(candidate.subtasks, {
      now,
      taskId,
      validRoleIds,
    }),
    summary,
    target_paths: ensureOptionalStringArray(candidate.target_paths),
    title,
  });
}

function createFallbackPlannerDraft({
  operatorPrompt,
  overrides = {},
  taskId,
  now = new Date(),
}) {
  return Object.freeze({
    acceptance_checks: [],
    acceptance_commands: Object.freeze([]),
    operator_guidance: [],
    out_of_scope: [],
    phase: ensureOptionalPhase(overrides.phase),
    priority: ensureOptionalPriority(overrides.priority),
    subtasks: normalizePlannerSubtasks([], {
      now,
      taskId,
    }),
    summary: operatorPrompt.trim(),
    target_paths: [],
    title: overrides.title ?? deriveIntakeTaskTitle(operatorPrompt, taskId),
  });
}

function createIntakeTaskRecord({
  contentOverrides = {},
  draft,
  operatorPrompt,
  taskId,
  now = new Date(),
}) {
  const timestamp = toIsoTimestamp(now, "now");
  const normalizedOverrides = ensurePlainObject(contentOverrides, "contentOverrides");

  return parseTaskRecord({
    acceptance_markdown: normalizeMarkdownOverride(normalizedOverrides.acceptance_markdown)
      ?? buildMarkdownList(draft.acceptance_checks),
    acceptance_commands: draft.acceptance_commands,
    assigned_to: null,
    created_at: timestamp,
    depends_on: [],
    details_markdown: normalizeMarkdownOverride(normalizedOverrides.details_markdown)
      ?? buildDraftDetailsMarkdown(draft),
    goal_id: null,
    id: taskId,
    max_rejections: DEFAULT_MAX_REJECTIONS,
    operator_brief_markdown: normalizeMarkdownOverride(normalizedOverrides.operator_brief_markdown)
      ?? normalizeMarkdownOverride(operatorPrompt),
    out_of_scope: draft.out_of_scope,
    phase: draft.phase,
    priority: draft.priority,
    rejection_count: 0,
    status: "PENDING",
    title: draft.title,
    transition_log: [{
      actor: "cli:intake",
      from_status: null,
      reason: "Created from operator natural-language intake.",
      timestamp,
      to_status: "PENDING",
    }],
    updated_at: timestamp,
  });
}

function normalizePlannerCost(plannerCost) {
  if (!plannerCost || typeof plannerCost !== "object") {
    return null;
  }

  const inputTokens = Number(plannerCost.input_tokens ?? plannerCost.tokens_in ?? 0);
  const cachedInputTokens = Number(plannerCost.cached_input_tokens ?? plannerCost.tokens_cached ?? 0);
  const outputTokens = Number(plannerCost.output_tokens ?? plannerCost.tokens_out ?? 0);
  const estimatedUsd = Number(plannerCost.estimated_usd ?? 0);
  const durationMs = Number(plannerCost.duration_ms ?? 0);

  if (inputTokens === 0 && outputTokens === 0 && estimatedUsd === 0 && durationMs === 0) {
    return null;
  }

  return Object.freeze({
    duration_ms: durationMs,
    estimated_usd: estimatedUsd,
    tokens_cached: cachedInputTokens,
    tokens_in: inputTokens,
    tokens_out: outputTokens,
  });
}










const INTAKE_TESTABLE_MIN_CHARS = 15;
const INTAKE_VAGUE_VERBS_PATTERN = /^(done|ok|works?|complete|finished|good|fine)\b[.!]?$/i;
const INTAKE_EXPLICIT_NONE_PATTERN = /^(none|n\/a|nothing|not\s+applicable)\b/i;

function validateIntakeAcceptance({ draft, plannerMode }) {
  if (plannerMode !== "structured_planner") {
    return Object.freeze({ issues: Object.freeze([]), ok: true });
  }
  const issues = [];
  const acceptance = Array.isArray(draft?.acceptance_checks) ? draft.acceptance_checks : [];
  if (acceptance.length === 0) {
    issues.push({
      field: "acceptance_checks",
      message: "Planner produced no acceptance criteria. Every structured task must list at least one testable check (what must be true for PASS).",
    });
  } else {
    const vague = acceptance.filter((item) => {
      if (typeof item !== "string") return true;
      const trimmed = item.trim();
      if (trimmed.length < INTAKE_TESTABLE_MIN_CHARS) return true;
      if (INTAKE_VAGUE_VERBS_PATTERN.test(trimmed)) return true;
      return false;
    });
    if (vague.length > 0) {
      issues.push({
        field: "acceptance_checks",
        message: `Acceptance criteria must be testable (>= ${INTAKE_TESTABLE_MIN_CHARS} chars, not "done/works/ok"). Weak entries: ${vague.map((v) => typeof v === "string" ? v : "(non-string)").join(" | ")}`,
      });
    }
  }
  let acceptanceCommands = [];
  try {
    acceptanceCommands = normalizeAcceptanceCommandPlan(
      draft && Object.prototype.hasOwnProperty.call(draft, "acceptance_commands")
        ? draft.acceptance_commands
        : [],
    );
  } catch (error) {
    issues.push({
      field: "acceptance_commands",
      message: error instanceof Error
        ? `Acceptance command plan is invalid: ${error.message}`
        : "Acceptance command plan is invalid.",
    });
  }
  if (acceptanceCommands.length === 0) {
    issues.push({
      field: "acceptance_commands",
      message: "Planner produced no deterministic acceptance command. Every structured task must declare at least one argv-only command plan.",
    });
  } else if (!acceptanceCommands.some((command) => command.required)) {
    issues.push({
      field: "acceptance_commands",
      message: "Planner produced no required acceptance command. At least one deterministic command must participate in the canonical verdict.",
    });
  }
  const outOfScope = Array.isArray(draft?.out_of_scope) ? draft.out_of_scope : [];
  if (outOfScope.length === 0) {
    issues.push({
      field: "out_of_scope",
      message: "Out-of-scope section must be populated. Write 'NONE' explicitly, or list what the agent must not touch (tables, services, feature areas).",
    });
  }
  return Object.freeze({
    issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
    ok: issues.length === 0,
  });
}

function createTaskIntakeArtifact({
  contentOverrides = {},
  now = new Date(),
  operatorPrompt,
  overrides = {},
  plannerCost = null,
  plannerMode = "fallback",
  plannerOutput = null,
  plannerRuntime = null,
  routePreview = null,
  taskId,
  validRoleIds = null,
}) {
  if (!TASK_INTAKE_PLANNER_MODES.includes(plannerMode)) {
    throw new TaskIntakeError(`plannerMode must be one of ${TASK_INTAKE_PLANNER_MODES.join(", ")}`);
  }

  const normalizedTaskId = assertCanonicalTaskId(taskId);
  const normalizedPrompt = ensureNonEmptyString(operatorPrompt, "operatorPrompt");
  const draft = plannerMode === "structured_planner" && plannerOutput
    ? normalizePlannerDraft(plannerOutput, {
      now,
      operatorPrompt: normalizedPrompt,
      overrides,
      taskId: normalizedTaskId,
      validRoleIds,
    })
    : createFallbackPlannerDraft({
      now,
      operatorPrompt: normalizedPrompt,
      overrides,
      taskId: normalizedTaskId,
    });
  const derivedTask = createIntakeTaskRecord({
    contentOverrides,
    draft,
    now,
    operatorPrompt: normalizedPrompt,
    taskId: normalizedTaskId,
  });

  return Object.freeze({
    acceptance_checks: Object.freeze(draft.acceptance_checks),
    acceptance_commands: draft.acceptance_commands,
    acceptance_validation: validateIntakeAcceptance({ draft, plannerMode }),
    created_at: toIsoTimestamp(now, "now"),
    derived_task: derivedTask,
    id: `${normalizedTaskId}:intake`,
    operator_prompt: normalizedPrompt,
    planner_cost: normalizePlannerCost(plannerCost),
    planner_mode: plannerMode,
    planner_runtime: plannerRuntime,
    reference_bundle: Object.freeze({
      guides: Object.freeze(draft.operator_guidance),
      target_paths: Object.freeze(draft.target_paths),
    }),
    route_preview: routePreview ?? null,
    subtasks: Object.freeze(draft.subtasks),
    summary: draft.summary,
    task_id: normalizedTaskId,
  });
}

function createTaskIntakePaths(stateRoot, taskId) {
  const normalizedStateRoot = canonicalizePath(
    ensureNonEmptyString(stateRoot, "stateRoot"),
  );
  const normalizedTaskId = assertCanonicalTaskId(taskId);
  const expectedIntakeRoot = path.join(normalizedStateRoot, "intake");
  const intakeRoot = canonicalizePath(expectedIntakeRoot);
  if (intakeRoot !== expectedIntakeRoot) {
    throw new TaskIntakeError(
      "task intake root must not resolve through a filesystem alias",
    );
  }
  const taskRoot = canonicalizePath(path.join(intakeRoot, normalizedTaskId));
  const relativeTaskRoot = path.relative(intakeRoot, taskRoot);

  if (
    relativeTaskRoot !== normalizedTaskId
    || path.isAbsolute(relativeTaskRoot)
  ) {
    throw new TaskIntakeError(
      "task intake path must be the exact canonical child of the intake root",
    );
  }

  return Object.freeze({
    intake_path: path.join(taskRoot, "intake.json"),
    report_json_path: path.join(taskRoot, "report.json"),
    report_markdown_path: path.join(taskRoot, "report.md"),
    route_preview_path: path.join(taskRoot, "route-preview.json"),
    runtime_preferences_path: path.join(taskRoot, "runtime-preferences.json"),
    task_root: taskRoot,
  });
}

function writeRuntimePreferences({
  stateRoot,
  taskId,
  plannerRuntime = null,
  executorRuntime = null,
}) {
  const paths = createTaskIntakePaths(stateRoot, taskId);
  fs.mkdirSync(paths.task_root, { recursive: true });
  const payload = {
    executor_runtime: executorRuntime,
    planner_runtime: plannerRuntime,
  };
  fs.writeFileSync(paths.runtime_preferences_path, `${JSON.stringify(payload, null, 2)}\n`);
}

function readRuntimePreferences({ stateRoot, taskId }) {
  const paths = createTaskIntakePaths(stateRoot, taskId);

  if (!fs.existsSync(paths.runtime_preferences_path)) {
    return { executor_runtime: null, planner_runtime: null };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(paths.runtime_preferences_path, "utf8"));
    return {
      executor_runtime: typeof parsed.executor_runtime === "string" && parsed.executor_runtime.trim() !== ""
        ? parsed.executor_runtime.trim()
        : null,
      planner_runtime: typeof parsed.planner_runtime === "string" && parsed.planner_runtime.trim() !== ""
        ? parsed.planner_runtime.trim()
        : null,
    };
  } catch {
    return { executor_runtime: null, planner_runtime: null };
  }
}

function writeTaskIntakeArtifacts({
  artifact,
  stateRoot,
}) {
  const normalizedArtifact = ensurePlainObject(artifact, "artifact");
  const paths = createTaskIntakePaths(stateRoot, normalizedArtifact.task_id);
  fs.mkdirSync(paths.task_root, { recursive: true });
  fs.writeFileSync(paths.intake_path, `${JSON.stringify(normalizedArtifact, null, 2)}\n`);
  fs.writeFileSync(
    paths.route_preview_path,
    `${JSON.stringify(normalizedArtifact.route_preview ?? null, null, 2)}\n`,
  );

  return paths;
}

function readTaskIntakeArtifact({
  stateRoot,
  taskId,
}) {
  const paths = createTaskIntakePaths(stateRoot, taskId);

  if (!fs.existsSync(paths.intake_path)) {
    throw new TaskIntakeError(`intake artifact is missing for ${taskId}`);
  }

  return JSON.parse(fs.readFileSync(paths.intake_path, "utf8"));
}

function createOperatorPromptTaskNote({
  now = new Date(),
  operatorPrompt,
  taskId,
}) {
  return createTaskNote({
    authorId: "cli:intake",
    authorType: "operator",
    content: operatorPrompt,
    createdAt: now,
    id: `${taskId}:note:intake:${Date.parse(now)}`,
    taskId,
  });
}

function createOperatorPromptIngressRecord({
  now = new Date(),
  routeCandidate = null,
  sourceRef = null,
  taskId,
}) {
  const timestamp = toIsoTimestamp(now, "now");

  return parseTaskIngressRecord({
    approvals_required: [],
    authority_constraints: [],
    detected_at: timestamp,
    id: `${taskId}:ingress:${Date.parse(timestamp)}`,
    ingress_status: routeCandidate ? "ROUTED" : "DETECTED",
    route_candidate: routeCandidate,
    source_ref: sourceRef ?? `task:${taskId}`,
    source_type: "operator_prompt",
  });
}

function mapVerdictClassToTaskStatus(verdictClass) {
  switch (verdictClass) {
    case "PASS":
      return "DONE";
    case "PARTIAL_PROGRESS":
      return "IN_PROGRESS";
    case "EVIDENCE_GAP":
      return "IN_REVIEW";
    case "DEFECT":



      return "REJECTED";
    case "ENV_BLOCK":
    case "NEEDS_ESCALATION":
    default:
      return "BLOCKED";
  }
}

function transitionTaskStatus(task, {
  actor = "cli:start-task",
  now = new Date(),
  reason,
  status,
}) {
  const normalizedTask = parseTaskRecord(task);
  const nextStatus = ensureNonEmptyString(status, "status");
  const normalizedReason = ensureNonEmptyString(reason, "reason");
  const timestamp = toIsoTimestamp(now, "now");







  let effectiveStatus = nextStatus;
  let effectiveReason = normalizedReason;
  let rejectionCount = normalizedTask.rejection_count ?? 0;
  const transitionLog = [
    ...(normalizedTask.transition_log ?? []),
    {
      actor,
      from_status: normalizedTask.status,
      reason: normalizedReason,
      timestamp,
      to_status: nextStatus,
    },
  ];

  if (nextStatus === "REJECTED") {
    rejectionCount += 1;
    const maxRejections = normalizedTask.max_rejections ?? DEFAULT_MAX_REJECTIONS;
    if (rejectionCount >= maxRejections) {
      effectiveStatus = "BLOCKED";
      effectiveReason = `Task auto-blocked after reaching max rejections (${rejectionCount}/${maxRejections}).`;
      transitionLog.push({
        actor: "system",
        from_status: "REJECTED",
        reason: effectiveReason,
        timestamp,
        to_status: "BLOCKED",
      });
    }
  }

  return parseTaskRecord({
    ...normalizedTask,
    rejection_count: rejectionCount,
    status: effectiveStatus,
    transition_log: transitionLog,
    updated_at: timestamp,
  });
}

function buildExecutionReferenceBundle(artifact) {
  const normalizedArtifact = ensurePlainObject(artifact, "artifact");
  const targetPaths = ensureOptionalStringArray(
    normalizedArtifact.reference_bundle?.target_paths ?? normalizedArtifact.referenceBundle?.targetPaths,
  );
  const guides = ensureOptionalGuideEntryArray(
    normalizedArtifact.reference_bundle?.guides ?? normalizedArtifact.referenceBundle?.guides,
  );
  const acceptanceChecks = ensureOptionalStringArray(
    normalizedArtifact.acceptance_checks ?? normalizedArtifact.acceptanceChecks,
  );
  const documentationPriority = targetPaths.length > 0 ? targetPaths : ["."];

  return Object.freeze({
    documentationPriority,
    guides: [
      ...guides,
      ...acceptanceChecks.map((entry) => ({
        content: `Acceptance check: ${entry}`,
        provenance: { source_ref: "task-intake", source_type: "acceptance_check" },
      })),
      "Inspect the current repository state before editing and keep changes scoped to the task.",
    ],
    stepCatalog: [
      "Inspect the relevant files before changing them.",
      "Implement the smallest coherent change set that satisfies the task.",
      "Summarize changed behavior and verification evidence.",
    ],
    targetPaths: targetPaths.length > 0 ? targetPaths : ["."],
    taskId: normalizedArtifact.task_id,
    verifierRefs: acceptanceChecks.map((entry, index) => ({
      content: entry,
      id: `acceptance-check-${index + 1}`,
      source_ref: "task_intake_artifact",
      source_type: "project",
      title: `Acceptance Check ${index + 1}`,
    })),
  });
}

function buildTaskReport({
  now = new Date(),
  snapshot,
  taskId,
}) {
  const normalizedSnapshot = ensurePlainObject(snapshot, "snapshot");
  const normalizedTaskId = assertCanonicalTaskId(taskId);
  const tasks = Array.isArray(normalizedSnapshot.tasks) ? normalizedSnapshot.tasks : [];
  const taskNotes = Array.isArray(normalizedSnapshot.taskNotes ?? normalizedSnapshot.task_notes)
    ? (normalizedSnapshot.taskNotes ?? normalizedSnapshot.task_notes)
    : [];
  const runs = Array.isArray(normalizedSnapshot.runs) ? normalizedSnapshot.runs : [];
  const blockers = Array.isArray(normalizedSnapshot.blockers) ? normalizedSnapshot.blockers : [];
  const explainability = Array.isArray(normalizedSnapshot.explainability) ? normalizedSnapshot.explainability : [];
  const assignments = Array.isArray(normalizedSnapshot.assignments) ? normalizedSnapshot.assignments : [];
  const ingressRecords = Array.isArray(normalizedSnapshot.ingressRecords ?? normalizedSnapshot.ingress_records)
    ? (normalizedSnapshot.ingressRecords ?? normalizedSnapshot.ingress_records)
    : [];
  const verdicts = Array.isArray(normalizedSnapshot.verdicts) ? normalizedSnapshot.verdicts : [];

  const task = tasks.find((entry) => entry.id === normalizedTaskId) ?? null;
  const filteredRuns = runs.filter((entry) => entry.task_id === normalizedTaskId);
  const filteredAssignments = assignments.filter((entry) => entry.task_id === normalizedTaskId);
  const filteredBlockers = blockers.filter((entry) => entry.task_id === normalizedTaskId);
  const filteredExplainability = explainability.filter((entry) => entry.task_id === normalizedTaskId);
  const filteredTaskNotes = taskNotes.filter((entry) => entry.task_id === normalizedTaskId);
  const filteredIngressRecords = ingressRecords.filter((entry) =>
    entry.source_ref === normalizedTaskId || entry.source_ref === `task:${normalizedTaskId}`);
  const filteredVerdicts = verdicts.filter((entry) => entry.task_id === normalizedTaskId);





  const evidencePackets = Array.isArray(normalizedSnapshot.evidence)
    ? normalizedSnapshot.evidence
    : [];
  const verdictIds = new Set(filteredVerdicts.map((entry) => entry.id));
  const filteredEvidencePackets = evidencePackets.filter((packet) =>
    packet?.verdict_id && verdictIds.has(packet.verdict_id));

  return Object.freeze({
    assignments: Object.freeze(filteredAssignments),
    blockers: Object.freeze(filteredBlockers),
    evidence_packets: Object.freeze(filteredEvidencePackets),
    explainability: Object.freeze(filteredExplainability),
    generated_at: toIsoTimestamp(now, "now"),
    ingress: Object.freeze(filteredIngressRecords),
    runs: Object.freeze(filteredRuns),
    task,
    task_notes: Object.freeze(filteredTaskNotes),
    verdicts: Object.freeze(filteredVerdicts),
  });
}

function renderTaskReportMarkdown(report) {
  const normalizedReport = ensurePlainObject(report, "report");
  const task = normalizedReport.task ?? null;
  const title = task?.title ?? normalizedReport.task_id ?? "Task Report";
  const lines = [
    `# ${title}`,
    "",
    `- Task ID: ${task?.id ?? "unknown-task"}`,
    `- Status: ${task?.status ?? "unknown"}`,
    `- Phase: ${task?.phase ?? "n/a"}`,
    `- Priority: ${task?.priority ?? "n/a"}`,
    `- Generated at: ${normalizedReport.generated_at ?? "unknown"}`,
    "",
    "## Intake Prompt",
  ];

  const intakePrompt = normalizedReport.task_notes?.find((note) => note.author_id === "cli:intake")?.content ?? null;
  if (intakePrompt) {
    lines.push("", intakePrompt, "");
  } else {
    lines.push("", "_No intake prompt recorded._", "");
  }

  lines.push("## Verdicts", "");

  if ((normalizedReport.verdicts ?? []).length === 0) {
    lines.push("_No verdicts recorded._", "");
  } else {
    for (const verdict of normalizedReport.verdicts) {
      lines.push(`- ${verdict.verdict_class}: ${verdict.reason}`);
    }
    lines.push("");
  }

  lines.push("## Runs", "");

  if ((normalizedReport.runs ?? []).length === 0) {
    lines.push("_No runs recorded._", "");
  } else {
    for (const run of normalizedReport.runs) {
      lines.push(`- ${run.id}: ${run.status} via ${run.adapter_id}`);
    }
    lines.push("");
  }

  lines.push("## Explainability", "");

  if ((normalizedReport.explainability ?? []).length === 0) {
    lines.push("_No explainability records recorded._", "");
  } else {
    for (const decision of normalizedReport.explainability) {
      lines.push(`- ${decision.decision_type}: ${decision.human_readable_summary}`);
    }
    lines.push("");
  }




  const evidencePackets = Array.isArray(normalizedReport.evidence_packets)
    ? normalizedReport.evidence_packets
    : [];
  const collectedItems = evidencePackets.flatMap((packet) =>
    (Array.isArray(packet?.items) ? packet.items : []).map((item) => ({
      ...item,
      _evidence_packet_id: packet.id ?? null,
    })));
  const uniqueByKey = new Map();
  for (const item of collectedItems) {
    const key = `${item.type ?? "evidence"}|${item.source ?? ""}|${(item.content ?? "").slice(0, 80)}`;
    if (!uniqueByKey.has(key)) uniqueByKey.set(key, item);
  }
  const deduped = Array.from(uniqueByKey.values());
  lines.push("## Evidence of Completion", "");
  if (deduped.length === 0) {
    lines.push("_No evidence artifacts attached to validator verdicts._", "");
  } else {
    const groups = [
      { header: "### Agent summaries", types: ["subtask_summary", "run_log"] },
      { header: "### Quality gate output", types: ["quality_gate_result"] },
      { header: "### LLM reviewer verdict", types: ["llm_review"] },
      { header: "### Git diff", types: ["git_diff"] },
      { header: "### Other evidence", types: null },
    ];
    const seen = new Set();
    for (const group of groups) {
      const items = group.types === null
        ? deduped.filter((item) => !seen.has(item))
        : deduped.filter((item) => {
          if (!group.types.includes(item.type)) return false;
          seen.add(item);
          return true;
        });
      if (items.length === 0) continue;
      lines.push(group.header, "");
      for (const item of items) {
        const srcLabel = item.subtask_id
          ? `${item.source ?? item.type ?? "evidence"} (subtask ${item.subtask_id})`
          : (item.source ?? item.type ?? "evidence");
        lines.push(`<details><summary>${srcLabel}</summary>`, "", "```", item.content ?? "(empty)", "```", "</details>", "");
      }
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

export {
  DEFAULT_INTAKE_PHASE,
  DEFAULT_INTAKE_PRIORITY,
  TASK_INTAKE_PLANNER_MODES,
  TaskIntakeError,
  buildExecutionReferenceBundle,
  buildTaskReport,
  createFallbackPlannerDraft,
  createIntakeTaskRecord,
  createOperatorPromptIngressRecord,
  createOperatorPromptTaskNote,
  createTaskIntakeArtifact,
  createTaskIntakePaths,
  deriveIntakeTaskTitle,
  mapVerdictClassToTaskStatus,
  normalizePlannerDraft,
  readRuntimePreferences,
  readTaskIntakeArtifact,
  renderTaskReportMarkdown,
  transitionTaskStatus,
  validateIntakeAcceptance,
  writeRuntimePreferences,
  writeTaskIntakeArtifacts,
};
