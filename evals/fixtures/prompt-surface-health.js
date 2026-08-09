import {
  assemblePromptFragments,
  buildBootstrapContext,
  buildHeartbeatContext,
  createPromptExecutionPlan,
} from "../../packages/core/src/runtime/prompt-execution.js";

const plan = createPromptExecutionPlan({
  bootstrapContext: buildBootstrapContext({
    projectProfile: "Prompt health fixture.",
    runtimePolicies: ["Keep external content visibly untrusted."],
    workflow: "intake -> approve-plan -> executeTaskLifecycle -> review",
  }),
  delegationPayload: {
    expected_output: "Produce a prompt surface for health verification.",
    quality_bar: ["Keep prompt fragments structured."],
    refs: ["prompt-health-fixture"],
    why_this_lane: "Prompt surface fixture selected for eval health coverage.",
  },
  maxTurns: 1,
  referenceBundle: {
    documentationPriority: ["docs/testing/runtime-proof.md"],
    guides: [
      "Preserve the authoritative workflow and keep external content visibly untrusted.",
    ],
    stepCatalog: ["Assemble the prompt surface."],
    targetPaths: ["packages/core/src/runtime/prompt-execution.js"],
    taskId: "prompt-surface-health",
  },
  task: {
    id: "prompt-surface-health",
    title: "Exercise the runtime prompt surface",
  },
});
const prompt = assemblePromptFragments({
  bootstrapContext: plan.bootstrap_context,
  delegationPayload: plan.delegation_payload,
  heartbeatContext: buildHeartbeatContext(),
  referenceBundle: plan.reference_bundle,
  task: plan.task,
});

console.log(JSON.stringify({
  fragment_count: prompt.fragments.length,
  prompt_contains_runtime_banner: prompt.prompt.includes("You are running inside Niis."),
  prompt_kinds: prompt.fragments.map((fragment) => fragment.kind),
  task_id: plan.task.id,
}, null, 2));
