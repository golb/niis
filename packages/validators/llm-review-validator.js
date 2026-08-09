import { createValidatorDefinition } from "../core/src/contracts/validator.js";













function parseReviewerJsonResponse(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/\{[^{}]*"verdict"\s*:\s*"[^"]+"[^{}]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeVerdictLabel(value) {
  if (typeof value !== "string") return null;
  const label = value.trim().toUpperCase();
  if (label === "PASS" || label === "ACCEPT" || label === "APPROVED") return "PASS";
  if (label === "DEFECT" || label === "FAIL" || label === "REJECT" || label === "REJECTED") return "DEFECT";
  if (label === "EVIDENCE_GAP" || label === "UNCLEAR" || label === "UNKNOWN") return "EVIDENCE_GAP";
  return null;
}

function collectReviewInputs({ task, evidencePacket }) {
  const items = Array.isArray(evidencePacket?.items) ? evidencePacket.items : [];
  const summaries = items
    .filter((entry) => entry && typeof entry.content === "string"
      && (entry.type === "subtask_summary" || entry.type === "run_log" || entry.type === "quality_gate_result"))
    .map((entry) => ({
      content: entry.content,
      source: entry.source ?? entry.type ?? "evidence",
      subtask_id: entry.subtask_id ?? null,
    }));
  const diffs = items
    .filter((entry) => entry && typeof entry.content === "string" && entry.type === "git_diff")
    .map((entry) => ({
      content: entry.content,
      source: entry.source ?? "git-diff",
      subtask_id: entry.subtask_id ?? null,
    }));





  let reviewTarget = null;
  const targetEntry = items.find((entry) => entry && entry.type === "review_target" && typeof entry.content === "string");
  if (targetEntry) {
    try {
      const parsed = JSON.parse(targetEntry.content);
      if (parsed && typeof parsed === "object") {
        reviewTarget = {
          branch_name: typeof parsed.branch_name === "string" ? parsed.branch_name : null,
          source_branch: typeof parsed.source_branch === "string" ? parsed.source_branch : null,
          subtask_id: targetEntry.subtask_id ?? null,
          worktree_path: typeof parsed.worktree_path === "string" ? parsed.worktree_path : null,
        };
      }
    } catch {
      reviewTarget = null;
    }
  }
  return {
    acceptance: task?.acceptance_markdown ?? null,
    brief: task?.operator_brief_markdown ?? task?.details_markdown ?? null,
    diffs,
    outOfScope: Array.isArray(task?.out_of_scope) ? task.out_of_scope : [],
    reviewTarget,
    summaries,
    title: task?.title ?? null,
  };
}

function createLlmReviewValidator() {
  return createValidatorDefinition({
    id: "llm_review",
    description: "LLM-backed acceptance-criteria reviewer. Asks an LLM whether the work satisfies the operator's acceptance criteria.",
    domain: "review.acceptance",
    excludedConcerns: ["evidence.authenticity", "security.catalog"],
    async validate({ task, evidencePacket, evidenceRuntime = {} }) {
      const llmReviewer = evidenceRuntime?.llmReviewer;
      if (typeof llmReviewer !== "function") {
        return {
          evidence_packet: evidencePacket,
          next_action: "Enable llm_review in .niis/project-config.json to get an acceptance-criteria review; otherwise operator must review manually.",
          policy_refs: ["policy/llm_review/v1"],
          reason: "LLM reviewer is not configured; skipping acceptance-criteria review.",
          verdict_class: "EVIDENCE_GAP",
        };
      }

      const inputs = collectReviewInputs({ evidencePacket, task });
      if (inputs.summaries.length === 0) {
        return {
          evidence_packet: evidencePacket,
          next_action: "Agent summaries are missing; cannot run acceptance-criteria review.",
          policy_refs: ["policy/llm_review/v1"],
          reason: "No agent summaries found in the evidence packet.",
          verdict_class: "EVIDENCE_GAP",
        };
      }

      let review;
      try {
        review = await llmReviewer(inputs);
      } catch (error) {
        return {
          evidence_packet: evidencePacket,
          next_action: "Retry the review or inspect the LLM reviewer runtime.",
          policy_refs: ["policy/llm_review/v1"],
          reason: `LLM reviewer errored: ${error.message}`,
          verdict_class: "EVIDENCE_GAP",
        };
      }

      const verdict = normalizeVerdictLabel(review?.verdict);
      const reason = (typeof review?.reason === "string" && review.reason.trim())
        ? review.reason.trim()
        : "LLM reviewer did not provide a reason.";
      const nextAction = (typeof review?.next_action === "string" && review.next_action.trim())
        ? review.next_action.trim()
        : "Proceed per LLM reviewer verdict.";

      const reviewEvidenceItem = {
        content: `LLM reviewer verdict: ${verdict ?? "UNKNOWN"}. ${reason}`,
        raw_output_ref: null,
        source: "llm_reviewer",
        subtask_id: null,
        type: "llm_review",
      };
      const augmentedPacket = evidencePacket
        ? {
          ...evidencePacket,
          items: [...(evidencePacket.items ?? []), reviewEvidenceItem],
        }
        : evidencePacket;

      if (verdict === "PASS") {
        return {
          evidence_packet: augmentedPacket,
          next_action: nextAction,
          observation_signals: [{
            category: "llm_review",
            confidence: 0.9,
            summary: "LLM reviewer marked acceptance criteria as satisfied.",
          }],
          policy_refs: ["policy/llm_review/v1"],
          reason,
          verdict_class: "PASS",
        };
      }

      if (verdict === "DEFECT") {
        return {
          blocker_class: "MISSING_EVIDENCE",
          evidence_packet: augmentedPacket,
          failure_attribution: "task_local",
          next_action: nextAction,
          observation_signals: [{
            category: "llm_review",
            confidence: 0.8,
            summary: "LLM reviewer flagged acceptance-criteria gaps.",
          }],
          policy_refs: ["policy/llm_review/v1"],
          reason,
          verdict_class: "DEFECT",
        };
      }

      return {
        evidence_packet: augmentedPacket,
        next_action: nextAction,
        policy_refs: ["policy/llm_review/v1"],
        reason,
        verdict_class: "EVIDENCE_GAP",
      };
    },
  });
}

export {
  createLlmReviewValidator,
  normalizeVerdictLabel,
  parseReviewerJsonResponse,
};
