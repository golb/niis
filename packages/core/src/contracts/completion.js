import { createApprovalBlocker } from "../state/authority.js";

function createEvidenceBlocker(reason) {
  return {
    blocker_class: "MISSING_EVIDENCE",
    reason,
    next_action: "Collect the required verdict, evidence packet, and explainability record before completion.",
  };
}

function validateCompletionRequirements({
  actorRole,
  executorAgentId,
  reviewerAgentId,
  verdict,
  evidencePacket,
  explainabilityRecord,
}) {
  if (!["reviewer", "validator", "operator"].includes(actorRole)) {
    return {
      ok: false,
      blocker: createApprovalBlocker("Completion requires reviewer, validator, or operator authority."),
      diagnostics: "Actor role is not authorized to finalize a task.",
    };
  }

  if (!verdict) {
    return {
      ok: false,
      blocker: createEvidenceBlocker("Completion requires a review or validator verdict."),
      diagnostics: "Missing verdict artifact.",
    };
  }

  if (!evidencePacket) {
    return {
      ok: false,
      blocker: createEvidenceBlocker("Completion requires an evidence packet."),
      diagnostics: "Missing evidence packet artifact.",
    };
  }

  if (!explainabilityRecord) {
    return {
      ok: false,
      blocker: createEvidenceBlocker("Completion requires an explainability record."),
      diagnostics: "Missing explainability record.",
    };
  }

  if (verdict.verdict_class !== "PASS") {
    return {
      ok: false,
      blocker: createEvidenceBlocker("Completion requires verdict_class PASS."),
      diagnostics: "Verdict class is not PASS.",
    };
  }

  if (executorAgentId && reviewerAgentId && executorAgentId === reviewerAgentId) {
    return {
      ok: false,
      blocker: createApprovalBlocker(
        "Reviewer authority is invalid because reviewer and executor are the same agent instance.",
      ),
      diagnostics: "reviewer != executor invariant violated.",
    };
  }

  return {
    ok: true,
    blocker: null,
    diagnostics: "Completion requirements satisfied.",
  };
}

export {
  createEvidenceBlocker,
  validateCompletionRequirements,
};
