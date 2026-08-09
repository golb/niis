import test from "node:test";
import assert from "node:assert/strict";

import {
  LAB_AGENTS,
  buildManageAgentsPageData,
  pickPersonaForTask,
  renderManageAgentsDocument,
  renderProjectDocument,
  setExtraLabAgents,
} from "./lab-page.js";




test.beforeEach(() => {
  setExtraLabAgents([]);
});

test("LAB_AGENTS ships seven built-in orchestration personas", () => {
  assert.equal(LAB_AGENTS.length, 7);
  assert.deepEqual(
    LAB_AGENTS.map((agent) => agent.role_id),
    [
      "coordinator-generalist",
      "task-planner",
      "generalist-worker",
      "frontend-specialist",
      "nodejs-worker",
      "python-worker",
      "validator",
    ],
  );
});

test("setExtraLabAgents merges installed package-agents into LAB_AGENTS", () => {
  const collectorLabAgent = {
    id: "feed-collector",
    name: "Collector",
    role: "Feed Collector",
    role_id: "feed-collector",
    accent: "#0ea5e9",
    avatar: "",
    bg: "#cfe8f5",
    bg_dark: "#0b2230",
  };
  setExtraLabAgents([collectorLabAgent]);
  assert.equal(LAB_AGENTS.length, 8);
  const collector = LAB_AGENTS.find((agent) => agent.id === "feed-collector");
  assert.ok(collector, "feed-collector must be in LAB_AGENTS once registered");
  assert.equal(collector.name, "Collector");
  assert.equal(collector.role, "Feed Collector");



  assert.equal(
    pickPersonaForTask({ status: "PENDING", assigned_to: "feed-collector", task_kind: "agent_tick" }, null),
    "feed-collector",
  );
});

test("setExtraLabAgents([]) restores the built-in roster", () => {
  setExtraLabAgents([{ id: "feed-collector", name: "Collector", role: "Feed Collector", role_id: "feed-collector", accent: "#0ea5e9", avatar: "" }]);
  assert.equal(LAB_AGENTS.length, 8);
  setExtraLabAgents([]);
  assert.equal(LAB_AGENTS.length, 7);
  assert.equal(LAB_AGENTS.some((a) => a.id === "feed-collector"), false);
});

test("pickPersonaForTask honors task.assigned_to only when it names a bundled persona", () => {
  assert.equal(
    pickPersonaForTask({ status: "PENDING", assigned_to: "nova" }, null),
    "nova",
  );
  assert.equal(
    pickPersonaForTask({ status: "PENDING", assigned_to: "feed-collector", task_kind: "agent_tick" }, null),
    "marcus",
  );
});

test("pickPersonaForTask keeps existing phase and subtask heuristics", () => {
  assert.equal(pickPersonaForTask({ status: "PLANNING", assigned_to: null }, null), "vera");
  assert.equal(pickPersonaForTask({ status: "IN_REVIEW", assigned_to: null }, null), "iris");
  assert.equal(
    pickPersonaForTask(
      { status: "IN_PROGRESS", assigned_to: null },
      { subtasks: [{ status: "IN_PROGRESS", role_id: "frontend-specialist" }] },
    ),
    "nova",
  );
});

test("Manage Agents renders extra built-in personas after core agents", () => {
  const collectorManifest = {
    id: "feed-collector",
    role_label: "Feed Collector",
    description: "Collects external feeds.",
    lane: "ingestion",
    adapter_requirements: { operations: ["execute"], toolFamilies: ["mcp", "feeds"] },
    keywords: ["feeds"],
    persona: {
      name: "Collector",
      avatar_url: null,
      accent: "#10b981",
    },
    _provenance: "built-in",
    agent_settings: {
      title: "Feed runtime",
      hint: "Collector follows task collection specs.",
      rows: [
        { label: "Configuration", value: "Install and configure the private feed package", code: true },
      ],
    },
  };
  const data = buildManageAgentsPageData({
    manifests: [collectorManifest],
  });
  assert.deepEqual(data.personaOrder, ["feed-collector"]);

  const html = renderManageAgentsDocument(data);
  assert.match(html, /Collector/);
  assert.match(html, /Feed Collector/);
  assert.doesNotMatch(html, /\/__niis\/assets\/person-/);
  assert.match(html, /action="\/project\/settings\/role\/feed-collector"/);
  assert.match(html, /class="lab-agent-toggle-input"/);
  assert.match(html, /built-in/);
  assert.doesNotMatch(html, /title="Agent">Agent/);
  assert.doesNotMatch(html, /marketplace-local/);
  assert.match(html, /Feed runtime/);
  assert.match(html, /Install and configure the private feed package/);
  assert.doesNotMatch(html, /href="\/agents\/collector"/);
});

test("project page exposes one fixed supervised promotion policy", () => {
  const html = renderProjectDocument({
    projectContext: {
      doctor: { all_checks: [] },
      profile: { project_id: "local-project" },
      roleConfig: {
        overrides: {
          merge_policy: { mode: "legacy-automation" },
        },
      },
    },
    snapshot: {
      goals: [],
      runs: [],
      tasks: [],
    },
  });

  assert.match(html, /Promotion policy/);
  assert.match(html, /Supervised manual promotion/);
  assert.match(html, /canonical <code>PASS<\/code>/);
  assert.match(html, /Reviewable branch/);
  assert.match(html, /manual landing/);
  assert.match(html, /Legacy configuration detected/);
  assert.doesNotMatch(html, /name="preset"/);
  assert.doesNotMatch(html, /action="\/project\/settings\/merge-policy"/);
  assert.match(html, /frame\.setAttribute\('sandbox', ''\)/);
  assert.doesNotMatch(html, /__niisShadows__|newScript\.textContent/);
  assert.match(html, /monthly reference \(USD\) — operator-entered/u);
  assert.doesNotMatch(html, /Pro \$20|Max5x|hard 429|upgrade your plan/u);
  assert.doesNotMatch(html, /Danger zone|Archive project|Delete project|settings\/(?:archive|delete)/u);
});
