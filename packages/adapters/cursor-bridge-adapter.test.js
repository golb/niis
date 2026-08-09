import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeAdapterResult,
  runAdapterDiagnostics,
} from "../core/src/contracts/adapter.js";
import { createCursorBridgeAdapter } from "./cursor-bridge-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureServerPath = path.join(__dirname, "test-fixtures", "mcp-echo-server.js");

test("createCursorBridgeAdapter exposes the declared cursor_bridge compatibility path", async () => {
  const adapter = createCursorBridgeAdapter({
    id: "fixture-cursor-bridge",
    command: process.execPath,
    args: [fixtureServerPath],
    defaultToolName: "echo",
  });

  const executeResult = await adapter.execute({
    tool_call: {
      arguments: {
        text: "cursor",
      },
    },
  });
  const diagnostics = await runAdapterDiagnostics({
    adapter,
    config: {},
  });
  const normalized = normalizeAdapterResult(adapter, executeResult);

  assert.equal(adapter.protocolType, "cursor_bridge");
  assert.equal(adapter.capabilities().adapter_kind, "cursor_bridge");
  assert.equal(normalized.status, "SUCCESS");
  assert.equal(normalized.summary, "echo:cursor");
  assert.equal(diagnostics.ok, true);
  assert.equal(
    diagnostics.checks.some((check) => check.name === "mcp.initialize" && check.status === "PASS"),
    true,
  );
});
