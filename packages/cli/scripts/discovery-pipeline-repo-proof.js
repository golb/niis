import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runIncrementalDiscoveryPipeline } from "../../core/src/runtime/discovery-pipeline.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_VALIDATION_SURFACE_ROOT = path.resolve(DEFAULT_WORKSPACE_ROOT, "..");

class DiscoveryPipelineRepoProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "DiscoveryPipelineRepoProofError";
    this.result = result;
  }
}

function resolveFlagValue(args, flagName) {
  const flagIndex = args.indexOf(flagName);

  if (flagIndex === -1) {
    return null;
  }

  return args[flagIndex + 1] ?? null;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readPackageName(packagePath) {
  if (!fs.existsSync(packagePath)) return null;
  const packageName = JSON.parse(fs.readFileSync(packagePath, "utf8")).name;
  return typeof packageName === "string" && packageName !== ""
    ? packageName
    : null;
}

function createProofArtifacts(workspaceRoot) {
  const proofRoot = path.join(workspaceRoot, ".niis", "proofs", "discovery-pipeline-repo");
  return Object.freeze({
    registry: path.join(proofRoot, "registry.json"),
    summary: path.join(proofRoot, "summary.json"),
  });
}

function runDiscoveryPipelineRepoProof({
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
  validationSurfaceRoot = DEFAULT_VALIDATION_SURFACE_ROOT,
} = {}) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedValidationSurfaceRoot = path.resolve(validationSurfaceRoot);
  const rootPackagePath = path.join(normalizedValidationSurfaceRoot, "package.json");

  if (!fs.existsSync(rootPackagePath) || !fs.statSync(rootPackagePath).isFile()) {
    throw new DiscoveryPipelineRepoProofError(
      `no root package.json found under ${normalizedValidationSurfaceRoot}`,
    );
  }
  const expectedWorkspacePackageIds = [
    readPackageName(rootPackagePath),
    readPackageName(path.join(normalizedValidationSurfaceRoot, "niis", "package.json")),
  ].filter(Boolean);

  const artifacts = createProofArtifacts(normalizedWorkspaceRoot);
  const registryPayload = {
    entries: [
      {
        candidate_kind: "package",
        display_name: "@niis/core registry mirror",
        package_id: "@niis/core",
        source_ref: "registry://niis-core-mirror",
        version: "0.1.0",
      },
      {
        candidate_kind: "package",
        display_name: "Discovery Pipeline Repo Helper",
        package_id: "pkg-discovery-pipeline-repo-helper",
        source_ref: "registry://discovery-pipeline-repo-helper",
        version: "0.1.0",
      },
    ],
  };

  writeJson(artifacts.registry, registryPayload);

  const pipeline = runIncrementalDiscoveryPipeline({
    maxParallel: 2,
    now: "2026-04-04T22:20:00Z",
    reportId: "discovery-pipeline-repo-proof",
    sources: [
      {
        kind: "local_filesystem",
        rootDirectory: normalizedValidationSurfaceRoot,
      },
      {
        kind: "registry",
        registryPath: artifacts.registry,
      },
    ],
    taskId: "discovery-pipeline-repo-proof",
  });
  const candidatePackageIds = pipeline.final_report.candidates
    .map((candidate) => candidate.package_id)
    .filter((packageId) => typeof packageId === "string");
  const candidateSourceRefs = pipeline.final_report.candidates
    .map((candidate) => candidate.source_ref)
    .filter((sourceRef) => typeof sourceRef === "string");
  const duplicateDedupKeys = pipeline.final_report.duplicates
    .map((duplicate) => duplicate.dedup_key)
    .filter((dedupKey) => typeof dedupKey === "string");
  const result = {
    artifacts,
    candidate_package_ids: candidatePackageIds,
    downstream_subtask_count: pipeline.summary.downstream_subtasks_created,
    duplicate_core_detected: duplicateDedupKeys.includes("package:@niis/core"),
    final_candidate_count: pipeline.final_report.candidates.length,
    has_cli_candidate: candidatePackageIds.includes("@niis/cli"),
    has_core_candidate: candidatePackageIds.includes("@niis/core"),
    has_workspace_candidate: expectedWorkspacePackageIds.some((packageId) =>
      candidatePackageIds.includes(packageId)),
    helper_candidate_detected: candidatePackageIds.includes("pkg-discovery-pipeline-repo-helper"),
    parallel_ready_seeker_count: pipeline.ready_seekers.length,
    report_id: pipeline.final_report.report_id,
    root_package_candidate_detected: candidateSourceRefs.includes(rootPackagePath),
    workspace_package_ids_expected: expectedWorkspacePackageIds,
    scope_count: pipeline.seeker_scopes.length,
    source_kinds: pipeline.final_report.source_kinds,
    validation_surface_root: normalizedValidationSurfaceRoot,
    workspace_root: normalizedWorkspaceRoot,
  };

  writeJson(artifacts.summary, result);

  if (
    !result.root_package_candidate_detected
    || !result.has_workspace_candidate
    || !result.has_core_candidate
    || !result.has_cli_candidate
    || !result.duplicate_core_detected
  ) {
    throw new DiscoveryPipelineRepoProofError(
      "discovery pipeline repo proof failed to discover the expected broader host-repo package contour",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const proofWorkspaceRoot = process.env.NIIS_PROOF_WORKSPACE_ROOT
      ? path.resolve(process.env.NIIS_PROOF_WORKSPACE_ROOT)
      : DEFAULT_WORKSPACE_ROOT;
    const validationSurfaceRoot = (() => {
      const flagValue = resolveFlagValue(process.argv, "--validation-surface-root");
      return flagValue === null
        ? DEFAULT_VALIDATION_SURFACE_ROOT
        : path.resolve(process.cwd(), flagValue);
    })();

    console.log(JSON.stringify(runDiscoveryPipelineRepoProof({
      validationSurfaceRoot,
      workspaceRoot: proofWorkspaceRoot,
    }), null, 2));
  } catch (error) {
    if (error instanceof DiscoveryPipelineRepoProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  DiscoveryPipelineRepoProofError,
  runDiscoveryPipelineRepoProof,
};
