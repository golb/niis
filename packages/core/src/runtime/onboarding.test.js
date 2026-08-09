import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { initializeBootstrapState } from "./bootstrap-surface.js";
import { generateOnboardingArtifacts, loadAttachedProjectContext } from "./onboarding.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const installRoot = path.resolve(__dirname, "..", "..", "..", "..");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createTempWorkspace() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niis-onboarding-"));
  const repositoryRoot = path.join(tempRoot, "host-repo");
  const packageRoot = path.join(repositoryRoot, "niis");

  fs.mkdirSync(packageRoot, { recursive: true });
  writeFile(path.join(repositoryRoot, "package.json"), JSON.stringify({
    type: "module",
    dependencies: {
      "@hapi/hapi": "^20.3.0",
      react: "^18.3.1",
    },
    devDependencies: {
      "@playwright/test": "^1.58.2",
      jest: "^29.7.0",
      webpack: "^5.0.0",
    },
  }, null, 2));
  writeFile(path.join(repositoryRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "esnext",
    },
  }, null, 2));
  writeFile(path.join(repositoryRoot, "playwright.config.ts"), "export default {};\n");
  writeFile(path.join(repositoryRoot, "Jenkinsfile"), "pipeline { agent any }\n");
  writeFile(path.join(repositoryRoot, "src/routes/home.tsx"), "export const Home = () => null;\n");
  writeFile(path.join(repositoryRoot, "server/plugins/logger.js"), "export const logger = {};\n");
  writeFile(path.join(repositoryRoot, "server/services/api.js"), "export const api = {};\n");
  writeFile(path.join(repositoryRoot, "README.md"), "# Host repo\n");
  writeFile(path.join(repositoryRoot, "docs/guide.md"), "# Guide\n");

  const oldTimestamp = new Date("2026-03-01T00:00:00.000Z");
  const newTimestamp = new Date("2026-04-01T00:00:00.000Z");
  fs.utimesSync(path.join(repositoryRoot, "README.md"), oldTimestamp, oldTimestamp);
  fs.utimesSync(path.join(repositoryRoot, "docs/guide.md"), oldTimestamp, oldTimestamp);
  fs.utimesSync(path.join(repositoryRoot, "src/routes/home.tsx"), newTimestamp, newTimestamp);

  return {
    packageRoot,
    repositoryRoot,
    tempRoot,
  };
}

test("generateOnboardingArtifacts writes reviewable onboarding outputs and uses cache hits on unchanged inputs", () => {
  const workspace = createTempWorkspace();

  const firstRun = generateOnboardingArtifacts({
    now: "2026-04-01T18:10:00.000Z",
    packageRoot: workspace.packageRoot,
    validationSurfaceRoot: workspace.repositoryRoot,
  });

  assert.equal(firstRun.attachment.reviewable, true);
  assert.equal(firstRun.attachment.destructive, false);
  assert.equal(firstRun.attachment.cache.codemap.hit, false);
  assert.notEqual(firstRun.profile.primary_type, "unknown");
  assert.deepEqual(firstRun.profile.frameworks, ["hapi", "react"]);
  assert.ok(firstRun.profile.task_sources.documentation_staleness_candidates.length >= 1);
  assert.ok(fs.existsSync(firstRun.artifacts.project_profile));
  assert.ok(fs.existsSync(firstRun.artifacts.workflow));
  assert.ok(fs.existsSync(firstRun.artifacts.codemap));
  assert.ok(fs.existsSync(path.join(workspace.packageRoot, ".niis", "registry.json")));

  const workflowMarkdown = fs.readFileSync(firstRun.artifacts.workflow, "utf8");
  const codemap = JSON.parse(fs.readFileSync(firstRun.artifacts.codemap, "utf8"));

  assert.match(workflowMarkdown, /workspace_strategy:/);
  assert.equal(codemap.stats.files_indexed > 0, true);

  const secondRun = generateOnboardingArtifacts({
    now: "2026-04-01T18:11:00.000Z",
    packageRoot: workspace.packageRoot,
    validationSurfaceRoot: workspace.repositoryRoot,
  });

  assert.equal(secondRun.attachment.cache.codemap.hit, true);
  assert.equal(secondRun.attachment.cache.reference_seeds.hit, true);

  writeFile(path.join(workspace.repositoryRoot, "src/routes/home.tsx"), "export const Home = () => 'updated';\n");
  const thirdRun = generateOnboardingArtifacts({
    now: "2026-04-01T18:12:00.000Z",
    packageRoot: workspace.packageRoot,
    validationSurfaceRoot: workspace.repositoryRoot,
  });

  assert.equal(thirdRun.attachment.cache.codemap.hit, false);
  assert.equal(thirdRun.registry.projects.length, 1);
});

test("loadAttachedProjectContext summarizes attached project artifacts for the control plane", () => {
  const workspace = createTempWorkspace();
  const packageRoot = workspace.repositoryRoot;

  initializeBootstrapState(workspace.repositoryRoot, {
    installRoot,
  });
  generateOnboardingArtifacts({
    now: "2026-04-01T18:10:00.000Z",
    packageRoot,
    validationSurfaceRoot: workspace.repositoryRoot,
  });

  const projectContext = loadAttachedProjectContext({
    packageRoot,
    validationSurfaceRoot: workspace.repositoryRoot,
    workspaceRoot: workspace.repositoryRoot,
  });

  assert.equal(projectContext.hasProjectProfile, true);
  assert.equal(projectContext.hasWorkflow, true);
  assert.equal(projectContext.hasCodemap, true);
  assert.equal(projectContext.profile.project_id, "host-repo");
  assert.deepEqual(projectContext.profile.frameworks, ["hapi", "react"]);
  assert.deepEqual(projectContext.profile.languages, ["javascript", "typescript"]);
  assert.equal(projectContext.workflow.workspace_strategy.mode, "worktree");
  assert.equal(projectContext.codemap.stats.files_indexed > 0, true);
  assert.equal(projectContext.codemap.language_breakdown.some((entry) => entry.language === "typescript"), true);
  assert.equal(projectContext.install.status, "BOOTSTRAPPED");
  assert.equal(projectContext.doctor.runtime_availability.some((check) => check.id === "codex_local"), true);
});
