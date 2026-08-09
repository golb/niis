import { validateCompletionRequirements } from "../contracts/completion.js";
import {
  assertValidatorOrthogonality,
  selectValidatorsById,
} from "../contracts/validator.js";
import { parseBlockerArtifact } from "../schemas/blocker.js";
import { parseEventLogEntry } from "../schemas/event.js";
import { parseEvidencePacket } from "../schemas/evidence.js";
import { parseExplainabilityRecord } from "../schemas/explainability.js";
import { parseReviewVerdict } from "../schemas/verdict.js";
import { toIsoTimestamp } from "../scheduler/queue.js";
import { normalizeObservationSignals } from "./observations.js";
import { redactEventLogEntry, redactEvidencePacket, redactExplainabilityRecord } from "./redaction.js";
import { resolvePolicy, selectDefaultValidatorIdsForStrictness } from "./resolved-policy.js";

class ValidatorLaneError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidatorLaneError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidatorLaneError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePolicyResolutionInput(policy = {}, projectProfile = {}) {
  if (!isPlainObject(policy)) {
    return {
      projectProfile,
      runtimeOverrides: {},
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(policy, "basePolicy")
    || Object.prototype.hasOwnProperty.call(policy, "projectProfile")
    || Object.prototype.hasOwnProperty.call(policy, "runtimeOverrides")
    || Object.prototype.hasOwnProperty.call(policy, "workflowPolicy")
  ) {
    return {
      ...policy,
      projectProfile: isPlainObject(policy.projectProfile) ? policy.projectProfile : projectProfile,
    };
  }

  return {
    projectProfile,
    runtimeOverrides: policy,
  };
}

function hasExplicitValidatorLaneConfig(...sources) {
  return sources.some((source) =>
    isPlainObject(source)
    && isPlainObject(source.validator_lane)
    && (
      source.validator_lane.default_validator_ids !== undefined
      || source.validator_lane.strictness !== undefined
    ));
}

function inferProjectProfileClass(projectProfile = {}) {
  if (!isPlainObject(projectProfile)) {
    return "unknown";
  }

  const primaryType = typeof projectProfile.primary_type === "string"
    ? projectProfile.primary_type.trim().toLowerCase()
    : "";
  const frameworks = Array.isArray(projectProfile.frameworks) ? projectProfile.frameworks : [];
  const validationSurface = isPlainObject(projectProfile.validation_surface)
    ? projectProfile.validation_surface
    : {};
  const codeLikeSignals = [
    Array.isArray(validationSurface.routes) ? validationSurface.routes.length : 0,
    Array.isArray(validationSurface.plugins) ? validationSurface.plugins.length : 0,
    Array.isArray(validationSurface.services) ? validationSurface.services.length : 0,
  ];

  if (primaryType === "documentation") {
    return "documentation";
  }

  if (
    (primaryType && primaryType !== "unknown")
    || frameworks.length > 0
    || codeLikeSignals.some((count) => count > 0)
  ) {
    return "application";
  }

  return "unknown";
}

function isDocumentationLikeTask(task = {}) {
  if (!isPlainObject(task)) {
    return false;
  }

  const sourceType = typeof task.source_type === "string" ? task.source_type.trim().toLowerCase() : "";
  const refs = Array.isArray(task.refs) ? task.refs : [];
  const searchText = [
    task.title,
    task.summary,
    task.description,
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return sourceType === "documentation_staleness"
    || refs.some((value) => typeof value === "string" && /\.(md|mdx|txt|rst)$/i.test(value))
    || /\b(doc|docs|documentation|readme|roadmap|glossary)\b/i.test(searchText);
}

function assembleDefaultValidatorIds({
  policy = {},
  projectProfile = {},
  resolvedPolicy,
  task,
}) {
  if (
    hasExplicitValidatorLaneConfig(projectProfile)
    || hasExplicitValidatorLaneConfig(policy)
  ) {
    return resolvedPolicy.validator_lane.default_validator_ids;
  }

  const projectProfileClass = inferProjectProfileClass(projectProfile);
  const documentationLikeTask = isDocumentationLikeTask(task);

  if (projectProfileClass === "documentation" && documentationLikeTask) {
    return selectDefaultValidatorIdsForStrictness("minimal");
  }

  if (documentationLikeTask) {
    return selectDefaultValidatorIdsForStrictness("standard");
  }

  return resolvedPolicy.validator_lane.default_validator_ids;
}

function createFallbackEvidencePacket(seedEvidencePacket = null) {
  if (seedEvidencePacket) {
    return {
      authenticity_status: seedEvidencePacket.authenticity_status,
      items: seedEvidencePacket.items,
      markers: seedEvidencePacket.markers,
    };
  }

  return {
    authenticity_status: "UNVERIFIED",
    items: [],
    markers: {
      auth_surfaces_attempted: [],
      browser_live_checks: [],
      checked_urls: [],
      runtime_evidence_succeeded: false,
    },
  };
}

function createRunLogEvidenceItem(runRecord) {
  const rawOutputRef = runRecord?.run_log?.ref ?? null;

  if (!rawOutputRef) {
    return null;
  }

  return {
    content: `Persisted raw run log is available for ${runRecord.id}.`,
    raw_output_ref: rawOutputRef,
    source: runRecord.id,
    type: "run_log",
  };
}

function linkEvidencePacketToRunRecord(seedEvidencePacket = null, runRecord = null) {
  if (!runRecord?.run_log?.ref) {
    return seedEvidencePacket;
  }

  const fallback = createFallbackEvidencePacket(seedEvidencePacket);

  if (fallback.items.some((item) => item.raw_output_ref === runRecord.run_log.ref)) {
    return fallback;
  }

  return {
    ...fallback,
    items: [...fallback.items, createRunLogEvidenceItem(runRecord)].filter(Boolean),
    markers: {
      ...fallback.markers,
      runtime_evidence_succeeded: true,
    },
  };
}

function normalizeEvidenceRuntime(evidenceRuntime = null) {
  if (evidenceRuntime === null || evidenceRuntime === undefined) {
    return Object.freeze({
      llmReviewer: null,
      verifyRawOutputRef: null,
    });
  }

  if (typeof evidenceRuntime !== "object" || Array.isArray(evidenceRuntime)) {
    throw new ValidatorLaneError("evidenceRuntime must be a plain object");
  }

  return Object.freeze({
    llmReviewer:
      typeof evidenceRuntime.llmReviewer === "function"
        ? evidenceRuntime.llmReviewer
        : null,
    verifyRawOutputRef:
      typeof evidenceRuntime.verifyRawOutputRef === "function"
        ? evidenceRuntime.verifyRawOutputRef
        : null,
  });
}

function mergeEvidencePacket(seedEvidencePacket = null, validatorEvidencePacket = null) {
  const fallback = createFallbackEvidencePacket(seedEvidencePacket);
  const candidate = validatorEvidencePacket ?? {};

  return {
    authenticity_status: candidate.authenticity_status ?? fallback.authenticity_status,
    items: candidate.items?.length ? candidate.items : fallback.items,
    markers: {
      auth_surfaces_attempted:
        candidate.markers?.auth_surfaces_attempted ?? fallback.markers.auth_surfaces_attempted,
      browser_live_checks:
        candidate.markers?.browser_live_checks ?? fallback.markers.browser_live_checks,
      checked_urls: candidate.markers?.checked_urls ?? fallback.markers.checked_urls,
      runtime_evidence_succeeded:
        candidate.markers?.runtime_evidence_succeeded
        ?? fallback.markers.runtime_evidence_succeeded,
    },
  };
}

function createCanonicalEvidencePacket({
  evidencePacket,
  seedEvidencePacket,
  verdictId,
}) {
  const mergedEvidencePacket = mergeEvidencePacket(seedEvidencePacket, evidencePacket);

  return parseEvidencePacket({
    ...mergedEvidencePacket,
    id: `${verdictId}:evidence`,
    verdict_id: verdictId,
  });
}

function createCanonicalVerdict({
  taskId,
  runId,
  validatorId,
  result,
  now,
}) {
  const timestamp = toIsoTimestamp(now, "validator verdict timestamp");

  return parseReviewVerdict({
    created_at: timestamp,
    evidence_packet_id: `${runId}:${validatorId}:verdict:${timestamp}:evidence`,
    failure_attribution: result.failure_attribution ?? "none",
    id: `${runId}:${validatorId}:verdict:${timestamp}`,
    next_action: result.next_action,
    reason: result.reason,
    reviewer_id: validatorId,
    run_id: runId,
    task_id: taskId,
    verdict_class: result.verdict_class,
  });
}

function mapVerdictClassToBlockerClass(result) {
  if (result.blocker_class) {
    return result.blocker_class;
  }

  switch (result.verdict_class) {
    case "ENV_BLOCK":
      return "ENV_BLOCK";
    case "NEEDS_ESCALATION":
      return "MISSING_APPROVAL";
    case "DEFECT":
    case "EVIDENCE_GAP":
    case "PARTIAL_PROGRESS":
      return "MISSING_EVIDENCE";
    default:
      return null;
  }
}

function createBlockerFromResult({
  result,
  taskId,
  validatorId,
  now,
}) {
  const blockerClass = mapVerdictClassToBlockerClass(result);

  if (!blockerClass) {
    return null;
  }

  return parseBlockerArtifact({
    blocker_class: blockerClass,
    created_at: toIsoTimestamp(now, "validator blocker timestamp"),
    id: `${taskId}:${validatorId}:blocker:${Date.parse(now)}`,
    next_action: result.next_action,
    reason: result.reason,
    task_id: taskId,
  });
}

function createValidatorArtifacts({
  explainabilityPolicyRefs,
  now,
  runId,
  taskId,
  validator,
  verdict,
}) {
  const timestamp = toIsoTimestamp(now, "validator event timestamp");

  return {
    event: parseEventLogEntry({
      actor: validator.id,
      event_type: "VALIDATOR_RUN",
      id: `${runId}:${validator.id}:event:${timestamp}`,
      payload: {
        domain: validator.domain,
        failure_attribution: verdict.failure_attribution,
        verdict_class: verdict.verdict_class,
      },
      run_id: runId,
      task_id: taskId,
      timestamp,
    }),
    explainability: parseExplainabilityRecord({
      alternatives_considered: [],
      decision_type: "GATE",
      evidence_refs: [verdict.evidence_packet_id],
      human_readable_summary:
        `${validator.id} returned ${verdict.verdict_class}`
        + (verdict.failure_attribution !== "none"
          ? ` (${verdict.failure_attribution})`
          : "")
        + `: ${verdict.reason}`,
      id: `${runId}:${validator.id}:explainability:${timestamp}`,
      policy_refs: explainabilityPolicyRefs,
      route_chosen: `validator_lane:${validator.id}`,
      task_id: taskId,
      timestamp,
    }),
  };
}

async function runValidatorWithTimeout(validator, context, timeoutMs) {
  let timeoutHandle = null;

  try {
    return await Promise.race([
      validator.validate(context),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new ValidatorLaneError(`validator ${validator.id} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function createSyntheticValidatorResult(verdictClass, reason, nextAction) {
  return {
    blocker_class: null,
    evidence_packet: {
      authenticity_status: "UNVERIFIED",
      items: [],
      markers: {
        auth_surfaces_attempted: [],
        browser_live_checks: [],
        checked_urls: [],
        runtime_evidence_succeeded: false,
      },
    },
    human_summary: reason,
    next_action: nextAction,
    observation_signals: [],
    policy_refs: [],
    reason,
    verdict_class: verdictClass,
  };
}

function createLaneSummary({
  finalVerdict,
  policyRefs,
  runId,
  taskId,
  validatorCount,
  now,
}) {
  const timestamp = toIsoTimestamp(now, "lane summary timestamp");

  return parseExplainabilityRecord({
    alternatives_considered: [],
    decision_type: "GATE",
    evidence_refs: [finalVerdict.evidence_packet_id],
    human_readable_summary:
      `validator lane stopped with ${finalVerdict.verdict_class} after ${validatorCount} validator(s)`,
    id: `${runId}:validator-lane-summary:${timestamp}`,
    policy_refs: policyRefs,
    route_chosen: "validator_lane",
    task_id: taskId,
    timestamp,
  });
}

async function runValidatorLane({
  actorRole = "validator",
  evidencePacket = null,
  evidenceRuntime = null,
  executorAgentId = null,
  now = new Date(),
  observedOutcome = {},
  policy = {},
  projectProfile = {},
  reviewerAgentId = "validator-lane",
  runRecord,
  task,
  validatorIds = [],
  validators = [],
}) {
  const normalizedTaskId = ensureNonEmptyString(task?.id, "task.id");
  const normalizedRunId = ensureNonEmptyString(runRecord?.id, "runRecord.id");
  const resolvedPolicy = resolvePolicy(normalizePolicyResolutionInput(policy, projectProfile));
  const normalizedEvidenceRuntime = normalizeEvidenceRuntime(evidenceRuntime);
  const selectedValidators = selectValidatorsById(
    validators,
    validatorIds.length > 0
      ? validatorIds
      : assembleDefaultValidatorIds({
        policy,
        projectProfile,
        resolvedPolicy,
        task,
      }),
  );

  assertValidatorOrthogonality(selectedValidators);

  const laneResults = [];
  const observations = [];
  const events = [];
  const explainabilityRecords = [];
  let finalVerdict = null;
  let finalEvidencePacket = linkEvidencePacketToRunRecord(evidencePacket, runRecord);
  let blocker = null;
  let continuationRequest = null;

  for (const [validatorIndex, validator] of selectedValidators.entries()) {
    let result;

    try {
      result = await runValidatorWithTimeout(
        validator,
        {
          evidencePacket: finalEvidencePacket,
          evidenceRuntime: normalizedEvidenceRuntime,
          observedOutcome,
          policy: resolvedPolicy,
          previousResults: laneResults,
          runRecord,
          task,
        },
        resolvedPolicy.resource_limits.validator_timeout_ms,
      );
    } catch (error) {
      result = resolvedPolicy.fail_mode.validator_lane === "fail_open"
        ? createSyntheticValidatorResult(
          "EVIDENCE_GAP",
          `validator ${validator.id} failed open: ${error.message}`,
          "Continue to the next validator while recording the validator failure.",
        )
        : createSyntheticValidatorResult(
          "NEEDS_ESCALATION",
          `validator ${validator.id} failed closed: ${error.message}`,
          "Escalate the broken validator gate before trusting the review result.",
        );
    }

    const verdict = createCanonicalVerdict({
      now,
      result,
      runId: normalizedRunId,
      taskId: normalizedTaskId,
      validatorId: validator.id,
    });
    const canonicalEvidencePacket = redactEvidencePacket(
      createCanonicalEvidencePacket({
        evidencePacket: result.evidence_packet,
        seedEvidencePacket: finalEvidencePacket,
        verdictId: verdict.id,
      }),
      resolvedPolicy.redaction,
    );
    const artifacts = createValidatorArtifacts({
      explainabilityPolicyRefs: [
        "policy/validator_lane/v1",
        ...result.policy_refs,
      ],
      now,
      runId: normalizedRunId,
      taskId: normalizedTaskId,
      validator,
      verdict,
    });
    const redactedEvent = redactEventLogEntry(artifacts.event, resolvedPolicy.redaction);
    const redactedExplainability = redactExplainabilityRecord(
      artifacts.explainability,
      resolvedPolicy.redaction,
    );
    const continuationRule =
      resolvedPolicy.validator_lane.continuation_by_verdict[verdict.verdict_class];

    laneResults.push({
      continuation_rule: continuationRule,
      evidence_packet: canonicalEvidencePacket,
      explainability: redactedExplainability,
      validator,
      verdict,
    });
    finalVerdict = verdict;
    finalEvidencePacket = canonicalEvidencePacket;
    observations.push(
      ...normalizeObservationSignals({
        defaultPolicyRefs: ["policy/validator_lane/v1", ...result.policy_refs],
        redactionPolicy: resolvedPolicy.redaction,
        signals: result.observation_signals ?? [],
        sourceId: verdict.id,
        sourceKind: "validator_result",
      }),
    );
    events.push(redactedEvent);
    explainabilityRecords.push(redactedExplainability);

    if (continuationRule.create_blocker) {
      blocker = createBlockerFromResult({
        now,
        result,
        taskId: normalizedTaskId,
        validatorId: validator.id,
      });
    }





    const passHasRemainingValidators =
      verdict.verdict_class === "PASS"
      && validatorIndex < selectedValidators.length - 1;

    if (!continuationRule.continue_to_next && !passHasRemainingValidators) {
      if (continuationRule.retry_kind === "continuation") {
        continuationRequest = {
          delay_ms: resolvedPolicy.validator_lane.short_retry_delay_ms,
          retry_kind: continuationRule.retry_kind,
        };
      }
      break;
    }
  }

  if (!finalVerdict) {
    throw new ValidatorLaneError("validator lane did not produce a final verdict");
  }

  const laneSummary = redactExplainabilityRecord(
    createLaneSummary({
      finalVerdict,
      now,
      policyRefs: ["policy/validator_lane/v1"],
      runId: normalizedRunId,
      taskId: normalizedTaskId,
      validatorCount: laneResults.length,
    }),
    resolvedPolicy.redaction,
  );
  const completionGate = validateCompletionRequirements({
    actorRole,
    evidencePacket: finalEvidencePacket,
    executorAgentId: executorAgentId ?? runRecord.agent_id ?? null,
    explainabilityRecord: laneSummary,
    reviewerAgentId,
    verdict: finalVerdict,
  });

  if (!blocker && completionGate.blocker) {
    const timestamp = toIsoTimestamp(now, "completion gate blocker timestamp");
    blocker = parseBlockerArtifact({
      ...completionGate.blocker,
      created_at: timestamp,
      id: `${normalizedTaskId}:completion-gate:${Date.parse(timestamp)}`,
      task_id: normalizedTaskId,
    });
  }

  return Object.freeze({
    blocker,
    completion_gate: completionGate,
    continuation_request: continuationRequest,
    events: Object.freeze(events),
    explainability: Object.freeze([...explainabilityRecords, laneSummary]),
    final_evidence_packet: finalEvidencePacket,
    final_verdict: finalVerdict,
    observations: Object.freeze(observations),
    resolved_policy: resolvedPolicy,
    results: Object.freeze(laneResults),
  });
}

export {
  ValidatorLaneError,
  createRunLogEvidenceItem,
  linkEvidencePacketToRunRecord,
  runValidatorLane,
};
