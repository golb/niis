import { spawnSync } from "node:child_process";

import {
  ALLOWED_EXECUTABLES,
  isExecutableAllowed,
} from "../policy/executable-allowlist.js";

class QualityGateError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "QualityGateError";
    this.code = options.code ?? "quality_gate_failed";
  }
}




const ALLOWED_COMMANDS = new Set(ALLOWED_EXECUTABLES);

function isCommandAllowed(command) {
  return isExecutableAllowed(command);
}

function runQualityGate({ gate, workspaceRoot, timeoutMs = 60_000, subtaskId = null }) {
  if (!gate || typeof gate !== "object") {
    throw new QualityGateError("gate must be an object");
  }
  if (!isCommandAllowed(gate.command)) {
    return Object.freeze({
      duration_ms: 0,
      exit_code: -1,
      fail_mode: gate.fail_mode ?? "hard",
      gate_id: gate.id,
      ok: false,
      stderr: `Command "${gate.command}" is not whitelisted for quality gates.`,
      stdout: "",
      subtask_id: subtaskId,
    });
  }
  const startedAt = Date.now();
  const result = spawnSync(gate.command, Array.isArray(gate.args) ? gate.args : [], {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const finishedAt = Date.now();
  const exitCode = result.status ?? (result.signal ? 124 : 1);

  return Object.freeze({
    duration_ms: finishedAt - startedAt,
    exit_code: exitCode,
    fail_mode: gate.fail_mode ?? "hard",
    gate_id: gate.id,
    ok: exitCode === 0,
    stderr: (result.stderr ?? "").slice(0, 4000),
    stdout: (result.stdout ?? "").slice(0, 4000),
    subtask_id: subtaskId,
  });
}

function runQualityGates({ gates = [], workspaceRoot, timeoutMs = 60_000, subtaskId = null } = {}) {
  if (!Array.isArray(gates) || gates.length === 0) {
    return { hard_failures: [], results: [] };
  }
  const results = gates.map((gate) => runQualityGate({ gate, subtaskId, timeoutMs, workspaceRoot }));
  const hardFailures = results.filter((entry) => !entry.ok && entry.fail_mode === "hard");
  return { hard_failures: hardFailures, results };
}

function summarizeQualityGates(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return "No quality gates were declared for this role.";
  }
  return results.map((result) =>
    `[${result.gate_id}] exit=${result.exit_code} (${result.fail_mode})${result.ok ? " ✓" : " ✗"}`
  ).join("; ");
}

export {
  ALLOWED_COMMANDS,
  QualityGateError,
  isCommandAllowed,
  runQualityGate,
  runQualityGates,
  summarizeQualityGates,
};
