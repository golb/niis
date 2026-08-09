import test from "node:test";
import assert from "node:assert/strict";

import { evaluateObservationGuardian } from "./observation-guardian.js";

test("evaluateObservationGuardian allows observation after cheapest-first checks pass", () => {
  const result = evaluateObservationGuardian({
    activitySignal: {
      observedAt: "2026-04-04T10:58:00.000Z",
      state: "idle",
      supported: true,
    },
    now: "2026-04-04T11:00:00.000Z",
    observerTurn: 1,
    projectId: "example-project",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.checks.length, 4);
  assert.equal(result.checks.every((check) => check.allowed), true);
  assert.equal(result.observation_signal.source_kind, "background_observer_guardian");
});

test("evaluateObservationGuardian blocks on project cooldown before activity checks", () => {
  const result = evaluateObservationGuardian({
    activitySignal: {
      observedAt: "2026-04-04T11:00:00.000Z",
      state: "idle",
      supported: true,
    },
    lastObservationAt: "2026-04-04T10:59:00.000Z",
    now: "2026-04-04T11:00:00.000Z",
    observerTurn: 1,
    projectId: "example-project",
    policy: {
      background_analysis: {
        project_cooldown_ms: 120000,
      },
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks[1].name, "project_cooldown");
  assert.match(result.checks[1].reason ?? "", /cooldown remains active/i);
});

test("evaluateObservationGuardian blocks when activity signal is unsupported and fail mode skips observation", () => {
  const result = evaluateObservationGuardian({
    activitySignal: {
      supported: false,
    },
    now: "2026-04-04T11:00:00.000Z",
    observerTurn: 1,
    projectId: "example-project",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.checks.at(-1)?.name, "activity_signal");
  assert.match(result.checks.at(-1)?.reason ?? "", /activity signal is unavailable/i);
});

test("evaluateObservationGuardian can allow observation without activity signal under explicit fail mode", () => {
  const result = evaluateObservationGuardian({
    activitySignal: {
      supported: false,
    },
    now: "2026-04-04T11:00:00.000Z",
    observerTurn: 1,
    projectId: "example-project",
    policy: {
      background_analysis: {
        activity_signal: {
          fail_mode: "allow_without_signal",
          required_state: "idle",
        },
      },
    },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.checks.at(-1)?.allowed, true);
});
