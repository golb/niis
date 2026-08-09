const ALLOWED_EXECUTABLES = Object.freeze([
  "node",
  "npm",
  "yarn",
  "pnpm",
  "go",
  "cargo",
  "ruff",
  "mypy",
  "pytest",
  "tsc",
  "eslint",
  "prettier",
  "vitest",
  "jest",
  "playwright",
  "git",
]);
const ALLOWED_EXECUTABLE_SET = new Set(ALLOWED_EXECUTABLES);

function getExecutableBasename(executable) {
  if (typeof executable !== "string" || executable.trim() === "") {
    return null;
  }

  return executable.trim().split(/[\\/]/).pop() ?? null;
}

function isExecutableAllowed(executable) {
  const basename = getExecutableBasename(executable);
  if (basename === null || !ALLOWED_EXECUTABLE_SET.has(basename)) {
    return false;
  }
  if (!/[\\/]/u.test(executable)) {
    return true;
  }
  return basename === "node"
    && executable === process.execPath;
}

export {
  ALLOWED_EXECUTABLES,
  getExecutableBasename,
  isExecutableAllowed,
};
