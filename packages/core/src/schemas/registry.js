class SchemaRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaRegistryError";
  }
}

const REGISTERED_ENTITY_VERSION_FIELD = "schema_version";

const BACKWARD_COMPATIBILITY_RULES = Object.freeze({
  additive_optional_fields_without_type_change: true,
  enum_expansion_without_semantic_redefinition: true,
  default_value_addition_for_new_optional_fields: true,
  required_field_addition_requires_migration: false,
  field_removal_without_migration: false,
  field_type_change_without_migration: false,
  enum_value_removal_without_migration: false,
});

function createSchemaRegistry() {
  const schemasByEntity = new Map();

  function requireSchema(entity) {
    const schema = get(entity);

    if (!schema) {
      throw new SchemaRegistryError(`Schema entity is not registered: ${entity}`);
    }

    if (typeof schema.parse !== "function") {
      throw new SchemaRegistryError(`Registered schema is missing parse(): ${entity}`);
    }

    return schema;
  }

  function assertRegisteredVersion(entity, schemaVersion) {
    const schema = requireSchema(entity);

    if (typeof schemaVersion !== "string" || schemaVersion.length === 0) {
      throw new SchemaRegistryError(
        `Registered entity load requires non-empty ${REGISTERED_ENTITY_VERSION_FIELD}: ${entity}`,
      );
    }

    if (schema.version !== schemaVersion) {
      throw new SchemaRegistryError(
        `Schema version mismatch for ${entity}: expected ${schema.version}, got ${schemaVersion}`,
      );
    }

    return schema.version;
  }

  function register(schema) {
    if (!schema || typeof schema !== "object") {
      throw new SchemaRegistryError("Cannot register an empty schema definition");
    }

    if (!schema.entity || !schema.name || !schema.version) {
      throw new SchemaRegistryError("Schema registration requires entity, name, and version");
    }

    if (schemasByEntity.has(schema.entity)) {
      throw new SchemaRegistryError(`Schema entity already registered: ${schema.entity}`);
    }

    schemasByEntity.set(schema.entity, schema);
    return schema;
  }

  function has(entity) {
    return schemasByEntity.has(entity);
  }

  function get(entity) {
    return schemasByEntity.get(entity) || null;
  }

  function list() {
    return Array.from(schemasByEntity.values())
      .map((schema) => ({
        entity: schema.entity,
        name: schema.name,
        version: schema.version,
      }))
      .sort((left, right) => left.entity.localeCompare(right.entity));
  }

  function compatibilityMatrix() {
    return list().map((schema) => ({
      entity: schema.entity,
      version: schema.version,
      backward_compatible_changes: BACKWARD_COMPATIBILITY_RULES,
    }));
  }

  function validateRegisteredEntity(entity, payload, options = {}) {
    const schema = requireSchema(entity);
    const { schemaVersion } = options;

    if (schemaVersion !== undefined) {
      assertRegisteredVersion(entity, schemaVersion);
    }

    return schema.parse(payload);
  }

  function createRegisteredEntityEnvelope(entity, payload) {
    const schema = requireSchema(entity);

    return {
      entity,
      [REGISTERED_ENTITY_VERSION_FIELD]: schema.version,
      payload: schema.parse(payload),
    };
  }

  function loadRegisteredEntity(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new SchemaRegistryError("Registered entity load requires an object record");
    }

    const { entity, payload } = record;
    const schemaVersion = record[REGISTERED_ENTITY_VERSION_FIELD];

    if (typeof entity !== "string" || entity.length === 0) {
      throw new SchemaRegistryError("Registered entity load requires a non-empty entity");
    }

    const value = validateRegisteredEntity(entity, payload, { schemaVersion });

    return {
      entity,
      [REGISTERED_ENTITY_VERSION_FIELD]: schemaVersion,
      value,
    };
  }

  return {
    assertRegisteredVersion,
    compatibilityMatrix,
    createRegisteredEntityEnvelope,
    get,
    has,
    loadRegisteredEntity,
    list,
    register,
    validateRegisteredEntity,
  };
}

function isBackwardCompatibleChange(change) {
  return Boolean(BACKWARD_COMPATIBILITY_RULES[change]);
}

function buildDefaultSchemaRegistry(modules) {
  const registry = createSchemaRegistry();

  for (const module of modules) {
    if (!module || !module.schema || typeof module.parse !== "function") {
      throw new SchemaRegistryError("Schema module is missing a schema definition");
    }

    registry.register(module);
  }

  return registry;
}

export {
  BACKWARD_COMPATIBILITY_RULES,
  REGISTERED_ENTITY_VERSION_FIELD,
  SchemaRegistryError,
  buildDefaultSchemaRegistry,
  createSchemaRegistry,
  isBackwardCompatibleChange,
};
