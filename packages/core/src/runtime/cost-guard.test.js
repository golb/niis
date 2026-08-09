import test from "node:test";
import assert from "node:assert/strict";

import { createRoleBudgetGuard, createRunCostGuard, currentMonthBucket } from "./cost-guard.js";

test("createRunCostGuard accumulates and triggers shouldAbort at cap", () => {
  const guard = createRunCostGuard({ capUsd: 0.5 });
  guard.accumulate(0.2);
  assert.equal(guard.shouldAbort(), false);
  guard.accumulate(0.4);
  assert.equal(guard.shouldAbort(), true);
});

test("createRunCostGuard with no cap never aborts", () => {
  const guard = createRunCostGuard({ capUsd: null });
  guard.accumulate(1000);
  assert.equal(guard.shouldAbort(), false);
});

test("createRoleBudgetGuard canDispatch respects monthly cap", () => {
  const guard = createRoleBudgetGuard({ currentSpend: 8, monthlyCap: 10, roleId: "frontend" });
  assert.equal(guard.canDispatch(1), true);
  assert.equal(guard.canDispatch(2), false);
});

test("currentMonthBucket returns YYYY-MM format", () => {
  const bucket = currentMonthBucket(new Date(Date.UTC(2026, 3, 18)));
  assert.equal(bucket, "2026-04");
});
