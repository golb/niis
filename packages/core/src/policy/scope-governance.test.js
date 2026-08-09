import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SCOPE_GOVERNANCE_POLICY,
  evaluateScopeBoundary,
  normalizeScopeGovernancePolicy,
} from "./scope-governance.js";

test("normalizeScopeGovernancePolicy keeps the canonical drift defaults", () => {
  const policy = normalizeScopeGovernancePolicy();

  assert.deepEqual(policy, DEFAULT_SCOPE_GOVERNANCE_POLICY);
});

test("evaluateScopeBoundary keeps unrelated host-product bugs outside current phase scope", () => {
  const result = evaluateScopeBoundary({
    candidate: {
      host_bug: true,
      proof_required: false,
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.disposition, "backlog_input");
});

test("evaluateScopeBoundary allows proof-driven bugfix exceptions only with full governance evidence", () => {
  const denied = evaluateScopeBoundary({
    candidate: {
      host_bug: true,
      proof_required: true,
      decision_log_ref: "docs/decisions/example.md",
      operator_approved_exception: false,
      proof_justification: "Need a narrow fix to validate the substrate.",
    },
  });
  const allowed = evaluateScopeBoundary({
    candidate: {
      host_bug: true,
      proof_required: true,
      decision_log_ref: "docs/decisions/example.md",
      operator_approved_exception: true,
      proof_justification: "Need a narrow fix to validate the substrate.",
    },
  });

  assert.equal(denied.allowed, false);
  assert.equal(denied.disposition, "evidence_only");
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.disposition, "proof_exception");
});
