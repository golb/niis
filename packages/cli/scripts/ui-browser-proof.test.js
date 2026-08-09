import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const proofEntrypoint = path.resolve(__dirname, "ui-browser-proof.js");

test("ui-browser-proof prepare-only preserves the static read-only ui --output contour", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-ui-browser-proof-test-"));
  const workspaceRoot = path.join(root, "workspace");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const prepareResult = spawnSync(process.execPath, [
    proofEntrypoint,
    "--workspace-root",
    workspaceRoot,
    "--prepare-only",
  ], {
    cwd: path.resolve(__dirname, "..", "..", ".."),
    encoding: "utf8",
  });

  assert.equal(prepareResult.status, 0);

  const prepared = JSON.parse(prepareResult.stdout);

  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.steps.map((step) => step.command), ["init", "ui"]);
  assert.equal(prepared.artifact_checks.database_path, true);
  assert.equal(prepared.artifact_checks.install_state, true);
  assert.equal(prepared.artifact_checks.dashboard_html, true);
  assert.equal(prepared.artifact_checks.render_summary, true);
  assert.equal(prepared.render_summary.title, "Interactive Control-Plane Proof");
  assert.equal(prepared.render_summary.route_mode, "read_only_dashboard");
  assert.equal(prepared.render_summary.has_post_forms, false);
  assert.equal(prepared.render_summary.has_control_plane_routes, false);
  assert.equal(prepared.render_summary.has_task_detail_catalog, true);
  assert.equal(prepared.render_summary.has_hash_navigation_support, true);
  assert.equal(prepared.render_summary.task_title_count >= 2, true);

  const preparedHtml = fs.readFileSync(prepared.artifacts.dashboard_html, "utf8");

  assert.match(preparedHtml, /Interactive Control-Plane Proof/);
  assert.doesNotMatch(preparedHtml, /method="post"/);
  assert.doesNotMatch(preparedHtml, /href="\/tasks\/new"/);
});

test("ui-browser-proof smoke-only verifies create, plan, approve, start, and run detail", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-ui-browser-proof-smoke-test-"));
  const workspaceRoot = path.join(root, "workspace");

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const smokeResult = spawnSync(process.execPath, [
    proofEntrypoint,
    "--workspace-root",
    workspaceRoot,
    "--smoke-only",
    "--port",
    "0",
  ], {
    cwd: path.resolve(__dirname, "..", "..", ".."),
    encoding: "utf8",
  });

  assert.equal(smokeResult.status, 0);

  const smoked = JSON.parse(smokeResult.stdout);

  assert.equal(smoked.ok, true);
  assert.equal(smoked.artifact_checks.serve_summary, true);
  assert.equal(smoked.serve_summary.home_ok, true);
  assert.equal(smoked.serve_summary.health_ok, true);
  assert.equal(smoked.serve_summary.health_payload.surface, "niis_ui");
  assert.equal(smoked.serve_summary.read_only_export.route_mode, "read_only_dashboard");
  assert.equal(smoked.serve_summary.read_only_export.has_post_forms, false);
  assert.equal(smoked.serve_summary.interactive_routes.home, true);
  assert.equal(smoked.serve_summary.interactive_routes.task_create, true);
  assert.equal(smoked.serve_summary.interactive_routes.task_workbench, true);
  assert.equal(smoked.serve_summary.interactive_routes.approval_queue, true);
  assert.equal(smoked.serve_summary.interactive_routes.run_detail, true);
  assert.equal(smoked.serve_summary.interactive_mutations.create, true);
  assert.equal(smoked.serve_summary.interactive_mutations.plan, true);
  assert.equal(smoked.serve_summary.interactive_mutations.approve_plan, true);
  assert.equal(smoked.serve_summary.interactive_mutations.start, true);
  assert.equal(smoked.serve_summary.interactive_mutations.approval_approve, true);
  assert.equal(smoked.serve_summary.created_task.created, true);
  assert.equal(smoked.serve_summary.created_task.planning_started, true);
  assert.equal(smoked.serve_summary.created_task.plan_approved, true);
  assert.equal(smoked.serve_summary.created_task.execution_started, true);
  assert.equal(smoked.serve_summary.created_task.workbench_ok, true);
  assert.equal(typeof smoked.serve_summary.created_task.id, "string");
  assert.equal(smoked.serve_summary.approval.before_queue_visible, true);
  assert.equal(smoked.serve_summary.approval.approved, true);
  assert.equal(smoked.serve_summary.run_detail.page_ok, true);
  assert.equal(smoked.serve_summary.run_detail.validator_decisions, true);
  assert.equal(smoked.serve_summary.run_detail.produced_artifacts, true);
  assert.equal(typeof smoked.serve_summary.run_detail.run_id, "string");

  const serveSummary = JSON.parse(fs.readFileSync(smoked.artifacts.serve_summary, "utf8"));

  assert.equal(serveSummary.home_status, 200);
  assert.equal(serveSummary.health_status, 200);
  assert.equal(serveSummary.interactive_mutations.start, true);
  assert.equal(serveSummary.interactive_mutations.approval_approve, true);
  assert.equal(serveSummary.run_detail.validator_decisions, true);
});
