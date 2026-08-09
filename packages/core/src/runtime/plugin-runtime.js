import {
  REQUIRED_PLUGIN_HOOKS,
  createPluginDefinition,
  createPluginRuntimeCheck,
  evaluatePluginCapabilityRequirement,
  evaluatePluginLifecycleTransition,
} from "../contracts/plugin-runtime.js";

class PluginRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "PluginRuntimeError";
  }
}

function summarizeCapabilities(capabilities) {
  return [
    ...capabilities.operations,
    ...capabilities.permissions,
    ...capabilities.tool_families,
  ].join(", ") || "none";
}

function createIntegrationDiagnosticRequest(integration) {
  return Object.freeze({
    adapter_id: integration.adapter_id,
    args: integration.args,
    capabilities: {
      adapterKind: integration.capabilities.adapter_kind,
      allow: integration.capabilities.allow,
      deny: integration.capabilities.deny,
      operations: integration.capabilities.operations,
      permissions: integration.capabilities.permissions,
      privilegedOperations: integration.capabilities.privileged_operations,
      toolFamilies: integration.capabilities.tool_families,
    },
    command: integration.command,
    cwd: integration.cwd,
    default_tool_name: integration.default_tool_name,
    id: integration.id,
    kind: integration.kind,
    metadata: integration.metadata,
    optional_env: integration.optional_env,
    protocol_type: integration.protocol_type,
    required_env: integration.required_env,
  });
}

function createPluginRuntimePlan({
  plugin,
  action = "load",
} = {}) {
  if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
    throw new PluginRuntimeError("plugin runtime plan requires a plain object plugin descriptor");
  }

  const normalizedPlugin = createPluginDefinition(plugin);
  const checks = [];
  let blocked = false;

  function addCheck(check) {
    const normalizedCheck = createPluginRuntimeCheck(check);
    checks.push(normalizedCheck);

    if (normalizedCheck.status === "error") {
      blocked = true;
    }
  }

  const lifecycleTransition = evaluatePluginLifecycleTransition({
    action,
    fromState: normalizedPlugin.lifecycle_state,
  });

  addCheck({
    id: "plugin-activation-status",
    status: normalizedPlugin.package_manifest.activation_status === "ACTIVE" ? "ok" : "error",
    summary: normalizedPlugin.package_manifest.activation_status,
    details:
      normalizedPlugin.package_manifest.activation_status === "ACTIVE"
        ? "Plugin package is active and eligible for runtime loading."
        : "Plugin runtime cannot load until the package manifest is ACTIVE.",
  });

  const missingHooks = REQUIRED_PLUGIN_HOOKS.filter((hookName) => !normalizedPlugin.hooks[hookName]);
  addCheck({
    id: "plugin-hooks",
    status: missingHooks.length === 0 ? "ok" : "error",
    summary: missingHooks.length === 0 ? "setup, shutdown, health" : missingHooks.join(", "),
    details:
      missingHooks.length === 0
        ? "Plugin declares setup, shutdown, and health hooks."
        : "Plugin runtime contract requires setup, shutdown, and health hook declarations.",
  });

  addCheck({
    id: "plugin-worker-isolation",
    status: "ok",
    summary: `${normalizedPlugin.worker.isolation_kind} / ${normalizedPlugin.worker.rpc_protocol}`,
    details: "Plugin runtime isolates extensions through a process-boundary worker RPC contract.",
  });

  addCheck({
    id: "plugin-runtime-capabilities",
    status: "ok",
    summary: summarizeCapabilities(normalizedPlugin.runtime_capabilities),
    details: "Plugin runtime capability profile is declared and can gate subscriptions, tools, jobs, state, and integrations.",
  });

  if (normalizedPlugin.event_subscriptions.length > 0) {
    const capabilityDecision = evaluatePluginCapabilityRequirement({
      capabilities: normalizedPlugin.runtime_capabilities,
      operation: "events.subscribe",
    });
    addCheck({
      id: "plugin-event-subscriptions",
      status: capabilityDecision.allowed ? "ok" : "error",
      summary: `${normalizedPlugin.event_subscriptions.length} subscription(s)`,
      details: capabilityDecision.allowed
        ? "Plugin event subscriptions are allowed by the declared runtime capability profile."
        : `Plugin event subscriptions are blocked: ${capabilityDecision.reason}.`,
    });
  }

  if (normalizedPlugin.tools.length > 0) {
    const capabilityDecision = evaluatePluginCapabilityRequirement({
      capabilities: normalizedPlugin.runtime_capabilities,
      operation: "runtime_tools.register",
      toolFamily: "plugin",
    });
    addCheck({
      id: "plugin-tools",
      status: capabilityDecision.allowed ? "ok" : "error",
      summary: `${normalizedPlugin.tools.length} tool(s)`,
      details: capabilityDecision.allowed
        ? "Plugin runtime tool registration is allowed by the declared capability profile."
        : `Plugin runtime tool registration is blocked: ${capabilityDecision.reason}.`,
    });
  }

  if (normalizedPlugin.jobs.length > 0) {
    const capabilityDecision = evaluatePluginCapabilityRequirement({
      capabilities: normalizedPlugin.runtime_capabilities,
      operation: "jobs.schedule",
    });
    addCheck({
      id: "plugin-jobs",
      status: capabilityDecision.allowed ? "ok" : "error",
      summary: `${normalizedPlugin.jobs.length} job(s)`,
      details: capabilityDecision.allowed
        ? "Plugin job scheduling is allowed by the declared capability profile."
        : `Plugin job scheduling is blocked: ${capabilityDecision.reason}.`,
    });
  }

  if (normalizedPlugin.state_scopes.length > 0) {
    const requiresWrite = normalizedPlugin.state_scopes.some((scope) => scope.access === "read_write");
    const capabilityDecision = evaluatePluginCapabilityRequirement({
      capabilities: normalizedPlugin.runtime_capabilities,
      operation: requiresWrite ? "state.write" : "state.read",
    });
    addCheck({
      id: "plugin-state-scope",
      status: capabilityDecision.allowed ? "ok" : "error",
      summary: `${normalizedPlugin.state_scopes.length} scope(s)`,
      details: capabilityDecision.allowed
        ? "Plugin scoped state is allowed by the declared capability profile."
        : `Plugin scoped state is blocked: ${capabilityDecision.reason}.`,
    });
  }

  const integrationDiagnosticRequests = normalizedPlugin.integrations.map((integration) =>
    createIntegrationDiagnosticRequest(integration));
  if (normalizedPlugin.integrations.length > 0) {
    const capabilityDecision = evaluatePluginCapabilityRequirement({
      capabilities: normalizedPlugin.runtime_capabilities,
      operation: "integration.mcp_server",
      toolFamily: "mcp",
    });
    addCheck({
      id: "plugin-integrations",
      status: capabilityDecision.allowed ? "ok" : "error",
      summary: normalizedPlugin.integrations.map((integration) => integration.kind).join(", "),
      details: capabilityDecision.allowed
        ? "Plugin runtime integrations are allowed by the declared capability profile."
        : `Plugin runtime integrations are blocked: ${capabilityDecision.reason}.`,
    });
  }

  addCheck({
    id: "plugin-lifecycle-transition",
    status: lifecycleTransition.allowed ? "ok" : "error",
    summary: `${lifecycleTransition.from_state} -> ${action}`,
    details: lifecycleTransition.allowed
      ? `Lifecycle action ${action} transitions the plugin to ${lifecycleTransition.to_state}.`
      : lifecycleTransition.reason,
  });

  return Object.freeze({
    action,
    adapter_diagnostic_requests: Object.freeze(integrationDiagnosticRequests),
    allowed: !blocked && lifecycleTransition.allowed,
    checks: Object.freeze(checks),
    lifecycle_transition: lifecycleTransition,
    plugin_definition: normalizedPlugin,
    runtime_status: !blocked && lifecycleTransition.allowed ? "ready" : "blocked",
  });
}

export {
  PluginRuntimeError,
  createPluginRuntimePlan,
};
