import test from "node:test";
import assert from "node:assert/strict";

import {
  applyObservationLifecycle,
  createObservationArtifact,
  evaluateObservationLifecycle,
} from "./observation-lifecycle.js";

function createObservation(overrides = {}) {
  return {
    category: "pre_execution_gate",
    confidence: 1,
    payload: {
      decision: "blocked",
      operation: "danger.full_access",
    },
    policyRefs: ["policy/pre_execution_gate/v1"],
    sourceId: "task-1:gate-block",
    sourceKind: "pre_execution_gate",
    summary: "blocked dangerous operation",
    ...overrides,
  };
}

test("evaluateObservationLifecycle keeps unprocessed observations in hot storage by default", () => {
  const artifact = createObservationArtifact({
    createdAt: "2026-03-01T00:00:00.000Z",
    observation: createObservation(),
  });
  const decision = evaluateObservationLifecycle({
    artifact,
    now: "2026-04-04T00:00:00.000Z",
  });

  assert.equal(decision.action, "retain_hot");
  assert.equal(decision.next_storage_tier, "hot");
  assert.match(decision.reason, /unprocessed observations remain in the hot path/i);
});

test("evaluateObservationLifecycle archives processed hot observations after retention window", () => {
  const artifact = createObservationArtifact({
    createdAt: "2026-03-20T00:00:00.000Z",
    observation: createObservation(),
    processedAt: "2026-03-22T00:00:00.000Z",
  });
  const decision = evaluateObservationLifecycle({
    artifact,
    now: "2026-04-04T00:00:00.000Z",
  });

  assert.equal(decision.action, "archive");
  assert.equal(decision.next_storage_tier, "archive");
  assert.equal(decision.updated_artifact.storage_tier, "archive");
  assert.equal(decision.updated_artifact.archived_at, "2026-04-04T00:00:00.000Z");
});

test("evaluateObservationLifecycle purges aged archived artifacts", () => {
  const artifact = createObservationArtifact({
    archivedAt: "2026-03-01T00:00:00.000Z",
    createdAt: "2026-02-15T00:00:00.000Z",
    observation: createObservation(),
    processedAt: "2026-02-20T00:00:00.000Z",
    storageTier: "archive",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  const decision = evaluateObservationLifecycle({
    artifact,
    now: "2026-04-04T00:00:00.000Z",
  });

  assert.equal(decision.action, "purge");
  assert.equal(decision.next_storage_tier, "purged");
  assert.equal(decision.updated_artifact.storage_tier, "purged");
  assert.equal(decision.updated_artifact.purged_at, "2026-04-04T00:00:00.000Z");
});

test("applyObservationLifecycle summarizes retain, archive, and purge actions", () => {
  const result = applyObservationLifecycle({
    artifacts: [
      createObservationArtifact({
        createdAt: "2026-03-01T00:00:00.000Z",
        observation: createObservation({ sourceId: "task-1:gate-block" }),
      }),
      createObservationArtifact({
        createdAt: "2026-03-20T00:00:00.000Z",
        observation: createObservation({ sourceId: "task-2:gate-block" }),
        processedAt: "2026-03-22T00:00:00.000Z",
      }),
      createObservationArtifact({
        archivedAt: "2026-03-01T00:00:00.000Z",
        createdAt: "2026-02-15T00:00:00.000Z",
        observation: createObservation({ sourceId: "task-3:gate-block" }),
        processedAt: "2026-02-20T00:00:00.000Z",
        storageTier: "archive",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    ],
    now: "2026-04-04T00:00:00.000Z",
  });

  assert.deepEqual(result.summary, {
    archive: 1,
    purge: 1,
    retain_hot: 1,
    total: 3,
  });
});
