import test from "node:test";
import assert from "node:assert/strict";

import {
  REGISTERED_ENTITY_VERSION_FIELD,
  SchemaRegistryError,
  defaultSchemaRegistry,
} from "./index.js";

test("defaultSchemaRegistry creates a versioned envelope for registered entities", () => {
  const envelope = defaultSchemaRegistry.createRegisteredEntityEnvelope("task", {
    id: "schema-registry-record",
    title: "Implement schema registry load checks",
    status: "IN_PROGRESS",
    phase: 1,
    priority: "high",
    goal_id: null,
    depends_on: [],
    assigned_to: null,
    out_of_scope: [],
    rejection_count: 0,
    max_rejections: 5,
    created_at: "2026-03-21T14:00:00Z",
    updated_at: "2026-03-21T14:00:00Z",
    transition_log: [],
  });

  assert.equal(envelope.entity, "task");
  assert.equal(envelope[REGISTERED_ENTITY_VERSION_FIELD], "1.0.0");
  assert.equal(envelope.payload.id, "schema-registry-record");
});

test("defaultSchemaRegistry loads registered entities only when schema versions match", () => {
  const loaded = defaultSchemaRegistry.loadRegisteredEntity({
    entity: "package_manifest",
    schema_version: "1.0.0",
    payload: {
      id: "pkg-validator-default",
      name: "Default Validator Pack",
      version: "0.1.0",
      type: "validator",
      capabilities: ["review"],
      compatibility: {
        min_niis_version: "0.1.0",
        max_niis_version: null,
        required_adapters: [],
      },
      activation_status: "REVIEW",
      schema_version: "1.0.0",
    },
  });

  assert.equal(loaded.entity, "package_manifest");
  assert.equal(loaded.schema_version, "1.0.0");
  assert.equal(loaded.value.name, "Default Validator Pack");
});

test("defaultSchemaRegistry rejects registered entity loads with mismatched schema versions", () => {
  assert.throws(
    () =>
      defaultSchemaRegistry.loadRegisteredEntity({
        entity: "task",
        schema_version: "2.0.0",
        payload: {
          id: "schema-registry-record",
          title: "Implement schema registry load checks",
          status: "IN_PROGRESS",
          phase: 1,
          priority: "high",
          goal_id: null,
          depends_on: [],
          assigned_to: null,
          out_of_scope: [],
          rejection_count: 0,
          max_rejections: 5,
          created_at: "2026-03-21T14:00:00Z",
          updated_at: "2026-03-21T14:00:00Z",
          transition_log: [],
        },
      }),
    (error) => {
      assert.ok(error instanceof SchemaRegistryError);
      assert.match(error.message, /Schema version mismatch for task/);
      return true;
    },
  );
});

test("defaultSchemaRegistry rejects loads for unregistered entity types", () => {
  assert.throws(
    () =>
      defaultSchemaRegistry.loadRegisteredEntity({
        entity: "nonexistent_entity",
        schema_version: "1.0.0",
        payload: {},
      }),
    (error) => {
      assert.ok(error instanceof SchemaRegistryError);
      assert.match(error.message, /Schema entity is not registered/);
      return true;
    },
  );
});
