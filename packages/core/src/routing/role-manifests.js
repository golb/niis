










const ROLE_TYPES = Object.freeze({
  COORDINATOR: "coordinator",
  PLANNER: "planner",
  SPECIALIST: "specialist",
  VALIDATOR: "validator",
  WORKER: "worker",
});

const ROLE_MANIFEST_DEFAULTS = Object.freeze({
  authority: Object.freeze({
    can: Object.freeze([]),
    cannot: Object.freeze([]),
  }),
  budget: null,




  context_contract: null,
  doc_refs: Object.freeze([]),
  model_preference: null,
  path_patterns: Object.freeze([]),


  role_label: null,


  persona: null,
  quality_gates: Object.freeze([]),
  scope: Object.freeze({
    path_globs: Object.freeze([]),
  }),
  system_prompt: null,



  version: "0.1.0",
});

function withRoleDefaults(manifest) {
  return Object.freeze({
    ...ROLE_MANIFEST_DEFAULTS,
    ...manifest,
  });
}

const COORDINATOR_GENERALIST_MANIFEST = withRoleDefaults({
  adapter_requirements: Object.freeze({
    operations: ["execute", "plan"],
    permissions: ["orchestrate", "delegate"],
    protocolTypes: [],
    toolFamilies: ["filesystem", "shell"],
  }),
  description: "System orchestration role for intake, routing, delegation, retries, blockers, and approvals.",
  expected_output: "Coordinate task lifecycle, delegate to appropriate workers, manage blockers and approvals.",
  health_assets: Object.freeze([]),
  id: "coordinator-generalist",
  version: "1.2.0",
  role_label: "Coordinator",
  persona: Object.freeze({
    name: "Marcus",
    avatar_url: null,
    accent: "#3b82f6",
    bg: "#d0d0d0",
    bg_dark: "#161616",
  }),
  keywords: Object.freeze([
    "coordinate",
    "orchestrate",
    "delegate",
    "route",
    "intake",
    "retry",
    "blocker",
    "approval",
    "escalate",
    "assign",
  ]),
  lane: "coordinator",
  priority: 100,
  quality_bar: Object.freeze([
    "Correctly identify task type and route to appropriate lane.",
    "Manage blockers and escalations with clear reasoning.",
    "Ensure delegation payload contains sufficient context.",
  ]),
  role_type: ROLE_TYPES.COORDINATOR,
  safe_fallback: false,
});

const TASK_PLANNER_MANIFEST = withRoleDefaults({
  adapter_requirements: Object.freeze({
    operations: ["execute", "plan"],
    permissions: [],
    protocolTypes: [],
    toolFamilies: ["filesystem"],
  }),
  description: "Planning role for task decomposition, details, acceptance criteria, subtasks, and scoped guidance.",
  expected_output: "Produce structured task plan with decomposed subtasks, acceptance criteria, and execution guidance.",
  health_assets: Object.freeze([]),
  id: "task-planner",
  version: "1.1.0",
  role_label: "Planner",
  persona: Object.freeze({
    name: "Vera",
    avatar_url: null,
    accent: "#a855f7",
    bg: "#c5b3a4",
    bg_dark: "#161616",
  }),
  keywords: Object.freeze([
    "plan",
    "decompose",
    "breakdown",
    "subtask",
    "acceptance",
    "criteria",
    "scope",
    "guidance",
    "details",
    "structure",
  ]),
  lane: "planner",
  priority: 90,
  quality_bar: Object.freeze([
    "Decompose complex tasks into 2-5 atomic subtasks.",
    "Define clear acceptance criteria for each subtask.",
    "Identify target paths and relevant documentation.",
  ]),
  role_type: ROLE_TYPES.PLANNER,
  safe_fallback: false,
});

const GENERALIST_WORKER_MANIFEST = withRoleDefaults({
  adapter_requirements: Object.freeze({
    operations: ["execute"],
    permissions: [],
    protocolTypes: [],
    toolFamilies: ["shell"],
  }),
  description: "Catch-all worker for tasks that do not match a domain specialist — generic file edits, refactors, doc and config updates, renames, cleanups, and one-off scripts. Picked when no Frontend / Node / Python specialist scores positive affinity for the task.",
  expected_output: "Apply the requested changes precisely, capture diff/log evidence, surface ambiguity as blockers early instead of guessing scope.",
  health_assets: Object.freeze([]),
  id: "generalist-worker",
  version: "1.0.0",
  role_label: "Generalist",
  persona: Object.freeze({
    name: "Kai",
    avatar_url: null,
    accent: "#6b7280",
    bg: "#b8c8d4",
    bg_dark: "#16202a",
  }),





  keywords: Object.freeze([
    "cleanup",
    "rename",
    "move",
    "docs",
    "readme",
    "comment",
    "config",
    "misc",
    "chore",
    "rollback",
    "revert",
  ]),
  lane: "generalist",
  priority: 0,




  quality_gates: Object.freeze([
    Object.freeze({
      args: ["--test", "--test-reporter=spec", "--test-timeout=60000"],
      command: "node",
      fail_mode: "soft",
      id: "generalist.node.test",
    }),
  ]),
  quality_bar: Object.freeze([
    "Follow the task constraints exactly — no scope creep, no surrounding cleanup.",
    "Produce verifiable evidence: diff summary, command output, or before/after notes.",
    "Report blockers early if requirements are unclear or out-of-scope ambiguity is detected.",
    "Stay neutral on stack: do not assume Node/Python/frontend conventions unless the task explicitly invokes them.",
  ]),
  role_type: ROLE_TYPES.WORKER,
  safe_fallback: true,
});

const FRONTEND_SPECIALIST_MANIFEST = withRoleDefaults({
  adapter_requirements: Object.freeze({
    operations: ["execute"],
    permissions: [],
    protocolTypes: [],
    toolFamilies: ["shell"],
  }),
  description: "Execution specialist for UI, frontend, and web development tasks.",
  expected_output: "Implement frontend changes with proper styling, accessibility, and responsive behavior.",
  health_assets: Object.freeze([]),
  id: "frontend-specialist",
  version: "1.3.0",
  role_label: "Frontend",
  persona: Object.freeze({
    name: "Nova",
    avatar_url: null,
    accent: "#ec4899",
    bg: "#4e7b7e",
  }),
  keywords: Object.freeze([
    "ui",
    "frontend",
    "css",
    "html",
    "react",
    "vue",
    "component",
    "style",
    "layout",
    "responsive",
    "accessibility",
    "design",
    "button",
    "form",
    "modal",
    "navigation",
    "sidebar",
    "header",
    "footer",
  ]),
  lane: "frontend",
  path_patterns: Object.freeze([
    "\\.html?$",
    "\\.css$",
    "\\.scss$",
    "\\.less$",
    "\\.sass$",
    "\\.jsx$",
    "\\.tsx$",
    "\\.vue$",
    "\\.svelte$",
    "(^|/)templates/",
    "(^|/)components/",
    "(^|/)styles/",
    "(^|/)assets/",
    "(^|/)public/",
    "(^|/)pages/",
    "(^|/)views/",
  ]),
  priority: 80,




  quality_gates: Object.freeze([
    Object.freeze({
      args: ["--noEmit"],
      command: "tsc",
      fail_mode: "soft",
      id: "frontend.tsc.noemit",
    }),
    Object.freeze({
      args: [".", "--ext", ".js,.jsx,.ts,.tsx,.vue,.svelte"],
      command: "eslint",
      fail_mode: "soft",
      id: "frontend.eslint",
    }),
  ]),
  quality_bar: Object.freeze([
    "Follow design specifications and style guidelines.",
    "Ensure responsive behavior across breakpoints.",
    "Maintain accessibility standards.",
  ]),
  role_type: ROLE_TYPES.SPECIALIST,
  safe_fallback: false,
});

const NODEJS_WORKER_MANIFEST = withRoleDefaults({
  adapter_requirements: Object.freeze({
    operations: ["execute"],
    permissions: [],
    protocolTypes: [],
    toolFamilies: ["shell"],
  }),
  description: "Execution specialist for Node.js / TypeScript backend work (API, CLI, server).",
  expected_output: "Implement backend changes with `npm test` / `node --test` passing and type-check clean.",
  health_assets: Object.freeze([]),
  id: "nodejs-worker",
  version: "1.0.0",
  role_label: "Node Backend",
  persona: Object.freeze({
    name: "Theo",
    avatar_url: null,
    accent: "#10b981",
    bg: "#b5cdb0",
    bg_dark: "#142019",
  }),
  keywords: Object.freeze([
    "node",
    "nodejs",
    "typescript",
    "express",
    "fastify",
    "nextjs-api",
    "koa",
    "nestjs",
    "bun",
    "deno",
  ]),
  lane: "backend",
  path_patterns: Object.freeze([
    "\\.js$",
    "\\.mjs$",
    "\\.cjs$",
    "\\.ts$",
    "package\\.json$",
    "(^|/)src/",
    "(^|/)lib/",
    "(^|/)server/",
  ]),
  priority: 75,



  quality_gates: Object.freeze([
    Object.freeze({
      args: ["--test", "--test-reporter=spec", "--test-timeout=60000"],
      command: "node",
      fail_mode: "hard",
      id: "nodejs.test",
    }),
    Object.freeze({
      args: ["--noEmit"],
      command: "tsc",
      fail_mode: "soft",
      id: "nodejs.tsc.noemit",
    }),
  ]),
  quality_bar: Object.freeze([
    "All existing tests remain green; add tests for new behavior.",
    "No type-check regressions.",
    "Code changes are scoped to the role's path patterns.",
  ]),
  role_type: ROLE_TYPES.WORKER,
  safe_fallback: false,
});

const PYTHON_WORKER_MANIFEST = withRoleDefaults({
  adapter_requirements: Object.freeze({
    operations: ["execute"],
    permissions: [],
    protocolTypes: [],
    toolFamilies: ["shell"],
  }),
  description: "Execution specialist for Python services (FastAPI, Django, AI/ML, data pipelines).",
  expected_output: "Implement Python changes with `pytest` passing, `ruff check` clean, `mypy` clean.",
  health_assets: Object.freeze([]),
  id: "python-worker",
  version: "1.0.0",
  role_label: "Python Backend",
  persona: Object.freeze({
    name: "Mira",
    avatar_url: null,
    accent: "#f97316",
    bg: "#e8d5c4",
    bg_dark: "#1d1815",
  }),
  keywords: Object.freeze([
    "python",
    "fastapi",
    "django",
    "flask",
    "pytest",
    "pandas",
    "numpy",
    "pytorch",
    "langchain",
  ]),
  lane: "backend",
  path_patterns: Object.freeze([
    "\\.py$",
    "pyproject\\.toml$",
    "requirements.*\\.txt$",
    "(^|/)src/.*\\.py$",
  ]),
  priority: 75,
  quality_gates: Object.freeze([
    Object.freeze({
      args: ["check", "."],
      command: "ruff",
      fail_mode: "hard",
      id: "python.ruff",
    }),
    Object.freeze({
      args: ["."],
      command: "mypy",
      fail_mode: "soft",
      id: "python.mypy",
    }),
    Object.freeze({
      args: ["--tb=short", "-q"],
      command: "pytest",
      fail_mode: "hard",
      id: "python.pytest",
    }),
  ]),
  quality_bar: Object.freeze([
    "ruff clean (no lint errors).",
    "pytest passes for touched modules.",
    "Coverage meets project thresholds if configured.",
  ]),
  role_type: ROLE_TYPES.WORKER,
  safe_fallback: false,
});

const VALIDATOR_MANIFEST = withRoleDefaults({
  adapter_requirements: Object.freeze({
    operations: ["execute"],
    permissions: [],
    protocolTypes: [],
    toolFamilies: ["filesystem", "shell"],
  }),
  description: "Review and validation role for quality gates and evidence verification.",
  expected_output: "Produce structured verdict with evidence references and clear reasoning.",
  health_assets: Object.freeze([]),
  id: "validator",
  version: "1.1.0",
  role_label: "Validator",
  persona: Object.freeze({
    name: "Iris",
    avatar_url: null,
    accent: "#6366f1",
    bg: "#99ada9",
    bg_dark: "#1a2426",
  }),
  keywords: Object.freeze([
    "review",
    "validate",
    "verify",
    "test",
    "check",
    "audit",
    "evidence",
    "verdict",
  ]),
  lane: "validator",
  priority: 70,
  quality_bar: Object.freeze([
    "Verify work against acceptance criteria.",
    "Collect evidence for verdict justification.",
    "Distinguish between PASS, DEFECT, EVIDENCE_GAP, and other verdict classes.",
  ]),
  role_type: ROLE_TYPES.VALIDATOR,
  safe_fallback: false,
});

const DEFAULT_ROLE_MANIFESTS = Object.freeze([
  COORDINATOR_GENERALIST_MANIFEST,
  TASK_PLANNER_MANIFEST,
  GENERALIST_WORKER_MANIFEST,
  FRONTEND_SPECIALIST_MANIFEST,
  NODEJS_WORKER_MANIFEST,
  PYTHON_WORKER_MANIFEST,
  VALIDATOR_MANIFEST,
]);

const DEFAULT_EXECUTION_ROLE_MANIFESTS = Object.freeze(
  DEFAULT_ROLE_MANIFESTS.filter((manifest) =>
    manifest.role_type === ROLE_TYPES.WORKER || manifest.role_type === ROLE_TYPES.SPECIALIST),
);

function getRoleManifestById(id) {
  return DEFAULT_ROLE_MANIFESTS.find((manifest) => manifest.id === id) ?? null;
}

function getRoleManifestsByType(roleType) {
  return DEFAULT_ROLE_MANIFESTS.filter((manifest) => manifest.role_type === roleType);
}

function getSafeFallbackManifest() {
  return DEFAULT_ROLE_MANIFESTS.find((manifest) => manifest.safe_fallback) ?? GENERALIST_WORKER_MANIFEST;
}

function getPlannerManifest() {
  return TASK_PLANNER_MANIFEST;
}

function getCoordinatorManifest() {
  return COORDINATOR_GENERALIST_MANIFEST;
}

function getWorkerManifests() {
  return DEFAULT_EXECUTION_ROLE_MANIFESTS;
}








const SYSTEM_ROLE_IDS = Object.freeze([
  "coordinator-generalist",
  "task-planner",
  "validator",
  "generalist-worker",
]);

function isSystemRoleId(roleId) {
  return SYSTEM_ROLE_IDS.includes(roleId);
}

export {
  COORDINATOR_GENERALIST_MANIFEST,
  DEFAULT_EXECUTION_ROLE_MANIFESTS,
  DEFAULT_ROLE_MANIFESTS,
  FRONTEND_SPECIALIST_MANIFEST,
  GENERALIST_WORKER_MANIFEST,
  ROLE_MANIFEST_DEFAULTS,
  ROLE_TYPES,
  SYSTEM_ROLE_IDS,
  TASK_PLANNER_MANIFEST,
  VALIDATOR_MANIFEST,
  getCoordinatorManifest,
  getPlannerManifest,
  getRoleManifestById,
  getRoleManifestsByType,
  getSafeFallbackManifest,
  getWorkerManifests,
  isSystemRoleId,
  withRoleDefaults,
};
