import test from "node:test";
import assert from "node:assert/strict";

import { definePlugin } from "./index.js";

test("definePlugin returns executable hooks plus a normalized runtime descriptor", async () => {
  const plugin = definePlugin({
    manifest: {
      id: "pkg-observability-plugin",
      name: "Observability Plugin",
      version: "0.1.0",
      type: "plugin",
      capabilities: ["observability"],
      compatibility: {
        min_niis_version: "0.1.0",
        max_niis_version: null,
        required_adapters: [],
      },
      activation_status: "ACTIVE",
      schema_version: "1.0.0",
    },
    runtimeCapabilities: {
      operations: ["events.subscribe"],
    },
    setup: async () => "setup",
    shutdown: async () => "shutdown",
    health: async () => ({ ok: true }),
  });

  assert.equal(plugin.manifest.type, "plugin");
  assert.equal(plugin.runtime.hooks.setup, true);
  assert.equal(await plugin.setup(), "setup");
  assert.equal(plugin.transition("load").to_state, "ready");
});
