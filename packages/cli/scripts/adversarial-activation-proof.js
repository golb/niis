import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  runAdversarialImportProof,
} from "./adversarial-import-proof.js";

class AdversarialActivationProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "AdversarialActivationProofError";
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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
    throw new AdversarialActivationProofError(
      `failed to parse JSON output for command ${command}: ${error.message}`,
      { failed_step: step },
    );
  }
}

function createProofArtifacts(workspaceRoot, proofLabel = null) {
  const proofRoot = proofLabel
    ? path.join(workspaceRoot, ".niis", "proofs", "adversarial-activation", proofLabel)
    : path.join(workspaceRoot, ".niis", "proofs", "adversarial-activation");
  return Object.freeze({
    activate_output: path.join(proofRoot, "activate-output.json"),
    activate_spec: path.join(proofRoot, "activate-spec.json"),
  });
}

function verifyProofArtifacts(artifacts) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(artifacts).map(([key, artifactPath]) => [key, fs.existsSync(artifactPath)]),
    ),
  );
}

function createActivationSpec({
  imported,
  proofLabel,
  timestamp,
}) {
  const taskId = proofLabel
    ? `adversarial-activation-proof-task-${proofLabel}`
    : "adversarial-activation-proof-task";
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
        id: "proof-activation-attacker",
        role: "attacker",
        verdictClass: "DEFECT",
      }),
      createContextAwareReviewerSpec({
        expectedPreviousResultsCount: 1,
        id: "proof-activation-defender",
        role: "defender",
        verdictClass: "PASS",
      }),
      createContextAwareReviewerSpec({
        expectedPreviousResultsCount: 2,
        id: "proof-activation-auditor",
        role: "auditor",
        verdictClass: "PASS",
      }),
    ],
    now: timestamp,
    packageManifest: imported.package_manifest,
    policy: {
      activation_review: {
        mode: "auto",
      },
    },
    securityScanSurfaces: imported.activation_input?.security_scan_surfaces ?? [],
    taskId,
  };
}

function runAdversarialActivationProof({
  proofLabel = null,
  sourcePath = null,
  workspaceRoot = process.cwd(),
  validationSurfaceRoot = workspaceRoot,
  cliEntrypoint = null,
} = {}) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedValidationSurfaceRoot = path.resolve(validationSurfaceRoot);
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const resolvedCliEntrypoint = cliEntrypoint
    ? path.resolve(cliEntrypoint)
    : path.resolve(scriptDirectory, "..", "bin", "niis.js");
  const timestamp = "2026-04-03T14:15:00.000Z";
  const artifacts = createProofArtifacts(normalizedWorkspaceRoot, proofLabel);

  let importProof;
  try {
    importProof = runAdversarialImportProof({
      cliEntrypoint: resolvedCliEntrypoint,
      proofLabel,
      sourcePath,
      validationSurfaceRoot: normalizedValidationSurfaceRoot,
      workspaceRoot: normalizedWorkspaceRoot,
    });
  } catch (error) {
    if (error?.result) {
      throw new AdversarialActivationProofError(
        "adversarial activation proof failed during import contour",
        error.result,
      );
    }
    throw error;
  }

  const imported = readJson(importProof.artifacts.import_output);
  const activationSpec = createActivationSpec({
    imported,
    proofLabel: importProof.proof_label,
    timestamp,
  });
  writeJson(artifacts.activate_spec, activationSpec);

  const activateStep = runCliStep({
    cliEntrypoint: resolvedCliEntrypoint,
    command: "activate",
    commandArgs: [path.relative(normalizedWorkspaceRoot, artifacts.activate_spec)],
    parseJson: true,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const steps = [
    ...importProof.steps,
    activateStep,
  ];

  if (!activateStep.ok) {
    throw new AdversarialActivationProofError(
      "adversarial activation proof failed during activation",
      { artifacts, steps },
    );
  }

  writeJson(artifacts.activate_output, activateStep.parsed_json);

  const artifactChecks = verifyProofArtifacts(artifacts);
  const finalActivationStatus = activateStep.parsed_json?.package_manifest?.activation_status ?? null;
  const finalAllowed = activateStep.parsed_json?.allowed ?? null;
  const finalVerdict = activateStep.parsed_json?.adversarial_review?.final_verdict?.verdict_class ?? null;
  const importedPackageId = activateStep.parsed_json?.package_manifest?.id ?? null;
  const ok = importProof.ok
    && steps.every((step) => step.ok)
    && Object.values(artifactChecks).every(Boolean)
    && finalAllowed === true
    && finalActivationStatus === "ACTIVE"
    && finalVerdict === "PASS";
  const result = {
    activation_allowed: finalAllowed,
    artifact_checks: artifactChecks,
    artifacts,
    cli_entrypoint: resolvedCliEntrypoint,
    final_activation_status: finalActivationStatus,
    final_verdict: finalVerdict,
    import_final_review_status: importProof.final_review_status,
    imported_package_id: importedPackageId,
    ok,
    proof_label: importProof.proof_label,
    source_path: importProof.source_path,
    steps,
    validation_surface_root: normalizedValidationSurfaceRoot,
    workspace_root: normalizedWorkspaceRoot,
  };

  if (!ok) {
    throw new AdversarialActivationProofError(
      "adversarial activation proof failed; inspect activation artifacts",
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

    console.log(JSON.stringify(runAdversarialActivationProof({
      proofLabel: resolveFlagValue(process.argv, "--proof-label"),
      sourcePath: resolveFlagValue(process.argv, "--source-path"),
      validationSurfaceRoot,
    }), null, 2));
  } catch (error) {
    if (error instanceof AdversarialActivationProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  AdversarialActivationProofError,
  runAdversarialActivationProof,
};
