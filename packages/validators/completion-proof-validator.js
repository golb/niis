import { createValidatorDefinition } from "../core/src/contracts/validator.js";

function normalizeRequiredAcceptanceCommandIds({ observedOutcome = {}, task = {} } = {}) {
  const explicitIds =
    observedOutcome.required_acceptance_command_ids
    ?? observedOutcome.requiredAcceptanceCommandIds
    ?? null;

  if (Array.isArray(explicitIds)) {
    return [...new Set(explicitIds
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim()))];
  }

  const taskCommands =
    task.acceptance_commands
    ?? task.acceptanceCommands
    ?? [];

  if (!Array.isArray(taskCommands)) {
    return [];
  }

  return [...new Set(taskCommands
    .filter((command) => command?.required !== false)
    .map((command) => command?.id)
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim()))];
}

function normalizeAcceptanceCommandResults(observedOutcome = {}) {
  const candidate =
    observedOutcome.acceptance_command_results
    ?? observedOutcome.acceptanceCommandResults
    ?? [];

  return Array.isArray(candidate)
    ? candidate.filter((result) => result && typeof result === "object")
    : [];
}

function findCommandEvidenceItem(evidencePacket, commandId, rawOutputRef) {
  return (evidencePacket?.items ?? []).find((item) => {
    if (!item || item.raw_output_ref !== rawOutputRef) {
      return false;
    }

    const source = typeof item.source === "string" ? item.source : "";
    return (
      item.type === "quality_gate_result"
      || item.type === "acceptance_command_output"
      || item.type === "command_output"
    ) && (
      source === `acceptance-command:${commandId}`
      || source === `quality-gate:${commandId}`
      || source.endsWith(`:${commandId}`)
    );
  }) ?? null;
}

function evaluateAcceptanceCommandProof({ evidencePacket, observedOutcome, task }) {
  const requiredIds = normalizeRequiredAcceptanceCommandIds({ observedOutcome, task });
  const results = normalizeAcceptanceCommandResults(observedOutcome);

  if (requiredIds.length === 0) {
    return {
      next_action:
        "Declare at least one required acceptance command as an argv command plan, run it, and attach its raw output.",
      reason:
        "No required acceptance commands were declared. An agent completion signal or a completed run record is not proof of task completion.",
      verdict_class: "EVIDENCE_GAP",
    };
  }

  for (const commandId of requiredIds) {
    const result = results.find((entry) =>
      (entry.command_id ?? entry.commandId ?? entry.gate_id) === commandId);

    if (!result) {
      return {
        next_action: `Run required acceptance command ${commandId} and attach its raw output before requesting PASS.`,
        reason: `Required acceptance command ${commandId} has no recorded result.`,
        verdict_class: "EVIDENCE_GAP",
      };
    }

    if (result.ok !== true || Number(result.exit_code ?? result.exitCode ?? 1) !== 0) {
      return {
        failure_attribution: "task_local",
        next_action: `Fix the failure from required acceptance command ${commandId}, then run it again in a new review attempt.`,
        reason: `Required acceptance command ${commandId} failed.`,
        verdict_class: "DEFECT",
      };
    }

    const rawOutputRef = result.raw_output_ref ?? result.rawOutputRef ?? null;
    if (
      typeof rawOutputRef !== "string"
      || rawOutputRef.trim() === ""
      || !findCommandEvidenceItem(evidencePacket, commandId, rawOutputRef)
    ) {
      return {
        next_action:
          `Persist the raw output for required acceptance command ${commandId} and link it from the evidence packet.`,
        reason:
          `Required acceptance command ${commandId} passed, but its raw output is not attached as command evidence.`,
        verdict_class: "EVIDENCE_GAP",
      };
    }
  }

  return {
    next_action: "Required acceptance commands passed with raw-output-backed evidence.",
    reason: `All ${requiredIds.length} required acceptance command(s) passed with attached raw output.`,
    verdict_class: "PASS",
  };
}

function createCompletionProofValidator() {
  return createValidatorDefinition({
    id: "completion_proof",
    description: "Determines whether the run has enough authentic runtime proof to accept completion.",
    domain: "review.completion",
    excludedConcerns: ["evidence.authenticity", "security.catalog"],
    async validate({ evidencePacket, observedOutcome = {}, task = {} }) {
      const preExistingProductFailure =
        observedOutcome.pre_existing_product_failure
        ?? observedOutcome.preExistingProductFailure
        ?? null;
      const taskLocalDefect =
        observedOutcome.task_local_defect
        ?? observedOutcome.taskLocalDefect
        ?? null;
      const legacyDefectFound = observedOutcome.defect_found ?? null;

      if (observedOutcome.environment_blocked) {
        return {
          blocker_class: "ENV_BLOCK",
          evidence_packet: evidencePacket,
          next_action: "Repair the environment and retry the run before another review attempt.",
          policy_refs: ["policy/completion_proof/v1"],
          reason: observedOutcome.environment_blocked,
          verdict_class: "ENV_BLOCK",
        };
      }

      if (observedOutcome.escalation_required) {
        return {
          blocker_class: "MISSING_APPROVAL",
          evidence_packet: evidencePacket,
          next_action: "Escalate to an operator or higher-authority reviewer before retrying.",
          policy_refs: ["policy/completion_proof/v1"],
          reason: observedOutcome.escalation_required,
          verdict_class: "NEEDS_ESCALATION",
        };
      }

      if (preExistingProductFailure && taskLocalDefect) {
        return {
          blocker_class: "MISSING_APPROVAL",
          evidence_packet: evidencePacket,
          failure_attribution: "none",
          next_action:
            "Clarify whether the observed defect is pre-existing product debt or task-local regression before final review.",
          policy_refs: ["policy/completion_proof/v1"],
          reason:
            "Review input reported both pre-existing and task-local defect attribution for the same outcome.",
          verdict_class: "NEEDS_ESCALATION",
        };
      }

      if (preExistingProductFailure) {
        return {
          blocker_class: "MISSING_EVIDENCE",
          evidence_packet: evidencePacket,
          failure_attribution: "pre_existing_product",
          next_action:
            "Record the pre-existing product failure as validation evidence and route it through a separate product decision, not this task closure.",
          policy_refs: ["policy/completion_proof/v1"],
          reason: preExistingProductFailure,
          verdict_class: "DEFECT",
        };
      }

      if (taskLocalDefect || legacyDefectFound) {
        return {
          blocker_class: "MISSING_EVIDENCE",
          evidence_packet: evidencePacket,
          failure_attribution: "task_local",
          next_action: "Fix the confirmed defect and collect a new review-worthy evidence packet.",
          policy_refs: ["policy/completion_proof/v1"],
          reason: taskLocalDefect ?? legacyDefectFound,
          verdict_class: "DEFECT",
        };
      }

      const hardGateFailures =
        observedOutcome.hard_gate_failures
        ?? observedOutcome.hardGateFailures
        ?? [];
      if (Array.isArray(hardGateFailures) && hardGateFailures.length > 0) {
        const failure = hardGateFailures[0] ?? {};
        const failureId = failure.gate_id ?? failure.id ?? failure.kind ?? "unknown";
        const reason = failure.reason ?? failure.message ?? `Hard gate ${failureId} failed.`;
        return {
          blocker_class: failure.blocker_class ?? "MISSING_EVIDENCE",
          evidence_packet: evidencePacket,
          failure_attribution: failure.failure_attribution ?? "none",
          next_action: failure.next_action
            ?? `Resolve hard gate ${failureId} and create a new review attempt.`,
          policy_refs: ["policy/completion_proof/v2"],
          reason,
          verdict_class: failure.verdict_class ?? "ENV_BLOCK",
        };
      }

      const hasRuntimeEvidence = Boolean(evidencePacket?.markers?.runtime_evidence_succeeded)
        || Boolean((evidencePacket?.items ?? []).length > 0);

      if (!hasRuntimeEvidence) {
        return {
          blocker_class: "MISSING_EVIDENCE",
          evidence_packet: evidencePacket,
          failure_attribution: "none",
          next_action: "Collect authentic runtime evidence before asking the validator lane for acceptance.",
          policy_refs: ["policy/completion_proof/v2"],
          reason: "The completion validator did not receive enough runtime-backed proof to judge the run.",
          verdict_class: "EVIDENCE_GAP",
        };
      }

      if (observedOutcome.partial_progress) {
        return {
          evidence_packet: evidencePacket,
          failure_attribution: "none",
          next_action: "Schedule a short continuation retry and re-run the validator lane after more work is done.",
          observation_signals: [
            {
              category: "completion_review",
              confidence: 0.75,
              summary: "The run produced contentful progress but not a complete finish.",
            },
          ],
          policy_refs: ["policy/completion_proof/v2"],
          reason: "Runtime evidence shows meaningful progress, but the task is not objectively complete yet.",
          verdict_class: "PARTIAL_PROGRESS",
        };
      }

      const commandProof = evaluateAcceptanceCommandProof({
        evidencePacket,
        observedOutcome,
        task,
      });

      if (commandProof.verdict_class === "PASS") {
        return {
          evidence_packet: evidencePacket,
          failure_attribution: "none",
          next_action: "Completion proof is sufficient; accept the run if authority checks also pass.",
          observation_signals: [
            {
              category: "completion_review",
              confidence: 1,
              summary: "The completion validator confirmed a review-ready pass.",
            },
          ],
          policy_refs: ["policy/completion_proof/v2"],
          reason: commandProof.reason,
          verdict_class: "PASS",
        };
      }

      return {
        blocker_class:
          commandProof.verdict_class === "DEFECT"
            ? "MISSING_EVIDENCE"
            : null,
        evidence_packet: evidencePacket,
        failure_attribution: commandProof.failure_attribution ?? "none",
        next_action: commandProof.next_action,
        observation_signals: [
          {
            category: "completion_review",
            confidence: 0.7,
            summary: "The run ended without complete command-backed acceptance proof.",
          },
        ],
        policy_refs: ["policy/completion_proof/v2"],
        reason: commandProof.reason,
        verdict_class: commandProof.verdict_class,
      };
    },
  });
}

export {
  createCompletionProofValidator,
  evaluateAcceptanceCommandProof,
};
