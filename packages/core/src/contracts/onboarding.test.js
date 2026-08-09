import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectProfile,
  createWorkflowManifest,
  renderProjectProfileMarkdown,
  renderWorkflowMarkdown,
} from "./onboarding.js";

test("renderWorkflowMarkdown emits YAML front matter and workspace strategy contract", () => {
  const workflow = createWorkflowManifest({
    buildSystems: ["webpack", "npm"],
    frameworks: ["react"],
    generatedAt: "2026-04-01T18:00:00.000Z",
    languages: ["typescript", "javascript"],
    primaryType: "react",
    projectId: "example-project",
    summary: "Reviewable workflow contract.",
    taskSourceTypes: ["backlog_file", "documentation_staleness"],
    testFrameworks: ["jest", "playwright"],
    workspaceStrategy: {
      branch_template: "{{task.id}}-{{slug}}",
      mode: "worktree",
      provision_command: null,
      workspace_source_priority: ["project_primary", "task_session_cwd"],
    },
  });
  const markdown = renderWorkflowMarkdown(workflow);

  assert.ok(markdown.startsWith("---\n"));
  assert.match(markdown, /workspace_strategy:/);
  assert.match(markdown, /branch template: `\{\{task\.id\}\}-\{\{slug\}\}`/);
  assert.match(markdown, /task_source_types:/);
});

test("renderProjectProfileMarkdown includes validation surface, task sources, and context boundary", () => {
  const profile = createProjectProfile({
    buildSystems: ["webpack"],
    classificationMatrix: [
      { category: "framework", value: "react", evidence: "dependency react" },
    ],
    contextBoundary: {
      cross_repo_promotion_required: true,
      project_root: "/tmp/repo",
      scope: "project",
    },
    frameworks: ["react"],
    generatedAt: "2026-04-01T18:00:00.000Z",
    languages: ["typescript"],
    manifests: [{ kind: "package_manifest", path: "package.json" }],
    markerEvidence: [{ marker: "tsconfig.json", reason: "language -> typescript" }],
    primaryType: "react",
    projectId: "example-project",
    repoRoot: "/tmp/repo",
    repositoryHistory: {
      available: true,
      last_commit_at: "2026-04-01T17:55:00.000Z",
      recent_paths: ["src/routes/home.tsx"],
      total_commits: 10,
    },
    taskSources: {
      backlog_paths: ["niis-backlog.md"],
      code_roots: ["src", "server"],
      declared_sources: ["backlog_file", "documentation_staleness"],
      documentation_paths: ["README.md", "docs/guide.md"],
      documentation_staleness_candidates: [
        {
          id: "documentation-staleness:recent-code",
          reason: "Code is newer than docs.",
          title: "Review documentation freshness",
        },
      ],
    },
    testFrameworks: ["jest"],
    validationSurface: {
      plugins: [{ path: "server/plugins/logger.js", type: "source" }],
      routes: [{ path: "src/routes/home.tsx", type: "source" }],
      services: [{ path: "server/services/api.js", type: "source" }],
      templates: [{ path: "templates/page.html", type: "other" }],
      total_files_indexed: 42,
    },
  });
  const markdown = renderProjectProfileMarkdown(profile);

  assert.match(markdown, /## Validation Surface/);
  assert.match(markdown, /## Task Sources/);
  assert.match(markdown, /## Context Boundary/);
  assert.match(markdown, /documentation-staleness:recent-code/);
});
