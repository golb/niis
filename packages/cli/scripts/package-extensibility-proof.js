import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createPackageManifest } from "../../core/src/contracts/packages.js";

class PackageExtensibilityProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "PackageExtensibilityProofError";
    this.result = result;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntrypoint = path.resolve(__dirname, "..", "bin", "niis.js");
const validatorContractPath = path.resolve(
  __dirname,
  "..",
  "..",
  "core",
  "src",
  "contracts",
  "validator.js",
);
const testAdapterPath = path.resolve(__dirname, "..", "..", "adapters", "test-adapter.js");

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function writeFile(filePath, content) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runCliStep({
  command,
  commandArgs = [],
  parseJson = true,
  workspaceRoot,
}) {
  const result = spawnSync(process.execPath, [cliEntrypoint, command, ...commandArgs], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const stdout = result.stdout?.trim() ?? "";

  return Object.freeze({
    command,
    command_args: commandArgs,
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    parsed_json: parseJson && stdout ? JSON.parse(stdout) : null,
    stderr: result.stderr?.trim() ?? "",
    stdout,
  });
}

function createExtensionPackageFiles(workspaceRoot) {
  const extensionsRoot = path.join(workspaceRoot, "extensions");
  ensureDirectory(extensionsRoot);
  const packageIds = {
    adapter: "package-proof-adapter",
    agent: "package-proof-agent",
    role: "package-proof-role",
    validator: "package-proof-validator",
  };
  const manifests = {
    adapter: createPackageManifest({
      activationStatus: "REVIEW",
      capabilities: ["execute", "package_extensibility"],
      id: packageIds.adapter,
      name: "Package Proof Adapter",
      runtime: {
        definitionKind: "adapter_factory",
        moduleRef: "./package-proof-adapter.js",
      },
      type: "adapter",
      version: "1.0.0",
    }),
    agent: createPackageManifest({
      activationStatus: "REVIEW",
      capabilities: ["execute"],
      id: packageIds.agent,
      name: "Package Proof Agent",
      runtime: {
        definitionKind: "agent_entity",
        moduleRef: "./package-proof-agent.js",
      },
      type: "agent",
      version: "1.0.0",
    }),
    role: createPackageManifest({
      activationStatus: "REVIEW",
      capabilities: ["route"],
      id: packageIds.role,
      name: "Package Proof Role",
      runtime: {
        definitionKind: "role_manifest",
        moduleRef: "./package-proof-role.js",
      },
      type: "role",
      version: "1.0.0",
    }),
    validator: createPackageManifest({
      activationStatus: "REVIEW",
      capabilities: ["review"],
      id: packageIds.validator,
      name: "Package Proof Validator",
      runtime: {
        definitionKind: "validator_factory",
        moduleRef: "./package-proof-validator.js",
      },
      type: "validator",
      version: "1.0.0",
    }),
  };

  const manifestPaths = {
    adapter: path.join(extensionsRoot, "package-proof-adapter.manifest.json"),
    agent: path.join(extensionsRoot, "package-proof-agent.manifest.json"),
    role: path.join(extensionsRoot, "package-proof-role.manifest.json"),
    validator: path.join(extensionsRoot, "package-proof-validator.manifest.json"),
  };

  for (const [key, manifestPath] of Object.entries(manifestPaths)) {
    writeJson(manifestPath, manifests[key]);
  }

  writeFile(
    path.join(extensionsRoot, "package-proof-adapter.js"),
    [
      `import { createInMemoryTestAdapter } from ${JSON.stringify(testAdapterPath)};`,
      "",
      "export default function createPackageProofAdapter() {",
      "  return createInMemoryTestAdapter({",
      `    id: ${JSON.stringify(packageIds.adapter)},`,
      "    capabilities: {",
      "      operations: [\"execute\"],",
      "      permissions: [],",
      "      privilegedOperations: [],",
      "      protocolType: \"in_memory\",",
      "      toolFamilies: [\"package_extensibility\"],",
      "      allow: {",
      "        sensitivePathClasses: [\"workspace\"],",
      "        toolFamilies: [\"package_extensibility\"],",
      "      },",
      "      deny: {",
      "        operations: [],",
      "        sensitivePathClasses: [],",
      "        toolFamilies: [],",
      "      },",
      "    },",
      "    metadata: { cost_tier: \"standard\", loaded_from_package: true },",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(extensionsRoot, "package-proof-role.js"),
    [
      "export default {",
      `  id: ${JSON.stringify(packageIds.role)},`,
      "  lane: \"generalist\",",
      "  keywords: [\"package extensibility proof\"],",
      "  safe_fallback: true,",
      "  expected_output: \"Use the activated package role and adapter.\",",
      "  quality_bar: [\"Select the package-provided execution lane.\"],",
      "  adapter_requirements: {",
      "    operations: [\"execute\"],",
      "    protocolTypes: [\"in_memory\"],",
      "    toolFamilies: [\"package_extensibility\"],",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(extensionsRoot, "package-proof-validator.js"),
    [
      `import { createValidatorDefinition } from ${JSON.stringify(validatorContractPath)};`,
      "",
      "export default function createPackageProofValidator() {",
      "  return createValidatorDefinition({",
      `    id: ${JSON.stringify(packageIds.validator)},`,
      "    description: \"Package-provided proof validator.\",",
      "    domain: \"package_extensibility_proof\",",
      "    excludedConcerns: [],",
      "    validate() {",
      "      return {",
      "        verdict_class: \"PASS\",",
      "        failure_attribution: \"none\",",
      "        reason: \"Activated validator package loaded successfully.\",",
      "        next_action: \"Package extensibility proof passed.\",",
      "        evidence_packet: {",
      "          authenticity_status: \"VERIFIED\",",
      "          items: [{",
      "            content: \"Activated validator package executed through the review CLI path.\",",
      `            source: ${JSON.stringify(packageIds.validator)},`,
      "            type: \"package_validator\",",
      "          }],",
      "          markers: {",
      "            auth_surfaces_attempted: [\"package-runtime-loader\"],",
      "            browser_live_checks: [],",
      "            checked_urls: [],",
      "            runtime_evidence_succeeded: true,",
      "          },",
      "        },",
      "      };",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(extensionsRoot, "package-proof-agent.js"),
    [
      "export default {",
      `  id: ${JSON.stringify(packageIds.agent)},`,
      "  name: \"Package Proof Agent\",",
      "  adapter_type: \"in_memory\",",
      "  status: \"ACTIVE\",",
      "  pause_condition: null,",
      "  capabilities: [\"execute\"],",
      "  budget_monthly: { limit_usd: 10, spent_usd: 0 },",
      "  config: {},",
      "  env_bindings: [],",
      "  health_status: \"healthy\",",
      "  last_run_id: null,",
      "  last_run_at: null,",
      "  accumulated: {",
      "    total_tokens_in: 0,",
      "    total_tokens_out: 0,",
      "    total_cost_usd: 0,",
      "    total_runs: 0,",
      "  },",
      `  created_at: ${JSON.stringify(new Date("2026-04-07T00:00:00.000Z").toISOString())},`,
      `  updated_at: ${JSON.stringify(new Date("2026-04-07T00:00:00.000Z").toISOString())},`,
      "};",
      "",
    ].join("\n"),
  );

  return {
    manifest_paths: manifestPaths,
    manifests,
    package_ids: packageIds,
  };
}

function createActivationSpec({
  candidateKind,
  manifest,
  sourceRef,
}) {
  return {
    candidateKind,
    packageManifest: manifest,
    recordInstallState: true,
    sourceKind: "local_filesystem",
    sourceRef,
  };
}

function runPackageExtensibilityProof({
  workspaceRoot = null,
} = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-package-extensibility-proof-"));
  const resolvedWorkspaceRoot = workspaceRoot
    ? path.resolve(workspaceRoot)
    : path.join(tempRoot, "workspace");

  ensureDirectory(resolvedWorkspaceRoot);
  const packageFiles = createExtensionPackageFiles(resolvedWorkspaceRoot);
  const activationSteps = [];
  const initStep = runCliStep({
    command: "init",
    parseJson: false,
    workspaceRoot: resolvedWorkspaceRoot,
  });

  for (const packageKind of ["role", "adapter", "validator", "agent"]) {
    const activationSpecPath = path.join(
      resolvedWorkspaceRoot,
      `${packageKind}-activation.json`,
    );
    writeJson(activationSpecPath, createActivationSpec({
      candidateKind: packageKind === "agent" ? "package" : packageKind,
      manifest: packageFiles.manifests[packageKind],
      sourceRef: path.relative(resolvedWorkspaceRoot, packageFiles.manifest_paths[packageKind]),
    }));
    activationSteps.push(runCliStep({
      command: "activate",
      commandArgs: [activationSpecPath],
      workspaceRoot: resolvedWorkspaceRoot,
    }));
  }

  const routeSpecPath = path.join(resolvedWorkspaceRoot, "package-proof-route.json");
  writeJson(routeSpecPath, {
    referenceBundle: {
      guides: [],
      targetPaths: [],
    },
    task: {
      id: "package-proof-task",
      priority: "medium",
      title: "Package extensibility proof task",
    },
  });
  const routeStep = runCliStep({
    command: "route",
    commandArgs: [routeSpecPath],
    workspaceRoot: resolvedWorkspaceRoot,
  });

  const reviewSpecPath = path.join(resolvedWorkspaceRoot, "package-proof-review.json");
  writeJson(reviewSpecPath, {
    runRecord: {
      id: "package-proof-run",
      task_id: "package-proof-task",
      agent_id: packageFiles.package_ids.agent,
      adapter_id: packageFiles.package_ids.adapter,
      status: "COMPLETED",
      started_at: "2026-04-07T00:00:00.000Z",
      finished_at: "2026-04-07T00:00:01.000Z",
      checkpoint_id: null,
      exit_code: 0,
      cost: {
        tokens_in: 0,
        tokens_out: 0,
        duration_ms: 1,
        estimated_usd: 0,
      },
      invocation_source: "on_demand",
      run_log: {
        storage: "inline",
        ref: null,
        bytes: 0,
        sha256: "proof",
      },
      task_session_key: null,
    },
    task: {
      id: "package-proof-task",
      priority: "medium",
      title: "Package extensibility proof task",
    },
    validatorIds: [packageFiles.package_ids.validator],
  });
  const reviewStep = runCliStep({
    command: "review",
    commandArgs: [reviewSpecPath],
    workspaceRoot: resolvedWorkspaceRoot,
  });

  const serveSpecPath = path.join(resolvedWorkspaceRoot, "package-proof-serve.json");
  writeJson(serveSpecPath, {
    agentId: packageFiles.package_ids.agent,
    maxTicks: 0,
    storage: {
      kind: "memory",
    },
    watchConfig: {
      taskSources: [],
    },
    workspace: {
      root: ".niis/tmp-workspaces",
    },
  });
  const serveStep = runCliStep({
    command: "serve",
    commandArgs: [serveSpecPath, "--once"],
    workspaceRoot: resolvedWorkspaceRoot,
  });

  const ok = [
    initStep.ok,
    activationSteps.every((step) => step.ok),
    activationSteps.every((step) => step.parsed_json?.allowed === true),
    routeStep.ok,
    routeStep.parsed_json?.selected_adapter?.id === packageFiles.package_ids.adapter,
    routeStep.parsed_json?.selected_lane?.manifest_id === packageFiles.package_ids.role,
    reviewStep.ok,
    reviewStep.parsed_json?.results?.[0]?.validator?.id === packageFiles.package_ids.validator,
    reviewStep.parsed_json?.final_verdict?.verdict_class === "PASS",
    serveStep.ok,
    Array.isArray(serveStep.parsed_json?.snapshot?.agents),
    serveStep.parsed_json?.snapshot?.agents?.some((agent) => agent.id === packageFiles.package_ids.agent) === true,
  ].every(Boolean);
  const result = {
    activation_steps: activationSteps,
    init_step: initStep,
    ok,
    package_ids: packageFiles.package_ids,
    route_step: routeStep,
    review_step: reviewStep,
    serve_step: serveStep,
    temp_root: tempRoot,
    workspace_root: resolvedWorkspaceRoot,
  };

  if (!ok) {
    throw new PackageExtensibilityProofError(
      "package extensibility proof failed; inspect activation, route, review, or serve output",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runPackageExtensibilityProof(), null, 2));
  } catch (error) {
    if (error instanceof PackageExtensibilityProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  PackageExtensibilityProofError,
  runPackageExtensibilityProof,
};
