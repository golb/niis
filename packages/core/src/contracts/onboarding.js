import { toIsoTimestamp } from "../scheduler/queue.js";

class OnboardingContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "OnboardingContractError";
  }
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OnboardingContractError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OnboardingContractError(`${label} must be a plain object`);
  }

  return value;
}

function ensureStringArray(values, label) {
  if (values === undefined || values === null) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw new OnboardingContractError(`${label} must be an array`);
  }

  return [...new Set(values.map((value, index) =>
    ensureNonEmptyString(value, `${label}[${index}]`)))];
}

function ensureBoolean(value, label, defaultValue) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "boolean") {
    throw new OnboardingContractError(`${label} must be a boolean`);
  }

  return value;
}

function ensureNumber(value, label, defaultValue = 0) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new OnboardingContractError(`${label} must be a number`);
  }

  return value;
}

function normalizeStringRecords(records, label, requiredKeys) {
  if (!Array.isArray(records)) {
    throw new OnboardingContractError(`${label} must be an array`);
  }

  return Object.freeze(records.map((record, index) => {
    const normalizedRecord = ensurePlainObject(record, `${label}[${index}]`);
    const output = {};

    for (const key of requiredKeys) {
      output[key] = ensureNonEmptyString(normalizedRecord[key], `${label}[${index}].${key}`);
    }

    return Object.freeze(output);
  }));
}

function normalizeSurfaceGroup(items, label) {
  return normalizeStringRecords(items ?? [], label, ["path", "type"]);
}

function createWorkflowManifest(input = {}) {
  const projectId = input.projectId ?? input.project_id;
  const generatedAt = input.generatedAt ?? input.generated_at ?? new Date();
  const summary = input.summary;
  const primaryType = input.primaryType ?? input.primary_type;
  const languages = input.languages ?? [];
  const frameworks = input.frameworks ?? [];
  const buildSystems = input.buildSystems ?? input.build_systems ?? [];
  const testFrameworks = input.testFrameworks ?? input.test_frameworks ?? [];
  const taskSourceTypes = input.taskSourceTypes ?? input.task_source_types ?? [];
  const workspaceStrategy = input.workspaceStrategy ?? input.workspace_strategy ?? {};
  const reviewRequired = input.reviewRequired ?? input.review_required ?? true;
  const normalizedWorkspaceStrategy = ensurePlainObject(workspaceStrategy, "workspaceStrategy");

  return Object.freeze({
    activation: "manual",
    build_systems: Object.freeze(ensureStringArray(buildSystems, "buildSystems")),
    frameworks: Object.freeze(ensureStringArray(frameworks, "frameworks")),
    generated_at: toIsoTimestamp(generatedAt, "generatedAt"),
    languages: Object.freeze(ensureStringArray(languages, "languages")),
    primary_type: ensureNonEmptyString(primaryType, "primaryType"),
    project_id: ensureNonEmptyString(projectId, "projectId"),
    review_required: ensureBoolean(reviewRequired, "reviewRequired", true),
    schema_version: 1,
    summary: ensureNonEmptyString(summary, "summary"),
    task_source_types: Object.freeze(ensureStringArray(taskSourceTypes, "taskSourceTypes")),
    test_frameworks: Object.freeze(ensureStringArray(testFrameworks, "testFrameworks")),
    workspace_strategy: Object.freeze({
      branch_template: ensureNonEmptyString(
        normalizedWorkspaceStrategy.branch_template ?? "{{task.id}}-{{slug}}",
        "workspaceStrategy.branch_template",
      ),
      mode: ensureNonEmptyString(
        normalizedWorkspaceStrategy.mode ?? "worktree",
        "workspaceStrategy.mode",
      ),
      provision_command:
        normalizedWorkspaceStrategy.provision_command === null
        || normalizedWorkspaceStrategy.provision_command === undefined
          ? null
          : ensureNonEmptyString(
            normalizedWorkspaceStrategy.provision_command,
            "workspaceStrategy.provision_command",
          ),
      workspace_source_priority: Object.freeze(
        ensureStringArray(
          normalizedWorkspaceStrategy.workspace_source_priority ?? [],
          "workspaceStrategy.workspace_source_priority",
        ),
      ),
    }),
  });
}

function createProjectProfile(input = {}) {
  const projectId = input.projectId ?? input.project_id;
  const generatedAt = input.generatedAt ?? input.generated_at ?? new Date();
  const repoRoot = input.repoRoot ?? input.repo_root;
  const primaryType = input.primaryType ?? input.primary_type;
  const languages = input.languages ?? [];
  const frameworks = input.frameworks ?? [];
  const buildSystems = input.buildSystems ?? input.build_systems ?? [];
  const testFrameworks = input.testFrameworks ?? input.test_frameworks ?? [];
  const classificationMatrix = input.classificationMatrix ?? input.classification_matrix ?? [];
  const markerEvidence = input.markerEvidence ?? input.marker_evidence ?? [];
  const manifests = input.manifests ?? [];
  const validationSurface = input.validationSurface ?? input.validation_surface ?? {};
  const taskSources = input.taskSources ?? input.task_sources ?? {};
  const repositoryHistory = input.repositoryHistory ?? input.repository_history ?? {};
  const contextBoundary = input.contextBoundary ?? input.context_boundary ?? {};
  const normalizedValidationSurface = ensurePlainObject(validationSurface, "validationSurface");
  const normalizedTaskSources = ensurePlainObject(taskSources, "taskSources");
  const normalizedRepositoryHistory = ensurePlainObject(repositoryHistory, "repositoryHistory");
  const normalizedContextBoundary = ensurePlainObject(contextBoundary, "contextBoundary");

  return Object.freeze({
    build_systems: Object.freeze(ensureStringArray(buildSystems, "buildSystems")),
    classification_matrix: normalizeStringRecords(
      classificationMatrix ?? [],
      "classificationMatrix",
      ["category", "value", "evidence"],
    ),
    context_boundary: Object.freeze({
      cross_repo_promotion_required: ensureBoolean(
        normalizedContextBoundary.cross_repo_promotion_required,
        "contextBoundary.cross_repo_promotion_required",
        true,
      ),
      project_root: ensureNonEmptyString(
        normalizedContextBoundary.project_root ?? repoRoot,
        "contextBoundary.project_root",
      ),
      scope: ensureNonEmptyString(normalizedContextBoundary.scope ?? "project", "contextBoundary.scope"),
    }),
    frameworks: Object.freeze(ensureStringArray(frameworks, "frameworks")),
    generated_at: toIsoTimestamp(generatedAt, "generatedAt"),
    languages: Object.freeze(ensureStringArray(languages, "languages")),
    manifests: normalizeStringRecords(manifests ?? [], "manifests", ["kind", "path"]),
    marker_evidence: normalizeStringRecords(markerEvidence ?? [], "markerEvidence", ["marker", "reason"]),
    primary_type: ensureNonEmptyString(primaryType, "primaryType"),
    project_id: ensureNonEmptyString(projectId, "projectId"),
    repo_root: ensureNonEmptyString(repoRoot, "repoRoot"),
    repository_history: Object.freeze({
      available: ensureBoolean(normalizedRepositoryHistory.available, "repositoryHistory.available", false),
      last_commit_at:
        normalizedRepositoryHistory.last_commit_at === null
        || normalizedRepositoryHistory.last_commit_at === undefined
          ? null
          : toIsoTimestamp(normalizedRepositoryHistory.last_commit_at, "repositoryHistory.last_commit_at"),
      recent_paths: Object.freeze(
        ensureStringArray(normalizedRepositoryHistory.recent_paths ?? [], "repositoryHistory.recent_paths"),
      ),
      total_commits: ensureNumber(
        normalizedRepositoryHistory.total_commits,
        "repositoryHistory.total_commits",
        0,
      ),
    }),
    reviewable: true,
    schema_version: 1,
    task_sources: Object.freeze({
      backlog_paths: Object.freeze(
        ensureStringArray(normalizedTaskSources.backlog_paths ?? [], "taskSources.backlog_paths"),
      ),
      code_roots: Object.freeze(
        ensureStringArray(normalizedTaskSources.code_roots ?? [], "taskSources.code_roots"),
      ),
      declared_sources: Object.freeze(
        ensureStringArray(normalizedTaskSources.declared_sources ?? [], "taskSources.declared_sources"),
      ),
      documentation_paths: Object.freeze(
        ensureStringArray(normalizedTaskSources.documentation_paths ?? [], "taskSources.documentation_paths"),
      ),
      documentation_staleness_candidates: normalizeStringRecords(
        normalizedTaskSources.documentation_staleness_candidates ?? [],
        "taskSources.documentation_staleness_candidates",
        ["id", "title", "reason"],
      ),
    }),
    test_frameworks: Object.freeze(ensureStringArray(testFrameworks, "testFrameworks")),
    validation_surface: Object.freeze({
      plugins: normalizeSurfaceGroup(normalizedValidationSurface.plugins ?? [], "validationSurface.plugins"),
      routes: normalizeSurfaceGroup(normalizedValidationSurface.routes ?? [], "validationSurface.routes"),
      services: normalizeSurfaceGroup(normalizedValidationSurface.services ?? [], "validationSurface.services"),
      templates: normalizeSurfaceGroup(normalizedValidationSurface.templates ?? [], "validationSurface.templates"),
      total_files_indexed: ensureNumber(
        normalizedValidationSurface.total_files_indexed,
        "validationSurface.total_files_indexed",
        0,
      ),
    }),
  });
}

function createCodemapArtifact({
  generatedAt = new Date(),
  root,
  contentHash,
  entries = [],
  stats = {},
}) {
  return Object.freeze({
    content_hash: ensureNonEmptyString(contentHash, "contentHash"),
    entries: Object.freeze(entries.map((entry, index) => {
      const normalizedEntry = ensurePlainObject(entry, `entries[${index}]`);

      return Object.freeze({
        kind: ensureNonEmptyString(normalizedEntry.kind, `entries[${index}].kind`),
        language:
          normalizedEntry.language === null || normalizedEntry.language === undefined
            ? null
            : ensureNonEmptyString(normalizedEntry.language, `entries[${index}].language`),
        path: ensureNonEmptyString(normalizedEntry.path, `entries[${index}].path`),
        size_bytes: ensureNumber(normalizedEntry.size_bytes, `entries[${index}].size_bytes`, 0),
      });
    })),
    generated_at: toIsoTimestamp(generatedAt, "generatedAt"),
    root: ensureNonEmptyString(root, "root"),
    schema_version: 1,
    stats: Object.freeze({
      docs_count: ensureNumber(stats.docs_count, "stats.docs_count", 0),
      files_indexed: ensureNumber(stats.files_indexed, "stats.files_indexed", 0),
      source_count: ensureNumber(stats.source_count, "stats.source_count", 0),
    }),
  });
}

function createReferenceSeedModel({
  generatedAt = new Date(),
  contentHash,
  seeds = [],
}) {
  return Object.freeze({
    content_hash: ensureNonEmptyString(contentHash, "contentHash"),
    generated_at: toIsoTimestamp(generatedAt, "generatedAt"),
    schema_version: 1,
    seeds: Object.freeze(seeds.map((seed, index) => {
      const normalizedSeed = ensurePlainObject(seed, `seeds[${index}]`);

      return Object.freeze({
        id: ensureNonEmptyString(normalizedSeed.id, `seeds[${index}].id`),
        kind: ensureNonEmptyString(normalizedSeed.kind, `seeds[${index}].kind`),
        path: ensureNonEmptyString(normalizedSeed.path, `seeds[${index}].path`),
        reason: ensureNonEmptyString(normalizedSeed.reason, `seeds[${index}].reason`),
        title: ensureNonEmptyString(normalizedSeed.title, `seeds[${index}].title`),
      });
    })),
  });
}

function createBootstrapPack({
  projectId,
  generatedAt = new Date(),
  artifacts = [],
  reviewRequired = true,
}) {
  return Object.freeze({
    activation: "manual",
    artifacts: normalizeStringRecords(artifacts ?? [], "artifacts", ["kind", "path"]),
    destructive: false,
    generated_at: toIsoTimestamp(generatedAt, "generatedAt"),
    project_id: ensureNonEmptyString(projectId, "projectId"),
    review_required: ensureBoolean(reviewRequired, "reviewRequired", true),
    schema_version: 1,
  });
}

function createScaffoldPlan({
  projectId,
  generatedAt = new Date(),
  steps = [],
}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new OnboardingContractError("steps must be a non-empty array");
  }

  return Object.freeze({
    generated_at: toIsoTimestamp(generatedAt, "generatedAt"),
    project_id: ensureNonEmptyString(projectId, "projectId"),
    review_required: true,
    schema_version: 1,
    steps: Object.freeze(steps.map((step, index) => {
      const normalizedStep = ensurePlainObject(step, `steps[${index}]`);

      return Object.freeze({
        action: ensureNonEmptyString(normalizedStep.action, `steps[${index}].action`),
        detail: ensureNonEmptyString(normalizedStep.detail, `steps[${index}].detail`),
        id: ensureNonEmptyString(normalizedStep.id ?? `step-${index + 1}`, `steps[${index}].id`),
      });
    })),
  });
}

function createProjectRegistryEntry({
  projectId,
  packageRoot,
  validationSurfaceRoot,
  attachedAt = new Date(),
}) {
  return Object.freeze({
    attached_at: toIsoTimestamp(attachedAt, "attachedAt"),
    context_scope: "project",
    cross_repo_promotion_required: true,
    package_root: ensureNonEmptyString(packageRoot, "packageRoot"),
    project_id: ensureNonEmptyString(projectId, "projectId"),
    validation_surface_root: ensureNonEmptyString(validationSurfaceRoot, "validationSurfaceRoot"),
  });
}

function formatYamlScalar(value) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  throw new OnboardingContractError(`unsupported YAML scalar type: ${typeof value}`);
}

function renderYamlValue(value, indentLevel = 0) {
  const indent = "  ".repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indent}[]`;
    }

    return value.map((entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const lines = Object.entries(entry).flatMap(([key, nestedValue], index) => {
          const prefix = index === 0 ? `${indent}- ${key}:` : `${indent}  ${key}:`;
          if (nestedValue && typeof nestedValue === "object") {
            return [
              prefix,
              renderYamlValue(nestedValue, indentLevel + 2),
            ];
          }

          return `${prefix} ${formatYamlScalar(nestedValue)}`;
        });

        return lines.join("\n");
      }

      return `${indent}- ${formatYamlScalar(entry)}`;
    }).join("\n");
  }

  if (value && typeof value === "object") {
    return Object.entries(value).map(([key, nestedValue]) => {
      if (nestedValue && typeof nestedValue === "object") {
        return `${indent}${key}:\n${renderYamlValue(nestedValue, indentLevel + 1)}`;
      }

      return `${indent}${key}: ${formatYamlScalar(nestedValue)}`;
    }).join("\n");
  }

  return `${indent}${formatYamlScalar(value)}`;
}

function renderWorkflowMarkdown(workflowManifest) {
  const workflow = createWorkflowManifest(workflowManifest);
  const frontmatter = renderYamlValue({
    activation: workflow.activation,
    build_systems: workflow.build_systems,
    frameworks: workflow.frameworks,
    generated_at: workflow.generated_at,
    languages: workflow.languages,
    primary_type: workflow.primary_type,
    project_id: workflow.project_id,
    review_required: workflow.review_required,
    schema_version: workflow.schema_version,
    task_source_types: workflow.task_source_types,
    test_frameworks: workflow.test_frameworks,
    workspace_strategy: workflow.workspace_strategy,
  });

  return [
    "---",
    frontmatter,
    "---",
    "",
    "# Workflow",
    "",
    workflow.summary,
    "",
    "## Workspace Strategy",
    "",
    `- mode: \`${workflow.workspace_strategy.mode}\``,
    `- branch template: \`${workflow.workspace_strategy.branch_template}\``,
    `- provision command: ${workflow.workspace_strategy.provision_command ? `\`${workflow.workspace_strategy.provision_command}\`` : "_none_"}`,
    `- workspace source priority: ${workflow.workspace_strategy.workspace_source_priority.map((value) => `\`${value}\``).join(", ") || "_none_"}`,
    "",
    "## Task Sources",
    "",
    ...workflow.task_source_types.map((taskSourceType) => `- \`${taskSourceType}\``),
    "",
    "## Review Notes",
    "",
    "- generated onboarding artifacts are reviewable and do not auto-activate new behavior",
    "- sensitive values must be redacted, omitted, or stored through a secret reference",
    "",
  ].join("\n");
}

function renderProjectProfileMarkdown(projectProfile) {
  const profile = createProjectProfile(projectProfile);

  return [
    "# Project Profile",
    "",
    `- project id: \`${profile.project_id}\``,
    `- repo root: \`${profile.repo_root}\``,
    `- primary type: \`${profile.primary_type}\``,
    `- languages: ${profile.languages.map((value) => `\`${value}\``).join(", ") || "_none_"}`,
    `- frameworks: ${profile.frameworks.map((value) => `\`${value}\``).join(", ") || "_none_"}`,
    `- build systems: ${profile.build_systems.map((value) => `\`${value}\``).join(", ") || "_none_"}`,
    `- test frameworks: ${profile.test_frameworks.map((value) => `\`${value}\``).join(", ") || "_none_"}`,
    "",
    "## Classification Matrix",
    "",
    ...profile.classification_matrix.map((entry) =>
      `- ${entry.category}: \`${entry.value}\` via ${entry.evidence}`),
    "",
    "## Marker Evidence",
    "",
    ...profile.marker_evidence.map((entry) => `- \`${entry.marker}\`: ${entry.reason}`),
    "",
    "## Validation Surface",
    "",
    `- indexed files: ${profile.validation_surface.total_files_indexed}`,
    `- routes: ${profile.validation_surface.routes.map((entry) => `\`${entry.path}\``).join(", ") || "_none_"}`,
    `- services: ${profile.validation_surface.services.map((entry) => `\`${entry.path}\``).join(", ") || "_none_"}`,
    `- plugins: ${profile.validation_surface.plugins.map((entry) => `\`${entry.path}\``).join(", ") || "_none_"}`,
    `- templates: ${profile.validation_surface.templates.map((entry) => `\`${entry.path}\``).join(", ") || "_none_"}`,
    "",
    "## Task Sources",
    "",
    `- declared sources: ${profile.task_sources.declared_sources.map((value) => `\`${value}\``).join(", ") || "_none_"}`,
    `- documentation paths: ${profile.task_sources.documentation_paths.map((value) => `\`${value}\``).join(", ") || "_none_"}`,
    `- code roots: ${profile.task_sources.code_roots.map((value) => `\`${value}\``).join(", ") || "_none_"}`,
    `- backlog paths: ${profile.task_sources.backlog_paths.map((value) => `\`${value}\``).join(", ") || "_none_"}`,
    "",
    "### Documentation Staleness Candidates",
    "",
    ...profile.task_sources.documentation_staleness_candidates.map((candidate) =>
      `- \`${candidate.id}\`: ${candidate.title} — ${candidate.reason}`),
    "",
    "## Repository History",
    "",
    `- available: ${profile.repository_history.available}`,
    `- total commits: ${profile.repository_history.total_commits}`,
    `- last commit at: ${profile.repository_history.last_commit_at ?? "_unknown_"}`,
    `- recent paths: ${profile.repository_history.recent_paths.map((value) => `\`${value}\``).join(", ") || "_none_"}`,
    "",
    "## Context Boundary",
    "",
    `- scope: \`${profile.context_boundary.scope}\``,
    `- project root: \`${profile.context_boundary.project_root}\``,
    `- cross-repo promotion required: ${profile.context_boundary.cross_repo_promotion_required}`,
    "",
  ].join("\n");
}

export {
  OnboardingContractError,
  createBootstrapPack,
  createCodemapArtifact,
  createProjectProfile,
  createProjectRegistryEntry,
  createReferenceSeedModel,
  createScaffoldPlan,
  createWorkflowManifest,
  renderProjectProfileMarkdown,
  renderWorkflowMarkdown,
};
