import assert from "node:assert/strict";
import test from "node:test";

import {
  LayeredContextError,
  createLayeredContext,
  loadLayeredContext,
} from "./layered-context.js";

test("project context overrides organization and core with complete provenance", () => {
  const context = createLayeredContext({
    core: [{
      content: "core value",
      id: "policy",
      provenance: { source_ref: "builtin/policy" },
    }],
    organization: [{
      content: "organization value",
      id: "policy",
      provenance: { source_ref: "organization/policy" },
    }],
    project: [{
      content: "project value",
      id: "policy",
      provenance: { source_ref: "project/policy" },
    }],
  });

  assert.equal(context.effective_entries.length, 1);
  assert.equal(context.effective_entries[0].content, "project value");
  assert.equal(context.effective_entries[0].layer, "project");
  assert.deepEqual(
    context.effective_entries[0].provenance.override_chain.map((entry) => entry.layer),
    ["core", "organization", "project"],
  );
});

test("on-demand context is loaded only by an explicit stable id", () => {
  const context = createLayeredContext({
    core: [
      { content: "always", id: "baseline" },
      { content: "later", id: "specialist", load: "on_demand" },
    ],
  });

  const initial = loadLayeredContext(context);
  assert.deepEqual(initial.loaded_ids, ["baseline"]);
  assert.deepEqual(initial.available_on_demand, ["specialist"]);

  const refined = loadLayeredContext(context, {
    requestedIds: ["specialist"],
  });
  assert.deepEqual(refined.loaded_ids, ["baseline", "specialist"]);
  assert.deepEqual(refined.available_on_demand, []);
});

test("unknown progressive context requests fail closed", () => {
  assert.throws(
    () => loadLayeredContext(createLayeredContext(), {
      requestedIds: ["missing"],
    }),
    (error) =>
      error instanceof LayeredContextError
      && error.code === "context_id_unavailable",
  );
});
