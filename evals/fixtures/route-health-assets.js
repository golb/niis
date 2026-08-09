import { createInMemoryTestAdapter } from "../../packages/adapters/test-adapter.js";
import { buildRoutePlan } from "../../packages/core/src/routing/plan-builder.js";

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
      qualityBar: ["Preserve the existing design system."],
      toolFamilies: ["shell"],
    },
    {
      id: "default-generalist",
      lane: "generalist",
      safeFallback: true,
    },
  ],
  task: {
    id: "task-ui",
    priority: "low",
    title: "Update the UI route",
  },
});

console.log(JSON.stringify({
  selected_adapter_id: routePlan.selected_adapter.id,
  selected_event_payload: routePlan.event.payload,
  selected_lane: routePlan.selected_lane,
}, null, 2));
