import assert from "node:assert/strict";
import test from "node:test";
import { computeEstimatedUsd } from "./pricing.js";

test("cost estimation fails closed for unknown models and runtimes", () => {
  assert.throws(
    () => computeEstimatedUsd({ inputTokens: 1, modelId: "unpriced-model" }),
    /No pricing is configured for model: unpriced-model/u,
  );
  assert.throws(
    () => computeEstimatedUsd({ inputTokens: 1, runtimeId: "unpriced-runtime" }),
    /No pricing model is configured for runtime: unpriced-runtime/u,
  );
});
