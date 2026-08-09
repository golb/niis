import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createLocalSecretRef,
  createLocalSecretStore,
  materializeAgentEnvConfig,
  persistSensitiveAgentEnvBindings,
} from "./secrets.js";

function createAgent(envBindings = []) {
  return {
    id: "agent-secret-1",
    name: "Secret Agent",
    adapter_type: "in_memory",
    status: "ACTIVE",
    pause_condition: null,
    capabilities: ["execute"],
    budget_monthly: {
      limit_usd: 100,
      spent_usd: 0,
    },
    config: {},
    env_bindings: envBindings,
    health_status: "healthy",
    last_run_id: null,
    last_run_at: null,
    accumulated: {
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_cost_usd: 0,
      total_runs: 0,
    },
    created_at: "2026-04-01T20:00:00Z",
    updated_at: "2026-04-01T20:00:00Z",
  };
}

function createStateRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-secret-store-"));
  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });
  return path.join(root, ".niis");
}

test("createLocalSecretStore encrypts values at rest and resolves refs", (t) => {
  const stateRoot = createStateRoot(t);
  const secretStore = createLocalSecretStore({
    stateRoot,
  });
  const secretRef = createLocalSecretRef({
    segments: ["agent", "agent-secret-1", "OPENAI_API_KEY"],
  });

  secretStore.putSecret({
    metadata: {
      owner_id: "agent-secret-1",
      owner_kind: "agent",
    },
    ref: secretRef,
    value: "sk-test-secret",
  });

  assert.equal(secretStore.getSecret(secretRef), "sk-test-secret");
  assert.equal(secretStore.hasSecret(secretRef), true);
  assert.equal(secretStore.listSecrets()[0].ref, secretRef);
  assert.equal(
    fs.readFileSync(secretStore.paths.secretStorePath, "utf8").includes("sk-test-secret"),
    false,
  );
});

test("persistSensitiveAgentEnvBindings rewrites only sensitive plaintext bindings", (t) => {
  const stateRoot = createStateRoot(t);
  const secretStore = createLocalSecretStore({
    stateRoot,
  });
  const agent = createAgent([
    {
      key: "OPENAI_API_KEY",
      type: "plain",
      value: "sk-test-secret",
    },
    {
      key: "NIIS_LOG_LEVEL",
      type: "plain",
      value: "debug",
    },
  ]);

  const rewritten = persistSensitiveAgentEnvBindings(agent, {
    secretStore,
  });
  const runtimeConfig = materializeAgentEnvConfig(rewritten);

  assert.equal(rewritten.env_bindings[0].type, "secret_ref");
  assert.equal(rewritten.env_bindings[1].type, "plain");
  assert.deepEqual(runtimeConfig, {
    OPENAI_API_KEY: {
      secret_ref: rewritten.env_bindings[0].value,
    },
    NIIS_LOG_LEVEL: "debug",
  });
  assert.equal(secretStore.getSecret(rewritten.env_bindings[0].value), "sk-test-secret");
});

test("materializeAgentEnvConfig rejects sensitive plaintext bindings in reject mode", () => {
  const agent = createAgent([
    {
      key: "OPENAI_API_KEY",
      type: "plain",
      value: "sk-test-secret",
    },
  ]);

  assert.throws(
    () => materializeAgentEnvConfig(agent, { plaintextPersistence: "reject" }),
    /persists sensitive env binding OPENAI_API_KEY as plaintext/,
  );
});
