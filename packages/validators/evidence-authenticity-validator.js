import { createValidatorDefinition } from "../core/src/contracts/validator.js";

const PLACEHOLDER_PATTERNS = [
  /\[truncated\]/i,
  /\.\.\.\s*truncated/i,
  /\bTODO\b/i,
  /placeholder/i,
  /same as above/i,
  /omitted for brevity/i,
];

function dedupeStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim() !== ""))];
}

function createEvidenceAuthenticityValidator() {
  return createValidatorDefinition({
    id: "evidence_authenticity",
    description: "Checks that evidence is backed by concrete runtime artifacts rather than placeholders.",
    domain: "evidence.authenticity",
    excludedConcerns: ["review.completion", "security.catalog"],
    async validate({ evidencePacket, evidenceRuntime = {}, runRecord }) {
      const evidenceItems = evidencePacket?.items ?? [];

      if (evidenceItems.length === 0) {
        return {
          evidence_packet: {
            authenticity_status: "UNVERIFIED",
            items: [],
            markers: evidencePacket?.markers ?? {},
          },
          next_action: "Collect raw command/runtime evidence before terminal review.",
          policy_refs: ["policy/evidence_authenticity/v1"],
          reason: "No evidence items were provided to the authenticity validator.",
          verdict_class: "EVIDENCE_GAP",
        };
      }

      const suspiciousItem = evidenceItems.find((item) =>
        PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(item.content))
        || (item.source === "handwritten_claim" && !item.raw_output_ref));

      if (suspiciousItem) {
        return {
          blocker_class: "MISSING_EVIDENCE",
          evidence_packet: {
            authenticity_status: "SUSPICIOUS",
            items: evidenceItems,
            markers: evidencePacket?.markers ?? {},
          },
          next_action: "Replace placeholder or handwritten claims with raw runtime-backed evidence.",
          observation_signals: [
            {
              category: "evidence_authenticity",
              confidence: 1,
              summary: `Suspicious evidence item detected from ${suspiciousItem.source}.`,
            },
          ],
          policy_refs: ["policy/evidence_authenticity/v1"],
          reason: "Evidence contains placeholders, truncation markers, or handwritten claims without raw backing.",
          verdict_class: "DEFECT",
        };
      }

      const refBackedItems = evidenceItems.filter((item) => item.raw_output_ref);
      const verifiedRefBackedItems = [];
      const brokenRefBackedItems = [];
      const runLogRef = runRecord?.run_log?.ref ?? null;

      for (const item of refBackedItems) {
        const expectedSha256 = item.raw_output_ref === runLogRef
          ? runRecord?.run_log?.sha256 ?? null
          : null;

        if (typeof evidenceRuntime.verifyRawOutputRef === "function") {
          const verification = await evidenceRuntime.verifyRawOutputRef({
            evidenceItem: item,
            expectedSha256,
            rawOutputRef: item.raw_output_ref,
            runRecord,
          });

          if (verification?.ok) {
            verifiedRefBackedItems.push(item);
          } else {
            brokenRefBackedItems.push({
              item,
              verification,
            });
          }
          continue;
        }

        if (runLogRef && item.raw_output_ref === runLogRef) {
          verifiedRefBackedItems.push(item);
        }
      }

      if (brokenRefBackedItems.length > 0) {
        return {
          blocker_class: "MISSING_EVIDENCE",
          evidence_packet: {
            authenticity_status: "SUSPICIOUS",
            items: evidenceItems,
            markers: {
              ...(evidencePacket?.markers ?? {}),
              auth_surfaces_attempted: dedupeStrings([
                ...(evidencePacket?.markers?.auth_surfaces_attempted ?? []),
                "run_log_ref_verification",
              ]),
            },
          },
          next_action: "Repair or restore the referenced run-log artifact before trusting this evidence packet.",
          observation_signals: [
            {
              category: "evidence_authenticity",
              confidence: 1,
              summary: `Run-log artifact verification failed for ${brokenRefBackedItems[0].item.raw_output_ref}.`,
            },
          ],
          policy_refs: ["policy/evidence_authenticity/v1"],
          reason: "Evidence references a run-log artifact that is missing or fails integrity verification.",
          verdict_class: "DEFECT",
        };
      }

      const authenticityStatus = verifiedRefBackedItems.length > 0
        ? "VERIFIED"
        : "UNVERIFIED";

      return {
        evidence_packet: {
          authenticity_status: authenticityStatus,
          items: evidenceItems,
          markers: {
            ...(evidencePacket?.markers ?? {}),
            auth_surfaces_attempted: dedupeStrings([
              ...(evidencePacket?.markers?.auth_surfaces_attempted ?? []),
              refBackedItems.length > 0 ? "run_log_ref_verification" : "",
            ]),
            runtime_evidence_succeeded:
              Boolean(evidencePacket?.markers?.runtime_evidence_succeeded)
              || verifiedRefBackedItems.length > 0,
          },
        },
        next_action: "Continue to the completion validator to decide whether the evidence proves task completion.",
        observation_signals: [
          {
            category: "evidence_authenticity",
            confidence: authenticityStatus === "VERIFIED" ? 1 : 0.6,
            summary: authenticityStatus === "VERIFIED"
              ? `Evidence authenticity classified as VERIFIED through ${verifiedRefBackedItems.length} run-log ref(s).`
              : "Evidence authenticity remains UNVERIFIED because no persisted raw runtime artifact was validated.",
          },
        ],
        policy_refs: ["policy/evidence_authenticity/v1"],
        reason: authenticityStatus === "VERIFIED"
          ? "Evidence is authentic enough to continue through the validator lane."
          : "Evidence items exist, but no persisted raw runtime artifact was verified yet.",
        verdict_class: "EVIDENCE_GAP",
      };
    },
  });
}

export {
  createEvidenceAuthenticityValidator,
};
