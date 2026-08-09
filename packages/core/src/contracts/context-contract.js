import { createHash } from "node:crypto";

import { SchemaValidationError } from "../schemas/shared.js";
import { CONTEXT_SOURCES, parseContextContract } from "../schemas/context-contract.js";

class ContextContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContextContractError";
  }
}







class ContextContractViolationError extends Error {
  constructor({ roleId = null, violationKind = "unclassified_source", violations = [] } = {}) {
    const normalizedViolations = Array.isArray(violations) ? violations.map(String) : [String(violations)];
    super(`Context contract violation for role ${roleId ?? "unknown-role"}: ${normalizedViolations.join("; ")}`);
    this.name = "ContextContractViolationError";
    this.code = "context_contract_violation";
    this.role_id = roleId ?? null;
    this.violation_kind = violationKind;
    this.violations = Object.freeze([...normalizedViolations]);
  }
}




const CONTEXT_CONTRACT_ALWAYS_ALLOWED_SOURCES = Object.freeze(["task_spec"]);





const GUIDE_SOURCE_TYPE_TO_CONTEXT_SOURCE = Object.freeze({
  acceptance_check: "acceptance_checks",
  doc_ref: "doc_refs",
  inline: "operator_guidance",
  operator_guidance: "operator_guidance",
  prior_attempt: "prior_attempt",
  project: "operator_guidance",
});





function normalizeContextContract(raw, { roleId = null } = {}) {
  if (raw === undefined || raw === null) {
    return null;
  }

  let parsed;
  try {
    parsed = parseContextContract(raw);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new ContextContractViolationError({
        roleId,
        violationKind: "invalid_contract",
        violations: error.errors,
      });
    }
    throw error;
  }

  return Object.freeze({
    allow: Object.freeze([...new Set(parsed.allow)].sort()),
    version: parsed.version,
  });
}

function isContextSourceAllowed(contract, source) {
  if (!contract) {
    return true;
  }

  if (!CONTEXT_SOURCES.includes(source)) {
    return false;
  }

  return CONTEXT_CONTRACT_ALWAYS_ALLOWED_SOURCES.includes(source)
    || contract.allow.includes(source);
}

function classifyGuideSource(entry) {
  if (typeof entry === "string") {
    return GUIDE_SOURCE_TYPE_TO_CONTEXT_SOURCE.inline;
  }

  const sourceType = entry?.provenance?.source_type ?? entry?.source_type ?? "inline";
  return GUIDE_SOURCE_TYPE_TO_CONTEXT_SOURCE[sourceType] ?? null;
}







function partitionExecutionGuides({ contract = null, roleId = null, guides = [] } = {}) {
  const normalizedGuides = Array.isArray(guides) ? guides : [];
  const entries = [];
  for (const guide of normalizedGuides) {
    const content = typeof guide === "string"
      ? guide
      : (typeof guide?.content === "string" ? guide.content : null);
    if (!content) {
      continue;
    }
    entries.push({ content, source: classifyGuideSource(guide) });
  }

  if (!contract) {
    return Object.freeze(entries.map((entry) => Object.freeze(entry)));
  }

  const unclassified = entries.filter((entry) => entry.source === null);
  if (unclassified.length > 0) {
    throw new ContextContractViolationError({
      roleId,
      violationKind: "unclassified_source",
      violations: unclassified.map((entry) =>
        `guide entry "${entry.content.slice(0, 80)}" carries no recognized context source`),
    });
  }

  return Object.freeze(
    entries
      .filter((entry) => isContextSourceAllowed(contract, entry.source))
      .map((entry) => Object.freeze(entry)),
  );
}









const AGENT_TICK_ALLOWED_ARGUMENT_KEYS = Object.freeze(["task_id"]);

function assertAgentTickWithinContextContract({
  contract = null,
  roleId = null,
  task = {},
  toolCall = {},
} = {}) {
  if (!contract) {
    throw new ContextContractViolationError({
      roleId,
      violationKind: "missing_contract",
      violations: [
        "package agents with external connectivity must declare a context_contract; absence fails closed for agent ticks",
      ],
    });
  }

  const args = toolCall?.arguments
    && typeof toolCall.arguments === "object"
    && !Array.isArray(toolCall.arguments)
    ? toolCall.arguments
    : {};
  const violations = [];
  for (const key of Object.keys(args)) {
    if (!AGENT_TICK_ALLOWED_ARGUMENT_KEYS.includes(key)) {
      violations.push(
        `tool argument "${key}" is outside the tick contract (allowed: ${AGENT_TICK_ALLOWED_ARGUMENT_KEYS.join(", ")})`,
      );
    }
  }





  const parentTaskId = typeof task?.parent_task_id === "string" ? task.parent_task_id : null;
  if (Object.prototype.hasOwnProperty.call(args, "task_id")) {
    if (typeof args.task_id !== "string") {
      violations.push(
        `tool argument "task_id" must be a string, got ${Array.isArray(args.task_id) ? "array" : typeof args.task_id}`,
      );
    } else if (args.task_id !== parentTaskId) {
      violations.push(
        `tick targets task "${args.task_id}" but is bound to parent task "${parentTaskId ?? "(none)"}" — a tick may only execute the task assigned to this agent`,
      );
    }
  }
  if (violations.length > 0) {
    throw new ContextContractViolationError({
      roleId,
      violationKind: "tick_outside_contract",
      violations,
    });
  }

  return Object.freeze({ ok: true });
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}




function createContextContractDigest(contract) {
  if (!contract) {
    return null;
  }

  return createHash("sha256")
    .update(canonicalJson({ allow: [...contract.allow], version: contract.version }))
    .digest("hex");
}

const CONTEXT_CONTRACT_DIGEST_NOTE_PREFIX = "niis-context-contract-sha256:";

function createContextContractDigestNote(digest) {
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new ContextContractError("digest must be a 64-character lowercase hex sha256 string");
  }

  return `${CONTEXT_CONTRACT_DIGEST_NOTE_PREFIX}${digest}`;
}

export {
  AGENT_TICK_ALLOWED_ARGUMENT_KEYS,
  CONTEXT_CONTRACT_ALWAYS_ALLOWED_SOURCES,
  CONTEXT_CONTRACT_DIGEST_NOTE_PREFIX,
  ContextContractError,
  ContextContractViolationError,
  GUIDE_SOURCE_TYPE_TO_CONTEXT_SOURCE,
  assertAgentTickWithinContextContract,
  classifyGuideSource,
  createContextContractDigest,
  createContextContractDigestNote,
  isContextSourceAllowed,
  normalizeContextContract,
  partitionExecutionGuides,
};
