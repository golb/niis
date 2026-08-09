import { createPolicyObservation, normalizeObservationSignals } from "./observations.js";
import { DEFAULT_REDACTION_POLICY } from "./redaction.js";
import { createThreatCatalog, indexThreatCatalog } from "./threat-catalog.js";

class SecurityScanError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecurityScanError";
  }
}

const PLAINTEXT_SECRET_PATTERN =
  /\b(?:[A-Z0-9]+_)*(api[_-]?key|secret|token|password|authorization)\b\s*[:=]\s*["']?([^\s"',}]+)/i;
const PROMPT_INJECTION_PATTERN =
  /\b(ignore\s+previous\s+instructions|override\s+the\s+system\s+prompt|developer\s+message)\b/i;
const MALICIOUS_HOOK_PATTERN = /\b(rm\s+-rf|curl\s+[^|]+\|\s*sh|wget\s+[^|]+\|\s*sh)\b/i;

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SecurityScanError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureArray(value, label) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new SecurityScanError(`${label} must be an array`);
  }

  return value;
}

function normalizeSurface(surface, index) {
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
    throw new SecurityScanError(`surface[${index}] must be a plain object`);
  }

  return Object.freeze({
    capabilities: ensureArray(surface.capabilities ?? surface.permissions ?? [], `surface[${index}].capabilities`)
      .map((value, innerIndex) => ensureNonEmptyString(value, `surface[${index}].capabilities[${innerIndex}]`)),
    content: typeof surface.content === "string" ? surface.content : "",
    hooks: ensureArray(surface.hooks ?? [], `surface[${index}].hooks`)
      .map((value, innerIndex) => ensureNonEmptyString(value, `surface[${index}].hooks[${innerIndex}]`)),
    id: ensureNonEmptyString(surface.id ?? `surface-${index + 1}`, `surface[${index}].id`),
    name: typeof surface.name === "string" ? surface.name : "",
    similar_to:
      surface.similar_to === undefined || surface.similar_to === null
        ? null
        : ensureNonEmptyString(surface.similar_to, `surface[${index}].similar_to`),
    typosquatting_candidate: Boolean(surface.typosquatting_candidate ?? false),
    type: ensureNonEmptyString(surface.type ?? "generic_surface", `surface[${index}].type`),
  });
}

function createSecurityFinding({
  catalogIndex,
  ruleId,
  surface,
  surfaceType,
  summarySuffix,
}) {
  const rule = catalogIndex.get(ruleId);

  if (!rule) {
    throw new SecurityScanError(`unknown threat catalog rule: ${ruleId}`);
  }

  return Object.freeze({
    auto_fixable: rule.auto_fixable,
    blocking: rule.blocking,
    category: rule.category,
    remediation_hint: rule.remediation_hint,
    rule_id: rule.rule_id,
    severity: rule.severity,
    source_surface_id: surface.id,
    source_surface_type: surfaceType,
    summary: `${rule.summary}${summarySuffix ? ` ${summarySuffix}` : ""}`,
  });
}

function scanSurface(surface, { catalogIndex, surfaceType }) {
  const findings = [];

  if (surface.content && PLAINTEXT_SECRET_PATTERN.test(surface.content)) {
    findings.push(createSecurityFinding({
      catalogIndex,
      ruleId: "security/plaintext-secret-persistence",
      surface,
      surfaceType,
      summarySuffix: `Surface ${surface.id} contains a plaintext secret-like assignment.`,
    }));
  }

  if (surface.content && PROMPT_INJECTION_PATTERN.test(surface.content)) {
    findings.push(createSecurityFinding({
      catalogIndex,
      ruleId: "security/prompt-injection-carrier",
      surface,
      surfaceType,
      summarySuffix: `Surface ${surface.id} contains prompt-injection-like instructions.`,
    }));
  }

  if (
    surface.capabilities.includes("danger.full_access")
    || surface.capabilities.includes("workspace.write")
    || surface.capabilities.includes("network.access")
  ) {
    findings.push(createSecurityFinding({
      catalogIndex,
      ruleId: "security/overprivileged-integration",
      surface,
      surfaceType,
      summarySuffix: `Surface ${surface.id} declares privileged capabilities: ${surface.capabilities.join(", ")}.`,
    }));
  }

  if (surface.typosquatting_candidate || surface.similar_to) {
    findings.push(createSecurityFinding({
      catalogIndex,
      ruleId: "security/typosquatting-candidate",
      surface,
      surfaceType,
      summarySuffix: surface.similar_to
        ? `Surface ${surface.id} resembles ${surface.similar_to}.`
        : `Surface ${surface.id} is marked as a typosquatting candidate.`,
    }));
  }

  if (surface.hooks.some((hook) => MALICIOUS_HOOK_PATTERN.test(hook))) {
    findings.push(createSecurityFinding({
      catalogIndex,
      ruleId: "security/malicious-hook-surface",
      surface,
      surfaceType,
      summarySuffix: `Surface ${surface.id} declares a suspicious lifecycle hook.`,
    }));
  }

  return findings;
}

function scanSecuritySurfaces({
  redactionPolicy = DEFAULT_REDACTION_POLICY,
  surfaceType = "doctor",
  surfaces = [],
  threatCatalog,
} = {}) {
  const normalizedThreatCatalog = createThreatCatalog(threatCatalog);
  const catalogIndex = indexThreatCatalog(normalizedThreatCatalog);
  const normalizedSurfaces = ensureArray(surfaces, "surfaces")
    .map((surface, index) => normalizeSurface(surface, index));
  const findings = normalizedSurfaces.flatMap((surface) =>
    scanSurface(surface, {
      catalogIndex,
      surfaceType: ensureNonEmptyString(surfaceType, "surfaceType"),
    }));
  const observations = normalizeObservationSignals({
    defaultPolicyRefs: ["policy/security_scan/v1"],
    redactionPolicy,
    signals: findings.map((finding) => ({
      category: "security_scan",
      confidence: finding.blocking ? 1 : 0.7,
      payload: finding,
      sourceId: `${finding.source_surface_type}:${finding.source_surface_id}:${finding.rule_id}`,
      sourceKind: "security_scan_finding",
      summary: `${finding.severity}:${finding.rule_id}`,
    })),
    sourceId: `${surfaceType}:scan`,
    sourceKind: "security_scan",
  });

  return Object.freeze({
    findings: Object.freeze(findings),
    observations,
    summary: createPolicyObservation({
      category: "security_scan_summary",
      confidence: findings.length === 0 ? 1 : 0.8,
      payload: {
        blocking_findings: findings.filter((finding) => finding.blocking).length,
        finding_count: findings.length,
        surface_type: surfaceType,
      },
      policyRefs: ["policy/security_scan/v1"],
      redactionPolicy,
      sourceId: `${surfaceType}:summary`,
      sourceKind: "security_scan_summary",
      summary:
        findings.length === 0
          ? `security scan for ${surfaceType} found no issues`
          : `security scan for ${surfaceType} found ${findings.length} issue(s)`,
    }),
  });
}

export {
  SecurityScanError,
  scanSecuritySurfaces,
};
