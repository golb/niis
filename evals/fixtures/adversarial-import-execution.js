import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAdversarialReviewer } from "../../packages/core/src/runtime/adversarial-review.js";
import { importExternalPack } from "../../packages/core/src/runtime/package-import.js";

const scenarioMode = process.argv[2] ?? "approve";

if (!["approve", "escalate"].includes(scenarioMode)) {
  throw new Error(`unsupported adversarial import mode: ${scenarioMode}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-adversarial-import-"));
const sourcePath = path.join(
  tempRoot,
  scenarioMode === "approve" ? "approved-import-pack.txt" : "escalated-import-pack.txt",
);

try {
  fs.writeFileSync(sourcePath, "Reviewable content only.\n");

  const imported = importExternalPack({
    adversarialReviewers: [
      createAdversarialReviewer({
        id: "fixture-import-attacker",
        role: "attacker",
        review() {
          return {
            evidence_packet: {
              authenticity_status: "VERIFIED",
              items: [{
                content: "Attacker identified an import-side route that still needs rebuttal.",
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
            next_action: "Require a defender rebuttal for the candidate import risk.",
            reason: "Adversarial import review identified a candidate risk worth challenging.",
            verdict_class: "DEFECT",
          };
        },
      }),
      createAdversarialReviewer({
        id: "fixture-import-defender",
        role: "defender",
        review(context) {
          if (context.previous_results.length !== 1) {
            throw new Error("defender expected exactly one prior attacker result");
          }

          return {
            evidence_packet: {
              authenticity_status: "VERIFIED",
              items: [{
                content: scenarioMode === "approve"
                  ? "Defender showed the imported package keeps the risky path out of scope."
                  : "Defender reduced the import-side risk but could not close it completely.",
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
            next_action: "Escalate to the auditor for the final import decision.",
            reason: scenarioMode === "approve"
              ? "The rebuttal resolved the attacker concern for the import candidate."
              : "The rebuttal made progress, but unresolved import risk remains.",
            verdict_class: scenarioMode === "approve" ? "PASS" : "PARTIAL_PROGRESS",
          };
        },
      }),
      createAdversarialReviewer({
        id: "fixture-import-auditor",
        role: "auditor",
        review(context) {
          if (context.previous_results.length !== 2) {
            throw new Error("auditor expected attacker and defender results first");
          }

          return {
            evidence_packet: {
              authenticity_status: "VERIFIED",
              items: [{
                content: scenarioMode === "approve"
                  ? "Auditor approved the conversion report for explicit activation review."
                  : "Auditor requires explicit approval before import activation can proceed.",
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
            next_action: scenarioMode === "approve"
              ? "Mark the conversion report approved and keep explicit activation as a separate step."
              : "Keep the conversion report pending and escalate the residual import risk.",
            reason: scenarioMode === "approve"
              ? "The final adversarial import review approved the conversion report."
              : "Residual import risk still requires escalation before approval.",
            verdict_class: scenarioMode === "approve" ? "PASS" : "NEEDS_ESCALATION",
          };
        },
      }),
    ],
    policy: {
      activation_review: {
        mode: "auto",
      },
    },
    sourcePack: {
      capabilities: ["review"],
      format: "generic_external_pack",
      origin: "external",
      path: sourcePath,
      version: "0.1.0",
    },
    taskId: scenarioMode === "approve"
      ? "eval-adversarial-import-execution"
      : "eval-adversarial-import-escalation",
  });

  console.log(JSON.stringify({
    adversarial_final_verdict: imported.adversarial_review?.final_verdict.verdict_class ?? null,
    adversarial_summary_route: imported.adversarial_review?.summary.route_chosen ?? null,
    blocker_class: imported.blocker?.blocker_class ?? null,
    conversion_review_status: imported.conversion_report.review_status,
    conversion_status: imported.conversion_report.conversion_status,
    package_activation_status: imported.package_manifest.activation_status,
    review_plan_mode: imported.review_plan.mode,
    review_stage_roles: imported.adversarial_review?.results.map((entry) => entry.reviewer_role) ?? [],
    review_stage_verdicts: imported.adversarial_review?.results.map((entry) => entry.verdict.verdict_class) ?? [],
    scenario_mode: scenarioMode,
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, { force: true, recursive: true });
}
