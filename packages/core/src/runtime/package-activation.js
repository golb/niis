import { createPackageManifest } from "../contracts/packages.js";
import { resolveAdversarialReviewPlan } from "../policy/activation-review.js";
import { createPolicyObservation } from "../policy/observations.js";
import { resolvePolicy } from "../policy/resolved-policy.js";
import { runAdversarialReview } from "./adversarial-review.js";
import { scanSecuritySurfaces } from "../policy/security-scan.js";
import { DEFAULT_THREAT_CATALOG } from "../policy/threat-catalog.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import { parseBlockerArtifact } from "../schemas/blocker.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { parsePackageManifest } from "../schemas/package-manifest.js";
import { evaluatePackageManifestCompatibility } from "./package-compatibility.js";

class PackageActivationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageActivationError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PackageActivationError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureSurfaceArray(value) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new PackageActivationError("securityScanSurfaces must be an array");
  }

  return value;
}

function createPackageManifestSecuritySurface(packageManifest) {
  const manifest = parsePackageManifest(packageManifest);

  return Object.freeze({
    capabilities: manifest.capabilities,
    content: JSON.stringify({
      activation_status: manifest.activation_status,
      id: manifest.id,
      name: manifest.name,
      type: manifest.type,
      version: manifest.version,
    }),
    hooks: [],
    id: `manifest:${manifest.id}`,
    name: manifest.name,
    type: "package_manifest",
  });
}

function createActivationBlocker({ packageManifest, taskId, findingCount, now }) {
  const timestamp = toIsoTimestamp(now, "activation blocker timestamp");

  return parseBlockerArtifact({
    blocker_class: "SECURITY_FINDING",
    created_at: timestamp,
    id: `${taskId}:package-activation:${packageManifest.id}:${Date.parse(timestamp)}`,
    next_action:
      "Keep the package in REVIEW and resolve the named security findings before retrying activation.",
    reason:
      `Package ${packageManifest.id} cannot move REVIEW -> ACTIVE because the activation gate found `
      + `${findingCount} blocking security finding(s).`,
    task_id: taskId,
  });
}

function createCompatibilityBlocker({
  packageManifest,
  compatibilityEvaluation,
  taskId,
  now,
}) {
  const timestamp = toIsoTimestamp(now, "activation compatibility blocker timestamp");

  return parseBlockerArtifact({
    blocker_class: "DEPENDENCY_UNMET",
    created_at: timestamp,
    id: `${taskId}:package-activation:${packageManifest.id}:compatibility:${Date.parse(timestamp)}`,
    next_action:
      "Satisfy the manifest compatibility requirements or downgrade the package compatibility declaration before retrying activation.",
    reason:
      `Package ${packageManifest.id} remains in REVIEW because manifest compatibility checks failed: `
      + `${compatibilityEvaluation.blocked_by.join(", ")}.`,
    task_id: taskId,
  });
}

function createAdversarialReviewBlocker({
  packageManifest,
  reviewPlan,
  taskId,
  now,
}) {
  const timestamp = toIsoTimestamp(now, "activation adversarial-review blocker timestamp");
  const triggerSuffix = reviewPlan.trigger_surface_types.length > 0
    ? ` for high-stakes surface(s): ${reviewPlan.trigger_surface_types.join(", ")}`
    : "";

  return parseBlockerArtifact({
    blocker_class: "MISSING_APPROVAL",
    created_at: timestamp,
    id: `${taskId}:package-activation:${packageManifest.id}:adversarial-review:${Date.parse(timestamp)}`,
    next_action:
      "Run the attacker/defender/auditor adversarial review plan or downgrade the activation review policy before retrying activation.",
    reason:
      `Package ${packageManifest.id} remains in REVIEW because policy-gated adversarial activation review `
      + `is required${triggerSuffix}.`,
    task_id: taskId,
  });
}

function createActivationEvent({
  adversarialReview,
  compatibilityEvaluation,
  packageManifest,
  taskId,
  runId,
  findings,
  allowed,
  reviewPlan,
  now,
}) {
  const timestamp = toIsoTimestamp(now, "activation event timestamp");

  return parseEventLogEntry({
    actor: "activation_gate",
    event_type: allowed ? "STATE_CHANGE" : "POLICY_DECISION",
    id: `${runId}:package-activation:${timestamp}`,
    payload: allowed
      ? {
        entity: "package_manifest",
        finding_count: findings.length,
        from_status: "REVIEW",
        package_id: packageManifest.id,
        adversarial_final_verdict: adversarialReview?.final_verdict?.verdict_class ?? null,
        adversarial_review_executed: Boolean(adversarialReview),
        review_mode: reviewPlan.mode,
        to_status: "ACTIVE",
      }
      : {
        adversarial_final_verdict: adversarialReview?.final_verdict?.verdict_class ?? null,
        adversarial_review_required: reviewPlan.required,
        adversarial_review_executed: Boolean(adversarialReview),
        blocked: true,
        compatibility_blocked: compatibilityEvaluation.compatible === false,
        compatibility_blocked_by: compatibilityEvaluation.blocked_by,
        blocking_finding_count: findings.filter((finding) => finding.blocking).length,
        finding_count: findings.length,
        package_id: packageManifest.id,
        review_mode: reviewPlan.mode,
        review_pattern_id: reviewPlan.pattern_id,
        trigger_surface_types: reviewPlan.trigger_surface_types,
      },
    run_id: runId,
    task_id: taskId,
    timestamp,
  });
}

function createActivationExplainability({
  adversarialReview,
  compatibilityEvaluation,
  packageManifest,
  taskId,
  findings,
  allowed,
  reviewPlan,
  now,
}) {
  const timestamp = toIsoTimestamp(now, "activation explainability timestamp");
  const blockingFindings = findings.filter((finding) => finding.blocking).length;
  const policyRefs = ["policy/security_scan/v1"];

  if (reviewPlan.required) {
    policyRefs.push("policy/activation_review/v1");
  }

  if (compatibilityEvaluation.compatible === false) {
    policyRefs.push("policy/package_compatibility/v1");
  }

  return parseExplainabilityRecord({
    alternatives_considered: allowed
      ? []
      : compatibilityEvaluation.compatible === false
        ? [{
          option: "Activate despite manifest compatibility mismatch",
          reason_rejected:
            "Activation uses declared compatibility checks, so unmet Niis-version or adapter requirements block the package before promotion.",
        }]
      : adversarialReview
        ? [{
          option: "Activate immediately after adversarial review",
          reason_rejected:
            `The final auditor verdict was ${adversarialReview.final_verdict.verdict_class},`
            + " so the package could not be promoted to ACTIVE.",
        }]
        : reviewPlan.required && blockingFindings === 0
        ? [{
          option: "Activate immediately after the baseline security scan",
          reason_rejected: "High-stakes activation was configured to require an attacker/defender/auditor review pass.",
        }]
        : [{
        option: "Leave the package in REVIEW",
        reason_rejected: "Activation was blocked by one or more named security findings.",
      }],
    decision_type: "GATE",
    evidence_refs: [
      ...findings.map((finding) => `${finding.source_surface_type}:${finding.source_surface_id}`),
      ...(adversarialReview ? [adversarialReview.final_verdict.evidence_packet_id] : []),
    ],
    human_readable_summary: allowed
      ? adversarialReview
        ? `Package ${packageManifest.id} passed the activation security gate plus the adversarial attacker/defender/auditor review and can move REVIEW -> ACTIVE.`
        : `Package ${packageManifest.id} passed the activation security gate and can move REVIEW -> ACTIVE.`
      : compatibilityEvaluation.compatible === false
        ? `Package ${packageManifest.id} remains in REVIEW because manifest compatibility requirements are not satisfied by the current runtime.`
      : adversarialReview
        ? `Package ${packageManifest.id} remains in REVIEW because adversarial activation review ended with ${adversarialReview.final_verdict.verdict_class}.`
        : reviewPlan.required && blockingFindings === 0
        ? `Package ${packageManifest.id} remains in REVIEW because policy requires an adversarial attacker/defender/auditor activation review before promotion.`
        : `Package ${packageManifest.id} remains in REVIEW because the activation security gate found blocking security findings.`,
    id: `${taskId}:package-activation:${Date.parse(timestamp)}`,
    policy_refs: policyRefs,
    route_chosen: "package_activation_gate",
    task_id: taskId,
    timestamp,
  });
}

function evaluatePackageActivation({
  adversarialReviewers = [],
  availableAdapters = [],
  currentNiisVersion = null,
  packageManifest,
  policy = {},
  securityScanSurfaces = [],
  taskId = null,
  runId = null,
  threatCatalog = null,
  now = new Date(),
} = {}) {
  const normalizedManifest = parsePackageManifest(packageManifest);

  if (normalizedManifest.activation_status !== "REVIEW") {
    throw new PackageActivationError(
      `package ${normalizedManifest.id} must be in REVIEW before activation; got ${normalizedManifest.activation_status}`,
    );
  }

  const resolvedTaskId = taskId ?? `package-activation:${normalizedManifest.id}`;
  const resolvedRunId = runId ?? `${resolvedTaskId}:run`;
  const resolvedPolicy = resolvePolicy({ runtimeOverrides: policy });
  const resolvedThreatCatalog = threatCatalog ?? resolvedPolicy.threat_catalog ?? DEFAULT_THREAT_CATALOG;
  const activationSurfaces = [
    createPackageManifestSecuritySurface(normalizedManifest),
    ...ensureSurfaceArray(securityScanSurfaces),
  ];
  const scan = scanSecuritySurfaces({
    surfaceType: "activation",
    surfaces: activationSurfaces,
    threatCatalog: resolvedThreatCatalog,
  });
  const blockingFindings = scan.findings.filter((finding) => finding.blocking);
  const compatibilityEvaluation = evaluatePackageManifestCompatibility({
    availableAdapters,
    currentNiisVersion: currentNiisVersion ?? undefined,
    packageManifest: normalizedManifest,
  });
  const reviewPlan = resolveAdversarialReviewPlan({
    policy: resolvedPolicy.activation_review,
    surfaces: activationSurfaces,
  });
  const adversarialReview =
    blockingFindings.length === 0
    && compatibilityEvaluation.compatible
    && reviewPlan.required
    && Array.isArray(adversarialReviewers)
    && adversarialReviewers.length > 0
      ? runAdversarialReview({
        reviewPlan,
        reviewers: adversarialReviewers,
        runId: `${resolvedRunId}:adversarial-review`,
        subject: Object.freeze({
          package_manifest: normalizedManifest,
          security_findings: scan.findings,
          security_scan_surfaces: activationSurfaces,
        }),
        subjectKind: "package_activation",
        taskId: resolvedTaskId,
      })
      : null;
  const allowed = blockingFindings.length === 0
    && compatibilityEvaluation.compatible
    && (reviewPlan.required === false || adversarialReview?.allowed === true);
  const nextManifest = allowed
    ? createPackageManifest({
      activationStatus: "ACTIVE",
      capabilities: normalizedManifest.capabilities,
      compatibility: normalizedManifest.compatibility,
      id: normalizedManifest.id,
      name: normalizedManifest.name,
      runtime: normalizedManifest.runtime,
      schemaVersion: normalizedManifest.schema_version,
      type: normalizedManifest.type,
      version: normalizedManifest.version,
    })
    : normalizedManifest;

  return Object.freeze({
    allowed,
    blocker: allowed
      ? null
      : blockingFindings.length > 0
        ? createActivationBlocker({
          findingCount: blockingFindings.length,
          now,
          packageManifest: normalizedManifest,
          taskId: resolvedTaskId,
        })
        : compatibilityEvaluation.compatible === false
          ? createCompatibilityBlocker({
            compatibilityEvaluation,
            now,
            packageManifest: normalizedManifest,
            taskId: resolvedTaskId,
          })
        : adversarialReview?.blocker
          ?? createAdversarialReviewBlocker({
            now,
            packageManifest: normalizedManifest,
            reviewPlan,
            taskId: resolvedTaskId,
          }),
    event: createActivationEvent({
      adversarialReview,
      allowed,
      compatibilityEvaluation,
      findings: scan.findings,
      now,
      packageManifest: normalizedManifest,
      reviewPlan,
      runId: resolvedRunId,
      taskId: resolvedTaskId,
    }),
    explainability: createActivationExplainability({
      adversarialReview,
      allowed,
      compatibilityEvaluation,
      findings: scan.findings,
      now,
      packageManifest: normalizedManifest,
      reviewPlan,
      taskId: resolvedTaskId,
    }),
    findings: scan.findings,
    observations: Object.freeze([
      ...compatibilityEvaluation.checks.map((check) => createPolicyObservation({
        category: "package_compatibility",
        confidence: check.status === "error" ? 0.9 : 1,
        payload: {
          manifest_id: normalizedManifest.id,
          status: check.status,
        },
        policyRefs: ["policy/package_compatibility/v1"],
        sourceId: `${normalizedManifest.id}:${check.id}`,
        sourceKind: "package_compatibility",
        summary: check.summary,
      })),
      scan.summary,
      ...scan.observations,
    ]),
    compatibility_evaluation: compatibilityEvaluation,
    package_manifest: nextManifest,
    adversarial_review: adversarialReview,
    review_plan: reviewPlan,
  });
}

export {
  PackageActivationError,
  createPackageManifestSecuritySurface,
  evaluatePackageActivation,
};
