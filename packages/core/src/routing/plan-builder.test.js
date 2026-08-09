import test from "node:test";
import assert from "node:assert/strict";

import { createInMemoryTestAdapter } from "../../../adapters/test-adapter.js";
import {
  RoutingPlanError,
  applyPlanMutations,
  buildRoutePlan,
  createIncrementalPipelineMutations,
  normalizeRoleManifests,
  planParallelDispatch,
} from "./plan-builder.js";

test("normalizeRoleManifests defaults execution routing to worker manifests", () => {
  const manifests = normalizeRoleManifests();

  assert.deepEqual(
    manifests.map((manifest) => manifest.id),
    ["generalist-worker", "frontend-specialist", "nodejs-worker", "python-worker"],
  );
});

test("buildRoutePlan reports incompatible adapter routing as non-retryable", () => {
  const memoryOnlyAdapter = createInMemoryTestAdapter({
    id: "memory-only-adapter",
  });

  assert.throws(
    () => buildRoutePlan({
      adapters: [memoryOnlyAdapter],
      roleManifests: [
        {
          id: "shell-worker",
          lane: "generalist",
          safe_fallback: true,
          toolFamilies: ["shell"],
        },
      ],
      task: {
        id: "task-shell",
        title: "Run the requested task",
      },
    }),
    (error) => {
      assert.equal(error instanceof RoutingPlanError, true);
      assert.equal(error.code, "ROUTING_CAPABILITY_MISMATCH");
      assert.equal(error.retry_safe, false);
      assert.equal(error.retrySafe, false);
      assert.equal(error.details.manifest_id, "shell-worker");
      return true;
    },
  );
});

test("buildRoutePlan chooses adapter by affinity and cost tier and emits explainability", () => {
  const cheapAdapter = createInMemoryTestAdapter({
    id: "cheap-adapter",
    capabilities: {
      toolFamilies: ["shell"],
    },
    metadata: {
      cost_tier: "budget",
    },
  });
  const premiumAdapter = createInMemoryTestAdapter({
    id: "premium-adapter",
    capabilities: {
      toolFamilies: ["shell"],
    },
    metadata: {
      cost_tier: "premium",
    },
  });
  const routePlan = buildRoutePlan({
    adapters: [premiumAdapter, cheapAdapter],
    referenceBundle: {
      documentationPriority: ["docs/worker.md"],
      guides: ["Inspect the task and then patch."],
      stepCatalog: ["Read the existing implementation."],
      targetPaths: ["src/ui.js"],
    },
    roleManifests: [
      {
        healthAssets: [
          {
            assetId: "runtime-default-prompt-surface",
            assetKind: "prompt",
          },
        ],
        id: "frontend-specialist",
        keywords: ["ui", "frontend"],
        lane: "frontend",
        priority: 10,
        quality_bar: ["Preserve the existing design system."],
        toolFamilies: ["shell"],
      },
      {
        id: "default-generalist",
        lane: "generalist",
        safe_fallback: true,
      },
    ],
    task: {
      id: "task-ui",
      priority: "low",
      title: "Update the UI route",
    },
  });

  assert.equal(routePlan.selected_lane.lane_id, "frontend");
  assert.deepEqual(routePlan.selected_lane.health_assets, [
    {
      asset_id: "runtime-default-prompt-surface",
      asset_kind: "prompt",
    },
  ]);
  assert.equal(routePlan.selected_adapter.id, "cheap-adapter");
  assert.equal(routePlan.explainability.decision_type, "ROUTE");
  assert.deepEqual(routePlan.event.payload.health_assets, [
    {
      asset_id: "runtime-default-prompt-surface",
      asset_kind: "prompt",
    },
  ]);
  assert.match(routePlan.delegation_payload.why_this_lane, /frontend/);
});

test("buildRoutePlan selects frontend-specialist when target_paths match frontend path_patterns", () => {
  const shellAdapter = createInMemoryTestAdapter({
    id: "shell-adapter",
    capabilities: { toolFamilies: ["shell"] },
    metadata: { cost_tier: "standard" },
  });
  const routePlan = buildRoutePlan({
    adapters: [shellAdapter],
    referenceBundle: {
      targetPaths: ["templates/parser/parser.html"],
    },
    roleManifests: [
      {
        id: "frontend-specialist",
        keywords: ["ui", "frontend"],
        lane: "frontend",
        path_patterns: ["\\.html?$", "(^|/)templates/"],
        priority: 80,
        toolFamilies: ["shell"],
      },
      {
        id: "generalist-worker",
        lane: "generalist",
        priority: 0,
        safe_fallback: true,
      },
    ],
    task: {
      id: "task-rename-label",
      priority: "medium",
      title: "Rename Sample Input to Sample Inputs",
    },
  });

  assert.equal(routePlan.selected_lane.lane_id, "frontend");
  assert.equal(routePlan.selected_lane.manifest_id, "frontend-specialist");
});

test("buildRoutePlan falls back to generalist when target_paths match no specialist patterns", () => {
  const shellAdapter = createInMemoryTestAdapter({
    id: "shell-adapter",
    capabilities: { toolFamilies: ["shell"] },
    metadata: { cost_tier: "standard" },
  });
  const routePlan = buildRoutePlan({
    adapters: [shellAdapter],
    referenceBundle: {
      targetPaths: ["src/lib/utils.js"],
    },
    roleManifests: [
      {
        id: "frontend-specialist",
        keywords: ["ui", "frontend"],
        lane: "frontend",
        path_patterns: ["\\.html?$", "(^|/)templates/"],
        priority: 80,
        toolFamilies: ["shell"],
      },
      {
        id: "generalist-worker",
        lane: "generalist",
        priority: 0,
        safe_fallback: true,
      },
    ],
    task: {
      id: "task-backend-utility",
      priority: "medium",
      title: "Refactor helper to clarify intent",
    },
  });

  assert.equal(routePlan.selected_lane.lane_id, "generalist");
});

test("authority filter drops manifests when target_paths fall outside scope", () => {
  const shellAdapter = createInMemoryTestAdapter({
    id: "shell-adapter",
    capabilities: { toolFamilies: ["shell"] },
    metadata: { cost_tier: "standard" },
  });
  const routePlan = buildRoutePlan({
    adapters: [shellAdapter],
    referenceBundle: {
      targetPaths: ["server/api/handler.go"],
    },
    roleManifests: [
      {
        id: "frontend-specialist",
        keywords: ["ui", "frontend"],
        lane: "frontend",
        path_patterns: ["\\.html?$", "(^|/)templates/"],
        priority: 80,
        scope: { path_globs: ["templates/**", "**/*.html"] },
        toolFamilies: ["shell"],
      },
      {
        id: "generalist-worker",
        lane: "generalist",
        priority: 0,
        safe_fallback: true,
      },
    ],
    task: {
      id: "task-server-handler",
      priority: "medium",
      title: "Adjust handler logic",
    },
  });

  assert.equal(routePlan.selected_lane.lane_id, "generalist");
});

test("planParallelDispatch finds dependency-free subtasks", () => {
  const dispatchable = planParallelDispatch({
    maxParallel: 3,
    subtasks: [
      {
        id: "sub-1",
        parent_task_id: "task-1",
        status: "DONE",
        title: "done",
      },
      {
        depends_on: ["sub-1"],
        id: "sub-2",
        parent_task_id: "task-1",
        status: "PENDING",
        title: "ready",
      },
      {
        depends_on: ["sub-9"],
        id: "sub-3",
        parent_task_id: "task-1",
        status: "PENDING",
        title: "blocked",
      },
    ],
  });

  assert.equal(dispatchable.length, 1);
  assert.equal(dispatchable[0].id, "sub-2");
});

test("applyPlanMutations supports insert, split, skip, and reorder", () => {
  const result = applyPlanMutations({
    mutations: [
      {
        reason: "insert follow-up",
        subtasks: [
          {
            id: "sub-2",
            parent_task_id: "task-1",
            title: "inserted",
          },
        ],
        type: "insert_subtask",
      },
      {
        reason: "split original",
        subtasks: [
          {
            id: "sub-1a",
            parent_task_id: "task-1",
            title: "split a",
          },
          {
            id: "sub-1b",
            parent_task_id: "task-1",
            title: "split b",
          },
        ],
        target_id: "sub-1",
        type: "split_subtask",
      },
      {
        ordered_ids: ["sub-2", "sub-1b", "sub-1a"],
        reason: "move inserted first",
        type: "reorder_subtasks",
      },
      {
        reason: "skip duplicate work",
        target_id: "sub-1a",
        type: "skip_subtask",
      },
    ],
    runId: "run-1",
    subtasks: [
      {
        id: "sub-1",
        parent_task_id: "task-1",
        status: "PENDING",
        title: "original",
      },
    ],
    taskId: "task-1",
  });

  assert.deepEqual(
    result.subtasks.map((subtask) => subtask.id),
    ["sub-2", "sub-1b"],
  );
  assert.equal(result.artifacts.length, 4);
});

test("createIncrementalPipelineMutations inserts downstream work as source results arrive", () => {
  const result = createIncrementalPipelineMutations({
    createSubtasksFromResult: (sourceResult, index) => [
      {
        id: `downstream-${index + 1}`,
        parent_task_id: "task-1",
        title: `Process ${sourceResult.name}`,
      },
    ],
    existingSubtasks: [
      {
        id: "source-1",
        parent_task_id: "task-1",
        status: "PENDING",
        title: "Source work",
      },
    ],
    runId: "run-2",
    sourceResults: [
      {
        name: "artifact-a",
      },
    ],
    taskId: "task-1",
  });

  assert.equal(result.subtasks.length, 2);
  assert.equal(result.subtasks[1].id, "downstream-1");
});

test("buildRoutePlan respects manifest.model_preference.runtime when picking adapter", () => {




  const claudeAdapter = createInMemoryTestAdapter({
    id: "claude_code_local",
    capabilities: { toolFamilies: ["shell"] },
    metadata: { cost_tier: "standard" },
  });
  const codexAdapter = createInMemoryTestAdapter({
    id: "codex_local",
    capabilities: { toolFamilies: ["shell"] },
    metadata: { cost_tier: "standard" },
  });

  const baseManifest = {
    id: "frontend-specialist",
    keywords: ["ui", "frontend"],
    lane: "frontend",
    path_patterns: ["\\.tsx$"],
    priority: 80,
    toolFamilies: ["shell"],
  };
  const task = {
    id: "task-runtime-pref",
    priority: "medium",
    title: "Style header",
  };

  const planNoOverride = buildRoutePlan({
    adapters: [claudeAdapter, codexAdapter],
    referenceBundle: { targetPaths: ["src/header.tsx"] },
    roleManifests: [baseManifest],
    task,
  });
  assert.equal(planNoOverride.selected_lane.manifest_id, "frontend-specialist");
  assert.equal(planNoOverride.selected_adapter.id, "claude_code_local");

  const planWithOverride = buildRoutePlan({
    adapters: [claudeAdapter, codexAdapter],
    referenceBundle: { targetPaths: ["src/header.tsx"] },
    roleManifests: [
      {
        ...baseManifest,
        model_preference: { runtime: "codex_local", model: "gpt-5" },
      },
    ],
    task,
  });
  assert.equal(planWithOverride.selected_adapter.id, "codex_local");
  assert.deepEqual(planWithOverride.delegation_payload.model_preference, {
    model: "gpt-5",
    runtime: "codex_local",
  });
});

test("buildRoutePlan carries the role context contract into the delegation payload", () => {
  const shellAdapter = createInMemoryTestAdapter({
    id: "shell-adapter",
    capabilities: { toolFamilies: ["shell"] },
  });
  const routePlan = buildRoutePlan({
    adapters: [shellAdapter],
    referenceBundle: {
      documentationPriority: ["docs/worker.md"],
      guides: ["Inspect the task and then patch."],
      stepCatalog: ["Read the existing implementation."],
      targetPaths: ["src/ui.js"],
    },
    roleManifests: [
      {
        context_contract: {
          allow: ["task_spec", "role_persona", "operator_guidance"],
          version: 1,
        },
        id: "contract-worker",
        lane: "generalist",
        safe_fallback: true,
        toolFamilies: ["shell"],
      },
    ],
    task: { id: "task-contract", title: "Run the contracted task" },
  });

  assert.deepEqual(routePlan.delegation_payload.context_contract, {
    allow: ["operator_guidance", "role_persona", "task_spec"],
    version: 1,
  });
  assert.equal(routePlan.delegation_payload.role_id, "contract-worker");
});

test("buildRoutePlan surfaces an invalid role context contract as a fail-closed violation", () => {
  const shellAdapter = createInMemoryTestAdapter({
    id: "shell-adapter",
    capabilities: { toolFamilies: ["shell"] },
  });

  assert.throws(
    () => buildRoutePlan({
      adapters: [shellAdapter],
      roleManifests: [
        {
          context_contract: { allow: ["secrets"] },
          id: "contract-worker",
          lane: "generalist",
          safe_fallback: true,
          toolFamilies: ["shell"],
        },
      ],
      task: { id: "task-contract", title: "Run the contracted task" },
    }),
    (error) => error.code === "context_contract_violation"
      && error.violation_kind === "invalid_contract",
  );
});
