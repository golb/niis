import fs from "node:fs";
import path from "node:path";

import { createDiscoveryReport } from "../contracts/packages.js";
import {
  createIncrementalPipelineMutations,
  planParallelDispatch,
} from "../routing/plan-builder.js";
import { parseSubtaskRecord } from "../schemas/subtask.js";
import { discoverPackageCandidates } from "./package-discovery.js";

class DiscoveryPipelineError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiscoveryPipelineError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DiscoveryPipelineError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DiscoveryPipelineError(`${label} must be a plain object`);
  }

  return value;
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new DiscoveryPipelineError(`${label} must be an array`);
  }

  return value;
}

function toIsoTimestamp(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function slugify(value) {
  return ensureNonEmptyString(value, "value")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeSource(source, index) {
  const normalizedSource = ensurePlainObject(source, `sources[${index}]`);
  const kind = normalizedSource.kind ?? normalizedSource.sourceKind;

  if (!["local_filesystem", "registry"].includes(kind)) {
    throw new DiscoveryPipelineError(
      `sources[${index}].kind must be one of: local_filesystem, registry`,
    );
  }

  return Object.freeze({
    entries: normalizedSource.entries ?? null,
    kind,
    registry_path: normalizedSource.registryPath ?? normalizedSource.registry_path ?? null,
    root_directory: normalizedSource.rootDirectory ?? normalizedSource.root_directory ?? null,
    source_id: normalizedSource.id ?? `${kind}-${index + 1}`,
  });
}

function loadRegistryEntries(source) {
  if (Array.isArray(source.entries)) {
    return source.entries;
  }

  const registryPath = path.resolve(ensureNonEmptyString(source.registry_path, "registryPath"));
  const payload = JSON.parse(fs.readFileSync(registryPath, "utf8"));

  if (Array.isArray(payload)) {
    return payload;
  }

  return payload.entries ?? [];
}

function partitionFilesystemSource(source) {
  const rootDirectory = path.resolve(ensureNonEmptyString(source.root_directory, "rootDirectory"));
  const entries = fs.existsSync(rootDirectory)
    ? fs.readdirSync(rootDirectory, { withFileTypes: true })
    : [];
  const childDirectories = entries
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith("."))
    .map((entry) => path.join(rootDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const scopeRoots = fs.existsSync(path.join(rootDirectory, "package.json"))
    ? [rootDirectory, ...childDirectories]
    : childDirectories.length > 0
      ? childDirectories
      : [rootDirectory];

  return scopeRoots.map((scopeRoot, index) => Object.freeze({
    description: `filesystem scope ${path.basename(scopeRoot)}`,
    scope_id: `${source.source_id}:scope:${index + 1}`,
    source: {
      id: `${source.source_id}:scope:${index + 1}`,
      kind: "local_filesystem",
      rootDirectory: scopeRoot,
    },
    source_id: source.source_id,
    source_kind: source.kind,
  }));
}

function partitionRegistrySource(source) {
  const entries = loadRegistryEntries(source);

  if (entries.length === 0) {
    return [Object.freeze({
      description: `registry scope ${source.source_id}`,
      scope_id: `${source.source_id}:scope:1`,
      source: {
        id: `${source.source_id}:scope:1`,
        kind: "registry",
        entries: [],
      },
      source_id: source.source_id,
      source_kind: source.kind,
    })];
  }

  return entries.map((entry, index) => {
    const normalizedEntry = ensurePlainObject(entry, `registry.entries[${index}]`);
    const sourceRef = normalizedEntry.source_ref ?? normalizedEntry.sourceRef ?? `entry-${index + 1}`;

    return Object.freeze({
      description: `registry scope ${sourceRef}`,
      scope_id: `${source.source_id}:scope:${index + 1}`,
      source: {
        entries: [normalizedEntry],
        id: `${source.source_id}:scope:${index + 1}`,
        kind: "registry",
      },
      source_id: source.source_id,
      source_kind: source.kind,
    });
  });
}

function partitionDiscoverySources(sources = []) {
  return Object.freeze(
    ensureArray(sources, "sources")
      .map((source, index) => normalizeSource(source, index))
      .flatMap((source) =>
        source.kind === "local_filesystem"
          ? partitionFilesystemSource(source)
          : partitionRegistrySource(source)),
  );
}

function createSeekerSubtask(scope, taskId, now) {
  return parseSubtaskRecord({
    created_at: toIsoTimestamp(now),
    id: `${taskId}:seeker:${slugify(scope.scope_id)}`,
    parent_task_id: taskId,
    status: "PENDING",
    title: `Discovery seeker for ${scope.description}`,
  });
}

function createDownstreamSubtasksFromCandidate(candidate, taskId, seekerSubtaskId, index) {
  return [{
    depends_on: [seekerSubtaskId],
    id: `${taskId}:discover-followup:${slugify(candidate.dedup_key)}:${index + 1}`,
    parent_task_id: taskId,
    title:
      `Review discovery candidate ${candidate.display_name} `
      + `(${candidate.suggestion_category}) for follow-up learning or documentation`,
  }];
}

function runIncrementalDiscoveryPipeline({
  alreadyReported = null,
  maxParallel = 2,
  now = new Date(),
  reportId = "discovery-pipeline-report",
  sources = [],
  taskId = "runtime:discovery-pipeline",
  threatCatalog,
} = {}) {
  const seekerScopes = partitionDiscoverySources(sources);
  const seekerSubtasks = Object.freeze(
    seekerScopes.map((scope) => createSeekerSubtask(scope, taskId, now)),
  );
  const readySeekers = planParallelDispatch({
    maxParallel,
    subtasks: seekerSubtasks,
  });

  const seedAlreadyReported = Array.isArray(alreadyReported?.candidates)
    ? [...alreadyReported.candidates]
    : Array.isArray(alreadyReported)
      ? [...alreadyReported]
      : [];
  let accumulatedCandidates = [];
  let accumulatedDuplicates = [];
  let downstreamSubtasks = [];
  const seekerReports = [];

  for (const [index, scope] of seekerScopes.entries()) {
    const seekerSubtask = seekerSubtasks[index];
    const report = discoverPackageCandidates({
      alreadyReported: [...seedAlreadyReported, ...accumulatedCandidates],
      now,
      reportId: `${reportId}:${slugify(scope.scope_id)}`,
      sources: [scope.source],
      threatCatalog,
    });
    const mutationResult = createIncrementalPipelineMutations({
      createSubtasksFromResult: (candidate, candidateIndex) =>
        createDownstreamSubtasksFromCandidate(
          candidate,
          taskId,
          seekerSubtask.id,
          candidateIndex,
        ),
      existingSubtasks: [...seekerSubtasks, ...downstreamSubtasks],
      now,
      runId: `${taskId}:pipeline`,
      sourceResults: report.candidates,
      taskId,
    });
    const newDownstreamSubtasks = mutationResult.subtasks.slice(
      seekerSubtasks.length + downstreamSubtasks.length,
    );

    accumulatedCandidates = [...accumulatedCandidates, ...report.candidates];
    accumulatedDuplicates = [...accumulatedDuplicates, ...report.duplicates];
    downstreamSubtasks = [...downstreamSubtasks, ...newDownstreamSubtasks];
    seekerReports.push(Object.freeze({
      downstream_mutation_artifacts: mutationResult.artifacts,
      downstream_subtasks: Object.freeze(newDownstreamSubtasks),
      report,
      scope,
      seeker_subtask: seekerSubtask,
    }));
  }

  const finalReport = createDiscoveryReport({
    candidates: accumulatedCandidates,
    duplicates: accumulatedDuplicates,
    generatedAt: now,
    reportId,
    sourceKinds: [...new Set(seekerScopes.map((scope) => scope.source_kind))],
  });

  return Object.freeze({
    final_report: finalReport,
    ready_seekers: Object.freeze(readySeekers),
    seeker_reports: Object.freeze(seekerReports),
    seeker_scopes: seekerScopes,
    seeker_subtasks: seekerSubtasks,
    summary: Object.freeze({
      downstream_subtasks_created: downstreamSubtasks.length,
      parallel_ready_seekers: readySeekers.length,
      scopes: seekerScopes.length,
      total_new_candidates: finalReport.candidates.length,
      total_reported_duplicates: finalReport.duplicates.length,
    }),
  });
}

export {
  DiscoveryPipelineError,
  partitionDiscoverySources,
  runIncrementalDiscoveryPipeline,
};
