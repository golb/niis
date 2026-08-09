import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseAgentEntity } from "../schemas/agent.js";

const LOCAL_SECRET_STORE_FILENAME = "store.json";
const LOCAL_SECRET_MASTER_KEY_FILENAME = "master.key";
const LOCAL_SECRET_STORE_SCHEMA_VERSION = 1;
const LOCAL_SECRET_ALGORITHM = "aes-256-gcm";
const SENSITIVE_ENV_KEY_PATTERN =
  /(?:^|_)(?:api[_-]?key|secret|token|password|authorization)(?:$|_)/i;
const PLAINTEXT_PERSISTENCE_MODES = ["reject", "allow"];

class LocalSecretStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalSecretStoreError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LocalSecretStoreError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new LocalSecretStoreError(`${label} must be a plain object`);
  }

  return value;
}

function toIsoTimestamp(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function ensurePlaintextPersistenceMode(value) {
  const normalizedValue = value ?? "reject";

  if (!PLAINTEXT_PERSISTENCE_MODES.includes(normalizedValue)) {
    throw new LocalSecretStoreError(
      `plaintext persistence mode must be one of ${PLAINTEXT_PERSISTENCE_MODES.join(", ")}`,
    );
  }

  return normalizedValue;
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function writePrivateFile(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function createSecretStorePaths(stateRoot) {
  const normalizedStateRoot = path.resolve(ensureNonEmptyString(stateRoot, "stateRoot"));
  const secretsRoot = path.join(normalizedStateRoot, "secrets");

  return Object.freeze({
    secretMasterKeyPath: path.join(secretsRoot, LOCAL_SECRET_MASTER_KEY_FILENAME),
    secretStorePath: path.join(secretsRoot, LOCAL_SECRET_STORE_FILENAME),
    secretsRoot,
    stateRoot: normalizedStateRoot,
  });
}

function sanitizeSecretRefSegment(value) {
  return ensureNonEmptyString(value, "secret ref segment")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "value";
}

function createLocalSecretRef({ segments = [] } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new LocalSecretStoreError("secret ref segments must be a non-empty array");
  }

  return `secret://local/${segments.map((segment, index) =>
    sanitizeSecretRefSegment(typeof segment === "string" ? segment : `segment-${index + 1}`),
  ).join("/")}`;
}

function createEmptySecretManifest(now = new Date()) {
  const timestamp = toIsoTimestamp(now);

  return {
    created_at: timestamp,
    schema_version: LOCAL_SECRET_STORE_SCHEMA_VERSION,
    secrets: {},
    updated_at: timestamp,
  };
}

function ensureSecretStoreFiles(paths, createIfMissing) {
  if (!fs.existsSync(paths.secretsRoot)) {
    if (!createIfMissing) {
      throw new LocalSecretStoreError(`secret store directory is missing: ${paths.secretsRoot}`);
    }

    ensureDirectory(paths.secretsRoot);
  }

  if (!fs.existsSync(paths.secretMasterKeyPath)) {
    if (!createIfMissing) {
      throw new LocalSecretStoreError(`secret master key is missing: ${paths.secretMasterKeyPath}`);
    }

    writePrivateFile(paths.secretMasterKeyPath, randomBytes(32));
  }

  if (!fs.existsSync(paths.secretStorePath)) {
    if (!createIfMissing) {
      throw new LocalSecretStoreError(`secret store file is missing: ${paths.secretStorePath}`);
    }

    writePrivateFile(
      paths.secretStorePath,
      `${JSON.stringify(createEmptySecretManifest(), null, 2)}\n`,
    );
  }
}

function readMasterKey(secretMasterKeyPath) {
  const key = fs.readFileSync(secretMasterKeyPath);

  if (key.length !== 32) {
    throw new LocalSecretStoreError("local secret master key must be 32 bytes");
  }

  return key;
}

function readSecretManifest(secretStorePath) {
  const manifest = JSON.parse(fs.readFileSync(secretStorePath, "utf8"));

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new LocalSecretStoreError("secret store manifest must be a plain object");
  }

  if (manifest.schema_version !== LOCAL_SECRET_STORE_SCHEMA_VERSION) {
    throw new LocalSecretStoreError(
      `unsupported secret store schema version ${manifest.schema_version}`,
    );
  }

  if (!manifest.secrets || typeof manifest.secrets !== "object" || Array.isArray(manifest.secrets)) {
    throw new LocalSecretStoreError("secret store manifest secrets must be a plain object");
  }

  return manifest;
}

function writeSecretManifest(secretStorePath, manifest) {
  writePrivateFile(secretStorePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function encryptSecretValue(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(LOCAL_SECRET_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(ensureNonEmptyString(value, "secret value"), "utf8"),
    cipher.final(),
  ]);

  return {
    auth_tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
  };
}

function decryptSecretValue(record, key) {
  const decipher = createDecipheriv(
    LOCAL_SECRET_ALGORITHM,
    key,
    Buffer.from(record.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(record.auth_tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function normalizeSecretMetadata(metadata = {}) {
  return structuredClone(ensurePlainObject(metadata, "secret metadata"));
}

function buildStoredSecretRecord({
  currentRecord = null,
  metadata = {},
  now = new Date(),
  ref,
  value,
  key,
}) {
  const timestamp = toIsoTimestamp(now);

  return {
    ...encryptSecretValue(value, key),
    created_at: currentRecord?.created_at ?? timestamp,
    metadata: normalizeSecretMetadata(metadata),
    ref: ensureNonEmptyString(ref, "secret ref"),
    updated_at: timestamp,
  };
}

function readSecretRecord(secretStorePath, secretRef) {
  const manifest = readSecretManifest(secretStorePath);
  return manifest.secrets?.[secretRef] ?? null;
}

function listSecretMetadata(secretStorePath) {
  const manifest = readSecretManifest(secretStorePath);

  return Object.values(manifest.secrets)
    .map((record) => ({
      created_at: record.created_at,
      metadata: structuredClone(record.metadata ?? {}),
      ref: record.ref,
      updated_at: record.updated_at,
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

function createLocalSecretStore({
  stateRoot,
  createIfMissing = true,
} = {}) {
  const paths = createSecretStorePaths(stateRoot);
  ensureSecretStoreFiles(paths, createIfMissing);

  return Object.freeze({
    get paths() {
      return paths;
    },
    getSecret(secretRef) {
      const normalizedSecretRef = ensureNonEmptyString(secretRef, "secret ref");
      const record = readSecretRecord(paths.secretStorePath, normalizedSecretRef);

      if (!record) {
        return undefined;
      }

      return decryptSecretValue(record, readMasterKey(paths.secretMasterKeyPath));
    },
    hasSecret(secretRef) {
      return readSecretRecord(paths.secretStorePath, ensureNonEmptyString(secretRef, "secret ref")) !== null;
    },
    listSecrets() {
      return listSecretMetadata(paths.secretStorePath);
    },
    putSecret({
      metadata = {},
      now = new Date(),
      ref,
      value,
    } = {}) {
      const normalizedSecretRef = ensureNonEmptyString(ref, "secret ref");
      const manifest = readSecretManifest(paths.secretStorePath);
      const nextRecord = buildStoredSecretRecord({
        currentRecord: manifest.secrets[normalizedSecretRef] ?? null,
        key: readMasterKey(paths.secretMasterKeyPath),
        metadata,
        now,
        ref: normalizedSecretRef,
        value,
      });

      manifest.secrets[normalizedSecretRef] = nextRecord;
      manifest.updated_at = toIsoTimestamp(now);
      writeSecretManifest(paths.secretStorePath, manifest);

      return {
        created_at: nextRecord.created_at,
        metadata: structuredClone(nextRecord.metadata),
        ref: nextRecord.ref,
        updated_at: nextRecord.updated_at,
      };
    },
    resolve(secretRef) {
      return this.getSecret(secretRef);
    },
  });
}

function isSensitiveEnvBindingKey(key) {
  return SENSITIVE_ENV_KEY_PATTERN.test(ensureNonEmptyString(key, "env binding key"));
}

function materializeAgentEnvConfig(agent, {
  plaintextPersistence = "reject",
} = {}) {
  const normalizedAgent = parseAgentEntity(agent);
  const persistenceMode = ensurePlaintextPersistenceMode(plaintextPersistence);
  const config = {};

  for (const binding of normalizedAgent.env_bindings) {
    if (binding.type === "secret_ref") {
      config[binding.key] = {
        secret_ref: binding.value,
      };
      continue;
    }

    if (persistenceMode === "reject" && isSensitiveEnvBindingKey(binding.key)) {
      throw new LocalSecretStoreError(
        `agent ${normalizedAgent.id} persists sensitive env binding ${binding.key} as plaintext`,
      );
    }

    config[binding.key] = binding.value;
  }

  return Object.freeze(config);
}

function persistSensitiveAgentEnvBindings(agent, {
  now = new Date(),
  plaintextPersistence = "reject",
  secretStore,
} = {}) {
  const normalizedAgent = parseAgentEntity(agent);
  const persistenceMode = ensurePlaintextPersistenceMode(plaintextPersistence);

  if (!secretStore || typeof secretStore.putSecret !== "function") {
    if (persistenceMode === "reject" && normalizedAgent.env_bindings.some((binding) =>
      binding.type === "plain" && isSensitiveEnvBindingKey(binding.key)
    )) {
      throw new LocalSecretStoreError(
        `secretStore.putSecret is required to persist sensitive env bindings for agent ${normalizedAgent.id}`,
      );
    }

    return normalizedAgent;
  }

  let didRewrite = false;
  const normalizedBindings = normalizedAgent.env_bindings.map((binding) => {
    if (binding.type !== "plain" || !isSensitiveEnvBindingKey(binding.key)) {
      return binding;
    }

    const secretRef = createLocalSecretRef({
      segments: ["agent", normalizedAgent.id, binding.key],
    });

    secretStore.putSecret({
      metadata: {
        env_key: binding.key,
        owner_id: normalizedAgent.id,
        owner_kind: "agent",
      },
      now,
      ref: secretRef,
      value: binding.value,
    });

    didRewrite = true;

    return {
      key: binding.key,
      type: "secret_ref",
      value: secretRef,
    };
  });

  if (!didRewrite) {
    return normalizedAgent;
  }

  return parseAgentEntity({
    ...normalizedAgent,
    env_bindings: normalizedBindings,
    updated_at: toIsoTimestamp(now),
  });
}

function collectSecretStoreChecks(stateRoot) {
  const paths = createSecretStorePaths(stateRoot);

  if (!fs.existsSync(paths.stateRoot)) {
    return [
      {
        id: "secret-store",
        status: "warning",
        summary: paths.secretsRoot,
        details: "Run `init` to scaffold the encrypted local secret store.",
      },
    ];
  }

  const checks = [
    {
      id: "secret-store-dir",
      status: fs.existsSync(paths.secretsRoot) ? "ok" : "warning",
      summary: paths.secretsRoot,
      details: "The local secret store directory should exist under the state root.",
    },
    {
      id: "secret-store-key",
      status: fs.existsSync(paths.secretMasterKeyPath) ? "ok" : "warning",
      summary: paths.secretMasterKeyPath,
      details: "The local secret store master key should exist and remain outside committed artifacts.",
    },
    {
      id: "secret-store-file",
      status: fs.existsSync(paths.secretStorePath) ? "ok" : "warning",
      summary: paths.secretStorePath,
      details: "The encrypted local secret store manifest should exist once init has completed.",
    },
  ];

  if (!fs.existsSync(paths.secretMasterKeyPath) || !fs.existsSync(paths.secretStorePath)) {
    return checks;
  }

  try {
    readMasterKey(paths.secretMasterKeyPath);
    readSecretManifest(paths.secretStorePath);
    checks.push({
      id: "secret-store-health",
      status: "ok",
      summary: "encrypted local secret store is readable",
      details: "Master key and manifest parse successfully.",
    });
  } catch (error) {
    checks.push({
      id: "secret-store-health",
      status: "error",
      summary: error.message,
      details: "Repair or restore the local secret store before using secret refs.",
    });
  }

  return checks;
}

export {
  LOCAL_SECRET_MASTER_KEY_FILENAME,
  LOCAL_SECRET_STORE_FILENAME,
  LOCAL_SECRET_STORE_SCHEMA_VERSION,
  LocalSecretStoreError,
  collectSecretStoreChecks,
  createLocalSecretRef,
  createLocalSecretStore,
  createSecretStorePaths,
  isSensitiveEnvBindingKey,
  materializeAgentEnvConfig,
  persistSensitiveAgentEnvBindings,
};
