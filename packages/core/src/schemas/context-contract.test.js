import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTEXT_SOURCES,
  parseContextContract,
  validateContextContract,
} from "./context-contract.js";
import { SchemaValidationError } from "./shared.js";

const BASE_CONTEXT_CONTRACT = Object.freeze({
  version: 1,
  allow: Object.freeze(["task_spec", "role_persona", "operator_guidance"]),
});

test("parseContextContract accepts a complete contract", () => {
  const parsed = parseContextContract({ ...BASE_CONTEXT_CONTRACT, allow: [...BASE_CONTEXT_CONTRACT.allow] });

  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.allow, ["task_spec", "role_persona", "operator_guidance"]);
});

test("parseContextContract hydrates defaults for an empty contract", () => {
  const parsed = parseContextContract({});

  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.allow, []);
});

test("parseContextContract rejects unknown context sources", () => {
  assert.throws(
    () => parseContextContract({ allow: ["secrets"] }),
    (error) => error instanceof SchemaValidationError
      && error.errors.some((entry) => entry.includes("allow.[0]")),
  );
});

test("parseContextContract rejects unknown keys", () => {
  assert.throws(
    () => parseContextContract({ ...BASE_CONTEXT_CONTRACT, allow: [...BASE_CONTEXT_CONTRACT.allow], forbidden: ["secrets"] }),
    (error) => error instanceof SchemaValidationError
      && error.errors.some((entry) => entry.includes("forbidden is not allowed")),
  );
});

test("parseContextContract rejects a non-integer version", () => {
  assert.throws(
    () => parseContextContract({ version: "1", allow: [] }),
    SchemaValidationError,
  );
});

test("validateContextContract reports errors without throwing", () => {
  const result = validateContextContract({ allow: "task_spec" });

  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.ok(result.errors.length > 0);
});

test("every declared context source is accepted in allow", () => {
  const parsed = parseContextContract({ allow: [...CONTEXT_SOURCES] });

  assert.deepEqual(parsed.allow, CONTEXT_SOURCES);
});
