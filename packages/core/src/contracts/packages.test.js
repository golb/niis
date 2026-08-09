import test from "node:test";
import assert from "node:assert/strict";

import {
  createConversionReport,
  createDiscoveryReport,
  PACKAGE_MANIFEST_SCHEMA_VERSION,
  createInstallState,
  createPackageManifest,
  createReleaseBundle,
  createUpgradePlan,
} from "./packages.js";

test("createPackageManifest supports prompt packages with canonical defaults", () => {
  const manifest = createPackageManifest({
    id: "pkg-prompt-review",
    name: "Review Prompt Pack",
    type: "prompt",
    version: "0.1.0",
  });

  assert.equal(manifest.type, "prompt");
  assert.equal(manifest.activation_status, "INACTIVE");
  assert.equal(manifest.schema_version, PACKAGE_MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.compatibility.min_niis_version, "0.1.0");
});

test("createPackageManifest supports plugin packages as a first-class manifest type", () => {
  const manifest = createPackageManifest({
    id: "pkg-observability-plugin",
    name: "Observability Plugin",
    type: "plugin",
    version: "0.1.0",
  });

  assert.equal(manifest.type, "plugin");
  assert.equal(manifest.activation_status, "INACTIVE");
});

test("createReleaseBundle and createUpgradePlan return normalized packaging artifacts", () => {
  const bundle = createReleaseBundle({
    bundleId: "bundle-core-0.1.0",
    fileRefs: ["dist/core.tgz"],
    migrationRefs: ["migrations/0001.sql"],
    packageId: "@niis/core",
    version: "0.1.0",
  });
  const upgradePlan = createUpgradePlan({
    blockedBy: [],
    checks: ["schema-compatible"],
    fromVersion: "0.1.0",
    migrationRefs: ["migrations/0002.sql"],
    packageId: "@niis/core",
    planId: "upgrade-core-0.2.0",
    toVersion: "0.2.0",
  });

  assert.equal(bundle.channel, "stable");
  assert.deepEqual(bundle.file_refs, ["dist/core.tgz"]);
  assert.equal(upgradePlan.compatibility_status, "compatible");
  assert.deepEqual(upgradePlan.checks, ["schema-compatible"]);
});

test("createInstallState accepts persisted snake_case artifact shapes", () => {
  const installState = createInstallState({
    commands: ["init"],
    database_path: "/tmp/state.sqlite",
    entries: [{
      display_name: "CLI command surface",
      files: [{
        path: "packages/cli/bin/niis.js",
        required: true,
        sha256: "abc123",
      }],
      id: "cli-command-surface",
      metadata: {},
      operations: ["bootstrap_command_surface"],
      package_id: "@niis/cli",
      recorded_at: "2026-04-02T08:10:00.000Z",
      source_kind: "builtin",
      source_ref: "packages/cli/bin/niis.js",
      target_kind: "command_surface",
      version: "0.1.0",
    }],
    installed_at: "2026-04-02T08:10:00.000Z",
    package_root: "/tmp/niis",
    schema_version: 1,
    state_root: "/tmp/niis/.niis",
    status: "BOOTSTRAPPED",
  });

  assert.equal(installState.package_root, "/tmp/niis");
  assert.equal(installState.entries[0].display_name, "CLI command surface");
  assert.equal(installState.entries[0].source_kind, "builtin");
});

test("createDiscoveryReport returns reviewable deduped candidate artifacts", () => {
  const report = createDiscoveryReport({
    reportId: "discovery-report-1",
    sourceKinds: ["local_filesystem", "registry"],
    candidates: [{
      candidateId: "candidate-skill-local",
      candidateKind: "package",
      dedupKey: "package:pkg-review-skill",
      displayName: "Review Skill",
      packageId: "pkg-review-skill",
      packageManifest: {
        id: "pkg-review-skill",
        name: "Review Skill",
        version: "0.1.0",
        type: "skill",
        capabilities: ["review"],
        compatibility: {
          min_niis_version: "0.1.0",
          max_niis_version: null,
          required_adapters: [],
        },
        activation_status: "REVIEW",
        schema_version: "1.0.0",
      },
      securityFindings: [{
        auto_fixable: false,
        blocking: true,
        category: "supply_chain",
        remediation_hint: "Review before activation.",
        rule_id: "security/prompt-injection-carrier",
        severity: "high",
        source_surface_id: "registry-entry",
        source_surface_type: "discovery",
        summary: "Imported content may carry prompt-injection instructions.",
      }],
      sourceKind: "local_filesystem",
      sourceRef: "/tmp/review-skill/package.json",
      suggestionCategory: "shipped_capability",
      suggestionReason: "Local manifest already exists and should be documented before duplicated.",
      version: "0.1.0",
    }],
    duplicates: [{
      candidateId: "candidate-skill-registry",
      canonicalCandidateId: "candidate-skill-local",
      dedupKey: "package:pkg-review-skill",
      reason: "registry candidate duplicates a filesystem candidate with the same package identity",
    }],
  });

  assert.equal(report.candidates[0].candidate_kind, "package");
  assert.equal(report.candidates[0].package_manifest.activation_status, "REVIEW");
  assert.equal(report.candidates[0].security_findings[0].rule_id, "security/prompt-injection-carrier");
  assert.equal(report.candidates[0].suggestion_category, "shipped_capability");
  assert.match(report.candidates[0].suggestion_reason, /documented/i);
  assert.equal(report.duplicates[0].canonical_candidate_id, "candidate-skill-local");
});

test("createConversionReport normalizes reviewed converter artifacts", () => {
  const report = createConversionReport({
    conversionStatus: "PARTIAL",
    id: "conversion-report-1",
    incompatibilities: ["foreign hooks require manual rewrite"],
    reviewStatus: "PENDING",
    securityFindings: [{
      auto_fixable: false,
      blocking: true,
      remediation_hint: "Review the imported content before activation.",
      rule_id: "security/prompt-injection-carrier",
      severity: "high",
      summary: "Imported content may carry prompt-injection instructions.",
    }],
    sourcePack: {
      format: "cursor_rule_bundle",
      origin: "cursor",
      path: "/tmp/imported-pack",
    },
    targetPackageId: "pkg-imported-skill",
    warnings: ["rule semantics were mapped to skill semantics"],
  });

  assert.equal(report.conversion_status, "PARTIAL");
  assert.equal(report.review_status, "PENDING");
  assert.equal(report.target_package_id, "pkg-imported-skill");
  assert.equal(report.security_findings[0].rule_id, "security/prompt-injection-carrier");
});
