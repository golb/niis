import { createHash } from "node:crypto";

const PLAN_APPROVAL_DIGEST_NOTE_PREFIX = "niis-plan-sha256:";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error("plan approval input must be JSON serializable");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function createPlanApprovalDigest({
  artifact,
  runtimePreferences = null,
  task,
} = {}) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("task is required to bind a plan approval");
  }
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("intake artifact is required to bind a plan approval");
  }

  const approvedTaskPlan = {
    acceptance_commands: task.acceptance_commands ?? [],
    acceptance_markdown: task.acceptance_markdown ?? null,
    details_markdown: task.details_markdown ?? null,
    id: task.id ?? null,
    operator_brief_markdown: task.operator_brief_markdown ?? null,
    out_of_scope: task.out_of_scope ?? [],
    phase: task.phase ?? null,
    priority: task.priority ?? null,
    title: task.title ?? null,
  };
  return createHash("sha256")
    .update(canonicalJson({
      artifact,
      runtime_preferences: runtimePreferences ?? null,
      task: approvedTaskPlan,
    }))
    .digest("hex");
}

function createPlanApprovalDigestNote(digest) {
  if (typeof digest !== "string" || !SHA256_PATTERN.test(digest)) {
    throw new Error("plan approval digest must be a lowercase SHA-256 value");
  }
  return `${PLAN_APPROVAL_DIGEST_NOTE_PREFIX}${digest}`;
}

function hasPlanApprovalDigest(approval, digest) {
  if (
    !approval
    || typeof approval !== "object"
    || typeof digest !== "string"
    || !SHA256_PATTERN.test(digest)
    || !Array.isArray(approval.notes)
  ) {
    return false;
  }
  const expected = createPlanApprovalDigestNote(digest);
  return approval.notes.some((note) => note === expected);
}

export {
  PLAN_APPROVAL_DIGEST_NOTE_PREFIX,
  createPlanApprovalDigest,
  createPlanApprovalDigestNote,
  hasPlanApprovalDigest,
};
