import { createPackageManifest } from "../../packages/core/src/contracts/packages.js";
import { createAdversarialReviewer } from "../../packages/core/src/runtime/adversarial-review.js";
import { evaluatePackageActivation } from "../../packages/core/src/runtime/package-activation.js";

const scenarioMode = process.argv[2] ?? "pass";

if (!["pass", "escalate"].includes(scenarioMode)) {
  throw new Error(`unsupported adversarial execution mode: ${scenarioMode}`);
}

const activation = evaluatePackageActivation({
  adversarialReviewers: [
    createAdversarialReviewer({
      id: "fixture-attacker",
      role: "attacker",
      review() {
        return {
          evidence_packet: {
            authenticity_status: "VERIFIED",
            items: [{
              content: "Attacker highlighted a candidate abuse path for rebuttal.",
              source: "attacker",
              type: "review_note",
            }],
            markers: {
              auth_surfaces_attempted: [],
              browser_live_checks: [],
              checked_urls: [],
              runtime_evidence_succeeded: true,
            },
          },
          next_action: "Ask the defender to rebut the candidate abuse path.",
          reason: "Potential abuse path identified for the high-stakes activation.",
          verdict_class: "DEFECT",
        };
      },
    }),
    createAdversarialReviewer({
      id: "fixture-defender",
      role: "defender",
      review(context) {
        if (context.previous_results.length !== 1) {
          throw new Error("defender expected exactly one prior attacker result");
        }

        return {
          evidence_packet: {
            authenticity_status: "VERIFIED",
            items: [{
              content: scenarioMode === "pass"
                ? "Defender rebutted the abuse path with bounded capability evidence."
                : "Defender reduced the abuse path but could not fully close the high-stakes concern.",
              source: "defender",
              type: "review_note",
            }],
            markers: {
              auth_surfaces_attempted: [],
              browser_live_checks: [],
              checked_urls: [],
              runtime_evidence_succeeded: true,
            },
          },
          next_action: "Escalate to the auditor for the final activation decision.",
          reason: scenarioMode === "pass"
            ? "The rebuttal neutralized the attacker concern."
            : "The rebuttal made progress, but residual risk still needs an auditor decision.",
          verdict_class: scenarioMode === "pass" ? "PASS" : "PARTIAL_PROGRESS",
        };
      },
    }),
    createAdversarialReviewer({
      id: "fixture-auditor",
      role: "auditor",
      review(context) {
        if (context.previous_results.length !== 2) {
          throw new Error("auditor expected attacker and defender results first");
        }

        return {
          evidence_packet: {
            authenticity_status: "VERIFIED",
            items: [{
              content: scenarioMode === "pass"
                ? "Auditor accepted the defended package for activation."
                : "Auditor determined the residual risk requires escalation before activation.",
              source: "auditor",
              type: "review_note",
            }],
            markers: {
              auth_surfaces_attempted: [],
              browser_live_checks: [],
              checked_urls: [],
              runtime_evidence_succeeded: true,
            },
          },
          next_action: scenarioMode === "pass"
            ? "Promote the package to ACTIVE."
            : "Keep the package in REVIEW and require explicit operator approval for the unresolved risk.",
          reason: scenarioMode === "pass"
            ? "The final adversarial review accepted the package for activation."
            : "The final adversarial review found residual high-stakes risk that requires escalation.",
          verdict_class: scenarioMode === "pass" ? "PASS" : "NEEDS_ESCALATION",
        };
      },
    }),
  ],
  packageManifest: createPackageManifest({
    activationStatus: "REVIEW",
    capabilities: ["review"],
    compatibility: {
      max_niis_version: null,
      min_niis_version: "0.1.0",
      required_adapters: [],
    },
    id: "pkg-adversarial-execution",
    name: "Adversarial Execution Package",
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
  taskId: scenarioMode === "pass"
    ? "eval-adversarial-review-execution"
    : "eval-adversarial-review-escalation",
});

console.log(JSON.stringify({
  activation_allowed: activation.allowed,
  activation_status: activation.package_manifest.activation_status,
  adversarial_final_verdict: activation.adversarial_review?.final_verdict.verdict_class ?? null,
  adversarial_summary_route: activation.adversarial_review?.summary.route_chosen ?? null,
  blocker_class: activation.blocker?.blocker_class ?? null,
  review_plan_mode: activation.review_plan.mode,
  scenario_mode: scenarioMode,
  review_stage_roles: activation.adversarial_review?.results.map((entry) => entry.reviewer_role) ?? [],
  review_stage_verdicts: activation.adversarial_review?.results.map((entry) => entry.verdict.verdict_class) ?? [],
}, null, 2));
