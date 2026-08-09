import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createBubblewrapMaskEntries,
  createSeatbeltTraversalEntries,
  escapeSandboxLiteral,
  orderPathScopedRules,
} from "../core/src/runtime/sandbox-path-rules.js";

class RuntimeReadSandboxError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "RuntimeReadSandboxError";
    this.code = options.code ?? "runtime_read_sandbox_error";
    this.category = "env_block";
    this.retrySafe = false;
    this.skippedDeniedReadRoots = Object.freeze([
      ...(options.skippedDeniedReadRoots ?? []),
    ]);
  }
}




function assertSandboxSafePath(value, code) {
  if (/[\r\n\0]/u.test(value)) {
    throw new RuntimeReadSandboxError(
      "sandbox paths must not contain control characters",
      { code },
    );
  }
  return value;
}

function normalizeRuntimeDeniedReadRoots({
  deniedReadRoots,
  workspaceRoot,
}) {
  if (
    !Array.isArray(deniedReadRoots)
    || deniedReadRoots.length === 0
    || deniedReadRoots.some((entry) =>
      typeof entry !== "string"
      || entry.trim() === ""
      || /[\r\n\0]/u.test(entry))
  ) {
    throw new RuntimeReadSandboxError(
      "executor sandbox policy requires at least one denied read root",
      { code: "runtime_denied_read_roots_missing" },
    );
  }
  const resolvedWorkspace = assertSandboxSafePath(
    fs.realpathSync(path.resolve(workspaceRoot)),
    "runtime_workspace_root_invalid",
  );
  const roots = [];
  const skippedRoots = [];
  for (const entry of deniedReadRoots) {
    const resolved = path.resolve(entry);
    if (!fs.existsSync(resolved)) {
      if (!skippedRoots.includes(resolved)) skippedRoots.push(resolved);
      continue;
    }
    const canonical = fs.realpathSync(resolved);
    if (canonical === resolvedWorkspace) {
      throw new RuntimeReadSandboxError(
        "the attempt workspace cannot itself be a denied read root",
        { code: "runtime_workspace_denied" },
      );
    }
    if (!roots.includes(canonical)) roots.push(canonical);
  }
  if (roots.length === 0) {
    throw new RuntimeReadSandboxError(
      "executor sandbox policy has no available denied read root",
      {
        code: "runtime_denied_read_roots_unavailable",
        skippedDeniedReadRoots: skippedRoots.sort(),
      },
    );
  }
  return Object.freeze({
    deniedReadRoots: Object.freeze(roots.sort()),
    skippedDeniedReadRoots: Object.freeze(skippedRoots.sort()),
    workspaceRoot: resolvedWorkspace,
  });
}

function resolveRuntimeDeniedReadRoots(stateRoot, env = process.env) {
  const homeRoot = os.homedir();
  const configuredRoots = String(env.NIIS_DENIED_READ_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
  return Object.freeze([...new Set([
    path.resolve(stateRoot),
    path.join(homeRoot, ".ssh"),
    path.join(homeRoot, ".aws"),
    path.join(homeRoot, ".gnupg"),
    path.join(homeRoot, ".config", "gh"),
    path.join(homeRoot, ".npmrc"),
    ...configuredRoots,
  ])]);
}

function normalizeRuntimeExecutionPolicy({
  deniedReadRoots = [],
  workspaceRoot,
}) {
  if (
    !Array.isArray(deniedReadRoots)
    || deniedReadRoots.some((entry) =>
      typeof entry !== "string"
      || entry.trim() === ""
      || /[\r\n\0]/u.test(entry))
  ) {
    throw new RuntimeReadSandboxError(
      "executor denied read roots must be an array of non-empty paths",
      { code: "runtime_denied_read_roots_invalid" },
    );
  }
  const resolvedWorkspace = assertSandboxSafePath(
    fs.realpathSync(path.resolve(workspaceRoot)),
    "runtime_workspace_root_invalid",
  );
  if (deniedReadRoots.length === 0) {
    return Object.freeze({
      deniedReadRoots: Object.freeze([]),
      skippedDeniedReadRoots: Object.freeze([]),
      workspaceRoot: resolvedWorkspace,
    });
  }
  return normalizeRuntimeDeniedReadRoots({
    deniedReadRoots,
    workspaceRoot: resolvedWorkspace,
  });
}

function createRuntimeReadSandboxInvocation({
  args = [],
  commandPath,
  deniedReadRoots,
  workspaceRoot,
}) {
  const normalized = normalizeRuntimeDeniedReadRoots({
    deniedReadRoots,
    workspaceRoot,
  });
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    const environmentRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "niis-runtime-sandbox-"),
    );
    const profilePath = path.join(environmentRoot, "runtime.sb");
    fs.writeFileSync(profilePath, [
      "(version 1)",
      "(allow default)",
      ...orderPathScopedRules([
        ...normalized.deniedReadRoots.map((root) => ({
          lines: [
            `(deny file-read* (subpath "${escapeSandboxLiteral(root)}"))`,
            `(deny file-write* (subpath "${escapeSandboxLiteral(root)}"))`,
          ],
          path: root,
          rank: 0,
        })),
        ...createSeatbeltTraversalEntries(
          normalized.deniedReadRoots,
          [normalized.workspaceRoot],
        ),
        {
          lines: [`(allow file-read* file-write* (subpath "${escapeSandboxLiteral(normalized.workspaceRoot)}"))`],
          path: normalized.workspaceRoot,
          rank: 1,
        },
      ]),
      "",
    ].join("\n"), { mode: 0o600 });
    return Object.freeze({
      args: Object.freeze(["-f", profilePath, commandPath, ...args]),
      backend: "darwin-seatbelt-read-contained",
      cleanup() {
        fs.rmSync(environmentRoot, { force: true, recursive: true });
      },
      command: "/usr/bin/sandbox-exec",
      appliedDeniedReadRoots: normalized.deniedReadRoots,
      skippedDeniedReadRoots: normalized.skippedDeniedReadRoots,
    });
  }

  if (process.platform === "linux") {
    const bubblewrapPath = ["/usr/bin/bwrap", "/bin/bwrap"]
      .find((candidate) => fs.existsSync(candidate));
    if (bubblewrapPath) {
      const mounts = orderPathScopedRules([
        ...createBubblewrapMaskEntries(
          normalized.deniedReadRoots,
          [normalized.workspaceRoot],
        ),
        {
          lines: ["--bind", normalized.workspaceRoot, normalized.workspaceRoot],
          path: normalized.workspaceRoot,
          rank: 2,
        },
      ]);
      return Object.freeze({
        args: Object.freeze([
          "--die-with-parent",
          "--new-session",
          "--unshare-pid",
          "--bind", "/", "/",
          "--dev", "/dev",
          "--proc", "/proc",
          ...mounts,
          "--chdir", normalized.workspaceRoot,
          "--",
          commandPath,
          ...args,
        ]),
        backend: "linux-bubblewrap-read-contained",
        cleanup() {},
        command: bubblewrapPath,
        appliedDeniedReadRoots: normalized.deniedReadRoots,
        skippedDeniedReadRoots: normalized.skippedDeniedReadRoots,
      });
    }
  }

  throw new RuntimeReadSandboxError(
    "no supported OS read sandbox is available for the executor runtime",
    { code: "runtime_read_sandbox_unavailable" },
  );
}

function createExecutionEnvironmentRoot() {
  const createdRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-runtime-execution-"),
  );
  try {
    fs.chmodSync(createdRoot, 0o700);
    const environmentRoot = fs.realpathSync(createdRoot);
    const cacheRoot = path.join(environmentRoot, "cache");
    const runtimeRoot = path.join(environmentRoot, "runtime");
    const tempRoot = path.join(environmentRoot, "tmp");
    for (const directory of [cacheRoot, runtimeRoot, tempRoot]) {
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    return Object.freeze({
      environmentRoot,
      env: Object.freeze({
        npm_config_cache: cacheRoot,
        TEMP: tempRoot,
        TMP: tempRoot,
        TMPDIR: `${tempRoot}${path.sep}`,
        XDG_CACHE_HOME: cacheRoot,
        XDG_RUNTIME_DIR: runtimeRoot,
      }),
    });
  } catch (error) {
    fs.rmSync(createdRoot, { force: true, recursive: true });
    throw error;
  }
}

function createRuntimeExecutionSandboxInvocation({
  args = [],
  commandPath,
  deniedReadRoots = [],
  workspaceRoot,
}) {
  if (typeof commandPath !== "string" || commandPath.trim() === "") {
    throw new RuntimeReadSandboxError(
      "executor runtime command path must be a non-empty string",
      { code: "runtime_command_path_invalid" },
    );
  }
  if (
    !Array.isArray(args)
    || args.some((entry) => typeof entry !== "string" || /[\0]/u.test(entry))
  ) {
    throw new RuntimeReadSandboxError(
      "executor runtime arguments must be an array of strings without NUL bytes",
      { code: "runtime_arguments_invalid" },
    );
  }
  const normalized = normalizeRuntimeExecutionPolicy({
    deniedReadRoots,
    workspaceRoot,
  });
  const environment = createExecutionEnvironmentRoot();
  let handedOff = false;
  const cleanupEnvironment = () => {
    fs.rmSync(environment.environmentRoot, { force: true, recursive: true });
  };

  try {
    if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
      const profilePath = path.join(environment.environmentRoot, "runtime.sb");
      fs.writeFileSync(profilePath, [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        ...orderPathScopedRules([
          ...normalized.deniedReadRoots.map((root) => ({



            lines: [
              `(deny file-read* (subpath "${escapeSandboxLiteral(root)}"))`,
              `(deny file-write* (subpath "${escapeSandboxLiteral(root)}"))`,
            ],
            path: root,
            rank: 0,
          })),
          ...createSeatbeltTraversalEntries(
            normalized.deniedReadRoots,
            [normalized.workspaceRoot, environment.environmentRoot],
          ),
          {
            lines: [`(allow file-read* file-write* (subpath "${escapeSandboxLiteral(normalized.workspaceRoot)}"))`],
            path: normalized.workspaceRoot,
            rank: 1,
          },
          {
            lines: [`(allow file-read* file-write* (subpath "${escapeSandboxLiteral(environment.environmentRoot)}"))`],
            path: environment.environmentRoot,
            rank: 1,
          },
        ]),
        '(allow file-write* (literal "/dev/null"))',
        '(allow file-write* (literal "/dev/tty"))',
        "",
      ].join("\n"), { mode: 0o600 });
      handedOff = true;
      return Object.freeze({
        args: Object.freeze(["-f", profilePath, commandPath, ...args]),
        backend: "darwin-seatbelt-workspace-write-contained",
        cleanup: cleanupEnvironment,
        command: "/usr/bin/sandbox-exec",
        env: environment.env,
        runtimeRoot: environment.environmentRoot,
        appliedDeniedReadRoots: normalized.deniedReadRoots,
        skippedDeniedReadRoots: normalized.skippedDeniedReadRoots,
      });
    }

    if (process.platform === "linux") {
      const bubblewrapPath = ["/usr/bin/bwrap", "/bin/bwrap"]
        .find((candidate) => fs.existsSync(candidate));
      if (bubblewrapPath) {
        const mounts = orderPathScopedRules([
          ...createBubblewrapMaskEntries(
            normalized.deniedReadRoots,
            [normalized.workspaceRoot, environment.environmentRoot],
          ),
          {
            lines: ["--bind", normalized.workspaceRoot, normalized.workspaceRoot],
            path: normalized.workspaceRoot,
            rank: 2,
          },
          {
            lines: ["--bind", environment.environmentRoot, environment.environmentRoot],
            path: environment.environmentRoot,
            rank: 2,
          },
        ]);
        handedOff = true;
        return Object.freeze({
          args: Object.freeze([
            "--die-with-parent",
            "--new-session",
            "--unshare-pid",
            "--ro-bind", "/", "/",
            "--dev", "/dev",
            "--proc", "/proc",
            ...mounts,
            "--chdir", normalized.workspaceRoot,
            "--",
            commandPath,
            ...args,
          ]),
          backend: "linux-bubblewrap-workspace-write-contained",
          cleanup: cleanupEnvironment,
          command: bubblewrapPath,
          env: environment.env,
          runtimeRoot: environment.environmentRoot,
          appliedDeniedReadRoots: normalized.deniedReadRoots,
          skippedDeniedReadRoots: normalized.skippedDeniedReadRoots,
        });
      }
    }

    throw new RuntimeReadSandboxError(
      "no supported OS write sandbox is available for the executor runtime",
      { code: "runtime_write_sandbox_unavailable" },
    );
  } finally {
    if (!handedOff) cleanupEnvironment();
  }
}

export {
  RuntimeReadSandboxError,
  createRuntimeExecutionSandboxInvocation,
  createRuntimeReadSandboxInvocation,
  normalizeRuntimeDeniedReadRoots,
  normalizeRuntimeExecutionPolicy,
  resolveRuntimeDeniedReadRoots,
};
