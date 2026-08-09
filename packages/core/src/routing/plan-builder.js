import { selectAdapterByCapabilities } from "../contracts/adapter.js";
import { normalizeContextContract } from "../contracts/context-contract.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { parseSubtaskRecord } from "../schemas/subtask.js";
import { parseTaskRecord } from "../schemas/task.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import { createReferenceBundle } from "../runtime/reference-bundle.js";
import { DEFAULT_EXECUTION_ROLE_MANIFESTS } from "./role-manifests.js";

class RoutingPlanError extends Error {
  constructor(message, {
    code = "ROUTING_PLAN_INVALID",
    details = {},
    retrySafe = false,
  } = {}) {
    super(message);
    this.name = "RoutingPlanError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.retrySafe = retrySafe;
    this.retry_safe = retrySafe;
  }
}

const PLAN_MUTATION_TYPES = Object.freeze([
  "split_subtask",
  "insert_subtask",
  "skip_subtask",
  "reorder_subtasks",
]);

const DEFAULT_ROUTING_POLICY = Object.freeze({
  complexity_tiers: [
    {
      max_score: 4,
      tier: "budget",
    },
    {
      max_score: 8,
      tier: "standard",
    },
    {
      max_score: Number.POSITIVE_INFINITY,
      tier: "premium",
    },
  ],
  fallback_policy_ref: "routing/safe-fallback/v1",
  max_parallel: 2,
  policy_refs: ["routing/coordinator/v1"],
  safe_fallback_manifest: "generalist-worker",
});

const PRIORITY_TO_COMPLEXITY = Object.freeze({
  blocker: 6,
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
});

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RoutingPlanError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RoutingPlanError(`${label} must be a plain object`);
  }

  return value;
}

function ensureInteger(value, label, defaultValue = 0) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (!Number.isInteger(value)) {
    throw new RoutingPlanError(`${label} must be an integer`);
  }

  return value;
}

function ensureStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new RoutingPlanError(`${label} must be an array`);
  }

  return values.map((value, index) => ensureNonEmptyString(value, `${label}[${index}]`));
}

function ensureAssetHealthAssetArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new RoutingPlanError(`${label} must be an array`);
  }

  return values.map((value, index) => {
    const normalizedValue = ensurePlainObject(value, `${label}[${index}]`);

    return Object.freeze({
      asset_id: ensureNonEmptyString(
        normalizedValue.asset_id ?? normalizedValue.assetId,
        `${label}[${index}].asset_id`,
      ),
      asset_kind: ensureNonEmptyString(
        normalizedValue.asset_kind ?? normalizedValue.assetKind,
        `${label}[${index}].asset_kind`,
      ),
    });
  });
}

function normalizeTaskForRouting(task, now = new Date()) {
  const normalizedTask = ensurePlainObject(task, "task");
  const timestamp = toIsoTimestamp(now, "now");

  return parseTaskRecord({
    assigned_to: normalizedTask.assigned_to ?? null,
    created_at: normalizedTask.created_at ?? timestamp,
    depends_on: normalizedTask.depends_on ?? [],
    goal_id: normalizedTask.goal_id ?? null,
    id: ensureNonEmptyString(normalizedTask.id, "task.id"),
    max_rejections: normalizedTask.max_rejections ?? 5,
    out_of_scope: normalizedTask.out_of_scope ?? [],
    phase: normalizedTask.phase ?? 2,
    priority: normalizedTask.priority ?? "medium",
    rejection_count: normalizedTask.rejection_count ?? 0,
    status: normalizedTask.status ?? "PENDING",
    title: ensureNonEmptyString(normalizedTask.title ?? normalizedTask.id, "task.title"),
    transition_log: normalizedTask.transition_log ?? [],
    updated_at: normalizedTask.updated_at ?? timestamp,
  });
}

function normalizeSubtasks(subtasks, taskId, now = new Date()) {
  if (!Array.isArray(subtasks)) {
    return [];
  }

  return subtasks.map((subtask, index) =>
    parseSubtaskRecord({
      assigned_agent: subtask.assigned_agent ?? null,
      created_at: subtask.created_at ?? toIsoTimestamp(now, "now"),
      depends_on: subtask.depends_on ?? [],
      id: ensureNonEmptyString(subtask.id ?? `${taskId}:subtask:${index + 1}`, `subtasks[${index}].id`),
      parent_task_id: subtask.parent_task_id ?? taskId,
      reference_bundle_id: subtask.reference_bundle_id ?? null,
      role_id: subtask.role_id ?? null,
      status: subtask.status ?? "PENDING",
      title: ensureNonEmptyString(subtask.title ?? subtask.id ?? `Subtask ${index + 1}`, `subtasks[${index}].title`),
    }),
  );
}

function normalizeRoutingPolicy(policy = {}) {
  const normalizedPolicy = ensurePlainObject(policy, "routingPolicy");
  const complexityTiers = Array.isArray(normalizedPolicy.complexity_tiers)
    ? normalizedPolicy.complexity_tiers
    : normalizedPolicy.complexityTiers;
  const normalizedComplexityTiers = Array.isArray(complexityTiers)
    ? complexityTiers.map((entry, index) => {
      const normalizedEntry = ensurePlainObject(entry, `complexity_tiers[${index}]`);

      return Object.freeze({
        max_score:
          normalizedEntry.max_score === undefined
            ? Number.POSITIVE_INFINITY
            : Number(normalizedEntry.max_score),
        tier: ensureNonEmptyString(
          normalizedEntry.tier ?? `tier-${index + 1}`,
          `complexity_tiers[${index}].tier`,
        ),
      });
    })
    : DEFAULT_ROUTING_POLICY.complexity_tiers;

  return Object.freeze({
    complexity_tiers: Object.freeze(
      [...normalizedComplexityTiers].sort((left, right) => left.max_score - right.max_score),
    ),
    fallback_policy_ref:
      normalizedPolicy.fallback_policy_ref ?? DEFAULT_ROUTING_POLICY.fallback_policy_ref,
    max_parallel: ensureInteger(
      normalizedPolicy.max_parallel ?? normalizedPolicy.maxParallel,
      "routingPolicy.max_parallel",
      DEFAULT_ROUTING_POLICY.max_parallel,
    ),
    policy_refs: Object.freeze(
      ensureStringArray(
        normalizedPolicy.policy_refs ?? normalizedPolicy.policyRefs ?? DEFAULT_ROUTING_POLICY.policy_refs,
        "routingPolicy.policy_refs",
      ),
    ),
    safe_fallback_manifest:
      normalizedPolicy.safe_fallback_manifest
      ?? normalizedPolicy.safeFallbackManifest
      ?? DEFAULT_ROUTING_POLICY.safe_fallback_manifest,
  });
}

function normalizeAuthority(rawAuthority, index) {
  if (!rawAuthority || typeof rawAuthority !== "object") {
    return Object.freeze({
      can: Object.freeze([]),
      cannot: Object.freeze([]),
    });
  }
  return Object.freeze({
    can: Object.freeze(
      ensureStringArray(rawAuthority.can ?? [], `roleManifests[${index}].authority.can`),
    ),
    cannot: Object.freeze(
      ensureStringArray(rawAuthority.cannot ?? [], `roleManifests[${index}].authority.cannot`),
    ),
  });
}

function normalizeScope(rawScope, index) {
  if (!rawScope || typeof rawScope !== "object") {
    return Object.freeze({ path_globs: Object.freeze([]) });
  }
  return Object.freeze({
    path_globs: Object.freeze(
      ensureStringArray(rawScope.path_globs ?? rawScope.pathGlobs ?? [], `roleManifests[${index}].scope.path_globs`),
    ),
  });
}

function normalizeQualityGates(rawGates, index) {
  if (!Array.isArray(rawGates)) {
    return Object.freeze([]);
  }
  return Object.freeze(rawGates.map((gate, gateIndex) => {
    if (!gate || typeof gate !== "object") {
      throw new RoutingPlanError(`roleManifests[${index}].quality_gates[${gateIndex}] must be an object`);
    }
    const failMode = gate.fail_mode === "soft" ? "soft" : "hard";
    return Object.freeze({
      args: Object.freeze(
        ensureStringArray(gate.args ?? [], `roleManifests[${index}].quality_gates[${gateIndex}].args`),
      ),
      command: ensureNonEmptyString(
        gate.command,
        `roleManifests[${index}].quality_gates[${gateIndex}].command`,
      ),
      fail_mode: failMode,
      id: ensureNonEmptyString(
        gate.id ?? `gate-${gateIndex + 1}`,
        `roleManifests[${index}].quality_gates[${gateIndex}].id`,
      ),
    });
  }));
}

function normalizeModelPreference(rawPref) {
  if (!rawPref || typeof rawPref !== "object") {
    return null;
  }
  const runtime = typeof rawPref.runtime === "string" ? rawPref.runtime.trim() : "";
  const model = typeof rawPref.model === "string" ? rawPref.model.trim() : "";
  if (runtime === "" || model === "") {
    return null;
  }
  return Object.freeze({ model, runtime });
}

function normalizeDocRefs(rawRefs, index) {
  if (!Array.isArray(rawRefs)) {
    return Object.freeze([]);
  }
  return Object.freeze(rawRefs.map((ref, refIndex) => {
    if (typeof ref === "string") {
      return Object.freeze({ path: ref, required: true });
    }
    if (!ref || typeof ref !== "object") {
      throw new RoutingPlanError(`roleManifests[${index}].doc_refs[${refIndex}] must be string or object`);
    }
    return Object.freeze({
      path: ensureNonEmptyString(ref.path, `roleManifests[${index}].doc_refs[${refIndex}].path`),
      required: ref.required !== false,
    });
  }));
}

function normalizeBudget(rawBudget) {
  if (!rawBudget || typeof rawBudget !== "object") {
    return null;
  }
  const monthlyUsd = Number(rawBudget.monthly_usd ?? rawBudget.monthlyUsd ?? 0);
  const perRunUsd = Number(rawBudget.per_run_usd ?? rawBudget.perRunUsd ?? 0);
  if (monthlyUsd <= 0 && perRunUsd <= 0) {
    return null;
  }
  return Object.freeze({
    monthly_usd: monthlyUsd > 0 ? monthlyUsd : null,
    per_run_usd: perRunUsd > 0 ? perRunUsd : null,
  });
}

function normalizeRoleManifest(manifest, index) {
  const normalizedManifest = ensurePlainObject(manifest, `roleManifests[${index}]`);

  return Object.freeze({
    adapter_requirements: Object.freeze({
      operations: ensureStringArray(
        normalizedManifest.adapter_requirements?.operations
          ?? normalizedManifest.operations
          ?? ["execute"],
        `roleManifests[${index}].operations`,
      ),
      permissions: ensureStringArray(
        normalizedManifest.adapter_requirements?.permissions
          ?? normalizedManifest.permissions
          ?? [],
        `roleManifests[${index}].permissions`,
      ),
      protocolTypes: ensureStringArray(
        normalizedManifest.adapter_requirements?.protocolTypes
          ?? normalizedManifest.protocolTypes
          ?? [],
        `roleManifests[${index}].protocolTypes`,
      ),
      toolFamilies: ensureStringArray(
        normalizedManifest.adapter_requirements?.toolFamilies
          ?? normalizedManifest.toolFamilies
          ?? [],
        `roleManifests[${index}].toolFamilies`,
      ),
    }),
    authority: normalizeAuthority(normalizedManifest.authority, index),
    budget: normalizeBudget(normalizedManifest.budget),
    context_contract: normalizeContextContract(
      normalizedManifest.context_contract ?? normalizedManifest.contextContract,
      { roleId: normalizedManifest.id ?? `role-${index + 1}` },
    ),
    doc_refs: normalizeDocRefs(normalizedManifest.doc_refs ?? normalizedManifest.docRefs, index),
    expected_output: ensureNonEmptyString(
      normalizedManifest.expected_output ?? "Complete the assigned work with evidence.",
      `roleManifests[${index}].expected_output`,
    ),
    health_assets: Object.freeze(
      ensureAssetHealthAssetArray(
        normalizedManifest.health_assets ?? normalizedManifest.healthAssets ?? [],
        `roleManifests[${index}].health_assets`,
      ),
    ),
    id: ensureNonEmptyString(
      normalizedManifest.id ?? `role-${index + 1}`,
      `roleManifests[${index}].id`,
    ),
    keywords: Object.freeze(
      ensureStringArray(
        normalizedManifest.keywords ?? normalizedManifest.affinity_keywords ?? [],
        `roleManifests[${index}].keywords`,
      ).map((keyword) => keyword.toLowerCase()),
    ),
    lane: ensureNonEmptyString(
      normalizedManifest.lane ?? normalizedManifest.id ?? `lane-${index + 1}`,
      `roleManifests[${index}].lane`,
    ),
    model_preference: normalizeModelPreference(normalizedManifest.model_preference ?? normalizedManifest.modelPreference),
    path_patterns: Object.freeze(
      ensureStringArray(
        normalizedManifest.path_patterns ?? normalizedManifest.pathPatterns ?? [],
        `roleManifests[${index}].path_patterns`,
      ),
    ),
    priority: ensureInteger(
      normalizedManifest.priority,
      `roleManifests[${index}].priority`,
      0,
    ),
    quality_bar: Object.freeze(
      ensureStringArray(
        normalizedManifest.quality_bar ?? normalizedManifest.qualityBar ?? [],
        `roleManifests[${index}].quality_bar`,
      ),
    ),
    quality_gates: normalizeQualityGates(normalizedManifest.quality_gates ?? normalizedManifest.qualityGates, index),
    safe_fallback: Boolean(
      normalizedManifest.safe_fallback ?? normalizedManifest.safeFallback ?? false,
    ),
    scope: normalizeScope(normalizedManifest.scope, index),
    system_prompt: typeof normalizedManifest.system_prompt === "string"
      ? normalizedManifest.system_prompt
      : (typeof normalizedManifest.systemPrompt === "string" ? normalizedManifest.systemPrompt : null),
  });
}

function normalizeRoleManifests(roleManifests = []) {
  if (!Array.isArray(roleManifests)) {
    throw new RoutingPlanError("roleManifests must be an array");
  }

  if (roleManifests.length === 0) {
    return DEFAULT_EXECUTION_ROLE_MANIFESTS;
  }

  return Object.freeze(roleManifests.map((manifest, index) => normalizeRoleManifest(manifest, index)));
}

function deriveTaskAffinityText(task) {
  return [
    task.id,
    task.title,
    ...(task.out_of_scope ?? []),
  ].join(" ").toLowerCase();
}

const PATH_MATCH_WEIGHT = 2;

function calculatePathAffinityScore(referenceBundle, manifest) {
  const patterns = Array.isArray(manifest.path_patterns) ? manifest.path_patterns : [];
  if (patterns.length === 0) {
    return 0;
  }

  const targetPaths = Array.isArray(referenceBundle?.target_paths)
    ? referenceBundle.target_paths
    : [];
  if (targetPaths.length === 0) {
    return 0;
  }

  const compiledPatterns = patterns
    .map((pattern) => {
      try {
        return new RegExp(pattern, "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (compiledPatterns.length === 0) {
    return 0;
  }

  return targetPaths.reduce((score, candidatePath) => {
    if (typeof candidatePath !== "string") {
      return score;
    }
    const matchedAny = compiledPatterns.some((regex) => regex.test(candidatePath));
    return matchedAny ? score + PATH_MATCH_WEIGHT : score;
  }, 0);
}

function calculateAffinityScore(task, manifest, referenceBundle = null) {
  const affinityText = deriveTaskAffinityText(task);
  const keywordScore = manifest.keywords.reduce((score, keyword) =>
    score + (affinityText.includes(keyword) ? 1 : 0),
  0);
  const pathScore = calculatePathAffinityScore(referenceBundle, manifest);

  return keywordScore + pathScore;
}

function globToRegex(glob) {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i += 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (ch === "?") {
      pattern += "[^/]";
    } else if ("\\^$.|+(){}[]".includes(ch)) {
      pattern += `\\${ch}`;
    } else {
      pattern += ch;
    }
  }
  try {
    return new RegExp(`^${pattern}$`, "i");
  } catch {
    return null;
  }
}

function pathMatchesAnyGlob(candidate, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return true;
  if (typeof candidate !== "string") return false;
  return globs
    .map(globToRegex)
    .filter(Boolean)
    .some((regex) => regex.test(candidate));
}

function applyAuthorityFilter({ manifests, referenceBundle }) {
  const targetPaths = Array.isArray(referenceBundle?.target_paths) ? referenceBundle.target_paths : [];
  const accepted = [];
  const rejected = [];
  for (const manifest of manifests) {
    const globs = manifest?.scope?.path_globs ?? [];
    if (!Array.isArray(globs) || globs.length === 0 || targetPaths.length === 0) {
      accepted.push(manifest);
      continue;
    }
    const outOfScope = targetPaths.find((candidate) => !pathMatchesAnyGlob(candidate, globs));
    if (outOfScope) {
      rejected.push({
        manifest_id: manifest.id,
        reason_rejected: `Out-of-scope path "${outOfScope}" not covered by ${manifest.id} scope.`,
      });
      continue;
    }
    accepted.push(manifest);
  }
  return { accepted, rejected };
}

function selectRoleManifest({
  task,
  roleManifests,
  routingPolicy,
  referenceBundle = null,
} = {}) {
  const manifests = normalizeRoleManifests(roleManifests);
  const { accepted, rejected } = applyAuthorityFilter({
    manifests,
    referenceBundle,
  });
  const candidatePool = accepted.length > 0 ? accepted : manifests;
  const scoredManifests = candidatePool.map((manifest) => ({
    manifest,
    score: calculateAffinityScore(task, manifest, referenceBundle),
  }));
  const matchingManifest = [...scoredManifests]
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (right.manifest.priority !== left.manifest.priority) {
        return right.manifest.priority - left.manifest.priority;
      }

      return left.manifest.id.localeCompare(right.manifest.id);
    })[0];

  if (matchingManifest) {
    return matchingManifest.manifest;
  }

  const safeFallback = manifests.find((manifest) =>
    manifest.id === routingPolicy.safe_fallback_manifest || manifest.safe_fallback,
  );

  if (!safeFallback) {
    throw new RoutingPlanError("no strong affinity match and no safe-fallback role manifest");
  }

  return safeFallback;
}

function estimateTaskComplexity({
  task,
  referenceBundle,
}) {
  const priorityScore = PRIORITY_TO_COMPLEXITY[task.priority] ?? PRIORITY_TO_COMPLEXITY.medium;
  const referenceScore = referenceBundle.target_paths.length
    + referenceBundle.guides.length
    + referenceBundle.examples.length
    + referenceBundle.verifier_refs.length;

  return priorityScore + Math.min(referenceScore, 4) + task.depends_on.length;
}

function selectCostTier({
  task,
  referenceBundle,
  routingPolicy,
}) {
  const complexityScore = estimateTaskComplexity({
    referenceBundle,
    task,
  });
  const selectedTier = routingPolicy.complexity_tiers.find((entry) =>
    complexityScore <= entry.max_score,
  ) ?? routingPolicy.complexity_tiers.at(-1);

  return Object.freeze({
    complexity_score: complexityScore,
    tier: selectedTier.tier,
  });
}

function tierDistance(candidateTier, selectedTier, knownTiers) {
  const candidateIndex = knownTiers.indexOf(candidateTier);
  const selectedIndex = knownTiers.indexOf(selectedTier);

  if (candidateIndex === -1 || selectedIndex === -1) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.abs(candidateIndex - selectedIndex);
}

function summarizeAdapter(adapter) {
  return Object.freeze({
    capabilities: adapter.capabilities(),
    id: adapter.id,
    metadata: adapter.metadata ?? {},
    protocol_type: adapter.protocolType,
  });
}

function selectExecutionLane({
  task,
  adapters,
  roleManifests,
  routingPolicy,
  referenceBundle,
} = {}) {
  const selectedManifest = selectRoleManifest({
    referenceBundle,
    roleManifests,
    routingPolicy,
    task,
  });
  const selectedCostTier = selectCostTier({
    referenceBundle,
    routingPolicy,
    task,
  });
  const capabilitySelection = selectAdapterByCapabilities(
    adapters,
    selectedManifest.adapter_requirements,
  );

  if (!capabilitySelection.selected) {
    throw new RoutingPlanError(
      `no adapter satisfies the declared routing requirements for manifest ${selectedManifest.id}`,
      {
        code: "ROUTING_CAPABILITY_MISMATCH",
        details: {
          adapter_ids: adapters.map((adapter) => adapter.id),
          manifest_id: selectedManifest.id,
          requirements: selectedManifest.adapter_requirements,
        },
        retrySafe: false,
      },
    );
  }

  const knownTiers = routingPolicy.complexity_tiers.map((entry) => entry.tier);




  const preferredRuntime = selectedManifest.model_preference?.runtime ?? null;
  const rankedCandidates = [...capabilitySelection.candidates].sort((left, right) => {
    if (preferredRuntime) {
      const leftPref = left.adapter.id === preferredRuntime ? 0 : 1;
      const rightPref = right.adapter.id === preferredRuntime ? 0 : 1;
      if (leftPref !== rightPref) return leftPref - rightPref;
    }

    const leftTier = left.adapter.metadata?.cost_tier ?? "standard";
    const rightTier = right.adapter.metadata?.cost_tier ?? "standard";
    const leftDistance = tierDistance(leftTier, selectedCostTier.tier, knownTiers);
    const rightDistance = tierDistance(rightTier, selectedCostTier.tier, knownTiers);

    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }

    return left.adapter.id.localeCompare(right.adapter.id);
  });
  const selectedAdapter = rankedCandidates[0]?.adapter ?? capabilitySelection.selected;
  const alternatives = rankedCandidates.slice(1).map((candidate) => {
    const reasonBase = preferredRuntime && selectedAdapter.id === preferredRuntime
      ? `Adapter ${candidate.adapter.id} satisfies the lane contract but role override prefers ${preferredRuntime}.`
      : `Adapter ${candidate.adapter.id} satisfies the lane contract but ranked behind ${selectedAdapter.id} for the ${selectedCostTier.tier} cost tier.`;
    return {
      option: `${selectedManifest.id}/${candidate.adapter.id}`,
      reason_rejected: reasonBase,
    };
  });

  return Object.freeze({
    adapter_summary: summarizeAdapter(selectedAdapter),
    alternatives,
    cost_tier: selectedCostTier,
    lane_id: selectedManifest.lane,
    manifest: selectedManifest,
    selectedAdapter,
  });
}

function createDelegationPayload({
  task,
  executionLane,
  referenceBundle,
} = {}) {
  const manifest = executionLane.manifest ?? {};
  return Object.freeze({
    authority: manifest.authority ?? Object.freeze({ can: Object.freeze([]), cannot: Object.freeze([]) }),
    budget: manifest.budget ?? null,
    context_contract: manifest.context_contract ?? null,
    expected_output: manifest.expected_output,
    model_preference: manifest.model_preference ?? null,
    quality_bar: manifest.quality_bar,
    quality_gates: manifest.quality_gates ?? Object.freeze([]),
    refs: Object.freeze([
      referenceBundle.id,
      ...referenceBundle.target_paths,
      ...referenceBundle.documentation_priority,
    ]),
    role_id: manifest.id,
    scope: manifest.scope ?? Object.freeze({ path_globs: Object.freeze([]) }),
    system_prompt: manifest.system_prompt ?? null,
    why_this_lane: `Route lane ${executionLane.lane_id} selected via manifest ${executionLane.manifest.id} and adapter ${executionLane.adapter_summary.id} for cost tier ${executionLane.cost_tier.tier}. Task ${task.id} matched declared capability and affinity requirements.`,
  });
}

function identifyReadySubtasks(subtasks) {
  const parentTaskId = subtasks[0]?.parent_task_id ?? "task";
  const normalizedSubtasks = normalizeSubtasks(subtasks, parentTaskId);
  const completedIds = new Set(
    normalizedSubtasks
      .filter((subtask) => subtask.status === "DONE")
      .map((subtask) => subtask.id),
  );

  return normalizedSubtasks.filter((subtask) =>
    subtask.status === "PENDING"
    && subtask.depends_on.every((dependencyId) => completedIds.has(dependencyId)),
  );
}

function scopesOverlap(globsA, globsB) {
  if (!Array.isArray(globsA) || !Array.isArray(globsB)) return false;
  if (globsA.length === 0 || globsB.length === 0) return false;
  const regexA = globsA.map(globToRegex).filter(Boolean);
  const regexB = globsB.map(globToRegex).filter(Boolean);
  for (const ra of regexA) {
    for (const rb of regexB) {
      if (ra.source === rb.source) return true;
    }
  }
  for (const globA of globsA) {
    for (const globB of globsB) {
      const prefixA = String(globA).replace(/\*+.*$/, "");
      const prefixB = String(globB).replace(/\*+.*$/, "");
      if (prefixA && prefixB && (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA))) {
        return true;
      }
    }
  }
  return false;
}

function planParallelDispatch({
  subtasks = [],
  maxParallel = DEFAULT_ROUTING_POLICY.max_parallel,
  roleManifests = [],
} = {}) {
  const ready = identifyReadySubtasks(subtasks);
  if (ready.length === 0) return Object.freeze([]);

  if (!Array.isArray(roleManifests) || roleManifests.length === 0) {
    return Object.freeze(ready.slice(0, maxParallel));
  }

  const manifestById = new Map(roleManifests.map((m) => [m.id, m]));
  const selected = [];
  const usedScopes = [];
  for (const subtask of ready) {
    if (selected.length >= maxParallel) break;
    const manifest = subtask.role_id ? manifestById.get(subtask.role_id) : null;
    const scope = manifest?.scope?.path_globs ?? [];
    const collides = usedScopes.some((existing) => scopesOverlap(existing, scope));
    if (collides) continue;
    selected.push(subtask);
    usedScopes.push(scope);
  }
  return Object.freeze(selected);
}

function ensurePlanMutationType(type) {
  const normalizedType = ensureNonEmptyString(type, "mutation.type");

  if (!PLAN_MUTATION_TYPES.includes(normalizedType)) {
    throw new RoutingPlanError(`unsupported plan mutation type: ${normalizedType}`);
  }

  return normalizedType;
}

function createPlanMutationArtifact({
  type,
  taskId,
  runId,
  reason,
  details = {},
  now = new Date(),
  policyRefs = ["routing/plan-mutation/v1"],
} = {}) {
  const mutationType = ensurePlanMutationType(type);
  const timestamp = toIsoTimestamp(now, "now");
  const normalizedDetails = ensurePlainObject(details, "details");
  const event = parseEventLogEntry({
    actor: "coordinator",
    event_type: "POLICY_DECISION",
    id: `${runId}:${mutationType}:${timestamp}`,
    payload: {
      mutation_type: mutationType,
      ...normalizedDetails,
      reason: ensureNonEmptyString(reason, "reason"),
    },
    run_id: ensureNonEmptyString(runId, "runId"),
    task_id: ensureNonEmptyString(taskId, "taskId"),
    timestamp,
  });
  const explainability = parseExplainabilityRecord({
    alternatives_considered: [],
    decision_type: "ROUTE",
    evidence_refs: [],
    human_readable_summary: `Plan mutation ${mutationType} applied: ${reason}.`,
    id: `${runId}:${mutationType}:explainability:${timestamp}`,
    policy_refs: ensureStringArray(policyRefs, "policyRefs"),
    route_chosen: mutationType,
    task_id: taskId,
    timestamp,
  });

  return Object.freeze({
    event,
    explainability,
    type: mutationType,
  });
}

function reorderSubtasks(subtasks, orderedIds) {
  const orderMap = new Map(orderedIds.map((id, index) => [id, index]));

  return [...subtasks].sort((left, right) => {
    const leftOrder = orderMap.has(left.id) ? orderMap.get(left.id) : Number.POSITIVE_INFINITY;
    const rightOrder = orderMap.has(right.id) ? orderMap.get(right.id) : Number.POSITIVE_INFINITY;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return left.id.localeCompare(right.id);
  });
}

function applyPlanMutations({
  subtasks = [],
  mutations = [],
  taskId,
  runId,
  now = new Date(),
} = {}) {
  let nextSubtasks = normalizeSubtasks(subtasks, taskId, now);
  const artifacts = [];

  for (const mutation of mutations) {
    const normalizedMutation = ensurePlainObject(mutation, "mutation");
    const mutationType = ensurePlanMutationType(normalizedMutation.type);
    const details = ensurePlainObject(normalizedMutation.details, "mutation.details");

    if (mutationType === "insert_subtask") {
      const insertedSubtasks = normalizeSubtasks(
        normalizedMutation.subtasks ?? [],
        taskId,
        now,
      );
      const afterId = normalizedMutation.after_id ?? null;
      const insertIndex = afterId
        ? nextSubtasks.findIndex((subtask) => subtask.id === afterId) + 1
        : nextSubtasks.length;

      nextSubtasks = [
        ...nextSubtasks.slice(0, Math.max(insertIndex, 0)),
        ...insertedSubtasks,
        ...nextSubtasks.slice(Math.max(insertIndex, 0)),
      ];
    }

    if (mutationType === "split_subtask") {
      const targetId = ensureNonEmptyString(normalizedMutation.target_id, "mutation.target_id");
      const splitSubtasks = normalizeSubtasks(normalizedMutation.subtasks ?? [], taskId, now);
      nextSubtasks = nextSubtasks.flatMap((subtask) =>
        subtask.id === targetId ? splitSubtasks : [subtask],
      );
    }

    if (mutationType === "skip_subtask") {
      const targetId = ensureNonEmptyString(normalizedMutation.target_id, "mutation.target_id");
      nextSubtasks = nextSubtasks.filter((subtask) => subtask.id !== targetId);
    }

    if (mutationType === "reorder_subtasks") {
      nextSubtasks = reorderSubtasks(
        nextSubtasks,
        ensureStringArray(normalizedMutation.ordered_ids, "mutation.ordered_ids"),
      );
    }

    artifacts.push(
      createPlanMutationArtifact({
        details,
        now,
        reason: normalizedMutation.reason ?? "plan mutation applied",
        runId,
        taskId,
        type: mutationType,
      }),
    );
  }

  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    subtasks: Object.freeze(nextSubtasks),
  });
}

function createIncrementalPipelineMutations({
  taskId,
  runId,
  existingSubtasks = [],
  sourceResults = [],
  createSubtasksFromResult,
  now = new Date(),
} = {}) {
  if (typeof createSubtasksFromResult !== "function") {
    throw new RoutingPlanError("createSubtasksFromResult must be a function");
  }

  const mutations = sourceResults.flatMap((result, index) => ({
    after_id: existingSubtasks.at(-1)?.id ?? null,
    details: {
      source_result_index: index,
    },
    reason: "incremental pipeline produced downstream work",
    subtasks: createSubtasksFromResult(result, index),
    type: "insert_subtask",
  }));

  return applyPlanMutations({
    mutations,
    now,
    runId,
    subtasks: existingSubtasks,
    taskId,
  });
}

function buildRoutePlan({
  task,
  adapters,
  roleManifests = [],
  referenceBundle = {},
  routingPolicy = {},
  subtasks = [],
  now = new Date(),
} = {}) {
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new RoutingPlanError("adapters must be a non-empty array");
  }

  const normalizedTask = normalizeTaskForRouting(task, now);
  const normalizedPolicy = normalizeRoutingPolicy(routingPolicy);
  const normalizedReferenceBundle = createReferenceBundle({
    ...referenceBundle,
    taskId: normalizedTask.id,
    targetPaths: referenceBundle.targetPaths ?? referenceBundle.target_paths ?? [],
    now,
  });
  const executionLane = selectExecutionLane({
    adapters,
    referenceBundle: normalizedReferenceBundle,
    roleManifests,
    routingPolicy: normalizedPolicy,
    task: normalizedTask,
  });
  const delegationPayload = createDelegationPayload({
    executionLane,
    referenceBundle: normalizedReferenceBundle,
    task: normalizedTask,
  });
  const timestamp = toIsoTimestamp(now, "now");
  const explainability = parseExplainabilityRecord({
    alternatives_considered: executionLane.alternatives,
    decision_type: "ROUTE",
    evidence_refs: [normalizedReferenceBundle.id],
    human_readable_summary: `Selected lane ${executionLane.lane_id} with adapter ${executionLane.adapter_summary.id} for task ${normalizedTask.id}.`,
    id: `${normalizedTask.id}:route:${timestamp}`,
    policy_refs: normalizedPolicy.policy_refs,
    route_chosen: `${executionLane.lane_id}/${executionLane.adapter_summary.id}`,
    task_id: normalizedTask.id,
    timestamp,
  });
  const event = parseEventLogEntry({
    actor: "coordinator",
    event_type: "POLICY_DECISION",
    id: `${normalizedTask.id}:route-event:${timestamp}`,
    payload: {
      adapter_id: executionLane.adapter_summary.id,
      alternatives_considered: executionLane.alternatives,
      cost_tier: executionLane.cost_tier,
      delegation_payload: delegationPayload,
      health_assets: executionLane.manifest.health_assets,
      lane_id: executionLane.lane_id,
      manifest_id: executionLane.manifest.id,
      policy_refs: normalizedPolicy.policy_refs,
      reference_bundle_id: normalizedReferenceBundle.id,
    },
    run_id: `route:${normalizedTask.id}`,
    task_id: normalizedTask.id,
    timestamp,
  });
  const normalizedSubtasks = normalizeSubtasks(subtasks, normalizedTask.id, now);
  const dispatchableSubtasks = planParallelDispatch({
    maxParallel: normalizedPolicy.max_parallel,
    roleManifests: normalizeRoleManifests(roleManifests),
    subtasks: normalizedSubtasks,
  });

  return Object.freeze({
    delegation_payload: delegationPayload,
    dispatchable_subtasks: dispatchableSubtasks,
    event,
    explainability,
    reference_bundle: normalizedReferenceBundle,
    routing_policy: normalizedPolicy,
    selected_adapter: executionLane.adapter_summary,
    selectedAdapter: executionLane.selectedAdapter,
    selected_lane: Object.freeze({
      cost_tier: executionLane.cost_tier,
      health_assets: executionLane.manifest.health_assets,
      lane_id: executionLane.lane_id,
      manifest_id: executionLane.manifest.id,
    }),
    task: normalizedTask,
  });
}

export {
  DEFAULT_ROUTING_POLICY,
  PLAN_MUTATION_TYPES,
  RoutingPlanError,
  applyPlanMutations,
  buildRoutePlan,
  createDelegationPayload,
  createIncrementalPipelineMutations,
  createPlanMutationArtifact,
  estimateTaskComplexity,
  identifyReadySubtasks,
  normalizeRoleManifests,
  normalizeRoutingPolicy,
  normalizeTaskForRouting,
  planParallelDispatch,
  selectCostTier,
  selectExecutionLane,
  selectRoleManifest,
};
