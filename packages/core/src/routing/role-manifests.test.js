import assert from "node:assert";
import { test } from "node:test";

import {
  COORDINATOR_GENERALIST_MANIFEST,
  DEFAULT_EXECUTION_ROLE_MANIFESTS,
  DEFAULT_ROLE_MANIFESTS,
  FRONTEND_SPECIALIST_MANIFEST,
  GENERALIST_WORKER_MANIFEST,
  ROLE_TYPES,
  TASK_PLANNER_MANIFEST,
  VALIDATOR_MANIFEST,
  getCoordinatorManifest,
  getPlannerManifest,
  getRoleManifestById,
  getRoleManifestsByType,
  getSafeFallbackManifest,
  getWorkerManifests,
} from "./role-manifests.js";

test("DEFAULT_ROLE_MANIFESTS contains all canonical role manifests", () => {
  assert.equal(DEFAULT_ROLE_MANIFESTS.length, 7);

  const ids = DEFAULT_ROLE_MANIFESTS.map((manifest) => manifest.id);
  assert.ok(ids.includes("coordinator-generalist"));
  assert.ok(ids.includes("task-planner"));
  assert.ok(ids.includes("generalist-worker"));
  assert.ok(ids.includes("frontend-specialist"));
  assert.ok(ids.includes("nodejs-worker"));
  assert.ok(ids.includes("python-worker"));
  assert.ok(ids.includes("validator"));
});

test("COORDINATOR_GENERALIST_MANIFEST has correct role type and priority", () => {
  assert.equal(COORDINATOR_GENERALIST_MANIFEST.id, "coordinator-generalist");
  assert.equal(COORDINATOR_GENERALIST_MANIFEST.role_type, ROLE_TYPES.COORDINATOR);
  assert.equal(COORDINATOR_GENERALIST_MANIFEST.priority, 100);
  assert.equal(COORDINATOR_GENERALIST_MANIFEST.lane, "coordinator");
  assert.equal(COORDINATOR_GENERALIST_MANIFEST.safe_fallback, false);
  assert.ok(COORDINATOR_GENERALIST_MANIFEST.keywords.includes("coordinate"));
  assert.ok(COORDINATOR_GENERALIST_MANIFEST.keywords.includes("delegate"));
});

test("TASK_PLANNER_MANIFEST has correct role type and keywords", () => {
  assert.equal(TASK_PLANNER_MANIFEST.id, "task-planner");
  assert.equal(TASK_PLANNER_MANIFEST.role_type, ROLE_TYPES.PLANNER);
  assert.equal(TASK_PLANNER_MANIFEST.priority, 90);
  assert.equal(TASK_PLANNER_MANIFEST.lane, "planner");
  assert.ok(TASK_PLANNER_MANIFEST.keywords.includes("plan"));
  assert.ok(TASK_PLANNER_MANIFEST.keywords.includes("decompose"));
  assert.ok(TASK_PLANNER_MANIFEST.keywords.includes("subtask"));
});

test("GENERALIST_WORKER_MANIFEST is the safe fallback", () => {
  assert.equal(GENERALIST_WORKER_MANIFEST.id, "generalist-worker");
  assert.equal(GENERALIST_WORKER_MANIFEST.role_type, ROLE_TYPES.WORKER);
  assert.equal(GENERALIST_WORKER_MANIFEST.priority, 0);
  assert.equal(GENERALIST_WORKER_MANIFEST.lane, "generalist");
  assert.equal(GENERALIST_WORKER_MANIFEST.safe_fallback, true);
  assert.deepEqual(GENERALIST_WORKER_MANIFEST.adapter_requirements.toolFamilies, ["shell"]);




  const forbidden = ["ui", "frontend", "css", "html", "react", "node", "typescript", "python", "django", "flask"];
  for (const term of forbidden) {
    assert.ok(
      !GENERALIST_WORKER_MANIFEST.keywords.includes(term),
      `generalist must not claim specialist keyword "${term}"`,
    );
  }
});

test("DEFAULT_EXECUTION_ROLE_MANIFESTS only contains worker execution lanes", () => {
  assert.deepEqual(
    DEFAULT_EXECUTION_ROLE_MANIFESTS.map((manifest) => manifest.id),
    ["generalist-worker", "frontend-specialist", "nodejs-worker", "python-worker"],
  );
  assert.equal(
    DEFAULT_EXECUTION_ROLE_MANIFESTS.every((manifest) =>
      manifest.role_type === ROLE_TYPES.WORKER || manifest.role_type === ROLE_TYPES.SPECIALIST),
    true,
  );
});

test("FRONTEND_SPECIALIST_MANIFEST has frontend-related keywords", () => {
  assert.equal(FRONTEND_SPECIALIST_MANIFEST.id, "frontend-specialist");
  assert.equal(FRONTEND_SPECIALIST_MANIFEST.role_type, ROLE_TYPES.SPECIALIST);
  assert.equal(FRONTEND_SPECIALIST_MANIFEST.priority, 80);
  assert.equal(FRONTEND_SPECIALIST_MANIFEST.lane, "frontend");
  assert.ok(FRONTEND_SPECIALIST_MANIFEST.keywords.includes("ui"));
  assert.ok(FRONTEND_SPECIALIST_MANIFEST.keywords.includes("css"));
  assert.ok(FRONTEND_SPECIALIST_MANIFEST.keywords.includes("react"));
  assert.ok(FRONTEND_SPECIALIST_MANIFEST.keywords.includes("component"));
});

test("VALIDATOR_MANIFEST has review-related keywords", () => {
  assert.equal(VALIDATOR_MANIFEST.id, "validator");
  assert.equal(VALIDATOR_MANIFEST.role_type, ROLE_TYPES.VALIDATOR);
  assert.ok(VALIDATOR_MANIFEST.keywords.includes("review"));
  assert.ok(VALIDATOR_MANIFEST.keywords.includes("validate"));
  assert.ok(VALIDATOR_MANIFEST.keywords.includes("verdict"));
});

test("getRoleManifestById returns correct manifest", () => {
  const coordinator = getRoleManifestById("coordinator-generalist");
  assert.deepEqual(coordinator, COORDINATOR_GENERALIST_MANIFEST);

  const planner = getRoleManifestById("task-planner");
  assert.deepEqual(planner, TASK_PLANNER_MANIFEST);

  const unknown = getRoleManifestById("unknown-role");
  assert.equal(unknown, null);
});

test("getRoleManifestsByType returns manifests of the specified type", () => {
  const workers = getRoleManifestsByType(ROLE_TYPES.WORKER);
  assert.equal(workers.length, 3);
  const workerIds = workers.map((m) => m.id).sort();
  assert.deepEqual(workerIds, ["generalist-worker", "nodejs-worker", "python-worker"]);

  const specialists = getRoleManifestsByType(ROLE_TYPES.SPECIALIST);
  assert.equal(specialists.length, 1);
  assert.equal(specialists[0].id, "frontend-specialist");

  const coordinators = getRoleManifestsByType(ROLE_TYPES.COORDINATOR);
  assert.equal(coordinators.length, 1);
  assert.equal(coordinators[0].id, "coordinator-generalist");
});

test("getSafeFallbackManifest returns generalist-worker", () => {
  const fallback = getSafeFallbackManifest();
  assert.equal(fallback.id, "generalist-worker");
  assert.equal(fallback.safe_fallback, true);
});

test("getPlannerManifest returns task-planner", () => {
  const planner = getPlannerManifest();
  assert.equal(planner.id, "task-planner");
  assert.equal(planner.role_type, ROLE_TYPES.PLANNER);
});

test("getCoordinatorManifest returns coordinator-generalist", () => {
  const coordinator = getCoordinatorManifest();
  assert.equal(coordinator.id, "coordinator-generalist");
  assert.equal(coordinator.role_type, ROLE_TYPES.COORDINATOR);
});

test("getWorkerManifests returns worker and specialist roles", () => {
  const workers = getWorkerManifests();
  assert.equal(workers.length, 4);

  const ids = workers.map((m) => m.id);
  assert.ok(ids.includes("generalist-worker"));
  assert.ok(ids.includes("frontend-specialist"));
  assert.ok(ids.includes("nodejs-worker"));
  assert.ok(ids.includes("python-worker"));
});

test("role priority ordering is coordinator > planner > specialist > validator > worker", () => {
  assert.ok(COORDINATOR_GENERALIST_MANIFEST.priority > TASK_PLANNER_MANIFEST.priority);
  assert.ok(TASK_PLANNER_MANIFEST.priority > FRONTEND_SPECIALIST_MANIFEST.priority);
  assert.ok(FRONTEND_SPECIALIST_MANIFEST.priority > VALIDATOR_MANIFEST.priority);
  assert.ok(VALIDATOR_MANIFEST.priority > GENERALIST_WORKER_MANIFEST.priority);
});
