import { createValidatorDefinition } from "../core/src/contracts/validator.js";
import { scanSecuritySurfaces } from "../core/src/policy/security-scan.js";

function createSecurityScanValidator() {
  return createValidatorDefinition({
    id: "security_scan",
    description: "Runs the named security-scan threat catalog against doctor/converter/activation-like surfaces.",
    domain: "security.catalog",
    excludedConcerns: ["evidence.authenticity", "review.completion"],
    async validate({ observedOutcome = {}, policy }) {
      const scan = scanSecuritySurfaces({
        surfaceType: observedOutcome.security_surface_type ?? "review",
        surfaces: observedOutcome.security_scan_surfaces ?? [],
        threatCatalog: policy?.threat_catalog,
      });
      const blockingFindings = scan.findings.filter((finding) => finding.blocking);

      if (blockingFindings.length > 0) {
        return {
          blocker_class: "SECURITY_FINDING",
          evidence_packet: null,
          next_action: "Stop review acceptance and escalate the named security findings before activation or completion.",
          observation_signals: [
            scan.summary,
            ...scan.observations,
          ],
          policy_refs: ["policy/security_scan/v1"],
          reason: `Security scan found ${blockingFindings.length} blocking finding(s).`,
          verdict_class: "NEEDS_ESCALATION",
        };
      }

      return {
        evidence_packet: null,
        next_action: "Continue through the validator lane; the current security scan produced no blocking findings.",
        observation_signals: [
          scan.summary,
          ...scan.observations,
        ],
        policy_refs: ["policy/security_scan/v1"],
        reason:
          scan.findings.length === 0
            ? "Security scan found no issues for the supplied surfaces."
            : "Security scan found warnings only; no blocking findings were raised.",
        verdict_class: "EVIDENCE_GAP",
      };
    },
  });
}

export {
  createSecurityScanValidator,
};
