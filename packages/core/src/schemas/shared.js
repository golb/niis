class SchemaValidationError extends Error {
  constructor(schemaName, errors) {
    super(`Invalid ${schemaName}: ${errors.join("; ")}`);
    this.name = "SchemaValidationError";
    this.schemaName = schemaName;
    this.errors = errors;
  }
}

function defineSchema(definition) {
  return Object.freeze({
    version: "1.0.0",
    ...definition,
  });
}

function string(options = {}) {
  return {
    kind: "string",
    ...options,
  };
}

function number(options = {}) {
  return {
    kind: "number",
    ...options,
  };
}

function integer(options = {}) {
  return {
    kind: "integer",
    ...options,
  };
}

function booleanField(options = {}) {
  return {
    kind: "boolean",
    ...options,
  };
}

function enumField(values, options = {}) {
  return {
    kind: "enum",
    values: [...values],
    ...options,
  };
}

function arrayOf(item, options = {}) {
  return {
    kind: "array",
    item,
    ...options,
  };
}

function objectShape(shape, options = {}) {
  return {
    kind: "object",
    shape,
    ...options,
  };
}

function anyObject(options = {}) {
  return {
    kind: "anyObject",
    ...options,
  };
}

function cloneDefault(value) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof global.structuredClone === "function") {
    return global.structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function formatPath(pathSegments) {
  if (pathSegments.length === 0) {
    return "value";
  }

  return pathSegments.join(".");
}

function validateDescriptor(descriptor, input, pathSegments, errors) {
  if (input === undefined) {
    if (Object.prototype.hasOwnProperty.call(descriptor, "default")) {
      return cloneDefault(descriptor.default);
    }

    if (descriptor.optional) {
      return undefined;
    }

    errors.push(`${formatPath(pathSegments)} is required`);
    return undefined;
  }

  if (input === null) {
    if (descriptor.nullable) {
      return null;
    }

    errors.push(`${formatPath(pathSegments)} must not be null`);
    return undefined;
  }

  switch (descriptor.kind) {
    case "string":
      return validateString(descriptor, input, pathSegments, errors);
    case "number":
      return validateNumber(descriptor, input, pathSegments, errors);
    case "integer":
      return validateInteger(descriptor, input, pathSegments, errors);
    case "boolean":
      return validateBoolean(descriptor, input, pathSegments, errors);
    case "enum":
      return validateEnum(descriptor, input, pathSegments, errors);
    case "array":
      return validateArray(descriptor, input, pathSegments, errors);
    case "object":
      return validateObject(descriptor, input, pathSegments, errors);
    case "anyObject":
      return validateAnyObject(descriptor, input, pathSegments, errors);
    default:
      errors.push(`${formatPath(pathSegments)} uses unsupported descriptor kind ${descriptor.kind}`);
      return undefined;
  }
}

function validateString(descriptor, input, pathSegments, errors) {
  if (typeof input !== "string") {
    errors.push(`${formatPath(pathSegments)} must be a string`);
    return undefined;
  }

  if (descriptor.minLength !== undefined && input.length < descriptor.minLength) {
    errors.push(`${formatPath(pathSegments)} must have length >= ${descriptor.minLength}`);
  }

  if (descriptor.isoTimestamp && !isIsoTimestamp(input)) {
    errors.push(`${formatPath(pathSegments)} must be an ISO 8601 timestamp`);
  }

  return input;
}

function validateNumber(descriptor, input, pathSegments, errors) {
  if (typeof input !== "number" || Number.isNaN(input)) {
    errors.push(`${formatPath(pathSegments)} must be a number`);
    return undefined;
  }

  if (descriptor.min !== undefined && input < descriptor.min) {
    errors.push(`${formatPath(pathSegments)} must be >= ${descriptor.min}`);
  }

  return input;
}

function validateInteger(descriptor, input, pathSegments, errors) {
  if (!Number.isInteger(input)) {
    errors.push(`${formatPath(pathSegments)} must be an integer`);
    return undefined;
  }

  if (descriptor.min !== undefined && input < descriptor.min) {
    errors.push(`${formatPath(pathSegments)} must be >= ${descriptor.min}`);
  }

  return input;
}

function validateBoolean(descriptor, input, pathSegments, errors) {
  if (typeof input !== "boolean") {
    errors.push(`${formatPath(pathSegments)} must be a boolean`);
    return undefined;
  }

  return input;
}

function validateEnum(descriptor, input, pathSegments, errors) {
  if (!descriptor.values.includes(input)) {
    errors.push(`${formatPath(pathSegments)} must be one of: ${descriptor.values.join(", ")}`);
    return undefined;
  }

  return input;
}

function validateArray(descriptor, input, pathSegments, errors) {
  if (!Array.isArray(input)) {
    errors.push(`${formatPath(pathSegments)} must be an array`);
    return undefined;
  }

  return input.map((item, index) =>
    validateDescriptor(descriptor.item, item, [...pathSegments, `[${index}]`], errors),
  );
}

function validateObject(descriptor, input, pathSegments, errors) {
  if (!isPlainObject(input)) {
    errors.push(`${formatPath(pathSegments)} must be an object`);
    return undefined;
  }

  const output = {};

  for (const [key, fieldDescriptor] of Object.entries(descriptor.shape)) {
    const normalized = validateDescriptor(fieldDescriptor, input[key], [...pathSegments, key], errors);

    if (normalized !== undefined || fieldDescriptor.optional || fieldDescriptor.default !== undefined) {
      output[key] = normalized;
    }
  }

  if (!descriptor.allowUnknownKeys) {
    for (const key of Object.keys(input)) {
      if (!Object.prototype.hasOwnProperty.call(descriptor.shape, key)) {
        errors.push(`${formatPath([...pathSegments, key])} is not allowed`);
      }
    }
  }

  return output;
}

function validateAnyObject(descriptor, input, pathSegments, errors) {
  if (!isPlainObject(input)) {
    errors.push(`${formatPath(pathSegments)} must be a plain object`);
    return undefined;
  }

  return descriptor.clone === false ? input : cloneDefault(input);
}

function parseSchema(schema, input) {
  const errors = [];
  const normalized = validateDescriptor(
    objectShape(schema.fields, { allowUnknownKeys: false }),
    input,
    [],
    errors,
  );

  if (errors.length > 0) {
    throw new SchemaValidationError(schema.name, errors);
  }

  return normalized;
}

function validateSchema(schema, input) {
  try {
    return {
      ok: true,
      errors: [],
      value: parseSchema(schema, input),
    };
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      return {
        ok: false,
        errors: error.errors,
        value: null,
      };
    }

    throw error;
  }
}

function exportSchema(schema) {
  return {
    name: schema.name,
    entity: schema.entity,
    version: schema.version,
    description: schema.description,
    fields: exportFields(schema.fields),
  };
}

function exportFields(fields) {
  const exported = {};

  for (const [fieldName, descriptor] of Object.entries(fields)) {
    exported[fieldName] = exportDescriptor(descriptor);
  }

  return exported;
}

function exportDescriptor(descriptor) {
  const exported = {
    kind: descriptor.kind,
  };

  if (descriptor.nullable) {
    exported.nullable = true;
  }

  if (descriptor.optional) {
    exported.optional = true;
  }

  if (Object.prototype.hasOwnProperty.call(descriptor, "default")) {
    exported.default = cloneDefault(descriptor.default);
  }

  if (descriptor.kind === "enum") {
    exported.values = [...descriptor.values];
  }

  if (descriptor.kind === "array") {
    exported.item = exportDescriptor(descriptor.item);
  }

  if (descriptor.kind === "object") {
    exported.shape = exportFields(descriptor.shape);
  }

  if (descriptor.kind === "string" && descriptor.isoTimestamp) {
    exported.format = "iso-8601";
  }

  if (descriptor.min !== undefined) {
    exported.min = descriptor.min;
  }

  if (descriptor.minLength !== undefined) {
    exported.minLength = descriptor.minLength;
  }

  return exported;
}

export {
  SchemaValidationError,
  anyObject,
  arrayOf,
  booleanField,
  defineSchema,
  enumField,
  exportSchema,
  integer,
  number,
  objectShape,
  parseSchema,
  string,
  validateSchema,
};
