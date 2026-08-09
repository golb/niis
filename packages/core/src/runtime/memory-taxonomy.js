import { parseInstinctArtifact } from "../schemas/instinct.js";
import { parseObservationArtifact } from "../schemas/observation-artifact.js";
import { parseSkillCandidate } from "../schemas/skill-candidate.js";

class MemoryTaxonomyError extends Error {
  constructor(message) {
    super(message);
    this.name = "MemoryTaxonomyError";
  }
}

const MEMORY_TIERS = Object.freeze(["daily", "projects", "facts"]);

function evaluateObservationArtifactTier(artifact) {
  const normalizedArtifact = parseObservationArtifact(artifact);

  return Object.freeze({
    artifact_id: normalizedArtifact.id,
    artifact_kind: "observation_artifact",
    memory_tier: "daily",
    project_id: null,
    rationale:
      "Observation artifacts remain daily memory inputs: redacted, high-churn signals that feed learning but do not yet become reviewed reusable knowledge.",
    scope: null,
  });
}

function evaluateInstinctTier(instinct) {
  const normalizedInstinct = parseInstinctArtifact(instinct);
  const memoryTier = normalizedInstinct.scope === "global" ? "facts" : "projects";

  return Object.freeze({
    artifact_id: normalizedInstinct.id,
    artifact_kind: "instinct_artifact",
    memory_tier: memoryTier,
    project_id: normalizedInstinct.project_id,
    rationale:
      memoryTier === "facts"
        ? "Global reviewed instincts belong to facts memory because they carry cross-project durable knowledge."
        : "Project-scoped reviewed instincts belong to projects memory because they encode reusable local knowledge for one project.",
    scope: normalizedInstinct.scope,
  });
}

function evaluateSkillCandidateTier(skillCandidate) {
  const normalizedSkillCandidate = parseSkillCandidate(skillCandidate);
  const memoryTier = normalizedSkillCandidate.scope === "global" ? "facts" : "projects";

  return Object.freeze({
    artifact_id: normalizedSkillCandidate.id,
    artifact_kind: "skill_candidate",
    memory_tier: memoryTier,
    project_id: normalizedSkillCandidate.project_id,
    rationale:
      memoryTier === "facts"
        ? "Global reviewed skill candidates belong to facts memory because they are durable cross-project reusable knowledge awaiting packaging or activation review."
        : "Project-scoped reviewed skill candidates belong to projects memory because they are reusable local knowledge for one project, not universal facts.",
    scope: normalizedSkillCandidate.scope,
  });
}

function evaluateMemoryTier({
  instinct = null,
  observationArtifact = null,
  skillCandidate = null,
} = {}) {
  const provided = [
    observationArtifact !== null,
    instinct !== null,
    skillCandidate !== null,
  ].filter(Boolean).length;

  if (provided !== 1) {
    throw new MemoryTaxonomyError(
      "provide exactly one of observationArtifact, instinct, or skillCandidate",
    );
  }

  if (observationArtifact !== null) {
    return evaluateObservationArtifactTier(observationArtifact);
  }

  if (instinct !== null) {
    return evaluateInstinctTier(instinct);
  }

  return evaluateSkillCandidateTier(skillCandidate);
}

function classifyMemoryTaxonomy({
  instincts = [],
  observationArtifacts = [],
  skillCandidates = [],
} = {}) {
  if (!Array.isArray(observationArtifacts)) {
    throw new MemoryTaxonomyError("observationArtifacts must be an array");
  }

  if (!Array.isArray(instincts)) {
    throw new MemoryTaxonomyError("instincts must be an array");
  }

  if (!Array.isArray(skillCandidates)) {
    throw new MemoryTaxonomyError("skillCandidates must be an array");
  }

  const evaluations = Object.freeze([
    ...observationArtifacts.map((artifact) => evaluateMemoryTier({ observationArtifact: artifact })),
    ...instincts.map((instinct) => evaluateMemoryTier({ instinct })),
    ...skillCandidates.map((skillCandidate) => evaluateMemoryTier({ skillCandidate })),
  ]);
  const summary = Object.freeze({
    daily: evaluations.filter((entry) => entry.memory_tier === "daily").length,
    facts: evaluations.filter((entry) => entry.memory_tier === "facts").length,
    projects: evaluations.filter((entry) => entry.memory_tier === "projects").length,
    total: evaluations.length,
  });

  return Object.freeze({
    evaluations,
    summary,
  });
}

export {
  MEMORY_TIERS,
  MemoryTaxonomyError,
  classifyMemoryTaxonomy,
  evaluateMemoryTier,
};
