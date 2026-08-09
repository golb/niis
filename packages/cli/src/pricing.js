import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRICING_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../config/pricing.json",
);

let cachedConfig = null;

function loadPricingConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  if (!fs.existsSync(PRICING_CONFIG_PATH)) {
    cachedConfig = { models: {}, runtime_defaults: {} };
    return cachedConfig;
  }

  try {
    cachedConfig = JSON.parse(fs.readFileSync(PRICING_CONFIG_PATH, "utf8"));
  } catch {
    cachedConfig = { models: {}, runtime_defaults: {} };
  }

  return cachedConfig;
}

function resolveModelPricing({ modelId, runtimeId }) {
  const config = loadPricingConfig();
  const explicitId = typeof modelId === "string" && modelId.trim() !== "" ? modelId.trim() : null;
  const resolvedModelId = explicitId
    ?? (runtimeId && config.runtime_defaults?.[runtimeId]);

  if (!resolvedModelId) {
    if (runtimeId) {
      throw new Error(`No pricing model is configured for runtime: ${runtimeId}`);
    }
    return null;
  }

  const pricing = config.models?.[resolvedModelId];
  if (!pricing) {
    throw new Error(`No pricing is configured for model: ${resolvedModelId}`);
  }

  return {
    cached_input_per_mtok: Number(pricing.cached_input ?? pricing.input ?? 0),
    input_per_mtok: Number(pricing.input ?? 0),
    model_id: resolvedModelId,
    output_per_mtok: Number(pricing.output ?? 0),
  };
}

function computeEstimatedUsd({
  inputTokens = 0,
  cachedInputTokens = 0,
  outputTokens = 0,
  modelId = null,
  runtimeId = null,
} = {}) {
  const pricing = resolveModelPricing({ modelId, runtimeId });
  if (!pricing) {
    return 0;
  }

  const cached = Math.max(0, Number(cachedInputTokens) || 0);
  const totalInput = Math.max(0, Number(inputTokens) || 0);
  const uncached = Math.max(0, totalInput - cached);
  const output = Math.max(0, Number(outputTokens) || 0);

  const cost = (uncached * pricing.input_per_mtok
    + cached * pricing.cached_input_per_mtok
    + output * pricing.output_per_mtok) / 1_000_000;

  return Math.round(cost * 1_000_000) / 1_000_000;
}

export {
  computeEstimatedUsd,
  loadPricingConfig,
  resolveModelPricing,
};
