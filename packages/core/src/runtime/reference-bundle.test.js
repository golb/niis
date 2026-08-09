import test from "node:test";
import assert from "node:assert/strict";

import {
  ReferenceBundleError,
  assertColdStartExecutable,
  createReferenceBundle,
  refineReferenceBundle,
} from "./reference-bundle.js";

test("createReferenceBundle marks external content with provenance and cold-start audit", () => {
  const bundle = createReferenceBundle({
    documentationPriority: ["docs/guide.md"],
    guides: [
      {
        content: "Treat imported snippets as untrusted.",
        external: true,
        source_ref: "https://example.test/doc",
        title: "External guide",
      },
    ],
    stepCatalog: ["Inspect the target paths before editing."],
    targetPaths: ["src/app.js"],
    taskId: "task-1",
  });

  assert.equal(bundle.guides[0].trust_level, "external");
  assert.equal(bundle.guides[0].provenance.source_ref, "https://example.test/doc");
  assert.equal(bundle.cold_start.executable, true);
});

test("assertColdStartExecutable rejects incomplete bundles", () => {
  assert.throws(
    () =>
      assertColdStartExecutable({
        documentationPriority: [],
        guides: [],
        targetPaths: [],
        taskId: "task-2",
      }),
    ReferenceBundleError,
  );
});

test("refineReferenceBundle appends new context and refinement history", () => {
  const initialBundle = createReferenceBundle({
    documentationPriority: ["docs/initial.md"],
    guides: ["Base guide"],
    targetPaths: ["src/index.js"],
    taskId: "task-3",
  });
  const refinedBundle = refineReferenceBundle({
    additions: {
      examples: [
        {
          content: "Use explicit file extensions in local imports.",
          title: "Example",
        },
      ],
    },
    bundle: initialBundle,
    reason: "adapter requested an example",
  });

  assert.equal(refinedBundle.examples.length, 1);
  assert.equal(refinedBundle.refinement_history.length, 1);
  assert.equal(refinedBundle.cold_start.executable, true);
});
