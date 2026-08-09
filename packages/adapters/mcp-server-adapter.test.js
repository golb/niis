import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeAdapterResult,
  renderSessionCompactionHandoff,
  runAdapterDiagnostics,
} from "../core/src/contracts/adapter.js";
import { createMcpServerAdapter } from "./mcp-server-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureServerPath = path.join(__dirname, "test-fixtures", "mcp-echo-server.js");

test("createMcpServerAdapter connects to a stdio MCP server, lists tools, and calls the configured tool", async () => {
  const adapter = createMcpServerAdapter({
    id: "fixture-mcp-adapter",
    command: process.execPath,
    args: [fixtureServerPath],
    defaultToolName: "echo",
    capabilities: {
      toolFamilies: ["mcp", "task_source.query"],
    },
  });

  const executeResult = await adapter.execute({
    tool_call: {
      arguments: {
        text: "hello",
      },
    },
  });
  const normalized = normalizeAdapterResult(adapter, executeResult);

  assert.equal(adapter.protocolType, "mcp_server");
  assert.equal(normalized.status, "SUCCESS");
  assert.equal(normalized.summary, "echo:hello");
  assert.equal(normalized.completion_signal, true);
  assert.equal(normalized.artifacts[0].type, "mcp_tool_call");
});

test("createMcpServerAdapter participates in diagnostics and session handoff", async () => {
  const adapter = createMcpServerAdapter({
    id: "fixture-mcp-diagnostics",
    command: process.execPath,
    args: [fixtureServerPath],
    defaultToolName: "sum",
  });
  const diagnostics = await runAdapterDiagnostics({
    adapter,
    config: {},
  });
  const handoff = renderSessionCompactionHandoff(adapter.sessionCodec(), [
    {
      tool: "sum",
    },
  ]);

  assert.equal(diagnostics.ok, true);
  assert.equal(
    diagnostics.checks.some((check) => check.name === "mcp.tools.list" && check.status === "PASS"),
    true,
  );
  assert.equal(handoff, "mcp-server handoff for 1 session(s)");
});

test("createMcpServerAdapter returns a structured error when the requested tool is missing", async () => {
  const adapter = createMcpServerAdapter({
    id: "fixture-mcp-missing-tool",
    command: process.execPath,
    args: [fixtureServerPath],
  });

  const executeResult = await adapter.execute({
    tool_call: {
      name: "missing_tool",
      arguments: {},
    },
  });
  const normalized = normalizeAdapterResult(adapter, executeResult);

  assert.equal(normalized.status, "ERROR");
  assert.equal(normalized.error?.category, "permanent");
  assert.equal(normalized.error?.retry_safe, false);
});
