import {
  anyObject,
  arrayOf,
  defineSchema,
  enumField,
  exportSchema,
  objectShape,
  parseSchema,
  string,
  validateSchema,
} from "./shared.js";

const PACKAGE_TYPES = [
  "role",
  "agent",
  "adapter",
  "validator",
  "plugin",
  "skill",
  "prompt",
  "workflow",
  "policy_pack",
  "converter",
];

const ACTIVATION_STATUSES = ["INACTIVE", "REVIEW", "ACTIVE", "DEPRECATED"];
const PACKAGE_RUNTIME_DEFINITION_KINDS = [
  "role_manifest",
  "adapter_factory",
  "validator_factory",
  "agent_entity",
];

const packageManifestSchema = defineSchema({
  name: "package_manifest",
  entity: "package_manifest",
  description: "Canonical manifest for versioned Niis roles, agents, adapters, validators, and packs.",
  fields: {
    id: string({ minLength: 1 }),
    name: string({ minLength: 1 }),
    version: string({ minLength: 1 }),
    type: enumField(PACKAGE_TYPES),
    capabilities: arrayOf(string({ minLength: 1 }), { default: [] }),
    compatibility: objectShape({
      min_niis_version: string({ minLength: 1 }),
      max_niis_version: string({ nullable: true, default: null }),
      required_adapters: arrayOf(string({ minLength: 1 }), { default: [] }),
    }),
    runtime: objectShape({
      config: anyObject({ default: {} }),
      definition_kind: enumField(PACKAGE_RUNTIME_DEFINITION_KINDS, {
        nullable: true,
        default: null,
      }),
      export_name: string({ minLength: 1, default: "default" }),
      module_ref: string({ minLength: 1, nullable: true, default: null }),
    }, {
      default: {
        config: {},
        definition_kind: null,
        export_name: "default",
        module_ref: null,
      },
    }),
    activation_status: enumField(ACTIVATION_STATUSES),
    schema_version: string({ minLength: 1 }),
  },
});

function parsePackageManifest(input) {
  return parseSchema(packageManifestSchema, input);
}

function validatePackageManifest(input) {
  return validateSchema(packageManifestSchema, input);
}

function exportPackageManifestSchema() {
  return exportSchema(packageManifestSchema);
}

export {
  ACTIVATION_STATUSES,
  PACKAGE_RUNTIME_DEFINITION_KINDS,
  PACKAGE_TYPES,
  exportPackageManifestSchema,
  packageManifestSchema,
  parsePackageManifest,
  validatePackageManifest,
};
