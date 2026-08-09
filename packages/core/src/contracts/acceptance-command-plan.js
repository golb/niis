import {
  getExecutableBasename,
  isExecutableAllowed,
} from "../policy/executable-allowlist.js";

const ACCEPTANCE_COMMAND_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/;
const ACCEPTANCE_COMMAND_KEYS = Object.freeze(["argv", "id", "required"]);
const MAX_ACCEPTANCE_COMMANDS = 32;
const MAX_ARGV_ITEMS = 128;
const MAX_ARG_LENGTH = 16_384;

const UNSAFE_ARGV_PATTERNS = Object.freeze([
  Object.freeze({ id: "nul-byte", pattern: /\0/u }),
  Object.freeze({ id: "line-break", pattern: /[\r\n\u2028\u2029]/u }),
  Object.freeze({ id: "shell-control-operator", pattern: /(?:&&|\|\||[;&|])/u }),
  Object.freeze({ id: "shell-redirection", pattern: /[<>]/u }),
  Object.freeze({ id: "shell-glob", pattern: /[*?\[\]]/u }),
  Object.freeze({ id: "command-substitution", pattern: /(?:`|\$|%[^%]+%|![A-Za-z_][A-Za-z0-9_]*!)/u }),
]);

class AcceptanceCommandPlanError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AcceptanceCommandPlanError";
    this.code = options.code ?? "invalid_acceptance_command_plan";
    this.path = options.path ?? "acceptance_commands";
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message, path) {
  throw new AcceptanceCommandPlanError(`${path}: ${message}`, { path });
}

function assertExactKeys(command, path) {
  const keys = Object.keys(command).sort();
  if (
    keys.length !== ACCEPTANCE_COMMAND_KEYS.length
    || keys.some((key, index) => key !== ACCEPTANCE_COMMAND_KEYS[index])
  ) {
    fail(`must contain exactly ${ACCEPTANCE_COMMAND_KEYS.join(", ")}`, path);
  }
}

function assertSafeArgvToken(token, path) {
  if (typeof token !== "string") {
    fail("must be a string", path);
  }
  if (token.length === 0 || token.trim() === "") {
    fail("must not be empty", path);
  }
  if (token.length > MAX_ARG_LENGTH) {
    fail(`must not exceed ${MAX_ARG_LENGTH} characters`, path);
  }

  const unsafePattern = UNSAFE_ARGV_PATTERNS.find(({ pattern }) => pattern.test(token));
  if (unsafePattern) {
    fail(`contains forbidden ${unsafePattern.id} syntax`, path);
  }
}

const FORBIDDEN_PACKAGE_SCRIPT_NAMES = new Set([
  "install",
  "postinstall",
  "preinstall",
  "pack",
  "postpack",
  "prepack",
  "prepare",
  "publish",
  "postpublish",
  "prepublish",
  "prepublishonly",
  "release",
  "unpublish",
  "version",
]);

function assertPackageManagerCommand(argv, path) {
  const forbiddenContextFlags = new Set([
    "--config",
    "--global",
    "--prefix",
    "--registry",
    "--script-shell",
    "--userconfig",
    "--workspace",
    "--workspaces",
    "--cwd",
    "-C",
    "-g",
  ]);
  if (argv.slice(1).some((arg) =>
    forbiddenContextFlags.has(arg)
    || [...forbiddenContextFlags].some((flag) => arg.startsWith(`${flag}=`)))) {
    fail(
      "package-manager acceptance commands may not redirect execution, config, registry, or workspace context",
      path,
    );
  }
  const subcommand = argv[1] ?? "";
  if (subcommand === "test") return;
  if (!["run", "run-script"].includes(subcommand)) {
    fail(
      "package managers may run only test or an explicitly named package script",
      path,
    );
  }
  const scriptName = argv[2] ?? "";
  if (
    scriptName === ""
    || scriptName.startsWith("-")
    || FORBIDDEN_PACKAGE_SCRIPT_NAMES.has(scriptName.toLowerCase())
  ) {
    fail("package script name is missing or publication-capable", path);
  }
}

function assertNodeCommand(argv, path) {
  const args = argv.slice(1);
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
    return;
  }
  if (!["--check", "--test"].includes(args[0])) {
    fail("node may run only --check or --test acceptance commands", path);
  }
  if (args.length < 2) {
    fail("node acceptance command must name an explicit checked or test file", path);
  }
  if (args.some((arg) =>
    arg === "-e"
    || arg === "--eval"
    || arg === "-p"
    || arg === "--print"
    || arg === "-r"
    || arg === "--require"
    || arg.startsWith("--eval=")
    || arg.startsWith("--import=")
    || arg.startsWith("--require="))) {
    fail("node eval/import/require hooks are forbidden in acceptance commands", path);
  }
}

function assertGitCommand(argv, path) {
  const readOnlySubcommands = new Set([
    "branch",
    "cat-file",
    "check-ignore",
    "check-ref-format",
    "diff",
    "grep",
    "log",
    "ls-files",
    "merge-base",
    "rev-parse",
    "show",
    "status",
  ]);
  if (!readOnlySubcommands.has(argv[1] ?? "")) {
    fail("git acceptance commands are restricted to read-only inspection", path);
  }
  const args = argv.slice(2);
  if (
    args.some((arg) =>
      arg === "-o"
      || arg === "--output"
      || arg.startsWith("--output=")
      || arg === "--ext-diff"
      || arg === "--textconv"
      || arg === "--edit-description"
      || arg === "--open-files-in-pager")
  ) {
    fail("git acceptance commands may not write output or invoke external helpers", path);
  }
  if (
    argv[1] === "branch"
    && !(
      args.length === 1
      && args[0] === "--show-current"
    )
    && !(
      args.length >= 1
      && args[0] === "--list"
      && args.slice(1).every((arg) => !arg.startsWith("-"))
    )
  ) {
    fail("git branch acceptance commands are restricted to --show-current or --list", path);
  }
}

function assertToolSpecificPolicy(argv, path) {
  const executable = getExecutableBasename(argv[0]);
  if (executable === "node") {
    assertNodeCommand(argv, path);
  } else if (["npm", "yarn", "pnpm"].includes(executable)) {
    assertPackageManagerCommand(argv, path);
  } else if (executable === "git") {
    assertGitCommand(argv, path);
  } else if (executable === "go" && !["test", "vet"].includes(argv[1])) {
    fail("go acceptance commands are restricted to test or vet", path);
  } else if (executable === "cargo") {
    if (!["check", "clippy", "fmt", "test"].includes(argv[1])) {
      fail("cargo acceptance commands are restricted to check, clippy, fmt, or test", path);
    }
    if (argv[1] === "fmt" && !argv.includes("--check")) {
      fail("cargo fmt acceptance commands must include --check", path);
    }
  } else if (executable === "ruff") {
    if (argv[1] === "check") {
      if (argv.some((arg) =>
        arg === "--fix"
        || arg === "--fix-only"
        || arg === "--unsafe-fixes"
        || arg.startsWith("--fix=")
        || arg.startsWith("--fix-only="))) {
        fail("ruff check write modes are forbidden in acceptance commands", path);
      }
    } else if (argv[1] === "format") {
      if (!argv.includes("--check")) {
        fail("ruff format acceptance commands must include --check", path);
      }
    } else {
      fail("ruff acceptance commands are restricted to check or format --check", path);
    }
  } else if (executable === "tsc" && !argv.includes("--noEmit")) {
    fail("tsc acceptance commands must include --noEmit", path);
  } else if (
    ["eslint", "prettier"].includes(executable)
    && argv.some((arg) => ["--fix", "--write"].includes(arg))
  ) {
    fail("formatter/linter write modes are forbidden in acceptance commands", path);
  }
}

function normalizeAcceptanceCommand(command, index) {
  const path = `acceptance_commands[${index}]`;
  if (!isPlainObject(command)) {
    fail("must be a plain JSON object", path);
  }
  assertExactKeys(command, path);

  if (typeof command.id !== "string" || !ACCEPTANCE_COMMAND_ID_PATTERN.test(command.id)) {
    fail(
      "id must be a stable 1-128 character lowercase identifier using letters, digits, '.', '_', ':', or '-'",
      `${path}.id`,
    );
  }
  if (typeof command.required !== "boolean") {
    fail("must be an explicit boolean", `${path}.required`);
  }
  if (!Array.isArray(command.argv) || command.argv.length === 0) {
    fail("must be a non-empty argv array", `${path}.argv`);
  }
  if (command.argv.length > MAX_ARGV_ITEMS) {
    fail(`must not contain more than ${MAX_ARGV_ITEMS} items`, `${path}.argv`);
  }

  command.argv.forEach((token, argvIndex) => {
    assertSafeArgvToken(token, `${path}.argv[${argvIndex}]`);
  });
  if (!isExecutableAllowed(command.argv[0])) {
    fail(`executable "${command.argv[0]}" is not allowlisted`, `${path}.argv[0]`);
  }
  assertToolSpecificPolicy(command.argv, `${path}.argv`);

  return Object.freeze({
    argv: Object.freeze([...command.argv]),
    id: command.id,
    required: command.required,
  });
}

function normalizeAcceptanceCommandPlan(value, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) {
    fail("must be an array", "acceptance_commands");
  }
  if (!allowEmpty && value.length === 0) {
    fail("must declare at least one command", "acceptance_commands");
  }
  if (value.length > MAX_ACCEPTANCE_COMMANDS) {
    fail(`must not contain more than ${MAX_ACCEPTANCE_COMMANDS} commands`, "acceptance_commands");
  }

  const normalized = value.map((command, index) => normalizeAcceptanceCommand(command, index));
  const seenIds = new Set();
  for (const command of normalized) {
    if (seenIds.has(command.id)) {
      fail(`contains duplicate id "${command.id}"`, "acceptance_commands");
    }
    seenIds.add(command.id);
  }

  return Object.freeze(normalized);
}

function toQualityGateDefinitions(acceptanceCommands) {
  const normalized = normalizeAcceptanceCommandPlan(acceptanceCommands);
  return Object.freeze(normalized.map((command) => Object.freeze({
    args: Object.freeze(command.argv.slice(1)),
    command: command.argv[0],
    fail_mode: command.required ? "hard" : "soft",
    id: command.id,
  })));
}

export {
  ACCEPTANCE_COMMAND_ID_PATTERN,
  AcceptanceCommandPlanError,
  MAX_ACCEPTANCE_COMMANDS,
  UNSAFE_ARGV_PATTERNS,
  normalizeAcceptanceCommandPlan,
  toQualityGateDefinitions,
};
