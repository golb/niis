import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidatorOrthogonality,
  createValidatorDefinition,
  createVerdictContinuationPolicy,
  selectValidatorsById,
  ValidatorContractError,
} from "./validator.js";

test("createVerdictContinuationPolicy keeps the canonical verdict-class continuation defaults", () => {
  const continuationPolicy = createVerdictContinuationPolicy();

  assert.equal(continuationPolicy.PASS.action, "complete_lane");
  assert.equal(continuationPolicy.EVIDENCE_GAP.continue_to_next, true);
  assert.equal(continuationPolicy.PARTIAL_PROGRESS.retry_kind, "continuation");
  assert.equal(continuationPolicy.DEFECT.create_blocker, true);
});

test("assertValidatorOrthogonality rejects duplicate domains", () => {
  const validatorA = createValidatorDefinition({
    id: "validator-a",
    description: "Validator A",
    domain: "proof.a",
    excludedConcerns: ["proof.b"],
    validate: async () => ({
      verdict_class: "EVIDENCE_GAP",
      reason: "continue",
      next_action: "continue",
    }),
  });
  const validatorB = createValidatorDefinition({
    id: "validator-b",
    description: "Validator B",
    domain: "proof.a",
    excludedConcerns: ["proof.c"],
    validate: async () => ({
      verdict_class: "PASS",
      reason: "done",
      next_action: "done",
    }),
  });

  assert.throws(
    () => assertValidatorOrthogonality([validatorA, validatorB]),
    ValidatorContractError,
  );
});

test("selectValidatorsById returns validators in the requested order", () => {
  const validatorA = createValidatorDefinition({
    id: "validator-a",
    description: "Validator A",
    domain: "proof.a",
    excludedConcerns: [],
    validate: async () => ({
      verdict_class: "PASS",
      reason: "done",
      next_action: "done",
    }),
  });
  const validatorB = createValidatorDefinition({
    id: "validator-b",
    description: "Validator B",
    domain: "proof.b",
    excludedConcerns: [],
    validate: async () => ({
      verdict_class: "PASS",
      reason: "done",
      next_action: "done",
    }),
  });

  const selected = selectValidatorsById([validatorA, validatorB], ["validator-b", "validator-a"]);

  assert.deepEqual(selected.map((validator) => validator.id), ["validator-b", "validator-a"]);
});

test("createValidatorDefinition preserves failure attribution on normalized validator results", async () => {
  const validator = createValidatorDefinition({
    id: "validator-attribution",
    description: "Validator attribution",
    domain: "proof.attribution",
    excludedConcerns: [],
    validate: async () => ({
      verdict_class: "DEFECT",
      failure_attribution: "pre_existing_product",
      reason: "pre-existing failure",
      next_action: "record separately",
    }),
  });

  const result = await validator.validate({});

  assert.equal(result.verdict_class, "DEFECT");
  assert.equal(result.failure_attribution, "pre_existing_product");
});
