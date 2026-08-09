import fs from "node:fs";
import path from "node:path";

import {
  createConversionReport,
  createPackageManifest,
} from "../contracts/packages.js";
import { resolveAdversarialReviewPlan } from "../policy/activation-review.js";
import { resolvePolicy } from "../policy/resolved-policy.js";
import { runAdversarialReview } from "./adversarial-review.js";
import { scanSecuritySurfaces } from "../policy/security-scan.js";
import { DEFAULT_THREAT_CATALOG } from "../policy/threat-catalog.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import { parseBlockerArtifact } from "../schemas/blocker.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { parsePackageManifest } from "../schemas/package-manifest.js";

class PackageImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageImportError";
  }
}

const DIRECT_PACKAGE_TYPES = new Set([
  "role",
  "agent",
  "adapter",
  "validator",
  "plugin",
  "skill",
  "prompt",
  "workflow",
  "policy_pack",
  "converter",
]);

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PackageImportError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageImportError(`${label} must be a plain object`);
  }

  return value;
}

function ensureStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new PackageImportError(`${label} must be an array`);
  }

  return values
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "imported-pack";
}

function mapForeignTypeToPackageType(foreignType) {
  const normalizedType = typeof foreignType === "string" ? foreignType.trim().toLowerCase() : "";

  if (DIRECT_PACKAGE_TYPES.has(normalizedType)) {
    return normalizedType;
  }

  switch (normalizedType) {
    case "rule":
    case "instruction":
    case "instructions":
    case "claude_md":
    case "cursor_rule":
    case "codex_task":
      return "skill";
    case "plugin":
      return "plugin";
    default:
      return "skill";
  }
}

function derivePackageId(sourcePack, packageType) {
  if (typeof sourcePack.target_package_id === "string" && sourcePack.target_package_id.trim() !== "") {
    return sourcePack.target_package_id.trim();
  }

  if (typeof sourcePack.targetPackageId === "string" && sourcePack.targetPackageId.trim() !== "") {
    return sourcePack.targetPackageId.trim();
  }

  if (typeof sourcePack.package_id === "string" && sourcePack.package_id.trim() !== "") {
    return sourcePack.package_id.trim();
  }

  if (typeof sourcePack.packageId === "string" && sourcePack.packageId.trim() !== "") {
    return sourcePack.packageId.trim();
  }

  const origin = ensureNonEmptyString(sourcePack.origin, "sourcePack.origin");
  const baseName = path.basename(ensureNonEmptyString(sourcePack.path, "sourcePack.path"));

  return `imported-${packageType}-${slugify(origin)}-${slugify(baseName)}`;
}

function derivePackageName(sourcePack, packageId) {
  return sourcePack.display_name
    ?? sourcePack.displayName
    ?? sourcePack.name
    ?? packageId;
}

function derivePackageVersion(sourcePack) {
  return sourcePack.version ?? "0.0.0";
}

function deriveConversionWarnings(sourcePack, packageType) {
  const warnings = new Set(ensureStringArray(sourcePack.warnings ?? [], "sourcePack.warnings"));
  const foreignType = typeof sourcePack.foreign_type === "string"
    ? sourcePack.foreign_type
    : sourcePack.foreignType;

  if (typeof foreignType === "string" && foreignType.trim() !== "" && foreignType.trim().toLowerCase() !== packageType) {
    warnings.add(`foreign type ${foreignType} was mapped into Niis package type ${packageType}`);
  }

  if (!sourcePack.package_manifest && !sourcePack.packageManifest) {
    warnings.add("converter synthesized a reviewable Niis package manifest from foreign-pack metadata");
  }

  return [...warnings];
}

function resolveImportedContent(sourcePack) {
  if (typeof sourcePack.content === "string") {
    return sourcePack.content;
  }

  const sourcePath = ensureNonEmptyString(sourcePack.path, "sourcePack.path");

  if (!fs.existsSync(sourcePath)) {
    return JSON.stringify({
      origin: sourcePack.origin,
      format: sourcePack.format,
      path: sourcePath,
    });
  }

  const stats = fs.statSync(sourcePath);

  if (stats.isFile()) {
    return fs.readFileSync(sourcePath, "utf8");
  }

  if (stats.isDirectory()) {
    return JSON.stringify({
      directory_entries: fs.readdirSync(sourcePath).sort(),
      path: sourcePath,
    });
  }

  return JSON.stringify({
    format: sourcePack.format,
    path: sourcePath,
  });
}

function normalizeReviewManifest(sourcePack) {
  const suppliedManifest = sourcePack.package_manifest ?? sourcePack.packageManifest ?? null;

  if (suppliedManifest) {
    const manifest = parsePackageManifest(suppliedManifest);

    return createPackageManifest({
      activationStatus: "REVIEW",
      capabilities: manifest.capabilities,
      compatibility: manifest.compatibility,
      id: manifest.id,
      name: manifest.name,
      schemaVersion: manifest.schema_version,
      type: manifest.type,
      version: manifest.version,
    });
  }

  const packageType = mapForeignTypeToPackageType(sourcePack.foreign_type ?? sourcePack.foreignType ?? null);
  const packageId = derivePackageId(sourcePack, packageType);

  return createPackageManifest({
    activationStatus: "REVIEW",
    capabilities: ensureStringArray(sourcePack.capabilities ?? [], "sourcePack.capabilities"),
    compatibility: sourcePack.compatibility ?? {
      min_niis_version: "0.1.0",
      max_niis_version: null,
      required_adapters: [],
    },
    id: packageId,
    name: derivePackageName(sourcePack, packageId),
    type: packageType,
    version: derivePackageVersion(sourcePack),
  });
}

function createConverterSecuritySurface(sourcePack, packageManifest, content) {
  return Object.freeze({
    capabilities: packageManifest.capabilities,
    content,
    hooks: ensureStringArray(sourcePack.hooks ?? [], "sourcePack.hooks"),
    id: `source-pack:${sourcePack.origin}:${sourcePack.path}`,
    similar_to: sourcePack.similar_to ?? sourcePack.similarTo ?? null,
    typosquatting_candidate: Boolean(
      sourcePack.typosquatting_candidate ?? sourcePack.typosquattingCandidate ?? false,
    ),
    type: "conversion_candidate",
  });
}

function createImportBlocker({ taskId, targetPackageId, findingCount, now }) {
  const timestamp = toIsoTimestamp(now, "import blocker timestamp");

  return parseBlockerArtifact({
    blocker_class: "SECURITY_FINDING",
    created_at: timestamp,
    id: `${taskId}:package-import:${targetPackageId}:${Date.parse(timestamp)}`,
    next_action:
      "Keep the converted package in REVIEW and resolve the named converter security findings before activation.",
    reason:
      `Imported pack for ${targetPackageId} produced ${findingCount} blocking security finding(s) during conversion review.`,
    task_id: taskId,
  });
}

function createAdversarialImportBlocker({
  taskId,
  targetPackageId,
  reviewPlan,
  now,
}) {
  const timestamp = toIsoTimestamp(now, "import adversarial-review blocker timestamp");
  const triggerSuffix = reviewPlan.trigger_surface_types.length > 0
    ? ` for high-stakes surface(s): ${reviewPlan.trigger_surface_types.join(", ")}`
    : "";

  return parseBlockerArtifact({
    blocker_class: "MISSING_APPROVAL",
    created_at: timestamp,
    id: `${taskId}:package-import:${targetPackageId}:adversarial-review:${Date.parse(timestamp)}`,
    next_action:
      "Run the attacker/defender/auditor adversarial import review or downgrade the activation review policy before promotion.",
    reason:
      `Imported pack for ${targetPackageId} remains review-only because policy-gated adversarial import `
      + `review is required${triggerSuffix}.`,
    task_id: taskId,
  });
}

function createImportEvent({
  adversarialReview,
  taskId,
  runId,
  targetPackageId,
  blockingFindings,
  conversionStatus,
  reviewPlan,
  now,
}) {
  const timestamp = toIsoTimestamp(now, "import event timestamp");

  return parseEventLogEntry({
    actor: "converter",
    event_type: blockingFindings > 0 ? "POLICY_DECISION" : "CHECKPOINT",
    id: `${runId}:package-import:${timestamp}`,
    payload: {
      adversarial_final_verdict: adversarialReview?.final_verdict?.verdict_class ?? null,
      adversarial_review_required: reviewPlan.required,
      adversarial_review_executed: Boolean(adversarialReview),
      blocking_finding_count: blockingFindings,
      conversion_status: conversionStatus,
      review_mode: reviewPlan.mode,
      review_pattern_id: reviewPlan.pattern_id,
      stage: "import_conversion",
      target_package_id: targetPackageId,
      trigger_surface_types: reviewPlan.trigger_surface_types,
    },
    run_id: runId,
    task_id: taskId,
    timestamp,
  });
}

function createImportExplainability({
  adversarialReview,
  taskId,
  targetPackageId,
  findings,
  conversionStatus,
  reviewPlan,
  now,
}) {
  const timestamp = toIsoTimestamp(now, "import explainability timestamp");
  const blockingFindings = findings.filter((finding) => finding.blocking).length;
  const policyRefs = ["policy/security_scan/v1"];

  if (reviewPlan.required) {
    policyRefs.push("policy/activation_review/v1");
  }

  return parseExplainabilityRecord({
    alternatives_considered: blockingFindings > 0
      ? [{
        option: "Auto-activate the converted package immediately",
        reason_rejected: "Converted packages must remain reviewable and blocking findings prevent auto-promotion.",
      }]
      : adversarialReview && !adversarialReview.allowed
        ? [{
          option: "Approve the converted package for activation",
          reason_rejected:
            `The final auditor verdict was ${adversarialReview.final_verdict.verdict_class},`
            + " so the converted package stayed review-only.",
        }]
      : reviewPlan.required
        ? [{
          option: "Promote the converted package using only the baseline converter scan",
          reason_rejected: "High-stakes import review was configured to require an attacker/defender/auditor pass before promotion.",
        }]
      : [],
    decision_type: "GATE",
    evidence_refs: [
      ...findings.map((finding) => `${finding.rule_id}:${finding.source_surface_id ?? "source-pack"}`),
      ...(adversarialReview ? [adversarialReview.final_verdict.evidence_packet_id] : []),
    ],
    human_readable_summary:
      blockingFindings > 0
        ? `Imported pack for ${targetPackageId} remains review-only because the converter found blocking security findings.`
        : adversarialReview?.allowed
          ? `Imported pack for ${targetPackageId} converted successfully and passed adversarial attacker/defender/auditor review, so the conversion report is now approved for explicit activation.`
        : adversarialReview
          ? `Imported pack for ${targetPackageId} remains review-only because adversarial import review ended with ${adversarialReview.final_verdict.verdict_class}.`
        : reviewPlan.required
          ? `Imported pack for ${targetPackageId} converted successfully, but promotion now requires an adversarial attacker/defender/auditor review.`
          : `Imported pack for ${targetPackageId} converted successfully into a reviewable Niis package.`,
    id: `${taskId}:package-import:${Date.parse(timestamp)}`,
    policy_refs: policyRefs,
    route_chosen: "converter_import_path",
    task_id: taskId,
    timestamp,
  });
}

function importExternalPack({
  adversarialReviewers = [],
  sourcePack,
  policy = {},
  taskId = null,
  runId = null,
  threatCatalog = null,
  now = new Date(),
} = {}) {
  const normalizedSourcePack = ensurePlainObject(sourcePack, "sourcePack");
  normalizedSourcePack.origin = ensureNonEmptyString(normalizedSourcePack.origin, "sourcePack.origin");
  normalizedSourcePack.format = ensureNonEmptyString(normalizedSourcePack.format, "sourcePack.format");
  normalizedSourcePack.path = ensureNonEmptyString(normalizedSourcePack.path, "sourcePack.path");

  const resolvedPolicy = resolvePolicy({ runtimeOverrides: policy });
  const resolvedThreatCatalog = threatCatalog ?? resolvedPolicy.threat_catalog ?? DEFAULT_THREAT_CATALOG;
  const packageManifest = normalizeReviewManifest(normalizedSourcePack);
  const content = resolveImportedContent(normalizedSourcePack);
  const converterSurface = createConverterSecuritySurface(
    normalizedSourcePack,
    packageManifest,
    content,
  );
  const scan = scanSecuritySurfaces({
    surfaceType: "converter",
    surfaces: [converterSurface],
    threatCatalog: resolvedThreatCatalog,
  });
  const blockingFindings = scan.findings.filter((finding) => finding.blocking);
  const reviewPlan = resolveAdversarialReviewPlan({
    policy: resolvedPolicy.activation_review,
    surfaces: [converterSurface],
  });
  const resolvedTaskId = taskId ?? `package-import:${packageManifest.id}`;
  const resolvedRunId = runId ?? `${resolvedTaskId}:run`;
  const adversarialReview =
    blockingFindings.length === 0
    && reviewPlan.required
    && Array.isArray(adversarialReviewers)
    && adversarialReviewers.length > 0
      ? runAdversarialReview({
        reviewPlan,
        reviewers: adversarialReviewers,
        runId: `${resolvedRunId}:adversarial-review`,
        subject: Object.freeze({
          conversion_candidate: normalizedSourcePack,
          package_manifest: packageManifest,
          security_findings: scan.findings,
          security_scan_surface: converterSurface,
        }),
        subjectKind: "package_import",
        taskId: resolvedTaskId,
      })
      : null;
  const warnings = new Set(deriveConversionWarnings(normalizedSourcePack, packageManifest.type));

  if (reviewPlan.required) {
    warnings.add(
      "policy-gated adversarial attacker/defender/auditor review is required before activation",
    );
  }
  const incompatibilities = ensureStringArray(
    normalizedSourcePack.incompatibilities ?? [],
    "sourcePack.incompatibilities",
  );
  const conversionStatus =
    incompatibilities.length > 0 || blockingFindings.length > 0
      ? "PARTIAL"
      : "SUCCESS";
  const conversionReport = createConversionReport({
    conversionStatus,
    convertedAt: now,
    id: `${packageManifest.id}:conversion-report`,
    incompatibilities,
    reviewStatus: adversarialReview?.allowed ? "APPROVED" : "PENDING",
    securityFindings: scan.findings,
    sourcePack: normalizedSourcePack,
    targetPackageId: packageManifest.id,
    warnings: [...warnings],
  });

  return Object.freeze({
    activation_input: {
      candidate_kind: normalizedSourcePack.candidate_kind ?? normalizedSourcePack.candidateKind ?? "package",
      package_manifest: packageManifest,
      security_scan_surfaces: [converterSurface],
      source_kind: "converted_external",
      source_ref: normalizedSourcePack.path,
    },
    blocker: blockingFindings.length > 0
      ? createImportBlocker({
        findingCount: blockingFindings.length,
        now,
        targetPackageId: packageManifest.id,
        taskId: resolvedTaskId,
      })
      : adversarialReview?.blocker
        ?? (reviewPlan.required && !adversarialReview?.allowed
          ? createAdversarialImportBlocker({
            now,
            reviewPlan,
            targetPackageId: packageManifest.id,
            taskId: resolvedTaskId,
          })
          : null),
    conversion_report: conversionReport,
    event: createImportEvent({
      adversarialReview,
      blockingFindings: blockingFindings.length,
      conversionStatus,
      now,
      reviewPlan,
      runId: resolvedRunId,
      targetPackageId: packageManifest.id,
      taskId: resolvedTaskId,
    }),
    explainability: createImportExplainability({
      adversarialReview,
      conversionStatus,
      findings: scan.findings,
      now,
      reviewPlan,
      targetPackageId: packageManifest.id,
      taskId: resolvedTaskId,
    }),
    observations: Object.freeze([
      scan.summary,
      ...scan.observations,
    ]),
    adversarial_review: adversarialReview,
    package_manifest: packageManifest,
    review_plan: reviewPlan,
  });
}

export {
  PackageImportError,
  importExternalPack,
};
