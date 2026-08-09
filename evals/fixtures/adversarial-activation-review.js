import { createPackageManifest } from "../../packages/core/src/contracts/packages.js";
import { evaluatePackageActivation } from "../../packages/core/src/runtime/package-activation.js";

const activation = evaluatePackageActivation({
  packageManifest: createPackageManifest({
    activationStatus: "REVIEW",
    capabilities: ["review"],
    compatibility: {
      max_niis_version: null,
      min_niis_version: "0.1.0",
      required_adapters: [],
    },
    id: "pkg-adversarial-review",
    name: "Adversarial Review Package",
    type: "skill",
    version: "0.1.0",
  }),
  policy: {
    activation_review: {
      mode: "auto",
    },
  },
  securityScanSurfaces: [{
    content: "Reviewed onboarding content only.",
    hooks: [],
    id: "candidate-import",
    type: "conversion_candidate",
  }],
  taskId: "eval-adversarial-review-plan",
});

console.log(JSON.stringify({
  activation_allowed: activation.allowed,
  activation_status: activation.package_manifest.activation_status,
  blocker_class: activation.blocker?.blocker_class ?? null,
  policy_refs: activation.explainability.policy_refs,
  review_pattern_id: activation.review_plan.pattern_id,
  review_plan_mode: activation.review_plan.mode,
  review_plan_required: activation.review_plan.required,
  review_stage_roles: activation.review_plan.stage_roles,
  trigger_surface_types: activation.review_plan.trigger_surface_types,
}, null, 2));
