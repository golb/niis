const CONTEXT_LAYER_ORDER = Object.freeze([
  "core",
  "organization",
  "project",
]);

const CONTEXT_LOAD_MODES = Object.freeze([
  "eager",
  "on_demand",
]);

class LayeredContextError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "LayeredContextError";
    this.code = options.code ?? "layered_context_error";
  }
}

function ensurePlainObject(value, label) {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new LayeredContextError(`${label} must be a plain object`);
  }
  return value;
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LayeredContextError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeLayerEntries(entries, layer) {
  if (entries === undefined || entries === null) {
    return Object.freeze([]);
  }
  if (!Array.isArray(entries)) {
    throw new LayeredContextError(`${layer} context must be an array`);
  }

  const seen = new Set();
  return Object.freeze(entries.map((rawEntry, index) => {
    const entry = ensurePlainObject(rawEntry, `${layer}[${index}]`);
    const id = ensureNonEmptyString(
      entry.id ?? entry.key,
      `${layer}[${index}].id`,
    );
    if (seen.has(id)) {
      throw new LayeredContextError(
        `${layer} context contains duplicate id ${id}`,
        { code: "duplicate_context_id" },
      );
    }
    seen.add(id);

    const load = entry.load ?? entry.load_mode ?? "eager";
    if (!CONTEXT_LOAD_MODES.includes(load)) {
      throw new LayeredContextError(
        `${layer}[${index}].load must be one of: ${CONTEXT_LOAD_MODES.join(", ")}`,
      );
    }
    const provenance = ensurePlainObject(
      entry.provenance,
      `${layer}[${index}].provenance`,
    );

    return Object.freeze({
      content: ensureNonEmptyString(
        entry.content ?? entry.value,
        `${layer}[${index}].content`,
      ),
      id,
      layer,
      load,
      provenance: Object.freeze({
        source_ref: ensureNonEmptyString(
          provenance.source_ref ?? `${layer}:${id}`,
          `${layer}[${index}].provenance.source_ref`,
        ),
        source_type: ensureNonEmptyString(
          provenance.source_type ?? layer,
          `${layer}[${index}].provenance.source_type`,
        ),
      }),
    });
  }));
}

function createLayeredContext(input = {}) {
  const normalizedInput = ensurePlainObject(input, "layeredContext");
  const layers = {};
  const historyById = new Map();

  for (const layer of CONTEXT_LAYER_ORDER) {
    const entries = normalizeLayerEntries(
      normalizedInput[layer]
        ?? (layer === "organization" ? normalizedInput.org : undefined),
      layer,
    );
    layers[layer] = entries;
    for (const entry of entries) {
      const history = historyById.get(entry.id) ?? [];
      history.push(entry);
      historyById.set(entry.id, history);
    }
  }

  const effectiveEntries = [];
  for (const [id, history] of historyById.entries()) {
    const selected = history.at(-1);
    effectiveEntries.push(Object.freeze({
      ...selected,
      provenance: Object.freeze({
        ...selected.provenance,
        override_chain: Object.freeze(history.map((entry) => Object.freeze({
          layer: entry.layer,
          source_ref: entry.provenance.source_ref,
          source_type: entry.provenance.source_type,
        }))),
      }),
    }));
  }

  effectiveEntries.sort((left, right) => {
    const layerDelta =
      CONTEXT_LAYER_ORDER.indexOf(left.layer)
      - CONTEXT_LAYER_ORDER.indexOf(right.layer);
    return layerDelta || left.id.localeCompare(right.id);
  });

  return Object.freeze({
    layer_order: CONTEXT_LAYER_ORDER,
    layers: Object.freeze(layers),
    effective_entries: Object.freeze(effectiveEntries),
  });
}

function loadLayeredContext(input, {
  requestedIds = [],
} = {}) {
  const context = input?.effective_entries
    ? input
    : createLayeredContext(input);
  if (!Array.isArray(requestedIds)) {
    throw new LayeredContextError("requestedIds must be an array");
  }

  const requested = new Set(
    requestedIds.map((value, index) =>
      ensureNonEmptyString(value, `requestedIds[${index}]`)),
  );
  const knownIds = new Set(context.effective_entries.map((entry) => entry.id));
  const missingIds = [...requested].filter((id) => !knownIds.has(id));
  if (missingIds.length > 0) {
    throw new LayeredContextError(
      `requested context IDs are unavailable: ${missingIds.join(", ")}`,
      { code: "context_id_unavailable" },
    );
  }

  const entries = context.effective_entries.filter(
    (entry) => entry.load === "eager" || requested.has(entry.id),
  );
  const deferredIds = context.effective_entries
    .filter((entry) => entry.load === "on_demand" && !requested.has(entry.id))
    .map((entry) => entry.id);

  return Object.freeze({
    available_on_demand: Object.freeze(deferredIds),
    entries: Object.freeze(entries),
    loaded_ids: Object.freeze(entries.map((entry) => entry.id)),
    requested_ids: Object.freeze([...requested]),
  });
}

export {
  CONTEXT_LAYER_ORDER,
  CONTEXT_LOAD_MODES,
  LayeredContextError,
  createLayeredContext,
  loadLayeredContext,
};
