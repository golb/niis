import {
  createPluginDefinition,
  evaluatePluginLifecycleTransition,
} from "../../core/src/contracts/plugin-runtime.js";

class NiisSdkError extends Error {
  constructor(message) {
    super(message);
    this.name = "NiisSdkError";
  }
}

function requireHookFunction(value, name) {
  if (typeof value !== "function") {
    throw new NiisSdkError(`plugin ${name} hook must be a function`);
  }

  return value;
}

function definePlugin({
  manifest,
  runtimeCapabilities = {},
  worker = {},
  eventSubscriptions = [],
  tools = [],
  jobs = [],
  stateScopes = [],
  integrations = [],
  setup,
  shutdown,
  health,
  metadata = {},
} = {}) {
  const hooks = {
    health: true,
    setup: true,
    shutdown: true,
  };
  const runtime = createPluginDefinition({
    eventSubscriptions,
    hooks,
    integrations,
    jobs,
    lifecycleState: "installed",
    manifest,
    metadata,
    runtimeCapabilities,
    stateScopes,
    tools,
    worker,
  });

  return Object.freeze({
    health: requireHookFunction(health, "health"),
    manifest: runtime.package_manifest,
    metadata: runtime.metadata,
    runtime,
    setup: requireHookFunction(setup, "setup"),
    shutdown: requireHookFunction(shutdown, "shutdown"),
    transition(action) {
      return evaluatePluginLifecycleTransition({
        action,
        fromState: this.runtime.lifecycle_state,
      });
    },
  });
}

export {
  NiisSdkError,
  definePlugin,
};
