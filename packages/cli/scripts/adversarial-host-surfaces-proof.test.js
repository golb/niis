import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAdversarialHostSurfacesProof } from "./adversarial-host-surfaces-proof.js";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("runAdversarialHostSurfacesProof covers multiple synthetic repository surfaces", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-adversarial-host-surfaces-"));
  const workspaceRoot = path.join(root, "niis");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      baseUrl: "./src",
      paths: {
        "@extensions": ["server/plugins"],
        "@extensions/*": ["server/plugins/*"],
        "@middleware": ["server/prehandlers"],
        "@middleware/*": ["server/prehandlers/*"],
        "@http": ["server/routes"],
      },
    },
  }, null, 2));
  writeFile(path.join(root, "README.md"), "# Fixture Application\nTesting workflow and architecture.\nPlaywright E2E proof.\n");
  writeFile(path.join(root, "README-TESTING.md"), "# Additional Notes\n");
  writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "host-repo",
    type: "module",
    version: "0.1.0",
    scripts: {
      "test:e2e": "playwright test",
    },
  }, null, 2));
  writeFile(path.join(root, "playwright.config.ts"), "export default {};\n");
  writeFile(
    path.join(root, "src", "client", "components", "Dashboard", "index.tsx"),
    "const Dashboard = async (props) => render(await fetch('/api/summary'), props);\nexport default Dashboard;\n",
  );
  writeFile(
    path.join(root, "src", "client", "components", "Settings", "index.tsx"),
    "const Settings = () => null;\nexport default Settings;\n",
  );
  writeFile(
    path.join(root, "src", "client", "api", "tasks", "index.ts"),
    "async function listTasks() { return fetch('/api/tasks', { headers: { accept: 'application/json' } }); }\nexport default listTasks;\n",
  );
  writeFile(
    path.join(root, "src", "client", "api", "status", "index.ts"),
    "export default function status() { return { ok: true }; }\n",
  );
  writeFile(
    path.join(root, "src", "server", "routes", "index.ts"),
    "import Hapi from '@hapi/hapi';\nexport function init(server: Hapi.Server) { server.route({ method: 'GET', path: '/tasks', options: { pre: [] } }); }\n",
  );
  writeFile(
    path.join(root, "src", "server", "index.ts"),
    "import './tracing';\nimport routes from '@http';\nimport { registry } from '@extensions';\nimport Hapi from '@hapi/hapi';\nexport async function init() { const server = new Hapi.Server(); await server.register([registry.Renderer, registry.Translations]); routes.init(server); await server.plugins.renderer.renderPage(); }\n",
  );
  writeFile(
    path.join(root, "src", "server", "tracing.ts"),
    "import './prehandlers/handlers/attachRequestContext';\n",
  );
  writeFile(
    path.join(root, "src", "server", "prehandlers", "handlers", "attachRequestContext.ts"),
    "export async function attachRequestContext(request, h) { const requestId = request.headers['x-request-id']; request.app.context = { requestId }; return h.continue; }\n",
  );
  writeFile(
    path.join(root, "src", "server", "prehandlers", "handlers", "index.ts"),
    "export * from './attachRequestContext';\nexport { getInitialState } from './getInitialState';\n",
  );
  writeFile(
    path.join(root, "src", "server", "prehandlers", "index.ts"),
    "import * as handlers from './handlers';\nexport function buildRequestPreHandlers() { return [{ method: handlers.attachRequestContext, assign: 'context' }]; }\n",
  );
  writeFile(
    path.join(root, "src", "server", "prehandlers", "handlers", "getInitialState.ts"),
    "export function getInitialState(request) { return { user: request.pre.user, client: request.pre.client, country: request.pre.country }; }\n",
  );
  writeFile(
    path.join(root, "src", "server", "plugins", "renderer", "index.tsx"),
    "const plugin = { name: 'renderer', version: '0.0.1', register: async function (server) { server.decorate('handler', 'page', () => {}); server.expose('renderPage', async () => renderToString(App)); server.method('renderToString', async () => 'html'); } };\nexport default plugin;\n",
  );
  writeFile(
    path.join(root, "src", "server", "plugins", "index.ts"),
    "export * as registry from './registry';\n",
  );
  writeFile(
    path.join(root, "src", "server", "plugins", "registry.ts"),
    "export { default as Renderer } from './renderer';\nexport { default as Translations } from './translations';\n",
  );
  writeFile(
    path.join(root, "src", "server", "plugins", "translations", "index.ts"),
    "const plugin = { name: 'translations', version: '0.0.1', register: async function (server) { server.expose('dictionary', {}); } };\nexport default plugin;\n",
  );
  writeFile(
    path.join(root, "src", "server", "plugins", "metrics", "index.ts"),
    "const plugin = { name: 'metrics', version: '0.0.1', register: async function (server) { server.expose('snapshot', {}); } };\nexport default plugin;\n",
  );
  writeFile(
    path.join(root, "e2e", "workflow.spec.ts"),
    "test.describe('workflow', () => { test('opens tasks', async ({ page }) => { await page.goto('/tasks'); expect(page).toBeDefined(); }); });\n",
  );
  writeFile(path.join(root, "e2e", "seed.spec.ts"), "test('seed', async () => {});\n");
  writeFile(path.join(workspaceRoot, "README.md"), "# Synthetic workspace README should be ignored\n");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = runAdversarialHostSurfacesProof({
    validationSurfaceRoot: root,
    workspaceRoot,
  });

  assert.equal(result.all_ok, true);
  assert.equal(result.surface_count, 11);
  assert.equal(result.surface_results.every((entry) => entry.ok), true);
  assert.deepEqual(
    result.surface_results.map((entry) => entry.category),
    ["documentation", "package_manifest", "playwright_config", "source_view", "source_api", "server_route", "prehandler", "server_plugin", "server_runtime", "test_directory", "test_spec"],
  );
  assert.equal(result.surface_results[0].candidate_count, 2);
  assert.equal(result.surface_results[3].candidate_count, 2);
  assert.equal(
    result.surface_results[3].source_path.endsWith("src/client/components/Dashboard/index.tsx"),
    true,
  );
  assert.deepEqual(
    result.surface_results[3].selection_signals,
    [
      "+120:ui-entrypoint",
      "+30:tsx-view",
      "+80:ui-surface-path",
      "+60:component-export",
      "+40:ui-behavior",
      "+25:ui-keyword-density",
    ],
  );
  assert.equal(result.surface_results[4].candidate_count, 2);
  assert.equal(
    result.surface_results[4].source_path.endsWith("src/client/api/tasks/index.ts"),
    true,
  );
  assert.deepEqual(
    result.surface_results[4].selection_signals,
    [
      "+120:api-entrypoint",
      "+20:ts-api",
      "+80:api-surface-path",
      "+70:http-client-call",
      "+50:endpoint-literal",
      "+40:request-shape",
      "+20:api-keyword-density",
    ],
  );
  assert.equal(
    result.surface_results[5].source_path.endsWith("src/server/routes/index.ts"),
    true,
  );
  assert.deepEqual(
    result.surface_results[5].selection_signals,
    [
      "+140:routes-entrypoint",
      "+90:routes-path",
      "+80:hapi-route-registration",
      "+60:route-definition-shape",
      "+40:route-prehandlers",
      "+20:hapi-server-contract",
    ],
  );
  assert.equal(
    result.surface_results[6].source_path.endsWith("src/server/prehandlers/handlers/attachRequestContext.ts"),
    true,
  );
  assert.deepEqual(
    result.surface_results[6].selection_signals,
    [
      "+90:prehandlers-path",
      "+80:prehandler-implementation-path",
      "+60:request-continuation",
      "+40:request-context-access",
    ],
  );
  assert.equal(
    result.surface_results[7].source_path.endsWith("src/server/plugins/renderer/index.tsx"),
    true,
  );
  assert.deepEqual(
    result.surface_results[7].selection_signals,
    [
      "+90:plugins-path",
      "+80:plugin-entrypoint",
      "+60:hapi-plugin-register",
      "+60:rendering-surface",
      "+40:plugin-wiring-surface",
      "+20:plugin-contract-shape",
    ],
  );
  assert.equal(
    result.surface_results[8].source_path.endsWith("src/server/index.ts"),
    true,
  );
  assert.match(
    result.surface_results[8].selection_reason,
    /ranking by runtime evidence and selected-surface resolved dependency overlap while preferring unrepresented server families over plugin, prehandler, route/,
  );
  assert.deepEqual(
    result.surface_results[8].selection_signals,
    [
      "+120:server-runtime-path",
      "+50:bootstrap-runtime-family",
      "+55:selected-server-route-surface-resolved-dependency-overlap",
      "+55:selected-prehandler-surface-resolved-dependency-overlap",
      "+55:selected-server-plugin-surface-resolved-dependency-overlap",
      "+70:selected-surface-resolved-dependency-coverage",
      "+80:render-runtime-surface",
      "+40:server-wiring-runtime",
      "+50:bootstrap-runtime-content",
      "+105:selected-surface-resolved-dependency-bridge",
      "+25:server-runtime-keywords",
      "+20:hapi-runtime-contract",
      "+90:unrepresented-runtime-family",
    ],
  );
  assert.equal(result.surface_results[10].candidate_count, 2);
  assert.match(result.surface_results[10].selection_reason, /top-ranked test_spec candidate/);
  assert.deepEqual(
    result.surface_results[10].selection_signals,
    [
      "+60:concrete-browser-actions",
      "+40:explicit-assertions",
      "+20:structured-test-suite",
    ],
  );
  assert.equal(result.surface_results.at(-1)?.source_path.endsWith("e2e/workflow.spec.ts"), true);
  assert.equal(
    result.surface_results.every((entry) => entry.final_activation_status === "ACTIVE"),
    true,
  );
});
