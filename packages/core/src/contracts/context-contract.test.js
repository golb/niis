import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTEXT_CONTRACT_DIGEST_NOTE_PREFIX,
  ContextContractError,
  ContextContractViolationError,
  assertAgentTickWithinContextContract,
  classifyGuideSource,
  createContextContractDigest,
  createContextContractDigestNote,
  isContextSourceAllowed,
  normalizeContextContract,
  partitionExecutionGuides,
} from "./context-contract.js";

const BASE_RAW_CONTRACT = Object.freeze({
  version: 1,
  allow: Object.freeze(["operator_guidance", "role_persona"]),
});

function buildGuide(content, sourceType) {
  return {
    content,
    provenance: { source_ref: "test", source_type: sourceType },
  };
}

test("normalizeContextContract returns null for an absent contract", () => {
  assert.equal(normalizeContextContract(null), null);
  assert.equal(normalizeContextContract(undefined), null);
});

test("normalizeContextContract dedupes and sorts the allow-list", () => {
  const contract = normalizeContextContract({
    allow: ["role_persona", "operator_guidance", "role_persona"],
  });

  assert.deepEqual(contract.allow, ["operator_guidance", "role_persona"]);
  assert.equal(contract.version, 1);
  assert.ok(Object.isFrozen(contract));
  assert.ok(Object.isFrozen(contract.allow));
});

test("normalizeContextContract raises a fail-closed violation for an invalid declaration", () => {
  assert.throws(
    () => normalizeContextContract({ allow: ["secrets"] }, { roleId: "frontend-specialist" }),
    (error) => error instanceof ContextContractViolationError
      && error.code === "context_contract_violation"
      && error.violation_kind === "invalid_contract"
      && error.role_id === "frontend-specialist",
  );
});

test("isContextSourceAllowed denies by default and always allows task_spec", () => {
  const contract = normalizeContextContract(BASE_RAW_CONTRACT);

  assert.equal(isContextSourceAllowed(contract, "role_persona"), true);
  assert.equal(isContextSourceAllowed(contract, "doc_refs"), false);
  assert.equal(isContextSourceAllowed(contract, "task_spec"), true);
  assert.equal(isContextSourceAllowed(contract, "not_a_source"), false);
  assert.equal(isContextSourceAllowed(null, "doc_refs"), true);
});

test("classifyGuideSource maps provenance source types onto contract sources", () => {
  assert.equal(classifyGuideSource("plain string"), "operator_guidance");
  assert.equal(classifyGuideSource(buildGuide("x", "acceptance_check")), "acceptance_checks");
  assert.equal(classifyGuideSource(buildGuide("x", "doc_ref")), "doc_refs");
  assert.equal(classifyGuideSource(buildGuide("x", "prior_attempt")), "prior_attempt");
  assert.equal(classifyGuideSource(buildGuide("x", "inline")), "operator_guidance");
  assert.equal(classifyGuideSource(buildGuide("x", "project")), "operator_guidance");
  assert.equal(classifyGuideSource(buildGuide("x", "external")), null);
});

test("partitionExecutionGuides preserves every entry in order without a contract", () => {
  const entries = partitionExecutionGuides({
    contract: null,
    guides: [
      "first",
      buildGuide("second", "doc_ref"),
      buildGuide("third", "external"),
    ],
  });

  assert.deepEqual(entries.map((entry) => entry.content), ["first", "second", "third"]);
  assert.equal(entries[2].source, null);
});

test("partitionExecutionGuides filters entries outside the allow-list", () => {
  const contract = normalizeContextContract({ allow: ["operator_guidance"] });
  const entries = partitionExecutionGuides({
    contract,
    guides: [
      "kept",
      buildGuide("dropped doc ref", "doc_ref"),
      buildGuide("dropped prior attempt", "prior_attempt"),
    ],
    roleId: "generalist-worker",
  });

  assert.deepEqual(entries.map((entry) => entry.content), ["kept"]);
});

test("partitionExecutionGuides fails closed on unclassifiable entries under a contract", () => {
  const contract = normalizeContextContract({ allow: ["operator_guidance"] });

  assert.throws(
    () => partitionExecutionGuides({
      contract,
      guides: [buildGuide("mystery", "external")],
      roleId: "generalist-worker",
    }),
    (error) => error instanceof ContextContractViolationError
      && error.violation_kind === "unclassified_source"
      && error.role_id === "generalist-worker"
      && error.violations.length === 1,
  );
});

test("createContextContractDigest is deterministic and order-insensitive", () => {
  const first = createContextContractDigest(
    normalizeContextContract({ allow: ["role_persona", "operator_guidance"] }),
  );
  const second = createContextContractDigest(
    normalizeContextContract({ allow: ["operator_guidance", "role_persona"] }),
  );

  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(first, second);
  assert.equal(createContextContractDigest(null), null);
});

test("createContextContractDigest changes when the contract changes", () => {
  const base = createContextContractDigest(normalizeContextContract(BASE_RAW_CONTRACT));
  const widened = createContextContractDigest(
    normalizeContextContract({ ...BASE_RAW_CONTRACT, allow: [...BASE_RAW_CONTRACT.allow, "doc_refs"] }),
  );

  assert.notEqual(base, widened);
});

test("createContextContractDigestNote formats and validates the digest", () => {
  const digest = createContextContractDigest(normalizeContextContract(BASE_RAW_CONTRACT));
  const note = createContextContractDigestNote(digest);

  assert.equal(note, `${CONTEXT_CONTRACT_DIGEST_NOTE_PREFIX}${digest}`);
  assert.throws(() => createContextContractDigestNote("not-a-digest"), ContextContractError);
});

test("assertAgentTickWithinContextContract fails closed when the contract is absent", () => {
  assert.throws(
    () => assertAgentTickWithinContextContract({
      contract: null,
      roleId: "feed-collector",
      task: { parent_task_id: "collection-a" },
      toolCall: { name: "collect.run", arguments: { task_id: "collection-a" } },
    }),
    (error) => error instanceof ContextContractViolationError
      && error.violation_kind === "missing_contract"
      && error.role_id === "feed-collector",
  );
});

test("assertAgentTickWithinContextContract accepts a tick bound to its own parent task", () => {
  const contract = normalizeContextContract({ allow: ["task_spec", "role_persona"] });
  const result = assertAgentTickWithinContextContract({
    contract,
    roleId: "feed-collector",
    task: { parent_task_id: "collection-a" },
    toolCall: { name: "collect.run", arguments: { task_id: "collection-a" } },
  });
  assert.equal(result.ok, true);
});

test("assertAgentTickWithinContextContract accepts argument-less tool calls", () => {
  const contract = normalizeContextContract({ allow: ["task_spec"] });
  const result = assertAgentTickWithinContextContract({
    contract,
    roleId: "feed-collector",
    task: { parent_task_id: "collection-a" },
    toolCall: { name: "status", arguments: {} },
  });
  assert.equal(result.ok, true);
});

test("assertAgentTickWithinContextContract rejects a tick targeting a foreign task", () => {
  const contract = normalizeContextContract({ allow: ["task_spec", "role_persona"] });
  assert.throws(
    () => assertAgentTickWithinContextContract({
      contract,
      roleId: "feed-collector",
      task: { parent_task_id: "collection-a" },
      toolCall: { name: "collect.run", arguments: { task_id: "collection-b" } },
    }),
    (error) => error instanceof ContextContractViolationError
      && error.violation_kind === "tick_outside_contract"
      && /foreign|bound to parent task/u.test(error.message)
      && /collection-b/u.test(error.message),
  );
});

test("assertAgentTickWithinContextContract rejects tool arguments outside the tick allow-list", () => {
  const contract = normalizeContextContract({ allow: ["task_spec", "role_persona"] });
  assert.throws(
    () => assertAgentTickWithinContextContract({
      contract,
      roleId: "feed-collector",
      task: { parent_task_id: "collection-a" },
      toolCall: {
        name: "collect.run",
        arguments: { task_id: "collection-a", workspace_path: "/etc/passwd" },
      },
    }),
    (error) => error instanceof ContextContractViolationError
      && error.violations.some((entry) => entry.includes("workspace_path")),
  );
});

test("assertAgentTickWithinContextContract rejects present-but-non-string task_id values", () => {
  const contract = normalizeContextContract({ allow: ["task_spec", "role_persona"] });
  for (const badValue of [999, ["collection-b"], { $ne: null }, true, null]) {
    assert.throws(
      () => assertAgentTickWithinContextContract({
        contract,
        roleId: "feed-collector",
        task: { parent_task_id: "collection-a" },
        toolCall: { name: "collect.run", arguments: { task_id: badValue } },
      }),
      (error) => error instanceof ContextContractViolationError
        && error.violations.some((entry) => entry.includes("must be a string")),
      `task_id=${JSON.stringify(badValue)} must be a violation`,
    );
  }
});
