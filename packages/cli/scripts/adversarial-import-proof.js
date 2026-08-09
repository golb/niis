import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

class AdversarialImportProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "AdversarialImportProofError";
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

function runCliStep({
  cliEntrypoint,
  command,
  commandArgs = [],
  workspaceRoot,
  parseJson = false,
}) {
  const result = spawnSync(
    process.execPath,
    [cliEntrypoint, command, ...commandArgs],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
    },
  );
  const stdout = result.stdout?.trim() ?? "";
  const step = {
    command,
    command_args: commandArgs,
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    stderr: result.stderr?.trim() ?? "",
    stdout,
  };

  if (!parseJson || result.status !== 0) {
    return step;
  }

  try {
    return {
      ...step,
      parsed_json: stdout ? JSON.parse(stdout) : null,
    };
  } catch (error) {
    throw new AdversarialImportProofError(
      `failed to parse JSON output for command ${command}: ${error.message}`,
      { failed_step: step },
    );
  }
}

function createProofArtifacts(workspaceRoot, proofLabel = null) {
  const proofRoot = proofLabel
    ? path.join(workspaceRoot, ".niis", "proofs", "adversarial-import", proofLabel)
    : path.join(workspaceRoot, ".niis", "proofs", "adversarial-import");
  return Object.freeze({
    import_output: path.join(proofRoot, "import-output.json"),
    import_spec: path.join(proofRoot, "import-spec.json"),
  });
}

function verifyProofArtifacts(artifacts) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(artifacts).map(([key, artifactPath]) => [key, fs.existsSync(artifactPath)]),
    ),
  );
}

function createProofLabel(sourcePath) {
  return path.basename(sourcePath)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function resolveHostImportSource(validationSurfaceRoot, explicitSourcePath = null) {
  if (explicitSourcePath) {
    const resolvedSourcePath = path.resolve(validationSurfaceRoot, explicitSourcePath);

    if (!fs.existsSync(resolvedSourcePath)) {
      throw new AdversarialImportProofError(`explicit source path is missing: ${resolvedSourcePath}`);
    }

    return resolvedSourcePath;
  }

  const candidates = [
    "README.md",
    "docs/README.md",
    "package.json",
  ].map((candidate) => path.join(validationSurfaceRoot, candidate));

  const match = candidates.find((candidate) => fs.existsSync(candidate));

  if (!match) {
    throw new AdversarialImportProofError(
      `no import proof source found under ${validationSurfaceRoot}; expected one of `
      + candidates.map((candidate) => path.basename(candidate)).join(", "),
    );
  }

  return match;
}

function createImportSpec({
  packageId,
  sourcePath,
  taskId,
  timestamp,
}) {
  function createContextAwareReviewerSpec({
    expectedPreviousResultsCount,
    id,
    role,
    verdictClass,
  }) {
    return {
      expectedPreviousResultsCount,
      id,
      role,
      strategy: "subject_summary",
      verdictClass,
    };
  }

  return {
    adversarialReviewers: [
      createContextAwareReviewerSpec({
        expectedPreviousResultsCount: 0,
        id: "proof-import-attacker",
        role: "attacker",
        verdictClass: "DEFECT",
      }),
      createContextAwareReviewerSpec({
        expectedPreviousResultsCount: 1,
        id: "proof-import-defender",
        role: "defender",
        verdictClass: "PASS",
      }),
      createContextAwareReviewerSpec({
        expectedPreviousResultsCount: 2,
        id: "proof-import-auditor",
        role: "auditor",
        verdictClass: "PASS",
      }),
    ],
    now: timestamp,
    policy: {
      activation_review: {
        mode: "auto",
      },
    },
    sourcePack: {
      capabilities: ["review"],
      foreignType: "rule",
      format: "cursor_rule_bundle",
      origin: "host_repository",
      path: sourcePath,
      targetPackageId: packageId,
      version: "0.1.0",
    },
    taskId,
  };
}

function runAdversarialImportProof({
  proofLabel = null,
  sourcePath = null,
  workspaceRoot = process.cwd(),
  validationSurfaceRoot = workspaceRoot,
  cliEntrypoint = null,
} = {}) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedValidationSurfaceRoot = path.resolve(validationSurfaceRoot);
  const resolvedSourcePath = resolveHostImportSource(
    normalizedValidationSurfaceRoot,
    sourcePath,
  );
  const resolvedProofLabel = proofLabel ?? (sourcePath ? createProofLabel(resolvedSourcePath) : null);
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const resolvedCliEntrypoint = cliEntrypoint
    ? path.resolve(cliEntrypoint)
    : path.resolve(scriptDirectory, "..", "bin", "niis.js");
  const timestamp = "2026-04-03T12:30:00.000Z";
  const artifacts = createProofArtifacts(normalizedWorkspaceRoot, resolvedProofLabel);
  const steps = [
    runCliStep({
      cliEntrypoint: resolvedCliEntrypoint,
      command: "init",
      workspaceRoot: normalizedWorkspaceRoot,
    }),
    runCliStep({
      cliEntrypoint: resolvedCliEntrypoint,
      command: "attach",
      commandArgs: ["--validation-surface-root", normalizedValidationSurfaceRoot],
      workspaceRoot: normalizedWorkspaceRoot,
    }),
    runCliStep({
      cliEntrypoint: resolvedCliEntrypoint,
      command: "profile",
      commandArgs: ["--validation-surface-root", normalizedValidationSurfaceRoot],
      workspaceRoot: normalizedWorkspaceRoot,
    }),
  ];

  if (steps.some((step) => !step.ok)) {
    throw new AdversarialImportProofError(
      "adversarial import proof bootstrap preconditions failed",
      { steps },
    );
  }

  const packageId = resolvedProofLabel
    ? `host-repo-review-skill-${resolvedProofLabel}`
    : "host-repo-review-skill";
  const taskId = resolvedProofLabel
    ? `adversarial-import-proof-task-${resolvedProofLabel}`
    : "adversarial-import-proof-task";
  const importSpec = createImportSpec({
    packageId,
    sourcePath: resolvedSourcePath,
    taskId,
    timestamp,
  });
  writeJson(artifacts.import_spec, importSpec);

  const importStep = runCliStep({
    cliEntrypoint: resolvedCliEntrypoint,
    command: "import",
    commandArgs: [path.relative(normalizedWorkspaceRoot, artifacts.import_spec)],
    parseJson: true,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  steps.push(importStep);

  if (!importStep.ok) {
    throw new AdversarialImportProofError(
      "adversarial import proof failed during import",
      { artifacts, steps },
    );
  }

  writeJson(artifacts.import_output, importStep.parsed_json);

  const artifactChecks = verifyProofArtifacts(artifacts);
  const finalReviewStatus = importStep.parsed_json?.conversion_report?.review_status ?? null;
  const finalVerdict = importStep.parsed_json?.adversarial_review?.final_verdict?.verdict_class ?? null;
  const importedPackageId = importStep.parsed_json?.package_manifest?.id ?? null;
  const ok = steps.every((step) => step.ok)
    && Object.values(artifactChecks).every(Boolean)
    && finalReviewStatus === "APPROVED"
    && finalVerdict === "PASS"
    && importStep.parsed_json?.package_manifest?.activation_status === "REVIEW";
  const result = {
    artifact_checks: artifactChecks,
    artifacts,
    cli_entrypoint: resolvedCliEntrypoint,
    final_review_status: finalReviewStatus,
    final_verdict: finalVerdict,
    imported_package_id: importedPackageId,
    ok,
    proof_label: resolvedProofLabel,
    source_path: importSpec.sourcePack.path,
    steps,
    validation_surface_root: normalizedValidationSurfaceRoot,
    workspace_root: normalizedWorkspaceRoot,
  };

  if (!ok) {
    throw new AdversarialImportProofError(
      "adversarial import proof failed; inspect command outputs or import artifacts",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const validationSurfaceRoot = (() => {
      const flagValue = resolveFlagValue(process.argv, "--validation-surface-root");
      return flagValue === null ? process.cwd() : path.resolve(process.cwd(), flagValue);
    })();

    console.log(JSON.stringify(runAdversarialImportProof({
      proofLabel: resolveFlagValue(process.argv, "--proof-label"),
      sourcePath: resolveFlagValue(process.argv, "--source-path"),
      validationSurfaceRoot,
    }), null, 2));
  } catch (error) {
    if (error instanceof AdversarialImportProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  AdversarialImportProofError,
  runAdversarialImportProof,
};
