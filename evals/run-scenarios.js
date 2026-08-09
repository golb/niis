import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

class EvalHarnessError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "EvalHarnessError";
    this.result = result;
  }
}

const ASSET_HEALTH_STATUSES = Object.freeze(["healthy", "watch", "failing"]);

function ensurePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvalHarnessError(`${label} must be a plain object`);
  }

  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new EvalHarnessError(`${label} must be an array`);
  }

  return value;
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvalHarnessError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureEnumValue(value, allowedValues, label) {
  const normalizedValue = ensureNonEmptyString(value, label);

  if (!allowedValues.includes(normalizedValue)) {
    throw new EvalHarnessError(
      `${label} must be one of ${allowedValues.join(", ")}`,
    );
  }

  return normalizedValue;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function getByPath(value, dottedPath) {
  return dottedPath.split(".").reduce(
    (current, segment) => (current === undefined || current === null ? undefined : current[segment]),
    value,
  );
}

function tryParseJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveAttemptFilePath(attempt, grader) {
  const filePath = ensureNonEmptyString(
    grader.file ?? grader.file_path ?? grader.filePath,
    "grader.file",
  );

  return path.resolve(attempt.cwd, filePath);
}

function valueMatchesExpectation(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((item, index) => valueMatchesExpectation(actual[index], item));
  }

  if (isPlainObject(expected)) {
    return isPlainObject(actual)
      && Object.entries(expected).every(([key, value]) =>
        valueMatchesExpectation(actual[key], value));
  }

  return actual === expected;
}

function gradeJsonArrayIncludes({
  actualFilePath = null,
  fieldPath,
  graderType,
  jsonValue,
  expectedEntry,
}) {
  if (!Array.isArray(jsonValue)) {
    return {
      actual: jsonValue,
      actual_file: actualFilePath,
      expected: expectedEntry,
      passed: false,
      summary: `${actualFilePath ? "JSON file field" : "JSON field"} ${fieldPath} was not an array.`,
      type: graderType,
    };
  }

  const passed = jsonValue.some((entry) => valueMatchesExpectation(entry, expectedEntry));

  return {
    actual: jsonValue,
    actual_file: actualFilePath,
    expected: expectedEntry,
    passed,
    summary: passed
      ? `${actualFilePath ? "JSON file array" : "JSON array"} ${fieldPath} included the expected entry.`
      : `${actualFilePath ? "JSON file array" : "JSON array"} ${fieldPath} did not include the expected entry.`,
    type: graderType,
  };
}

function gradeJsonArrayAllFieldEquals({
  actualFilePath = null,
  fieldName,
  fieldPath,
  graderType,
  jsonValue,
  expectedValue,
}) {
  if (!Array.isArray(jsonValue)) {
    return {
      actual: jsonValue,
      actual_file: actualFilePath,
      expected: expectedValue,
      passed: false,
      summary: `${actualFilePath ? "JSON file field" : "JSON field"} ${fieldPath} was not an array.`,
      type: graderType,
    };
  }

  if (jsonValue.length === 0) {
    return {
      actual: jsonValue,
      actual_file: actualFilePath,
      expected: expectedValue,
      passed: false,
      summary: `${actualFilePath ? "JSON file array" : "JSON array"} ${fieldPath} was empty.`,
      type: graderType,
    };
  }

  const passed = jsonValue.every((entry) =>
    isPlainObject(entry) && valueMatchesExpectation(entry[fieldName], expectedValue));

  return {
    actual: jsonValue,
    actual_file: actualFilePath,
    expected: expectedValue,
    passed,
    summary: passed
      ? `${actualFilePath ? "JSON file array" : "JSON array"} ${fieldPath} had ${fieldName} matching the expected value for every entry.`
      : `${actualFilePath ? "JSON file array" : "JSON array"} ${fieldPath} did not have ${fieldName} matching the expected value for every entry.`,
    type: graderType,
  };
}

function gradeJsonObjectValuesEqual({
  actualFilePath = null,
  fieldPath,
  graderType,
  jsonValue,
  expectedValue,
}) {
  if (!isPlainObject(jsonValue)) {
    return {
      actual: jsonValue,
      actual_file: actualFilePath,
      expected: expectedValue,
      passed: false,
      summary: `${actualFilePath ? "JSON file field" : "JSON field"} ${fieldPath} was not an object.`,
      type: graderType,
    };
  }

  const values = Object.values(jsonValue);
  if (values.length === 0) {
    return {
      actual: jsonValue,
      actual_file: actualFilePath,
      expected: expectedValue,
      passed: false,
      summary: `${actualFilePath ? "JSON file object" : "JSON object"} ${fieldPath} had no values.`,
      type: graderType,
    };
  }

  const passed = values.every((value) => valueMatchesExpectation(value, expectedValue));

  return {
    actual: jsonValue,
    actual_file: actualFilePath,
    expected: expectedValue,
    passed,
    summary: passed
      ? `${actualFilePath ? "JSON file object" : "JSON object"} ${fieldPath} had all values matching the expected value.`
      : `${actualFilePath ? "JSON file object" : "JSON object"} ${fieldPath} did not have all values matching the expected value.`,
    type: graderType,
  };
}

function gradeAttempt(grader, attempt) {
  const normalizedGrader = ensurePlainObject(grader, "grader");
  const graderType = ensureNonEmptyString(
    normalizedGrader.type ?? normalizedGrader.kind,
    "grader.type",
  );

  if (graderType === "exit_code_zero") {
    return {
      passed: attempt.exit_code === 0,
      summary: attempt.exit_code === 0
        ? "Process exited with code 0."
        : `Process exited with code ${attempt.exit_code}.`,
      type: graderType,
    };
  }

  if (graderType === "json_field_equals") {
    const fieldPath = ensureNonEmptyString(
      normalizedGrader.path ?? normalizedGrader.field,
      "grader.path",
    );
    const actual = getByPath(attempt.stdout_json, fieldPath);
    const expected = normalizedGrader.equals;

    return {
      actual,
      expected,
      passed: actual === expected,
      summary: actual === expected
        ? `JSON field ${fieldPath} matched the expected value.`
        : `JSON field ${fieldPath} did not match the expected value.`,
      type: graderType,
    };
  }

  if (graderType === "json_field_gte") {
    const fieldPath = ensureNonEmptyString(
      normalizedGrader.path ?? normalizedGrader.field,
      "grader.path",
    );
    const actual = getByPath(attempt.stdout_json, fieldPath);
    const expected = normalizedGrader.gte ?? normalizedGrader.min;

    if (typeof actual !== "number" || typeof expected !== "number") {
      return {
        actual,
        expected,
        passed: false,
        summary: `JSON field ${fieldPath} or the expected minimum was not numeric.`,
        type: graderType,
      };
    }

    return {
      actual,
      expected,
      passed: actual >= expected,
      summary: actual >= expected
        ? `JSON field ${fieldPath} was greater than or equal to the expected minimum.`
        : `JSON field ${fieldPath} was less than the expected minimum.`,
      type: graderType,
    };
  }

  if (graderType === "json_array_includes") {
    const fieldPath = ensureNonEmptyString(
      normalizedGrader.path ?? normalizedGrader.field,
      "grader.path",
    );
    const expectedEntry = normalizedGrader.includes;

    if (expectedEntry === undefined) {
      throw new EvalHarnessError("grader.includes must be provided");
    }

    return gradeJsonArrayIncludes({
      expectedEntry,
      fieldPath,
      graderType,
      jsonValue: getByPath(attempt.stdout_json, fieldPath),
    });
  }

  if (graderType === "json_array_all_field_equals") {
    const fieldPath = ensureNonEmptyString(
      normalizedGrader.path ?? normalizedGrader.field,
      "grader.path",
    );
    const fieldName = ensureNonEmptyString(
      normalizedGrader.entry_field ?? normalizedGrader.entryField,
      "grader.entry_field",
    );
    if (!Object.hasOwn(normalizedGrader, "equals")) {
      throw new EvalHarnessError("grader.equals must be provided");
    }

    return gradeJsonArrayAllFieldEquals({
      expectedValue: normalizedGrader.equals,
      fieldName,
      fieldPath,
      graderType,
      jsonValue: getByPath(attempt.stdout_json, fieldPath),
    });
  }

  if (graderType === "json_object_values_all_equal") {
    const fieldPath = ensureNonEmptyString(
      normalizedGrader.path ?? normalizedGrader.field,
      "grader.path",
    );
    if (!Object.hasOwn(normalizedGrader, "equals")) {
      throw new EvalHarnessError("grader.equals must be provided");
    }

    return gradeJsonObjectValuesEqual({
      expectedValue: normalizedGrader.equals,
      fieldPath,
      graderType,
      jsonValue: getByPath(attempt.stdout_json, fieldPath),
    });
  }

  if (graderType === "stdout_contains") {
    const needle = ensureNonEmptyString(normalizedGrader.contains, "grader.contains");
    return {
      passed: attempt.stdout.includes(needle),
      summary: attempt.stdout.includes(needle)
        ? `stdout contained ${needle}.`
        : `stdout did not contain ${needle}.`,
      type: graderType,
    };
  }

  if (graderType === "file_contains") {
    const filePath = resolveAttemptFilePath(attempt, normalizedGrader);
    const needle = ensureNonEmptyString(normalizedGrader.contains, "grader.contains");
    const fileExists = fs.existsSync(filePath);
    const fileContent = fileExists ? fs.readFileSync(filePath, "utf8") : "";

    return {
      actual_file: filePath,
      passed: fileExists && fileContent.includes(needle),
      summary: !fileExists
        ? `File ${filePath} did not exist.`
        : fileContent.includes(needle)
          ? `File ${filePath} contained ${needle}.`
          : `File ${filePath} did not contain ${needle}.`,
      type: graderType,
    };
  }

  if (graderType === "file_json_field_equals") {
    const filePath = resolveAttemptFilePath(attempt, normalizedGrader);
    const fieldPath = ensureNonEmptyString(
      normalizedGrader.path ?? normalizedGrader.field,
      "grader.path",
    );
    const expected = normalizedGrader.equals;

    if (!fs.existsSync(filePath)) {
      return {
        actual: undefined,
        actual_file: filePath,
        expected,
        passed: false,
        summary: `File ${filePath} did not exist.`,
        type: graderType,
      };
    }

    let parsedFile;

    try {
      parsedFile = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return {
        actual: undefined,
        actual_file: filePath,
        expected,
        passed: false,
        summary: `File ${filePath} was not valid JSON.`,
        type: graderType,
      };
    }

    const actual = getByPath(parsedFile, fieldPath);

    return {
      actual,
      actual_file: filePath,
      expected,
      passed: actual === expected,
      summary: actual === expected
        ? `JSON file field ${fieldPath} matched the expected value.`
        : `JSON file field ${fieldPath} did not match the expected value.`,
      type: graderType,
    };
  }

  if (graderType === "file_json_array_includes") {
    const filePath = resolveAttemptFilePath(attempt, normalizedGrader);
    const fieldPath = ensureNonEmptyString(
      normalizedGrader.path ?? normalizedGrader.field,
      "grader.path",
    );
    const expectedEntry = normalizedGrader.includes;

    if (expectedEntry === undefined) {
      throw new EvalHarnessError("grader.includes must be provided");
    }

    if (!fs.existsSync(filePath)) {
      return {
        actual: undefined,
        actual_file: filePath,
        expected: expectedEntry,
        passed: false,
        summary: `File ${filePath} did not exist.`,
        type: graderType,
      };
    }

    let parsedFile;

    try {
      parsedFile = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return {
        actual: undefined,
        actual_file: filePath,
        expected: expectedEntry,
        passed: false,
        summary: `File ${filePath} was not valid JSON.`,
        type: graderType,
      };
    }

    return gradeJsonArrayIncludes({
      actualFilePath: filePath,
      expectedEntry,
      fieldPath,
      graderType,
      jsonValue: getByPath(parsedFile, fieldPath),
    });
  }

  throw new EvalHarnessError(`unsupported grader type: ${graderType}`);
}

function runScenarioAttempt({
  scenario,
  workspaceRoot,
}) {
  const normalizedScenario = ensurePlainObject(scenario, "scenario");
  const cwd = path.resolve(
    workspaceRoot,
    normalizedScenario.cwd ?? ".",
  );
  const result = spawnSync(
    ensureNonEmptyString(normalizedScenario.command, "scenario.command"),
    ensureArray(normalizedScenario.args ?? [], "scenario.args").map((arg, index) =>
      ensureNonEmptyString(arg, `scenario.args[${index}]`)),
    {
      cwd,
      encoding: "utf8",
    },
  );
  const stdout = result.stdout?.trim() ?? "";
  const stderr = result.stderr?.trim() ?? "";
  const attempt = {
    cwd,
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    stderr,
    stdout,
    stdout_json: tryParseJson(stdout),
  };
  const graders = ensureArray(normalizedScenario.graders ?? [], "scenario.graders");
  const evaluations = graders.map((grader) => gradeAttempt(grader, attempt));

  return {
    ...attempt,
    grader_results: evaluations,
    passed: evaluations.every((evaluation) => evaluation.passed),
  };
}

function normalizeHealthAssets(healthAssets = []) {
  return ensureArray(healthAssets, "scenario.health_assets").map((asset, index) => {
    const normalizedAsset = ensurePlainObject(asset, `scenario.health_assets[${index}]`);

    return Object.freeze({
      asset_id: ensureNonEmptyString(
        normalizedAsset.asset_id ?? normalizedAsset.assetId,
        `scenario.health_assets[${index}].asset_id`,
      ),
      asset_kind: ensureNonEmptyString(
        normalizedAsset.asset_kind ?? normalizedAsset.assetKind,
        `scenario.health_assets[${index}].asset_kind`,
      ),
    });
  });
}

function normalizeOutputPath(suite, suitePath, workspaceRoot) {
  const explicitOutputPath = suite.outputPath ?? suite.output_path ?? null;
  if (explicitOutputPath) {
    return path.resolve(workspaceRoot, explicitOutputPath);
  }

  const suiteFileName = path.basename(suitePath, path.extname(suitePath));
  return path.join(workspaceRoot, ".niis", "proofs", "evals", `${suiteFileName}.json`);
}

function normalizeAssetHealthOutputPath(suite, outputPath) {
  const explicitOutputPath = suite.assetHealthOutputPath ?? suite.asset_health_output_path ?? null;
  if (explicitOutputPath) {
    return path.resolve(path.dirname(outputPath), explicitOutputPath);
  }

  if (outputPath.endsWith(".json")) {
    return outputPath.replace(/\.json$/u, ".asset-health.json");
  }

  return `${outputPath}.asset-health.json`;
}

function deriveAssetHealthStatus(assetEntry) {
  if (assetEntry.failed_scenarios === 0) {
    return "healthy";
  }

  if (assetEntry.passed_scenarios === 0) {
    return "failing";
  }

  return "watch";
}

function createAssetHealthReport({
  generatedAt,
  outputPath,
  scenarioDefinitions,
  scenarioResults,
  suiteId,
}) {
  const assetMap = new Map();

  for (let index = 0; index < scenarioResults.length; index += 1) {
    const scenarioDefinition = scenarioDefinitions[index];
    const scenarioResult = scenarioResults[index];
    const healthAssets = normalizeHealthAssets(
      scenarioDefinition.health_assets ?? scenarioDefinition.healthAssets ?? [],
    );

    for (const asset of healthAssets) {
      const assetKey = `${asset.asset_kind}:${asset.asset_id}`;
      const existing = assetMap.get(assetKey) ?? {
        asset_id: asset.asset_id,
        asset_kind: asset.asset_kind,
        evidence_refs: [],
        failed_scenarios: 0,
        passed_scenarios: 0,
        scenario_refs: [],
      };

      existing.scenario_refs.push({
        pass_at_k: scenarioResult.pass_at_k,
        scenario_id: scenarioResult.id,
        status: scenarioResult.status,
      });
      existing.evidence_refs.push(`${suiteId}:${scenarioResult.id}`);

      if (scenarioResult.status === "PASS") {
        existing.passed_scenarios += 1;
      } else {
        existing.failed_scenarios += 1;
      }

      assetMap.set(assetKey, existing);
    }
  }

  const assets = [...assetMap.values()]
    .map((assetEntry) => {
      const status = deriveAssetHealthStatus(assetEntry);

      return Object.freeze({
        asset_id: assetEntry.asset_id,
        asset_kind: assetEntry.asset_kind,
        evidence_refs: Object.freeze(assetEntry.evidence_refs),
        failed_scenarios: assetEntry.failed_scenarios,
        passed_scenarios: assetEntry.passed_scenarios,
        scenario_refs: Object.freeze(assetEntry.scenario_refs),
        status: ensureEnumValue(status, ASSET_HEALTH_STATUSES, "asset_health.status"),
      });
    })
    .sort((left, right) =>
      `${left.asset_kind}:${left.asset_id}`.localeCompare(`${right.asset_kind}:${right.asset_id}`));

  return Object.freeze({
    assets: Object.freeze(assets),
    generated_at: generatedAt,
    output_path: outputPath,
    source_suite_id: suiteId,
    summary: {
      failing: assets.filter((asset) => asset.status === "failing").length,
      healthy: assets.filter((asset) => asset.status === "healthy").length,
      total: assets.length,
      watch: assets.filter((asset) => asset.status === "watch").length,
    },
  });
}

function runScenarioSuite({
  suitePath = path.join("evals", "scenarios", "proof-regression-suite.json"),
  workspaceRoot = process.cwd(),
} = {}) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedSuitePath = path.resolve(normalizedWorkspaceRoot, suitePath);
  const suite = ensurePlainObject(readJson(resolvedSuitePath), "suite");
  const generatedAt = new Date().toISOString();
  const suiteId = ensureNonEmptyString(suite.suite_id ?? suite.suiteId ?? "eval-suite", "suite.suite_id");
  const scenarios = ensureArray(suite.scenarios, "suite.scenarios");
  const scenarioResults = scenarios.map((scenario) => {
    const normalizedScenario = ensurePlainObject(scenario, "scenario");
    const attempts = Number(normalizedScenario.attempts ?? 1);
    const attemptResults = [];

    for (let index = 0; index < attempts; index += 1) {
      attemptResults.push(runScenarioAttempt({
        scenario: normalizedScenario,
        workspaceRoot: normalizedWorkspaceRoot,
      }));
    }

    const passedAttempts = attemptResults.filter((attempt) => attempt.passed).length;
    const passAtK = passedAttempts > 0 ? 1 : 0;

    return {
      attempts,
      description: normalizedScenario.description ?? "",
      id: ensureNonEmptyString(normalizedScenario.id, "scenario.id"),
      pass_at_k: passAtK,
      passed_attempts: passedAttempts,
      status: passAtK === 1 ? "PASS" : "FAIL",
      attempt_results: attemptResults,
    };
  });
  const outputPath = normalizeOutputPath(suite, resolvedSuitePath, normalizedWorkspaceRoot);
  const assetHealthOutputPath = normalizeAssetHealthOutputPath(suite, outputPath);
  const assetHealth = createAssetHealthReport({
    generatedAt,
    outputPath: assetHealthOutputPath,
    scenarioDefinitions: scenarios,
    scenarioResults,
    suiteId,
  });
  const result = {
    asset_health: assetHealth,
    asset_health_output_path: assetHealthOutputPath,
    generated_at: generatedAt,
    ok: scenarioResults.every((scenario) => scenario.status === "PASS"),
    output_path: outputPath,
    scenarios: scenarioResults,
    suite_id: suiteId,
    summary: {
      failed: scenarioResults.filter((scenario) => scenario.status !== "PASS").length,
      passed: scenarioResults.filter((scenario) => scenario.status === "PASS").length,
      total: scenarioResults.length,
    },
    workspace_root: normalizedWorkspaceRoot,
  };

  writeJson(outputPath, result);
  writeJson(assetHealthOutputPath, assetHealth);

  if (!result.ok) {
    throw new EvalHarnessError(
      "scenario suite failed; inspect attempt outputs and grader results",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const suitePath = process.argv[2] ?? path.join("evals", "scenarios", "proof-regression-suite.json");

  try {
    console.log(JSON.stringify(runScenarioSuite({
      suitePath,
    }), null, 2));
  } catch (error) {
    if (error instanceof EvalHarnessError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  EvalHarnessError,
  runScenarioSuite,
};
