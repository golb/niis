import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HostLocalRuntimesProofError, runHostLocalRuntimesProof } from "./host-local-runtimes-proof.js";

function writeFakeRuntime(binDir, name, versionLine) {
  const runtimePath = path.join(binDir, name);
  fs.writeFileSync(
    runtimePath,
    `#!/bin/sh
echo "${versionLine}"
`,
  );
  fs.chmodSync(runtimePath, 0o755);
  return runtimePath;
}

test("runHostLocalRuntimesProof reports a blocked result when host binaries are unavailable", async (t) => {
  const originalCodexPath = process.env.NIIS_CODEX_LOCAL_BIN;
  const originalClaudePath = process.env.NIIS_CLAUDE_CODE_LOCAL_BIN;
  const originalPath = process.env.PATH;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-host-local-runtimes-proof-test-"));
  const workspaceRoot = path.join(root, "workspace");
  const outputRoot = path.join(root, "artifacts");

  process.env.NIIS_CODEX_LOCAL_BIN = "";
  process.env.NIIS_CLAUDE_CODE_LOCAL_BIN = "";
  process.env.PATH = "/nonexistent";

  t.after(() => {
    if (originalCodexPath === undefined) {
      delete process.env.NIIS_CODEX_LOCAL_BIN;
    } else {
      process.env.NIIS_CODEX_LOCAL_BIN = originalCodexPath;
    }

    if (originalClaudePath === undefined) {
      delete process.env.NIIS_CLAUDE_CODE_LOCAL_BIN;
    } else {
      process.env.NIIS_CLAUDE_CODE_LOCAL_BIN = originalClaudePath;
    }

    process.env.PATH = originalPath;
    fs.rmSync(root, { force: true, recursive: true });
  });

  await assert.rejects(
    async () => {
      await runHostLocalRuntimesProof({
        outputRoot,
        workspaceRoot,
      });
    },
    (error) => {
      assert.equal(error instanceof HostLocalRuntimesProofError, true);
      assert.equal(error.result?.status, "blocked");
      assert.deepEqual(error.result?.missing_runtimes, ["codex_local", "claude_code_local"]);
      return true;
    },
  );
});

test("runHostLocalRuntimesProof accepts the claude alias from PATH for claude_code_local", async (t) => {
  const originalCodexPath = process.env.NIIS_CODEX_LOCAL_BIN;
  const originalClaudePath = process.env.NIIS_CLAUDE_CODE_LOCAL_BIN;
  const originalPath = process.env.PATH;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-host-local-runtimes-proof-alias-test-"));
  const binDir = path.join(root, "bin");
  const workspaceRoot = path.join(root, "workspace");
  const outputRoot = path.join(root, "artifacts");

  fs.mkdirSync(binDir, { recursive: true });
  writeFakeRuntime(binDir, "codex", "codex-cli 0.0.0-test");
  writeFakeRuntime(binDir, "claude", "2.1.92 (Claude Code)");

  process.env.NIIS_CODEX_LOCAL_BIN = "";
  process.env.NIIS_CLAUDE_CODE_LOCAL_BIN = "";
  process.env.PATH = `${binDir}:${originalPath}`;

  t.after(() => {
    if (originalCodexPath === undefined) {
      delete process.env.NIIS_CODEX_LOCAL_BIN;
    } else {
      process.env.NIIS_CODEX_LOCAL_BIN = originalCodexPath;
    }

    if (originalClaudePath === undefined) {
      delete process.env.NIIS_CLAUDE_CODE_LOCAL_BIN;
    } else {
      process.env.NIIS_CLAUDE_CODE_LOCAL_BIN = originalClaudePath;
    }

    process.env.PATH = originalPath;
    fs.rmSync(root, { force: true, recursive: true });
  });

  const result = await runHostLocalRuntimesProof({
    outputRoot,
    workspaceRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.codex_local.ok, true);
  assert.equal(result.diagnostics.claude_code_local.ok, true);
  assert.equal(result.host_binaries.codex_local, path.join(binDir, "codex"));
  assert.equal(result.host_binaries.claude_code_local, path.join(binDir, "claude"));
  assert.equal(result.route_steps[0].parsed_json?.selected_adapter?.id, "codex_local");
  assert.equal(result.route_steps[1].parsed_json?.selected_adapter?.id, "claude_code_local");
});
