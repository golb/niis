import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLAUDE_EDITING_TOOLS,
  CLAUDE_READ_ONLY_TOOLS,
  INTAKE_PLANNER_SCHEMA,
  buildExecutionPrompt,
  buildPlannerPrompt,
  createBuiltinExecutorAdapter,
  runClaudeExecution,
  runClaudePlanner,
  runCodexPlanner,
} from "./intake-runtime.js";
import { normalizeContextContract } from "../../core/src/contracts/context-contract.js";

function writeArgumentEchoRuntime(root, name) {
  const executable = path.join(root, name);
  fs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      "process.stdout.write(JSON.stringify({ result: JSON.stringify(process.argv.slice(2)) }));",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return executable;
}

function createTermResistantProcessTreeFixture(root) {
  const wrapperPath = path.join(root, "term-wrapper.cjs");
  const readyPath = path.join(root, "grandchild.pid");
  const grandchildSource = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  fs.writeFileSync(wrapperPath, [
    "#!/usr/bin/env node",
    "const { spawn } = require('node:child_process');",
    "process.on('SIGTERM', () => process.exit(0));",
    `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: "ignore" });`,
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"), { mode: 0o700 });
  return { readyPath, wrapperPath };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return false;
    throw error;
  }
}

async function waitForReadyProcess(readyPath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyPath)) {
      const pid = Number(fs.readFileSync(readyPath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`grandchild did not become ready: ${readyPath}`);
}

test("planner schema requires structured argv acceptance commands", () => {
  assert.ok(INTAKE_PLANNER_SCHEMA.required.includes("acceptance_commands"));
  const commandSchema = INTAKE_PLANNER_SCHEMA.properties.acceptance_commands;
  assert.equal(commandSchema.type, "array");
  assert.equal(commandSchema.minItems, 1);
  assert.deepEqual(commandSchema.items.required, ["id", "argv", "required"]);
  assert.equal(commandSchema.items.properties.argv.type, "array");
  assert.equal(commandSchema.items.properties.required.type, "boolean");
});

test("planner prompt forbids shell interpolation in acceptance commands", () => {
  const prompt = buildPlannerPrompt({
    operatorPrompt: "Make the focused change and verify it.",
    workspaceRoot: "",
  });

  assert.match(prompt, /acceptance_commands/);
  assert.match(prompt, /non-empty `argv` string array/);
  assert.match(prompt, /Never emit a shell command string/);
  assert.match(prompt, /At least one command must set `required` to true/);
  assert.match(prompt, /read-only verification/);
  assert.match(prompt, /Never request install, publish, release/);
});

test("Claude execution forwards an explicit denied-tool policy", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-claude-args-"));
  const executable = writeArgumentEchoRuntime(root, "fake-claude");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const result = await runClaudeExecution({
    commandPath: executable,
    disallowedTools: ["Bash(git push *)", "WebFetch"],
    permissionMode: "plan",
    prompt: "Return a verdict.",
    workspaceRoot: root,
  });
  const args = JSON.parse(result.summary);
  const deniedIndex = args.indexOf("--disallowedTools");

  assert.ok(deniedIndex >= 0);
  assert.equal(args[deniedIndex + 1], "Bash(git push *),WebFetch");
  assert.equal(args[args.length - 1], "Return a verdict.");
});

test("Claude execution kills TERM-resistant descendants on cancellation and timeout", {
  skip: process.platform === "win32",
}, async () => {
  for (const mode of ["cancel", "timeout"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-intake-tree-"));
    const { readyPath, wrapperPath } = createTermResistantProcessTreeFixture(root);
    let grandchildPid = null;
    try {
      const controller = new AbortController();
      const pending = runClaudeExecution({
        commandPath: wrapperPath,
        prompt: `Wait for ${mode}.`,
        signal: controller.signal,
        timeoutMs: mode === "timeout" ? 2_000 : 5_000,
        workspaceRoot: root,
      });
      const rejection = assert.rejects(
        pending,
        /subtask aborted \(timeout or cancellation\)/u,
      );
      grandchildPid = await waitForReadyProcess(readyPath);
      if (mode === "cancel") controller.abort();

      await rejection;
      assert.equal(isProcessAlive(grandchildPid), false);
    } finally {
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      fs.rmSync(root, { force: true, recursive: true });
    }
  }
});

test("Claude execution defaults to a read-only tool allowlist with MCP disabled", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-claude-readonly-"));
  const executable = writeArgumentEchoRuntime(root, "fake-claude");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const result = await runClaudeExecution({
    commandPath: executable,
    prompt: "Inspect and return a verdict.",
    workspaceRoot: root,
  });
  const args = JSON.parse(result.summary);
  const toolsIndex = args.indexOf("--tools");
  const allowedIndex = args.indexOf("--allowedTools");
  const permissionIndex = args.indexOf("--permission-mode");
  const mcpIndex = args.indexOf("--mcp-config");

  assert.deepEqual(args[toolsIndex + 1].split(","), CLAUDE_READ_ONLY_TOOLS);
  assert.deepEqual(
    args[allowedIndex + 1].split(","),
    CLAUDE_READ_ONLY_TOOLS.map((tool) => `${tool}(./**)`),
  );
  assert.equal(args[permissionIndex + 1], "dontAsk");
  assert.equal(args[mcpIndex + 1], "{}");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(!args[toolsIndex + 1].includes("Bash"));
  assert.ok(!args[toolsIndex + 1].includes("Agent"));
  assert.ok(!args[toolsIndex + 1].includes("Web"));
});

test("Claude execution rejects shell, agent, and network-capable tools", async () => {
  for (const tool of ["Bash", "Agent", "WebFetch", "WebSearch"]) {
    await assert.rejects(
      runClaudeExecution({
        allowedTools: ["Read", tool],
        commandPath: "/does/not/matter",
        prompt: "Return a verdict.",
        workspaceRoot: process.cwd(),
      }),
      /contains unsupported tools/u,
    );
  }
});

test("Claude execution rejects malformed denied-tool entries", async () => {
  await assert.rejects(
    runClaudeExecution({
      commandPath: "/does/not/matter",
      disallowedTools: ["WebFetch\nEdit"],
      prompt: "Return a verdict.",
      workspaceRoot: process.cwd(),
    }),
    /disallowedTools must be an array/u,
  );
});

test("Claude planner uses the same read-only tool and MCP envelope", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-claude-planner-policy-"));
  fs.mkdirSync(path.join(root, ".niis"));
  const executable = path.join(root, "fake-claude");
  const argsPath = path.join(root, "args.json");
  const plannerPayload = {
    acceptance_checks: ["Check output."],
    acceptance_commands: [{ argv: ["npm", "test"], id: "tests", required: true }],
    operator_guidance: [],
    out_of_scope: [],
    phase: 0,
    priority: "medium",
    subtasks: [],
    summary: "Summary",
    target_paths: [],
    title: "Title",
  };
  fs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(JSON.stringify({ result: ${JSON.stringify(JSON.stringify(plannerPayload))} }));`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const output = await runClaudePlanner({
    commandPath: executable,
    operatorPrompt: "Inspect the task.",
    workspaceRoot: root,
  });
  const args = JSON.parse(fs.readFileSync(argsPath, "utf8"));
  const toolsIndex = args.indexOf("--tools");
  const permissionIndex = args.indexOf("--permission-mode");

  assert.equal(output.parsed.title, "Title");
  assert.deepEqual(args[toolsIndex + 1].split(","), CLAUDE_READ_ONLY_TOOLS);
  assert.equal(args[permissionIndex + 1], "dontAsk");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--json-schema"));
  assert.notEqual(output.result.runtime_sandbox_backend, null);
  assert.ok(output.result.sandbox_evidence.applied_denied_read_roots.includes(fs.realpathSync(path.join(root, ".niis"))));
});

test("planner runtime is terminated when its deadline expires", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-planner-timeout-"));
  fs.mkdirSync(path.join(root, ".niis"));
  const executable = path.join(root, "fake-claude");
  fs.writeFileSync(executable, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  await assert.rejects(
    runClaudePlanner({
      commandPath: executable,
      operatorPrompt: "Wait forever.",
      timeoutMs: 50,
      workspaceRoot: root,
    }),
    /subtask aborted \(timeout or cancellation\)/u,
  );
});

test("Codex planner forces read-only sandbox and never approval", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-codex-planner-policy-"));
  fs.mkdirSync(path.join(root, ".niis"));
  const executable = path.join(root, "fake-codex");
  const argsPath = path.join(root, "args.json");
  const plannerPayload = {
    acceptance_checks: ["Check output."],
    acceptance_commands: [{ argv: ["npm", "test"], id: "tests", required: true }],
    operator_guidance: [],
    out_of_scope: [],
    phase: 0,
    priority: "medium",
    subtasks: [],
    summary: "Summary",
    target_paths: [],
    title: "Title",
  };
  fs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      `const payload = ${JSON.stringify(JSON.stringify(plannerPayload))};`,
      "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: payload } }) + '\\n');",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const result = await runCodexPlanner({
    commandPath: executable,
    operatorPrompt: "Inspect the task.",
    workspaceRoot: root,
  });
  const args = JSON.parse(fs.readFileSync(argsPath, "utf8"));

  assert.equal(result.parsed.title, "Title");
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args[args.indexOf("--ask-for-approval") + 1], "never");
  assert.ok(!args.includes("--full-auto"));
  assert.notEqual(result.result.runtime_sandbox_backend, null);
  assert.ok(result.result.sandbox_evidence.applied_denied_read_roots.includes(fs.realpathSync(path.join(root, ".niis"))));
});

test("builtin Claude executor exposes only editing tools and enforces disabled network", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-claude-executor-policy-"));
  const protectedRoot = path.join(root, "state");
  const workspaceRoot = path.join(root, "worktrees", "attempt");
  fs.mkdirSync(protectedRoot, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const executable = writeArgumentEchoRuntime(root, "fake-claude");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const adapter = createBuiltinExecutorAdapter({
    commandPath: executable,
    runtimeId: "claude_code_local",
    workspaceRoot,
  });

  const result = await adapter.execute({
    network_policy: { mode: "disabled" },
    sandbox_policy: {
      concurrency: 1,
      denied_read_roots: [protectedRoot],
      mode: "workspace-write",
    },
    task: { id: "task-policy", title: "Apply a scoped edit" },
  });
  const args = JSON.parse(result.summary);
  const toolsIndex = args.indexOf("--tools");

  assert.equal(result.status, "SUCCESS");
  assert.equal(result._raw_runtime_output.security_evidence.filesystem_enforced, true);
  assert.equal(result._raw_runtime_output.security_evidence.network_enforced, true);
  assert.equal(result._raw_runtime_output.security_evidence.read_enforced, true);
  assert.equal(result._raw_runtime_output.security_evidence.write_enforced, true);
  assert.match(
    result._raw_runtime_output.security_evidence.write_backend,
    /workspace-write-contained/u,
  );
  assert.equal(
    result._raw_runtime_output.security_evidence.network_backend,
    "claude-tool-allowlist",
  );
  assert.match(
    result._raw_runtime_output.runtime_sandbox_backend,
    /(?:workspace-write-contained|inherited-write-sandbox)$/u,
  );
  assert.deepEqual(args[toolsIndex + 1].split(","), CLAUDE_EDITING_TOOLS);
  assert.deepEqual(
    args[args.indexOf("--allowedTools") + 1].split(","),
    CLAUDE_EDITING_TOOLS.map((tool) => `${tool}(./**)`),
  );
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(!args[toolsIndex + 1].includes("Bash"));
  assert.ok(!args[toolsIndex + 1].includes("Agent"));
  assert.ok(!args[toolsIndex + 1].includes("Web"));
});

test("builtin executor rejects unsupported policies without retry", async () => {
  const adapter = createBuiltinExecutorAdapter({
    commandPath: "/does/not/matter",
    runtimeId: "claude_code_local",
    workspaceRoot: process.cwd(),
  });

  for (const context of [
    {
      network_policy: { mode: "adapter-declared" },
      sandbox_policy: { concurrency: 1, mode: "workspace-write" },
    },
    {
      network_policy: { mode: "disabled" },
      sandbox_policy: { concurrency: 2, mode: "workspace-write" },
    },
    {
      network_policy: { mode: "disabled" },
      sandbox_policy: { concurrency: 1, mode: "host" },
    },
  ]) {
    const result = await adapter.execute(context);
    assert.equal(result.status, "ERROR");
    assert.equal(result.error.category, "env_block");
    assert.equal(result.error.retry_safe, false);
  }
});

function buildExecutionPromptContext(overrides = {}) {
  return {
    task: { id: "task-123", title: "Sample task" },
    delegation_payload: {
      authority: { can: ["Edit files"], cannot: ["Touch CI"] },
      expected_output: "Outcome Y",
      quality_bar: ["No regressions"],
      quality_gates: [{ args: ["run", "lint"], command: "npm", fail_mode: "hard", id: "lint" }],
      role_id: "frontend-specialist",
      system_prompt: "Be careful.",
      why_this_lane: "Lane X",
      ...(overrides.delegation_payload ?? {}),
    },
    reference_bundle: {
      guides: [
        { content: "Do the thing", provenance: { source_ref: "inline", source_type: "inline" } },
        { content: "Acceptance check: npm test passes", provenance: { source_ref: "task-intake", source_type: "acceptance_check" } },
        { content: "Role doc ref [docs/x.md]:\nBody", provenance: { source_ref: "docs/x.md", source_type: "doc_ref" } },
        { content: "Bounded repair attempt. Prior attempt attempt-1 ended with DEFECT: reason", provenance: { source_ref: "attempt-1", source_type: "prior_attempt" } },
      ],
      target_paths: ["src/app.js"],
      ...(overrides.reference_bundle ?? {}),
    },
  };
}



const LEGACY_EXECUTION_PROMPT = [
  "# Role persona",
  "Be careful.",
  "",
  "Task ID: task-123",
  "Task: Sample task",
  "",
  "Execute the task inside the current repository.",
  "Why this lane: Lane X",
  "Expected output: Outcome Y",
  "",
  "You CAN:",
  "- Edit files",
  "",
  "You CANNOT:",
  "- Touch CI",
  "",
  "Target paths:",
  "- src/app.js",
  "",
  "Operator guidance:",
  "- Do the thing",
  "- Acceptance check: npm test passes",
  "- Role doc ref [docs/x.md]:\nBody",
  "- Bounded repair attempt. Prior attempt attempt-1 ended with DEFECT: reason",
  "",
  "Acceptance checks:",
  "- npm test passes",
  "",
  "Quality bar:",
  "- No regressions",
  "",
  "Quality gates (these will be executed by the validator; ensure your changes pass them):",
  "- [lint] npm run lint (hard)",
  "",
  "Return a short plain-text summary of changed files, behavior, and verification.",
].join("\n");

test("execution prompt without a context contract matches the legacy composition byte for byte", () => {
  assert.equal(buildExecutionPrompt(buildExecutionPromptContext()), LEGACY_EXECUTION_PROMPT);
});

test("execution prompt with a full-allow contract matches the no-contract composition", () => {
  const contract = normalizeContextContract({
    allow: [
      "task_spec",
      "role_persona",
      "routing_rationale",
      "authority",
      "target_paths",
      "operator_guidance",
      "acceptance_checks",
      "doc_refs",
      "prior_attempt",
      "quality_bar",
      "quality_gates",
    ],
  });
  const prompt = buildExecutionPrompt(buildExecutionPromptContext({
    delegation_payload: { context_contract: contract },
  }));

  assert.equal(prompt, LEGACY_EXECUTION_PROMPT);
});

test("execution prompt with a narrow contract contains no artifacts outside the allow-list", () => {
  const contract = normalizeContextContract({ allow: ["task_spec", "operator_guidance"] });
  const prompt = buildExecutionPrompt(buildExecutionPromptContext({
    delegation_payload: { context_contract: contract },
  }));

  assert.equal(prompt, [
    "Task ID: task-123",
    "Task: Sample task",
    "",
    "Execute the task inside the current repository.",
    "",
    "Operator guidance:",
    "- Do the thing",
    "",
    "Return a short plain-text summary of changed files, behavior, and verification.",
  ].join("\n"));
  assert.ok(!prompt.includes("# Role persona"));
  assert.ok(!prompt.includes("Why this lane"));
  assert.ok(!prompt.includes("You CAN"));
  assert.ok(!prompt.includes("Target paths:"));
  assert.ok(!prompt.includes("docs/x.md"));
  assert.ok(!prompt.includes("Bounded repair attempt"));
  assert.ok(!prompt.includes("Acceptance checks:"));
  assert.ok(!prompt.includes("Quality bar:"));
  assert.ok(!prompt.includes("Quality gates"));
});

test("execution prompt fails closed when a contract meets an unclassifiable guide source", () => {
  const contract = normalizeContextContract({ allow: ["task_spec", "operator_guidance"] });
  const context = buildExecutionPromptContext({
    delegation_payload: { context_contract: contract },
  });
  context.reference_bundle.guides = [
    ...context.reference_bundle.guides,
    { content: "mystery artifact", provenance: { source_ref: "web", source_type: "external" } },
  ];

  assert.throws(
    () => buildExecutionPrompt(context),
    (error) => error.code === "context_contract_violation"
      && error.role_id === "frontend-specialist"
      && /mystery artifact/u.test(error.message),
  );
});

test("execution prompt warns once per role when a contract is absent", (t) => {
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return originalWrite.call(process.stderr, chunk, ...rest);
  };
  t.after(() => {
    process.stderr.write = originalWrite;
  });

  const context = buildExecutionPromptContext({
    delegation_payload: { role_id: "contract-warning-probe-role" },
  });
  buildExecutionPrompt(context);
  buildExecutionPrompt(context);

  const warnings = writes.filter((chunk) =>
    chunk.includes("contract-warning-probe-role has no context contract"));
  assert.equal(warnings.length, 1);
});

test("builtin executor rethrows a context-contract violation instead of recording a failed turn", async () => {
  const adapter = createBuiltinExecutorAdapter({
    commandPath: "/does/not/matter",
    runtimeId: "claude_code_local",
    workspaceRoot: process.cwd(),
  });
  const context = buildExecutionPromptContext({
    delegation_payload: {
      context_contract: normalizeContextContract({ allow: ["task_spec"] }),
    },
  });
  context.reference_bundle.guides = [
    { content: "mystery artifact", provenance: { source_ref: "web", source_type: "external" } },
  ];

  await assert.rejects(
    adapter.execute({
      ...context,
      network_policy: { mode: "disabled" },
      sandbox_policy: {
        concurrency: 1,
        denied_read_roots: [path.join(process.cwd(), "package.json")],
        mode: "workspace-write",
      },
    }),
    (error) => error.code === "context_contract_violation",
  );
});
