import { parseAdapterResponse } from "../schemas/adapter-response.js";

class AdapterContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdapterContractError";
  }
}

const ADAPTER_PROTOCOL_TYPES = ["local_cli", "mcp_server", "cursor_bridge", "in_memory"];
const DIAGNOSTIC_CHECK_STATUSES = ["PASS", "FAIL", "WARN"];
const CALLBACK_CHANNEL_NAMES = [
  "onProgress",
  "onBlocker",
  "onApprovalRequest",
  "onContextRequest",
];

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AdapterContractError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureUniqueStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new AdapterContractError(`${label} must be an array`);
  }

  const normalizedValues = values.map((value, index) =>
    ensureNonEmptyString(value, `${label}[${index}]`),
  );

  return [...new Set(normalizedValues)];
}

function ensureProtocolType(protocolType) {
  const normalizedProtocolType = ensureNonEmptyString(protocolType, "protocolType");

  if (!ADAPTER_PROTOCOL_TYPES.includes(normalizedProtocolType)) {
    throw new AdapterContractError(
      `unsupported adapter protocol type: ${normalizedProtocolType}`,
    );
  }

  return normalizedProtocolType;
}

function createEnvBindingDeclaration({
  key,
  description,
  sensitive = false,
}) {
  return Object.freeze({
    description: ensureNonEmptyString(description, `env binding ${key} description`),
    key: ensureNonEmptyString(key, "env binding key"),
    sensitive: Boolean(sensitive),
  });
}

function normalizeEnvBindings({
  required = [],
  optional = [],
} = {}) {
  const normalizeList = (bindings, label) => {
    if (!Array.isArray(bindings)) {
      throw new AdapterContractError(`${label} env bindings must be an array`);
    }

    return bindings.map((binding, index) =>
      createEnvBindingDeclaration({
        key: binding?.key ?? binding?.name ?? binding?.env,
        description: binding?.description ?? `${label} env binding ${index}`,
        sensitive: binding?.sensitive ?? false,
      }),
    );
  };

  const normalizedRequired = normalizeList(required, "required");
  const normalizedOptional = normalizeList(optional, "optional");
  const duplicateKeys = normalizedRequired
    .map((binding) => binding.key)
    .filter((key) => normalizedOptional.some((binding) => binding.key === key));

  if (duplicateKeys.length > 0) {
    throw new AdapterContractError(
      `env binding keys must be unique across required/optional declarations: ${[...new Set(duplicateKeys)].join(", ")}`,
    );
  }

  return Object.freeze({
    optional: normalizedOptional,
    required: normalizedRequired,
  });
}

function createCapabilityProfile({
  adapterKind = "generic",
  protocolType = "local_cli",
  operations = [],
  permissions = [],
  toolFamilies = [],
  privilegedOperations = [],
  allow = {},
  deny = {},
} = {}) {
  const normalizedAllow = {
    sensitivePathClasses: ensureUniqueStringArray(
      allow.sensitivePathClasses ?? [],
      "allow.sensitivePathClasses",
    ),
    toolFamilies: ensureUniqueStringArray(allow.toolFamilies ?? [], "allow.toolFamilies"),
  };
  const normalizedDeny = {
    operations: ensureUniqueStringArray(deny.operations ?? [], "deny.operations"),
    sensitivePathClasses: ensureUniqueStringArray(
      deny.sensitivePathClasses ?? [],
      "deny.sensitivePathClasses",
    ),
    toolFamilies: ensureUniqueStringArray(deny.toolFamilies ?? [], "deny.toolFamilies"),
  };

  return Object.freeze({
    adapter_kind: ensureNonEmptyString(adapterKind, "adapterKind"),
    allow: normalizedAllow,
    deny: normalizedDeny,
    operations: ensureUniqueStringArray(operations, "operations"),
    permissions: ensureUniqueStringArray(permissions, "permissions"),
    privileged_operations: ensureUniqueStringArray(
      privilegedOperations,
      "privilegedOperations",
    ),
    protocol_type: ensureProtocolType(protocolType),
    tool_families: ensureUniqueStringArray(toolFamilies, "toolFamilies"),
  });
}

function normalizeCapabilityProfile(capabilityProfile) {
  if (capabilityProfile?.protocol_type) {
    return capabilityProfile;
  }

  return createCapabilityProfile(capabilityProfile);
}

function createRuntimeToolSpec({
  name,
  description,
  requiredCapabilities = [],
  inputSchema = {},
}) {
  return Object.freeze({
    description: ensureNonEmptyString(description, `runtime tool ${name} description`),
    input_schema: inputSchema && typeof inputSchema === "object" ? inputSchema : {},
    name: ensureNonEmptyString(name, "runtime tool name"),
    required_capabilities: ensureUniqueStringArray(
      requiredCapabilities,
      "runtime tool requiredCapabilities",
    ),
  });
}

function normalizeRuntimeTools(runtimeTools = []) {
  if (!Array.isArray(runtimeTools)) {
    throw new AdapterContractError("runtime tools must be an array");
  }

  const normalizedRuntimeTools = runtimeTools.map((runtimeTool, index) =>
    createRuntimeToolSpec({
      name: runtimeTool?.name,
      description: runtimeTool?.description ?? `runtime tool ${index}`,
      requiredCapabilities: runtimeTool?.required_capabilities ?? runtimeTool?.requiredCapabilities ?? [],
      inputSchema: runtimeTool?.input_schema ?? runtimeTool?.inputSchema ?? {},
    }),
  );
  const duplicateNames = normalizedRuntimeTools
    .map((runtimeTool) => runtimeTool.name)
    .filter((name, index, values) => values.indexOf(name) !== index);

  if (duplicateNames.length > 0) {
    throw new AdapterContractError(
      `runtime tool names must be unique: ${[...new Set(duplicateNames)].join(", ")}`,
    );
  }

  return Object.freeze(normalizedRuntimeTools);
}

function createCallbackChannel(callbacks = {}) {
  const channel = {};

  for (const callbackName of CALLBACK_CHANNEL_NAMES) {
    const callback = callbacks[callbackName];
    channel[callbackName] = typeof callback === "function" ? callback : async () => undefined;
  }

  return Object.freeze(channel);
}

function createSessionCodec({
  serialize = (sessionParams) => sessionParams,
  deserialize = (stored) => stored,
  compactionHandoff = (sessions) =>
    sessions.map((session) => JSON.stringify(session)).join("\n"),
} = {}) {
  if (typeof serialize !== "function") {
    throw new AdapterContractError("session codec serialize must be a function");
  }

  if (typeof deserialize !== "function") {
    throw new AdapterContractError("session codec deserialize must be a function");
  }

  if (typeof compactionHandoff !== "function") {
    throw new AdapterContractError("session codec compactionHandoff must be a function");
  }

  return Object.freeze({
    compactionHandoff,
    deserialize,
    serialize,
  });
}

function serializeAdapterSession(sessionCodec, sessionParams) {
  return sessionCodec.serialize(sessionParams);
}

function deserializeAdapterSession(sessionCodec, stored) {
  return sessionCodec.deserialize(stored);
}

function renderSessionCompactionHandoff(sessionCodec, sessions) {
  return sessionCodec.compactionHandoff(sessions);
}

function resolveSecretReference(secretRef, secretStore) {
  const normalizedSecretRef = ensureNonEmptyString(secretRef, "secret_ref");

  if (typeof secretStore === "function") {
    return secretStore(normalizedSecretRef);
  }

  if (secretStore && typeof secretStore === "object") {
    return secretStore[normalizedSecretRef];
  }

  return undefined;
}

function resolveEnvValue(key, config, secretStore) {
  const value = config?.[key];

  if (value && typeof value === "object" && !Array.isArray(value) && value.secret_ref) {
    return resolveSecretReference(value.secret_ref, secretStore);
  }

  return value;
}

function resolveAdapterEnv({
  config = {},
  secretStore = null,
  requiredEnv = [],
  optionalEnv = [],
}) {
  const normalizedBindings = normalizeEnvBindings({
    optional: optionalEnv,
    required: requiredEnv,
  });
  const envMap = {};
  const missing = [];

  for (const binding of normalizedBindings.required) {
    const resolvedValue = resolveEnvValue(binding.key, config, secretStore);

    if (resolvedValue === undefined || resolvedValue === null || resolvedValue === "") {
      missing.push(binding.key);
      continue;
    }

    envMap[binding.key] = String(resolvedValue);
  }

  for (const binding of normalizedBindings.optional) {
    const resolvedValue = resolveEnvValue(binding.key, config, secretStore);

    if (resolvedValue !== undefined && resolvedValue !== null && resolvedValue !== "") {
      envMap[binding.key] = String(resolvedValue);
    }
  }

  if (missing.length > 0) {
    throw new AdapterContractError(
      `missing required adapter env bindings: ${missing.join(", ")}`,
    );
  }

  return envMap;
}

function createCapabilityDeniedResponse({
  adapterId = "adapter",
  operation,
  toolFamily = null,
  sensitivePathClass = null,
  reason,
}) {
  const operationLabel = ensureNonEmptyString(operation, "denied operation");
  const deniedReason = ensureNonEmptyString(reason, "deny reason");
  const details = [
    `adapter ${adapterId} denied operation ${operationLabel}`,
    toolFamily ? `tool family ${toolFamily}` : null,
    sensitivePathClass ? `path class ${sensitivePathClass}` : null,
  ].filter(Boolean).join(" / ");

  return parseAdapterResponse({
    status: "ERROR",
    summary: `Capability denied: ${details}`,
    next_actions: [
      "Select an adapter whose declared capabilities allow the requested operation.",
      "Grant the required capability or allowlist entry before retrying.",
    ],
    artifacts: [],
    cost: null,
    completion_signal: null,
    self_assessment: null,
    error: {
      root_cause: deniedReason,
      category: "auth",
      retry_safe: false,
      retry_instruction: null,
      stop_condition: "adapter capability or allow/deny envelope blocks this operation",
      escalation_hint: "Adjust adapter permissions or routing policy before retrying.",
    },
  });
}

function evaluateCapabilityAccess({
  capabilities,
  operation,
  toolFamily = null,
  sensitivePathClass = null,
}) {
  const normalizedOperation = ensureNonEmptyString(operation, "operation");
  const capabilityProfile = capabilities?.protocol_type
    ? capabilities
    : normalizeCapabilityProfile(capabilities);

  if (!capabilityProfile.operations.includes(normalizedOperation)) {
    return {
      allowed: false,
      reason: `operation ${normalizedOperation} is not declared by the adapter`,
    };
  }

  if (capabilityProfile.deny.operations.includes(normalizedOperation)) {
    return {
      allowed: false,
      reason: `operation ${normalizedOperation} is explicitly denied`,
    };
  }

  if (
    capabilityProfile.privileged_operations.includes(normalizedOperation) &&
    !capabilityProfile.permissions.includes(normalizedOperation)
  ) {
    return {
      allowed: false,
      reason: `privileged operation ${normalizedOperation} is missing a matching permission grant`,
    };
  }

  if (toolFamily) {
    if (capabilityProfile.deny.toolFamilies.includes(toolFamily)) {
      return {
        allowed: false,
        reason: `tool family ${toolFamily} is explicitly denied`,
      };
    }

    if (
      capabilityProfile.allow.toolFamilies.length > 0 &&
      !capabilityProfile.allow.toolFamilies.includes(toolFamily)
    ) {
      return {
        allowed: false,
        reason: `tool family ${toolFamily} is outside the adapter allowlist`,
      };
    }
  }

  if (sensitivePathClass) {
    if (capabilityProfile.deny.sensitivePathClasses.includes(sensitivePathClass)) {
      return {
        allowed: false,
        reason: `sensitive path class ${sensitivePathClass} is explicitly denied`,
      };
    }

    if (
      capabilityProfile.allow.sensitivePathClasses.length > 0 &&
      !capabilityProfile.allow.sensitivePathClasses.includes(sensitivePathClass)
    ) {
      return {
        allowed: false,
        reason: `sensitive path class ${sensitivePathClass} is outside the adapter allowlist`,
      };
    }
  }

  return {
    allowed: true,
    reason: null,
  };
}

function assertAdapterImplementation(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new AdapterContractError("adapter implementation must be an object");
  }

  for (const methodName of ["execute", "test", "capabilities", "normalize"]) {
    if (typeof adapter[methodName] !== "function") {
      throw new AdapterContractError(`adapter is missing required method ${methodName}()`);
    }
  }

  for (const methodName of ["requiredEnv", "optionalEnv", "runtimeTools", "callbackChannel", "sessionCodec"]) {
    if (adapter[methodName] !== undefined && typeof adapter[methodName] !== "function") {
      throw new AdapterContractError(`adapter optional method ${methodName}() must be a function when provided`);
    }
  }

  return adapter;
}

function normalizeAdapterResult(adapter, rawResult) {
  assertAdapterImplementation(adapter);
  return parseAdapterResponse(adapter.normalize(rawResult));
}

function createDiagnosticCheck({
  name,
  status,
  message,
}) {
  const normalizedStatus = ensureNonEmptyString(status, `diagnostic status for ${name}`);

  if (!DIAGNOSTIC_CHECK_STATUSES.includes(normalizedStatus)) {
    throw new AdapterContractError(`unsupported diagnostic check status: ${normalizedStatus}`);
  }

  return Object.freeze({
    message: ensureNonEmptyString(message, `diagnostic message for ${name}`),
    name: ensureNonEmptyString(name, "diagnostic check name"),
    status: normalizedStatus,
  });
}

async function runAdapterDiagnostics({
  adapter,
  config = {},
  secretStore = null,
  runtimeContext = {},
}) {
  const normalizedAdapter = assertAdapterImplementation(adapter);
  const requiredEnv = typeof normalizedAdapter.requiredEnv === "function"
    ? normalizedAdapter.requiredEnv()
    : [];
  const optionalEnv = typeof normalizedAdapter.optionalEnv === "function"
    ? normalizedAdapter.optionalEnv()
    : [];
  const checks = [];
  let env = null;

  checks.push(createDiagnosticCheck({
    name: "interface",
    status: "PASS",
    message: "Adapter implements execute(), test(), capabilities(), and normalize().",
  }));
  checks.push(createDiagnosticCheck({
    name: "protocol",
    status: "PASS",
    message: `Adapter protocol type ${normalizeCapabilityProfile(normalizedAdapter.capabilities()).protocol_type} is supported.`,
  }));

  try {
    env = resolveAdapterEnv({
      config,
      secretStore,
      requiredEnv,
      optionalEnv,
    });
    checks.push(createDiagnosticCheck({
      name: "env_bindings",
      status: "PASS",
      message: "Required and optional env bindings resolved successfully.",
    }));
  } catch (error) {
    checks.push(createDiagnosticCheck({
      name: "env_bindings",
      status: "FAIL",
      message: error.message,
    }));

    return {
      adapter_id: normalizedAdapter.id ?? "adapter",
      checks,
      env: null,
      ok: false,
      protocol_type: normalizeCapabilityProfile(normalizedAdapter.capabilities()).protocol_type,
      test_result: null,
    };
  }

  const testResult = await normalizedAdapter.test({
    config,
    env,
    runtimeContext,
  });
  const normalizedTestChecks = (testResult?.checks ?? []).map((check, index) =>
    createDiagnosticCheck({
      name: check?.name ?? `test_${index}`,
      status: check?.status ?? "PASS",
      message: check?.message ?? "adapter.test() completed",
    }),
  );

  return {
    adapter_id: normalizedAdapter.id ?? "adapter",
    checks: [...checks, ...normalizedTestChecks],
    env,
    ok: checks.every((check) => check.status !== "FAIL")
      && normalizedTestChecks.every((check) => check.status !== "FAIL")
      && (testResult?.ok ?? true),
    protocol_type: normalizeCapabilityProfile(normalizedAdapter.capabilities()).protocol_type,
    test_result: testResult ?? null,
  };
}

function matchesCapabilityRequirements(capabilityProfile, requirements = {}) {
  const normalizedCapabilityProfile = normalizeCapabilityProfile(capabilityProfile);
  const requiredOperations = ensureUniqueStringArray(
    requirements.operations ?? [],
    "requirements.operations",
  );
  const requiredPermissions = ensureUniqueStringArray(
    requirements.permissions ?? [],
    "requirements.permissions",
  );
  const requiredToolFamilies = ensureUniqueStringArray(
    requirements.toolFamilies ?? [],
    "requirements.toolFamilies",
  );
  const requiredProtocolTypes = ensureUniqueStringArray(
    requirements.protocolTypes ?? [],
    "requirements.protocolTypes",
  );

  return requiredOperations.every((operation) =>
    normalizedCapabilityProfile.operations.includes(operation),
  ) && requiredPermissions.every((permission) =>
    normalizedCapabilityProfile.permissions.includes(permission),
  ) && requiredToolFamilies.every((toolFamily) =>
    normalizedCapabilityProfile.tool_families.includes(toolFamily),
  ) && (requiredProtocolTypes.length === 0
    || requiredProtocolTypes.includes(normalizedCapabilityProfile.protocol_type));
}

function capabilityMatchScore(capabilityProfile) {
  return capabilityProfile.operations.length
    + capabilityProfile.permissions.length
    + capabilityProfile.tool_families.length;
}

function selectAdapterByCapabilities(adapters, requirements = {}) {
  const candidates = adapters
    .map(assertAdapterImplementation)
    .map((adapter) => ({
      adapter,
      capabilities: normalizeCapabilityProfile(adapter.capabilities()),
    }))
    .filter(({ capabilities }) => matchesCapabilityRequirements(capabilities, requirements))
    .sort((left, right) => {
      const scoreDiff = capabilityMatchScore(right.capabilities) - capabilityMatchScore(left.capabilities);

      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return ensureNonEmptyString(left.adapter.id, "adapter id").localeCompare(
        ensureNonEmptyString(right.adapter.id, "adapter id"),
      );
    });

  return {
    candidates,
    selected: candidates[0]?.adapter ?? null,
  };
}

function createAdapterDefinition({
  id,
  protocolType = "local_cli",
  capabilities,
  execute,
  test,
  normalize,
  requiredEnv = () => [],
  optionalEnv = () => [],
  sessionCodec = {},
  runtimeTools = () => [],
  callbackChannel = {},
  metadata = {},
}) {
  const adapterId = ensureNonEmptyString(id, "adapter id");

  if (typeof execute !== "function") {
    throw new AdapterContractError("adapter execute must be a function");
  }

  if (typeof test !== "function") {
    throw new AdapterContractError("adapter test must be a function");
  }

  if (typeof normalize !== "function") {
    throw new AdapterContractError("adapter normalize must be a function");
  }

  if (typeof capabilities !== "function" && (!capabilities || typeof capabilities !== "object")) {
    throw new AdapterContractError("adapter capabilities must be a function or plain object");
  }

  if (typeof requiredEnv !== "function" || typeof optionalEnv !== "function") {
    throw new AdapterContractError("requiredEnv and optionalEnv must be functions");
  }

  if (typeof runtimeTools !== "function") {
    throw new AdapterContractError("runtimeTools must be a function");
  }

  const resolvedCapabilities = () =>
    createCapabilityProfile({
      protocolType,
      ...(typeof capabilities === "function" ? capabilities() : capabilities),
    });
  const resolvedSessionCodec = createSessionCodec(sessionCodec);
  const resolvedCallbackChannel = createCallbackChannel(callbackChannel);

  return Object.freeze({
    callbackChannel() {
      return resolvedCallbackChannel;
    },
    capabilities() {
      return resolvedCapabilities();
    },
    execute,
    id: adapterId,
    metadata,
    normalize(rawResult) {
      return parseAdapterResponse(normalize(rawResult));
    },
    optionalEnv() {
      return normalizeEnvBindings({ optional: optionalEnv() }).optional;
    },
    protocolType: resolvedCapabilities().protocol_type,
    requiredEnv() {
      return normalizeEnvBindings({ required: requiredEnv() }).required;
    },
    runtimeTools() {
      return normalizeRuntimeTools(runtimeTools());
    },
    sessionCodec() {
      return resolvedSessionCodec;
    },
    test,
  });
}

export {
  ADAPTER_PROTOCOL_TYPES,
  CALLBACK_CHANNEL_NAMES,
  DIAGNOSTIC_CHECK_STATUSES,
  AdapterContractError,
  assertAdapterImplementation,
  createAdapterDefinition,
  createCallbackChannel,
  createCapabilityDeniedResponse,
  createCapabilityProfile,
  createDiagnosticCheck,
  createEnvBindingDeclaration,
  createRuntimeToolSpec,
  createSessionCodec,
  deserializeAdapterSession,
  evaluateCapabilityAccess,
  matchesCapabilityRequirements,
  normalizeCapabilityProfile,
  normalizeAdapterResult,
  normalizeEnvBindings,
  normalizeRuntimeTools,
  renderSessionCompactionHandoff,
  resolveAdapterEnv,
  resolveSecretReference,
  runAdapterDiagnostics,
  selectAdapterByCapabilities,
  serializeAdapterSession,
};
