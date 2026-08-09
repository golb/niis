import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearRoleConfigCache,
  getAutoRepairConfig,
  getMergePolicy,
  loadRoleById,
  loadRoleConfig,
  parseFrontmatter,
  resolveDefaultMergePolicy,
} from "./role-config-loader.js";

function withFixture(setup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-role-config-"));
  try {
    setup(root);
    clearRoleConfigCache();
    return root;
  } catch (error) {
    fs.rmSync(root, { force: true, recursive: true });
    throw error;
  }
}

test("loadRoleConfig merges defaults with the shipped markdown overlay", (t) => {
  const root = withFixture(() => undefined);
  t.after(() => {
    clearRoleConfigCache();
    fs.rmSync(root, { force: true, recursive: true });
  });

  const config = loadRoleConfig({ workspaceRoot: root, useCache: false });
  const frontend = config.manifests.find((m) => m.id === "frontend-specialist");
  assert.ok(frontend, "frontend-specialist manifest must exist");
  assert.match(frontend.system_prompt, /senior frontend engineer/u);
  assert.equal(frontend.context_contract.version, 1);
});

test("loadRoleConfig overlays project-config.json on top of markdown", (t) => {
  const root = withFixture((dir) => {
    fs.mkdirSync(path.join(dir, ".niis"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".niis/project-config.json"),
      JSON.stringify({
        roles: {
          "frontend-specialist": {
            budget: { monthly_usd: 10 },
            model_preference: { runtime: "claude_code_local", model: "claude-sonnet-4-6" },
          },
        },
      }),
    );
  });
  t.after(() => {
    clearRoleConfigCache();
    fs.rmSync(root, { force: true, recursive: true });
  });

  const config = loadRoleConfig({ workspaceRoot: root, useCache: false });
  const frontend = config.manifests.find((m) => m.id === "frontend-specialist");
  assert.equal(frontend.budget.monthly_usd, 10);
  assert.equal(frontend.model_preference.model, "claude-sonnet-4-6");
});

test("loadRoleConfig deep-merges persona overrides without losing avatar/accent", (t) => {
  const root = withFixture((dir) => {
    fs.mkdirSync(path.join(dir, ".niis"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".niis/project-config.json"),
      JSON.stringify({
        roles: {
          "frontend-specialist": {
            persona: { name: "Aurora" },
          },
        },
      }),
    );
  });
  t.after(() => {
    clearRoleConfigCache();
    fs.rmSync(root, { force: true, recursive: true });
  });

  const config = loadRoleConfig({ workspaceRoot: root, useCache: false });
  const frontend = config.manifests.find((m) => m.id === "frontend-specialist");
  assert.equal(frontend.persona.name, "Aurora");

  assert.equal(frontend.persona.avatar_url, null);
  assert.equal(frontend.persona.accent, "#ec4899");
  assert.equal(frontend.persona.bg, "#4e7b7e");
});

test("loadRoleById returns null for unknown role", (t) => {
  const root = withFixture(() => {});
  t.after(() => {
    clearRoleConfigCache();
    fs.rmSync(root, { force: true, recursive: true });
  });
  const role = loadRoleById("does-not-exist", { workspaceRoot: root });
  assert.equal(role, null);
});

test("parseFrontmatter parses YAML subset", () => {
  const text = "---\nid: foo\nbudget:\n  monthly_usd: 5\n  per_run_usd: 0.5\n---\nbody text";
  const { frontmatter, body } = parseFrontmatter(text);
  assert.equal(frontmatter.id, "foo");
  assert.equal(frontmatter.budget.monthly_usd, 5);
  assert.equal(frontmatter.budget.per_run_usd, 0.5);
  assert.equal(body, "body text");
});

test("getMergePolicy returns defaults when config is missing", (t) => {
  const root = withFixture(() => undefined);
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const policy = getMergePolicy({ workspaceRoot: root });
  assert.equal(policy.mode, "none");
  assert.equal(policy.isolate_single_shot, false);
});

test("getAutoRepairConfig is fail-closed and requires explicit opt-in", (t) => {
  const root = withFixture(() => undefined);
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  assert.deepEqual(getAutoRepairConfig({ workspaceRoot: root }), {
    enabled: false,
    max_attempts: 2,
  });
});

test("getAutoRepairConfig reads only the bounded new-attempt controls", (t) => {
  const root = withFixture((dir) => {
    fs.mkdirSync(path.join(dir, ".niis"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".niis/project-config.json"),
      JSON.stringify({
        auto_repair: {
          enabled: true,
          max_attempts: 3,
          model_preference: "ignored-legacy-value",
        },
      }),
    );
  });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  assert.deepEqual(getAutoRepairConfig({ workspaceRoot: root }), {
    enabled: true,
    max_attempts: 3,
  });
});

test("getMergePolicy reads isolate_single_shot and mode overrides from project config", (t) => {
  const root = withFixture((dir) => {
    fs.mkdirSync(path.join(dir, ".niis"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".niis/project-config.json"),
      JSON.stringify({ merge_policy: { isolate_single_shot: true, mode: "create_pr" } }),
    );
  });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const policy = getMergePolicy({ workspaceRoot: root });
  assert.equal(policy.mode, "create_pr");
  assert.equal(policy.isolate_single_shot, true);
});

test("getMergePolicy falls back to default when mode is invalid", (t) => {
  const root = withFixture((dir) => {
    fs.mkdirSync(path.join(dir, ".niis"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".niis/project-config.json"),
      JSON.stringify({ merge_policy: { mode: "unsupported-value" } }),
    );
  });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const policy = getMergePolicy({ workspaceRoot: root });
  assert.equal(policy.mode, "none");
});

test("resolveDefaultMergePolicy picks autonomous when gh + origin both available", () => {
  const probe = { command: () => true, origin: () => true };
  const policy = resolveDefaultMergePolicy({ probe, workspaceRoot: "/tmp/any" });
  assert.equal(policy.mode, "create_pr");
  assert.equal(policy.isolate_single_shot, true);
  assert.equal(policy.branch_per_task, true);
});

test("resolveDefaultMergePolicy stays conservative when gh is missing", () => {
  const probe = { command: () => false, origin: () => true };
  const policy = resolveDefaultMergePolicy({ probe, workspaceRoot: "/tmp/any" });
  assert.equal(policy.mode, "none");
  assert.equal(policy.isolate_single_shot, false);
  assert.equal(policy.branch_per_task, false);
});

test("resolveDefaultMergePolicy stays conservative when origin is missing", () => {
  const probe = { command: () => true, origin: () => false };
  const policy = resolveDefaultMergePolicy({ probe, workspaceRoot: "/tmp/any" });
  assert.equal(policy.mode, "none");
});

test("getMergePolicy honors explicit false even when autonomous default is in effect", (t) => {
  const root = withFixture((dir) => {
    fs.mkdirSync(path.join(dir, ".niis"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".niis/project-config.json"),
      JSON.stringify({ merge_policy: { isolate_single_shot: false, mode: "none" } }),
    );
  });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const policy = getMergePolicy({ workspaceRoot: root });


  assert.equal(policy.isolate_single_shot, false);
  assert.equal(policy.mode, "none");
});

test("loadRoleConfig passes context_contract frontmatter through the merge chain", (t) => {
  const root = withFixture(() => undefined);
  t.after(() => {
    clearRoleConfigCache();
    fs.rmSync(root, { force: true, recursive: true });
  });

  const config = loadRoleConfig({ workspaceRoot: root, useCache: false });
  const frontend = config.manifests.find((m) => m.id === "frontend-specialist");
  assert.equal(frontend.context_contract.version, 1);
  assert.ok(frontend.context_contract.allow.includes("task_spec"));
  assert.ok(frontend.context_contract.allow.includes("role_persona"));
  assert.ok(frontend.context_contract.allow.includes("operator_guidance"));
});

test("context_contract overrides replace the allow-list wholesale instead of merging", (t) => {
  const root = withFixture((dir) => {
    fs.mkdirSync(path.join(dir, ".niis"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".niis/project-config.json"),
      JSON.stringify({
        roles: {
          "frontend-specialist": {
            context_contract: { allow: ["task_spec"] },
          },
        },
      }),
    );
  });
  t.after(() => {
    clearRoleConfigCache();
    fs.rmSync(root, { force: true, recursive: true });
  });

  const config = loadRoleConfig({ workspaceRoot: root, useCache: false });
  const frontend = config.manifests.find((m) => m.id === "frontend-specialist");


  assert.deepEqual(frontend.context_contract.allow, ["task_spec"]);
});
