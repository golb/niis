import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_RUN_LOG_INLINE_BYTES = 4096;
const RUN_LOG_ARTIFACT_DIRECTORY = "run-logs";
const RUN_LOG_OUTPUT_KINDS = Object.freeze(["json", "text"]);
const RUN_LOG_STORAGES = Object.freeze(["inline", "ref"]);

class RunLogStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunLogStorageError";
  }
}

function clone(value) {
  return structuredClone(value);
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RunLogStorageError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePositiveInteger(value, label) {
  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    throw new RunLogStorageError(`${label} must be a positive integer`);
  }

  return normalizedValue;
}

function ensureOutputKind(value, label) {
  const normalizedValue = ensureNonEmptyString(value, label);

  if (!RUN_LOG_OUTPUT_KINDS.includes(normalizedValue)) {
    throw new RunLogStorageError(
      `${label} must be one of ${RUN_LOG_OUTPUT_KINDS.join(", ")}`,
    );
  }

  return normalizedValue;
}

function ensureRunLogStorage(value, label) {
  const normalizedValue = ensureNonEmptyString(value, label);

  if (!RUN_LOG_STORAGES.includes(normalizedValue)) {
    throw new RunLogStorageError(
      `${label} must be one of ${RUN_LOG_STORAGES.join(", ")}`,
    );
  }

  return normalizedValue;
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function sanitizeRunLogIdentifier(value) {
  return ensureNonEmptyString(value, "runId")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "") || "run-log";
}

function assertPathWithinRoot(rootPath, targetPath, label) {
  const canonicalRoot = path.resolve(rootPath);
  const canonicalTarget = path.resolve(targetPath);
  const relativePath = path.relative(canonicalRoot, canonicalTarget);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new RunLogStorageError(`${label} escapes the state root: ${canonicalTarget}`);
  }

  return canonicalTarget;
}

function serializeRunLogOutput(rawOutput) {
  if (typeof rawOutput === "string") {
    return Object.freeze({
      bytes: Buffer.byteLength(rawOutput),
      extension: ".log",
      kind: "text",
      serialized: rawOutput,
      value: rawOutput,
    });
  }

  const normalizedValue = rawOutput ?? {};
  const serialized = JSON.stringify(normalizedValue);

  return Object.freeze({
    bytes: Buffer.byteLength(serialized),
    extension: ".json",
    kind: "json",
    serialized,
    value: clone(normalizedValue),
  });
}

function createRunLogDescriptor({
  rawOutput,
  storage = "inline",
  ref = null,
} = {}) {
  const serialized = serializeRunLogOutput(rawOutput);

  return Object.freeze({
    bytes: serialized.bytes,
    ref: ref === null ? null : ensureNonEmptyString(ref, "run log ref"),
    sha256: createHash("sha256").update(serialized.serialized).digest("hex"),
    storage: ensureRunLogStorage(storage, "run log storage"),
  });
}

function createRunLogPaths(stateRoot, runId) {
  const normalizedStateRoot = path.resolve(ensureNonEmptyString(stateRoot, "stateRoot"));
  const artifactsRoot = path.join(normalizedStateRoot, "artifacts");
  const runLogsRoot = path.join(artifactsRoot, RUN_LOG_ARTIFACT_DIRECTORY);
  const sanitizedRunId = sanitizeRunLogIdentifier(runId);

  return Object.freeze({
    artifactsRoot,
    jsonArtifactPath: path.join(runLogsRoot, `${sanitizedRunId}.json`),
    runLogsRoot,
    stateRoot: normalizedStateRoot,
    textArtifactPath: path.join(runLogsRoot, `${sanitizedRunId}.log`),
  });
}

function createRunLogRef(stateRoot, artifactPath) {
  const normalizedStateRoot = path.resolve(ensureNonEmptyString(stateRoot, "stateRoot"));
  const normalizedArtifactPath = assertPathWithinRoot(
    normalizedStateRoot,
    artifactPath,
    "run log artifact path",
  );
  const relativePath = toPosixPath(path.relative(normalizedStateRoot, normalizedArtifactPath));

  return `${path.basename(normalizedStateRoot)}/${relativePath}`;
}

function resolveRunLogRefPath(stateRoot, ref) {
  const normalizedStateRoot = path.resolve(ensureNonEmptyString(stateRoot, "stateRoot"));
  const normalizedRef = ensureNonEmptyString(ref, "run log ref");
  const stateRootPrefix = `${path.basename(normalizedStateRoot)}/`;
  const normalizedRelativeRef = normalizedRef.startsWith(stateRootPrefix)
    ? normalizedRef.slice(stateRootPrefix.length)
    : normalizedRef;

  return assertPathWithinRoot(
    normalizedStateRoot,
    path.resolve(normalizedStateRoot, normalizedRelativeRef),
    "run log ref path",
  );
}

function verifyRunLogReference({
  stateRoot,
  ref,
  expectedSha256 = null,
} = {}) {
  try {
    const artifactPath = resolveRunLogRefPath(stateRoot, ref);

    if (!fs.existsSync(artifactPath)) {
      return Object.freeze({
        artifact_path: artifactPath,
        exists: false,
        ok: false,
        ref: ensureNonEmptyString(ref, "run log ref"),
        sha256: null,
      });
    }

    const serialized = fs.readFileSync(artifactPath, "utf8");
    const sha256 = createHash("sha256").update(serialized).digest("hex");

    return Object.freeze({
      artifact_path: artifactPath,
      exists: true,
      ok: expectedSha256 ? sha256 === expectedSha256 : true,
      ref: ensureNonEmptyString(ref, "run log ref"),
      sha256,
    });
  } catch {
    return Object.freeze({
      artifact_path: null,
      exists: false,
      ok: false,
      ref: typeof ref === "string" ? ref : null,
      sha256: null,
    });
  }
}

function deserializeRunLogOutput(serialized, kind) {
  const normalizedKind = ensureOutputKind(kind, "run log output kind");

  if (normalizedKind === "json") {
    return JSON.parse(serialized);
  }

  return serialized;
}

function normalizeRunLogRecord(record, label = "runLog") {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new RunLogStorageError(`${label} must be a plain object`);
  }

  const rawOutput = record.raw_output ?? null;
  const outputKind = record.raw_output_kind
    ?? (typeof rawOutput === "string" ? "text" : "json");
  const runLog = record.run_log && typeof record.run_log === "object" && !Array.isArray(record.run_log)
    ? record.run_log
    : {};

  return Object.freeze({
    raw_output: rawOutput === null ? null : clone(rawOutput),
    raw_output_kind: ensureOutputKind(outputKind, `${label}.raw_output_kind`),
    raw_output_ref:
      record.raw_output_ref === null || record.raw_output_ref === undefined
        ? null
        : ensureNonEmptyString(record.raw_output_ref, `${label}.raw_output_ref`),
    run_id: ensureNonEmptyString(record.run_id, `${label}.run_id`),
    run_log: Object.freeze({
      bytes: Number(runLog.bytes ?? 0),
      ref: runLog.ref === null || runLog.ref === undefined ? null : String(runLog.ref),
      sha256: typeof runLog.sha256 === "string" ? runLog.sha256 : "",
      storage: typeof runLog.storage === "string" ? runLog.storage : "inline",
    }),
  });
}

function createStoredRunLogRecord({
  inlineBytes = DEFAULT_RUN_LOG_INLINE_BYTES,
  rawOutput,
  runId,
  stateRoot = null,
} = {}) {
  const normalizedRunId = ensureNonEmptyString(runId, "runId");
  const normalizedInlineBytes = ensurePositiveInteger(inlineBytes, "inlineBytes");
  const serialized = serializeRunLogOutput(rawOutput);

  if (serialized.bytes <= normalizedInlineBytes || !stateRoot) {
    return Object.freeze({
      raw_output: clone(serialized.value),
      raw_output_kind: serialized.kind,
      raw_output_ref: null,
      run_id: normalizedRunId,
      run_log: createRunLogDescriptor({
        rawOutput: serialized.value,
        ref: null,
        storage: "inline",
      }),
    });
  }

  const paths = createRunLogPaths(stateRoot, normalizedRunId);
  const artifactPath = serialized.kind === "json" ? paths.jsonArtifactPath : paths.textArtifactPath;
  const alternateArtifactPath = serialized.kind === "json" ? paths.textArtifactPath : paths.jsonArtifactPath;

  ensureDirectory(paths.runLogsRoot);
  fs.writeFileSync(artifactPath, serialized.serialized, "utf8");

  if (fs.existsSync(alternateArtifactPath)) {
    fs.rmSync(alternateArtifactPath, { force: true });
  }

  const ref = createRunLogRef(paths.stateRoot, artifactPath);

  return Object.freeze({
    raw_output: null,
    raw_output_kind: serialized.kind,
    raw_output_ref: ref,
    run_id: normalizedRunId,
    run_log: createRunLogDescriptor({
      rawOutput: serialized.value,
      ref,
      storage: "ref",
    }),
  });
}

function hydrateRunLogRecord(record, { stateRoot } = {}) {
  const normalizedRecord = normalizeRunLogRecord(record);

  if (normalizedRecord.raw_output !== null) {
    return clone(normalizedRecord);
  }

  if (!normalizedRecord.raw_output_ref) {
    return clone(normalizedRecord);
  }

  const artifactPath = resolveRunLogRefPath(stateRoot, normalizedRecord.raw_output_ref);

  if (!fs.existsSync(artifactPath)) {
    throw new RunLogStorageError(`run log artifact is missing: ${artifactPath}`);
  }

  const serialized = fs.readFileSync(artifactPath, "utf8");
  const sha256 = createHash("sha256").update(serialized).digest("hex");

  if (normalizedRecord.run_log.sha256 !== sha256) {
    throw new RunLogStorageError(
      `run log integrity mismatch for ${normalizedRecord.run_id}: expected ${normalizedRecord.run_log.sha256}, got ${sha256}`,
    );
  }

  return {
    ...clone(normalizedRecord),
    raw_output: deserializeRunLogOutput(serialized, normalizedRecord.raw_output_kind),
  };
}

function collectRunLogStorageChecks(stateRoot) {
  const normalizedStateRoot = path.resolve(ensureNonEmptyString(stateRoot, "stateRoot"));
  const artifactsRoot = path.join(normalizedStateRoot, "artifacts");
  const runLogsRoot = path.join(artifactsRoot, RUN_LOG_ARTIFACT_DIRECTORY);

  if (!fs.existsSync(normalizedStateRoot)) {
    return [{
      id: "run-log-store",
      status: "warning",
      summary: runLogsRoot,
      details: "Run `init` to scaffold the local run-log artifact store.",
    }];
  }

  return [
    {
      id: "artifacts-root",
      status: fs.existsSync(artifactsRoot) ? "ok" : "warning",
      summary: artifactsRoot,
      details: "The local artifacts root should exist under the state root.",
    },
    {
      id: "run-log-store",
      status: fs.existsSync(runLogsRoot) || fs.existsSync(artifactsRoot) ? "ok" : "warning",
      summary: runLogsRoot,
      details: "The run-log artifact directory is created on first file-backed log persistence.",
    },
  ];
}

export {
  DEFAULT_RUN_LOG_INLINE_BYTES,
  RUN_LOG_ARTIFACT_DIRECTORY,
  RunLogStorageError,
  collectRunLogStorageChecks,
  createRunLogDescriptor,
  createRunLogPaths,
  createStoredRunLogRecord,
  hydrateRunLogRecord,
  normalizeRunLogRecord,
  resolveRunLogRefPath,
  serializeRunLogOutput,
  verifyRunLogReference,
};
