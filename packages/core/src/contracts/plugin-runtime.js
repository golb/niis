import {
  createCapabilityProfile,
  createRuntimeToolSpec,
  evaluateCapabilityAccess,
  normalizeEnvBindings,
} from "./adapter.js";
import { parsePackageManifest } from "../schemas/package-manifest.js";

class PluginRuntimeContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "PluginRuntimeContractError";
  }
}

const PLUGIN_LIFECYCLE_STATES = ["installed", "ready", "disabled", "error", "uninstalled"];
const PLUGIN_LIFECYCLE_ACTIONS = ["load", "disable", "enable", "fail", "recover", "health", "uninstall"];
const PLUGIN_INTEGRATION_KINDS = ["mcp_server"];
const PLUGIN_WORKER_ISOLATION_KINDS = ["process_rpc"];
const PLUGIN_WORKER_RPC_PROTOCOLS = ["json_rpc_2_0"];
const PLUGIN_STATE_SCOPE_KINDS = ["project", "plugin_instance"];
const PLUGIN_STATE_SCOPE_ACCESS = ["read_only", "read_write"];
const PLUGIN_RUNTIME_CHECK_STATUSES = ["ok", "warning", "error"];
const REQUIRED_PLUGIN_HOOKS = ["setup", "shutdown", "health"];

const PLUGIN_LIFECYCLE_TRANSITIONS = Object.freeze({
  disabled: Object.freeze({
    enable: "ready",
    uninstall: "uninstalled",
  }),
  error: Object.freeze({
    recover: "ready",
    uninstall: "uninstalled",
  }),
  installed: Object.freeze({
    load: "ready",
    uninstall: "uninstalled",
  }),
  ready: Object.freeze({
    disable: "disabled",
    fail: "error",
    health: "ready",
    uninstall: "uninstalled",
  }),
  uninstalled: Object.freeze({}),
});

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PluginRuntimeContractError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensureNullableString(value, label) {
  if (value === undefined || value === null) {
    return null;
  }

  return ensureNonEmptyString(value, label);
}

function ensurePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginRuntimeContractError(`${label} must be a plain object`);
  }

  return value;
}

function ensureEnumValue(value, allowedValues, label) {
  if (!allowedValues.includes(value)) {
    throw new PluginRuntimeContractError(`${label} must be one of: ${allowedValues.join(", ")}`);
  }

  return value;
}

function ensureStringArray(values, label) {
  if (!Array.isArray(values)) {
    throw new PluginRuntimeContractError(`${label} must be an array`);
  }

  return values.map((value, index) => ensureNonEmptyString(value, `${label}[${index}]`));
}

function ensureBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new PluginRuntimeContractError(`${label} must be a boolean`);
  }

  return value;
}

function ensurePositiveInteger(value, label, fallbackValue) {
  const normalizedValue = value ?? fallbackValue;

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    throw new PluginRuntimeContractError(`${label} must be a positive integer`);
  }

  return normalizedValue;
}

function uniqueStrings(values) {
  return Object.freeze([...new Set(values)]);
}

function createPluginHookDescriptor(input = {}) {
  const normalizedInput = ensurePlainObject(input, "hooks");

  return Object.freeze({
    health: ensureBoolean(
      normalizedInput.health ?? normalizedInput.health_declared ?? false,
      "hooks.health",
    ),
    setup: ensureBoolean(
      normalizedInput.setup ?? normalizedInput.setup_declared ?? false,
      "hooks.setup",
    ),
    shutdown: ensureBoolean(
      normalizedInput.shutdown ?? normalizedInput.shutdown_declared ?? false,
      "hooks.shutdown",
    ),
  });
}

function createPluginWorkerSpec(input = {}) {
  const normalizedInput = ensurePlainObject(input, "worker");
  const restartPolicy = ensurePlainObject(
    normalizedInput.restartPolicy
    ?? normalizedInput.restart_policy
    ?? {},
    "worker.restartPolicy",
  );
  const initialBackoffMs = ensurePositiveInteger(
    restartPolicy.initialBackoffMs ?? restartPolicy.initial_backoff_ms,
    "worker.restartPolicy.initialBackoffMs",
    1000,
  );
  const maxBackoffMs = ensurePositiveInteger(
    restartPolicy.maxBackoffMs ?? restartPolicy.max_backoff_ms,
    "worker.restartPolicy.maxBackoffMs",
    30000,
  );

  if (initialBackoffMs > maxBackoffMs) {
    throw new PluginRuntimeContractError(
      "worker.restartPolicy.initialBackoffMs must be less than or equal to maxBackoffMs",
    );
  }

  return Object.freeze({
    isolation_kind: ensureEnumValue(
      normalizedInput.isolationKind ?? normalizedInput.isolation_kind ?? "process_rpc",
      PLUGIN_WORKER_ISOLATION_KINDS,
      "worker.isolationKind",
    ),
    restart_policy: Object.freeze({
      initial_backoff_ms: initialBackoffMs,
      max_backoff_ms: maxBackoffMs,
      max_restarts: ensurePositiveInteger(
        restartPolicy.maxRestarts ?? restartPolicy.max_restarts,
        "worker.restartPolicy.maxRestarts",
        5,
      ),
      restart_window_ms: ensurePositiveInteger(
        restartPolicy.restartWindowMs ?? restartPolicy.restart_window_ms,
        "worker.restartPolicy.restartWindowMs",
        60000,
      ),
    }),
    rpc_protocol: ensureEnumValue(
      normalizedInput.rpcProtocol ?? normalizedInput.rpc_protocol ?? "json_rpc_2_0",
      PLUGIN_WORKER_RPC_PROTOCOLS,
      "worker.rpcProtocol",
    ),
  });
}

function createPluginEventSubscription(input = {}) {
  const normalizedInput = ensurePlainObject(input, "eventSubscription");

  return Object.freeze({
    required_capabilities: uniqueStrings(ensureStringArray(
      normalizedInput.requiredCapabilities
      ?? normalizedInput.required_capabilities
      ?? [],
      "eventSubscription.requiredCapabilities",
    )),
    topic: ensureNonEmptyString(
      normalizedInput.topic ?? normalizedInput.event_type,
      "eventSubscription.topic",
    ),
  });
}

function createPluginJobSpec(input = {}) {
  const normalizedInput = ensurePlainObject(input, "job");

  return Object.freeze({
    description: ensureNonEmptyString(
      normalizedInput.description ?? `Plugin job ${normalizedInput.id ?? "job"}`,
      "job.description",
    ),
    id: ensureNonEmptyString(normalizedInput.id, "job.id"),
    required_capabilities: uniqueStrings(ensureStringArray(
      normalizedInput.requiredCapabilities
      ?? normalizedInput.required_capabilities
      ?? [],
      "job.requiredCapabilities",
    )),
    schedule: ensureNonEmptyString(
      normalizedInput.schedule ?? normalizedInput.cron,
      "job.schedule",
    ),
  });
}

function createPluginStateScope(input = {}) {
  const normalizedInput = ensurePlainObject(input, "stateScope");

  return Object.freeze({
    access: ensureEnumValue(
      normalizedInput.access ?? "read_write",
      PLUGIN_STATE_SCOPE_ACCESS,
      "stateScope.access",
    ),
    kind: ensureEnumValue(
      normalizedInput.kind ?? "project",
      PLUGIN_STATE_SCOPE_KINDS,
      "stateScope.kind",
    ),
    scope_key: ensureNonEmptyString(
      normalizedInput.scopeKey ?? normalizedInput.scope_key,
      "stateScope.scopeKey",
    ),
  });
}

function createPluginIntegrationSpec(input = {}) {
  const normalizedInput = ensurePlainObject(input, "integration");
  const integrationKind = ensureEnumValue(
    normalizedInput.kind,
    PLUGIN_INTEGRATION_KINDS,
    "integration.kind",
  );
  const envBindings = normalizeEnvBindings({
    optional: normalizedInput.optionalEnv ?? normalizedInput.optional_env ?? [],
    required: normalizedInput.requiredEnv ?? normalizedInput.required_env ?? [],
  });

  if (integrationKind === "mcp_server") {
    return Object.freeze({
      adapter_id: ensureNonEmptyString(
        normalizedInput.adapterId
        ?? normalizedInput.adapter_id
        ?? normalizedInput.id,
        "integration.adapterId",
      ),
      args: ensureStringArray(normalizedInput.args ?? [], "integration.args"),
      capabilities: createCapabilityProfile({
        protocolType: "mcp_server",
        adapterKind: "plugin_mcp_server",
        ...(normalizedInput.capabilities ?? {}),
      }),
      command: ensureNonEmptyString(normalizedInput.command, "integration.command"),
      cwd: ensureNullableString(normalizedInput.cwd ?? null, "integration.cwd"),
      default_tool_name: ensureNullableString(
        normalizedInput.defaultToolName ?? normalizedInput.default_tool_name ?? null,
        "integration.defaultToolName",
      ),
      display_name: ensureNonEmptyString(
        normalizedInput.displayName ?? normalizedInput.display_name ?? normalizedInput.id,
        "integration.displayName",
      ),
      id: ensureNonEmptyString(normalizedInput.id, "integration.id"),
      kind: integrationKind,
      metadata: ensurePlainObject(normalizedInput.metadata ?? {}, "integration.metadata"),
      optional_env: envBindings.optional,
      protocol_type: "mcp_server",
      required_env: envBindings.required,
    });
  }

  throw new PluginRuntimeContractError(`unsupported integration kind: ${integrationKind}`);
}

function createPluginRuntimeCheck(input = {}) {
  const normalizedInput = ensurePlainObject(input, "pluginRuntimeCheck");

  return Object.freeze({
    details: ensureNonEmptyString(normalizedInput.details, "pluginRuntimeCheck.details"),
    id: ensureNonEmptyString(normalizedInput.id, "pluginRuntimeCheck.id"),
    status: ensureEnumValue(
      normalizedInput.status,
      PLUGIN_RUNTIME_CHECK_STATUSES,
      "pluginRuntimeCheck.status",
    ),
    summary: ensureNonEmptyString(normalizedInput.summary, "pluginRuntimeCheck.summary"),
  });
}

function createPluginDefinition(input = {}) {
  const normalizedInput = ensurePlainObject(input, "pluginDefinition");
  const manifest = parsePackageManifest(
    normalizedInput.manifest
    ?? normalizedInput.package_manifest
    ?? normalizedInput.packageManifest,
  );

  if (manifest.type !== "plugin") {
    throw new PluginRuntimeContractError(
      `plugin manifest must use type plugin, received ${manifest.type}`,
    );
  }

  return Object.freeze({
    event_subscriptions: Object.freeze(
      (normalizedInput.eventSubscriptions
        ?? normalizedInput.event_subscriptions
        ?? [])
        .map((subscription) => createPluginEventSubscription(subscription)),
    ),
    hooks: createPluginHookDescriptor(normalizedInput.hooks ?? {}),
    integrations: Object.freeze(
      (normalizedInput.integrations ?? []).map((integration) => createPluginIntegrationSpec(integration)),
    ),
    jobs: Object.freeze(
      (normalizedInput.jobs ?? []).map((job) => createPluginJobSpec(job)),
    ),
    lifecycle_state: ensureEnumValue(
      normalizedInput.lifecycleState ?? normalizedInput.lifecycle_state ?? "installed",
      PLUGIN_LIFECYCLE_STATES,
      "pluginDefinition.lifecycleState",
    ),
    metadata: ensurePlainObject(normalizedInput.metadata ?? {}, "pluginDefinition.metadata"),
    package_manifest: manifest,
    runtime_capabilities: createCapabilityProfile({
      adapterKind: "plugin_runtime",
      protocolType: "local_cli",
      ...(normalizedInput.runtimeCapabilities
        ?? normalizedInput.runtime_capabilities
        ?? {}),
    }),
    state_scopes: Object.freeze(
      (normalizedInput.stateScopes
        ?? normalizedInput.state_scopes
        ?? [])
        .map((scope) => createPluginStateScope(scope)),
    ),
    tools: Object.freeze(
      (normalizedInput.tools ?? []).map((tool) => createRuntimeToolSpec(tool)),
    ),
    worker: createPluginWorkerSpec(normalizedInput.worker ?? {}),
  });
}

function evaluatePluginLifecycleTransition({
  fromState,
  action,
} = {}) {
  const normalizedFromState = ensureEnumValue(fromState, PLUGIN_LIFECYCLE_STATES, "fromState");
  const normalizedAction = ensureEnumValue(action, PLUGIN_LIFECYCLE_ACTIONS, "action");
  const nextState = PLUGIN_LIFECYCLE_TRANSITIONS[normalizedFromState]?.[normalizedAction] ?? null;

  return Object.freeze({
    action: normalizedAction,
    allowed: nextState !== null,
    from_state: normalizedFromState,
    reason:
      nextState !== null
        ? null
        : `plugin lifecycle does not allow ${normalizedFromState} -> ${normalizedAction}`,
    to_state: nextState,
  });
}

function evaluatePluginCapabilityRequirement({
  capabilities,
  operation,
  toolFamily = null,
} = {}) {
  return evaluateCapabilityAccess({
    capabilities,
    operation,
    toolFamily,
  });
}

export {
  PLUGIN_INTEGRATION_KINDS,
  PLUGIN_LIFECYCLE_ACTIONS,
  PLUGIN_LIFECYCLE_STATES,
  PLUGIN_LIFECYCLE_TRANSITIONS,
  PLUGIN_RUNTIME_CHECK_STATUSES,
  PLUGIN_STATE_SCOPE_ACCESS,
  PLUGIN_STATE_SCOPE_KINDS,
  PLUGIN_WORKER_ISOLATION_KINDS,
  PLUGIN_WORKER_RPC_PROTOCOLS,
  PluginRuntimeContractError,
  REQUIRED_PLUGIN_HOOKS,
  createPluginDefinition,
  createPluginEventSubscription,
  createPluginHookDescriptor,
  createPluginIntegrationSpec,
  createPluginJobSpec,
  createPluginRuntimeCheck,
  createPluginStateScope,
  createPluginWorkerSpec,
  evaluatePluginCapabilityRequirement,
  evaluatePluginLifecycleTransition,
};
