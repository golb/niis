import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createInitPlan } from "../../core/src/index.js";
import { createSqliteStorage, seedStorage } from "../../core/src/storage/index.js";

class UiBrowserProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "UiBrowserProofError";
    this.result = result;
  }
}

const DEFAULT_PROOF_TITLE = "Interactive Control-Plane Proof";
const DEFAULT_PROOF_TIMESTAMP = "2026-04-08T17:10:00.000Z";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, {
    mode: 0o755,
  });
}

function createFakeClaudeBinary(binDir, {
  plannerJson = null,
  plannerOutputText = null,
  executionSummary = "Focused UI proof execution summary.",
} = {}) {
  const plannerPayload = plannerOutputText ?? JSON.stringify(plannerJson ?? {
    acceptance_checks: ["Keep the change scoped."],
    acceptance_commands: [
      { argv: ["node", "--check", "src/example.js"], id: "syntax", required: true },
    ],
    operator_guidance: ["Inspect the existing task and run surfaces first."],
    out_of_scope: ["No unrelated changes."],
    phase: 11,
    priority: "high",
    subtasks: [
      { title: "Preview the plan" },
      { title: "Create and start the task" },
    ],
    summary: "Planner summary for the interactive control-plane proof.",
    target_paths: ["src/example.js"],
    title: "Planner title for control-plane proof",
  });
  const scriptPath = path.join(binDir, "claude");

  writeExecutable(scriptPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("claude-cli test");
  process.exit(0);
}
const prompt = args.join(" ");
const payload = prompt.includes("Niis intake planner")
  ? ${JSON.stringify(plannerPayload)}
  : ${JSON.stringify(executionSummary)};
process.stdout.write(JSON.stringify({ result: payload }));
`);

  return scriptPath;
}

function runCliStep({
  cliEntrypoint,
  command,
  commandArgs = [],
  env = process.env,
  workspaceRoot,
}) {
  const result = spawnSync(
    process.execPath,
    [cliEntrypoint, command, ...commandArgs],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env,
    },
  );

  return {
    command,
    command_args: commandArgs,
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    stderr: result.stderr?.trim() ?? "",
    stdout: result.stdout?.trim() ?? "",
  };
}

function resolveCliEntrypoint(cliEntrypoint = null) {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  return cliEntrypoint
    ? path.resolve(cliEntrypoint)
    : path.resolve(scriptDirectory, "..", "bin", "niis.js");
}

function buildUiBrowserProofArtifacts(workspaceRoot) {
  const initPlan = createInitPlan(workspaceRoot);
  const proofRoot = path.join(initPlan.stateRoot, "proofs", "ui-browser");

  return Object.freeze({
    dashboard_html: path.join(proofRoot, "dashboard.html"),
    database_path: initPlan.databasePath,
    install_state: initPlan.installStatePath,
    render_summary: path.join(proofRoot, "render-summary.json"),
    serve_summary: path.join(proofRoot, "serve-summary.json"),
    state_root: initPlan.stateRoot,
  });
}

function verifyUiBrowserProofArtifacts(artifacts) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(artifacts).map(([key, artifactPath]) => [key, fs.existsSync(artifactPath)]),
    ),
  );
}

function dedupeAndSort(values) {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function extractMatches(text, pattern) {
  return Array.from(text.matchAll(pattern), (match) => match[1]);
}

function createStaticRenderSummary({
  html = "",
  title = DEFAULT_PROOF_TITLE,
} = {}) {
  const normalizedHtml = String(html ?? "");
  const hasPostForms = /<form[\s>]/i.test(normalizedHtml);
  const hasControlPlaneRoutes = normalizedHtml.includes('href="/pipeline#new-task"');
  const taskTitles = dedupeAndSort(extractMatches(
    normalizedHtml,
    /<a href="#task-detail-[^"]+">([^<]+)<\/a>/g,
  ));

  return Object.freeze({
    has_control_plane_routes: hasControlPlaneRoutes,
    has_hash_navigation_support: normalizedHtml.includes("window.addEventListener(\"hashchange\", openHashTarget)"),
    has_post_forms: hasPostForms,
    has_task_detail_catalog: normalizedHtml.includes(">Task Detail Catalog<"),
    route_mode: !hasPostForms && !hasControlPlaneRoutes ? "read_only_dashboard" : "interactive_control_plane",
    task_title_count: taskTitles.length,
    task_titles: taskTitles,
    title: String(title ?? ""),
  });
}

function createUiBrowserProofSeed(timestamp = DEFAULT_PROOF_TIMESTAMP) {
  return {
    blockers: [
      {
        blocker_class: "MISSING_APPROVAL",
        created_at: timestamp,
        id: "blocker-release-approval",
        next_action: "Grant release approval from the interactive control-plane proof.",
        reason: "Release approval is required before deploy.",
        resolved_at: null,
        task_id: "task-release-approval",
      },
    ],
    tasks: [
      {
        assigned_to: null,
        created_at: timestamp,
        depends_on: [],
        goal_id: null,
        id: "task-release-approval",
        max_rejections: 5,
        out_of_scope: [],
        phase: 11,
        priority: "high",
        rejection_count: 0,
        status: "BLOCKED",
        title: "Approve release rollout from control-plane proof",
        transition_log: [],
        updated_at: timestamp,
      },
      {
        assigned_to: null,
        created_at: timestamp,
        depends_on: [],
        goal_id: null,
        id: "task-query",
        max_rejections: 5,
        out_of_scope: [],
        phase: 11,
        priority: "medium",
        rejection_count: 0,
        status: "PENDING",
        title: "Inspect query substrate from control-plane proof",
        transition_log: [],
        updated_at: timestamp,
      },
    ],
  };
}

function resolveFlagValue(args, flag) {
  const flagIndex = args.indexOf(flag);
  if (flagIndex === -1) {
    return null;
  }

  return args[flagIndex + 1] ?? null;
}

function createProofEnvironment(workspaceRoot) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "niis-ui-proof-bin-"));

  const claudePath = createFakeClaudeBinary(binDir, {
    executionSummary: "Changed parser source mode and verified focused checks.",
  });

  return {
    cleanup: () => fs.rmSync(binDir, { force: true, recursive: true }),
    env: {
      ...process.env,
      NIIS_CLAUDE_CODE_LOCAL_BIN: claudePath,
      NIIS_CODEX_LOCAL_BIN: "",
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    },
  };
}

async function prepareUiBrowserProofWorkspace({
  cliEntrypoint = null,
  timestamp = DEFAULT_PROOF_TIMESTAMP,
  title = DEFAULT_PROOF_TITLE,
  workspaceRoot = null,
} = {}) {
  const resolvedCliEntrypoint = resolveCliEntrypoint(cliEntrypoint);
  const normalizedWorkspaceRoot = workspaceRoot
    ? path.resolve(workspaceRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), "niis-ui-browser-proof-"));

  fs.mkdirSync(normalizedWorkspaceRoot, { recursive: true });

  const initStep = runCliStep({
    cliEntrypoint: resolvedCliEntrypoint,
    command: "init",
    workspaceRoot: normalizedWorkspaceRoot,
  });

  if (!initStep.ok) {
    throw new UiBrowserProofError("ui browser proof failed during init", {
      cli_entrypoint: resolvedCliEntrypoint,
      init_step: initStep,
      workspace_root: normalizedWorkspaceRoot,
    });
  }

  if (!fs.existsSync(path.join(normalizedWorkspaceRoot, ".git"))) {
    const fixturePath = path.join(normalizedWorkspaceRoot, "src", "example.js");
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, "export const proofFixture = true;\n");
    for (const gitArgs of [
      ["init", "--quiet"],
      ["config", "user.name", "Niis Proof"],
      ["config", "user.email", "proof@niis.invalid"],
      ["add", "src/example.js"],
      ["commit", "--quiet", "-m", "Initialize disposable UI proof fixture"],
    ]) {
      const gitResult = spawnSync("git", gitArgs, {
        cwd: normalizedWorkspaceRoot,
        encoding: "utf8",
      });
      if (gitResult.status !== 0) {
        throw new UiBrowserProofError(`ui browser proof git fixture failed: git ${gitArgs.join(" ")}`, {
          exit_code: gitResult.status,
          stderr: gitResult.stderr,
          workspace_root: normalizedWorkspaceRoot,
        });
      }
    }
  }

  const artifacts = buildUiBrowserProofArtifacts(normalizedWorkspaceRoot);
  const sqliteStorage = createSqliteStorage({
    databasePath: artifacts.database_path,
  });

  try {
    await seedStorage(sqliteStorage, createUiBrowserProofSeed(timestamp));
  } finally {
    sqliteStorage.close();
  }

  const renderStep = runCliStep({
    cliEntrypoint: resolvedCliEntrypoint,
    command: "ui",
    commandArgs: [
      "--output",
      artifacts.dashboard_html,
      "--title",
      title,
    ],
    workspaceRoot: normalizedWorkspaceRoot,
  });

  if (renderStep.ok) {
    const html = fs.readFileSync(artifacts.dashboard_html, "utf8");
    writeJson(artifacts.render_summary, createStaticRenderSummary({
      html,
      title,
    }));
  }

  const prepareArtifacts = Object.freeze({
    dashboard_html: artifacts.dashboard_html,
    database_path: artifacts.database_path,
    install_state: artifacts.install_state,
    render_summary: artifacts.render_summary,
    state_root: artifacts.state_root,
  });
  const steps = Object.freeze([initStep, renderStep]);
  const artifactChecks = verifyUiBrowserProofArtifacts(prepareArtifacts);
  const renderSummary = fs.existsSync(artifacts.render_summary)
    ? JSON.parse(fs.readFileSync(artifacts.render_summary, "utf8"))
    : null;
  const ok = steps.every((step) => step.ok) && Object.values(artifactChecks).every(Boolean);
  const result = {
    artifact_checks: artifactChecks,
    artifacts: prepareArtifacts,
    cli_entrypoint: resolvedCliEntrypoint,
    ok,
    render_summary: renderSummary,
    steps,
    timestamp,
    workspace_root: normalizedWorkspaceRoot,
  };

  if (!ok) {
    throw new UiBrowserProofError("ui browser proof failed during prepare-only setup", result);
  }

  return Object.freeze(result);
}

function waitForServeUrl(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const cleanup = () => {
      clearTimeout(timeoutId);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    const onStdout = (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/Serving local (?:control plane|dashboard) at (http:\/\/[^\s]+)/);

      if (match) {
        cleanup();
        resolve({
          stderr,
          stdout,
          url: match[1],
        });
      }
    };

    const onStderr = (chunk) => {
      stderr += chunk.toString();
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onExit = (code, signal) => {
      cleanup();
      reject(new UiBrowserProofError("ui browser proof smoke server exited before readiness", {
        exit_code: code,
        signal,
        stderr,
        stdout,
      }));
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new UiBrowserProofError("ui browser proof smoke server timed out before readiness", {
        stderr,
        stdout,
      }));
    }, timeoutMs);

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopChildProcess(child) {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8").trim();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new UiBrowserProofError(`timed out waiting for UI bootstrap record: ${filePath}`);
}

async function waitForTask({ databasePath, taskId, predicate, timeoutMs = 10000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sqliteStorage = createSqliteStorage({ databasePath, readonly: true });
    try {
      const task = (await sqliteStorage.tasks.list()).find((entry) => entry.id === taskId) ?? null;
      const runs = await sqliteStorage.runs.byTask(taskId);
      if (predicate({ runs, task })) return { runs, task };
    } finally {
      sqliteStorage.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new UiBrowserProofError(`timed out waiting for task lifecycle state: ${taskId}`);
}

function createServeSummary({
  approval = {},
  createdTask = {},
  healthJson = null,
  healthStatus = 0,
  homeStatus = 0,
  interactiveRoutes = {},
  interactiveMutations = {},
  renderSummary = null,
  runDetail = {},
  url = "",
} = {}) {
  return Object.freeze({
    approval,
    created_task: createdTask,
    health_ok:
      healthStatus === 200
      && healthJson !== null
      && healthJson.ok === true
      && healthJson.surface === "niis_ui",
    health_payload: healthJson,
    health_status: healthStatus,
    home_ok: homeStatus === 200,
    home_status: homeStatus,
    interactive_mutations: interactiveMutations,
    interactive_routes: interactiveRoutes,
    read_only_export: renderSummary,
    run_detail: runDetail,
    served_url: String(url ?? ""),
  });
}

async function runUiBrowserProofSmoke({
  cliEntrypoint = null,
  host = "127.0.0.1",
  port = "0",
  title = DEFAULT_PROOF_TITLE,
  workspaceRoot = null,
} = {}) {
  const prepared = await prepareUiBrowserProofWorkspace({
    cliEntrypoint,
    title,
    workspaceRoot,
  });
  const artifacts = buildUiBrowserProofArtifacts(prepared.workspace_root);
  const proofEnvironment = createProofEnvironment(prepared.workspace_root);
  const bootstrapRecordPath = path.join(prepared.workspace_root, ".niis", "proofs", "ui-browser", "bootstrap-url.txt");
  const child = spawn(process.execPath, [
    prepared.cli_entrypoint,
    "ui",
    "--serve",
    "--host",
    host,
    "--port",
    String(port),
    "--open",
  ], {
    cwd: prepared.workspace_root,
    env: {
      ...proofEnvironment.env,
      NIIS_UI_OPEN_RECORD_PATH: bootstrapRecordPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const ready = await waitForServeUrl(child);
    const bootstrapUrl = await waitForFile(bootstrapRecordPath);
    const bootstrapResponse = await fetch(bootstrapUrl, { redirect: "manual" });
    const sessionCookie = bootstrapResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    fs.rmSync(bootstrapRecordPath, { force: true });
    if (bootstrapResponse.status !== 303 || sessionCookie === "") {
      throw new UiBrowserProofError("UI bootstrap did not produce an authenticated session");
    }
    const uiOrigin = new URL(ready.url).origin;
    const uiFetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", sessionCookie);
      const method = String(init.method ?? "GET").toUpperCase();
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", uiOrigin);
      return fetch(input, { ...init, headers });
    };
    const homeResponse = await uiFetch(ready.url);
    const homeHtml = await homeResponse.text();
    const healthResponse = await fetch(new URL("/health", ready.url));
    const healthJson = await healthResponse.json();

    const approvalsBeforeResponse = await uiFetch(new URL("/approvals", ready.url));
    const approvalsBeforeHtml = await approvalsBeforeResponse.text();

    const createResponse = await uiFetch(new URL("/tasks/new", ready.url), {
      body: new URLSearchParams({
        intent: "create",
        planner_runtime: "claude",
        prompt: "Add parser target source toggle.",
        title: "Parser source toggle",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      redirect: "manual",
    });
    const taskLocation = createResponse.headers.get("location");
    const createdTaskId = taskLocation?.match(/^\/tasks\/([^?]+)/u)?.[1] ?? null;
    let taskPageResponse = taskLocation
      ? await uiFetch(new URL(taskLocation, ready.url))
      : null;
    let taskPageHtml = taskPageResponse ? await taskPageResponse.text() : "";

    const planningResponse = createdTaskId
      ? await uiFetch(new URL(`/tasks/${encodeURIComponent(createdTaskId)}/actions/start`, ready.url), {
        body: new URLSearchParams(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        redirect: "manual",
      })
      : null;
    if (createdTaskId) {
      await waitForTask({
        databasePath: createInitPlan(prepared.workspace_root).databasePath,
        predicate: ({ task }) => task?.status === "PENDING",
        taskId: createdTaskId,
      });
    }
    const planApprovalResponse = createdTaskId
      ? await uiFetch(new URL(`/tasks/${encodeURIComponent(createdTaskId)}/actions/approve`, ready.url), {
        body: new URLSearchParams({ note: "Approved from browser lifecycle proof." }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        redirect: "manual",
      })
      : null;
    const executionResponse = createdTaskId
      ? await uiFetch(new URL(`/tasks/${encodeURIComponent(createdTaskId)}/actions/start`, ready.url), {
        body: new URLSearchParams(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        redirect: "manual",
      })
      : null;
    if (taskLocation) {
      taskPageResponse = await uiFetch(new URL(taskLocation, ready.url));
      taskPageHtml = await taskPageResponse.text();
    }

    const executionState = createdTaskId
      ? await waitForTask({
        databasePath: createInitPlan(prepared.workspace_root).databasePath,
        predicate: ({ runs }) => runs.length > 0,
        taskId: createdTaskId,
      })
      : { runs: [] };
    const createdTaskRuns = executionState.runs;

    const runId = createdTaskRuns[0]?.id ?? null;
    const runDetailResponse = runId
      ? await uiFetch(new URL(`/runs/${encodeURIComponent(runId)}`, ready.url))
      : null;
    const runDetailHtml = runDetailResponse ? await runDetailResponse.text() : "";

    const reopenedStorage = createSqliteStorage({
      databasePath: createInitPlan(prepared.workspace_root).databasePath,
      readonly: true,
    });
    let approvalCount = 0;
    try {
      approvalCount = createdTaskId
        ? (await reopenedStorage.approvals.byTask(createdTaskId)).length
        : 0;
    } finally {
      reopenedStorage.close();
    }

    const serveSummary = createServeSummary({
      approval: {
        approval_count: approvalCount,
        approved: planApprovalResponse?.status === 303 && approvalCount === 1,
        before_queue_visible: approvalsBeforeHtml.includes("Approve release rollout from control-plane proof"),
      },
      createdTask: {
        created: createResponse.status === 303 && Boolean(taskLocation),
        execution_started: executionResponse?.status === 303 && createdTaskRuns.length === 1,
        id: createdTaskId,
        plan_approved: planApprovalResponse?.status === 303,
        planning_started: planningResponse?.status === 303,
        workbench_ok:
          taskPageResponse?.status === 200
          && taskPageHtml.includes("Niis"),
      },
      healthJson,
      healthStatus: healthResponse.status,
      homeStatus: homeResponse.status,
      interactiveMutations: {
        approval_approve: planApprovalResponse?.status === 303,
        create: createResponse.status === 303,
        plan: planningResponse?.status === 303,
        approve_plan: planApprovalResponse?.status === 303,
        start: executionResponse?.status === 303 && createdTaskRuns.length === 1,
      },
      interactiveRoutes: {
        approval_queue: approvalsBeforeResponse.status === 200,
        home: homeResponse.status === 200 && homeHtml.includes("Niis"),
        run_detail: runDetailResponse?.status === 200,
        task_create: createResponse.status === 303,
        task_workbench: taskPageResponse?.status === 200,
      },
      renderSummary: prepared.render_summary,
      runDetail: {
        page_ok: runDetailResponse?.status === 200,
        produced_artifacts: runDetailHtml.includes("Produced Artifacts"),
        run_id: runId,
        validator_decisions: runDetailHtml.includes("Validator Decisions"),
      },
      url: ready.url,
    });

    writeJson(artifacts.serve_summary, serveSummary);

    const smokeArtifacts = Object.freeze({
      ...prepared.artifacts,
      serve_summary: artifacts.serve_summary,
    });
    const artifactChecks = verifyUiBrowserProofArtifacts(smokeArtifacts);
    const ok = prepared.ok
      && serveSummary.home_ok
      && serveSummary.health_ok
      && serveSummary.created_task.created
      && serveSummary.created_task.workbench_ok
      && serveSummary.created_task.planning_started
      && serveSummary.created_task.plan_approved
      && serveSummary.created_task.execution_started
      && serveSummary.approval.approved
      && serveSummary.run_detail.page_ok
      && serveSummary.run_detail.validator_decisions
      && serveSummary.run_detail.produced_artifacts
      && serveSummary.read_only_export?.route_mode === "read_only_dashboard"
      && serveSummary.read_only_export?.has_post_forms === false
      && Object.values(artifactChecks).every(Boolean);
    const result = {
      artifact_checks: artifactChecks,
      artifacts: smokeArtifacts,
      ok,
      prepare: prepared,
      serve_summary: serveSummary,
      workspace_root: prepared.workspace_root,
    };

    if (!ok) {
      throw new UiBrowserProofError("ui browser proof smoke checks failed", result);
    }

    return Object.freeze(result);
  } finally {
    await stopChildProcess(child);
    proofEnvironment.cleanup();
  }
}

async function runUiBrowserProofServe({
  cliEntrypoint = null,
  host = "127.0.0.1",
  open = false,
  port = "4173",
  title = DEFAULT_PROOF_TITLE,
  workspaceRoot = null,
} = {}) {
  const prepared = await prepareUiBrowserProofWorkspace({
    cliEntrypoint,
    title,
    workspaceRoot,
  });
  const proofEnvironment = createProofEnvironment(prepared.workspace_root);

  console.log(`Prepared UI browser proof workspace at ${prepared.workspace_root}`);

  const serveArgs = [
    prepared.cli_entrypoint,
    "ui",
    "--serve",
    "--host",
    host,
    "--port",
    String(port),
  ];

  if (open) {
    serveArgs.push("--open");
  }

  const child = spawn(process.execPath, serveArgs, {
    cwd: prepared.workspace_root,
    env: proofEnvironment.env,
    stdio: "inherit",
  });

  const forwardSignal = (signal) => {
    if (child.exitCode === null) {
      child.kill(signal);
    }
  };

  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 || signal !== null) {
        resolve();
        return;
      }

      reject(new UiBrowserProofError("ui browser proof serve process exited with failure", {
        exit_code: code,
        signal,
        workspace_root: prepared.workspace_root,
      }));
    });
  });
  proofEnvironment.cleanup();

  return prepared;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const workspaceRoot = resolveFlagValue(process.argv, "--workspace-root");
    const host = resolveFlagValue(process.argv, "--host") ?? "127.0.0.1";
    const port = resolveFlagValue(process.argv, "--port") ?? "4173";
    const prepareOnly = process.argv.includes("--prepare-only");
    const smokeOnly = process.argv.includes("--smoke-only");
    const open = process.argv.includes("--open");

    if (prepareOnly) {
      const prepared = await prepareUiBrowserProofWorkspace({
        workspaceRoot,
      });
      console.log(JSON.stringify(prepared, null, 2));
    } else if (smokeOnly) {
      const smokeResult = await runUiBrowserProofSmoke({
        host,
        port,
        workspaceRoot,
      });
      console.log(JSON.stringify(smokeResult, null, 2));
    } else {
      await runUiBrowserProofServe({
        host,
        open,
        port,
        workspaceRoot,
      });
    }
  } catch (error) {
    if (error instanceof UiBrowserProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  DEFAULT_PROOF_TITLE,
  UiBrowserProofError,
  createStaticRenderSummary,
  createServeSummary,
  createUiBrowserProofSeed,
  prepareUiBrowserProofWorkspace,
  runUiBrowserProofSmoke,
  runUiBrowserProofServe,
};
